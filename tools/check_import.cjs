// Production parser and shared import flow, exercised without browser automation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const store = fs.readFileSync('js/store.js', 'utf8');
const app = fs.readFileSync('js/app.js', 'utf8');
const css = fs.readFileSync('css/styles.css', 'utf8');
const writes = [], images = new Map();
const context = vm.createContext({
  t: (key) => key, location: { hostname: 'localhost' },
  localStorage: { setItem(key, value) { writes.push([key, value]); } },
  putImage: async (key, value) => images.set(key, value), imgKey: (id, name) => `${id}|${name}`,
  connect() {}, applyPreset() {}, renderSettings() {}, toast() {},
});
vm.runInContext(store.replace(/^import .*\n/, '').replace(/export /g, ''), context);
vm.runInContext('let S = defaultState();', context);
vm.runInContext(app.slice(app.indexOf('async function importSettings(text)'), app.indexOf("$('#fileImport').onchange")), context);
const run = (code) => vm.runInContext(code, context);
const original = run('S');
const png = 'data:image/png;base64,aGVsbG8=';
const backup = { version: 3, presets: [{ id: 'one', name: 'One', cells: [{ label: 'Hello' }], images: { Source: png, Unsafe: 'javascript:alert(1)' } }], activePreset: 'one' };
(async () => {
  for (const text of ['{', '', 'null', '[]', '{}', '{"presets":[]}', '{"presets":[null]}', '{"presets":[{}]}', '{"cells":[null]}', '{"cells":[],"grid":null}']) {
    await assert.rejects(context.importSettings(text));
    assert.equal(run('S'), original, 'invalid input must not replace live settings');
    assert.equal(writes.length, 0); assert.equal(images.size, 0);
  }
  await context.importSettings(JSON.stringify(backup));
  assert.equal(run('S.cells[0].label'), 'Hello');
  assert.equal(images.get('one|Source'), png); assert.equal(images.size, 1);
  assert.equal(writes.length, 1);
  assert(!writes[0][1].includes('data:image/'), 'images must not reach localStorage');
  assert(!('images' in JSON.parse(writes[0][1]).presets[0]));
  const duplicate = structuredClone(backup); duplicate.presets.push(structuredClone(duplicate.presets[0]));
  const parsed = context.parseBackup(JSON.stringify(duplicate));
  assert.notEqual(parsed.state.presets[0].id, parsed.state.presets[1].id);
  assert.equal(parsed.thumbnails[1][0], parsed.state.presets[1].id, 'images follow regenerated duplicate IDs');
  const legacy = context.parseBackup(JSON.stringify({ cells: [{ label: 'Legacy' }], obs: { host: 'old-machine' } }));
  assert.equal(legacy.state.cells[0].label, 'Legacy'); assert.equal(legacy.state.obs.host, 'old-machine');
  const live = run('S'); const writeCount = writes.length;
  context.putImage = async () => { throw new Error('storage failed'); };
  await assert.rejects(context.importSettings(JSON.stringify(backup)));
  assert.equal(run('S'), live); assert.equal(writes.length, writeCount);
  assert.match(app, /await importSettings\(await f.text\(\)\)/);
  assert.match(app, /await importSettings\(ta.value\)/);
  assert.match(app, /id="importError" role="alert"/);
  assert.match(css, /button,\.btn,\.cell,input,select,textarea,\[role="button"\],#buf\{touch-action:manipulation\}/);
  assert.match(css, /#grid\{[^}]*touch-action:pan-y pinch-zoom/);
  assert.match(css, /#scenes\{[^}]*touch-action:pan-y pinch-zoom/);
  assert.match(css, /input,select\{[^}]*font-size:16px/);
  assert.match(css, /dialog.backup textarea\{[^}]*font:16px/);
  assert(!/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(fs.readFileSync('index.html', 'utf8')));
  console.log('Import validation, shared flow, legacy settings, thumbnail restore/isolation, failures and touch CSS checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
