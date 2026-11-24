import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

// This suite runs the unmodified official Magpie Bun host, not a hook stub.
// Set MAGPIE_HOST_PATH and MAGPIE_BUN to an official checkout and runnable Bun.
// MAGPIE_BINARY_PATH adds an end-to-end run through the official Go gateway.
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const pluginPath = process.env.MAGPIE_PLUGIN_PATH ? resolve(process.env.MAGPIE_PLUGIN_PATH) : root;
const hostPath = process.env.MAGPIE_HOST_PATH;
const bun = process.env.MAGPIE_BUN || 'bun';
const binary = process.env.MAGPIE_BINARY_PATH;
const note = (...args) => { if (process.env.MAGPIE_INTEGRATION_DEBUG) console.error(...args); };
const peerId = '1'.repeat(40);
const protocolFor = {
  chat: 'openai-chat-completions',
  responses: 'openai-responses',
  messages: 'anthropic-messages',
};
const pathFor = { chat: '/v1/chat/completions', responses: '/v1/responses', messages: '/v1/messages' };
const sdkFor = { chat: '@ai-sdk/openai-compatible', responses: '@ai-sdk/openai', messages: '@ai-sdk/anthropic' };

function model(kind, id = `fixture-${kind}`) {
  const capabilities = { contextWindow: 32768, maxOutputTokens: 8192, toolUse: true, reasoning: false, inputs: ['text'] };
  return {
    id, name: id, type: 'text', context_length: 32768, max_output_tokens: 8192,
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    capabilities: { tool_use: true, reasoning: false },
    peers: [{ peerId, serviceId: id, model: `${peerId}@${id}`, displayName: 'Integration fixture',
      provider: 'fixture', protocol: protocolFor[kind], protocols: [protocolFor[kind]],
      inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0,
      reputation: 100, trustScore: 100, capabilities }],
  };
}

function requestBody(kind, mode = 'normal') {
  const common = { model: `fixture-${kind}`, service:'fixture-denied-service', stream: true, max_tokens: 32, fixture_mode: mode };
  if (kind === 'responses') return { ...common, input: [{ role: 'user', content: 'Reply integration-ok' }] };
  return { ...common, messages: [{ role: 'user', content: 'Reply integration-ok' }] };
}

