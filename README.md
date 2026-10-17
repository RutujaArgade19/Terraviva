# Terraviva

Farmer-controlled data depot with an SMS field interface, personal dashboard, device sensor collection, scoped cooperative access, dataset imports and a separate commercial participation choice.

## Current data status

The source recovery and full-table analysis are complete for **28 retrieved CSV files**: **1,754,685 source-table rows**, **804 field occurrences** and **566,600,488 original bytes**. A complete standalone HTML report and SQLite package have been delivered separately. The original ZIP's full inventory and checksum remain unknown; the report records 44 additional observed filenames whose contents were not retrieved.

The reference-data app update is staged on [data-import/verified-reference-2026-10-17](https://github.com/jesusvilela/Terraviva/tree/data-import/verified-reference-2026-10-17). The execution workspace disconnected after 81 of 111 source fragments were uploaded. [Its publication status](https://github.com/jesusvilela/Terraviva/blob/data-import/verified-reference-2026-10-17/PUBLICATION_STATUS.md) records the remaining transfer and resume checks.

**This production revision adds farmer sensor collection.** Its reference-data catalog remains unpopulated until the complete source bundle is published. The existing interactive report and explicit local file-import workflow remain available. The sensor module has no dependency on that source bundle.

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
| Farmer depot | Farmer-specific harvest declarations, sensor readings, grants and operational state | Confirmed SMS, validated file import or authenticated device ingestion |
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
py -3 scripts/stage-datasets.py --input "C:\Users\HAL900\OneDrive\all-datasets.zip" --publish-app --replace
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

## Gather each farmer's sensor data

The sensor module accepts readings from enrolled devices or gateways through `POST /api/sensors`. Each ingest credential is bound on the server to one farm and one device; it can optionally be restricted to a named field. A device cannot choose another farm in its payload. Farmer viewing uses the existing farmer credential through `GET /api/sensors`. See [the sensor enrollment and API guide](docs/sensors.md) for the complete request contract and equipment setup requirements.

Readings preserve a source ID, device, field, measurement, numeric source text, unit, observation time, server receipt time and sender-supplied quality status. Compatible units are validated; unlike measures are not pooled. Late and out-of-order readings are accepted with their original observation time. Identical retries are idempotent, while reusing an ID with different contents rejects the batch. Sensor writes preserve harvest records, grants and commercial participation settings.

Open **Farm sensors** for a tab-local demonstration or connect with a farmer token to view the private depot. Device ingestion credentials belong on enrolled hardware or gateways. The connected browser view reads the farmer's sensor history; local demo readings are explicitly labelled and are not uploaded.

The pilot stores at most 10,000 readings per farm, subject to a whole-depot serialized size limit of 3 MiB. Batches are bounded to 500 readings and 256 KiB. Capacity errors return 507 without deleting old readings or partly accepting a batch. Production histories need a durable event store, pagination and an agreed retention policy. Sensor partner sharing is a future extension; the current sensor read endpoint requires the farmer role. No sensor data enters a commercial report automatically.

Live collection needs the Redis/encryption settings below and `SENSOR_DEVICE_ACCESS_JSON`, an array of device credential hashes with fixed farm/device assignments. The implementation supplies the ingestion interface and farmer view. Hardware enrollment and provider-specific MQTT, LoRaWAN or vendor API bridges require the farmer's actual equipment and credentials. The reference snapshot contains no measured live sensor history to connect automatically.

## HTML data report

**Data report** opens a self-contained analysis page with an implementation audit and a local exploratory profiler:

- Source size, tables, rows and columns; complete column dictionary and inferred types.
- Missing values, exact duplicate rows and data-quality signals.
- Numeric summaries, histograms, quartiles and IQR review candidates.
- Category concentration, date coverage and pairwise Pearson correlations with each pair's observation count.
- Source provenance, method notes and a downloadable profile JSON.

Choose a file, paste text, use **Analyse my records** from the depot, or **Analyse source** from a loaded repository/local source. The source action opens the original bytes for analysis without harvest mapping or farmer assignment. A selected file is processed in browser memory. The depot-to-report handoff sends only the current farm and its record export to the report window on the same origin; it does not send the access token or permission state. Profile JSON may contain category values and should be handled like source-derived data.

The interactive profiler processes all rows within explicit limits: 20 MiB, 100,000 rows, 250 columns, 2 million cells and 32 tables. Inputs beyond those limits are refused rather than sampled. Preview rows and category charts are intentionally bounded and labelled. Large numeric relationship matrices are bounded to a stated subset of fields. Built-in examples are labelled synthetic and never presented as the supplied archive.

For a permanent report across an archive's source tables, the build accepts a derived `report/archive-analysis.json` following [the archive analysis contract](report/archive-contract.md). It renders source inventories, coverage, findings, per-table field dictionaries and statistical profiles directly into the HTML. Those findings remain visible when a visitor loads another file, tries an example or clears the interactive analyser. The build validates the declared scope and accepted fields before embedding the analysis. The staging command does not generate this analysis file automatically; it must be produced from the actual source data with its methods and exclusions documented. The completed source analysis is in the separately delivered HTML report. Its integration into the production report waits for completion of the source-bundle upload documented above.

The fixed architecture audit is pinned to original commit `e0013fbfb8c9de2d5a7b850216270e6836857073`. It describes the original six-field SMS schema; import provenance is documented as an extension. It is historical context. The current sensor contract is documented in [docs/sensors.md](docs/sensors.md); the measured source findings are in the separately delivered complete data report.

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
- `SENSOR_DEVICE_ACCESS_JSON`: ingest-only device entries `{tokenHash, farm, deviceId, field?, label?, enabled?}`. Use distinct random device credentials and server-side SHA-256 hashes. Disabling an entry or removing it revokes future ingestion.
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

Provider-specific sensor bridges, payment systems, live commercial reports, arbitrary cohort query services and revenue-share accounting remain roadmap work. Minimum group size is a demonstration safeguard, not proof of anonymisation. Commercial permission remains a current boolean rather than a versioned consent contract. A production analytics product needs a more complete disclosure and consent model.

The per-farm encrypted document and deduplication history grow with use: suitable for a bounded pilot, requiring event-table storage and retention policy for scale. Event history is not tamper-proof. Key rotation, backups/restore, recipient onboarding, telecom configuration and real-provider end-to-end tests remain operational work.

## Verification

```sh
npm test
python3 test/stage-datasets.py
npm run build
```

Tests exercise core confirmation and permissions, encryption and signatures, mocked authenticated API/SMS flows, full-row EDA edge cases, strict harvest normalization, cross-farm rejection, repeat imports, provenance, archive staging, scoped sensor ingestion, retries/conflicts, shared storage capacity and sensor UI behavior. Synthetic test fixtures are kept separate from the app's real-data catalog. External Redis and Twilio integrations need live credentialed verification.

References: [Twilio request security](https://www.twilio.com/docs/usage/security), [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi).
