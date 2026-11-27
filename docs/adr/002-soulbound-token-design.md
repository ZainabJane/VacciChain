# ADR-002: Soulbound Token Design for Vaccination Records

## Status
Accepted

## Context
VacciChain needs to issue vaccination records that are:
- Non-transferable to prevent fraud and black markets
- Permanently tied to the patient's identity
- Verifiable by third parties (schools, employers, border agencies)
- Revocable in case of errors or updates
- Compliant with healthcare data regulations

Traditional NFTs are transferable by design, which creates risks for vaccination records including unauthorized transfers, identity fraud, and creation of vaccination black markets.

## Decision
We implemented soulbound vaccination NFTs using contract-level transfer restrictions. Every public entry point that could change token ownership is explicitly rejected at the contract level. Rejected operations return `ContractError::SoulboundToken` (a typed contract error) rather than panicking, so callers receive a deterministic error code and no storage is mutated and no events are emitted on the failure path.

### Ownership-changing entry points (all rejected)
The following public operations are the complete set of paths that could alter ownership. Each is enforced to fail with `ContractError::SoulboundToken`:

- `transfer(env, from, to, token_id)` — direct transfer; rejected.
- `transfer_from(env, spender, from, to, token_id)` — delegated transfer; rejected.
- `safe_transfer(env, from, to, token_id)` — safe-transfer variant; rejected.
- `safe_transfer_from(env, spender, from, to, token_id)` — safe delegated transfer; rejected.
- `approve(env, owner, spender, token_id)` — approval grant; rejected (no approvals exist, so no delegated transfer can ever be authorized).
- `set_approval_for_all(env, owner, operator, approved)` — operator approval; rejected.
- `clawback(env, admin, from, token_id)` — admin clawback; rejected (records are revoked, never reassigned).
- `burn(env, owner, token_id)` — burn; rejected (no burn path exists).

Because approvals cannot be created and no clawback/burn/transfer path exists, there is no alternate entry point (direct, delegated, admin, or batch) that can move a token between wallets. Revocation is the only state change available and it does not change ownership.

### Threat model and tests
- The threat-model matrix enumerating each ownership-changing operation, its trust assumptions, and its rejection behavior is documented in `docs/security/soulbound-threat-model.md`.
- Negative contract tests in `contracts/vaccination/src/test.rs` assert that each operation above returns `ContractError::SoulboundToken`, leaves token ownership and approval storage unchanged, and emits no events on the failure path.

## Consequences

### Positive
- **Fraud prevention**: No possibility of unauthorized transfer or sale of vaccination records
- **Identity binding**: Records remain permanently associated with the patient's wallet
- **Regulatory compliance**: Meets healthcare data portability requirements without transferability
- **Simple enforcement**: Single point of control in the smart contract
- **Gas efficiency**: No complex transfer logic to execute
- **Audit trail**: All vaccination events remain traceable to original recipient

### Negative
- **Wallet loss risk**: If a patient loses their wallet, vaccination records are inaccessible
- **No recovery mechanism**: Cannot transfer records to a new wallet address
- **Inflexibility**: Cannot accommodate legitimate transfer scenarios (e.g., legal guardianship changes)
- **User experience**: Users must understand they cannot transfer records like regular NFTs

## Alternatives Considered

### Transferable NFTs with Transfer Restrictions
- **Pros**: Flexible, allows legitimate transfers, familiar UX
- **Cons**: Complex logic, potential for exploits, regulatory concerns
- **Rejected**: Transfer complexity creates security risks for healthcare data

### Off-chain Binding with On-chain References
- **Pros**: Can implement recovery mechanisms, flexible identity management
- **Cons**: Centralized trust, additional infrastructure, privacy concerns
- **Rejected**: Defeats purpose of on-chain verification and decentralization

### Multi-signature Controlled Transfers
- **Pros**: Allows controlled transfers with multiple approvals
- **Cons**: Complex implementation, gas costs, coordination overhead
- **Rejected**: Too complex for simple vaccination record use case

### Time-locked Transfers
- **Pros**: Allows transfers after cooling-off period
- **Cons**: Still enables transfer markets, timing attacks possible
- **Rejected**: Any transferability creates fraud potential

## Implementation Notes
- All ownership-changing functions return `ContractError::SoulboundToken`; they do not panic
- Soulbound enforcement is at contract level, not UI level
- No `approve` / `set_approval_for_all` paths exist; approval attempts are rejected
- No `clawback` or `burn` paths exist; attempts are rejected
- Records can be revoked but not transferred or reassigned
- Verification functions work directly on patient wallet address
- Batch verification supported for efficiency
- Threat-model matrix: `docs/security/soulbound-threat-model.md`
- Negative tests: `contracts/vaccination/src/test.rs` (assert error code, unchanged storage, no events)

```rust
// Transfer is permanently blocked — soulbound enforcement returns a typed error
pub fn transfer(env: Env, _from: Address, _to: Address, _token_id: u64) -> Result<(), ContractError> {
    Err(ContractError::SoulboundToken)
}
```

## References
- [Soulbound Tokens Concept - Vitalik Buterin](https://vitalik.ca/general/2022/01/26/soulbound.html)
- [ERC-721 Non-Fungible Token Standard](https://eips.ethereum.org/EIPS/eip-721)
- [Soroban Contract Documentation](https://soroban.stellar.org/docs/smart-contracts/overview)
