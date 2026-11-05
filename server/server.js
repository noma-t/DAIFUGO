/*
 * 大富豪 セルフホストサーバー
 * 依存パッケージなし（Node.js 標準モジュールのみ）
 *   node server/server.js [--open] [--port 3000]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const E = require('../shared/engine');
const AI = require('./ai');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const args = process.argv.slice(2);
const argPort = args.indexOf('--port') >= 0 ? parseInt(args[args.indexOf('--port') + 1], 10) : NaN;
const BASE_PORT = argPort || parseInt(process.env.PORT, 10) || 3000;
const OPEN = args.indexOf('--open') >= 0;
let PORT = BASE_PORT;

const rooms = new Map();

// ---------------------------------------------------------------- ユーティリティ
function rid(n) { return crypto.randomBytes(n).toString('hex'); }
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)];
    if (!rooms.has(c)) return c;
  }
}
function cleanName(s) {
  s = String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12);
  return s || 'プレイヤー';
}
function lanUrls() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) {
    for (const a of ifs[k] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push('http://' + a.address + ':' + PORT + '/');
    }
  }
  return out;
}

// ---------------------------------------------------------------- ルーム
// 前回の対戦設定（クライアントの Cookie 由来）から席構成を復元する
function presetSeats(list, hostId) {
  const def = [{ kind: 'human', pid: hostId }, { kind: 'ai', level: 3 }, { kind: 'ai', level: 3 }, { kind: 'ai', level: 3 }];
  if (!Array.isArray(list) || list.length < 3 || list.length > 8) return def;
  if (list.filter(x => x && x.kind === 'me').length !== 1) return def;
  return list.map(x => {
    if (x && x.kind === 'me') return { kind: 'human', pid: hostId };
    if (x && x.kind === 'open') return { kind: 'open' };
    const lv = parseInt(x && x.level, 10);
    return { kind: 'ai', level: lv >= 1 && lv <= 5 ? lv : 3 };
  });
}

function createRoom(hostName, preset) {
  preset = preset && typeof preset === 'object' ? preset : {};
  const code = newCode();
  const host = { id: rid(6), token: rid(16), name: cleanName(hostName), connected: false, streams: new Set(), dcTimer: null, leftTimer: null };
  const room = {
    code,
    hostId: host.id,
    members: new Map([[host.id, host]]),
    seats: presetSeats(preset.seats, host.id),
    settings: preset.settings ? E.sanitizeSettings(preset.settings) : E.defaultSettings(),
    screen: 'lobby',
    game: null,
    seatMap: null,
    prevPlaces: null,
    gameNo: 0,
    timers: new Map(),
    deadlines: {},
    result: null,
    lastActive: Date.now(),
    endTimer: null
  };
  rooms.set(code, room);
  return { room, member: host };
}

function memberByToken(room, token) {
  for (const m of room.members.values()) if (m.token === token) return m;
  return null;
}

function seatName(room, s, idx, used) {
  if (s.kind === 'human') return room.members.get(s.pid).name;
  let base = 'CPU Lv' + s.level;
  let name = base, k = 1;
  while (used.has(name)) { k++; name = base + ' ' + String.fromCharCode(64 + k); }
  return name;
}

function ensureHost(room) {
  const h = room.members.get(room.hostId);
  if (h && h.connected) return;
  for (const m of room.members.values()) {
    if (m.connected) { room.hostId = m.id; return; }
  }
}

function removeMember(room, m) {
  room.members.delete(m.id);
  room.seats.forEach((s, i) => {
    if (s.kind === 'human' && s.pid === m.id) room.seats[i] = { kind: 'ai', level: 3 };
  });
  if (room.hostId === m.id) {
    const next = room.members.values().next().value;
    room.hostId = next ? next.id : null;
  }
  if (!room.members.size) destroyRoom(room);
}

function destroyRoom(room) {
  for (const t of room.timers.values()) if (t) clearTimeout(t);
  room.timers.clear();
  if (room.endTimer) clearTimeout(room.endTimer);
  rooms.delete(room.code);
}

// ---------------------------------------------------------------- 表示用データ
function controllerOf(room, seat) {
  const s = room.seatMap[seat];
  if (s.kind === 'ai') return { ai: true, level: s.level };
  const m = room.members.get(s.pid);
  if (!m || !m.connected) return { ai: true, level: 3, proxy: true };
  return { ai: false, member: m };
}

function filterEvents(evs, mySeat) {
  return evs.map(e => {
    if ((e.t === 'give' || e.t === 'exchange') && e.from !== mySeat && e.to !== mySeat) {
      return Object.assign({}, e, { cards: null, count: e.cards.length });
    }
    return e;
  });
}

function viewFor(room, m, evs) {
  const v = {
    now: Date.now(),
    code: room.code,
    lan: lanUrls(),
    screen: room.screen,
    me: { id: m.id, name: m.name, isHost: room.hostId === m.id },
    lobby: {
      seats: room.seats.map(s => {
        if (s.kind === 'human') {
          const mm = room.members.get(s.pid);
          return { kind: 'human', name: mm ? mm.name : '?', connected: !!(mm && mm.connected), isHost: s.pid === room.hostId, isMe: s.pid === m.id };
        }
        return { kind: s.kind, level: s.level };
      }),
      settings: room.settings,
      gameNo: room.gameNo
    }
  };
  const g = room.game;
  if (g && room.screen !== 'lobby') {
    const mySeat = room.seatMap.findIndex(s => s.kind === 'human' && s.pid === m.id);
    const deadlines = {};
    for (const k of Object.keys(room.deadlines)) {
      const d = room.deadlines[k];
      deadlines[d.seat] = { at: d.at, total: d.total };
    }
    v.game = {
      n: g.n,
      gameNo: g.gameNo,
      mySeat,
      phase: g.phase,
      players: g.players.map((p, i) => {
        const s = room.seatMap[i];
        const mm = s.kind === 'human' ? room.members.get(s.pid) : null;
        return {
          name: p.name,
          kind: s.kind,
          level: s.level || 0,
          proxy: s.kind === 'human' && !(mm && mm.connected),
          count: p.hand.length,
          out: p.out,
          place: p.place,
          passed: p.passed,
          ochi: p.ochi,
          foul: p.foul,
          title: g.prevPlaces ? E.titleOf(g.prevPlaces[i], g.n) : ''
        };
      }),
      hand: mySeat >= 0 ? g.players[mySeat].hand : [],
      field: g.field,
      pileCount: g.pile.length,
      pileTop: g.pile.slice(-3),
      revolution: g.revolution,
      back: g.back,
      bind: g.bind,
      turn: g.phase === 'play' ? g.turn : -1,
      lastPlayer: g.lastPlayer,
      ctx: E.ctxOf(g),
      pending: g.phase === 'choice' ? g.pending : null,
      exPending: g.phase === 'exchange' ? g.exPending : null,
      deadlines,
      timer: room.settings.timer,
      events: filterEvents(evs || [], mySeat)
    };
  }
  if (room.screen === 'result') {
    v.result = room.result;
    v.resultSeat = room.seatMap ? room.seatMap.findIndex(s => s.kind === 'human' && s.pid === m.id) : -1;
  }
  return v;
}

function send(m, data) {
  const s = 'data: ' + JSON.stringify(data) + '\n\n';
  for (const res of m.streams) {
    try { res.write(s); } catch (e) { /* ignore */ }
  }
}

