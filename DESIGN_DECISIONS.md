# Design Decisions — From sg777

## 1. Keep 3-Party Architecture (Player + Dealer + Cashier)

**Decision: Do NOT move to 2-party SRA.**

### Disconnection Problem
In a 2-party commutative setup, every player encrypts the entire deck. If any player disconnects or refuses to broadcast their decryption key, the entire deck becomes permanently locked and the game halts. A losing player can grief the table by simply dropping off.

The 3-party system prevents this — the Cashier holds Shamir secret shares of the blinding values. If a player disconnects, the remaining players can reconstruct the blinding values using M-of-N threshold shares without the disconnected player.

### Collusion Resistance
The protocol requires Player + Dealer + Cashier collusion to reveal the deck, not just Dealer + Cashier. The Player's own keys and blinding factors are part of the cryptographic chain — the Dealer and Cashier cannot decrypt a player's hole cards without the player's private key material. The Cashier acts as an independent blinding layer preventing Dealer + Player collusion.

### Impact on our build
- Keep sg777 field multiply protocol (mental-poker.mjs)
- Keep the Blinder/BVV role
- SRA (mental-poker-sra.mjs) can remain as an option but is NOT the default
- The Cashier/Blinder can be automated (same process as dealer) but must remain cryptographically independent

## 2. Use Shamir Secret Sharing for Card Reveals

**Decision: Players control card revealing, not a centralized party.**

### How it works
1. Cashier blinds the deck with per-card blinding values
2. Cashier splits each blinding value using Shamir secret sharing (M-of-N threshold)
3. Each player's share is encrypted with that player's registered public key
4. Shares are distributed to players
5. To reveal a card: players exchange their Shamir shares
6. Once M shares are collected, the blinding value is reconstructed
7. Player removes the blinding, then uses their own key to decode the card

### Why this matters
- No single party controls card reveals
- A minority of players disconnecting doesn't prevent reveals (M-of-N threshold)
- Players don't need to trust the Cashier to be online during the game
- The Cashier only needs to be present during the initial deck setup

### Impact on our build
- Need to implement Shamir secret sharing (gfshare equivalent in JS)
- Each player needs a registered public key (via VerusID)
- Card reveals become player-to-player operations, not cashier-dependent
- The Cashier's role is front-loaded (deck blinding + share distribution)

## 3. Communication via Verus IDs (not P2P sockets)

**Decision: All communication through Verus IDs to bypass connectivity issues.**

The original design used direct P2P WebSocket connections. This was abandoned because of:
- NAT/firewall issues in decentralized environments
- Players needing static IPs or port forwarding
- Relay servers defeating the purpose of P2P

Moving to Verus IDs solves connectivity — all parties read/write to the blockchain. No direct connections needed.

### Our hybrid approach
We're using z-transaction memos for speed (~0.4s via mempool) while keeping the Verus ID approach for discovery and permanent state. This preserves the "no direct connection needed" property while being faster than contentmultimap polling.

## 4. Card Index in Private Key — NOT a Security Issue

**Decision: Keep the byte-30 card index encoding. No hash commitment needed.**

The premise that embedding the card index reduces entropy is incorrect. A full 256-bit random number is generated and only one byte is used for the card index. The remaining 248 bits provide massive entropy. The private key is never published — only the Curve25519 public points are shared as the deck. Because of the remaining entropy, it is cryptographically impossible to derive the private key (and the index) from the public point.

A separate hash commitment scheme is unnecessary.

## 5. Cashier is Required — Even for Casual Games

**Decision: The Cashier role is always present at the protocol level.**

For casual games, the dealer can host private tables where only designated Verus player IDs can join, and one player can act as dealer. However, at the protocol level, the Cashier is still needed — all cryptographic rules still hold.

The Cashier is NOT a single node but a **group of elected nodes**. Their availability is a non-issue because they are financially incentivized to be online — they receive a commission (dev fund commission) from the pot for providing the blinding/shuffling service.

## 6. Showdown Verification IS Cryptographic

**Decision: Self-reporting was our implementation bug, not a protocol limitation.**

The cryptographic proof IS the deck of public points published during the game. At showdown:
1. Players reveal their private blinding keys
2. Anyone can independently apply those keys to the published deck
3. If the math matches the published public points, the card is verified
4. It is impossible to cheat by self-reporting — the math must match

Our earlier implementation (writing hole cards to P_SHOWDOWN_CARDS_KEY) was incorrect. The protocol already has cryptographic verification built in — we just need to implement it correctly.

## 7. Rake Settlement — Per Hand, Not Pooled

**Decision: Rake calculated and paid immediately at end of each hand.**

From the C codebase (host.c):
- `dcv_commission` (dealer fee) and `dev_fund_commission` (cashier fee) are calculated as a percentage of the winner's funds
- These amounts are immediately subtracted from the winner's payout
- Settlement TX pays: winner (net amount) + dealer + cashier(s) in one transaction
- No "rake pool" that accumulates over time
- Paying active participants immediately keeps the state clean and avoids bloated multi-output transactions

## Summary: What we keep, what we change

| Component | Original | Our Approach | Change? |
|-----------|----------|-------------|---------|
| 3-party protocol | Yes | Yes | No change |
| sg777 field multiply | Yes | Yes | No change |
| Shamir secret sharing | Yes | Need to build in JS | Port from C |
| Cashier/Blinder role | Separate node | Automated, same process | Simplified |
| Card reveal flow | Shamir shares via players | Shamir shares via z-memos | Same logic, different transport |
| Communication | Verus ID contentmultimap | z-memos (fast) + contentmultimap (permanent) | Faster |
| Settlement | Per-hand, cashier multisig | Per-session, house payout | Changed |
| Provably fair seeds | Not in original | Added on top | New feature |

## 8. VDXF Key Indexing — No Storage Limits

Contentmultimap entries are permanently indexed in the blockchain DB, just like UTXOs. Every update to every VDXF key is stored and retrievable in order. Nothing is overwritten. `getidentitycontent` with a block range returns ALL updates to a key in that range.

This means:
- No size limit concerns — each update is independent
- Full audit trail built into the chain
- Efficient filtered queries by VDXF key
- Block range queries for replay

## 9. Mempool Ordering via UTXO Chaining

Identity updates in the mempool can be reordered by miners UNLESS each TX spends the output of the previous one (UTXO chaining). Sequential spending creates a dependency graph that guarantees order.

- v1: Wait for block confirmation (simple, ~10s per action)
- v2: Chain UTXOs for mempool-speed ordering (~1s per action, guaranteed order)

The `getidentitycontent` API with `heightend=-1` was added by Mike Toutonghi specifically for the poker use case.

## 10. Match the BCRA 2026 Paper Exactly

After reviewing the paper and dev feedback, our build should match:
- 3-party architecture (Player + Dealer + Cashier committee)
- Player-specific blinding factor `e_i` for collusion resistance
- Cryptoeconomic staking (`V_stake`) for all participants
- Virtual betting during game (data commitments on Verus IDs, not real TXs)
- Post-game full-trace replay verification by cashier committee
- Gated settlement — committee only signs payout after verification passes
- Per-hand settlement with rake paid immediately to dealer + cashier
- Cheating = slash stake (makes cheating inherently unprofitable)
