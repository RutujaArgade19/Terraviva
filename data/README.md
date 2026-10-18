# Terraviva reference data

## What is included

This snapshot contains 28 retrieved CSV source files: **566,600,488 original bytes**, **1,754,685 source-table rows**, and **804 field occurrences**. Original bytes are preserved in the committed lossless `source-bundle/`. Source preparation generates per-source gzip fragments under `reference-base/sources/` and every parsed row and column under `public/reference/`.

The inputs were recovered individually from the supplied OneDrive collection. The original ZIP, its SHA-256 and its complete contents inventory remain unknown. Forty-four additional observed filenames are listed as unretrieved in the report. “Complete” in the catalog means complete for the 28 retrieved files. Source-table totals count repeated exports and projections as well as distinct records.

This is reference data. Its holding identifiers do not identify the signed-in farmer, and the snapshot creates no farm assignment, access grant or commercial-use consent. The original source's synthetic and static status flags remain part of the data.

## SQL and storage design

SQLite is the portable analytical base. Each source table keeps its original columns, source row positions and lexical values. Tables can be joined using documented keys after checking grain, units and coverage. The database can be opened without a service, account or network connection.

The live farmer depot continues to use the existing encrypted Redis storage. The static reference browser reads generated pages. Vercel does not mutate the reference SQLite file.

| Path | Contents |
| --- | --- |
| `data/source-bundle/manifest.json` | Committed checksums and byte lengths for all 111 archive fragments and 30 original members, plus expected data dimensions |
| `data/source-bundle/source.tar.xz.partNNNN` | Committed consecutive fragments of the 55,462,120-byte tar+xz archive; each fragment is at most 500,000 bytes |
| `data/source-metadata.json` | Prepared source identity, column definitions and full measured source profiles |
| `data/reference-base/catalog.json` | Source dimensions, hashes, grain, page descriptors and storage locations |
| `data/reference-base/sources/<id>/manifest.json` | Ordered fragment sizes and hashes, full compressed hash, and original CSV hash |
| `data/reference-base/sources/<id>/source.csv.gz.partNNNN` | Consecutive fragments of a single gzip stream, at most 4 MiB each |
| `data/reference-base/schemas/<id>.sql` | Explicit per-source SQL table definition |
| `public/reference/index.json` | App catalog for all 28 retrieved source tables |
| `public/reference/<id>/page-NNNNNN.json.gz` | Full source rows, ordered and paginated; every original source column is retained |
| `public/reference/<id>/profile.json` | Complete source profile, with column summaries and quality context |
| `report/archive-analysis.json` | Measured collection analysis, findings, relationships and source inventory |

The paths below `data/reference-base/` and `public/reference/`, plus the source metadata and report analysis JSON, are generated and excluded from Git. The committed bundle contains 28 original CSV files and two metadata/analysis JSON files. No source table is omitted to make the package smaller.

The downloadable `Terraviva_Reference_Data_SQLite.zip` is supplied separately. It contains the closed SQLite database, delivery metadata, checksums and a README. The repository preserves its reproducible inputs instead of committing the 766 MB database as one Git object.

## Reproduce and verify

Use Python 3.11+ from the repository root. Outputs must be new locations; the scripts refuse accidental replacement.

First prepare the full source package and app views from the committed bundle:

```sh
npm run prepare:data
```

Equivalent: `python3 scripts/prepare-reference.py`. `npm run build` also performs this step automatically. The preparer validates all fragment hashes, the full compressed archive, member byte counts and original SHA-256 hashes. Archive extraction permits only declared regular files and safe relative paths. A completed preparation is cached, with source and output hashes rechecked on reuse. Edited generated files are preserved unless `--rebuild` is explicitly requested; unexpected extra files require inspection before continuing.

Restore the exact original CSV files, checking both fragment and original-source checksums:

```sh
python3 data/restore-sources.py \
  --base data/reference-base \
  --output-dir /tmp/terraviva-original-csv
```

Rebuild the compressed source package, paginated app views, profiles and schemas:

```sh
python3 scripts/build-reference-base.py \
  --input /tmp/terraviva-original-csv \
  --metadata data/source-metadata.json \
  --output-dir /tmp/terraviva-reference-build
```

Verify the prepared package and every generated app row against its preserved source:

```sh
python3 scripts/verify-reference-build.py \
  --base data/reference-base \
  --reference public/reference
```

Build a new queryable SQLite snapshot:

```sh
python3 scripts/build-reference-sqlite.py \
  --output /tmp/terraviva-reference.sqlite3
```

The default SQL input is `data/reference-base`. A rebuilt database may have a different binary layout across SQLite versions; exact original CSV checksums, source row equality and SQL integrity are the authoritative reproducibility checks. The separately delivered database has its own fixed byte checksum in its ZIP.

