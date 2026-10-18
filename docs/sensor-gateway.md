# Collect sensor observations through a field gateway

`scripts/sensor-gateway.py` supplies the sender side of the [farmer sensor wallet](sensors.md). A hardware driver or provider integration maps real observations to Terraviva JSON, invokes `enqueue`, and the sender keeps them on local disk until the server returns a complete matching receipt. `run` drains newly queued observations and retries temporary network failures, including after connectivity returns.

The script uses Python 3.10 or newer and its standard library, including SQLite. It does not discover sensors, read hardware, connect to a vendor account, poll provider APIs or subscribe to MQTT. Those integrations must supply the observations. No physical feed is connected by installing this script.

## 1. Provision the receiver and bind the local queue

First configure the server's Redis/encryption storage and enroll a **separate ingest credential** as described in [Credentials and enrollment](sensors.md#credentials-and-enrollment). Confirm its farm, device and optional field mapping with the administrator. A farmer-read credential is not an ingest credential.

Create one queue per enrolled farm/device. Run these commands from the checkout on the gateway computer. The device and farmer IDs below are placeholders; replace them with the actual enrollment:

```sh
python3 scripts/sensor-gateway.py \
  --db "$HOME/.local/state/terraviva/probe-north.sqlite3" init \
  --endpoint https://terraviva-ruddy.vercel.app/api/sensors \
  --device-id probe-north \
  --farm farmer-a
```

`init` creates a private directory and database if absent. It binds the database permanently to that endpoint, device and **expected receipt farm**. Repeating the same initialization is harmless; a different binding is rejected without changing existing observations. Use a different private queue for another device or farm. Do not share one queue across tenants.

**The credential still determines the server's farm.** Expected-farm validation detects a wrong enrollment **after submission** and stops the sender, but cannot undo a write already made under that credential. There is no device-authenticated preflight/read endpoint. Verify enrollment before submitting real data; local binding is an additional mismatch detector, not a replacement for server authorization.

The URL must use HTTPS and end at `/api/sensors`, without embedded credentials, query parameters or fragments. TLS certificate checks remain enabled. Redirects, including redirects to another HTTPS host, are never followed.

## 2. Enqueue actual observations

The input contract is one UTF-8 JSON file containing either an array or `{ "readings": [...] }`. `--input -` reads the same format from standard input. JSONL and CSV are not accepted by this initial sender. Each input is limited to 16 MiB and is enqueued atomically.

This example describes the shape only; it is **illustrative, not a measured reading**:

```json
{
  "readings": [
    {
      "id": "probe-north-20261017T100000-moisture",
      "deviceId": "probe-north",
      "field": "North Field",
      "observedAt": "2026-10-17T10:00:00Z",
      "measurement": "soil_moisture",
      "value": "23.500",
      "unit": "%",
      "quality": "unverified"
    }
  ]
}
```

After the upstream integration has written a real mapped file outside the repository:

```sh
python3 scripts/sensor-gateway.py \
  --db "$HOME/.local/state/terraviva/probe-north.sqlite3" enqueue \
  --input /path/to/mapped-observations.json
```

The command reports counts only. The integration should keep its source observations until `enqueue` succeeds. It can safely repeat the same file: an existing identical ID/content pair is counted as a duplicate, including after successful delivery. Reusing an ID with different normalized content rejects the entire input. The sender never invents IDs or silently renames a conflicting observation. Preserve the original device/provider observation ID, or define a stable identity for each measurement upstream; generating a fresh ID on every retry would create duplicates.

