// A made-up machine for previewing the UI in a plain browser: projects, chats and running
// sessions in the shape the Rust side sends. Times are built from the moment of the request, so
// "4m ago" stays true however old this file gets.

const HOME = 'C:\\Users\\you\\code';
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

// [project, [title, age, turns, branch, live status?, waiting for?]]
const PROJECTS = [
  ['neon-garage', [
    ['Drift camera shake', 4 * MIN, 38, 'feat/drift-cam', 'busy'],
    ['Garage lighting pass', 3 * HOUR, 22, 'main'],
    ['Tire smoke particles', 2 * DAY, 51, 'main'],
  ]],
  ['atlas-api', [
    ['Rate limiter rewrite', 9 * MIN, 64, 'fix/limiter', 'waiting', 'permission: Bash'],
    ['Postgres migration 042', 1 * DAY, 17, 'main'],
  ]],
  ['synth-lab', [
    ['Oscillator bank refactor', 16 * MIN, 29, 'dev', 'busy'],
    ['MIDI clock drift', 6 * HOUR, 12, 'dev'],
  ]],
  ['orbit-ui', [
    ['Command palette', 42 * MIN, 45, 'feat/palette', 'idle'],
    ['Dark mode tokens', 2 * DAY, 19, 'main'],
    ['Focus rings audit', 4 * DAY, 8, 'main'],
  ]],
  ['pixel-forge', [
    ['Sprite atlas packer', 2 * HOUR, 33, 'main'],
    ['Palette swap shader', 3 * DAY, 26, 'shader'],
  ]],
  ['tiny-compiler', [
    ['Parser error recovery', 5 * HOUR, 57, 'parser'],
    ['Register allocation', 5 * DAY, 71, 'main'],
  ]],
  ['vr-sketch', [
    ['Hand tracking jitter', 1 * DAY, 23, 'main'],
  ]],
  ['field-notes', [
    ['Weekly research digest', 8 * HOUR, 6, null],
  ]],
  ['shop-front', [
    ['Checkout flow bug', 2 * DAY, 31, 'hotfix'],
    ['Stripe webhook retries', 6 * DAY, 14, 'main'],
  ]],
  ['dotfiles', [
    ['Clink prompt tweaks', 3 * DAY, 9, 'main'],
  ]],
];

// Stable ids that read like real session ids, so picks and saved desks survive a reload.
function idOf(project, i) {
  let h = 2166136261, hex = '';
  for (let round = 0; hex.length < 32; round++) {
    for (const ch of project + ':' + i + ':' + round) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    hex += (h >>> 0).toString(16).padStart(8, '0');
  }
  return [hex.slice(0, 8), hex.slice(8, 12), '4' + hex.slice(13, 16), '8' + hex.slice(17, 20), hex.slice(20, 32)].join('-');
}

export function demoSnapshot(now = Date.now()) {
  const live = [];
  const projects = PROJECTS.map(([name, chats]) => {
    const path = `${HOME}\\${name}`;
    const list = chats.map(([title, age, turns, branch, status, waitingFor], i) => {
      const id = idOf(name, i);
      const last = now - age;
      if (status) {
        live.push({ pid: 4100 + live.length * 37, sessionId: id, cwd: path, kind: 'interactive', startedAt: last - 40 * MIN, name: title, status, waitingFor: waitingFor || null });
      }
      return { id, title, named: false, branch, first: new Date(last - turns * 4 * MIN).toISOString(), last: new Date(last).toISOString(), turns, entry: 'cli', kb: turns * 37 };
    });
    return { key: path.replace(/[:\\/ ]/g, '-'), name, path, last: list[0].last, chats: list };
  }).sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
  return { now, projects, live, liveError: null, retentionDays: 365, scanning: false };
}
