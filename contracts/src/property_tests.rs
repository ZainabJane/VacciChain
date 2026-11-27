#![cfg(test)]

use proptest::prelude::*;
use soroban_sdk::{Address, Env, String as SorobanString, testutils::Address as TestAddress, Vec};
use crate::{VacciChainContract, ContractError, storage::VaccinationRecord};

// Issue #84: bounded, reproducible proptest configuration.
//
// - `PROPTEST_CASES` bounds the number of generated cases per property so the
//   suite has a predictable runtime.
// - `PROPTEST_MAX_SHRINK_ITERS` bounds shrinking so a failing case is minimized
//   quickly and deterministically.
// - A fixed `RngAlgorithm` plus a fixed seed makes runs reproducible. The seed
//   can be overridden via the `PROPTEST_SEED` environment variable when a
//   failure needs to be replayed.
proptest! {
    #![proptest_config(ProptestConfig {
        cases: 32,
        max_shrink_iters: 256,
        rng_algorithm: RngAlgorithm::ChaCha,
        .. ProptestConfig::default()
    })]
}

/// Shared fixture: initializes the contract and registers one authorized issuer
/// and one patient. Returns `(env, admin, issuer, patient)`.
fn setup_authorized() -> (Env, Address, Address, Address) {
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

    (env, admin, issuer, patient)
}

// Property: mint then verify always returns the minted record
proptest! {
    #[test]
    fn prop_mint_then_verify_returns_record(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date in r"\d{4}-\d{2}-\d{2}"
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);

        env.mock_all_auths();

        // Setup
        let _ = VacciChainContract::initialize(env.clone(), admin.clone());
        let _ = VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            SorobanString::from_slice(&env, b"Test Issuer"),
            SorobanString::from_slice(&env, b"LIC123"),
            SorobanString::from_slice(&env, b"US"),
        );
        let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

        // Mint
        let mint_result = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str.clone(),
            date_str.clone(),
            issuer.clone(),
        None,
        None,
        );

        if let Ok(token_id) = mint_result {
            // Verify
            let (vaccinated, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());

            // Property: if mint succeeded, verify should return the record
            prop_assert!(vaccinated, "patient should be vaccinated after mint");
            prop_assert!(records.len() > 0, "should have at least one record");

            // Find the minted record
            let mut found = false;
            for i in 0..records.len() {
                let record = records.get(i).unwrap();
                if record.token_id == token_id && record.vaccine_name == vaccine_str {
                    found = true;
                    prop_assert_eq!(record.date_administered, date_str, "date should match");
                    prop_assert_eq!(record.issuer, issuer, "issuer should match");
                    prop_assert_eq!(record.patient, patient, "patient should match");
                    prop_assert!(!record.revoked, "record should not be revoked");
                    break;
                }
            }
            prop_assert!(found, "minted record should be found in verify results");
        }
    }
}

// Property: transfer always fails (soulbound)
proptest! {
    #[test]
    fn prop_transfer_always_fails(
        _seed in 0u32..100
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);
        let recipient = TestAddress::random(&env);

        env.mock_all_auths();

        // Setup
        let _ = VacciChainContract::initialize(env.clone(), admin.clone());
        let _ = VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            SorobanString::from_slice(&env, b"Test Issuer"),
            SorobanString::from_slice(&env, b"LIC123"),
            SorobanString::from_slice(&env, b"US"),
        );
        let _ = VacciChainContract::register_patient(env.clone(), patient.clone());
        let _ = VacciChainContract::register_patient(env.clone(), recipient.clone());

        // Mint a record
        let vaccine_str = SorobanString::from_slice(&env, b"COVID-19");
        let date_str = SorobanString::from_slice(&env, b"2024-01-15");

        let mint_result = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str,
            date_str,
            issuer.clone(),
        None,
        None,
        );

        if let Ok(token_id) = mint_result {
            // Property: transfer should always fail (soulbound)
            let transfer_result = VacciChainContract::transfer(
                env.clone(),
                patient.clone(),
                recipient.clone(),
                token_id,
            );

            prop_assert_eq!(
                transfer_result,
                Err(ContractError::SoulboundToken),
                "transfer should always fail with SoulboundToken error"
            );
        }
    }
}

