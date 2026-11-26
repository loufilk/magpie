#!/usr/bin/env node
// Linux, Node 22/24. Read-only diagnostics; never sends inference or payment POSTs.
import { lookup } from 'node:dns/promises';
import { createSocket } from 'node:dgram';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import assert from 'node:assert/strict';

const emit = (check, result) => console.log(JSON.stringify({ time: new Date().toISOString(), check, ...result }));
const errorCode = e => e?.code ?? e?.cause?.code ?? e?.name ?? 'ERROR';
const official = ['dht1.antseed.com', 'dht2.antseed.com'];
const fallback = ['router.bittorrent.com', 'router.utorrent.com', 'dht.transmissionbt.com'];
const load = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const exists = async p => { try { await stat(p); return true; } catch { return false; } };
const validPort = p => Number.isInteger(p) && p > 0 && p <= 65535;
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
const zero = { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0 };
const priceFields = ['inputUsdPerMillion', 'outputUsdPerMillion', 'cachedInputUsdPerMillion'];

function discoveryCounts(status) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  // Current Buyer fields take precedence, including zero; retain legacy JSONL keys.
  return {
    dhtNodes: count(status?.dhtNodeCount ?? status?.dhtNodes),
    peers: count(status?.peerCount ?? status?.peers),
  };
}

