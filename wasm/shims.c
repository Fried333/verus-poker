/**
 * Shims for missing functions when compiling to WASM
 */
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

// Use emscripten's random (backed by crypto.getRandomValues in browser/node)
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
EM_JS(void, js_random_bytes, (uint8_t *buf, int len), {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
        crypto.getRandomValues(HEAPU8.subarray(buf, buf + len));
    } else {
        // Node.js fallback
        var nodeCrypto = require('crypto');
        var bytes = nodeCrypto.randomBytes(len);
        for (var i = 0; i < len; i++) HEAPU8[buf + i] = bytes[i];
    }
});
#endif

void OS_randombytes(unsigned char *x, long xlen) {
#ifdef __EMSCRIPTEN__
    js_random_bytes(x, (int)xlen);
#else
    // Fallback for non-emscripten builds
    FILE *f = fopen("/dev/urandom", "rb");
    if (f) { fread(x, 1, xlen, f); fclose(f); }
#endif
}

// init_hexbytes_noT — convert bytes to hex string (no trailing null check)
static const char hexchars[] = "0123456789abcdef";
int32_t init_hexbytes_noT(char *hexbytes, uint8_t *message, long len) {
    for (long i = 0; i < len; i++) {
        hexbytes[i*2] = hexchars[(message[i] >> 4) & 0xf];
        hexbytes[i*2+1] = hexchars[message[i] & 0xf];
    }
    hexbytes[len*2] = 0;
    return (int32_t)(len * 2 + 1);
}

// curve25519_fieldelement — clamp hash to valid field element
#include "curve25519.h"
bits256 curve25519_fieldelement(bits256 hash) {
    hash.bytes[0] &= 0xf8;
    hash.bytes[31] &= 0x7f;
    hash.bytes[31] |= 0x40;
    return hash;
}
