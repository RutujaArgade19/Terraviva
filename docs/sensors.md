# Farmer sensor wallet pilot

Terraviva can receive sensor readings through an authenticated HTTPS endpoint and return them to the owning farmer. Readings live in the existing encrypted private depot under that farmer’s identity. The reference datasets remain separate.

This is a small HTTP ingestion pilot. No physical device, field gateway, MQTT broker or vendor account is connected by the repository itself. A deployed endpoint requires the existing Redis and encryption configuration, enrolled device credentials, and a gateway or device that submits the documented requests. The farmer interface reads connected data with a farmer credential; its local demonstration does not imply a hardware connection.

## Credentials and enrollment

Use the existing private-depot variables `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `DEPOT_ENCRYPTION_KEY` and `DEPOT_ACCESS_JSON`. Add a server-only `SENSOR_DEVICE_ACCESS_JSON` array. It is empty by default.

Each enrollment has these fields:

| Field | Meaning |
| --- | --- |
| `tokenHash` | SHA-256 hex digest of a separate ingest credential, never the credential itself |
| `farm` | Existing farmer identity, using 1–80 ASCII letters, digits, underscores or hyphens |
| `deviceId` | Stable identity of the device or gateway, using the same character limits |
| `label` | Optional human-readable label, at most 120 characters |
| `field` | Optional fixed field name; when present, every submitted reading must match it exactly |
| `enabled` | Optional boolean; `false` disables new submissions without deleting historical readings |

Provision a distinct secret credential of at least 32 characters outside this repository and place its hash in the enrollment. Give the secret only to the submitting device or gateway. Do not place it in source control, public build variables, a URL or the farmer interface. The API rejects duplicate token hashes, duplicate farm/device enrollments, malformed identities, and reuse of a farmer or partner credential as an ingest credential. Removing or disabling an enrollment stops future ingestion; it does not delete earlier readings.

A gateway credential represents one enrolled `deviceId`. It can submit several supported measurements. If it represents a fixed field, configure that field binding. An enrollment without a fixed field accepts explicit field names within its authenticated farm; no geographic or parcel ownership is inferred from those names.

## Submit readings

Send `POST /api/sensors` with `Content-Type: application/json` and `Authorization: Bearer <ingest-credential>`. The body contains only a `readings` array. This is an illustrative payload, not a measured observation:

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

The server obtains `farm` and the authorized device from the credential. A payload cannot override the farm, device scope, configured field, consent, sharing grants or receiver time. Unsupported fields are rejected. A receiver-assigned `receivedAt` is added after validation.

`observedAt` requires a valid calendar date, seconds and an explicit timezone: `Z` or an offset such as `+02:00`. Fractional seconds may contain up to three digits. The original valid timestamp text is retained. Observations more than five minutes ahead of receiver time are rejected. Delayed readings and out-of-order observations are accepted; there is no requirement for a device to maintain a continuous connection. The gateway must keep unsent records itself and retry later—the service cannot retrieve data that was never submitted.

Values may be finite JSON numbers or finite numeric text. Numeric text such as `"23.500"` and `"00023.500"` is retained exactly. JSON numbers are stored using their canonical JavaScript string representation. No unit conversions, rounding, calibration or interpolation are performed.

### Supported measurements

| `measurement` | Exact accepted `unit` |
| --- | --- |
| `air_temperature` | `°C` |
| `soil_temperature` | `°C` |
| `soil_moisture` | `%` |
| `relative_humidity` | `%` |
| `rainfall` | `mm` |
| `soil_ph` | `pH` |
| `electrical_conductivity` | `dS/m` |
| `battery_voltage` | `V` |
| `wind_speed` | `m/s` |
| `solar_radiation` | `W/m²` |

The whitelist is a pilot input contract, not a statement that all devices produce interchangeable measurements. In particular, `%` does not identify whether a soil-moisture measurement is volumetric, gravimetric or a vendor-derived scale. That basis and any calibration are not represented by this initial model. Do not compare such readings across devices without the missing metadata. Rainfall intervals, sensor depth and other measurement context also need an extended schema before corresponding agronomic interpretations are reliable.

Quality is sender-reported: `unverified`, `ok`, `suspect` or `invalid`. An omitted quality becomes `unverified`. `ok` does not mean a farmer approved the reading or that Terraviva verified a calibration. A numerically valid reading marked `invalid` remains available with its flag. Numeric range plausibility and agronomic validation are not implemented.

### Retries and conflicts

A reading is identified by `(deviceId, id)` within its authenticated farm. Repeating that identity with the same normalized fields is an idempotent retry. It does not add a row or change the original `receivedAt`. Reusing it with a different timestamp, value, field, measurement, unit or quality returns `409`.

A batch is atomic. Any invalid reading, conflicting identity or capacity failure rejects the entire batch. Existing readings are neither overwritten nor removed. Exact duplicate entries within a valid batch are acknowledged as duplicates.

New readings return `201`; an entirely repeated batch returns `200`. The response identifies the authenticated farm/device and includes `accepted`, `duplicates`, `totalReadings`, `capacity` and receipts for the submitted readings. It does not expose unrelated readings or private-depot state. The ingest credential cannot use the farmer read endpoint.

## Read the farmer’s sensor data

Send `GET /api/sensors` with the farmer’s existing bearer credential from `DEPOT_ACCESS_JSON`. Only `role: "farmer"` is accepted. Partner tokens are rejected even if a harvest-sharing grant is active. Ingest credentials are rejected for this read operation.

The response contains:

| Property | Meaning |
| --- | --- |
| `farm` | Identity established by the farmer credential |
| `devices` | That farm’s enrolled device metadata, excluding token hashes |
| `readings` | All stored sensor readings for that farm, in receipt order |
| `capacity`, `remaining` | The sensor row limit and remaining row slots |
| `stateBytes`, `maxStateBytes` | Current whole-depot UTF-8 JSON size and its independent byte limit |
| `role` | `private-sensor-data` |
| `commercialUse` | `not-enabled-by-this-module` |

The reading array retains both observation time and receiver time. Consumers can sort by `observedAt` for a timeline while keeping receipt order available for diagnosing delayed submissions.

## Storage and limits

The encrypted farmer state gains `sensors: { "version": 1, "readings": [...] }`. The AES-GCM storage adapter and Redis compare-and-swap update already used by the depot also protect sensor writes. A compare-and-swap retry applies the same deterministic reading identity rules. No in-memory server fallback is used when Redis or encryption is unconfigured.

| Pilot limit | Value |
| --- | ---: |
| Readings per submitted batch | 500 |
| Request body | 256 KiB |
| Stored sensor readings per farmer | 10,000 |
| Entire farmer depot as plaintext UTF-8 JSON | 3 MiB |
| Requests per farm | Existing shared limit of 60 per minute |
| Future observation tolerance | 5 minutes |

Both the row and byte limits apply. The byte budget includes harvest records, permissions, audit state and sensors; long text can exhaust it before 10,000 readings. The whole-depot limit is checked before encryption and before the Redis compare-and-swap write. It leaves headroom for the existing state-bearing response envelopes and the sensor device inventory.

Capacity exhaustion returns `507` with an explicit message. It does not evict old data, silently stop recording, or partially save a batch. Exact retries remain valid when row capacity is full. Exporting data alone does not free capacity. This pilot has no delete/retention operation; larger or ongoing feeds need a designed storage expansion or migration before reaching the limit. A device should retain and surface failed submissions instead of assuming receipt.

Authentication or enrollment does not prove a reading’s physical origin. This pilot does not implement signed device telemetry, hardware attestation, vendor ingestion adapters, scheduled pulls, MQTT, calibration management or automated agronomic alerts.

## Permissions and commercial use

Sensor ingestion changes only the sensor portion of the farmer state. It preserves harvest records, sharing grants, the commercial preference, SMS state and other existing depot properties. Existing cooperative projection and aggregate code operate on harvest records and do not include sensors. Setting a farm’s existing commercial preference does not add sensor readings to an aggregate product through this module.

There is no sensor-sharing or sensor-commercial-use permission implemented yet. Those require their own scoped grant and enforcement path before becoming product features.

## Verification

```sh
node --test test/sensors.cjs
```

Tests use explicitly synthetic credentials and an isolated mocked Redis transport. They cover farmer/device/partner separation, cross-farm and cross-device attempts, field binding, encrypted storage, null/configuration failures, malformed requests, strict units/timestamps, delayed records, exact retries, conflicts and atomicity, consent/grant preservation, and row/UTF-8 byte capacity. They demonstrate software behavior; they do not constitute a live hardware connection test.
