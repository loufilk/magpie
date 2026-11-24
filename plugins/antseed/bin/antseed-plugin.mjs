#!/usr/bin/env node
import { consoleLink, ensureManagedGateway, runtimeStatus, stopManagedGateway } from '../lib/runtime.mjs';

function parse(argv) {
  const [command = 'help', ...args] = argv;
  const options = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { json = true; continue; }
    const map = { '--profile': 'profile', '--data-root': 'dataRoot', '--node': 'nodePath', '--gateway-port': 'gatewayPort', '--buyer-port': 'buyerPort' };
    const key = map[arg];
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown option or missing value: ${arg}`);
    const value = args[++i];
    options[key] = key.endsWith('Port') ? Number(value) : value;
  }
  return { command, options, json };
}

const HELP = `Magpie Antseed plugin runtime

  antseed-plugin setup [--profile default]   Start the managed gateway in this terminal
  antseed-plugin status [--json]            Show public runtime status (no secrets)
  antseed-plugin stop                       Stop this profile's managed gateway
  antseed-plugin console                    Print its official one-time console setup link

Options: --profile NAME --data-root PATH --node PATH --gateway-port PORT --buyer-port PORT
setup stays in the foreground. Magpie automatically manages the same runtime while the plugin runs.
Funding and provider policies are managed from Magpie and the official Antseed console.
`;

try {
  const { command, options, json } = parse(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') process.stdout.write(HELP);
  else if (command === 'status') process.stdout.write(`${JSON.stringify(await runtimeStatus(options), null, 2)}\n`);
  else if (command === 'stop') process.stdout.write(`${JSON.stringify(await stopManagedGateway(options.profile ?? 'default', options), null, 2)}\n`);
  else if (command === 'setup' || command === 'console') {
    const onProgress = (message) => process.stderr.write(`[Antseed] ${message}\n`);
    if (command === 'console' && !(await runtimeStatus(options)).initialized) throw new Error('This profile is not initialized. Run setup first.');
    const conn = await ensureManagedGateway({ ...options, onProgress });
    if (command === 'console') {
      const link = await consoleLink(options);
      process.stdout.write(json ? `${JSON.stringify(link, null, 2)}\n` : `${link.setupLink ?? link.url}\n`);
    } else {
      const safe = { profile: conn.profile, baseURL: conn.baseURL, consoleURL: conn.consoleURL, dataDir: conn.dataDir };
      process.stdout.write(json ? `${JSON.stringify(safe, null, 2)}\n` : `Antseed gateway ready: ${safe.baseURL}\nConsole: ${safe.consoleURL}\nKeep this terminal open. Press Ctrl+C to stop.\n`);
    }
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      process.stderr.write('[Antseed] Waiting for the gateway to finish active requests…\n');
      await stopManagedGateway(options.profile ?? 'default', options);
    };
    process.once('SIGINT', () => { void stop().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); });
    process.once('SIGTERM', () => { void stop().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }); });
  } else throw new Error(`Unknown command: ${command}\n${HELP}`);
} catch (error) {
  process.stderr.write(`Antseed: ${error.message}\n`);
  process.exitCode = 1;
}