All rows must have the bound `deviceId`. The server additionally enforces any enrolled field restriction. The supported measurements, exact units and field semantics are listed in the [receiver contract](sensors.md#supported-measurements).

- Numeric **text** retains its exact form, such as `"00023.500"`. JSON numeric values are parsed with decimal precision and converted to numeric text before transmission, avoiding Python/JavaScript floating-point formatting differences. Quote identifiers, including large numeric-looking IDs. Values must fit the receiver's finite numeric range.
- An omitted quality becomes `unverified`. Quality remains sender-reported; it is not farmer approval or calibration evidence.
- Observation times retain their original text and timezone. The sender accepts calendar years 0001–9999, requires explicit timezone and seconds, and rejects observations over five minutes ahead of its clock. The server independently checks against its own clock. Keep gateway time synchronized.
- Late and out-of-order readings remain queued in arrival order; no age filter discards them. There is no interpolation, unit conversion or agronomic interpretation.

## 3. Supply a credential and start sending

Provision the secret through the gateway's secret-management process into a private file, for example `$HOME/.config/terraviva/probe-north.token`. On POSIX systems it must belong to the running account and have mode `0600`; keep its directory private as well. Alternatively inject `TERRAVIVA_SENSOR_TOKEN` into the process environment. `--token-env NAME` selects another environment variable **by name**.

Do not pass a token as a command argument, put it in an input file, commit it, or use a public frontend environment variable. The sender does not persist credentials or credential hashes in SQLite, and does not print request bodies, response bodies or credential values.

For a bounded send attempt:

```sh
python3 scripts/sensor-gateway.py \
  --db "$HOME/.local/state/terraviva/probe-north.sqlite3" flush \
  --token-file "$HOME/.config/terraviva/probe-north.token"
```

For ongoing collection, keep this process running under the gateway's service manager:

```sh
python3 scripts/sensor-gateway.py \
  --db "$HOME/.local/state/terraviva/probe-north.sqlite3" run \
  --token-file "$HOME/.config/terraviva/probe-north.token" \
  --interval 30
```

The upstream integration may continue running `enqueue` in another process against the same local queue. SQLite transactions protect concurrent enqueues and acknowledgements. The sender does not hold a database write transaction while waiting for the network. `run` reloads its credential at the start of each cycle so a properly provisioned file rotation is picked up.

`run` remains in the foreground. Configure the service manager to start it on gateway boot and to surface nonzero exits. Do not configure blind restart loops for permanent configuration/capacity errors. `--cycles N` provides a finite run for diagnostics; the default `0` continues until interrupted. Stopping and restarting retains every unacknowledged observation.

Inspect the local state without a credential:

```sh
python3 scripts/sensor-gateway.py \
  --db "$HOME/.local/state/terraviva/probe-north.sqlite3" status
```

## Delivery behavior and limits

| Behavior | Implementation |
| --- | --- |
| Local durability | SQLite WAL transactions with `synchronous=FULL`, on reliable local storage |
| Server batch | At most 500 observations **and** 256 KiB of UTF-8 JSON including the envelope |
| Default flush work | Up to 20 batches; `--max-batches` permits 1–100 per cycle |
| Network timeout | 10 seconds by default; `--timeout` permits 1–30 seconds per socket operation |
| Temporary failures | Network/TLS/protocol failures, HTTP 408/425/429 and 5xx except 507 |
| Retry budget | Three additional attempts per batch by default; `--retries` permits 0–5 |
| Backoff | Exponential delay; `Retry-After` is honored within a 60-second maximum delay |
| Run interval | 30 seconds by default; configurable from 1–60 seconds |
| Acknowledgement | Only matching HTTP 200/201 receipts for the **entire** submitted batch |

Before acknowledging, the sender checks farm/device, accepted/duplicate counts, capacity and total counts, every submitted field, uniqueness of receipts and valid receiver timestamps. Unexpected, incomplete or malformed success responses stop the sender and leave the whole batch pending. A confirmed row's payload is compacted to an ID/fingerprint and receipt timestamps, so later ID reuse is still detected. These fingerprints are retained indefinitely; there is no automatic local eviction or retention policy.

If the server saves a batch but the reply is lost, the sender resubmits the same IDs and content. The receiver's idempotency rule then returns duplicate receipts. A process interruption after the server reply but before the local acknowledgement has the same recovery behavior. This requires the receiver to retain those identities; it does not protect against server data deletion or a database rollback performed outside the normal protocol.

HTTP 400/401/403/409/507 and other permanent rejections **stop** `flush` and `run` with a nonzero exit code. Pending data is retained. Correct credentials/mapping, resolve conflicts, or expand server capacity before restarting. The sender does not skip a failing row, because that could hide a gap in the farm record. Temporary failures exhaust a bounded flush retry budget; ongoing `run` waits until its next cycle and tries again. A finite run that ends on a temporary failure also returns nonzero.

Exit codes: `0` for completed work (inspect the printed pending count), `2` for local input/configuration/storage errors, `3` for permanent HTTP rejection/redirect, `4` for exhausted temporary failures, `5` for an unverified receipt, and `130` when interrupted.

## Storage and deployment boundaries

**The local queue is not encrypted by this script.** Its files contain farm observations in plaintext, potentially including SQLite journal/history pages after acknowledgement. On POSIX systems the script enforces an owned `0700` parent directory and `0600` database/credential files, rejecting symlinked queue paths and linked files. On Windows, configure equivalent account ACLs yourself; Python mode bits do not establish those ACLs. Use disk encryption and managed backups where needed. The receiver's encrypted depot does not encrypt the gateway disk.

Keep queues, credential files, mapped input files and backups **outside the repository**. Use a reliable local disk, not a network or synchronizing cloud folder. Back up via SQLite's backup facility or while all writers are stopped; copying only the database during WAL activity can miss committed observations. Monitor free disk space and queue depth. Retained fingerprints grow over time, and no background pruning is performed.

The receiver still has a 10,000-reading limit per farmer and a 3 MiB **whole-depot** byte limit. Its farm-wide rate limit is shared with other depot traffic. Buffering improves recovery from interruptions; it does not increase server capacity. Sustained feeds need storage expansion and a retention/export design before hitting these limits.

This sender introduces no sensor-sharing grant, commercial-use permission, calibration model, hardware attestation, SMS sensor query or alerting feature. Sensor data follows the current receiver's private-farmer access rules.

## Verification

```sh
python3 test/sensor-gateway.py
```

Tests use synthetic observations, a temporary local queue and isolated fake transports. They cover crash/restart recovery, reply loss and exact retry, identity conflicts, whole-batch acknowledgement, receipt identity mismatch, Unicode byte batching, concurrent arrival, bounded retry, permanent failure behavior, credential nonpersistence and urllib redirect prevention. They do not send observations to the deployed app or demonstrate a physical sensor connection.
