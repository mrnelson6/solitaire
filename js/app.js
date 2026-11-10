import {
  VARIANTS, RANKS, SUITS, isRed, defaultOptions, optionLabel, statKey,
  newGame, restoreGame, encodePiles, decodePiles,
  canPickUp, canMove, applyMove, dealStock, bestDestination,
  autoMoveOne, canAutoFinish, findHint, isWon, foundationCount,
} from './games.js';

const $ = (sel) => document.querySelector(sel);

// ---------- Storage ----------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('solitaire:' + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('solitaire:' + key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
};

const DEFAULT_SETTINGS = {
  autoFoundation: true,
  tapToMove: true,
  haptics: true,
  theme: 'auto',
  felt: 'green',
  back: 'blue',
  opts: Object.fromEntries(Object.keys(VARIANTS).map((v) => [v, defaultOptions(v)])),
};
const saved = store.get('settings', {});
const settings = { ...DEFAULT_SETTINGS, ...saved, opts: { ...DEFAULT_SETTINGS.opts, ...saved.opts } };

function saveSettings() { store.set('settings', settings); }

// ---------- Helpers ----------

function formatTime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function vibrate(pattern) {
  if (settings.haptics && navigator.vibrate) navigator.vibrate(pattern);
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function confirmAction(message, okLabel = 'Continue') {
  const dialog = $('#confirm-dialog');
  $('#confirm-text').textContent = message;
  $('#confirm-ok').textContent = okLabel;
  dialog.showModal();
  return new Promise((resolve) => {
    const done = (result) => {
      dialog.close();
      $('#confirm-ok').onclick = $('#confirm-cancel').onclick = null;
      resolve(result);
    };
    $('#confirm-ok').onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    dialog.oncancel = () => done(false);
  });
}

const svgNS = 'http://www.w3.org/2000/svg';
function suitIcon(s, cls) {
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svgNS, 'use');
  use.setAttribute('href', '#suit-' + SUITS[s]);
  svg.appendChild(use);
  return svg;
}

const SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANK_NAMES = ['', 'Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King'];

// ---------- Game state ----------

let game = null;      // see games.js, plus: elapsed, completed, history
let runningSince = 0; // timestamp when the timer last started, 0 when stopped
let paused = false;
let autoTimer = 0;
let finishing = false;

function elapsed() {
  return game.elapsed + (runningSince ? Date.now() - runningSince : 0);
}

function startTimer() {
  if (runningSince || !game || game.completed || paused) return;
  runningSince = Date.now();
}

function stopTimer() {
  if (!runningSince) return;
  game.elapsed += Date.now() - runningSince;
  runningSince = 0;
}

function saveGame() {
  if (!game) return;
  store.set('current', {
    variant: game.variant,
    opts: game.opts,
    seed: game.seed,
    piles: encodePiles(game),
    moves: game.moves,
    elapsed: elapsed(),
    completed: game.completed,
    started: game.started,
    history: game.history.slice(-300),
  });
}

function loadSaved() {
  const s = store.get('current', null);
  if (!s || !VARIANTS[s.variant]) return null;
  try {
    const g = restoreGame(s);
    return { ...g, elapsed: s.elapsed || 0, completed: !!s.completed, started: !!s.started, history: s.history || [] };
  } catch { return null; }
}

function pushHistory() {
  game.history.push({ p: encodePiles(game), m: game.moves });
  if (game.history.length > 300) game.history.shift();
}

// ---------- Table layout ----------

const table = $('#table');
let cardEls = [];   // by card id
let slotEls = [];   // by pile index
let layout = null;
let where = [];     // by card id: { pi, ci, x, y }
let pileRects = []; // by pile index: area covered by the pile and its cards

