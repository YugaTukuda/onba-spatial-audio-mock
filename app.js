import { AudioEngine } from './audio-engine.js';
import { HeadTracker } from './tracking.js';
import { ROOM_PRESETS, DEFAULT_ROOM, normalizeRoom, roomMetrics } from './room-acoustics.js';
import { initialScene, makeSource, validateScene, MAX_SOURCES, MAX_FILE_BYTES, DEMOS, CLIPS, clamp, wrapAngle, distance, toBase64 } from './scene.js';

const $ = id => document.getElementById(id);
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let scene = initialScene();
let selected = scene.sources[0].id;
let tool = 'move';
let audioTarget = null;
let fileBusy = false;
let dirty = true;
let toastTimeout;
let dragging = null;
let geometry = { x: 50, y: 50, size: 400, scale: 40 };
let width = 600, height = 600;
let lastDraw = 0, lastFrame = performance.now(), lastReadout = 0;
const pressed = new Set();
const engine = new AudioEngine();
const canvas = $('room');
const ctx = canvas.getContext('2d');
const tracker = new HeadTracker($('webcam'), $('face-overlay'), trackingUpdate);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

function toast(message, error = false) {
  clearTimeout(toastTimeout);
  $('toast').textContent = message;
  $('toast').className = `toast show${error ? ' error' : ''}`;
  toastTimeout = setTimeout(() => $('toast').classList.remove('show'), error ? 6500 : 3300);
}
function currentSource() { return scene.sources.find(s => s.id === selected); }
function orientation() { return { yaw: wrapAngle(scene.listener.yaw + tracker.offset.yaw), pitch: tracker.offset.pitch }; }
function paintRange(input) { input.style.setProperty('--value', `${(input.value - input.min) / (input.max - input.min) * 100}%`); }
function setField(id, value) { const element = $(id); if (document.activeElement !== element) element.value = value; }
function changed() { dirty = true; }

function renderRoom() {
  const room = scene.room;
  const metrics = roomMetrics(room);
  $('room-preset').value = $('room-preset-detail').value = room.preset;
  $('room-rt60-summary').textContent = metrics.rt60.toFixed(2);
  $('room-height-summary').textContent = room.height.toFixed(1);
  $('rt60-mode-label').textContent = room.autoRt60 ? '推定 RT60' : '指定 RT60';
  $('room-rt60-readout').textContent = metrics.rt60.toFixed(2);
  $('room-rt60-status').textContent = room.autoRt60 ? metrics.estimatedRt60>6 ? '自動 / 上限6秒' : '自動' : '手動';
  $('room-volume').textContent = `${Math.round(metrics.volume)} m³`;
  setField('room-mix',scene.reverb);
  $('room-mix-value').textContent = `${scene.reverb}%`;
  paintRange($('room-mix'));
  setField('room-height',room.height.toFixed(1));
  $('room-auto-rt60').checked = room.autoRt60;
  $('room-rt60').disabled = room.autoRt60;
  setField('room-rt60',Math.round(metrics.rt60*20)/20);
  setField('room-predelay',room.predelay);
  $('room-predelay-value').textContent = `${room.predelay} ms`;
  for (const [id,key] of [['wall-absorption','wallAbsorption'],['floor-absorption','floorAbsorption'],['ceiling-absorption','ceilingAbsorption']]) {
    setField(id,Math.round(room[key]*100));
    $(`${id}-value`).textContent = `${Math.round(room[key]*100)}%`;
    paintRange($(id));
  }
  ['room-rt60','room-predelay'].forEach(id=>paintRange($(id)));
  ['listener-height','source-height'].forEach(id=>$(id).max=String(Math.min(5,room.height)));
}

function updateRoom(next) {
  scene.room = normalizeRoom(next);
  let adjusted = false;
  for (const point of [scene.listener,...scene.sources]) {
    if (point.height>scene.room.height) { point.height=scene.room.height; adjusted=true; }
  }
  renderRoom(); renderListener(); renderDetail(); changed();
  if (adjusted) toast('天井高に合わせて、音源・耳の高さを調整しました');
}

function chooseRoomPreset(preset) {
  if (preset==='custom') return updateRoom({...scene.room,preset});
  const {label,...parameters}=ROOM_PRESETS[preset];
  updateRoom({...parameters,preset});
}
for (const id of ['room-preset','room-preset-detail']) $(id).addEventListener('change',event=>chooseRoomPreset(event.target.value));
$('room-height').addEventListener('input',event=>{
  const value=event.target.valueAsNumber;
  if (Number.isFinite(value)) updateRoom({...scene.room,preset:'custom',height:clamp(value,2,8)});
});
$('room-height').addEventListener('change',()=>{ $('room-height').value=scene.room.height.toFixed(1); });
for (const [id,key] of [['wall-absorption','wallAbsorption'],['floor-absorption','floorAbsorption'],['ceiling-absorption','ceilingAbsorption']]) {
  $(id).addEventListener('input',event=>updateRoom({...scene.room,preset:'custom',[key]:Number(event.target.value)/100}));
}
$('room-auto-rt60').addEventListener('change',event=>{
  const rt60=clamp(Math.round(roomMetrics(scene.room).rt60*20)/20,.15,6);
  updateRoom({...scene.room,preset:'custom',autoRt60:event.target.checked,rt60});
});
$('room-rt60').addEventListener('input',event=>updateRoom({...scene.room,preset:'custom',autoRt60:false,rt60:Number(event.target.value)}));
$('room-predelay').addEventListener('input',event=>updateRoom({...scene.room,preset:'custom',predelay:Number(event.target.value)}));

