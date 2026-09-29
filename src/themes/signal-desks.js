// Signal's Desks view: every set of chats opened together, newest first, and the bench where a set
// is put together. Chats are added from the list, dragged onto each other to trade places, laid
// out by a shape, and named to keep the desk for good.
import { SHAPES, tree, boxes, thumb, recent } from '../desks.js';
import { title, ago } from '../model.js';

const GAP = 6;
const GONE = 'rgba(128,128,128,.35)';

export const DESKS_TEMPLATE = `
<section class="desks">
  <div class="shelf-head"><b>Desks</b><small class="shelf-sub"></small></div>
  <div class="shelf"></div>
  <div class="bench">
    <section class="card editor"><svg class="shape"><path/></svg>
      <div class="ed-top">
        <input class="dname" placeholder="name it to keep this desk" maxlength="48" spellcheck="false" autocomplete="off">
        <div class="seg shapes pill-glass">${SHAPES.map(([k, name]) => `<button type="button" data-shape="${k}">${name}</button>`).join('')}</div>
      </div>
      <div class="frame"><div class="fbar"><i></i><span>one new terminal window</span></div><div class="area"><div class="hint"></div></div></div>
      <div class="ed-foot"><button class="ed-clear" type="button">Clear</button><small class="ed-note"></small><button class="ed-save" type="button">Save desk</button><button class="ed-go" type="button">Open together</button></div>
    </section>
    <section class="chooser"><div class="ch-head"><b>Add chats</b><small>newest first</small></div><ul class="chlist"></ul></section>
  </div>
</section>`;

/**
 * Wires the view into the Signal root. `kit` lends it Signal's own pieces: launch (the pixel sweep
 * around an action), openTogether, toast, shake, gbtn, canPick, accent, keyed, shape (the
 * folder-tab outline) and the search box.
 */
