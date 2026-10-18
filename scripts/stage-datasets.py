#!/usr/bin/env python3
"""Build an offline SQLite snapshot from explicit CSV/TSV/JSON inputs.

Examples, after the source archive is available:
  python3 scripts/stage-datasets.py --input /path/all-datasets.zip
  python3 scripts/stage-datasets.py --input /path/all-datasets.zip --replace
  python3 scripts/stage-datasets.py --input /path/all-datasets.zip --replace --publish-app

Nothing is downloaded, committed, deployed, assigned to a farmer, or imported
into the private depot. --publish-app is deliberately separate: its output is
public reference data if the app is subsequently deployed. Existing output is
never replaced without --replace and generated-output ownership checks.

Every supported source file's original bytes are stored in source_files.
Original CSV cell strings and JSON number lexemes are retained in row_json.
JSON views contain ALL rows or are marked requires-split; no sampling occurs.
Views wrap records with _terravivaDataset provenance and sourceContext. The
context is a mapping from ancestor JSON Pointers to their metadata. Array-valued
fields are recursively omitted while scalar/object siblings, including explicit
farm claims, are retained; context cannot become extra tables.
The original file bytes remain authoritative for the entire source envelope.
"""
from __future__ import annotations

import argparse
from collections import Counter, OrderedDict
from contextlib import contextmanager
import csv
from dataclasses import dataclass
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import sys
import tempfile
from typing import Any, Callable, Iterator
import zipfile


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = "terraviva.stage-datasets"
VERSION = 1
MIB = 1024 * 1024
VIEW_LIMIT = MIB
STAGE_MARKER = ".terraviva-stage.json"
APP_MARKER = ".terraviva-datasets-owner.json"
SUPPORTED = {".csv": "csv", ".tsv": "tsv", ".json": "json"}
MEDIA_TYPES = {"csv": "text/csv", "tsv": "text/tab-separated-values", "json": "application/json"}
NUMBER = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
JSON_NUMBER = re.compile(r"^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$")


class StageError(Exception):
    """A bounded, reviewable input or output failure."""


class JSONNumber(str):
    """A validated JSON numeric lexeme, kept exact instead of becoming float."""


@dataclass(frozen=True)
class Limits:
    expanded: int = 200 * MIB
    member: int = 50 * MIB
    rows: int = 100_000
    columns: int = 500
    cells: int = 2_000_000
    tables: int = 256
    json_nodes: int = 2_000_000
    depth: int = 100
    flatten_depth: int = 5


@dataclass
class SourceSpec:
    path: str
    size: int
    format: str
    read: Callable[[], bytes]


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(MIB), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical(value: Any) -> str:
    """Deterministic valid JSON, preserving numeric lexemes and value types."""
    if isinstance(value, JSONNumber):
        if not JSON_NUMBER.fullmatch(value):
            raise StageError("Invalid internal JSON number representation.")
        return str(value)
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return json.dumps(value, allow_nan=False, separators=(",", ":"))
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=True)
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(canonical(key) + ":" + canonical(value[key]) for key in sorted(value)) + "}"
    raise StageError(f"Unsupported internal value type: {type(value).__name__}")


def write_json(path: Path, value: Any) -> None:
    path.write_text(canonical(value) + "\n", encoding="utf-8")


def pointer(path: tuple[str, ...]) -> str:
    return "" if not path else "/" + "/".join(key.replace("~", "~0").replace("/", "~1") for key in path)


def safe_member(name: str) -> str:
    # No original archive name is ever used as an extraction destination.
    # Reject cross-platform traversal nonetheless, before extension filtering.
    if not name or "\x00" in name or name.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", name):
        raise StageError(f"Unsafe archive path: {name!r}")
    normalized = name.replace("\\", "/")
    pieces = normalized.split("/")
    if ".." in pieces or any(":" in piece for piece in pieces):
        raise StageError(f"Unsafe archive path: {name!r}")
    path = PurePosixPath(normalized)
    if path.is_absolute() or str(path) in ("", "."):
        raise StageError(f"Unsafe archive path: {name!r}")
    return path.as_posix().rstrip("/")


def metadata_path(path: str) -> bool:
    parts = PurePosixPath(path).parts
    return "__MACOSX" in parts or any(part in {".DS_Store", "Thumbs.db", "desktop.ini"} for part in parts)


def read_bounded(stream: Any, declared: int, limits: Limits) -> bytes:
    parts: list[bytes] = []
    size = 0
    while True:
        chunk = stream.read(min(MIB, limits.member - size + 1))
        if not chunk:
            break
        size += len(chunk)
        if size > limits.member:
            raise StageError("Expanded member exceeds the configured per-file byte limit.")
        parts.append(chunk)
    if size != declared:
        raise StageError("Source size changed while reading, or archive member size is inconsistent.")
    return b"".join(parts)


def disk_reader(path: Path, declared: int, limits: Limits) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise StageError(f"Only regular data files are supported: {path.name}")
        result = read_bounded(stream, declared, limits)
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise StageError(f"Source changed while reading: {path.name}")
        return result


