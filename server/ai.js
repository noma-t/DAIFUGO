/*
 * ルールベースのAI（Lv1〜Lv5）
 * Lv1 ランダム / Lv2 素直 / Lv3 標準 / Lv4 上級（カード記憶） / Lv5 最強（手札推測＋シミュレーション）
 */
'use strict';
const E = require('../shared/engine');

function rnd(n) { return Math.floor(Math.random() * n); }
function pick(a) { return a[rnd(a.length)]; }

function effRev(st) { return st.revolution !== st.back; }

function keyStrength(cb, rev) {
  if (cb.jokerSingle) return 17;
  const r = cb.type === 'seq' ? (rev ? cb.hi : cb.lo) : cb.rank;
  const s = E.strength(r, rev);
  return s === 100 ? 17 : s;
}

// 自分から見えていないカード（相手の手札にあるはずのカード）
function unseenCards(st, seat) {
  const known = new Set();
  st.players[seat].hand.forEach(c => known.add(c.id));
  st.pile.forEach(c => known.add(c.id));
  st.field.forEach(f => f.cards.forEach(c => known.add(c.id)));
  return E.makeDeck(st.rules.jokers).filter(c => !known.has(c.id));
}

function handInfo(hand) {
  const counts = {};
  let jokers = 0;
  for (const c of hand) {
    if (c.r === 16) jokers++;
    else counts[c.r] = (counts[c.r] || 0) + 1;
  }
  const seqIds = new Set();
  for (const s of E.SUITS) {
    const have = {};
    for (const c of hand) if (c.s === s) have[c.r] = c;
    let run = [];
    for (let r = 3; r <= 16; r++) {
      if (have[r]) run.push(have[r]);
      else {
        if (run.length >= 3) run.forEach(c => seqIds.add(c.id));
        run = [];
      }
    }
  }
  return { counts, jokers, seqIds };
}

// 相手が返せない手か（簡易判定）
function isBoss(st, mv, unseen) {
  const cb = mv.combo;
  const rev = effRev(st);
  if (cb.jokerSingle) {
    return !(st.rules.spade3 && unseen.some(c => c.id === 'S3'));
  }
  if (cb.type === 'seq') {
    return false;
  }
  const uj = unseen.filter(c => c.r === 16).length;
  const my = E.strength(cb.rank, rev);
  if (cb.rank === 16) return true;
  const byRank = {};
  for (const c of unseen) if (c.r !== 16 && E.strength(c.r, rev) > my) byRank[c.r] = (byRank[c.r] || 0) + 1;
  if (cb.n === 1 && uj > 0) return false;
  for (const r in byRank) if (byRank[r] + uj >= cb.n) return false;
  if (uj >= cb.n && cb.n >= 2) return false;
  return true;
}

function remainingIsOneCombo(st, hand, mv) {
  const ids = new Set(mv.ids);
  const rest = hand.filter(c => !ids.has(c.id));
  if (!rest.length) return true;
  if (st.rules.finishBan && E.isBannedFinish(rest, st.rules)) return false;
  return E.analyze(rest, st.rules).length > 0;
}

