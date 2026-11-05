(() => {
  'use strict';
  const E = window.Engine;
  const $ = (s, el) => (el || document).querySelector(s);
  const stage = $('#stage');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const S = {
    scale: 1, code: null, token: null, es: null, view: null, screen: null, offset: 0,
    sel: new Set(), groups: [], csel: new Set(), picks: [], dlgKey: null, choiceKey: null,
    ptr: null, handPos: {}, fieldEls: new Map(), handEls: new Map(), oppPos: {},
    banners: [], bannerTimer: null
  };

  const FELT = { x: 40, y: 72, w: 1200, h: 420 };
  const PILE_PT = { x: 1060, y: 350 };
  const HAND_X = 40, HAND_Y = 548, HAND_W = 1036;
  const OPP_LAYOUT = {
    1: [[545, 120]],
    2: [[330, 136], [760, 136]],
    3: [[70, 200], [545, 120], [1030, 200]],
    4: [[70, 200], [330, 136], [760, 136], [1030, 200]]
  };
  const PLAY_OFFS = [[0, 0, 0], [16, -10, 5], [-14, 8, -6], [10, 12, 3], [-12, -8, -4], [6, 6, 7]];

  // ---------------------------------------------------------------- 画面サイズ
  function fit() {
    S.scale = Math.min(window.innerWidth / 1280, window.innerHeight / 720);
    stage.style.transform = 'translate(-50%, -50%) scale(' + S.scale + ')';
  }
  window.addEventListener('resize', fit);
  fit();
  function stagePt(e) {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left) / S.scale, y: (e.clientY - r.top) / S.scale };
  }

  function show(name) {
    if (S.screen === name) return;
    S.screen = name;
    document.querySelectorAll('.screen').forEach(el => el.classList.toggle('on', el.id === 'scr-' + name));
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
  }

  // ---------------------------------------------------------------- 通信
  async function api(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '通信エラー');
    return j;
  }
  function send(action) {
    return api('/api/action', { code: S.code, token: S.token, action }).catch(e => { toast(e.message); throw e; });
  }
  function storeKey(code) { return 'daifugo:' + code; }

  function connect(code, token) {
    S.code = code;
    S.token = token;
    try { localStorage.setItem(storeKey(code), token); } catch (e) { /* */ }
    history.replaceState(null, '', '?room=' + code);
    if (S.es) S.es.close();
    const es = new EventSource('/api/stream?code=' + encodeURIComponent(code) + '&token=' + encodeURIComponent(token));
    S.es = es;
    es.onmessage = e => {
      let v;
      try { v = JSON.parse(e.data); } catch (x) { return; }
      if (v.kicked) { leaveToTitle('ルームから外れました'); return; }
      $('#connNote').textContent = '';
      onView(v);
    };
    es.onerror = () => {
      if (es.readyState === 2) {
        leaveToTitle('ルームに接続できませんでした');
      } else {
        $('#connNote').textContent = '再接続中…';
      }
    };
  }

  function leaveToTitle(msg) {
    if (S.es) { S.es.close(); S.es = null; }
    if (S.code) { try { localStorage.removeItem(storeKey(S.code)); } catch (e) { /* */ } }
    S.code = null; S.token = null; S.view = null;
    history.replaceState(null, '', location.pathname);
    $('#titleMsg').textContent = msg || '';
    resetGameDom();
    show('title');
  }

  // ---------------------------------------------------------------- タイトル
  const inName = $('#inName'), inCode = $('#inCode');
  try { inName.value = localStorage.getItem('daifugo:name') || ''; } catch (e) { /* */ }
  function myName() {
    const n = inName.value.trim() || 'プレイヤー';
    try { localStorage.setItem('daifugo:name', n); } catch (e) { /* */ }
    return n;
  }
  // 前回の対戦設定（ルール・持ち時間・席構成）を Cookie に保存／復元する
  const PRESET_COOKIE = 'daifugo_preset';
  function loadPreset() {
    const m = document.cookie.match(new RegExp('(?:^|; )' + PRESET_COOKIE + '=([^;]*)'));
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(m[1])); } catch (e) { return null; }
  }
  function savePreset(L) {
    const preset = {
      settings: L.settings,
      seats: L.seats.map(s => s.isMe ? { kind: 'me' } : s.kind === 'ai' ? { kind: 'ai', level: s.level } : { kind: 'open' })
    };
    document.cookie = PRESET_COOKIE + '=' + encodeURIComponent(JSON.stringify(preset)) + '; path=/; max-age=31536000; SameSite=Lax';
  }

  $('#btnCreate').addEventListener('click', async () => {
    try {
      const r = await api('/api/create', { name: myName(), preset: loadPreset() });
      connect(r.code, r.token);
    } catch (e) { $('#titleMsg').textContent = e.message; }
  });
  async function join() {
    const code = inCode.value.trim().toUpperCase();
    if (code.length !== 4) { $('#titleMsg').textContent = 'ルームコードは4文字です'; return; }
    let token = null;
    try { token = localStorage.getItem(storeKey(code)); } catch (e) { /* */ }
    try {
      const r = await api('/api/join', { code, name: myName(), token });
      connect(r.code, r.token);
    } catch (e) { $('#titleMsg').textContent = e.message; }
  }
  $('#btnJoin').addEventListener('click', join);
  inCode.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });

  // ---------------------------------------------------------------- 表示更新
  function onView(v) {
    const prev = S.view;
    S.view = v;
    S.offset = v.now - Date.now();
    if (v.screen === 'lobby') { resetGameDom(); show('lobby'); renderLobby(v); }
    else if (v.screen === 'game') {
      if (!prev || prev.screen !== 'game' || (prev.game && v.game && prev.game.gameNo !== v.game.gameNo)) resetGameDom();
      show('game');
      renderGame(v, prev);
    } else if (v.screen === 'result') { show('result'); renderResult(v); }
  }
  function now() { return Date.now() + S.offset; }

  // ---------------------------------------------------------------- ルームトップ
  const RULES = [
    { k: 'revolution', name: '革命', desc: '同じ数字4枚以上で強さの順番が逆転' },
    { k: 'eightCut', name: '8切り', desc: '8を出すと場が流れる（階段に含まれても有効）' },
    { name: '縛り', desc: '種類ごとにオン／オフ', subs: [{ k: 'suitBind', name: 'スート縛り' }, { k: 'numBind', name: '数字縛り' }] },
    { k: 'sequence', name: '階段', desc: '同じスートで連続した3枚以上を出せる' },
    { k: 'spade3', name: 'スペ3返し', desc: 'ジョーカー1枚出しにスペードの3で返せる' },
    { k: 'exchange', name: 'カード交換', desc: '2ゲーム目から階級に応じて交換' },
    { k: 'miyakoochi', name: '都落ち', desc: '大富豪が1位で上がれないと大貧民に' },
    { k: 'elevenBack', name: '11バック', desc: 'Jを出すと場が流れるまで強さが逆転' },
    { k: 'fiveSkip', name: '5飛び', desc: '5を出すと次のプレイヤーを飛ばす' },
    { k: 'sevenPass', name: '7渡し', desc: '7を出すと手札を次のプレイヤーに渡せる' },
    { k: 'tenDiscard', name: '10捨て', desc: '10を出すと手札を捨てられる' },
    { k: 'jokers', name: 'ジョーカーの枚数', type: 'jokers' },
    { k: 'finishBan', name: '上がり禁止', desc: '選んだカードを最後に出して上がれない', subs: [{ k: 'banJoker', name: 'JK' }, { k: 'banTwo', name: '2' }, { k: 'banEight', name: '8' }, { k: 'banSpade3', name: '♠3' }] },
    { k: 'queenBomber', name: 'クイーンボンバー', desc: 'Qを出すと数字を宣言し、全員がその数字を捨てる', subs: [{ k: 'bomberMustFull', name: '必ず枚数分宣言' }] },
    { k: 'specialFinishBan', name: '特殊上がり禁止', desc: '特殊効果で手札がなくなる上がり方を禁止', subs: [{ k: 'sfbBomber', name: 'クイーンボンバー' }, { k: 'sfbSeven', name: '7渡し' }, { k: 'sfbTen', name: '10捨て' }] }
  ];

  function updateSettings(mut) {
    const s = JSON.parse(JSON.stringify(S.view.lobby.settings));
    mut(s);
    send({ type: 'settings', settings: s }).catch(() => {});
  }

  function renderLobby(v) {
    const L = v.lobby;
    const host = v.me.isHost;
    const dis = host ? '' : ' disabled';
    if (host) savePreset(L);
    $('#lbCode').textContent = 'ROOM ' + v.code;
    const humans = L.seats.filter(s => s.kind === 'human').length;
    const ais = L.seats.filter(s => s.kind === 'ai').length;
    $('#lbCount').textContent = L.seats.length + '人 / 人間 ' + humans + ' / AI ' + ais;
    $('#lbHostNote').textContent = host ? 'あなたがホストです' : 'ルールと席はホストが決めます';
    $('#seatNum').textContent = L.seats.length;
    $('#seatMinus').disabled = !host || L.seats.length <= 3;
    $('#seatPlus').disabled = !host || L.seats.length >= 5;

    $('#seatList').innerHTML = L.seats.map((s, i) => {
      let body;
      if (s.kind === 'human') {
        const tags = (s.isHost ? '<span class="seat-tag">ホスト</span>' : '') + (s.isMe ? '<span class="seat-tag">あなた</span>' : '') + (s.connected ? '' : '<span class="seat-tag off">切断中</span>');
        const kick = host && !s.isMe ? '<button class="btn small" data-seat="' + i + '" data-kind="ai" data-level="3">AIにする</button>' : '';
        body = '<span class="seat-name">' + esc(s.name) + tags + '</span>' + kick;
      } else {
        const lv = s.kind === 'ai' ? s.level : 0;
        const seg = '<div class="seg" role="group" aria-label="席' + (i + 1) + 'の設定">' +
          '<button data-seat="' + i + '" data-kind="open" class="' + (s.kind === 'open' ? 'on' : '') + '"' + dis + '>人間待ち</button>' +
          [1, 2, 3, 4, 5].map(l => '<button data-seat="' + i + '" data-kind="ai" data-level="' + l + '" class="' + (lv === l ? 'on' : '') + '"' + dis + ' aria-label="AI レベル' + l + '">Lv' + l + '</button>').join('') +
          '</div>';
        body = '<span class="seat-name">' + (s.kind === 'open' ? '<span class="muted">参加待ち…</span>' : 'CPU Lv' + lv) + '</span>' + seg;
      }
      return '<div class="seat"><span class="seat-no">' + (i + 1) + '</span>' + body + '</div>';
    }).join('');

    const urls = [location.origin + '/?room=' + v.code];
    (v.lan || []).forEach(u => {
      const x = u.replace(/\/$/, '') + '/?room=' + v.code;
      if (urls.indexOf(x) < 0) urls.push(x);
    });
    $('#inviteList').innerHTML = urls.map(u => '<div class="invite-row"><span class="invite-url">' + esc(u) + '</span><button class="btn small" data-copy="' + esc(u) + '">コピー</button></div>').join('');

    const st = L.settings;
    const R = st.rules, T = st.timer;
    $('#rulesNote').textContent = host ? 'クリックで切り替え' : '';
    const secOpts = [10, 15, 20, 30, 45, 60, 90, 120];
    if (secOpts.indexOf(T.seconds) < 0) secOpts.push(T.seconds);
    $('#timerBox').innerHTML =
      '<span>持ち時間</span>' +
      '<button class="toggle ' + (T.enabled ? 'on' : '') + '" data-timer="enabled"' + dis + ' aria-pressed="' + T.enabled + '">' + (T.enabled ? 'ON' : 'OFF') + '</button>' +
      '<label class="muted" for="selSec">1手</label><select id="selSec" class="sel-in"' + dis + (T.enabled ? '' : ' disabled') + '>' +
      secOpts.sort((a, b) => a - b).map(x => '<option value="' + x + '"' + (x === T.seconds ? ' selected' : '') + '>' + x + '秒</option>').join('') + '</select>' +
      '<span class="muted">時間切れ</span><div class="seg" role="group" aria-label="時間切れの動作">' +
      '<button data-timeout="pass" class="' + (T.onTimeout === 'pass' ? 'on' : '') + '"' + dis + '>パスする</button>' +
      '<button data-timeout="ai" class="' + (T.onTimeout === 'ai' ? 'on' : '') + '"' + dis + '>AIが代わりに打つ</button></div>';

    $('#ruleList').innerHTML = RULES.map(r => {
      if (r.type === 'jokers') {
        return '<div class="rule"><div class="rule-top"><span class="rule-name">' + r.name + '</span>' +
          '<div class="seg" role="group" aria-label="ジョーカーの枚数">' + [0, 1, 2].map(x => '<button data-jokers="' + x + '" class="' + (R.jokers === x ? 'on' : '') + '"' + dis + '>' + x + '枚</button>').join('') + '</div></div>' +
          '<span class="rule-desc">使うジョーカーの枚数</span></div>';
      }
      const on = r.k ? R[r.k] : true;
      const tgl = r.k ? '<button class="toggle ' + (on ? 'on' : '') + '" data-rule="' + r.k + '"' + dis + ' aria-pressed="' + on + '" aria-label="' + r.name + '">' + (on ? 'ON' : 'OFF') + '</button>' : '';
      const subs = r.subs ? '<div class="subs">' + r.subs.map(s => '<button class="toggle sub ' + (R[s.k] ? 'on' : '') + '" data-rule="' + s.k + '"' + (host && on ? '' : ' disabled') + ' aria-pressed="' + R[s.k] + '">' + s.name + '</button>').join('') + '</div>' : '';
      return '<div class="rule ' + (on ? '' : 'off') + '"><div class="rule-top"><span class="rule-name">' + r.name + '</span>' + tgl + '</div><span class="rule-desc">' + r.desc + '</span>' + subs + '</div>';
    }).join('');

    const open = L.seats.some(s => s.kind === 'open');
    const bs = $('#btnStart');
    bs.style.display = host ? '' : 'none';
    bs.disabled = open;
    $('#lbMsg').textContent = host ? (open ? '空いている席があります（AIを入れるか参加を待ってください）' : '') : 'ホストの開始を待っています…';
    $('#lbMsg').style.color = host ? '' : 'var(--muted)';
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.copy) {
      const u = b.dataset.copy;
      (navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(u) : Promise.reject()).then(
        () => toast('コピーしました'),
        () => {
          const ta = document.createElement('textarea');
          ta.value = u; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); toast('コピーしました'); } catch (x) { toast(u); }
          ta.remove();
        });
      return;
    }
    if (S.screen !== 'lobby' || !S.view) return;
    if (b.dataset.seat !== undefined) {
      send({ type: 'seat', index: +b.dataset.seat, kind: b.dataset.kind, level: +(b.dataset.level || 3) }).catch(() => {});
    } else if (b.dataset.rule) {
      const k = b.dataset.rule;
      updateSettings(s => { s.rules[k] = !s.rules[k]; });
    } else if (b.dataset.jokers !== undefined) {
      const x = +b.dataset.jokers;
      updateSettings(s => { s.rules.jokers = x; });
    } else if (b.dataset.timer) {
      updateSettings(s => { s.timer.enabled = !s.timer.enabled; });
    } else if (b.dataset.timeout) {
      const x = b.dataset.timeout;
      updateSettings(s => { s.timer.onTimeout = x; });
    }
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'selSec') {
      const x = +e.target.value;
      updateSettings(s => { s.timer.seconds = x; });
    }
  });
  $('#seatMinus').addEventListener('click', () => send({ type: 'seatCount', count: S.view.lobby.seats.length - 1 }).catch(() => {}));
  $('#seatPlus').addEventListener('click', () => send({ type: 'seatCount', count: S.view.lobby.seats.length + 1 }).catch(() => {}));
  $('#btnStart').addEventListener('click', () => send({ type: 'start' }).catch(() => {}));
  $('#lbLeave').addEventListener('click', () => {
    send({ type: 'leave' }).catch(() => {}).finally(() => leaveToTitle(''));
  });

  // ---------------------------------------------------------------- カード描画
  function cardCls(c) { return c.r === 16 ? 'jk' : (c.s === 'H' || c.s === 'D') ? 'red' : ''; }
  function cardHtml(c, extra, style) {
    return '<div class="card ' + cardCls(c) + ' ' + (extra || '') + '"' + (style ? ' style="' + style + '"' : '') + '>' +
      '<span class="rk">' + E.RANK_LABEL[c.r] + '</span><span class="st">' + E.SUIT_SYM[c.s] + '</span></div>';
  }
  function cardEl(c, extra) {
    const d = document.createElement('div');
    d.innerHTML = cardHtml(c, extra);
    return d.firstChild;
  }

  // ---------------------------------------------------------------- プレイ画面
  function resetGameDom() {
    S.fieldEls.forEach(el => el.remove());
    S.fieldEls.clear();
    S.handEls.forEach(el => el.remove());
    S.handEls.clear();
    S.sel.clear();
    S.csel.clear();
    S.picks = [];
    S.dlgKey = null;
    S.choiceKey = null;
    S.handPos = {};
    S.banners = [];
    clearTimeout(S.bannerTimer);
    S.bannerTimer = null;
    $('#banner').classList.remove('on');
    $('#fx').innerHTML = '';
    $('#dialog').classList.remove('on');
    $('#dialog').innerHTML = '';
    $('#choicePanel').classList.remove('on');
    endDrag();
  }

  function oppSeats(g) {
    const r = [];
    const base = g.mySeat >= 0 ? g.mySeat : -1;
    for (let k = 1; k < g.n + (base < 0 ? 1 : 0); k++) r.push(((base < 0 ? -1 : base) + k + g.n) % g.n);
    return r;
  }

  function myTurn(g) { return g.phase === 'play' && g.turn === g.mySeat && g.mySeat >= 0; }
  function choiceMode(g) {
    if (g.mySeat < 0) return null;
    if (g.phase === 'choice' && g.pending && g.pending.seat === g.mySeat && g.pending.type !== 'bomber') {
      return { kind: g.pending.type, max: g.pending.max, to: g.pending.to, exact: false };
    }
    if (g.phase === 'exchange' && g.exPending && g.exPending[g.mySeat]) {
      const p = g.exPending[g.mySeat];
      return { kind: 'exchange', max: p.count, to: p.to, exact: true };
    }
    return null;
  }

  function seatStatus(g, i) {
    const p = g.players[i];
    if (p.out) return p.ochi ? '都落ち' : p.foul ? '反則上がり' : p.place + '位';
    if (g.phase === 'choice' && g.pending && g.pending.seat === i) return { text: g.pending.type === 'bomber' ? '宣言中…' : '選択中…', blink: true };
    if (g.phase === 'exchange' && g.exPending && g.exPending[i]) return { text: '交換中…', blink: true };
    if (p.passed) return 'パス';
    return '';
  }

  function renderGame(v, prev) {
    const g = v.game;
    const prevG = prev && prev.screen === 'game' ? prev.game : null;
    $('#gCode').textContent = 'ROOM ' + v.code;
    const aiN = g.players.filter(p => p.kind === 'ai').length;
    $('#gCount').textContent = g.n + '人 / AI ' + aiN;

    // 場の状態
    const bindTxt = E.bindLabel(g.bind);
    const bB = $('#bBind');
    bB.textContent = bindTxt || '縛り';
    bB.className = 'badge' + (bindTxt ? ' on-bind' : '');
    $('#bRev').className = 'badge' + (g.revolution ? ' on-rev' : '');
    $('#bBack').className = 'badge' + (g.back ? ' on-back' : '');
    $('#bBind').style.display = (g.ctx.rules.suitBind || g.ctx.rules.numBind) ? '' : 'none';
    $('#bRev').style.display = g.ctx.rules.revolution ? '' : 'none';
    $('#bBack').style.display = g.ctx.rules.elevenBack ? '' : 'none';

    // 相手
    const seats = oppSeats(g);
    const lay = OPP_LAYOUT[seats.length] || OPP_LAYOUT[4];
    S.oppPos = {};
    $('#opps').innerHTML = seats.map((s, j) => {
      const p = g.players[s];
      const pos = lay[j];
      S.oppPos[s] = { x: pos[0], y: pos[1] };
      const st = seatStatus(g, s);
      const stText = typeof st === 'string' ? st : st.text;
      const blink = typeof st === 'object' && st.blink;
      const isTurn = g.phase === 'play' && g.turn === s;
      const n = p.count;
      const step = n > 1 ? Math.min(14, 168 / (n - 1)) : 0;
      let backs = '';
      for (let k = 0; k < n; k++) backs += '<div class="back" style="left:' + (k * step) + 'px"></div>';
      const bw = n ? 26 + (n - 1) * step : 0;
      const sub = p.proxy ? '<span class="opp-ttl">AI代打</span>' : '';
      const ttl = p.out && !p.ochi && !p.foul ? '<span class="opp-ttl gold">' + p.place + '位</span>' : '<span class="opp-ttl ' + (p.title === '大富豪' ? 'gold' : '') + '">' + esc(p.title || '') + '</span>';
      return '<div class="opp ' + (p.out ? 'out' : '') + '" style="left:' + pos[0] + 'px;top:' + pos[1] + 'px">' +
        '<div class="opp-head"><span class="opp-tag ' + (isTurn ? 'turn' : '') + '">' + esc(p.name) + '</span>' + ttl + sub + '</div>' +
        '<div class="opp-cards"><div class="backs" style="width:' + bw + 'px">' + backs + '</div><span class="cnt" aria-label="残り' + n + '枚">' + n + '</span></div>' +
        '<span class="opp-act ' + (blink ? 'blink' : '') + '">' + esc(p.out ? '' : stText) + '</span></div>';
    }).join('');

    renderField(g);
    renderPile(g);

    // 手札（演出のため、更新前の位置を保存）
    const oldPos = Object.assign({}, S.handPos);
    renderHand(g);

    // 自分
    const me = g.mySeat >= 0 ? g.players[g.mySeat] : null;
    if (me) {
      const st = seatStatus(g, g.mySeat);
      const stText = typeof st === 'string' ? st : st.text;
      $('#meInfo').innerHTML = '<span class="me-name ' + (myTurn(g) ? 'turn' : '') + '">あなた</span> ' + (me.title ? esc(me.title) + '・' : '') + me.count + '枚' +
        (stText ? '<br><span style="color:var(--accent)">' + esc(stText) + '</span>' : '') + (me.proxy ? '<br>AI代打' : '');
    }
    updateButtons();
    renderChoice(g);
    renderBomber(g);
    processEvents(g, prevG, oldPos);
  }

  function renderField(g) {
    const ids = new Set(g.field.map(f => f.id));
    S.fieldEls.forEach((el, id) => {
      if (!ids.has(id)) {
        S.fieldEls.delete(id);
        el.classList.add('gone');
        setTimeout(() => el.remove(), 420);
      }
    });
    const last = g.field.length ? g.field[g.field.length - 1].id : -1;
    g.field.forEach(f => {
      let el = S.fieldEls.get(f.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'play ' + (f.seat === g.mySeat ? 'in-up' : 'in-down');
        const o = PLAY_OFFS[f.id % PLAY_OFFS.length];
        el.style.transform = 'translate(' + o[0] + 'px,' + o[1] + 'px) rotate(' + o[2] + 'deg)';
        const n = f.cards.length;
        el.innerHTML = '<div class="fan">' + f.cards.map((c, k) => cardHtml(c, 'lg',
          'margin-left:' + (k === 0 ? 0 : -40) + 'px;transform:rotate(' + ((k - (n - 1) / 2) * 9) + 'deg)')).join('') + '</div>';
        $('#field').appendChild(el);
        S.fieldEls.set(f.id, el);
      }
      el.classList.toggle('old', f.id !== last);
    });
    let nameEl = $('#field .play-name');
    if (!nameEl) { nameEl = document.createElement('div'); nameEl.className = 'play-name'; $('#field').appendChild(nameEl); }
    const lp = g.field.length ? g.field[g.field.length - 1].seat : -1;
    nameEl.textContent = lp >= 0 ? (lp === g.mySeat ? 'あなた' : g.players[lp].name) : '';
  }

  function renderPile(g) {
    const rots = [-14, 6, 18];
    const key = g.pileTop.map(c => c.id).join(',');
    const el = $('#pileCards');
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.innerHTML = g.pileTop.map((c, i) =>
      '<div style="position:absolute;left:' + (14 + i * 26) + 'px;top:0;transform:rotate(' + rots[i] + 'deg)">' +
      cardHtml(c, 'xs', 'animation:pileIn 0.25s steps(4) both') + '</div>').join('');
  }

  function handLayout(n) {
    const step = n > 1 ? Math.min(72, (HAND_W - 66) / (n - 1)) : 0;
    return i => i * step;
  }

  // 自分の番に出せる手（ビューごとにキャッシュ）
  function turnMoves(g) {
    if (!myTurn(g) || choiceMode(g)) return null;
    if (S.movesFor !== g) {
      S.movesFor = g;
      S.moves = E.legalMovesCtx(g.ctx, g.hand).map(m => new Set(m.ids));
    }
    return S.moves;
  }
  function fitsMove(moves, ids) { return moves.some(m => ids.every(id => m.has(id))); }

  // カードを選択に加える。今の選択と一緒に出せないなら、出せる組み合わせだけ残して入れ替える
  function selectPlayable(g, id) {
    const moves = turnMoves(g);
    if (!moves) { S.sel.add(id); return true; }
    const withC = moves.filter(m => m.has(id));
    if (!withC.length) return false;
    const order = Array.from(S.sel);
    let best = [], bs = -1;
    for (const m of withC) {
      const keep = order.filter(x => m.has(x));
      const sc = keep.length * 1000 + keep.reduce((a, x) => a + order.indexOf(x), 0);
      if (sc > bs) { bs = sc; best = keep; }
    }
    S.sel = new Set(best.concat([id]));
    // 他に選びようがないカードは同時に選択する（例：ジョーカーなしで2枚出しのペア）
    const cur = Array.from(S.sel);
    const done = moves.some(m => m.size === cur.length && cur.every(x => m.has(x)));
    if (!done) {
      const cands = moves.filter(m => cur.every(x => m.has(x)));
      if (cands.length) {
        const forced = Array.from(cands[0]).filter(x => !S.sel.has(x) && cands.every(m => m.has(x)));
        if (forced.length) {
          forced.forEach(x => S.sel.add(x));
          S.groups.push(new Set([id].concat(forced)));
        }
      }
    }
    return true;
  }

  function renderHand(g) {
    const hand = g.hand;
    const ids = new Set(hand.map(c => c.id));
    for (const id of Array.from(S.sel)) if (!ids.has(id)) S.sel.delete(id);
    for (const id of Array.from(S.csel)) if (!ids.has(id)) S.csel.delete(id);
    S.handEls.forEach((el, id) => { if (!ids.has(id)) { el.remove(); S.handEls.delete(id); } });
    const cm = choiceMode(g);
    const lx = handLayout(hand.length);
    const dragging = S.ptr && S.ptr.active;
    const moves = turnMoves(g);
    if (moves && S.sel.size && !fitsMove(moves, Array.from(S.sel))) S.sel.clear();
    const selArr = Array.from(S.sel);
    S.groups = S.groups.filter(gr => Array.from(gr).every(x => S.sel.has(x)));
    S.handPos = {};
    hand.forEach((c, i) => {
      let el = S.handEls.get(c.id);
      if (!el) {
        el = cardEl(c, '');
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.setAttribute('aria-label', E.cardLabel(c));
        el.dataset.id = c.id;
        el.style.left = lx(i) + 'px';
        el.style.top = '18px';
        $('#hand').appendChild(el);
        S.handEls.set(c.id, el);
      }
      const on = cm ? S.csel.has(c.id) : S.sel.has(c.id);
      el.classList.toggle('sel', on && !cm);
      el.classList.toggle('pick', on && !!cm);
      el.classList.toggle('ghosted', !!(dragging && on && !cm));
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
      let playable = true, hint = false, dim = false;
      if (moves) {
        playable = moves.some(m => m.has(c.id));
        if (!playable) dim = true;
        else if (!on && selArr.length) {
          hint = moves.some(m => m.has(c.id) && selArr.every(x => m.has(x)));
          dim = !hint;
        }
      }
      el.classList.toggle('dim', dim);
      el.classList.toggle('nogo', !playable);
      el.classList.toggle('hint', hint);
      el.setAttribute('aria-disabled', playable ? 'false' : 'true');
      const x = lx(i), y = on ? 0 : hint ? 8 : 18;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.zIndex = i + 1;
      S.handPos[c.id] = { x: HAND_X + x, y: HAND_Y + y };
    });
  }

  function refreshHand() { if (S.view && S.view.game) { renderHand(S.view.game); updateButtons(); renderChoice(S.view.game); } }

  function selValid(g) {
    if (!S.sel.size) return false;
    return E.validatePlay(g.ctx, g.hand, Array.from(S.sel)).ok;
  }

  function updateButtons() {
    const g = S.view && S.view.game;
    if (!g) return;
    const mt = myTurn(g);
    $('#btnPlay').disabled = !(mt && selValid(g));
    $('#btnPass').disabled = !(mt && g.ctx.field);
    $('#hand').classList.toggle('locked', g.mySeat < 0);
  }

  function tryPlay() {
    const g = S.view && S.view.game;
    if (!g || !myTurn(g)) return false;
    const ids = Array.from(S.sel);
    if (!E.validatePlay(g.ctx, g.hand, ids).ok) {
      const f = $('#felt');
      f.classList.remove('bad'); void f.offsetWidth; f.classList.add('bad');
      return false;
    }
    S.sel.clear();
    send({ type: 'play', cards: ids }).catch(() => {});
    return true;
  }
  $('#btnPlay').addEventListener('click', tryPlay);
  $('#btnPass').addEventListener('click', () => {
    const g = S.view && S.view.game;
    if (!g || !myTurn(g)) return;
    S.sel.clear();
    send({ type: 'pass' }).catch(() => {});
  });

  function toggleCard(id) {
    const g = S.view && S.view.game;
    if (!g || g.mySeat < 0) return;
    const cm = choiceMode(g);
    if (cm) {
      if (S.csel.has(id)) S.csel.delete(id);
      else {
        if (S.csel.size >= cm.max) {
          if (cm.max === 1) S.csel.clear(); else return;
        }
        S.csel.add(id);
      }
    } else {
      if (S.sel.has(id)) {
        // 同時に選択されたカードはまとめて解除
        const gr = S.groups.find(x => x.has(id));
        if (gr) { gr.forEach(x => S.sel.delete(x)); S.groups = S.groups.filter(x => x !== gr); }
        else S.sel.delete(id);
      } else if (!selectPlayable(g, id)) return;
    }
    refreshHand();
  }

  // ---------------- ドラッグ＆ドロップ
  const handEl = $('#hand');
  handEl.addEventListener('pointerdown', e => {
    const el = e.target.closest('.card');
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const p = stagePt(e);
    S.ptr = { id: el.dataset.id, x: p.x, y: p.y, active: false, over: false };
  });
  handEl.addEventListener('keydown', e => {
    const el = e.target.closest('.card');
    if (!el) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(el.dataset.id); }
  });
  function inFelt(p) { return p.x >= FELT.x && p.x <= FELT.x + FELT.w && p.y >= FELT.y && p.y <= FELT.y + FELT.h; }
  window.addEventListener('pointermove', e => {
    const d = S.ptr;
    if (!d) return;
    const p = stagePt(e);
    if (!d.active) {
      if (Math.hypot(p.x - d.x, p.y - d.y) < 7) return;
      const g = S.view && S.view.game;
      if (!g || !myTurn(g)) return;
      if (!S.sel.has(d.id) && !selectPlayable(g, d.id)) { S.ptr = null; return; }
      d.active = true;
      buildGhost(g);
      refreshHand();
    }
    const gh = $('#ghost');
    gh.style.left = p.x + 'px';
    gh.style.top = p.y + 'px';
    d.over = inFelt(p);
    $('#felt').classList.toggle('over', d.over);
  });
  window.addEventListener('pointerup', () => {
    const d = S.ptr;
    if (!d) return;
    if (d.active) {
      const over = d.over;
      endDrag();
      if (over) tryPlay();
      refreshHand();
    } else {
      S.ptr = null;
      toggleCard(d.id);
    }
  });
  window.addEventListener('pointercancel', () => { endDrag(); refreshHand(); });
  function endDrag() {
    S.ptr = null;
    $('#ghost').classList.remove('on');
    $('#felt').classList.remove('over');
  }
  function buildGhost(g) {
    const cards = g.hand.filter(c => S.sel.has(c.id));
    const n = cards.length;
    const gh = $('#ghost');
    gh.innerHTML = cards.map((c, k) => cardHtml(c, 'lg', 'margin-left:' + (k === 0 ? 0 : -40) + 'px;transform:rotate(' + ((k - (n - 1) / 2) * 9) + 'deg)')).join('');
    gh.classList.add('on');
  }

  // ---------------- 7渡し・10捨て・カード交換
  function renderChoice(g) {
    const cp = $('#choicePanel');
    const cm = choiceMode(g);
    if (!cm) {
      cp.classList.remove('on');
      S.choiceKey = null;
      S.csel.clear();
      return;
    }
    const key = cm.kind + ':' + g.phase + ':' + (g.pending ? g.pending.max : cm.max) + ':' + g.field.length + ':' + g.pileCount;
    if (S.choiceKey !== key) {
      if (S.choiceKey !== null) S.csel.clear();
      S.choiceKey = key;
      cp.classList.remove('on'); void cp.offsetWidth;
    }
    const k = S.csel.size;
    const toName = cm.to >= 0 && g.players[cm.to] ? esc(g.players[cm.to].name) : '';
    const R = g.ctx.rules;
    const sfb = R.specialFinishBan && ((cm.kind === 'give7' && R.sfbSeven) || (cm.kind === 'discard10' && R.sfbTen));
    const blocked = sfb && k > 0 && k === g.hand.length;
    let title, text, btns;
    if (cm.kind === 'exchange') {
      title = 'カード交換';
      text = toName + ' に渡すカードを <span style="color:var(--accent)">' + cm.max + '枚</span> 選んでください';
      btns = '<button class="btn primary" id="cpOk"' + (k === cm.max ? '' : ' disabled') + '>渡す ' + k + '/' + cm.max + '</button>';
    } else if (cm.kind === 'give7') {
      title = '7渡し';
      text = toName + ' に渡すカードを選んでください（' + cm.max + '枚まで）' + (blocked ? '<br><span class="muted">特殊上がり禁止：手札をすべて渡すことはできません</span>' : '');
      btns = '<button class="btn" id="cpNone">渡さない</button><button class="btn primary" id="cpOk"' + (k > 0 && !blocked ? '' : ' disabled') + '>渡す ' + k + '/' + cm.max + '</button>';
    } else {
      title = '10捨て';
      text = '捨てるカードを選んでください（' + cm.max + '枚まで）' + (blocked ? '<br><span class="muted">特殊上がり禁止：手札をすべて捨てることはできません</span>' : '');
      btns = '<button class="btn" id="cpNone">捨てない</button><button class="btn primary" id="cpOk"' + (k > 0 && !blocked ? '' : ' disabled') + '>捨てる ' + k + '/' + cm.max + '</button>';
    }
    cp.innerHTML = '<span class="cp-title">' + title + '</span><span class="cp-text">' + text + '</span><div class="cp-btns">' + btns + '</div>';
    cp.classList.add('on');
  }
  $('#choicePanel').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.id === 'cpOk') {
      const ids = Array.from(S.csel);
      S.csel.clear();
      send({ type: 'choose', cards: ids }).catch(() => {});
    } else if (b.id === 'cpNone') {
      S.csel.clear();
      send({ type: 'choose', cards: [] }).catch(() => {});
    }
  });

  // ---------------- クイーンボンバー宣言
  function renderBomber(g) {
    const dlg = $('#dialog');
    const mine = g.phase === 'choice' && g.pending && g.pending.type === 'bomber' && g.pending.seat === g.mySeat;
    if (!mine) {
      dlg.classList.remove('on');
      dlg.innerHTML = '';
      S.dlgKey = null;
      return;
    }
    const key = 'b:' + g.field.length + ':' + g.pileCount;
    if (S.dlgKey !== key) { S.dlgKey = key; S.picks = []; }
    drawBomber(g);
  }
  function drawBomber(g) {
    const dlg = $('#dialog');
    const pd = g.pending;
    const R = g.ctx.rules;
    const max = pd.max;
    const lastPlay = g.field.length ? g.field[g.field.length - 1] : null;
    const qs = lastPlay && lastPlay.seat === g.mySeat ? lastPlay.cards : [];
    const ranks = E.bomberRankList(R);
    const sfb = R.specialFinishBan && R.sfbBomber;
    const grid = ranks.map(r => {
      const on = S.picks.indexOf(r) >= 0;
      const ok = E.bomberSelectable(R, g.hand, S.picks, max, r);
      const banned = !on && !ok && S.picks.length < max;
      return '<button class="rank-btn ' + (r === 16 ? 'jk ' : '') + (on ? 'on' : '') + '" data-rank="' + r + '"' + (ok ? '' : ' disabled') + ' aria-pressed="' + on + '">' +
        '<span>' + E.RANK_LABEL[r] + '</span><span class="note">' + (banned ? '上がり不可' : '') + '</span></button>';
    }).join('');
    const k = S.picks.length;
    const okBtn = R.bomberMustFull ? k === max : true;
    dlg.innerHTML = '<div class="dlg-shade"></div><div class="dlg" role="dialog" aria-label="クイーンボンバー">' +
      '<div class="dlg-head"><span class="dlg-title">クイーンボンバー</span><span class="muted" id="dlgTime"></span></div>' +
      '<div class="dlg-mid"><div class="mini-row">' + qs.map(c => cardHtml(c, 'sm')).join('') + '</div>' +
      '<span class="dlg-text">Qを' + max + '枚出しました。<br>全員に捨てさせる数字を <em>' + max + 'つ' + (R.bomberMustFull ? '' : 'まで') + '</em> 選べます。</span>' +
      '<div class="my-mini"><span class="muted" style="font-size:13px">あなたの残り手札</span><div class="mini-row">' +
      g.hand.map(c => cardHtml(c, 'sm' + (S.picks.indexOf(c.r) >= 0 ? ' mark' : ''))).join('') + '</div></div></div>' +
      '<div class="rank-grid">' + grid + '</div>' +
      '<div class="dlg-foot"><span class="note">' + (sfb ? '特殊上がり禁止：自分の手札がなくなる組み合わせは選べません' : '') + '</span>' +
      '<div class="cp-btns">' + (R.bomberMustFull ? '' : '<button class="btn" id="bmNone">宣言しない</button>') +
      '<button class="btn primary" id="bmOk"' + (okBtn ? '' : ' disabled') + '>決定 ' + k + '/' + max + '</button></div></div></div>';
    dlg.classList.add('on');
  }
  $('#dialog').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const g = S.view && S.view.game;
    if (!g) return;
    if (b.dataset.rank) {
      const r = +b.dataset.rank;
      const i = S.picks.indexOf(r);
      if (i >= 0) S.picks.splice(i, 1);
      else if (S.picks.length < g.pending.max) S.picks.push(r);
      drawBomber(g);
    } else if (b.id === 'bmOk') {
      const ranks = S.picks.slice();
      send({ type: 'declare', ranks }).catch(() => {});
    } else if (b.id === 'bmNone') {
      send({ type: 'declare', ranks: [] }).catch(() => {});
    }
  });

  // ---------------- 演出
  function nameOf(g, seat) {
    if (seat === g.mySeat) return 'あなた';
    return g.players[seat] ? g.players[seat].name : '';
  }
  // 帯を長めに表示するルール（ミリ秒）
  const BANNER_HOLD = { 'クイーンボンバー': 3000 };
  function queueBanner(rule, player, chips) {
    S.banners.push({ rule, player, chips: chips || [] });
    if (!S.bannerTimer) nextBanner();
  }
  function nextBanner() {
    const el = $('#banner');
    const b = S.banners.shift();
    if (!b) { el.classList.remove('on'); S.bannerTimer = null; return; }
    el.classList.remove('on'); void el.offsetWidth;
    el.innerHTML = '<div class="bn-row"><span class="bn-rule">' + esc(b.rule) + '</span>' +
      b.chips.map(c => '<span class="bn-chip">' + esc(c) + '</span>').join('') + '</div><span class="bn-player">' + esc(b.player) + '</span>';
    el.classList.add('on');
    const hold = BANNER_HOLD[b.rule] || (S.banners.length ? 650 : (b.chips.length ? 1700 : 1150));
    S.bannerTimer = setTimeout(nextBanner, hold);
  }

  function seatPoint(g, seat, i) {
    if (seat === g.mySeat) return { x: HAND_X + 300 + i * 30, y: HAND_Y + 10 };
    const p = S.oppPos[seat] || { x: 600, y: 120 };
    return { x: p.x + 46 * i, y: p.y };
  }

  function flyEl(el, from, to, delay, opts) {
    opts = opts || {};
    el.classList.add('fly');
    if (opts.pop) el.classList.add('pop');
    el.style.left = from.x + 'px';
    el.style.top = from.y + 'px';
    $('#fx').appendChild(el);
    setTimeout(() => {
      el.classList.remove('pop');
      void el.offsetWidth;
      el.style.transform = 'translate(' + (to.x - from.x) + 'px,' + (to.y - from.y) + 'px) scale(' + (opts.scale || 0.5) + ')';
      el.style.opacity = '0';
    }, delay || 30);
    setTimeout(() => el.remove(), (delay || 30) + 620);
  }
  function backEl() {
    const d = document.createElement('div');
    d.className = 'back';
    return d;
  }

  function processEvents(g, prevG, oldPos) {
    const evs = g.events || [];
    for (const e of evs) {
      if (e.t === 'effect') {
        queueBanner(e.rule, nameOf(g, e.seat), e.chips);
      } else if (e.t === 'finish') {
        queueBanner('上がり', nameOf(g, e.seat), []);
      } else if (e.t === 'bomber') {
        Object.keys(e.losses).forEach(k => {
          const s = +k;
          const cards = e.losses[k];
          cards.forEach((c, i) => {
            if (s === g.mySeat && oldPos[c.id]) {
              const el = cardEl(c, 'mark');
              flyEl(el, oldPos[c.id], PILE_PT, 850);
            } else {
              const p = seatPoint(g, s, i);
              const el = cardEl(c, 'sm mark');
              flyEl(el, { x: p.x, y: p.y - 66 }, PILE_PT, 850, { pop: true });
            }
          });
        });
      } else if (e.t === 'discard') {
        e.cards.forEach((c, i) => {
          const from = e.seat === g.mySeat && oldPos[c.id] ? oldPos[c.id] : seatPoint(g, e.seat, i);
          flyEl(cardEl(c, e.seat === g.mySeat ? '' : 'sm'), from, PILE_PT, 200, { pop: e.seat !== g.mySeat });
        });
      } else if (e.t === 'give' || e.t === 'exchange') {
        const n = e.cards ? e.cards.length : e.count;
        for (let i = 0; i < n; i++) {
          const c = e.cards ? e.cards[i] : null;
          const from = e.from === g.mySeat && c && oldPos[c.id] ? oldPos[c.id] : seatPoint(g, e.from, i);
          const to = seatPoint(g, e.to, i);
          const el = c && (e.from === g.mySeat || e.to === g.mySeat) ? cardEl(c, 'sm') : backEl();
          flyEl(el, from, to, 150 + i * 60, { scale: 0.9 });
        }
      }
    }
  }

  // ---------------- タイマー表示
  function awaitedSeat(g) {
    if (g.phase === 'play') return g.turn;
    if (g.phase === 'choice' && g.pending) return g.pending.seat;
    if (g.phase === 'exchange' && g.exPending) {
      if (g.exPending[g.mySeat]) return g.mySeat;
      const ks = Object.keys(g.exPending);
      return ks.length ? +ks[0] : -1;
    }
    return -1;
  }
  function tick() {
    requestAnimationFrame(tick);
    const v = S.view;
    if (!v || v.screen !== 'game' || !v.game) return;
    const g = v.game;
    const seat = awaitedSeat(g);
    const dl = seat >= 0 ? g.deadlines[seat] : null;
    const fill = $('#timerFill');
    let secTxt = '';
    if (dl) {
      const rem = Math.max(0, dl.at - now());
      const frac = Math.min(1, rem / dl.total);
      fill.style.width = (frac * 100) + '%';
      secTxt = String(Math.ceil(rem / 1000));
    } else {
      fill.style.width = '0%';
    }
    fill.classList.toggle('mine', seat === g.mySeat);
    let info = '';
    if (g.phase === 'play') {
      info = g.turn === g.mySeat ? 'あなたの番' : esc(nameOf(g, g.turn)) + 'の番';
    } else if (g.phase === 'choice' && g.pending) {
      info = g.pending.seat === g.mySeat ? 'あなたの番' : esc(nameOf(g, g.pending.seat)) + 'の番';
    } else if (g.phase === 'exchange') {
      info = 'カード交換';
    } else if (g.phase === 'end') {
      info = 'ゲーム終了';
    }
    const html = info + (secTxt && seat === g.mySeat ? ' <span class="sec">' + secTxt + '</span>' : '');
    const ti = $('#turnInfo');
    if (ti.innerHTML !== html) ti.innerHTML = html;
    const dt = $('#dlgTime');
    if (dt) dt.textContent = secTxt ? '残り ' + secTxt + '秒' : '';
  }
  requestAnimationFrame(tick);

  // ---------------------------------------------------------------- リザルト
  function renderResult(v) {
    const r = v.result;
    $('#resultRows').innerHTML = r.rows.map((row, i) => {
      const note = row.ochi ? '都落ち' : row.foul ? '反則上がり' : '';
      const isMe = row.seat === v.resultSeat;
      return '<div class="res-row ' + (isMe ? 'me' : '') + '" style="animation-delay:' + (i * 0.08) + 's">' +
        '<span class="res-place">' + row.place + '位</span>' +
        '<span class="res-name">' + esc(row.name) + (isMe ? ' <span class="res-note">（あなた）</span>' : '') + (note ? ' <span class="res-note">' + note + '</span>' : '') + '</span>' +
        '<span class="res-note">次の階級</span><span class="res-title ' + (row.place === 1 ? 'top' : '') + '">' + esc(row.title) + '</span></div>';
    }).join('');
    $('#resultFoot').innerHTML = v.me.isHost
      ? '<button class="btn primary big" id="rsAgain">もう一回</button><button class="btn big" id="rsEnd">終了</button>'
      : '<span class="muted">ホストの選択を待っています…</span><button class="btn small" id="rsLeave">退出</button>';
  }
  $('#scr-result').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.id === 'rsAgain') send({ type: 'again' }).catch(() => {});
    else if (b.id === 'rsEnd') send({ type: 'end' }).catch(() => {});
    else if (b.id === 'rsLeave') send({ type: 'leave' }).catch(() => {}).finally(() => leaveToTitle(''));
  });

  // ---------------------------------------------------------------- 起動
  (async function boot() {
    const q = new URLSearchParams(location.search);
    const code = (q.get('room') || '').toUpperCase();
    if (code) {
      inCode.value = code;
      let token = null;
      try { token = localStorage.getItem(storeKey(code)); } catch (e) { /* */ }
      if (token) {
        try {
          const r = await api('/api/join', { code, name: myName(), token });
          connect(r.code, r.token);
          return;
        } catch (e) {
          try { localStorage.removeItem(storeKey(code)); } catch (x) { /* */ }
        }
      }
    }
    show('title');
    inName.focus();
  })();
})();