function buildTable() {
  table.replaceChildren();
  table.classList.remove('celebrate');
  slotEls = game.piles.map((p, pi) => {
    const el = document.createElement('div');
    el.className = 'slot ' + p.kind;
    el.dataset.pile = pi;
    if (p.kind === 'stock') {
      el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
    } else if (p.kind === 'foundation' && game.variant !== 'spider') {
      el.textContent = 'A';
    }
    table.appendChild(el);
    return el;
  });
  cardEls = game.deck.map((d, id) => {
    const el = document.createElement('div');
    el.className = 'pc down' + (isRed(d.s) ? ' red' : '');
    el.dataset.id = id;
    const inner = document.createElement('div');
    inner.className = 'in';
    const rank = document.createElement('span');
    rank.className = 'rank' + (d.r === 10 ? ' ten' : '');
    rank.textContent = RANKS[d.r];
    inner.append(rank, suitIcon(d.s, 'sm'));
    if (d.r > 10) {
      const letter = document.createElement('span');
      letter.className = 'face-letter';
      letter.textContent = RANKS[d.r];
      inner.appendChild(letter);
    }
    inner.appendChild(suitIcon(d.s, 'lg'));
    el.appendChild(inner);
    table.appendChild(el);
    return el;
  });
  where = [];
}

function computeLayout() {
  const W = table.clientWidth;
  const H = table.clientHeight;
  const cols = VARIANTS[game.variant].cols;
  const gap = Math.max(3, Math.min(12, W * 0.013));
  let cw = (W - gap * (cols + 1)) / cols;
  cw = Math.max(20, Math.min(cw, 120, (H - gap * 3) / 1.4 / 3.8));
  const ch = cw * 1.4;
  const left = (W - (cols * cw + (cols - 1) * gap)) / 2;
  const font = Math.max(10, cw * 0.32);
  layout = {
    W, H, gap, cw, ch, left, font,
    top: gap,
    tabTop: gap + ch + Math.max(gap * 1.5, 8),
    colX: (c) => left + c * (cw + gap),
  };
  table.style.setProperty('--cw', cw + 'px');
  table.style.setProperty('--ch', ch + 'px');
  table.style.setProperty('--cr', Math.max(3, cw * 0.09) + 'px');
  table.style.setProperty('--cf', font + 'px');
}

// Works out where every card sits.
function placeCards() {
  const L = layout;
  const out = [];
  pileRects = [];
  game.piles.forEach((p, pi) => {
    const x0 = L.colX(p.col);
    const y0 = p.row === 0 ? L.top : L.tabTop;
    const n = p.cards.length;
    let rect = { x: x0, y: y0, w: L.cw, h: L.ch };

    if (p.kind === 'tableau') {
      const nDown = p.cards.filter((c) => !c.up).length;
      const nUp = n - nDown;
      const minUp = L.font * 1.1 + 2;
      let dDown = L.ch * 0.11;
      let dUp = Math.max(L.ch * 0.27, minUp);
      const avail = L.H - y0 - L.ch - L.gap;
      const need = nDown * dDown + Math.max(0, nUp - 1) * dUp;
      if (need > avail && n > 1) {
        dDown = Math.max(L.ch * 0.05, dDown * Math.min(1, avail / need));
        if (nUp > 1) dUp = Math.max(minUp * 0.9, Math.min(dUp, (avail - nDown * dDown) / (nUp - 1)));
      }
      let y = y0;
      p.cards.forEach((c, ci) => {
        out[c.id] = { pi, ci, x: x0, y, z: 10 + ci };
        y += c.up ? dUp : dDown;
      });
      if (n) rect.h = out[p.cards[n - 1].id].y - y0 + L.ch;
      rect.h = Math.max(rect.h, L.H - y0); // the whole column is a drop target
    } else if (p.kind === 'waste') {
      const fan = game.opts.draw === 3 ? 3 : 1;
      const shown = Math.min(fan, n);
      p.cards.forEach((c, ci) => {
        const k = Math.max(0, ci - (n - shown));
        out[c.id] = { pi, ci, x: x0 + k * L.cw * 0.3, y: y0, z: 10 + ci };
      });
      rect.w = L.cw * (1 + 0.3 * Math.max(0, shown - 1));
    } else if (p.kind === 'stock' && game.variant === 'spider') {
      const groups = Math.ceil(n / 10);
      p.cards.forEach((c, ci) => {
        const g = Math.floor(ci / 10);
        out[c.id] = { pi, ci, x: x0 - (groups - 1 - g) * L.cw * 0.18, y: y0, z: 10 + ci };
      });
    } else {
      p.cards.forEach((c, ci) => { out[c.id] = { pi, ci, x: x0, y: y0, z: 10 + ci }; });
    }
    slotEls[pi].style.transform = `translate(${x0}px, ${y0}px)`;
    pileRects[pi] = rect;
  });
  return out;
}