function eventsFor(kind, tool = false) {
  const event = (name, data) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
  if (kind === 'chat') {
    const delta = tool ? { tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'lookup', arguments: '{"city":"Berlin"}' } }] } : { content: 'integration-ok' };
    return [
      event('', { id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-chat', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] }),
      event('', { id: 'chat_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-chat', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
      'data: [DONE]\n\n',
    ];
  }
  if (kind === 'responses') {
    const item = tool ? { id: 'fc_fixture', type: 'function_call', call_id: 'call_fixture', name: 'lookup', arguments: '{"city":"Berlin"}', status: 'completed' } : { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'integration-ok', annotations: [] }] };
    return [
      event('response.created', { type: 'response.created', response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] } }),
      event('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } }),
      ...(tool ? [event('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: '{"city":"Berlin"}' })] : [event('response.output_text.delta', { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'integration-ok' })]),
      event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }),
      event('response.completed', { type: 'response.completed', response: { id: 'resp_fixture', object: 'response', status: 'completed', model: 'fixture-responses', output: [item], usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }),
    ];
  }
  return [
    event('message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture-messages', content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call_fixture', name: 'lookup', input: {} } : { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: '{"city":"Berlin"}' } : { type: 'text_delta', text: 'integration-ok' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } }),
    event('message_stop', { type: 'message_stop' }),
  ];
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-magpie-integration-'));
  const cleanup = [];
  const state = { calls: [], models: Object.keys(protocolFor).map(kind => model(kind)), cancelled: 0, leaked: 0, stale: false,
    balance: { available_usd: '12.345678', reserved_usd: '2.000000', pending_usd: '0.250000', wallet_usd: '0.500000' } };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    state.calls.push({ method: req.method, path: req.url, headers: req.headers, body });
    const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/healthz') return json(200, { ok: true });
    if (req.url === '/v1/key') return json(200, { data: {
      id: 'key_fixture', label: 'Integration', buyer_address: `0x${peerId}`,
      balance: { ...state.balance, stale: state.stale },
      usage: { requests: 2, spent_usd: '0.125000', input_tokens: 10, cached_input_tokens: 2, output_tokens: 6 },
      limits: { daily: { limit_usd: '5.000000', spent_usd: '0.125000', remaining_usd: '4.875000' } },
    } });
    if (req.url?.startsWith('/v1/models')) return json(200, { object: 'list', data: state.models });
    if (req.url === '/redirect-target') { state.leaked++; return json(200, { wrong: true }); }
    const kind = Object.keys(pathFor).find(x => pathFor[x] === req.url);
    if (!kind) return json(404, { error: { message: 'fixture route not found' } });
    if (body.fixture_mode === '402') return json(402, { error: { code: 'insufficient_credits', message: 'fixture no credits' } });
    if (body.fixture_mode === '503') return json(503, { error: { code: 'fixture_unavailable', message: 'fixture temporarily unavailable' } });
    if (body.fixture_mode === 'redirect') { res.writeHead(302, { location: '/redirect-target' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-antseed-gateway-tag': 'gateway_fixture', 'x-antseed-request-id': 'request_fixture', 'x-antseed-peer-id': peerId });
    const events = eventsFor(kind, body.fixture_mode === 'tool');
    res.write(events[0]);
    if (body.fixture_mode === 'cancel') {
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 30);
      res.on('close', () => { clearInterval(timer); state.cancelled++; });
      return;
    }
    for (const value of events.slice(1)) { await delay(4); res.write(value); }
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  t.after(async () => { for (const fn of cleanup.reverse()) await fn(); server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  return { dir, state, baseURL, cleanup };
}

async function makeHost(t, f) {
  assert.ok(hostPath, 'Set MAGPIE_HOST_PATH to the unmodified official internal/plugin/host.js.');
  const child = spawn(bun, [resolve(hostPath)], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DO_NOT_TRACK:'1', MAGPIE_NO_STATS:'1', MAGPIE_ANTSEED_DATA_DIR: join(f.dir, 'antseed') } });
  const pending = new Map();
  let next = 0;
  let stderr = '';
  child.stderr.on('data', b => { stderr += b; });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.event === 'head') { p.head = msg; p.onHead?.(msg); return; }
    if (msg.event === 'chunk') {
      const b = Buffer.from(msg.data, 'base64'); p.chunks.push(b); p.onChunk?.(b);
      send({ method: 'credit', params: { id: msg.id, n: b.length + 2048 } });
      return;
    }
    if (!('result' in msg) && !msg.error) return;
    pending.delete(msg.id); clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(p.streaming ? { head: p.head, body: Buffer.concat(p.chunks).toString(), result: msg.result } : msg.result);
  });
  child.on('error', error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); });
  child.on('exit', code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Official host exited ${code}: ${stderr}`)); } pending.clear(); });
  function begin(method, params = {}, options = {}) {
    const id = ++next;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out: ${stderr}`)); }, 15000);
      pending.set(id, { resolve, reject, timer, chunks: [], streaming: method === 'fetch', ...options });
      send({ id, method, params });
    });
    return { id, promise, cancel() { send({ method: 'abort', params: { id } }); const p = pending.get(id); if (p) { pending.delete(id); clearTimeout(p.timer); p.resolve({ cancelled: true }); } } };
  }
  const rpc = (method, params) => begin(method, params).promise;
  f.cleanup.push(async () => {
    child.stdin.end();
    await Promise.race([once(child, 'exit').catch(() => {}), delay(1500)]);
    if (child.exitCode == null) child.kill('SIGTERM');
    lines.close();
  });
  const initialized = await rpc('init', { authPath: join(f.dir, 'plugin-auth.json'), directory: f.dir, plugins: [{ spec: pluginPath, target: pluginPath, options: { includeAutoRoutes: true, includePinnedRoutes: true, dispatchCatalogTtlMs: 0, cooldownMs: 0, allowedPeers: [] } }], loadMillis: 10000, listMillis: 10000 });
  assert.equal(initialized.plugins[0]?.error, undefined, JSON.stringify(initialized));
  const signed = await rpc('apiKey', { provider: 'antseed', method: 1, inputs: { mode: 'gateway', baseURL: f.baseURL, key: 'integration-antseed-key', label: 'Integration' }, proxy: 'direct' });
  assert.equal(signed.ok, true, JSON.stringify(signed));
  const authFile = JSON.parse(await readFile(join(f.dir, 'plugin-auth.json'), 'utf8'));
  assert.equal((await stat(join(f.dir, 'plugin-auth.json'))).mode & 0o777, 0o600);
  return { rpc, begin, signed, authFile, stderr: () => stderr };
}

