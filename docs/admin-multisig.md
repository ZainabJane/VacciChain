# Admin Multi-Signature Procedure

> **Issue #83 — Multisig policy validated against deployment configuration.**
> This document is the authoritative record of the deployed signer set and threshold.
> It must stay in lockstep with the Soroban contract configuration and the deployment
> runbook. Any change to signers or threshold requires updating all three together.

## Overview

Critical admin operations in VacciChain require M-of-N approvals before execution:

| Operation | Route | Multi-sig required |
|---|---|---|
| Approve issuer onboarding | `POST /v1/onboarding/applications/:id/review` | Yes |
| Add issuer (direct) | `POST /v1/onboarding/applications/:id/review` | Yes |
| Revoke issuer | `POST /v1/onboarding/applications/:id/review` | Yes |

Multi-sig is enforced at the backend layer via `backend/src/middleware/multiSig.js`. The Soroban contract additionally enforces `require_auth()` on the admin address, providing defence in depth.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `MULTISIG_THRESHOLD` | Number of approvals required (M) | `2` |
| `MULTISIG_KEY_HOLDERS` | Comma-separated wallet addresses allowed to approve | any admin JWT |
| `MULTISIG_PROPOSAL_TTL_MS` | Proposal expiry in milliseconds | `3600000` (1 hour) |

Set `MULTISIG_THRESHOLD=1` to disable multi-sig (single admin sufficient — not recommended for production).

## Deployed Signer Set and Threshold

The deployed configuration is **2-of-3** (M = 2, N = 3). This is the single source of
truth for both the backend (`MULTISIG_THRESHOLD` / `MULTISIG_KEY_HOLDERS`) and the
Soroban contract admin configuration.

| Slot | Role | Wallet address | Added | Notes |
|---|---|---|---|---|
| Signer A | Security lead | `G...SIGNER_A` | 2026-01-15 | Primary approver |
| Signer B | Operations lead | `G...SIGNER_B` | 2026-01-15 | Primary approver |
| Signer C | Compliance lead | `G...SIGNER_C` | 2026-01-15 | Break-glass / recovery approver |

- **Threshold (M):** `2`
- **Signer set (N):** `3` — the addresses above, and no others.
- **Contract alignment:** the Soroban contract's admin signer set and threshold MUST
  match this table exactly. The contract enforces `require_auth()` on the admin
  address; the backend enforces the M-of-N approval flow. Both layers must agree.

### Verifying alignment

Before every deployment, confirm the backend and contract agree:

1. Read `MULTISIG_THRESHOLD` and `MULTISIG_KEY_HOLDERS` from the target environment.
2. Query the deployed contract's admin signer set and threshold.
3. Assert the signer sets are identical and the thresholds are equal (`2`).
4. Record the verification result in the deployment runbook for that release.

If the two disagree, **abort the deployment** and reconcile before proceeding.

## Key Holders

Key holders must be documented in your access-controlled secrets management system. At minimum record:

- Wallet address
- Name / role of holder
- Date added / removed
- Contact for emergency rotation

Restrict `MULTISIG_KEY_HOLDERS` to the minimum set of trusted addresses. Rotate the list immediately if a key holder leaves or a wallet is suspected compromised.

## Multi-Sig Ceremony Procedure

### Step 1 — Initiator submits the operation

The initiator (any admin-role JWT holder) submits the request **without** a `proposal_id`. The backend creates a pending proposal and returns a `202`:

```bash
curl -X POST https://api.example.com/v1/onboarding/applications/<id>/review \
  -H "Authorization: Bearer <initiator-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "decision": "approved" }'
```

Response:
```json
{
  "message": "Multi-sig required. 1 more approval(s) needed.",
  "proposal_id": "550e8400-e29b-41d4-a716-446655440000",
  "approvals": 1,
  "threshold": 2,
  "expires_at": "2026-04-29T15:00:00.000Z"
}
```

### Step 2 — Co-signer approves

