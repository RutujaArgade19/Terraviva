#!/usr/bin/env python3
"""Recover exact source CSVs from a verified Terraviva SQLite snapshot.

Every recovered file must match its recorded original byte count AND SHA-256.
Serialization candidates are never accepted merely because their parsed cells
match. The input database is opened read-only and is never modified.
"""
from __future__ import annotations
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile

from reference_data import NULL_TOKEN, contained, quote_identifier, sha256_file, write_json


def published_name(table: str):
    return re.sub(r"_\d{4}_part_\d+$", "", table)


def recover(database: Path, output: Path, metadata_output: Path, expected_database_sha256=None):
    if output.exists() or metadata_output.exists():
        raise ValueError("Output already exists; choose fresh paths")
    checksum = sha256_file(database)
    if expected_database_sha256 and checksum != expected_database_sha256:
        raise ValueError("Input SQLite checksum differs from the expected snapshot")
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise ValueError("Input SQLite integrity check failed")
    catalog = [dict(row) for row in connection.execute("SELECT * FROM source_catalog ORDER BY source_path")]
    table_lineage = {row["published_table"]: dict(row) for row in connection.execute("SELECT * FROM combined_table_provenance")}
    column_lineage = {(row["published_table"], row["published_column"]): dict(row)
                      for row in connection.execute("SELECT * FROM combined_column_provenance")}
    quality = [{key: row[key] for key in ("issue", "status", "treatment")}
               for row in connection.execute("SELECT * FROM combined_quality_issues")]
    output.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".terraviva-csv-recovery-", dir=output.parent))
    sources = []
    try:
        for source in catalog:
            columns = json.loads(source["columns_json"])
            sql_columns = [row["name"] for row in connection.execute("SELECT name FROM source_columns WHERE dataset_id=? ORDER BY ordinal", (source["dataset_id"],))]
            if columns != sql_columns or len(columns) != source["column_count"]:
                raise ValueError("Source column order differs between metadata tables")
            destination = contained(work, source["source_path"])
            destination.parent.mkdir(parents=True, exist_ok=True)
            sql = ("SELECT " + ",".join(quote_identifier(col) for col in columns) + " FROM " +
                   quote_identifier(source["table_name"]) + ' ORDER BY "_row_number"')
            match = None
            for line_ending in ("\n", "\r\n"):
                for quoting in (csv.QUOTE_MINIMAL, csv.QUOTE_ALL):
                    for bom in (False, True):
                        row_count = 0
                        with destination.open("w", encoding="utf-8-sig" if bom else "utf-8", newline="") as stream:
                            writer = csv.writer(stream, lineterminator=line_ending, quoting=quoting)
                            writer.writerow(columns)
                            for row_count, row in enumerate(connection.execute(sql), 1):
                                if any(value is not None and not isinstance(value, str) for value in row):
                                    raise ValueError("Source cell lost its lexical TEXT representation")
                                writer.writerow([NULL_TOKEN if value is None else value for value in row])
                        if row_count != source["row_count"]:
                            raise ValueError("Source row count differs from SQLite catalog")
                        if destination.stat().st_size == source["source_bytes"] and sha256_file(destination) == source["source_sha256"]:
                            match = {"lineEnding": "LF" if line_ending == "\n" else "CRLF",
                                     "quoting": "minimal" if quoting == csv.QUOTE_MINIMAL else "all", "utf8Bom": bom}
                            break
                    if match:
                        break
                if match:
                    break
            if not match:
                raise ValueError(f"Could not reproduce exact original CSV bytes: {source['source_path']}")
            original_profile = json.loads(source["profile_json"])
            profile = original_profile["table"]
            table = published_name(source["table_name"])
            lineage = table_lineage.get(table, {})
            for column in profile["columns"]:
                origin = column_lineage.get((table, column["name"]))
                if origin:
                    column["unit"] = origin["unit_or_coding"]
                    column["description"] = (f"{origin['source_table']}: {origin['source_column_or_rule']}. "
                                             f"Value origin: {origin['value_origin']}. Reference period: {origin['reference_period']}.")
                    column["lineage"] = {key: origin[key] for key in ("source_table", "source_column_or_rule", "value_origin", "reference_period", "unit_or_coding")}
            # A single pooled magnitude has no meaning across tonnes and 1000 pieces.
            if source["table_name"] == "combined_animal_product_ready":
                for column in profile["columns"]:
                    if column["name"] in ("quantity", "quantity_per_static_head"):
                        column["numeric"] = None
                        column["numericSuppressionReason"] = "Mixed units: MILK tonnes and EGGS 1000 pieces. Summarize each product/unit separately."
            profile["source"] = {"path": source["source_path"], "bytes": source["source_bytes"], "sha256": source["source_sha256"]}
            profile["method"] = original_profile["method"]
            profile["additionalChecks"] = {key: value for key, value in original_profile.items() if key not in ("schemaVersion", "source", "method", "table", "elapsedSeconds")}
            metadata = {"id": source["dataset_id"], "path": source["source_path"], "sha256": source["source_sha256"],
                        "bytes": source["source_bytes"], "rowCount": source["row_count"], "columns": columns,
                        "tableName": source["table_name"], "title": source["table_name"].removeprefix("combined_"),
                        "grain": lineage.get("grain_keys") or "One original CSV row; no publisher grain declared",
                        "lineage": {key: lineage[key] for key in ("object_type", "source_dataset", "source_version", "transformation_rule") if key in lineage},
                        "warnings": [], "profile": profile, "csvSerialization": match,
                        "originalBytesVerified": True}
            sources.append(metadata)
            print(json.dumps({"recoveredExactOriginal": source["source_path"], "bytes": source["source_bytes"],
                              "rows": source["row_count"], "serialization": match}), flush=True)
        meta = {"version": 1, "sourceCollection": "dg-agri-hackathon-datasets",
                "originalArchiveCoverage": "unknown", "recoveredFromDatabaseSha256": checksum,
                "recoveryRule": "Every CSV matches its previously recorded original byte count and SHA-256.",
                "qualityIssues": quality, "sources": sources}
        write_json(metadata_output, meta)
        os.replace(work, output)
        return {"sourceFiles": len(sources), "sourceBytes": sum(s["bytes"] for s in sources),
                "rows": sum(s["rowCount"] for s in sources)}
    finally:
        connection.close()
        if work.exists():
            shutil.rmtree(work)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", required=True, type=Path)
    parser.add_argument("--expected-database-sha256")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--metadata-output", required=True, type=Path)
    args = parser.parse_args()
    try:
        result = recover(args.database, args.output_dir, args.metadata_output, args.expected_database_sha256)
    except (ValueError, OSError, sqlite3.Error) as exc:
        parser.exit(2, f"CSV recovery refused: {exc}\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
