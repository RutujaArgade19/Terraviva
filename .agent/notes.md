# Implementation checkpoint

- Scope: permissioned farmer data depot, SMS capture/confirmation, dashboard, cooperative access and independent commercial participation.
- Shared deterministic SMS core supports browser simulator and signed Twilio webhook. Storage adapter encrypts per-farm state and uses atomic compare-and-swap.
- Run npm test and npm run build. Start localhost with npm start.
- Repository created from empty upstream. No dataset archive or credentials were committed.
- Missing live service setup is documented in README. No deployed site or real SMS delivery claimed.
- Outbound SMS is isolated in api/sms-send.js. It requires farmer bearer auth, enrolled E.164 phone, persisted opt-in, per-farm rate limiting, and SMS_MODE=live before calling Twilio. Demo mode returns an explicit no-send result.
- Verification for this slice: npm test (11 pass), npm run build, git diff --check.
- Browser demo now seeds Terra.demo() on first visit: three illustrative harvests, active COOP access, and four activity events; commercial participation remains off and the UI labels the data as illustrative/sample-only.
