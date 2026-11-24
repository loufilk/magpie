import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, normalizeOptions, isFreeOffer, pricesOf, selectRoute } from '../lib/catalog.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const base = 'http://127.0.0.1:8379/v1';
function offer(id = A, price = 1, extra = {}) {
  return { peerId: id, serviceId: 'model-native', type: 'text', protocol: 'anthropic-messages', protocols: ['anthropic-messages'],
    inputUsdPerMillion: price, outputUsdPerMillion: price * 3,
    capabilities: { contextWindow: 200000, maxOutputTokens: 8192, inputs: ['text', 'image'], outputs: ['text'], reasoning: true, toolUse: true }, ...extra };
}
function entry(peers = [offer()], extra = {}) { return { id: 'model', name: 'Model', type: 'text', peers, ...extra }; }

test('native peer models carry accurate capability and price shapes; aliases have no invented execution price', () => {
  const catalog = buildCatalog([entry([offer(A, 1, { cachedInputUsdPerMillion: 0.1 })])], base);
  const row = catalog.models[`${A}@model-native`];
  assert.equal(row.api.npm, '@ai-sdk/anthropic');
  assert.deepEqual(row.cost, { input: 1, output: 3, cache: { read: 0.1, write: 1 } });
  assert.equal(row.capabilities.toolcall, true);
  assert.equal(row.capabilities.input.image, true);
  assert.equal(row.limit.context, 200000);
  assert.equal(Object.hasOwn(catalog.models.model, 'cost'), false);
});

test('zero prices are free only with known input/output and no paid cached/unit charge', () => {
  assert.equal(isFreeOffer({}), false);
  assert.equal(isFreeOffer({ outputUsdPerMillion: 0 }), false);
  assert.equal(isFreeOffer(offer(A, 0)), true);
  assert.equal(isFreeOffer(offer(A, 0, { cachedInputUsdPerMillion: 1 })), false);
  assert.equal(isFreeOffer(offer(A, 1, { freeTier: { requests: 1000 } })), false);
  assert.equal(isFreeOffer(offer(A, 0, { unitBillingModels: { chat: { components: [{ priceUsd: 1 }] } } })), false);
  assert.equal(isFreeOffer(offer(A, 0, { unitBillingModels: { chat: { components: [{ priceUsd: 0 }] } } })), true);
  assert.deepEqual(pricesOf(offer(A, 2)), { input: 2, output: 6, cached: 2 });
});

test('global and per-model caps intersect, deny unknown prices, and check cached fallback', () => {
  const peers = [offer(A, 1), offer(B, 0.4), offer('c'.repeat(40), 0.1, { outputUsdPerMillion: undefined })];
  let c = buildCatalog([entry(peers)], base, { maxInputUsdPerMillion: 0.5, maxOutputUsdPerMillion: 2 });
  assert.deepEqual(c.routes.get('model').candidates.map((c) => c.peerId), [B]);
  c = buildCatalog([entry(peers)], base, { maxInputUsdPerMillion: 0.5, rules: { model: { maxInputUsdPerMillion: 2 } } });
  assert.equal(c.routes.get('model').candidates.some((c) => c.peerId === A), false);
  c = buildCatalog([entry([offer(A, 0.1, { cachedInputUsdPerMillion: 3 })])], base, { maxInputUsdPerMillion: 0.2 });
  assert.equal(c.routes.size, 0);
});

test('relative caps require official reference prices and cap each token class independently', () => {
  const options = { rules: { model: { maxMultiplier: 0.1 } } };
  assert.equal(buildCatalog([entry()], base, options).routes.size, 0);
  const reference_price = { input_usd_per_million: 10, output_usd_per_million: 30, cached_input_usd_per_million: 2 };
  assert.equal(buildCatalog([entry([offer(A, 1, { cachedInputUsdPerMillion: 0.2 })], { reference_price })], base, options).routes.size, 2);
  assert.equal(buildCatalog([entry([offer(A, 1, { cachedInputUsdPerMillion: 1 })], { reference_price })], base, options).routes.size, 0);
});

test('allow/block lists and health fail closed; blocking wins', () => {
  const data = [entry([offer(A, 1), offer(B, 0.1, { health: { status: 'failing' } })])];
  assert.equal(buildCatalog(data, base, { allowedPeers: [A], blockedPeers: [A] }).routes.size, 0);
  assert.deepEqual(buildCatalog(data, base, { allowedPeers: [`0x${A}`] }).routes.get('model').candidates.map((c) => c.peerId), [A]);
});

test('a peer with two provider prices cannot evade a cap by exposing its cheap offer', () => {
  const data = [entry([offer(A, 0.1), offer(A, 50)])];
  assert.equal(buildCatalog(data, base, { maxInputUsdPerMillion: 1 }).routes.size, 0);
  assert.equal(buildCatalog(data, base).models[`${A}@model-native`].cost.input, 50);
});

test('unknown individual capabilities are not borrowed from aggregate catalog metadata', () => {
  const c = buildCatalog([entry([offer(A, 1, { capabilities: undefined })], { context_length: 1000000, capabilities: { tool_use: true } })], base);
  assert.equal(c.models[`${A}@model-native`].limit.context, 0);
  assert.equal(c.models[`${A}@model-native`].capabilities.toolcall, false);
  assert.equal(Object.hasOwn(c.models[`${A}@model-native`], 'free'), false);
});

test('auto routes select free/cheap eligible seller and skip cooldown; explicit pins never fail over', () => {
  const options = normalizeOptions({});
  const c = buildCatalog([entry([offer(A, 1), offer(B, 0)])], base, options);
  assert.equal(selectRoute(c, 'model', options).peerId, B);
  const cooldowns = new Map([[`${B}@model-native`, 1000]]);
  assert.equal(selectRoute(c, 'model', options, cooldowns, 500).peerId, A);
  assert.throws(() => selectRoute(c, `${B}@model-native`, options, cooldowns, 500), /冷却/);
  assert.throws(() => selectRoute(c, `${'d'.repeat(40)}@model-native`, options), /限制/);
});

test('invalid policy values cannot silently broaden an intended limit', () => {
  assert.throws(() => normalizeOptions({ freeOnly: 'true' }), /boolean/);
  assert.throws(() => normalizeOptions({ maxInputUsdPerMillion: '0.1' }), /non-negative/);
  assert.throws(() => normalizeOptions({ allowedPeers: ['oops'] }), /peer ID/);
  assert.throws(() => normalizeOptions({ rules: { model: { maxInput: 0.1 } } }), /Unknown/);
  assert.throws(() => normalizeOptions({ dispatchCatalogTtlMs: 9000 }), /5000/);
});

test('non-text services and malformed offers are not callable text models', () => {
  const c = buildCatalog([entry([offer()], { type: 'image' }), entry([{ peerId: A }]), entry([offer()], { id: 'bad\nmodel' })], base);
  assert.equal(c.routes.size, 0);
  assert.throws(() => buildCatalog(null, base), /data array/);
});
