/**
 * Playwright browser test — automates 4 players and verifies the game works
 * Installs: npm install playwright
 * Run: node test-browser.mjs
 */

import { chromium } from 'playwright';

const URL = 'https://46-225-132-28.sslip.io';
const PLAYERS = ['Alice', 'Bob', 'Charlie', 'Dave'];
const WAIT = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  const browser = await chromium.launch({ headless: true });
  const issues = [];
  let handsPlayed = 0;

  console.log('Starting 4 player browser test...');

  // Open 4 pages, one per player
  const pages = [];
  for (const name of PLAYERS) {
    const page = await browser.newPage();
    await page.goto(URL + '/player?name=' + name);
    pages.push({ name, page });
    console.log(`  ${name} connected`);
    await WAIT(500);
  }

  // Wait for all to join
  await WAIT(5000);

  // Check all players received 'Seated' log
  for (const { name, page } of pages) {
    const log = await page.textContent('#log');
    if (!log.includes('Seated')) {
      issues.push(`${name}: never received seat assignment`);
    }
  }

  // Play multiple hands
  for (let hand = 0; hand < 5; hand++) {
    console.log(`\n=== Hand ${hand + 1} ===`);

    // Wait for hand to start (cards dealt)
    await WAIT(4000);

    // Check each player has hole cards
    for (const { name, page } of pages) {
      const myCards = await page.$('#my-cards');
      const cardCount = await myCards.$$eval('.mc, .my-card', els => els.length);
      if (cardCount === 0) {
        // Check if player was eliminated
        const log = await page.textContent('#log');
        if (!log.includes('New Hand')) {
          issues.push(`Hand ${hand + 1}: ${name} has no cards and no new hand`);
        }
      } else if (cardCount !== 2) {
        issues.push(`Hand ${hand + 1}: ${name} has ${cardCount} hole cards (expected 2)`);
      } else {
        console.log(`  ${name}: has ${cardCount} hole cards`);
      }
    }

    // Check board has 5 empty slots
    const firstPage = pages[0].page;
    const boardCards = await firstPage.$$eval('#board .cd, #board .card', els => els.length);
    if (boardCards !== 5) {
      issues.push(`Hand ${hand + 1}: board has ${boardCards} slots (expected 5)`);
    }

    // Play through betting rounds — each player takes action when it's their turn
    for (let round = 0; round < 20; round++) { // Max 20 actions per hand
      let acted = false;

      for (const { name, page } of pages) {
        // Check if this player has action buttons
        const buttons = await page.$$('#ctrls button');
        if (buttons.length > 0) {
          // Get button labels
          const labels = [];
          for (const btn of buttons) {
            labels.push(await btn.textContent());
          }
          console.log(`  ${name}'s turn: ${labels.join(', ')}`);

          // Check: when no bet, should show "Bet" not "Raise"
          const hasBet = labels.some(l => l.includes('Bet'));
          const hasRaise = labels.some(l => l.includes('Raise'));
          const hasCall = labels.some(l => l.includes('Call'));

          if (hasCall && hasRaise) {
            // This is fine — there's a bet to call and can raise
          } else if (!hasCall && hasRaise) {
            issues.push(`Hand ${hand + 1}: ${name} has Raise button but no Call (should be Bet)`);
          }

          // Take a random action
          const action = pickAction(labels);
          console.log(`  ${name} -> ${action}`);

          if (action.includes('Fold')) {
            await page.click('button.bf');
          } else if (action.includes('Check')) {
            await page.click('button.bk');
          } else if (action.includes('Call')) {
            await page.click('button.bc');
          } else if (action.includes('Bet') || action.includes('Raise')) {
            await page.click('button.br');
          } else if (action.includes('All In')) {
            await page.click('button.ba');
          }

          acted = true;
          await WAIT(1000);
          break; // Only one player acts per round
        }
      }

      if (!acted) {
        // No player has buttons — either showdown or waiting
        const log = await firstPage.textContent('#log');
        if (log.includes('SHOWDOWN') || log.includes('next hand')) {
          console.log('  Hand complete');
          handsPlayed++;
          break;
        }
        // Check if all players show "Waiting"
        let allWaiting = true;
        for (const { page } of pages) {
          const ctrlText = await page.textContent('#ctrls');
          if (!ctrlText.includes('Waiting') && !ctrlText.includes('Showdown') && !ctrlText.includes('Starting')) {
            allWaiting = false;
          }
        }
        if (allWaiting) {
          await WAIT(2000);
        }
      }
    }

    // Check community cards at showdown
    const boardState = await firstPage.$$eval('#board .cd.f, #board .card.face', els => els.length);
    const logText = await firstPage.textContent('#log');

    if (logText.includes('SHOWDOWN') && boardState < 5) {
      // Only an issue if there are multiple players (not everyone folded)
      if (!logText.includes('folds') || logText.split('folds').length < PLAYERS.length) {
        issues.push(`Hand ${hand + 1}: showdown with only ${boardState} community cards`);
      }
    }

    // Check pot went to someone
    if (logText.includes('WINS')) {
      console.log('  Winner found');
    } else if (logText.includes('folds')) {
      console.log('  Won by fold');
    }

    // Wait for next hand
    await WAIT(6000);
  }

  // Final checks
  console.log('\n=== Final State ===');
  for (const { name, page } of pages) {
    const log = await page.textContent('#log');
    const chipText = await page.textContent('#my-section');
    console.log(`  ${name}: ${chipText.split('\\n')[0]}`);

    // Check for any JS errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    if (errors.length > 0) {
      issues.push(`${name}: JS errors: ${errors.join('; ')}`);
    }
  }

  // Report
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Hands played: ${handsPlayed}`);
  console.log(`Issues found: ${issues.length}`);
  for (const issue of issues) {
    console.log(`  BUG: ${issue}`);
  }
  if (issues.length === 0) {
    console.log('  No issues found!');
  }

  await browser.close();
  process.exit(issues.length > 0 ? 1 : 0);
}

function pickAction(labels) {
  // Smart action selection — mix of strategies
  const r = Math.random();
  const hasCheck = labels.some(l => l.includes('Check'));
  const hasCall = labels.some(l => l.includes('Call'));

  if (hasCheck) {
    // If can check: 60% check, 30% bet, 10% fold
    if (r < 0.6) return labels.find(l => l.includes('Check'));
    if (r < 0.9) return labels.find(l => l.includes('Bet') || l.includes('Raise')) || labels.find(l => l.includes('Check'));
    return labels.find(l => l.includes('Fold')) || labels[0];
  } else if (hasCall) {
    // If must call: 50% call, 20% raise, 30% fold
    if (r < 0.5) return labels.find(l => l.includes('Call'));
    if (r < 0.7) return labels.find(l => l.includes('Raise')) || labels.find(l => l.includes('Call'));
    return labels.find(l => l.includes('Fold')) || labels[0];
  }
  return labels[0];
}

run().catch(e => { console.error(e); process.exit(1); });