Each additional key holder calls the approval endpoint with the `proposal_id`:

```bash
curl -X POST https://api.example.com/v1/admin/multisig/approve \
  -H "Authorization: Bearer <cosigner-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "proposal_id": "550e8400-e29b-41d4-a716-446655440000" }'
```

Response when threshold is reached:
```json
{
  "proposal_id": "550e8400-e29b-41d4-a716-446655440000",
  "operation": "onboarding_review",
  "approvals": 2,
  "status": "approved",
  "expires_at": "2026-04-29T15:00:00.000Z"
}
```

### Step 3 — Initiator executes

Once approved, the initiator re-submits the original request **with** the `proposal_id`:

```bash
curl -X POST https://api.example.com/v1/onboarding/applications/<id>/review \
  -H "Authorization: Bearer <initiator-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "decision": "approved", "proposal_id": "550e8400-e29b-41d4-a716-446655440000" }'
```

The proposal is consumed (single-use) and the operation executes.

### Checking proposal status

```bash
curl https://api.example.com/v1/admin/multisig/proposals/<proposal_id> \
  -H "Authorization: Bearer <admin-token>"
```

## Security Considerations

- **Proposals are single-use**: once consumed by execution they are deleted.
- **Proposals expire**: default 1 hour. Expired proposals must be re-initiated.
- **Audit trail**: every proposal creation, approval, and execution is written to the audit log.
- **In-process storage**: proposals are stored in memory. For multi-instance deployments, replace the `Map` in `multiSig.js` with a shared Redis store.
- **Threshold of 1**: disables multi-sig. Only use in development/testing.

## Emergency Procedure

If a key holder is unavailable and an urgent operation is needed:

1. Confirm the emergency with at least one other key holder out-of-band (phone/Signal).
2. Temporarily lower `MULTISIG_THRESHOLD` to `1` and restart the backend.
3. Execute the operation.
4. Restore `MULTISIG_THRESHOLD` to the original value and restart.
5. Document the emergency in the audit log and incident tracker.

> **Note:** with the deployed 2-of-3 set, a single unavailable signer does **not**
> require lowering the threshold — the remaining two signers can still reach the
> threshold of 2. Threshold lowering is only needed if two or more signers are
> simultaneously unavailable.

## Testnet Drill Procedure (Issue #83)

A drill must be executed on testnet before promoting any change to the signer set or
threshold, and at least once per quarter. The drill demonstrates both normal
administration and signer-unavailable recovery.

### Drill A — Normal administration

1. Initiate an admin operation (e.g. issuer approval) with Signer A's token.
2. Confirm a `202` with `threshold: 2` and `approvals: 1`.
3. Approve the proposal with Signer B's token.
4. Confirm the proposal reaches `status: "approved"` with `approvals: 2`.
5. Execute the operation with the `proposal_id` and confirm success.
6. Confirm the audit log records creation, approval, and execution.

### Drill B — Signer-unavailable recovery

1. Simulate Signer C being unavailable (do not use Signer C's key).
2. Initiate an admin operation with Signer A's token.
3. Approve with Signer B's token and confirm the threshold of 2 is reached
   **without** Signer C.
4. Execute the operation and confirm success.
5. Separately, simulate two signers unavailable and exercise the Emergency Procedure
   above (lower threshold to 1, execute, restore threshold to 2, restart).
6. Confirm the threshold is restored to `2` and the signer set is unchanged.

### Documented results

Record each drill run in the table below (append a row per run):

| Date | Environment | Drill | Result | Operator | Notes |
|---|---|---|---|---|---|
| _pending_ | testnet | A — normal administration | _pending_ | _pending_ | _pending_ |
| _pending_ | testnet | B — signer-unavailable recovery | _pending_ | _pending_ | _pending_ |

A drill is only considered passed when both Drill A and Drill B succeed and the
post-drill configuration is verified to match the **Deployed Signer Set and Threshold**
section above.