@contextmanager
def sources(input_path: Path, limits: Limits) -> Iterator[tuple[dict, list[SourceSpec], list[dict]]]:
    specs: list[SourceSpec] = []
    skipped: list[dict] = []
    seen: set[str] = set()
    total = 0

    def add(path: str, size: int, reader: Callable[[], bytes]) -> None:
        nonlocal total
        suffix = PurePosixPath(path).suffix.lower()
        if metadata_path(path):
            skipped.append({"file": path, "reason": "operating-system metadata"})
            return
        if suffix not in SUPPORTED:
            skipped.append({"file": path, "reason": "unsupported non-data extension; not opened"})
            return
        if path in seen:
            raise StageError(f"Repeated normalized source path: {path}")
        seen.add(path)
        if size > limits.member:
            raise StageError(f"{path} exceeds the per-file limit of {limits.member} bytes.")
        total += size
        if total > limits.expanded:
            raise StageError(f"Supported expanded data exceeds the total limit of {limits.expanded} bytes.")
        specs.append(SourceSpec(path, size, SUPPORTED[suffix], reader))

    if input_path.is_dir():
        for current, directories, filenames in os.walk(input_path, followlinks=False):
            directories.sort()
            for name in directories:
                if (Path(current) / name).is_symlink():
                    raise StageError(f"Symlink directory is not accepted: {name}")
            for name in sorted(filenames):
                path = Path(current) / name
                logical = safe_member(path.relative_to(input_path).as_posix())
                if path.is_symlink():
                    raise StageError(f"Symlink file is not accepted: {logical}")
                info = path.stat()
                if not stat.S_ISREG(info.st_mode):
                    raise StageError(f"Special file is not accepted: {logical}")
                add(logical, info.st_size, lambda p=path, size=info.st_size: disk_reader(p, size, limits))
        origin = {"kind": "directory", "name": input_path.name}
        yield origin, sorted(specs, key=lambda item: item.path), skipped
        return

    if not input_path.is_file():
        raise StageError(f"Input is not an accessible file or directory: {input_path}")
    if input_path.suffix.lower() == ".zip":
        before = input_path.stat()
        container_sha = file_sha(input_path)
        with zipfile.ZipFile(input_path) as archive:
            for info in archive.infolist():
                logical = safe_member(info.filename)
                mode = info.external_attr >> 16
                file_type = stat.S_IFMT(mode)
                if stat.S_ISLNK(mode):
                    raise StageError(f"Archive symlink is not accepted: {logical}")
                if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise StageError(f"Archive special file is not accepted: {logical}")
                if info.is_dir():
                    continue
                if info.flag_bits & 1:
                    raise StageError(f"Encrypted archive member is not supported: {logical}")

                def reader(member=info) -> bytes:
                    with archive.open(member, "r") as stream:
                        return read_bounded(stream, member.file_size, limits)

                add(logical, info.file_size, reader)
            yield {"kind": "zip", "name": input_path.name, "sha256": container_sha}, sorted(specs, key=lambda item: item.path), skipped
        after = input_path.stat()
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise StageError("The source archive changed during the build.")
        return
    logical = safe_member(input_path.name)
    size = input_path.stat().st_size
    add(logical, size, lambda: disk_reader(input_path, size, limits))
    yield {"kind": "file", "name": input_path.name}, specs, skipped


def decode(data: bytes, filename: str) -> tuple[str, str]:
    try:
        if data.startswith((b"\xff\xfe", b"\xfe\xff")):
            return data.decode("utf-16"), "UTF-16 with BOM"
        text = data.decode("utf-8-sig")
        if "\x00" in text:
            raise StageError(f"{filename}: NUL bytes suggest unsupported encoding or binary data.")
        return text, "UTF-8 with BOM" if data.startswith(b"\xef\xbb\xbf") else "UTF-8"
    except UnicodeError as exc:
        raise StageError(f"{filename}: use UTF-8, or UTF-16 with an explicit BOM; no lossy encoding guess is applied.") from exc


def json_preflight(text: str, limits: Limits) -> None:
    in_string = escaped = False
    depth = nodes = 0
    previous = ""
    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            nodes += 1
        elif char in "[{":
            depth += 1
            nodes += 1
            if depth > limits.depth:
                raise StageError(f"JSON exceeds {limits.depth} nesting levels.")
        elif char in "]}":
            depth -= 1
        elif char not in " \t\r\n,:" and previous in ("", "[", ",", ":"):
            nodes += 1
        if char not in " \t\r\n":
            previous = char
        if nodes > limits.json_nodes:
            raise StageError(f"JSON exceeds the bounded complexity limit of {limits.json_nodes} tokens.")