function broadcast(room, evs) {
  room.lastActive = Date.now();
  for (const m of room.members.values()) {
    if (m.streams.size) send(m, viewFor(room, m, evs));
  }
}

// ---------------------------------------------------------------- ゲーム進行
function startGame(room, again) {
  const used = new Set();
  room.seatMap = room.seats.map((s, i) => {
    const name = seatName(room, s, i, used);
    used.add(name);
    return Object.assign({}, s, { name });
  });
  if (!again) { room.prevPlaces = null; room.gameNo = 0; }
  room.gameNo++;
  room.game = E.newGame({
    names: room.seatMap.map(s => s.name),
    rules: room.settings.rules,
    prevPlaces: room.prevPlaces,
    gameNo: room.gameNo
  });
  room.screen = 'game';
  room.result = null;
  clearAllTimers(room);
  afterChange(room);
}

function clearAllTimers(room) {
  for (const t of room.timers.values()) if (t) clearTimeout(t);
  room.timers.clear();
  room.deadlines = {};
  if (room.endTimer) { clearTimeout(room.endTimer); room.endTimer = null; }
}

function calcDelay(evs) {
  let d = 0;
  for (const e of evs) {
    if (e.t === 'play') d += 550;
    else if (e.t === 'effect') d += 650;
    else if (e.t === 'flow') d += 450;
    else if (e.t === 'bomber') d += 2400;
    else if (e.t === 'give' || e.t === 'discard') d += 500;
    else if (e.t === 'exchange') d += 400;
    else if (e.t === 'pass') d += 250;
    else if (e.t === 'finish') d += 600;
  }
  return Math.min(d, 3200);
}

