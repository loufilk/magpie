import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from '../index.mjs';
import { createProviderPlugin } from '../lib/connection.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const baseURL = 'http://127.0.0.1:8379/v1';
const auth = { type: 'api', key: 'account-one', metadata: { mode: 'gateway', baseURL, label: 'Main' } };
function data(price = 1) { return [{ id: 'model', type: 'text', name: 'Model', peers: [A, B].map((peerId, i) => ({ peerId, serviceId: 'native-model', type: 'text', protocol: 'openai-chat-completions', inputUsdPerMillion: price + i, outputUsdPerMillion: price + i, capabilities: { contextWindow: 10000, maxOutputTokens: 2048, inputs: ['text'], outputs: ['text'], toolUse: true } })) }]; }
const keyInfo = { id: 'test-key', label: 'Main', balance: { available_usd: '12.345678', reserved_usd: '0', pending_usd: '0', stale: false }, usage: { requests: 1, spent_usd: '0.000001' }, limits: {} };
function mock(options = {}) {
  const seen = [];
  let models = data();
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url).endsWith('/models?type=text')) return Response.json({ data: models });
    if (String(url).endsWith('/key')) return Response.json({ data: keyInfo });
    if (options.post) return options.post(url, init);
    return Response.json({ id: 'answer', choices: [{ message: { content: 'OK' } }] });
  };
  return { fetchImpl, seen, setModels: (v) => { models = v; }, posts: () => seen.filter((x) => x.init.method === 'POST') };
}

test('entry exports one plugin; unauthenticated registration starts no runtime', async () => {
  assert.equal(typeof plugin.server, 'function');
  const hooks = await createProviderPlugin({}, {}, { runtime: { ensureManagedGateway() { throw new Error('unexpected startup'); } } });
  const config = {};
  await hooks.config(config);
  assert.equal(config.provider.antseed.name, 'Antseed');
  assert.equal(hooks.auth.methods.length, 3);
  assert.deepEqual(await hooks.auth.loader(async () => null), {});
});

test('API login validates gateway key once and keeps credentials out of options/metadata', async () => {
  const upstream = mock();
  const hooks = await createProviderPlugin({}, {}, upstream);
  const result = await hooks.auth.methods[1].authorize({ mode: 'gateway', baseURL, key: 'account-one', label: 'Main' });
  assert.equal(result.type, 'success');
  assert.equal(result.key, 'account-one');
  assert.deepEqual(result.metadata, { mode: 'gateway', baseURL, label: 'Main' });
  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].url, `${baseURL}/key`);
  assert.equal(upstream.posts().length, 0);
});

test('explicit bare Buyer login uses placeholder and does not fake a wallet balance', async () => {
  const upstream = mock();
  const hooks = await createProviderPlugin({}, {}, upstream);
  const result = await hooks.auth.methods[1].authorize({ mode: 'buyer', baseURL });
  assert.equal(result.key, 'antseed-local');
  const usage = await hooks.auth.usage(async () => ({ ...result, type: 'api' }));
  assert.deepEqual(usage.windows, []);
  assert.equal(Object.hasOwn(usage, 'balance'), false);
});

test('request rechecks current catalog, pins selected seller and forwards actual account key only', async () => {
  const upstream = mock();
  const hooks = await createProviderPlugin({}, { maxInputUsdPerMillion: 1.5, dispatchCatalogTtlMs: 0 }, upstream);
  await hooks.provider.models({ models: {} }, { auth });
  const loader = await hooks.auth.loader(async () => auth);
  let response = await loader.fetch(`${baseURL}/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer client-secret', 'x-api-key': 'other' }, body: JSON.stringify({ model: 'model', messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(upstream.posts()[0].init.body).model, `${A}@native-model`);
  assert.equal(upstream.posts()[0].init.headers.get('authorization'), 'Bearer account-one');
  assert.equal(upstream.posts()[0].init.headers.has('x-api-key'), false);
  upstream.setModels(data(4));
  response = await loader.fetch(`${baseURL}/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'model', messages: [] }) });
  assert.equal(response.status, 403);
  assert.equal(upstream.posts().length, 1, 'changed price must be refused before a second paid dispatch');
});

