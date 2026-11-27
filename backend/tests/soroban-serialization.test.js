'use strict';

/**
 * Cross-language Soroban serialization tests.
 *
 * These tests consume the shared fixtures in `shared/fixtures/soroban-serialization.json`
 * (the same fixtures consumed by the Rust contract tests) and assert that:
 *   1. Node SDK invocation arguments encode to the same canonical XDR bytes as Rust.
 *   2. Indexer event decoding produces the same typed values as Rust.
 *   3. Negative fixtures (incompatible encodings) are rejected.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
  Keypair,
  StrKey,
} = require('@stellar/stellar-sdk');

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'shared',
  'fixtures',
  'soroban-serialization.json',
);

function loadFixtures() {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  return JSON.parse(raw);
}

const fixtures = loadFixtures();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a hex string (with or without 0x prefix) to a Buffer.
 */
function hexToBuffer(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return Buffer.from(clean, 'hex');
}

/**
 * Convert a Buffer to a lowercase hex string.
 */
function bufferToHex(buf) {
  return Buffer.from(buf).toString('hex');
}

/**
 * Build an ScVal from a fixture argument descriptor.
 *
 * The fixture descriptor mirrors the Rust `ScVal` variants that the contract
 * exposes as public arguments. Each descriptor has a `type` and a `value`.
 */
function buildScVal(descriptor) {
  switch (descriptor.type) {
    case 'u32':
      return nativeToScVal(descriptor.value, { type: 'u32' });
    case 'i32':
      return nativeToScVal(descriptor.value, { type: 'i32' });
    case 'u64':
      return nativeToScVal(BigInt(descriptor.value), { type: 'u64' });
    case 'i64':
      return nativeToScVal(BigInt(descriptor.value), { type: 'i64' });
    case 'u128':
      return nativeToScVal(BigInt(descriptor.value), { type: 'u128' });
    case 'i128':
      return nativeToScVal(BigInt(descriptor.value), { type: 'i128' });
    case 'bool':
      return nativeToScVal(descriptor.value, { type: 'bool' });
    case 'symbol':
      return nativeToScVal(descriptor.value, { type: 'symbol' });
    case 'string':
      return nativeToScVal(descriptor.value, { type: 'string' });
    case 'bytes':
      return nativeToScVal(hexToBuffer(descriptor.value), { type: 'bytes' });
    case 'address':
      return Address.fromString(descriptor.value).toScVal();
    case 'vec': {
      const items = descriptor.value.map(buildScVal);
      return xdr.ScVal.scvVec(items);
    }
    case 'map': {
      const entries = descriptor.value.map((entry) => {
        return new xdr.ScMapEntry({
          key: buildScVal(entry.key),
          val: buildScVal(entry.value),
        });
      });
      return xdr.ScVal.scvMap(entries);
    }
    case 'option': {
      if (descriptor.value === null || descriptor.value === undefined) {
        return xdr.ScVal.scvVoid();
      }
      return buildScVal(descriptor.value);
    }
    default:
      throw new Error(`Unsupported fixture type: ${descriptor.type}`);
  }
}

/**
 * Encode an ScVal to canonical XDR hex.
 */
function encodeScVal(scVal) {
  return bufferToHex(scVal.toXDR());
}

/**
 * Decode an ScVal from canonical XDR hex.
 */
function decodeScVal(hex) {
  return xdr.ScVal.fromXDR(hexToBuffer(hex));
}

/**
 * Normalize a native value for comparison against fixture expectations.
 * BigInts are stringified so they can be compared against JSON values.
 */
