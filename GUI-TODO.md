# GUI Issues & Fix Plan

## Status: Chain layer works. GUI needs fixing.

### Proven Working
- Chain communication: 100/100 hands, 0.5s cross-node, 100% reliable
- 3-player game: 49/49 stress test hands, all streets, real shuffle/deal/verify
- Card privacy: API returns own cards face-up, opponents as ?? (verified)
- DCV separated from players (dealer is headless orchestrator)
- Dynamic player join between hands
- Winner banner displays on all 3 views

---

## Problems Found (from live 3-player testing)

### P1: Status not consistent across views
- When player A acts, players B and C should see "A checks" or "A calls"
- Currently: `lastAction` field added to chain BS data, player poll loop reads it, sets `gs.message`
- Issue: message appears briefly then gets overwritten by next pushState
- Fix needed: make status persistent — show in log AND above action buttons consistently

### P2: Cards not rendering on .59 (nginx proxy)
- Card SVG path was `/cards.bebfd660.svg` (absolute)
- Through nginx `/poker/` proxy, this resolves to wrong URL
- Fix: changed to `basePath + 'cards.bebfd660.svg'` — DEPLOYED but untested visually
- Also deployed `bg-red.44d92640.svg` to .59

### P3: Playwright test has timing issues
- Winner banner stays visible → next hand detects it as instant win
- 3-player chain delays → actions take 10-30s → test timeouts
- Need to wait for banner to HIDE before checking for next hand
- Need longer timeouts for 3-player rounds

### P4: Hand count shows wrong number
- Log shows "Hand #267 — shuffling" etc — hundreds of hands from long-running dealer
- Chips don't reset between sessions (pplayer2 had 401, pdealer2 had 0)
- Need: reset chips on new session, or track per-session

### P5: Phase text overlaps with UI
- "preflop" text shows in center of table, overlaps with seat badges
- Minor cosmetic issue

### P6: Fold spectating incomplete
- After folding, player should see: board cards updating, other players' actions, showdown
- Cards hidden correctly (verified)
- Board/pot updates need verification

---

## Architecture

```
.28 Server:
  Port 3000: Dealer (headless DCV) — writes to ptable2
  Port 3001: Player pplayer2 — reads ptable2, writes to pplayer2
  Caddy: 46-225-132-28.sslip.io → localhost:3001

.59 Server:
  Port 3001: Player pdealer2 — reads ptable2, writes to pdealer2
  nginx: verus.cx/poker/ → localhost:3001

Local PC:
  Port 3000: Player pc-player — reads ptable2, writes to pc-player
```

## Data Flow
```
Dealer writes BS to ptable2 (chain)
  → Player server polls getidentitycontent (0.5s)
  → Updates gs object
  → pushState sends fullstate via WebSocket to browser
  → handleFullState renders cards/board/buttons/status

Player clicks action button
  → WebSocket sends to player server
  → Server writes to player identity (chain)
  → Dealer polls player identity, reads action
  → Dealer updates game state, writes next BS
```

## Key Files
- `poker-server.mjs` — server: chain polling + WebSocket + API
- `p2p-dealer.mjs` — dealer: game orchestration
- `p2p-layer.mjs` — chain read/write
- `public/poker.html` — GUI: renders game state
- `public/poker-new.html` — clean alternative GUI (built, not deployed)

## Server & Identity Details

### .28 Server (46.225.132.28)
- SSH: `ssh -p 2400 root@46.225.132.28`
- CHIPS RPC: user918810440 / passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1 / port 22778
- Caddy: `46-225-132-28.sslip.io` → localhost:3001
- Code: `/root/bet/`
- Dealer: `node poker-server.mjs --local --role=dealer --table=ptable2 --players=pplayer2,pdealer2,pc-player --port=3000`
- Player: `node poker-server.mjs --local --role=player --id=pplayer2 --table=ptable2 --port=3001`