export function desksView(root, ctx, kit) {
  const $ = s => root.querySelector(s);
  const shelf = $('.shelf'), area = $('.area'), list = $('.chlist'), nameIn = $('.dname'), editor = $('.editor');
  const { accent, keyed } = kit;
  const tiles = new Map(), panes = new Map();
  let vm = null, byId = new Map(), bound;
  let listSig = '', laid = [];

  /* ---------- the shelf: desks, most recently opened first ---------- */
  function renderShelf() {
    const desks = recent(ctx.prefs.desks);
    const named = desks.filter(d => d.name).length;
    $('.shelf-sub').textContent = desks.length ? `${named} saved · ${desks.length - named} recent · newest first` : '';
    shelf.querySelector('.none')?.remove();
    keyed(shelf, tiles, desks, d => d.id, makeTile, fillTile);
    if (!desks.length) {
      shelf.insertAdjacentHTML('beforeend', '<div class="none">Nothing opened together yet. Pick chats, place them on the bench below and open them: every launch lands here, and naming one keeps it.</div>');
    }
  }
  function makeTile() {
    const el = document.createElement('article');
    el.className = 'desk';
    el.innerHTML = '<div class="dk-thumb"></div><div class="dk-tx"><b></b><small></small></div><small class="dk-who"></small><div class="dk-act"></div>';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'dk-del';
    // Deleting takes a second click, so a stray one can't lose a saved desk.
    del.addEventListener('click', e => {
      e.stopPropagation();
      if (del.classList.contains('armed')) return ctx.deleteDesk(el._d.id);
      del.classList.add('armed');
      del.textContent = 'delete?';
      setTimeout(() => { del.classList.remove('armed'); del.textContent = '×'; }, 2600);
    });
    del.textContent = '×';
    const go = kit.gbtn('play', 'open this desk', () => kit.launch(() => ctx.openDesk(el._d), el, null));
    el.querySelector('.dk-act').append(del, go);
    el.addEventListener('click', () => ctx.editDesk(el._d, id => byId.has(id)));
    return el;
  }
  function fillTile(el, d) {
    el._d = d;
    const chats = d.slots.map(id => byId.get(id));
    const gone = chats.filter(c => !c).length;
    const sig = JSON.stringify([d, gone, chats.map(c => c && [title(c), c.state]), ctx.deskId() === d.id, ago(new Date(d.opened || d.created).toISOString())]);
    if (el._sig === sig) return;
    el._sig = sig;
    el.classList.toggle('on', ctx.deskId() === d.id);
    el.classList.toggle('unnamed', !d.name);
    el.querySelector('.dk-thumb').innerHTML = thumb(d.shape, d.slots.length, i => (chats[i] ? accent(chats[i]) : GONE));
    el.querySelector('b').textContent = d.name || 'Unsaved';
    const when = d.opened ? ago(new Date(d.opened).toISOString()) : 'never opened';
    el.querySelector('.dk-tx small').textContent = [when, d.slots.length + ' chat' + (d.slots.length === 1 ? '' : 's'), gone ? gone + ' gone' : null].filter(Boolean).join(' · ');
    el.querySelector('.dk-who').textContent = chats.filter(Boolean).map(title).join(' · ') || 'its chats are gone';
    el.querySelector('.gbtn').title = ctx.prefs.fork ? 'fork these chats together' : 'open this desk';
  }

  /* ---------- the bench ---------- */
  const blocked = c => !!c.live && !ctx.prefs.fork;
  function renderBench() {
    const ids = ctx.picked();
    root.querySelectorAll('.shapes button').forEach(b => b.classList.toggle('on', b.dataset.shape === ctx.shape()));
    // The name field follows the desk on the bench, and is left alone while you type in it.
    if (bound !== ctx.deskId()) {
      bound = ctx.deskId();
      nameIn.value = ctx.prefs.desks.find(d => d.id === bound)?.name || '';
    }
    layoutPanes();
    const desk = ctx.prefs.desks.find(d => d.id === ctx.deskId());
    const skip = ids.map(id => byId.get(id)).filter(c => c && blocked(c)).length;
    $('.ed-note').textContent = !ids.length ? '' : [
      desk ? (desk.name ? `editing "${desk.name}"` : 'from a recent launch') : null,
      `${ids.length} chat${ids.length === 1 ? '' : 's'}`,
      skip ? `${skip} running, left out` : null,
    ].filter(Boolean).join(' · ');
    $('.ed-save').disabled = !ids.length;
    $('.ed-go').disabled = !ids.length;
    $('.ed-go').textContent = ctx.prefs.fork ? 'Fork together' : 'Open together';
  }
  function layoutPanes() {
    const ids = ctx.picked();
    const W = area.clientWidth, H = area.clientHeight;
    laid = ids.length && W ? boxes(tree(ctx.shape(), ids.length), W, H, GAP) : [];
    $('.area .hint').hidden = ids.length > 0;
    $('.area .hint').textContent = 'Add chats from the list on the right, or pick them on the cards. Drag one onto another to swap their places.';
    const keep = new Set();
    ids.forEach((id, i) => {
      const c = byId.get(id);
      if (!c || !laid[i]) return;
      keep.add(id);
      let el = panes.get(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'dpane';
        el.innerHTML = '<b></b><small></small><span class="tag">running, left out</span><span class="n"></span>';
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'rm';
        rm.title = 'take it off the desk';
        rm.textContent = '×';
        rm.addEventListener('click', e => { e.stopPropagation(); ctx.togglePick(el._c); });
        el.appendChild(rm);
        // A new pane grows out of where it will sit instead of flying in from the corner.
        Object.assign(el.style, { left: laid[i].x + laid[i].w / 2 + 'px', top: laid[i].y + laid[i].h / 2 + 'px', width: '0px', height: '0px' });
        area.appendChild(el);
        panes.set(id, el);
        void el.offsetWidth;
      }
      el._c = c;
      el.dataset.i = i;
      el.style.setProperty('--acc', accent(c));
      el.classList.toggle('busy', blocked(c));
      el.querySelector('b').textContent = title(c);
      el.querySelector('small').textContent = [c.project.name, ago(c.last)].filter(Boolean).join(' · ');
      el.querySelector('.n').textContent = i + 1;
      if (!el.classList.contains('lift')) {
        const b = laid[i];
        Object.assign(el.style, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' });
      }
    });
    for (const [id, el] of panes) if (!keep.has(id)) { el.remove(); panes.delete(id); }
  }
  new ResizeObserver(() => {
    if (!vm) return;
    area.querySelectorAll('.dpane').forEach(p => p.classList.add('settle'));
    layoutPanes();
    void area.offsetWidth;
    area.querySelectorAll('.dpane').forEach(p => p.classList.remove('settle'));
    const e = editor;
    kit.shape(e.querySelector('.shape'), e.offsetWidth, e.offsetHeight, 22, 0.42);
  }).observe(area);

  // Dragging: the pane follows the pointer; let go over another pane and the two trade places.
  let drag = null;
  const under = (e) => {
    const r = area.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    return laid.findIndex(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
  };
  area.addEventListener('pointerdown', e => {
    const p = e.target.closest('.dpane');
    if (!p || e.button !== 0 || e.target.closest('button')) return;
    drag = { el: p, from: +p.dataset.i, x: e.clientX, y: e.clientY, moved: false, to: -1 };
    p.setPointerCapture(e.pointerId);
  });
  area.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) { drag.moved = true; drag.el.classList.add('lift'); }
    drag.el.style.transform = `translate(${dx}px, ${dy}px) rotate(${Math.max(-2, Math.min(2, dx / 80))}deg)`;
    drag.to = under(e);
    area.querySelectorAll('.dpane').forEach(p => p.classList.toggle('drop', p !== drag.el && +p.dataset.i === drag.to));
  });
  const drop = e => {
    if (!drag) return;
    const { el, from, moved } = drag;
    const to = moved ? under(e) : -1;
    drag = null;
    area.querySelectorAll('.drop').forEach(p => p.classList.remove('drop'));
    if (!moved) return;
    // Settle from where it was let go, not from where it started.
    const r = el.getBoundingClientRect(), a = area.getBoundingClientRect();
    el.classList.add('settle');
    el.style.transform = '';
    Object.assign(el.style, { left: r.left - a.left + 'px', top: r.top - a.top + 'px' });
    el.classList.remove('lift');
    void el.offsetWidth;
    el.classList.remove('settle');
    if (to >= 0 && to !== from) ctx.swapPicks(from, to);
    else layoutPanes();
  };
  area.addEventListener('pointerup', drop);
  area.addEventListener('pointercancel', drop);

  $('.shapes').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) ctx.setShape(b.dataset.shape);
  });
  function save() {
    const name = nameIn.value.trim();
    if (!ctx.picked().length) return;
    if (!name) { nameIn.focus(); kit.shake(nameIn); return; }
    ctx.saveDesk(name);
    nameIn.blur();
    kit.toast({ kind: 'jump', line: `desk "${name}" saved`, cmd: `${ctx.picked().length} chats · ${SHAPES.find(s => s[0] === ctx.shape())[1].toLowerCase()}` });
  }
  $('.ed-save').addEventListener('click', save);
  $('.ed-clear').addEventListener('click', () => { ctx.clearPicks(); nameIn.value = ''; });
  $('.ed-go').addEventListener('click', () => kit.openTogether(editor));
  nameIn.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.altKey) { e.preventDefault(); e.stopPropagation(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); nameIn.blur(); }
  });

  /* ---------- the chat list ---------- */
  function shown() {
    const q = kit.search.value.trim().toLowerCase();
    return vm.chats
      .filter(c => !q || title(c).toLowerCase().includes(q) || c.project.name.toLowerCase().includes(q) || (c.branch || '').toLowerCase().includes(q))
      .sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
  }
  function renderList() {
    const chats = shown(), ids = ctx.picked();
    const sig = JSON.stringify([chats.map(c => [c.id, title(c), c.state, ago(c.last)]), ids, ctx.prefs.fork]);
    if (sig === listSig) return;
    listSig = sig;
    list.replaceChildren(...chats.map(c => {
      const li = document.createElement('li');
      const at = ids.indexOf(c.id);
      li.className = 'chi' + (at >= 0 ? ' on' : '') + (kit.canPick(c) ? '' : ' off');
      li.style.setProperty('--acc', accent(c));
      li.innerHTML = '<i></i><div><b></b><small></small></div><span class="slot"></span>';
      li.querySelector('b').textContent = title(c);
      li.querySelector('small').textContent = [c.project.name, c.live ? c.state : ago(c.last)].filter(Boolean).join(' · ');
      li.querySelector('.slot').textContent = at >= 0 ? at + 1 : kit.canPick(c) ? '+' : '';
      li.title = kit.canPick(c) ? (at >= 0 ? 'take it off the desk' : 'add it to the desk') : "it's running: turn on Fork to add a copy of it";
      if (kit.canPick(c)) li.addEventListener('click', () => ctx.togglePick(c));
      return li;
    }));
    if (!chats.length) list.innerHTML = `<li class="none">nothing matches "${kit.search.value.trim().replace(/[<&]/g, '')}"</li>`;
  }

  return {
    update(next) {
      vm = next;
      byId = new Map(vm.chats.map(c => [c.id, c]));
      renderShelf();
      renderBench();
      renderList();
    },
    /** Enter in the search box adds the first chat that matches. */
    addFirst() {
      const c = shown().find(c => kit.canPick(c) && !ctx.picked().includes(c.id));
      if (c) ctx.togglePick(c);
    },
  };
}
