// Game state, zones and the actions both players use.
import { DB } from './data.js';
import { isCreature, isLand, power, toughness, isDead, def, isType, hasKw, oracle, face, typeLine, hasSubtype } from './rules.js';
import { repl, playerFlag } from './statics.js';

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
    commanderZone: 'ask',
    dorks: 'last',
    aiSpeed: 650,
    pauseOnAiSpells: true,
    autoTreasure: true,
    autoUntap: true,
    autoDraw: true,
    arenaMode: true,
    aiStyle: 'casual',
    boardLayout: 'organized',
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
  G.undo.push(JSON.stringify({ s: G.s, nextId }));
  if (G.undo.length > 60) G.undo.shift();
  G.redo = [];
}
function restore(json) {
  const o = JSON.parse(json);
  if (o.s) {
    nextId = o.nextId || nextId;
    return o.s;
  }
  return o;
}
export function undo() {
  if (!G.undo.length) return false;
  G.redo.push(JSON.stringify({ s: G.s, nextId }));
  G.s = restore(G.undo.pop());
  emit();
  return true;
}
export function redo() {
  if (!G.redo.length) return false;
  G.undo.push(JSON.stringify({ s: G.s, nextId }));
  G.s = restore(G.redo.pop());
  emit();
  return true;
}
// put a snapshot back in place (same object), used when a spell is cancelled mid-way
export function restoreInPlace(json) {
  const snap = restore(json);
  for (const k of Object.keys(G.s)) delete G.s[k];
  Object.assign(G.s, snap);
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
  return {
    name, life: G.settings.startingLife, poison: 0, zones: z, cmdDmg: {}, tax: {}, mulligans: 0, lost: null,
    counters: { energy: 0, experience: 0, rad: 0, ticket: 0 }, speed: 0, ring: 0, ringBearer: null,
    dungeon: null, dungeonsCompleted: 0, cityBlessing: false,
  };
}

