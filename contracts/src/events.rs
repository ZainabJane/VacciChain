use soroban_sdk::{symbol_short, Env, Address, String};

/// Returns the current ledger timestamp.
///
/// Timestamps are provided by the ledger and are assumed to be monotonically
/// non-decreasing. No arithmetic is performed on them here, so overflow and
/// invalid-time assumptions are avoided: values are emitted verbatim, including
/// the boundary values `0` and `u64::MAX` (see issue #88).
fn ledger_timestamp(env: &Env) -> u64 {
    env.ledger().timestamp()
}

pub fn emit_minted(env: &Env, token_id: u64, patient: &Address, vaccine_name: &String, issuer: &Address) {
    let timestamp = ledger_timestamp(env);
    env.events().publish(
        (symbol_short!("minted"), token_id),
        (patient.clone(), vaccine_name.clone(), issuer.clone(), timestamp),
    );
}

pub fn emit_revoked(env: &Env, token_id: u64, revoker: &Address) {
    let timestamp = ledger_timestamp(env);
    env.events().publish(
        (symbol_short!("revoked"), token_id),
        (revoker.clone(), timestamp),
    );
}

pub fn emit_issuer_added(env: &Env, issuer: &Address, admin: &Address) {
    let timestamp = ledger_timestamp(env);
    env.events().publish(
        (symbol_short!("iss_add"),),
        (issuer.clone(), admin.clone(), timestamp),
    );
}

pub fn emit_issuer_revoked(env: &Env, issuer: &Address, admin: &Address) {
    let timestamp = ledger_timestamp(env);
    env.events().publish(
        (symbol_short!("iss_rev"),),
        (issuer.clone(), admin.clone(), timestamp),
    );
}

/// Emits the admin transfer proposal event.
///
/// `expires_at` is a ledger timestamp supplied by the caller; it is emitted
/// verbatim without arithmetic so boundary values (`0`, `u64::MAX`) are safe.
pub fn emit_admin_transfer_proposed(env: &Env, current_admin: &Address, new_admin: &Address, expires_at: u64) {
    env.events().publish(
        (symbol_short!("adm_prop"),),
        (current_admin.clone(), new_admin.clone(), expires_at),
    );
}

pub fn emit_admin_transfer_accepted(env: &Env, new_admin: &Address) {
    let timestamp = ledger_timestamp(env);
    env.events().publish(
        (symbol_short!("adm_acc"),),
        (new_admin.clone(), timestamp),
    );
}

pub fn emit_contract_upgraded(env: &Env, new_wasm_hash: &soroban_sdk::BytesN<32>, admin: &Address) {
    let timestamp = ledger_timestamp(env);
    env.events().publish(
        (symbol_short!("upgraded"),),
        (new_wasm_hash.clone(), admin.clone(), timestamp),
    );
}

pub fn emit_patient_registered(env: &Env, patient: &Address) {
    let timestamp = ledger_timestamp(env);
    env.events().publish(
        (symbol_short!("pat_reg"),),
        (patient.clone(), timestamp),
    );
}

pub fn emit_contract_paused(env: &Env, admin: &Address) {
    let timestamp = ledger_timestamp(env);
    env.events().publish(
        (symbol_short!("paused"),),
        (admin.clone(), timestamp),
    );
}

pub fn emit_contract_unpaused(env: &Env, admin: &Address) {
    let timestamp = ledger_timestamp(env);
    env.events().publish(
        (symbol_short!("unpaused"),),
        (admin.clone(), timestamp),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Ledger;
    use soroban_sdk::{Address, Env, String};

    /// Boundary test (issue #88): a zero ledger timestamp is emitted verbatim.
    #[test]
    fn emits_with_zero_timestamp() {
        let env = Env::default();
        env.ledger().set_timestamp(0);
        let patient = Address::generate(&env);
        let issuer = Address::generate(&env);
        let name = String::from_str(&env, "BCG");
        emit_minted(&env, 0, &patient, &name, &issuer);
        emit_revoked(&env, 0, &issuer);
        emit_issuer_added(&env, &issuer, &patient);
        emit_issuer_revoked(&env, &issuer, &patient);
        emit_admin_transfer_proposed(&env, &patient, &issuer, 0);
        emit_admin_transfer_accepted(&env, &issuer);
        emit_patient_registered(&env, &patient);
        emit_contract_paused(&env, &patient);
        emit_contract_unpaused(&env, &patient);
        assert_eq!(ledger_timestamp(&env), 0);
    }

    /// Boundary test (issue #88): the maximum u64 timestamp is emitted verbatim
    /// without overflow in any counter or sequence arithmetic.
    #[test]
    fn emits_with_max_timestamp() {
        let env = Env::default();
        env.ledger().set_timestamp(u64::MAX);
        let patient = Address::generate(&env);
        let issuer = Address::generate(&env);
        let name = String::from_str(&env, "BCG");
        emit_minted(&env, u64::MAX, &patient, &name, &issuer);
        emit_revoked(&env, u64::MAX, &issuer);
        emit_issuer_added(&env, &issuer, &patient);
        emit_issuer_revoked(&env, &issuer, &patient);
        emit_admin_transfer_proposed(&env, &patient, &issuer, u64::MAX);
        emit_admin_transfer_accepted(&env, &issuer);
        emit_patient_registered(&env, &patient);
        emit_contract_paused(&env, &patient);
        emit_contract_unpaused(&env, &patient);
        assert_eq!(ledger_timestamp(&env), u64::MAX);
    }
}
