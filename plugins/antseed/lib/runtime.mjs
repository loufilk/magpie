import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { access, chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const ANTSEED_CLI_VERSION = '0.1.259';
export const ANTSEED_ROUTER_VERSION = '0.1.54';
const VERIFIER_VERSION = '0.1.10';
const MANAGER_SHA = '4b54df7106612f7c2db9075f8b1566af9876d855cc5a99fe8cbfae9b29f88307';
const MANAGER_ORIGINAL = "export const PLUGINS_DIR = join(homedir(), '.antseed', 'plugins');";
const MANAGER_REPLACEMENT = "export const PLUGINS_DIR = process.env['MAGPIE_ANTSEED_PLUGIN_DIR'] || join(homedir(), '.antseed', 'plugins');";
const READY_FILE = 'native-ready.json';
const DEFAULT_POLICY = Object.freeze({ freeOnly: false, preferFreePeers: true, minTrustScore: 60 });
const delay = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(signal.reason ?? new Error('Operation cancelled'));
  const abort = () => { clearTimeout(timer); rej(signal.reason ?? new Error('Operation cancelled')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); res(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const digest = (value) => createHash('sha256').update(value).digest('hex');
function safeDiagnostic(value) {
  return String(value ?? '').replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/antseed_(?:admin_)?[a-zA-Z0-9_-]+/g, '[redacted key]')
    .replace(/\b(?:0x)?[0-9a-fA-F]{40,}\b/g, '[redacted address/key]')
    .replace(/(Bearer|authorization|password|token|secret)(\s*[:=]?\s*)[^\s,;"}]+/gi, '$1$2[redacted]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@')
    .slice(-4000);
}
const privateJSON = async (path, fallback = null) => {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`Cannot read ${path}: invalid or unreadable state file`); }
};

export function runtimePaths(options = {}) {
  const profile = options.profile ?? 'default';
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(profile)) {
    throw new Error('Profile must contain 1–48 letters, numbers, underscores or hyphens.');
  }
  const platformBase = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
    : (process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'));
  const root = resolve(options.dataRoot ?? process.env.MAGPIE_ANTSEED_DATA_DIR ?? join(platformBase, 'magpie-antseed'));
  const profileDir = join(root, 'profiles', profile);
  return {
    root, profile, profileDir, dataDir: join(profileDir, 'antseed'),
    configPath: join(profileDir, 'antseed-config.json'),
    credentialsPath: join(profileDir, 'credentials.json'),
    statePath: join(profileDir, 'runtime.json'),
    settingsPath: join(profileDir, 'settings.json'),
    runtimeDir: resolve(options.runtimeDir ?? process.env.MAGPIE_ANTSEED_RUNTIME_DIR ?? join(root, `runtime-${ANTSEED_CLI_VERSION}`)),
  };
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

async function atomicJSON(path, value) {
  await privateDirectory(dirname(path));
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally { await rm(temp, { force: true }).catch(() => {}); }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// A lock is removed only after its owner exited. We never signal a PID read from disk.
async function withLock(path, fn, { signal, timeoutMs = 600_000 } = {}) {
  const started = Date.now();
  const owner = randomBytes(16).toString('hex');
  await privateDirectory(dirname(path));
  for (;;) {
    signal?.throwIfAborted();
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, owner }));
      await handle.close();
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const lock = await privateJSON(path).catch(() => null);
      if (lock && !alive(lock.pid)) {
        // Serialize stale cleanup and re-read after taking the recovery lock: otherwise a
        // second reaper could unlink the new owner's lock after the first removed the stale one.
        const recoveryPath = `${path}.recover`;
        let recovery;
        try { recovery = await open(recoveryPath, 'wx', 0o600); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const recovering = await privateJSON(recoveryPath).catch(() => null);
          if (recovering && !alive(recovering.pid)) throw new Error(`Interrupted Antseed lock recovery: inspect and remove ${recoveryPath} after confirming no setup is running.`);
        }
        if (recovery) {
          try {
            await recovery.writeFile(JSON.stringify({ pid: process.pid, owner }));
            const latest = await privateJSON(path).catch(() => null);
            if (latest?.owner === lock.owner && !alive(latest.pid)) await rm(path, { force: true });
          } finally { await recovery.close(); await rm(recoveryPath, { force: true }); }
        }
        await delay(50, signal);
        continue;
      }
      if (Date.now() - started >= timeoutMs) throw new Error('Another Antseed setup is running. Retry after it finishes.');
      await delay(150, signal);
    }
  }
  try { return await fn(); }
  finally {
    const lock = await privateJSON(path).catch(() => null);
    if (lock?.owner === owner) await rm(path, { force: true });
  }
}

