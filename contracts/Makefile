# Vaccichain contracts Makefile
#
# Deployment requires an explicit NETWORK (testnet|mainnet). Deploying without
# an explicit network is refused to prevent accidental deployment against the
# wrong Stellar network.

# ---------------------------------------------------------------------------
# Network-specific configuration
# ---------------------------------------------------------------------------
# Expected network passphrases (used to validate the target network).
TESTNET_PASSPHRASE := Test SDF Network ; September 2015
MAINNET_PASSPHRASE := Public Global Stellar Network ; September 2015

# Default RPC URLs per network (override via environment if needed).
TESTNET_RPC_URL ?= https://soroban-testnet.stellar.org
MAINNET_RPC_URL ?= https://soroban-mainnet.stellar.org

WASM_PATH := target/wasm32-unknown-unknown/release/vaccichain.wasm

# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------
# Resolve network-specific settings from NETWORK. Fails if NETWORK is unset or
# not one of the supported values.
define resolve_network
	@if [ -z "$(NETWORK)" ]; then \
		echo "ERROR: NETWORK is required. Use 'make deploy NETWORK=testnet' or 'make deploy NETWORK=mainnet'."; \
		exit 1; \
	fi; \
	case "$(NETWORK)" in \
		testnet) \
			EXPECTED_PASSPHRASE="$(TESTNET_PASSPHRASE)"; \
			EXPECTED_RPC_URL="$(TESTNET_RPC_URL)"; \
			;; \
		mainnet) \
			EXPECTED_PASSPHRASE="$(MAINNET_PASSPHRASE)"; \
			EXPECTED_RPC_URL="$(MAINNET_RPC_URL)"; \
			;; \
		*) \
			echo "ERROR: Unsupported NETWORK '$(NETWORK)'. Must be 'testnet' or 'mainnet'."; \
			exit 1; \
			;; \
	esac; \
	if [ -z "$(ADMIN_SECRET_KEY)" ]; then \
		echo "ERROR: ADMIN_SECRET_KEY is required for deployment."; \
		exit 1; \
	fi; \
	if [ -z "$$EXPECTED_RPC_URL" ]; then \
		echo "ERROR: No RPC URL configured for network '$(NETWORK)'."; \
		exit 1; \
	fi; \
	echo "Validated network config: NETWORK=$(NETWORK) RPC_URL=$$EXPECTED_RPC_URL"
endef

# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------
build:
	cargo build --target wasm32-unknown-unknown --release
	@echo "WASM artifact: $(WASM_PATH)"

# Reproducible release build + SHA-256 artifact hash.
#
# Pinned toolchain:
#   - Rust toolchain is pinned via rust-toolchain.toml (channel + target wasm32-unknown-unknown).
#   - Dependencies are pinned via Cargo.lock (committed to the repo).
#   - Build with `--locked` so Cargo refuses to update the lockfile.
#
# Nondeterministic inputs to be aware of:
#   - Absolute paths embedded in the WASM (debug info / panic messages). We strip
#     debug info via RUSTFLAGS to reduce path leakage and improve reproducibility.
#   - The Rust compiler version and the wasm32-unknown-unknown target must match
#     the pinned toolchain exactly; a different toolchain will produce a different hash.
#   - Cargo/rustc build environment variables (e.g. CARGO_HOME, RUSTUP_HOME) do not
#     affect the artifact, but differing dependency sources (registry vs vendored) can.
#   - To fully reproduce on a clean runner: install the pinned toolchain, run
#     `cargo fetch --locked`, then `make build-hash` and compare artifact.sha256.
build-hash:
	@echo "Building release WASM with pinned toolchain (--locked)..."
	RUSTFLAGS="$${RUSTFLAGS:-} -C debuginfo=0" \
		cargo build --locked --target wasm32-unknown-unknown --release
	@echo "Generating SHA-256 artifact hash..."
	@cd target/wasm32-unknown-unknown/release && \
		sha256sum vaccichain.wasm > ../../../../artifact.sha256
	@echo "Artifact hash written to artifact.sha256:"
	@cat artifact.sha256

# Verify a previously generated artifact hash against a fresh build.
verify-hash: build-hash
	@echo "Verifying artifact hash..."
	@sha256sum -c artifact.sha256 --status && \
		echo "OK: artifact matches artifact.sha256" || \
		(echo "ERROR: artifact hash mismatch" && exit 1)

build-verified:
	cargo build --target wasm32-unknown-unknown --release
	@echo "Computing SHA-256 hash of WASM artifact..."
	$(eval WASM_HASH := $(shell sha256sum target/wasm32-unknown-unknown/release/vaccichain.wasm | cut -d' ' -f1))
	@echo "WASM SHA-256: $(WASM_HASH)"
	@echo "$(WASM_HASH)  vaccichain.wasm" > target/wasm32-unknown-unknown/release/vaccichain.wasm.sha256
	@echo "Hash written to target/wasm32-unknown-unknown/release/vaccichain.wasm.sha256"

