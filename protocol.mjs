/**
 * Full Poker Protocol — implements the BCRA 2026 paper
 * Algorithm 2 (Shuffle and Blind) + Algorithm 3 (Card Reveal) + Algorithm 4 (Verification)
 *
 * Uses field multiply (mental-poker.mjs) for crypto.
 * Will be swapped to WASM when compiled.
 */

import {
  fieldMul, fieldRecip, randomFieldElement, getCardIndex,
  bytesToBigInt, bigIntToBytes, cryptoShuffle, generatePermutation,
  applyPermutation, generateBlindingKeys
} from './mental-poker.mjs';
import { createHash, randomBytes } from 'crypto';

const P = (1n << 255n) - 19n;

// Generator point G (basepoint 9 for curve25519)
const G = 9n;

// Scalar multiplication placeholder (field mul for now — proper curve25519 in WASM)
const scalarMul = (scalar, point) => fieldMul(scalar, point);

/**
 * Algorithm 1: Player Deck Initialization
 * Each player generates their initial card representations.
 */
export function playerInit(numCards, playerId) {
  const nonces = []; // r_ik
  const scalars = []; // h_ik
  const points = []; // P_ik = h_ik * G

  for (let k = 0; k < numCards; k++) {
    const r_ik = randomBytes(32).toString('hex');
    const h_ik_bytes = createHash('sha256').update(r_ik + '||card_' + k + '_string').digest();
    const h_ik = bytesToBigInt(new Uint8Array(h_ik_bytes)) % P;
    const P_ik = scalarMul(h_ik, G);

    nonces.push(r_ik);
    scalars.push(h_ik);
    points.push(P_ik);
  }

  // Generate session keypair
  const p_i = randomFieldElement();
  const P_i = scalarMul(p_i, G);

  // Generate secret permutation
  const sigma_i = generatePermutation(numCards);

  // Commitment
  const commitData = p_i.toString(16) + '||' + sigma_i.join(',');
  const C_secrets = createHash('sha256').update(
    nonces.join('||')
  ).digest('hex');

  // Permute and blind: D_1,i = {p_i * P_i,sigma_i^(-1)(j)}
  const D_0 = points; // Initial deck
  const D_0_permuted = applyPermutation(D_0, sigma_i);
  const D_1 = D_0_permuted.map(point => scalarMul(p_i, point));

  return {
    // Private (kept by player)
    nonces,       // r_ik
    scalars,      // h_ik
    sessionKey: p_i,
    permutation: sigma_i,
    secretsCommitment: C_secrets,

    // Public (sent to dealer via Verus ID)
    publicKey: P_i,
    initialDeck: D_0,   // {P_i1, ..., P_iZ}
    blindedDeck: D_1,    // After permute + blind
    commitment: createHash('sha256').update(commitData).digest('hex')
  };
}

/**
 * Algorithm 2, Stage II: Dealer Shuffle and Blind
 * Dealer applies global scalar d, permutation σ_Dealer, and player-specific e_i.
 */
export function dealerShuffle(playerDecks, numCards) {
  const numPlayers = playerDecks.length;

  // Generate dealer secrets
  const d = randomFieldElement();              // Global scalar
  const sigma_Dealer = generatePermutation(numCards); // Global permutation
  const e = [];                                 // Player-specific scalars
  const E = [];                                 // Public points for e_i

  for (let i = 0; i < numPlayers; i++) {
    const e_i = randomFieldElement();
    e.push(e_i);
    E.push(scalarMul(e_i, G));
  }

  // Process each player's deck
  const D_2 = []; // Output: dealer-blinded decks per player

  for (let i = 0; i < numPlayers; i++) {
    const D_1 = playerDecks[i].blindedDeck;

    // Permute with dealer's permutation
    const D_1_permuted = applyPermutation(D_1, sigma_Dealer);

    // Blind with global d, then with player-specific e_i
    const D_2_i = D_1_permuted.map(point => {
      const blinded_d = scalarMul(d, point);
      return scalarMul(e[i], blinded_d);
    });

    D_2.push(D_2_i);
  }

  // Commitment
  const commitData = d.toString(16) + '||' + sigma_Dealer.join(',') +
    '||' + e.map(x => x.toString(16)).join(',');
  const dealerCommitment = createHash('sha256').update(commitData).digest('hex');

  return {
    // Private (kept by dealer)
    d,
    sigma_Dealer,
    e,                    // Player-specific scalars

    // Public
    E,                    // Public points for each e_i
    dealerCommitment,
    blindedDecks: D_2     // Per-player dealer-blinded decks
  };
}

