import { createProviderPlugin, runtimeOptions } from './lib/connection.mjs';
import { normalizeOptions } from './lib/catalog.mjs';

async function server(input = {}, rawOptions = {}, dependencies = {}) {
  const options = normalizeOptions(rawOptions ?? {});
  const hooks = await createProviderPlugin(input, options, dependencies);
  const runtime = async () => dependencies.runtime ?? await import('./lib/runtime.mjs');
  // Magpie gives OAuth authorize only one minute. Its official CLI install
  // phase has a separate ten-minute budget and progress/cancellation handling.
  // Installing dependencies here creates no wallet, key or gateway process.
  // API-key sign-in to an existing Gateway bypasses this phase in Magpie.
  hooks.auth.cli = {
    name: 'Antseed runtime',
    manual: '安装 Node.js 22/24 LTS 与 npm 后重试；也可先运行本插件附带的 magpie-antseed setup 命令准备运行时。',
    async installed() {
      return (await runtime()).isManagedRuntimeInstalled(runtimeOptions(options));
    },
    async install({ signal } = {}) {
      signal?.throwIfAborted();
      await (await runtime()).prepareManagedRuntime(runtimeOptions(options, {}, signal));
      signal?.throwIfAborted();
    },
  };
  return hooks;
}

// Magpie calls every exported function as a provider. Keep this entry export
// singular; pure helpers and dependency injection live in lib/ for tests.
export default { id: 'antseed-magpie', server };
