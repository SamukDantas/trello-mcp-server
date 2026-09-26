import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cardId = 'c'.repeat(24);
const longDescription = '# Requisitos\n\n' + '- Ação com acentos e emoji 🚀: **preservar Markdown**\n'.repeat(300) + '\n[Fim da descrição](https://example.com)';

for (const [label, description] of [
  ['longa com Markdown, Unicode e quebras de linha', longDescription],
  ['curta', 'Descrição curta.'],
  ['exatamente 100 caracteres', 'x'.repeat(100)],
  ['vazia', ''],
]) {
  test(`detalhes retornam a descrição integral: ${label}`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trello-description-'));
    const log = path.join(dir, 'requests.jsonl');
    fs.writeFileSync(log, '');
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', pathToFileURL(path.resolve('tests/fixtures/mock-trello.mjs')).href, 'dist/index.js'],
      env: { ...process.env, TRELLO_TEST_LOG: log, TRELLO_TEST_DESCRIPTION: description }, stderr: 'pipe' });
    const client = new Client({ name: 'description-test', version: '1' });
    t.after(async () => { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.match(tools.find(tool => tool.name === 'trello_get_card_details').description, /descrição completa, sem truncamento/);
    for (const selector of [{ cardId }, { cardName: 'Pedido 1' }]) {
      const result = await client.callTool({ name: 'trello_get_card_details', arguments: selector });
      assert.ok(!result.isError);
      const text = result.content[0].text;
      assert.ok(text.includes(description
        ? `📄 Descrição completa:\n${description}\n\n🔗`
        : '📄 Descrição: (vazia)\n🔗'), 'A descrição deve ser devolvida integralmente, sem reticências acrescentadas');
      assert.ok(text.includes(cardId));
      assert.ok(text.includes('https://trello.com/c/fake'));
    }
    const requests = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(requests.every(request => request.method === 'GET'), 'A leitura não deve alterar o Trello');
    if (description === longDescription) {
      const result = await client.callTool({ name: 'trello_create_card', arguments: {
        name: 'Novo pedido', listId: '1'.repeat(24), desc: description,
      } });
      assert.ok(!result.isError);
      assert.ok(result.content[0].text.includes(`📄 Descrição completa:\n${description}\n\n`));
      const writes = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(request => request.method !== 'GET');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].body.desc, description);
    }
  });
}