function fetchParams(f, kind, mode = 'normal') {
  return {
    provider: 'antseed', model: `fixture-${kind}`, npm: sdkFor[kind], url: `${f.baseURL.slice(0, -3)}${pathFor[kind]}`,
    method: 'POST', body: Buffer.from(JSON.stringify(requestBody(kind, mode))).toString('base64'),
    headers: { 'content-type': 'application/json', authorization: 'Bearer caller-secret-must-not-leak', 'x-api-key': 'caller-api-key-must-not-leak', cookie: 'caller-cookie-must-not-leak', 'x-antseed-buyer-identity': 'attacker-identity' },
    proxy: 'direct',
  };
}

test('official Magpie Bun host: native login, dynamic catalog, usage, three streamed APIs and tools', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const host = await makeHost(t, f);
  const providers = await host.rpc('providers');
  const row = providers.find(x => x.id === 'antseed');
  assert.ok(row?.signedIn, JSON.stringify(providers));
  assert.match(row.cli?.name ?? '', /Antseed/);
  assert.deepEqual(await host.rpc('cliInstalled', { provider:'antseed' }), { installed:false }, 'Cold runtime installation has its own Magpie installer phase');
  for (const kind of Object.keys(protocolFor)) {
    assert.ok(row.models.some(x => x.id === `fixture-${kind}`), JSON.stringify(row.models));
    for (const mode of ['normal', 'tool']) {
      const before = f.state.calls.filter(x => x.method === 'POST').length;
      const result = await host.rpc('fetch', fetchParams(f, kind, mode));
      assert.equal(result.head.status, 200);
      assert.match(result.body, mode === 'tool' ? /lookup/ : /integration-ok/);
      assert.equal(result.head.headers['x-antseed-gateway-tag'], 'gateway_fixture');
      assert.equal(f.state.calls.filter(x => x.method === 'POST').length - before, 1, `${kind} ${mode} must dispatch once`);
      const call = f.state.calls.at(-1);
      assert.equal(call.headers.authorization, 'Bearer integration-antseed-key');
      assert.equal(call.headers['x-api-key'], undefined);
      assert.equal(call.headers.cookie, undefined);
      assert.equal(call.headers['x-antseed-buyer-identity'], undefined);
      assert.equal(call.body.service, undefined, 'A caller service field cannot override the verified model');
    }
  }
  const usage = await host.rpc('usage', { provider: 'antseed', account: host.signed.account, proxy: 'direct' });
  assert.match(JSON.stringify(usage), /12\.345678|12\.3457|12\.35/);
  assert.ok(!JSON.stringify(usage).includes('integration-antseed-key'));
  f.state.models.push(model('chat', 'fixture-added'));
  await host.rpc('reload', { provider: 'antseed', account: host.signed.account });
  const refreshed = await host.rpc('providers');
  assert.ok(refreshed.find(x => x.id === 'antseed').models.some(x => x.id === 'fixture-added'), 'models added upstream become visible after refresh');
  f.state.balance = {};
  const unknown = await host.rpc('usage', { provider:'antseed', account:host.signed.account, proxy:'direct' });
  assert.equal(unknown.balance, '', 'An unknown balance is not displayed as zero USDC');
  assert.ok(!unknown.windows.some(x => x.balance === 0));

  const second = await fixture(t);
  const signed2 = await host.rpc('apiKey', { provider:'antseed', account:'new', method:1,
    inputs:{ mode:'gateway', baseURL:second.baseURL, key:'second-fixture-antseed-key', label:'Second' }, proxy:'direct' });
  assert.equal(signed2.ok, true);
  assert.notEqual(signed2.account, host.signed.account);
  const beforeFirst = f.state.calls.filter(x => x.method === 'POST').length;
  const secondCall = await host.rpc('fetch', { ...fetchParams(second, 'chat'), account:signed2.account });
  assert.equal(secondCall.head.status, 200);
  assert.equal(f.state.calls.filter(x => x.method === 'POST').length, beforeFirst);
  assert.equal(second.state.calls.at(-1).headers.authorization, 'Bearer second-fixture-antseed-key');
  const stored = JSON.parse(await readFile(join(f.dir, 'plugin-auth.json'), 'utf8'));
  assert.equal(stored[host.signed.account].metadata.baseURL, f.baseURL);
  assert.equal(stored[signed2.account].metadata.baseURL, second.baseURL);
  assert.ok(!JSON.stringify(await host.rpc('providers')).includes('second-fixture-antseed-key'));
});

