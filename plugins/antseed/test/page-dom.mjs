import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

// Optional DOM behavior check; browser rendering is covered separately by page-ui.mjs.
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_MODULE || 'jsdom');
const base = new URL('../page/', import.meta.url);
const html = await readFile(new URL('index.html', base), 'utf8');
const script = await readFile(new URL('app.js', base), 'utf8');
assert.doesNotMatch(html, /type=["']module/);
const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => errors.push(error.message));
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://magpie.example/plugin/', virtualConsole });
const { window } = dom;
const { document } = window;
let saved;
let changeTheme;
window.magpie = {
  ready: Promise.resolve({ dark: false, lang: 'zh' }),
  onTheme: callback => { changeTheme = callback; },
  options: {
    get: async () => ({ discoveryTimeoutMs: 17000, customPreserved: 'keep' }),
    set: async options => { saved = JSON.parse(JSON.stringify(options)); return options; },
  },
};
try {
  await window.eval(script);
  assert.equal(document.getElementById('save').disabled, false);
  document.getElementById('maxInputUsdPerMillion').value = '0';
  document.getElementById('maxOutputUsdPerMillion').value = '0.2';
  document.getElementById('add-rule').click();
  document.querySelector('[data-key=model]').value = 'deepseek-test';
  document.querySelector('[data-key=maxMultiplier]').value = '0.05';
  document.querySelector('[data-key=freeOnly]').checked = true;
  document.getElementById('settings').dispatchEvent(new window.Event('submit', { cancelable: true }));
  // Flush the cross-realm Promise continuations of the async submit handler.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.maxInputUsdPerMillion, 0);
  assert.equal(saved.maxOutputUsdPerMillion, 0.2);
  assert.equal(saved.rules['deepseek-test'].maxMultiplier, 0.05);
  assert.equal(saved.rules['deepseek-test'].freeOnly, true);
  assert.equal(saved.customPreserved, 'keep');
  assert.equal(saved.discoveryTimeoutMs, 17000);
  assert.match(document.getElementById('status').textContent, /已保存/);
  changeTheme({ dark: true, lang: 'en' });
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(document.getElementById('save').textContent, 'Save settings');
  assert.equal(document.querySelector('[data-key=model]').value, 'deepseek-test');
  assert.equal(document.querySelector('[data-key=maxMultiplier]').value, '0.05');
  assert.equal(document.querySelector('[data-key=freeOnly]').checked, true);
  document.querySelector('.rule-top button').click();
  assert.equal(document.getElementById('rules-empty').hidden, false);
  assert.deepEqual(errors, []);
  console.log('DOM interactions passed: classic script, bridge load/save, strict zero and multiplier, preserved options, rule editing, language and theme.');
} finally {
  window.close();
}
