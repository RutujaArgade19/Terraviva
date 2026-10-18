# Terraviva
Farmer-controlled data depot with an SMS field interface, personal dashboard, scoped cooperative access and a commercial participation module.

## Run
Requires Node 22 or later. No runtime dependencies.
```sh
npm test
npm run build
npm start
```
Open http://127.0.0.1:3000. Demo mode uses browser storage and sends no SMS. A first visit is pre-filled with clearly labeled illustrative farmer data so the dashboards are immediately presentable; clear the `terraviva-v2` browser storage key to return to an empty demo.

## Demo journey
1. Open **Text from the field** and send: Harvested 12 tonnes of wheat from North Field
2. Send YES. The record appears in My data depot and My dashboard.
3. Send SHARE COOP 7, then CONFIRM. Permissions shows the cooperative view.
4. Send REVOKE COOP. Future partner access is denied.
5. Commercial participation is a separate dashboard choice, off by default.
6. Industry insights withholds results: this workspace has one farm, below the five-farm demonstration threshold.

## Connect the central pilot
Configure server-only Vercel variables listed in .env.example:
- UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN: your durable Redis REST service.
- DEPOT_ENCRYPTION_KEY: 32 cryptographically random bytes encoded in hex. Back up securely; losing it loses data access.
- DEPOT_ACCESS_JSON: array of {tokenHash, farm, role}, where tokenHash is SHA256 of a random token of at least 32 characters. role is farmer or partner. A partner entry also needs recipient: COOP.
- SMS_FARM_MAP_JSON: map verified E.164 numbers to the same farm identifiers. Enrol numbers out of band; verify ownership and the cooperative relationship before enabling.
- TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_URL: exact HTTPS POST webhook URL, e.g. https://your-domain/api/sms. Configure the Twilio number's incoming messaging webhook as form-encoded POST to that URL.

Use Connect private depot and your farmer token. Tokens are held in browser memory, not localStorage. The API derives the farm from credentials, never from a client-supplied farm ID. Partner reads use the same endpoint with the partner token and action read; no active grant returns 403.

Stored farm state uses AES-256-GCM with farm-bound additional authenticated data. Redis compare-and-swap updates avoid lost concurrent writes. Message IDs deduplicate retries. Twilio form signatures are checked before processing. Duplicate webhook deliveries return empty TwiML to avoid duplicate replies. Confirmation expires in ten minutes. Rate limiting is per enrolled farm (60 requests/minute). Missing service configuration fails closed.

The SMS endpoint returns TwiML for the provider to reply; no unsolicited outbound SMS API is used. SMS commands cannot enable commercial use or add recipients. Use REVOKE COOP, not the carrier-reserved STOP keyword.

### Outbound SMS (disabled by default)
`SMS_MODE=demo` is the safe default. Authenticated farmer clients may call `POST /api/sms-send` with `{ "action":"consent", "enabled":true }`, then `{ "action":"send", "message":"..." }`; demo responses explicitly report that no message was sent. Consent is stored per farm, can be revoked, and sends are restricted to the verified enrolled farmer E.164 number in `SMS_FARM_MAP_JSON`. The existing per-farm rate limit applies to consent and sends.

For real Twilio delivery, obtain a Twilio Account SID, Auth Token, and an SMS-capable E.164 Twilio number, configure them as server-only variables, set `SMS_MODE=live`, and obtain explicit approval before enabling it. The route reports provider rejection without exposing provider credentials. Do not run live-provider tests against a paid account; use the demo mode and mocked `fetch` tests.

## Deployment
Import jesusvilela/Terraviva in Vercel. Framework: Other. Build: npm run build. Output: dist. API routes in api/ are serverless functions. Browser demo works without secrets; central pilot and live SMS need the variables above. A Twilio webhook must be reachable by Twilio; use an appropriate configured domain without Vercel login interception. Do not expose secrets to the browser or commit .env.

## Scope and limitations
This is an engineering pilot, not a production security certification. It has administrator-issued bearer tokens, not self-service identity, MFA, account recovery or a consent-contract system. SMS phone ownership alone is weak assurance; allow only low-risk pilot records and pre-approved relationships. SMS is not end-to-end encrypted. Supported grammar is English examples, not unrestricted AI language understanding. Dates use UTC. Historical/date-qualified harvest messages are rejected unless they match the documented grammar.

No dataset archive is published. Farmer-entered records are declarations; do not infer verified crop/batch certificates. No file upload, integration connector, payments, live commercial report, arbitrary cohort queries or revenue-share accounting is implemented. Minimum group size is a demonstration safeguard, not proof of anonymisation. A production report needs disclosure analysis and repeated-query protection.

The per-farm encrypted document and deduplication history grow with use: suitable for a bounded pilot, requiring event-table storage and retention policy for scale. Event history is not tamper-proof. Key rotation, backups/restore, recipient onboarding, telecom configuration and real-provider end-to-end tests remain operational work.

## Verification
Tests cover confirmation/cancellation/expiry, duplicate messages, quantity validation, scoped projection/revocation, distinct-farm aggregate suppression, encryption/tampering, identity selection, a published Twilio signature vector, and mocked central-storage API/SMS flows. External Redis and Twilio integrations need live credentialed verification.

References: https://www.twilio.com/docs/usage/security and https://upstash.com/docs/redis/features/restapi.

