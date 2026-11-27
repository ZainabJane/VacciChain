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

// ── Helpers for soulbound / boundary invariants (Issues #75, #77) ────────────

/// Snapshot the full contract storage as a comparable vector of (key, value)
/// pairs. Used to prove that prohibited operations do not mutate state.
fn storage_snapshot(env: &Env, contract_id: &soroban_sdk::Address) -> soroban_sdk::Vec<(soroban_sdk::Val, soroban_sdk::Val)> {
    env.as_contract(contract_id, || {
        let mut out = soroban_sdk::Vec::new(env);
        for key in env.storage().instance().keys() {
            if let Some(val) = env.storage().instance().get::<soroban_sdk::Val, soroban_sdk::Val>(&key) {
                out.push_back((key, val));
            }
        }
        for key in env.storage().persistent().keys() {
            if let Some(val) = env.storage().persistent().get::<soroban_sdk::Val, soroban_sdk::Val>(&key) {
                out.push_back((key, val));
            }
        }
        for key in env.storage().temporary().keys() {
            if let Some(val) = env.storage().temporary().get::<soroban_sdk::Val, soroban_sdk::Val>(&key) {
                out.push_back((key, val));
            }
        }
        out
    })
}

/// Assert that a prohibited operation failed with `SoulboundToken`, emitted no
/// events, and left storage byte-for-byte unchanged.
fn assert_soulbound_rejected<F>(env: &Env, client: &VacciChainContractClient, op: F)
where
    F: FnOnce() -> Result<Result<(), ContractError>, Result<ContractError, soroban_sdk::InvokeError>>,
{
    let before = storage_snapshot(env, &client.address);
    let result = op();
    assert_eq!(result, Err(Ok(ContractError::SoulboundToken)));
    let after = storage_snapshot(env, &client.address);
    assert_eq!(before, after, "prohibited op must not mutate storage");
    assert_eq!(env.events().all().len(), 0, "prohibited op must not emit events");
}

// ── Storage lifecycle & TTL assumptions (Issue #90) ──────────────────────────
//
// Soroban persistent storage entries can expire when their TTL (time-to-live,
// measured in ledgers) is not extended. The contract makes the following
// assumptions, which the tests below validate:
//
// 1. Every write to a persistent entry (admin, issuer, patient, vaccination
//    record, pause flag) extends that entry's TTL so it does not silently
//    expire between transactions.
// 2. Reads of missing/expired entries must degrade to a safe, recoverable
//    state: `verify_vaccination` reports "not vaccinated" rather than
//    panicking, and state-changing calls return a typed `ContractError`.
// 3. Authorization checks must never fail open. If the admin or issuer entry
//    is absent/expired, privileged calls must be denied (Unauthorized /
//    NotInitialized) rather than permitted.
// 4. Expired/missing entries must be recoverable: re-initialization or
//    re-registration restores normal operation.

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

// ── Soulbound enforcement across all ownership-changing entry points (#75) ───

#[test]
fn invariant_transfer_does_not_mutate_or_emit() {
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

// ── Missing / expired persistent entries (Issue #90) ─────────────────────────

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
fn invariant_verification_degrades_gracefully_on_expired_entries() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);

    client.mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &None::<u32>,
        &None::<u32>,
    );

    // Clear events emitted by setup/mint so we only observe the transfer.
    let _ = env.events().all();

    assert_soulbound_rejected(&env, &client, || {
        client.try_transfer(&patient, &recipient, &token_id)
    });
}

#[test]
fn invariant_approve_rejected_as_soulbound() {
    let (env, client, _admin) = setup();
    let owner = soroban_sdk::Address::generate(&env);
    let spender = soroban_sdk::Address::generate(&env);

    assert_soulbound_rejected(&env, &client, || {
        client.try_approve(&owner, &spender, &1u64, &100u32)
    });
}

#[test]
fn invariant_allowance_is_always_zero() {
    let (env, client, _admin) = setup();
    let owner = soroban_sdk::Address::generate(&env);
    let spender = soroban_sdk::Address::generate(&env);

    // No approval path may ever grant an allowance on a soulbound token.
    let allowance = client.allowance(&owner, &spender);
    assert_eq!(allowance, 0, "soulbound tokens must never have allowances");
}