const liftTimers = new Map();
const liftNext = new Set(); // card ids to keep on top during the next render's animation

function render() {
  if (!game) return;
  computeLayout();
  const next = placeCards();
  let lift = 0;
  game.piles.forEach((p) => p.cards.forEach((c) => {
    const el = cardEls[c.id];
    const pos = next[c.id];
    const prev = where[c.id];
    el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    const wasDown = el.classList.contains('down');
    el.classList.toggle('down', !c.up);
    if (wasDown && c.up && prev) {
      el.classList.remove('flip');
      void el.offsetWidth; // restart the animation
      el.classList.add('flip');
    }
    // Cards changing pile (or snapping back) fly above everything else until they land.
    if ((prev && prev.pi !== pos.pi) || liftNext.has(c.id)) {
      el.style.zIndex = 1000 + lift++;
      clearTimeout(liftTimers.get(el));
      liftTimers.set(el, setTimeout(() => {
        liftTimers.delete(el);
        el.style.zIndex = where[c.id]?.z ?? pos.z;
      }, 260));
    } else if (!liftTimers.has(el)) {
      el.style.zIndex = pos.z;
    }
    el.setAttribute('aria-label', c.up ? `${RANK_NAMES[c.r]} of ${SUIT_NAMES[c.s]}` : 'Face-down card');
  }));
  where = next;
  liftNext.clear();
  updateChrome();
}

// Cards fly from the stock (or the top left) to their places on a new deal.
function dealAnimation() {
  const L = layout;
  const stockIdx = game.piles.findIndex((p) => p.kind === 'stock');
  const sx = stockIdx >= 0 ? L.colX(game.piles[stockIdx].col) : L.W / 2 - L.cw / 2;
  const sy = stockIdx >= 0 ? L.top : -L.ch * 1.5;
  const order = [];
  game.piles.forEach((p) => p.cards.forEach((c) => order.push(c.id)));
  order.forEach((id) => {
    const el = cardEls[id];
    el.classList.add('instant');
    el.style.transform = `translate(${sx}px, ${sy}px)`;
  });
  void table.offsetWidth;
  const tableauCards = new Set();
  game.piles.forEach((p) => { if (p.kind === 'tableau') p.cards.forEach((c) => tableauCards.add(c.id)); });
  let k = 0;
  order.forEach((id) => {
    const el = cardEls[id];
    el.classList.remove('instant');
    if (tableauCards.has(id)) el.style.transitionDelay = `${Math.min(k++ * 14, 900)}ms`;
    el.style.transform = `translate(${where[id].x}px, ${where[id].y}px)`;
  });
  setTimeout(() => cardEls.forEach((el) => { el.style.transitionDelay = ''; }), 1300);
}

function updateChrome() {
  $('#game-sub').textContent = [optionLabel(game.variant, game.opts), `${game.moves} move${game.moves === 1 ? '' : 's'}`]
    .filter(Boolean).join(' · ');
  $('#undo-btn').disabled = !game.history.length || game.completed;
  $('#hint-btn').disabled = game.completed;
  $('#finish-btn').hidden = finishing || game.completed || !canAutoFinish(game);
  const stockIdx = game.piles.findIndex((p) => p.kind === 'stock');
  if (stockIdx >= 0) {
    const empty = !game.piles[stockIdx].cards.length;
    const canRecycle = game.variant === 'klondike' && game.piles[1].cards.length > 0;
    slotEls[stockIdx].querySelector('svg').style.visibility = empty && canRecycle ? 'visible' : 'hidden';
  }
}

// ---------- Moves ----------

