// Media sources sync a frame only if some path is a video/image file; audio, folders and unknown are skipped silently.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync('js/app.js', 'utf8');
const settings = {
  'Music folder': { playlist: [{ value: 'E:\\music' }, { value: 'E:\\music\\intro.MP3' }] },
  'Song': { local_file: 'E:\\a\\song.mp3' },
  'Clip': { local_file: 'E:\\v\\Clip.MP4' },
  'Mixed': { playlist: [{ value: 'E:\\music' }, { value: 'E:\\v\\goal.webm' }] },
  'Pictures': { playlist: [{ value: 'E:\\img\\logo.avif' }] },
  'Scan': { local_file: 'E:\\img\\scan.TIF' },
  'Tape': { local_file: 'E:\\v\\tape.mpeg' },
  'Phone photo': { local_file: 'E:\\img\\IMG_0001.HEIC' },
  'Old clip': { playlist: [{ value: 'E:\\music' }, { value: 'E:\\v\\old.m4v' }] },
};
const calls = [];
const context = vm.createContext({
  obs: { async call(req, data) { calls.push(req); if (req !== 'GetInputSettings') throw new Error('unexpected ' + req); return { inputSettings: settings[data.inputName] }; } },
});
vm.runInContext(app.slice(app.indexOf('const VISUAL_EXT'), app.indexOf('async function detectAudio')), context);
(async () => {
  const skip = async (n) => vm.runInContext(`isAudio(${JSON.stringify(n)})`, context);
  assert.equal(await skip('Music folder'), true, 'VLC folder of MP3s must be skipped');
  assert.equal(await skip('Song'), true);
  assert.equal(await skip('Clip'), false, 'uppercase .MP4 is a video');
  assert.equal(await skip('Mixed'), false, 'one video path is enough');
  assert.equal(await skip('Pictures'), false);
  assert.equal(await skip('Scan'), false, '.TIF is an image');
  assert.equal(await skip('Tape'), false, '.mpeg is a video');
  assert.equal(await skip('Phone photo'), false, '.HEIC is an image');
  assert.equal(await skip('Old clip'), false, '.m4v is a video');
  assert.ok(calls.every((c) => c === 'GetInputSettings'), 'no screenshot or media calls while deciding');
  const audio = JSON.parse(vm.runInContext('JSON.stringify([...audioSrc].sort())', context));
  assert.deepEqual(audio, ['Music folder', 'Song'], 'skipped sources get the note icon');
  // refreshImages builds its sync list only from sources isAudio() did not skip
  assert.match(app, /if \(!\(await isAudio\(n\)\)\) vidNames\.push\(n\)/);
  console.log('check_vlc_sync: OK');
})().catch((e) => { console.error(e); process.exit(1); });