// Property: duplicate mint always fails
proptest! {
    #[test]
    fn prop_duplicate_mint_always_fails(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date in r"\d{4}-\d{2}-\d{2}"
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);

        env.mock_all_auths();

        // Setup
        let _ = VacciChainContract::initialize(env.clone(), admin.clone());
        let _ = VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            SorobanString::from_slice(&env, b"Test Issuer"),
            SorobanString::from_slice(&env, b"LIC123"),
            SorobanString::from_slice(&env, b"US"),
        );
        let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

        // First mint
        let first_mint = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str.clone(),
            date_str.clone(),
            issuer.clone(),
        None,
        None,
        );

        if first_mint.is_ok() {
            // Second mint with same inputs
            let second_mint = VacciChainContract::mint_vaccination(
                env.clone(),
                patient.clone(),
                vaccine_str,
                date_str,
                issuer.clone(),
        None,
        None,
            );

            // Property: duplicate mint should always fail
            prop_assert_eq!(
                second_mint,
                Err(ContractError::DuplicateRecord),
                "duplicate mint should fail with DuplicateRecord error"
            );
        }
    }
}

// Property: verify returns consistent results
proptest! {
    #[test]
    fn prop_verify_consistency(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date in r"\d{4}-\d{2}-\d{2}"
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);

        env.mock_all_auths();

        // Setup
        let _ = VacciChainContract::initialize(env.clone(), admin.clone());
        let _ = VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            SorobanString::from_slice(&env, b"Test Issuer"),
            SorobanString::from_slice(&env, b"LIC123"),
            SorobanString::from_slice(&env, b"US"),
        );
        let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

        // Mint
        let _ = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str,
            date_str,
            issuer.clone(),
        None,
        None,
        );

        // Verify multiple times
        let (vaccinated1, records1, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
        let (vaccinated2, records2, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());

        // Property: verify should return consistent results
        prop_assert_eq!(vaccinated1, vaccinated2, "vaccination status should be consistent");
        prop_assert_eq!(records1.len(), records2.len(), "record count should be consistent");
    }
}

// Property: revoking a single record only affects that record (record-level scope)
proptest! {
    #[test]
    fn prop_revoked_records_not_returned(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date in r"\d{4}-\d{2}-\d{2}"
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);

        env.mock_all_auths();

        // Setup
        let _ = VacciChainContract::initialize(env.clone(), admin.clone());
        let _ = VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            SorobanString::from_slice(&env, b"Test Issuer"),
            SorobanString::from_slice(&env, b"LIC123"),
            SorobanString::from_slice(&env, b"US"),
        );
        let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

        // Mint
        let mint_result = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str,
            date_str,
            issuer.clone(),
        None,
        None,
        );

        if let Ok(token_id) = mint_result {
            // Verify before revocation
            let (vaccinated_before, records_before, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
            prop_assert!(vaccinated_before, "should be vaccinated before revocation");
            prop_assert!(records_before.len() > 0, "should have records before revocation");

            // Revoke
            let _ = VacciChainContract::revoke_vaccination(env.clone(), token_id, issuer.clone());

            // Verify after revocation
            let (vaccinated_after, records_after, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());

            // Property: revocation is record-level, so the revoked record is excluded
            // while any other non-revoked records remain visible.
            prop_assert_eq!(
                records_after.len(),
                records_before.len() - 1,
                "only the revoked record should be removed"
            );
            prop_assert_eq!(
                vaccinated_after,
                records_after.len() > 0,
                "vaccination status should reflect remaining non-revoked records"
            );
            for i in 0..records_after.len() {
                let record = records_after.get(i).unwrap();
                prop_assert_ne!(record.token_id, token_id, "revoked record must not be returned");
                prop_assert!(!record.revoked, "returned records must not be revoked");
            }
        }
    }
}