def load_exact_json(text: str, limits: Limits) -> Any:
    json_preflight(text, limits)

    def pairs(items: list[tuple[str, Any]]) -> dict:
        result = {}
        for key, value in items:
            if key in result:
                raise StageError(f"Duplicate JSON key would overwrite original data: {key!r}")
            result[key] = value
        return result

    def constant(value: str) -> None:
        raise StageError(f"Non-standard JSON numeric literal is not accepted: {value}")

    try:
        return json.loads(text, parse_int=JSONNumber, parse_float=JSONNumber, parse_constant=constant, object_pairs_hook=pairs)
    except (ValueError, RecursionError) as exc:
        raise StageError(f"Invalid JSON: {exc}") from exc


def prune_context_arrays(value: Any) -> Any:
    """Remove array fields recursively without discarding sibling farm claims."""
    if isinstance(value, dict):
        return {key: prune_context_arrays(item) for key, item in value.items() if not isinstance(item, list)}
    return value


def table_context(root: Any, path: tuple[str, ...]) -> dict:
    result = {}
    current = root
    for index in range(len(path)):
        if not isinstance(current, dict):
            break
        branch = path[index]
        metadata = {key: prune_context_arrays(item) for key, item in current.items()
                    if key != branch and not isinstance(item, list)}
        if metadata:
            result[pointer(path[:index])] = metadata
        current = current[branch]
    return result


def json_tables(root: Any, limits: Limits) -> list[dict]:
    if isinstance(root, list):
        return [{"path": (), "rows": root, "context": {}, "lines": None}]
    found: list[dict] = []

    def walk(value: dict, path: tuple[str, ...]) -> None:
        for key in sorted(value):
            item, next_path = value[key], path + (key,)
            if isinstance(item, list):
                found.append({"path": next_path, "rows": item, "context": table_context(root, next_path), "lines": None})
                if len(found) > limits.tables:
                    raise StageError(f"Source exceeds {limits.tables} distinct JSON tables.")
            elif isinstance(item, dict):
                walk(item, next_path)

    if isinstance(root, dict):
        walk(root, ())
    if not found:
        found.append({"path": (), "rows": [root], "context": {}, "lines": None})
    for table in found:
        if len(table["rows"]) > limits.rows:
            raise StageError(f"Table {pointer(table['path']) or '/'} exceeds {limits.rows} rows; no truncation is permitted.")
    return found


def csv_records(text: str, delimiter: str) -> Iterator[tuple[list[str], int]]:
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter, strict=True)
    previous_line = 0
    for record in reader:
        line = previous_line + 1
        previous_line = reader.line_num
        if record:  # Only completely empty physical lines are skipped.
            yield record, line


def delimiter_for(text: str, format_name: str, explicit: str | None, limits: Limits) -> str:
    if explicit:
        return explicit
    if format_name == "tsv":
        return "\t"
    candidates = []
    for delimiter in (",", ";", "\t"):
        try:
            widths = Counter()
            first = None
            count = 0
            for record, _ in csv_records(text, delimiter):
                count += 1
                if count > limits.rows + 1:
                    raise StageError(f"CSV exceeds {limits.rows} rows.")
                if first is None:
                    first = len(record)
                widths[len(record)] += 1
            if first and first > 1:
                candidates.append((widths[first] / count, first, delimiter))
        except csv.Error:
            continue
    if not candidates:
        return ","
    candidates.sort(reverse=True)
    if len(candidates) > 1 and candidates[0][0] - candidates[1][0] < 0.05:
        raise StageError("CSV delimiter is ambiguous. Supply --delimiter comma, semicolon, or tab, or stage this file separately.")
    return candidates[0][2]


def csv_table(text: str, format_name: str, explicit: str | None, limits: Limits) -> dict:
    csv.field_size_limit(limits.member)
    delimiter = delimiter_for(text, format_name, explicit, limits)
    rows, lines = [], []
    try:
        reader = iter(csv_records(text, delimiter))
        headers, header_line = next(reader)
        if len(headers) > limits.columns:
            raise StageError(f"CSV header exceeds {limits.columns} columns.")
        names, used = [], set()
        for index, header in enumerate(headers):
            base = header if header else f"Column {index + 1}"
            candidate, ordinal = base, 2
            while candidate in used:
                candidate = f"{base} [{ordinal}]"
                ordinal += 1
            used.add(candidate)
            names.append(candidate)
        for record, line in reader:
            if len(record) != len(headers):
                raise StageError(f"CSV line {line} has {len(record)} fields; the header has {len(headers)}. Correct ragged rows before staging.")
            rows.append(dict(zip(names, record)))
            lines.append(line)
            if len(rows) > limits.rows:
                raise StageError(f"CSV exceeds {limits.rows} rows; no truncation is permitted.")
            if len(rows) * len(names) > limits.cells:
                raise StageError(f"CSV exceeds {limits.cells} profiling cells.")
    except StopIteration as exc:
        raise StageError("CSV contains no header.") from exc
    except csv.Error as exc:
        raise StageError(f"Malformed CSV: {exc}") from exc
    return {"path": (), "rows": rows, "lines": lines, "schema": names,
            "context": {}, "csv": {"delimiter": delimiter, "headerLine": header_line,
            "originalHeaders": headers, "workingHeaders": names}}


