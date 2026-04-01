/**
 * Playwright Browser Test — real browser testing of poker UI
 * Uses playwright from /home/dev/Desktop/llm/node_modules/playwright
 */

import { chromium } from '/home/dev/Desktop/llm/node_modules/playwright/index.mjs';
import { spawn } from 'child_process';

const PORT = 3011;
const WAIT = ms => new Promise(r => setTimeout(r, ms));
let server;
let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL: ' + msg); }
}

async function main() {
  // Start server
  console.log('Starting poker server on port ' + PORT + '...');
  server = spawn('node', ['poker-server.mjs', '--port=' + PORT], { stdio: ['pipe', 'pipe', 'pipe'] });
  let ready = false;
  server.stdout.on('data', d => { if (d.toString().includes('Verus Poker')) ready = true; });
  server.stderr.on('data', d => {});
  for (let i = 0; i < 20; i++) { if (ready) break; await WAIT(500); }
  if (!ready) { console.log('FAIL: Server did not start'); process.exit(1); }
  console.log('Server ready\n');

  // Launch browser
  const browser = await chromium.launch({ headless: true });

  // Open 2 pages (2 players)
  const page1 = await browser.newPage();
  const page2 = await browser.newPage();

  await page1.goto('http://localhost:' + PORT + '/play?name=Alice');
  await page2.goto('http://localhost:' + PORT + '/play?name=Bob');
  await WAIT(3000);

  // ══════════════════════════════
  console.log('TEST 1: Pages loaded');
  const title1 = await page1.title();
  const title2 = await page2.title();
  assert(title1.includes('Poker'), 'Alice page loaded');
  assert(title2.includes('Poker'), 'Bob page loaded');

  // ══════════════════════════════
  console.log('\nTEST 2: Wait for cards');
  await WAIT(12000); // Wait for hand to start (8s timer + deal)
  const cards1 = await page1.evaluate(() => typeof myCards !== 'undefined' ? myCards.join(',') : '');
  const cards2 = await page2.evaluate(() => typeof myCards !== 'undefined' ? myCards.join(',') : '');
  assert(cards1.length > 0, 'Alice has cards: ' + cards1);
  assert(cards2.length > 0, 'Bob has cards: ' + cards2);

  // No duplicates
  if (cards1 && cards2) {
    const all = [...cards1.split(','), ...cards2.split(',')];
    assert(new Set(all).size === all.length, 'No duplicate hole cards');
  }

  // ══════════════════════════════
  console.log('\nTEST 3: Chips displayed');
  const chipsText = await page1.evaluate(() => document.getElementById('my-chips')?.textContent || '');
  assert(chipsText.includes('chips'), 'Chips shown: ' + chipsText);

  // Check seat chip display
  const seatChips = await page1.evaluate(() => {
    const els = document.querySelectorAll('.seat-chips');
    return [...els].map(e => e.textContent).filter(t => t.length > 0);
  });
  assert(seatChips.length >= 2, 'Seat chips visible: ' + seatChips.join(', '));

  // ══════════════════════════════
  console.log('\nTEST 4: Play hand — auto check/call');
  for (let round = 0; round < 30; round++) {
    await WAIT(1000);
    // Click check/call on both pages
    for (const page of [page1, page2]) {
      const checkBtn = await page.$('button.btn-check');
      if (checkBtn) { await checkBtn.click(); continue; }
      const callBtn = await page.$('button.btn-call');
      if (callBtn) { await callBtn.click(); continue; }
    }
    // Check if verified
    const verText = await page1.evaluate(() => document.getElementById('ti-verify')?.textContent || '');
    if (verText.includes('Verified') || verText.includes('✓')) break;
  }

  // ══════════════════════════════
  console.log('\nTEST 5: Settlement');
  await WAIT(2000);
  const verText = await page1.evaluate(() => document.getElementById('ti-verify')?.textContent || '');
  assert(verText.includes('Verified') || verText.includes('✓'), 'Verified: ' + verText);

  // Winner banner
  const bannerVisible = await page1.evaluate(() => document.getElementById('winner-banner')?.style.display !== 'none');
  const bannerText = await page1.evaluate(() => document.getElementById('winner-banner')?.textContent || '');
  console.log('    Banner visible: ' + bannerVisible + ' text: ' + bannerText.substring(0, 60));

  // ══════════════════════════════
  console.log('\nTEST 6: Board cards');
  const boardCards = await page1.evaluate(() => {
    const board = document.getElementById('board');
    return board ? board.children.length : 0;
  });
  console.log('    Board card elements: ' + boardCards);

  // ══════════════════════════════
  console.log('\nTEST 7: Table clears after settlement');
  await WAIT(6000); // Wait for 4s clear + buffer
  const cardsAfter = await page1.evaluate(() => typeof myCards !== 'undefined' ? myCards.join(',') : '');
  assert(cardsAfter === '', 'Cards cleared: "' + cardsAfter + '"');

  const boardAfter = await page1.evaluate(() => {
    const board = document.getElementById('board');
    return board ? board.children.length : 0;
  });
  assert(boardAfter === 0, 'Board cleared: ' + boardAfter + ' cards');

  // ══════════════════════════════
  console.log('\nTEST 8: Chip conservation');
  const chipData = await page1.evaluate(() => {
    if (!st || !st.players) return null;
    return st.players.filter(p => !p.empty).map(p => ({ id: p.id || p.name, chips: p.chips }));
  });
  if (chipData) {
    const total = chipData.reduce((s, p) => s + p.chips, 0);
    assert(total === 400, 'Chips conserved: ' + total);
    chipData.forEach(p => console.log('    ' + p.id + ': ' + p.chips));
  } else {
    assert(false, 'Could not read chip data');
  }

  // ══════════════════════════════
  console.log('\nTEST 9: Reconnect mid-hand');
  // Wait for next hand to start
  await WAIT(15000);
  const cardsBeforeRefresh = await page1.evaluate(() => typeof myCards !== 'undefined' ? myCards.join(',') : '');
  if (cardsBeforeRefresh) {
    // Refresh page
    await page1.reload();
    await WAIT(3000);
    const cardsAfterRefresh = await page1.evaluate(() => typeof myCards !== 'undefined' ? myCards.join(',') : '');
    assert(cardsAfterRefresh === cardsBeforeRefresh, 'Cards restored after refresh: ' + cardsAfterRefresh);
  } else {
    console.log('    (skipped — no hand in progress)');
  }

  // ══════════════════════════════
  console.log('\n═══════════════════════════');
  console.log(passed + ' passed, ' + failed + ' failed');
  console.log(failed === 0 ? 'ALL TESTS PASS' : 'SOME TESTS FAILED');

  await browser.close();
  server.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  if (server) server.kill();
  process.exit(1);
});
