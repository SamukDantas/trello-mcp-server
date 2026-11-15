// Isolated subprocess fixture for tests/fixes.test.mjs. All HTTP is intercepted; real credentials are never read.
// Unlike mock-trello.mjs, every logged request also records its query string and Authorization header.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const id = char => char.repeat(24);
const board = id('a'), other = id('b'), member = id('9');
const lists = [{ id: id('1'), name: 'Triagem' }, { id: id('2'), name: 'Testing' }];
const labels = [{ id: id('7'), name: 'Bug', color: 'red' }, { id: id('8'), name: 'Debug', color: 'blue' }];
const past = '2020-01-01T12:00:00.000Z';
const cards = [
  { id: id('c'), name: 'Pedido 1', desc: '', idBoard: board, idList: lists[0].id, idLabels: [labels[1].id], idMembers: [], due: null, dueComplete: false, shortUrl: 'https://trello.com/c/pedido1' },
  { id: id('d'), name: 'Repetido', desc: '', idBoard: board, idList: lists[1].id, idLabels: [], idMembers: [], due: null, dueComplete: false, shortUrl: 'https://trello.com/c/rep1' },
  { id: id('e'), name: 'Repetido', desc: '', idBoard: board, idList: lists[1].id, idLabels: [], idMembers: [], due: null, dueComplete: false, shortUrl: 'https://trello.com/c/rep2' },
  { id: id('3'), name: 'Atrasado', desc: 'contém a palavra-chave zebra', idBoard: board, idList: lists[1].id, idLabels: [], idMembers: [member], due: past, dueComplete: false, shortUrl: 'https://trello.com/c/atrasado' },
  { id: id('4'), name: '=SOMA(A1) entregue', desc: 'já "feito"', idBoard: board, idList: lists[1].id, idLabels: [labels[0].id], idMembers: [], due: past, dueComplete: true, shortUrl: 'https://trello.com/c/feito' },
];
const boards = [
  { id: board, name: 'Loja', shortUrl: 'https://trello.com/b/lojaAAAA', closed: false },
  { id: other, name: 'Loja Filial', shortUrl: 'https://trello.com/b/filialBB', closed: false },
];

// Tests must never see the developer's real credentials; a test opts into env credentials explicitly.
for (const [name, testName] of [['TRELLO_API_KEY', 'TRELLO_TEST_API_KEY'], ['TRELLO_TOKEN', 'TRELLO_TEST_TOKEN']]) {
  if (process.env[testName]) process.env[name] = process.env[testName];
  else delete process.env[name];
}

const configPath = path.join(os.homedir(), '.config', 'opencode', 'trello-config.json');
const config =process.env.TRELLO_TEST_CONFIG || JSON.stringify({ apiKey: 'fakekey', token: 'faketoken', boardId: board });
const originalRead = fs.readFileSync;
const originalExists = fs.existsSync;
fs.existsSync = function(file) { return file === configPath || originalExists.apply(this, arguments); };
fs.readFileSync = function(file) { return file === configPath ? config : originalRead.apply(this, arguments); };

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.origin !== 'https://api.trello.com') throw new Error('Network access forbidden in tests');
  const endpoint = url.pathname.slice(2);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  fs.appendFileSync(process.env.TRELLO_TEST_LOG, JSON.stringify({
    endpoint, method, body, query: url.search, auth: new Headers(init.headers).get('authorization'),
  }) + '\n');
  const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });

  if (endpoint.startsWith(`/cards/${id('f')}`)) return new Response('card not found (token faketoken)', { status: 404, statusText: 'Not Found' });
  if (endpoint === '/members/me') return json({ id: member });
  if (endpoint === '/members/me/boards') return json(boards);
  if (endpoint === '/boards' && method === 'POST') return json({ ...boards[0], ...body });
  if (endpoint === '/boards/lojaAAAA') return json({ id: board });
  if (endpoint === `/boards/${board}/lists`) return json(lists);
  if (endpoint === `/boards/${board}/labels`) return json(labels);
  if (endpoint === `/boards/${board}/members`) return json([{ id: member, fullName: 'Ana Lima', username: 'ana' }]);
  if (endpoint === `/boards/${board}/actions`) return json([]);
  if (endpoint === `/boards/${board}/plugins`) return json([{ id: id('5'), listing: { name: 'Calendário' } }]);
  if (endpoint === `/boards/${board}/cards/open` || endpoint === `/boards/${board}/cards/visible`) return json(cards);
  if (endpoint.startsWith('/boards/')) return json({ ...(boards.find(b => b.id === endpoint.split('/')[2]) || boards[0]), desc: '', url: 'https://trello.com/b/lojaAAAA/loja', ...body });
  if (endpoint.startsWith('/cards/')) return json({ ...(cards.find(c => c.id === endpoint.split('/')[2]) || cards[0]), ...body });
  if (endpoint.startsWith('/lists/') || endpoint.startsWith('/webhooks')) return json({ id: id('6'), ...body });
  throw new Error(`Unexpected mock request: ${method} ${endpoint}`);
};
