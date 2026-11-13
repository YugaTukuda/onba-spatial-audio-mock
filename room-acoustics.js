export const ROOM_PRESETS = {
  whitecube: { label: 'ホワイトキューブ', height: 3, wallAbsorption: .10, floorAbsorption: .05, ceilingAbsorption: .10, autoRt60: true, rt60: 1.7, predelay: 18 },
  concrete: { label: '硬いコンクリート空間', height: 4, wallAbsorption: .03, floorAbsorption: .03, ceilingAbsorption: .03, autoRt60: true, rt60: 4, predelay: 28 },
  treated: { label: '吸音を施した会場', height: 3, wallAbsorption: .45, floorAbsorption: .35, ceilingAbsorption: .65, autoRt60: true, rt60: .4, predelay: 8 }
};
const { label, ...whitecube } = ROOM_PRESETS.whitecube;
export const DEFAULT_ROOM = Object.freeze({ ...whitecube, preset: 'whitecube' });
const limit = (value, low, high) => Math.min(high, Math.max(low, value));

export function normalizeRoom(input) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) throw new Error('会場の設定が正しくありません');
  const room = { ...DEFAULT_ROOM, ...input };
  const ranges = { height: [2,8], wallAbsorption: [0,.95], floorAbsorption: [0,.95], ceilingAbsorption: [0,.95], rt60: [.15,6], predelay: [0,100] };
  for (const [key, [low, high]] of Object.entries(ranges)) {
    if (typeof room[key] !== 'number' || !Number.isFinite(room[key]) || room[key] < low || room[key] > high) throw new Error('会場の数値が範囲外です');
  }
  if (typeof room.autoRt60 !== 'boolean') throw new Error('残響時間の設定が正しくありません');
  if (room.preset !== 'custom' && !Object.hasOwn(ROOM_PRESETS, room.preset)) throw new Error('会場プリセットが正しくありません');
  return Object.fromEntries(['preset',...Object.keys(ranges),'autoRt60'].map(key => [key,room[key]]));
}

export function roomMetrics(room = DEFAULT_ROOM) {
  const volume = 100 * room.height;
  const wallArea = 40 * room.height;
  const surfaceArea = wallArea + 200;
  const absorptionArea = wallArea * room.wallAbsorption + 100 * room.floorAbsorption + 100 * room.ceilingAbsorption;
  const meanAbsorption = limit(absorptionArea / surfaceArea, .0001, .9999);
  // Eyring's diffuse-field estimate, omitting air absorption. These broad-band
  // coefficients are editable assumptions, not measured material properties.
  const estimatedRt60 = .161 * volume / (-surfaceArea * Math.log(1 - meanAbsorption));
  return { volume, surfaceArea, meanAbsorption, estimatedRt60,
    rt60: room.autoRt60 ? limit(estimatedRt60, .15, 6) : room.rt60 };
}

export function reflectedSources(source, room = DEFAULT_ROOM) {
  const wall = Math.sqrt(1 - room.wallAbsorption);
  return [
    { ...source, x: -source.x, reflection: wall, surface: 'west' },
    { ...source, x: 20 - source.x, reflection: wall, surface: 'east' },
    { ...source, z: -source.z, reflection: wall, surface: 'north' },
    { ...source, z: 20 - source.z, reflection: wall, surface: 'south' },
    { ...source, height: -source.height, reflection: Math.sqrt(1-room.floorAbsorption), surface: 'floor' },
    { ...source, height: 2 * room.height - source.height, reflection: Math.sqrt(1-room.ceilingAbsorption), surface: 'ceiling' }
  ];
}

export function impulseChannels(sampleRate, rt60) {
  const duration = Math.max(.18, rt60 * 1.15);
  const length = Math.ceil(sampleRate * duration);
  let seed = 99;
  const random = () => { seed = (Math.imul(1664525,seed)+1013904223)|0; return (seed>>>0)/4294967296; };
  return [0,1].map(() => {
    const data = new Float32Array(length);
    for (let i=0;i<length;i++) {
      const t=i/sampleRate;
      // Amplitude reaches -60 dB at RT60; the last 15% avoids a hard cutoff.
      data[i]=(random()*2-1)*Math.exp(-Math.LN10*3*t/rt60)*Math.min(1,t/.006);
    }
    return data;
  });
}
