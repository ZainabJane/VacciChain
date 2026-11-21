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

// ---------------------------------------------------------------------------
// Issue #85: fuzz harnesses covering every public entry point and the
// serialization boundaries (malformed strings, oversized inputs, invalid
// addresses). Each harness must never panic; it may return any ContractError.
//
// Reproducing a failure:
//   1. proptest prints the failing seed and the shrunk input on failure.
//   2. Re-run with: `PROPTEST_CASES=<n> cargo test -p contracts fuzz_ -- --nocapture`
//   3. To pin a single case, set `PROPTEST_SEED=<seed>` (proptest reads it via
//      the `proptest` config) or add a `proptest! { #![proptest_config(...)] }`.
//   4. CI runs the deterministic smoke corpus below via
//      `cargo test -p contracts fuzz_smoke_corpus`; scheduled jobs run the full
//      proptest suites with a larger `PROPTEST_CASES`.
// ---------------------------------------------------------------------------

// Strategy for arbitrary (possibly malformed) UTF-8-ish byte strings.
fn arb_raw_string() -> impl Strategy<Value = std::vec::Vec<u8>> {
    proptest::collection::vec(any::<u8>(), 0..512)
}

// Strategy for oversized inputs (beyond typical field limits).
fn arb_oversized_string() -> impl Strategy<Value = std::vec::Vec<u8>> {
    proptest::collection::vec(any::<u8>(), 512..4096)
}

// Helper: build a fully initialized contract with one issuer and one patient.
fn setup_env() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let patient = TestAddress::random(&env);
    let _ = crate::VacciChainContract::initialize(env.clone(), admin.clone());
    let _ = crate::VacciChainContract::add_issuer(
        env.clone(),
        issuer.clone(),
        SorobanString::from_slice(&env, b"Test Issuer"),
        SorobanString::from_slice(&env, b"LIC123"),
        SorobanString::from_slice(&env, b"US"),
    );
    let _ = crate::VacciChainContract::register_patient(env.clone(), patient.clone());
    (env, admin, issuer, patient)
}

// Fuzz: initialize with arbitrary admin addresses (including repeated calls).
proptest! {
    #[test]
    fn fuzz_initialize(_seed in 0u32..1000) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = TestAddress::random(&env);
        let result = crate::VacciChainContract::initialize(env.clone(), admin.clone());
        // First call must succeed; a second call must not panic.
        prop_assert!(result.is_ok());
        let again = crate::VacciChainContract::initialize(env.clone(), admin);
        let _ = again;
    }
}

// Fuzz: add_issuer with malformed / oversized metadata strings.
proptest! {
    #[test]
    fn fuzz_add_issuer_malformed(
        name in arb_raw_string(),
        license in arb_raw_string(),
        country in arb_raw_string(),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let _ = crate::VacciChainContract::initialize(env.clone(), admin);
        let result = crate::VacciChainContract::add_issuer(
            env.clone(),
            issuer,
            SorobanString::from_slice(&env, &name),
            SorobanString::from_slice(&env, &license),
            SorobanString::from_slice(&env, &country),
        );
        let _ = result;
    }
}

// Fuzz: add_issuer with oversized inputs.
proptest! {
    #[test]
    fn fuzz_add_issuer_oversized(
        name in arb_oversized_string(),
        license in arb_oversized_string(),
        country in arb_oversized_string(),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = TestAddress::random(&env);
        let issuer = TestAddress::random(&env);
        let _ = crate::VacciChainContract::initialize(env.clone(), admin);
        let result = crate::VacciChainContract::add_issuer(
            env.clone(),
            issuer,
            SorobanString::from_slice(&env, &name),
            SorobanString::from_slice(&env, &license),
            SorobanString::from_slice(&env, &country),
        );
        let _ = result;
    }
}

// Fuzz: revoke_issuer on known and unknown issuers.
proptest! {
    #[test]
    fn fuzz_revoke_issuer(_seed in 0u32..1000) {
        let (env, _admin, issuer, _patient) = setup_env();
        let unknown = TestAddress::random(&env);
        let _ = crate::VacciChainContract::revoke_issuer(env.clone(), issuer);
        let _ = crate::VacciChainContract::revoke_issuer(env.clone(), unknown);
    }
}

