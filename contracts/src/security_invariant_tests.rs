#![cfg(test)]

//! Security invariant tests (Issue #96)
//!
//! Verifies critical security properties that must hold on every change:
//! - Non-issuer cannot mint
//! - Transfer always fails regardless of caller/recipient
//! - Non-admin cannot add or revoke issuers
//! - Paused contract rejects all state-changing calls

use soroban_sdk::{testutils::Address as _, Env, String};
use crate::{VacciChainContract, VacciChainContractClient, ContractError};

// ── Authorization matrix ─────────────────────────────────────────────────────
//
// Privileged entry point            | Required auth
// ----------------------------------|------------------------------------------
// initialize                        | admin (one-time)
// add_issuer                        | admin
// revoke_issuer                     | admin
// mint_vaccination                  | active (non-revoked) issuer
// register_patient                  | patient (self)
// pause / unpause                   | admin
// upgrade                           | admin
// transfer                          | always fails (soulbound)
// verify_vaccination                | none (read-only)

fn setup() -> (Env, VacciChainContractClient<'static>, soroban_sdk::Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(VacciChainContract, ());
    let client = VacciChainContractClient::new(&env, &contract_id);
    let admin = soroban_sdk::Address::generate(&env);
    client.initialize(&admin).unwrap();
    (env, client, admin)
}

fn add_issuer(env: &Env, client: &VacciChainContractClient, issuer: &soroban_sdk::Address) {
    client.add_issuer(
        issuer,
        &String::from_str(env, "Test Hospital"),
        &String::from_str(env, "LIC-001"),
        &String::from_str(env, "USA"),
    ).unwrap();
}

// ── Non-issuer cannot mint ────────────────────────────────────────────────────

#[test]
fn invariant_non_issuer_cannot_mint() {
    let (env, client, _admin) = setup();
    let non_issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    let result = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &non_issuer,
        &None::<u32>,
        &None::<u32>,
    );

    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn invariant_revoked_issuer_cannot_mint() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    client.revoke_issuer(&issuer).unwrap();

    let result = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &None::<u32>,
        &None::<u32>,
    );

    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn invariant_forged_issuer_cannot_mint() {
    let (env, client, _admin) = setup();
    // A legitimate issuer exists, but the caller forges a different address
    // that was never added to the allowlist.
    let legit_issuer = soroban_sdk::Address::generate(&env);
    let forged_issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &legit_issuer);
    assert!(client.is_issuer(&legit_issuer));
    assert!(!client.is_issuer(&forged_issuer));

    let result = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &forged_issuer,
        &None::<u32>,
        &None::<u32>,
    );

    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

#[test]
fn invariant_unauthorized_caller_cannot_mint() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let attacker = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);

    // Only the attacker authorizes the call; the issuer address is used as the
    // claimed issuer but the attacker is the actual caller.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "mint_vaccination",
            args: (
                patient.clone(),
                String::from_str(&env, "COVID-19"),
                String::from_str(&env, "2024-01-15"),
                attacker.clone(),
                None::<u32>,
                None::<u32>,
            ).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &attacker,
        &None::<u32>,
        &None::<u32>,
    );

    assert_eq!(result, Err(Ok(ContractError::Unauthorized)));
}

// ── Transfer always fails ─────────────────────────────────────────────────────

#[test]
fn invariant_transfer_always_fails() {
    let (env, client, _admin) = setup();
    let from = soroban_sdk::Address::generate(&env);
    let to = soroban_sdk::Address::generate(&env);

    let result = client.try_transfer(&from, &to, &1u64);
    assert_eq!(result, Err(Ok(ContractError::SoulboundToken)));
}

#[test]
fn invariant_transfer_fails_even_for_admin() {
    let (env, client, admin) = setup();
    let to = soroban_sdk::Address::generate(&env);

    let result = client.try_transfer(&admin, &to, &1u64);
    assert_eq!(result, Err(Ok(ContractError::SoulboundToken)));
}

#[test]
fn invariant_transfer_fails_for_any_token_id() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);
    let recipient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    let token_id = client.mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &None::<u32>,
        &None::<u32>,
    );

    let result = client.try_transfer(&patient, &recipient, &token_id);
    assert_eq!(result, Err(Ok(ContractError::SoulboundToken)));
}