#[test]
fn invariant_verify_vaccination_degrades_on_expiry() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    client.mint(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &None::<u32>,
        &None::<u32>,
    );

    let (vaccinated, records, _) = client.verify_vaccination(&patient);
    assert!(vaccinated);
    assert_eq!(records.len(), 1);

    // Simulate expiry of the patient's persistent entries.
    env.as_contract(&client.address, || {
        env.storage().persistent().remove(&patient);
    });

    // Verification must degrade gracefully, not panic.
    let (vaccinated, records, _) = client.verify_vaccination(&patient);
    assert!(!vaccinated, "Expired entries must not report vaccinated");
    assert_eq!(records.len(), 0, "Expired entries must yield no records");
}

#[test]
fn invariant_clawback_rejected_as_soulbound() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    // Simulate expiry of the issuer's persistent entry.
    env.as_contract(&client.address, || {
        env.storage().persistent().remove(&issuer);
    });

    let result = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &Some(1u32),
        &None::<u32>,
    );

    let _ = env.events().all();

    assert_soulbound_rejected(&env, &client, || {
        client.try_clawback(&issuer, &patient, &token_id)
    });
}

#[test]
fn invariant_burn_rejected_as_soulbound() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    let token_id = client.mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &None::<u32>,
        &None::<u32>,
    );

    let _ = env.events().all();

    assert_soulbound_rejected(&env, &client, || {
        client.try_burn(&patient, &token_id)
    });
}

#[test]
fn invariant_transfer_from_rejected_as_soulbound() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);
    let spender = soroban_sdk::Address::generate(&env);
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

    let _ = env.events().all();

    // Alternate entry point: transfer_from must be equally blocked.
    assert_soulbound_rejected(&env, &client, || {
        client.try_transfer_from(&spender, &patient, &recipient, &token_id)
    });
}

// ── Input length / collection size boundaries (#77) ──────────────────────────

const MAX_NAME_LEN: u32 = 64;
const MAX_DATE_LEN: u32 = 32;
const MAX_LICENSE_LEN: u32 = 64;
const MAX_COUNTRY_LEN: u32 = 32;
const MAX_PATIENT_RECORDS: u32 = 32;
const MAX_BATCH_SIZE: u32 = 20;

fn repeat(env: &Env, ch: char, len: u32) -> String {
    let mut s = String::from_str(env, "");
    for _ in 0..len {
        s.push_back(ch);
    }
    s
}

fn assert_rejected_without_writes<F>(env: &Env, client: &VacciChainContractClient, op: F)
where
    F: FnOnce() -> Result<Result<u64, ContractError>, Result<ContractError, soroban_sdk::InvokeError>>,
{
    let before = storage_snapshot(env, &client.address);
    let result = op();
    assert!(result.is_err(), "oversized input must be rejected");
    let after = storage_snapshot(env, &client.address);
    assert_eq!(before, after, "rejected input must not partially write storage");
}

#[test]
fn boundary_vaccine_name_zero_max_and_over() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);
    add_issuer(&env, &client, &issuer);

    // Zero-length name: rejected.
    assert_rejected_without_writes(&env, &client, || {
        client.try_mint_vaccination(
            &patient,
            &String::from_str(&env, ""),
            &String::from_str(&env, "2024-01-15"),
            &issuer,
            &None::<u32>,
            &None::<u32>,
        )
    });

    // Max valid name: accepted.
    let max_name = repeat(&env, 'A', MAX_NAME_LEN);
    let ok = client.try_mint_vaccination(
        &patient,
        &max_name,
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &None::<u32>,
        &None::<u32>,
    );
    assert!(ok.is_ok(), "max-length vaccine name must be accepted");

    // One over the limit: rejected without writes.
    let over_name = repeat(&env, 'A', MAX_NAME_LEN + 1);
    assert_rejected_without_writes(&env, &client, || {
        client.try_mint_vaccination(
            &patient,
            &over_name,
            &String::from_str(&env, "2024-01-15"),
            &issuer,
            &None::<u32>,
            &None::<u32>,
        )
    });
}

