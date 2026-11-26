import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../bin/antseed-network-diagnose.mjs', import.meta.url));
const preload = new URL('./fixtures/diagnostic-preload.mjs', import.meta.url).href;
// Minimal projection of the status counts reported in the user's Core acceptance.
const coreStatus = JSON.parse(readFileSync(new URL('./fixtures/core-buyer-status-20261126.json', import.meta.url), 'utf8'));

function diagnose(status, { stdin = false, httpStatus = 200 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'antseed-diagnostic-test-'));
  try {
    const entry = stdin ? ['--input-type=module', '-'] : [script];
    const result = spawnSync(process.execPath, ['--import', preload, ...entry, '--data-root', home, '--buyer-port', '28377', '--seconds', '0'], {
      cwd: fileURLToPath(new URL('../bin/', import.meta.url)),
      env: {
        HOME: home,
        XDG_DATA_HOME: home,
        MAGPIE_ANTSEED_RUNTIME_DIR: join(home, 'runtime'),
        ANTSEED_DIAGNOSTIC_TEST_STATUS: JSON.stringify(status),
        ANTSEED_DIAGNOSTIC_TEST_HTTP_STATUS: String(httpStatus),
      },
      input: stdin ? readFileSync(script, 'utf8') : undefined,
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    const records = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.some(row => row.check === 'fatal'), false, result.stdout);
    const buyer = records.find(row => row.check === 'buyer');
    const summary = records.find(row => row.check === 'result');
    assert.ok(buyer, result.stdout);
    assert.ok(summary, result.stdout);
    assert.equal(summary.inferencePosts, 0);
    assert.equal(summary.paymentPosts, 0);
    return { exitCode: result.status, buyer, summary };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function expectDiscovery(status, counts, observed, options) {
  const result = diagnose(status, options);
  assert.equal(result.exitCode, observed ? 0 : 2);
  assert.deepEqual({ dhtNodes: result.buyer.dhtNodes, peers: result.buyer.peers }, counts);
  assert.equal(result.summary.discoveryObserved, observed);
  return result;
}

test('Core Buyer status with 99 DHT nodes and 105 peers exits successfully', () => {
  expectDiscovery(coreStatus, { dhtNodes: 99, peers: 105 }, true);
});

test('Core Buyer status also succeeds with the Docker stdin invocation', () => {
  expectDiscovery(coreStatus, { dhtNodes: 99, peers: 105 }, true, { stdin: true });
});

test('legacy Buyer status fields remain supported', () => {
  expectDiscovery({ dhtNodes: 12, peers: 8 }, { dhtNodes: 12, peers: 8 }, true);
});

test('each discovery count independently accepts its current or legacy field', () => {
  expectDiscovery({ dhtNodeCount: 99, peers: 105 }, { dhtNodes: 99, peers: 105 }, true);
  expectDiscovery({ dhtNodes: 99, peerCount: 105 }, { dhtNodes: 99, peers: 105 }, true);
});

test('current fields take precedence, including zero counts', () => {
  for (const [dhtNodeCount, peerCount] of [[99, 105], [0, 105], [99, 0], [0, 0]]) {
    expectDiscovery({ dhtNodeCount, peerCount, dhtNodes: 12, peers: 8 },
      { dhtNodes: dhtNodeCount, peers: peerCount }, dhtNodeCount > 0 && peerCount > 0);
  }
});

test('null current fields fall back to legacy counts', () => {
  expectDiscovery({ dhtNodeCount: null, peerCount: null, dhtNodes: 12, peers: 8 }, { dhtNodes: 12, peers: 8 }, true);
});

test('missing or invalid counts remain unknown and fail discovery', () => {
  expectDiscovery(null, { dhtNodes: null, peers: null }, false);
  expectDiscovery({}, { dhtNodes: null, peers: null }, false);
  for (const value of [undefined, null, '99', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, true, [], {}]) {
    expectDiscovery({ dhtNodeCount: value, peerCount: 105 }, { dhtNodes: null, peers: 105 }, false);
    expectDiscovery({ dhtNodeCount: 99, peerCount: value }, { dhtNodes: 99, peers: null }, false);
  }
  for (const value of ['99', -1]) {
    expectDiscovery({ dhtNodeCount: value, peerCount: 105, dhtNodes: 12, peers: 8 }, { dhtNodes: null, peers: 105 }, false);
    expectDiscovery({ dhtNodes: 99, peers: value }, { dhtNodes: 99, peers: null }, false);
  }
});

test('unavailable Buyer status exits with discovery failure', () => {
  const result = expectDiscovery(coreStatus, { dhtNodes: null, peers: null }, false, { httpStatus: 503 });
  assert.equal(result.buyer.error, 'HTTP_503');
});
