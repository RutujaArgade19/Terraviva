#!/usr/bin/env python3
"""Temporary synthetic fixtures verify staging; no base data is committed."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "stage-datasets.py"


class StagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="terraviva-stage-test-")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def run_stage(self, *arguments: object, ok=True):
        result = subprocess.run([sys.executable, str(SCRIPT), *map(str, arguments)], text=True, capture_output=True, timeout=60)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("Stage refused:", result.stderr)
        return result

    def archive(self, name="source.zip", members=None):
        destination = self.root / name
        with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
            for path, content in (members or {}).items():
                archive.writestr(path, content)
        return destination

    def test_snapshot_preserves_sources_rows_types_and_relationships(self):
        csv_bytes = b'\xef\xbb\xbfid;quantity;note\r\n001;0;"north; field"\r\n002;12,5;NA\r\n'
        json_bytes = b'{"farm":"other-farm","depot":{"records":[{"id":9007199254740993,"quantity":0,"active":false,"rate":0.1234567890123456789012345},{"id":9007199254740993,"quantity":0,"active":false,"rate":0.1234567890123456789012345}],"reference":[{"code":"ES"}]}}'
        source = self.archive(members={"harvests.csv": csv_bytes, "nested/depot.json": json_bytes, "README.txt": "do not interpret as rows", "__MACOSX/._notes": "metadata"})
        output = self.root / "staged"
        summary = self.run_stage("--input", source, "--output-dir", output)
        self.assertEqual((summary["files"], summary["datasets"], summary["rows"]), (2, 3, 5))
        self.assertIsNone(summary["publishedApp"])
        with sqlite3.connect(output / "base.sqlite3") as database:
            self.assertEqual(database.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(database.execute("PRAGMA foreign_key_check").fetchall(), [])
            saved = dict(database.execute("SELECT logical_path, source_bytes FROM source_files"))
            self.assertEqual(saved["harvests.csv"], csv_bytes)
            self.assertEqual(saved["nested/depot.json"], json_bytes)
            actual_sha = database.execute("SELECT sha256 FROM source_files WHERE logical_path='harvests.csv'").fetchone()[0]
            self.assertEqual(actual_sha, hashlib.sha256(csv_bytes).hexdigest())
            csv_row = database.execute("SELECT row_json FROM rows JOIN datasets USING(dataset_id) WHERE source_format='csv' AND row_index=1").fetchone()[0]
            self.assertEqual(json.loads(csv_row), {"id": "001", "quantity": "0", "note": "north; field"})
            parsed = database.execute("SELECT row_json FROM rows JOIN datasets USING(dataset_id) WHERE table_pointer='/depot/records' AND row_index=1").fetchone()[0]
            self.assertIn('"id":9007199254740993', parsed)
            self.assertIn('"rate":0.1234567890123456789012345', parsed)
            self.assertIn('"active":false', parsed)
            self.assertEqual(database.execute("SELECT duplicate_extra_rows FROM datasets WHERE table_pointer='/depot/records'").fetchone()[0], 1)
            self.assertEqual(database.execute("SELECT COUNT(*) FROM rows JOIN datasets USING(dataset_id) JOIN source_files USING(source_file_id)").fetchone()[0], 5)
            profile = json.loads(database.execute("SELECT profile_json FROM columns JOIN datasets USING(dataset_id) WHERE source_format='csv' AND json_pointer='/quantity'").fetchone()[0])
            self.assertEqual(profile["missing"], 0)
            self.assertEqual(profile["unconvertedLocaleNumbers"], 1)
            self.assertEqual(profile["rowsProfiled"], 2)
        catalog = json.loads((output / "catalog.json").read_text())
        entry = next(row for row in catalog["datasets"] if row["source"]["tablePointer"] == "/depot/records")
        text = (output / entry["file"]).read_text()
        view = json.loads(text)
        self.assertEqual(view["_terravivaDataset"]["role"], "reference")
        self.assertIsNone(view["_terravivaDataset"]["farmerAssignment"])
        self.assertEqual(view["_terravivaDataset"]["sourceContext"][""]["farm"], "other-farm")
        self.assertEqual(len(view["records"]), 2)
        self.assertIn('"rate":0.1234567890123456789012345', text)
        self.assertEqual(entry["bytes"], len(text.encode()))
        self.assertEqual(len(catalog["skippedFiles"]), 2)

    def test_repeat_build_is_deterministic_and_parser_settings_change_provenance(self):
        source = self.archive(members={"data.csv": "id,quantity\na,0\nb,3\n"})
        first, second, changed = (self.root / name for name in ("one", "two", "changed"))
        a = self.run_stage("--input", source, "--output-dir", first)
        b = self.run_stage("--input", source, "--output-dir", second)
        self.assertEqual(a["buildId"], b["buildId"])
        self.assertEqual((first / "base.sqlite3").read_bytes(), (second / "base.sqlite3").read_bytes())
        c = self.run_stage("--input", source, "--output-dir", changed, "--delimiter", "comma")
        self.assertNotEqual(a["buildId"], c["buildId"])
        with sqlite3.connect(changed / "base.sqlite3") as database:
            metadata = dict(database.execute("SELECT key,value_json FROM build_metadata"))
            self.assertEqual(json.loads(metadata["parserSettings"])["delimiter"], ",")
            self.assertEqual(json.loads(metadata["generatorSha256"]), hashlib.sha256(SCRIPT.read_bytes()).hexdigest())

    def test_context_preserves_nested_farm_claims_beside_array_fields(self):
        source_data = {"metadata": {"farm_id": "other", "tags": ["x"],
                                   "nested": {"label": "retain", "samples": [1, 2]}},
                       "records": [{"quantity": 1}]}
        source = self.archive(members={"context.json": json.dumps(source_data)})
        output = self.root / "context-result"
        self.run_stage("--input", source, "--output-dir", output)
        catalog = json.loads((output / "catalog.json").read_text())
        entry = next(row for row in catalog["datasets"] if row["source"]["tablePointer"] == "/records")
        view = json.loads((output / entry["file"]).read_text())
        context = view["_terravivaDataset"]["sourceContext"]
        self.assertEqual(context[""]["metadata"], {"farm_id": "other", "nested": {"label": "retain"}})

        def assert_no_arrays(value):
            self.assertNotIsInstance(value, list)
            if isinstance(value, dict):
                for item in value.values():
                    assert_no_arrays(item)

        assert_no_arrays(context)
        self.assertEqual(view["records"], source_data["records"])
        with sqlite3.connect(output / "base.sqlite3") as database:
            stored = json.loads(database.execute("SELECT context_json FROM datasets WHERE table_pointer='/records'").fetchone()[0])
            self.assertEqual(stored["sourceContext"][""]["metadata"]["farm_id"], "other")

    def test_output_is_not_overwritten_without_deliberate_owned_replace(self):
        source = self.archive(members={"reference.json": '[{"country":"ES"}]'})
        output = self.root / "staged"
        self.run_stage("--input", source, "--output-dir", output)
        before = (output / "base.sqlite3").read_bytes()
        self.run_stage("--input", source, "--output-dir", output, ok=False)
        self.assertEqual(before, (output / "base.sqlite3").read_bytes())
        self.run_stage("--input", source, "--output-dir", output, "--replace")
        (output / "personal.txt").write_text("keep")
        self.run_stage("--input", source, "--output-dir", output, "--replace", ok=False)
        self.assertEqual((output / "personal.txt").read_text(), "keep")
        unowned = self.root / "unowned"
        unowned.mkdir()
        (unowned / "keep.txt").write_text("keep")
        self.run_stage("--input", source, "--output-dir", unowned, "--replace", ok=False)

    def test_zip_traversal_absolute_paths_and_symlinks_are_rejected(self):
        for index, path in enumerate(("../outside.csv", "/absolute.csv", "C:\\outside.csv", "nested/../../outside.csv")):
            with self.subTest(path=path):
                source = self.archive(f"bad-{index}.zip", {path: "id\nx\n"})
                output = self.root / f"out-{index}"
                self.run_stage("--input", source, "--output-dir", output, ok=False)
                self.assertFalse(output.exists())
        symlink = self.root / "link.zip"
        info = zipfile.ZipInfo("link.csv")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        with zipfile.ZipFile(symlink, "w") as archive:
            archive.writestr(info, "../../outside.csv")
        self.run_stage("--input", symlink, "--output-dir", self.root / "link-output", ok=False)
        self.assertFalse((self.root.parent / "outside.csv").exists())

    def test_row_bounds_and_invalid_rows_leave_no_partial_snapshot(self):
        source = self.archive(members={"data.csv": "id,quantity\na,1\nb,2\n"})
        output = self.root / "rows"
        self.run_stage("--input", source, "--output-dir", output, "--max-rows", "1", ok=False)
        self.assertFalse(output.exists())
        ragged = self.archive("ragged.zip", {"data.csv": "a,b\n1,2,3\n"})
        self.run_stage("--input", ragged, "--output-dir", self.root / "ragged", ok=False)
        duplicate = self.archive("duplicate.zip", {"data.json": '[{"id":1,"id":2}]'})
        self.run_stage("--input", duplicate, "--output-dir", self.root / "duplicate", ok=False)

    def test_large_or_wide_views_are_not_silently_truncated_or_published(self):
        large = [{"country": "ES", "text": "x" * 700} for _ in range(1700)]
        wide = [{f"column_{index}": index for index in range(251)}]
        source = self.archive(members={"large.json": json.dumps(large), "wide.json": json.dumps(wide), "small.tsv": "code\tlabel\nES\tSpain\n"})
        output, app = self.root / "staged", self.root / "public"
        summary = self.run_stage("--input", source, "--output-dir", output, "--publish-app", "--app-dir", app)
        self.assertEqual(summary["requiresSplit"], 2)
        catalog = json.loads((output / "catalog.json").read_text())
        self.assertEqual(sum(entry["rows"] for entry in catalog["datasets"]), 1702)
        for entry in catalog["datasets"]:
            if entry["status"] == "requires-split":
                self.assertIsNone(entry["file"])
                self.assertFalse((output / "views" / (entry["id"] + ".json")).exists())
        manifest = json.loads((app / "manifest.json").read_text())
        self.assertEqual(len(manifest["datasets"]), 1)
        self.assertEqual(len(manifest["unpublishedDatasets"]), 2)
        self.assertTrue(all((app / entry["file"]).stat().st_size <= 1024 * 1024 for entry in manifest["datasets"]))
        with sqlite3.connect(output / "base.sqlite3") as database:
            self.assertEqual(database.execute("SELECT COUNT(*) FROM rows").fetchone()[0], 1702)

    def test_publication_is_explicit_preserves_unrelated_files_and_verifies_generated_ownership(self):
        source = self.archive(members={"reference.json": '[{"code":"ES"}]'})
        output, app = self.root / "staged", self.root / "public"
        app.mkdir()
        initial = {"version": 1, "status": "awaiting-source-archive", "datasets": [{"id": "manual", "name": "manual", "file": "manual.json", "format": "json", "rows": 1}]}
        (app / "manifest.json").write_text(json.dumps(initial))
        (app / "manual.json").write_text('[{"keep":true}]')
        self.run_stage("--input", source, "--output-dir", output, "--app-dir", app)
        self.assertEqual(json.loads((app / "manifest.json").read_text()), initial)
        self.run_stage("--input", source, "--output-dir", output, "--replace", "--publish-app", "--app-dir", app)
        manifest = json.loads((app / "manifest.json").read_text())
        self.assertEqual(manifest["datasets"][0], initial["datasets"][0])
        self.assertEqual((app / "manual.json").read_text(), '[{"keep":true}]')
        generated = next(entry for entry in manifest["datasets"] if entry["id"] != "manual")
        (app / generated["file"]).write_text('[{"edited":true}]')
        before = (output / "base.sqlite3").read_bytes()
        self.run_stage("--input", source, "--output-dir", output, "--replace", "--publish-app", "--app-dir", app, ok=False)
        self.assertEqual(before, (output / "base.sqlite3").read_bytes())
        self.assertEqual((app / generated["file"]).read_text(), '[{"edited":true}]')

    def test_directory_input_and_explicit_temporary_schema_initialization(self):
        source = self.root / "input"
        source.mkdir()
        (source / "codes.json").write_text('[{"code":"ES"},{"code":"PT"}]')
        result = self.run_stage("--input", source, "--output-dir", self.root / "directory-result")
        self.assertEqual(result["rows"], 2)
        empty = self.root / "schema-check"
        result = self.run_stage("--init-empty", "--output-dir", empty)
        self.assertEqual(result["status"], "schema-only-empty")
        with sqlite3.connect(empty / "base.sqlite3") as database:
            self.assertEqual(database.execute("SELECT COUNT(*) FROM source_files").fetchone()[0], 0)
            self.assertEqual(database.execute("PRAGMA user_version").fetchone()[0], 1)
        self.run_stage("--init-empty", ok=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
