import { createHash } from 'node:crypto';
import { buildCatalog, normalizeOptions, selectRoute } from './catalog.mjs';

export const PROVIDER_ID = 'antseed';
const DEFAULT_BASE = 'http://127.0.0.1:8377/v1';
const REQUEST_PATHS = new Set(['/chat/completions', '/responses', '/messages']);
const FORWARDED_HEADERS = new Set(['accept', 'content-type', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'x-request-id', 'x-client-request-id', 'idempotency-key']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
const record = (v) => v && typeof v === 'object' && !Array.isArray(v);
const defaultRuntime = () => import('./runtime.mjs');

export function validateBaseURL(value, { allowInsecureHttp = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new TypeError('请填写 Antseed Gateway 的 HTTP(S) 地址。');
  let url;
  try { url = new URL(value.trim()); } catch { throw new TypeError('Antseed 地址必须是完整的 HTTP(S) URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Antseed 地址不能包含用户名、密码、查询参数或片段。');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (url.protocol === 'http:' && !loopback && !allowInsecureHttp) {
    throw new TypeError('远程 Gateway 请使用 HTTPS；局域网 HTTP 需在插件设置显式启用 allowInsecureHttp。');
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (/%2f|%5c|%2e/i.test(path) || /\\/.test(path)) throw new TypeError('Antseed 地址包含不支持的路径编码。');
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  return url.href.replace(/\/$/, '');
}

function validKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('请填写有效的 Gateway API Key；不要填写钱包私钥。');
  return value.trim();
}
function profileName(value) {
  const name = String(value ?? 'default').trim() || 'default';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(name)) throw new TypeError('钱包配置名称只能含字母、数字、下划线或连字符，最长 48 个字符。');
  return name;
}
function cleanLabel(value) { return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100) : ''; }
function fingerprint(value) { return createHash('sha256').update(value).digest('hex'); }
function abortIfNeeded(signal) { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); }
function errorWith(message, status, code) { return Object.assign(new Error(message), { status, code }); }
function safeError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '操作已取消或超时；请查询原有配置后重试。';
  return error?.publicMessage || (error instanceof TypeError && !/fetch/i.test(error.message) ? error.message : error?.code?.startsWith('antseed_') ? error.message : 'Antseed 连接未完成，请检查 Gateway 状态和插件日志中的运行状态。');
}
function withTimeout(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function runtimeOptions(options, metadata = {}, signal) {
  const policy = {
    freeOnly: options.freeOnly,
    preferFreePeers: options.preferFree,
  };
  // Gateway policy gives [] the strict meaning "no peer", unlike our UI's
  // empty allow list meaning "all peers". Omit empty lists when forwarding.
  if (options.allowedPeers.length) policy.allowedPeerIds = options.allowedPeers;
  if (options.blockedPeers.length) policy.blockedPeerIds = options.blockedPeers;
  for (const key of ['maxInputUsdPerMillion', 'maxOutputUsdPerMillion', 'maxCachedInputUsdPerMillion']) if (options[key] != null) policy[key] = options[key];
  const result = { profile: profileName(metadata.profile ?? options.profile), signal, policy };
  for (const key of ['dataRoot', 'gatewayPort', 'buyerPort', 'nodePath']) {
    if (metadata[key] !== undefined) result[key] = metadata[key];
    else if (options[key] !== undefined) result[key] = options[key];
  }
  return result;
}

export async function resolveConnection(auth, options = {}, dependencies = {}, signal) {
  const opts = normalizeOptions(options);
  if (auth?.type !== 'api' || !auth.key) throw errorWith('请先在 Magpie 的 Antseed Provider 中初始化本地 Gateway，或连接已有 Gateway。', 401, 'antseed_not_signed_in');
  const metadata = record(auth.metadata) ? auth.metadata : {};
  if (metadata.mode === 'managed') {
    const runtime = dependencies.runtime ?? await defaultRuntime();
    const result = await runtime.ensureManagedGateway(runtimeOptions(opts, metadata, signal));
    return { ...result, baseURL: validateBaseURL(result.baseURL, opts), apiKey: validKey(result.apiKey) };
  }
  if (!['gateway', 'buyer'].includes(metadata.mode)) throw errorWith('这个 Antseed 账号缺少连接类型，请重新登录。', 401, 'antseed_invalid_account');
  return {
    mode: metadata.mode,
    baseURL: validateBaseURL(metadata.baseURL, opts),
    apiKey: validKey(auth.key),
    label: cleanLabel(metadata.label || auth.accountId),
  };
}

async function boundedJSON(response, maxBytes = 8 * 1024 * 1024) {
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) { await response.body?.cancel(); throw errorWith('Antseed 返回的数据超过允许大小。', 502, 'antseed_response_too_large'); }
  if (!response.body) throw errorWith('Antseed 返回了空数据。', 502, 'antseed_invalid_response');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw errorWith('Antseed 返回的数据超过允许大小。', 502, 'antseed_response_too_large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw errorWith('Antseed 返回了无法识别的 JSON 数据。', 502, 'antseed_invalid_response'); }
}

async function readEndpoint(connection, path, { fetchImpl = globalThis.fetch, timeoutMs = 10000, signal } = {}) {
  abortIfNeeded(signal);
  let response;
  try {
    response = await fetchImpl(`${connection.baseURL}${path}`, {
      method: 'GET', headers: { authorization: `Bearer ${connection.apiKey}`, accept: 'application/json' },
      redirect: 'error', signal: withTimeout(signal, timeoutMs),
    });
  } catch (error) {
    abortIfNeeded(signal);
    if (error?.name === 'TimeoutError') throw errorWith('Antseed 目录或余额查询超时。', 504, 'antseed_read_timeout');
    throw errorWith('无法读取 Antseed Gateway，或 Gateway 返回了重定向；为保护 API Key，重定向不会跟随。', 502, 'antseed_read_failed');
  }
  if (!response.ok) {
    await response.body?.cancel();
    const error = errorWith(`Antseed ${path.startsWith('/key') ? '余额/Key' : '模型目录'}查询返回 HTTP ${response.status}。`, response.status, 'antseed_upstream_error');
    if (response.status === 401) error.signIn = 'expired';
    throw error;
  }
  return boundedJSON(response);
}

export async function fetchCatalog(connection, options = {}, dependencies = {}, signal) {
  const opts = normalizeOptions(options);
  const payload = await readEndpoint(connection, '/models?type=text', { ...dependencies, timeoutMs: opts.discoveryTimeoutMs, signal });
  try { return buildCatalog(payload?.data, connection.baseURL, opts); }
  catch { throw errorWith('Antseed 模型目录格式不正确，已停止派发请求。', 502, 'antseed_invalid_catalog'); }
}

export async function fetchKeyInfo(connection, options = {}, dependencies = {}, signal) {
  const payload = await readEndpoint(connection, '/key', { ...dependencies, timeoutMs: options.discoveryTimeoutMs ?? 10000, signal });
  if (!record(payload?.data) || typeof payload.data.id !== 'string') throw errorWith('此端点没有返回 Antseed Gateway Key 信息。裸 Buyer 请显式选择 Buyer 连接方式。', 502, 'antseed_invalid_key_info');
  return payload.data;
}

function amount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) && num <= Number.MAX_SAFE_INTEGER / 1000000 ? num : null;
}
export function usageFromKeyInfo(info) {
  const balance = info.balance;
  const available = amount(balance?.available_usd);
  const stale = balance?.stale === true;
  const windows = [];
  if (available != null) windows.push({ name: stale ? 'Antseed 余额（缓存）' : 'Antseed 可用余额', balance: available, unit: 'USDC', ...(stale ? { aside: true } : {}) });
  const spent = amount(info.usage?.spent_usd);
  if (spent != null) windows.push({ name: '此 Key 已记账支出', amount: spent, unit: 'USDC', aside: true, display: `${info.usage.spent_usd} USDC` });
  for (const [period, limit] of Object.entries(record(info.limits) ? info.limits : {})) {
    const max = amount(limit?.limit_usd), used = amount(limit?.spent_usd);
    if (max == null || used == null) continue;
    windows.push({ name: `Key ${period} 预算`, amount: used, limit: max, unit: 'USDC', display: `${limit.spent_usd} / ${limit.limit_usd} USDC` });
  }
  return {
    plan: 'Antseed · USDC 按量结算', user: cleanLabel(info.label) || info.buyer_address || undefined,
    ...(available != null ? { balance: `${balance.available_usd} USDC${stale ? '（缓存）' : ''}` } : {}),
    windows, signIn: 'kept',
  };
}

