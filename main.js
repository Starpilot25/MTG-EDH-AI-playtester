// Setup screen, game start, mulligans.
import {
  DB, parseDecklist, importFromUrl, resolveDeck, legendaryCandidates, secondCandidates, canPair, wantsPair, SAMPLE_DECKS,
} from './data.js';
import { G, newGame, cardsIn, move, log, esc, emit } from './state.js';
import { run, aiMulligans, mulligan, bottomCount, startPlay } from './game.js';
import { render, bindEvents, openDialog, closeDialog, cancelPending, toast } from './ui.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('edhpt:' + k);
      return v === null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('edhpt:' + k, JSON.stringify(v));
    } catch (e) {
      /* storage unavailable */
    }
  },
};

const cardImg = (d) =>
  d.faces[0].img
    ? `<img src="${d.faces[0].img}" alt="${esc(d.name)}">`
    : `<div class="img-missing">${esc(d.name)}</div>`;

const slots = { p: { deck: null, mode: 'link' }, ai: { deck: null, mode: 'sample' } };
let lastDecks = null;

// ------------------------------------------------------------ setup UI
function slotEl(pid) {
  return $(`.deck-slot[data-pid="${pid}"]`);
}

function setMode(pid, mode) {
  slots[pid].mode = mode;
  const el = slotEl(pid);
  $$('.seg button', el).forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  $$('.mode', el).forEach((m) => (m.hidden = m.dataset.mode !== mode));
  store.set(pid + ':mode', mode);
}

async function loadSlot(pid) {
  const el = slotEl(pid);
  const status = $('.status', el);
  const mode = slots[pid].mode;
  const btn = $('.load', el);
  status.className = 'status';
  status.innerHTML = '<span class="spinner"></span> Loading cards from Scryfall…';
  btn.disabled = true;
  try {
    let parsed;
    if (mode === 'mirror') {
      if (!slots.p.deck) throw new Error('Load your deck first.');
      slots.ai.deck = JSON.parse(JSON.stringify(slots.p.deck));
      slots.ai.deck.name = slots.p.deck.name + ' (mirror)';
      showSummary(pid);
      return;
    }
    if (mode === 'link') {
      const url = $('.in-link', el).value.trim();
      if (!url) throw new Error('Paste a Moxfield or Archidekt deck link.');
      store.set(pid + ':link', url);
      status.innerHTML = '<span class="spinner"></span> Fetching the deck…';
      parsed = await importFromUrl(url);
      status.innerHTML = '<span class="spinner"></span> Loading cards from Scryfall…';
    } else if (mode === 'paste') {
      const text = $('.in-paste', el).value;
      store.set(pid + ':paste', text);
      parsed = parseDecklist(text);
      parsed.name = $('.in-name', el).value.trim() || 'Pasted deck';
    } else {
      const key = $('.in-sample', el).value;
      store.set(pid + ':sample', key);
      parsed = parseDecklist(SAMPLE_DECKS[key].text);
      parsed.name = SAMPLE_DECKS[key].label;
    }
    if (!parsed.main.length && !parsed.commanders.length) throw new Error('No cards found in that list.');
    const deck = await resolveDeck(parsed);
    if (!deck.commanders.length) {
      // Commander not marked: guess from the list (prefer a legend that can pair with another
      // legend or Background in the deck), and let the user change it.
      const cands = legendaryCandidates(deck);
      const paired = cands.find((d) => wantsPair(d) && secondCandidates(deck, d.id).length);
      const pick = (paired || cands[0] || {}).id;
      if (pick) {
        setCommanders(deck, [pick]);
        const second = paired && secondCandidates(deck, pick)[0];
        if (second) setCommanders(deck, [pick, second.id]);
        deck.guessedCommander = true;
      }
    }
    slots[pid].deck = deck;
    showSummary(pid);
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message;
    slots[pid].deck = null;
    $('.summary', el).hidden = true;
  } finally {
    btn.disabled = false;
    updateStart();
  }
}

