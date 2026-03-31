/**
 * Mental Poker Protocol — based on sg777's PANGEA design
 *
 * Uses curve25519 field multiplication for encryption/blinding.
 * This is ~20,000x faster than SRA modular exponentiation.
 *
 * Protocol (3-party: Player, Dealer/DCV, Blinder/BVV):
 * 1. Player generates deck keypairs (card index in byte 30 of private key)
 * 2. Dealer shuffles + blinds with dealer's per-card keys (curve25519 scalar mult)
 * 3. Blinder shuffles + blinds with blinder's per-card keys (field multiply)
 * 4. To reveal: blinder reveals its blinding value, player uses own key to decode
 * 5. Card identity = byte 30 of the recovered private key
 *
 * For TypeScript we use BigInt arithmetic on the curve25519 field.
 * The field prime is 2^255 - 19.
 */

// Curve25519 field prime: 2^255 - 19
const P = (1n << 255n) - 19n;

/**
 * Field multiplication: (a * b) mod p
 * This is the core operation — equivalent to fmul_donna in the C code.
 */
export function fieldMul(a: bigint, b: bigint): bigint {
  return ((a % P) * (b % P)) % P;
}

/**
 * Field addition: (a + b) mod p
 */
export function fieldAdd(a: bigint, b: bigint): bigint {
  return ((a % P) + (b % P)) % P;
}

/**
 * Field subtraction: (a - b) mod p
 */
export function fieldSub(a: bigint, b: bigint): bigint {
  return (((a % P) - (b % P)) + P) % P;
}

/**
 * Modular exponentiation: base^exp mod p (for field inverse)
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) {
      result = (result * base) % mod;
    }
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/**
 * Field reciprocal (inverse): a^(-1) mod p
 * Uses Fermat's little theorem: a^(-1) = a^(p-2) mod p
 * Equivalent to crecip_donna in the C code.
 */
export function fieldRecip(a: bigint): bigint {
  return modPow(a, P - 2n, P);
}

/**
 * Convert a 32-byte Uint8Array to BigInt (little-endian, as in curve25519)
 */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    result = (result << 8n) | BigInt(bytes[i]);
  }
  return result;
}

/**
 * Convert BigInt to 32-byte Uint8Array (little-endian)
 */
export function bigIntToBytes(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = ((n % P) + P) % P;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & 0xFFn);
    val >>= 8n;
  }
  return bytes;
}

/**
 * Generate a random field element using crypto.getRandomValues
 */
export function randomFieldElement(): bigint {
  let bytes: Uint8Array;
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node.js fallback
    const nodeCrypto = require('crypto');
    bytes = nodeCrypto.randomBytes(32);
  }
  // Clamp to curve25519 field element (like curve25519_fieldelement in bet.c)
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  return bytesToBigInt(bytes) % P;
}

/**
 * Generate a card keypair.
 * The card index is embedded in byte 30 of the private key (matching sg777's design).
 * Private key is a random field element with card index encoded.
 * Public key = private key (in field multiply protocol, the "public" part
 * is the field element itself, blinded by multiplication).
 */
export interface CardKeyPair {
  priv: bigint;      // Private key (random field element with card index in "byte 30")
  pub: bigint;       // In this protocol, the public representation
  cardIndex: number;  // 0-51
}

/**
 * Generate a deck of card keypairs.
 * Each card's private key has the card index encoded, matching the C code:
 *   randval.bytes[30] = index
 */
export function generateDeck(numCards: number = 52): CardKeyPair[] {
  const deck: CardKeyPair[] = [];
  for (let i = 0; i < numCards; i++) {
    const priv = randomFieldElement();
    // Embed card index in byte 30 (matching C code: card_rand256)
    const privBytes = bigIntToBytes(priv);
    privBytes[30] = i;
    const privWithIndex = bytesToBigInt(privBytes);
    deck.push({
      priv: privWithIndex,
      pub: privWithIndex, // In field protocol, pub = priv (blinded by multiplication)
      cardIndex: i
    });
  }
  return deck;
}

/**
 * Extract card index from a decoded private key (byte 30).
 */
export function getCardIndex(priv: bigint): number {
  const bytes = bigIntToBytes(priv);
  return bytes[30];
}

/**
 * Fisher-Yates shuffle using cryptographic randomness.
 */
export function cryptoShuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    let rand: number;
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
      const buf = new Uint32Array(1);
      globalThis.crypto.getRandomValues(buf);
      rand = buf[0];
    } else {
      const nodeCrypto = require('crypto');
      rand = nodeCrypto.randomBytes(4).readUInt32BE(0);
    }
    const j = rand % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Generate random blinding keys for a set of cards.
 */
export function generateBlindingKeys(numCards: number): bigint[] {
  return Array.from({ length: numCards }, () => randomFieldElement());
}

/**
 * Blind (encrypt) card values using field multiplication.
 * blind(card, key) = card * key mod p
 * This is what both the dealer and blinder do.
 */
