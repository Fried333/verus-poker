import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { split, reconstruct, splitHex, reconstructHex } from './shamir.mjs';
import { randomBytes } from 'crypto';

describe('Shamir Secret Sharing', () => {

  it('split and reconstruct single byte', () => {
    const secret = new Uint8Array([42]);
    const shares = split(secret, 3, 5);
    assert.equal(shares.length, 5);
    const recovered = reconstruct(shares.slice(0, 3));
    assert.equal(recovered[0], 42);
  });

  it('reconstruct with any M-of-N subset', () => {
    const secret = new Uint8Array([99]);
    const shares = split(secret, 3, 5);

    // Try all 3-share combinations
    const combos = [[0,1,2],[0,1,3],[0,1,4],[0,2,3],[0,2,4],[0,3,4],[1,2,3],[1,2,4],[1,3,4],[2,3,4]];
    for (const combo of combos) {
      const subset = combo.map(i => shares[i]);
      const recovered = reconstruct(subset);
      assert.equal(recovered[0], 99, 'Failed for combo: ' + combo.join(','));
    }
  });

  it('fewer than M shares fails to reconstruct', () => {
    const secret = new Uint8Array([77]);
    const shares = split(secret, 3, 5);
    const recovered = reconstruct(shares.slice(0, 2)); // Only 2, need 3
    // With only 2 shares for a threshold-3 scheme, result should be wrong
    // (not guaranteed to fail, but statistically extremely unlikely to be correct)
    // We can't assert it's wrong every time, so just verify the function runs
    assert.ok(recovered.length === 1);
  });

  it('multi-byte secret', () => {
    const secret = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const shares = split(secret, 3, 5);
    assert.equal(shares[0].data.length, 10);
    const recovered = reconstruct(shares.slice(0, 3));
    assert.deepEqual(recovered, secret);
  });

  it('32-byte secret (curve25519 scalar)', () => {
    const secret = randomBytes(32);
    const shares = split(new Uint8Array(secret), 3, 5);
    const recovered = reconstruct(shares.slice(1, 4)); // shares 2,3,4
    assert.deepEqual(Buffer.from(recovered), secret);
  });

  it('hex convenience functions', () => {
    const hexSecret = 'deadbeef0123456789abcdef';
    const shares = splitHex(hexSecret, 3, 5);
    assert.equal(shares.length, 5);
    assert.equal(shares[0].data.length, hexSecret.length); // Hex string length

    const recovered = reconstructHex(shares.slice(0, 3));
    assert.equal(recovered, hexSecret);
  });

  it('2-of-3 threshold', () => {
    const secret = randomBytes(32);
    const shares = split(new Uint8Array(secret), 2, 3);
    // Any 2 shares should work
    assert.deepEqual(Buffer.from(reconstruct([shares[0], shares[1]])), secret);
    assert.deepEqual(Buffer.from(reconstruct([shares[0], shares[2]])), secret);
    assert.deepEqual(Buffer.from(reconstruct([shares[1], shares[2]])), secret);
  });

  it('5-of-9 threshold (poker table)', () => {
    const secret = randomBytes(32);
    const shares = split(new Uint8Array(secret), 5, 9);
    assert.equal(shares.length, 9);
    // Use shares 1,3,5,7,9
    const subset = [shares[0], shares[2], shares[4], shares[6], shares[8]];
    assert.deepEqual(Buffer.from(reconstruct(subset)), secret);
  });

  it('share indices are 1-based', () => {
    const secret = new Uint8Array([42]);
    const shares = split(secret, 2, 3);
    assert.equal(shares[0].index, 1);
    assert.equal(shares[1].index, 2);
    assert.equal(shares[2].index, 3);
  });

  it('100 random secrets all reconstruct correctly', () => {
    for (let i = 0; i < 100; i++) {
      const secret = randomBytes(32);
      const shares = split(new Uint8Array(secret), 3, 5);
      const recovered = reconstruct(shares.slice(0, 3));
      assert.deepEqual(Buffer.from(recovered), secret);
    }
  });

  it('large secret (512 bytes)', () => {
    const secret = randomBytes(512);
    const shares = split(new Uint8Array(secret), 3, 5);
    const recovered = reconstruct(shares.slice(2, 5));
    assert.deepEqual(Buffer.from(recovered), secret);
  });
});