function renderSources() {
  $('source-count').textContent = String(scene.sources.length).padStart(2, '0');
  $('source-list').innerHTML = scene.sources.length ? scene.sources.map((source, i) => {
    const inactive = source.muted || (scene.sources.some(s => s.solo) && !source.solo);
    const wave = Array.from({ length: 37 }, (_, n) => `<i style="height:${4 + ((n * 17 + i * 11) % 23)}px;animation-duration:${.6 + (n % 7) * .13}s;animation-delay:-${n * .07}s"></i>`).join('');
    return `<article class="source-card${selected === source.id ? ' selected' : ''}${inactive ? ' muted' : ''}" data-source="${source.id}" style="--source-color:${source.color}" tabindex="0" aria-label="${escapeHTML(source.name)}を選択">
      <div class="source-card-head"><span class="source-symbol">${icon('speaker')}</span><div class="source-card-title"><strong>${escapeHTML(source.name)}</strong><small title="${escapeHTML(source.fileName || DEMOS[source.kind])}">${escapeHTML(source.fileName || DEMOS[source.kind])}</small></div><span class="source-number">${String(i + 1).padStart(2, '0')}</span></div>
      <div class="source-wave" aria-hidden="true">${wave}</div>
      <div class="source-level-row"><input class="source-volume" data-action="volume" type="range" min="0" max="100" value="${source.volume}" aria-label="${escapeHTML(source.name)}の音量" style="--value:${source.volume}%"><span class="source-volume-label">${source.volume}%</span></div>
      <div class="source-card-actions"><button class="mini-button${source.muted ? ' active' : ''}" data-action="mute" aria-label="${escapeHTML(source.name)}をミュート" aria-pressed="${source.muted}" title="ミュート">M</button><button class="mini-button${source.solo ? ' active' : ''}" data-action="solo" aria-label="${escapeHTML(source.name)}をソロ" aria-pressed="${source.solo}" title="ソロ">S</button><span class="source-distance" data-distance="${source.id}">${distance(source, scene.listener).toFixed(2)} m</span><button class="mini-button delete" data-action="delete" aria-label="${escapeHTML(source.name)}を削除" title="削除">${icon('trash')}</button></div>
    </article>`;
  }).join('') : '<p class="empty-sources">まだ音源がありません。<br>音源を追加して、音場をつくりましょう。</p>';
  const unavailable = scene.sources.length >= MAX_SOURCES;
  $('add-source').disabled = $('add-source-secondary').disabled = $('place-tool').disabled = unavailable;
  renderDetail();
}

function renderDetail() {
  const source = currentSource();
  $('source-detail').hidden = !source;
  if (!source) return;
  $('source-detail').style.setProperty('--selected-color', source.color);
  setField('source-name', source.name);
  setField('source-x', source.x.toFixed(2));
  setField('source-z', source.z.toFixed(2));
  setField('source-height', source.height.toFixed(1));
  const fileOption = $('source-kind').querySelector('[value="file"]');
  fileOption.hidden = !source.audio;
  fileOption.textContent = source.fileName || '読み込んだファイル';
  $('source-kind').value = source.audio ? 'file' : source.kind;
}

function selectSource(id) {
  selected = id;
  document.querySelectorAll('.source-card').forEach(card => card.classList.toggle('selected', card.dataset.source === id));
  renderDetail();
  changed();
}

function renderListener() {
  const orient = orientation();
  setField('listener-x', scene.listener.x.toFixed(2));
  setField('listener-z', scene.listener.z.toFixed(2));
  setField('listener-height', scene.listener.height.toFixed(1));
  setField('listener-yaw', Math.round(orient.yaw) % 360);
  $('heading-dial').style.setProperty('--heading', `${orient.yaw}deg`);
  if (document.activeElement !== $('yaw-slider')) $('yaw-slider').value = Math.round(orient.yaw) % 360;
  paintRange($('yaw-slider'));
  $('compass-label').textContent = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'][Math.round(orient.yaw / 45) % 8];
  $('cursor-coordinates').textContent = `X ${scene.listener.x.toFixed(2)} / Z ${scene.listener.z.toFixed(2)} m`;
}

