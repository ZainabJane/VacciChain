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

// Documented maximum lengths for public inputs and stored collections.
// These mirror the contract's validation bounds (see validation module).
const MAX_VACCINE_NAME_LEN: usize = 100;
const MAX_DATE_LEN: usize = 10;
const MAX_ISSUER_NAME_LEN: usize = 100;
const MAX_LICENSE_LEN: usize = 50;
const MAX_COUNTRY_LEN: usize = 2;
const MAX_RECORDS_PER_PATIENT: u32 = 50;

fn setup_env(env: &Env) -> (Address, Address, Address) {
    let admin = TestAddress::random(env);
    let issuer = TestAddress::random(env);
    let patient = TestAddress::random(env);

    env.mock_all_auths();

    let _ = VacciChainContract::initialize(env.clone(), admin.clone());
    let _ = VacciChainContract::add_issuer(
        env.clone(),
        issuer.clone(),
        SorobanString::from_slice(env, b"Test Issuer"),
        SorobanString::from_slice(env, b"LIC123"),
        SorobanString::from_slice(env, b"US"),
    );
    let _ = VacciChainContract::register_patient(env.clone(), patient.clone());

    (admin, issuer, patient)
}

fn make_string(env: &Env, len: usize) -> SorobanString {
    let mut bytes = [b'a'; 256];
    SorobanString::from_slice(env, &bytes[..len.min(256)])
}

// Property: vaccine name boundary lengths (0, max, max+1)
proptest! {
    #[test]
    fn prop_vaccine_name_boundaries(len in 0usize..=(MAX_VACCINE_NAME_LEN + 1)) {
        let env = Env::default();
        let (_admin, issuer, patient) = setup_env(&env);

        let vaccine_str = make_string(&env, len);
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
