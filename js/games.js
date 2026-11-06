// Rules for each solitaire variant. Pure game logic, no DOM.
//
// A game holds a list of piles. Each pile has a kind (stock, waste,
// foundation, tableau or cell), a slot on the table (col/row) and an array of
// cards. A card is { id, s, r, up }: suit index, rank 1-13 and face-up flag.

export const SUITS = ['s', 'h', 'd', 'c']; // spades, hearts, diamonds, clubs
export const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const isRed = (s) => s === 1 || s === 2;

export const VARIANTS = {
  klondike: {
    label: 'Klondike',
    tagline: 'The classic',
    rules: 'Build the tableau down in alternating colors and move every card to the four foundations, Ace to King. Only Kings can fill an empty column. Tap the stock to turn over more cards.',
    cols: 7,
    options: [{ key: 'draw', choices: [[1, 'Draw 1'], [3, 'Draw 3']], default: 1 }],
  },
  spider: {
    label: 'Spider',
    tagline: 'Two decks, ten columns',
    rules: 'Build down regardless of suit, but only runs of the same suit move together. A full King-to-Ace run of one suit is removed. Tap the stock to deal a card onto every column. Clear all eight runs to win.',
    cols: 10,
    options: [{ key: 'suits', choices: [[1, '1 suit'], [2, '2 suits'], [4, '4 suits']], default: 1 }],
  },
  freecell: {
    label: 'FreeCell',
    tagline: 'Every card face up',
    rules: 'All cards are dealt face up. Build down in alternating colors and use the four free cells to hold single cards. Free cells and empty columns let you move longer runs at once. Almost every deal can be won.',
    cols: 8,
    options: [],
  },
  yukon: {
    label: 'Yukon',
    tagline: 'No stock, any group moves',
    rules: 'Like Klondike with no stock: build down in alternating colors, but any face-up card can be moved along with everything on top of it, even if those cards are out of order. Only Kings can fill an empty column.',
    cols: 7,
    options: [],
  },
};

export function defaultOptions(variant) {
  return Object.fromEntries(VARIANTS[variant].options.map((o) => [o.key, o.default]));
}

export function optionLabel(variant, opts) {
  return VARIANTS[variant].options
    .map((o) => (o.choices.find(([v]) => v === opts[o.key]) || o.choices[0])[1])
    .join(' · ');
}

// Stats are kept per variant and option, e.g. "klondike-3" or "spider-2".
export function statKey(variant, opts) {
  return [variant, ...VARIANTS[variant].options.map((o) => opts[o.key])].join('-');
}

// ---------- Dealing ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDeck(variant, opts) {
  const deck = [];
  if (variant === 'spider') {
    const suits = opts.suits === 4 ? [0, 1, 2, 3] : opts.suits === 2 ? [0, 1] : [0];
    for (let k = 0; k < 8; k++) for (let r = 1; r <= 13; r++) deck.push({ s: suits[k % suits.length], r });
  } else {
    for (let s = 0; s < 4; s++) for (let r = 1; r <= 13; r++) deck.push({ s, r });
  }
  return deck;
}

const pile = (kind, col, row) => ({ kind, col, row, cards: [] });

function makePiles(variant) {
  const piles = [];
  const add = (kind, cols, row) => cols.forEach((c) => piles.push(pile(kind, c, row)));
  const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
  if (variant === 'klondike') {
    add('stock', [0], 0);
    add('waste', [1], 0);
    add('foundation', range(3, 7), 0);
    add('tableau', range(0, 7), 1);
  } else if (variant === 'spider') {
    add('foundation', range(0, 8), 0);
    add('stock', [9], 0);
    add('tableau', range(0, 10), 1);
  } else if (variant === 'freecell') {
    add('cell', range(0, 4), 0);
    add('foundation', range(4, 8), 0);
    add('tableau', range(0, 8), 1);
  } else if (variant === 'yukon') {
    add('foundation', range(3, 7), 0);
    add('tableau', range(0, 7), 1);
  }
  return piles;
}