// ── Non-admin cannot add or revoke issuers ────────────────────────────────────

#[test]
fn invariant_non_admin_cannot_add_issuer() {
    let (env, client, _admin) = setup();
    let non_admin = soroban_sdk::Address::generate(&env);
    let issuer = soroban_sdk::Address::generate(&env);

    // Override mock_all_auths to only authorize non_admin
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &non_admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "add_issuer",
            args: (
                issuer.clone(),
                String::from_str(&env, "Hospital"),
                String::from_str(&env, "LIC"),
                String::from_str(&env, "USA"),
            ).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_add_issuer(
        &issuer,
        &String::from_str(&env, "Hospital"),
        &String::from_str(&env, "LIC"),
        &String::from_str(&env, "USA"),
    );

    assert!(result.is_err(), "Non-admin should not be able to add an issuer");
}

#[test]
fn invariant_non_admin_cannot_revoke_issuer() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let non_admin = soroban_sdk::Address::generate(&env);

    // Add issuer as admin first
    add_issuer(&env, &client, &issuer);
    assert!(client.is_issuer(&issuer));

    // Attempt revoke as non-admin
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &non_admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "revoke_issuer",
            args: (issuer.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_revoke_issuer(&issuer);
    assert!(result.is_err(), "Non-admin should not be able to revoke an issuer");
}

#[test]
fn invariant_non_admin_cannot_pause() {
    let (env, client, _admin) = setup();
    let non_admin = soroban_sdk::Address::generate(&env);

    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &non_admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "pause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_pause();
    assert!(result.is_err(), "Non-admin should not be able to pause");
}

#[test]
fn invariant_non_admin_cannot_unpause() {
    let (env, client, _admin) = setup();
    let non_admin = soroban_sdk::Address::generate(&env);

    client.pause().unwrap();

    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &non_admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "unpause",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_unpause();
    assert!(result.is_err(), "Non-admin should not be able to unpause");
}

#[test]
fn invariant_non_admin_cannot_upgrade() {
    let (env, client, _admin) = setup();
    let non_admin = soroban_sdk::Address::generate(&env);
    let new_wasm_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);

    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &non_admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "upgrade",
            args: (new_wasm_hash.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result = client.try_upgrade(&new_wasm_hash);
    assert!(result.is_err(), "Non-admin should not be able to upgrade");
}

// ── Paused contract rejects all state-changing calls ─────────────────────────

#[test]
fn invariant_paused_contract_rejects_mint() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    client.pause().unwrap();

    let result = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &None::<u32>,
        &None::<u32>,
    );

    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

#[test]
fn invariant_paused_contract_rejects_add_issuer() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);

    client.pause().unwrap();

    let result = client.try_add_issuer(
        &issuer,
        &String::from_str(&env, "Hospital"),
        &String::from_str(&env, "LIC"),
        &String::from_str(&env, "USA"),
    );

    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

#[test]
fn invariant_paused_contract_rejects_revoke_issuer() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    client.pause().unwrap();

    let result = client.try_revoke_issuer(&issuer);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

#[test]
fn invariant_paused_contract_rejects_register_patient() {
    let (env, client, _admin) = setup();
    let patient = soroban_sdk::Address::generate(&env);

    client.pause().unwrap();

    let result = client.try_register_patient(&patient);
    assert_eq!(result, Err(Ok(ContractError::ContractPaused)));
}

#[test]
fn invariant_paused_contract_allows_verify() {
    let (env, client, _admin) = setup();
    let wallet = soroban_sdk::Address::generate(&env);

    client.pause().unwrap();

    // verify_vaccination must still work when paused
    let (vaccinated, records, _) = client.verify_vaccination(&wallet);
    assert!(!vaccinated);
    assert_eq!(records.len(), 0);
}

#[test]
fn invariant_unpause_restores_minting() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    client.pause().unwrap();
    client.unpause().unwrap();

    // Should succeed after unpause
    let result = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &None::<u32>,
        &None::<u32>,
    );

    assert!(result.is_ok(), "Minting should succeed after unpause");
}