function afterChange({ auto = true } = {}) {
  render();
  saveGame();
  if (checkWin()) return;
  if (auto) scheduleAuto();
}

function doMove(from, ci, to) {
  if (!canMove(game, from, ci, to)) return false;
  startTimer();
  pushHistory();
  const runs = applyMove(game, from, ci, to);
  game.moves++;
  game.started = true;
  vibrate(runs ? [20, 40, 20] : 8);
  afterChange();
  return true;
}

function tapStock() {
  if (!game || game.completed || paused) return;
  const before = encodePiles(game);
  const moves = game.moves;
  const res = dealStock(game);
  if (!res.ok) {
    if (res.reason) toast(res.reason);
    return;
  }
  startTimer();
  game.history.push({ p: before, m: moves });
  game.moves++;
  game.started = true;
  vibrate(res.runs ? [20, 40, 20] : 6);
  afterChange();
}

function scheduleAuto(delay = 170) {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(autoStep, delay);
}

function stopAuto() {
  clearTimeout(autoTimer);
  finishing = false;
}

function autoStep() {
  if (!game || game.completed || paused || drag) return;
  if ((settings.autoFoundation || finishing) && autoMoveOne(game, !finishing)) {
    render();
    saveGame();
    if (!checkWin()) scheduleAuto(finishing ? 80 : 150);
    return;
  }
  finishing = false;
  updateChrome();
}

function finish() {
  if (!canAutoFinish(game)) return;
  pushHistory();
  finishing = true;
  updateChrome();
  scheduleAuto(0);
}

function undo() {
  if (!game || game.completed || !game.history.length) return;
  stopAuto();
  const prev = game.history.pop();
  decodePiles(game, prev.p);
  game.moves = prev.m;
  render();
  saveGame();
}

let hintTimer = 0;
function clearHint() {
  clearTimeout(hintTimer);
  document.querySelectorAll('.hint').forEach((el) => el.classList.remove('hint', 'hint-to'));
}

function hint() {
  if (!game || game.completed || paused) return;
  clearHint();
  const h = findHint(game);
  if (!h) { toast('No moves left. Try Undo or a new deal.'); return; }
  const mark = [];
  if (h.stock) {
    const pi = game.piles.findIndex((p) => p.kind === 'stock');
    const stock = game.piles[pi];
    mark.push(stock.cards.length ? cardEls[stock.cards[stock.cards.length - 1].id] : slotEls[pi]);
    toast(stock.cards.length ? 'Deal from the stock' : 'Turn the waste back over');
  } else {
    const src = game.piles[h.from];
    for (let i = h.ci; i < src.cards.length; i++) mark.push(cardEls[src.cards[i].id]);
    const dst = game.piles[h.to];
    mark.push(dst.cards.length ? cardEls[dst.cards[dst.cards.length - 1].id] : slotEls[h.to]);
  }
  mark.forEach((el) => el.classList.add('hint'));
  if (!h.stock) mark[mark.length - 1].classList.add('hint-to');
  hintTimer = setTimeout(clearHint, 1800);
}

function checkWin() {
  if (game.completed || !isWon(game)) return false;
  game.completed = true;
  stopTimer();
  stopAuto();
  const key = statKey(game.variant, game.opts);
  const stats = store.get('stats', {});
  const s = { played: 0, won: 0, best: null, ...stats[key] };
  s.won++;
  const time = game.elapsed;
  const isBest = s.best == null || time < s.best;
  if (isBest) s.best = time;
  stats[key] = s;
  store.set('stats', stats);
  saveGame();
  updateChrome();
  vibrate([30, 60, 30, 60, 60]);

  // Little celebration hop across the foundations.
  where.forEach((w, id) => { cardEls[id].style.setProperty('--d', `${(id % 13) * 45 + Math.floor(id / 13) * 90}ms`); });
  table.classList.add('celebrate');

  setTimeout(() => {
    $('#win-time').textContent = formatTime(time);
    $('#win-moves').textContent = game.moves;
    $('#win-best').textContent = formatTime(s.best);
    $('#win-note').textContent = isBest && s.won > 1 ? 'New best time!' : `${s.won} win${s.won === 1 ? '' : 's'} at ${VARIANTS[game.variant].label}${optionLabel(game.variant, game.opts) ? ' · ' + optionLabel(game.variant, game.opts) : ''}`;
    $('#win-dialog').showModal();
  }, 1100);
  return true;
}