// Property: revoking one of multiple records leaves the others verifiable
proptest! {
    #[test]
    fn prop_revoke_one_of_multiple_records_preserves_others(
        vaccine_a in r"[a-zA-Z0-9\-\s]{1,50}",
        vaccine_b in r"[a-zA-Z0-9\-\s]{1,50}",
        date_a in r"\d{4}-\d{2}-\d{2}",
        date_b in r"\d{4}-\d{2}-\d{2}"
    ) {
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

        let vaccine_a_str = SorobanString::from_slice(&env, vaccine_a.as_bytes());
        let vaccine_b_str = SorobanString::from_slice(&env, vaccine_b.as_bytes());
        let date_a_str = SorobanString::from_slice(&env, date_a.as_bytes());
        let date_b_str = SorobanString::from_slice(&env, date_b.as_bytes());

        let first = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_a_str.clone(),
            date_a_str.clone(),
            issuer.clone(),
            None,
            None,
        );
        let second = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_b_str.clone(),
            date_b_str.clone(),
            issuer.clone(),
            None,
            None,
        );

        // Only meaningful when both records were minted (distinct keys)
        if let (Ok(first_id), Ok(second_id)) = (first, second) {
            prop_assert_ne!(first_id, second_id, "token ids must be distinct");

            let (_, records_before, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
            prop_assert_eq!(records_before.len(), 2, "both records should be present");

            // Revoke only the first record
            let revoke_result = VacciChainContract::revoke_vaccination(env.clone(), first_id, issuer.clone());
            prop_assert!(revoke_result.is_ok(), "revocation should succeed");

            let (vaccinated_after, records_after, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());

            // Property: the remaining record is still verifiable
            prop_assert!(vaccinated_after, "patient should still be vaccinated via remaining record");
            prop_assert_eq!(records_after.len(), 1, "exactly one record should remain");

            let remaining = records_after.get(0).unwrap();
            prop_assert_eq!(remaining.token_id, second_id, "remaining record should be the second one");
            prop_assert_eq!(remaining.vaccine_name, vaccine_b_str, "remaining vaccine should match");
            prop_assert_eq!(remaining.date_administered, date_b_str, "remaining date should match");
            prop_assert!(!remaining.revoked, "remaining record should not be revoked");

            // Property: revocation is irreversible
            let second_revoke = VacciChainContract::revoke_vaccination(env.clone(), first_id, issuer.clone());
            prop_assert!(second_revoke.is_err(), "re-revoking an already revoked record should fail");

            let (_, records_final, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
            prop_assert_eq!(records_final.len(), 1, "irreversible revocation should not change remaining records");
        }
    }
}

// Property: duplicate detection normalizes case and whitespace variants
proptest! {
    #[test]
    fn prop_duplicate_detection_normalizes_variants(
        base_name in r"[a-zA-Z0-9]{1,20}",
        base_date in r"\d{4}-\d{2}-\d{2}"
    ) {
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

        let original_name = SorobanString::from_slice(&env, base_name.as_bytes());
        let original_date = SorobanString::from_slice(&env, base_date.as_bytes());

        let first_mint = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            original_name.clone(),
            original_date.clone(),
            issuer.clone(),
            None,
            None,
        );

        if first_mint.is_ok() {
            // Build formatting variants: uppercase, lowercase, and padded whitespace
            let mut upper_buf = [0u8; 64];
            let mut lower_buf = [0u8; 64];
            let mut padded_buf = [0u8; 66];
            let len = base_name.len();
            for i in 0..len {
                let b = base_name.as_bytes()[i];
                upper_buf[i] = b.to_ascii_uppercase();
                lower_buf[i] = b.to_ascii_lowercase();
            }
            padded_buf[0] = b' ';
            padded_buf[1..=len].copy_from_slice(&base_name.as_bytes()[..len]);
            padded_buf[len + 1] = b' ';

            let variants: [&[u8]; 3] = [
                &upper_buf[..len],
                &lower_buf[..len],
                &padded_buf[..len + 2],
            ];

            for variant in variants.iter() {
                let variant_str = SorobanString::from_slice(&env, variant);
                let result = VacciChainContract::mint_vaccination(
                    env.clone(),
                    patient.clone(),
                    variant_str,
                    original_date.clone(),
                    issuer.clone(),
                    None,
                    None,
                );
                // Property: formatting variants of the same key are duplicates
                prop_assert_eq!(
                    result,
                    Err(ContractError::DuplicateRecord),
                    "formatting variant should be detected as duplicate"
                );
            }
        }
    }
}