export function normalizeRuntimePolicy(value = DEFAULT_POLICY) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Antseed policy must be an object.');
  const allowed = new Set(['freeOnly', 'preferFreePeers', 'minTrustScore', 'maxInputUsdPerMillion', 'maxOutputUsdPerMillion', 'maxCachedInputUsdPerMillion', 'allowedPeerIds', 'blockedPeerIds']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unsupported runtime policy field: ${key}`);
  const output = { ...DEFAULT_POLICY, ...value };
  for (const key of ['freeOnly', 'preferFreePeers']) if (typeof output[key] !== 'boolean') throw new Error(`${key} must be a boolean.`);
  if (!Number.isFinite(output.minTrustScore) || output.minTrustScore < 0 || output.minTrustScore > 100) throw new Error('minTrustScore must be between 0 and 100.');
  for (const key of ['maxInputUsdPerMillion', 'maxOutputUsdPerMillion', 'maxCachedInputUsdPerMillion']) {
    if (output[key] !== undefined && (!Number.isFinite(output[key]) || output[key] < 0)) throw new Error(`${key} must be a non-negative number.`);
  }
  for (const key of ['allowedPeerIds', 'blockedPeerIds']) {
    if (output[key] === undefined) continue;
    if (!Array.isArray(output[key]) || output[key].some((id) => typeof id !== 'string' || !/^(0x)?[0-9a-fA-F]{40}$/.test(id))) throw new Error(`${key} must contain Antseed peer IDs.`);
    output[key] = [...new Set(output[key].map((id) => id.toLowerCase().replace(/^0x/, '')))];
  }
  return output;
}

export function buyerConfig(policy, buyerPort) {
  const p = normalizeRuntimePolicy(policy);
  const input = p.freeOnly ? 0 : p.maxInputUsdPerMillion ?? 100;
  const output = p.freeOnly ? 0 : p.maxOutputUsdPerMillion ?? 100;
  const cached = p.freeOnly ? 0 : p.maxCachedInputUsdPerMillion ?? input;
  return {
    buyer: {
      proxyPort: buyerPort,
      maxPricing: { defaults: { inputUsdPerMillion: input, outputUsdPerMillion: output, cachedInputUsdPerMillion: cached } },
      routingPreferences: {
        preferFreePeers: p.preferFreePeers,
        maxInputUsdPerMillion: input,
        minTrustScore: p.minTrustScore,
        allowedPeerIds: p.allowedPeerIds ?? [],
        blockedPeerIds: p.blockedPeerIds ?? [],
      },
    },
    telemetry: { enabled: false },
  };
}

function gatewayPolicy(policy) {
  const p = normalizeRuntimePolicy(policy);
  return {
    preferFreePeers: p.preferFreePeers,
    minTrustScore: p.minTrustScore,
    ...(p.allowedPeerIds !== undefined ? { allowedPeerIds: p.allowedPeerIds } : {}),
    ...(p.blockedPeerIds !== undefined ? { blockedPeerIds: p.blockedPeerIds } : {}),
    maxInputUsdPerMillion: p.freeOnly ? 0 : p.maxInputUsdPerMillion ?? 100,
    maxOutputUsdPerMillion: p.freeOnly ? 0 : p.maxOutputUsdPerMillion ?? 100,
    maxCachedInputUsdPerMillion: p.freeOnly ? 0 : p.maxCachedInputUsdPerMillion ?? p.maxInputUsdPerMillion ?? 100,
  };
}

export async function patchIsolatedPluginDirectory(runtimeDir) {
  const file = join(runtimeDir, 'node_modules', '@antseed', 'cli', 'dist', 'plugins', 'manager.js');
  const source = await readFile(file, 'utf8');
  if (source.includes(MANAGER_REPLACEMENT) && digest(source.replace(MANAGER_REPLACEMENT, MANAGER_ORIGINAL)) === MANAGER_SHA) return;
  if (digest(source) !== MANAGER_SHA || source.split(MANAGER_ORIGINAL).length !== 2) {
    throw new Error('The Antseed CLI installation differs from the reviewed 0.1.259 source; refusing to patch or start it.');
  }
  await writeFile(file, source.replace(MANAGER_ORIGINAL, MANAGER_REPLACEMENT));
}

function cleanEnv(paths, runtime, extra = {}) {
  const env = { ...process.env };
  // A Magpie account must not silently adopt another application's identity or chain settings.
  for (const key of Object.keys(env)) if (/^ANTSEED_/.test(key)) delete env[key];
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return {
    ...env,
    ANTSEED_CONFIG: paths.configPath,
    ANTSEED_DATA_DIR: paths.dataDir,
    MAGPIE_ANTSEED_PLUGIN_DIR: runtime.runtimeDir,
    ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1',
    ANTSEED_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    NO_COLOR: '1',
    ...extra,
  };
}

async function nodeRuntimeInfo(options = {}) {
  const candidate = options.nodePath ?? process.env.MAGPIE_ANTSEED_NODE ?? (process.versions.bun ? 'node' : process.execPath);
  try {
    const { stdout } = await execFileAsync(candidate, ['-p', 'JSON.stringify({version:process.versions.node,path:process.execPath,abi:process.versions.modules,platform:process.platform,arch:process.arch,bun:!!process.versions.bun})'], { timeout: 15_000, windowsHide: true, signal: options.signal });
    const info = JSON.parse(stdout.trim());
    if (info.bun || Number(info.version.split('.')[0]) < 22) throw new Error('version');
    return info;
  } catch {
    options.signal?.throwIfAborted();
    throw new Error('Managed Antseed needs Node.js 22 or 24 LTS with npm. Install Node.js, or set MAGPIE_ANTSEED_NODE to its executable.');
  }
}

const runtimeReady = (node) => ({ version: 1, cli: ANTSEED_CLI_VERSION, router: ANTSEED_ROUTER_VERSION,
  verifier: VERIFIER_VERSION, manager: MANAGER_SHA, nodePath: node.path, nodeVersion: node.version,
  nodeABI: node.abi, platform: node.platform, arch: node.arch });

/** Cheap install-hook probe: no npm, native loading, network, or wallet creation.
 * Inspect the configured Node, not the Bun host's unrelated module ABI. */
export async function isManagedRuntimeInstalled(options = {}) {
  const paths = runtimePaths(options);
  try {
    const marker = await privateJSON(join(paths.runtimeDir, READY_FILE));
    if (!marker) return false;
    const [node, cli, router, verifier, source] = await Promise.all([
      nodeRuntimeInfo(options),
      privateJSON(join(paths.runtimeDir, 'node_modules', '@antseed', 'cli', 'package.json')),
      privateJSON(join(paths.runtimeDir, 'node_modules', '@antseed', 'router-local', 'package.json')),
      privateJSON(join(paths.runtimeDir, 'node_modules', '@antseed', 'antseed-verifier', 'package.json')),
      readFile(join(paths.runtimeDir, 'node_modules', '@antseed', 'cli', 'dist', 'plugins', 'manager.js'), 'utf8'),
    ]);
    const expected = runtimeReady(node);
    return Object.entries(expected).every(([key, value]) => marker[key] === value)
      && cli?.version === ANTSEED_CLI_VERSION && router?.version === ANTSEED_ROUTER_VERSION && verifier?.version === VERIFIER_VERSION
      && source.includes(MANAGER_REPLACEMENT) && digest(source.replace(MANAGER_REPLACEMENT, MANAGER_ORIGINAL)) === MANAGER_SHA;
  } catch { options.signal?.throwIfAborted(); return false; }
}

async function npmInvocation(nodePath) {
  if (process.platform !== 'win32') return { file: 'npm', args: [] };
  const candidates = [join(dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const dir of (process.env.Path ?? process.env.PATH ?? '').split(';')) candidates.push(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const file of candidates) if (await exists(file)) return { file: nodePath, args: [file] };
  throw new Error('npm-cli.js was not found beside Node.js. Install the official Node.js LTS distribution.');
}

async function validateNative(runtime, options) {
  const script = "const r=require('node:module').createRequire(require('node:path').join(process.cwd(),'package.json'));const D=r('better-sqlite3');const d=new D(':memory:');d.close();r('node-datachannel');";
  try { await execFileAsync(runtime.nodePath, ['-e', script], { cwd: runtime.runtimeDir, timeout: 20_000, windowsHide: true, signal: options.signal }); }
  catch { throw new Error('Antseed native modules could not load under this Node runtime. Remove the private runtime directory and retry setup; Linux may need build-essential, Python and CMake when a prebuilt module is unavailable.'); }
}

export async function prepareManagedRuntime(options = {}) {
  const paths = runtimePaths(options);
  const node = await nodeRuntimeInfo(options);
  const nodePath = node.path;
  const runtime = { nodePath, runtimeDir: paths.runtimeDir, cliPath: join(paths.runtimeDir, 'node_modules', '@antseed', 'cli', 'dist', 'cli', 'index.js') };
  await privateDirectory(paths.runtimeDir);
  return withLock(join(paths.runtimeDir, '.install.lock'), async () => {
    // Never leave a successful marker behind if a subsequent repair or native check fails.
    await rm(join(paths.runtimeDir, READY_FILE), { force: true });
    const cli = await privateJSON(join(paths.runtimeDir, 'node_modules', '@antseed', 'cli', 'package.json'));
    const router = await privateJSON(join(paths.runtimeDir, 'node_modules', '@antseed', 'router-local', 'package.json'));
    const verifier = await privateJSON(join(paths.runtimeDir, 'node_modules', '@antseed', 'antseed-verifier', 'package.json'));
    if (cli?.version !== ANTSEED_CLI_VERSION || router?.version !== ANTSEED_ROUTER_VERSION || verifier?.version !== VERIFIER_VERSION) {
      options.onProgress?.(`Installing Antseed CLI ${ANTSEED_CLI_VERSION} and native dependencies in its private runtime…`);
      let packageText;
      let lockText;
      try {
        [packageText, lockText] = await Promise.all([
          readFile(new URL('../runtime/package.json', import.meta.url), 'utf8'),
          readFile(new URL('../runtime/package-lock.json', import.meta.url), 'utf8'),
        ]);
        const manifest = JSON.parse(packageText);
        const locked = JSON.parse(lockText);
        for (const [name, version] of Object.entries({ '@antseed/cli': ANTSEED_CLI_VERSION, '@antseed/router-local': ANTSEED_ROUTER_VERSION, '@antseed/antseed-verifier': VERIFIER_VERSION })) {
          if (manifest.dependencies?.[name] !== version || locked.packages?.['']?.dependencies?.[name] !== version) throw new Error('version mismatch');
        }
      } catch { throw new Error('The plugin runtime lock files are missing or inconsistent. Reinstall the complete plugin package.'); }
      await writeFile(join(paths.runtimeDir, 'package.json'), packageText, { mode: 0o600 });
      await writeFile(join(paths.runtimeDir, 'package-lock.json'), lockText, { mode: 0o600 });
      const npm = await npmInvocation(nodePath);
      try {
        await execFileAsync(npm.file, [...npm.args, 'ci', '--prefix', paths.runtimeDir, '--global=false', '--no-audit', '--no-fund', '--omit=optional', '--ignore-scripts=false'], {
          cwd: paths.runtimeDir, timeout: 600_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal: options.signal,
          env: { ...process.env, PATH: `${dirname(nodePath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
        });
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        const detail = safeDiagnostic(error.stderr || error.message);
        throw new Error(`Antseed dependency installation failed (${error.code ?? 'npm'}). Check registry access and the Node.js native build prerequisites.${detail ? `\n${detail}` : ''}`);
      }
    }
    await patchIsolatedPluginDirectory(paths.runtimeDir);
    await validateNative(runtime, options);
    await atomicJSON(join(paths.runtimeDir, READY_FILE), runtimeReady(node));
    return runtime;
  }, options);
}

