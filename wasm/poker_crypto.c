/**
 * Poker Crypto WASM — wraps the original C code for use in JS
 * ALL bits256 params passed as pointers (32-byte buffers)
 */
#include <emscripten.h>
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
#include "curve25519.h"

#define CARDS_MAXCARDS 52
#define CARDS_MAXPLAYERS 9

struct pair256 { bits256 priv, prod; };

// Forward declarations
bits256 fmul_donna(bits256 a, bits256 b);
bits256 crecip_donna(bits256 a);
bits256 xoverz_donna(bits256 a);

static bits256 curve25519_fieldelement(bits256 hash) {
    hash.bytes[0] &= 0xf8; hash.bytes[31] &= 0x7f; hash.bytes[31] |= 0x40;
    return hash;
}

static bits256 card_rand256_internal(int32_t privkeyflag, int8_t index) {
    bits256 randval;
    OS_randombytes(randval.bytes, sizeof(randval));
    if (privkeyflag != 0)
        randval.bytes[0] &= 0xf8, randval.bytes[31] &= 0x7f, randval.bytes[31] |= 0x40;
    randval.bytes[30] = index;
    return randval;
}

// Global permutations (reset per session)
static int32_t permis_d[CARDS_MAXCARDS];
static int32_t permis_b[CARDS_MAXCARDS];
static int permis_d_init = 0, permis_b_init = 0;

EMSCRIPTEN_KEEPALIVE
void bet_permutation(int32_t *permis, int32_t numcards) {
    for (int32_t i = 0; i < numcards; i++) permis[i] = i;
    for (int32_t i = numcards - 1; i > 0; i--) {
        uint32_t r;
        OS_randombytes((uint8_t*)&r, sizeof(r));
        int32_t j = r % (i + 1);
        int32_t tmp = permis[i]; permis[i] = permis[j]; permis[j] = tmp;
    }
}

EMSCRIPTEN_KEEPALIVE
void reset_permutations(void) {
    permis_d_init = 0;
    permis_b_init = 0;
}

/**
 * deckgen_player — Player generates their deck
 * All arrays are flat byte buffers: bits256[n] = n*32 bytes
 */
EMSCRIPTEN_KEEPALIVE
void deckgen_player(
    uint8_t *out_privs,      // OUT: player privkeys [numcards * 32]
    uint8_t *out_cards,      // OUT: blinded cards [numcards * 32]
    uint8_t *out_pubkey,     // OUT: public key [32]
    int32_t numcards
) {
    struct pair256 randcards[CARDS_MAXCARDS];
    bits256 key_pub;
    bits256 key_priv = curve25519_keypair(&key_pub);

    for (int32_t i = 0; i < numcards; i++) {
        randcards[i].priv = card_rand256_internal(1, i);
        randcards[i].prod = curve25519(randcards[i].priv, curve25519_basepoint9());
    }

    for (int32_t i = 0; i < numcards; i++) {
        bits256 blinded = curve25519(randcards[i].priv, key_pub);
        memcpy(out_privs + i * 32, randcards[i].priv.bytes, 32);
        memcpy(out_cards + i * 32, blinded.bytes, 32);
    }
    memcpy(out_pubkey, key_pub.bytes, 32);
}

/**
 * deckgen_vendor — Dealer processes a player's cards
 */
EMSCRIPTEN_KEEPALIVE
void deckgen_vendor(
    int32_t playerid,
    uint8_t *out_cardprods,   // OUT: card products [numcards * 32]
    uint8_t *out_finalcards,  // OUT: final cards [numcards * 32]
    int32_t numcards,
    uint8_t *in_playercards   // IN: player's blinded cards [numcards * 32]
) {
    struct pair256 randcards[CARDS_MAXCARDS];
    bits256 tmp[CARDS_MAXCARDS];

    // Generate dealer's random cards
    for (int32_t i = 0; i < numcards; i++)
        randcards[i].priv = curve25519_keypair(&randcards[i].prod);

    // Initialize dealer permutation once
    if (!permis_d_init) { bet_permutation(permis_d, numcards); permis_d_init = 1; }

    for (int32_t i = 0; i < numcards; i++) {
        bits256 playercard;
        memcpy(playercard.bytes, in_playercards + i * 32, 32);

        bits256 xoverz = xoverz_donna(curve25519(randcards[i].priv, playercard));
        bits256 hash;
        vcalc_sha256(0, hash.bytes, xoverz.bytes, sizeof(xoverz));
        tmp[i] = fmul_donna(curve25519_fieldelement(hash), randcards[i].priv);
    }

    for (int32_t i = 0; i < numcards; i++) {
        memcpy(out_finalcards + i * 32, tmp[permis_d[i]].bytes, 32);
        memcpy(out_cardprods + i * 32, randcards[i].prod.bytes, 32);
    }
}

/**
 * p2p_bvv_init — Cashier blinds the cards
 */
EMSCRIPTEN_KEEPALIVE
void p2p_bvv_init(
    uint8_t *out_blindings,    // OUT: blinding values [numcards * 32]
    uint8_t *out_blindedcards, // OUT: blinded cards [numcards * 32]
    uint8_t *in_finalcards,    // IN: from dealer [numcards * 32]
    int32_t numcards
) {
    if (!permis_b_init) { bet_permutation(permis_b, numcards); permis_b_init = 1; }

    for (int32_t i = 0; i < numcards; i++) {
        bits256 blinding = rand256(1);
        bits256 finalcard;
        memcpy(finalcard.bytes, in_finalcards + permis_b[i] * 32, 32);

        bits256 blinded = fmul_donna(finalcard, blinding);
        memcpy(out_blindings + i * 32, blinding.bytes, 32);
        memcpy(out_blindedcards + i * 32, blinded.bytes, 32);
    }
}

/**
 * decode_card — Decode a single card
 * Returns card index (0-51) or -1 on failure
 */
EMSCRIPTEN_KEEPALIVE
int32_t decode_card(
    uint8_t *in_encrypted,     // IN: encrypted card [32]
    uint8_t *in_blinding,      // IN: blinding value [32]
    uint8_t *in_player_privs,  // IN: player's private keys [numcards * 32]
    uint8_t *in_dealer_prods,  // IN: dealer's card products [numcards * 32]
    int32_t numcards
) {
    bits256 enc, blind, blind_inv, unblinded;
    memcpy(enc.bytes, in_encrypted, 32);
    memcpy(blind.bytes, in_blinding, 32);

    blind_inv = crecip_donna(blind);
    unblinded = fmul_donna(blind_inv, enc);

    for (int32_t i = 0; i < numcards; i++) {
        bits256 priv, prod;
        memcpy(priv.bytes, in_player_privs + i * 32, 32);
        for (int32_t j = 0; j < numcards; j++) {
            memcpy(prod.bytes, in_dealer_prods + j * 32, 32);
            bits256 test = curve25519(priv, prod);
            if (memcmp(unblinded.bytes, test.bytes, 32) == 0) {
                return priv.bytes[30];
            }
        }
    }
    return -1;
}

EMSCRIPTEN_KEEPALIVE
uint8_t* alloc_bytes(int32_t size) { return (uint8_t*)malloc(size); }

EMSCRIPTEN_KEEPALIVE
void free_bytes(uint8_t* ptr) { free(ptr); }
