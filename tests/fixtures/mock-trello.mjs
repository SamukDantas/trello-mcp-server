// Isolated subprocess fixture. All HTTP is intercepted; real credentials are never read.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const board = 'a'.repeat(24), other = 'b'.repeat(24), card = 'c'.repeat(24);
const lists = [
  { id: '1'.repeat(24), name: 'Triagem' },
  { id: '2'.repeat(24), name: 'Análise comercial' },
  { id: '3'.repeat(24), name: 'Testing' },
  { id: '4'.repeat(24), name: 'Testing urgente' },
  { id: '5'.repeat(24), name: 'Repetida' },
  { id: '6'.repeat(24), name: 'Repetida' },
];
const otherLists = [{ id: '7'.repeat(24), name: 'Recepção' }];
const cards = [
  { id: card, desc: process.env.TRELLO_TEST_DESCRIPTION || '', name: 'Pedido 1', idBoard: board, idList: lists[0].id, idLabels: [], due: null, dueComplete: false, shortUrl: 'https://trello.com/c/fake' },
  { id: 'd'.repeat(24), name: 'Repetido', idBoard: board, idList: lists[3].id, idLabels: [] },
  { id: 'e'.repeat(24), name: 'Repetido', idBoard: board, idList: lists[3].id, idLabels: [] },
];
const configPath = path.join(os.homedir(), '.config', 'opencode', 'trello-config.json');
const originalRead = fs.readFileSync;
const originalExists = fs.existsSync;
fs.existsSync = function(file) { return file === configPath || originalExists.apply(this, arguments); };
fs.readFileSync = function(file) {
  if (file === configPath) return JSON.stringify({ apiKey: 'fake', token: 'fake', boardId: board });
  return originalRead.apply(this, arguments);
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.origin !== 'https://api.trello.com') throw new Error('Network access forbidden in tests');
  const endpoint = url.pathname.slice(2);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : undefined;
  fs.appendFileSync(process.env.TRELLO_TEST_LOG, JSON.stringify({ endpoint, method, body }) + '\n');
  let data;
  if (endpoint === '/members/me/boards') data = [{ id: board, name: 'Loja', shortUrl: 'https://trello.com/b/loja' }, { id: other, name: 'Atendimento', shortUrl: 'https://trello.com/b/atendimento' }];
  else if (endpoint === `/boards/${board}/lists`) data = lists;
  else if (endpoint === `/boards/${other}/lists`) data = otherLists;
  else if (endpoint === `/boards/${board}/labels`) data = [];
  else if (endpoint === `/boards/${board}/cards/open`) data = cards;
  else if (endpoint.startsWith('/lists/') && endpoint.endsWith('/cards')) data = cards.filter(c => c.idList === endpoint.split('/')[2]);
  else if (endpoint === '/cards' && method === 'POST') data = { ...cards[0], ...body };
  else if (endpoint.startsWith('/cards/')) data = { ...(cards.find(c => c.id === endpoint.split('/')[2]) || cards[0]), ...body };
  else if (endpoint.startsWith('/lists/') && method !== 'GET') data = { id: endpoint.split('/')[2], ...body };
  else throw new Error(`Unexpected mock request: ${method} ${endpoint}`);
  return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