/**
 * Algorithm 2, Stage III: Cashier Shuffle and Blind + SSS
 * Cashier applies permutation, per-card blinding, and splits blinding values.
 */
export function cashierShuffle(dealerBlindedDecks, numPlayers, numCards, sssThreshold) {
  const sigma_Cashier = generatePermutation(numCards);
  const b = [];     // b[i][j] = blinding scalar for player i, card j
  const D_3 = [];   // Final decks
  const sssShares = []; // sssShares[i][j] = array of N shares for b_ij

  for (let i = 0; i < numPlayers; i++) {
    const D_2 = dealerBlindedDecks[i];
    const b_i = [];
    const shares_i = [];

    // Permute with cashier's permutation
    const D_2_permuted = applyPermutation(D_2, sigma_Cashier);

    // Blind each card with unique b_ij
    const D_3_i = [];
    for (let j = 0; j < numCards; j++) {
      const b_ij = randomFieldElement();
      b_i.push(b_ij);

      // Blind
      const C_ij = scalarMul(b_ij, D_2_permuted[j]);
      D_3_i.push(C_ij);

      // Split b_ij into SSS shares
      const secretBytes = bigIntToBytes(b_ij);
      // Simple SSS in JS (we'll use WASM version in production)
      const cardShares = simpleSSSplit(secretBytes, sssThreshold, numPlayers);
      shares_i.push(cardShares);
    }

    b.push(b_i);
    D_3.push(D_3_i);
    sssShares.push(shares_i);
  }

  // Commitment
  const commitData = sigma_Cashier.join(',') + '||' +
    b.map(bi => bi.map(x => x.toString(16)).join(',')).join('||');
  const cashierCommitment = createHash('sha256').update(commitData).digest('hex');

  return {
    // Private (kept by cashier)
    sigma_Cashier,
    b,                     // All blinding values

    // Distributed to players (encrypted in production)
    sssShares,             // sssShares[player][card] = shares array

    // Public
    cashierCommitment,
    finalDecks: D_3        // Per-player final encrypted decks
  };
}

/**
 * Algorithm 3: Card Reveal (Private — Hole Cards)
 * Player reconstructs b_ij from SSS shares, then unblinds through dealer.
 */
export function revealCard(playerIndex, cardPosition, sssShares, playerData, dealerData, numPlayers, sssThreshold) {
  // Step 1: Collect M shares for b_ij and reconstruct
  const shares = [];
  for (let k = 0; k < numPlayers && shares.length < sssThreshold; k++) {
    if (sssShares[playerIndex][cardPosition][k]) {
      shares.push(sssShares[playerIndex][cardPosition][k]);
    }
  }

  if (shares.length < sssThreshold) {
    throw new Error('Not enough SSS shares to reconstruct');
  }

  const b_ij_bytes = simpleSSSReconstruct(shares, sssThreshold);
  const b_ij = bytesToBigInt(b_ij_bytes) % P;

  // Step 2: Remove cashier blinding
  // C'_ij = b_ij^(-1) * C_ij = (e_i * d * p_i) * P_i,k
  const b_ij_inv = fieldRecip(b_ij);
  // Note: we need the final encrypted card value from the cashier's output
  // For this simplified version, we compute the unblinding chain directly

  // Step 3: Get e_i and d from dealer
  const e_i = dealerData.e[playerIndex];
  const d = dealerData.d;

  // Step 4: Remove dealer blinding: (e_i * d)^(-1)
  const ed_inv = fieldRecip(fieldMul(e_i, d));

  // Step 5: Remove player blinding: p_i^(-1)
  const p_i_inv = fieldRecip(playerData.sessionKey);

  // Combined unblinding: p_i^(-1) * (e_i*d)^(-1) * b_ij^(-1) * C_ij = h_ik * G
  // Then match against initial deck to find card k

  return {
    b_ij,
    b_ij_inv,
    ed_inv,
    p_i_inv
  };
}

/**
 * Full card decode: given all secrets, recover the card index at a position
 */