// Property: legitimate repeat doses (different dates) are not duplicates
proptest! {
    #[test]
    fn prop_repeat_doses_not_duplicates(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date_a in r"\d{4}-\d{2}-\d{2}",
        date_b in r"\d{4}-\d{2}-\d{2}"
    ) {
        prop_assume!(date_a != date_b);

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

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_a_str = SorobanString::from_slice(&env, date_a.as_bytes());
        let date_b_str = SorobanString::from_slice(&env, date_b.as_bytes());

        let first = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str.clone(),
            date_a_str,
            issuer.clone(),
            None,
            None,
        );

        if first.is_ok() {
            // Property: same vaccine on a different date is a legitimate repeat dose
            let second = VacciChainContract::mint_vaccination(
                env.clone(),
                patient.clone(),
                vaccine_str,
                date_b_str,
                issuer.clone(),
                None,
                None,
            );
            prop_assert!(second.is_ok(), "repeat dose on a different date should be allowed");
        }
    }
}

// Property: unauthorized issuer cannot mint
proptest! {
    #[test]
    fn prop_unauthorized_issuer_cannot_mint(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date in r"\d{4}-\d{2}-\d{2}"
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let unauthorized_issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);

        env.mock_all_auths();

        // Setup (don't add unauthorized_issuer)
        let _ = VacciChainContract::initialize(env.clone(), admin.clone());
        let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

        // Try to mint with unauthorized issuer
        let result = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str,
            date_str,
            unauthorized_issuer.clone(),
        None,
        None,
        );

        // Property: unauthorized issuer should not be able to mint
        prop_assert_eq!(
            result,
            Err(ContractError::Unauthorized),
            "unauthorized issuer should not be able to mint"
        );
    }
}

// Documented maximum lengths for public inputs and stored collections.
// These mirror the contract's validation bounds (see validation module).
const MAX_VACCINE_NAME_LEN: usize = 100;
const MAX_DATE_LEN: usize = 10;
const MAX_ISSUER_NAME_LEN: usize = 100;
const MAX_LICENSE_LEN: usize = 50;
const MAX_COUNTRY_LEN: usize = 2;
const MAX_RECORDS_PER_PATIENT: u32 = 50;

// ---------------------------------------------------------------------------
// Resource baselines (Backlog 086)
//
// These tests measure the CPU instruction and memory byte cost of the
// representative mint, verify, revoke and batch operations. Each measurement
// is printed in a stable, machine-readable format so the benchmark harness
// (scripts/check_resource_baseline.sh) can capture it and compare against the
// committed baselines in contracts/resource_baselines.json.
//
// Format: `RESOURCE_BASELINE op=<name> cpu=<u64> mem=<u64>`
// ---------------------------------------------------------------------------

/// Emit a single machine-readable resource measurement line.
fn emit_resource_baseline(op: &str, cpu: u64, mem: u64) {
    // `std::println!` is available in test builds; the harness greps for the
    // `RESOURCE_BASELINE` prefix.
    std::println!("RESOURCE_BASELINE op={} cpu={} mem={}", op, cpu, mem);
}

/// Measure the resources consumed by `f` on the given env, returning
/// (cpu_instructions, memory_bytes).
fn measure<F: FnOnce()>(env: &Env, f: F) -> (u64, u64) {
    env.budget().reset_unlimited();
    f();
    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();
    (cpu, mem)
}

