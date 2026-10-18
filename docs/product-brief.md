# Terraviva — farmer data, under farmer control

## Problem statement

Farmers share information with buyers, cooperatives, advisers, certification bodies and public authorities to meet business, compliance and sustainability reporting requirements. The same information is often requested in different formats and entered repeatedly. This creates administrative work while leaving farmers with limited visibility over who uses their data, for what purpose and for how long.

Terraviva aims to reduce that burden and return useful value to the farmer. Each farm would have one place to organise its records, documents and sensor readings, review their quality and authorise specific uses. Information collected once could support several reporting needs without giving every recipient unrestricted access to the farm's data.

## Datasets selected

Our product ambition is to support all relevant datasets made available for the hackathon, so that different value chain partners can receive the information they need in the right context. These reference datasets would also help us develop reporting, data validation and optional benchmarking features.

The current verified snapshot contains **28 retrieved CSV sources**, with **1,754,685 source-table rows** and **804 field occurrences**. The row total includes overlapping views of the same underlying records. It is not a count of distinct farm events. The original archive's complete inventory has not been verified, so this snapshot must not be described as the complete publisher release. The data report records 44 additional observed filenames whose contents were not retrieved.

The collection covers farm structure and reporting, parcel operations, sales and certification, livestock and animal products, regional context, and source provenance. Synthetic, modelled, static and regional values retain their original meaning. Reference records are not automatically assigned to a real farmer and do not establish that farmer's consent, performance or ownership of a sensor.

The measured source inventory and limitations are documented in the [data guide](../data/README.md), [reference verification record](../data/reference-verification.json) and the generated HTML data report.

## Planned solution approach

Terraviva is a modular farmer data wallet. It brings a farm's records, documents and connected sensor readings together, with access through a dashboard, simple field messaging and assisted services where needed. Farmers enter information once, or authorise its automatic collection, then review it and reuse it across approved reporting tasks.

The intended experience is accessible, multilingual and able to accept different media. Short messages can support field work; documents, photos and voice can support cases where a structured form is inconvenient. The present SMS pilot has a limited English command grammar. Multilingual conversation, voice and document understanding remain development work.

### A useful home for each farm's data

The wallet should organise information by farm, field, time and source. A farmer should be able to see where a record came from, correct an error and understand whether a value was entered by a person, imported from a file, measured by a device or derived by an analytical process. Original evidence and subsequent corrections should remain distinguishable.

The immediate benefit is practical: less repeated entry, easier preparation of reports and a clearer view of the farm's own activity. The quality of those outputs depends on the available records and their meaning; a regional estimate, for example, cannot be presented as a measurement from the farmer's own field.

### Automatic collection of each farmer's sensor data

Sensor collection is a core requirement. A farmer should be able to enrol devices or authorise a gateway or provider to send readings into that farm's wallet. Examples include soil moisture, temperature, rainfall and equipment measurements, subject to the device and connector capabilities actually supported.

Each reading needs a farm association established by the enrolled connection, a device identity, an observation time, a measurement type, a value, an explicit unit and provenance. Recording the time of receipt as well as the time of observation allows the system to recognise delayed uploads. Field assignments and calibration context should be available when relevant.

The collection service should support intermittent connectivity: devices or gateways retain readings while offline and retry after a connection becomes available. Terraviva must recognise repeated delivery of the same reading and flag conflicting reuse of an identifier. Device buffering, transmission and provider authentication require a suitable connector or gateway; an HTTP intake endpoint alone does not establish that a physical sensor is connected.

Farmer review must be practical at sensor volume. Farmers should be able to approve the device association and collection rules, review summaries or batches, and resolve flagged exceptions. They should not have to confirm every routine reading individually. Automated checks and a farmer's review are separate facts, and neither is proof that a sensor is calibrated or that every reading is accurate.

### Permissioned reuse

The target permission model describes the recipient, the data fields, the purpose, the duration and any permitted onward use. Farmers should be able to inspect active grants and revoke future access. A recipient receives only the authorised information through an enforced access path.

The product must present these as separate choices:

| Choice | What the farmer authorises |
| --- | --- |
| Store and process my farm data | Use the wallet and its own-farm services, including authorised sensor collection. |
| Share identifiable records | Give a named recipient scoped access for an agreed purpose and period. |
| Participate in benchmarking | Contribute approved data to defined aggregate comparisons and receive the available results. |
| Participate in a commercial aggregate product | Allow a disclosed aggregate use under its own terms and farmer benefit arrangements. |

