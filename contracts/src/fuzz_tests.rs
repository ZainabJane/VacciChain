#![cfg(test)]

use proptest::prelude::*;
use soroban_sdk::{Address, Env, String as SorobanString, testutils::Address as TestAddress};
use crate::{VacciChainContract, ContractError};

// Strategy for generating valid Stellar addresses
fn arb_address() -> impl Strategy<Value = Address> {
    "G[A-Z2-7]{55}".prop_map(|s| {
        Address::from_contract_id(&[0u8; 32])
    })
}

// Documented maximum lengths for public arguments and stored collections.
// These mirror the contract's validation bounds and are used to drive
// boundary fuzzing at zero, maximum valid, and one-over-limit sizes.
const MAX_VACCINE_NAME_LEN: usize = 100;
const MAX_DATE_LEN: usize = 10;
const MAX_ISSUER_NAME_LEN: usize = 100;
const MAX_ISSUER_LICENSE_LEN: usize = 50;
const MAX_ISSUER_COUNTRY_LEN: usize = 2;

// Strategy for generating vaccine names
fn arb_vaccine_name() -> impl Strategy<Value = SorobanString> {
    r"[a-zA-Z0-9\-\s]{1,100}".prop_map(|s| {
        SorobanString::from_slice(&Env::default(), s.as_bytes())
    })
}

// Strategy for generating dates
fn arb_date() -> impl Strategy<Value = SorobanString> {
    r"\d{4}-\d{2}-\d{2}".prop_map(|s| {
        SorobanString::from_slice(&Env::default(), s.as_bytes())
    })
}

// Strategy for boundary lengths: zero, maximum valid, and one-over-limit.
fn arb_boundary_len(max: usize) -> impl Strategy<Value = usize> {
    prop_oneof![
        Just(0usize),
        Just(max),
        Just(max.saturating_add(1)),
    ]
}

// Build a SorobanString of exactly `len` ASCII bytes.
fn string_of_len(env: &Env, len: usize) -> SorobanString {
    let bytes = vec![b'a'; len];
    SorobanString::from_slice(env, &bytes)
}

// Strategy for boundary-length vaccine names.
fn arb_boundary_vaccine_name() -> impl Strategy<Value = SorobanString> {
    arb_boundary_len(MAX_VACCINE_NAME_LEN).prop_map(|len| {
        let env = Env::default();
        string_of_len(&env, len)
    })
}

// Strategy for boundary-length dates.
fn arb_boundary_date() -> impl Strategy<Value = SorobanString> {
    arb_boundary_len(MAX_DATE_LEN).prop_map(|len| {
        let env = Env::default();
        string_of_len(&env, len)
    })
}

// Strategy for boundary-length issuer metadata (name, license, country).
fn arb_boundary_issuer_metadata() -> impl Strategy<Value = (SorobanString, SorobanString, SorobanString)> {
    (
        arb_boundary_len(MAX_ISSUER_NAME_LEN),
        arb_boundary_len(MAX_ISSUER_LICENSE_LEN),
        arb_boundary_len(MAX_ISSUER_COUNTRY_LEN),
    )
        .prop_map(|(name_len, license_len, country_len)| {
            let env = Env::default();
            (
                string_of_len(&env, name_len),
                string_of_len(&env, license_len),
                string_of_len(&env, country_len),
            )
        })
}

// Fuzz test: mint_vaccination with various inputs
proptest! {
    #[test]
    fn fuzz_mint_vaccination_valid_inputs(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,100}",
        date in r"\d{4}-\d{2}-\d{2}"
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);

        // Initialize contract
        env.mock_all_auths();
        let _ = crate::VacciChainContract::initialize(env.clone(), admin.clone());

        // Add issuer
        let _ = crate::VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            SorobanString::from_slice(&env, b"Test Issuer"),
            SorobanString::from_slice(&env, b"LIC123"),
            SorobanString::from_slice(&env, b"US"),
        );

        // Register patient
        let _ = crate::VacciChainContract::register_patient(env.clone(), patient.clone());

        // Attempt mint
        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

        let result = crate::VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str,
            date_str,
            issuer.clone(),
        None,
        None,
        );

        // Should succeed or fail gracefully
        let _ = result;
    }
}

