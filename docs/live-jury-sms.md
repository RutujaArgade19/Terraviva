# Live jury SMS

From **Add my data → Send a text**, open **Open guarded live SMS**. This is separate from the free simulator.

## Vercel production configuration

Keep all values server-side, never in public JavaScript or NEXT_PUBLIC variables:

- Existing private-depot Redis URL/token and encryption key.
- `DEPOT_ACCESS_JSON`: a farmer token hash mapped to the demo farm (token at least 32 characters).
- `SMS_FARM_MAP_JSON`: the approved E.164 number mapped to that same farm.
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`: SMS-capable sender.
- `SMS_MODE=live` and `SMS_DEMO_ENABLED=true` to enable this feature; set the latter to `false` immediately after the pitch.
- `SMS_DEMO_TO`: the single approved E.164 recipient.
- `SMS_DEMO_CODE_SHA256`: SHA-256 hex digest of a separately chosen presenter code. The code is never embedded in the app. A short code is only an additional confirmation, not the authentication credential. Use a different code from examples published in chat/docs.

Redeploy after changing Vercel environment variables. Local environment variables are not read by the hosted app. Trial Twilio accounts may require recipient verification and country permissions.

## Presenter flow

1. Enter the farmer access token on `/live-sms.html`; preview fetches the fixed message and recipient, without sending.
2. Enter the presenter code, confirm recipient consent and charges, and click **Send one real SMS**.
3. Use **Check delivery status**. Queued/accepted is not delivered. The status lookup requests Twilio's Message resource; it does not send another message.

There is no phone or free-text body input. The fixed message describes the illustrative sample, not private farm data. Explicit consent applies to this one message, not a permanent marketing opt-in. Tokens/codes stay out of browser storage. Reloading clears credentials.

## Safety boundaries

- Farmer authentication is checked before any demo action. Preview also requires the enrolled number to match the server-side allowlist.
- Five code attempts per farm per 15-minute time bucket; three reserved provider attempts globally per UTC day. Redis reserves both the request ID and quota atomically before provider invocation.
- Request IDs are retained for seven days. Replaying an ID does not send twice within that window. Unknown/rejected outcomes still consume the quota; no automatic retry. Inspect Twilio before initiating another attempt.
- The older arbitrary-message live send is disabled; its demo mode remains available.
- These controls cover outbound jury sending only. The separate signed inbound SMS/TwiML reply channel is unchanged and has its own operating costs. Disable its webhook separately if not required for the pitch.
- Never publish the farmer token. A leaked token plus code could spend the daily allowance; disable the feature and rotate credentials if exposed.

Verification: `node --test test/sms-demo-live.cjs`, `npm test`, `npm run build`. Tests stub the provider; they do not send SMS.

Provider semantics: https://www.twilio.com/docs/messaging/api/message-resource
