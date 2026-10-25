// Game state, zones and the actions both players use.
import { DB } from './data.js';
import { isCreature, isLand, power, toughness, isDead, def, isType, hasKw, oracle, face, typeLine, hasSubtype, abilitiesGone, pairGrantText } from './rules.js';
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
    everyStep: true,
    arenaMode: true,
    aiStyle: 'casual',
    boardLayout: 'organized',
  },
};

let nextId = 1;

// Game events waiting for triggered abilities (processed by triggers.js)
export const eventQueue = [];
// Avatar: "Whenever you waterbend, earthbend, firebend, or airbend" — remember which this turn
export function noteBend(pid, kind) {
  if (!G.s || !pid) return;
  const t = G.s.ts && G.s.ts[pid];
  if (t && !(t.bends || []).includes(kind)) t.bends = [...(t.bends || []), kind];
  queueEvent({ type: 'bend', pid, kind });
}
// "Whenever you exert a creature"
export function noteExert(c) {
  if (!c) return;
  c.noUntapUntil = nextTurnNumber(c.controller);
  queueEvent({ type: 'exerted', iid: c.iid, controller: c.controller });
}
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

const isCreatureCard = (c) => /Creature/.test((DB[c.def].faces[c.face || 0] || DB[c.def].faces[0]).typeLine || DB[c.def].typeLine || '');
export function freshTurnStats(list = seats()) {
  const one = () => ({ loyaltyActivated: 0, spells: 0, noncreatureSpells: 0, lifeLost: 0, lifeGained: 0, damagedOpp: false, attacked: false, landsPlayed: 0, drawn: 0, cardsLeftGy: 0, permLeft: false, speedUp: false, discarded: [] });
  const ts = {};
  for (const k of list) ts[k] = one();
  return Object.assign(ts, { creatureDied: false, warped: false });
}

