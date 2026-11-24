/** Public Antseed /v1/models catalog -> account-scoped OpenCode models.
 * Prices are the current advertised USD/USDC price per million tokens.
 * A free allowance on a priced offer is not a zero-priced offer.
 */
export const PROTOCOL_NPM = Object.freeze({
  'anthropic-messages': '@ai-sdk/anthropic',
  'openai-responses': '@ai-sdk/openai',
  'openai-chat-completions': '@ai-sdk/openai-compatible',
});
const LIMIT_KEYS = ['maxInputUsdPerMillion', 'maxOutputUsdPerMillion', 'maxCachedInputUsdPerMillion'];
const RULE_KEYS = new Set([...LIMIT_KEYS, 'freeOnly', 'maxMultiplier']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
const record = (v) => v && typeof v === 'object' && !Array.isArray(v);
export const knownPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const saneId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);

export function peerId(value) {
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase().replace(/^0x/, '');
  return /^[a-f0-9]{40}$/.test(v) ? v : null;
}

function nonnegative(value, key) {
  if (value == null) return null;
  if (!knownPrice(value)) throw new TypeError(`${key} must be a non-negative number or null`);
  return value;
}
function ids(value, key, peers = false) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${key} must be an array`);
  return [...new Set(value.map((id) => {
    const parsed = peers ? peerId(id) : (saneId(id) ? id : null);
    if (!parsed) throw new TypeError(`${key} contains an invalid ${peers ? 'peer ID' : 'model ID'}`);
    return parsed;
  }))];
}
function bool(value, fallback, key) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be a boolean`);
  return value;
}
function bounded(value, fallback, min, max, key) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`${key} must be an integer from ${min} to ${max}`);
  return value;
}

export function normalizeOptions(options = {}) {
  if (!record(options)) throw new TypeError('Antseed options must be an object');
  const rules = Object.create(null);
  if (options.rules != null) {
    if (!record(options.rules)) throw new TypeError('rules must map exact model IDs to an object');
    for (const [id, raw] of Object.entries(options.rules)) {
      if (!saneId(id) || !record(raw)) throw new TypeError('Each model rule must have a valid model ID and object');
      for (const key of Object.keys(raw)) if (!RULE_KEYS.has(key)) throw new TypeError(`Unknown model rule field: ${key}`);
      const rule = Object.create(null);
      for (const key of [...LIMIT_KEYS, 'maxMultiplier']) rule[key] = nonnegative(raw[key], key);
      rule.freeOnly = bool(raw.freeOnly, false, 'freeOnly');
      rules[id] = rule;
    }
  }
  return {
    ...options,
    includeAutoRoutes: bool(options.includeAutoRoutes, true, 'includeAutoRoutes'),
    includePinnedRoutes: bool(options.includePinnedRoutes, true, 'includePinnedRoutes'),
    preferFree: bool(options.preferFree, true, 'preferFree'),
    freeOnly: bool(options.freeOnly, false, 'freeOnly'),
    allowInsecureHttp: bool(options.allowInsecureHttp, false, 'allowInsecureHttp'),
    maxInputUsdPerMillion: nonnegative(options.maxInputUsdPerMillion, 'maxInputUsdPerMillion'),
    maxOutputUsdPerMillion: nonnegative(options.maxOutputUsdPerMillion, 'maxOutputUsdPerMillion'),
    maxCachedInputUsdPerMillion: nonnegative(options.maxCachedInputUsdPerMillion, 'maxCachedInputUsdPerMillion'),
    allowedPeers: ids(options.allowedPeers, 'allowedPeers', true),
    blockedPeers: ids(options.blockedPeers, 'blockedPeers', true),
    models: ids(options.models, 'models'),
    rules,
    discoveryTimeoutMs: bounded(options.discoveryTimeoutMs, 10000, 100, 120000, 'discoveryTimeoutMs'),
    dispatchCatalogTtlMs: bounded(options.dispatchCatalogTtlMs, 2000, 0, 5000, 'dispatchCatalogTtlMs'),
    cooldownMs: bounded(options.cooldownMs, 30000, 0, 300000, 'cooldownMs'),
  };
}

/** An absent cached-input rate inherits the fresh-input rate, as official pricing.ts does. */
export function pricesOf(offer) {
  const input = knownPrice(offer?.inputUsdPerMillion) ? offer.inputUsdPerMillion : null;
  const output = knownPrice(offer?.outputUsdPerMillion) ? offer.outputUsdPerMillion : null;
  const cached = offer?.cachedInputUsdPerMillion == null ? input
    : knownPrice(offer.cachedInputUsdPerMillion) ? offer.cachedInputUsdPerMillion : null;
  return { input, output, cached };
}

