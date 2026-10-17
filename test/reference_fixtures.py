"""Small labelled synthetic fixtures; never used as app base data."""
import contextlib
import csv
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


def module(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


builder = module("reference_builder", "scripts/build-reference-base.py")
verifier = module("reference_verifier", "scripts/verify-reference-build.py")
restorer = module("reference_restorer", "data/restore-sources.py")
sql_builder = module("reference_sql_builder", "scripts/build-reference-sqlite.py")


def quiet(function, *args, **kwargs):
    with contextlib.redirect_stdout(io.StringIO()):
        return function(*args, **kwargs)


def fixture(directory: Path, tables=None):
    if tables is None:
        tables = {"fixture.csv": (["id", "value", "notes"], [
            ["001", "3.1400", "a,b"], ["002", "\\N", "line one\nline two"],
            ["003", "", "  "], ["004", "0", "NA"]])}
    original = directory / "original"
    original.mkdir()
    sources = []
    for name, (columns, rows) in tables.items():
        source = original / name
        source.parent.mkdir(exist_ok=True)
        with source.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream, lineterminator="\r\n")
            writer.writerow(columns)
            writer.writerows(rows)
        raw = source.read_bytes()
        sources.append({"path": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                        "columns": columns, "rowCount": len(rows), "tableName": Path(name).stem,
                        "profile": {"rowCount": len(rows), "columns": [{"name": c} for c in columns]}})
    metadata = directory / "metadata.json"
    metadata.write_text(json.dumps({"sources": sources}), encoding="utf-8")
    base = directory / "base"
    quiet(builder.build, original, metadata, base, 2)
    return original, metadata, base


def edit_catalog(base: Path, callback):
    catalog = json.loads((base / "catalog.json").read_text())
    callback(catalog)
    text = json.dumps(catalog)
    (base / "catalog.json").write_text(text)
    (base / "reference" / "index.json").write_text(text)
    return catalog
