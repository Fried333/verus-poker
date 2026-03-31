/**
 * RPC integration test — requires a running CHIPS daemon
 * Run: node test-rpc.mjs <rpc_user> <rpc_pass> [host] [port]
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, VDXF_KEYS, publishTable, readTable } from './verus-rpc.mjs';

const user = process.argv[2] || '';
const pass = process.argv[3] || '';
const host = process.argv[4] || '127.0.0.1';
const port = parseInt(process.argv[5] || '22778');

const client = createClient({ host, port, user, pass });

describe('Verus RPC Client', () => {

  it('getInfo returns chain data', async () => {
    const info = await client.getInfo();
    assert.ok(info.blocks > 0);
    assert.ok(info.name);
    console.log(`  Chain: ${info.name}, Block: ${info.blocks}`);
  });

  it('getBlockCount returns number', async () => {
    const count = await client.getBlockCount();
    assert.ok(typeof count === 'number');
    assert.ok(count > 0);
  });

  it('getBalance returns number', async () => {
    const bal = await client.getBalance();
    assert.ok(typeof bal === 'number');
    console.log(`  Wallet balance: ${bal}`);
  });

  it('listIdentities returns array', async () => {
    const ids = await client.listIdentities();
    assert.ok(Array.isArray(ids));
    console.log(`  Identities in wallet: ${ids.length}`);
    for (const id of ids) {
      console.log(`    ${id.identity.name}`);
    }
  });

  it('getIdentity for poker-dealer', async () => {
    try {
      const id = await client.getIdentity('poker-dealer.CHIPS@');
      assert.ok(id.identity);
      console.log(`  poker-dealer address: ${id.identity.primaryaddresses[0]}`);
    } catch (e) {
      console.log(`  poker-dealer not found: ${e.message}`);
    }
  });

  it('canSignFor poker-dealer', async () => {
    const can = await client.canSignFor('poker-dealer.CHIPS@');
    console.log(`  Can sign for poker-dealer: ${can}`);
  });
});
