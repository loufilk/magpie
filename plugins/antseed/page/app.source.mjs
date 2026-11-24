import { BOOL_FIELDS, PRICE_FIELDS, collectSettings } from './settings.mjs';

const english = {
  title: 'Use the network at your price', intro: 'Connect a gateway in Providers → Antseed. Models refresh automatically; your balance and usage appear on the provider card.',
  walletTitle: 'Wallet & funding', walletBody: 'Choose “Wallet / funding console” in Antseed’s sign-in options. Use a card or Base USDC in the official console, and manage statements, budgets and multiple wallets there.',
  routing: 'Models & routing', routingSub: 'Quotes checked before each request', preferFree: 'Prefer free offers', preferFreeHelp: 'Choose eligible zero-price sellers first, then compare paid offers.',
  freeOnly: 'Free models only', freeOnlyHelp: 'Input, output and cache reads must all be free. Sellers may impose conditions on free allowances.',
  auto: 'Show automatic selection', autoHelp: 'Select an eligible seller before a request. Later requests avoid sellers in cooldown after a failure.',
  pinned: 'Show individual sellers', pinnedHelp: 'Model IDs include the seller ID, for fixed routes and price comparisons.',
  caps: 'Global price limits', capsHelp: 'Leave blank to use gateway settings. Enter 0 to allow zero-price offers only. All limits apply together.',
  input: 'Input', output: 'Output', cache: 'Cache read', rules: 'Rules by model', addRule: '+ Add model',
  rulesHelp: 'The stricter model or global limit wins. A multiplier is offer price ÷ the catalog’s retail reference price. Missing reference prices block that model’s request.',
  noRules: 'All models use the global settings', scope: 'Sellers & models', allowed: 'Allowed sellers', allowedHelp: 'One peer ID per line. Blank allows all sellers.',
  blocked: 'Blocked sellers', blockedHelp: 'Block rules take precedence.', models: 'Allowed models', modelsHelp: 'One catalog model ID per line. Blank allows all available models.',
  save: 'Save settings', accounting: 'Actual spend comes from the Antseed request ledger. Catalog quotes and retail references are used for selection; pending settlement is shown in the official console.',
  model: 'Model ID', multiplier: 'Max. multiplier', remove: 'Remove', freeRule: 'Free offers only for this model', saved: 'Saved. The next catalog refresh and request use these settings.', saving: 'Saving…',
  preview: 'Preview mode. Open this page inside Magpie to save settings.', failed: 'Could not load settings. Reopen this page in Magpie.', invalid: 'Check your input: ', loading: 'Loading settings…'
};
const chinese = {
  model: '模型 ID', multiplier: '最高倍率', remove: '删除', input: '输入', output: '输出', cache: '缓存读取', freeRule: '此模型仅使用免费报价',
  saved: '已保存。下次刷新模型列表与调用时使用新设置。', saving: '正在保存…', preview: '预览模式：请从 Magpie 插件页面打开后保存设置。',
  failed: '设置读取失败，请从 Magpie 重新打开此页面。', invalid: '请检查输入：', loading: '正在读取设置…'
};
const defaults = { preferFree:true, freeOnly:false, includeAutoRoutes:true, includePinnedRoutes:true, rules:{}, allowedPeers:[], blockedPeers:[], models:[] };
const original = new Map([...document.querySelectorAll('[data-i18n]')].map(el => [el, el.textContent]));
let locale = 'zh';
let options = {};
let bridge = null;
let saving = false;
const status = document.getElementById('status');
const save = document.getElementById('save');
const rows = document.getElementById('rule-rows');
function t(key) { return (locale === 'zh' ? chinese[key] : english[key]) ?? english[key] ?? key; }
function show(message, error=false) { status.textContent=message; status.classList.toggle('error',error); }
function rowValues() {
  return [...rows.children].map(row => Object.fromEntries([...row.querySelectorAll('[data-key]')].map(el => [el.dataset.key, el.type==='checkbox' ? el.checked : el.value])));
}
function applyTheme(theme) {
  if (!theme) return;
  document.documentElement.dataset.theme=theme.dark?'dark':'light';
  const next = String(theme.lang ?? 'zh').startsWith('zh') ? 'zh' : 'en';
  const values = rowValues();
  locale=next;
  document.documentElement.lang=locale==='zh'?'zh-CN':'en';
  for (const [el,zh] of original) el.textContent=locale==='zh'?zh:(english[el.dataset.i18n]??zh);
  rows.replaceChildren();
  values.forEach(addRow);
}
function field(key,label,value='',type='number') {
  const holder=document.createElement('label');
  const caption=document.createElement('span'); caption.textContent=label;
  const input=document.createElement('input'); input.dataset.key=key; input.type=type; input.value=value??'';
  if(type==='number'){input.min='0';input.step='any';input.inputMode='decimal';input.placeholder='—';}
  else { input.placeholder='deepseek-v3.2'; input.maxLength=300; }
  holder.append(caption,input); return holder;
}
function emptyState(){document.getElementById('rules-empty').hidden=rows.children.length!==0;}
function addRow(value={}) {
  const row=document.createElement('div');row.className='rule';
  const top=document.createElement('div');top.className='rule-top';
  top.append(field('model',t('model'),value.model,'text'));
  const remove=document.createElement('button');remove.type='button';remove.className='secondary';remove.textContent=t('remove');
  remove.addEventListener('click',()=>{row.remove();emptyState();});top.append(remove);
  const grid=document.createElement('div');grid.className='rule-fields';
  grid.append(field('maxMultiplier',t('multiplier'),value.maxMultiplier));
  ['input','output','cache'].forEach((key,i)=>grid.append(field(PRICE_FIELDS[i],t(key),value[PRICE_FIELDS[i]])));
  const free=document.createElement('label');free.className='rule-free';const cb=document.createElement('input');cb.type='checkbox';cb.dataset.key='freeOnly';cb.checked=!!value.freeOnly;
  free.append(cb,document.createTextNode(t('freeRule')));row.append(top,grid,free);rows.append(row);emptyState();
}
function renderSettings(value){
  options={...defaults,...value};
  BOOL_FIELDS.forEach(key=>{document.getElementById(key).checked=options[key]??defaults[key];});
  PRICE_FIELDS.forEach(key=>{document.getElementById(key).value=options[key]??'';});
  ['allowedPeers','blockedPeers','models'].forEach(key=>{document.getElementById(key).value=(options[key]??[]).join('\n');});
  rows.replaceChildren();for(const [model,rule] of Object.entries(options.rules??{}))addRow({model,...rule});emptyState();
}
document.getElementById('add-rule').addEventListener('click',()=>addRow());
document.getElementById('settings').addEventListener('submit',async event=>{
  event.preventDefault();if(!bridge||saving)return;
  try{
    const fields=Object.fromEntries([...BOOL_FIELDS,...PRICE_FIELDS,'allowedPeers','blockedPeers','models'].map(key=>{const el=document.getElementById(key);return[key,el.type==='checkbox'?el.checked:el.value];}));
    const next=collectSettings(options,fields,rowValues());
    saving=true;save.disabled=true;show(t('saving'));
    const persisted=await bridge.options.set(next);options={...next,...persisted};show(t('saved'));
  }catch(error){show(t('invalid')+String(error.message??error),true);}
  finally{setTimeout(()=>{saving=false;save.disabled=!bridge;},1100);}
});
renderSettings(defaults);save.disabled=true;show(t('loading'));
try{
  if(!window.magpie?.ready){show(t('preview'));}
  else{
    const theme=await window.magpie.ready;applyTheme(theme);
    const saved=await window.magpie.options.get();renderSettings(saved);
    bridge=window.magpie;save.disabled=false;show('');bridge.onTheme?.(applyTheme);
  }
}catch{show(t('failed'),true);}