export function newGame(variant, opts, seed) {
  const deck = buildDeck(variant, opts);
  const rng = mulberry32(seed);
  const cards = deck.map((d, id) => ({ id, s: d.s, r: d.r, up: false }));
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  const piles = makePiles(variant);
  const tab = piles.filter((p) => p.kind === 'tableau');
  const stock = piles.find((p) => p.kind === 'stock');
  const deal = (p, n, upFrom) => {
    for (let i = 0; i < n; i++) {
      const c = cards.pop();
      c.up = i >= upFrom;
      p.cards.push(c);
    }
  };

  if (variant === 'klondike') {
    tab.forEach((p, i) => deal(p, i + 1, i));
  } else if (variant === 'spider') {
    tab.forEach((p, i) => deal(p, i < 4 ? 6 : 5, i < 4 ? 5 : 4));
  } else if (variant === 'freecell') {
    tab.forEach((p, i) => deal(p, i < 4 ? 7 : 6, 0));
  } else if (variant === 'yukon') {
    tab.forEach((p, i) => deal(p, i === 0 ? 1 : i + 5, i));
  }
  if (stock) stock.cards = cards.splice(0).reverse();

  return { variant, opts: { ...opts }, seed, deck, piles, moves: 0 };
}

// ---------- Compact encoding for saves and undo ----------

// Each card becomes one character: id * 2 + face-up, offset past ASCII so it
// never needs escaping in JSON.
export function encodePiles(g) {
  return g.piles.map((p) => String.fromCharCode(...p.cards.map((c) => 192 + c.id * 2 + (c.up ? 1 : 0))));
}

export function decodePiles(g, encoded) {
  g.piles.forEach((p, i) => {
    p.cards = Array.from(encoded[i] || '', (ch) => {
      const n = ch.charCodeAt(0) - 192;
      const id = n >> 1;
      return { id, s: g.deck[id].s, r: g.deck[id].r, up: (n & 1) === 1 };
    });
  });
}

export function restoreGame({ variant, opts, seed, piles, moves }) {
  const g = { variant, opts, seed, deck: buildDeck(variant, opts), piles: makePiles(variant), moves: moves || 0 };
  decodePiles(g, piles);
  return g;
}

// ---------- Rules ----------

const top = (p) => p.cards[p.cards.length - 1];
const ofKind = (g, kind) => g.piles.filter((p) => p.kind === kind);

// Can `above` sit on `below` in the tableau?
function stacks(variant, below, above) {
  if (below.r !== above.r + 1) return false;
  return variant === 'spider' || isRed(below.s) !== isRed(above.s);
}

// Does `above` sit on `below` as part of a run that moves together?
function linked(variant, below, above) {
  if (variant === 'spider') return below.s === above.s && below.r === above.r + 1;
  return stacks(variant, below, above);
}

// How many cards FreeCell lets you move at once, given free cells and empty columns.
export function freecellCapacity(g, toEmptyColumn) {
  const freeCells = ofKind(g, 'cell').filter((p) => !p.cards.length).length;
  const emptyCols = ofKind(g, 'tableau').filter((p) => !p.cards.length).length - (toEmptyColumn ? 1 : 0);
  return (freeCells + 1) * 2 ** Math.max(0, emptyCols);
}

export function canPickUp(g, pi, ci) {
  const p = g.piles[pi];
  const c = p.cards[ci];
  if (!c || !c.up) return false;
  const last = ci === p.cards.length - 1;
  switch (p.kind) {
    case 'waste':
    case 'cell':
      return last;
    case 'foundation':
      return last && g.variant !== 'spider';
    case 'tableau':
      if (g.variant === 'yukon') return true;
      for (let j = ci; j < p.cards.length - 1; j++) {
        if (!linked(g.variant, p.cards[j], p.cards[j + 1])) return false;
      }
      if (g.variant === 'freecell' && p.cards.length - ci > freecellCapacity(g, false)) return false;
      return true;
    default:
      return false;
  }
}