def value_type(value: Any) -> str:
    if isinstance(value, JSONNumber):
        return "number"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "number"


def missing(value: Any) -> bool:
    return value is None or isinstance(value, str) and not isinstance(value, JSONNumber) and not value.strip()


def date_like(value: Any) -> bool:
    if not isinstance(value, str) or isinstance(value, JSONNumber) or not DATE.fullmatch(value.strip()):
        return False
    try:
        dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def flatten(value: Any, path: tuple[str, ...], depth: int, limits: Limits) -> Iterator[tuple[tuple[str, ...], Any]]:
    if isinstance(value, dict) and value and depth < limits.flatten_depth:
        for key, item in value.items():
            yield from flatten(item, path + (key,), depth + 1, limits)
    else:
        yield path, value


class ColumnProfile:
    def __init__(self, path: tuple[str, ...]):
        self.path = path
        self.observed = self.present = self.numeric = self.dates = self.blanks = self.nulls = 0
        self.types: Counter = Counter()
        self.values: Counter = Counter()
        self.locales = 0
        self.leading_zero = False
        self.year_shaped = True

    def add(self, value: Any) -> None:
        self.observed += 1
        self.types[value_type(value)] += 1
        if missing(value):
            self.nulls += value is None
            self.blanks += value is not None
            return
        self.present += 1
        self.values[canonical(value)] += 1
        is_number = isinstance(value, JSONNumber) or isinstance(value, str) and bool(NUMBER.fullmatch(value.strip()))
        self.numeric += is_number
        self.dates += date_like(value)
        self.year_shaped &= bool(re.fullmatch(r"(?:18|19|20|21)\d{2}", str(value).strip()))
        if isinstance(value, str) and not isinstance(value, JSONNumber):
            self.leading_zero |= bool(re.fullmatch(r"0\d+", value.strip()))
            self.locales += bool(re.fullmatch(r"[+-]?[\d .\u00a0]+,[\d., \u00a0]+", value.strip()))

    def finish(self, row_count: int) -> dict:
        name = self.path[-1] if self.path else "(value)"
        words = re.sub(r"([a-z\d])([A-Z])", r"\1 \2", name).lower()
        words = re.sub(r"[^a-z0-9áéíóúñ]+", " ", words)
        compact = words.replace(" ", "")
        identifier = bool(re.search(r"\b(id|ids|identifier|uuid|guid|code|postal|postcode|zip|phone|mobile|iban|vat|year|año|anio)\b", words))
        identifier |= bool(re.fullmatch(r"(?:farmer|farm|field|parcel|plot|transaction|record|customer|user|buyer|order|invoice|product|crop|grant)(?:id|code|number)", compact))
        measure = bool(re.search(r"\b(quantity|weight|area|amount|price|total|count|yield|revenue|cost|value|measure)\b", words))
        identifier |= self.leading_zero or self.year_shaped and self.present > 0 and not measure
        if not self.present:
            inferred = "empty"
        elif identifier:
            inferred = "identifier"
        elif self.types["boolean"] == self.present:
            inferred = "boolean"
        elif self.numeric == self.present:
            inferred = "numeric"
        elif self.dates == self.present:
            inferred = "date"
        elif self.types["array"] + self.types["object"] == self.present:
            inferred = "structured"
        elif len(self.values) <= 20 or len(self.values) <= self.present * 0.2:
            inferred = "categorical"
        else:
            inferred = "text"
        frequent = sorted(self.values.items(), key=lambda item: (-item[1], item[0]))[:10]
        return {"path": list(self.path), "jsonPointer": pointer(self.path), "name": name,
                "type": inferred, "sourceTypes": dict(self.types), "rowsProfiled": row_count,
                "missing": row_count - self.present, "nonMissing": self.present,
                "missingKinds": {"absent": row_count - self.observed, "null": self.nulls, "blank": self.blanks},
                "distinct": len(self.values), "numericCandidates": self.numeric,
                "dateCandidates": self.dates, "unconvertedLocaleNumbers": self.locales,
                "topFrequencies": [{"valuePreview": value[:160], "previewShortened": len(value) > 160, "count": count} for value, count in frequent],
                "distinctPolicy": "Original representations; JSON number lexemes are retained, strings and numbers are distinct.",
                "missingPolicy": "Absent, null, empty or whitespace-only strings; zero, false and literal NA are values."}