// newGame(yourDeck, aiDeck) is 1v1; newGame(yourDeck, ai1, ai2[, ai3]) seats a pod of 3-4 players.
export function newGame(pDeck, ...aiDecks) {
  nextId = 1;
  const list = ['p', ...AI_SEATS.slice(0, Math.max(1, aiDecks.length))];
  const pod = list.length > 2;
  const players = {};
  const decks = {};
  const allDecks = [pDeck, ...aiDecks];
  list.forEach((k, i) => {
    players[k] = newPlayer(k === 'p' ? 'You' : pod ? `AI ${i}` : 'AI');
    decks[k] = { name: allDecks[i].name };
  });
  const s = {
    seats: list,
    cards: {},
    players,
    decks,
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
    extraTurns: Object.fromEntries(list.map((k) => [k, 0])),
    extraCombats: 0,
    ts: freshTurnStats(list),
    delayed: [],
    pool: Object.fromEntries(list.map((k) => [k, []])),
  };
  G.s = s;
  eventQueue.length = 0;
  G.undo = [];
  G.redo = [];
  for (const [pid, deck] of list.map((k, i) => [k, allDecks[i]])) {
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
  // Turn order: everyone rolls a d20 (shown at the start of the game); highest goes first, ties roll again.
  // s.rolls = rounds of { pid: value } (a round for each tie-break).
  const name = (k) => (k === 'p' ? 'you' : s.players[k].name);
  if (!pod) {
    // 1v1: one random draw decides who starts (as the old coin flip did); the two dice are read from it
    const r = Math.random();
    s.first = r < 0.5 ? 'p' : 'ai';
    const u = (r < 0.5 ? r * 2 : (r - 0.5) * 2) * 190; // 190 = the number of (high, low) pairs of d20s
    let k = Math.floor(u);
    let hi = 2;
    while (k >= hi - 1) { k -= hi - 1; hi++; }
    const lo = k + 1;
    s.rolls = [{ [s.first]: hi, [s.first === 'p' ? 'ai' : 'p']: lo }];
    log('sys', `Dice for turn order: you roll ${s.rolls[0].p}, the AI rolls ${s.rolls[0].ai}. <b>${s.first === 'p' ? 'You go' : 'The AI goes'} first</b>.`);
  } else {
    // pods: the highest roll goes first, then play passes around the table in seating order.
    // Only players tied for the highest roll roll again.
    s.rolls = [];
    let rolling = list.slice();
    const scores = {};
    while (rolling.length > 1) {
      const round = {};
      for (const k of rolling) round[k] = 1 + Math.floor(Math.random() * 20);
      s.rolls.push(round);
      for (const k of rolling) scores[k] = (scores[k] || []).concat(round[k]);
      const top = Math.max(...rolling.map((k) => round[k]));
      rolling = rolling.filter((k) => round[k] === top);
    }
    s.first = rolling[0];
    const from = list.indexOf(s.first);
    const order = [...list.slice(from), ...list.slice(0, from)];
    log('sys', `Dice for turn order: ${list.map((k) => `${name(k)} ${scores[k].join(' then ')}`).join(', ')}. <b>${s.first === 'p' ? 'You go' : s.players[s.first].name + ' goes'} first</b>. Turn order: ${order.map(name).join(' → ')}.`);
  }
  for (const k of list) draw(k, 7, true);
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
// ------------------------------------------------------------ seats
// 'p' is you. AI seats are 'ai', 'ai2', 'ai3'. G.s.seats lists everyone in turn order (clockwise: each
// player's left-hand neighbour comes next). A 1v1 game is ['p', 'ai'], so everything below reduces to the
// two-player rules there.
export const AI_SEATS = ['ai', 'ai2', 'ai3'];
export function seats() {
  return (G.s && G.s.seats) || ['p', 'ai'];
}
export const isAI = (pid) => AI_SEATS.includes(pid);
// is this id a player (seat) rather than a card?
export const isPlayer = (x) => !!(x && G.s && G.s.players[x]) || x === 'p' || AI_SEATS.includes(x);
export const multiplayer = () => seats().length > 2;
export function inGame(pid) {
  const pl = G.s && G.s.players[pid];
  return !!pl && !pl.lost;
}
// players still in the game, in turn order
export function livingSeats() {
  return seats().filter(inGame);
}
// everyone except pid who is still in the game (in 1v1: the other player, even after they lost)
export function opponents(pid) {
  if (!multiplayer()) return seats().filter((k) => k !== pid);
  return livingSeats().filter((k) => k !== pid);
}
// the next player in turn order who is still in the game (the player to pid's left)
export function nextSeat(pid, dir = 1) {
  const all = seats();
  const n = all.length;
  let k = all.indexOf(pid);
  for (let step = 0; step < n; step++) {
    k = (k + dir + n) % n;
    if (all[k] !== pid && inGame(all[k])) return all[k];
  }
  return all.find((x) => x !== pid) || pid;
}
// Who an AI seat is focusing on (threat assessment lives in ai.js and registers itself here).
export const seatHooks = { focus: null };
// "The" opponent. In 1v1 that's simply the other player. In a pod, code that still needs a single opponent
// (a default target, "that player" with nothing chosen) gets the one this seat is focused on: for an AI, its
// threat assessment; for you, the next opponent in turn order.
export function opp(pid) {
  if (!multiplayer()) return pid === 'p' ? 'ai' : 'p';
  const opps = opponents(pid);
  if (!opps.length) return nextSeat(pid);
  if (isAI(pid) && seatHooks.focus) {
    const f = seatHooks.focus(pid);
    if (f && opps.includes(f)) return f;
  }
  return nextSeat(pid);
}
// The turn number on which pid's next turn starts, for "until your next turn". In 1v1 this has always been
// counted as two turns from now; in a pod it depends on where pid sits relative to the active player.
export function nextTurnNumber(pid) {
  const s = G.s;
  if (!multiplayer()) return s.turn + 2;
  const order = livingSeats();
  const n = order.length;
  const a = order.indexOf(s.active);
  const k = order.indexOf(pid);
  if (a < 0 || k < 0) return s.turn + n;
  const d = (k - a + n) % n;
  return s.turn + (d === 0 ? n : d);
}
// A creature that joins an attack already in progress ("enters tapped and attacking"): in a pod it attacks
// the same player as the creature that made it, or else whoever most of the attackers are going after.
export function joinAttack(iid, srcIid) {
  const cb = G.s && G.s.combat;
  if (!cb || !multiplayer()) return;
  cb.targets = cb.targets || {};
  if (cb.targets[iid]) return;
  const from = srcIid && cb.targets[srcIid];
  if (from) {
    cb.targets[iid] = from;
    return;
  }
  const counts = {};
  for (const a of cb.attackers) if (cb.targets[a]) counts[cb.targets[a]] = (counts[cb.targets[a]] || 0) + 1;
  const best = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
  const c = G.s.cards[iid];
  cb.targets[iid] = best ? best[0] : opp(c ? c.controller : 'p');
}
// The player to your left takes the next turn (turn order passes to the left); the player to your right had
// the turn before yours. In 1v1 both are your opponent.
export const leftOf = (pid) => nextSeat(pid, 1);
export const rightOf = (pid) => nextSeat(pid, -1);
// Turn order starting with pid (the players still in the game), for "starting with you, each player …"
export function turnOrderFrom(pid) {
  const order = seats().filter((k) => k === pid || inGame(k));
  const k = Math.max(0, order.indexOf(pid));
  return [...order.slice(k), ...order.slice(0, k)];
}
// Replace "the AI" / "AI" in the text parts of an html line (not inside tags) with this seat's name.
// "AI 2" style names are left alone.
export function seatWords(html, pid) {
  const name = (G.s.players[pid] && G.s.players[pid].name) || pid;
  return html.split(/(<[^>]*>)/).map((part) => {
    if (part.startsWith('<')) return part;
    return part
      .replace(/\b[Tt]he AI's\b/g, `${name}'s`)
      .replace(/\b[Tt]he AI\b(?! \d)/g, name)
      .replace(/\bAI's\b/g, `${name}'s`)
      .replace(/\bAI\b(?! \d)(?!')/g, name);
  }).join('');
}
// ------------------------------------------------------------ goad
// Goad (rule 701.15): until the goading player's next turn the creature attacks each combat if able, and attacks
// a player other than the goading player if able. Several players can goad the same creature; each goad
// lasts until that player's next turn. `until` is the last turn number the goad is in effect.
export function goadUntil(by) {
  return multiplayer() ? nextTurnNumber(by) - 1 : G.s.turn + 1;
}
export function goad(c, by, until = goadUntil(by)) {
  if (!c) return;
  const g = c.goaded || {};
  const from = { ...(g.from || (g.by ? { [g.by]: g.until } : {})) };
  from[by] = Math.max(from[by] || 0, until);
  c.goaded = { by, until: Math.max(...Object.values(from)), from };
}
// is it goaded right now?
export function isGoaded(c) {
  if (c && c.goadWhile && G.s && (!G.s.cards[c.goadWhile] || G.s.cards[c.goadWhile].zone !== 'battlefield')) return false; // Hot Pursuit
  return !!(c && c.goaded && (!c.goaded.until || G.s.turn <= c.goaded.until));
}
// the players who goaded it (whose goad is still in effect)
export function goadersOf(c) {
  if (!isGoaded(c)) return [];
  const from = c.goaded.from || { [c.goaded.by]: c.goaded.until };
  return Object.entries(from).filter(([, u]) => !u || G.s.turn <= u).map(([k]) => k);
}
// End of turn: drop goads that have run out (each goader separately).
export function expireGoads() {
  const s = G.s;
  for (const c of Object.values(s.cards)) {
    if (!c.goaded) continue;
    if (c.goaded.from) {
      const left = Object.entries(c.goaded.from).filter(([, u]) => !u || u > s.turn);
      if (!left.length) delete c.goaded;
      else {
        const from = Object.fromEntries(left);
        const [by, until] = left.sort((a, b) => b[1] - a[1])[0];
        c.goaded = { by, until, from };
      }
    } else if (c.goaded.until && c.goaded.until <= s.turn) delete c.goaded;
  }
}
// The legal attack targets for a goaded creature: players (and their permanents) other than its goaders.
// If every opponent goaded it, any of them will do.
export function goadOk(c, targetPlayer) {
  const g = goadersOf(c);
  if (!g.length || !multiplayer()) return true;
  const others = opponents(c.controller).filter((o) => !g.includes(o));
  return !others.length || !g.includes(targetPlayer);
}
// every permanent on the battlefield, seat by seat (phased-out ones excluded, like cardsIn)
export function allBattlefields() {
  return seats().flatMap((k) => cardsIn(k, 'battlefield'));
}
// Display names: "you", "the AI" in 1v1, "AI 2" style names in a pod
export function seatName(pid) {
  if (pid === 'p') return 'you';
  if (!multiplayer()) return 'the AI';
  return (G.s.players[pid] && G.s.players[pid].name) || pid;
}
// "You" / "The AI" / "AI 2", and "your" / "the AI's" / "AI 2's"
export const seatNameCap = (pid) => (pid === 'p' ? 'You' : multiplayer() ? seatName(pid) : 'The AI');
export const seatPoss = (pid) => (pid === 'p' ? 'your' : multiplayer() ? `${seatName(pid)}'s` : "the AI's");

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
// tap a permanent and let "Whenever ~ becomes tapped" triggers see it
export function tapPerm(c) {
  if (!c || c.tapped) return;
  c.tapped = true;
  if (c.zone === 'battlefield') queueEvent({ type: 'tapped', iid: c.iid, controller: c.controller });
}
export function tappedHook(c) {
  if (!c || !G.s || c.zone !== 'battlefield' || !isCreature(c)) return;
  const first = c.firstTapTurn !== G.s.turn;
  c.firstTapTurn = G.s.turn;
  if (!first || G.s.active !== c.controller || !c.tapped) return;
  const cap = G.s.players[c.controller].zones.battlefield.map((i) => G.s.cards[i]).find((x) => x && !x.phasedOut && !abilitiesGone(x) && /Whenever a creature you control becomes tapped during your turn, if it's the first time that creature has become tapped this turn, untap it/i.test(oracle(x)));
  if (!cap) return;
  c.tapped = false;
  log(c.controller, `${nameTag(cap)}: ${nameTag(c)} untaps.`);
}
export function log(who, html) {
  // pods: lines an AI seat logs about itself say "The AI …" in places; name the seat instead ("AI 2 …")
  if (multiplayer() && isAI(who) && typeof html === 'string') html = seatWords(html, who);
  G.s.log.push({ who, html, turn: G.s.turn });
  if (G.s.log.length > 500) G.s.log.shift();
}

// ------------------------------------------------------------ zone movement
const RESET = ['chosenNumber', 'chosenCardType', 'fromLibTurn', 'hiddenExile', 'ianSrc', 'exiledFromHand', 'mayCastFromGy', 'mayCastFromGyTurn', 'lockeGroup', 'tapped', 'damage', 'deathtouched', 'auraBuffs', 'eot', 'eotGrants', 'pacifiedBy', 'attachedTo', 'attacking',
  'blocking', 'animated', 'crewedTurn', 'saddledTurn', 'stationCreature', 'regen', 'goaded', 'detainedUntil', 'monstrous',
  'renowned', 'classLevel', 'proto', 'setPT', 'modesUsed', 'chosenColor', 'lostAbilities', 'endOfTurn', 'eotUnlessBlessing', 'blightLand', 'becameLand', 'exileIfLeaves', 'noUntapUntil', 'phasedOut', 'phasedUntil', 'phaseInTapped', 'exiledLinked', 'sector', 'chosenType', 'floated',
  'cantBlockTurn', 'unblockableTurn', 'suspected', 'mutated', 'usedAbilities', 'kicked', 'bargained', 'castMode', 'xPaid', 'impending',
  'ringBearer', 'exileOnDeath', 'cantSacUntil', 'dmgDraw', 'addTypes', 'extraText', 'pairedWith', 'chosenPlayers', 'dmgBy', 'dmgByTurn', 'grantedText', 'grantedBy', 'eotText', 'controlWhile', 'craftedFrom', 'becameTreasure', 'chosenMode', 'solved', 'unlocked', 'grants', 'ptMod', 'echoPaid', 'endOfCombat', 'bestowed',
  'morph', 'wardTwo', 'reconfigured', 'usedLoyaltyTurn', 'loyaltyUses', 'provokedBy', 'squadCount', 'offspringPaid', 'merged',
  'foretold', 'foretoldTurn', 'plotted', 'plottedTurn', 'onAdventure', 'mayPlay', 'mayPlayUntil', 'anyColorMana', 'mayPlayFreeUntil', 'castOnly', 'myTurnOnly', 'convokedBy', 'mayPlayFree', 'suspended',
  'rebound', 'encodedOn', 'hiddenBy', 'auraType', 'layerFx', 'addTypesTs', 'lostAt', 'lostGrantsN', 'lostEotN', 'switchPT', 'dutyVs', 'vowVs', 'raggerVs', 'eggFor', 'secretOpp', 'grantedUnearth', 'grantedUnearthTurn', 'grantedFlashback', 'grantedFlashbackTurn', 'kodamaPut', 'mustBlockTurn', 'loseIndestructibleTurn', 'monarchOnDeath', 'enlistedTurn', 'escaped', 'noUntapWhile', 'noUntapWhileCtl', 'luciusReturn', 'necromancyOf', 'preventDmgTurn', 'spelljacked', 'settlementBy', 'playIfTokenAttacked', 'indestructibleFrom', 'goadWhile', 'typeWhileCounter', 'dmgToCounters', 'playOneOf', 'lifeOnCast', 'playWhileCtl', 'exiledWithSrc', 'prepared', 'exileIfDiesTurn', 'warped', 'manifested', 'castFrom', 'castFace', 'aiSkip', 'ntTurn', 'noAttackUntil', 'noBlockUntil'];

/**
 * Move a card between zones (possibly across controllers' battlefields).
 * opts: {to:'top'|'bottom'|index, x, y, controller, tapped, faceDown, silent, cause}
 */
export function move(iid, zone, opts = {}) {
  const s = G.s;
  const c = s.cards[iid];
  if (!c) return;
  const fromZone = c.zone;
  if (fromZone === 'battlefield' || zone === 'battlefield') s.bfv = (s.bfv || 0) + 1; // board changed (rules.js caches by this)
  const fromCtl = fromZone === 'battlefield' ? c.controller : c.owner;
  let requested = zone;
  // Samwise the Stouthearted: "a permanent card in your graveyard that was put there from the battlefield this turn"
  if (fromZone === 'battlefield' && zone === 'graveyard') c.fromBfTurn = s.turn;
  if (zone === 'graveyard') c.gyTurn = s.turn; // Garna: "put there from anywhere this turn"
  // Lynde, Cheerful Tormentor: a Curse put into your graveyard from the battlefield returns attached to you at the next end step
  if (fromZone === 'battlefield' && zone === 'graveyard' && /\bCurse\b/.test(DB[c.def].typeLine || '') && Object.values(s.cards).some((x) => x.zone === 'battlefield' && x.controller === c.owner && /Whenever a Curse is put into your graveyard from the battlefield, return it to the battlefield attached to you/i.test(DB[x.def].faces[0].oracle || ''))) (s.delayed = s.delayed || []).push({ at: 'endStep', kind: 'returnAura', iid: c.iid, pid: c.owner, player: c.owner });
  // Xira: "When that creature dies, if it has an egg counter on it, draw a card and create a 1/1 black Insect creature token with flying."
  if (fromZone === 'battlefield' && zone === 'graveyard' && (c.counters || {}).egg > 0 && c.eggFor) { const ep = c.eggFor; queueMicrotask(() => { if (G.s !== s) return; draw(ep, 1, true); createToken(genericTokenDef(1, 1, 'Insect', ['B'], { keywords: ['flying'] }), ep, 1); log(ep, `Xira: ${ep === 'p' ? 'you draw' : 'draws'} a card and ${ep === 'p' ? 'create' : 'creates'} an Insect.`); }); }
  // Cass, Hand of Vengeance: remember what was attached as it left
  if (fromZone === 'battlefield' && zone !== 'battlefield') c.lastAttached = Object.values(s.cards).filter((x) => x.attachedTo === iid && x.zone === 'battlefield').map((x) => x.iid);
  // replacements: finality counters, "exile it if it would leave", Rest in Peace and friends
  if (fromZone === 'battlefield' && zone !== 'battlefield') {
    if ((c.counters || {}).finality && zone === 'graveyard') zone = 'exile';
    // Cosmic Intervention: "If a permanent you control would be put into a graveyard from the battlefield this turn, exile it instead. Return it … at the beginning of the next end step."
    if (zone === 'graveyard' && !c.token && (s.cosmic || []).some((x) => x.turn === s.turn && x.pid === c.controller)) {
      zone = requested = 'exile';
      s.delayed = s.delayed || [];
      s.delayed.push({ at: 'endStep', kind: 'returnFromExile', iid, pid: c.owner });
    }
    if (c.exileIfLeaves) zone = 'exile';
    if (c.exileIfDiesTurn === s.turn && zone === 'graveyard') zone = requested = 'exile'; // The War Doctor: "would die this turn, exile it instead" (it doesn't die)
  }
  if (zone === 'graveyard' && repl('gyExile', c.owner)) zone = 'exile';
  // "Whenever one or more cards are put into exile …" (Laelia, The War Doctor): one batch per effect
  if (zone === 'exile' && fromZone && fromZone !== 'exile') {
    const batch = eventQueue.find((e) => e.type === 'exiledBatch');
    const item = { iid, from: fromZone, owner: c.owner, controller: fromZone === 'battlefield' ? c.controller : c.owner, by: s.effectCtl || null }; // by: whose spell or ability is resolving (Hero of Bretagard)
    if (batch) batch.items.push(item);
    else queueEvent({ type: 'exiledBatch', items: [item] });
  }
  // events for triggered abilities
  if (fromZone === 'battlefield' && zone !== 'battlefield') {
    const pairGrant = c.pairedWith ? pairGrantText(c) : ''; // soulbond: a dying creature keeps what its pair gave it (Doom Weaver)
    // soulbond: the pair breaks when either leaves
    if (c.pairedWith && s.cards[c.pairedWith] && s.cards[c.pairedWith].pairedWith === iid) delete s.cards[c.pairedWith].pairedWith;
    delete c.pairedWith;
    s.ts[c.controller].permLeft = true;
    if (!isLand(c)) s.ts.nonlandLeft = true;
    const attachedHere = Object.values(s.cards).filter((a) => a.attachedTo === iid && a.zone === 'battlefield');
    if (requested === 'graveyard' && isCreature(c)) {
      s.ts.creatureDied = true;
      s.ts.creaturesDiedN = (s.ts.creaturesDiedN || 0) + 1;
      queueEvent({
        type: 'dies', iid, def: c.def, face: c.face || 0, controller: c.controller, owner: c.owner, token: c.token,
        power: power(c), toughness: toughness(c), counters: { ...(c.counters || {}) }, isCommander: c.isCommander, merged: c.merged || [],
        granted: [c.extraText, c.eotText, pairGrant].filter(Boolean).join('\n') || undefined, // "When this creature dies, …" it gained (Rabid Attack)
        wasBlitzed: c.castMode === 'blitz', wasAttacking: !!c.attacking, wasBlocking: !!c.blocking, dmgBy: c.dmgByTurn === s.turn ? c.dmgBy || [] : [], attached: attachedHere.map((a) => a.iid), attachedCtl: Object.fromEntries(attachedHere.map((a) => [a.iid, a.controller])),
      });
    } else if (requested === 'graveyard') queueEvent({ type: 'putIntoGraveyard', iid, def: c.def, controller: c.controller, owner: c.owner, token: c.token, fromBattlefield: true });
    queueEvent({ type: 'leaves', iid, def: c.def, face: c.face || 0, controller: c.controller, owner: c.owner, token: c.token, to: zone, wasAttacking: !!c.attacking, power: isCreature(c) ? power(c) : undefined, creature: isCreature(c), artifact: isType(c, 'Artifact'), counters: { ...(c.counters || {}) }, attached: attachedHere.map((a) => a.iid) });
    if (requested === 'graveyard' && isCreature(c)) (s.ts[c.controller].diedTypes = s.ts[c.controller].diedTypes || []).push(typeLine(c));
  }
  if (fromZone === 'graveyard' && zone !== 'graveyard') {
    s.ts[c.owner].cardsLeftGy++;
    // "Whenever one or more cards leave your graveyard": one event per batch
    const lg = eventQueue.find((e) => e.type === 'leftGraveyard' && e.owner === c.owner);
    if (lg) { lg.n++; (lg.defs = lg.defs || []).push(c.def); }
    else queueEvent({ type: 'leftGraveyard', owner: c.owner, n: 1, def: c.def, defs: [c.def] });
  }
  if (zone === 'graveyard' && fromZone !== 'graveyard' && !c.token) queueEvent({ type: 'toGraveyard', iid, def: c.def, owner: c.owner, from: fromZone, controller: fromZone === 'battlefield' ? c.controller : c.owner });
  // "Its controller …" after it left (Path to Exile on a creature you'd stolen): remember who controlled it
  if (fromZone === 'battlefield' && zone !== 'battlefield') (s.lastCtl = s.lastCtl || {})[iid] = c.controller;
  // last known power and toughness, with counters and pumps (Swords to Plowshares: "life equal to its power")
  if (fromZone === 'battlefield' && zone !== 'battlefield' && isCreature(c)) (s.lki = s.lki || {})[iid] = { p: power(c), t: toughness(c), wasLand: isLand(c) };
  else if (fromZone === 'battlefield' && zone !== 'battlefield' && c.becameLand) (s.lki = s.lki || {})[iid] = { wasLand: true }; // Princess Yue dying as Moon
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
  // (a spell stays recorded in the zone it was cast from while it's on the stack: opts.fromStack marks a
  // countered or resolving spell, so a commander cast from the command zone still gets the choice)
  if (c.isCommander && !opts.noCommandZone && (opts.fromStack || (fromZone !== zone && fromZone !== 'command'))) {
    const auto = isAI(c.owner) || G.settings.commanderZone === 'auto';
    const gyEx = zone === 'graveyard' || zone === 'exile';
    if (auto && gyEx) zone = 'command';
    // the player decides: it goes there, and a prompt offers the command zone
    else if (!auto && (gyEx || ((zone === 'hand' || zone === 'library') && (fromZone === 'battlefield' || fromZone === 'stack' || opts.fromStack)))) c.cmdAsk = zone;
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
  // a copy of a card (Flawless Forgery's cast copy): a token once it's a permanent, gone once it leaves the stack otherwise
  if (c.copyCard && zone !== fromZone) {
    if (zone === 'battlefield') { c.token = true; delete c.copyCard; }
    else {
      delete s.cards[iid];
      return null;
    }
  }
  // tokens cease to exist outside the battlefield
  if (c.token && zone !== 'battlefield') {
    delete s.cards[iid];
    if (combatRef()) dropFromCombat(iid);
    return null;
  }
  const leavingField = fromZone === 'battlefield' && zone !== 'battlefield';
  // Grafted Exoskeleton leaving: the creature it was attached to is sacrificed
  if (leavingField && c.attachedTo && s.cards[c.attachedTo] && s.cards[c.attachedTo].zone === 'battlefield' && /becomes unattached from a permanent, sacrifice that permanent/i.test(oracle(c))) {
    const host = c.attachedTo;
    c.attachedTo = null;
    queueMicrotask(() => { if (G.s === s && s.cards[host] && s.cards[host].zone === 'battlefield') { log(s.cards[host].controller, `${nameTag(s.cards[host])} is sacrificed (its Equipment came off).`); sacrifice(host); } });
  }
  if (leavingField && c.origDef) endCopy(c);
  // Fight for the Throne: "When the creature an opponent controls dies this turn, if you control your commander, you become the monarch."
  if (leavingField && zone === 'graveyard' && c.monarchOnDeath && c.monarchOnDeath.turn === s.turn && Object.values(s.cards).some((x) => x.zone === 'battlefield' && x.isCommander && x.controller === c.monarchOnDeath.pid)) { const mp = c.monarchOnDeath.pid; if (s.monarch !== mp) { s.monarch = mp; queueEvent({ type: 'becameMonarch', pid: mp }); log(mp, `${mp === 'p' ? 'You become' : 'The AI becomes'} the monarch.`); } }
  // Lucius the Eternal: "When that creature leaves the battlefield, return this card from exile to the battlefield"
  if (leavingField && c.luciusReturn) { const lu = c.luciusReturn; queueMicrotask(() => { const l = s.cards[lu]; if (G.s === s && l && l.zone === 'exile') { toBattlefield(lu, l.owner); log(l.owner, `${nameTag(l)} returns from exile.`); } }); }
  if (zone === 'graveyard' && s.ts && s.ts[c.owner]) s.ts[c.owner].toGyCount = (s.ts[c.owner].toGyCount || 0) + 1; // Fraying Sanity
  if (leavingField || (zone !== 'battlefield' && fromZone !== 'battlefield')) {
    if (c.becameLand) delete c.nameOverride;
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
    c.enteredFrom = fromZone || null; // "a land you control enters from anywhere other than your hand
    c.ts = nextStamp();
    // Rooms: the door that was cast enters unlocked ("When you unlock this door" triggers); put onto the battlefield otherwise, both stay locked
    if (/Room/.test(DB[c.def].typeLine || '') && DB[c.def].faces.length === 2 && /Room/.test(DB[c.def].faces[1].typeLine || '')) {
      const k = fromZone === 'stack' || c.castFace !== undefined ? c.castFace || 0 : -1;
      c.unlocked = [k === 0, k === 1];
      c.face = 0;
      if (k >= 0) queueEvent({ type: 'unlock', iid, door: k, controller: opts.controller || c.controller });
    }
    if (fromZone !== 'stack') c.castMode = c.castMode || null;
  }
  if (opts.controller && fromZone === 'battlefield' && zone === 'battlefield' && c.controller !== opts.controller) queueEvent({ type: 'controlLost', iid, from: c.controller, to: opts.controller }); // Khârn the Betrayer
  if (opts.controller && fromZone === 'battlefield' && zone === 'battlefield' && c.controller !== opts.controller && c.pairedWith) { if (s.cards[c.pairedWith] && s.cards[c.pairedWith].pairedWith === iid) delete s.cards[c.pairedWith].pairedWith; delete c.pairedWith; } // soulbond: control changed
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
  if (zone === 'battlefield' && fromZone !== 'battlefield') {
    entering(c, opts);
    // what entered under whose control this turn ("if two or more nonland permanents entered the battlefield under your control this turn")
    const tsc = s.ts && s.ts[c.controller];
    if (tsc) (tsc.entered = tsc.entered || []).push({ iid, types: typeLine(c), token: !!c.token, faceDown: !!c.faceDown });
  }
  // the turn's history for "if …" conditions
  if (s.ts && fromZone !== zone) {
    const tso = s.ts[c.owner];
    if (zone === 'graveyard' && tso) {
      tso.toGy = (tso.toGy || 0) + 1;
      if (fromZone !== 'battlefield') tso.toGyNotBf = (tso.toGyNotBf || 0) + 1;
      if (isCreatureCard(c)) tso.creatureToGy = true;
      if (!c.token && /Artifact|Creature|Enchantment|Land|Planeswalker|Battle/.test(DB[c.def].typeLine || '')) tso.descended = (tso.descended || 0) + 1; // descend
    }
    if (fromZone === 'graveyard' && tso && isCreatureCard(c)) tso.creatureLeftGy = true;
    if (zone === 'exile') s.ts.exiledAny = true;
    if (fromZone === 'battlefield' && zone === 'hand') (s.ts[fromCtl] || {}).bouncedToHand = true;
    if (fromZone === 'battlefield' && zone === 'graveyard') {
      const tl = DB[c.def].typeLine || '';
      if (/Artifact|Creature/.test(tl)) s.ts.artOrCreatureToGy = true;
      if (/Enchantment/.test(tl) && tso) tso.enchantmentToGy = true;
      if (/Land/.test(tl) && tso) tso.landToGy = true;
    }
  }
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
  // its own "enters tapped" line — not a trigger about other permanents entering tapped (Amulet of Vigor) or a static for others
  const line = o.split('\n').find((l) => /enters?(?: the battlefield)? tapped/i.test(l) && !/^\s*(?:When|Whenever|At)\b/i.test(l) && !/(?:you control|opponents? controls?|permanents|creatures|lands) enters? (?:the battlefield )?tapped/i.test(l));
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
  if ((m = line.match(/unless your opponents control (\w+) or more lands/i))) return opponents(pid).flatMap((o) => cardsIn(o, 'battlefield')).filter(isLand).length < (NUMW[m[1]] || +m[1]);
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
  for (const mm of o.matchAll(/enters(?: the battlefield)? with (a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+) ([+-]\d+\/[+-]\d+|[a-z]+) counters? on (?:it|him|her|them)( for each time (?:it|he|she|~|this [a-z]+) was kicked)?/gi)) {
    const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    const nW = mm[1].toLowerCase();
    let k = nW === 'x' ? c.xPaid || 0 : words[nW] || parseInt(nW, 10) || 0;
    // Everflowing Chalice, Batroc: "… for each time it was kicked" (multikicker)
    if (mm[3]) k *= typeof c.kicked === 'number' ? c.kicked : c.kicked ? 1 : 0;
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
  if (/(?:^|\n)(?:This creature|~|[^\n.]+?) enters prepared\b/.test(o)) c.prepared = true; // Blazing Firesinger
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
  if (isLand(c)) queueEvent({ type: 'landfall', iid: c.iid, controller: c.controller, from: c.enteredFrom });
  void opts;
  void s;
}

// Counters, with Hardened Scales / Doubling Season style replacements for the controller.
export function addCounters(c, kind, n, opts = {}) {
  if (!c || n === 0) return 0;
  c.counters = c.counters || {};
  // Darksteel Angel & co.: "Creatures you control can't have -1/-1 counters put on them."
  if (n > 0 && kind === '-1/-1' && c.zone === 'battlefield' && isCreature(c) && cardsIn(c.controller, 'battlefield').some((x) => !x.phasedOut && /Creatures you control can't have -1\/-1 counters put on them/i.test(oracle(x)))) return 0;
  if (n > 0 && c.zone === 'battlefield' && kind !== 'loyalty-cost') {
    if (kind === '+1/+1') n += repl('counterPlusOne', c.controller);
    // Lae'zel: "If you would put one or more counters on a creature or planeswalker you control …, put that many plus one"
    const putter = opts.by || G.curActor || c.controller;
    if (putter === c.controller && (isCreature(c) || /Planeswalker/.test(typeLine(c)))) n += repl('counterPlusOneAll', c.controller);
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
  if (n > 0) c.counterTurn = G.s.turn; // "if you put a counter on ~ this turn" 
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

// Draw replacements: Teferi's Ageless Insight / Alhammarret's Archive / Thought Reflection ("draw two cards instead"),
// Notion Thief ("instead you skip that draw and you draw a card"). Each draw is replaced once by each effect.
function drawReplacement(pid) {
  const s = G.s;
  const ts = s.ts[pid];
  // the first card you draw in your draw step is exempt from "except the first one…"
  let exempt = false;
  if (s.step === 'draw' && s.active === pid && !ts.drawStepDrew) {
    exempt = true;
    ts.drawStepDrew = true;
  }
  const oracleOf = (x) => oracle(x); // the active text ("Max speed — " lines only at max speed)
  const field = (who) => s.players[who].zones.battlefield.map((i) => s.cards[i]).filter((x) => x && !x.phasedOut && !abilitiesGone(x));
  const others = opponents(pid).flatMap(field); // every opponent's permanents
  // Notion Thief (an opponent of the drawer)
  // Chains of Mephistopheles (anyone's): discard instead (then draw), or mill if they can't
  const chains = [...field(pid), ...others].find((x) => /If a player would draw a card except the first one they draw in each of their draw steps, that player discards a card instead/i.test(oracleOf(x)));
  if (chains && !exempt) return { deferred: 'chains', by: chains };
  // Underrealm Lich (yours): look at the top three, keep one, the rest go to the graveyard
  const lich = field(pid).find((x) => /If you would draw a card, instead look at the top three cards of your library, then put one into your hand and the rest into your graveyard/i.test(oracleOf(x)));
  if (lich) return { deferred: 'lich', by: lich };
  const thief = others.find((x) => /If an opponent would draw a card except the first one they draw in each of their draw steps, instead (?:you skip|that player skips) that draw and you draw a card/i.test(oracleOf(x)));
  if (thief && !exempt) return { stolenBy: thief.controller, by: thief };
  // Narset, Parter of Veils (opponents) / Spirit of the Labyrinth (everyone): no more than one card each turn
  const limit = others.find((x) => /Each opponent can't draw more than one card each turn/i.test(oracleOf(x)))
    || [...field(pid), ...others].find((x) => /Each player can't draw more than one card each turn/i.test(oracleOf(x)));
  if (limit && (ts.drawn || 0) >= 1) return { blocked: limit };
  let mult = 1;
  const why = [];
  for (const x of field(pid)) {
    const o = oracleOf(x);
    if (/If you would draw a card except the first one you draw in each of your draw steps, draw two cards instead/i.test(o)) {
      if (!exempt) {
        mult *= 2;
        why.push(x);
      }
    } else if (/If you would draw a card, draw two cards instead/i.test(o)) {
      mult *= 2;
      why.push(x);
    }
  }
  return { mult, why };
}

// Timestamps (rule 613.7): permanents get one as they enter; continuous effects get one when they start
export function nextStamp() {
  if (!G.s) return 0;
  G.s.tick = (G.s.tick || 0) + 1;
  return G.s.tick;
}
// "loses all abilities": abilities granted before this are gone, ones granted after it still apply (layer 6)
export function loseAllAbilities(c, until = true) {
  c.lostAbilities = until;
  c.lostAt = nextStamp();
  c.lostGrantsN = (c.grants || []).length;
  c.lostEotN = (c.eotGrants || []).length;
}

export function draw(pid, n = 1, silent = false, opts = {}) {
  // a spell being cast from the top of the library (Mystic Forge) is on the stack, not in the library
  const onStack = new Set([G.s.stack && G.s.stack.iid, G.s.pstack && G.s.pstack.iid, ...(G.s.resolving || [])].filter(Boolean));
  let lib = zoneOf(pid, 'library').filter((i) => !onStack.has(i));
  let drawn = 0;
  for (let k = 0; k < n; k++) {
    lib = zoneOf(pid, 'library').filter((i) => !onStack.has(i));
    if (G.s.phase === 'play' && !opts.noRepl) {
      const r = drawReplacement(pid);
      if (r.deferred) {
        // the draw is replaced; the choice (what to discard / which card to keep) is made right after this effect
        queueEvent({ type: 'replacedDraw', kind: r.deferred, pid, by: r.by.iid });
        continue;
      }
      if (r.blocked) {
        log(pid, `${nameTag(r.blocked)}: ${pid === 'p' ? "you can't" : "the AI can't"} draw more than one card this turn.`);
        continue;
      }
      if (r.stolenBy) {
        log(r.stolenBy, `${nameTag(r.by)}: ${pid === 'p' ? 'you skip that draw' : 'the AI skips that draw'} and ${r.stolenBy === 'p' ? 'you draw' : 'the AI draws'} a card instead.`);
        draw(r.stolenBy, 1, true, { noRepl: true });
        continue;
      }
      if (r.mult > 1) {
        log(pid, `${r.why.map((x) => nameTag(x)).join(', ')}: ${pid === 'p' ? 'you draw' : 'the AI draws'} ${r.mult} cards instead of 1.`);
        drawn += draw(pid, r.mult, true, { noRepl: true });
        continue;
      }
    }
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
      // Laboratory Maniac / Jace, Wielder of Mysteries: "If you would draw a card while your library has no cards in it, you win the game instead."
      const lab = G.s.players[pid].zones.battlefield.map((i) => G.s.cards[i]).find((x) => x && !x.phasedOut && /If you would draw a card while your library has no cards in it, you win the game instead/i.test((DB[x.def].faces[x.face || 0] || {}).oracle || ''));
      if (lab && G.s.phase === 'play') {
        log(pid, `${nameTag(lab)}: ${pid === 'p' ? 'you win' : 'the AI wins'} the game instead of drawing from an empty library!`);
        winGame(pid, nameTag(lab));
        break;
      }
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
  for (const i of ids) if (G.s.cards[i]) G.s.cards[i].fromLibTurn = G.s.turn; // Coram: "put there from libraries this turn"
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
  if (value < before && pl.noLifeLossTurn === G.s.turn) value = before; // Courageous Resolve (fateful hour)
  pl.life = value;
  const ts = G.s.ts && G.s.ts[pid];
  if (ts) {
    if (value < before) {
      ts.lifeLost += before - value;
      // in a pod, the player whose turn it is gets the credit (in 1v1, the other player)
      const by = multiplayer() ? (G.s.active && G.s.active !== pid ? G.s.active : null) : opp(pid);
      if (by && G.s.ts[by]) G.s.ts[by].damagedOpp = true;
      queueEvent({ type: 'lifeLost', pid, amount: before - value, byDamage: !!G.s.damageNow });
      // Start your engines!: speed goes up once on your turn when an opponent loses life
      const o = by || opp(pid);
      const po = G.s.players[o];
      if (G.s.active === o && po.speed > 0 && po.speed < 4 && !G.s.ts[o].speedUp) {
        po.speed++;
        G.s.ts[o].speedUp = true;
        log(o, `${(o === 'p' ? 'Your' : seatNameCap(o) + "'s")} speed increases to ${po.speed}${po.speed === 4 ? ' (max speed)' : ''}.`);
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
  readCache.layerFx = null;
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
  return !!(s && s.slaved && isAI(s.slaved.of) && s.slaved.turn === s.turn);
}
// Sen Triplets: `by` may play lands and cast spells from `of`'s hand this turn
export function handControl(by, of) {
  const s = G.s;
  const h = s && s.handControl;
  return !!(h && h.turn === s.turn && h.by === by && (!of || h.of === of));
}

export function changeLife(pid, delta, reason) {
  // Bilbo, Birthday Celebrant & co.: "If you would gain life, you gain that much life plus 1 instead."
  if (delta > 0 && G.s && G.s.phase === 'play') {
    const plus = cardsIn(pid, 'battlefield').filter((c) => !c.phasedOut && /If you would gain life, you gain that much life plus 1 instead/i.test(oracle(c))).length;
    delta += plus;
    // Rhox Faithmender, Boon Reflection, Alhammarret's Archive: "you gain twice that much life instead" (each one doubles)
    const dbl = cardsIn(pid, 'battlefield').filter((c) => !c.phasedOut && /If you would gain life, you gain twice that much life instead/i.test(oracle(c))).length;
    delta *= 2 ** dbl;
  }
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
  if (G.s.players[pid] && G.s.players[pid].cantLoseTurn === G.s.turn) return true;
  return cardsIn(pid, 'battlefield').some((c) => /You can't lose the game/i.test(oracle(c)));
}

export function loseGame(pid, why) {
  if (G.s && G.s.players[pid] && !G.s.players[pid].lost) queueEvent({ type: 'playerLost', pid }); // Share the Spoils, Ramses
  const pl = G.s.players[pid];
  if (pl.lost || G.s.winner) return;
  pl.lost = why;
  if (!multiplayer()) {
    G.s.winner = opp(pid);
    log('sys', `<b>${pid === 'p' ? 'You lose' : 'The AI loses'}</b> — ${why}.`);
    return;
  }
  G.s.lastLoss = why;
  log('sys', `<b>${pid === 'p' ? 'You lose' : pl.name + ' loses'}</b> — ${why}.`);
  leaveGame(pid);
  const left = livingSeats();
  if (left.length === 1) {
    G.s.winner = left[0];
    log('sys', `<b>${left[0] === 'p' ? 'You win' : G.s.players[left[0]].name + ' wins'}</b> — last player standing.`);
  } else if (pid === 'p') {
    // you're out: the game is over for you (the AI with the most life is shown as the winner)
    G.s.winner = left.slice().sort((a, b) => G.s.players[b].life - G.s.players[a].life)[0];
  }
}
// "You win the game": in a pod every opponent loses
export function winGame(pid, why) {
  if (!multiplayer()) return loseGame(opp(pid), why);
  for (const o of opponents(pid)) loseGame(o, why);
}

// Rule 800.4a: when a player leaves a multiplayer game, everything they own leaves with them, anything of
// theirs someone else controls goes too, and anything of someone else's they control goes back to its owner.
function leaveGame(pid) {
  const s = G.s;
  for (const c of Object.values(s.cards)) {
    if (c.owner === pid) {
      if (c.zone) {
        const z = s.players[c.controller] && s.players[c.controller].zones[c.zone];
        const k = z ? z.indexOf(c.iid) : -1;
        if (k >= 0) z.splice(k, 1);
        const zo = s.players[pid].zones[c.zone];
        const ko = zo ? zo.indexOf(c.iid) : -1;
        if (ko >= 0) zo.splice(ko, 1);
      }
      c.zone = null;
      c.leftGame = true;
      delete c.attachedTo;
    } else if (c.controller === pid && c.zone === 'battlefield') {
      const z = s.players[pid].zones.battlefield;
      z.splice(z.indexOf(c.iid), 1);
      c.controller = c.owner;
      s.players[c.owner].zones.battlefield.push(c.iid);
      c.attacking = false;
      c.blocking = false;
    }
  }
  // auras and equipment left on nothing fall off / go to the graveyard through the normal checks
  for (const c of Object.values(s.cards)) if (c.attachedTo && s.cards[c.attachedTo] && s.cards[c.attachedTo].leftGame) delete c.attachedTo;
  if (s.combat) {
    s.combat.attackers = s.combat.attackers.filter((i) => s.cards[i] && !s.cards[i].leftGame && s.combat.targets[i] !== pid && !(s.cards[s.combat.targets[i]] || {}).leftGame);
    for (const k of Object.keys(s.combat.blocks || {})) s.combat.blocks[k] = s.combat.blocks[k].filter((b) => s.cards[b] && !s.cards[b].leftGame && s.cards[b].controller !== pid);
  }
  // the monarch / initiative passes to the active player (or the next player, if it was their own turn)
  const heir = s.active && s.active !== pid && inGame(s.active) ? s.active : nextSeat(pid);
  if (s.monarch === pid) {
    if (s.monarch !== heir) queueEvent({ type: 'becameMonarch', pid: heir });
    s.monarch = heir;
    log(heir, `${heir === 'p' ? 'You become' : s.players[heir].name + ' becomes'} the monarch.`);
  }
  if (s.initiative === pid) {
    // the new holder takes the initiative properly (and ventures into the Undercity)
    s.initiative = null;
    queueEvent({ type: 'takeInitiative', pid: heir });
  }
  s.delayed = (s.delayed || []).filter((d) => d.pid !== pid && d.controller !== pid);
  s.pool[pid] = [];
}

// Untap step: stun counters and "doesn't untap" effects
export function untapAll(pid) {
  // Endbringer, Seedborn Muse-style: "Untap ~ during each other player's untap step."
  for (const c of seats().filter((k) => k !== pid).flatMap((k) => cardsIn(k, 'battlefield'))) {
    if (!c.tapped || c.phasedOut) continue;
    if (!/Untap (?:~|this [a-z]+|[^.\n]*?) during each other player's untap step/i.test(oracle(c).split(DB[c.def].name).join('~'))) continue;
    if ((c.counters || {}).stun) {
      c.counters.stun--;
      if (!c.counters.stun) delete c.counters.stun;
      continue;
    }
    c.tapped = false;
  }
  for (const c of cardsIn(pid, 'battlefield')) {
    c.sick = false;
    if (!c.tapped) continue;
    if ((c.counters || {}).stun) {
      c.counters.stun--;
      if (!c.counters.stun) delete c.counters.stun;
      continue;
    }
    if (c.noUntapUntil && c.noUntapUntil > G.s.turn) continue;
    if (c.noUntapWhile && G.s.cards[c.noUntapWhile] && G.s.cards[c.noUntapWhile].zone === 'battlefield' && (!c.noUntapWhileCtl || G.s.cards[c.noUntapWhile].controller === c.noUntapWhileCtl)) continue; // Origin of Iron Man, Merchant Raiders
    if (/doesn't untap during (?:your|its controller's) untap step/i.test(oracle(c)) && !/if/i.test(oracle(c).match(/[^.\n]*doesn't untap during[^.\n]*/i)[0])) continue;
    if (c.pacifiedBy && /doesn't untap/i.test(oracle(card(c.pacifiedBy) || c))) continue;
    // Auras: "Enchanted creature doesn't untap during its controller's untap step [unless that player is the monarch]"
    if (Object.values(G.s.cards).some((a) => {
      if (a.zone !== 'battlefield' || a.attachedTo !== c.iid || a.phasedOut) return false;
      const um = oracle(a).match(/Enchanted (?:creature|permanent) doesn't untap during its controller's untap step( unless that player is the monarch)?/i);
      if (!um) return false;
      return um[1] ? G.s.monarch !== c.controller : true;
    })) continue;
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
  if (c.copyNotLegendary) { delete c.notLegendary; delete c.copyNotLegendary; } // Shuri
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
    else if (c.lostAbilities) c.lostEotN = 0; // this turn's granted abilities are gone; next turn's start fresh
    if (c.switchPT === 'eot') delete c.switchPT;
    if (c.layerFx) c.layerFx = c.layerFx.filter((e) => e.until !== 'eot');
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
  // Stilt-Man: 'It gains "This permanent can't be sacrificed" until the end of your next turn.'; Hithlain Rope: "~ can't be sacrificed."
  if ((c.cantSacUntil && G.s.turn <= c.cantSacUntil) || new RegExp(`(?:^|\\n)(?:${(DB[c.def].name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|This (?:permanent|artifact|creature)) can't be sacrificed`, 'i').test(oracle(c))) {
    log(c.controller, `${cardName(c)} can't be sacrificed.`);
    return false;
  }
  queueEvent({ type: 'sacrificed', iid, def: c.def, controller: c.controller, token: c.token, types: typeLine(c) });
  if (G.s.ts && G.s.ts[c.controller]) (G.s.ts[c.controller].sacTypes = G.s.ts[c.controller].sacTypes || []).push(typeLine(c));
  if (G.s.ts && G.s.ts[c.controller]) G.s.ts[c.controller].sacrificed = (G.s.ts[c.controller].sacrificed || 0) + 1;
  move(iid, 'graveyard');
  return true;
}

// State-based actions
export function stateBased() {
  const s = G.s;
  // rule 704.5q: +1/+1 and -1/-1 counters on the same permanent cancel out, however they got there
  // (wither/infect damage, counters added by hand, delayed returns…)
  for (const c of Object.values(s.cards)) {
    const cs = c.counters;
    if (!cs || !(cs['+1/+1'] > 0) || !(cs['-1/-1'] > 0)) continue;
    const k = Math.min(cs['+1/+1'], cs['-1/-1']);
    cs['+1/+1'] -= k;
    cs['-1/-1'] -= k;
    if (!cs['+1/+1']) delete cs['+1/+1'];
    if (!cs['-1/-1']) delete cs['-1/-1'];
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    // Thancred Waters: indestructible for as long as you control Thancred
    for (const c of Object.values(s.cards)) {
      if (c.zone !== 'battlefield' || !c.indestructibleFrom) continue;
      const src = s.cards[c.indestructibleFrom];
      if (!src || src.zone !== 'battlefield' || src.controller !== c.controller) {
        const i = (c.grants || []).indexOf('indestructible');
        if (i >= 0) c.grants.splice(i, 1);
        delete c.indestructibleFrom;
      }
    }
    // "gain control of target creature for as long as ~ remains on the battlefield" (The Akroan War, Old Man of the Sea…)
    for (const c of Object.values(s.cards)) {
      if (c.zone !== 'battlefield' || !c.controlWhile) continue;
      const src = s.cards[c.controlWhile.src];
      const gone = !src || src.zone !== 'battlefield' || (c.controlWhile.youControl && src.controller !== c.controlWhile.by);
      if (gone) {
        const back = c.controlWhile.prev;
        // Opportunistic Dragon: the stolen permanent gets its abilities back and can fight again
        if (c.controlWhile.strip) {
          delete c.lostAbilities;
          if (c.pacifiedBy === c.controlWhile.src) c.pacifiedBy = null;
        }
        delete c.controlWhile;
        if (back && back !== c.controller) {
          move(c.iid, 'battlefield', { controller: back });
          c.zone = 'battlefield';
          log(back, `${nameTag(c)} returns to ${seatPoss(back)} control.`);
          changed = true;
        }
      }
    }
    // auras fall off when what they enchant leaves; equipment just unattaches
    for (const a of Object.values(s.cards)) {
      if (a.zone === 'battlefield' && a.attachedTo && (!s.cards[a.attachedTo] || s.cards[a.attachedTo].zone !== 'battlefield' || s.cards[a.attachedTo].phasedOut)) {
        if (s.cards[a.attachedTo] && s.cards[a.attachedTo].phasedOut) continue;
        a.attachedTo = null;
        if (a.bestowed) {
          // bestow: when what it enchants leaves, it stops being an Aura and stays as a creature
          delete a.bestowed;
          log(a.controller, `${nameTag(a)} is no longer attached and becomes a creature.`);
          changed = true;
          continue;
        }
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
      // layered effects from an Aura that's gone (Frogify, Darksteel Mutation…)
      if (c.layerFx && c.layerFx.some((e) => String(e.until).startsWith('aura:'))) {
        const keep = c.layerFx.filter((e) => {
          if (!String(e.until).startsWith('aura:')) return true;
          const k = String(e.until).slice(5);
          return s.cards[k] && s.cards[k].zone === 'battlefield' && s.cards[k].attachedTo === c.iid;
        });
        if (keep.length !== c.layerFx.length) c.layerFx = keep;
      }
      // the Aura that took its abilities / set its type is gone
      if (String(c.lostAbilities || '').startsWith('aura:')) {
        const k = c.lostAbilities.slice(5);
        if (!s.cards[k] || s.cards[k].zone !== 'battlefield' || s.cards[k].attachedTo !== c.iid) {
          delete c.lostAbilities;
          if (c.auraType && c.auraType.src === k) {
            delete c.auraType;
            delete c.setPT;
          }
        }
      }
    }
    legendRule();
    const died = [];
    for (const pid of seats()) {
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
        const gone = card(c.iid);
        log(c.controller, `${name} ${gone && gone.zone === 'exile' ? 'is exiled instead of dying' : 'dies'}${c.isCommander ? ' (to the command zone)' : ''}.`);
        changed = true;
      }
    }
    // the city's blessing
    for (const pid of seats()) {
      const pl = s.players[pid];
      if (!pl.cityBlessing && cardsIn(pid, 'battlefield').length >= 10 && cardsIn(pid, 'battlefield').some((c) => /\bAscend\b/.test(oracle(c)))) {
        pl.cityBlessing = true;
        log(pid, `${pid === 'p' ? 'You get' : 'The AI gets'} the city's blessing.`);
      }
    }
    for (const pid of seats()) checkLoss(pid);
    if (!changed) break;
  }
}

// ------------------------------------------------------------ legend rule
// The Ring tempts you: how far along its abilities your Ring-bearer is (0 if this creature isn't your Ring-bearer)
export function ringLevel(c) {
  if (!c || !c.ringBearer || c.zone !== 'battlefield' || !G.s) return 0;
  const pl = G.s.players[c.controller];
  return pl && pl.ringBearer === c.iid ? Math.min(4, pl.ring || 0) : 0;
}
export const RING_TEXT = [
  'Your Ring-bearer is legendary and can\'t be blocked by creatures with greater power.',
  'Whenever your Ring-bearer attacks, draw a card, then discard a card.',
  'Whenever your Ring-bearer becomes blocked by a creature, that creature\'s controller sacrifices it at end of combat.',
  'Whenever your Ring-bearer deals combat damage to a player, each opponent loses 3 life.',
];

export function isLegendary(c) {
  if (ringLevel(c) >= 1) return true;
  if (c.notLegendary || c.faceDown) return false;
  return /\bLegendary\b/.test(typeLine(c).split('—')[0]);
}
const oracleOf = (c) => oracle(c);

export function legendViolations() {
  const out = [];
  const field = allBattlefields();
  if (field.some((c) => !c.faceDown && /The "legend rule" doesn't apply\.|The “legend rule” doesn’t apply\./i.test(oracleOf(c)))) return out;
  for (const pid of seats()) {
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
    if (isAI(v.controller)) {
      const cs = v.ids.map((i) => G.s.cards[i]);
      const score = (c) => Object.values(c.counters || {}).reduce((a, b) => a + b, 0) * 2 +
        Object.values(G.s.cards).filter((o) => o.attachedTo === c.iid).length * 3 + v.ids.indexOf(c.iid) * 0.1;
      cs.sort((a, b) => score(b) - score(a));
      for (const c of cs.slice(1)) {
        log(v.controller, `Legend rule: ${seatName(v.controller)} keeps one ${nameTag(c)} and puts the other into the graveyard.`);
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

// "If you would create one or more Treasure tokens, instead create those tokens plus an additional Treasure token." (Xorn, Jolene),
// Worldwalker Helm (artifact tokens → plus a Map), Tippy-Toe (any tokens → plus a Food), Chatterfang (plus that many Squirrels)
function tokenAdditions(defId, pid, n) {
  const d = DB[defId];
  if (!d || !G.s) return { same: 0, other: [] };
  let same = 0;
  const other = [];
  for (const iid of G.s.players[pid].zones.battlefield) {
    const x = G.s.cards[iid];
    if (!x || x.phasedOut || abilitiesGone(x)) continue;
    const o = (DB[x.def].faces[x.face || 0] || {}).oracle || '';
    for (const m of o.matchAll(/If you would create one or more ((?:[A-Za-z]+ )?)tokens?, instead create those tokens plus an additional ([A-Z][a-z]+) token/g)) {
      const kind = m[1].trim().toLowerCase();
      const fits = !kind || (kind === 'artifact' ? /\bArtifact\b/.test(d.typeLine || '') : new RegExp('\\b' + kind + '\\b', 'i').test(d.name + ' ' + (d.typeLine || '')));
      if (!fits) continue;
      if (new RegExp('^' + m[2] + '$', 'i').test(d.name)) same++;
      else other.push({ label: m[2], n: 1 });
    }
    if (/If one or more tokens would be created under your control, those tokens plus that many 1\/1 green Squirrel creature tokens are created instead/i.test(o) && !/^Squirrel$/i.test(d.name)) other.push({ label: 'Squirrel', n, pt: [1, 1], color: 'G' });
  }
  return { same, other };
}

export const TOKEN_CAP = 1000;
export function createToken(defId, pid, n = 1, opts = {}) {
  defId = canonicalToken(defId);
  // Crafty Cutpurse: "each token that would be created under an opponent's control this turn is created under your control instead"
  if (G.s && G.s.cutpurse) { const th = Object.entries(G.s.cutpurse).find(([k, t]) => t === G.s.turn && k !== pid && opponents(pid).includes(k)); if (th) pid = th[0]; }
  // Divine Visitation: "If one or more creature tokens would be created under your control, that many 4/4 white Angel creature
  // tokens with flying and vigilance are created instead."
  if (G.s && DB[defId] && /\bCreature\b/.test((DB[defId].faces[0].typeLine || DB[defId].typeLine || '').split('—')[0])) {
    const dv = cardsIn(pid, 'battlefield').find((c) => !c.phasedOut && /If one or more creature tokens would be created under your control, that many (\d+)\/(\d+) (white|blue|black|red|green) ([A-Z][a-z]+) creature tokens(?: with ([a-z ,]+?))? are created instead/i.test(oracle(c)));
    if (dv) {
      const m = oracle(dv).match(/that many (\d+)\/(\d+) (white|blue|black|red|green) ([A-Z][a-z]+) creature tokens(?: with ([a-z ,]+?))? are created instead/i);
      const col = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[m[3].toLowerCase()];
      const kws = (m[5] || '').split(/,? and |, /).map((x) => x.trim()).filter(Boolean);
      defId = genericTokenDef(+m[1], +m[2], m[4], [col], { keywords: kws });
    }
  }
  const made = [];
  let count = n;
  // several identical triggers resolving as one batch (Scute Swarm ×500): make that many times as many
  if (G.s && G.s.tokenMult > 1) count *= G.s.tokenMult;
  // "…plus an additional …" replacements first, then doublers (the order that gives you the most)
  const add = opts.noDouble || opts.noAdd ? { same: 0, other: [] } : tokenAdditions(defId, pid, n);
  count += add.same;
  if (!opts.noDouble) for (let k = 0; k < repl('tokenDouble', pid); k++) count *= 2;

  // safety valve: Scute Swarm doubling, token loops — stop at TOKEN_CAP tokens per player so the game can't grind to a halt
  const have = G.s ? cardsIn(pid, 'battlefield').filter((c) => c.token).length : 0;
  if (have + count > TOKEN_CAP) {
    const allowed = Math.max(0, TOKEN_CAP - have);
    if (G.s && G.s.tokenCapWarned !== G.s.turn) {
      G.s.tokenCapWarned = G.s.turn;
      log(pid, `Token limit reached: ${seatName(pid)} can have at most ${TOKEN_CAP} tokens, so ${count - allowed} token${count - allowed === 1 ? ' wasn\'t' : "s weren't"} created.`);
    }
    count = allowed;
  }
  for (let k = 0; k < count; k++) {
    const iid = makeCard(defId, pid, null, { token: true, ...(opts.extra || {}) });
    toBattlefield(iid, pid, { tapped: opts.tapped });
    made.push(iid);
  }
  // the additional tokens come after the ones asked for (callers use the first for "it"/"that token")
  for (const o of add.other) {
    const extra = o.pt ? genericTokenDef(o.pt[0], o.pt[1], o.label, o.color) : genericTokenDef(0, 0, o.label);
    createToken(extra, pid, o.n, { noAdd: true, tapped: false });
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

// Inkshield: "For each 1 damage prevented this way, create a 2/1 white and black Inkling creature token with flying."
export function inkshieldFlush() {
  // Selfless Squire: "Whenever damage that would be dealt to you is prevented, put that many +1/+1 counters on this creature."
  const q = (G.s && G.s.preventedQ) || [];
  if (q.length) {
    G.s.preventedQ = [];
    for (const e of q) for (const c of cardsIn(e.pid, 'battlefield')) if (!abilitiesGone(c) && /Whenever damage that would be dealt to you is prevented, put that many \+1\/\+1 counters on/i.test(oracle(c))) { addCounters(c, '+1/+1', e.n); log(e.pid, `${nameTag(c)} gets ${e.n} +1/+1 counter${e.n === 1 ? '' : 's'}.`); }
  }
  const ik = G.s && G.s.inkshield;
  if (!ik || !(ik.n > 0)) return;
  const k = ik.n;
  ik.n = 0;
  createToken(genericTokenDef(2, 1, 'Inkling', ['W', 'B'], { keywords: ['flying'] }), ik.pid, k);
  log(ik.pid, `Inkshield: ${k} Inkling${k === 1 ? '' : 's'}.`);
}

export function attackersTotalPower() {
  const cb = G.s.combat;
  return cb ? cb.attackers.reduce((a, i) => a + Math.max(0, power(card(i))), 0) : 0;
}

export { def };
