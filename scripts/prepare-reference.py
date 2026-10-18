#!/usr/bin/env python3
"""Reconstruct complete reference assets from the committed, checksummed source bundle."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import tarfile
import tempfile

from reference_data import contained, safe_relative, sha256_file, MIB

ROOT = Path(__file__).resolve().parents[1]


def validate_manifest(manifest):
    if manifest.get('version') != 1 or manifest.get('format') != 'tar+xz':
        raise ValueError('Unsupported source bundle format')
    members = manifest['members']
    if not 1 <= len(members) <= 128 or len({m['path'] for m in members}) != len(members):
        raise ValueError('Empty or repeated bundle members')
    for member in members:
        safe_relative(member['path'])
        if type(member['bytes']) is not int or not 0 <= member['bytes'] <= 1024 * MIB:
            raise ValueError('Invalid member byte count')
        if not isinstance(member['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', member['sha256']):
            raise ValueError('Invalid member checksum')
    if sum(m['bytes'] for m in members) > 1024 * MIB:
        raise ValueError('Source bundle expands beyond the supported limit')
    archive = manifest['archive']
    if (type(archive['bytes']) is not int or not 1 <= archive['bytes'] <= 256 * MIB or
            not isinstance(archive['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', archive['sha256'])):
        raise ValueError('Invalid source archive size or checksum')
    parts = manifest['archive']['parts']
    if not 1 <= len(parts) <= 1024 or len({p['file'] for p in parts}) != len(parts):
        raise ValueError('Empty or repeated bundle fragments')
    for part in parts:
        safe_relative(part['file'])
        if type(part['bytes']) is not int or not 1 <= part['bytes'] <= 500000:
            raise ValueError('Invalid fragment byte count')
        if not isinstance(part['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', part['sha256']):
            raise ValueError('Invalid fragment checksum')
    if sum(p['bytes'] for p in parts) != manifest['archive']['bytes']:
        raise ValueError('Archive and fragment byte counts disagree')
    return members


def verify_bundle_parts(bundle, manifest):
    """Verify committed bytes even when generated output is already cached."""
    digest = hashlib.sha256()
    for part in manifest['archive']['parts']:
        path = contained(bundle, part['file'])
        if path.stat().st_size != part['bytes']:
            raise ValueError('Source bundle fragment size differs: ' + part['file'])
        part_hash = hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda: stream.read(MIB), b''):
                part_hash.update(block)
                digest.update(block)
        if part_hash.hexdigest() != part['sha256']:
            raise ValueError('Source bundle fragment checksum differs: ' + part['file'])
    if digest.hexdigest() != manifest['archive']['sha256']:
        raise ValueError('Source bundle archive checksum differs')


def unpack(bundle, destination):
    manifest = json.loads((bundle / 'manifest.json').read_text(encoding='utf-8'))
    members = validate_manifest(manifest)
    expected = {m['path']: m for m in members}
    archive_path = destination / 'source.tar.xz'
    full_hash = hashlib.sha256()
    with archive_path.open('xb') as output:
        for part in manifest['archive']['parts']:
            path = contained(bundle, part['file'])
            if path.stat().st_size != part['bytes'] or sha256_file(path) != part['sha256']:
                raise ValueError('Source bundle fragment checksum differs: ' + part['file'])
            with path.open('rb') as source:
                for block in iter(lambda: source.read(MIB), b''):
                    full_hash.update(block)
                    output.write(block)
    if full_hash.hexdigest() != manifest['archive']['sha256']:
        raise ValueError('Source bundle archive checksum differs')
    extracted = destination / 'extracted'
    extracted.mkdir()
    seen = set()
    # Never extract arbitrary paths, links, or executable source documents.
    with tarfile.open(archive_path, mode='r:xz') as archive:
        for member in archive:
            if member.name not in expected or member.name in seen or not member.isfile():
                raise ValueError('Unexpected, repeated or non-regular archive member')
            spec = expected[member.name]
            if member.size != spec['bytes']:
                raise ValueError('Archive member size differs: ' + member.name)
            path = contained(extracted, member.name)
            path.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            count = 0
            with archive.extractfile(member) as source, path.open('xb') as output:
                for block in iter(lambda: source.read(MIB), b''):
                    count += len(block)
                    if count > spec['bytes']:
                        raise ValueError('Archive member exceeds its declared size')
                    digest.update(block)
                    output.write(block)
            if count != spec['bytes'] or digest.hexdigest() != spec['sha256']:
                raise ValueError('Original source bytes differ: ' + member.name)
            seen.add(member.name)
    if seen != set(expected):
        raise ValueError('The source archive omits declared members')
    return extracted, manifest


def generator_hash():
    digest = hashlib.sha256()
    for name in ('prepare-reference.py', 'build-reference-base.py', 'reference_data.py'):
        digest.update((ROOT / 'scripts' / name).read_bytes())
    return digest.hexdigest()


def manifest_hash(manifest):
    raw = json.dumps(manifest, sort_keys=True, ensure_ascii=False, allow_nan=False,
                     separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def prepared_files(root):
    files = []
    for name in ('data/reference-base', 'public/reference'):
        files.extend(p for p in contained(root, name).rglob('*') if p.is_file())
    files.extend(contained(root, name) for name in ('report/archive-analysis.json', 'data/source-metadata.json'))
    for path in files:
        contained(root, path.relative_to(root).as_posix())
    return files


def is_current(root, manifest, generator):
    marker = contained(root, '.reference-prepared.json')
    if not marker.exists():
        return False
    try:
        stamp = json.loads(marker.read_text())
    except (OSError, ValueError):
        return False
    if not isinstance(stamp, dict) or not isinstance(stamp.get('files'), dict):
        return False
    if (stamp.get('version') != 2 or stamp.get('manifestSha256') != manifest_hash(manifest) or
            stamp.get('archiveSha256') != manifest['archive']['sha256'] or stamp.get('generatorSha256') != generator):
        return False
    files = prepared_files(root)
    expected = stamp.get('files', {})
    actual_names = {p.relative_to(root).as_posix() for p in files}
    if actual_names != set(expected):
        return False
    return all(p.is_file() and not p.is_symlink() and sha256_file(p) == expected[p.relative_to(root).as_posix()] for p in files)


def install_file(source, root, relative, replace):
    target = contained(root, relative)
    if target.exists() and sha256_file(source) != sha256_file(target) and not replace:
        raise ValueError('Generated output differs; inspect it, then use --rebuild: ' + str(target))
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def prepare(root, bundle, replace=False):
    manifest = json.loads((bundle / 'manifest.json').read_text())
    validate_manifest(manifest)
    verify_bundle_parts(bundle, manifest)
    generator = generator_hash()
    if is_current(root, manifest, generator):
        print('Reference source bundle and all prepared assets are current.', flush=True)
        return
    with tempfile.TemporaryDirectory(prefix='terraviva-prepare-') as directory:
        work = Path(directory)
        extracted, manifest = unpack(bundle, work)
        spec = importlib.util.spec_from_file_location('terraviva_build_reference', ROOT / 'scripts' / 'build-reference-base.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        output = work / 'reference-build'
        totals = module.build(extracted / 'csv', extracted / 'data/source-metadata.json', output)
        if totals != manifest['expectedTotals']:
            raise ValueError('Rebuilt source dimensions differ from the verified collection')
        mappings = [(output / 'reference', contained(root, 'public/reference')),
                    (output / 'sources', contained(root, 'data/reference-base/sources')),
                    (output / 'schemas', contained(root, 'data/reference-base/schemas'))]
        for source, target in mappings:
            expected = {p.relative_to(source).as_posix() for p in source.rglob('*') if p.is_file()}
            if target.exists():
                extras = [p for p in target.rglob('*') if p.is_file() and p.relative_to(target).as_posix() not in expected]
                if extras:
                    raise ValueError('Managed output contains unexpected files; inspect before replacing: ' + str(target))
            for path in source.rglob('*'):
                if path.is_file():
                    destination = target / path.relative_to(source)
                    install_file(path, root, destination.relative_to(root).as_posix(), replace)
        install_file(output / 'catalog.json', root, 'data/reference-base/catalog.json', replace)
        for name in ('report/archive-analysis.json', 'data/source-metadata.json'):
            install_file(extracted / name, root, name, replace)
    hashes = {p.relative_to(root).as_posix(): sha256_file(p) for p in prepared_files(root)}
    marker = {'version': 2, 'manifestSha256': manifest_hash(manifest), 'archiveSha256': manifest['archive']['sha256'],
              'generatorSha256': generator, 'files': hashes}
    contained(root, '.reference-prepared.json').write_text(json.dumps(marker, indent=2) + '\n')
    print('Prepared all 28 verified sources and every reference page.', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--bundle', type=Path, default=ROOT / 'data/source-bundle')
    parser.add_argument('--rebuild', action='store_true', help='Replace inspected generated files after a deliberate source/generator update')
    args = parser.parse_args()
    prepare(args.root.resolve(), args.bundle.resolve(), args.rebuild)


if __name__ == '__main__':
    main()
