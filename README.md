# Terraviva

Farmer-controlled data depot with an SMS field interface, personal dashboard, scoped cooperative access, dataset imports and a separate commercial participation choice.

## Current data status

The requested source is `all-datasets.zip`. Its Windows path was supplied, but the archive itself has not been transferred into this workspace. **No real archive rows or populated base database are included in this revision.** `public/datasets/manifest.json` records that state explicitly. The staging command, schema, app import workflow and interactive HTML report are ready for the source.

## Run

Requires Node 22 or later. No runtime dependencies. Dataset staging additionally requires Python 3.10 or later, using only its standard library.

```sh
npm test
npm run build
npm start
```

Open http://127.0.0.1:3000. Demo mode uses browser storage and sends no SMS. The self-contained report is at `/data-report.html` and can also be opened as a downloaded HTML file.

## Data architecture

| Layer | Role | Write path |
| --- | --- | --- |
| Original source files | Preserve exact input bytes and checksums | Explicit local staging command |
| `data/staged/base.sqlite3` | Reproducible base-data snapshot: source metadata, tables and original parsed rows | Rebuilt from the supplied archive |
| `data/staged/catalog.json` | Inventory and provenance for every staged table | Generated with the snapshot |
| `public/datasets/` | Full JSON table views and a catalog for app use | Explicit `--publish-app` staging option |
| Farmer depot | Farmer-specific harvest declarations, grants and operational state | Confirmed SMS or validated file import |
| Report | Exploratory statistics calculated from a chosen source | Browser memory; no automatic upload |

SQLite suits the versioned base dataset because it is portable, queryable and easy to reproduce. Source rows initially retain their original values as JSON; typed analytical views can be added after inspecting the actual schema and units. The existing encrypted Redis store remains the live farmer store. The app does not write to a SQLite file on Vercel.

### Stage the archive

From the repository root, after the actual ZIP is available:

```sh
python3 scripts/stage-datasets.py --input /path/to/all-datasets.zip
```

This inventories supported CSV, TSV and JSON tables, retains original source bytes, computes SHA-256 checksums and creates the SQLite snapshot plus a catalog. It does not add observations to any farmer's depot. Unsupported files remain inventoried with their status; malformed supported inputs fail validation instead of being silently discarded.

To also generate the app's public dataset views:

```sh
python3 scripts/stage-datasets.py --input /path/to/all-datasets.zip --publish-app --replace
npm test
python3 test/stage-datasets.py
npm run build
```

`--replace` permits replacing an existing staging output and the initial awaiting-source app catalog. The command checks its managed output before replacing files. Inspect the results before committing. Content placed in this public repository, including the source snapshot, is publicly accessible; publish the archive only when its contents and usage terms allow that use.

On Windows, the input can be supplied directly to a local checkout:

```powershell
py -3 scripts/stage-datasets.py --input "C:\Users\HAL900\Downloads\all-datasets.zip" --publish-app --replace
```

See [data/README.md](data/README.md) for the storage contract, limits and reconciliation queries. Do not create an empty `base.sqlite3` to stand in for a missing archive.

## Import records in the app

1. Open **Data import** and choose a UTF-8 CSV/JSON file or an available repository source.
2. Select the table and map product, quantity, unit, field and date. Dates must be explicit, valid ISO calendar dates. Quantities need a supported, unambiguous mass unit.
3. Review the destination farm, normalized rows, total mass and duplicate warnings.
4. Confirm the batch. Browser-demo imports stay on the device. Connected imports go through authenticated server validation and encrypted storage.

The app accepts at most 1 MiB per source and 1,000 rows per harvest batch. It rejects malformed CSV rows, invalid dates, ambiguous units, mismatched farm identities and conflicting reuse of source IDs. Larger archive tables can remain in the SQLite reference snapshot; the app does not silently take the first 1,000 rows. Reimporting the same source skips identical records. Renaming a source changes its identifier namespace, so duplicate measurements require review.

Reference tables are not automatically assigned to a farmer. A weather series, a regional benchmark or a multi-farm export must retain its own meaning. Only compatible harvest rows belong in the harvest ledger, after a valid farm mapping and explicit confirmation.

Importing preserves existing permission and commercial participation settings. Existing active cooperative grants cover the relevant fields of newly imported harvest records too. No new grant or commercial authorization is created by an import.

## HTML data report

**Data report** opens a self-contained analysis page with an implementation audit and a local exploratory profiler:

- Source size, tables, rows and columns; complete column dictionary and inferred types.
- Missing values, exact duplicate rows and data-quality signals.
- Numeric summaries, histograms, quartiles and IQR review candidates.
- Category concentration, date coverage and pairwise Pearson correlations with each pair's observation count.
- Source provenance, method notes and a downloadable profile JSON.

Choose a file, paste text, use **Analyse my records** from the depot, or **Analyse source** from a loaded repository/local source. The source action opens the original bytes for analysis without harvest mapping or farmer assignment. A selected file is processed in browser memory. The depot-to-report handoff sends only the current farm and its record export to the report window on the same origin; it does not send the access token or permission state. Profile JSON may contain category values and should be handled like source-derived data.

The report profiles all rows within explicit limits: 20 MiB, 100,000 rows, 250 columns, 2 million cells and 32 tables. Inputs beyond those limits are refused rather than sampled. Preview rows and category charts are intentionally bounded and labelled. Large numeric relationship matrices are bounded to a stated subset of fields. Built-in examples are labelled synthetic and never presented as the supplied archive.

