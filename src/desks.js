// Desks: chats opened together, each in its spot. A shape is a rule that lays out any number of
// panes; the tree it makes is what the Rust side turns into one Windows Terminal call, so the
// preview drawn here and the window that opens come from the same tree.

export const SHAPES = [
  ['grid', 'Grid'],
  ['main', 'Main + stack'],
  ['cols', 'Columns'],
  ['rows', 'Rows'],
];

// A region of one part is just that part, so trees stay as flat as the layout looks.
const split = (dir, kids, sizes) => (kids.length === 1 ? kids[0] : sizes ? { dir, sizes, kids } : { dir, kids });
const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);

/** The layout tree for `n` panes: a pane is its index, a region is {dir: 'V'|'H', sizes?, kids}. */
export function tree(shape, n) {
  if (n <= 1) return 0;
  if (shape === 'main') return split('V', [0, split('H', range(1, n - 1))], [0.58, 0.42]);
  if (shape === 'cols') return split('V', range(0, n));
  if (shape === 'rows') return split('H', range(0, n));
  // As square as the count allows, the left columns taking the extra rows: three chats read as
  // two stacked on the left and one tall on the right.
  const cols = Math.ceil(Math.sqrt(n));
  let k = 0;
  return split('V', range(0, cols).map(c => split('H', Array.from({ length: Math.floor(n / cols) + (c < n % cols ? 1 : 0) }, () => k++))));
}

/** Every pane's box in a w x h frame, with `gap` between neighbours, indexed by pane. */
export function boxes(node, w, h, gap = 0) {
  const out = [];
  (function place(node, x, y, w, h) {
    if (typeof node === 'number') { out[node] = { x, y, w, h }; return; }
    const along = node.dir === 'V' ? w : h;
    const room = along - gap * (node.kids.length - 1);
    const sizes = node.sizes || node.kids.map(() => 1 / node.kids.length);
    let at = 0;
    node.kids.forEach((kid, i) => {
      const len = room * sizes[i];
      if (node.dir === 'V') place(kid, x + at, y, len, h); else place(kid, x, y + at, w, len);
      at += len + gap;
    });
  })(node, 0, 0, w, h);
  return out;
}

/** A small drawing of a layout; `fill(i)` colours pane i. */
export function thumb(shape, n, fill, w = 64, h = 40) {
  const rects = boxes(tree(shape, Math.max(1, n)), w, h, 2).map((b, i) =>
    `<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="3" fill="${fill(i)}"/>`);
  return `<svg viewBox="0 0 ${w} ${h}" aria-hidden="true">${rects.join('')}</svg>`;
}

const same = (d, shape, slots) => d.shape === shape && d.slots.length === slots.length && d.slots.every((s, i) => s === slots[i]);
const when = d => d.opened || d.created;
export const recent = desks => desks.slice().sort((a, b) => when(b) - when(a));

// Unnamed desks are a history of what was opened; past this many the oldest ones drop off.
// Named desks are the user's own and never do.
const UNNAMED_KEPT = 8;

/**
 * The desks after opening `slots` in `shape`. The same arrangement opened again (as the desk
 * being edited, or matching any desk) is that desk opened again, not a new one.
 */
export function opened(desks, { shape, slots, deskId, now }) {
  const hit = desks.find(d => d.id === deskId && same(d, shape, slots)) || desks.find(d => same(d, shape, slots));
  if (hit) return desks.map(d => (d === hit ? { ...d, opened: now } : d));
  const fresh = { id: crypto.randomUUID(), name: null, shape, slots: slots.slice(), created: now, opened: now };
  const unnamed = recent([fresh, ...desks.filter(d => !d.name)]).slice(0, UNNAMED_KEPT);
  return [...desks.filter(d => d.name), ...unnamed];
}

/**
 * The desks after naming the arrangement: it updates the desk being edited, or names the unnamed
 * desk it matches, or becomes a new desk. Returns [desks, id of the saved desk].
 */
export function saved(desks, { name, shape, slots, deskId, now }) {
  const target = desks.find(d => d.id === deskId) || desks.find(d => !d.name && same(d, shape, slots));
  if (target) return [desks.map(d => (d === target ? { ...d, name, shape, slots: slots.slice() } : d)), target.id];
  const fresh = { id: crypto.randomUUID(), name, shape, slots: slots.slice(), created: now, opened: null };
  return [[...desks, fresh], fresh.id];
}
