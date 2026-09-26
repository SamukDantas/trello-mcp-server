import test from 'node:test';
import assert from 'node:assert/strict';
import { configureSystemCertificateTrust, requestTrello } from '../dist/network.js';

test('inclui CAs do sistema preservando CAs padrão e extras sem duplicatas', () => {
  let configured;
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  assert.equal(configureSystemCertificateTrust({
    getCACertificates: type => type === 'default' ? ['bundled', 'extra', 'shared'] : ['system', 'shared'],
    setDefaultCACertificates: certificates => { configured = certificates; },
  }), true);
  assert.deepEqual(configured, ['bundled', 'extra', 'shared', 'system']);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, previous);
});

test('runtime sem APIs de CA continua compatível', () => {
  assert.equal(configureSystemCertificateTrust({}), false);
  assert.equal(configureSystemCertificateTrust({ getCACertificates: () => { throw new Error('should not be called'); } }), false);
});

test('falha ao carregar CAs não desativa validação nem instala trust parcial', () => {
  let configured = false;
  assert.throws(() => configureSystemCertificateTrust({
    getCACertificates: () => { throw new Error('store unavailable'); },
    setDefaultCACertificates: () => { configured = true; },
  }), /store unavailable/);
  assert.equal(configured, false);
});

for (const code of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND', 'ECONNRESET', undefined]) {
  test(`erro de rede ${code ?? 'desconhecido'} explica a causa sem vazar credenciais nem repetir chamadas`, async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError('https://api.trello.com?key=secret-key&token=secret-token', {
        cause: Object.assign(new Error('secret-token'), { code }),
      });
    };
    await assert.rejects(requestTrello('https://api.trello.com?key=secret-key&token=secret-token', { method: 'POST' }), error => {
      assert.ok(error.message.includes(code ?? 'NETWORK_ERROR'));
      assert.ok(!error.message.includes('secret-key'));
      assert.ok(!error.message.includes('secret-token'));
      if (code?.includes('CERT') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') assert.match(error.message, /validação TLS permanece ativa/);
      else assert.match(error.message, /rede, DNS e proxy/);
      return true;
    });
    assert.equal(calls, 1);
  });
}

test('respostas HTTP e opções originais são preservadas', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const response = new Response('unauthorized', { status: 401 });
  const init = { method: 'PUT', body: '{"dueComplete":true}' };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.trello.com/1/cards/example');
    assert.equal(options, init);
    return response;
  };
  assert.equal(await requestTrello('https://api.trello.com/1/cards/example', init), response);
});