verify-release:
	@test -n "$(RELEASE_MANIFEST)" || (echo "ERROR: RELEASE_MANIFEST is not set (path to release manifest)" && exit 1)
	@test -f "$(RELEASE_MANIFEST)" || (echo "ERROR: Release manifest not found: $(RELEASE_MANIFEST)" && exit 1)
	@test -f target/wasm32-unknown-unknown/release/vaccichain.wasm || (echo "ERROR: WASM artifact not found; run 'make build-verified' first" && exit 1)
	@echo "Computing SHA-256 hash of local WASM artifact..."
	$(eval LOCAL_HASH := $(shell sha256sum target/wasm32-unknown-unknown/release/vaccichain.wasm | cut -d' ' -f1))
	$(eval EXPECTED_HASH := $(shell grep -E '^(wasm_sha256|wasm_hash)[[:space:]]*[:=]' "$(RELEASE_MANIFEST)" | head -n1 | sed -E 's/^[^:=]*[:=][[:space:]]*//' | tr -d '"[:space:]'))
	@test -n "$(EXPECTED_HASH)" || (echo "ERROR: Could not read wasm hash from manifest: $(RELEASE_MANIFEST)" && exit 1)
	@echo "Local WASM SHA-256:    $(LOCAL_HASH)"
	@echo "Expected WASM SHA-256: $(EXPECTED_HASH)"
	@if [ "$(LOCAL_HASH)" = "$(EXPECTED_HASH)" ]; then \
		echo "Release verification passed: WASM hash matches manifest."; \
	else \
		echo "ERROR: WASM hash mismatch — local $(LOCAL_HASH) != expected $(EXPECTED_HASH)"; \
		exit 1; \
	fi

test:
	cargo test

test-coverage:
	cargo tarpaulin --fail-under 85 --out Xml

# Issue #83: Validate multisignature policy against deployment configuration.
# Runs the testnet drill covering normal administration and signer-unavailable
# recovery. Requires ADMIN_SECRET_KEY, ADMIN_PUBLIC_KEY, and a deployed
# CONTRACT_ID (or VACCINATIONS_CONTRACT_ID in ../.env).
testnet-drill:
	@echo "Running testnet multisig drill (issue #83)..."
	@test -n "$(ADMIN_SECRET_KEY)" || (echo "ERROR: ADMIN_SECRET_KEY is not set" && exit 1)
	@test -n "$(ADMIN_PUBLIC_KEY)" || (echo "ERROR: ADMIN_PUBLIC_KEY is not set" && exit 1)
	@test -n "$(CONTRACT_ID)" || (echo "ERROR: CONTRACT_ID is not set" && exit 1)
	@bash ./scripts/testnet_drill.sh \
		--contract-id "$(CONTRACT_ID)" \
		--admin-secret-key "$(ADMIN_SECRET_KEY)" \
		--admin-public-key "$(ADMIN_PUBLIC_KEY)" \
		--network testnet
	@echo "Testnet drill passed: normal administration and signer-unavailable recovery verified."

# Resource baseline / regression gates (Backlog 086).
# BENCH_BASELINE: stored baseline measurements (committed).
# BENCH_CURRENT:  measurements produced by the latest `make bench` run.
# BENCH_THRESHOLD: max allowed relative regression (e.g. 0.10 = 10%).
BENCH_BASELINE ?= benches/resource_baseline.json
BENCH_CURRENT ?= target/bench/resource_current.json
BENCH_COMPARISON ?= target/bench/resource_comparison.txt
BENCH_THRESHOLD ?= 0.10

bench:
	@mkdir -p $(dir $(BENCH_CURRENT))
	cargo test --release --features resource-bench --test resource_baseline -- \
		--nocapture --test-threads=1
	@echo "Resource measurements written to $(BENCH_CURRENT)"

bench-check:
	@mkdir -p $(dir $(BENCH_CURRENT)) $(dir $(BENCH_COMPARISON))
	@if [ ! -f "$(BENCH_BASELINE)" ]; then \
		echo "ERROR: baseline file $(BENCH_BASELINE) not found"; \
		exit 1; \
	fi
	cargo test --release --features resource-bench --test resource_baseline -- \
		--nocapture --test-threads=1
	@echo "Comparing $(BENCH_CURRENT) against baseline $(BENCH_BASELINE) (threshold $(BENCH_THRESHOLD))..."
	@python3 scripts/compare_resources.py \
		--baseline "$(BENCH_BASELINE)" \
		--current "$(BENCH_CURRENT)" \
		--threshold "$(BENCH_THRESHOLD)" \
		--output "$(BENCH_COMPARISON)" || \
		(echo "ERROR: resource regression exceeded threshold — see $(BENCH_COMPARISON)"; exit 1)
	@echo "Resource comparison written to $(BENCH_COMPARISON)"