function moveCost(st, seat, mv, level, ctx) {
  const R = st.rules;
  const hand = st.players[seat].hand;
  const info = ctx.info;
  const cb = mv.combo;
  const n = mv.ids.length;
  const remain = hand.length - n;
  if (remain === 0) return mv.foul ? 500 : -1000;
  const rev = effRev(st);
  const s = keyStrength(cb, rev);
  let cost = s - n * 1.3;

  const byId = {};
  hand.forEach(c => { byId[c.id] = c; });
  const used = {};
  let jUsed = 0;
  for (const id of mv.ids) {
    const c = byId[id];
    if (c.r === 16) jUsed++;
    else used[c.r] = (used[c.r] || 0) + 1;
  }
  for (const r in used) {
    const have = info.counts[r];
    if (cb.type !== 'seq' && have > used[r]) cost += 4 + (have - used[r]);
    if (cb.type === 'seq' && have >= 2) cost += 2;
  }
  if (cb.type !== 'seq') for (const id of mv.ids) if (info.seqIds.has(id)) cost += 4;
  if (jUsed && !cb.jokerSingle && remain > 2) cost += 6 * jUsed;
  if (cb.jokerSingle && remain > 3) cost += 6;
  if (s >= 14 && remain > 4 && cb.type !== 'seq') cost += 3;
  if (R.eightCut && cb.reps.indexOf(8) >= 0) cost -= 2;

  if (level === 3 && remainingIsOneCombo(st, hand, mv) && s >= 13) cost -= 20;
  if (level >= 4) {
    const boss = isBoss(st, mv, ctx.unseen);
    const one = remainingIsOneCombo(st, hand, mv);
    if (boss && one) cost -= 60;
    else if (one && s >= 13) cost -= 20;
    else if (boss && !st.fieldCombo && remain <= 4) cost -= 6;
    // 革命：手札が弱いなら狙う、強いなら避ける
    if (R.revolution && cb.type === 'multi' && cb.n >= 4) {
      const ids = new Set(mv.ids);
      const rest = hand.filter(c => !ids.has(c.id) && c.r !== 16);
      const avg = rest.length ? rest.reduce((a, c) => a + E.strength(c.r, st.revolution), 0) / rest.length : 10;
      cost += avg < 9 ? -14 : 12;
    }
    if (R.eightCut && cb.reps.indexOf(8) >= 0 && st.fieldCombo) cost -= 3;
    if (ctx.danger && st.fieldCombo) cost -= 4;
  }
  return cost;
}

function shouldPass(st, seat, best, cost, level, ctx) {
  if (!st.fieldCombo) return false;
  const hand = st.players[seat].hand;
  const remain = hand.length - best.ids.length;
  if (remain === 0) return false;
  if (level >= 4 && ctx.danger) return cost > 40;
  const usesJoker = best.ids.some(id => id[0] === 'X');
  if (usesJoker && remain > 3) return true;
  const s = keyStrength(best.combo, effRev(st));
  if (s >= 15 && remain > 6) return true;
  return cost > 18 && remain > 5;
}

function decideTurnHeuristic(st, seat, level) {
  const moves = E.legalMoves(st, seat);
  const canPass = !!st.fieldCombo;
  if (!moves.length) return { type: 'pass' };
  if (level <= 1) {
    if (canPass && rnd(moves.length + 1) === 0) return { type: 'pass' };
    return { type: 'play', cards: pick(moves).ids };
  }
  if (level === 2) {
    const rev = effRev(st);
    moves.sort((a, b) => {
      const fa = a.ids.length === st.players[seat].hand.length ? -100 : 0;
      const fb = b.ids.length === st.players[seat].hand.length ? -100 : 0;
      return (keyStrength(a.combo, rev) + fa) - (keyStrength(b.combo, rev) + fb) || b.ids.length - a.ids.length;
    });
    const m = moves.find(x => !x.foul) || moves[0];
    return { type: 'play', cards: m.ids };
  }
  const ctx = buildCtx(st, seat, level);
  let best = null, bestCost = Infinity;
  for (const mv of moves) {
    const c = moveCost(st, seat, mv, level, ctx);
    if (c < bestCost) { bestCost = c; best = mv; }
  }
  if (canPass && shouldPass(st, seat, best, bestCost, level, ctx)) return { type: 'pass' };
  return { type: 'play', cards: best.ids };
}

function buildCtx(st, seat, level) {
  const ctx = { info: handInfo(st.players[seat].hand) };
  if (level >= 4) {
    ctx.unseen = unseenCards(st, seat);
    ctx.danger = st.players.some((p, i) => i !== seat && !p.out && p.hand.length <= 2);
  }
  return ctx;
}

// ---------------------------------------------------------------- Lv5: 手札推測＋シミュレーション
function clone(st) {
  const c = JSON.parse(JSON.stringify(st));
  c.events = [];
  return c;
}

function determinize(st, seat) {
  const c = clone(st);
  const pool = E.shuffle(unseenCards(st, seat));
  let k = 0;
  c.players.forEach((p, i) => {
    if (i === seat) return;
    const need = p.out ? 0 : st.players[i].hand.length;
    p.hand = E.sortCards(pool.slice(k, k + need));
    k += need;
  });
  return c;
}

