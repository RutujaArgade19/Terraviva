#!/usr/bin/env python3
"""Isolated gateway tests. All observations and credentials are synthetic."""

from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from email.message import Message
from http.client import BadStatusLine, IncompleteRead
import importlib.util
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import urllib.response


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("terraviva_sensor_gateway", ROOT / "scripts/sensor-gateway.py")
G = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = G
SPEC.loader.exec_module(G)
ENDPOINT = "https://sensor-tests.invalid/api/sensors"
TOKEN = "synthetic-test-credential-never-use-live-0123456789"
BINDING = (ENDPOINT, "probe-north", "test-farm")
RECEIVED = "2026-01-02T12:00:00.000Z"


def observation(index=1, **changes):
    value = {"id": "reading-%d" % index, "deviceId": "probe-north", "field": "North Field",
             "observedAt": "2020-02-29T10:30:00+02:00", "measurement": "soil_moisture",
             "value": "00023.500", "unit": "%", "quality": "unverified"}
    value.update(changes)
    return value


def receipt(rows, *, status=201, accepted=None, **changes):
    accepted = len(rows) if accepted is None else accepted
    reply = {"farm": BINDING[2], "deviceId": BINDING[1], "accepted": accepted,
             "duplicates": len(rows) - accepted, "totalReadings": len(rows), "capacity": 10000,
             "readings": [dict(row, receivedAt=RECEIVED) for row in rows]}
    reply.update(changes)
    return G.Response(status, {"Content-Type": "application/json; charset=utf-8"}, G.json_text(reply).encode())