export function canMove(g, from, ci, to) {
  if (from === to) return false;
  const src = g.piles[from];
  const dst = g.piles[to];
  const n = src.cards.length - ci;
  const first = src.cards[ci];
  const t = top(dst);
  if (!first) return false;
  switch (dst.kind) {
    case 'foundation':
      if (g.variant === 'spider' || n !== 1) return false;
      return t ? t.s === first.s && first.r === t.r + 1 : first.r === 1;
    case 'cell':
      return n === 1 && !t;
    case 'tableau':
      if (g.variant === 'freecell' && n > freecellCapacity(g, !t)) return false;
      if (!t) return g.variant === 'klondike' || g.variant === 'yukon' ? first.r === 13 : true;
      return t.up && stacks(g.variant, t, first);
    default:
      return false;
  }
}

// Moves cards and tidies up (flips exposed cards, clears finished Spider runs).
// Returns the number of Spider runs completed.
export function applyMove(g, from, ci, to) {
  const moved = g.piles[from].cards.splice(ci);
  g.piles[to].cards.push(...moved);
  return settle(g);
}

function settle(g) {
  let runs = 0;
  if (g.variant === 'spider') {
    for (const p of ofKind(g, 'tableau')) {
      const n = p.cards.length;
      if (n < 13) continue;
      const run = p.cards.slice(n - 13);
      const ok = run.every((c, i) => c.up && c.r === 13 - i && c.s === run[0].s);
      if (!ok) continue;
      const dest = ofKind(g, 'foundation').find((f) => !f.cards.length);
      p.cards.splice(n - 13);
      dest.cards.push(...run.reverse()); // King on top
      runs++;
    }
  }
  for (const p of ofKind(g, 'tableau')) {
    const t = top(p);
    if (t && !t.up) t.up = true;
  }
  return runs;
}

// Tapping the stock. Returns { ok, runs } or { ok: false, reason }.
export function dealStock(g) {
  const stock = ofKind(g, 'stock')[0];
  if (!stock) return { ok: false };
  if (g.variant === 'klondike') {
    const waste = ofKind(g, 'waste')[0];
    if (!stock.cards.length) {
      if (!waste.cards.length) return { ok: false };
      stock.cards = waste.cards.splice(0).reverse();
      stock.cards.forEach((c) => { c.up = false; });
      return { ok: true, recycled: true };
    }
    const n = Math.min(g.opts.draw || 1, stock.cards.length);
    for (let i = 0; i < n; i++) {
      const c = stock.cards.pop();
      c.up = true;
      waste.cards.push(c);
    }
    return { ok: true };
  }
  if (g.variant === 'spider') {
    if (!stock.cards.length) return { ok: false };
    const tab = ofKind(g, 'tableau');
    if (tab.some((p) => !p.cards.length)) return { ok: false, reason: 'Fill every column before dealing.' };
    for (const p of tab) {
      const c = stock.cards.pop();
      if (!c) break;
      c.up = true;
      p.cards.push(c);
    }
    return { ok: true, runs: settle(g) };
  }
  return { ok: false };
}

export function stockIsEmpty(g) {
  const stock = ofKind(g, 'stock')[0];
  const waste = ofKind(g, 'waste')[0];
  return !stock || (!stock.cards.length && !(waste && waste.cards.length));
}

export function foundationCount(g) {
  return ofKind(g, 'foundation').reduce((n, p) => n + p.cards.length, 0);
}

export function isWon(g) {
  return foundationCount(g) === g.deck.length;
}

// Where a tapped card (and everything on it) should go, or -1.
export function bestDestination(g, pi, ci) {
  if (!canPickUp(g, pi, ci)) return -1;
  const src = g.piles[pi];
  const first = src.cards[ci];
  const below = src.cards[ci - 1];
  const legal = g.piles.map((_, to) => to).filter((to) => canMove(g, pi, ci, to));
  if (!legal.length) return -1;
  const score = (to) => {
    const dst = g.piles[to];
    const t = top(dst);
    if (dst.kind === 'foundation') return src.kind === 'foundation' ? -1 : 100;
    if (dst.kind === 'cell') return 10;
    if (!t) {
      // Moving a whole column into an empty one does nothing.
      if (src.kind === 'tableau' && ci === 0) return 1;
      return 20;
    }
    let s = 50;
    if (g.variant === 'spider' && t.s === first.s) s += 20;
    if (below && !below.up) s += 5;
    return s;
  };
  legal.sort((a, b) => score(b) - score(a) || a - b);
  return score(legal[0]) > 0 ? legal[0] : -1;
}

