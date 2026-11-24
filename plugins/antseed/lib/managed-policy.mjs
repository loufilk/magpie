import { createHash } from 'node:crypto';

const CAP_KEYS = ['maxInputUsdPerMillion', 'maxOutputUsdPerMillion', 'maxCachedInputUsdPerMillion'];
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const fail = message => Object.assign(new Error(message), { status:503, code:'antseed_policy_failed', publicMessage:message });

/** Bind model-specific caps to a server-enforced preset, using the same API key
 * and ledger. No prompt, request defaults, wallet or payment is added. */
export async function prepareManagedRoute(connection, route, options, runtimeOptions, runtime, signal) {
  if (connection.mode !== 'managed') return route.id;
  const ids = [route.modelId, route.id, ...route.offers.map(offer => offer.serviceId)];
  if (!ids.some(id => Object.hasOwn(options.rules ?? {}, id))) return route.id;
  signal?.throwIfAborted();
  const policy = route.policy;
  if (!policy) throw fail('此模型的采购规则尚未解析，已停止请求。');
  const routingPolicy = { allowedPeerIds:[route.peerId] };
  for (const key of CAP_KEYS) {
    const cap = policy.freeOnly ? 0 : policy[key];
    if (cap != null) {
      if (!Number.isFinite(cap) || cap < 0) throw fail('此模型的采购限价无效，已停止请求。');
      routingPolicy[key] = cap;
    }
  }
  if (routingPolicy.maxCachedInputUsdPerMillion == null && routingPolicy.maxInputUsdPerMillion != null) {
    routingPolicy.maxCachedInputUsdPerMillion = routingPolicy.maxInputUsdPerMillion;
  }
  if (!CAP_KEYS.some(key => routingPolicy[key] != null)) return route.id;
  if (typeof runtime?.managementRequest !== 'function' || !connection.workspaceId || route.id.length > 200) {
    throw fail('无法把此模型的采购限价写入托管 Gateway，已停止请求。');
  }
  const expected = { workspaceId:connection.workspaceId, model:route.id, routingPolicy, systemPrompt:null, params:{} };
  const hash = createHash('sha256').update(stable(expected)).digest('hex').slice(0,32);
  const slug = `magpie-${hash}`;
  const path = `/presets?workspace=${encodeURIComponent(connection.workspaceId)}`;
  const matches = row => row?.slug === slug && row.workspaceId === expected.workspaceId
    && row.model === expected.model && row.systemPrompt === null && stable(row.params) === '{}'
    && stable(row.routingPolicy) === stable(routingPolicy);
  const read = async () => {
    const response = await runtime.managementRequest(path, { method:'GET', signal }, runtimeOptions);
    if (!response.ok) { await response.body?.cancel(); throw fail(`Gateway 采购规则读取失败（HTTP ${response.status}），已停止请求。`); }
    const rows = await response.json();
    if (!Array.isArray(rows)) throw fail('Gateway 采购规则返回格式错误，已停止请求。');
    const sameSlug = rows.filter(row => row?.slug === slug);
    if (!sameSlug.length) return null;
    if (sameSlug.length !== 1 || !matches(sameSlug[0])) throw fail('Gateway 中同名采购规则被修改，请在控制台检查。已停止请求。');
    return sameSlug[0];
  };
  if (await read()) return `@preset/${slug}`;
  const response = await runtime.managementRequest('/presets', {
    method:'POST', signal, headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ ...expected, slug, name:`Magpie ${route.modelId}`.slice(0,100), confirmEmpty:true }),
  }, runtimeOptions);
  if (response.status === 409) {
    await response.body?.cancel();
    if (await read()) return `@preset/${slug}`;
    throw fail('Gateway 采购规则冲突，已停止请求。');
  }
  if (!response.ok) { await response.body?.cancel(); throw fail(`Gateway 采购规则保存失败（HTTP ${response.status}），已停止请求。`); }
  if (!matches(await response.json())) throw fail('Gateway 没有确认相同的采购限价，已停止请求。');
  return `@preset/${slug}`;
}
