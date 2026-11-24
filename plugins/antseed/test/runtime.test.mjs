import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buyerConfig, createRuntimeManager, isManagedRuntimeInstalled, normalizeRuntimePolicy, runtimePaths } from '../lib/runtime.mjs';

const fixture = fileURLToPath(new URL('./fixtures/runtime-cli.mjs', import.meta.url));
const manager = () => createRuntimeManager({ prepareRuntime: async (options) => ({ nodePath: process.execPath, cliPath: fixture, runtimeDir: runtimePaths(options).runtimeDir }) });
async function context(t) {
  const root = await mkdtemp(join(tmpdir(), 'magpie-antseed-runtime-'));
  const runtime = manager();
  const options = { dataRoot: root, profile: 'testing', startupTimeoutMs: 10_000 };
  t.after(async () => { await runtime.stopManagedGateway('testing', options); await rm(root, { recursive: true, force: true }); });
  return { root, runtime, options, paths: runtimePaths(options) };
}

test('runtime paths reject traversal and never use a caller profile as a path', () => {
  for (const profile of ['..', '../wallet', 'x/y', '\\wallet', '', 'x'.repeat(49)]) assert.throws(() => runtimePaths({ profile }));
  assert.equal(runtimePaths({ dataRoot: '/tmp/antseed-test', profile: 'profile-1' }).dataDir, '/tmp/antseed-test/profiles/profile-1/antseed');
});

test('free-only has zero input, output and cache caps in the official buyer configuration', () => {
  const config = buyerConfig({ freeOnly: true, maxInputUsdPerMillion: 500, maxOutputUsdPerMillion: 800 }, 18888);
  assert.deepEqual(config.buyer.maxPricing.defaults, { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0 });
  assert.equal(config.buyer.routingPreferences.maxInputUsdPerMillion, 0);
  assert.throws(() => normalizeRuntimePolicy({ maxInputUsdPerMillion: NaN }));
  assert.throws(() => normalizeRuntimePolicy({ maxOutputUsdPerMillion: -1 }));
  assert.throws(() => normalizeRuntimePolicy({ modelRoutes: {} }));
  assert.throws(() => normalizeRuntimePolicy({ allowedPeerIds: ['invalid'] }));
});

test('reading status and requesting console before initialization create no wallet', async (t) => {
  const { runtime, options, paths } = await context(t);
  const status = await runtime.runtimeStatus(options);
  assert.equal(status.initialized, false);
  assert.equal(status.running, false);
  await assert.rejects(runtime.consoleLink(options), /not been initialized/);
  await assert.rejects(stat(paths.profileDir), { code: 'ENOENT' });
  assert.equal(await isManagedRuntimeInstalled(options), false);
  await assert.rejects(stat(paths.profileDir), { code: 'ENOENT' });
});

test('package manifests without successful native validation are not installed', async (t) => {
  const { options, paths } = await context(t);
  for (const [name, version] of [['cli', '0.1.259'], ['router-local', '0.1.54'], ['antseed-verifier', '0.1.10']]) {
    const directory = join(paths.runtimeDir, 'node_modules', '@antseed', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ version }));
  }
  assert.equal(await isManagedRuntimeInstalled(options), false);
});

test('concurrent setup spawns once, persists secrets privately, and reuses the same key after restart', async (t) => {
  const { runtime, options, paths } = await context(t);
  const connections = await Promise.all(Array.from({ length: 8 }, () => runtime.ensureManagedGateway(options)));
  assert.equal(new Set(connections.map((conn) => conn.apiKey)).size, 1);
  const fixtureState = () => readFile(join(paths.dataDir, 'fixture.json'), 'utf8').then(JSON.parse);
  assert.equal((await fixtureState()).starts, 1);
  assert.equal((await fixtureState()).creates, 1);
  assert.equal((await fixtureState()).parentProtocol.stdin, '1');
  assert.equal((await fixtureState()).parentProtocol.pid, String(process.pid));
  assert.equal((await fixtureState()).pluginDir, paths.runtimeDir);
  if (process.platform !== 'win32') {
    assert.equal((await stat(paths.credentialsPath)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.profileDir)).mode & 0o777, 0o700);
  }
  const status = await runtime.runtimeStatus(options);
  assert.equal(status.running, true);
  assert.equal(JSON.stringify(status).includes('fixture_secret'), false);
  const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  assert.equal((await fetch(`http://127.0.0.1:${state.controlPort}/stop`, { method: 'POST' })).status, 401);
  assert.equal((await runtime.runtimeStatus(options)).running, true);
  assert.equal((await runtime.managementRequest('/status', {}, options)).status, 200);
  await runtime.stopManagedGateway('testing', options);
  assert.equal((await runtime.runtimeStatus(options)).running, false);
  const after = await runtime.ensureManagedGateway(options);
  assert.equal(after.apiKey, connections[0].apiKey);
  assert.equal((await fixtureState()).starts, 2);
  assert.equal((await fixtureState()).creates, 1);
});

test('a second runtime attaches via authenticated controller and can stop without signaling stored PIDs', async (t) => {
  const { runtime, options } = await context(t);
  const first = await runtime.ensureManagedGateway(options);
  const observer = manager();
  const second = await observer.ensureManagedGateway(options);
  assert.equal(first.baseURL, second.baseURL);
  assert.equal(first.keyId, second.keyId);
  assert.equal((await observer.stopManagedGateway('testing', options)).stopped, true);
  assert.equal((await runtime.runtimeStatus(options)).running, false);
});

