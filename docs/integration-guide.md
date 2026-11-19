# VacciChain Integration Guide

This guide is for third-party systems — schools, employers, border agencies — that need to verify a person's vaccination status using the VacciChain API.

**Base URL:** `https://api.vaccichain.io` (replace with your deployment URL)

---

## Overview

Most integrators only need the single public endpoint:

```
GET /verify/:wallet
```

No authentication is required. If you need to call authenticated endpoints (e.g., to build a dashboard that fetches records on behalf of a user), you must first complete the SEP-10 auth flow to obtain a JWT.

---

## 1. Public Verification (No Auth Required)

The simplest integration. Given a patient's Stellar wallet address, returns their vaccination status and records.

### Request

```
GET /verify/GABCDEF...
```

The wallet address must be a valid Stellar public key: starts with `G`, 56 characters, base32.

### Response — vaccinated

```json
{
  "wallet": "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "vaccinated": true,
  "record_count": 2,
  "records": [
    {
      "token_id": "tok_001",
      "vaccine_name": "COVID-19 mRNA",
      "date": "2024-03-15",
      "issuer": "GISSUERADDRESS..."
    },
    {
      "token_id": "tok_002",
      "vaccine_name": "Influenza",
      "date": "2024-10-01",
      "issuer": "GISSUERADDRESS..."
    }
  ]
}
```

### Response — no records

```json
{
  "wallet": "GABCDEF...",
  "vaccinated": false,
  "record_count": 0,
  "records": []
}
```

### JavaScript example

```js
async function checkVaccination(walletAddress) {
  const res = await fetch(`https://api.vaccichain.io/verify/${walletAddress}`);
  if (!res.ok) {
    const { error } = await res.json();
    throw new Error(error);
  }
  return res.json();
}

const status = await checkVaccination('GABCDEF...');
console.log(status.vaccinated); // true | false
```

### Python example

```python
import httpx

def check_vaccination(wallet_address: str) -> dict:
    r = httpx.get(f"https://api.vaccichain.io/verify/{wallet_address}")
    r.raise_for_status()
    return r.json()

status = check_vaccination("GABCDEF...")
print(status["vaccinated"])  # True | False
```

---

## 2. Authenticated Access via SEP-10

Required only if you need to call endpoints that require a JWT (e.g., `GET /vaccination/:wallet`). The flow has two steps: get a challenge, sign it, exchange for a JWT.

### Step 1 — Request a challenge

```
POST /auth/sep10
Content-Type: application/json

{ "public_key": "GCLIENTPUBLICKEY..." }
```

**Response:**

```json
{
  "transaction": "<XDR-encoded transaction>",
  "nonce": "GNONCE..."
}
```

The `transaction` is a Stellar transaction XDR that your wallet must sign. It expires in **5 minutes**.

### Step 2 — Sign the transaction

Sign the XDR transaction with the private key corresponding to `public_key`. With Freighter in a browser context this happens via the extension API. For server-side integrations, use the Stellar SDK directly.

### Step 3 — Exchange for a JWT

```
POST /auth/verify
Content-Type: application/json

{
  "transaction": "<signed XDR>",
  "nonce": "GNONCE..."
}
```

**Response:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "publicKey": "GCLIENTPUBLICKEY...",
  "role": "patient"
}
```

The JWT is valid for **1 hour**. Include it in subsequent requests:

```
Authorization: Bearer <token>
```

### JavaScript example (full SEP-10 flow)

```js
import * as StellarSdk from "@stellar/stellar-sdk";

async function authenticate(keypair) {
  // Step 1: get challenge
  const challengeRes = await fetch("https://api.vaccichain.io/auth/sep10", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ public_key: keypair.publicKey() }),
  });
  const { transaction, nonce } = await challengeRes.json();

  // Step 2: sign
  const tx = new StellarSdk.Transaction(transaction, StellarSdk.Networks.TESTNET);
  tx.sign(keypair);

  // Step 3: exchange for JWT
  const verifyRes = await fetch("https://api.vaccichain.io/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR(), nonce }),
  });
  const { token } = await verifyRes.json();
  return token;
}
```

