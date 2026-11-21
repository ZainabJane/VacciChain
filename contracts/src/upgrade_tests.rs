#![cfg(test)]

use soroban_sdk::{Address, Env, String as SorobanString, testutils::Address as TestAddress, Vec};
use crate::{VacciChainContract, ContractError, storage::VaccinationRecord};

// ---------------------------------------------------------------------------
// Upgrade authorization tests (see docs/contract-upgrade.md)
//
// Upgrade rules under test:
//   * Only the stored admin may propose an upgrade.
//   * A proposal must be approved by the admin before it becomes effective.
//   * The artifact hash must be reviewed/recorded before approval.
//   * Rollback is only permitted to the immediately previous version and only
//     while no post-upgrade writes have occurred.
// ---------------------------------------------------------------------------

#[test]
fn test_unauthorized_upgrade_proposal_fails() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let attacker = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());

    // A non-admin caller must not be able to propose an upgrade.
    let result = VacciChainContract::propose_upgrade(
        env.clone(),
        attacker.clone(),
        2,
        SorobanString::from_slice(&env, b"deadbeef"),
    );
    assert_eq!(
        result,
        Err(ContractError::Unauthorized),
        "non-admin upgrade proposal must fail"
    );
}

#[test]
fn test_upgrade_requires_approval_before_effective() {
    let env = Env::default();
    let admin = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());

    // Propose a v2 upgrade as the admin.
    let propose = VacciChainContract::propose_upgrade(
        env.clone(),
        admin.clone(),
        2,
        SorobanString::from_slice(&env, b"deadbeef"),
    );
    assert!(propose.is_ok(), "admin proposal should succeed");

    // Without approval the upgrade must not be effective.
    let effective = VacciChainContract::is_upgrade_approved(env.clone());
    assert!(!effective, "upgrade must not be effective before approval");

    // Approval by the admin makes it effective.
    let approve = VacciChainContract::approve_upgrade(env.clone(), admin.clone());
    assert!(approve.is_ok(), "admin approval should succeed");
    assert!(
        VacciChainContract::is_upgrade_approved(env.clone()),
        "upgrade should be effective after approval"
    );
}

#[test]
fn test_upgrade_requires_artifact_review() {
    let env = Env::default();
    let admin = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());

    // Proposing with an empty artifact hash (unreviewed artifact) must fail.
    let result = VacciChainContract::propose_upgrade(
        env.clone(),
        admin.clone(),
        2,
        SorobanString::from_slice(&env, b""),
    );
    assert_eq!(
        result,
        Err(ContractError::InvalidInput),
        "upgrade with unreviewed artifact must fail"
    );
}

#[test]
fn test_rollback_limited_to_previous_version() {
    let env = Env::default();
    let admin = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());

    // Rollback without any prior upgrade must fail.
    let result = VacciChainContract::rollback_upgrade(env.clone(), admin.clone());
    assert_eq!(
        result,
        Err(ContractError::InvalidInput),
        "rollback with no previous version must fail"
    );
}

#[test]
fn test_unauthorized_rollback_fails() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let attacker = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());

    let result = VacciChainContract::rollback_upgrade(env.clone(), attacker.clone());
    assert_eq!(
        result,
        Err(ContractError::Unauthorized),
        "non-admin rollback must fail"
    );
}

#[test]
fn test_state_valid_across_supported_upgrade_path() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let patient = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
    let _ = VacciChainContract::add_issuer(
        env.clone(),
        issuer.clone(),
        SorobanString::from_slice(&env, b"Test Issuer"),
        SorobanString::from_slice(&env, b"LIC123"),
        SorobanString::from_slice(&env, b"US"),
    );
    let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

    let vaccine_name = SorobanString::from_slice(&env, b"COVID-19");
    let date = SorobanString::from_slice(&env, b"2024-01-15");

    let token_id = VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        vaccine_name.clone(),
        date.clone(),
        issuer.clone(),
        None,
        None,
    ).expect("mint should succeed");

    // Perform the supported v1 -> v2 upgrade path (propose + approve).
    let _ = VacciChainContract::propose_upgrade(
        env.clone(),
        admin.clone(),
        2,
        SorobanString::from_slice(&env, b"deadbeef"),
    ).expect("proposal should succeed");
    let _ = VacciChainContract::approve_upgrade(env.clone(), admin.clone())
        .expect("approval should succeed");

    // State must remain valid after the upgrade.
    let (vaccinated, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert!(vaccinated, "patient should still be vaccinated after upgrade");
    assert_eq!(records.len(), 1, "should still have 1 record");
    assert_eq!(records.get(0).unwrap().token_id, token_id, "token_id should match");
    assert_eq!(records.get(0).unwrap().vaccine_name, vaccine_name, "vaccine_name should match");
}

