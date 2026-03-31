/**
 * Live RPC test against the CHIPS daemon on the test server.
 * ONE call at a time. No flooding.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from './verus-rpc.mjs';

const client = createClient({
  host: '127.0.0.1',
  port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
});

describe('Live RPC', () => {

  it('getBlockCount', async () => {
    const count = await client.getBlockCount();
    assert.ok(count > 3600000);
    console.log(`  Block: ${count}`);
  });

  it('getInfo', async () => {
    const info = await client.getInfo();
    assert.equal(info.name, 'CHIPS');
    console.log(`  Chain: ${info.name}, Blocks: ${info.blocks}`);
  });

  it('getBalance', async () => {
    const bal = await client.getBalance();
    assert.ok(typeof bal === 'number');
    console.log(`  Balance: ${bal}`);
  });

  it('listIdentities', async () => {
    const ids = await client.listIdentities();
    assert.ok(ids.length >= 6);
    const names = ids.map(i => i.identity.name);
    console.log(`  IDs: ${names.join(', ')}`);
    assert.ok(names.includes('poker-dealer'));
    assert.ok(names.includes('poker-p1'));
  });

  it('getIdentity poker-dealer', async () => {
    const id = await client.getIdentity('poker-dealer.CHIPS@');
    assert.ok(id.identity.primaryaddresses.length > 0);
    console.log(`  poker-dealer addr: ${id.identity.primaryaddresses[0]}`);
  });
});