// Fuzz test: mint_vaccination with malformed inputs
proptest! {
    #[test]
    fn fuzz_mint_vaccination_malformed_inputs(
        vaccine_name in r"[\x00-\x7F]{0,200}",
        date in r"[\x00-\x7F]{0,200}"
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);

        env.mock_all_auths();
        let _ = crate::VacciChainContract::initialize(env.clone(), admin.clone());
        let _ = crate::VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            SorobanString::from_slice(&env, b"Test Issuer"),
            SorobanString::from_slice(&env, b"LIC123"),
            SorobanString::from_slice(&env, b"US"),
        );
        let _ = crate::VacciChainContract::register_patient(env.clone(), patient.clone());

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

        let result = crate::VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str,
            date_str,
            issuer.clone(),
        None,
        None,
        );

        // Should not panic, may return error
        let _ = result;
    }
}

// Fuzz test: verify_vaccination with non-existent wallets
proptest! {
    #[test]
    fn fuzz_verify_vaccination_nonexistent_wallet(
        _seed in 0u32..1000
    ) {
        let env = Env::default();
        let wallet = TestAddress::random(&env);

        let (vaccinated, records, _) = crate::VacciChainContract::verify_vaccination(env.clone(), wallet);

        // Should return false and empty records for non-existent wallet
        prop_assert!(!vaccinated);
        prop_assert_eq!(records.len(), 0);
    }
}

// Fuzz test: duplicate mint detection
proptest! {
    #[test]
    fn fuzz_duplicate_mint_detection(
        vaccine_name in r"[a-zA-Z0-9\-\s]{1,50}",
        date in r"\d{4}-\d{2}-\d{2}"
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);

        env.mock_all_auths();
        let _ = crate::VacciChainContract::initialize(env.clone(), admin.clone());
        let _ = crate::VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            SorobanString::from_slice(&env, b"Test Issuer"),
            SorobanString::from_slice(&env, b"LIC123"),
            SorobanString::from_slice(&env, b"US"),
        );
        let _ = crate::VacciChainContract::register_patient(env.clone(), patient.clone());

        let vaccine_str = SorobanString::from_slice(&env, vaccine_name.as_bytes());
        let date_str = SorobanString::from_slice(&env, date.as_bytes());

        // First mint should succeed
        let result1 = crate::VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_str.clone(),
            date_str.clone(),
            issuer.clone(),
        None,
        None,
        );

        if result1.is_ok() {
            // Second mint with same inputs should fail with DuplicateRecord
            let result2 = crate::VacciChainContract::mint_vaccination(
                env.clone(),
                patient.clone(),
                vaccine_str,
                date_str,
                issuer.clone(),
        None,
        None,
            );

            prop_assert_eq!(result2, Err(ContractError::DuplicateRecord));
        }
    }
}

// Fuzz test: boundary lengths for vaccine names and dates.
// Zero, maximum valid, and one-over-limit values must never panic; over-limit
// inputs must be rejected without mutating storage.
proptest! {
    #[test]
    fn fuzz_mint_boundary_lengths(
        vaccine_name in arb_boundary_vaccine_name(),
        date in arb_boundary_date(),
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);

        env.mock_all_auths();
        let _ = crate::VacciChainContract::initialize(env.clone(), admin.clone());
        let _ = crate::VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            SorobanString::from_slice(&env, b"Test Issuer"),
            SorobanString::from_slice(&env, b"LIC123"),
            SorobanString::from_slice(&env, b"US"),
        );
        let _ = crate::VacciChainContract::register_patient(env.clone(), patient.clone());

        let name_len = vaccine_name.len() as usize;
        let date_len = date.len() as usize;

        let result = crate::VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            vaccine_name,
            date,
            issuer.clone(),
            None,
            None,
        );

        // Over-limit inputs must be rejected; valid boundaries may succeed.
        if name_len > MAX_VACCINE_NAME_LEN || date_len > MAX_DATE_LEN {
            prop_assert!(result.is_err());
        }

        // Storage must never contain a record for a rejected mint.
        if result.is_err() {
            let (_, records, _) =
                crate::VacciChainContract::verify_vaccination(env.clone(), patient.clone());
            prop_assert_eq!(records.len(), 0);
        }
    }
}

