# Implementation checkpoint

- Scope: permissioned farmer data depot, SMS capture/confirmation, dashboard, cooperative access and independent commercial participation.
- Shared deterministic SMS core supports browser simulator and signed Twilio webhook. Storage adapter encrypts per-farm state and uses atomic compare-and-swap.
- Run npm test and npm run build. Start localhost with npm start.
- Repository created from empty upstream. No dataset archive or credentials were committed.
- Missing live service setup is documented in README. No deployed site or real SMS delivery claimed.
- Outbound SMS is isolated in api/sms-send.js. It requires farmer bearer auth, enrolled E.164 phone, persisted opt-in, per-farm rate limiting, and SMS_MODE=live before calling Twilio. Demo mode returns an explicit no-send result.
- Verification for this slice: npm test (11 pass), npm run build, git diff --check.
- The remote sensor release requires the main browser demo to remain empty for sensor isolation; the illustrative farmer wallet lives in the presentation-only public/pitch.html instead.
- The SMS integration is split intentionally into signed inbound /api/sms and authenticated outbound /api/sms-send. The latter is demo-safe unless SMS_MODE=live and server-side Twilio variables are configured.
- The coherent pitch surface is public/pitch.html with click-through journey and simulated SMS; it never sends a message.
- Verification after reconciliation: npm test (138 pass), npm run build, git diff --check.
