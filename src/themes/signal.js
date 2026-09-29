// Signal, the main theme: every project is a folder-tab card, the chats running right now orbit a
// chrome crystal, and a dimmer blends dark into light instead of flipping between them.
import './signal.css';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { title, ago, agoParts, clock, day, match, pathTail, initial, hash, ordered } from '../model.js';
import { pixelSweep, roll, charge, shake } from '../fx.js';
import { desksView, DESKS_TEMPLATE } from './signal-desks.js';
import { thumb } from '../desks.js';

// Waiting pink is a status color, so no card wears it as its own color.
const ACCENTS = ['#2bff5a', '#d4ff1f', '#ffe81f', '#ff6a1a', '#ff7ab8', '#9b6bff', '#1fd6ff'];
const accentOf = key => ACCENTS[hash(key) % ACCENTS.length];
const STATE_ACC = { working: 'var(--work)', waiting: 'var(--wait)', done: 'var(--done)' };
const pad2 = n => String(n).padStart(2, '0');
const svg = (body, box = '0 0 12 12') => `<svg viewBox="${box}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICON = {
  play: '<svg viewBox="0 0 12 12"><path d="M3 1.6v8.8l7.4-4.4z" fill="currentColor"/></svg>',
  jump: svg('<path d="M3 9 9 3M4 3h5v5"/>'),
  fork: svg('<circle cx="3" cy="2.5" r="1.3"/><circle cx="9" cy="2.5" r="1.3"/><circle cx="6" cy="10" r="1.3"/><path d="M3 4v1.2c0 1.6 3 1.6 3 3.4M9 4v1.2c0 1.6-3 1.6-3 3.4"/>'),
  plus: svg('<path d="M6 1.5v9M1.5 6h9"/>'),
  list: svg('<path d="M1.5 3h9M1.5 6h9M1.5 9h6"/>'),
  pick: svg('<rect x="1.5" y="1.5" width="9" height="9" rx="2"/><path d="M6 1.5v9M6 6h4.5"/>'),
  picked: '<svg viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="2.4" fill="currentColor"/><path d="M3.4 6.2 5.2 8l3.4-3.8" fill="none" stroke="var(--card)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  x: svg('<path d="M2 2l8 8M10 2 2 10"/>'),
  min: svg('<path d="M2.5 6h7"/>'),
  dots: '<svg viewBox="0 0 20 6" fill="currentColor"><circle cx="3" cy="3" r="2.4"/><circle cx="10" cy="3" r="2.4"/><circle cx="17" cy="3" r="2.4"/></svg>',
  search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>',
  moon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/></svg>',
  sun: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>',
  desks: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M11.5 4v16M11.5 12H21"/></svg>',
  cards: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 8.5V18a2.5 2.5 0 0 0 2.5 2.5h13A2.5 2.5 0 0 0 21 18V10a2.5 2.5 0 0 0-2.5-2.5H12L10 5H5.5A2.5 2.5 0 0 0 3 7.5Z"/></svg>',
};

const TEMPLATE = `
<header class="bar" data-tauri-drag-region>
  <div class="brand" data-tauri-drag-region><span class="orb" data-tauri-drag-region>cc</span><div data-tauri-drag-region><b data-tauri-drag-region>CC/RESUME</b><small class="sub" data-tauri-drag-region></small></div></div>
  <div class="drag" data-tauri-drag-region></div>
  <label class="search">${ICON.search}<input class="q" placeholder="search projects and chats" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
  <div class="drag" data-tauri-drag-region></div>
  <div class="seg pill-glass"><button type="button" data-mode="window">New window</button><button type="button" data-mode="split">Split pane</button></div>
  <button class="fork pill-glass" type="button" title="open a copy of the chat instead of the chat itself"><i></i>Fork</button>
  <div class="dimmer pill-glass" title="drag for any shade in between">
    <button class="ic" type="button" data-to="0" aria-label="dark">${ICON.moon}</button>
    <div class="track"><span class="knob"></span></div>
    <button class="ic" type="button" data-to="1" aria-label="light">${ICON.sun}</button>
  </div>
  <button class="auto" type="button" title="follow the Windows light or dark setting">auto</button>
  <button class="icb view" type="button"></button>
  <div class="win"><button class="min" type="button" title="minimize">${ICON.min}</button><button class="shut" type="button" title="back to the tray">${ICON.x}</button></div>