export function blindCard(card: bigint, blindingKey: bigint): bigint {
  return fieldMul(card, blindingKey);
}

/**
 * Unblind (decrypt) a card by multiplying with the inverse of the blinding key.
 * unblind(blinded, key) = blinded * key^(-1) mod p
 */
export function unblindCard(blindedCard: bigint, blindingKey: bigint): bigint {
  return fieldMul(blindedCard, fieldRecip(blindingKey));
}

/**
 * Blind an entire deck.
 */
export function blindDeck(deck: bigint[], blindingKeys: bigint[]): bigint[] {
  if (deck.length !== blindingKeys.length) {
    throw new Error(`Deck size ${deck.length} != keys size ${blindingKeys.length}`);
  }
  return deck.map((card, i) => blindCard(card, blindingKeys[i]));
}

/**
 * Apply a permutation to reorder an array.
 */
export function applyPermutation<T>(arr: T[], perm: number[]): T[] {
  if (arr.length !== perm.length) throw new Error('Array and permutation must be same length');
  return perm.map(i => arr[i]);
}

/**
 * Generate a random permutation of integers 0..n-1.
 */
export function generatePermutation(n: number): number[] {
  const perm = Array.from({ length: n }, (_, i) => i);
  return cryptoShuffle(perm);
}

// ============================================================
// Full Protocol Types
// ============================================================

export interface PlayerDeckInfo {
  keypairs: CardKeyPair[];      // Player's per-card keypairs
  publicCards: bigint[];         // The public card values sent to dealer
}

export interface DealerDeckInfo {
  blindingKeys: bigint[];       // Dealer's per-card blinding keys
  permutation: number[];         // Dealer's shuffle order
}

export interface BlindingDeckInfo {
  blindingKeys: bigint[];       // Blinder's per-card blinding keys
  permutation: number[];         // Blinder's shuffle order
}

// ============================================================
// Protocol Steps
// ============================================================

/**
 * Step 1: Player initializes their deck.
 * Generates keypairs and sends public card values to the dealer.
 */
export function playerInitDeck(numCards: number = 14): PlayerDeckInfo {
  const keypairs = generateDeck(numCards);
  const publicCards = keypairs.map(kp => kp.pub);
  return { keypairs, publicCards };
}

/**
 * Step 2: Dealer shuffles and blinds the player's cards.
 * Applies dealer's permutation, then blinds with dealer's keys.
 */
export function dealerShuffleAndBlind(playerCards: bigint[], numCards: number = 14): {
  blindedCards: bigint[];
  deckInfo: DealerDeckInfo;
} {
  const permutation = generatePermutation(numCards);
  const blindingKeys = generateBlindingKeys(numCards);

  // Shuffle using permutation
  const shuffled = applyPermutation(playerCards, permutation);

  // Blind each card with dealer's key
  const blindedCards = blindDeck(shuffled, blindingKeys);

  return {
    blindedCards,
    deckInfo: { blindingKeys, permutation }
  };
}

/**
 * Step 3: Blinder (BVV/cashier) shuffles and blinds again.
 * Applies blinder's permutation, then blinds with blinder's keys.
 */
export function blinderShuffleAndBlind(dealerBlindedCards: bigint[], numCards: number = 14): {
  blindedCards: bigint[];
  deckInfo: BlindingDeckInfo;
} {
  const permutation = generatePermutation(numCards);
  const blindingKeys = generateBlindingKeys(numCards);

  // Shuffle again
  const shuffled = applyPermutation(dealerBlindedCards, permutation);

  // Blind again with blinder's keys
  const blindedCards = blindDeck(shuffled, blindingKeys);

  return {
    blindedCards,
    deckInfo: { blindingKeys, permutation }
  };
}

/**
 * Step 4: Reveal a card.
 * Blinder reveals its blinding key for a specific card position.
 * Player uses the inverse to remove blinder's layer, then uses own key
 * and dealer info to decode the card.
 *
 * In the simplified field-multiply protocol:
 * decoded = unblind(unblind(doubleBlinded, blinderKey), dealerKey)
 * The card index is then extracted from the decoded value.
 */
export function revealCard(
  doubleBlindedCard: bigint,
  blinderKey: bigint,
  dealerKey: bigint
): bigint {
  const afterBlinderRemoved = unblindCard(doubleBlindedCard, blinderKey);
  const decoded = unblindCard(afterBlinderRemoved, dealerKey);
  return decoded;
}

/**
 * Step 5: Player decodes the card index from the revealed value.
 * Searches their keypairs for a matching public value, then reads byte 30.
 */
export function decodeCard(
  revealedValue: bigint,
  playerKeypairs: CardKeyPair[]
): number {
  // The revealed value should match one of the player's original public cards
  // In the simplified protocol, check by field division
  for (const kp of playerKeypairs) {
    // If revealedValue == kp.pub, the card index is kp.cardIndex
    if (revealedValue === kp.pub) {
      return kp.cardIndex;
    }
  }
  // If direct match fails, try matching via byte 30
  return getCardIndex(revealedValue);
}