function hasPaidOrUnknownUnitPrice(offer) {
  if (offer?.unitBillingModels == null) return false;
  if (!record(offer.unitBillingModels)) return true;
  return Object.values(offer.unitBillingModels).some((model) =>
    !record(model) || !Array.isArray(model.components)
      || model.components.some((component) => !knownPrice(component?.priceUsd) || component.priceUsd > 0));
}

export function isFreeOffer(offer) {
  const p = pricesOf(offer);
  return p.input === 0 && p.output === 0 && p.cached === 0 && !hasPaidOrUnknownUnitPrice(offer);
}

function tighter(a, b) { return a == null ? b : b == null ? a : Math.min(a, b); }
export function policyFor(entry, offer, options) {
  const policy = { freeOnly: options.freeOnly };
  for (const key of LIMIT_KEYS) policy[key] = options[key];
  for (const id of new Set([entry.id, offer.serviceId, `${peerId(offer.peerId)}@${offer.serviceId}`])) {
    if (!own(options.rules, id)) continue;
    const rule = options.rules[id];
    policy.freeOnly ||= rule.freeOnly;
    for (const key of LIMIT_KEYS) policy[key] = tighter(policy[key], rule[key]);
    if (rule.maxMultiplier != null) {
      const ref = entry.reference_price;
      if (!knownPrice(ref?.input_usd_per_million) || !knownPrice(ref?.output_usd_per_million)) return null;
      policy.maxInputUsdPerMillion = tighter(policy.maxInputUsdPerMillion, ref.input_usd_per_million * rule.maxMultiplier);
      policy.maxOutputUsdPerMillion = tighter(policy.maxOutputUsdPerMillion, ref.output_usd_per_million * rule.maxMultiplier);
      const cached = knownPrice(ref.cached_input_usd_per_million) ? ref.cached_input_usd_per_million : ref.input_usd_per_million;
      policy.maxCachedInputUsdPerMillion = tighter(policy.maxCachedInputUsdPerMillion, cached * rule.maxMultiplier);
    }
  }
  return policy;
}

export function offerAllowed(entry, offer, options) {
  const id = peerId(offer?.peerId);
  if (!id || !saneId(offer.serviceId) || offer.type && offer.type !== 'text' || offer.health?.status === 'failing') return false;
  if (options.allowedPeers.length && !options.allowedPeers.includes(id)) return false;
  if (options.blockedPeers.includes(id)) return false;
  const policy = policyFor(entry, offer, options);
  if (!policy || policy.freeOnly && !isFreeOffer(offer)) return false;
  const p = pricesOf(offer);
  // Text routes with additional unknown/unit charges cannot be safely price-capped.
  if (hasPaidOrUnknownUnitPrice(offer) && LIMIT_KEYS.some((key) => policy[key] != null)) return false;
  const checks = [[p.input, policy.maxInputUsdPerMillion], [p.output, policy.maxOutputUsdPerMillion],
    [p.cached, policy.maxCachedInputUsdPerMillion ?? policy.maxInputUsdPerMillion]];
  return checks.every(([price, max]) => max == null || price != null && price <= max);
}

