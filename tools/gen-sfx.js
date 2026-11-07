// 効果音（public/sfx/*.wav）を生成するスクリプト。
// 使い方: node tools/gen-sfx.js
'use strict';
const fs = require('fs');
const path = require('path');

const RATE = 22050;
const OUT = path.join(__dirname, '..', 'public', 'sfx');

// 再生成しても同じ音になるよう、乱数は固定シードの線形合同法を使う
let seed = 12345;
function rand() { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 * 2 - 1; }

function buffer(sec) { return new Float32Array(Math.ceil(RATE * sec)); }
function wave(type, ph) {
  const f = ph - Math.floor(ph);
  if (type === 'square') return f < 0.5 ? 1 : -1;
  if (type === 'triangle') return 1 - 4 * Math.abs(f - 0.5);
  return Math.sin(ph * 2 * Math.PI);
}
// 周波数を f0→f1 に指数スイープしながら、指数減衰エンベロープで鳴らす
function tone(buf, { at = 0, dur, f0, f1 = f0, type = 'sine', vol = 0.5, attack = 0.004, decay = 6 }) {
  const s0 = Math.floor(at * RATE), n = Math.floor(dur * RATE);
  let ph = 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / RATE, k = i / n;
    const f = f0 * Math.pow(f1 / f0, k);
    ph += f / RATE;
    const env = Math.min(1, t / attack) * Math.exp(-decay * k) * (1 - Math.pow(k, 8));
    buf[s0 + i] += wave(type, ph) * env * vol;
  }
}
// ローパスをかけたホワイトノイズ（cutoff は 0〜1 の係数、関数で時間変化も可）
function noise(buf, { at = 0, dur, vol = 0.5, cutoff = 0.5, env }) {
  const s0 = Math.floor(at * RATE), n = Math.floor(dur * RATE);
  let y = 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const k = i / n;
    const a = typeof cutoff === 'function' ? cutoff(k) : cutoff;
    y += a * (rand() - y);
    buf[s0 + i] += y * env(k) * vol;
  }
}

function writeWav(name, buf) {
  const data = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.max(-1, Math.min(1, buf[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(OUT, name + '.wav'), Buffer.concat([h, data]));
}

const SOUNDS = {
  // カードを選択
  select() {
    const b = buffer(0.07);
    tone(b, { dur: 0.06, f0: 880, f1: 1320, type: 'square', vol: 0.18, decay: 4 });
    return b;
  },
  // カードの選択を解除
  deselect() {
    const b = buffer(0.07);
    tone(b, { dur: 0.06, f0: 660, f1: 440, type: 'square', vol: 0.16, decay: 4 });
    return b;
  },
  // カードを場に出す（バサッ）
  play() {
    const b = buffer(0.16);
    noise(b, { dur: 0.13, vol: 0.9, cutoff: k => 0.7 - 0.5 * k, env: k => Math.exp(-9 * k) });
    tone(b, { dur: 0.08, f0: 160, f1: 70, vol: 0.5, decay: 5 });
    return b;
  },
  // パス
  pass() {
    const b = buffer(0.22);
    tone(b, { dur: 0.09, f0: 523, type: 'triangle', vol: 0.35, decay: 3 });
    tone(b, { at: 0.1, dur: 0.11, f0: 392, type: 'triangle', vol: 0.35, decay: 4 });
    return b;
  },
  // 場が流れる（シュワッ）
  flow() {
    const b = buffer(0.5);
    noise(b, { dur: 0.48, vol: 0.7, cutoff: k => 0.05 + 0.5 * Math.sin(Math.PI * k), env: k => Math.sin(Math.PI * Math.pow(k, 0.6)) });
    return b;
  },
  // 自分の番が来た
  turn() {
    const b = buffer(0.32);
    tone(b, { dur: 0.09, f0: 784, type: 'square', vol: 0.16, decay: 2 });
    tone(b, { at: 0.09, dur: 0.22, f0: 1175, type: 'square', vol: 0.16, decay: 5 });
    return b;
  }
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, fn] of Object.entries(SOUNDS)) {
  writeWav(name, fn());
  console.log('wrote public/sfx/' + name + '.wav');
}
