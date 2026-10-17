'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const modulePath = fs.existsSync(path.join(__dirname, 'harvest-import.js'))
  ? path.join(__dirname, 'harvest-import.js') : path.join(__dirname, '../public/harvest-import.js');
const Import = require(modulePath);
const now = Date.parse('2026-10-17T10:00:00Z');
const opts = { farm: 'test-farm', sourceName: 'synthetic-test.csv', sourceKind: 'dataset' };
const row = (overrides = {}) => ({ product: 'wheat', volume: 2, field: 'North', date: '2026-10-16', ...overrides });
const empty = () => ({ records: [], grants: [], commercial: false, pending: null, processed: {}, events: [] });

test('strict normalization converts kg, preserves historical dates, Unicode and file provenance', () => {
  const input = { id: 'batch-1', product: '  MaÍz   dulce ', quantity: '1250.50', unit: 'kg', field: '  Río  norte ', date: '2024-02-29' };
  const original = structuredClone(input);
  const plan = Import.prepare([input], opts);
  assert.equal(plan.totalTonnes, 1.2505);
  assert.equal(plan.records[0].product, 'maíz dulce');
  assert.equal(plan.records[0].field, 'Río norte');
  assert.equal(plan.records[0].date, '2024-02-29');
  assert.equal(plan.records[0].source, 'file import • synthetic-test.csv');
  assert.equal(plan.records[0].importMeta.originalId, 'batch-1');
  assert.equal(plan.records[0].importMeta.originalQuantity, '1250.50');
  assert.equal(plan.records[0].importMeta.originalUnit, 'kg');
  assert.equal(plan.records[0].importedAt, undefined);
  assert.deepEqual(input, original);
  const result = Import.commit(empty(), plan, now);
  assert.equal(result.state.records[0].importedAt, new Date(now).toISOString());
  assert.equal(result.state.records[0].importMeta.originalUnit, 'kg');
});

test('one invalid row rejects the whole plan; no date or zero-mass default is invented', () => {
  for (const bad of [
    row({ date: undefined }), row({ date: '2026-02-29' }), row({ date: '2026-04-31' }),
    row({ date: '0000-01-01' }), row({ date: '2026-1-1' }), row({ date: '2026-10-16T10:00:00Z' }),
    row({ volume: 0 }), row({ volume: -1 }), row({ volume: Infinity }), row({ volume: NaN }),
    row({ volume: null }), row({ product: '' }), row({ field: '   ' })
  ]) {
    assert.throws(() => Import.prepare([row(), bad], opts), error => error.status === 400 && error.issues[0].row === 2);
  }
});

test('decimal strings reject comma/thousands/exponent syntax, ambiguity and unsafe IDs', () => {
  for (const volume of ['1,250', '1 250', '1e3', '0x10', 'Infinity', 'NaN', '01', '.5', '2.']) {
    assert.throws(() => Import.prepare([row({ volume })], opts));
  }
  for (const bad of [
    { product: 'wheat', quantity: 1, field: 'North', date: '2026-01-01' },
    row({ unit: 'kg' }), row({ unit: 'tons' }), row({ quantity: 2, unit: 't' }),
    { product: 'wheat', quantity: 2, unit: 'tons', field: 'North', date: '2026-01-01' },
    row({ id: Number.MAX_SAFE_INTEGER + 1 })
  ]) assert.throws(() => Import.prepare([bad], opts));
  assert.equal(Import.prepare([row({ id: 0 })], opts).records[0].importMeta.originalId, '0');
});

test('the declared mass bound applies after normalization and accepts small valid quantities', () => {
  assert.equal(Import.prepare([row({ volume: 100000 })], opts).totalTonnes, 100000);
  assert.throws(() => Import.prepare([row({ volume: 100000.001 })], opts));
  const quantity = { product: 'wheat', quantity: 100000000, unit: 'kg', field: 'North', date: '2026-01-01' };
  assert.equal(Import.prepare([quantity], opts).totalTonnes, 100000);
  assert.throws(() => Import.prepare([{ ...quantity, quantity: 100000001 }], opts));
  assert.equal(Import.prepare([{ ...quantity, quantity: 1 }], opts).totalTonnes, 0.001);
});

