#!/usr/bin/env python3
"""Queue mapped Terraviva observations locally and submit them over HTTPS.

Python 3.10+; standard library only. This is a sender, not a hardware driver.
"""

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from email.utils import parsedate_to_datetime
import hashlib
from http.client import HTTPException
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


MAX_BATCH = 500
MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 512 * 1024
MAX_INPUT_BYTES = 16 * 1024 * 1024
FIELDS = ("id", "deviceId", "field", "observedAt", "measurement", "value", "unit", "quality")
UNITS = {
    "air_temperature": "°C", "soil_temperature": "°C", "soil_moisture": "%",
    "relative_humidity": "%", "rainfall": "mm", "soil_ph": "pH",
    "electrical_conductivity": "dS/m", "battery_voltage": "V",
    "wind_speed": "m/s", "solar_radiation": "W/m²",
}
IDENTITY = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
READING_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\Z")
NUMERIC = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")
STAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})\Z")
# Match JavaScript String.trim used by the receiver (Python strip omits FEFF).
JS_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


class GatewayError(Exception):
    """An intentionally non-sensitive error safe for a command-line log."""

    def __init__(self, message, code=2, transient=False):
        super().__init__(message)
        self.code = code
        self.transient = transient


def stamp_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp(value):
    if not isinstance(value, str) or not STAMP.fullmatch(value):
        raise GatewayError("Use an ISO observation timestamp with seconds and an explicit timezone.")
    try:
        if value[-1] != "Z":
            hours, minutes = int(value[-5:-3]), int(value[-2:])
            if hours > 14 or minutes > 59 or (hours == 14 and minutes != 0):
                raise ValueError
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise GatewayError("A timestamp has an invalid date or timezone (supported years: 0001–9999).") from None


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise GatewayError("JSON contains a duplicate property; nothing was enqueued or acknowledged.")
        result[key] = value
    return result


def no_constant(_value):
    raise GatewayError("Non-finite JSON numbers are not supported.")


