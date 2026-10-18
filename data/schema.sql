-- Terraviva immutable dataset snapshot, schema version 1.
-- This database is built offline. It is not a writable Vercel database and
-- does not replace the private Redis depot, grants, or farmer state.
-- Source file bytes and their SHA-256 hashes are the provenance authority.
-- row_json retains JSON number lexemes and CSV strings; SQLite json_extract
-- may coerce arbitrary-precision numbers when a query requests SQL numbers.
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;

CREATE TABLE build_metadata (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL CHECK (json_valid(value_json))
) WITHOUT ROWID;

CREATE TABLE source_files (
    source_file_id TEXT PRIMARY KEY,
    logical_path TEXT NOT NULL UNIQUE,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    encoding TEXT NOT NULL,
    source_bytes BLOB NOT NULL,
    CHECK (length(source_bytes) = byte_size)
) WITHOUT ROWID;

CREATE TABLE datasets (
    dataset_id TEXT PRIMARY KEY,
    source_file_id TEXT NOT NULL REFERENCES source_files(source_file_id),
    name TEXT NOT NULL,
    table_pointer TEXT NOT NULL,
    source_format TEXT NOT NULL CHECK (source_format IN ('csv', 'tsv', 'json')),
    source_shape_json TEXT NOT NULL CHECK (json_valid(source_shape_json)),
    context_json TEXT NOT NULL CHECK (json_valid(context_json)),
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    column_count INTEGER NOT NULL CHECK (column_count >= 0),
    duplicate_extra_rows INTEGER NOT NULL CHECK (duplicate_extra_rows >= 0),
    view_status TEXT NOT NULL CHECK (view_status IN ('available', 'requires-split')),
    view_bytes INTEGER NOT NULL CHECK (view_bytes >= 0),
    UNIQUE (source_file_id, table_pointer)
) WITHOUT ROWID;

CREATE TABLE columns (
    dataset_id TEXT NOT NULL REFERENCES datasets(dataset_id),
    column_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
    json_pointer TEXT NOT NULL,
    display_name TEXT NOT NULL,
    source_type_counts_json TEXT NOT NULL CHECK (json_valid(source_type_counts_json)),
    inferred_type TEXT NOT NULL,
    missing_count INTEGER NOT NULL CHECK (missing_count >= 0),
    distinct_count INTEGER NOT NULL CHECK (distinct_count >= 0),
    profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
    PRIMARY KEY (dataset_id, column_id),
    UNIQUE (dataset_id, json_pointer),
    UNIQUE (dataset_id, ordinal)
) WITHOUT ROWID;

CREATE TABLE rows (
    dataset_id TEXT NOT NULL REFERENCES datasets(dataset_id),
    row_index INTEGER NOT NULL CHECK (row_index >= 1),
    source_line INTEGER CHECK (source_line IS NULL OR source_line >= 1),
    row_sha256 TEXT NOT NULL CHECK (length(row_sha256) = 64),
    row_json TEXT NOT NULL CHECK (json_valid(row_json)),
    PRIMARY KEY (dataset_id, row_index)
) WITHOUT ROWID;

CREATE INDEX rows_by_content ON rows(dataset_id, row_sha256);
CREATE INDEX datasets_by_source ON datasets(source_file_id);

CREATE VIEW dataset_overview AS
SELECT d.dataset_id, d.name, s.logical_path, s.sha256 AS source_sha256,
       d.table_pointer, d.source_format, d.row_count, d.column_count,
       d.duplicate_extra_rows, d.view_status, d.view_bytes
FROM datasets AS d JOIN source_files AS s USING (source_file_id);

-- Example (choose a dataset and the actual observed field explicitly):
-- SELECT row_index, json_extract(row_json, '$.crop') AS crop
-- FROM rows WHERE dataset_id = ? ORDER BY row_index;
-- No row is assigned a farmer, product, quantity, currency, or consent here.