function afterChange(room) {
  const g = room.game;
  const evs = g.events;
  g.events = [];
  if (g.phase === 'end') {
    clearAllTimers(room);
    broadcast(room, evs);
    room.endTimer = setTimeout(() => {
      room.endTimer = null;
      if (room.game !== g) return;
      const places = E.places(g);
      room.prevPlaces = places;
      room.result = {
        gameNo: g.gameNo,
        rows: g.players.map((p, i) => ({
          seat: i,
          name: p.name,
          place: places[i],
          title: E.titleOf(places[i], g.n),
          ochi: p.ochi,
          foul: p.foul,
          kind: room.seatMap[i].kind
        })).sort((a, b) => a.place - b.place)
      };
      room.screen = 'result';
      broadcast(room, []);
    }, calcDelay(evs) + 1400);
    return;
  }
  schedule(room, calcDelay(evs));
  broadcast(room, evs);
}

// 人間が全員上がって残りがAIだけか
function onlyAILeft(room, g) {
  return g.players.every((p, i) => p.out || room.seatMap[i].kind === 'ai');
}

function schedule(room, animDelay) {
  const g = room.game;
  if (!g || g.phase === 'end') return;
  const fast = onlyAILeft(room, g);
  if (fast) animDelay *= 0.35;
  const aw = E.awaiting(g);
  const keys = new Set();
  for (const a of aw) {
    const key = a.kind === 'exchange' ? 'ex:' + a.seat : a.kind + ':' + a.seat + ':' + g.seq;
    keys.add(key);
    if (room.timers.has(key)) continue;
    const ctrl = controllerOf(room, a.seat);
    if (ctrl.ai) {
      const think = fast ? 60 + Math.random() * 80
        : a.kind === 'turn' ? 380 + Math.random() * 420 : 450 + Math.random() * 300;
      room.timers.set(key, setTimeout(() => runAI(room, a.seat, key, ctrl.level), animDelay + think));
    } else if (room.settings.timer.enabled) {
      const total = room.settings.timer.seconds * 1000;
      const at = Date.now() + animDelay + total;
      room.deadlines[key] = { seat: a.seat, at, total };
      room.timers.set(key, setTimeout(() => onTimeout(room, a.seat, key), animDelay + total));
    } else {
      room.timers.set(key, null);
    }
  }
  for (const k of Array.from(room.timers.keys())) {
    if (!keys.has(k)) {
      const t = room.timers.get(k);
      if (t) clearTimeout(t);
      room.timers.delete(k);
      delete room.deadlines[k];
    }
  }
}

function rescheduleSeat(room, seat) {
  if (!room.game || room.screen !== 'game') return;
  for (const k of Array.from(room.timers.keys())) {
    const parts = k.split(':');
    if (+parts[1] === seat) {
      const t = room.timers.get(k);
      if (t) clearTimeout(t);
      room.timers.delete(k);
      delete room.deadlines[k];
    }
  }
  schedule(room, 300);
  broadcast(room, []);
}

