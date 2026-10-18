/* Terraviva EDA — dependency-free, local-memory data profiling.
 * No fetch, storage, uploads, telemetry, implicit consent, or DOM mutation.
 * The source records are retained separately from flattened profiling rows.
 * All rows are profiled; limits reject a file rather than sample/truncate it.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TerravivaEDA = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var VERSION = '1.0.0';
  var LIMITS = Object.freeze({
    maxFileBytes: 20 * 1024 * 1024,
    maxRows: 100000,
    maxColumns: 250,
    maxCells: 2000000,
    maxTables: 32,
    maxFlattenDepth: 5,
    maxJSONDepth: 100,
    maxJSONNodes: 2000000,
    maxNumericPairColumns: 24,
    maxDisplayedFrequencies: 20,
    previewRows: 12
  });
  var OWN = Object.prototype.hasOwnProperty;
  var DAY = 86400000;
  var NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  var ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var YMD_DATE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
  var ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([Zz]|[+-]\d{2}:?\d{2})?$/;

  function fail(code, message, details) {
    var e = new Error(message);
    e.name = 'TerravivaEDAError';
    e.code = code;
    if (details !== undefined) e.details = details;
    throw e;
  }
  function issue(code, message, extra, severity) {
    return Object.assign({ code: code, severity: severity || 'warning', message: message }, extra || {});
  }
  function dict() { return Object.create(null); }
  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date); }
  function isMissing(v) { return v === null || v === undefined || (typeof v === 'string' && v.trim() === ''); }
  function pct(n, d) { return d ? n / d * 100 : 0; }
  function finite(v) { return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : null; }
  function utf8Bytes(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).byteLength;
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 128) n++;
      else if (c < 2048) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  function checkText(text, options) {
    if (typeof text !== 'string') fail('text_required', 'The file must be supplied as text.');
    var n = utf8Bytes(text);
    if (n > LIMITS.maxFileBytes || (options && options.sizeBytes > LIMITS.maxFileBytes))
      fail('file_limit', 'This local profiler accepts files up to 20 MiB. No rows have been sampled or imported.');
    return n;
  }
  function pointer(path) { return path.length ? '/' + path.map(function (s) { return String(s).replace(/~/g, '~0').replace(/\//g, '~1'); }).join('/') : ''; }
  function getPath(row, path) {
    var value = row;
    if (typeof path === 'string') path = path === '' ? [] : path.replace(/^\//, '').split('/').map(function (s) { return s.replace(/~1/g, '/').replace(/~0/g, '~'); });
    for (var i = 0; i < path.length; i++) {
      if (value === null || value === undefined || !OWN.call(Object(value), path[i])) return undefined;
      value = value[path[i]];
    }
    return value;
  }
  function readablePath(path) {
    if (!path.length) return '(value)';
    return path.map(function (part, i) {
      return /^[A-Za-z_$][\w$]*$/.test(part) ? (i ? '.' : '') + part : '[' + JSON.stringify(part) + ']';
    }).join('');
  }

  // A type-tagged, order-independent object encoding. Array order is retained.
  // It deliberately distinguishes strings from numbers and absent keys from null.
  function stableKey(value, seen) {
    if (value === undefined) return 'u';
    if (value === null) return 'z';
    var t = typeof value;
    if (t === 'string') return 's' + JSON.stringify(value);
    if (t === 'boolean') return value ? 'b1' : 'b0';
    if (t === 'number') return 'n' + (Object.is(value, -0) ? '0' : String(value));
    if (t === 'bigint') return 'i' + String(value);
    if (value instanceof Date) return 'd' + String(value.getTime());
    if (t !== 'object') return t + ':' + String(value);
    seen = seen || new Set();
    if (seen.has(value)) fail('circular_record', 'Circular JavaScript records cannot be profiled.');
    seen.add(value);
    var result;
    if (Array.isArray(value)) result = 'a[' + value.map(function (v) { return stableKey(v, seen); }).join(',') + ']';
    else result = 'o{' + Object.keys(value).sort().map(function (k) { return JSON.stringify(k) + ':' + stableKey(value[k], seen); }).join(',') + '}';
    seen.delete(value);
    return result;
  }
  function displayValue(v) {
    if (v === undefined) return '(absent)';
    if (v === null) return 'null';
    if (typeof v === 'string') return v;
    if (typeof v !== 'object') return String(v);
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }

  // Delimiter assessment considers every logical record, outside quoted fields.
  // A close tie is surfaced to the caller instead of silently guessing.
  function detectDelimiter(text) {
    var candidates = [',', ';', '\t'];
    var records = [], counts = [0, 0, 0], quoted = false, hasContent = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (c === '"') {
        hasContent = true;
        if (quoted && text[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (!quoted && (c === '\n' || c === '\r')) {
        if (hasContent) records.push(counts);
        counts = [0, 0, 0]; hasContent = false;
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else {
        if (!quoted) { var d = candidates.indexOf(c); if (d >= 0) counts[d]++; }
        hasContent = true;
      }
      if (records.length > LIMITS.maxRows + 1) fail('row_limit', 'The file exceeds 100,000 data rows. No rows have been sampled or imported.');
    }
    if (hasContent) records.push(counts);
    if (!records.length) return { delimiter: ',', confidence: 'single-column', candidates: [] };
    var scored = candidates.map(function (d, j) {
      var headerWidth = records[0][j] + 1;
      var matches = records.reduce(function (n, row) { return n + (row[j] + 1 === headerWidth ? 1 : 0); }, 0);
      return { delimiter: d, headerWidth: headerWidth, consistency: matches / records.length };
    }).filter(function (s) { return s.headerWidth > 1; }).sort(function (a, b) { return b.consistency - a.consistency || b.headerWidth - a.headerWidth; });
    if (!scored.length) return { delimiter: ',', confidence: 'single-column', candidates: [] };
    if (scored.length > 1 && scored[0].consistency - scored[1].consistency < 0.05)
      fail('ambiguous_delimiter', 'The delimiter is ambiguous. Select comma, semicolon, or tab explicitly.', { candidates: scored });
    return { delimiter: scored[0].delimiter, confidence: scored[0].consistency >= 0.95 ? 'high' : 'review', candidates: scored };
  }

  function parseCSV(text, options) {
    options = options || {};
    checkText(text, options);
    var hadBOM = text.charCodeAt(0) === 0xfeff;
    if (hadBOM) text = text.slice(1);
    if (text.indexOf('\0') !== -1) fail('binary_or_encoding', 'The file contains NUL bytes. Export UTF-8 CSV or JSON before profiling.');
    var detection = options.delimiter ? { delimiter: options.delimiter, confidence: 'explicit' } : detectDelimiter(text);
    var delimiter = detection.delimiter;
    if ([',', ';', '\t'].indexOf(delimiter) < 0) fail('unsupported_delimiter', 'Choose a comma, semicolon, or tab delimiter.');
    var records = [], locations = [], parserErrors = [], skippedBlankLines = 0;
    var cells = [], field = '', quoted = false, closedQuote = false, touched = false;
    var physicalLine = 1, startLine = 1, currentErrors = [];
    function mark(code, message) { if (!currentErrors.some(function (e) { return e.code === code; })) currentErrors.push({ code: code, message: message }); }
    function endField() {
      cells.push(field); field = ''; closedQuote = false;
      if (cells.length > LIMITS.maxColumns) fail('column_limit', 'The file exceeds 250 columns. No rows have been sampled or imported.');
    }
    function endRecord() {
      if (!touched && !cells.length && !field.length) { skippedBlankLines++; currentErrors = []; return; }
      endField();
      records.push(cells); locations.push({ line: startLine, endLine: physicalLine });
      currentErrors.forEach(function (e) { parserErrors.push(issue(e.code, e.message, { record: records.length, line: startLine, endLine: physicalLine }, 'error')); });
      cells = []; touched = false; currentErrors = [];
      if (records.length > LIMITS.maxRows + 1) fail('row_limit', 'The file exceeds 100,000 data rows. No rows have been sampled or imported.');
    }
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { quoted = false; closedQuote = true; }
        } else {
          field += c;
          if (c === '\r') { if (text[i + 1] === '\n') { field += '\n'; i++; } physicalLine++; }
          else if (c === '\n') physicalLine++;
        }
      } else if (c === delimiter) { endField(); touched = true; }
      else if (c === '\n' || c === '\r') {
        endRecord();
        if (c === '\r' && text[i + 1] === '\n') i++;
        physicalLine++; startLine = physicalLine;
      } else if (c === '"' && field.length === 0 && !closedQuote) { quoted = true; touched = true; }
      else {
        if (closedQuote) mark('csv_after_quote', 'Characters appear after a closing quote and before a delimiter. The characters are retained; review this row.');
        else if (c === '"') mark('csv_unexpected_quote', 'A quote appears inside an unquoted field. The quote is retained; review this row.');
        field += c; touched = true;
      }
    }
    if (quoted) mark('csv_unclosed_quote', 'A quoted field was not closed before the end of the file. This row may contain multiple intended records.');
    if (touched || cells.length || field.length) endRecord();
    if (!records.length) fail('empty_file', 'The CSV file contains no header or data.');
    var originalHeaders = records.shift();
    var headerLocation = locations.shift();
    var maxWidth = originalHeaders.length;
    for (var r = 0; r < records.length; r++) maxWidth = Math.max(maxWidth, records[r].length);
    if (maxWidth * records.length > LIMITS.maxCells) fail('cell_limit', 'The file exceeds the local limit of 2,000,000 table cells. No rows have been sampled or imported.');
    var used = new Set(), headers = [], notes = [], issues = [];
    if (hadBOM) notes.push('The UTF-8 byte-order mark was removed from the first header.');
    if (skippedBlankLines) notes.push(skippedBlankLines + ' empty physical CSV line(s) were skipped. Quoted empty values and rows containing delimiters were retained.');
    for (var h = 0; h < maxWidth; h++) {
      var original = h < originalHeaders.length ? originalHeaders[h] : undefined;
      var base = original === undefined ? 'Extra field ' + (h - originalHeaders.length + 1) : (original.trim() || 'Column ' + (h + 1));
      var name = base, serial = 2;
      while (used.has(name)) name = base + ' [' + serial++ + ']';
      used.add(name);
      headers.push(name);
      if (original !== undefined && (name !== original || original.trim() === ''))
        issues.push(issue('header_normalized', 'A blank, repeated, or whitespace-padded header received a distinct working name.', { column: h + 1, originalHeader: original, workingName: name }, 'info'));
    }
    var rowErrors = parserErrors.map(function (e) { return Object.assign({}, e, { row: e.record - 1 }); });
    var rows = records.map(function (record, index) {
      var out = dict();
      for (var j = 0; j < record.length; j++) out[headers[j]] = record[j];
      if (record.length !== originalHeaders.length) rowErrors.push(issue('csv_width_mismatch', 'CSV row width differs from the header; extra fields are retained and absent fields stay missing.', { row: index + 1, record: index + 2, line: locations[index].line, expected: originalHeaders.length, actual: record.length }, 'error'));
      return out;
    });
    if (rowErrors.length) issues.push(issue('csv_row_errors', rowErrors.length + ' CSV parse or row-width issue(s) require review.', { count: rowErrors.length }, 'error'));
    if (detection.confidence === 'review') issues.push(issue('delimiter_review', 'The delimiter has inconsistent record widths. Check the selected delimiter and row errors.'));
    if (detection.confidence === 'single-column') notes.push('No unambiguous delimiter appeared in the header; the file is treated as a single-column CSV.');
    return {
      rows: rows, headers: headers, originalHeaders: originalHeaders, delimiter: delimiter,
      delimiterConfidence: detection.confidence, rowErrors: rowErrors, rowLocations: locations,
      headerLocation: headerLocation, issues: issues, notes: notes,
      schema: headers.map(function (name, index) { return { path: [name], originalName: originalHeaders[index] }; })
    };
  }

  // Strict JSON reader: detects duplicate keys and preserves unsafe integer
  // literals as their exact text, rather than silently rounding identifiers.
  function decimalIdentity(token) {
    var m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
    if (!m || (m[4] && m[4].replace(/^[+-]/, '').length > 6)) return null;
    var digits = (m[2] + (m[3] || '')).replace(/^0+/, '');
    if (!digits) return '0';
    var exponent = Number(m[4] || 0) - (m[3] || '').length;
    var stripped = digits.replace(/0+$/, '');
    exponent += digits.length - stripped.length;
    return m[1] + stripped + 'e' + exponent;
  }
  function readJSON(text) {
    var index = 0, nodes = 0, unsafeIntegers = 0, nonFiniteNumbers = 0, precisionPreserved = 0;
    var numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    function syntax(message) { fail('invalid_json', message + ' (character ' + (index + 1) + ').', { offset: index }); }
    function space() { while (index < text.length && /[\x20\t\r\n]/.test(text[index])) index++; }
    function string() {
      var start = index++;
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue; }
        if (text[index++] === '"') {
          try { return JSON.parse(text.slice(start, index)); } catch (_) { syntax('Invalid JSON string'); }
        }
      }
      syntax('Unterminated JSON string');
    }
    function value(depth) {
      if (++nodes > LIMITS.maxJSONNodes) fail('json_node_limit', 'The JSON file exceeds the local limit of 2,000,000 values.');
      if (depth > LIMITS.maxJSONDepth) fail('json_depth_limit', 'JSON nesting exceeds 100 levels.');
      space();
      var c = text[index];
      if (c === '"') return string();
      if (c === '{') {
        index++; space();
        var obj = dict();
        if (text[index] === '}') { index++; return obj; }
        while (index < text.length) {
          if (text[index] !== '"') syntax('Expected an object key');
          var key = string();
          if (OWN.call(obj, key)) fail('duplicate_json_key', 'Duplicate JSON object key ' + JSON.stringify(key) + ' would overwrite data. Correct the file before profiling.', { offset: index });
          space(); if (text[index++] !== ':') syntax('Expected a colon after an object key');
          obj[key] = value(depth + 1); space();
          if (text[index] === '}') { index++; return obj; }
          if (text[index++] !== ',') syntax('Expected a comma or closing brace');
          space();
        }
        syntax('Unterminated JSON object');
      }
      if (c === '[') {
        index++; space();
        var arr = [];
        if (text[index] === ']') { index++; return arr; }
        while (index < text.length) {
          arr.push(value(depth + 1));
          if (arr.length > LIMITS.maxRows) fail('row_limit', 'A JSON array exceeds 100,000 entries. No rows have been sampled or imported.');
          space();
          if (text[index] === ']') { index++; return arr; }
          if (text[index++] !== ',') syntax('Expected a comma or closing bracket');
          space();
        }
        syntax('Unterminated JSON array');
      }
      if (text.slice(index, index + 4) === 'true') { index += 4; return true; }
      if (text.slice(index, index + 5) === 'false') { index += 5; return false; }
      if (text.slice(index, index + 4) === 'null') { index += 4; return null; }
      numberPattern.lastIndex = index;
      var match = numberPattern.exec(text);
      if (match) {
        var token = match[0]; index += token.length;
        var number = Number(token);
        if (!Number.isFinite(number)) { nonFiniteNumbers++; return token; }
        if (Number.isInteger(number) && !Number.isSafeInteger(number)) { unsafeIntegers++; return token; }
        if (decimalIdentity(token) !== decimalIdentity(String(number))) { precisionPreserved++; return token; }
        return number;
      }
      syntax('Expected a JSON value');
    }
    var result = value(0); space();
    if (index !== text.length) syntax('Unexpected characters after the JSON value');
    return { data: result, unsafeIntegers: unsafeIntegers, nonFiniteNumbers: nonFiniteNumbers, precisionPreserved: precisionPreserved };
  }

  function discoverTables(data) {
    if (Array.isArray(data)) return [{ name: 'records', path: [], rows: data }];
    if (!isObject(data)) fail('unsupported_json_shape', 'Use a JSON array of records, a depot export, or an object containing arrays of records.');
    var tables = [];
    function walk(obj, path, depth) {
      Object.keys(obj).forEach(function (key) {
        var item = obj[key], next = path.concat(key);
        if (Array.isArray(item)) tables.push({ name: next.join('.'), path: next, rows: item });
        else if (isObject(item) && depth < LIMITS.maxFlattenDepth) walk(item, next, depth + 1);
        if (tables.length > LIMITS.maxTables) fail('table_limit', 'The JSON export exceeds 32 discovered tables.');
      });
    }
    walk(data, [], 0);
    if (!tables.length) tables.push({ name: 'document', path: [], rows: [data] });
    var total = tables.reduce(function (n, table) { return n + table.rows.length; }, 0);
    if (total > LIMITS.maxRows) fail('row_limit', 'The JSON export exceeds 100,000 rows across its tables. No rows have been sampled or imported.');
    return tables;
  }

  function parseJSON(text, options) {
    options = options || {};
    checkText(text, options);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var parsed = readJSON(text);
    var issues = [], notes = [];
    if (parsed.unsafeIntegers) issues.push(issue('unsafe_integer_preserved', parsed.unsafeIntegers + ' JSON integer literal(s) exceeded exact JavaScript integer precision and were retained as exact text.', { count: parsed.unsafeIntegers }));
    if (parsed.nonFiniteNumbers) issues.push(issue('large_number_preserved', parsed.nonFiniteNumbers + ' JSON number literal(s) exceeded finite JavaScript range and were retained as text.', { count: parsed.nonFiniteNumbers }));
    if (parsed.precisionPreserved) issues.push(issue('numeric_precision_preserved', parsed.precisionPreserved + ' JSON numeric value(s) would change decimal value or underflow when converted to JavaScript Number; their exact original numeric text was retained.', { count: parsed.precisionPreserved }));
    notes.push('JSON decimal numbers use JavaScript floating-point arithmetic. Unsafe integer literals are preserved as text.');
    var tables = discoverTables(parsed.data);
    if (tables.length > 1) notes.push('Arrays outside record arrays are profiled as separate tables. Tables are not automatically joined, deduplicated, or converted into farm records.');
    if (isObject(parsed.data)) notes.push('Top-level metadata remains available in sourceData; it is not automatically interpreted as a table or permission grant.');
    return { tables: tables, data: parsed.data, issues: issues, notes: notes };
  }

  function numericValue(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string') return null;
    var s = value.trim();
    if (!NUMERIC.test(s)) return null;
    var n = Number(s);
    if (!Number.isFinite(n)) return null;
    if (/^[+-]?\d+$/.test(s) && !Number.isSafeInteger(n)) return null;
    return n;
  }
  function validYMD(y, m, d) {
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return false;
    var leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    return d <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }
  function isoDay(y, m, d) { return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
  function dateValue(value, order) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? { timestamp: value.getTime(), format: 'Date object', naiveTime: false, dateOnly: false } : null;
    if (typeof value !== 'string') return null;
    var s = value.trim(), match = ISO_DATE.exec(s), format = 'YYYY-MM-DD';
    if (!match) { match = YMD_DATE.exec(s); format = 'YYYY/MM/DD'; }
    if (match) {
      var y = +match[1], m = +match[2], d = +match[3];
      if (!validYMD(y, m, d)) return null;
      return { timestamp: Date.parse(isoDay(y, m, d) + 'T00:00:00Z'), format: format, naiveTime: false, dateOnly: true };
    }
    match = ISO_TIME.exec(s);
    if (match) {
      var year = +match[1], month = +match[2], day = +match[3], hour = +match[4], minute = +match[5], second = +(match[6] || 0);
      if (!validYMD(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
      var zone = match[8] || 'Z';
      if (zone !== 'Z' && zone !== 'z') {
        var normalizedZone = zone.replace(':', '');
        if (+normalizedZone.slice(1, 3) > 23 || +normalizedZone.slice(3) > 59) return null;
        zone = normalizedZone.slice(0, 3) + ':' + normalizedZone.slice(3);
      }
      var ms = ((match[7] || '') + '000').slice(0, 3);
      var stamp = Date.parse(isoDay(year, month, day) + 'T' + match[4] + ':' + match[5] + ':' + String(second).padStart(2, '0') + '.' + ms + zone.toUpperCase());
      return Number.isFinite(stamp) ? { timestamp: stamp, format: match[8] ? 'ISO date-time with offset' : 'ISO date-time without offset', naiveTime: !match[8], dateOnly: false } : null;
    }
    if (order === 'DMY' || order === 'MDY') {
      match = /^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/.exec(s);
      if (match) {
        var yy = +match[3], mm = +(order === 'DMY' ? match[2] : match[1]), dd = +(order === 'DMY' ? match[1] : match[2]);
        if (validYMD(yy, mm, dd)) return { timestamp: Date.parse(isoDay(yy, mm, dd) + 'T00:00:00Z'), format: order + ' (explicit)', naiveTime: false, dateOnly: true };
      }
    }
    return null;
  }

  function identifierReason(name, values, uniqueCount) {
    var words = String(name).replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9áéíóúñ]+/g, ' ').trim();
    var compact = words.replace(/ /g, '');
    if (/\b(year|years|año|anio|année|jahr)\b/.test(words)) return 'year';
    if (/\b(id|ids|identifier|identifiers|uuid|guid|code|codes|postcode|postal|zip|zipcode|phone|telephone|mobile|tel|iban|nif|cif|vat)\b/.test(words) || /(?:identifier|postcode|zipcode|phone|phonenumber|postalcode)$/.test(compact)) return 'identifier-like field name';
    if (/^(?:farmer|farm|field|parcel|plot|transaction|record|customer|client|user|buyer|cooperative|coop|order|invoice|product|crop|grant|batch|lot|event|session|tax|external)(?:id|ids|code|number|no)$/.test(compact)) return 'identifier-like field name';
    if (/\b(account|invoice|order|reference|ref|record|farmer|farm|parcel|plot|transaction|customer)\s+(number|no|num)\b/.test(words)) return 'identifier-like field name';
    if (!values.length) return null;
    var measureName = /\b(quantity|qty|weight|tonnes?|tons?|kilograms?|kg|hectares?|ha|amount|total|price|revenue|income|cost|count|units?|height|width|area|yield|volume|distance|temperature|humidity|moisture|measure|value|sales|cantidad|importe|precio|rendimiento|superficie|produccion|producción|ventas|ingresos)\b/.test(words);
    if (values.every(function (v) { return typeof v === 'string' && /^[+-]?0\d+$/.test(v.trim()); })) return 'leading-zero digit strings';
    if (values.some(function (v) { return typeof v === 'string' && /^0\d+$/.test(v.trim()); }) && values.every(function (v) { return typeof v === 'string' && /^\d+$/.test(v.trim()); })) return 'digit strings include leading zeros';
    if (values.every(function (v) { return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim()); })) return 'UUID-shaped values';
    if (!measureName && values.every(function (v) { return (typeof v === 'string' || typeof v === 'number') && /^(?:18|19|20|21)\d{2}$/.test(String(v).trim()); })) return 'year-shaped values';
    if (!measureName && values.every(function (v) { return typeof v === 'string' && /^\+\d[\d\s().-]{5,}$/.test(v.trim()); })) return 'telephone-shaped values';
    if (!measureName && values.length > 1 && uniqueCount / values.length > 0.8 && values.every(function (v) { return (typeof v === 'string' || typeof v === 'number') && /^\d{10,}$/.test(String(v).trim()); })) return 'long, mostly unique digit strings';
    return null;
  }

  function quantile(sorted, p) {
    if (!sorted.length) return null;
    var index = (sorted.length - 1) * p, lo = Math.floor(index), hi = Math.ceil(index), fraction = index - lo;
    return sorted[lo] * (1 - fraction) + sorted[hi] * fraction;
  }
  function compensatedSum(values) {
    var sum = 0, correction = 0;
    for (var i = 0; i < values.length; i++) { var adjusted = values[i] - correction; var next = sum + adjusted; correction = (next - sum) - adjusted; sum = next; }
    return sum;
  }
  function numericalStats(entries) {
    var n = entries.length;
    if (!n) return null;
    var values = entries.map(function (e) { return e.value; }).sort(function (a, b) { return a - b; });
    var maxAbs = Math.max(Math.abs(values[0]), Math.abs(values[n - 1])) || 1;
    var scaled = values.map(function (v) { return v / maxAbs; });
    var normalizedSum = compensatedSum(scaled), meanScaled = normalizedSum / n;
    var varianceScaled = n > 1 ? compensatedSum(scaled.map(function (v) { return (v - meanScaled) * (v - meanScaled); })) / (n - 1) : null;
    var q1s = quantile(scaled, 0.25), q3s = quantile(scaled, 0.75), iqrs = q3s - q1s;
    var lowerS = q1s - 1.5 * iqrs, upperS = q3s + 1.5 * iqrs;
    var outliers = entries.filter(function (e) { var v = e.value / maxAbs; return v < lowerS || v > upperS; }).map(function (e) { return { row: e.row, value: e.value }; });
    var minS = scaled[0], maxS = scaled[n - 1], binCount = values[0] === values[n - 1] ? 1 : Math.min(20, Math.max(2, Math.ceil(Math.log2(n) + 1)));
    var step = binCount > 1 ? (maxS - minS) / binCount : 0;
    var bins = [];
    for (var b = 0; b < binCount; b++) bins.push({ low: finite((minS + step * b) * maxAbs), high: finite((b === binCount - 1 ? maxS : minS + step * (b + 1)) * maxAbs), count: 0 });
    scaled.forEach(function (v) { var slot = !step ? 0 : Math.max(0, Math.min(binCount - 1, Math.floor((v - minS) / step))); bins[slot].count++; });
    var result = {
      n: n, min: values[0], max: values[n - 1], sum: finite(normalizedSum * maxAbs),
      mean: finite(meanScaled * maxAbs), median: finite(quantile(scaled, 0.5) * maxAbs),
      p25: finite(q1s * maxAbs), p75: finite(q3s * maxAbs),
      sampleSd: n > 1 ? finite(Math.sqrt(Math.max(0, varianceScaled)) * maxAbs) : null,
      iqr: finite(iqrs * maxAbs), lowerFence: finite(lowerS * maxAbs), upperFence: finite(upperS * maxAbs),
      outlierCount: outliers.length, outlierRows: outliers,
      zeros: values.filter(function (v) { return v === 0; }).length,
      negativeCount: values.filter(function (v) { return v < 0; }).length,
      constant: values[0] === values[n - 1],
      histogram: { bins: bins, binCount: binCount, n: n, method: 'Equal-width bins; Sturges count capped at 20' },
      quantileMethod: 'Linear interpolation at (n - 1) × p (R type 7)',
      outlierMethod: 'Values strictly outside Q1 − 1.5 × IQR or Q3 + 1.5 × IQR; flags are not errors'
    };
    result.sd = result.sampleSd;
    result.q1 = result.p25; result.q3 = result.p75;
    result.overflow = ['sum', 'mean', 'median', 'p25', 'p75', 'iqr', 'lowerFence', 'upperFence'].filter(function (k) { return result[k] === null; });
    if (n > 1 && result.sampleSd === null) result.overflow.push('sampleSd');
    return result;
  }
  function dateStats(entries) {
    if (!entries.length) return null;
    var sorted = entries.slice().sort(function (a, b) { return a.timestamp - b.timestamp; });
    var dayCounts = new Map(), monthCounts = new Map(), formats = dict(), naive = 0;
    sorted.forEach(function (e) {
      var iso = new Date(e.timestamp).toISOString(), day = iso.slice(0, 10), month = iso.slice(0, 7);
      dayCounts.set(day, (dayCounts.get(day) || 0) + 1); monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
      formats[e.format] = (formats[e.format] || 0) + 1; if (e.naiveTime) naive++;
    });
    var start = sorted[0].timestamp, end = sorted[sorted.length - 1].timestamp;
    var calendarDays = Math.floor(end / DAY) - Math.floor(start / DAY) + 1;
    return {
      n: entries.length, min: new Date(start).toISOString(), max: new Date(end).toISOString(),
      minTimestamp: start, maxTimestamp: end, spanDays: (end - start) / DAY,
      calendarDays: calendarDays, distinctDays: dayCounts.size, daysWithoutRecords: Math.max(0, calendarDays - dayCounts.size),
      dayCounts: Array.from(dayCounts, function (e) { return { date: e[0], count: e[1] }; }),
      monthCounts: Array.from(monthCounts, function (e) { return { month: e[0], count: e[1] }; }),
      formats: formats, timezoneNaiveCount: naive,
      groupingTimezone: 'UTC for profiling only; source text retained',
      coverageCaveat: 'Days without records do not prove missing data unless a reporting cadence is known.'
    };
  }

  function flattenRows(rows, schema) {
    var columns = new Map(), flatRows = [], truncatedPaths = new Set(), hasNested = false;
    function register(path, originalName) {
      var key = pointer(path);
      if (!columns.has(key)) columns.set(key, { key: key, path: path.slice(), name: readablePath(path), originalName: originalName });
      if (columns.size > LIMITS.maxColumns) fail('column_limit', 'The flattened table exceeds 250 columns. No rows have been sampled or imported.');
      return key;
    }
    (schema || []).forEach(function (s) { register(s.path, s.originalName); });
    rows.forEach(function (row) {
      var out = dict();
      function walk(value, path, depth) {
        if (isObject(value) && Object.keys(value).length && depth < LIMITS.maxFlattenDepth) {
          if (path.length) hasNested = true;
          Object.keys(value).forEach(function (k) { walk(value[k], path.concat(k), depth + 1); });
        } else {
          var key = register(path);
          out[key] = value;
          if (isObject(value) && Object.keys(value).length && depth >= LIMITS.maxFlattenDepth) truncatedPaths.add(key);
        }
      }
      if (isObject(row)) Object.keys(row).forEach(function (k) { walk(row[k], [k], 1); });
      else walk(row, [], 0);
      flatRows.push(out);
      if (flatRows.length * columns.size > LIMITS.maxCells) fail('cell_limit', 'The flattened table exceeds 2,000,000 cells. No rows have been sampled or imported.');
    });
    return { flatRows: flatRows, columns: Array.from(columns.values()), truncatedPaths: Array.from(truncatedPaths), hasNested: hasNested };
  }

  function profileColumn(info, flatRows, options) {
    var present = [], numericEntries = [], dateEntries = [], frequencies = new Map();
    var missing = { absent: 0, null: 0, emptyString: 0, whitespace: 0 };
    var typeCounts = dict(), localeNumericCount = 0, localeDateCount = 0, nonFiniteCount = 0;
    var dateOrder = options.columnDateOrders && options.columnDateOrders[info.key] || options.dateOrder;
    flatRows.forEach(function (row, index) {
      var v = row[info.key];
      if (isMissing(v)) {
        if (v === undefined) missing.absent++;
        else if (v === null) missing.null++;
        else if (v === '') missing.emptyString++;
        else missing.whitespace++;
        return;
      }
      present.push(v);
      var rawType = Array.isArray(v) ? 'array' : v instanceof Date ? 'date-object' : typeof v;
      typeCounts[rawType] = (typeCounts[rawType] || 0) + 1;
      var key = stableKey(v), found = frequencies.get(key);
      if (found) found.count++;
      else frequencies.set(key, { value: v, count: 1, _key: key });
      var num = numericValue(v);
      if (num !== null) numericEntries.push({ row: index + 1, value: num });
      var date = dateValue(v, dateOrder);
      if (date) dateEntries.push(Object.assign({ row: index + 1 }, date));
      if (typeof v === 'number' && !Number.isFinite(v)) nonFiniteCount++;
      if (typeof v === 'string') {
        var s = v.trim();
        if (/^[+-]?[\d .\u00a0]+,[\d.,\u00a0 ]+$/.test(s) || /^[+-]?\d{1,3}(?:[ \u00a0]\d{3})+(?:[.,]\d+)?$/.test(s)) localeNumericCount++;
        if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{4}$/.test(s) && !date) localeDateCount++;
      }
    });
    var count = present.length, total = flatRows.length;
    var identifier = identifierReason(info.path.length ? info.path[info.path.length - 1] : info.name, present, frequencies.size);
    var type, reason;
    if (!count) { type = 'empty'; reason = 'All values are missing under the explicit null/blank rule.'; }
    else if (identifier) { type = 'identifier'; reason = identifier + '; excluded from numeric summaries and correlations.'; }
    else if (present.every(function (v) { return typeof v === 'boolean'; })) { type = 'boolean'; reason = 'All non-missing values are booleans.'; }
    else if (present.every(function (v) { return v !== null && typeof v === 'object' && !(v instanceof Date); })) { type = 'structured'; reason = 'Arrays, empty objects, or objects retained at the flattening depth limit.'; }
    else if (numericEntries.length === count) { type = 'numeric'; reason = 'Every non-missing value is a finite canonical numeric value; no locale or unit conversion.'; }
    else if (dateEntries.length === count) { type = 'date'; reason = 'Every non-missing value matches a valid explicit date format.'; }
    else if (frequencies.size <= 20 || frequencies.size / count <= 0.2) { type = 'categorical'; reason = 'At most 20 distinct values, or at most 20% distinct values; inferred from every row.'; }
    else { type = 'text'; reason = 'Non-numeric, non-date values with higher cardinality.'; }
    var missingCount = total - count;
    var allFrequencies = Array.from(frequencies.values()).sort(function (a, b) { return b.count - a.count || (a._key < b._key ? -1 : a._key > b._key ? 1 : 0); });
    var shown = allFrequencies.slice(0, LIMITS.maxDisplayedFrequencies).map(function (f) { return { value: f.value, label: displayValue(f.value), count: f.count, percent: pct(f.count, count) }; });
    var result = Object.assign({}, info, {
      type: type, semanticType: identifier === 'year' || identifier === 'year-shaped values' ? 'year' : type,
      inference: reason, inferenceRows: total, nonMissingCount: count, missingCount: missingCount,
      missingPercent: pct(missingCount, total), missingKinds: missing,
      uniqueCount: frequencies.size, uniquePercent: pct(frequencies.size, count),
      constant: count > 0 && frequencies.size === 1, rawTypeCounts: typeCounts,
      frequencies: shown, displayedFrequencyCount: shown.length, omittedFrequencyCount: Math.max(0, frequencies.size - shown.length),
      otherFrequencyCount: allFrequencies.slice(shown.length).reduce(function (n, f) { return n + f.count; }, 0),
      numericCandidateCount: numericEntries.length, dateCandidateCount: dateEntries.length,
      unconvertedLocaleNumericCount: localeNumericCount, unparsedLocaleDateCount: localeDateCount,
      nonFiniteCount: nonFiniteCount,
      numeric: type === 'numeric' ? numericalStats(numericEntries) : null,
      dates: type === 'date' ? dateStats(dateEntries) : null,
      examples: shown.slice(0, 4).map(function (f) { return f.value; })
    });
    return result;
  }

  function pearsonPair(a, b, flatRows) {
    var pairs = [], scaleX = 0, scaleY = 0;
    flatRows.forEach(function (row) {
      if (isMissing(row[a.key]) || isMissing(row[b.key])) return;
      var x = numericValue(row[a.key]), y = numericValue(row[b.key]);
      if (x === null || y === null) return;
      pairs.push([x, y]); scaleX = Math.max(scaleX, Math.abs(x)); scaleY = Math.max(scaleY, Math.abs(y));
    });
    var base = { x: a.key, y: b.key, xName: a.name, yName: b.name, n: pairs.length, r: null, status: 'ok', smallSample: pairs.length < 10, method: 'Pearson; pairwise-complete rows; no causal interpretation' };
    if (pairs.length < 2) { base.status = 'insufficient_pairs'; return base; }
    scaleX = scaleX || 1; scaleY = scaleY || 1;
    var xs = pairs.map(function (p) { return p[0] / scaleX; }), ys = pairs.map(function (p) { return p[1] / scaleY; });
    var mx = compensatedSum(xs) / pairs.length, my = compensatedSum(ys) / pairs.length;
    var xx = 0, yy = 0, xy = 0;
    for (var i = 0; i < pairs.length; i++) { var dx = xs[i] - mx, dy = ys[i] - my; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
    if (xx === 0 || yy === 0) { base.status = 'zero_variance'; return base; }
    var r = xy / Math.sqrt(xx) / Math.sqrt(yy);
    if (!Number.isFinite(r)) { base.status = 'numerical_limit'; return base; }
    base.r = Math.max(-1, Math.min(1, r));
    return base;
  }

  function profileTable(rows, options) {
    options = options || {};
    if (!Array.isArray(rows)) fail('rows_required', 'A table must be an array of records.');
    if (rows.length > LIMITS.maxRows) fail('row_limit', 'The table exceeds 100,000 rows. No rows have been sampled or imported.');
    var issues = (options.issues || []).slice(), notes = (options.notes || []).slice();
    var flattened = flattenRows(rows, options.schema);
    var columns = flattened.columns.map(function (c) { return profileColumn(c, flattened.flatRows, options); });
    if (flattened.hasNested) notes.push('Nested object fields are flattened with unambiguous JSON Pointer keys. Source records retain their original nested structure.');
    if (flattened.truncatedPaths.length) notes.push('Nested objects at depth 5 remain structured cells: ' + flattened.truncatedPaths.join(', ') + '.');
    if (columns.some(function (c) { return c.type === 'structured'; })) notes.push('Arrays and structured cells are not exploded into extra rows. Their exact structures are included in duplicate comparisons.');
    var duplicates = new Map();
    rows.forEach(function (row, index) {
      var key = stableKey(row), group = duplicates.get(key);
      if (group) group.push(index + 1); else duplicates.set(key, [index + 1]);
    });
    var duplicateGroups = Array.from(duplicates.values()).filter(function (g) { return g.length > 1; }).map(function (g) { return { rows: g, count: g.length, extraRows: g.length - 1 }; });
    var duplicateCount = duplicateGroups.reduce(function (n, g) { return n + g.extraRows; }, 0);
    if (duplicateCount) issues.push(issue('duplicate_records', duplicateCount + ' repeated full record(s) beyond the first occurrence. Repetition is a review flag, not automatic evidence of an error.', { count: duplicateCount }));
    columns.forEach(function (c) {
      if (c.missingCount) issues.push(issue('missing_values', c.missingCount + ' missing value(s) in ' + c.name + '.', { column: c.key, count: c.missingCount }, c.missingCount === rows.length ? 'warning' : 'info'));
      if (c.unconvertedLocaleNumericCount) issues.push(issue('locale_numeric_unconverted', c.unconvertedLocaleNumericCount + ' numeric-looking value(s) in ' + c.name + ' use commas or grouping separators and remain unchanged.', { column: c.key, count: c.unconvertedLocaleNumericCount }));
      if (c.unparsedLocaleDateCount) issues.push(issue('locale_date_unparsed', c.unparsedLocaleDateCount + ' date-like value(s) in ' + c.name + ' need an explicit DMY or MDY choice before date analysis.', { column: c.key, count: c.unparsedLocaleDateCount }));
      if (c.nonFiniteCount) issues.push(issue('non_finite_values', c.nonFiniteCount + ' non-finite numeric value(s) in ' + c.name + ' are excluded from numeric inference.', { column: c.key, count: c.nonFiniteCount }));
      if (c.numeric && c.numeric.outlierCount) issues.push(issue('iqr_flags', c.numeric.outlierCount + ' value(s) in ' + c.name + ' fall outside the 1.5 × IQR fences. These are statistical review flags.', { column: c.key, count: c.numeric.outlierCount }, 'info'));
      if (c.numeric && c.numeric.overflow.length) issues.push(issue('numeric_overflow', 'Some statistics for ' + c.name + ' exceed finite numeric range and are reported as null.', { column: c.key, statistics: c.numeric.overflow }));
      if (c.dates && c.dates.timezoneNaiveCount) issues.push(issue('timezone_naive_dates', c.dates.timezoneNaiveCount + ' date-time value(s) in ' + c.name + ' have no timezone. UTC is used only as a consistent profiling convention; source text is retained.', { column: c.key, count: c.dates.timezoneNaiveCount }));
      if (c.numericCandidateCount && c.numericCandidateCount < c.nonMissingCount && c.type !== 'identifier') issues.push(issue('mixed_numeric_content', c.name + ' contains ' + c.numericCandidateCount + ' canonical numeric value(s) mixed with other values; no numeric summary or correlation is inferred.', { column: c.key, count: c.numericCandidateCount }, 'info'));
    });
    var numericColumns = columns.filter(function (c) { return c.type === 'numeric'; });
    var correlationColumns = numericColumns.slice(0, LIMITS.maxNumericPairColumns), numericPairs = [];
    if (numericColumns.length > correlationColumns.length) notes.push('Correlation display is limited to the first 24 numeric columns in source order; all columns and all rows still receive complete univariate profiles.');
    for (var x = 0; x < correlationColumns.length; x++) for (var y = x + 1; y < correlationColumns.length; y++) numericPairs.push(pearsonPair(correlationColumns[x], correlationColumns[y], flattened.flatRows));
    var missingCells = columns.reduce(function (n, c) { return n + c.missingCount; }, 0);
    var types = dict(); columns.forEach(function (c) { types[c.type] = (types[c.type] || 0) + 1; });
    notes.push('All ' + rows.length + ' rows were profiled. Preview and frequency display limits do not limit statistical calculations.');
    notes.push('Missing means absent, null, empty string, or whitespace-only string. Zero, false, and literal NA are retained as values.');
    notes.push('Unique counts and frequencies exclude missing values and distinguish original strings from numbers. No trimming, currency inference, or unit conversion is applied to retained values.');
    notes.push('Full-record duplicates ignore JSON object key order, preserve array order, and distinguish null from absent fields. Row numbers are 1-based data-row positions.');
    return {
      name: options.name || 'records', path: options.path || [],
      rowCount: rows.length, columnCount: columns.length, cellCount: rows.length * columns.length,
      missingCells: missingCells, missingPercent: pct(missingCells, rows.length * columns.length),
      completeRowCount: flattened.flatRows.filter(function (row) { return columns.every(function (c) { return !isMissing(row[c.key]); }); }).length,
      typeCounts: types, rows: rows, flatRows: flattened.flatRows,
      previewRows: flattened.flatRows.slice(0, LIMITS.previewRows), columns: columns,
      numericPairs: numericPairs, correlationColumnKeys: correlationColumns.map(function (c) { return c.key; }),
      duplicateGroups: duplicateGroups, duplicateCount: duplicateCount,
      duplicateParticipantCount: duplicateGroups.reduce(function (n, g) { return n + g.count; }, 0),
      originalHeaders: options.originalHeaders || null, delimiter: options.delimiter || null,
      rowErrors: options.rowErrors || [], rowLocations: options.rowLocations || [],
      allRowsProfiled: true, sampled: false, issues: issues, notes: notes
    };
  }

  function analyzeText(text, options) {
    options = options || {};
    var sizeBytes = checkText(text, options);
    var filename = options.filename || options.fileName || 'local-data';
    var clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (!clean.trim()) fail('empty_file', 'The file is empty.');
    var format = options.format || 'auto';
    if (format === 'auto') format = /\.json$/i.test(filename) || /^[\s]*[\[{]/.test(clean) ? 'json' : 'csv';
    if (format !== 'csv' && format !== 'json') fail('unsupported_format', 'Use CSV, TSV, or JSON text.');
    var tables, issues = [], notes = [], sourceData = null;
    if (format === 'csv') {
      var csvOptions = Object.assign({}, options);
      if (!csvOptions.delimiter && /\.tsv$/i.test(filename)) csvOptions.delimiter = '\t';
      var csv = parseCSV(text, csvOptions);
      tables = [profileTable(csv.rows, Object.assign({}, options, csv, { name: filename.replace(/\.[^.]+$/, '') || 'records' }))];
      issues = csv.issues.slice(); notes = csv.notes.slice();
    } else {
      var json = parseJSON(text, options); sourceData = json.data;
      tables = json.tables.map(function (table) { return profileTable(table.rows, Object.assign({}, options, { name: table.name, path: table.path })); });
      issues = json.issues; notes = json.notes;
    }
    var totalRows = tables.reduce(function (n, table) { return n + table.rowCount; }, 0);
    var totalCells = tables.reduce(function (n, table) { return n + table.cellCount; }, 0);
    if (totalCells > LIMITS.maxCells) fail('cell_limit', 'The complete export exceeds 2,000,000 table cells. No rows have been sampled or imported.');
    return {
      version: VERSION,
      source: { filename: filename, format: format, sizeBytes: sizeBytes, tableCount: tables.length, rowCount: totalRows, cellCount: totalCells, localOnly: true, sampled: false },
      sourceData: sourceData, tables: tables, issues: issues, notes: notes,
      method: { allRowsProfiled: true, missingRule: 'absent, null, empty or whitespace-only string', quantiles: 'R type 7', standardDeviation: 'sample, n − 1', correlations: 'Pearson, pairwise complete; identifier fields excluded', originalRecordsRetained: true },
      limits: LIMITS
    };
  }
  function analyzeRecords(rows, options) {
    options = options || {};
    var table = profileTable(rows, options);
    return {
      version: VERSION,
      source: { filename: options.filename || 'in-memory records', format: 'records', sizeBytes: null, tableCount: 1, rowCount: table.rowCount, cellCount: table.cellCount, localOnly: true, sampled: false },
      sourceData: rows, tables: [table], issues: [], notes: [],
      method: { allRowsProfiled: true, missingRule: 'absent, null, empty or whitespace-only string', quantiles: 'R type 7', standardDeviation: 'sample, n − 1', correlations: 'Pearson, pairwise complete; identifier fields excluded', originalRecordsRetained: true },
      limits: LIMITS
    };
  }
  return Object.freeze({
    version: VERSION, limits: LIMITS, analyzeText: analyzeText, analyzeRecords: analyzeRecords,
    parseCSV: parseCSV, parseJSON: parseJSON, profileTable: profileTable,
    detectDelimiter: detectDelimiter, getPath: getPath, isMissing: isMissing,
    numericValue: numericValue, dateValue: dateValue, stableKey: stableKey
  });
});
