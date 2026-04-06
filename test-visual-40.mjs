#!/usr/bin/env node
import { chromium } from 'playwright';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ ignoreHTTPSErrors: true });
  const local = await ctx.newPage();
  const p28 = await ctx.newPage();
  const p59 = await ctx.newPage();
  for (const p of [local, p28, p59]) await p.setViewportSize({ width: 900, height: 600 });
  await local.goto('http://localhost:3000', { waitUntil: 'load' });
  await p28.goto('http://46.225.132.28:3001', { waitUntil: 'load' });
  await p59.goto('https://verus.cx/poker/', { waitUntil: 'load' });
  await sleep(5000);

  const P = [['local', local], ['p28', p28], ['p59', p59]];
  let issues = [], acts = { local: 0, p28: 0, p59: 0 }, reloads = 0;
  function getHandNum(text) { const m = (text || '').match(/\d+/); return m ? parseInt(m[0]) : 0; }

  for (let h = 1; h <= 40; h++) {
    process.stdout.write('H' + h + ': ');

    // Handle busted + wait for buttons
    let gotButtons = false;
    while (!gotButtons) {
      for (const [n, pg] of P) {
        const ctrl = await pg.$eval('#controls', e => e.textContent.trim()).catch(() => '');
        if (ctrl.includes('Out of chips')) {
          await pg.click('#controls button').catch(() => {});
          await sleep(3000);
          const sit = await pg.$('#controls button');
          if (sit) { const t = await sit.textContent().catch(() => ''); if (t.includes('Sit In')) { await sit.click().catch(() => {}); reloads++; } }
          continue;
        }
        const btns = await pg.$$eval('#controls button', b => b.map(x => x.textContent.trim())).catch(() => []);
        if (btns.length > 0 && !btns[0].includes('Reload') && !btns[0].includes('Sit In')) { gotButtons = true; break; }
      }
      if (!gotButtons) await sleep(2000);
    }

    const startHand = getHandNum(await local.$eval('#ti-hand', e => e.textContent).catch(() => ''));

    // CHECKS at hand start
    for (const [n, pg] of P) {
      const s = await pg.evaluate(() => ({
        banner: document.getElementById('winner-banner')?.style.display !== 'none',
        undef: [...document.querySelectorAll('.seat')].some(s => s.textContent.includes('undefined')),
      })).catch(() => ({}));
      if (s.banner) issues.push('H' + h + ' ' + n + ': stale banner');
      if (s.undef) issues.push('H' + h + ' ' + n + ': undefined in seat');
    }

    // Play random actions
    for (let a = 0; a < 20; a++) {
      let anyButtons = false;
      for (const [n, pg] of P) {
        const btns = await pg.$$eval('#controls button', b => b.map(x => x.textContent.trim())).catch(() => []);
        if (btns.length > 0 && !btns[0].includes('Reload') && !btns[0].includes('Sit In')) {
          anyButtons = true;
          const rnd = Math.random();
          let btn;
          if (rnd < 0.35) btn = await pg.$('button.btn-check') || await pg.$('button.btn-call');
          else if (rnd < 0.55) btn = await pg.$('button.btn-fold');
          else if (rnd < 0.8) btn = await pg.$('button.btn-raise') || await pg.$('button.btn-check');
          else btn = await pg.$('button.btn-allin') || await pg.$('button.btn-call');
          if (!btn) btn = await pg.$('#controls button');
          if (btn) { await btn.click().catch(() => {}); acts[n]++; }
          await sleep(800);
        }
      }
      if (!anyButtons) break; // No buttons on any page — hand probably ended
      await sleep(1000);
    }

    // Wait for hand to end — poll until hand count changes (max 60s)
    let done = false;
    for (let i = 0; i < 30; i++) {
      const curHand = getHandNum(await local.$eval('#ti-hand', e => e.textContent).catch(() => ''));
      const banner = await local.evaluate(() => document.getElementById('winner-banner')?.style.display !== 'none').catch(() => false);
      const phase = await local.$eval('#hand-info', e => e.textContent).catch(() => '');
      if (curHand > startHand || banner || phase === 'settled') { done = true; break; }
      await sleep(2000);
    }

    // Check log for undefined
    const logUndef = await local.evaluate(() => {
      const log = document.getElementById('action-log');
      return log ? [...log.querySelectorAll('div')].some(d => d.textContent.includes('undefined')) : false;
    }).catch(() => false);
    if (logUndef) issues.push('H' + h + ': undefined in log');

    console.log(done ? 'ok' : 'TIMEOUT');
    if (!done) issues.push('H' + h + ': hand never ended');

    if (issues.length > 0) {
      console.log('\nSTOPPED at hand ' + h + ':');
      issues.forEach(i => console.log('  ' + i));
      await local.screenshot({ path: '/tmp/v40-stopped.png' });
      break;
    }
    if (h % 10 === 0) await local.screenshot({ path: '/tmp/v40-h' + h + '.png' });
    await sleep(10000);
  }

  console.log('\n══════════════════');
  if (issues.length === 0) console.log('40/40 — NO VISUAL ISSUES');
  else { console.log(issues.length + ' issues'); issues.forEach(i => console.log('  ' + i)); }
  console.log('Actions: local=' + acts.local + ' p28=' + acts.p28 + ' p59=' + acts.p59 + ' Reloads: ' + reloads);
  await b.close();
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