</header>
<div class="main">
  <section class="card hero">
    <svg class="shape"><path/></svg>
    <div class="head"><i class="rec"></i><span class="headline">Live now</span></div>
    <div class="count"><span class="num live-num">00</span><sup>open</sup><span class="of"></span></div>
    <div class="field"><canvas></canvas><div class="hud"><i class="v1"></i><i class="v2"></i><i class="h1"></i><i class="h2"></i><span class="a"></span><span class="b"></span><span class="c"></span><span class="d"></span></div></div>
    <ul class="livelist"></ul>
    <div class="legend"><span><i style="background:var(--work)"></i>working</span><span><i style="background:var(--wait)"></i>waiting</span><span><i style="background:var(--done)"></i>done</span></div>
  </section>
  <section class="cards"></section>
  ${DESKS_TEMPLATE}
</div>
<div class="scrim"></div>
<section class="card drawer"><svg class="shape"><path/></svg><button class="close" type="button" aria-label="close">${ICON.x}</button><div class="body"></div></section>
<div class="dock"><div class="layout"></div><div class="say"><b></b><small></small></div><button class="clear" type="button">clear</button><button class="arrange" type="button">Arrange</button><button class="all" type="button">Open together</button></div>
<div class="toast"><i></i><div><b></b><code></code></div></div>`;

// Folder-tab silhouette: the left part stands up as a tab, the right part steps down and leaves a
// notch where the menu dots sit.
function folder(w, h, step, tab) {
  const r = 28, cw = 36;
  return `M${r},0 H${tab - cw / 2} C${tab},0 ${tab},${step} ${tab + cw / 2},${step} H${w - r} A${r},${r} 0 0 1 ${w},${step + r} V${h - r} A${r},${r} 0 0 1 ${w - r},${h} H${r} A${r},${r} 0 0 1 0,${h - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`;
}
function shape(svgEl, w, h, step, tabFrac) {
  svgEl.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svgEl.querySelector('path').setAttribute('d', folder(w, h, step, w * tabFrac));
}

export function mount(host, ctx) {
  const root = document.createElement('div');
  root.className = 'sig';
  root.innerHTML = TEMPLATE;
  host.appendChild(root);
  const $ = s => root.querySelector(s);
  const q = $('.q');
  const cardsBox = $('.cards');
  const cards = new Map();
  const pills = new Map();
  const scheme = matchMedia('(prefers-color-scheme: light)');
  let vm = null;
  let sel = 0;
  let drawer = { key: null, row: 0, sig: '' };
  const on = (el, ev, fn, opt) => el.addEventListener(ev, fn, opt);

  /* ---------- actions ---------- */
  function toast(r) {
    const t = $('.toast');
    t.querySelector('i').className = r.kind === 'jump' ? 'jump' : r.kind === 'error' ? 'error' : '';
    t.querySelector('b').textContent = r.line;
    t.querySelector('code').textContent = r.cmd || '';
    t.classList.remove('in');
    void t.offsetWidth;
    t.classList.add('in');
  }
  // The light starts crossing the moment you click, so the wait for the terminal reads as part of
  // the motion. The label turns over once the light has reached the middle, however fast the answer.
  async function launch(run, surface, label) {
    if (surface) { pixelSweep(surface); charge(surface); }
    const midway = new Promise(r => setTimeout(r, surface ? 520 : 0));
    try {
      const [r] = await Promise.all([run(), midway]);
      if (label) roll(label, r.line);
      toast(r);
      crystal.pulse();
    } catch (err) {
      await midway;
      if (surface) shake(surface);
      toast({ kind: 'error', line: String(err), cmd: '' });
    }
  }
  const resume = (chat, surface, label) => launch(() => ctx.resume(chat), surface, label);
  const chatIcon = c => (ctx.prefs.fork ? 'fork' : c.live ? 'jump' : 'play');
  const chatVerb = c => (ctx.prefs.fork ? 'fork this chat' : c.live ? 'jump to its window' : 'resume in ' + (ctx.prefs.mode === 'split' ? 'a split pane' : 'its own window'));
  function gbtn(icon, tip, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gbtn';
    b.title = tip;
    b.innerHTML = ICON[icon];
    b.addEventListener('click', e => { e.stopPropagation(); fn(); });
    return b;
  }

  /* ---------- hero ---------- */
  function renderHero() {
    const s = vm.stats;
    $('.sub').textContent = `${s.projects} projects · ${s.chats} chats`;
    $('.headline').textContent = vm.scanning ? 'Reading your chats…' : s.open ? 'Live now' : 'Nothing running';
    $('.rec').className = 'rec' + (s.waiting ? ' hot' : s.working ? ' busy' : '');
    $('.live-num').textContent = pad2(s.open);
    $('.of').innerHTML = `of ${s.chats} chats` + (s.waiting ? `<br><b>${pad2(s.waiting)} waiting on you</b>` : s.working ? `<br>${pad2(s.working)} working` : '');
    $('.hud .a').textContent = `field / ${pad2(s.projects)} prj`;
    $('.hud .b').innerHTML = `${pad2(s.working)} working` + (s.waiting ? `<br><span class="blink" style="position:static">${pad2(s.waiting)} waiting</span>` : '');
    $('.hud .d').textContent = s.open ? 'it spins with the work' : 'at rest';
    renderLive();
  }
  function renderLive() {
    const ul = $('.livelist');
    if (!vm.liveChats.length) {
      pills.clear();
      ul.innerHTML = '<li class="empty">no chats running.<br>pick one from the cards to resume it.</li>';
      return;
    }
    ul.querySelector('.empty')?.remove();
    keyed(ul, pills, vm.liveChats, c => c.id, () => {
      const li = document.createElement('li');
      li.innerHTML = '<div class="tx"><b></b><small></small></div>';
      li.append(gbtn('jump', '', () => resume(li._chat, li, li.querySelector('b'))));
      return li;
    }, (li, c) => {
      li._chat = c;
      li.className = 'lp ' + c.state;
      li.style.setProperty('--acc', STATE_ACC[c.state]);
      setText(li.querySelector('b'), title(c));
      const why = c.state === 'waiting' && c.live.waitingFor ? 'waiting: ' + c.live.waitingFor : c.state;
      li.querySelector('small').textContent = [why, c.project.name, c.last && ago(c.last)].filter(Boolean).join(' · ');
      const b = li.querySelector('.gbtn');
      b.innerHTML = ICON[ctx.prefs.fork ? 'fork' : 'jump'];
      b.title = ctx.prefs.fork ? 'fork this chat' : 'jump to its window';
    });
  }

  /* ---------- project cards ---------- */
  const visible = () => ordered(vm.projects, ctx.prefs.pins).filter(p => match(p, q.value));
  function renderCards() {
    const list = visible();
    cardsBox.querySelector('.none')?.remove();
    keyed(cardsBox, cards, list, p => p.key, makeCard, fillCard);
    if (!list.length) {
      const none = document.createElement('div');
      none.className = 'none';
      none.textContent = vm.projects.length ? `nothing matches "${q.value.trim()}"` : vm.scanning ? 'reading your chats…' : 'no Claude Code chats on this PC yet';
      cardsBox.appendChild(none);
    }
    sel = Math.min(sel, Math.max(0, list.length - 1));
    list.forEach((p, i) => cards.get(p.key).classList.toggle('sel', i === sel && !!(q.value || selTouched)));
    sizeCards();
  }
  let selTouched = false;
  function makeCard() {
    const el = document.createElement('article');
    el.className = 'card proj';
    el.innerHTML = '<svg class="shape"><path/></svg><button class="dots" type="button">' + ICON.dots + '</button>' +
      '<div class="ph"><span class="ico"></span><div><b></b><small></small></div></div>' +
      '<div class="big"><span class="num"></span><sup></sup><span class="side"></span></div>' +
      '<div class="pill"><div class="pt"><span class="t"></span><span class="k"></span></div><div class="tline"></div></div>' +
      '<div class="pf"></div>';
    const pf = el.querySelector('.pf');
    pf.append(
      gbtn('play', '', () => resume(el._p.chats[0], el.querySelector('.pill'), el.querySelector('.pt .t'))),
      gbtn('plus', 'new chat in this folder', () => launch(() => ctx.newChat(el._p), el.querySelector('.pill'))),
      gbtn('list', 'all chats', () => openDrawer(el._p)),
      gbtn('pick', '', () => ctx.togglePick(el._p.chats[0])),
      document.createElement('small'),
    );
    el.querySelector('.dots').addEventListener('click', e => { e.stopPropagation(); ctx.togglePin(el._p.key); });
    el.addEventListener('click', () => { sel = visible().indexOf(el._p); openDrawer(el._p); });
    return el;
  }
  function fillCard(el, p) {
    el._p = p;
    const pinned = ctx.prefs.pins.includes(p.key);
    const c0 = p.chats[0];
    const sig = JSON.stringify([p.last, p.chats.length, p.chats.map(c => c.state).join(), title(c0), c0.turns, c0.branch, agoParts(p.last), ctx.prefs.fork, ctx.prefs.mode, pinned, ctx.picked().includes(c0.id)]);
    if (el._sig === sig) return;
    el._sig = sig;
    el.style.setProperty('--acc', accentOf(p.key));
    const dots = el.querySelector('.dots');
    dots.classList.toggle('pinned', pinned);
    dots.title = pinned ? 'unpin' : 'pin to the front';
    el.querySelector('.ico').textContent = initial(p.name);
    el.querySelector('.ph b').textContent = p.name;
    el.querySelector('.ph small').textContent = pathTail(p.path);
    const [n, unit] = agoParts(p.last);
    el.querySelector('.big .num').textContent = n;
    el.querySelector('.big sup').textContent = unit + ' ago';
    el.querySelector('.big .side').innerHTML = `<b>${p.chats.length}</b> chat${p.chats.length === 1 ? '' : 's'}`;
    el.querySelector('.state')?.remove();
    const hot = p.chats.find(c => c.state === 'waiting') || p.chats.find(c => c.state === 'working') || p.chats.find(c => c.state === 'done');
    if (hot) el.insertAdjacentHTML('beforeend', `<span class="state ${hot.state}"><i></i>${hot.state}</span>`);
    setText(el.querySelector('.pt .t'), title(c0));
    el.querySelector('.pt .k').textContent = clock(c0.last);
    // The dots are this project's chats over the last week, newest on the right.
    const line = el.querySelector('.tline');
    line.replaceChildren(...p.chats.filter(c => Date.now() - Date.parse(c.last) < 7 * 864e5).map(c => {
      const i = document.createElement('i');
      if (c.live) i.className = 'lv';
      i.style.left = (100 - (Date.now() - Date.parse(c.last)) / (7 * 864e5) * 100).toFixed(1) + '%';
      return i;
    }));
    const go = el.querySelector('.pf .gbtn');
    go.innerHTML = ICON[chatIcon(c0)];
    go.title = chatVerb(c0) + ': ' + title(c0);
    pickButton(el.querySelectorAll('.pf .gbtn')[3], c0);
    el.querySelector('.pf small').textContent = [c0.branch, c0.turns + ' turns', day(c0.last)].filter(Boolean).join(' · ');
  }
  // Every card shares one size, so one measurement shapes them all.
  let cardSize = '';
  function sizeCards() {
    const first = cardsBox.querySelector('.proj');
    if (!first) return;
    const w = first.offsetWidth, h = first.offsetHeight;
    const key = w + 'x' + h + ':' + cards.size;
    if (key === cardSize) return;
    cardSize = key;
    cardsBox.querySelectorAll('.proj > .shape').forEach(s => shape(s, w, h, 20, 0.58));
  }

  /* ---------- drawer ---------- */
  function openDrawer(p) {
    drawer = { key: p.key, row: 0, sig: '' };
    renderDrawer();
    $('.drawer').classList.add('on');
    $('.scrim').classList.add('on');
    const d = $('.drawer');
    shape(d.querySelector('.shape'), d.offsetWidth, d.offsetHeight, 24, 0.55);
  }
  function closeDrawer() {
    drawer.key = null;
    $('.drawer').classList.remove('on');
    $('.scrim').classList.remove('on');
  }
  function renderDrawer() {
    if (!drawer.key) return;
    const p = vm.projects.find(x => x.key === drawer.key);
    if (!p) return closeDrawer();
    const sig = JSON.stringify([p.chats.map(c => [c.id, c.state, title(c), c.turns, ago(c.last)]), ctx.prefs.fork, ctx.prefs.mode, ctx.picked()]);
    if (sig !== drawer.sig) {
      drawer.sig = sig;
      const body = $('.drawer .body');
      body.innerHTML = '<div class="ph"><span class="ico"></span><div><b></b><small></small></div></div><ul class="rows"></ul><button class="new" type="button">+ new chat in this folder</button>';
      body.querySelector('.ico').textContent = initial(p.name);
      body.querySelector('.ph b').textContent = p.name;
      body.querySelector('.ph small').textContent = p.path;
      $('.drawer').style.setProperty('--acc', accentOf(p.key));
      const ul = body.querySelector('.rows');
      p.chats.forEach((c, i) => {
        const li = document.createElement('li');
        li.className = 'row' + (c.live ? ' hot' : '');
        if (c.live) li.style.setProperty('--acc', STATE_ACC[c.state]);
        li.innerHTML = '<div class="tx"><b></b><small></small></div>';
        li.querySelector('b').textContent = title(c);
        const tags = [c.branch, ago(c.last), c.turns + ' turns', c.entry === 'claude-desktop' ? 'desktop app' : null, c.live ? (c.state === 'waiting' && c.live.waitingFor ? 'waiting: ' + c.live.waitingFor : c.state) : null];
        li.querySelector('small').textContent = tags.filter(Boolean).join(' · ');
        const pick = gbtn('pick', '', () => ctx.togglePick(c));
        pick.classList.add('pick');
        pickButton(pick, c);
        li.append(pick, gbtn(chatIcon(c), chatVerb(c), () => resume(c, li, li.querySelector('b'))));
        li.addEventListener('click', () => { drawer.row = i; markRow(); });
        li.addEventListener('dblclick', () => resume(c, li, li.querySelector('b')));
        ul.appendChild(li);
      });
      body.querySelector('.new').addEventListener('click', () => launch(() => ctx.newChat(p), null));
    }
    markRow();
  }
  function markRow() {
    const rows = root.querySelectorAll('.drawer .row');
    drawer.row = Math.max(0, Math.min(drawer.row, rows.length - 1));
    rows.forEach((r, i) => r.classList.toggle('sel', i === drawer.row));
    rows[drawer.row]?.scrollIntoView({ block: 'nearest' });
  }
  on($('.drawer .close'), 'click', closeDrawer);
  on($('.scrim'), 'click', closeDrawer);

  /* ---------- controls ---------- */
  function syncControls() {
    root.querySelectorAll('.bar .seg button').forEach(b => b.classList.toggle('on', b.dataset.mode === ctx.prefs.mode));
    $('.fork').classList.toggle('on', ctx.prefs.fork);
    $('.auto').classList.toggle('on', ctx.prefs.autoTheme);
  }
  on($('.bar .seg'), 'click', e => {
    const b = e.target.closest('button');
    if (b) { ctx.setPrefs({ mode: b.dataset.mode }); syncControls(); update(vm); }
  });
  on($('.fork'), 'click', () => { ctx.setPrefs({ fork: !ctx.prefs.fork }); syncControls(); update(vm); });
  on($('.view'), 'click', () => showView(view === 'desks' ? 'chats' : 'desks'));
  on($('.min'), 'click', () => ctx.minimize());
  on($('.shut'), 'click', () => ctx.hide());
  on(q, 'input', () => { sel = 0; renderCards(); desks.update(vm); });

  /* ---------- the dimmer: dark and light as one continuous range ---------- */
  function applyMix(v, animate) {
    root.classList.toggle('dragging', !animate);
    root.style.setProperty('--mix', Math.max(0, Math.min(1, v)).toFixed(4));
  }
  const settle = v => ctx.setPrefs({ mix: v, autoTheme: false });
  root.querySelectorAll('.dimmer .ic').forEach(b => on(b, 'click', () => { applyMix(+b.dataset.to, true); settle(+b.dataset.to); syncControls(); }));
  const track = $('.track');
  const fromPointer = e => { const r = track.getBoundingClientRect(); return (e.clientX - r.left - 11) / (r.width - 22); };
  let dragging = false;
  on(track, 'pointerdown', e => { track.setPointerCapture(e.pointerId); dragging = true; applyMix(fromPointer(e), false); });
  on(track, 'pointermove', e => { if (dragging) applyMix(fromPointer(e), false); });
  on(track, 'pointerup', e => {
    dragging = false;
    let m = Math.max(0, Math.min(1, fromPointer(e)));
    // Text crosses over inside this band, so the dimmer never comes to rest where ink and card share a grey.
    if (m > 0.43 && m < 0.57) m = m < 0.5 ? 0.43 : 0.57;
    applyMix(m, true);
    settle(m);
    syncControls();
  });
  on($('.auto'), 'click', () => {
    const autoTheme = !ctx.prefs.autoTheme;
    ctx.setPrefs({ autoTheme });
    if (autoTheme) applyMix(scheme.matches ? 1 : 0, true);
    syncControls();
  });
  on(scheme, 'change', () => { if (ctx.prefs.autoTheme) applyMix(scheme.matches ? 1 : 0, true); });
  applyMix(ctx.prefs.autoTheme ? (scheme.matches ? 1 : 0) : ctx.prefs.mix, false);
  syncControls();

  /* ---------- keyboard ---------- */
  function onKey(e) {
    const typing = document.activeElement === q;
    if (e.key === 'Enter' && e.altKey) {
      if (ctx.picked().length) openTogether(view === 'desks' ? $('.editor') : $('.dock'));
      return true;
    }
    // Other fields (a desk's name) keep their own keys.
    if (document.activeElement?.matches('input') && !typing) return false;
    if (view === 'desks') {
      if (e.key === 'Escape') {
        if (q.value) { q.value = ''; desks.update(vm); } else showView('chats');
        return true;
      }
      if (e.key === 'Enter' && typing) { desks.addFirst(); return true; }
      if (e.key === '/' && !typing) { q.focus(); q.select(); return true; }
      if (e.key.length === 1 && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) q.focus();
      return false;
    }
    if (drawer.key) {
      if (e.key === 'Escape') { closeDrawer(); return true; }
      if (e.key === ' ') {
        const p = vm.projects.find(x => x.key === drawer.key);
        const c = p && p.chats[drawer.row];
        if (c && canPick(c)) ctx.togglePick(c);
        return true;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { drawer.row += e.key === 'ArrowDown' ? 1 : -1; markRow(); return true; }
      if (e.key === 'Enter') {
        const li = root.querySelectorAll('.drawer .row')[drawer.row];
        const p = vm.projects.find(x => x.key === drawer.key);
        if (li && p) resume(p.chats[drawer.row], li, li.querySelector('b'));
        return true;
      }
      return false;
    }
    const list = visible();
    if (e.key === 'Escape') {
      if (q.value) { q.value = ''; sel = 0; renderCards(); return true; }
      return false;
    }
    if (e.key === '/' && !typing) { q.focus(); q.select(); return true; }
    const cols = getComputedStyle(cardsBox).gridTemplateColumns.split(' ').length;
    const step = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: typing ? 0 : 1, ArrowLeft: typing ? 0 : -1 }[e.key];
    if (step) {
      selTouched = true;
      sel = Math.max(0, Math.min(list.length - 1, sel + step));
      renderCards();
      cards.get(list[sel]?.key)?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (e.key === 'Enter' && list[sel]) {
      const p = list[sel], el = cards.get(p.key);
      // Ctrl+Enter skips the drawer and goes straight back into the latest chat.
      if (e.ctrlKey) resume(p.chats[0], el.querySelector('.pill'), el.querySelector('.pt .t'));
      else openDrawer(p);
      return true;
    }
    if (e.key.length === 1 && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) q.focus();
    return false;
  }

  /* ---------- crystal ---------- */
  const crystal = crystalField($('.field'), root);
  setInterval(() => {
    const d = new Date();
    $('.hud .c').textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} local`;
  }, 1000);
  new ResizeObserver(() => { const h = $('.hero'); shape(h.querySelector('.shape'), h.offsetWidth, h.offsetHeight, 24, 0.5); }).observe($('.hero'));
  new ResizeObserver(() => { cardSize = ''; sizeCards(); }).observe(cardsBox);

  /* ---------- picking chats to open together ---------- */
  // A running chat can't get a second copy, so it can only be picked when forking.
  const canPick = c => !c.live || ctx.prefs.fork;
  function pickButton(b, c) {
    const on = ctx.picked().includes(c.id);
    b.hidden = !canPick(c);
    b.classList.toggle('on', on);
    b.innerHTML = ICON[on ? 'picked' : 'pick'];
    b.title = on ? 'take it out of the group' : 'pick it to open together with others';
  }
  function renderDock() {
    const ids = ctx.picked();
    const dock = $('.dock');
    root.classList.toggle('picking', ids.length > 0);
    if (!ids.length) return;
    // The layout the terminal will build, drawn small: what you pick is what opens.
    $('.dock .layout').innerHTML = thumb(ctx.shape(), ids.length, () => 'var(--work)');
    const names = ids.map(id => vm.chats.find(c => c.id === id)).filter(Boolean).map(c => title(c));
    dock.querySelector('b').textContent = `${ids.length} chat${ids.length === 1 ? '' : 's'} ${ctx.prefs.fork ? 'to fork' : 'to open'} side by side`;
    dock.querySelector('small').textContent = names.join(' \u00b7 ');
  }
  const openTogether = surface => launch(() => ctx.openTogether(), surface, null);
  on($('.dock .all'), 'click', () => openTogether($('.dock')));
  on($('.dock .clear'), 'click', () => ctx.clearPicks());
  on($('.dock .arrange'), 'click', () => showView('desks'));

  /* ---------- chats or desks ---------- */
  // The app opens on whichever view was in use last.
  let view = 'chats';
  function showView(next) {
    view = next;
    if (ctx.prefs.view !== view) ctx.setPrefs({ view });
    root.classList.toggle('view-desks', view === 'desks');
    const b = $('.view');
    b.innerHTML = ICON[view === 'desks' ? 'cards' : 'desks'];
    b.title = view === 'desks' ? 'back to your chats' : 'desks: chats you opened together';
    q.placeholder = view === 'desks' ? 'search chats to add' : 'search projects and chats';
    closeDrawer();
    if (vm) update(vm);
  }
  const desks = desksView(root, ctx, {
    launch, toast, shake, gbtn, canPick, keyed, shape, search: q,
    accent: c => accentOf(c.project.key),
    openTogether,
  });
  showView(ctx.prefs.view === 'desks' ? 'desks' : 'chats');

  function update(next) {
    vm = next;
    renderDock();
    renderHero();
    renderCards();
    renderDrawer();
    desks.update(vm);
    crystal.setLive(vm.liveChats);
  }

  return {
    update,
    onKey,
    focusSearch() { q.focus(); q.select(); },
  };
}

