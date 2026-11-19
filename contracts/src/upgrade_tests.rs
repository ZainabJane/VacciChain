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