# Deploy requires an explicit NETWORK. Validates network-specific config before
# deploying, then runs the smoke test against the deployed contract.
deploy:
	$(call resolve_network)
	@echo "Deploying to Stellar $(NETWORK)..."
	$(eval CONTRACT_ID := $(shell soroban contract deploy \
		--wasm $(WASM_PATH) \
		--source $(ADMIN_SECRET_KEY) \
		--network $(NETWORK) \
		--rpc-url $$EXPECTED_RPC_URL))
	@if [ -z "$(CONTRACT_ID)" ]; then \
		echo "ERROR: Deployment failed — no CONTRACT_ID returned."; \
		exit 1; \
	fi
	@echo "CONTRACT_ID=$(CONTRACT_ID)"
	@echo "Running post-deploy smoke test..."
	$(MAKE) smoke-test NETWORK=$(NETWORK) CONTRACT_ID=$(CONTRACT_ID)
	@echo "Smoke test passed. Writing contract ID to ../.env..."
	@sed -i 's|^VACCINATIONS_CONTRACT_ID=.*|VACCINATIONS_CONTRACT_ID=$(CONTRACT_ID)|' ../.env 2>/dev/null || \
		echo "VACCINATIONS_CONTRACT_ID=$(CONTRACT_ID)" >> ../.env
	@echo "Deploy complete. CONTRACT_ID=$(CONTRACT_ID)"

# Smoke test: verifies the deployed contract belongs to the expected network
# and that its on-chain WASM hash matches the locally built artifact hash.
# Usage: make smoke-test NETWORK=testnet CONTRACT_ID=<id>
smoke-test:
	$(call resolve_network)
	@if [ -z "$(CONTRACT_ID)" ]; then \
		echo "ERROR: CONTRACT_ID is required for smoke-test."; \
		exit 1; \
	fi
	@echo "Verifying contract $(CONTRACT_ID) on network $(NETWORK)..."
	@echo "Checking network passphrase..."
	$(eval ACTUAL_PASSPHRASE := $(shell soroban network passphrase --network $(NETWORK) 2>/dev/null))
	@if [ "$(ACTUAL_PASSPHRASE)" != "$$EXPECTED_PASSPHRASE" ]; then \
		echo "ERROR: Network passphrase mismatch for '$(NETWORK)'."; \
		echo "  expected: $$EXPECTED_PASSPHRASE"; \
		echo "  actual:   $(ACTUAL_PASSPHRASE)"; \
		exit 1; \
	fi
	@echo "Network passphrase OK."
	@echo "Checking deployed WASM hash against local artifact..."
	$(eval EXPECTED_HASH := $(shell sha256sum $(WASM_PATH) | cut -d' ' -f1))
	$(eval DEPLOYED_HASH := $(shell soroban contract fetch \
		--id $(CONTRACT_ID) \
		--network $(NETWORK) \
		--rpc-url $$EXPECTED_RPC_URL 2>/dev/null | sha256sum | cut -d' ' -f1))
	@if [ -z "$(EXPECTED_HASH)" ]; then \
		echo "ERROR: Could not compute local artifact hash. Did you run 'make build'?"; \
		exit 1; \
	fi
	@if [ "$(DEPLOYED_HASH)" != "$(EXPECTED_HASH)" ]; then \
		echo "ERROR: Deployed WASM hash does not match local artifact."; \
		echo "  expected: $(EXPECTED_HASH)"; \
		echo "  deployed: $(DEPLOYED_HASH)"; \
		exit 1; \
	fi
	@echo "WASM hash OK: $(EXPECTED_HASH)"
	@echo "Running invocation smoke test..."
	$(eval SMOKE_RESULT := $(shell soroban contract invoke \
		--id $(CONTRACT_ID) \
		--source $(ADMIN_SECRET_KEY) \
		--network $(NETWORK) \
		--rpc-url $$EXPECTED_RPC_URL \
		-- verify_vaccination \
		--wallet $(ADMIN_PUBLIC_KEY) 2>&1))
	@echo "Smoke test result: $(SMOKE_RESULT)"
	@echo "$(SMOKE_RESULT)" | grep -qv "error" || (echo "ERROR: Smoke test failed — $(SMOKE_RESULT)" && exit 1)
	@echo "Smoke test passed. Writing contract ID to ../.env..."
	@sed -i 's|^VACCINATIONS_CONTRACT_ID=.*|VACCINATIONS_CONTRACT_ID=$(CONTRACT_ID)|' ../.env 2>/dev/null || \
		echo "VACCINATIONS_CONTRACT_ID=$(CONTRACT_ID)" >> ../.env
	@echo "Deploy complete. CONTRACT_ID=$(CONTRACT_ID)"
	@echo "Next step (issue #83): run 'make testnet-drill CONTRACT_ID=$(CONTRACT_ID)' to validate the multisig policy."
	@echo "See DEPLOYMENT.md for the multisig drill procedure and signer-unavailable recovery runbook."

clean:
	cargo clean
	@rm -f artifact.sha256

.PHONY: build build-hash verify-hash build-verified verify-release test test-coverage bench bench-check deploy clean