/** Keeps `box`'s children in the order of `items`, creating, filling and dropping nodes by key. */
function keyed(box, map, items, keyOf, make, fill) {
  const keep = new Set();
  let prev = null;
  for (const item of items) {
    const k = keyOf(item);
    let el = map.get(k);
    if (!el) { el = make(); map.set(k, el); }
    fill(el, item);
    const want = prev ? prev.nextElementSibling : box.firstElementChild;
    if (want !== el) box.insertBefore(el, want);
    prev = el;
    keep.add(k);
  }
  for (const [k, el] of map) if (!keep.has(k)) { el.remove(); map.delete(k); }
}

/** Updates text unless a roll animation owns the element right now. */
function setText(el, text) {
  if (!el.dataset.rolling && el.textContent !== text) el.textContent = text;
}

/* ---------- the crystal and its orbit ---------- */
function crystalField(field, root) {
  const canvas = field.querySelector('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.02);
  scene.environment = env.texture;
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 30);
  camera.position.set(0, 0, 6.4);

  // Six faceted arms with side branches, merged into one chrome body.
  function spike(len, width) {
    const s = new THREE.Shape();
    s.moveTo(0, 0); s.lineTo(width, width * 1.4); s.lineTo(width * 0.8, len - width * 1.6); s.lineTo(0, len); s.lineTo(-width * 0.8, len - width * 1.6); s.lineTo(-width, width * 1.4); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.07, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.035, bevelSegments: 1 });
    g.translate(0, 0, -0.035);
    return g;
  }
  const parts = [];
  for (let k = 0; k < 6; k++) {
    const a = k / 6 * Math.PI * 2;
    const arm = spike(1.35, 0.1); arm.translate(0, 0.18, 0); arm.rotateZ(a); parts.push(arm);
    for (const [at, len] of [[0.62, 0.46], [0.98, 0.3]]) for (const side of [-1, 1]) {
      const b = spike(len, 0.06); b.rotateZ(side * Math.PI / 3); b.translate(0, 0.18 + at, 0); b.rotateZ(a); parts.push(b);
    }
  }
  const hex = new THREE.Shape();
  for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2 + Math.PI / 6; if (k) hex.lineTo(Math.cos(a) * 0.36, Math.sin(a) * 0.36); else hex.moveTo(Math.cos(a) * 0.36, Math.sin(a) * 0.36); }
  hex.closePath();
  const core = new THREE.ExtrudeGeometry(hex, { depth: 0.12, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 1 });
  core.translate(0, 0, -0.06);
  parts.push(core);
  const crystalGeo = mergeGeometries(parts.map(g => (g.index ? g.toNonIndexed() : g)));
  parts.forEach(g => g.dispose());
  crystalGeo.computeVertexNormals();
  const chrome = new THREE.MeshPhysicalMaterial({ color: 0xe8edf4, metalness: 1, roughness: 0.1, iridescence: 0.55, iridescenceIOR: 1.7, iridescenceThicknessRange: [180, 520], flatShading: true });
  const crystal = new THREE.Mesh(crystalGeo, chrome);
  scene.add(crystal);

  const dotCanvas = document.createElement('canvas');
  dotCanvas.width = dotCanvas.height = 64;
  const dg = dotCanvas.getContext('2d');
  const grad = dg.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.35, 'rgba(255,255,255,.8)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  dg.fillStyle = grad; dg.fillRect(0, 0, 64, 64);
  const dotTex = new THREE.CanvasTexture(dotCanvas);
  const layer = (positions, colors, size, blending) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ map: dotTex, size, vertexColors: true, transparent: true, depthWrite: false, blending }));
  };
  // Glow reads on black and ink reads on white, so each set of dots exists twice and cross-fades with the dimmer.
  const NA = 150, amb = new Float32Array(NA * 3), ambCol = new Float32Array(NA * 3);
  const base = [new THREE.Color('#2bff5a'), new THREE.Color('#9b6bff'), new THREE.Color('#9a9a9a')];
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < NA; i++) {
    const r = 1.9 + rnd() * 1.5, a = rnd() * Math.PI * 2, y = (rnd() - 0.5) * 2.4;
    amb.set([Math.cos(a) * r, y, Math.sin(a) * r * 0.6 - 0.5], i * 3);
    const c = base[i % 3];
    ambCol.set([c.r, c.g, c.b], i * 3);
  }
  const ambGlow = layer(amb, ambCol, 0.07, THREE.AdditiveBlending);
  const ambInk = layer(amb, ambCol, 0.06, THREE.NormalBlending);
  const swarm = new THREE.Group();
  swarm.add(ambGlow, ambInk);
  scene.add(swarm);

  const STATE_COL = { working: new THREE.Color('#2bff5a'), waiting: new THREE.Color('#ff2d6f'), done: new THREE.Color('#f2f2f2') };
  let live = [], liveGlow = null, liveInk = null, livePos = null, liveSig = null;
  function setLive(chats) {
    const sig = chats.map(c => c.id + c.state).join();
    if (sig === liveSig) { live = chats; return; }
    liveSig = sig;
    live = chats;
    for (const l of [liveGlow, liveInk]) if (l) { scene.remove(l); l.geometry.dispose(); l.material.dispose(); }
    livePos = new Float32Array(chats.length * 3);
    const cols = new Float32Array(chats.length * 3);
    chats.forEach((c, i) => { const col = STATE_COL[c.state]; cols.set([col.r, col.g, col.b], i * 3); });
    liveGlow = layer(livePos, cols, 0.34, THREE.AdditiveBlending);
    liveInk = layer(livePos, cols.map(v => v * 0.8), 0.22, THREE.NormalBlending);
    scene.add(liveGlow, liveInk);
  }

  let burst = 0, spin = 0, last = performance.now();
  const resize = () => {
    const w = field.clientWidth, h = field.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(field);
  resize();

  function tick(now) {
    requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const mix = parseFloat(getComputedStyle(root).getPropertyValue('--mix')) || 0;
    const working = live.filter(c => c.state === 'working').length;
    burst = Math.max(0, burst - dt * 0.8);
    spin += dt * (0.22 + working * 0.08 + burst * 2.2);
    crystal.rotation.set(Math.sin(now / 2600) * 0.3, Math.sin(now / 1900) * 0.55, spin);
    crystal.scale.setScalar(0.92 * (1 + burst * 0.08));
    live.forEach((c, i) => {
      const a = now / 1000 * (c.state === 'working' ? 0.9 : 0.35) + i * 2.1, r = 1.55 + (i % 2) * 0.35;
      livePos.set([Math.cos(a) * r, Math.sin(a * 0.7 + i) * 0.55, Math.sin(a) * r * 0.55], i * 3);
    });
    if (liveGlow) {
      liveGlow.geometry.attributes.position.needsUpdate = true;
      liveInk.geometry.attributes.position.needsUpdate = true;
      liveGlow.material.opacity = 1 - mix;
      liveInk.material.opacity = mix;
    }
    ambGlow.material.opacity = 1 - mix;
    ambInk.material.opacity = mix;
    swarm.rotation.y = now / 9000;
    scene.environmentIntensity = 1.05 - mix * 0.2;
    renderer.render(scene, camera);
  }
  requestAnimationFrame(tick);

  return {
    setLive,
    pulse() { burst = 1; },
  };
}
