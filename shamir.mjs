/**
 * Shamir's Secret Sharing over GF(256)
 * Port of gfshare.c from the CHIPS/bet codebase.
 *
 * Split a secret into N shares with threshold M (M-of-N reconstruction).
 * Used for distributing card blinding values to players.
 */

import { randomBytes } from 'crypto';

// GF(256) multiplication and inversion tables
// Using the irreducible polynomial x^8 + x^4 + x^3 + x + 1 (0x11b)
const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);

// Initialize lookup tables
(function initTables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x = x << 1;
    if (x & 0x100) x ^= 0x11b;
  }
  // Repeat for wraparound
  for (let i = 255; i < 512; i++) {
    EXP_TABLE[i] = EXP_TABLE[i - 255];
  }
  LOG_TABLE[0] = 0; // Convention: log(0) = 0, though 0 has no log in GF(256)
})();

/**
 * GF(256) multiplication
 */
function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
}

/**
 * GF(256) inverse
 */
function gfInv(a) {
  if (a === 0) throw new Error('Cannot invert 0 in GF(256)');
  return EXP_TABLE[255 - LOG_TABLE[a]];
}

/**
 * GF(256) division
 */
function gfDiv(a, b) {
  if (b === 0) throw new Error('Division by 0 in GF(256)');
  if (a === 0) return 0;
  return EXP_TABLE[(LOG_TABLE[a] + 255 - LOG_TABLE[b]) % 255];
}

/**
 * Evaluate a polynomial at point x in GF(256)
 * coeffs[0] = constant term (the secret)
 */
function polyEval(coeffs, x) {
  let result = 0;
  let xi = 1; // x^0
  for (let i = 0; i < coeffs.length; i++) {
    result ^= gfMul(coeffs[i], xi);
    xi = gfMul(xi, x);
  }
  return result;
}

/**
 * Split a single byte secret into N shares with threshold M.
 * Returns array of { x, y } pairs where x is the share index (1..N) and y is the share value.
 */
function splitByte(secret, M, N) {
  // Generate random polynomial of degree M-1 with secret as constant term
  const coeffs = new Uint8Array(M);
  coeffs[0] = secret;
  const rand = randomBytes(M - 1);
  for (let i = 1; i < M; i++) {
    coeffs[i] = rand[i - 1];
    // Ensure highest coefficient is non-zero for proper degree
    if (i === M - 1 && coeffs[i] === 0) coeffs[i] = 1;
  }

  // Evaluate at points 1, 2, ..., N
  const shares = [];
  for (let i = 0; i < N; i++) {
    const x = i + 1; // Share indices 1..N (never 0, as that would reveal the secret)
    shares.push({ x, y: polyEval(coeffs, x) });
  }
  return shares;
}

/**
 * Reconstruct a single byte secret from M or more shares using Lagrange interpolation.
 * Evaluates the polynomial at x=0 to recover the constant term (the secret).
 */
function reconstructByte(shares) {
  let secret = 0;
  const M = shares.length;

  for (let i = 0; i < M; i++) {
    // Compute Lagrange basis polynomial L_i(0)
    // L_i(0) = product of (0 - x_j) / (x_i - x_j) for j != i
    // In GF(256): (0 - x_j) = x_j (since -a = a in GF(2^k))
    // So L_i(0) = product of x_j / (x_i XOR x_j) for j != i
    let basis = 1;
    for (let j = 0; j < M; j++) {
      if (i === j) continue;
      // numerator term: x_j
      // denominator term: x_i XOR x_j (subtraction in GF(256) is XOR)
      const num = shares[j].x;
      const den = shares[i].x ^ shares[j].x;
      if (den === 0) throw new Error('Duplicate share indices');
      basis = gfMul(basis, gfDiv(num, den));
    }
    secret ^= gfMul(shares[i].y, basis);
  }
  return secret;
}

/**
 * Split a multi-byte secret (Buffer/Uint8Array) into N shares with threshold M.
 * Returns array of N shares, each is { index: 1..N, data: Uint8Array }
 */
export function split(secret, M, N) {
  if (M < 2) throw new Error('Threshold must be at least 2');
  if (N < M) throw new Error('N must be >= M');
  if (N > 254) throw new Error('N must be <= 254');
  if (!(secret instanceof Uint8Array)) {
    if (Buffer.isBuffer(secret)) secret = new Uint8Array(secret);
    else throw new Error('Secret must be Uint8Array or Buffer');
  }

  const shares = Array.from({ length: N }, (_, i) => ({
    index: i + 1,
    data: new Uint8Array(secret.length)
  }));

  for (let byte = 0; byte < secret.length; byte++) {
    const byteShares = splitByte(secret[byte], M, N);
    for (let i = 0; i < N; i++) {
      shares[i].data[byte] = byteShares[i].y;
    }
  }

  return shares;
}

/**
 * Reconstruct a secret from M or more shares.
 * shares: array of { index: number, data: Uint8Array }
 */
export function reconstruct(shares) {
  if (shares.length < 2) throw new Error('Need at least 2 shares');
  const secretLen = shares[0].data.length;
  const result = new Uint8Array(secretLen);

  for (let byte = 0; byte < secretLen; byte++) {
    const byteShares = shares.map(s => ({ x: s.index, y: s.data[byte] }));
    result[byte] = reconstructByte(byteShares);
  }

  return result;
}

/**
 * Convenience: split a hex string secret
 */
export function splitHex(hexSecret, M, N) {
  const buf = Buffer.from(hexSecret, 'hex');
  return split(new Uint8Array(buf), M, N).map(s => ({
    index: s.index,
    data: Buffer.from(s.data).toString('hex')
  }));
}

/**
 * Convenience: reconstruct from hex shares
 */
export function reconstructHex(shares) {
  const parsed = shares.map(s => ({
    index: s.index,
    data: new Uint8Array(Buffer.from(s.data, 'hex'))
  }));
  return Buffer.from(reconstruct(parsed)).toString('hex');
}
