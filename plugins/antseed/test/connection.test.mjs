import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBaseURL, validateRequestTarget, inferenceHeaders, resolveConnection, fetchKeyInfo, usageFromKeyInfo, runtimeOptions } from '../lib/connection.mjs';
import { normalizeOptions } from '../lib/catalog.mjs';

test('base URLs normalize root/subpath/v1 but refuse embedded secrets, redirects and plaintext remote', () => {
  assert.equal(validateBaseURL('http://127.0.0.1:8379/'), 'http://127.0.0.1:8379/v1');
  assert.equal(validateBaseURL('https://example.test/api/v1/'), 'https://example.test/api/v1');
  assert.equal(validateBaseURL('http://[::1]:8379'), 'http://[::1]:8379/v1');
  for (const bad of ['https://user:secret@example.test', 'https://example.test/?key=secret', 'https://example.test/#secret', 'file:///tmp/x', 'http://example.test', 'http://127.0.0.2:9000']) assert.throws(() => validateBaseURL(bad));
  assert.equal(validateBaseURL('http://antseed:8379', { allowInsecureHttp: true }), 'http://antseed:8379/v1');
});

test('inference URL scope forbids other origins and administrative endpoints', () => {
  const base = 'https://example.test/gateway/v1';
  assert.equal(validateRequestTarget(`${base}/messages?beta=true`, base).path, '/messages');
  for (const path of ['https://attacker.test/v1/messages', `${base}/key/topup`, `${base}/../console/api`, `${base}/messages/other`, `${base}/messages?api_key=secret`, 'https://u:p@example.test/gateway/v1/messages']) assert.throws(() => validateRequestTarget(path, base));
});

test('only protocol headers survive; caller keys, cookies and routing overrides are discarded', () => {
  const routingOverrides = ['x-antseed-provider', 'x-antseed-service', 'x-antseed-prefer-peer', 'x-antseed-routing-policy', 'x-antseed-gateway-auth', 'x-antseed-spending-auth', 'x-antseed-gateway-key', 'x-antseed-buyer-identity', 'x-antseed-attribution-tag'];
  const headers = inferenceHeaders({ ...Object.fromEntries(routingOverrides.map(name => [name, 'untrusted'])), authorization: 'Bearer other', cookie: 'secret', 'x-api-key': 'wrong', 'x-antseed-pin-peer': 'wrong', host: 'evil', 'x-magpie-caller-agent': 'private', 'anthropic-version': '2023-06-01', 'content-length': '100', 'idempotency-key': 'request-123' }, 'real-key', { peerId: 'a'.repeat(40) });
  assert.equal(headers.get('authorization'), 'Bearer real-key');
  assert.equal(headers.get('x-antseed-pin-peer'), 'a'.repeat(40));
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.get('idempotency-key'), 'request-123');
  for (const key of [...routingOverrides, 'cookie', 'x-api-key', 'host', 'x-magpie-caller-agent', 'content-length']) assert.equal(headers.has(key), false);
});

test('managed accounts reuse stored profile and paths instead of current default profile', async () => {
  let seen;
  const runtime = { ensureManagedGateway: async (options) => { seen = options; return { profile: options.profile, baseURL: 'http://127.0.0.1:8379/v1', apiKey: 'existing' }; } };
  const connection = await resolveConnection({ type: 'api', key: 'saved', metadata: { mode: 'managed', profile: 'existing', dataRoot: '/safe/data' } }, { profile: 'new', dataRoot: '/different', maxInputUsdPerMillion: 1 }, { runtime });
  assert.equal(connection.apiKey, 'existing');
  assert.equal(seen.profile, 'existing');
  assert.equal(seen.dataRoot, '/safe/data');
  assert.equal(seen.policy.maxInputUsdPerMillion, 1);
  assert.equal(own(seen, 'privateKey'), false);
});
function own(o, k) { return Object.hasOwn(o, k); }

test('key read always uses redirect:error and validates official gateway shape', async () => {
  const connection = { baseURL: 'https://gateway.test/v1', apiKey: 'secret' };
  let seen;
  const info = await fetchKeyInfo(connection, {}, { fetchImpl: async (url, init) => { seen = { url, init }; return Response.json({ data: { id: 'key-123', balance: null } }); } });
  assert.equal(info.id, 'key-123');
  assert.equal(seen.url, 'https://gateway.test/v1/key');
  assert.equal(seen.init.redirect, 'error');
  await assert.rejects(fetchKeyInfo(connection, {}, { fetchImpl: async () => Response.json({ data: {} }) }), /Key 信息/);
});

test('unknown/stale balance does not become zero; displayed spend is official key settlement', () => {
  assert.equal(Object.hasOwn(usageFromKeyInfo({ id: 'a', balance: null, usage: {} }), 'balance'), false);
  const result = usageFromKeyInfo({ id: 'a', label: 'Main', balance: { available_usd: '12.345678', stale: true }, usage: { spent_usd: '0.002' }, limits: { daily: { limit_usd: '1', spent_usd: '0.002' } } });
  assert.equal(result.balance, '12.345678 USDC（缓存）');
  assert.equal(result.windows[0].balance, 12.345678);
  assert.equal(result.windows[0].aside, true);
  assert.equal(result.windows[1].amount, 0.002);
  assert.equal(result.windows[2].limit, 1);
});

test('runtime policy maps only official keys, retaining strict zero price caps', () => {
  const mapped = runtimeOptions(normalizeOptions({ maxInputUsdPerMillion: 0, freeOnly: true, preferFree: false, blockedPeers: ['b'.repeat(40)] }));
  assert.deepEqual(mapped.policy, { freeOnly: true, preferFreePeers: false, blockedPeerIds: ['b'.repeat(40)], maxInputUsdPerMillion: 0 });
});