function normalizeNative(value) {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeNative);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = normalizeNative(value[key]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fixture sanity checks
// ---------------------------------------------------------------------------

describe('Soroban serialization fixtures', () => {
  it('loads the shared fixture file', () => {
    assert.ok(fixtures, 'fixtures should be defined');
    assert.ok(Array.isArray(fixtures.arguments), 'fixtures.arguments must be an array');
    assert.ok(Array.isArray(fixtures.returns), 'fixtures.returns must be an array');
    assert.ok(
      Array.isArray(fixtures.negative),
      'fixtures.negative must be an array',
    );
  });

  it('covers every public argument', () => {
    assert.ok(
      fixtures.arguments.length > 0,
      'there must be at least one argument fixture',
    );
    for (const arg of fixtures.arguments) {
      assert.ok(arg.name, 'argument fixture must have a name');
      assert.ok(arg.descriptor, `argument ${arg.name} must have a descriptor`);
      assert.ok(arg.xdr, `argument ${arg.name} must have expected xdr`);
    }
  });

  it('covers representative return values', () => {
    assert.ok(
      fixtures.returns.length > 0,
      'there must be at least one return fixture',
    );
    for (const ret of fixtures.returns) {
      assert.ok(ret.name, 'return fixture must have a name');
      assert.ok(ret.descriptor, `return ${ret.name} must have a descriptor`);
      assert.ok(ret.xdr, `return ${ret.name} must have expected xdr`);
    }
  });
});

// ---------------------------------------------------------------------------
// Argument encoding agreement with Rust
// ---------------------------------------------------------------------------

describe('Node invocation arguments agree with Rust fixtures', () => {
  for (const arg of fixtures.arguments) {
    it(`encodes argument "${arg.name}" to the same XDR as Rust`, () => {
      const scVal = buildScVal(arg.descriptor);
      const encoded = encodeScVal(scVal);
      assert.strictEqual(
        encoded,
        arg.xdr.toLowerCase(),
        `XDR mismatch for argument ${arg.name}`,
      );
    });

    it(`round-trips argument "${arg.name}" through XDR`, () => {
      const scVal = buildScVal(arg.descriptor);
      const encoded = encodeScVal(scVal);
      const decoded = decodeScVal(encoded);
      assert.strictEqual(
        encodeScVal(decoded),
        encoded,
        `round-trip mismatch for argument ${arg.name}`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Return value decoding agreement with Rust
// ---------------------------------------------------------------------------

describe('Node return value decoding agrees with Rust fixtures', () => {
  for (const ret of fixtures.returns) {
    it(`decodes return "${ret.name}" from Rust XDR`, () => {
      const scVal = decodeScVal(ret.xdr);
      const encoded = encodeScVal(scVal);
      assert.strictEqual(
        encoded,
        ret.xdr.toLowerCase(),
        `re-encode mismatch for return ${ret.name}`,
      );
    });

    if (ret.native !== undefined) {
      it(`decodes return "${ret.name}" to the expected native value`, () => {
        const scVal = decodeScVal(ret.xdr);
        const native = normalizeNative(scValToNative(scVal));
        assert.deepStrictEqual(
          native,
          ret.native,
          `native mismatch for return ${ret.name}`,
        );
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Indexer event decoding agreement with Rust
// ---------------------------------------------------------------------------

describe('Indexer event decoding agrees with Rust fixtures', () => {
  const events = fixtures.events || [];

  it('has event fixtures', () => {
    assert.ok(Array.isArray(events), 'fixtures.events must be an array');
  });

  for (const event of events) {
    it(`decodes indexer event "${event.name}"`, () => {
      const topics = event.topics.map((hex) => decodeScVal(hex));
      const data = decodeScVal(event.data);

      // Re-encode and compare against the Rust-produced XDR.
      const reencodedTopics = topics.map(encodeScVal);
      assert.deepStrictEqual(
        reencodedTopics,
        event.topics.map((hex) => hex.toLowerCase()),
        `topic XDR mismatch for event ${event.name}`,
      );
      assert.strictEqual(
        encodeScVal(data),
        event.data.toLowerCase(),
        `data XDR mismatch for event ${event.name}`,
      );

      // Compare decoded native values when the fixture provides them.
      if (event.nativeTopics !== undefined) {
        const nativeTopics = topics.map((t) => normalizeNative(scValToNative(t)));
        assert.deepStrictEqual(
          nativeTopics,
          event.nativeTopics,
          `native topic mismatch for event ${event.name}`,
        );
      }
      if (event.nativeData !== undefined) {
        const nativeData = normalizeNative(scValToNative(data));
        assert.deepStrictEqual(
          nativeData,
          event.nativeData,
          `native data mismatch for event ${event.name}`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Negative fixtures: incompatible encodings must be rejected
// ---------------------------------------------------------------------------

describe('Negative fixtures reject incompatible encodings', () => {
  for (const neg of fixtures.negative) {
    it(`rejects "${neg.name}"`, () => {
      switch (neg.kind) {
        case 'malformed-xdr': {
          assert.throws(
            () => decodeScVal(neg.xdr),
            /./,
            `expected malformed XDR to throw for ${neg.name}`,
          );
          break;
        }
        case 'type-mismatch': {
          // The fixture provides XDR that decodes to a different type than
          // the descriptor claims. Building the descriptor and comparing
          // against the provided XDR must fail.
          const scVal = buildScVal(neg.descriptor);
          const encoded = encodeScVal(scVal);
          assert.notStrictEqual(
            encoded,
            neg.xdr.toLowerCase(),
            `expected type mismatch for ${neg.name}`,
          );
          break;
        }
        case 'invalid-address': {
          assert.throws(
            () => Address.fromString(neg.value),
            /./,
            `expected invalid address to throw for ${neg.name}`,
          );
          break;
        }
        case 'invalid-symbol': {
          // Symbols must be <= 32 chars and limited to [a-zA-Z0-9_].
          assert.throws(
            () => nativeToScVal(neg.value, { type: 'symbol' }),
            /./,
            `expected invalid symbol to throw for ${neg.name}`,
          );
          break;
        }
        case 'overflow': {
          assert.throws(
            () => buildScVal(neg.descriptor),
            /./,
            `expected overflow to throw for ${neg.name}`,
          );
          break;
        }
        default:
          throw new Error(`Unsupported negative fixture kind: ${neg.kind}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-check: StrKey address encoding matches Rust
// ---------------------------------------------------------------------------

describe('Address StrKey encoding agrees with Rust fixtures', () => {
  const addresses = fixtures.addresses || [];

  it('has address fixtures', () => {
    assert.ok(Array.isArray(addresses), 'fixtures.addresses must be an array');
  });

  for (const addr of addresses) {
    it(`round-trips address "${addr.name}"`, () => {
      const parsed = Address.fromString(addr.value);
      assert.strictEqual(
        parsed.toString(),
        addr.value,
        `address round-trip mismatch for ${addr.name}`,
      );

      const scVal = parsed.toScVal();
      assert.strictEqual(
        encodeScVal(scVal),
        addr.xdr.toLowerCase(),
        `address XDR mismatch for ${addr.name}`,
      );

      // Verify StrKey decoding matches the raw public key bytes.
      if (addr.publicKey) {
        const decoded = StrKey.decodeEd25519PublicKey(addr.value);
        assert.strictEqual(
          bufferToHex(decoded),
          addr.publicKey.toLowerCase(),
          `public key mismatch for ${addr.name}`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-check: Keypair-derived addresses match Rust fixtures
// ---------------------------------------------------------------------------

describe('Keypair-derived addresses agree with Rust fixtures', () => {
  const keypairs = fixtures.keypairs || [];

  it('has keypair fixtures', () => {
    assert.ok(Array.isArray(keypairs), 'fixtures.keypairs must be an array');
  });

  for (const kp of keypairs) {
    it(`derives address for "${kp.name}"`, () => {
      const keypair = Keypair.fromSecret(kp.secret);
      assert.strictEqual(
        keypair.publicKey(),
        kp.publicKey,
        `public key mismatch for ${kp.name}`,
      );
      assert.strictEqual(
        keypair.rawPublicKey().toString('hex'),
        kp.rawPublicKey.toLowerCase(),
        `raw public key mismatch for ${kp.name}`,
      );
    });
  }
});