export function validateRequestTarget(input, baseURL) {
  let url;
  try { url = new URL(input instanceof Request ? input.url : String(input)); }
  catch { throw errorWith('Antseed 请求 URL 不正确。', 400, 'antseed_invalid_request'); }
  const base = new URL(baseURL);
  if (url.origin !== base.origin || url.username || url.password || url.hash) throw errorWith('Antseed 拒绝向已配置 Gateway 之外的地址发送凭据。', 400, 'antseed_endpoint_refused');
  const path = url.pathname.slice(base.pathname.length);
  if (!url.pathname.startsWith(`${base.pathname}/`) || !REQUEST_PATHS.has(path)) throw errorWith('Antseed 插件只接受 Chat、Responses 和 Messages 推理端点。', 400, 'antseed_endpoint_refused');
  for (const key of url.searchParams.keys()) if (key !== 'beta') throw errorWith('Antseed 请求包含不支持的端点参数。', 400, 'antseed_endpoint_refused');
  return { url: `${baseURL}${path}${url.search}`, path };
}

export function inferenceHeaders(source, key, route) {
  const headers = new Headers();
  for (const [name, value] of new Headers(source)) if (FORWARDED_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  headers.set('authorization', `Bearer ${validKey(key)}`);
  headers.set('content-type', 'application/json');
  headers.set('x-antseed-pin-peer', route.peerId);
  return headers;
}

function responseError(error, path = '') {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
  const message = safeError(error);
  const code = error?.code?.startsWith('antseed_') ? error.code : 'antseed_request_failed';
  const payload = path === '/messages'
    ? { type: 'error', error: { type: status >= 500 ? 'api_error' : status === 403 ? 'permission_error' : 'invalid_request_error', message } }
    : { error: { type: status >= 500 ? 'api_error' : 'invalid_request_error', code, message } };
  return Response.json(payload, { status, headers: { 'x-magpie-sign-in': status === 401 ? 'expired' : 'kept' } });
}

function managedAuth(connection, settings) {
  const metadata = { mode: 'managed', profile: connection.profile };
  for (const key of ['dataRoot', 'gatewayPort', 'buyerPort', 'nodePath']) if (settings[key] !== undefined) metadata[key] = settings[key];
  return { type: 'success', key: connection.apiKey, accountId: `Antseed · ${connection.profile}`, metadata };
}

export async function createProviderPlugin(input = {}, rawOptions = {}, dependencies = {}) {
  const options = normalizeOptions(rawOptions ?? {});
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const getRuntime = async () => dependencies.runtime ?? await defaultRuntime();
  const clock = dependencies.now ?? Date.now;
  // Each key/endpoint has its own catalog and health state. No auth value or
  // conversation is persisted in a cache key, log, page, or plugin options.
  const states = new Map();
  function stateFor(connection) {
    const key = fingerprint(`${connection.baseURL}\0${connection.apiKey}`);
    if (!states.has(key)) {
      if (states.size >= 128) states.delete(states.keys().next().value);
      states.set(key, { catalog: null, at: -Infinity, cooldowns: new Map() });
    }
    return states.get(key);
  }
  async function readCatalog(connection, signal, force = false) {
    const state = stateFor(connection);
    if (!force && state.catalog && clock() - state.at < options.dispatchCatalogTtlMs) return state.catalog;
    // An abort belongs to this request. Do not share abortable fetch promises
    // between unrelated model calls or accounts.
    const catalog = await fetchCatalog(connection, options, { fetchImpl }, signal);
    state.catalog = catalog;
    state.at = clock();
    return catalog;
  }
  const profilePrompt = { type: 'text', key: 'profile', message: '钱包配置名称（同名配置会复用已有钱包，默认 default）', placeholder: 'default', validate: (value) => { try { profileName(value); } catch (e) { return e.message; } } };
  async function authorizeManaged(inputs, context = {}, openOnly = false) {
    try {
      const runtime = await getRuntime();
      const settings = runtimeOptions(options, { profile: inputs?.profile || options.profile || 'default' }, context.signal);
      // Keep the resolved wallet root with the account, so changing a default
      // directory later cannot accidentally create another wallet for it.
      if (runtime.runtimePaths) settings.dataRoot = runtime.runtimePaths(settings).root;
      if (openOnly) {
        const status = await runtime.runtimeStatus(settings);
        if (!status.initialized) return { type: 'failed', error: '这个配置尚未初始化，请先选择「初始化本地 Antseed Gateway」。' };
      }
      const connection = await runtime.ensureManagedGateway(settings);
      abortIfNeeded(context.signal);
      const link = await runtime.consoleLink(settings);
      return {
        // A first owner claims the console with setupLink's one-time token.
        // Keep it solely in the OAuth browser handoff, never in saved auth.
        url: link.setupLink ?? link.url,
        instructions: link.setupRequired ? '在官方控制台完成首次设置。钱包与支付由 Antseed 管理；返回 Magpie 即可选择已发现模型。' : '已打开此钱包的 Antseed 官方控制台，可查看余额、充值和账单。',
        method: 'auto',
        async callback(_code, { signal } = {}) {
          abortIfNeeded(signal);
          return managedAuth(connection, settings);
        },
      };
    } catch (error) { return { type: 'failed', error: safeError(error) }; }
  }
  return {
    config: async (config) => {
      config.provider ??= {};
      config.provider[PROVIDER_ID] ??= { name: 'Antseed', npm: '@ai-sdk/openai-compatible', api: DEFAULT_BASE, models: {} };
    },
    auth: {
      provider: PROVIDER_ID,
      maxConcurrency: 4,
      methods: [
        { type: 'oauth', label: '初始化本地 Antseed Gateway', prompts: [profilePrompt], authorize: (inputs, context) => authorizeManaged(inputs, context) },
        {
          type: 'api', label: '连接已有 Antseed Gateway / Buyer',
          prompts: [
            { type: 'select', key: 'mode', message: '连接类型', options: [{ label: 'Gateway（真实 API Key、余额与账单）', value: 'gateway' }, { label: '裸 Buyer（已运行，使用本地占位 Key）', value: 'buyer' }] },
            { type: 'text', key: 'baseURL', message: 'Antseed 地址（根地址或 /v1）', placeholder: 'http://127.0.0.1:8379/v1', validate: (value) => { try { validateBaseURL(value, options); } catch (e) { return e.message; } } },
            { type: 'password', key: 'key', message: 'Gateway API Key（不是钱包私钥）', when: { key: 'mode', op: 'eq', value: 'gateway' }, validate: (value) => { try { validKey(value); } catch (e) { return e.message; } } },
            { type: 'text', key: 'label', message: '此连接的名称（可选）', placeholder: 'Antseed' },
          ],
          async authorize(inputs = {}, { signal } = {}) {
            try {
              const mode = inputs.mode || 'gateway';
              if (!['gateway', 'buyer'].includes(mode)) throw new TypeError('请选择 Gateway 或裸 Buyer。');
              const baseURL = validateBaseURL(inputs.baseURL, options);
              const key = mode === 'buyer' ? 'antseed-local' : validKey(inputs.key);
              const connection = { mode, baseURL, apiKey: key };
              if (mode === 'gateway') await fetchKeyInfo(connection, options, { fetchImpl }, signal);
              else await fetchCatalog(connection, options, { fetchImpl }, signal);
              const label = cleanLabel(inputs.label) || 'Antseed';
              return { type: 'success', key, accountId: `${label} · ${new URL(baseURL).host} · ${fingerprint(`${baseURL}\0${key}`).slice(0, 8)}`, metadata: { mode, baseURL, label } };
            } catch (error) { return { type: 'failed', error: safeError(error) }; }
          },
        },
        { type: 'oauth', label: '打开钱包 / 充值控制台', prompts: [profilePrompt], authorize: (inputs, context) => authorizeManaged(inputs, context, true) },
      ],
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        const connection = await resolveConnection(auth, options, dependencies);
        return {
          baseURL: connection.baseURL, apiKey: connection.apiKey,
          async fetch(request, init = {}) {
            let path = '';
            const signal = init.signal ?? (request instanceof Request ? request.signal : undefined);
            try {
              abortIfNeeded(signal);
              const target = validateRequestTarget(request, connection.baseURL);
              path = target.path;
              if (String(init.method || (request instanceof Request ? request.method : 'POST')).toUpperCase() !== 'POST') throw errorWith('Antseed 推理端点需要 POST。', 405, 'antseed_method_refused');
              const bodyText = init.body ?? (request instanceof Request ? await request.clone().text() : undefined);
              if (typeof bodyText !== 'string' && !Buffer.isBuffer(bodyText) && !(bodyText instanceof Uint8Array)) throw errorWith('Antseed 推理请求必须是 JSON。', 400, 'antseed_invalid_request');
              if (Buffer.byteLength(bodyText) > 32 * 1024 * 1024) throw errorWith('Antseed 请求超过 32 MiB。', 413, 'antseed_request_too_large');
              let body;
              try { body = JSON.parse(typeof bodyText === 'string' ? bodyText : Buffer.from(bodyText).toString('utf8')); } catch { throw errorWith('Antseed 推理请求不是有效 JSON。', 400, 'antseed_invalid_request'); }
              if (!record(body) || typeof body.model !== 'string') throw errorWith('Antseed 请求必须指定一个模型。', 400, 'antseed_invalid_request');
              // Antseed routes by `service ?? model`, including before it
              // resolves a preset. These three text protocols use `model`;
              // a caller-supplied service must not bypass the vetted route.
              delete body.service;
              // Reconnect the same managed profile after host/child restarts. No
              // new identity is created by a model request.
              const currentAuth = await getAuth();
              const current = await resolveConnection(currentAuth, options, dependencies, signal);
              if (current.baseURL !== connection.baseURL) throw errorWith('Antseed Gateway 地址已变化，请重新加载此 Provider。', 503, 'antseed_gateway_moved');
              const catalog = await readCatalog(current, signal);
              const state = stateFor(current);
              const selected = selectRoute(catalog, body.model, options, state.cooldowns, clock());
              if (current.mode === 'managed') {
                const prepare = dependencies.prepareManagedRoute ?? (await import('./managed-policy.mjs')).prepareManagedRoute;
                body.model = await prepare(current, selected, options, runtimeOptions(options, currentAuth.metadata, signal), await getRuntime(), signal);
              } else body.model = selected.id;
              abortIfNeeded(signal);
              let response;
              try {
                response = await fetchImpl(target.url, {
                  method: 'POST', headers: inferenceHeaders(init.headers ?? (request instanceof Request ? request.headers : undefined), current.apiKey, selected),
                  body: JSON.stringify(body), signal, redirect: 'error',
                });
              } catch (error) {
                if (!signal?.aborted) state.cooldowns.set(selected.id, clock() + options.cooldownMs);
                abortIfNeeded(signal);
                throw errorWith('Antseed 请求连接中断或返回重定向。此请求不会自动重发；可查看官方账单确认状态。', 502, 'antseed_dispatch_failed');
              }
              if (response.status === 429 || response.status >= 500 || response.status === 404 || response.status === 403 || response.status === 402 && selected.free) state.cooldowns.set(selected.id, clock() + options.cooldownMs);
              else if (response.ok) state.cooldowns.delete(selected.id);
              // Streaming bodies, tool calls, signatures and upstream errors
              // are returned untouched. Never read and retry a paid response.
              return response;
            } catch (error) {
              abortIfNeeded(signal);
              return responseError(error, path);
            }
          },
        };
      },
      async usage(getAuth, _provider, { signal } = {}) {
        abortIfNeeded(signal);
        const auth = await getAuth();
        if (!auth) return { windows: [] };
        try {
          const connection = await resolveConnection(auth, options, dependencies, signal);
          if (connection.mode === 'buyer') return { plan: 'Antseed 裸 Buyer · 余额请查看 Antseed 钱包', windows: [], signIn: 'kept' };
          return usageFromKeyInfo(await fetchKeyInfo(connection, options, { fetchImpl }, signal));
        } catch (error) { abortIfNeeded(signal); return { error: safeError(error), windows: [], signIn: error?.signIn === 'expired' ? 'expired' : 'kept' }; }
      },
    },
    provider: {
      id: PROVIDER_ID,
      async models(provider, { auth, signal } = {}) {
        abortIfNeeded(signal);
        if (!auth) return provider.models;
        const connection = await resolveConnection(auth, options, dependencies, signal);
        return (await readCatalog(connection, signal, true)).models;
      },
    },
  };
}