// ---------- Automatic moves ----------

function foundationRank(g, s) {
  const f = ofKind(g, 'foundation').find((p) => p.cards.length && p.cards[0].s === s);
  return f ? top(f).r : 0;
}

// A card is safe to auto-play when no card of the other color could still
// need it as a parent.
function safeToPlay(g, c) {
  if (c.r <= 2) return true;
  const opposite = [0, 1, 2, 3].filter((s) => isRed(s) !== isRed(c.s));
  return opposite.every((s) => foundationRank(g, s) >= c.r - 1);
}

// Moves one card to a foundation if possible. Returns true if a move was made.
export function autoMoveOne(g, safeOnly) {
  if (g.variant === 'spider') return false;
  const foundations = g.piles.map((p, i) => i).filter((i) => g.piles[i].kind === 'foundation');
  // Lowest rank first so finishing looks orderly.
  const sources = g.piles
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => (p.kind === 'tableau' || p.kind === 'waste' || p.kind === 'cell') && p.cards.length && top(p).up)
    .sort((a, b) => top(a.p).r - top(b.p).r);
  for (const { p, i } of sources) {
    const ci = p.cards.length - 1;
    if (safeOnly && !safeToPlay(g, p.cards[ci])) continue;
    const to = foundations.find((f) => canMove(g, i, ci, f));
    if (to !== undefined) {
      applyMove(g, i, ci, to);
      return true;
    }
  }
  return false;
}

// True when the rest of the game is just moving cards up: no stock, nothing
// face down, and every column in descending order. The lowest card left is
// then always on top of its column, so finishing can never get stuck.
export function canAutoFinish(g) {
  if (g.variant === 'spider' || isWon(g) || !stockIsEmpty(g)) return false;
  return ofKind(g, 'tableau').every((p) =>
    p.cards.every((c, i) => c.up && (i === 0 || p.cards[i - 1].r > c.r)));
}

// ---------- Hints ----------

// Returns the most useful move as { from, ci, to }, { stock: true }, or null.
export function findHint(g) {
  let best = null;
  let bestScore = 0;
  g.piles.forEach((src, from) => {
    if (src.kind !== 'tableau' && src.kind !== 'waste' && src.kind !== 'cell') return;
    for (let ci = 0; ci < src.cards.length; ci++) {
      if (!canPickUp(g, from, ci)) continue;
      const first = src.cards[ci];
      const below = src.cards[ci - 1];
      g.piles.forEach((dst, to) => {
        if (!canMove(g, from, ci, to)) return;
        const t = top(dst);
        let score = 0;
        if (dst.kind === 'foundation') score = 100;
        else if (dst.kind === 'cell') score = src.kind === 'cell' ? 0 : 4;
        else if (src.kind === 'waste') score = t ? 50 : 30;
        else if (src.kind === 'cell') score = t ? 55 : 25;
        else if (below && !below.up) score = t ? 80 : 75;
        else if (!below) score = t ? 70 : 0; // empties a column (moving a whole column to an empty one is pointless)
        else if (stacks(g.variant, below, first) && (g.variant !== 'spider' || below.s === first.s)) score = 0; // already built
        else if (!t) score = 12;
        else score = g.variant === 'spider' && t.s === first.s ? 45 : 30;
        if (score > bestScore) { bestScore = score; best = { from, ci, to }; }
      });
    }
  });
  const stock = ofKind(g, 'stock')[0];
  const canDeal = g.variant === 'klondike' ? !stockIsEmpty(g)
    : g.variant === 'spider' && stock.cards.length > 0 && ofKind(g, 'tableau').every((p) => p.cards.length);
  if (canDeal && bestScore < 20) return { stock: true };
  return best;
}
