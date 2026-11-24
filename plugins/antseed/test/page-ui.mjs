import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here,'..');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const captured=[];
const bridge=`window.magpie={ready:Promise.resolve({dark:false,lang:'zh'}),onTheme:(fn)=>{window.changeTheme=fn},options:{get:async()=>({preferFree:true,includeAutoRoutes:true,includePinnedRoutes:true,freeOnly:false,allowedPeers:[],blockedPeers:[],models:[],rules:{},discoveryTimeoutMs:15000}),set:async(value)=>{window.savedOptions=value;return value}}};`;
const server=createServer(async(req,res)=>{
  if(req.url==='/_magpie/bridge.js'){res.setHeader('content-type','text/javascript');return res.end(bridge);}
  const path=req.url==='/'?'index.html':req.url?.slice(1);
  if(!['index.html','app.js','settings.mjs','style.css','icon.svg'].includes(path)){res.writeHead(404);return res.end();}
  try{
    res.setHeader('content-type',path.endsWith('.html')?'text/html':path.endsWith('.css')?'text/css':path.endsWith('.svg')?'image/svg+xml':'text/javascript');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; font-src 'none'");
    res.end(await readFile(join(root,'page',path)));
  }catch{res.writeHead(500).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_PATH}:{})});
try{
  const page=await browser.newPage({viewport:{width:1280,height:1200}});
  page.on('pageerror',error=>captured.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('#save').waitFor();
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);
  await page.locator('#maxInputUsdPerMillion').fill('0');
  await page.locator('#maxOutputUsdPerMillion').fill('0.2');
  await page.locator('#add-rule').click();
  await page.locator('[data-key=model]').fill('deepseek-test');
  await page.locator('[data-key=maxMultiplier]').fill('0.05');
  await page.locator('#save').click();
  await page.waitForFunction(()=>window.savedOptions?.rules?.['deepseek-test']?.maxMultiplier===0.05);
  assert.equal(await page.evaluate(()=>window.savedOptions.maxInputUsdPerMillion),0);
  assert.equal(await page.evaluate(()=>window.savedOptions.discoveryTimeoutMs),15000);
  assert.match(await page.locator('#status').innerText(),/已保存/);
  const output=resolve(process.env.ANTSEED_UI_OUTPUT_DIR || join(root,'verification/ui'));
  await mkdir(output,{recursive:true});
  await page.screenshot({path:join(output,'desktop-light.png'),fullPage:true});
  await page.setViewportSize({width:375,height:812});
  await page.evaluate(()=>window.changeTheme({dark:true,lang:'zh'}));
  assert.equal(await page.locator('[data-key=model]').inputValue(),'deepseek-test');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile page must not overflow horizontally');
  await page.screenshot({path:join(output,'mobile-dark.png'),fullPage:true});
  await page.evaluate(()=>window.changeTheme({dark:false,lang:'en'}));
  assert.equal(await page.locator('#save').innerText(),'Save settings');
  await page.locator('#allowedPeers').fill('invalid-peer');
  await page.waitForFunction(()=>!document.querySelector('#save').disabled);
  await page.locator('#save').click();
  assert.match(await page.locator('#status').innerText(),/Invalid peer ID/);
  assert.deepEqual(captured,[]);
  console.log('Page UI passed: desktop/mobile, light/dark, Chinese/English, saving strict zero/ratio limits, invalid peer rejection and no horizontal overflow.');
}finally{
  await browser.close();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