async function freePort(requested) {
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1024 || requested > 65535)) throw new Error('Managed ports must be integers between 1024 and 65535.');
  const server = createNetServer();
  try {
    await new Promise((res, rej) => { server.once('error', rej); server.listen(requested ?? 0, '127.0.0.1', res); });
    return server.address().port;
  } catch { throw new Error(`Antseed loopback port ${requested ?? '(automatic)'} is unavailable.`); }
  finally { if (server.listening) await new Promise((res) => server.close(res)); }
}

function validPort(value) { return Number.isInteger(value) && value >= 1024 && value <= 65535; }
function validDescriptor(value) {
  return value && validPort(value.controlPort) && validPort(value.gatewayPort) && validPort(value.buyerPort)
    && typeof value.token === 'string' && /^[0-9a-f]{64}$/.test(value.token)
    && typeof value.generation === 'string' && /^[0-9a-f]{32}$/.test(value.generation);
}

async function controllerCall(state, method, path, signal) {
  if (!validDescriptor(state)) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${state.controlPort}${path}`, {
      method, headers: { authorization: `Bearer ${state.token}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500),
      redirect: 'error',
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.generation === state.generation ? data : null;
  } catch { return null; }
}

async function cliCommand(runtime, paths, args, options = {}) {
  let result;
  try {
    result = await execFileAsync(runtime.nodePath, [runtime.cliPath, '--data-dir', paths.dataDir, '--config', paths.configPath, ...args], {
      cwd: paths.profileDir, env: cleanEnv(paths, runtime), timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw new Error(`Antseed ${args.slice(0, 3).join(' ')} failed (${error.code ?? 'command error'}).`);
  }
  if (!args.includes('--json')) return result.stdout;
  // Some SDKs write a startup notice before JSON. Parse only the trailing complete JSON value.
  const raw = result.stdout.trim();
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== '{' && raw[index] !== '[') continue;
    try { return JSON.parse(raw.slice(index)); } catch { /* continue */ }
  }
  throw new Error('Antseed returned no valid JSON for a management operation.');
}