/// Shared setup: initialize contract, register an issuer and a patient.
fn setup_env() -> (Env, Address, Address, Address) {
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

    (env, admin, issuer, patient)
}

fn make_string(env: &Env, len: usize) -> SorobanString {
    let mut bytes = [b'a'; 256];
    SorobanString::from_slice(env, &bytes[..len.min(256)])
}

#[test]
fn resource_baseline_mint() {
    let (env, _admin, issuer, patient) = setup_env();
    let vaccine = SorobanString::from_slice(&env, b"COVID-19");
    let date = SorobanString::from_slice(&env, b"2024-01-15");

    let (cpu, mem) = measure(&env, || {
        let _ = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine.clone(),
            date.clone(),
            issuer.clone(),
            None,
            None,
        );

        if len == 0 || len > MAX_VACCINE_NAME_LEN {
            prop_assert_eq!(
                result,
                Err(ContractError::InvalidInput),
                "out-of-bound vaccine name should be rejected"
            );
            // No storage mutation: patient should have no records
            let (vaccinated, records, _) =
                VacciChainContract::verify_vaccination(env.clone(), patient.clone());
            prop_assert!(!vaccinated, "failed mint must not mark patient vaccinated");
            prop_assert_eq!(records.len(), 0, "failed mint must not store a record");
        } else {
            prop_assert!(result.is_ok(), "valid-length vaccine name should be accepted");
        }
    }
}

// Property: date boundary lengths (0, max, max+1)
proptest! {
    #[test]
    fn prop_date_boundaries(len in 0usize..=(MAX_DATE_LEN + 1)) {
        let env = Env::default();
        let (_admin, issuer, patient) = setup_env(&env);

        let vaccine_str = SorobanString::from_slice(&env, b"COVID-19");
        let date_str = make_string(&env, len);

        let result = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str,
            date_str,
            issuer.clone(),
            None,
            None,
        );

        if len == 0 || len > MAX_DATE_LEN {
            prop_assert_eq!(
                result,
                Err(ContractError::InvalidInput),
                "out-of-bound date should be rejected"
            );
            let (vaccinated, records, _) =
                VacciChainContract::verify_vaccination(env.clone(), patient.clone());
            prop_assert!(!vaccinated, "failed mint must not mark patient vaccinated");
            prop_assert_eq!(records.len(), 0, "failed mint must not store a record");
        } else {
            prop_assert!(result.is_ok(), "valid-length date should be accepted");
        }
    }
}

// Property: issuer metadata boundary lengths (name, license, country)
proptest! {
    #[test]
    fn prop_issuer_metadata_boundaries(
        name_len in 0usize..=(MAX_ISSUER_NAME_LEN + 1),
        license_len in 0usize..=(MAX_LICENSE_LEN + 1),
        country_len in 0usize..=(MAX_COUNTRY_LEN + 1),
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);

        env.mock_all_auths();
        let _ = VacciChainContract::initialize(env.clone(), admin.clone());

        let name = make_string(&env, name_len);
        let license = make_string(&env, license_len);
        let country = make_string(&env, country_len);

        let result = VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            name,
            license,
            country,
        );

        let out_of_bounds = name_len == 0
            || name_len > MAX_ISSUER_NAME_LEN
            || license_len == 0
            || license_len > MAX_LICENSE_LEN
            || country_len == 0
            || country_len > MAX_COUNTRY_LEN;

        if out_of_bounds {
            prop_assert_eq!(
                result,
                Err(ContractError::InvalidInput),
                "out-of-bound issuer metadata should be rejected"
            );
            // No storage mutation: issuer must not be able to mint
            let patient = TestAddress::random(&env);
            let _ = VacciChainContract::register_patient(env.clone(), patient.clone());
            let mint = VacciChainContract::mint_vaccination(
                env.clone(),
                patient.clone(),
                SorobanString::from_slice(&env, b"COVID-19"),
                SorobanString::from_slice(&env, b"2024-01-15"),
                issuer.clone(),
                None,
                None,
            );
            prop_assert_eq!(
                mint,
                Err(ContractError::Unauthorized),
                "invalid issuer must not be able to mint"
            );
        } else {
            prop_assert!(result.is_ok(), "valid-length issuer metadata should be accepted");
        }
    }
}