test('3 protocols stream untouched, including tool calls/signatures, without buffering', async () => {
  for (const path of ['/chat/completions', '/responses', '/messages']) {
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('event: tool_call\ndata: {"arguments":"{","signature":"opaque"}\n\n')); } });
    const original = new Response(stream, { headers: { 'content-type': 'text/event-stream', 'x-antseed-request-id': 'upstream-request' } });
    const upstream = mock({ post: async () => original });
    const hooks = await createProviderPlugin({}, {}, upstream);
    const loader = await hooks.auth.loader(async () => auth);
    const response = await loader.fetch(`${baseURL}${path}`, { method: 'POST', body: JSON.stringify({ model: 'model', messages: [], stream: true }) });
    assert.equal(response, original);
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /opaque/);
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    controller.close();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: [DONE]\n\n');
    assert.equal((await reader.read()).done, true);
  }
});

test('a caller service cannot override the vetted model on Gateway or bare Buyer text requests', async () => {
  for (const mode of ['gateway', 'buyer']) {
    for (const path of ['/chat/completions', '/responses', '/messages']) {
      const upstream = mock();
      const account = { ...auth, metadata: { ...auth.metadata, mode } };
      const hooks = await createProviderPlugin({}, {}, upstream);
      const loader = await hooks.auth.loader(async () => account);
      const response = await loader.fetch(`${baseURL}${path}`, { body: JSON.stringify({ model: 'model', service: `${B}@unchecked-expensive-service`, messages: [] }) });
      assert.equal(response.status, 200);
      assert.equal(upstream.posts().length, 1);
      const sent = JSON.parse(upstream.posts()[0].init.body);
      assert.equal(sent.model, `${A}@native-model`);
      assert.equal(Object.hasOwn(sent, 'service'), false);
    }
  }
});

test('upstream 402 and server errors are preserved; one call never retries a paid POST', async () => {
  for (const status of [402, 429, 503]) {
    const upstream = mock({ post: async () => new Response('upstream-error', { status }) });
    const hooks = await createProviderPlugin({}, {}, upstream);
    const loader = await hooks.auth.loader(async () => auth);
    const response = await loader.fetch(`${baseURL}/messages`, { method: 'POST', body: JSON.stringify({ model: 'model', messages: [] }) });
    assert.equal(response.status, status);
    assert.equal(await response.text(), 'upstream-error');
    assert.equal(upstream.posts().length, 1);
  }
});

test('failed seller cools down only for later calls; a later alias can select next eligible seller', async () => {
  let n = 0;
  const upstream = mock({ post: async () => new Response('busy', { status: ++n === 1 ? 503 : 200 }) });
  const hooks = await createProviderPlugin({}, {}, upstream);
  const loader = await hooks.auth.loader(async () => auth);
  const init = { method: 'POST', body: JSON.stringify({ model: 'model', messages: [] }) };
  assert.equal((await loader.fetch(`${baseURL}/responses`, init)).status, 503);
  assert.equal(upstream.posts().length, 1);
  assert.equal((await loader.fetch(`${baseURL}/responses`, init)).status, 200);
  assert.deepEqual(upstream.posts().map((p) => JSON.parse(p.init.body).model), [`${A}@native-model`, `${B}@native-model`]);
});

