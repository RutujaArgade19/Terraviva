#!/usr/bin/env python3
"""Build complete, checksummed reference pages and lossless source fragments.

The checked-in source metadata fixes the input collection and source hashes.
All CSV lexical values survive unchanged; only literal \\N maps to JSON null.
No records are assigned to a farmer and no consent or access grants are created.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from reference_data import (MIB, contained, csv_rows, json_bytes, quote_identifier,
                            sha256_file, source_id, write_json)


class FragmentWriter:
    def __init__(self, directory: Path, limit: int = 4 * MIB):
        self.directory, self.limit = directory, limit
        self.pending = bytearray()
        self.parts = []
        self.digest = hashlib.sha256()
        self.byte_count = 0

    def write(self, data):
        self.digest.update(data)
        self.byte_count += len(data)
        self.pending.extend(data)
        while len(self.pending) >= self.limit:
            self._emit(bytes(self.pending[:self.limit]))
            del self.pending[:self.limit]
        return len(data)

    def _emit(self, data: bytes):
        name = f"source.csv.gz.part{len(self.parts) + 1:04d}"
        with (self.directory / name).open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        self.parts.append({"file": name, "bytes": len(data),
                           "sha256": hashlib.sha256(data).hexdigest()})

    def finish(self):
        if self.pending:
            self._emit(bytes(self.pending))
            self.pending.clear()


def preserve_source(path: Path, destination: Path, source: dict):
    destination.mkdir(parents=True)
    writer = FragmentWriter(destination)
    digest, count = hashlib.sha256(), 0
    with gzip.GzipFile(filename="", mode="wb", fileobj=writer, compresslevel=6, mtime=0) as compressed:
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(MIB), b""):
                digest.update(block)
                count += len(block)
                compressed.write(block)
    writer.finish()
    if count != source["bytes"] or digest.hexdigest() != source["sha256"]:
        raise ValueError(f"Source bytes changed or checksum differs: {source['path']}")
    manifest = {"version": 1, "source": {key: source[key] for key in ("path", "bytes", "sha256")},
                "compression": "gzip", "compressionMtime": 0,
                "compressedBytes": writer.byte_count, "compressedSha256": writer.digest.hexdigest(),
                "fragmentLimitBytes": 4 * MIB, "parts": writer.parts}
    descriptor = write_json(destination / "manifest.json", manifest)
    return manifest, descriptor


def build_pages(path: Path, destination: Path, dataset: dict, page_rows: int, page_max_bytes: int):
    destination.mkdir(parents=True)
    columns = dataset["columns"]
    rows, encoded, first, ordinal, pages = [], 0, 1, 0, []
    # The final exact encoded-size check below remains authoritative.
    overhead = len(json_bytes({"datasetId": dataset["id"], "columns": columns,
                              "rows": [], "firstRow": 999999999999,
                              "lastRow": 999999999999, "role": "reference",
                              "farmerAssignment": None}))

    def flush():
        nonlocal rows, encoded, first
        if not rows:
            return
        page = {"datasetId": dataset["id"], "columns": columns, "rows": rows,
                "firstRow": first, "lastRow": first + len(rows) - 1,
                "role": "reference", "farmerAssignment": None}
        raw = json_bytes(page)
        if len(raw) > page_max_bytes:
            raise ValueError("A source row exceeds the complete page byte limit")
        compressed = gzip.compress(raw, compresslevel=6, mtime=0)
        filename = f"page-{len(pages) + 1:06d}.json.gz"
        with (destination / filename).open("xb") as stream:
            stream.write(compressed)
        pages.append({"file": f"{dataset['id']}/{filename}", "firstRow": first,
                      "lastRow": page["lastRow"], "rows": len(rows),
                      "bytes": len(compressed), "decodedBytes": len(raw),
                      "sha256": hashlib.sha256(compressed).hexdigest(),
                      "decodedSha256": hashlib.sha256(raw).hexdigest()})
        first += len(rows)
        rows, encoded = [], 0

    reader = csv_rows(path, columns)
    next(reader)
    for ordinal, row in enumerate(reader, 1):
        length = len(json_bytes(row))  # its newline is the same size as the page comma
        if rows and (len(rows) >= page_rows or overhead + encoded + length > page_max_bytes):
            flush()
        rows.append(row)
        encoded += length
    flush()
    if ordinal != dataset["rowCount"]:
        raise ValueError(f"CSV row count differs from metadata: {path}")
    return pages


def build(input_root: Path, metadata_path: Path, output: Path, page_rows=20000, page_max_bytes=20*MIB):
    if page_rows < 1 or page_max_bytes < 1024:
        raise ValueError("Page limits must be positive and at least 1 KiB")
    if output.exists():
        raise ValueError("Output already exists; select a fresh output directory")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    sources = metadata["sources"]
    if not sources:
        raise ValueError("The source manifest is empty")
    if len({entry["path"] for entry in sources}) != len(sources):
        raise ValueError("The source manifest repeats a path")
    input_root = input_root.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output_resolved = output.resolve()
    if output_resolved == input_root or input_root in output_resolved.parents or output_resolved in input_root.parents:
        raise ValueError("Input and output must not overlap")
    work = Path(tempfile.mkdtemp(prefix=".terraviva-reference-", dir=output.parent))
    try:
        datasets = []
        for source in sorted(sources, key=lambda value: value["path"]):
            path = contained(input_root, source["path"])
            if not path.is_file():
                raise ValueError(f"Missing source: {source['path']}")
            dataset_id = source_id(source["path"], source["sha256"])
            columns = source["columns"]
            if not columns or len(columns) != len(set(columns)):
                raise ValueError("Source columns must be unique and nonempty")
            dataset = {"id": dataset_id, "title": source.get("title", Path(source["path"]).stem),
                       "source": {key: source[key] for key in ("path", "bytes", "sha256")},
                       "rowCount": source["rowCount"], "columns": columns,
                       "grain": source.get("grain", "One original CSV row; see source metadata"),
                       "role": "reference", "farmerAssignment": None,
                       "consentGranted": False, "warnings": source.get("warnings", [])}
            storage, storage_descriptor = preserve_source(path, work / "sources" / dataset_id, source)
            dataset["sourceStorage"] = {"file": f"sources/{dataset_id}/manifest.json", **storage_descriptor,
                                        "compressedBytes": storage["compressedBytes"], "parts": len(storage["parts"])}
            dataset["pages"] = build_pages(path, work / "reference" / dataset_id, dataset, page_rows, page_max_bytes)
            profile = source.get("profile", {"rows": source["rowCount"], "columns": [{"name": col} for col in columns]})
            profile_descriptor = write_json(work / "reference" / dataset_id / "profile.json", profile)
            dataset["profile"] = {"file": f"{dataset_id}/profile.json", **profile_descriptor}
            table_name = source.get("tableName", Path(source["path"]).stem)
            schema = ("-- Reference source only. All cells are source text except literal \\N, represented as NULL.\n"
                      f"CREATE TABLE {quote_identifier(table_name)} (\n"
                      '  "_row_number" INTEGER PRIMARY KEY,\n  "_source_line" INTEGER NOT NULL,\n  ' +
                      ",\n  ".join(quote_identifier(col) + " TEXT" for col in columns) + "\n);\n")
            schema_path = work / "schemas" / (dataset_id + ".sql")
            schema_path.parent.mkdir(exist_ok=True)
            schema_path.write_text(schema, encoding="utf-8")
            dataset["schema"] = {"file": f"schemas/{dataset_id}.sql", "tableName": table_name,
                                 "bytes": schema_path.stat().st_size, "sha256": sha256_file(schema_path)}
            datasets.append(dataset)
            print(json.dumps({"source": source["path"], "rows": dataset["rowCount"],
                              "pages": len(dataset["pages"])}), flush=True)
        totals = {"sourceFiles": len(datasets), "sourceBytes": sum(d["source"]["bytes"] for d in datasets),
                  "rows": sum(d["rowCount"] for d in datasets),
                  "columnOccurrences": sum(len(d["columns"]) for d in datasets),
                  "pages": sum(len(d["pages"]) for d in datasets)}
        catalog = {"kind": "terraviva-reference-catalog", "schemaVersion": 1,
                   "version": 1, "generator": "terraviva.reference-base", "status": "ready",
                   "scope": {"kind": "retrieved-source-collection", "completeForRetrievedFiles": True,
                             "originalArchiveCoverage": "unknown", "originalArchiveComplete": False},
                   "sourceCollection": metadata.get("sourceCollection", "dg-agri-hackathon-datasets"),
                   "role": "reference", "farmerAssignment": None, "consentGranted": False,
                   "nullPolicy": "Only the literal CSV token \\N becomes null. Empty strings, whitespace, zero and NA remain source text.",
                   "numericPolicy": "Every non-null source cell stays lexical text, including identifiers and decimal formatting.",
                   "totals": totals, "sampling": False, "pageLimits": {"rows": page_rows, "decodedBytes": page_max_bytes},
                   "datasets": datasets}
        write_json(work / "catalog.json", catalog)
        write_json(work / "reference" / "index.json", catalog)
        os.replace(work, output)
        return totals
    finally:
        if work.exists():
            shutil.rmtree(work)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Directory containing the exact original source CSV files")
    parser.add_argument("--metadata", type=Path, default=Path(__file__).resolve().parents[1] / "data" / "source-metadata.json")
    parser.add_argument("--output-dir", required=True, type=Path, help="Fresh output directory; existing output is never replaced")
    parser.add_argument("--page-rows", type=int, default=20000)
    parser.add_argument("--page-max-bytes", type=int, default=20*MIB)
    parser.add_argument("--sqlite", action="store_true", help="Also rebuild a complete offline SQLite file under OUTPUT/sqlite")
    args = parser.parse_args()
    try:
        totals = build(args.input, args.metadata, args.output_dir, args.page_rows, args.page_max_bytes)
        if args.sqlite:
            import importlib.util
            spec = importlib.util.spec_from_file_location("reference_sqlite", Path(__file__).with_name("build-reference-sqlite.py"))
            sqlite_builder = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(sqlite_builder)
            sqlite_builder.build(args.output_dir, args.output_dir / "reference", args.output_dir / "sqlite" / "terraviva-reference.sqlite3")
    except (ValueError, OSError, KeyError) as exc:
        parser.exit(2, f"Reference build refused: {exc}\n")
    print(json.dumps({"output": str(args.output_dir), **totals}, indent=2))


if __name__ == "__main__":
    main()