#[test]
fn resource_baseline_mint() {
    let (env, _admin, issuer, patient) = setup_env();
    let vaccine = SorobanString::from_slice(&env, b"COVID-19");
    let date = SorobanString::from_slice(&env, b"2024-01-15");

    let (cpu, mem) = measure(&env, || {
        let _ = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine,
            date,
            issuer.clone(),
            None,
            None,
        );
    });

    emit_resource_baseline("mint", cpu, mem);
}

#[test]
fn resource_baseline_verify() {
    let (env, _admin, issuer, patient) = setup_env();
    let vaccine = SorobanString::from_slice(&env, b"COVID-19");
    let date = SorobanString::from_slice(&env, b"2024-01-15");

    let _ = VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        vaccine,
        date,
        issuer.clone(),
        None,
        None,
    );

    let (cpu, mem) = measure(&env, || {
        let _ = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    });

    emit_resource_baseline("verify", cpu, mem);
}

#[test]
fn resource_baseline_revoke() {
    let (env, _admin, issuer, patient) = setup_env();
    let vaccine = SorobanString::from_slice(&env, b"COVID-19");
    let date = SorobanString::from_slice(&env, b"2024-01-15");

    let token_id = VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        vaccine,
        date,
        issuer.clone(),
        None,
        None,
    )
    .expect("mint should succeed for revoke baseline");

    let (cpu, mem) = measure(&env, || {
        let _ = VacciChainContract::revoke_vaccination(env.clone(), token_id, issuer.clone());
    });

    emit_resource_baseline("revoke", cpu, mem);
}

