/* Terraviva harvest-file normalization. Runs unchanged in the browser and Node.
 * prepare is pure and synchronous; commit clones the supplied state.
 * A server must prepare again using its authenticated farm, not trust a client plan.
 * Fingerprints identify data; they are not anonymisation or access credentials.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TerraImport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = 1;
  const MAX_ROWS = 1000;
  const MAX_TONNES = 100000;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const present = (o, k) => own(o, k) && o[k] !== null && o[k] !== undefined && o[k] !== '';
  const units = new Map([['t', 1], ['tonne', 1], ['tonnes', 1], ['kg', 0.001], ['kilogram', 0.001], ['kilograms', 0.001]]);
  const knownColumns = new Set(['id', 'product', 'volume', 'quantity', 'unit', 'field', 'date', 'farm', 'farm_id', 'source', 'importMeta', 'importedAt']);

  function fail(message, issues = [], code = 'INVALID_IMPORT') {
    const error = new Error(message);
    error.name = 'HarvestImportError';
    error.status = 400;
    error.code = code;
    error.issues = issues;
    return error;
  }

  function text(value, name, max) {
    if (typeof value !== 'string') throw new Error(name + ' must be text.');
    const result = value.normalize('NFC').trim();
    if (!result || result.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(result)) {
      throw new Error(name + ' must contain 1–' + max + ' printable characters.');
    }
    return result;
  }

  function decimal(value, label) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error(label + ' must be finite.');
      return value;
    }
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())) {
      throw new Error(label + ' must be a plain decimal using a period, with no commas, thousands separators or exponent notation.');
    }
    const n = Number(value.trim());
    if (!Number.isFinite(n)) throw new Error(label + ' must be finite.');
    return n;
  }

  function isoDate(value) {
    if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('date must be a real YYYY-MM-DD date; no date is supplied automatically.');
    }
    const stamp = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) {
      throw new Error('date must be a real calendar date.');
    }
    return value;
  }

  function originalId(row) {
    if (!present(row, 'id')) return null;
    if (typeof row.id === 'number') {
      if (!Number.isSafeInteger(row.id)) throw new Error('id must be text or a safe integer; large identifiers must remain strings.');
      return String(row.id);
    }
    return text(row.id, 'id', 200);
  }

  function options(value) {
    if (!value || typeof value !== 'object') throw fail('Farm and file provenance are required.');
    try {
      return {
        farm: text(value.farm, 'farm', 80),
        sourceName: text(value.sourceName, 'sourceName', 160),
        sourceKind: text(value.sourceKind || 'file', 'sourceKind', 40).toLowerCase()
      };
    } catch (error) { throw fail(error.message); }
  }

  function normalize(row, context) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Each row must be an object.');
    for (const key of ['farm', 'farm_id']) {
      if (own(row, key) && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
        if (typeof row[key] !== 'string' || row[key].normalize('NFC').trim() !== context.farm) {
          throw new Error(key + ' does not match the selected farm. Split files by farm before importing.');
        }
      }
    }
    if (row.importMeta && typeof row.importMeta === 'object' && own(row.importMeta, 'farm')) {
      if (typeof row.importMeta.farm !== 'string' || row.importMeta.farm.normalize('NFC').trim() !== context.farm) {
        throw new Error('The original import farm does not match the selected farm.');
      }
    }
    const product = text(row.product, 'product', 120).replace(/\s+/gu, ' ').toLowerCase();
    const field = text(row.field, 'field', 160).replace(/\s+/gu, ' ');
    const date = isoDate(row.date);
    const hasVolume = present(row, 'volume'), hasQuantity = present(row, 'quantity');
    if (hasVolume === hasQuantity) throw new Error('Provide volume (canonical tonnes) OR quantity with an explicit unit, never both.');
    let volume, raw, unit;
    if (hasVolume) {
      raw = typeof row.volume === 'string' ? row.volume.trim() : row.volume;
      unit = present(row, 'unit') ? text(row.unit, 'unit', 30).toLowerCase() : 't';
      if (units.get(unit) !== 1) throw new Error('volume is already tonnes; use quantity + unit for kg. The ambiguous unit "tons" is not accepted.');
      volume = decimal(raw, 'volume');
    } else {
      raw = typeof row.quantity === 'string' ? row.quantity.trim() : row.quantity;
      unit = text(row.unit, 'unit', 30).toLowerCase();
      if (!units.has(unit)) throw new Error('unit must be kg/kilogram(s) or t/tonne(s). The ambiguous unit "tons" is not accepted.');
      const amount = decimal(raw, 'quantity');
      volume = units.get(unit) === 1 ? amount : amount / 1000;
    }
    if (!Number.isFinite(volume) || volume <= 0 || volume > MAX_TONNES) {
      throw new Error('Normalized harvest mass must be above zero and at most 100000 tonnes.');
    }
    return { product, volume, field, date, originalId: originalId(row), originalQuantity: raw, originalUnit: unit };
  }

  // FIPS 180-4 SHA-256 arithmetic over UTF-8. No dependency, network or platform
  // crypto API is needed by the synchronous browser preview. Verified against
  // Node crypto in the accompanying tests, including Unicode and long payloads.
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  const rot = (n, bits) => (n >>> bits) | (n << (32 - bits));
  function sha256(value) {
    const input = new TextEncoder().encode(value);
    const length = Math.ceil((input.length + 9) / 64) * 64;
    const buffer = new Uint8Array(length);
    buffer.set(input); buffer[input.length] = 0x80;
    const view = new DataView(buffer.buffer);
    view.setUint32(length - 8, Math.floor(input.length / 0x20000000));
    view.setUint32(length - 4, (input.length * 8) >>> 0);
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64);
    for (let offset = 0; offset < length; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = w[i - 15], b = w[i - 2];
        const s0 = rot(a, 7) ^ rot(a, 18) ^ (a >>> 3);
        const s1 = rot(b, 17) ^ rot(b, 19) ^ (b >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
        const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, h].forEach((n, i) => { H[i] = (H[i] + n) >>> 0; });
    }
    return H.map(n => n.toString(16).padStart(8, '0')).join('');
  }

  function contentKey(record, farm) {
    // Field case is preserved: distinct field labels are not silently merged.
    return JSON.stringify(['terraviva-harvest-v1', farm, record.product, record.volume, record.field, record.date]);
  }

  function buildRecord(normal, context) {
    const contentFingerprint = sha256(contentKey(normal, context.farm));
    const identity = normal.originalId === null
      ? ['terraviva-idless-v1', context.farm, contentFingerprint]
      : ['terraviva-source-id-v1', context.farm, context.sourceKind, context.sourceName, normal.originalId];
    const identityFingerprint = sha256(JSON.stringify(identity));
    return {
      id: 'import-' + identityFingerprint,
      product: normal.product, volume: normal.volume, field: normal.field, date: normal.date,
      source: 'file import • ' + context.sourceName,
      importMeta: {
        version: VERSION, ...context, originalId: normal.originalId,
        contentFingerprint, identityFingerprint,
        originalQuantity: normal.originalQuantity, originalUnit: normal.originalUnit
      }
    };
  }

  function planFingerprint(records, context) {
    return sha256(JSON.stringify(['terraviva-plan-v1', context.farm, context.sourceKind, context.sourceName,
      records.map(r => [r.id, r.importMeta.contentFingerprint]).sort((a, b) => a[0].localeCompare(b[0]))]));
  }

  function prepare(rows, suppliedOptions) {
    const context = options(suppliedOptions);
    if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) {
      throw fail('Import requires 1–' + MAX_ROWS + ' harvest rows.');
    }
    const issues = [], records = [], byIdentity = new Map(), byContent = new Map();
    const ignored = new Set(), warnings = [];
    let duplicatesInFile = 0, sharedMeasurements = 0;
    rows.forEach((row, index) => {
      const rowNumber = index + 1;
      try {
        const record = buildRecord(normalize(row, context), context);
        Object.keys(row).forEach(k => { if (!knownColumns.has(k)) ignored.add(k); });
        const previous = byIdentity.get(record.id);
        if (previous) {
          if (previous.importMeta.contentFingerprint !== record.importMeta.contentFingerprint) {
            throw new Error('The same source id has different measurements. Corrections require reconciliation; this import will not overwrite records.');
          }
          duplicatesInFile++;
          return;
        }
        const sameContent = byContent.get(record.importMeta.contentFingerprint) || [];
        if (sameContent.length && (record.importMeta.originalId === null || sameContent.some(r => r.importMeta.originalId === null))) {
          throw new Error('Identical measurements mix rows with and without source ids. Supply consistent ids to distinguish separate loads.');
        }
        if (sameContent.length) sharedMeasurements++;
        byIdentity.set(record.id, record);
        sameContent.push(record); byContent.set(record.importMeta.contentFingerprint, sameContent);
        records.push(record);
      } catch (error) {
        issues.push({ row: rowNumber, field: 'row', message: error.message });
      }
    });
    if (issues.length) throw fail('Import cancelled: ' + issues.length + ' invalid row(s). No records were saved. ' + issues[0].message, issues);
    if (ignored.size) warnings.push('Extra columns are not stored: ' + [...ignored].sort().join(', ') + '.');
    if (rows.some(r => own(r, 'source') || own(r, 'importMeta') || own(r, 'importedAt'))) {
      warnings.push('Source labels and import metadata from the file are not trusted; this import records its own file provenance.');
    }
    if (duplicatesInFile) warnings.push(duplicatesInFile + ' repeated row(s) with the same import identity are omitted within this file.');
    if (sharedMeasurements) warnings.push(sharedMeasurements + ' additional row(s) share measurements but have distinct source ids; they are retained as separate loads.');
    if (records.some(r => r.importMeta.originalId === null)) {
      warnings.push('Rows without source ids use exact normalized content for repeat detection. Separate loads with identical measurements require distinct source ids.');
    }
    return {
      version: VERSION, ...context, inputRows: rows.length, records, duplicatesInFile, warnings,
      fingerprint: planFingerprint(records, context),
      totalTonnes: records.reduce((sum, r) => sum + r.volume, 0)
    };
  }

  function checkedPlan(plan) {
    if (!plan || plan.version !== VERSION || !Array.isArray(plan.records) || !Array.isArray(plan.warnings)
      || !Number.isInteger(plan.inputRows) || plan.inputRows < 1 || plan.inputRows > MAX_ROWS
      || !Number.isInteger(plan.duplicatesInFile) || plan.duplicatesInFile < 0
      || plan.records.length + plan.duplicatesInFile !== plan.inputRows) {
      throw fail('Invalid import plan. Preview the file again.');
    }
    const rows = plan.records.map(r => {
      if (!r || !r.importMeta) throw fail('Invalid import provenance. Preview the file again.');
      return {
        product: r.product, volume: r.volume, field: r.field, date: r.date,
        ...(r.importMeta.originalId !== null ? { id: r.importMeta.originalId } : {})
      };
    });
    const rebuilt = prepare(rows, plan);
    if (rebuilt.fingerprint !== plan.fingerprint || rebuilt.records.length !== plan.records.length) {
      throw fail('The import plan changed after preparation. Preview the file again.');
    }
    rebuilt.records.forEach((record, i) => {
      const raw = plan.records[i].importMeta;
      const normalizedOriginal = normalize({
        product: record.product, field: record.field, date: record.date,
        quantity: raw.originalQuantity, unit: raw.originalUnit
      }, plan);
      if (normalizedOriginal.volume !== record.volume) throw fail('Import quantity provenance does not match the normalized mass.');
      record.importMeta.originalQuantity = raw.originalQuantity;
      record.importMeta.originalUnit = raw.originalUnit;
    });
    return { ...rebuilt, inputRows: plan.inputRows, duplicatesInFile: plan.duplicatesInFile, warnings: [...new Set(plan.warnings.map(String))] };
  }

  function commit(state, suppliedPlan, now = Date.now()) {
    const plan = checkedPlan(suppliedPlan);
    if (!state || !Array.isArray(state.records) || !Array.isArray(state.events)) throw fail('Invalid depot state.');
    if (own(state, 'farm') && state.farm !== plan.farm) throw fail('Import farm does not match the depot.');
    if (typeof now !== 'number' || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw fail('Invalid import timestamp.');
    const timestamp = new Date(now).toISOString();
    const byId = new Map(), byContent = new Map(), issues = [], warnings = [...plan.warnings];
    for (let index = 0; index < state.records.length; index++) {
      const record = state.records[index];
      if (record.importMeta && record.importMeta.farm !== plan.farm) throw fail('Existing import belongs to a different farm.');
      let normal;
      try { normal = normalize({ product: record.product, volume: record.volume, field: record.field, date: record.date }, plan); }
      catch (error) { throw fail('Existing depot row ' + (index + 1) + ' is invalid. Reconcile it before importing: ' + error.message); }
      const fingerprint = sha256(contentKey(normal, plan.farm));
      const entry = { record, fingerprint, named: record.importMeta ? record.importMeta.originalId !== null : present(record, 'id') };
      if (present(record, 'id')) {
        const previous = byId.get(String(record.id));
        if (previous && previous.fingerprint !== fingerprint) throw fail('Existing records reuse an id with different content. Reconcile the depot before importing.');
        byId.set(String(record.id), entry);
      }
      const same = byContent.get(fingerprint) || []; same.push(entry); byContent.set(fingerprint, same);
    }
    const additions = [];
    let skipped = plan.duplicatesInFile, sharedMeasurements = 0;
    plan.records.forEach((record, index) => {
      const meta = record.importMeta;
      // Original exported depot IDs can refer directly to existing SMS/import rows.
      const direct = byId.get(record.id) || (meta.originalId !== null ? byId.get(meta.originalId) : null);
      if (direct) {
        if (direct.fingerprint !== meta.contentFingerprint) {
          issues.push({ row: index + 1, field: 'id', message: 'An existing record has this id but different measurements. Import does not overwrite records.' });
        } else skipped++;
        return;
      }
      const same = byContent.get(meta.contentFingerprint) || [];
      if (same.length) {
        if (meta.originalId === null && same.every(e => !e.named)) { skipped++; return; }
        if (meta.originalId === null || same.some(e => !e.named)) {
          issues.push({ row: index + 1, field: 'id', message: 'Matching measurements mix identified and unidentified loads. Supply the existing record id, or reconcile the records before importing.' });
          return;
        }
        sharedMeasurements++;
      }
      additions.push({ ...record, importedAt: timestamp });
    });
    if (issues.length) throw fail('Import cancelled: ' + issues.length + ' identity conflict(s). No records were saved. ' + issues[0].message, issues, 'IMPORT_CONFLICT');
    if (sharedMeasurements) warnings.push(sharedMeasurements + ' new record(s) match existing measurements but have different source ids; retained as separate loads.');
    const next = structuredClone(state);
    next.records.push(...additions);
    const summary = 'Imported ' + additions.length + ' harvest record(s); skipped ' + skipped + ' repeated row(s).';
    if (additions.length) next.events.unshift({ time: timestamp, text: summary + ' File: ' + plan.sourceName + '.' });
    return { state: next, added: additions.length, skipped, duplicatesInFile: plan.duplicatesInFile, warnings: [...new Set(warnings)], summary };
  }

  return { prepare, commit, VERSION, MAX_ROWS, MAX_TONNES };
});
