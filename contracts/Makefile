build:
	cargo build --target wasm32-unknown-unknown --release
	@echo "WASM artifact: target/wasm32-unknown-unknown/release/vaccichain.wasm"

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

deploy:
	@echo "Deploying to Stellar testnet..."
	$(eval CONTRACT_ID := $(shell soroban contract deploy \
		--wasm target/wasm32-unknown-unknown/release/vaccichain.wasm \
		--source $(ADMIN_SECRET_KEY) \
		--network testnet))
	@echo "CONTRACT_ID=$(CONTRACT_ID)"
	@echo "Running post-deploy smoke test..."
	$(eval SMOKE_RESULT := $(shell soroban contract invoke \
		--id $(CONTRACT_ID) \
		--source $(ADMIN_SECRET_KEY) \
		--network testnet \
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

.PHONY: build test test-coverage testnet-drill deploy clean