// Put the chosen cards in the command zone and everything else back in the 99.
function setCommanders(deck, ids) {
  deck.cards.push(...deck.commanders);
  deck.commanders = [];
  for (const id of ids.filter(Boolean)) {
    const k = deck.cards.indexOf(id);
    if (k >= 0) deck.cards.splice(k, 1);
    deck.commanders.push(id);
  }
}

function showSummary(pid) {
  const el = slotEl(pid);
  const deck = slots[pid].deck;
  const status = $('.status', el);
  const total = deck.cards.length + deck.commanders.length;
  status.className = 'status ok';
  status.textContent = `Loaded ${total} cards.`;
  const sum = $('.summary', el);
  const cmds = deck.commanders.map((id) => DB[id]);
  const cands = legendaryCandidates(deck);
  const warn = [];
  if (total !== 100) warn.push(`This deck has ${total} cards, not 100. You can still play it.`);
  if (deck.missing.length) warn.push(`Couldn't find on Scryfall: ${deck.missing.map(esc).join(', ')}.`);
  if (deck.guessedCommander) warn.push('No commander was marked, so one was picked from the list. Change it below if needed.');
  if (!deck.commanders.length) warn.push('No commander found. Pick one below, or play without one.');
  if (deck.commanders.length > 2) warn.push('More than two commanders are marked. They all start in the command zone.');
  if (deck.commanders.length === 2 && !canPair(cmds[0], cmds[1]))
    warn.push(`${esc(cmds[0].name)} and ${esc(cmds[1].name)} can't normally share the command zone. You can still play them together.`);
  const first = deck.commanders[0] || '';
  const second = deck.commanders[1] || '';
  // first slot: legendary creatures (and current picks); second slot: legal partners/Backgrounds
  const firstOpts = [...new Map([...cmds, ...cands].map((d) => [d.id, d])).values()].filter((d) => d.id !== second);
  const secondOpts = first
    ? [...new Map([...(second ? [DB[second]] : []), ...secondCandidates(deck, first)].map((d) => [d.id, d])).values()]
    : [];
  const showSecond = first && (secondOpts.length || wantsPair(DB[first]));
  const kindLabel = first && /Background/.test(secondOpts.map((d) => d.faces[0].typeLine).join(' ')) && !secondOpts.some((d) => /Creature/.test(d.faces[0].typeLine))
    ? 'Background'
    : 'Partner / Background';
  const opt = (d, sel) => `<option value="${d.id}" ${sel ? 'selected' : ''}>${esc(d.name)}</option>`;
  sum.innerHTML = `
    <div class="sum-head">
      <div class="sum-cmds">${cmds.map(cardImg).join('') || '<div class="no-cmd">No commander</div>'}</div>
      <div><h3>${esc(deck.name)}</h3>
        <p class="cmd-names">${cmds.map((d) => esc(d.name)).join(' & ') || '—'}</p>
        <p class="mix">${mix(deck)}</p></div>
    </div>
    ${warn.length ? `<ul class="warns">${warn.map((w) => `<li>${w}</li>`).join('')}</ul>` : ''}
    ${firstOpts.length ? `<div class="cmd-picks">
      <label class="cmd-pick">Commander
        <select class="sel-cmd"><option value="">(none)</option>${firstOpts.map((d) => opt(d, d.id === first)).join('')}</select></label>
      ${showSecond ? `<label class="cmd-pick">${kindLabel}
        <select class="sel-cmd2"><option value="">(none)</option>${secondOpts.map((d) => opt(d, d.id === second)).join('')}</select>
        ${!secondOpts.length ? '<span class="tip">No legal partner or Background found in this list.</span>' : ''}</label>` : ''}
    </div>` : ''}`;
  sum.hidden = false;
  const sel = $('.sel-cmd', sum);
  const sel2 = $('.sel-cmd2', sum);
  if (sel)
    sel.addEventListener('change', () => {
      deck.guessedCommander = false;
      // keep the second commander only if it still pairs with the new first one
      const keep = second && sel.value && canPair(DB[sel.value], DB[second]) ? second : '';
      setCommanders(deck, [sel.value, keep]);
      showSummary(pid);
    });
  if (sel2)
    sel2.addEventListener('change', () => {
      deck.guessedCommander = false;
      setCommanders(deck, [first, sel2.value]);
      showSummary(pid);
    });
  updateStart();
}

