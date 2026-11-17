// Looks for the app: 'broadcast' (default) or 'classic' (the original style.css on its own).
// The Broadcast stylesheet is <link id="theme-css"> in index.html; this switches it on and off,
// and after each render fills in the few values the theme draws from game state.
import { G } from './state.js';
import { DB } from './data.js';

const KEY = 'edhpt:theme';
export const THEMES = ['broadcast', 'classic'];

export function currentTheme() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return THEMES.includes(v) ? v : 'broadcast';
  } catch (e) {
    return 'broadcast';
  }
}

// Apply a look to the main window and any pop-out windows (docs)
export function applyTheme(t, docs = []) {
  if (!THEMES.includes(t)) t = 'broadcast';
  try { localStorage.setItem(KEY, JSON.stringify(t)); } catch (e) { /* private mode: just don't remember it */ }
  for (const d of [document, ...docs]) themeDoc(d, t);
}

// Make one document (a pop-out window) match the current look
export function themeDoc(d, t = currentTheme()) {
  d.documentElement.dataset.theme = t;
  let link = d.getElementById('theme-css');
  if (!link && d !== document) {
    link = d.createElement('link');
    link.id = 'theme-css';
    link.rel = 'stylesheet';
    link.href = `${location.origin}/css/theme-broadcast.css`;
    d.head.appendChild(link);
  }
  if (link) link.disabled = t !== 'broadcast';
}

const MANA = { W: '#efe3b4', U: '#4d93d6', B: '#8a7393', R: '#de5b3f', G: '#4fa864' };
const idBar = new Map(); // pid -> css gradient (commanders don't change mid-game, so cache per game)
let idGame = null;
function identityBar(pid) {
  const s = G.s;
  if (idGame !== s) { idBar.clear(); idGame = s; }
  if (idBar.has(pid)) return idBar.get(pid);
  const set = new Set();
  for (const c of Object.values(s.cards)) if (c.isCommander && c.owner === pid) for (const k of (DB[c.def] || {}).ci || []) set.add(k);
  const cols = 'WUBRG'.split('').filter((k) => set.has(k)).map((k) => MANA[k]);
  const bar = !cols.length ? '#a39e93' : cols.length === 1 ? cols[0] : `linear-gradient(90deg, ${cols.map((x, i) => `${x} ${(i * 100) / cols.length}% ${((i + 1) * 100) / cols.length}%`).join(', ')})`;
  idBar.set(pid, bar);
  return bar;
}

const lastLife = new WeakMap(); // doc -> Map(pid -> life)
// After a render: colour-identity stripes, damage/poison bar levels, life flashes, the lit field on your turn
export function decorate(docs = []) {
  const s = G.s;
  if (!s || document.documentElement.dataset.theme === 'classic') return;
  for (const d of [document, ...docs]) {
    const panelOf = (pid) => (pid === 'p' ? d.getElementById('my-panel') : d.querySelector(`[data-seat-panel="${pid}"]`) || (pid === 'ai' ? d.getElementById('opp-panel') : null));
    for (const pid of Object.keys(s.players)) {
      const el = panelOf(pid);
      if (!el) continue;
      const bar = identityBar(pid);
      if (el.style.getPropertyValue('--id-bar') !== bar) el.style.setProperty('--id-bar', bar);
      const lv = el.querySelector('.lval');
      const life = s.players[pid].life;
      if (!lastLife.has(d) || lastLife.get(d).game !== s) lastLife.set(d, Object.assign(new Map(), { game: s }));
      const was = lastLife.get(d).get(pid);
      lastLife.get(d).set(pid, life);
      if (lv && was !== undefined && was !== life) {
        lv.classList.remove('hit', 'heal');
        void lv.offsetWidth; // restart the animation
        lv.classList.add(life < was ? 'hit' : 'heal');
      }
    }
    for (const m of d.querySelectorAll('.cmd-dmg, .poison')) {
      const v = parseInt((m.querySelector('b') || {}).textContent || '0', 10) || 0;
      const lvl = String(Math.min(1, v / (m.classList.contains('poison') ? 10 : 21)));
      if (m.style.getPropertyValue('--v') !== lvl) m.style.setProperty('--v', lvl);
    }
    const mf = d.getElementById('my-field');
    if (mf) mf.classList.toggle('on-turn', s.active === 'p');
    const mp = d.getElementById('my-panel');
    if (mp) mp.classList.toggle('on-turn', s.active === 'p');
    for (const id of ['opp-panel', 'opp-field']) { const el = d.getElementById(id); if (el) el.classList.toggle('on-turn', s.active === 'ai'); }
  }
}
