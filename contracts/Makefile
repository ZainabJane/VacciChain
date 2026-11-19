build:
	cargo build --target wasm32-unknown-unknown --release
	@echo "WASM artifact: target/wasm32-unknown-unknown/release/vaccichain.wasm"

test:
	cargo test

test-coverage:
	cargo tarpaulin --fail-under 85 --out Xml

# Contract release checklist gate.
# Verifies the WASM artifact hash and required release environment variables
# (network identifiers, approval reference) before any mainnet deploy.
# See contracts/README.md and the contract release checklist for full details.
release-check:
	@echo "Running contract release checklist gates..."
	@test -n "$(RELEASE_NETWORK)" || (echo "ERROR: RELEASE_NETWORK is required (e.g. testnet, mainnet)." && exit 1)
	@test -n "$(EXPECTED_CONTRACT_ID)" || (echo "ERROR: EXPECTED_CONTRACT_ID is required." && exit 1)
	@test -n "$(EXPECTED_WASM_HASH)" || (echo "ERROR: EXPECTED_WASM_HASH is required." && exit 1)
	@test -n "$(APPROVAL_REFERENCE)" || (echo "ERROR: APPROVAL_REFERENCE is required (recorded approval for this release)." && exit 1)
	@test -f target/wasm32-unknown-unknown/release/vaccichain.wasm || (echo "ERROR: WASM artifact not found. Run 'make build' first." && exit 1)
	@echo "Verifying WASM artifact integrity..."
	$(eval ACTUAL_WASM_HASH := $(shell sha256sum target/wasm32-unknown-unknown/release/vaccichain.wasm | cut -d' ' -f1))
	@echo "Expected WASM hash: $(EXPECTED_WASM_HASH)"
	@echo "Actual WASM hash:   $(ACTUAL_WASM_HASH)"
	@test "$(ACTUAL_WASM_HASH)" = "$(EXPECTED_WASM_HASH)" || (echo "ERROR: WASM artifact hash mismatch — artifact integrity gate failed." && exit 1)
	@echo "Release gates passed: network=$(RELEASE_NETWORK) contract=$(EXPECTED_CONTRACT_ID) approval=$(APPROVAL_REFERENCE)"

deploy: release-check
	@echo "Deploying to Stellar $(RELEASE_NETWORK)..."
	$(eval CONTRACT_ID := $(shell soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/vaccichain.wasm \
		--source $(ADMIN_SECRET_KEY) \
		--network $(RELEASE_NETWORK)))
	@echo "CONTRACT_ID=$(CONTRACT_ID)"
	@echo "Running post-deploy smoke test..."
	$(eval SMOKE_RESULT := $(shell soroban contract invoke \
		--id $(CONTRACT_ID) \
		--source $(ADMIN_SECRET_KEY) \
		--network $(RELEASE_NETWORK) \
		-- verify_vaccination \
		--wallet $(ADMIN_PUBLIC_KEY) 2>&1))
	@echo "Smoke test result: $(SMOKE_RESULT)"
	@echo "$(SMOKE_RESULT)" | grep -qv "error" || (echo "ERROR: Smoke test failed — $(SMOKE_RESULT)" && exit 1)
	@echo "Smoke test passed. Writing contract ID to ../.env..."
	@sed -i 's|^VACCINATIONS_CONTRACT_ID=.*|VACCINATIONS_CONTRACT_ID=$(CONTRACT_ID)|' ../.env 2>/dev/null || \
		echo "VACCINATIONS_CONTRACT_ID=$(CONTRACT_ID)" >> ../.env
	@echo "Deploy complete. CONTRACT_ID=$(CONTRACT_ID)"

clean:
	cargo clean

.PHONY: build test test-coverage release-check deploy clean