function setTool(next) {
  tool = next;
  $('move-tool').classList.toggle('active', tool === 'move');
  $('place-tool').classList.toggle('active', tool === 'place');
  $('move-tool').setAttribute('aria-pressed', tool === 'move');
  $('place-tool').setAttribute('aria-pressed', tool === 'place');
  $('map-instruction').textContent = tool === 'place' ? 'クリックして、新しい音源を配置' : '空いている場所をクリックして、そこで聴く';
  canvas.style.cursor = tool === 'place' ? 'copy' : 'crosshair';
}

function beginPlace() {
  if (scene.sources.length >= MAX_SOURCES) return toast('音源は16個まで配置できます', true);
  setTool('place');
  canvas.focus({ preventScroll: true });
  toast('平面図をクリックして音源を置いてください');
}
function addSource(x, z) {
  if (scene.sources.length >= MAX_SOURCES) { toast('音源は16個まで配置できます', true); return null; }
  const source = makeSource(scene.sources.length, x, z);
  scene.sources.push(source);
  selected = source.id;
  if (engine.ctx && engine.startedAt !== null) {
    engine.prepareSource(source).then(() => {
      if (!scene.sources.includes(source)) { engine.remove(source.id); return; }
      if (engine.startedAt !== null) engine.attach(source, scene);
      changed();
    }).catch(error => toast(error.message, true));
  }
  renderSources();
  changed();
  return source;
}

$('add-source').addEventListener('click', beginPlace);
$('add-source-secondary').addEventListener('click', beginPlace);
$('place-tool').addEventListener('click', beginPlace);
$('move-tool').addEventListener('click', () => setTool('move'));
$('center-listener').addEventListener('click', () => { Object.assign(scene.listener, { x: 5, z: 5, yaw: 0 }); tracker.calibrate(); renderListener(); changed(); toast('鑑賞者を中央に戻しました'); });

$('source-list').addEventListener('click', event => {
  const card = event.target.closest('[data-source]');
  if (!card) return;
  const source = scene.sources.find(s => s.id === card.dataset.source);
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'mute') { source.muted = !source.muted; renderSources(); }
  else if (action === 'solo') { source.solo = !source.solo; renderSources(); }
  else if (action === 'delete') {
    engine.remove(source.id);
    scene.sources = scene.sources.filter(s => s.id !== source.id);
    if (selected === source.id) selected = scene.sources[0]?.id;
    renderSources();
  } else if (action !== 'volume') selectSource(source.id);
  changed();
});
$('source-list').addEventListener('input', event => {
  if (event.target.dataset.action !== 'volume') return;
  const source = scene.sources.find(s => s.id === event.target.closest('[data-source]').dataset.source);
  source.volume = Number(event.target.value);
  event.target.nextElementSibling.textContent = `${source.volume}%`;
  paintRange(event.target);
  changed();
});
$('source-list').addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.classList.contains('source-card')) {
    event.preventDefault(); event.stopPropagation(); selectSource(event.target.dataset.source);
  }
});

function bindNumber(id, getObject, property, min, max, onChange) {
  $(id).addEventListener('input', event => {
    const object = getObject();
    const number = event.target.valueAsNumber;
    if (!object || !Number.isFinite(number)) return;
    object[property] = clamp(number, min, typeof max==='function'?max():max);
    onChange?.(); changed();
  });
  $(id).addEventListener('change', event => {
    const object = getObject();
    if (!object) return;
    const number = event.target.valueAsNumber;
    if (!Number.isFinite(number)) { event.target.value = object[property]; return; }
    object[property] = clamp(number, min, typeof max==='function'?max():max);
    event.target.value = object[property];
    onChange?.();
    changed();
  });
}
['x', 'z'].forEach(axis => {
  bindNumber(`listener-${axis}`, () => scene.listener, axis, 0, 10, renderListener);
  bindNumber(`source-${axis}`, currentSource, axis, 0, 10, renderDetail);
});
bindNumber('listener-height', () => scene.listener, 'height', 0, () => Math.min(5,scene.room.height), renderListener);
bindNumber('source-height', currentSource, 'height', 0, () => Math.min(5,scene.room.height), renderDetail);
function setHeading(value) { scene.listener.yaw = wrapAngle(value - tracker.offset.yaw); renderListener(); changed(); }
$('listener-yaw').addEventListener('input', event => { if (Number.isFinite(event.target.valueAsNumber)) setHeading(event.target.valueAsNumber); });
$('listener-yaw').addEventListener('change', event => { if (Number.isFinite(event.target.valueAsNumber)) setHeading(event.target.valueAsNumber); else renderListener(); });
$('yaw-slider').addEventListener('input', event => setHeading(Number(event.target.value)));
$('source-name').addEventListener('change', event => {
  const source = currentSource(); if (!source) return;
  source.name = event.target.value.trim() || '名前のない音源';
  renderSources(); changed();
});
$('source-name').addEventListener('input', event => {
  const source = currentSource();
  if (!source) return;
  source.name = event.target.value.trim() || '名前のない音源';
  const card = document.querySelector(`[data-source="${source.id}"]`);
  if (card) {
    card.querySelector('strong').textContent = source.name;
    card.setAttribute('aria-label', `${source.name}を選択`);
  }
  changed();
});
$('source-kind').addEventListener('change', async event => {
  const source = currentSource();
  if (!source || event.target.value === 'file') return;
  if (fileBusy) { renderDetail(); return; }
  const replacement = { ...source, kind: event.target.value, audio: null, fileName: null };
  fileBusy = true;
  try {
    const buffer = await engine.resolveBuffer(replacement);
    if (!scene.sources.includes(source)) return;
    Object.assign(source, replacement);
    engine.replace(source, scene, buffer);
    renderSources(); changed();
  } catch (error) { renderDetail(); toast(error.message, true); }
  finally { fileBusy = false; }
});

