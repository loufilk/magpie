// A management/process fixture, never used for real inference or wallet operations.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const value = (name) => argv[argv.indexOf(name) + 1];
const dataDir = value('--data-dir');
await mkdir(dataDir, { recursive: true });
const file = join(dataDir, 'fixture.json');
let state;
try { state = JSON.parse(await readFile(file, 'utf8')); } catch { state = { creates: 0, starts: 0, keys: [] }; }
const save = () => writeFile(file, JSON.stringify(state));
const commands = argv.slice(4);
const json = (value) => console.log(JSON.stringify(value));
if (commands[0] !== 'gateway') process.exit(1);
if (commands[1] === 'key' && commands[2] === 'list') json(state.keys);
else if (commands[1] === 'key' && commands[2] === 'create') {
  state.creates++;
  const key = { id: `key_${state.creates}`, apiKey: 'antseed_fixture_secret', label: value('--label'), status: 'active', workspaceId: 'ws_default' };
  state.keys.push(key);
  await save(); json(key);
} else if (commands[1] === 'key' && commands[2] === 'rotate') json(state.keys[0]);
else if (commands[1] === 'key' && commands[2] === 'policy') {
  state.policy = JSON.parse(await readFile(value('--file'), 'utf8'));
  await save(); console.log('Policy saved');
} else if (commands[1] === 'admin-token' && commands[2] === 'create') json({ id: 'admin_fixture', token: 'antseed_admin_fixture_secret' });
else if (commands[1] === 'console-link') json({ url: `http://localhost:${value('--port')}/console`, setupRequired: true, setupLink: `http://localhost:${value('--port')}/console/setup#fixture-once` });
else if (commands[1] === 'start') {
  state.starts++;
  state.parentProtocol = { stdin: process.env.ANTSEED_GATEWAY_STOP_ON_STDIN_CLOSE, pid: process.env.ANTSEED_GATEWAY_PARENT_PID };
  state.externalIdentityPresent = Boolean(process.env.ANTSEED_IDENTITY_HEX);
  state.pluginDir = process.env.MAGPIE_ANTSEED_PLUGIN_DIR;
  await save();
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/healthz') res.end('{"ok":true}');
    else if (req.url === '/v1/models') res.end('{"object":"list","data":[]}');
    else if (req.url === '/console/api/status') {
      if (req.headers.authorization !== 'Bearer antseed_admin_fixture_secret') res.writeHead(401).end('{}');
      else res.end('{"fixture":true}');
    } else res.writeHead(404).end('{}');
  });
  const timer = setTimeout(() => server.listen(Number(value('--port')), value('--host')), state.startDelay ?? 0);
  process.stdin.on('end', () => {
    clearTimeout(timer);
    if (server.listening) { server.closeAllConnections(); server.close(); }
  });
  process.stdin.resume();
} else process.exit(2);
