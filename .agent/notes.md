# Implementation checkpoint

- Scope: permissioned farmer data depot, SMS capture/confirmation, dashboard, cooperative access and independent commercial participation.
- Shared deterministic SMS core supports browser simulator and signed Twilio webhook. Storage adapter encrypts per-farm state and uses atomic compare-and-swap.
- Run npm test and npm run build. Start localhost with npm start.
- Repository created from empty upstream. No dataset archive or credentials were committed.
- Missing live service setup is documented in README. No deployed site or real SMS delivery claimed.
- Outbound SMS is isolated in api/sms-send.js. It requires farmer bearer auth, enrolled E.164 phone, persisted opt-in, per-farm rate limiting, and SMS_MODE=live before calling Twilio. Demo mode returns an explicit no-send result.
- Verification for this slice: npm test (11 pass), npm run build, git diff --check.
- Correction: sensor isolation does not require an empty browser harvest wallet. The main demo now seeds only pristine legacy empty wallets, preserves meaningful saved data, and keeps illustrative sensor cards separate from private sensor records.
- The SMS integration is split intentionally into signed inbound /api/sms and authenticated outbound /api/sms-send. The latter is demo-safe unless SMS_MODE=live and server-side Twilio variables are configured.
- The coherent pitch surface is public/pitch.html with click-through journey and simulated SMS; it never sends a message.
- Verification after reconciliation: npm test (138 pass), npm run build, git diff --check.
- Current correction: 141 tests pass, including returning empty browser state, an SMS-confirmed harvest updating the same wallet, preservation of modified state, and an empty private depot staying empty. Build and diff check pass. Five-minute walkthrough: docs/five-minute-demo.md. No provider call or SMS send performed.
