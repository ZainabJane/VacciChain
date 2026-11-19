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

test:
	cargo test

test-coverage:
	cargo tarpaulin --fail-under 85 --out Xml

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
	@echo "Smoke test passed for CONTRACT_ID=$(CONTRACT_ID) on $(NETWORK)."

clean:
	cargo clean

.PHONY: build test test-coverage deploy smoke-test clean