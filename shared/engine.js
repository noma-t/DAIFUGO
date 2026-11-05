/*
 * 大富豪 ゲームエンジン（サーバー・ブラウザ共用）
 * 状態はプレーンなオブジェクトで持ち、JSONで複製できる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUITS = ['S', 'H', 'D', 'C'];
  const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣', X: '★' };
  const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3, X: 4 };
  const RANK_LABEL = { 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: 'JK' };

  // ---------------------------------------------------------------- 設定
  function defaultSettings() {
    return {
      rules: {
        revolution: true,     // 革命
        eightCut: true,       // 8切り
        suitBind: true,       // 縛り：スート縛り
        numBind: false,       // 縛り：数字縛り（階段縛り）
        sequence: true,       // 階段
        spade3: true,         // スペ3返し
        exchange: true,       // カード交換
        miyakoochi: true,     // 都落ち
        elevenBack: true,     // 11バック
        fiveSkip: false,      // 5飛び
        sevenPass: false,     // 7渡し
        tenDiscard: false,    // 10捨て
        jokers: 1,            // ジョーカーの枚数
        finishBan: true,      // 上がり禁止
        banJoker: true,
        banTwo: true,
        banEight: true,
        banSpade3: false,
        queenBomber: false,   // クイーンボンバー
        bomberMustFull: false,// 必ず枚数分宣言する
        specialFinishBan: false, // 特殊上がり禁止
        sfbBomber: true,
        sfbSeven: true,
        sfbTen: true
      },
      timer: { enabled: true, seconds: 30, onTimeout: 'ai' }
    };
  }

  function sanitizeSettings(input) {
    const d = defaultSettings();
    const out = { rules: {}, timer: {} };
    const r = (input && input.rules) || {};
    for (const k of Object.keys(d.rules)) {
      if (k === 'jokers') {
        const v = parseInt(r.jokers, 10);
        out.rules.jokers = [0, 1, 2].includes(v) ? v : d.rules.jokers;
      } else {
        out.rules[k] = typeof r[k] === 'boolean' ? r[k] : d.rules[k];
      }
    }
    const t = (input && input.timer) || {};
    out.timer.enabled = typeof t.enabled === 'boolean' ? t.enabled : d.timer.enabled;
    let sec = parseInt(t.seconds, 10);
    if (!isFinite(sec)) sec = d.timer.seconds;
    out.timer.seconds = Math.max(5, Math.min(180, sec));
    out.timer.onTimeout = t.onTimeout === 'pass' ? 'pass' : 'ai';
    return out;
  }

  // ---------------------------------------------------------------- カード
  function makeDeck(jokers) {
    const d = [];
    for (const s of SUITS) for (let r = 3; r <= 15; r++) d.push({ id: s + r, s: s, r: r });
    for (let i = 1; i <= jokers; i++) d.push({ id: 'X' + i, s: 'X', r: 16 });
    return d;
  }
  function shuffle(a, rnd) {
    rnd = rnd || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function sortCards(cards) {
    return cards.sort((a, b) => a.r - b.r || SUIT_ORDER[a.s] - SUIT_ORDER[b.s]);
  }
  function isJoker(c) { return c.r === 16; }
  function strength(r, rev) {
    if (r === 16) return 100;
    return rev ? 20 - r : r;
  }
  function cardLabel(c) { return c.r === 16 ? 'JK' : SUIT_SYM[c.s] + RANK_LABEL[c.r]; }

  // ---------------------------------------------------------------- 役の解析
  // 出そうとしているカードの解釈を列挙する（ジョーカーの扱いで複数ありうる）
  function analyze(cards, rules) {
    const n = cards.length;
    if (!n) return [];
    const jokers = cards.filter(isJoker).length;
    const reals = cards.filter(c => !isJoker(c));
    const out = [];
    if (reals.length === 0) {
      if (n === 1) out.push({ type: 'single', n: 1, rank: 16, jokerSingle: true, suits: [], jokers: 1, reps: [16] });
      else out.push({ type: 'multi', n: n, rank: 16, suits: [], jokers: n, reps: new Array(n).fill(16) });
      return out;
    }
    if (reals.every(c => c.r === reals[0].r)) {
      const r = reals[0].r;
      out.push({ type: n === 1 ? 'single' : 'multi', n: n, rank: r, suits: reals.map(c => c.s).sort(), jokers: jokers, reps: new Array(n).fill(r) });
    }
    if (rules.sequence && n >= 3) {
      const suit = reals[0].s;
      if (reals.every(c => c.s === suit)) {
        const rs = reals.map(c => c.r).sort((a, b) => a - b);
        let distinct = true;
        for (let i = 1; i < rs.length; i++) if (rs[i] === rs[i - 1]) distinct = false;
        const minR = rs[0], maxR = rs[rs.length - 1];
        if (distinct && maxR - minR + 1 <= n) {
          for (let lo = Math.max(3, maxR - n + 1); lo <= Math.min(minR, 16 - n); lo++) {
            const hi = lo + n - 1;
            const reps = [];
            for (let r = lo; r <= hi; r++) reps.push(r);
            out.push({ type: 'seq', n: n, lo: lo, hi: hi, suit: suit, suits: [suit], jokers: jokers, reps: reps });
          }
        }
      }
    }
    return out;
  }

  function suitsOf(cb) { return cb.type === 'seq' ? [cb.suit] : cb.suits; }

  function ctxOf(st) {
    return { rules: st.rules, revolution: st.revolution, back: st.back, bind: st.bind, field: st.fieldCombo };
  }

  function canBeat(cb, ctx) {
    const f = ctx.field;
    if (!f) return true;
    const rev = ctx.revolution !== ctx.back;
    if (f.jokerSingle) {
      return !!(ctx.rules.spade3 && cb.type === 'single' && cb.rank === 3 && cb.suits[0] === 'S');
    }
    if (cb.jokerSingle) return f.type === 'single';
    if (cb.type !== f.type || cb.n !== f.n) return false;
    if (ctx.bind && ctx.bind.suits) {
      const real = suitsOf(cb);
      if (!real.every(s => ctx.bind.suits.indexOf(s) >= 0)) return false;
    }
    if (cb.type === 'seq') return rev ? cb.hi < f.hi : cb.lo > f.lo;
    const a = strength(cb.rank, rev), b = strength(f.rank, rev);
    if (ctx.bind && ctx.bind.num && cb.rank !== 16 && f.rank !== 16) return a === b + 1;
    return a > b;
  }

  function bestInterp(list, ctx) {
    const ok = list.filter(cb => canBeat(cb, ctx));
    if (!ok.length) return null;
    const plain = ok.find(cb => cb.type !== 'seq');
    if (plain) return plain;
    const rev = ctx.revolution !== ctx.back;
    ok.sort((a, b) => rev ? a.hi - b.hi : b.lo - a.lo);
    return ok[0];
  }

  function isBannedFinish(cards, rules) {
    if (!rules.finishBan) return false;
    return cards.some(c =>
      (rules.banJoker && c.r === 16) || (rules.banTwo && c.r === 15) ||
      (rules.banEight && c.r === 8) || (rules.banSpade3 && c.id === 'S3'));
  }

  // 出せるかどうか（ctx は ctxOf(state) と同じ形）
  function validatePlay(ctx, hand, ids) {
    if (!ids || !ids.length) return { ok: false };
    const set = new Set(ids);
    if (set.size !== ids.length) return { ok: false };
    const cards = ids.map(id => hand.find(c => c.id === id));
    if (cards.some(c => !c)) return { ok: false };
    const cb = bestInterp(analyze(cards, ctx.rules), ctx);
    if (!cb) return { ok: false, reason: '出せません' };
    let foul = false;
    if (cards.length === hand.length && isBannedFinish(cards, ctx.rules)) {
      // 親で他に出せる手がない場合のみ、反則上がり（最下位）として出せる
      if (ctx.field || hand.length > 1) return { ok: false, reason: '上がり禁止' };
      foul = true;
    }
    return { ok: true, combo: cb, cards: cards, foul: foul };
  }

  function combos(arr, k) {
    const out = [];
    const cur = [];
    (function rec(start) {
      if (cur.length === k) { out.push(cur.slice()); return; }
      for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1); cur.pop(); }
    })(0);
    return out;
  }

  // 場を無視した、手札から作れる組の候補
  function candidateSets(hand, rules) {
    const J = hand.filter(isJoker);
    const byRank = {};
    for (const c of hand) if (!isJoker(c)) (byRank[c.r] = byRank[c.r] || []).push(c);
    const out = [];
    if (J.length) out.push([J[0]]);
    if (J.length >= 2) out.push(J.slice(0, 2));
    for (const r in byRank) {
      const L = byRank[r];
      for (let k = 1; k <= L.length; k++) {
        for (const sub of combos(L, k)) {
          for (let j = 0; j <= J.length; j++) out.push(sub.concat(J.slice(0, j)));
        }
      }
    }
    if (rules.sequence) {
      for (const s of SUITS) {
        const have = {};
        for (const c of hand) if (c.s === s) have[c.r] = c;
        for (let lo = 3; lo <= 13; lo++) {
          let miss = 0;
          const cs = [];
          for (let hi = lo; hi <= 15; hi++) {
            if (have[hi]) cs.push(have[hi]); else miss++;
            if (miss > J.length) break;
            if (hi - lo + 1 >= 3 && cs.length > 0) out.push(cs.concat(J.slice(0, miss)));
          }
        }
      }
    }
    return out;
  }

  function legalMovesCtx(ctx, hand) {
    const seen = new Set();
    const res = [];
    for (const set of candidateSets(hand, ctx.rules)) {
      const ids = set.map(c => c.id);
      const key = ids.slice().sort().join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const v = validatePlay(ctx, hand, ids);
      if (v.ok) res.push({ ids: ids, combo: v.combo, foul: v.foul });
    }
    return res;
  }
  function legalMoves(st, seat) { return legalMovesCtx(ctxOf(st), st.players[seat].hand); }

  // ---------------------------------------------------------------- 階級
  function titleOf(place, n) {
    if (!place) return '';
    if (n === 3) return ['', '大富豪', '平民', '大貧民'][place] || '';
    if (place === 1) return '大富豪';
    if (place === 2) return '富豪';
    if (place === n) return '大貧民';
    if (place === n - 1) return '貧民';
    return '平民';
  }

  function bindLabel(bind) {
    if (!bind) return '';
    const parts = [];
    if (bind.suits) parts.push(bind.suits.map(s => SUIT_SYM[s]).join('') + '縛り');
    if (bind.num) parts.push('数字縛り');
    return parts.join(' ');
  }

  // ---------------------------------------------------------------- ゲーム進行
  function ev(st, e) { st.events.push(e); }
  function eff(st, rule, seat, extra) { ev(st, Object.assign({ t: 'effect', rule: rule, seat: seat }, extra || {})); }

  function newGame(opts) {
    const rules = opts.rules;
    const n = opts.names.length;
    const deck = shuffle(makeDeck(rules.jokers), opts.rnd);
    const players = opts.names.map(name => ({ name: name, hand: [], out: false, place: 0, passed: false, foul: false, ochi: false }));
    const off = Math.floor((opts.rnd || Math.random)() * n);
    deck.forEach((c, i) => players[(i + off) % n].hand.push(c));
    players.forEach(p => sortCards(p.hand));
    const st = {
      rules: rules, n: n, players: players, gameNo: opts.gameNo || 1,
      prevPlaces: opts.prevPlaces || null,
      turn: 0, field: [], fieldCombo: null, lastPlayer: -1,
      revolution: false, back: false, bind: { suits: null, num: false },
      pile: [], nextTop: 1, nextBottom: n,
      phase: 'play', pending: null, queue: [], post: null, exPending: null,
      events: [], seq: 0, playSeq: 0, millionaire: -1
    };
    if (st.prevPlaces) st.millionaire = st.prevPlaces.indexOf(1);
    if (st.prevPlaces && rules.exchange) setupExchange(st);
    else startPlay(st);
    return st;
  }

  function startPlay(st) {
    st.phase = 'play';
    st.exPending = null;
    if (st.prevPlaces) {
      const low = st.prevPlaces.indexOf(st.n);
      st.turn = low >= 0 ? low : 0;
    } else {
      const holder = st.players.findIndex(p => p.hand.some(c => c.id === 'D3'));
      st.turn = holder >= 0 ? holder : 0;
    }
    ev(st, { t: 'start', seat: st.turn });
  }

  function setupExchange(st) {
    const n = st.n;
    const seatOf = p => st.prevPlaces.indexOf(p);
    const pairs = n === 3 ? [[1, 3, 1]] : [[1, n, 2], [2, n - 1, 1]];
    st.phase = 'exchange';
    st.exPending = {};
    for (const pr of pairs) {
      const u = seatOf(pr[0]), l = seatOf(pr[1]), cnt = pr[2];
      if (u < 0 || l < 0) continue;
      const lp = st.players[l], up = st.players[u];
      const best = lp.hand.slice().sort((a, b) => strength(b.r, false) - strength(a.r, false) || SUIT_ORDER[a.s] - SUIT_ORDER[b.s]).slice(0, cnt);
      const ids = new Set(best.map(c => c.id));
      lp.hand = lp.hand.filter(c => !ids.has(c.id));
      up.hand = sortCards(up.hand.concat(best));
      ev(st, { t: 'exchange', from: l, to: u, cards: best });
      st.exPending[u] = { to: l, count: cnt };
    }
    if (!Object.keys(st.exPending).length) startPlay(st);
  }

  function nextSeat(st, from, skipPassed) {
    for (let k = 1; k <= st.n; k++) {
      const s = (from + k) % st.n;
      const p = st.players[s];
      if (p.out) continue;
      if (skipPassed && p.passed) continue;
      return s;
    }
    return -1;
  }
  function activeSeats(st) {
    const r = [];
    st.players.forEach((p, i) => { if (!p.out) r.push(i); });
    return r;
  }
  function leaderFrom(st, seat) {
    if (seat >= 0 && !st.players[seat].out) return seat;
    return nextSeat(st, seat < 0 ? 0 : seat, false);
  }

  function awaiting(st) {
    if (st.phase === 'end') return [];
    if (st.phase === 'exchange') return Object.keys(st.exPending).map(s => ({ seat: +s, kind: 'exchange' }));
    if (st.phase === 'choice') return [{ seat: st.pending.seat, kind: st.pending.type }];
    return [{ seat: st.turn, kind: 'turn' }];
  }

  function err(msg) { return { ok: false, error: msg || '無効な操作です' }; }
  const OK = { ok: true };

  function act(st, seat, a) {
    const r = actInner(st, seat, a || {});
    if (r.ok) st.seq++;
    return r;
  }

  function actInner(st, seat, a) {
    if (st.phase === 'end') return err('ゲームは終了しています');
    if (st.phase === 'exchange') {
      if (a.type !== 'choose') return err();
      const pe = st.exPending[seat];
      if (!pe) return err();
      const p = st.players[seat];
      const ids = Array.isArray(a.cards) ? a.cards : [];
      if (ids.length !== pe.count || new Set(ids).size !== ids.length) return err('枚数が違います');
      const cards = ids.map(id => p.hand.find(c => c.id === id));
      if (cards.some(c => !c)) return err();
      const set = new Set(ids);
      p.hand = p.hand.filter(c => !set.has(c.id));
      const t = st.players[pe.to];
      t.hand = sortCards(t.hand.concat(cards));
      ev(st, { t: 'exchange', from: seat, to: pe.to, cards: cards });
      delete st.exPending[seat];
      if (!Object.keys(st.exPending).length) startPlay(st);
      return OK;
    }
    if (st.phase === 'choice') {
      const pd = st.pending;
      if (pd.seat !== seat) return err('手番ではありません');
      if (pd.type === 'bomber') {
        if (a.type !== 'declare') return err();
        return doDeclare(st, Array.isArray(a.ranks) ? a.ranks : []);
      }
      if (a.type !== 'choose') return err();
      return doChoose(st, Array.isArray(a.cards) ? a.cards : []);
    }
    if (st.turn !== seat) return err('手番ではありません');
    if (a.type === 'pass') {
      if (!st.fieldCombo) return err('親はパスできません');
      doPass(st, seat);
      return OK;
    }
    if (a.type === 'play') {
      const v = validatePlay(ctxOf(st), st.players[seat].hand, Array.isArray(a.cards) ? a.cards : []);
      if (!v.ok) return err(v.reason);
      doPlay(st, seat, v);
      return OK;
    }
    return err();
  }

  function doPlay(st, seat, v) {
    const R = st.rules;
    const p = st.players[seat];
    const ids = new Set(v.cards.map(c => c.id));
    p.hand = p.hand.filter(c => !ids.has(c.id));
    const prev = st.fieldCombo;
    const cb = v.combo;
    const rev0 = st.revolution !== st.back;
    st.playSeq++;
    const cards = sortCards(v.cards.slice());
    st.field.push({ id: st.playSeq, seat: seat, cards: cards });
    ev(st, { t: 'play', seat: seat, cards: cards, id: st.playSeq });

    const newBinds = [];
    if (prev && !prev.jokerSingle && !cb.jokerSingle && prev.type === cb.type) {
      if (R.suitBind && !st.bind.suits && (cb.type === 'seq' || (!prev.jokers && !cb.jokers))) {
        const a = suitsOf(prev).slice().sort().join(), b = suitsOf(cb).slice().sort().join();
        if (a === b) {
          st.bind.suits = suitsOf(cb).slice();
          newBinds.push(st.bind.suits.map(s => SUIT_SYM[s]).join('') + '縛り');
        }
      }
      if (R.numBind && !st.bind.num && cb.type !== 'seq' && cb.rank !== 16 && prev.rank !== 16 &&
        strength(cb.rank, rev0) === strength(prev.rank, rev0) + 1) {
        st.bind.num = true;
        newBinds.push('数字縛り');
      }
    }
    st.fieldCombo = cb;
    st.lastPlayer = seat;

    const cnt = r => cb.reps.filter(x => x === r).length;
    let flow = false, skip = 0;
    if (prev && prev.jokerSingle) { eff(st, 'スペ3返し', seat); flow = true; }
    if (R.revolution && cb.type === 'multi' && cb.n >= 4) { st.revolution = !st.revolution; eff(st, '革命', seat); }
    if (R.elevenBack && cnt(11)) { st.back = !st.back; eff(st, '11バック', seat); }
    for (const b of newBinds) eff(st, b, seat);
    if (R.eightCut && cnt(8)) { flow = true; eff(st, '8切り', seat); }
    if (R.fiveSkip && cnt(5) && !flow) { skip = cnt(5); eff(st, '5飛び', seat); }

    if (p.hand.length === 0) finishPlayer(st, seat, v.foul);
    if (st.phase === 'end') return;

    st.queue = [];
    if (R.sevenPass && cnt(7) && p.hand.length) st.queue.push({ type: 'give7', seat: seat, max: cnt(7) });
    if (R.tenDiscard && cnt(10) && p.hand.length) st.queue.push({ type: 'discard10', seat: seat, max: cnt(10) });
    if (R.queenBomber && cnt(12)) st.queue.push({ type: 'bomber', seat: seat, max: cnt(12) });
    st.post = { seat: seat, flow: flow, skip: skip };
    runQueue(st);
  }

  function runQueue(st) {
    while (st.queue.length) {
      if (st.phase === 'end') return;
      const q = st.queue.shift();
      const p = st.players[q.seat];
      if (q.type !== 'bomber' && p.hand.length === 0) continue;
      if (q.type === 'give7') {
        q.to = -1;
        for (let k = 1; k < st.n; k++) {
          const s = (q.seat + k) % st.n;
          if (!st.players[s].out) { q.to = s; break; }
        }
        if (q.to < 0) continue;
      }
      st.pending = q;
      st.phase = 'choice';
      return;
    }
    if (st.phase === 'end') return;
    st.pending = null;
    st.phase = 'play';
    finishPost(st);
  }

  function sfbOn(st, kind) {
    const R = st.rules;
    if (!R.specialFinishBan) return false;
    return kind === 'bomber' ? R.sfbBomber : kind === 'give7' ? R.sfbSeven : R.sfbTen;
  }

  function doChoose(st, ids) {
    const pd = st.pending;
    const p = st.players[pd.seat];
    if (ids.length > pd.max || new Set(ids).size !== ids.length) return err('枚数が多すぎます');
    const cards = ids.map(id => p.hand.find(c => c.id === id));
    if (cards.some(c => !c)) return err();
    if (sfbOn(st, pd.type) && ids.length > 0 && ids.length === p.hand.length) return err('特殊上がり禁止');
    const set = new Set(ids);
    p.hand = p.hand.filter(c => !set.has(c.id));
    if (pd.type === 'give7') {
      const t = st.players[pd.to];
      t.hand = sortCards(t.hand.concat(cards));
      if (cards.length) {
        eff(st, '7渡し', pd.seat);
        ev(st, { t: 'give', from: pd.seat, to: pd.to, cards: cards });
      }
    } else {
      st.pile.push.apply(st.pile, cards);
      if (cards.length) {
        eff(st, '10捨て', pd.seat);
        ev(st, { t: 'discard', seat: pd.seat, cards: cards });
      }
    }
    if (p.hand.length === 0 && !p.out) finishPlayer(st, pd.seat, false);
    st.pending = null;
    if (st.phase !== 'end') st.phase = 'play';
    runQueue(st);
    return OK;
  }

  function bomberRankList(rules) {
    const r = [];
    for (let i = 3; i <= 15; i++) r.push(i);
    if (rules.jokers > 0) r.push(16);
    return r;
  }

  // クイーンボンバー：その数字を選べるか（picks は選択中の数字）
  function bomberSelectable(rules, hand, picks, max, rank) {
    if (picks.indexOf(rank) >= 0) return true;
    if (picks.length >= max) return false;
    if (rules.specialFinishBan && rules.sfbBomber && hand.length) {
      const after = picks.concat([rank]);
      if (hand.every(c => after.indexOf(c.r) >= 0)) return false;
    }
    return true;
  }

  function doDeclare(st, ranks) {
    const pd = st.pending;
    const R = st.rules;
    const valid = bomberRankList(R);
    ranks = ranks.map(x => parseInt(x, 10));
    if (new Set(ranks).size !== ranks.length || ranks.some(r => valid.indexOf(r) < 0)) return err();
    if (ranks.length > pd.max) return err('宣言できる数を超えています');
    if (R.bomberMustFull && ranks.length !== pd.max) return err('枚数分宣言してください');
    const me = st.players[pd.seat];
    if (sfbOn(st, 'bomber') && me.hand.length && me.hand.every(c => ranks.indexOf(c.r) >= 0)) return err('特殊上がり禁止');
    const set = new Set(ranks);
    const losses = {};
    st.players.forEach((p, s) => {
      if (p.out) return;
      const L = p.hand.filter(c => set.has(c.r));
      if (!L.length) return;
      p.hand = p.hand.filter(c => !set.has(c.r));
      losses[s] = L;
      st.pile.push.apply(st.pile, L);
    });
    if (ranks.length) {
      eff(st, 'クイーンボンバー', pd.seat, { chips: ranks.slice().sort((a, b) => a - b).map(r => RANK_LABEL[r]) });
      ev(st, { t: 'bomber', seat: pd.seat, ranks: ranks, losses: losses });
    }
    for (let k = 0; k < st.n; k++) {
      const s = (pd.seat + k) % st.n;
      const p = st.players[s];
      if (!p.out && p.hand.length === 0) {
        finishPlayer(st, s, false);
        if (st.phase === 'end') break;
      }
    }
    st.pending = null;
    if (st.phase !== 'end') st.phase = 'play';
    runQueue(st);
    return OK;
  }

  function finishPlayer(st, seat, foul) {
    const p = st.players[seat];
    p.out = true;
    p.passed = false;
    if (foul) {
      p.place = st.nextBottom--;
      p.foul = true;
      eff(st, '反則上がり', seat);
    } else {
      p.place = st.nextTop++;
      ev(st, { t: 'finish', seat: seat, place: p.place });
      if (st.rules.miyakoochi && p.place === 1 && st.millionaire >= 0 && st.millionaire !== seat) {
        const m = st.players[st.millionaire];
        if (!m.out) {
          m.out = true;
          m.ochi = true;
          m.passed = false;
          m.place = st.nextBottom--;
          eff(st, '都落ち', st.millionaire);
        }
      }
    }
    checkEnd(st);
  }

  function checkEnd(st) {
    const act = st.players.filter(p => !p.out);
    if (act.length <= 1) {
      if (act.length === 1) { act[0].out = true; act[0].place = st.nextTop++; }
      st.phase = 'end';
      st.pending = null;
      st.queue = [];
      st.post = null;
      ev(st, { t: 'end' });
    }
  }

  function finishPost(st) {
    const post = st.post;
    st.post = null;
    if (!post || st.phase === 'end') return;
    const seat = post.seat;
    if (post.flow) return doFlow(st, leaderFrom(st, seat));
    const others = activeSeats(st).filter(s => s !== seat && !st.players[s].passed);
    if (others.length === 0) return doFlow(st, leaderFrom(st, seat));
    // 5飛びで残りの全員が飛ばされた（誰も出さずに出した本人へ戻る）なら場を流す
    if (post.skip >= others.length) {
      for (let s = nextSeat(st, seat, true), i = 0; i < others.length; i++, s = nextSeat(st, s, true)) ev(st, { t: 'skip', seat: s });
      return doFlow(st, leaderFrom(st, seat));
    }
    let t = nextSeat(st, seat, true);
    for (let i = 0; i < post.skip; i++) {
      ev(st, { t: 'skip', seat: t });
      t = nextSeat(st, t, true);
    }
    st.turn = t;
  }

  function doPass(st, seat) {
    st.players[seat].passed = true;
    ev(st, { t: 'pass', seat: seat });
    const lp = st.lastPlayer;
    const remaining = activeSeats(st).filter(s => !st.players[s].passed && s !== lp);
    const next = nextSeat(st, seat, true);
    // 5飛びで飛ばされた人は passed にならないため、手番が最後に出した人へ戻った時点でも場を流す
    if (remaining.length === 0 || next === lp) return doFlow(st, leaderFrom(st, lp));
    st.turn = next;
  }

  function doFlow(st, leader) {
    for (const pl of st.field) st.pile.push.apply(st.pile, pl.cards);
    st.field = [];
    st.fieldCombo = null;
    st.lastPlayer = -1;
    st.bind = { suits: null, num: false };
    st.back = false;
    st.players.forEach(p => { p.passed = false; });
    ev(st, { t: 'flow' });
    st.turn = leader;
  }

  function places(st) { return st.players.map(p => p.place); }

  return {
    SUITS, SUIT_SYM, RANK_LABEL,
    defaultSettings, sanitizeSettings,
    makeDeck, shuffle, sortCards, strength, cardLabel,
    analyze, canBeat, validatePlay, legalMoves, legalMovesCtx, candidateSets, isBannedFinish,
    ctxOf, titleOf, bindLabel, newGame, act, awaiting, places,
    bomberRankList, bomberSelectable, nextSeat
  };
});