test('off-origin requests cannot exfiltrate a saved API key', async () => {
  const upstream = mock();
  const hooks = await createProviderPlugin({}, {}, upstream);
  const loader = await hooks.auth.loader(async () => auth);
  const response = await loader.fetch('https://attacker.test/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'model', messages: [] }) });
  assert.equal(response.status, 400);
  assert.equal(upstream.seen.length, 0);
});

test('redirect dispatch has redirect:error and never sends another POST', async () => {
  const upstream = mock({ post: async (_url, init) => { assert.equal(init.redirect, 'error'); throw new TypeError('fetch failed'); } });
  const hooks = await createProviderPlugin({}, {}, upstream);
  const loader = await hooks.auth.loader(async () => auth);
  assert.equal((await loader.fetch(`${baseURL}/responses`, { body: JSON.stringify({ model: 'model', input: 'x' }) })).status, 502);
  assert.equal(upstream.posts().length, 1);
});

test('request abort signal reaches upstream and cancellation is not changed to a successful response', async () => {
  const abort = new AbortController();
  const upstream = mock({ post: async (_url, init) => {
    assert.equal(init.signal, abort.signal);
    abort.abort(new DOMException('User cancelled', 'AbortError'));
    throw abort.signal.reason;
  } });
  const hooks = await createProviderPlugin({}, {}, upstream);
  const loader = await hooks.auth.loader(async () => auth);
  await assert.rejects(loader.fetch(`${baseURL}/responses`, { signal: abort.signal, body: JSON.stringify({ model: 'model', input: 'x' }) }), { name: 'AbortError' });
  assert.equal(upstream.posts().length, 1);
});

test('catalog cache is isolated per account; second account cannot use first account model permissions', async () => {
  const upstream = mock();
  const other = { ...auth, key: 'account-two' };
  const original = upstream.fetchImpl;
  const hooks = await createProviderPlugin({}, {}, { fetchImpl: async (url, init) => {
    if (String(url).includes('/models') && init.headers.authorization === 'Bearer account-two') return Response.json({ data: [] });
    return original(url, init);
  } });
  const first = await hooks.auth.loader(async () => auth);
  const second = await hooks.auth.loader(async () => other);
  const init = { body: JSON.stringify({ model: 'model', messages: [] }) };
  assert.equal((await first.fetch(`${baseURL}/messages`, init)).status, 200);
  assert.equal((await second.fetch(`${baseURL}/messages`, init)).status, 403);
  assert.equal(upstream.posts().length, 1);
});

test('managed setup opens official console and re-opening an uninitialized profile does not create wallet', async () => {
  let ensured = 0, initialized = false;
  const runtime = {
    runtimeStatus: async () => ({ initialized }),
    ensureManagedGateway: async ({ profile }) => { ensured++; initialized = true; return { profile, apiKey: 'managed-key', baseURL }; },
    consoleLink: async () => ({ url: 'http://localhost:8379/console', setupLink: 'http://localhost:8379/console/setup#one-time', setupRequired: true }),
  };
  const hooks = await createProviderPlugin({}, {}, { runtime });
  assert.equal((await hooks.auth.methods[2].authorize({ profile: 'main' })).type, 'failed');
  assert.equal(ensured, 0);
  const flow = await hooks.auth.methods[0].authorize({ profile: 'main' });
  assert.equal(flow.method, 'auto');
  assert.equal(flow.url, 'http://localhost:8379/console/setup#one-time');
  const saved = await flow.callback();
  assert.equal(saved.metadata.profile, 'main');
  assert.equal(saved.key, 'managed-key');
  assert.equal(own(saved.metadata, 'privateKey'), false);
  assert.equal(JSON.stringify(saved).includes('one-time'), false, 'setup token must never be saved as an account field');
  assert.equal(ensured, 1);
});

test('official auth.cli installer prepares runtime outside one-minute OAuth authorize and creates no wallet', async () => {
  let ready = false, prepares = 0, walletStarts = 0;
  const controller = new AbortController();
  const runtime = {
    isManagedRuntimeInstalled: async () => ready,
    prepareManagedRuntime: async (settings) => { assert.equal(settings.signal, controller.signal); prepares++; ready = true; },
    ensureManagedGateway: async () => { walletStarts++; throw new Error('wallet startup belongs to explicit authorize'); },
  };
  const hooks = await plugin.server({}, {}, { runtime });
  assert.equal(hooks.auth.cli.name, 'Antseed runtime');
  assert.equal(await hooks.auth.cli.installed(), false);
  await hooks.auth.cli.install({ signal: controller.signal });
  assert.equal(await hooks.auth.cli.installed(), true);
  assert.equal(prepares, 1);
  assert.equal(walletStarts, 0);
});

test('external Gateway API login never checks or installs local runtime', async () => {
  const upstream = mock();
  const runtime = new Proxy({}, { get() { throw new Error('external account touched the local runtime'); } });
  const hooks = await plugin.server({}, {}, { ...upstream, runtime });
  const result = await hooks.auth.methods[1].authorize({ mode: 'gateway', baseURL, key: 'account-one' });
  assert.equal(result.type, 'success');
});

test('official runtime install receives cancellation and does not turn a cancelled install into success', async () => {
  const controller = new AbortController();
  const runtime = {
    prepareManagedRuntime: async ({ signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort(new DOMException('Install cancelled', 'AbortError'));
      signal.throwIfAborted();
    },
  };
  const hooks = await plugin.server({}, {}, { runtime });
  await assert.rejects(hooks.auth.cli.install({ signal: controller.signal }), { name: 'AbortError' });
});

test('model-list and usage hook cancellation stop their pending GETs', async () => {
  for (const hook of ['models', 'usage']) {
    const controller = new AbortController();
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let cancelled = false;
    const hooks = await createProviderPlugin({}, {}, { fetchImpl: async (_url, { signal }) => {
      entered();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true });
      });
    } });
    const pending = hook === 'models'
      ? hooks.provider.models({ models: {} }, { auth, signal: controller.signal })
      : hooks.auth.usage(async () => auth, {}, { signal: controller.signal });
    await started;
    controller.abort(new DOMException('List cancelled', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(cancelled, true);
  }
});

