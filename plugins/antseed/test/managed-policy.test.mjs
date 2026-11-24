import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareManagedRoute } from '../lib/managed-policy.mjs';

const peer='ab'.repeat(20);
const route={id:`${peer}@model-test`,modelId:'model-test',peerId:peer,offers:[{serviceId:'model-test'}],policy:{maxInputUsdPerMillion:.02,maxOutputUsdPerMillion:.08,maxCachedInputUsdPerMillion:.01}};
const connection={mode:'managed',workspaceId:'workspace-test'};
const options={rules:{'model-test':{maxMultiplier:.05}}};
test('model limits become an immutable official preset; same key and no prompt injection',async()=>{
  const presets=[]; const writes=[];
  const runtime={managementRequest:async(path,init)=>{
    if(init.method==='GET')return Response.json(presets);
    const row=JSON.parse(init.body); writes.push(row);presets.push(row);return Response.json(row,{status:201});
  }};
  const first=await prepareManagedRoute(connection,route,options,{},runtime);
  assert.match(first,/^@preset\/magpie-[a-f0-9]{32}$/);
  const second=await prepareManagedRoute(connection,route,options,{},runtime);
  assert.equal(first,second);assert.equal(writes.length,1);
  assert.equal(writes[0].systemPrompt,null);assert.deepEqual(writes[0].params,{});
  assert.deepEqual(writes[0].routingPolicy,{allowedPeerIds:[peer],maxInputUsdPerMillion:.02,maxOutputUsdPerMillion:.08,maxCachedInputUsdPerMillion:.01});
  presets[0].routingPolicy.maxInputUsdPerMillion=99;
  await assert.rejects(()=>prepareManagedRoute(connection,route,options,{},runtime),/被修改/);
});
test('failed policy management stops inference and cannot silently drop a cap',async()=>{
  const runtime={managementRequest:async()=>Response.json({error:'down'},{status:503})};
  await assert.rejects(()=>prepareManagedRoute(connection,route,options,{},runtime),/读取失败/);
  await assert.rejects(()=>prepareManagedRoute(connection,{...route,policy:null},options,{},runtime),/尚未解析/);
});
test('concurrent preset creation is recovered by verifying the exact existing policy',async()=>{
  let preset=null;let firstRead=true;
  const runtime={managementRequest:async(path,init)=>{
    if(init.method==='GET'){if(firstRead){firstRead=false;return Response.json([]);}return Response.json([preset]);}
    preset=JSON.parse(init.body);return Response.json({}, {status:409});
  }};
  assert.match(await prepareManagedRoute(connection,route,options,{},runtime),/^@preset\//);
});
test('free model rules enforce all three zero caps; remote calls keep their explicit route',async()=>{
  let saved;
  const runtime={managementRequest:async(path,init)=>init.method==='GET'?Response.json([]):(saved=JSON.parse(init.body),Response.json(saved,{status:201}))};
  await prepareManagedRoute(connection,{...route,policy:{freeOnly:true}},options,{},runtime);
  for(const key of ['maxInputUsdPerMillion','maxOutputUsdPerMillion','maxCachedInputUsdPerMillion'])assert.equal(saved.routingPolicy[key],0);
  assert.equal(await prepareManagedRoute({mode:'gateway'},route,options,{},null),route.id);
});
