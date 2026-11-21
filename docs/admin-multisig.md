# Admin Multi-Signature Procedure

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

## Admin Key Recovery and Rotation

A lost, compromised, or unavailable admin key must be replaceable **without** granting any single party unilateral control. Recovery and rotation are themselves multi-sig operations and follow the same proposal/approval/execution lifecycle as other admin actions.

### Policy Summary

| Parameter | Value | Notes |
|---|---|---|
| Recovery threshold | `MULTISIG_THRESHOLD` (M of N) | Same threshold as other admin operations; never lower for recovery |
| Proposal delay (timelock) | `ADMIN_ROTATION_DELAY_MS` (default `86400000`, 24h) | Minimum time between approval and execution |
| Proposal expiry | `ADMIN_ROTATION_TTL_MS` (default `172800000`, 48h) | Must exceed the delay; expired proposals are discarded |
| Cancellation | Any current key holder may cancel a pending rotation | Cancellation is immediate and audited |
| Emergency override | Requires M-of-N **plus** out-of-band confirmation by all remaining holders | See Emergency Procedure |

The timelock guarantees that a compromised single key cannot silently swap out the admin set: the legitimate holders have a full delay window to observe and cancel the proposal.

### Configuration

| Variable | Description | Default |
|---|---|---|
| `ADMIN_ROTATION_DELAY_MS` | Timelock between approval and execution | `86400000` (24 hours) |
| `ADMIN_ROTATION_TTL_MS` | Rotation proposal expiry | `172800000` (48 hours) |
| `ADMIN_ROTATION_EMERGENCY` | Enables the emergency fast-path (requires all-holder confirmation) | `false` |

`ADMIN_ROTATION_TTL_MS` must be greater than `ADMIN_ROTATION_DELAY_MS`; the backend refuses to start otherwise.

### Step 1 — Propose the rotation

Any current key holder proposes adding and/or removing admin addresses:

```bash
curl -X POST https://api.example.com/v1/admin/multisig/rotation/propose \
  -H "Authorization: Bearer <proposer-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
        "add": ["G...NEWKEY"],
        "remove": ["G...COMPROMISEDKEY"],
        "reason": "key holder wallet compromised"
      }'
```

Response:
```json
{
  "proposal_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "operation": "admin_rotation",
  "approvals": 1,
  "threshold": 2,
  "status": "pending",
  "executable_at": "2026-04-30T15:00:00.000Z",
  "expires_at": "2026-05-01T15:00:00.000Z"
}
```

### Step 2 — Approve

Each additional key holder approves with the `proposal_id` (same endpoint as other proposals):

```bash
curl -X POST https://api.example.com/v1/admin/multisig/approve \
  -H "Authorization: Bearer <cosigner-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{ "proposal_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7" }'
```

When the threshold is reached the proposal moves to `approved` but **cannot execute** until `executable_at` (proposal creation + `ADMIN_ROTATION_DELAY_MS`).

### Step 3 — Cancel (optional, before execution)

Any current key holder may cancel a pending or approved rotation during the delay window:

```bash
curl -X POST https://api.example.com/v1/admin/multisig/rotation/<proposal_id>/cancel \
  -H "Authorization: Bearer <admin-token>"
```

Cancellation is immediate, requires no threshold, and is written to the audit log. A cancelled proposal can never be executed or re-approved; a new proposal must be created.

### Step 4 — Execute

After the delay has elapsed and before expiry, an approver executes the rotation:

```bash
curl -X POST https://api.example.com/v1/admin/multisig/rotation/<proposal_id>/execute \
  -H "Authorization: Bearer <initiator-admin-token>"
```

The proposal is consumed (single-use) and `MULTISIG_KEY_HOLDERS` is updated atomically. Execution is rejected if the proposal is not `approved`, if `executable_at` has not passed, or if `expires_at` has passed.

### Expiry and replay protection

- **Expiry**: rotation proposals expire at `expires_at`. Expired proposals cannot be approved, cancelled, or executed and must be re-proposed.
- **Replay**: each `proposal_id` is single-use. Execution marks the proposal `executed` and deletes it; any subsequent execution or approval attempt with the same `proposal_id` is rejected with `409 Conflict`.
- **Stale approvals**: approvals are bound to the exact `add`/`remove` payload. Any change requires a new proposal, so an old approval cannot be replayed against a different key set.
- **Unauthorized attempts**: requests from addresses not in `MULTISIG_KEY_HOLDERS`, or with an invalid/expired JWT, are rejected with `403 Forbidden` and logged. Self-approval beyond the initiator's single approval is not counted twice.

### Emergency behavior

If a key is compromised and waiting the full delay is unsafe:

1. Confirm the emergency out-of-band (phone/Signal) with **every** remaining key holder.
2. Set `ADMIN_ROTATION_EMERGENCY=true` and restart the backend.
3. Propose and approve the rotation as above; with emergency mode enabled the delay is skipped **only if all remaining holders have approved**.
4. Execute the rotation, then set `ADMIN_ROTATION_EMERGENCY=false` and restart.
5. Document the emergency in the audit log and incident tracker.

Emergency mode never allows a single holder to act alone, and never lowers the approval threshold.

## Emergency Procedure

If a key holder is unavailable and an urgent operation is needed:

1. Confirm the emergency with at least one other key holder out-of-band (phone/Signal).
2. Temporarily lower `MULTISIG_THRESHOLD` to `1` and restart the backend.
3. Execute the operation.
4. Restore `MULTISIG_THRESHOLD` to the original value and restart.
5. Document the emergency in the audit log and incident tracker.

> Note: lowering `MULTISIG_THRESHOLD` is a break-glass action for ordinary operations only. It must **not** be used to perform admin key recovery or rotation — use the rotation flow above instead.
