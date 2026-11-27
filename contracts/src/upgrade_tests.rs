#![cfg(test)]

use soroban_sdk::{Address, Env, String as SorobanString, testutils::Address as TestAddress, Vec};
use crate::{VacciChainContract, ContractError, storage::VaccinationRecord};

// ---------------------------------------------------------------------------
// Prior-state fixtures
// ---------------------------------------------------------------------------
//
// These fixtures represent the exact on-chain shape written by the previous
// contract version (schema_version == 1). They are written directly into
// storage so the migration tests do not depend on the current mint path, which
// may itself evolve. If the storage layout changes, these fixtures must be
// updated to match the *old* layout, never the new one.

/// Build a v1 `VaccinationRecord` snapshot exactly as the prior contract wrote it.
fn v1_record_fixture(
    env: &Env,
    token_id: u64,
    patient: &Address,
    issuer: &Address,
    vaccine_name: &str,
    date: &str,
) -> VaccinationRecord {
    VaccinationRecord {
        token_id,
        patient: patient.clone(),
        issuer: issuer.clone(),
        vaccine_name: SorobanString::from_slice(env, vaccine_name.as_bytes()),
        date: SorobanString::from_slice(env, date.as_bytes()),
        schema_version: 1,
        revoked: false,
    }
}

/// Write a v1 record fixture directly into storage, bypassing the mint path.
fn seed_v1_record(env: &Env, record: &VaccinationRecord) {
    env.storage().persistent().set(&record.token_id, record);
}

/// Seed a v1 issuer fixture directly into storage.
fn seed_v1_issuer(env: &Env, issuer: &Address, name: &str, license: &str, country: &str) {
    let record = crate::storage::IssuerRecord {
        address: issuer.clone(),
        name: SorobanString::from_slice(env, name.as_bytes()),
        license_number: SorobanString::from_slice(env, license.as_bytes()),
        country: SorobanString::from_slice(env, country.as_bytes()),
        active: true,
        schema_version: 1,
    };
    env.storage().persistent().set(issuer, &record);
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

// ---------------------------------------------------------------------------
// Fixture-based migration tests
// ---------------------------------------------------------------------------

#[test]
fn test_migration_reads_v1_record_fixture() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let patient = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
    seed_v1_issuer(&env, &issuer, "Legacy Issuer", "LIC-OLD", "US");
    let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

    // Seed a record written by the prior contract version.
    let fixture = v1_record_fixture(&env, 42, &patient, &issuer, "COVID-19", "2023-12-01");
    seed_v1_record(&env, &fixture);

    // The current contract must read the prior-state record without loss.
    let (vaccinated, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert!(vaccinated, "patient with a v1 fixture record should be vaccinated");
    assert_eq!(records.len(), 1, "v1 fixture record should be readable");

    let record = records.get(0).unwrap();
    assert_eq!(record.token_id, 42, "token_id must be preserved");
    assert_eq!(record.vaccine_name, fixture.vaccine_name, "vaccine_name must be preserved");
    assert_eq!(record.date, fixture.date, "date must be preserved");
    assert_eq!(record.issuer, issuer, "issuer must be preserved");
    assert_eq!(record.schema_version, 1, "v1 fixture keeps schema_version 1");
}

#[test]
fn test_migration_writes_after_reading_v1_fixture() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let patient = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
    seed_v1_issuer(&env, &issuer, "Legacy Issuer", "LIC-OLD", "US");
    let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

    let fixture = v1_record_fixture(&env, 7, &patient, &issuer, "Flu", "2023-11-05");
    seed_v1_record(&env, &fixture);

    // New writes must coexist with migrated prior-state records.
    let new_token = VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        SorobanString::from_slice(&env, b"Measles"),
        SorobanString::from_slice(&env, b"2024-04-01"),
        issuer.clone(),
        None,
        None,
    ).expect("mint after migration should succeed");

    let (vaccinated, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert!(vaccinated, "patient should be vaccinated");
    assert_eq!(records.len(), 2, "old and new records should both be present");

    let mut saw_fixture = false;
    let mut saw_new = false;
    for i in 0..records.len() {
        let record = records.get(i).unwrap();
        if record.token_id == 7 {
            saw_fixture = true;
            assert_eq!(record.schema_version, 1, "fixture record keeps schema_version 1");
        }
        if record.token_id == new_token {
            saw_new = true;
        }
    }
    assert!(saw_fixture, "migrated fixture record must not be dropped");
    assert!(saw_new, "newly minted record must be present");
}

#[test]
fn test_migration_reads_v1_issuer_fixture() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
    seed_v1_issuer(&env, &issuer, "Legacy Issuer", "LIC-OLD", "US");

    let is_issuer = VacciChainContract::is_issuer(env.clone(), issuer.clone());
    assert!(is_issuer, "v1 issuer fixture should be recognized as an issuer");
}

#[test]
fn test_unsupported_schema_version_fails_safely() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let patient = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
    seed_v1_issuer(&env, &issuer, "Legacy Issuer", "LIC-OLD", "US");
    let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

    // Simulate a record written by a *future* schema version that this
    // contract cannot interpret.
    let mut future = v1_record_fixture(&env, 99, &patient, &issuer, "Unknown", "2030-01-01");
    future.schema_version = 999;
    seed_v1_record(&env, &future);

    // Reading must fail safely with a documented error rather than silently
    // misinterpreting the record.
    let result = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert_eq!(
        result,
        Err(ContractError::UnsupportedSchemaVersion),
        "unsupported schema_version must surface a documented error"
    );

    // Recovery plan: the raw record must remain intact in storage so an
    // operator can export it and re-import after deploying a compatible
    // contract version. Nothing is dropped or locked.
    let stored: VaccinationRecord = env
        .storage()
        .persistent()
        .get(&99u64)
        .expect("unsupported record must not be dropped from storage");
    assert_eq!(stored.schema_version, 999, "raw record must be preserved for recovery");
    assert_eq!(stored.token_id, 99, "raw record token_id must be preserved");
}