test('farm claims and existing depot scope cannot cross the selected identity', () => {
  assert.equal(Import.prepare([row()], { ...opts, farm: 'Demo farm' }).farm, 'Demo farm');
  for (const claim of [{ farm: 'another' }, { farm_id: 'another' }, { importMeta: { farm: 'another' } }]) {
    assert.throws(() => Import.prepare([row(claim)], opts), /match/);
  }
  assert.doesNotThrow(() => Import.prepare([row({ farm: opts.farm, farm_id: opts.farm })], opts));
  const plan = Import.prepare([row()], opts);
  assert.throws(() => Import.commit({ ...empty(), farm: 'another' }, plan, now), /match/);
  const saved = Import.commit(empty(), plan, now).state;
  const otherPlan = Import.prepare([row()], { ...opts, farm: 'another' });
  assert.notEqual(plan.records[0].id, otherPlan.records[0].id);
  assert.throws(() => Import.commit(saved, otherPlan, now), /different farm/);
});

test('import cannot enable commercial use, grant access, replace replay state or cancel pending action', () => {
  const state = empty();
  state.grants = [{ id: 'g', revoked: false, fields: ['volume'] }];
  state.pending = { kind: 'harvest', expires: now + 5000, record: { volume: 5 } };
  state.processed = { sms1: 'Pending confirmation' };
  state.events = [{ text: 'Before import', time: '2026-10-17T09:00:00Z' }];
  state.extension = { any: 'preserved' };
  const before = structuredClone(state);
  const input = row({ commercial: true, grants: [{ recipient: 'untrusted' }], source: 'verified SMS', importedAt: '1900-01-01' });
  const plan = Import.prepare([input], opts);
  assert(plan.warnings.some(x => x.includes('commercial')));
  const result = Import.commit(state, plan, now);
  assert.deepEqual(state, before);
  for (const key of ['grants', 'commercial', 'pending', 'processed', 'extension']) assert.deepEqual(result.state[key], state[key]);
  assert.equal(result.state.records[0].commercial, undefined);
  assert.equal(result.state.records[0].grants, undefined);
  assert.equal(result.state.records[0].source, 'file import • synthetic-test.csv');
  assert.equal(result.state.events.length, 2);
});

test('same explicit id and content skips within file and on reimport without adding audit noise', () => {
  const source = row({ id: 'load-1' });
  const plan = Import.prepare([source, source], opts);
  assert.equal(plan.records.length, 1);
  assert.equal(plan.duplicatesInFile, 1);
  const first = Import.commit(empty(), plan, now);
  assert.equal(first.added, 1);
  assert.equal(first.skipped, 1);
  const second = Import.commit(first.state, plan, now + 10);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 2);
  assert.deepEqual(second.state, first.state);
});

test('id-less repeat detection is content scoped and survives renamed files and row order', () => {
  const a = row(), b = row({ date: '2026-10-15', volume: 3 });
  const firstPlan = Import.prepare([a, b, a], opts);
  assert.equal(firstPlan.duplicatesInFile, 1);
  const first = Import.commit(empty(), firstPlan, now);
  const secondPlan = Import.prepare([b, a], { ...opts, sourceName: 'renamed.csv' });
  const second = Import.commit(first.state, secondPlan, now + 100);
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 2);
  assert.deepEqual(second.state, first.state);
  assert.equal(Import.prepare([a, b], opts).fingerprint, Import.prepare([b, a], opts).fingerprint);
});

test('different explicit ids with identical measurements are retained with a visible warning', () => {
  const plan = Import.prepare([row({ id: 'load-1' }), row({ id: 'load-2' })], opts);
  assert.equal(plan.records.length, 2);
  assert(plan.warnings.some(x => x.includes('distinct source ids')));
  const first = Import.commit(empty(), plan, now);
  assert.equal(first.added, 2);
  const next = Import.commit(first.state, Import.prepare([row({ id: 'load-3' })], opts), now);
  assert.equal(next.added, 1);
  assert(next.warnings.some(x => x.includes('different source ids')));
});

test('explicit identity namespaces are source-specific, and renamed sources are not silently merged', () => {
  const firstPlan = Import.prepare([row({ id: 'load-1' })], opts);
  const secondPlan = Import.prepare([row({ id: 'load-1' })], { ...opts, sourceName: 'different-export.csv' });
  assert.notEqual(firstPlan.records[0].id, secondPlan.records[0].id);
  const result = Import.commit(Import.commit(empty(), firstPlan, now).state, secondPlan, now);
  assert.equal(result.added, 1);
  assert(result.warnings.some(x => x.includes('different source ids')));
});

