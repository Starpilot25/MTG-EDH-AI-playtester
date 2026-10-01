// Game state, zones and the actions both players use.
import { DB } from './data.js';
import { isCreature, isLand, power, isDead, def } from './rules.js';

export const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile', 'command'];
export const STEPS = ['untap', 'upkeep', 'draw', 'main1', 'combat', 'main2', 'end'];
export const STEP_LABEL = {
  untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw', main1: 'Main 1', combat: 'Combat', main2: 'Main 2', end: 'End',
};

export const G = {
  s: null,
  undo: [],
  redo: [],
  listeners: new Set(),
  settings: {
    startingLife: 40,
    freeMulligan: true,
    autoCommander: true,
    aiSpeed: 650,
    pauseOnAiSpells: true,
    autoUntap: true,
    autoDraw: true,
    arenaMode: true,
  },
};

let nextId = 1;

// Game events waiting for triggered abilities (processed by triggers.js)
export const eventQueue = [];
export function queueEvent(ev) {
  if (G.s && G.s.phase === 'play') eventQueue.push({ ...ev, turn: G.s.turn });
}
const uid = () => 'c' + nextId++;

export function onChange(fn) {
  G.listeners.add(fn);
}
export function emit() {
  for (const fn of G.listeners) fn(G.s);
}

export function snapshot() {
  if (!G.s) return;
  G.undo.push(JSON.stringify(G.s));
  if (G.undo.length > 60) G.undo.shift();
  G.redo = [];
}
export function undo() {
  if (!G.undo.length) return false;
  G.redo.push(JSON.stringify(G.s));
  G.s = JSON.parse(G.undo.pop());
  emit();
  return true;
}
export function redo() {
  if (!G.redo.length) return false;
  G.undo.push(JSON.stringify(G.s));
  G.s = JSON.parse(G.redo.pop());
  emit();
  return true;
}

function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newPlayer(name) {
  const z = {};
  ZONES.forEach((k) => (z[k] = []));
  return { name, life: G.settings.startingLife, poison: 0, zones: z, cmdDmg: {}, tax: {}, mulligans: 0, lost: null };
}

export function newGame(pDeck, aiDeck) {
  nextId = 1;
  const s = {
    cards: {},
    players: { p: newPlayer('You'), ai: newPlayer('AI') },
    decks: { p: { name: pDeck.name }, ai: { name: aiDeck.name } },
    turn: 0,
    active: null,
    first: null,
    step: 'main1',
    landPlayed: false,
    combat: null,
    log: [],
    phase: 'mulligan',
    winner: null,
  };
  G.s = s;
  eventQueue.length = 0;
  G.undo = [];
  G.redo = [];
  for (const [pid, deck] of [['p', pDeck], ['ai', aiDeck]]) {
    for (const id of deck.commanders) {
      const iid = makeCard(id, pid, 'command');
      s.cards[iid].isCommander = true;
      s.players[pid].tax[iid] = 0;
    }
    for (const id of deck.cards) makeCard(id, pid, 'library');
    shuffleArr(s.players[pid].zones.library);
  }
  s.first = Math.random() < 0.5 ? 'p' : 'ai';
  log('sys', `Coin flip: <b>${s.first === 'p' ? 'you go' : 'the AI goes'} first</b>.`);
  draw('p', 7, true);
  draw('ai', 7, true);
  return s;
}

export function makeCard(defId, owner, zone, extra = {}) {
  const iid = uid();
  const inst = {
    iid, def: defId, owner, controller: owner, zone,
    tapped: false, face: 0, faceDown: false, counters: {}, ptMod: null, damage: 0,
    sick: true, token: !!extra.token, isCommander: false, x: null, y: null, ...extra,
  };
  G.s.cards[iid] = inst;
  if (zone) G.s.players[owner].zones[zone].push(iid);
  return iid;
}

export function card(iid) {
  return G.s.cards[iid];
}
export function zoneOf(pid, z) {
  return G.s.players[pid].zones[z];
}
export function cardsIn(pid, z) {
  return G.s.players[pid].zones[z].map((i) => G.s.cards[i]);
}
export function opp(pid) {
  return pid === 'p' ? 'ai' : 'p';
}