function chooseFile(target) { audioTarget = target; $('audio-file').value = ''; $('audio-file').click(); }
$('upload-zone').addEventListener('click', () => chooseFile(currentSource()?.id || null));
$('replace-audio').addEventListener('click', () => chooseFile(selected));
$('audio-file').addEventListener('change', event => { if (event.target.files[0]) loadAudio(event.target.files[0], audioTarget); });
async function loadAudio(file, target, position) {
  if (fileBusy) return toast('前の音声を読み込んでいます');
  if (file.size > MAX_FILE_BYTES) return toast('音声ファイルは20 MBまでです', true);
  if (!file.size) return toast('空のファイルは読み込めません', true);
  let source = scene.sources.find(s => s.id === target);
  if (!source && scene.sources.length >= MAX_SOURCES) return toast('音源は16個まで配置できます', true);
  const total = scene.sources.filter(s => s !== source).reduce((sum, s) => sum + (s.audio?.length || 0) * .75, 0) + file.size;
  if (total > 100 * 1024 * 1024) return toast('読み込む音声の合計は100 MBまでです', true);
  fileBusy = true;
  toast(`「${file.name}」を読み込んでいます…`);
  try {
    const bytes = await file.arrayBuffer();
    const buffer = await engine.decode(bytes);
    // Do not resurrect a source deleted while decoding.
    if (target && !scene.sources.some(s => s.id === target)) return;
    if (!source) source = addSource(position?.x ?? 5, position?.z ?? 5);
    if (!source) return;
    source.fileName = file.name;
    source.audio = toBase64(bytes);
    engine.replace(source, scene, buffer);
    selectSource(source.id);
    renderSources();
    changed();
    toast(`「${file.name}」を設定しました · ${buffer.duration.toFixed(1)}秒`);
  } catch (error) { toast(error.message.includes('5分') ? error.message : '音声を読み込めませんでした。WAVやMP3など、対応する形式を選んでください', true); }
  finally { fileBusy = false; }
}
for (const zone of [$('upload-zone'), $('stage-wrap')]) {
  zone.addEventListener('dragover', event => { event.preventDefault(); zone.classList.add('drop-active'); });
  zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('drop-active'); });
  zone.addEventListener('drop', async event => {
    event.preventDefault(); zone.classList.remove('drop-active');
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    const position = zone === $('stage-wrap') ? mapPoint(event) : null;
    for (let i = 0; i < files.length; i++) {
      await loadAudio(files[i], zone === $('upload-zone') && i === 0 ? currentSource()?.id : null,
        position && { x: clamp(position.x + i * .4, 0, 10), z: clamp(position.z + i * .4, 0, 10) });
    }
  });
}

for (const id of ['master', 'reverb']) $(id).addEventListener('input', event => {
  scene[id] = Number(event.target.value);
  $(`${id}-value`).textContent = `${scene[id]}%`;
  paintRange(event.target);
  if(id==='reverb') { setField('room-mix',scene.reverb); $('room-mix-value').textContent=`${scene.reverb}%`; paintRange($('room-mix')); }
  changed();
});
$('room-mix').addEventListener('input',event=>{
  scene.reverb=Number(event.target.value);
  $('reverb').value=scene.reverb;
  $('reverb-value').textContent=$('room-mix-value').textContent=`${scene.reverb}%`;
  paintRange($('reverb'));paintRange(event.target);changed();
});

let transportBusy = false;
async function togglePlay() {
  if (transportBusy) return;
  if (fileBusy) return toast('ファイルの読み込みが完了するまでお待ちください');
  transportBusy = true;
  $('play').disabled = $('room-audition').disabled = true;
  try {
    if (engine.playing) await engine.pause();
    else if (!scene.sources.length) toast('音源を追加してから再生してください');
    else await engine.play(scene, orientation());
    renderTransport();
  } catch (error) { toast(`再生できませんでした: ${error.message}`, true); }
  finally { transportBusy = false; $('play').disabled = $('room-audition').disabled = false; }
}
function renderTransport() {
  document.body.classList.toggle('playing', engine.playing);
  $('play').innerHTML = `${icon(engine.playing ? 'pause' : 'play')}<span>${engine.playing ? '一時停止' : engine.startedAt !== null ? '再開する' : '試聴する'}</span>`;
  $('stage-status').textContent = engine.playing ? '音場を再生中' : '音場プレビュー';
  $('room-audition').innerHTML = `${icon(engine.playing?'pause':'play')}${engine.playing?'一時停止':'試聴する'}`;
}
$('play').addEventListener('click', togglePlay);
$('room-audition').addEventListener('click',togglePlay);
$('stop').addEventListener('click', async () => {
  if (transportBusy) return;
  transportBusy = true;
  try { await engine.stop(); renderTransport(); $('elapsed').textContent = '00:00'; }
  finally { transportBusy = false; }
});

