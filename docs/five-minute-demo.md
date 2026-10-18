# Five-minute Terraviva demo

Open the main app, not the separate pitch page. Fresh visitors and untouched legacy empty browser wallets load fictional Ana Garcia's three harvests (24.30 t), a seven-day COOP grant and activity. Existing edited wallets are preserved. Private depots always use their own data, even when empty.

1. **0:00–1:00 — Dashboard:** meet Ana, a fictional wheat and olive farmer in Valencia. Show recorded harvest totals and the explicitly illustrative sensor snapshot.
2. **1:00–2:00 — Text from the field:** send `Harvested 2 tonnes of wheat from North Field`, then `YES`. This simulator uses the same command engine as the inbound SMS service but sends no SMS.
3. **2:00–3:00 — My data depot:** show the new record and export the wallet. Total is now 26.30 t. Imported and declared harvests are not independently certified.
4. **3:00–4:00 — Permissions:** inspect the cooperative's scoped preview, revoke access, then use `SHARE COOP 7` and `CONFIRM` to restore it. Commercial consent is separate and starts off.
5. **4:00–5:00 — Industry insights:** show the separate five-farm synthetic example: 122 t pooled, 24.4 t mean. Ana is not included. Her real workspace report remains withheld; the demo does not bypass the minimum-group rule.

The sensor simulator and reference-data explorer remain separate tools, not claimed integrations with Ana's wallet. A private connection hides the showcase entirely. The main text console is not an outbound SMS sender; live delivery and Vercel provider configuration require separate verification. No live SMS is needed for this pitch.

Verification: `node --test test/sensor-summary.cjs`, `npm test`, `npm run build`, `git diff --check`.
