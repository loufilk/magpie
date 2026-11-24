import { execFileSync } from 'node:child_process';

const cli = process.argv[2] || '/magpie';
const spec = process.argv[3] || '/opt/magpie-antseed';
const env = { ...process.env, NO_COLOR: '1' };
const raw = execFileSync(cli, ['plugin', 'options', spec], { encoding: 'utf8', env }).trim();
let current;
if (raw.startsWith('{')) current = JSON.parse(raw);
else if (raw.startsWith('No options set.')) current = {};
else throw new Error('Could not read the current Magpie plugin options.');
if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Plugin options must be an object.');

// Manifest options are editor examples, not runtime defaults. Seed the actual
// store once and preserve every existing option, including explicit nulls.
const defaults = { gatewayPort: 18379, buyerPort: 18377 };
if (Object.keys(defaults).some(key => !Object.hasOwn(current, key))) {
  const next = { ...defaults, ...current };
  execFileSync(cli, ['plugin', 'options', spec, JSON.stringify(next)], { stdio: 'inherit', env });
}