#[test]
fn boundary_date_zero_max_and_over() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);
    add_issuer(&env, &client, &issuer);

    assert_rejected_without_writes(&env, &client, || {
        client.try_mint_vaccination(
            &patient,
            &String::from_str(&env, "COVID-19"),
            &String::from_str(&env, ""),
            &issuer,
            &None::<u32>,
            &None::<u32>,
        )
    });

    let max_date = repeat(&env, '1', MAX_DATE_LEN);
    let ok = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &max_date,
        &issuer,
        &None::<u32>,
        &None::<u32>,
    );
    assert!(ok.is_ok(), "max-length date must be accepted");

    let over_date = repeat(&env, '1', MAX_DATE_LEN + 1);
    assert_rejected_without_writes(&env, &client, || {
        client.try_mint_vaccination(
            &patient,
            &String::from_str(&env, "COVID-19"),
            &over_date,
            &issuer,
            &None::<u32>,
            &None::<u32>,
        )
    });
}

#[test]
fn boundary_issuer_name_zero_max_and_over() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);

    assert_rejected_without_writes(&env, &client, || {
        client.try_add_issuer(
            &issuer,
            &String::from_str(&env, ""),
            &String::from_str(&env, "LIC-001"),
            &String::from_str(&env, "USA"),
        )
    });

    let max_name = repeat(&env, 'H', MAX_NAME_LEN);
    let ok = client.try_add_issuer(
        &issuer,
        &max_name,
        &String::from_str(&env, "LIC-001"),
        &String::from_str(&env, "USA"),
    );
    assert!(ok.is_ok(), "max-length issuer name must be accepted");

    let over_name = repeat(&env, 'H', MAX_NAME_LEN + 1);
    assert_rejected_without_writes(&env, &client, || {
        client.try_add_issuer(
            &issuer,
            &over_name,
            &String::from_str(&env, "LIC-001"),
            &String::from_str(&env, "USA"),
        )
    });
}

#[test]
fn boundary_issuer_license_zero_max_and_over() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);

    assert_rejected_without_writes(&env, &client, || {
        client.try_add_issuer(
            &issuer,
            &String::from_str(&env, "Hospital"),
            &String::from_str(&env, ""),
            &String::from_str(&env, "USA"),
        )
    });

    let max_license = repeat(&env, 'L', MAX_LICENSE_LEN);
    let ok = client.try_add_issuer(
        &issuer,
        &String::from_str(&env, "Hospital"),
        &max_license,
        &String::from_str(&env, "USA"),
    );
    assert!(ok.is_ok(), "max-length license must be accepted");

    let over_license = repeat(&env, 'L', MAX_LICENSE_LEN + 1);
    assert_rejected_without_writes(&env, &client, || {
        client.try_add_issuer(
            &issuer,
            &String::from_str(&env, "Hospital"),
            &over_license,
            &String::from_str(&env, "USA"),
        )
    });
}

#[test]
fn boundary_issuer_country_zero_max_and_over() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);

    assert_rejected_without_writes(&env, &client, || {
        client.try_add_issuer(
            &issuer,
            &String::from_str(&env, "Hospital"),
            &String::from_str(&env, "LIC-001"),
            &String::from_str(&env, ""),
        )
    });

    let max_country = repeat(&env, 'U', MAX_COUNTRY_LEN);
    let ok = client.try_add_issuer(
        &issuer,
        &String::from_str(&env, "Hospital"),
        &String::from_str(&env, "LIC-001"),
        &max_country,
    );
    assert!(ok.is_ok(), "max-length country must be accepted");

    let over_country = repeat(&env, 'U', MAX_COUNTRY_LEN + 1);
    assert_rejected_without_writes(&env, &client, || {
        client.try_add_issuer(
            &issuer,
            &String::from_str(&env, "Hospital"),
            &String::from_str(&env, "LIC-001"),
            &over_country,
        )
    });
}

#[test]
fn boundary_patient_record_count_max_and_over() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);
    add_issuer(&env, &client, &issuer);

    // Fill up to the documented maximum record count.
    for _ in 0..MAX_PATIENT_RECORDS {
        client.mint_vaccination(
            &patient,
            &String::from_str(&env, "COVID-19"),
            &String::from_str(&env, "2024-01-15"),
            &issuer,
            &None::<u32>,
            &None::<u32>,
        ).unwrap();
    }

    // One over the limit: rejected without partial writes.
    assert_rejected_without_writes(&env, &client, || {
        client.try_mint_vaccination(
            &patient,
            &String::from_str(&env, "COVID-19"),
            &String::from_str(&env, "2024-01-15"),
            &issuer,
            &None::<u32>,
            &None::<u32>,
        )
    });
}

