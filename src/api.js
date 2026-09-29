// The bridge to the Rust side. Outside Tauri (a plain browser on `npm run dev`) the same calls run
// against a dumped snapshot and launch nothing, so the UI can be worked on without the app.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const inTauri = '__TAURI_INTERNALS__' in window;

const tauri = {
  snapshot: () => invoke('snapshot'),
  ready: () => invoke('ready'),
  resume: (sessionId, mode, fork) => invoke('resume', { sessionId, mode, fork }),
  newChat: (projectKey, mode) => invoke('new_chat', { projectKey, mode }),
  jump: sessionId => invoke('jump', { sessionId }),
  openTogether: (sessionIds, layout, fork) => invoke('open_together', { sessionIds, layout, fork }),
  prefs: () => invoke('get_prefs'),
  savePrefs: prefs => invoke('save_prefs', { prefs }),
  keepChats: days => invoke('keep_chats', { days }),
  hide: () => invoke('hide'),
  minimize: () => invoke('minimize'),
  on: (event, fn) => listen(event, e => fn(e.payload)),
};

const DEFAULT_PREFS = { mix: 0, autoTheme: false, mode: 'window', fork: false, pins: [], startWithWindows: true, retentionDismissed: false, view: 'chats', desks: [] };

function preview() {
  // Nothing is launched here; the toast shows the claude call the app would make.
  const say = (line, cmd) => Promise.resolve({ kind: 'open', line, cmd });
  const call = (id, fork) => `claude --resume ${id}` + (fork ? ' --fork-session' : '');
  let prefs = DEFAULT_PREFS;
  try { prefs = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('cc-resume-prefs') || '{}') }; } catch { /* private mode: defaults */ }
  return {
    snapshot: () => fetch('/__snapshot').then(r => r.json()).then(s => ({ projects: [], live: [], ...s })),
    ready: () => Promise.resolve(),
    resume: (id, mode, fork) => say((fork ? 'forking' : 'resuming') + ' in ' + (mode === 'split' ? 'a split pane' : 'its own window'), call(id, fork)),
    newChat: (_key, mode) => say('new chat in ' + (mode === 'split' ? 'a split pane' : 'its own window'), 'claude'),
    openTogether: (ids, _layout, fork) => say((fork ? 'forked ' : 'opened ') + ids.length + ' side by side', ids.map(id => call(id, fork)).join('  |  ')),
    jump: () => Promise.resolve({ kind: 'jump', line: 'already open, jumped to its window', cmd: '' }),
    prefs: () => Promise.resolve(prefs),
    savePrefs: p => { prefs = p; try { localStorage.setItem('cc-resume-prefs', JSON.stringify(p)); } catch { /* ignore */ } return Promise.resolve(); },
    keepChats: () => Promise.resolve(),
    hide: () => Promise.resolve(),
    minimize: () => Promise.resolve(),
    on: () => Promise.resolve(() => {}),
  };
}

export const api = inTauri ? tauri : preview();