### Python example (full SEP-10 flow)

```python
import httpx
from stellar_sdk import Keypair, Network, Transaction

def authenticate(keypair: Keypair) -> str:
    base = "https://api.vaccichain.io"

    # Step 1: get challenge
    r = httpx.post(f"{base}/auth/sep10", json={"public_key": keypair.public_key})
    r.raise_for_status()
    data = r.json()
    transaction_xdr, nonce = data["transaction"], data["nonce"]

    # Step 2: sign
    tx = Transaction.from_xdr(transaction_xdr, network_passphrase=Network.TESTNET_NETWORK_PASSPHRASE)
    tx.sign(keypair)

    # Step 3: exchange for JWT
    r = httpx.post(f"{base}/auth/verify", json={"transaction": tx.to_xdr(), "nonce": nonce})
    r.raise_for_status()
    return r.json()["token"]
```

---

## 3. Error Reference

All errors return JSON with an `error` string field. The `error` string is a **stable, machine-readable code** — integrators may branch on it. Human-readable detail, when present, is returned in a separate `message` field and may change without notice; never parse `message`.

### 3.1 Contract error codes

Contract-level failures are mapped by the backend to stable API responses. The mapping below is part of the public contract: a given contract error code always produces the same HTTP status and `error` code.

| Contract error code | HTTP status | `error` code | Cause | Action |
|---------------------|-------------|--------------|-------|--------|
| `Unauthorized` | `403` | `unauthorized` | Caller is not the issuer/owner authorized for this operation | Authenticate as the correct issuer |
| `ConsentRequired` | `403` | `consent_required` | Patient has not granted consent for this operation | Request consent from the patient |
| `ConsentRevoked` | `403` | `consent_revoked` | Patient revoked consent; operation no longer permitted | Stop issuing/reading; re-request consent |
| `NotAllowlisted` | `403` | `not_allowlisted` | Issuer is not on the patient's allowlist | Patient must allowlist the issuer |
| `AlreadyIssued` | `409` | `already_issued` | A record for this vaccine/date already exists | Treat as idempotent success or surface to user |
| `NotFound` | `404` | `not_found` | Referenced record or token does not exist | Verify the identifier |
| `InvalidArgument` | `400` | `invalid_argument` | Contract argument failed validation | Fix the request payload |
| `NotInitialized` | `503` | `contract_not_initialized` | Contract not yet initialized on this network | Retry later; contact support if persistent |

> **Compatibility note:** new contract error codes may be added in future versions. Unknown codes are mapped to `500` with `error: "contract_error"` and the raw code in `contract_error_code`. Treat any unrecognized `error` value as a generic failure rather than crashing.

### 3.2 API-level errors

| Status | Error message | Cause | Action |
|--------|--------------|-------|--------|
| `400` | `public_key required` | Missing `public_key` in `/auth/sep10` body | Include `public_key` |
| `400` | `Invalid Stellar public key` | Malformed key (not `G...` 56-char base32) | Validate key format before sending |
| `400` | `wallet must be a valid Stellar public key (G... 56-char base32)` | Bad wallet in `/verify/:wallet` | Check the address format |
| `400` | `transaction and nonce required` | Missing fields in `/auth/verify` body | Include both fields |
| `401` | `Challenge transaction has expired` | More than 5 minutes elapsed since challenge was issued | Restart from Step 1 |
| `401` | `Client signature missing or invalid` | Transaction was not signed with the correct private key | Re-sign with the matching keypair |
| `401` | `Invalid server signature` | Transaction was tampered with | Do not modify the XDR before signing |
| `403` | `unauthorized` / `consent_required` / `consent_revoked` / `not_allowlisted` | See §3.1 | See §3.1 |
| `429` | `Too many requests` | Rate limit exceeded (10 req/min for `/auth/sep10`, 60 req/min for `/verify`) | Back off and retry after `retryAfter` seconds |
| `500` | `<message>` | Unexpected server or contract error | Log and retry; contact support if persistent |