// ---------- Dragging and tapping ----------

let drag = null;

function locate(target) {
  const cardEl = target.closest('.pc');
  if (cardEl) {
    const w = where[+cardEl.dataset.id];
    return w ? { pi: w.pi, ci: w.ci } : null;
  }
  const slotEl = target.closest('.slot');
  if (slotEl) return { pi: +slotEl.dataset.pile, ci: -1 };
  return null;
}

table.addEventListener('pointerdown', (e) => {
  if (!game || game.completed || paused || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const hit = locate(e.target);
  if (!hit) return;
  const pile = game.piles[hit.pi];
  if (pile.kind === 'stock') { e.preventDefault(); tapStock(); return; }
  if (hit.ci < 0 || !canPickUp(game, hit.pi, hit.ci)) return;
  e.preventDefault();
  clearHint();
  clearTimeout(autoTimer);
  const ids = pile.cards.slice(hit.ci).map((c) => c.id);
  drag = { ...hit, ids, pointer: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, moving: false };
  table.setPointerCapture(e.pointerId);
});

table.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointer) return;
  drag.dx = e.clientX - drag.x0;
  drag.dy = e.clientY - drag.y0;
  if (!drag.moving) {
    if (Math.hypot(drag.dx, drag.dy) < 6) return;
    drag.moving = true;
    drag.ids.forEach((id, k) => {
      const el = cardEls[id];
      el.classList.add('dragging');
      clearTimeout(liftTimers.get(el));
      el.style.zIndex = 2000 + k;
    });
  }
  drag.ids.forEach((id) => {
    const w = where[id];
    cardEls[id].style.transform = `translate(${w.x + drag.dx}px, ${w.y + drag.dy}px)`;
  });
});

function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.pointer) return;
  const d = drag;
  drag = null;
  d.ids.forEach((id) => {
    cardEls[id].classList.remove('dragging');
    if (d.moving) liftNext.add(id);
  });
  if (cancelled) { render(); return; }
  if (!d.moving) { tapCard(d.pi, d.ci); return; }
  const to = dropTarget(d);
  if (to < 0 || !doMove(d.pi, d.ci, to)) {
    render();
    if (settings.autoFoundation) scheduleAuto();
  }
}

table.addEventListener('pointerup', (e) => endDrag(e, false));
table.addEventListener('pointercancel', (e) => endDrag(e, true));

// The legal pile that overlaps the dragged card the most.
function dropTarget(d) {
  const w = where[d.ids[0]];
  const r = { x: w.x + d.dx, y: w.y + d.dy, w: layout.cw, h: layout.ch };
  let best = -1;
  let bestArea = 0;
  pileRects.forEach((p, pi) => {
    if (pi === d.pi) return;
    const ox = Math.min(r.x + r.w, p.x + p.w) - Math.max(r.x, p.x);
    const oy = Math.min(r.y + r.h, p.y + p.h) - Math.max(r.y, p.y);
    if (ox <= 0 || oy <= 0) return;
    const area = ox * oy;
    if (area > bestArea && canMove(game, d.pi, d.ci, pi)) { best = pi; bestArea = area; }
  });
  return best;
}

function tapCard(pi, ci) {
  if (!settings.tapToMove) { render(); return; }
  if (game.piles[pi].kind === 'foundation') { render(); return; } // drag to take a card back off
  const to = bestDestination(game, pi, ci);
  if (to >= 0 && doMove(pi, ci, to)) return;
  render();
  vibrate([10, 30, 10]);
  for (let i = ci; i < game.piles[pi].cards.length; i++) {
    const el = cardEls[game.piles[pi].cards[i].id];
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 320);
  }
}