function protocols(offer) {
  return new Set([offer.protocol, ...(Array.isArray(offer.protocols) ? offer.protocols : [])].filter((p) => own(PROTOCOL_NPM, p)));
}
export function npmFor(offers) {
  for (const protocol of Object.keys(PROTOCOL_NPM)) if (offers.length && offers.every((offer) => protocols(offer).has(protocol))) return PROTOCOL_NPM[protocol];
  return PROTOCOL_NPM['openai-chat-completions'];
}
function capabilitiesFor(offers) {
  const caps = offers.map((offer) => record(offer.capabilities) ? offer.capabilities : {});
  const all = (key) => caps.length > 0 && caps.every((c) => c[key] === true);
  const limit = (key) => caps.length && caps.every((c) => Number.isSafeInteger(c[key]) && c[key] > 0) ? Math.min(...caps.map((c) => c[key])) : 0;
  const supports = (field, modality) => caps.every((c) => Array.isArray(c[field]) ? c[field].includes(modality) : modality === 'text');
  const input = Object.fromEntries(['text', 'image', 'audio', 'video', 'pdf'].map((m) => [m, supports('inputs', m)]));
  return {
    limit: { context: limit('contextWindow'), output: limit('maxOutputTokens') },
    capabilities: {
      reasoning: all('reasoning'), toolcall: all('toolUse'), attachment: input.image || input.pdf,
      input, output: Object.fromEntries(['text', 'image', 'audio', 'video', 'pdf'].map((m) => [m, supports('outputs', m)])),
    },
  };
}
function costFor(offers) {
  const prices = offers.map(pricesOf);
  if (!prices.length || prices.some((p) => Object.values(p).some((v) => v == null)) || offers.some(hasPaidOrUnknownUnitPrice)) return undefined;
  return { input: Math.max(...prices.map((p) => p.input)), output: Math.max(...prices.map((p) => p.output)),
    cache: { read: Math.max(...prices.map((p) => p.cached)), write: Math.max(...prices.map((p) => p.input)) } };
}
function modelRow(id, name, baseURL, offers, auto = false) {
  const cost = auto ? undefined : costFor(offers);
  const free = offers.length > 0 && offers.every(isFreeOffer);
  return {
    id, name: `${name}${auto ? ' · 自动选商 / 报价待选' : !cost ? ' · 报价未知' : offers.length > 1 ? ' · 卖家报价上界' : ''}`,
    api: { id, url: baseURL, npm: npmFor(offers) },
    ...capabilitiesFor(offers),
    status: 'active', headers: {}, options: {}, variants: {},
    ...(cost ? { cost } : {}), ...(free ? { free: true } : {}),
  };
}

/** routes are private to the plugin; only models is exposed to Magpie. */
export function buildCatalog(data, baseURL, rawOptions = {}) {
  const options = normalizeOptions(rawOptions);
  if (!Array.isArray(data)) throw new TypeError('Antseed /v1/models did not return a data array');
  if (data.length > 10000) throw new TypeError('Antseed catalog is too large');
  const models = Object.create(null);
  const routes = new Map();
  for (const entry of data) {
    if (!record(entry) || entry.type !== 'text' || !saneId(entry.id) || entry.id.includes('@')) continue;
    if (options.models.length && !options.models.includes(entry.id)) continue;
    if (!Array.isArray(entry.peers) || entry.peers.length > 5000) continue;
    const groups = new Map();
    for (const offer of entry.peers) {
      if (!record(offer) || !peerId(offer.peerId) || !saneId(offer.serviceId)) continue;
      const id = `${peerId(offer.peerId)}@${offer.serviceId}`;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(offer);
    }
    const eligible = [];
    for (const [id, offers] of groups) {
      // peer@service does not select a provider within a peer. Every matching
      // provider's offer must fit the policy, rather than advertising one cheap
      // offer and letting the buyer dispatch to a different expensive one.
      if (!offers.every((offer) => offerAllowed(entry, offer, options))) continue;
      const route = { id, modelId: entry.id, peerId: peerId(offers[0].peerId), offers, entry, policy: policyFor(entry, offers[0], options), cost: costFor(offers), free: offers.every(isFreeOffer) };
      eligible.push(route);
      if (options.includePinnedRoutes) {
        models[id] = modelRow(id, `${entry.name || entry.id} @ ${offers[0].displayName || route.peerId.slice(0, 12)}`, baseURL, offers);
        routes.set(id, { auto: false, candidates: [route] });
      }
    }
    if (options.includeAutoRoutes && eligible.length) {
      models[entry.id] = modelRow(entry.id, entry.name || entry.id, baseURL, eligible.flatMap((g) => g.offers), true);
      routes.set(entry.id, { auto: true, candidates: eligible });
    }
  }
  return { models, routes };
}

/** Select exactly one seller before sending a paid POST. Never replay a POST. */
export function selectRoute(catalog, model, options, cooldowns = new Map(), now = Date.now()) {
  const route = catalog.routes.get(model);
  if (!route) throw Object.assign(new Error('该模型当前没有符合采购报价、供应商和模型限制的可用卖家，请刷新模型目录。'), { status: 403, code: 'antseed_route_unavailable' });
  const candidates = route.candidates.filter((c) => (cooldowns.get(c.id) ?? 0) <= now);
  if (!candidates.length) throw Object.assign(new Error('该模型的合格卖家正在故障冷却期，请稍后重试。'), { status: 503, code: 'antseed_seller_cooldown' });
  candidates.sort((a, b) => (options.preferFree ? Number(b.free) - Number(a.free) : 0)
    || (a.cost ? a.cost.input + a.cost.output : Infinity) - (b.cost ? b.cost.input + b.cost.output : Infinity)
    || a.id.localeCompare(b.id));
  return candidates[0];
}
