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
fn invariant_clawback_rejected_as_soulbound() {
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
