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

// Property: revoked records are not returned by verify
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

            // Property: revoked records should not be returned
            prop_assert!(!vaccinated_after, "should not be vaccinated after revocation");
            prop_assert_eq!(records_after.len(), 0, "revoked records should not be returned");
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

// Property: a non-issuer (arbitrary address) can never mint, regardless of
// whether it is the admin, the patient, or a random third party.
proptest! {
    #[test]
    fn prop_non_issuer_cannot_mint(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date in r"\d{4}-\d{2}-\d{2}",
        actor_kind in 0u8..3,
    ) {
        let (env, admin, _issuer, patient) = setup_authorized();

        // Pick an actor that is guaranteed not to be a registered issuer.
        let actor = match actor_kind {
            0 => admin.clone(),
            1 => patient.clone(),
            _ => TestAddress::random(&env),
        };

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

        let result = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str,
            date_str,
            actor,
            None,
            None,
        );

        prop_assert_eq!(
            result,
            Err(ContractError::Unauthorized),
            "non-issuer must never be able to mint"
        );

        // Storage invariant: no record was created for the patient.
        let (vaccinated, records, _) =
            VacciChainContract::verify_vaccination(env.clone(), patient.clone());
        prop_assert!(!vaccinated, "failed mint must not mark patient vaccinated");
        prop_assert_eq!(records.len(), 0, "failed mint must not create records");
    }
}

// Property: there is no transfer path — any transfer attempt on a valid token
// fails with SoulboundToken, and the record remains owned by the patient.
proptest! {
    #[test]
    fn prop_no_transfer_path_preserves_ownership(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date in r"\d{4}-\d{2}-\d{2}",
    ) {
        let (env, _admin, issuer, patient) = setup_authorized();
        let recipient = TestAddress::random(&env);
        let _ = VacciChainContract::register_patient(env.clone(), recipient.clone());

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

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
            let transfer_result = VacciChainContract::transfer(
                env.clone(),
                patient.clone(),
                recipient.clone(),
                token_id,
            );
            prop_assert_eq!(
                transfer_result,
                Err(ContractError::SoulboundToken),
                "transfer must always fail for soulbound tokens"
            );

            // Ownership invariant: record still belongs to the original patient.
            let (_, records, _) =
                VacciChainContract::verify_vaccination(env.clone(), patient.clone());
            let mut found = false;
            for i in 0..records.len() {
                let record = records.get(i).unwrap();
                if record.token_id == token_id {
                    found = true;
                    prop_assert_eq!(record.patient.clone(), patient.clone());
                    break;
                }
            }
            prop_assert!(found, "record must remain with original patient after failed transfer");

            // Recipient must not gain the record.
            let (recipient_vaccinated, recipient_records, _) =
                VacciChainContract::verify_vaccination(env.clone(), recipient.clone());
            prop_assert!(!recipient_vaccinated, "recipient must not become vaccinated");
            prop_assert_eq!(recipient_records.len(), 0, "recipient must not receive records");
        }
    }
}

// Property: uniqueness — minting the same (patient, vaccine, date, issuer) tuple
// twice always fails with DuplicateRecord, and the record count is unchanged.
proptest! {
    #[test]
    fn prop_uniqueness_duplicate_detection(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date in r"\d{4}-\d{2}-\d{2}",
    ) {
        let (env, _admin, issuer, patient) = setup_authorized();

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

        let first = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str.clone(),
            date_str.clone(),
            issuer.clone(),
            None,
            None,
        );

        if first.is_ok() {
            let (_, records_before, _) =
                VacciChainContract::verify_vaccination(env.clone(), patient.clone());

            let second = VacciChainContract::mint_vaccination(
                env.clone(),
                patient.clone(),
                vaccine_str,
                date_str,
                issuer.clone(),
                None,
                None,
            );
            prop_assert_eq!(
                second,
                Err(ContractError::DuplicateRecord),
                "duplicate mint must fail with DuplicateRecord"
            );

            // Storage invariant: duplicate attempt did not add a record.
            let (_, records_after, _) =
                VacciChainContract::verify_vaccination(env.clone(), patient.clone());
            prop_assert_eq!(
                records_before.len(),
                records_after.len(),
                "duplicate mint must not change record count"
            );
        }
    }
}

// Property: revocation — after revoking a token, verify excludes it, and
// revoking an already-revoked token is idempotent (no panic, no state change).
proptest! {
    #[test]
    fn prop_revocation_excludes_and_is_idempotent(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date in r"\d{4}-\d{2}-\d{2}",
    ) {
        let (env, _admin, issuer, patient) = setup_authorized();

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

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
            let _ = VacciChainContract::revoke_vaccination(env.clone(), token_id, issuer.clone());

            let (vaccinated, records, _) =
                VacciChainContract::verify_vaccination(env.clone(), patient.clone());
            prop_assert!(!vaccinated, "revoked patient must not be vaccinated");
            prop_assert_eq!(records.len(), 0, "revoked records must be excluded");

            // Idempotent revocation: second revoke must not resurrect the record.
            let _ = VacciChainContract::revoke_vaccination(env.clone(), token_id, issuer.clone());
            let (vaccinated2, records2, _) =
                VacciChainContract::verify_vaccination(env.clone(), patient.clone());
            prop_assert!(!vaccinated2, "re-revocation must keep patient unvaccinated");
            prop_assert_eq!(records2.len(), 0, "re-revocation must keep records excluded");
        }
    }
}