function connection(paths, state, credentials) {
  return {
    mode: 'managed', profile: paths.profile,
    baseURL: `http://127.0.0.1:${state.gatewayPort}/v1`, apiKey: credentials.apiKey,
    consoleURL: `http://localhost:${state.gatewayPort}/console`, dataDir: paths.dataDir,
    gatewayPort: state.gatewayPort, buyerPort: state.buyerPort,
    keyId: credentials.keyId, workspaceId: credentials.workspaceId,
  };
}

function validateCredentials(value) {
  if (!value || typeof value.apiKey !== 'string' || !value.apiKey.startsWith('antseed_')
    || typeof value.keyId !== 'string' || typeof value.adminToken !== 'string' || !value.adminToken.startsWith('antseed_admin_')) {
    throw new Error('Antseed credential state is incomplete. Refusing to replace an existing wallet or API key automatically.');
  }
  return value;
}

function waitForSetup(entry, signal) {
  signal?.throwIfAborted();
  entry.waiters++;
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (ok, value) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      entry.waiters--;
      if (ok) resolve(value); else reject(value);
    };
    const abort = () => {
      const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
      finish(false, reason);
      // One cancelled model request must not cancel another request's startup.
      if (!entry.waiters && !entry.settled) entry.controller.abort(reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise.then((value) => finish(true, value), (error) => finish(false, error));
    if (signal?.aborted) abort();
  });
}

