#!/usr/bin/env python3
"""Restore every original CSV from the checked-in, checksummed gzip fragments."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from reference_data import MIB, contained, sha256_file


def restore_one(base: Path, dataset: dict, destination: Path):
    storage = dataset["sourceStorage"]
    manifest_path = contained(base, storage["file"])
    if manifest_path.stat().st_size != storage["bytes"] or sha256_file(manifest_path) != storage["sha256"]:
        raise ValueError("Source-fragment manifest differs from catalog")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["source"] != dataset["source"] or manifest["compression"] != "gzip":
        raise ValueError("Source-fragment manifest identifies a different source")
    expected = dataset["source"]
    source_path = contained(destination, expected["path"])
    source_path.parent.mkdir(parents=True, exist_ok=True)
    compressed_hash, compressed_bytes = hashlib.sha256(), 0
    if not manifest["parts"] or len({part["file"] for part in manifest["parts"]}) != len(manifest["parts"]):
        raise ValueError("Fragment inventory is empty or repeats a file")
    with tempfile.TemporaryFile() as compressed:
        for ordinal, part in enumerate(manifest["parts"], 1):
            if part["file"] != f"source.csv.gz.part{ordinal:04d}" or part["bytes"] > 4*MIB:
                raise ValueError("Invalid fragment order or size")
            path = contained(manifest_path.parent, part["file"])
            digest, count = hashlib.sha256(), 0
            with path.open("rb") as stream:
                for block in iter(lambda: stream.read(MIB), b""):
                    count += len(block)
                    if count > part["bytes"]:
                        raise ValueError("Fragment exceeds its recorded size")
                    digest.update(block)
                    compressed_hash.update(block)
                    compressed_bytes += len(block)
                    compressed.write(block)
            if count != part["bytes"] or digest.hexdigest() != part["sha256"]:
                raise ValueError("Source fragment failed its checksum")
        if compressed_bytes != manifest["compressedBytes"] or compressed_hash.hexdigest() != manifest["compressedSha256"]:
            raise ValueError("Reassembled gzip stream failed its checksum")
        compressed.seek(0)
        digest, count = hashlib.sha256(), 0
        with gzip.GzipFile(fileobj=compressed, mode="rb") as original, source_path.open("xb") as target:
            for block in iter(lambda: original.read(MIB), b""):
                count += len(block)
                if count > expected["bytes"]:
                    raise ValueError("Expanded source exceeds its recorded size")
                digest.update(block)
                target.write(block)
            target.flush()
            os.fsync(target.fileno())
        if count != expected["bytes"] or digest.hexdigest() != expected["sha256"]:
            raise ValueError(f"Restored source failed its original checksum: {expected['path']}")
    return source_path


def restore(base: Path, output: Path):
    if output.exists():
        raise ValueError("Output exists; choose a fresh destination")
    catalog = json.loads((base / "catalog.json").read_text(encoding="utf-8"))
    output.parent.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".terraviva-restored-", dir=output.parent))
    try:
        for dataset in catalog["datasets"]:
            restore_one(base, dataset, work)
        os.replace(work, output)
        return catalog["totals"]
    finally:
        if work.exists():
            shutil.rmtree(work)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, default=Path(__file__).resolve().parent / "reference-base")
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        totals = restore(args.base, args.output_dir)
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(2, f"Restore refused: {exc}\n")
    print(json.dumps({"restored": str(args.output_dir), **totals}, indent=2))


if __name__ == "__main__":
    main()