export function freshTurnStats() {
  const one = () => ({ loyaltyActivated: 0, spells: 0, noncreatureSpells: 0, lifeLost: 0, lifeGained: 0, damagedOpp: false, attacked: false, landsPlayed: 0, drawn: 0, cardsLeftGy: 0, permLeft: false, speedUp: false, discarded: [] });
  return { p: one(), ai: one(), creatureDied: false, warped: false };
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
    landsPlayed: 0,
    combat: null,
    log: [],
    phase: 'mulligan',
    winner: null,
    monarch: null,
    initiative: null,
    dayNight: null,
    extraTurns: { p: 0, ai: 0 },
    extraCombats: 0,
    ts: freshTurnStats(),
    delayed: [],
    pool: { p: [], ai: [] },
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
    for (const id of deck.companions || []) {
      const iid = makeCard(id, pid, 'command');
      s.cards[iid].isCompanion = true;
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
// Phased-out permanents are treated as though they don't exist.
export function cardsIn(pid, z) {
  const out = G.s.players[pid].zones[z].map((i) => G.s.cards[i]).filter(Boolean);
  return z === 'battlefield' ? out.filter((c) => !c.phasedOut) : out;
}
export function allOnField(pid) {
  return G.s.players[pid].zones.battlefield.map((i) => G.s.cards[i]).filter(Boolean);
}
export function opp(pid) {
  return pid === 'p' ? 'ai' : 'p';
}

export function cardName(inst) {
  if (!inst) return '?';
  if (inst.faceDown) return 'a face-down card';
  if (inst.nameOverride) return inst.nameOverride;
  const d = DB[inst.def];
  return (d.faces[inst.face || 0] || d.faces[0]).name;
}
export function nameTag(inst) {
  if (!inst) return '?';
  if (inst.faceDown) return '<i>a face-down card</i>';
  return `<span class="cn" data-def="${inst.def}" data-face="${inst.face || 0}">${esc(cardName(inst))}</span>`;
}
export function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Captain America, Living Legend: a creature you control that becomes tapped for the first time during your turn untaps
export function tappedHook(c) {
  if (!c || !G.s || c.zone !== 'battlefield' || !isCreature(c)) return;
  const first = c.firstTapTurn !== G.s.turn;
  c.firstTapTurn = G.s.turn;
  if (!first || G.s.active !== c.controller || !c.tapped) return;
  const cap = G.s.players[c.controller].zones.battlefield.map((i) => G.s.cards[i]).find((x) => x && !x.phasedOut && !x.lostAbilities && /Whenever a creature you control becomes tapped during your turn, if it's the first time that creature has become tapped this turn, untap it/i.test(oracle(x)));
  if (!cap) return;
  c.tapped = false;
  log(c.controller, `${nameTag(cap)}: ${nameTag(c)} untaps.`);
}
export function log(who, html) {
  G.s.log.push({ who, html, turn: G.s.turn });
  if (G.s.log.length > 500) G.s.log.shift();
}

// ------------------------------------------------------------ zone movement
const RESET = ['chosenCardType', 'hiddenExile', 'ianSrc', 'exiledFromHand', 'mayCastFromGy', 'mayCastFromGyTurn', 'lockeGroup', 'tapped', 'damage', 'deathtouched', 'auraBuffs', 'eot', 'eotGrants', 'pacifiedBy', 'attachedTo', 'attacking',
  'blocking', 'animated', 'crewedTurn', 'saddledTurn', 'stationCreature', 'regen', 'goaded', 'detainedUntil', 'monstrous',
  'renowned', 'classLevel', 'proto', 'setPT', 'modesUsed', 'chosenColor', 'lostAbilities', 'endOfTurn', 'exileIfLeaves', 'noUntapUntil', 'phasedOut', 'phasedUntil', 'phaseInTapped', 'exiledLinked', 'sector', 'chosenType', 'floated',
  'cantBlockTurn', 'unblockableTurn', 'suspected', 'mutated', 'usedAbilities', 'kicked', 'castMode', 'xPaid', 'impending',
  'ringBearer', 'addTypes', 'extraText', 'eotText', 'controlWhile', 'craftedFrom', 'becameTreasure', 'chosenMode', 'solved', 'unlocked', 'grants', 'ptMod', 'echoPaid', 'endOfCombat', 'bestowed',
  'morph', 'wardTwo', 'reconfigured', 'usedLoyaltyTurn', 'loyaltyUses', 'provokedBy', 'squadCount', 'offspringPaid', 'merged',
  'foretold', 'foretoldTurn', 'plotted', 'plottedTurn', 'onAdventure', 'mayPlay', 'mayPlayUntil', 'anyColorMana', 'mayPlayFreeUntil', 'castOnly', 'myTurnOnly', 'convokedBy', 'mayPlayFree', 'suspended',
  'rebound', 'encodedOn', 'hiddenBy', 'playWhileCtl', 'exiledWithSrc', 'warped', 'manifested', 'castFrom', 'castFace', 'aiSkip', 'ntTurn', 'noAttackUntil', 'noBlockUntil'];

/**
 * Move a card between zones (possibly across controllers' battlefields).
 * opts: {to:'top'|'bottom'|index, x, y, controller, tapped, faceDown, silent, cause}
 */
export function move(iid, zone, opts = {}) {
  const s = G.s;
  const c = s.cards[iid];
  if (!c) return;
  const fromZone = c.zone;
  const fromCtl = fromZone === 'battlefield' ? c.controller : c.owner;
  const requested = zone;
  // replacements: finality counters, "exile it if it would leave", Rest in Peace and friends
  if (fromZone === 'battlefield' && zone !== 'battlefield') {
    if ((c.counters || {}).finality && zone === 'graveyard') zone = 'exile';
    if (c.exileIfLeaves) zone = 'exile';
  }
  if (zone === 'graveyard' && repl('gyExile', c.owner)) zone = 'exile';
  // events for triggered abilities
  if (fromZone === 'battlefield' && zone !== 'battlefield') {
    s.ts[c.controller].permLeft = true;
    const attachedHere = Object.values(s.cards).filter((a) => a.attachedTo === iid && a.zone === 'battlefield');
    if (requested === 'graveyard' && isCreature(c)) {
      s.ts.creatureDied = true;
      queueEvent({
        type: 'dies', iid, def: c.def, face: c.face || 0, controller: c.controller, owner: c.owner, token: c.token,
        power: power(c), toughness: toughness(c), counters: { ...(c.counters || {}) }, isCommander: c.isCommander, merged: c.merged || [],
        wasBlitzed: c.castMode === 'blitz', attached: attachedHere.map((a) => a.iid), attachedCtl: Object.fromEntries(attachedHere.map((a) => [a.iid, a.controller])),
      });
    } else if (requested === 'graveyard') queueEvent({ type: 'putIntoGraveyard', iid, def: c.def, controller: c.controller, owner: c.owner, token: c.token, fromBattlefield: true });
    queueEvent({ type: 'leaves', iid, def: c.def, face: c.face || 0, controller: c.controller, owner: c.owner, token: c.token, to: zone, wasAttacking: !!c.attacking });
    if (requested === 'graveyard' && isCreature(c)) (s.ts[c.controller].diedTypes = s.ts[c.controller].diedTypes || []).push(typeLine(c));
  }
  if (fromZone === 'graveyard' && zone !== 'graveyard') s.ts[c.owner].cardsLeftGy++;
  if (zone === 'graveyard' && fromZone !== 'graveyard' && !c.token) queueEvent({ type: 'toGraveyard', iid, def: c.def, owner: c.owner, from: fromZone, controller: fromZone === 'battlefield' ? c.controller : c.owner });
  // "Its controller …" after it left (Path to Exile on a creature you'd stolen): remember who controlled it
  if (fromZone === 'battlefield' && zone !== 'battlefield') (s.lastCtl = s.lastCtl || {})[iid] = c.controller;
  // Gwen Stacy: "You may play that card for as long as you control this creature" ends when it leaves or changes control
  if (fromZone === 'battlefield' && (zone !== 'battlefield' || (opts.controller && opts.controller !== c.controller)))
    for (const x of Object.values(s.cards)) if (x.playWhileCtl === iid) {
      delete x.playWhileCtl;
      x.mayPlay = null;
    }
  // remove from old zone
  if (fromZone) {
    const arr = s.players[fromCtl].zones[fromZone];
    const k = arr.indexOf(iid);
    if (k >= 0) arr.splice(k, 1);
  }
  // commander replacement
  delete c.cmdAsk;
  if (c.isCommander && !opts.noCommandZone && fromZone !== zone && fromZone !== 'command') {
    const auto = c.owner === 'ai' || G.settings.commanderZone === 'auto';
    const gyEx = zone === 'graveyard' || zone === 'exile';
    if (auto && gyEx) zone = 'command';
    // the player decides: it goes there, and a prompt offers the command zone
    else if (!auto && (gyEx || ((zone === 'hand' || zone === 'library') && (fromZone === 'battlefield' || fromZone === 'stack')))) c.cmdAsk = zone;
  }
  // a mutated pile moves together
  if (c.merged && c.merged.length && fromZone === 'battlefield' && zone !== 'battlefield') {
    const under = c.merged;
    c.merged = [];
    for (const m of under) {
      const mc = s.cards[m];
      if (!mc) continue;
      mc.zone = null;
      if (mc.token && zone !== 'battlefield') delete s.cards[m];
      else move(m, zone === 'command' ? 'graveyard' : zone);
    }
  }
  // tokens cease to exist outside the battlefield
  if (c.token && zone !== 'battlefield') {
    delete s.cards[iid];
    if (combatRef()) dropFromCombat(iid);
    return null;
  }
  const leavingField = fromZone === 'battlefield' && zone !== 'battlefield';
  if (leavingField && c.origDef) endCopy(c);
  if (leavingField || (zone !== 'battlefield' && fromZone !== 'battlefield')) {
    for (const k of RESET) delete c[k];
    c.counters = {};
    c.grants = [];
    c.ptMod = null;
    c.damage = 0;
    c.tapped = false;
    if (zone !== 'exile') c.faceDown = false;
    c.face = 0;
    c.controller = c.owner;
    c.x = c.y = null;
    if (combatRef()) dropFromCombat(iid);
  }
  if (zone === 'battlefield' && fromZone !== 'battlefield') {
    c.sick = true;
    c.enteredTurn = s.turn;
    // Rooms: the door that was cast enters unlocked ("When you unlock this door" triggers); put onto the battlefield otherwise, both stay locked
    if (/Room/.test(DB[c.def].typeLine || '') && DB[c.def].faces.length === 2 && /Room/.test(DB[c.def].faces[1].typeLine || '')) {
      const k = fromZone === 'stack' || c.castFace !== undefined ? c.castFace || 0 : -1;
      c.unlocked = [k === 0, k === 1];
      c.face = 0;
      if (k >= 0) queueEvent({ type: 'unlock', iid, door: k, controller: opts.controller || c.controller });
    }
    if (fromZone !== 'stack') c.castMode = c.castMode || null;
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
    if (zone === 'library') arr.unshift(iid);
    else arr.push(iid);
  } else if (typeof opts.to === 'number') arr.splice(opts.to, 0, iid);
  else arr.push(iid);
  if (zone === 'battlefield' && fromZone !== 'battlefield') entering(c, opts);
  // theft (Jhoira, Control Magic, Treachery…): remember it so the player gets a popup naming the card
  if (zone === 'battlefield' && s.phase === 'play' && !c.token && c.controller !== c.owner && (fromZone !== 'battlefield' || fromCtl !== c.controller)) {
    s.stealNotes = [...(s.stealNotes || []), { iid, by: c.controller, from: c.owner, fromZone }];
  }
  return c;
}

// ------------------------------------------------------------ lands that enter tapped (sometimes)
const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const COLORW = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
function permMatches(x, phrase) {
  phrase = phrase.toLowerCase().trim().replace(/^(?:a|an|another) /, '');
  const tl = typeLine(x).toLowerCase();
  if (/^basic lands?$/.test(phrase)) return /\bbasic\b/.test(tl) && isLand(x);
  if (/^lands?$/.test(phrase)) return isLand(x);
  if (/^legendary creatures?$/.test(phrase)) return /legendary/.test(tl) && isCreature(x);
  const cols = phrase.match(/^((?:white|blue|black|red|green)(?:,? (?:or )?(?:white|blue|black|red|green))*) permanents?$/);
  if (cols) {
    const want = cols[1].split(/,? or |, /).map((w) => COLORW[w.trim()]);
    return want.some((w) => (DB[x.def].colors || []).includes(w));
  }
  // "Forest or an Island", "Mount or Vehicle", "planeswalker", "Equipment", "Swamps"
  return phrase.split(/,? or (?:a |an )?|, (?:a |an )?/).some((w) => {
    w = w.trim().replace(/s$/, '');
    return w && new RegExp('\\b' + w + 's?\\b', 'i').test(tl);
  });
}
// true = tapped, false = untapped, {ask, life} = you may pay life (the player decides)
export function entersTapped(c, o = oracle(c).replace(/\([^)]*\)/g, '')) {
  const s = G.s;
  const pid = c.controller;
  const line = (o.match(/[^\n]*enters?(?: the battlefield)? tapped[^\n]*/i) || [])[0];
  if (!line) return false;
  const others = cardsIn(pid, 'battlefield').filter((x) => x.iid !== c.iid);
  let m;
  if ((m = line.match(/you may pay (\d+) life\. If you don't, (?:it|~|this land|[^,.]+) enters tapped/i))) return { ask: true, life: +m[1] };
  // Theorist's Sanctum: "As this land enters, you may behold a Jace. If you don't, this land enters tapped."
  if ((m = o.match(/you may behold an? ([A-Z][\w-]+|[a-z]+)\. If you don't, (?:it|~|this land|[^,.]+) enters tapped/i))) {
    const k = m[1];
    const fits = (x) => hasSubtype({ ...x, zone: 'battlefield' }, k) || new RegExp('\\b' + k + '\\b', 'i').test(typeLine({ ...x, zone: 'battlefield' }));
    const seen = others.find(fits) || cardsIn(pid, 'hand').find(fits);
    if (seen) {
      log(pid, `${pid === 'p' ? 'You behold' : 'The AI beholds'} ${nameTag(seen)}, so ${nameTag(c)} enters untapped.`);
      return false;
    }
    return true;
  }
  if (/you may reveal (?:a|an) ([^.]+?) card from your hand/i.test(line)) {
    const kinds = line.match(/you may reveal (?:a|an) ([^.]+?) card from your hand/i)[1];
    const inHand = cardsIn(pid, 'hand').some((x) => permMatches({ ...x, zone: 'battlefield' }, kinds) || kinds.split(/ or (?:a |an )?/).some((k) => new RegExp('\\b' + k.trim() + '\\b', 'i').test(typeLine(x))));
    const control = /or you control (?:a|an) ([A-Za-z]+)/i.test(line) && others.some((x) => permMatches(x, line.match(/or you control (?:a|an) ([A-Za-z]+)/i)[1]));
    if (inHand) log(pid, `${pid === 'p' ? 'You reveal' : 'The AI reveals'} a ${esc(kinds)} card so ${nameTag(c)} enters untapped.`);
    return !(inHand || control);
  }
  if ((m = line.match(/you may behold (?:a|an) ([A-Za-z]+)/i))) return !(others.some((x) => permMatches(x, m[1])) || cardsIn(pid, 'hand').some((x) => new RegExp('\\b' + m[1] + '\\b', 'i').test(typeLine(x))));
  if ((m = line.match(/unless you control (\w+) or (fewer|more) other ([a-z ]+?)s?\.?$/i))) {
    const k = NUMW[m[1].toLowerCase()] || +m[1];
    const n = others.filter((x) => permMatches(x, m[3])).length;
    return m[2].toLowerCase() === 'fewer' ? n > k : n < k;
  }
  if ((m = line.match(/unless you control (\w+) or more ([a-z ]+?)s?\.?$/i))) {
    const k = NUMW[m[1].toLowerCase()] || +m[1];
    return others.filter((x) => permMatches(x, m[2])).length < k;
  }
  if ((m = line.match(/unless you control (?:a|an) ([^.]+?)\.?$/i))) return !others.some((x) => permMatches(x, m[1]));
  if (/unless you have two or more opponents/i.test(line)) return true; // one opponent here
  if ((m = line.match(/unless a player has (\d+) or less life/i))) return !Object.values(s.players).some((pl) => pl.life <= +m[1]);
  if ((m = line.match(/unless your opponents control (\w+) or more lands/i))) return cardsIn(opp(pid), 'battlefield').filter(isLand).length < (NUMW[m[1]] || +m[1]);
  if (/unless it's your turn/i.test(line)) return s.active !== pid;
  if (/if it's not your turn/i.test(line)) return s.active !== pid;
  if (/unless it's your first, second, or third turn of the game/i.test(line)) return Math.ceil(s.turn / 2) > 3;
  if (/During your first three turns of the game, [^.]* enters tapped if you were the starting player/i.test(line)) return s.first === pid && Math.ceil(s.turn / 2) <= 3;
  if (/if it was played from your hand/i.test(line)) return true;
  if (/unless|if /i.test(line)) return false; // a condition we don't know: let the player tap it by hand
  return true;
}

// Things that happen as a permanent enters: counters it enters with, enters-tapped effects, events.
function entering(c, opts) {
  const s = G.s;
  if (c.faceDown) {
    queueEvent({ type: 'enters', iid: c.iid, controller: c.controller, creature: true, token: c.token });
    return;
  }
  const o = oracle(c).replace(/\([^)]*\)/g, '');
  const f = face(c);
  if (isType(c, 'Planeswalker') && c.counters.loyalty === undefined) c.counters.loyalty = parseInt(f.loyalty, 10) || 0;
  if (isType(c, 'Battle') && c.counters.defense === undefined) c.counters.defense = parseInt(f.defense, 10) || 0;
  let m;
  // "enters with N +1/+1 counters", "enters with X …", modular, graft, fading, vanishing, sunburst-ish
  for (const mm of o.matchAll(/enters(?: the battlefield)? with (a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+) ([+-]\d+\/[+-]\d+|[a-z]+) counters? on it/gi)) {
    const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const nW = mm[1].toLowerCase();
    const k = nW === 'x' ? c.xPaid || 0 : words[nW] || parseInt(nW, 10) || 0;
    if (k) addCounters(c, mm[2].toLowerCase(), k, { silent: true });
  }
  // Oath of Gideon: "Each planeswalker you control enters with an additional loyalty counter on it."
  if (isType(c, 'Planeswalker'))
    for (const iid of s.players[c.controller].zones.battlefield) {
      const src = s.cards[iid];
      if (src && src.iid !== c.iid && !src.phasedOut && /Each planeswalker you control enters with an additional loyalty counter/i.test(oracle(src))) c.counters.loyalty = (c.counters.loyalty || 0) + 1;
    }
  // Dragonstorm Globe, Grumgully, Metallic Mimic: "Each [other] <kind> you control enters with an additional +1/+1 counter on it"
  for (const iid of s.players[c.controller].zones.battlefield) {
    const src = s.cards[iid];
    if (!src || src.phasedOut || src.faceDown) continue;
    const so = oracle(src).replace(/\([^)]*\)/g, '');
    for (const mm of so.matchAll(/(?:^|\n)(?:Each |Other )?(other )?((?:[\w-]+ ){0,3}?)(?:creatures?|permanents?|([A-Z][\w-]+)s?) you control (?:enters?|enter) (?:the battlefield )?with (an|one|two|three|\d+) additional ([+-]\d+\/[+-]\d+|[a-z]+) counters? on (?:it|them)(?: for each ([A-Z][\w-]+|creature|other creature) you (?:already )?control)?/g)) {
      if (mm[1] && src.iid === c.iid) continue;
      if (src.iid === c.iid && !/^Each /.test(mm[0].trim())) continue;
      const words = (mm[2] || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      const sub = mm[3];
      const isPerm = /permanents? you control/.test(mm[0]);
      if (!isPerm && !sub && !isCreature(c)) continue;
      if (sub && !hasSubtype(c, sub)) continue;
      let ok = true;
      for (const w of words) {
        if (w === 'other') continue;
        if (/^non-?/.test(w)) { const t = w.replace(/^non-?/, ''); if (hasSubtype(c, t) || isType(c, t[0].toUpperCase() + t.slice(1))) ok = false; }
        else if (w === 'nontoken') { if (c.token) ok = false; }
        else if (w === 'token') { if (!c.token) ok = false; }
        else if (!hasSubtype(c, w) && !isType(c, w[0].toUpperCase() + w.slice(1))) ok = false;
      }
      if (!ok) continue;
      let k = { an: 1, one: 1, two: 2, three: 3 }[mm[4].toLowerCase()] || parseInt(mm[4], 10) || 1;
      // Giada: "… for each Angel you already control" (not counting the one entering)
      if (mm[6]) {
        const kind = mm[6];
        const already = s.players[c.controller].zones.battlefield.map((i) => s.cards[i]).filter((x) => x && x.iid !== c.iid && !x.phasedOut && (/creature/.test(kind) ? isCreature(x) : hasSubtype(x, kind))).length;
        k *= already;
      }
      if (!k) continue;
      addCounters(c, mm[5].toLowerCase(), k, { silent: true });
    }
  }
  if ((m = o.match(/\bModular (\d+)/))) addCounters(c, '+1/+1', +m[1], { silent: true });
  if ((m = o.match(/\bGraft (\d+)/))) addCounters(c, '+1/+1', +m[1], { silent: true });
  if ((m = o.match(/\bFading (\d+)/))) addCounters(c, 'fade', +m[1], { silent: true });
  if ((m = o.match(/\bVanishing (\d+)/))) addCounters(c, 'time', +m[1], { silent: true });
  if (/\bSunburst\b/.test(o) && c.colorsSpent) addCounters(c, isCreature(c) ? '+1/+1' : 'charge', c.colorsSpent, { silent: true });
  if (c.xPaid && /\bRavenous\b/.test(o)) addCounters(c, '+1/+1', c.xPaid, { silent: true });
  if (/^\(?As this Saga enters/m.test(o) || hasSubtype(c, 'Saga')) {
    if (c.counters.lore === undefined) c.counters.lore = 0;
  }
  // Horizon Explorer: "Lands you control enter untapped."
  const forceUntap = isLand(c) && G.s.players[c.controller].zones.battlefield.some((i) => i !== c.iid && G.s.cards[i] && !G.s.cards[i].phasedOut && /(?:^|\n)Lands you control enter (?:the battlefield )?untapped/i.test(oracle(G.s.cards[i])));
  const et = forceUntap ? false : entersTapped(c, o);
  if (forceUntap) c.tapped = false;
  if (et === true) c.tapped = true;
  else if (et && et.ask) {
    // "you may pay 2 life": it enters tapped; the controller is asked right away and it untaps if they pay
    c.tapped = true;
    queueEvent({ type: 'payToUntap', iid: c.iid, controller: c.controller, life: et.life });
  }
  if (isCreature(c) && repl('oppEnterTapped', c.controller)) c.tapped = true;
  if (repl('oppPermsTapped', c.controller)) c.tapped = true;
  if (/^Living weapon|\bLiving weapon\b/m.test(o) || /\bFor Mirrodin!/m.test(o) || /\bJob select\b/i.test(o)) queueEvent({ type: 'germ', iid: c.iid, controller: c.controller });
  queueEvent({ type: 'enters', iid: c.iid, controller: c.controller, creature: isCreature(c), token: c.token, land: isLand(c), def: c.def });
  if (isLand(c)) queueEvent({ type: 'landfall', iid: c.iid, controller: c.controller });
  void opts;
  void s;
}

// Counters, with Hardened Scales / Doubling Season style replacements for the controller.
export function addCounters(c, kind, n, opts = {}) {
  if (!c || n === 0) return 0;
  c.counters = c.counters || {};
  if (n > 0 && c.zone === 'battlefield' && kind !== 'loyalty-cost') {
    if (kind === '+1/+1') n += repl('counterPlusOne', c.controller);
    const dbl = repl('counterDouble', c.controller);
    for (let k = 0; k < dbl; k++) n *= 2;
  }
  // +1/+1 and -1/-1 counters annihilate each other
  c.counters[kind] = Math.max(0, (c.counters[kind] || 0) + n);
  if (kind === '+1/+1' || kind === '-1/-1') {
    const a = c.counters['+1/+1'] || 0;
    const b = c.counters['-1/-1'] || 0;
    const k = Math.min(a, b);
    if (k) {
      c.counters['+1/+1'] = a - k;
      c.counters['-1/-1'] = b - k;
    }
  }
  for (const key of Object.keys(c.counters)) if (!c.counters[key] && key !== 'loyalty' && key !== 'lore' && key !== 'defense') delete c.counters[key];
  const by = opts.by || G.curActor || null;
  if (n > 0 && by && G.s.ts && G.s.ts[by] && c.zone === 'battlefield' && isCreature(c)) G.s.ts[by].counterOnCreature = true;
  if (n > 0 && !opts.silent) queueEvent({ type: 'counterPut', iid: c.iid, kind, n, controller: c.controller, by });
  return n;
}

function combatRef() {
  return G.s.combat;
}
function dropFromCombat(iid) {
  const cb = G.s.combat;
  cb.attackers = cb.attackers.filter((a) => a !== iid);
  delete cb.blocks[iid];
  if (cb.targets) delete cb.targets[iid];
  for (const k of Object.keys(cb.blocks)) {
    if (!cb.blocks[k].includes(iid)) continue;
    cb.blocks[k] = cb.blocks[k].filter((b) => b !== iid);
    // a blocked creature stays blocked even if its blockers leave combat (it deals no damage unless it has trample)
    if (!cb.blocks[k].length) cb.wasBlocked = { ...(cb.wasBlocked || {}), [k]: true };
  }
}
// Is this attacker blocked? (true even after all its blockers have left the battlefield)
export function isBlocked(aid) {
  const cb = G.s && G.s.combat;
  return !!(cb && (((cb.blocks || {})[aid] || []).length || (cb.wasBlocked || {})[aid]));
}

export function libTop(pid, n = 1) {
  const lib = zoneOf(pid, 'library');
  return lib.slice(Math.max(0, lib.length - n)).reverse();
}

export function draw(pid, n = 1, silent = false) {
  const lib = zoneOf(pid, 'library');
  let drawn = 0;
  for (let k = 0; k < n; k++) {
    // dredge: you chose to dredge a card instead of this draw
    const pl = G.s.players[pid];
    if (pl.dredge && card(pl.dredge.iid) && card(pl.dredge.iid).zone === 'graveyard' && lib.length >= pl.dredge.n) {
      const d = pl.dredge;
      pl.dredge = null;
      mill(pid, d.n);
      move(d.iid, 'hand');
      log(pid, `${pid === 'p' ? 'You dredge' : 'The AI dredges'} ${nameTag(card(d.iid))} instead of drawing.`);
      continue;
    }
    if (!lib.length) {
      if (G.s.phase === 'play') {
        log(pid, `${pid === 'p' ? 'You try' : 'The AI tries'} to draw from an empty library.`);
        loseGame(pid, 'drew from an empty library');
      }
      break;
    }
    const iid = lib[lib.length - 1];
    move(iid, 'hand');
    drawn++;
    const ts = G.s.ts[pid];
    ts.drawn++;
    if (G.s.phase === 'play') queueEvent({ type: 'draw', pid, iid, nth: ts.drawn });
  }
  if (!silent && drawn) log(pid, `${pid === 'p' ? 'You draw' : 'AI draws'} ${drawn} card${drawn > 1 ? 's' : ''}.`);
  return drawn;
}

export function shuffle(pid) {
  shuffleArr(zoneOf(pid, 'library'));
}

export function mill(pid, n) {
  const ids = libTop(pid, n);
  ids.forEach((i) => move(i, 'graveyard'));
  if (ids.length) log(pid, `${pid === 'p' ? 'You mill' : 'AI mills'} ${ids.map((i) => nameTag(card(i))).join(', ')}.`);
  if (ids.length) queueEvent({ type: 'mill', pid, ids });
  return ids;
}

// Discard: madness cards go to exile and may be cast; everything else to the graveyard.
export function discard(iid) {
  const c = card(iid);
  if (!c) return;
  const pid = c.owner;
  G.s.ts[pid].discarded.push(iid);
  if (/\bMadness\b/.test(oracle(c))) {
    move(iid, 'exile');
    c.madness = true;
    queueEvent({ type: 'madness', iid, pid });
  } else move(iid, 'graveyard');
  queueEvent({ type: 'discard', iid, pid });
}

export function setLife(pid, value, reason) {
  const pl = G.s.players[pid];
  const before = pl.life;
  if (value > before && playerFlag(pid, 'noLifeGain')) value = before;
  if (pl.lifeLocked && G.s.turn < pl.lifeLocked) value = before; // Teferi's Protection
  pl.life = value;
  const ts = G.s.ts && G.s.ts[pid];
  if (ts) {
    if (value < before) {
      ts.lifeLost += before - value;
      G.s.ts[opp(pid)].damagedOpp = true;
      queueEvent({ type: 'lifeLost', pid, amount: before - value });
      // Start your engines!: speed goes up once on your turn when an opponent loses life
      const o = opp(pid);
      const po = G.s.players[o];
      if (G.s.active === o && po.speed > 0 && po.speed < 4 && !G.s.ts[o].speedUp) {
        po.speed++;
        G.s.ts[o].speedUp = true;
        log(o, `${o === 'p' ? 'Your' : "The AI's"} speed increases to ${po.speed}${po.speed === 4 ? ' (max speed)' : ''}.`);
      }
    } else if (value > before) {
      ts.lifeGained += value - before;
      queueEvent({ type: 'lifeGained', pid, amount: value - before });
    }
  }
  if (reason !== false && value !== before)
    log(pid, `${pid === 'p' ? 'Your' : 'AI'} life ${before} → <b>${value}</b>${reason ? ' (' + reason + ')' : ''}.`);
  checkLoss(pid);
}
// Casual AI: plays like a friendly pod (fewer all-in swings, saves removal and counters for real threats)
export const casualAI = () => (G.settings.aiStyle || 'casual') !== 'competitive';

// While drawing the screen nothing changes, so rules text and static effects can be computed once per card.
export const readCache = { on: false, oracle: new WeakMap(), mods: new WeakMap(), field: null, anthems: null };
// the real card behind a temporary copy ({...card, tapped: false}) when the copy reads the same rules text
export function cacheTwin(inst) {
  const o = G.s && G.s.cards[inst.iid];
  if (!o) return null;
  if (o === inst) return o;
  if (o.face === inst.face && o.faceDown === inst.faceDown && o.zone === inst.zone && o.controller === inst.controller && o.counters === inst.counters
    && o.extraText === inst.extraText && o.unlocked === inst.unlocked && o.chosenType === inst.chosenType && o.chosenMode === inst.chosenMode && o.def === inst.def && o.lostAbilities === inst.lostAbilities) return o;
  return null;
}
export function withReadCache(fn) {
  if (readCache.on) return fn();
  readCache.on = true;
  readCache.oracle = new WeakMap();
  readCache.mods = new WeakMap();
  readCache.field = null;
  readCache.anthems = null;
  readCache.statics = null;
  readCache.threat = null;
  readCache.kw = null;
  try {
    return fn();
  } finally {
    readCache.on = false;
    readCache.field = null;
    readCache.anthems = null;
  }
}

// Mindslaver / Emrakul: you control the AI during this turn
export function aiSlaved() {
  const s = G.s;
  return !!(s && s.slaved && s.slaved.of === 'ai' && s.slaved.turn === s.turn);
}
// Sen Triplets: `by` may play lands and cast spells from `of`'s hand this turn
export function handControl(by, of) {
  const s = G.s;
  const h = s && s.handControl;
  return !!(h && h.turn === s.turn && h.by === by && (!of || h.of === of));
}

export function changeLife(pid, delta, reason) {
  setLife(pid, G.s.players[pid].life + delta, reason);
}

export function checkLoss(pid) {
  const pl = G.s.players[pid];
  if (pl.lost) return;
  if (pl.life <= 0 && !hasLoseImmunity(pid)) loseGame(pid, 'life total reached 0');
  else if (pl.poison >= 10) loseGame(pid, '10 poison counters');
  else if (Object.values(pl.cmdDmg).some((v) => v >= 21)) loseGame(pid, '21 commander damage');
}
function hasLoseImmunity(pid) {
  return cardsIn(pid, 'battlefield').some((c) => /You can't lose the game/i.test(oracle(c)));
}

export function loseGame(pid, why) {
  const pl = G.s.players[pid];
  if (pl.lost || G.s.winner) return;
  pl.lost = why;
  G.s.winner = opp(pid);
  log('sys', `<b>${pid === 'p' ? 'You lose' : 'The AI loses'}</b> — ${why}.`);
}
export function winGame(pid, why) {
  loseGame(opp(pid), why);
}

// Untap step: stun counters and "doesn't untap" effects
export function untapAll(pid) {
  for (const c of cardsIn(pid, 'battlefield')) {
    c.sick = false;
    if (!c.tapped) continue;
    if ((c.counters || {}).stun) {
      c.counters.stun--;
      if (!c.counters.stun) delete c.counters.stun;
      continue;
    }
    if (c.noUntapUntil && c.noUntapUntil > G.s.turn) continue;
    if (/doesn't untap during (?:your|its controller's) untap step/i.test(oracle(c)) && !/if/i.test(oracle(c).match(/[^.\n]*doesn't untap during[^.\n]*/i)[0])) continue;
    if (c.pacifiedBy && /doesn't untap/i.test(oracle(card(c.pacifiedBy) || c))) continue;
    c.tapped = false;
  }
}

// "becomes a copy of it until end of turn": put the original card back
export function endCopy(c) {
  if (!c.origDef) return;
  c.def = c.origDef;
  c.face = c.origFace || 0;
  delete c.origDef;
  delete c.origFace;
  delete c.copyUntil;
  delete c.nameOverride;
  delete c.addTypes;
}
export function cleanupDamage() {
  const s = G.s;
  for (const c of Object.values(s.cards)) {
    c.damage = 0;
    c.deathtouched = false;
    c.attacking = false;
    c.blocking = false;
    if (c.copyUntil === 'eot') endCopy(c);
    if (c.ntTurn && c.ntTurn > s.turn) continue; // "until your next turn" effects last through the opponent's turn
    delete c.ntTurn;
    c.eot = null;
    c.eotGrants = null;
    if (c.animated && c.animated.until === 'eot') delete c.animated;
    if (c.lostAbilities === 'eot') delete c.lostAbilities;
    delete c.eotText;
    if (c.setPTUntil === 'eot') {
      delete c.setPT;
      delete c.setPTUntil;
    }
  }
}

// ------------------------------------------------------------ destroy / sacrifice
// Destroy respects indestructible, regeneration shields, shield counters and umbra armor.
export function destroy(iid, opts = {}) {
  const c = card(iid);
  if (!c || c.zone !== 'battlefield') return false;
  if (hasKw(c, 'indestructible') && !opts.ignoreIndestructible) return false;
  if ((c.counters || {}).shield) {
    c.counters.shield--;
    if (!c.counters.shield) delete c.counters.shield;
    log(c.controller, `${nameTag(c)} loses a shield counter instead of being destroyed.`);
    return false;
  }
  if (c.regen > 0 && !opts.noRegen) {
    c.regen--;
    c.tapped = true;
    c.damage = 0;
    c.deathtouched = false;
    if (G.s.combat) dropFromCombat(iid);
    log(c.controller, `${nameTag(c)} regenerates.`);
    return false;
  }
  const umbra = Object.values(G.s.cards).find((a) => a.zone === 'battlefield' && a.attachedTo === iid && /\b(?:Umbra|Totem) armor\b/i.test(oracle(a)));
  if (umbra) {
    c.damage = 0;
    c.deathtouched = false;
    log(c.controller, `${nameTag(umbra)} is destroyed instead of ${nameTag(c)}.`);
    move(umbra.iid, 'graveyard');
    return false;
  }
  move(iid, 'graveyard');
  return true;
}

export function sacrifice(iid) {
  const c = card(iid);
  if (!c || c.zone !== 'battlefield') return false;
  queueEvent({ type: 'sacrificed', iid, def: c.def, controller: c.controller, token: c.token, types: typeLine(c) });
  move(iid, 'graveyard');
  return true;
}

// State-based actions
export function stateBased() {
  const s = G.s;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    // "gain control of target creature for as long as ~ remains on the battlefield" (The Akroan War, Old Man of the Sea…)
    for (const c of Object.values(s.cards)) {
      if (c.zone !== 'battlefield' || !c.controlWhile) continue;
      const src = s.cards[c.controlWhile.src];
      const gone = !src || src.zone !== 'battlefield' || (c.controlWhile.youControl && src.controller !== c.controlWhile.by);
      if (gone) {
        const back = c.controlWhile.prev;
        delete c.controlWhile;
        if (back && back !== c.controller) {
          move(c.iid, 'battlefield', { controller: back });
          c.zone = 'battlefield';
          log(back, `${nameTag(c)} returns to ${back === 'p' ? 'your' : "the AI's"} control.`);
          changed = true;
        }
      }
    }
    // auras fall off when what they enchant leaves; equipment just unattaches
    for (const a of Object.values(s.cards)) {
      if (a.zone === 'battlefield' && a.attachedTo && (!s.cards[a.attachedTo] || s.cards[a.attachedTo].zone !== 'battlefield' || s.cards[a.attachedTo].phasedOut)) {
        if (s.cards[a.attachedTo] && s.cards[a.attachedTo].phasedOut) continue;
        a.attachedTo = null;
        if (/\bAura\b/.test(typeLine(a))) {
          log(a.controller, `${nameTag(a)} goes to the graveyard (nothing to enchant).`);
          move(a.iid, 'graveyard');
          changed = true;
        }
      }
    }
    for (const c of Object.values(s.cards)) {
      if (c.zone !== 'battlefield') continue;
      if (c.pacifiedBy && (!s.cards[c.pacifiedBy] || s.cards[c.pacifiedBy].zone !== 'battlefield')) c.pacifiedBy = null;
      if (c.auraBuffs)
        for (const k of Object.keys(c.auraBuffs))
          if (!s.cards[k] || s.cards[k].zone !== 'battlefield' || s.cards[k].attachedTo !== c.iid) delete c.auraBuffs[k];
    }
    legendRule();
    const died = [];
    for (const pid of ['p', 'ai']) {
      for (const c of cardsIn(pid, 'battlefield')) {
        if (isCreature(c) && toughness(c) <= 0) died.push({ c, zero: true });
        else if (isCreature(c) && isDead(c)) died.push({ c });
        else if (isType(c, 'Planeswalker') && !isCreature(c) && (c.counters.loyalty || 0) <= 0 && c.enteredTurn !== undefined
          && !s.players[c.controller].zones.battlefield.some((i) => s.cards[i] && !s.cards[i].phasedOut && /Planeswalkers you control aren't put into their owners' graveyards for having 0 loyalty/i.test(oracle(s.cards[i])))) died.push({ c, zero: true, pw: true });
        else if (isType(c, 'Battle') && (c.counters.defense || 0) <= 0 && c.counters.defense !== undefined) died.push({ c, battle: true });
      }
    }
    for (const { c, zero, pw, battle } of died) {
      if (!card(c.iid) || c.zone !== 'battlefield') continue;
      const name = nameTag(c);
      if (battle) {
        queueEvent({ type: 'battleDefeated', iid: c.iid, controller: c.controller, def: c.def });
        log(c.controller, `${name} is defeated.`);
        move(c.iid, 'exile');
        changed = true;
        continue;
      }
      if (zero) {
        move(c.iid, 'graveyard');
        log(c.controller, `${name} ${pw ? 'runs out of loyalty' : 'dies'}.`);
        changed = true;
      } else if (destroy(c.iid)) {
        log(c.controller, `${name} dies${c.isCommander ? ' (to the command zone)' : ''}.`);
        changed = true;
      }
    }
    // the city's blessing
    for (const pid of ['p', 'ai']) {
      const pl = s.players[pid];
      if (!pl.cityBlessing && cardsIn(pid, 'battlefield').length >= 10 && cardsIn(pid, 'battlefield').some((c) => /\bAscend\b/.test(oracle(c)))) {
        pl.cityBlessing = true;
        log(pid, `${pid === 'p' ? 'You get' : 'The AI gets'} the city's blessing.`);
      }
    }
    for (const pid of ['p', 'ai']) checkLoss(pid);
    if (!changed) break;
  }
}

// ------------------------------------------------------------ legend rule
export function isLegendary(c) {
  if (c.notLegendary || c.faceDown) return false;
  return /\bLegendary\b/.test(typeLine(c).split('—')[0]);
}
const oracleOf = (c) => oracle(c);

export function legendViolations() {
  const out = [];
  const field = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')];
  if (field.some((c) => !c.faceDown && /The "legend rule" doesn't apply\.|The “legend rule” doesn’t apply\./i.test(oracleOf(c)))) return out;
  for (const pid of ['p', 'ai']) {
    if (cardsIn(pid, 'battlefield').some((c) => !c.faceDown && /legend rule["”] doesn['’]t apply to permanents you control/i.test(oracleOf(c)))) continue;
    const groups = {};
    for (const c of cardsIn(pid, 'battlefield')) {
      if (!isLegendary(c)) continue;
      const nm = cardName(c);
      (groups[nm] = groups[nm] || []).push(c);
    }
    for (const [nm, cs] of Object.entries(groups)) {
      if (cs.length < 2) continue;
      if (cs.length === 2 && cs.some((c) => /exactly two permanents named[^.]*legend rule["”] doesn['’]t apply/i.test(oracleOf(c)))) continue;
      out.push({ controller: pid, name: nm, ids: cs.map((c) => c.iid) });
    }
  }
  return out;
}

const legendAsked = new Set();
function legendRule() {
  for (const v of legendViolations()) {
    if (v.controller === 'ai') {
      const cs = v.ids.map((i) => G.s.cards[i]);
      const score = (c) => Object.values(c.counters || {}).reduce((a, b) => a + b, 0) * 2 +
        Object.values(G.s.cards).filter((o) => o.attachedTo === c.iid).length * 3 + v.ids.indexOf(c.iid) * 0.1;
      cs.sort((a, b) => score(b) - score(a));
      for (const c of cs.slice(1)) {
        log('ai', `Legend rule: the AI keeps one ${nameTag(c)} and puts the other into the graveyard.`);
        move(c.iid, 'graveyard');
      }
    } else {
      const key = v.ids.slice().sort().join(',');
      if (legendAsked.has(key)) continue;
      legendAsked.add(key);
      if (G.settings.arenaMode) queueEvent({ type: 'legendRule', controller: 'p', ids: v.ids, name: v.name });
      else log('p', `Legend rule: you control ${v.ids.length} copies of ${esc(v.name)} — keep one and put the rest into the graveyard.`);
    }
  }
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
  const land = c && isLand(c) && !isCreature(c);
  const taken = allOnField('p').filter((o) => o.iid !== c.iid && o.x !== null);
  const W = (typeof window !== 'undefined' && window.__fieldWidth) || 900;
  const H = (typeof window !== 'undefined' && window.__fieldHeight) || 360;
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

// Tokens, doubled by Parallel Lives / Doubling Season style effects.
// Treasure, Clue, Food… made by different cards are the same token: use one definition for each,
// so they stack together and count the same (keeping the real token art when we have it).
const tokenCanon = {};
function canonicalToken(defId) {
  const d = DB[defId];
  if (!d) return defId;
  const name = d.name;
  if (!ARTIFACT_TOKENS[name] || !/Token/i.test(d.typeLine || '') || /Creature/.test(d.typeLine || '')) return defId;
  const cur = tokenCanon[name] && DB[tokenCanon[name]] ? tokenCanon[name] : null;
  const hasImg = (x) => !!(DB[x] && DB[x].faces[0] && DB[x].faces[0].img);
  if (!cur || (!hasImg(cur) && hasImg(defId))) {
    tokenCanon[name] = defId;
    // tokens already out switch to the one with art, so they all stack
    if (cur && G.s) for (const c of Object.values(G.s.cards)) if (c.token && c.def === cur) c.def = defId;
  }
  return tokenCanon[name];
}

export function createToken(defId, pid, n = 1, opts = {}) {
  defId = canonicalToken(defId);
  const made = [];
  let count = n;
  if (!opts.noDouble) for (let k = 0; k < repl('tokenDouble', pid); k++) count *= 2;
  for (let k = 0; k < count; k++) {
    const iid = makeCard(defId, pid, null, { token: true, ...(opts.extra || {}) });
    toBattlefield(iid, pid, { tapped: opts.tapped });
    made.push(iid);
  }
  if (made.length) queueEvent({ type: 'tokensCreated', pid, ids: made });
  return made;
}

// Generic tokens used when the real token isn't known.
const ARTIFACT_TOKENS = {
  Treasure: ['Artifact', '{T}, Sacrifice this artifact: Add one mana of any color.'],
  Clue: ['Artifact', '{2}, Sacrifice this artifact: Draw a card.'],
  Food: ['Artifact', '{2}, {T}, Sacrifice this artifact: You gain 3 life.'],
  Blood: ['Artifact', '{1}, {T}, Discard a card, Sacrifice this artifact: Draw a card.'],
  Map: ['Artifact', '{1}, {T}, Sacrifice this artifact: Target creature you control explores. Activate only as a sorcery.'],
  Powerstone: ['Artifact', "{T}: Add {C}. This mana can't be spent to cast a nonartifact spell."],
  Gold: ['Artifact', 'Sacrifice this artifact: Add one mana of any color.'],
  Junk: ['Artifact', '{T}, Sacrifice this artifact: Exile the top card of your library. You may play that card this turn. Activate only as a sorcery.'],
  Shard: ['Enchantment', '{2}, Sacrifice this enchantment: Scry 1, then draw a card.'],
  Lander: ['Artifact', '{2}, {T}, Sacrifice this artifact: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.'],
  Mutagen: ['Artifact', '{1}, {T}, Sacrifice this artifact: Put a +1/+1 counter on target creature. Activate only as a sorcery.'],
};
const ROLE_TOKENS = {
  Monster: 'Enchant creature\nEnchanted creature gets +1/+1 and has trample.',
  Royal: 'Enchant creature\nEnchanted creature gets +1/+1 and has ward {1}.',
  Sorcerer: 'Enchant creature\nEnchanted creature gets +1/+1 and has "Whenever this creature attacks, scry 1."',
  Virtuous: 'Enchant creature\nEnchanted creature gets +1/+1 for each enchantment you control.',
  Wicked: 'Enchant creature\nEnchanted creature gets +1/+1.\nWhen this Aura is put into a graveyard from the battlefield, each opponent loses 1 life.',
  'Young Hero': 'Enchant creature\nEnchanted creature has "Whenever this creature attacks, if its toughness is 3 or less, put a +1/+1 counter on it."',
  Cursed: 'Enchant creature\nEnchanted creature has base power and toughness 1/1.',
};
// Named creature tokens whose stats aren't written on the card that makes them
const NAMED_CREATURE_TOKENS = {
  Gingerbrute: { p: 1, t: 1, typeLine: 'Token Artifact Creature — Food Golem', oracle: "Haste\n{1}: This token can't be blocked this turn except by creatures with haste.\n{2}, {T}, Sacrifice this token: You gain 3 life.", keywords: ['haste'] },
};
export function namedTokenDef(label) {
  const n = NAMED_CREATURE_TOKENS[label];
  if (!n) return null;
  const id = `gen-named-${label}`;
  if (!DB[id]) {
    DB[id] = {
      id, name: label, layout: 'token', cmc: 0, manaCost: '', typeLine: n.typeLine, colors: [], ci: [], keywords: n.keywords || [], produced: [], tokens: [], doubleFaced: false, isToken: true,
      faces: [{ name: label, manaCost: '', typeLine: n.typeLine, oracle: n.oracle, power: String(n.p), toughness: String(n.t), img: null, imgLarge: null }],
    };
  }
  return id;
}
export function genericTokenDef(p, t, label, color, extra = {}) {
  const art = ARTIFACT_TOKENS[label];
  const role = ROLE_TOKENS[label.replace(/ Role$/, '')];
  const id = art ? `gen-${label}` : role ? `gen-role-${label}` : `gen-${p}-${t}-${label}-${(extra.keywords || []).join('_')}-${extra.types || ''}`.replace(/\s+/g, '_');
  if (!DB[id]) {
    let typeLine;
    let oracleText = '';
    if (art) {
      typeLine = `Token ${art[0]} — ${label}`;
      oracleText = art[1];
    } else if (role) {
      typeLine = `Token Enchantment — Aura Role`;
      oracleText = role;
    } else {
      typeLine = `Token ${extra.types ? extra.types + ' ' : ''}Creature — ${label}`;
      oracleText = (extra.keywords || []).map((k) => k[0].toUpperCase() + k.slice(1)).join(', ');
    }
    const name = role ? `${label.replace(/ Role$/, '')} Role` : label;
    DB[id] = {
      id, name, layout: 'token', cmc: 0, manaCost: '', typeLine,
      colors: color ? [].concat(color) : [], ci: [], keywords: (extra.keywords || []).map((k) => k.toLowerCase()),
      produced: label === 'Treasure' || label === 'Gold' ? ['W', 'U', 'B', 'R', 'G'] : label === 'Powerstone' ? ['C'] : [],
      tokens: [], doubleFaced: false, isToken: true,
      faces: [{ name, manaCost: '', typeLine, oracle: oracleText, power: art || role ? undefined : String(p), toughness: art || role ? undefined : String(t), img: null, imgLarge: null }],
    };
  }
  return id;
}

export function attackersTotalPower() {
  const cb = G.s.combat;
  return cb ? cb.attackers.reduce((a, i) => a + Math.max(0, power(card(i))), 0) : 0;
}

export { def };
