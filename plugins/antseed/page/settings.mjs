export const PRICE_FIELDS = ['maxInputUsdPerMillion', 'maxOutputUsdPerMillion', 'maxCachedInputUsdPerMillion'];
export const BOOL_FIELDS = ['preferFree', 'freeOnly', 'includeAutoRoutes', 'includePinnedRoutes'];

export function numberOrNull(value, label = 'Price') {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error(`${label}: use a non-negative decimal number.`);
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw new Error(`${label}: value is out of range.`);
  return n;
}

export function lines(value) {
  return [...new Set(String(value ?? '').split(/[\n,]/).map(s => s.trim()).filter(Boolean))];
}

export function validatePeers(value) {
  const list = lines(value);
  for (const id of list) {
    if (!/^(?:0x)?[a-f0-9]{40}$/i.test(id)) throw new Error(`Invalid peer ID: ${id.slice(0,60)}`);
  }
  return list;
}

export function collectSettings(previous, fields, rows) {
  const out = { ...previous };
  for (const key of BOOL_FIELDS) out[key] = Boolean(fields[key]);
  if (!out.includeAutoRoutes && !out.includePinnedRoutes) throw new Error('Enable at least one model entry type.');
  for (const key of PRICE_FIELDS) out[key] = numberOrNull(fields[key], key);
  out.allowedPeers = validatePeers(fields.allowedPeers);
  out.blockedPeers = validatePeers(fields.blockedPeers);
  out.models = lines(fields.models);
  out.rules = Object.create(null);
  for (const row of rows) {
    const model = String(row.model ?? '').trim();
    if (!model || model.length > 300 || /[\x00-\x1f]/.test(model) || ['__proto__','constructor','prototype'].includes(model)) throw new Error('Enter a valid model ID for each rule.');
    if (Object.hasOwn(out.rules, model)) throw new Error(`Duplicate rule: ${model}`);
    const rule = {};
    for (const key of [...PRICE_FIELDS, 'maxMultiplier']) {
      const value = numberOrNull(row[key], `${model} ${key}`);
      if (value !== null) rule[key] = value;
    }
    if (row.freeOnly) rule.freeOnly = true;
    if (!Object.keys(rule).length) throw new Error(`Set a limit for ${model}, or remove its rule.`);
    out.rules[model] = rule;
  }
  return out;
}