def stage_table(connection: sqlite3.Connection, work: Path, source: SourceSpec, source_id: str, source_hash: str, table: dict, limits: Limits) -> dict:
    path = table["path"]
    table_pointer = pointer(path)
    dataset_id = "ds-" + sha((source_id + "\0" + table_pointer).encode())[:24]
    name = PurePosixPath(source.path).stem + (" · " + ".".join(path) if path else "")
    provenance = {"file": source.path, "sha256": source_hash, "tablePointer": table_pointer}
    descriptor = {"id": dataset_id, "role": "reference", "farmerAssignment": None,
                  "source": provenance, "sourceContext": table["context"],
                  "sourceContextPolicy": "Ancestor metadata with array-valued fields recursively omitted; scalar/object siblings and explicit farm claims retained. Full original bytes are in source_files."}
    if "csv" in table:
        descriptor["csv"] = table["csv"]
    # Context and schema metadata contain no arrays except CSV header metadata.
    # CSV header metadata is stored in SQL/catalog, not in the app view, so only
    # the actual records array becomes a discoverable table in the browser.
    view_descriptor = {key: value for key, value in descriptor.items() if key != "csv"}
    prefix = '{"_terravivaDataset":' + canonical(view_descriptor) + ',"records":['
    suffix = "]}\n"
    file_name = dataset_id + ".json"
    view_path = work / "views" / file_name
    prefix_bytes = prefix.encode("utf-8")
    view_size = len(prefix_bytes) + len(suffix)
    available = view_size <= VIEW_LIMIT
    profiles: OrderedDict[str, ColumnProfile] = OrderedDict()
    for header in table.get("schema", []):
        profiles[pointer((header,))] = ColumnProfile((header,))
    shape: Counter = Counter()
    seen_rows: set[str] = set()
    duplicate_count = 0
    rows = table["rows"]
    if len(rows) > limits.rows:
        raise StageError(f"{name} exceeds {limits.rows} rows; no truncation is permitted.")
    connection.execute("INSERT INTO datasets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                       (dataset_id, source_id, name, table_pointer, source.format, "{}", canonical(descriptor), 0, 0, 0, "available", 0))
    view_stream = view_path.open("wb")
    try:
        if available:
            view_stream.write(prefix_bytes)
        for index, record in enumerate(rows, 1):
            shape[value_type(record)] += 1
            encoded = canonical(record)
            encoded_bytes = encoded.encode("utf-8")
            record_hash = sha(encoded_bytes)
            if record_hash in seen_rows:
                duplicate_count += 1
            seen_rows.add(record_hash)
            source_line = table["lines"][index - 1] if table["lines"] is not None else None
            connection.execute("INSERT INTO rows VALUES (?,?,?,?,?)", (dataset_id, index, source_line, record_hash, encoded))
            if isinstance(record, dict):
                flat = (leaf for key, value in record.items() for leaf in flatten(value, (key,), 1, limits))
            else:
                flat = flatten(record, (), 0, limits)
            for field_path, value in flat:
                key = pointer(field_path)
                if key not in profiles:
                    profiles[key] = ColumnProfile(field_path)
                profiles[key].add(value)
                if len(profiles) > limits.columns:
                    raise StageError(f"{name} exceeds {limits.columns} flattened columns.")
            if index * len(profiles) > limits.cells:
                raise StageError(f"{name} exceeds {limits.cells} profiling cells; no sampling is permitted.")
            addition = (b"," if index > 1 else b"") + encoded_bytes
            view_size += len(addition)
            if available and view_size <= VIEW_LIMIT:
                view_stream.write(addition)
            else:
                available = False
        if available:
            view_stream.write(suffix.encode())
    finally:
        view_stream.close()
    browser_compatible = len(rows) <= 100_000 and len(profiles) <= 250 and len(rows) * len(profiles) <= 2_000_000
    available = available and browser_compatible
    if not available:
        view_path.unlink()
    column_summaries = []
    for index, profile in enumerate(profiles.values(), 1):
        result = profile.finish(len(rows))
        column_id = "col-" + sha(result["jsonPointer"].encode())[:24]
        connection.execute("INSERT INTO columns VALUES (?,?,?,?,?,?,?,?,?,?)",
                           (dataset_id, column_id, index, result["jsonPointer"], result["name"], canonical(result["sourceTypes"]),
                            result["type"], result["missing"], result["distinct"], canonical(result)))
        column_summaries.append({key: result[key] for key in ("jsonPointer", "name", "type", "missing", "distinct")})
    status = "available" if available else "requires-split"
    connection.execute("UPDATE datasets SET source_shape_json=?,row_count=?,column_count=?,duplicate_extra_rows=?,view_status=?,view_bytes=? WHERE dataset_id=?",
                       (canonical(dict(shape)), len(rows), len(profiles), duplicate_count, status, view_size, dataset_id))
    result = {"id": dataset_id, "name": name, "format": "json", "rows": len(rows), "columnCount": len(profiles),
              "columns": column_summaries, "source": provenance, "status": status,
              "file": "views/" + file_name if available else None, "bytes": view_size,
              "duplicateExtraRows": duplicate_count, "role": "reference", "farmerAssignment": None}
    if available:
        result["sha256"] = file_sha(view_path)
    else:
        result["reason"] = ("Full dataset view exceeds 1 MiB" if view_size > VIEW_LIMIT else "Dataset exceeds the browser limits of 250 columns, 100,000 rows, or 2,000,000 cells") + "; split explicitly or query the SQLite snapshot. No partial view was published."
    return result


def read_object(path: Path) -> dict:
    if path.is_symlink():
        raise StageError(f"Refusing to modify a metadata symlink: {path}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        raise StageError(f"Cannot validate existing metadata: {path}") from exc
    if not isinstance(value, dict):
        raise StageError(f"Expected an object in metadata: {path}")
    return value


def generated_files(directory: Path) -> dict[str, str]:
    return {path.relative_to(directory).as_posix(): file_sha(path) for path in sorted(directory.rglob("*")) if path.is_file() and path.name != STAGE_MARKER}


def validate_output(output: Path, replace: bool) -> None:
    if output.is_symlink():
        raise StageError("Output directory must not be a symlink.")
    if not output.exists():
        return
    if not replace:
        raise StageError(f"Output already exists: {output}. Use a new directory or explicitly pass --replace.")
    if not output.is_dir() or not (output / STAGE_MARKER).is_file():
        raise StageError("--replace only replaces a staging directory owned by this generator. Choose a new output directory.")
    marker = read_object(output / STAGE_MARKER)
    if marker.get("generator") != GENERATOR or marker.get("version") != VERSION:
        raise StageError("Existing output ownership could not be verified.")
    if any(path.is_symlink() for path in output.rglob("*")):
        raise StageError("Existing output contains a symlink; choose a new output directory.")
    if marker.get("files") != generated_files(output):
        raise StageError("Existing generated output was edited or contains unrelated files; choose a new output directory.")


def prepare_app(app: Path, stage: Path, catalog: dict, replace: bool) -> Path:
    if app.is_symlink() or app.exists() and not app.is_dir():
        raise StageError("Public dataset destination must be a regular directory.")
    if any((app / name).is_symlink() for name in ("manifest.json", APP_MARKER)):
        raise StageError("Public dataset metadata must not be a symlink.")
    existing = read_object(app / "manifest.json") if (app / "manifest.json").exists() else {"version": 1, "datasets": []}
    if (app / "manifest.json").exists() and not replace:
        raise StageError("The public dataset manifest already exists. --publish-app also needs --replace to update that manifest.")
    old_owner = read_object(app / APP_MARKER) if (app / APP_MARKER).exists() else None
    owned_ids: set[str] = set()
    owned_files: dict[str, str] = {}
    existing_rows = existing.get("datasets", [])
    existing_unpublished = existing.get("unpublishedDatasets", [])
    if not isinstance(existing_rows, list) or not isinstance(existing_unpublished, list) or any(not isinstance(row, dict) for row in existing_rows + existing_unpublished):
        raise StageError("Existing app catalog is not a supported dataset manifest.")
    if old_owner is not None:
        if old_owner.get("generator") != GENERATOR or old_owner.get("version") != VERSION:
            raise StageError("Public dataset ownership marker is not recognized.")
        owned_files = old_owner.get("files", {})
        entry_hashes = old_owner.get("entryHashes", {})
        if not isinstance(owned_files, dict) or not isinstance(entry_hashes, dict):
            raise StageError("Public dataset ownership metadata is invalid.")
        owned_ids = set(entry_hashes)
        current_by_id = {row.get("id"): row for row in existing_rows + existing_unpublished}
        for dataset_id, digest in entry_hashes.items():
            if dataset_id not in current_by_id or sha(canonical(current_by_id[dataset_id]).encode()) != digest:
                raise StageError("A generated app catalog entry was edited; choose a new destination or reconcile it explicitly.")
        for name, digest in owned_files.items():
            if not re.fullmatch(r"ds-[a-f0-9]{24}\.json", name):
                raise StageError("Unsafe generated filename in ownership marker.")
            path = app / name
            if not path.is_file() or path.is_symlink() or file_sha(path) != digest:
                raise StageError(f"Generated public file changed or is missing: {name}")
    unrelated = [row for row in existing_rows if row.get("id") not in owned_ids]
    unrelated_unpublished = [row for row in existing_unpublished if row.get("id") not in owned_ids]
    unrelated_ids = {row.get("id") for row in unrelated + unrelated_unpublished}
    incoming = catalog["datasets"]
    if unrelated_ids.intersection(row["id"] for row in incoming):
        raise StageError("Incoming dataset identifiers conflict with unrelated app catalog entries.")
    app.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".terraviva-public-", dir=app.parent))
    try:
        if app.exists():
            shutil.copytree(app, work, dirs_exist_ok=True, symlinks=True)
        for name in owned_files:
            (work / name).unlink()
        public_entries, unpublished, new_files = [], [], {}
        for row in incoming:
            entry = {key: row[key] for key in ("id", "name", "format", "rows", "columnCount", "source", "status", "bytes", "role", "farmerAssignment")}
            if row["status"] == "available":
                name = row["id"] + ".json"
                if (work / name).exists() or (work / name).is_symlink():
                    raise StageError(f"Publishing would overwrite an unrelated public file: {name}")
                shutil.copyfile(stage / row["file"], work / name)
                entry.update(file=name, sha256=row["sha256"])
                public_entries.append(entry)
                new_files[name] = row["sha256"]
            else:
                entry.update(file=None, reason=row["reason"])
                unpublished.append(entry)
        manifest = dict(existing)
        manifest.update(version=1, status="ready" if public_entries or unrelated else "requires-split",
                        buildId=catalog["buildId"], source=catalog["origin"],
                        datasets=unrelated + public_entries, unpublishedDatasets=unrelated_unpublished + unpublished,
                        generatedBy=GENERATOR, dataRole="reference; no farmer assignment or consent inferred")
        write_json(work / "manifest.json", manifest)
        write_json(work / APP_MARKER, {"generator": GENERATOR, "version": VERSION, "buildId": catalog["buildId"],
                                     "files": new_files, "entryHashes": {row["id"]: sha(canonical(row).encode()) for row in public_entries + unpublished}})
        return work
    except BaseException:
        shutil.rmtree(work, ignore_errors=True)
        raise


