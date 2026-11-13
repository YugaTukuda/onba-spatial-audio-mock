import { DEFAULT_ROOM, normalizeRoom } from './room-acoustics.js';
export const COLORS = ['#eab179', '#9babe8', '#d5a4d5', '#8ed0b7', '#e0cc7c', '#83bdd5'];
export const CLIPS = {
  'beetle-01': { label: 'コガネムシ · 00:00–00:30', url: './audio/koganemushi-01-000-030.wav', fileName: 'コガネムシ_00m00s–00m30s.wav' },
  'beetle-02': { label: 'コガネムシ · 00:30–01:00', url: './audio/koganemushi-02-030-060.wav', fileName: 'コガネムシ_00m30s–01m00s.wav' },
  'beetle-03': { label: 'コガネムシ · 01:00–01:30', url: './audio/koganemushi-03-060-090.wav', fileName: 'コガネムシ_01m00s–01m30s.wav' }
};
export const DEMOS = { ...Object.fromEntries(Object.entries(CLIPS).map(([key, clip]) => [key, clip.label])), wind: '風のテクスチャ', water: '水のしずく', chime: '柔らかなチャイム' };
export const MAX_SOURCES = 16;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const wrapAngle = angle => ((angle % 360) + 360) % 360;
export const angleDelta = (a, b) => ((a - b + 540) % 360) - 180;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z, a.height - b.height);
export function makeSource(index, x = 5, z = 5) {
  const kinds = Object.keys(CLIPS);
  return { id: crypto.randomUUID(), name: `音源 ${String(index + 1).padStart(2, '0')}`,
    x, z, height: 1.6, volume: 70, muted: false, solo: false,
    color: COLORS[index % COLORS.length], kind: kinds[index % kinds.length], fileName: null, audio: null };
}
export function initialScene() {
  return { version: 1, listener: { x: 5, z: 6, height: 1.6, yaw: 0, pitch: 0 },
    master: 65, reverb: 20, room: { ...DEFAULT_ROOM }, sources: [makeSource(0, 2.5, 2.5), makeSource(1, 7.5, 3.5), makeSource(2, 3.5, 7.5)] };
}
function number(value, min, max, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name}が正しくありません`);
  return value;
}
export function validateScene(input) {
  if (!input || input.version !== 1 || !Array.isArray(input.sources) || input.sources.length > MAX_SOURCES) throw new Error('ONBAのシーンファイルではありません');
  const point = (p, name) => ({ x: number(p?.x, 0, 10, name), z: number(p?.z, 0, 10, name), height: number(p?.height, 0, 5, name) });
  const listener = { ...point(input.listener, '鑑賞者の位置'), yaw: number(input.listener.yaw, 0, 360, '向き'), pitch: 0 };
  let total = 0;
  const sources = input.sources.map((s, i) => {
    if (!Object.hasOwn(DEMOS, s.kind)) throw new Error('音の種類が正しくありません');
    if (s.audio != null && (typeof s.audio !== 'string' || s.audio.length > MAX_FILE_BYTES * 1.34 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s.audio))) throw new Error('音声データが正しくありません');
    total += s.audio?.length || 0;
    if (total > 140 * 1024 * 1024) throw new Error('音声データの合計が大きすぎます');
    return { ...makeSource(i), ...point(s, '音源の位置'), name: String(s.name || `音源 ${i + 1}`).slice(0, 60),
      volume: number(s.volume, 0, 100, '音量'), muted: !!s.muted, solo: !!s.solo,
      kind: s.kind, fileName: s.audio ? String(s.fileName || '読み込んだ音声').slice(0, 180) : null,
      audio: s.audio || null };
  });
  const room = normalizeRoom(input.room);
  const highest = Math.max(listener.height,...sources.map(source=>source.height));
  // Older scenes had no ceiling. Preserve their source positions when loading.
  if (!input.room && highest > room.height) { room.height = highest + .2; room.preset = 'custom'; }
  if (highest > room.height) throw new Error('音源または耳の高さが天井を超えています');
  return { version: 1, listener, master: number(input.master, 0, 100, '出力音量'), reverb: number(input.reverb, 0, 100, '残響'), room, sources };
}
export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function fromBase64(value) {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0)).buffer;
}
// MediaPipe MatrixData stores elements in column-major order. The face's local
// +Z axis points toward the viewer; its X/Y components give yaw and pitch.
export function poseFromMatrix(matrix) {
  if (!matrix || matrix.length !== 16 || !Array.from(matrix).every(Number.isFinite)) return null;
  return { yaw: -Math.atan2(matrix[8], matrix[10]) * 180 / Math.PI,
    pitch: Math.atan2(matrix[9], Math.hypot(matrix[8], matrix[10])) * 180 / Math.PI };
}
