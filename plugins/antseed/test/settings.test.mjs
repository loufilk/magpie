import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSettings, numberOrNull } from '../page/settings.mjs';

const fields={preferFree:true,freeOnly:false,includeAutoRoutes:true,includePinnedRoutes:true,allowedPeers:'',blockedPeers:'',models:''};
test('settings keep zero as a cap and blank as unknown; invalid values cannot loosen caps',()=>{
  assert.equal(numberOrNull(''),null); assert.equal(numberOrNull('0'),0);
  for(const value of ['-1','NaN','Infinity','0x10','1e20'])assert.throws(()=>numberOrNull(value));
  const saved=collectSettings({discoveryTimeoutMs:1234}, {...fields,maxInputUsdPerMillion:'0'},[]);
  assert.equal(saved.maxInputUsdPerMillion,0);assert.equal(saved.maxOutputUsdPerMillion,null);assert.equal(saved.discoveryTimeoutMs,1234);
});
test('per-model rules preserve decimal multipliers and refuse ambiguous duplicate rules',()=>{
  const rule={model:'deepseek-test',maxMultiplier:'.05',maxInputUsdPerMillion:'0.002'};
  const saved=collectSettings({},fields,[rule]);assert.equal(saved.rules['deepseek-test'].maxMultiplier,.05);
  assert.throws(()=>collectSettings({},fields,[rule,rule]),/Duplicate/);
  assert.throws(()=>collectSettings({},fields,[{model:'__proto__',freeOnly:true}]),/valid model/);
});
test('invalid seller lists fail closed and every route cannot be hidden accidentally',()=>{
  assert.throws(()=>collectSettings({}, {...fields,allowedPeers:'bad-address'},[]),/peer ID/);
  assert.throws(()=>collectSettings({}, {...fields,includeAutoRoutes:false,includePinnedRoutes:false},[]),/at least/);
  const id='0x'+'ab'.repeat(20);assert.deepEqual(collectSettings({}, {...fields,allowedPeers:id+'\n'+id},[]).allowedPeers,[id]);
});
