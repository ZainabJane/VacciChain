//! # Contract Event Schemas (Versioned)
//!
//! All state-changing actions emit events whose topics carry an explicit
//! schema version so indexers can safely interpret payloads across upgrades.
//!
//! ## Compatibility rules
//!
//! * The **first topic** is always the versioned event name, e.g. `minted_v1`.
//!   A new schema version MUST use a new symbol (`minted_v2`); existing
//!   symbols are never reused with a different payload shape.
//! * The **second topic** (when present) is the primary key of the event
//!   (e.g. `token_id`). It is stable across versions.
//! * The **payload** is a tuple whose last element is always the ledger
//!   `timestamp` (u64), except where noted below.
//! * Additive changes (appending fields) are allowed only within a new
//!   versioned symbol. Indexers MUST key off the versioned symbol and MUST
//!   ignore unknown trailing fields for forward compatibility.
//! * Removing or reordering fields requires a new version symbol.
//!
//! ## Event catalogue (v1)
//!
//! | Event symbol   | Topics                     | Payload (in order)                                  |
//! |----------------|----------------------------|-----------------------------------------------------|
//! | `minted_v1`    | `(token_id)`               | `(patient, vaccine_name, issuer, timestamp)`        |
//! | `revoked_v1`   | `(token_id)`               | `(revoker, timestamp)`                              |
//! | `iss_add_v1`   | –                          | `(issuer, admin, timestamp)`                        |
//! | `iss_rev_v1`   | –                          | `(issuer, admin, timestamp)`                        |
//! | `adm_prop_v1`  | –                          | `(current_admin, new_admin, expires_at)`            |
//! | `adm_acc_v1`   | –                          | `(new_admin, timestamp)`                            |
//! | `upgraded_v1`  | –                          | `(new_wasm_hash, admin, timestamp)`                 |
//! | `pat_reg_v1`   | –                          | `(patient, timestamp)`                              |
//! | `paused_v1`    | –                          | `(admin, timestamp)`                                |
//! | `unpaused_v1`  | –                          | `(admin, timestamp)`                                |

use soroban_sdk::{symbol_short, Env, Address, String};

/// Current event schema version. Bump when introducing a new version symbol.
pub const EVENT_SCHEMA_VERSION: u32 = 1;

pub fn emit_minted(env: &Env, token_id: u64, patient: &Address, vaccine_name: &String, issuer: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("minted_v1"), token_id),
        (patient.clone(), vaccine_name.clone(), issuer.clone(), timestamp),
    );
}

pub fn emit_revoked(env: &Env, token_id: u64, revoker: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("revoked_v1"), token_id),
        (revoker.clone(), timestamp),
    );
}

pub fn emit_issuer_added(env: &Env, issuer: &Address, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("iss_add_v1"),),
        (issuer.clone(), admin.clone(), timestamp),
    );
}

pub fn emit_issuer_revoked(env: &Env, issuer: &Address, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("iss_rev_v1"),),
        (issuer.clone(), admin.clone(), timestamp),
    );
}

pub fn emit_admin_transfer_proposed(env: &Env, current_admin: &Address, new_admin: &Address, expires_at: u64) {
    env.events().publish(
        (symbol_short!("adm_prop_v1"),),
        (current_admin.clone(), new_admin.clone(), expires_at),
    );
}

pub fn emit_admin_transfer_accepted(env: &Env, new_admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("adm_acc_v1"),),
        (new_admin.clone(), timestamp),
    );
}

pub fn emit_contract_upgraded(env: &Env, new_wasm_hash: &soroban_sdk::BytesN<32>, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("upgraded_v1"),),
        (new_wasm_hash.clone(), admin.clone(), timestamp),
    );
}

pub fn emit_patient_registered(env: &Env, patient: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("pat_reg_v1"),),
        (patient.clone(), timestamp),
    );
}

pub fn emit_contract_paused(env: &Env, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("paused_v1"),),
        (admin.clone(), timestamp),
    );
}

