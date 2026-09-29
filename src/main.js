// Boots the window: loads prefs and the first snapshot, mounts the UI, and keeps it fed with live
// updates from the Rust side.
import './styles/fonts.css';
import './styles/app.css';
import { api } from './api.js';
import { view } from './model.js';
import { tree, opened, saved } from './desks.js';
import { mount } from './themes/signal.js';

const host = document.getElementById('app');
let snap = null;
let prefs = null;
let ui = null;
// The arrangement being built: chats in pane order, the shape they open in, and the saved desk it
// came from, if any. Kept here so it survives anything the UI rebuilds.
const picked = [];
let shape = 'grid';
let deskId = null;

function setPrefs(patch) {
  prefs = { ...prefs, ...patch };
  api.savePrefs(prefs).catch(err => console.error('saving prefs failed', err));
}

async function openArrangement(slots, shapeName, fromDesk) {
  const r = await api.openTogether(slots, tree(shapeName, slots.length), prefs.fork);
  setPrefs({ desks: opened(prefs.desks, { shape: shapeName, slots, deskId: fromDesk, now: Date.now() }) });
  return r;
}

const ctx = {
  get prefs() { return prefs; },
  setPrefs,
  resume(chat) { return chat.orphan ? api.jump(chat.id) : api.resume(chat.id, prefs.mode, prefs.fork); },
  newChat(project) { return api.newChat(project.key, prefs.mode); },

  picked: () => picked,
  shape: () => shape,
  deskId: () => deskId,
  togglePick(chat) {
    const i = picked.indexOf(chat.id);
    if (i >= 0) picked.splice(i, 1);
    else picked.push(chat.id);
    refresh();
  },
  swapPicks(a, b) {
    [picked[a], picked[b]] = [picked[b], picked[a]];
    refresh();
  },
  setShape(s) { shape = s; refresh(); },
  clearPicks() { picked.length = 0; deskId = null; refresh(); },
  async openTogether() {
    const r = await openArrangement(picked.slice(), shape, deskId);
    picked.length = 0;
    deskId = null;
    refresh();
    return r;
  },

  /** Puts a desk on the bench to change it; only chats that still exist come along. */
  editDesk(desk, known) {
    picked.splice(0, picked.length, ...desk.slots.filter(known));
    shape = desk.shape;
    deskId = desk.id;
    refresh();
  },
  saveDesk(name) {
    const [desks, id] = saved(prefs.desks, { name, shape, slots: picked, deskId, now: Date.now() });
    deskId = id;
    setPrefs({ desks });
    refresh();
  },
  openDesk(desk) { return openArrangement(desk.slots, desk.shape, desk.id).finally(refresh); },
  deleteDesk(id) {
    if (deskId === id) deskId = null;
    setPrefs({ desks: prefs.desks.filter(d => d.id !== id) });
    refresh();
  },

  togglePin(key) {
    const pins = prefs.pins.includes(key) ? prefs.pins.filter(k => k !== key) : [...prefs.pins, key];
    setPrefs({ pins });
    refresh();
  },
  hide: () => api.hide(),
  minimize: () => api.minimize(),
};

function refresh() {
  if (ui && snap) ui.update(view(snap));
  showNotice();
}

/* ---------- one-time notices ---------- */
const bar = document.createElement('div');
bar.className = 'notice';
document.body.appendChild(bar);
const dismissed = new Set();
let shown = null;
let failure = null;

function showNotice() {
  if (!snap || !prefs) return;
  const days = snap.retentionDays;
  const notices = [];
  if ((days == null || days <= 30) && !prefs.retentionDismissed) {
    notices.push({
      key: 'retention',
      text: `Claude Code deletes chats after ${days ?? 30} days, and they drop off this list with them.`,
      actions: [
        ['yes', 'Keep them a year', () => api.keepChats(365).catch(err => { failure = String(err); dismissed.add('retention'); showNotice(); })],
        ['no', 'Not now', () => setPrefs({ retentionDismissed: true })],
      ],
    });
  }
  if (failure) notices.unshift({ key: 'failure:' + failure, text: failure, actions: [['no', 'OK', () => { failure = null; }]] });
  if (snap.liveError) {
    notices.push({ key: 'live', text: `Running chats can't be read right now: ${snap.liveError}.`, actions: [['no', 'OK', () => dismissed.add('live')]] });
  }
  const next = notices.find(n => !dismissed.has(n.key)) || null;
  if ((next && next.key) === shown) return;
  shown = next && next.key;
  bar.classList.toggle('on', !!next);
  if (!next) return;
  bar.replaceChildren(Object.assign(document.createElement('span'), { textContent: next.text }));
  for (const [cls, label, fn] of next.actions) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: label });
    b.addEventListener('click', () => { fn(); showNotice(); });
    bar.appendChild(b);
  }
}

window.addEventListener('keydown', e => {
  if (ui?.onKey(e)) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') ctx.hide();
});

// Updates can land while the first snapshot is still on its way; whichever is newer wins.
function take(s) {
  if (snap && s.now < snap.now) return;
  snap = s;
  refresh();
}

(async () => {
  await Promise.all([
    api.on('snapshot', take),
    api.on('summoned', () => ui?.focusSearch()),
  ]);
  const [p, s] = await Promise.all([api.prefs(), api.snapshot()]);
  // Chats used to open as tabs; each now gets its own window unless a split is asked for.
  prefs = { ...p, mode: p.mode === 'split' ? 'split' : 'window', desks: p.desks || [] };
  if (!snap || s.now >= snap.now) snap = s;
  ui = mount(host, ctx);
  refresh();
  // Relative times ("12m ago") age even when nothing new arrives.
  setInterval(refresh, 30000);
  requestAnimationFrame(() => api.ready());
})();
