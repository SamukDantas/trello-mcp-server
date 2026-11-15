import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const id = char => char.repeat(24);
const board = id('a'), other = id('b'), card = id('c'), member = id('9');
const bug = id('7'), debug = id('8');

async function start(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trello-fixes-'));
  const log = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(log, '');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', pathToFileURL(path.resolve('tests/fixtures/mock-trello-fixes.mjs')).href, 'dist/index.js'],
    env: { ...process.env, TRELLO_TEST_LOG: log, ...env }, stderr: 'pipe' });
  const client = new Client({ name: 'fixes-test', version: '1' });
  t.after(async () => { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await client.connect(transport);
  const requests = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {
    client,
    call: (name, args) => client.callTool({ name, arguments: args }),
    requests,
    writes: () => requests().filter(r => r.method !== 'GET').map(({ endpoint, method, body }) => ({ endpoint, method, ...(body === undefined ? {} : { body }) })),
    clear: () => fs.writeFileSync(log, ''),
  };
}
const text = result => result.content.map(item => item.text).join('\n');

test('correções de bugs e segurança no servidor completo', async t => {
  const { client, call, requests, writes, clear } = await start(t);
  async function check(name, action) { await t.test(name, async () => { clear(); await action(); }); }
  const rejected = async (tool, args) => {
    const result = await call(tool, args);
    assert.equal(result.isError, true, `${tool} deveria falhar`);
    assert.equal(writes().length, 0, `${tool} não deveria escrever no Trello`);
    return result;
  };

  await check('anuncia 78 ferramentas e não oferece mais a automação que nada criava', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 78);
    assert.ok(!tools.some(tool => tool.name === 'trello_create_automation'));
  });

  await check('todo parâmetro de ID declara o formato aceito', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        if (/Id$/.test(name)) assert.ok(schema.pattern, `${tool.name}.${name} sem validação de formato`);
        if (/Ids$/.test(name)) assert.ok(schema.items?.pattern, `${tool.name}.${name} sem validação de formato`);
      }
    }
  });

  await check('credenciais vão no cabeçalho Authorization, nunca na URL', async () => {
    assert.ok(!(await call('trello_list_lists', {})).isError);
    assert.ok(!(await call('trello_upload_attachment', { cardId: card, fileUrl: 'https://example.com/a.pdf' })).isError);
    assert.ok(!(await call('trello_remove_due_date', { cardId: id('3') })).isError);
    assert.ok(requests().length >= 3);
    for (const request of requests()) {
      assert.equal(request.auth, 'OAuth oauth_consumer_key="fakekey", oauth_token="faketoken"');
      assert.doesNotMatch(request.query, /key=|token=|fake/);
    }
  });

  for (const [tool, args] of [
    ['trello_delete_card', { cardId: `../boards/${board}` }],
    ['trello_get_card_details', { cardId: `${card}?closed=true` }],
    ['trello_move_card', { cardId: '../boards/x', listId: id('1') }],
    ['trello_delete_webhook', { webhookId: 'a/b' }],
    ['trello_update_card', { cardId: card, labelIds: ['x&y=1'] }],
    ['trello_remove_card_member', { cardId: card, memberId: `${member}/../..` }],
  ]) {
    await check(`${tool}: ID malformado não chega à API`, async () => {
      await rejected(tool, args);
      assert.equal(requests().length, 0);
    });
  }

  await check('trello_delete_card: nome parcial ou repetido não exclui nada', async () => {
    await rejected('trello_delete_card', { cardName: 'Pedido' });
    await rejected('trello_delete_card', { cardName: 'Repetido' });
  });
  await check('trello_delete_card: nome exato exclui somente aquele card', async () => {
    assert.ok(!(await call('trello_delete_card', { cardName: 'pedido 1' })).isError);
    assert.deepEqual(writes(), [{ endpoint: `/cards/${card}`, method: 'DELETE' }]);
  });
  await check('trecho do nome serve quando identifica um único card', async () => {
    assert.ok(!(await call('trello_add_comment', { cardName: 'Pedido', text: 'oi' })).isError);
    assert.deepEqual(writes(), [{ endpoint: `/cards/${card}/actions/comments`, method: 'POST', body: { text: 'oi' } }]);
  });
  await check('nome ambíguo é recusado e lista os candidatos com ID', async () => {
    const result = await rejected('trello_add_comment', { cardName: 'Repetido', text: 'oi' });
    assert.match(text(result), new RegExp(id('d')));
    assert.match(text(result), new RegExp(id('e')));
  });

  await check('trello_delete_board: exclusão permanente exige confirm', async () => {
    await rejected('trello_delete_board', { boardId: board, permanent: true });
    assert.equal(requests().length, 0);
  });
  await check('trello_delete_board: exclusão permanente por nome exige o nome exato', async () => {
    await rejected('trello_delete_board', { boardName: 'Filial', permanent: true, confirm: true });
    assert.ok(!(await call('trello_delete_board', { boardName: 'Loja', permanent: true, confirm: true })).isError);
    assert.deepEqual(writes(), [{ endpoint: `/boards/${board}`, method: 'DELETE' }]);
  });
  await check('trello_delete_board: sem permanent apenas arquiva, e recusa nome ambíguo', async () => {
    await rejected('trello_delete_board', { boardName: 'Loj' });
    assert.ok(!(await call('trello_delete_board', { boardName: 'Filial' })).isError);
    assert.deepEqual(writes(), [{ endpoint: `/boards/${other}`, method: 'PUT', body: { closed: true } }]);
  });

  await check('trello_create_board: prefs sem visibility não quebra e usa os nomes da API', async () => {
    assert.ok(!(await call('trello_create_board', { name: 'Novo', prefs: { votingEnabled: true } })).isError);
    assert.ok(!(await call('trello_create_board', { name: 'Novo', prefs: { visibility: 'team', commentsEnabled: false } })).isError);
    const [first, second] = requests().filter(r => r.method === 'POST');
    assert.equal(first.query, '?prefs_voting=members');
    assert.equal(second.query, '?prefs_permissionLevel=org&prefs_comments=disabled');
    assert.ok(!('prefs' in first.body) && !('prefs' in second.body));
  });
  await check('trello_update_board: prefs usam prefs/<nome> da API', async () => {
    assert.ok(!(await call('trello_update_board', { boardId: board, prefs: { visibility: 'private', selfJoinEnabled: false } })).isError);
    const [update] = requests().filter(r => r.method === 'PUT');
    const params = new URLSearchParams(update.query);
    assert.equal(params.get('prefs/permissionLevel'), 'private');
    assert.equal(params.get('prefs/selfJoin'), 'false');
  });

  await check('votos usam membersVoted do usuário autenticado', async () => {
    assert.ok(!(await call('trello_vote_card', { cardId: card })).isError);
    assert.ok(!(await call('trello_unvote_card', { cardId: card })).isError);
    assert.deepEqual(writes(), [
      { endpoint: `/cards/${card}/membersVoted`, method: 'POST', body: { value: member } },
      { endpoint: `/cards/${card}/membersVoted/${member}`, method: 'DELETE' },
    ]);
  });
  await check('membros do card usam idMembers', async () => {
    assert.ok(!(await call('trello_add_card_member', { cardId: card, memberId: member })).isError);
    assert.ok(!(await call('trello_remove_card_member', { cardId: card, memberId: member })).isError);
    assert.deepEqual(writes(), [
      { endpoint: `/cards/${card}/idMembers`, method: 'POST', body: { value: member } },
      { endpoint: `/cards/${card}/idMembers/${member}`, method: 'DELETE' },
    ]);
  });
  await check('trello_delete_comment usa a rota de comentários', async () => {
    assert.ok(!(await call('trello_delete_comment', { cardId: card, commentId: id('1') })).isError);
    assert.deepEqual(writes(), [{ endpoint: `/cards/${card}/actions/${id('1')}/comments`, method: 'DELETE' }]);
  });
  await check('remover vencimento envia string vazia, pois a API ignora due: null', async () => {
    assert.ok(!(await call('trello_remove_due_date', { cardId: id('3') })).isError);
    assert.deepEqual(writes(), [{ endpoint: `/cards/${id('3')}`, method: 'PUT', body: { due: '' } }]);
    clear();
    assert.ok(!(await call('trello_update_card', { cardId: id('3'), due: 'remove' })).isError);
    assert.deepEqual(writes(), [{ endpoint: `/cards/${id('3')}`, method: 'PUT', body: { due: '' } }]);
  });

  await check('etiqueta por nome exige nome exato: "Bug" não inclui "Debug"', async () => {
    assert.ok(!(await call('trello_update_card', { cardId: card, labelNames: ['bug'] })).isError);
    assert.equal(writes()[0].body.idLabels, bug);
    clear();
    await rejected('trello_update_card', { cardId: card, addLabelNames: ['bu'] });
    await rejected('trello_create_card', { name: 'X', listId: id('1'), labelNames: ['Inexistente'] });
  });
  await check('adicionar e remover etiquetas na mesma chamada aplica as duas alterações', async () => {
    assert.ok(!(await call('trello_update_card', { cardId: card, addLabelIds: [bug], removeLabelIds: [debug] })).isError);
    assert.equal(writes()[0].body.idLabels, bug);
    clear();
    assert.ok(!(await call('trello_update_card', { cardId: card, addLabelNames: ['Bug'] })).isError);
    assert.equal(writes()[0].body.idLabels, `${debug},${bug}`);
  });

  await check('trello_search_in_board procura na descrição e limita depois de filtrar', async () => {
    const byDescription = await call('trello_search_in_board', { query: 'zebra', limit: 1 });
    assert.match(text(byDescription), /Atrasado/);
    assert.match(text(byDescription), new RegExp(id('3')));
    const limited = await call('trello_search_in_board', { query: 'repetido', limit: 1 });
    assert.match(text(limited), /Encontrados: 2/);
    assert.match(text(limited), /mais 1 cards não exibidos/);
  });
  await check('trello_search_by_due: uma requisição e concluído não conta como atrasado', async () => {
    const result = await call('trello_search_by_due', { filter: 'overdue' });
    assert.match(text(result), /Atrasado/);
    assert.doesNotMatch(text(result), /SOMA/);
    assert.equal(requests().filter(r => r.endpoint.startsWith('/cards/')).length, 0);
    assert.equal(requests().length, 1);
  });
  await check('trello_board_activity_stats envia o período em since', async () => {
    assert.ok(!(await call('trello_board_activity_stats', { days: 7 })).isError);
    const params = new URLSearchParams(requests().find(r => r.endpoint === `/boards/${board}/actions`).query);
    assert.match(params.get('since'), /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Date.now() - new Date(params.get('since')).getTime() >= 7 * 24 * 60 * 60 * 1000 - 60000);
    assert.equal(params.get('date'), null);
  });

  await check('trello_export_board devolve o conteúdo em JSON', async () => {
    const result = await call('trello_export_board', {});
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[1].text);
    assert.equal(data.board.id, board);
    assert.equal(data.cards.length, 5);
    assert.deepEqual(data.cards.find(c => c.id === id('3')), {
      id: id('3'), name: 'Atrasado', list: 'Testing', labels: [], members: ['ana'], due: '2020-01-01T12:00:00.000Z',
      dueComplete: false, url: 'https://trello.com/c/atrasado', desc: 'contém a palavra-chave zebra',
    });
    assert.ok(requests().every(r => r.method === 'GET'));
  });
  await check('trello_export_board em CSV escapa aspas e neutraliza fórmulas', async () => {
    const result = await call('trello_export_board', { format: 'csv' });
    const lines = result.content[1].text.split('\r\n');
    assert.equal(lines[0], 'id,name,list,labels,members,due,dueComplete,url,desc');
    assert.equal(lines.length, 6);
    assert.ok(lines.some(line => line.includes(`"'=SOMA(A1) entregue"`) && line.includes('"já ""feito"""') && line.includes('"Bug"')));
  });

  await check('falha da API vira isError, com o motivo e sem expor o token', async () => {
    const result = await call('trello_get_card_details', { cardId: id('f') });
    assert.equal(result.isError, true);
    assert.match(text(result), /404/);
    assert.match(text(result), /card not found/);
    assert.doesNotMatch(text(result), /faketoken/);
  });

  await check('URL do quadro é resolvida por shortLink com uma única consulta', async () => {
    const boardUrl = 'https://trello.com/b/lojaAAAA/loja';
    assert.ok(!(await call('trello_list_lists', { boardUrl })).isError);
    assert.ok(!(await call('trello_list_lists', { boardUrl })).isError);
    assert.deepEqual(requests().map(r => r.endpoint), ['/boards/lojaAAAA', `/boards/${board}/lists`, `/boards/${board}/lists`]);
  });

  await check('webhook exige HTTPS e convite exige email válido', async () => {
    await rejected('trello_create_webhook', { callbackURL: 'http://example.com/hook', modelId: board });
    await rejected('trello_add_board_member', { email: 'nao-e-email' });
    await rejected('trello_upload_attachment', { cardId: card, fileUrl: 'ftp://example.com/a.pdf' });
    assert.equal(requests().length, 0);
    assert.ok(!(await call('trello_create_webhook', { callbackURL: 'https://example.com/hook', modelId: board })).isError);
    assert.equal(writes()[0].endpoint, '/webhooks');
  });

  await check('Power-Ups usam as rotas plugins e boardPlugins', async () => {
    const listed = await call('trello_list_power_ups', {});
    assert.match(text(listed), /Calendário/);
    assert.match(text(listed), new RegExp(id('5')));
    assert.ok(!(await call('trello_enable_power_up', { powerUpId: id('5') })).isError);
    assert.ok(!(await call('trello_disable_power_up', { powerUpId: id('5') })).isError);
    assert.deepEqual(writes(), [
      { endpoint: `/boards/${board}/boardPlugins`, method: 'POST', body: { idPlugin: id('5') } },
      { endpoint: `/boards/${board}/boardPlugins/${id('5')}`, method: 'DELETE' },
    ]);
  });

  await check('trello_remove_board_member aceita @username exato, não trecho do nome', async () => {
    await rejected('trello_remove_board_member', { email: 'an' });
    assert.ok(!(await call('trello_remove_board_member', { email: '@ana' })).isError);
    assert.deepEqual(writes(), [{ endpoint: `/boards/${board}/members/${member}`, method: 'DELETE' }]);
  });
});

