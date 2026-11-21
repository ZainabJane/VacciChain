build:
	cargo build --target wasm32-unknown-unknown --release
	@echo "WASM artifact: target/wasm32-unknown-unknown/release/vaccichain.wasm"

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

test:
	cargo test

test-coverage:
	cargo tarpaulin --fail-under 85 --out Xml

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
	@rm -f artifact.sha256

.PHONY: build build-hash verify-hash test test-coverage deploy clean