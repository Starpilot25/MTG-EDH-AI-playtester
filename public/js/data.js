// Card data: decklist parsing, deck import, and the card definition registry.

export const DB = {}; // scryfall id -> card definition

export function normalize(c) {
  if (!c) return null;
  if (DB[c.id]) return DB[c.id];
  const img = (f) => (f && f.image_uris ? f.image_uris.normal : null);
  const imgL = (f) => (f && f.image_uris ? f.image_uris.large || f.image_uris.normal : null);
  const facesSrc = c.card_faces && c.card_faces.length ? c.card_faces : [c];
  const faces = facesSrc.map((f) => ({
    name: f.name,
    manaCost: f.mana_cost || '',
    typeLine: f.type_line || '',
    oracle: f.oracle_text || '',
    power: f.power,
    toughness: f.toughness,
    loyalty: f.loyalty,
    defense: f.defense,
    img: img(f) || img(c),
    imgLarge: imgL(f) || imgL(c),
  }));
  // Split / adventure / flip cards share one image: oracle text of all halves matters for display.
  const def = {
    id: c.id,
    name: c.name,
    // Omen cards (Tarkir: Dragonstorm): a permanent with an "Instant — Omen"/"Sorcery — Omen" half, whatever layout the data calls it
    layout: faces.length > 1 && faces.slice(1).some((f) => /\bOmen\b/.test(f.typeLine)) ? 'omen' : c.layout,
    cmc: c.cmc || 0,
    manaCost: c.mana_cost || faces[0].manaCost,
    typeLine: c.type_line || faces[0].typeLine,
    colors: c.colors || [],
    ci: c.color_identity || [],
    keywords: (c.keywords || []).map((k) => k.toLowerCase()),
    produced: c.produced_mana || [],
    tokens: (c.all_parts || []).filter((p) => p.id !== c.id).map((p) => p.id),
    faces,
    doubleFaced: !!(c.card_faces && c.card_faces.length > 1 && c.card_faces[1].image_uris),
    isToken: /token|emblem/i.test(c.type_line || '') || c.layout === 'token' || c.layout === 'emblem',
  };
  DB[c.id] = def;
  return def;
}

// ------------------------------------------------------------ decklist text
const SKIP_SECTIONS = /^(sideboard|maybeboard|maybe|considering|tokens?)\b/i;
const CMD_SECTIONS = /^(commanders?|command zone)\b/i;
const MAIN_SECTIONS = /^(deck|main|mainboard|main deck|library)\b/i;
const COMPANION_SECTIONS = /^companions?\b/i;

export function parseDecklist(text) {
  const commanders = [];
  const companions = [];
  const sideboard = [];
  const main = [];
  let section = 'main';
  let sawBlankAfterMain = false;
  const lines = String(text || '').split(/\r?\n/);
  for (let raw of lines) {
    let line = raw.trim();
    if (!line) {
      if (main.length) sawBlankAfterMain = true;
      continue;
    }
    if (line.startsWith('//') || line.startsWith('#')) {
      const h = line.replace(/^\/\/\s*|^#+\s*/, '');
      if (CMD_SECTIONS.test(h)) section = 'cmd';
      else if (COMPANION_SECTIONS.test(h)) section = 'companion';
      else if (SKIP_SECTIONS.test(h)) section = /^sideboard/i.test(h) ? 'sb' : 'skip';
      else if (MAIN_SECTIONS.test(h)) section = 'main';
      continue;
    }
    const header = line.replace(/:$/, '');
    if (!/^\d/.test(header) && header.split(' ').length <= 3) {
      if (CMD_SECTIONS.test(header)) { section = 'cmd'; continue; }
      if (COMPANION_SECTIONS.test(header)) { section = 'companion'; continue; }
      if (SKIP_SECTIONS.test(header)) { section = /^sideboard/i.test(header) ? 'sb' : 'skip'; continue; }
      if (MAIN_SECTIONS.test(header)) { section = 'main'; continue; }
    }
    if (/^SB:\s*/i.test(line)) {
      // MTGO style sideboard line. In Commander exports the commander is often the "sideboard".
      line = line.replace(/^SB:\s*/i, '');
      const e = parseLine(line);
      if (e) commanders.push(e);
      continue;
    }
    const isCmdTag = /\*CMDR\*/i.test(line);
    const e = parseLine(line);
    if (!e) continue;
    if (section === 'skip') continue;
    // a companion is often exported in the sideboard (Moxfield, Archidekt): kept if it turns out to have Companion
    if (section === 'sb') { sideboard.push(e); continue; }
    if (isCmdTag || section === 'cmd') commanders.push(e);
    else if (section === 'companion') companions.push(e);
    else main.push(e);
  }
  void sawBlankAfterMain;
  return { commanders, main, companions, sideboard };
}

function parseLine(line) {
  line = line.replace(/\s+#\S.*$/, '').replace(/\^[^^]*\^/g, '').replace(/\*[A-Z]+\*/gi, '').trim();
  const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
  let qty = 1;
  let rest = line;
  if (m) {
    qty = parseInt(m[1], 10);
    rest = m[2];
  }
  let set, cn;
  const sm = rest.match(/^(.*?)\s+[([]([A-Za-z0-9]{2,6})[)\]]\s*([A-Za-z0-9★\-]+)?\s*$/);
  if (sm) {
    rest = sm[1];
    set = sm[2].toLowerCase();
    cn = sm[3];
  }
  rest = rest.replace(/\s+/g, ' ').trim();
  if (!rest) return null;
  return { name: rest, qty, set, collector_number: cn };
}

// ------------------------------------------------------------ network
async function api(path, opts) {
  let res;
  try {
    res = await fetch(path, opts);
  } catch (e) {
    throw new Error('Cannot reach the playtester server. Start it with "node server.js" and open http://localhost:5173.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Request failed (' + res.status + ')');
  return body;
}

export async function importFromUrl(url) {
  return api('/api/deck?url=' + encodeURIComponent(url.trim()));
}

// Cards you've loaded before are kept on this computer, so a deck you've played loads instantly and still loads
// when Scryfall is down or busy (error 503). Only cards not seen before are asked for, and a busy Scryfall is retried.
export const fetchHooks = { status: () => {} };
const CARD_KEY = 'edh-card-cache-v1';
let cardStore = null;
const store = () => {
  if (cardStore) return cardStore;
  try { cardStore = JSON.parse(localStorage.getItem(CARD_KEY) || '{}') || {}; } catch (e) { cardStore = {}; }
  return cardStore;
};
const storeSave = () => {
  const st = store();
  let keys = Object.keys(st);
  // keep the most recently used ~2500 cards
  if (keys.length > 2500) {
    keys.sort((a, b) => (st[a].t || 0) - (st[b].t || 0));
    for (const k of keys.slice(0, keys.length - 2500)) delete st[k];
  }
  for (let tries = 0; tries < 4; tries++) {
    try {
      localStorage.setItem(CARD_KEY, JSON.stringify(st));
      return;
    } catch (e) {
      keys = Object.keys(st).sort((a, b) => (st[a].t || 0) - (st[b].t || 0)); // storage full: drop the oldest quarter
      for (const k of keys.slice(0, Math.ceil(keys.length / 4))) delete st[k];
    }
  }
};
// A saved card whose picture no longer loads (Scryfall replaced the image): forget it, so the next deck load asks again
export function forgetCachedCard(name) {
  const st = store();
  const nm = String(name || '').toLowerCase();
  let gone = 0;
  for (const k of Object.keys(st)) {
    const c = st[k] && st[k].c;
    if (k === 'n:' + nm || (c && String(c.name || '').toLowerCase().split(' // ')[0] === nm.split(' // ')[0])) { delete st[k]; gone++; }
  }
  if (gone) storeSave();
}
const identKey = (x) => (x.id ? 'id:' + x.id : x.set && x.collector_number ? `sc:${x.set}/${x.collector_number}`.toLowerCase() : 'n:' + String(x.name || '').toLowerCase());
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
export const loadStats = { cached: 0, fetched: 0, ms: 0 };
export async function fetchCards(identifiers, opts = {}) {
  const st = store();
  const now = Date.now();
  const found = identifiers.map((x) => {
    const hit = st[identKey(x)];
    if (hit) hit.t = now;
    return hit ? hit.c : null;
  });
  const missingIdx = found.map((c, i) => (c ? -1 : i)).filter((i) => i >= 0);
  if (missingIdx.length) {
    const want = missingIdx.map((i) => identifiers[i]);
    let cards = null;
    let lastErr = null;
    const waits = opts.retry === false ? [0] : [0, 1500, 4000, 8000];
    for (let k = 0; k < waits.length && !cards; k++) {
      if (waits[k]) {
        if (!opts.quiet) fetchHooks.status(`Scryfall is busy — trying again (${k} of ${waits.length - 1})…`);
        await sleepMs(waits[k]);
      }
      try {
        cards = (await api('/api/cards', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers: want }) })).cards;
      } catch (e) {
        lastErr = e;
        // only a busy / unavailable Scryfall is worth waiting for (429, 5xx); anything else fails at once
        if (!/Scryfall error (?:429|5\d\d)|timed? ?out|ECONNRESET|fetch failed/i.test(e.message)) throw e;
      }
    }
    if (!cards) {
      const code = (lastErr && (lastErr.message.match(/\b(429|5\d\d)\b/) || [])[1]) || '';
      throw new Error(`Scryfall (the card database this app uses) isn't answering right now${code ? ` (error ${code})` : ''}. It's usually back within a few minutes — try loading again then. Decks you've loaded before keep working.`);
    }
    missingIdx.forEach((i, j) => {
      found[i] = cards[j] || null;
      if (cards[j]) st[identKey(identifiers[i])] = { c: cards[j], t: now };
    });
    if (!opts.quiet) Object.assign(loadStats, { fetched: missingIdx.length, ms: Date.now() - now });
  }
  if (!opts.quiet) {
    loadStats.cached = identifiers.length - missingIdx.length;
    if (!missingIdx.length) Object.assign(loadStats, { fetched: 0, ms: 0 });
  }
  storeSave();
  const out = found.map((c) => (c ? normalize(c) : null));
  // Foreign-language pictures can only come from a printing picked by id or set + number (deck links); a card asked for
  // by name is already the English printing. Check those few, a few seconds later, so it never competes with loading.
  const printed = found.filter((c, i) => c && (identifiers[i].id || identifiers[i].collector_number));
  if (!opts.quiet) {
    const all = found.filter(Boolean);
    sharpFromCache(all);
    setTimeout(() => (printed.length ? englishImages(printed) : Promise.resolve()).catch(() => {}).then(() => sharpImages(all)).catch(() => {}), 4000);
  }
  return out;
}

// A deck link can point at a Japanese, German… printing, whose card images are in that language. The rules text
// we use is always English; swap the pictures for the English printing's. This runs in the background after the
// deck has loaded, with short timeouts, and remembers which cards are English so it only ever asks Scryfall once.
export const imageHooks = { changed: () => {} };
const EN_KEY = 'edh-en-ids';
let enKnown = null;
const enSet = () => {
  if (enKnown) return enKnown;
  try { enKnown = new Set(JSON.parse(localStorage.getItem(EN_KEY) || '[]')); } catch (e) { enKnown = new Set(); }
  return enKnown;
};
const enSave = () => {
  try { localStorage.setItem(EN_KEY, JSON.stringify([...enSet()].slice(-20000))); } catch (e) { /* storage full or blocked: just ask again next time */ }
};
async function englishImages(cards) {
  const sf = async (url, opts) => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}) }, ...(ctl ? { signal: ctl.signal } : {}), ...opts });
      return r.ok ? await r.json() : null;
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const known = enSet();
  // newer servers say which language each card is; older ones don't, so ask Scryfall about the ones we haven't seen
  for (const c of cards) if (c.lang === 'en') known.add(c.id);
  const unknown = [...new Set(cards.filter((c) => c.lang === undefined && !known.has(c.id) && !c.id.startsWith('gen-')).map((c) => c.id))];
  for (let i = 0; i < unknown.length; i += 75) {
    const body = await sf('https://api.scryfall.com/cards/collection', { method: 'POST', body: JSON.stringify({ identifiers: unknown.slice(i, i + 75).map((id) => ({ id })) }) });
    if (!body) return; // offline / Scryfall slow: try again next time
    for (const x of body.data || []) if (x.lang === 'en') known.add(x.id); else for (const c of cards) if (c.id === x.id) c.lang = x.lang;
  }
  enSave();
  let swapped = 0;
  for (const c of cards) {
    if (!c.lang || c.lang === 'en' || !DB[c.id]) continue;
    let en = (c.set && c.collector_number && (await sf(`https://api.scryfall.com/cards/${encodeURIComponent(c.set)}/${encodeURIComponent(c.collector_number)}/en`))) || null;
    if (!en || en.lang !== 'en') en = await sf('https://api.scryfall.com/cards/named?exact=' + encodeURIComponent(c.name.split(' // ')[0]));
    if (!en || en.lang !== 'en') continue;
    const srcFaces = en.card_faces && en.card_faces.length && en.card_faces[0].image_uris ? en.card_faces : [en];
    DB[c.id].faces.forEach((f, k) => {
      const u = (srcFaces[k] || srcFaces[0]).image_uris || en.image_uris;
      if (u) {
        f.img = u.normal;
        f.imgLarge = u.large || u.normal;
      }
    });
    c.lang = 'en';
    swapped++;
  }
  if (swapped) imageHooks.changed();
}

// Some printings only have a low-resolution scan on Scryfall (new sets, promos): they look blurry. Use the picture of a
// sharp English printing of the same card instead, the same artwork if there is one. Runs in the background after a deck
// loads, asks Scryfall once per card, and remembers the answer.
const SHARP_OK = 'edh-sharp-ok';
const SHARP_SWAP = 'edh-sharp-swap';
const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') || d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } };
function applySharp(id, faces) {
  const d = DB[id];
  if (!d || !faces) return false;
  d.faces.forEach((f, k) => {
    const u = faces[k] || faces[0];
    if (u && u.img) { f.img = u.img; f.imgLarge = u.imgLarge || u.img; }
  });
  return true;
}
function sharpFromCache(cards) {
  const swap = lsGet(SHARP_SWAP, {});
  let n = 0;
  for (const c of cards) if (swap[c.id] && applySharp(c.id, swap[c.id])) n++;
  if (n) imageHooks.changed();
}
async function sharpImages(cards) {
  if (typeof fetch === 'undefined') return;
  const sf = async (url, opts) => {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await fetch(url, { headers: { Accept: 'application/json', ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}) }, ...(ctl ? { signal: ctl.signal } : {}), ...opts });
      return r.ok ? await r.json() : null;
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = new Set(lsGet(SHARP_OK, []));
  const swap = lsGet(SHARP_SWAP, {});
  const todo = cards.filter((c) => c && DB[c.id] && !ok.has(c.id) && !swap[c.id] && !String(c.id).startsWith('gen-'));
  if (!todo.length) return;
  // what Scryfall says about each scan (older saved cards don't carry it)
  const info = {};
  for (const c of todo) if (c.image_status) info[c.id] = { status: c.image_status, oracle: c.oracle_id, illus: c.illustration_id, name: c.name };
  const ask = todo.filter((c) => !info[c.id]).map((c) => c.id);
  for (let i = 0; i < ask.length; i += 75) {
    const body = await sf('https://api.scryfall.com/cards/collection', { method: 'POST', body: JSON.stringify({ identifiers: ask.slice(i, i + 75).map((id) => ({ id })) }) });
    if (!body) return; // offline / Scryfall slow: try again next time
    for (const x of body.data || []) info[x.id] = { status: x.image_status, oracle: x.oracle_id, illus: x.illustration_id || (x.card_faces && x.card_faces[0].illustration_id), name: x.name };
    await wait(120);
  }
  let changed = 0;
  for (const c of todo) {
    const inf = info[c.id];
    if (!inf) continue;
    if (inf.status === 'highres_scan') { ok.add(c.id); continue; }
    if (!inf.oracle) continue;
    await wait(120);
    const res = await sf(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(`oracleid:${inf.oracle} lang:en game:paper`)}&unique=prints&order=released&dir=desc`);
    const prints = ((res && res.data) || []).filter((x) => x.image_status === 'highres_scan' && !x.oversized && x.lang === 'en');
    if (!prints.length) { ok.add(c.id); continue; } // nothing sharper exists yet
    const same = prints.find((x) => inf.illus && (x.illustration_id === inf.illus || (x.card_faces && x.card_faces[0].illustration_id === inf.illus)));
    const best = same || prints[0];
    const src = best.card_faces && best.card_faces.length && best.card_faces[0].image_uris ? best.card_faces : [best];
    const faces = DB[c.id].faces.map((f, k) => { const u = (src[k] || src[0]).image_uris || best.image_uris; return u ? { img: u.normal, imgLarge: u.large || u.normal } : null; });
    if (!faces.some(Boolean)) continue;
    swap[c.id] = faces;
    if (applySharp(c.id, faces)) changed++;
  }
  lsSet(SHARP_OK, [...ok].slice(-30000));
  lsSet(SHARP_SWAP, swap);
  if (changed) imageHooks.changed();
}

// Saved decks live on the local server (saved-decks.json).
export async function listSaved() {
  return (await api('/api/saved')).decks || [];
}
export async function saveDeck(entry) {
  return api('/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry) });
}
export async function deleteSaved(id) {
  return api('/api/saved?id=' + encodeURIComponent(id), { method: 'DELETE' });
}
// A loaded deck back to plain decklist text (keeps your chosen commanders).
export function deckToText(deck) {
  const count = (ids) => {
    const m = new Map();
    for (const id of ids) m.set(DB[id].name, (m.get(DB[id].name) || 0) + 1);
    return [...m].map(([nm, k]) => `${k} ${nm}`).join('\n');
  };
  return `Commander\n${count(deck.commanders)}\n\n${(deck.companions || []).length ? `Companion\n${count(deck.companions)}\n\n` : ''}Deck\n${count(deck.cards)}`;
}

export async function searchTokens(q) {
  const { cards } = await api('/api/tokens?q=' + encodeURIComponent(q || ''));
  return cards.map(normalize);
}

// Resolve a parsed deck ({name, commanders, main}) into card definitions.
// Returns {name, commanders:[defId], cards:[defId,... one per copy], missing:[names]}
export async function resolveDeck(parsed) {
  const all = [
    ...parsed.commanders.map((e) => ({ ...e, cmd: true })),
    ...(parsed.companions || []).map((e) => ({ ...e, companion: true })),
    ...(parsed.sideboard || []).map((e) => ({ ...e, companion: true, sb: true })),
    ...parsed.main,
  ];
  const idents = all.map((e) =>
    e.set && e.collector_number ? { name: e.name, set: e.set, collector_number: e.collector_number } : { name: e.name }
  );
  const defs = await fetchCards(idents);
  const out = { name: parsed.name || 'Deck', commanders: [], companions: [], cards: [], missing: [] };
  all.forEach((e, i) => {
    const d = defs[i];
    if (!d) return e.sb ? undefined : out.missing.push(e.name);
    if (e.sb && !/(?:^|\n)Companion —/.test(d.faces[0].oracle || '')) return; // ordinary sideboard card: not in the deck
    if (e.cmd) out.commanders.push(d.id);
    else if (e.companion && /(?:^|\n)Companion —/.test(d.faces[0].oracle || '')) out.companions.push(d.id);
    else for (let k = 0; k < (e.qty || 1); k++) out.cards.push(d.id);
  });
  // Pre-load the tokens these cards can make, so the AI (and the token menu) can use them.
  const tokenIds = [...new Set([...out.commanders, ...out.cards].flatMap((id) => DB[id].tokens))].filter(
    (id) => !DB[id]
  );
  // In the background: the deck is ready without them, and a busy Scryfall shouldn't hold up loading.
  if (tokenIds.length) fetchCards(tokenIds.slice(0, 150).map((id) => ({ id })), { retry: false, quiet: true }).catch(() => {});
  return out;
}

function uniqueDefs(ids) {
  const seen = new Set();
  return ids.map((id) => DB[id]).filter((d) => d && !seen.has(d.id) && seen.add(d.id));
}

// What lets a card share the command zone with a second commander.
export function pairing(d) {
  const f = d.faces[0];
  const kw = d.keywords;
  const pw = f.oracle.match(/^Partner with ([^(\n]+?)\s*(?:\(|$)/m);
  // "Partner—Character select", "Partner—Friends forever": pairs only with the same kind
  const pv = f.oracle.match(/^Partner\s*[—–-]\s*([^(\n]+?)\s*(?:\(|$)/m);
  const variant = pv ? pv[1].trim().toLowerCase() : null;
  return {
    partner: (kw.includes('partner') || /^Partner\s*(?:\(|$)/m.test(f.oracle)) && !pw && !variant,
    partnerWith: pw ? pw[1].trim() : null,
    partnerVariant: variant && variant !== 'friends forever' ? variant : null,
    friendsForever: kw.includes('friends forever') || variant === 'friends forever',
    chooseBackground: kw.includes('choose a background') || /Choose a Background/.test(f.oracle),
    isBackground: /\bBackground\b/.test(f.typeLine),
    doctorsCompanion: kw.includes("doctor's companion") || /Doctor's companion/.test(f.oracle),
    isDoctor: /Time Lord Doctor/.test(f.typeLine),
  };
}

export function canPair(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const x = pairing(a);
  const y = pairing(b);
  return (
    (x.partner && y.partner) ||
    x.partnerWith === b.name ||
    y.partnerWith === a.name ||
    (x.friendsForever && y.friendsForever) ||
    (!!x.partnerVariant && x.partnerVariant === y.partnerVariant) ||
    (x.chooseBackground && y.isBackground) ||
    (y.chooseBackground && x.isBackground) ||
    (x.doctorsCompanion && y.isDoctor) ||
    (y.doctorsCompanion && x.isDoctor)
  );
}

export function wantsPair(d) {
  const x = pairing(d);
  return x.partner || !!x.partnerWith || !!x.partnerVariant || x.friendsForever || x.chooseBackground || x.doctorsCompanion || x.isDoctor || x.isBackground;
}

export function legendaryCandidates(deck) {
  return uniqueDefs(deck.cards).filter((d) => {
    const t = d.faces[0].typeLine;
    // legendary Vehicles / Spacecraft with a power/toughness box can lead too (2025 rules change)
    return (/Legendary/.test(t) && (/Creature/.test(t) || (/\b(?:Vehicle|Spacecraft)\b/.test(t) && d.faces[0].power != null))) || /can be your commander/i.test(d.faces[0].oracle);
  });
}

// Cards in the deck that could be the second commander next to `first`.
export function secondCandidates(deck, firstId) {
  const first = DB[firstId];
  return uniqueDefs(deck.cards).filter((d) => canPair(first, d));
}

// ------------------------------------------------------------ samples
const basics = (n, name) => `${n} ${name}`;

// Official preconstructed Commander decks: { key: { label, set, text } } (same decklist format as the samples)
export const PRECON_DECKS = {
  trc_federation: {
    label: "Federation Fleet (Jean-Luc Picard, Luminary)",
    set: "Star Trek Commander",
    bracket: 2,
    text: `Commander
1 Jean-Luc Picard, Luminary

Deck
1 Captain Janeway, Endgame
1 Ambassador K'Ehleyr
1 Beverly Crusher, Ship's Doctor
1 Dr. Pulaski, Cynical Clinician
1 Ensign Harry Kim, Operations
1 Ezri Dax, Newly Joined
1 Guinan, Ancient Advisor
1 Julian Bashir, Frontier Doctor
1 Spot, Felis catus
1 U.S.S. Enterprise-E, Sovereign
1 Chief Miles O'Brien
1 Data, Exploring Humanity
1 Geordi La Forge, Innovator
1 Kes, Evolving Telepath
1 On the Shoulders of Giants
1 Seven of Nine, Tertiary Adjunct
1 Temporal Tribulation
1 Tuvok, Chief Tactical Officer
1 Ro Laren, Double Agent
1 Rom and Leeta, Unlikely Pair
1 B'Elanna Torres, Scrapper
1 Cmdr. Troi, Outgoing Empath
1 Commander William Riker
1 Reg Barclay, Fidgety Fantasist
1 Tom Paris, Risk-Taker
1 Unification
1 Vic Fontaine, One Night Only
1 Worf, Son of Mogh
1 U.S.S. Defiant, Tough Little Ship
1 U.S.S. Enterprise-C, Time-Tossed
1 U.S.S. Prometheus, Prototype
1 U.S.S. Stargazer, Here and There
1 Grand Crescendo
1 Loran of the Third Path
1 Promise of Loyalty
1 Cryptic Command
1 Chain Reaction
1 Fevered Visions
1 Fractured Identity
1 Supreme Verdict
1 Alhammarret's Archive
1 Howling Mine
1 Battlefield Forge
1 Clifftop Retreat
1 Coastal Peak
1 Command Beacon
1 Desolate Lighthouse
1 Exotic Orchard
1 Fabled Passage
1 Frostboil Snarl
1 Furycalm Snarl
1 Glacial Fortress
1 Glittering Massif
1 Irrigated Farmland
1 Port Town
1 Prairie Stream
1 Radiant Summit
1 Scorched Geyser
1 Sulfur Falls
1 Training Center
1 Malfunctioning Holodeck
1 Chronomantic Escape
1 Swords to Plowshares
1 Frantic Search
1 Negate
1 Pongify
1 Abrade
1 Thrill of Possibility
1 Faithful Mending
1 Arcane Signet
1 Commander's Sphere
1 Hedron Archive
1 Mind Stone
1 Sol Ring
1 Stonespeaker Crystal
1 Talisman of Conviction
1 Talisman of Creativity
1 Talisman of Progress
1 Thought Vessel
1 Command Tower
1 Evolving Wilds
1 Mystic Monastery
1 Path of Ancestry
1 Perilous Landscape
1 Reliquary Tower
1 Terramorphic Expanse
5 Island
4 Plains
4 Mountain`,
  },
  trc_landing: {
    label: "Landing Party (Commander Spock)",
    set: "Star Trek Commander",
    bracket: 2,
    text: `Commander
1 Commander Spock

Deck
1 Captain Kirk, Boldly Going
1 Balance of Terror
1 Merciful Mandate
1 M'Ress, Crew Coordinator
1 Shuttlecraft Galileo
1 Tribble Cluster
1 Colossal Clone Master
1 Fleet Captain Christopher Pike
1 Giant Space Amoeba
1 Lieutenant Nyota Uhura
1 Sam Kirk, Xenoanthropologist
1 Temporal Tribulation
1 Amanda Grayson, Logic's Link
1 Christine Chapel, Combat Medic
1 Janice Rand, Essential Aide
1 Lieutenant Hikaru Sulu
1 Chief Kyle, Transporter Tech
1 Chief Montgomery Scott
1 Lt. Arex, Ever-Adapting
1 McCoy, Not a Bricklayer
1 Pavel Chekov, First Posting
1 T'Pring, Never Parted
1 Command Chair
1 The Guardian of Forever
1 Jefferies Tube
1 Planet Killer
1 S.S. Botany Bay
1 Starfleet Communicator
1 Starship Enterprise
1 U.S.S. Defiant, Mirror Migrant
1 U.S.S. Farragut, Bold Explorer
1 Shore Leave Planet
1 Austere Command
1 Sun Titan
1 Wrath of God
1 Echo of Eons
1 Ancient Greenwarden
1 Augur of Autumn
1 Exploration
1 Guardian Project
1 Heroic Intervention
1 Lotus Cobra
1 Scute Swarm
1 Tireless Tracker
1 Canopy Vista
1 Exotic Orchard
1 Fabled Passage
1 Fortified Village
1 Glacial Fortress
1 Hinterland Harbor
1 Irrigated Farmland
1 Mosswort Bridge
1 Mutavault
1 Port Town
1 Prairie Stream
1 Rain-Slicked Copse
1 Scattered Groves
1 Sea of Clouds
1 Sodden Verdure
1 Sunpetal Grove
1 Temple of Enlightenment
1 Temple of Mystery
1 Temple of Plenty
1 Vineglimmer Snarl
1 Cold-Blooded Crew
1 Syndicate Liquidators
1 Earth, Sector 001
1 Risa
1 Vulcan
1 Path to Exile
1 Brainstorm
1 Ponder
1 Reality Shift
1 Beast Within
1 Cultivate
1 Farseek
1 Harmonize
1 Nature's Lore
1 Rampant Growth
1 Satyr Wayfinder
1 Growth Spiral
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Evolving Wilds
1 Path of Ancestry
1 Reliquary Tower
1 Seaside Citadel
1 Temple of the False God
1 Terramorphic Expanse
1 Tranquil Landscape
4 Forest
2 Plains
2 Island`,
  },
  trc_klingon: {
    label: "Klingon Fury (Worf, Defiant Commander)",
    set: "Star Trek Commander",
    bracket: 2,
    text: `Commander
1 Worf, Defiant Commander

Deck
1 Kor, Cause of Vengeance
1 Ambassador K'Ehleyr
1 Imperial Hullbreachers
1 Indelicate Healer
1 Korok, Liberated Rage
1 Martok, Hero of the Empire
1 Merciful Mandate
1 Right of Vengeance
1 Blood-Sport Champion
1 Kurn, Son of Mogh
1 The Promise of Kahless
1 Voq, Torchbearer
1 The Beacon of Kahless
1 Ferocious Colonist
1 Gagh Slinger
1 Galvanizing Tenor
1 Glory to the Empire!
1 Gnarling Targ
1 Grilka, Widowed Warrior
1 Kang, Suspicious Captain
1 Koloth, Tribble Hunter
1 Own the Day
1 Qo'noS Quartermaster
1 Alexander, Ship's Fool
1 Chancellor Gorkon
1 Curzon Dax, Bound by Blood
1 Rite of Ascension
1 Sins of the Father
1 I.K.S. Negh'Var, Imperial Flagship
1 K't'inga-Class Battle Cruiser
1 K'Vort-Class Raider
1 The Sword of Kahless
1 Concerted Effort
1 Duelist's Heritage
1 Vanquish the Horde
1 Painful Truths
1 Combat Celebrant
1 Disrupt Decorum
1 Professional Face-Breaker
1 Shared Animosity
1 World at War
1 Pest Control
1 Ruinous Ultimatum
1 Vindicate
1 Warleader's Call
1 Sword of Light and Shadow
1 Battlefield Forge
1 Canyon Slough
1 Clifftop Retreat
1 Dragonskull Summit
1 Eclipsed Steppe
1 Exotic Orchard
1 Foreboding Ruins
1 Furycalm Snarl
1 Glittering Massif
1 Isolated Chapel
1 Radiant Summit
1 Shineshadow Snarl
1 Smoldering Marsh
1 Temple of Malice
1 Umbral Expanse
1 Vault of Champions
1 Cha'DIch Investigator
1 Path to Exile
1 Return to Dust
1 Valorous Stance
1 Night's Whisper
1 Rite of Oblivion
1 Terminate
1 Arcane Signet
1 Herald's Horn
1 Lightning Greaves
1 Mind Stone
1 Sol Ring
1 Talisman of Conviction
1 Talisman of Hierarchy
1 Talisman of Indulgence
1 Command Tower
1 Evolving Wilds
1 Nomad Outpost
1 Path of Ancestry
1 Rogue's Passage
1 Shattered Landscape
1 Terramorphic Expanse
5 Mountain
5 Plains
5 Swamp`,
  },
  trc_borg: {
    label: "We Are the Borg (The Borg Queen)",
    set: "Star Trek Commander",
    bracket: 2,
    text: `Commander
1 The Borg Queen

Deck
1 Locutus of Borg
1 Borg Incursion
1 Emergency Regeneration
1 Join the Collective
1 Korok, Liberated Rage
1 Maturation Chamber
1 Stratagem Emulator
1 Supplementation Node
1 Type-03 Borg Vessel
1 Ambulatory Reactor
1 Borg Scout Sphere
1 Co-Option Adjutant
1 Gift of Perfection
1 Optimization Annex
1 Seven of Nine, Tertiary Adjunct
1 Transwarp Hub
1 Võx, Child of the Collective
1 Assimilate the Wounded
1 Assimilation Assessor
1 Battle of Wolf 359
1 Extraction Integrant
1 Reclamation Specialist
1 The Best of Both Worlds
1 Collective Override
1 Deliver from Chaos
1 Hugh, First of Many
1 Jurati, Cordial Queen
1 One, Borg Evolved
1 Class-4 Tactical Cube
1 Queen's Diamond
1 Reconnaissance Partition
1 Shore Leave Planet
1 Tempered Steel
1 Disallow
1 Toxic Deluge
1 Anguished Unmaking
1 Astral Cornucopia
1 Darksteel Plate
1 Door of Destinies
1 Forsaken Monument
1 The Immortal Sun
1 Skullclamp
1 Unwinding Clock
1 Academy Ruins
1 Choked Estuary
1 Drowned Catacomb
1 Eclipsed Steppe
1 Exotic Orchard
1 Fetid Pools
1 Glacial Fortress
1 Irrigated Farmland
1 Isolated Chapel
1 Morphic Pool
1 Port Town
1 Prairie Stream
1 Shineshadow Snarl
1 Skycloud Expanse
1 Spire of Industry
1 Sunken Hollow
1 Umbral Expanse
1 Underground River
1 Command Subadjunct
1 Conquest Mission
1 Hive Mind Coprocessor
1 Locutus, the One Who Speaks
1 Dispatch
1 Return to Dust
1 Thirst for Knowledge
1 Thoughtcast
1 Bitter Triumph
1 Arcane Signet
1 Commander's Sphere
1 Everflowing Chalice
1 Sol Ring
1 Stonespeaker Crystal
1 Swiftfoot Boots
1 Talisman of Dominance
1 Talisman of Hierarchy
1 Talisman of Progress
1 Wayfarer's Bauble
1 Arcane Sanctum
1 Command Tower
1 Contaminated Landscape
1 Evolving Wilds
1 Path of Ancestry
1 Rogue's Passage
1 Terramorphic Expanse
4 Plains
4 Island
4 Swamp`,
  },
  rfc_multiverse: {
    label: "Multiverse Reforged (Jace, Multiverse Architect)",
    set: "Reality Fracture Commander",
    bracket: 2,
    text: `Commander
1 Jace, Multiverse Architect

Deck
1 Akroma, Angel of Fury
1 Archfiend of Despair
1 Archon of Cruelty
1 Avacyn, Angel of Horror
1 Dack Fayden, Helping Hand
1 Darksteel Angel
1 Ginger, Queen of Sweets
1 Jhoira, Weatherlight Corsair
1 Memnarch, the Warden
1 Nissa, Leyline Tamer
1 Niv-Mizzet, Ghost Counsel
1 Ob Nixilis, the Ascended
1 Omnath, Locus of the Void
1 Overlord of the Mistmoors
1 Serra's Emissary
1 Tamiyo, Upriser Crowned
1 The Ur-Sphinx
1 Venser, Fervent Forger
1 Brainstorm
1 Brainsurge
1 Despark
1 Fact or Fiction
1 Fatehold Charm
1 Flawless Maneuver
1 Grand Crescendo
1 Occult Epiphany
1 Path to Exile
1 Secure the Wastes
1 Stroke of Midnight
1 Swords to Plowshares
1 Synthetic Destiny
1 Teferi's Reproach
1 Lingering Souls
1 Martial Coup
1 Mass Polymorph
1 Sunfall
1 White Sun's Twilight
1 Arcane Signet
1 Azorius Signet
1 Chromatic Lantern
1 Currency Converter
1 Cursed Mirror
1 Dimir Signet
1 Fellwar Stone
1 Izzet Signet
1 Proteus Staff
1 Rakdos Signet
1 Sol Ring
1 Staff of the Storyteller
1 Talisman of Creativity
1 Talisman of Dominance
1 Talisman of Indulgence
1 Talisman of Progress
1 Dreadhorde Invasion
1 Plan for All Outcomes
1 Shark Typhoon
1 Skrelv's Hive
1 Whirlwind of Thought
1 Windcrag Siege
1 Elspeth, Sun's Champion
1 Battlefield Forge
1 Caves of Koilos
1 Clifftop Retreat
1 Command Tower
1 Contaminated Landscape
1 Drowned Catacomb
1 Exotic Orchard
1 Fabled Passage
1 Fetid Heath
1 Glacial Fortress
3 Island
1 Isolated Chapel
1 Kher Keep
2 Mountain
1 Mystic Gate
1 Path of Ancestry
1 Perilous Landscape
4 Plains
1 Prairie Stream
1 Radiant Summit
1 Reflecting Pool
1 Restless Anchorage
1 Restless Spire
1 Shivan Reef
1 Sulfur Falls
1 Sulfurous Springs
1 Sunken Ruins
2 Swamp
1 Turbulent Crater
1 Turbulent Shore
1 Turbulent Wetlands
1 Underground River`,
  },
  ecc_blight: {
    label: "Blight Curse (Auntie Ool, Cursewretch)",
    set: "Lorwyn Eclipsed Commander",
    bracket: 2,
    text: `Commander
1 Auntie Ool, Cursewretch

Deck
1 Archfiend of Ifnir
1 Carnifex Demon
1 Channeler Initiate
1 Devoted Druid
1 Dread Tiller
1 Dusk Urchins
1 Evolution Sage
1 Ferrafor, Young Yew
1 Glissa Sunslayer
1 Grave Titan
1 Grim Poppet
1 Hapatra, Vizier of Poisons
1 Ignoble Hierarch
1 Kulrath Knight
1 Massacre Girl, Known Killer
1 Midnight Banshee
1 Necroskitter
1 Oft-Nabbed Goat
1 Puppeteer Clique
1 Sinister Gnarlbark
1 Skinrender
1 Soul Snuffers
1 The Reaper, King No More
1 The Scorpion God
1 Tree of Perdition
1 Village Pillagers
1 Wickerbough Elder
1 Assassin's Trophy
1 Cathartic Pyre
1 Fire Covenant
1 Infernal Grasp
1 Putrefy
1 Terminate
1 Aberrant Return
1 Black Sun's Zenith
1 Burning Curiosity
1 Cathartic Reunion
1 Chain Reaction
1 Eventide's Shadow
1 Harmonize
1 Hoarder's Greed
1 Incremental Blight
1 Night's Whisper
1 Painful Truths
1 Persist
1 Arcane Signet
1 Chimil, the Inner Sun
1 Commander's Sphere
1 Contagion Clasp
1 Sol Ring
1 Wickersmith's Tools
1 Binding the Old Gods
1 Blowfly Infestation
1 Everlasting Torment
1 Flourishing Defenses
1 Grave Venerations
1 Lasting Tarfire
1 Puca's Covenant
1 Liliana, Death Wielder
1 Vraska, Betrayal's Sting
1 Canyon Slough
1 Cinder Glade
1 Command Tower
1 Dragonskull Summit
1 Evolving Wilds
1 Exotic Orchard
1 Festering Thicket
6 Forest
1 Golgari Rot Farm
1 Gruul Turf
1 Ifnir Deadlands
4 Mountain
1 Nesting Grounds
1 Path of Ancestry
1 Rakdos Carnarium
1 Riveteers Overlook
1 Rootbound Crag
1 Savage Lands
1 Sheltered Thicket
1 Smoldering Marsh
8 Swamp
1 Terramorphic Expanse
1 Vernal Fen
1 Woodland Cemetery`,
  },
  msh_avengers: {
    label: "Avengers Assemble (Captain America, Team Leader)",
    set: "Marvel Super Heroes Commander",
    bracket: 2,
    text: `Commander
1 Captain America, Team Leader

Deck
1 Ant-Man, Elusive Avenger
1 Bastion Protector
1 Black Widow, Agile Avenger
1 Captain America, Living Legend
1 Captain Mar-Vell, Space-Born
1 Captain Marvel, Apex Avenger
1 Director Nick Fury
1 Falcon and Redwing
1 Firebird, Blazing Ranger
1 Hawkeye, Avenging Archer
1 Hercules, Olympian Hero
1 Iron Man, Armored Avenger
1 Jarvis, Earth's Mightiest Butler
1 Jocasta, Automaton Avenger
1 Metallic Mimic
1 Patriot, Shield Wielder
1 Photon, Mighty Marvel
1 Professor Hulk
1 Quicksilver, Speedster
1 Rescue, Pepper Potts
1 Scarlet Witch, Chaotic Avenger
1 Shang-Chi and the Ten Rings
1 She-Hulk, Wallbreaker
1 Speed, Young Avenger
1 The Wasp, Winsome Avenger
1 Thor, Asgard's Avenger
1 Vision, Synthezoid Avenger
1 War Machine, Avenging Arsenal
1 Winter Soldier, Reborn Avenger
1 Arcane Denial
1 Destroy Evil
1 Heroic Return
1 Heroic Sacrifice
1 Make Your Move
1 Methods of the Mighty
1 Swords to Plowshares
1 Austere Command
1 Avenge
1 Dismantling Wave
1 Raise the Palisade
1 Rip Apart
1 West Coast Expansion
1 Arcane Signet
1 Herald's Horn
1 Avengers Quinjet
1 Door of Destinies
1 Hero's Blade
1 Hulkbuster Armor
1 Relic of Legends
1 Fellwar Stone
1 Sol Ring
1 Talisman of Conviction
1 Talisman of Creativity
1 Talisman of Progress
1 Thought Vessel
1 Tome of Legends
1 Folk Hero
1 Gift of Immortality
1 Kindred Discovery
1 Love on the Battlefield
1 Reconnaissance Mission
1 Avengers Tower
1 Clifftop Retreat
1 Coastal Peak
1 Command Tower
1 Exotic Orchard
1 Frostboil Snarl
1 Furycalm Snarl
1 Glacial Fortress
1 Glittering Massif
1 Irrigated Farmland
5 Island
5 Mountain
1 Mystic Monastery
1 Path of Ancestry
6 Plains
1 Plaza of Heroes
1 Port Town
1 Prairie Stream
1 Radiant Summit
1 Scavenger Grounds
1 Scorched Geyser
1 Secluded Courtyard
1 Spectator Seating
1 Sulfur Falls
1 Unclaimed Territory`,
  },
  msh_doom: {
    label: "Doom Prevails (Doctor Doom, King of Latveria)",
    set: "Marvel Super Heroes Commander",
    bracket: 2,
    text: `Commander
1 Doctor Doom, King of Latveria

Deck
1 Loki, the Deceiver
1 Abomination, World Ravager
1 Baron Strucker, HYDRA Overlord
1 Batroc the Leaper
1 Chameleon, Master of Disguise
1 Containment Construct
1 Helmut Zemo, Mastermind
1 Iron Monger, Sadistic Tycoon
1 Kang Prime
1 Kang, Temporal Tyrant
1 Killmonger, Ruthless Usurper
1 Klaw, Master of Sound
1 Lady Loki, Agent of Chaos
1 Living Laser
1 Madame Hydra
1 Molecule Man
1 Moonstone, Harsh Mistress
1 Prowler, Clawed Thief
1 Puppet Master, String Puller
1 Red Ghost, Intangible Genius
1 Spark Double
1 Stilt-Man, Towering Terror
1 Superior Foes of Spider-Man
1 The Frightful Four
1 The Squadron Sinister
1 Titan of Littjara
1 Titania, Proud Pummeler
1 Tombstone, Career Criminal
1 Tri-Sentinel, Act of Vengeance
1 Typhoid Mary, Fractured
1 Ultron, Unlimited
1 Arcane Signet
1 Currency Converter
1 Damocles Base, Sword of Kang
1 Doom's Time Platform
1 Loki's Scepter
1 Patchwork Banner
1 Progenitor's Icon
1 Skullclamp
1 Sol Ring
1 Swiftfoot Boots
1 Talisman of Dominance
1 Talisman of Indulgence
1 Blasphemous Act
1 Endless Ranks of HYDRA
1 Extract Power
1 Kindred Dominance
1 Night's Whisper
1 Syphon Mind
1 Toxic Deluge
1 Vandalblast
1 Age of Ultron
1 Archnemesis
1 Black Market Connections
1 Glorious Purpose
1 Kang Dynasty
1 Propaganda
1 Bedevil
1 Chaos Warp
1 Lethal Scheme
1 Terminate
1 Withering Torment
1 Canyon Slough
1 Choked Estuary
1 Coastal Peak
1 Command Tower
1 Crumbling Necropolis
1 Dragonskull Summit
1 Drowned Catacomb
1 Exotic Orchard
1 Fetid Pools
1 Foreboding Ruins
1 Frostboil Snarl
4 Island
1 Luxury Suite
5 Mountain
1 Path of Ancestry
1 Scavenger Grounds
1 Scorched Geyser
1 Secluded Courtyard
1 Smoldering Marsh
1 Sulfur Falls
1 Sunken Hollow
6 Swamp
1 Terramorphic Expanse
1 Unclaimed Territory
1 Villainous Hideout`,
  },
  tdc_jeskai: {
    label: "Jeskai Striker (Shiko and Narset, Unified)",
    set: "Tarkir: Dragonstorm Commander",
    bracket: 2,
    text: `Commander
1 Shiko and Narset, Unified

Deck
1 Archmage Emeritus
1 Baral and Kari Zev
1 Caldera Pyremaw
1 Elsha, Threefold Master
1 Goblin Electromancer
1 Guttersnipe
1 Haughty Djinn
1 Lier, Disciple of the Drowned
1 Manaform Hellkite
1 Mangara, the Diplomat
1 Monastery Mentor
1 Storm-Kiln Artist
1 Third Path Iconoclast
1 Transcendent Dragon
1 Velomachus Lorehold
1 Veyran, Voice of Duality
1 Voracious Bibliophile
1 Young Pyromancer
1 Abrade
1 Big Score
1 Consider
1 Electrodominance
1 Expansion // Explosion
1 Frantic Search
1 Magma Opus
1 Narset's Reversal
1 Opt
1 Pongify
1 Prismari Command
1 Sublime Epiphany
1 Swords to Plowshares
1 Think Twice
1 Transforming Flourish
1 Ancestral Vision
1 Baral's Expertise
1 Compulsive Research
1 Curse of the Swine
1 Deep Analysis
1 Dismantling Wave
1 Expressive Iteration
1 Faithless Looting
1 Mana Geyser
1 Ponder
1 Preordain
1 Rite of Replication
1 Time Wipe
1 Vanquish the Horde
1 Will of the Jeskai
1 Adaptive Training Post
1 Arcane Signet
1 Azorius Signet
1 Boros Signet
1 Fellwar Stone
1 Izzet Signet
1 Sol Ring
1 Talisman of Progress
1 Aligned Heart
1 Curse of Opulence
1 Ghostly Prison
1 Shiny Impetus
1 Tempest Technique
1 Whirlwind of Thought
1 Adarkar Wastes
1 Ash Barrens
1 Battlefield Forge
1 Cascade Bluffs
1 Clifftop Retreat
1 Command Tower
1 Evolving Wilds
1 Exotic Orchard
1 Ferrous Lake
1 Glacial Fortress
1 Irrigated Farmland
5 Island
5 Mountain
4 Plains
1 Mystic Monastery
1 Path of Ancestry
1 Perilous Landscape
1 Prairie Stream
1 Reliquary Tower
1 Rugged Prairie
1 Shivan Reef
1 Skycloud Expanse
1 Sulfur Falls
1 Temple of Enlightenment
1 Temple of Epiphany
1 Temple of Triumph`,
  },
  tdc_temur: {
    label: "Temur Roar (Ureni of the Unwritten)",
    set: "Tarkir: Dragonstorm Commander",
    bracket: 2,
    text: `Commander
1 Ureni of the Unwritten

Deck
1 Eshki, Temur's Roar
1 Bountiful Landscape
1 Cinder Glade
1 Command Tower
1 Evolving Wilds
1 Exotic Orchard
1 Flooded Grove
5 Forest
1 Frontier Bivouac
1 Haven of the Spirit Dragon
1 Hinterland Harbor
3 Island
1 Karplusan Forest
1 Kessig Wolf Run
1 Mossfire Valley
1 Mosswort Bridge
6 Mountain
1 Path of Ancestry
1 Rockfall Vale
1 Rootbound Crag
1 Sheltered Thicket
1 Shivan Reef
1 Sulfur Falls
1 Temple of Abandon
1 Temple of Mystery
1 Temple of the Dragon Queen
1 Yavimaya Coast
1 Atarka, World Render
1 Atsushi, the Blazing Sky
1 Broodcaller Scourge
1 Deceptive Frostkite
1 Dragonlord Atarka
1 Dragonlord's Servant
1 Dragonmaster Outcast
1 Gadrak, the Crown-Scourge
1 Glorybringer
1 Hammerhead Tyrant
1 Harbinger of the Hunt
1 Hellkite Courser
1 Keiga, the Tide Star
1 Lathliss, Dragon Queen
1 Leyline Tyrant
1 Nesting Dragon
1 Nogi, Draco-Zealot
1 Opportunistic Dragon
1 Parapet Thrasher
1 Rapacious Dragon
1 Sarkhan, Soul Aflame
1 Scourge of the Throne
1 Skarrgan Hellkite
1 Steel Hellkite
1 Stormbreath Dragon
1 Stormshriek Feral
1 Taurean Mauler
1 Territorial Hellkite
1 Thunderbreak Regent
1 Thundermane Dragon
1 Vengeful Ancestor
1 Verix Bladewing
1 Whirlwing Stormbrood
1 Become the Avalanche
1 Blasphemous Act
1 Farseek
1 Kodama's Reach
1 Migration Path
1 Selvala's Stampede
1 Storm's Wrath
1 Will of the Temur
1 Zenith Festival
1 Breaching Dragonstorm
1 Dragon Tempest
1 Elemental Bond
1 Encroaching Dragonstorm
1 Frontier Siege
1 Reflections of Littjara
1 Temur Ascendancy
1 Beast Within
1 Chaos Warp
1 Draconic Lore
1 Rapid Hybridization
1 Reality Shift
1 Spit Flame
1 Arcane Signet
1 Dragon's Hoard
1 Fellwar Stone
1 Sol Ring
1 Talisman of Creativity
1 Talisman of Impulse`,
  },
  fdn_angels: {
    label: 'Calling All Angels (Giada, Font of Hope)',
    set: 'Foundations Commander',
    bracket: 2,
    text: `Commander
1 Giada, Font of Hope

Deck
1 Always Watching
1 Angel of the Ruins
1 Angelic Destiny
1 Angelic Field Marshal
1 Angelic Sleuth
1 Archangel of Tithes
1 Austere Command
1 Bishop of Wings
1 Cleansing Nova
1 Court of Grace
1 Day of Judgment
1 Emeria Shepherd
1 Exemplar of Light
1 Fateful Absence
1 Firemane Commando
1 Grasp of Fate
1 Herald of Eternal Dawn
1 Herald of War
1 Linvala, the Preserver
1 Lyra Dawnbringer
1 Merchant of Truth
1 Metropolis Reformer
1 Norn's Choirmaster
1 Reya Dawnbringer
1 Righteous Valkyrie
1 Search the Premises
1 Sephara, Sky's Blade
1 Seraph of the Sword
1 Serra Avenger
1 Speaker of the Heavens
1 Sunblast Angel
1 Wojek Investigator
1 Endless Atlas
1 Metallic Mimic
1 Tome of Legends
1 Vanquisher's Banner
1 Bonders' Enclave
1 War Room
1 Angel of Finality
1 Angel of Vitality
1 Cut a Deal
1 Dazzling Angel
1 Defy Death
1 Destroy Evil
1 Exorcise
1 Inspiring Overseer
1 Invoke the Divine
1 Secret Rendezvous
1 Segovian Angel
1 Starnheim Aspirant
1 Swords to Plowshares
1 Thraben Watcher
1 Valorous Stance
1 Vanguard Seraph
1 Youthful Valkyrie
1 Arcane Signet
1 Commander's Sphere
1 Heraldic Banner
1 Marble Diamond
1 Mind Stone
1 Patchwork Banner
1 Sol Ring
1 Swiftfoot Boots
1 Radiant Fountain
1 Secluded Steppe
1 Seraph Sanctuary
1 Temple of the False God
${basics(32, 'Plains')}`,
  },
  fdn_thopters: {
    label: 'Keen Engineering (Sai, Master Thopterist)',
    set: 'Foundations Commander',
    bracket: 2,
    text: `Commander
1 Sai, Master Thopterist

Deck
1 All Is Dust
1 Broodstar
1 Kappa Cannoneer
1 Master of Etherium
1 Master Transmuter
1 Misleading Signpost
1 Pull from Tomorrow
1 Research Thief
1 Shimmer Dragon
1 Thopter Fabricator
1 Thopter Spy Network
1 Thought Monitor
1 Vedalken Archmage
1 Adaptive Omnitool
1 Cultivator's Caravan
1 Darksteel Juggernaut
1 Duplicant
1 Forsaken Monument
1 Graaz, Unstoppable Juggernaut
1 Mazemind Tome
1 Mind's Eye
1 Myr Battlesphere
1 Nettlecyst
1 Nevinyrral's Disk
1 Psychosis Crawler
1 Scrawling Crawler
1 Skysovereign, Consul Flagship
1 Steel Hellkite
1 Steel Overseer
1 War Room
1 Aetherize
1 Counterspell
1 Etherium Sculptor
1 Fall from Favor
1 Launch Mishap
1 Memory Guardian
1 Negate
1 Padeem, Consul of Innovation
1 Propaganda
1 Tamiyo's Logbook
1 Thirst for Knowledge
1 Thoughtcast
1 Whirler Rogue
1 Aether Spellbomb
1 Arcane Signet
1 Chief of the Foundry
1 Foundry Inspector
1 Hedron Archive
1 Ichor Wellspring
1 Meteor Golem
1 Mind Stone
1 Myr Retriever
1 Ornithopter of Paradise
1 Palladium Myr
1 Shimmer Myr
1 Silver Myr
1 Sol Ring
1 Soul-Guide Lantern
1 Spire Golem
1 Thought Vessel
1 Buried Ruin
1 Darksteel Citadel
1 Foundry of the Consuls
1 Lonely Sandbar
1 Remote Isle
${basics(34, 'Island')}`,
  },
  fdn_zombies: {
    label: 'Wretched Ranks (Ghoulcaller Gisa)',
    set: 'Foundations Commander',
    bracket: 2,
    text: `Commander
1 Ghoulcaller Gisa

Deck
1 Army of the Damned
1 Ayara, First of Locthwain
1 Bad Moon
1 Cemetery Reaper
1 Champion of the Perished
1 Cryptbreaker
1 Death Baron
1 Diregraf Colossus
1 Endless Ranks of the Dead
1 God-Eternal Bontu
1 Grave Titan
1 Graveborn Muse
1 Gravecrawler
1 Headless Rider
1 Josu Vess, Lich Knight
1 Kalitas, Traitor of Ghet
1 Liliana's Mastery
1 Liliana's Reaver
1 Lord of the Undead
1 Midnight Reaper
1 Mutilate
1 Necrotic Hex
1 Open the Graves
1 Oversold Cemetery
1 Phyrexian Arena
1 Razorlash Transmogrant
1 Zul Ashur, Lich Lord
1 Castle Locthwain
1 Geier Reach Sanitarium
1 Ambition's Cost
1 Carrion Feeder
1 Cemetery Recruitment
1 Consumed by Greed
1 Consuming Corruption
1 Eternal Taskmaster
1 Fleshbag Marauder
1 Go for the Throat
1 Gray Merchant of Asphodel
1 Lord of the Accursed
1 Marchesa's Decree
1 Mire Triton
1 Moan of the Unhallowed
1 Night's Whisper
1 Noxious Ghoul
1 Sign in Blood
1 Soulless One
1 Syphon Flesh
1 Tendrils of Corruption
1 Undead Augur
1 Undead Butler
1 Undead Warchief
1 Vengeful Dead
1 Wight of Precinct Six
1 Withering Torment
1 Arcane Signet
1 Bontu's Monument
1 Charcoal Diamond
1 Commander's Sphere
1 Infernal Idol
1 Mind Stone
1 Patchwork Banner
1 Sol Ring
1 Barren Moor
1 Bojuka Bog
1 Memorial to Folly
1 Witch's Cottage
${basics(33, 'Swamp')}`,
  },
  fdn_dragons: {
    label: 'Reign of Dragons (Lathliss, Dragon Queen)',
    set: 'Foundations Commander',
    bracket: 2,
    text: `Commander
1 Lathliss, Dragon Queen

Deck
1 Atsushi, the Blazing Sky
1 Blasphemous Act
1 Chain Reaction
1 Chandra's Ignition
1 Chaos Warp
1 Count on Luck
1 Crucible of Fire
1 Cursed Mirror
1 Dragon Tempest
1 Dragonhawk, Fate's Tempest
1 Dragonmaster Outcast
1 Drakuseth, Maw of Flames
1 The Elder Dragon War
1 Goddric, Cloaked Reveler
1 Goldlust Triad
1 Hellkite Charger
1 Hit the Mother Lode
1 Leyline Tyrant
1 Magmaquake
1 Minion of the Mighty
1 Nogi, Draco-Zealot
1 Orb of Dragonkind
1 Outpost Siege
1 Parapet Thrasher
1 Sarkhan, Dragon Ascendant
1 Scourge of the Throne
1 Scourge of Valkas
1 Shivan Devastator
1 Spit Flame
1 Taurean Mauler
1 Terror of Mount Velus
1 Thunderbreak Regent
1 Thundermane Dragon
1 Tyrant's Familiar
1 Utvara Hellkite
1 Warstorm Surge
1 Basilisk Collar
1 Dragon's Hoard
1 Bonders' Enclave
1 Haven of the Spirit Dragon
1 Spinerock Knoll
1 War Room
1 Abrade
1 Anger
1 Bitter Reunion
1 Breaching Dragonstorm
1 Breath Weapon
1 Carnelian Orb of Dragonkind
1 Dragonlord's Servant
1 Dragonspeaker Shaman
1 Firespitter Whelp
1 Lightning Bolt
1 Mana Geyser
1 Rapacious Dragon
1 Skyline Despot
1 Thrill of Possibility
1 Unexpected Windfall
1 Arcane Signet
1 Commander's Sphere
1 Dragonstorm Globe
1 Fire Diamond
1 Hazoret's Monument
1 Herald's Horn
1 Sol Ring
1 Swiftfoot Boots
1 Forgotten Cave
1 Temple of the False God
${basics(32, 'Mountain')}`,
  },
  fdn_dinos: {
    label: 'Tramplesaurus Rex (Ghalta, Primal Hunger)',
    set: 'Foundations Commander',
    bracket: 2,
    text: `Commander
1 Ghalta, Primal Hunger

Deck
1 Arachnogenesis
1 Arasta of the Endless Web
1 Beast Whisperer
1 Birds of Paradise
1 Carnage Tyrant
1 Curious Altisaur
1 Dungrove Elder
1 Elder Gargaroth
1 Ezuri's Predation
1 Gigantosaurus
1 Hulking Raptor
1 Loot, Exuberant Explorer
1 Managorger Hydra
1 Overwhelming Stampede
1 Pugnacious Hammerskull
1 Regal Imperiosaur
1 Rhonas the Indomitable
1 Ripjaw Raptor
1 Rishkar's Expertise
1 Scavenging Ooze
1 Scrapshooter
1 Shamanic Revelation
1 Steel Leaf Champion
1 Surrak and Goreclaw
1 Surrak, the Hunt Caller
1 Tangleweave Armor
1 Thickest in the Thicket
1 Unnatural Growth
1 Verdant Sun's Avatar
1 Whiptongue Hydra
1 Yeva, Nature's Herald
1 Bonders' Enclave
1 Mosswort Bridge
1 Scavenger Grounds
1 War Room
1 Witch's Clinic
1 Beast Within
1 Bite Down
1 Challenger Troll
1 Clifftop Lookout
1 Collective Resistance
1 Colossal Majesty
1 Elemental Bond
1 Elvish Mystic
1 Fyndhorn Elves
1 Garruk's Packleader
1 Garruk's Uprising
1 Goreclaw, Terror of Qal Sisma
1 Harmonize
1 Ilysian Caryatid
1 Kenrith's Transformation
1 Llanowar Elves
1 Llanowar Tribe
1 Monstrous Onslaught
1 Paradise Druid
1 Ram Through
1 Rishkar, Peema Renegade
1 Tamiyo's Safekeeping
1 Terrian, World Tyrant
1 Thrashing Brontodon
1 Whisperer of the Wilds
1 Commander's Sphere
1 Rhonas's Monument
1 Sol Ring
1 Swiftfoot Boots
1 Rogue's Passage
1 Tranquil Thicket
${basics(32, 'Forest')}`,
  },
  tmnt_turtles: {
    label: 'Turtle Power! (Leonardo, the Balance)',
    set: 'Teenage Mutant Ninja Turtles Commander',
    bracket: 2,
    text: `Commander
1 Leonardo, the Balance

Deck
1 Donatello, the Brains
1 Splinter, the Mentor
1 Raphael, the Muscle
1 Michelangelo, the Heart
1 Heroes in a Half Shell
1 Continue?
1 Endless Foot Assault
1 April O'Neil, Live on the Scene
1 Baxter, Fly in the Ointment
1 Here Comes a New Hero!
1 Irma, Part-Time Mutant
1 Krang, the All-Powerful
1 Ray Fillet, Wave Warrior
1 Bebop, Skull & Crossbones
1 Dimension X Pizzasaur
1 Foot Chopper
1 Game Over
1 Rat King, Pale Piper
1 Shredder, Shadow Master
1 Swift Demise
1 Casey Jones, Back Alley Brute
1 Electric Seaweed
1 Fast Forward
1 Shellshock
1 Special Move
1 Tempestra, Dame of Games
1 Tokka & Rahzar, Unsupervised
1 High Score
1 Leatherhead, Iron Gator
1 Level Up
1 Ninja Pizza
1 Rocksteady, Mutant Marauder
1 Super Combo
1 Double Jump // Flying Kick
1 Arcade Cabinet
1 Big Mother Mouser
1 Coin of Mastery
1 Exploding Barrel
1 Mole Module
1 Roadkill Rodney
1 Big Apple, 3 a.m.
1 Hidden Hideout
1 Together Forever
1 Vanquish the Horde
1 Wave Goodbye
1 Blasphemous Act
1 Biogenic Ooze
1 Steelbane Hydra
1 Vigor
1 Voracious Hydra
1 Assassin's Trophy
1 Corpsejack Menace
1 Chromatic Lantern
1 Cinder Glade
1 City of Brass
1 Dragonskull Summit
1 Exotic Orchard
1 Fabled Passage
1 Grand Coliseum
1 Hinterland Harbor
1 Rain-Slicked Copse
1 Rootbound Crag
1 Smoldering Marsh
1 Sodden Verdure
1 Spire Garden
1 Sunken Hollow
1 Undergrowth Stadium
1 Vernal Fen
1 Lita, Little Orphan Amphibian
1 Mona Lisa, Science Geek
1 Lessons from Life
1 Everything Pizza
1 Escape Tunnel
1 Turtle Lair
1 Acidic Slime
1 Cultivate
1 Harmonize
1 Arcane Signet
1 Sol Ring
1 Ash Barrens
1 Command Tower
1 Evolving Wilds
1 Path of Ancestry
1 Thriving Grove
1 Thriving Isle
1 Thriving Moor
1 Vibrant Cityscape
${basics(2, 'Plains')}
${basics(2, 'Island')}
${basics(2, 'Swamp')}
${basics(2, 'Mountain')}
${basics(4, 'Forest')}`,
  },
  eoe_worldshaper: {
    label: 'World Shaper (Hearthhull, the Worldseed)',
    set: 'Edge of Eternities Commander',
    bracket: 2,
    text: `Commander
1 Hearthhull, the Worldseed

Deck
1 Szarel, Genesis Shepherd
1 Eumidian Wastewaker
1 Evendo Brushrazer
1 Planetary Annihilation
1 Baloth Prime
1 Exploration Broodship
1 Horizon Explorer
1 Scouring Swarm
1 Eumidian Hatchery
1 Festering Thicket
1 Vernal Fen
1 Fabled Passage
1 Braids, Arisen Nightmare
1 God-Eternal Bontu
1 Blasphemous Act
1 Hammer of Purphoros
1 Moraug, Fury of Akoum
1 Augur of Autumn
1 Centaur Vinecrasher
1 Formless Genesis
1 Loamcrafter Faun
1 Multani, Yavimaya's Avatar
1 Oracle of Mul Daya
1 Pest Infestation
1 Rampaging Baloths
1 Splendid Reclamation
1 Tireless Tracker
1 Titania, Protector of Argoth
1 World Breaker
1 Escape to the Wilds
1 Gaze of Granite
1 The Gitrog Monster
1 Korvold, Fae-Cursed King
1 Mazirek, Kraul Death Priest
1 Omnath, Locus of Rage
1 Soul of Windgrace
1 Windgrace's Judgment
1 Worldsoul's Rage
1 Canyon Slough
1 Cinder Glade
1 Karplusan Forest
1 Llanowar Wastes
1 Sheltered Thicket
1 Smoldering Marsh
1 Sulfurous Springs
1 Twilight Mire
1 Viridescent Bog
1 Farseek
1 Springbloom Druid
1 Binding the Old Gods
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Mountain Valley
1 Terramorphic Expanse
1 Infernal Grasp
1 Night's Whisper
1 Sprouting Goblin
1 Aftermath Analyst
1 Beast Within
1 Cultivate
1 Groundskeeper
1 Harrow
1 Nature's Lore
1 Roiling Regrowth
1 Satyr Wayfinder
1 Skyshroud Claim
1 Tear Asunder
1 Juri, Master of the Revue
1 Mayhem Devil
1 Putrefy
1 Rakdos Charm
1 Uurg, Spawn of Turg
1 Bojuka Bog
1 Cabaretti Courtyard
1 Dakmor Salvage
1 Escape Tunnel
1 Evolving Wilds
1 Maestros Theater
1 Myriad Landscape
1 Riveteers Overlook
1 Rocky Tar Pit
1 Wastes
${basics(5, 'Swamp')}
${basics(3, 'Mountain')}
${basics(8, 'Forest')}`,
  },
  tdc_mardu: {
    label: 'Mardu Surge (Zurgo Stormrender)',
    set: 'Tarkir: Dragonstorm Commander',
    bracket: 2,
    text: `Commander
1 Zurgo Stormrender

Deck
1 Neriv, Crackling Vanguard
1 Ainok Strike Leader
1 Ironwill Forger
1 Bone Devourer
1 Goldlust Triad
1 Redoubled Stormsinger
1 Adeline, Resplendent Cathar
1 Angel of Invention
1 Emeria Angel
1 Hero of Bladehold
1 Selfless Spirit
1 Sun Titan
1 Twilight Drover
1 Chittering Witch
1 Gix, Yawgmoth Praetor
1 Mindblade Render
1 Ophiomancer
1 Yahenni, Undying Partisan
1 Grenzo, Havoc Raiser
1 Legion Warboss
1 Ogre Battledriver
1 Siege-Gang Commander
1 Myr Battlesphere
1 Solemn Simulacrum
1 Goldnight Commander
1 Morbid Opportunist
1 Viscera Seer
1 Beetleback Chief
1 Loyal Apprentice
1 Aron, Benalia's Ruin
1 Thalisse, Reverent Medium
1 Kaya, Geist Hunter
1 Will of the Mardu
1 Grand Crescendo
1 Stroke of Midnight
1 Swords to Plowshares
1 Bitter Triumph
1 Deadly Dispute
1 Abrade
1 Hour of Reckoning
1 Eliminate the Competition
1 Tempt with Vengeance
1 Shadow Summoning
1 Lingering Souls
1 Release the Dogs
1 Within Range
1 Commander's Insignia
1 Divine Visitation
1 Legion Loyalty
1 Tocasia's Welcome
1 Bastion of Remembrance
1 Infantry Shield
1 Blade of Selves
1 Idol of Oblivion
1 Lightning Greaves
1 Skullclamp
1 Arcane Signet
1 Sol Ring
1 Fellwar Stone
1 Talisman of Conviction
1 Talisman of Hierarchy
1 Wayfarer's Bauble
1 Battlefield Forge
1 Canyon Slough
1 Castle Ardenvale
1 Castle Embereth
1 Caves of Koilos
1 Clifftop Retreat
1 Dragonskull Summit
1 Exotic Orchard
1 Fetid Heath
1 Isolated Chapel
1 Shattered Sanctum
1 Smoldering Marsh
1 Temple of Silence
1 Temple of Triumph
1 Vault of the Archangel
1 Windbrisk Heights
1 Command Tower
1 Nomad Outpost
1 Bojuka Bog
1 Path of Ancestry
1 Shattered Landscape
1 Terramorphic Expanse
${basics(5, 'Plains')}
${basics(5, 'Swamp')}
${basics(5, 'Mountain')}`,
  },
  dft_eternal: {
    label: 'Eternal Might (Temmet, Naktamun\'s Will)',
    set: 'Aetherdrift Commander',
    bracket: 2,
    text: `Commander
1 Temmet, Naktamun's Will

Deck
1 Hashaton, Scarab's Fist
1 On Wings of Gold
1 Priest of the Crossing
1 Renewed Solidarity
1 Wizened Mentor
1 Prophet of the Scarab
1 Rhet-Tomb Mystic
1 Lost Monarch of Ifnir
1 Accursed Duneyard
1 Commence the Endgame
1 Cryptbreaker
1 Grave Titan
1 Gravecrawler
1 Midnight Reaper
1 Murderous Rider
1 Zombie Master
1 Angel of Sanctions
1 Dusk // Dawn
1 God-Eternal Oketra
1 Timeless Dragon
1 Champion of Wits
1 Forgotten Creation
1 Pull from Tomorrow
1 Vizier of Many Faces
1 Archfiend of Ifnir
1 Cemetery Reaper
1 Crowded Crypt
1 Damn
1 Dread Summons
1 Dreadhorde Invasion
1 Liliana, Death's Majesty
1 Never // Return
1 Plague Belcher
1 Rot Hulk
1 The Scarab God
1 God-Pharaoh's Gift
1 Maskwood Nexus
1 Adarkar Wastes
1 Caves of Koilos
1 Drowned Catacomb
1 Exotic Orchard
1 Fetid Pools
1 Glacial Fortress
1 Irrigated Farmland
1 Isolated Chapel
1 Prairie Stream
1 Sunken Hollow
1 Temple of Deceit
1 Temple of Silence
1 Underground River
1 Unholy Grotto
1 Swords to Plowshares
1 Corpse Augur
1 Corpse Knight
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Path of Ancestry
1 Binding Mummy
1 Cast Out
1 Eternal Skylord
1 Fleshbag Marauder
1 Gempalm Polluter
1 Lord of the Accursed
1 Twisted Abomination
1 Undead Augur
1 Despark
1 Gleaming Overseer
1 Lazotep Chancellor
1 Wayward Servant
1 Bontu's Monument
1 Commander's Sphere
1 Dimir Signet
1 Gate to the Afterlife
1 Orzhov Signet
1 Talisman of Dominance
1 Talisman of Hierarchy
1 Arcane Sanctum
1 Ash Barrens
1 Desert of the Glorified
1 Desert of the Mindful
1 Desert of the True
1 Evolving Wilds
1 Orzhov Basilica
1 Terramorphic Expanse
${basics(5, 'Plains')}
${basics(4, 'Island')}
${basics(5, 'Swamp')}`,
  },
  blc_squirrels: {
    label: 'Squirreled Away (Hazel of the Rootbloom)',
    set: 'Bloomburrow Commander',
    bracket: 2,
    text: `Commander
1 Hazel of the Rootbloom

Deck
1 The Odd Acorn Gang
1 Garruk, Cursed Huntsman
1 Chittering Witch
1 Insatiable Frugivore
1 Moonstone Eulogist
1 Swarmyard Massacre
1 Hazel's Brewmaster
1 Woe Strider
1 Saw in Half
1 Ogre Slumlord
1 Decree of Pain
1 Gourmand's Talent
1 Rootcast Apprenticeship
1 Scurry of Squirrels
1 End-Raze Forerunners
1 Arasta of the Endless Web
1 Deep Forest Hermit
1 Toski, Bearer of Secrets
1 Beastmaster Ascension
1 Second Harvest
1 Shamanic Revelation
1 Chatterfang, Squirrel General
1 Temple of Malady
1 Casualties of War
1 Windgrace's Judgment
1 Maskwood Nexus
1 Academy Manufactor
1 Woodland Cemetery
1 Necroblossom Snarl
1 Oran-Rief, the Vastwood
1 Swarmyard
1 Exotic Orchard
1 Llanowar Wastes
1 Grim Backwoods
1 Viridescent Bog
1 Twilight Mire
1 Gilded Goose
1 Chitterspitter
1 Maelstrom Pulse
1 Beledros Witherbloom
1 Idol of Oblivion
1 Sword of the Squeak
1 Morbid Opportunist
1 Nadier's Nightblade
1 Plumb the Forbidden
1 Bastion of Remembrance
1 Plaguecrafter
1 Cache Grab
1 Chatterstorm
1 Poison-Tip Archer
1 Moldervine Reclamation
1 Ravenous Squirrel
1 Skyfisher Spider
1 Binding the Old Gods
1 Golgari Rot Farm
1 Jungle Hollow
1 Haunted Mire
1 Nested Shambler
1 Deadly Dispute
1 Zulaport Cutthroat
1 Squirrel Sovereign
1 Prosperous Innkeeper
1 Haywire Mite
1 Tireless Provisioner
1 Squirrel Nest
1 Honored Dreyleader
1 Tear Asunder
1 Wolfwillow Haven
1 Putrefy
1 Arcane Signet
1 Golgari Signet
1 Talisman of Resilience
1 Sol Ring
1 Skullclamp
1 Terramorphic Expanse
1 Path of Ancestry
1 Evolving Wilds
1 Command Tower
1 Tranquil Thicket
1 Bojuka Bog
1 Tainted Wood
1 Barren Moor
${basics(8, 'Swamp')}
${basics(9, 'Forest')}`,
  },
  m3c_overdrive: {
    label: 'Graveyard Overdrive (Disa the Restless)',
    set: 'Modern Horizons 3 Commander',
    bracket: 2,
    text: `Commander
1 Disa the Restless

Deck
1 Coram, the Undertaker
1 Bloodbraid Challenger
1 Broodmate Tyrant
1 Tempt with Mayhem
1 Gluttonous Hellkite
1 Pyrogoyf
1 Polygoyf
1 Barrowgoyf
1 Sawhorn Nemesis
1 Infested Thrinax
1 Final Act
1 Siege-Gang Lieutenant
1 Tarmogoyf Nest
1 Exterminator Magmarch
1 Liliana, Death's Majesty
1 Maelstrom Pulse
1 Junji, the Midnight Sky
1 Garruk, Apex Predator
1 The Reaver Cleaver
1 Temple of Malady
1 Deadbridge Chant
1 Kolaghan's Command
1 Izoni, Thousand-Eyed
1 Lhurgoyf
1 Selvala, Heart of the Wilds
1 Kessig Wolf Run
1 Archon of Cruelty
1 Maskwood Nexus
1 Grist, the Hunger Tide
1 Ignoble Hierarch
1 Necrogoyf
1 Mortivore
1 Chandra's Ignition
1 Viridescent Bog
1 Find // Finality
1 Mossfire Valley
1 Ziatora, the Incinerator
1 Canyon Slough
1 Cinder Glade
1 Exotic Orchard
1 Shadowblood Ridge
1 Sheltered Thicket
1 Smoldering Marsh
1 Temple of Abandon
1 Temple of Malice
1 Raging Ravine
1 Terminate
1 Demolition Field
1 Command Tower
1 Twisted Landscape
1 Grisly Salvage
1 Yavimaya Elder
1 Bituminous Blast
1 Bloodbraid Elf
1 Eternal Witness
1 Savage Lands
1 Tainted Wood
1 Burnished Hart
1 Deathreap Ritual
1 Arcane Signet
1 Syr Konrad, the Grim
1 Grapple with the Past
1 Dakmor Salvage
1 Accursed Marauder
1 Brawn
1 Faithless Looting
1 Rampant Growth
1 Anger
1 Tranquil Thicket
1 Stitcher's Supplier
1 Graveshifter
1 Talisman of Resilience
1 Altar of the Goyf
1 Syphon Mind
1 Talisman of Indulgence
1 Sakura-Tribe Elder
1 Terramorphic Expanse
1 Tainted Peak
1 Riveteers Overlook
1 Riveteers Charm
1 Forgotten Cave
1 Path of Ancestry
1 Lightning Greaves
1 Myriad Landscape
1 Sol Ring
1 Talisman of Impulse
1 Evolving Wilds
${basics(4, 'Swamp')}
${basics(3, 'Mountain')}
${basics(5, 'Forest')}`,
  },
  otc_desert: {
    label: 'Desert Bloom (Yuma, Proud Protector)',
    set: 'Outlaws of Thunder Junction Commander',
    bracket: 2,
    text: `Commander
1 Yuma, Proud Protector

Deck
1 Kirri, Talented Sprout
1 Scavenger Grounds
1 Sun Titan
1 Omnath, Locus of Rage
1 Descend upon the Sinful
1 Chromatic Lantern
1 Marshal's Anthem
1 Sheltered Thicket
1 Scute Swarm
1 Hour of Promise
1 Oracle of Mul Daya
1 Ramunap Excavator
1 Scattered Groves
1 World Shaper
1 Nesting Dragon
1 Turntimber Sower
1 Sevinne's Reclamation
1 Ancient Greenwarden
1 Titania, Protector of Argoth
1 Return of the Wildspeaker
1 Perennial Behemoth
1 Avenger of Zendikar
1 Hazezon, Shaper of Sand
1 Escape to the Wilds
1 Heaven // Earth
1 Genesis Hydra
1 Sunscorched Divide
1 The Mending of Dominaria
1 Decimate
1 Sand Scout
1 Embrace the Unknown
1 Dune Chanter
1 Cataclysmic Prospecting
1 Vengeful Regrowth
1 Angel of Indemnity
1 Cactus Preserve
1 Rumbleweed
1 Terramorphic Expanse
1 Evolving Wilds
1 Swiftfoot Boots
1 Explore
1 Sol Ring
1 Satyr Wayfinder
1 Perpetual Timepiece
1 Crawling Sensation
1 Painted Bluffs
1 Command Tower
1 Magmatic Insight
1 Krosan Verge
1 Desert of the True
1 Skullwinder
1 Desert of the Indomitable
1 Jungle Shrine
1 Bitter Reunion
1 Desert of the Fervent
1 Valorous Stance
1 Dunes of the Dead
1 Shefet Dunes
1 Hashep Oasis
1 Elvish Rejuvenator
1 Winding Way
1 Springbloom Druid
1 Arcane Signet
1 Unholy Heat
1 Thrilling Discovery
1 Electric Revelation
1 Eccentric Farmer
1 Harrow
1 Ramunap Ruins
1 Path to Exile
1 Requisition Raid
1 Bovine Intervention
1 Map the Frontier
1 Conduit Pylons
1 Mirage Mesa
1 Wreck and Rebuild
1 Angel of the Ruins
1 Bristling Backwoods
1 Creosote Heath
1 Abraded Bluffs
1 Scaretiller
1 Nantuko Cultivator
${basics(6, 'Plains')}
${basics(4, 'Mountain')}
${basics(7, 'Forest')}`,
  },
  otc_wanted: {
    label: 'Most Wanted (Olivia, Opulent Outlaw)',
    set: 'Outlaws of Thunder Junction Commander',
    bracket: 2,
    text: `Commander
1 Olivia, Opulent Outlaw

Deck
1 Vihaan, Goldwaker
1 Council's Judgment
1 Heliod's Intervention
1 Angelic Sell-Sword
1 We Ride at Dawn
1 Massacre Girl
1 Fain, the Broker
1 Witch of the Moors
1 Nighthawk Scavenger
1 Curtains' Call
1 Misfortune Teller
1 Painful Truths
1 Kamber, the Plunderer
1 Ogre Slumlord
1 Hex
1 Mari, the Killing Quill
1 Discreet Retreat
1 Charred Graverobber
1 Back in Town
1 Marshland Bloodcaster
1 Veinwitch Coven
1 Rankle, Master of Pranks
1 Dire Fleet Ravager
1 Mirror Entity
1 Dire Fleet Daredevil
1 Captain Lannery Storm
1 Seize the Spotlight
1 Grenzo, Havoc Raiser
1 Angrath's Marauders
1 Captivating Crew
1 Rain of Riches
1 Laurine, the Diversion
1 Mass Mutiny
1 Dead Before Sunrise
1 Graywater's Fixer
1 Life Insurance
1 Breena, the Demagogue
1 Queen Marchesa
1 Idol of Oblivion
1 Academy Manufactor
1 Bounty Board
1 Fetid Heath
1 Command Beacon
1 Vault of the Archangel
1 Dragonskull Summit
1 Temple of Silence
1 Temple of Malice
1 Exotic Orchard
1 Temple of Triumph
1 Clifftop Retreat
1 Isolated Chapel
1 Bonders' Enclave
1 Caves of Koilos
1 Battlefield Forge
1 Sulfurous Springs
1 Rugged Prairie
1 Desolate Mire
1 Shadowblood Ridge
1 Canyon Slough
1 Smoldering Marsh
1 Blackcleave Cliffs
1 Mistmeadow Skulk
1 Requisition Raid
1 Changeling Outcast
1 Feed the Swarm
1 Deadly Dispute
1 Morbid Opportunist
1 Aetherborn Marauder
1 Tenured Inkcaster
1 Shoot the Sheriff
1 Lightning Greaves
1 Impulsive Pilferer
1 Shiny Impetus
1 Humble Defector
1 Glittering Stockpile
1 Boros Charm
1 Arcane Signet
1 Trailblazer's Boots
1 Bandit's Haul
1 Orzhov Signet
1 Sol Ring
1 Rakdos Signet
1 Command Tower
1 Bojuka Bog
1 Path of Ancestry
1 Rogue's Passage
1 Demolition Field
1 Tainted Peak
1 Sunhome, Fortress of the Legion
1 Nomad Outpost
1 Temple of the False God
${basics(2, 'Plains')}
${basics(4, 'Swamp')}
${basics(2, 'Mountain')}`,
  },
  mkc_disguise: {
    label: 'Deadly Disguise (Kaust, Eyes of the Glade)',
    set: 'Murders at Karlov Manor Commander',
    bracket: 2,
    text: `Commander
1 Kaust, Eyes of the Glade

Deck
1 Duskana, the Rage Mother
1 True Identity
1 Unexplained Absence
1 Veiled Ascension
1 Boltbender
1 Showstopping Surprise
1 Tesak, Judith's Hellhound
1 Experiment Twelve
1 Printlifter Ooze
1 Panoptic Projektor
1 Ransom Note
1 Ugin's Mastery
1 Austere Command
1 Dusk // Dawn
1 Exalted Angel
1 Fell the Mighty
1 Hidden Dragonslayer
1 Master of Pearls
1 Mastery of the Unseen
1 Mirror Entity
1 Welcoming Vampire
1 Akroma, Angel of Fury
1 Ashcloud Phoenix
1 Chaos Warp
1 Imperial Hellkite
1 Jeska's Will
1 Neheb, the Eternal
1 Scourge of the Throne
1 Beast Whisperer
1 Deathmist Raptor
1 Den Protector
1 Hooded Hydra
1 Krosan Cloudscraper
1 Krosan Colossus
1 Obscuring Aether
1 Ohran Frostfang
1 Return of the Wildspeaker
1 Root Elemental
1 Saryth, the Viper's Fang
1 Seedborn Muse
1 Temur War Shaman
1 Thelonite Hermit
1 Toski, Bearer of Secrets
1 Trail of Mystery
1 Whisperwood Elemental
1 Yedora, Grave Gardener
1 Decimate
1 Sidar Kondo of Jamuraa
1 Lifecrafter's Bestiary
1 Scroll of Fate
1 Canopy Vista
1 Cinder Glade
1 Exotic Orchard
1 Fortified Village
1 Furycalm Snarl
1 Game Trail
1 Kessig Wolf Run
1 Mossfire Valley
1 Mosswort Bridge
1 Scattered Groves
1 Sheltered Thicket
1 Shrine of the Forsaken Gods
1 Sungrass Prairie
1 Temple of Abandon
1 Temple of Plenty
1 Temple of Triumph
1 Path to Exile
1 Ainok Survivalist
1 Broodhatch Nantuko
1 Nervous Gardener
1 Nantuko Vigilante
1 Nature's Lore
1 Sakura-Tribe Elder
1 Salt Road Ambushers
1 Three Visits
1 Wild Growth
1 Arcane Signet
1 Sol Ring
1 Boros Garrison
1 Command Tower
1 Branch of Vitu-Ghazi
1 Gruul Turf
1 Jungle Shrine
1 Krosan Verge
1 Sacred Peaks
1 Selesnya Sanctuary
1 Temple of the False God
1 Zoetic Cavern
${basics(4, 'Plains')}
${basics(3, 'Mountain')}
${basics(4, 'Forest')}`,
  },
  who_evil: {
    label: 'Masters of Evil (Davros, Dalek Creator)',
    set: 'Doctor Who Commander',
    bracket: 2,
    text: `Commander
1 Davros, Dalek Creator

Deck
1 Missy
1 Auton Soldier
1 The Flood of Mars
1 Cyber Conversion
1 Hunted by The Family
1 Dalek Drone
1 Vashta Nerada
1 Time Reaper
1 Doomsday Confluence
1 The Toymaker's Trap
1 Vislor Turlough
1 Genesis of the Daleks
1 This Is How It Ends
1 Death in Heaven
1 Delete
1 Ensnared by the Mara
1 Day of the Moon
1 The Master, Multiplied
1 The Master, Mesmerist
1 Rassilon, the War President
1 The Master, Gallifrey's End
1 The Valeyard
1 Weeping Angel
1 The Beast, Deathless Prince
1 The Rani
1 Sycorax Commander
1 The Cyber-Controller
1 Cult of Skaro
1 The Dalek Emperor
1 Ashad, the Lone Cyberman
1 Blink
1 The Master, Formed Anew
1 Cybermen Squadron
1 Cybership
1 Wound Reflection
1 Blasphemous Act
1 Solemn Simulacrum
1 The Sound of Drums
1 River of Tears
1 Foreboding Ruins
1 Shadowblood Ridge
1 Smoldering Marsh
1 Temple of Deceit
1 Choked Estuary
1 Sunken Hollow
1 Darkwater Catacombs
1 Fetid Pools
1 Temple of Malice
1 Canyon Slough
1 Exotic Orchard
1 Temple of Epiphany
1 Frostboil Snarl
1 Stormcarved Coast
1 Fiery Islet
1 Lavaclaw Reaches
1 Shipwreck Marsh
1 Drowned Catacomb
1 Haunted Ridge
1 Dragonskull Summit
1 Creeping Tar Pit
1 Gallifrey Council Chamber
1 Renegade Silent
1 Zygon Infiltrator
1 Don't Blink
1 Exterminate!
1 Dalek Squadron
1 Sontaran General
1 Great Intelligence's Plan
1 Cyberman Patrol
1 Cybermat
1 Clockwork Droid
1 Midnight Crusader Shuttle
1 Laser Screwdriver
1 Arcane Signet
1 Sol Ring
1 Thought Vessel
1 Mind Stone
1 Lightning Greaves
1 Propaganda
1 Feed the Swarm
1 Snuff Out
1 Commander's Sphere
1 Wayfarer's Bauble
1 Talisman of Dominance
1 Talisman of Indulgence
1 Command Tower
1 Terramorphic Expanse
1 Thriving Moor
1 Path of Ancestry
1 Temple of the False God
1 Reliquary Tower
1 Crumbling Necropolis
1 Ominous Cemetery
${basics(2, 'Island')}
${basics(2, 'Swamp')}
${basics(2, 'Mountain')}`,
  },
  woc_virtue: {
    label: 'Virtue and Valor (Ellivere of the Wild Court)',
    set: 'Wilds of Eldraine Commander',
    bracket: 2,
    text: `Commander
1 Ellivere of the Wild Court

Deck
1 Gylwain, Casting Director
1 Liberated Livestock
1 Ox Drover
1 Songbirds' Blessing
1 Unfinished Business
1 Giant Inheritance
1 Knickknack Ouphe
1 Loamcrafter Faun
1 Timber Paladin
1 Ajani's Chosen
1 Angelic Destiny
1 Archon of Sun's Grace
1 Austere Command
1 Celestial Archon
1 Daybreak Coronet
1 Eidolon of Countless Battles
1 Kor Spiritdancer
1 Mantle of the Ancients
1 Realm-Cloaked Giant // Cast Off
1 Retether
1 Shalai, Voice of Plenty
1 Starfield Mystic
1 Sun Titan
1 Timely Ward
1 Tithe Taker
1 Umbra Mystic
1 Winds of Rath
1 Bear Umbra
1 Eidolon of Blossoms
1 Enchantress's Presence
1 Indomitable Might
1 Rishkar's Expertise
1 Sanctum Weaver
1 Setessan Champion
1 Verdant Embrace
1 Canopy Vista
1 Castle Ardenvale
1 Fortified Village
1 Hall of Heliod's Generosity
1 Sungrass Prairie
1 Temple of Plenty
1 Danitha Capashen, Paragon
1 Ethereal Armor
1 Generous Gift
1 Sage's Reverie
1 Spectral Steel
1 Swords to Plowshares
1 Transcendent Envoy
1 Ancestral Mask
1 Aura Gnarlid
1 Careful Cultivation
1 Destiny Spinner
1 Fertile Ground
1 Kenrith's Transformation
1 Paradise Druid
1 Snake Umbra
1 Sylvan Ranger
1 Utopia Sprawl
1 Warbriar Blessing
1 Jukai Naturalist
1 Pollenbright Wings
1 Siona, Captain of the Pyleas
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Krosan Verge
1 Myriad Landscape
1 Vitu-Ghazi, the City-Tree
1 Tanglespan Lookout
1 Syr Armont, the Redeemer
${basics(15, 'Forest')}
${basics(14, 'Plains')}`,
  },
  ltc_food: {
    label: 'Food and Fellowship (Frodo & Sam)',
    set: 'The Lord of the Rings Commander',
    bracket: 2,
    text: `Commander
1 Frodo, Adventurous Hobbit
1 Sam, Loyal Attendant

Deck
1 Field-Tested Frying Pan
1 The Gaffer
1 Gwaihir, Greatest of the Eagles
1 Of Herbs and Stewed Rabbit
1 Gollum, Obsessed Stalker
1 Lobelia, Defender of Bag End
1 Rapacious Guest
1 Assemble the Entmoot
1 Feasting Hobbit
1 Motivated Pony
1 Prize Pig
1 Banquet Guests
1 Bilbo, Birthday Celebrant
1 Farmer Cotton
1 Merry, Warden of Isengard
1 Pippin, Warden of Isengard
1 Treebeard, Gracious Host
1 Hithlain Rope
1 Call for Unity
1 Dawn of Hope
1 Dusk // Dawn
1 Fell the Mighty
1 Fumigate
1 Mentor of the Meek
1 Sanguine Bond
1 Toxic Deluge
1 Birds of Paradise
1 Gilded Goose
1 Woodfall Primus
1 Anguished Unmaking
1 Chromatic Lantern
1 Trading Post
1 Well of Lost Dreams
1 Brushland
1 Canopy Vista
1 Exotic Orchard
1 Fortified Village
1 Isolated Chapel
1 Murmuring Bosk
1 Necroblossom Snarl
1 Scattered Groves
1 Shineshadow Snarl
1 Sunpetal Grove
1 Woodland Cemetery
1 Eagles of the North
1 Landroval, Horizon Witness
1 Rosie Cotton of South Lane
1 Shire Shirriff
1 Mirkwood Bats
1 Generous Ent
1 Path to Exile
1 Swords to Plowshares
1 Revive the Shire
1 Butterbur, Bree Innkeeper
1 Crypt Incursion
1 Go for the Throat
1 Night's Whisper
1 Cultivate
1 Essence Warden
1 Farseek
1 Great Oak Guardian
1 Harmonize
1 Orchard Strider
1 Prosperous Innkeeper
1 Shire Terrace
1 Tireless Provisioner
1 Mortify
1 Savvy Hunter
1 Arcane Signet
1 Commander's Sphere
1 Pristine Talisman
1 Sol Ring
1 Access Tunnel
1 Ash Barrens
1 Command Tower
1 Evolving Wilds
1 Ghost Quarter
1 Graypelt Refuge
1 Path of Ancestry
1 Rogue's Passage
1 Sandsteppe Citadel
1 Scoured Barrens
${basics(4, 'Plains')}
${basics(4, 'Swamp')}
${basics(8, 'Forest')}`,
  },
  moc_threat: {
    label: 'Growing Threat (Brimaz, Blight of Oreskos)',
    set: 'March of the Machine Commander',
    bracket: 2,
    text: `Commander
1 Brimaz, Blight of Oreskos

Deck
1 Moira and Teshar
1 Ichor Elixir
1 Blight Titan
1 Darksteel Splicer
1 Excise the Imperfect
1 Filigree Vector
1 Path of the Schemer
1 Bitterthorn, Nissa's Animus
1 Vulpine Harvester
1 Cataclysmic Gearhulk
1 Massacre Wurm
1 Noxious Gearhulk
1 Phyrexian Scriptures
1 Phyrexian Triniform
1 Soul of New Phyrexia
1 Ancient Stone Idol
1 Angel of the Ruins
1 Blade Splicer
1 Coveted Jewel
1 Duplicant
1 Exotic Orchard
1 Fetid Heath
1 Karn's Bastion
1 Myr Battlesphere
1 Nettlecyst
1 Phyrexian Delver
1 Phyrexian Rebirth
1 Psychosis Crawler
1 Scrap Trawler
1 Sculpting Steel
1 Scytheclaw
1 Shineshadow Snarl
1 Spire of Industry
1 Temple of Silence
1 Utter End
1 Vault of the Archangel
1 Yawgmoth's Vile Offering
1 Bojuka Bog
1 Command Tower
1 Commander's Sphere
1 Evolving Wilds
1 First-Sphere Gargantua
1 Fractured Powerstone
1 Goldmire Bridge
1 Night's Whisper
1 Orzhov Locket
1 Orzhov Signet
1 Path of Ancestry
1 Phyrexian Ghoul
1 Phyrexian Rager
1 Silverquill Campus
1 Terramorphic Expanse
1 Wayfarer's Bauble
1 Hedron Archive
1 Ambition's Cost
1 Arcane Signet
1 Bloodline Pretender
1 Bone Shredder
1 Burnished Hart
1 Despark
1 Go for the Throat
1 Graveshifter
1 Keskit, the Flesh Sculptor
1 Master Splicer
1 Meteor Golem
1 Mind Stone
1 Mortify
1 Shattered Angel
1 Shimmer Myr
1 Sol Ring
1 Swords to Plowshares
1 Tainted Field
1 Talisman of Hierarchy
1 Victimize
1 Compleated Huntmaster
1 Phyrexian Gargantua
${basics(10, 'Plains')}
${basics(13, 'Swamp')}`,
  },
  clb_party: {
    label: 'Party Time (Nalia de\'Arnise)',
    set: 'Battle for Baldur\'s Gate Commander',
    bracket: 2,
    text: `Commander
1 Nalia de'Arnise

Deck
1 Burakos, Party Leader
1 Folk Hero
1 Deep Gnome Terramancer
1 Harper Recruiter
1 Seasoned Dungeoneer
1 Stick Together
1 Black Market Connections
1 Solemn Doomguide
1 Multiclass Baldric
1 Archpriest of Iona
1 Austere Command
1 Bygone Bishop
1 Dusk // Dawn
1 Eight-and-a-Half-Tails
1 Frontline Medic
1 Galepowder Mage
1 Glorious Protector
1 Jazal Goldmane
1 Magus of the Balance
1 Mikaeus, the Lunarch
1 Mirror Entity
1 Order of Whiteclay
1 Selfless Spirit
1 Sevinne's Reclamation
1 Solemn Recruit
1 Squad Commander
1 Unbreakable Formation
1 Bloodsoaked Champion
1 Butcher of Malakir
1 Calculating Lich
1 Dire Fleet Ravager
1 Gonti, Lord of Luxury
1 Grim Haruspex
1 Grim Hireling
1 Mardu Strike Leader
1 Mindblade Render
1 Nighthawk Scavenger
1 Pontiff of Blight
1 Puppeteer Clique
1 Felisa, Fang of Silverquill
1 Firja's Retribution
1 High Priest of Penance
1 Maskwood Nexus
1 Castle Locthwain
1 Mutavault
1 Shambling Vent
1 Temple of Silence
1 Vault of the Archangel
1 War Room
1 Windbrisk Heights
1 Arcane Signet
1 Command Tower
1 Aven Mindcensor
1 Crib Swap
1 Irregular Cohort
1 Mage's Attendant
1 Mother of Runes
1 Priest of Ancient Lore
1 Rumor Gatherer
1 Valiant Changeling
1 Changeling Outcast
1 Corpse Augur
1 Malakir Blood-Priest
1 Thwart the Grave
1 Zulaport Cutthroat
1 Despark
1 Orzhov Signet
1 Skullclamp
1 Sol Ring
1 Talisman of Hierarchy
1 Ash Barrens
1 Bojuka Bog
1 Mortuary Mire
1 Myriad Landscape
1 Orzhov Basilica
1 Path of Ancestry
1 Snowfield Sinkhole
1 Starlit Sanctum
1 Tainted Field
${basics(10, 'Plains')}
${basics(10, 'Swamp')}`,
  },
  nec_buckle: {
    label: 'Buckle Up (Kotori, Pilot Prodigy)',
    set: 'Kamigawa: Neon Dynasty Commander',
    bracket: 2,
    text: `Commander
1 Kotori, Pilot Prodigy

Deck
1 Shorikai, Genesis Engine
1 Jace, Architect of Thought
1 Aerial Surveyor
1 Drumbellower
1 Ironsoul Enforcer
1 Cyberdrive Awakener
1 Imposter Mech
1 Kappa Cannoneer
1 Katsumasa, the Animator
1 Research Thief
1 Imperial Recovery Unit
1 Mobilizer Mech
1 Prodigy's Prototype
1 Surgehacker Mech
1 Aeronaut Admiral
1 Cataclysmic Gearhulk
1 Indomitable Archangel
1 Myrsmith
1 Parhelion II
1 Sram, Senior Edificer
1 Teshar, Ancestor's Apostle
1 Emry, Lurker of the Loch
1 Etherium Sculptor
1 Master of Etherium
1 Organic Extinction
1 Release to Memory
1 Swift Reconfiguration
1 Access Denied
1 Universal Surveillance
1 Armed and Armored
1 Crush Contraband
1 Dispatch
1 Generous Gift
1 Swords to Plowshares
1 Reality Shift
1 Thoughtcast
1 Dance of the Manse
1 Riddlesmith
1 Sai, Master Thopterist
1 Thopter Spy Network
1 Vedalken Engineer
1 Whirler Rogue
1 Arcanist's Owl
1 Hanna, Ship's Navigator
1 Raff Capashen, Ship's Mage
1 Arcane Signet
1 Azorius Signet
1 Colossal Plow
1 Cultivator's Caravan
1 Fellwar Stone
1 Foundry Inspector
1 Gold Myr
1 Mirage Mirror
1 Peacewalker Colossus
1 Raiders' Karve
1 Shimmer Myr
1 Silver Myr
1 Skysovereign, Consul Flagship
1 Smuggler's Copter
1 Sol Ring
1 Solemn Simulacrum
1 Weatherlight
1 Command Tower
1 Exotic Orchard
1 Port Town
1 Prairie Stream
1 Skycloud Expanse
1 Spire of Industry
1 Temple of Enlightenment
${basics(15, 'Plains')}
${basics(15, 'Island')}`,
  },
  afc_courage: {
    label: "Aura of Courage (Galea, Kindler of Hope)",
    set: "Forgotten Realms Commander",
    bracket: 2,
    text: `Commander
1 Galea, Kindler of Hope

Deck
1 Angel of Finality
1 Puresteel Paladin
1 Realm-Cloaked Giant
1 Sram, Senior Edificer
1 Prognostic Sphinx
1 Cold-Eyed Selkie
1 Fleecemane Lion
1 Knight of Autumn
1 Riverwise Augur
1 Acidic Slime
1 Paradise Druid
1 Winds of Rath
1 Serum Visions
1 Nature's Lore
1 Heroic Intervention
1 Valorous Stance
1 Brainstorm
1 Bant Charm
1 Argentum Armor
1 Basilisk Collar
1 Masterwork of Ingenuity
1 Moonsilver Spear
1 Sword of the Animist
1 Behemoth Sledge
1 Arcane Signet
1 Colossus Hammer
1 Explorer's Scope
1 Sol Ring
1 Swiftfoot Boots
1 Viridian Longbow
1 Imprisoned in the Moon
1 Greater Good
1 Verdant Embrace
1 Angelic Gift
1 Gryff's Boon
1 Curse of Verbosity
1 Eel Umbra
1 Psychic Impetus
1 Abundant Growth
1 Fertile Ground
1 Kenrith's Transformation
1 Rancor
1 Utopia Sprawl
1 Wild Growth
1 Shielding Plax
1 Canopy Vista
1 Exotic Orchard
1 Fortified Village
1 Lumbering Falls
1 Port Town
1 Prairie Stream
1 Skycloud Expanse
1 Sungrass Prairie
1 Evolving Wilds
1 Azorius Chancery
1 Bant Panorama
1 Command Tower
1 Flood Plain
1 Grasslands
1 Halimar Depths
1 Mishra's Factory
1 Path of Ancestry
1 Seaside Citadel
1 Simic Growth Chamber
1 Terramorphic Expanse
1 Thriving Grove
1 Thriving Heath
1 Thriving Isle
1 Vitu-Ghazi, the City-Tree
4 Island
8 Forest
2 Plains
1 Storvald, Frost Giant Jarl
1 Fey Steed
1 Holy Avenger
1 Mantle of the Ancients
1 Robe of Stars
1 Valiant Endeavor
1 Diviner's Portent
1 Netherese Puzzle-Ward
1 Winged Boots
1 Belt of Giant Strength
1 Song of Inspiration
1 Catti-brie of Mithral Hall
1 Ride the Avalanche
1 Clay Golem
1 Ebony Fly
1 Sword of Hours`,
  },
  afc_rage: {
    label: "Draconic Rage (Vrondiss, Rage of Ancients)",
    set: "Forgotten Realms Commander",
    bracket: 2,
    text: `Commander
1 Vrondiss, Rage of Ancients

Deck
1 Bogardan Hellkite
1 Demanding Dragon
1 Dragonmaster Outcast
1 Hoard-Smelter Dragon
1 Opportunistic Dragon
1 Scourge of Valkas
1 Shivan Hellkite
1 Skyline Despot
1 Skyship Stalker
1 Taurean Mauler
1 Terror of Mount Velus
1 Thunderbreak Regent
1 Chameleon Colossus
1 Atarka, World Render
1 Anger
1 Dragonlord's Servant
1 Savage Ventmaw
1 Dragonspeaker Shaman
1 Chain Reaction
1 Rishkar's Expertise
1 Shamanic Revelation
1 Rile
1 Cultivate
1 Explore
1 Rampant Growth
1 Magmaquake
1 Spit Flame
1 Decree of Savagery
1 Kindred Summons
1 Return of the Wildspeaker
1 Beast Within
1 Return to Nature
1 Dragon's Hoard
1 Arcane Signet
1 Commander's Sphere
1 Gruul Signet
1 Heirloom Blade
1 Sol Ring
1 Gratuitous Violence
1 Outpost Siege
1 Warstorm Surge
1 Colossal Majesty
1 Garruk's Uprising
1 Cinder Glade
1 Crucible of the Spirit Dragon
1 Exotic Orchard
1 Game Trail
1 Haven of the Spirit Dragon
1 Mossfire Valley
1 Mosswort Bridge
1 Command Tower
1 Desert
1 Gruul Turf
1 Path of Ancestry
12 Mountain
15 Forest
1 Klauth, Unrivaled Ancient
1 Berserker's Frenzy
1 Chaos Dragon
1 Maddening Hex
1 Vengeful Ancestor
1 Bag of Tricks
1 Druid of Purification
1 Indomitable Might
1 Neverwinter Hydra
1 Wild Endeavor
1 Dragonborn Champion
1 Klauth's Will
1 Wulfgar of Icewind Dale
1 Barbarian Class
1 Earth-Cult Elemental
1 Component Pouch
1 Sword of Hours
1 Underdark Rift`,
  },
  afc_dungeons: {
    label: "Dungeons of Death (Sefris of the Hidden Ways)",
    set: "Forgotten Realms Commander",
    bracket: 2,
    text: `Commander
1 Sefris of the Hidden Ways

Deck
1 Cataclysmic Gearhulk
1 Eternal Dragon
1 Karmic Guide
1 Sun Titan
1 Sunblast Angel
1 Champion of Wits
1 Curator of Mysteries
1 Phantasmal Image
1 Doomed Necromancer
1 Ashen Rider
1 Baleful Strix
1 Hostage Taker
1 Solemn Simulacrum
1 Ronom Unicorn
1 Wall of Omens
1 Merfolk Looter
1 Mulldrifter
1 Murder of Crows
1 Plaguecrafter
1 Reassembling Skeleton
1 Shriekmaw
1 Cloudblazer
1 Necrotic Sliver
1 Obsessive Stitcher
1 Burnished Hart
1 Meteor Golem
1 Necromantic Selection
1 Unburial Rites
1 Victimize
1 Utter End
1 Swords to Plowshares
1 Forbidden Alchemy
1 Despark
1 Vanish into Memory
1 Arcane Signet
1 Commander's Sphere
1 Fellwar Stone
1 Sol Ring
1 Wayfarer's Bauble
1 Lightning Greaves
1 Propaganda
1 Choked Estuary
1 Darkwater Catacombs
1 Exotic Orchard
1 Geier Reach Sanitarium
1 High Market
1 Nimbus Maze
1 Port Town
1 Prairie Stream
1 Sunken Hollow
1 Evolving Wilds
1 Arcane Sanctum
1 Azorius Chancery
1 Command Tower
1 Dimir Aqueduct
1 Esper Panorama
1 Orzhov Basilica
1 Terramorphic Expanse
1 Thriving Heath
1 Thriving Isle
1 Thriving Moor
7 Plains
5 Island
7 Swamp
1 Nihiloor
1 Immovable Rod
1 Radiant Solar
1 Revivify
1 Thorough Investigation
1 Arcane Endeavor
1 Minn, Wily Illusionist
1 Phantom Steed
1 Rod of Absorption
1 Grave Endeavor
1 Wand of Orcus
1 Extract Brain
1 Midnight Pathlighter
1 Minimus Containment
1 Hama Pashar, Ruin Seeker
1 Dungeon Map
1 Bucknard's Everfull Purse
1 Clay Golem
1 Component Pouch`,
  },
  afc_portal: {
    label: "Planar Portal (Prosper, Tome-Bound)",
    set: "Forgotten Realms Commander",
    bracket: 2,
    text: `Commander
1 Prosper, Tome-Bound

Deck
1 Chittering Witch
1 Fiend of the Shadows
1 Gonti, Lord of Luxury
1 Marionette Master
1 Ogre Slumlord
1 Piper of the Swarm
1 Pontiff of Blight
1 Dark-Dweller Oracle
1 Dire Fleet Daredevil
1 Dream Pillager
1 Etali, Primal Storm
1 Izzet Chemister
1 Tectonic Giant
1 Loyal Apprentice
1 Consuming Vapors
1 Hex
1 Apex of Power
1 Disrupt Decorum
1 Ignite the Future
1 Phthisis
1 Light Up the Stage
1 Throes of Chaos
1 Vandalblast
1 Chaos Warp
1 Commune with Lava
1 Bedevil
1 Bituminous Blast
1 Rakdos Charm
1 Terminate
1 Chaos Wand
1 Arcane Signet
1 Commander's Sphere
1 Fellwar Stone
1 Mind Stone
1 Orazca Relic
1 Rakdos Signet
1 Sol Ring
1 Talisman of Indulgence
1 Unstable Obelisk
1 Dead Man's Chest
1 Theater of Horrors
1 Shiny Impetus
1 Exotic Orchard
1 Foreboding Ruins
1 Shadowblood Ridge
1 Smoldering Marsh
1 Spinerock Knoll
1 Bojuka Bog
1 Command Tower
1 Mortuary Mire
1 Rakdos Carnarium
1 Tainted Peak
1 Zhalfirin Void
14 Swamp
13 Mountain
1 Karazikar, the Eye Tyrant
1 Bag of Devouring
1 Danse Macabre
1 Death Tyrant
1 Grim Hireling
1 Hellish Rebuke
1 Lorcan, Warlock Collector
1 Fiendlash
1 Reckless Endeavor
1 Share the Spoils
1 Wild-Magic Sorcerer
1 Fevered Suspicion
1 Hurl Through Hell
1 Warlock Class
1 Chaos Channeler
1 You Find Some Prisoners
1 Bucknard's Everfull Purse
1 Ebony Fly
1 Underdark Rift`,
  },
  clb_dissent: {
    label: "Draconic Dissent (Firkraag, Cunning Instigator)",
    set: "Battle for Baldur's Gate Commander",
    bracket: 2,
    text: `Commander
1 Firkraag, Cunning Instigator

Deck
1 Will Kenrith
1 Rowan Kenrith
1 Keiga, the Tide Star
1 Pursued Whale
1 Sly Instigator
1 Agitator Ant
1 Avatar of Slaughter
1 Brash Taunter
1 Chaos Dragon
1 Drakuseth, Maw of Flames
1 Geode Rager
1 Goblin Spymaster
1 Kazuul, Tyrant of the Cliffs
1 Ryusei, the Falling Star
1 Territorial Hellkite
1 Thunder Dragon
1 Vengeful Ancestor
1 Warmonger Hellkite
1 Niv-Mizzet, Parun
1 Solemn Simulacrum
1 Steel Hellkite
1 Stuffy Doll
1 Burnished Hart
1 Sprite Dragon
1 Aether Gale
1 Curse of the Swine
1 Blasphemous Act
1 Chain Reaction
1 Disrupt Decorum
1 Compulsive Research
1 Domineering Will
1 Reins of Power
1 Chaos Warp
1 Midnight Clock
1 Dragon's Hoard
1 Arcane Signet
1 Mind Stone
1 Wayfarer's Bauble
1 Bloodthirsty Blade
1 Fellwar Stone
1 Hedron Archive
1 Izzet Signet
1 Sol Ring
1 Talisman of Creativity
1 Dissipation Field
1 The Akroan War
1 Psychic Impetus
1 Shiny Impetus
1 Curse of Verbosity
1 Propaganda
1 Curse of Opulence
1 Castle Vantress
1 Desolate Lighthouse
1 Kher Keep
1 Temple of Epiphany
1 Wandering Fumarole
1 Command Tower
1 Ash Barrens
1 Izzet Boilerworks
1 Myriad Landscape
1 Path of Ancestry
1 Prismari Campus
1 Reliquary Tower
1 Temple of the False God
1 Terrain Generator
12 Island
12 Mountain
1 Baeloth Barrityl, Entertainer
1 Clan Crafter
1 Artificer Class
1 Astral Dragon
1 Mocking Doppelganger
1 Bothersome Quasit
1 Death Kiss
1 Loot Dispute
1 Spectacular Showdown
1 Angler Turtle`,
  },
  clb_exile: {
    label: "Exit from Exile (Faldorn, Dread Wolf Herald)",
    set: "Battle for Baldur's Gate Commander",
    bracket: 2,
    text: `Commander
1 Faldorn, Dread Wolf Herald

Deck
1 Vivien, Champion of the Wilds
1 Xenagos, the Reveler
1 Aurora Phoenix
1 Bonecrusher Giant
1 Dire Fleet Daredevil
1 Dream Pillager
1 Etali, Primal Storm
1 Greater Gargadon
1 Izzet Chemister
1 Laelia, the Blade Reforged
1 Tectonic Giant
1 Urabrask the Hidden
1 Wild-Magic Sorcerer
1 Arasta of the Endless Web
1 Battle Mammoth
1 End-Raze Forerunners
1 Hornet Queen
1 Lovestruck Beast
1 Managorger Hydra
1 Sweet-Gum Recluse
1 Embereth Shieldbreaker
1 Sakura-Tribe Elder
1 Bloodbraid Elf
1 Grumgully, the Generous
1 Ignite the Future
1 Jeska's Will
1 Mizzium Mortars
1 Ezuri's Predation
1 Escape to the Wilds
1 Nature's Lore
1 Light Up the Stage
1 Beanstalk Giant
1 Cultivate
1 Explore
1 Kodama's Reach
1 Search for Tomorrow
1 Terramorph
1 Three Visits
1 Return of the Wildspeaker
1 Demon Bolt
1 Beast Within
1 Natural Reclamation
1 Chaos Wand
1 Arcane Signet
1 Sol Ring
1 Outpost Siege
1 Stolen Strategy
1 Warstorm Surge
1 Primeval Bounty
1 Sandwurm Convergence
1 Castle Embereth
1 Cinder Glade
1 Game Trail
1 Kessig Wolf Run
1 Mossfire Valley
1 Mosswort Bridge
1 Raging Ravine
1 Spinerock Knoll
1 Temple of Abandon
1 Command Tower
1 Ash Barrens
1 Blighted Woodland
1 Gruul Turf
1 Highland Forest
1 Myriad Landscape
1 Temple of the False God
11 Mountain
12 Forest
1 Durnan of the Yawning Portal
1 Passionate Archaeologist
1 Delayed Blast Fireball
1 Nalfeshnee
1 Green Slime
1 Journey to the Lost City
1 Tlincalli Hunter
1 Venture Forth
1 Sarevok's Tome
1 Volcanic Torrent`,
  },
  clb_flayers: {
    label: "Mind Flayarrgh! (Captain N'ghathrod)",
    set: "Battle for Baldur's Gate Commander",
    bracket: 2,
    text: `Commander
1 Captain N'ghathrod

Deck
1 Chasm Skulker
1 Forgotten Creation
1 Grazilaxx, Illithid Scholar
1 Hullbreaker Horror
1 Mind Flayer
1 Overcharged Amalgam
1 Sludge Monster
1 Wharf Infiltrator
1 Dark Hatchling
1 Dross Harvester
1 Guiltfeeder
1 Hunted Horror
1 Nighthowler
1 Nihilith
1 Sewer Nemesis
1 Woe Strider
1 Consuming Aberration
1 Nemesis of Reason
1 Phyrexian Revoker
1 Psychosis Crawler
1 Spellskite
1 Dauthi Horror
1 Dusk Mangler
1 Phyrexian Rager
1 Plague Spitter
1 Ravenous Chupacabra
1 Fractured Sanity
1 Crippling Fear
1 Hex
1 In Garruk's Wake
1 Feed the Swarm
1 Syphon Mind
1 Extract from Darkness
1 Pull from Tomorrow
1 Curtains' Call
1 Memory Plunder
1 Fact or Fiction
1 Drown in the Loch
1 Arcane Signet
1 Mind Stone
1 Dimir Keyrune
1 Dimir Signet
1 Everflowing Chalice
1 Herald's Horn
1 Lightning Greaves
1 Mindcrank
1 Sol Ring
1 Talisman of Dominance
1 Thought Vessel
1 Leyline of Anticipation
1 Reflections of Littjara
1 Black Market
1 Choked Estuary
1 Creeping Tar Pit
1 Darkwater Catacombs
1 Drownyard Temple
1 Exotic Orchard
1 Nephalia Drownyard
1 River of Tears
1 Sunken Hollow
1 Temple of Deceit
1 Command Tower
1 Ash Barrens
1 Dimir Aqueduct
1 Myriad Landscape
1 Path of Ancestry
1 Port of Karfell
1 Rogue's Passage
1 Tainted Isle
1 Temple of the False God
9 Island
11 Swamp
1 Zellix, Sanity Flayer
1 Haunted One
1 Aboleth Spawn
1 Endless Evil
1 Grell Philosopher
1 Psionic Ritual
1 Brainstealer Dragon
1 From the Catacombs
1 Uchuulon`,
  },
  blc_army: {
    label: "Animated Army (Bello, Bard of the Brambles)",
    set: "Bloomburrow Commander",
    bracket: 2,
    text: `Commander
1 Bello, Bard of the Brambles

Deck
1 Wildsear, Scouring Maw
1 Domri, Anarch of Bolas
1 Etali, Primal Storm
1 Prosperous Bandit
1 Pyreswipe Hawk
1 Alchemist's Talent
1 Berserkers' Onslaught
1 Outpost Siege
1 Rain of Riches
1 Chaos Warp
1 Sunbird's Invocation
1 Gratuitous Violence
1 Warstorm Surge
1 Starstorm
1 Lotus Cobra
1 Evercoat Ursine
1 Brightcap Badger
1 Trailtracker Scout
1 Thickest in the Thicket
1 Ghalta, Primal Hunger
1 Esika's Chariot
1 Unnatural Growth
1 Greater Good
1 Kodama of the East Tree
1 Grothama, All-Devouring
1 Rampaging Baloths
1 Bootleggers' Stash
1 Primeval Bounty
1 Gilded Lotus
1 Spine of Ish Sah
1 Temple of Abandon
1 Karplusan Forest
1 Exotic Orchard
1 Sheltered Thicket
1 Game Trail
1 Raging Ravine
1 Copperline Gorge
1 Mossfire Valley
1 Cinder Glade
1 Rootbound Crag
1 Mosswort Bridge
1 Blasphemous Act
1 Llanowar Loamspeaker
1 Tendershoot Dryad
1 Goreclaw, Terror of Qal Sisma
1 Path of Discovery
1 Decimate
1 Rolling Hamsphere
1 Teapot Slinger
1 Explore
1 Farseek
1 Cultivate
1 Grumgully, the Generous
1 Wandertale Mentor
1 Thought Vessel
1 Arcane Signet
1 Wooded Ridgeline
1 Big Score
1 Abrade
1 Rampant Growth
1 Sakura-Tribe Elder
1 Beast Within
1 Garruk's Packleader
1 Harmonize
1 Garruk's Uprising
1 Gruul Signet
1 Burnished Hart
1 Hedron Archive
1 Fellwar Stone
1 Thran Dynamo
1 Sol Ring
1 Mind Stone
1 Talisman of Impulse
1 Terramorphic Expanse
1 Path of Ancestry
1 Gruul Turf
1 Evolving Wilds
1 Forgotten Cave
1 Tranquil Thicket
1 Command Tower
1 Reliquary Tower
8 Mountain
10 Forest`,
  },
  blc_family: {
    label: "Family Matters (Zinnia, Valley's Voice)",
    set: "Bloomburrow Commander",
    bracket: 2,
    text: `Commander
1 Zinnia, Valley's Voice

Deck
1 Arthur, Marigold Knight
1 Elspeth, Sun's Champion
1 Jazal Goldmane
1 Martial Coup
1 Storm of Souls
1 Selfless Spirit
1 Murmuration
1 Blade Splicer
1 Hanged Executioner
1 Loyal Warhound
1 Restoration Angel
1 Jacked Rabbit
1 Skyclave Apparition
1 Dusk // Dawn
1 Boss's Chauffeur
1 Angel of the Ruins
1 Luminous Broodmoth
1 Sun Titan
1 Pollywog Prodigy
1 Fortune Teller's Talent
1 Aether Channeler
1 Pull from Tomorrow
1 Shield Broker
1 Stolen by the Fae
1 Rapid Augmenter
1 Bident of Thassa
1 Curiosity Crafter
1 Devilish Valet
1 Siege-Gang Commander
1 Echoing Assault
1 Agate Instigator
1 Calamity of Cinders
1 Rose Room Treasurer
1 Combat Celebrant
1 Inferno Titan
1 Time Wipe
1 Solemn Simulacrum
1 Helm of the Host
1 Glacial Fortress
1 Adarkar Wastes
1 Temple of Enlightenment
1 Castle Ardenvale
1 Seachrome Coast
1 Sulfur Falls
1 Cascade Bluffs
1 Exotic Orchard
1 Clifftop Retreat
1 Shivan Reef
1 Temple of Triumph
1 Battlefield Forge
1 Skycloud Expanse
1 Temple of Epiphany
1 Ferrous Lake
1 Rugged Prairie
1 Sunscorched Divide
1 Spirited Companion
1 Inspiring Overseer
1 Cut a Deal
1 Path to Exile
1 Illusory Ambusher
1 Rowdy Research
1 Plumecreed Escort
1 Rapid Hybridization
1 Junk Winder
1 Aetherize
1 Chart a Course
1 Tetsuko Umezawa, Fugitive
1 Thopter Engineer
1 Cloudblazer
1 Arcane Signet
1 Boros Signet
1 Ornithopter of Paradise
1 Azorius Signet
1 Izzet Signet
1 Circuit Mender
1 Fellwar Stone
1 Sol Ring
1 Mind Stone
1 Terramorphic Expanse
1 Path of Ancestry
1 Thriving Heath
1 Evolving Wilds
1 Thriving Isle
1 Thriving Bluff
1 Command Tower
1 Mystic Monastery
5 Plains
4 Island
4 Mountain`,
  },
  blc_peace: {
    label: "Peace Offering (Ms. Bumbleflower)",
    set: "Bloomburrow Commander",
    bracket: 2,
    text: `Commander
1 Ms. Bumbleflower

Deck
1 Mr. Foxglove
1 Tamiyo, Field Researcher
1 Tenuous Truce
1 Loran of the Third Path
1 Steelburr Champion
1 Tempt with Bunnies
1 Perch Protection
1 Sunscorch Regent
1 Promise of Loyalty
1 Hoofprints of the Stag
1 Mangara, the Diplomat
1 Realm-Cloaked Giant
1 Sphinx of Enlightenment
1 Forgotten Ancient
1 Bloodroot Apothecary
1 Communal Brewing
1 Managorger Hydra
1 Rishkar, Peema Renegade
1 Rites of Flourishing
1 Tempt with Discovery
1 Kalonian Hydra
1 Faeburrow Elder
1 Exotic Orchard
1 Simic Ascendancy
1 Ghirapur Orrery
1 Psychosis Crawler
1 Adarkar Wastes
1 Temple of Enlightenment
1 Seachrome Coast
1 Glacial Fortress
1 Hinterland Harbor
1 Razorverge Thicket
1 Flooded Grove
1 Skycloud Expanse
1 Canopy Vista
1 Prairie Stream
1 Brushland
1 Temple of Mystery
1 Yavimaya Coast
1 Overflowing Basin
1 Sungrass Prairie
1 Sunpetal Grove
1 Triskaidekaphile
1 Octomancer
1 Twenty-Toed Toad
1 Intellectual Offering
1 Illusionist's Gambit
1 Body of Knowledge
1 Chasm Skulker
1 Perplexing Test
1 Jolrael, Mwonvuli Recluse
1 Fisher's Talent
1 Selvala, Explorer Returned
1 Kwain, Itinerant Meddler
1 Coveted Jewel
1 Temple of Plenty
1 Generous Gift
1 Swords to Plowshares
1 Secret Rendezvous
1 Baird, Steward of Argive
1 An Offer You Can't Refuse
1 Wizard Class
1 Cultivate
1 Farseek
1 Broken Wings
1 Spore Frog
1 Wear Down
1 Peerless Recycling
1 Coiling Oracle
1 Riot Control
1 Martial Impetus
1 Jolly Gerbils
1 Long River's Pull
1 Thought Vessel
1 Arcane Signet
1 Swiftfoot Boots
1 Fellwar Stone
1 Sol Ring
1 Mind Stone
1 Thriving Heath
1 Thriving Isle
1 Thriving Grove
1 Terramorphic Expanse
1 Command Tower
1 Evolving Wilds
1 Reliquary Tower
1 Seaside Citadel
4 Plains
4 Island
4 Forest`,
  },
  otc_larceny: {
    label: "Grand Larceny (Gonti, Canny Acquisitor)",
    set: "Outlaws of Thunder Junction Commander",
    bracket: 2,
    text: `Commander
1 Gonti, Canny Acquisitor

Deck
1 Felix Five-Boots
1 Thieving Skydiver
1 Sage of the Beyond
1 Ghostly Pilferer
1 Diluvian Primordial
1 Stolen Goods
1 Curse of the Swine
1 Dazzling Sphinx
1 Arcane Heist
1 Smirking Spelljacker
1 Mind's Dilation
1 Gonti, Lord of Luxury
1 Predators' Hour
1 Brainstealer Dragon
1 Cunning Rhetoric
1 Thieving Amalgam
1 Orochi Soul-Reaver
1 Thieving Varmint
1 Heartless Conscription
1 Nashi, Moon Sage's Scion
1 Baleful Mastery
1 Ohran Frostfang
1 Savvy Trader
1 Tower Winder
1 Cazur, Ruthless Stalker
1 Silent-Blade Oni
1 Hostage Taker
1 Edric, Spymaster of Trest
1 Fallen Shinobi
1 Cold-Eyed Selkie
1 Siphon Insight
1 Extract Brain
1 Shadowmage Infiltrator
1 Baleful Strix
1 Culling Ritual
1 Thief of Sanity
1 Villainous Wealth
1 The Mimeoplasm
1 Plasm Capture
1 Ukkima, Stalking Shadow
1 Bladegriff Prototype
1 Chaos Wand
1 Dream-Thief's Bandana
1 Oblivion Sower
1 Overflowing Basin
1 Drowned Catacomb
1 Temple of Deceit
1 Temple of Malady
1 Darkwater Catacombs
1 Fetid Pools
1 Yavimaya Coast
1 Viridescent Bog
1 Exotic Orchard
1 Underground River
1 Woodland Cemetery
1 Sunken Hollow
1 Temple of Mystery
1 Hinterland Harbor
1 Darkslick Shores
1 Flooded Grove
1 Twilight Mire
1 Llanowar Wastes
1 Slither Blade
1 Whirler Rogue
1 Triton Shorestalker
1 Feed the Swarm
1 Silhana Ledgewalker
1 Rampant Growth
1 Kodama's Reach
1 Void Attendant
1 Three Visits
1 Putrefy
1 Trygon Predator
1 Doc Aurlock, Grizzled Genius
1 Arcane Signet
1 Darksteel Ingot
1 Fellwar Stone
1 Prismatic Lens
1 Sol Ring
1 Command Tower
1 Reliquary Tower
1 Access Tunnel
1 Dimir Aqueduct
1 Opulent Palace
3 Island
2 Island
3 Swamp
3 Swamp
2 Forest
2 Forest`,
  },
  otc_quickdraw: {
    label: "Quick Draw (Stella Lee, Wild Card)",
    set: "Outlaws of Thunder Junction Commander",
    bracket: 2,
    text: `Commander
1 Stella Lee, Wild Card

Deck
1 Eris, Roar of the Storm
1 Archmage Emeritus
1 Baral's Expertise
1 Tezzeret's Gambit
1 Midnight Clock
1 Haughty Djinn
1 Dig Through Time
1 Winged Boots
1 Talrand, Sky Summoner
1 Octavia, Living Thesis
1 Thunderclap Drake
1 Lock and Load
1 Forger's Foundry
1 Finale of Revelation
1 Curse of the Swine
1 Mizzix's Mastery
1 Chaos Warp
1 Crackling Spellslinger
1 Pyretic Charge
1 Smoldering Stagecoach
1 Elemental Eruption
1 Rousing Refrain
1 Cursed Mirror
1 Bloodthirsty Adversary
1 Finale of Promise
1 Arcane Bombardment
1 Niv-Mizzet, Parun
1 Kaza, Roil Chaser
1 Shark Typhoon
1 Galvanic Iteration
1 Epic Experiment
1 Veyran, Voice of Duality
1 Leyline Dowser
1 Exotic Orchard
1 Shivan Reef
1 Sulfur Falls
1 Frostboil Snarl
1 Temple of Epiphany
1 Cascade Bluffs
1 Ferrous Lake
1 Treasure Cruise
1 Preordain
1 Ponder
1 Murmuring Mystic
1 Deep Analysis
1 Radical Idea
1 Opt
1 Think Twice
1 Arcane Denial
1 Pteramander
1 Vandalblast
1 Pongify
1 Serum Visions
1 Faithless Looting
1 Big Score
1 Storm-Kiln Artist
1 Young Pyromancer
1 Electrostatic Field
1 Guttersnipe
1 Volcanic Torrent
1 Windfall
1 Goblin Electromancer
1 Third Path Iconoclast
1 Expressive Iteration
1 Arcane Signet
1 Izzet Signet
1 Sol Ring
1 Command Tower
1 Temple of the False God
1 Reliquary Tower
1 Izzet Boilerworks
1 Propaganda
7 Island
7 Island
7 Mountain
6 Mountain`,
  },
  eoe_counter: {
    label: "Counter Intelligence (Inspirit, Flagship Vessel)",
    set: "Edge of Eternities Commander",
    bracket: 2,
    text: `Commander
1 Inspirit, Flagship Vessel

Deck
1 Kilo, Apogee Mind
1 Patrolling Peacemaker
1 Insight Engine
1 Uthros Research Craft
1 Depthshaker Titan
1 Long-Range Sensor
1 Moxite Refinery
1 Solar Array
1 Surge Conductor
1 Glittering Massif
1 Radiant Summit
1 Swan Song
1 Chaos Warp
1 Cloud Key
1 Gavel of the Righteous
1 Battlefield Forge
1 Angel of the Ruins
1 Fumigate
1 Organic Extinction
1 Resourceful Defense
1 Chrome Host Seedshark
1 Cyberdrive Awakener
1 Deepglow Skate
1 Emry, Lurker of the Loch
1 Kappa Cannoneer
1 Phyrexian Metamorph
1 Pull from Tomorrow
1 Ripples of Potential
1 Tekuthal, Inquiry Dominus
1 Thought Monitor
1 Universal Surveillance
1 Chain Reaction
1 Alibou, Ancient Witness
1 Jhoira, Weatherlight Captain
1 Wake the Past
1 Astral Cornucopia
1 Crystalline Crawler
1 Darksteel Reactor
1 Empowered Autogenerator
1 Hangarback Walker
1 Lux Artillery
1 Lux Cannon
1 Steel Overseer
1 Threefold Thunderhulk
1 Titan Forge
1 Adarkar Wastes
1 Cascade Bluffs
1 Clifftop Retreat
1 Exotic Orchard
1 Glacial Fortress
1 Irrigated Farmland
1 Karn's Bastion
1 The Mycosynth Gardens
1 Rugged Prairie
1 Shivan Reef
1 Skycloud Expanse
1 Spire of Industry
1 Sulfur Falls
1 Temple of Enlightenment
1 Temple of Epiphany
1 Temple of Triumph
1 Swords to Plowshares
1 Tezzeret's Gambit
1 Thirst for Knowledge
1 Arcane Signet
1 Pentad Prism
1 Sol Ring
1 Command Tower
1 Dispatch
1 Etherium Sculptor
1 Experimental Augury
1 Thrummingbird
1 Enthusiastic Mechanaut
1 Coretapper
1 Etched Oracle
1 Everflowing Chalice
1 Golem Foundry
1 Mindless Automaton
1 Soul-Guide Lantern
1 Ancient Den
1 Buried Ruin
1 Evolving Wilds
1 Great Furnace
1 Lonely Sandbar
1 Mystic Monastery
1 Razortide Bridge
1 Rustvale Bridge
1 Seat of the Synod
1 Secluded Steppe
1 Silverbluff Bridge
2 Plains
1 Plains
2 Island
1 Island
2 Mountain
1 Mountain`,
  },
  mkc_clue: {
    label: "Deep Clue Sea (Morska, Undersea Sleuth)",
    set: "Murders at Karlov Manor Commander",
    bracket: 2,
    text: `Commander
1 Morska, Undersea Sleuth

Deck
1 Sophia, Dogged Detective
1 Armed with Proof
1 Merchant of Truth
1 Serene Sleuth
1 Detective of the Month
1 Follow the Bodies
1 Tangletrove Kelp
1 Innocuous Researcher
1 On the Trail
1 Knowledge Is Power
1 Ransom Note
1 Aerial Extortionist
1 Bennie Bracks, Zoologist
1 Farewell
1 Fumigate
1 Organic Extinction
1 Search the Premises
1 Alandra, Sky Dreamer
1 Confirm Suspicions
1 Ethereal Investigator
1 Finale of Revelation
1 Kappa Cannoneer
1 Mechanized Production
1 Nadir Kraken
1 Shimmer Dragon
1 Teferi's Ageless Insight
1 Tezzeret, Betrayer of Flesh
1 Thought Monitor
1 Hornet Queen
1 Jolrael, Mwonvuli Recluse
1 Killer Service
1 Tireless Tracker
1 Adrix and Nev, Twincasters
1 Chulane, Teller of Tales
1 Disorder in the Court
1 Esix, Fractal Bloom
1 Hydroid Krasis
1 Koma, Cosmos Serpent
1 Lonis, Cryptozoologist
1 Selvala, Explorer Returned
1 Academy Manufactor
1 Idol of Oblivion
1 Inspiring Statuary
1 Nettlecyst
1 Psychosis Crawler
1 Canopy Vista
1 Exotic Orchard
1 Irrigated Farmland
1 Prairie Stream
1 Scattered Groves
1 Skycloud Expanse
1 Spire of Industry
1 Sungrass Prairie
1 Temple of Enlightenment
1 Temple of Mystery
1 Temple of Plenty
1 Swords to Plowshares
1 Erdwal Illuminator
1 Junk Winder
1 Ongoing Investigation
1 Whirler Rogue
1 Graf Mole
1 Ulvenwald Mysteries
1 Wilderness Reclamation
1 Wavesifter
1 Arcane Signet
1 Azorius Signet
1 Simic Signet
1 Sol Ring
1 Talisman of Curiosity
1 Talisman of Progress
1 Talisman of Unity
1 Azorius Chancery
1 Magnifying Glass
1 Command Tower
1 Krosan Verge
1 Lonely Sandbar
1 Path of Ancestry
1 Reliquary Tower
1 Seaside Citadel
1 Secluded Steppe
1 Selesnya Sanctuary
1 Simic Growth Chamber
1 Temple of the False God
1 Tranquil Thicket
3 Plains
6 Island
5 Forest`,
  },
  mkc_blame: {
    label: "Blame Game (Nelly Borca, Impulsive Accuser)",
    set: "Murders at Karlov Manor Commander",
    bracket: 2,
    text: `Commander
1 Nelly Borca, Impulsive Accuser

Deck
1 Feather, Radiant Arbiter
1 Immortal Obligation
1 Otherworldly Escort
1 Redemption Arc
1 Trouble in Pairs
1 Havoc Eater
1 Hot Pursuit
1 Mob Verdict
1 Prisoner's Dilemma
1 Take the Bait
1 Ransom Note
1 Angel of the Ruins
1 Comeuppance
1 Darien, King of Kjeldor
1 Duelist's Heritage
1 Elspeth, Sun's Champion
1 Keeper of the Accord
1 Loran of the Third Path
1 Promise of Loyalty
1 Selfless Squire
1 Sevinne's Reclamation
1 Smuggler's Share
1 Stalking Leonin
1 Sun Titan
1 Windborn Muse
1 Winds of Rath
1 Agitator Ant
1 Brash Taunter
1 Disrupt Decorum
1 Etali, Primal Storm
1 Fiendish Duo
1 Frontier Warmonger
1 Kazuul, Tyrant of the Cliffs
1 Spectacular Showdown
1 Vengeful Ancestor
1 Anya, Merciless Angel
1 Boros Reckoner
1 Deflecting Palm
1 Gisela, Blade of Goldnight
1 Ancient Stone Idol
1 Solemn Simulacrum
1 Steel Hellkite
1 Tome of Legends
1 Castle Ardenvale
1 Exotic Orchard
1 Furycalm Snarl
1 Kher Keep
1 Labyrinth of Skophos
1 Needle Spires
1 Scavenger Grounds
1 Slayers' Stronghold
1 Temple of Triumph
1 Throne of the High City
1 War Room
1 Ghostly Prison
1 Gideon's Sacrifice
1 Martial Impetus
1 Orzhov Advokist
1 Seal of Cleansing
1 Soul Snare
1 Vow of Duty
1 Wall of Omens
1 Curse of Opulence
1 Rite of the Raging Storm
1 Shiny Impetus
1 Vow of Lightning
1 Arcane Signet
1 Bloodthirsty Blade
1 Fellwar Stone
1 Mind Stone
1 Sol Ring
1 Talisman of Conviction
1 Thought Vessel
1 Access Tunnel
1 Ash Barrens
1 Boros Garrison
1 Command Tower
1 Escape Tunnel
1 Myriad Landscape
1 Reliquary Tower
1 Rogue's Passage
1 Sunhome, Fortress of the Legion
1 Temple of the False God
9 Plains
7 Mountain`,
  },
  mkc_recon: {
    label: "Revenant Recon (Mirko, Obsessive Theorist)",
    set: "Murders at Karlov Manor Commander",
    bracket: 2,
    text: `Commander
1 Mirko, Obsessive Theorist

Deck
1 Marvo, Deep Operative
1 Case of the Shifting Visage
1 Copy Catchers
1 Final-Word Phantom
1 Watcher of Hours
1 Charnel Serenade
1 Eye of Duskmantle
1 Foreboding Steamboat
1 Unshakable Tail
1 Counterpoint
1 Ransom Note
1 Amphin Mutineer
1 Dream Eater
1 Mission Briefing
1 Phyrexian Metamorph
1 Sphinx of the Second Sun
1 Vizier of Many Faces
1 Black Sun's Zenith
1 Dogged Detective
1 Doom Whisperer
1 Grave Titan
1 Massacre Wurm
1 Overseer of the Damned
1 Phyrexian Arena
1 Pile On
1 Reanimate
1 Rise of the Dark Realms
1 Toxic Deluge
1 Twilight Prophet
1 Baleful Strix
1 Connive // Concoct
1 Lazav, the Multifarious
1 Master of Death
1 Choked Estuary
1 Darkwater Catacombs
1 Drownyard Temple
1 Fetid Pools
1 Hostile Desert
1 River of Tears
1 Sunken Hollow
1 Brainstorm
1 Consider
1 Curate
1 Deep Analysis
1 Enhanced Surveillance
1 Ephara's Dispersal
1 Mulldrifter
1 Nightveil Sprite
1 Otherworldly Gaze
1 Thoughtbound Phantasm
1 Animate Dead
1 Necromancy
1 Price of Fame
1 Ravenous Chupacabra
1 Shriekmaw
1 Sinister Starfish
1 Syr Konrad, the Grim
1 Whispering Snitch
1 Dimir Spybug
1 Discovery // Dispersal
1 Disinformation Campaign
1 Notion Rain
1 Arcane Signet
1 Dimir Signet
1 Everflowing Chalice
1 Mind Stone
1 Sol Ring
1 Talisman of Dominance
1 Thought Vessel
1 Ash Barrens
1 Bojuka Bog
1 Command Tower
1 Dimir Aqueduct
1 Myriad Landscape
1 Mystic Sanctuary
1 Port of Karfell
1 Reliquary Tower
1 Rogue's Passage
1 Tainted Isle
1 Temple of the False God
1 Tocasia's Dig Site
9 Island
9 Swamp`,
  },
  tdc_abzan: {
    label: "Abzan Armor (Felothar the Steadfast)",
    set: "Tarkir: Dragonstorm Commander",
    bracket: 2,
    text: `Commander
1 Felothar the Steadfast

Deck
1 Betor, Ancestor's Voice
1 Protector of the Wastes
1 Reunion of the House
1 Jaws of Defeat
1 Tip the Scales
1 Will of the Abzan
1 Arbor Adherent
1 Canopy Gargantuan
1 Rampart Architect
1 Tree of Redemption
1 Ikra Shidiqi, the Usurper
1 Baldin, Century Herdmaster
1 Expel the Interlopers
1 Indomitable Ancients
1 Rhox Faithmender
1 Shalai, Voice of Plenty
1 Wakestone Gargoyle
1 Wall of Reverence
1 Welcoming Vampire
1 Zetalpa, Primal Dawn
1 Arasta of the Endless Web
1 Assault Formation
1 Hornet Nest
1 Seedborn Muse
1 Sylvan Caryatid
1 Towering Titan
1 Anguished Unmaking
1 Dragonlord Dromoka
1 Faeburrow Elder
1 Shadrix Silverquill
1 Sidar Kondo of Jamuraa
1 Colfenor's Urn
1 Staff of Compleation
1 Weathered Sentinels
1 Canopy Vista
1 Exotic Orchard
1 Fortified Village
1 Isolated Chapel
1 Overgrown Farmland
1 Sungrass Prairie
1 Sunpetal Grove
1 Temple of Malady
1 Temple of Plenty
1 Temple of Silence
1 Twilight Mire
1 Woodland Cemetery
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Nyx-Fleece Ram
1 Slaughter the Strong
1 Swords to Plowshares
1 Wall of Omens
1 Wingmantle Chaplain
1 Behind the Scenes
1 Blight Pile
1 Feed the Swarm
1 Infernal Grasp
1 Wall of Limbs
1 Arboreal Grazer
1 Axebane Guardian
1 Carven Caryatid
1 Evolving Wilds
1 Jaddi Offshoot
1 Overgrown Battlement
1 Sandsteppe Citadel
1 Tower Defense
1 Wall of Blossoms
1 Wall of Roots
1 Despark
1 Indulging Patrician
1 Crashing Drawbridge
1 Orzhov Signet
1 Selesnya Signet
1 Swiftfoot Boots
1 Walking Bulwark
1 Access Tunnel
1 Bojuka Bog
1 Deceptive Landscape
1 Path of Ancestry
1 Radiant Grove
6 Plains
5 Swamp
7 Forest`,
  },
  tdc_sultai: {
    label: "Sultai Arisen (Teval, the Balanced Scale)",
    set: "Tarkir: Dragonstorm Commander",
    bracket: 2,
    text: `Commander
1 Teval, the Balanced Scale

Deck
1 Kotis, Sibsig Champion
1 Diviner of Mist
1 Afterlife from the Loam
1 Teval's Judgment
1 Welcome the Dead
1 Floral Evoker
1 Steward of the Harvest
1 Will of the Sultai
1 Colossal Grave-Reaver
1 Gravecrawler
1 Life from the Loam
1 Casualties of War
1 Amphin Mutineer
1 River Kelpie
1 Dauthi Voidwalker
1 Disciple of Bolas
1 Junji, the Midnight Sky
1 Lethal Scheme
1 Living Death
1 Lord of the Forsaken
1 Necromantic Selection
1 Necropolis Fiend
1 Noxious Gearhulk
1 Ob Nixilis, the Fallen
1 Tasigur, the Golden Fang
1 Woe Strider
1 Avenger of Zendikar
1 Conduit of Worlds
1 Multani, Yavimaya's Avatar
1 Shigeki, Jukai Visionary
1 Consuming Aberration
1 Jarad, Golgari Lich Lord
1 Lord of Extinction
1 Meren of Clan Nel Toth
1 Command Beacon
1 Crypt of Agadeem
1 Darkwater Catacombs
1 Dreamroot Cascade
1 Drownyard Temple
1 Exotic Orchard
1 Fetid Pools
1 Hinterland Harbor
1 Llanowar Wastes
1 Sunken Hollow
1 Temple of Malady
1 Woodland Cemetery
1 Essence Anchor
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Forbidden Alchemy
1 Hedron Crab
1 Treasure Cruise
1 Wonder
1 Phyrexian Reclamation
1 Reassembling Skeleton
1 Stitcher's Supplier
1 Victimize
1 Kishla Skimmer
1 Crawling Sensation
1 Cultivate
1 Farseek
1 Grapple with the Past
1 Harrow
1 Opulent Palace
1 Rampant Growth
1 Sakura-Tribe Elder
1 Satyr Wayfinder
1 Springbloom Druid
1 Tear Asunder
1 Timeless Witness
1 Grisly Salvage
1 Nyx Weaver
1 Putrefy
1 Skull Prophet
1 Millikin
1 Cephalid Coliseum
1 Contaminated Aquifer
1 Foreboding Landscape
1 Golgari Rot Farm
1 Haunted Mire
1 Memorial to Folly
1 Myriad Landscape
1 Terramorphic Expanse
4 Island
5 Swamp
6 Forest`,
  },
  sld_odds_and_ends: {
    label: "Odds and Ends (Yennett, Cryptic Sovereign)",
    set: "Secret Lair Commander",
    bracket: 2,
    text: `Commander
1 Yennett, Cryptic Sovereign

Deck
1 Void Winnower
1 Esper Sentinel
1 Reconnaissance
1 Swords to Plowshares
1 Weathered Wayfarer
1 Misleading Signpost
1 Breach the Multiverse
1 Virtue of Persistence // Locthwain Scorn
1 Shadrix Silverquill
1 Sensei's Divining Top
1 Sol Ring
1 Aboleth Spawn
1 Adarkar Wastes
1 Aeon Engine
1 Aerial Extortionist
1 Aminatou, the Fateshifter
1 Approach of the Second Sun
1 Arcane Sanctum
1 Arcane Signet
1 Brainstorm
1 Breena, the Demagogue
1 Caves of Koilos
1 Chaos Wand
1 Claim Jumper
1 Coalition Relic
1 Command Beacon
1 Command Tower
1 Commander's Sphere
1 Contaminated Landscape
1 Dazzling Sphinx
1 Doom Whisperer
1 Drowned Catacomb
1 Enigma Sphinx
1 Ethersworn Sphinx
1 Evolving Wilds
1 Exchange of Words
1 Exotic Orchard
1 Extinction Event
1 Fabled Passage
1 Fatespinner
1 Fractured Identity
1 Glacial Fortress
1 Imprisoned in the Moon
1 Inniaz, the Gale Force
1 Isolated Chapel
1 Jeskai Infiltrator
1 Leadership Vacuum
1 Loran of the Third Path
1 Marvo, Deep Operative
1 Master of Predicaments
1 Mirage Mirror
1 Myriad Landscape
1 Mystic Gate
1 Nadir Kraken
1 Oubliette
1 Path of Ancestry
1 Planeswalker's Mischief
1 Ponder
1 Prairie Stream
1 Profane Transfusion
1 Promise of Loyalty
1 Psychic Battle
1 Rapid Hybridization
1 Reliquary Tower
1 Shared Fate
1 Silent Clearing
1 Skyclave Apparition
1 Skyclave Relic
1 Smuggler's Share
1 Soothsaying
1 Space Beleren
1 Sunken Hollow
1 Swift Reconfiguration
1 Talisman of Progress
1 Temple of Deceit
1 Temple of Enlightenment
1 Temple of Silence
1 Terramorphic Expanse
1 Thief of Sanity
1 Time Stop
1 Toxrill, the Corrosive
1 Underground River
1 Vega, the Watcher
1 Venser's Journal
1 Vesuvan Drifter
1 Wayfarer's Bauble
1 Yavimaya, Cradle of Growth
4 Plains
4 Island
4 Swamp`,
  },
  sld_hatsune_miku: {
    label: "Hatsune Miku (Trostani, Selesnya's Voice)",
    set: "Secret Lair Commander",
    bracket: 2,
    text: `Commander
1 Trostani, Selesnya's Voice

Deck
1 Archangel of Thune
1 Halo Fountain
1 Grand Crescendo
1 Shalai, Voice of Plenty
1 Song of the Worldsoul
1 Soul Warden
1 Break Down
1 Cultivate
1 Finale of Devastation
1 Vorinclex, Voice of Hunger
1 Bountiful Promenade
1 Angel of Indemnity
1 Angelic Chorus
1 Boon Reflection
1 Crested Sunmare
1 Dazzling Theater // Prop Room
1 Elenda's Hierophant
1 Excavation Technique
1 Hour of Reckoning
1 Nykthos Paragon
1 Resplendent Angel
1 Silverquill Lecturer
1 Soul of Eternity
1 Speaker of the Heavens
1 Storm Herd
1 Voice of the Blessed
1 Ancient Cornucopia
1 Arasta of the Endless Web
1 Blossoming Bogbeast
1 Bramble Sovereign
1 Fanatic of Rhonas
1 Gruff Triplets
1 Healing Technique
1 Pest Infestation
1 Shamanic Revelation
1 Camaraderie
1 Conclave Evangelist
1 Ghalta and Mavren
1 Growing Ranks
1 Lathiel, the Bounteous Dawn
1 Mirari's Wake
1 Rhys the Redeemed
1 Voice of Resurgence
1 Aetherflux Reservoir
1 Phyrexian Processor
1 Canopy Vista
1 Gavony Township
1 Grove of the Guardian
1 Lazotep Quarry
1 Overgrown Farmland
1 Restless Prairie
1 Sungrass Prairie
1 Sunpetal Grove
1 Temple of Plenty
1 Invincible Hymn
1 Ajani's Pridemate
1 Cleric Class
1 Congregate
1 Path to Exile
1 Rootborn Defenses
1 Suture Priest
1 Swords to Plowshares
1 Avacyn's Pilgrim
1 Explore
1 Farseek
1 Llanowar Elves
1 Nature's Lore
1 Prosperous Innkeeper
1 Song of Freyalise
1 Sundering Growth
1 Idol of Oblivion
1 Selesnya Signet
1 Skullclamp
1 Sol Ring
1 Springleaf Drum
1 Blossoming Sands
1 Brokers Hideout
1 Command Tower
1 Graypelt Refuge
1 Krosan Verge
1 Radiant Fountain
1 Rogue's Passage
1 Sapseep Forest
1 Selesnya Sanctuary
1 Seraph Sanctuary
7 Plains
7 Forest`,
  },
  msc_the_fantastic_four: {
    label: "The Fantastic Four (Invisible Woman)",
    set: "Marvel Super Heroes Commander",
    bracket: 2,
    text: `Commander
1 Invisible Woman

Deck
1 Mister Fantastic
1 Human Torch
1 The Thing
1 Galactus, Devourer of Worlds
1 Silver Surfer, Galactus's Herald
1 Invisible Force Field
1 Ultimate Nullification
1 Council of Reeds
1 Fantastic Elasticity
1 Lockjaw, Slobbering Teleporter
1 Valeria Richards, Precocious
1 Alicia Masters, Skilled Sculptor
1 Flame On!
1 Franklin Richards, Ascendant
1 Nova Flame
1 It's Clobberin' Time!
1 Medusa, Inhuman Queen
1 Black Bolt, Inhuman King
1 Cosmic Crucible
1 Crystal, Inhuman Princess
1 Dragon Man, Reformed Robot
1 First Family
1 Namor, Atlantean King
1 Power Pack
1 Willie Lumpkin, Postman
1 The Fantasticar
1 H.E.R.B.I.E., Lovable Robot
1 Negative Zone Portal
1 Unstable Molecule Suit
1 Cleansing Nova
1 Clever Concealment
1 Collective Effort
1 Monologue Tax
1 Promise of Loyalty
1 Tragic Arrogance
1 Quantum Misalignment
1 Recurring Insight
1 Into the Time Vortex
1 Seize the Day
1 Path of Discovery
1 Galvanic Iteration
1 Taunt from the Rampart
1 Whirlwind of Thought
1 Chromatic Lantern
1 Mirage Mirror
1 Canopy Vista
1 Cinder Glade
1 Clifftop Retreat
1 Exotic Orchard
1 Fabled Passage
1 Glacial Fortress
1 Hinterland Harbor
1 Prairie Stream
1 Radiant Summit
1 Rejuvenating Springs
1 Rootbound Crag
1 Scorched Geyser
1 Sodden Verdure
1 Sulfur Falls
1 Sunpetal Grove
1 Terramorphic Expanse
1 Mind's Dilation
1 Annie Joins Up
1 Genesis Ultimatum
1 Mister Fantastic, Reed Richards
1 Baxter Building
1 Bovine Intervention
1 Cut a Deal
1 Path to Exile
1 Deep Analysis
1 Cultivate
1 Farseek
1 Terramorph
1 Three Visits
1 Expressive Iteration
1 Hull Breach
1 Arcane Signet
1 Lightning Greaves
1 Sol Ring
1 Command Tower
1 Evolving Wilds
1 Path of Ancestry
3 Plains
2 Plains
2 Island
2 Island
2 Mountain
1 Mountain
3 Forest
2 Forest`,
  },
  msc_wakanda_forever: {
    label: "Wakanda Forever (T'Challa, the Black Panther)",
    set: "Marvel Super Heroes Commander",
    bracket: 2,
    text: `Commander
1 T'Challa, the Black Panther

Deck
1 Dora Milaje Elite
1 Everett K. Ross, Hapless Attaché
1 Hatut Zeraze Strike Force
1 King Solomon's Frogs
1 Midnight Angel Armor
1 Queen Mother Ramonda
1 Royal Talon Fighter Jet
1 The Spear of Bashenga
1 Ancestral Communion
1 Fight for the Throne
1 M'Baku, Jabari Chieftain
1 Nakia, Wakandan Operative
1 W'Kabi, Shield of the Nation
1 Wakanda Forever!
1 Zuri, Warrior of Wakanda
1 Bast, Panther Goddess
1 Okoye, Mighty and Adored
1 Shuri, the Black Panther
1 Storm, Queen of Wakanda
1 T'Chaka, Venerable King
1 Heart-Shaped Herb
1 Kimoyo Beads
1 N'Yami-Class Mother Ship
1 Panther Habit
1 Panther Robot
1 Shuri's Fabricator
1 Vibranium Mining Mech
1 Vibranium Strike Gauntlets
1 The Great Mound
1 Divine Visitation
1 Loyal Retainers
1 Martial Coup
1 Vanquish the Horde
1 Birds of Paradise
1 Conduit of Worlds
1 Greater Good
1 Nature's Lore
1 Overwhelming Stampede
1 Coveted Jewel
1 Gilded Lotus
1 Helm of the Host
1 Metalwork Colossus
1 Solemn Simulacrum
1 Trading Post
1 Bountiful Promenade
1 Canopy Vista
1 Fortified Village
1 Razorverge Thicket
1 Scattered Groves
1 Scavenger Grounds
1 Sungrass Prairie
1 Sunpetal Grove
1 Throne of the High City
1 Scourglass
1 Fleecemane Lion
1 Hammer of Nazahn
1 Mind's Eye
1 Sword of the Animist
1 Thran Dynamo
1 Dispatch
1 Generous Gift
1 Ingenious Smith
1 Palace Jailer
1 Valorous Stance
1 Beast Within
1 Harmonize
1 Loyal Guardian
1 Arcane Signet
1 Meteor Golem
1 Sol Ring
1 Whispersilk Cloak
1 Command Tower
1 Evolving Wilds
1 Path of Ancestry
1 Terramorphic Expanse
6 Plains
6 Plains
6 Forest
6 Forest`,
  },
  sld_goblin_storm: {
    label: "Goblin Storm (Zada, Hedron Grinder)",
    set: "Secret Lair Commander",
    bracket: 2,
    text: `Commander
1 Zada, Hedron Grinder

Deck
1 Krenko, Mob Boss
1 Pashalik Mons
1 Brightstone Ritual
1 Broadside Bombardiers
1 Conspicuous Snoop
1 Empty the Warrens
1 Grapeshot
1 Skirk Prospector
1 Roaming Throne
1 Skullclamp
1 Sol Ring
1 Blasphemous Act
1 Chaos Warp
1 Frontline Heroism
1 Goblin Bombardment
1 Goblin Chieftain
1 Goblin Dark-Dwellers
1 Goblin Lackey
1 Goblin Trashmaster
1 Great Train Heist
1 Grenzo, Havoc Raiser
1 Howlsquad Heavy
1 Past in Flames
1 Redcap Gutter-Dweller
1 Rundvelt Hordemaster
1 Searslicer Goblin
1 Siege-Gang Commander
1 Siege-Gang Lieutenant
1 Idol of Oblivion
1 Ruby Medallion
1 Throne of Eldraine
1 Arena of Glory
1 Castle Embereth
1 Den of the Bugbear
1 Fountainport
1 Kher Keep
1 Spinerock Knoll
1 War Room
1 Shinka, the Bloodsoaked Keep
1 Ancestors' Aid
1 Battle Hymn
1 Boggart Shenanigans
1 Crimson Wisps
1 Daring Discovery
1 Dragon Fodder
1 Expedite
1 Faithless Looting
1 Fists of Flame
1 Gempalm Incinerator
1 General Kreat, the Boltbringer
1 Glimpse the Impossible
1 Goblin Bushwhacker
1 Goblin Matron
1 Goblin Negotiation
1 Goblin Warchief
1 Haze of Rage
1 Impact Tremors
1 Impulsive Pilferer
1 Krenko's Command
1 Mana Geyser
1 Mogg War Marshal
1 Quest for the Goblin Lord
1 Renegade Tactics
1 Sazacap's Brew
1 Seething Song
1 Spreading Insurrection
1 Storm-Kiln Artist
1 Vandalblast
1 Wild Ride
1 Witch's Mark
1 Swiftfoot Boots
1 Dwarven Mine
1 Forgotten Cave
1 Goblin Burrows
1 Hidden Volcano
1 Reliquary Tower
1 Smoldering Crater
7 Mountain
8 Mountain
7 Mountain`,
  },
  soc_lorehold_spirit: {
    label: "Lorehold Spirit (Quintorius, History Chaser)",
    set: "Secrets of Strixhaven Commander",
    bracket: 2,
    text: `Commander
1 Quintorius, History Chaser

Deck
1 Excava, the Risen Past
1 Lorehold Archivist
1 Augusta, Order Returned
1 Ceaseless Conflict
1 Vanguard of the Restless
1 Advanced Reconstruction
1 Fateful Tempest
1 Naktamun Lorespinner
1 Relic Retriever
1 Spirit of Resilience
1 Turbulent Steppe
1 Moonshaker Cavalry
1 Staff of the Storyteller
1 Wave of Reckoning
1 Fabled Passage
1 Angel of Indemnity
1 Ao, the Dawn Sky
1 Archaeomancer's Map
1 Claim Jumper
1 Drumbellower
1 Guardian of Faith
1 Guardian Scalelord
1 Karmic Guide
1 Monologue Tax
1 Remorseful Cleric
1 Selfless Spirit
1 Serra Paragon
1 Sevinne's Reclamation
1 Skyclave Apparition
1 Sun Titan
1 Tocasia's Welcome
1 Tragic Arrogance
1 White Orchid Phantom
1 Atsushi, the Blazing Sky
1 Conspiracy Theorist
1 Laelia, the Blade Reforged
1 Balefire Liege
1 Hofri Ghostforge
1 Quintorius, Loremaster
1 Venerable Warsinger
1 Bitterthorn, Nissa's Animus
1 Currency Converter
1 Battlefield Forge
1 Clifftop Retreat
1 Emeria, the Sky Ruin
1 Exotic Orchard
1 Furycalm Snarl
1 Glittering Massif
1 Lotus Field
1 Radiant Summit
1 Rugged Prairie
1 Sunscorched Divide
1 Temple of Triumph
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Primary Research
1 Seize the Spoils
1 Kirol, History Buff
1 Lorehold Charm
1 Fields of Strife
1 Terramorphic Expanse
1 Kami of Ancient Law
1 Path to Exile
1 Secret Rendezvous
1 Swords to Plowshares
1 Teshar, Ancestor's Apostle
1 Anger
1 Faithless Looting
1 Squee, Goblin Nabob
1 Quintorius, Field Historian
1 Rip Apart
1 Containment Construct
1 Fellwar Stone
1 Millikin
1 Mind Stone
1 Patchwork Banner
1 Perpetual Timepiece
1 Lorehold Campus
1 Mistveil Plains
1 Sacred Peaks
1 Study Hall
11 Plains
6 Mountain`,
  },
  soc_prismari_artistry: {
    label: "Prismari Artistry (Rootha, Mastering the Moment)",
    set: "Secrets of Strixhaven Commander",
    bracket: 2,
    text: `Commander
1 Rootha, Mastering the Moment

Deck
1 Muddle, the Ever-Changing
1 Inspired Skypainter
1 Abstract Performance
1 Dirgur Focusmage
1 Leitmotif Composer
1 Furygale Flocking
1 Prismari Pianist
1 Renegade Bull
1 Coastal Peak
1 Scorched Geyser
1 Turbulent Springs
1 Faerie Mastermind
1 Chain Reaction
1 Determined Iteration
1 Harmonic Prodigy
1 Fabled Passage
1 Archmage Emeritus
1 Brazen Borrower
1 Curiosity Crafter
1 Dig Through Time
1 Replication Technique
1 Rite of Replication
1 Thunderclap Drake
1 Blasphemous Act
1 Chaos Warp
1 Creative Technique
1 Cursed Mirror
1 Dance with Calamity
1 Goldspan Dragon
1 Manaform Hellkite
1 Mirrorwing Dragon
1 Plargg and Nassari
1 Redoubled Stormsinger
1 Rionya, Fire Dancer
1 Rousing Refrain
1 Surge to Victory
1 Twinflame
1 Volcanic Salvo
1 Brudiclad, Telchor Engineer
1 Galazeth Prismari
1 Magma Opus
1 Prismari Command
1 Veyran, Voice of Duality
1 Solemn Simulacrum
1 Cascade Bluffs
1 Exotic Orchard
1 Ferrous Lake
1 Frostboil Snarl
1 Hall of Oracles
1 Restless Spire
1 Shivan Reef
1 Sulfur Falls
1 Temple of Epiphany
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Prismari Charm
1 Spectacle Summit
1 Terramorphic Expanse
1 Aether Gale
1 Arcane Denial
1 Deep Analysis
1 Reality Shift
1 Resculpt
1 Treasure Cruise
1 Abrade
1 Big Score
1 Mana Geyser
1 Storm-Kiln Artist
1 Throes of Chaos
1 Volcanic Torrent
1 Expressive Iteration
1 Rootha, Mercurial Artist
1 Stormcatch Mentor
1 Fellwar Stone
1 Lightning Greaves
1 Talisman of Creativity
1 Molten Tributary
1 Mystic Sanctuary
1 Path of Ancestry
1 Prismari Campus
1 Reliquary Tower
1 Study Hall
1 Temple of the False God
8 Island
7 Mountain`,
  },
  soc_quandrix_unlimited: {
    label: "Quandrix Unlimited (Zimone, Infinite Analyst)",
    set: "Secrets of Strixhaven Commander",
    bracket: 2,
    text: `Commander
1 Zimone, Infinite Analyst

Deck
1 Primo, the Unbounded
1 Owlin Spiralmancer
1 Expansion Algorithm
1 Nexus Mentality
1 Kinetic Ooze
1 Lattice Library
1 Nev, the Practical Dean
1 Yavimaya Bloomsage
1 Striding Shotcaller
1 Brass Infiniscope
1 Turbulent Wilderness
1 Commander's Insight
1 Ingenious Prodigy
1 Pull from Tomorrow
1 Benevolent Hydra
1 Unbound Flourishing
1 Fabled Passage
1 Curse of the Swine
1 Deekah, Fractal Theorist
1 Entrancing Melody
1 Perplexing Test
1 Stroke of Genius
1 Zimone's Hypothesis
1 Animist's Awakening
1 Forgotten Ancient
1 Fractal Harness
1 Goldvein Hydra
1 Guardian Augmenter
1 Hardened Scales
1 Lifeblood Hydra
1 Mana Bloom
1 Open the Way
1 Ozolith, the Shattered Spire
1 Primal Might
1 Primordial Hydra
1 Silkguard
1 Steelbane Hydra
1 Altered Ego
1 Biomass Mutation
1 Elusive Otter
1 The Goose Mother
1 Hydroid Krasis
1 Oversimplify
1 Quandrix Command
1 Tanazir Quandrix
1 Zimone, All-Questioning
1 Astral Cornucopia
1 Elementalist's Palette
1 Hangarback Walker
1 Stonecoil Serpent
1 Alchemist's Refuge
1 Exotic Orchard
1 Flooded Grove
1 Hinterland Harbor
1 Oran-Rief, the Vastwood
1 Overflowing Basin
1 Rain-Slicked Copse
1 Sodden Verdure
1 Temple of Mystery
1 Vineglimmer Snarl
1 Yavimaya Coast
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Quandrix Charm
1 Paradox Gardens
1 Terramorphic Expanse
1 Rapid Hybridization
1 Beast Within
1 Kami of Whispered Hopes
1 Nature's Lore
1 Three Visits
1 Tyvar's Stand
1 Decisive Denial
1 Eureka Moment
1 Quandrix Apprentice
1 Troyan, Gutsy Explorer
1 Zimone, Quandrix Prodigy
1 Opal Palace
1 Path of Ancestry
1 Quandrix Campus
1 Reliquary Tower
1 Rogue's Passage
1 Study Hall
1 Tangled Islet
1 Temple of the False God
7 Island
6 Forest`,
  },
  soc_silverquill_influence: {
    label: "Silverquill Influence (Killian, Decisive Mentor)",
    set: "Secrets of Strixhaven Commander",
    bracket: 2,
    text: `Commander
1 Killian, Decisive Mentor

Deck
1 Scriv, the Obligator
1 Eiganjo Dynastorian
1 Forum Filibuster
1 Herald of Amity
1 Changing Loyalty
1 Coercive Impetus
1 Intermediate Chirography
1 Defacing Duskmage
1 Eclipsed Steppe
1 Turbulent Moor
1 Umbral Expanse
1 Fabled Passage
1 Eldrazi Conscription
1 Ajani's Chosen
1 Angelic Destiny
1 Archon of Sun's Grace
1 Armored Skyhunter
1 Combat Calligrapher
1 Eidolon of Countless Battles
1 Firemane Commando
1 Gift of Immortality
1 Kor Spiritdancer
1 Land Tax
1 Mangara, the Diplomat
1 Nils, Discipline Enforcer
1 Pearl-Ear, Imperial Advisor
1 Promise of Loyalty
1 Redemption Arc
1 Shielded by Faith
1 Songbirds' Blessing
1 Sram, Senior Edificer
1 Starfield Mystic
1 Winds of Rath
1 Doomwake Giant
1 Ghoulish Impetus
1 Keen Duelist
1 Anguished Unmaking
1 Breena, the Demagogue
1 Eriette of the Charmed Apple
1 Inkshield
1 Shadrix Silverquill
1 Tomik, Wielder of Law
1 Vanishing Verse
1 Caves of Koilos
1 Desolate Mire
1 Exotic Orchard
1 Fetid Heath
1 Isolated Chapel
1 Shineshadow Snarl
1 Temple of Silence
1 War Room
1 Flickering Ward
1 Fallen Ideal
1 Screams from Within
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Forum of Amity
1 Terramorphic Expanse
1 Chains of Custody
1 Darksteel Mutation
1 Ghostly Prison
1 Martial Impetus
1 Raffine's Guidance
1 Sage's Reverie
1 Secret Rendezvous
1 Sentinel's Eyes
1 Sheltered by Ghosts
1 Spirit Mantle
1 Transcendent Envoy
1 Animate Dead
1 Hateful Eidolon
1 Parasitic Impetus
1 Fracture
1 Killian, Ink Duelist
1 Fellwar Stone
1 Talisman of Hierarchy
1 Arcane Lighthouse
1 Bojuka Bog
1 Path of Ancestry
1 Silverquill Campus
1 Study Hall
1 Sunlit Marsh
8 Plains
8 Swamp`,
  },
  soc_witherbloom_pestilence: {
    label: "Witherbloom Pestilence (Dina, Essence Brewer)",
    set: "Secrets of Strixhaven Commander",
    bracket: 2,
    text: `Commander
1 Dina, Essence Brewer

Deck
1 Gorma, the Gullet
1 Merchant of Venom
1 Defiling Daemogoth
1 Ominous Harvest
1 Stensian Sanguinist
1 Feral Appetite
1 Pest Rescuer
1 Ribtruss Roaster
1 Eccentric Pestfinder
1 Immoral Bargain
1 Turbulent Fen
1 Ophiomancer
1 Toxic Deluge
1 Tendershoot Dryad
1 Fabled Passage
1 Blight Mound
1 Bloodghast
1 Final Act
1 Jadar, Ghoulcaller of Nephalia
1 Nether Traitor
1 Priest of Forgotten Gods
1 Smothering Abomination
1 Veinwitch Coven
1 Witch of the Moors
1 Woe Strider
1 Yahenni, Undying Partisan
1 Awakening Zone
1 Blossoming Bogbeast
1 Gilded Goose
1 Mycoloth
1 Ohran Frostfang
1 Pest Infestation
1 Trudge Garden
1 Assassin's Trophy
1 Beledros Witherbloom
1 Casualties of War
1 Creakwood Liege
1 Culling Ritual
1 Gyome, Master Chef
1 Mazirek, Kraul Death Priest
1 Wight of the Reliquary
1 Witherbloom Command
1 Exotic Orchard
1 Festering Thicket
1 Grim Backwoods
1 High Market
1 Llanowar Wastes
1 Necroblossom Snarl
1 Temple of Malady
1 Twilight Mire
1 Vernal Fen
1 Viridescent Bog
1 Woodland Cemetery
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Teacher's Pest
1 Witherbloom Charm
1 Terramorphic Expanse
1 Titan's Grave
1 Blood Artist
1 Infernal Grasp
1 Morbid Opportunist
1 Night's Whisper
1 Pawn of Ulamog
1 Plumb the Forbidden
1 Umbral Collar Zealot
1 Viscera Seer
1 Zulaport Cutthroat
1 Cultivate
1 Elvish Mystic
1 Sakura-Tribe Elder
1 Springbloom Druid
1 Deadly Brew
1 Dina, Soul Steeper
1 Moldervine Reclamation
1 Mortality Spear
1 Haywire Mite
1 Bojuka Bog
1 Haunted Mire
1 Path of Ancestry
1 Study Hall
1 Witherbloom Campus
8 Swamp
8 Forest`,
  },
  ecc_dance_of_the_elements: {
    label: "Dance of the Elements (Ashling, the Limitless)",
    set: "Lorwyn Eclipsed Commander",
    bracket: 2,
    text: `Commander
1 Ashling, the Limitless

Deck
1 Mass of Mysteries
1 Elemental Spectacle
1 Springleaf Parade
1 Jubilation
1 Impulsivity
1 Lamentation
1 Belonging
1 Subterfuge
1 Rain-Slicked Copse
1 Sodden Verdure
1 Abundant Countryside
1 Endurance
1 Fury
1 Haunting Voyage
1 Avenger of Zendikar
1 Cavalier of Thorns
1 Greenwarden of Murasa
1 Selvala, Heart of the Wilds
1 Titan of Industry
1 Muldrotha, the Gravetide
1 Omnath, Locus of Rage
1 Yarok, the Desecrated
1 Omnath, Locus of the Roil
1 Timeless Lotus
1 Shatter the Sky
1 Hoofprints of the Stag
1 Slithermuse
1 Descendants' Fury
1 Blasphemous Act
1 Cream of the Crop
1 Kindred Summons
1 Bane of Progress
1 Realmwalker
1 Return of the Wildspeaker
1 Faeburrow Elder
1 Vernal Sovereign
1 Horde of Notions
1 Maelstrom Wanderer
1 Jegantha, the Wellspring
1 Chromatic Lantern
1 Primal Beyond
1 Raging Ravine
1 Exotic Orchard
1 Flamekin Village
1 Path to Exile
1 Mulldrifter
1 Reality Shift
1 Shriekmaw
1 Shimmercreep
1 Flamebraider
1 Crib Swap
1 Secluded Courtyard
1 Sol Ring
1 Command Tower
1 Arcane Signet
1 Distant Melody
1 Incandescent Soulstoke
1 Eclipsed Flamekin
1 Foundation Breaker
1 Garruk's Uprising
1 Risen Reef
1 Fellwar Stone
1 Unclaimed Territory
1 Ancient Ziggurat
1 Frontier Bivouac
1 Sandsteppe Citadel
1 Savage Lands
1 Opulent Palace
1 Seaside Citadel
1 Jungle Shrine
1 Smokebraider
1 Ingot Chewer
1 Fertile Ground
1 Abundant Growth
1 Kodama's Reach
1 Cultivate
1 Path of Ancestry
1 Thriving Grove
1 Thriving Heath
1 Thriving Isle
1 Opal Palace
1 Thriving Bluff
1 Thriving Moor
2 Plains
2 Island
2 Swamp
2 Mountain
8 Forest`,
  },
  fic_counter_blitz_final_fant: {
    label: "Counter Blitz (FINAL FANTASY X) (Tidus, Yuna's Guardian)",
    set: "Final Fantasy Commander",
    bracket: 2,
    text: `Commander
1 Tidus, Yuna's Guardian

Deck
1 Yuna, Grand Summoner
1 Auron, Venerated Guardian
1 Chocobo Knights
1 Gatta and Luzzu
1 Lord Jyscal Guado
1 Protection Magic
1 Summon: Ixion
1 Summon: Yojimbo
1 Summoner's Sending
1 Blitzball Stadium
1 Lulu, Stern Guardian
1 O'aka, Traveling Merchant
1 Rikku, Resourceful Guardian
1 Summon: Valefor
1 Maester Seymour
1 Sphere Grid
1 Summon: Magus Sisters
1 Tromell, Seymour's Butler
1 Yuna's Decision
1 Yuna's Whistle
1 Kimahri, Valiant Guardian
1 Shelinda, Yevon Acolyte
1 Sin, Unending Cataclysm
1 Wakka, Devoted Guardian
1 Collective Effort
1 Damning Verdict
1 Farewell
1 Luminous Broodmoth
1 Promise of Loyalty
1 Resourceful Defense
1 Scholar of New Horizons
1 Sunscorch Regent
1 Together Forever
1 Chasm Skulker
1 Inexorable Tide
1 Pull from Tomorrow
1 Bane of Progress
1 Fight Rigging
1 Forgotten Ancient
1 Generous Patron
1 Gyre Sage
1 Hardened Scales
1 Incubation Druid
1 Path of Discovery
1 Rampant Rejuvenator
1 Tireless Tracker
1 Altered Ego
1 Endless Detour
1 Fathom Mage
1 Walking Ballista
1 Brushland
1 Canopy Vista
1 Exotic Orchard
1 Flooded Grove
1 Fortified Village
1 Glacial Fortress
1 Hinterland Harbor
1 Overflowing Basin
1 Port Town
1 Prairie Stream
1 Skycloud Expanse
1 Sungrass Prairie
1 Sunpetal Grove
1 Temple of Enlightenment
1 Temple of Mystery
1 Temple of Plenty
1 Vineglimmer Snarl
1 Destroy Evil
1 Grateful Apparition
1 Path to Exile
1 An Offer You Can't Refuse
1 Duskshell Crawler
1 Farseek
1 Inspiring Call
1 Three Visits
1 Bred for the Hunt
1 Arcane Signet
1 Everflowing Chalice
1 Sol Ring
1 Ash Barrens
1 Evolving Wilds
1 Forge of Heroes
1 Idyllic Beachfront
1 Nesting Grounds
1 Path of Ancestry
1 Radiant Grove
1 Seaside Citadel
1 Tangled Islet
1 Temple of the False God
1 Command Tower
1 Island
1 Island
1 Island
1 Forest
1 Forest
1 Forest
1 Plains
1 Plains
1 Plains`,
  },
  fic_limit_break_final_fantas: {
    label: "Limit Break (FINAL FANTASY VII) (Cloud, Ex-SOLDIER)",
    set: "Final Fantasy Commander",
    bracket: 2,
    text: `Commander
1 Cloud, Ex-SOLDIER

Deck
1 Tifa, Martial Artist
1 Cid, Freeflier Pilot
1 Cloud's Limit Break
1 Elena, Turk Recruit
1 Heidegger, Shinra Executive
1 Helitrooper
1 SOLDIER Military Program
1 Ultimate Magic: Holy
1 Avalanche of Sector 7
1 Cait Sith, Fortune Teller
1 Summon: Kujata
1 Ultimate Magic: Meteor
1 Vincent, Vengeful Atoner
1 Yuffie, Materia Hunter
1 Bugenhagen, Wise Elder
1 Lifestream's Blessing
1 Professor Hojo
1 Summoning Materia
1 Aerith, Last Ancient
1 Barret, Avalanche Leader
1 Red XIII, Proud Warrior
1 Sephiroth, Fallen Hero
1 Conformer Shuriken
1 Wrecking Ball Arm
1 Austere Command
1 Bastion Protector
1 Bronze Guardian
1 Clever Concealment
1 Puresteel Paladin
1 Unfinished Business
1 Vanquish the Horde
1 Chaos Warp
1 Hellkite Tyrant
1 Professional Face-Breaker
1 Decimate
1 Armory Automaton
1 Champion's Helm
1 Conqueror's Flail
1 Darksteel Plate
1 Inspiring Statuary
1 Sword of the Animist
1 Battlefield Forge
1 Bonders' Enclave
1 Brushland
1 Canopy Vista
1 Cinder Glade
1 Clifftop Retreat
1 Exotic Orchard
1 Fire-Lit Thicket
1 Fortified Village
1 Furycalm Snarl
1 Game Trail
1 Mossfire Valley
1 Rootbound Crag
1 Rugged Prairie
1 Scavenger Grounds
1 Slayers' Stronghold
1 Spire of Industry
1 Sungrass Prairie
1 Sunpetal Grove
1 Sunscorched Divide
1 Zack Fair
1 Barret Wallace
1 Dispatch
1 Secret Rendezvous
1 Furious Rise
1 Vandalblast
1 Cultivate
1 Harmonize
1 Nature's Lore
1 Rampant Growth
1 Behemoth Sledge
1 Arcane Signet
1 Colossus Hammer
1 Explorer's Scope
1 Hero's Blade
1 Hero's Heirloom
1 Lightning Greaves
1 Mask of Memory
1 Skullclamp
1 Sol Ring
1 Trailblazer's Boots
1 Ash Barrens
1 Evolving Wilds
1 Jungle Shrine
1 Path of Ancestry
1 Radiant Grove
1 Sacred Peaks
1 Wooded Ridgeline
1 Command Tower
1 Mountain
1 Mountain
1 Mountain
1 Forest
1 Forest
1 Forest
1 Plains
1 Plains
1 Plains`,
  },
  fic_revival_trance_final_fan: {
    label: "Revival Trance (FINAL FANTASY VI) (Terra, Herald of Hope)",
    set: "Final Fantasy Commander",
    bracket: 2,
    text: `Commander
1 Terra, Herald of Hope

Deck
1 Celes, Rune Knight
1 Coin of Fate
1 Cyan, Vengeful Samurai
1 General Leo Cristophe
1 Espers to Magicite
1 The Falcon, Airship Restored
1 Interceptor, Shadow's Hound
1 Rejoin the Fight
1 Shadow, Mysterious Assassin
1 Siegfried, Famed Swordsman
1 Gau, Feral Youth
1 Gogo, Mysterious Mime
1 Sabin, Master Monk
1 Snort
1 Strago and Relm
1 Summon: Esper Valigarmanda
1 Umaro, Raging Yeti
1 Banon, the Returners' Leader
1 Edgar, Master Machinist
1 Kefka, Dancing Mad
1 Locke, Treasure Hunter
1 Mog, Moogle Warrior
1 Setzer, Wandering Gambler
1 The Warring Triad
1 Sun Titan
1 Tragic Arrogance
1 Archfiend of Depravity
1 Reanimate
1 Rise of the Dark Realms
1 Sepulchral Primordial
1 Combustible Gearhulk
1 Flayer of the Hatebound
1 Ruin Grinder
1 Bedevil
1 Legions to Ashes
1 Priest of Fell Rites
1 Ruinous Ultimatum
1 Key to the City
1 Solemn Simulacrum
1 Battlefield Forge
1 Clifftop Retreat
1 Desolate Mire
1 Dragonskull Summit
1 Exotic Orchard
1 Fetid Heath
1 Foreboding Ruins
1 Furycalm Snarl
1 Graven Cairns
1 High Market
1 Isolated Chapel
1 Rugged Prairie
1 Shadowblood Ridge
1 Shineshadow Snarl
1 Smoldering Marsh
1 Sulfurous Springs
1 Sunscorched Divide
1 Phoenix Down
1 Laughing Mad
1 Angel of the Ruins
1 Palace Jailer
1 Morbid Opportunist
1 Night's Whisper
1 Pitiless Plunderer
1 Stitch Together
1 Stitcher's Supplier
1 Anger
1 Big Score
1 Crackling Doom
1 Mortify
1 Arcane Signet
1 Commander's Sphere
1 Meteor Golem
1 Millikin
1 Mind Stone
1 Sol Ring
1 Swiftfoot Boots
1 Talisman of Conviction
1 Talisman of Indulgence
1 Wayfarer's Bauble
1 Ash Barrens
1 Demolition Field
1 Evolving Wilds
1 Geothermal Bog
1 Nomad Outpost
1 Path of Ancestry
1 Rogue's Passage
1 Sacred Peaks
1 Sunlit Marsh
1 Command Tower
2 Plains
1 Plains
1 Plains
1 Swamp
1 Swamp
1 Swamp
1 Mountain
1 Mountain
1 Mountain`,
  },
  fic_scions_spellcraft_final_: {
    label: "Scions & Spellcraft (FINAL FANTASY XIV) (Y'shtola, Night's Blessed)",
    set: "Final Fantasy Commander",
    bracket: 2,
    text: `Commander
1 Y'shtola, Night's Blessed

Deck
1 G'raha Tia, Scion Reborn
1 Alisaie Leveilleur
1 Champions from Beyond
1 Dancer's Chakrams
1 Summon: Good King Mog XII
1 Tataru Taru
1 Thancred Waters
1 Alphinaud Leveilleur
1 Blue Mage's Cane
1 Hermes, Overseer of Elpis
1 Hraesvelgr of the First Brood
1 Observed Stasis
1 Eye of Nidhogg
1 Fandaniel, Telophoroi Ascian
1 Astrologian's Planisphere
1 Reaper's Scythe
1 Transpose
1 Ardbert, Warrior of Darkness
1 Emet-Selch of the Third Seat
1 Estinien Varlineau
1 Hildibrand Manderville
1 Krile Baldesion
1 Lyse Hext
1 Papalymo Totolymo
1 Urianger Augurelt
1 Archaeomancer's Map
1 Authority of the Consuls
1 Cleansing Nova
1 Final Judgment
1 Archmage Emeritus
1 Dig Through Time
1 Rite of Replication
1 Sublime Epiphany
1 Torrential Gearhulk
1 Crux of Fate
1 Lethal Scheme
1 Murderous Rider
1 Baleful Strix
1 Vindicate
1 Void Rend
1 Coveted Jewel
1 Tome of Legends
1 Choked Estuary
1 Darkwater Catacombs
1 Desolate Mire
1 Drowned Catacomb
1 Exotic Orchard
1 Fetid Heath
1 Glacial Fortress
1 Isolated Chapel
1 Port Town
1 Prairie Stream
1 Scavenger Grounds
1 Shineshadow Snarl
1 Skycloud Expanse
1 Sunken Hollow
1 Sunken Ruins
1 Underground River
1 White Auracite
1 Sage's Nouliths
1 Circle of Power
1 Cut a Deal
1 Lingering Souls
1 Swords to Plowshares
1 Hypnotic Sprite
1 Into the Story
1 Propaganda
1 Bastion of Remembrance
1 Exsanguinate
1 Snuff Out
1 Syphon Mind
1 Arcane Signet
1 Relic of Legends
1 Sol Ring
1 Talisman of Dominance
1 Talisman of Hierarchy
1 Talisman of Progress
1 Thought Vessel
1 Arcane Sanctum
1 Ash Barrens
1 Command Tower
1 Contaminated Aquifer
1 Demolition Field
1 Evolving Wilds
1 Idyllic Beachfront
1 Path of Ancestry
1 Sunlit Marsh
1 Temple of the False God
1 Island
1 Island
1 Island
2 Swamp
1 Swamp
1 Swamp
2 Plains
1 Plains
1 Plains`,
  },
  sld_everyone_s_invited: {
    label: "Everyone's Invited! (Morophon, the Boundless)",
    set: "Secret Lair Commander",
    bracket: 2,
    text: `Commander
1 Morophon, the Boundless

Deck
1 Raise the Palisade
1 Bitterblossom
1 Taurean Mauler
1 Avenger of Zendikar
1 Coat of Arms
1 Kindred Summons
1 Maskwood Nexus
1 Sol Ring
1 Tendershoot Dryad
1 Adarkar Wastes
1 Amoeboid Changeling
1 Ancient Amphitheater
1 Arcane Adaptation
1 Arcane Denial
1 Arcane Sanctum
1 Arcane Signet
1 Atla Palani, Nest Tender
1 Beast Within
1 Black Market Connections
1 Bloodline Pretender
1 Brenard, Ginger Sculptor
1 Bruse Tarl, Roving Rancher
1 Brushland
1 Chameleon Colossus
1 Cloudshredder Sliver
1 Command Tower
1 Crib Swap
1 Cultivate
1 Darkwater Catacombs
1 Distant Melody
1 Double Down
1 Exotic Orchard
1 Fabled Passage
1 Farseek
1 Feline Sovereign
1 Fire-Belly Changeling
1 Frontier Bivouac
1 Gemhide Sliver
1 Gilt-Leaf Palace
1 Graveshifter
1 Guardian Gladewalker
1 Harabaz Druid
1 Harper Recruiter
1 Impostor of the Sixth Pride
1 Jungle Shrine
1 Karplusan Forest
1 Kindred Discovery
1 Kindred Dominance
1 Kinsbaile Cavalier
1 Kirri, Talented Sprout
1 Kodama's Reach
1 Llanowar Wastes
1 Magda, Brazen Outlaw
1 Manaweft Sliver
1 Masked Vandal
1 Mirror Entity
1 Moritte of the Frost
1 Mossfire Valley
1 Mothdust Changeling
1 Murmuring Bosk
1 Mutavault
1 Nameless Inversion
1 Opulent Palace
1 Overflowing Basin
1 Path of Ancestry
1 Pongify
1 Realmbreaker, the Invasion Tree
1 Realmwalker
1 Rin and Seri, Inseparable
1 Risen Reef
1 Rukarumel, Biologist
1 Seaside Citadel
1 Secluded Glen
1 Shapesharer
1 Shields of Velis Vel
1 Skeletal Changeling
1 Sophia, Dogged Detective
1 Spoils of Adventure
1 Stick Together
1 Sungrass Prairie
1 Tazri, Beacon of Unity
1 The Bears of Littjara
1 The World Tree
1 Universal Automaton
1 Unsettled Mariner
1 Wanderwine Hub
1 Yavimaya Coast
1 Forest
1 Forest
1 Forest
1 Plains
1 Plains
1 Plains
1 Mountain
1 Mountain
1 Island
1 Island
1 Island
1 Swamp`,
  },
  drc_living_energy: {
    label: "Living Energy (Saheeli, Radiant Creator)",
    set: "Aetherdrift Commander",
    bracket: 2,
    text: `Commander
1 Saheeli, Radiant Creator

Deck
1 Pia Nalaar, Chief Mechanic
1 Territorial Aetherkite
1 Nissa, Worldsoul Speaker
1 Peema Trailblazer
1 Rampaging Aetherhood
1 Adaptive Omnitool
1 Aetherflux Conduit
1 Aetheric Amplifier
1 Stridehangar Automaton
1 Chain Reaction
1 Chaos Warp
1 Druid of Purification
1 Chromatic Lantern
1 Duplicant
1 Academy Ruins
1 Aethersquall Ancient
1 Aethertide Whale
1 Confiscation Coup
1 Disallow
1 Midnight Clock
1 One with the Machine
1 Sai, Master Thopterist
1 Thopter Spy Network
1 Blasphemous Act
1 Combustible Gearhulk
1 Lightning Runner
1 Pia and Kiran Nalaar
1 Aetherwind Basker
1 Architect of the Untamed
1 Bootleggers' Stash
1 Elder Gargaroth
1 Aetherworks Marvel
1 Conjurer's Closet
1 Cultivator's Caravan
1 Panharmonicon
1 Retrofitter Foundry
1 Solemn Simulacrum
1 Triplicate Titan
1 Exotic Orchard
1 Frostboil Snarl
1 Hinterland Harbor
1 Karplusan Forest
1 Overflowing Basin
1 Rootbound Crag
1 Sheltered Thicket
1 Shivan Reef
1 Spire of Industry
1 Sulfur Falls
1 Temple of Epiphany
1 Treasure Vault
1 Vineglimmer Snarl
1 Yavimaya Coast
1 Reality Shift
1 Arcane Signet
1 Lightning Greaves
1 Sol Ring
1 Command Tower
1 Arcane Denial
1 Bespoke Battlewagon
1 Era of Innovation
1 Glimmer of Genius
1 Whirler Rogue
1 Loyal Apprentice
1 Reckless Fireweaver
1 Attune with Aether
1 Explosive Vegetation
1 Peema Aether-Seer
1 Servant of the Conduit
1 Rogue Refiner
1 Saheeli, Sublime Artificer
1 Whirler Virtuoso
1 Commander's Sphere
1 Decoction Module
1 Ornithopter of Paradise
1 Solar Transformer
1 Soul-Guide Lantern
1 Talisman of Curiosity
1 Aether Hub
1 Evolving Wilds
1 Frontier Bivouac
1 Path of Ancestry
1 Slagwoods Bridge
1 Tanglepool Bridge
5 Island
5 Mountain
6 Forest`,
  },
  sld_20_ways_to_win: {
    label: "20 Ways to Win (Go-Shintai of Life's Origin)",
    set: "Secret Lair Commander",
    bracket: 2,
    text: `Commander
1 Go-Shintai of Life's Origin

Deck
1 Alseid of Life's Bounty
1 Approach of the Second Sun
1 Arcane Signet
1 Augur of Autumn
1 Auriok Champion
1 Austere Command
1 Azorius Guildgate
1 Baldur's Gate
1 Biovisionary
1 Black Dragon Gate
1 Boros Guildgate
1 Bountiful Promenade
1 Brushland
1 Chromatic Lantern
1 Circuitous Route
1 Citadel Gate
1 Clever Concealment
1 Cliffgate
1 Command Tower
1 Crib Swap
1 Darksteel Citadel
1 Darksteel Mutation
1 Dimir Guildgate
1 Drown in Dreams
1 Dryad of the Ilysian Grove
1 Eerie Ultimatum
1 Exotic Orchard
1 Faeburrow Elder
1 Felidar Sovereign
1 Fertile Ground
1 Forbidden Orchard
1 Forest
1 Forgotten Ancient
1 Gateway Plaza
1 Ghostly Prison
1 Ghoulish Impetus
1 Golgari Guildgate
1 Gond Gate
1 Gruul Guildgate
1 Halo Fountain
1 Hangarback Walker
1 Happily Ever After
1 Heap Gate
1 Heliod's Intervention
1 Heliod, Sun-Crowned
1 Helix Pinnacle
1 Hellkite Tyrant
1 Homeward Path
1 Izzet Guildgate
1 Kynaios and Tiro of Meletis
1 Lightning Greaves
1 Lignify
1 Liliana's Contract
1 Mangara, the Diplomat
1 Manor Gate
1 Maskwood Nexus
1 Mayael's Aria
1 Maze's End
1 Mechanized Production
1 Monologue Tax
1 Morbid Opportunist
1 Mystic Remora
1 Orzhov Guildgate
1 Overgrown Farmland
1 Pariah
1 Path of Ancestry
1 Plains
1 Plaza of Harmony
1 Rakdos Guildgate
1 Razorverge Thicket
1 Reflecting Pool
1 Revel in Riches
1 Rite of Replication
1 Sanctum Weaver
1 Sea Gate
1 Seedborn Muse
1 Selesnya Guildgate
1 Shalai, Voice of Plenty
1 Shiny Impetus
1 Simic Ascendancy
1 Simic Guildgate
1 Sol Ring
1 Soul's Attendant
1 Sphinx's Revelation
1 Sun Titan
1 Sunscorch Regent
1 Supreme Verdict
1 Taurean Mauler
1 Test of Endurance
1 The Eternal Wanderer
1 The World Tree
1 Thornglint Bridge
1 Tireless Tracker
1 Trace of Abundance
1 Tragic Arrogance
1 Triskaidekaphile
1 Twenty-Toed Toad
1 Wooded Bastion
1 Yahenni, Undying Partisan`,
  },
  dsc_death_toll: {
    label: "Death Toll (Winter, Cynical Opportunist)",
    set: "Duskmourn Commander",
    bracket: 2,
    text: `Commander
1 Winter, Cynical Opportunist

Deck
1 Rendmaw, Creaking Nest
1 Deluge of Doom
1 Demonic Covenant
1 Into the Pit
1 Polluted Cistern // Dim Oubliette
1 Demolisher Spawn
1 Formless Genesis
1 Ursine Monstrosity
1 Convert to Slime
1 Moldgraf Monstrosity
1 Culling Ritual
1 Cemetery Tampering
1 Noxious Gearhulk
1 Ob Nixilis Reignited
1 Professor Onyx
1 Reanimate
1 Whip of Erebos
1 Arachnogenesis
1 Deathcap Cultivator
1 Giant Adephage
1 Hornet Queen
1 Inscription of Abundance
1 Ishkanah, Grafwidow
1 Scavenging Ooze
1 Titania, Nature's Force
1 Wrenn and Seven
1 Deadbridge Chant
1 Grim Flayer
1 Grist, the Hunger Tide
1 Old Stickfingers
1 Solemn Simulacrum
1 Dryad Arbor
1 Exotic Orchard
1 Grim Backwoods
1 Llanowar Wastes
1 Necroblossom Snarl
1 Temple of Malady
1 Twilight Mire
1 Viridescent Bog
1 Woodland Cemetery
1 Vile Mutilator
1 Terramorphic Expanse
1 Night's Whisper
1 Grapple with the Past
1 Deathreap Ritual
1 Putrefy
1 Arcane Signet
1 Sol Ring
1 Suspicious Bookcase
1 Command Tower
1 Carrion Grub
1 Stitcher's Supplier
1 Crawling Sensation
1 Gnarlwood Dryad
1 Harmonize
1 Harrow
1 Moldgraf Millipede
1 Mulch
1 Obsessive Skinner
1 Rampant Growth
1 Sakura-Tribe Elder
1 Skola Grovedancer
1 Binding the Old Gods
1 Grisly Salvage
1 Nyx Weaver
1 Burnished Hart
1 Commander's Sphere
1 Golgari Signet
1 Haywire Mite
1 Mind Stone
1 Talisman of Resilience
1 Whispersilk Cloak
1 Ash Barrens
1 Barren Moor
1 Bojuka Bog
1 Darkmoss Bridge
1 Evolving Wilds
1 Golgari Rot Farm
1 Jungle Hollow
1 Reliquary Tower
1 Tainted Wood
1 Temple of the False God
1 Tranquil Thicket
1 Tree of Tales
1 Vault of Whispers
7 Swamp
7 Forest`,
  },
  dsc_endless_punishment: {
    label: "Endless Punishment (Valgavoth, Harrower of Souls)",
    set: "Duskmourn Commander",
    bracket: 2,
    text: `Commander
1 Valgavoth, Harrower of Souls

Deck
1 The Lord of Pain
1 Persistent Constrictor
1 Sadistic Shell Game
1 Suspended Sentence
1 Barbflare Gremlin
1 Gleeful Arsonist
1 Spiked Corridor // Torture Pit
1 Star Athlete
1 Séance Board
1 Bedevil
1 Mogis, God of Slaughter
1 Braids, Arisen Nightmare
1 Decree of Pain
1 Fate Unraveler
1 Kederekt Parasite
1 Mask of Griselbrand
1 Massacre Girl
1 Massacre Wurm
1 Nightshade Harvester
1 Blasphemous Act
1 Brash Taunter
1 Chaos Warp
1 Combustible Gearhulk
1 Enchanter's Bane
1 Harsh Mentor
1 Rampaging Ferocidon
1 Tectonic Giant
1 Florian, Voldaren Scion
1 Kaervek the Merciless
1 Rakdos, Lord of Riots
1 Spiteful Visions
1 Stormfist Crusader
1 Theater of Horrors
1 Vial Smasher the Fierce
1 Basilisk Collar
1 Solemn Simulacrum
1 Blackcleave Cliffs
1 Canyon Slough
1 Dragonskull Summit
1 Exotic Orchard
1 Foreboding Ruins
1 Graven Cairns
1 Shadowblood Ridge
1 Shivan Gorge
1 Smoldering Marsh
1 Spinerock Knoll
1 Sulfurous Springs
1 Temple of Malice
1 Witch's Clinic
1 Fear of Burning Alive
1 Grab the Prize
1 Terramorphic Expanse
1 Blood Pact
1 Blood Seeker
1 Feed the Swarm
1 Arcane Signet
1 Lightning Greaves
1 Sol Ring
1 Command Tower
1 Bastion of Remembrance
1 Blood Artist
1 Falkenrath Noble
1 Gray Merchant of Asphodel
1 Infernal Grasp
1 Morbid Opportunist
1 Sign in Blood
1 Syr Konrad, the Grim
1 Light Up the Stage
1 Kardur, Doomscourge
1 Mayhem Devil
1 Rakdos Charm
1 Fellwar Stone
1 Mind Stone
1 Rakdos Signet
1 Talisman of Indulgence
1 Thought Vessel
1 Ash Barrens
1 Bloodfell Caves
1 Evolving Wilds
1 Geothermal Bog
1 Leechridden Swamp
1 Tainted Peak
1 Temple of the False God
8 Swamp
8 Mountain`,
  },
  dsc_jump_scare: {
    label: "Jump Scare! (Zimone, Mystery Unraveler)",
    set: "Duskmourn Commander",
    bracket: 2,
    text: `Commander
1 Zimone, Mystery Unraveler

Deck
1 Kianne, Corrupted Memory
1 Glitch Interpreter
1 They Came from the Pipes
1 Zimone's Hypothesis
1 Curator Beastie
1 Disorienting Choice
1 Experimental Lab // Staff Room
1 Shriekwood Devourer
1 Giggling Skitterspike
1 Cackling Counterpart
1 Citanul Hierophants
1 Aether Gale
1 Body of Knowledge
1 Dig Through Time
1 Kefnet the Mindful
1 Kheru Spellsnatcher
1 Primordial Mist
1 Skaab Ruinator
1 Ashaya, Soul of the Wild
1 Augur of Autumn
1 Deathmist Raptor
1 Ezuri's Predation
1 Hydra Omnivore
1 Multani, Yavimaya's Avatar
1 Overwhelming Stampede
1 Sandwurm Convergence
1 Scute Swarm
1 Shigeki, Jukai Visionary
1 Temur War Shaman
1 Thunderfoot Baloth
1 Trail of Mystery
1 Whisperwood Elemental
1 Worldspine Wurm
1 Aesi, Tyrant of Gyre Strait
1 Arixmethes, Slumbering Isle
1 Biomass Mutation
1 Oversimplify
1 Rashmi, Eternities Crafter
1 Scroll of Fate
1 Castle Vantress
1 Drownyard Temple
1 Flooded Grove
1 Hinterland Harbor
1 Mosswort Bridge
1 Overflowing Basin
1 Temple of Mystery
1 Vineglimmer Snarl
1 Yavimaya Coast
1 Overgrown Zealot
1 Growing Dread
1 Terramorphic Expanse
1 Beast Within
1 Growth Spiral
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Counterspell
1 Reality Shift
1 Retreat to Coralhelm
1 Beanstalk Giant
1 Cultivate
1 Explosive Vegetation
1 Greater Tanuki
1 Rampant Growth
1 Sakura-Tribe Elder
1 Wilderness Reclamation
1 Yavimaya Elder
1 Yedora, Grave Gardener
1 Eureka Moment
1 Tatyova, Benthic Druid
1 Trygon Predator
1 Simic Signet
1 Ash Barrens
1 Evolving Wilds
1 Myriad Landscape
1 Quandrix Campus
1 Reliquary Tower
1 Simic Growth Chamber
1 Tangled Islet
1 Temple of the False God
1 Thornwood Falls
9 Island
9 Forest`,
  },
  dsc_miracle_worker: {
    label: "Miracle Worker (Aminatou, Veil Piercer)",
    set: "Duskmourn Commander",
    bracket: 2,
    text: `Commander
1 Aminatou, Veil Piercer

Deck
1 The Master of Keys
1 Redress Fate
1 Secret Arcade // Dusty Parlor
1 Soaring Lightbringer
1 Fear of Sleep Paralysis
1 Ancient Cellarspawn
1 Cramped Vents // Access Maze
1 Metamorphosis Fanatic
1 Phenomenon Investigators
1 Mesa Enchantress
1 Terminus
1 Aminatou's Augury
1 Utter End
1 Entreat the Angels
1 Monologue Tax
1 Ondu Spiritdancer
1 Sigil of the Empty Throne
1 Starfield Mystic
1 Timely Ward
1 Verge Rangers
1 Dream Eater
1 Extravagant Replication
1 Mirrormade
1 One with the Multiverse
1 Prognostic Sphinx
1 Shark Typhoon
1 Arvinox, the Mind Flail
1 Demon of Fate's Design
1 Doomwake Giant
1 Nightmare Shepherd
1 Athreos, Shroud-Veiled
1 Inkshield
1 Life Insurance
1 Spirit-Sister's Call
1 Time Wipe
1 Solemn Simulacrum
1 Adarkar Wastes
1 Caves of Koilos
1 Hall of Heliod's Generosity
1 Temple of Deceit
1 Temple of Enlightenment
1 Temple of Silence
1 Underground River
1 Bottomless Pool // Locker Room
1 Terramorphic Expanse
1 Auramancer
1 Swords to Plowshares
1 Moon-Blessed Cleric
1 Ponder
1 Portent
1 Telling Time
1 Diabolic Vision
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Cast Out
1 Return to Dust
1 Sphere of Safety
1 Arcane Denial
1 Archetype of Imagination
1 Brainstorm
1 Otherworldly Gaze
1 Thirst for Meaning
1 The Eldest Reborn
1 Read the Bones
1 Azorius Signet
1 Brainstone
1 Burnished Hart
1 Commander's Sphere
1 Mind Stone
1 Orzhov Signet
1 Arcane Sanctum
1 Ash Barrens
1 Azorius Chancery
1 Bojuka Bog
1 Dimir Aqueduct
1 Evolving Wilds
1 Halimar Depths
1 Obscura Storefront
1 Orzhov Basilica
1 Tainted Field
1 Tainted Isle
1 Thriving Heath
1 Thriving Isle
1 Thriving Moor
5 Plains
4 Island
5 Swamp`,
  },
  m3c_creative_energy: {
    label: "Creative Energy (Satya, Aetherflux Genius)",
    set: "Modern Horizons 3 Commander",
    bracket: 2,
    text: `Commander
1 Satya, Aetherflux Genius

Deck
1 Cayth, Famed Mechanist
1 Sphinx of the Revelation
1 Filigree Racer
1 Localized Destruction
1 Aether Refinery
1 Hourglass of the Lost
1 Salvation Colossus
1 Blaster Hulk
1 Razorfield Ripper
1 Silverquill Lecturer
1 Overclocked Electromancer
1 Stone Idol Generator
1 Aurora Shifter
1 Conversion Apparatus
1 Gonti's Aether Heart
1 Lightning Runner
1 Aethertide Whale
1 Aethergeode Miner
1 Aethersphere Harvester
1 Bident of Thassa
1 Temple of Enlightenment
1 Battlefield Forge
1 Myr Battlesphere
1 Grenzo, Havoc Raiser
1 Brudiclad, Telchor Engineer
1 Coveted Jewel
1 Goldspan Dragon
1 Legion Loyalty
1 Mystic Gate
1 Akroma's Will
1 Adarkar Wastes
1 Shivan Reef
1 Coalition Relic
1 Combustible Gearhulk
1 Aetherworks Marvel
1 Angel of Invention
1 Confiscation Coup
1 Aetherstorm Roc
1 Aethersquall Ancient
1 Frostboil Snarl
1 Austere Command
1 Furycalm Snarl
1 Midnight Clock
1 Professional Face-Breaker
1 Farewell
1 Port Town
1 Temple of Triumph
1 Solemn Simulacrum
1 Temple of Epiphany
1 Prairie Stream
1 Skyclave Apparition
1 Castle Vantress
1 Jolted Awake
1 Bespoke Battlewagon
1 Roil Cartographer
1 Unstable Amulet
1 Amped Raptor
1 Solar Transformer
1 Scurry of Gremlins
1 Izzet Generatorium
1 Talisman of Conviction
1 Tezzeret's Gambit
1 Izzet Boilerworks
1 Azorius Chancery
1 Talisman of Progress
1 Command Tower
1 Burnished Hart
1 Arcane Signet
1 Sol Ring
1 Era of Innovation
1 Aether Hub
1 Decoction Module
1 Glimmer of Genius
1 Whirler Virtuoso
1 Talisman of Creativity
1 Swords to Plowshares
1 Wayfarer's Bauble
1 Demolition Field
1 Mystic Monastery
5 Plains
5 Plains
3 Island
2 Island
3 Mountain
2 Mountain`,
  },
  m3c_eldrazi_incursion: {
    label: "Eldrazi Incursion (Ulalek, Fused Atrocity)",
    set: "Modern Horizons 3 Commander",
    bracket: 2,
    text: `Commander
1 Ulalek, Fused Atrocity

Deck
1 Azlask, the Swelling Scourge
1 Ulamog's Dreadsire
1 Benthic Anomaly
1 Eldritch Immunity
1 Selective Obliteration
1 Angelic Aberration
1 Bismuth Mindrender
1 Hideous Taskmaster
1 Twins of Discord
1 Mutated Cultist
1 Eldrazi Confluence
1 Spawnbed Protector
1 Chittering Dispatcher
1 Inversion Behemoth
1 Ugin, the Ineffable
1 Eldrazi Conscription
1 Cascading Cataracts
1 Eldrazi Monument
1 Sire of Stagnation
1 Shrine of the Forsaken Gods
1 Ugin's Insight
1 Drowner of Hope
1 Return of the Wildspeaker
1 Tendo Ice Bridge
1 Battlefield Forge
1 Llanowar Wastes
1 Brushland
1 Underground River
1 Oblivion Sower
1 Adarkar Wastes
1 Karplusan Forest
1 Yavimaya Coast
1 Sulfurous Springs
1 Caves of Koilos
1 Shivan Reef
1 Imprisoned in the Moon
1 Temple of Malady
1 Temple of Silence
1 Morophon, the Boundless
1 Kozilek's Return
1 World Breaker
1 Ruins of Oran-Rief
1 Sifter of Skulls
1 Endbringer
1 Corrupted Crossroads
1 Deepfathom Skulker
1 Vile Redeemer
1 Eldrazi Displacer
1 Mystic Forge
1 All Is Dust
1 Rishkar's Expertise
1 Awakening Zone
1 Eldrazi Temple
1 Elder Deep-Fiend
1 Bonders' Enclave
1 Exotic Orchard
1 Forsaken Monument
1 Snapping Voidcraw
1 Herald's Horn
1 Everflowing Chalice
1 Glaring Fleshraker
1 Wastescape Battlemage
1 Crib Swap
1 Titans' Vanguard
1 Talisman of Resilience
1 Hedron Archive
1 Spawning Bed
1 Ulamog's Nullifier
1 Twisted Landscape
1 Tranquil Landscape
1 Tectonic Edge
1 Reliquary Tower
1 Sol Ring
1 Artisan of Kozilek
1 Opal Palace
1 Dreamstone Hedron
1 Arcane Signet
1 Tomb of the Spirit Dragon
1 Secluded Courtyard
1 Idol of Oblivion
1 Wastes
1 Talisman of Curiosity
1 Talisman of Impulse
1 Warping Wail
1 Talisman of Dominance
1 Command Tower
1 Ash Barrens
1 Ancient Stirrings
1 Ulamog's Crusher
1 Garruk's Uprising
1 Suffer the Past
1 Skittering Invasion
1 Path of Ancestry
1 Unclaimed Territory
1 Plains
1 Island
1 Swamp
1 Mountain
1 Forest`,
  },
  m3c_tricky_terrain: {
    label: "Tricky Terrain (Omo, Queen of Vesuva)",
    set: "Modern Horizons 3 Commander",
    bracket: 2,
    text: `Commander
1 Omo, Queen of Vesuva

Deck
1 Jyoti, Moag Ancient
1 March from Velis Vel
1 Wonderscape Sage
1 Copy Land
1 Desert Warfare
1 Trenchpost
1 Sage of the Maze
1 Lazotep Quarry
1 Rampant Frogantua
1 Sunken Palace
1 Horizon of Progress
1 Planar Nexus
1 Aggressive Biomancy
1 Talon Gates of Madara
1 Hydroid Krasis
1 Terastodon
1 Lair of the Hydra
1 Nissa, Steward of Elements
1 Magus of the Candelabra
1 Lumbering Falls
1 Blast Zone
1 Apex Devastator
1 Dreamroot Cascade
1 Summary Dismissal
1 Yavimaya Coast
1 Flooded Grove
1 Hour of Promise
1 Ramunap Excavator
1 Hydra Broodmaster
1 Drown in Dreams
1 Vineglimmer Snarl
1 Vivien Reid
1 Yavimaya, Cradle of Growth
1 Dryad of the Ilysian Grove
1 Mirage Mirror
1 Overflowing Basin
1 Temple of Mystery
1 Chromatic Lantern
1 Oblivion Stone
1 Scute Swarm
1 Ulvenwald Hydra
1 Evacuation
1 Replication Technique
1 Finale of Revelation
1 Mana Reflection
1 Uro, Titan of Nature's Wrath
1 Curse of the Swine
1 Vesuva
1 Dark Depths
1 Thespian's Stage
1 Avenger of Zendikar
1 Seer's Sundial
1 Rampaging Baloths
1 Fog Bank
1 Urza's Power Plant
1 Urza's Tower
1 Urza's Mine
1 Satyr Wayfinder
1 Arcane Denial
1 Simic Guildgate
1 Treasure Cruise
1 Sol Ring
1 Basilisk Gate
1 Beast Within
1 Tatyova, Benthic Druid
1 Propaganda
1 Simic Growth Chamber
1 Floriferous Vinewall
1 Arcane Signet
1 Desert of the Indomitable
1 Hashep Oasis
1 Expedition Map
1 Hidden Cataract
1 Hidden Nursery
1 Volatile Fault
1 Growth Spiral
1 Elvish Rejuvenator
1 Urban Evolution
1 Harmonize
1 Thornwood Falls
1 Cloudpost
1 Sylvan Scrying
1 Acidic Slime
1 Pongify
1 Lush Oasis
1 Skullwinder
1 Desert of the Mindful
1 Command Tower
1 Poison Dart Frog
1 Glimmerpost
1 Eureka Moment
1 Quandrix Campus
2 Island
1 Island
2 Forest
2 Forest`,
  },
  pip_hail_caesar: {
    label: "Hail, Caesar (Caesar, Legion's Emperor)",
    set: "Fallout Commander",
    bracket: 2,
    text: `Commander
1 Caesar, Legion's Emperor

Deck
1 Mr. House, President and CEO
1 Aradesh, the Founder
1 Battle of Hoover Dam
1 Overseer of Vault 76
1 Securitron Squadron
1 Sierra, Nuka's Biggest Fan
1 Vault 75: Middle School
1 Yes Man, Personal Securitron
1 V.A.T.S.
1 Wasteland Raider
1 Mysterious Stranger
1 Powder Ganger
1 Rose, Cutthroat Raider
1 Thrill-Kill Disciple
1 Wild Wasteland
1 Boomer Scrapper
1 Colonel Autumn
1 Desdemona, Freedom's Edge
1 Elder Arthur Maxson
1 Kellogg, Dangerous Mind
1 MacCready, Lamplight Mayor
1 The Nipton Lottery
1 Paladin Elizabeth Taggerdy
1 Vault 11: Voter's Dilemma
1 ED-E, Lonesome Eyebot
1 Desolate Mire
1 Diamond City
1 Captain of the Watch
1 Entrapment Maneuver
1 Hour of Reckoning
1 Keeper of the Accord
1 Marshal's Anthem
1 Martial Coup
1 Secure the Wastes
1 Black Market
1 Lethal Scheme
1 Stolen Strategy
1 Anguished Unmaking
1 Assemble the Legion
1 Fervent Charge
1 Ruinous Ultimatum
1 Canyon Slough
1 Clifftop Retreat
1 Dragonskull Summit
1 Isolated Chapel
1 Shadowblood Ridge
1 Smoldering Marsh
1 Temple of Malice
1 Temple of Silence
1 Temple of Triumph
1 Windbrisk Heights
1 Gary Clone
1 Butch DeLoria, Tunnel Snake
1 Ruthless Radrat
1 Craig Boone, Novac Guard
1 Legate Lanius, Caesar's Ace
1 White Glove Gourmand
1 Charisma Bobblehead
1 Luck Bobblehead
1 Survivor's Med Kit
1 Impassioned Orator
1 Intangible Virtue
1 Bastion of Remembrance
1 Deadly Dispute
1 Morbid Opportunist
1 Pitiless Plunderer
1 General's Enforcer
1 Heroic Reinforcements
1 Wear // Tear
1 Arcane Signet
1 Skullclamp
1 Sol Ring
1 Talisman of Conviction
1 Talisman of Hierarchy
1 Talisman of Indulgence
1 Ash Barrens
1 Command Tower
1 Evolving Wilds
1 Memorial to Glory
1 Myriad Landscape
1 Nomad Outpost
1 Path of Ancestry
1 Tainted Field
1 Tainted Peak
1 Terramorphic Expanse
3 Plains
2 Plains
2 Swamp
2 Swamp
3 Mountain
2 Mountain`,
  },
  pip_mutant_menace: {
    label: "Mutant Menace (The Wise Mothman)",
    set: "Fallout Commander",
    bracket: 2,
    text: `Commander
1 The Wise Mothman

Deck
1 The Master, Transcendent
1 Jason Bright, Glowing Prophet
1 Mirelurk Queen
1 Piper Wright, Publick Reporter
1 Radstorm
1 Struggle for Project Purity
1 Feral Ghoul
1 Hancock, Ghoulish Mayor
1 Nuclear Fallout
1 Screeching Scorchbeast
1 Vault 12: The Necropolis
1 Harold and Bob, First Numens
1 Lily Bowen, Raging Grandma
1 Power Fist
1 Rampaging Yao Guai
1 Strong, the Brutish Thespian
1 Tato Farmer
1 Watchful Radstag
1 Agent Frank Horrigan
1 Alpha Deathclaw
1 Atomize
1 Marcus, Mutant Mayor
1 Mutational Advantage
1 Vault 87: Forced Evolution
1 Nuka-Nuke Launcher
1 Recon Craft Theta
1 Mariposa Military Base
1 Overflowing Basin
1 Viridescent Bog
1 Fraying Sanity
1 Inexorable Tide
1 Branching Evolution
1 Guardian Project
1 Hardened Scales
1 Tireless Tracker
1 Biomass Mutation
1 Casualties of War
1 Find // Finality
1 Darkwater Catacombs
1 Drowned Catacomb
1 Exotic Orchard
1 Fetid Pools
1 Hinterland Harbor
1 Nesting Grounds
1 Sunken Hollow
1 Temple of Deceit
1 Temple of Malady
1 Temple of Mystery
1 Woodland Cemetery
1 Vexing Radgull
1 Bloatfly Swarm
1 Infesting Radroach
1 Cathedral Acolyte
1 Glowing One
1 Lumbering Megasloth
1 Contaminated Drink
1 Nightkin Ambusher
1 Raul, Trouble Shooter
1 Young Deathclaws
1 Strength Bobblehead
1 Cultivate
1 Farseek
1 Harmonize
1 Inspiring Call
1 Rampant Growth
1 Corpsejack Menace
1 Putrefy
1 Winding Constrictor
1 Arcane Signet
1 Contagion Clasp
1 Sol Ring
1 Talisman of Curiosity
1 Talisman of Dominance
1 Talisman of Resilience
1 Ash Barrens
1 Command Tower
1 Evolving Wilds
1 Mortuary Mire
1 Opulent Palace
1 Path of Ancestry
1 Tainted Isle
1 Tainted Wood
1 Temple of the False God
1 Terramorphic Expanse
3 Swamp
2 Swamp
3 Forest
2 Forest
3 Island
2 Island`,
  },
  pip_science: {
    label: "Science! (Dr. Madison Li)",
    set: "Fallout Commander",
    bracket: 2,
    text: `Commander
1 Dr. Madison Li

Deck
1 Liberty Prime, Recharged
1 Automated Assembly Line
1 Brotherhood Scribe
1 Overencumbered
1 The Prydwen, Steel Flagship
1 Sentry Bot
1 Vault 13: Dweller's Journey
1 Curie, Emergent Intelligence
1 James, Wandering Dad
1 Nick Valentine, Private Eye
1 Synth Infiltrator
1 Assaultron Dominator
1 The Motherlode, Excavator
1 Plasma Caster
1 Synth Eradicator
1 Arcade Gannon
1 Electrosiphon
1 Red Death, Shipwrecker
1 Rex, Cyber-Hound
1 Sentinel Sarah Lyons
1 Shaun, Father of Synths
1 Vault 112: Sadistic Simulation
1 Brotherhood Vertibird
1 T-45 Power Armor
1 Ferrous Lake
1 HELIOS One
1 Austere Command
1 Open the Vaults
1 Mechanized Production
1 One with the Machine
1 Wake the Past
1 Mystic Forge
1 Panharmonicon
1 Solemn Simulacrum
1 Steel Overseer
1 Clifftop Retreat
1 Exotic Orchard
1 Glacial Fortress
1 Irrigated Farmland
1 Prairie Stream
1 Skycloud Expanse
1 Spire of Industry
1 Sulfur Falls
1 Temple of Enlightenment
1 Temple of Epiphany
1 Treasure Vault
1 Paladin Danse, Steel Maverick
1 Nerd Rage
1 Robobrain War Mind
1 Bottle-Cap Blast
1 Elder Owyn Lyons
1 Behemoth of Vault 0
1 C.A.M.P.
1 Endurance Bobblehead
1 Expert-Level Safe
1 Intelligence Bobblehead
1 Nuka-Cola Vending Machine
1 Crush Contraband
1 Dispatch
1 Swords to Plowshares
1 Glimmer of Genius
1 Thirst for Knowledge
1 Whirler Rogue
1 Loyal Apprentice
1 Unexpected Windfall
1 Arcane Signet
1 Everflowing Chalice
1 Lightning Greaves
1 Mind Stone
1 Sol Ring
1 Talisman of Conviction
1 Talisman of Creativity
1 Talisman of Progress
1 Thought Vessel
1 Wayfarer's Bauble
1 Ash Barrens
1 Buried Ruin
1 Command Tower
1 Evolving Wilds
1 Myriad Landscape
1 Mystic Monastery
1 Path of Ancestry
1 Razortide Bridge
1 Rustvale Bridge
1 Silverbluff Bridge
1 Terramorphic Expanse
3 Island
2 Island
2 Mountain
2 Mountain
2 Plains
2 Plains`,
  },
  pip_scrappy_survivors: {
    label: "Scrappy Survivors (Dogmeat, Ever Loyal)",
    set: "Fallout Commander",
    bracket: 2,
    text: `Commander
1 Dogmeat, Ever Loyal

Deck
1 Preston Garvey, Minuteman
1 Codsworth, Handy Helper
1 Idolized
1 Pre-War Formalwear
1 Vault 101: Birthday Party
1 Duchess, Wayward Tavernkeep
1 Grim Reaper's Sprint
1 Junk Jet
1 Megaton's Fate
1 Vault 21: House Gambit
1 Veronica, Dissident Scribe
1 Animal Friend
1 Strong Back
1 Almost Perfect
1 Armory Paladin
1 Cait, Cage Brawler
1 Cass, Hand of Vengeance
1 Inventory Management
1 Moira Brown, Guide Author
1 Three Dog, Galaxy News DJ
1 Mister Gutsy
1 Pip-Boy 3000
1 Junktown
1 Sunscorched Divide
1 Mantle of the Ancients
1 Puresteel Paladin
1 Single Combat
1 Blasphemous Act
1 Chaos Warp
1 Heroic Intervention
1 Basilisk Collar
1 Bloodforged Battle-Axe
1 Champion's Helm
1 Masterwork of Ingenuity
1 Canopy Vista
1 Cinder Glade
1 Clifftop Retreat
1 Exotic Orchard
1 Mossfire Valley
1 Rootbound Crag
1 Scattered Groves
1 Scavenger Grounds
1 Sheltered Thicket
1 Sungrass Prairie
1 Sunpetal Grove
1 Temple of Abandon
1 Temple of Plenty
1 Temple of Triumph
1 Brotherhood Outcast
1 Commander Sofia Daguerre
1 Acquired Mutation
1 Crimson Caravaneer
1 Ian the Reckless
1 Bighorner Rancher
1 Break Down
1 Gunner Conscript
1 Super Mutant Scavenger
1 Well Rested
1 Agility Bobblehead
1 Perception Bobblehead
1 Silver Shroud Costume
1 All That Glitters
1 Path to Exile
1 Valorous Stance
1 Sticky Fingers
1 Abundant Growth
1 Fertile Ground
1 Rancor
1 Squirrel Nest
1 Wild Growth
1 Behemoth Sledge
1 Arcane Signet
1 Brass Knuckles
1 Explorer's Scope
1 Fireshrieker
1 Sol Ring
1 Swiftfoot Boots
1 Ash Barrens
1 Buried Ruin
1 Command Tower
1 Evolving Wilds
1 Jungle Shrine
1 Path of Ancestry
1 Roadside Reliquary
1 Rogue's Passage
1 Temple of the False God
1 Terramorphic Expanse
2 Mountain
2 Mountain
2 Forest
2 Forest
2 Plains
2 Plains`,
  },
  sld_raining_cats_and_dogs: {
    label: "Raining Cats and Dogs (Rin and Seri, Inseparable)",
    set: "Secret Lair Commander",
    bracket: 2,
    text: `Commander
1 Rin and Seri, Inseparable

Deck
1 Jetmir, Nexus of Revels
1 Jinnie Fay, Jetmir's Second
1 Anointed Procession
1 Sol Ring
1 Alms Collector
1 Highcliff Felidar
1 Kitt Kanto, Mayhem Diva
1 Brimaz, King of Oreskos
1 Stalking Leonin
1 Cast Out
1 Phabine, Boss's Confidant
1 Crib Swap
1 Path to Exile
1 King of the Pride
1 Felidar Retreat
1 White Sun's Zenith
1 Komainu Battle Armor
1 Skyhunter Strike Force
1 Whitemane Lion
1 Loyal Warhound
1 Regal Caracal
1 Lion Sash
1 Pack Leader
1 Tocasia's Welcome
1 Hungry Lynx
1 Seht's Tiger
1 Mirror Entity
1 Qasali Slingers
1 Spirited Companion
1 Marisi, Breaker of the Coil
1 Jungle Shrine
1 Cursed Mirror
1 Herald's Horn
1 Path of Ancestry
1 Oreskos Explorer
1 Jazal Goldmane
1 Fleetfoot Panther
1 Taurean Mauler
1 Krosan Verge
1 Impact Tremors
1 Temur Sabertooth
1 Exotic Orchard
1 Nacatl War-Pride
1 Warp World
1 Arcane Signet
1 Beastmaster Ascension
1 Keeper of Fables
1 Nature's Lore
1 Command Tower
1 Return of the Wildspeaker
1 Feline Sovereign
1 Masked Vandal
1 Realmwalker
1 Greater Tanuki
1 Lurking Predators
1 Rootbound Crag
1 Sunpetal Grove
1 Showdown of the Skalds
1 Basilisk Collar
1 Oketra's Monument
1 Canopy Vista
1 Cinder Glade
1 Bloodline Pretender
1 Clifftop Retreat
1 Maskwood Nexus
1 Animal Sanctuary
1 Scattered Groves
1 Sheltered Thicket
1 Jetmir's Garden
1 Skullclamp
1 Vanquisher's Banner
1 Three Visits
1 Cultivate
1 Farseek
1 Fortified Village
1 Game Trail
1 Dusk // Dawn
10 Plains
5 Mountain
7 Forest`,
  },
  lcc_ahoy_mateys: {
    label: "Ahoy Mateys (Admiral Brass, Unsinkable)",
    set: "The Lost Caverns of Ixalan Commander",
    bracket: 2,
    text: `Commander
1 Admiral Brass, Unsinkable

Deck
1 Don Andres, the Renegade
1 The Indomitable
1 Storm Fleet Negotiator
1 Francisco, Fowl Marauder
1 The Grim Captain's Locker
1 Skeleton Crew
1 Broadside Bombardiers
1 Gemcutter Buccaneer
1 Arm-Mounted Anchor
1 Amphin Mutineer
1 Bident of Thassa
1 Corsair Captain
1 Evacuation
1 Timestream Navigator
1 Warkite Marauder
1 Black Market Connections
1 Blood Money
1 Dire Fleet Ravager
1 Fathom Fleet Captain
1 Lethal Scheme
1 Angrath's Marauders
1 Blasphemous Act
1 Captain Lannery Storm
1 Captivating Crew
1 Chaos Warp
1 Coercive Recruiter
1 Dire Fleet Daredevil
1 Kari Zev, Skyship Raider
1 Port Razer
1 Shared Animosity
1 Admiral Beckett Brass
1 Hostage Taker
1 King Narfi's Betrayal
1 Prismari Command
1 Zara, Renegade Recruiter
1 Icon of Ancestry
1 Vanquisher's Banner
1 Choked Estuary
1 Desolate Lighthouse
1 Exotic Orchard
1 Foreboding Ruins
1 Frostboil Snarl
1 Geier Reach Sanitarium
1 Nephalia Drownyard
1 Smoldering Marsh
1 Sulfur Falls
1 Sunken Hollow
1 Azure Fleet Admiral
1 Enterprising Scallywag
1 Daring Saboteur
1 Departed Deckhand
1 Distant Melody
1 Ghost of Ramirez DePietro
1 Malcolm, Keen-Eyed Navigator
1 Merchant Raiders
1 Siren Stormtamer
1 Spectral Sailor
1 Windfall
1 Feed the Swarm
1 Pitiless Plunderer
1 Breeches, Brazen Plunderer
1 Faithless Looting
1 Rakdos Charm
1 Ramirez DePietro, Pillager
1 Arcane Signet
1 Commander's Sphere
1 Dimir Signet
1 Herald's Horn
1 Izzet Signet
1 Rakdos Signet
1 Sol Ring
1 Wayfarer's Bauble
1 Command Tower
1 Crumbling Necropolis
1 Evolving Wilds
1 Path of Ancestry
1 Port of Karfell
1 Rogue's Passage
1 Secluded Courtyard
1 Terramorphic Expanse
1 Thriving Bluff
1 Thriving Isle
1 Thriving Moor
1 Unclaimed Territory
6 Island
4 Swamp
5 Mountain`,
  },
  lcc_blood_rites: {
    label: "Blood Rites (Clavileño, First of the Blessed)",
    set: "The Lost Caverns of Ixalan Commander",
    bracket: 2,
    text: `Commander
1 Clavileño, First of the Blessed

Deck
1 Carmen, Cruel Skymarcher
1 Charismatic Conqueror
1 Elenda's Hierophant
1 March of the Canonized
1 Redemption Choir
1 Dusk Legion Sergeant
1 Master of Dark Rites
1 Promise of Aclazotz
1 Order of Sacred Dusk
1 Austere Command
1 Kindred Boon
1 Mavren Fein, Dusk Apostle
1 Radiant Destiny
1 Welcoming Vampire
1 Bloodghast
1 Bloodtracker
1 Butcher of Malakir
1 Champion of Dusk
1 Cordial Vampire
1 Crossway Troublemakers
1 Damn
1 Drana, Liberator of Malakir
1 Exquisite Blood
1 Glass-Cast Heart
1 New Blood
1 Nighthawk Scavenger
1 Olivia's Wrath
1 Pact of the Serpent
1 Patron of the Vein
1 Sanctum Seeker
1 Timothar, Baron of Bats
1 Twilight Prophet
1 Yahenni, Undying Partisan
1 Elenda, the Dusk Rose
1 Sorin, Lord of Innistrad
1 Utter End
1 Vona, Butcher of Magan
1 Blade of the Bloodchief
1 Isolated Chapel
1 Shineshadow Snarl
1 Temple of Silence
1 Vault of the Archangel
1 Voldaren Estate
1 Windbrisk Heights
1 Martyr of Dusk
1 Return to Dust
1 Swords to Plowshares
1 Blood Artist
1 Bloodline Necromancer
1 Dusk Legion Zealot
1 Falkenrath Noble
1 Indulgent Aristocrat
1 Oathsworn Vampire
1 Village Rites
1 Viscera Seer
1 Bartolomé del Presidio
1 Cruel Celebrant
1 Etchings of the Chosen
1 Legion Lieutenant
1 Arcane Signet
1 Commander's Sphere
1 Heirloom Blade
1 Mind Stone
1 Orzhov Signet
1 Sol Ring
1 Swiftfoot Boots
1 Talisman of Hierarchy
1 Wayfarer's Bauble
1 Bojuka Bog
1 Command Tower
1 Myriad Landscape
1 Orzhov Basilica
1 Path of Ancestry
1 Rogue's Passage
1 Secluded Courtyard
1 Tainted Field
1 Temple of the False God
1 Unclaimed Territory
8 Plains
13 Swamp`,
  },
  lcc_explorers_of_the_deep: {
    label: "Explorers of the Deep (Hakbal of the Surging Soul)",
    set: "The Lost Caverns of Ixalan Commander",
    bracket: 2,
    text: `Commander
1 Hakbal of the Surging Soul

Deck
1 Xolatoyac, the Smiling Flood
1 Mist Dancer
1 Ripples of Potential
1 Wave Goodbye
1 Bygone Marvels
1 Deeproot Historian
1 Topography Tracker
1 Tributary Instructor
1 Singer of Swift Rivers
1 Benthic Biomancer
1 Commit // Memory
1 Coralhelm Commander
1 Curse of the Swine
1 Emperor Mihail II
1 Herald of Secret Streams
1 Kindred Discovery
1 Kopala, Warden of Waves
1 Master of the Pearl Trident
1 Merfolk Sovereign
1 Reflections of Littjara
1 Seafloor Oracle
1 Surgespanner
1 Svyelun of Sea and Sky
1 Thassa, God of the Sea
1 Thieving Skydiver
1 Branching Evolution
1 Deeproot Elite
1 Hardened Scales
1 Realmwalker
1 Ruinous Intrusion
1 Cold-Eyed Selkie
1 Kumena, Tyrant of Orazca
1 Prime Speaker Zegana
1 Quandrix Command
1 Simic Ascendancy
1 Tishana, Voice of Thunder
1 Vorel of the Hull Clade
1 Zegana, Utopian Speaker
1 Metallic Mimic
1 Alchemist's Refuge
1 Hinterland Harbor
1 Karn's Bastion
1 Mosswort Bridge
1 Temple of Mystery
1 Vineglimmer Snarl
1 Merfolk Cave-Diver
1 Aetherize
1 Deeproot Waters
1 Merrow Reejerey
1 Rapid Hybridization
1 Ravenform
1 Sage of Fables
1 Stonybrook Banneret
1 Beast Within
1 Nicanzil, Current Conductor
1 Evolution Sage
1 Explore
1 Inspiring Call
1 Kodama's Reach
1 Growth Spiral
1 Kiora's Follower
1 Merfolk Mistbinder
1 Merfolk Skydiver
1 Tatyova, Benthic Druid
1 Arcane Signet
1 Commander's Sphere
1 Simic Signet
1 Sol Ring
1 Swiftfoot Boots
1 Command Tower
1 Llanowar Reborn
1 Myriad Landscape
1 Path of Ancestry
1 Reliquary Tower
1 Rogue's Passage
1 Secluded Courtyard
1 Simic Growth Chamber
1 Temple of the False God
1 Unclaimed Territory
7 Forest
13 Island`,
  },
  lcc_veloci_ramp_tor: {
    label: "Veloci-Ramp-Tor (Pantlaza, Sun-Favored)",
    set: "The Lost Caverns of Ixalan Commander",
    bracket: 2,
    text: `Commander
1 Pantlaza, Sun-Favored

Deck
1 Wayta, Trainer Prodigy
1 Bronzebeak Foragers
1 From the Rubble
1 Wrathful Raptors
1 Curious Altisaur
1 Dinosaur Egg
1 Scion of Calamity
1 Sunfrill Imitator
1 Progenitor's Icon
1 Akroma's Will
1 Kinjalli's Sunwing
1 Temple Altisaur
1 Wakening Sun's Avatar
1 Zetalpa, Primal Dawn
1 Chandra's Ignition
1 Etali, Primal Storm
1 Fiery Confluence
1 Marauding Raptor
1 Apex Altisaur
1 Deathgorge Scavenger
1 Descendants' Path
1 Rampaging Brontodon
1 Regal Behemoth
1 Return of the Wildspeaker
1 Ripjaw Raptor
1 Rishkar's Expertise
1 Runic Armasaur
1 Shifting Ceratops
1 Topiary Stomper
1 Verdant Sun's Avatar
1 Wayward Swordtooth
1 Quartzwood Crasher
1 Regisaur Alpha
1 Xenagos, God of Revels
1 Zacama, Primal Calamity
1 Lifecrafter's Bestiary
1 Arch of Orazca
1 Canopy Vista
1 Cinder Glade
1 Clifftop Retreat
1 Exotic Orchard
1 Fortified Village
1 Furycalm Snarl
1 Game Trail
1 Kessig Wolf Run
1 Mosswort Bridge
1 Bellowing Aegisaur
1 Generous Gift
1 Majestic Heliopterus
1 Path to Exile
1 Earthshaker Dreadmaw
1 Ixalli's Lorekeeper
1 Thrashing Brontodon
1 Otepec Huntmaster
1 Itzquinth, Firstborn of Gishath
1 Cultivate
1 Drover of the Mighty
1 Farseek
1 Migration Path
1 Rampant Growth
1 Ranging Raptors
1 Savage Stomp
1 Thunderherd Migration
1 Thundering Spineback
1 Atzocan Seer
1 Raging Regisaur
1 Raging Swordtooth
1 Rhythm of the Wild
1 Arcane Signet
1 Sol Ring
1 Command Tower
1 Evolving Wilds
1 Jungle Shrine
1 Myriad Landscape
1 Path of Ancestry
1 Rogue's Passage
1 Secluded Courtyard
1 Temple of the False God
1 Terramorphic Expanse
1 Thriving Bluff
1 Thriving Grove
1 Thriving Heath
1 Unclaimed Territory
8 Forest
4 Plains
4 Mountain`,
  },
  who_blast_from_the_past: {
    label: "Blast from the Past (The Fourth Doctor & Sarah Jane Smith)",
    set: "Doctor Who Commander",
    bracket: 2,
    text: `Commander
1 The Fourth Doctor
1 Sarah Jane Smith

Deck
1 Romana II
1 Jo Grant
1 Tegan Jovanka
1 Barbara Wright
1 Ian Chesterton
1 Peri Brown
1 Crisis of Conscience
1 The Caves of Androzani
1 The War Games
1 Trial of a Time Lord
1 The Night of the Doctor
1 Traverse Eternity
1 K-9, Mark I
1 Adric, Mathematical Genius
1 Nyssa of Traken
1 Reverse the Polarity
1 Five Hundred Year Diary
1 An Unearthly Child
1 Leela, Sevateem Warrior
1 Ace, Fearless Rebel
1 Susan Foreman
1 The Five Doctors
1 Jamie McCrimmon
1 The Sea Devils
1 City of Death
1 Gallifrey Stands
1 Alistair, the Brigadier
1 The First Doctor
1 The Second Doctor
1 The Third Doctor
1 The Fifth Doctor
1 The Sixth Doctor
1 The Seventh Doctor
1 The Eighth Doctor
1 Vrestin, Menoptra Leader
1 Sergeant John Benton
1 The Curse of Fenric
1 Duggan, Private Detective
1 Bessie, the Doctor's Roadster
1 Ace's Baseball Bat
1 Gallifrey Council Chamber
1 Day of Destiny
1 Heroic Intervention
1 Time Wipe
1 Heroes' Podium
1 Trenzalore Clocktower
1 Twice Upon a Time
1 Port Town
1 Exotic Orchard
1 Temple of Enlightenment
1 Fortified Village
1 Prairie Stream
1 Canopy Vista
1 Sungrass Prairie
1 Temple of Plenty
1 Irrigated Farmland
1 Temple of Mystery
1 Vineglimmer Snarl
1 Scattered Groves
1 Celestial Colonnade
1 Deserted Beach
1 Glacial Fortress
1 Horizon Canopy
1 Overgrown Farmland
1 Waterlogged Grove
1 Dreamroot Cascade
1 Skycloud Expanse
1 Banish to Another Universe
1 Time Lord Regeneration
1 Displaced Dinosaurs
1 Sonic Screwdriver
1 TARDIS
1 Swords to Plowshares
1 Path to Exile
1 Return to Dust
1 Explore
1 Three Visits
1 Arcane Signet
1 Sol Ring
1 Talisman of Unity
1 Hero's Blade
1 Talisman of Progress
1 Thought Vessel
1 Mind Stone
1 Thriving Isle
1 Thriving Grove
1 Thriving Heath
1 Ash Barrens
1 Seaside Citadel
1 Command Tower
1 Path of Ancestry
2 Plains
2 Island
3 Forest`,
  },
  who_paradox_power: {
    label: "Paradox Power (The Thirteenth Doctor & Yasmin Khan)",
    set: "Doctor Who Commander",
    bracket: 2,
    text: `Commander
1 The Thirteenth Doctor
1 Yasmin Khan

Deck
1 Danny Pink
1 Osgood, Operation Double
1 Twice Upon a Time
1 Become the Pilot
1 Quantum Misalignment
1 Nardole, Resourceful Cyborg
1 Flatline
1 Bill Potts
1 Into the Time Vortex
1 Dan Lewis
1 Flaming Tyrannosaurus
1 Ryan Sinclair
1 Return the Past
1 Impending Flux
1 The Flux
1 Sisterhood of Karn
1 Graham O'Brien
1 Karvanista, Loyal Lupari
1 The Foretold Soldier
1 Fugitive of the Judoon
1 River Song
1 Madame Vastra
1 Jenny Flint
1 Strax, Sontaran Nurse
1 The Twelfth Doctor
1 The Fugitive Doctor
1 Me, the Immortal
1 Frost Fair Lure Fish
1 Lunar Hatchling
1 Heaven Sent
1 Last Night Together
1 River Song's Diary
1 Confession Dial
1 Clara Oswald
1 Chaos Warp
1 Cursed Mirror
1 Carpet of Flowers
1 Dreamroot Cascade
1 Temple of Mystery
1 Vineglimmer Snarl
1 Waterlogged Grove
1 Desolate Lighthouse
1 Rockfall Vale
1 Rootbound Crag
1 Temple of Abandon
1 Cinder Glade
1 Sheltered Thicket
1 Temple of Epiphany
1 Frostboil Snarl
1 Stormcarved Coast
1 Fiery Islet
1 Game Trail
1 Exotic Orchard
1 Gallifrey Council Chamber
1 Psychic Paper
1 TARDIS
1 Sonic Screwdriver
1 Start the TARDIS
1 Surge of Brilliance
1 Iraxxa, Empress of Mars
1 Memory Worm
1 Decaying Time Loop
1 Thijarian Witness
1 Truth or Consequences
1 Bigger on the Inside
1 Wreck and Rebuild
1 Arcane Signet
1 Sol Ring
1 Ponder
1 Think Twice
1 Preordain
1 Throes of Chaos
1 Cultivate
1 Search for Tomorrow
1 Farseek
1 Beast Within
1 Growth Spiral
1 Talisman of Curiosity
1 Talisman of Impulse
1 Rogue's Passage
1 Frontier Bivouac
1 Reliquary Tower
1 Myriad Landscape
1 Temple of the False God
1 Path of Ancestry
1 Command Tower
1 Ominous Cemetery
4 Island
3 Mountain
4 Forest`,
  },
  who_timey_wimey: {
    label: "Timey-Wimey (The Tenth Doctor & Rose Tyler)",
    set: "Doctor Who Commander",
    bracket: 2,
    text: `Commander
1 The Tenth Doctor
1 Rose Tyler

Deck
1 Wilfred Mott
1 Everybody Lives!
1 Everything Comes to Dust
1 Four Knocks
1 The Pandorica
1 The Wedding of River Song
1 Adipose Offspring
1 Astrid Peth
1 Crack in Time
1 The Girl in the Fireplace
1 Martha Jones
1 Nanogene Conversion
1 Flesh Duplicate
1 The Eleventh Hour
1 All of History, All at Once
1 Donna Noble
1 Amy Pond
1 Ecstatic Beauty
1 RMS Titanic
1 Coward // Killer
1 The Parting of the Ways
1 The Ninth Doctor
1 Sally Sparrow
1 Jenny, Generated Anomaly
1 Rory Williams
1 The Eleventh Doctor
1 The War Doctor
1 Regenerations Restored
1 Idris, Soul of the TARDIS
1 The Face of Boe
1 Run for Your Life
1 The Day of the Doctor
1 Gallifrey Falls // No More
1 Dinosaurs on a Spaceship
1 Kate Stewart
1 Rotating Fireplace
1 The Moment
1 Trenzalore Clocktower
1 Grasp of Fate
1 Farewell
1 Out of Time
1 Wedding Ring
1 Inspiring Refrain
1 As Foretold
1 Fractured Identity
1 Port Town
1 Temple of Triumph
1 Exotic Orchard
1 Temple of Enlightenment
1 Prairie Stream
1 Irrigated Farmland
1 Deserted Beach
1 Glacial Fortress
1 Skycloud Expanse
1 Temple of Epiphany
1 Frostboil Snarl
1 Thespian's Stage
1 Furycalm Snarl
1 War Room
1 Sunbaked Canyon
1 Sundown Pass
1 Stormcarved Coast
1 Fiery Islet
1 Atraxi Warden
1 Wibbly-wobbly, Timey-wimey
1 Time Beetle
1 Star Whale
1 Sibylline Soothsayer
1 Judoon Enforcers
1 Psychic Paper
1 TARDIS
1 Sonic Screwdriver
1 Arcane Signet
1 Sol Ring
1 Clockspinning
1 Thought Vessel
1 Mind Stone
1 Talisman of Creativity
1 Lightning Greaves
1 Talisman of Conviction
1 Evolving Wilds
1 Command Tower
1 Path of Ancestry
1 Temple of the False God
1 Myriad Landscape
1 Thriving Bluff
1 Mystic Monastery
1 Ominous Cemetery
1 Rogue's Passage
3 Plains
3 Island
3 Mountain`,
  },
  woc_fae_dominion: {
    label: "Fae Dominion (Tegwyll, Duke of Splendor)",
    set: "Wilds of Eldraine Commander",
    bracket: 2,
    text: `Commander
1 Tegwyll, Duke of Splendor

Deck
1 Alela, Cunning Conqueror
1 Archmage of Echoes
1 Malleable Impostor
1 Misleading Signpost
1 Shadow Puppeteers
1 Blightwing Bandit
1 Faerie Bladecrafter
1 Nettling Nuisance
1 Tegwyll's Scouring
1 Brazen Borrower
1 Dig Through Time
1 Faerie Formation
1 Glen Elendra Archmage
1 Hullbreaker Horror
1 Illusionist's Gambit
1 Midnight Clock
1 Perplexing Test
1 Reflections of Littjara
1 Scion of Oona
1 Sower of Temptation
1 Theoretical Duplication
1 Kindred Dominance
1 Nightmare Unmaking
1 Puppeteer Clique
1 Rankle, Master of Pranks
1 Thrilling Encore
1 Glen Elendra Liege
1 Nymris, Oona's Trickster
1 Oona, Queen of the Fae
1 Choked Estuary
1 Darkwater Catacombs
1 Exotic Orchard
1 Secluded Glen
1 Sunken Hollow
1 Temple of Deceit
1 Mocking Sprite
1 Picklock Prankster
1 Spell Stutter
1 Obyra, Dreaming Duelist
1 Spellscorn Coven
1 Arcane Denial
1 Cloud of Faeries
1 Consider
1 Distant Melody
1 Fact or Fiction
1 Faerie Seer
1 Frantic Search
1 Hypnotic Sprite
1 Keep Watch
1 Nightveil Sprite
1 Opt
1 Quickling
1 Reality Shift
1 Reconnaissance Mission
1 Repulse
1 Run Away Together
1 Snap
1 Reckless Spite
1 Halo Forager
1 Arcane Signet
1 Dimir Signet
1 Fellwar Stone
1 Mind Stone
1 Sol Ring
1 Talisman of Dominance
1 Wayfarer's Bauble
1 Bojuka Bog
1 Command Tower
1 Dimir Aqueduct
1 Faerie Conclave
1 Myriad Landscape
1 Path of Ancestry
1 Tainted Isle
1 Temple of the False God
13 Island
12 Swamp`,
  },
  sld_angels_they_re_just_like: {
    label: "Angels: They're Just Like Us but Cooler and with Wings (Gisela, the Broken Blade)",
    set: "Secret Lair Commander",
    bracket: 2,
    text: `Commander
1 Gisela, the Broken Blade

Deck
1 Bruna, the Fading Light
1 Ajani, Strength of the Pride
1 Angel of Destiny
1 Angel of Finality
1 Angel of Serenity
1 Angel of the Ruins
1 Angel of Vitality
1 Angelic Accord
1 Angelic Field Marshal
1 Arcane Signet
1 Arch of Orazca
1 Archangel of Thune
1 Archangel of Tithes
1 Arden Angel
1 Austere Command
1 Bishop of Wings
1 Bonders' Enclave
1 Breathkeeper Seraph
1 Cleansing Nova
1 Commander's Plate
1 Cosmos Elixir
1 Court of Grace
1 Dawn of Hope
1 Dawnbreak Reclaimer
1 Dismantling Wave
1 Emeria Shepherd
1 Emeria, the Sky Ruin
1 Endless Atlas
1 Entreat the Angels
1 Everflowing Chalice
1 Giada, Font of Hope
1 Griffin Aerie
1 Heirloom Blade
1 Invoke the Divine
1 Karoo
1 Keeper of the Accord
1 Kindred Boon
1 Lightning Greaves
1 Marble Diamond
1 Mazemind Tome
1 Mind Stone
1 Myriad Landscape
1 Nykthos Paragon
1 Nykthos, Shrine to Nyx
1 Oketra's Monument
1 Path of Ancestry
1 Path to Exile
1 Pearl Medallion
8 Plains
8 Plains
7 Plains
7 Plains
1 Righteous Valkyrie
1 Search for Glory
1 Sephara, Sky's Blade
1 Seraph Sanctuary
1 Serra Ascendant
1 Shattered Angel
1 Sol Ring
1 Speaker of the Heavens
1 Starnheim Aspirant
1 Sunblast Angel
1 Swiftfoot Boots
1 Sword of the Animist
1 Swords to Plowshares
1 Thalia's Lancers
1 The Book of Exalted Deeds
1 Tome of Legends
1 Urza's Incubator
1 Valkyrie Harbinger
1 Vanquisher's Banner
1 War Room
1 Well of Lost Dreams`,
  },
  cmm_eldrazi_unbound: {
    label: "Eldrazi Unbound (Zhulodok, Void Gorger)",
    set: "Commander Masters",
    bracket: 2,
    text: `Commander
1 Zhulodok, Void Gorger

Deck
1 Omarthis, Ghostfire Initiate
1 Kozilek, the Great Distortion
1 Abstruse Archaic
1 Calamity of the Titans
1 Desecrate Reality
1 Flayer of Loyalties
1 Rise of the Eldrazi
1 Skittering Cicada
1 Ugin's Mastery
1 Darksteel Monolith
1 All Is Dust
1 Endbringer
1 Endless One
1 It That Betrays
1 Matter Reshaper
1 Oblivion Sower
1 Ugin, the Ineffable
1 Ancient Stone Idol
1 Duplicant
1 Endless Atlas
1 Forsaken Monument
1 Hangarback Walker
1 Investigator's Journal
1 Kaldra Compleat
1 Mazemind Tome
1 Metalwork Colossus
1 Mirage Mirror
1 Myriad Construct
1 Mystic Forge
1 Perilous Vault
1 Phyrexian Triniform
1 Solemn Simulacrum
1 Soul of New Phyrexia
1 Steel Hellkite
1 Stonecoil Serpent
1 Transmogrifying Wand
1 Arch of Orazca
1 Blast Zone
1 Bonders' Enclave
1 Geier Reach Sanitarium
1 Mirrorpool
1 Ruins of Oran-Rief
1 Scavenger Grounds
1 Sea Gate Wreckage
1 Shrine of the Forsaken Gods
1 Tyrite Sanctum
1 War Room
1 Burnished Hart
1 Geode Golem
1 Lightning Greaves
1 Meteor Golem
1 Sol Ring
1 Thought Vessel
1 Thran Dynamo
1 Unstable Obelisk
1 Reliquary Tower
1 Rogue's Passage
1 Artisan of Kozilek
1 Bane of Bala Ged
1 Not of This World
1 Spatial Contortion
1 Titan's Presence
1 Warping Wail
1 Crashing Drawbridge
1 Dreamstone Hedron
1 Everflowing Chalice
1 Fireshrieker
1 Hedron Archive
1 Mind Stone
1 Ornithopter of Paradise
1 Palladium Myr
1 Scaretiller
1 Suspicious Bookcase
1 Worn Powerstone
1 Arcane Lighthouse
1 Eldrazi Temple
1 Forge of Heroes
1 Guildless Commons
1 Mage-Ring Network
1 Temple of the False God
1 Tomb of the Spirit Dragon
1 Urza's Mine
1 Urza's Power Plant
1 Urza's Tower
8 Wastes
7 Wastes`,
  },
  cmm_enduring_enchantments: {
    label: "Enduring Enchantments (Anikthea, Hand of Erebos)",
    set: "Commander Masters",
    bracket: 2,
    text: `Commander
1 Anikthea, Hand of Erebos

Deck
1 Narci, Fable Singer
1 Battle at the Helvault
1 Boon of the Spirit Realm
1 Ondu Spiritdancer
1 Cacophony Unleashed
1 Demon of Fate's Design
1 Ghoulish Impetus
1 Composer of Spring
1 Nyxborn Behemoth
1 Archon of Sun's Grace
1 Felidar Retreat
1 Grasp of Fate
1 Heliod, God of the Sun
1 Mesa Enchantress
1 Sigil of the Empty Throne
1 Starfield Mystic
1 Starfield of Nyx
1 Cunning Rhetoric
1 Doomwake Giant
1 Dreadhorde Invasion
1 Erebos, Bleak-Hearted
1 Abundance
1 Arasta of the Endless Web
1 Courser of Kruphix
1 Dryad of the Ilysian Grove
1 Eidolon of Blossoms
1 Enchantress's Presence
1 Herald of the Pantheon
1 The Mending of Dominaria
1 Sanctum Weaver
1 Sandwurm Convergence
1 Setessan Champion
1 Verduran Enchantress
1 Battle for Bretagard
1 Calix, Destiny's Hand
1 Culling Ritual
1 Mirari's Wake
1 Sythis, Harvest's Hand
1 Canopy Vista
1 Exotic Orchard
1 Fortified Village
1 Necroblossom Snarl
1 Shineshadow Snarl
1 Sungrass Prairie
1 Temple of Malady
1 Temple of Plenty
1 Temple of Silence
1 Path to Exile
1 Extinguish All Hope
1 Kodama's Reach
1 Arcane Signet
1 Sol Ring
1 Ash Barrens
1 Command Tower
1 Cast Out
1 Love Song of Night and Day
1 Omen of the Sun
1 Spirited Companion
1 The Eldest Reborn
1 Mindwrack Harpy
1 The Binding of the Titans
1 Destiny Spinner
1 Farseek
1 Font of Fertility
1 Greater Tanuki
1 Khalni Heart Expedition
1 Nessian Wanderer
1 Omen of the Hunt
1 Rampant Growth
1 Binding the Old Gods
1 Jukai Naturalist
1 Nyx Weaver
1 Satyr Enchanter
1 Golgari Rot Farm
1 Krosan Verge
1 Orzhov Basilica
1 Sandsteppe Citadel
1 Selesnya Sanctuary
1 Tainted Field
1 Tainted Wood
3 Plains
3 Plains
3 Swamp
2 Swamp
4 Forest
4 Forest`,
  },
  cmm_planeswalker_party: {
    label: "Planeswalker Party (Commodore Guff)",
    set: "Commander Masters",
    bracket: 2,
    text: `Commander
1 Commodore Guff

Deck
1 Leori, Sparktouched Hunter
1 Mangara, the Diplomat
1 Gatewatch Beacon
1 Onakke Oathkeeper
1 Teyo, Geometric Tactician
1 Sparkshaper Visionary
1 Vronos, Masked Inquisitor
1 Chandra, Legacy of Fire
1 Guff Rewrites History
1 Jaya's Phoenix
1 Ajani Steadfast
1 Deploy the Gatewatch
1 Elspeth, Sun's Champion
1 Gideon Jura
1 Norn's Annex
1 Oath of Gideon
1 Promise of Loyalty
1 Semester's End
1 Urza's Ruinous Blast
1 Deepglow Skate
1 Jace Beleren
1 Jace, Architect of Thought
1 Jace, Mirror Mage
1 Oath of Jace
1 Spark Double
1 Blasphemous Act
1 Chandra, Awakened Inferno
1 Chandra, Torch of Defiance
1 Repeated Reverberation
1 Sarkhan the Masterless
1 Nahiri, the Harbinger
1 Narset of the Ancient Way
1 Narset, Enlightened Master
1 Oath of Teferi
1 The Chain Veil
1 Nevinyrral's Disk
1 Silent Arbiter
1 Cascade Bluffs
1 Exotic Orchard
1 Frostboil Snarl
1 Furycalm Snarl
1 Karn's Bastion
1 Mobilized District
1 Mystic Gate
1 Port Town
1 Prairie Stream
1 Rugged Prairie
1 Skycloud Expanse
1 Temple of Enlightenment
1 Temple of Epiphany
1 Temple of Triumph
1 Cartographer's Hawk
1 Path to Exile
1 Kazuul, Tyrant of the Cliffs
1 Arcane Signet
1 Fellwar Stone
1 Sol Ring
1 Command Tower
1 Myriad Landscape
1 Reliquary Tower
1 Grateful Apparition
1 Oreskos Explorer
1 Swords to Plowshares
1 The Wanderer
1 Flux Channeler
1 Fog Bank
1 Narset, Parter of Veils
1 Thrummingbird
1 Saheeli, Sublime Artificer
1 Wall of Denial
1 Azorius Signet
1 Boros Signet
1 Honor-Worn Shaku
1 Izzet Signet
1 Talisman of Conviction
1 Talisman of Creativity
1 Talisman of Progress
1 Wayfarer's Bauble
1 Forge of Heroes
1 Interplanar Beacon
1 Mystic Monastery
4 Island
3 Island
2 Mountain
2 Mountain
4 Plains
3 Plains`,
  },
  cmm_sliver_swarm: {
    label: "Sliver Swarm (Sliver Gravemother)",
    set: "Commander Masters",
    bracket: 2,
    text: `Commander
1 Sliver Gravemother

Deck
1 Rukarumel, Biologist
1 Regal Sliver
1 Taunting Sliver
1 Titan of Littjara
1 Lazotep Sliver
1 Capricious Sliver
1 Descendants' Fury
1 For the Ancestors
1 Hatchery Sliver
1 Bonescythe Sliver
1 Cleansing Nova
1 Harsh Mercy
1 Galerider Sliver
1 Synapse Sliver
1 Crippling Fear
1 Syphon Sliver
1 Spiteful Sliver
1 Brood Sliver
1 Megantic Sliver
1 Realmwalker
1 Cloudshredder Sliver
1 Decimate
1 Sliver Hivelord
1 Icon of Ancestry
1 Vanquisher's Banner
1 Canopy Vista
1 Cinder Glade
1 Exotic Orchard
1 Irrigated Farmland
1 Prairie Stream
1 Scattered Groves
1 Sheltered Thicket
1 Smoldering Marsh
1 Sunken Hollow
1 Arcane Signet
1 Fellwar Stone
1 Sol Ring
1 Ash Barrens
1 Command Tower
1 Path of Ancestry
1 Constricting Sliver
1 Sentinel Sliver
1 Sinew Sliver
1 Diffusion Sliver
1 Distant Melody
1 Shifting Sliver
1 Windfall
1 Winged Sliver
1 Clot Sliver
1 Crypt Sliver
1 Blade Sliver
1 Blur Sliver
1 Bonesplitter Sliver
1 Cleaving Sliver
1 Hollowhead Sliver
1 Striking Sliver
1 Two-Headed Sliver
1 Cultivate
1 Farseek
1 Gemhide Sliver
1 Manaweft Sliver
1 Might Sliver
1 Nature's Lore
1 Quick Sliver
1 Three Visits
1 Venom Sliver
1 Crystalline Sliver
1 Firewake Sliver
1 Harmonic Sliver
1 Hibernation Sliver
1 Lavabelly Sliver
1 Necrotic Sliver
1 Herald's Horn
1 Pillar of Origins
1 Flood Plain
1 Frontier Bivouac
1 Grasslands
1 Jungle Shrine
1 Mountain Valley
1 Mystic Monastery
1 Nomad Outpost
1 Opulent Palace
1 Rocky Tar Pit
1 Sandsteppe Citadel
1 Savage Lands
1 Seaside Citadel
1 Secluded Courtyard
1 Unclaimed Territory
2 Plains
2 Island
2 Swamp
2 Mountain
3 Forest`,
  },
  ltc_elven_council: {
    label: "Elven Council (Galadriel, Elven-Queen)",
    set: "The Lord of the Rings Commander",
    bracket: 2,
    text: `Commander
1 Galadriel, Elven-Queen

Deck
1 Gandalf, Westward Voyager
1 Raise the Palisade
1 Trap the Trespassers
1 Arwen, Weaver of Hope
1 Galadhrim Ambush
1 Haldir, Lórien Lieutenant
1 Legolas Greenleaf
1 Mirkwood Elk
1 Travel Through Caradhras
1 Windswift Slice
1 Círdan the Shipwright
1 Elrond of the White Council
1 Erestor of the Council
1 Mirkwood Trapper
1 Radagast, Wizard of Wilds
1 Sail into the West
1 Song of Eärendil
1 Lothlórien Blade
1 Model of Unity
1 Colossal Whale
1 Devastation Tide
1 Mystic Confluence
1 Plea for Power
1 Swan Song
1 Asceticism
1 Elvish Archdruid
1 Elvish Piper
1 Elvish Warmaster
1 Genesis Wave
1 Heroic Intervention
1 Hornet Queen
1 Inscription of Abundance
1 Overwhelming Stampede
1 Realm Seekers
1 Seeds of Renewal
1 Sylvan Offering
1 Exotic Orchard
1 Flooded Grove
1 Hinterland Harbor
1 Rejuvenating Springs
1 Vineglimmer Snarl
1 Lórien Revealed
1 Celeborn the Wise
1 Elven Farsight
1 Wose Pathfinder
1 Learn from the Past
1 Opt
1 Preordain
1 Arbor Elf
1 Beast Within
1 Cultivate
1 Elvish Mystic
1 Elvish Visionary
1 Farhaven Elf
1 Mirror of Galadriel
1 Lignify
1 Paradise Druid
1 Rampant Growth
1 Reclamation Sage
1 Wood Elves
1 Growth Spiral
1 Arcane Signet
1 Commander's Sphere
1 Lightning Greaves
1 Sol Ring
1 Whispersilk Cloak
1 Ash Barrens
1 Command Tower
1 Field of Ruin
1 Lonely Sandbar
1 Thornwood Falls
1 Tranquil Thicket
1 Woodland Stream
6 Island
5 Island
8 Forest
7 Forest`,
  },
  ltc_riders_of_rohan: {
    label: "Riders of Rohan (Éowyn, Shieldmaiden)",
    set: "The Lord of the Rings Commander",
    bracket: 2,
    text: `Commander
1 Éowyn, Shieldmaiden

Deck
1 Aragorn, King of Gondor
1 Beregond of the Guard
1 Champions of Minas Tirith
1 Gilraen, Dúnedain Protector
1 Grey Host Reinforcements
1 Lossarnach Captain
1 Archivist of Gondor
1 Denethor, Stone Seer
1 Fealty to the Realm
1 Call for Aid
1 Gimli of the Glittering Caves
1 Boromir, Gondor's Hope
1 Éomer, King of Rohan
1 Faramir, Steward of Gondor
1 Forth Eorlingas!
1 Oath of Eorl
1 Riders of Rohan
1 Taunt from the Rampart
1 Crown of Gondor
1 Bastion Protector
1 Dearly Departed
1 Frontline Medic
1 Increasing Devotion
1 Marshal's Anthem
1 Selfless Squire
1 Unbreakable Formation
1 Verge Rangers
1 Visions of Glory
1 Weathered Wayfarer
1 Combat Celebrant
1 Court of Ire
1 Earthquake
1 Flamerush Rider
1 Frontier Warmonger
1 Harsh Mentor
1 Shared Animosity
1 Zealous Conscripts
1 Supreme Verdict
1 Door of Destinies
1 Vanquisher's Banner
1 Battlefield Forge
1 Clifftop Retreat
1 Exotic Orchard
1 Furycalm Snarl
1 Glacial Fortress
1 Port Town
1 Prairie Stream
1 Sulfur Falls
1 Throne of the High City
1 Windbrisk Heights
1 Lost to Legend
1 Erkenbrand, Lord of Westfold
1 Banishing Light
1 Fiend Hunter
1 Palace Jailer
1 Path to Exile
1 Sunset Revelry
1 Swords to Plowshares
1 Village Bell-Ringer
1 Prince Imrahil the Fair
1 Humble Defector
1 Théoden, King of Rohan
1 Arcane Signet
1 Commander's Sphere
1 Heirloom Blade
1 Herald's Horn
1 Sol Ring
1 Talisman of Conviction
1 Talisman of Progress
1 Thought Vessel
1 Wayfarer's Bauble
1 Command Tower
1 Evolving Wilds
1 Field of Ruin
1 Path of Ancestry
1 Rogue's Passage
1 Secluded Courtyard
1 Terramorphic Expanse
1 Tranquil Cove
1 Wind-Scarred Crag
5 Plains
4 Plains
3 Island
2 Island
3 Mountain
2 Mountain`,
  },
  ltc_the_hosts_of_mordor: {
    label: "The Hosts of Mordor (Sauron, Lord of the Rings)",
    set: "The Lord of the Rings Commander",
    bracket: 2,
    text: `Commander
1 Sauron, Lord of the Rings

Deck
1 Saruman, the White Hand
1 Corsairs of Umbar
1 Monstrosity of the Lake
1 Subjugate the Hobbits
1 Shelob, Dread Weaver
1 Cavern-Hoard Dragon
1 Orcish Siegemaster
1 Rampaging War Mammoth
1 The Balrog of Moria
1 Gríma, Saruman's Footman
1 In the Darkness Bind Them
1 Lidless Gaze
1 Lord of the Nazgûl
1 Moria Scavenger
1 Summons of Saruman
1 Too Greedily, Too Deep
1 Wake the Dragon
1 Relic of Sauron
1 The Black Gate
1 Decree of Pain
1 Languish
1 Living Death
1 Reanimate
1 Blasphemous Act
1 Goblin Dark-Dwellers
1 Inferno Titan
1 Knollspine Dragon
1 Scourge of the Throne
1 Siege-Gang Commander
1 Treasure Nabber
1 Hostage Taker
1 Notion Thief
1 Choked Estuary
1 Desolate Lighthouse
1 Dragonskull Summit
1 Drowned Catacomb
1 Foreboding Ruins
1 Frostboil Snarl
1 Smoldering Marsh
1 Sulfur Falls
1 Sulfurous Springs
1 Sunken Hollow
1 Underground River
1 Treason of Isengard
1 Bitter Downfall
1 Troll of Khazad-dûm
1 Voracious Fell Beast
1 Fiery Inscription
1 Grishnákh, Brash Instigator
1 Arcane Denial
1 Boon of the Wish-Giver
1 Consider
1 Deep Analysis
1 Fact or Fiction
1 Forbidden Alchemy
1 Feed the Swarm
1 Merciless Executioner
1 Revenge of Ravens
1 Anger
1 Faithless Looting
1 The Mouth of Sauron
1 Goblin Cratermaker
1 Guttersnipe
1 Shiny Impetus
1 Thrill of Possibility
1 Extract from Darkness
1 Arcane Signet
1 Basalt Monolith
1 Commander's Sphere
1 Everflowing Chalice
1 Mind Stone
1 Sol Ring
1 Worn Powerstone
1 Command Tower
1 Crumbling Necropolis
1 Evolving Wilds
1 Field of Ruin
1 Path of Ancestry
1 Rogue's Passage
1 Terramorphic Expanse
3 Island
3 Island
3 Swamp
3 Swamp
4 Mountain
3 Mountain`,
  },
  sld_from_cute_to_brute: {
    label: "From Cute to Brute (Esika, God of the Tree // The Prismatic Bridge)",
    set: "Secret Lair Commander",
    bracket: 2,
    text: `Commander
1 Esika, God of the Tree // The Prismatic Bridge

Deck
1 Archangel Avacyn // Avacyn, the Purifier
1 Bloodline Keeper // Lord of Lineage
1 Nicol Bolas, the Ravager // Nicol Bolas, the Arisen
1 Westvale Abbey // Ormendahl, Profane Prince
1 Putrefy
1 Rhys the Redeemed
1 Evolving Wilds
1 Exotic Orchard
1 Vivid Grove
1 Arlinn Kord // Arlinn, Embraced by the Moon
1 Voldaren Pariah // Abolisher of Bloodlines
1 Guardian Project
1 Beast Whisperer
1 Chromatic Lantern
1 Emmara, Soul of the Accord
1 Elbrus, the Binding Blade // Withengar Unbound
1 Sisay, Weatherlight Captain
1 Sol Ring
1 Scattered Groves
1 Sheltered Thicket
1 Harmonize
1 Altar of the Pantheon
1 Kinnan, Bonder Prodigy
1 Pongify
1 Chandra, Fire of Kaladesh // Chandra, Roaring Flame
1 Jace, Vryn's Prodigy // Jace, Telepath Unbound
1 Kytheon, Hero of Akros // Gideon, Battle-Forged
1 Liliana, Heretical Healer // Liliana, Defiant Necromancer
1 Nissa, Vastwood Seer // Nissa, Sage Animist
1 Opulent Palace
1 Azor's Gateway // Sanctum of the Sun
1 Hadana's Climb // Winged Temple of Orazca
1 Journey to Eternity // Atzal, Cave of Eternity
1 Dowsing Dagger // Lost Vale
1 Legion's Landing // Adanto, the First Fort
1 Search for Azcanta // Azcanta, the Sunken Ruin
1 Thaumatic Compass // Spires of Orazca
1 Treasure Map // Treasure Cove
1 Beast Within
1 Farseek
1 Garruk Relentless // Garruk, the Veil-Cursed
1 Command Tower
1 Brightclimb Pathway // Grimclimb Pathway
1 Branchloft Pathway // Boulderloft Pathway
1 Cragcrown Pathway // Timbercrown Pathway
1 Needleverge Pathway // Pillarverge Pathway
1 Riverglide Pathway // Lavaglide Pathway
1 Valakut Awakening // Valakut Stoneforge
1 Bala Ged Recovery // Bala Ged Sanctuary
1 Clearwater Pathway // Murkwater Pathway
1 Hagra Mauling // Hagra Broodpit
1 Ondu Inversion // Ondu Skyruins
1 Sandstone Oracle
1 Sphinx of the Second Sun
1 Meteor Golem
1 Terramorphic Expanse
1 Blightstep Pathway // Searstep Pathway
1 Hengegate Pathway // Mistgate Pathway
1 Barkchannel Pathway // Tidechannel Pathway
1 Darkbore Pathway // Slitherbore Pathway
1 Valki, God of Lies // Tibalt, Cosmic Impostor
1 Rimewood Falls
1 Woodland Chasm
1 Kolvori, God of Kinship // The Ringhart Crest
1 Cosima, God of the Voyage // The Omenkeel
1 Plargg, Dean of Chaos // Augusta, Dean of Order
1 Valentin, Dean of the Vein // Lisette, Dean of the Root
1 Shaile, Dean of Radiance // Embrose, Dean of Shadow
1 Mila, Crafty Companion // Lukka, Wayward Bonder
1 Triplicate Titan
1 Diluvian Primordial
1 Seaside Citadel
1 Arlinn, the Pack's Hope // Arlinn, the Moon's Fury
1 Ludevic, Necrogenius // Olag, Ludevic's Hubris
1 Dennick, Pious Apprentice // Dennick, Pious Apparition
1 Tovolar's Huntmaster // Tovolar's Packleader
1 Butcher of Malakir
1 Path of Ancestry
1 Savage Lands
1 Tireless Provisioner
1 Fellwar Stone
1 Urza's Ruinous Blast
1 Zetalpa, Primal Dawn
1 Commander's Sphere
1 Arcane Signet
1 Jolrael, Mwonvuli Recluse
1 Sandsteppe Citadel
1 Plains
1 Swamp
1 Forest
1 Forest
1 Forest
1 Island
1 Mountain
1 Jungle Shrine
1 Frontier Bivouac
1 Time Wipe
1 Utter End
1 The World Tree`,
  },
  moc_call_for_backup: {
    label: "Call for Backup (Bright-Palm, Soul Awakener)",
    set: "March of the Machine Commander",
    bracket: 2,
    text: `Commander
1 Bright-Palm, Soul Awakener

Deck
1 Shalai and Hallar
1 Death-Greeter's Champion
1 Uncivil Unrest
1 Ichor Elixir
1 Mirror-Style Master
1 Guardian Scalelord
1 Emergent Woodwurm
1 Path of the Pyromancer
1 Conclave Sledge-Captain
1 Kalonian Hydra
1 Mikaeus, the Lunarch
1 Canopy Vista
1 Champion of Lambholt
1 Cinder Glade
1 Dromoka's Command
1 Exotic Orchard
1 Flamerush Rider
1 Flameshadow Conjuring
1 Forgotten Ancient
1 Fortified Village
1 Furycalm Snarl
1 Game Trail
1 Gavony Township
1 Genesis Hydra
1 Gyre Sage
1 Heaven // Earth
1 High Sentinels of Arashin
1 Incubation Druid
1 Inscription of Abundance
1 Ion Storm
1 Kessig Wolf Run
1 Krenko, Tin Street Kingpin
1 Managorger Hydra
1 Mossfire Valley
1 Mosswort Bridge
1 Restoration Angel
1 Rishkar, Peema Renegade
1 Semester's End
1 Strionic Resonator
1 Sungrass Prairie
1 Sunscorch Regent
1 Temple of Abandon
1 Temple of Plenty
1 Temple of Triumph
1 Together Forever
1 Triskelion
1 Command Tower
1 Commander's Sphere
1 Cultivate
1 Evolving Wilds
1 Fertilid
1 Fractured Powerstone
1 Kodama's Reach
1 Path of Ancestry
1 Pridemalkin
1 Return to Nature
1 Terramorphic Expanse
1 Wood Elves
1 Abzan Battle Priest
1 Abzan Falconer
1 Alharu, Solemn Ritualist
1 Arcane Signet
1 Armorcraft Judge
1 Brawn
1 Bretagard Stronghold
1 Conclave Mentor
1 Constable of the Realm
1 Elite Scaleguard
1 Enduring Scalelord
1 Falkenrath Exterminator
1 Field of Ruin
1 Generous Gift
1 Good-Fortune Unicorn
1 Hamza, Guardian of Arashin
1 Hindervines
1 Inspiring Call
1 Jungle Shrine
1 Juniper Order Ranger
1 Krosan Verge
1 Llanowar Reborn
1 Mindless Automaton
1 Rogue's Passage
1 Slurrk, All-Ingesting
1 Sol Ring
1 Swords to Plowshares
1 Temple of the False God
5 Plains
2 Mountain
6 Forest`,
  },
  moc_cavalry_charge: {
    label: "Cavalry Charge (Sidar Jabari of Zhalfir)",
    set: "March of the Machine Commander",
    bracket: 2,
    text: `Commander
1 Sidar Jabari of Zhalfir

Deck
1 Elenda and Azor
1 Exsanguinator Cavalry
1 Ichor Elixir
1 Herald of Hoofbeats
1 Locthwain Lancer
1 Chivalric Alliance
1 Path of the Enigma
1 Vodalian Wave-Knight
1 Conjurer's Mantle
1 Ethersworn Adjudicator
1 Hero of Bladehold
1 Vona, Butcher of Magan
1 Acclaimed Contender
1 Adeline, Resplendent Cathar
1 Aryel, Knight of Windgrace
1 Choked Estuary
1 Exotic Orchard
1 Fell the Mighty
1 Haakon, Stromgald Scourge
1 Josu Vess, Lich Knight
1 Knight Exemplar
1 Knight of the White Orchid
1 Knights' Charge
1 Liliana's Standard Bearer
1 Maul of the Skyclaves
1 Midnight Reaper
1 Murderous Rider
1 Painful Truths
1 Port Town
1 Prairie Stream
1 Promise of Loyalty
1 Pull from Tomorrow
1 Shineshadow Snarl
1 Sigiled Sword of Valeron
1 Silverwing Squadron
1 Sunken Hollow
1 Temple of Deceit
1 Temple of Enlightenment
1 Temple of Silence
1 Time Wipe
1 Unbreakable Formation
1 Valiant Knight
1 Vanquisher's Banner
1 Worthy Knight
1 Bojuka Bog
1 Command Tower
1 Commander's Sphere
1 Distant Melody
1 Evolving Wilds
1 Fractured Powerstone
1 Orzhov Signet
1 Path of Ancestry
1 Read the Bones
1 Smitten Swordmaster
1 Terramorphic Expanse
1 Thriving Heath
1 Thriving Isle
1 Thriving Moor
1 Arcane Sanctum
1 Arcane Signet
1 Arvad the Cursed
1 Corpse Knight
1 Despark
1 Fellwar Stone
1 Foulmire Knight
1 Herald's Horn
1 Knight of the Last Breath
1 Knights of the Black Rose
1 Mind Stone
1 Myriad Landscape
1 Order of Midnight
1 Path to Exile
1 Return to Dust
1 Sol Ring
1 Swords to Plowshares
1 Syr Elenora, the Discerning
1 Syr Konrad, the Grim
1 Temple of the False God
1 Wintermoor Commander
1 Xerex Strobe-Knight
8 Plains
6 Island
5 Swamp`,
  },
  moc_divine_convocation: {
    label: "Divine Convocation (Kasla, the Broken Halo)",
    set: "March of the Machine Commander",
    bracket: 2,
    text: `Commander
1 Kasla, the Broken Halo

Deck
1 Saint Traft and Rem Karolus
1 Wand of the Worldsoul
1 Flockchaser Phantom
1 Wildfire Awakener
1 Ichor Elixir
1 Path of the Ghosthunter
1 Deluxe Dragster
1 Mistmeadow Vanisher
1 Nesting Dovehawk
1 Kykar, Wind's Fury
1 Elspeth, Sun's Champion
1 The Locust God
1 Angel of Finality
1 Angel of Salvation
1 Austere Command
1 Chasm Skulker
1 Cultivator's Caravan
1 Emeria Angel
1 Exotic Orchard
1 Frostboil Snarl
1 Furycalm Snarl
1 Hour of Reckoning
1 Keeper of the Accord
1 Kher Keep
1 Mentor of the Meek
1 Nadir Kraken
1 Port Town
1 Prairie Stream
1 Secure the Wastes
1 Skycloud Expanse
1 Temple of Enlightenment
1 Temple of Epiphany
1 Temple of Triumph
1 Venerated Loxodon
1 Whirlwind of Thought
1 Cloud of Faeries
1 Command Tower
1 Commander's Sphere
1 Ephemeral Shields
1 Evolving Wilds
1 Fractured Powerstone
1 Goblin Instigator
1 Goblin Medics
1 Impact Tremors
1 Spirited Companion
1 Suture Priest
1 Terramorphic Expanse
1 Village Bell-Ringer
1 Banisher Priest
1 Arcane Signet
1 Battle Screech
1 Chant of Vitu-Ghazi
1 Conclave Tribunal
1 Devouring Light
1 Duergar Hedge-Mage
1 Fallowsage
1 Flight of Equenauts
1 Improbable Alliance
1 Migratory Route
1 Mystic Monastery
1 Rogue's Passage
1 Seraph of the Masses
1 Skullclamp
1 Sol Ring
1 Stoke the Flames
1 Swords to Plowshares
1 Tetsuko Umezawa, Fugitive
1 Wear // Tear
1 Temporal Cleansing
1 Meeting of Minds
1 Shatter the Source
1 Wrenn's Resolve
1 Cut Short
1 Joyful Stormsculptor
1 Artistic Refusal
8 Plains
8 Island
8 Mountain`,
  },
  moc_tinker_time: {
    label: "Tinker Time (Gimbal, Gremlin Prodigy)",
    set: "March of the Machine Commander",
    bracket: 2,
    text: `Commander
1 Gimbal, Gremlin Prodigy

Deck
1 Rashmi and Ragavan
1 Schema Thief
1 Sandsteppe War Riders
1 Cutthroat Negotiator
1 Hedron Detonator
1 Ichor Elixir
1 Path of the Animist
1 Pain Distributor
1 Dance with Calamity
1 Pia and Kiran Nalaar
1 Feldon of the Third Path
1 Chaos Warp
1 Stroke of Genius
1 Academy Manufactor
1 Aid from the Cowl
1 Bloodforged Battle-Axe
1 Brass's Bounty
1 Cinder Glade
1 Echo Storm
1 Everquill Phoenix
1 Exotic Orchard
1 Fiery Confluence
1 Frostboil Snarl
1 Game Trail
1 Gilded Goose
1 Hellkite Igniter
1 Imprisoned in the Moon
1 Inspiring Statuary
1 Master of Etherium
1 Masterful Replication
1 Perplexing Test
1 Rise and Shine
1 Saheeli's Artistry
1 Sharding Sphinx
1 Shimmer Dragon
1 Skyclave Relic
1 Spell Swindle
1 Spine of Ish Sah
1 Temple of Abandon
1 Temple of Epiphany
1 Temple of Mystery
1 Thopter Assembly
1 Thopter Spy Network
1 Tireless Tracker
1 Vedalken Humiliator
1 Vineglimmer Snarl
1 Workshop Elders
1 Command Tower
1 Crack Open
1 Evolving Wilds
1 Fractured Powerstone
1 Gruul Signet
1 Izzet Signet
1 Path of Ancestry
1 Reverse Engineer
1 Root Out
1 Simic Growth Chamber
1 Simic Signet
1 Terramorphic Expanse
1 Thoughtcast
1 Replicating Ring
1 Arcane Signet
1 Combine Chrysalis
1 Curse of Opulence
1 Frontier Bivouac
1 Ghirapur Aether Grid
1 Junk Winder
1 Myriad Landscape
1 Reality Shift
1 Saheeli, Sublime Artificer
1 Sol Ring
1 Struggle // Survive
1 Tireless Provisioner
1 Vampires' Vengeance
1 Weirding Wood
1 Whirler Rogue
8 Island
8 Mountain
7 Forest`,
  },
  onc_corrupting_influence: {
    label: "Corrupting Influence (Ixhel, Scion of Atraxa)",
    set: "Phyrexia: All Will Be One Commander",
    bracket: 2,
    text: `Commander
1 Ixhel, Scion of Atraxa

Deck
1 Bilious Skulldweller
1 Blight Mamba
1 Blightbelly Rat
1 Cankerbloom
1 Contaminant Grafter
1 Evolution Sage
1 Glissa's Retriever
1 Grateful Apparition
1 Ichor Rats
1 Ichorclaw Myr
1 Mycosynth Fiend
1 Myr Convert
1 Norn's Choirmaster
1 Pestilent Syphoner
1 Phyrexian Swarmlord
1 Plague Myr
1 Plague Stinger
1 Scavenging Ooze
1 Venomous Brutalizer
1 Viridian Corrupter
1 Vishgraz, the Doomhive
1 Windborn Muse
1 Caress of Phyrexia
1 Culling Ritual
1 Cultivate
1 Expand the Sphere
1 Feed the Infection
1 Fumigate
1 Geth's Summons
1 Infectious Inquiry
1 Merciless Eviction
1 Night's Whisper
1 Noxious Assault
1 Painful Truths
1 Phyresis Outbreak
1 Phyrexian Rebirth
1 Unnatural Restoration
1 Vat Emergence
1 Wurmquake
1 Beast Within
1 Carrion Call
1 Mortify
1 Noxious Revival
1 Putrefy
1 Swords to Plowshares
1 Vraska's Fall
1 Ghostly Prison
1 Moldervine Reclamation
1 Norn's Decree
1 Arcane Signet
1 Chromatic Lantern
1 Commander's Sphere
1 Contagion Clasp
1 Fellwar Stone
1 Glistening Sphere
1 Golgari Signet
1 Grafted Exoskeleton
1 Norn's Annex
1 Phyrexian Atlas
1 Sol Ring
1 Trailblazer's Boots
1 Bojuka Bog
1 Canopy Vista
1 Command Tower
1 Exotic Orchard
1 Fortified Village
1 Karn's Bastion
1 Krosan Verge
1 Myriad Landscape
1 Necroblossom Snarl
1 Path of Ancestry
1 Sandsteppe Citadel
1 Shineshadow Snarl
1 Sungrass Prairie
1 Tainted Field
1 Tainted Wood
1 Temple of Malady
1 Temple of Plenty
1 Temple of Silence
6 Plains
6 Swamp
8 Forest`,
  },
  onc_rebellion_rising: {
    label: "Rebellion Rising (Neyali, Suns' Vanguard)",
    set: "Phyrexia: All Will Be One Commander",
    bracket: 2,
    text: `Commander
1 Neyali, Suns' Vanguard

Deck
1 Elspeth Tirel
1 Adriana, Captain of the Guard
1 Dragonmaster Outcast
1 Emeria Angel
1 Goldnight Commander
1 Harmonious Archon
1 Jor Kadeen, the Prevailer
1 Legion Warboss
1 Loyal Apprentice
1 Mentor of the Meek
1 Myr Battlesphere
1 Otharri, Suns' Glory
1 Phantom General
1 Prava of the Steel Legion
1 Siege-Gang Commander
1 Silverwing Squadron
1 Solemn Simulacrum
1 Boros Charm
1 Call the Coppercoats
1 Clever Concealment
1 Flawless Maneuver
1 Generous Gift
1 Midnight Haunting
1 Path to Exile
1 White Sun's Zenith
1 Battle Screech
1 Chain Reaction
1 Collective Effort
1 Cut a Deal
1 Finale of Glory
1 Goldwardens' Gambit
1 Hate Mirage
1 Heroic Reinforcements
1 Hordeling Outburst
1 Hour of Reckoning
1 Increasing Devotion
1 Martial Coup
1 Rip Apart
1 Assemble the Legion
1 Court of Grace
1 Felidar Retreat
1 Intangible Virtue
1 Roar of Resistance
1 Arcane Signet
1 Boros Signet
1 Commander's Sphere
1 Fellwar Stone
1 Glimmer Lens
1 Hexplate Wallbreaker
1 Idol of Oblivion
1 Kemba's Banner
1 Loxodon Warhammer
1 Mace of the Valiant
1 Mask of Memory
1 Maul of the Skyclaves
1 Mind Stone
1 Sol Ring
1 Soul-Guide Lantern
1 Staff of the Storyteller
1 Talisman of Conviction
1 Vulshok Factory
1 Boros Garrison
1 Buried Ruin
1 Castle Ardenvale
1 Castle Embereth
1 Command Tower
1 Exotic Orchard
1 Forgotten Cave
1 Furycalm Snarl
1 Kher Keep
1 Myriad Landscape
1 Path of Ancestry
1 Secluded Steppe
1 Slayers' Stronghold
1 Temple of Triumph
1 Temple of the False God
1 Windbrisk Heights
11 Plains
11 Mountain`,
  },
  scd_chaos_incarnate: {
    label: "Chaos Incarnate (Kardur, Doomscourge)",
    set: "Starter Commander Decks",
    bracket: 2,
    text: `Commander
1 Kardur, Doomscourge

Deck
1 Archfiend of Depravity
1 Bloodgift Demon
1 Deadly Tempest
1 Dredge the Mire
1 Ob Nixilis Reignited
1 Profane Command
1 Rakshasa Debaser
1 Reign of the Pit
1 Sangromancer
1 Scythe Specter
1 Sepulchral Primordial
1 Soul Shatter
1 Titan Hunter
1 Blasphemous Act
1 Brash Taunter
1 Chaos Warp
1 Combustible Gearhulk
1 Dictate of the Twin Gods
1 Fiery Confluence
1 Geode Rager
1 Kazuul, Tyrant of the Cliffs
1 Magmatic Force
1 Sunbird's Invocation
1 Tectonic Giant
1 Wild Ricochet
1 Wildfire Devils
1 Kaervek the Merciless
1 Spiteful Visions
1 Stormfist Crusader
1 Theater of Horrors
1 Coveted Jewel
1 Solemn Simulacrum
1 Foreboding Ruins
1 Smoldering Marsh
1 Stensia Bloodhall
1 Temple of Malice
1 Ambition's Cost
1 Feed the Swarm
1 Indulgent Tormentor
1 Read the Bones
1 Sign in Blood
1 Syphon Mind
1 Vampire Nighthawk
1 Abrade
1 Explosion of Riches
1 Guttersnipe
1 Hate Mirage
1 Mana Geyser
1 Thermo-Alchemist
1 Breath of Malfegor
1 Rakdos Charm
1 Terminate
1 Unlicensed Disintegration
1 Arcane Signet
1 Burnished Hart
1 Commander's Sphere
1 Lightning Greaves
1 Nihil Spellbomb
1 Rakdos Signet
1 Sol Ring
1 Talisman of Indulgence
1 Wayfarer's Bauble
1 Worn Powerstone
1 Akoum Refuge
1 Bloodfell Caves
1 Cinder Barrens
1 Command Tower
1 Molten Slagheap
1 Myriad Landscape
1 Urborg Volcano
15 Swamp
14 Mountain`,
  },
  scd_draconic_destruction: {
    label: "Draconic Destruction (Atarka, World Render)",
    set: "Starter Commander Decks",
    bracket: 2,
    text: `Commander
1 Atarka, World Render

Deck
1 Akoum Hellkite
1 Chain Reaction
1 Crucible of Fire
1 Demanding Dragon
1 Dragonkin Berserker
1 Dragonmaster Outcast
1 Drakuseth, Maw of Flames
1 Dream Pillager
1 Flameblast Dragon
1 Hoard-Smelter Dragon
1 Magmaquake
1 Mordant Dragon
1 Runehorn Hellkite
1 Sarkhan, the Dragonspeaker
1 Scourge of Valkas
1 Spit Flame
1 Sweltering Suns
1 Thunderbreak Regent
1 Thundermaw Hellkite
1 Tyrant's Familiar
1 Verix Bladewing
1 Foe-Razer Regent
1 Frontier Siege
1 Hunter's Prowess
1 Primal Might
1 Shamanic Revelation
1 Clan Defiance
1 Harbinger of the Hunt
1 Dragon's Hoard
1 Steel Hellkite
1 Cinder Glade
1 Game Trail
1 Haven of the Spirit Dragon
1 Temple of Abandon
1 Dragon Mage
1 Dragon Tempest
1 Dragonlord's Servant
1 Dragonspeaker Shaman
1 Furnace Whelp
1 Provoke the Trolls
1 Rapacious Dragon
1 Unleash Fury
1 Vandalblast
1 Beast Within
1 Blossoming Defense
1 Cultivate
1 Drumhunter
1 Elemental Bond
1 Garruk's Uprising
1 Harmonize
1 Hunter's Insight
1 Loaming Shaman
1 Return to Nature
1 Sakura-Tribe Elder
1 Draconic Disciple
1 Fires of Yavimaya
1 Savage Ventmaw
1 Arcane Signet
1 Atarka Monument
1 Commander's Sphere
1 Sol Ring
1 Swiftfoot Boots
1 Talisman of Impulse
1 Command Tower
1 Kazandu Refuge
1 Path of Ancestry
1 Rugged Highlands
1 Shivan Oasis
1 Timber Gorge
18 Mountain
12 Forest`,
  },
  scd_first_flight: {
    label: "First Flight (Isperia, Supreme Judge)",
    set: "Starter Commander Decks",
    bracket: 2,
    text: `Commander
1 Isperia, Supreme Judge

Deck
1 Archon of Redemption
1 Cartographer's Hawk
1 Cleansing Nova
1 Emeria Angel
1 Gideon Jura
1 Hanged Executioner
1 Remorseful Cleric
1 Sephara, Sky's Blade
1 Steel-Plume Marshal
1 Storm Herd
1 True Conviction
1 Angler Turtle
1 Bident of Thassa
1 Diluvian Primordial
1 Ever-Watching Threshold
1 Faerie Formation
1 Gravitational Shift
1 Inspired Sphinx
1 Sharding Sphinx
1 Sphinx of Enlightenment
1 Windreader Sphinx
1 Absorb
1 Skycat Sovereign
1 Sphinx's Revelation
1 Time Wipe
1 Moorland Haunt
1 Port Town
1 Prairie Stream
1 Temple of Enlightenment
1 Aven Gagglemaster
1 Banishing Light
1 Condemn
1 Crush Contraband
1 Disenchant
1 Generous Gift
1 Kangee's Lieutenant
1 Rally of Wings
1 Soul Snare
1 Swords to Plowshares
1 Vow of Duty
1 Aetherize
1 Counterspell
1 Favorable Winds
1 Negate
1 Tide Skimmer
1 Warden of Evos Isle
1 Winged Words
1 Cloudblazer
1 Empyrean Eagle
1 Jubilant Skybonder
1 Kangee, Sky Warden
1 Migratory Route
1 Staggering Insight
1 Thunderclap Wyvern
1 Arcane Signet
1 Azorius Signet
1 Commander's Sphere
1 Hedron Archive
1 Pilgrim's Eye
1 Sky Diamond
1 Skyscanner
1 Sol Ring
1 Talisman of Progress
1 Thought Vessel
1 Coastal Tower
1 Command Tower
1 Meandering River
1 Sejiri Refuge
1 Tranquil Cove
15 Plains
15 Island`,
  },
  scd_grave_danger: {
    label: "Grave Danger (Gisa and Geralf)",
    set: "Starter Commander Decks",
    bracket: 2,
    text: `Commander
1 Gisa and Geralf

Deck
1 Geralf's Mindcrusher
1 Laboratory Drudge
1 Army of the Damned
1 Cemetery Reaper
1 Champion of the Perished
1 Crippling Fear
1 Gravespawn Sovereign
1 Josu Vess, Lich Knight
1 Liliana, Untouched by Death
1 Liliana's Mastery
1 Liliana's Standard Bearer
1 Midnight Reaper
1 Necromantic Selection
1 Necrotic Hex
1 Open the Graves
1 Overseer of the Damned
1 Scourge of Nel Toth
1 Unbreathing Horde
1 Zombie Apocalypse
1 Enter the God-Eternals
1 Havengul Lich
1 Undermine
1 Vela the Night-Clad
1 Grimoire of the Dead
1 Choked Estuary
1 Sunken Hollow
1 Temple of Deceit
1 Deep Analysis
1 Distant Melody
1 Eternal Skylord
1 Lazotep Plating
1 Sinister Sabotage
1 Cruel Revival
1 Curse of Disturbance
1 Feed the Swarm
1 Fleshbag Marauder
1 Gray Merchant of Asphodel
1 Lazotep Reaver
1 Liliana's Devotee
1 Lord of the Accursed
1 Lotleth Giant
1 Loyal Subordinate
1 Mire Triton
1 Murder
1 Spark Reaper
1 Syphon Flesh
1 Undead Augur
1 Vampiric Rites
1 Vengeful Dead
1 Victimize
1 Vizier of the Scorpion
1 Withered Wretch
1 Diregraf Captain
1 Gleaming Overseer
1 Pilfered Plans
1 Arcane Signet
1 Commander's Sphere
1 Dimir Signet
1 Heraldic Banner
1 Sol Ring
1 Talisman of Dominance
1 Unstable Obelisk
1 Wayfarer's Bauble
1 Command Tower
1 Dismal Backwater
1 Jwar Isle Refuge
1 Salt Marsh
1 Submerged Boneyard
13 Island
18 Swamp`,
  },
  scd_token_triumph: {
    label: "Token Triumph (Emmara, Soul of the Accord)",
    set: "Starter Commander Decks",
    bracket: 2,
    text: `Commander
1 Emmara, Soul of the Accord

Deck
1 Ajani, Caller of the Pride
1 Citywide Bust
1 Commander's Insignia
1 Dawn of Hope
1 Dictate of Heliod
1 Felidar Retreat
1 Hour of Reckoning
1 Mentor of the Meek
1 White Sun's Zenith
1 Champion of Lambholt
1 Citanul Hierophants
1 Collective Unconscious
1 Harvest Season
1 Hornet Nest
1 Hornet Queen
1 Rishkar, Peema Renegade
1 Scavenging Ooze
1 Thunderfoot Baloth
1 Verdant Force
1 Aura Mutation
1 Camaraderie
1 Collective Blessing
1 Dauntless Escort
1 March of the Multitudes
1 Trostani Discordant
1 Idol of Oblivion
1 Slate of Ancestry
1 Canopy Vista
1 Fortified Village
1 Temple of Plenty
1 Conclave Tribunal
1 Devouring Light
1 Path to Exile
1 Rootborn Defenses
1 Valor in Akros
1 Avacyn's Pilgrim
1 Curse of Bounty
1 Eternal Witness
1 Farhaven Elf
1 Great Oak Guardian
1 Harmonize
1 Jade Mage
1 Jaspera Sentinel
1 Karametra's Favor
1 Leafkin Druid
1 Loyal Guardian
1 Nissa's Expedition
1 Nullmage Shepherd
1 Overrun
1 Overwhelming Instinct
1 Presence of Gond
1 Reclamation Sage
1 Scatter the Seeds
1 Sporemound
1 Voice of Many
1 Maja, Bretagard Protector
1 Selesnya Evangel
1 Selesnya Guildmage
1 Sylvan Reclamation
1 Arcane Signet
1 Commander's Sphere
1 Sol Ring
1 Talisman of Unity
1 Blossoming Sands
1 Command Tower
1 Elfhame Palace
1 Graypelt Refuge
1 Holdout Settlement
1 Tranquil Expanse
1 Vitu-Ghazi, the City-Tree
15 Forest
14 Plains`,
  },
  brc_mishra_s_burnished_banne: {
    label: "Mishra's Burnished Banner (Mishra, Eminent One)",
    set: "The Brothers' War Commander",
    bracket: 2,
    text: `Commander
1 Mishra, Eminent One

Deck
1 Muzzio, Visionary Architect
1 Geth, Lord of the Vault
1 Herald of Anguish
1 Jhoira, Weatherlight Captain
1 Silas Renn, Seeker Adept
1 Emry, Lurker of the Loch
1 Master Transmuter
1 Padeem, Consul of Innovation
1 Workshop Elders
1 Fain, the Broker
1 Audacious Reshapers
1 Hellkite Igniter
1 Slobad, Goblin Tinkerer
1 Brudiclad, Telchor Engineer
1 Metalwork Colossus
1 Traxos, Scourge of Kroog
1 Blasphemous Act
1 Expressive Iteration
1 Thoughtcast
1 Feed the Swarm
1 Faithless Looting
1 Chaos Warp
1 Bedevil
1 Fact or Fiction
1 Thirst for Knowledge
1 Abrade
1 Lithoform Engine
1 Cursed Mirror
1 Idol of Oblivion
1 Mirrorworks
1 Oblivion Stone
1 Spine of Ish Sah
1 Strionic Resonator
1 Trading Post
1 Oni-Cult Anvil
1 Dreamstone Hedron
1 Fellwar Stone
1 Hedron Archive
1 Ichor Wellspring
1 Mind Stone
1 Servo Schematic
1 Sol Ring
1 Thran Dynamo
1 Mnemonic Sphere
1 Executioner's Capsule
1 Arcane Signet
1 Commander's Sphere
1 Dimir Signet
1 Mycosynth Wellspring
1 Nihil Spellbomb
1 Prophetic Prism
1 Rakdos Signet
1 Wayfarer's Bauble
1 Darkwater Catacombs
1 Exotic Orchard
1 Shadowblood Ridge
1 Smoldering Marsh
1 Temple of Deceit
1 Temple of Epiphany
1 Temple of Malice
1 Buried Ruin
1 Crumbling Necropolis
1 Dimir Aqueduct
1 Izzet Boilerworks
1 Myriad Landscape
1 Rakdos Carnarium
1 Reliquary Tower
1 Ash Barrens
1 Command Tower
1 Drossforge Bridge
1 Great Furnace
1 Mistvault Bridge
1 Path of Ancestry
1 Seat of the Synod
1 Silverbluff Bridge
1 Terramorphic Expanse
1 Vault of Whispers
4 Swamp
5 Island
4 Mountain
1 Ashnod the Uncaring
1 Glint Raker
1 Terisiare's Devastation
1 Blast-Furnace Hellkite
1 Farid, Enterprising Salvager
1 Machine God's Effigy
1 Scavenged Brawler
1 Smelting Vat
1 Wondrous Crucible`,
  },
  brc_urza_s_iron_alliance: {
    label: "Urza's Iron Alliance (Urza, Chief Artificer)",
    set: "The Brothers' War Commander",
    bracket: 2,
    text: `Commander
1 Urza, Chief Artificer

Deck
1 Indomitable Archangel
1 Ethersworn Adjudicator
1 Noxious Gearhulk
1 Alela, Artful Provocateur
1 Angel of the Ruins
1 Bronze Guardian
1 Digsite Engineer
1 Losheel, Clockwork Scholar
1 Teshar, Ancestor's Apostle
1 Master of Etherium
1 Sai, Master Thopterist
1 Sharding Sphinx
1 Shimmer Dragon
1 Thought Monitor
1 Vedalken Humiliator
1 Marionette Master
1 Baleful Strix
1 Sharuum the Hegemon
1 Darksteel Juggernaut
1 Etched Champion
1 Myr Battlesphere
1 Solemn Simulacrum
1 Steel Hellkite
1 Steel Overseer
1 Filigree Attendant
1 Whirler Rogue
1 Armix, Filigree Thrasher
1 Chief of the Foundry
1 Etherium Sculptor
1 Chrome Courier
1 Austere Command
1 Phyrexian Rebirth
1 Urza's Ruinous Blast
1 One with the Machine
1 Vindicate
1 Preordain
1 Sphinx's Revelation
1 Unbreakable Formation
1 Swords to Plowshares
1 Despark
1 Bident of Thassa
1 Cranial Plating
1 Liquimetal Torque
1 Relic of Progenitus
1 Skullclamp
1 Sol Ring
1 Swiftfoot Boots
1 Thought Vessel
1 Arcane Signet
1 Azorius Signet
1 Dimir Signet
1 Orzhov Signet
1 Tempered Steel
1 Thopter Spy Network
1 Exotic Orchard
1 Prairie Stream
1 River of Tears
1 Skycloud Expanse
1 Spire of Industry
1 Sunken Hollow
1 Temple of Deceit
1 Temple of Enlightenment
1 Temple of Silence
1 Arcane Sanctum
1 Azorius Chancery
1 Darksteel Citadel
1 Dimir Aqueduct
1 Orzhov Basilica
1 Ancient Den
1 Ash Barrens
1 Bojuka Bog
1 Command Tower
1 Evolving Wilds
1 Goldmire Bridge
1 Mistvault Bridge
1 Path of Ancestry
1 Razortide Bridge
1 Seat of the Synod
1 Vault of Whispers
4 Plains
4 Island
3 Swamp
1 Tawnos, Solemn Survivor
1 Sanwell, Avenger Ace
1 Scholar of New Horizons
1 March of Progress
1 Wire Surgeons
1 Wreck Hunter
1 Hexavus
1 Kayla's Music Box
1 Thopter Shop`,
  },
  "40k_forces_of_the_imperium": {
    label: "Forces of the Imperium (Inquisitor Greyfax)",
    set: "Warhammer 40,000 Commander",
    bracket: 2,
    text: `Commander
1 Inquisitor Greyfax

Deck
1 Bastion Protector
1 Collective Effort
1 Deploy to the Front
1 Fell the Mighty
1 Hour of Reckoning
1 Launch the Fleet
1 Martial Coup
1 Entrapment Maneuver
1 Utter End
1 Swords to Plowshares
1 Mortify
1 Everflowing Chalice
1 Mind Stone
1 Skullclamp
1 Sol Ring
1 Talisman of Dominance
1 Talisman of Hierarchy
1 Talisman of Progress
1 Arcane Signet
1 Commander's Sphere
1 Reconnaissance Mission
1 Choked Estuary
1 Darkwater Catacombs
1 Exotic Orchard
1 Port Town
1 Prairie Stream
1 Skycloud Expanse
1 Sunken Hollow
1 Arcane Sanctum
1 Ash Barrens
1 Memorial to Glory
1 Command Tower
1 Dismal Backwater
1 Evolving Wilds
1 Path of Ancestry
1 Scoured Barrens
1 Terramorphic Expanse
1 Tranquil Cove
5 Island
7 Swamp
8 Plains
1 Marneus Calgar
1 Celestine, the Living Saint
1 Defenders of Humanity
1 For the Emperor!
1 Space Marine Devastator
1 Triumph of Saint Katherine
1 Ultramarines Honour Guard
1 Vexilus Praetor
1 Zephyrim
1 Sister of Silence
1 Vanguard Suppressor
1 Arco-Flagellant
1 Primaris Eliminator
1 Assault Intercessor
1 Belisarius Cawl
1 Birth of the Imperium
1 Callidus Assassin
1 Commissar Severina Raine
1 Company Commander
1 Cybernetica Datasmith
1 Epistolary Librarian
1 Exterminatus
1 The Flesh Is Weak
1 Inquisitor Eisenhorn
1 Neyam Shai Murad
1 Sister Hospitaller
1 Sister Repentia
1 The Golden Throne
1 Inquisitorial Rosette
1 Knight Paladin
1 Reaver Titan
1 Redemptor Dreadnought
1 Thunderhawk Gunship
1 And They Shall Know No Fear
1 Grey Knight Paragon
1 Space Marine Scout
1 Thunderwolf Cavalry
1 Sicarian Infiltrator
1 Sanguinary Priest
1 Deny the Witch
1 Primaris Chaplain`,
  },
  "40k_necron_dynasties": {
    label: "Necron Dynasties (Szarekh, the Silent King)",
    set: "Warhammer 40,000 Commander",
    bracket: 2,
    text: `Commander
1 Szarekh, the Silent King

Deck
1 Beacon of Unrest
1 Living Death
1 Mutilate
1 Dread Return
1 Defile
1 Darkness
1 Go for the Throat
1 Caged Sun
1 Endless Atlas
1 Gilded Lotus
1 Mystic Forge
1 Sculpting Steel
1 Cranial Plating
1 Hedron Archive
1 Mask of Memory
1 Sol Ring
1 Arcane Signet
1 Commander's Sphere
1 Mind Stone
1 Thought Vessel
1 Unstable Obelisk
1 Wayfarer's Bauble
1 Barren Moor
1 Myriad Landscape
1 Reliquary Tower
1 Desert of the Glorified
1 Polluted Mire
1 Vault of Whispers
10 Swamp
10 Swamp
10 Swamp
1 Imotekh the Stormlord
1 Anrakyr the Traveller
1 Biotransference
1 Chronomancer
1 Cryptek
1 Illuminor Szeras
1 Lokhust Heavy Destroyer
1 Lychguard
1 Necron Deathmark
1 Necron Overlord
1 Out of the Tombs
1 Royal Warden
1 Shard of the Nightbringer
1 Shard of the Void Dragon
1 Skorpekh Lord
1 Technomancer
1 Their Name Is Death
1 Their Number Is Legion
1 Tomb Blade
1 Trazyn the Infinite
1 Triarch Stalker
1 The War in Heaven
1 Canoptek Scarab Swarm
1 Canoptek Spyder
1 Canoptek Tomb Sentinel
1 Canoptek Wraith
1 Convergence of Dominion
1 Cryptothrall
1 Ghost Ark
1 Necron Monolith
1 Resurrection Orb
1 Sceptre of Eternal Glory
1 Tomb Fortress
1 Flayed One
1 Hexmark Destroyer
1 Plasmancer
1 Psychomancer
1 Sautekh Immortal
1 Skorpekh Destroyer
1 Triarch Praetorian
1 Night Scythe`,
  },
  "40k_the_ruinous_powers": {
    label: "The Ruinous Powers (Abaddon the Despoiler)",
    set: "Warhammer 40,000 Commander",
    bracket: 2,
    text: `Commander
1 Abaddon the Despoiler

Deck
1 Past in Flames
1 Decree of Pain
1 Blasphemous Act
1 Deny Reality
1 Chaos Warp
1 Reverberate
1 Bile Blight
1 Bituminous Blast
1 Brainstorm
1 Dark Ritual
1 Chromatic Lantern
1 Assault Suit
1 Sol Ring
1 Talisman of Creativity
1 Talisman of Dominance
1 Talisman of Indulgence
1 Worn Powerstone
1 Commander's Sphere
1 Wayfarer's Bauble
1 Warstorm Surge
1 Exotic Orchard
1 Foreboding Ruins
1 Sunken Hollow
1 Barren Moor
1 Crumbling Necropolis
1 Molten Slagheap
1 Temple of the False God
1 Command Tower
1 Dismal Backwater
1 Evolving Wilds
1 Forgotten Cave
1 Path of Ancestry
1 Swiftwater Cliffs
1 Terramorphic Expanse
8 Mountain
8 Swamp
8 Island
1 Be'lakor, the Dark Master
1 Lord of Change
1 Blight Grenade
1 Great Unclean One
1 Mandate of Abaddon
1 Mortarion, Daemon Primarch
1 Nurgle's Conscription
1 Plague Drone
1 Poxwalkers
1 Sloppity Bilepiper
1 Tallyman of Nurgle
1 Venomcrawler
1 Aspiring Champion
1 Bloodthirster
1 Dark Apostle
1 Keeper of Secrets
1 Khârn the Betrayer
1 Knight Rampager
1 Let the Galaxy Burn
1 Blood for the Blood God!
1 Chaos Defiler
1 Chaos Mutation
1 Drach'Nyen
1 Exalted Flamer of Tzeentch
1 Helbrute
1 The Horus Heresy
1 Kill! Maim! Burn!
1 Lucius the Eternal
1 Magnus the Red
1 Mutalith Vortex Beast
1 Pink Horror
1 The Ruinous Powers
1 Tzaangor Shaman
1 Heralds of Tzeentch
1 Nurgle's Rot
1 Bloodcrusher of Khorne
1 Chaos Terminator Lord
1 Herald of Slaanesh
1 Noise Marine
1 Seeker of Slaanesh
1 The Lost and the Damned`,
  },
  "40k_tyranid_swarm": {
    label: "Tyranid Swarm (The Swarmlord)",
    set: "Warhammer 40,000 Commander",
    bracket: 2,
    text: `Commander
1 The Swarmlord

Deck
1 Hull Breach
1 Cultivate
1 Explore
1 Farseek
1 Rampant Growth
1 Starstorm
1 Aetherize
1 Inspiring Call
1 Harrow
1 Icon of Ancestry
1 Herald's Horn
1 Sol Ring
1 Arcane Signet
1 Abundance
1 Death's Presence
1 Hardened Scales
1 Bred for the Hunt
1 New Horizons
1 Overgrowth
1 Cinder Glade
1 Exotic Orchard
1 Game Trail
1 Temple of Abandon
1 Temple of Epiphany
1 Temple of Mystery
1 Ash Barrens
1 Frontier Bivouac
1 Unclaimed Territory
1 Cave of Temptation
1 Command Tower
1 Evolving Wilds
1 Opal Palace
1 Path of Ancestry
1 Rugged Highlands
1 Terramorphic Expanse
1 Thornwood Falls
7 Mountain
7 Island
8 Forest
1 Magus Lucea Kane
1 Genestealer Patriarch
1 Exocrine
1 The Red Terror
1 Screamer-Killer
1 Biophagus
1 Bone Sabres
1 Broodlord
1 Clamavus
1 Haruspex
1 Hierophant Bio-Titan
1 Hormagaunt Horde
1 Lictor
1 Nexos
1 Old One Eye
1 Sporocyst
1 Termagant Swarm
1 Tervigon
1 Toxicrene
1 Tyrant Guard
1 Atalan Jackal
1 Deathleaper, Terror Weapon
1 The First Tyrannic War
1 Gargoyle Flock
1 Ghyrson Starn, Kelermorph
1 Malanthrope
1 Mawloc
1 Ravener
1 Shadow in the Warp
1 Tyranid Harridan
1 Tyranid Prime
1 Winged Hive Tyrant
1 Zoanthrope
1 Genestealer Locus
1 Acolyte Hybrid
1 Aberrant
1 Purestrain Genestealer
1 Tyranid Invasion
1 Trygon Prime
1 Venomthrope
1 Goliath Truck`,
  },
  dmc_legends_legacy: {
    label: "Legends' Legacy (Dihada, Binder of Wills)",
    set: "Dominaria United Commander",
    bracket: 2,
    text: `Commander
1 Dihada, Binder of Wills

Deck
1 Adriana, Captain of the Guard
1 Alesha, Who Smiles at Death
1 Anafenza, Kin-Tree Spirit
1 Arvad the Cursed
1 Ashling the Pilgrim
1 Bell Borca, Spectral Sergeant
1 Captain Lannery Storm
1 Kothophed, Soul Hoarder
1 Drana, Liberator of Malakir
1 Etali, Primal Storm
1 Garna, the Bloodflame
1 Jazal Goldmane
1 Josu Vess, Lich Knight
1 Kari Zev, Skyship Raider
1 Krenko, Tin Street Kingpin
1 Neheb, Dreadhorde Champion
1 Odric, Lunarch Marshal
1 Tajic, Blade of the Legion
1 Teshar, Ancestor's Apostle
1 Traxos, Scourge of Kroog
1 Zetalpa, Primal Dawn
1 Primevals' Glorious Rebirth
1 Urza's Ruinous Blast
1 Faithless Looting
1 Kaya's Wrath
1 Night's Whisper
1 Read the Bones
1 Ambition's Cost
1 Bedevil
1 Generous Gift
1 Hero's Downfall
1 Mortify
1 Thrill of Possibility
1 Unbreakable Formation
1 Wear // Tear
1 Blackblade Reforged
1 Bontu's Monument
1 Commander's Sphere
1 Arcane Signet
1 Fellwar Stone
1 Hazoret's Monument
1 Hedron Archive
1 Hero's Blade
1 Heroes' Podium
1 Honor-Worn Shaku
1 Oketra's Monument
1 Sol Ring
1 Sword of the Chosen
1 Tenza, Godo's Maul
1 The Circle of Loyalty
1 Day of Destiny
1 Battlefield Forge
1 Bojuka Bog
1 Boros Garrison
1 Command Tower
1 Dragonskull Summit
1 Evolving Wilds
1 Foreboding Ruins
1 Geier Reach Sanitarium
1 Mikokoro, Center of the Sea
1 Mobilized District
1 Nomad Outpost
1 Orzhov Basilica
1 Rakdos Carnarium
1 Reliquary Tower
1 Shivan Gorge
1 Shizo, Death's Storehouse
1 Smoldering Marsh
1 Temple of Malice
1 Temple of Silence
1 Temple of Triumph
1 Terramorphic Expanse
1 Tyrite Sanctum
1 Caves of Koilos
1 Shanid, Sleepers' Scourge
1 Zeriam, Golden Wind
1 Bladewing, Deathless Tyrant
1 Cadric, Soul Kindler
1 Gerrard's Hourglass Pendant
1 Moira, Urborg Haunt
1 The Peregrine Dynamo
1 Verrak, Warped Sengir
1 The Reaver Cleaver
5 Mountain
6 Plains
5 Swamp`,
  },
  dmc_painbow: {
    label: "Painbow (Jared Carthalion)",
    set: "Dominaria United Commander",
    bracket: 2,
    text: `Commander
1 Jared Carthalion

Deck
1 Archelos, Lagoon Mystic
1 Atla Palani, Nest Tender
1 Baleful Strix
1 Chromanticore
1 Coiling Oracle
1 O-Kagachi, Vengeful Kami
1 Faeburrow Elder
1 Fusion Elemental
1 Zaxara, the Exemplary
1 Hero of Precinct One
1 Illuna, Apex of Wishes
1 Knight of New Alara
1 Maelstrom Archangel
1 Nethroi, Apex of Death
1 Rienne, Angel of Rebirth
1 Selvala, Explorer Returned
1 Solemn Simulacrum
1 Surrak Dragonclaw
1 Transguild Courier
1 Glint-Eye Nephilim
1 Xyris, the Writhing Storm
1 Cultivate
1 Duneblast
1 Explore
1 Explosive Vegetation
1 Farseek
1 Kodama's Reach
1 Lavalanche
1 Merciless Eviction
1 Migration Path
1 Painful Truths
1 Radiant Flames
1 Search for Tomorrow
1 Time Wipe
1 Abzan Charm
1 Beast Within
1 Echoing Truth
1 Growth Spiral
1 Terminate
1 Naya Charm
1 Path to Exile
1 Sultai Charm
1 Sylvan Reclamation
1 Arcane Signet
1 Coalition Relic
1 Fellwar Stone
1 Commander's Sphere
1 Prophetic Prism
1 Abundant Growth
1 Maelstrom Nexus
1 Path to the World Tree
1 Bad River
1 Arcane Sanctum
1 Canopy Vista
1 Cascading Cataracts
1 Cinder Glade
1 Command Tower
1 Crumbling Necropolis
1 Crystal Quarry
1 Evolving Wilds
1 Exotic Orchard
1 Flood Plain
1 Frontier Bivouac
1 Grasslands
1 Jungle Shrine
1 Krosan Verge
1 Mountain Valley
1 Murmuring Bosk
1 Mystic Monastery
1 Nomad Outpost
1 Opulent Palace
1 Prairie Stream
1 Rocky Tar Pit
1 Sandsteppe Citadel
1 Savage Lands
1 Seaside Citadel
1 Smoldering Marsh
1 Sunken Hollow
1 Terramorphic Expanse
1 Jenson Carthalion, Druid Exile
1 Two-Headed Hellkite
1 Tiller Engine
1 Unite the Coalition
1 Fallaji Wayfarer
1 Iridian Maelstrom
1 Mana Cannons
1 Primeval Spawn
1 Obsidian Obelisk
3 Forest
2 Mountain
2 Island
2 Plains
2 Swamp`,
  },
  ncc_bedecked_brokers: {
    label: "Bedecked Brokers (Perrie, the Pulverizer)",
    set: "Streets of New Capenna Commander",
    bracket: 2,
    text: `Commander
1 Perrie, the Pulverizer

Deck
1 Kros, Defense Contractor
1 Ajani Unyielding
1 Angelic Sleuth
1 Aven Courier
1 Aven Mimeomancer
1 Avenging Huntbonder
1 Bribe Taker
1 Crystalline Giant
1 Devoted Druid
1 Denry Klin, Editor in Chief
1 Evolution Sage
1 Fathom Mage
1 Forgotten Ancient
1 Grateful Apparition
1 Incubation Druid
1 Jenara, Asura of War
1 Luminarch Aspirant
1 Park Heights Maverick
1 Rishkar, Peema Renegade
1 Roalesk, Apex Hybrid
1 Scavenging Ooze
1 Shield Broker
1 Skyboon Evangelist
1 Skyship Plunderer
1 Slippery Bogbonder
1 Steelbane Hydra
1 Thrummingbird
1 Vorel of the Hull Clade
1 Wall of Roots
1 Wickerbough Elder
1 Wingspan Mentor
1 Declaration in Stone
1 Damning Verdict
1 Planar Outburst
1 Tezzeret's Gambit
1 Rishkar's Expertise
1 Urban Evolution
1 Bant Charm
1 Brokers Charm
1 Brokers Confluence
1 Contractual Safeguard
1 Exotic Pets
1 Generous Gift
1 Storm of Forms
1 Family's Favor
1 Hoofprints of the Stag
1 Primal Empathy
1 Resourceful Defense
1 Together Forever
1 Agent's Toolkit
1 Arcane Signet
1 Commander's Sphere
1 Everflowing Chalice
1 Fellwar Stone
1 Gavel of the Righteous
1 Midnight Clock
1 Oblivion Stone
1 Oracle's Vault
1 Power Conduit
1 Sol Ring
1 Swiftfoot Boots
1 Ash Barrens
1 Bant Panorama
1 Brokers Hideout
1 Canopy Vista
1 Command Tower
1 Exotic Orchard
1 Flooded Grove
1 Fortified Village
1 Gavony Township
1 Karn's Bastion
1 Littjara Mirrorlake
1 Llanowar Reborn
1 Myriad Landscape
1 Nesting Grounds
1 Path of Ancestry
1 Port Town
1 Prairie Stream
1 Seaside Citadel
1 Skycloud Expanse
1 Sungrass Prairie
1 Temple of Mystery
1 Vivid Creek
1 Vivid Grove
1 Vivid Meadow
5 Forest
4 Island
5 Plains`,
  },
  ncc_cabaretti_cacophony: {
    label: "Cabaretti Cacophony (Kitt Kanto, Mayhem Diva)",
    set: "Streets of New Capenna Commander",
    bracket: 2,
    text: `Commander
1 Kitt Kanto, Mayhem Diva

Deck
1 Phabine, Boss's Confidant
1 Leafkin Druid
1 Sakura-Tribe Elder
1 Agitator Ant
1 Bess, Soul Nourisher
1 Champion of Lambholt
1 Magus of the Wheel
1 Orzhov Advokist
1 Rumor Gatherer
1 Scute Swarm
1 Selvala, Explorer Returned
1 Wood Elves
1 Zurzoth, Chaos Rider
1 Arasta of the Endless Web
1 Life of the Party
1 Master of Ceremonies
1 Rose Room Treasurer
1 Sizzling Soloist
1 Boss's Chauffeur
1 Gahiji, Honored One
1 Kazuul, Tyrant of the Cliffs
1 Thunderfoot Baloth
1 Cabaretti Confluence
1 Camaraderie
1 Cultivate
1 Fell the Mighty
1 Harmonize
1 Indulge // Excess
1 Martial Coup
1 Seize the Spotlight
1 Shamanic Revelation
1 Sylvan Offering
1 Vivien's Stampede
1 Artifact Mutation
1 Aura Mutation
1 Beast Within
1 Boros Charm
1 Cabaretti Charm
1 Crash the Party
1 Call the Coppercoats
1 Grand Crescendo
1 March of the Multitudes
1 Path to Exile
1 Sol Ring
1 Arcane Signet
1 Bloodthirsty Blade
1 Fellwar Stone
1 Idol of Oblivion
1 Commander's Sphere
1 Scepter of Celebration
1 False Floor
1 Intangible Virtue
1 Awakening Zone
1 Beastmaster Ascension
1 Duelist's Heritage
1 Killer Service
1 Prosperous Partnership
1 Felidar Retreat
1 Outpost Siege
1 Assemble the Legion
1 Sandwurm Convergence
1 Ash Barrens
1 Cabaretti Courtyard
1 Canopy Vista
1 Castle Ardenvale
1 Castle Embereth
1 Cinder Glade
1 Command Tower
1 Exotic Orchard
1 Fortified Village
1 Game Trail
1 Jungle Shrine
1 Mossfire Valley
1 Myriad Landscape
1 Naya Panorama
1 Path of Ancestry
1 Rugged Prairie
1 Sungrass Prairie
1 Temple of Triumph
1 Thriving Bluff
1 Thriving Grove
1 Thriving Heath
1 Windbrisk Heights
4 Plains
4 Mountain
8 Forest`,
  },
  ncc_maestros_massacre: {
    label: "Maestros Massacre (Anhelo, the Painter)",
    set: "Streets of New Capenna Commander",
    bracket: 2,
    text: `Commander
1 Anhelo, the Painter

Deck
1 Parnesse, the Subtle Brush
1 Bloodsoaked Champion
1 Cormela, Glamour Thief
1 Dogged Detective
1 Goblin Electromancer
1 Kess, Dissident Mage
1 Puppeteer Clique
1 Rekindling Phoenix
1 Spellbinding Soprano
1 Squee, the Immortal
1 Sinister Concierge
1 Syrix, Carrier of the Flame
1 Skyclave Shade
1 Woe Strider
1 Army of the Damned
1 Bedevil
1 Call the Skybreaker
1 Chain Reaction
1 Clone Legion
1 Damnable Pact
1 Deep Analysis
1 Drawn from Dreams
1 Dread Summons
1 Feed the Swarm
1 Flawless Forgery
1 Hex
1 Maestros Confluence
1 Make an Example
1 Ponder
1 Preordain
1 Reign of the Pit
1 River's Rebuke
1 Sever the Bloodline
1 Talrand's Invocation
1 Xander's Pact
1 Zndrsplt's Judgment
1 A Little Chat
1 Dig Through Time
1 Fact or Fiction
1 Frantic Search
1 Maestros Charm
1 Mystic Confluence
1 Waste Management
1 Arcane Signet
1 Audacious Swap
1 Body Count
1 Commander's Sphere
1 Dimir Signet
1 Fellwar Stone
1 Izzet Signet
1 Lightning Greaves
1 Rakdos Signet
1 Sol Ring
1 Mimic Vat
1 Smuggler's Buggy
1 Twinning Staff
1 Wayfarer's Bauble
1 Cryptic Pursuit
1 Determined Iteration
1 Double Vision
1 Extravagant Replication
1 Rite of the Raging Storm
1 Maestros Theater
1 Ash Barrens
1 Command Tower
1 Crumbling Necropolis
1 Grixis Panorama
1 Myriad Landscape
1 Path of Ancestry
1 Thriving Bluff
1 Thriving Isle
1 Thriving Moor
1 Cascade Bluffs
1 Choked Estuary
1 Darkwater Catacombs
1 Exotic Orchard
1 Foreboding Ruins
1 Shadowblood Ridge
1 Smoldering Marsh
1 Sunken Hollow
1 Temple of Epiphany
7 Island
6 Swamp
5 Mountain`,
  },
  ncc_obscura_operation: {
    label: "Obscura Operation (Kamiz, Obscura Oculus)",
    set: "Streets of New Capenna Commander",
    bracket: 2,
    text: `Commander
1 Kamiz, Obscura Oculus

Deck
1 Tivit, Seller of Secrets
1 Aerial Extortionist
1 Cephalid Facetaker
1 Skyway Robber
1 Misfortune Teller
1 Oskar, Rubbish Reclaimer
1 Silent-Blade Oni
1 Wrexial, the Risen Deep
1 Alela, Artful Provocateur
1 Fallen Shinobi
1 Drana, Liberator of Malakir
1 Archon of Coronation
1 Sun Titan
1 Champion of Wits
1 Chasm Skulker
1 Ghostly Pilferer
1 Identity Thief
1 Nadir Kraken
1 Custodi Lich
1 Graveblade Marauder
1 Daxos of Meletis
1 Dragonlord Ojutai
1 Shadowmage Infiltrator
1 Thief of Sanity
1 Daring Saboteur
1 Looter il-Kor
1 Whirler Rogue
1 Inkfathom Witch
1 Jailbreak
1 Writ of Return
1 Austere Command
1 Dusk // Dawn
1 Stolen Identity
1 Nightmare Unmaking
1 Profane Command
1 Treasure Cruise
1 An Offer You Can't Refuse
1 Change of Plans
1 Lethal Scheme
1 Obscura Charm
1 Obscura Confluence
1 Commit // Memory
1 Utter End
1 Swords to Plowshares
1 In Too Deep
1 Life Insurance
1 Smuggler's Share
1 Arcane Signet
1 Azorius Signet
1 Commander's Sphere
1 Currency Converter
1 Dimir Signet
1 Fellwar Stone
1 Mask of Riddles
1 Mask of the Schemer
1 Orzhov Signet
1 Quietus Spike
1 Strionic Resonator
1 Sol Ring
1 Swiftfoot Boots
1 Wayfarer's Bauble
1 Fetid Heath
1 Creeping Tar Pit
1 Sunken Hollow
1 Choked Estuary
1 Arcane Sanctum
1 Darkwater Catacombs
1 Exotic Orchard
1 Port Town
1 Prairie Stream
1 Skycloud Expanse
1 Temple of Silence
1 Ash Barrens
1 Command Tower
1 Esper Panorama
1 Myriad Landscape
1 Obscura Storefront
1 Path of Ancestry
1 Rogue's Passage
1 Thriving Heath
1 Thriving Isle
1 Thriving Moor
5 Plains
6 Island
6 Swamp`,
  },
  ncc_riveteers_rampage: {
    label: "Riveteers Rampage (Henzie \"Toolbox\" Torre)",
    set: "Streets of New Capenna Commander",
    bracket: 2,
    text: `Commander
1 Henzie "Toolbox" Torre

Deck
1 The Beamtown Bullies
1 Jolene, the Plunder Queen
1 Caldaia Guardian
1 Mezzio Mugger
1 Wave of Rats
1 Weathered Sentinels
1 Bellowing Mauler
1 Grime Gorger
1 First Responder
1 Deathbringer Regent
1 Disciple of Bolas
1 Noxious Gearhulk
1 Etali, Primal Storm
1 Inferno Titan
1 Stalking Vengeance
1 Avenger of Zendikar
1 Giant Adephage
1 Greenwarden of Murasa
1 Mitotic Slime
1 Thragtusk
1 Treeshaker Chimera
1 Woodfall Primus
1 World Shaper
1 Kresh the Bloodbraided
1 Solemn Simulacrum
1 Artisan of Kozilek
1 Indrik Stomphowler
1 Overgrown Battlement
1 Temur Sabertooth
1 Riveteers Confluence
1 Aether Snap
1 Painful Truths
1 Blasphemous Act
1 Life's Legacy
1 Victimize
1 Explore
1 Farseek
1 Kodama's Reach
1 Migration Path
1 Rampant Growth
1 Chaos Warp
1 Riveteers Charm
1 Windgrace's Judgment
1 Terminate
1 Arcane Signet
1 Commander's Sphere
1 Fellwar Stone
1 Sol Ring
1 Dodgy Jalopy
1 Glittering Stockpile
1 Lifecrafter's Bestiary
1 Protection Racket
1 Industrial Advancement
1 Rain of Riches
1 Turf War
1 Next of Kin
1 Evolutionary Leap
1 Warstorm Surge
1 Garruk's Uprising
1 Deathreap Ritual
1 Cinder Glade
1 Exotic Orchard
1 Foreboding Ruins
1 Game Trail
1 Kessig Wolf Run
1 Mossfire Valley
1 Mosswort Bridge
1 Shadowblood Ridge
1 Smoldering Marsh
1 Spinerock Knoll
1 Temple of Malady
1 Twilight Mire
1 Ash Barrens
1 Blighted Woodland
1 Command Tower
1 Jund Panorama
1 Myriad Landscape
1 Path of Ancestry
1 Riveteers Overlook
1 Savage Lands
1 Temple of the False God
1 Thriving Bluff
1 Thriving Grove
1 Thriving Moor
4 Swamp
5 Mountain
6 Forest`,
  },
  sld_heads_i_win_tails_you_lo: {
    label: "Heads I Win, Tails You Lose (Zndrsplt, Eye of Wisdom & Okaun, Eye of Chaos)",
    set: "Secret Lair Commander",
    bracket: 2,
    text: `Commander
1 Zndrsplt, Eye of Wisdom
1 Okaun, Eye of Chaos

Deck
1 Daretti, Scrap Savant
1 Ral Zarek
1 Goblin Kaboomist
1 Krark, the Thumbless
1 Niv-Mizzet, Parun
1 Spark Double
1 Frenetic Sliver
1 Goblin Archaeologist
1 Karplusan Minotaur
1 Tavern Scoundrel
1 Tribute Mage
1 Bloodsworn Steward
1 Goblin Engineer
1 The Locust God
1 Yusri, Fortune's Flame
1 Mogg Assassin
1 Sakashima the Impostor
1 Stitch in Time
1 Blasphemous Act
1 Fabricate
1 Fiery Gambit
1 Chandra's Ignition
1 Gamble
1 Reshape
1 Seize the Day
1 Ponder
1 Preordain
1 Serum Visions
1 Slip Through Space
1 Squee's Revenge
1 Vandalblast
1 Negate
1 Chaos Warp
1 Whir of Invention
1 Counterspell
1 Long-Term Plans
1 Muddle the Mixture
1 Temur Battle Rage
1 Krark's Thumb
1 Izzet Signet
1 Lightning Greaves
1 Mind Stone
1 Swiftfoot Boots
1 Sword of Vengeance
1 Thought Vessel
1 Whispersilk Cloak
1 Boompile
1 Commander's Plate
1 Embercleave
1 Shadowspear
1 Arcane Signet
1 Crooked Scales
1 Sol Ring
1 Talisman of Creativity
1 Propaganda
1 Mirror March
1 Chance Encounter
1 Footfall Crater
1 Impulsive Maneuvers
1 Planar Chaos
1 Risky Move
1 Temple of Epiphany
1 Wandering Fumarole
1 Buried Ruin
1 Great Furnace
1 Izzet Boilerworks
1 Myriad Landscape
1 Path of Ancestry
1 Rogue's Passage
7 Island
8 Mountain
1 Academy Ruins
1 Cascade Bluffs
1 Desolate Lighthouse
1 Exotic Orchard
1 Flamekin Village
1 Inventors' Fair
1 Shivan Reef
1 Spinerock Knoll
1 Sulfur Falls
1 Tolaria West
1 Training Center
1 Command Tower
1 Reliquary Tower
1 Temple of the False God`,
  },
  nec_upgrades_unleashed: {
    label: "Upgrades Unleashed (Chishiro, the Shattered Blade)",
    set: "Kamigawa: Neon Dynasty Commander",
    bracket: 2,
    text: `Commander
1 Chishiro, the Shattered Blade

Deck
1 Kaima, the Fractured Calm
1 Ox of Agonas
1 Akki Battle Squad
1 Kami of Celebration
1 Komainu Battle Armor
1 Ascendant Acolyte
1 Kosei, Penitent Warlord
1 Rampant Rejuvenator
1 Tanuki Transplanter
1 Orochi Merge-Keeper
1 Towashi Guide-Bot
1 Walking Skyscraper
1 Agitator Ant
1 Goblin Razerunners
1 Krenko, Tin Street Kingpin
1 Taurean Mauler
1 Acidic Slime
1 Champion of Lambholt
1 Fertilid
1 Forgotten Ancient
1 Genesis Hydra
1 Loyal Guardian
1 Primeval Protector
1 Rishkar, Peema Renegade
1 Sakura-Tribe Elder
1 Spearbreaker Behemoth
1 Whiptongue Hydra
1 Grumgully, the Generous
1 Ulasht, the Hate Seed
1 Collision of Realms
1 Smoke Spirits' Aid
1 Chain Reaction
1 Kodama's Reach
1 Rampant Growth
1 Rishkar's Expertise
1 Shamanic Revelation
1 Soul's Majesty
1 Vastwood Surge
1 Decimate
1 Silkguard
1 Chaos Warp
1 Starstorm
1 Beast Within
1 Hunter's Insight
1 Mage Slayer
1 Arcane Signet
1 Blackblade Reforged
1 Bonehoard
1 Fireshrieker
1 Sol Ring
1 Swiftfoot Boots
1 Sword of Vengeance
1 Unquenchable Fury
1 Concord with the Kami
1 One with the Kami
1 Invigorating Hot Spring
1 Elemental Mastery
1 Shifting Shadow
1 Bear Umbra
1 Ordeal of Nylea
1 Snake Umbra
1 Rhythm of the Wild
1 Cinder Glade
1 Command Tower
1 Exotic Orchard
1 Game Trail
1 Gruul Turf
2 Mossfire Valley
1 Opal Palace
1 Oran-Rief, the Vastwood
1 Raging Ravine
1 Temple of Abandon
12 Mountain
14 Forest`,
  },
  voc_spirit_squadron: {
    label: "Spirit Squadron (Millicent, Restless Revenant)",
    set: "Innistrad: Crimson Vow Commander",
    bracket: 2,
    text: `Commander
1 Millicent, Restless Revenant

Deck
1 Dovin, Grand Arbiter
1 Donal, Herald of Wings
1 Rhoda, Geist Avenger
1 Timin, Youthful Geist
1 Drogskol Reinforcements
1 Priest of the Blessed Graf
1 Ethereal Investigator
1 Spectral Arcanist
1 Angel of Flight Alabaster
1 Boreas Charger
1 Bygone Bishop
1 Custodi Soulbinders
1 Hallowed Spiritkeeper
1 Hanged Executioner
1 Karmic Guide
1 Knight of the White Orchid
1 Mentor of the Meek
1 Mirror Entity
1 Oyobi, Who Split the Heavens
1 Remorseful Cleric
1 Twilight Drover
1 Windborn Muse
1 Ghostly Pilferer
1 Kami of the Crescent Moon
1 Rattlechains
1 Shacklegeist
1 Supreme Phantom
1 Geist of Saint Traft
1 Custodi Squire
1 Spectral Shepherd
1 Nebelgast Herald
1 Sire of the Storm
1 Spectral Sailor
1 Drogskol Captain
1 Storm of Souls
1 Haunting Imitation
1 Fell the Mighty
1 Kirtar's Wrath
1 Flood of Tears
1 Distant Melody
1 Sudden Salvation
1 Occult Epiphany
1 Disorder in the Court
1 Benevolent Offering
1 Crush Contraband
1 Swords to Plowshares
1 Arcane Denial
1 Midnight Clock
1 Arcane Signet
1 Azorius Locket
1 Azorius Signet
1 Commander's Sphere
1 Marble Diamond
1 Sky Diamond
1 Sol Ring
1 Haunted Library
1 Breath of the Sleepless
1 Promise of Bunrei
1 Imprisoned in the Moon
1 Verity Circle
1 Darksteel Mutation
1 Field of Souls
1 Ghostly Prison
1 Reconnaissance Mission
1 Exotic Orchard
1 Moorland Haunt
1 Port Town
1 Prairie Stream
1 Skycloud Expanse
1 Temple of Enlightenment
1 Azorius Chancery
1 Command Tower
1 Myriad Landscape
1 Path of Ancestry
1 Temple of the False God
1 Unclaimed Territory
12 Plains
11 Island`,
  },
  voc_vampiric_bloodline: {
    label: "Vampiric Bloodline (Strefan, Maurer Progenitor)",
    set: "Innistrad: Crimson Vow Commander",
    bracket: 2,
    text: `Commander
1 Strefan, Maurer Progenitor

Deck
1 Timothar, Baron of Bats
1 Crossway Troublemakers
1 Kamber, the Plunderer
1 Shadowgrange Archfiend
1 Laurine, the Diversion
1 Markov Enforcer
1 Midnight Arsonist
1 Scion of Opulence
1 Anowon, the Ruin Sage
1 Bloodlord of Vaasgoth
1 Bloodtracker
1 Butcher of Malakir
1 Champion of Dusk
1 Cordial Vampire
1 Dark Impostor
1 Malakir Bloodwitch
1 Necropolis Regent
1 Nirkana Revenant
1 Patron of the Vein
1 Sanctum Seeker
1 Stromkirk Condemned
1 Anje's Ravager
1 Bloodsworn Steward
1 Crimson Honor Guard
1 Falkenrath Gorger
1 Stromkirk Occultist
1 Vampiric Dragon
1 Bloodtithe Harvester
1 Blood Artist
1 Bloodline Necromancer
1 Falkenrath Noble
1 Indulgent Aristocrat
1 Vampire Nighthawk
1 Rakish Heir
1 Stromkirk Captain
1 Olivia's Wrath
1 Predators' Hour
1 Imposing Grandeur
1 Sinister Waltz
1 Damnable Pact
1 Avacyn's Judgment
1 Blasphemous Act
1 Mob Rule
1 Ancient Craving
1 Feed the Swarm
1 Night's Whisper
1 Vandalblast
1 Urge to Feed
1 Rakdos Charm
1 Glass-Cast Heart
1 Arcane Signet
1 Charcoal Diamond
1 Commander's Sphere
1 Fire Diamond
1 Rakdos Signet
1 Sol Ring
1 Swiftfoot Boots
1 Unstable Obelisk
1 Arterial Alchemy
1 Underworld Connections
1 Molten Echoes
1 Stensia Masquerade
1 Exotic Orchard
1 Foreboding Ruins
1 Shadowblood Ridge
1 Smoldering Marsh
1 Temple of Malice
1 Command Tower
1 Myriad Landscape
1 Path of Ancestry
1 Rakdos Carnarium
1 Tainted Peak
1 Temple of the False God
1 Unclaimed Territory
14 Swamp
11 Mountain`,
  },
  mic_coven_counters: {
    label: "Coven Counters (Leinore, Autumn Sovereign)",
    set: "Innistrad: Midnight Hunt Commander",
    bracket: 2,
    text: `Commander
1 Leinore, Autumn Sovereign

Deck
1 Angel of Glory's Rise
1 Bastion Protector
1 Custodi Soulbinders
1 Dearly Departed
1 Herald of War
1 Knight of the White Orchid
1 Mikaeus, the Lunarch
1 Odric, Master Tactician
1 Riders of Gavony
1 Victory's Envoy
1 Champion of Lambholt
1 Gyre Sage
1 Kessig Cagebreakers
1 Somberwald Sage
1 Verdurous Gearhulk
1 Wild Beastmaster
1 Heron's Grace Champion
1 Sigarda, Heron's Grace
1 Abzan Falconer
1 Ainok Bond-Kin
1 Elite Scaleguard
1 Orzhov Advokist
1 Avacyn's Pilgrim
1 Eternal Witness
1 Yavimaya Elder
1 Enduring Scalelord
1 Juniper Order Ranger
1 Trostani's Summoner
1 Cleansing Nova
1 Hour of Reckoning
1 Shamanic Revelation
1 Bestial Menace
1 Biogenic Upgrade
1 Growth Spasm
1 Unbreakable Formation
1 Return to Dust
1 Swords to Plowshares
1 Beast Within
1 Inspiring Call
1 Lifecrafter's Bestiary
1 Arcane Signet
1 Sol Ring
1 Swiftfoot Boots
1 Talisman of Unity
1 Citadel Siege
1 Death's Presence
1 Canopy Vista
1 Exotic Orchard
1 Fortified Village
1 Sungrass Prairie
1 Temple of Plenty
1 Blighted Woodland
1 Command Tower
1 Krosan Verge
1 Myriad Landscape
1 Path of Ancestry
1 Rogue's Passage
1 Selesnya Sanctuary
1 Temple of the False God
12 Forest
12 Plains
1 Kyler, Sigardian Emissary
1 Celestial Judgment
1 Curse of Conformity
1 Moorland Rescuer
1 Sigarda's Vanguard
1 Stalwart Pathlighter
1 Wall of Mourning
1 Celebrate the Harvest
1 Curse of Clinging Webs
1 Heronblade Elite
1 Kurbis, Harvest Celebrant
1 Ruinous Intrusion
1 Sigardian Zealot
1 Somberwald Beastmaster
1 Dawnhart Wardens
1 Moonsilver Key`,
  },
  mic_undead_unleashed: {
    label: "Undead Unleashed (Wilhelt, the Rotcleaver)",
    set: "Innistrad: Midnight Hunt Commander",
    bracket: 2,
    text: `Commander
1 Wilhelt, the Rotcleaver

Deck
1 Liliana, Death's Majesty
1 Forgotten Creation
1 Havengul Runebinder
1 Stitcher Geralf
1 Undead Alchemist
1 Butcher of Malakir
1 Cemetery Reaper
1 Death Baron
1 Diregraf Colossus
1 Eater of Hope
1 Gravespawn Sovereign
1 Midnight Reaper
1 Overseer of the Damned
1 Gisa and Geralf
1 Eternal Skylord
1 Corpse Augur
1 Fleshbag Marauder
1 Liliana's Devotee
1 Lord of the Accursed
1 Spark Reaper
1 Undead Augur
1 Diregraf Captain
1 Gleaming Overseer
1 Ruthless Deathfang
1 Hour of Eternity
1 Army of the Damned
1 Dark Salvation
1 Dread Summons
1 Zombie Apocalypse
1 Distant Melody
1 Feed the Swarm
1 Syphon Flesh
1 Aetherspouts
1 Go for the Throat
1 Arcane Signet
1 Charcoal Diamond
1 Commander's Sphere
1 Sky Diamond
1 Sol Ring
1 Talisman of Dominance
1 Rooftop Storm
1 Dreadhorde Invasion
1 Endless Ranks of the Dead
1 Liliana's Mastery
1 Open the Graves
1 Choked Estuary
1 Darkwater Catacombs
1 Exotic Orchard
1 Sunken Hollow
1 Temple of Deceit
1 Bojuka Bog
1 Command Tower
1 Dimir Aqueduct
1 Mortuary Mire
1 Myriad Landscape
1 Path of Ancestry
1 Tainted Isle
1 Unclaimed Territory
12 Island
15 Swamp
1 Eloise, Nephalia Sleuth
1 Cleaver Skaab
1 Curse of Unbinding
1 Drown in Dreams
1 Empty the Laboratory
1 Hordewing Skaab
1 Shadow Kin
1 Crowded Crypt
1 Curse of the Restless Dead
1 Ghouls' Night Out
1 Gorex, the Tombshell
1 Prowling Geistcatcher
1 Ravenous Rotbelly
1 Tomb Tyrant`,
  },
  c21_lorehold_legacies: {
    label: "Lorehold Legacies (Osgir, the Reconstructor)",
    set: "Commander 2021 (Strixhaven)",
    bracket: 2,
    text: `Commander
1 Osgir, the Reconstructor

Deck
1 Daretti, Scrap Savant
1 Combustible Gearhulk
1 Alibou, Ancient Witness
1 Angel of the Ruins
1 Bronze Guardian
1 Digsite Engineer
1 Losheel, Clockwork Scholar
1 Audacious Reshapers
1 Laelia, the Blade Reforged
1 Ruin Grinder
1 Triplicate Titan
1 Sun Titan
1 Feldon of the Third Path
1 Hellkite Igniter
1 Hellkite Tyrant
1 Hoard-Smelter Dragon
1 Pia Nalaar
1 Jor Kadeen, the Prevailer
1 Bosh, Iron Golem
1 Duplicant
1 Myr Battlesphere
1 Scrap Trawler
1 Solemn Simulacrum
1 Steel Hellkite
1 Steel Overseer
1 Sanctum Gargoyle
1 Quicksmith Genius
1 Thopter Engineer
1 Burnished Hart
1 Meteor Golem
1 Pilgrim's Eye
1 Excavation Technique
1 Wake the Past
1 Cleansing Nova
1 Rout
1 Chain Reaction
1 Secret Rendezvous
1 Reconstruct History
1 Rip Apart
1 Faithless Looting
1 Dispatch
1 Return to Dust
1 Boros Charm
1 Archaeomancer's Map
1 Battlemage's Bracers
1 Cursed Mirror
1 Key to the City
1 Sculpting Steel
1 Thousand-Year Elixir
1 Dispeller's Capsule
1 Arcane Signet
1 Boros Locket
1 Commander's Sphere
1 Hedron Archive
1 Ichor Wellspring
1 Mind Stone
1 Mycosynth Wellspring
1 Sol Ring
1 Unstable Obelisk
1 Monologue Tax
1 Darksteel Mutation
1 Battlefield Forge
1 Exotic Orchard
1 Slayers' Stronghold
1 Temple of Triumph
1 Lorehold Campus
1 Study Hall
1 Ancient Den
1 Boros Garrison
1 Command Tower
1 Darksteel Citadel
1 Forgotten Cave
1 Great Furnace
1 Myriad Landscape
1 Phyrexia's Core
1 Rogue's Passage
1 Secluded Steppe
1 Sunhome, Fortress of the Legion
1 Temple of the False God
12 Mountain
8 Plains`,
  },
  c21_prismari_performance: {
    label: "Prismari Performance (Zaffai, Thunder Conductor)",
    set: "Commander 2021 (Strixhaven)",
    bracket: 2,
    text: `Commander
1 Zaffai, Thunder Conductor

Deck
1 Jaya Ballard
1 Veyran, Voice of Duality
1 Dazzling Sphinx
1 Octavia, Living Thesis
1 Sly Instigator
1 Inferno Project
1 Radiant Performer
1 Rionya, Fire Dancer
1 Diluvian Primordial
1 Naru Meha, Master Wizard
1 Talrand, Sky Summoner
1 Charmbreaker Devils
1 Dualcaster Mage
1 Erratic Cyclops
1 Etali, Primal Storm
1 Wildfire Devils
1 Storm-Kiln Artist
1 Rootha, Mercurial Artist
1 Living Lore
1 Humble Defector
1 Crackling Drake
1 Inspiring Refrain
1 Muse Vortex
1 Creative Technique
1 Fiery Encore
1 Rousing Refrain
1 Surge to Victory
1 Aether Gale
1 Apex of Power
1 Blasphemous Act
1 Volcanic Vision
1 Call the Skybreaker
1 Epic Experiment
1 Elemental Masterpiece
1 Expressive Iteration
1 Ponder
1 Serum Visions
1 Treasure Cruise
1 Faithless Looting
1 Mana Geyser
1 Reinterpret
1 Aetherspouts
1 Dig Through Time
1 Resculpt
1 Brainstorm
1 Traumatic Visions
1 Fiery Fall
1 Seething Song
1 Letter of Acceptance
1 Arcane Signet
1 Hedron Archive
1 Izzet Signet
1 Mind Stone
1 Sol Ring
1 Talisman of Creativity
1 Metallurgic Summonings
1 Swarm Intelligence
1 Exotic Orchard
1 Scavenger Grounds
1 Shivan Reef
1 Temple of Epiphany
1 Prismari Campus
1 Study Hall
1 Blighted Cataract
1 Command Tower
1 Desert of the Fervent
1 Desert of the Mindful
1 Forgotten Cave
1 Izzet Boilerworks
1 Lonely Sandbar
1 Mage-Ring Network
1 Memorial to Genius
1 Myriad Landscape
1 Reliquary Tower
1 Temple of the False God
10 Island
9 Mountain
1 Elementalist's Palette
1 Mind's Desire
1 Brass's Bounty
1 Sunbird's Invocation
1 Pyromancer's Goggles`,
  },
  c21_quantum_quandrix: {
    label: "Quantum Quandrix (Adrix and Nev, Twincasters)",
    set: "Commander 2021 (Strixhaven)",
    bracket: 2,
    text: `Commander
1 Adrix and Nev, Twincasters

Deck
1 Garruk, Primal Hunter
1 Esix, Fractal Bloom
1 Curiosity Crafter
1 Deekah, Fractal Theorist
1 Spawning Kraken
1 Guardian Augmenter
1 Ruxa, Patient Professor
1 Desolation Twin
1 Champion of Wits
1 Crafty Cutpurse
1 Reef Worm
1 Arashi, the Sky Asunder
1 Forgotten Ancient
1 Hornet Nest
1 Hornet Queen
1 Hydra Broodmaster
1 Incubation Druid
1 Kazandu Tuskcaller
1 Managorger Hydra
1 Rampaging Baloths
1 Terastodon
1 Kaseto, Orochi Archmage
1 Master Biomancer
1 Biomathematician
1 Quandrix Cultivator
1 Zimone, Quandrix Prodigy
1 Coiling Oracle
1 Plaxcaster Frogling
1 Trygon Predator
1 Replication Technique
1 Oversimplify
1 Curse of the Swine
1 Rite of Replication
1 Shamanic Revelation
1 Spitting Image
1 Golden Ratio
1 Rampant Growth
1 Incubation // Incongruity
1 Perplexing Test
1 Theoretical Duplication
1 Return of the Wildspeaker
1 Biomass Mutation
1 Eureka Moment
1 Rapid Hybridization
1 Beast Within
1 Krosan Grip
1 Fractal Harness
1 Sequence Engine
1 Geometric Nexus
1 Idol of Oblivion
1 Arcane Signet
1 Simic Signet
1 Sol Ring
1 Paradox Zone
1 Primal Empathy
1 Exotic Orchard
1 Lumbering Falls
1 Mosswort Bridge
1 Oran-Rief, the Vastwood
1 Temple of Mystery
1 Yavimaya Coast
1 Quandrix Campus
1 Study Hall
1 Blighted Woodland
1 Command Tower
1 Llanowar Reborn
1 Lonely Sandbar
1 Myriad Landscape
1 Novijen, Heart of Progress
1 Opal Palace
1 Simic Growth Chamber
1 Temple of the False God
1 Tranquil Thicket
11 Forest
10 Island
1 Commander's Insight
1 Ezuri's Predation
1 Kodama's Reach
1 Nissa's Expedition
1 Rogue's Passage`,
  },
  c21_silverquill_statement: {
    label: "Silverquill Statement (Breena, the Demagogue)",
    set: "Commander 2021 (Strixhaven)",
    bracket: 2,
    text: `Commander
1 Breena, the Demagogue

Deck
1 Gideon, Champion of Justice
1 Felisa, Fang of Silverquill
1 Combat Calligrapher
1 Guardian Archon
1 Nils, Discipline Enforcer
1 Scholarship Sponsor
1 Author of Shadows
1 Bold Plagiarist
1 Fain, the Broker
1 Keen Duelist
1 Angel of Serenity
1 Boreas Charger
1 Hunted Lammasu
1 Knight of the White Orchid
1 Selfless Squire
1 Stalking Leonin
1 Sunscorch Regent
1 Windborn Muse
1 Zetalpa, Primal Dawn
1 Deathbringer Regent
1 Necropolis Regent
1 Deathbringer Liege
1 Magister of Worth
1 Teysa, Envoy of Ghosts
1 Elite Scaleguard
1 Oreskos Explorer
1 Orzhov Advokist
1 Promise of Loyalty
1 Incarnation Technique
1 Tragic Arrogance
1 Infernal Offering
1 Secret Rendezvous
1 Stinging Study
1 Inkshield
1 Oblation
1 Utter End
1 Fracture
1 Tempting Contract
1 Coveted Jewel
1 Pendant of Prosperity
1 Victory Chimes
1 Arcane Signet
1 Bloodthirsty Blade
1 Mind Stone
1 Orzhov Signet
1 Sol Ring
1 Spectral Searchlight
1 Cunning Rhetoric
1 Citadel Siege
1 Together Forever
1 Ghostly Prison
1 Martial Impetus
1 Soul Snare
1 Vow of Duty
1 Curse of Disturbance
1 Parasitic Impetus
1 Caves of Koilos
1 Exotic Orchard
1 Mikokoro, Center of the Sea
1 Temple of Silence
1 Silverquill Campus
1 Study Hall
1 Barren Moor
1 Bojuka Bog
1 Command Tower
1 Myriad Landscape
1 Opal Palace
1 Orzhov Basilica
1 Secluded Steppe
1 Tainted Field
1 Temple of the False God
14 Plains
10 Swamp
1 Duelist's Heritage
1 Debtors' Knell
1 Ambition's Cost
1 Rogue's Passage`,
  },
  c21_witherbloom_witchcraft: {
    label: "Witherbloom Witchcraft (Willowdusk, Essence Seer)",
    set: "Commander 2021 (Strixhaven)",
    bracket: 2,
    text: `Commander
1 Willowdusk, Essence Seer

Deck
1 Ob Nixilis Reignited
1 Gyome, Master Chef
1 Marshland Bloodcaster
1 Tivash, Gloom Summoner
1 Veinwitch Coven
1 Blossoming Bogbeast
1 Ezzaroot Channeler
1 Sproutback Trudge
1 Yedora, Grave Gardener
1 Bloodtracker
1 Defiant Bloodlord
1 Noxious Gearhulk
1 Sangromancer
1 Ageless Entity
1 Gluttonous Troll
1 Sapling of Colfenor
1 Honor Troll
1 Dina, Soul Steeper
1 Bloodthirsty Aerialist
1 Epicure of Blood
1 Silversmote Ghoul
1 Vampire Nighthawk
1 Leyline Prowler
1 Essence Pulse
1 Healing Technique
1 Pest Infestation
1 Revival Experiment
1 Damnable Pact
1 Deadly Tempest
1 Taste of Death
1 Gaze of Granite
1 Ancient Craving
1 Feed the Swarm
1 Cultivate
1 Rampant Growth
1 Mortality Spear
1 Reckless Spite
1 Suffer the Past
1 Pulse of Murasa
1 Druidic Satchel
1 Loxodon Warhammer
1 Well of Lost Dreams
1 Arcane Signet
1 Elixir of Immortality
1 Paradise Plume
1 Pristine Talisman
1 Sol Ring
1 Sun Droplet
1 Talisman of Resilience
1 Blight Mound
1 Trudge Garden
1 Sanguine Bond
1 Greed
1 Gift of Paradise
1 Moldervine Reclamation
1 Exotic Orchard
1 High Market
1 Llanowar Wastes
1 Temple of Malady
1 Witherbloom Campus
1 Study Hall
1 Blighted Woodland
1 Command Tower
1 Gingerbread Cabin
1 Golgari Rot Farm
1 Jungle Hollow
1 Myriad Landscape
1 Radiant Fountain
1 Sapseep Forest
1 Tainted Wood
1 Temple of the False God
11 Swamp
11 Forest
1 Witch's Clinic
1 Nissa's Renewal
1 Verdant Sun's Avatar
1 Alhammarret's Archive
1 Venser's Journal
1 Rogue's Passage`,
  },
  khc_elven_empire: {
    label: "Elven Empire (Lathril, Blade of the Elves)",
    set: "Kaldheim Commander",
    bracket: 2,
    text: `Commander
1 Lathril, Blade of the Elves

Deck
1 Abomination of Llanowar
1 Beast Whisperer
1 Canopy Tactician
1 Cultivator of Blades
1 Dwynen, Gilt-Leaf Daen
1 Elderfang Ritualist
1 Elvish Archdruid
1 Elvish Mystic
1 Elvish Rejuvenator
1 End-Raze Forerunners
1 Eyeblight Cullers
1 Farhaven Elf
1 Golgari Findbroker
1 Harald, King of Skemfar
1 Imperious Perfect
1 Jagged-Scar Archers
1 Jaspera Sentinel
1 Llanowar Tribe
1 Lys Alana Huntmaster
1 Lys Alana Scarblade
1 Marwyn, the Nurturer
1 Masked Admirers
1 Miara, Thorn of the Glade
1 Nullmage Shepherd
1 Numa, Joraga Chieftain
1 Poison-Tip Archer
1 Reclamation Sage
1 Rhys the Exiled
1 Ruthless Winnower
1 Shaman of the Pack
1 Skemfar Shadowsage
1 Springbloom Druid
1 Sylvan Messenger
1 Timberwatch Elf
1 Twinblade Assassins
1 Voice of Many
1 Voice of the Woods
1 Wirewood Channeler
1 Wolverine Riders
1 Wood Elves
1 Elven Ambush
1 Poison the Cup
1 Putrefy
1 Tergrid's Shadow
1 Ambition's Cost
1 Bounty of Skemfar
1 Casualties of War
1 Eyeblight Massacre
1 Elvish Promenade
1 Harvest Season
1 Pact of the Serpent
1 Return Upon the Tide
1 Roots of Wisdom
1 Arcane Signet
1 Serpent's Soul-Jar
1 Sol Ring
1 Binding the Old Gods
1 Crown of Skemfar
1 Elderfang Venom
1 Pride of the Perfect
1 Prowess of the Fair
1 Moldervine Reclamation
1 Command Tower
16 Forest
1 Foul Orchard
1 Golgari Guildgate
1 Golgari Rot Farm
1 Jungle Hollow
1 Myriad Landscape
1 Path of Ancestry
1 Skemfar Elderhall
13 Swamp`,
  },
  khc_phantom_premonition: {
    label: "Phantom Premonition (Ranar the Ever-Watchful)",
    set: "Kaldheim Commander",
    bracket: 2,
    text: `Commander
1 Ranar the Ever-Watchful

Deck
1 Angel of Finality
1 Angel of Serenity
1 Arcane Artisan
1 Brago, King Eternal
1 Burnished Hart
1 Cloudblazer
1 Cloudgoat Ranger
1 Empyrean Eagle
1 Ethereal Valkyrie
1 Evangel of Heliod
1 Flickerwisp
1 Geist-Honored Monk
1 Goldnight Commander
1 Hero of Bretagard
1 Inspired Sphinx
1 Kor Cartographer
1 Meteor Golem
1 Mist Raven
1 Mistmeadow Witch
1 Mulldrifter
1 Restoration Angel
1 Sage of the Beyond
1 Sea Gate Oracle
1 Soulherder
1 Stoic Farmer
1 Sun Titan
1 Surtland Elementalist
1 Thunderclap Wyvern
1 Vega, the Watcher
1 Wall of Omens
1 Whirler Rogue
1 Behold the Multiverse
1 Cosmic Intervention
1 Eerie Interlude
1 Ghostly Flicker
1 Iron Verdict
1 Momentary Blink
1 Return to Dust
1 Saw It Coming
1 Synthetic Destiny
1 Warhorn Blast
1 Cleansing Nova
1 Curse of the Swine
1 Migratory Route
1 Ravenform
1 Spectral Deluge
1 Storm Herd
1 Tales of the Ancestors
1 Windfall
1 Banishing Light
1 Day of the Dragons
1 Ghostly Prison
1 Marshal's Anthem
1 Niko Defies Destiny
1 Arcane Signet
1 Azorius Signet
1 Commander's Sphere
1 Marble Diamond
1 Mind Stone
1 Replicating Ring
1 Sky Diamond
1 Sol Ring
1 Swiftfoot Boots
1 Azorius Chancery
1 Azorius Guildgate
1 Command Tower
1 Cryptic Caves
1 Gates of Istfell
1 Glacial Floodplain
12 Island
1 Meandering River
1 Myriad Landscape
1 Opal Palace
13 Plains
1 Sejiri Refuge
1 Tranquil Cove`,
  },
  cmr_arm_for_battle: {
    label: "Arm for Battle (Wyleth, Soul of Steel)",
    set: "Commander Legends",
    bracket: 2,
    text: `Commander
1 Wyleth, Soul of Steel

Deck
1 Oreskos Explorer
1 Relic Seeker
1 Sram, Senior Edificer
1 Brass Squire
1 Danitha Capashen, Paragon
1 Dualcaster Mage
1 Flickerwisp
1 Ironclad Slayer
1 Kor Cartographer
1 Odric, Lunarch Marshal
1 Tiana, Ship's Caretaker
1 Condemn
1 Expedite
1 Swords to Plowshares
1 Abrade
1 Boros Charm
1 Comet Storm
1 Dawn Charm
1 Deflecting Palm
1 Disenchant
1 Fists of Flame
1 Temur Battle Rage
1 Valorous Stance
1 Generous Gift
1 Unbreakable Formation
1 Volcanic Fallout
1 Wear // Tear
1 White Sun's Zenith
1 Master Warcraft
1 Return to Dust
1 Wild Ricochet
1 Word of Seizing
1 Response // Resurgence
1 Jaya's Immolating Inferno
1 Martial Coup
1 Relentless Assault
1 Winds of Rath
1 Bonesplitter
1 Explorer's Scope
1 Sol Ring
1 Blackblade Reforged
1 Blazing Sunsteel
1 Boros Signet
1 Hero's Blade
1 Mask of Avacyn
1 Ring of Thune
1 Ring of Valkas
1 Swiftfoot Boots
1 Fireshrieker
1 Haunted Cloak
1 Loxodon Warhammer
1 Sunforger
1 Sword of Vengeance
1 Sigarda's Aid
1 Spirit Mantle
1 Timely Ward
1 Unquestioned Authority
1 Faith Unbroken
1 On Serra's Wings
1 Boros Garrison
1 Boros Guildgate
1 Command Tower
1 Encroaching Wastes
1 Evolving Wilds
1 Forgotten Cave
1 Memorial to War
9 Mountain
1 Myriad Landscape
14 Plains
1 Rogue's Passage
1 Rupture Spire
1 Secluded Steppe
1 Slayers' Stronghold
1 Stone Quarry
1 Sunhome, Fortress of the Legion
1 Terramorphic Expanse
1 Transguild Promenade
1 Wind-Scarred Crag`,
  },
  cmr_reap_the_tides: {
    label: "Reap the Tides (Aesi, Tyrant of Gyre Strait)",
    set: "Commander Legends",
    bracket: 2,
    text: `Commander
1 Aesi, Tyrant of Gyre Strait

Deck
1 Coiling Oracle
1 Eternal Witness
1 Ramunap Excavator
1 Reclamation Sage
1 Stumpsquall Hydra
1 Yavimaya Elder
1 Fathom Mage
1 Sharktocrab
1 Wickerbough Elder
1 Acidic Slime
1 Meloku the Clouded Mirror
1 Mulldrifter
1 Murkfiend Liege
1 Sporemound
1 Rampaging Baloths
1 Shipbreaker Kraken
1 Avenger of Zendikar
1 Meteor Golem
1 Molimo, Maro-Sorcerer
1 Nezahal, Primal Tide
1 Scourge of Fleets
1 Simic Sky Swallower
1 Sphinx of Uthuun
1 Trench Behemoth
1 Tromokratis
1 Verdant Sun's Avatar
1 Elder Deep-Fiend
1 Slinn Voda, the Rising Deep
1 Stormtide Leviathan
1 Terastodon
1 Arcane Denial
1 Counterspell
1 Growth Spiral
1 Into the Roil
1 Peel from Reality
1 Simic Charm
1 Beast Within
1 Fact or Fiction
1 Explore
1 Rampant Growth
1 Compulsive Research
1 Cultivate
1 Kodama's Reach
1 Search for Tomorrow
1 Harmonize
1 Whelming Wave
1 Urban Evolution
1 Spitting Image
1 Ior Ruin Expedition
1 Khalni Heart Expedition
1 Retreat to Kazandu
1 Sol Ring
1 Simic Signet
1 Swiftfoot Boots
1 Seer's Sundial
1 Blighted Woodland
1 Command Tower
1 Coral Atoll
1 Evolving Wilds
15 Forest
15 Island
1 Jungle Basin
1 Memorial to Genius
1 Reliquary Tower
1 Simic Growth Chamber
1 Simic Guildgate
1 Terramorphic Expanse
1 Thornwood Falls
1 Vivid Creek
1 Vivid Grove
1 Woodland Stream`,
  },
  znc_land_s_wrath: {
    label: "Land's Wrath (Obuun, Mul Daya Ancestor)",
    set: "Zendikar Rising Commander",
    bracket: 2,
    text: `Commander
1 Obuun, Mul Daya Ancestor

Deck
1 Admonition Angel
1 Trove Warden
1 Geode Rager
1 Emeria Angel
1 Emeria Shepherd
1 Sun Titan
1 Multani, Yavimaya's Avatar
1 Rampaging Baloths
1 Sylvan Advocate
1 Waker of the Wilds
1 Living Twister
1 Mina and Denn, Wildborn
1 Omnath, Locus of Rage
1 Abzan Falconer
1 Elite Scaleguard
1 Kor Cartographer
1 Acidic Slime
1 Armorcraft Judge
1 Elvish Rejuvenator
1 Embodiment of Insight
1 Evolution Sage
1 Fertilid
1 Keeper of Fables
1 Satyr Wayfinder
1 Sporemound
1 Springbloom Druid
1 Tuskguard Captain
1 Yavimaya Elder
1 Sandstone Oracle
1 Scaretiller
1 Murasa Rootgrazer
1 Hour of Revelation
1 Planar Outburst
1 Nissa's Renewal
1 Beanstalk Giant
1 Circuitous Route
1 Far Wanderings
1 Harmonize
1 Kodama's Reach
1 Ground Assault
1 Treacherous Terrain
1 Return of the Wildspeaker
1 Condemn
1 Crush Contraband
1 Harrow
1 Inspiring Call
1 Naya Charm
1 Sylvan Reclamation
1 Roiling Regrowth
1 Seer's Sundial
1 Arcane Signet
1 Sol Ring
1 Together Forever
1 Abundance
1 The Mending of Dominaria
1 Rites of Flourishing
1 Banishing Light
1 Retreat to Emeria
1 Khalni Heart Expedition
1 Retreat to Kazandu
1 Zendikar's Roil
1 Needle Spires
1 Blighted Woodland
1 Boros Garrison
1 Boros Guildgate
1 Command Tower
1 Cryptic Caves
1 Evolving Wilds
1 Gruul Guildgate
1 Gruul Turf
1 Jungle Shrine
1 Krosan Verge
1 Myriad Landscape
1 Naya Panorama
1 Selesnya Guildgate
1 Selesnya Sanctuary
1 Terramorphic Expanse
7 Plains
4 Mountain
10 Forest
1 Struggle // Survive`,
  },
  znc_sneak_attack: {
    label: "Sneak Attack (Anowon, the Ruin Thief)",
    set: "Zendikar Rising Commander",
    bracket: 2,
    text: `Commander
1 Anowon, the Ruin Thief

Deck
1 Lazav, Dimir Mastermind
1 Enigma Thief
1 Scourge of Fleets
1 Gonti, Lord of Luxury
1 Nighthowler
1 Ogre Slumlord
1 Sepulchral Primordial
1 Consuming Aberration
1 Notion Thief
1 Oona, Queen of the Fae
1 Sygg, River Cutthroat
1 Faerie Vandal
1 Invisible Stalker
1 Latchkey Faerie
1 Marang River Prowler
1 Master Thief
1 Nightveil Sprite
1 Slither Blade
1 Triton Shorestalker
1 Whirler Rogue
1 Changeling Outcast
1 Frogtosser Banneret
1 Marsh Flitter
1 Oona's Blackguard
1 Stinkdrinker Bandit
1 Syr Konrad, the Grim
1 Zulaport Cutthroat
1 Merfolk Windrobber
1 Sure-Footed Infiltrator
1 Soaring Thought-Thief
1 Notorious Throng
1 Stolen Identity
1 In Garruk's Wake
1 Necromantic Selection
1 Distant Melody
1 Open into Wonder
1 Endless Obedience
1 Rise from the Grave
1 Extract from Darkness
1 Fated Return
1 Silumgar's Command
1 Spinal Embrace
1 Aetherize
1 Fact or Fiction
1 Murder
1 Price of Fame
1 Soul Manipulation
1 Whispersteel Dagger
1 Blackblade Reforged
1 Bonehoard
1 Obelisk of Urd
1 Scytheclaw
1 Arcane Signet
1 Commander's Sphere
1 Dimir Keyrune
1 Dimir Locket
1 Dimir Signet
1 Heirloom Blade
1 Mind Stone
1 Sol Ring
1 Military Intelligence
1 Command Tower
1 Dimir Aqueduct
1 Dimir Guildgate
1 Dismal Backwater
1 Jwar Isle Refuge
1 Myriad Landscape
1 Rogue's Passage
1 Submerged Boneyard
15 Island
15 Swamp`,
  },
  c20_arcane_maelstrom: {
    label: "Arcane Maelstrom (Kalamax, the Stormsire)",
    set: "Commander 2020 (Ikoria)",
    bracket: 2,
    text: `Commander
1 Kalamax, the Stormsire

Deck
1 Jace, Architect of Thought
1 Xyris, the Writhing Storm
1 Haldan, Avid Arcanist
1 Pako, Arcane Retriever
1 Eon Frolicker
1 Nascent Metamorph
1 Glademuse
1 Ravenous Gigantotherium
1 Lunar Mystic
1 Niblis of Frost
1 Talrand, Sky Summoner
1 Charmbreaker Devils
1 Dualcaster Mage
1 Etali, Primal Storm
1 Goblin Dark-Dwellers
1 Djinn Illuminatus
1 Melek, Izzet Paragon
1 Rashmi, Eternities Crafter
1 Wort, the Raidmother
1 Solemn Simulacrum
1 Murmuring Mystic
1 Crackling Drake
1 Surreal Memoir
1 Decoy Gambit
1 Deflecting Swat
1 Curious Herd
1 Chaos Warp
1 Comet Storm
1 Commune with Lava
1 Starstorm
1 Strength of the Tajuru
1 Artifact Mutation
1 Prophetic Bolt
1 Clash of Titans
1 Channeled Force
1 Chemister's Insight
1 Frantic Search
1 Whiplash Trap
1 Crop Rotation
1 Evolution Charm
1 Harrow
1 Hunter's Insight
1 Hunting Pack
1 Natural Connection
1 Slice in Twain
1 Tribute to the Wild
1 Growth Spiral
1 Temur Charm
1 Lavabrink Floodgates
1 Twinning Staff
1 Bonder's Ornament
1 Arcane Signet
1 Commander's Sphere
1 Lightning Greaves
1 Sol Ring
1 Swarm Intelligence
1 Primal Empathy
1 Psychic Impetus
1 Shiny Impetus
1 Predatory Impetus
1 Wilderness Reclamation
1 Cinder Glade
1 Desolate Lighthouse
1 Exotic Orchard
1 Kessig Wolf Run
1 Mossfire Valley
1 Mosswort Bridge
1 Oran-Rief, the Vastwood
1 Scavenger Grounds
1 Yavimaya Coast
1 Command Tower
1 Frontier Bivouac
1 Gruul Turf
1 Halimar Depths
1 Izzet Boilerworks
1 Myriad Landscape
1 Rupture Spire
1 Simic Growth Chamber
1 Rugged Highlands
1 Swiftwater Cliffs
1 Thornwood Falls
8 Forest
5 Island
5 Mountain`,
  },
  c20_enhanced_evolution: {
    label: "Enhanced Evolution (Otrimi, the Ever-Playful)",
    set: "Commander 2020 (Ikoria)",
    bracket: 2,
    text: `Commander
1 Otrimi, the Ever-Playful

Deck
1 Nissa, Steward of Elements
1 Zaxara, the Exemplary
1 Cazur, Ruthless Stalker
1 Ukkima, Stalking Shadow
1 Souvenir Snatcher
1 Tidal Barracuda
1 Boneyard Mycodrax
1 Mindleecher
1 Capricopian
1 Sawtusk Demolisher
1 Beast Whisperer
1 Genesis Hydra
1 Hungering Hydra
1 Masked Admirers
1 Predator Ooze
1 Vastwood Hydra
1 Vorapede
1 Cold-Eyed Selkie
1 Wydwen, the Biting Gale
1 Silent Arbiter
1 Archipelagore
1 Dreamtail Heron
1 Pouncing Shoreshark
1 Cavern Whisperer
1 Chittering Harvester
1 Insatiable Hemophage
1 Auspicious Starrix
1 Fertilid
1 Glowstone Recluse
1 Migratory Greathorn
1 Boneyard Lurker
1 Trumpeting Gnarr
1 Illusory Ambusher
1 Mulldrifter
1 Shriekmaw
1 Heroes' Bane
1 Reclamation Sage
1 Yavimaya Dryad
1 Trygon Predator
1 Dredge the Mire
1 Mind Spring
1 Deadly Tempest
1 Profane Command
1 Animist's Awakening
1 Find // Finality
1 Gaze of Granite
1 Villainous Wealth
1 Migration Path
1 Kodama's Reach
1 Deadly Rollick
1 Beast Within
1 Krosan Grip
1 Putrefy
1 Manascape Refractor
1 Lifecrafter's Bestiary
1 Bonder's Ornament
1 Arcane Signet
1 Sol Ring
1 Psychic Impetus
1 Parasitic Impetus
1 Predatory Impetus
1 Propaganda
1 Darkwater Catacombs
1 Endless Sands
1 Exotic Orchard
1 Llanowar Wastes
1 Sunken Hollow
1 Blighted Woodland
1 Command Tower
1 Dimir Aqueduct
1 Golgari Rot Farm
1 Mortuary Mire
1 Myriad Landscape
1 Opulent Palace
1 Rogue's Passage
1 Simic Growth Chamber
1 Soaring Seacliff
1 Temple of the False God
1 Dismal Backwater
1 Jungle Hollow
1 Thornwood Falls
5 Swamp
11 Forest
2 Island`,
  },
  c20_ruthless_regiment: {
    label: "Ruthless Regiment (Jirina Kudro)",
    set: "Commander 2020 (Ikoria)",
    bracket: 2,
    text: `Commander
1 Jirina Kudro

Deck
1 Nahiri, the Harbinger
1 Kelsien, the Plague
1 Trynn, Champion of Freedom
1 Silvar, Devourer of the Free
1 Verge Rangers
1 Species Specialist
1 Titan Hunter
1 Fireflux Squad
1 Frontier Warmonger
1 Bounty Agent
1 Dearly Departed
1 Frontline Medic
1 Knight of the White Orchid
1 Magus of the Disk
1 Odric, Master Tactician
1 Riders of Gavony
1 Thalia's Lieutenant
1 Thraben Doomsayer
1 Disciple of Bolas
1 Xathrid Necromancer
1 Alesha, Who Smiles at Death
1 Captivating Crew
1 Fumiko the Lowblood
1 Magus of the Wheel
1 Titan of Eternal Fire
1 Adriana, Captain of the Guard
1 General's Enforcer
1 Banisher Priest
1 Cavalry Pegasus
1 Devout Chaplain
1 Zulaport Cutthroat
1 Humble Defector
1 Garna, the Bloodflame
1 Citywide Bust
1 Cleansing Nova
1 Increasing Devotion
1 Painful Truths
1 Ambition's Cost
1 Call the Coppercoats
1 Flawless Maneuver
1 Unexpectedly Absent
1 Crackling Doom
1 Dire Tactics
1 Terminate
1 Sanctuary Blade
1 Bonder's Ornament
1 Arcane Signet
1 Boros Signet
1 Commander's Sphere
1 Heirloom Blade
1 Orzhov Signet
1 Rakdos Signet
1 Skullclamp
1 Sol Ring
1 Molten Echoes
1 Outpost Siege
1 Shared Animosity
1 Sanctuary Lockdown
1 Bastion of Remembrance
1 Martial Impetus
1 Parasitic Impetus
1 Shiny Impetus
1 Vigilante Justice
1 Battlefield Forge
1 Exotic Orchard
1 Shadowblood Ridge
1 Smoldering Marsh
1 Spinerock Knoll
1 Windbrisk Heights
1 Bojuka Bog
1 Boros Garrison
1 Command Tower
1 Myriad Landscape
1 Nomad Outpost
1 Orzhov Basilica
1 Path of Ancestry
1 Rakdos Carnarium
1 Temple of the False God
1 Unclaimed Territory
1 Bloodfell Caves
1 Evolving Wilds
1 Scoured Barrens
1 Wind-Scarred Crag
4 Mountain
8 Plains
4 Swamp`,
  },
  c20_symbiotic_swarm: {
    label: "Symbiotic Swarm (Kathril, Aspect Warper)",
    set: "Commander 2020 (Ikoria)",
    bracket: 2,
    text: `Commander
1 Kathril, Aspect Warper

Deck
1 Ajani Unyielding
1 Tayam, Luminous Enigma
1 Nikara, Lair Scavenger
1 Yannik, Scavenging Sentinel
1 Avenging Huntbonder
1 Cartographer's Hawk
1 Vitality Hunter
1 Daring Fiendbonder
1 Slippery Bogbonder
1 Akroma, Angel of Wrath
1 Angel of Finality
1 Cataclysmic Gearhulk
1 Kalemne's Captain
1 Odric, Lunarch Marshal
1 Reveillark
1 Solemn Recruit
1 Sunblast Angel
1 Zetalpa, Primal Dawn
1 Cairn Wanderer
1 Soul of Innistrad
1 Soulflayer
1 Hornet Queen
1 Majestic Myriarch
1 Splinterfright
1 Archon of Valor's Reach
1 Karametra, God of Harvests
1 Void Beckoner
1 Titanoth Rex
1 Aerial Responder
1 Vampire Nighthawk
1 Acidic Slime
1 Sakura-Tribe Elder
1 Satyr Wayfinder
1 Skullwinder
1 Nyx Weaver
1 Selective Adaptation
1 Ever After
1 Duneblast
1 Unbreakable Bond
1 Unburial Rites
1 Cultivate
1 Harmonize
1 Obscuring Haze
1 Blood Curdle
1 Abzan Charm
1 Deathsprout
1 Despark
1 Grisly Salvage
1 Netherborn Altar
1 Mimic Vat
1 Bonder's Ornament
1 Arcane Signet
1 Commander's Sphere
1 Sol Ring
1 Swiftfoot Boots
1 Together Forever
1 Abzan Ascendancy
1 Deadbridge Chant
1 Martial Impetus
1 Parasitic Impetus
1 Predatory Impetus
1 Nesting Grounds
1 Canopy Vista
1 Caves of Koilos
1 Exotic Orchard
1 Gavony Township
1 Grim Backwoods
1 Sungrass Prairie
1 Blighted Woodland
1 Command Tower
1 Golgari Rot Farm
1 Krosan Verge
1 Memorial to Folly
1 Myriad Landscape
1 Orzhov Basilica
1 Sandsteppe Citadel
1 Selesnya Sanctuary
1 Blossoming Sands
1 Evolving Wilds
1 Jungle Hollow
1 Scoured Barrens
7 Plains
7 Swamp
4 Forest`,
  },
  c20_timeless_wisdom: {
    label: "Timeless Wisdom (Gavi, Nest Warden)",
    set: "Commander 2020 (Ikoria)",
    bracket: 2,
    text: `Commander
1 Gavi, Nest Warden

Deck
1 Chandra, Flamecaller
1 Akim, the Soaring Wind
1 Brallin, Skyshark Rider
1 Shabraz, the Skyshark
1 Cryptic Trilobite
1 Herald of the Forgotten
1 Ethereal Forager
1 Agitator Ant
1 Spellpyre Phoenix
1 Surly Badgersaur
1 Eternal Dragon
1 Sun Titan
1 Curator of Mysteries
1 Nimble Obstructionist
1 Portal Mage
1 Isperia, Supreme Judge
1 Mercurial Chemister
1 Niv-Mizzet, the Firemind
1 The Locust God
1 Psychosis Crawler
1 Valiant Rescuer
1 Rooting Moloch
1 Savai Thundermane
1 Vizier of Tumbling Sands
1 Dismantling Wave
1 Akroma's Vengeance
1 Decree of Justice
1 Descend upon the Sinful
1 Boon of the Wish-Giver
1 Windfall
1 Slice and Dice
1 Migratory Route
1 Fierce Guardianship
1 Neutralize
1 Zenith Flare
1 Hieroglyphic Illumination
1 Abandoned Sarcophagus
1 Fluctuator
1 Bonder's Ornament
1 Arcane Signet
1 Azorius Signet
1 Boros Signet
1 Commander's Sphere
1 Izzet Signet
1 Sol Ring
1 Raugrin Crystal
1 Crystalline Resonance
1 Astral Drift
1 Hoofprints of the Stag
1 Drake Haven
1 New Perspectives
1 Tectonic Reformation
1 Ominous Seas
1 Reconnaissance Mission
1 Martial Impetus
1 Psychic Impetus
1 Shiny Impetus
1 Cast Out
1 Spirit Cairn
1 Lightning Rift
1 Exotic Orchard
1 Hostile Desert
1 Irrigated Farmland
1 Prairie Stream
1 Shivan Reef
1 Skycloud Expanse
1 Ash Barrens
1 Azorius Chancery
1 Boros Garrison
1 Command Tower
1 Desert of the Fervent
1 Desert of the Mindful
1 Desert of the True
1 Drifting Meadow
1 Forgotten Cave
1 Izzet Boilerworks
1 Lonely Sandbar
1 Myriad Landscape
1 Mystic Monastery
1 Reliquary Tower
1 Remote Isle
1 Secluded Steppe
1 Smoldering Crater
1 Temple of the False God
5 Island
6 Mountain
4 Plains`,
  },
  c19_faceless_menace: {
    label: "Faceless Menace (Kadena, Slinking Sorcerer)",
    set: "Commander 2019",
    bracket: 2,
    text: `Commander
1 Kadena, Slinking Sorcerer

Deck
1 Vraska the Unseen
1 Rayami, First of the Fallen
1 Volrath, the Shapestealer
1 Kadena's Silencer
1 Thought Sponge
1 Thieving Amalgam
1 Apex Altisaur
1 Grismold, the Dreadsower
1 Deathmist Raptor
1 Hooded Hydra
1 Chromeshell Crab
1 Ixidron
1 Kheru Spellsnatcher
1 Stratus Dancer
1 Thousand Winds
1 Vesuvan Shapeshifter
1 Bane of the Living
1 Grim Haruspex
1 Silumgar Assassin
1 Den Protector
1 Seedborn Muse
1 Thelonite Hermit
1 Sagu Mauler
1 Voice of Many
1 Scaretiller
1 Willbender
1 Skinthinner
1 Ainok Survivalist
1 Great Oak Guardian
1 Nantuko Vigilante
1 Sakura-Tribe Elder
1 Icefeather Aven
1 Road of Return
1 Ghastly Conscription
1 Hex
1 Overwhelming Stampede
1 Tempt with Discovery
1 Mire in Misery
1 Tezzeret's Gambit
1 Cultivate
1 Explore
1 Farseek
1 Urban Evolution
1 Sudden Substitution
1 Biomass Mutation
1 Leadership Vacuum
1 Echoing Truth
1 Reality Shift
1 Putrefy
1 Sultai Charm
1 Pendant of Prosperity
1 Scroll of Fate
1 Strionic Resonator
1 Sol Ring
1 Thran Dynamo
1 Gift of Doom
1 Trail of Mystery
1 Bounty of the Luxa
1 Secret Plans
1 Darkwater Catacombs
1 Exotic Orchard
1 Llanowar Wastes
1 Shrine of the Forsaken Gods
1 Sunken Hollow
1 Thespian's Stage
1 Yavimaya Coast
5 Island
3 Swamp
7 Forest
1 Ash Barrens
1 Bojuka Bog
1 Command Tower
1 Dimir Aqueduct
1 Evolving Wilds
1 Foul Orchard
1 Golgari Guildgate
1 Golgari Rot Farm
1 Jungle Hollow
1 Myriad Landscape
1 Opulent Palace
1 Reliquary Tower
1 Simic Growth Chamber
1 Simic Guildgate
1 Temple of the False God
1 Terramorphic Expanse
1 Thornwood Falls
1 Woodland Stream`,
  },
  c19_merciless_rage: {
    label: "Merciless Rage (Anje Falkenrath)",
    set: "Commander 2019",
    bracket: 2,
    text: `Commander
1 Anje Falkenrath

Deck
1 Ob Nixilis Reignited
1 Chainer, Nightmare Adept
1 Greven, Predator Captain
1 Archfiend of Spite
1 Bone Miser
1 K'rrik, Son of Yawgmoth
1 Anje's Ravager
1 Skyfire Phoenix
1 Wildfire Devils
1 Champion of Stray Souls
1 Geth, Lord of the Vault
1 Soul of Innistrad
1 Asylum Visitor
1 Doomed Necromancer
1 Overseer of the Damned
1 Flayer of the Hatebound
1 Magus of the Wheel
1 Squee, Goblin Nabob
1 Stromkirk Occultist
1 Bloodhall Priest
1 Solemn Simulacrum
1 Scaretiller
1 Big Game Hunter
1 Gorgon Recluse
1 Grave Scrabbler
1 Nightshade Assassin
1 Plaguecrafter
1 Sanitarium Skeleton
1 Meteor Golem
1 Nightmare Unmaking
1 Boneyard Parley
1 Beacon of Unrest
1 From Under the Floorboards
1 In Garruk's Wake
1 Avacyn's Judgment
1 Mire in Misery
1 Hate Mirage
1 Call to the Netherworld
1 Murderous Compulsion
1 Alchemist's Greeting
1 Malevolent Whispers
1 Chaos Warp
1 Dark Withering
1 Fiery Temper
1 Violent Eruption
1 Aeon Engine
1 Grimoire of the Dead
1 Key to the City
1 Bloodthirsty Blade
1 Armillary Sphere
1 Hedron Archive
1 Rakdos Locket
1 Sol Ring
1 Curse of Fool's Wisdom
1 Hedonist's Trove
1 Warstorm Surge
1 Faith of the Devoted
1 The Eldest Reborn
1 Zombie Infestation
1 Sanctum of Eternity
1 Drownyard Temple
1 Exotic Orchard
1 Geier Reach Sanitarium
10 Swamp
10 Mountain
1 Akoum Refuge
1 Ash Barrens
1 Barren Moor
1 Bloodfell Caves
1 Cinder Barrens
1 Command Tower
1 Evolving Wilds
1 Forgotten Cave
1 Memorial to Folly
1 Mortuary Mire
1 Myriad Landscape
1 Rakdos Carnarium
1 Rakdos Guildgate
1 Rix Maadi, Dungeon Palace
1 Terramorphic Expanse
1 Temple of the False God`,
  },
  c19_mystic_intellect: {
    label: "Mystic Intellect (Sevinne, the Chronoclasm)",
    set: "Commander 2019",
    bracket: 2,
    text: `Commander
1 Sevinne, the Chronoclasm

Deck
1 Ral Zarek
1 Elsha of the Infinite
1 Pramikon, Sky Rampart
1 Thalia's Geistcaller
1 Wall of Stolen Identity
1 Backdraft Hellkite
1 Dockside Extortionist
1 Gerrard, Weatherlight Hero
1 Pristine Angel
1 Sun Titan
1 Clever Impersonator
1 Zetalpa, Primal Dawn
1 River Kelpie
1 Talrand, Sky Summoner
1 Pristine Skywise
1 Cliffside Rescuer
1 Scaretiller
1 Guttersnipe
1 Crackling Drake
1 Burnished Hart
1 Sevinne's Reclamation
1 Mass Diminish
1 Ignite the Future
1 Divine Reckoning
1 Dusk // Dawn
1 Increasing Devotion
1 Storm Herd
1 Devil's Play
1 Deep Analysis
1 Mystic Retrieval
1 Runic Repetition
1 Faithless Looting
1 Rolling Temblor
1 Mandate of Peace
1 Increasing Vengeance
1 Magmaquake
1 Refuse // Cooperate
1 Leadership Vacuum
1 Prismatic Strands
1 Purify the Grave
1 Ray of Distortion
1 Chemister's Insight
1 Fact or Fiction
1 Fervent Denial
1 Oona's Grace
1 Think Twice
1 Desperate Ravings
1 Farm // Market
1 Empowered Autogenerator
1 Bloodthirsty Blade
1 Armillary Sphere
1 Azorius Locket
1 Commander's Sphere
1 Izzet Locket
1 Sol Ring
1 Jace's Sanctum
1 Ghostly Prison
1 Secrets of the Dead
1 Burning Vengeance
1 Exotic Orchard
1 Prairie Stream
9 Plains
8 Island
4 Mountain
1 Ash Barrens
1 Azorius Chancery
1 Boros Garrison
1 Boros Guildgate
1 Command Tower
1 Evolving Wilds
1 Highland Lake
1 Izzet Boilerworks
1 Izzet Guildgate
1 Myriad Landscape
1 Mystic Monastery
1 Stone Quarry
1 Swiftwater Cliffs
1 Temple of the False God
1 Terramorphic Expanse
1 Tranquil Cove
1 Wind-Scarred Crag`,
  },
  c19_primal_genesis: {
    label: "Primal Genesis (Ghired, Conclave Exile)",
    set: "Commander 2019",
    bracket: 2,
    text: `Commander
1 Ghired, Conclave Exile

Deck
1 Garruk, Primal Hunter
1 Atla Palani, Nest Tender
1 Marisi, Breaker of the Coil
1 Doomed Artisan
1 Tectonic Hellion
1 Ohran Frostfang
1 Selesnya Eulogist
1 Tahngarth, First Mate
1 Angel of Sanctions
1 Wingmate Roc
1 Dragonmaster Outcast
1 Feldon of the Third Path
1 Giant Adephage
1 Soul of Zendikar
1 Trostani, Selesnya's Voice
1 Desolation Twin
1 Flamerush Rider
1 Heart-Piercer Manticore
1 Rampaging Baloths
1 Thragtusk
1 Emmara Tandris
1 Wayfaring Temple
1 Cliffside Rescuer
1 Voice of Many
1 Scaretiller
1 Roc Egg
1 Garruk's Packleader
1 Sakura-Tribe Elder
1 Vitu-Ghazi Guildmage
1 Ghired's Belligerence
1 Full Flowering
1 Hour of Reckoning
1 Phyrexian Rebirth
1 Shamanic Revelation
1 Hate Mirage
1 Cultivate
1 Explore
1 Farseek
1 Harmonize
1 Fresh Meat
1 Momentous Fall
1 Second Harvest
1 Rootborn Defenses
1 Trostani's Judgment
1 Beast Within
1 Druid's Deliverance
1 Slice in Twain
1 Naya Charm
1 Sundering Growth
1 Idol of Oblivion
1 Mimic Vat
1 Soul Foundry
1 Lightning Greaves
1 Sol Ring
1 Commander's Insignia
1 Song of the Worldsoul
1 Growing Ranks
1 Intangible Virtue
1 Colossal Majesty
1 Elemental Bond
1 Cinder Glade
1 Exotic Orchard
1 Gargoyle Castle
1 Sungrass Prairie
7 Plains
4 Mountain
8 Forest
1 Ash Barrens
1 Blossoming Sands
1 Boros Garrison
1 Command Tower
1 Evolving Wilds
1 Graypelt Refuge
1 Gruul Turf
1 Jungle Shrine
1 Kazandu Refuge
1 Krosan Verge
1 Myriad Landscape
1 Naya Panorama
1 Rogue's Passage
1 Rugged Highlands
1 Selesnya Sanctuary
1 Terramorphic Expanse`,
  },
  c18_adaptive_enchantment: {
    label: "Adaptive Enchantment (Estrid, the Masked)",
    set: "Commander 2018",
    bracket: 2,
    text: `Commander
1 Estrid, the Masked

Deck
1 Bruna, Light of Alabaster
1 Eidolon of Blossoms
1 Hydra Omnivore
1 Ajani's Chosen
1 Celestial Archon
1 Silent Sentinel
1 Boon Satyr
1 Herald of the Pantheon
1 Cold-Eyed Selkie
1 Daxos of Meletis
1 Elderwood Scion
1 Archetype of Imagination
1 Whitewater Naiads
1 Aura Gnarlid
1 Reclamation Sage
1 Yavimaya Enchantress
1 Martial Coup
1 Phyrexian Rebirth
1 Winds of Rath
1 Creeping Renaissance
1 Kruphix's Insight
1 Dismantling Blow
1 Bant Charm
1 Sol Ring
1 Sigil of the Empty Throne
1 Dictate of Kruphix
1 Bear Umbra
1 Enchantress's Presence
1 Epic Proportions
1 Ground Seal
1 Spawning Grounds
1 Finest Hour
1 Righteous Authority
1 Sage's Reverie
1 Soul Snare
1 Unquestioned Authority
1 Eel Umbra
1 Vow of Flight
1 Dawn's Reflection
1 Fertile Ground
1 Overgrowth
1 Snake Umbra
1 Vow of Wildness
1 Wild Growth
1 Unflinching Courage
9 Plains
6 Island
8 Forest
1 Azorius Chancery
1 Blossoming Sands
1 Command Tower
1 Evolving Wilds
1 Krosan Verge
1 Meandering River
1 Mosswort Bridge
1 Seaside Citadel
1 Selesnya Sanctuary
1 Simic Growth Chamber
1 Terramorphic Expanse
1 Thornwood Falls
1 Tranquil Cove
1 Tranquil Expanse
1 Woodland Stream
1 Kestia, the Cultivator
1 Tuvasa the Sunlit
1 Empyrial Storm
1 Heavenly Blademaster
1 Estrid's Invocation
1 Ever-Watching Threshold
1 Octopus Umbra
1 Genesis Storm
1 Myth Unbound
1 Nylea's Colossus
1 Ravenous Slime
1 Arixmethes, Slumbering Isle
1 Loyal Unicorn
1 Loyal Drake
1 Loyal Guardian
1 Forge of Heroes`,
  },
  c18_exquisite_invention: {
    label: "Exquisite Invention (Saheeli, the Gifted)",
    set: "Commander 2018",
    bracket: 2,
    text: `Commander
1 Saheeli, the Gifted

Deck
1 Maverick Thopterist
1 Soul of New Phyrexia
1 Inkwell Leviathan
1 Sharding Sphinx
1 Hellkite Igniter
1 Bosh, Iron Golem
1 Darksteel Juggernaut
1 Duplicant
1 Myr Battlesphere
1 Psychosis Crawler
1 Scuttling Doom Engine
1 Steel Hellkite
1 Thopter Assembly
1 Etherium Sculptor
1 Whirler Rogue
1 Chief of the Foundry
1 Pilgrim's Eye
1 Saheeli's Artistry
1 Blasphemous Act
1 Reverse Engineer
1 Tidings
1 Chaos Warp
1 Magmaquake
1 Into the Roil
1 Thirst for Knowledge
1 Blinkmoth Urn
1 Mimic Vat
1 Mirrorworks
1 Prototype Portal
1 Unwinding Clock
1 Commander's Sphere
1 Dreamstone Hedron
1 Hedron Archive
1 Izzet Signet
1 Magnifying Glass
1 Mind Stone
1 Prismatic Lens
1 Scrabbling Claws
1 Sol Ring
1 Swiftfoot Boots
1 Unstable Obelisk
1 Vessel of Endless Rest
1 Worn Powerstone
1 Darksteel Citadel
1 Great Furnace
1 Seat of the Synod
1 Thopter Spy Network
15 Island
12 Mountain
1 Buried Ruin
1 Command Tower
1 Foundry of the Consuls
1 Highland Lake
1 Izzet Boilerworks
1 Izzet Guildgate
1 Swiftwater Cliffs
1 Brudiclad, Telchor Engineer
1 Tawnos, Urza's Apprentice
1 Echo Storm
1 Vedalken Humiliator
1 Enchanter's Bane
1 Saheeli's Directive
1 Treasure Nabber
1 Varchild, Betrayer of Kjeldor
1 Ancient Stone Idol
1 Coveted Jewel
1 Endless Atlas
1 Retrofitter Foundry
1 Aether Gale
1 Loyal Drake
1 Loyal Apprentice
1 Geode Golem
1 Thopter Engineer
1 Forge of Heroes`,
  },
  c18_nature_s_vengeance: {
    label: "Nature's Vengeance (Lord Windgrace)",
    set: "Commander 2018",
    bracket: 2,
    text: `Commander
1 Lord Windgrace

Deck
1 Charnelhoard Wurm
1 Avenger of Zendikar
1 Soul of Innistrad
1 Flameblast Dragon
1 Budoka Gardener
1 Centaur Vinecrasher
1 Moldgraf Monstrosity
1 Rampaging Baloths
1 Scute Mob
1 Rubblehulk
1 Acidic Slime
1 Baloth Woodcrasher
1 Borderland Explorer
1 Farhaven Elf
1 Sakura-Tribe Elder
1 Yavimaya Elder
1 Zendikar Incarnate
1 Ruinous Path
1 Chain Reaction
1 Decimate
1 Gaze of Granite
1 Lavalanche
1 Worm Harvest
1 Stitch Together
1 Cultivate
1 Explore
1 Explosive Vegetation
1 Far Wanderings
1 Hunting Wilds
1 Savage Twister
1 Moonlight Bargain
1 Consign to Dust
1 Grapple with the Past
1 Harrow
1 Grisly Salvage
1 Putrefy
1 Seer's Sundial
1 Sol Ring
1 Retreat to Hagra
1 Khalni Heart Expedition
1 Deathreap Ritual
6 Swamp
5 Mountain
7 Forest
1 Akoum Refuge
1 Barren Moor
1 Blighted Woodland
1 Bojuka Bog
1 Command Tower
1 Evolving Wilds
1 Forgotten Cave
1 Golgari Rot Farm
1 Grim Backwoods
1 Gruul Turf
1 Haunted Fengraf
1 Jund Panorama
1 Jungle Hollow
1 Kazandu Refuge
1 Khalni Garden
1 Mountain Valley
1 Myriad Landscape
1 Rakdos Carnarium
1 Rocky Tar Pit
1 Savage Lands
1 Temple of the False God
1 Terramorphic Expanse
1 Tranquil Thicket
1 Warped Landscape
1 Gyrus, Waker of Corpses
1 Thantis, the Warweaver
1 Bloodtracker
1 Emissary of Grudges
1 Fury Storm
1 Nesting Dragon
1 Reality Scramble
1 Crash of Rhino Beetles
1 Turntimber Sower
1 Whiptongue Hydra
1 Windgrace's Judgment
1 Xantcha, Sleeper Agent
1 Loyal Subordinate
1 Loyal Apprentice
1 Loyal Guardian
1 Forge of Heroes`,
  },
  c18_subjective_reality: {
    label: "Subjective Reality (Aminatou, the Fateshifter)",
    set: "Commander 2018",
    bracket: 2,
    text: `Commander
1 Aminatou, the Fateshifter

Deck
1 Enigma Sphinx
1 Serra Avatar
1 Adarkar Valkyrie
1 Conundrum Sphinx
1 Djinn of Wishes
1 Jeskai Infiltrator
1 Sphinx of Jwar Isle
1 Sphinx of Uthuun
1 Phyrexian Delver
1 Duskmantle Seer
1 High Priest of Penance
1 Silent-Blade Oni
1 Mulldrifter
1 Ninja of the Deep Hours
1 Sigiled Starfish
1 Pilgrim's Eye
1 Terminus
1 Entreat the Angels
1 Army of the Damned
1 Akroma's Vengeance
1 Devastation Tide
1 Dream Cache
1 Ponder
1 Portent
1 Treasure Hunt
1 Utter End
1 Banishing Stroke
1 Return to Dust
1 Brainstorm
1 Predict
1 Telling Time
1 Esper Charm
1 Mortify
1 Azorius Signet
1 Commander's Sphere
1 Crystal Ball
1 Dimir Signet
1 Mind Stone
1 Orzhov Signet
1 Seer's Lantern
1 Sol Ring
1 Lightform
1 Cloudform
8 Plains
5 Island
3 Swamp
1 Arcane Sanctum
1 Azorius Chancery
1 Azorius Guildgate
1 Barren Moor
1 Command Tower
1 Dimir Aqueduct
1 Dimir Guildgate
1 Dismal Backwater
1 Forsaken Sanctuary
1 Halimar Depths
1 Jwar Isle Refuge
1 Lonely Sandbar
1 Meandering River
1 Mortuary Mire
1 New Benalia
1 Orzhov Basilica
1 Orzhov Guildgate
1 Scoured Barrens
1 Secluded Steppe
1 Sejiri Refuge
1 Submerged Boneyard
1 Tranquil Cove
1 Varina, Lich Queen
1 Yennett, Cryptic Sovereign
1 Boreas Charger
1 Magus of the Balance
1 Aminatou's Augury
1 Primordial Mist
1 Entreat the Dead
1 Night Incarnate
1 Skull Storm
1 Sower of Discord
1 Yuriko, the Tiger's Shadow
1 Isolated Watchtower
1 Aethermage's Touch
1 Loyal Unicorn
1 Loyal Subordinate
1 Geode Golem
1 Forge of Heroes
1 Crib Swap`,
  },
  cm2_devour_for_power: {
    label: "Devour for Power (The Mimeoplasm)",
    set: "Commander Anthology Volume II",
    bracket: 2,
    text: `Commander
1 The Mimeoplasm

Deck
1 Nezumi Graverobber
1 Skullbriar, the Walking Grave
1 Riddlekeeper
1 Fleshbag Marauder
1 Eternal Witness
1 Troll Ascetic
1 Yavimaya Elder
1 Solemn Simulacrum
1 Brawn
1 Wonder
1 Sewer Nemesis
1 Gravedigger
1 Lhurgoyf
1 Dreamborn Muse
1 Mortivore
1 Desecrator Hag
1 Mulldrifter
1 Acidic Slime
1 Vulturous Zombie
1 Dark Hatchling
1 Extractor Demon
1 Scythe Specter
1 Wrexial, the Risen Deep
1 Vorosh, the Hunter
1 Triskelavus
1 Slipstream Eel
1 Butcher of Malakir
1 Patron of the Nezumi
1 Damia, Sage of Stone
1 Szadek, Lord of Secrets
1 Avatar of Woe
1 Artisan of Kozilek
1 Minds Aglow
1 Shared Trauma
1 Sign in Blood
1 Stitch Together
1 Cultivate
1 Windfall
1 Buried Alive
1 Syphon Mind
1 Unnerve
1 Rise from the Grave
1 Syphon Flesh
1 Living Death
1 Tribute to the Wild
1 Spell Crumple
1 Fact or Fiction
1 Relic Crush
1 Sol Ring
1 Dimir Signet
1 Golgari Signet
1 Lightning Greaves
1 Simic Signet
1 Oblivion Stone
1 Vow of Wildness
1 Vow of Flight
1 Vow of Malice
1 Memory Erosion
1 Grave Pact
1 Barren Moor
1 Command Tower
1 Dimir Aqueduct
1 Dreadship Reef
1 Golgari Rot Farm
1 Jwar Isle Refuge
1 Lonely Sandbar
1 Rupture Spire
1 Simic Growth Chamber
1 Svogthos, the Restless Tomb
1 Temple of the False God
1 Terramorphic Expanse
1 Tranquil Thicket
8 Forest
8 Island
11 Swamp`,
  },
  c17_arcane_wizardry: {
    label: "Arcane Wizardry (Inalla, Archmage Ritualist)",
    set: "Commander 2017",
    bracket: 2,
    text: `Commander
1 Inalla, Archmage Ritualist

Deck
1 Kess, Dissident Mage
1 Mairsil, the Pretender
1 Galecaster Colossus
1 Magus of the Mind
1 Portal Mage
1 Vindictive Lich
1 Izzet Chemister
1 Taigam, Sidisi's Hand
1 Havengul Lich
1 Marchesa, the Black Rose
1 Vela the Night-Clad
1 Arcanis the Omnipotent
1 Azami, Lady of Scrolls
1 Body Double
1 Harbinger of the Tides
1 Serendib Sorcerer
1 Apprentice Necromancer
1 Magus of the Abyss
1 Puppeteer Clique
1 Etherium-Horn Sorcerer
1 Mercurial Chemister
1 Nin, the Pain Artist
1 Niv-Mizzet, the Firemind
1 Shadowmage Infiltrator
1 Bloodline Necromancer
1 Archaeomancer
1 Merchant of Secrets
1 Sea Gate Oracle
1 Corpse Augur
1 Izzet Chronarch
1 Nivix Guildmage
1 Kindred Dominance
1 Clone Legion
1 Spelltwine
1 Decree of Pain
1 Necromantic Selection
1 Comet Storm
1 Polymorphist's Jest
1 Chaos Warp
1 Memory Plunder
1 Silumgar's Command
1 Into the Roil
1 Opportunity
1 Reality Shift
1 Go for the Throat
1 Cauldron Dance
1 Crosis's Charm
1 Rakdos Charm
1 Terminate
1 Nevinyrral's Disk
1 Mirror of the Forebears
1 Commander's Sphere
1 Darksteel Ingot
1 Fellwar Stone
1 Sol Ring
1 Unstable Obelisk
1 Worn Powerstone
1 Shifting Shadow
1 Curse of Verbosity
1 Curse of Disturbance
1 Curse of Opulence
1 Exotic Orchard
1 Mystifying Maze
10 Island
6 Swamp
4 Mountain
1 Path of Ancestry
1 Command Tower
1 Crumbling Necropolis
1 Dimir Aqueduct
1 Dismal Backwater
1 Evolving Wilds
1 Grixis Panorama
1 Izzet Boilerworks
1 Jwar Isle Refuge
1 Rakdos Carnarium
1 Swiftwater Cliffs
1 Temple of the False God
1 Terramorphic Expanse
1 Vivid Crag
1 Vivid Creek
1 Vivid Marsh`,
  },
  c17_draconic_domination: {
    label: "Draconic Domination (The Ur-Dragon)",
    set: "Commander 2017",
    bracket: 2,
    text: `Commander
1 The Ur-Dragon

Deck
1 O-Kagachi, Vengeful Kami
1 Ramos, Dragon Engine
1 Scalelord Reckoner
1 Boneyard Scourge
1 Territorial Hellkite
1 Taigam, Ojutai Master
1 Wasitora, Nekoru Queen
1 Ryusei, the Falling Star
1 Scourge of Valkas
1 Utvara Hellkite
1 Sunscorch Regent
1 Deathbringer Regent
1 Hellkite Charger
1 Tyrant's Familiar
1 Atarka, World Render
1 Bladewing the Risen
1 Broodmate Dragon
1 Crosis, the Purger
1 Dromoka, the Eternal
1 Intet, the Dreamer
1 Kolaghan, the Storm's Fury
1 Niv-Mizzet, Dracogenius
1 Ojutai, Soul of Winter
1 Scion of the Ur-Dragon
1 Silumgar, the Drifting Death
1 Spellbound Dragon
1 Teneb, the Harvester
1 Steel Hellkite
1 Orator of Ojutai
1 Dragonlord's Servant
1 Dragonspeaker Shaman
1 Savage Ventmaw
1 Fortunate Few
1 Fractured Identity
1 Crux of Fate
1 Painful Truths
1 Earthquake
1 Cultivate
1 Farseek
1 Kodama's Reach
1 Rain of Thorns
1 Fist of Suns
1 Herald's Horn
1 Mirror of the Forebears
1 Armillary Sphere
1 Commander's Sphere
1 Darksteel Ingot
1 Dreamstone Hedron
1 Lightning Greaves
1 Nihil Spellbomb
1 Sol Ring
1 Wayfarer's Bauble
1 Kindred Discovery
1 Monastery Siege
1 Palace Siege
1 Crucible of Fire
1 Dragon Tempest
1 Frontier Siege
1 Curse of Verbosity
1 Curse of Opulence
1 Curse of Bounty
1 Elemental Bond
1 Crucible of the Spirit Dragon
1 Haven of the Spirit Dragon
6 Mountain
3 Swamp
3 Forest
3 Plains
3 Island
1 Path of Ancestry
1 Arcane Sanctum
1 Command Tower
1 Crumbling Necropolis
1 Frontier Bivouac
1 Jungle Shrine
1 Mystic Monastery
1 Nomad Outpost
1 Opulent Palace
1 Sandsteppe Citadel
1 Savage Lands
1 Seaside Citadel
1 Vivid Crag
1 Vivid Creek
1 Vivid Grove
1 Vivid Marsh
1 Vivid Meadow`,
  },
  c17_feline_ferocity: {
    label: "Feline Ferocity (Arahbo, Roar of the World)",
    set: "Commander 2017",
    bracket: 2,
    text: `Commander
1 Arahbo, Roar of the World

Deck
1 Nazahn, Revered Bladesmith
1 Mirri, Weatherlight Duelist
1 Alms Collector
1 Balan, Wandering Knight
1 Stalking Leonin
1 Hungry Lynx
1 Qasali Slingers
1 Jazal Goldmane
1 Jareth, Leonine Titan
1 Kemba, Kha Regent
1 Leonin Arbiter
1 Leonin Shikari
1 Raksha Golden Cub
1 Seht's Tiger
1 Spirit of the Hearth
1 Jedit Ojanen of Efrava
1 Fleecemane Lion
1 Phantom Nishoba
1 Leonin Relic-Warder
1 Oreskos Explorer
1 Sunspear Shikari
1 Taj-Nar Swordsmith
1 Temur Sabertooth
1 Qasali Pridemage
1 Traverse the Outlands
1 Divine Reckoning
1 Rout
1 Hunter's Prowess
1 Soul's Majesty
1 Cultivate
1 Harmonize
1 Nissa's Pilgrimage
1 Kindred Summons
1 White Sun's Zenith
1 Condemn
1 Wing Shards
1 Crushing Vines
1 Relic Crush
1 Bloodforged Battle-Axe
1 Hammer of Nazahn
1 Argentum Armor
1 Grappling Hook
1 Quietus Spike
1 Staff of Nin
1 Sword of the Animist
1 Sword of Vengeance
1 Heirloom Blade
1 Herald's Horn
1 Behemoth Sledge
1 Dreamstone Hedron
1 Hedron Archive
1 Hero's Blade
1 Lightning Greaves
1 Loxodon Warhammer
1 Skullclamp
1 Sol Ring
1 Swiftfoot Boots
1 Mirari's Wake
1 Abundance
1 Zendikar Resurgent
1 Curse of Vitality
1 Curse of Bounty
1 Mosswort Bridge
1 Stirring Wildwood
7 Plains
6 Forest
1 Path of Ancestry
1 Blighted Woodland
1 Blossoming Sands
1 Command Tower
1 Elfhame Palace
1 Evolving Wilds
1 Grasslands
1 Graypelt Refuge
1 Krosan Verge
1 Myriad Landscape
1 Opal Palace
1 Rogue's Passage
1 Saltcrusted Steppe
1 Secluded Steppe
1 Selesnya Guildgate
1 Selesnya Sanctuary
1 Temple of the False God
1 Terramorphic Expanse
1 Tranquil Expanse
1 Tranquil Thicket
1 Vivid Meadow
1 Vivid Grove`,
  },
  c17_vampiric_bloodlust: {
    label: "Vampiric Bloodlust (Edgar Markov)",
    set: "Commander 2017",
    bracket: 2,
    text: `Commander
1 Edgar Markov

Deck
1 Licia, Sanguine Tribune
1 Mathas, Fiend Seeker
1 Kheru Mind-Eater
1 Patron of the Vein
1 Bloodsworn Steward
1 Crimson Honor Guard
1 Anowon, the Ruin Sage
1 Bloodlord of Vaasgoth
1 Blood Baron of Vizkopa
1 Butcher of Malakir
1 Captivating Vampire
1 Dark Impostor
1 Drana, Kalastria Bloodchief
1 Malakir Bloodwitch
1 Sangromancer
1 Skeletal Vampire
1 Vein Drinker
1 Bloodline Necromancer
1 Blood Artist
1 Bloodhusk Ritualist
1 Falkenrath Noble
1 Pawn of Ulamog
1 Vampire Nighthawk
1 Rakish Heir
1 Stromkirk Captain
1 Tithe Drinker
1 New Blood
1 Disrupt Decorum
1 Kindred Charge
1 Fell the Mighty
1 Blood Tribute
1 Consuming Vapors
1 Damnable Pact
1 Merciless Eviction
1 Ambition's Cost
1 Read the Bones
1 Syphon Mind
1 Teferi's Protection
1 Crackling Doom
1 Return to Dust
1 Swords to Plowshares
1 Go for the Throat
1 Skeletal Scrying
1 Mortify
1 Blade of the Bloodchief
1 Door of Destinies
1 Well of Lost Dreams
1 Heirloom Blade
1 Boros Signet
1 Orzhov Signet
1 Rakdos Signet
1 Skullclamp
1 Sol Ring
1 Worn Powerstone
1 Kindred Boon
1 Blind Obedience
1 Black Market
1 Sanguine Bond
1 Underworld Connections
1 Outpost Siege
1 Curse of Vitality
1 Curse of Disturbance
8 Swamp
4 Mountain
3 Plains
1 Path of Ancestry
1 Akoum Refuge
1 Bloodfell Caves
1 Bojuka Bog
1 Boros Garrison
1 Boros Guildgate
1 Cinder Barrens
1 Command Tower
1 Evolving Wilds
1 Forsaken Sanctuary
1 Kabira Crossroads
1 Nomad Outpost
1 Opal Palace
1 Orzhov Basilica
1 Orzhov Guildgate
1 Rakdos Carnarium
1 Rakdos Guildgate
1 Scoured Barrens
1 Stone Quarry
1 Terramorphic Expanse
1 Urborg Volcano
1 Wind-Scarred Crag`,
  },
  cma_heavenly_inferno: {
    label: "Heavenly Inferno (Kaalia of the Vast)",
    set: "Commander Anthology",
    bracket: 2,
    text: `Commander
1 Kaalia of the Vast

Deck
1 Akroma, Angel of Fury
1 Angel of Despair
1 Angelic Arbiter
1 Anger
1 Archangel of Strife
1 Avatar of Slaughter
1 Basandra, Battle Seraph
1 Bladewing the Risen
1 Boros Guildmage
1 Dragon Whelp
1 Dread Cacodemon
1 Duergar Hedge-Mage
1 Fallen Angel
1 Furnace Whelp
1 Gwyllion Hedge-Mage
1 Lightkeeper of Emeria
1 Malfegor
1 Mana-Charged Dragon
1 Mother of Runes
1 Oni of Wild Places
1 Oros, the Avenger
1 Orzhov Guildmage
1 Razorjaw Oni
1 Reiver Demon
1 Serra Angel
1 Shattered Angel
1 Tariel, Reckoner of Souls
1 Voice of All
1 Akroma's Vengeance
1 Death by Dragons
1 Diabolic Tutor
1 Earthquake
1 Evincar's Justice
1 Syphon Flesh
1 Syphon Mind
1 Bathe in Light
1 Cleansing Beam
1 Comet Storm
1 Congregate
1 Master Warcraft
1 Mortify
1 Orim's Thunder
1 Path to Exile
1 Return to Dust
1 Sulfurous Blast
1 Terminate
1 Wrecking Ball
1 Armillary Sphere
1 Boros Signet
1 Darksteel Ingot
1 Lightning Greaves
1 Orzhov Signet
1 Rakdos Signet
1 Sol Ring
1 Pyrohemia
1 Righteous Cause
1 Soul Snare
1 Stranglehold
1 Vow of Duty
1 Vow of Lightning
1 Vow of Malice
1 Akoum Refuge
1 Barren Moor
1 Bojuka Bog
1 Boros Garrison
1 Command Tower
1 Evolving Wilds
1 Forgotten Cave
1 Molten Slagheap
8 Mountain
1 Orzhov Basilica
8 Plains
1 Rakdos Carnarium
1 Rupture Spire
1 Secluded Steppe
8 Swamp
1 Vivid Meadow
1 Zoetic Cavern`,
  },
  c16_breed_lethality: {
    label: "Breed Lethality (Atraxa, Praetors' Voice)",
    set: "Commander 2016",
    bracket: 2,
    text: `Commander
1 Atraxa, Praetors' Voice

Deck
1 Thrummingbird
1 Festercreep
1 Scavenging Ooze
1 Abzan Falconer
1 Orzhov Advokist
1 Tuskguard Captain
1 Necroplasm
1 Champion of Lambholt
1 Reyhan, Last of the Abzan
1 Vorel of the Hull Clade
1 Crystalline Crawler
1 Custodi Soulbinders
1 Forgotten Ancient
1 Bane of the Living
1 Ishai, Ojutai Dragonspeaker
1 Corpsejack Menace
1 Fathom Mage
1 Master Biomancer
1 Elite Scaleguard
1 Reveillark
1 Deepglow Skate
1 Kalonian Hydra
1 Ikra Shidiqi, the Usurper
1 Vulturous Zombie
1 Juniper Order Ranger
1 Ghave, Guru of Spores
1 Enduring Scalelord
1 Manifold Insights
1 Languish
1 Tezzeret's Gambit
1 Migratory Route
1 Merciless Eviction
1 Spitting Image
1 Sublime Exhalation
1 Duneblast
1 Treasure Cruise
1 Disdainful Stroke
1 Solidarity of Heroes
1 Grip of Phyresis
1 Inspiring Call
1 Mortify
1 Putrefy
1 Ancient Excavation
1 Mirrorweave
1 Sylvan Reclamation
1 Sol Ring
1 Fellwar Stone
1 Golgari Signet
1 Orzhov Signet
1 Simic Signet
1 Commander's Sphere
1 Darksteel Ingot
1 Cauldron of Souls
1 Astral Cornucopia
1 Hardened Scales
1 Brave the Sands
1 Duelist's Heritage
1 Bred for the Hunt
1 Citadel Siege
1 Cathars' Crusade
1 Arcane Sanctum
1 Ash Barrens
1 Azorius Chancery
1 Command Tower
1 Darkwater Catacombs
1 Dreadship Reef
1 Evolving Wilds
1 Exotic Orchard
1 Golgari Rot Farm
1 Murmuring Bosk
1 Opal Palace
1 Opulent Palace
1 Sandsteppe Citadel
1 Seaside Citadel
1 Sungrass Prairie
1 Temple of the False God
1 Terramorphic Expanse
1 Underground River
5 Plains
4 Island
5 Swamp
7 Forest`,
  },
  c16_entropic_uprising: {
    label: "Entropic Uprising (Yidris, Maelstrom Wielder)",
    set: "Commander 2016",
    bracket: 2,
    text: `Commander
1 Yidris, Maelstrom Wielder

Deck
1 Satyr Wayfinder
1 Wall of Blossoms
1 Coiling Oracle
1 Thrasios, Triton Hero
1 Goblin Spymaster
1 Spellheart Chimera
1 Vial Smasher the Fierce
1 Academy Elite
1 Gamekeeper
1 Sangromancer
1 Bloodbraid Elf
1 Horizon Chimera
1 Kydele, Chosen of Kruphix
1 Glint-Eye Nephilim
1 Aeon Chronicler
1 Guiltfeeder
1 Consuming Aberration
1 Nath of the Gilt-Leaf
1 Runehorn Hellkite
1 Etherium-Horn Sorcerer
1 Dragon Mage
1 Blood Tyrant
1 Wheel of Fate
1 Windfall
1 Parting Thoughts
1 Far Wanderings
1 Past in Flames
1 Whispering Madness
1 Decimate
1 Devastation Tide
1 Reforge the Soul
1 Worm Harvest
1 Spelltwine
1 Whims of the Fates
1 Grave Upheaval
1 Cruel Entertainment
1 Ghastly Conscription
1 Volcanic Vision
1 Treasure Cruise
1 Treacherous Terrain
1 Army of the Damned
1 In Garruk's Wake
1 Chain of Vapor
1 Rakdos Charm
1 Chaos Warp
1 Ancient Excavation
1 Evacuation
1 Bituminous Blast
1 Curtains' Call
1 Sol Ring
1 Fellwar Stone
1 Rakdos Signet
1 Simic Signet
1 Chromatic Lantern
1 Commander's Sphere
1 Whispersilk Cloak
1 Boompile
1 Burgeoning
1 Waste Not
1 Frenzied Fugue
1 Ash Barrens
1 Command Tower
1 Crumbling Necropolis
1 Dismal Backwater
1 Evolving Wilds
1 Exotic Orchard
1 Frontier Bivouac
1 Jungle Hollow
1 Opulent Palace
1 Rakdos Carnarium
1 Reliquary Tower
1 Rugged Highlands
1 Rupture Spire
1 Savage Lands
1 Shadowblood Ridge
1 Simic Growth Chamber
1 Swiftwater Cliffs
1 Terramorphic Expanse
1 Thornwood Falls
5 Island
5 Swamp
5 Mountain
5 Forest`,
  },
  c16_invent_superiority: {
    label: "Invent Superiority (Breya, Etherium Shaper)",
    set: "Commander 2016",
    bracket: 2,
    text: `Commander
1 Breya, Etherium Shaper

Deck
1 Daretti, Scrap Savant
1 Myr Retriever
1 Chief Engineer
1 Etherium Sculptor
1 Vedalken Engineer
1 Slobad, Goblin Tinkerer
1 Baleful Strix
1 Akiri, Line-Slinger
1 Armory Automaton
1 Shimmer Myr
1 Master of Etherium
1 Trinket Mage
1 Magus of the Will
1 Hanna, Ship's Navigator
1 Silas Renn, Seeker Adept
1 Sydri, Galvanic Genius
1 Etched Oracle
1 Solemn Simulacrum
1 Sanctum Gargoyle
1 Faerie Artisans
1 Bruse Tarl, Boorish Herder
1 Ethersworn Adjudicator
1 Sphinx Summoner
1 Jor Kadeen, the Prevailer
1 Soul of New Phyrexia
1 Godo, Bandit Warlord
1 Hellkite Tyrant
1 Sharuum the Hegemon
1 Myr Battlesphere
1 Hellkite Igniter
1 Filigree Angel
1 Whipflare
1 Parting Thoughts
1 Trash for Treasure
1 Beacon of Unrest
1 Migratory Route
1 Open the Vaults
1 Phyrexian Rebirth
1 Grave Upheaval
1 Coastal Breach
1 Grip of Phyresis
1 Ancient Excavation
1 Read the Runes
1 Trial // Error
1 Everflowing Chalice
1 Skullclamp
1 Sol Ring
1 Dispeller's Capsule
1 Executioner's Capsule
1 Cranial Plating
1 Fellwar Stone
1 Ichor Wellspring
1 Mycosynth Wellspring
1 Swiftfoot Boots
1 Thopter Foundry
1 Commander's Sphere
1 Loxodon Warhammer
1 Bonehoard
1 Nevinyrral's Disk
1 Trading Post
1 Blinkmoth Urn
1 Darksteel Citadel
1 Seat of the Synod
1 Curse of Vengeance
1 Arcane Sanctum
1 Ash Barrens
1 Azorius Chancery
1 Boros Garrison
1 Buried Ruin
1 Command Tower
1 Crumbling Necropolis
1 Dimir Aqueduct
1 Evolving Wilds
1 Exotic Orchard
1 Mystic Monastery
1 Nomad Outpost
1 Rakdos Carnarium
1 Rupture Spire
1 Temple of the False God
1 Terramorphic Expanse
1 Transguild Promenade
5 Plains
5 Island
4 Swamp
4 Mountain`,
  },
  c16_open_hostility: {
    label: "Open Hostility (Saskia the Unyielding)",
    set: "Commander 2016",
    bracket: 2,
    text: `Commander
1 Saskia the Unyielding

Deck
1 Wight of Precinct Six
1 Den Protector
1 Quirion Explorer
1 Sakura-Tribe Elder
1 Sylvok Explorer
1 Korozda Guildmage
1 Zhur-Taa Druid
1 Selesnya Guildmage
1 Mentor of the Meek
1 Mirror Entity
1 Alesha, Who Smiles at Death
1 Taurean Mauler
1 Managorger Hydra
1 Wild Beastmaster
1 Tymna the Weaver
1 Wilderness Elemental
1 Dauntless Escort
1 Brutal Hordechief
1 Charging Cinderhorn
1 Thelonite Hermit
1 Tana, the Bloodsower
1 Iroas, God of Victory
1 Mycoloth
1 Ravos, Soultender
1 Ankle Shanker
1 Thunderfoot Baloth
1 Stalking Vengeance
1 Stonehoof Chieftain
1 Primeval Protector
1 Farseek
1 Rampant Growth
1 Shamanic Revelation
1 Grave Upheaval
1 Treacherous Terrain
1 Clan Defiance
1 Lavalanche
1 Terminate
1 Artifact Mutation
1 Boros Charm
1 Aura Mutation
1 Abzan Charm
1 Naya Charm
1 Crackling Doom
1 Grab the Reins
1 Utter End
1 Sylvan Reclamation
1 Divergent Transformations
1 Order // Chaos
1 Skullclamp
1 Sol Ring
1 Conqueror's Flail
1 Fellwar Stone
1 Gruul Signet
1 Lightning Greaves
1 Commander's Sphere
1 Sunforger
1 Blind Obedience
1 Evolutionary Escalation
1 Necrogenesis
1 Beastmaster Ascension
1 Everlasting Torment
1 Frenzied Fugue
1 Breath of Fury
1 Ash Barrens
1 Caves of Koilos
1 Command Tower
1 Dragonskull Summit
1 Evolving Wilds
1 Exotic Orchard
1 Grand Coliseum
1 Gruul Turf
1 Jungle Shrine
1 Karplusan Forest
1 Mosswort Bridge
1 Nomad Outpost
1 Orzhov Basilica
1 Rootbound Crag
1 Sandsteppe Citadel
1 Savage Lands
1 Spinerock Knoll
1 Sunpetal Grove
1 Terramorphic Expanse
1 Windbrisk Heights
3 Plains
3 Swamp
5 Mountain
5 Forest`,
  },
  c16_stalwart_unity: {
    label: "Stalwart Unity (Kynaios and Tiro of Meletis)",
    set: "Commander 2016",
    bracket: 2,
    text: `Commander
1 Kynaios and Tiro of Meletis

Deck
1 Veteran Explorer
1 Humble Defector
1 Hushwing Gryff
1 Orzhov Advokist
1 Chasm Skulker
1 Gwafa Hazid, Profiteer
1 Ludevic, Necro-Alchemist
1 Selvala, Explorer Returned
1 Edric, Spymaster of Trest
1 Akroan Horse
1 Selfless Squire
1 Windborn Muse
1 Sidar Kondo of Jamuraa
1 Horizon Chimera
1 Zedruu the Greathearted
1 Psychosis Crawler
1 Kazuul, Tyrant of the Cliffs
1 Kraum, Ludevic's Opus
1 Realm Seekers
1 Rubblehulk
1 Progenitor Mimic
1 Blazing Archon
1 Minds Aglow
1 Collective Voyage
1 Cultivate
1 Kodama's Reach
1 Tempt with Discovery
1 Wave of Reckoning
1 Migratory Route
1 Seeds of Renewal
1 Reverse the Sands
1 Treacherous Terrain
1 Blasphemous Act
1 Swords to Plowshares
1 Swan Song
1 Arcane Denial
1 Benefactor's Draught
1 Oblation
1 Beast Within
1 Entrapment Maneuver
1 Reins of Power
1 Sylvan Reclamation
1 Sol Ring
1 Empyrial Plate
1 Howling Mine
1 Commander's Sphere
1 Temple Bell
1 Assault Suit
1 Prismatic Geoscope
1 Venser's Journal
1 Keening Stone
1 Evolutionary Escalation
1 Oath of Druids
1 Ghostly Prison
1 Propaganda
1 Rites of Flourishing
1 Sphere of Safety
1 Lurking Predators
1 Hoofprints of the Stag
1 Ash Barrens
1 Azorius Chancery
1 Command Tower
1 Evolving Wilds
1 Exotic Orchard
1 Forbidden Orchard
1 Frontier Bivouac
1 Gruul Turf
1 Homeward Path
1 Izzet Boilerworks
1 Jungle Shrine
1 Krosan Verge
1 Myriad Landscape
1 Mystic Monastery
1 Opal Palace
1 Rupture Spire
1 Seaside Citadel
1 Selesnya Sanctuary
1 Terramorphic Expanse
1 Transguild Promenade
5 Plains
5 Island
5 Mountain
5 Forest`,
  },
  c15_call_the_spirits: {
    label: "Call the Spirits (Daxos the Returned)",
    set: "Commander 2015",
    bracket: 2,
    text: `Commander
1 Daxos the Returned

Deck
1 Oreskos Explorer
1 Karlov of the Ghost Council
1 Underworld Coinsmith
1 Burnished Hart
1 Bastion Protector
1 Dawnglare Invoker
1 Ghostblade Eidolon
1 Kor Sanctifiers
1 Monk Idealist
1 Mesa Enchantress
1 Nighthowler
1 Corpse Augur
1 Fate Unraveler
1 Ajani's Chosen
1 Doomwake Giant
1 Dreadbringer Lampads
1 Celestial Ancient
1 Celestial Archon
1 Herald of the Host
1 Banshee of the Dread Choir
1 Thief of Blood
1 Treasury Thrull
1 Sandstone Oracle
1 Silent Sentinel
1 Teysa, Envoy of Ghosts
1 Ancient Craving
1 Gild
1 Dawn to Dusk
1 Righteous Confluence
1 Open the Vaults
1 Deadly Tempest
1 Death Grasp
1 Sol Ring
1 Wayfarer's Bauble
1 Lightning Greaves
1 Orzhov Signet
1 Thought Vessel
1 Crystal Chimes
1 Orzhov Cluestone
1 Phyrexian Reclamation
1 Seal of Cleansing
1 Grave Peril
1 Banishing Light
1 Cage of Hands
1 Karmic Justice
1 Vow of Duty
1 Fallen Ideal
1 Seal of Doom
1 Vow of Malice
1 Aura of Silence
1 Grasp of Fate
1 Shielded by Faith
1 Phyrexian Arena
1 Underworld Connections
1 Daxos's Torment
1 Marshal's Anthem
1 Dictate of Heliod
1 Sigil of the Empty Throne
1 Black Market
1 Necromancer's Covenant
1 Barren Moor
1 Command Tower
1 Evolving Wilds
1 Ghost Quarter
1 New Benalia
1 Orzhov Basilica
1 Orzhov Guildgate
1 Rogue's Passage
1 Scoured Barrens
1 Secluded Steppe
1 Tainted Field
1 Temple of the False God
1 Terramorphic Expanse
1 Vivid Marsh
1 Vivid Meadow
11 Plains
13 Swamp`,
  },
  c15_plunder_the_graves: {
    label: "Plunder the Graves (Meren of Clan Nel Toth)",
    set: "Commander 2015",
    bracket: 2,
    text: `Commander
1 Meren of Clan Nel Toth

Deck
1 Sakura-Tribe Elder
1 Satyr Wayfinder
1 Viridian Emissary
1 Wall of Blossoms
1 Viridian Zealot
1 Korozda Guildmage
1 Lotleth Troll
1 Blood Bairn
1 Phyrexian Rager
1 Skullwinder
1 Wood Elves
1 Eternal Witness
1 Corpse Augur
1 Centaur Vinecrasher
1 Bloodspore Thrinax
1 Jarad, Golgari Lich Lord
1 Shriekmaw
1 Indrik Stomphowler
1 Kessig Cagebreakers
1 Banshee of the Dread Choir
1 Phyrexian Plaguelord
1 Acidic Slime
1 Mycoloth
1 Mazirek, Kraul Death Priest
1 Vulturous Zombie
1 Great Oak Guardian
1 Champion of Stray Souls
1 Extractor Demon
1 Thief of Blood
1 Pathbreaker Ibex
1 Cloudthresher
1 Butcher of Malakir
1 Eater of Hope
1 Scourge of Nel Toth
1 Caller of the Pack
1 Terastodon
1 Verdant Force
1 Mulch
1 Victimize
1 Primal Growth
1 Ambition's Cost
1 Sever the Bloodline
1 Barter in Blood
1 Rise from the Grave
1 Spider Spawning
1 Overwhelming Stampede
1 Dread Summons
1 Altar's Reap
1 Tribute to the Wild
1 Golgari Charm
1 Grisly Salvage
1 Putrefy
1 Wretched Confluence
1 Skullclamp
1 Sol Ring
1 Golgari Signet
1 Lightning Greaves
1 Thought Vessel
1 Bonehoard
1 Eldrazi Monument
1 Diabolic Servitude
1 Command Tower
1 Evolving Wilds
1 Golgari Guildgate
1 Golgari Rot Farm
1 Grim Backwoods
1 High Market
1 Jungle Hollow
1 Polluted Mire
1 Slippery Karst
1 Tainted Wood
1 Terramorphic Expanse
1 Vivid Grove
1 Vivid Marsh
13 Swamp
12 Forest`,
  },
  c15_seize_control: {
    label: "Seize Control (Mizzix of the Izmagnus)",
    set: "Commander 2015",
    bracket: 2,
    text: `Commander
1 Mizzix of the Izmagnus

Deck
1 Goblin Electromancer
1 Jace's Archivist
1 Gigantoplasm
1 Talrand, Sky Summoner
1 Psychosis Crawler
1 Broodbirth Viper
1 Illusory Ambusher
1 Lone Revenant
1 Warchief Giant
1 Charmbreaker Devils
1 Arjun, the Shifting Flame
1 Etherium-Horn Sorcerer
1 Melek, Izzet Paragon
1 Dragon Mage
1 Preordain
1 Faithless Looting
1 Vandalblast
1 Mizzium Mortars
1 Windfall
1 Mystic Retrieval
1 Stolen Goods
1 Mizzix's Mastery
1 Rite of Replication
1 Sleep
1 Chain Reaction
1 Call the Skybreaker
1 Blatant Thievery
1 Epic Experiment
1 Meteor Blast
1 Blustersquall
1 Brainstorm
1 Echoing Truth
1 Desperate Ravings
1 Urza's Rage
1 Counterflux
1 Aetherize
1 Fact or Fiction
1 Reins of Power
1 Steam Augury
1 Mystic Confluence
1 Word of Seizing
1 Act of Aggression
1 Prophetic Bolt
1 Aethersnatch
1 Mirror Match
1 Firemind's Foresight
1 Repeal
1 Comet Storm
1 Magmaquake
1 Stroke of Genius
1 Dominate
1 Blue Sun's Zenith
1 Sol Ring
1 Izzet Signet
1 Thought Vessel
1 Worn Powerstone
1 Seal of the Guildpact
1 Awaken the Sky Tyrant
1 Rite of the Raging Storm
1 Thought Reflection
1 Command Tower
1 Evolving Wilds
1 Izzet Boilerworks
1 Izzet Guildgate
1 Reliquary Tower
1 Rogue's Passage
1 Spinerock Knoll
1 Swiftwater Cliffs
1 Temple of the False God
1 Terramorphic Expanse
1 Vivid Crag
1 Vivid Creek
14 Island
13 Mountain`,
  },
  c15_swell_the_host: {
    label: "Swell the Host (Ezuri, Claw of Progress)",
    set: "Commander 2015",
    bracket: 2,
    text: `Commander
1 Ezuri, Claw of Progress

Deck
1 Experiment One
1 Elvish Visionary
1 Sakura-Tribe Elder
1 Plaxmanta
1 Coiling Oracle
1 Caller of the Claw
1 Loaming Shaman
1 Noble Quarry
1 Skullwinder
1 Viridian Shaman
1 Eternal Witness
1 Ohran Viper
1 Kaseto, Orochi Archmage
1 Lorescale Coatl
1 Trygon Predator
1 Cold-Eyed Selkie
1 Wistful Selkie
1 Solemn Simulacrum
1 Forgotten Ancient
1 Patagia Viper
1 Thelonite Hermit
1 Ninja of the Deep Hours
1 Chameleon Colossus
1 Mystic Snake
1 Stingerfling Spider
1 Broodbirth Viper
1 Illusory Ambusher
1 Mulldrifter
1 Arbor Colossus
1 Great Oak Guardian
1 Bane of Progress
1 Prime Speaker Zegana
1 Caller of the Pack
1 Rampant Growth
1 Kodama's Reach
1 Overrun
1 Desert Twister
1 Verdant Confluence
1 Biomantic Mastery
1 Ezuri's Predation
1 Rapid Hybridization
1 Arachnogenesis
1 Krosan Grip
1 Snakeform
1 Cobra Trap
1 Mirror Match
1 Synthetic Destiny
1 Sol Ring
1 Simic Signet
1 Swiftfoot Boots
1 Thought Vessel
1 Simic Keyrune
1 Sword of Vengeance
1 Bident of Thassa
1 Scytheclaw
1 Orochi Hatchery
1 Beastmaster Ascension
1 Day of the Dragons
1 Command Beacon
1 Command Tower
1 Evolving Wilds
1 High Market
1 Llanowar Reborn
1 Mosswort Bridge
1 Novijen, Heart of Progress
1 Oran-Rief, the Vastwood
1 Reliquary Tower
1 Simic Growth Chamber
1 Simic Guildgate
1 Terramorphic Expanse
1 Thornwood Falls
1 Vivid Creek
1 Vivid Grove
1 Zoetic Cavern
14 Forest
11 Island`,
  },
  c15_wade_into_battle: {
    label: "Wade into Battle (Kalemne, Disciple of Iroas)",
    set: "Commander 2015",
    bracket: 2,
    text: `Commander
1 Kalemne, Disciple of Iroas

Deck
1 Oreskos Explorer
1 Magus of the Wheel
1 Stinkdrinker Daredevil
1 Taurean Mauler
1 Dawnglare Invoker
1 Desolation Giant
1 Fumiko the Lowblood
1 Hunted Dragon
1 Stoneshock Giant
1 Thundercloud Shaman
1 Warchief Giant
1 Herald of the Host
1 Kalemne's Captain
1 Anya, Merciless Angel
1 Sunrise Sovereign
1 Hammerfist Giant
1 Inferno Titan
1 Dawnbreak Reclaimer
1 Sun Titan
1 Hostility
1 Jareth, Leonine Titan
1 Victory's Herald
1 Sandstone Oracle
1 Hamletback Goliath
1 Arbiter of Knollridge
1 Borderland Behemoth
1 Dream Pillager
1 Magma Giant
1 Angel of Serenity
1 Gisela, Blade of Goldnight
1 Breath of Darigaaz
1 Fiery Confluence
1 Disaster Radius
1 Earthquake
1 Meteor Blast
1 Fall of the Hammer
1 Orim's Thunder
1 Sol Ring
1 Blade of Selves
1 Boros Signet
1 Coldsteel Heart
1 Fellwar Stone
1 Lightning Greaves
1 Mind Stone
1 Thought Vessel
1 Basalt Monolith
1 Boros Cluestone
1 Darksteel Ingot
1 Loxodon Warhammer
1 Urza's Incubator
1 Worn Powerstone
1 Seer's Sundial
1 Dreamstone Hedron
1 Staff of Nin
1 Curse of the Nightly Hunt
1 Banishing Light
1 Faith's Fetters
1 Rite of the Raging Storm
1 Warstorm Surge
1 Ancient Amphitheater
1 Blasted Landscape
1 Boros Garrison
1 Boros Guildgate
1 Command Tower
1 Drifting Meadow
1 Evolving Wilds
1 Forgotten Cave
1 Secluded Steppe
1 Smoldering Crater
1 Terramorphic Expanse
1 Vivid Crag
1 Vivid Meadow
1 Wind-Scarred Crag
14 Mountain
11 Plains
1 Crib Swap`,
  },
  c14_built_from_scratch: {
    label: "Built From Scratch (Daretti, Scrap Savant)",
    set: "Commander 2014",
    bracket: 2,
    text: `Commander
1 Daretti, Scrap Savant

Deck
1 Goblin Welder
1 Epochrasite
1 Myr Retriever
1 Myr Sire
1 Bottle Gnomes
1 Cathodion
1 Junk Diver
1 Palladium Myr
1 Pilgrim's Eye
1 Tuktuk the Explorer
1 Dualcaster Mage
1 Feldon of the Third Path
1 Solemn Simulacrum
1 Flametongue Kavu
1 Beetleback Chief
1 Ingot Chewer
1 Steel Hellkite
1 Wurmcoil Engine
1 Spitebellows
1 Hoard-Smelter Dragon
1 Warmonger Hellkite
1 Myr Battlesphere
1 Pentavus
1 Tyrant's Familiar
1 Bosh, Iron Golem
1 Bogardan Hellkite
1 Faithless Looting
1 Whipflare
1 Scrap Mastery
1 Incite Rebellion
1 Blasphemous Act
1 Impact Resonance
1 Chaos Warp
1 Volcanic Offering
1 Word of Seizing
1 Magmaquake
1 Starstorm
1 Everflowing Chalice
1 Panic Spellbomb
1 Sol Ring
1 Wayfarer's Bauble
1 Fire Diamond
1 Ichor Wellspring
1 Liquimetal Coating
1 Mind Stone
1 Mycosynth Wellspring
1 Ruby Medallion
1 Swiftfoot Boots
1 Commander's Sphere
1 Jalum Tome
1 Pristine Talisman
1 Unstable Obelisk
1 Trading Post
1 Caged Sun
1 Dreamstone Hedron
1 Loreseeker's Stone
1 Spine of Ish Sah
1 Darksteel Citadel
1 Great Furnace
1 Bitter Feud
1 Arcane Lighthouse
1 Buried Ruin
1 Dormant Volcano
1 Flamekin Village
1 Forgotten Cave
1 Ghost Quarter
1 Phyrexia's Core
1 Reliquary Tower
1 Smoldering Crater
1 Temple of the False God
29 Mountain`,
  },
  c14_forged_in_stone: {
    label: "Forged In Stone (Nahiri, the Lithomancer)",
    set: "Commander 2014",
    bracket: 2,
    text: `Commander
1 Nahiri, the Lithomancer

Deck
1 Containment Priest
1 Whitemane Lion
1 Grand Abolisher
1 Kor Sanctifiers
1 Mentor of the Meek
1 Flickerwisp
1 Hallowed Spiritkeeper
1 Kemba, Kha Regent
1 Silverblade Paladin
1 Skyhunter Skirmisher
1 Angelic Field Marshal
1 Celestial Crusader
1 Jazal Goldmane
1 Geist-Honored Monk
1 Requiem Angel
1 Adarkar Valkyrie
1 Sun Titan
1 Sunblast Angel
1 Twilight Shepherd
1 Angel of the Dire Hour
1 Serra Avatar
1 Gift of Estates
1 Spectral Procession
1 Fell the Mighty
1 Nomads' Assembly
1 Deploy to the Front
1 Martial Coup
1 Decree of Justice
1 Brave the Elements
1 Condemn
1 Afterlife
1 Midnight Haunting
1 Oblation
1 Wing Shards
1 Benevolent Offering
1 Comeuppance
1 Return to Dust
1 White Sun's Zenith
1 Masterwork of Ingenuity
1 Skullclamp
1 Sol Ring
1 Marble Diamond
1 Mask of Memory
1 Pearl Medallion
1 Swiftfoot Boots
1 Commander's Sphere
1 Loxodon Warhammer
1 Strata Scythe
1 Sword of Vengeance
1 Assault Suit
1 Bonehoard
1 Moonsilver Spear
1 Argentum Armor
1 Loreseeker's Stone
1 Armistice
1 Mobilization
1 Sacred Mesa
1 Marshal's Anthem
1 Cathars' Crusade
1 True Conviction
1 Arcane Lighthouse
1 Drifting Meadow
1 Emeria, the Sky Ruin
1 Ghost Quarter
1 Karoo
1 Secluded Steppe
1 Temple of the False God
32 Plains`,
  },
  c14_guided_by_nature: {
    label: "Guided By Nature (Freyalise, Llanowar's Fury)",
    set: "Commander 2014",
    bracket: 2,
    text: `Commander
1 Freyalise, Llanowar's Fury

Deck
1 Elvish Mystic
1 Elvish Skysweeper
1 Essence Warden
1 Joraga Warcaller
1 Llanowar Elves
1 Sylvan Safekeeper
1 Elvish Visionary
1 Priest of Titania
1 Sylvan Ranger
1 Thornweald Archer
1 Wellwisher
1 Farhaven Elf
1 Imperious Perfect
1 Reclamation Sage
1 Timberwatch Elf
1 Titania's Chosen
1 Wood Elves
1 Elvish Archdruid
1 Ezuri, Renegade Leader
1 Drove of Elves
1 Immaculate Magistrate
1 Wren's Run Packmaster
1 Lys Alana Huntmaster
1 Masked Admirers
1 Wolfbriar Elemental
1 Creeperhulk
1 Silklash Spider
1 Titania, Protector of Argoth
1 Grave Sifter
1 Primordial Sage
1 Rampaging Baloths
1 Soul of the Harvest
1 Thunderfoot Baloth
1 Siege Behemoth
1 Tornado Elemental
1 Terastodon
1 Lifeblood Hydra
1 Hunting Triad
1 Whirlwind
1 Overwhelming Stampede
1 Overrun
1 Grim Flowering
1 Collective Unconscious
1 Desert Twister
1 Wave of Vitriol
1 Praetor's Counsel
1 Sylvan Offering
1 Harrow
1 Fresh Meat
1 Skullclamp
1 Sol Ring
1 Emerald Medallion
1 Moss Diamond
1 Swiftfoot Boots
1 Commander's Sphere
1 Assault Suit
1 Seer's Sundial
1 Predator, Flagship
1 Loreseeker's Stone
1 Beastmaster Ascension
1 Song of the Dryads
1 Wolfcaller's Howl
1 Crystal Vein
1 Evolving Wilds
1 Gargoyle Castle
1 Ghost Quarter
1 Haunted Fengraf
1 Havenwood Battleground
1 Jungle Basin
1 Myriad Landscape
1 Oran-Rief, the Vastwood
1 Slippery Karst
1 Terramorphic Expanse
1 Tranquil Thicket
25 Forest`,
  },
  c14_peer_through_time: {
    label: "Peer Through Time (Teferi, Temporal Archmage)",
    set: "Commander 2014",
    bracket: 2,
    text: `Commander
1 Teferi, Temporal Archmage

Deck
1 Azure Mage
1 Fathom Seer
1 Fog Bank
1 Willbender
1 Dulcet Sirens
1 Riptide Survivor
1 Sea Gate Oracle
1 Shaper Parasite
1 Reef Worm
1 Mulldrifter
1 Ixidron
1 Stitcher Geralf
1 Stormsurge Kraken
1 Steel Hellkite
1 Brine Elemental
1 Frost Titan
1 Sphinx of Jwar Isle
1 Sphinx of Magosi
1 Phyrexian Ingester
1 Sphinx of Uthuun
1 Hoverguard Sweepers
1 Lorthos, the Tidemaker
1 Artisan of Kozilek
1 Breaching Leviathan
1 Deep-Sea Kraken
1 Call to Mind
1 Compulsive Research
1 Concentrate
1 Rite of Replication
1 Rush of Knowledge
1 Aether Gale
1 Distorting Wake
1 Pongify
1 Cyclonic Rift
1 Into the Roil
1 Turn to Frog
1 Exclude
1 Cackling Counterpart
1 Domineering Will
1 Dismiss
1 Intellectual Offering
1 Stroke of Genius
1 Everflowing Chalice
1 Sol Ring
1 Mind Stone
1 Sapphire Medallion
1 Sky Diamond
1 Swiftfoot Boots
1 Crown of Doom
1 Unstable Obelisk
1 Worn Powerstone
1 Assault Suit
1 Thran Dynamo
1 Dreamstone Hedron
1 Tormod's Crypt
1 Commander's Sphere
1 Nevinyrral's Disk
1 Ur-Golem's Eye
1 Infinite Reflection
1 Well of Ideas
1 Fool's Demise
1 Coral Atoll
1 Ghost Quarter
1 Lonely Sandbar
1 Myriad Landscape
1 Remote Isle
1 Tectonic Edge
1 Zoetic Cavern
31 Island`,
  },
  c14_sworn_to_darkness: {
    label: "Sworn To Darkness (Ob Nixilis of the Black Oath)",
    set: "Commander 2014",
    bracket: 2,
    text: `Commander
1 Ob Nixilis of the Black Oath

Deck
1 Skirsdag High Priest
1 Nantuko Shade
1 Vampire Hexmage
1 Burnished Hart
1 Flesh Carver
1 Crypt Ghast
1 Disciple of Bolas
1 Evernight Shade
1 Abyssal Persecutor
1 Nekrataal
1 Magus of the Coffers
1 Raving Dead
1 Shriekmaw
1 Bloodgift Demon
1 Demon of Wailing Agonies
1 Drana, Kalastria Bloodchief
1 Ghoulcaller Gisa
1 Gray Merchant of Asphodel
1 Morkrut Banshee
1 Grave Titan
1 Phyrexian Gargantua
1 Pontiff of Blight
1 Reaper from the Abyss
1 Butcher of Malakir
1 Overseer of the Damned
1 Pestilence Demon
1 Liliana's Reaver
1 Xathrid Demon
1 Sign in Blood
1 Read the Bones
1 Victimize
1 Syphon Mind
1 Dread Return
1 Mutilate
1 Infernal Offering
1 Aether Snap
1 Promise of Power
1 Necromantic Selection
1 Profane Command
1 Dregs of Sorrow
1 Black Sun's Zenith
1 Spoils of Blood
1 Tragic Slip
1 Malicious Affliction
1 Sudden Spoiling
1 Tendrils of Corruption
1 Annihilate
1 Skeletal Scrying
1 Wake the Dead
1 Sol Ring
1 Charcoal Diamond
1 Jet Medallion
1 Mind Stone
1 Swiftfoot Boots
1 Unstable Obelisk
1 Worn Powerstone
1 Lashwrithe
1 Commander's Sphere
1 Bad Moon
1 Arcane Lighthouse
1 Barren Moor
1 Bojuka Bog
1 Crypt of Agadeem
1 Everglades
1 Ghost Quarter
1 Myriad Landscape
1 Polluted Mire
32 Swamp`,
  },
  c13_eternal_bargain: {
    label: "Eternal Bargain (Oloro, Ageless Ascetic)",
    set: "Commander 2013",
    bracket: 2,
    text: `Commander
1 Oloro, Ageless Ascetic

Deck
1 Ajani's Pridemate
1 Augury Adept
1 Azorius Herald
1 Disciple of Griselbrand
1 Diviner Spirit
1 Divinity of Pride
1 Filigree Angel
1 Hooded Horror
1 Kongming, "Sleeping Dragon"
1 Marrow Bats
1 Myr Battlesphere
1 Phyrexian Delver
1 Phyrexian Gargantua
1 Raven Familiar
1 Razor Hippogriff
1 Serene Master
1 Serra Avatar
1 Sharding Sphinx
1 Sharuum the Hegemon
1 Sphinx of the Steel Wind
1 Stormscape Battlemage
1 Sydri, Galvanic Genius
1 Tidal Force
1 Tidehollow Strix
1 Tower Gargoyle
1 Vizkopa Guildmage
1 Wall of Reverence
1 Brilliant Plan
1 Death Grasp
1 Deep Analysis
1 Famine
1 Order of Succession
1 Survival Cache
1 Tempt with Immortality
1 Toxic Deluge
1 Dromar's Charm
1 Lim-Dûl's Vault
1 Reckless Spite
1 Spinal Embrace
1 Crawlspace
1 Nevinyrral's Disk
1 Nihil Spellbomb
1 Obelisk of Esper
1 Pristine Talisman
1 Sol Ring
1 Sun Droplet
1 Swiftfoot Boots
1 Thopter Foundry
1 Well of Lost Dreams
1 Act of Authority
1 Cradle of Vitality
1 Curse of Inertia
1 Curse of Shallow Graves
1 Curse of the Forsaken
1 Darksteel Mutation
1 Greed
1 Phyrexian Reclamation
1 Sanguine Bond
1 Arcane Sanctum
1 Azorius Chancery
1 Azorius Guildgate
1 Barren Moor
1 Command Tower
1 Dimir Guildgate
1 Esper Panorama
1 Evolving Wilds
6 Island
1 Jwar Isle Refuge
1 Lonely Sandbar
1 Opal Palace
1 Orzhov Basilica
1 Orzhov Guildgate
9 Plains
1 Rupture Spire
1 Springjack Pasture
9 Swamp
1 Temple of the False God
1 Transguild Promenade`,
  },
  c13_evasive_maneuvers: {
    label: "Evasive Maneuvers (Derevi, Empyrial Tactician)",
    set: "Commander 2013",
    bracket: 2,
    text: `Commander
1 Derevi, Empyrial Tactician

Deck
1 Acidic Slime
1 Aerie Mystics
1 Angel of Finality
1 Azami, Lady of Scrolls
1 Bane of Progress
1 Deceiver Exarch
1 Diviner Spirit
1 Djinn of Infinite Deceits
1 Dungeon Geists
1 Farhaven Elf
1 Fiend Hunter
1 Flickerwisp
1 Hada Spy Patrol
1 Karmic Guide
1 Kazandu Tuskcaller
1 Lu Xun, Scholar General
1 Mirror Entity
1 Mistmeadow Witch
1 Murkfiend Liege
1 Phantom Nantuko
1 Pilgrim's Eye
1 Roon of the Hidden Realm
1 Rubinia Soulsinger
1 Selesnya Guildmage
1 Skyward Eye Prophets
1 Stonecloaker
1 Thornwind Faeries
1 Winged Coatl
1 Wonder
1 Borrowing 100,000 Arrows
1 Kirtar's Wrath
1 Restore
1 Tempt with Glory
1 Wash Out
1 Aethermage's Touch
1 Arcane Denial
1 Blue Sun's Zenith
1 Krosan Grip
1 Selesnya Charm
1 Unexpectedly Absent
1 Azorius Keyrune
1 Basalt Monolith
1 Conjurer's Closet
1 Darksteel Ingot
1 Leonin Bladetrap
1 Selesnya Signet
1 Simic Signet
1 Sol Ring
1 Surveyor's Scope
1 Swiftfoot Boots
1 Sword of the Paruns
1 Thousand-Year Elixir
1 Thunderstaff
1 Control Magic
1 Curse of Inertia
1 Curse of Predation
1 Curse of the Forsaken
1 Darksteel Mutation
1 Flickerform
1 Leafdrake Roost
1 Presence of Gond
1 Azorius Chancery
1 Azorius Guildgate
1 Bant Panorama
1 Command Tower
1 Evolving Wilds
1 Faerie Conclave
6 Forest
7 Island
1 Opal Palace
7 Plains
1 Rupture Spire
1 Saltcrusted Steppe
1 Seaside Citadel
1 Secluded Steppe
1 Sejiri Refuge
1 Selesnya Guildgate
1 Selesnya Sanctuary
1 Simic Guildgate
1 Temple of the False God
1 Terramorphic Expanse
1 Transguild Promenade`,
  },
  c13_mind_seize: {
    label: "Mind Seize (Jeleva, Nephalia's Scourge)",
    set: "Commander 2013",
    bracket: 2,
    text: `Commander
1 Jeleva, Nephalia's Scourge

Deck
1 Augur of Bolas
1 Baleful Force
1 Baleful Strix
1 Charmbreaker Devils
1 Diviner Spirit
1 Echo Mage
1 Fog Bank
1 Guard Gomazoa
1 Guttersnipe
1 Hooded Horror
1 Jace's Archivist
1 Mnemonic Wall
1 Nekusar, the Mindrazer
1 Nightscape Familiar
1 Nivix Guildmage
1 Terra Ravager
1 Thraximundar
1 True-Name Nemesis
1 Uyo, Silent Prophet
1 Vampire Nighthawk
1 Viseling
1 Army of the Damned
1 Cruel Ultimatum
1 Decree of Pain
1 Fissure Vent
1 Incendiary Command
1 Infest
1 Molten Disaster
1 Phthisis
1 Prosperity
1 Skyscribing
1 Strategic Planning
1 Tempt with Reflections
1 Annihilate
1 Crosis's Charm
1 Dismiss
1 Grixis Charm
1 Illusionist's Gambit
1 Opportunity
1 Soul Manipulation
1 Starstorm
1 Sudden Spoiling
1 Vision Skeins
1 Wild Ricochet
1 Armillary Sphere
1 Eye of Doom
1 Mirari
1 Obelisk of Grixis
1 Sol Ring
1 Swiftfoot Boots
1 Temple Bell
1 Wayfarer's Bauble
1 Arcane Melee
1 Curse of Chaos
1 Curse of Inertia
1 Curse of Shallow Graves
1 Price of Knowledge
1 Propaganda
1 Spiteful Visions
1 Akoum Refuge
1 Bojuka Bog
1 Command Tower
1 Crumbling Necropolis
1 Dimir Guildgate
1 Evolving Wilds
1 Grixis Panorama
9 Island
1 Izzet Boilerworks
1 Izzet Guildgate
1 Molten Slagheap
5 Mountain
1 Opal Palace
1 Rakdos Carnarium
1 Rakdos Guildgate
1 Rupture Spire
8 Swamp
1 Temple of the False God
1 Urza's Factory
1 Vivid Creek
1 Vivid Marsh`,
  },
  c13_nature_of_the_beast: {
    label: "Nature of the Beast (Marath, Will of the Wild)",
    set: "Commander 2013",
    bracket: 2,
    text: `Commander
1 Marath, Will of the Wild

Deck
1 Archangel
1 Avenger of Zendikar
1 Baloth Woodcrasher
1 Crater Hellion
1 Deadwood Treefolk
1 Drumhunter
1 Eternal Dragon
1 Gahiji, Honored One
1 Grazing Gladehart
1 Krosan Tusker
1 Krosan Warchief
1 Magus of the Arena
1 Mayael the Anima
1 Mold Shambler
1 Naya Soulbeast
1 Rakeclaw Gargantuan
1 Rampaging Baloths
1 Ravenous Baloth
1 Spellbreaker Behemoth
1 Spitebellows
1 Terra Ravager
1 Valley Rannet
1 Cultivate
1 Fiery Justice
1 Fireball
1 From the Ashes
1 Harmonize
1 Hull Breach
1 One Dozen Eyes
1 Rain of Thorns
1 Restore
1 Savage Twister
1 Slice and Dice
1 Tempt with Discovery
1 Wrath of God
1 Boros Charm
1 Naya Charm
1 Slice in Twain
1 Sprouting Vines
1 Street Spasm
1 Behemoth Sledge
1 Druidic Satchel
1 Seer's Sundial
1 Sol Ring
1 Swiftfoot Boots
1 Tower of Fortunes
1 Curse of Chaos
1 Curse of Predation
1 Curse of the Forsaken
1 Darksteel Mutation
1 Fires of Yavimaya
1 Mystic Barrier
1 Spawning Grounds
1 War Cadence
1 Warstorm Surge
1 Where Ancients Tread
1 Witch Hunt
1 Boros Garrison
1 Boros Guildgate
1 Command Tower
1 Contested Cliffs
1 Drifting Meadow
1 Evolving Wilds
8 Forest
1 Forgotten Cave
1 Gruul Guildgate
1 Homeward Path
1 Jungle Shrine
1 Khalni Garden
1 Mosswort Bridge
5 Mountain
1 Naya Panorama
1 New Benalia
1 Opal Palace
4 Plains
1 Rupture Spire
1 Secluded Steppe
1 Selesnya Guildgate
1 Selesnya Sanctuary
1 Slippery Karst
1 Smoldering Crater
1 Temple of the False God
1 Tranquil Thicket
1 Vitu-Ghazi, the City-Tree
1 Vivid Crag`,
  },
  c13_power_hungry: {
    label: "Power Hungry (Prossh, Skyraider of Kher)",
    set: "Commander 2013",
    bracket: 2,
    text: `Commander
1 Prossh, Skyraider of Kher

Deck
1 Brooding Saurian
1 Capricious Efreet
1 Charnelhoard Wurm
1 Deathbringer Thoctar
1 Deepfire Elemental
1 Elvish Skysweeper
1 Endless Cockroaches
1 Endrek Sahr, Master Breeder
1 Fell Shepherd
1 Goblin Sharpshooter
1 Golgari Guildmage
1 Hooded Horror
1 Hua Tuo, Honored Physician
1 Hunted Troll
1 Inferno Titan
1 Jade Mage
1 Ophiomancer
1 Quagmire Druid
1 Sakura-Tribe Elder
1 Scarland Thrinax
1 Sek'Kuar, Deathkeeper
1 Shattergang Brothers
1 Silklash Spider
1 Sprouting Thrinax
1 Stalking Vengeance
1 Stronghold Assassin
1 Terra Ravager
1 Viscera Seer
1 Walker of the Grove
1 Wight of Precinct Six
1 Dirge of Dread
1 Mass Mutiny
1 Restore
1 Rough // Tumble
1 Spoils of Victory
1 Sudden Demise
1 Tempt with Vengeance
1 Jund Charm
1 Reincarnation
1 Armillary Sphere
1 Carnage Altar
1 Jar of Eyeballs
1 Obelisk of Jund
1 Plague Boiler
1 Sol Ring
1 Spine of Ish Sah
1 Swiftfoot Boots
1 Blood Rites
1 Curse of Chaos
1 Curse of Predation
1 Curse of Shallow Graves
1 Fecundity
1 Foster
1 Furnace Celebration
1 Goblin Bombardment
1 Night Soil
1 Primal Vigor
1 Tooth and Claw
1 Vile Requiem
1 Widespread Panic
1 Akoum Refuge
1 Command Tower
1 Evolving Wilds
7 Forest
1 Golgari Guildgate
1 Golgari Rot Farm
1 Grim Backwoods
1 Gruul Guildgate
1 Jund Panorama
1 Kazandu Refuge
1 Khalni Garden
1 Kher Keep
1 Llanowar Reborn
7 Mountain
1 Opal Palace
1 Rakdos Guildgate
1 Rupture Spire
1 Savage Lands
6 Swamp
1 Temple of the False God
1 Terramorphic Expanse
1 Vivid Grove`,
  },
  cmd_counterpunch: {
    label: "Counterpunch (Ghave, Guru of Spores)",
    set: "Commander 2011",
    bracket: 2,
    text: `Commander
1 Ghave, Guru of Spores

Deck
1 Aquastrand Spider
1 Deadly Recluse
1 Sakura-Tribe Elder
1 Scavenging Ooze
1 Monk Realist
1 Selesnya Evangel
1 Golgari Guildmage
1 Selesnya Guildmage
1 Nantuko Husk
1 Fertilid
1 Spawnwrithe
1 Vampire Nighthawk
1 Spike Feeder
1 Yavimaya Elder
1 Squallmonger
1 Penumbra Spider
1 Sigil Captain
1 Shriekmaw
1 Dark Hatchling
1 Teneb, the Harvester
1 Hornet Queen
1 Vish Kal, Blood Arbiter
1 Symbiotic Wurm
1 Celestial Force
1 Karador, Ghost Chieftain
1 Chorus of the Conclave
1 Alliance of Arms
1 Cultivate
1 Harmonize
1 Syphon Flesh
1 Bestial Menace
1 Hex
1 Hour of Reckoning
1 Death Mutation
1 Storm Herd
1 Doom Blade
1 Tribute to the Wild
1 Footbottom Feast
1 Afterlife
1 Mortify
1 Nemesis Trap
1 Cobra Trap
1 Skullclamp
1 Sol Ring
1 Golgari Signet
1 Lightning Greaves
1 Orzhov Signet
1 Selesnya Signet
1 Darksteel Ingot
1 Acorn Catapult
1 Soul Snare
1 Fists of Ironwood
1 Necrogenesis
1 Vow of Malice
1 Awakening Zone
1 Vow of Wildness
1 Oblivion Ring
1 Vow of Duty
1 Attrition
1 Aura Shards
1 Barren Moor
1 Command Tower
1 Evolving Wilds
1 Golgari Rot Farm
1 Orzhov Basilica
1 Rupture Spire
1 Secluded Steppe
1 Selesnya Sanctuary
1 Temple of the False God
1 Tranquil Thicket
1 Vivid Grove
1 Vivid Marsh
1 Vivid Meadow
8 Swamp
10 Forest
8 Plains`,
  },
  cmd_mirror_mastery: {
    label: "Mirror Mastery (Riku of Two Reflections)",
    set: "Commander 2011",
    bracket: 2,
    text: `Commander
1 Riku of Two Reflections

Deck
1 Garruk Wildspeaker
1 Magus of the Vineyard
1 Veteran Explorer
1 Fierce Empath
1 Edric, Spymaster of Trest
1 Animar, Soul of Elements
1 Conundrum Sphinx
1 Aethersnipe
1 Chartooth Cougar
1 Rapacious One
1 Spitebellows
1 Deadwood Treefolk
1 Elvish Aberration
1 Baloth Woodcrasher
1 Hydra Omnivore
1 Nucklavee
1 Valley Rannet
1 Intet, the Dreamer
1 Faultgrinder
1 Krosan Tusker
1 Simic Sky Swallower
1 Trench Gorger
1 Avatar of Fury
1 Magmatic Force
1 Artisan of Kozilek
1 Collective Voyage
1 Hull Breach
1 Cultivate
1 Kodama's Reach
1 Firespout
1 Ruination
1 Explosive Vegetation
1 Chain Reaction
1 Death by Dragons
1 Vengeful Rebirth
1 Disaster Radius
1 Call the Skybreaker
1 Savage Twister
1 Brainstorm
1 Tribute to the Wild
1 Colossal Might
1 Invigorate
1 Spell Crumple
1 Electrolyze
1 Ray of Command
1 Prophetic Bolt
1 Hunting Pack
1 Sol Ring
1 Armillary Sphere
1 Gruul Signet
1 Izzet Signet
1 Lightning Greaves
1 Prophetic Prism
1 Simic Signet
1 Vow of Flight
1 Vow of Lightning
1 Vow of Wildness
1 Command Tower
1 Evolving Wilds
1 Fungal Reaches
1 Gruul Turf
1 Homeward Path
1 Izzet Boilerworks
1 Kazandu Refuge
1 Rupture Spire
1 Simic Growth Chamber
1 Temple of the False God
1 Vivid Crag
1 Vivid Creek
1 Vivid Grove
7 Island
8 Mountain
13 Forest
1 Fire // Ice`,
  },
  cmd_political_puppets: {
    label: "Political Puppets (Zedruu the Greathearted)",
    set: "Commander 2011",
    bracket: 2,
    text: `Commander
1 Zedruu the Greathearted

Deck
1 Goblin Cadets
1 Spurnmage Advocate
1 Jötun Grunt
1 Wall of Omens
1 Fog Bank
1 Nin, the Pain Artist
1 Azorius Guildmage
1 Court Hussar
1 Gomazoa
1 Guard Gomazoa
1 Vedalken Plotter
1 Wall of Denial
1 Plumeveil
1 Flametongue Kavu
1 Windborn Muse
1 False Prophet
1 Brion Stoutarm
1 Ruhan of the Fomori
1 Chromeshell Crab
1 Izzet Chronarch
1 Dominus of Fealty
1 Rapacious One
1 Numot, the Devastator
1 Arbiter of Knollridge
1 Breath of Darigaaz
1 Trade Secrets
1 Death by Dragons
1 Austere Command
1 Insurrection
1 Skyscribing
1 Brainstorm
1 Flusterstorm
1 Lash Out
1 Punishing Fire
1 Pollen Lullaby
1 Perilous Research
1 Vision Skeins
1 Whirlpool Whelm
1 Chaos Warp
1 Oblation
1 Murmurs from Beyond
1 Repulse
1 Spell Crumple
1 Wild Ricochet
1 Reins of Power
1 Scattering Stroke
1 Sol Ring
1 Armillary Sphere
1 Fellwar Stone
1 Howling Mine
1 Lightning Greaves
1 Prophetic Prism
1 Champion's Helm
1 Darksteel Ingot
1 Dreamstone Hedron
1 Soul Snare
1 Journey to Nowhere
1 Vow of Lightning
1 Ghostly Prison
1 Vow of Duty
1 Propaganda
1 Vow of Flight
1 Prison Term
1 Crescendo of War
1 Martyr's Bond
1 Azorius Chancery
1 Boros Garrison
1 Command Tower
1 Evolving Wilds
1 Izzet Boilerworks
1 Terramorphic Expanse
8 Mountain
8 Plains
12 Island`,
  },
};

export const SAMPLE_DECKS = {
  gruul: {
    label: 'Built-in deck · Bracket 3 — Gruul Stompy (Xenagos)',
    bracket: 3,
    text: `Commander
1 Xenagos, God of Revels

Deck
1 Sol Ring
1 Arcane Signet
1 Gruul Signet
1 Llanowar Elves
1 Elvish Mystic
1 Birds of Paradise
1 Rampant Growth
1 Cultivate
1 Kodama's Reach
1 Wood Elves
1 Sakura-Tribe Elder
1 Lightning Bolt
1 Chaos Warp
1 Beast Within
1 Harmonize
1 Eternal Witness
1 Thragtusk
1 Avenger of Zendikar
1 Inferno Titan
1 Thundermaw Hellkite
1 Hellkite Charger
1 Goblin Rabblemaster
1 Rampaging Baloths
1 Craterhoof Behemoth
1 Ghalta, Primal Hunger
1 Garruk Wildspeaker
1 Blasphemous Act
1 Vandalblast
1 Return of the Wildspeaker
1 Overrun
1 Heroic Intervention
1 Grizzly Bears
1 Kalonian Tusker
1 Garruk's Companion
1 Rancor
1 Lovestruck Beast
1 Questing Beast
1 Old Gnawbone
1 Terror of the Peaks
1 Pathbreaker Ibex
1 Explore
1 Three Visits
1 Nature's Lore
1 Mind Stone
1 Stomping Ground
1 Cinder Glade
1 Rugged Highlands
1 Command Tower
1 Exotic Orchard
1 Kessig Wolf Run
1 Game Trail
1 Rootbound Crag
${basics(23, 'Forest')}
${basics(24, 'Mountain')}`,
  },
  golgari: {
    label: 'Built-in deck · Bracket 3 — Golgari Value (Meren)',
    bracket: 3,
    text: `Commander
1 Meren of Clan Nel Toth

Deck
1 Sol Ring
1 Arcane Signet
1 Golgari Signet
1 Llanowar Elves
1 Elvish Mystic
1 Deathrite Shaman
1 Cultivate
1 Kodama's Reach
1 Rampant Growth
1 Sakura-Tribe Elder
1 Wood Elves
1 Ravenous Chupacabra
1 Murder
1 Doom Blade
1 Go for the Throat
1 Beast Within
1 Eternal Witness
1 Grave Titan
1 Massacre Wurm
1 Gray Merchant of Asphodel
1 Night's Whisper
1 Sign in Blood
1 Read the Bones
1 Phyrexian Arena
1 Damnation
1 Toxic Deluge
1 Avenger of Zendikar
1 Pelakka Wurm
1 Shriekmaw
1 Plaguecrafter
1 Viscera Seer
1 Fleshbag Marauder
1 Gonti, Lord of Luxury
1 Noxious Revival
1 Krosan Grip
1 Golgari Charm
1 Grim Flayer
1 Kokusho, the Evening Star
1 Sheoldred, the Apocalypse
1 Skullclamp
1 Tireless Tracker
1 Grisly Salvage
1 Infernal Grasp
1 Mind Stone
1 Woodland Cemetery
1 Overgrown Tomb
1 Llanowar Wastes
1 Jungle Hollow
1 Command Tower
1 Golgari Rot Farm
1 Temple of Malady
1 Twilight Mire
${basics(24, 'Swamp')}
${basics(23, 'Forest')}`,
  },
  whiteTokens: {
    label: 'Built-in deck · Bracket 2 — Mono-White Tokens (Adeline)',
    bracket: 2,
    text: `Commander
1 Adeline, Resplendent Cathar

Deck
1 Sol Ring
1 Arcane Signet
1 Mind Stone
1 Commander's Sphere
1 Fellwar Stone
1 Swords to Plowshares
1 Path to Exile
1 Generous Gift
1 Wrath of God
1 Austere Command
1 Return to Dust
1 Valorous Stance
1 Oblivion Ring
1 Banishing Light
1 Fateful Absence
1 Council's Judgment
1 Raise the Alarm
1 Secure the Wastes
1 Spectral Procession
1 Midnight Haunting
1 Increasing Devotion
1 Martial Coup
1 Rally the Ranks
1 Akroma's Will
1 Ephemerate
1 Intangible Virtue
1 Glorious Anthem
1 Honor of the Pure
1 Anointed Procession
1 Divine Visitation
1 Cathars' Crusade
1 Dictate of Heliod
1 Benalish Marshal
1 Thalia's Lieutenant
1 Champion of the Parish
1 Hero of Bladehold
1 Brimaz, King of Oreskos
1 Angel of Invention
1 Emeria Angel
1 Archangel of Thune
1 Serra Angel
1 Sun Titan
1 Restoration Angel
1 Captain of the Watch
1 Mentor of the Meek
1 Selfless Spirit
1 Kor Skyfisher
1 Militia Bugler
1 Heliod's Pilgrim
1 Thraben Inspector
1 Dauntless Bodyguard
1 Monastery Mentor
1 Inspiring Overseer
1 Wall of Omens
1 Mother of Runes
1 Thalia, Guardian of Thraben
1 Ajani's Pridemate
1 Soul Warden
1 Knight of the White Orchid
1 Elspeth, Sun's Champion
1 Elspeth Tirel
1 Gideon, Ally of Zendikar
1 Castle Ardenvale
1 Emeria, the Sky Ruin
${basics(35, 'Plains')}`,
  },
  izzet: {
    label: 'Built-in deck · Bracket 2 — Izzet Spells (Niv-Mizzet, Parun)',
    bracket: 2,
    text: `Commander
1 Niv-Mizzet, Parun

Deck
1 Sol Ring
1 Arcane Signet
1 Izzet Signet
1 Mind Stone
1 Talisman of Creativity
1 Fellwar Stone
1 Opt
1 Consider
1 Preordain
1 Ponder
1 Brainstorm
1 Serum Visions
1 Sleight of Hand
1 Anticipate
1 Lightning Bolt
1 Chain Lightning
1 Abrade
1 Pyroclasm
1 Counterspell
1 Arcane Denial
1 Negate
1 Mana Leak
1 Swan Song
1 Pongify
1 Rapid Hybridization
1 Into the Roil
1 Chaos Warp
1 Blasphemous Act
1 Fact or Fiction
1 Treasure Cruise
1 Behold the Multiverse
1 Expressive Iteration
1 Big Score
1 Unexpected Windfall
1 Faithless Looting
1 Thrill of Possibility
1 Izzet Charm
1 Electrolyze
1 Fire // Ice
1 Frantic Search
1 Prismari Command
1 Thousand-Year Storm
1 Mulldrifter
1 Archmage Emeritus
1 Guttersnipe
1 Young Pyromancer
1 Talrand, Sky Summoner
1 Murmuring Mystic
1 Crackling Drake
1 Electrostatic Field
1 Firebrand Archer
1 Third Path Iconoclast
1 Storm-Kiln Artist
1 Baral, Chief of Compliance
1 Goblin Electromancer
1 Brazen Borrower
1 Stormchaser Mage
1 Ledger Shredder
1 Sprite Dragon
1 Delver of Secrets
1 Ral, Storm Conduit
1 Reliquary Tower
1 Swiftwater Cliffs
1 Steam Vents
1 Sulfur Falls
1 Spirebluff Canal
1 Izzet Boilerworks
1 Shivan Reef
1 Command Tower
${basics(15, 'Island')}
${basics(15, 'Mountain')}`,
  },
  cats: {
    label: 'Built-in deck · Bracket 1 — Selesnya Cats (Arahbo)',
    bracket: 1,
    text: `Commander
1 Arahbo, Roar of the World

Deck
1 Sol Ring
1 Arcane Signet
1 Selesnya Signet
1 Rampant Growth
1 Cultivate
1 Kodama's Reach
1 Wood Elves
1 Farhaven Elf
1 Explore
1 Harrow
1 Ajani's Pridemate
1 Adorned Pouncer
1 Brimaz, King of Oreskos
1 Pride Sovereign
1 Regal Caracal
1 Leonin Warleader
1 Qasali Pridemage
1 Qasali Slingers
1 Sacred Cat
1 Prowling Serpopard
1 Feline Sovereign
1 Fleecemane Lion
1 Mirri, Weatherlight Duelist
1 Kemba, Kha Regent
1 Seht's Tiger
1 Leonin Skyhunter
1 Leonin Relic-Warder
1 Steppe Lynx
1 Savannah Lions
1 Silvercoat Lion
1 Raksha Golden Cub
1 Kaheera, the Orphanguard
1 Jedit Ojanen of Efrava
1 Felidar Guardian
1 Felidar Sovereign
1 Felidar Cub
1 Felidar Retreat
1 Qasali Ambusher
1 Pridemalkin
1 Mirri, Cat Warrior
1 Wild Nacatl
1 Nacatl War-Pride
1 King of the Pride
1 Whitemane Lion
1 Leonin of the Lost Pride
1 Leonin Elder
1 Leonin Den-Guard
1 Taj-Nar Swordsmith
1 Sabertooth Nishoba
1 Coat of Arms
1 Herald's Horn
1 Vanquisher's Banner
1 Swords to Plowshares
1 Beast Within
1 Generous Gift
1 Heroic Intervention
1 Return to Dust
1 Harmonize
1 Rishkar's Expertise
1 Overrun
1 Wrath of God
1 Lightning Greaves
1 Swiftfoot Boots
1 Command Tower
1 Path of Ancestry
1 Unclaimed Territory
1 Selesnya Sanctuary
1 Blossoming Sands
${basics(15, 'Plains')}
${basics(16, 'Forest')}`,
  },
  goblins: {
    label: 'Built-in deck · Bracket 1 — Mono-Red Goblins (Krenko, Tin Street Kingpin)',
    bracket: 1,
    text: `Commander
1 Krenko, Tin Street Kingpin

Deck
1 Sol Ring
1 Arcane Signet
1 Mind Stone
1 Fire Diamond
1 Ruby Medallion
1 Thought Vessel
1 Hedron Archive
1 Wayfarer's Bauble
1 Goblin Instigator
1 Beetleback Chief
1 Mogg War Marshal
1 Goblin Warchief
1 Goblin Chieftain
1 Goblin King
1 Goblin Piledriver
1 Siege-Gang Commander
1 Legion Warboss
1 Goblin Rabblemaster
1 Goblin Ringleader
1 Goblin Trashmaster
1 Battle Cry Goblin
1 Mogg Fanatic
1 Mogg Flunkies
1 Goblin Cratermaker
1 Goblin Arsonist
1 Goblin Heelcutter
1 Foundry Street Denizen
1 Goblin Lackey
1 Goblin Guide
1 Goblin Dark-Dwellers
1 Goblin Motivator
1 Goblin Kaboomist
1 Conspicuous Snoop
1 Gempalm Incinerator
1 Volley Veteran
1 Goblin Chainwhirler
1 Reckless Bushwhacker
1 Goblin Bushwhacker
1 Frenzied Goblin
1 Goblin Wardriver
1 Fanatical Firebrand
1 Ib Halfheart, Goblin Tactician
1 Goblin Shortcutter
1 Ember Hauler
1 Skirk Commando
1 Goblin Gaveleer
1 Purphoros, God of the Forge
1 Impact Tremors
1 Goblin Bombardment
1 Krenko's Command
1 Dragon Fodder
1 Hordeling Outburst
1 Goblin Rally
1 Boggart Shenanigans
1 Goblin War Strike
1 Goblin Warrens
1 Lightning Bolt
1 Abrade
1 Chaos Warp
1 Blasphemous Act
1 Shock
1 Light Up the Stage
1 Outpost Siege
1 Faithless Looting
1 Lightning Greaves
1 Command Tower
1 Castle Embereth
${basics(32, 'Mountain')}`,
  },
  korvold: {
    label: 'Built-in deck · Bracket 4 — Jund Sacrifice (Korvold, Fae-Cursed King)',
    bracket: 4,
    text: `Commander
1 Korvold, Fae-Cursed King

Deck
1 Sol Ring
1 Mana Vault
1 Arcane Signet
1 Talisman of Indulgence
1 Talisman of Impulse
1 Talisman of Resilience
1 Birds of Paradise
1 Llanowar Elves
1 Elvish Mystic
1 Fyndhorn Elves
1 Three Visits
1 Nature's Lore
1 Farseek
1 Sakura-Tribe Elder
1 Gilded Goose
1 Tireless Provisioner
1 Prosperous Innkeeper
1 Academy Manufactor
1 Grim Hireling
1 Prosper, Tome-Bound
1 Mayhem Devil
1 Pitiless Plunderer
1 Ashnod's Altar
1 Phyrexian Altar
1 Viscera Seer
1 Carrion Feeder
1 Blood Artist
1 Zulaport Cutthroat
1 Bastion of Remembrance
1 Mirkwood Bats
1 Woe Strider
1 Gravecrawler
1 Bloodghast
1 Reassembling Skeleton
1 Nether Traitor
1 Tireless Tracker
1 Savvy Hunter
1 Professional Face-Breaker
1 Goldspan Dragon
1 Revel in Riches
1 Skullclamp
1 Village Rites
1 Deadly Dispute
1 Plumb the Forbidden
1 Demonic Tutor
1 Vampiric Tutor
1 Diabolic Intent
1 Eldritch Evolution
1 Chord of Calling
1 Green Sun's Zenith
1 Gamble
1 Worldly Tutor
1 Assassin's Trophy
1 Abrupt Decay
1 Toxic Deluge
1 Feed the Swarm
1 Chaos Warp
1 Deadly Rollick
1 Infernal Grasp
1 Go for the Throat
1 Beast Within
1 Kolaghan's Command
1 Lightning Greaves
1 Swiftfoot Boots
1 Living Death
1 Command Tower
1 Exotic Orchard
1 Savage Lands
1 Ziatora's Proving Ground
1 Overgrown Tomb
1 Blood Crypt
1 Stomping Ground
1 Bloodstained Mire
1 Wooded Foothills
1 Verdant Catacombs
1 Dragonskull Summit
1 Woodland Cemetery
1 Rootbound Crag
1 Cinder Glade
1 Smoldering Marsh
1 Twilight Mire
1 Fire-Lit Thicket
1 Graven Cairns
1 Bojuka Bog
1 Gaea's Cradle
1 Haunted Ridge
1 Ignoble Hierarch
1 Witch's Oven
${basics(4, 'Forest')}
${basics(4, 'Swamp')}
${basics(3, 'Mountain')}`,
  },
  atraxa: {
    label: 'Built-in deck · Bracket 4 — Four-Color Counters (Atraxa, Praetors\' Voice)',
    bracket: 4,
    text: `Commander
1 Atraxa, Praetors' Voice

Deck
1 Sol Ring
1 Mana Vault
1 Arcane Signet
1 Chrome Mox
1 Fellwar Stone
1 Talisman of Dominance
1 Talisman of Unity
1 Talisman of Progress
1 Talisman of Resilience
1 Birds of Paradise
1 Noble Hierarch
1 Farseek
1 Nature's Lore
1 Three Visits
1 Cultivate
1 Smothering Tithe
1 Doubling Season
1 Hardened Scales
1 Winding Constrictor
1 Corpsejack Menace
1 Branching Evolution
1 Vorinclex, Monstrous Raider
1 Evolution Sage
1 Flux Channeler
1 Karn's Bastion
1 Contagion Engine
1 Inexorable Tide
1 Deepglow Skate
1 Oath of Teferi
1 The Chain Veil
1 Teferi, Hero of Dominaria
1 Teferi, Temporal Archmage
1 Garruk Wildspeaker
1 Vraska, Golgari Queen
1 Nissa, Who Shakes the World
1 Tamiyo, Field Researcher
1 Narset, Parter of Veils
1 Oko, Thief of Crowns
1 Ajani, Mentor of Heroes
1 Swords to Plowshares
1 Path to Exile
1 Counterspell
1 Anguished Unmaking
1 Assassin's Trophy
1 Vindicate
1 Cyclonic Rift
1 Supreme Verdict
1 Toxic Deluge
1 Teferi's Protection
1 Heroic Intervention
1 Arcane Denial
1 Swan Song
1 Mana Drain
1 Force of Will
1 Rhystic Study
1 Mystic Remora
1 Sylvan Library
1 Demonic Tutor
1 Vampiric Tutor
1 Enlightened Tutor
1 Mystical Tutor
1 Command Tower
1 City of Brass
1 Mana Confluence
1 Exotic Orchard
1 Breeding Pool
1 Hallowed Fountain
1 Watery Grave
1 Overgrown Tomb
1 Godless Shrine
1 Temple Garden
1 Flooded Strand
1 Polluted Delta
1 Misty Rainforest
1 Verdant Catacombs
1 Windswept Heath
1 Marsh Flats
1 Spara's Headquarters
1 Raffine's Tower
1 Indatha Triome
1 Sandsteppe Citadel
1 Arcane Sanctum
1 Seaside Citadel
1 Opulent Palace
1 Pernicious Deed
1 Generous Gift
1 Rishkar, Peema Renegade
1 The Ozolith
1 Lightning Greaves
1 Sylvan Caryatid
${basics(2, 'Plains')}
${basics(2, 'Island')}
${basics(2, 'Swamp')}
${basics(3, 'Forest')}`,
  },
  kinnan: {
    label: 'Built-in deck · Bracket 5 (cEDH) — Simic Combo (Kinnan, Bonder Prodigy)',
    bracket: 5,
    text: `Commander
1 Kinnan, Bonder Prodigy

Deck
1 Sol Ring
1 Mana Vault
1 Grim Monolith
1 Basalt Monolith
1 Chrome Mox
1 Mox Diamond
1 Mox Opal
1 Mox Amber
1 Lotus Petal
1 Arcane Signet
1 Fellwar Stone
1 Talisman of Curiosity
1 Birds of Paradise
1 Llanowar Elves
1 Elvish Mystic
1 Fyndhorn Elves
1 Arbor Elf
1 Delighted Halfling
1 Utopia Sprawl
1 Wild Growth
1 Gilded Goose
1 Devoted Druid
1 Incubation Druid
1 Paradise Druid
1 Bloom Tender
1 Priest of Titania
1 Isochron Scepter
1 Dramatic Reversal
1 Freed from the Real
1 Pemmin's Aura
1 Umbral Mantle
1 Walking Ballista
1 Hullbreaker Horror
1 Worldly Tutor
1 Mystical Tutor
1 Survival of the Fittest
1 Green Sun's Zenith
1 Finale of Devastation
1 Eldritch Evolution
1 Fauna Shaman
1 Force of Will
1 Force of Negation
1 Fierce Guardianship
1 Pact of Negation
1 Mental Misstep
1 Swan Song
1 Flusterstorm
1 Mana Drain
1 Counterspell
1 Spell Pierce
1 An Offer You Can't Refuse
1 Rapid Hybridization
1 Pongify
1 Snap
1 Cyclonic Rift
1 Rhystic Study
1 Mystic Remora
1 Sylvan Library
1 Ponder
1 Preordain
1 Brainstorm
1 Gitaxian Probe
1 Trinket Mage
1 Tezzeret the Seeker
1 Displacer Kitten
1 Breeding Pool
1 Misty Rainforest
1 Flooded Strand
1 Polluted Delta
1 Windswept Heath
1 Wooded Foothills
1 Verdant Catacombs
1 Yavimaya Coast
1 Hinterland Harbor
1 Waterlogged Grove
1 Command Tower
1 Gaea's Cradle
1 Ancient Tomb
1 Boseiju, Who Endures
1 Otawara, Soaring City
1 Tropical Island
1 Mana Confluence
1 City of Brass
1 Talon Gates of Madara
1 Elvish Spirit Guide
1 Springleaf Drum
1 Dryad Arbor
1 Training Grounds
1 Thousand-Year Elixir
1 Jeweled Amulet
1 Wall of Roots
1 Sylvan Scrying
${basics(4, 'Forest')}
${basics(3, 'Island')}`,
  },
  tnt: {
    label: 'Built-in deck · Bracket 5 (cEDH) — Four-Color Blitz (Thrasios & Tymna)',
    bracket: 5,
    text: `Commander
1 Thrasios, Triton Hero
1 Tymna the Weaver

Deck
1 Sol Ring
1 Mana Vault
1 Chrome Mox
1 Mox Diamond
1 Lotus Petal
1 Arcane Signet
1 Fellwar Stone
1 Talisman of Dominance
1 Birds of Paradise
1 Noble Hierarch
1 Elvish Mystic
1 Llanowar Elves
1 Fyndhorn Elves
1 Delighted Halfling
1 Carpet of Flowers
1 Dark Ritual
1 Cabal Ritual
1 Demonic Tutor
1 Vampiric Tutor
1 Imperial Seal
1 Mystical Tutor
1 Enlightened Tutor
1 Worldly Tutor
1 Wishclaw Talisman
1 Grim Tutor
1 Force of Will
1 Force of Negation
1 Pact of Negation
1 Mana Drain
1 Counterspell
1 Swan Song
1 Flusterstorm
1 Silence
1 Swords to Plowshares
1 Path to Exile
1 Assassin's Trophy
1 Abrupt Decay
1 Drannith Magistrate
1 Opposition Agent
1 Rhystic Study
1 Mystic Remora
1 Necropotence
1 Sylvan Library
1 Esper Sentinel
1 Dark Confidant
1 Ad Nauseam
1 Brainstorm
1 Ponder
1 Preordain
1 Gitaxian Probe
1 Thassa's Oracle
1 Demonic Consultation
1 Tainted Pact
1 Dramatic Reversal
1 Isochron Scepter
1 Spell Pierce
1 Mental Misstep
1 Grand Abolisher
1 Deathrite Shaman
1 Gilded Goose
1 Command Tower
1 City of Brass
1 Mana Confluence
1 Forbidden Orchard
1 Breeding Pool
1 Hallowed Fountain
1 Watery Grave
1 Overgrown Tomb
1 Godless Shrine
1 Temple Garden
1 Flooded Strand
1 Polluted Delta
1 Misty Rainforest
1 Verdant Catacombs
1 Windswept Heath
1 Marsh Flats
1 Scalding Tarn
1 Bloodstained Mire
1 Wooded Foothills
1 Arid Mesa
1 Ancient Tomb
1 Gaea's Cradle
1 Tropical Island
1 Underground Sea
1 Bayou
1 Scrubland
1 Savannah
1 Tundra
1 Gemstone Caverns
1 Elvish Spirit Guide
1 Mox Amber
1 Toxic Deluge
1 Faerie Mastermind
1 Spellseeker
${basics(1, 'Island')}
${basics(1, 'Swamp')}
${basics(1, 'Forest')}
${basics(1, 'Plains')}`,
  },
};