#[test]
fn invariant_revoke_with_missing_issuer_entry_denies() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);

    env.as_contract(&client.address, || {
        env.storage().persistent().remove(&issuer);
    });

    // Revoking an already-absent issuer must not succeed silently.
    let result = client.try_revoke_issuer(&issuer);
    assert!(result.is_err(), "Revoke of expired issuer must be denied");
}

#[test]
fn invariant_add_issuer_with_missing_admin_denies() {
    let (env, client, admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);

    // Simulate expiry of the admin entry.
    env.as_contract(&client.address, || {
        env.storage().persistent().remove(&admin);
    });

    let result = client.try_add_issuer(
        &issuer,
        &String::from_str(&env, "Hospital"),
        &String::from_str(&env, "LIC"),
        &String::from_str(&env, "USA"),
    );

    // Missing admin must not fail open.
    assert!(result.is_err(), "Missing admin must deny add_issuer");
}

#[test]
fn invariant_missing_admin_blocks_pause() {
    let (env, client, admin) = setup();

    env.as_contract(&client.address, || {
        env.storage().persistent().remove(&admin);
    });

    let result = client.try_pause();
    assert!(result.is_err(), "Missing admin must deny pause");
}

#[test]
fn invariant_writes_extend_ttl() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);
    client.register_patient(&patient);
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

    // After writes, the persistent entries must have a live TTL.
    env.as_contract(&client.address, || {
        let issuer_ttl = env.storage().persistent().get_ttl(&issuer);
        let patient_ttl = env.storage().persistent().get_ttl(&patient);
        assert!(issuer_ttl > 0, "Issuer entry TTL must be extended on write");
        assert!(patient_ttl > 0, "Patient entry TTL must be extended on write");
    });
}

#[test]
fn boundary_batch_size_max_and_over() {
    let (env, client, _admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    add_issuer(&env, &client, &issuer);

    // Build a batch at the documented maximum size.
    let mut max_batch = soroban_sdk::Vec::new(&env);
    for i in 0..MAX_BATCH_SIZE {
        let patient = soroban_sdk::Address::generate(&env);
        max_batch.push_back((
            patient,
            String::from_str(&env, "COVID-19"),
            String::from_str(&env, "2024-01-15"),
            i,
        ));
    }
    let ok = client.try_batch_mint(&issuer, &max_batch);
    assert!(ok.is_ok(), "max-size batch must be accepted");

    // One over the limit: rejected without partial writes.
    let mut over_batch = soroban_sdk::Vec::new(&env);
    for i in 0..(MAX_BATCH_SIZE + 1) {
        let patient = soroban_sdk::Address::generate(&env);
        over_batch.push_back((
            patient,
            String::from_str(&env, "COVID-19"),
            String::from_str(&env, "2024-01-15"),
            i,
        ));
    }
    assert_rejected_without_writes(&env, &client, || {
        client.try_batch_mint(&issuer, &over_batch)
    });
}

#[test]
fn invariant_expired_entries_recover_after_reinit() {
    let (env, client, admin) = setup();
    let issuer = soroban_sdk::Address::generate(&env);
    let patient = soroban_sdk::Address::generate(&env);

    add_issuer(&env, &client, &issuer);

    // Simulate expiry of admin + issuer entries.
    env.as_contract(&client.address, || {
        env.storage().persistent().remove(&admin);
        env.storage().persistent().remove(&issuer);
    });

    // Privileged calls are denied while state is absent.
    assert!(client.try_pause().is_err());

    // Re-initialization restores a usable contract.
    client.initialize(&admin).unwrap();
    add_issuer(&env, &client, &issuer);

    let result = client.try_mint_vaccination(
        &patient,
        &String::from_str(&env, "COVID-19"),
        &String::from_str(&env, "2024-01-15"),
        &issuer,
        &None::<u32>,
        &None::<u32>,
    );
    assert!(result.is_ok(), "Contract must recover after re-initialization");
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
