// Run the production mic handlers against a tiny DOM/OBS fake (no browser needed).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync('js/app.js', 'utf8');
const css = fs.readFileSync('css/styles.css', 'utf8');
const elements = new Map();
const element = (name) => {
  if (!elements.has(name)) {
    const classes = new Set();
    elements.set(name, { classes, classList: { toggle(key, on) { on ? classes.add(key) : classes.delete(key); } } });
  }
  return elements.get(name);
};
const listeners = {};
const context = vm.createContext({
  $: element, t: (key) => key, toast() {},
  S: { mic: { source: 'Mic' }, activePreset: 1 },
  obs: { identified: true, ws: {}, addEventListener(name, handler) { listeners[name] = handler; } },
  act: {},
});
vm.runInContext(app.slice(app.indexOf('let micMuted = null;'), app.indexOf('// Оверлеи')), context);
vm.runInContext(app.slice(app.indexOf("$('#btnMic').onclick ="), app.indexOf("$('#gtimer').onclick =")), context);
const run = (code) => vm.runInContext(code, context);
const state = () => run('micMuted');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const event = (muted, source = 'Mic') => listeners.InputMuteStateChanged({ detail: { inputName: source, inputMuted: muted } });
(async () => {
  run('setMic(true)');
  assert(element('#btnMic').classes.has('alert'));
  assert.equal(element('#btnMic').textContent, 'hdr.micMuted');
  event(false, 'Other'); assert.equal(state(), true);
  event(false); assert.equal(state(), false);
  assert(element('#btnMic').classes.has('micon'));
  run('setMic(null)'); assert(element('#btnMic').classes.has('dim'));
  assert(!element('#btnMic').classes.has('micon'));

  let pending = deferred(); context.act.getMute = () => pending.promise;
  let work = run('refreshMic()'); event(true); pending.resolve(false); await work;
  assert.equal(state(), true, 'newer OBS event beats an older query');
  for (const change of ['S.activePreset++', 'S.mic.source = "Other"', 'obs.ws = {}', 'obs.identified = false; setMic(null)']) {
    run('S.mic.source = "Mic"; obs.identified = true');
    pending = deferred(); work = run('refreshMic()'); run(change); pending.resolve(true); await work;
    assert.equal(state(), null, 'old context cannot restore mute state');
  }
  event(false); assert.equal(state(), null, 'ignore events while disconnected');
  run('obs.identified = true; setMic(true)');
  pending = deferred(); let calls = 0;
  context.act.toggleMute = () => { calls++; return pending.promise; };
  work = element('#btnMic').onclick();
  await element('#btnMic').onclick(); assert.equal(calls, 1, 'ignore overlapping toggle taps');
  assert.equal(state(), true, 'no optimistic unmute');
  pending.resolve(false); await work; assert.equal(state(), false);
  run('setMic(true)');
  context.act.toggleMute = async () => { throw new Error('failed'); };
  context.act.getMute = async () => true;
  await element('#btnMic').onclick(); assert.equal(state(), true, 'failed unmute remains muted after OBS confirmation');
  context.act.getMute = async () => { throw new Error('offline'); };
  await element('#btnMic').onclick(); assert.equal(state(), null, 'failed query means unknown, not unmuted');
  run('setMic(undefined)'); assert.equal(state(), null);
  assert.match(app, /function applyPreset\(\) \{\s*setMic\(null\)/);
  assert.match(app, /function connect\(\) \{ setMic\(null\)/);
  assert(css.includes('#btnMic.alert{animation:micblink .4s steps(2) infinite}@keyframes micblink{0%{background:#ff1a1a;box-shadow:0 0 18px #ff1a1a}50%{background:#5a0d0d;box-shadow:none}}'));
  assert(!/micpanel|mic-muted/.test(css), 'no left-panel mute styling');
  assert(!app.includes("classList.toggle('mic-muted'"));
  assert.match(css, /prefers-reduced-motion:reduce\)\{#btnMic\.alert\{animation:none;background:#ff1a1a/);
  assert(fs.readFileSync('sw.js', 'utf8').includes('overlay-pad-' + fs.readFileSync('VERSION', 'utf8').trim()));
  console.log('Mic state, stale replies, failed toggles, overlapping taps, CSS and version checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
