build:
	cargo build --target wasm32-unknown-unknown --release
	@echo "WASM artifact: target/wasm32-unknown-unknown/release/vaccichain.wasm"

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

clean:
	cargo clean

.PHONY: build test test-coverage bench bench-check deploy clean
