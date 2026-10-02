#!/usr/bin/env node
// EDH Playtester — local server.
// Serves the app and proxies the three outside services it needs:
//   Moxfield / Archidekt (deck links) and Scryfall (card data + images metadata).
// No dependencies: needs Node 18 or newer.  Run:  node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 5173;
const PUBLIC_DIR = process.env.EDH_PUBLIC_DIR || path.join(__dirname, 'public');
const APP_UA = 'EDHPlaytester/1.0 (local hobby playtester)';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Scryfall asks for ~10 requests/second at most.
let lastScryfall = 0;
async function scryfall(url, init = {}) {
  const wait = Math.max(0, lastScryfall + 110 - Date.now());
  if (wait) await sleep(wait);
  lastScryfall = Date.now();
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': APP_UA, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const cardCache = new Map(); // key -> trimmed card

function trimCard(c) {
  if (!c || c.object !== 'card') return null;
  const face = (f) => ({
    name: f.name,
    mana_cost: f.mana_cost || '',
    type_line: f.type_line || '',
    oracle_text: f.oracle_text || '',
    power: f.power,
    toughness: f.toughness,
    loyalty: f.loyalty,
    defense: f.defense,
    image_uris: f.image_uris ? { normal: f.image_uris.normal, large: f.image_uris.large } : undefined,
  });
  return {
    id: c.id,
    oracle_id: c.oracle_id,
    name: c.name,
    layout: c.layout,
    mana_cost: c.mana_cost || (c.card_faces ? c.card_faces[0].mana_cost : '') || '',
    cmc: c.cmc || 0,
    type_line: c.type_line || '',
    oracle_text: c.oracle_text || '',
    power: c.power,
    toughness: c.toughness,
    loyalty: c.loyalty,
    defense: c.defense,
    colors: c.colors || (c.card_faces && c.card_faces[0].colors) || [],
    color_identity: c.color_identity || [],
    keywords: c.keywords || [],
    produced_mana: c.produced_mana || [],
    image_uris: c.image_uris ? { normal: c.image_uris.normal, large: c.image_uris.large } : undefined,
    card_faces: c.card_faces ? c.card_faces.map(face) : undefined,
    all_parts: (c.all_parts || [])
      .filter((p) => p.component === 'token' || (p.type_line || '').includes('Emblem'))
      .map((p) => ({ id: p.id, name: p.name, type_line: p.type_line })),
    set: c.set,
    collector_number: c.collector_number,
    digital: !!c.digital,
  };
}

function idKey(ident) {
  if (ident.id) return 'id:' + ident.id;
  if (ident.set && ident.collector_number) return `sc:${ident.set}/${ident.collector_number}`.toLowerCase();
  return 'n:' + String(ident.name || '').toLowerCase();
}

// Resolve a list of identifiers ({id} | {name} | {set, collector_number, name}) to trimmed cards.
async function resolveCards(identifiers) {
  const out = {};
  const pending = [];
  for (const ident of identifiers) {
    const k = idKey(ident);
    if (cardCache.has(k)) out[k] = cardCache.get(k);
    else pending.push(ident);
  }
  const notFound = [];
  for (let i = 0; i < pending.length; i += 75) {
    const chunk = pending.slice(i, i + 75);
    const sendIds = chunk.map((x) =>
      x.id ? { id: x.id } : x.set && x.collector_number ? { set: x.set, collector_number: String(x.collector_number) } : { name: x.name }
    );
    const { status, body } = await scryfall('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      body: JSON.stringify({ identifiers: sendIds }),
    });
    if (status !== 200) throw new Error('Scryfall error ' + status + ': ' + (body.details || ''));
    const found = (body.data || []).map(trimCard);
    // Match results back to requests.
    for (const ident of chunk) {
      const k = idKey(ident);
      let hit = null;
      if (ident.id) hit = found.find((c) => c.id === ident.id);
      else if (ident.set && ident.collector_number)
        hit = found.find(
          (c) => c.set === String(ident.set).toLowerCase() && String(c.collector_number) === String(ident.collector_number)
        );
      if (!hit && ident.name) {
        const n = ident.name.toLowerCase();
        hit = found.find(
          (c) => c.name.toLowerCase() === n || c.name.toLowerCase().split(' // ')[0] === n.split(' // ')[0]
        );
      }
      if (hit) {
        cardCache.set(k, hit);
        out[k] = hit;
      } else notFound.push(ident);
    }
  }
  // Second chance: printing not found -> by name; name not found -> fuzzy front face.
  for (const ident of notFound) {
    const k = idKey(ident);
    if (!ident.name) continue;
    const q = ident.name.split(' // ')[0];
    const { status, body } = await scryfall('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(q));
    if (status === 200) {
      const c = trimCard(body);
      cardCache.set(k, c);
      out[k] = c;
    }
  }
  // Name-only lookups can land on a digital-only printing (e.g. the Arena "Through the Omenpaths"
  // versions of Spider-Man cards). Swap those for the newest paper printing so the art matches.
  for (const ident of identifiers) {
    const k = idKey(ident);
    const c = out[k];
    if (!c || !isDigitalPrint(c)) continue;
    const q = `!"${c.name.split(' // ')[0]}" -is:digital -set:om1`;
    const { status, body } = await scryfall('https://api.scryfall.com/cards/search?unique=prints&order=released&dir=desc&q=' + encodeURIComponent(q));
    const paper = status === 200 && (body.data || []).map(trimCard).find((x) => x && !isDigitalPrint(x));
    if (paper) {
      cardCache.set(k, paper);
      out[k] = paper;
    }
  }
  return identifiers.map((ident) => out[idKey(ident)] || null);
}

function isDigitalPrint(c) {
  return !!c.digital || c.set === 'om1';
}

// ---------------------------------------------------------------- deck links
function entry(name, qty, set, cn) {
  return { name, qty: Number(qty) || 1, set: set || undefined, collector_number: cn || undefined };
}

async function fetchMoxfield(id) {
  const tries = [`https://api2.moxfield.com/v3/decks/all/${id}`, `https://api2.moxfield.com/v2/decks/all/${id}`];
  let lastStatus = 0;
  for (const url of tries) {
    const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
    lastStatus = res.status;
    if (!res.ok) continue;
    const d = await res.json();
    const commanders = [];
    const main = [];
    const companions = [];
    const collect = (board, into) => {
      if (!board) return;
      const cards = board.cards || board; // v3: {cards:{...}}  v2: {...}
      for (const k of Object.keys(cards)) {
        const e = cards[k];
        const c = e.card || {};
        into.push(entry(c.name || k, e.quantity, c.set, c.cn));
      }
    };
    if (d.boards) {
      collect(d.boards.commanders, commanders);
      collect(d.boards.companions, companions);
      collect(d.boards.mainboard, main);
    } else {
      collect(d.commanders, commanders);
      collect(d.companions, companions);
      collect(d.mainboard, main);
    }
    return { name: d.name || 'Moxfield deck', commanders, main, companions };
  }
  throw new Error(
    lastStatus === 403 || lastStatus === 429
      ? 'Moxfield refused the request (it blocks some automated access). Open the deck on Moxfield, choose Export → Copy for MTGO/Plain text, and paste the list instead.'
      : 'Could not load that Moxfield deck (status ' + lastStatus + '). Is the deck public?'
  );
}

async function fetchArchidekt(id) {
  const res = await fetch(`https://archidekt.com/api/decks/${id}/`, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('Could not load that Archidekt deck (status ' + res.status + '). Is the deck public?');
  const d = await res.json();
  const excluded = new Set(['maybeboard', 'sideboard', 'considering']);
  for (const cat of d.categories || []) {
    if (cat && cat.includedInDeck === false) excluded.add(String(cat.name).toLowerCase());
  }
  const commanders = [];
  const main = [];
  const companions = [];
  for (const e of d.cards || []) {
    const cats = (e.categories || []).map((c) => String(typeof c === 'string' ? c : c.name).toLowerCase());
    const card = e.card || {};
    const name = (card.oracleCard && card.oracleCard.name) || card.name || card.displayName;
    if (!name) continue;
    const set = card.edition && card.edition.editioncode;
    const cn = card.collectorNumber;
    if (cats.includes('commander')) commanders.push(entry(name, e.quantity, set, cn));
    else if (cats.includes('companion')) companions.push(entry(name, e.quantity, set, cn));
    else if (cats.length && cats.every((c) => excluded.has(c))) continue;
    else if (cats[0] && excluded.has(cats[0])) continue;
    else main.push(entry(name, e.quantity, set, cn));
  }
  return { name: d.name || 'Archidekt deck', commanders, main, companions };
}

async function fetchDeck(url) {
  let m = url.match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/);
  if (m) return fetchMoxfield(m[1]);
  m = url.match(/archidekt\.com\/(?:api\/)?decks\/(\d+)/);
  if (m) return fetchArchidekt(m[1]);
  throw new Error('That link is not a Moxfield or Archidekt deck link.');
}

// ---------------------------------------------------------------- saved decks (saved-decks.json next to this file)
const SAVED_FILE = path.join(process.env.EDH_DATA_DIR || __dirname, 'saved-decks.json');
function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8'));
  } catch (e) {
    return [];
  }
}
function writeSaved(list) {
  fs.writeFileSync(SAVED_FILE, JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------- http
function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2e6) reject(new Error('Body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/api/deck' && req.method === 'GET') {
      const deck = await fetchDeck(u.searchParams.get('url') || '');
      return send(res, 200, deck);
    }
    if (u.pathname === '/api/cards' && req.method === 'POST') {
      const { identifiers } = JSON.parse((await readBody(req)) || '{}');
      if (!Array.isArray(identifiers)) return send(res, 400, { error: 'identifiers must be an array' });
      const cards = await resolveCards(identifiers.slice(0, 600));
      return send(res, 200, { cards });
    }
    if (u.pathname === '/api/tokens' && req.method === 'GET') {
      const q = (u.searchParams.get('q') || '').trim();
      const query = `t:token ${q}`.trim();
      const { status, body } = await scryfall(
        'https://api.scryfall.com/cards/search?unique=cards&order=name&q=' + encodeURIComponent(query)
      );
      if (status === 404) return send(res, 200, { cards: [] });
      if (status !== 200) return send(res, 502, { error: 'Scryfall search failed' });
      const cards = (body.data || []).slice(0, 60).map(trimCard);
      cards.forEach((c) => cardCache.set('id:' + c.id, c));
      return send(res, 200, { cards });
    }
    if (u.pathname === '/api/version') return send(res, 200, { version: process.env.EDH_VERSION || require('./package.json').version, source: process.env.EDH_VERSION_SOURCE || 'local' });
    if (u.pathname === '/api/saved' && req.method === 'GET') return send(res, 200, { decks: readSaved() });
    if (u.pathname === '/api/saved' && req.method === 'POST') {
      const d = JSON.parse((await readBody(req)) || '{}');
      if (!d.name || !d.text) return send(res, 400, { error: 'A saved deck needs a name and a decklist.' });
      const list = readSaved();
      const now = new Date().toISOString();
      let entry = list.find((x) => (d.id && x.id === d.id) || x.name.toLowerCase() === String(d.name).toLowerCase());
      if (entry) Object.assign(entry, { name: String(d.name).slice(0, 120), text: d.text, commander: d.commander || '', source: d.source || entry.source || '', updated: now });
      else {
        entry = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(d.name).slice(0, 120), text: d.text, commander: d.commander || '', source: d.source || '', saved: now, updated: now };
        list.push(entry);
      }
      writeSaved(list);
      return send(res, 200, { deck: entry, decks: list });
    }
    if (u.pathname === '/api/saved' && req.method === 'DELETE') {
      const id = u.searchParams.get('id');
      const list = readSaved().filter((x) => x.id !== id);
      writeSaved(list);
      return send(res, 200, { decks: list });
    }
    if (u.pathname.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });

    // static files
    let p = decodeURIComponent(u.pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message || String(e) });
  }
});

// Start listening. The desktop app calls start() itself; `node server.js` runs it directly.
function start(port = PORT, host) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener('error', onError);
      reject(e);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}

if (require.main === module) {
  start().then((port) => console.log(`\n  EDH Playtester is running →  http://localhost:${port}\n  (Ctrl+C to stop)\n`));
}

module.exports = { start, server };