function keyValid(room, key) {
  return room.timers.has(key);
}

function applyAction(room, seat, action) {
  const g = room.game;
  let r = action ? E.act(g, seat, action) : { ok: false };
  if (!r.ok) {
    const fb = AI.fallback(g, seat);
    r = fb ? E.act(g, seat, fb) : r;
  }
  return r;
}

function runAI(room, seat, key, level) {
  if (!keyValid(room, key) || !room.game) return;
  room.timers.delete(key);
  let action = null;
  try { action = AI.decide(room.game, seat, level); } catch (e) { console.error(e); }
  applyAction(room, seat, action);
  afterChange(room);
}

function onTimeout(room, seat, key) {
  if (!keyValid(room, key) || !room.game) return;
  room.timers.delete(key);
  delete room.deadlines[key];
  const g = room.game;
  const aw = E.awaiting(g).find(a => a.seat === seat);
  if (!aw) return;
  let action = null;
  if (room.settings.timer.onTimeout === 'ai') {
    action = AI.decide(g, seat, 3);
  } else if (aw.kind === 'turn') {
    action = g.fieldCombo ? { type: 'pass' } : AI.decide(g, seat, 2);
  } else if (aw.kind === 'bomber') {
    action = g.rules.bomberMustFull ? AI.decide(g, seat, 2) : { type: 'declare', ranks: [] };
  } else if (aw.kind === 'exchange') {
    action = AI.decideChoice(g, seat, 'exchange', 2);
  } else {
    action = { type: 'choose', cards: [] };
  }
  applyAction(room, seat, action);
  afterChange(room);
}

// ---------------------------------------------------------------- API
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', ch => {
      data += ch;
      if (data.length > 64 * 1024) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function joinRoom(room, name) {
  if (room.screen !== 'lobby') return { error: 'ゲーム中のため参加できません。ルームトップに戻るまでお待ちください。' };
  let idx = room.seats.findIndex(s => s.kind === 'open');
  if (idx < 0) idx = room.seats.findIndex(s => s.kind === 'ai');
  if (idx < 0) return { error: '満席です' };
  let nm = cleanName(name);
  const names = new Set(Array.from(room.members.values()).map(m => m.name));
  let k = 2;
  const base = nm;
  while (names.has(nm)) nm = base + k++;
  const m = { id: rid(6), token: rid(16), name: nm, connected: false, streams: new Set(), dcTimer: null, leftTimer: null };
  room.members.set(m.id, m);
  room.seats[idx] = { kind: 'human', pid: m.id };
  return { member: m };
}

