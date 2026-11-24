import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const pageCheck=spawnSync(process.execPath,[join(root,'scripts/build-page.mjs'),'--check'],{stdio:'inherit'});
if(pageCheck.status!==0)process.exit(pageCheck.status??1);
const files=[];
async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.name.startsWith('.')||['node_modules','runtime','verification'].includes(entry.name))continue;const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(/\.(?:mjs|js)$/.test(path))files.push(path);}}
await walk(root);
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);}
const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
for(const dir of ['lib','page','runtime'])if(!pkg.files.includes(dir))throw new Error(`Package is missing ${dir}`);
const entry=await import(join(root,'index.mjs'));
if(Object.keys(entry).length!==1||entry.default?.id!=='antseed-magpie'||typeof entry.default.server!=='function')throw new Error('The package must export one Magpie provider entry.');
const lock=JSON.parse(await readFile(join(root,'runtime/package-lock.json'),'utf8'));
for(const [name,p] of Object.entries(lock.packages??{})){
  if(p.resolved&&!p.resolved.startsWith('https://registry.npmjs.org/'))throw new Error(`Unexpected runtime package registry: ${name}`);
  if(p.resolved&&!p.integrity)throw new Error(`Runtime package lacks integrity: ${name}`);
}
console.log(`Syntax and package checks passed: ${files.length} JavaScript files; one provider export; runtime lockfile verified.`);