Recording a harvest or connecting a sensor must not silently enable a new sharing grant or commercial use. Revocation controls future access; the product must also explain any limits on recalling information that a recipient has already received under an authorised grant.

### Optional benchmarking and a commercial DataMart

Farmers could opt into comparisons with appropriate groups of participating farms. A comparison needs consistent units, compatible time periods and a clear description of the contributing population. The product should withhold a result when the available data cannot support a meaningful or sufficiently protected comparison.

A separate DataMart is planned for approved aggregate reports, dashboards or datasets for third parties and industry. Removing names alone is insufficient. The design needs minimum group sizes, suppression of revealing results, suitable geographic and time aggregation, and controls that limit disclosure through repeated or overlapping queries. These controls require implementation and evaluation for each product; the pilot's small-group demonstration is not proof of anonymisation.

Commercial analytics are a proposed revenue stream. Their contribution to the business depends on customer demand, operating costs, permitted uses and the value returned to participating farmers. Dashboard access, reduced fees and revenue sharing are options to evaluate. The farmer benefit model and commercial terms remain decisions to make, rather than established sources of financial sustainability.

### Local advisers and accessible support

Local advisers can help farmers who have limited connectivity, suitable equipment, time or confidence with digital tools. Their role includes onboarding, explaining permissions, checking imports and helping resolve data-quality problems in the farmer's preferred language.

Assistance must preserve the farmer's agency. An adviser should receive an explicit, limited role for the farms and activities they support. Adviser access should be visible, reviewable and revocable. Assisted entry should identify the person who entered a record and the farmer's review status. Offline capture and later synchronisation are intended capabilities; local operating arrangements and connected workflows need to be developed and tested.

## Implementation boundary

This brief describes the product direction as well as the engineering pilot. The distinction matters when demonstrating the application or describing it to partners.

| Area | Current engineering position | Further work for the intended product |
| --- | --- | --- |
| Reference data | The 28 retrieved sources have been preserved and fully profiled, with a queryable SQLite snapshot and a complete paginated reference explorer. | Retrieve and verify additional source files; maintain versioned source updates and documented usage rights. |
| Farmer records | The pilot supports harvest confirmation, explicit file import, a farmer dashboard and an encrypted server storage adapter. A browser demonstration also works without service credentials. | Broader farm record types, documents, reliable identity and account management, operational backup and recovery. |
| SMS | A signed provider webhook and bounded English command patterns support harvest capture and routine cooperative permissions when the required services are configured. | Live provider validation, additional languages, better ambiguity handling and accessible multimodal interfaces. |
| Permissions | The pilot has a defined cooperative sharing path, expiry and revocation, plus a separate commercial participation setting. | A complete purpose- and field-based grant system, versioned agreements, additional recipients and adviser delegation. |
| Sensors | The pilot implements device credentials bound to a farm, authenticated batch intake, encrypted storage and a farmer sensor view. Tests cover access isolation, delayed observations, retries, conflicts and atomic capacity limits. Hardware connections and provider credentials have not been supplied. | Operational device enrolment, connector-specific integration, live device testing, calibration context, farmer review workflows and storage suitable for sustained sensor volume. |
| Benchmarking and DataMart | The pilot demonstrates withholding results when the participating group is too small. | Defined opt-in cohorts, validated aggregate products, disclosure controls, usage terms and an agreed farmer benefit model. |

Repository and deployment status should be verified separately before describing any module as live. The presence of a storage adapter, webhook or intake route does not establish that the corresponding external service is configured or that a real farmer's device has sent data.

## Demonstration narrative

The demonstration should show a complete, understandable journey: a farmer records a harvest in the field, confirms it and sees it in the wallet; a separately labelled sensor example demonstrates how a device reading enters the same farm context; the farmer reviews provenance and quality; an approved cooperative receives only its permitted view until the grant expires or is revoked.

The reference-data explorer and data report demonstrate what has actually been retrieved and analysed. Benchmark or industry results must be labelled according to their evidence. Illustrative outputs should be clearly marked, and an insufficient cohort should produce a withheld result.

## Short pitch

Terraviva gives farmers a useful home for their records, documents and sensor data, with control over how that information is reused. Farmers enter information once or collect it automatically, review its quality and share the right data with the right partner for an agreed period. Accessible field messaging and local advisers help more farmers participate. With separate permission, participating farms can also benefit from benchmarking and carefully governed aggregate data products.
