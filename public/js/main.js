// Setup screen, game start, mulligans.
import {
  DB, parseDecklist, importFromUrl, resolveDeck, legendaryCandidates, secondCandidates, canPair, wantsPair, SAMPLE_DECKS, PRECON_DECKS,
  listSaved, saveDeck, deleteSaved, deckToText, fetchHooks, loadStats,
} from './data.js';
import { G, newGame, cardsIn, move, log, esc, emit } from './state.js';
import { loadDungeons } from './dungeon.js';
import { voiceSupported, speak, stopSpeaking } from './voice.js';
import { run, aiMulligans, mulligan, bottomCount, startPlay } from './game.js';
import { render, bindEvents, openDialog, closeDialog, cancelPending, toast, teardownTable } from './ui.js';

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

const slots = { p: { deck: null, mode: 'paste' }, ai: { deck: null, mode: 'sample' }, ai2: { deck: null, mode: 'sample' }, ai3: { deck: null, mode: 'sample' } };
// How many AI opponents (1 = 1v1, 2–3 = a pod). The extra AI slots are copies of the AI slot.
let opponentsN = 1;
const SLOT_IDS = ['p', 'ai', 'ai2', 'ai3'];
const aiSlots = () => ['ai', 'ai2', 'ai3'].slice(0, opponentsN);
const activeSlots = () => ['p', ...aiSlots()];
// test hook: the deck loaded in a setup slot (used with window.__podDecks to seat a pod)
if (typeof window !== 'undefined') window.__slotDeck = (pid) => slots[pid] && slots[pid].deck;
let savedDecks = [];

// ------------------------------------------------------------ saved decks
async function refreshSaved(selectId) {
  try {
    savedDecks = await listSaved();
  } catch (e) {
    savedDecks = [];
  }
  for (const pid of SLOT_IDS) {
    const el = slotEl(pid);
    if (!el) continue;
    const sel = $('.in-saved', el);
    const keep = selectId || sel.value || store.get(pid + ':saved', '');
    sel.innerHTML = savedDecks.length
      ? savedDecks
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((d) => `<option value="${esc(d.id)}">${esc(d.name)}${d.commander ? ' — ' + esc(d.commander) : ''}</option>`)
        .join('')
      : '<option value="">No saved decks yet</option>';
    if (savedDecks.some((d) => d.id === keep)) sel.value = keep;
    $('.del-saved', el).disabled = !savedDecks.length;
    $('.saved-tip', el).hidden = savedDecks.length > 0;
  }
}