// Decode bounded BEP5 bencode; reject malformed/trailing data and duplicate keys.
function decode(buf) {
  let i = 0;
  function parse(depth = 0) {
    if (depth > 16 || i >= buf.length) throw Error('invalid bencode');
    const ch = buf[i++];
    if (ch === 100 || ch === 108) {
      const obj = ch === 100 ? Object.create(null) : [];
      while (buf[i] !== 101) {
        if (i >= buf.length) throw Error('unterminated bencode');
        if (Array.isArray(obj)) obj.push(parse(depth + 1));
        else { const k = parse(depth + 1); if (!Buffer.isBuffer(k) || Object.hasOwn(obj, String(k))) throw Error('invalid key'); obj[String(k)] = parse(depth + 1); }
      }
      i++; return obj;
    }
    if (ch === 105) { const j = buf.indexOf(101, i); if (j < 0 || !/^-?(0|[1-9]\d*)$/.test(buf.subarray(i,j).toString())) throw Error('invalid integer'); const n = Number(buf.subarray(i,j)); i = j+1; return n; }
    i--; const j = buf.indexOf(58, i); if (j < 0 || !/^(0|[1-9]\d*)$/.test(buf.subarray(i,j).toString())) throw Error('invalid string');
    const n = Number(buf.subarray(i,j)); i = j+1; if (!Number.isSafeInteger(n) || i+n > buf.length) throw Error('invalid length'); const value = buf.subarray(i,i+n); i += n; return value;
  }
  const value = parse(); if (i !== buf.length) throw Error('trailing bytes'); return value;
}
function query(kind, tx) {
  const id = randomBytes(20), topic = createHash('sha1').update('antseed:*').digest();
  const args = kind === 'ping' ? [Buffer.from('d2:id20:'), id, Buffer.from('e')] : [Buffer.from('d2:id20:'), id, Buffer.from('9:info_hash20:'), topic, Buffer.from('e')];
  return Buffer.concat([Buffer.from('d1:a'), ...args, Buffer.from(`1:q${kind.length}:${kind}1:t${tx.length}:`), tx, Buffer.from('1:y1:qe')]);
}
function krpc(address, port, kind, ms = 3500) {
  return new Promise(resolve => {
    const s = createSocket('udp4'), tx = randomBytes(4), start = Date.now(); let done = false;
    const timer = setTimeout(() => finish({ state: 'timeout' }), ms);
    function finish(result) { if (done) return; done = true; clearTimeout(timer); try { s.close(); } catch {} resolve({ ...result, ms: Date.now()-start }); }
    s.on('error', e => finish({ state: 'socket_error', error: errorCode(e) }));
    s.on('message', (msg, from) => {
      if (from.address !== address || from.port !== port || msg.length > 65507) return;
      try { const v = decode(msg); if (!Buffer.isBuffer(v.t) || !v.t.equals(tx)) return;
        if (String(v.y) === 'r' && Buffer.isBuffer(v.r?.id) && v.r.id.length === 20) finish({ state: 'reply', returnedNodes: Buffer.isBuffer(v.r.nodes) ? Math.floor(v.r.nodes.length/26) : 0, returnedValues: Array.isArray(v.r.values) ? v.r.values.length : 0 });
        else if (String(v.y) === 'e') finish({ state: 'krpc_error_reply' });
      } catch { /* malformed UDP is not a successful DHT reply */ }
    });
    s.bind(0, '0.0.0.0', () => s.send(query(kind,tx), port, address, e => { if (e) finish({ state: 'send_error', error: errorCode(e) }); }));
  });
}
async function loopback() {
  const s = createSocket('udp4');
  try {
    await new Promise((ok, bad) => { s.once('error',bad); s.bind(0,'127.0.0.1',ok); });
    s.on('message', (b,r) => { const q = decode(b); s.send(Buffer.concat([Buffer.from('d1:rd2:id20:'), Buffer.alloc(20,1), Buffer.from('e1:t4:'), q.t, Buffer.from('1:y1:re')]),r.port,r.address); });
    return await krpc('127.0.0.1',s.address().port,'ping',1000);
  } catch(e) { return {state:'socket_error',error:errorCode(e)}; } finally { try { s.close(); } catch {} }
}
async function probe(host, port = 6881) {
  let replied = false;
  try {
    const ips = [...new Set((await lookup(host,{family:4,all:true})).map(x=>x.address))];
    emit('bootstrap_dns',{host,ips});
    for (const address of ips.slice(0,4)) {
      const ping = await krpc(address,port,'ping');
      const getPeers = await krpc(address,port,'get_peers');
      emit('bootstrap_krpc',{host,address,port,ping,getPeers});
      replied ||= [ping,getPeers].some(p=>['reply','krpc_error_reply'].includes(p.state));
    }
  } catch(e) { emit('bootstrap_dns',{host,error:errorCode(e)}); }
  return replied;
}
async function get(base, path) {
  try { const response = await fetch(base+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(8000)}); if (!response.ok) return {error:`HTTP_${response.status}`}; return {data:await response.json()}; }
  catch(e) { return {error:errorCode(e)}; }
}
function args() {
  const opt = {profile:'default',seconds:90}; const argv = process.argv.slice(2);
  for (let i=0;i<argv.length;i++) {
    const flag=argv[i]; if (flag==='--self-test') opt.selfTest=true;
    else if (flag==='--help') opt.help=true;
    else if (['--profile','--data-root','--buyer-port','--seconds','--config'].includes(flag) && argv[i+1] && !argv[i+1].startsWith('--')) opt[flag.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=argv[++i];
    else throw Error(`unknown option: ${flag}`);
  }
  opt.seconds=Number(opt.seconds); if (!Number.isInteger(opt.seconds)||opt.seconds<0||opt.seconds>600) throw Error('seconds must be 0..600');
  if (opt.buyerPort!=null && !validPort(Number(opt.buyerPort))) throw Error('invalid buyer port');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(opt.profile)||opt.profile==='..') throw Error('invalid profile');
  return opt;
}
async function catalog(data, base) {
  if (!Array.isArray(data)) { emit('catalog',{error:'invalid_schema'}); return; }
  let mod; try { mod=await import('../lib/catalog.mjs'); } catch(e) { emit('catalog',{models:data.length,error:'plugin_catalog_module_unavailable'}); return; }
  const free=mod.buildCatalog(data,base,{freeOnly:true,includeAutoRoutes:false});
  const rules=Object.fromEntries(data.filter(m=>m?.type==='text'&&typeof m.id==='string').map(m=>[m.id,{maxMultiplier:0.05}]));
  // The plugin permits unknown reference price when no rule exists; require it for every cheap candidate.
  const cheap=mod.buildCatalog(data,base,{rules,includeAutoRoutes:false});
  const collect=(c,strict)=>Array.from(c.routes.values()).flatMap(r=>r.candidates).flatMap(r=>{
    const ref=r.entry.reference_price; const p=r.cost;
    if (!p) return [];
    const refs=[ref?.input_usd_per_million,ref?.output_usd_per_million,ref?.cached_input_usd_per_million??ref?.input_usd_per_million];
    const rates=[p.input,p.output,p.cache.read];
    const multiplier=refs.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0)&&refs.every((n,i)=>n>0||rates[i]===0)?Math.max(...rates.map((n,i)=>refs[i]===0?0:n/refs[i])):null;
    if(strict&&(r.free||multiplier===null||!(multiplier<0.05))) return [];
    return [{model:r.modelId,route:r.id,provider:r.offers.map(o=>o.displayName??o.provider),prices:rates,multiplier,trust:r.offers.map(o=>o.effectiveReputationScore??null),stakersOnly:r.offers.some(o=>o.freeTier?.base?.stakersOnly===true||o.freeTier?.stakersOnly===true),health:r.offers.map(o=>o.health?.status??'unknown')}];
  });
  emit('catalog',{models:data.length,free:collect(free,false),below005:collect(cheap,true),priceOrder:['input','output','cached'],source:'local_buyer_advertised_not_inference_tested'});
}
async function main() {
  const opt=args();
  if(opt.help){console.log('node bin/antseed-network-diagnose.mjs [--profile default] [--data-root PATH] [--config FILE] [--buyer-port PORT] [--seconds 90] [--self-test]');return;}
  if(opt.selfTest){assert.equal(String(decode(Buffer.from('d1:y1:re')).y),'r');assert.throws(()=>decode(Buffer.from('d1:y1:reX')));assert.equal(String(decode(query('get_peers',Buffer.alloc(4))).q),'get_peers');assert.equal((await loopback()).state,'reply');emit('self_test',{passed:4});return;}
  const root=opt.dataRoot??process.env.MAGPIE_ANTSEED_DATA_DIR??join(process.env.XDG_DATA_HOME??join(homedir(),'.local','share'),'magpie-antseed');
  const profile=join(root,'profiles',opt.profile);
  const cfg=await load(opt.config??join(profile,'antseed-config.json')); const state=await load(join(profile,'runtime.json')); const settings=await load(join(profile,'settings.json'));
  const port=Number(opt.buyerPort??state?.buyerPort??settings?.buyerPort??cfg?.buyer?.proxyPort??8377);
  if(!validPort(port)) throw Error('invalid resolved buyer port');
  const runtime=process.env.MAGPIE_ANTSEED_RUNTIME_DIR??join(root,'runtime-0.1.259'); const pkg=await load(join(runtime,'node_modules','@antseed','cli','package.json'));
  const docker=run('docker',['inspect','--format','{{.HostConfig.NetworkMode}}','magpie-antseed']);
  emit('environment',{platform:platform(),node:process.version,containerMarker:await exists('/.dockerenv'),dockerNetwork:docker.status===0?docker.stdout.trim():'unavailable',profile:opt.profile,buyerPort:port,cliVersion:pkg?.version??null,proxyEnvPresent:Object.keys(process.env).some(k=>/^(http|https|all)_proxy$/i.test(k))});
  const b=cfg?.buyer,n=cfg?.network,caps=b?.maxPricing?.defaults;
  emit('profile_config',{present:!!cfg,officialBootstrapDisabled:cfg?n?.noOfficialBootstrap===true:null,extraBootstrapCount:cfg?(Array.isArray(n?.bootstrapNodes)?n.bootstrapNodes.length:0):null,dhtPort:n?.dhtPort??null,bindHost:n?.bindHost??null,metadataTimeoutMs:b?.metadataFetchTimeoutMs??null,refreshMs:b?.peerRefreshIntervalMs??null,minTrustScore:b?.routingPreferences?.minTrustScore??null,minPeerReputation:b?.minPeerReputation??null,allowedPeerCount:b?.routingPreferences?.allowedPeerIds?.length??0,blockedPeerCount:b?.routingPreferences?.blockedPeerIds?.length??0,priceCaps:caps?Object.fromEntries(priceFields.map(k=>[k,typeof caps[k]==='number'?caps[k]:null])):null,allThreeCapsZero:priceFields.every(k=>caps?.[k]===zero[k]),autoSweep:b?.autoSweep??null});
  emit('udp_loopback',await loopback());
  const officialReplies=await Promise.all(official.map(h=>probe(h)));
  const fallbackReplies=officialReplies.some(Boolean)?[]:await Promise.all(fallback.map(h=>probe(h)));
  emit('bootstrap_summary',{officialResponded:officialReplies.filter(Boolean).length,fallbackResponded:fallbackReplies.filter(Boolean).length,fallbackProbed:fallbackReplies.length,probeIndependentOfBuyerConfig:true});
  const base=`http://127.0.0.1:${port}`; const deadline=Date.now()+opt.seconds*1000; let status, peers, models, counts;
  do {
    [status,peers,models]=await Promise.all([get(base,'/_antseed/status'),get(base,'/_antseed/peers'),get(base,'/v1/models?type=text')]);
    counts=discoveryCounts(status.data); emit('buyer',{error:status.error??null,...counts,catalogModels:Array.isArray(models.data?.data)?models.data.data.length:null,peerEndpointError:peers.error??null,catalogError:models.error??null});
    if(status.error||Date.now()>=deadline) break;
    await sleep(Math.min(10000,Math.max(0,deadline-Date.now())));
  }while(true);
  if(models.data) await catalog(models.data.data,base);
  const cached=await get('https://antscan.co','/api/marketplace?limit=1');
  emit('public_marketplace',{error:cached.error??null,collectorLastPoll:cached.data?.collector?.lastPollCompletedAt??null,returnedOffers:Array.isArray(cached.data?.offerings)?cached.data.offerings.length:null,source:'cached_not_local_discovery'});
  const discoveryObserved=counts.dhtNodes>0&&counts.peers>0;
  if(!discoveryObserved) process.exitCode=2;
  emit('result',{inferencePosts:0,paymentPosts:0,discoveryObserved,notes:'No configuration changes; no inference, funding, staking or settlement commands. Run in the actual Buyer network namespace.'});
}
main().catch(e=>{emit('fatal',{error:errorCode(e),message:e.message});process.exitCode=1;});