test('credenciais do ambiente têm precedência sobre o arquivo e dispensam apiKey/token em disco', async t => {
  const { call, requests } = await start(t, {
    TRELLO_TEST_CONFIG: JSON.stringify({ apiKey: 'dodisco', boardId: board }),
    TRELLO_TEST_API_KEY: 'envkey', TRELLO_TEST_TOKEN: 'envtoken',
  });
  assert.ok(!(await call('trello_list_lists', {})).isError);
  assert.equal(requests()[0].auth, 'OAuth oauth_consumer_key="envkey", oauth_token="envtoken"');
});

for (const [label, config, tool, message] of [
  ['token com aspas', { apiKey: 'k', token: 't"x' }, 'trello_list_boards', /Configuração inválida/],
  ['sem apiKey', { token: 't' }, 'trello_list_boards', /Configuração inválida/],
  ['sem quadro padrão', { apiKey: 'k', token: 't' }, 'trello_list_lists', /Nenhum quadro definido/],
]) {
  test(`configuração ${label} é recusada antes de qualquer requisição`, async t => {
    const { call, requests } = await start(t, { TRELLO_TEST_CONFIG: JSON.stringify(config) });
    const result = await call(tool, {});
    assert.equal(result.isError, true);
    assert.match(text(result), message);
    assert.equal(requests().length, 0);
  });
}