// Fuzz: register_patient with arbitrary addresses (repeated registration).
proptest! {
    #[test]
    fn fuzz_register_patient(_seed in 0u32..1000) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = TestAddress::random(&env);
        let patient = TestAddress::random(&env);
        let _ = crate::VacciChainContract::initialize(env.clone(), admin);
        let first = crate::VacciChainContract::register_patient(env.clone(), patient.clone());
        prop_assert!(first.is_ok());
        let second = crate::VacciChainContract::register_patient(env.clone(), patient);
        let _ = second;
    }
}

// Fuzz: mint_vaccination with arbitrary addresses and malformed strings.
proptest! {
    #[test]
    fn fuzz_mint_vaccination_arbitrary(
        vaccine_name in arb_raw_string(),
        date in arb_raw_string(),
        use_known_issuer in any::<bool>(),
    ) {
        let (env, _admin, issuer, patient) = setup_env();
        let mint_issuer = if use_known_issuer { issuer } else { TestAddress::random(&env) };
        let result = crate::VacciChainContract::mint_vaccination(
            env.clone(),
            patient,
            SorobanString::from_slice(&env, &vaccine_name),
            SorobanString::from_slice(&env, &date),
            mint_issuer,
            None,
            None,
        );
        let _ = result;
    }
}

// Fuzz: revoke_vaccination on known and unknown record ids.
proptest! {
    #[test]
    fn fuzz_revoke_vaccination(record_id in 0u64..u64::MAX) {
        let (env, _admin, _issuer, _patient) = setup_env();
        let result = crate::VacciChainContract::revoke_vaccination(env.clone(), record_id);
        let _ = result;
    }
}

// Fuzz: batch_verify with arbitrary wallet lists (including empty and large).
proptest! {
    #[test]
    fn fuzz_batch_verify(count in 0usize..32) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = TestAddress::random(&env);
        let _ = crate::VacciChainContract::initialize(env.clone(), admin);
        let mut wallets = soroban_sdk::Vec::new(&env);
        for _ in 0..count {
            wallets.push_back(TestAddress::random(&env));
        }
        let result = crate::VacciChainContract::batch_verify(env.clone(), wallets);
        let _ = result;
    }
}

// Fuzz: pause / unpause toggling never panics.
proptest! {
    #[test]
    fn fuzz_pause_unpause(toggles in 0u32..16) {
        let (env, _admin, _issuer, _patient) = setup_env();
        for i in 0..toggles {
            if i % 2 == 0 {
                let _ = crate::VacciChainContract::pause(env.clone());
            } else {
                let _ = crate::VacciChainContract::unpause(env.clone());
            }
        }
    }
}

// Fuzz: admin transfer flow (propose_admin / accept_admin) with arbitrary addresses.
proptest! {
    #[test]
    fn fuzz_admin_transfer(_seed in 0u32..1000) {
        let (env, _admin, _issuer, _patient) = setup_env();
        let new_admin = TestAddress::random(&env);
        let _ = crate::VacciChainContract::propose_admin(env.clone(), new_admin.clone());
        let _ = crate::VacciChainContract::accept_admin(env.clone(), new_admin);
        // Accepting from a non-proposed address must not panic.
        let stranger = TestAddress::random(&env);
        let _ = crate::VacciChainContract::accept_admin(env.clone(), stranger);
    }
}

// Fuzz: upgrade entry point with arbitrary wasm hashes.
proptest! {
    #[test]
    fn fuzz_upgrade(hash in proptest::array::uniform32(any::<u8>())) {
        let (env, _admin, _issuer, _patient) = setup_env();
        let wasm_hash = soroban_sdk::BytesN::from_array(&env, &hash);
        let result = crate::VacciChainContract::upgrade(env.clone(), wasm_hash);
        let _ = result;
    }
}

