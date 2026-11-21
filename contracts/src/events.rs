use soroban_sdk::{symbol_short, Env, Address, String};

pub fn emit_minted(env: &Env, token_id: u64, patient: &Address, vaccine_name: &String, issuer: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("minted"), token_id),
        (patient.clone(), vaccine_name.clone(), issuer.clone(), timestamp),
    );
}

/// Emitted when an individual vaccination record is revoked.
///
/// Revocation scope: affects only the single record identified by `token_id`.
/// It does not revoke the issuer's permission nor other records they issued.
/// Revocation is irreversible: a revoked record can never be un-revoked.
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

/// Emitted when an issuer's permission is revoked by the admin.
///
/// Revocation scope: affects the issuer's permission to mint new records.
/// Previously minted records remain valid unless individually revoked.
/// Revocation is irreversible for the current permission grant; re-adding
/// the issuer emits a fresh `iss_add` event.
pub fn emit_issuer_revoked(env: &Env, issuer: &Address, admin: &Address) {
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

pub fn emit_admin_transfer_cancelled(env: &Env, current_admin: &Address, cancelled_by: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("adm_cncl"),),
        (current_admin.clone(), cancelled_by.clone(), timestamp),
    );
}

pub fn emit_admin_transfer_expired(env: &Env, current_admin: &Address, new_admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("adm_exp"),),
        (current_admin.clone(), new_admin.clone(), timestamp),
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