test('managed model rule is enforced by its preset even with a conflicting service field, with prompt unchanged', async () => {
  const upstream = mock();
  const management = [];
  const managed = { ...auth, key: 'managed-key', metadata: { mode: 'managed', profile: 'existing' } };
  const runtime = {
    ensureManagedGateway: async (settings) => {
      assert.equal(settings.profile, 'existing');
      return { mode: 'managed', profile: 'existing', baseURL, apiKey: 'managed-key', workspaceId: 'workspace-1' };
    },
    managementRequest: async (path, init) => {
      management.push({ path, init });
      return init.method === 'GET' ? Response.json([]) : Response.json(JSON.parse(init.body));
    },
  };
  const hooks = await createProviderPlugin({}, { profile: 'different', rules: { model: { maxInputUsdPerMillion: 1.5 } } }, { ...upstream, runtime });
  const loader = await hooks.auth.loader(async () => managed);
  const messages = [{ role: 'system', content: 'Preserve system instruction' }, { role: 'user', content: 'hi' }];
  const response = await loader.fetch(`${baseURL}/chat/completions`, { body: JSON.stringify({ model: 'model', service: `${B}@unchecked-expensive-service`, messages, max_tokens: 100 }) });
  assert.equal(response.status, 200);
  assert.equal(management.length, 2);
  const preset = JSON.parse(management[1].init.body);
  assert.equal(preset.routingPolicy.maxInputUsdPerMillion, 1.5);
  assert.equal(preset.model, `${A}@native-model`);
  assert.equal(preset.systemPrompt, null);
  const sent = JSON.parse(upstream.posts()[0].init.body);
  assert.match(sent.model, /^@preset\/magpie-[a-f0-9]{32}$/);
  assert.equal(Object.hasOwn(sent, 'service'), false);
  assert.deepEqual(sent.messages, messages);
  assert.equal(sent.max_tokens, 100);
  assert.equal(upstream.posts()[0].init.headers.get('authorization'), 'Bearer managed-key');
});

test('free-tier rejection cools only that seller; the next new call may select another offer', async () => {
  let n = 0;
  const upstream = mock({ post: async () => new Response('free allowance exhausted', { status: ++n === 1 ? 402 : 200 }) });
  upstream.setModels(data(0));
  const hooks = await createProviderPlugin({}, {}, upstream);
  const loader = await hooks.auth.loader(async () => auth);
  const init = { body: JSON.stringify({ model: 'model', input: 'hi' }) };
  assert.equal((await loader.fetch(`${baseURL}/responses`, init)).status, 402);
  assert.equal(upstream.posts().length, 1);
  assert.equal((await loader.fetch(`${baseURL}/responses`, init)).status, 200);
  assert.equal(JSON.parse(upstream.posts()[1].init.body).model, `${B}@native-model`);
});
function own(o, k) { return Object.hasOwn(o, k); }
