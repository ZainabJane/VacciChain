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

// ── Helpers for revocation / duplicate / lifecycle tests ─────────────────────

fn mint(
    env: &Env,
    client: &VacciChainContractClient,
    patient: &soroban_sdk::Address,
    issuer: &soroban_sdk::Address,
    vaccine: &str,
    date: &str,
    dose: Option<u32>,
) -> u64 {
    client.mint_vaccination(
        patient,
        &String::from_str(env, vaccine),
        &String::from_str(env, date),
        issuer,
        &dose,
        &None::<u32>,
    )
}

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

// ── Revocation scope: individual record, not wallet or issuer ────────────────

#[test]
fn invariant_revoke_one_record_keeps_remaining_records_valid() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);

    let first = mint(&env, &client, &patient, &issuer, "COVID-19", "2024-01-15", Some(1));
    let second = mint(&env, &client, &patient, &issuer, "COVID-19", "2024-02-15", Some(2));

    // Revoke only the first record.
    client.revoke_vaccination(&first).unwrap();

    // The revoked record is no longer valid.
    assert!(!client.is_vaccination_valid(&first));

    // The remaining record is still valid and the wallet is still vaccinated.
    assert!(client.is_vaccination_valid(&second));
    let (vaccinated, records, _) = client.verify_vaccination(&patient);
    assert!(vaccinated, "Wallet must remain vaccinated while a valid record exists");
    assert_eq!(records.len(), 1, "Only the non-revoked record should remain");
    assert_eq!(records.get(0).unwrap().token_id, second);
}

#[test]
fn invariant_revocation_is_irreversible() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    let token_id = mint(&env, &client, &patient, &issuer, "COVID-19", "2024-01-15", None);

    client.revoke_vaccination(&token_id).unwrap();
    assert!(!client.is_vaccination_valid(&token_id));

    // A second revocation must not resurrect the record.
    let _ = client.try_revoke_vaccination(&token_id);
    assert!(!client.is_vaccination_valid(&token_id));
}

#[test]
fn invariant_revoking_record_does_not_revoke_issuer() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    let token_id = mint(&env, &client, &patient, &issuer, "COVID-19", "2024-01-15", None);

    client.revoke_vaccination(&token_id).unwrap();

    // Issuer permission is unaffected by record revocation.
    assert!(client.is_issuer(&issuer));
    let next = mint(&env, &client, &patient, &issuer, "COVID-19", "2024-03-15", Some(2));
    assert!(client.is_vaccination_valid(&next));
}

// ── Duplicate-record detection ───────────────────────────────────────────────

#[test]
fn invariant_exact_duplicate_is_rejected() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    mint(&env, &client, &patient, &issuer, "COVID-19", "2024-01-15", Some(1));

    let result = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &Some(1u32),
        &None::<u32>,
    );

    assert_eq!(result, Err(Ok(ContractError::DuplicateRecord)));
}

#[test]
fn invariant_case_and_whitespace_variants_are_duplicates() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    mint(&env, &client, &patient, &issuer, "COVID-19", "2024-01-15", Some(1));

    // Case variant of the vaccine name.
    let case_variant = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "covid-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &Some(1u32),
        &None::<u32>,
    );
    assert_eq!(case_variant, Err(Ok(ContractError::DuplicateRecord)));

    // Whitespace-padded variant of the vaccine name.
    let padded_variant = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "  COVID-19  "),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &Some(1u32),
        &None::<u32>,
    );
    assert_eq!(padded_variant, Err(Ok(ContractError::DuplicateRecord)));
}

#[test]
fn invariant_legitimate_repeat_doses_are_allowed() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);

    let dose1 = mint(&env, &client, &patient, &issuer, "COVID-19", "2024-01-15", Some(1));
    let dose2 = mint(&env, &client, &patient, &issuer, "COVID-19", "2024-02-15", Some(2));

    assert_ne!(dose1, dose2);
    assert!(client.is_vaccination_valid(&dose1));
    assert!(client.is_vaccination_valid(&dose2));
}

// ── Issuer lifecycle state machine ───────────────────────────────────────────