The fixed architecture audit is pinned to original commit `e0013fbfb8c9de2d5a7b850216270e6836857073`. It describes the original six-field SMS schema; import provenance is documented as an extension. There are no archive-level empirical findings until the archive is loaded.

Edit `report/template.html`, `report/style.css` and `report/ui.js`, then run `npm run report` or `npm run build`. The build embeds the engine and recomputes exact script/style Content Security Policy hashes. It does not enable `unsafe-inline`.

## Demo journey

1. Open **Text from the field** and send: `Harvested 12 tonnes of wheat from North Field`.
2. Send `YES`. The record appears in **My data depot** and **My dashboard**.
3. Send `SHARE COOP 7`, then `CONFIRM`. **Permissions** shows the cooperative view.
4. Send `REVOKE COOP`. Future partner access is denied.
5. Commercial participation is a separate dashboard choice, off by default.
6. **Industry insights** withholds results: this workspace has one farm, below the five-farm demonstration threshold.
7. Export the records or open **Analyse my records** to profile the actual local declarations.

## Connect the central pilot

Configure server-only Vercel variables listed in `.env.example`:

- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: your durable Redis REST service.
- `DEPOT_ENCRYPTION_KEY`: 32 cryptographically random bytes encoded in hex. Back up securely; losing it loses data access.
- `DEPOT_ACCESS_JSON`: array of `{tokenHash, farm, role}`, where `tokenHash` is SHA-256 of a random token of at least 32 characters. `role` is `farmer` or `partner`. A partner entry also needs `recipient: "COOP"`.
- `SMS_FARM_MAP_JSON`: map verified E.164 numbers to the same farm identifiers. Enrol numbers out of band; verify ownership and the cooperative relationship before enabling.
- `TWILIO_AUTH_TOKEN` and `TWILIO_WEBHOOK_URL`: exact HTTPS POST webhook URL, e.g. `https://your-domain/api/sms`. Configure the Twilio number's incoming messaging webhook as form-encoded POST to that URL.

Use **Connect private depot** and your farmer token. Tokens are held in browser memory, not localStorage. The API derives the farm from credentials. Partner reads use the same endpoint with the partner token and `action: "read"`; no active grant returns 403. Partners cannot import records.

Stored farm state uses AES-256-GCM with farm-bound additional authenticated data. Redis compare-and-swap updates avoid lost concurrent writes. Message IDs deduplicate delivery retries. Twilio form signatures are checked before processing. Duplicate webhook deliveries return empty TwiML to avoid duplicate replies. Confirmation expires in ten minutes. Rate limiting is per enrolled farm: 60 requests/minute. Missing service configuration fails closed.

The SMS endpoint returns TwiML for the provider to reply; no unsolicited outbound SMS API is used. SMS commands cannot enable commercial use or add recipients. Use `REVOKE COOP`, not the carrier-reserved `STOP` keyword.

## Deployment

Existing repository: `jesusvilela/Terraviva`. Vercel configuration: framework **Other**, build `npm run build`, output `dist`. API routes in `api/` are serverless functions. The build recursively copies only `public/`; the SQLite database and original source directory are not app static routes. Files committed to the public GitHub repository remain public there.

Browser demo, local imports and report work without secrets. The central pilot and live SMS need the variables above. A Twilio webhook must be reachable by Twilio; use an appropriate configured domain without Vercel login interception. Do not expose secrets to the browser or commit `.env`.

## Scope and limitations

This is an engineering pilot. It has administrator-issued bearer tokens, not self-service identity, MFA, account recovery or a consent-contract system. SMS phone ownership alone is weak assurance; use pre-approved pilot relationships. SMS is not end-to-end encrypted. Supported SMS grammar consists of English command patterns. Dates in original SMS records use UTC intake time; date-qualified text can be absorbed into free-text field labels and must not be interpreted as a parsed historical event date. File import requires an explicit source date.

Farmer-entered records are declarations, not independently verified crop/batch certificates. The original parser uses ASCII crop/field patterns; file imports preserve validated Unicode labels. It can misread a thousands comma as a decimal comma. No measured farm area, sales prices or population coverage is stored, so these records alone cannot establish yield, revenue or market share.

No external integration connector, payment system, live commercial report, arbitrary cohort query service or revenue-share accounting is implemented. Minimum group size is a demonstration safeguard, not proof of anonymisation. Commercial permission remains a current boolean rather than a versioned consent contract. A production analytics product needs a more complete disclosure and consent model.

The per-farm encrypted document and deduplication history grow with use: suitable for a bounded pilot, requiring event-table storage and retention policy for scale. Event history is not tamper-proof. Key rotation, backups/restore, recipient onboarding, telecom configuration and real-provider end-to-end tests remain operational work.

## Verification

```sh
npm test
python3 test/stage-datasets.py
npm run build
```

Tests exercise core confirmation and permissions, encryption and signatures, mocked authenticated API/SMS flows, full-row EDA edge cases, strict harvest normalization, cross-farm rejection, repeat imports, provenance and archive staging. Synthetic test fixtures are kept separate from the app's real-data catalog. External Redis and Twilio integrations need live credentialed verification.

References: [Twilio request security](https://www.twilio.com/docs/usage/security), [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi).