test('same source id with changed measurements rejects whole batch without mutation', () => {
  assert.throws(() => Import.prepare([row({ id: 'load-1' }), row({ id: 'load-1', volume: 3 })], opts), /same source id/);
  const state = Import.commit(empty(), Import.prepare([row({ id: 'load-1' })], opts), now).state;
  const before = structuredClone(state);
  const plan = Import.prepare([row({ id: 'new', volume: 20 }), row({ id: 'load-1', volume: 3 })], opts);
  assert.throws(() => Import.commit(state, plan, now), error => error.code === 'IMPORT_CONFLICT');
  assert.deepEqual(state, before);
});

test('identified and unidentified matching loads require explicit reconciliation', () => {
  assert.throws(() => Import.prepare([row(), row({ id: 'batch' })], opts), /consistent ids/);
  const state = Import.commit(empty(), Import.prepare([row({ id: 'batch' })], opts), now).state;
  assert.throws(() => Import.commit(state, Import.prepare([row()], opts), now), /Matching measurements/);
  const idless = Import.commit(empty(), Import.prepare([row()], opts), now).state;
  assert.throws(() => Import.commit(idless, Import.prepare([row({ id: 'batch' })], opts), now), /Matching measurements/);
});

test('exported existing depot IDs identify original SMS/import records; changed content never overwrites', () => {
  const smsState = empty();
  smsState.records.push({ ...row(), id: 'record-test-sms', source: 'farmer-confirmed SMS' });
  const replay = Import.commit(smsState, Import.prepare(smsState.records, opts), now);
  assert.equal(replay.added, 0);
  assert.equal(replay.skipped, 1);
  const altered = Import.prepare([row({ id: 'record-test-sms', volume: 4 })], opts);
  assert.throws(() => Import.commit(smsState, altered, now), /different measurements/);
  const imported = Import.commit(empty(), Import.prepare([row({ id: 'batch' })], opts), now).state;
  const exportedPlan = Import.prepare(imported.records, { ...opts, sourceName: 'terraviva-records.json' });
  assert.equal(Import.commit(imported, exportedPlan, now).added, 0);
});

test('prepared-plan integrity detects modified mass and inconsistent unit provenance', () => {
  const plan = Import.prepare([row()], opts);
  const tampered = structuredClone(plan);
  tampered.records[0].volume = 9;
  assert.throws(() => Import.commit(empty(), tampered, now), /changed/);
  const wrongUnit = structuredClone(plan);
  wrongUnit.records[0].importMeta.originalUnit = 'kg';
  assert.throws(() => Import.commit(empty(), wrongUnit, now), /provenance/);
  assert.throws(() => Import.commit(empty(), plan, Infinity), /timestamp/);
});

test('SHA-256 content fingerprints agree with Node crypto for Unicode and block boundaries', () => {
  for (let size = 1; size <= 120; size++) {
    const record = row({ product: 'ñ'.repeat(size) });
    const plan = Import.prepare([record], opts);
    const content = JSON.stringify(['terraviva-harvest-v1', opts.farm, record.product, record.volume, record.field, record.date]);
    assert.equal(plan.records[0].importMeta.contentFingerprint, crypto.createHash('sha256').update(content).digest('hex'));
  }
});

test('limits are enforced and a 1000-row plan remains atomic and deterministic', () => {
  assert.throws(() => Import.prepare([], opts));
  assert.throws(() => Import.prepare(Array(1001).fill(row()), opts));
  const data = Array.from({ length: 1000 }, (_, i) => row({ id: 'load-' + i, volume: i + 1 }));
  const plan = Import.prepare(data, opts);
  assert.equal(plan.records.length, 1000);
  const expected = crypto.createHash('sha256').update(JSON.stringify(['terraviva-plan-v1', opts.farm, opts.sourceKind, opts.sourceName,
    plan.records.map(r => [r.id, r.importMeta.contentFingerprint]).sort((a, b) => a[0].localeCompare(b[0]))])).digest('hex');
  assert.equal(plan.fingerprint, expected);
  const result = Import.commit(empty(), plan, now);
  assert.equal(result.added, 1000);
  assert.equal(result.state.records.length, 1000);
  assert.equal(Import.commit(result.state, plan, now).added, 0);
});

test('browser global API matches CommonJS without network or environment dependencies', () => {
  const sandbox = { TextEncoder, structuredClone };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(modulePath, 'utf8'), sandbox);
  assert.equal(typeof sandbox.TerraImport.prepare, 'function');
  const browserPlan = sandbox.TerraImport.prepare([row()], opts);
  assert.equal(browserPlan.fingerprint, Import.prepare([row()], opts).fingerprint);
  assert.equal(sandbox.TerraImport.commit(empty(), browserPlan, now).added, 1);
});