#[test]
fn invariant_issuer_add_revoke_readd_transitions() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);

    assert!(!client.is_issuer(&issuer));

    add_issuer(&env, &client, &issuer);
    assert!(client.is_issuer(&issuer));

    client.revoke_issuer(&issuer).unwrap();
    assert!(!client.is_issuer(&issuer));

    // Re-add after revocation is allowed.
    add_issuer(&env, &client, &issuer);
    assert!(client.is_issuer(&issuer));
}

#[test]
fn invariant_revoking_unknown_issuer_has_explicit_semantics() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);

    // Revoking a never-registered issuer must not silently succeed as a state change.
    let result = client.try_revoke_issuer(&issuer);
    assert!(result.is_err(), "Revoking an unknown issuer must return an error");
    assert!(!client.is_issuer(&issuer));
}

#[test]
fn invariant_issuer_handoff_preserves_audit_trail() {
    let (env, client, admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let new_admin = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);

    // Hand off administrator role.
    client.transfer_admin(&new_admin).unwrap();
    assert_eq!(client.get_admin(), new_admin);

    // The old admin can no longer mutate issuer state.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &admin,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "revoke_issuer",
            args: (issuer.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let result = client.try_revoke_issuer(&issuer);
    assert!(result.is_err(), "Former admin must not revoke issuers after handoff");
    assert!(client.is_issuer(&issuer));
}

// ── Administrator rotation / recovery flow ───────────────────────────────────

#[test]
fn invariant_admin_rotation_proposal_and_acceptance() {
    let (env, client, admin) = setup();
    let new_admin = soroban_sdk::Address::generate(&env);

    client.propose_admin(&new_admin).unwrap();
    assert_eq!(client.get_pending_admin(), Some(new_admin.clone()));

    // Acceptance must be authorized by the proposed admin.
    client.accept_admin(&new_admin).unwrap();
    assert_eq!(client.get_admin(), new_admin);
    assert_eq!(client.get_pending_admin(), None);
    let _ = admin;
}

#[test]
fn invariant_admin_rotation_proposal_expires() {
    let (env, client, _admin) = setup();
    let new_admin = soroban_sdk::Address::generate(&env);

    client.propose_admin(&new_admin).unwrap();

    // Advance ledger past the proposal expiry window.
    env.ledger().set_sequence_number(env.ledger().sequence() + 100_000);

    let result = client.try_accept_admin(&new_admin);
    assert!(result.is_err(), "Expired proposal must not be acceptable");
}

#[test]
fn invariant_admin_rotation_replay_rejected() {
    let (env, client, _admin) = setup();
    let new_admin = soroban_sdk::Address::generate(&env);

    client.propose_admin(&new_admin).unwrap();
    client.accept_admin(&new_admin).unwrap();

    // Replaying acceptance after completion must fail.
    let replay = client.try_accept_admin(&new_admin);
    assert!(replay.is_err(), "Replayed acceptance must be rejected");
}

#[test]
fn invariant_admin_rotation_can_be_cancelled() {
    let (env, client, admin) = setup();
    let new_admin = soroban_sdk::Address::generate(&env);

    client.propose_admin(&new_admin).unwrap();
    client.cancel_admin_proposal().unwrap();
    assert_eq!(client.get_pending_admin(), None);

    // After cancellation the proposal cannot be accepted.
    let result = client.try_accept_admin(&new_admin);
    assert!(result.is_err(), "Cancelled proposal must not be acceptable");
    assert_eq!(client.get_admin(), admin);
}

#[test]
fn invariant_unauthorized_admin_rotation_attempts_fail() {
    let (env, client, admin) = setup();
    let attacker = soroban_sdk::Address::generate(&env);
    let target = soroban_sdk::Address::generate(&env);

    // Non-admin cannot propose a rotation.
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "propose_admin",
            args: (target.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let propose = client.try_propose_admin(&target);
    assert!(propose.is_err(), "Non-admin must not propose a rotation");
    assert_eq!(client.get_admin(), admin);

    // Non-target cannot accept a pending proposal.
    client.propose_admin(&target).unwrap();
    env.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &client.address,
            fn_name: "accept_admin",
            args: (attacker.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let accept = client.try_accept_admin(&attacker);
    assert!(accept.is_err(), "Unauthorized acceptance must be rejected");
    assert_eq!(client.get_admin(), admin);
}
