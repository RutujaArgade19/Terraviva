"""Shared, standard-library-only helpers for Terraviva reference snapshots."""
from __future__ import annotations

import csv
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re

MIB = 1024 * 1024
NULL_TOKEN = "\\N"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(MIB), b""):
            digest.update(block)
    return digest.hexdigest()


def json_bytes(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, allow_nan=False,
                       separators=(",", ":")) + "\n").encode("utf-8")


def write_json(path: Path, value) -> dict:
    raw = json_bytes(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}


def safe_relative(value: str) -> Path:
    if (not isinstance(value, str) or not value or "\\" in value or
            "\x00" in value or ":" in value):
        raise ValueError(f"Unsafe relative path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in value.split("/")):
        raise ValueError(f"Unsafe relative path: {value!r}")
    return Path(*path.parts)


def contained(root: Path, relative: str) -> Path:
    candidate = root / safe_relative(relative)
    resolved_root = root.resolve()
    if resolved_root not in candidate.resolve().parents:
        raise ValueError("Path escapes its data root")
    for parent in [candidate, *candidate.parents]:
        if parent == root.parent:
            break
        if parent.is_symlink():
            raise ValueError(f"Symlink is not accepted: {parent}")
    return candidate


def quote_identifier(value: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("Invalid SQL identifier")
    return '"' + value.replace('"', '""') + '"'


def source_id(path: str, checksum: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{64}", checksum):
        raise ValueError("Invalid source SHA-256")
    return "ds-" + hashlib.sha256((path + "\0" + checksum).encode()).hexdigest()[:24]


def csv_rows(path: Path, expected_columns: list[str] | None = None):
    """Yield ordered lexical cells; only the documented literal \\N means NULL."""
    csv.field_size_limit(100 * MIB)
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        reader = csv.reader(stream, strict=True)
        try:
            columns = next(reader)
        except StopIteration as exc:
            raise ValueError(f"Missing CSV header: {path}") from exc
        if not columns or len(set(columns)) != len(columns) or any(not name for name in columns):
            raise ValueError(f"Invalid or duplicate CSV columns: {path}")
        if expected_columns is not None and columns != expected_columns:
            raise ValueError(f"CSV column order differs from metadata: {path}")
        yield columns
        for ordinal, row in enumerate(reader, 1):
            if len(row) != len(columns):
                raise ValueError(f"Ragged CSV row {ordinal}: {path}")
            yield [None if cell == NULL_TOKEN else cell for cell in row]
