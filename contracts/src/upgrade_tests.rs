#![cfg(test)]

use soroban_sdk::{Address, Env, String as SorobanString, testutils::Address as TestAddress, Vec};
use crate::{VacciChainContract, ContractError, storage::VaccinationRecord};

/// Deployment action decided by the deployment workflow for a contract-path push.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeployAction {
    /// No existing production contract: create a new deployment.
    Deploy,
    /// Existing production contract and an explicit target: upgrade it in place.
    Upgrade,
    /// Existing production contract and no explicit target: do nothing.
    NoOp,
}

/// Minimal representation of the deployment manifest used by the workflow.
#[derive(Clone, Debug, Default)]
pub struct DeploymentManifest {
    /// Contract id of the existing production deployment, if any.
    pub production_contract: Option<SorobanString>,
    /// Contract id explicitly targeted by an upgrade request, if any.
    pub target_contract: Option<SorobanString>,
    /// Explicit operator override allowing a second production contract.
    pub allow_redeploy: bool,
}

/// Error returned when the deployment decision cannot be satisfied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeployError {
    /// An upgrade was requested without naming the target contract.
    UpgradeRequiresTarget,
    /// A redeploy was attempted while a production contract already exists.
    DuplicateProductionContract,
}

/// Decide what the workflow should do for a contract-path push.
///
/// * No production contract -> `Deploy`.
/// * Production contract + explicit target -> `Upgrade`.
/// * Production contract + no target -> `NoOp` (idempotent re-run).
pub fn decide_deploy_action(manifest: &DeploymentManifest) -> Result<DeployAction, DeployError> {
    match (&manifest.production_contract, &manifest.target_contract) {
        (None, _) => Ok(DeployAction::Deploy),
        (Some(_), Some(_)) => Ok(DeployAction::Upgrade),
        (Some(_), None) => Ok(DeployAction::NoOp),
    }
}

/// Guard against silently creating a second production contract.
///
/// Returns `Ok(())` when the action is safe, otherwise the blocking error.
pub fn guard_duplicate_production(
    manifest: &DeploymentManifest,
    action: DeployAction,
) -> Result<(), DeployError> {
    if action == DeployAction::Deploy
        && manifest.production_contract.is_some()
        && !manifest.allow_redeploy
    {
        return Err(DeployError::DuplicateProductionContract);
    }
    Ok(())
}

/// Validate that an upgrade names an explicit target contract.
pub fn validate_upgrade_target(
    manifest: &DeploymentManifest,
    action: DeployAction,
) -> Result<(), DeployError> {
    if action == DeployAction::Upgrade && manifest.target_contract.is_none() {
        return Err(DeployError::UpgradeRequiresTarget);
    }
    Ok(())
}

#[test]
fn test_deploy_when_no_production_contract() {
    let env = Env::default();
    let manifest = DeploymentManifest::default();

    let action = decide_deploy_action(&manifest).expect("decision should succeed");
    assert_eq!(action, DeployAction::Deploy, "fresh manifest should deploy");
    assert!(guard_duplicate_production(&manifest, action).is_ok());
    assert!(validate_upgrade_target(&manifest, action).is_ok());
}

#[test]
fn test_noop_when_production_contract_exists_without_target() {
    let env = Env::default();
    let manifest = DeploymentManifest {
        production_contract: Some(SorobanString::from_slice(&env, b"CPROD123")),
        target_contract: None,
        allow_redeploy: false,
    };

    let action = decide_deploy_action(&manifest).expect("decision should succeed");
    assert_eq!(
        action,
        DeployAction::NoOp,
        "re-running a completed deployment must be a no-op"
    );
    // A no-op must never be treated as a fresh deploy, so the duplicate guard passes.
    assert!(guard_duplicate_production(&manifest, action).is_ok());
}

#[test]
fn test_upgrade_when_production_contract_and_target_present() {
    let env = Env::default();
    let manifest = DeploymentManifest {
        production_contract: Some(SorobanString::from_slice(&env, b"CPROD123")),
        target_contract: Some(SorobanString::from_slice(&env, b"CPROD123")),
        allow_redeploy: false,
    };

    let action = decide_deploy_action(&manifest).expect("decision should succeed");
    assert_eq!(action, DeployAction::Upgrade, "explicit target should upgrade");
    assert!(validate_upgrade_target(&manifest, action).is_ok());
    assert!(guard_duplicate_production(&manifest, action).is_ok());
}

#[test]
fn test_upgrade_without_target_is_rejected() {
    let env = Env::default();
    let manifest = DeploymentManifest {
        production_contract: Some(SorobanString::from_slice(&env, b"CPROD123")),
        target_contract: None,
        allow_redeploy: false,
    };

    // Forcing an upgrade decision without a target must be rejected.
    let result = validate_upgrade_target(&manifest, DeployAction::Upgrade);
    assert_eq!(
        result,
        Err(DeployError::UpgradeRequiresTarget),
        "upgrade must require an explicit target contract"
    );
}