export function decodeCard(encryptedCard, b_ij, e_i, d, p_i, initialDeck) {
  // Remove all blinding layers
  let point = encryptedCard;
  point = fieldMul(fieldRecip(b_ij), point);   // Remove cashier
  point = fieldMul(fieldRecip(e_i), point);     // Remove dealer e_i
  point = fieldMul(fieldRecip(d), point);       // Remove dealer d
  point = fieldMul(fieldRecip(p_i), point);     // Remove player

  // Match against initial deck points
  for (let k = 0; k < initialDeck.length; k++) {
    if (point === initialDeck[k]) {
      return k;
    }
  }

  // Fallback: try getCardIndex
  return getCardIndex(point);
}

/**
 * Algorithm 4: Post-Game Verification
 * Replay all steps and verify every intermediate deck matches.
 */
export function verifyGame(playerData, dealerData, cashierData, numCards) {
  const numPlayers = playerData.length;
  const errors = [];

  // Verify player commitments
  for (let i = 0; i < numPlayers; i++) {
    const expectedCommitment = createHash('sha256').update(
      playerData[i].nonces.join('||')
    ).digest('hex');
    if (expectedCommitment !== playerData[i].secretsCommitment) {
      errors.push('Player ' + i + ' nonce commitment mismatch');
    }
  }

  // Replay Stage I: Player shuffle+blind
  for (let i = 0; i < numPlayers; i++) {
    const D_0 = playerData[i].initialDeck;
    const D_0_permuted = applyPermutation(D_0, playerData[i].permutation);
    const D_1_expected = D_0_permuted.map(p => scalarMul(playerData[i].sessionKey, p));

    for (let j = 0; j < numCards; j++) {
      if (D_1_expected[j] !== playerData[i].blindedDeck[j]) {
        errors.push('Player ' + i + ' Stage I mismatch at card ' + j);
        break;
      }
    }
  }

  // Replay Stage II: Dealer shuffle+blind
  for (let i = 0; i < numPlayers; i++) {
    const D_1 = playerData[i].blindedDeck;
    const D_1_permuted = applyPermutation(D_1, dealerData.sigma_Dealer);
    const D_2_expected = D_1_permuted.map(p => {
      return scalarMul(dealerData.e[i], scalarMul(dealerData.d, p));
    });

    if (dealerData.blindedDecks[i]) {
      for (let j = 0; j < numCards; j++) {
        if (D_2_expected[j] !== dealerData.blindedDecks[i][j]) {
          errors.push('Dealer Stage II mismatch for player ' + i + ' at card ' + j);
          break;
        }
      }
    }
  }

  // Replay Stage III: Cashier shuffle+blind
  for (let i = 0; i < numPlayers; i++) {
    if (dealerData.blindedDecks[i] && cashierData.finalDecks[i]) {
      const D_2 = dealerData.blindedDecks[i];
      const D_2_permuted = applyPermutation(D_2, cashierData.sigma_Cashier);
      const D_3_expected = D_2_permuted.map((p, j) => {
        return scalarMul(cashierData.b[i][j], p);
      });

      for (let j = 0; j < numCards; j++) {
        if (D_3_expected[j] !== cashierData.finalDecks[i][j]) {
          errors.push('Cashier Stage III mismatch for player ' + i + ' at card ' + j);
          break;
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// ============================================================
// Simple SSS helpers (JS fallback — production uses WASM)
// ============================================================

function simpleSSSplit(secretBytes, M, N) {
  // Very simple byte-level split — matches the C SSS approach
  const shares = [];
  for (let i = 0; i < N; i++) {
    const share = new Uint8Array(secretBytes.length);
    for (let b = 0; b < secretBytes.length; b++) {
      // Simple polynomial eval in GF(256)
      // For now, use a basic XOR-based approach
      // This is a placeholder — production uses the C WASM SSS
      share[b] = secretBytes[b] ^ ((i + 1) * (b + 1) & 0xFF);
    }
    shares.push({ index: i + 1, data: share });
  }
  return shares;
}

function simpleSSSReconstruct(shares, M) {
  // Placeholder — just XOR back
  const len = shares[0].data.length;
  const result = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    result[b] = shares[0].data[b] ^ ((shares[0].index) * (b + 1) & 0xFF);
  }
  return result;
}
