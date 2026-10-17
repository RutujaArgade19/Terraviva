# Base data and staging contract

## Status of this revision

`all-datasets.zip` has been identified by its Windows path, but the archive bytes have not been supplied here. The repository contains the staging schema and executable pipeline, **not a populated dataset or placeholder database**. The public app catalog explicitly reports `awaiting-source-archive`.

Run the staging command once the actual source is available. Source-specific relationships, units, licences and analytical conclusions still require inspection of those files.

## Why SQLite

The base data is an offline, versioned snapshot. SQLite provides one queryable file containing source provenance, table/column metadata and all staged rows. Original parsed values remain intact until a documented transformation is warranted. This is a useful starting point when an archive's schemas are not yet known.

The app consumes generated JSON views. Live farmer records and permission changes remain in the existing encrypted Redis depot. Neither the app nor Vercel functions mutate this base SQLite file.

## Commands

Run from a checkout of this repository with Python 3.10+:

```sh
python3 scripts/stage-datasets.py --input /path/to/all-datasets.zip
```

`--input` also accepts one CSV/TSV/JSON file or a directory. For a Windows checkout:

```powershell
py -3 scripts/stage-datasets.py --input "C:\Users\HAL900\Downloads\all-datasets.zip"
```

The default output is `data/staged/`. To create the app's public views as well:

```sh
python3 scripts/stage-datasets.py --input /path/to/all-datasets.zip --publish-app --replace
```

`--replace` is needed to update the existing awaiting-source manifest and to replace an existing managed snapshot. Generated-file checksums protect edits and unrelated files; it is not a blanket overwrite flag. Use `--output-dir` and `--app-dir` for isolated destinations. Do not overlap input, output and app directories.

Review the source and generated outputs before committing. This repository is public. The SQLite snapshot includes original source bytes, so committing it publishes those bytes too. The app's permission controls govern the private farmer store; they do not restrict public GitHub files or public dataset views.

## Generated artifacts

| Path | Meaning |
| --- | --- |
| `data/staged/base.sqlite3` | SQLite snapshot with original source bytes, metadata and rows |
| `data/staged/catalog.json` | Build/source identifiers, checksums, table inventory, counts, skipped files and view availability |
| `data/staged/views/<dataset-id>.json` | Complete app-compatible table view when within the view limits |
| `public/datasets/manifest.json` | App catalog, only updated with `--publish-app` |
| `public/datasets/<dataset-id>.json` | Published complete reference table, only with `--publish-app` |

Generator ownership markers accompany the output directories. Preserve them when committing staged outputs; replacement validation uses their file hashes. Unsupported documents and operating-system metadata are listed as skipped and are not executed or opened. The original archive itself remains an external source; its SHA-256 is recorded when staging a ZIP. Exact bytes of each supported source file are retained inside SQLite.

A table that cannot be exposed within the app-view limits remains complete in SQLite and is listed as `requires-split`. No first-N-row sample masquerades as a full table. The browser report has its own explicit limits, and harvest imports have the narrower limit of 1,000 rows.

## SQLite schema

The executable definition is [schema.sql](schema.sql), schema version 1.

| Table or view | Grain and key | Important fields |
| --- | --- | --- |
| `build_metadata` | One value per metadata key | Generator/version, build identity, origin, numeric policy, effective limits |
| `source_files` | One supported file per logical source path | `source_file_id`, `logical_path`, `byte_size`, `sha256`, `encoding`, `source_bytes` |
| `datasets` | One discovered table in a source file | `dataset_id`, source foreign key, JSON table pointer, shape, context, row/column counts, view availability |
| `columns` | One flattened field path per dataset | Ordinal, JSON Pointer, observed source types, conservative inferred type, missing/distinct counts, profile JSON |
| `rows` | One original parsed row at a one-based source position | `dataset_id`, `row_index`, CSV source line when available, row SHA-256, exact `row_json` |
| `dataset_overview` | Convenient join of dataset and source metadata | Source filename/hash, table pointer, shape counts and view status |

Foreign keys connect rows and columns to datasets, then datasets to source files. `(dataset_id, row_index)` identifies a source observation. No inferred farm, crop, date, amount, currency, commercial consent or business-event key is created.

### Reconciliation queries

After the source has been staged, these queries inspect the actual snapshot:

