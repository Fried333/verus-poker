/**
 * Mental Poker Protocol — based on sg777's PANGEA design
 * Zero dependencies. Uses BigInt (built-in) and crypto (built-in).
 *
 * Curve25519 field: p = 2^255 - 19
 * Core operation: field multiplication (a * b mod p)
 * ~20,000x faster than SRA modular exponentiation
 */

import { randomBytes } from 'crypto';

const P = (1n << 255n) - 19n;

// Field arithmetic
export const fieldMul = (a, b) => ((a % P) * (b % P)) % P;

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

export const fieldRecip = (a) => modPow(a, P - 2n, P);

// Byte conversion (little-endian, matching curve25519)
export function bytesToBigInt(bytes) {
  let r = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(bytes[i]);
  return r;
}

export function bigIntToBytes(n) {
  const b = new Uint8Array(32);
  let v = ((n % P) + P) % P;
  for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xFFn); v >>= 8n; }
  return b;
}

// Random field element
export function randomFieldElement() {
  const bytes = randomBytes(32);
  bytes[0] &= 248; bytes[31] &= 127; bytes[31] |= 64;
  return bytesToBigInt(bytes) % P;
}

// Card index lives in byte 30 of the private key (matching C code)
export function getCardIndex(priv) {
  return Number((priv >> 240n) & 0xFFn);
}

function setCardIndex(val, index) {
  const bytes = bigIntToBytes(val);
  bytes[30] = index;
  return bytesToBigInt(bytes);
}

// Blinding operations
export const blindCard = (card, key) => fieldMul(card, key);
export const unblindCard = (card, key) => fieldMul(card, fieldRecip(key));

// Fisher-Yates shuffle with crypto randomness
export function cryptoShuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomBytes(4).readUInt32BE(0) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Generate deck keypairs — card index embedded in byte 30
export function generateDeck(n = 14) {
  return Array.from({ length: n }, (_, i) => {
    const priv = setCardIndex(randomFieldElement(), i);
    return { priv, cardIndex: i };
  });
}

export function generateBlindingKeys(n) {
  return Array.from({ length: n }, () => randomFieldElement());
}

export function generatePermutation(n) {
  return cryptoShuffle(Array.from({ length: n }, (_, i) => i));
}

export function applyPermutation(arr, perm) {
  return perm.map(i => arr[i]);
}

// ============================================================
// Protocol Steps
// ============================================================

// Step 1: Player generates deck, sends public values
export function playerInitDeck(n = 14) {
  const keypairs = generateDeck(n);
  return { keypairs, publicCards: keypairs.map(kp => kp.priv) };
}

// Step 2: Dealer shuffles + blinds
export function dealerShuffleAndBlind(playerCards, n = 14) {
  const perm = generatePermutation(n);
  const keys = generateBlindingKeys(n);
  const shuffled = applyPermutation(playerCards, perm);
  const blinded = shuffled.map((c, i) => blindCard(c, keys[i]));
  return { blindedCards: blinded, deckInfo: { keys, perm } };
}

// Step 3: Blinder shuffles + blinds again
export function blinderShuffleAndBlind(dealerCards, n = 14) {
  const perm = generatePermutation(n);
  const keys = generateBlindingKeys(n);
  const shuffled = applyPermutation(dealerCards, perm);
  const blinded = shuffled.map((c, i) => blindCard(c, keys[i]));
  return { blindedCards: blinded, deckInfo: { keys, perm } };
}

// Step 4: Reveal a card — remove both blinding layers
export function revealCard(doubleBlinded, blinderKey, dealerKey) {
  return unblindCard(unblindCard(doubleBlinded, blinderKey), dealerKey);
}