### Handling rate limits

The `429` response includes a `retryAfter` field (seconds). The response also sets the standard `RateLimit-*` headers.

```js
async function verifyWithRetry(wallet, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(`https://api.vaccichain.io/verify/${wallet}`);
    if (res.status === 429) {
      const { retryAfter } = await res.json();
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    return res.json();
  }
  throw new Error("Rate limit retries exhausted");
}
```

```python
import time, httpx

def verify_with_retry(wallet: str, retries: int = 3) -> dict:
    for _ in range(retries):
        r = httpx.get(f"https://api.vaccichain.io/verify/{wallet}")
        if r.status_code == 429:
            time.sleep(r.json()["retryAfter"])
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError("Rate limit retries exhausted")
```

---

## 4. Bulk Verification

For batch use cases (e.g., checking a list of students), use the analytics service:

```
POST http://localhost:8001/batch/verify
Content-Type: application/json

{
  "wallets": [
    "GABCDEF...",
    "GHIJKLM..."
  ]
}
```

**Response:**

```json
[
  { "wallet": "GABCDEF...", "vaccinated": true },
  { "wallet": "GHIJKLM...", "vaccinated": false }
]
```

---

## 5. Consent and Allowlist Semantics

Issuance and verification are gated by two independent controls: the patient's **allowlist** (which issuers may issue to them) and the patient's **consent** (whether a given issuer may act on their records). Both are enforced at the contract level and surfaced by the API.

### 5.1 Consent states

| Consent state | Issuance by issuer | Authenticated read | Public `/verify/:wallet` |
|---------------|--------------------|--------------------|--------------------------|
| **Absent** (never granted) | Rejected — `403 consent_required` | Rejected — `403 consent_required` | Returns `vaccinated: false` (no records) |
| **Granted** | Allowed | Allowed | Returns status with permitted fields only |
| **Revoked** | Rejected — `403 consent_revoked` | Rejected — `403 consent_revoked` | Returns `vaccinated: false` (no records) |
| **Changed** (re-granted after revoke) | Allowed under the new grant | Allowed under the new grant | Returns status with permitted fields only |

State transitions:

- `absent → granted` when the patient grants consent to an issuer.
- `granted → revoked` when the patient revokes consent; any in-flight issuance is rejected.
- `revoked → granted` when the patient re-grants; the new grant supersedes the old one.

### 5.2 Allowlist semantics

- An issuer not on the patient's allowlist receives `403 not_allowlisted` on issuance.
- Allowlisting is a prerequisite for consent: consent can only be granted to an allowlisted issuer.
- Removing an issuer from the allowlist behaves like revocation for future operations; previously issued records remain on-chain.

### 5.3 What public verification reveals

Public verification is **not** a privacy guarantee for on-chain data. Records are soulbound and publicly readable on the Stellar ledger. The `/verify/:wallet` endpoint deliberately **omits prohibited fields** — it never returns patient identity data, consent state, allowlist membership, or issuer-private metadata. It returns only the fields documented in §1 (`wallet`, `vaccinated`, `record_count`, and permitted record fields).

Integrators must not assume that the absence of a field in the API response means the underlying data is private on-chain.

---

## 6. Security Notes

- Vaccination records are **soulbound on-chain** — they cannot be transferred or forged at the contract level. A positive `vaccinated: true` response is cryptographically guaranteed.
- Always verify the wallet address belongs to the person presenting it through your own identity verification process. VacciChain confirms the record exists on-chain; it does not confirm identity.
- Public-chain data is **not private**: on-chain records are readable by anyone. The API omits prohibited fields, but do not treat on-chain data as confidential.
- JWTs are scoped by role (`patient` or `issuer`) and expire after 1 hour.
- SEP-10 nonces are single-use. A replayed challenge will be rejected with `401`.