// Fuzz test: boundary lengths for issuer metadata.
proptest! {
    #[test]
    fn fuzz_add_issuer_boundary_lengths(
        metadata in arb_boundary_issuer_metadata(),
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);

        env.mock_all_auths();
        let _ = crate::VacciChainContract::initialize(env.clone(), admin.clone());

        let (name, license, country) = metadata;
        let name_len = name.len() as usize;
        let license_len = license.len() as usize;
        let country_len = country.len() as usize;

        let result = crate::VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            name,
            license,
            country,
        );

        // Over-limit metadata must be rejected.
        if name_len > MAX_ISSUER_NAME_LEN
            || license_len > MAX_ISSUER_LICENSE_LEN
            || country_len > MAX_ISSUER_COUNTRY_LEN
        {
            prop_assert!(result.is_err());
        }
    }
}

// Fuzz test: every ownership-changing entry point must fail with
// SoulboundToken and must not mutate storage or emit events.
proptest! {
    #[test]
    fn fuzz_soulbound_ownership_ops_always_fail(
        _seed in 0u32..1000,
        op in 0u8..4,
    ) {
        let env = Env::default();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let patient = TestAddress::random(&env);
        let other = TestAddress::random(&env);

        env.mock_all_auths();
        let _ = crate::VacciChainContract::initialize(env.clone(), admin.clone());
        let _ = crate::VacciChainContract::add_issuer(
            env.clone(),
            issuer.clone(),
            SorobanString::from_slice(&env, b"Test Issuer"),
            SorobanString::from_slice(&env, b"LIC123"),
            SorobanString::from_slice(&env, b"US"),
        );
        let _ = crate::VacciChainContract::register_patient(env.clone(), patient.clone());

        // Mint a record so ownership exists to be (illegally) changed.
        let mint = crate::VacciChainContract::mint_vaccination(
            env.clone(),
            patient.clone(),
            SorobanString::from_slice(&env, b"COVID-19"),
            SorobanString::from_slice(&env, b"2024-01-01"),
            issuer.clone(),
            None,
            None,
        );
        prop_assume!(mint.is_ok());

        let (before_vaccinated, before_records, _) =
            crate::VacciChainContract::verify_vaccination(env.clone(), patient.clone());
        let events_before = env.events().all().len();

        // Dispatch each ownership-changing operation.
        let result = match op {
            0 => crate::VacciChainContract::transfer(
                env.clone(),
                patient.clone(),
                other.clone(),
            ),
            1 => crate::VacciChainContract::approve(
                env.clone(),
                patient.clone(),
                other.clone(),
            ),
            2 => crate::VacciChainContract::clawback(
                env.clone(),
                admin.clone(),
                patient.clone(),
            ),
            _ => crate::VacciChainContract::burn(
                env.clone(),
                patient.clone(),
            ),
        };

        // All ownership-changing operations must be rejected as soulbound.
        prop_assert_eq!(result, Err(ContractError::SoulboundToken));

        // Storage must be unchanged.
        let (after_vaccinated, after_records, _) =
            crate::VacciChainContract::verify_vaccination(env.clone(), patient.clone());
        prop_assert_eq!(before_vaccinated, after_vaccinated);
        prop_assert_eq!(before_records.len(), after_records.len());

        // No misleading events may be emitted by a rejected operation.
        prop_assert_eq!(events_before, env.events().all().len());
    }
}
