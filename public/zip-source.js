/* Terraviva ZIP source reader. No network, filesystem writes, or executable content.
 * Format: PKWARE APPNOTE 6.3.10, https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
 * listArchive reads the footer and bounded central directory, not the entire Blob.
 * readEntry returns verified bytes for one entry; CRC32 detects corruption, not provenance.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TerravivaZipSource = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MiB = 1024 * 1024;
  const MAX_SAFE = Number.MAX_SAFE_INTEGER;
  const DEFAULTS = Object.freeze({
    maxEntries: 100000,
    maxCentralDirectoryBytes: 64 * MiB,
    maxPathDepth: 64,
    maxUncompressedBytes: 50 * MiB,
    maxCompressedBytes: 50 * MiB
  });
  const registered = new WeakMap();
  const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
    '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
    '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }

  class ZipError extends Error {
    constructor(code, message, details) {
      super(message);
      this.name = 'ZipError';
      this.code = code;
      if (details !== undefined) this.details = details;
    }
  }
  function fail(code, message, details) { throw new ZipError(code, message, details); }
  function integer(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid_limit', label + ' must be a nonnegative safe integer.');
    return value;
  }
  function limit(options, name) {
    return integer(options[name] === undefined ? DEFAULTS[name] : options[name], name);
  }
  function add(a, b, label) {
    const result = a + b;
    if (!Number.isSafeInteger(result) || result < 0) fail('integer_precision', label + ' exceeds exact JavaScript integer support.');
    return result;
  }
  function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  function uint64(dv, offset, label) {
    const low = dv.getUint32(offset, true);
    const high = dv.getUint32(offset + 4, true);
    if (high > 0x1fffff) fail('integer_precision', label + ' exceeds exact JavaScript integer support.');
    return high * 0x100000000 + low;
  }
  function crcUpdate(state, bytes) {
    let c = state;
    for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return c >>> 0;
  }
  function crc32(bytes) { return (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }
  function checkBlob(blob) {
    if (!blob || !Number.isSafeInteger(blob.size) || blob.size < 0 || typeof blob.slice !== 'function') {
      fail('invalid_blob', 'Expected a File or Blob with an exact byte size and slice method.');
    }
  }
  function checkAbort(signal) {
    if (signal && signal.aborted) fail('aborted', 'ZIP reading was cancelled.');
  }
  async function bytesAt(blob, offset, length, signal) {
    checkAbort(signal);
    const end = add(offset, length, 'Read boundary');
    if (offset < 0 || end > blob.size) fail('truncated_archive', 'ZIP metadata points outside the archive.');
    const part = blob.slice(offset, end);
    if (!part || typeof part.arrayBuffer !== 'function') fail('invalid_blob', 'Blob slices must support arrayBuffer().');
    const bytes = new Uint8Array(await part.arrayBuffer());
    checkAbort(signal);
    if (bytes.byteLength !== length) fail('truncated_archive', 'Could not read the requested ZIP bytes.');
    return bytes;
  }
  function extras(bytes) {
    const result = new Map();
    const dv = view(bytes);
    let offset = 0;
    while (offset < bytes.length) {
      if (offset + 4 > bytes.length) fail('malformed_extra', 'A ZIP extra-field header is truncated.');
      const id = dv.getUint16(offset, true);
      const size = dv.getUint16(offset + 2, true);
      offset += 4;
      if (offset + size > bytes.length) fail('malformed_extra', 'A ZIP extra field extends beyond its header.');
      if (result.has(id) && (id === 1 || id === 0x7075)) fail('malformed_extra', 'A critical ZIP extra field is repeated.');
      if (!result.has(id)) result.set(id, bytes.subarray(offset, offset + size));
      offset += size;
    }
    return result;
  }
  function utf8(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { fail('invalid_filename_encoding', 'A ZIP filename marked as UTF-8 is invalid.'); }
  }
  function decodeName(raw, flags, extra) {
    if (flags & 0x800) return { name: utf8(raw), encoding: 'UTF-8' };
    const unicode = extra.get(0x7075);
    if (unicode && unicode.length >= 5 && unicode[0] === 1 && view(unicode).getUint32(1, true) === crc32(raw)) {
      return { name: utf8(unicode.subarray(5)), encoding: 'Info-ZIP Unicode path' };
    }
    let name = '';
    for (let i = 0; i < raw.length; i += 1) name += raw[i] < 128 ? String.fromCharCode(raw[i]) : CP437[raw[i] - 128];
    return { name: name, encoding: 'CP437' };
  }
  function safeName(name, maxDepth) {
    const normalized = name.replace(/\\/g, '/');
    if (!normalized || normalized[0] === '/' || /[\x00-\x1f\x7f:]/.test(normalized)) {
      fail('unsafe_path', 'ZIP entry names must be relative paths without control characters or drive prefixes.', { name: name });
    }
    const parts = normalized.split('/');
    if (parts[parts.length - 1] === '') parts.pop();
    if (!parts.length || parts.some(function (part) { return part === '' || part === '.' || part === '..'; })) {
      fail('unsafe_path', 'ZIP entry names cannot contain empty, dot, or parent-directory path components.', { name: name });
    }
    if (parts.length > maxDepth) fail('path_depth_limit', 'A ZIP entry exceeds the configured path-depth limit.', { name: name });
    return normalized;
  }
  function sameBytes(left, right) {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
    return true;
  }
  function zip64Fields(extra, values) {
    const needed = values.uncompressedSize === 0xffffffff || values.compressedSize === 0xffffffff ||
      values.localHeaderOffset === 0xffffffff || values.disk === 0xffff;
    if (!needed) return false;
    const data = extra.get(1);
    if (!data) fail('missing_zip64', 'A ZIP64 entry is missing its extended size or offset fields.');
    const dv = view(data);
    let offset = 0;
    for (const key of ['uncompressedSize', 'compressedSize', 'localHeaderOffset']) {
      if (values[key] === 0xffffffff) {
        if (offset + 8 > data.length) fail('malformed_zip64', 'A ZIP64 size or offset is truncated.');
        values[key] = uint64(dv, offset, key);
        offset += 8;
      }
    }
    if (values.disk === 0xffff) {
      if (offset + 4 > data.length) fail('malformed_zip64', 'The ZIP64 disk number is truncated.');
      values.disk = dv.getUint32(offset, true);
    }
    return true;
  }

  async function listArchive(blob, options) {
    options = options || {};
    checkBlob(blob);
    const maxEntries = limit(options, 'maxEntries');
    const maxDirectory = limit(options, 'maxCentralDirectoryBytes');
    const maxPathDepth = limit(options, 'maxPathDepth');
    if (blob.size < 22) fail('missing_eocd', 'The file is too short to be a ZIP archive.');
    const tailSize = Math.min(blob.size, 22 + 65535 + 20);
    const tailStart = blob.size - tailSize;
    const tail = await bytesAt(blob, tailStart, tailSize, options.signal);
    const td = view(tail);
    let endIndex = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (td.getUint32(i, true) === 0x06054b50 && i + 22 + td.getUint16(i + 20, true) === tail.length) {
        endIndex = i;
        break;
      }
    }
    if (endIndex < 0) fail('missing_eocd', 'No complete ZIP end-of-directory record was found. Trailing data and split archives are unsupported.');
    const endOffset = tailStart + endIndex;
    let disk = td.getUint16(endIndex + 4, true);
    let directoryDisk = td.getUint16(endIndex + 6, true);
    let diskEntries = td.getUint16(endIndex + 8, true);
    let entryCount = td.getUint16(endIndex + 10, true);
    let directorySize = td.getUint32(endIndex + 12, true);
    let directoryOffset = td.getUint32(endIndex + 16, true);
    let footerStart = endOffset;
    const requiresZip64 = disk === 0xffff || directoryDisk === 0xffff || diskEntries === 0xffff ||
      entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff;
    const hasLocator = endIndex >= 20 && td.getUint32(endIndex - 20, true) === 0x07064b50;
    let zip64 = requiresZip64 || hasLocator;
    const notes = [];
    if (zip64) {
      if (!hasLocator) fail('missing_zip64', 'The ZIP64 end-of-directory locator is missing.');
      const locator = endIndex - 20;
      if (td.getUint32(locator + 4, true) !== 0 || td.getUint32(locator + 16, true) !== 1) {
        fail('multipart_unsupported', 'Multipart ZIP archives are not supported.');
      }
      const recordOffset = uint64(td, locator + 8, 'ZIP64 directory record offset');
      const record = await bytesAt(blob, recordOffset, 56, options.signal);
      const rd = view(record);
      if (rd.getUint32(0, true) !== 0x06064b50) fail('malformed_zip64', 'The ZIP64 end-of-directory signature is invalid.');
      const recordSize = uint64(rd, 4, 'ZIP64 directory record size');
      if (recordSize < 44 || add(recordOffset, add(recordSize, 12, 'ZIP64 record size'), 'ZIP64 record end') !== endOffset - 20) {
        fail('malformed_zip64', 'The ZIP64 directory record has an inconsistent size or location.');
      }
      const values = {
        disk: rd.getUint32(16, true), directoryDisk: rd.getUint32(20, true),
        diskEntries: uint64(rd, 24, 'ZIP64 entries on disk'), entryCount: uint64(rd, 32, 'ZIP64 entry count'),
        directorySize: uint64(rd, 40, 'ZIP64 directory size'), directoryOffset: uint64(rd, 48, 'ZIP64 directory offset')
      };
      for (const item of [[disk, values.disk, 0xffff], [directoryDisk, values.directoryDisk, 0xffff],
        [diskEntries, values.diskEntries, 0xffff], [entryCount, values.entryCount, 0xffff],
        [directorySize, values.directorySize, 0xffffffff], [directoryOffset, values.directoryOffset, 0xffffffff]]) {
        if (item[0] !== item[2] && item[0] !== item[1]) fail('malformed_zip64', 'ZIP32 and ZIP64 directory metadata disagree.');
      }
      disk = values.disk; directoryDisk = values.directoryDisk;
      diskEntries = values.diskEntries; entryCount = values.entryCount;
      directorySize = values.directorySize; directoryOffset = values.directoryOffset;
      footerStart = recordOffset;
    }
    if (disk !== 0 || directoryDisk !== 0 || diskEntries !== entryCount) fail('multipart_unsupported', 'Multipart ZIP archives are not supported.');
    if (entryCount > maxEntries) fail('entry_count_limit', 'The ZIP entry count exceeds the configured limit.', { actual: entryCount, limit: maxEntries });
    if (directorySize > maxDirectory) fail('directory_size_limit', 'The ZIP central directory exceeds the configured byte limit.', { actual: directorySize, limit: maxDirectory });
    if (entryCount * 46 > directorySize || add(directoryOffset, directorySize, 'Central directory end') > footerStart) {
      fail('malformed_directory', 'ZIP directory size, entry count, or offset is inconsistent.');
    }
    const directory = await bytesAt(blob, directoryOffset, directorySize, options.signal);
    const dd = view(directory);
    const entries = [];
    const names = new Set();
    let offset = 0;
    let totalCompressedBytes = 0;
    let totalUncompressedBytes = 0;
    let directoryCount = 0;
    let encryptedCount = 0;
    let symlinkCount = 0;
    let unsupportedCount = 0;
    let duplicateNameCount = 0;
    for (let index = 0; index < entryCount; index += 1) {
      checkAbort(options.signal);
      if (offset + 46 > directory.length || dd.getUint32(offset, true) !== 0x02014b50) {
        fail('malformed_directory', 'A ZIP central-directory entry is invalid. Compressed or encrypted central directories are unsupported.');
      }
      const nameSize = dd.getUint16(offset + 28, true);
      const extraSize = dd.getUint16(offset + 30, true);
      const commentSize = dd.getUint16(offset + 32, true);
      const next = offset + 46 + nameSize + extraSize + commentSize;
      if (next > directory.length) fail('truncated_directory', 'A ZIP central-directory entry is truncated.');
      const flags = dd.getUint16(offset + 8, true);
      const method = dd.getUint16(offset + 10, true);
      const rawName = directory.slice(offset + 46, offset + 46 + nameSize);
      const extra = extras(directory.subarray(offset + 46 + nameSize, offset + 46 + nameSize + extraSize));
      const decoded = decodeName(rawName, flags, extra);
      // Check both the original encoded path and an optional Unicode override.
      const original = decodeName(rawName, flags, new Map());
      safeName(original.name, maxPathDepth);
      const normalizedName = safeName(decoded.name, maxPathDepth);
      const values = {
        compressedSize: dd.getUint32(offset + 20, true), uncompressedSize: dd.getUint32(offset + 24, true),
        localHeaderOffset: dd.getUint32(offset + 42, true), disk: dd.getUint16(offset + 34, true)
      };
      const entryZip64 = zip64Fields(extra, values);
      zip64 = zip64 || entryZip64;
      if (values.disk !== 0) fail('multipart_unsupported', 'An entry references a different ZIP disk.');
      if (add(values.localHeaderOffset, 30, 'Local header end') > directoryOffset) fail('invalid_entry_offset', 'A local ZIP header overlaps or follows the central directory.');
      const versionMadeBy = dd.getUint16(offset + 4, true);
      const externalAttributes = dd.getUint32(offset + 38, true);
      const host = versionMadeBy >>> 8;
      const unixType = host === 3 || host === 19 ? ((externalAttributes >>> 16) & 0xf000) : 0;
      const isDirectory = normalizedName.endsWith('/') || (externalAttributes & 0x10) !== 0 || unixType === 0x4000;
      const symlink = unixType === 0xa000;
      const special = unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000 && !symlink;
      const encrypted = (flags & (1 | 0x40 | 0x2000)) !== 0 || method === 99;
      const unsupportedFlags = flags & ~(1 | 2 | 4 | 8 | 0x40 | 0x800 | 0x2000);
      const readable = !isDirectory && !symlink && !special && !encrypted && !unsupportedFlags && (method === 0 || method === 8);
      const entry = Object.freeze({
        index: index, name: decoded.name, normalizedName: normalizedName, filenameEncoding: decoded.encoding,
        rawNameBytes: rawName.slice(), compressedSize: values.compressedSize, uncompressedSize: values.uncompressedSize,
        crc32: dd.getUint32(offset + 16, true), method: method, flags: flags, encrypted: encrypted,
        directory: isDirectory, symlink: symlink, special: special, readable: readable,
        localHeaderOffset: values.localHeaderOffset, centralHeaderOffset: directoryOffset + offset,
        dataDescriptor: (flags & 8) !== 0, zip64: entryZip64,
        versionNeeded: dd.getUint16(offset + 6, true), versionMadeBy: versionMadeBy,
        externalAttributes: externalAttributes, modifiedDosTime: dd.getUint16(offset + 12, true),
        modifiedDosDate: dd.getUint16(offset + 14, true), extraFieldIds: Object.freeze(Array.from(extra.keys()))
      });
      registered.set(entry, { blob: blob, entry: entry, rawName: rawName, directoryOffset: directoryOffset, unsupportedFlags: unsupportedFlags });
      entries.push(entry);
      totalCompressedBytes = add(totalCompressedBytes, entry.compressedSize, 'Total compressed entry bytes');
      totalUncompressedBytes = add(totalUncompressedBytes, entry.uncompressedSize, 'Total uncompressed entry bytes');
      if (isDirectory) directoryCount += 1;
      if (encrypted) encryptedCount += 1;
      if (symlink) symlinkCount += 1;
      if (!isDirectory && !readable) unsupportedCount += 1;
      if (names.has(normalizedName)) duplicateNameCount += 1;
      names.add(normalizedName);
      offset = next;
    }
    if (offset < directory.length && offset + 6 <= directory.length && dd.getUint32(offset, true) === 0x05054b50) {
      const size = dd.getUint16(offset + 4, true);
      if (offset + 6 + size !== directory.length) fail('malformed_directory', 'The ZIP digital-signature record has an invalid size.');
      notes.push('The central directory contains a digital signature; this reader does not verify that signature.');
      offset += 6 + size;
    }
    if (offset !== directory.length) fail('malformed_directory', 'Unexpected bytes remain inside the declared ZIP central directory.');
    if (encryptedCount) notes.push(encryptedCount + ' encrypted entries were inventoried; their contents cannot be read by this module.');
    if (unsupportedCount) notes.push(unsupportedCount + ' non-directory entries cannot be extracted by this module (encryption, compression method, flags, or special file type).');
    if (duplicateNameCount) notes.push(duplicateNameCount + ' repeated entry names are retained separately by entry index.');
    notes.push('Entry sizes and CRC32 values come from the central directory. Content integrity is verified only for entries successfully read.');
    return Object.freeze({
      format: 'zip', size: blob.size, entryCount: entryCount, fileCount: entryCount - directoryCount,
      directoryCount: directoryCount, encryptedCount: encryptedCount, symlinkCount: symlinkCount,
      unsupportedCount: unsupportedCount, duplicateNameCount: duplicateNameCount,
      totalCompressedBytes: totalCompressedBytes, totalUncompressedBytes: totalUncompressedBytes,
      centralDirectoryOffset: directoryOffset, centralDirectoryBytes: directorySize, endRecordOffset: endOffset,
      zip64: zip64, entries: Object.freeze(entries), notes: Object.freeze(notes)
    });
  }

  async function readEntry(blob, entry, options) {
    options = options || {};
    checkBlob(blob);
    const state = registered.get(entry);
    if (!state || state.blob !== blob) fail('unrecognized_entry', 'Use the original entry object returned by listArchive for this same File or Blob.');
    checkAbort(options.signal);
    const maxOutput = limit(options, 'maxUncompressedBytes');
    const maxInput = limit(options, 'maxCompressedBytes');
    if (entry.encrypted) fail('encrypted_entry', 'Encrypted ZIP entries are not supported.', { name: entry.name });
    if (entry.directory) fail('directory_entry', 'A directory has no file contents to read.', { name: entry.name });
    if (entry.symlink || entry.special) fail('special_entry', 'Symlinks and special ZIP entries cannot be read as datasets.', { name: entry.name });
    if (state.unsupportedFlags) fail('unsupported_flags', 'This ZIP entry uses unsupported general-purpose flags.', { flags: entry.flags });
    if (entry.method !== 0 && entry.method !== 8) fail('unsupported_compression', 'Only stored (0) and deflate (8) ZIP entries can be read.', { method: entry.method });
    if (entry.uncompressedSize > maxOutput) fail('entry_size_limit', 'The entry exceeds the configured uncompressed-byte limit.', { actual: entry.uncompressedSize, limit: maxOutput, name: entry.name });
    if (entry.compressedSize > maxInput) fail('compressed_size_limit', 'The entry exceeds the configured compressed-byte limit.', { actual: entry.compressedSize, limit: maxInput, name: entry.name });
    if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize) fail('size_mismatch', 'A stored ZIP entry has unequal compressed and uncompressed sizes.');
    const local = await bytesAt(blob, entry.localHeaderOffset, 30, options.signal);
    const ld = view(local);
    if (ld.getUint32(0, true) !== 0x04034b50) fail('invalid_local_header', 'The local ZIP file-header signature is invalid.');
    if (ld.getUint16(6, true) !== entry.flags || ld.getUint16(8, true) !== entry.method) {
      fail('header_mismatch', 'Local and central ZIP compression metadata disagree.');
    }
    const nameSize = ld.getUint16(26, true);
    const extraSize = ld.getUint16(28, true);
    const dataStart = add(entry.localHeaderOffset, 30 + nameSize + extraSize, 'Entry data start');
    const dataEnd = add(dataStart, entry.compressedSize, 'Entry data end');
    if (dataEnd > state.directoryOffset) fail('invalid_entry_offset', 'ZIP entry data extends into or beyond the central directory.');
    const fields = await bytesAt(blob, entry.localHeaderOffset + 30, nameSize + extraSize, options.signal);
    if (!sameBytes(fields.subarray(0, nameSize), state.rawName)) fail('header_mismatch', 'Local and central ZIP filenames disagree.');
    const localExtra = extras(fields.subarray(nameSize));
    if (!entry.dataDescriptor) {
      const localValues = {
        compressedSize: ld.getUint32(18, true), uncompressedSize: ld.getUint32(22, true),
        localHeaderOffset: 0, disk: 0
      };
      zip64Fields(localExtra, localValues);
      if (ld.getUint32(14, true) !== entry.crc32 || localValues.compressedSize !== entry.compressedSize || localValues.uncompressedSize !== entry.uncompressedSize) {
        fail('header_mismatch', 'Local and central ZIP sizes or checksums disagree.');
      }
    }
    const part = blob.slice(dataStart, dataEnd);
    if (!part || typeof part.stream !== 'function') fail('stream_unavailable', 'This browser must support Blob.stream() to read ZIP entries.');
    let stream = part.stream();
    if (entry.method === 8) {
      let decompressor;
      try {
        if (typeof DecompressionStream !== 'function') throw new Error('Unavailable');
        decompressor = new DecompressionStream('deflate-raw');
      } catch (_) {
        fail('decompression_unavailable', 'This runtime does not support DecompressionStream("deflate-raw").');
      }
      stream = stream.pipeThrough(decompressor);
    }
    let output;
    try { output = new Uint8Array(entry.uncompressedSize); }
    catch (_) { fail('allocation_limit', 'The runtime could not allocate this entry. Use a smaller member or a lower extraction limit.'); }
    const reader = stream.getReader();
    let offset = 0;
    let crc = 0xffffffff;
    let cancelled = false;
    const onAbort = function () { cancelled = true; reader.cancel().catch(function () {}); };
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        checkAbort(options.signal);
        const result = await reader.read();
        checkAbort(options.signal);
        if (result.done) break;
        const chunk = result.value;
        if (!(chunk instanceof Uint8Array)) fail('invalid_stream', 'The ZIP stream returned non-byte content.');
        if (offset + chunk.byteLength > output.length || offset + chunk.byteLength > maxOutput) {
          fail('size_mismatch', 'ZIP output exceeds its declared size or the extraction limit.');
        }
        output.set(chunk, offset);
        offset += chunk.byteLength;
        crc = crcUpdate(crc, chunk);
      }
      if (offset !== entry.uncompressedSize) fail('size_mismatch', 'ZIP output does not match the declared uncompressed size.');
      if (((crc ^ 0xffffffff) >>> 0) !== entry.crc32) fail('crc_mismatch', 'ZIP entry CRC32 verification failed.', { name: entry.name });
      return output;
    } catch (error) {
      if (!cancelled) { try { await reader.cancel(error); } catch (_) {} }
      if (error instanceof ZipError) throw error;
      fail('decompression_failed', 'The ZIP entry could not be decompressed or read.', { name: entry.name });
    } finally {
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }

  return Object.freeze({ version: '1.0.0', defaults: DEFAULTS, ZipError: ZipError, listArchive: listArchive, readEntry: readEntry });
});