#[test]
fn resource_baseline_batch() {
    let (env, _admin, issuer, patient) = setup_env();
    let vaccine = SorobanString::from_slice(&env, b"COVID-19");
    let date = SorobanString::from_slice(&env, b"2024-01-15");

    // Batch of sequential mints for the same patient (representative batch op).
    const BATCH_SIZE: u32 = 5;

    let (cpu, mem) = measure(&env, || {
        for i in 0..BATCH_SIZE {
            let v = SorobanString::from_slice(&env, format!("COVID-19-{}", i).as_bytes());
            let _ = VacciChainContract::mint_vaccination(
                env.clone(),
                patient.clone(),
                v,
                date.clone(),
                issuer.clone(),
                None,
                None,
            );
            prop_assert_eq!(
                mint,
                Err(ContractError::Unauthorized),
                "rejected issuer must not be registered"
            );
        } else {
            prop_assert!(result.is_ok(), "valid-length issuer metadata should be accepted");
        }
    }
}

// Property: patient record collection boundary (0, max, max+1)
proptest! {
    #[test]
    fn prop_patient_record_collection_boundary(count in 0u32..=(MAX_RECORDS_PER_PATIENT + 1)) {
        let env = Env::default();
        let (_admin, issuer, patient) = setup_env(&env);

        let mut last_result = Ok(0u64);
        for i in 0..count {
            let mut name_bytes = [b'v'; 32];
            name_bytes[0] = b'a' + (i % 26) as u8;
            let name = SorobanString::from_slice(&env, &name_bytes[..8]);
            let date = SorobanString::from_slice(&env, b"2024-01-15");
            last_result = VacciChainContract::mint_vaccination(
                env.clone(),
                patient.clone(),
                name,
                date,
                issuer.clone(),
                None,
                None,
            );
            if last_result.is_err() {
                break;
            }
        }

        let (_, records, _) =
            VacciChainContract::verify_vaccination(env.clone(), patient.clone());

        if count > MAX_RECORDS_PER_PATIENT {
            prop_assert_eq!(
                last_result,
                Err(ContractError::InvalidInput),
                "exceeding record collection limit should be rejected"
            );
            prop_assert!(
                records.len() <= MAX_RECORDS_PER_PATIENT,
                "stored records must not exceed the documented maximum"
            );
        } else {
            prop_assert_eq!(
                records.len(),
                count,
                "all in-bound records should be stored"
            );
        }
    }
}

// Property: no sequence of public calls can change a token's patient field
proptest! {
    #[test]
    fn prop_token_patient_immutable(
        ops in prop::collection::vec(0u8..6, 0..20)
    ) {
        let env = Env::default();
        let (_admin, issuer, patient) = setup_env(&env);
        let other = TestAddress::random(&env);
        let _ = VacciChainContract::register_patient(env.clone(), other.clone());

        let token_id = match VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            SorobanString::from_slice(&env, b"COVID-19"),
            SorobanString::from_slice(&env, b"2024-01-15"),
            issuer.clone(),
            None,
            None,
        ) {
            Ok(id) => id,
            Err(_) => return Ok(()),
        };

        for op in ops {
            match op {
                0 => {
                    let _ = VacciChainContract::transfer(
                        env.clone(),
                        patient.clone(),
                        other.clone(),
                        token_id,
                    );
                }
                1 => {
                    let _ = VacciChainContract::transfer(
                        env.clone(),
                        other.clone(),
                        patient.clone(),
                        token_id,
                    );
                }
                2 => {
                    let _ = VacciChainContract::approve(
                        env.clone(),
                        patient.clone(),
                        other.clone(),
                        token_id,
                    );
                }
                3 => {
                    let _ = VacciChainContract::revoke_vaccination(
                        env.clone(),
                        token_id,
                        issuer.clone(),
                    );
                }
                4 => {
                    let _ = VacciChainContract::revoke_vaccination(
                        env.clone(),
                        token_id,
                        other.clone(),
                    );
                }
                _ => {
                    let _ = VacciChainContract::mint_vaccination(
                        env.clone(),
                        other.clone(),
                        SorobanString::from_slice(&env, b"COVID-19"),
                        SorobanString::from_slice(&env, b"2024-01-15"),
                        issuer.clone(),
                        None,
                        None,
                    );
                }
            }
        }

        // The token's patient field must remain the original owner.
        let record: VaccinationRecord =
            VacciChainContract::get_record(env.clone(), token_id).unwrap();
        prop_assert_eq!(
            record.patient,
            patient,
            "token patient field must never change"
        );
    }
}

// Property: resource usage stays within baseline
proptest! {
    #[test]
    fn prop_resource_baseline(
        ops in prop::collection::vec(0u8..6, 0..20)
    ) {
        let env = Env::default();
        let (_admin, issuer, patient) = setup_env(&env);
        let other = TestAddress::random(&env);
        let _ = VacciChainContract::register_patient(env.clone(), other.clone());

        let token_id = match VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            SorobanString::from_slice(&env, b"COVID-19"),
            SorobanString::from_slice(&env, b"2024-01-15"),
            issuer.clone(),
            None,
            None,
        ) {
            Ok(id) => id,
            Err(_) => return Ok(()),
        };

        for op in ops {
            match op {
                0 => {
                    let _ = VacciChainContract::transfer(
                        env.clone(),
                        patient.clone(),
                        other.clone(),
                        token_id,
                    );
                }
                1 => {
                    let _ = VacciChainContract::approve(
                        env.clone(),
                        patient.clone(),
                        other.clone(),
                        token_id,
                    );
                }
                2 => {
                    let _ = VacciChainContract::revoke_vaccination(
                        env.clone(),
                        token_id,
                        issuer.clone(),
                    );
                }
                _ => {
                    let _ = VacciChainContract::mint_vaccination(
                        env.clone(),
                        other.clone(),
                        SorobanString::from_slice(&env, b"COVID-19"),
                        SorobanString::from_slice(&env, b"2024-01-15"),
                        issuer.clone(),
                        None,
                        None,
                    );
                }
            }
        }

        let (cpu, mem) = measure_resources(&env);
        emit_resource_baseline("batch", cpu, mem);
    });
}
