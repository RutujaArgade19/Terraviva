'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deflateRawSync } = require('node:zlib');
const Zip = require('../public/zip-source.js');

// All archives in this file are temporary, synthetic in-memory fixtures.
function referenceCRC(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function extra(id, bytes) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(bytes.length, 2);
  return Buffer.concat([header, bytes]);
}
function wide(...values) {
  const result = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => result.writeBigUInt64LE(BigInt(value), index * 8));
  return result;
}
function makeZip(items, options = {}) {
  const base = options.offsetBase || 0;
  const locals = [];
  const centrals = [];
  const positions = [];
  let offset = base;
  let centralLength = 0;
  for (const item of items) {
    const data = Buffer.from(item.data || '');
    const rawName = item.rawName || Buffer.from(item.name, 'utf8');
    const method = item.method === undefined ? 8 : item.method;
    const flags = (item.flags === undefined ? 0x800 : item.flags) | (item.descriptor ? 8 : 0);
    const compressed = method === 8 ? deflateRawSync(data) : data;
    const crc = item.crc === undefined ? referenceCRC(data) : item.crc;
    const outputSize = item.reportedSize === undefined ? data.length : item.reportedSize;
    const zip64 = options.zip64 || item.zip64;
    const sharedExtra = item.extra || Buffer.alloc(0);
    const localExtra = Buffer.concat([zip64 ? extra(1, wide(outputSize, compressed.length)) : Buffer.alloc(0), sharedExtra]);
    const centralExtra = Buffer.concat([zip64 ? extra(1, wide(outputSize, compressed.length, offset)) : Buffer.alloc(0), sharedExtra]);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(item.descriptor ? 0 : crc, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : item.descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : item.descriptor ? 0 : outputSize, 22);
    local.writeUInt16LE(rawName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    let descriptor = Buffer.alloc(0);
    if (item.descriptor) {
      const signatureBytes = item.descriptorSignature === false ? 0 : 4;
      descriptor = Buffer.alloc(signatureBytes + 4 + (zip64 ? 16 : 8));
      if (signatureBytes) descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, signatureBytes);
      if (zip64) {
        descriptor.writeBigUInt64LE(BigInt(compressed.length), signatureBytes + 4);
        descriptor.writeBigUInt64LE(BigInt(outputSize), signatureBytes + 12);
      } else {
        descriptor.writeUInt32LE(compressed.length, signatureBytes + 4);
        descriptor.writeUInt32LE(outputSize, signatureBytes + 8);
      }
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | (zip64 ? 45 : 20), 4);
    central.writeUInt16LE(zip64 ? 45 : 20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20);
    central.writeUInt32LE(zip64 ? 0xffffffff : outputSize, 24);
    central.writeUInt16LE(rawName.length, 28);
    central.writeUInt16LE(centralExtra.length, 30);
    const mode = item.mode === undefined ? 0x81a4 : item.mode;
    central.writeUInt32LE((mode * 0x10000) >>> 0, 38);
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    positions.push({ local: offset - base, data: offset - base + 30 + rawName.length + localExtra.length, centralRelative: centralLength });
    locals.push(local, rawName, localExtra, compressed, descriptor);
    const centralParts = [central, rawName, centralExtra];
    centrals.push(...centralParts);
    centralLength += centralParts.reduce((sum, part) => sum + part.length, 0);
    offset += local.length + rawName.length + localExtra.length + compressed.length + descriptor.length;
  }
  const centralOffset = offset;
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(options.comment || '');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.zip64 ? 0xffff : items.length, 8);
  end.writeUInt16LE(options.zip64 ? 0xffff : items.length, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : centralOffset, 16);
  end.writeUInt16LE(comment.length, 20);
  let footer = Buffer.alloc(0);
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(items.length), 24);
    record.writeBigUInt64LE(BigInt(items.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(centralOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(centralOffset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    footer = Buffer.concat([record, locator]);
  }
  return {
    bytes: Buffer.concat([...locals, directory, footer, end, comment]),
    positions: positions.map(position => ({ ...position, central: centralOffset - base + position.centralRelative })),
    directoryOffset: centralOffset - base,
    directoryLength: directory.length,
    zip64Offset: centralOffset - base + directory.length,
    endOffset: centralOffset - base + directory.length + footer.length
  };
}
const blobOf = fixture => new Blob([fixture.bytes]);
const rejectsCode = (promise, code) => assert.rejects(promise, error => error instanceof Zip.ZipError && error.code === code);

test('inventories stored/deflated records and verifies bytes, zero files and Unicode names', async () => {
  const fixture = makeZip([
    { name: 'farm/', method: 0, mode: 0x41ed },
    { name: 'farm/sales.csv', data: 'amount,code\n0,00123\n12.30,00567\n', method: 0 },
    { name: 'récolte.json', data: '{"quantity":0,"field":"北"}' },
    { name: 'empty.csv', data: '', method: 0 }
  ], { comment: 'Synthetic archive, no real farmer data.' });
  const blob = blobOf(fixture);
  const result = await Zip.listArchive(blob);
  assert.equal(result.entryCount, 4);
  assert.equal(result.fileCount, 3);
  assert.equal(result.directoryCount, 1);
  assert.equal(result.entries[2].filenameEncoding, 'UTF-8');
  assert.equal(new TextDecoder().decode(await Zip.readEntry(blob, result.entries[1])), 'amount,code\n0,00123\n12.30,00567\n');
  assert.equal(new TextDecoder().decode(await Zip.readEntry(blob, result.entries[2])), '{"quantity":0,"field":"北"}');
  assert.equal((await Zip.readEntry(blob, result.entries[3])).length, 0);
  assert.equal(result.totalUncompressedBytes, result.entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0));
  await rejectsCode(Zip.readEntry(blob, result.entries[0]), 'directory_entry');
});

test('inventory of a virtual 1.31 GB Blob reads only footer and central directory', async () => {
  const base = 1310000000;
  const fixture = makeZip([{ name: 'actual.csv', data: 'id,value\n1,0\n' }], { offsetBase: base });
  const requests = [];
  const blob = {
    size: base + fixture.bytes.length,
    slice(start, end) {
      requests.push([start, end]);
      assert.ok(end - start < 100000, 'No large or whole-archive read');
      const output = Buffer.alloc(end - start);
      const overlapStart = Math.max(start, base);
      if (overlapStart < end) fixture.bytes.copy(output, overlapStart - start, overlapStart - base, end - base);
      return new Blob([output]);
    }
  };
  const result = await Zip.listArchive(blob);
  assert.equal(requests.length, 2);
  assert.ok(requests.reduce((sum, [start, end]) => sum + end - start, 0) < 70000);
  assert.equal(result.entries[0].localHeaderOffset, base);
  assert.equal(new TextDecoder().decode(await Zip.readEntry(blob, result.entries[0])), 'id,value\n1,0\n');
});

test('reads ZIP64 and only consumes extra fields for corresponding sentinel values', async () => {
  const fixture = makeZip([{ name: 'wide.csv', data: 'n\n9007199254740993\n' }], { zip64: true });
  const blob = blobOf(fixture);
  const result = await Zip.listArchive(blob);
  assert.equal(result.zip64, true);
  assert.equal(result.entries[0].zip64, true);
  assert.equal(new TextDecoder().decode(await Zip.readEntry(blob, result.entries[0])), 'n\n9007199254740993\n');
  const partial = makeZip([{ name: 'offset-only.csv', data: 'a\n0\n', extra: extra(1, wide(0)) }]);
  partial.bytes.writeUInt32LE(0xffffffff, partial.positions[0].central + 42);
  const partialBlob = blobOf(partial);
  const partialArchive = await Zip.listArchive(partialBlob);
  assert.equal(partialArchive.entries[0].localHeaderOffset, 0);
  assert.equal(new TextDecoder().decode(await Zip.readEntry(partialBlob, partialArchive.entries[0])), 'a\n0\n');
});

test('refuses imprecise ZIP64 integers and inconsistent ZIP32/ZIP64 metadata', async () => {
  const tooWide = makeZip([{ name: 'a.csv', data: 'x' }], { zip64: true });
  tooWide.bytes.writeBigUInt64LE(9007199254740992n, tooWide.positions[0].central + 46 + Buffer.byteLength('a.csv') + 4);
  await rejectsCode(Zip.listArchive(blobOf(tooWide)), 'integer_precision');
  const inconsistent = makeZip([{ name: 'a.csv', data: 'x' }], { zip64: true });
  inconsistent.bytes.writeUInt16LE(2, inconsistent.endOffset + 10);
  await rejectsCode(Zip.listArchive(blobOf(inconsistent)), 'malformed_zip64');
});

test('uses central metadata for signed and unsigned data descriptors, including ZIP64', async () => {
  for (const zip64 of [false, true]) {
    const fixture = makeZip([
      { name: 'signed.csv', data: 'value\n0\n1\n', descriptor: true },
      { name: 'unsigned.csv', data: 'value\n2\n3\n', descriptor: true, descriptorSignature: false }
    ], { zip64 });
    const blob = blobOf(fixture);
    const result = await Zip.listArchive(blob);
    assert.equal(new TextDecoder().decode(await Zip.readEntry(blob, result.entries[0])), 'value\n0\n1\n');
    assert.equal(new TextDecoder().decode(await Zip.readEntry(blob, result.entries[1])), 'value\n2\n3\n');
  }
});

test('enforces inventory and extraction limits before reading member contents', async () => {
  const fixture = makeZip([{ name: 'large.csv', data: 'abc'.repeat(10000) }]);
  const blob = blobOf(fixture);
  await rejectsCode(Zip.listArchive(blob, { maxEntries: 0 }), 'entry_count_limit');
  await rejectsCode(Zip.listArchive(blob, { maxCentralDirectoryBytes: 10 }), 'directory_size_limit');
  const result = await Zip.listArchive(blob);
  await rejectsCode(Zip.readEntry(blob, result.entries[0], { maxUncompressedBytes: 10 }), 'entry_size_limit');
  await rejectsCode(Zip.readEntry(blob, result.entries[0], { maxCompressedBytes: 1 }), 'compressed_size_limit');
  assert.equal((await Zip.readEntry(blob, result.entries[0], { maxUncompressedBytes: 30000 })).length, 30000);
  await rejectsCode(Zip.listArchive(blob, { maxEntries: Infinity }), 'invalid_limit');
});

test('rejects corrupt CRCs and forged inflated sizes instead of returning partial or changed bytes', async () => {
  for (const method of [0, 8]) {
    const fixture = makeZip([{ name: 'bad.csv', data: '123456789', method, crc: 0 }]);
    const blob = blobOf(fixture);
    const result = await Zip.listArchive(blob);
    await rejectsCode(Zip.readEntry(blob, result.entries[0]), 'crc_mismatch');
  }
  assert.equal(referenceCRC(Buffer.from('123456789')), 0xcbf43926);
  for (const reportedSize of [1, 100]) {
    const fixture = makeZip([{ name: 'wrong-size.csv', data: '123456789', reportedSize }]);
    const blob = blobOf(fixture);
    const result = await Zip.listArchive(blob);
    await rejectsCode(Zip.readEntry(blob, result.entries[0]), 'size_mismatch');
  }
});

test('inventories encrypted, unsupported-method and symlink entries but refuses extraction', async () => {
  const fixture = makeZip([
    { name: 'encrypted.csv', data: 'x', flags: 0x801 },
    { name: 'unsupported.csv', data: 'x', method: 12 },
    { name: 'link.csv', data: '../outside', method: 0, mode: 0xa1ff }
  ]);
  const blob = blobOf(fixture);
  const result = await Zip.listArchive(blob);
  assert.equal(result.encryptedCount, 1);
  assert.equal(result.symlinkCount, 1);
  assert.equal(result.unsupportedCount, 3);
  assert.ok(result.entries.every(entry => entry.readable === false));
  await rejectsCode(Zip.readEntry(blob, result.entries[0]), 'encrypted_entry');
  await rejectsCode(Zip.readEntry(blob, result.entries[1]), 'unsupported_compression');
  await rejectsCode(Zip.readEntry(blob, result.entries[2]), 'special_entry');
});

test('rejects traversal, absolute paths, Windows drives, ADS, and invalid UTF-8 names', async () => {
  for (const name of ['../x.csv', '/x.csv', 'C:\\x.csv', 'a\\..\\x.csv', 'a//x.csv', 'a:stream.csv', 'a\0.csv']) {
    await rejectsCode(Zip.listArchive(blobOf(makeZip([{ name, data: 'x' }]))), 'unsafe_path');
  }
  const invalid = makeZip([{ name: 'ignored', rawName: Buffer.from([0xff]), data: 'x' }]);
  await rejectsCode(Zip.listArchive(blobOf(invalid)), 'invalid_filename_encoding');
});

test('decodes legacy CP437 and CRC-bound Unicode path metadata without merging duplicate entries', async () => {
  const rawName = Buffer.from([0x82, 0x2e, 0x63, 0x73, 0x76]);
  const unicode = Buffer.concat([Buffer.from([1]), Buffer.alloc(4), Buffer.from('récolte.csv')]);
  unicode.writeUInt32LE(referenceCRC(rawName), 1);
  const fixture = makeZip([
    { name: 'ignored', rawName, data: 'x', flags: 0 },
    { name: 'ignored', rawName, data: 'y', flags: 0, extra: extra(0x7075, unicode) },
    { name: 'é.csv', data: 'z' }
  ]);
  const blob = blobOf(fixture);
  const result = await Zip.listArchive(blob);
  assert.deepEqual(result.entries.map(entry => entry.name), ['é.csv', 'récolte.csv', 'é.csv']);
  assert.equal(result.duplicateNameCount, 1);
  assert.equal(new TextDecoder().decode(await Zip.readEntry(blob, result.entries[1])), 'y');
});

test('rejects truncated, multipart, inconsistent directory and mismatched local-header metadata', async () => {
  await rejectsCode(Zip.listArchive(new Blob(['not a zip'])), 'missing_eocd');
  const truncated = makeZip([{ name: 'a.csv', data: 'x' }]);
  await rejectsCode(Zip.listArchive(new Blob([truncated.bytes.subarray(0, truncated.bytes.length - 1)])), 'missing_eocd');
  const multipart = makeZip([{ name: 'a.csv', data: 'x' }]);
  multipart.bytes.writeUInt16LE(1, multipart.endOffset + 4);
  await rejectsCode(Zip.listArchive(blobOf(multipart)), 'multipart_unsupported');
  const badDirectory = makeZip([{ name: 'a.csv', data: 'x' }]);
  badDirectory.bytes[badDirectory.directoryOffset] = 0;
  await rejectsCode(Zip.listArchive(blobOf(badDirectory)), 'malformed_directory');
  const badOffset = makeZip([{ name: 'a.csv', data: 'x' }]);
  badOffset.bytes.writeUInt32LE(badOffset.directoryOffset, badOffset.positions[0].central + 42);
  await rejectsCode(Zip.listArchive(blobOf(badOffset)), 'invalid_entry_offset');
  const badLocal = makeZip([{ name: 'a.csv', data: 'x' }]);
  badLocal.bytes[30] = 0x62;
  const blob = blobOf(badLocal);
  const result = await Zip.listArchive(blob);
  await rejectsCode(Zip.readEntry(blob, result.entries[0]), 'header_mismatch');
});

test('binds extraction to inventoried Blob/entry objects and supports cancellation', async () => {
  const fixture = makeZip([{ name: 'a.csv', data: 'x' }]);
  const blob = blobOf(fixture);
  const result = await Zip.listArchive(blob);
  await rejectsCode(Zip.readEntry(blobOf(fixture), result.entries[0]), 'unrecognized_entry');
  await rejectsCode(Zip.readEntry(blob, { ...result.entries[0] }), 'unrecognized_entry');
  assert.ok(Object.isFrozen(result.entries[0]));
  const controller = new AbortController();
  controller.abort();
  await rejectsCode(Zip.listArchive(blob, { signal: controller.signal }), 'aborted');
  await rejectsCode(Zip.readEntry(blob, result.entries[0], { signal: controller.signal }), 'aborted');
});