test('simultaneous recovery of a stale setup lock starts only one gateway', async (t) => {
  const { runtime, options, paths } = await context(t);
  await mkdir(paths.profileDir, { recursive: true });
  await writeFile(join(paths.profileDir, '.setup.lock'), JSON.stringify({ pid: 2147483647, owner: 'dead-owner' }));
  const observer = manager();
  const [one, two] = await Promise.all([runtime.ensureManagedGateway(options), observer.ensureManagedGateway(options)]);
  assert.equal(one.baseURL, two.baseURL);
  const fixtureState = JSON.parse(await readFile(join(paths.dataDir, 'fixture.json'), 'utf8'));
  assert.equal(fixtureState.starts, 1);
  assert.equal(fixtureState.creates, 1);
});

test('policy updates restart the owned runtime and preserve its key', async (t) => {
  const { runtime, options, paths } = await context(t);
  const first = await runtime.ensureManagedGateway(options);
  const next = await runtime.ensureManagedGateway({ ...options, policy: { freeOnly: true } });
  assert.equal(next.keyId, first.keyId);
  const stored = JSON.parse(await readFile(join(paths.dataDir, 'fixture.json'), 'utf8'));
  assert.equal(stored.starts, 2);
  assert.equal(stored.policy.maxInputUsdPerMillion, 0);
  assert.equal(stored.policy.maxOutputUsdPerMillion, 0);
  assert.equal(stored.policy.maxCachedInputUsdPerMillion, 0);
});

test('managed config updates retain console-configured RPC and unrelated buyer settings', async (t) => {
  const { runtime, options, paths } = await context(t);
  await mkdir(paths.profileDir, { recursive: true });
  await writeFile(paths.configPath, JSON.stringify({ payments: { crypto: { rpcUrl: 'https://rpc.example.test' } }, buyer: { requestTimeoutMs: 43210, autoSweep: false } }));
  await runtime.ensureManagedGateway(options);
  const config = JSON.parse(await readFile(paths.configPath, 'utf8'));
  assert.equal(config.payments.crypto.rpcUrl, 'https://rpc.example.test');
  assert.equal(config.buyer.requestTimeoutMs, 43210);
  assert.equal(config.buyer.autoSweep, false);
});

test('startup cancellation closes the child and retains the initialized credential', async (t) => {
  const { runtime, options, paths } = await context(t);
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(join(paths.dataDir, 'fixture.json'), JSON.stringify({ creates: 0, starts: 0, keys: [], startDelay: 5000 }));
  const controller = new AbortController();
  const setup = runtime.ensureManagedGateway({ ...options, signal: controller.signal, onProgress: () => setTimeout(() => controller.abort(new Error('test cancelled')), 50) });
  await assert.rejects(setup, /test cancelled/);
  assert.equal((await runtime.runtimeStatus(options)).running, false);
  assert.equal((await runtime.runtimeStatus(options)).initialized, true);
});

test('cancelling one shared startup caller does not cancel the other caller', async (t) => {
  const { runtime, options, paths } = await context(t);
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(join(paths.dataDir, 'fixture.json'), JSON.stringify({ creates: 0, starts: 0, keys: [], startDelay: 300 }));
  const controller = new AbortController();
  const cancelled = runtime.ensureManagedGateway({ ...options, signal: controller.signal, onProgress: () => controller.abort(new Error('first caller cancelled')) });
  const remaining = runtime.ensureManagedGateway(options);
  await assert.rejects(cancelled, /first caller cancelled/);
  const result = await remaining;
  assert.equal(result.mode, 'managed');
  assert.equal((await runtime.runtimeStatus(options)).running, true);
  const stored = JSON.parse(await readFile(join(paths.dataDir, 'fixture.json'), 'utf8'));
  assert.equal(stored.starts, 1);
  assert.equal(stored.creates, 1);
});

test('a waiting caller aborts promptly while another caller still owns startup', async (t) => {
  const { runtime, options, paths } = await context(t);
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(join(paths.dataDir, 'fixture.json'), JSON.stringify({ creates: 0, starts: 0, keys: [], startDelay: 300 }));
  const controller = new AbortController();
  let firstFinished = false;
  const first = runtime.ensureManagedGateway(options).then((value) => { firstFinished = true; return value; });
  const second = runtime.ensureManagedGateway({ ...options, signal: controller.signal });
  controller.abort(new Error('waiting caller cancelled'));
  await assert.rejects(second, /waiting caller cancelled/);
  assert.equal(firstFinished, false);
  await first;
  assert.equal((await runtime.runtimeStatus(options)).running, true);
});

test('a crash between spawn and PID persistence cannot reopen the same wallet', async (t) => {
  const { runtime, options, paths } = await context(t);
  await mkdir(paths.profileDir, { recursive: true });
  await writeFile(paths.statePath, JSON.stringify({ version: 1, phase: 'starting', ownerPid: 2147483647,
    controlPort: 61001, gatewayPort: 61002, buyerPort: 61003, token: 'a'.repeat(64), generation: 'b'.repeat(32) }));
  await assert.rejects(runtime.ensureManagedGateway(options), /interrupted before its child PID was recorded/);
  await assert.rejects(stat(paths.credentialsPath), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(paths.statePath, 'utf8')).phase, 'starting');
});

test('an unbound live gateway PID prevents wallet reopening even with free ports', async (t) => {
  const { runtime, options, paths } = await context(t);
  await mkdir(paths.profileDir, { recursive: true });
  // This process stands in for a live child. The manager may check it, never signal it.
  await writeFile(paths.statePath, JSON.stringify({ version: 1, phase: 'starting', ownerPid: 2147483647, childPid: process.pid,
    controlPort: 61004, gatewayPort: 61005, buyerPort: 61006, token: 'c'.repeat(64), generation: 'd'.repeat(32) }));
  await assert.rejects(runtime.ensureManagedGateway(options), /owner or gateway is still alive/);
  await assert.rejects(stat(paths.credentialsPath), { code: 'ENOENT' });
});
