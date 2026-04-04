import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

const urls = ['http://localhost:3000', 'http://46.225.132.28:3001', 'https://verus.cx/poker/'];
for (let i = 0; i < urls.length; i++) {
  const url = urls[i];
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => logs.push('ERROR: ' + e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 10000 }).catch(e => logs.push('LOAD FAIL: ' + e.message));
  await new Promise(r => setTimeout(r, 4000));
  const seats = await page.$$eval('.seat', s => s.length).catch(() => -1);
  const btns = await page.$$eval('#controls button', b => b.map(x => x.textContent.trim())).catch(() => []);
  const ctrl = await page.$eval('#controls', e => e.textContent.trim().substring(0, 80)).catch(() => '?');
  console.log('\n' + url + ':');
  console.log('  seats=' + seats + ' buttons=[' + btns.join(',') + '] ctrl="' + ctrl + '"');
  console.log('  console logs:');
  logs.forEach(l => console.log('    ' + l));
  await page.screenshot({ path: '/tmp/debug-' + i + '.png' });
}
await browser.close();
process.exit(0);