// Double-click on desktop sends a card straight to its foundation.
table.addEventListener('dblclick', (e) => {
  if (settings.tapToMove || !game || game.completed) return;
  const hit = locate(e.target);
  if (!hit || hit.ci < 0) return;
  const to = bestDestination(game, hit.pi, hit.ci);
  if (to >= 0 && game.piles[to].kind === 'foundation') doMove(hit.pi, hit.ci, to);
});

let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (!game || $('#game').hidden || !layout) return;
    if (table.clientWidth === layout.W && table.clientHeight === layout.H) return;
    cardEls.forEach((el) => el.classList.add('instant'));
    render();
    requestAnimationFrame(() => cardEls.forEach((el) => el.classList.remove('instant')));
  });
}).observe(table);

// ---------- Pause ----------

function setPaused(value) {
  if (!game || game.completed) value = false;
  paused = value;
  $('#pause-overlay').hidden = !paused;
  if (paused) { stopTimer(); clearTimeout(autoTimer); saveGame(); } else if (game?.started) startTimer();
}

$('#pause-btn').addEventListener('click', () => setPaused(!paused));
$('#resume-btn').addEventListener('click', () => setPaused(false));

document.addEventListener('visibilitychange', () => {
  if (!game || $('#game').hidden) { if (!document.hidden) renderHome(); return; }
  if (document.hidden) { stopTimer(); saveGame(); } else if (!paused && game.started) startTimer();
});

setInterval(() => {
  if (game && !$('#game').hidden) $('#timer').textContent = formatTime(elapsed());
}, 500);

// ---------- Navigation ----------

function showGameView() {
  $('#home').hidden = true;
  $('#game').hidden = false;
  if (history.state?.view !== 'game') history.pushState({ view: 'game' }, '');
}

function goHome() {
  if (game) {
    stopTimer();
    stopAuto();
    saveGame();
  }
  paused = false;
  $('#pause-overlay').hidden = true;
  $('#game').hidden = true;
  $('#home').hidden = false;
  if (history.state?.view === 'game') history.back();
  renderHome();
}

window.addEventListener('popstate', () => {
  if (!$('#game').hidden) {
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    goHome();
  }
});

function loadGame(g, { deal = false } = {}) {
  stopAuto();
  clearHint();
  game = g;
  runningSince = 0;
  paused = false;
  $('#pause-overlay').hidden = true;
  $('#game-label').textContent = VARIANTS[g.variant].label;
  $('#timer').textContent = formatTime(g.elapsed);
  showGameView();
  buildTable();
  render();
  if (deal) dealAnimation();
  if (g.started && !g.completed) startTimer();
}

function startGame(variant, opts, seed = (Math.random() * 2 ** 32) >>> 0) {
  const g = { ...newGame(variant, opts, seed), elapsed: 0, completed: false, started: false, history: [] };
  const key = statKey(variant, opts);
  const stats = store.get('stats', {});
  stats[key] = { played: 0, won: 0, best: null, ...stats[key] };
  stats[key].played++;
  store.set('stats', stats);
  loadGame(g, { deal: true });
  saveGame();
}

function inProgress() {
  const s = store.get('current', null);
  return s && !s.completed && s.started ? s : null;
}

async function confirmNewGame(label) {
  if (!inProgress()) return true;
  return confirmAction(`Start a new ${label} game? Your current game will be lost.`, 'New game');
}

// ---------- Home ----------

function statsFor(variant, opts) {
  return { played: 0, won: 0, best: null, ...store.get('stats', {})[statKey(variant, opts)] };
}

function renderHome() {
  const current = inProgress();
  $('#continue-card').hidden = !current;
  if (current) {
    const g = loadSaved();
    const total = g ? g.deck.length : 52;
    const done = g ? foundationCount(g) : 0;
    $('#continue-meta').textContent = [VARIANTS[current.variant].label, optionLabel(current.variant, current.opts),
      formatTime(current.elapsed), `${Math.round((done / total) * 100)}%`].filter(Boolean).join(' · ');
  }
  for (const btn of document.querySelectorAll('.variant')) {
    const v = btn.dataset.variant;
    const opts = settings.opts[v];
    btn.querySelector('em').textContent = optionLabel(v, opts) || VARIANTS[v].tagline;
    const s = statsFor(v, opts);
    btn.querySelector('small').textContent = s.played
      ? `Won ${s.won} of ${s.played}${s.best != null ? ' · Best ' + formatTime(s.best) : ''}`
      : 'Not played yet';
  }
}