```sql
SELECT name, logical_path, table_pointer, row_count, column_count,
       duplicate_extra_rows, view_status
FROM dataset_overview
ORDER BY logical_path, table_pointer;

SELECT d.name, d.row_count AS declared_rows, COUNT(r.row_index) AS stored_rows
FROM datasets AS d
LEFT JOIN rows AS r USING (dataset_id)
GROUP BY d.dataset_id
HAVING declared_rows <> stored_rows;

SELECT d.name, c.display_name, c.inferred_type,
       c.missing_count, c.distinct_count
FROM columns AS c
JOIN datasets AS d USING (dataset_id)
ORDER BY d.name, c.ordinal;

PRAGMA integrity_check;
PRAGMA foreign_key_check;
```

The reconciliation query should return no discrepancies. For a field that actually exists in an inspected table, an explicit extraction can use `json_extract(row_json, '$.field_name')`. Choose fields and units from the source, not from assumed domain labels. SQLite numeric extraction may coerce arbitrary-precision JSON numbers; keep identifiers and precision-sensitive values as source text when exactness matters.

## Source semantics and precision

CSV strings retain leading zeros, whitespace and their original cell text. JSON number lexemes are preserved in `row_json` and generated views, including large integers and precise decimal notation. Original raw bytes remain the final provenance authority. Objects are serialized in stable key order for row fingerprints; CSV source line numbers support reconciliation.

Missingness counts absent fields, nulls and whitespace-only strings. Zero, false and the literal string `NA` are present values. Column types are inferred from observed values and field names; they do not certify units or domain meaning. Identifier-like columns are kept distinct from continuous measures.

Exact staged-row fingerprints compare canonical source representations while retaining numeric lexemes. Thus JSON `1` and `1.0` can have different staged fingerprints even though a downstream numeric analysis treats their values as equal. Neither form of exact duplication proves whether two rows describe the same real-world event. The stager retains duplicates and reports their count.

CSV header duplicates, blank headers, inconsistent row widths, malformed quoting, ambiguous delimiters, JSON duplicate keys, invalid encodings and malformed supported sources cause the staging operation to fail. No partial batch replaces the previous output. UTF-8 is supported with or without a BOM; UTF-16 requires an explicit BOM. The browser app accepts UTF-8 views/files.

## Reference-data wrapper

Each generated table view has this structure:

```json
{
  "_terravivaDataset": {
    "id": "deterministic dataset identifier",
    "role": "reference",
    "farmerAssignment": null,
    "source": {
      "file": "original logical source path",
      "sha256": "source file checksum",
      "tablePointer": "/path/to/source/table"
    },
    "sourceContext": {}
  },
  "records": []
}
```

This is a structure example only. A generated view's `records` array contains all rows of that table. `sourceContext` retains scalar and object metadata from JSON ancestors while recursively omitting array-valued fields. It preserves, for example, a nested farm claim even when neighbouring metadata contains an array, without manufacturing extra analytical tables. The full source envelope is recoverable from `source_bytes`.

The app checks explicit farm claims in rows and source context before a harvest import. A reference dataset can be analysed without assigning it to a farmer. Explicit mapping, validation, preview and confirmation are required before compatible records are added to the selected depot. Existing grants and commercial preferences remain in effect; the base-data snapshot cannot grant permission.

## Bounds and large sources

Defaults for offline staging:

| Bound | Default |
| --- | ---: |
| Total supported expanded source data | 200 MiB |
| One expanded source file | 50 MiB |
| Rows per table | 100,000 |
| Flattened columns per table | 500 |
| Profiling cells per table | 2,000,000 |
| JSON tables per source | 256 |
| JSON depth | 100 |
| Flattened object depth | 5 |
| Complete public JSON view | 1 MiB |

`--max-expanded-mib`, `--max-member-mib`, `--max-rows`, `--max-columns` and `--max-cells` allow a deliberate larger offline staging run. Browser-compatible views remain bounded separately: 1 MiB, 100,000 rows, 250 columns and 2,000,000 cells. A valid reference view may exceed the 1,000-row harvest-batch limit and still be useful for analysis.

If the actual archive exceeds practical Git repository size or these limits, partition it explicitly or keep full data in durable object/database storage and commit its schema, manifests and approved app views. Make that choice using the observed archive sizes and contents.

## Validation

```sh
python3 test/stage-datasets.py
npm test
npm run build
```

Staging tests create small labelled synthetic fixtures in temporary directories. They are not base data and do not populate the real app catalog. The staging command also runs SQLite foreign-key and integrity checks before installing a snapshot.
