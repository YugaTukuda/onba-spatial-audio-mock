import { CLIPS, clamp, distance, fromBase64 } from './scene.js';

const SPEED_OF_SOUND = 343;
const TAU = Math.PI * 2;
const gainTarget = (param, value, time, speed = .025) => {
  param.cancelScheduledValues(time);
  param.setTargetAtTime(value, time, speed);
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = null;
    this.buffers = new Map();
    this.voices = new Map();
    this.demos = new Map();
    this.clipLoads = new Map();
    this.playing = false;
    this.startedAt = null;
    this.transportBusy = false;
  }

  async init() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('このブラウザはWeb Audioに対応していません');
      this.ctx = new Context({ latencyHint: 'interactive' });
      await this.ctx.suspend();
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = .65;
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -8;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 12;
      this.limiter.attack.value = .003;
      this.limiter.release.value = .2;
      this.master.connect(this.limiter);
      this.limiter.connect(ctx.destination);

      // A diffuse late tail complements the four image-source reflections.
      this.convolver = ctx.createConvolver();
      const length = Math.floor(ctx.sampleRate * 1.8);
      const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
      const rand = seededRandom(99);
      for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
          const t = i / ctx.sampleRate;
          data[i] = t < .055 ? 0 : (rand() * 2 - 1) * Math.exp(-t * 4.5);
        }
      }
      this.convolver.buffer = impulse;
      this.wet = ctx.createGain();
      this.wet.gain.value = .05;
      this.convolver.connect(this.wet).connect(this.master);

      const splitter = ctx.createChannelSplitter(2);
      this.limiter.connect(splitter);
      this.meters = [0, 1].map(channel => {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        splitter.connect(analyser, channel);
        return { analyser, data: new Float32Array(analyser.fftSize) };
      });
    })();
    try { await this.ready; } catch (error) { this.ready = null; throw error; }
  }

  async decode(arrayBuffer) {
    await this.init();
    const original = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    // Uploaded recordings represent a point source; preserve no stereo width.
    if (original.duration > 300) throw new Error('音声は5分以内にしてください');
    if (original.numberOfChannels === 1) return original;
    const mono = this.ctx.createBuffer(1, original.length, original.sampleRate);
    const data = mono.getChannelData(0);
    for (let channel = 0; channel < original.numberOfChannels; channel++) {
      const source = original.getChannelData(channel);
      for (let i = 0; i < data.length; i++) data[i] += source[i] / original.numberOfChannels;
    }
    return mono;
  }

  async prepareSource(source) {
    await this.init();
    if (this.buffers.has(source.id)) return;
    this.buffers.set(source.id, await this.resolveBuffer(source));
  }

  async resolveBuffer(source) {
    await this.init();
    if (source.audio) return this.decode(fromBase64(source.audio));
    const clip = CLIPS[source.kind];
    if (!clip) return this.demo(source.kind);
    if (!this.clipLoads.has(source.kind)) {
      const loading = (async () => {
        const response = await fetch(new URL(clip.url, import.meta.url));
        if (!response.ok) throw new Error(`音声を取得できませんでした (${response.status})`);
        return this.decode(await response.arrayBuffer());
      })();
      this.clipLoads.set(source.kind, loading);
      loading.catch(() => this.clipLoads.delete(source.kind));
    }
    return this.clipLoads.get(source.kind);
  }

  demo(kind) {
    if (this.demos.has(kind)) return this.demos.get(kind);
    const rate = this.ctx.sampleRate;
    const duration = 12;
    const buffer = this.ctx.createBuffer(1, rate * duration, rate);
    const data = buffer.getChannelData(0);
    const random = seededRandom(kind === 'wind' ? 7 : kind === 'water' ? 21 : 42);
    if (kind === 'wind') {
      let brown = 0;
      let low = 0;
      for (let i = 0; i < data.length; i++) {
        const t = i / rate;
        brown = (brown + .035 * (random() * 2 - 1)) / 1.014;
        low += .045 * (brown - low);
        data[i] = (low * 1.8 + (random() * 2 - 1) * .012) * (.55 + .22 * Math.sin(t * TAU / 6));
      }
    } else if (kind === 'water') {
      for (let start = .1; start < duration - .7; start += .22 + random() * .48) {
        const freq = 500 + random() * 1800;
        const decay = .12 + random() * .15;
        for (let j = 0; j < rate * .6; j++) {
          const i = Math.floor(start * rate) + j;
          if (i >= data.length) break;
          const t = j / rate;
          data[i] += Math.sin(TAU * (freq * t - freq * .3 * t * t)) * Math.exp(-t / decay * 3) * Math.min(t * 300, 1) * .35;
        }
      }
    } else {
      const notes = [523.25, 659.25, 783.99, 987.77, 783.99, 659.25];
      notes.forEach((freq, n) => {
        const start = n * 1.8 + .1;
        for (let j = 0; j < rate * 2.6; j++) {
          const i = Math.floor(start * rate) + j;
          if (i >= data.length) break;
          const t = j / rate;
          const tone = Math.sin(TAU * freq * t) + .22 * Math.sin(TAU * freq * 2.003 * t) + .08 * Math.sin(TAU * freq * 3.98 * t);
          data[i] += tone * Math.exp(-t * 2.7) * Math.min(t * 120, 1) * .24;
        }
      });
    }
    const fade = Math.floor(rate * .08);
    for (let i = 0; i < fade; i++) { data[i] *= i / fade; data[data.length - 1 - i] *= i / fade; }
    this.demos.set(kind, buffer);
    return buffer;
  }

  panner(position) {
    const node = this.ctx.createPanner();
    node.panningModel = 'HRTF';
    node.distanceModel = 'inverse';
    node.refDistance = 1;
    node.maxDistance = 100;
    node.rolloffFactor = 1;
    node.coneInnerAngle = 360;
    node.positionX.value = position.x;
    node.positionY.value = position.height;
    node.positionZ.value = position.z;
    return node;
  }

  attach(source, scene) {
    if (this.voices.has(source.id)) return;
    const ctx = this.ctx;
    const buffer = this.buffers.get(source.id);
    if (!buffer) throw new Error('音声の読み込みが完了していません');
    const input = ctx.createBufferSource();
    input.buffer = buffer;
    input.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    input.connect(gain);
    const delay = ctx.createDelay(.25);
    const panner = this.panner(source);
    gain.connect(delay).connect(panner).connect(this.master);
    panner.connect(this.convolver);
    const reflections = [0, 1, 2, 3].map(() => {
      const delay = ctx.createDelay(.25);
      const panner = this.panner(source);
      const gain = ctx.createGain();
      gain.gain.value = 0;
      return { delay, panner, gain };
    });
    reflections.forEach(reflection => {
      gain.connect(reflection.delay).connect(reflection.panner).connect(reflection.gain).connect(this.master);
    });
    const offset = this.startedAt === null ? 0 : (ctx.currentTime - this.startedAt) % buffer.duration;
    input.start(ctx.currentTime, Math.max(0, offset));
    this.voices.set(source.id, { input, gain, delay, panner, reflections });
    this.updateSource(source, scene);
  }

  updateSource(source, scene) {
    const voice = this.voices.get(source.id);
    if (!voice) return;
    const t = this.ctx.currentTime;
    const solo = scene.sources.some(s => s.solo);
    const audible = !source.muted && (!solo || source.solo);
    // Keep headroom when several files sum at a nearby listener.
    gainTarget(voice.gain.gain, audible ? source.volume / 100 * .55 : 0, t);
    setPosition(voice.panner, source, t);
    gainTarget(voice.delay.delayTime, distance(source, scene.listener) / SPEED_OF_SOUND, t, .05);
    const images = [
      { ...source, x: -source.x }, { ...source, x: 20 - source.x },
      { ...source, z: -source.z }, { ...source, z: 20 - source.z }
    ];
    voice.reflections.forEach((reflection, i) => {
      setPosition(reflection.panner, images[i], t);
      gainTarget(reflection.delay.delayTime, distance(images[i], scene.listener) / SPEED_OF_SOUND, t, .05);
      gainTarget(reflection.gain.gain, scene.reverb / 100 * .42, t);
    });
  }

  update(scene, orientation = scene.listener) {
    if (!this.ctx || !this.master) return;
    const listener = this.ctx.listener;
    const t = this.ctx.currentTime;
    setPosition(listener, scene.listener, t);
    const yaw = orientation.yaw * Math.PI / 180;
    const pitch = (orientation.pitch || 0) * Math.PI / 180;
    const forward = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const up = [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)];
    if (listener.forwardX) {
      ['X', 'Y', 'Z'].forEach((axis, i) => { gainTarget(listener[`forward${axis}`], forward[i], t); gainTarget(listener[`up${axis}`], up[i], t); });
    } else listener.setOrientation(...forward, ...up);
    gainTarget(this.master.gain, scene.master / 100, t);
    gainTarget(this.wet.gain, scene.reverb / 100 * .28, t);
    scene.sources.forEach(source => this.updateSource(source, scene));
  }

  async play(scene, orientation) {
    if (this.transportBusy) return;
    this.transportBusy = true;
    try {
      await this.init();
      await Promise.all(scene.sources.map(s => this.prepareSource(s)));
      if (this.startedAt === null) this.startedAt = this.ctx.currentTime;
      scene.sources.forEach(source => this.attach(source, scene));
      this.update(scene, orientation);
      await this.ctx.resume();
      this.playing = true;
    } finally { this.transportBusy = false; }
  }

  async pause() { if (this.ctx) await this.ctx.suspend(); this.playing = false; }
  async stop() {
    await this.pause();
    [...this.voices.keys()].forEach(id => this.detach(id));
    // Flush both delay lines and the late tail on stop by replacing its buffer.
    if (this.convolver) { const impulse = this.convolver.buffer; this.convolver.buffer = null; this.convolver.buffer = impulse; }
    this.startedAt = null;
  }
  detach(id) {
    const voice = this.voices.get(id);
    if (!voice) return;
    try { voice.input.stop(); } catch { /* already stopped */ }
    [voice.input, voice.gain, voice.delay, voice.panner, ...voice.reflections.flatMap(r => [r.delay, r.panner, r.gain])].forEach(node => node.disconnect());
    this.voices.delete(id);
  }
  replace(source, scene, buffer) {
    this.detach(source.id);
    this.buffers.set(source.id, buffer);
    if (this.startedAt !== null) this.attach(source, scene);
  }
  remove(id) { this.detach(id); this.buffers.delete(id); }
  elapsed() { return this.startedAt === null || !this.ctx ? 0 : Math.max(0, this.ctx.currentTime - this.startedAt); }
  levels() {
    if (!this.playing || !this.meters) return [0, 0];
    return this.meters.map(({ analyser, data }) => {
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((total, value) => total + value * value, 0) / data.length);
      return clamp((20 * Math.log10(Math.max(rms, 1e-5)) + 60) / 60, 0, 1);
    });
  }
}

function setPosition(node, position, t) {
  if (node.positionX) {
    gainTarget(node.positionX, position.x, t);
    gainTarget(node.positionY, position.height, t);
    gainTarget(node.positionZ, position.z, t);
  } else node.setPosition(position.x, position.height, position.z);
}
function seededRandom(seed) {
  return () => { seed = (Math.imul(1664525, seed) + 1013904223) | 0; return (seed >>> 0) / 4294967296; };
}
