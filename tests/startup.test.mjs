import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('servidor completo inicializa via stdio e anuncia as 79 ferramentas', async t => {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], stderr: 'pipe' });
  const client = new Client({ name: 'smoke-test', version: '1' });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 79);
  assert.equal(new Set(tools.map(tool => tool.name)).size, 79);
  for (const name of ['trello_next', 'trello_update_card', 'trello_set_card_custom_field', 'trello_set_card_archived', 'trello_set_card_subscription']) {
    assert.ok(tools.some(tool => tool.name === name), name);
  }
});