function handleLobbyAction(room, m, a) {
  const isHost = room.hostId === m.id;
  if (a.type === 'leave') {
    removeMember(room, m);
    for (const res of m.streams) { try { res.end(); } catch (e) { /* */ } }
    if (rooms.has(room.code)) broadcast(room, []);
    return { ok: true };
  }
  if (!isHost) return { error: 'ホストのみ変更できます' };
  if (a.type === 'seatCount') {
    const n = parseInt(a.count, 10);
    if (!(n >= 3 && n <= 8)) return { error: '人数は3〜8人です' };
    while (room.seats.length < n) room.seats.push({ kind: 'ai', level: 3 });
    while (room.seats.length > n) {
      let i = -1;
      for (let j = room.seats.length - 1; j >= 0; j--) if (room.seats[j].kind !== 'human') { i = j; break; }
      if (i < 0) return { error: '人間の席は減らせません' };
      room.seats.splice(i, 1);
    }
    return { ok: true };
  }
  if (a.type === 'seat') {
    const i = parseInt(a.index, 10);
    const s = room.seats[i];
    if (!s) return { error: '席がありません' };
    if (s.kind === 'human') {
      if (s.pid === m.id) return { error: '自分の席は変更できません' };
      if (a.kind !== 'ai' && a.kind !== 'open') return { error: '無効な操作です' };
      // 人間の席をAIに戻す（そのプレイヤーは退出扱い）
      const target = room.members.get(s.pid);
      if (target) {
        removeMember(room, target);
        send(target, { kicked: true });
        for (const res of target.streams) { try { res.end(); } catch (e) { /* */ } }
      }
    }
    if (a.kind === 'open') room.seats[i] = { kind: 'open' };
    else if (a.kind === 'ai') {
      const lv = Math.max(1, Math.min(5, parseInt(a.level, 10) || 3));
      room.seats[i] = { kind: 'ai', level: lv };
    } else return { error: '無効な操作です' };
    return { ok: true };
  }
  if (a.type === 'settings') {
    room.settings = E.sanitizeSettings(a.settings);
    return { ok: true };
  }
  if (a.type === 'start') {
    if (room.seats.some(s => s.kind === 'open')) return { error: '空いている席があります。AIを入れるか参加を待ってください' };
    if (room.seats.length < 3 || room.seats.length > 8) return { error: '人数は3〜8人です' };
    startGame(room, false);
    return { ok: true, started: true };
  }
  return { error: '無効な操作です' };
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  if (p === '/api/info' && req.method === 'GET') return json(res, 200, { lan: lanUrls(), port: PORT });

  if (p === '/api/stream' && req.method === 'GET') {
    const room = rooms.get(String(url.searchParams.get('code') || '').toUpperCase());
    const m = room && memberByToken(room, url.searchParams.get('token'));
    if (!m) return json(res, 404, { error: 'ルームが見つかりません' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 1500\n\n');
    m.streams.add(res);
    if (m.dcTimer) { clearTimeout(m.dcTimer); m.dcTimer = null; }
    if (m.leftTimer) { clearTimeout(m.leftTimer); m.leftTimer = null; }
    const wasConnected = m.connected;
    m.connected = true;
    ensureHost(room);
    if (!wasConnected) {
      if (room.game && room.screen === 'game') {
        const seat = room.seatMap.findIndex(s => s.kind === 'human' && s.pid === m.id);
        if (seat >= 0) rescheduleSeat(room, seat);
      }
      broadcast(room, []);
    } else {
      send(m, viewFor(room, m, []));
    }
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) { /* */ } }, 20000);
    req.on('close', () => {
      clearInterval(ka);
      m.streams.delete(res);
      if (m.streams.size || !rooms.has(room.code)) return;
      m.dcTimer = setTimeout(() => {
        m.dcTimer = null;
        if (m.streams.size) return;
        m.connected = false;
        ensureHost(room);
        if (room.game && room.screen === 'game') {
          const seat = room.seatMap.findIndex(s => s.kind === 'human' && s.pid === m.id);
          if (seat >= 0) rescheduleSeat(room, seat);
        }
        broadcast(room, []);
        // ロビーで長時間戻らなければ席を空ける
        m.leftTimer = setTimeout(() => {
          m.leftTimer = null;
          if (m.connected || !rooms.has(room.code)) return;
          if (room.screen === 'lobby') {
            removeMember(room, m);
            if (rooms.has(room.code)) broadcast(room, []);
          }
        }, 5 * 60 * 1000);
      }, 3000);
    });
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: '不正なリクエストです' }); }

  if (p === '/api/create') {
    const { room, member } = createRoom(body.name, body.preset);
    return json(res, 200, { code: room.code, token: member.token });
  }
  if (p === '/api/join') {
    const room = rooms.get(String(body.code || '').toUpperCase().trim());
    if (!room) return json(res, 404, { error: 'ルームが見つかりません' });
    if (body.token) {
      const m = memberByToken(room, body.token);
      if (m) return json(res, 200, { code: room.code, token: m.token });
    }
    const r = joinRoom(room, body.name);
    if (r.error) return json(res, 409, { error: r.error });
    broadcast(room, []);
    return json(res, 200, { code: room.code, token: r.member.token });
  }
  if (p === '/api/action') {
    const room = rooms.get(String(body.code || '').toUpperCase());
    const m = room && memberByToken(room, body.token);
    if (!m) return json(res, 404, { error: 'ルームが見つかりません' });
    const a = body.action || {};
    if (room.screen === 'lobby') {
      const r = handleLobbyAction(room, m, a);
      if (r.error) return json(res, 400, r);
      if (!r.started && rooms.has(room.code)) broadcast(room, []);
      return json(res, 200, { ok: true });
    }
    if (room.screen === 'result') {
      if (a.type === 'leave') {
        // 結果画面から抜けた場合：席はAIに置き換える
        removeMember(room, m);
        if (rooms.has(room.code)) broadcast(room, []);
        return json(res, 200, { ok: true });
      }
      if (room.hostId !== m.id) return json(res, 400, { error: 'ホストが選択します' });
      if (a.type === 'again') {
        // 抜けたメンバーの席はAIに置き換え済み
        startGame(room, true);
        return json(res, 200, { ok: true });
      }
      if (a.type === 'end') {
        room.screen = 'lobby';
        room.game = null;
        room.result = null;
        clearAllTimers(room);
        broadcast(room, []);
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: '無効な操作です' });
    }
    // ゲーム中
    const g = room.game;
    if (a.type === 'leave') {
      removeMember(room, m);
      for (const st of m.streams) { try { st.end(); } catch (e) { /* */ } }
      if (!rooms.has(room.code)) return json(res, 200, { ok: true });
      const seat = room.seatMap.findIndex(s => s.kind === 'human' && s.pid === m.id);
      if (seat >= 0) {
        room.seatMap[seat] = { kind: 'ai', level: 3, name: room.seatMap[seat].name };
        rescheduleSeat(room, seat);
      } else {
        broadcast(room, []);
      }
      return json(res, 200, { ok: true });
    }
    const seat = room.seatMap.findIndex(s => s.kind === 'human' && s.pid === m.id);
    if (seat < 0) return json(res, 400, { error: '席がありません' });
    const r = E.act(g, seat, a);
    if (!r.ok) return json(res, 400, { error: r.error });
    afterChange(room);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------- 静的ファイル
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  let file;
  if (p === '/engine.js') file = path.join(ROOT, 'shared', 'engine.js');
  else {
    if (p === '/') p = '/index.html';
    file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(e => { console.error(e); try { json(res, 500, { error: 'サーバーエラー' }); } catch (x) { /* */ } });
    return;
  }
  serveStatic(req, res, url);
});