export function cardName(inst) {
  if (!inst) return '?';
  if (inst.faceDown) return 'a face-down card';
  return DB[inst.def].faces[inst.face || 0].name;
}
export function nameTag(inst) {
  if (!inst) return '?';
  if (inst.faceDown) return '<i>a face-down card</i>';
  return `<span class="cn" data-def="${inst.def}" data-face="${inst.face || 0}">${esc(cardName(inst))}</span>`;
}
export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function log(who, html) {
  G.s.log.push({ who, html, turn: G.s.turn });
  if (G.s.log.length > 400) G.s.log.shift();
}

// ------------------------------------------------------------ zone movement
/**
 * Move a card between zones (possibly across controllers' battlefields).
 * opts: {to:'top'|'bottom'|index, x, y, controller, tapped, faceDown, silent}
 */
export function move(iid, zone, opts = {}) {
  const s = G.s;
  const c = s.cards[iid];
  if (!c) return;
  const fromZone = c.zone;
  const fromCtl = fromZone === 'battlefield' ? c.controller : c.owner;
  // things triggered abilities care about ("whenever a creature dies", landfall)
  if (fromZone === 'battlefield' && zone === 'graveyard' && isCreature(c))
    queueEvent({ type: 'dies', iid, def: c.def, face: c.face || 0, controller: c.controller, owner: c.owner, token: c.token, power: power(c) });
  if (zone === 'battlefield' && fromZone !== 'battlefield' && isLand(c))
    queueEvent({ type: 'landfall', iid, controller: opts.controller || c.controller });
  // remove from old zone
  if (fromZone) {
    const arr = s.players[fromCtl].zones[fromZone];
    const k = arr.indexOf(iid);
    if (k >= 0) arr.splice(k, 1);
  }
  // commander replacement
  if (c.isCommander && (zone === 'graveyard' || zone === 'exile') && (c.owner === 'ai' || G.settings.autoCommander)) {
    zone = 'command';
  }
  // tokens cease to exist outside the battlefield
  if (c.token && zone !== 'battlefield') {
    delete s.cards[iid];
    if (combatRef()) dropFromCombat(iid);
    return null;
  }
  const leavingField = fromZone === 'battlefield' && zone !== 'battlefield';
  if (leavingField || (zone !== 'battlefield' && fromZone !== 'battlefield')) {
    c.tapped = false;
    c.counters = {};
    c.ptMod = null;
    c.damage = 0;
    c.deathtouched = false;
    c.grants = [];
    c.auraBuffs = null;
    c.eot = null;
    c.eotGrants = null;
    c.pacifiedBy = null;
    c.attachedTo = null;
    c.attacking = false;
    if (zone !== 'exile') c.faceDown = false;
    c.face = 0;
    c.controller = c.owner;
    c.x = c.y = null;
    if (combatRef()) dropFromCombat(iid);
  }
  if (zone === 'battlefield' && fromZone !== 'battlefield') {
    c.sick = true;
    c.enteredTurn = s.turn;
  }
  if (opts.controller) c.controller = opts.controller;
  if (opts.tapped !== undefined) c.tapped = opts.tapped;
  if (opts.faceDown !== undefined) c.faceDown = opts.faceDown;
  if (opts.x !== undefined) c.x = opts.x;
  if (opts.y !== undefined) c.y = opts.y;
  c.zone = zone;
  const owner = zone === 'battlefield' ? c.controller : c.owner;
  const arr = s.players[owner].zones[zone];
  if (opts.to === 'bottom') {
    // library "bottom" is index 0 (top of library is the end of the array)
    if (zone === 'library') arr.unshift(iid);
    else arr.push(iid);
  } else if (typeof opts.to === 'number') arr.splice(opts.to, 0, iid);
  else arr.push(iid);
  return c;
}

function combatRef() {
  return G.s.combat;
}
function dropFromCombat(iid) {
  const cb = G.s.combat;
  cb.attackers = cb.attackers.filter((a) => a !== iid);
  delete cb.blocks[iid];
  for (const k of Object.keys(cb.blocks)) cb.blocks[k] = cb.blocks[k].filter((b) => b !== iid);
}

