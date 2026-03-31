/**
 * SRA Mental Poker — 2-party, no cashier needed
 * Commutative encryption: E_a(E_b(x)) = E_b(E_a(x))
 * Uses Pohlig-Hellman: E_k(x) = x^k mod p
 * Zero dependencies.
 */

import { randomBytes } from 'crypto';

// NIST DH group 14 (2048-bit safe prime, RFC 3526)
const P = BigInt('0x' +
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AACAA68FFFFFFFFFFFFFFFF');
const P1 = P - 1n;

function modPow(base, exp, mod) {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b > 0n) { [a, b] = [b, a % b]; }
  return a;
}

function extGcd(a, b) {
  if (a === 0n) return [b, 0n, 1n];
  const [g, x, y] = extGcd(b % a, a);
  return [g, y - (b / a) * x, x];
}

function modInverse(a, m) {
  const [g, x] = extGcd(((a % m) + m) % m, m);
  if (g !== 1n) throw new Error('No inverse');
  return ((x % m) + m) % m;
}

function randomBigInt(max) {
  const byteLen = (max.toString(16).length + 1) >> 1;
  while (true) {
    const val = BigInt('0x' + randomBytes(byteLen).toString('hex')) % max;
    if (val >= 2n) return val;
  }
}

// Generate keypair: k coprime to p-1, k_inv = k^(-1) mod (p-1)
export function generateKeyPair() {
  let k;
  do { k = randomBigInt(P1); } while (gcd(k, P1) !== 1n);
  return { enc: k, dec: modInverse(k, P1) };
}

// Encrypt: x^k mod p
export const encrypt = (card, key) => modPow(card, key.enc, P);

// Decrypt: x^(k_inv) mod p
export const decrypt = (card, key) => modPow(card, key.dec, P);

// Shuffle
export function cryptoShuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE(0) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Plaintext deck: card values 2..53 (avoid 0,1 identity elements)
export const createDeck = (n = 52) => Array.from({ length: n }, (_, i) => BigInt(i + 2));
export const cardFromPlaintext = (val) => Number(val) - 2;

// Encrypt + shuffle (what each player does)
export function encryptAndShuffle(deck, key) {
  return cryptoShuffle(deck.map(c => encrypt(c, key)));
}

// Full protocol steps
export function playerEncryptAndShuffle(deck) {
  const key = generateKeyPair();
  const encrypted = encryptAndShuffle(deck, key);
  return { encrypted, key };
}