def overlaps(a: Path, b: Path) -> bool:
    return a == b or a in b.parents or b in a.parents


def commit_directories(pairs: list[tuple[Path, Path]]) -> None:
    committed: list[tuple[Path, Path | None]] = []
    try:
        for prepared, destination in pairs:
            backup = None
            if destination.exists():
                backup = Path(tempfile.mkdtemp(prefix=".terraviva-backup-", dir=destination.parent))
                backup.rmdir()
                os.replace(destination, backup)
            try:
                os.replace(prepared, destination)
            except BaseException:
                if backup:
                    os.replace(backup, destination)
                raise
            committed.append((destination, backup))
    except BaseException:
        for destination, backup in reversed(committed):
            shutil.rmtree(destination)
            if backup:
                os.replace(backup, destination)
        raise
    for _, backup in committed:
        if backup:
            shutil.rmtree(backup)


def build(args: argparse.Namespace) -> dict:
    limits = Limits(expanded=args.max_expanded_mib * MIB, member=args.max_member_mib * MIB,
                    rows=args.max_rows, columns=args.max_columns, cells=args.max_cells)
    if args.init_empty and (args.input or args.publish_app or args.output_dir is None):
        raise StageError("--init-empty requires an explicit --output-dir and cannot be combined with --input or --publish-app.")
    if not args.init_empty and not args.input:
        raise StageError("--input is required. The Windows Downloads path is not automatically accessible here.")
    output_unresolved = Path(args.output_dir) if args.output_dir else ROOT / "data" / "staged"
    app_unresolved = Path(args.app_dir) if args.app_dir else ROOT / "public" / "datasets"
    if output_unresolved.is_symlink() or app_unresolved.is_symlink():
        raise StageError("Output destinations must not be symlinks.")
    output, app = output_unresolved.resolve(), app_unresolved.resolve()
    input_path = Path(args.input).expanduser().resolve() if args.input else None
    if input_path and overlaps(input_path, output):
        raise StageError("Input and output paths must be separate; do not stage into or over the input tree.")
    if args.publish_app and (overlaps(output, app) or input_path and overlaps(input_path, app)):
        raise StageError("Public, staging, and input paths must be separate.")
    validate_output(output, args.replace)
    output.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".terraviva-stage-", dir=output.parent))
    app_work = None
    database = work / "base.sqlite3"
    schema = (ROOT / "data" / "schema.sql").read_text(encoding="utf-8")
    connection = None
    try:
        (work / "views").mkdir()
        connection = sqlite3.connect(database)
        connection.execute("PRAGMA page_size = 4096")
        connection.execute("PRAGMA journal_mode = DELETE")
        connection.execute("SELECT json_valid('{}')").fetchone()
        connection.executescript(schema)
        entries, files, skipped = [], [], []
        origin = {"kind": "schema-only", "name": "explicit temporary schema validation"}
        if not args.init_empty:
            with sources(input_path, limits) as (origin, specs, skipped):
                if not specs:
                    raise StageError("Input contains no supported CSV, TSV, or JSON data files.")
                for source in specs:
                    raw = source.read()
                    source_hash = sha(raw)
                    source_id = "src-" + sha((source.path + "\0" + source_hash).encode())[:24]
                    text, encoding = decode(raw, source.path)
                    connection.execute("INSERT INTO source_files VALUES (?,?,?,?,?,?,?)",
                                       (source_id, source.path, MEDIA_TYPES[source.format], len(raw), source_hash, encoding, sqlite3.Binary(raw)))
                    if source.format == "json":
                        tables = json_tables(load_exact_json(text, limits), limits)
                    else:
                        tables = [csv_table(text, source.format, args.delimiter, limits)]
                    for table in tables:
                        entries.append(stage_table(connection, work, source, source_id, source_hash, table, limits))
                    files.append({"id": source_id, "file": source.path, "sha256": source_hash, "bytes": len(raw), "encoding": encoding, "tables": len(tables)})
        parser_settings = {"delimiter": args.delimiter, "limits": vars(limits), "appViewLimitBytes": VIEW_LIMIT,
                           "browserLimits": {"rows": 100_000, "columns": 250, "cells": 2_000_000}}
        generator_sha = file_sha(Path(__file__).resolve())
        fingerprint = {"schemaSha256": sha(schema.encode()), "generatorSha256": generator_sha,
                       "origin": origin, "sourceFiles": files, "skippedFiles": skipped,
                       "parserSettings": parser_settings, "version": VERSION}
        build_id = "build-" + sha(canonical(fingerprint).encode())[:24]
        metadata = {"generator": GENERATOR, "version": VERSION, "buildId": build_id, "origin": origin,
                    "status": "schema-only-empty" if args.init_empty else "staged",
                    "role": "immutable build snapshot; not a live Vercel database",
                    "farmerAssignment": None, "consentGranted": False,
                    "sourceAuthority": "source_files.source_bytes + sha256",
                    "numericPolicy": "JSON number lexemes retained exactly; SQL numeric extraction may coerce precision.",
                    "limits": vars(limits), "parserSettings": parser_settings, "generatorSha256": generator_sha,
                    "schemaSha256": fingerprint["schemaSha256"]}
        for key, value in sorted(metadata.items()):
            connection.execute("INSERT INTO build_metadata VALUES (?,?)", (key, canonical(value)))
        if connection.execute("PRAGMA foreign_key_check").fetchall():
            raise StageError("Generated SQLite foreign-key verification failed.")
        connection.commit()
        connection.execute("VACUUM")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise StageError("Generated SQLite integrity verification failed.")
        connection.close()
        connection = None
        catalog = {"version": VERSION, "generator": GENERATOR, "buildId": build_id, "status": metadata["status"],
                   "origin": origin, "database": {"file": "base.sqlite3", "sha256": file_sha(database), "bytes": database.stat().st_size,
                   "role": "offline build snapshot; existing private Redis state is separate"},
                   "sourceFiles": files, "datasets": entries, "skippedFiles": skipped,
                   "totals": {"files": len(files), "datasets": len(entries), "rows": sum(row["rows"] for row in entries)},
                   "viewLimitBytes": VIEW_LIMIT, "sampling": False,
                   "policies": ["Original file bytes preserved in SQLite.", "No currency, unit, farmer, or consent is inferred.",
                                "Only complete dataset views at or below 1 MiB are available to publish.",
                                "Private depot storage is not modified."]}
        write_json(work / "catalog.json", catalog)
        write_json(work / STAGE_MARKER, {"generator": GENERATOR, "version": VERSION, "buildId": build_id, "files": generated_files(work)})
        if args.publish_app:
            app_work = prepare_app(app, work, catalog, args.replace)
        commit_directories([(work, output)] + ([(app_work, app)] if app_work else []))
        return {"output": str(output), "database": str(output / "base.sqlite3"), "buildId": build_id,
                "status": metadata["status"], **catalog["totals"],
                "requiresSplit": sum(row["status"] == "requires-split" for row in entries),
                "publishedApp": str(app) if args.publish_app else None}
    except (sqlite3.Error, zipfile.BadZipFile, RuntimeError, csv.Error, OSError) as exc:
        raise StageError(str(exc)) from exc
    finally:
        if connection:
            connection.close()
        if work.exists():
            shutil.rmtree(work, ignore_errors=True)
        if app_work and app_work.exists():
            shutil.rmtree(app_work, ignore_errors=True)