class Receiver:
    """Model only the server's stable IDs/receipts, not its implementation."""

    def __init__(self):
        self.stored = {}
        self.calls = []

    def __call__(self, endpoint, token, body, timeout):
        if endpoint != ENDPOINT or token != TOKEN or not 1 <= timeout <= 30:
            raise AssertionError("Unexpected transport configuration")
        self.calls.append(body)
        rows = json.loads(body)["readings"]
        added = 0
        for row in rows:
            previous = self.stored.get(row["id"])
            if previous is not None and previous != row:
                return G.Response(409, {}, b"")
            if previous is None:
                self.stored[row["id"]] = row
                added += 1
        return receipt(rows, status=201 if added else 200, accepted=added, totalReadings=len(self.stored))


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="terraviva-gateway-test-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "outbox.sqlite3"
        self.box = G.Outbox(self.path, binding=BINDING)
        self.addCleanup(lambda: self.box.close())
        self.receiver = Receiver()

    def test_enqueues_atomically_and_deduplicates(self):
        first = observation()
        self.assertEqual(self.box.enqueue([first, first]), {"enqueued": 1, "duplicates": 1})
        with self.assertRaisesRegex(G.GatewayError, "entire input"):
            self.box.enqueue([observation(2), observation(value="24.1")])
        self.assertEqual(self.box.status()["pending"], 1)
        self.assertEqual(self.box.batch()[0], [first])

    def test_invalid_input_rolls_back_the_whole_enqueue(self):
        invalids = [observation(deviceId="other-device"), observation(farm="other-farm"),
                    observation(observedAt="2023-02-29T10:00:00Z"), observation(observedAt="2020-01-01T00:00:00"),
                    observation(observedAt="2020-01-01T00:00:00+14:01"), observation(value="NaN"),
                    observation(value="1e400"), observation(value=True), observation(unit="mV"),
                    observation(quality="farmer-approved"), observation(field="\ud800"), observation(field="\ufeff"),
                    observation(field="🌾" * 61), observation(id=9007199254740993)]
        for row in invalids:
            with self.subTest(row=row), self.assertRaises(G.GatewayError):
                self.box.enqueue([observation(2), row])
            self.assertEqual(self.box.status()["pending"], 0)

    def test_late_readings_and_lexical_numbers_survive_reopen(self):
        self.box.enqueue([observation(2), observation(1, observedAt="2010-01-01T02:30:00+02:00")])
        self.box.close()
        self.box = G.Outbox(self.path)
        rows, body = self.box.batch()
        self.assertEqual([row["id"] for row in rows], ["reading-2", "reading-1"])
        self.assertEqual(rows[1]["observedAt"], "2010-01-01T02:30:00+02:00")
        self.assertIn(b'"value":"00023.500"', body)

    def test_committed_enqueue_survives_unclean_process_exit(self):
        script = """
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('gateway_child', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
box = module.Outbox(sys.argv[2])
box.enqueue(json.loads(sys.argv[3]))
os._exit(0)
"""
        result = subprocess.run([sys.executable, "-c", script, str(ROOT / "scripts/sensor-gateway.py"),
                                 str(self.path), json.dumps([observation()])], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.box.close()
        self.box = G.Outbox(self.path)
        self.assertEqual(self.box.status()["pending"], 1)
        self.assertEqual(self.box.batch()[0], [observation()])

    def test_queue_binding_cannot_be_changed_by_reinitialization(self):
        self.box.enqueue([observation()])
        for binding in [("https://another.invalid/api/sensors", BINDING[1], BINDING[2]),
                        (ENDPOINT, "another-device", BINDING[2]), (ENDPOINT, BINDING[1], "another-farm")]:
            with self.subTest(binding=binding), self.assertRaisesRegex(G.GatewayError, "already bound"):
                G.Outbox(self.path, binding=binding)
        with G.Outbox(self.path, binding=BINDING) as another:
            self.assertEqual(another.status()["pending"], 1)
            self.assertEqual(another.binding["farm"], BINDING[2])

    def test_only_https_sensor_endpoint_without_embedded_secrets_is_allowed(self):
        invalid = ["http://sensor-tests.invalid/api/sensors", "https://user:password@sensor-tests.invalid/api/sensors",
                   ENDPOINT + "?token=secret", ENDPOINT + "#token", "https://sensor-tests.invalid/elsewhere",
                   "https://sensor-tests.invalid\n/api/sensors", "https://sensor-tests.invalid:99999/api/sensors"]
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(G.GatewayError):
                G.endpoint_url(url)
        self.assertEqual(G.endpoint_url("https://SENSOR-TESTS.invalid:443/api/sensors"), ENDPOINT)

    def test_numeric_json_uses_decimal_text_without_precision_loss(self):
        input_path = Path(self.directory.name) / "readings.json"
        base = observation(id="9007199254740993")
        base.pop("quality")
        encoded = json.dumps({"readings": [base]})
        input_path.write_text(encoded.replace('"00023.500"', "9007199254740993.1200"))
        self.box.enqueue(G.load_input(str(input_path)))
        rows, _ = self.box.batch()
        self.assertEqual(rows[0]["value"], "9007199254740993.1200")
        self.assertEqual(rows[0]["id"], "9007199254740993")
        self.assertEqual(rows[0]["quality"], "unverified")
        self.assertEqual(G.flush(self.box, TOKEN, send=self.receiver)["pending"], 0)

    def test_json_duplicate_keys_and_nonfinite_constants_rejected(self):
        input_path = Path(self.directory.name) / "readings.json"
        for raw in ('{"readings":[],"readings":[]}', '[{"value":NaN}]', '{"readings":[],"farm":"x"}'):
            input_path.write_text(raw)
            with self.subTest(raw=raw), self.assertRaises(G.GatewayError):
                G.load_input(str(input_path))

    def test_clock_error_does_not_enqueue_future_data(self):
        future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(timespec="seconds")
        with self.assertRaisesRegex(G.GatewayError, "future"):
            self.box.enqueue([observation(observedAt=future)])
        self.assertEqual(self.box.status()["pending"], 0)

    def test_acknowledgement_keeps_identity_tombstone(self):
        self.box.enqueue([observation()])
        self.assertEqual(G.flush(self.box, TOKEN, send=self.receiver), {"acknowledged": 1, "batches": 1, "pending": 0})
        self.assertEqual(self.box.enqueue([observation()]), {"enqueued": 0, "duplicates": 1})
        with self.assertRaisesRegex(G.GatewayError, "conflicts"):
            self.box.enqueue([observation(value="23.6")])
        stored = self.box.connection.execute("SELECT payload, received_at FROM outbox").fetchone()
        self.assertIsNone(stored["payload"])
        self.assertEqual(stored["received_at"], RECEIVED)
        self.assertEqual(self.box.status()["acknowledged"], 1)

    def test_lost_reply_retries_exact_body_and_does_not_duplicate_server_rows(self):
        self.box.enqueue([observation()])
        waits = []
        def lose_first(*args):
            response = self.receiver(*args)
            if len(self.receiver.calls) == 1:
                raise G.GatewayError("Uncertain receipt", code=4, transient=True)
            return response
        result = G.flush(self.box, TOKEN, send=lose_first, sleep=waits.append)
        self.assertEqual(result["acknowledged"], 1)
        self.assertEqual(len(self.receiver.stored), 1)
        self.assertEqual(self.receiver.calls[0], self.receiver.calls[1])
        self.assertEqual(waits, [1.0])

    def test_crash_between_server_receipt_and_local_ack_replays_safely(self):
        self.box.enqueue([observation()])
        with patch.object(self.box, "acknowledge", side_effect=RuntimeError("simulated process interruption")):
            with self.assertRaises(RuntimeError):
                G.flush(self.box, TOKEN, send=self.receiver)
        self.box.close()
        self.box = G.Outbox(self.path)
        self.assertEqual(self.box.status()["pending"], 1)
        result = G.flush(self.box, TOKEN, send=self.receiver)
        self.assertEqual(result["acknowledged"], 1)
        self.assertEqual(len(self.receiver.stored), 1)

    def test_entire_batch_remains_when_any_receipt_is_wrong(self):
        rows = [observation(1), observation(2)]
        self.box.enqueue(rows)
        valid = json.loads(receipt(rows).body)
        mutations = [lambda r: r.update(farm="other-farm"), lambda r: r.update(deviceId="other-device"),
                     lambda r: r.update(accepted=True), lambda r: r.update(duplicates=1),
                     lambda r: r.update(totalReadings=1), lambda r: r.update(capacity=20000),
                     lambda r: r["readings"].pop(), lambda r: r["readings"][1].update(value=23.5),
                     lambda r: r["readings"][1].update(value="23.500"),
                     lambda r: r["readings"][1].update(id="reading-1"),
                     lambda r: r["readings"][1].update(receivedAt="yesterday"),
                     lambda r: r["readings"][1].pop("receivedAt"), lambda r: r.update(unexpected="data")]
        for mutate in mutations:
            reply = json.loads(json.dumps(valid))
            mutate(reply)
            response = G.Response(201, {"Content-Type": "application/json"}, json.dumps(reply).encode())
            with self.subTest(mutate=mutate), self.assertRaises(G.GatewayError) as caught:
                G.flush(self.box, TOKEN, send=lambda *_: response, sleep=lambda _: self.fail("must stop on invalid receipt"))
            self.assertEqual(caught.exception.code, 5)
            self.assertEqual(self.box.status()["pending"], 2)
        self.assertEqual(G.flush(self.box, TOKEN, send=self.receiver)["pending"], 0)

    def test_non_json_truncated_duplicate_key_and_oversized_receipts_are_uncertain(self):
        self.box.enqueue([observation()])
        responses = [G.Response(201, {"Content-Type": "text/html"}, b"<html>ok</html>"),
                     G.Response(201, {"Content-Type": "application/json"}, b'{"farm":'),
                     G.Response(201, {"Content-Type": "application/json"}, b'{"farm":"a","farm":"b"}'),
                     G.Response(201, {"Content-Type": "application/json"}, b" " * (G.MAX_RESPONSE_BYTES + 1)),
                     receipt([observation()], status=200, accepted=1)]
        for response in responses:
            with self.subTest(response=response.status), self.assertRaises(G.GatewayError) as caught:
                G.flush(self.box, TOKEN, send=lambda *_: response)
            self.assertEqual(caught.exception.code, 5)
            self.assertEqual(self.box.status()["pending"], 1)

    def test_permanent_failures_never_retry_or_evict(self):
        self.box.enqueue([observation()])
        for status in (400, 401, 403, 409, 413, 415, 507, 301, 302, 303, 307, 308):
            calls = []
            def reject(*args):
                calls.append(args)
                return G.Response(status, {}, b"untrusted diagnostic")
            with self.subTest(status=status), self.assertRaises(G.GatewayError) as caught:
                G.flush(self.box, TOKEN, send=reject, sleep=lambda _: self.fail("permanent retry"))
            self.assertEqual(caught.exception.code, 3)
            self.assertFalse(caught.exception.transient)
            self.assertEqual(len(calls), 1)
            self.assertEqual(self.box.status()["pending"], 1)

    def test_transient_retry_budget_and_retry_after_are_bounded(self):
        self.box.enqueue([observation()])
        responses = [G.Response(429, {"Retry-After": "20"}, b""), G.Response(503, {}, b"")]
        waits = []
        def eventually(*args):
            return responses.pop(0) if responses else self.receiver(*args)
        self.assertEqual(G.flush(self.box, TOKEN, send=eventually, sleep=waits.append)["pending"], 0)
        self.assertEqual(waits, [20, 2])
        self.assertEqual(G.retry_delay({"retry-after": "999999"}, 0), 60)
        self.assertEqual(G.retry_delay({"retry-after": "not a date"}, 1), 2)
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.assertEqual(G.retry_delay({"Retry-After": "Thu, 01 Jan 2026 00:00:10 GMT"}, 0, now=now), 10)
        self.box.enqueue([observation(2)])
        calls, waits = [], []
        def unavailable(*args):
            calls.append(args)
            return G.Response(503, {}, b"")
        with self.assertRaises(G.GatewayError) as caught:
            G.flush(self.box, TOKEN, retries=2, send=unavailable, sleep=waits.append)
        self.assertTrue(caught.exception.transient)
        self.assertEqual(len(calls), 3)
        self.assertEqual(waits, [1, 2])
        self.assertEqual(self.box.status()["pending"], 1)

    def test_batch_row_limit_and_bounded_flush(self):
        self.box.enqueue([observation(index) for index in range(501)])
        result = G.flush(self.box, TOKEN, max_batches=1, send=self.receiver)
        self.assertEqual(result, {"acknowledged": 500, "batches": 1, "pending": 1})
        self.assertLessEqual(len(self.receiver.calls[0]), G.MAX_REQUEST_BYTES)
        self.assertEqual(G.flush(self.box, TOKEN, send=self.receiver)["pending"], 0)

    def test_batch_bytes_are_counted_as_utf8_with_full_envelope(self):
        # Long legal Unicode fields make 500 readings exceed 256 KiB.
        rows = [observation(index, id=("x" * 120) + str(index), field="田" * 120,
                            value="0." + "0" * 70) for index in range(500)]
        self.box.enqueue(rows)
        chosen, body = self.box.batch()
        self.assertLess(len(chosen), 500)
        self.assertLessEqual(len(body), G.MAX_REQUEST_BYTES)
        next_length = len(G.json_text(rows[len(chosen)]).encode()) + 1
        self.assertGreater(len(body) + next_length, G.MAX_REQUEST_BYTES)
        result = G.flush(self.box, TOKEN, send=self.receiver)
        self.assertEqual(result["acknowledged"], 500)
        self.assertTrue(all(len(body) <= G.MAX_REQUEST_BYTES for body in self.receiver.calls))

    def test_run_drains_arrivals_from_another_connection(self):
        self.box.enqueue([observation(1)])
        outputs, intervals = [], []
        def next_cycle(interval):
            intervals.append(interval)
            with G.Outbox(self.path) as producer:
                producer.enqueue([observation(2)])
        G.run(self.box, lambda: TOKEN, cycles=2, interval=2, send=self.receiver,
              sleep=next_cycle, output=outputs.append)
        self.assertEqual(len(outputs), 2)
        self.assertEqual(intervals, [2])
        self.assertEqual(self.box.status()["pending"], 0)
        self.assertEqual(len(self.receiver.stored), 2)

    def test_run_stops_on_permanent_failures_but_waits_for_network_recovery(self):
        self.box.enqueue([observation()])
        for status in (401, 403, 409, 507):
            with self.subTest(status=status), self.assertRaises(G.GatewayError):
                G.run(self.box, lambda: TOKEN, cycles=2, send=lambda *_: G.Response(status, {}, b""),
                      sleep=lambda _: self.fail("permanent error must stop run"), output=lambda _: None)
        calls, outputs = [], []
        def offline_once(*args):
            calls.append(1)
            if len(calls) == 1:
                raise G.GatewayError("offline", code=4, transient=True)
            return self.receiver(*args)
        G.run(self.box, lambda: TOKEN, cycles=2, retries=0, interval=1, send=offline_once,
              sleep=lambda _: None, output=outputs.append)
        self.assertIn("retry", outputs[0])
        self.assertEqual(self.box.status()["pending"], 0)

    def test_finite_run_returns_failure_when_recovery_did_not_occur(self):
        self.box.enqueue([observation()])
        with self.assertRaises(G.GatewayError) as caught:
            G.run(self.box, lambda: TOKEN, cycles=1, retries=0, send=lambda *_: G.Response(503, {}, b""),
                  output=lambda _: None, sleep=lambda _: self.fail("finite cycle unexpectedly slept"))
        self.assertEqual(caught.exception.code, 4)
        self.assertEqual(self.box.status()["pending"], 1)

    def test_acknowledgement_transaction_rolls_back_on_local_conflict(self):
        rows = [observation(1), observation(2)]
        self.box.enqueue(rows)
        checked = G.validated_receipts(receipt(rows), rows, self.box.binding)
        self.box.connection.execute("UPDATE outbox SET fingerprint = 'damaged' WHERE id = 'reading-2'")
        with self.assertRaises(G.GatewayError):
            self.box.acknowledge(rows, checked)
        self.assertEqual(self.box.status()["pending"], 2)
        with self.assertRaises(G.GatewayError):
            G.flush(self.box, TOKEN, send=lambda *_: self.fail("corrupt batch was sent"))

    def test_two_senders_can_validate_the_same_pending_batch(self):
        self.box.enqueue([observation()])
        with G.Outbox(self.path) as another:
            rows, body = self.box.batch()
            rows2, body2 = another.batch()
            first = self.receiver(ENDPOINT, TOKEN, body, 10)
            second = self.receiver(ENDPOINT, TOKEN, body2, 10)
            another.acknowledge(rows2, G.validated_receipts(second, rows2, another.binding))
            self.box.acknowledge(rows, G.validated_receipts(first, rows, self.box.binding))
        self.assertEqual(self.box.status()["acknowledged"], 1)
        self.assertEqual(len(self.receiver.stored), 1)

    def test_credentials_never_enter_queue_or_normal_output(self):
        token_path = Path(self.directory.name) / "device.token"
        token_path.write_text(TOKEN + "\n")
        token_path.chmod(0o600)
        self.assertEqual(G.credential(str(token_path)), TOKEN)
        with patch.dict(os.environ, {"TERRAVIVA_SENSOR_TOKEN": TOKEN}):
            self.assertEqual(G.credential(), TOKEN)
        self.box.enqueue([observation()])
        G.flush(self.box, G.credential(str(token_path)), send=self.receiver)
        self.assertNotIn(TOKEN, "\n".join(self.box.connection.iterdump()))
        for file in self.path.parent.glob("outbox.sqlite3*"):
            self.assertNotIn(TOKEN.encode(), file.read_bytes())
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            self.assertEqual(G.main(["--db", str(self.path), "status"]), 0)
        self.assertNotIn(TOKEN, output.getvalue() + errors.getvalue())
        self.assertNotIn("00023.500", output.getvalue() + errors.getvalue())

    @unittest.skipUnless(os.name == "posix", "POSIX file permissions")
    def test_private_files_and_symlinks(self):
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        unsafe = Path(self.directory.name) / "public"
        unsafe.mkdir(mode=0o755)
        with self.assertRaisesRegex(G.GatewayError, "0700"):
            G.Outbox(unsafe / "outbox.sqlite3", binding=BINDING)
        alias = Path(self.directory.name) / "alias"
        alias.symlink_to(self.path)
        with self.assertRaises(G.GatewayError):
            G.Outbox(alias)
        token_path = Path(self.directory.name) / "bad.token"
        token_path.write_text(TOKEN)
        token_path.chmod(0o644)
        with self.assertRaisesRegex(G.GatewayError, "0600"):
            G.credential(str(token_path))
        token_path.chmod(0o600)
        token_path.write_text(TOKEN + "\n" * 3000)
        with self.assertRaisesRegex(G.GatewayError, "size"):
            G.credential(str(token_path))


class TransportTests(unittest.TestCase):
    def test_real_urllib_handler_never_follows_a_redirect(self):
        # Use urllib's real response/redirect processors with a fake network handler.
        # Both protocols are replaced: a regression cannot make an actual network call.
        real_builder = urllib.request.build_opener
        for status in (301, 302, 303, 307, 308):
            calls = []
            class FakeHTTPS(urllib.request.HTTPSHandler):
                def https_open(self, request):
                    calls.append(request)
                    headers = Message()
                    headers["Location"] = "https://untrusted.invalid/collect"
                    response = urllib.response.addinfourl(io.BytesIO(TOKEN.encode()), headers, request.full_url, status)
                    response.msg = "Redirect"
                    return response
            class NoHTTP(urllib.request.HTTPHandler):
                def http_open(self, _request):
                    raise AssertionError("HTTP downgrade attempted")
            with self.subTest(status=status), patch.object(G.urllib.request, "build_opener", side_effect=lambda *handlers: real_builder(FakeHTTPS(), NoHTTP(), *handlers)):
                response = G.send_https(ENDPOINT, TOKEN, b'{"readings":[]}', 10)
            self.assertEqual(response.status, status)
            self.assertEqual(response.body, b"")
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0].full_url, ENDPOINT)
            self.assertEqual(calls[0].get_header("Authorization"), "Bearer " + TOKEN)

    def test_network_exceptions_are_sanitized(self):
        for failure in (urllib.error.URLError("accidental credential echo: " + TOKEN),
                        BadStatusLine(TOKEN), IncompleteRead(TOKEN.encode(), 100)):
            class Broken:
                def open(self, *_args, **_kwargs):
                    raise failure
            with self.subTest(failure=type(failure).__name__), patch.object(G.urllib.request, "build_opener", return_value=Broken()):
                with self.assertRaises(G.GatewayError) as caught:
                    G.send_https(ENDPOINT, TOKEN, b'{"readings":[]}', 10)
            self.assertTrue(caught.exception.transient)
            self.assertNotIn(TOKEN, str(caught.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