function quickChoice(st, seat, kind) {
  const p = st.players[seat];
  if (kind === 'exchange') return { type: 'choose', cards: weakest(p.hand, st.exPending[seat].count, st).map(c => c.id) };
  if (kind === 'give7' || kind === 'discard10') {
    let k = Math.min(st.pending.max, p.hand.length);
    if (sfbBlock(st, kind) && k >= p.hand.length) k = p.hand.length - 1;
    return { type: 'choose', cards: weakest(p.hand, Math.max(0, k), st).map(c => c.id) };
  }
  if (kind === 'bomber') return { type: 'declare', ranks: bomberPick(st, seat, 2) };
  return null;
}

function playoutPolicy(st, seat) {
  const moves = E.legalMoves(st, seat);
  if (!moves.length) return { type: 'pass' };
  const hand = st.players[seat].hand;
  const rev = effRev(st);
  let best = null, bc = Infinity;
  for (const m of moves) {
    let c = keyStrength(m.combo, rev) - m.ids.length * 1.3;
    if (m.ids.length === hand.length) c = m.foul ? 999 : -999;
    if (m.ids.some(id => id[0] === 'X') && hand.length - m.ids.length > 2) c += 6;
    if (c < bc) { bc = c; best = m; }
  }
  if (st.fieldCombo && bc > 15 && hand.length > 4 && Math.random() < 0.7) return { type: 'pass' };
  return { type: 'play', cards: best.ids };
}

function playout(st, me) {
  let guard = 0;
  while (st.phase !== 'end' && guard++ < 400) {
    const aw = E.awaiting(st)[0];
    if (!aw) break;
    const a = aw.kind === 'turn' ? playoutPolicy(st, aw.seat) : quickChoice(st, aw.seat, aw.kind);
    let r = E.act(st, aw.seat, a);
    if (!r.ok) {
      if (aw.kind === 'turn') {
        const mv = E.legalMoves(st, aw.seat)[0];
        r = E.act(st, aw.seat, st.fieldCombo || !mv ? { type: 'pass' } : { type: 'play', cards: mv.ids });
      } else if (aw.kind === 'bomber') {
        r = E.act(st, aw.seat, { type: 'declare', ranks: [] });
      } else {
        r = E.act(st, aw.seat, { type: 'choose', cards: [] });
      }
      if (!r.ok) break;
    }
  }
  const p = st.players[me];
  return p.place || st.n;
}

function decideTurnMC(st, seat) {
  const moves = E.legalMoves(st, seat);
  if (!moves.length) return { type: 'pass' };
  if (moves.length === 1 && !st.fieldCombo) return { type: 'play', cards: moves[0].ids };
  const ctx = buildCtx(st, seat, 4);
  const scored = moves.map(mv => ({ a: { type: 'play', cards: mv.ids }, h: moveCost(st, seat, mv, 4, ctx) }));
  scored.sort((x, y) => x.h - y.h);
  if (scored[0].h <= -500) return scored[0].a;
  const cands = scored.slice(0, 6);
  if (st.fieldCombo) cands.push({ a: { type: 'pass' }, h: 5 });
  cands.forEach(c => { c.sum = 0; c.cnt = 0; });
  const deadline = Date.now() + 350;
  let rounds = 0;
  while (Date.now() < deadline && rounds < 60) {
    rounds++;
    for (const c of cands) {
      const sim = determinize(st, seat);
      const r = E.act(sim, seat, c.a);
      if (!r.ok) { c.sum += st.n; c.cnt++; continue; }
      c.sum += playout(sim, seat);
      c.cnt++;
    }
  }
  let best = cands[0], bv = Infinity;
  for (const c of cands) {
    const v = c.sum / Math.max(1, c.cnt) + c.h * 0.01;
    if (v < bv) { bv = v; best = c; }
  }
  return best.a;
}

// ---------------------------------------------------------------- 選択系
function weakest(hand, k, st) {
  const rev = st ? st.revolution : false;
  return hand.slice().sort((a, b) => E.strength(a.r, rev) - E.strength(b.r, rev)).slice(0, k);
}
function sfbBlock(st, kind) {
  const R = st.rules;
  if (!R.specialFinishBan) return false;
  return kind === 'give7' ? R.sfbSeven : kind === 'discard10' ? R.sfbTen : R.sfbBomber;
}