The older general-purpose `scripts/stage-datasets.py` is retained for new small CSV/TSV/JSON inputs or a future complete ZIP. It uses a different generic row-envelope schema and explicit limits. It is not the build path for this recovered collection. Its `/datasets/` import catalog is separate from the full `/reference/` explorer.

## SQLite contract

| Table or view | Meaning |
| --- | --- |
| `source_catalog` | One entry per retrieved source, with source path/hash, table name, shape, preservation and measured profile JSON |
| `source_columns` | One entry per source column, with original ordinal/name, storage type and measured profile JSON |
| `build_metadata` | Generator, collection scope, lexical/null policy and audit metadata |
| Original CSV filename stems | All source rows and source columns; `_row_number` and `_source_line` provide row provenance |
| `operation_core_all` | Every source copy of the 17 shared operation fields, with source provenance |
| `operation_key_audit` | Candidate-key repetitions and exact shared-field variant counts |
| `operation_core_deduplicated` | One common-field record per audited operation key, created only when key completeness and equality checks pass |

Only the literal CSV marker `\N` becomes SQL/JSON null. Empty strings, whitespace, zero, `NA`, leading zeros and decimal spelling remain lexical source text. `_row_number` is the one-based logical CSV data row; `_source_line` is the physical source line on which that record ends. Numeric analysis requires an explicit cast and a verified field/unit definition. Identifier fields should remain text.

Source SQL examples are inert text. No build executes SQL supplied by a source row.

### Useful queries

```sql
SELECT source_path, table_name, row_count, column_count, source_sha256
FROM source_catalog
ORDER BY source_path;

SELECT dataset_id, ordinal, name, storage_type
FROM source_columns
ORDER BY dataset_id, ordinal;

SELECT key, value_json FROM build_metadata;

SELECT COUNT(*) AS source_copies FROM operation_core_all;
SELECT COUNT(*) AS audited_keys FROM operation_core_deduplicated;
SELECT * FROM operation_key_audit WHERE core_variants > 1;
PRAGMA quick_check;
```

In the delivered snapshot, the operation union has **793,738 source copies** and **721,334 distinct candidate keys**. The candidate key is `(operation_type, source_operation_id)`. All 72,404 repeated keys have exactly equal values in the 17 shared fields; no missing keys or conflicting variants were found. These are source-key checks, not independent validation of real-world agricultural events. Original enriched rows remain available even when the common-field view is deduplicated.

## Interpretations the app must preserve

- **Farm reporting:** 20,000 holdings over 2017–2026, with 200,000 holding-year rows. The tested structure and labour fields are static within holdings. Farm financial values are marked synthetic and not regionally recalibrated. Historical financial variation is not evidence of observed farm performance.
- **Subsidies:** the 200,000-row subsidy export is an exact ten-field projection of farm reporting. Adding its totals to farm reporting would count the same information twice.
- **Operations:** seven enriched planting partitions contain 506,086 source keys. Only `part_3` was retrieved; this is not a complete history of all operations. The narrow 2021 file repeats the enriched 2021 core exactly. Campaign year and calendar operation year can differ.
- **Animal products:** milk is measured in tonnes; eggs are measured in thousands of pieces. Their quantities and per-head metrics must not be pooled across units. Source denominators are static and frequently fractional.
- **Livestock:** 33,516 holding/category rows have null year and a static temporal basis. They are not annual herd observations.
- **Sales and certificates:** 354,614 transaction identifiers are unique. The 27,827 certificate links cover 26,088 transactions; 1,739 transactions have two links. A flat transaction-to-certificate join therefore multiplies some sale amounts. No parcel or batch lineage is established by that link alone.
- **Regional context:** eight assigned regions and retrospective climate normals provide context. Regional assignment is synthetic, and repeated context rows are not independent climate observations. The retrieved collection does not supply a measured NDVI/monitoring history or real geographic parcel positioning.

The report contains the exact tests, field profiles, units, null patterns, outlier review candidates, source provenance and coverage qualifications. Numeric associations describe this source collection; they do not establish causation or representativeness.

## App behavior and permissions

`/reference-data.html` lists every retrieved table. It verifies compressed and decoded page hashes, displays bounded pages, supports a cancellable scan over the complete selected source, and opens all fields for a selected row. Display limits are identified explicitly; the stored collection is not sampled.

Reference sources never populate the farmer ledger automatically. The separate harvest-import workflow still requires compatible fields, a valid farm mapping, a preview and explicit confirmation. Imports preserve existing permissions; they cannot create commercial participation.

The source snapshot, report and generated views are public when committed/deployed in this public project. Farmer permission controls apply to private depot records, not these static reference files. Publisher provenance records a hackathon-participant redistribution declaration; it is a source declaration, not an independently verified licence audit or an unrestricted public distribution licence.
