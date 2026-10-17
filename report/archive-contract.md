# Archive report input

`report/archive-analysis.json` is optional. If it is absent, the report retains its
honest awaiting-source state. If present, it is a **derived analysis**, not a raw
dataset, and the build produces permanent archive findings alongside the private
interactive analyser. Do not place source rows, credentials or personal account
secrets in this file.

Use JSON numbers for measured numeric values. Unknown values must be `null` or
omitted, never zero. `schemaVersion`, `status`, `archive` and table identifiers are
validated by the renderer. All text is rendered as plain escaped text, not HTML.
The schema is a recursive allowlist: unknown fields are rejected at every level,
and only a newly normalized copy is rendered or embedded. Select the documented
fields from engine output; do not pass through its raw records, previews, extra
metadata, or arbitrary objects inside text fields. Boolean controls require
literal `true` or `false` when supplied.

```text
{
  schemaVersion: 1,
  status: "complete" | "partial",
  generatedAt: ISO timestamp,
  title?: string,
  summary?: [string],
  archive: {
    filename: string, bytes: integer, sha256: 64-character hexadecimal string,
    memberCount?: integer, uncompressedBytes?: integer
  },
  coverage: {
    fileCount?, parsedFileCount?, tableCount?, profiledTableCount?,
    totalTableRows?, profiledRows?, complete?: boolean, notes?: [string]
  },
  files: [{id, path, format?, bytes?, sha256?, status?, notes?: [string]}],
  tables: [{
    id, name, fileId?, sourcePath?, pointer?, grain?,
    role?: "reference" | "unknown",
    rowCount?, profiledRows?, columnCount?, duplicateCount?,
    missingCellCount?, completeRowCount?,
    columns: [{
      key?, name, type?, unit?, description?,
      nonMissingCount?, missingCount?, uniqueCount?,
      numeric?: {
        n?, mean?, median?, p25?, p75?, sampleSd?, min?, max?, outlierCount?,
        histogram?: {method?, bins: [{low, high, count}]}
      },
      frequencies?: [{label, count}],
      dates?: {
        min?, max?, distinctDays?, calendarDays?, daysWithoutRecords?,
        dayCounts?: [{date, count}], monthCounts?: [{month, count}]
      }
    }],
    numericPairs?: [{xName, yName, n?, r?, status?}],
    keyCandidates?: [{columns: [string], uniqueCount?, missingCount?, duplicateCount?, note?}],
    notes?: [string], issues?: [{severity?, message}]
  }],
  findings?: [{title, body, implication?, evidence?: [{tableId?, fileId?, column?, metric?, text?}]}],
  relationships?: [{
    leftTableId, rightTableId, keys: [string], status?, matchedCount?,
    unmatchedLeft?, unmatchedRight?, note?
  }],
  exclusions?: [{source, reason, rows?}],
  staging?: {status?, publishedTables?, unpublishedTables?, notes?: [string]},
  methods?: {version?, notes?: [string]}
}
```

The documented `numeric`, `frequencies`, `dates` and `numericPairs` fields follow
the existing Terraviva EDA engine. Include complete scalar summaries for every profiled field;
frequency lists and histogram bins may be bounded views when their coverage is
explicit. `uniqueCount` must refer to all profiled rows, not a truncated frequency
list. Top category charts use `nonMissingCount` as the denominator and explicitly
combine any remainder. Original source values remain unchanged in the staged
source files.

`rowCount` is the source table size; `profiledRows` is the actual analysis scope.
The archive-wide sum is labeled **rows across source tables**, not farms,
independent observations, or joined entities. Partial coverage and all excluded
members must be documented. A partial report may list fewer files than
`coverage.fileCount` and fewer profiled tables than `coverage.tableCount`.
`tables[]` is the supplied profile set, so a declared `profiledTableCount` must
equal its length. When every table's `profiledRows` is known, their sum must equal
the declared `coverage.profiledRows`. Known source-row totals must reconcile when
all declared tables are represented, and otherwise bound the total from below.

`status: "complete"` requires `coverage.complete: true`, all six scope counts,
the full inventoried file and table sets, every source row and field profiled,
measured present/missing counts, and **no exclusions**. Any exclusion or incomplete
inventory requires `status: "partial"` and `complete: false` (or an omitted
`complete` field). Unknown counts cannot create a green completeness badge. This
is intentionally stronger than completeness of a silently restricted sub-scope.

Numeric sample sizes, outlier counts and bin counts must fit their declared
population. Pearson correlation must be within [-1, 1] or null. Histogram and
frequency counts are non-negative integers; date buckets must be unique and use
real calendar dates/months. A date such as 2026-02-30 is rejected rather than
normalized into a different month.

Do not infer that a table is a harvest
ledger, or assign it to the current farmer, from the presence of numeric columns.

Source evidence references use stable `fileId` and `tableId` values. The archive
SHA-256 must be computed from the original ZIP bytes; it is distinct from each
member's checksum and from the generated JSON analysis file. Any checksum that is
not yet known must be obtained before publishing an archive report.

This schema does not authorize publication, third-party reuse, farm assignment,
or commercial participation. It records analysis and provenance only.