/** Dependency seam for lifecycle tests; normal callers use the singleton exports below. */
export function createRuntimeManager({ prepareRuntime = prepareManagedRuntime } = {}) {
  const pending = new Map();
  const owned = new Map();

  async function ensureManagedGateway(options = {}) {
    options.signal?.throwIfAborted();
    const paths = runtimePaths(options);
    let entry = pending.get(paths.profileDir);
    const joined = Boolean(entry);
    if (!entry) {
      entry = { controller: new AbortController(), waiters: 0, settled: false, promise: null };
      const sharedOptions = { ...options, signal: entry.controller.signal };
      entry.promise = withLock(join(paths.profileDir, '.setup.lock'), () => start(paths, sharedOptions), sharedOptions).finally(() => {
        entry.settled = true;
        if (pending.get(paths.profileDir) === entry) pending.delete(paths.profileDir);
      });
      pending.set(paths.profileDir, entry);
    }
    try {
      const result = await waitForSetup(entry, options.signal);
      // A waiting caller may request a different policy; apply it serially after startup.
      return joined ? ensureManagedGateway(options) : result;
    } catch (error) {
      options.signal?.throwIfAborted();
      // A new caller can arrive while the previous last caller's cancelled startup drains.
      if (entry.controller.signal.aborted) return ensureManagedGateway(options);
      throw error;
    }
  }

  async function start(paths, options) {
    await privateDirectory(paths.profileDir);
    await privateDirectory(paths.dataDir);
    const previous = await privateJSON(paths.settingsPath, {});
    const policy = normalizeRuntimePolicy(options.policy ?? previous.policy ?? DEFAULT_POLICY);
    const policyHash = digest(JSON.stringify(policy));
    let state = await privateJSON(paths.statePath);
    const current = await controllerCall(state, 'GET', '/status', options.signal);
    if (current?.running && state.policyHash === policyHash
      && (options.gatewayPort === undefined || options.gatewayPort === state.gatewayPort)
      && (options.buyerPort === undefined || options.buyerPort === state.buyerPort)) return connection(paths, state, validateCredentials(await privateJSON(paths.credentialsPath)));
    if (current?.running) {
      await stopManagedGateway(paths.profile, { ...options, wait: true });
      state = null;
    }
    else if (current) {
      throw new Error('The previous Antseed process is still starting or stopping. Retry after it finishes; its wallet was not opened again.');
    }
    if (validDescriptor(state) && !current) {
      // Its parent may just have died. Reusing the wallet before that buyer stops can double-open channels.
      if (alive(state.ownerPid) || alive(state.childPid)) {
        throw new Error('The previous Antseed owner or gateway is still alive. Wait for its parent/stdin shutdown to finish; no process was killed.');
      }
      if (state.phase === 'starting' && !Number.isSafeInteger(state.childPid)) {
        // A crash can happen between spawn and saving its PID. Free ports do not prove
        // that an unbound child is gone. Preserve the descriptor for explicit recovery.
        throw new Error(`Antseed setup was interrupted before its child PID was recorded. Confirm that the old gateway and buyer have exited, then remove ${paths.statePath} and retry. The wallet and credentials must be retained.`);
      }
      try { await freePort(state.gatewayPort); await freePort(state.buyerPort); }
      catch { throw new Error('The previous Antseed process is still stopping, or its recorded ports are occupied. Retry once both ports are released; no process was killed.'); }
    }
    const runtime = await prepareRuntime(options);
    let gatewayPort;
    let buyerPort;
    if (options.gatewayPort !== undefined) gatewayPort = await freePort(options.gatewayPort);
    else {
      try { gatewayPort = await freePort(previous.gatewayPort); } catch { gatewayPort = await freePort(); }
    }
    if (options.buyerPort !== undefined) buyerPort = await freePort(options.buyerPort);
    else {
      try { buyerPort = await freePort(previous.buyerPort); } catch { buyerPort = await freePort(); }
    }
    if (gatewayPort === buyerPort) throw new Error('The Antseed gateway and buyer ports must be different.');
    const existingConfig = await privateJSON(paths.configPath, {});
    const managedConfig = buyerConfig(policy, buyerPort);
    await atomicJSON(paths.configPath, {
      ...existingConfig,
      telemetry: { ...existingConfig.telemetry, ...managedConfig.telemetry },
      buyer: {
        ...existingConfig.buyer, ...managedConfig.buyer,
        routingPreferences: { ...existingConfig.buyer?.routingPreferences, ...managedConfig.buyer.routingPreferences },
        maxPricing: { ...existingConfig.buyer?.maxPricing, ...managedConfig.buyer.maxPricing },
      },
    });
    await atomicJSON(paths.settingsPath, { version: 1, policy, gatewayPort, buyerPort });

    let credentials = await privateJSON(paths.credentialsPath);
    if (credentials) validateCredentials(credentials);
    else {
      // An interrupted first setup can leave a key in the store. Rotate that key instead of making another one.
      const keys = await cliCommand(runtime, paths, ['gateway', 'key', 'list', '--json'], options);
      const label = `Magpie ${paths.profile}`;
      const existing = Array.isArray(keys) ? keys.find((key) => key.label === label && key.status === 'active') : null;
      const key = existing
        ? await cliCommand(runtime, paths, ['gateway', 'key', 'rotate', existing.id, '--json'], options)
        : await cliCommand(runtime, paths, ['gateway', 'key', 'create', '--label', label, '--json'], options);
      // This token is private to the plugin backend. It is never sent in inference requests or UI status.
      const admin = await cliCommand(runtime, paths, ['gateway', 'admin-token', 'create', '--label', label, '--scope', 'admin', '--no-expiry', '--json'], options);
      credentials = validateCredentials({ version: 1, apiKey: key.apiKey, keyId: key.id, workspaceId: key.workspaceId, adminToken: admin.token, adminTokenId: admin.id });
      await atomicJSON(paths.credentialsPath, credentials);
    }
    const policyFile = join(paths.profileDir, 'gateway-policy.json');
    await atomicJSON(policyFile, gatewayPolicy(policy));
    await cliCommand(runtime, paths, ['gateway', 'key', 'policy', 'set', credentials.keyId, '--file', policyFile, '--confirm-empty', '--accept-narrowed'], options);

    const generation = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    // Persist the ports before spawning: a parent crash during startup must not allow
    // another buyer to start against the same wallet while this one is still exiting.
    state = { version: 1, generation, token, ownerPid: process.pid, controlPort: gatewayPort, gatewayPort, buyerPort, policyHash, phase: 'starting', startedAt: new Date().toISOString() };
    await atomicJSON(paths.statePath, state);
    const child = spawn(runtime.nodePath, [runtime.cliPath, '--data-dir', paths.dataDir, '--config', paths.configPath,
      'gateway', 'start', '--host', '127.0.0.1', '--port', String(gatewayPort), '--buyer-port', String(buyerPort)], {
      cwd: paths.profileDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv(paths, runtime, { ANTSEED_GATEWAY_STOP_ON_STDIN_CLOSE: '1', ANTSEED_GATEWAY_PARENT_PID: String(process.pid) }),
    });
    // Do not persist raw Antseed output: it includes wallet addresses and operational state.
    let failure = null;
    let diagnostic = '';
    let ready = false;
    child.once('error', (error) => { failure = error; });
    child.stdin.on('error', () => {});
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      if (!ready) diagnostic = safeDiagnostic(diagnostic + chunk.toString());
    });
    let stopping = false;
    let stopped;
    const exited = new Promise((res) => child.once('close', res));
    const control = createServer((request, response) => {
      const got = Buffer.from(request.headers.authorization ?? '');
      const want = Buffer.from(`Bearer ${token}`);
      if (got.length !== want.length || !timingSafeEqual(got, want) || request.headers.origin) {
        response.writeHead(401).end(); request.resume(); return;
      }
      response.setHeader('content-type', 'application/json');
      response.setHeader('cache-control', 'no-store');
      if (request.method === 'GET' && request.url === '/status') {
        response.end(JSON.stringify({ generation, running: ready && !stopping && child.exitCode === null && child.signalCode === null, starting: !ready && !stopping }));
      } else if (request.method === 'POST' && request.url === '/stop') {
        response.end(JSON.stringify({ generation, stopping: true }));
        void stop().catch(() => {});
      } else { response.writeHead(404).end(); }
      request.resume();
    });
    const stop = () => {
      if (stopped) return stopped;
      stopping = true;
      stopped = (async () => {
        child.stdin.end();
        // Official gateway drains requests and stops its buyer. Never kill a stored PID.
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        }, 180_000);
        timer.unref();
        try { await exited; } finally { clearTimeout(timer); }
        await cleanup();
        if (owned.get(paths.profileDir)?.child === child) owned.delete(paths.profileDir);
      })();
      return stopped;
    };
    let cleanupPromise;
    const cleanup = () => cleanupPromise ??= (async () => {
      owned.delete(paths.profileDir);
      if (control.listening) { control.closeIdleConnections?.(); await new Promise((res) => control.close(res)); }
      const saved = await privateJSON(paths.statePath).catch(() => null);
      if (saved?.generation === generation) await rm(paths.statePath, { force: true });
    })();
    try {
      state.childPid = child.pid;
      await atomicJSON(paths.statePath, state);
      await new Promise((res, rej) => { control.once('error', rej); control.listen(0, '127.0.0.1', res); });
      state.controlPort = control.address().port;
      await atomicJSON(paths.statePath, state);
      owned.set(paths.profileDir, { stop, child, runtime, paths });
    } catch (error) {
      await stop();
      throw error;
    }
    // Resources are now fully registered. If the child exited earlier, the
    // startup check below still calls stop() and cleans this completed setup.
    child.once('close', () => { void cleanup().catch(() => {}); });
    try {
      const deadline = Date.now() + (options.startupTimeoutMs ?? 180_000);
      options.onProgress?.('Starting the private Antseed gateway and discovering providers…');
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`Antseed gateway exited before becoming ready. Check native dependencies, available ports and P2P network access.\n${diagnostic}`);
        try {
          const result = await fetch(`http://127.0.0.1:${gatewayPort}/healthz`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
          if (result.ok) { ready = true; break; }
        } catch { /* process is still starting */ }
        await delay(300, options.signal);
      }
      if (!ready) throw new Error('Antseed gateway startup timed out. Check outbound P2P/UDP and Base RPC connectivity.');
      diagnostic = '';
      state.phase = 'ready';
      await atomicJSON(paths.statePath, state);
      options.signal?.throwIfAborted();
      return connection(paths, state, credentials);
    } catch (error) {
      await stop();
      throw error;
    }
  }

  async function stopManagedGateway(profile = 'default', options = {}) {
    const paths = runtimePaths({ ...options, profile });
    const ownedRuntime = owned.get(paths.profileDir);
    if (ownedRuntime) { await ownedRuntime.stop(); return { profile, stopped: true }; }
    const state = await privateJSON(paths.statePath);
    const answer = await controllerCall(state, 'POST', '/stop', options.signal);
    if (!answer) return { profile, stopped: false, running: false };
    if (options.wait !== false) {
      const deadline = Date.now() + 185_000;
      while (await exists(paths.statePath)) {
        if (Date.now() >= deadline) throw new Error('Antseed is still draining requests; its wallet state was retained.');
        await delay(200, options.signal);
      }
    }
    return { profile, stopped: true };
  }

  async function runtimeStatus(options = {}) {
    const paths = runtimePaths(options);
    const state = await privateJSON(paths.statePath);
    const result = await controllerCall(state, 'GET', '/status', options.signal);
    const settings = await privateJSON(paths.settingsPath, {});
    return {
      profile: paths.profile, installed: await exists(join(paths.runtimeDir, 'node_modules', '@antseed', 'cli', 'package.json')),
      initialized: await exists(paths.credentialsPath), configured: await exists(paths.credentialsPath), running: Boolean(result?.running),
      cliVersion: ANTSEED_CLI_VERSION, dataDir: paths.dataDir,
      ...(result?.running ? { baseURL: `http://127.0.0.1:${state.gatewayPort}/v1`, consoleURL: `http://localhost:${state.gatewayPort}/console`, startedAt: state.startedAt } : {}),
      policy: settings.policy ?? DEFAULT_POLICY,
    };
  }

  async function consoleLink(options = {}) {
    if (!await exists(runtimePaths(options).credentialsPath)) throw new Error('This Antseed profile has not been initialized. Use Create wallet / Start Antseed first.');
    const conn = await ensureManagedGateway(options);
    const paths = runtimePaths(options);
    const runtime = owned.get(paths.profileDir)?.runtime ?? await prepareRuntime(options);
    // Only the caller's explicit Console action invokes this; status never creates a sign-in token.
    return cliCommand(runtime, paths, ['gateway', 'console-link', '--port', String(conn.gatewayPort), '--json'], options);
  }

  async function managementRequest(path, init = {}, options = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('#')) throw new Error('Invalid management API path.');
    const conn = await ensureManagedGateway(options);
    const credentials = validateCredentials(await privateJSON(runtimePaths(options).credentialsPath));
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${credentials.adminToken}`);
    return fetch(`http://127.0.0.1:${conn.gatewayPort}/console/api${path}`, { ...init, headers, redirect: 'error', signal: init.signal ?? options.signal ?? AbortSignal.timeout(20_000) });
  }

  return { ensureManagedGateway, stopManagedGateway, runtimeStatus, consoleLink, managementRequest };
}

const singleton = createRuntimeManager();
export const ensureManagedGateway = singleton.ensureManagedGateway;
export const stopManagedGateway = singleton.stopManagedGateway;
export const runtimeStatus = singleton.runtimeStatus;
export const consoleLink = singleton.consoleLink;
export const managementRequest = singleton.managementRequest;