function mix(deck) {
  const types = { Creature: 0, Land: 0, Instant: 0, Sorcery: 0, Artifact: 0, Enchantment: 0, Planeswalker: 0 };
  for (const id of deck.cards) {
    const t = DB[id].faces[0].typeLine;
    for (const k of Object.keys(types)) if (new RegExp('\\b' + k + '\\b').test(t.split('—')[0])) {
      types[k]++;
      break;
    }
  }
  return Object.entries(types)
    .filter(([, v]) => v)
    .map(([k, v]) => `<span><b>${v}</b> ${k === 'Sorcery' ? 'sorceries' : k.toLowerCase() + (v === 1 ? '' : 's')}</span>`)
    .join('');
}

function updateStart() {
  const ok = slots.p.deck && slots.ai.deck;
  $('#start').disabled = !ok;
  $('#start-hint').textContent = ok ? 'Both decks are ready.' : 'Load both decks to start.';
}

function readSettings() {
  G.settings.freeMulligan = $('#set-free').checked;
  G.settings.pauseOnAiSpells = $('#set-pause').checked;
  G.settings.arenaMode = $('#set-arena').checked;
  G.settings.aiSpeed = +$('#set-speed').value;
  G.settings.startingLife = +$('#set-life').value || 40;
  store.set('settings', {
    freeMulligan: G.settings.freeMulligan,
    pauseOnAiSpells: G.settings.pauseOnAiSpells,
    arenaMode: G.settings.arenaMode,
    aiSpeed: G.settings.aiSpeed,
    startingLife: G.settings.startingLife,
  });
}