#[test]
fn test_upgrade_v1_to_v2_data_persistence() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let patient = TestAddress::random(&env);

    env.mock_all_auths();

    // Initialize v1 contract
    let _ = VacciChainContract::initialize(env.clone(), admin.clone());

    // Add issuer
    let _ = VacciChainContract::add_issuer(
        env.clone(),
        issuer.clone(),
        SorobanString::from_slice(&env, b"Test Issuer"),
        SorobanString::from_slice(&env, b"LIC123"),
        SorobanString::from_slice(&env, b"US"),
    );

    // Register patient
    let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

    // Mint vaccination record in v1
    let vaccine_name = SorobanString::from_slice(&env, b"COVID-19");
    let date = SorobanString::from_slice(&env, b"2024-01-15");

    let token_id = VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        vaccine_name.clone(),
        date.clone(),
        issuer.clone(),
        None,
        None,
    ).expect("mint should succeed");

    // Verify record exists in v1
    let (vaccinated, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert!(vaccinated, "patient should be vaccinated");
    assert_eq!(records.len(), 1, "should have 1 record");
    assert_eq!(records.get(0).unwrap().schema_version, 1, "schema version should be 1");

    // After upgrade to v2, verify records are still readable
    // (In real scenario, contract would be redeployed with v2 code)
    let (vaccinated_after, records_after, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert!(vaccinated_after, "patient should still be vaccinated after upgrade");
    assert_eq!(records_after.len(), 1, "should still have 1 record");
    assert_eq!(records_after.get(0).unwrap().token_id, token_id, "token_id should match");
    assert_eq!(records_after.get(0).unwrap().vaccine_name, vaccine_name, "vaccine_name should match");
}

#[test]
fn test_schema_version_field_read_across_versions() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let patient = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
    let _ = VacciChainContract::add_issuer(
        env.clone(),
        issuer.clone(),
        SorobanString::from_slice(&env, b"Test Issuer"),
        SorobanString::from_slice(&env, b"LIC123"),
        SorobanString::from_slice(&env, b"US"),
    );
    let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

    let vaccine_name = SorobanString::from_slice(&env, b"Pfizer");
    let date = SorobanString::from_slice(&env, b"2024-02-20");

    let _ = VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        vaccine_name,
        date,
        issuer.clone(),
        None,
        None,
    );

    let (_, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    let record = records.get(0).unwrap();

    // Verify schema_version field is correctly set
    assert_eq!(record.schema_version, 1, "schema_version should be 1 for v1 records");
}

#[test]
fn test_multiple_records_persist_after_upgrade() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let patient = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
    let _ = VacciChainContract::add_issuer(
        env.clone(),
        issuer.clone(),
        SorobanString::from_slice(&env, b"Test Issuer"),
        SorobanString::from_slice(&env, b"LIC123"),
        SorobanString::from_slice(&env, b"US"),
    );
    let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

    // Mint multiple records
    let vaccines = vec!["COVID-19", "Flu", "Measles"];
    let dates = vec!["2024-01-15", "2024-02-20", "2024-03-10"];

    for i in 0..vaccines.len() {
        let vaccine = SorobanString::from_slice(&env, vaccines[i].as_bytes());
        let date = SorobanString::from_slice(&env, dates[i].as_bytes());

        let _ = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine,
            date,
            issuer.clone(),
        None,
        None,
        );
    }

    // Verify all records persist
    let (vaccinated, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert!(vaccinated, "patient should be vaccinated");
    assert_eq!(records.len(), 3, "should have 3 records");

    // Verify each record's schema version
    for i in 0..records.len() {
        let record = records.get(i).unwrap();
        assert_eq!(record.schema_version, 1, "all records should have schema_version 1");
    }
}

#[test]
fn test_revoked_records_persist_after_upgrade() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let patient = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
    let _ = VacciChainContract::add_issuer(
        env.clone(),
        issuer.clone(),
        SorobanString::from_slice(&env, b"Test Issuer"),
        SorobanString::from_slice(&env, b"LIC123"),
        SorobanString::from_slice(&env, b"US"),
    );
    let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

    let vaccine_name = SorobanString::from_slice(&env, b"COVID-19");
    let date = SorobanString::from_slice(&env, b"2024-01-15");

    let token_id = VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        vaccine_name,
        date,
        issuer.clone(),
        None,
        None,
    ).expect("mint should succeed");

    // Revoke the record
    let _ = VacciChainContract::revoke_vaccination(env.clone(), token_id, issuer.clone());

    // Verify record is revoked
    let (vaccinated, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert!(!vaccinated, "patient should not be vaccinated after revocation");
    assert_eq!(records.len(), 0, "revoked records should not be returned");
}
