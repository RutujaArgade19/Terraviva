#!/usr/bin/env python3
"""Verify every original source and every published cell and row position."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile

from reference_data import contained, csv_rows, sha256_file

_spec = importlib.util.spec_from_file_location("restore_sources", Path(__file__).resolve().parents[1] / "data" / "restore-sources.py")
_restore = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_restore)


def verify(base: Path, reference: Path):
    catalog = json.loads((base / "catalog.json").read_text(encoding="utf-8"))
    index = json.loads((reference / "index.json").read_text(encoding="utf-8"))
    if catalog != index:
        raise ValueError("Browser index and source catalog disagree")
    counts = {"sourceFiles": 0, "sourceBytes": 0, "rows": 0, "columnOccurrences": 0, "pages": 0}
    with tempfile.TemporaryDirectory(prefix="terraviva-verification-", dir="/tmp") as directory:
        root = Path(directory)
        for dataset in catalog["datasets"]:
            if dataset.get("farmerAssignment") is not None or dataset.get("consentGranted") is not False or dataset.get("role") != "reference":
                raise ValueError("Reference data has an unexpected farmer/consent assignment")
            original = _restore.restore_one(base, dataset, root)
            reader = csv_rows(original, dataset["columns"])
            next(reader)
            ordinal = 0
            for descriptor in dataset["pages"]:
                path = contained(reference, descriptor["file"])
                compressed = path.read_bytes()
                if len(compressed) != descriptor["bytes"] or hashlib.sha256(compressed).hexdigest() != descriptor["sha256"]:
                    raise ValueError("Compressed page checksum mismatch")
                if descriptor["decodedBytes"] > catalog["pageLimits"]["decodedBytes"]:
                    raise ValueError("Page exceeds the configured byte bound")
                raw = gzip.decompress(compressed)
                if len(raw) != descriptor["decodedBytes"] or hashlib.sha256(raw).hexdigest() != descriptor["decodedSha256"]:
                    raise ValueError("Decoded page checksum mismatch")
                page = json.loads(raw)
                if (page["datasetId"] != dataset["id"] or page["columns"] != dataset["columns"] or
                    page.get("role") != "reference" or page.get("farmerAssignment") is not None):
                    raise ValueError("Page provenance or columns differ from catalog")
                if (page["firstRow"] != ordinal + 1 or descriptor["firstRow"] != ordinal + 1 or
                    len(page["rows"]) != descriptor["rows"]):
                    raise ValueError("Page ordering or row count differs from catalog")
                for row in page["rows"]:
                    try:
                        expected = next(reader)
                    except StopIteration as exc:
                        raise ValueError("Published rows exceed the original source") from exc
                    if row != expected:
                        raise ValueError(f"Published cell differs from source: {dataset['source']['path']} row {ordinal+1}")
                    ordinal += 1
                if page["lastRow"] != ordinal or descriptor["lastRow"] != ordinal:
                    raise ValueError("Page last-row position is inconsistent")
                counts["pages"] += 1
            if next(reader, None) is not None or ordinal != dataset["rowCount"]:
                raise ValueError("Published pages do not cover the entire source")
            profile = dataset["profile"]
            profile_path = contained(reference, profile["file"])
            if profile_path.stat().st_size != profile["bytes"] or sha256_file(profile_path) != profile["sha256"]:
                raise ValueError("Column profile checksum mismatch")
            schema = dataset["schema"]
            schema_path = contained(base, schema["file"])
            if schema_path.stat().st_size != schema["bytes"] or sha256_file(schema_path) != schema["sha256"]:
                raise ValueError("SQL schema checksum mismatch")
            counts["sourceFiles"] += 1
            counts["sourceBytes"] += dataset["source"]["bytes"]
            counts["rows"] += ordinal
            counts["columnOccurrences"] += len(dataset["columns"])
            original.unlink()
            print(json.dumps({"verified": dataset["source"]["path"], "rows": ordinal}), flush=True)
    if counts != catalog["totals"]:
        raise ValueError("Verified collection totals differ from catalog")
    return counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--reference", type=Path, help="Browser reference directory; defaults to BASE/reference")
    args = parser.parse_args()
    try:
        result = verify(args.base, args.reference or args.base / "reference")
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(2, f"Verification failed: {exc}\n")
    print(json.dumps({"verifiedEverySourceAndPublishedCell": True, **result}, indent=2))


if __name__ == "__main__":
    main()
