import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPlatformTools } from '../dist/platform-tools.js';

const cardId = 'a'.repeat(24), boardId = 'b'.repeat(24), customFieldId = 'c'.repeat(24), optionId = 'd'.repeat(24);
async function setup(t, type = 'text', override) {
  const calls = [];
  const server = new McpServer({ name: 'test', version: '1' });
  registerPlatformTools(server, {
    async resolveBoard(input) { calls.push({ board: input }); return boardId; },
    async request(endpoint, method = 'GET', body) {
      calls.push({ endpoint, method, body });
      if (override) return override(endpoint, method, body);
      if (endpoint === `/cards/${cardId}?fields=idBoard`) return { idBoard: boardId };
      if (endpoint === `/customFields/${customFieldId}`) return { id: customFieldId, idModel: boardId, type, options: [{ id: optionId }] };
      return {};
    },
  });
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  return { calls, client, call: (name, args) => client.callTool({ name, arguments: args }) };
}

test('registra sete ferramentas e expõe os schemas pelo MCP', async t => {
  const { client } = await setup(t);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 7);
  assert.equal(new Set(tools.map(tool => tool.name)).size, 7);
  assert.ok(tools.every(tool => tool.inputSchema.type === 'object'));
});

for (const [type, value, body] of [
  ['text', 'Versão 2', { value: { text: 'Versão 2' } }],
  ['number', 0, { value: { number: '0' } }],
  ['checkbox', false, { value: { checked: 'false' } }],
  ['date', '2026-09-22T08:00:00-04:00', { value: { date: '2026-09-22T12:00:00.000Z' } }],
  ['list', optionId, { idValue: optionId }],
  ['text', null, { idValue: '', value: '' }],
  ['list', null, { idValue: '', value: '' }],
]) test(`serialização ${type} (${value})`, async t => {
  const ctx = await setup(t, type);
  const response = await ctx.call('trello_set_card_custom_field', { cardId, customFieldId, value });
  assert.ok(!response.isError);
  assert.deepEqual(ctx.calls.at(-1), { endpoint: `/cards/${cardId}/customField/${customFieldId}/item`, method: 'PUT', body });
});

for (const [type, value] of [['number', '12'], ['checkbox', 'false'], ['list', 'unknown'], ['date', 'tomorrow'], ['text', true]]) {
  test(`rejeita valor incompatível: ${type}`, async t => {
    const ctx = await setup(t, type);
    const response = await ctx.call('trello_set_card_custom_field', { cardId, customFieldId, value });
    assert.equal(response.isError, true);
    assert.ok(ctx.calls.every(call => call.method !== 'PUT'));
  });
}

test('rejeita campo de outro quadro antes de escrever', async t => {
  const ctx = await setup(t, 'text', endpoint => endpoint.includes('fields=idBoard') ? { idBoard: boardId } : { idModel: 'other', type: 'text' });
  assert.equal((await ctx.call('trello_set_card_custom_field', { cardId, customFieldId, value: 'x' })).isError, true);
  assert.ok(ctx.calls.every(call => call.method !== 'PUT'));
});

test('rejeita IDs inválidos no protocolo antes de consultar a API', async t => {
  const ctx = await setup(t);
  assert.equal((await ctx.call('trello_set_card_archived', { cardId: '../bad', archived: true })).isError, true);
  assert.equal(ctx.calls.length, 0);
});

test('cria dropdown no quadro escolhido com opções nativas', async t => {
  const ctx = await setup(t);
  assert.ok(!(await ctx.call('trello_create_custom_field', { boardUrl: 'Projeto', name: 'Prioridade', type: 'list', options: ['Alta', 'Baixa'] })).isError);
  assert.deepEqual(ctx.calls[0], { board: 'Projeto' });
  assert.deepEqual(ctx.calls[1], { endpoint: '/customFields', method: 'POST', body: {
    idModel: boardId, modelType: 'board', name: 'Prioridade', type: 'list', pos: 'bottom',
    options: [{ value: { text: 'Alta' }, pos: 16384 }, { value: { text: 'Baixa' }, pos: 32768 }],
  } });
});

for (const args of [{ type: 'list' }, { type: 'text', options: ['x'] }, { type: 'list', options: ['Alta', 'alta'] }]) {
  test(`rejeita opções inconsistentes ${JSON.stringify(args)}`, async t => {
    const ctx = await setup(t);
    assert.equal((await ctx.call('trello_create_custom_field', { name: 'Campo', ...args })).isError, true);
    assert.equal(ctx.calls.length, 0);
  });
}

test('leitura combina nomes, opções e campos ainda vazios', async t => {
  const ctx = await setup(t, 'list', endpoint => {
    if (endpoint.includes('fields=idBoard')) return { idBoard: boardId };
    if (endpoint.endsWith('/customFields')) return [
      { id: customFieldId, name: 'Prioridade', type: 'list', options: [{ id: optionId, value: { text: 'Alta' } }] },
      { id: 'empty', name: 'Versão', type: 'text' },
    ];
    return [{ idCustomField: customFieldId, idValue: optionId }];
  });
  const response = await ctx.call('trello_get_card_custom_fields', { cardId });
  assert.deepEqual(JSON.parse(response.content[0].text), [
    { id: customFieldId, name: 'Prioridade', type: 'list', value: 'Alta', optionId },
    { id: 'empty', name: 'Versão', type: 'text', value: null },
  ]);
});

for (const [tool, key, apiKey] of [['trello_set_card_archived', 'archived', 'closed'], ['trello_set_card_subscription', 'subscribed', 'subscribed']]) {
  for (const value of [true, false]) test(`${tool}=${value}`, async t => {
    const ctx = await setup(t);
    assert.ok(!(await ctx.call(tool, { cardId, [key]: value })).isError);
    assert.deepEqual(ctx.calls, [{ endpoint: `/cards/${cardId}`, method: 'PUT', body: { [apiKey]: value } }]);
  });
}

for (const [tool, path] of [['trello_list_custom_fields', 'customFields'], ['trello_list_archived_cards', 'cards?filter=closed&fields=name,idList,shortUrl,closed']]) {
  test(`${tool} usa o resolvedor de quadro ativo`, async t => {
    const ctx = await setup(t);
    assert.ok(!(await ctx.call(tool, {})).isError);
    assert.deepEqual(ctx.calls[0], { board: undefined });
    assert.equal(ctx.calls[1].endpoint, `/boards/${boardId}/${path}`);
  });
}

test('falha da API é um erro MCP, sem mensagem de sucesso', async t => {
  const ctx = await setup(t, 'text', () => { throw new Error('Trello API error: 403 Forbidden'); });
  const response = await ctx.call('trello_set_card_archived', { cardId, archived: true });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /403/);
});