test('official Magpie Bun host: status and redirect isolation, one POST, cancellation reaches upstream', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const host = await makeHost(t, f);
  for (const [mode, status] of [['402', 402]]) {
    const before = f.state.calls.filter(x => x.method === 'POST').length;
    const result = await host.rpc('fetch', fetchParams(f, 'chat', mode));
    assert.equal(result.head.status, status);
    assert.equal(f.state.calls.filter(x => x.method === 'POST').length - before, 1);
  }
  const beforeRedirect = f.state.calls.filter(x => x.method === 'POST').length;
  const redirected = await host.rpc('fetch', fetchParams(f, 'chat', 'redirect'));
  assert.equal(redirected.head.status, 502, 'A refused redirect is a safe gateway failure');
  assert.equal(f.state.calls.filter(x => x.method === 'POST').length - beforeRedirect, 1);
  assert.equal(f.state.leaked, 0, 'gateway redirects must not receive the Antseed key');
  let first;
  const firstChunk = new Promise(r => { first = r; });
  const started = host.begin('fetch', fetchParams(f, 'chat', 'cancel'), { onChunk: first });
  await firstChunk;
  started.cancel();
  await started.promise;
  for (let i = 0; i < 40 && !f.state.cancelled; i++) await delay(25);
  assert.equal(f.state.cancelled, 1, 'Magpie abort must cancel the real upstream stream');
  assert.equal(f.state.calls.filter(x => x.body?.fixture_mode === 'cancel').length, 1);
});