pub fn emit_contract_unpaused(env: &Env, admin: &Address) {
    let timestamp = env.ledger().timestamp();
    env.events().publish(
        (symbol_short!("unpaused_v1"),),
        (admin.clone(), timestamp),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Events as _;
    use soroban_sdk::{Address, BytesN, Env, String, Symbol, TryFromVal, Val, Vec};

    fn setup() -> Env {
        let env = Env::default();
        env.mock_all_auths();
        env
    }

    /// Assert the last emitted event has the given versioned topic symbol and
    /// that its payload tuple has the expected arity.
    fn assert_event(env: &Env, expected_topic: &str, expected_arity: usize) {
        let events = env.events().all();
        let (_, topics, data) = events.last().expect("no event emitted");
        let first: Symbol = Symbol::try_from_val(env, &topics.get(0).unwrap()).unwrap();
        assert_eq!(first, Symbol::new(env, expected_topic));
        let tuple: Vec<Val> = Vec::try_from_val(env, &data).unwrap();
        assert_eq!(tuple.len() as usize, expected_arity);
    }

    #[test]
    fn minted_event_v1_schema() {
        let env = setup();
        let patient = Address::generate(&env);
        let issuer = Address::generate(&env);
        let name = String::from_str(&env, "COVID-19");
        emit_minted(&env, 42, &patient, &name, &issuer);
        assert_event(&env, "minted_v1", 4);
    }

    #[test]
    fn revoked_event_v1_schema() {
        let env = setup();
        let revoker = Address::generate(&env);
        emit_revoked(&env, 42, &revoker);
        assert_event(&env, "revoked_v1", 2);
    }

    #[test]
    fn issuer_added_event_v1_schema() {
        let env = setup();
        let issuer = Address::generate(&env);
        let admin = Address::generate(&env);
        emit_issuer_added(&env, &issuer, &admin);
        assert_event(&env, "iss_add_v1", 3);
    }

    #[test]
    fn issuer_revoked_event_v1_schema() {
        let env = setup();
        let issuer = Address::generate(&env);
        let admin = Address::generate(&env);
        emit_issuer_revoked(&env, &issuer, &admin);
        assert_event(&env, "iss_rev_v1", 3);
    }

    #[test]
    fn admin_transfer_proposed_event_v1_schema() {
        let env = setup();
        let current = Address::generate(&env);
        let new = Address::generate(&env);
        emit_admin_transfer_proposed(&env, &current, &new, 1000);
        assert_event(&env, "adm_prop_v1", 3);
    }

    #[test]
    fn admin_transfer_accepted_event_v1_schema() {
        let env = setup();
        let new = Address::generate(&env);
        emit_admin_transfer_accepted(&env, &new);
        assert_event(&env, "adm_acc_v1", 2);
    }

    #[test]
    fn contract_upgraded_event_v1_schema() {
        let env = setup();
        let hash = BytesN::from_array(&env, &[0u8; 32]);
        let admin = Address::generate(&env);
        emit_contract_upgraded(&env, &hash, &admin);
        assert_event(&env, "upgraded_v1", 3);
    }

    #[test]
    fn patient_registered_event_v1_schema() {
        let env = setup();
        let patient = Address::generate(&env);
        emit_patient_registered(&env, &patient);
        assert_event(&env, "pat_reg_v1", 2);
    }

    #[test]
    fn paused_event_v1_schema() {
        let env = setup();
        let admin = Address::generate(&env);
        emit_contract_paused(&env, &admin);
        assert_event(&env, "paused_v1", 2);
    }

    #[test]
    fn unpaused_event_v1_schema() {
        let env = setup();
        let admin = Address::generate(&env);
        emit_contract_unpaused(&env, &admin);
        assert_event(&env, "unpaused_v1", 2);
    }

    /// Indexer fixture: verifies that a v1 symbol is distinct from a
    /// hypothetical v2 symbol so old/new payloads are never misclassified.
    #[test]
    fn versioned_symbols_are_distinct() {
        let env = setup();
        let v1 = Symbol::new(&env, "minted_v1");
        let v2 = Symbol::new(&env, "minted_v2");
        assert_ne!(v1, v2);
        assert_eq!(EVENT_SCHEMA_VERSION, 1);
    }
}