### .59 Server (89.125.50.59)
- SSH: `ssh -p 2400 root@89.125.50.59`
- CHIPS RPC: user3204884389 / pass0eb576315b2469542ae02d3232eda16948e23c621e790ce16cbd685e2e5062b855 / port 22778
- nginx: `verus.cx/poker/` → localhost:3001
- Code: `/root/bet/`
- Static files also at: `/root/pangea-poker/dist/` (served by poker-server)
- Player: `node poker-server.mjs --local --role=player --id=pdealer2 --table=ptable2 --port=3001`
- **DO NOT use `killall node`** — other production services run on this server

### Local PC
- CHIPS conf: `~/.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf`
- CHIPS RPC: user2635208224 / passb78ca123796c3618e869aacdae5bbcce0276172c1fc4c9e230fb951388a7a31383 / port 22778
- Code: `/home/dev/Desktop/chips/verus-poker/`
- Player: `node poker-server.mjs --local --role=player --id=pc-player --table=ptable2 --port=3000`
- Browser: `http://localhost:3000`
- Playwright: `NODE_PATH=/home/dev/Desktop/llm/node_modules`

### CHIPS Identities
| Identity | R-Address | Owner | Purpose |
|----------|-----------|-------|---------|
| ptable2 | RAwyMMAYjs4gM2QQPHEPrT87M1BBHGYsuc | .28 | Table (dealer writes here) |
| pplayer2 | RAwyMMAYjs4gM2QQPHEPrT87M1BBHGYsuc | .28 | Player on .28 |
| pdealer2 | RKhh2r14ejZdEi9WUBirGdZgSQtbZnMYHD | .59 | Player on .59 |
| pc-player | (local wallet) | Local | Player on local PC |

### Browser URLs
- Local: `http://localhost:3000`
- .28 player: `https://46-225-132-28.sslip.io/`
- .59 player: `https://verus.cx/poker/play?name=pdealer2`

### Key RPC Calls
- Read: `getidentitycontent` with `heightend=-1` (includes mempool, 0.5s cross-node)
- Write: `updateidentity` with `parent` field required (PBaaS chain)
- CHIPS parent: `iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP`

### Deploy Commands
```bash
# Deploy to .28
scp -P 2400 poker-server.mjs p2p-dealer.mjs p2p-layer.mjs verus-rpc.mjs public/poker.html root@46.225.132.28:/root/bet/

# Deploy to .59
scp -P 2400 poker-server.mjs p2p-layer.mjs verus-rpc.mjs public/poker.html root@89.125.50.59:/root/bet/
ssh -p 2400 root@89.125.50.59 'cp /root/bet/public/poker.html /root/pangea-poker/dist/'

# Start all (run in order)
# 1. .28 dealer + player
ssh -p 2400 root@46.225.132.28 'cd /root/bet && node poker-server.mjs --local --role=dealer --table=ptable2 --players=pplayer2,pdealer2,pc-player --port=3000 > /tmp/dealer.log 2>&1 & sleep 3; cd /root/bet && node poker-server.mjs --local --role=player --id=pplayer2 --table=ptable2 --port=3001 > /tmp/player28.log 2>&1 &'

# 2. .59 player
ssh -p 2400 root@89.125.50.59 'cd /root/bet && node poker-server.mjs --local --role=player --id=pdealer2 --table=ptable2 --port=3001 > /tmp/player59.log 2>&1 &'

# 3. Local player
node poker-server.mjs --local --role=player --id=pc-player --table=ptable2 --port=3000 > /tmp/local-player.log 2>&1 &
```

## Fix Priority
1. **P2 (cards on .59)** — just deployed, verify with refresh
2. **P1 (status consistency)** — needs log + controls area to both show opponent actions
3. **P3 (Playwright)** — fix test to properly handle stale banners and timing
4. **P4 (hand count/chips)** — reset on new session
5. **P6 (fold spectating)** — verify board updates after fold
6. **P5 (phase text overlap)** — CSS fix

## Testing Approach
- Playwright 3-view test: open all 3 browsers
- After EACH action: screenshot all 3, verify pot/board/players match
- After fold: verify cards hidden, board still updates
- After settlement: verify banner shows then clears, next hand starts clean
- Run 20 hands minimum before declaring fixed