// Deterministic smoke corpus for CI. Runs a fixed set of adversarial inputs
// against every public entry point without relying on proptest randomness.
// Invoke via: `cargo test -p contracts fuzz_smoke_corpus`.
#[test]
fn fuzz_smoke_corpus() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = TestAddress::random(&env);
    let issuer = TestAddress::random(&env);
    let patient = TestAddress::random(&env);
    let stranger = TestAddress::random(&env);

    // initialize: first ok, second must not panic.
    assert!(crate::VacciChainContract::initialize(env.clone(), admin.clone()).is_ok());
    let _ = crate::VacciChainContract::initialize(env.clone(), admin.clone());

    // add_issuer: empty, malformed, and oversized metadata.
    let empty = SorobanString::from_slice(&env, b"");
    let _ = crate::VacciChainContract::add_issuer(
        env.clone(),
        issuer.clone(),
        empty.clone(),
        empty.clone(),
        empty.clone(),
    );
    let _ = crate::VacciChainContract::add_issuer(
        env.clone(),
        issuer.clone(),
        SorobanString::from_slice(&env, b"Test Issuer"),
        SorobanString::from_slice(&env, b"LIC123"),
        SorobanString::from_slice(&env, b"US"),
    );
    let oversized = std::vec![b'A'; 4096];
    let _ = crate::VacciChainContract::add_issuer(
        env.clone(),
        stranger.clone(),
        SorobanString::from_slice(&env, &oversized),
        SorobanString::from_slice(&env, &oversized),
        SorobanString::from_slice(&env, &oversized),
    );

    // register_patient: valid, then duplicate.
    assert!(crate::VacciChainContract::register_patient(env.clone(), patient.clone()).is_ok());
    let _ = crate::VacciChainContract::register_patient(env.clone(), patient.clone());

    // mint_vaccination: valid, malformed, oversized, unknown issuer.
    let _ = crate::VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        SorobanString::from_slice(&env, b"COVID-19"),
        SorobanString::from_slice(&env, b"2024-01-01"),
        issuer.clone(),
        None,
        None,
    );
    let _ = crate::VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        empty.clone(),
        empty.clone(),
        issuer.clone(),
        None,
        None,
    );
    let _ = crate::VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        SorobanString::from_slice(&env, &oversized),
        SorobanString::from_slice(&env, &oversized),
        issuer.clone(),
        None,
        None,
    );
    let _ = crate::VacciChainContract::mint_vaccination(
        env.clone(),
        patient.clone(),
        SorobanString::from_slice(&env, b"COVID-19"),
        SorobanString::from_slice(&env, b"2024-01-01"),
        stranger.clone(),
        None,
        None,
    );

    // verify_vaccination: known and unknown wallets.
    let _ = crate::VacciChainContract::verify_vaccination(env.clone(), patient.clone());
    let _ = crate::VacciChainContract::verify_vaccination(env.clone(), stranger.clone());

    // batch_verify: empty and populated lists.
    let empty_list = soroban_sdk::Vec::new(&env);
    let _ = crate::VacciChainContract::batch_verify(env.clone(), empty_list);
    let mut wallets = soroban_sdk::Vec::new(&env);
    wallets.push_back(patient.clone());
    wallets.push_back(stranger.clone());
    let _ = crate::VacciChainContract::batch_verify(env.clone(), wallets);

    // revoke_vaccination: unknown record id.
    let _ = crate::VacciChainContract::revoke_vaccination(env.clone(), u64::MAX);

    // pause / unpause toggling.
    let _ = crate::VacciChainContract::pause(env.clone());
    let _ = crate::VacciChainContract::unpause(env.clone());

    // admin transfer: propose, accept, and accept from stranger.
    let _ = crate::VacciChainContract::propose_admin(env.clone(), stranger.clone());
    let _ = crate::VacciChainContract::accept_admin(env.clone(), stranger.clone());
    let _ = crate::VacciChainContract::accept_admin(env.clone(), patient.clone());

    // upgrade: arbitrary wasm hash.
    let wasm_hash = soroban_sdk::BytesN::from_array(&env, &[0u8; 32]);
    let _ = crate::VacciChainContract::upgrade(env.clone(), wasm_hash);

    // revoke_issuer: known and unknown issuers.
    let _ = crate::VacciChainContract::revoke_issuer(env.clone(), issuer);
    let _ = crate::VacciChainContract::revoke_issuer(env.clone(), stranger);
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