function cameraUI(active) {
  $('camera-preview').classList.toggle('enabled', active);
  $('camera-placeholder').hidden = active;
  $('camera-options').hidden = !active;
  $('camera-toggle').classList.toggle('is-active', active);
  $('camera-toggle').innerHTML = `${icon('camera')}${active ? 'カメラを停止する' : 'カメラを有効にする'}`;
  $('camera-badge').textContent = active ? 'ON' : 'OFF';
  if (!active) $('camera-note').textContent = '映像は端末内で処理。保存・送信しません。';
}
$('camera-toggle').addEventListener('click', async () => {
  if (tracker.running) {
    scene.listener.yaw = orientation().yaw;
    tracker.stop(); cameraUI(false); renderListener(); changed(); return;
  }
  $('camera-toggle').disabled = true;
  $('camera-toggle').innerHTML = `${icon('camera')}モデルを準備しています…`;
  $('camera-note').textContent = 'ブラウザに表示されるカメラの使用許可を確認してください。';
  try {
    await tracker.start();
    cameraUI(tracker.running);
    if (tracker.running) { $('camera-note').textContent = '正面を向いて「正面を合わせる」を押してください。'; toast('カメラを開始しました。正面を合わせてください'); }
  } catch (error) { cameraUI(false); toast(error.message, true); }
  finally { $('camera-toggle').disabled = false; }
});
$('calibrate-camera').addEventListener('click', () => {
  if (tracker.calibrate()) { renderListener(); changed(); toast('現在の顔の向きを正面に設定しました'); }
  else toast('顔が見つかりません。カメラに顔全体を映してください', true);
});
$('tracking-sensitivity').addEventListener('change', event => tracker.sensitivity = Number(event.target.value));
$('invert-tracking').addEventListener('change', event => tracker.invert = event.target.checked);
function trackingUpdate(result) {
  if (result.error) { cameraUI(false); toast(result.error, true); changed(); return; }
  $('camera-live-label').textContent = result.found ? '● 顔をトラッキング中' : '顔が見つかりません · 向きを保持';
  $('camera-badge').textContent = result.found ? 'LIVE' : 'SEARCH';
  $('camera-yaw').textContent = `${Math.round(result.yaw)}°`;
  $('camera-pitch').textContent = `${Math.round(result.pitch)}°`;
  renderListener(); changed();
}

$('save-scene').addEventListener('click', async () => {
  if (fileBusy || transportBusy) return toast('読み込みが完了してから保存してください');
  const data = structuredClone(scene);
  data.listener.yaw = orientation().yaw;
  data.listener.pitch = 0;
  fileBusy = true;
  $('save-scene').disabled = true;
  try {
  await Promise.all(data.sources.map(async source => {
    const clip = CLIPS[source.kind];
    if (source.audio || !clip) return;
    const response = await fetch(new URL(clip.url, import.meta.url));
    if (!response.ok) throw new Error('同梱音声を取得できませんでした');
    source.audio = toBase64(await response.arrayBuffer());
    source.fileName = clip.fileName;
  }));
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const now = new Date();
  a.download = `ONBA-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}.onba.json`;
  a.href = url; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('音声を含むシーンを保存しました');
  } catch (error) { toast(`保存できませんでした: ${error.message}`, true); }
  finally { fileBusy = false; $('save-scene').disabled = false; }
});
$('load-scene').addEventListener('click', () => {
  if (fileBusy || transportBusy) return toast('読み込みが完了してからシーンを開いてください');
  $('scene-file').value = ''; $('scene-file').click();
});
$('scene-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file || fileBusy || transportBusy) return;
  if (file.size > 145 * 1024 * 1024) return toast('シーンファイルが大きすぎます', true);
  fileBusy = true;
  const decoded = new Map();
  try {
    const loaded = validateScene(JSON.parse(await file.text()));
    // Prepare the whole replacement first; malformed audio leaves the current scene intact.
    for (const source of loaded.sources) {
      await engine.prepareSource(source);
      decoded.set(source.id, engine.buffers.get(source.id));
    }
    await engine.stop();
    engine.buffers.clear();
    decoded.forEach((buffer, id) => engine.buffers.set(id, buffer));
    scene = loaded;
    selected = scene.sources[0]?.id;
    tracker.calibrate();
    renderSources(); renderRoom(); renderListener(); renderTransport();
    ['master', 'reverb'].forEach(id => { $(id).value = scene[id]; paintRange($(id)); $(`${id}-value`).textContent = `${scene[id]}%`; });
    setTool('move'); changed();
    toast('シーンを読み込みました');
  } catch (error) { decoded.forEach((_, id) => engine.buffers.delete(id)); toast(`シーンを開けませんでした: ${error.message}`, true); }
  finally { fileBusy = false; }
});

