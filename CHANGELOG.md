# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Placeholder for changes that will be included in the next release.
- Explicit network and contract-ID validation in deployment tooling: deployment commands now require an explicit network, validate network-specific configuration, and reject mismatched or missing network settings before any deployment or invocation.
- Deployment smoke tests that confirm the deployed contract ID belongs to the expected network and matches the expected artifact hash.
- Contract function and error-code compatibility documentation covering public methods, authorization requirements, error semantics, and version-specific behavior, with backend mapping tests verifying contract errors become stable API responses.
- Contract dependency and toolchain policy defining supported Rust, Soroban SDK, and CLI versions, CI verification of the declared toolchain and dependency advisories, and a dependency upgrade procedure requiring tests, resource comparison, and release-note updates.
- Explicit consent and allowlist semantics at the contract/API boundary, documenting state transitions and API behavior for absent, granted, revoked, and changed consent, along with tests proving unauthorized issuance is rejected and public verification does not reveal prohibited fields.

## [0.1.0] - 2026-05-29

### Added
- Soroban smart contract for soulbound vaccination records.
- Express backend with Stellar SEP-10 authentication and JWT-based issuer authorization.
- React frontend for patient, issuer, and verification workflows.
- Python FastAPI analytics service for vaccination metrics and bulk verification.
- Docker Compose configuration for local multi-service development.
- Contract deployment, backend startup, and frontend build guides.
- Troubleshooting documentation for common RPC, key format, and Docker issues.
- Security guidance for secret scanning and HTTP header hardening.
- Staging environment workflow for release tagging and production promotion.

## [References]

- [0.1.0]: https://github.com/dev-fatima-24/VacciChain/releases/tag/v0.1.0