# Vaccination record schema (v1)

Defined in `backend/src/schemas/vaccinationRecord.js`. Canonical names follow the contract's `VaccinationRecord`.

| Field | Issue request | Contract / API record | Indexed mint event |
| --- | --- | --- | --- |
| `schema_version` | optional, must be 1 | required; absent in old records, read as 1 | added on write or read |
| `token_id` | rejected | required; u64 as a string | event topic, not in payload |
| `patient` | required, as `patient_address` | required | required |
| `vaccine_name` | required, at most 100 bytes | required | required |
| `date_administered` | required, ISO date | required | not emitted |
| `issuer` | from signer | required | required |
| `timestamp` | rejected | nullable for old records | optional |
| `revoked` | rejected | defaults to `false` | not emitted |
| `dose_number`, `dose_series` | optional, number <= series | nullable | not emitted |
| `lot_number`, `tx_hash` | rejected | legacy, kept if present | legacy |

Legacy names read as aliases: `patient_address`, `issuer_address`, `tokenId`.
Old index rows with positional keys (`"0"`–`"3"`) are mapped on read.

To evolve: add a new version beside v1 and map old versions forward; never change v1's meaning.