const helpDialog = $('help-dialog');
const roomDialog = $('room-dialog');
$('open-room-settings').addEventListener('click',()=>{ pressed.clear(); renderRoom(); roomDialog.showModal(); });
$('close-room-settings').addEventListener('click',()=>roomDialog.close());
$('done-room-settings').addEventListener('click',()=>roomDialog.close());
$('reset-room-settings').addEventListener('click',()=>updateRoom({...DEFAULT_ROOM}));
roomDialog.addEventListener('click',event=>{
  if(event.target!==roomDialog)return;
  const rect=roomDialog.getBoundingClientRect();
  if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)roomDialog.close();
});
$('help').addEventListener('click', () => { pressed.clear(); helpDialog.showModal(); });
$('close-help').addEventListener('click', () => helpDialog.close());
$('start-exploring').addEventListener('click', () => helpDialog.close());
helpDialog.addEventListener('click', event => { if (event.target === helpDialog) { const r = helpDialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) helpDialog.close(); } });

function mapPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: clamp((event.clientX - rect.left - geometry.x) / geometry.scale, 0, 10), z: clamp((event.clientY - rect.top - geometry.y) / geometry.scale, 0, 10),
    px: event.clientX - rect.left, py: event.clientY - rect.top };
}
const screenPoint = point => ({ x: geometry.x + point.x * geometry.scale, y: geometry.y + point.z * geometry.scale });
function inRoom(point) { return point.px >= geometry.x && point.px <= geometry.x + geometry.size && point.py >= geometry.y && point.py <= geometry.y + geometry.size; }
function getHandle() {
  const a = orientation().yaw * Math.PI / 180;
  return { x: scene.listener.x + Math.sin(a) * .7, z: scene.listener.z - Math.cos(a) * .7 };
}
canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const point = mapPoint(event);
  if (!inRoom(point)) return;
  canvas.focus({ preventScroll: true });
  if (tool === 'place') { addSource(point.x, point.z); setTool('move'); return; }
  const handle = screenPoint(getHandle());
  const listener = screenPoint(scene.listener);
  const source = [...scene.sources].reverse().find(s => { const p = screenPoint(s); return Math.hypot(p.x - point.px, p.y - point.py) < 19; });
  if (Math.hypot(handle.x - point.px, handle.y - point.py) < 12) dragging = { type: 'heading' };
  else if (Math.hypot(listener.x - point.px, listener.y - point.py) < 17) dragging = { type: 'listener', dx: scene.listener.x - point.x, dz: scene.listener.z - point.z };
  else if (source) { selectSource(source.id); dragging = { type: 'source', id: source.id, dx: source.x - point.x, dz: source.z - point.z }; }
  else { scene.listener.x = point.x; scene.listener.z = point.z; dragging = { type: 'listener', dx: 0, dz: 0 }; renderListener(); }
  canvas.setPointerCapture(event.pointerId);
  changed();
});
canvas.addEventListener('pointermove', event => {
  const point = mapPoint(event);
  if (!dragging) return;
  if (dragging.type === 'heading') setHeading(Math.atan2(point.x - scene.listener.x, scene.listener.z - point.z) * 180 / Math.PI);
  else {
    const object = dragging.type === 'source' ? scene.sources.find(s => s.id === dragging.id) : scene.listener;
    if (!object) return;
    object.x = clamp(point.x + dragging.dx, 0, 10);
    object.z = clamp(point.z + dragging.dz, 0, 10);
    renderListener(); renderDetail(); changed();
  }
});
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(event, () => dragging = null);

const interactiveField = target => target instanceof HTMLElement && (target.matches('input, select, textarea, button, a') || target.isContentEditable);
window.addEventListener('keydown', event => {
  if (interactiveField(event.target) || helpDialog.open || roomDialog.open || event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'escape') { setTool('move'); return; }
  if (key === ' ') { event.preventDefault(); if (!event.repeat) togglePlay(); return; }
  if (['w','a','s','d','q','e','arrowup','arrowdown','arrowleft','arrowright','shift'].includes(key)) { event.preventDefault(); pressed.add(key); }
});
window.addEventListener('keyup', event => pressed.delete(event.key.toLowerCase()));
window.addEventListener('blur', () => pressed.clear());
document.addEventListener('visibilitychange', () => { if (document.hidden) pressed.clear(); });
window.addEventListener('pagehide', () => { tracker.dispose(); engine.ctx?.close(); });
window.addEventListener('beforeunload', event => { if (scene.sources.some(s => s.audio)) { event.preventDefault(); event.returnValue = ''; } });