def positive(value: str) -> int:
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    result.add_argument("--input", help="Explicit ZIP archive, source directory, CSV, TSV, or JSON file")
    result.add_argument("--output-dir", help="New/owned output directory; default: data/staged relative to this repository")
    result.add_argument("--replace", action="store_true", help="Replace verified generated output; unrelated/edited files are protected")
    result.add_argument("--publish-app", action="store_true", help="Deliberately copy complete reference-data views into public/datasets")
    result.add_argument("--app-dir", help="Explicit app dataset destination for an isolated build; default: public/datasets")
    result.add_argument("--init-empty", action="store_true", help="Validate the schema in an explicit temporary output directory; never publish")
    result.add_argument("--delimiter", choices=("comma", "semicolon", "tab"), help="Explicit delimiter for CSV/TSV files; otherwise detect per file")
    result.add_argument("--max-expanded-mib", type=positive, default=200, help="Maximum total supported expanded source data, default 200 MiB")
    result.add_argument("--max-member-mib", type=positive, default=50, help="Maximum expanded member/source file, default 50 MiB")
    result.add_argument("--max-rows", type=positive, default=100_000, help="Maximum rows per dataset; never truncate")
    result.add_argument("--max-columns", type=positive, default=500, help="Maximum flattened columns per dataset")
    result.add_argument("--max-cells", type=positive, default=2_000_000, help="Maximum profiling grid cells per dataset")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    args.delimiter = {"comma": ",", "semicolon": ";", "tab": "\t", None: None}[args.delimiter]
    try:
        summary = build(args)
    except StageError as exc:
        print(f"Stage refused: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
