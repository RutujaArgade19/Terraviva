#!/usr/bin/env python3
"""Rebuild one offline SQLite database from the verified source fragments.

The database is constructed in /tmp, closed and checked before its final copy.
No SQL text from a source cell is executed. No live farmer store is modified.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import zipfile

from reference_data import NULL_TOKEN, contained, quote_identifier as qi, sha256_file, write_json

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("restore_sources", ROOT / "data" / "restore-sources.py")
_restore = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_restore)
OPERATION_COLUMNS = ["operation_type", "source_operation_id", "parcel_id", "year", "operation_date",
                     "product_type", "product_name", "active_substance", "seed_rate_kg_ha", "n_kg_ha",
                     "p2o5_kg_ha", "k2o_kg_ha", "dose_l_or_kg_ha", "yield_t_ha", "dose_unit_status",
                     "operation_cost_eur", "operation_cost_available"]

CATALOG_SCHEMA = """
CREATE TABLE build_metadata(key TEXT PRIMARY KEY, value_json TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE source_catalog(
 dataset_id TEXT PRIMARY KEY, source_path TEXT NOT NULL UNIQUE, source_sha256 TEXT NOT NULL,
 source_bytes INTEGER NOT NULL, table_name TEXT NOT NULL UNIQUE, row_count INTEGER NOT NULL,
 column_count INTEGER NOT NULL, profile_json TEXT NOT NULL, columns_json TEXT NOT NULL,
 preservation_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE source_columns(
 dataset_id TEXT NOT NULL REFERENCES source_catalog(dataset_id), ordinal INTEGER NOT NULL,
 name TEXT NOT NULL, storage_type TEXT NOT NULL, profile_json TEXT,
 PRIMARY KEY(dataset_id,ordinal), UNIQUE(dataset_id,name)
) WITHOUT ROWID;
"""


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def add_operation_views(connection, datasets):
    sources = [d for d in datasets if all(c in d["columns"] for c in OPERATION_COLUMNS)]
    if not sources:
        return {"sourceRows": 0, "deduplicatedView": "not-applicable"}
    columns = ",".join(qi(c) for c in OPERATION_COLUMNS)
    selects = [f"SELECT {literal(d['id'])} AS _dataset_id,{literal(d['source']['path'])} AS _source_path,"
               f"_row_number AS _source_row,_source_line,{columns} FROM {qi(d['schema']['tableName'])}" for d in sources]
    connection.execute("CREATE VIEW operation_core_all AS " + " UNION ALL ".join(selects))
    connection.execute(f"""CREATE TABLE operation_key_audit AS
        WITH copies AS (
          SELECT operation_type,source_operation_id,COUNT(*) AS source_rows,
                 COUNT(DISTINCT _dataset_id) AS source_files
          FROM operation_core_all GROUP BY operation_type,source_operation_id
        ), variants AS (
          SELECT operation_type,source_operation_id,COUNT(*) AS core_variants
          FROM (SELECT {columns} FROM operation_core_all GROUP BY {columns})
          GROUP BY operation_type,source_operation_id
        )
        SELECT copies.*,variants.core_variants FROM copies JOIN variants
        ON copies.operation_type IS variants.operation_type
        AND copies.source_operation_id IS variants.source_operation_id""")
    missing = connection.execute("""SELECT COUNT(*) FROM operation_core_all
        WHERE operation_type IS NULL OR source_operation_id IS NULL
        OR TRIM(operation_type)='' OR TRIM(source_operation_id)=''""").fetchone()[0]
    keys, copies, repeated, conflicts = connection.execute("""SELECT COUNT(*),COALESCE(SUM(source_rows),0),
        COALESCE(SUM(source_rows>1),0),COALESCE(SUM(core_variants>1),0) FROM operation_key_audit""").fetchone()
    available = missing == 0 and conflicts == 0
    if available:
        connection.execute(f"CREATE VIEW operation_core_deduplicated AS SELECT {columns} FROM operation_core_all GROUP BY {columns}")
    return {"declaredCandidateKey": ["operation_type", "source_operation_id"], "sharedColumns": OPERATION_COLUMNS,
            "sourceRows": copies, "candidateKeys": keys, "missingKeyRows": missing,
            "repeatedKeyGroups": repeated, "conflictingKeyGroups": conflicts,
            "deduplicatedRows": keys if available else None,
            "deduplicatedView": "available" if available else "withheld: incomplete or conflicting keys",
            "scope": "Exact source-key/core-field audit; original source copies remain in their tables."}


def build(base: Path, reference: Path, output: Path):
    if output.exists():
        raise ValueError("Output exists; choose a fresh file")
    catalog = json.loads((base / "catalog.json").read_text(encoding="utf-8"))
    if json.loads((reference / "index.json").read_text(encoding="utf-8")) != catalog:
        raise ValueError("Source catalog and browser index differ")
    total_rows = 0
    with tempfile.TemporaryDirectory(prefix="terraviva-sqlite-", dir="/tmp") as directory:
        work = Path(directory)
        database = work / "base.sqlite3"
        connection = sqlite3.connect(database)
        try:
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA journal_mode=DELETE")
            connection.execute("PRAGMA temp_store=FILE")
            connection.executescript(CATALOG_SCHEMA)
            for dataset in catalog["datasets"]:
                source = _restore.restore_one(base, dataset, work / "sources")
                columns, table = dataset["columns"], dataset["schema"]["tableName"]
                if any(c in {"_row_number", "_source_line"} for c in columns):
                    raise ValueError("Source uses a reserved provenance column")
                connection.execute(f"CREATE TABLE {qi(table)} (\"_row_number\" INTEGER PRIMARY KEY,"
                                   '"_source_line" INTEGER NOT NULL,' + ",".join(qi(c)+" TEXT" for c in columns) + ")")
                profile_path = contained(reference, dataset["profile"]["file"])
                if profile_path.stat().st_size != dataset["profile"]["bytes"] or sha256_file(profile_path) != dataset["profile"]["sha256"]:
                    raise ValueError("Source profile failed its checksum")
                profile = json.loads(profile_path.read_text(encoding="utf-8"))
                connection.execute("INSERT INTO source_catalog VALUES (?,?,?,?,?,?,?,?,?,?)", (
                    dataset["id"], dataset["source"]["path"], dataset["source"]["sha256"], dataset["source"]["bytes"], table,
                    dataset["rowCount"], len(columns), json.dumps(profile, ensure_ascii=False),
                    json.dumps(columns), json.dumps(dataset["sourceStorage"])))
                column_profiles = {item["name"]: item for item in profile.get("columns", [])}
                connection.executemany("INSERT INTO source_columns VALUES (?,?,?,?,?)", [
                    (dataset["id"], index, col, "TEXT", json.dumps(column_profiles.get(col), ensure_ascii=False))
                    for index, col in enumerate(columns, 1)])
                insert = "INSERT INTO " + qi(table) + " VALUES (" + ",".join("?" for _ in range(len(columns)+2)) + ")"
                row_count = 0
                with source.open("r", encoding="utf-8-sig", newline="") as stream:
                    reader = csv.reader(stream, strict=True)
                    if next(reader) != columns:
                        raise ValueError("Source header differs from catalog")
                    batch = []
                    for row_count, row in enumerate(reader, 1):
                        if len(row) != len(columns):
                            raise ValueError("Source contains a ragged CSV record")
                        batch.append((row_count, reader.line_num, *[None if c == NULL_TOKEN else c for c in row]))
                        if len(batch) >= 1000:
                            connection.executemany(insert, batch)
                            batch.clear()
                    if batch:
                        connection.executemany(insert, batch)
                if row_count != dataset["rowCount"]:
                    raise ValueError("Stored row count differs from catalog")
                total_rows += row_count
                source.unlink()
                print(json.dumps({"stored": dataset["source"]["path"], "rows": row_count}), flush=True)
            if total_rows != catalog["totals"]["rows"]:
                raise ValueError("Stored collection row count differs from catalog")
            audit = add_operation_views(connection, catalog["datasets"])
            metadata = {"generator": "terraviva-reference-sqlite/2", "sourceCatalogSha256": sha256_file(base/"catalog.json"),
                        "scope": catalog["scope"], "totals": catalog["totals"], "operationAudit": audit,
                        "role": "reference", "farmerAssignment": None, "consentGranted": False,
                        "nullPolicy": catalog["nullPolicy"], "numericPolicy": catalog["numericPolicy"]}
            connection.executemany("INSERT INTO build_metadata VALUES (?,?)", [(key, json.dumps(value, ensure_ascii=False)) for key,value in metadata.items()])
            if connection.execute("PRAGMA foreign_key_check").fetchall():
                raise ValueError("Generated database foreign keys failed")
            connection.commit()
            if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Generated SQLite integrity check failed")
        finally:
            connection.close()
        if any(Path(str(database)+suffix).exists() for suffix in ("-journal", "-wal", "-shm")):
            raise ValueError("Closed database still has a sidecar journal")
        with database.open("rb") as stream:
            os.fsync(stream.fileno())
        checksum = sha256_file(database)
        check = sqlite3.connect(database.as_uri()+"?mode=ro&immutable=1", uri=True)
        try:
            if check.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("Closed SQLite copy failed verification")
        finally:
            check.close()
        output.parent.mkdir(parents=True, exist_ok=True)
        # Exclusive final creation prevents replacement of unrelated output.
        with database.open("rb") as src, output.open("xb") as dst:
            shutil.copyfileobj(src, dst, 1024*1024)
            dst.flush()
            os.fsync(dst.fileno())
        if sha256_file(output) != checksum:
            raise ValueError("Final SQLite copy differs from the verified database")
        return {"file": str(output), "bytes": output.stat().st_size, "sha256": checksum,
                "sourceFiles": len(catalog["datasets"]), "sourceRows": total_rows, "operationAudit": audit}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", "--staging-dir", dest="base", type=Path, default=ROOT / "data" / "reference-base")
    parser.add_argument("--reference", type=Path, help="Defaults to BASE/reference when present, otherwise public/reference")
    destination = parser.add_mutually_exclusive_group(required=True)
    destination.add_argument("--output", type=Path)
    destination.add_argument("--output-dir", type=Path, help="Create a fresh delivery directory with SQLite, README and checksums")
    parser.add_argument("--zip", action="store_true", help="With --output-dir, also create a complete ZIP delivery")
    args = parser.parse_args()
    reference = args.reference or (args.base / "reference" if (args.base / "reference").is_dir() else ROOT / "public" / "reference")
    try:
        if args.zip and not args.output_dir:
            raise ValueError("--zip requires --output-dir")
        if args.output_dir:
            args.output_dir.mkdir(parents=True, exist_ok=False)
        output = args.output or args.output_dir / "terraviva-reference.sqlite3"
        result = build(args.base, reference, output)
        if args.output_dir:
            write_json(args.output_dir / "delivery.json", result)
            (args.output_dir / "CHECKSUMS.sha256").write_text(result["sha256"] + "  terraviva-reference.sqlite3\n", encoding="utf-8")
            (args.output_dir / "README.md").write_text(
                "# Terraviva offline reference database\n\n"
                "Open terraviva-reference.sqlite3 in a SQLite client. This is an immutable reference snapshot.\n"
                "No farmer assignment, commercial consent or access grant is implied. Original archive coverage remains unknown.\n\n"
                "All source rows and lexical TEXT cells are retained in separate source tables; only literal \\N becomes NULL.\n"
                "The _row_number and _source_line columns preserve logical row and physical CSV end-line positions.\n"
                "source_catalog and source_columns contain original source checksums and full measured profiles.\n"
                "operation_core_all retains every operation source copy. operation_key_audit checks exact shared-field variants.\n"
                "operation_core_deduplicated is present only if every key is complete and no conflicting variant exists.\n\n"
                "Original CSV bytes are distributed in the repository's data/reference-base gzip fragments.\n"
                "To rebuild: python3 scripts/build-reference-sqlite.py --output /tmp/terraviva-reference.sqlite3\n"
                "SQLite byte layout may vary by runtime; source checksums and row-level comparison establish data fidelity.\n",
                encoding="utf-8")
            if args.zip:
                archive_path = args.output_dir / "terraviva-reference-sqlite.zip"
                with zipfile.ZipFile(archive_path, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                    for name in ("terraviva-reference.sqlite3", "README.md", "delivery.json", "CHECKSUMS.sha256"):
                        archive.write(args.output_dir / name, name)
                result["zip"] = {"file": str(archive_path), "bytes": archive_path.stat().st_size, "sha256": sha256_file(archive_path)}
    except (ValueError, OSError, sqlite3.Error, KeyError) as exc:
        parser.exit(2, f"SQLite build refused: {exc}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