$('#continue-btn').addEventListener('click', () => {
  const g = loadSaved();
  if (g) loadGame(g);
});

// ---------- New game setup ----------

let setupVariant = 'klondike';

function segmented(choices, value, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'segmented';
  for (const [v, label] of choices) {
    const b = document.createElement('button');
    b.textContent = label;
    b.classList.toggle('active', v === value);
    b.addEventListener('click', () => {
      wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      onPick(v);
    });
    wrap.appendChild(b);
  }
  return wrap;
}

function renderSetupStats() {
  const s = statsFor(setupVariant, settings.opts[setupVariant]);
  const cells = [
    [s.played, 'Played'],
    [s.played ? `${Math.round((s.won / s.played) * 100)}%` : '–', 'Won'],
    [s.best != null ? formatTime(s.best) : '–', 'Best'],
  ];
  $('#setup-stats').replaceChildren(...cells.map(([v, l]) => {
    const d = document.createElement('div');
    d.innerHTML = '<span class="stat-value"></span><span class="stat-label"></span>';
    d.firstChild.textContent = v;
    d.lastChild.textContent = l;
    return d;
  }));
}

function openSetup(variant) {
  setupVariant = variant;
  const info = VARIANTS[variant];
  $('#setup-title').textContent = info.label;
  $('#setup-rules').textContent = info.rules;
  $('#setup-options').replaceChildren(...info.options.map((o) =>
    segmented(o.choices, settings.opts[variant][o.key], (v) => {
      settings.opts[variant] = { ...settings.opts[variant], [o.key]: v };
      saveSettings();
      renderSetupStats();
      renderHome();
    })));
  renderSetupStats();
  $('#setup-dialog').showModal();
}

for (const btn of document.querySelectorAll('.variant')) {
  btn.addEventListener('click', () => openSetup(btn.dataset.variant));
}

$('#setup-play').addEventListener('click', async () => {
  $('#setup-dialog').close();
  if (!(await confirmNewGame(VARIANTS[setupVariant].label))) return;
  startGame(setupVariant, settings.opts[setupVariant]);
});

// ---------- Game controls ----------

$('#back-btn').addEventListener('click', goHome);
$('#undo-btn').addEventListener('click', undo);
$('#hint-btn').addEventListener('click', hint);
$('#finish-btn').addEventListener('click', finish);

$('#restart-btn').addEventListener('click', async () => {
  if (!game) return;
  if (game.started && !game.completed && !(await confirmAction('Restart this deal from the beginning?', 'Restart'))) return;
  const g = { ...newGame(game.variant, game.opts, game.seed), elapsed: 0, completed: false, started: false, history: [] };
  loadGame(g, { deal: true });
  saveGame();
});

$('#new-btn').addEventListener('click', async () => {
  if (!game) return;
  const opts = settings.opts[game.variant];
  if (game.started && !game.completed && !(await confirmAction('Deal a new game? This one will be lost.', 'New deal'))) return;
  startGame(game.variant, opts);
});

$('#win-again').addEventListener('click', () => {
  $('#win-dialog').close();
  startGame(game.variant, settings.opts[game.variant]);
});
$('#win-home').addEventListener('click', () => { $('#win-dialog').close(); goHome(); });

document.addEventListener('keydown', (e) => {
  if ($('#game').hidden || document.querySelector('dialog[open]') || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey) return;
  if (k === 'h') hint();
  else if (k === 'd' || k === ' ') { e.preventDefault(); tapStock(); }
  else if (k === 'f') finish();
  else if (k === 'p') setPaused(!paused);
  else if (k === 'escape') goHome();
});