function bomberPick(st, seat, level) {
  const pd = st.pending;
  const hand = st.players[seat].hand;
  const ranks = E.bomberRankList(st.rules);
  const want = st.rules.bomberMustFull ? pd.max : pd.max;
  const picks = [];
  if (level <= 1) {
    const k = st.rules.bomberMustFull ? pd.max : rnd(pd.max + 1);
    const pool = E.shuffle(ranks.slice());
    for (const r of pool) {
      if (picks.length >= k) break;
      if (E.bomberSelectable(st.rules, hand, picks, pd.max, r)) picks.push(r);
    }
    return picks;
  }
  const unseen = unseenCards(st, seat);
  const rev = st.revolution;
  const score = {};
  for (const r of ranks) {
    const mine = hand.filter(c => c.r === r).length;
    const theirs = unseen.filter(c => c.r === r).length;
    const s = E.strength(r, rev);
    // 自分の弱いカードを捨て、相手の強いカードを奪う
    score[r] = mine * (s <= 9 ? 3 : -2) + theirs * (s >= 13 ? 1.5 : 0.5);
  }
  const order = ranks.slice().sort((a, b) => score[b] - score[a]);
  for (const r of order) {
    if (picks.length >= want) break;
    if (!st.rules.bomberMustFull && score[r] <= 0) break;
    if (E.bomberSelectable(st.rules, hand, picks, pd.max, r)) picks.push(r);
  }
  return picks;
}

function decideChoice(st, seat, kind, level) {
  const p = st.players[seat];
  if (kind === 'exchange') {
    const cnt = st.exPending[seat].count;
    if (level <= 1) return { type: 'choose', cards: E.shuffle(p.hand.slice()).slice(0, cnt).map(c => c.id) };
    return { type: 'choose', cards: weakest(p.hand, cnt, st).map(c => c.id) };
  }
  if (kind === 'give7' || kind === 'discard10') {
    let k = Math.min(st.pending.max, p.hand.length);
    if (sfbBlock(st, kind) && k >= p.hand.length) k = p.hand.length - 1;
    k = Math.max(0, k);
    if (level <= 1) {
      k = rnd(k + 1);
      return { type: 'choose', cards: E.shuffle(p.hand.slice()).slice(0, k).map(c => c.id) };
    }
    // 組を崩さない弱いカードを優先
    const info = handInfo(p.hand);
    const rev = st.revolution;
    const sorted = p.hand.slice().sort((a, b) => {
      const pa = (info.counts[a.r] >= 2 || info.seqIds.has(a.id) ? 4 : 0) + E.strength(a.r, rev);
      const pb = (info.counts[b.r] >= 2 || info.seqIds.has(b.id) ? 4 : 0) + E.strength(b.r, rev);
      return pa - pb;
    });
    return { type: 'choose', cards: sorted.slice(0, k).map(c => c.id) };
  }
  if (kind === 'bomber') return { type: 'declare', ranks: bomberPick(st, seat, level) };
  return null;
}

function decide(st, seat, level) {
  const aw = E.awaiting(st).find(a => a.seat === seat);
  if (!aw) return null;
  if (aw.kind !== 'turn') return decideChoice(st, seat, aw.kind, level);
  if (level >= 5) {
    try { return decideTurnMC(st, seat); } catch (e) { return decideTurnHeuristic(st, seat, 4); }
  }
  return decideTurnHeuristic(st, seat, level);
}

// 失敗しないための最終手段
function fallback(st, seat) {
  const aw = E.awaiting(st).find(a => a.seat === seat);
  if (!aw) return null;
  if (aw.kind === 'turn') {
    if (st.fieldCombo) return { type: 'pass' };
    const mv = E.legalMoves(st, seat)[0];
    return mv ? { type: 'play', cards: mv.ids } : null;
  }
  if (aw.kind === 'bomber') {
    return { type: 'declare', ranks: st.rules.bomberMustFull ? bomberPick(st, seat, 1) : [] };
  }
  if (aw.kind === 'exchange') return decideChoice(st, seat, 'exchange', 2);
  return { type: 'choose', cards: [] };
}

module.exports = { decide, fallback, decideChoice };
