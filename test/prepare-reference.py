#!/usr/bin/env python3
"""Small adversarial fixtures for the committed source-bundle preparation path."""
import hashlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('prepare_reference', ROOT / 'scripts/prepare-reference.py')
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


def bundle_fixture(root, entries=None, declared=None):
    entries = entries or [('csv/example.csv', b'id,value\n001,\\N\n002,0\n', None)]
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:xz') as archive:
        for name, raw, link in entries:
            info = tarfile.TarInfo(name)
            if link:
                info.type = tarfile.SYMTYPE
                info.linkname = link
                archive.addfile(info)
            else:
                info.size = len(raw)
                archive.addfile(info, io.BytesIO(raw))
    raw = stream.getvalue()
    bundle = root / 'bundle'
    bundle.mkdir()
    parts = []
    for index, offset in enumerate(range(0, len(raw), 64), 1):
        fragment = raw[offset:offset + 64]
        name = f'source.part{index:04d}'
        (bundle / name).write_bytes(fragment)
        parts.append({'file': name, 'bytes': len(fragment), 'sha256': hashlib.sha256(fragment).hexdigest()})
    members = [{'path': name, 'bytes': 0 if link else len(data),
                'sha256': hashlib.sha256(b'' if link else data).hexdigest()}
               for name, data, link in (declared if declared is not None else entries)]
    manifest = {'version': 1, 'format': 'tar+xz', 'members': members,
                'archive': {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'parts': parts}}
    (bundle / 'manifest.json').write_text(json.dumps(manifest))
    return bundle, manifest


class PrepareReferenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.work = self.root / 'work'
        self.work.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def cached_fixture(self):
        _, manifest = bundle_fixture(self.root)
        for name in ('report/archive-analysis.json', 'data/source-metadata.json'):
            target = self.work / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('{}')
        files = {p.relative_to(self.work).as_posix(): PREPARE.sha256_file(p)
                 for p in PREPARE.prepared_files(self.work)}
        stamp = {'version': 2, 'manifestSha256': PREPARE.manifest_hash(manifest),
                 'archiveSha256': manifest['archive']['sha256'], 'generatorSha256': 'fixture', 'files': files}
        (self.work / '.reference-prepared.json').write_text(json.dumps(stamp))
        self.assertTrue(PREPARE.is_current(self.work, manifest, 'fixture'))
        return manifest

    def test_missing_generated_json_invalidates_cache_for_regeneration(self):
        manifest = self.cached_fixture()
        (self.work / 'report/archive-analysis.json').unlink()
        self.assertFalse(PREPARE.is_current(self.work, manifest, 'fixture'))

    def test_full_manifest_changes_invalidate_cache(self):
        manifest = self.cached_fixture()
        changed_totals = copy.deepcopy(manifest)
        changed_totals['expectedTotals'] = {'rows': 999}
        self.assertFalse(PREPARE.is_current(self.work, changed_totals, 'fixture'))
        changed_member = copy.deepcopy(manifest)
        changed_member['members'][0]['sha256'] = '0' * 64
        self.assertFalse(PREPARE.is_current(self.work, changed_member, 'fixture'))

    def test_exact_source_bytes_survive_fragmented_bundle(self):
        bundle, manifest = bundle_fixture(self.root)
        PREPARE.verify_bundle_parts(bundle, manifest)
        extracted, result = PREPARE.unpack(bundle, self.work)
        self.assertEqual((extracted / 'csv/example.csv').read_bytes(), b'id,value\n001,\\N\n002,0\n')
        self.assertEqual(result, manifest)

    def test_corrupt_fragment_is_refused_before_cached_output_is_used(self):
        bundle, _ = bundle_fixture(self.root)
        fragment = bundle / 'source.part0001'
        content = bytearray(fragment.read_bytes())
        content[0] ^= 1
        fragment.write_bytes(content)
        with patch.object(PREPARE, 'is_current', return_value=True) as current:
            with self.assertRaisesRegex(ValueError, 'fragment checksum'):
                PREPARE.prepare(self.work, bundle)
            current.assert_not_called()

    def test_archive_checksum_is_verified_independently(self):
        bundle, manifest = bundle_fixture(self.root)
        manifest['archive']['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'archive checksum'):
            PREPARE.verify_bundle_parts(bundle, manifest)

    def test_paths_cannot_escape_extraction_root(self):
        bundle_fixture(self.root, [('../escape.csv', b'bad', None)])
        with self.assertRaisesRegex(ValueError, 'Unsafe relative path'):
            PREPARE.unpack(self.root / 'bundle', self.work)
        self.assertFalse((self.root / 'escape.csv').exists())

    def test_archive_links_and_undeclared_members_are_refused(self):
        for kind in ('link', 'undeclared'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                work = root / 'work'
                work.mkdir()
                entries = [('csv/link.csv', b'', '/tmp/elsewhere')] if kind == 'link' else [('csv/extra.csv', b'bad', None)]
                declared = None if kind == 'link' else [('csv/expected.csv', b'expected', None)]
                bundle, _ = bundle_fixture(root, entries, declared)
                with self.assertRaisesRegex(ValueError, 'Unexpected, repeated or non-regular'):
                    PREPARE.unpack(bundle, work)

    def test_declared_member_cannot_be_omitted(self):
        entries = [('csv/one.csv', b'one', None)]
        bundle, _ = bundle_fixture(self.root, entries, entries + [('csv/two.csv', b'two', None)])
        with self.assertRaisesRegex(ValueError, 'omits declared members'):
            PREPARE.unpack(bundle, self.work)

    def test_member_checksum_and_expansion_limits_are_enforced(self):
        bundle, manifest = bundle_fixture(self.root)
        manifest['members'][0]['sha256'] = '0' * 64
        (bundle / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, 'Original source bytes differ'):
            PREPARE.unpack(bundle, self.work)
        manifest['members'][0]['bytes'] = 1024 * PREPARE.MIB + 1
        with self.assertRaisesRegex(ValueError, 'Invalid member byte count'):
            PREPARE.validate_manifest(manifest)

    def test_edited_generated_file_requires_explicit_rebuild(self):
        source = self.root / 'source'
        source.write_bytes(b'verified')
        target = self.work / 'asset'
        target.write_bytes(b'user edit')
        with self.assertRaisesRegex(ValueError, 'Generated output differs'):
            PREPARE.install_file(source, self.work, 'asset', False)
        self.assertEqual(target.read_bytes(), b'user edit')
        PREPARE.install_file(source, self.work, 'asset', True)
        self.assertEqual(target.read_bytes(), b'verified')

    def test_generated_destination_cannot_use_symlink_parent(self):
        source = self.root / 'source'
        source.write_bytes(b'verified')
        outside = self.root / 'outside'
        outside.mkdir()
        (self.work / 'linked').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            PREPARE.install_file(source, self.work, 'linked/asset', True)
        self.assertFalse((outside / 'asset').exists())


if __name__ == '__main__':
    unittest.main()
