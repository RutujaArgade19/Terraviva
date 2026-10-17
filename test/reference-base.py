#!/usr/bin/env python3
"""Source fidelity and complete-page verification, including tampered manifests."""
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys

from reference_fixtures import ROOT, builder, edit_catalog, fixture, quiet, restorer, verifier


class ReferenceBaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.original, self.metadata, self.base = fixture(self.directory)

    def tearDown(self):
        self.temporary.cleanup()

    def catalog(self):
        return json.loads((self.base / "catalog.json").read_text())

    def test_complete_pages_preserve_lexical_values_nulls_and_row_positions(self):
        result = quiet(verifier.verify, self.base, self.base / "reference")
        self.assertEqual(result["rows"], 4)
        self.assertEqual(result["pages"], 2)
        catalog = self.catalog()
        first = catalog["datasets"][0]["pages"][0]
        page = json.loads(gzip.decompress((self.base / "reference" / first["file"]).read_bytes()))
        self.assertEqual(page["rows"], [["001", "3.1400", "a,b"], ["002", None, "line one\nline two"]])
        self.assertEqual((page["firstRow"], page["lastRow"]), (1, 2))
        self.assertEqual(catalog["kind"], "terraviva-reference-catalog")

    def test_original_byte_reassembly_matches_crlf_and_quoted_newlines(self):
        target = self.directory / "restored"
        quiet(restorer.restore, self.base, target)
        self.assertEqual((target/"fixture.csv").read_bytes(), (self.original/"fixture.csv").read_bytes())

    def test_existing_output_is_never_overwritten(self):
        with self.assertRaisesRegex(ValueError, "exists"):
            quiet(builder.build, self.original, self.metadata, self.base)
        self.assertTrue((self.base/"catalog.json").exists())

    def test_modified_source_is_rejected_before_publication(self):
        with (self.original/"fixture.csv").open("ab") as stream:
            stream.write(b"extra,cell,row\n")
        output = self.directory / "changed-build"
        with self.assertRaisesRegex(ValueError, "checksum|changed"):
            quiet(builder.build, self.original, self.metadata, output)
        self.assertFalse(output.exists())

    def test_declared_row_count_must_match_source(self):
        metadata = json.loads(self.metadata.read_text())
        metadata["sources"][0]["rowCount"] += 1
        self.metadata.write_text(json.dumps(metadata))
        with self.assertRaisesRegex(ValueError, "row count"):
            quiet(builder.build, self.original, self.metadata, self.directory/"wrong-rows")

    def test_corrupt_fragment_fails_even_if_gzip_remains_decodable(self):
        source = self.catalog()["datasets"][0]
        manifest_path = self.base / source["sourceStorage"]["file"]
        manifest = json.loads(manifest_path.read_text())
        part = manifest_path.parent / manifest["parts"][0]["file"]
        data = bytearray(part.read_bytes())
        data[4] ^= 1  # Gzip timestamp, unrelated to decoded CSV cells.
        part.write_bytes(data)
        with self.assertRaisesRegex(ValueError, "checksum"):
            quiet(verifier.verify, self.base, self.base/"reference")

    def test_changed_cell_is_detected_even_with_matching_page_hashes(self):
        catalog = self.catalog()
        page_descriptor = catalog["datasets"][0]["pages"][0]
        path = self.base/"reference"/page_descriptor["file"]
        page = json.loads(gzip.decompress(path.read_bytes()))
        page["rows"][0][1] = "999.00"
        raw = json.dumps(page).encode()
        compressed = gzip.compress(raw, mtime=0)
        path.write_bytes(compressed)
        def update(c):
            d = c["datasets"][0]["pages"][0]
            d.update(bytes=len(compressed), decodedBytes=len(raw), sha256=hashlib.sha256(compressed).hexdigest(), decodedSha256=hashlib.sha256(raw).hexdigest())
        edit_catalog(self.base, update)
        with self.assertRaisesRegex(ValueError, "cell differs"):
            quiet(verifier.verify, self.base, self.base/"reference")

    def test_dropped_page_is_detected(self):
        edit_catalog(self.base, lambda c: c["datasets"][0]["pages"].pop())
        with self.assertRaisesRegex(ValueError, "entire source"):
            quiet(verifier.verify, self.base, self.base/"reference")

    def test_reordered_pages_are_detected(self):
        edit_catalog(self.base, lambda c: c["datasets"][0]["pages"].reverse())
        with self.assertRaisesRegex(ValueError, "ordering"):
            quiet(verifier.verify, self.base, self.base/"reference")

    def test_farmer_assignment_is_refused(self):
        edit_catalog(self.base, lambda c: c["datasets"][0].update(farmerAssignment="a-farm"))
        with self.assertRaisesRegex(ValueError, "farmer/consent"):
            quiet(verifier.verify, self.base, self.base/"reference")

    def test_source_traversal_is_refused(self):
        edit_catalog(self.base, lambda c: c["datasets"][0]["sourceStorage"].update(file="../outside.json"))
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            quiet(verifier.verify, self.base, self.base/"reference")

    def test_catalog_totals_cannot_mask_omitted_rows(self):
        edit_catalog(self.base, lambda c: c["totals"].update(rows=3))
        with self.assertRaisesRegex(ValueError, "totals"):
            quiet(verifier.verify, self.base, self.base/"reference")

    def test_legacy_sqlite_flag_builds_a_real_database(self):
        output = self.directory / "legacy-build"
        result = subprocess.run([sys.executable, str(ROOT/'scripts/build-reference-base.py'),
            '--input', str(self.original), '--metadata', str(self.metadata), '--output-dir', str(output), '--sqlite'],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((output/'sqlite/terraviva-reference.sqlite3').is_file())


if __name__ == "__main__":
    unittest.main()