def json_text(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def normalize(row, device_id, now=None):
    if not isinstance(row, dict) or set(row) - set(FIELDS) or set(FIELDS[:-1]) - set(row):
        raise GatewayError("Each reading must contain the documented fields only; quality is optional.")
    if not isinstance(row["id"], str) or not READING_ID.fullmatch(row["id"]):
        raise GatewayError("Each observation needs a stable reading ID of 1–128 allowed characters.")
    if row["deviceId"] != device_id:
        raise GatewayError("Observation deviceId does not match this queue's enrolled device.")
    field = row["field"]
    try:
        valid_field = (isinstance(field, str) and bool(field.strip(JS_WHITESPACE))
                       and len(field.encode("utf-16-le")) // 2 <= 120
                       and not re.search(r"[\x00-\x1f\x7f]", field))
    except UnicodeError:
        valid_field = False
    if not valid_field:
        raise GatewayError("Field names must be nonblank, at most 120 UTF-16 units, and have no control characters.")
    observed = timestamp(row["observedAt"])
    # Compare in the supplied zone to avoid overflowing on an ancient offset date.
    try:
        in_future = observed > (now or datetime.now(timezone.utc)) + timedelta(minutes=5)
    except (OverflowError, ValueError):
        raise GatewayError("Observation timestamp is outside the supported calendar range.") from None
    if in_future:
        raise GatewayError("Observation time is more than five minutes in the future; check the device clock.")
    measurement = row["measurement"]
    if not isinstance(measurement, str) or measurement not in UNITS or row["unit"] != UNITS[measurement]:
        raise GatewayError("Measurement or unit does not match the documented sensor contract.")
    value = row["value"]
    # Always send numeric text, so the receipt can be compared exactly across runtimes.
    # JSON decimals are parsed without a binary-float round trip by load_input().
    if isinstance(value, (Decimal, int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str) or len(value) > 80 or not NUMERIC.fullmatch(value):
        raise GatewayError("Sensor values must be finite numeric text or numbers, at most 80 characters.")
    try:
        finite = math.isfinite(float(value))
    except (OverflowError, ValueError):
        finite = False
    if not finite:
        raise GatewayError("Sensor value exceeds the server's finite numeric range.")
    quality = row.get("quality", "unverified")
    if quality not in ("unverified", "ok", "suspect", "invalid"):
        raise GatewayError("Quality must be unverified, ok, suspect or invalid.")
    result = {key: row[key] for key in FIELDS[:-1]}
    result.update(value=value, quality=quality)
    return result


def load_input(path):
    """Read one UTF-8 JSON array or {readings:[...]}; never fabricate IDs."""
    try:
        if path == "-":
            raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        else:
            with open(path, "rb") as source:
                raw = source.read(MAX_INPUT_BYTES + 1)
        if len(raw) > MAX_INPUT_BYTES:
            raise GatewayError("Input exceeds 16 MiB; split it into smaller files.")
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object,
                           parse_float=Decimal, parse_int=Decimal, parse_constant=no_constant)
    except (OSError, UnicodeError, ValueError):
        raise GatewayError("Cannot read a valid UTF-8 JSON input file.") from None
    if isinstance(value, dict) and set(value) == {"readings"}:
        value = value["readings"]
    if not isinstance(value, list) or not value:
        raise GatewayError("Input must be a nonempty readings array or an object containing only that array.")
    return value


def endpoint_url(value):
    try:
        parts = urllib.parse.urlsplit(value)
        valid = (isinstance(value, str) and not re.search(r"[\x00-\x20\x7f]", value)
                 and parts.scheme == "https" and parts.hostname
                 and parts.username is None and parts.password is None
                 and parts.path == "/api/sensors" and not parts.query and not parts.fragment)
        if not valid:
            raise ValueError
        host = parts.hostname.encode("idna").decode("ascii").lower()
        port = parts.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError
        if ":" in host:
            host = "[" + host + "]"
        return "https://" + host + (":" + str(port) if port and port != 443 else "") + "/api/sensors"
    except (TypeError, UnicodeError, ValueError):
        raise GatewayError("Endpoint must be an HTTPS /api/sensors URL without credentials, query or fragment.") from None


def private_path(path, create=False):
    """Use an owned, private directory and a regular, non-symlink database."""
    path = Path(os.path.abspath(os.path.expanduser(path)))
    for item in reversed(path.parents):
        if item.is_symlink():
            raise GatewayError("Queue paths must not contain symbolic links.")
    if create:
        missing = []
        parent = path.parent
        while not parent.exists():
            missing.append(parent)
            parent = parent.parent
        for directory in reversed(missing):
            directory.mkdir(mode=0o700)
    for item in reversed(path.parents):
        if item.is_symlink():
            raise GatewayError("Queue paths must not contain symbolic links.")
    try:
        parent_info = path.parent.stat()
        if not stat.S_ISDIR(parent_info.st_mode):
            raise GatewayError("Queue parent must be a directory.")
        if os.name == "posix" and (parent_info.st_uid != os.geteuid() or parent_info.st_mode & 0o077):
            raise GatewayError("Use a queue directory owned by this account with mode 0700.")
        flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        if create:
            flags |= os.O_CREAT
        descriptor = os.open(path, flags, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise GatewayError("Queue must be a regular file without hard links.")
            if os.name == "posix" and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
                raise GatewayError("Queue file must be owned by this account with mode 0600.")
        finally:
            os.close(descriptor)
    except OSError:
        raise GatewayError("Cannot open the private queue; initialize it first and check its permissions.") from None
    return path


class Outbox:
    def __init__(self, path, binding=None):
        self.path = private_path(path, create=binding is not None)
        self.connection = sqlite3.connect(str(self.path), timeout=5, isolation_level=None)
        self.connection.row_factory = sqlite3.Row
        try:
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA busy_timeout=5000")
            if binding is not None:
                endpoint, device_id, farm = binding
                endpoint = endpoint_url(endpoint)
                if not all(isinstance(x, str) and IDENTITY.fullmatch(x) for x in (device_id, farm)):
                    raise GatewayError("Device and expected farm need 1–80 letters, digits, underscores or hyphens.")
                wanted = {"version": "1", "endpoint": endpoint, "deviceId": device_id, "farm": farm}
                with self.transaction():
                    self.connection.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
                    self.connection.execute("""CREATE TABLE IF NOT EXISTS outbox (
                        sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
                        fingerprint TEXT NOT NULL, payload TEXT, enqueued_at TEXT NOT NULL,
                        acknowledged_at TEXT, received_at TEXT,
                        CHECK ((payload IS NULL) = (acknowledged_at IS NOT NULL)))""")
                    current = dict(self.connection.execute("SELECT key, value FROM metadata"))
                    if current and current != wanted:
                        raise GatewayError("Queue is already bound to another endpoint, device or expected farm; it was not changed.")
                    if not current:
                        self.connection.executemany("INSERT INTO metadata VALUES (?, ?)", wanted.items())
            self.binding = dict(self.connection.execute("SELECT key, value FROM metadata"))
            if set(self.binding) != {"version", "endpoint", "deviceId", "farm"} or self.binding["version"] != "1":
                raise GatewayError("Queue schema is not supported.")
            if self.binding["endpoint"] != endpoint_url(self.binding["endpoint"]) or not all(
                IDENTITY.fullmatch(self.binding[key]) for key in ("deviceId", "farm")
            ):
                raise GatewayError("Stored queue binding is invalid.")
        except BaseException:
            self.connection.close()
            raise

    def close(self):
        self.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    @contextmanager
    def transaction(self):
        self.connection.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.connection.execute("COMMIT")
        except BaseException:
            self.connection.execute("ROLLBACK")
            raise

    def enqueue(self, readings):
        if not isinstance(readings, list) or not readings:
            raise GatewayError("Supply a nonempty readings array.")
        rows = []
        for reading in readings:
            row = normalize(reading, self.binding["deviceId"])
            payload = json_text(row)
            encoded = payload.encode("utf-8")
            if len(encoded) + len(b'{"readings":[]}') > MAX_REQUEST_BYTES:
                raise GatewayError("An observation cannot fit within the server request limit.")
            rows.append((row["id"], hashlib.sha256(encoded).hexdigest(), payload))
        inserted = duplicates = 0
        with self.transaction():
            for reading_id, fingerprint, payload in rows:
                existing = self.connection.execute("SELECT fingerprint FROM outbox WHERE id = ?", (reading_id,)).fetchone()
                if existing:
                    if existing[0] != fingerprint:
                        raise GatewayError("Reading ID conflicts with queued or acknowledged content; the entire input was rejected.")
                    duplicates += 1
                else:
                    self.connection.execute(
                        "INSERT INTO outbox (id, fingerprint, payload, enqueued_at) VALUES (?, ?, ?, ?)",
                        (reading_id, fingerprint, payload, stamp_now()),
                    )
                    inserted += 1
        return {"enqueued": inserted, "duplicates": duplicates}

    def status(self):
        counts = self.connection.execute(
            "SELECT COUNT(*), COALESCE(SUM(acknowledged_at IS NULL), 0) FROM outbox"
        ).fetchone()
        return {"endpoint": self.binding["endpoint"], "deviceId": self.binding["deviceId"],
                "expectedFarm": self.binding["farm"], "pending": counts[1], "acknowledged": counts[0] - counts[1]}

    def batch(self, max_count=MAX_BATCH, max_bytes=MAX_REQUEST_BYTES):
        if not 1 <= max_count <= MAX_BATCH or not 32 <= max_bytes <= MAX_REQUEST_BYTES:
            raise GatewayError("Batch limits exceed the receiver contract.")
        pending = self.connection.execute(
            "SELECT id, fingerprint, payload FROM outbox WHERE acknowledged_at IS NULL ORDER BY sequence LIMIT ?",
            (max_count,),
        ).fetchall()
        chosen, encoded = [], []
        size = len(b'{"readings":[]}')
        for entry in pending:
            try:
                content = entry["payload"].encode("utf-8")
                row = json.loads(entry["payload"], object_pairs_hook=unique_object, parse_constant=no_constant)
                normalized = normalize(row, self.binding["deviceId"])
                if (entry["id"] != normalized["id"] or json_text(normalized) != entry["payload"]
                        or hashlib.sha256(content).hexdigest() != entry["fingerprint"]):
                    raise ValueError
            except (GatewayError, TypeError, UnicodeError, ValueError):
                raise GatewayError("A queued observation failed its integrity check; nothing was sent from this batch.") from None
            extra = len(content) + bool(encoded)
            if size + extra > max_bytes:
                if not chosen:
                    raise GatewayError("The oldest queued observation exceeds the configured batch byte limit.")
                break
            chosen.append(normalized)
            encoded.append(content)
            size += extra
        return chosen, b'{"readings":[' + b",".join(encoded) + b"]}"

    def acknowledge(self, readings, receipts):
        """Retain identity fingerprints after delivery, so IDs cannot be reused."""
        with self.transaction():
            for row in readings:
                fingerprint = hashlib.sha256(json_text(row).encode("utf-8")).hexdigest()
                existing = self.connection.execute(
                    "SELECT fingerprint, acknowledged_at, received_at FROM outbox WHERE id = ?", (row["id"],)
                ).fetchone()
                if not existing or existing["fingerprint"] != fingerprint:
                    raise GatewayError("Queue changed unexpectedly while awaiting a receipt; batch acknowledgement rolled back.")
                received = receipts[row["id"]]["receivedAt"]
                if existing["acknowledged_at"] is not None and existing["received_at"] != received:
                    raise GatewayError("Conflicting receipt times for an already acknowledged reading; queue retained.")
                self.connection.execute(
                    "UPDATE outbox SET payload = NULL, acknowledged_at = ?, received_at = ? WHERE id = ? AND acknowledged_at IS NULL",
                    (stamp_now(), received, row["id"]),
                )


def credential(token_file=None, env_name="TERRAVIVA_SENSOR_TOKEN"):
    if token_file is not None:
        try:
            descriptor = os.open(token_file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(descriptor, "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise GatewayError("Credential file must be a regular file without links.")
                if os.name == "posix" and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
                    raise GatewayError("Credential file must be owned by this account with mode 0600.")
                if info.st_size > 1026:
                    raise GatewayError("Credential file exceeds the supported size.")
                raw = source.read(1027)
            token = raw.decode("ascii").rstrip("\r\n")
        except (OSError, UnicodeError):
            raise GatewayError("Cannot read a private ASCII credential file.") from None
    else:
        token = os.environ.get(env_name, "")
    if not re.fullmatch(r"[!-~]{32,1024}", token):
        raise GatewayError("Supply a separate ingest credential of 32–1024 non-whitespace ASCII characters via environment or private file.")
    return token


@dataclass
class Response:
    status: int
    headers: dict
    body: bytes


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _request, _file, _code, _message, _headers, _url):
        return None


def send_https(endpoint, token, body, timeout):
    """TLS certificate checks use Python's defaults; redirects never get a token."""
    request = urllib.request.Request(endpoint, data=body, method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json",
        "Authorization": "Bearer " + token, "User-Agent": "Terraviva-Sensor-Gateway/1",
    })
    opener = urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=timeout) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise GatewayError("Receipt exceeded the size limit; the batch remains queued.", code=5)
            return Response(response.status, dict(response.headers.items()), payload)
    except urllib.error.HTTPError as error:
        # Do not print/read arbitrary error bodies: a server could echo the token or observations.
        try:
            return Response(error.code, dict(error.headers.items()), b"")
        finally:
            error.close()
    except (OSError, HTTPException, urllib.error.URLError):
        raise GatewayError("Network/TLS request failed; receipt is uncertain and the batch remains queued.", code=4, transient=True) from None


def validated_receipts(response, readings, binding):
    try:
        headers = {key.lower(): value for key, value in response.headers.items()}
        if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ValueError
        if len(response.body) > MAX_RESPONSE_BYTES:
            raise ValueError
        reply = json.loads(response.body.decode("utf-8"), object_pairs_hook=unique_object, parse_constant=no_constant)
        if not isinstance(reply, dict) or set(reply) != {
            "farm", "deviceId", "accepted", "duplicates", "totalReadings", "capacity", "readings"
        }:
            raise ValueError
        if reply["farm"] != binding["farm"] or reply["deviceId"] != binding["deviceId"]:
            raise GatewayError(
                "Receipt farm/device does not match this queue. Stop and verify enrollment; a server write may already have occurred. Queue retained.",
                code=5,
            )
        counts = [reply[key] for key in ("accepted", "duplicates", "totalReadings", "capacity")]
        if any(type(value) is not int or value < 0 for value in counts):
            raise ValueError
        accepted, duplicates, total, capacity = counts
        if (accepted + duplicates != len(readings) or total < len(readings) or total > capacity
                or capacity != 10000 or (response.status == 201) != (accepted > 0)):
            raise ValueError
        if not isinstance(reply["readings"], list) or len(reply["readings"]) != len(readings):
            raise ValueError
        expected = {row["id"]: row for row in readings}
        receipts = {}
        for row in reply["readings"]:
            if not isinstance(row, dict) or set(row) != set(FIELDS) | {"receivedAt"}:
                raise ValueError
            reading_id = row["id"]
            if not isinstance(reading_id, str) or reading_id not in expected or reading_id in receipts:
                raise ValueError
            if any(row[key] != expected[reading_id][key] for key in FIELDS):
                raise ValueError
            timestamp(row["receivedAt"])
            receipts[reading_id] = row
        return receipts
    except GatewayError as error:
        if error.code == 5:
            raise
    except (AttributeError, KeyError, TypeError, UnicodeError, ValueError):
        pass
    raise GatewayError("Unverified or incomplete receipt; no reading in this batch was acknowledged. Check the receiver before retrying.", code=5)


def retry_delay(headers, attempt, base=1.0, now=None):
    delay = min(60.0, base * (2 ** attempt))
    value = next((v for k, v in headers.items() if k.lower() == "retry-after"), "")
    try:
        if re.fullmatch(r"[0-9]+", value):
            requested = float(value)
        else:
            requested = (parsedate_to_datetime(value) - (now or datetime.now(timezone.utc))).total_seconds()
        if math.isfinite(requested):
            delay = max(delay, min(60.0, max(0, requested)))
    except (TypeError, ValueError, OverflowError):
        pass
    return delay


def flush(outbox, token, *, timeout=10, retries=3, max_batches=20, send=send_https, sleep=time.sleep):
    if not 1 <= timeout <= 30 or not 0 <= retries <= 5 or not 1 <= max_batches <= 100:
        raise GatewayError("Use timeout 1–30 seconds, retries 0–5 and max-batches 1–100.")
    delivered = batches = 0
    for _ in range(max_batches):
        readings, body = outbox.batch()
        if not readings:
            break
        for attempt in range(retries + 1):
            headers = {}
            try:
                response = send(outbox.binding["endpoint"], token, body, timeout)
                headers = response.headers
                if response.status in (200, 201):
                    receipts = validated_receipts(response, readings, outbox.binding)
                    outbox.acknowledge(readings, receipts)
                    delivered += len(readings)
                    batches += 1
                    break
                if response.status in (408, 425, 429) or (500 <= response.status <= 599 and response.status != 507):
                    raise GatewayError("Receiver temporarily unavailable (HTTP %d); batch retained." % response.status, code=4, transient=True)
                if 300 <= response.status <= 399:
                    raise GatewayError("Redirect refused; verify the bound HTTPS endpoint. No redirect was followed; batch retained.", code=3)
                actions = {400: "Correct the mapped observation or device clock.", 401: "Check the ingest credential and enrollment.",
                           403: "Check device authorization.", 409: "Resolve the conflicting reading identity; do not silently rename it.",
                           507: "Expand server storage before continuing; exporting alone does not free capacity."}
                raise GatewayError("Receiver rejected the batch (HTTP %d). %s Queue retained." %
                                   (response.status, actions.get(response.status, "Check the receiver configuration.")), code=3)
            except GatewayError as error:
                if not error.transient or attempt == retries:
                    raise
                sleep(retry_delay(headers, attempt))
    return {"acknowledged": delivered, "batches": batches, "pending": outbox.status()["pending"]}


def run(outbox, token_loader, *, interval=30, cycles=0, output=print, sleep=time.sleep, **options):
    if not 1 <= interval <= 60 or cycles < 0:
        raise GatewayError("Run interval must be 1–60 seconds; cycles must be nonnegative (0 means until interrupted).")
    completed = 0
    last_error = None
    while cycles == 0 or completed < cycles:
        try:
            output(json.dumps(flush(outbox, token_loader(), sleep=sleep, **options)))
            last_error = None
        except GatewayError as error:
            if not error.transient:
                raise
            last_error = error
            output(str(error) + " Will retry after the configured interval.")
        completed += 1
        if cycles == 0 or completed < cycles:
            sleep(interval)
    if last_error is not None:
        raise last_error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="SQLite outbox in a private directory (outside the repository)")
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="bind a queue to one endpoint, device and expected farmer")
    init.add_argument("--endpoint", required=True)
    init.add_argument("--device-id", required=True)
    init.add_argument("--farm", required=True, help="expected receipt farm; enrollment remains the server's authority")
    enqueue = commands.add_parser("enqueue", help="atomically queue mapped JSON observations; safe to repeat")
    enqueue.add_argument("--input", required=True, help="UTF-8 JSON file or - for stdin")
    commands.add_parser("status", help="show binding and counts without requiring credentials")
    for name in ("flush", "run"):
        command = commands.add_parser(name, help="send pending observations" + (" repeatedly until interrupted" if name == "run" else " with bounded retries"))
        source = command.add_mutually_exclusive_group()
        source.add_argument("--token-file", help="private credential file; never pass a token as a command argument")
        source.add_argument("--token-env", default="TERRAVIVA_SENSOR_TOKEN", help="environment variable name, not its value")
        command.add_argument("--timeout", type=float, default=10)
        command.add_argument("--retries", type=int, default=3, help="extra attempts per transient batch failure, at most 5")
        command.add_argument("--max-batches", type=int, default=20, help="bounded work per flush cycle, at most 100")
        if name == "run":
            command.add_argument("--interval", type=float, default=30, help="seconds between cycles, 1–60")
            command.add_argument("--cycles", type=int, default=0, help="0 runs until interrupted; positive values bound the run")
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            binding = (args.endpoint, args.device_id, args.farm)
        else:
            binding = None
        with Outbox(args.db, binding=binding) as outbox:
            if args.command in ("init", "status"):
                print(json.dumps(outbox.status()))
            elif args.command == "enqueue":
                print(json.dumps(outbox.enqueue(load_input(args.input))))
            else:
                loader = lambda: credential(args.token_file, args.token_env)
                options = {"timeout": args.timeout, "retries": args.retries, "max_batches": args.max_batches}
                if args.command == "run":
                    run(outbox, loader, interval=args.interval, cycles=args.cycles, **options)
                else:
                    print(json.dumps(flush(outbox, loader(), **options)))
        return 0
    except GatewayError as error:
        print("Sensor gateway: " + str(error), file=sys.stderr)
        return error.code
    except (OSError, sqlite3.Error):
        print("Sensor gateway: local queue/storage operation failed. Unconfirmed readings remain queued; check disk space and permissions.", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("Sensor gateway stopped. Unconfirmed readings remain queued.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
