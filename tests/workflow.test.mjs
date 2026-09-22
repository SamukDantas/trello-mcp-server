import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const boardId = 'a'.repeat(24), cardId = 'c'.repeat(24), listId = '2'.repeat(24);
test('operações genéricas no servidor completo, com API e configuração simuladas', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trello-workflow-'));
  const log = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(log, '');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', pathToFileURL(path.resolve('tests/fixtures/mock-trello.mjs')).href, 'dist/index.js'],
    env: { ...process.env, TRELLO_TEST_LOG: log }, stderr: 'pipe' });
  const client = new Client({ name: 'generic-test', version: '1' });
  t.after(async () => { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const requests = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const clear = () => fs.writeFileSync(log, '');
  const writes = () => requests().filter(r => r.method !== 'GET');
  async function check(name, action) { await t.test(name, async () => { clear(); await action(); }); }

  for (const tool of ['trello_move_card', 'trello_next']) {
    await check(`${tool}: destino explícito e sem etiquetas`, async () => {
      assert.ok(!(await call(tool, { cardId, listName: 'Análise comercial' })).isError);
      assert.deepEqual(writes(), [{ endpoint: `/cards/${cardId}`, method: 'PUT', body: { idList: listId, idBoard: boardId } }]);
    });
    await check(`${tool}: sem destino não altera nada`, async () => {
      assert.equal((await call(tool, { cardId })).isError, true);
      assert.equal(writes().length, 0);
    });
  }
  for (const tool of ['trello_done', 'trello_mark_card_complete', 'trello_mark_due_complete']) {
    for (const complete of [true, false]) await check(`${tool}: complete=${complete} sem data, movimento ou comentário`, async () => {
      assert.ok(!(await call(tool, { cardId, complete })).isError);
      assert.deepEqual(writes(), [{ endpoint: `/cards/${cardId}`, method: 'PUT', body: { dueComplete: complete } }]);
    });
  }
  for (const [tool, params] of [['trello_create', { title: 'Novo pedido' }], ['trello_create_card', { name: 'Novo pedido' }]]) {
    await check(`${tool}: exige destino`, async () => {
      assert.equal((await call(tool, params)).isError, true);
      assert.equal(writes().length, 0);
    });
    await check(`${tool}: cria sem listas/labels na configuração`, async () => {
      assert.ok(!(await call(tool, { ...params, listId })).isError);
      assert.deepEqual(writes(), [{ endpoint: '/cards', method: 'POST', body: { name: 'Novo pedido', idList: listId } }]);
    });
  }
  await check('Testing urgente não vira Testing', async () => {
    assert.ok(!(await call('trello_update_card', { cardId, listName: 'Testing urgente' })).isError);
    assert.equal(writes()[0].body.idList, '4'.repeat(24));
  });
  await check('mover + limpar vencimento preserva todas as alterações', async () => {
    assert.ok(!(await call('trello_update_card', { cardId, listId, due: 'remove', dueComplete: true })).isError);
    assert.deepEqual(writes()[0].body, { due: null, dueComplete: true, idList: listId, idBoard: boardId });
  });
  for (const tool of ['trello_move_card', 'trello_update_card', 'trello_create_card', 'trello_list_cards_in_list', 'trello_list_pending_backlog_tasks', 'trello_archive_all_cards', 'trello_delete_all_cards', 'trello_update_list', 'trello_delete_list']) {
    for (const listName of ['Repetida', 'Test', 'doing']) await check(`${tool}: rejeita lista ambígua/parcial/inexistente ${listName}`, async () => {
      assert.equal((await call(tool, { cardId, name: 'Novo', newName: 'Novo nome', listName, confirm: true })).isError, true);
      assert.equal(writes().length, 0);
    });
  }
  await check('ID distingue listas com o mesmo nome', async () => {
    assert.ok(!(await call('trello_move_card', { cardId, listId: '6'.repeat(24) })).isError);
    assert.equal(writes()[0].body.idList, '6'.repeat(24));
  });
  await check('ID e nome conflitantes não selecionam lista arbitrariamente', async () => {
    assert.equal((await call('trello_move_card', { cardId, listId, listName: 'Triagem' })).isError, true);
    assert.equal(writes().length, 0);
  });
  for (const tool of ['trello_archive_all_cards', 'trello_delete_all_cards']) await check(`${tool}: filtro exato restringe o lote`, async () => {
    assert.ok(!(await call(tool, { listName: 'Testing urgente', confirm: true })).isError);
    assert.deepEqual(writes().map(r => r.endpoint), [`/cards/${'d'.repeat(24)}`, `/cards/${'e'.repeat(24)}`]);
  });
  for (const tool of ['trello_archive_all_cards', 'trello_delete_all_cards']) await check(`${tool}: preserva confirmação`, async () => {
    await call(tool, { listId, confirm: false });
    assert.equal(writes().length, 0);
  });
  await check('atalho de listagem não filtra etiqueta', async () => {
    const response = await call('trello_list_pending_backlog_tasks', { listId: '1'.repeat(24) });
    assert.ok(!response.isError);
    assert.match(response.content[0].text, /Pedido 1/);
  });
  await check('card de nome repetido não é movido arbitrariamente', async () => {
    assert.equal((await call('trello_update_card', { cardName: 'Repetido', listId })).isError, true);
    assert.equal(writes().length, 0);
  });
  await check('status exige card e lê a API', async () => {
    assert.equal((await call('trello_status', {})).isError, true);
    assert.ok(!(await call('trello_status', { cardId })).isError);
    assert.equal(requests().at(-1).endpoint, `/cards/${cardId}`);
  });
  await check('quadro ativo define as listas disponíveis sem fallback ao padrão', async () => {
    await call('trello_set_board', { boardUrl: 'Atendimento' });
    assert.ok(!(await call('trello_move_card', { cardId, listName: 'Recepção' })).isError);
    assert.deepEqual(writes()[0].body, { idList: '7'.repeat(24), idBoard: 'b'.repeat(24) });
    clear();
    assert.equal((await call('trello_create_card', { name: 'Pedido', listName: 'Triagem' })).isError, true);
    assert.equal(writes().length, 0);
  });
});