async function saveCurrent(pid, name) {
  const deck = slots[pid].deck;
  if (!deck) return;
  try {
    const res = await saveDeck({
      name,
      text: deckToText(deck),
      commander: deck.commanders.map((id) => DB[id].name).join(' & '),
      source: slots[pid].source || '',
    });
    deck.name = name;
    toast(`Saved “${name}”.`);
    await refreshSaved(res.deck.id);
    showSummary(pid);
  } catch (e) {
    toast('Could not save: ' + e.message);
  }
}
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
  fetchHooks.status = (msg) => (status.innerHTML = `<span class="spinner"></span> ${msg}`);
  btn.disabled = true;
  try {
    let parsed;
    if (mode === 'mirror') {
      if (!slots.p.deck) throw new Error('Load your deck first.');
      slots[pid].deck = JSON.parse(JSON.stringify(slots.p.deck));
      slots[pid].deck.name = slots.p.deck.name + ' (mirror)';
      showSummary(pid);
      return;
    }
    if (mode === 'link') {
      const url = $('.in-link', el).value.trim();
      if (!url) throw new Error('Paste a Moxfield or Archidekt deck link.');
      store.set(pid + ':link', url);
      slots[pid].source = url;
      status.innerHTML = '<span class="spinner"></span> Fetching the deck…';
      parsed = await importFromUrl(url);
      status.innerHTML = '<span class="spinner"></span> Loading cards from Scryfall…';
    } else if (mode === 'paste') {
      const text = $('.in-paste', el).value;
      if (/^\s*https?:\/\/\S+\s*$/.test(text)) throw new Error("Deck links aren't supported. On Moxfield or Archidekt, use Export and copy the list as text, then paste that here.");
      store.set(pid + ':paste', text);
      parsed = parseDecklist(text);
      parsed.name = $('.in-name', el).value.trim() || 'Pasted deck';
      slots[pid].source = '';
    } else if (mode === 'saved') {
      const id = $('.in-saved', el).value;
      const entry = savedDecks.find((d) => d.id === id);
      if (!entry) throw new Error('No saved deck chosen. Load a deck and press “Save deck” to add one.');
      store.set(pid + ':saved', id);
      parsed = parseDecklist(entry.text);
      parsed.name = entry.name;
      slots[pid].source = entry.source || '';
    } else if (mode === 'precon') {
      const key = $('.in-precon', el).value;
      if (!key || !PRECON_DECKS[key]) throw new Error('No precons have been added yet.');
      store.set(pid + ':precon', key);
      parsed = parseDecklist(PRECON_DECKS[key].text);
      parsed.name = PRECON_DECKS[key].label;
      slots[pid].source = 'precon:' + key;
    } else {
      const key = $('.in-sample', el).value;
      store.set(pid + ':sample', key);
      parsed = parseDecklist(SAMPLE_DECKS[key].text);
      parsed.name = SAMPLE_DECKS[key].label;
      slots[pid].source = 'sample:' + key;
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
  // where the cards came from, so a slow load can be told apart: saved on this computer, or fetched from Scryfall
  const ls = loadStats;
  status.textContent = `Loaded ${total} cards.${ls.fetched ? ` (${ls.fetched} new from Scryfall in ${(ls.ms / 1000).toFixed(1)} s${ls.cached ? `, ${ls.cached} already saved` : ''})` : ls.cached ? ' (all saved on this computer)' : ''}`;
  const sum = $('.summary', el);
  const cmds = deck.commanders.map((id) => DB[id]);
  const cands = legendaryCandidates(deck);
  const warn = [];
  if (total !== 100) warn.push(`This deck has ${total} cards, not 100. You can still play it.`);
  if ((deck.companions || []).length) warn.push(`Companion: ${deck.companions.map((id) => esc(DB[id].name)).join(', ')} starts outside the game — pay {3} at sorcery speed (right-click it in your command zone) to put it into your hand.`);
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
    <form class="save-row"><input class="save-name" value="${esc(deck.name.replace(/^(?:Sample|Claude|Built-in) deck · /, ''))}" aria-label="Name to save this deck as" maxlength="120"><button type="submit">${savedDecks.some((d) => d.name.toLowerCase() === deck.name.toLowerCase()) ? 'Update saved deck' : 'Save deck'}</button></form>
    ${firstOpts.length ? `<div class="cmd-picks">
      <label class="cmd-pick">Commander
        <select class="sel-cmd"><option value="">(none)</option>${firstOpts.map((d) => opt(d, d.id === first)).join('')}</select></label>
      ${showSecond ? `<label class="cmd-pick">${kindLabel}
        <select class="sel-cmd2"><option value="">(none)</option>${secondOpts.map((d) => opt(d, d.id === second)).join('')}</select>
        ${!secondOpts.length ? '<span class="tip">No legal partner or Background found in this list.</span>' : ''}</label>` : ''}
    </div>` : ''}`;
  sum.hidden = false;
  $('.save-row', sum).addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('.save-name', sum).value.trim();
    if (!name) return toast('Give the deck a name first.');
    saveCurrent(pid, name);
  });
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
  const list = activeSlots();
  const ok = list.every((k) => slots[k].deck);
  $('#start').disabled = !ok;
  const missing = list.filter((k) => !slots[k].deck).length;
  $('#start-hint').textContent = opponentsN === 1
    ? (ok ? 'Both decks are ready.' : 'Load both decks to start.')
    : ok ? `All ${list.length} decks are ready.` : `Load all ${list.length} decks to start (${missing} to go).`;
}

// The opponent count switch: shows one AI slot per opponent. The extra slots are built from the AI slot.
function slotHeading(pid) {
  if (pid === 'p') return 'Your deck';
  return opponentsN === 1 ? "AI's deck" : `AI ${aiSlots().indexOf(pid) + 1}'s deck`;
}
function buildExtraSlots() {
  const base = slotEl('ai');
  for (const pid of ['ai2', 'ai3']) {
    if (slotEl(pid)) continue;
    const el = base.cloneNode(true);
    el.dataset.pid = pid;
    el.querySelectorAll('[id]').forEach((x) => (x.id = x.id.replace(/^ai-/, pid + '-')));
    el.querySelectorAll('label[for]').forEach((x) => (x.htmlFor = x.htmlFor.replace(/^ai-/, pid + '-')));
    $('.status', el).textContent = '';
    $('.status', el).className = 'status';
    $('.summary', el).hidden = true;
    $('.summary', el).innerHTML = '';
    base.parentNode.appendChild(el);
  }
}
function setOpponents(n) {
  opponentsN = Math.max(1, Math.min(3, +n || 1));
  store.set('opponents', opponentsN);
  for (const pid of ['ai', 'ai2', 'ai3']) {
    const el = slotEl(pid);
    if (!el) continue;
    el.hidden = !aiSlots().includes(pid);
    $('.slot-head h2', el).textContent = slotHeading(pid);
  }
  $$('.pod-seg button').forEach((b) => b.classList.toggle('on', +b.dataset.opps === opponentsN));
  const hint = $('.pod-hint');
  if (hint) hint.textContent = opponentsN === 1 ? '1v1' : `${opponentsN + 1}-player pod: you and ${opponentsN} AIs, turns go around the table`;
  const wrap = $('.opp-slots');
  if (wrap) wrap.style.setProperty('--opps', opponentsN);
  document.body.classList.toggle('pod-setup', opponentsN > 1);
  updateStart();
}

function readSettings() {
  G.settings.freeMulligan = $('#set-free').checked;
  G.settings.unlimitedMulligans = $('#set-unlimited').checked;
  G.settings.pauseOnAiSpells = $('#set-pause').checked;
  G.settings.autoTreasure = $('#set-treasure').checked;
  G.settings.arenaMode = $('#set-arena').checked;
  G.settings.aiSpeed = +$('#set-speed').value;
  G.settings.aiStyle = $('#set-aistyle').value;
  G.settings.aiVoice = $('#set-voice').value;
  G.settings.boardLayout = $('#set-layout').value;
  G.settings.commanderZone = $('#set-cmdzone').value;
  G.settings.dorks = $('#set-dorks').value;
  G.settings.startingLife = +$('#set-life').value || 40;
  store.set('settings', {
    freeMulligan: G.settings.freeMulligan,
    unlimitedMulligans: G.settings.unlimitedMulligans,
    pauseOnAiSpells: G.settings.pauseOnAiSpells,
    autoTreasure: G.settings.autoTreasure,
    arenaMode: G.settings.arenaMode,
    aiSpeed: G.settings.aiSpeed,
    aiStyle: G.settings.aiStyle,
    aiVoice: G.settings.aiVoice,
    boardLayout: G.settings.boardLayout,
    commanderZone: G.settings.commanderZone,
    dorks: G.settings.dorks,
    startingLife: G.settings.startingLife,
  });
}

function initSetup() {
  buildExtraSlots();
  for (const pid of SLOT_IDS) {
    const el = slotEl(pid);
    const BRACKETS = { 1: 'Bracket 1 · Exhibition', 2: 'Bracket 2 · Core', 3: 'Bracket 3 · Upgraded', 4: 'Bracket 4 · Optimized', 5: 'Bracket 5 · cEDH' };
    $('.in-sample', el).innerHTML = [1, 2, 3, 4, 5]
      .map((b) => {
        const list = Object.entries(SAMPLE_DECKS).filter(([, v]) => v.bracket === b);
        return list.length ? `<optgroup label="${BRACKETS[b]}">${list.map(([k, v]) => `<option value="${k}">${esc(v.label.replace(/^(?:Sample|Claude|Built-in) deck · /, ''))}</option>`).join('')}</optgroup>` : '';
      })
      .join('');
    $('.in-paste', el).value = store.get(pid + ':paste', '');
    $('.in-sample', el).value = store.get(pid + ':sample', { p: 'gruul', ai: 'golgari', ai2: 'izzet', ai3: 'korvold' }[pid]);
    if (!$('.in-sample', el).value) $('.in-sample', el).selectedIndex = 0;
    const precons = Object.entries(PRECON_DECKS);
    const sets = [...new Set(precons.map(([, v]) => v.set || 'Other'))];
    $('.in-precon', el).innerHTML = sets
      .map((set) => `<optgroup label="${esc(set)}">${precons.filter(([, v]) => (v.set || 'Other') === set).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</optgroup>`)
      .join('');
    $('.in-precon', el).hidden = !precons.length;
    $('.precon-tip', el).hidden = !!precons.length;
    if (precons.length) $('.in-precon', el).value = store.get(pid + ':precon', precons[0][0]);
    { const m0 = store.get(pid + ':mode', pid === 'p' ? 'paste' : 'sample'); setMode(pid, m0 === 'link' ? 'paste' : m0); }
    $$('.seg button', el).forEach((b) => b.addEventListener('click', () => setMode(pid, b.dataset.mode)));
    $('.load', el).addEventListener('click', () => loadSlot(pid));
    $('.in-saved', el).addEventListener('change', () => loadSlot(pid));
    $('.del-saved', el).addEventListener('click', async () => {
      const id = $('.in-saved', el).value;
      const entry = savedDecks.find((d) => d.id === id);
      if (!entry || !window.confirm(`Delete the saved deck “${entry.name}”?`)) return;
      try {
        await deleteSaved(id);
        await refreshSaved();
        toast(`Deleted “${entry.name}”.`);
      } catch (e) {
        toast('Could not delete: ' + e.message);
      }
    });
  }
  $$('.pod-seg button').forEach((b) => b.addEventListener('click', () => setOpponents(b.dataset.opps)));
  setOpponents(store.get('opponents', 1));
  refreshSaved();
  fetch('/api/version')
    .then((r) => r.json())
    .then((v) => {
      const el = $('#version');
      if (el && v.version) {
        el.innerHTML = `<button type="button" class="linkish" data-v="new" title="See what's new">Version ${esc(v.version)}${v.source === 'just updated' ? ' · just updated' : ''} · What's new</button> · <button type="button" class="linkish" data-v="log" title="Every update so far">Full update log</button>`;
        el.querySelector('[data-v=new]').addEventListener('click', () => showPatchNotes(v.version, null));
        el.querySelector('[data-v=log]').addEventListener('click', () => showUpdateLog());
      }
      // patch notes after an update: everything newer than the last version this player saw
      const seen = store.get('seenVersion', null);
      if (v.version && (seen ? cmpVersion(v.version, seen) > 0 : v.source === 'just updated')) showPatchNotes(v.version, seen || prevVersion(v.version));
      if (v.version) store.set('seenVersion', v.version);
    })
    .catch(() => {});
  const st = store.get('settings', {});
  $('#set-free').checked = st.freeMulligan ?? true;
  $('#set-unlimited').checked = st.unlimitedMulligans ?? false;
  $('#set-pause').checked = st.pauseOnAiSpells ?? true;
  $('#set-treasure').checked = st.autoTreasure ?? true;
  G.settings.orderTriggers = st.orderTriggers ?? true;
  G.settings.everyStep = st.everyStep ?? true;
  $('#set-arena').checked = st.arenaMode ?? true;
  $('#set-speed').value = st.aiSpeed ?? 650;
  $('#set-aistyle').value = st.aiStyle ?? 'casual';
  $('#set-voice').value = st.aiVoice ?? 'off';
  if (!voiceSupported()) for (const id of ['#set-voice', '#gm-voice']) { const el = $(id); if (el) { el.value = 'off'; el.disabled = true; el.title = "This browser can't speak."; } }
  $('#set-voice').addEventListener('change', (e) => { if (e.target.value !== 'off') { stopSpeaking(); speak(e.target.value === 'read' ? 'A.I. announcements on. I will also read you the cards I cast.' : 'A.I. announcements on.'); } });
  $('#set-layout').value = st.boardLayout ?? 'organized';
  $('#set-cmdzone').value = st.commanderZone ?? 'ask';
  $('#set-dorks').value = st.dorks ?? 'last';
  $('#set-life').value = st.startingLife ?? 40;
  $('#start').addEventListener('click', () => {
    readSettings();
    lastDecks = { p: slots.p.deck, ai: slots.ai.deck, extra: aiSlots().slice(1).map((k) => slots[k].deck) };
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
  teardownTable();
  closeDialog(true);
  // abandon the game: any AI turn or resolution still running sees G.s change and stops
  G.s = null;
  run.aiBusy = false;
  $('#table').hidden = true;
  $('#setup').hidden = false;
}

async function beginGame() {
  await loadDungeons(); // dungeon rooms come from Scryfall; cached after the first game
  cancelPending();
  closeDialog(true);
  run.aiBusy = false;
  // pods: the extra AI decks sit in seats 'ai2' and 'ai3'
  newGame(lastDecks.p, lastDecks.ai, ...(lastDecks.extra || []));
  showTable();
  render();
  const g = G.s;
  await diceDialog();
  if (G.s !== g) return;
  aiMulligans();
  render();
  mulliganDialog();
}

// Everyone rolls a d20 for turn order (the rolls were made when the game was set up; this shows them).
// The tumbling numbers are only for show, so they don't use the game's random numbers.
function diceDialog() {
  const s = G.s;
  const rounds = s.rolls || [];
  if (!rounds.length) return Promise.resolve();
  const order = s.seats;
  const who = (k) => (k === 'p' ? 'You' : s.players[k].name);
  const flick = () => { const a = new Uint8Array(1); crypto.getRandomValues(a); return 1 + (a[0] % 20); };
  const fast = (G.settings.aiSpeed || 650) <= 300;
  return new Promise((resolve) => {
    const dlg = openDialog(`<span class="eyebrow">Turn order</span><h3>Roll for turn order</h3>
      <p class="hint">Everyone rolls a d20. Highest goes first${order.length > 2 ? ', then play passes around the table' : ''}. A tie for the highest roll is rolled again.</p>
      <div class="dice-rounds"></div>
      <p class="dice-result"></p>
      <div class="btns"><button class="primary" id="dice-ok">Skip</button></div>`, { noClose: true });
    const box = dlg.querySelector('.dice-rounds');
    const res = dlg.querySelector('.dice-result');
    const ok = dlg.querySelector('#dice-ok');
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      box.innerHTML = rounds.map((r, i) => roundHTML(r, i, true)).join('');
      const from = order.indexOf(s.first);
      const turns = [...order.slice(from), ...order.slice(0, from)];
      res.innerHTML = `<b>${who(s.first)} ${s.first === 'p' ? 'go' : 'goes'} first.</b>${order.length > 2 ? ` Turn order: ${turns.map(who).join(' → ')}.` : ''}`;
      ok.textContent = 'Continue';
    };
    const roundHTML = (r, i, settled, shown = {}) => `<div class="dice-round">${i ? `<span class="dice-tie">Tie for the highest roll — ${Object.keys(r).map(who).join(' and ')} roll again</span>` : ''}
      <div class="dice-row">${Object.keys(r).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((k) => {
        const v = settled || shown[k] ? r[k] : flick();
        const top = settled && r[k] === Math.max(...Object.values(r)) && (i === rounds.length - 1 || Object.keys(r).length > 1 && Object.values(r).filter((v) => v === r[k]).length === 1);
        return `<div class="die-wrap ${top ? 'top' : ''}"><div class="d20 ${settled || shown[k] ? '' : 'rolling'} seat-${k}"><b>${v}</b></div><span>${esc(who(k))}</span></div>`;
      }).join('')}</div></div>`;
    // animate one round at a time: the dice tumble, then land one after another
    let i = 0;
    const playRound = () => {
      if (done) return;
      if (i >= rounds.length) return finish();
      const r = rounds[i];
      const keys = Object.keys(r).sort((a, b) => order.indexOf(a) - order.indexOf(b));
      const shown = {};
      const prev = rounds.slice(0, i).map((x, j) => roundHTML(x, j, true)).join('');
      const t0 = Date.now();
      const spin = fast ? 450 : 900;
      const step = fast ? 120 : 260;
      clearInterval(timer);
      timer = setInterval(() => {
        if (done) return clearInterval(timer);
        const t = Date.now() - t0;
        keys.forEach((k, n) => { if (t > spin + n * step) shown[k] = true; });
        box.innerHTML = prev + roundHTML(r, i, false, shown);
        if (keys.every((k) => shown[k])) {
          clearInterval(timer);
          box.innerHTML = prev + roundHTML(r, i, true);
          i++;
          setTimeout(playRound, fast ? 250 : 650);
        }
      }, 70);
    };
    ok.addEventListener('click', () => {
      if (!done) return finish();
      closeDialog(true);
      resolve();
    });
    playRound();
  });
}

function mulliganDialog() {
  const pl = G.s.players.p;
  const hand = cardsIn('p', 'hand');
  const lands = hand.filter((c) => /\bLand\b/.test(DB[c.def].faces[0].typeLine.split('—')[0])).length;
  const nextFree = G.settings.unlimitedMulligans || (G.settings.freeMulligan && pl.mulligans === 0);
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
  $('#gm-log').addEventListener('click', () => {
    $('#game-menu').hidden = true;
    showUpdateLog();
  });
  $('#gm-pause').addEventListener('change', (e) => (G.settings.pauseOnAiSpells = e.target.checked));
  $('#gm-treasure').addEventListener('change', (e) => {
    G.settings.autoTreasure = e.target.checked;
    store.set('settings', { ...store.get('settings', {}), autoTreasure: e.target.checked });
    $('#set-treasure').checked = e.target.checked;
  });
  $('#gm-order').addEventListener('change', (e) => {
    G.settings.orderTriggers = e.target.checked;
    store.set('settings', { ...store.get('settings', {}), orderTriggers: e.target.checked });
  });
  $('#gm-arena').addEventListener('change', (e) => (G.settings.arenaMode = e.target.checked));
  $('#gm-speed').addEventListener('change', (e) => (G.settings.aiSpeed = +e.target.value));
  $('#gm-layout').addEventListener('change', (e) => {
    G.settings.boardLayout = e.target.value;
    store.set('settings', { ...store.get('settings', {}), boardLayout: e.target.value });
    $('#set-layout').value = e.target.value;
    render();
  });
  $('#gm-dorks').addEventListener('change', (e) => {
    G.settings.dorks = e.target.value;
    store.set('settings', { ...store.get('settings', {}), dorks: e.target.value });
    $('#set-dorks').value = e.target.value;
  });
  $('#gm-cmdzone').addEventListener('change', (e) => {
    G.settings.commanderZone = e.target.value;
    store.set('settings', { ...store.get('settings', {}), commanderZone: e.target.value });
    $('#set-cmdzone').value = e.target.value;
  });
  $('#gm-voice').addEventListener('change', (e) => {
    G.settings.aiVoice = e.target.value;
    store.set('settings', { ...store.get('settings', {}), aiVoice: e.target.value });
    $('#set-voice').value = e.target.value;
    stopSpeaking();
    if (e.target.value !== 'off') speak(e.target.value === 'read' ? 'A.I. announcements on. I will also read you the cards I cast.' : 'A.I. announcements on.');
  });
  $('#gm-aistyle').addEventListener('change', (e) => {
    G.settings.aiStyle = e.target.value;
    store.set('settings', { ...store.get('settings', {}), aiStyle: e.target.value });
    $('#set-aistyle').value = e.target.value;
  });
  $('#gm-autodraw').addEventListener('change', (e) => (G.settings.autoDraw = e.target.checked));
  $('#gm-everystep').addEventListener('change', (e) => {
    G.settings.everyStep = e.target.checked;
    store.set('settings', { ...store.get('settings', {}), everyStep: e.target.checked });
  });
  $('#gm-autountap').addEventListener('change', (e) => (G.settings.autoUntap = e.target.checked));
  $('#btn-menu').addEventListener('click', () => {
    $('#gm-pause').checked = G.settings.pauseOnAiSpells;
    $('#gm-treasure').checked = G.settings.autoTreasure !== false;
    $('#gm-order').checked = G.settings.orderTriggers !== false;
    $('#gm-arena').checked = G.settings.arenaMode;
    $('#gm-speed').value = G.settings.aiSpeed;
    $('#gm-aistyle').value = G.settings.aiStyle || 'casual';
    $('#gm-voice').value = G.settings.aiVoice || 'off';
    $('#gm-layout').value = G.settings.boardLayout || 'organized';
    $('#gm-cmdzone').value = G.settings.commanderZone || 'ask';
    $('#gm-dorks').value = G.settings.dorks || 'last';
    $('#gm-autodraw').checked = G.settings.autoDraw;
    $('#gm-everystep').checked = G.settings.everyStep !== false;
    $('#gm-autountap').checked = G.settings.autoUntap;
  });
  if (location.protocol === 'file:') {
    toast('Open this through the server: run "node server.js", then visit http://localhost:5173');
  }
});

export { emit };

// ------------------------------------------------------------ patch notes
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
function prevVersion(v) {
  const p = String(v).split('.').map(Number);
  p[p.length - 1] -= 1;
  return p.join('.');
}
// since = null shows the latest few releases; otherwise every release newer than `since`
// The full update log: every version's notes, newest first, with a search box (find a card's fix by name)
async function showUpdateLog() {
  let notes = [];
  try {
    notes = await fetch('patch-notes.json', { cache: 'no-store' }).then((r) => r.json());
  } catch (e) {
    toast('Could not load the update log.');
    return;
  }
  const dlg = openDialog(`<div class="patch-notes update-log">
    <h3>Update log <span class="ul-count">${notes.length} updates</span></h3>
    <input type="search" class="ul-search" placeholder="Search updates (a card name, a feature…)" aria-label="Search updates">
    <div class="ul-list">${notes.map((n) => `<section data-text="${esc((n.version + ' ' + (n.title || '') + ' ' + n.notes.join(' ')).toLowerCase())}"><h4>${esc(n.version)}${n.title ? ` <span>${esc(n.title)}</span>` : ''}</h4><ul>${n.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>`).join('')}</div>
    <p class="hint ul-none" hidden>No updates match.</p>
    <div class="row-end"><button class="primary" data-close>Close</button></div>
  </div>`, { wide: true });
  const input = dlg.querySelector('.ul-search');
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    let shown = 0;
    dlg.querySelectorAll('.ul-list section').forEach((sec) => {
      const ok = !q || sec.dataset.text.includes(q);
      sec.hidden = !ok;
      if (ok) shown++;
    });
    dlg.querySelector('.ul-none').hidden = shown > 0;
  });
  input.focus();
}

async function showPatchNotes(current, since) {
  let notes = [];
  try {
    notes = await fetch('patch-notes.json', { cache: 'no-store' }).then((r) => r.json());
  } catch (e) {
    return;
  }
  const list = since ? notes.filter((n) => cmpVersion(n.version, since) > 0 && cmpVersion(n.version, current) <= 0) : notes.slice(0, 6);
  if (!list.length) return;
  openDialog(`<div class="patch-notes">
    <h3>${since ? `Updated to version ${esc(current)}` : "What's new"}</h3>
    ${list.map((n) => `<section><h4>${esc(n.version)}${n.title ? ` <span>${esc(n.title)}</span>` : ''}</h4><ul>${n.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>`).join('')}
    <div class="row-end"><button class="linkish pn-all">Full update log</button><button class="primary" data-close>Got it</button></div>
  </div>`);
  const all = document.querySelector('#dialog .pn-all');
  if (all) all.addEventListener('click', () => showUpdateLog());
}