export function libTop(pid, n = 1) {
  const lib = zoneOf(pid, 'library');
  return lib.slice(Math.max(0, lib.length - n)).reverse();
}

export function draw(pid, n = 1, silent = false) {
  const lib = zoneOf(pid, 'library');
  let drawn = 0;
  for (let k = 0; k < n; k++) {
    if (!lib.length) {
      if (G.s.phase === 'play') {
        log(pid, `${pid === 'p' ? 'You try' : 'The AI tries'} to draw from an empty library.`);
        loseGame(pid, 'drew from an empty library');
      }
      break;
    }
    move(lib[lib.length - 1], 'hand');
    drawn++;
  }
  if (!silent && drawn) log(pid, `${pid === 'p' ? 'You draw' : 'AI draws'} ${drawn} card${drawn > 1 ? 's' : ''}.`);
  return drawn;
}

export function shuffle(pid) {
  shuffleArr(zoneOf(pid, 'library'));
  G.s.cards; // noop
}

export function mill(pid, n) {
  const ids = libTop(pid, n);
  ids.forEach((i) => move(i, 'graveyard'));
  if (ids.length) log(pid, `${pid === 'p' ? 'You mill' : 'AI mills'} ${ids.map((i) => nameTag(card(i))).join(', ')}.`);
}

export function setLife(pid, value, reason) {
  const pl = G.s.players[pid];
  const before = pl.life;
  pl.life = value;
  if (reason !== false && value !== before)
    log(pid, `${pid === 'p' ? 'Your' : 'AI'} life ${before} → <b>${value}</b>${reason ? ' (' + reason + ')' : ''}.`);
  checkLoss(pid);
}
export function changeLife(pid, delta, reason) {
  setLife(pid, G.s.players[pid].life + delta, reason);
}

export function checkLoss(pid) {
  const pl = G.s.players[pid];
  if (pl.lost) return;
  if (pl.life <= 0) loseGame(pid, 'life total reached 0');
  else if (pl.poison >= 10) loseGame(pid, '10 poison counters');
  else if (Object.values(pl.cmdDmg).some((v) => v >= 21)) loseGame(pid, '21 commander damage');
}

export function loseGame(pid, why) {
  const pl = G.s.players[pid];
  if (pl.lost || G.s.winner) return;
  pl.lost = why;
  G.s.winner = opp(pid);
  log('sys', `<b>${pid === 'p' ? 'You lose' : 'The AI loses'}</b> — ${why}.`);
}

export function untapAll(pid) {
  for (const c of cardsIn(pid, 'battlefield')) {
    c.tapped = false;
    c.sick = false;
  }
}

export function cleanupDamage() {
  for (const c of Object.values(G.s.cards)) {
    c.damage = 0;
    c.deathtouched = false;
    c.attacking = false;
    c.eot = null;
    c.eotGrants = null;
  }
}

// creatures with lethal damage go to the graveyard
export function stateBased() {
  // auras fall off when what they enchant leaves; buffs go away with the aura
  const all = Object.values(G.s.cards);
  for (const a of all) {
    if (a.zone === 'battlefield' && a.attachedTo && (!G.s.cards[a.attachedTo] || G.s.cards[a.attachedTo].zone !== 'battlefield')) {
      a.attachedTo = null;
      if (/\bAura\b/.test(DB[a.def].typeLine)) {
        log(a.controller, `${nameTag(a)} goes to the graveyard (nothing to enchant).`);
        move(a.iid, 'graveyard');
      }
    }
  }
  for (const c of Object.values(G.s.cards)) {
    if (c.zone !== 'battlefield') continue;
    if (c.pacifiedBy && (!G.s.cards[c.pacifiedBy] || G.s.cards[c.pacifiedBy].zone !== 'battlefield')) c.pacifiedBy = null;
    if (c.auraBuffs)
      for (const k of Object.keys(c.auraBuffs))
        if (!G.s.cards[k] || G.s.cards[k].zone !== 'battlefield') delete c.auraBuffs[k];
  }
  const died = [];
  for (const pid of ['p', 'ai']) {
    for (const c of cardsIn(pid, 'battlefield')) {
      if (isCreature(c) && isDead(c)) died.push(c);
    }
  }
  for (const c of died) {
    const name = nameTag(c);
    const isCmd = c.isCommander;
    move(c.iid, 'graveyard');
    log(c.controller === 'p' || c.owner === 'p' ? 'p' : 'ai', `${name} dies${isCmd ? ' (to the command zone)' : ''}.`);
  }
  for (const pid of ['p', 'ai']) checkLoss(pid);
  return died.length;
}

