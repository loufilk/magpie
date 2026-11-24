import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.MAGPIE_HOST_PATH) {
  console.error('Set MAGPIE_HOST_PATH to an unmodified official Magpie internal/plugin/host.js and MAGPIE_BUN to a runnable Bun binary.');
  process.exit(2);
}
const child = spawn(process.execPath, ['--test', resolve(root, 'test/integration-magpie.mjs')], { cwd: root, env: process.env, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