// 放置されたルームの掃除
setInterval(() => {
  const now = Date.now();
  for (const room of Array.from(rooms.values())) {
    const anyone = Array.from(room.members.values()).some(m => m.connected);
    if (!anyone && now - room.lastActive > 30 * 60 * 1000) destroyRoom(room);
  }
}, 60 * 1000);

function openBrowser(url) {
  try {
    let cmd, a;
    if (process.platform === 'win32') { cmd = 'cmd'; a = ['/c', 'start', '""', url]; }
    else if (process.platform === 'darwin') { cmd = 'open'; a = [url]; }
    else { cmd = 'xdg-open'; a = [url]; }
    const child = spawn(cmd, a, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => {});
    child.unref();
  } catch (e) { /* ignore */ }
}

function listen(port, tries) {
  server.once('error', e => {
    if (e.code === 'EADDRINUSE' && tries > 0) {
      console.log('ポート ' + port + ' は使用中のため ' + (port + 1) + ' を試します…');
      listen(port + 1, tries - 1);
    } else {
      console.error('サーバーを起動できませんでした:', e.message);
      process.exit(1);
    }
  });
  server.listen(port, '0.0.0.0', () => {
    PORT = port;
    const local = 'http://localhost:' + port + '/';
    console.log('');
    console.log('  ==========================================');
    console.log('   大富豪サーバーを起動しました');
    console.log('  ==========================================');
    console.log('   このPCで遊ぶ : ' + local);
    const lan = lanUrls();
    if (lan.length) {
      console.log('   同じネットワークの友だち :');
      lan.forEach(u => console.log('     ' + u));
    }
    console.log('');
    console.log('   終了するにはこのウィンドウを閉じるか Ctrl+C を押してください');
    console.log('');
    if (OPEN) openBrowser(local);
  });
}

listen(BASE_PORT, 10);