function initSetup() {
  for (const pid of ['p', 'ai']) {
    const el = slotEl(pid);
    $('.in-sample', el).innerHTML = Object.entries(SAMPLE_DECKS)
      .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`)
      .join('');
    $('.in-link', el).value = store.get(pid + ':link', '');
    $('.in-paste', el).value = store.get(pid + ':paste', '');
    $('.in-sample', el).value = store.get(pid + ':sample', pid === 'p' ? 'gruul' : 'golgari');
    setMode(pid, store.get(pid + ':mode', pid === 'p' ? 'link' : 'sample'));
    $$('.seg button', el).forEach((b) => b.addEventListener('click', () => setMode(pid, b.dataset.mode)));
    $('.load', el).addEventListener('click', () => loadSlot(pid));
    $('.in-link', el).addEventListener('keydown', (e) => e.key === 'Enter' && loadSlot(pid));
  }
  const st = store.get('settings', {});
  $('#set-free').checked = st.freeMulligan ?? true;
  $('#set-pause').checked = st.pauseOnAiSpells ?? true;
  $('#set-arena').checked = st.arenaMode ?? true;
  $('#set-speed').value = st.aiSpeed ?? 650;
  $('#set-life').value = st.startingLife ?? 40;
  $('#start').addEventListener('click', () => {
    readSettings();
    lastDecks = { p: slots.p.deck, ai: slots.ai.deck };
    beginGame();
  });
  updateStart();
}

// ------------------------------------------------------------ game start
function showTable() {
  $('#setup').hidden = true;
  $('#table').hidden = false;
}
function showSetup() {
  cancelPending();
  closeDialog(true);
  $('#table').hidden = true;
  $('#setup').hidden = false;
}

function beginGame() {
  cancelPending();
  closeDialog(true);
  run.aiBusy = false;
  newGame(lastDecks.p, lastDecks.ai);
  showTable();
  render();
  aiMulligans();
  render();
  mulliganDialog();
}

function mulliganDialog() {
  const pl = G.s.players.p;
  const hand = cardsIn('p', 'hand');
  const lands = hand.filter((c) => /\bLand\b/.test(DB[c.def].faces[0].typeLine.split('—')[0])).length;
  const nextFree = G.settings.freeMulligan && pl.mulligans === 0;
  const keepCount = 7 - bottomCount('p');
  const dlg = openDialog(`
    <span class="eyebrow">${G.s.first === 'p' ? 'You are on the play' : 'You are on the draw'}</span>
    <h3>Opening hand${pl.mulligans ? ` · mulligan ${pl.mulligans}` : ''}</h3>
    <p class="hint">${lands} land${lands === 1 ? '' : 's'} · keeping puts ${7 - keepCount} card${7 - keepCount === 1 ? '' : 's'} on the bottom.</p>
    <div class="mull-hand">${hand.map((c) => `<div class="mull-card" data-iid="${c.iid}">${cardImg(DB[c.def])}</div>`).join('')}</div>
    <div class="btns">
      <button class="primary" id="keep">Keep ${keepCount}</button>
      <button id="mull">Mulligan${nextFree ? ' (free)' : ''}</button>
    </div>`, { wide: true, noClose: true });
  $('#keep', dlg).addEventListener('click', () => {
    const n = bottomCount('p');
    if (n > 0) return bottomDialog(n);
    finishMulligans();
  });
  $('#mull', dlg).addEventListener('click', () => {
    mulligan('p');
    render();
    mulliganDialog();
  });
}

function bottomDialog(n) {
  const hand = cardsIn('p', 'hand');
  const picked = new Set();
  const dlg = openDialog(`
    <h3>Put ${n} card${n > 1 ? 's' : ''} on the bottom</h3>
    <p class="hint">Click cards to choose them.</p>
    <div class="mull-hand pick">${hand.map((c) => `<button class="mull-card" data-iid="${c.iid}">${cardImg(DB[c.def])}</button>`).join('')}</div>
    <div class="btns"><button class="primary" id="bottom-ok" disabled>Confirm</button></div>`, { wide: true, noClose: true });
  $$('.mull-card', dlg).forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.iid;
      if (picked.has(id)) picked.delete(id);
      else if (picked.size < n) picked.add(id);
      b.classList.toggle('on', picked.has(id));
      $('#bottom-ok', dlg).disabled = picked.size !== n;
    })
  );
  $('#bottom-ok', dlg).addEventListener('click', () => {
    picked.forEach((id) => move(id, 'library', { to: 'bottom' }));
    finishMulligans();
  });
}

function finishMulligans() {
  const m = G.s.players.p.mulligans;
  log('p', m ? `You mulligan ${m === 1 ? 'once' : m + ' times'} and keep ${cardsIn('p', 'hand').length}.` : 'You keep your opening seven.');
  closeDialog(true);
  startPlay();
}

// ------------------------------------------------------------ boot
window.addEventListener('edh:rematch', () => beginGame());
window.addEventListener('edh:newdecks', () => showSetup());

document.addEventListener('DOMContentLoaded', () => {
  initSetup();
  bindEvents();
  $('#btn-menu').addEventListener('click', (e) => {
    const m = $('#game-menu');
    m.hidden = !m.hidden;
    e.stopPropagation();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#game-menu')) $('#game-menu').hidden = true;
  });
  $('#gm-restart').addEventListener('click', () => beginGame());
  $('#gm-decks').addEventListener('click', () => showSetup());
  $('#gm-pause').addEventListener('change', (e) => (G.settings.pauseOnAiSpells = e.target.checked));
  $('#gm-arena').addEventListener('change', (e) => (G.settings.arenaMode = e.target.checked));
  $('#gm-speed').addEventListener('change', (e) => (G.settings.aiSpeed = +e.target.value));
  $('#gm-autodraw').addEventListener('change', (e) => (G.settings.autoDraw = e.target.checked));
  $('#gm-autountap').addEventListener('change', (e) => (G.settings.autoUntap = e.target.checked));
  $('#btn-menu').addEventListener('click', () => {
    $('#gm-pause').checked = G.settings.pauseOnAiSpells;
    $('#gm-arena').checked = G.settings.arenaMode;
    $('#gm-speed').value = G.settings.aiSpeed;
    $('#gm-autodraw').checked = G.settings.autoDraw;
    $('#gm-autountap').checked = G.settings.autoUntap;
  });
  if (location.protocol === 'file:') {
    toast('Open this through the server: run "node server.js", then visit http://localhost:5173');
  }
});

export { emit };