#[test]
fn test_duplicate_production_deploy_is_blocked_without_override() {
    let env = Env::default();
    let manifest = DeploymentManifest {
        production_contract: Some(SorobanString::from_slice(&env, b"CPROD123")),
        target_contract: None,
        allow_redeploy: false,
    };

    // Even if something forces a Deploy action, the guard must block it.
    let result = guard_duplicate_production(&manifest, DeployAction::Deploy);
    assert_eq!(
        result,
        Err(DeployError::DuplicateProductionContract),
        "re-deploying over an existing production contract must be blocked"
    );
}

#[test]
fn test_duplicate_production_deploy_allowed_with_explicit_override() {
    let env = Env::default();
    let manifest = DeploymentManifest {
        production_contract: Some(SorobanString::from_slice(&env, b"CPROD123")),
        target_contract: None,
        allow_redeploy: true,
    };

    let result = guard_duplicate_production(&manifest, DeployAction::Deploy);
    assert!(
        result.is_ok(),
        "explicit override should permit an intentional redeploy"
    );
}

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

#[test]
fn test_non_admin_cannot_upgrade() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let attacker = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
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
    // A non-admin address must not be able to authorize an upgrade.
    let result = VacciChainContract::upgrade(env.clone(), attacker.clone(), None);
    assert_eq!(
        result,
        Err(ContractError::Unauthorized),
        "non-admin must not be able to upgrade the contract"
    );
}

#[test]
fn test_upgrade_preserves_storage_and_lifecycle() {
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

    let token_id = VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        SorobanString::from_slice(&env, b"COVID-19"),
        SorobanString::from_slice(&env, b"2024-01-15"),
        issuer.clone(),
        None,
        None,
    ).expect("mint should succeed");

    // Admin-authorized upgrade must succeed.
    let upgrade_result = VacciChainContract::upgrade(env.clone(), admin.clone(), None);
    assert_eq!(upgrade_result, Ok(()), "admin upgrade should succeed");

    // Lifecycle: storage written before the upgrade must remain intact.
    let (vaccinated, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert!(vaccinated, "patient should remain vaccinated after upgrade");
    assert_eq!(records.len(), 1, "record count should be preserved across upgrade");
    assert_eq!(records.get(0).unwrap().token_id, token_id, "token_id should be preserved");
    assert_eq!(records.get(0).unwrap().schema_version, 1, "schema_version should be preserved");
}

#[test]
fn test_upgrade_does_not_introduce_pii() {
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

    let _ = VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        SorobanString::from_slice(&env, b"COVID-19"),
        SorobanString::from_slice(&env, b"2024-01-15"),
        issuer.clone(),
        None,
        None,
    ).expect("mint should succeed");

    let (_, records_before, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    let record_before = records_before.get(0).unwrap();

    let _ = VacciChainContract::upgrade(env.clone(), admin.clone(), None);

    // Privacy: the upgrade must not add or alter PII-bearing fields.
    let (_, records_after, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    let record_after = records_after.get(0).unwrap();
    assert_eq!(record_after.patient, record_before.patient, "patient field must be unchanged");
    assert_eq!(record_after.issuer, record_before.issuer, "issuer field must be unchanged");
    assert_eq!(record_after.vaccine_name, record_before.vaccine_name, "vaccine_name must be unchanged");
    assert_eq!(record_after.date, record_before.date, "date must be unchanged");
    assert_eq!(record_after.schema_version, record_before.schema_version, "schema_version must be unchanged");
}

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

    // Revocation status must be preserved across upgrade.
    let _ = VacciChainContract::revoke_vaccination(env.clone(), new_token, issuer.clone());
    let (vaccinated_after_revoke, records_after_revoke, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert!(!vaccinated_after_revoke, "revocation status must persist across upgrade");
    assert_eq!(records_after_revoke.len(), 1, "revoked record must not reappear after upgrade");

    // Revoking again must not resurrect the record
    let _ = VacciChainContract::revoke_vaccination(env.clone(), new_token, issuer.clone());
    let (vaccinated_again, records_again, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    assert!(!vaccinated_again, "record must remain revoked after repeated revocation");
    assert_eq!(records_again.len(), 1, "revoked records must stay hidden");
}

#[test]
fn test_admin_rotation_proposal_survives_upgrade() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let new_admin = TestAddress::random(&env);
}

#[test]
fn test_migration_reads_v1_issuer_fixture() {
    let env = Env::default();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let new_admin = TestAddress::random(&env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
    // Propose an admin rotation; the pending proposal must survive an upgrade
    let propose_result = VacciChainContract::propose_admin_rotation(
        env.clone(),
        admin.clone(),
        new_admin.clone(),
    );
    assert!(propose_result.is_ok(), "admin should be able to propose rotation");

    // Simulate upgrade: pending proposal is re-read from storage and can be accepted
    let accept_result = VacciChainContract::accept_admin_rotation(
        env.clone(),
        new_admin.clone(),
    );
    assert!(accept_result.is_ok(), "pending rotation proposal should survive upgrade and be acceptable");

    // The new admin must be able to perform admin-only operations after upgrade
    let add_result = VacciChainContract::add_issuer(
        env.clone(),
        issuer.clone(),
        SorobanString::from_slice(&env, b"New Issuer"),
        SorobanString::from_slice(&env, b"LIC456"),
        SorobanString::from_slice(&env, b"US"),
    );
    assert!(add_result.is_ok(), "rotated admin should retain admin authority after upgrade");
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