// Put a card onto the battlefield, choosing a free spot for the player's side.
export function toBattlefield(iid, pid, opts = {}) {
  const c = card(iid);
  const pos = pid === 'p' && (opts.x === undefined || opts.x === null) ? freeSpot(c) : {};
  return move(iid, 'battlefield', { controller: pid, ...pos, ...opts });
}

export const CARD_W = 88;
export const CARD_H = 123;

export function freeSpot(c) {
  const land = c && isLand(c);
  const taken = cardsIn('p', 'battlefield').filter((o) => o.iid !== c.iid && o.x !== null);
  const W = window.__fieldWidth || 900;
  const H = window.__fieldHeight || 360;
  const stepX = CARD_W + 10;
  const rows = land
    ? [Math.max(8, H - CARD_H - 10), Math.max(8, H - CARD_H * 2 - 22)]
    : [10, 10 + CARD_H + 12, 10 + (CARD_H + 12) * 2];
  for (const y of rows) {
    for (let x = 22; x + CARD_W <= W - 22; x += stepX) {
      const hit = taken.some((o) => Math.abs(o.x - x) < CARD_W * 0.6 && Math.abs(o.y - y) < CARD_H * 0.6);
      if (!hit) return { x, y };
    }
  }
  return { x: 22 + Math.random() * Math.max(0, W - CARD_W - 44), y: 10 + Math.random() * 40 };
}

export function commanderTax(pid, iid) {
  return (G.s.players[pid].tax[iid] || 0) * 2;
}

export function createToken(defId, pid, n = 1, opts = {}) {
  const made = [];
  for (let k = 0; k < n; k++) {
    const iid = makeCard(defId, pid, null, { token: true });
    toBattlefield(iid, pid, opts);
    made.push(iid);
  }
  return made;
}

// Generic token used when the real token isn't known.
const ARTIFACT_TOKENS = {
  Treasure: '{T}, Sacrifice this artifact: Add one mana of any color.',
  Clue: '{2}, Sacrifice this artifact: Draw a card.',
  Food: '{2}, {T}, Sacrifice this artifact: You gain 3 life.',
  Blood: '{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.',
  Map: '{1}, {T}, Sacrifice this artifact: Target creature you control explores. Activate only as a sorcery.',
};
export function genericTokenDef(p, t, label, color) {
  const artifact = ARTIFACT_TOKENS[label];
  const id = artifact ? `gen-${label}` : `gen-${p}-${t}-${label}`.replace(/\s+/g, '_');
  if (!DB[id]) {
    const typeLine = artifact ? `Token Artifact — ${label}` : `Token Creature — ${label}`;
    DB[id] = {
      id, name: label, layout: 'token', cmc: 0, manaCost: '', typeLine,
      colors: color ? [color] : [], ci: [], keywords: [], produced: label === 'Treasure' ? ['W', 'U', 'B', 'R', 'G'] : [],
      tokens: [], doubleFaced: false, isToken: true,
      faces: [{ name: label, manaCost: '', typeLine, oracle: artifact || '', power: artifact ? undefined : String(p), toughness: artifact ? undefined : String(t), img: null, imgLarge: null }],
    };
  }
  return id;
}

export function attackersTotalPower() {
  const cb = G.s.combat;
  return cb ? cb.attackers.reduce((a, i) => a + Math.max(0, power(card(i))), 0) : 0;
}

export { def };
