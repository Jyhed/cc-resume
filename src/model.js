// Turns a snapshot from the Rust side into what the themes draw: projects with their chats, each
// chat marked with its live state, plus the running sessions that have no transcript yet.

const STATE = { busy: 'working', waiting: 'waiting', idle: 'done' };
const ORDER = { waiting: 0, working: 1, done: 2 };

export function view(snap) {
  const liveById = new Map(snap.live.map(l => [l.sessionId, l]));
  const projects = snap.projects.map(p => {
    const proj = { ...p, chats: [] };
    proj.chats = p.chats.map(c => {
      const live = liveById.get(c.id) || null;
      return { ...c, project: proj, live, state: live ? STATE[live.status] || 'done' : 'closed' };
    });
    proj.open = proj.chats.filter(c => c.live).length;
    proj.waiting = proj.chats.some(c => c.state === 'waiting');
    proj.working = proj.chats.some(c => c.state === 'working');
    return proj;
  });

  // A session that hasn't sent anything has no transcript yet, but it is running and belongs on screen.
  const known = new Set(projects.flatMap(p => p.chats.map(c => c.id)));
  const orphans = snap.live.filter(l => !known.has(l.sessionId)).map(l => ({
    id: l.sessionId, title: null, named: false, branch: null, first: null,
    last: l.startedAt ? new Date(l.startedAt).toISOString() : null,
    turns: 0, entry: null, kb: 0, live: l, state: STATE[l.status] || 'done', orphan: true,
    project: projects.find(p => samePath(p.path, l.cwd)) || { key: null, name: folderName(l.cwd || ''), path: l.cwd || '', chats: [] },
  }));

  const liveChats = [...projects.flatMap(p => p.chats.filter(c => c.live)), ...orphans]
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.live.startedAt || 0) - (a.live.startedAt || 0));
  const chats = projects.flatMap(p => p.chats);
  return {
    projects, liveChats, chats,
    stats: {
      projects: projects.length,
      chats: chats.length,
      open: liveChats.length,
      waiting: liveChats.filter(c => c.state === 'waiting').length,
      working: liveChats.filter(c => c.state === 'working').length,
    },
    retentionDays: snap.retentionDays ?? null,
    liveError: snap.liveError || null,
    scanning: !!snap.scanning,
  };
}

export const title = c => c.title || (c.live && c.live.name) || 'untitled chat';

function minutesAgo(iso) { return Math.max(0, (Date.now() - Date.parse(iso)) / 60000); }

export function ago(iso) {
  if (!iso) return '';
  const m = minutesAgo(iso);
  if (m < 1) return 'just now';
  if (m < 60) return Math.round(m) + 'm ago';
  if (m < 1440) return Math.round(m / 60) + 'h ago';
  return Math.round(m / 1440) + 'd ago';
}

// Big-number layouts set the value and its unit apart.
export function agoParts(iso) {
  const m = minutesAgo(iso);
  if (m < 60) return [String(Math.max(1, Math.round(m))), 'min'];
  if (m < 1440) { const h = Math.round(m / 60); return [String(h), h === 1 ? 'hr' : 'hrs']; }
  const d = Math.round(m / 1440);
  return [String(d), d === 1 ? 'day' : 'days'];
}

const pad = n => String(n).padStart(2, '0');
export function clock(iso) { const d = new Date(iso); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
export function day(iso) { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }

export function match(p, q) {
  q = (q || '').trim().toLowerCase();
  if (!q) return true;
  return p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q) ||
    p.chats.some(c => title(c).toLowerCase().includes(q) || (c.branch || '').toLowerCase().includes(q));
}

export function pathTail(path, n = 2) {
  return (path || '').replace(/[\\/]+$/, '').split(/[\\/]/).slice(-n).join('\\');
}

export function initial(name) {
  return (name.replace(/^[^a-z0-9~]+/i, '').charAt(0) || '?').toUpperCase();
}

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Pinned projects first, in pin order, then the rest by last activity. */
export function ordered(projects, pins) {
  const at = new Map((pins || []).map((k, i) => [k, i]));
  return projects.slice().sort((a, b) => (at.has(a.key) ? at.get(a.key) : 1e9) - (at.has(b.key) ? at.get(b.key) : 1e9));
}

function samePath(a, b) {
  const norm = s => (s || '').replace(/[\\/]+$/, '').toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

function folderName(path) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}