// ---------- Settings ----------

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = settings.theme;
  root.dataset.felt = settings.felt;
  root.dataset.back = settings.back;
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (settings.theme === 'auto') m.setAttribute('content', m.media.includes('dark') ? '#0f1115' : '#f4f5f8');
    else m.setAttribute('content', bg);
  });
  document.querySelectorAll('#theme-select button').forEach((b) => b.classList.toggle('active', b.dataset.themeValue === settings.theme));
  document.querySelectorAll('[data-swatch]').forEach((group) => {
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings[group.dataset.swatch]));
  });
}

function syncOptionControls() {
  document.querySelectorAll('[data-option]').forEach((group) => {
    const [variant, key] = group.dataset.option.split('.');
    group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', +b.dataset.value === settings.opts[variant][key]));
  });
}

$('#settings-btn').addEventListener('click', () => {
  document.querySelectorAll('[data-setting]').forEach((input) => { input.checked = settings[input.dataset.setting]; });
  syncOptionControls();
  const stats = Object.values(store.get('stats', {}));
  const won = stats.reduce((n, s) => n + (s.won || 0), 0);
  const played = stats.reduce((n, s) => n + (s.played || 0), 0);
  $('#stats-summary').textContent = `${won} game${won === 1 ? '' : 's'} won out of ${played} played`;
  $('#settings-dialog').showModal();
});

document.querySelectorAll('[data-setting]').forEach((input) => {
  input.addEventListener('change', () => {
    settings[input.dataset.setting] = input.checked;
    saveSettings();
  });
});

document.querySelectorAll('[data-option]').forEach((group) => {
  const [variant, key] = group.dataset.option.split('.');
  group.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    settings.opts[variant] = { ...settings.opts[variant], [key]: +b.dataset.value };
    saveSettings();
    syncOptionControls();
    renderHome();
    if (game && game.variant === variant && !$('#game').hidden) toast('Applies from your next deal');
  }));
});

document.querySelectorAll('[data-swatch]').forEach((group) => {
  group.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    settings[group.dataset.swatch] = b.dataset.value;
    saveSettings();
    applyTheme();
  }));
});

document.querySelectorAll('#theme-select button').forEach((btn) => {
  btn.addEventListener('click', () => {
    settings.theme = btn.dataset.themeValue;
    saveSettings();
    applyTheme();
  });
});

// Close buttons and tap-outside for sheet dialogs.
document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog && dialog.id !== 'win-dialog' && dialog.id !== 'confirm-dialog') dialog.close();
  });
});

// ---------- Install prompt ----------

// ---------- Zoom lock ----------
// iOS ignores user-scalable=no in Safari and doesn't always honour
// touch-action, so a double-tap or pinch can zoom the page. In the installed
// app there's no browser UI to zoom back out, so the view gets stuck.

// Pinch: Safari's proprietary gesture events.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1 || (e.scale !== undefined && e.scale !== 1)) e.preventDefault();
}, { passive: false });

// Double-tap: cancel the second quick tap. Buttons and form controls are left
// alone so their click events still fire; touch-action covers them. The card
// table uses pointer events, which still fire when touchend is cancelled.
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  const now = e.timeStamp;
  const quick = now - lastTouchEnd < 350;
  lastTouchEnd = now;
  if (quick && e.cancelable && !e.target.closest('button, a, input, select, textarea, label')) {
    e.preventDefault();
  }
}, { passive: false });

const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installEvent = null;

function maybeShowInstall() {
  if (isStandalone || store.get('installDismissed', false)) return;
  if (installEvent) {
    $('#install-btn').hidden = false;
    $('#install-card').hidden = false;
  } else if (isIOS) {
    $('#install-text').textContent = 'Tap the Share button, then “Add to Home Screen” for full-screen, offline play.';
    $('#install-card').hidden = false;
  }
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  maybeShowInstall();
});

$('#install-btn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('#install-card').hidden = true;
});

$('#install-dismiss').addEventListener('click', () => {
  store.set('installDismissed', true);
  $('#install-card').hidden = true;
});

// ---------- Boot ----------

applyTheme();
renderHome();
maybeShowInstall();
history.replaceState({ view: 'home' }, '');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable */ });
}
