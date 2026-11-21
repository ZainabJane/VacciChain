#![cfg(test)]

use proptest::prelude::*;
use soroban_sdk::{Address, Env, String as SorobanString, testutils::Address as TestAddress, Vec};
use crate::{VacciChainContract, ContractError, storage::VaccinationRecord};

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