function keyboardMove(dt) {
  if (!pressed.size || helpDialog.open || roomDialog.open || interactiveField(document.activeElement)) return;
  let forward = Number(pressed.has('w') || pressed.has('arrowup')) - Number(pressed.has('s') || pressed.has('arrowdown'));
  let sideways = Number(pressed.has('d')) - Number(pressed.has('a'));
  const rotation = Number(pressed.has('e') || pressed.has('arrowright')) - Number(pressed.has('q') || pressed.has('arrowleft'));
  if (!forward && !sideways && !rotation) return;
  scene.listener.yaw = wrapAngle(scene.listener.yaw + rotation * 85 * dt);
  const yaw = orientation().yaw * Math.PI / 180;
  const length = Math.hypot(forward, sideways) || 1;
  forward /= length; sideways /= length;
  const speed = pressed.has('shift') ? 3.6 : 1.4;
  scene.listener.x = clamp(scene.listener.x + (Math.sin(yaw) * forward + Math.cos(yaw) * sideways) * speed * dt, 0, 10);
  scene.listener.z = clamp(scene.listener.z + (-Math.cos(yaw) * forward + Math.sin(yaw) * sideways) * speed * dt, 0, 10);
  renderListener(); changed();
}

function resize() {
  const rect = $('stage-wrap').getBoundingClientRect();
  width = rect.width; height = rect.height;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = width * dpr; canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const size = Math.min(width - 80, height - 106);
  geometry = { x: (width - size) / 2, y: (height - size) / 2 - 2, size, scale: size / 10 };
  drawRoom(performance.now());
}
new ResizeObserver(resize).observe($('stage-wrap'));

