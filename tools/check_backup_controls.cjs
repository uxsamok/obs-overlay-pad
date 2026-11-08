const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync('js/app.js', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');
const css = fs.readFileSync('css/styles.css', 'utf8');
const controls = new Map();
const get = (name) => { if (!controls.has(name)) controls.set(name, { click() { this.clicks = (this.clicks || 0) + 1; } }); return controls.get(name); };
let downloads = 0, shown = 0, lastDialog;
const listeners = new Map();
const viewport = { height: 300, offsetTop: 100, addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); } };
const context = vm.createContext({
  $: get, S: { presets: [{ id: 'p1', cells: [] }] }, images: new Map([['p1|Source', 'data:image/png;base64,aGVsbG8=']]),
  t: (key) => key, toast() {}, setTimeout() {}, Blob,
  URL: { createObjectURL() { return 'blob:backup'; } },
  window: { visualViewport: viewport, addEventListener() {}, removeEventListener() {} },
  document: {
    body: { appendChild() {} },
    createElement(tag) {
      if (tag === 'a') return { style: {}, click() { downloads++; } };
      const styles = new Map(), events = {};
      const textarea = {};
      lastDialog = { styles, events, classList: { add() {} }, style: { setProperty(key, value) { styles.set(key, value); } },
        setAttribute() {}, querySelector() { return textarea; }, addEventListener(name, fn) { events[name] = fn; },
        showModal() { shown++; }, remove() { this.removed = true; },
      };
      return lastDialog;
    },
  },
});
vm.runInContext(app.slice(app.indexOf('function showBackupDialog'), app.indexOf('async function importSettings')), context);
get('#btnExportFile').onclick();
assert.equal(downloads, 1); assert.equal(shown, 0, 'file export does not show a text dialog');
get('#btnExportText').onclick();
assert.equal(downloads, 1, 'text export does not download'); assert.equal(shown, 1);
assert.equal(lastDialog.querySelector().value, context.backupJson());
assert.equal(JSON.parse(context.backupJson()).presets[0].images.Source, context.images.get('p1|Source'));
assert.equal(lastDialog.styles.get('--backup-height'), '300px');
assert.equal(lastDialog.styles.get('--backup-top'), '100px');
viewport.height = 220; listeners.get('resize')();
assert.equal(lastDialog.styles.get('--backup-height'), '220px');
lastDialog.events.close(); assert.equal(listeners.size, 0); assert(lastDialog.removed);
get('#btnImportFile').onclick(); assert.equal(get('#fileImport').clicks, 1);
assert.equal((html.match(/class="backup-controls" role="group"/g) || []).length, 2);
for (const id of ['btnImportFile', 'btnImportText', 'btnExportFile', 'btnExportText']) assert(html.includes(`id="${id}"`));
assert.match(app, /showBackupDialog\(d\); ta.focus\(\);/, 'retain immediate import focus');
assert(!/clipboard\.read|readText\(/.test(app));
assert.match(css, /dialog.backup-editor textarea\{[^}]*min-height:64px/);
assert.match(css, /dialog.backup-editor h3,dialog.backup-editor label,dialog.backup-editor \.row\{flex-shrink:0\}/);
console.log('Backup row structure, separate export actions/data, file picker, viewport updates/cleanup and import focus checks passed');
