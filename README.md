# Terraviva

### A home for your data. A voice from the field.

Farmers grow food. Sharing the records behind it should not become a second job—or mean giving up control of those records.

**Terraviva is a farmer-controlled data wallet:** record a harvest, bring in field data, and decide who can use it and for how long. This hackathon MVP makes that idea tangible through a populated farmer workspace, a text-message journey and time-limited cooperative access.

[**Meet Ana · Open the demo**](https://terraviva-ruddy.vercel.app/?demo=ana) · [Five-minute walkthrough](docs/five-minute-demo.md) · [Live SMS setup](docs/live-jury-sms.md) · [Data report](https://terraviva-ruddy.vercel.app/data-report.html)

## Meet Ana. Follow one record.

Ana García is our **fictional demonstration farmer** in Valencia. Her starting wallet contains three wheat and olive harvests, **24.30 tonnes** in total, a cooperative permission and an activity history. Illustrative sensor cards give the dashboard context; they are not connected devices or measured farm evidence.

On the home screen, tap **Add my data → Send a text** and try:

```text
Harvested 2 tonnes of wheat from North Field
YES
SUMMARY
```

The confirmed record appears in the **same wallet and dashboard**. Starting from the sample, the total becomes 26.30 tonnes. Then inspect cooperative access, revoke it, and see what the cooperative can no longer read.

**That is the story: capture once, reuse with permission, keep the farmer in control.**

The browser conversation is a simulator: no SMS is sent and no provider charges are incurred. The explicit demo link uses separate browser storage, preserving an existing wallet. Changes persist on that device, so a returning demo may contain more than the initial three records. Private depots are never filled with sample data.

## Five minutes with the jury

| Time | Show | Make the value visible |
| --- | --- | --- |
| 0:00–1:00 | Ana’s dashboard | A farmer starts with useful records, not an empty form. |
| 1:00–2:00 | Record a harvest in the text simulator; reply `YES` | Confirmation turns a short message into a structured record. |
| 2:00–3:00 | Open **My farm insights → All my records** and download them | The message and the wallet tell the same story. |
| 3:00–4:00 | Open **Who sees my data**, then tap **Stop sharing** | Access is a choice the farmer can change. Previously exported copies cannot be recalled. |
| 4:00–5:00 | Open **My farm insights → Compare with other farms** | A separately labelled five-farm synthetic cohort illustrates shared value. Ana’s one-farm report stays withheld. |

For an optional real-phone moment, open **Add my data → Send a text → Open guarded live SMS**. Rehearse and configure it before the pitch; the browser simulator remains the no-charge fallback. The older `/pitch.html` is a separate presentation mockup, not the interactive wallet used above.

## What works—and what it depends on

| Capability | Available in this MVP | Boundary |
| --- | --- | --- |
| Farmer wallet | Harvest records, dashboard, export, permissions and activity | Sample data is fictional; farm declarations are not independent certificates. |
| Text interface | Confirmation, summaries, time-limited COOP sharing and revocation | Browser simulation is free; real inbound SMS needs a configured Twilio webhook and private backend. English command patterns, not an open-ended AI assistant. |
| Live jury SMS | Presenter authentication, separate code, fixed recipient/message, send confirmation and delivery-status lookup | Requires server-side setup. Three attempts per UTC day, seven-day request replay protection; provider acceptance is not delivery. |
| Private depot | Authenticated farm access and encrypted Redis storage | Needs credentials and storage configuration; administrator-issued tokens, not self-service accounts. |
| Sensor collection | Device-bound ingestion, farmer views and a durable gateway sender | Actual equipment, enrollment and provider bridges must be configured. Sample sensor cards are not live telemetry. |
| Imports and reference data | Validated harvest imports, full reference-table browsing and descriptive analysis | Reference rows are not silently assigned to farmers or treated as consented commercial data. |
| Industry insight | Separate synthetic cohort demonstration; minimum-group suppression in the core | No live data marketplace, payments or revenue-sharing programme. |

**Live SMS activation checkpoint — 18 October 2026:** the guarded interface is deployed, but live sending remains blocked pending Redis, farmer authentication and demo configuration in Vercel. Twilio variables alone are not enough. No real delivery has been verified in this implementation session. See [the setup checklist](docs/live-jury-sms.md) before promising a live send.

## The principle behind the product

Sharing with a cooperative should not silently opt a farmer into commercial analytics. Terraviva keeps these choices separate. The pilot grants the pre-approved cooperative access to harvest products, quantities, dates and fields—not prices—and supports expiry and revocation.

The longer-term ambition is to return useful benchmarks to participating farmers and fund the service through permission-based aggregated insights. That is a product direction, not a launched revenue model. Multilingual and multimedia capture, advisor-assisted onboarding and production-grade consent contracts remain part of the [wider product roadmap](docs/product-brief.md).

## Current data status

The repository contains **28 verified source CSV files**, preserved in a lossless source bundle. The build restores their original bytes and generates every parsed row for a paginated reference-data browser. The retrieved collection has **1,754,685 source-table rows**, **804 field occurrences** and **566,600,488 original source bytes**. Row totals include overlapping source views; they are not counts of distinct farm events.

These files were recovered individually from the supplied OneDrive collection. The original `all-datasets.zip` was not transferred, and its full inventory and checksum remain unknown. The report identifies 44 additional observed filenames whose contents were not retrieved. The source snapshot is complete for the 28 retrieved files, not certified complete for the publisher's release.

The [data report](https://terraviva-ruddy.vercel.app/data-report.html) contains full-table descriptive analysis, source hashes and limitations. The [reference-data browser](https://terraviva-ruddy.vercel.app/reference-data.html) exposes all source columns and rows with full-source filtering. Both remain separate from the private farmer ledger and its permissions.

## Run it locally

Requires Node 22 or later and Python 3.11 or later. Reference preparation runs during the build using Python's standard library. The test command also prepares the source data and generates the report before tests run, so a fresh checkout has no dependency on previously generated files. No npm or pip packages are required.

```sh
npm run prepare:data
npm test
npm run build
npm start
```

Open http://127.0.0.1:3000. Depot demo mode uses browser storage and sends no SMS. The self-contained report is at `/data-report.html`; the complete source explorer is at `/reference-data.html`; the farmer sensor module is at `/sensors.html`.

## Data architecture

| Layer | Role | Write path |
| --- | --- | --- |
| `data/source-bundle/` | Committed original CSV bytes, full source profiles and report analysis in a checksummed tar+xz archive, split into 111 fragments of at most 500,000 bytes | Verified source snapshot |
| `data/reference-base/sources/` | Generated per-source gzip fragments that restore exact CSV bytes | `npm run prepare:data` |
| `data/reference-base/catalog.json` and `schemas/` | Source hashes, row counts, columns, storage manifests and SQL schemas | Generated from verified source files |
| `public/reference/` | Checksummed, paginated JSON for all 28 source tables, plus complete profiles | Offline build; read-only in the browser |
| SQLite reference snapshot | One portable queryable database with all original parsed source rows, metadata and operation-overlap views | Rebuilt locally after source preparation |
| Farmer depot | Farmer-specific harvest declarations, sensor readings, grants and operational state | Confirmed SMS, validated file import or authenticated device ingestion |
| `report/archive-analysis.json` | Measured findings and full profiles for the retrieved source collection | Explicit analysis of the verified data |

**SQL is the base-data choice.** The source consists of tabular records with explicit holding, year, transaction, crop and operation keys. SQLite makes the snapshot portable and queryable, while original lexical values remain TEXT until a documented analytical cast is needed. Only the literal source token `\N` becomes SQL/JSON null; empty strings, zero, identifier formatting and decimal text remain intact. The existing encrypted Redis store remains the live farmer store. The app does not write to a SQLite file on Vercel.

The browser validates both compressed and decoded page hashes and loads bounded pages. Filtering scans every page of the selected table, reports progress and can be cancelled. Visible rows are paginated; that display limit does not truncate the stored source. Source quantities are shown with their units, and synthetic/static status fields remain visible alongside relevant figures.

### Rebuild or inspect the reference data

See [data/README.md](data/README.md) for reconstruction commands, SQL examples, precision rules and source reconciliation. The downloadable SQLite package is delivered separately because it is larger than a sensible individual Git file. The committed source bundle is the reproducible base.

The 55,462,120-byte bundle contains all 28 original CSV files and two metadata/analysis files. `npm run prepare:data` verifies every fragment, the joined archive and every original member before generating the catalog, schemas, source fragments and app pages. It refuses unexpected archive paths, links and edited generated output. Generated assets are excluded from Git; `npm run build` prepares them automatically and creates the complete self-contained report. Cached builds verify both the source fragments and every prepared output hash.

The general-purpose `scripts/stage-datasets.py` remains available for a future original ZIP or a new local CSV/TSV/JSON collection. Its bounded `/datasets/` views support the explicit harvest-import workflow. The retrieved hackathon collection uses the separate complete `/reference/` pages so large, multi-farm tables keep their source meaning.

## Import records in the app

1. Open **Add my data → Upload a file** and choose a UTF-8 CSV/JSON file or an available repository source.
2. Select the table and map product, quantity, unit, field and date. Dates must be explicit, valid ISO calendar dates. Quantities need a supported, unambiguous mass unit.
3. Review the destination farm, normalized rows, total mass and duplicate warnings.
4. Confirm the batch. Browser-demo imports stay on the device. Connected imports go through authenticated server validation and encrypted storage.

The app accepts at most 1 MiB per source and 1,000 rows per harvest batch. It rejects malformed CSV rows, invalid dates, ambiguous units, mismatched farm identities and conflicting reuse of source IDs. Larger archive tables can remain in the SQLite reference snapshot; the app does not silently take the first 1,000 rows. Reimporting the same source skips identical records. Renaming a source changes its identifier namespace, so duplicate measurements require review.

Reference tables are not automatically assigned to a farmer. A weather series, a regional benchmark or a multi-farm export must retain its own meaning. Only compatible harvest rows belong in the harvest ledger, after a valid farm mapping and explicit confirmation.

Importing preserves existing permission and commercial participation settings. Existing active cooperative grants cover the relevant fields of newly imported harvest records too. No new grant or commercial authorization is created by an import.

## Gather each farmer's sensor data

The sensor module accepts readings from enrolled devices or gateways through `POST /api/sensors`. Each ingest credential is bound on the server to one farm and one device; it can optionally be restricted to a named field. A device cannot choose another farm in its payload. Farmer viewing uses the existing farmer credential through `GET /api/sensors`. See [the sensor enrollment and API guide](docs/sensors.md) for the complete request contract and equipment setup requirements.

Readings preserve a source ID, device, field, measurement, numeric source text, unit, observation time, server receipt time and sender-supplied quality status. Compatible units are validated; unlike measures are not pooled. Late and out-of-order readings are accepted with their original observation time. Identical retries are idempotent, while reusing an ID with different contents rejects the batch. Sensor writes preserve harvest records, grants and commercial participation settings.

Open **Farm sensors** for a tab-local demonstration or connect with a farmer token to view the private depot. Device ingestion credentials belong on enrolled hardware or gateways. The connected main dashboard and data depot also show sensor counts, latest observations and source quality flags. **Refresh depot** fetches a fresh farmer-authenticated snapshot; **Export sensor history** retains source values and both timestamps. Local demo readings are explicitly labelled and are not uploaded.

The pilot stores at most 10,000 readings per farm, subject to a whole-depot serialized size limit of 3 MiB. Batches are bounded to 500 readings and 256 KiB. Capacity errors return 507 without deleting old readings or partly accepting a batch. Production histories need a durable event store, pagination and an agreed retention policy. Sensor partner sharing is a future extension; the current sensor read endpoint requires the farmer role. No sensor data enters a commercial report automatically.

Live collection needs the Redis/encryption settings below and `SENSOR_DEVICE_ACCESS_JSON`, an array of device credential hashes with fixed farm/device assignments. The implementation supplies the ingestion interface, farmer view and a [durable gateway sender](docs/sensor-gateway.md). The sender uses a local SQLite outbox to retain mapped observations through restarts and temporary network failures, then retries submissions without creating duplicate server readings. It runs on the gateway or another always-on machine, not inside a Vercel request. Hardware enrollment and provider-specific MQTT, LoRaWAN or vendor API bridges require the farmer's actual equipment and credentials. The reference snapshot contains no measured live sensor history to connect automatically.

## HTML data report

**Data report** opens the complete self-contained analysis of the 28 retrieved files, including:

- A source inventory with file sizes, SHA-256 hashes, table shapes and retrieval status.
- All 804 field occurrences with types, missingness, distinct values and source context.
- Numeric summaries, histograms, quartiles, IQR review candidates and date coverage.
- Key uniqueness, measured relationships, join coverage and repeated source projections.
- Twenty-four evidence-based findings and nineteen measured relationships, with synthetic, static and regional limitations stated where they matter.
- A permanent source report plus an optional local exploratory profiler.

The analysis uses every row of the retrieved files. It does not infer population coverage, real-world farm performance or consent from synthetic source values. In particular, it identifies the repeated 2021 operation projection, the farm/subsidy projection, mixed animal-product units, static herd denominators and certificate joins that would multiply sales totals if flattened carelessly.

The optional interactive profiler accepts files within explicit limits: 20 MiB, 100,000 rows, 250 columns, 2 million cells and 32 tables. Larger inputs are refused rather than silently sampled. The complete source explorer has a separate paginated path for the full reference tables. Built-in profiler examples are labelled synthetic.

Choose a small local file, paste text or use **Analyse my records** from the depot. A selected file is processed in browser memory. The depot-to-report handoff sends only the current farm and its record export to the report window on the same origin; it does not send access tokens or permission state. Profile JSON can contain source category values.

The measured collection is stored in `report/archive-analysis.json`, following [the analysis contract](report/archive-contract.md). Its findings remain visible when a visitor loads another file or clears the interactive analyser. The fixed architecture audit is explicitly pinned to original commit `e0013fbfb8c9de2d5a7b850216270e6836857073`; it is historical context, not a claim that this revision has only the original SMS schema.

Edit `report/template.html`, `report/style.css` and `report/ui.js`, then run `npm run report` or `npm run build`. The build validates the analysis contract, embeds all report assets and recomputes exact script/style Content Security Policy hashes. It does not enable `unsafe-inline`.

## Try the permission boundary

Send `SHARE COOP 7`, then `CONFIRM`, to grant seven-day access. Open **Who sees my data** to inspect the cooperative preview, or use its one-tap **Share for 7 days** and **Stop sharing** buttons. Send `REVOKE COOP` to deny future access. Commercial contribution stays a separate choice, off by default.

**Compare with other farms** keeps the actual one-farm workspace report withheld. Its separate synthetic example uses five invented opt-in farms; it neither includes Ana’s wallet nor changes anyone’s consent. Export the wallet or choose **Analyse my records** to examine the records actually present in your session.

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

The inbound SMS endpoint returns TwiML for the provider to reply. Outbound SMS is available through `POST /api/sms-send`, but is disabled by default. SMS commands cannot enable commercial use or add recipients. Use `REVOKE COOP`, not the carrier-reserved `STOP` keyword.

### Outbound SMS channel

The outbound route's ordinary `send` action is simulation-only. Real sending uses the guarded jury flow at `/live-sms.html`: farmer authentication, a separate presenter code, server-fixed recipient/message, explicit per-send consent, atomic three-attempt daily quota, and request replay protection. See [Live jury SMS setup](docs/live-jury-sms.md) for the required Vercel settings. All provider credentials stay server-side. Provider acceptance is not delivery; the UI can retrieve delivery status without resending.

## Deployment

Existing repository: `jesusvilela/Terraviva`. Vercel configuration: framework **Other**, build `npm run build`, output `dist`. Use a build image with Node 22 and Python 3.11+; Vercel's Amazon Linux 2023 build image supplies Python 3.12. API routes in `api/` are serverless functions. The build prepares the reference data, generates the report and recursively copies only `public/`, including all paginated reference views. The SQLite database and compressed source bundle are not app static routes. Files committed to the public GitHub repository remain public there.

Browser demo, local imports and report work without secrets. The central pilot and live SMS need the variables above. A Twilio webhook must be reachable by Twilio; use an appropriate configured domain without Vercel login interception. Do not expose secrets to the browser or commit `.env`.

## Scope and limitations

This is an engineering pilot. It has administrator-issued bearer tokens, not self-service identity, MFA, account recovery or a consent-contract system. SMS phone ownership alone is weak assurance; use pre-approved pilot relationships. SMS is not end-to-end encrypted. Supported SMS grammar consists of English command patterns. Dates in original SMS records use UTC intake time; date-qualified text can be absorbed into free-text field labels and must not be interpreted as a parsed historical event date. File import requires an explicit source date.

Farmer-entered records are declarations, not independently verified crop/batch certificates. The original parser uses ASCII crop/field patterns; file imports preserve validated Unicode labels. It can misread a thousands comma as a decimal comma. No measured farm area, sales prices or population coverage is stored, so these records alone cannot establish yield, revenue or market share.

Provider-specific sensor bridges, payment systems, live commercial reports, arbitrary cohort query services and revenue-share accounting are roadmap work. Minimum group size is a demonstration safeguard, not proof of anonymisation. Commercial permission remains a current boolean rather than a versioned consent contract. A production analytics product needs a more complete disclosure and consent model.

The per-farm encrypted document and deduplication history grow with use: suitable for a bounded pilot, requiring event-table storage and retention policy for scale. Event history is not tamper-proof. Key rotation, backups/restore, recipient onboarding, telecom configuration and real-provider end-to-end tests remain operational work.

## Verification

```sh
npm run prepare:data
npm test
python3 test/stage-datasets.py
python3 test/reference-base.py
python3 test/reference-sqlite.py
python3 test/prepare-reference.py
npm run build
```

Tests exercise core confirmation and permissions, encryption and signatures, mocked authenticated API/SMS flows, full-row EDA edge cases, strict harvest normalization, cross-farm rejection, repeat imports, provenance and archive staging. Synthetic test fixtures are kept separate from the app's real-data catalog. External Redis and Twilio integrations need live credentialed verification.

References: [Twilio request security](https://www.twilio.com/docs/usage/security), [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi), [Vercel build image](https://vercel.com/docs/builds/build-image), [Vercel function limits](https://vercel.com/docs/functions/limitations).