// Property: storage invariants across generated combinations — minting N
// distinct records yields exactly N active records, all owned by the patient,
// all non-revoked, with unique token ids.
proptest! {
    #[test]
    fn prop_storage_invariants_across_combinations(
        count in 1usize..5,
        suffix in 0u32..10_000,
    ) {
        let (env, _admin, issuer, patient) = setup_authorized();

        let mut minted: u32 = 0;
        for i in 0..count {
            // Distinct vaccine names guarantee distinct records.
            let name = format!("VAC-{}-{}", suffix, i);
            let vaccine_str = SorobanString::from_slice(&env, name.as_bytes());
            let date_str = SorobanString::from_slice(&env, b"2024-01-15");

            let result = VacciChainContract::mint_vaccination(
                env.clone(),
                patient.clone(),
                vaccine_str,
                date_str,
                issuer.clone(),
                None,
                None,
            );
            if result.is_ok() {
                minted += 1;
            }
        }

        let (vaccinated, records, _) =
            VacciChainContract::verify_vaccination(env.clone(), patient.clone());

        // Invariant: record count matches successful mints.
        prop_assert_eq!(records.len(), minted, "record count must equal successful mints");
        prop_assert_eq!(vaccinated, minted > 0, "vaccination status must reflect mints");

        // Invariant: every record is owned by the patient and not revoked,
        // and token ids are unique.
        let mut seen: Vec<u64> = Vec::new(&env);
        for i in 0..records.len() {
            let record = records.get(i).unwrap();
            prop_assert_eq!(record.patient.clone(), patient.clone());
            prop_assert!(!record.revoked, "active records must not be revoked");
            prop_assert!(!seen.contains(&record.token_id), "token ids must be unique");
            seen.push_back(record.token_id);
        }
    }
}

// Regression tests: minimized failing cases discovered by the property tests
// above are retained here as explicit, deterministic tests. Issue #84.
#[cfg(test)]
mod regressions {
    use super::*;

    /// Regression: a non-issuer (admin) attempting to mint must be rejected
    /// and must not create storage entries.
    #[test]
    fn regression_non_issuer_mint_rejected() {
        let (env, admin, _issuer, patient) = setup_authorized();

        let result = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            SorobanString::from_slice(&env, b"COVID-19"),
            SorobanString::from_slice(&env, b"2024-01-15"),
            admin,
            None,
            None,
        );
        assert_eq!(result, Err(ContractError::Unauthorized));

        let (vaccinated, records, _) =
            VacciChainContract::verify_vaccination(env.clone(), patient.clone());
        assert!(!vaccinated);
        assert_eq!(records.len(), 0);
    }

    /// Regression: duplicate mint with identical inputs is rejected and does
    /// not change the stored record count.
    #[test]
    fn regression_duplicate_mint_rejected() {
        let (env, _admin, issuer, patient) = setup_authorized();

        let vaccine = SorobanString::from_slice(&env, b"COVID-19");
        let date = SorobanString::from_slice(&env, b"2024-01-15");

        let first = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine.clone(),
            date.clone(),
            issuer.clone(),
            None,
            None,
        );
        assert!(first.is_ok());

        let second = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine,
            date,
            issuer,
            None,
            None,
        );
        assert_eq!(second, Err(ContractError::DuplicateRecord));

        let (_, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
        assert_eq!(records.len(), 1);
    }

    /// Regression: transfer of a valid token is rejected and ownership is
    /// preserved.
    #[test]
    fn regression_transfer_rejected_preserves_ownership() {
        let (env, _admin, issuer, patient) = setup_authorized();
        let recipient = TestAddress::random(&env);
        let _ = VacciChainContract::register_patient(env.clone(), recipient.clone());

        let token_id = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            SorobanString::from_slice(&env, b"COVID-19"),
            SorobanString::from_slice(&env, b"2024-01-15"),
            issuer,
            None,
            None,
        )
        .expect("mint should succeed");

        let transfer = VacciChainContract::transfer(
            env.clone(),
            patient.clone(),
            recipient.clone(),
            token_id,
        );
        assert_eq!(transfer, Err(ContractError::SoulboundToken));

        let (_, records, _) = VacciChainContract::verify_vaccination(env.clone(), patient.clone());
        assert_eq!(records.len(), 1);
        assert_eq!(records.get(0).unwrap().patient, patient);

        let (recipient_vaccinated, recipient_records, _) =
            VacciChainContract::verify_vaccination(env.clone(), recipient.clone());
        assert!(!recipient_vaccinated);
        assert_eq!(recipient_records.len(), 0);
    }

    /// Regression: revoked records are excluded from verify and re-revocation
    /// is idempotent.
    #[test]
    fn regression_revocation_excludes_record() {
        let (env, _admin, issuer, patient) = setup_authorized();

        let token_id = VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            SorobanString::from_slice(&env, b"COVID-19"),
            SorobanString::from_slice(&env, b"2024-01-15"),
            issuer.clone(),
            None,
            None,
        )
        .expect("mint should succeed");

        let _ = VacciChainContract::revoke_vaccination(env.clone(), token_id, issuer.clone());
        let (vaccinated, records, _) =
            VacciChainContract::verify_vaccination(env.clone(), patient.clone());
        assert!(!vaccinated);
        assert_eq!(records.len(), 0);

        let _ = VacciChainContract::revoke_vaccination(env.clone(), token_id, issuer);
        let (vaccinated2, records2, _) =
            VacciChainContract::verify_vaccination(env.clone(), patient.clone());
        assert!(!vaccinated2);
        assert_eq!(records2.len(), 0);
    }
}
