//! # Event emission policy
//!
//! Events are emitted **only after** the corresponding state mutation has
//! succeeded. Callers must perform all authorization, validation, and
//! storage writes first, and invoke the `emit_*` helper last. As a result:
//!
//! * Failed operations (unauthorized mint/revoke, over-limit input, paused
//!   contract, rejected admin transfer, etc.) panic before any event is
//!   published, so no misleading event is ever emitted for a failed call.
//! * Soulbound tokens have **no** ownership-change events. There is no
//!   `transfer`, `approve`, or `clawback` event because those operations are
//!   not supported; ownership can only change via mint (creation) and revoke
//!   (permanent invalidation), each of which has its own event below.
//! * Every event helper here must be reachable from a contract entry point.
//!   Dead helpers are removed so operators never see a documented event that
//!   the contract cannot actually emit.

use soroban_sdk::{symbol_short, Env, Address, String};

pub fn emit_minted(env: &Env, token_id: u64, patient: &Address, vaccine_name: &String, issuer: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("minted"), token_id),
        (patient.clone(), vaccine_name.clone(), issuer.clone(), timestamp),
    );
}

pub fn emit_revoked(env: &Env, token_id: u64, revoker: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("revoked"), token_id),
        (revoker.clone(), timestamp),
    );
}

pub fn emit_issuer_added(env: &Env, issuer: &Address, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("iss_add"),),
        (issuer.clone(), admin.clone(), timestamp),
    );
}

pub fn emit_issuer_revoked(env: &Env, issuer: &Address, admin: &Address) {
    // Emitted by `revoke_issuer` only after the issuer is removed from
    // persistent storage, so a failed revocation never publishes this event.
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("iss_rev"),),
        (issuer.clone(), admin.clone(), timestamp),
    );
}

pub fn emit_admin_transfer_proposed(env: &Env, current_admin: &Address, new_admin: &Address, expires_at: u64) {
    env.events().publish(
        (symbol_short!("adm_prop"),),
        (current_admin.clone(), new_admin.clone(), expires_at),
    );
}

pub fn emit_admin_transfer_accepted(env: &Env, new_admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("adm_acc"),),
        (new_admin.clone(), timestamp),
    );
}

pub fn emit_contract_upgraded(env: &Env, new_wasm_hash: &soroban_sdk::BytesN<32>, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("upgraded"),),
        (new_wasm_hash.clone(), admin.clone(), timestamp),
    );
}

pub fn emit_patient_registered(env: &Env, patient: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("pat_reg"),),
        (patient.clone(), timestamp),
    );
}

pub fn emit_contract_paused(env: &Env, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("paused"),),
        (admin.clone(), timestamp),
    );
}

pub fn emit_contract_unpaused(env: &Env, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("unpaused"),),
        (admin.clone(), timestamp),
    );
}