async function cliRun(executable, args, env, input = '') {
  note('CLI', args[0], args[1] ?? '');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Magpie ${args[0]} timed out: ${err}`)); }, 45000);
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); note('CLI exit', args[0], code, out.slice(0, 150), err.slice(-5000)); code === 0 ? resolve(out) : reject(new Error(`Magpie ${args.join(' ')} exited ${code}: ${err}\n${out}`)); });
    child.stdin.end(input);
  });
}

test('official Magpie Go gateway: local plugin install, saved account, three HTTP APIs and tool streams', { timeout: 150000, skip: !binary && 'Set MAGPIE_BINARY_PATH to the official CLI binary for full HTTP integration.' }, async t => {
  const f = await fixture(t);
  const host = await makeHost(t, f);
  const portable = join(f.dir, 'portable');
  const data = join(portable, 'data');
  await mkdir(data, { recursive: true });
  const executable = join(portable, process.platform === 'win32' ? 'magpie.exe' : 'magpie');
  await copyFile(resolve(binary), executable);
  await writeFile(join(portable, '.portable'), 'isolated integration test\n');
  // Official internal/stats.Off explicitly checks both switches before any
  // telemetry request; every Magpie child in this fixture inherits them.
  const env = { ...process.env, DO_NOT_TRACK: '1', MAGPIE_NO_STATS: '1', MAGPIE_NO_ACCOUNTS: '1', MAGPIE_BUN: bun, MAGPIE_PLUGIN_CATALOG: 'off', MAGPIE_ANTSEED_DATA_DIR: join(f.dir, 'antseed'), BUN_INSTALL_CACHE_DIR: join(f.dir, 'bun-cache') };
  await writeFile(join(data, 'settings.json'), JSON.stringify({ noStats:true, noUsageStats:true, pluginProxy:'direct' }));
  const where = await cliRun(executable, ['data'], env);
  assert.ok(where.includes(data), `Magpie must use its portable test data: ${where}`);
  await cliRun(executable, ['plugin', 'add', pluginPath], env);
  const initialOptions = { includeAutoRoutes:true, includePinnedRoutes:true, dispatchCatalogTtlMs:0, allowedPeers:[], maxInputUsdPerMillion:0.75,
    rules:{ 'fixture-chat':{ maxOutputUsdPerMillion:0.6 } } };
  await cliRun(executable, ['plugin', 'options', pluginPath, JSON.stringify(initialOptions)], env);
  const manifest = JSON.parse(await readFile(join(pluginPath, 'package.json'), 'utf8'));
  const dockerSeed = join(dirname(resolve(pluginPath, manifest.main)), 'bin/docker-settings.mjs');
  await cliRun(process.execPath, [dockerSeed, executable, pluginPath], env);
  const seeded = JSON.parse(await cliRun(executable, ['plugin', 'options', pluginPath], env));
  assert.deepEqual(seeded, { gatewayPort:18379, buyerPort:18377, ...initialOptions }, 'Docker writes actual ports while preserving purchase rules');
  const customized = { ...seeded, gatewayPort:18381, buyerPort:18382, maxInputUsdPerMillion:0.5 };
  await cliRun(executable, ['plugin', 'options', pluginPath, JSON.stringify(customized)], env);
  await cliRun(process.execPath, [dockerSeed, executable, pluginPath], env);
  assert.deepEqual(JSON.parse(await cliRun(executable, ['plugin', 'options', pluginPath], env)), customized, 'Repeated Docker startup preserves all customized ports and limits');
  await writeFile(join(data, 'plugin-auth.json'), JSON.stringify(host.authFile), { mode: 0o600 });
  note('CLI plugin list result', await cliRun(executable, ['plugin', 'list'], env));
  const clientKey = 'magpie-integration-key-20261124';
  await cliRun(executable, ['gateway-key', 'add', 'integration', '--key', clientKey], env);
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const reserveWeb = createServer(); reserveWeb.listen(0, '127.0.0.1'); await once(reserveWeb, 'listening');
  const webPort = reserveWeb.address().port; await new Promise(r => reserveWeb.close(r));
  env.MAGPIE_ADDR = `127.0.0.1:${port}`;
  env.MAGPIE_WEB_KEY = 'magpie-web-fixture-key-20261124';
  // Discovery-off also hides authenticated plugin providers in Magpie. Keep
  // discovery on only inside a mount namespace with the user's home hidden,
  // foreign agent overrides removed, and a restricted tool search path.
  // HOME itself stays unchanged; no host config or credentials are opened.
  if (process.platform !== 'linux') throw new Error('Full gateway integration needs Linux bubblewrap for account isolation.');
  const agentEnvSource = await readFile(resolve(dirname(hostPath), '../agentenv/agentenv.go'), 'utf8');
  const agentVars = agentEnvSource.split('var Vars = []string{')[1]?.split('\n}')[0] ?? '';
  for (const [, name] of agentVars.matchAll(/"([A-Z][A-Z0-9_]+)"/g)) delete env[name];
  for (const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','DBUS_SESSION_BUS_ADDRESS','GNOME_KEYRING_CONTROL','SSH_AUTH_SOCK']) delete env[name];
  env.MAGPIE_NO_ACCOUNTS = '0';
  env.MAGPIE_TEST_SANDBOX = f.dir;
  env.PATH = '/usr/bin:/bin';
  const sandboxArgs = ['--die-with-parent', '--ro-bind', '/', '/', '--bind', f.dir, f.dir,
    '--tmpfs', homedir()];
  // A developer may keep the reviewed package or Bun inside their home.
  // Re-expose only those explicit inputs, while all account files stay hidden.
  for (const path of [pluginPath, bun]) if (isAbsolute(path) && path.startsWith(homedir() + sep)) sandboxArgs.push('--ro-bind', path, path);
  sandboxArgs.push('--unshare-pid', '--proc', '/proc', '--dev', '/dev', '--chdir', portable);
  // Current Magpie does not allow errors=pass on Provider plugins. The
  // plugin cannot control Magpie's outer retry/fallback policy.
  const child = spawn('bwrap', [...sandboxArgs, executable, 'serve', `--web=127.0.0.1:${webPort}`], { cwd: portable, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', b => { log += b; note('GO stdout', b.toString().slice(0, 2000)); }); child.stderr.on('data', b => { log += b; note('GO stderr', b.toString().slice(0, 2000)); });
  f.cleanup.push(async () => { child.kill('SIGTERM'); await Promise.race([once(child, 'exit').catch(() => {}), delay(2000)]); if (child.exitCode == null) child.kill('SIGKILL'); });
  const gateway = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${clientKey}`, 'content-type': 'application/json' };
  let listed;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`Magpie exited before ready: ${log}`);
    try {
      const response = await fetch(`${gateway}/v1/models`, { headers, signal: AbortSignal.timeout(1000) });
      if (response.ok) { listed = await response.json(); if (listed.data?.some(x => x.id.includes('fixture-chat'))) break; }
      else if (i % 10 === 0) note('GO models status', response.status, (await response.text()).slice(0, 1000));
    } catch (e) { if (i % 10 === 0) note('GO models error', e.message); }
    await delay(200);
  }
  if (!listed?.data?.some(x => x.id.includes('fixture-chat'))) note('GO gateway readiness failure', JSON.stringify(listed), log);
  assert.ok(listed?.data?.some(x => x.id.includes('fixture-chat')), `Full Magpie gateway did not list the Antseed plugin: ${JSON.stringify(listed)}\n${log}`);
  for (const kind of Object.keys(protocolFor)) {
    const id = listed.data.find(x => x.id === `antseed/fixture-${kind}`)?.id;
    assert.ok(id, `Missing automatic route for ${kind}: ${JSON.stringify(listed.data.map(x => x.id))}`);
    for (const mode of ['normal', 'tool']) {
      const before = f.state.calls.filter(x => x.method === 'POST').length;
      const response = await fetch(`${gateway}${pathFor[kind]}`, { method: 'POST', headers, body: JSON.stringify({ ...requestBody(kind, mode), model: id }), signal: AbortSignal.timeout(15000) });
      const text = await response.text();
      assert.equal(response.status, 200, `${kind}: ${text}\n${log}`);
      assert.match(text, mode === 'tool' ? /lookup/ : /integration-ok/);
      assert.equal(f.state.calls.filter(x => x.method === 'POST').length - before, 1, `Full gateway ${kind} ${mode} makes one inference request`);
      assert.equal(f.state.calls.at(-1).headers.authorization, 'Bearer integration-antseed-key');
      assert.equal(f.state.calls.at(-1).body.service, undefined, 'The real Go path also removes a conflicting service override');
    }
  }
  const aborted = new AbortController();
  const cancelBefore = f.state.calls.filter(x => x.method === 'POST').length;
  const cancelResponse = await fetch(`${gateway}${pathFor.chat}`, { method:'POST', headers,
    body:JSON.stringify({ ...requestBody('chat', 'cancel'), model:'antseed/fixture-chat' }), signal:aborted.signal });
  assert.equal(cancelResponse.status, 200);
  const cancelReader = cancelResponse.body.getReader();
  await cancelReader.read();
  aborted.abort();
  await cancelReader.cancel().catch(() => {});
  for (let i = 0; i < 50 && !f.state.cancelled; i++) await delay(25);
  assert.equal(f.state.cancelled, 1, 'Client abort reaches upstream through the real Go gateway');
  assert.equal(f.state.calls.filter(x => x.method === 'POST').length - cancelBefore, 1);
  for (const [kind, mode, status] of [['messages', '402', 402]]) {
    const before = f.state.calls.filter(x => x.method === 'POST').length;
    const response = await fetch(`${gateway}${pathFor[kind]}`, { method:'POST', headers,
      body:JSON.stringify({ ...requestBody(kind, mode), model:`antseed/fixture-${kind}` }), signal:AbortSignal.timeout(10000) });
    assert.equal(response.status, status, await response.text());
    assert.equal(f.state.calls.filter(x => x.method === 'POST').length - before, 1, `${status} fixture is dispatched once by the actual Go gateway`);
  }
  const web = `http://127.0.0.1:${webPort}`;
  const signIn = await fetch(`${web}/?k=${env.MAGPIE_WEB_KEY}`, { redirect:'manual' });
  assert.equal(signIn.status, 303);
  const cookie = signIn.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const pagesResponse = await fetch(`${web}/api/plugin-pages`, { headers:{ cookie } });
  assert.equal(pagesResponse.status, 200);
  const pages = await pagesResponse.json();
  const page = pages.find(x => x.spec === pluginPath);
  assert.ok(page?.url, JSON.stringify(pages));
  assert.deepEqual(page.reads, []);
  const htmlResponse = await fetch(new URL(page.url, web), { headers:{ origin:'null' } });
  const html = await htmlResponse.text();
  assert.equal(htmlResponse.status, 200);
  assert.match(html, /Antseed/);
  assert.ok(htmlResponse.headers.get('content-security-policy'));
  assert.ok(!html.includes('integration-antseed-key'));
  assert.doesNotMatch(html, /<script[^>]*type=["']module["']/i, 'Magpie sandbox pages need classic scripts: module fetches have no CORS permission');
  const pageBase = new URL('.', new URL(page.url, web));
  for (const asset of ['app.js', 'style.css', 'icon.svg', '_magpie/bridge.js']) {
    const response = await fetch(new URL(asset, pageBase), { headers:{ origin:'null' } });
    assert.equal(response.status, 200, `${asset} must be served by the real Magpie web host`);
    assert.ok((await response.text()).length > 10);
  }
  const optsResponse = await fetch(`${web}/api/plugin-pages/options`, { method:'POST', headers:{cookie, origin:web, 'content-type':'application/json'}, body:JSON.stringify({spec:pluginPath}) });
  assert.equal(optsResponse.status, 200);
  const exposedOptions = await optsResponse.text();
  assert.ok(!exposedOptions.includes('integration-antseed-key'));
  assert.ok(!exposedOptions.includes(f.baseURL));
});

export { fixture, requestBody, eventsFor, pathFor, protocolFor, sdkFor, model };