function roundedRect(x, y, w, h, r = 4) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function drawRoom(time) {
  ctx.clearRect(0, 0, width, height);
  const { x, y, size, scale } = geometry;
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#34462e';
  ctx.strokeRect(x, y, size, size);
  for (let i = 0; i <= 20; i++) {
    const p = i * scale / 2;
    ctx.strokeStyle = i % 2 ? '#8aab7010' : '#8aab7022';
    ctx.beginPath(); ctx.moveTo(x + p, y); ctx.lineTo(x + p, y + size); ctx.moveTo(x, y + p); ctx.lineTo(x + size, y + p); ctx.stroke();
  }
  // Corner registration marks give the plan a measured, architectural feel.
  ctx.strokeStyle = '#8fae7780';
  [[x,y,1,1],[x+size,y,-1,1],[x,y+size,1,-1],[x+size,y+size,-1,-1]].forEach(([cx,cy,dx,dy]) => {
    ctx.beginPath(); ctx.moveTo(cx,cy+dy*9); ctx.lineTo(cx,cy); ctx.lineTo(cx+dx*9,cy); ctx.stroke();
  });
  ctx.font = '8px ui-monospace, monospace'; ctx.fillStyle = '#708764'; ctx.textAlign = 'center';
  for (let i = 0; i <= 10; i += 2) { ctx.fillText(String(i), x + scale * i, y + size + 19); ctx.fillText(String(i), x - 17, y + scale * i + 3); }
  ctx.fillStyle = '#71866a';ctx.font = '8px ui-monospace, monospace'; ctx.fillText('X / m', x + size + 17, y + size + 19);
  ctx.save();ctx.translate(x-31,y+size/2);ctx.rotate(-Math.PI/2);ctx.fillText('Z / m',0,0);ctx.restore();

  ctx.save(); ctx.beginPath(); ctx.rect(x,y,size,size); ctx.clip();
  const listener = screenPoint(scene.listener);
  const hasSolo = scene.sources.some(s => s.solo);
  scene.sources.forEach((source, i) => {
    const point = screenPoint(source);
    const audible = !source.muted && (!hasSolo || source.solo);
    const active = source.id === selected;
    ctx.globalAlpha = audible ? 1 : .28;
    const glow = ctx.createRadialGradient(point.x, point.y, 1, point.x, point.y, scale * 2.3);
    glow.addColorStop(0, source.color + (active ? '16' : '0b')); glow.addColorStop(1, source.color + '00');
    ctx.fillStyle = glow; ctx.fillRect(point.x-scale*2.3,point.y-scale*2.3,scale*4.6,scale*4.6);
    [1, 1.75, 2.5].forEach((radius, ring) => {
      const phase = engine.playing && !reducedMotion ? (time / 3000) % .6 : 0;
      ctx.strokeStyle = source.color + (active ? ['26','18','0d'][ring] : ['14','0c','07'][ring]);
      ctx.lineWidth = .8; ctx.beginPath(); ctx.arc(point.x, point.y, scale * (radius + phase), 0, Math.PI * 2); ctx.stroke();
    });
    ctx.strokeStyle = source.color + (active ? '50' : '22'); ctx.lineWidth = .7; ctx.setLineDash([3,5]);
    ctx.beginPath();ctx.moveTo(point.x,point.y);ctx.lineTo(listener.x,listener.y);ctx.stroke();ctx.setLineDash([]);
    if (active && Math.hypot(point.x-listener.x,point.y-listener.y) > 75) {
      const mx = point.x * .45 + listener.x * .55, my = point.y * .45 + listener.y * .55;
      const text = `${distance(source,scene.listener).toFixed(2)} m`;
      ctx.font = '9px ui-monospace, monospace';const tw = ctx.measureText(text).width;
      roundedRect(mx-tw/2-7,my-9,tw+14,18,4);ctx.fillStyle='#1c291a';ctx.fill();ctx.strokeStyle=source.color+'35';ctx.stroke();ctx.fillStyle=source.color;ctx.fillText(text,mx,my+3);
    }
    ctx.fillStyle = '#1a251a';ctx.strokeStyle = source.color;ctx.lineWidth = active ? 1.5 : 1;
    ctx.beginPath();ctx.arc(point.x,point.y,12,0,Math.PI*2);ctx.fill();ctx.stroke();
    if (active) { ctx.strokeStyle=source.color+'4a';ctx.lineWidth=1;ctx.beginPath();ctx.arc(point.x,point.y,17,0,Math.PI*2);ctx.stroke(); }
    ctx.fillStyle=source.color;ctx.font='9px ui-monospace, monospace';ctx.fillText(String(i+1).padStart(2,'0'),point.x,point.y+3);
    ctx.font='10px -apple-system, sans-serif';ctx.fillStyle=source.color+'dd';
    const label = source.name.length > 10 ? source.name.slice(0,9)+'…' : source.name;
    const tw=ctx.measureText(label).width;
    const lx=clamp(point.x,x+tw/2+4,x+size-tw/2-4);
    ctx.fillText(label,lx,point.y > y+40 ? point.y-25 : point.y+32);
  });
  ctx.globalAlpha = 1;
  const yaw = orientation().yaw * Math.PI / 180;
  const bearing = yaw - Math.PI / 2;
  const gradient = ctx.createRadialGradient(listener.x,listener.y,0,listener.x,listener.y,scale*1.4);
  gradient.addColorStop(0,'#c3e6b837');gradient.addColorStop(1,'#c3e6b800');ctx.fillStyle=gradient;
  ctx.beginPath();ctx.moveTo(listener.x,listener.y);ctx.arc(listener.x,listener.y,scale*1.4,bearing-.58,bearing+.58);ctx.closePath();ctx.fill();
  const handle = screenPoint(getHandle());
  ctx.strokeStyle='#c3e6b877';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(listener.x,listener.y);ctx.lineTo(handle.x,handle.y);ctx.stroke();
  ctx.fillStyle='#c3e6b8';ctx.beginPath();ctx.arc(handle.x,handle.y,3,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle='#c3e6b844';ctx.beginPath();ctx.arc(listener.x,listener.y,19,0,Math.PI*2);ctx.stroke();
  ctx.fillStyle='#c3e6b8';ctx.beginPath();ctx.arc(listener.x,listener.y,12,0,Math.PI*2);ctx.fill();
  ctx.save();ctx.translate(listener.x,listener.y);ctx.rotate(yaw);ctx.strokeStyle='#23351c';ctx.lineWidth=1.5;
  ctx.beginPath();ctx.arc(0,0,5,Math.PI,0);ctx.stroke();ctx.beginPath();ctx.moveTo(-5,0);ctx.lineTo(-5,4);ctx.moveTo(5,0);ctx.lineTo(5,4);ctx.stroke();ctx.restore();
  const labelY = listener.y < y+size-35 ? listener.y+30 : listener.y-26;
  roundedRect(listener.x-17,labelY-9,34,16,4);ctx.fillStyle='#263d21';ctx.fill();ctx.strokeStyle='#a9d39455';ctx.lineWidth=.7;ctx.stroke();
  ctx.fillStyle='#c3e6b8';ctx.font='8px ui-monospace, monospace';ctx.fillText('YOU',listener.x,labelY+2);
  ctx.restore();
}

function frame(time) {
  const dt = Math.min((time-lastFrame)/1000,.05);lastFrame=time;
  keyboardMove(dt);
  if (dirty) { engine.update(scene,orientation()); dirty=false; }
  if (time-lastDraw > 32) { drawRoom(time);lastDraw=time; }
  if (time-lastReadout > 120) {
    const elapsed=Math.floor(engine.elapsed());
    $('elapsed').textContent=`${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;
    const levels=engine.levels();$('meter-l').style.width=`${levels[0]*100}%`;$('meter-r').style.width=`${levels[1]*100}%`;
    document.querySelectorAll('[data-distance]').forEach(element=> {const source=scene.sources.find(s=>s.id===element.dataset.distance);if(source)element.textContent=`${distance(source,scene.listener).toFixed(2)} m`;});
    lastReadout=time;
  }
  requestAnimationFrame(frame);
}
renderSources(); renderRoom(); renderListener();
document.querySelectorAll('input[type=range]').forEach(paintRange);
requestAnimationFrame(frame);
