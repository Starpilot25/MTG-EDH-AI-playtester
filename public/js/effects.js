// Shared effect engine. Reads rules text sentence by sentence, asks the controller's "chooser" for
// targets and choices, and applies the result. The AI's chooser picks automatically; the player's
// chooser asks through the UI (highlighted targets, card pickers), the way MTG Arena does.
import { DB } from './data.js';
import {
  hasSubtype, isLand, isCreature, isType, oracle, hasKw, power, toughness, cardValue, face, typeLine, colorsOf,
  isProtectedFrom, SECTORS, SECTOR_SIGN, kwCost, payCost, manaValueOf, isPermanentCard, manaAbility, basePT, grantsOf,
} from './rules.js';
import {
  G, card, cardsIn as cardsInZone, zoneOf as zoneOfRaw, move, draw, log, nameTag, changeLife, toBattlefield, createToken, genericTokenDef, namedTokenDef,
  stateBased, shuffle, cardName, opp, addCounters, loseAllAbilities, nextStamp, destroy, sacrifice, discard as discardCard, mill as millCards,
  libTop, queueEvent, winGame, loseGame, esc, makeCard, ringLevel, RING_TEXT, aiSlaved,
} from './state.js';
import { tapPerm } from './state.js';
// A spell being cast stays in its zone until it resolves; effects must not see it in the hand
// (Brainsurge can't put itself back, Windfall doesn't shuffle itself away, "cards in hand" counts exclude it).
// triggers.js's shared hooks (castFree, render…), loaded lazily to avoid a circular import
let T = {};
export function bindTriggerHooks(t) {
  T = t;
}
import('./triggers.js').then((m) => {
  T = m.T;
}).catch(() => {});
let castMod = null;
import('./cast.js').then((m) => {
  castMod = m;
}).catch(() => {});
// Ward: could this player pay the ward cost right now? (so the AI doesn't target into a ward it can't pay)
function wardPayableNow(pid, t) {
  const w = wardCost(t);
  if (!w) return true;
  if (w.n !== undefined) return !castMod || !!payCost(`{${w.n}}`, castMod.manaSources(pid));
  if (w.life !== undefined) return G.s.players[pid].life > w.life + 5;
  if (w.other) return w.other.split(/ or (?=pay |discard |sacrifice |\{)/i).some((x) => wardPartsPayable(pid, t, x));
  return true;
}
export const _wardPayableNow = wardPayableNow;
const onStackIid = (i) => !!(G.s && ((G.s.stack && G.s.stack.iid === i) || (G.s.pstack && G.s.pstack.iid === i) || (G.s.resolving || []).includes(i)));
function cardsIn(pid, z) {
  const out = cardsInZone(pid, z);
  return z === 'hand' ? out.filter((c) => !onStackIid(c.iid)) : out;
}
function zoneOf(pid, z) {
  const out = zoneOfRaw(pid, z);
  return z === 'hand' ? out.filter((i) => !onStackIid(i)) : out;
}
import { countPhrase, kwList, repl } from './statics.js';
import { helpers, damageMods, redirectTarget, playerProtectedFrom, abilitiesGone } from './rules.js';
import { venture, takeInitiative } from './dungeon.js';
import { seats, opponents, isAI, isPlayer, multiplayer, livingSeats, inGame, seatName } from './state.js';
import { nextTurnNumber } from './state.js';
import { joinAttack } from './state.js';
import { goad, goadUntil } from './state.js';
import { leftOf, rightOf, turnOrderFrom } from './state.js';
import { seatNameCap, seatPoss } from './state.js';

const WORDNUM = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, once: 1, twice: 2, thrice: 3,
};
export const n = (w, x = 0) => {
  if (w === undefined || w === null) return 1;
  w = String(w).toLowerCase().trim();
  if (w === 'x') return x;
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return WORDNUM[w] || 1;
};
const NUM = '(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|x|\\d+)';

export class Cancelled extends Error {}

export function costOf(c) {
  const f = face(c);
  return f.manaCost || DB[c.def].manaCost || '';
}

// "your Questing Beast" / "the AI's Questing Beast", always from the human's point of view
export function whose(c) {
  return (c.zone === 'battlefield' ? c.controller : c.owner) === 'p' ? 'your' : "the AI's";
}
export const who = (pid) => (pid === 'p' ? 'you' : seatName(pid));
// a seat's name for a menu option: "The AI" in 1v1, "AI 2" in a pod
const seatLabel = (pid) => (pid === 'p' ? 'You' : multiplayer() ? seatName(pid) : 'The AI');
const s_ = (pid, verb) => (isAI(pid) ? verb + 's' : verb);
const ctl = (c) => (c.zone === 'battlefield' ? c.controller : c.owner);

// ------------------------------------------------------------ text helpers
export function stripName(text, c) {
  // Sarkhan, Soul Aflame as a copy of Ureni: it keeps its own name, but the copied text still says "Ureni"
  if (c && c.nameOverride && DB[c.def] && c.nameOverride !== DB[c.def].name) text = stripName(text, { ...c, nameOverride: null });
  const name = cardName(c);
  // whole words only: "Ginger" must not eat the start of "Gingerbrute"
  const esc_ = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = (x) => new RegExp('(?<![A-Za-z])' + esc_(x) + '(?![A-Za-z])', 'g');
  let t = String(text || '').replace(word(name), '~');
  const short = name.split(',')[0];
  if ((short.length > 3 || (short.length === 3 && /^[A-Z][a-z]+$/.test(short) && c && DB[c.def] && /Legendary/.test(DB[c.def].typeLine || ''))) && short !== name) t = t.replace(word(short), '~'); // "Bob" too
  // "Gríma, Saruman's Footman" is written "Grima" in its own text
  const plain = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (plain(short) !== short && short.length > 3) t = t.replace(word(plain(short)), '~').replace(word(plain(name)), '~');
  // legends called by their first name: "Ureni of the Unwritten" → "Ureni", "Thrakkus the Butcher" → "Thrakkus"
  else if (short === name && c && DB[c.def] && /Legendary/.test(DB[c.def].typeLine || '')) {
    const fm = name.match(/^([A-Z][\w'-]{2,}) (?:of|the|from|and)\b/);
    if (fm) t = t.replace(new RegExp('\\b' + fm[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b(?! (?:of|the|from|and)\\b)', 'g'), '~');
  }
  // Star Trek-style: "Dr. Beverly Crusher" is "Dr. Crusher" in its own text
  {
    const w = short.split(' ');
    if (w.length >= 3) {
      const alt = `${w[0]} ${w[w.length - 1]}`;
      if (alt.length > 5) t = t.replace(word(alt), '~');
    }
  }
  return t
    .replace(/\bthis (creature|artifact|enchantment|permanent|land|card|Aura|Equipment|Vehicle|spell|Saga|Class|Case|planeswalker|battle|Spacecraft|Room)\b/gi, "~")
    .replace(/[“”]/g, '"')
    .replace(/’/g, "'");
}

const KEYWORD_LINE = /^(Kicker|Multikicker|Flashback|Buyback|Cycling|(?:Basic )?\w+cycling|Teamwork|Dredge|Escape|Overload|Entwine|Foretell|Madness|Retrace|Jump-start|Splice|Replicate|Conspire|Evoke|Dash|Blitz|Bestow|Mutate|Prototype|Disturb|Encore|Unearth|Embalm|Eternalize|Scavenge|Ninjutsu|Commander ninjutsu|Transmute|Forecast|Suspend|Morph|Megamorph|Disguise|Echo|Cumulative upkeep|Fading|Vanishing|Emerge|Surge|Spectacle|Prowl|Awaken|Aftermath|Fuse|Plot|Offspring|Gift|Bargain|Casualty|Squad|Cleave|Freerunning|Impending|Warp|Mayhem|Harmonize|Web-slinging|Sneak|Spree|Tiered|Escalate|Affinity|Convoke|Delve|Improvise|Assist|Undaunted|Split second|Storm|Cascade|Rebound|Ripple|Gravestorm|Epic|Cipher|Hideaway|Miracle|Channel|Bloodrush|Reinforce|Level up|Outlast|Reconfigure|Crew|Saddle|Station|Craft|Equip|Fortify|Ward|Companion|Partner|Choose a Background|Read ahead|More Than Meets the Eye|Living metal|Enlist|Training|Backup|Toxic|Squad|Devoid|Changeling|Ingest|Myriad|Melee|Skulk|Menace|Flash|Haste|Vigilance|Trample|Reach|Flying|Lifelink|Deathtouch|First strike|Double strike|Defender|Hexproof|Shroud|Indestructible|Infect|Wither|Prowess|Exalted|Persist|Undying|Afterlife|Riot|Decayed|Annihilator|Afflict|Bushido|Rampage|Flanking|Provoke|Renown|Dethrone|Evolve|Extort|Exploit|Fabricate|Devour|Modular|Graft|Soulshift|Bloodthirst|Amplify|Sunburst|Tribute|Unleash|Frenzy|Horsemanship|Shadow|Fear|Intimidate|Banding|Phasing|Mobilize|Exhaust|Max speed|Start your engines|Job select|Daybound|Nightbound|Compleated|Ravenous|For Mirrodin|Living weapon|Umbra armor|Totem armor|Poisonous|Absorb|Frenzy|Ascend|Mentor|Haunt|Champion|Changeling|Battle cry|Soulbond|Totem)\b/i;

export function etbText(c) {
  const t = joinBullets(stripName(oracle(c), c).replace(/\([^)]*\)/g, ''));
  const out = [];
  for (const m of t.matchAll(/(?:^|\n)(?:[A-Z][A-Za-z' ]{2,30} — )?When(?:ever)? ~ enters?(?: the battlefield)?(?: or [^,]+?)?(?: under your control)?,([^\n]+)/g))
    out.push(unjoin(m[1].trim()));
  return out.join('\n');
}

export function spellText(c) {
  // Jeska's Will & co.: "Choose one. If you control a commander as you cast this spell, you may choose both."
  const cmdr = G.s && c.controller && cardsIn(c.controller, 'battlefield').some((x) => x.isCommander);
  let o = stripName(oracle(c), c);
  // Spree: "Spree (Choose one or more additional costs.)\n+ {2} — …\n+ {B}{B} — …" works like "Choose one or more —" with a cost on each mode
  if (/(?:^|\n)Spree\b/.test(o)) o = o.replace(/(^|\n)Spree\b[^\n]*/, '$1Choose one or more —').replace(/(^|\n)\+\s*((?:\{[^}]+\})+)\s*—\s*/g, '$1• +$2 — ');
  return o
    .replace(/Choose one\. If you control a commander as you cast (?:this spell|~), you may choose both(?: instead)?\.\s*/i, cmdr ? 'Choose one or both —\n' : 'Choose one —\n')
    .replace(/\([^)]*\)/g, '')
    .split('\n')
    .filter((l) => l.trim() && !KEYWORD_LINE.test(l.trim()) && !/^(As an additional cost|You may pay [^.]* rather than pay|This spell costs|~ costs|You may cast ~|Spend only|This spell can't be countered|~ can't be countered|When you cast ~|When you cycle ~|Split second|Cast ~ only|Cast this spell only|Strive|Kicker|Flash$)/i.test(l.trim()))
    .join('\n');
}

// Activated abilities on a permanent ("{2}, {T}: Draw a card.", loyalty, equip, crew, level up…)
// Modal abilities put each "•" choice on its own line; keep them with the line that says "choose one —".
export function joinBullets(text) {
  return String(text || '').replace(/\n(?=•)/g, ' ¶');
}
export const unjoin = (t) => String(t || '').replace(/ ¶•/g, '\n•');
export function activatedAbilities(c) {
  // it lost all abilities: none of its own activated abilities (Rooms' unlocking and prepared copies are game rules, not abilities)
  let t = (c.lostAbilities || (c.zone === 'battlefield' && abilitiesGone(c))) && !c.becameTreasure ? '' : joinBullets(stripName(oracle(c), c).replace(/\([^)]*\)/g, ''));
  // Karn, Living Legacy's emblem: "Tap an untapped artifact you control: This emblem deals 1 damage to any target." —
  // offered on each of your untapped artifacts (tapping it is the cost, so summoning sickness doesn't matter)
  const emblemLines = [];
  if (c.zone === 'battlefield' && G.s && c.controller && isType(c, 'Artifact')) {
    for (const e of G.s.players[c.controller].emblems || []) {
      const em = e.match(/^Tap an untapped artifact you control: (.+)$/i);
      if (em) {
        const line = `{T}: ${em[1].replace(/^This emblem /i, '~ ')}`;
        emblemLines.push(line);
        t = (t ? t + '\n' : '') + line;
      }
    }
  }
  const out = [];
  // Prepared (Secrets of Strixhaven): "While it's prepared, you may cast a copy of its spell. Doing so unprepares it."
  if (c.zone === 'battlefield' && c.prepared && DB[c.def].faces[1] && !/Room/.test(DB[c.def].faces[1].typeLine || '')) {
    const f1 = DB[c.def].faces[1];
    out.push({ kind: 'prepared', mana: f1.manaCost || '', text: `Cast a copy of ${f1.name}`, raw: 'prepared', costText: f1.manaCost || '{0}', instant: /Instant/.test(f1.typeLine || ''), sorcery: !/Instant/.test(f1.typeLine || '') });
  }
  // Rooms: "As a sorcery, you may pay the mana cost of a locked door to unlock it." (a special action, no stack)
  if (c.zone === 'battlefield' && c.unlocked && DB[c.def].faces.length === 2) {
    DB[c.def].faces.forEach((f, k) => {
      if (!c.unlocked[k]) out.push({ kind: 'unlock', door: k, mana: f.manaCost || '', text: `Unlock ${f.name}`, raw: `Unlock ${f.name}`, costText: f.manaCost || "{0}", sorcery: true });
    });
  }
  for (const raw of t.split('\n')) {
    // "Exhaust — {4}: …" (activate only once): parse the ability after the label
    let line = raw.trim().replace(/^Exhaust\s*[—-]\s*/i, '');
    // ability words in front of an activated ability: "Displacement — {3}{U}: Return ~ to its owner's hand."
    {
      const aw = line.match(/^([A-Z][\w' -]{2,30}?) — (?=\{|(?:Sacrifice|Tap|Remove|Pay|Discard|Exile|Return|Put)\b[^:]*:)/);
      if (aw && !KEYWORD_LINE.test(aw[1]) && /:/.test(line)) line = line.slice(aw[0].length);
    }
    const loyal = line.match(/^([+−\-]?\d+|0|[+−\-]X):\s*(.+)$/);
    if (loyal && isType(c, 'Planeswalker')) {
      out.push({ kind: 'loyalty', cost: /X/.test(loyal[1]) ? 0 : parseInt(loyal[1].replace('−', '-'), 10) || 0, label: loyal[1], text: unjoin(loyal[2]), raw: line, x: /X/.test(loyal[1]) });
      continue;
    }
    let m;
    if ((m = line.match(/^Equip(?: ([^{—]+?))?(?: |—)((?:\{[^}]+\})+)/))) {
      out.push({ kind: 'equip', mana: m[2], filter: (m[1] || '').trim(), text: '', raw: line, sorcery: true });
      continue;
    }
    if ((m = line.match(/^Craft with (.+?) ((?:\{[^}]+\})+)/))) {
      const what = m[1].toLowerCase();
      const nm = what.match(/^(an?|one|two|three|four|five|six|\w+) (or more )?(.+)$/);
      const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
      out.push({ kind: 'craft', mana: m[2], min: nm ? words[nm[1]] || 1 : 1, more: !!(nm && nm[2]), filter: (nm ? nm[3] : what).replace(/s\b/g, ''), text: '', raw: line, sorcery: true });
      continue;
    }
    if ((m = line.match(/^Reconfigure ((?:\{[^}]+\})+)/))) {
      out.push({ kind: 'reconfigure', mana: m[1], text: '', raw: line, sorcery: true });
      continue;
    }
    if ((m = line.match(/^Crew (\d+)/))) {
      out.push({ kind: 'crew', n: +m[1], text: '', raw: line });
      continue;
    }
    if ((m = line.match(/^Saddle (\d+)/))) {
      out.push({ kind: 'saddle', n: +m[1], text: '', raw: line, sorcery: true });
      continue;
    }
    if (/^Station\b/.test(line)) {
      out.push({ kind: 'station', text: '', raw: line, sorcery: true });
      continue;
    }
    if ((m = line.match(/^Level up ((?:\{[^}]+\})+)/))) {
      out.push({ kind: 'levelup', mana: m[1], text: '', raw: line, sorcery: true });
      continue;
    }
    if ((m = line.match(/^Outlast ((?:\{[^}]+\})+)/))) {
      out.push({ kind: 'ability', tap: true, mana: m[1], costText: `${m[1]}, {T}`, text: 'Put a +1/+1 counter on ~.', raw: line, sorcery: true });
      continue;
    }
    if ((m = line.match(/^((?:\{[^}]+\})+): Level (\d+)/))) {
      if ((c.classLevel || 1) + 1 === +m[2]) out.push({ kind: 'classlevel', mana: m[1], level: +m[2], text: '', raw: line, sorcery: true });
      continue;
    }
    if ((m = line.match(/^Fortify ((?:\{[^}]+\})+)/))) continue;
    m = line.match(/^((?:[^:"]|"[^"]*"){1,120}?):\s*(.+)$/);
    if (!m) continue;
    const cost = m[1];
    if (/^(Level|STATION|LEVEL|Max speed|Companion|Chapter|[IVX]+(?:, [IVX]+)*) /.test(cost) || /—/.test(cost)) continue;
    if (!/\{|Sacrifice|Discard|Pay|Remove|Exile|Tap|Return|Put|Collect evidence|Forage|Exert/i.test(cost)) continue;
    // Strionic Resonator & co. are used from the prompt that appears while your ability is on the stack
    if (/^Copy target (?:activated or )?triggered ability you control/i.test(m[2])) continue;
    if (/^Add\b/.test(m[2]) && !/\bfor each\b|\bX\b/.test(m[2])) {
      // mana abilities are paid automatically, except odd ones the player may want by hand
      if (!/Sacrifice|Pay|Remove/i.test(cost)) continue;
    }
    out.push({
      kind: 'ability',
      tap: /\{T\}/.test(cost),
      untap: /\{Q\}/.test(cost),
      sac: /Sacrifice ~|Sacrifice this/i.test(cost),
      sacOther: (cost.match(/Sacrifice (an?|two|three|\d+|another) ([^,]+?)(?:,|$)/i) || null),
      tapOther: (cost.match(/Tap (an?|one|two|three|four|five|\d+) untapped ([^,]+?)(?:,|$)/i) || null),
      discardN: (cost.match(/Discard (a|two|\d+) cards?/i) || [])[1],
      exert: /Exert ~/i.test(cost),
      removeCounters: cost.match(/Remove (a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+|X) (?:([+-]\d+\/[+-]\d+|\w+) )?counters? from ~/i), // no kind: any counters (Ghost-Spider)
      putCounters: cost.match(/Put (a|an|one|two|three|\d+) ([+-]\d+\/[+-]\d+|[a-z]+) counters? on ~/i), // Mazemind Tome: "Put a page counter on ~"
      payLife: (cost.match(/Pay (\d+) life/i) || [])[1] || (/Pay life equal to the number of colors in your commanders?'? color identity/i.test(cost) ? 'identity' : undefined),
      payEnergy: (cost.match(/Pay (\w+) \{E\}/i) && WORDNUM[cost.match(/Pay (\w+) \{E\}/i)[1].toLowerCase()]) || (cost.match(/Pay (\d+) \{E\}/i) || [])[1] * 1 || (cost.match(/\{E\}/g) || []).length, // "Pay six {E}"
      exileFromGy: cost.match(/Exile (a|two|three|\d+|X) (?:other )?(?:([a-z]+) )?cards? from your graveyard/i),
      collectEvidence: (cost.match(/Collect evidence (\d+)/i) || [])[1],
      forage: /Forage/i.test(cost),
      returnToHand: /Return ~ to its owner's hand/i.test(cost),
      exileSelf: /(?:^|, )Exile (?:~|this card)(?: from your graveyard)?(?:,|$)/i.test(cost), // Renew, Scavenge-style costs
      mana: (cost.match(/\{(?!T\}|Q\}|E\})[^}]+\}/g) || []).join(''),
      costText: cost,
      text: unjoin(m[2]),
      raw: line,
      sorcery: /Activate only as a sorcery/i.test(m[2]),
      once: /Activate only once each turn|Activate this ability only once each turn/i.test(m[2]) || /^\s*Exhaust\b/i.test(raw),
      exhaust: /^\s*Exhaust\b/i.test(raw),
    });
    // Baru, Wurmspeaker: "This ability costs {X} less to activate, where X is the greatest power among Wurms you control."
    const ab = out[out.length - 1];
    const red = ab.text.match(/\s*This ability costs \{(X|\d+)\} less to activate(?:, where X is ([^.]+))?\.?/i);
    if (red) {
      ab.text = ab.text.replace(red[0], '').trim();
      const k = red[1] === 'X' ? (G.s && c.controller ? countPhrase(c.controller, red[2] || '', helpers, c.iid) || 0 : 0) : +red[1];
      const syms = ab.mana.match(/\{[^}]+\}/g) || [];
      const gen = syms.filter((x) => /^\{\d+\}$/.test(x)).reduce((a, x) => a + +x.slice(1, -1), 0);
      const rest = syms.filter((x) => !/^\{\d+\}$/.test(x)).join('');
      const g = Math.max(0, gen - k);
      ab.mana = (g ? `{${g}}` : '') + rest;
      if (k) ab.costText = ab.costText.replace(/^(?:\{[^}]+\})+/, ab.mana || '{0}');
    }
  }
  for (const ab of out) if (emblemLines.includes(ab.raw)) { ab.ignoreSick = true; ab.fromEmblem = true; }
  return out;
}

// Abilities usable from the hand or graveyard (cycling, ninjutsu, channel, unearth, embalm…)
export function zoneAbilities(c) {
  const t = stripName(oracle(c), c).replace(/\([^)]*\)/g, '');
  const out = [];
  let m;
  for (const raw of t.split('\n')) {
    const line = raw.trim();
    if (c.zone === 'hand') {
      if ((m = line.match(/^((?:basic )?\w*)cycling ((?:\{[^}]+\})+)/i))) out.push({ kind: 'cycling', type: m[1].toLowerCase().trim(), mana: m[2], label: `${m[1] ? m[1] + 'cycling' : 'Cycling'} ${m[2]}` });
      else if ((m = line.match(/^Cycling—(.+)$/i))) out.push({ kind: 'cycling', type: '', mana: '', other: m[1], label: `Cycling—${m[1]}` });
      if ((m = line.match(/^(Commander )?Ninjutsu ((?:\{[^}]+\})+)/i))) out.push({ kind: 'ninjutsu', mana: m[2], label: `Ninjutsu ${m[2]}` });
      if ((m = line.match(/^Channel — ((?:\{[^}]+\})*),? ?Discard ~: (.+)$/i))) out.push({ kind: 'channel', mana: m[1], text: m[2], label: `Channel ${m[1]}` });
      if ((m = line.match(/^Bloodrush — ((?:\{[^}]+\})+), Discard ~: (.+)$/i))) out.push({ kind: 'channel', mana: m[1], text: m[2], label: `Bloodrush ${m[1]}` });
      // Magma Opus: "{U/R}{U/R}, Discard ~: Create a Treasure token."
      if ((m = line.match(/^((?:\{[^}]+\})+), Discard ~: (.+)$/i))) out.push({ kind: 'channel', mana: m[1], text: m[2], label: `Discard: ${m[2].replace(/\.$/, '')}` });
      if ((m = line.match(/^Transmute ((?:\{[^}]+\})+)/i))) out.push({ kind: 'transmute', mana: m[1], label: `Transmute ${m[1]}`, sorcery: true });
      if ((m = line.match(/^Reinforce (\d+)—((?:\{[^}]+\})+)/i))) out.push({ kind: 'reinforce', n: +m[1], mana: m[2], label: `Reinforce ${m[1]}` });
      if ((m = line.match(/^Forecast — ((?:\{[^}]+\})+), Reveal ~[^:]*: (.+)$/i))) out.push({ kind: 'forecast', mana: m[1], text: m[2], label: `Forecast ${m[1]}` });
      if ((m = line.match(/^Foretell ((?:\{[^}]+\})+)/i))) out.push({ kind: 'foretell', mana: '{2}', later: m[1], label: 'Foretell (pay {2}, exile face down)' });
      if ((m = line.match(/^Plot ((?:\{[^}]+\})+)/i))) out.push({ kind: 'plot', mana: m[1], label: `Plot ${m[1]}`, sorcery: true });
      if ((m = line.match(/^Suspend (\d+)—((?:\{[^}]+\})+)/i))) out.push({ kind: 'suspend', n: +m[1], mana: m[2], label: `Suspend ${m[1]} — ${m[2]}` });
    }
    if (c.zone === 'graveyard') {
      if ((m = line.match(/^Unearth ((?:\{[^}]+\})+)/i))) out.push({ kind: 'unearth', mana: m[1], label: `Unearth ${m[1]}`, sorcery: true });
      if ((m = line.match(/^Embalm ((?:\{[^}]+\})+)/i))) out.push({ kind: 'embalm', mana: m[1], label: `Embalm ${m[1]}`, sorcery: true });
      if ((m = line.match(/^Eternalize ((?:\{[^}]+\})+)/i))) out.push({ kind: 'eternalize', mana: m[1], label: `Eternalize ${m[1]}`, sorcery: true });
      if ((m = line.match(/^Scavenge ((?:\{[^}]+\})+)/i))) out.push({ kind: 'scavenge', mana: m[1], label: `Scavenge ${m[1]}`, sorcery: true });
      if ((m = line.match(/^Encore ((?:\{[^}]+\})+)/i))) out.push({ kind: 'encore', mana: m[1], label: `Encore ${m[1]}`, sorcery: true });
      if ((m = line.match(/^Dredge (\d+)/i))) out.push({ kind: 'dredge', n: +m[1], label: `Dredge ${m[1]} (instead of your next draw)` });
      if ((m = line.match(/^Recover ((?:\{[^}]+\})+)/i))) void m;
    }
  }
  // Renew, Project Deathlok Soldier: activated abilities that work from the graveyard ("{2}{B}: Return this card from your graveyard to your hand")
  if (c.zone === 'graveyard') {
    const short = cardName(c).split(',')[0];
    for (const ab of activatedAbilities(c)) {
      if (ab.kind !== 'ability' || !/(?:~|this card) from your graveyard/i.test(`${ab.costText} ${ab.text}`)) continue;
      out.push({ kind: 'gyAbility', ab, mana: ab.mana, sorcery: ab.sorcery, label: `${ab.costText}: ${ab.text}`.replace(/~/g, short).replace(/\s*Activate only as a sorcery\./i, '') });
    }
  }
  return out;
}

// ------------------------------------------------------------ targeting filters
export function canTarget(c, casterPid, src) {
  if (!c || c.phasedOut) return false;
  if (hasKw(c, 'shroud')) return false;
  const theirs = ctl(c) !== casterPid;
  if (theirs && hasKw(c, 'hexproof')) return false;
  if (theirs) {
    for (const g of [...(c.grants || []), ...(c.eotGrants || [])]) if (/^hexproof from/.test(g) && src && isProtectedFrom({ ...c, grants: [g.replace('hexproof', 'protection')] }, src)) return false;
    const hm = oracle(c).match(/Hexproof from (\w+)/i);
    if (hm && src && isProtectedFrom({ ...c, grants: ['protection from ' + hm[1].toLowerCase()] }, src)) return false;
  }
  if (src && isProtectedFrom(c, src)) return false;
  return true;
}

const COLOR_WORDS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
// "creature or artifact", "artifact, creature, or enchantment"
export function matchesAny(c, phrase) {
  const p = String(phrase || '').toLowerCase().replace(/\b(creature|artifact|enchantment|land|planeswalker|permanent|token|card|battle)s\b/g, '$1');
  if (!/,| or /.test(p)) return matchesFilter(c, p);
  const parts = p.split(/,? or |, /).map((x) => x.trim()).filter(Boolean);
  // "nontoken creature or artifact": shared adjectives apply to the first part only
  return parts.some((x) => matchesFilter(c, x));
}
// Every subtype in the game (creature types, artifact/land/enchantment/spell subtypes), lowercase → proper case.
const SUBTYPES = new Map('Abyss Adventure Advisor Aetherborn Ajani Alara Alfava Alien Ally Aminatou Amonkhet Amsterdam Andorian Androzani Angel Angrath Antausia Antelope Apalapucia Ape Arcane Arcavios Archer Archon Arkhos Arlinn Armadillo Armored Artificer Arzakon Ashiok Assassin Assembly-Worker Astartes Asylum Atog Attraction Aura Aurochs Avatar Avishkar Azgol Azra Background Badger Bahamut Barbarian Bard Basilisk Basri Bat Bear Beast Beaver Beeble Beholder Belenon Berserker Bird Bison Boar Bobblehead Bolas Bolas\'s Book Borg Brainiac Bringer Brushwagg C\'tan Caitian Calix Camel Capenna Capybara Carrier Cartouche Case Cat Cave Centaur Chandra Chef Chicago Child Chimera Chorus Citizen Clamfolk Class Cleric Clown Clue Cockatrice Comet Construct Contraption Cow Coward Coyote Crab Cridhe Crocodile Curse Custodes Cyberman Cyborg Cyclops Dack Dakkon Dalek Daretti Darillium Dauthi Davriel Deb Dellian Demigod Demon Desert Detective Devil Dihada Dinosaur Djinn Doctor Dog Dominaria Domri Dovin Dragon Drake Dreadnought Drix Drone Druid Dryad Duck Duskmourn Dwarf Dyfed Earth Echidna Echoir Efreet Egg Elder Eldraine Eldrazi Elemental Elephant Elf Elk Ellywick Elminster Elspeth Employee Equilor Equipment Ergamon Ersta Estrid Eternal Eye Fabacin Faerie Feroz Ferret Fiora Fish Flagbearer Food Forest Fortification Fox Fractal Freyalise Frog Fungus Gallifrey Gamer Gamma Gargantikar Gargoyle Garruk Gate Giant Gideon Giraffe Gith Glimmer Gnoll Gnome Goat Gobakhan Goblin God Golem Gorgon Gorn Greensleeves Gremlin Griffin Grist Guest Guff Hag Halfling Hamster Harpy Hedgehog Hell Hellion Hero Hippo Hippogriff Homarid Homunculus Horror Horse Horsehead Huatli Human Hydra Hyena Ikoria Illusion Imp Incarnation Infinity Inhuman Inkling Innistrad Inquisitor Insect Inzerva Iquatana Ir Island Ixalan Jace Jackal Jared Jaya Jellyfish Jeska Judge Juggernaut Junction Kaito Kaldheim Kamigawa Kandoka Kangaroo Karn Karsus Kasmina Kavu Kaya Kelpien Kephalai Key Killbot Kinshala Kiora Kirin Kithkin Klingon Knight Kobold Kolbahan Kor Koth Kraken Kree Kylem Kyneth Lair Lamia Lammasu Lanthanite Las Leech Lemur Lesson Leviathan Lhurgoyf Library Licid Liliana Lizard Lobster Locus Lolth Lord Lorwyn Lukka Luvion MagicCon Mammoth Manticore Mars Master Masticore Meditation Mercadia Mercenary Merfolk Metathran Metraxis Mine Minion Minor Minotaur Minsc Mirrodin Mite Moag Mole Monger Mongoose Mongseng Monk Monkey Monopoly Moogle Moon Moonfolk Mordenkainen Mount Mountain Mouse Muraganda Mutant Mutter\'s Myr Mystic Nahiri Narset Nautilus Nebula Necron Necros Nephilim New Nightmare Nightstalker Niko Ninja Nissa Nixilis Noble Noggle Nomad Nymph Octopus Officer Ogre Oko Omen Omenpath Ooze Orc Orgg Orion Otter Ouphe Outside Ox Oyster Pangolin Peasant Pegasus Performer Pest Phelddagrif Phoenix Phyrexia Phyrexian Pilot Pirate Plains Plan Planet Plant Platypus Porcupine Possum Power-Plant Powerstone Praetor Primarch Processor Pyrulea Qu Quintorius Rabbit Rabiah Raccoon Ral Ranger Rat Rath Ravnica Realm Rebel Reflection Regatha Rhino Rigger Robot Rogue Room Rowan Rune Sable Saga Saheeli Salamander Samurai Samut Sand Saproling Sarkhan Satyr Scarecrow Scientist Scorpion Scout Seal Segovia Serpent Serra Serra\'s Shade Shadowmoor Shaman Shandalar Shapeshifter Shark Sheep Shenmeng Shi\'ar Shrine Siege Sifa Siren Sivitri Skaro Skeleton Skrull Skunk Slith Sliver Sloth Slug Snail Snake Soldier Soltari Sorcerer Sorin Spacecraft Spawn Specter Spellshaper Sphere Sphinx Spider Spike Spiral Spirit Sponge Spy Squid Squirrel Starfish Stickers Stone Surrakar Survivor Svega Swamp Symbiote Synth Szat Talosian Tamiyo Tarkir Tasha Teferi Tellarite Teyo Tezzeret Thalakos The Theros Tholian Thomil Thopter Thrull Thunder Tibalt Tiefling Time Tosk Tower Town Toy Trap Treasure Treefolk Trenzalore Trilobite Troll Turtle Tyranid Tyvar Ugin Ulgrotha Unicorn Unknown Urza Urza\'s Utrom Valla Vampire Varmint Vedalken Vegas Vehicle Venser Villain Vivien Volver Vorta Vraska Vronos Vryn Vulcan Wall Walrus Warlock Warrior Weasel Weird Werewolf Whale Wildfire Will Windgrace Wizard Wolf Wolverine Wombat Worm Worzel Wraith Wrenn Wurm Xenagos Xerex Xindi Yanggu Yanling Yeti You Zariel Zendikar Zhalfir Zombie Zubera'.split(' ').map((t) => [t.toLowerCase(), t]));
const PLURAL_SUB = { elves: 'elf', dwarves: 'dwarf', wolves: 'wolf', mice: 'mouse', fungi: 'fungus', octopi: 'octopus', leeches: 'leech', foxes: 'fox', sphinxes: 'sphinx', lynxes: 'lynx', ox: 'ox', oxen: 'ox', homunculi: 'homunculus', djinn: 'djinn', allies: 'ally', faeries: 'faerie', zombies: 'zombie' };
const NOT_SUBTYPE = new Set(['will', 'time', 'power', 'case', 'class', 'role', 'shard', 'lesson', 'trap', 'book', 'house', 'cave', 'town', 'sphere', 'host', 'mount', 'door',
  'you', 'your', 'the', 'a', 'an', 'it', 'its', 'of', 'or', 'and', 'he', 'she', 'they', 'their', 'all', 'each', 'other', 'another', 'one', 'two', 'three', 'target', 'toughness',
  'card', 'control', 'with', 'without', 'that', 'this', 'from', 'into', 'on', 'in', 'to', 'up', 'any', 'more', 'less', 'greater', 'mana', 'value', 'counter', 'token', 'number',
  'named', 'same', 'color', 'type', 'chosen', 'modified', 'legendary', 'basic', 'enchanted', 'equipped', 'attacking', 'blocking', 'tapped', 'untapped', 'spell', 'ability', 'player',
  'opponent', 'life', 'turn', 'damage', 'combat', 'graveyard', 'hand', 'library', 'battlefield', 'top', 'bottom', 'x', 'flying', 'first', 'double', 'strike', 'equal', 'least']);
export function subtypeWords(phrase) {
  const out = [];
  for (const raw of String(phrase).toLowerCase().split(/[^a-z'-]+/)) {
    if (!raw) continue;
    const cands = [PLURAL_SUB[raw], raw, raw.replace(/ies$/, 'y'), raw.replace(/es$/, ''), raw.replace(/s$/, '')].filter(Boolean);
    for (const w of cands) {
      if (SUBTYPES.has(w) && (!NOT_SUBTYPE.has(w) || (w === 'mount' && /\bmounts?\b/.test(phrase) && !/\bmount(?:ed|ing)\b/.test(phrase)) || (w === 'case' && /\bcases?\b/.test(phrase)) || (w === 'class' && /\bclass(?:es)?\b/.test(phrase)) || (w === 'role' && /\broles?\b/.test(phrase)))) {
        out.push(SUBTYPES.get(w));
        break;
      }
    }
  }
  return [...new Set(out)];
}
export function matchesFilter(c, phrase) {
  phrase = phrase.toLowerCase();
  let m0;
  const d = DB[c.def];
  for (const m of phrase.matchAll(/non-?(\w+)/g)) {
    const w = m[1];
    if (COLOR_WORDS[w] && colorsOf(c).includes(COLOR_WORDS[w])) return false;
    if (['artifact', 'creature', 'land', 'legendary', 'token', 'enchantment', 'planeswalker', 'basic', 'human', 'angel', 'demon', 'dragon', 'elf', 'zombie', 'wall', 'snow'].includes(w)) {
      if (w === 'token' ? c.token : w === 'legendary' ? /Legendary/.test(typeLine(c)) : w === 'basic' ? /Basic/.test(typeLine(c)) : new RegExp(w, 'i').test(typeLine(c))) return false;
    }
  }
  for (const [w, col] of Object.entries(COLOR_WORDS)) {
    if (new RegExp('(?<!non-?)\\b' + w + '\\b').test(phrase) && !/(?:white|blue|black|red|green) (?:or|and\/or) (?:white|blue|black|red|green)/.test(phrase) && !colorsOf(c).includes(col)) return false;
  }
  if (/\btapped\b/.test(phrase) && !/untapped/.test(phrase) && !c.tapped) return false;
  if (/\buntapped\b/.test(phrase) && c.tapped) return false;
  if (/\battacking or blocking\b/.test(phrase)) {
    if (!c.attacking && !c.blocking) return false;
  } else {
    if (/\battacking\b/.test(phrase) && !c.attacking) return false;
    if (/\bblocking\b/.test(phrase) && !c.blocking) return false;
  }
  if (/\bmodified\b/.test(phrase) && !/unmodified/.test(phrase) && !isModified(c)) return false;
  if (/\btoken\b/.test(phrase) && !/nontoken/.test(phrase) && !c.token) return false;
  if (/\blegendary\b/.test(phrase) && !/nonlegendary/.test(phrase) && !/Legendary/.test(typeLine(c)) && !ringLevel(c)) return false;
  if (/with flying/.test(phrase) && !hasKw(c, 'flying')) return false;
  // Duskana: "with base power and toughness 2/2"
  if ((m0 = phrase.match(/base power and toughness (\d+)\/(\d+)/))) {
    const b = basePT(c);
    if (+b.p !== +m0[1] || +b.t !== +m0[2]) return false;
  }
  for (const km of phrase.matchAll(/\bwith (menace|trample|deathtouch|lifelink|haste|vigilance|reach|first strike|double strike|defender|hexproof|indestructible|ward)\b/g)) if (!hasKw(c, km[1])) return false;
  if (/\byou don't own\b|\bbut don't own\b/.test(phrase) && c.owner === c.controller) return false;
  if (/without flying/.test(phrase) && hasKw(c, 'flying')) return false;
  let m;
  if ((m = phrase.match(/(?:with )?mana value (\d+) or less/))) if (d.cmc > +m[1]) return false;
  if ((m = phrase.match(/(?:with )?mana value (\d+) or greater/))) if (d.cmc < +m[1]) return false;
  if ((m = phrase.match(/power (\d+) or greater/))) if (power(c) < +m[1]) return false;
  if ((m = phrase.match(/power (\d+) or less/))) if (power(c) > +m[1]) return false;
  if ((m = phrase.match(/toughness (\d+) or less/))) if (toughness(c) > +m[1]) return false;
  if ((m = phrase.match(/toughness (\d+) or greater/))) if (toughness(c) < +m[1]) return false;
  // Wave Goodbye: "each creature without a +1/+1 counter on it"
  if (/without (?:a|any) \+1\/\+1 counters? on (?:it|them)/.test(phrase)) {
    if ((c.counters || {})['+1/+1'] > 0) return false;
  } else if (/with a \+1\/\+1 counter on it/.test(phrase) && !(c.counters || {})['+1/+1']) return false;
  if (/without (?:a|any) counters? on (?:it|them)/.test(phrase) && Object.values(c.counters || {}).some((v) => v > 0)) return false;
  if (/with a counter on it/.test(phrase) && !Object.keys(c.counters || {}).length) return false;
  if (/\bmonocolored\b/.test(phrase) && colorsOf(c).length !== 1) return false;
  if (/\bmulticolored\b/.test(phrase) && colorsOf(c).length < 2) return false;
  if (/\bcolorless\b/.test(phrase) && colorsOf(c).length) return false;
  const kinds = [];
  const p2 = phrase.replace(/non-?\w+/g, '');
  if (/\bcreatures?\b/.test(p2)) kinds.push('Creature');
  if (/\bartifacts?\b/.test(p2)) kinds.push('Artifact');
  if (/\benchantments?\b/.test(p2)) kinds.push('Enchantment');
  if (/\bplaneswalkers?\b/.test(p2)) kinds.push('Planeswalker');
  if (/\bbattles?\b/.test(p2)) kinds.push('Battle');
  if (/\blands?\b/.test(p2)) kinds.push('Land');
  if (/\binstants?\b/.test(p2)) kinds.push('Instant');
  if (/\bsorcer(?:y|ies)\b/.test(p2)) kinds.push('Sorcery');
  // subtypes: "target Zombie", "Goblin creature", "Dragon you control", "Mount or Vehicle"
  const subs = subtypeWords(p2);
  if (subs.length) {
    const ok = / or |, /.test(phrase) ? subs.some((t) => hasSubtype(c, t)) : subs.every((t) => hasSubtype(c, t));
    if (!ok) return false;
  }
  for (const m2 of phrase.matchAll(/\bnon-?([a-z]+)\b/g)) {
    const t = subtypeWords(m2[1])[0];
    if (t && hasSubtype(c, t)) return false;
  }
  if (/\bhistoric\b/.test(phrase) && !(/Legendary/.test(typeLine(c)) || isType(c, 'Artifact') || hasSubtype(c, 'Saga'))) return false;
  if (/\boutlaws?\b/.test(phrase) && !['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'].some((t) => hasSubtype(c, t))) return false;
  if (/\bpermanents?\b/.test(p2) && !kinds.length) {
    if (/nonland/.test(phrase) && isLand(c)) return false;
    if (/noncreature/.test(phrase) && isCreature(c)) return false;
    return true;
  }
  if (!kinds.length) return true;
  const isK = (k) => (k === 'Creature' ? isCreature(c) : isType(c, k));
  // "artifact creature" needs both; "artifact or creature", "artifact, creature, or enchantment" needs one
  const kindOk = kinds.length > 1 && !/\bor\b|, |and\/or/.test(p2) ? kinds.every(isK) : kinds.some(isK);
  if (!kindOk) return false;
  return true;
}

// Which battlefields a phrase allows: "an opponent controls" / "you control" / either.
function sidesFor(phrase, me) {
  if (/an opponent controls|you don't control|your opponents control|defending player controls|that player controls/.test(phrase)) return opponents(me);
  if (/you control|you own/.test(phrase)) return [me];
  return [me, ...opponents(me)];
}

export function legalTargets(phrase, me, src) {
  return sidesFor(phrase, me)
    .flatMap((pid) => cardsIn(pid, 'battlefield'))
    .filter((c) => canTarget(c, me, src) && matchesFilter(c, phrase) && (!/\bother\b|\banother\b/.test(phrase) || !src || c.iid !== src.iid));
}

// ------------------------------------------------------------ analysis (for the AI's scoring)
export function analyze(text, x = 0) {
  const t = String(text || '').toLowerCase();
  const a = {};
  let m;
  if ((m = t.match(/(?:^|\. |\n|, )(?:you |target player )?draws? (a|an|one|two|three|four|five|six|seven|x|\d+) cards?/))) a.draw = n(m[1], x);
  if ((m = t.match(/(destroy|exile) (?:up to (?:one|two) )?(?:another )?target ([^.]+?(?: with (?:mana value|power|toughness) [^.,]+?)?)(?:\.|,| and| with| an opponent| you don't| that|$)/)))
    a.removal = { verb: m[1], phrase: m[2] + (/an opponent controls/.test(t) ? ' an opponent controls' : '') };
  if ((m = t.match(/return (?:up to one )?target ([^.]+?) to (?:its|their) owner's hand/))) a.bounce = { phrase: m[1] };
  // tuck: Chaos Warp, Spin into Myth, Oblation — removal that sends it to the library
  if (!a.removal && (m = t.match(/(?:the owner of target ([^.]+?) shuffles it into|put target ([^.]+?) (?:on top of|on the bottom of|into) its owner's library|target ([^.]+?)'s owner shuffles it into)/)))
    a.removal = { verb: 'tuck', phrase: (m[1] || m[2] || m[3]).trim() };
  if ((m = t.match(/deals? (\d+|x) damage to (any target|target creature or planeswalker|target creature|target player or planeswalker|target opponent|target player|each opponent)/)))
    a.burn = { amount: n(m[1], x), to: m[2] };
  if (/destroy all (?:creatures|nonland permanents|other creatures)|exile all (?:creatures|nonland permanents)|all creatures get -\d+\/-\d+|destroy each creature|return all (?:creatures|nonland permanents) to their owners' hands/.test(t)) a.wipe = true;
  if ((m = t.match(/deals? (\d+|x) damage to each (creature[^.]*?|player)(?:\.|$| and)/)))
    a.massDamage = { amount: n(m[1], x), phrase: m[2] };
  if ((m = t.match(/create (a|an|one|two|three|x|\d+) (?:tapped )?tokens? that(?:'s| are) (?:a )?cop(?:y|ies) of/))) a.copy = { count: n(m[1], x) };
  else if ((m = t.match(/create (a|an|one|two|three|four|five|x|\d+) (?:tapped )?([^.]*?)tokens?/))) a.token = { count: n(m[1], x), desc: m[2] };
  if ((m = t.match(/you gain (\d+|x) life/))) a.gain = n(m[1], x);
  if ((m = t.match(/(?:each opponent|target opponent|target player|that player|defending player) loses (\d+|x) life/))) a.drain = n(m[1], x);
  if (/search your library for [^.]*?land cards?|search your library for (?:a|up to \w+) (?:basic )?(?:forest|island|swamp|mountain|plains)/.test(t)) a.ramp = true;
  else if (/search your library for (?:a|an) /.test(t)) a.tutor = true;
  if (/return (?:target |up to \w+ target )?[^.]*?creature cards? from (?:your|a) graveyard to the battlefield|put target creature card from (?:a|your|an opponent's) graveyard onto the battlefield/.test(t)) a.reanimate = true;
  if (/return (?:up to \w+ )?target [^.]*?cards? from your graveyard to your hand/.test(t)) a.regrowth = true;
  if ((m = t.match(/(?:each|target) opponent sacrifices (a|two|\d+) /))) a.edict = n(m[1]);
  if ((m = t.match(/put (a|one|two|three|\d+|x) \+1\/\+1 counters? on (target creature|each creature you control|~)/))) a.counters = { amount: n(m[1], x) };
  if (/gets \+\d+\/\+\d+ until end of turn|gains? (?:flying|trample|indestructible|hexproof)[^.]* until end of turn/.test(t)) a.pump = true;
  if (/creatures you control get \+/.test(t)) a.teamPump = true;
  if (/(?:^|\. |\n)scry (\d+)/.test(t)) a.scry = true;
  if (/(?:^|\. |\n)surveil (\d+)/.test(t)) a.surveil = true;
  if (/counter target/.test(t)) a.counterspell = true;
  if (/venture into the dungeon/.test(t)) a.venture = 1;
  if (/take the initiative/.test(t)) a.initiative = true;
  if (/become the monarch/.test(t)) a.monarch = true;
  if (/\bconnives?\b/.test(t)) a.draw = a.draw || 1;
  if (/\btransform ~|\btransform it\b/.test(t)) a.transform = true;
  if (/\binvestigate\b/.test(t)) a.investigate = true;
  if (/\bproliferate\b/.test(t)) a.proliferate = true;
  if (/\bexplores?\b/.test(t)) a.explore = true;
  if (/\bamass\b/.test(t)) a.token = a.token || { count: 1 };
  if (/\bfights?\b/.test(t)) a.fight = true;
  if (/\bgain control of\b/.test(t)) a.steal = true;
  if (/take an extra turn/.test(t)) a.extraTurn = true;
  if (/(?:each opponent|target player|that player) discards/.test(t)) a.oppDiscard = true;
  if (/add (\{[^}]+\})+|add \w+ mana/.test(t)) a.ritual = true;
  if (/(?:^|\. |\n)(?:target player |each opponent )?mills?/.test(t)) a.mill = true;
  if (/look at the top \w+ cards of your library/.test(t)) a.dig = true;
  if (/exile the top \w+ cards? of your library\. (?:until|you may play)/.test(t)) a.impulse = true;
  if (/\bdiscover\b/.test(t)) a.discover = true;
  if (/prevent all combat damage/.test(t)) a.fog = true;
  if (/^tap (?:up to \w+ )?target/.test(t)) a.tap = true;
  return a;
}

// Does the engine understand every sentence of this text? (the AI avoids abilities it would have to "apply by hand")
export function understood(text, src) {
  const t = src ? prep(text, src) : String(text || '').replace(/\([^)]*\)/g, '');
  const sens = splitSentences(t);
  for (let i = 0; i < sens.length; i++) {
    let low = sens[i].toLowerCase().trim().replace(/\.$/, '');
    if (!low) continue;
    low = low.replace(/^you may /, '');
    // a handler that reads the following sentences too ("Look at the top two… Put one into your hand…")
    const h = H.find((x) => !x.never && x.re.test(low) && (x.consumesRest || x.multi));
    if (h) return true;
    if (handled(low)) continue;
    // handlers written for two or three sentences at once
    const joined = sens.slice(i, i + 5).join(' ').toLowerCase().replace(/\.$/, '');
    if (H.some((x) => x.multi && x.re.test(joined))) return true;
    const cm = low.match(/^(?:if|when|as long as|until end of turn|this turn)[^,]*, (.+)$/);
    if (cm && handled(cm[1].replace(/^you may /, ''))) continue;
    return false;
  }
  return true;
}

export function knownEffect(text) {
  return Object.keys(analyze(text)).filter((k) => k !== 'counterspell').length > 0;
}

// "counter target noncreature spell" etc.
export function spellFilterOk(filter, c) {
  const tl = (DB[c.def].faces[c.face || 0] || DB[c.def].faces[0]).typeLine;
  filter = (filter || '').trim();
  if (!filter) return true;
  // Swan Song: "enchantment, instant, or sorcery"
  if (/,/.test(filter) || /^(?:artifact|creature|enchantment|instant|sorcery|planeswalker|battle|land)(?: or (?:artifact|creature|enchantment|instant|sorcery|planeswalker|battle))+$/.test(filter)) {
    const kinds = filter.split(/,\s*(?:or\s+)?|\s+or\s+/).map((x) => x.trim()).filter(Boolean);
    if (kinds.every((k) => /^(?:artifact|creature|enchantment|instant|sorcery|planeswalker|battle|noncreature)$/.test(k)))
      return kinds.some((k) => (k === 'noncreature' ? !/Creature/.test(tl) : new RegExp('\\b' + k + '\\b', 'i').test(tl)));
  }
  if (/noncreature/.test(filter)) return !/Creature/.test(tl);
  if (/instant or sorcery/.test(filter)) return /Instant|Sorcery/.test(tl);
  if (/creature/.test(filter)) return /Creature/.test(tl);
  if (/artifact or enchantment/.test(filter)) return /Artifact|Enchantment/.test(tl);
  if (/artifact/.test(filter)) return /Artifact/.test(tl);
  if (/enchantment/.test(filter)) return /Enchantment/.test(tl);
  if (/planeswalker/.test(filter)) return /Planeswalker/.test(tl);
  const mv = filter.match(/mana value (\d+) or less/);
  if (mv) return DB[c.def].cmc <= +mv[1];
  return true;
}

// ------------------------------------------------------------ conditions
function permsOf(pid) {
  return cardsIn(pid, 'battlefield');
}
function gyOf(pid) {
  return cardsIn(pid, 'graveyard');
}

// "Modified": has counters, is equipped, or is enchanted by an Aura its controller controls
export function isModified(c) {
  if (Object.values(c.counters || {}).some((k) => k > 0)) return true;
  return Object.values(G.s.cards).some((a) => a.attachedTo === c.iid && a.zone === 'battlefield' && (/Equipment/.test(typeLine(a)) || (/Aura/.test(typeLine(a)) && a.controller === c.controller)));
}
// "At the beginning of …, if …" conditions about the turn so far, players' hands and life, counters on this permanent…
function turnHistoryCond(c, env) {
  const s = G.s;
  const me = env.me;
  const them = env.them || opp(me);
  const ts = s.ts || {};
  const my = ts[me] || {};
  const last = (s.lastTs || {})[me] || {};
  const lastThem = (s.lastTs || {})[them] || {};
  const src = env.src && card(env.src.iid) ? card(env.src.iid) : env.src;
  const tp = env.thatPlayer || (env.it && env.it.player) || them;
  const handOf = (pid) => cardsIn(pid, 'hand').length;
  const cmpN = (have, op, k) => (op === 'or more' || op === 'or greater' ? have >= k : op === 'or fewer' || op === 'or less' ? have <= k : op === 'exactly' ? have === k : op === 'fewer than' ? have < k : op === 'more than' ? have > k : have >= k);
  const who = (w) => (/^(?:you|your)$/.test(w) ? me : /^that player|^they$/.test(w) ? tp : them);
  const entered = (pid, f) => ((ts[pid] || {}).entered || []).filter((e) => f(e));
  let m;
  // descend / leaving / entering this turn
  if (/^you descended this turn$/.test(c)) return (my.descended || 0) > 0;
  if (/^a permanent left the battlefield under your control this turn$/.test(c)) return !!my.permLeft;
  if (/^no permanents left the battlefield this turn$/.test(c)) return !seats().some((k) => (ts[k] || {}).permLeft);
  if ((m = c.match(/^(\w+) or more (nonland permanents|artifacts|creatures|permanents|lands) entered(?: the battlefield)? under your control this turn$/))) {
    const k = n(m[1]);
    const f = { 'nonland permanents': (e) => !/\bLand\b/.test(e.types), artifacts: (e) => /Artifact/.test(e.types), creatures: (e) => /Creature/.test(e.types), permanents: () => true, lands: (e) => /\bLand\b/.test(e.types) }[m[2]];
    return entered(me, f).length >= k;
  }
  if ((m = c.match(/^(?:a|an|another) (face-down creature|planeswalker|artifact|creature|land|[a-z]+) entered(?: the battlefield)? under your control this turn$/))) {
    const other = /^another/.test(c);
    return entered(me, (e) => (!other || e.iid !== (src || {}).iid) && (m[1] === 'face-down creature' ? e.faceDown : new RegExp('\\b' + m[1], 'i').test(e.types))).length > 0;
  }
  if (/^you had a land enter the battlefield under your control this turn$/.test(c)) return entered(me, (e) => /\bLand\b/.test(e.types)).length > 0;
  if (/^you had another creature enter the battlefield under your control last turn$/.test(c)) return ((last.entered || []).filter((e) => /Creature/.test(e.types)).length) > 0;
  if (/^you created a token this turn$/.test(c)) return entered(me, (e) => e.token).length > 0;
  if (/^(?:a|one or more) cards? left your graveyard this turn$/.test(c)) return (my.cardsLeftGy || 0) > 0;
  if (/^a creature card left your graveyard this turn$/.test(c)) return !!my.creatureLeftGy;
  if ((m = c.match(/^(\w+) or more cards were put into your graveyard (?:this turn from anywhere|from anywhere this turn)$/))) return (my.toGy || 0) >= n(m[1]);
  if ((m = c.match(/^(\w+) or more cards were put into your graveyard from anywhere other than the battlefield this turn$/))) return (my.toGyNotBf || 0) >= n(m[1]);
  if (/^a creature card was put into your graveyard from anywhere this turn$/.test(c)) return !!my.creatureToGy;
  if (/^an artifact or creature was put into a graveyard from the battlefield this turn$/.test(c)) return !!ts.artOrCreatureToGy;
  if (/^an enchantment was put into your graveyard from the battlefield this turn$/.test(c)) return !!my.enchantmentToGy;
  if (/^a land you controlled was put into your graveyard from the battlefield this turn$/.test(c)) return !!my.landToGy;
  if (/^a permanent was put into your hand from the battlefield this turn$/.test(c)) return !!my.bouncedToHand;
  if (/^one or more cards were put into exile this turn$/.test(c)) return !!ts.exiledAny;
  // deaths
  if (/^no creatures died this turn$/.test(c)) return !ts.creatureDied;
  if ((m = c.match(/^(\w+) or more creatures died under your control this turn$/))) return ((my.diedTypes || []).length) >= n(m[1]);
  if (/^a creature died under an opponent's control this turn$/.test(c)) return !!(((ts[them] || {}).diedTypes || []).length);
  if ((m = c.match(/^another ([a-z]+) died under your control this turn$/))) return (my.diedTypes || []).some((t) => new RegExp('\\b' + m[1], 'i').test(t));
  // sacrifices, discards, cycling
  if (/^you sacrificed (?:a permanent|one or more permanents) this turn$/.test(c)) return (my.sacrificed || 0) > 0;
  if ((m = c.match(/^you sacrificed (\w+) or more ([a-z]+?)s? this turn$/))) return (my.sacTypes || []).filter((t) => new RegExp('\\b' + m[2], 'i').test(t)).length >= n(m[1]);
  if ((m = c.match(/^you sacrificed an? ([a-z]+) this turn$/))) return (my.sacTypes || []).some((t) => new RegExp('\\b' + m[1], 'i').test(t));
  if (/^you discarded a card this turn$/.test(c)) return (my.discarded || []).length > 0;
  if (/^an opponent discarded a card this turn$/.test(c)) return ((ts[them] || {}).discarded || []).length > 0;
  if (/^a player discarded a card this turn$/.test(c)) return seats().some((k) => ((ts[k] || {}).discarded || []).length > 0);
  // life and damage
  if (/^you gained or lost life this turn$/.test(c)) return (my.lifeGained || 0) > 0 || (my.lifeLost || 0) > 0;
  if (/^you gained and lost life this turn$/.test(c)) return (my.lifeGained || 0) > 0 && (my.lifeLost || 0) > 0;
  if (/^you didn't lose life this turn$/.test(c)) return !(my.lifeLost > 0);
  if ((m = c.match(/^you lost (\w+) or more life this turn$/))) return (my.lifeLost || 0) >= n(m[1]);
  if ((m = c.match(/^a player lost (\w+) or more life this turn$/))) return Math.max(...seats().map((k) => (ts[k] || {}).lifeLost || 0)) >= n(m[1]);
  if (/^you lost life last turn$/.test(c)) return (last.lifeLost || 0) > 0;
  if (/^an opponent lost life last turn$/.test(c)) return (lastThem.lifeLost || 0) > 0;
  if ((m = c.match(/^you(?: were|'ve been) dealt (\w+) or more damage this turn$/))) return (my.dmgTaken || 0) >= n(m[1]);
  if ((m = c.match(/^an opponent was dealt (\w+) or more damage this turn$/))) return ((ts[them] || {}).dmgTaken || 0) >= n(m[1]);
  if (/^an opponent was dealt noncombat damage last turn$/.test(c)) return !!lastThem.noncombatDmgTaken;
  if ((m = c.match(/^a player was dealt combat damage by an? ([a-z]+) this turn$/))) return seats().flatMap((k) => (ts[k] || {}).combatDmgFromTypes || []).some((t) => new RegExp('\\b' + m[1], 'i').test(t));
  if ((m = c.match(/^you have exactly (\w+) life$/))) return s.players[me].life === n(m[1]);
  if ((m = c.match(/^(?:that player|an opponent) has (\w+) or less life$/))) return s.players[/^that/.test(c) ? tp : them].life <= n(m[1]);
  if ((m = c.match(/^each player has (\w+) or less life$/))) return livingSeats().every((k) => s.players[k].life <= n(m[1]));
  if (/^you have more life than an opponent$/.test(c)) return s.players[me].life > s.players[them].life;
  if (/^a player has more life than each other player$/.test(c)) return livingSeats().some((k) => livingSeats().every((o) => o === k || s.players[k].life > s.players[o].life));
  if (/^that player has less than half their starting life total$/.test(c)) return s.players[tp].life < (G.settings.startingLife || 40) / 2;
  // spells and draws this turn
  if (/^you didn't cast a spell this turn$/.test(c)) return !(my.spells > 0);
  if (/^(?:that player|they) didn't cast a spell this turn$/.test(c)) return !((ts[tp] || {}).spells > 0);
  if ((m = c.match(/^they cast (\w+) or more spells this turn$/))) return ((ts[tp] || {}).spells || 0) >= n(m[1]);
  if (/^that player didn't cast a creature spell this turn$/.test(c)) return !(((ts[tp] || {}).spells || 0) > ((ts[tp] || {}).noncreatureSpells || 0));
  if (/^you've cast both a creature spell and a noncreature spell this turn$/.test(c)) return (my.noncreatureSpells || 0) > 0 && (my.spells || 0) > (my.noncreatureSpells || 0);
  if (/^you've cast an instant or sorcery spell this turn$/.test(c)) return (my.instantSorcery || 0) > 0 || (my.noncreatureSpells || 0) > 0;
  if ((m = c.match(/^you've cast (\w+) or more instant and sorcery spells this turn$/))) return (my.instantSorcery || my.noncreatureSpells || 0) >= n(m[1]);
  if ((m = c.match(/^you(?:'ve)? drawn? (\w+) or more cards this turn$/)) || (m = c.match(/^you drew (\w+) or more cards this turn$/))) return (my.drawn || 0) >= n(m[1]);
  if (/^you've drawn more than one card this turn$/.test(c)) return (my.drawn || 0) > 1;
  if (/^you drew a card last turn$/.test(c)) return (last.drawn || 0) > 0;
  if (/^you didn't play a land this turn$/.test(c)) return !(my.landsPlayed > 0) && !s.landPlayed;
  // attacking
  if (/^you didn't attack with a creature this turn$/.test(c)) return !my.attacked;
  if (/^no creatures attacked this turn$/.test(c)) return !seats().some((k) => (ts[k] || {}).attacked);
  if (/^(?:~|it) didn't attack this turn$/.test(c)) return !(src && src.attackedTurn === s.turn);
  if (/^(?:~|it) attacked this turn$/.test(c)) return !!(src && src.attackedTurn === s.turn);
  if (/^(?:~|it) attacked or blocked this turn$/.test(c)) return !!(src && (src.attackedTurn === s.turn || src.blockedTurn === s.turn));
  if (/^(?:~|it) didn't attack or come under your control this turn$/.test(c)) return !!(src && src.attackedTurn !== s.turn && src.enteredTurn !== s.turn);
  if (/^(?:~|it) dealt damage to an opponent this turn$/.test(c)) return !!(src && src.dmgPlayerTurn === s.turn);
  if (/^(?:~|it) (?:entered|entered the battlefield) this turn$/.test(c)) return !!(src && src.enteredTurn === s.turn);
  if (/^(?:~|it) didn't enter the battlefield this turn$/.test(c)) return !(src && src.enteredTurn === s.turn);
  if (/^(?:a counter was put on ~|you put a counter on ~) this turn$/.test(c)) return !!(src && src.counterTurn === s.turn);
  // counters on this permanent
  if ((m = c.match(/^there (?:are|is) (\w+) or more ([a-z+\/0-9-]+) counters? on (?:~|it)$/))) return ((src && src.counters) || {})[m[2]] >= n(m[1]);
  if ((m = c.match(/^there are one or more ([a-z+\/0-9-]+) counters on ~$/))) return ((src && src.counters) || {})[m[1]] > 0;
  if ((m = c.match(/^there are no ([a-z+\/0-9-]+) counters on ~$/)) || (m = c.match(/^~ has no ([a-z+\/0-9-]+) counters on it$/))) return !(((src && src.counters) || {})[m[1]] > 0);
  if ((m = c.match(/^~ has an? ([a-z+\/0-9-]+) counter on it$/))) return ((src && src.counters) || {})[m[1]] > 0;
  if ((m = c.match(/^~ doesn't have an? ([a-z+\/0-9-]+) counter on it$/))) return !(((src && src.counters) || {})[m[1]] > 0);
  if ((m = c.match(/^~ has (\w+) or fewer ([a-z+\/0-9-]+) counters on it$/))) return (((src && src.counters) || {})[m[2]] || 0) <= n(m[1]);
  if ((m = c.match(/^(?:~|it) has (?:one or more )?([a-z+\/0-9-]+) counters on it$/))) return (((src && src.counters) || {})[m[1]] || 0) > 0;
  if ((m = c.match(/^(?:~|it|this [a-z]+) has fewer than (\w+) ([a-z+\/0-9-]+) counters on it$/))) return (((src && src.counters) || {})[m[2]] || 0) < n(m[1]);
  if (/^~ has counters on it$/.test(c)) return Object.values((src && src.counters) || {}).some((v) => v > 0);
  // this permanent's state
  if (/^~ is equipped$/.test(c)) return !!src && Object.values(s.cards).some((x) => x.zone === 'battlefield' && x.attachedTo === src.iid && /Equipment/.test(typeLine(x)));
  if (/^~ is enchanted$/.test(c)) return !!src && Object.values(s.cards).some((x) => x.zone === 'battlefield' && x.attachedTo === src.iid && /Aura/.test(typeLine(x)));
  if ((m = c.match(/^~ is enchanted by (\w+) or more auras$/))) return !!src && Object.values(s.cards).filter((x) => x.zone === 'battlefield' && x.attachedTo === src.iid && /Aura/.test(typeLine(x))).length >= n(m[1]);
  if (/^~ isn't prepared$/.test(c)) return !(src && src.prepared);
  if (/^~ is on the battlefield$/.test(c)) return !!(src && src.zone === 'battlefield');
  if (/^you both own and control ~$/.test(c)) return !!(src && src.owner === me && src.controller === me && src.zone === 'battlefield');
  if (/^enchanted creature is untapped$/.test(c)) { const h = src && src.attachedTo && card(src.attachedTo); return !!h && !h.tapped; }
  if ((m = c.match(/^enchanted creature's power is (\w+) or greater$/))) { const h = src && src.attachedTo && card(src.attachedTo); return !!h && power(h) >= n(m[1]); }
  // hands, libraries, graveyards
  if ((m = c.match(/^(you|that player|an opponent) (?:has|have) (no|one or fewer|exactly \w+|\w+ or (?:more|fewer|less)|fewer than \w+|more than \w+|a) cards? in (?:your |their |his or her )?hand$/))) {
    const pid = who(m[1].split(' ')[0] === 'that' ? 'that player' : m[1]);
    const h = handOf(pid);
    const q = m[2];
    if (q === 'no') return h === 0;
    if (q === 'a') return h > 0;
    if (q === 'one or fewer') return h <= 1;
    const qm = q.match(/^(exactly|fewer than|more than)? ?(\w+)(?: (or more|or fewer|or less))?$/);
    return qm ? cmpN(h, qm[1] || qm[3], n(qm[2])) : null;
  }
  if ((m = c.match(/^(?:a player|that player) has one or fewer cards in hand$/))) return Math.min(...livingSeats().map(handOf)) <= 1;
  if (/^an opponent has no cards in hand$/.test(c)) return handOf(them) === 0;
  if (/^a player has more cards in hand than each other player$/.test(c)) return livingSeats().some((k) => livingSeats().every((o) => o === k || handOf(k) > handOf(o)));
  if ((m = c.match(/^you have (\w+) or more cards in your library$/))) return cardsIn(me, 'library').length >= n(m[1]);
  if ((m = c.match(/^(?:you have )?(\w+) or more (creature )?cards are in your graveyard$/)) || (m = c.match(/^you have (\w+) or more (creature )?cards in your graveyard$/))) return cardsIn(me, 'graveyard').filter((x) => !m[2] || /Creature/.test(DB[x.def].typeLine || '')).length >= n(m[1]);
  if ((m = c.match(/^there are fewer than (\w+) creature cards in your graveyard$/))) return cardsIn(me, 'graveyard').filter((x) => /Creature/.test(DB[x.def].typeLine || '')).length < n(m[1]);
  if (/^~ is the only creature card in your graveyard$/.test(c)) return cardsIn(me, 'graveyard').filter((x) => /Creature/.test(DB[x.def].typeLine || '')).length === 1 && !!src && src.zone === 'graveyard';
  // the board
  if (/^no creatures are on the battlefield$/.test(c)) return !seats().flatMap((k) => cardsIn(k, 'battlefield')).some(isCreature);
  if ((m = c.match(/^there are (\w+) or more (creatures|lands) on the battlefield$/))) return seats().flatMap((k) => cardsIn(k, 'battlefield')).filter((x) => (m[2] === 'lands' ? isLand(x) : isCreature(x))).length >= n(m[1]);
  if ((m = c.match(/^there are no ([a-z]+?)s? on the battlefield$/))) return !seats().flatMap((k) => cardsIn(k, 'battlefield')).some((x) => matchesFilter(x, m[1]));
  if ((m = c.match(/^you control (\w+) or fewer lands$/))) return cardsIn(me, 'battlefield').filter(isLand).length <= n(m[1]);
  if (/^you control exactly one creature$/.test(c)) return cardsIn(me, 'battlefield').filter(isCreature).length === 1;
  if ((m = c.match(/^you control (\w+) or more ([a-z]+?)s$/))) return cardsIn(me, 'battlefield').filter((x) => matchesFilter(x, m[2])).length >= n(m[1]);
  if ((m = c.match(/^you don't control an? ([a-z ]+)$/))) return !cardsIn(me, 'battlefield').some((x) => matchesFilter(x, m[1]));
  // Koth, the Geomancer: "If that land is a Mountain, add {R}."
  if ((m = c.match(/^(?:that land|that card|that creature|that permanent|it) is an? ([a-z]+(?: [a-z]+)?)$/))) {
    const t = env.it && env.it.iid ? card(env.it.iid) : null;
    if (t) return matchesFilter(t, m[1]) || hasSubtype(t, m[1][0].toUpperCase() + m[1].slice(1));
  }
  // Roiling Canopy: "if you control at least five other Forests" (other than the one that just entered)
  if ((m = c.match(/^you control at least (\w+) other ([a-z]+?)s$/))) {
    const skip = (env.it && env.it.iid) || (src && src.iid);
    return cardsIn(me, 'battlefield').filter((x) => x.iid !== skip && matchesFilter(x, m[2])).length >= n(m[1]);
  }
  // Pugnacious Hammerskull: "you don't control another Dinosaur"
  if ((m = c.match(/^you (don't )?control another ([a-z ]+)$/))) {
    const has = cardsIn(me, 'battlefield').some((x) => x.iid !== (src && src.iid) && matchesFilter(x, m[2]));
    return m[1] ? !has : has;
  }
  if ((m = c.match(/^you control one or more ([a-z]+?)s$/))) return cardsIn(me, 'battlefield').some((x) => matchesFilter(x, m[1]));
  if (/^your opponents control no creatures$/.test(c)) return !cardsIn(them, 'battlefield').some(isCreature);
  if (/^a player controls no creatures$/.test(c)) return livingSeats().some((k) => !cardsIn(k, 'battlefield').some(isCreature));
  if ((m = c.match(/^an opponent controls (\w+) or more creatures$/))) return cardsIn(them, 'battlefield').filter(isCreature).length >= n(m[1]);
  if ((m = c.match(/^that player controls more (lands|creatures) than (?:you|each other player)$/))) { const f = m[1] === 'lands' ? isLand : isCreature; const others = /than you$/.test(c) ? [me] : seats().filter((o) => o !== tp && inGame(o)); return others.every((o) => cardsIn(tp, 'battlefield').filter(f).length > cardsIn(o, 'battlefield').filter(f).length); }
  if ((m = c.match(/^a player controls more (creatures|[a-z]+s) than each other player$/))) { const f = (x) => (m[1] === 'creatures' ? isCreature(x) : matchesFilter(x, m[1].replace(/s$/, ''))); const cnt = (k) => cardsIn(k, 'battlefield').filter(f).length; return livingSeats().some((k) => livingSeats().every((o) => o === k || cnt(k) > cnt(o))); }
  if ((m = c.match(/^that player controls an? ([a-z]+)$/))) return cardsIn(tp, 'battlefield').some((x) => matchesFilter(x, m[1]));
  if (/^all lands on the battlefield are islands$/.test(c)) return seats().flatMap((k) => cardsIn(k, 'battlefield')).filter(isLand).every((x) => hasSubtype(x, 'Island'));
  if ((m = c.match(/^all nonland permanents you control are (white|blue|black|red|green)$/))) return cardsIn(me, 'battlefield').filter((x) => !isLand(x)).every((x) => colorsOf(x).includes(COLOR_WORDS[m[1]]));
  if ((m = c.match(/^creatures you control have total toughness (\w+) or greater$/))) return cardsIn(me, 'battlefield').filter(isCreature).reduce((a, x) => a + Math.max(0, toughness(x)), 0) >= n(m[1]);
  if (/^an opponent is the monarch$/.test(c)) return s.monarch === them;
  if (/^there is no monarch$/.test(c)) return !s.monarch;
  if (/^you['’]re the monarch$/.test(c)) return s.monarch === me;
  if (/^it's an opponent's turn$/.test(c)) return s.active !== me;
  if (/^it's not the first turn of the game$/.test(c)) return s.turn > 1;
  if (/^your control your commander$/.test(c)) return cardsIn(me, 'battlefield').some((x) => x.isCommander);
  if (/^~ wasn't kicked$/.test(c)) return !(env.kicked || (src && src.kicked));
  if (/^your team gained life this turn$/.test(c)) return (my.lifeGained || 0) > 0;
  if ((m = c.match(/^there are (\w+) colors among permanents you control$/))) return new Set(cardsIn(me, 'battlefield').flatMap((x) => colorsOf(x))).size >= n(m[1]);
  if (/^~ is suspended$/.test(c)) return !!(src && src.suspended && src.zone === 'exile');
  if ((m = c.match(/^there are (\w+) or more cards exiled with ~$/)) || (m = c.match(/^(\w+) or more cards have been exiled with ~$/))) return !!src && Object.values(s.cards).filter((x) => x.zone === 'exile' && (x.exiledLinked === src.iid || x.hiddenBy === src.iid || (x.exiledBy || []).includes?.(src.iid))).length >= n(m[1]);
  if (/^~ was dealt damage this turn$/.test(c)) return !!(src && (src.damage || 0) > 0);
  if (/^a \+1\/\+1 counter was put on a permanent under your control this turn$/.test(c)) return !!my.counterOnCreature;
  if ((m = c.match(/^your devotion to (\w+)(?: and (\w+))? is (\w+) or greater$/))) { const v = countPhrase(me, `devotion to ${m[1]}${m[2] ? ' and ' + m[2] : ''}`, helpers, src && src.iid); return v === null ? null : v >= n(m[3]); }
  return null;
}

export function evalCond(cond, env) {
  // Scouring Swarm: "seven or more land cards are in your graveyard" → "there are seven or more land cards in your graveyard"
  cond = String(cond).replace(/^(\w+ or (?:more|fewer) (?:[a-z]+ )?cards?) (?:are|is) in (your|a|an opponent's|their) graveyard$/i, 'there are $1 in $2 graveyard');
  const c = cond.toLowerCase().replace(/^it's |^it is /, "it's ").trim();
  // In a pod, "an opponent …" holds when it's true of any opponent; "each opponent …" when true of all of them.
  if (multiplayer() && !env.them && /\b(?:an|each) opponent\b/.test(c) && opponents(env.me).length > 1) {
    const each = /\beach opponent\b/.test(c) && !/\ban opponent\b/.test(c);
    const res = opponents(env.me).map((o) => evalCond(cond, { ...env, them: o }));
    if (res.some((r) => r === null)) return null;
    return each ? res.every(Boolean) : res.some(Boolean);
  }
  const me = env.me;
  const them = env.them || opp(me);
  const s = G.s;
  const ts = s.ts || { p: {}, ai: {} };
  let m;
  // Pelt Collector: "if that creature's power is greater than ~'s" (the creature that entered or died)
  if ((m = c.match(/^that creature's power is greater than ~'s$/))) {
    const ev = env.event || {};
    const t = ev.iid && card(ev.iid);
    const p = ev.power !== undefined ? ev.power : t ? power(t) : null;
    const me_ = env.src && card(env.src.iid);
    if (p === null || !me_) return null;
    return p > power(me_);
  }
  // voting: "if sickness gets more votes", "if psychosis gets more votes or the vote is tied"
  if ((m = c.match(/^(.+?) gets more votes( or the vote is tied)?$/))) {
    if (!env.votes) return false; // no vote happened
    const mine = env.votes.tally.get(m[1].trim()) || 0;
    const others = [...env.votes.tally.entries()].filter(([k]) => k !== m[1].trim()).map(([, v]) => v);
    const best = Math.max(0, ...others);
    return mine > best || (!!m[2] && mine === best);
  }
  if (/(?:this spell|~|it) was kicked|kicker was paid/.test(c)) return !!env.kicked;
  if (/was kicked twice|kicked \w+ times/.test(c)) return (env.kicked || 0) >= 2;
  if (/(?:this spell|~|it) was bargained/.test(c)) return !!env.bargained;
  if (/(?:this spell|~) was cast using teamwork/.test(c)) return !!env.teamwork;
  if (/^you were the monarch as the turn began$/.test(c)) return G.s.monarchAtStart === env.me;
  // Baleful Mastery: "If the {1}{B} cost was paid"
  if (/^the (?:\{[^}]+\})+ cost was paid$/.test(c)) return env.castMode === 'altcost';
  // Cacophony Unleashed: "if you cast it"
  if (/^you cast (?:it|~)$/.test(c)) { const x = env.src && card(env.src.iid); return !!x && !!x.castFrom && x.castTurn === G.s.turn; }
  // Animate Dead: "if it's on the battlefield"
  if (/^(?:it's|~ is) (?:still )?on the battlefield$/.test(c)) { const x = env.src && card(env.src.iid); return !!x && x.zone === 'battlefield'; }
  // Alex Wilder: "if you cast it from anywhere other than your hand"
  if (/^you cast it from anywhere other than your hand$/.test(c)) {
    const x = (env.it && env.it.iid && card(env.it.iid)) || (env.src && card(env.src.iid));
    return !!x && !!x.castFrom && x.castFrom !== 'hand' && x.castTurn === G.s.turn;
  }
  // Eshki: "that spell's power is 4 or greater"
  {
    const sm = c.match(/^that spell's (power|toughness|mana value) is (\d+) or (greater|less)$/);
    if (sm) {
      const sp = env.it && env.it.iid && card(env.it.iid);
      if (!sp) return false;
      const f = DB[sp.def].faces[sp.castFace || sp.face || 0] || DB[sp.def].faces[0];
      const v = sm[1] === 'mana value' ? DB[sp.def].cmc || 0 : parseInt(sm[1] === 'power' ? f.power : f.toughness, 10) || 0;
      return sm[3] === 'greater' ? v >= +sm[2] : v <= +sm[2];
    }
  }
  // Scourge of the Throne, dethrone-style: "it's attacking the player with the most life or tied for most life"
  if (/^(?:it's|~ is) attacking the player with the most life or tied for most life$/.test(c)) {
    const a = (env.it && env.it.iid && card(env.it.iid)) || (env.src && card(env.src.iid));
    const tgt = a && G.s.combat && G.s.combat.targets && G.s.combat.targets[a.iid];
    const def = typeof tgt === 'string' && G.s.players[tgt] ? tgt : env.thatPlayer || opp(env.me);
    const most = Math.max(...seats().filter(inGame).map((p) => G.s.players[p].life));
    return G.s.players[def] && G.s.players[def].life >= most;
  }
  if (/the gift was promised|gift was promised/.test(c)) return !!env.gift;
  if (/the gift wasn't promised/.test(c)) return !env.gift;
  if (/(?:you cast it|~ was cast|this spell was cast|it was cast) from (?:a|your) graveyard/.test(c)) return env.castFrom === 'graveyard';
  if (/(?:you cast it|it was cast|~ was cast) from exile/.test(c)) return env.castFrom === 'exile';
  if (/(?:this spell's|~'s|its) (?:additional cost|squad cost|casualty cost) was paid|you paid the [a-z]+ cost/.test(c)) return !!env.additionalPaid;
  if (/its spree|you cast it for its/.test(c)) return !!env.altCost;
  if (/(?:~|it) (?:was|is) (?:cast|dashed|blitzed|evoked|foretold|plotted|warped)/.test(c)) return !!env.castMode;
  if (/^you do$|^you did$|^you do so$/.test(c)) return !!env.lastMay;
  // Nissa, Leyline Tamer: "if this is the first time this ability has resolved this turn"
  if (/^this is the first time this ability has resolved this turn$/.test(c)) {
    if (!env.src) return true;
    if (env.src.firstResolveTurn === G.s.turn) return false;
    env.src.firstResolveTurn = G.s.turn;
    return true;
  }
  // Currency Converter: "If it's a land card / a nonland card"
  if ((m = c.match(/^it's an? (non)?land card$/))) {
    const t = env.refCard ? card(env.refCard) : env.it && card(env.it.iid);
    if (!t) return false;
    return m[1] ? !isLand(t) : isLand(t);
  }
  // Massacre Girl, Known Killer: "if its toughness was less than 1"
  if ((m = c.match(/^its toughness was less than (\d+)$/))) return !!(env.event && env.event.toughness !== undefined && env.event.toughness < +m[1]);
  // Blowfly Infestation, Oft-Nabbed Goat
  if ((m = c.match(/^it had (?:a|one or more) ([+-]1\/[+-]1) counters? on it$/))) return ((env.deadCounters || {})[m[1]] || 0) > 0;
  // Vision: "if it isn't that player's turn"
  if (/^it isn't that player's turn$/.test(c)) return !!env.thatPlayer && G.s.active !== env.thatPlayer;
  // Hawkeye: "if ~ dealt damage to it this turn"
  if (/^~ dealt damage to it this turn$/.test(c)) return !!(env.src && env.it && (G.s.dmgPairs || {})[env.src.iid + '>' + env.it.iid] === G.s.turn);
  // Lasting Tarfire: "if you put a counter on a creature this turn"
  if (/^you put a counter on a creature this turn$/.test(c)) return !!(ts[me] || {}).counterOnCreature;
  // Rescue: "if it was an artifact"
  if (/^it was an artifact$/.test(c)) return !!(env.it && card(env.it.iid) && isType(card(env.it.iid), 'Artifact'));
  // Taborax: "If that creature was a Cleric"; Andúril: "If that creature is legendary"
  if ((m = c.match(/^(?:that creature|it) (?:was|is) (?:an? )?([a-z]+)$/)) && env.it && card(env.it.iid) && m[1] !== 'attacking' && m[1] !== 'tapped') {
    const t = card(env.it.iid);
    const ghost = t.zone === 'battlefield' ? t : { ...t, zone: 'battlefield' };
    return m[1] === 'legendary' ? /Legendary/.test(typeLine(ghost)) || !!ringLevel(t) : matchesFilter(ghost, m[1]);
  }
  // Captain Marvel: "if it's not a Kree"
  if (/^it's not an? ([a-z]+)$/.test(c)) return !(env.it && card(env.it.iid) && hasSubtype(card(env.it.iid), c.match(/^it's not an? ([a-z]+)$/)[1]));
  if ((m = c.match(/^(?:it|~|this [a-z]+) has (\w+) or more ([a-z+\/0-9-]+) counters on it$/))) return ((env.src && env.src.counters) || {})[m[2]] >= n(m[1]);
  if (/^(?:~|it|this [a-z]+) is tapped$/.test(c)) return !!(env.src && env.src.tapped);
  if (/^(?:~|it|this [a-z]+) is untapped$/.test(c)) return !!(env.src && !env.src.tapped);
  if (/^you didn't activate an? loyalty ability of an? planeswalker this turn$/.test(c)) return !((G.s.ts[env.me] || {}).loyaltyActivated > 0);
  if (/^you activated an? loyalty ability of an? planeswalker this turn$/.test(c)) return (G.s.ts[env.me] || {}).loyaltyActivated > 0;
  if (/^you don't$/.test(c)) return !env.lastMay;
  if (/it's your turn/.test(c)) return s.active === me;
  if (/it's not your turn/.test(c)) return s.active !== me;
  if (/no spells were cast last turn/.test(c)) return (s.lastTurnSpells || { total: 1 }).total === 0;
  if (/a player cast two or more spells last turn/.test(c)) return (s.lastTurnSpells || { max: 0 }).max >= 2;
  if (/it's night/.test(c)) return s.dayNight === 'night';
  if (/it's day/.test(c)) return s.dayNight === 'day';
  if (/a creature died this turn/.test(c)) return !!s.ts.creatureDied;
  if ((m = c.match(/^(\w+) or more creatures died this turn$/))) return (s.ts.creaturesDiedN || 0) >= n(m[1]);
  if (/^a creature died under your control this turn$/.test(c)) return !!((ts[me] || {}).diedTypes || []).length;
  // Alpharael (Void): "if a nonland permanent left the battlefield this turn or a spell was warped this turn"
  if (/^a nonland permanent left the battlefield this turn or a spell was warped this turn$/.test(c)) return !!(s.ts.nonlandLeft || s.ts.warped);
  if (/you attacked (?:with a creature )?this turn/.test(c)) return !!ts[me].attacked;
  if (/you(?:'ve| have) scried or surveilled this turn/.test(c)) return !!ts[me].scried;
  if (/you(?:'ve| have) surveilled this turn/.test(c)) return !!(ts[me].surveilledCards || []).length || !!ts[me].scried;
  if (/a permanent you controlled left the battlefield this turn/.test(c)) return !!ts[me].permLeft;
  if (/an opponent lost life this turn/.test(c)) return ts[them].lifeLost > 0;
  if (/you gained life this turn/.test(c)) return ts[me].lifeGained > 0;
  if (/you gained (\d+) or more life this turn/.test(c)) return ts[me].lifeGained >= +c.match(/(\d+)/)[1];
  if (/you(?:'ve| have) cast (?:another|two or more) spells? this turn/.test(c)) return ts[me].spells >= 2;
  if (/you(?:'ve| have) drawn two or more cards this turn/.test(c)) return ts[me].drawn >= 2;
  if (/(?:seven|7) or more cards are in your graveyard|you have seven or more cards in your graveyard/.test(c)) return gyOf(me).length >= 7;
  if (/four or more card types among cards in your graveyard/.test(c)) return countPhrase(me, 'card types among cards in your graveyard', helpers) >= 4;
  if (/two or more instant and\/or sorcery cards in your graveyard/.test(c)) return gyOf(me).filter((x) => /Instant|Sorcery/.test(DB[x.def].typeLine)).length >= 2;
  if ((m = c.match(/(four|eight|\d+) or more permanent cards in your graveyard/))) return gyOf(me).filter((x) => isPermanentCard(DB[x.def])).length >= n(m[1]);
  if (/you have no cards in hand/.test(c)) return !zoneOf(me, 'hand').length;
  if ((m = c.match(/you have (\w+) or more cards in hand/))) return zoneOf(me, 'hand').length >= n(m[1]);
  if (/you control three or more artifacts/.test(c)) return permsOf(me).filter((x) => isType(x, 'Artifact')).length >= 3;
  if (/you control a creature with power (\d+) or greater/.test(c)) return permsOf(me).some((x) => isCreature(x) && power(x) >= +c.match(/(\d+)/)[1]);
  if (/three or more creatures with different powers/.test(c)) return new Set(permsOf(me).filter(isCreature).map(power)).size >= 3;
  if (/an opponent has three or more poison counters/.test(c)) return s.players[them].poison >= 3;
  if (/you have the city's blessing/.test(c)) return !!s.players[me].cityBlessing;
  if (/you're the monarch|you are the monarch/.test(c)) return s.monarch === me;
  if (/you have the initiative/.test(c)) return s.initiative === me;
  if (/you(?:'ve| have) completed (?:a|one or more) dungeons?/.test(c)) return (s.players[me].dungeonsCompleted || 0) > 0;
  if (/you(?:'ve| have) completed (\w+) or more dungeons/.test(c)) return (s.players[me].dungeonsCompleted || 0) >= n(c.match(/completed (\w+) or more/)[1]);
  if (/you(?:'ve| have) completed a dungeon/.test(c)) return s.players[me].dungeonsCompleted > 0;
  if (/^you control (?:that creature|it|that permanent)$/.test(c)) { const t = env.it && env.it.iid && card(env.it.iid); return !!t && t.controller === me; }
  if (/^you don't control (?:that creature|it|that permanent)$/.test(c)) { const t = env.it && env.it.iid && card(env.it.iid); return !!t && t.controller !== me; }
  if (/you control your commander|you control a commander/.test(c)) return permsOf(me).some((x) => x.isCommander);
  if (/max speed|your speed is 4/.test(c)) return s.players[me].speed >= 4;
  if ((m = c.match(/you have (\d+) or more life/))) return s.players[me].life >= +m[1];
  if ((m = c.match(/you have (\d+) or less life/))) return s.players[me].life <= +m[1];
  if (/^(?:~|this card) is in your graveyard$/.test(c)) return !!(env.src && card(env.src.iid) && card(env.src.iid).zone === 'graveyard');
  if ((m = c.match(/^an opponent has (\d+) or less life$/))) return s.players[them].life <= +m[1];
  if (/you have at least (\d+) life more than your starting life total/.test(c)) return s.players[me].life >= G.settings.startingLife + +c.match(/(\d+)/)[1];
  if ((m = c.match(/you have (\w+) or more \{e\}/))) return s.players[me].counters.energy >= n(m[1]);
  if ((m = c.match(/x is (\w+) or (?:more|greater)/))) return (env.x || 0) >= n(m[1]);
  if (/^each player has no cards in hand$/.test(c)) return !zoneOf(me, 'hand').length && !zoneOf(them, 'hand').length;
  if ((m = c.match(/^creatures you control have total power (\d+) or greater$/))) return permsOf(me).filter(isCreature).reduce((a, x) => a + Math.max(0, power(x)), 0) >= +m[1];
  // Daredevil: "If that card is a Hero card"
  if ((m = c.match(/^(?:that card|it|the exiled card) is an? ([a-z -]+?) card$/))) {
    const t = env.it && card(env.it.iid);
    return !!t && matchesFilter(t, m[1]);
  }
  if (/^an opponent has more cards in hand than you$/.test(c)) return zoneOf(them, 'hand').length > zoneOf(me, 'hand').length;
  if (/^you have more cards in hand than (?:an|each) opponent$/.test(c)) return zoneOf(me, 'hand').length > zoneOf(them, 'hand').length;
  if ((m = c.match(/^there are (\w+) or more ([a-z ,/]+?) cards in your graveyard$/))) {
    // Lorehold Archivist: "three or more artifact and/or creature cards"
    const kinds = m[2].split(/,? and\/or |,? or |, /).map((x) => x.trim()).filter(Boolean);
    return gyOf(me).filter((x) => kinds.some((k) => matchesFilter(x, k))).length >= n(m[1]);
  }
  if (/^you haven't cast a spell from your hand this turn$/.test(c)) return !(ts[me].spellsFromHand || 0);
  if (/^you(?:'ve| have) cast a spell from your hand this turn$/.test(c)) return (ts[me].spellsFromHand || 0) > 0;
  if (/^you(?:'ve| have) cast a noncreature spell this turn$/.test(c)) return (ts[me].noncreatureSpells || 0) > 0;
  if (/^you(?:'ve| have) cast a creature spell this turn$/.test(c)) return (ts[me].spells || 0) > (ts[me].noncreatureSpells || 0);
  if ((m = c.match(/^you attacked with (\w+) or more creatures this turn$/))) return (ts[me].attackedWith || 0) >= n(m[1]);
  if (/^you attacked (?:with a creature )?this turn$/.test(c)) return !!ts[me].attacked;
  // Evercoat Ursine: "if there are cards exiled with it" (hidden away)
  if (/^there are cards exiled with (?:it|~|this [a-z]+)$/.test(c)) return !!env.src && Object.values(s.cards).some((x) => x.zone === 'exile' && (x.hiddenBy === env.src.iid || (x.exiledBy || []).includes?.(env.src.iid)));
  if ((m = c.match(/you control (another|a|an|(?:two|three|four|five|six|seven|eight|nine|ten|\d+) or more) ([^,.]+?)$/))) {
    const need = /^(?:another|a|an)$/.test(m[1]) ? 1 : n(m[1].replace(/ or more$/, ''));
    const phrase = m[2].replace(/s$/, '');
    return permsOf(me).filter((x) => (m[1] !== 'another' || x.iid !== (env.src || {}).iid) && matchesFilter(x, phrase)).length >= need;
  }
  if ((m = c.match(/you control no ([^,.]+?)$/))) return !permsOf(me).some((x) => matchesFilter(x, m[1].replace(/s$/, '')));
  if ((m = c.match(/an opponent controls (?:a|an) ([^,.]+?)$/))) return permsOf(them).some((x) => matchesFilter(x, m[1]));
  if (/an opponent controls more lands than you/.test(c)) return permsOf(them).filter(isLand).length > permsOf(me).filter(isLand).length;
  if (/an opponent controls more creatures than you/.test(c)) return permsOf(them).filter(isCreature).length > permsOf(me).filter(isCreature).length;
  if (/an opponent has more life than you/.test(c)) return s.players[them].life > s.players[me].life;
  if ((m = c.match(/(?:that creature|it)(?:'s| has) power (\d+) or greater|its power is (\d+) or greater/))) {
    const it = env.it && env.it.iid ? card(env.it.iid) : null;
    return it ? power(it) >= +(m[1] || m[2]) : false;
  }
  if (/(?:it|that card|that creature)(?:'s| is) (?:a )?creature/.test(c)) {
    const it = env.it && env.it.iid ? card(env.it.iid) : null;
    return it ? /Creature/.test(DB[it.def].typeLine) : false;
  }
  if (/(?:it|that card)(?:'s| is) a land/.test(c)) {
    const it = env.it && env.it.iid ? card(env.it.iid) : null;
    return it ? isLand(it) : false;
  }
  if (/(?:it|that card)(?:'s| is) a nonland card/.test(c)) {
    const it = env.it && env.it.iid ? card(env.it.iid) : null;
    return it ? !isLand(it) : false;
  }
  if (/you won the flip|you win the flip/.test(c)) return !!env.wonFlip;
  if (/(?:~|it) has no -1\/-1 counters? on it|it had no -1\/-1 counters/.test(c)) return !(env.deadCounters || {})['-1/-1'];
  if (/(?:~|it) has no \+1\/\+1 counters? on it|it had no \+1\/\+1 counters/.test(c)) return !(env.deadCounters || {})['+1/+1'];
  if (/~ (?:isn't|is not) renowned/.test(c)) return !(env.src && env.src.renowned);
  if (/~ (?:isn't|is not) monstrous/.test(c)) return !(env.src && env.src.monstrous);
  if (/~ is saddled|it's saddled/.test(c)) return !!(env.src && env.src.saddledTurn === G.s.turn);
  if (/^it was attacking$/.test(c) && env.wasAttacking !== undefined) return !!env.wasAttacking;
  if ((m = c.match(/^there are (seven|\w+|\d+) or more cards in your graveyard$/))) return gyOf(me).length >= n(m[1]);
  if ((m = c.match(/^an? ([a-z]+) died under your control this turn$/))) return ((ts[me] || {}).diedTypes || []).some((t) => new RegExp('\\b' + m[1], 'i').test(t));
  if (/^you have a full party$/.test(c)) return partySize(me) >= 4;
  if (/^~ is your ring-bearer$/.test(c)) return !!(env.src && card(env.src.iid) && card(env.src.iid).ringBearer);
  if ((m = c.match(/^the ring has tempted you (\w+) or more times this game$/))) return (s.players[me].ringTimes || s.players[me].ring || 0) >= n(m[1]);
  if ((m = c.match(/^an opponent lost (\w+) or more life this turn$/))) return ((ts[them] || {}).lifeLost || 0) >= n(m[1]);
  {
    const v = turnHistoryCond(c, env);
    if (v !== null) return v;
  }
  // "A and B": both halves must hold
  if (/ and /.test(c) && !/\band\/or\b/.test(c)) {
    const parts = c.split(/ and /);
    const vals = parts.map((p) => evalCond(p, env));
    if (vals.every((v) => v !== null)) return vals.every(Boolean);
  }
  if (/(?:~|it) (?:is|was) attacking/.test(c)) return !!(env.src && env.src.attacking);
  if (/its toughness is (\d+) or less/.test(c)) return env.src ? toughness(env.src) <= +c.match(/(\d+)/)[1] : false;
  return null;
}

// ------------------------------------------------------------ sentences
function splitSentences(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    let buf = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') q = !q;
      buf += ch;
      if (!q && ch === '.' && (line[i + 1] === ' ' || i === line.length - 1)) {
        out.push(buf.trim());
        buf = '';
      }
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out.filter((x) => x && x !== '.');
}

// ------------------------------------------------------------ picking objects
async function pickTargets(env, phrase, opts = {}) {
  const me = env.me;

  const p = phrase.toLowerCase();
  let count = 1;
  let optional = false;
  let m;
  if ((m = p.match(/^up to (one|two|three|four|five|x|\d+) /))) {
    count = n(m[1], env.x);
    optional = true;
  } else if ((m = p.match(/^(two|three|four|x|\d+) target/))) count = n(m[1], env.x);
  else if (/^any number of/.test(p)) {
    count = 99;
    optional = true;
  }
  const kind = p.replace(/^(?:up to \w+ |any number of |\w+ (?=target))?(?:other |another )?target /, '').replace(/^any number of target /, '');
  const results = [];
  // "creature or planeswalker [an opponent controls]" (Annie Joins Up) is permanents only — no players
  const anyTarget = /^any (?:other )?target|creature or player|player or planeswalker|creature, player, or planeswalker/.test(kind) || /any target/.test(p);
  const playerTarget = /^(?:player|opponent)s?\b/.test(kind) || anyTarget || /or player|player or/.test(kind);
  let cands;
  if (/^spell/.test(kind)) {
    cands = env.stackTarget ? [card(env.stackTarget)].filter(Boolean) : [];
  } else if (/card(?:s)? (?:from|in) (?:a|your|an opponent's|target player's) graveyard/.test(kind)) {
    const pids = /your graveyard/.test(kind) ? [me] : /opponent's/.test(kind) ? opponents(me) : seats();
    cands = pids.flatMap((pid) => cardsIn(pid, 'graveyard')).filter((c) => matchesFilter(c, kind.replace(/cards? (?:from|in) .*$/, '').trim() || 'card'));
  } else if (anyTarget) {
    cands = seats().flatMap((k) => cardsIn(k, 'battlefield')).filter(
      (c) => canTarget(c, me, env.src) && (isCreature(c) || isType(c, 'Planeswalker') || isType(c, 'Battle')) && (/^any other/.test(kind) ? c.iid !== env.src.iid : true)
    );
  } else if (/^(?:player|opponent)/.test(kind)) cands = [];
  else cands = legalTargets(kind, me, env.src);
  if (/\bother\b|\banother\b/.test(p) && env.src) cands = cands.filter((c) => c.iid !== env.src.iid);
  // "Tap target permanent, then untap another target permanent": not one already chosen by this ability
  if (/\banother target\b/.test(p) && env.pickedSoFar) cands = cands.filter((c) => !env.pickedSoFar.includes(c.iid));
  if (opts.filter) cands = cands.filter(opts.filter);
  // Lozhan: "any target that isn't a commander"
  if (/\bthat (?:isn't|is not|'s not) a commander\b|\bnoncommander\b/.test(p)) cands = cands.filter((c) => !c.isCommander);
  // "each of up to two other targets" (Drakuseth): not the ones already chosen
  const ex = opts.exclude || [];
  if (ex.length) cands = cands.filter((c) => !ex.some((e) => e.iid === c.iid));
  // the AI steers clear of opponents' permanents whose ward it can't pay, when there's another choice
  if (isAI(me) && !aiSlaved()) {
    const ok = cands.filter((c) => ctl(c) === me || wardPayableNow(me, c));
    // only when an opponent's permanent is still on offer (otherwise removal would land on its own creature)
    if (ok.length < cands.length && ok.some((c) => ctl(c) !== me)) cands = ok;
  }
  let players = [];
  if (playerTarget) {
    players = /opponent/.test(kind) ? opponents(me) : [...opponents(me), me];
    players = players.filter((pid) => !playerHexproof(pid, me, env.src) && !ex.some((e) => e.player === pid));
  }
  for (let k = 0; k < count; k++) {
    const left = cands.filter((c) => !results.some((r) => r.iid === c.iid));
    const pl = players.filter((pid) => !results.some((r) => r.player === pid));
    if (!left.length && !pl.length) break;
    const pick = await env.choosers[me].target({
      ...(env.forced ? { forced: true } : {}),
      // damage: say how much (Scourge of Valkas, Warstorm Surge: "deals damage equal to its power")
      prompt: opts.prompt || `${opts.amount !== undefined ? `Deal ${opts.amount} damage — choose ` : 'Choose '}${count > 1 && count < 99 ? `target ${k + 1} of ${count}` : 'a target'}: ${String(kind).replace(/^(?:up to|any number of) \w+ /, '')}`,
      candidates: left.map((c) => c.iid), players: pl, harm: opts.harm !== undefined ? opts.harm : true, amount: opts.amount, src: env.src, purpose: opts.purpose,
      optional: optional || k > 0 || (!left.length && !pl.length),
    });
    if (!pick) break;
    results.push(pick);
  }
  env.pickedSoFar = [...(env.pickedSoFar || []), ...results.filter((r) => r.iid).map((r) => r.iid)];
  if (opts.noWard) return results;
  // ward: the controller of an opponent's targeted permanent asks for the ward cost
  const kept = [];
  for (const r of results) {
    if (r.iid && card(r.iid) && card(r.iid).zone === 'battlefield' && ctl(card(r.iid)) !== me) {
      const t = card(r.iid);
      if (!(await payWard(me, t, env.choosers[me], env.src, env.choosers))) {
        // ward counters the whole spell or ability
        env.did.push(`${nameTag(t)}'s ward counters it`);
        env.wardCountered = true;
        return [];
      }
    }
    kept.push(r);
  }
  // "Whenever ~ becomes the target of a spell" (Goldspan Dragon, heroic-style cards)
  for (const r of kept) if (r.iid && card(r.iid) && card(r.iid).zone === 'battlefield') queueEvent({ type: 'becomesTarget', iid: r.iid, bySpell: Object.prototype.hasOwnProperty.call(env, 'castFrom'), controller: me });
  return kept;
}

// Ward: the caster pays the ward cost or the spell/ability is countered. Returns true if paid (or no ward).
export async function payWard(me, t, chooser, src, choosers) {
  const w = wardCost(t);
  if (!w) return true;
  const label = `Ward on ${cardName(t)}`;
  if (w.n !== undefined && !w.waterbend) return chooser.payUnless(w.n, label, w);
  if (w.n !== undefined) return chooser.payUnless(w.n, label, w);
  const ai = isAI(me);
  if (w.life !== undefined) {
    if (G.s.players[me].life < w.life) return false;
    if (ai) {
      if (G.s.players[me].life <= w.life + 5) return false;
    } else if (!(await chooser.confirm(label, `Pay ${w.life} life? If you don't, your spell or ability is countered.`, {}))) return false;
    changeLife(me, -w.life);
    log(me, `${who(me) === 'you' ? 'You pay' : 'The AI pays'} ${w.life} life for ${nameTag(t)}'s ward.`);
    return true;
  }
  // everything else: one or more parts ("{2}, Pay 3 life"), possibly a choice ("Discard a card or pay {3}")
  let text = w.other;
  const alts = text.split(/ or (?=pay |discard |sacrifice |\{)/i);
  if (alts.length > 1) {
    const fits = (x) => wardPartsPayable(me, t, x);
    const ok = alts.map((x, k) => ({ x, k })).filter((o) => fits(o.x));
    if (!ok.length) return false;
    if (ai) text = ok[ok.length - 1].x; // the AI prefers paying mana (listed last) over discarding
    else {
      const k = await chooser.choose({ prompt: `${label}: pay which? (If you don't, your spell or ability is countered.)`, options: [...ok.map((o) => ({ label: o.x })), { label: "Don't pay" }], aiPick: () => 0 });
      if (k === null || k === undefined || k < 0 || k >= ok.length) return false;
      text = ok[k].x;
    }
  } else {
    if (!wardPartsPayable(me, t, text)) return false;
    if (ai) {
      // the AI won't take five poison counters or sacrifice most of its board for one spell
      if (/poison/i.test(text) && (G.s.players[me].poison || 0) + 5 >= 8) return false;
      if (/sacrifice (?:two|three)/i.test(text)) return false;
    } else if (!(await chooser.confirm(label, `${text}? If you don't, your spell or ability is countered.`, {}))) return false;
  }
  const { payOtherCost, applyPayment } = await import('./cast.js');
  const { aiPay } = await import('./ai.js');
  const pay = async (pid, cost, lbl, o) => (isAI(pid) ? aiPay(pid, cost, lbl, o) : T && T.payPlayer ? T.payPlayer(cost, lbl, o) : null);
  for (let part of text.split(/, (?=pay|discard|sacrifice|\{|get|collect|blight|exile|tap|return|remove)/i)) {
    part = part.trim().replace(/\.$/, '');
    let m;
    if ((m = part.match(/^(?:pay )?((?:\{\d+\})+)$/i))) {
      const n = (m[1].match(/\d+/g) || []).reduce((a, x) => a + +x, 0);
      if (!(await chooser.payUnless(n, label, { n }))) return false;
      continue;
    }
    if ((m = part.match(/^pay (\d+) life$/i))) {
      if (G.s.players[me].life < +m[1]) return false;
      changeLife(me, -+m[1]);
      continue;
    }
    if ((m = part.match(/^get (\w+) poison counters?$/i))) {
      G.s.players[me].poison = (G.s.players[me].poison || 0) + n(m[1]);
      log(me, `${who(me) === 'you' ? 'You get' : 'The AI gets'} ${n(m[1])} poison counters (ward).`);
      continue;
    }
    if (/^discard a card at random$/i.test(part)) {
      const hand = cardsIn(me, 'hand');
      if (!hand.length) return false;
      const pick = hand[Math.floor(Math.random() * hand.length)];
      log(me, `${who(me) === 'you' ? 'You discard' : 'The AI discards'} ${nameTag(pick)} at random (ward).`);
      discardCard(pick.iid);
      continue;
    }
    if ((m = part.match(/^discard (?:a|an) ([a-z ,]+?) card$/i))) {
      const kinds = m[1].split(/,? or |, /).map((x) => x.trim()).filter(Boolean);
      const pool = cardsIn(me, 'hand').filter((x) => kinds.some((k) => matchesFilter(x, k)));
      if (!pool.length) return false;
      const [pick] = await (choosers || { [me]: chooser })[me].pickCards({ forced: true, prompt: `${label}: discard a ${m[1]} card`, cards: pool.map((x) => x.iid), min: 1, max: 1, purpose: 'discard', src: t, aiScore: (x) => -(DB[x.def].cmc || 0) });
      if (!pick) return false;
      discardCard(pick);
      continue;
    }
    try {
      if (!(await payOtherCost(me, part.toLowerCase(), src || t, { choosers: choosers || { [me]: chooser }, pay, applyPayment }))) return false;
    } catch (e) {
      if (e instanceof Cancelled) return false;
      throw e;
    }
  }
  return true;
}
// Can this player pay these ward parts at all? (Checked before asking.)
function wardPartsPayable(pid, t, text) {
  for (let part of String(text).split(/, (?=pay|discard|sacrifice|\{|get|collect|blight)/i)) {
    part = part.trim().replace(/\.$/, '').toLowerCase();
    let m;
    if ((m = part.match(/^(?:pay )?((?:\{\d+\})+)$/))) {
      const k = (m[1].match(/\d+/g) || []).reduce((a, x) => a + +x, 0);
      if (castMod && !payCost(`{${k}}`, castMod.manaSources(pid))) return false;
    } else if ((m = part.match(/^pay (\d+) life$/))) {
      if (G.s.players[pid].life < +m[1]) return false;
    } else if (/^discard/.test(part)) {
      if (!cardsIn(pid, 'hand').length) return false;
      const dm = part.match(/^discard (?:a|an) ([a-z ,]+?) card$/);
      if (dm && dm[1] !== 'card') {
        const kinds = dm[1].split(/,? or |, /).map((x) => x.trim()).filter(Boolean);
        if (!cardsIn(pid, 'hand').some((x) => kinds.some((k) => matchesFilter(x, k)))) return false;
      }
    } else if ((m = part.match(/^sacrifice (a|an|one|two|three|\d+) (.+)$/))) {
      const k = n(m[1]);
      const kinds = m[2].replace(/s$/, '').split(/ or /);
      if (cardsIn(pid, 'battlefield').filter((x) => kinds.some((kk) => matchesFilter(x, kk.replace(/s\b/, '')))).length < k) return false;
    }
  }
  return true;
}

function wardCost(c) {
  if (c.faceDown && c.wardTwo) return { n: 2, raw: '{2}' };
  // Gold-Forged Thopteryx: "Each legendary permanent you control has ward {2}."
  if (c.zone === 'battlefield' && /Legendary/.test(typeLine(c))) {
    for (const x of cardsIn(c.controller, 'battlefield')) {
      const wm = !abilitiesGone(x) && oracle(x).match(/Each legendary permanent you control has ward \{(\d+)\}/i);
      if (wm) return { n: +wm[1], raw: `{${wm[1]}}` };
    }
  }
  const o = oracle(c).replace(/ ?\([^)]*\)/g, '');
  // Minthara: "ward {X}, where X is the number of experience counters you have"
  const wx = o.match(/\bward \{X\}, where X is (?:the number of )?([^.\n]+)/i);
  if (wx) {
    const v = countPhrase(c.controller, wx[1], helpers, c.iid);
    return v ? { n: v, raw: `{${v}}` } : null;
  }
  // "Ward {2}", "Ward—Pay 3 life.", "Ward—Discard a card.", "Ward—{2}, Pay 3 life.", "Ward—Discard a card or pay {3}."
  // its own ward, or one given by something else (Bronze Guardian: "Other artifacts you control have ward {2}")
  const own = o.match(/(?:^|, )ward(?: \{(\d+)\}|—([^\n"]+?)(?:\.|"|$))/im);
  const given = c.zone === 'battlefield' ? grantsOf(c).map((g) => String(g).match(/^ward(?: \{(\d+)\}|—(.+?))\.?$/i)).find(Boolean) : null;
  let m = own || given;
  // Mishra, Tamer of Mak Fawa: 'Permanents you control have "Ward—Sacrifice a permanent."'
  if (!m && c.zone === 'battlefield')
    for (const x of cardsIn(c.controller, 'battlefield')) {
      if (abilitiesGone(x)) continue;
      const qm = oracle(x).match(/(?:^|\n)(other )?([a-z ]*?)(permanents|creatures|artifacts|enchantments|lands) you control have "ward(?: \{(\d+)\}|—([^"]+?))\.?"/i);
      if (qm && !(qm[1] && x.iid === c.iid) && matchesFilter(c, `${qm[2]}${qm[3].replace(/s$/, '')}`)) {
        m = [qm[0], qm[4], qm[5]];
        break;
      }
    }
  if (!m) return null;
  if (m[1]) return { n: +m[1], raw: `{${m[1]}}` };
  const raw = (m[2] || '').trim().replace(/~/g, cardName(c));
  const wb = raw.match(/^Waterbend \{(\d+)\}$/i);
  if (wb) return { n: +wb[1], waterbend: true, raw };
  const mana = raw.match(/^\{(\d+)\}$/);
  if (mana) return { n: +mana[1], raw };
  const life = raw.match(/^Pay (\d+) life$/i);
  if (life) return { life: +life[1], raw };
  // Phyrexian Fleshgorger, Raubahn: "Pay life equal to ~'s power"
  if (/^Pay life equal to .+'s power$/i.test(raw)) return { life: Math.max(0, power(c)), raw };
  return { other: raw, raw };
}

function playerHexproof(pid, caster, src) {
  if (src && playerProtectedFrom(pid, src)) return true;
  if (pid === caster) return false;
  if (G.s.players[pid].protectedUntil && G.s.turn < G.s.players[pid].protectedUntil) return true;
  return cardsIn(pid, 'battlefield').some((c) => /^You have (?:hexproof|shroud)/m.test(oracle(c)));
}

// Objects named by a phrase: "~", "it", "each creature you control", "target creature", "enchanted creature"…
async function objects(env, phrase, opts = {}) {
  let p = phrase.toLowerCase().trim().replace(/\.$/, '');
  // "destroy all creatures other than Magister of Worth" = "all other creatures"
  {
    const nm = env.src && DB[env.src.def] ? DB[env.src.def].name.split(' // ')[0].split(',')[0].toLowerCase() : '\u0000';
    const om = p.match(/^(each|all|every) (.+?) other than (.+)$/);
    if (om && (om[3] === '~' || om[3].startsWith(nm) || /^this (?:creature|permanent)$/.test(om[3]))) p = `${om[1]} other ${om[2]}`;
  }
  const me = env.me;
  if (/^(~|it|him|her|this creature|this permanent)$/.test(p)) {
    if (p === 'it' || p === 'him' || p === 'her') {
      if (env.it && env.it.iid && card(env.it.iid)) return [card(env.it.iid)];
      if (env.it && env.it.player) return [];
    }
    return env.src && card(env.src.iid) ? [card(env.src.iid)] : [];
  }
  if (/^(?:that creature|that permanent|that card|that land|that token|those creatures|them|the exiled card)$/.test(p)) {
    if (env.them_ && env.them_.length) return env.them_.map(card).filter(Boolean);
    return env.it && env.it.iid && card(env.it.iid) ? [card(env.it.iid)] : [];
  }
  if (/^(?:enchanted|equipped|fortified) (?:creature|permanent|land|artifact|planeswalker|enchantment)$/.test(p)) {
    const t = env.src && env.src.attachedTo && card(env.src.attachedTo);
    return t ? [t] : [];
  }
  if (/^(?:the )?(?:creature|permanent) (?:it'?s )?(?:enchanting|equipping)/.test(p)) {
    const t = env.src && env.src.attachedTo && card(env.src.attachedTo);
    return t ? [t] : [];
  }
  if (/target/.test(p) && !/^(?:each|all)\b/.test(p)) {
    const picks = await pickTargets(env, p.replace(/^.*?((?:up to \w+ |any number of |\w+ )?(?:another |other )?target .*)$/, '$1'), opts);
    env.it = picks[0] || null;
    env.them_ = picks.filter((x) => x.iid).map((x) => x.iid);
    return picks.filter((x) => x.iid).map((x) => card(x.iid)).filter(Boolean);
  }
  let m;
  // "each creature target player controls" (Contagion Engine), "each creature that player controls"
  if ((m = p.match(/^(?:each|all|every) (other |another )?(.+?) (target player|target opponent|that player|defending player|the defending player) controls$/))) {
    const pl = await playerTarget(env, m[3], opts.harm !== false);
    const filter = m[2].replace(/s\b/g, '') || 'permanent';
    if (pl && pl[0]) env.it = { player: pl[0] };
    return (pl || []).flatMap((pid) => cardsIn(pid, 'battlefield')).filter((c) => (!m[1] || c.iid !== (env.src || {}).iid) && matchesFilter(c, filter));
  }
  if ((m = p.match(/^(?:each|all|every) (other |another )?(.+)$/)) || (m = p.match(/^(other )?((?:[\w-]+ )*?(?:creatures|permanents|artifacts|enchantments|lands|planeswalkers|tokens|[A-Z]?[\w-]+s) (?:you control|your opponents control|an opponent controls))$/)) || (m = p.match(/^(other )?((?:attacking|blocking)(?: [\w-]+)*? (?:creatures|permanents))$/))) {
    const other = !!m[1];
    const rest = m[2];
    const pool = sidesFor(rest, me).flatMap((pid) => cardsIn(pid, 'battlefield'));
    const filter = rest.replace(/(?:you control|your opponents control|an opponent controls|on the battlefield)/, '').trim().replace(/s\b/g, '') || 'permanent';
    return pool.filter((c) => (!other || c.iid !== (env.src || {}).iid) && matchesFilter(c, filter));
  }
  if (/^~ and each other creature/.test(p)) return [env.src, ...(await objects(env, p.replace(/^~ and /, '')))].filter(Boolean);
  return [];
}

function playersOf(env, phrase) {
  const p = phrase.toLowerCase().trim();
  const me = env.me;
  if (/^(?:you|your)$/.test(p)) return [me];
  if (/^(?:each opponent|each of your opponents|your opponents)$/.test(p)) return opponents(me);
  if (/^(?:defending player|the defending player)$/.test(p)) return [defendingPlayer(env)];
  // one opponent: in 1v1 there's only one; in a pod "target opponent" is a choice (and "an opponent" goes to the focus)
  if (/^target opponent$/.test(p)) return opponents(me).length > 1 ? null : [opp(me)];
  if (/^an opponent$/.test(p)) return [opp(me)];
  if (/^(?:each player|all players|everyone)$/.test(p)) return [me, ...opponents(me)];
  if (/^(?:the )?player to your left$/.test(p)) return [leftOf(me)];
  if (/^(?:the )?player to your right$/.test(p)) return [rightOf(me)];
  if (/^(?:that player|its controller|its owner|their controller|that creature's controller|that permanent's controller|that spell's controller)$/.test(p)) {
    if (env.it && env.it.player) return [env.it.player];
    // "that player" is the player the trigger is about (Komainu: the damaged player), not the controller of "it"
    if (p === 'that player' && env.thatPlayer) return [env.thatPlayer];
    if (env.it && env.it.iid) {
      const c = card(env.it.iid);
      if (c && c.zone === 'battlefield') return [c.controller];
      // it has left the battlefield: "its controller" is whoever controlled it last ("its owner" is still the owner)
      if (/owner/.test(p)) { if (c) return [c.owner]; }
      else if (G.s.lastCtl && G.s.lastCtl[env.it.iid]) return [G.s.lastCtl[env.it.iid]];
      if (c) return [ctl(c)];
    }
    if (env.thatPlayer) return [env.thatPlayer];
    return [opp(me)];
  }
  if (/^target player$/.test(p)) return null; // needs a choice
  return [];
}

// The defending player for the source of this ability: whoever its attack is aimed at (or the controller of
// the planeswalker/battle it's attacking). In 1v1 that's always the opponent.
export function defendingPlayer(env) {
  if (!multiplayer()) return opp(env.me);
  const cb = G.s.combat;
  const src = env.src && env.src.iid;
  const t = cb && cb.targets && src && cb.targets[src];
  if (t && isPlayer(t)) return t;
  const tc = t && card(t);
  if (tc) return tc.protector || tc.controller;
  // the defending player during an opponent's attack is me
  if (cb && cb.by && cb.by !== env.me && Object.values(cb.targets || {}).includes(env.me)) return env.me;
  return opp(env.me);
}

async function playerTarget(env, phrase, harm = true) {
  const direct = playersOf(env, phrase);
  if (direct) return direct;
  const oppsOnly = /opponent/.test(String(phrase).toLowerCase());
  const pick = await env.choosers[env.me].target({
    ...(env.forced ? { forced: true } : {}),
    prompt: oppsOnly ? 'Choose an opponent' : `Choose a player`, candidates: [], players: (oppsOnly ? opponents(env.me) : [...opponents(env.me), env.me]).filter((p) => !playerHexproof(p, env.me, env.src)), harm, src: env.src,
  });
  return pick && pick.player ? [pick.player] : [];
}

// Power/toughness as it last was on the battlefield (with counters, Auras, pumps) once it has left
function lkiPT(c) {
  const live = card(c.iid);
  if ((!live || live.zone !== 'battlefield') && G.s.lki && G.s.lki[c.iid]) return G.s.lki[c.iid];
  return { p: power(c), t: toughness(c) };
}
function amountOf(word, env) {
  const w = String(word || '').toLowerCase().trim();
  if (/^x$/.test(w)) return env.x || 0;
  if (/^\d+$/.test(w) || WORDNUM[w]) return n(w, env.x);
  let m;
  if ((m = w.match(/^(?:damage )?equal to (?:~'s|its|his|her|that creature's|the sacrificed creature's|enchanted creature's|equipped creature's) power/))) {
    const it = /^(?:damage )?equal to (?:~'s|his|her)/.test(w) ? env.src : env.it && env.it.iid ? card(env.it.iid) : env.src;
    return it ? Math.max(0, lkiPT(it).p) : 0;
  }
  if ((m = w.match(/^(?:damage )?equal to (?:~'s|its|his|her|that creature's|the sacrificed creature's|enchanted creature's|equipped creature's) toughness/))) {
    const it = /^(?:damage )?equal to (?:~'s|his|her)/.test(w) ? env.src : env.it && env.it.iid ? card(env.it.iid) : env.src;
    return it ? Math.max(0, lkiPT(it).t) : 0;
  }
  if ((m = w.match(/^(?:damage )?equal to (?:that creature's|that permanent's|that card's|that spell's|its) (?:mana value|converted mana cost)/))) {
    const it = env.it && env.it.iid ? card(env.it.iid) : env.src;
    return it ? DB[it.def].cmc || 0 : 0;
  }
  // Astarion (Friends): "equal to the amount of life you gained this turn"
  if ((m = w.match(/^equal to the amount of life you (gained|lost) this turn$/))) return ((G.s.ts || {})[env.me] || {})[m[1] === 'gained' ? 'lifeGained' : 'lifeLost'] || 0;
  // The War Doctor: "equal to the number of time counters on it"
  if ((m = w.match(/^(?:damage )?equal to the number of ([a-z+\/0-9-]+) counters on (?:~|it|this [a-z]+)$/))) {
    const it = env.src && card(env.src.iid) ? card(env.src.iid) : env.src;
    return it ? (it.counters || {})[m[1]] || 0 : 0;
  }
  if ((m = w.match(/^(?:damage )?equal to (?:the number of |your )?(.+)$/))) {
    const v = countPhrase(env.me, m[1], helpers, env.src && env.src.iid);
    return v === null ? 0 : v;
  }
  return 0;
}

// ------------------------------------------------------------ the handlers
// Occult Epiphany: the AI favors discarding one card of each type
function varietyBonus(c, hand) {
  const tl = (DB[c.def].typeLine || '').split('—')[0];
  const types = tl.match(/Artifact|Creature|Enchantment|Instant|Land|Planeswalker|Sorcery|Battle/g) || [];
  // rarer types in hand are worth more as a discard (each new type is a token)
  return types.reduce((a, t) => a + 12 / hand.filter((h) => new RegExp(t).test(DB[h.def].typeLine || '')).length, 0);
}
async function mayAsk(env, what) {
  const yes = await env.choosers[env.me].confirm(`${cardName(env.src)}`, `You may ${what}`, env);
  env.lastMay = !!yes;
  return env.lastMay;
}

const H = [];
const on = (re, run, opts = {}) => (opts.first || on.first ? H.unshift({ re, run, ...opts }) : H.push({ re, run, ...opts }));

// --- counterspells
on(/^counter (target [^.]*?spell(?:,? activated ability, or triggered ability| or ability)?)(?:[^.]*?unless its controller pays \{(\d+|x)\})?(?: for each ([^.]+))?/, async (m, env) => {
  let tgt = env.stackTarget && card(env.stackTarget);
  // a prepared creature's spell copy: judge it as that spell (an instant/sorcery), not the creature
  const slot = G.s.stack && G.s.stack.iid === env.stackTarget ? G.s.stack : G.s.pstack && G.s.pstack.iid === env.stackTarget ? G.s.pstack : null;
  if (tgt && slot && slot.copyFace) tgt = { ...tgt, face: slot.copyFace };
  const filter = m[1].replace(/^target /, '').replace(/spell.*$/, '');
  if (!tgt) return env.did.push('has no spell to counter');
  // an activated ability on the stack: only "counter target … ability" can counter it
  if (G.s.stack && G.s.stack.ability) {
    // Stifle / Spider-Sense: "triggered ability"; Pithing-style "activated ability"; "ability" for either
    const se = env.sentence || m[0];
    const ok = G.s.stack.trigger ? /triggered ability|target ability|counter target activated or triggered ability/.test(se) : /activated ability|target ability/.test(se);
    if (!ok) return env.did.push(`can't counter that ${G.s.stack.trigger ? 'triggered' : 'activated'} ability`);
    G.s.stack.countered = true;
    return env.did.push(`counters ${nameTag(tgt)}'s ability`);
  }
  // "counter target instant spell, sorcery spell, or triggered ability" (Spider-Sense)
  const filt = /instant spell, sorcery spell/.test(env.sentence || '') ? 'instant or sorcery' : filter;
  if (!spellFilterOk(filt, tgt)) return env.did.push(`can't counter ${nameTag(tgt)} (wrong kind of spell)`);
  if (cantBeCountered(tgt)) return env.did.push(`${nameTag(tgt)} can't be countered`);
  if (m[2]) {
    const amt = m[2] === 'x' ? env.x : +m[2];
    const paid = await env.choosers[tgt.owner].payUnless(amt, cardName(env.src));
    if (paid) return env.did.push(`${who(tgt.owner)} ${s_(tgt.owner, 'pay')} {${amt}}, so ${nameTag(tgt)} isn't countered`);
  }
  G.s.stack.countered = true;
  if (/exile it instead|if that spell is countered this way, exile it/.test(env.text)) G.s.stack.exileCountered = true;
  env.it = { iid: tgt.iid };
  env.did.push(`counters ${whose(tgt)} ${nameTag(tgt)}`);
});
// Stifle, Tale's End, Disallow-style: "Counter target activated or triggered ability." / "Counter target triggered ability."
on(/^counter target (activated or triggered|triggered|activated)? ?ability(?: you don't control)?(?:\. if it's an ability of an artifact, creature, or planeswalker, that permanent's activated abilities can't be activated this turn)?$/, async (m, env) => {
  const st = G.s.stack;
  if (!st || !st.ability) return env.did.push('has no ability to counter');
  const kind = m[1] || 'activated or triggered';
  if (st.trigger ? !/triggered/.test(kind) : !/activated/.test(kind)) return env.did.push(`can't counter that ${st.trigger ? 'triggered' : 'activated'} ability`);
  st.countered = true;
  const src = card(st.iid);
  env.did.push(`counters ${src ? whose(src) + ' ' + nameTag(src) + "'s" : 'the'} ${st.trigger ? 'triggered' : 'activated'} ability`);
}, { first: true });
function cantBeCountered(c) {
  if (/(?:This spell|~) can't be countered|can't be countered\./i.test(face(c).oracle || '')) return true;
  return cardsIn(c.owner, 'battlefield').some((p) => /^(?:Spells|Creature spells|Noncreature spells) you control can't be countered/m.test(oracle(p)) &&
    (/^Spells/m.test(oracle(p)) || (/^Creature/m.test(oracle(p)) === /Creature/.test(DB[c.def].typeLine))));
}
// --- copy a spell
on(/^copy (target [^.]*?spell)(?: you control)?(?:\. you may choose new targets for the copy)?/, async (m, env) => {
  const tgt = env.stackTarget && card(env.stackTarget);
  if (!tgt) return env.did.push('has no spell to copy');
  const sub = await resolveEffects(spellText(tgt), tgt, { ...env, me: env.me, stackTarget: null });
  env.did.push(`copies ${nameTag(tgt)}${sub.length ? ': ' + sub.join('; ') : ''}`);
});

// --- destroy / exile / bounce / tuck
on(/^destroy (.+?)(?:\.? (?:it|they) can't be regenerated)?$/, async (m, env) => {
  const objs = await objects(env, m[1].replace(/\. .*$/, ''), { harm: true });
  const noRegen = /can't be regenerated/.test(env.sentence);
  let k = 0;
  env.thisWay = [];
  for (const c of objs) {
    const nm = `${whose(c)} ${nameTag(c)}`;
    const snap = { iid: c.iid, token: !!c.token, creature: isCreature(c), controller: c.controller, power: power(c), toughness: toughness(c) };
    if (destroy(c.iid, { noRegen })) {
      env.thisWay.push(snap);
      k++;
      if (objs.length <= 3) env.did.push(`destroys ${nm}`);
    } else if (objs.length <= 3) env.did.push(`${nm} survives`);
  }
  if (objs.length > 3) env.did.push(`destroys ${k} permanent${k === 1 ? '' : 's'}`);
});
// Sphinx of the Second Sun: "there is an additional beginning phase after this phase" (untap, upkeep, draw — then the end step)
on(/^there is an additional beginning phase after this phase$/, async (m, env) => {
  const cur = G.s.extraBeginning && G.s.extraBeginning.pid === env.me && G.s.extraBeginning.turn === G.s.turn ? G.s.extraBeginning : { pid: env.me, turn: G.s.turn, n: 0 };
  cur.n++;
  G.s.extraBeginning = cur;
  env.did.push('there will be an additional beginning phase (untap, upkeep, draw) after this main phase');
}, { first: true });
// Sen Triplets: "This turn, that player can't cast spells or activate abilities and plays with their hand revealed."
on(/^(?:this turn, )?(that player|target opponent|target player|each opponent) can't cast spells(?: or activate abilities)?(?: and plays with (?:their|his or her) hand revealed)?(?: this turn)?$/, async (m, env) => {
  let [pid] = /that player/.test(m[1]) ? [env.chosenPlayer || (env.it && env.it.player) || opp(env.me)] : /each opponent/.test(m[1]) ? [opp(env.me)] : await playerTarget(env, m[1]);
  if (!pid) pid = opp(env.me);
  G.s.silenced = { pid, turn: G.s.turn };
  if (/activate abilities/.test(env.sentence)) G.s.noAbilities = { pid, turn: G.s.turn };
  if (/hand revealed/.test(env.sentence)) G.s.handRevealed = { pid, turn: G.s.turn };
  env.it = { player: pid };
  env.did.push(`${who(pid)} can't cast spells${/activate abilities/.test(env.sentence) ? ' or activate abilities' : ''} this turn`);
}, { first: true });
// "You may play lands and cast spells from that player's hand this turn."
on(/^(?:you may )?(?:play lands and )?cast spells from (?:that player's|target opponent's|an opponent's) hand this turn$/, async (m, env) => {
  const of = env.chosenPlayer || (env.it && env.it.player) || opp(env.me);
  G.s.handControl = { by: env.me, of, turn: G.s.turn, lands: /play lands/.test(env.sentence) };
  G.s.handRevealed = { pid: of, turn: G.s.turn };
  env.did.push(`${who(env.me)} may play lands and cast spells from ${seatPoss(of)} hand this turn`);
}, { first: true });
// "Choose target opponent." (sets up "that player" for the next sentence)
on(/^choose target (opponent|player)$/, async (m, env) => {
  const [pid] = await playerTarget(env, 'target ' + m[1]);
  env.it = { player: pid || opp(env.me) };
  env.chosenPlayer = env.it.player;
}, { first: true });
// Mindslaver, Emrakul the Promised End, Worst Fears: "You control target player during that player's next turn."
on(/^(?:you )?(?:gain )?control (?:of )?(target (?:player|opponent)) during that player's next turn$/, async (m, env) => {
  const [pid] = await playerTarget(env, m[1]);
  const of = pid || opp(env.me);
  if (of === env.me) return env.did.push('controls their own next turn (nothing changes)');
  G.s.slaveNext = { by: env.me, of };
  env.it = { player: of };
  env.did.push(`${who(env.me)} will control ${seatName(of)} during ${of === 'p' ? 'your' : 'its'} next turn`);
}, { first: true });
// Emrakul, the Promised End: "After that turn, that player takes an extra turn."
on(/^after that turn, that player takes an extra turn$/, async (m, env) => {
  if (G.s.slaveNext) G.s.slaveNext.extraAfter = true;
  env.did.push('after that turn, that player takes an extra turn');
}, { first: true });
// Ajani Steadfast: "Put a +1/+1 counter on each creature you control and a loyalty counter on each other planeswalker you control."
on(/^put a \+1\/\+1 counter on each creature you control and a loyalty counter on each other planeswalker you control$/, async (m, env) => {
  const cr = cardsIn(env.me, 'battlefield').filter(isCreature);
  const pw = cardsIn(env.me, 'battlefield').filter((c) => isType(c, 'Planeswalker') && c.iid !== (env.src || {}).iid);
  cr.forEach((c) => addCounters(c, '+1/+1', 1));
  pw.forEach((c) => addCounters(c, 'loyalty', 1));
  env.did.push(`puts a +1/+1 counter on ${cr.length} creature${cr.length === 1 ? '' : 's'} and a loyalty counter on ${pw.length} other planeswalker${pw.length === 1 ? '' : 's'}`);
}, { first: true });
// Tezzeret the Seeker, Stoneforge-style: "Search your library for an artifact card with mana value X or less, put it onto the battlefield, then shuffle."
on(/^search your library for an? ([a-z ]+?) card with mana value (x|\d+) or less, put it onto the battlefield(?: tapped)?, then shuffle$/, async (m, env) => {
  const cap = m[2] === 'x' ? env.x || 0 : +m[2];
  const pool = cardsIn(env.me, 'library').filter((c) => matchesFilter(c, m[1]) && (DB[c.def].cmc || 0) <= cap);
  const [pick] = pool.length ? await env.choosers[env.me].pickCards({ prompt: `Search for a ${m[1]} card with mana value ${cap} or less`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'tutor', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 }) : [];
  if (pick) toBattlefield(pick, env.me, { tapped: /tapped/.test(env.sentence) });
  shuffle(env.me);
  env.did.push(pick ? `puts ${nameTag(card(pick))} onto the battlefield` : 'finds nothing');
}, { first: true });
// Auntie Ool: "draw a card if you control that creature. If you don't control it, its controller loses 1 life."
on(/^draw a card if you control that creature$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  const mine = c && c.controller === env.me;
  env.lastMay = !!mine;
  if (mine) {
    draw(env.me, 1, true);
    env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} 1`);
  }
}, { first: true });
on(/^if you don't control it, its controller loses (\d+) life$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  const pid = c ? c.controller : env.thatPlayer;
  if (!pid || pid === env.me) return;
  changeLife(pid, -+m[1]);
  env.did.push(`${who(pid)} ${s_(pid, 'lose')} ${m[1]} life`);
}, { first: true });
// Qarsi Revenant (Renew): "Put a flying counter, a deathtouch counter, and a lifelink counter on target creature."
on(/^put ((?:an? [a-z+\/0-9-]+ counter,? (?:and )?)+)on (target [a-z ]+?)$/, async (m, env) => {
  const kinds = [...m[1].matchAll(/an? ([a-z+\/0-9-]+) counter/g)].map((x) => x[1]);
  if (kinds.length < 2) return 'pass';
  const objs = await objects(env, m[2], { harm: kinds.every((k) => k.startsWith('-') || k === 'stun') });
  for (const c of objs) for (const k of kinds) addCounters(c, k, 1);
  env.did.push(objs.length ? `puts ${kinds.join(', ')} counters on ${objs.map(nameTag).join(', ')}` : 'finds no target');
}, { first: true });
// The Reaper, King No More: "Put a -1/-1 counter on each of up to two target creatures."
on(/^put an? ([+-]\d+\/[+-]\d+|[a-z]+) counter on each of (up to (?:one|two|three|four|x)|two|three|four|x) target ([a-z ]+?)$/, async (m, env) => {
  if (/(?:^|\s)x$/.test(m[2]) && !env.x) return env.did.push('puts no counters (X is 0)');
  const objs = await objects(env, `${m[2]} target ${m[3]}`, { harm: m[1].startsWith('-') || m[1] === 'stun' || m[1] === 'decayed' });
  for (const c of objs) addCounters(c, m[1], 1);
  env.did.push(`puts a ${m[1]} counter on ${objs.length ? objs.map(nameTag).join(', ') : 'nothing'}`);
}, { first: true });
// Dread Tiller: "put a land card from your hand or graveyard onto the battlefield tapped"
on(/^put a land card from your hand or graveyard onto the battlefield( tapped)?$/, async (m, env) => {
  const pool = [...cardsIn(env.me, 'hand'), ...cardsIn(env.me, 'graveyard')].filter(isLand);
  if (!pool.length) return env.did.push('has no land to put onto the battlefield');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'Put a land card from your hand or graveyard onto the battlefield', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'cheat', src: env.src, aiScore: (c) => (c.zone === 'graveyard' ? 2 : 1) });
  if (!pick) return;
  toBattlefield(pick, env.me, { tapped: !!m[1] });
  env.did.push(`puts ${nameTag(card(pick))} onto the battlefield${m[1] ? ' tapped' : ''}`);
}, { first: true });
// Blight N (Lorwyn Eclipsed): "put N -1/-1 counters on a creature you control"
on(/^blight (\d+|x)$/, async (m, env) => {
  const k = n(m[1], env.x);
  const pool = cardsIn(env.me, 'battlefield').filter(isCreature);
  if (!pool.length) {
    env.lastMay = false;
    return env.did.push(`can't blight (no creature)`);
  }
  const [pick] = await env.choosers[env.me].pickCards({ forced: true, prompt: `Blight ${k}: put ${k} -1/-1 counter${k > 1 ? 's' : ''} on a creature you control`, cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'blight', src: env.src, aiScore: (c) => (c.token ? 5 : 0) + toughness(c) - cardValue(c) / 3 });
  const c = pick && card(pick);
  if (!c) return;
  addCounters(c, '-1/-1', k, { by: env.me });
  env.it = { iid: c.iid };
  env.blighted = c.iid;
  env.lastMay = true;
  env.did.push(`blights ${k} (${nameTag(c)})`);
}, { first: true });
// Mass Polymorph / Synthetic Destiny: reveal until N creature cards, put them all onto the battlefield, shuffle the rest in
export function revealCreaturesOnto(pid, k) {
  const lib = zoneOf(pid, 'library');
  const found = [];
  const rest = [];
  while (lib.length && found.length < k) {
    const iid = lib[lib.length - 1];
    move(iid, 'exile');
    if (isCreature({ ...card(iid), zone: 'battlefield' })) found.push(iid);
    else rest.push(iid);
  }
  for (const i of found) toBattlefield(i, pid);
  for (const i of rest) move(i, 'library');
  shuffle(pid);
  log(pid, `${pid === 'p' ? 'You reveal' : 'The AI reveals'} ${found.length + rest.length} cards and ${pid === 'p' ? 'put' : 'puts'} ${found.length ? found.map((i) => nameTag(card(i))).join(', ') : 'nothing'} onto the battlefield.`);
  return found;
}
on(/^exile all creatures you control, then reveal cards from the top of your library until you reveal that many creature cards\. put all creature cards revealed this way onto the battlefield, then shuffle the rest of the revealed cards into your library$/, async (m, env) => {
  const mine = cardsIn(env.me, 'battlefield').filter(isCreature);
  mine.forEach((c) => move(c.iid, 'exile'));
  const got = revealCreaturesOnto(env.me, mine.length);
  env.did.push(`exiles ${mine.length} creature${mine.length === 1 ? '' : 's'} and puts ${got.length} onto the battlefield`);
}, { first: true, multi: true });
on(/^exile all creatures you control\. at the beginning of the next end step, reveal cards from the top of your library until you reveal that many creature cards, put all creature cards revealed this way onto the battlefield, then shuffle the rest of the revealed cards into your library$/, async (m, env) => {
  const mine = cardsIn(env.me, 'battlefield').filter(isCreature);
  mine.forEach((c) => move(c.iid, 'exile'));
  G.s.delayed.push({ at: 'endStep', kind: 'revealCreatures', pid: env.me, n: mine.length });
  env.did.push(`exiles ${mine.length} creature${mine.length === 1 ? '' : 's'}; at the next end step, that many creatures come from the library`);
}, { first: true, multi: true });
// Teferi's Reproach: "Choose target opponent. Until that player's next turn, they gain protection from everything and their life total can't change. All nonland permanents they control phase out."
on(/^until that player's next turn, they gain protection from everything and their life total can't change$/, async (m, env) => {
  const pid = env.chosenPlayer || (env.it && env.it.player) || opp(env.me);
  const until = G.s.turn + (G.s.active === pid ? 2 : 1);
  G.s.players[pid].protectedUntil = until;
  G.s.players[pid].lifeLocked = until;
  env.did.push(`${who(pid)} ${pid === 'p' ? 'gain' : 'gains'} protection from everything until ${pid === 'p' ? 'your' : 'its'} next turn`);
}, { first: true });
on(/^all nonland permanents they control phase out$/, async (m, env) => {
  const pid = env.chosenPlayer || (env.it && env.it.player) || opp(env.me);
  const list = cardsIn(pid, 'battlefield').filter((c) => !isLand(c));
  for (const c of list) {
    c.phasedOut = true;
  }
  env.did.push(`${list.length} nonland permanent${list.length === 1 ? '' : 's'} phase out`);
}, { first: true });
// Heroic Sacrifice
on(/^choose target creature you control\. until end of turn, all damage that would be dealt to you and creatures you control is dealt to the chosen creature instead(?: \(if it's still on the battlefield\))?\. when that creature dies this turn, put its counters on up to one target creature you control and draw a card$/, async (m, env) => {
  const [pk] = await pickTargets(env, 'target creature you control', { harm: false });
  const t = pk && card(pk.iid);
  if (!t) return;
  G.s.redirect = { pid: env.me, iid: t.iid, turn: G.s.turn, onDie: true };
  env.did.push(`all damage to ${seatName(env.me)} and ${env.me === 'p' ? 'your' : 'its'} creatures is dealt to ${nameTag(t)} this turn`);
}, { first: true, multi: true });
// Captain Marvel: "you may put the same number and kind of counters on ~"
on(/^(?:you may )?put the same number and kind of counters on ~$/, async (m, env) => {
  if (!env.counterKind || !env.src || env.src.zone !== 'battlefield') return;
  addCounters(env.src, env.counterKind, env.thatMuch || 1);
  env.did.push(`puts ${env.thatMuch || 1} ${env.counterKind} counter${(env.thatMuch || 1) === 1 ? '' : 's'} on ${nameTag(env.src)}`);
}, { first: true });
// Black Widow: "put a +1/+1 counter on ~ and you draw a card"
on(/^put a \+1\/\+1 counter on ~ and you draw a card$/, async (m, env) => {
  if (env.src && env.src.zone === 'battlefield') addCounters(env.src, '+1/+1', 1);
  draw(env.me, 1, true);
  env.did.push(`puts a +1/+1 counter on ${nameTag(env.src)} and draws a card`);
}, { first: true });
// Photon: "add that much mana of any one color"
on(/^add that much mana of any one color$/, async (m, env) => {
  const k = env.thatMuch || env.lastAmount || 0;
  if (!k) return;
  const col = await chooseManaColor(env, `${cardName(env.src)}: add ${k} mana of which color?`);
  addMana(env.me, Array.from({ length: k }, () => col));
  env.lastManaAdded = { sym: col, n: k };
  env.did.push(`adds ${k} ${{ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' }[col]} mana`);
}, { first: true });
// "any one color": you pick (the AI picks what its hand needs most)
async function chooseManaColor(env, prompt) {
  const cols = ['W', 'U', 'B', 'R', 'G'];
  const names = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
  const need = (col) => cardsIn(env.me, 'hand').reduce((a, c) => a + ((DB[c.def].manaCost || '').match(new RegExp('\\{' + col + '\\}', 'g')) || []).length, 0);
  const best = cols.slice().sort((a, b) => need(b) - need(a))[0];
  const k = await env.choosers[env.me].choose({ prompt, options: cols.map((x) => ({ label: names[x] })), aiPick: () => cols.indexOf(best) });
  return cols[k] || best;
}
// Photon: the mana it added stays in your pool until the end of the turn
on(/^until end of turn, you don't lose this mana as steps and phases end$/, async (m, env) => {
  const a = env.lastManaAdded;
  if (!a) return;
  const keep = (G.s.keepMana = G.s.keepMana || {});
  const prev = keep[env.me] && keep[env.me].turn === G.s.turn ? keep[env.me].list : [];
  keep[env.me] = { turn: G.s.turn, list: [...prev, ...(a.list || Array.from({ length: a.n }, () => a.sym))] };
  env.did.push('that mana stays until end of turn');
}, { first: true });
// Niv-Mizzet, Ghost Counsel: "you may pay that much life. if you do, draw that many cards"
on(/^(?:you may )?pay that much life\. if you do, draw that many cards$/, async (m, env) => {
  const k = env.thatMuch || 0;
  if (!k) return;
  const pl = G.s.players[env.me];
  // you already said yes to the trigger (which showed the amount): don't ask a second time
  const yes = isAI(env.me) ? pl.life - k >= 15 && pl.life - k > 5 : env.lastMay === true ? true : await env.choosers.p.confirm(cardName(env.src), `Pay ${k} life to draw ${k} card${k === 1 ? '' : 's'}?`);
  if (!yes) return;
  changeLife(env.me, -k, false);
  draw(env.me, k, true);
  env.did.push(`pays ${k} life and draws ${k}`);
}, { first: true, multi: true });
// Eventide's Shadow
on(/^remove any number of counters from among permanents on the battlefield\. you draw cards and lose life equal to the number of counters removed this way$/, async (m, env) => {
  const all = seats().flatMap((k) => cardsIn(k, 'battlefield')).filter((c) => Object.values(c.counters || {}).some((k) => k > 0));
  let picks;
  if (isAI(env.me)) {
    const budget = Math.max(0, G.s.players[env.me].life - 12);
    picks = [];
    let tot = 0;
    for (const c of all.filter((c) => c.controller !== env.me).sort((a, b) => cardValue(b) - cardValue(a))) {
      const k = Object.entries(c.counters).filter(([kk, v]) => v > 0 && !/^-1/.test(kk)).reduce((a, [, v]) => a + v, 0);
      if (!k || tot + k > budget) continue;
      tot += k;
      picks.push(c.iid);
    }
  } else picks = await env.choosers.p.pickCards({ prompt: 'Remove all counters from which permanents?', cards: all.map((c) => c.iid), min: 0, max: all.length, purpose: 'counters', src: env.src });
  let total = 0;
  for (const i of picks) {
    const c = card(i);
    for (const [k, v] of Object.entries(c.counters || {})) {
      if (!(v > 0)) continue;
      total += v;
      if (k === 'loyalty') c.counters.loyalty = 0;
      else delete c.counters[k];
    }
  }
  if (total) {
    draw(env.me, total, true);
    changeLife(env.me, -total, false);
  }
  env.did.push(`removes ${total} counter${total === 1 ? '' : 's'}, draws ${total} and loses ${total} life`);
}, { first: true, multi: true });
// Aberrant Return
on(/^put one, two, or three target creature cards from graveyards onto the battlefield under your control\. each of them enters with an additional -1\/-1 counter on it$/, async (m, env) => {
  const pool = seats().flatMap((k) => cardsIn(k, 'graveyard')).filter((c) => /Creature/.test(DB[c.def].typeLine || ''));
  const picks = await env.choosers[env.me].pickCards({ prompt: 'Choose one to three creature cards from graveyards', cards: pool.map((c) => c.iid), min: Math.min(1, pool.length), max: 3, purpose: 'reanimate', src: env.src, aiScore: (c) => cardValue(c) });
  for (const i of picks) {
    toBattlefield(i, env.me);
    if (card(i)) addCounters(card(i), '-1/-1', 1);
  }
  env.did.push(picks.length ? `puts ${picks.map((i) => nameTag(card(i))).join(', ')} onto the battlefield` : 'finds no creature cards');
}, { first: true, multi: true });
// Winter Soldier / Heroic Return: "If a Hero enters this way, it enters with (an|two) additional +1/+1 counter(s) on it."
on(/^if a ([a-z]+) enters this way, it enters with (an|two|three) additional \+1\/\+1 counters? on it$/, async (m, env) => {
  const c = (env.it && card(env.it.iid)) || (env.lastReturned && card(env.lastReturned));
  if (!c || c.zone !== 'battlefield' || !hasSubtype(c, m[1])) return;
  const k = m[2] === 'an' ? 1 : n(m[2]);
  addCounters(c, '+1/+1', k);
  env.did.push(`${nameTag(c)} gets ${k} extra +1/+1 counter${k === 1 ? '' : 's'}`);
}, { first: true });
// Oft-Nabbed Goat
on(/^its owner draws (?:x|\d+) cards? and each other player loses (?:x|\d+) life(?:, where x is the number of -1\/-1 counters on it)?$/, async (m, env) => {
  const k = (env.deadCounters || {})['-1/-1'] || 0;
  if (!k) return env.did.push('had no -1/-1 counters');
  const owner = (env.event && env.event.owner) || env.me;
  draw(owner, k, true);
  changeLife(opp(owner), -k, false);
  env.did.push(`${who(owner)} ${s_(owner, 'draw')} ${k} and ${who(opp(owner))} ${s_(opp(owner), 'lose')} ${k} life`);
}, { first: true });
// The Ur-Sphinx
on(/^each player mills that many cards\. for each player, you may cast a card that player milled this way without paying its mana cost$/, async (m, env) => {
  const k = env.thatMuch || 1;
  const milled = [];
  for (const pid of seats()) {
    const ids = libTop(pid, k);
    ids.forEach((i) => move(i, 'graveyard'));
    milled.push(ids);
  }
  env.did.push(`each player mills ${k}`);
  for (const ids of milled) {
    const pool = ids.filter((i) => card(i) && card(i).zone === 'graveyard' && !isLand(card(i)));
    if (!pool.length) continue;
    const [pick] = await env.choosers[env.me].pickCards({ prompt: 'You may cast one of the milled cards for free', cards: pool, min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
    if (pick && (env.castFree || T.castFree)) {
      env.did.push(`casts ${nameTag(card(pick))} for free`);
      await (env.castFree || T.castFree)(env.me, pick, {});
    }
  }
}, { first: true, multi: true });
// Nissa, Leyline Tamer
on(/^reveal cards from the top of your library until you reveal a (creature|land|artifact|noncreature|nonland) card\. put that card onto the battlefield and the rest on the bottom of your library in a random order$/, async (m, env) => {
  const lib = zoneOf(env.me, 'library');
  const rest = [];
  let hit = null;
  while (lib.length) {
    const i = lib[lib.length - 1];
    move(i, 'exile');
    const tl = DB[card(i).def].typeLine || '';
    const want = m[1] === 'creature' ? /Creature/.test(tl) : m[1] === 'land' ? /Land/.test(tl) : m[1] === 'artifact' ? /Artifact/.test(tl) : m[1] === 'noncreature' ? !/Creature/.test(tl) : !/Land/.test(tl);
    if (want) {
      hit = i;
      break;
    }
    rest.push(i);
  }
  if (hit) toBattlefield(hit, env.me);
  for (const i of rest.sort(() => Math.random() - 0.5)) move(i, 'library', { to: 'bottom' });
  env.did.push(hit ? `puts ${nameTag(card(hit))} onto the battlefield` : 'finds no creature');
}, { first: true, multi: true });
// Love on the Battlefield: "Whenever either of those creatures deals combat damage to a player this combat, put a +1/+1 counter on it."
on(/^whenever either of those creatures deals combat damage to a player this combat, put a \+1\/\+1 counter on it$/, async (m, env) => {
  for (const i of env.trigThem || env.them_ || []) if (card(i)) card(i).loveTurn = G.s.turn;
}, { first: true });
// Gift of Immortality
on(/^return ~ to the battlefield attached to that creature at the beginning of the next end step$/, async (m, env) => {
  const host = env.it && env.it.iid;
  if (!env.src) return;
  G.s.delayed.push({ at: 'endStep', kind: 'returnAttached', iid: env.src.iid, host, pid: env.src.owner || env.me });
  env.did.push(`${nameTag(env.src)} will return attached at the next end step`);
}, { first: true });
// Arcane Denial: "Its controller may draw up to two cards at the beginning of the next turn's upkeep. You draw a card at the beginning of the next turn's upkeep."
on(/^(its controller |you )?(?:may )?draws? (up to )?(a|one|two|three) cards? at the beginning of the next turn's upkeep$/, async (m, env) => {
  const tc = env.it && env.it.iid && card(env.it.iid);
  const pid = !m[1] || m[1] === 'you ' ? env.me : tc ? tc.controller || tc.owner : env.it && env.it.player;
  if (!pid) return;
  const k = m[3] === 'a' ? 1 : n(m[3]);
  G.s.delayed.push({ at: 'nextUpkeep', pid, n: k, upTo: !!m[2], after: G.s.turn, why: env.src ? cardName(env.src) : 'delayed draw' });
  env.did.push(`${who(pid)} will draw ${k} at the next upkeep`);
}, { first: true });
// She-Hulk: "put a +1/+1 counter on that Hero for each creature blocking it"
on(/^put a \+1\/\+1 counter on that [a-z]+ for each creature blocking it$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  const k = env.thatMuch || 0;
  if (!c || !k) return;
  addCounters(c, '+1/+1', k);
  env.did.push(`puts ${k} +1/+1 counter${k === 1 ? '' : 's'} on ${nameTag(c)}`);
}, { first: true });
// Hercules: "put that many +1/+1 counters on him"
on(/^put (that many|a|an|one|two|three) \+1\/\+1 counters? on (?:him|her)$/, async (m, env) => {
  const c = env.src && card(env.src.iid);
  const k = m[1] === 'that many' ? env.thatMuch || env.lastAmount || 0 : n(m[1] === 'a' || m[1] === 'an' ? 'one' : m[1]);
  if (!c || c.zone !== 'battlefield' || !k) return;
  addCounters(c, '+1/+1', k);
  env.did.push(`puts ${k} +1/+1 counter${k === 1 ? '' : 's'} on ${nameTag(c)}`);
}, { first: true });
on(/^(?:he|she) gains ([a-z ]+) until end of turn$/, async (m, env) => {
  const c = env.src && card(env.src.iid);
  if (!c || c.zone !== 'battlefield') return;
  c.eotGrants = [...(c.eotGrants || []), m[1]];
  env.did.push(`${nameTag(c)} gains ${m[1]} until end of turn`);
}, { first: true });
// Tamiyo, Upriser Crowned
on(/^tap those creatures and put a stun counter on each of them$/, async (m, env) => {
  const ids = (env.them_ || []).filter((i) => card(i) && card(i).zone === 'battlefield');
  for (const i of ids) {
    tapPerm(card(i));
    addCounters(card(i), 'stun', 1);
  }
  env.did.push(ids.length ? `taps and stuns ${ids.map((i) => nameTag(card(i))).join(', ')}` : 'finds no creatures');
}, { first: true });
// Captain America, Team Leader: "Put a +1/+1 counter on that Hero and a +1/+1 counter on ~."
on(/^put a \+1\/\+1 counter on that [a-z]+ and a \+1\/\+1 counter on ~$/, async (m, env) => {
  const that = env.it && card(env.it.iid);
  const me_ = env.src && card(env.src.iid);
  for (const c of [that, me_]) if (c && c.zone === 'battlefield') addCounters(c, '+1/+1', 1);
  env.did.push(`puts a +1/+1 counter on ${[that, me_].filter((c) => c && c.zone === 'battlefield').map(nameTag).join(' and ')}`);
}, { first: true });
// Currency Converter: "Whenever you discard a card, you may exile that card from your graveyard."
on(/^(?:you may )?exile (?:that card|it) from your graveyard$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  if (!c || c.zone !== 'graveyard') return env.did.push('the card is no longer in the graveyard');
  move(c.iid, 'exile');
  if (card(c.iid) && env.src) card(c.iid).exiledWith = env.src.iid;
  env.did.push(`exiles ${nameTag(c)}`);
}, { first: true });
// "{T}: Put a card exiled with ~ into your graveyard."
on(/^put a card exiled with ~ into (?:your|its owner's) graveyard$/, async (m, env) => {
  const pool = Object.values(G.s.cards).filter((c) => c.zone === 'exile' && env.src && c.exiledWith === env.src.iid);
  if (!pool.length) {
    env.it = null;
    return env.did.push(`has no cards exiled with ${nameTag(env.src)}`);
  }
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Put a card exiled with ${cardName(env.src)} into your graveyard`, cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'return', src: env.src, aiScore: (c) => (isLand(c) ? 1 : 2) });
  const c = card(pick);
  delete c.exiledWith;
  move(pick, 'graveyard');
  env.it = { iid: pick };
  env.refCard = pick; // later "if it's a land card" sentences still mean this card, even after tokens are made
  env.did.push(`puts ${nameTag(c)} into the graveyard`);
}, { first: true });
// Proteus Staff: "Put target creature on the bottom of its owner's library. That creature's controller reveals cards from the top of their library until they reveal a creature card. The player puts that card onto the battlefield and the rest on the bottom of their library in any order."
on(/^put target creature on the bottom of its owner's library\. that creature's controller reveals cards from the top of their library until they reveal a creature card\. (?:the|that) player puts that card onto the battlefield and the rest on the bottom of their library in (?:any|a random) order$/, async (m, env) => {
  const [t] = await objects(env, 'target creature', { harm: true });
  if (!t) return env.did.push('has no target');
  const ctl_ = t.controller;
  const owner = t.owner;
  move(t.iid, 'library', { to: 'bottom' });
  env.did.push(`puts ${nameTag(t)} on the bottom of ${seatPoss(owner)} library`);
  const lib = zoneOf(ctl_, 'library');
  const rest = [];
  let hit = null;
  for (let guard = 0; lib.length && guard < 999; guard++) {
    const i = lib[lib.length - 1];
    if (i === t.iid && rest.length + 1 >= lib.length) break; // only the bottomed creature is left
    move(i, 'exile');
    if (/Creature/.test(DB[card(i).def].typeLine || '') && i !== t.iid) {
      hit = i;
      break;
    }
    rest.push(i);
  }
  if (hit) toBattlefield(hit, ctl_);
  for (const i of rest) move(i, 'library', { to: 'bottom' });
  env.did.push(hit ? `${who(ctl_)} ${s_(ctl_, 'reveal')} ${rest.length + 1} card${rest.length ? 's' : ''} and ${s_(ctl_, 'put')} ${nameTag(card(hit))} onto the battlefield` : `${who(ctl_)} ${s_(ctl_, 'find')} no other creature`);
}, { first: true, multi: true });
// Cryptbreaker: "You draw a card and you lose 1 life."
on(/^(?:you )?draw (a|one|two|three) cards? and (?:you )?(lose|gain) (\d+) life$/, async (m, env) => {
  const k = m[1] === 'a' ? 1 : n(m[1]);
  draw(env.me, k, true);
  changeLife(env.me, m[2] === 'lose' ? -+m[3] : +m[3], false);
  env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${k} and ${s_(env.me, m[2])} ${m[3]} life`);
}, { first: true });
// King Narfi's Betrayal I: "Then you may exile a creature or planeswalker card from each graveyard."
on(/^(?:then )?(?:you may )?exile (?:a|an|up to one) ([a-z ]+?) card from each graveyard$/, async (m, env) => {
  const kinds = m[1].split(/ or /).map((x) => x.trim());
  const got = [];
  for (const pid of [...opponents(env.me), env.me]) {
    const pool = cardsIn(pid, 'graveyard').filter((c) => kinds.some((k) => matchesAny(c, k)));
    if (!pool.length) continue;
    const [pick] = await env.choosers[env.me].pickCards({ prompt: `You may exile a ${m[1]} card from ${seatPoss(pid)} graveyard`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'gy-exile', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
    if (!pick) continue;
    move(pick, 'exile');
    if (card(pick) && env.src) card(pick).exiledWith = env.src.iid;
    got.push(pick);
  }
  env.them_ = got;
  env.did.push(got.length ? `exiles ${got.map((i) => nameTag(card(i))).join(' and ')}` : 'exiles nothing');
}, { first: true });
// King Narfi's Betrayal II, III
on(/^(?:until end of turn, )?you may cast spells from among cards exiled with ~(, and you may spend mana as though it were mana of any (?:color|type) to cast those spells)?(?: until end of turn)?$/, async (m, env) => {
  const ids = Object.values(G.s.cards).filter((c) => c.zone === 'exile' && env.src && c.exiledWith === env.src.iid);
  for (const c of ids) Object.assign(c, { mayPlay: env.me, mayPlayUntil: G.s.turn, anyColorMana: !!m[1] });
  env.did.push(ids.length ? `may cast ${ids.map(nameTag).join(', ')} this turn${m[1] ? ' (with mana of any color)' : ''}` : 'has no exiled cards');
}, { first: true });
// ------------------------------------------------------------ theft: playing opponents' cards
// colored symbols become generic ("mana of any type/color can be spent")
function anyColorCost_(cost) {
  let gen = 0;
  const keep = [];
  for (const sym of String(cost || '').match(/\{[^}]+\}/g) || []) {
    const v = sym.slice(1, -1);
    if (/^\d+$/.test(v)) gen += +v;
    else if (/^[WUBRG](?:\/[WUBRGP])?$|^2\/[WUBRG]$/.test(v)) gen += /^2\//.test(v) ? 2 : 1;
    else keep.push(sym);
  }
  return keep.join('') + (gen ? `{${gen}}` : keep.length ? '' : '{0}');
}
const FOREVER = 1e9;
// let pid play these exiled cards: o.until (turn number), o.anyMana, o.castOnly (no lands), o.myTurnOnly, o.free
function grantPlay(ids, pid, o = {}) {
  const out = [];
  for (const i of ids) {
    const c = card(i);
    if (!c || c.zone !== 'exile') continue;
    if (o.free) Object.assign(c, { mayPlayFree: pid, mayPlayFreeUntil: o.until ?? FOREVER });
    else Object.assign(c, { mayPlay: pid, mayPlayUntil: o.until ?? FOREVER, anyColorMana: !!o.anyMana, castOnly: !!o.castOnly, myTurnOnly: !!o.myTurnOnly });
    if (o.hidden) c.hiddenExile = pid; // exiled face down: only the player who may play it can look at it
    if (o.ianSrc) c.ianSrc = o.ianSrc;
    out.push(i);
  }
  return out;
}
const anyManaText = (t) => /mana of any (?:type|color) can be spent|spend mana as though it were mana of any (?:type|color)/.test(t);
function exileTop(pid, k) {
  const ids = libTop(pid, k);
  ids.forEach((i) => move(i, 'exile'));
  return ids;
}
// exile from the top until a card matching test (returns { hit, all })
function exileUntil(pid, test) {
  const lib = zoneOf(pid, 'library');
  const all = [];
  let hit = null;
  while (lib.length) {
    const i = lib[lib.length - 1];
    move(i, 'exile');
    all.push(i);
    if (test(card(i))) {
      hit = i;
      break;
    }
  }
  return { hit, all };
}
const spellCards = (ids) => ids.filter((i) => card(i) && !isLandFace_(card(i)));
function isLandFace_(c) {
  return /\bLand\b/.test((DB[c.def].faces[0].typeLine || DB[c.def].typeLine || '').split('—')[0]);
}
// cast spells from a pool, one at a time: free, or paying (any-color) costs. Returns the cast iids.
async function castFromPool(env, ids, o = {}) {
  const cast_ = [];
  const max = o.max ?? 99;
  for (let k = 0; k < max; k++) {
    const pool = spellCards(ids).filter((i) => !cast_.includes(i) && card(i) && ['exile', 'graveyard', 'hand', 'library'].includes(card(i).zone));
    if (!pool.length || !T.castFree) break;
    let pick = null;
    try {
      [pick] = await env.choosers[env.me].pickCards({
        prompt: o.prompt || (o.free ? 'Cast a spell from among them without paying its mana cost?' : 'Cast a spell from among them?'),
        cards: pool, min: 0, max: 1, purpose: 'castFree', src: env.src, forced: true, aiScore: (c) => (DB[c.def].cmc || 0) + (o.free ? 2 : 0),
      });
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
      pick = null;
    }
    if (!pick) break;
    const c = card(pick);
    const cost = DB[c.def].faces[0].manaCost || DB[c.def].manaCost || '';
    // backing out of the free spell (e.g. cancelling its target) only skips the spell — the ability itself already happened
    let ok;
    try {
      ok = await T.castFree(env.me, pick, o.free ? {} : { cost: o.anyMana ? anyColorCost_(cost) : cost || '{0}', mode: 'impulse' });
    } catch (e) {
      if (!(e instanceof Cancelled)) throw e;
      ok = false;
    }
    if (ok === false) {
      if (isAI(env.me)) break; // couldn't pay
      continue;
    }
    cast_.push(pick);
    env.did.push(`casts ${nameTag(c)}${o.free ? ' for free' : ''}`);
  }
  return cast_;
}
const whoseLib = (pid) => (seatPoss(pid));

// Inspirit, Flagship Vessel: "put your choice of a +1/+1 counter or two charge counters on up to one other target artifact"
on(/^put your choice of an? ([+\-\d\/a-z]+) counter or (one|two|three|\w+) ([a-z]+) counters on up to one other target artifact(?: you control)?$/, async (m, env) => {
  const pool = cardsIn(env.me, 'battlefield').filter((c) => isType(c, 'Artifact') && (!env.src || c.iid !== env.src.iid) && canTarget(c, env.me, env.src));
  if (!pool.length) return env.did.push('has no other artifact');
  const wantsCharge = (c) => /^STATION \d+\+/m.test(oracle(c)) || /charge counter/i.test(oracle(c));
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Put a ${m[1]} counter or ${m[2]} ${m[3]} counters on up to one other artifact`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'counters', src: env.src, aiScore: (c) => (wantsCharge(c) ? 5 : 0) + (isCreature(c) ? 3 : 0) + cardValue(c) / 10 });
  const c = pick && card(pick);
  if (!c) return;
  const aiWant = wantsCharge(c) && !(isCreature(c) && !/^STATION/m.test(oracle(c))) ? 1 : 0;
  const k = await env.choosers[env.me].choose({ prompt: `${cardName(c)}: which counters?`, options: [{ label: `a ${m[1]} counter` }, { label: `${m[2]} ${m[3]} counters` }], aiPick: () => aiWant });
  if (k === 1) addCounters(c, m[3], n(m[2]));
  else addCounters(c, m[1], 1);
  env.did.push(`puts ${k === 1 ? `${m[2]} ${m[3]} counters` : `a ${m[1]} counter`} on ${nameTag(c)}`);
}, { first: true });
// Mathas, Fiend Seeker: 'For as long as that creature has a bounty counter on it, it has "When this creature dies, …"'
on(/^for as long as that creature has an? ([a-z]+) counter on it, it has "(.+)"$/, async (m, env, raw) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  if (!c || c.zone !== 'battlefield') return;
  const quoted = ((raw || '').match(/"(.+)"/) || [])[1] || m[2];
  const line = quoted.replace(/\b(?:this creature|~)\b/gi, '~').replace(/^\w/, (x) => x.toUpperCase());
  if (!(c.extraText || '').includes(line)) c.extraText = ((c.extraText || '') + '\n' + line).trim();
  env.did.push(`${nameTag(c)} has "${line.replace(/~/g, 'this creature')}" while it has a ${m[1]} counter`);
}, { first: true });
// Mathas's bounty: "each opponent draws a card and gains 2 life"
on(/^(each opponent|each player|target player|you) draws? (a|one|two|three|\d+) cards? and gains? (\d+) life$/, async (m, env) => {
  const pids = await playerTarget(env, m[1], false);
  for (const pid of pids) {
    draw(pid, n(m[2]), true);
    changeLife(pid, +m[3], false);
    env.did.push(`${who(pid)} ${s_(pid, 'draw')} ${n(m[2])} and ${s_(pid, 'gain')} ${m[3]} life`);
  }
}, { first: true });
// Mr. Foxglove
on(/^draw cards equal to the number of cards in defending player's hand minus the number of cards in your hand\. if you didn't draw cards this way, you may put a creature card from your hand onto the battlefield$/, async (m, env) => {
  const d = env.thatPlayer || opp(env.me);
  const k = Math.max(0, cardsIn(d, 'hand').length - cardsIn(env.me, 'hand').length);
  if (k > 0) {
    draw(env.me, k, true);
    return env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${k}`);
  }
  const pool = cardsIn(env.me, 'hand').filter(isCreature);
  if (!pool.length) return env.did.push('draws nothing and has no creature to put in');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'You may put a creature card from your hand onto the battlefield', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'cheat', src: env.src, aiScore: (c) => DB[c.def].cmc });
  if (!pick) return env.did.push('draws nothing');
  toBattlefield(pick, env.me);
  env.did.push(`puts ${nameTag(card(pick))} onto the battlefield`);
}, { first: true, multi: true });
// Nahiri's Resolve
on(/^exile any number of nontoken artifacts and\/or creatures you control\. return those cards to the battlefield under their owner's control at the beginning of your next upkeep$/, async (m, env) => {
  const pool = cardsIn(env.me, 'battlefield').filter((c) => !c.token && (isCreature(c) || isType(c, 'Artifact')));
  if (!pool.length) return env.did.push('has nothing to exile');
  // the AI blinks permanents with an enters ability (and nothing it needs untapped on the opponent's turn)
  const etb = (c) => /(?:^|\n)When(?:ever)? (?:~|this (?:creature|artifact)) enters/i.test(stripName(oracle(c), c));
  const picks = isAI(env.me) ? pool.filter((c) => etb(c) && !c.isCommander).map((c) => c.iid) : await env.choosers[env.me].pickCards({ prompt: 'Exile any number of nontoken artifacts and/or creatures (they return at your next upkeep)', cards: pool.map((c) => c.iid), min: 0, max: pool.length, purpose: 'blink', src: env.src, aiScore: (c) => (etb(c) && !c.isCommander ? 5 : -5) });
  const ids = picks.filter((i) => card(i));
  ids.forEach((i) => move(i, 'exile'));
  const gone = ids.filter((i) => card(i) && card(i).zone === 'exile');
  if (gone.length) {
    G.s.delayed = G.s.delayed || [];
    G.s.delayed.push({ at: 'upkeep', turnOf: env.me, after: G.s.turn, kind: 'returnExiled', ids: gone });
  }
  env.did.push(gone.length ? `exiles ${gone.map((i) => nameTag(card(i))).join(', ')} until the next upkeep` : 'exiles nothing');
}, { first: true, multi: true });
// Omo, Queen of Vesuva
on(/^put an? ([a-z]+) counter on each of up to one target land and up to one target creature$/, async (m, env) => {
  const lands = cardsIn(env.me, 'battlefield').filter((c) => isLand(c) && !(c.counters || {})[m[1]] && canTarget(c, env.me, env.src));
  const crs = cardsIn(env.me, 'battlefield').filter((c) => isCreature(c) && !isLand(c) && !(c.counters || {})[m[1]] && canTarget(c, env.me, env.src));
  const out = [];
  const [l] = lands.length ? await env.choosers[env.me].pickCards({ prompt: `Put an ${m[1]} counter on up to one target land`, cards: lands.map((c) => c.iid), min: 0, max: 1, purpose: 'counters', src: env.src, aiScore: (c) => (/Basic/.test(typeLine(c)) ? 1 : 3) - ((manaAbility(c) || { colors: [] }).colors.length) }) : [];
  if (l && card(l)) { addCounters(card(l), m[1], 1); out.push(nameTag(card(l))); }
  const [c] = crs.length ? await env.choosers[env.me].pickCards({ prompt: `Put an ${m[1]} counter on up to one target creature`, cards: crs.map((x) => x.iid), min: 0, max: 1, purpose: 'counters', src: env.src, aiScore: (x) => cardValue(x) }) : [];
  if (c && card(c)) { addCounters(card(c), m[1], 1); out.push(nameTag(card(c))); }
  env.did.push(out.length ? `puts an ${m[1]} counter on ${out.join(' and ')}` : `puts no ${m[1]} counters`);
}, { first: true });
// Rashmi and Ragavan
on(/^exile the top card of target opponent's library and create a treasure token\. then you may cast the exiled card without paying its mana cost if it's a spell with mana value less than the number of artifacts you control\. if you don't cast it this way, you may cast it this turn$/, async (m, env) => {
  const [o] = await playerTarget(env, 'target opponent');
  const who_ = o || opp(env.me);
  await runSentence('create a treasure token', env);
  const [top] = libTop(who_, 1);
  if (!top) return env.did.push('their library is empty');
  move(top, 'exile');
  const c = card(top);
  env.did.push(`exiles ${nameTag(c)}`);
  const arts = cardsIn(env.me, 'battlefield').filter((x) => isType(x, 'Artifact')).length;
  let done = [];
  if (!isLand(c) && (DB[c.def].cmc || 0) < arts) done = await castFromPool(env, [top], { free: true, max: 1 });
  if (!done.length && card(top) && card(top).zone === 'exile' && !isLand(c)) {
    grantPlay([top], env.me, { until: G.s.turn, castOnly: true });
    env.did.push(`may cast ${nameTag(c)} this turn`);
  }
}, { first: true, multi: true });
// Satya, Aetherflux Genius
on(/^at the beginning of the next end step, sacrifice (that token|it) unless you pay an amount of \{e\} equal to its mana value$/, async (m, env) => {
  const ids = (env.them_ && env.them_.length ? env.them_ : env.it && env.it.iid ? [env.it.iid] : []).filter((i) => card(i));
  if (!ids.length) return;
  G.s.delayed = G.s.delayed || [];
  for (const i of ids) G.s.delayed.push({ at: 'endStep', kind: 'sacUnlessEnergy', iid: i, pid: env.me });
  env.did.push(`${ids.map((i) => nameTag(card(i))).join(', ')} will be sacrificed at end step unless you pay energy`);
}, { first: true });
// Tidus, Yuna's Guardian: "move a counter from target creature you control onto a second target creature you control"
on(/^(?:you may )?move an? (?:([+\-\d\/a-z]+) )?counter from target creature you control onto a second target creature you control$/, async (m, env) => {
  const mine = cardsIn(env.me, 'battlefield').filter((c) => isCreature(c) && canTarget(c, env.me, env.src));
  const from = mine.filter((c) => Object.entries(c.counters || {}).some(([k, v]) => v > 0 && (!m[1] || k === m[1])));
  if (!from.length || mine.length < 2) return env.did.push('has no counter to move');
  let src, dst, kind;
  if (isAI(env.me)) {
    // the AI moves a +1/+1 counter onto an evasive creature without counters
    const dsts = mine.filter((c) => (hasKw(c, 'flying') || hasKw(c, 'menace') || hasKw(c, 'trample')) && !Object.values(c.counters || {}).some((v) => v > 0));
    src = from.filter((c) => (c.counters['+1/+1'] || 0) > 1 || !hasKw(c, 'flying')).sort((a, b) => (b.counters['+1/+1'] || 0) - (a.counters['+1/+1'] || 0))[0];
    dst = dsts.find((c) => !src || c.iid !== src.iid);
    if (!src || !dst || !(src.counters['+1/+1'] > 0)) return env.did.push('moves no counter');
    kind = '+1/+1';
  } else {
    const [a] = await env.choosers[env.me].pickCards({ prompt: 'Move a counter from which creature? (none to skip)', cards: from.map((c) => c.iid), min: 0, max: 1, purpose: 'counters', src: env.src });
    if (!a) return;
    src = card(a);
    const [b] = await env.choosers[env.me].pickCards({ prompt: `Move it onto which creature?`, cards: mine.filter((c) => c.iid !== a).map((c) => c.iid), min: 0, max: 1, purpose: 'counters', src: env.src });
    if (!b) return;
    dst = card(b);
    const kinds = Object.entries(src.counters).filter(([k, v]) => v > 0 && (!m[1] || k === m[1])).map(([k]) => k);
    kind = kinds[0];
    if (kinds.length > 1) kind = kinds[await env.choosers[env.me].choose({ prompt: 'Which counter?', options: kinds.map((k) => ({ label: k })), aiPick: () => 0 })];
  }
  src.counters[kind]--;
  if (!src.counters[kind]) delete src.counters[kind];
  addCounters(dst, kind, 1);
  env.did.push(`moves a ${kind} counter from ${nameTag(src)} to ${nameTag(dst)}`);
}, { first: true });
// Gonti, Canny Acquisitor: "look at the top card of that player's library, then exile it face down. You may play that card for as long as it remains exiled, and mana of any type can be spent to cast that spell."
on(/^look at the top card of (that player's|target opponent's|each opponent's) library, then exile it face down\. you may play that card for as long as it remains exiled, and mana of any (?:type|color) can be spent to cast (?:that spell|it)$/, async (m, env) => {
  const os = /each/.test(m[1]) ? opponents(env.me).filter(inGame) : /target/.test(m[1]) ? await playerTarget(env, 'target opponent') : [env.thatPlayer || opp(env.me)];
  for (const o of os) {
    const [top] = libTop(o, 1);
    if (!top) continue;
    move(top, 'exile');
    grantPlay([top], env.me, { anyMana: true, hidden: true });
    env.did.push(`exiles the top card of ${whoseLib(o)} library face down${env.me === 'p' ? ' (' + nameTag(card(top)) + ')' : ''}; it may be played`);
  }
}, { first: true, multi: true });
// Black Cat, Cunning Thief
on(/^look at the top (\w+) cards of target opponent's library, exile (\w+) of them face down, then put the rest on the bottom of their library in a random order\. you may play the exiled cards for as long as they remain exiled\. mana of any (?:color|type) can be spent to cast spells this way$/, async (m, env) => {
  const [t] = await playerTarget(env, 'target opponent');
  const o = t || opp(env.me);
  const top = libTop(o, n(m[1]));
  const k = Math.min(n(m[2]), top.length);
  const picks = await env.choosers[env.me].pickCards({ prompt: `Exile ${k} of them face down (you may play them)`, cards: top, min: k, max: k, purpose: 'steal', src: env.src, aiScore: (c) => (isLand(c) ? 1 : (DB[c.def].cmc || 0) + 2) });
  picks.forEach((i) => move(i, 'exile'));
  top.filter((i) => !picks.includes(i)).sort(() => Math.random() - 0.5).forEach((i) => move(i, 'library', { to: 'bottom' }));
  grantPlay(picks, env.me, { anyMana: true, hidden: true });
  env.did.push(`exiles ${k} card${k === 1 ? '' : 's'} face down from ${whoseLib(o)} library to play${env.me === 'p' ? ': ' + picks.map((i) => nameTag(card(i))).join(', ') : ''}`);
}, { first: true, multi: true });
// Author of Shadows
on(/^exile (?:all cards from )?(?:all opponents'|each opponent's|all of your opponents') graveyards?\. choose a nonland card exiled this way\. you may cast (?:that card|it)(?: for as long as it remains exiled)?[^]*$/, async (m, env) => {
  const o = opp(env.me);
  const ids = zoneOf(o, 'graveyard').slice();
  ids.forEach((i) => move(i, 'exile'));
  const pool = spellCards(ids);
  env.did.push(`exiles ${ids.length} card${ids.length === 1 ? '' : 's'} from ${whoseLib(o)} graveyard`);
  if (!pool.length) return;
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'Choose a nonland card you may cast while it stays exiled', cards: pool, min: 1, max: 1, purpose: 'steal', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
  grantPlay([pick], env.me, { anyMana: anyManaText(m[0]), castOnly: true });
  env.did.push(`may cast ${nameTag(card(pick))}`);
}, { first: true, multi: true });
// Crabomination
on(/^target opponent exiles the top card of their library, a card at random from their graveyard, and a card at random from their hand\. you may cast a spell from among cards exiled this way without paying its mana cost$/, async (m, env) => {
  const [t] = await playerTarget(env, 'target opponent');
  const o = t || opp(env.me);
  const ids = [...exileTop(o, 1)];
  const rnd = (z) => {
    const a = zoneOf(o, z);
    return a.length ? a[Math.floor(Math.random() * a.length)] : null;
  };
  for (const z of ['graveyard', 'hand']) {
    const i = rnd(z);
    if (i) {
      move(i, 'exile');
      ids.push(i);
    }
  }
  env.did.push(`${who(o)} ${s_(o, 'exile')} ${ids.map((i) => nameTag(card(i))).join(', ') || 'nothing'}`);
  await castFromPool(env, ids, { free: true, max: 1 });
}, { first: true, multi: true });
// Breach the Multiverse
on(/^for each player, choose a creature or planeswalker card in that player's graveyard\. put those cards onto the battlefield under your control\. then each creature you control becomes a phyrexian in addition to its other types$/, async (m, env) => {
  const got = [];
  for (const pid of [env.me, ...opponents(env.me)]) {
    const pool = cardsIn(pid, 'graveyard').filter((c) => /Creature|Planeswalker/.test(DB[c.def].typeLine || ''));
    if (!pool.length) continue;
    const [pick] = await env.choosers[env.me].pickCards({ prompt: `Choose a creature or planeswalker card in ${seatPoss(pid)} graveyard`, cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'reanimate', src: env.src, aiScore: (c) => cardValue(c) });
    if (pick) got.push(pick);
  }
  for (const i of got) toBattlefield(i, env.me);
  for (const c of cardsIn(env.me, 'battlefield').filter(isCreature)) if (!/Phyrexian/.test(c.addTypes || '')) c.addTypes = ((c.addTypes || '') + ' Phyrexian').trim();
  env.did.push(got.length ? `puts ${got.map((i) => nameTag(card(i))).join(' and ')} onto the battlefield` : 'finds nothing to return');
}, { first: true, multi: true });
// Brainstealer Dragon / Breeches / Ramirez / Nathan Drake / Etali / Gonti: exile the top card(s) of libraries
on(/^exile the top card of (each opponent's|each player's|that player's|each of those opponents') librar(?:y|ies)(?:, then|\.) (.+)$/, async (m, env) => {
  const pids = /each player/.test(m[1]) ? [env.me, ...opponents(env.me)] : /that player/.test(m[1]) ? [env.thatPlayer || opp(env.me)] : opponents(env.me);
  const ids = pids.flatMap((pid) => exileTop(pid, 1));
  env.did.push(`exiles ${ids.map((i) => nameTag(card(i))).join(', ') || 'nothing'}`);
  const rest = m[2];
  const anyMana = anyManaText(rest);
  if (/without paying/.test(rest)) await castFromPool(env, ids, { free: true, max: /any number/.test(rest) ? 99 : 1 });
  else if (/you may play (?:those cards|that card|them) (?:for as long as (?:they|it) remains? exiled)/.test(rest)) grantPlay(ids, env.me, { anyMana });
  else if (/you may play (?:those cards|that card|them) this turn/.test(rest)) grantPlay(ids, env.me, { anyMana, until: G.s.turn });
  else if (/you may cast (?:that card|it) for as long as it remains exiled/.test(rest)) grantPlay(ids, env.me, { anyMana, castOnly: true });
  else if (/you may cast a spell from among (?:those cards|them)$/.test(rest)) await castFromPool(env, ids, { max: 1, anyMana: true });
  else if (/^until end of turn, you may (cast|play)/.test(rest)) grantPlay(ids, env.me, { anyMana, until: G.s.turn, castOnly: /may cast/.test(rest) });
}, { first: true, multi: true });
// Overture: "Target opponent mills half their library, rounded down."
on(/^target (?:opponent|player) mills half their library, rounded (down|up)$/, async (m, env) => {
  const [t] = await playerTarget(env, 'target opponent');
  const o = t || opp(env.me);
  const lib = zoneOf(o, 'library');
  const k = m[1] === 'down' ? Math.floor(lib.length / 2) : Math.ceil(lib.length / 2);
  libTop(o, k).forEach((i) => move(i, 'graveyard'));
  env.did.push(`${who(o)} ${s_(o, 'mill')} ${k}`);
}, { first: true });
// Tinybones, the Pickpocket
on(/^(?:you may )?cast target nonland permanent card from that player's graveyard, and mana of any (?:color|type) can be spent to cast that spell$/, async (m, env) => {
  const pid = env.thatPlayer || opp(env.me);
  const pool = cardsIn(pid, 'graveyard').filter((c) => isPermanentCard(DB[c.def]) && !isLandFace_(c));
  if (!pool.length) return env.did.push('finds no permanent card');
  await castFromPool(env, pool.map((c) => c.iid), { max: 1, anyMana: true, prompt: `Cast a nonland permanent card from ${seatPoss(pid)} graveyard?` });
}, { first: true });
// The Horus Heresy
on(/^for each opponent, gain control of up to one target nonlegendary creature that player controls for as long as ~ remains on the battlefield$/, async (m, env) => {
  const pool = cardsIn(opp(env.me), 'battlefield').filter((c) => isCreature(c) && !/Legendary/.test(typeLine(c)) && canTarget(c, env.me, env.src));
  if (!pool.length) return env.did.push('finds no target');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'Gain control of up to one nonlegendary creature', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'steal', src: env.src, aiScore: (c) => cardValue(c) });
  if (!pick) return;
  const prev = card(pick).controller;
  move(pick, 'battlefield', { controller: env.me });
  if (card(pick) && env.src) card(pick).controlWhile = { src: env.src.iid, prev, by: env.me, youControl: false };
  env.did.push(`gains control of ${nameTag(card(pick))}`);
}, { first: true });
// Opportunistic Dragon
on(/^choose target ([a-z]+) or ([a-z]+) an opponent controls\. for as long as ~ remains on the battlefield, gain control of that permanent, it loses all abilities, and it can't attack or block$/, async (m, env) => {
  const fits = (x, w) => (/^[A-Z]/.test(capWords(w)) && ['artifact', 'creature', 'enchantment', 'land', 'planeswalker'].includes(w) ? isType(x, capWords(w)) : hasSubtype(x, capWords(w)));
  const pool = opponents(env.me).flatMap((o) => cardsIn(o, 'battlefield')).filter((x) => (fits(x, m[1]) || fits(x, m[2])) && canTarget(x, env.me, env.src));
  if (!pool.length) return env.did.push('finds no target');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Choose target ${m[1]} or ${m[2]} an opponent controls`, cards: pool.map((x) => x.iid), min: 1, max: 1, purpose: 'steal', src: env.src, aiScore: (x) => cardValue(x) });
  const c = pick && card(pick);
  if (!c || c.zone !== 'battlefield') return env.did.push('finds no target');
  const src = env.src && card(env.src.iid);
  if (!src || src.zone !== 'battlefield') return env.did.push(`${nameTag(c)} stays put (the Dragon left)`);
  const prev = c.controller;
  move(c.iid, 'battlefield', { controller: env.me });
  const k = card(c.iid);
  if (!k) return;
  k.controlWhile = { src: src.iid, prev, by: env.me, youControl: false, strip: true };
  loseAllAbilities(k);
  k.pacifiedBy = src.iid;
  env.did.push(`gains control of ${nameTag(k)}; it loses all abilities and can't attack or block`);
}, { first: true, multi: true });
// Duskana: "draw a card for each creature you control with base power and toughness 2/2"
on(/^(?:you )?draw (a|one|two|three) cards? for each (.+)$/, async (m, env) => {
  // Deadly Embrace: "draw a card for each creature that died this turn"
  if (/^creatures? that died this turn$/.test(m[2])) {
    const k = n(m[1]) * (G.s.ts.creaturesDiedN || 0);
    if (k) draw(env.me, k, true);
    return env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${k}`);
  }
  if (/but don't own$|,| this way$| this turn$/.test(m[2])) return 'pass';
  let k = null;
  const wm = m[2].match(/^(other )?((?:[\w-]+ )*?)(creature|artifact|permanent|land|[a-z]+)s? you control( with .+)?$/);
  if (wm && wm[4]) k = cardsIn(env.me, 'battlefield').filter((c) => !(wm[1] && c.iid === env.src.iid) && matchesFilter(c, `${wm[2]}${wm[3]}${wm[4]}`)).length;
  else if (/^(?:[\w-]+ ){0,3}?[\w-]+ (?:you control|your opponents control|on the battlefield|in your graveyard)$/.test(m[2])) k = countPhrase(env.me, m[2], helpers, env.src && env.src.iid);
  if (k === null) return 'pass';
  const total = n(m[1]) * k;
  if (total) draw(env.me, total, true);
  env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${total}`);
}, { first: true });
on(/^draw a card for each creature you control but don't own$/, async (m, env) => {
  const k = cardsIn(env.me, 'battlefield').filter((c) => isCreature(c) && c.owner !== env.me).length;
  if (k) draw(env.me, k, true);
  env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${k}`);
}, { first: true });
on(/^starting with you, each player chooses a creature\. destroy each creature chosen this way$/, async (m, env) => {
  const chosen = [];
  for (const pid of [env.me, ...opponents(env.me)]) {
    const pool = cardsIn(pid, 'battlefield').filter(isCreature);
    if (!pool.length) continue;
    const [pick] = await env.choosers[pid].pickCards({ prompt: 'Choose a creature you control to be destroyed', cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'sacrifice', src: env.src, aiScore: (c) => -cardValue(c) });
    if (pick) chosen.push(pick);
  }
  for (const i of chosen) if (card(i)) destroy(i);
  env.did.push(chosen.length ? `destroys ${chosen.map((i) => nameTag(card(i))).join(' and ')}` : 'destroys nothing');
}, { first: true, multi: true });
// Tinybones, Bauble Burglar
on(/^exile it from their graveyard with a stash counter on it$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  if (!c || c.zone !== 'graveyard') return;
  move(c.iid, 'exile');
  addCounters(card(c.iid), 'stash', 1, { silent: true });
  grantPlay([c.iid], env.me, { anyMana: true, myTurnOnly: true });
  env.did.push(`exiles ${nameTag(c)} with a stash counter`);
}, { first: true });
// Kefka, Dancing Mad
on(/^exile a card at random from each opponent's graveyard\. you may cast any number of spells from among cards exiled this way without paying their mana costs\. then each player who owns a spell you cast this way loses life equal to its mana value$/, async (m, env) => {
  const o = opp(env.me);
  const gy = zoneOf(o, 'graveyard');
  if (!gy.length) return env.did.push('finds an empty graveyard');
  const i = gy[Math.floor(Math.random() * gy.length)];
  move(i, 'exile');
  env.did.push(`exiles ${nameTag(card(i))}`);
  const cast_ = await castFromPool(env, [i], { free: true });
  for (const x of cast_) {
    const c = card(x);
    if (!c || c.owner === env.me) continue;
    const k = DB[c.def].cmc || 0;
    changeLife(c.owner, -k, false);
    env.did.push(`${who(c.owner)} ${s_(c.owner, 'lose')} ${k} life`);
  }
}, { first: true, multi: true });
// Fevered Suspicion / Plargg and Nassari: exile until a nonland card
on(/^each opponent exiles cards from the top of their library until they exile a nonland card\. you may cast any number of spells from among those nonland cards without paying their mana costs$/, async (m, env) => {
  const o = opp(env.me);
  const { hit, all } = exileUntil(o, (c) => !isLandFace_(c));
  env.did.push(`${who(o)} ${s_(o, 'exile')} ${all.length} card${all.length === 1 ? '' : 's'}${hit ? `, hitting ${nameTag(card(hit))}` : ''}`);
  if (hit) await castFromPool(env, [hit], { free: true });
}, { first: true, multi: true });
on(/^each player exiles cards from the top of their library until they exile a nonland card\. an opponent choo?ses a nonland card exiled this way\. you may cast up to two spells from among the other cards exiled this way without paying their mana costs$/, async (m, env) => {
  const hits = [];
  for (const pid of [env.me, ...opponents(env.me)]) {
    const { hit } = exileUntil(pid, (c) => !isLandFace_(c));
    if (hit) hits.push(hit);
  }
  env.did.push(`exiles ${hits.map((i) => nameTag(card(i))).join(' and ') || 'nothing'}`);
  if (!hits.length) return;
  const o = opp(env.me);
  // the opponent takes away the best one
  const [veto] = await env.choosers[o].pickCards({ prompt: 'Choose a card your opponent can’t cast', cards: hits, min: 1, max: 1, purpose: 'veto', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
  if (veto) env.did.push(`${who(o)} ${s_(o, 'choose')} ${nameTag(card(veto))}`);
  await castFromPool(env, hits.filter((i) => i !== veto), { free: true, max: 2 });
}, { first: true, multi: true });
// Black Widow, Super Spy: "You may put a +1/+1 counter on ~. If you don't, you may cast the exiled nonland card until end of turn
// and mana of any type can be spent to cast that spell."
on(/^you may put an? \+1\/\+1 counter on ~\. if you don't, you may cast the exiled nonland card until end of turn and mana of any (?:type|color) can be spent to cast that spell$/, async (m, env) => {
  const src = env.src && card(env.src.iid);
  let hit = env.it && card(env.it.iid);
  if (!hit || hit.zone !== 'exile' || isLand(hit)) {
    const o = env.thatPlayer || opp(env.me);
    hit = [...cardsIn(o, 'exile')].reverse().find((c) => !isLand(c)) || null;
  }
  const onBf = src && src.zone === 'battlefield';
  let counter = !!onBf;
  if (hit && onBf) {
    // the AI takes the spell when it's worth more than a counter and it can afford it
    const mana = cardsIn(env.me, 'battlefield').filter((x) => !x.tapped && (isLand(x) || (DB[x.def].produced || []).length)).length;
    const aiPick = () => !((DB[hit.def].cmc || 0) >= 2 && (DB[hit.def].cmc || 0) <= mana);
    counter = await env.choosers[env.me].confirm(cardName(src), `Put a +1/+1 counter on ${cardName(src)}? If you don't, you may cast ${cardName(hit)} this turn, spending mana as though it were mana of any type.`, { aiPick, yes: 'Put a counter', no: `Cast ${cardName(hit)} instead` });
    if (isAI(env.me)) counter = aiPick();
  }
  if (counter && onBf) {
    addCounters(src, '+1/+1', 1);
    env.did.push(`puts a +1/+1 counter on ${nameTag(src)}`);
  } else if (hit) {
    grantPlay([hit.iid], env.me, { until: G.s.turn, anyMana: true, castOnly: true });
    env.did.push(`may cast ${nameTag(hit)} this turn (mana of any type)`);
  }
}, { first: true, multi: true });
// Grenzo, Dungeon Warden: "Put the bottom card of your library into your graveyard. If it's a creature card with power
// less than or equal to Grenzo's power, put it onto the battlefield."
on(/^put the bottom card of your library into your graveyard\. if it's a creature card with power less than or equal to ~'s power, put it onto the battlefield$/, async (m, env) => {
  const lib = zoneOf(env.me, 'library');
  if (!lib.length) return env.did.push('has no library left');
  const iid = lib[0];
  move(iid, 'graveyard');
  const c = card(iid);
  const src = env.src && card(env.src.iid);
  const max = src && src.zone === 'battlefield' ? power(src) : (env.src ? power(env.src) : 0);
  // the card's power as printed (it's in the graveyard now)
  const pw = parseInt(DB[c.def].faces[0].power, 10);
  if (/Creature/.test(DB[c.def].faces[0].typeLine || DB[c.def].typeLine || '') && !isNaN(pw) && pw <= max) {
    toBattlefield(iid, env.me);
    env.did.push(`mills ${nameTag(c)} from the bottom and puts it onto the battlefield`);
  } else env.did.push(`mills ${nameTag(c)} from the bottom`);
}, { first: true, multi: true });
// Laughing Jasper Flint
on(/^exile the top x cards of target opponent's library, where x is the number of outlaws you control\. until end of turn, you may cast spells from among those cards, and mana of any (?:color|type) can be spent to cast those spells$/, async (m, env) => {
  const [t] = await playerTarget(env, 'target opponent');
  const o = t || opp(env.me);
  const k = cardsIn(env.me, 'battlefield').filter((c) => ['Assassin', 'Mercenary', 'Pirate', 'Rogue', 'Warlock'].some((x) => hasSubtype(c, x)) || (isCreature(c) && c.owner !== env.me && cardsIn(env.me, 'battlefield').some((y) => /Creatures you control but don't own are Mercenaries/i.test(oracle(y))))).length;
  const ids = exileTop(o, k);
  grantPlay(ids, env.me, { anyMana: true, castOnly: true, until: G.s.turn });
  env.did.push(`exiles the top ${ids.length} of ${whoseLib(o)} library to cast this turn`);
}, { first: true, multi: true });
// Lethal Scheme: "Each creature that convoked ~ connives."
on(/^each creature that convoked ~ connives$/, async (m, env) => {
  const ids = ((env.src && env.src.convokedBy) || []).filter((i) => card(i) && card(i).zone === 'battlefield');
  for (const i of ids) {
    draw(env.me, 1, true);
    const hand = cardsIn(env.me, 'hand');
    if (!hand.length) continue;
    const [d] = await env.choosers[env.me].pickCards({ forced: true, prompt: `${cardName(card(i))} connives: discard a card`, cards: hand.map((c) => c.iid), min: 1, max: 1, purpose: 'discard', src: env.src, aiScore: (c) => (isLand(c) ? 5 : -(DB[c.def].cmc || 0)) });
    if (d) {
      const nonland = !isLand(card(d));
      discardCard(d);
      if (nonland && card(i)) addCounters(card(i), '+1/+1', 1);
    }
  }
  if (ids.length) env.did.push(`${ids.length} convoking creature${ids.length === 1 ? '' : 's'} connive`);
}, { first: true });
// Locke, Treasure Hunter
on(/^each player mills a card\. if a land card was milled this way, create a treasure token\. until end of turn, you may cast a spell from among those cards$/, async (m, env) => {
  const ids = [env.me, ...opponents(env.me)].flatMap((pid) => libTop(pid, 1));
  ids.forEach((i) => move(i, 'graveyard'));
  env.did.push(`each player mills ${ids.map((i) => nameTag(card(i))).join(', ') || 'nothing'}`);
  if (ids.some((i) => isLand(card(i)))) createToken(genericTokenDef(0, 0, 'Treasure'), env.me, 1);
  // cast one of them this turn (from the graveyard): a one-shot permission
  for (const i of spellCards(ids)) Object.assign(card(i), { mayCastFromGy: env.me, mayCastFromGyTurn: G.s.turn, lockeGroup: env.src && env.src.iid + ':' + G.s.turn });
}, { first: true, multi: true });
// Extract Brain
on(/^target opponent chooses x cards from their hand\. look at those cards\. you may cast a spell from among them without paying its mana cost$/, async (m, env) => {
  const [t] = await playerTarget(env, 'target opponent');
  const o = t || opp(env.me);
  const hand = cardsIn(o, 'hand');
  const k = Math.min(env.x || 0, hand.length);
  if (!k) return env.did.push('sees no cards');
  const picks = await env.choosers[o].pickCards({ forced: true, prompt: `Choose ${k} card${k === 1 ? '' : 's'} from your hand for your opponent to look at`, cards: hand.map((c) => c.iid), min: k, max: k, purpose: 'reveal', src: env.src, aiScore: (c) => (isLand(c) ? 10 : -(DB[c.def].cmc || 0)) });
  env.did.push(`looks at ${picks.map((i) => nameTag(card(i))).join(', ')}`);
  await castFromPool(env, picks, { free: true, max: 1 });
}, { first: true, multi: true });
// Shadow of the Enemy
on(/^exile all creature cards from target player's graveyard\. you may cast spells from among those cards for as long as they remain exiled, and mana of any (?:color|type) can be spent to cast them$/, async (m, env) => {
  const [t] = await playerTarget(env, 'target player');
  const o = t || opp(env.me);
  const ids = cardsIn(o, 'graveyard').filter((c) => /Creature/.test(DB[c.def].typeLine || '')).map((c) => c.iid);
  ids.forEach((i) => move(i, 'exile'));
  grantPlay(ids, env.me, { anyMana: true, castOnly: true });
  env.did.push(`exiles ${ids.length} creature card${ids.length === 1 ? '' : 's'} to cast`);
}, { first: true, multi: true });
// Zara, Renegade Recruiter
on(/^look at defending player's hand\. you may put a creature card from it onto the battlefield under your control tapped and attacking that player or a planeswalker they control\. return that creature to its owner's hand at the beginning of the next end step$/, async (m, env) => {
  const o = env.thatPlayer || opp(env.me);
  const pool = cardsIn(o, 'hand').filter((c) => /Creature/.test(DB[c.def].typeLine || ''));
  env.did.push(`looks at ${seatPoss(o)} hand${env.me === 'p' ? ': ' + (cardsIn(o, 'hand').map(nameTag).join(', ') || 'empty') : ''}`);
  if (!pool.length) return;
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'Put a creature card from their hand onto the battlefield attacking', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'steal', src: env.src, aiScore: (c) => cardValue(c) });
  if (!pick) return;
  toBattlefield(pick, env.me, { tapped: true });
  const c = card(pick);
  if (c && G.s.combat) {
    c.attacking = true;
    G.s.combat.attackers.push(pick);
    if (G.s.combat.targets) G.s.combat.targets[pick] = o;
  }
  if (c) c.endOfTurn = 'hand';
  env.did.push(`puts ${nameTag(c)} onto the battlefield attacking (it returns at end of turn)`);
}, { first: true, multi: true });
// Rakdos, the Muscle
on(/^exile cards equal to its mana value from the top of target player's library\. until your next end step, you may play those cards and mana of any (?:color|type) can be spent to cast those spells$/, async (m, env) => {
  const sac = env.it && card(env.it.iid);
  const k = sac ? DB[sac.def].cmc || 0 : 0;
  const [t] = await playerTarget(env, 'target player');
  const o = t || opp(env.me);
  const ids = exileTop(o, k);
  grantPlay(ids, env.me, { anyMana: true, until: G.s.turn + (G.s.active === env.me ? 0 : 1) });
  env.did.push(`exiles the top ${ids.length} of ${whoseLib(o)} library to play`);
}, { first: true, multi: true });
// Gathering Stone: "look at the top card of your library. If it's a card of the chosen type, you may reveal it and put it into
// your hand. If you don't put the card into your hand, you may put it into your graveyard."
on(/^if it's a card of the chosen type, you may reveal it and put it into your hand$/, async (m, env) => {
  const lib = zoneOf(env.me, 'library');
  const top = lib.length ? card(lib[lib.length - 1]) : null;
  env.tookIt = false;
  env.it = top ? { iid: top.iid } : null;
  const type = env.src && card(env.src.iid) && card(env.src.iid).chosenType;
  if (!top || !type || !hasSubtype({ ...top, zone: 'hand' }, type) && !/changeling/i.test(DB[top.def].faces[0].oracle || '')) return;
  const yes = isAI(env.me) ? true : await env.choosers.p.confirm(cardName(env.src), `The top card is ${cardName(top)} (a ${type}). Reveal it and put it into your hand?`, { yes: 'Put into hand', no: 'Leave it' });
  if (!yes) return;
  move(top.iid, 'hand');
  env.tookIt = true;
  env.did.push(`reveals ${nameTag(top)} and puts it into ${who(env.me) === 'you' ? 'your' : 'its'} hand`);
}, { first: true });
on(/^if you don't put the card into your hand, you may put it into your graveyard$/, async (m, env) => {
  if (env.tookIt) return;
  const top = env.it && env.it.iid && card(env.it.iid);
  if (!top || top.zone !== 'library') return;
  // the AI mills lands it has plenty of and cards it can't use soon
  const lands = cardsIn(env.me, 'battlefield').filter(isLand).length;
  const yes = isAI(env.me) ? (isLand(top) ? lands >= 6 : (DB[top.def].cmc || 0) > lands + 2) : await env.choosers.p.confirm(cardName(env.src), `Put ${cardName(top)} (the top card of your library) into your graveyard?`, { yes: 'Into the graveyard', no: 'Keep it on top' });
  if (!yes) return;
  move(top.iid, 'graveyard');
  env.did.push(`puts ${env.me === 'p' ? nameTag(top) : 'the top card'} into the graveyard`);
}, { first: true });
// Descendants' Fury: "you may sacrifice one of them. If you do, reveal cards from the top of your library until you reveal a
// creature card that shares a creature type with the sacrificed creature. Put that card onto the battlefield and the rest on
// the bottom of your library in a random order."
on(/^(?:you may )?sacrifice one of them$/, async (m, env) => {
  const pool = (env.them_ || []).map(card).filter((c) => c && c.zone === 'battlefield' && c.controller === env.me);
  env.lastMay = false;
  if (!pool.length) return;
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'You may sacrifice one of them', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'sacrifice', src: env.src,
    aiScore: (c) => (c.token ? 3 : 0) - cardValue(c) / 2 });
  if (!pick) return;
  const c = card(pick);
  env.sacTypes = (typeLine(c).split('—')[1] || '').trim().split(/\s+/).filter(Boolean);
  env.sacChangeling = hasKw(c, 'changeling');
  sacrifice(pick);
  env.lastMay = true;
  env.did.push(`sacrifices ${nameTag(c)}`);
}, { first: true });
on(/^reveal cards from the top of your library until you reveal a creature card that shares a creature type with the sacrificed creature$/, async (m, env) => {
  const types = env.sacTypes || [];
  const lib = zoneOf(env.me, 'library');
  const revealed = [];
  let hit = null;
  for (let k = lib.length - 1; k >= 0; k--) {
    const c = card(lib[k]);
    revealed.push(c.iid);
    if (/Creature/.test(DB[c.def].faces[0].typeLine || '') && (env.sacChangeling || /changeling/i.test(DB[c.def].faces[0].oracle || '') || types.some((t) => hasSubtype({ ...c, zone: 'hand' }, t)))) {
      hit = c;
      break;
    }
  }
  env.revealedRest = revealed.filter((i) => !hit || i !== hit.iid);
  env.it = hit ? { iid: hit.iid } : null;
  env.did.push(hit ? `reveals ${revealed.length} card${revealed.length === 1 ? '' : 's'}, finds ${nameTag(hit)}` : 'reveals the whole library: no match');
}, { first: true });
on(/^put that card onto the battlefield and the rest on the bottom of your library in a random order$/, async (m, env) => {
  const hit = env.it && env.it.iid && card(env.it.iid);
  if (hit && hit.zone === 'library') {
    toBattlefield(hit.iid, env.me);
    env.did.push(`puts ${nameTag(hit)} onto the battlefield`);
  }
  const rest = (env.revealedRest || []).filter((i) => card(i) && card(i).zone === 'library');
  for (const i of rest.sort(() => Math.random() - 0.5)) move(i, 'library', { to: 'bottom' });
}, { first: true });
// Drakuseth: "it deals 4 damage to any target and 3 damage to each of up to two other targets"
on(/^(?:~|it|he|she) deals (\w+) damage to (any target|target [a-z ]+?) and (\w+) damage to each of up to (\w+) other targets$/, async (m, env) => {
  const src = env.src;
  const first = await pickTargetsForDamage(env, m[2], n(m[1], env.x));
  for (const t of first) await damageTargetPick(env, src, t, n(m[1], env.x));
  const more = await pickTargets(env, `up to ${m[4]} any target`, { harm: true, amount: n(m[3], env.x), exclude: first });
  for (const t of more) await damageTargetPick(env, src, t, n(m[3], env.x));
}, { first: true });
async function damageTargetPick(env, src, t, amount) {
  if (t.player) damagePlayer(env, src, t.player, amount);
  else if (t.iid && card(t.iid) && card(t.iid).zone === 'battlefield') {
    const c = card(t.iid);
    env.did.push(`deals ${amount} damage to ${whose(c)} ${nameTag(c)}`);
    damagePermanent(env, src, c, amount);
  }
}
// "~ deals 4 damage to each other opponent" — with two players, nobody else is there
// Super State: "it deals that much damage to each other opponent" (other than the one it just hit)
on(/^(?:~|this creature|it|that creature|enchanted creature|equipped creature) deals (that much|\w+) damage to each other opponent$/, async (m, env) => {
  const k = m[1] === 'that much' ? env.lastAmount || 0 : n(m[1], env.x);
  const hit = env.thatPlayer;
  const others = opponents(env.me).filter((pid) => pid !== hit && inGame(pid));
  if (!others.length || !k) return env.did.push('there are no other opponents');
  const srcC = /^(?:it|that creature|enchanted creature|equipped creature)$/.test(m[0].split(' deals')[0]) && env.it && env.it.iid && card(env.it.iid) ? card(env.it.iid) : env.src;
  for (const pid of others) damagePlayer(env, srcC, pid, k);
}, { first: true });
// Shared Animosity: "it gets +1/+0 until end of turn for each other attacking creature that shares a creature type with it"
on(/^it gets \+(\d+)\/\+(\d+) (?:until end of turn )?for each other attacking creature that shares a creature type with it(?: until end of turn)?$/, async (m, env) => {
  const t = env.it && env.it.iid && card(env.it.iid);
  if (!t) return;
  const subs = (typeLine(t).split('—')[1] || '').trim().split(/\s+/).filter(Boolean);
  const changeling = (x) => hasKw(x, 'changeling');
  const k = Object.values(G.s.cards).filter((x) => x.iid !== t.iid && x.zone === 'battlefield' && x.attacking && isCreature(x)
    && (changeling(t) || changeling(x) || subs.some((st) => hasSubtype(x, st)))).length;
  if (!k) return env.did.push(`${nameTag(t)} shares a type with no other attacker`);
  pumpEOT(t, { p: +m[1] * k, t: +m[2] * k });
  env.did.push(`${nameTag(t)} gets +${+m[1] * k}/+${+m[2] * k} until end of turn`);
}, { first: true });
// Molten Tide (Pyre Rhymer), High Tide: "Until end of turn, whenever you tap a Mountain for mana, add an additional {R}."
on(/^until end of turn, whenever (you|a player) taps? an? (plains|island|swamp|mountain|forest) for mana, (?:add|that player adds) an additi?onal \{([wubrg])\}$/, async (m, env) => {
  G.s.eotLandBonus = (G.s.eotLandBonus || []).filter((b) => b.turn === G.s.turn);
  G.s.eotLandBonus.push({ turn: G.s.turn, pid: m[1] === 'you' ? env.me : null, type: m[2][0].toUpperCase() + m[2].slice(1), col: m[3].toUpperCase() });
  env.did.push(`${m[2][0].toUpperCase() + m[2].slice(1)}s tap for an extra {${m[3].toUpperCase()}} this turn`);
}, { first: true });
// Glimpse the Impossible: "At the beginning of the next end step, if any of those cards remain exiled, put them into your
// graveyard, then create a 0/1 colorless Eldrazi Spawn creature token for each card put into your graveyard this way."
on(/^at the beginning of the next end step, if any of those cards remain exiled, put them into your graveyard, then create (.+?) for each card put into your graveyard this way$/, async (m, env) => {
  const ids = (env.them_ && env.them_.length ? env.them_ : (env.exiledIds || [])).slice();
  if (!ids.length) return;
  G.s.delayed = G.s.delayed || [];
  G.s.delayed.push({ at: 'endStep', kind: 'leftoverExileToGy', ids, src: env.src.iid, pid: env.me, tokens: m[1] });
  env.did.push('at the next end step, the cards still in exile go to the graveyard and make tokens');
}, { first: true });
on(/^those tokens have "sacrifice this creature: add \{c\}\.?"$/, async () => {}, { first: true });
// Expensive Taste
on(/^exile the top (\w+) cards of target opponent's library face down\. you may look at and play those cards for as long as they remain exiled$/, async (m, env) => {
  const [t] = await playerTarget(env, 'target opponent');
  const o = t || opp(env.me);
  const ids = exileTop(o, n(m[1]));
  grantPlay(ids, env.me, { hidden: true });
  env.did.push(`exiles the top ${ids.length} of ${whoseLib(o)} library face down${env.me === 'p' ? ': ' + ids.map((i) => nameTag(card(i))).join(', ') : ''}`);
}, { first: true, multi: true });
// Dream Harvest
on(/^each opponent exiles cards from the top of their library until they have exiled cards with total mana value (\d+) or greater this way\. until end of turn, you may cast cards exiled this way without paying their mana costs$/, async (m, env) => {
  const o = opp(env.me);
  const lib = zoneOf(o, 'library');
  const ids = [];
  let tot = 0;
  while (lib.length && tot < +m[1]) {
    const i = lib[lib.length - 1];
    move(i, 'exile');
    ids.push(i);
    tot += DB[card(i).def].cmc || 0;
  }
  grantPlay(spellCards(ids), env.me, { free: true, until: G.s.turn });
  env.did.push(`${who(o)} ${s_(o, 'exile')} ${ids.length} cards; you may cast them free this turn`.replace('you may', env.me === 'p' ? 'you may' : 'the AI may'));
}, { first: true, multi: true });
// Breeches, Brazen Plunderer
on(/^exile the top card of each of those opponents' libraries\. you may play those cards this turn, and you may spend mana as though it were mana of any (?:color|type) to cast those spells$/, async (m, env) => {
  const ids = exileTop(env.thatPlayer || opp(env.me), 1);
  grantPlay(ids, env.me, { anyMana: true, until: G.s.turn });
  env.did.push(`exiles ${ids.map((i) => nameTag(card(i))).join(', ') || 'nothing'} to play this turn`);
}, { first: true, multi: true });
// Gríma, Saruman's Footman
on(/^that player exiles cards from the top of their library until they exile an instant or sorcery card\. you may cast that card without paying its mana cost\. then that player puts the exiled cards that weren't cast this way on the bottom of their library in a random order$/, async (m, env) => {
  const o = env.thatPlayer || opp(env.me);
  const { hit, all } = exileUntil(o, (c) => /Instant|Sorcery/.test(DB[c.def].typeLine || ''));
  env.did.push(`${who(o)} ${s_(o, 'exile')} ${all.length} card${all.length === 1 ? '' : 's'}${hit ? `, hitting ${nameTag(card(hit))}` : ''}`);
  const cast_ = hit ? await castFromPool(env, [hit], { free: true, max: 1 }) : [];
  all.filter((i) => !cast_.includes(i) && card(i) && card(i).zone === 'exile').sort(() => Math.random() - 0.5).forEach((i) => move(i, 'library', { to: 'bottom' }));
}, { first: true, multi: true });
// Gonti, Night Minister
on(/^its controller looks at the top card of that opponent's library and exiles it face down\. they may play that card for as long as it remains exiled\. mana of any (?:color|type) can be spent to cast a spell this way$/, async (m, env) => {
  const atk = env.it && card(env.it.iid);
  const pid = atk ? atk.controller : env.me;
  const ids = exileTop(env.thatPlayer || opp(pid), 1);
  grantPlay(ids, pid, { anyMana: true, hidden: true });
  env.did.push(`${who(pid)} ${s_(pid, 'exile')} the top card of ${whoseLib(env.thatPlayer || opp(pid))} library to play`);
}, { first: true, multi: true });
// Klaw, Master of Sound
on(/^look at the top card of that player's library, then exile it face down\. you may play it for as long as it remains exiled\. mana of any (?:color|type) can be spent to cast a spell this way$/, async (m, env) => {
  const from = env.thatPlayer || opp(env.me);
  const ids = exileTop(from, 1);
  grantPlay(ids, env.me, { anyMana: true, hidden: true });
  env.did.push(`${who(env.me)} ${s_(env.me, 'exile')} the top card of ${whoseLib(from)} library face down to play`);
}, { first: true, multi: true });
// Pain Distributor: "they create a Treasure token" (the player who triggered it)
on(/^they create (.+)$/, async (m, env) => {
  const pid = env.thatPlayer || env.me;
  await runSentence(`create ${m[1]}`, { ...env, me: pid });
}, { first: true });
on(/^that player creates a treasure token$/, async (m, env) => {
  const pid = env.thatPlayer || env.me;
  createToken(genericTokenDef(0, 0, 'Treasure'), pid, 1);
  env.did.push(`${who(pid)} ${s_(pid, 'create')} a Treasure`);
}, { first: true });
// Brainstealer Dragon: "they lose life equal to its mana value"
on(/^they lose life equal to its mana value$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  if (!c) return;
  const pid = c.owner;
  const k = DB[c.def].cmc || 0;
  changeLife(pid, -k, false);
  env.did.push(`${who(pid)} ${s_(pid, 'lose')} ${k} life`);
}, { first: true });
// Intellect Devourer
on(/^each opponent exiles a card from their hand until ~ leaves the battlefield$/, async (m, env) => {
  const o = opp(env.me);
  const hand = cardsIn(o, 'hand');
  if (!hand.length) return env.did.push(`${who(o)} ${s_(o, 'have')} no cards in hand`);
  const [pick] = await env.choosers[o].pickCards({ forced: true, prompt: `Exile a card from your hand until ${cardName(env.src)} leaves`, cards: hand.map((c) => c.iid), min: 1, max: 1, purpose: 'exile', src: env.src, aiScore: (c) => (isLand(c) ? 10 : -(DB[c.def].cmc || 0)) });
  move(pick, 'exile');
  const c = card(pick);
  if (c && env.src) {
    c.exiledBy = env.src.iid;
    c.exiledFromHand = true;
    c.exiledWith = env.src.iid;
    grantPlay([pick], env.me, { anyMana: true });
  }
  env.did.push(`${who(o)} ${s_(o, 'exile')} ${nameTag(c)}`);
}, { first: true });
// Labyrinth Raptor: "defending player sacrifices a creature blocking it"
on(/^defending player sacrifices a creature blocking it$/, async (m, env) => {
  const atk = env.it && env.it.iid;
  const cb = G.s.combat;
  const bl = ((cb && cb.blocks[atk]) || []).filter((i) => card(i) && card(i).zone === 'battlefield');
  if (!bl.length) return;
  const pid = card(bl[0]).controller;
  const [pick] = bl.length === 1 ? bl : await env.choosers[pid].pickCards({ forced: true, prompt: 'Sacrifice a creature blocking it', cards: bl, min: 1, max: 1, purpose: 'sacrifice', src: env.src, aiScore: (c) => -cardValue(c) });
  const c = card(pick);
  sacrifice(pick);
  env.did.push(`${who(pid)} ${s_(pid, 'sacrifice')} ${nameTag(c)}`);
}, { first: true });
// Chaos Wand / Strago and Relm / Wand of Wonder: exile until an instant or sorcery (or creature), cast it free, the rest go back
on(/^target opponent exiles cards from the top of their library until they exile an? (instant or sorcery|instant, sorcery, or creature) card\. you may cast that card without paying its mana cost\.( if you cast a creature spell this way, it gains haste and "at the beginning of the end step, sacrifice (?:this creature|~)\.?"?| then put the exiled cards that weren't cast this way on the bottom of that library in a random order)$/, async (m, env) => {
  const [t] = await playerTarget(env, 'target opponent');
  const o = t || opp(env.me);
  const want = m[1].includes('creature') ? /Instant|Sorcery|Creature/ : /Instant|Sorcery/;
  const { hit, all } = exileUntil(o, (c) => want.test(DB[c.def].typeLine || ''));
  env.did.push(`${who(o)} ${s_(o, 'exile')} ${all.length} card${all.length === 1 ? '' : 's'}${hit ? `, hitting ${nameTag(card(hit))}` : ''}`);
  const cast_ = hit ? await castFromPool(env, [hit], { free: true, max: 1 }) : [];
  if (/gains haste/.test(m[2])) {
    for (const i of cast_) {
      const c = card(i);
      if (c && c.zone === 'battlefield' && isCreature(c)) {
        c.eotGrants = [...(c.eotGrants || []), 'haste'];
        c.endOfTurn = 'sacrifice';
      }
    }
  } else all.filter((i) => !cast_.includes(i) && card(i) && card(i).zone === 'exile').sort(() => Math.random() - 0.5).forEach((i) => move(i, 'library', { to: 'bottom' }));
}, { first: true, multi: true });
on(/^roll a d20\. each opponent exiles cards from the top of their library until they exile an instant or sorcery card, then shuffles the rest into their library\. you may cast up to x instant and\/or sorcery spells from among cards exiled this way without paying their mana costs\.?/, async (m, env) => {
  const roll = 1 + Math.floor(Math.random() * 20);
  const x = roll >= 20 ? 3 : roll >= 10 ? 2 : 1;
  const o = opp(env.me);
  const { hit, all } = exileUntil(o, (c) => /Instant|Sorcery/.test(DB[c.def].typeLine || ''));
  all.filter((i) => i !== hit).forEach((i) => move(i, 'library'));
  shuffle(o);
  env.did.push(`rolls ${roll} (up to ${x}); ${who(o)} ${s_(o, 'exile')} ${hit ? nameTag(card(hit)) : 'no instant or sorcery'}`);
  if (hit) await castFromPool(env, [hit], { free: true, max: x });
}, { first: true, multi: true, consumesRest: true });
// Ian Malcolm, Chaotician: "that player exiles the top card of their library" — the other player may cast it on their turns
on(/^that player exiles the top card of their library$/, async (m, env) => {
  const pid = env.thatPlayer || env.me;
  const ids = exileTop(pid, 1);
  for (const i of ids) if (card(i) && env.src) card(i).exiledWith = env.src.iid;
  if (env.src && /that player may cast a spell from among the cards they don't own exiled with/i.test(oracle(env.src))) grantPlay(ids, opp(pid), { anyMana: true, castOnly: true, myTurnOnly: true, ianSrc: env.src.iid });
  env.did.push(`${who(pid)} ${s_(pid, 'exile')} ${ids.map((i) => nameTag(card(i))).join(', ') || 'nothing'}`);
}, { first: true });
// Bident of Thassa: "Creatures your opponents control attack this turn if able."
on(/^creatures your opponents control attack this turn if able$/, async (m, env) => {
  const objs = cardsIn(opp(env.me), 'battlefield').filter(isCreature);
  for (const c of objs) goad(c, env.me);
  env.did.push(`${objs.length} creature${objs.length === 1 ? '' : 's'} must attack this turn`);
}, { first: true });
// Gix: "its controller may pay 1 life. If they do, they draw a card."
on(/^they draw (a|one|two|three) cards?$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  const pid = c ? c.controller : env.me;
  const k = m[1] === 'a' ? 1 : n(m[1]);
  draw(pid, k, true);
  env.did.push(`${who(pid)} ${s_(pid, 'draw')} ${k}`);
}, { first: true });
// Escape to the Wilds & co.: "You may play cards exiled this way until the end of your next turn."
on(/^(?:you may )?(play|cast) (?:the )?cards exiled this way( until the end of your next turn| this turn| until end of turn)?$/, async (m, env) => {
  const ids = (env.them_ || []).filter((i) => card(i) && card(i).zone === 'exile');
  const until = /next turn/.test(m[2] || '') ? G.s.turn + (G.s.active === env.me ? 2 : 1) : G.s.turn;
  grantPlay(ids, env.me, { until, castOnly: m[1] === 'cast' });
  env.did.push(`may play ${ids.length} exiled card${ids.length === 1 ? '' : 's'} ${/next turn/.test(m[2] || '') ? 'until the end of its next turn' : 'this turn'}`);
}, { first: true });
on(/^exile (?:all cards from )?(?:all opponents'|each opponent's|all of your opponents') graveyards?$/, async (m, env) => {
  const o = opp(env.me);
  const ids = zoneOf(o, 'graveyard').slice();
  ids.forEach((i) => move(i, 'exile'));
  env.them_ = ids;
  env.did.push(`exiles ${ids.length} card${ids.length === 1 ? '' : 's'} from ${seatPoss(o)} graveyard`);
}, { first: true });
// "Choose a nonland card exiled this way." (works sentence by sentence when a card's wording differs)
on(/^choose a (nonland |creature |instant or sorcery |)card exiled this way$/, async (m, env) => {
  const pool = (env.them_ || []).filter((i) => card(i) && card(i).zone === 'exile' && (!/nonland/.test(m[1]) || !isLandFace_(card(i))) && (!/creature/.test(m[1]) || /Creature/.test(DB[card(i).def].typeLine || '')));
  if (!pool.length) {
    env.it = null;
    return env.did.push('has no card to choose');
  }
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Choose a ${m[1]}card exiled this way`, cards: pool, min: 1, max: 1, purpose: 'steal', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
  env.it = { iid: pick };
  env.them_ = [pick];
  env.did.push(`chooses ${nameTag(card(pick))}`);
}, { first: true });
// Hoarder's Greed: lose 2, draw 2, clash; repeat while you win
on(/^you lose (\d+) life and draw (\w+) cards?, then clash with an opponent\. if you win, repeat this process$/, async (m, env) => {
  const o = opp(env.me);
  let loops = 0;
  for (; loops < 15 && !G.s.winner; loops++) {
    changeLife(env.me, -+m[1]);
    draw(env.me, n(m[2]), true);
    const [a] = libTop(env.me, 1);
    const [b] = libTop(o, 1);
    const mv = (i) => (i ? DB[card(i).def].cmc || 0 : -1);
    const won = mv(a) > mv(b);
    // clash: each player may put the revealed card on the bottom (lands go down)
    for (const [i, pid] of [[a, env.me], [b, o]]) if (i && isLand(card(i)) && cardsIn(pid, 'battlefield').filter(isLand).length >= 6) move(i, 'library', { to: 'bottom' });
    if (!won) break;
  }
  env.did.push(`loses ${(loops + 1) * +m[1]} life and draws ${(loops + 1) * n(m[2])} (${loops} clash${loops === 1 ? '' : 'es'} won)`);
}, { first: true, multi: true });
// Jhoira, Weatherlight Corsair
on(/^target opponent reveals cards from the top of their library until they reveal a historic permanent card\. you put that card onto the battlefield under your control and lose life equal to that permanent's mana value\. that player puts the rest of the revealed cards on the bottom of their library in a random order$/, async (m, env) => {
  const [pid] = await playerTarget(env, 'target opponent');
  const t = pid || opp(env.me);
  const lib = zoneOf(t, 'library');
  const rest = [];
  let hit = null;
  while (lib.length) {
    const iid = lib[lib.length - 1];
    const c = card(iid);
    move(iid, 'exile');
    const tl = DB[c.def].typeLine || '';
    if (isPermanentCard(DB[c.def]) && /Artifact|Legendary|Saga/.test(tl)) {
      hit = iid;
      break;
    }
    rest.push(iid);
  }
  if (hit) {
    toBattlefield(hit, env.me);
    changeLife(env.me, -(DB[card(hit).def].cmc || 0));
  }
  for (const i of rest.sort(() => Math.random() - 0.5)) move(i, 'library', { to: 'bottom' });
  env.did.push(hit ? `takes ${nameTag(card(hit))} from ${seatPoss(t)} library and loses ${DB[card(hit).def].cmc || 0} life` : 'finds no historic permanent');
}, { first: true, multi: true });
// Dack Fayden, Helping Hand (1 opponent): reveal until a creature card, it enters goaded and the opponent gains control of it
on(/^reveal cards from the top of your library until you reveal x creature cards, where x is the number of opponents you have\. put those creature cards onto the battlefield, then shuffle\. they're goaded for the rest of the game\. for each of those permanents, choose a different opponent\. each opponent gains control of the permanent for which they were chosen$/, async (m, env) => {
  const opps = opponents(env.me);
  const got = revealCreaturesOnto(env.me, opps.length);
  const lines = [];
  got.forEach((i, k) => {
    const to = opps[k] || opp(env.me);
    move(i, 'battlefield', { controller: to });
    if (card(i)) goad(card(i), env.me, 99999);
    if (card(i)) lines.push(`${nameTag(card(i))} enters goaded under ${to === 'p' ? 'your' : multiplayer() ? `${seatName(to)}'s` : "the AI's"} control`);
  });
  env.did.push(lines.length ? lines.join('; ') : 'finds no creature');
}, { first: true, multi: true });
// Scarlet Witch, Chaotic Avenger
on(/^look at the top two cards of your library, then exile them face down\. then you may cast a hero or noncreature spell from among cards exiled with ~ without paying its mana cost$/, async (m, env) => {
  const ids = libTop(env.me, 2);
  ids.forEach((i) => {
    move(i, 'exile');
    Object.assign(card(i), { faceDown: true, exiledWith: env.src && env.src.iid });
  });
  const pool = Object.values(G.s.cards).filter((c) => c.zone === 'exile' && c.exiledWith === (env.src && env.src.iid) && (hasSubtype({ ...c, faceDown: false }, 'Hero') || !/Creature/.test(DB[c.def].typeLine)) && !isLand({ ...c, faceDown: false }));
  env.did.push(`exiles ${ids.length} card${ids.length === 1 ? '' : 's'} face down`);
  if (!pool.length || !(env.castFree || T.castFree)) return;
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'You may cast a Hero or noncreature spell from among them for free', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'cast', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
  if (pick) {
    card(pick).faceDown = false;
    await (env.castFree || T.castFree)(env.me, pick, {});
    env.did.push(`casts ${nameTag(card(pick))} for free`);
  }
}, { first: true, multi: true });
// Blood Money: "For each nontoken creature destroyed this way, create a tapped Treasure token."
on(/^for each (nontoken |token )?(creature|permanent|artifact|enchantment|land|planeswalker) (?:destroyed|that died|that dies) this way(?:,| that you controlled,| your opponents controlled,)? (.+)$/, async (m, env) => {
  const list = (env.thisWay || []).filter((x) => (!m[1] || (m[1] === 'token ' ? x.token : !x.token)) && (m[2] !== 'creature' || x.creature)
    && (!/that you controlled/.test(env.sentence) || x.controller === env.me) && (!/your opponents controlled/.test(env.sentence) || x.controller !== env.me));
  const k = list.length;
  if (!k) return env.did.push('nothing was destroyed that way');
  let t = m[3].trim();
  if (/^create (?:a|an|one) /.test(t)) {
    t = t.replace(/^create (?:a|an|one) /, `create ${k} `).replace(/\btoken\b(?!s)/, 'tokens');
    await runSentence(t, env);
  } else for (let i = 0; i < k; i++) await runSentence(t, env);
}, { first: true });
on(/^exile (?:the top (\w+) cards? of (?:your|target player's|each player's|that player's) library)\.?(?: (?:until end of turn|until the end of your next turn|this turn)?,? ?you may (?:play|cast) (?:that card|those cards|them|it)(?: this turn| until the end of your next turn| until end of turn)?)?/, async (m, env) => {
  const k = n(m[1] || 'a', env.x);
  const pid = /target player|that player/.test(env.sentence) ? (env.thatPlayer || opp(env.me)) : env.me;
  const ids = libTop(pid, k);
  const whileCtl = /for as long as you control (?:this creature|this permanent|~)(?![a-z])/.test(env.text) && env.src;
  const until = whileCtl || /for as long as (?:it|they|that card|those cards) remains? exiled/.test(env.text) ? FOREVER : /next turn/.test(env.text) ? nextTurnNumber(env.me) : G.s.turn;
  for (const i of ids) {
    move(i, 'exile');
    if (/you may (?:play|cast)/.test(env.text)) Object.assign(card(i), { mayPlay: env.me, mayPlayUntil: until, ...(whileCtl ? { playWhileCtl: env.src.iid } : {}) });
  }
  env.them_ = ids;
  env.it = ids[0] ? { iid: ids[0] } : null;
  env.did.push(`exiles ${ids.length ? ids.map((i) => nameTag(card(i))).join(', ') : 'nothing'} from the top of ${pid === env.me ? 'the' : who(pid) + "'s"} library${/you may (?:play|cast)/.test(env.text) ? ' (playable from exile)' : ''}`);
  // Chandra, Torch of Defiance: "You may cast that card. If you don't, …" — decide now
  if (/you may cast that card\. if you don't/.test(env.text) && ids.length === 1) {
    const c = card(ids[0]);
    const aiWants = () => !isLand(c) && (DB[c.def].cmc || 0) <= cardsIn(env.me, 'battlefield').filter((x) => !x.tapped && (isLand(x) || DB[x.def].produced.length)).length;
    const yes = isLand(c) ? false : await env.choosers[env.me].confirm(cardName(c), `Cast ${cardName(c)} this turn? If you don't, the other effect happens instead.`, { aiPick: aiWants, ...(isAI(env.me) ? {} : {}) });
    env.lastMay = isAI(env.me) ? aiWants() : !!yes;
    if (!env.lastMay) Object.assign(c, { mayPlay: null });
  }
});
on(/^exile (?:cards from the top of your library until you exile (?:a|an) (nonland card|creature card|[^,.]+? card)(?: with (?:lesser |a lesser )?mana value[^,.]*)?)/, async (m, env) => {
  const lib = zoneOf(env.me, 'library');
  const exiled = [];
  let hit = null;
  while (lib.length) {
    const iid = lib[lib.length - 1];
    const c = card(iid);
    move(iid, 'exile');
    exiled.push(iid);
    if (/nonland/.test(m[1]) ? !isLand(c) : matchesFilter(c, m[1].replace(/ card$/, ''))) {
      hit = c;
      break;
    }
  }
  env.it = hit ? { iid: hit.iid } : null;
  env.them_ = exiled;
  env.did.push(`exiles ${exiled.length} card${exiled.length === 1 ? '' : 's'}${hit ? `, revealing ${nameTag(hit)}` : ''}`);
});
on(/^exile (all cards from target player's graveyard|all cards from target opponent's graveyard|target player's graveyard|each opponent's graveyard|all graveyards|all cards from all graveyards|target card from a graveyard|up to (\w+) target cards? from (?:a single|target player's|an opponent's) graveyard|all (?:creature )?cards? from (?:target player's|each opponent's) graveyard)/, async (m, env) => {
  let ids = [];
  if (/target card from a graveyard|up to/.test(m[1])) {
    const cnt = m[2] ? n(m[2]) : 1;
    const pool = seats().flatMap((k) => cardsIn(k, 'graveyard'));
    if (pool.length) ids = await env.choosers[env.me].pickCards({ prompt: 'Choose card(s) to exile from a graveyard', cards: pool.map((c) => c.iid), min: 0, max: cnt, purpose: 'gy-exile', src: env.src, aiScore: (c) => (c.owner === env.me ? -5 : DB[c.def].cmc) });
  } else {
    const pids = /all graveyards|all cards from all/.test(m[1]) ? seats() : opponents(env.me);
    ids = pids.flatMap((pid) => zoneOf(pid, 'graveyard').slice()).filter((i) => !/creature/.test(m[1]) || /Creature/.test(DB[card(i).def].typeLine));
  }
  ids.forEach((i) => move(i, 'exile'));
  env.did.push(`exiles ${ids.length} card${ids.length === 1 ? '' : 's'} from graveyard${ids.length === 1 ? '' : 's'}`);
});
const BLINK_RE = /^exile (.+?),? then return (?:it|that card|them|those cards|the exiled card|that permanent|those permanents) to the battlefield( tapped)? under (?:(?:its|their) (?:owner's|owners'|owner's) |your |their )control/;
on(BLINK_RE, async (m, env) => {
  const objs = await objects(env, m[1], { harm: false, purpose: 'blink' });
  const back = [];
  for (const c of objs) {
    const owner = /under your control/.test(env.sentence) ? env.me : c.owner;
    const iid = c.iid;
    const tok = c.token;
    move(iid, 'exile');
    if (!tok && card(iid)) {
      toBattlefield(iid, owner, { tapped: !!m[2] });
      back.push(iid);
      // Planar Incision: "…with a +1/+1 counter on it"
      const wc = env.sentence.match(/with (a|an|one|two|three|four|\d+) (?:additional )?([+-]\d+\/[+-]\d+|[a-z]+) counters? on (?:it|them|each of them)/);
      if (wc) addCounters(card(iid), wc[2], n(wc[1]));
    }
    env.did.push(`flickers ${nameTag(card(iid) || c)}${env.sentence.match(/with (?:a|an|one|two|three|\d+) [^ ]+ counters? on/) ? ' (with a counter)' : ''}`);
  }
  env.them_ = back;
  env.it = back[0] ? { iid: back[0] } : null;
  if (!objs.length) env.lastMay = false;
});
on(/^exile (.+?)\. (?:at the beginning of the next end step, )?return (?:it|that card|them) to the battlefield/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: false });
  for (const c of objs) {
    const iid = c.iid;
    const owner = c.owner;
    move(iid, 'exile');
    if (card(iid)) G.s.delayed.push({ at: 'endStep', kind: 'returnFromExile', iid, pid: owner });
    env.did.push(`exiles ${nameTag(c)} until the next end step`);
  }
});
on(/^exile (.+?)(?: until ~ leaves the battlefield)?$/, async (m, env) => {
  if (/top|graveyard|cards from|until you exile/.test(m[1])) return;
  const returnsLater = /you control/.test(m[1]) && /\breturn (?:that card|those cards|them|it|each of them|the exiled cards?)\b[^.]*to the battlefield/.test(env.text || '');
  const objs = await objects(env, m[1].replace(/ face down$/, ''), returnsLater ? { harm: false, purpose: 'blink' } : { harm: true });
  env.them_ = objs.map((c) => c.iid);
  env.it = objs[0] ? { iid: objs[0].iid } : env.it;
  const until = /until ~ leaves the battlefield/.test(env.sentence);
  // Oblivion Ring, Journey to Nowhere, Fiend Hunter: a separate "leaves the battlefield" trigger brings it back
  const linked = env.src && /leaves the battlefield, return the exiled (?:card|cards|creature|permanent)s?\b/i.test(oracle(env.src) || '');
  for (const c of objs) {
    const nm = `${whose(c)} ${nameTag(c)}`;
    move(c.iid, 'exile', { faceDown: /face down/.test(m[1]) });
    if (until && card(c.iid)) card(c.iid).exiledBy = env.src.iid;
    else if (linked && card(c.iid)) card(c.iid).exiledLinked = env.src.iid;
    if (objs.length <= 3) env.did.push(`exiles ${nm}`);
  }
  if (objs.length > 3) env.did.push(`exiles ${objs.length} permanents`);
  // "Exile it. If you do, you gain 4 life." (Mazemind Tome): "if you do" means something was exiled
  if (/^(?:it|~|this [a-z]+)$/.test(m[1].trim())) env.lastMay = objs.some((c) => card(c.iid) && card(c.iid).zone !== 'battlefield');
  // Duplicant: "As long as a card exiled with ~ is a creature card, ~ has the power, toughness, and creature types of the last
  // creature card exiled with ~."
  const dsrc = env.src && card(env.src.iid);
  const lastCreature = objs.filter((c) => card(c.iid) && card(c.iid).zone === 'exile' && /Creature/.test(DB[c.def].faces[0].typeLine || '')).pop();
  if (dsrc && dsrc.zone === 'battlefield' && lastCreature && /has the power, toughness, and creature types of the last creature card exiled with (?:~|it|this creature)/i.test(stripName(oracle(dsrc), dsrc))) {
    const f = DB[lastCreature.def].faces[0];
    const subs = ((f.typeLine || '').split('—')[1] || '').trim();
    // "*" (Tarmogoyf, Psychosis Crawler): its characteristic-defining ability still works in exile
    const bp = /\*/.test(`${f.power}${f.toughness}`) ? basePT(card(lastCreature.iid)) : { p: parseInt(f.power, 10) || 0, t: parseInt(f.toughness, 10) || 0 };
    dsrc.layerFx = [...(dsrc.layerFx || []).filter((e) => !e.imprint), { ts: nextStamp(), imprint: true, base: { p: bp.p, t: bp.t }, ...(subs ? { types: { subAdd: subs } } : {}) }];
    env.did.push(`${nameTag(dsrc)} becomes ${bp.p}/${bp.t}${subs ? ' ' + subs : ''}`);
  }
}, { skipIf: /top|graveyard|cards from|until you exile/ });
on(/^return (.+?) to (?:its|their) owner'?s?'? hands?/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: env.me !== 'self' });
  for (const c of objs) {
    const nm = `${whose(c)} ${nameTag(c)}`;
    move(c.iid, 'hand');
    if (objs.length <= 3) env.did.push(`returns ${nm} to its owner's hand`);
  }
  if (objs.length > 3) env.did.push(`returns ${objs.length} permanents to their owners' hands`);
}, { skipIf: /graveyard/ });
on(/^the owner of (.+?) puts it (?:into their library|on top of or on the bottom of their library|on the top or bottom of their library)(.*)$/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: true });
  for (const c of objs) {
    const owner = c.owner;
    const second = /second from the top/.test(m[2] || env.sentence);
    const opts = [{ label: second ? 'Second from the top' : 'On top' }, { label: 'On the bottom' }];
    const k = await env.choosers[owner].choose({ prompt: `Put ${cardName(c)} into your library:`, options: opts, aiPick: () => 0 });
    const nm = `${whose(c)} ${nameTag(c)}`;
    const lib = zoneOf(owner, 'library');
    if (k === 1) move(c.iid, 'library', { to: 'bottom' });
    else move(c.iid, 'library', second ? { to: Math.max(0, lib.length - 1) } : {});
    env.did.push(`${nm} goes ${k === 1 ? 'to the bottom of' : second ? 'second from the top of' : 'on top of'} its owner's library`);
  }
});
on(/^(?:put|shuffle) (.+?) (?:on top of|on the bottom of|into) (?:its|their) owner'?s?'? librar(?:y|ies)(?: (second|third|fourth|fifth) from the top)?/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: !/^(?:~|it)$/.test(m[1].trim()) });
  const bottom = /on the bottom/.test(env.sentence);
  const nth = { second: 2, third: 3, fourth: 4, fifth: 5 }[m[2]] || 0;
  for (const c of objs) {
    const owner = c.owner;
    const nm = `${whose(c)} ${nameTag(c)}`;
    const lib = zoneOf(owner, 'library');
    move(c.iid, 'library', bottom ? { to: 'bottom' } : nth ? { to: Math.max(0, lib.length - (nth - 1)) } : {});
    if (/shuffle/.test(env.sentence)) shuffle(owner);
    env.did.push(`puts ${nm} ${bottom ? 'on the bottom of' : /shuffle/.test(env.sentence) ? 'into' : nth ? `${m[2]} from the top of` : 'on top of'} its owner's library`);
  }
}, { skipIf: /graveyard|from your hand/ });

// --- damage
on(/^(~|it|he|she|that creature|enchanted creature|equipped creature|target creature you control|each creature|each other creature)?\s?deals? (\d+|x|damage equal to [^.]+?|that much damage|twice that much damage) (?:damage )?to (.+?)(?:\. |$)/, async (m, env) => {
  let amount = /that much/.test(m[2]) ? env.lastAmount || 0 : /^damage equal/.test(m[2]) ? amountOf(m[2].replace(/^damage /, ''), env) : amountOf(m[2], env);
  if (/twice that much/.test(m[2])) amount *= 2;
  let source = env.src;
  if (m[1] && /target creature you control/.test(m[1])) {
    const [c] = await objects(env, 'target creature you control', { harm: false });
    if (!c) return;
    source = c;
    if (/power/.test(m[2])) amount = power(c);
  } else if (m[1] && /^(?:enchanted|equipped) creature$/.test(m[1]) && env.src.attachedTo) source = card(env.src.attachedTo);
  if (m[1] && /^each (?:other )?creature/.test(m[1])) {
    // each creature deals damage equal to its power to … (rare)
    return;
  }
  let to = m[3].replace(/\.$/, '').replace(/, where x is .+$/, '');
  // Batroc the Leaper: "to each of up to X targets"
  to = to.replace(/^each of (up to (?:x|\w+)) targets$/, '$1 any target');
  if (/^up to x\b/.test(to) && !env.x) return env.did.push('X is 0, so no targets');
  if (/^up to x\b/.test(to)) to = to.replace(/^up to x\b/, `up to ${env.x}`);
  const divided = /divided as you choose/.test(env.sentence);
  to = to.replace(/ divided as you choose among (.+)$/, ' $1').replace(/^(?:one|any number of) /, '');
  await dealDamage(env, source, amount, to, divided);
});
on(/^(~|it) deals (\d+|x) damage divided as you choose among (.+?)(?:\.|$)/, async (m, env) => {
  const ph = m[3].toLowerCase();
  const count = /any number/.test(ph) ? 99 : /three/.test(ph) ? 3 : /two/.test(ph) ? 2 : 1;
  const rest = ph.replace(/^(?:one, two, or three|one or two|one or more|any number of|two|three) /, '');
  const kind = /^targets?$/.test(rest) ? 'any target' : rest.replace(/^targets? /, 'target ').replace(/s$/, '').replace(/s or /, ' or ');
  await dealDamage(env, env.src, amountOf(m[2], env), `up to ${count === 99 ? 'any number of' : count} ${/^target|^any target/.test(kind) ? kind : 'target ' + kind}`, true);
});
async function dealDamage(env, source, amount, toPhrase, divided) {
  const to = toPhrase.toLowerCase();
  const me = env.me;
  const parts = to.split(/ and (?=each|target|you|that|its|any|up to)/);
  for (const part of parts) {
    if (/^each (?:opponent|player)|^you$|^that player|^its controller|^defending player|^target (?:player|opponent)$/.test(part) || /^each opponent and each creature/.test(part)) {
      const ps = /^each player/.test(part) ? seats() : await playerTarget(env, part.replace(/ and .*/, ''));
      for (const pid of ps) damagePlayer(env, source, pid, amount);
      if (/and each creature/.test(part)) for (const c of await objects(env, 'each creature' + (part.match(/each creature(.*)$/) || ['', ''])[1])) damagePermanent(env, source, c, amount);
      continue;
    }
    if (/^each |^all /.test(part)) {
      const objs = await objects(env, part);
      for (const c of objs) damagePermanent(env, source, c, amount);
      env.did.push(`deals ${amount} damage to ${objs.length} ${objs.length === 1 ? 'creature' : 'creatures'}`);
      continue;
    }
    if (/target|any target/.test(part) || /^up to/.test(part)) {
      const picks = await pickTargetsForDamage(env, part, amount);
      const each = divided && picks.length ? Math.max(1, Math.floor(amount / picks.length)) : amount;
      let extra = divided && picks.length ? amount - each * picks.length : 0; // the remainder goes to the first target
      for (const pk of picks) {
        const amt = each + (extra > 0 ? extra : 0);
        extra = 0;
        if (pk.player) damagePlayer(env, source, pk.player, amt);
        else if (card(pk.iid)) damagePermanent(env, source, card(pk.iid), amt, true);
      }
      continue;
    }
    if (/^(?:~|itself|it)$/.test(part)) {
      const t = /itself|~/.test(part) ? source : env.it && card(env.it.iid);
      if (t) damagePermanent(env, source, t, amount, true);
      continue;
    }
    const objs = await objects(env, part);
    for (const c of objs) damagePermanent(env, source, c, amount, true);
  }
}
async function pickTargetsForDamage(env, part, amount, exclude) {
  const p = part.replace(/^(?:one |)/, '');
  return pickTargets(env, /target/.test(p) ? p : 'any target', { harm: true, amount, exclude });
}
function damageMult(source, toPlayer) {
  let m = 1;
  for (const c of cardsIn(source.controller || source.owner, 'battlefield')) {
    if (/If a source you control would deal damage to (?:a permanent or player|an opponent or a permanent an opponent controls), it deals (double|triple) that damage/i.test(oracle(c))) m *= /triple/i.test(oracle(c)) ? 3 : 2;
  }
  void toPlayer;
  return m;
}
// --- Empower Jace N: put N loyalty counters on a Jace token you control, making one first if needed
export const JACE_TOKEN = 'gen-jace-empower';
function jaceTokenDef() {
  if (!DB[JACE_TOKEN]) {
    const typeLine = 'Token Planeswalker — Jace';
    const oracleText = '−1: Surveil 1.\n−3: Draw a card.';
    DB[JACE_TOKEN] = {
      id: JACE_TOKEN, name: 'Jace', layout: 'token', cmc: 0, manaCost: '', typeLine, colors: ['U'], ci: [], keywords: [], produced: [],
      tokens: [], doubleFaced: false, isToken: true,
      faces: [{ name: 'Jace', manaCost: '', typeLine, oracle: oracleText, loyalty: '0', img: null, imgLarge: null }],
    };
  }
  return JACE_TOKEN;
}
on(/^empower (?:jace|~) (\d+|x|a|one|two|three|four|five|six|seven|eight|nine|ten)$/, async (m, env) => {
  const k = n(m[1], env.x);
  let jace = cardsIn(env.me, 'battlefield').find((c) => c.token && isType(c, 'Planeswalker') && hasSubtype(c, 'Jace'));
  if (!jace) {
    const [t] = createToken(jaceTokenDef(), env.me, 1, { noDouble: true });
    jace = card(t);
    jace.counters.loyalty = 0;
    env.did.push('creates a Jace planeswalker token');
  }
  if (k > 0) addCounters(jace, 'loyalty', k);
  env.it = { iid: jace.iid };
  env.did.push(`empowers Jace ${k} (${jace.counters.loyalty} loyalty)`);
}, { first: true });

// --- "Reveal cards from the top of your library until you reveal a creature or planeswalker card."
on(/^reveal cards from the top of your library until you reveal (a|an|one|two|three|\d+) ([a-z ,/-]+?) cards?(?: with [^.]+)?$/, async (m, env) => {
  const want = n(m[1], env.x) || 1;
  const kind = m[2].trim();
  const lib = zoneOf(env.me, 'library');
  const revealed = [];
  const hits = [];
  for (let k = lib.length - 1; k >= 0 && hits.length < want; k--) {
    const c = card(lib[k]);
    revealed.push(c.iid);
    const ok = /^nonland$/.test(kind) ? !isLand(c) : kind.split(/,? or |, /).some((part) => matchesAny(c, part.trim()));
    if (ok) hits.push(c.iid);
  }
  env.revealed = revealed.filter((i) => !hits.includes(i));
  env.it = hits[0] ? { iid: hits[0] } : null;
  env.them_ = hits;
  env.did.push(`reveals ${revealed.length} card${revealed.length === 1 ? '' : 's'}${hits.length ? `, hitting ${hits.map((i) => nameTag(card(i))).join(', ')}` : ' without a hit'}`);
}, { first: true });
on(/^(?:you may )?put (?:that card|it|those cards|them) (onto the battlefield(?: tapped)?(?: under your control)?|into your hand)(?:,? and| and then|\. then)? ?(?:put )?(?:all other cards revealed this way|the rest|the other revealed cards) (on the bottom of your library in a random order|on the bottom of your library in any order|into your graveyard|into your library)?(?:,? then shuffle)?$/, async (m, env) => {
  const ids = env.them_ && env.them_.length ? env.them_ : env.it && env.it.iid ? [env.it.iid] : [];
  for (const i of ids) {
    const c = card(i);
    if (!c) continue;
    if (/battlefield/.test(m[1])) toBattlefield(i, env.me, { tapped: /tapped/.test(m[1]) });
    else move(i, 'hand');
  }
  if (ids.length) env.did.push(`puts ${ids.map((i) => nameTag(card(i))).join(', ')} ${/battlefield/.test(m[1]) ? 'onto the battlefield' : 'into hand'}`);
  const rest = (env.revealed || []).filter((i) => card(i) && card(i).zone === 'library');
  const where = m[2] || (/shuffle/.test(env.sentence) ? 'into your library' : 'on the bottom of your library in a random order');
  if (/graveyard/.test(where)) rest.forEach((i) => move(i, 'graveyard'));
  else if (/bottom/.test(where)) {
    rest.sort(() => Math.random() - 0.5);
    rest.forEach((i) => move(i, 'library', { to: 'bottom' }));
  }
  if (/shuffle|into your library/.test(env.sentence)) shuffle(env.me);
}, { first: true });

// Jace, Multiverse Architect: "they may pay {2}. If they don't, creatures they control can't attack Jaces you control this turn."
on(/^(they|that player|the active player) may pay ((?:\{[^}]+\})+)$/, async (m, env) => {
  const payer = env.thatPlayer && env.thatPlayer !== env.me ? env.thatPlayer : G.s.active && G.s.active !== env.me ? G.s.active : opp(env.me);
  const { T } = await import('./triggers.js');
  let paid = false;
  if (isAI(payer)) {
    // worth it only if the AI has creatures that could go after a Jace and mana to spare
    const wants = cardsIn(payer, 'battlefield').some((c) => isCreature(c) && !c.tapped && power(c) > 0) && cardsIn(env.me, 'battlefield').some((c) => isType(c, 'Planeswalker') && hasSubtype(c, 'Jace'));
    if (wants) paid = T.payMana ? await T.payMana(payer, m[2], cardName(env.src)) : false;
  } else {
    const yes = await env.choosers.p.confirm(cardName(env.src), `Pay ${m[2]}? If you don't, your creatures can't attack Jaces this turn.`, {});
    if (yes) paid = T.payMana ? await T.payMana('p', m[2], cardName(env.src)) : false;
  }
  env.lastMay = !!paid;
  env.did.push(paid ? `${who(payer)} ${s_(payer, 'pay')} ${m[2]}` : `${who(payer)} ${payer === 'p' ? "don't" : "doesn't"} pay`);
}, { first: true });
on(/^creatures they control can't attack (?:~s|jaces|jace planeswalkers) you control this turn$/, async (m, env) => {
  G.s.noAttackJace = { owner: env.me, turn: G.s.turn };
  env.did.push(`creatures can't attack ${who(env.me) === 'you' ? 'your' : "the AI's"} Jaces this turn`);
}, { first: true });
// --- saga chapters and friends
// The Eldest Reborn: "Put target creature or planeswalker card from a graveyard onto the battlefield under your control."
on(/^put (target [^.]+?|up to (?:one|two|three) target [^.]+?) cards? from (a|your|an opponent's|target player's) graveyards? onto the battlefield(?: under your control)?( tapped)?$/, async (m, env) => {
  await runSentence(`Return ${m[1]} card from ${m[2]} graveyard to the battlefield under your control${m[3] || ''}`, env);
}, { first: true });
// Urza's Saga: "~ gains "{T}: Add {C}."" (permanently)
on(/^(~|it|this land|this saga) gains "(.+)"$/, async (m, env) => {
  const c = /^(?:~|this)/.test(m[1]) ? env.src : env.it && card(env.it.iid);
  if (!c || c.zone !== 'battlefield') return;
  const low = env.sentence.match(/gains "(.+)"$/i)[1];
  const at = (env.fullText || '').toLowerCase().indexOf(low.toLowerCase());
  const txt = (at >= 0 ? env.fullText.slice(at, at + low.length) : low).replace(/'/g, '"');
  c.extraText = (c.extraText ? c.extraText + '\n' : '') + txt;
  env.did.push(`${nameTag(c)} gains "${esc(txt)}"`);
}, { first: true });
// The Akroan War: "Until your next turn, creatures your opponents control attack each combat if able."
on(/^until your next turn, creatures your opponents control attack each combat if able$/, async (m, env) => {
  G.s.mustAttackAll = { pid: opp(env.me), until: nextTurnNumber(env.me) };
  env.did.push(`${who(opp(env.me)) === 'you' ? 'your' : "the AI's"} creatures must attack until ${who(env.me) === 'you' ? 'your' : "the AI's"} next turn`);
}, { first: true });
// The Akroan War: "Each tapped creature deals damage to itself equal to its power."
on(/^each tapped creature deals damage to itself equal to its power$/, async (m, env) => {
  const hit = [];
  for (const pid of seats()) for (const c of cardsIn(pid, 'battlefield').filter((x) => isCreature(x) && x.tapped)) {
    const pw = Math.max(0, power(c));
    if (pw > 0) {
      damagePermanent(env, c, c, pw);
      hit.push(nameTag(c));
    }
  }
  env.did.push(hit.length ? `${hit.join(', ')} damage${hit.length === 1 ? 's itself' : ' themselves'}` : 'no tapped creatures');
}, { first: true });
// Elspeth Conquers Death: "Noncreature spells your opponents cast cost {2} more to cast until your next turn."
on(/^((?:[\w-]+ ){0,4}?)spells your opponents cast cost \{(\d+)\} more to cast until your next turn$/, async (m, env) => {
  G.s.tempCosts = [...(G.s.tempCosts || []).filter((t) => t.until > G.s.turn), { who: 'theirs', owner: env.me, filter: m[1].trim(), delta: +m[2], until: nextTurnNumber(env.me) }];
  env.did.push(`${m[1].trim() || ''} spells cost {${m[2]}} more for ${who(opp(env.me))} until ${who(env.me) === 'you' ? 'your' : "the AI's"} next turn`);
}, { first: true });
// Elspeth Conquers Death: "Put a +1/+1 counter or a loyalty counter on it."
on(/^put a \+1\/\+1 counter or a loyalty counter on (it|that creature|that permanent)$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  if (!c || c.zone !== 'battlefield') return;
  const kind = isType(c, 'Planeswalker') && !isCreature(c) ? 'loyalty' : '+1/+1';
  addCounters(c, kind, 1);
  env.did.push(`puts a ${kind} counter on ${nameTag(c)}`);
}, { first: true });
// --- sweep fixes
// ===== Jace deck audit =====
// Waterbending Lesson: "Then discard a card unless you waterbend {2}."
on(/^(.+?) unless you waterbend \{(\d+)\}$/, async (m, env) => {
  const k = +m[2];
  const { T } = await import('./triggers.js');
  const want = isAI(env.me) ? true : await env.choosers.p.confirm(cardName(env.src), `Waterbend {${k}} so you don't have to ${m[1].replace(/^then /i, '')}? (Tap artifacts and creatures to help.)`, {});
  const paid = want && T.payMana ? await T.payMana(env.me, `{${k}}`, `Waterbend {${k}}`, { waterbend: k }) : false;
  if (paid) return env.did.push(`${who(env.me)} ${s_(env.me, 'waterbend')} {${k}}`);
  await runSentence(m[1], env);
}, { first: true });
// Command Bridge: "sacrifice it unless you tap an untapped permanent you control"
on(/^sacrifice (?:it|~|this land) unless you tap an untapped (permanent|creature|artifact|land) you control$/, async (m, env) => {
  const me = env.src && card(env.src.iid);
  if (!me || me.zone !== 'battlefield') return;
  const pool = cardsIn(env.me, 'battlefield').filter((c) => !c.tapped && !c.phasedOut && c.iid !== me.iid && (m[1] === 'permanent' || (m[1] === 'creature' ? isCreature(c) : isType(c, m[1][0].toUpperCase() + m[1].slice(1)))));
  // the AI taps a land it already used / a creature that isn't needed; skips the summoning-sick-free ones last
  const score = (c) => (isLand(c) ? 2 : 0) + (isCreature(c) ? -cardValue(c) / 4 : 0) - ((manaAbility(c) || { amount: 0 }).amount ? 1 : 0);
  const [pick] = pool.length ? await env.choosers[env.me].pickCards({ prompt: `${cardName(me)}: tap an untapped ${m[1]} you control (or none to sacrifice it)`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'tapCost', src: env.src, aiScore: score }) : [];
  if (pick && card(pick)) {
    tapPerm(card(pick));
    env.did.push(`taps ${nameTag(card(pick))} to keep ${nameTag(me)}`);
  } else {
    sacrifice(me.iid);
    env.did.push(`sacrifices ${nameTag(me)}`);
  }
}, { first: true });
// Tariel: "Choose a creature card at random from target opponent's graveyard. Put that card onto the battlefield under your control."
on(/^choose an? ([a-z]+) card at random from target opponent's graveyard\. put that card onto the battlefield under your control$/, async (m, env) => {
  const [o] = await playerTarget(env, 'target opponent');
  if (!o) return;
  const pool = cardsIn(o, 'graveyard').filter((c) => matchesAny(c, m[1]));
  if (!pool.length) return env.did.push(`${who(o) === 'you' ? 'your' : "the AI's"} graveyard has no ${m[1]} cards`);
  const pick = pool[Math.floor(Math.random() * pool.length)];
  toBattlefield(pick.iid, env.me);
  env.did.push(`randomly picks ${nameTag(card(pick.iid))} and puts it onto the battlefield`);
}, { first: true, multi: true });
// Bounce lands: "return a land you control to its owner's hand" / Coral Atoll: "sacrifice it unless you return an untapped Island you control to its owner's hand"
async function bounceOwnLand(env, kind, untapped, optional) {
  const pool = cardsIn(env.me, 'battlefield').filter((c) => isLand(c) && (!untapped || !c.tapped) && (kind === 'land' || hasSubtype(c, kind) || matchesFilter(c, kind)));
  if (!pool.length) return null;
  // the AI returns a tapped basic first (it can replay it), never the new land unless it must
  const score = (c) => (env.src && c.iid === env.src.iid ? -5 : 0) + (c.tapped ? 3 : 0) + (/Basic/.test(typeLine(c)) ? 2 : 0) - (manaAbility({ ...c, tapped: false }) || { amount: 1 }).amount;
  const [pick] = await env.choosers[env.me].pickCards({ forced: !optional, prompt: `Return ${untapped ? 'an untapped ' : 'a '}${kind} you control to its owner's hand`, cards: pool.map((c) => c.iid), min: optional ? 0 : 1, max: 1, purpose: 'bounceLand', src: env.src, aiScore: score });
  if (!pick) return null;
  const c = card(pick);
  move(pick, 'hand');
  env.did.push(`returns ${nameTag(c)} to ${who(env.me) === 'you' ? 'your' : "the AI's"} hand`);
  return c;
}
on(/^return (?:a|an) (untapped )?(land|[a-z]+) you control to its owner's hand$/, async (m, env) => {
  const c = await bounceOwnLand(env, m[2], !!m[1], false);
  env.it = c ? { iid: c.iid } : null;
  env.lastMay = !!c;
}, { first: true });
on(/^sacrifice (?:~|it) unless you return (?:a|an) (untapped )?(land|[a-z]+) you control to its owner's hand$/, async (m, env) => {
  const c = isAI(env.me) || (await env.choosers.p.confirm(cardName(env.src), `Return ${m[1] ? 'an untapped ' : 'a '}${m[2]} to your hand? If you don't, ${cardName(env.src)} is sacrificed.`, {}))
    ? await bounceOwnLand(env, m[2], !!m[1], true) : null;
  if (!c && env.src && env.src.zone === 'battlefield') {
    sacrifice(env.src.iid);
    env.did.push(`sacrifices ${nameTag(env.src)}`);
  }
}, { first: true });
// Fatehold Charm, Venser: "Return target spell or creature to its owner's hand."
on(/^return target spell or (creature|permanent|nonland permanent) to its owner's hand$/, async (m, env) => {
  const sp = env.stackTarget && card(env.stackTarget);
  if (sp && sp.zone !== 'battlefield') {
    G.s.stack.countered = true;
    G.s.stack.bounced = true;
    env.did.push(`returns ${nameTag(sp)} to its owner's hand`);
    env.bounceSpell = sp.iid;
    return;
  }
  await runSentence(`Return target ${m[1]} to its owner's hand`, env);
}, { first: true });
// Chandra, Flamecaller 0: "Discard all the cards in your hand, then draw that many cards plus one."
on(/^discard (?:all the cards in )?your hand$/, async (m, env) => {
  const hand = cardsIn(env.me, 'hand').map((c) => c.iid);
  hand.forEach((i) => discardCard(i));
  env.lastAmount = hand.length;
  env.discarded = [...(env.discarded || []), ...hand];
  env.did.push(`${who(env.me)} ${s_(env.me, 'discard')} ${hand.length} card${hand.length === 1 ? '' : 's'}`);
}, { first: true });
// Lifestream's Blessing: "If this spell was cast from exile, you gain twice X life."
on(/^if this spell was cast from (exile|your graveyard|your hand), you gain (twice x|x) life$/, async (m, env) => {
  const from = env.castFrom || (env.src && (card(env.src.iid) || env.src).castFrom);
  const want = m[1] === 'exile' ? 'exile' : m[1] === 'your graveyard' ? 'graveyard' : 'hand';
  if (from !== want) return env.did.push(`wasn't cast from ${m[1]}`);
  const k = (env.x || 0) * (/twice/.test(m[2]) ? 2 : 1);
  changeLife(env.me, k, false);
  env.did.push(`${who(env.me)} ${s_(env.me, 'gain')} ${k} life`);
}, { first: true });
on(/^you gain twice x life$/, async (m, env) => {
  const k = 2 * (env.x || 0);
  changeLife(env.me, k, false);
  env.did.push(`${who(env.me)} ${s_(env.me, 'gain')} ${k} life`);
});
// The Elder Dragon War II: "Discard any number of cards, then draw that many cards."
on(/^discard any number of cards, then draw that many cards$/, async (m, env) => {
  const hand = cardsIn(env.me, 'hand');
  const lands = cardsIn(env.me, 'battlefield').filter(isLand).length;
  const picks = hand.length ? await env.choosers[env.me].pickCards({ prompt: 'Discard any number of cards (you draw that many)', cards: hand.map((c) => c.iid), min: 0, max: hand.length, purpose: 'discard', src: env.src,
    aiScore: (c) => (isLand(c) ? (lands >= 5 ? 10 : -10) : (DB[c.def].cmc || 0) > lands + 2 ? 5 : -5) }) : [];
  // the AI only throws away what it scores as dead weight
  const keep = isAI(env.me) ? picks.filter((i) => { const c = card(i); return isLand(c) ? lands >= 5 : (DB[c.def].cmc || 0) > lands + 2; }) : picks;
  keep.forEach((i) => discardCard(i));
  if (keep.length) draw(env.me, keep.length, true);
  env.lastAmount = keep.length;
  env.did.push(`${who(env.me)} ${s_(env.me, 'discard')} ${keep.length} and ${s_(env.me, 'draw')} ${keep.length}`);
}, { first: true });
// Dragonhawk, Fate's Tempest: "At the beginning of your next end step, ~ deals 2 damage to each opponent for each of those cards that are still exiled."
on(/^at the beginning of your next end step, ~ deals (\w+) damage to each opponent for each of those cards that are still exiled$/, async (m, env) => {
  const ids = (env.them_ || env.revealed || []).filter((i) => card(i) && card(i).zone === 'exile');
  if (!ids.length || !env.src) return env.did.push('nothing exiled');
  G.s.delayed.push({ at: 'endStep', whoseEnd: env.me, kind: 'exiledDamage', ids, src: env.src.iid, per: n(m[1]), pid: env.me });
  env.did.push(`at ${seatPoss(env.me)} next end step, ${n(m[1])} damage to ${env.me === 'p' ? 'the AI' : 'you'} for each of those cards still in exile`);
}, { first: true });
// Gatewatch Beacon: "you may move a loyalty counter from ~ onto that planeswalker"
on(/^(you may )?move (a|an|one|two|three|\d+|all) ([a-z+\/0-9-]+) counters? from ~ onto (that planeswalker|that creature|it|target [a-z ]+)$/, async (m, env) => {
  const src = env.src && card(env.src.iid);
  const have = ((src && src.counters) || {})[m[3]] || 0;
  if (!src || !have) return env.did.push(`no ${m[3]} counters to move`);
  const [t] = /^target /.test(m[4]) ? await objects(env, m[4], { harm: false }) : [env.it && env.it.iid && card(env.it.iid)];
  if (!t || t.zone !== 'battlefield') return env.did.push('nothing to move it onto');
  if (m[1] && env.me === 'p' && !(await env.choosers.p.confirm(cardName(src), `Move ${m[2] === 'all' ? 'all' : m[2]} ${m[3]} counter${m[2] === 'a' || m[2] === 'one' ? '' : 's'} from ${cardName(src)} onto ${cardName(t)}?`, {}))) return;
  const k = Math.min(have, m[2] === 'all' ? have : n(m[2]));
  src.counters[m[3]] = have - k;
  if (!src.counters[m[3]] && m[3] !== 'loyalty') delete src.counters[m[3]];
  addCounters(t, m[3], k, { by: env.me });
  env.did.push(`moves ${k} ${m[3]} counter${k === 1 ? '' : 's'} onto ${nameTag(t)}`);
}, { first: true });
// Garruk, Primal Hunter -3: "Draw cards equal to the greatest power among creatures you control."
on(/^(?:you )?draw cards equal to (.+)$/, async (m, env) => {
  const k = Math.max(0, xFrom(m[1], env) || 0);
  if (k) draw(env.me, k, true);
  env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${k}`);
});
on(/^draw that many cards(?: plus (one|two|three))?$/, async (m, env) => {
  const k = (env.lastAmount || 0) + (m[1] ? n(m[1]) : 0);
  if (k) draw(env.me, k);
  env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${k}`);
}, { first: true });
// The Chain Veil: "For each planeswalker you control, you may activate one of its loyalty abilities once this turn as though none of its loyalty abilities have been activated this turn."
on(/^for each planeswalker you control, you may activate one of its loyalty abilities once this turn as though none of its loyalty abilities have been activated this turn$/, async (m, env) => {
  const cv = G.s.chainVeil && G.s.chainVeil.pid === env.me && G.s.chainVeil.turn === G.s.turn ? G.s.chainVeil : { pid: env.me, turn: G.s.turn, n: 0 };
  cv.n += 1;
  G.s.chainVeil = cv;
  env.did.push('each planeswalker may use another loyalty ability this turn');
}, { first: true });
// Jace's Machinations / Teferi emblem: loyalty abilities at instant speed (the table already lets you; nothing to enforce)
on(/^until end of turn, you may activate loyalty abilities of ([^.]+?) on any player's turn any time you could cast an instant$/, async (m, env) => {
  const sub = (m[1].match(/^([A-Z]?\w+) planeswalkers/i) || [])[1];
  G.s.instantLoyalty = { pid: env.me, turn: G.s.turn, subtype: sub && !/^planeswalkers?$/i.test(sub) ? sub : null };
  env.did.push('loyalty abilities can be used at instant speed this turn');
}, { first: true });
// Jace, Memory Adept −7: "Any number of target players each draw twenty cards."
on(/^any number of target players each draw (\w+) cards?$/, async (m, env) => {
  const k = n(m[1], env.x);
  let pids;
  if (isAI(env.me)) pids = multiplayer() ? [opp(env.me)] : opponents(env.me); // deck the opponent
  else {
    const others = opponents('p');
    const ch = await env.choosers[env.me].choose({ prompt: `Who draws ${k}?`, options: [...others.map((o) => ({ label: seatLabel(o) })), { label: 'You' }, { label: multiplayer() ? 'Everyone' : 'Both' }], aiPick: () => 0 });
    pids = ch === others.length ? ['p'] : ch === others.length + 1 ? seats().filter(inGame) : [others[ch] || others[0]];
  }
  for (const pid of pids) {
    draw(pid, k);
    env.did.push(`${who(pid)} ${s_(pid, 'draw')} ${k}`);
  }
}, { first: true });
// Jace, Reality Sculptor 0: "Exile all but the bottom card of each opponent's library."
on(/^exile all but the bottom card of (each opponent's|target player's|target opponent's) library$/, async (m, env) => {
  const pid = opp(env.me);
  const lib = zoneOf(pid, 'library').slice();
  const keep = lib[0]; // index 0 is the bottom
  let k = 0;
  for (const i of lib) if (i !== keep) {
    move(i, 'exile');
    k++;
  }
  env.did.push(`exiles ${k} cards from ${who(pid) === 'you' ? 'your' : "the AI's"} library`);
}, { first: true });
// Jace, Reality Sculptor −3 / Jace, Architect of Thought +1: attackers get −N/−0
on(/^until your next turn, whenever a creature (an opponent controls attacks|attacks you or a planeswalker you control), it gets -(\d+)\/-0 until end of turn$/, async (m, env) => {
  G.s.attackShrink = [...(G.s.attackShrink || []).filter((x) => x.until > G.s.turn), { owner: env.me, n: +m[2], until: nextTurnNumber(env.me), onlyAtMe: /attacks you/.test(m[1]) }];
  env.did.push(`until ${who(env.me) === 'you' ? 'your' : "the AI's"} next turn, attacking creatures get −${m[2]}/−0`);
}, { first: true });
// Jace, Architect of Thought −2: piles
on(/^reveal the top (three|two|four|five) cards of your library\. an opponent separates those cards into two piles\. put one pile into your hand and the other (on the bottom of your library in any order|into your graveyard)$/, async (m, env) => {
  const ids = libTop(env.me, n(m[1]));
  if (!ids.length) return;
  const sep = opp(env.me);
  let pile1;
  if (isAI(sep)) {
    // the AI puts the best card alone against the rest
    const best = ids.slice().sort((a, b) => cardValue(card(b)) - cardValue(card(a)))[0];
    pile1 = [best];
  } else {
    pile1 = await env.choosers.p.pickCards({ prompt: `Separate ${cardName(env.src)}'s cards into two piles: choose pile 1 (the rest is pile 2)`, cards: ids, min: 0, max: ids.length, purpose: 'pile', src: env.src, forced: true });
  }
  const pile2 = ids.filter((i) => !pile1.includes(i));
  const val = (p) => p.reduce((a, i) => a + cardValue(card(i)) + 1, 0);
  let take;
  if (isAI(env.me)) take = val(pile1) >= val(pile2) ? pile1 : pile2;
  else {
    const k = await env.choosers.p.choose({ prompt: 'Which pile goes to your hand?', options: [{ label: `Pile 1: ${pile1.map((i) => cardName(card(i))).join(', ') || '(empty)'}` }, { label: `Pile 2: ${pile2.map((i) => cardName(card(i))).join(', ') || '(empty)'}` }], aiPick: () => 0 });
    take = k === 1 ? pile2 : pile1;
  }
  const rest = ids.filter((i) => !take.includes(i));
  take.forEach((i) => move(i, 'hand'));
  rest.forEach((i) => (/graveyard/.test(m[2] || '') ? move(i, 'graveyard') : move(i, 'library', { to: 'bottom' })));
  env.did.push(`reveals ${ids.map((i) => nameTag(card(i))).join(', ')}; takes ${take.length ? take.map((i) => nameTag(card(i))).join(', ') : 'nothing'}`);
}, { first: true, multi: true });
// Jace, the Mind Sculptor +2 (fateseal 1): "Look at the top card of target player's library. You may put that card on the bottom of that player's library."
on(/^look at the top card of (target player's|your|each player's|target opponent's) library\. you may put (?:that card|it) on the bottom of (?:that player's|your|their) library$/, async (m, env) => {
  const [pid] = /^your/.test(m[1]) ? [env.me] : await playerTarget(env, /opponent/.test(m[1]) ? 'target opponent' : 'target player', true);
  const who_ = pid || opp(env.me);
  const [top] = libTop(who_, 1);
  if (!top) return env.did.push('finds an empty library');
  const c = card(top);
  const good = !isLand(c) || cardsIn(who_, 'battlefield').filter(isLand).length < 5;
  // the AI bottoms good cards from your library and bad cards from its own
  const aiPick = () => (who_ === env.me ? !good : good);
  const yes = isAI(env.me) ? aiPick() : await env.choosers[env.me].confirm(cardName(c), `Top of ${seatPoss(who_)} library: ${cardName(c)}. Put it on the bottom?`, {});
  if (yes) move(top, 'library', { to: 'bottom' });
  env.did.push(`looks at the top card of ${who_ === env.me ? 'its own' : (seatPoss(who_))} library${yes ? ' and puts it on the bottom' : ' and leaves it'}`);
}, { first: true, multi: true });
// Jace, the Mind Sculptor −12
on(/^exile all cards from (target player's|target opponent's|each opponent's) library, then that player shuffles (?:their|his or her) hand into (?:their|his or her) library$/, async (m, env) => {
  const [pid] = await playerTarget(env, /opponent/.test(m[1]) ? 'target opponent' : 'target player');
  const t = pid || opp(env.me);
  const lib = zoneOf(t, 'library').slice();
  lib.forEach((i) => move(i, 'exile'));
  zoneOf(t, 'hand').slice().forEach((i) => move(i, 'library'));
  shuffle(t);
  env.did.push(`exiles ${seatPoss(t)} library (${lib.length} cards); ${t === 'p' ? 'you shuffle your' : 'the AI shuffles its'} hand into ${t === 'p' ? 'your' : 'its'} library`);
}, { first: true });
// Thassa's Oracle
on(/^look at the top x cards of your library, where x is your devotion to blue\. put up to one of them on top of your library and the rest on the bottom of your library in a random order\. if x is greater than or equal to the number of cards in your library, you win the game$/, async (m, env) => {
  const x = countPhrase(env.me, 'your devotion to blue', helpers, env.src && env.src.iid) || 0;
  const ids = libTop(env.me, x);
  if (ids.length) {
    const [keep] = await env.choosers[env.me].pickCards({ prompt: `Thassa's Oracle: put up to one on top of your library (the rest go to the bottom)`, cards: ids, min: 0, max: 1, purpose: 'dig', src: env.src, aiScore: (c) => (isLand(c) ? 0 : DB[c.def].cmc + 1) });
    const rest = ids.filter((i) => i !== keep);
    for (const i of rest.sort(() => Math.random() - 0.5)) move(i, 'library', { to: 'bottom' });
    if (keep) move(keep, 'library');
  }
  const left = zoneOf(env.me, 'library').length;
  env.did.push(`looks at the top ${x} (devotion to blue ${x}, ${left} card${left === 1 ? '' : 's'} in library)`);
  if (x >= left) {
    winGame(env.me, `${cardName(env.src)}: devotion to blue ${x} ≥ ${left} cards in library`);
    env.did.push('wins the game');
  }
}, { first: true, multi: true });
// Jace, Architect of Thought −8
on(/^for each player, search that player's library for a nonland card and exile it(?:,|\.) then that player shuffles$/, async (m, env) => {
  env.them_ = [];
  for (const pid of seats()) {
    const pool = cardsIn(pid, 'library').filter((c) => !isLand(c));
    if (!pool.length) continue;
    const [pick] = await env.choosers[env.me].pickCards({ prompt: `Exile a nonland card from ${seatPoss(pid)} library`, cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'tutor', src: env.src, aiScore: (c) => DB[c.def].cmc });
    if (pick) {
      move(pick, 'exile');
      env.them_.push(pick);
    }
    shuffle(pid);
  }
  env.did.push(`exiles ${env.them_.map((i) => nameTag(card(i))).join(', ')}`);
}, { first: true, multi: true });
on(/^you may cast those cards without paying their mana costs$/, async (m, env) => {
  const { T } = await import('./triggers.js');
  for (const i of env.them_ || []) {
    const c = card(i);
    if (!c || c.zone !== 'exile') continue;
    const yes = isAI(env.me) ? true : await env.choosers.p.confirm(cardName(c), `Cast ${cardName(c)} without paying its mana cost?`, {});
    if (yes && T.castFree) await T.castFree(env.me, i, {});
  }
}, { first: true });
// Jace Reawakened +1: plot
on(/^(?:you may )?exile a nonland card with mana value (\d+) or less from your hand\. if you do, it becomes plotted$/, async (m, env) => {
  const pool = cardsIn(env.me, 'hand').filter((c) => !isLand(c) && DB[c.def].cmc <= +m[1]);
  if (!pool.length) return env.did.push('has nothing to plot');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Plot a card (mana value ${m[1]} or less)`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'plot', src: env.src, aiScore: (c) => DB[c.def].cmc });
  if (!pick) return;
  move(pick, 'exile');
  Object.assign(card(pick), { plotted: true, plottedTurn: G.s.turn });
  env.did.push(`plots ${env.me === 'p' ? nameTag(card(pick)) : 'a card'}`);
}, { first: true, multi: true });
// Jace Reawakened −6: "Until end of turn, whenever you cast a spell, copy it."
on(/^until end of turn, whenever you cast a spell, copy it$/, async (m, env) => {
  G.s.copyAll = { pid: env.me, turn: G.s.turn };
  env.did.push(`copies every spell ${who(env.me) === 'you' ? 'you cast' : 'it casts'} this turn`);
}, { first: true });
// Jace, Mirror Mage 0: "Draw a card and reveal it. Remove a number of loyalty counters equal to that card's mana value from ~."
on(/^draw a card and reveal it$/, async (m, env) => {
  draw(env.me, 1);
  const drawn = card(zoneOf(env.me, 'hand').slice(-1)[0]);
  env.it = drawn ? { iid: drawn.iid } : null;
  env.did.push(`draws and reveals ${drawn ? nameTag(drawn) : 'nothing'}`);
}, { first: true });
on(/^remove a number of loyalty counters equal to that card's mana value from (~|it)$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  const k = c ? DB[c.def].cmc : 0;
  if (env.src) env.src.counters.loyalty = Math.max(0, (env.src.counters.loyalty || 0) - k);
  env.did.push(`removes ${k} loyalty`);
}, { first: true });
// Vraska −2: "Target creature becomes a Treasure artifact … and loses all other card types and abilities."
on(/^target creature becomes a treasure artifact with "[^"]+" and loses all other card types and abilities$/, async (m, env) => {
  const [c] = await objects(env, 'target creature', { harm: true });
  if (!c) return;
  c.becameTreasure = true;
  loseAllAbilities(c);
  c.counters = {};
  c.extraText = '{T}, Sacrifice this artifact: Add one mana of any color.';
  env.did.push(`${nameTag(c)} becomes a Treasure`);
}, { first: true });
// Vraska −9: poison up to nine
on(/^if target player has fewer than nine poison counters, they get a number of poison counters equal to the difference$/, async (m, env) => {
  const [pid] = await playerTarget(env, 'target player');
  if (!pid) return;
  const pl = G.s.players[pid];
  if (pl.poison < 9) pl.poison = 9;
  env.did.push(`${who(pid)} ${pid === 'p' ? 'have' : 'has'} 9 poison counters`);
}, { first: true });
// Plan for All Outcomes: "the owner of up to one other target nonland permanent puts it on their choice of the top or bottom of their library"
on(/^the owner of (up to one (?:other )?target [^.]+?|target [^.]+?) puts it on their choice of the top or bottom of their library$/, async (m, env) => {
  const [c] = await objects(env, m[1].replace(/^up to one (?:other )?/, ''), { harm: true });
  if (!c || c.zone !== 'battlefield') return;
  const owner = c.owner;
  const top = isAI(owner) ? false : (await env.choosers.p.choose({ prompt: `Put ${cardName(c)} on top or bottom of your library?`, options: [{ label: 'Top' }, { label: 'Bottom' }], aiPick: () => 1 })) === 0;
  move(c.iid, 'library', top ? {} : { to: 'bottom' });
  env.did.push(`puts ${whose(c)} ${nameTag(c)} on the ${top ? 'top' : 'bottom'} of its owner's library`);
}, { first: true });
// Deepglow Skate, Aetheric Amplifier: double counters
on(/^double the number of each kind of counter on (any number of target permanents|target permanent|each permanent you control)$/, async (m, env) => {
  let objs;
  if (/any number/.test(m[1])) {
    const pool = seats().flatMap((k) => cardsIn(k, 'battlefield')).filter((c) => Object.values(c.counters || {}).some((v) => v > 0));
    objs = (await env.choosers[env.me].pickCards({ prompt: 'Double the counters on which permanents?', cards: pool.map((c) => c.iid), min: 0, max: pool.length, purpose: 'counters', src: env.src,
      aiScore: (c) => (c.controller === env.me ? 1 + Object.entries(c.counters).filter(([k]) => k !== '-1/-1' && k !== 'stun').reduce((a, [, v]) => a + v, 0) : (c.counters['-1/-1'] || 0) - 1) })).map(card);
  } else if (/target permanent/.test(m[1])) {
    // pick the permanent whose counters are best to double: your own loyalty/+1/+1, or an opponent's -1/-1
    const good = (c) => Object.entries(c.counters || {}).reduce((a, [k, v]) => a + (k === '-1/-1' || k === 'stun' ? -v : v), 0);
    const pool = seats().flatMap((k) => cardsIn(k, 'battlefield')).filter((c) => canTarget(c, env.me, env.src));
    const pick = await env.choosers[env.me].target({ prompt: 'Double the counters on which permanent?', candidates: pool.map((c) => c.iid), harm: false, src: env.src,
      aiScore: (c) => (c.controller === env.me ? good(c) : -good(c)) });
    objs = pick && pick.iid ? [card(pick.iid)] : [];
  } else objs = await objects(env, m[1], { harm: false });
  for (const c of objs) {
    for (const [k, v] of Object.entries(c.counters || {})) if (v > 0) addCounters(c, k, v);
    env.did.push(`doubles the counters on ${nameTag(c)}`);
  }
}, { first: true });
on(/^double the number of each kind of counter you have$/, async (m, env) => {
  const pl = G.s.players[env.me];
  if (pl.poison) pl.poison *= 2;
  for (const k of Object.keys(pl.counters || {})) pl.counters[k] *= 2;
  env.did.push(`doubles ${who(env.me) === 'you' ? 'your' : 'its'} counters`);
}, { first: true });
// Rowan Kenrith +2: "During target player's next turn, each creature that player controls attacks if able."
on(/^during target player's next turn, each creature that player controls attacks if able$/, async (m, env) => {
  const [pid] = await playerTarget(env, 'target player');
  if (!pid) return;
  G.s.mustAttackAll = multiplayer() ? { pid, from: nextTurnNumber(pid), until: nextTurnNumber(pid) + 1 } : { pid, from: G.s.turn + 1, until: G.s.turn + 2 };
  env.did.push(`${who(pid) === 'you' ? 'your' : "the AI's"} creatures must attack during ${who(pid) === 'you' ? 'your' : 'its'} next turn`);
}, { first: true });
// Ral Zarek −7
on(/^flip (\w+) coins\. take an extra turn after this one for each coin that comes up heads$/, async (m, env) => {
  const k = n(m[1]);
  let heads = 0;
  for (let i = 0; i < k; i++) if (Math.random() < 0.5) heads++;
  G.s.extraTurns[env.me] = (G.s.extraTurns[env.me] || 0) + heads;
  env.did.push(`flips ${k} coins: ${heads} heads — ${heads} extra turn${heads === 1 ? '' : 's'}`);
}, { first: true, multi: true });
// "you lose 1 life and amass Zombies 1", "deals 1 damage to each opponent and you gain 1 life"
on(/^(you lose \d+ life|~ deals \d+ damage to each opponent|this planeswalker deals \d+ damage to each opponent) and (amass .+|you gain \d+ life|you draw a card|draw a card|create .+)$/, async (m, env) => {
  await runSentence(m[1].replace(/^this planeswalker/, '~'), env);
  await runSentence(m[2], env);
}, { first: true });
// Chandra, Bold Pyromancer −7
on(/^(~) deals (\d+) damage to target player and each creature and planeswalker they control$/, async (m, env) => {
  const [pid] = await playerTarget(env, 'target player');
  if (!pid) return;
  const k = +m[2];
  damagePlayer(env, env.src, pid, k);
  const hit = cardsIn(pid, 'battlefield').filter((c) => isCreature(c) || isType(c, 'Planeswalker'));
  for (const c of hit) damagePermanent(env, env.src, c, k);
  env.did.push(`deals ${k} damage to ${hit.length} creatures and planeswalkers`);
}, { first: true });
// The Eternal Wanderer −4
on(/^for each player, choose a creature that player controls\. each player sacrifices all creatures they control not chosen this way$/, async (m, env) => {
  for (const pid of seats()) {
    const cs = cardsIn(pid, 'battlefield').filter(isCreature);
    if (!cs.length) continue;
    const [keep] = await env.choosers[env.me].pickCards({ prompt: `Choose the creature ${pid === 'p' ? 'you keep' : 'the AI keeps'}`, cards: cs.map((c) => c.iid), min: 1, max: 1, purpose: 'keep', src: env.src,
      aiScore: (c) => (pid === env.me ? cardValue(c) : -cardValue(c)) });
    const gone = cs.filter((c) => c.iid !== keep);
    gone.forEach((c) => sacrifice(c.iid));
    env.did.push(`${who(pid)} ${pid === 'p' ? 'keep' : 'keeps'} ${keep ? nameTag(card(keep)) : 'nothing'} and ${s_(pid, 'sacrifice')} ${gone.length}`);
  }
}, { first: true, multi: true });
// The Eternal Wanderer +1 return
on(/^return (?:that card|it|the exiled card) to the battlefield under its owner's control at the beginning of that player's next end step$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  if (!c || c.zone !== 'exile') return;
  G.s.delayed.push({ at: 'endStep', kind: 'returnFromExile', iid: c.iid, pid: c.owner, whoseEnd: c.owner });
  env.did.push(`${nameTag(c)} returns at ${who(c.owner) === 'you' ? 'your' : "the AI's"} next end step`);
}, { first: true });
// Emblems: "You get an emblem with '…'" — kept on the player and shown in the log
on(/^(you|target player|target opponent) gets? an emblem with ['"](.+)['"]$/, async (m, env) => {
  m = [m[0], m[2], m[1]];
  let pid = env.me;
  if (m[2] === 'target opponent') pid = opp(env.me);
  else if (m[2] === 'target player') {
    // emblems are good for whoever gets them: the AI gives them to itself; you choose
    if (isAI(env.me)) pid = env.me;
    else {
      const others = opponents('p');
      const k = await env.choosers.p.choose({ prompt: 'Who gets the emblem?', options: [{ label: 'You' }, ...others.map((o) => ({ label: seatLabel(o) }))], aiPick: () => 0 });
      pid = k >= 1 ? others[k - 1] || others[0] : 'p';
    }
  }
  const pl = G.s.players[pid];
  const at = (env.fullText || '').toLowerCase().indexOf(m[1].slice(0, 30));
  const txt = at >= 0 ? env.fullText.slice(at, at + m[1].length) : m[1];
  pl.emblems = [...(pl.emblems || []), txt];
  env.did.push(`${who(pid)} ${s_(pid, 'get')} an emblem: “${esc(txt)}”`);
}, { first: true });
// Way of the Cryomancer: "When you next cast an instant or sorcery spell this turn, copy that spell."
on(/^when you next cast an? (instant or sorcery|instant|sorcery|creature|noncreature) spell this turn, copy (?:that spell|it)(?: and you may choose new targets for the copy)?$/, async (m, env) => {
  G.s.copyNext = [...(G.s.copyNext || []), { pid: env.me, turn: G.s.turn, types: m[1] === 'instant or sorcery' ? ['Instant', 'Sorcery'] : [m[1][0].toUpperCase() + m[1].slice(1)] }];
  env.did.push(`will copy ${who(env.me) === 'you' ? 'your' : 'its'} next ${m[1]} spell this turn`);
}, { first: true });
// Way of the Warlord: "~ deals 2 damage to up to one target creature or planeswalker and 2 damage to target player"
on(/^(?!.*\bother targets$)(~|it|this planeswalker) deals (\d+|x) damage to ([^.]+?) and (\d+|x) damage to ([^.]+)$/, async (m, env) => {
  await runSentence(`${m[1]} deals ${m[2]} damage to ${m[3]}`, env);
  await runSentence(`${m[1]} deals ${m[4]} damage to ${m[5]}`, env);
}, { first: true });
// Way of the Healer, Hexhaven Battalion: "create a 2/2 colorless Wizard Soldier creature token named Cadet"
on(/^create (.+?) tokens? named ([a-z~][a-z~' -]*?)(?: with (.+))?$/, async (m, env) => {
  const at = env.sentence.toLowerCase().indexOf(' named ');
  const nm = env.sentence.slice(at + 7, at + 7 + m[2].length).replace(/~/g, env.src ? cardName(env.src) : '').replace(/\b(?!of\b)\w/g, (x) => x.toUpperCase());
  env.them_ = null;
  await makeTokens(env, `${m[1]}${m[3] ? ' with ' + m[3] : ''}`, null);
  for (const i of env.them_ || []) {
    const c = card(i);
    const base = DB[c.def];
    const id = `${base.id}-named-${nm.replace(/\s+/g, '_')}`;
    if (!DB[id]) DB[id] = { ...base, id, name: nm, faces: base.faces.map((f, k) => (k ? f : { ...f, name: nm })) };
    c.def = id;
  }
  if (env.did.length) env.did[env.did.length - 1] = env.did[env.did.length - 1].replace(/creates (\d+) .+? tokens?$/, (x, k) => `creates ${k} ${nm} token${+k === 1 ? '' : 's'}`);
}, { first: true });
// Baral and Kari Zev: "create First Mate Ragavan, a legendary 2/1 red Monkey Pirate creature token"
on(/^create (?!(?:a|an|one|two|three|four|five|x|that many|tokens?)\b)([a-z~][a-z~' -]+?), (?:a|an) (legendary )?([^,]+?) tokens?( with .+)?$/, async (m, env) => {
  await runSentence(`create a ${m[3]} token named ${m[1]}${m[4] || ''}`, env);
  if (m[2]) for (const i of env.them_ || []) {
    const c = card(i);
    const d = c && DB[c.def];
    if (d && !/Legendary/.test(d.typeLine)) {
      d.typeLine = 'Legendary ' + d.typeLine;
      d.faces = d.faces.map((f, k) => (k ? f : { ...f, typeLine: 'Legendary ' + f.typeLine }));
    }
  }
}, { first: true });
// Chittering Witch: "Create a number of 1/1 black Rat creature tokens equal to the number of opponents you have."
on(/^create a number of (.+?) tokens? equal to (.+)$/, async (m, env) => {
  const ph = m[2].replace(/^the number of /, '');
  const k = /^opponents you have$/.test(ph) ? 1 : /^cards in your hand$/.test(ph) ? cardsIn(env.me, 'hand').length : amountOf(m[2], env);
  if (!k) return env.did.push('creates no tokens');
  const saved = env.x;
  env.x = k;
  await makeTokens(env, `x ${m[1]}`, null);
  env.x = saved;
}, { first: true });
// Avenger of Zendikar, Izoni, Squad Commander: "create a 0/1 green Plant creature token for each land you control"
on(/^create (a|an|one|two|three) (.+?) tokens?( with [^.]+?)? for each (.+)$/, async (m, env) => {
  const per = n(m[1]);
  const what = m[4];
  let cnt;
  const cm = what.match(/^([a-z+\/0-9-]+) counter on (~|it|this [a-z]+)$/);
  if (cm) cnt = ((env.src && env.src.counters) || {})[cm[1]] || 0;
  // Occult Epiphany: "for each card type among cards discarded this way"
  else if (/^card type among (?:cards|the cards) (?:discarded|milled|exiled) this way$/.test(what)) {
    const pool = /discarded/.test(what) ? env.discarded || [] : env.them_ || [];
    const TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery'];
    cnt = TYPES.filter((t) => pool.some((i) => card(i) && new RegExp('\\b' + t + '\\b').test((DB[card(i).def].typeLine || '').split('—')[0]))).length;
  } else cnt = countPhrase(env.me, what, helpers, env.src && env.src.iid) || 0;
  const k = cnt * per;
  if (!k) return env.did.push('creates no tokens');
  const saved = env.x;
  env.x = k;
  await makeTokens(env, `x ${m[2]}${m[3] || ''}`, null);
  env.x = saved;
}, { first: true });
// Chaos Warp, Blink, This Is How It Ends: "the owner of target permanent shuffles it into their library"
on(/^(?:the owner of (target [^.]+?)|(target [^.]+?)'s owner|its owner) shuffles it into (?:their|his or her) library(?:, then reveals the top card of (?:their|his or her) library|, then investigates)?$/, async (m, env) => {
  const phrase = m[1] || m[2];
  const objs = phrase ? await objects(env, phrase, { harm: true }) : env.it && card(env.it.iid) ? [card(env.it.iid)] : [];
  for (const c of objs) {
    if (c.zone !== 'battlefield') continue;
    const owner = c.owner;
    const nm = `${whose(c)} ${nameTag(c)}`;
    move(c.iid, 'library');
    shuffle(owner);
    env.did.push(`shuffles ${nm} into its owner's library`);
    env.thatPlayer = owner;
    env.it = null;
    // Blink: "Its owner shuffles it into their library, then investigates." — the owner gets the Clue
    if (/then investigates/.test(env.sentence)) {
      createToken(genericTokenDef(0, 0, 'Clue'), owner, 1);
      env.did.push(`${who(owner)} ${s_(owner, 'investigate')}`);
    }
    if (/reveals the top card/.test(env.sentence)) {
      const top = libTop(owner, 1)[0];
      env.it = top ? { iid: top } : null;
      if (top) env.did.push(`${who(owner)} ${s_(owner, 'reveal')} ${nameTag(card(top))}`);
    }
  }
}, { first: true });
on(/^(?:(?:they|that player|its owner) )?reveals the top card of (?:their|his or her) library$/, async (m, env) => {
  const pid = env.thatPlayer || opp(env.me);
  const top = libTop(pid, 1)[0];
  env.it = top ? { iid: top } : null;
  if (top) env.did.push(`${who(pid)} ${s_(pid, 'reveal')} ${nameTag(card(top))}`);
}, { first: true });
// Chaos Warp: "If it's a permanent card, they put it onto the battlefield."
on(/^if it's a permanent card, (?:they|that player|its owner) puts? it onto the battlefield$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  if (!c || c.zone !== 'library' || !isPermanentCard(DB[c.def])) return;
  toBattlefield(c.iid, c.owner);
  env.did.push(`${nameTag(c)} goes onto the battlefield`);
}, { first: true });
// Silence: "Your opponents can't cast spells this turn."
on(/^(?:your opponents|each opponent|target player|target opponent) can't cast spells this turn$/, async (m, env) => {
  const pid = /target player/.test(m[0]) ? (await playerTarget(env, 'target player'))[0] : opp(env.me);
  G.s.silenced = { pid, turn: G.s.turn };
  env.did.push(`${who(pid)} can't cast spells this turn`);
}, { first: true });
// Secret Rendezvous: "You and target opponent each draw three cards."
on(/^you and (target opponent|target player|each opponent) each draw (\w+) cards?$/, async (m, env) => {
  const k = n(m[2], env.x);
  for (const pid of [env.me, ...opponents(env.me)]) {
    draw(pid, k);
    env.did.push(`${who(pid)} ${s_(pid, 'draw')} ${k}`);
  }
}, { first: true });
// Mortuary Mire, Noxious Revival: "Put target creature card from your graveyard on top of your library."
on(/^put ((?:any number of |up to (?:one|two|three) )?target [^.]+?) from (your|a|target player's) graveyard on top of (?:your|its owner's|their) library$/, async (m, env) => {
  const pids = m[2] === 'your' ? [env.me] : seats();
  const many = /^any number of /.test(m[1]) ? Infinity : /^up to (\w+)/.test(m[1]) ? n(m[1].match(/^up to (\w+)/)[1]) : 1;
  const filter = m[1].replace(/^(?:any number of |up to \w+ )?target /, '').replace(/ ?cards?$/, '').trim() || 'card';
  const pool = pids.flatMap((pid) => cardsIn(pid, 'graveyard')).filter((c) => matchesFilter(c, filter));
  if (!pool.length) return env.did.push('finds nothing');
  // Bone Harvest: any number; the AI stacks its best one or two (the last one chosen ends up on top)
  const max = Math.min(many, pool.length);
  const picks = await env.choosers[env.me].pickCards({ prompt: max > 1 ? `Put any number of ${filter} cards on top of the library (the last one chosen ends up on top)` : `Put a ${filter} card on top of its owner's library`, cards: pool.map((c) => c.iid), min: many === 1 ? 1 : 0, max: isAI(env.me) && many === Infinity ? Math.min(2, max) : max, purpose: 'regrowth', src: env.src, aiScore: (c) => (c.owner === env.me ? DB[c.def].cmc : -DB[c.def].cmc) });
  if (!picks.length) return;
  for (const pick of picks.slice().reverse()) move(pick, 'library');
  env.did.push(`puts ${picks.map((i) => nameTag(card(i))).join(', ')} on top of ${picks.length > 1 ? 'the library' : "its owner's library"}`);
}, { first: true });
// Soul of Windgrace: "Put a land card from a graveyard onto the battlefield tapped under your control."
on(/^put (a|an|one) ([a-z ]+?) cards? from (a|your|an opponent's) graveyards? onto the battlefield( tapped)?(?: under your control)?$/, async (m, env) => {
  await runSentence(`Return target ${m[2]} card from ${m[3]} graveyard to the battlefield under your control${m[4] || ''}`, env);
}, { first: true });
// Plaguecrafter: "Each player who can't discards a card."
on(/^each player who can't discards (a|one) cards?$/, async (m, env) => {
  for (const pid of env.couldntSac || []) {
    const hand = cardsIn(pid, 'hand');
    if (!hand.length) continue;
    const [pick] = await env.choosers[pid].pickCards({ forced: true, prompt: 'Discard a card', cards: hand.map((c) => c.iid), min: 1, max: 1, purpose: 'discard', src: env.src, aiScore: (c) => (isLand(c) ? 5 : -DB[c.def].cmc) });
    if (pick) {
      env.did.push(`${who(pid)} ${s_(pid, 'discard')} ${nameTag(card(pick))}`);
      discardCard(pick);
    }
  }
}, { first: true });
// Goblin Dark-Dwellers: "you may cast target instant or sorcery card with mana value 3 or less from your graveyard without paying its mana cost"
on(/^(?:you may )?cast (?:up to one )?target ([a-z ]+?) card(?: with mana value (\d+|x) or less)? from (?:your|an opponent's|a) graveyard without paying its mana cost(?:\. if that spell would be put into (?:your|a) graveyard, exile it instead)?$/, async (m, env) => {
  const kind = m[1].trim();
  const mv = m[2] ? n(m[2], env.x) : 99;
  const pool = cardsIn(env.me, 'graveyard').filter((c) => c.iid !== env.src.iid && matchesAny(c, kind) && DB[c.def].cmc <= mv);
  if (!pool.length) return env.did.push('finds nothing to cast');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Cast a ${kind} card from your graveyard for free`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => DB[c.def].cmc });
  if (!pick) return;
  const { T } = await import('./triggers.js');
  if (T.castFree) {
    const c = card(pick);
    if (/exile it instead/.test(env.text)) G.s.exileOnResolve = { ...(G.s.exileOnResolve || {}), [pick]: true };
    await T.castFree(env.me, pick, {});
    env.did.push(`casts ${nameTag(c)} for free`);
  }
}, { first: true });
// Helmut Zemo: "you may cast target instant or sorcery card with mana value less than or equal to his power from your graveyard"
// (paying its cost). "If you cast a spell this way, put a +1/+1 counter on ~."
on(/^(?:you may )?cast target ([a-z ]+?) card with mana value less than or equal to (?:his|her|its|~'s) power from your graveyard$/, async (m, env) => {
  env.lastMay = false;
  const src = (env.src && card(env.src.iid)) || env.src;
  const cap = src ? Math.max(0, power(src)) : 0;
  const kind = m[1].trim();
  const pool = cardsIn(env.me, 'graveyard').filter((c) => matchesAny(c, kind) && (DB[c.def].cmc || 0) <= cap);
  if (!pool.length) return env.did.push('finds nothing to cast');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Cast a ${kind} card with mana value ${cap} or less from your graveyard (paying its cost)?`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => DB[c.def].cmc });
  if (!pick) return;
  const { T } = await import('./triggers.js');
  if (!T.castFree) return;
  const c = card(pick);
  if (/exile it instead/.test(env.text)) G.s.exileOnResolve = { ...(G.s.exileOnResolve || {}), [pick]: true };
  const cost = DB[c.def].faces[0].manaCost || DB[c.def].manaCost || '';
  const ok = await T.castFree(env.me, pick, cost ? { cost } : {});
  if (G.s.exileOnResolve) delete G.s.exileOnResolve[pick]; // used up (or never cast)
  env.lastMay = !!ok;
  env.did.push(ok ? `casts ${nameTag(c)} from the graveyard` : `doesn't cast ${nameTag(c)}`);
}, { first: true });
on(/^if you cast a spell this way, (.+)$/, async (m, env, raw) => {
  if (!env.lastMay) return;
  await runSentence(raw.replace(/^if you cast a spell this way,\s*/i, ''), env);
}, { first: true });
// Ox Drover: "Target opponent creates a 1/1 white Ox creature token and you draw a card."
on(/^(target opponent|each opponent) creates (.+?) tokens?(?: and you draw (a|one|two) cards?)?$/, async (m, env) => {
  const saved = env.me;
  for (const o of /^each/.test(m[1]) ? opponents(saved) : [opp(saved)]) {
    env.me = o;
    await makeTokens(env, m[2], null);
  }
  env.me = saved;
  if (m[3]) {
    draw(env.me, n(m[3]));
    env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${n(m[3])}`);
  }
}, { first: true });
// Teferi's Protection: "Until your next turn, your life total can't change and you gain protection from everything."
on(/^until your next turn, your life total can't change and you gain protection from everything$/, async (m, env) => {
  G.s.players[env.me].lifeLocked = nextTurnNumber(env.me);
  G.s.players[env.me].protectedUntil = nextTurnNumber(env.me);
  env.did.push(`${seatPoss(env.me)} life total can't change and ${env.me === 'p' ? 'you have' : 'it has'} protection until ${env.me === 'p' ? 'your' : 'its'} next turn`);
}, { first: true });
// Living Death, split into its three steps
on(/^each player exiles all creature cards from their graveyard$/, async (m, env) => {
  env.livingDeath = {};
  for (const pid of seats()) {
    env.livingDeath[pid] = cardsIn(pid, 'graveyard').filter((c) => /Creature/.test(DB[c.def].typeLine)).map((c) => c.iid);
    env.livingDeath[pid].forEach((i) => move(i, 'exile'));
  }
  env.did.push(`exiles ${Object.values(env.livingDeath).reduce((a, x) => a + x.length, 0)} creature cards from graveyards`);
}, { first: true });
on(/^(?:each player )?sacrifices all creatures they control$/, async (m, env) => {
  let k = 0;
  for (const pid of seats()) for (const c of cardsIn(pid, 'battlefield').filter(isCreature)) {
    sacrifice(c.iid);
    k++;
  }
  env.did.push(`${k} creatures are sacrificed`);
}, { first: true });
on(/^(?:each player )?puts all cards they exiled this way onto the battlefield$/, async (m, env) => {
  const ld = env.livingDeath || {};
  let k = 0;
  for (const pid of seats()) for (const i of ld[pid] || []) if (card(i) && card(i).zone === 'exile') {
    toBattlefield(i, pid);
    k++;
  }
  env.did.push(`${k} creatures return to the battlefield`);
}, { first: true });
on(/^each player exiles all creature cards from their graveyard, then sacrifices all creatures they control, then puts all cards they exiled this way onto the battlefield$/, async (m, env) => {
  const ex = {};
  for (const pid of seats()) {
    ex[pid] = cardsIn(pid, 'graveyard').filter((c) => /Creature/.test(DB[c.def].typeLine)).map((c) => c.iid);
    ex[pid].forEach((i) => move(i, 'exile'));
  }
  for (const pid of seats()) for (const c of cardsIn(pid, 'battlefield').filter(isCreature)) sacrifice(c.iid);
  for (const pid of seats()) for (const i of ex[pid]) if (card(i) && card(i).zone === 'exile') toBattlefield(i, pid);
  env.did.push(multiplayer() ? `swaps graveyards and battlefields: ${seats().map((k) => `${(ex[k] || []).length} for ${seatName(k)}`).join(', ')}` : `swaps graveyards and battlefields: ${ex.p.length} for you, ${ex.ai.length} for the AI`);
}, { first: true });
// Rakdos Charm: "Each creature deals 1 damage to its controller."
on(/^each creature deals (\d+|x) damage to its controller$/, async (m, env) => {
  const k = n(m[1], env.x);
  for (const pid of seats()) {
    for (const c of cardsIn(pid, 'battlefield').filter(isCreature)) damagePlayer(env, c, pid, k);
  }
  env.did.push(`each creature deals ${k} damage to its controller`);
}, { first: true });
export function damagePlayer(env, source, pid, amount) {
  if (amount <= 0) return;
  const rd = redirectTarget(pid, null);
  if (rd) return damagePermanent(env, source, rd, amount, true);
  if (source && playerProtectedFrom(pid, source)) return env.did.push(`${who(pid)} ${pid === 'p' ? 'have' : 'has'} protection — the damage is prevented`);
  amount = damageMods(amount, source, pid, {});
  if (amount <= 0) return env.did.push(`the damage to ${who(pid)} is prevented`);
  if (G.s.players[pid] && source && hasKw(source, 'infect')) {
    G.s.players[pid].poison += amount;
    env.did.push(`gives ${who(pid)} ${amount} poison counter${amount === 1 ? '' : 's'}`);
  } else {
    G.s.damageNow = true;
    changeLife(pid, -amount, false);
    G.s.damageNow = false;
    env.did.push(`deals ${amount} damage to ${who(pid)}`);
  }
  if (source && source.zone === 'battlefield' && hasKw(source, 'lifelink')) changeLife(ctl(source), amount, false);
  if (G.s.ts && G.s.ts[pid]) {
    G.s.ts[pid].dmgTaken = (G.s.ts[pid].dmgTaken || 0) + amount;
    G.s.ts[pid].noncombatDmgTaken = true;
  }
  if (source && source.iid && card(source.iid)) card(source.iid).dmgPlayerTurn = G.s.turn;
  env.lastAmount = amount;
  if (source && source.iid) {
    queueEvent({ type: 'dealsDamage', iid: source.iid, amount, player: pid });
    queueEvent({ type: 'dealsDamagePlayer', iid: source.iid, amount, player: pid });
  }
}
export function damagePermanent(env, source, c, amount, log_) {
  if (amount <= 0 || !c || c.zone !== 'battlefield') return;
  const rd = isCreature(c) ? redirectTarget(c.controller, c.iid) : null;
  if (rd) c = rd;
  if (source && isProtectedFrom(c, source)) {
    env.did.push(`${nameTag(c)} is protected`);
    return;
  }
  amount = damageMods(amount, source, c.controller, { victim: c });
  if (amount <= 0) return env.did.push(`the damage to ${nameTag(c)} is prevented`);
  if ((c.counters || {}).shield) {
    c.counters.shield--;
    if (!c.counters.shield) delete c.counters.shield;
    env.did.push(`${nameTag(c)}'s shield counter prevents the damage`);
    return;
  }
  // The War Doctor: "If a creature dealt damage this way would die this turn, exile it instead." (set before it can die)
  if (isCreature(c) && /dealt damage this way would die this turn, exile it instead/i.test(env.text || '')) c.exileIfDiesTurn = G.s.turn;
  // excess damage (Bottle-Cap Blast): beyond lethal for a creature, beyond loyalty/defense otherwise
  {
    const left = isCreature(c) ? Math.max(0, toughness(c) - (c.damage || 0)) : isType(c, 'Planeswalker') ? c.counters.loyalty || 0 : isType(c, 'Battle') ? c.counters.defense || 0 : amount;
    env.excessDamage = Math.max(0, amount - left);
  }
  if (isType(c, 'Planeswalker') && !isCreature(c)) c.counters.loyalty = Math.max(0, (c.counters.loyalty || 0) - amount);
  else if (isType(c, 'Battle') && !isCreature(c)) c.counters.defense = Math.max(0, (c.counters.defense || 0) - amount);
  else if (source && (hasKw(source, 'infect') || hasKw(source, 'wither'))) addCounters(c, '-1/-1', amount);
  else c.damage += amount;
  if (source && hasKw(source, 'deathtouch') && isCreature(c)) c.deathtouched = true;
  if (source && source.zone === 'battlefield' && hasKw(source, 'lifelink')) changeLife(ctl(source), amount, false);
  env.lastAmount = amount;
  if (isCreature(c)) (env.damagedThisWay = env.damagedThisWay || []).push(c.iid);
  if (log_) env.did.push(`deals ${amount} damage to ${whose(c)} ${nameTag(c)}`);
  queueEvent({ type: 'dealtDamage', iid: c.iid, amount, other: source && source.iid });
  if (source && source.iid) (G.s.dmgPairs = G.s.dmgPairs || {})[source.iid + '>' + c.iid] = G.s.turn;
  if (source && source.iid) queueEvent({ type: 'dealsDamage', iid: source.iid, amount, other: c.iid });
}
on(/^(.+?) fights? (.+)$/, async (m, env) => {
  const [a] = await objects(env, m[1], { harm: false });
  const saveIt = env.it;
  const [b] = await objects(env, m[2], { harm: true });
  env.it = saveIt;
  if (!a || !b) return env.did.push('the fight fizzles');
  const pa = power(a);
  const pb = power(b);
  damagePermanent(env, a, b, pa);
  damagePermanent(env, b, a, pb);
  env.did.push(`${nameTag(a)} fights ${nameTag(b)}`);
});

// --- drawing, discarding, milling
on(/^(you |target player |each player |that player |its controller |target opponent |each opponent )?draws? (a|an|one|two|three|four|five|six|seven|eight|x|\d+|cards? equal to [^,.]+?|that many) cards?(?: and (?:you )?loses? (\d+|x|that much) life)?/, async (m, env) => {
  const pids = m[1] ? await playerTarget(env, m[1].trim(), false) : [env.me];
  let k = /that many/.test(m[2]) ? env.lastAmount || 0 : /equal to/.test(m[2]) ? amountOf(m[2].replace(/^cards? /, ''), env) : n(m[2], env.x);
  for (const pid of pids) {
    const before = new Set(zoneOf(pid, 'hand'));
    draw(pid, k, true);
    env.them_ = zoneOf(pid, 'hand').filter((i) => !before.has(i));
    env.did.push(`${who(pid)} ${s_(pid, 'draw')} ${k}`);
    if (m[3]) {
      const l = m[3] === 'x' ? env.x || 0 : m[3] === 'that much' ? k : +m[3];
      changeLife(pid, -l, false);
      env.did.push(`${who(pid)} ${s_(pid, 'lose')} ${l} life`);
    }
  }
});
on(/^(you |target player |each player |that player |target opponent |each opponent |its controller )?discards? (a|one|two|three|x|\d+|your|their|his or her) (?:cards?|hand)( at random)?/, async (m, env) => {
  const pids = m[1] ? await playerTarget(env, m[1].trim()) : [env.me];
  // "Discard a card. If you do, draw a card." (Shadow of the Goblin): it counts as done only if a card was discarded
  env.lastMay = false;
  for (const pid of pids) {
    const hand = cardsIn(pid, 'hand');
    let k = /your|their|his or her/.test(m[2]) ? hand.length : n(m[2], env.x);
    k = Math.min(k, hand.length);
    if (!k) continue;
    let picks;
    if (m[3]) picks = hand.slice().sort(() => Math.random() - 0.5).slice(0, k).map((c) => c.iid);
    else if (k === hand.length) picks = hand.map((c) => c.iid);
    else {
      const lands = cardsIn(pid, 'battlefield').filter(isLand).length;
      picks = await env.choosers[pid].pickCards({
        forced: true, prompt: `Choose ${k === 1 ? 'a card' : k + ' cards'} to discard`, cards: hand.map((c) => c.iid), min: k, max: k,
        purpose: 'discard', src: env.src, aiScore: (c) => (isLand(c) ? (lands >= 6 ? 10 : -10) : DB[c.def].cmc - lands) + (/Madness/.test(oracle(c)) ? 20 : 0) + (/card type among cards discarded/.test(env.text || '') ? varietyBonus(c, hand) : 0),
      });
    }
    if (picks.length) env.lastMay = true;
    env.discardedNonland = picks.some((i) => !isLand(card(i)));
    env.discarded = [...(env.discarded || []), ...picks];
    env.did.push(`${who(pid)} ${s_(pid, 'discard')} ${picks.map((i) => nameTag(card(i))).join(', ')}`);
    picks.forEach((i) => discardCard(i));
  }
});
on(/^(you |target player |each player |that player |target opponent |each opponent |its controller )?mills? (a|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+|cards equal to [^.]+?|half their library) cards?/, async (m, env) => {
  const pids = m[1] ? await playerTarget(env, m[1].trim()) : [env.me];
  for (const pid of pids) {
    const k = /half/.test(m[2]) ? Math.floor(zoneOf(pid, 'library').length / 2) : /equal to/.test(m[2]) ? amountOf(m[2].replace(/^cards /, ''), env) : n(m[2], env.x);
    const ids = millCards(pid, k);
    env.them_ = ids;
    env.did.push(`${who(pid)} ${s_(pid, 'mill')} ${ids.length}`);
  }
});
on(/^(?:you )?(?:draw a card, then discard a card|discard a card, then draw a card)$/, async () => {}, { never: true });

// --- life
on(/^(you|target player|each player|its controller|that player|target opponent) gains? (\d+|x|life equal to [^.]+?|that much life)(?: life)?(?:\.|$| for each| and |,| unless| if )/, async (m, env) => {
  const pids = await playerTarget(env, m[1], false);
  const k = /that much/.test(m[2]) ? env.lastAmount || 0 : /^life equal/.test(m[2]) ? amountOf(m[2].replace(/^life /, ''), env) : n(m[2], env.x);
  for (const pid of pids) {
    changeLife(pid, k, false);
    env.did.push(`${who(pid)} ${s_(pid, 'gain')} ${k} life`);
  }
});
on(/^(each opponent|target opponent|target player|that player|each player|you|its controller|defending player|each other player|they|that opponent|the player) loses? (\d+|x|that much|life equal to [^.]+?|half (?:their|your) life,? rounded up|a third of (?:their|your) life,? rounded up)(?: life)?(?: and you gain (\d+|x|that much) life)?(?:\.|$| for each|,| and | unless| if )/, async (m, env) => {
  const pids = await playerTarget(env, /^(?:they|that opponent|the player)$/.test(m[1]) ? 'that player' : m[1]);
  for (const pid of pids) {
    let k = /half/.test(m[2]) ? Math.ceil(G.s.players[pid].life / 2) : /third/.test(m[2]) ? Math.ceil(G.s.players[pid].life / 3) : m[2] === 'that much' ? env.lastAmount || 0
      // Astarion (Feed): "loses life equal to the amount of life they lost this turn"
      : /^life equal to the amount of life (?:they|that player) lost this turn$/.test(m[2]) ? ((G.s.ts || {})[pid] || {}).lifeLost || 0
      : /^life equal/.test(m[2]) ? amountOf(m[2].replace(/^life /, ''), env) : n(m[2], env.x);
    changeLife(pid, -k, false);
    env.lastAmount = k;
    env.did.push(`${who(pid)} ${s_(pid, 'lose')} ${k} life`);
    if (m[3]) {
      const g = /that much/.test(m[3]) ? k : n(m[3], env.x);
      changeLife(env.me, g, false);
      env.did.push(`${who(env.me)} ${s_(env.me, 'gain')} ${g} life`);
    }
  }
});
on(/^you gain life equal to the life lost this way/, async (m, env) => {
  changeLife(env.me, env.lastAmount || 0, false);
  env.did.push(`${who(env.me)} ${s_(env.me, 'gain')} ${env.lastAmount || 0} life`);
});
on(/^(?:you|target player|each player|that player) (?:gets?|get) (a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\d+|\{e\}(?:\{e\})*)(?: (?:poison counters?|rad counters?|experience counters?|energy counters?|\{e\}))?$/, async (m, env) => {
  const s = env.sentence;
  const pids = /^target player/.test(s) ? await playerTarget(env, 'target player') : /^each player/.test(s) ? seats() : /^that player/.test(s) ? [env.thatPlayer || opp(env.me)] : [env.me];
  const k = /\{e\}/.test(m[1]) ? (m[1].match(/\{e\}/g) || []).length : n(m[1], env.x);
  const kind = /poison/.test(s) ? 'poison' : /rad/.test(s) ? 'rad' : /experience/.test(s) ? 'experience' : 'energy';
  for (const pid0 of pids) {
    const pid = pid0;
    // Lae'zel: "… or on yourself, put that many plus one"
    const kk = k + (pid === env.me && k > 0 ? repl('playerCounterPlusOne', pid) || 0 : 0);
    if (kind === 'energy') { gainEnergy(pid, k, env); continue; }
    if (kind === 'poison') G.s.players[pid].poison += kk;
    else G.s.players[pid].counters[kind] = (G.s.players[pid].counters[kind] || 0) + kk;
    env.did.push(`${who(pid)} ${s_(pid, 'get')} ${kk} ${kind === 'energy' ? 'energy' : kind + ' counter' + (kk === 1 ? '' : 's')}`);
  }
});
on(/^(?:you )?pay (\d+) life/, async (m, env) => {
  changeLife(env.me, -+m[1], false);
  env.did.push(`pays ${m[1]} life`);
});

// --- tokens
on(/^create (.+?) tokens? that(?:'s| are) (?:a )?cop(?:y|ies) of (.+?)(?:, except (.+?))?(?:\.|$)/, async (m, env) => {
  const cm = m[1].match(new RegExp('^' + NUM + '(?: tapped)?(?: and attacking)?$'));
  const count = cm ? n(cm[1], env.x) : 1;
  let orig = null;
  const of = m[2];
  if (/target/.test(of)) [orig] = await objects(env, of, { harm: false });
  else if (/equipped|enchanted/.test(of)) orig = env.src.attachedTo ? card(env.src.attachedTo) : null;
  // "a copy of ~" is always this card (Scute Swarm on landfall: not the land that entered)
  else if (/^~/.test(of)) orig = (env.src && card(env.src.iid)) || env.src;
  else if (/^(?:it|that creature|that card|the exiled card|the discarded card|the sacrificed creature)/.test(of)) orig = env.it && env.it.iid ? card(env.it.iid) || null : env.src;
  if (!orig && /^(?:~|it)/.test(of)) orig = env.src;
  if (!orig) return env.did.push('has nothing to copy');
  const made = createToken(orig.def, env.me, count, { tapped: /tapped/.test(m[1]) });
  const except = (m[3] || '') + ' ' + env.sentence;
  for (const i of made) {
    const tk = card(i);
    tk.face = orig.face || 0;
    if (/isn't legendary|is not legendary|it's not legendary/.test(except)) tk.notLegendary = true;
    { const sl = except.match(/its starting loyalty is (\d+)/); if (sl) tk.counters.loyalty = +sl[1]; }
    if (/has haste|gains haste|have haste/.test(except)) tk.grants = [...(tk.grants || []), 'haste'];
    if (/it's 1\/1|it's a 1\/1|they're 1\/1|base power and toughness 1\/1/.test(except)) tk.setPT = { ts: nextStamp(), p: 1, t: 1 };
    // Hashaton: "except it's a 4/4 black Zombie" (its creature types and color are replaced)
    {
      const rp = !/in addition to its other/.test(except) && except.match(/(?:it's|they're) (?:an? )?(\d+)\/(\d+) ((?:white|blue|black|red|green|colorless) )?([a-z][a-z-]*)\b/i);
      if (rp) {
        tk.setPT = { ts: nextStamp(), p: +rp[1], t: +rp[2] };
        const col = rp[3] ? rp[3].trim().toLowerCase() : null;
        addLayerFx(tk, { until: true, types: { subSet: capWords(rp[4]) }, ...(col ? { colors: { set: col === 'colorless' ? [] : [COLOR_WORD[col]] } } : {}) });
      }
    }
    // Ember Island Production: "it's a 4/4 Hero in addition to its other types" / "a 2/2 Coward"
    {
      const pt = except.match(/(?:it's|they're) (?:an? )?(\d+)\/(\d+)(?: ([a-z][a-z -]*?))?( (?:artifact )?creatures?)?(?: with ([a-z ,]+?))? in addition to its other types/i);
      if (pt) {
        tk.setPT = { ts: nextStamp(), p: +pt[1], t: +pt[2] };
        if (pt[3]) tk.addTypes = ((tk.addTypes || '') + ' ' + pt[3].trim().split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')).trim();
        // Will of the Temur: "a 4/4 Dragon creature with flying in addition to its other types"
        if (pt[4] && !isCreature(tk)) addLayerFx(tk, { until: true, types: { add: 'Creature' } });
        if (pt[5]) tk.grants = [...(tk.grants || []), ...kwList(pt[5])];
      }
    }
    if (/and attacking/.test(m[1]) && G.s.combat) {
      G.s.combat.attackers.push(i);
      joinAttack(i, env.src && env.src.iid);
      tk.attacking = true;
    }
    if (/sacrifice (?:it|that token|them|the tokens?) at the beginning of the next end step|exile (?:it|that token|them|the tokens?) at the beginning of the next end step/.test(env.text)) tk.endOfTurn = /exile/.test(env.text) ? 'exile' : 'sacrifice';
  }
  env.them_ = made;
  env.it = made[0] ? { iid: made[0] } : null;
  env.did.push(`creates ${count > 1 ? count + ' token copies' : 'a token copy'} of ${nameTag(orig)}`);
  env.did.push(...(await attachLooseAuras(made, env.me, env.choosers)));
});
on(/^create (.+?) tokens?(?: (?:that are |that's )?(tapped(?: and attacking)?)(?: (?:that player|target opponent|the player|defending player|an opponent)(?: or (?:a|that) planeswalker (?:they control|it's attacking))?)?)?(?: with (.+?))?(?: attached to (.+?))?(?:, then .+)?$/, async (m, env) => {
  if (/that's a copy|that are copies/.test(m[1])) return;
  // "create a 2/2 Knight token with vigilance, a 3/3 Centaur token, and a 4/4 Rhino token with trample"
  const body = env.sentence.replace(/^create /, '');
  const parts = body.split(/,\s*(?:and\s+)?(?=(?:a|an|one|two|three|four|five|x) (?:tapped )?(?:\d+\/\d+|[a-z]+ (?:\d+\/\d+ )?[a-z ]*?(?:creature|artifact) tokens?|[a-z]+ tokens?))|\s+and\s+(?=(?:a|an|one|two|three|four|five) (?:\d+\/\d+|[a-z]+ (?:artifact )?tokens?))/);
  if (parts.length > 1 && parts.every((p) => /\btokens?\b/.test(p))) {
    for (const p of parts) await makeTokens(env, p.replace(/\s*tokens?\b/, ''), null);
    return;
  }
  await makeTokens(env, m[1] + (m[2] ? ' ' + m[2] : '') + (m[3] ? ' with ' + m[3] : ''), m[4]);
});
on(/^(?:you )?investigate(?: (\w+) times)?/, async (m, env) => {
  const k = m[1] ? n(m[1]) : 1;
  createToken(genericTokenDef(0, 0, 'Clue'), env.me, k);
  env.did.push(`investigates${k > 1 ? ' ' + k + ' times' : ''}`);
});
on(/^amass (\w+)(?: (\d+|x))?/, async (m, env) => {
  const k = m[2] ? n(m[2], env.x) : n(m[1], env.x);
  const kind = m[2] ? m[1][0].toUpperCase() + m[1].slice(1) : 'Zombie';
  let army = cardsIn(env.me, 'battlefield').find((c) => hasSubtype(c, 'Army'));
  if (!army) {
    const [t] = createToken(genericTokenDef(0, 0, `${kind} Army`, 'B'), env.me, 1, { noDouble: true });
    army = card(t);
  }
  addCounters(army, '+1/+1', k);
  env.it = { iid: army.iid };
  env.did.push(`amasses ${k}`);
});
on(/^incubate (\w+)/, async (m, env) => {
  const k = n(m[1], env.x);
  const id = incubatorDef();
  const [t] = createToken(id, env.me, 1);
  addCounters(card(t), '+1/+1', k);
  env.did.push(`incubates ${k}`);
});
function incubatorDef() {
  const id = 'gen-incubator';
  if (!DB[id]) {
    DB[id] = {
      id, name: 'Incubator', layout: 'token', cmc: 0, manaCost: '', typeLine: 'Token Artifact — Incubator', colors: [], ci: [], keywords: [], produced: [], tokens: [], doubleFaced: true, isToken: true,
      faces: [
        { name: 'Incubator', manaCost: '', typeLine: 'Token Artifact — Incubator', oracle: '{2}: Transform this artifact.', img: null, imgLarge: null },
        { name: 'Phyrexian Token', manaCost: '', typeLine: 'Token Artifact Creature — Phyrexian', oracle: '', power: '0', toughness: '0', img: null, imgLarge: null },
      ],
    };
  }
  return id;
}
on(/^populate/, async (m, env) => {
  const toks = cardsIn(env.me, 'battlefield').filter((c) => c.token && isCreature(c));
  if (!toks.length) return env.did.push('has nothing to populate');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'Choose a creature token to copy', cards: toks.map((c) => c.iid), min: 1, max: 1, purpose: 'populate', src: env.src, aiScore: (c) => cardValue(c) });
  const orig = card(pick);
  createToken(orig.def, env.me, 1);
  env.did.push(`populates (${nameTag(orig)})`);
});

async function makeTokens(env, desc, attachPhrase) {
  const d = desc.toLowerCase();
  const me = env.me;
  const m = d.match(new RegExp('^' + NUM + ' (?:tapped )?(?:and attacking )?(?:untapped )?|^(?:x|that many) '));
  let count = 1;
  if (/^that many/.test(d)) count = env.lastAmount || 0;
  else if (/^x /.test(d)) count = env.x || 0;
  else if (m) count = n(m[1], env.x);
  else if (/^(?:a number of|tokens equal to)/.test(d)) count = 1;
  const eq = d.match(/equal to (?:the number of |your )?(.+?)$/);
  if (eq && /^(?:a number of|x )/.test(d)) count = countPhrase(me, eq[1], helpers, env.src.iid) || 0;
  const tapped = /\btapped\b/.test(d);
  const attacking = /and attacking/.test(d);
  const src = env.src;
  let defId = null;
  let forcedPT = null;
  // known token from the card's Scryfall parts
  for (const id of (DB[src.def] || { tokens: [] }).tokens) {
    const td = DB[id];
    if (!td) continue;
    const nm = td.name.toLowerCase();
    if (d.includes(nm) || (nm.split(' ')[0].length > 3 && d.includes(nm.split(' ')[0]))) {
      const pt = d.match(/(\d+)\/(\d+)/);
      if (pt && td.faces[0].power !== undefined && /^\d+$/.test(td.faces[0].power) && (td.faces[0].power !== pt[1] || td.faces[0].toughness !== pt[2])) continue;
      defId = id;
      // "an X/X Shark" / "a 4/4 …" on a token whose printed P/T is 0/0 or *: keep the art, set the size
      const ptx = d.match(/\b(\d+|x)\/(\d+|x)\b/);
      if (ptx && (/x/.test(ptx[0]) || td.faces[0].power !== ptx[1] || td.faces[0].toughness !== ptx[2])) {
        forcedPT = { p: ptx[1] === 'x' ? env.x || 0 : +ptx[1], t: ptx[2] === 'x' ? env.x || 0 : +ptx[2] };
      }
      break;
    }
  }
  let mm;
  if (!defId && (mm = d.match(/\b(treasure|clue|food|blood|map|powerstone|gold|junk|shard|lander|mutagen)\b/))) defId = genericTokenDef(0, 0, mm[1][0].toUpperCase() + mm[1].slice(1));
  if (!defId && (mm = d.match(/\b(monster|royal|sorcerer|virtuous|wicked|young hero|cursed) role\b/))) {
    defId = genericTokenDef(0, 0, mm[1].replace(/\b\w/g, (x) => x.toUpperCase()));
  }
  if (!defId && (mm = d.match(/(\d+|x)\/(\d+|x)\s+((?:[a-z]+ )*?)((?:artifact |enchantment |legendary |snow )*)creature/))) {
    const pw = mm[1] === 'x' ? env.x || 0 : +mm[1];
    const tg = mm[2] === 'x' ? env.x || 0 : +mm[2];
    const words = mm[3].trim().split(/\s+/).filter(Boolean);
    const colorNames = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
    const colors = words.filter((w) => colorNames[w]).map((w) => colorNames[w]);
    const subs = words.filter((w) => !colorNames[w] && !/^(colorless|and|legendary|snow)$/.test(w));
    const label = subs.length ? subs.join(' ').replace(/\b\w/g, (x) => x.toUpperCase()) : 'Creature';
    const kws = [];
    const w = d.match(/with ([a-z ,]+?)(?:\.|$| and "| that| attached|"|$)/);
    if (w) kws.push(...kwList(w[1]).filter((k) => /^(flying|trample|haste|vigilance|reach|lifelink|deathtouch|menace|first strike|double strike|defender|hexproof|indestructible|infect|prowess|ward \{\d\}|decayed|changeling|toxic \d)$/.test(k)));
    defId = genericTokenDef(pw, tg, label, colors, { keywords: kws, types: mm[4].trim().replace(/\b\w/g, (x) => x.toUpperCase()) });
  }
  if (!defId && (mm = d.match(/\b(gingerbrute)\b/))) defId = namedTokenDef('Gingerbrute');
  if (!defId) defId = genericTokenDef(1, 1, 'Token');
  const made = createToken(defId, me, count, { tapped });
  // a made-up token gets the quoted ability the card gives it (Teferi, Temporal Pilgrim's Spirit:
  // 'with vigilance and "Whenever you draw a card, put a +1/+1 counter on this token."')
  {
    const q = String(env.sentence || '').match(/"([^"]+)"/);
    if (q && /^gen-/.test(defId) && !(DB[defId].faces[0].oracle || '').includes(q[1].slice(0, 20))) for (const i of made) if (card(i)) card(i).extraText = ((card(i).extraText || '') + '\n' + q[1].replace(/this (?:token|creature)/gi, '~')).trim();
  }
  if (forcedPT) for (const i of made) if (card(i)) card(i).setPT = { ts: nextStamp(), ...forcedPT };
  if (attacking && G.s.combat) {
    for (const i of made) {
      G.s.combat.attackers.push(i);
      joinAttack(i, env.src && env.src.iid);
      card(i).attacking = true;
      card(i).tapped = true;
      G.s.combat.targets = G.s.combat.targets || {};
      G.s.combat.targets[i] = opp(me);
    }
  }
  if (/sacrifice (?:it|that token|them|those tokens) at the beginning of the next end step/.test(env.text)) made.forEach((i) => (card(i).endOfTurn = 'sacrifice'));
  if (/exile (?:it|that token|them|those tokens) at the beginning of the next end step/.test(env.text)) made.forEach((i) => (card(i).endOfTurn = 'exile'));
  if (attachPhrase || /role/.test(d)) {
    // Gylwain: "Whenever Gylwain or another nontoken creature you control enters … attached to that creature" — Gylwain itself
    const selfHost = /^(?:that creature|it)$/.test(attachPhrase || '') && !(env.it && env.it.iid && card(env.it.iid) && card(env.it.iid).zone === 'battlefield') && env.src && card(env.src.iid) && card(env.src.iid).zone === 'battlefield';
    const [t] = selfHost ? [card(env.src.iid)] : await objects(env, attachPhrase || 'target creature', { harm: /cursed/.test(d) });
    for (const i of made) if (t) attachTo(card(i), t);
  }
  env.them_ = made;
  env.it = made[0] ? { iid: made[0] } : env.it;
  env.did.push(`creates ${made.length} ${DB[defId].name} token${made.length === 1 ? '' : 's'}`);
}

// --- counters
on(/^put (a|an|one|two|three|four|five|six|x|\d+|that many) ([+-]\d+\/[+-]\d+|[a-z]+) counters? on ((?:(?! and (?:draw|create|you|gain|scry|surveil|investigate|exile|destroy|return|untap|tap|mill|look|it|~)\b).)+?)(?: for each [^.]+)?(?:\.|$)/, async (m, env) => {
  let k = /that many/.test(m[1]) ? env.lastAmount || 0 : n(m[1], env.x);
  const fe = env.sentence.match(/for each ([^.]+)$/);
  if (fe && /^creature blocking it$/.test(fe[1])) k *= env.thatMuch || 0;
  // Ramos, Dragon Engine: "for each of that spell's colors"
  else if (fe && /^of that spell's colors$/.test(fe[1])) {
    const sp = (env.it && env.it.iid && card(env.it.iid)) || (env.event && env.event.iid && card(env.event.iid));
    k *= sp ? colorsOf(sp).length : 0;
  }
  else if (fe) k *= countPhrase(env.me, fe[1], helpers, env.src.iid) || 0;
  const kind = m[2];
  const objs = await objects(env, m[3], { harm: /^-/.test(kind) || kind === 'stun' || kind === 'blight' || kind === 'bounty' });
  for (const c of objs) {
    addCounters(c, kind, k);
    if (objs.length <= 3) env.did.push(`puts ${k} ${kind} counter${k === 1 ? '' : 's'} on ${nameTag(c)}`);
  }
  if (objs.length > 3) env.did.push(`puts ${kind} counters on ${objs.length} permanents`);
});
on(/^distribute (\w+) ([+-]\d+\/[+-]\d+|[a-z]+) counters among (.+?)(?:\.|$)/, async (m, env) => {
  const k = n(m[1], env.x);
  const objs = await objects(env, m[3].replace(/^(?:one|any number of|up to \w+) /, ''), { harm: false });
  if (!objs.length) return;
  const each = Math.floor(k / objs.length);
  objs.forEach((c, i) => addCounters(c, m[2], each + (i < k % objs.length ? 1 : 0)));
  env.did.push(`distributes ${k} ${m[2]} counters`);
});
on(/^remove (a|an|one|two|three|all|x|\d+) ([+-]\d+\/[+-]\d+|[a-z]+) counters? from (.+?)(?:\.|$)/, async (m, env) => {
  const objs = await objects(env, m[3]);
  for (const c of objs) {
    const have = (c.counters || {})[m[2]] || 0;
    const k = m[1] === 'all' ? have : Math.min(have, n(m[1], env.x));
    if (k) c.counters[m[2]] = have - k;
    if (!c.counters[m[2]] && m[2] !== 'loyalty') delete c.counters[m[2]];
    env.lastAmount = k;
    env.did.push(`removes ${k} ${m[2]} counter${k === 1 ? '' : 's'} from ${nameTag(c)}`);
  }
});
// Unnatural Growth, Mr. Orfeo, Kraken's double strike pals: "double the power (and toughness) of …"
on(/^double (?:the )?(power and toughness|power|toughness) of (.+?)(?: until end of turn)?(?:\.|$)/, async (m, env) => {
  const objs = (await objects(env, m[2], { harm: false })).filter(isCreature);
  for (const c of objs) {
    const p = /power/.test(m[1]) ? Math.max(0, power(c)) : 0;
    const t = /toughness/.test(m[1]) ? Math.max(0, toughness(c)) : 0;
    pumpEOT(c, { p, t });
  }
  if (objs.length) env.did.push(`doubles the ${m[1]} of ${objs.length > 3 ? objs.length + ' creatures' : objs.map(nameTag).join(', ')}`);
  else env.did.push('has no creatures to double');
});
on(/^double the number of ([+-]\d+\/[+-]\d+|[a-z]+|each kind of) counters on (.+?)(?:\.|$)/, async (m, env) => {
  const objs = await objects(env, m[2]);
  for (const c of objs) {
    for (const k of Object.keys(c.counters || {})) if (m[1] === 'each kind of' || k === m[1]) addCounters(c, k, c.counters[k]);
    env.did.push(`doubles the counters on ${nameTag(c)}`);
  }
});
on(/^proliferate(?: (twice|thrice|\w+ times))?/, async (m, env) => {
  const times = !m[1] ? 1 : m[1] === 'twice' ? 2 : m[1] === 'thrice' ? 3 : n(m[1].replace(/ times$/, '')) || 1;
  const PNAME = { poison: 'poison', energy: 'energy', experience: 'experience', rad: 'rad', ticket: 'ticket' };
  // a player's counters: poison lives on the player, the rest in .counters
  const pCounters = (pid) => {
    const P = G.s.players[pid];
    const out = {};
    if (P.poison > 0) out.poison = P.poison;
    for (const [k, v] of Object.entries(P.counters || {})) if (v > 0 && PNAME[k]) out[k] = v;
    return out;
  };
  for (let t = 0; t < times; t++) {
    const perms = seats().flatMap((k) => cardsIn(k, 'battlefield')).filter((c) => Object.values(c.counters || {}).some((v) => v > 0));
    const players = seats().filter((pid) => Object.keys(pCounters(pid)).length).map((pid) => ({
      key: 'player:' + pid,
      label: seatNameCap(pid),
      sub: Object.entries(pCounters(pid)).map(([k, v]) => `${v} ${PNAME[k]}`).join('\n'),
    }));
    const total = perms.length + players.length;
    const picks = total ? await env.choosers[env.me].pickCards({
      prompt: 'Proliferate: choose permanents and/or players to get one more of each kind of counter they already have', cards: perms.map((c) => c.iid), players, min: 0, max: total,
      purpose: 'proliferate', src: env.src, forced: env.forced,
      aiScore: (c) => {
        const good = (c.counters['+1/+1'] || 0) + (c.counters.loyalty || 0) + (c.counters.lore || 0) * 0.1;
        const bad = (c.counters['-1/-1'] || 0) + (c.counters.stun || 0);
        return c.controller === env.me ? good - bad : bad - good;
      },
      aiPlayerScore: (key) => {
        const pid = key.slice(7);
        const cs = pCounters(pid);
        // poison and rad hurt whoever has them; energy, experience and tickets help
        const good = (cs.energy ? 1 : 0) + (cs.experience ? 1 : 0) + (cs.ticket ? 1 : 0);
        const bad = (cs.poison ? 2 : 0) + (cs.rad ? 1 : 0);
        return pid === env.me ? good - bad : bad - good;
      },
    }) : [];
    const gotP = [];
    for (const i of picks) {
      if (typeof i === 'string' && i.startsWith('player:')) {
        const pid = i.slice(7);
        const P = G.s.players[pid];
        if (P.poison > 0) P.poison++;
        for (const k of Object.keys(P.counters || {})) if (P.counters[k] > 0 && PNAME[k]) P.counters[k]++;
        gotP.push(who(pid));
        continue;
      }
      const c = card(i);
      if (!c) continue;
      if (isAI(env.me) && ((c.controller === env.me && !c.counters['+1/+1'] && !c.counters.loyalty) || (c.controller !== env.me && !c.counters['-1/-1'] && !c.counters.stun))) continue;
      for (const k of Object.keys(c.counters)) if (c.counters[k] > 0) addCounters(c, k, 1);
    }
    const nP = picks.length - gotP.length;
    env.did.push(`proliferates (${nP} permanent${nP === 1 ? '' : 's'}${gotP.length ? ', and ' + gotP.join(' and ') : ''})`);
  }
});
// ---- energy {E}
// one place that hands out energy, so "Whenever you get one or more {E}" triggers fire
export function gainEnergy(pid, k, env) {
  if (!(k > 0)) return 0;
  const kk = k + (repl('playerCounterPlusOne', pid) || 0);
  G.s.players[pid].counters.energy = (G.s.players[pid].counters.energy || 0) + kk;
  queueEvent({ type: 'energyGained', pid, amount: kk, yourTurn: G.s.active === pid });
  if (env) env.did.push(`${who(pid)} ${s_(pid, 'get')} ${kk} energy`);
  return kk;
}
// "you get {E}{E}", "you get six {E}", "you get that many {E}", "you get an amount of {E} equal to …", "you get {E} for each …"
on(/^(?:then )?(?:you )?get (that many \{e\}|an amount of \{e\} equal to (.+)|((?:\{e\})+) for each (.+)|(\w+) \{e\}|(?:\{e\})+)$/, async (m, env) => {
  const w = m[1];
  let k;
  if (/^that many/.test(w)) k = env.lastAmount || env.thatMuch || 0;
  else if (m[2]) k = amountOf('equal to ' + m[2].replace(/^~'s/, "~'s"), env);
  else if (m[4]) k = (m[3].match(/\{e\}/g) || []).length * Math.max(0, countPhrase(env.me, m[4], helpers, env.src && env.src.iid) || 0);
  else if (m[5]) k = n(m[5], env.x);
  else k = (w.match(/\{e\}/g) || []).length;
  if (!k) return env.did.push(`${who(env.me)} ${s_(env.me, 'get')} no energy`);
  gainEnergy(env.me, k, env);
}, { first: true });
// "you may pay {E}{E}{E}", "pay eight {E}", "pay one or more {E}", "pay any amount of {E}", "pay an amount of {E} equal to that permanent's mana value"
on(/^(?:then )?(?:you may )?pay (any amount of \{e\}|one or more \{e\}|an amount of \{e\} equal to (.+)|(\w+) \{e\}|(?:\{e\})+)$/, async (m, env) => {
  const have = G.s.players[env.me].counters.energy || 0;
  const may = /\bmay\b/.test(env.sentence || m[0]);
  const w = m[1];
  env.lastMay = false;
  env.energyPaid = 0;
  let k;
  if (/^any amount|^one or more/.test(w)) {
    const min = /^one or more/.test(w) ? 1 : 0;
    if (have < Math.max(min, 1)) return env.did.push('has no energy to pay');
    // AI: enough to kill "that creature" when that's the point, otherwise all of it
    const it = env.it && env.it.iid && card(env.it.iid);
    const rest = (env.text || '').slice((env.text || '').indexOf(w));
    let aiK = have;
    if (it && it.zone === 'battlefield' && isCreature(it) && /damage to that creature/.test(rest)) aiK = Math.min(have, Math.max(1, toughness(it) - (it.damage || 0)));
    k = await env.choosers[env.me].chooseNumber({ prompt: `${cardName(env.src)}: pay how much energy? (you have ${have})`, min, max: have, ai: aiK });
    k = Math.max(0, Math.min(have, +k || 0));
    if (k < min || !k) return env.did.push('pays no energy');
  } else {
    k = m[2] ? amountOf('equal to ' + m[2], env) : m[3] ? n(m[3], env.x) : (w.match(/\{e\}/g) || []).length;
    if (have < k) return env.did.push(`can't pay ${k} energy (has ${have})`);
    if (may && !(await env.choosers[env.me].confirm(cardName(env.src), `Pay ${k} energy? (you have ${have})`, env))) return env.did.push('pays no energy');
  }
  G.s.players[env.me].counters.energy -= k;
  if (G.s.ts && G.s.ts[env.me]) G.s.ts[env.me].energyPaid = (G.s.ts[env.me].energyPaid || 0) + k;
  env.lastMay = true;
  env.lastAmount = env.thatMuch = env.energyPaid = k;
  env.did.push(`pays ${k} energy`);
}, { first: true });
// Ultima, Origin of Oblivion: "For as long as that land has a blight counter on it, it loses all land types and abilities and has "{T}: Add {C}.""
on(/^for as long as that land has a blight counter on it, it loses all land types and abilities and has "\{t\}: add \{c\}\.?"$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  if (!c || c.zone !== 'battlefield') return env.did.push('no land');
  c.blightLand = true;
  env.did.push(`${nameTag(c)} is blighted: no land types or abilities, taps for {C}`);
}, { first: true });
// Call the Spirit Dragons: "For each color, put a +1/+1 counter on a Dragon you control of that color. If you put +1/+1 counters on five Dragons this way, you win the game."
on(/^for each color, put a \+1\/\+1 counter on a dragon you control of that color\. if you put \+1\/\+1 counters on five dragons this way, you win the game$/, async (m, env) => {
  const dragons = cardsIn(env.me, 'battlefield').filter((c) => isCreature(c) && hasSubtype(c, 'Dragon'));
  // give each color to a different Dragon where possible (most different Dragons = closest to winning): small matching
  const cols = ['W', 'U', 'B', 'R', 'G'].filter((col) => dragons.some((d) => colorsOf(d).includes(col)));
  let best = null;
  const tryAssign = (k, used, pick) => {
    if (k === cols.length) {
      const distinct = new Set(pick).size;
      if (!best || distinct > best.distinct) best = { distinct, pick: [...pick] };
      return;
    }
    const opts = dragons.filter((d) => colorsOf(d).includes(cols[k]));
    // prefer an unused Dragon first
    for (const d of [...opts.filter((d) => !used.has(d.iid)), ...opts.filter((d) => used.has(d.iid))]) {
      const had = used.has(d.iid);
      used.add(d.iid);
      pick.push(d.iid);
      tryAssign(k + 1, used, pick);
      pick.pop();
      if (!had) used.delete(d.iid);
      if (best && best.distinct === cols.length) return;
    }
  };
  tryAssign(0, new Set(), []);
  if (!best || !best.pick.length) return env.did.push('no colored Dragons');
  best.pick.forEach((iid, k) => addCounters(card(iid), '+1/+1', 1, { by: env.me }));
  const got = [...new Set(best.pick)];
  env.did.push(`puts +1/+1 counters on ${got.map((i) => nameTag(card(i))).join(', ')} (${cols.join('')})`);
  if (got.length >= 5) {
    winGame(env.me, 'Call the Spirit Dragons — five Dragons got counters');
  }
}, { first: true, multi: true });
// Princess Yue: "When ~ dies, if she was a nonland creature, return this card to the battlefield tapped under your control. She's a land named Moon. She gains "{T}: Add {C}.""
on(/^(?:if (?:she|he|it) was a nonland creature, )?return (?:this card|~) to the battlefield tapped under your control\. (?:she's|he's|it's) a land named ([a-z' ]+)\. (?:she|he|it) gains "\{t\}: add \{c\}\.?"(?: \((?:she's|he's|it's) still legendary\.?\))?$/, async (m, env) => {
  const c = env.src && card(env.src.iid);
  if (!c || c.zone !== 'graveyard') return env.did.push('is no longer in the graveyard');
  // the intervening "if": it was a land already (died as Moon) → stays in the graveyard
  if (G.s.lki && G.s.lki[c.iid] && G.s.lki[c.iid].wasLand) return env.did.push('was a land — stays in the graveyard');
  toBattlefield(c.iid, env.me, { tapped: true });
  const x = card(c.iid);
  x.tapped = true;
  x.becameLand = m[1].replace(/\b\w/g, (y) => y.toUpperCase());
  x.nameOverride = x.becameLand;
  env.did.push(`returns as a tapped land named ${x.becameLand}`);
}, { first: true, multi: true });
// Ob Nixilis, the Fallen: "you may have target player lose 3 life" → "target player loses 3 life"
on(/^have (target player|target opponent|each opponent|each player|that player|its controller|defending player) (lose|gain|draw|mill|discard|sacrifice|create|put|shuffle|exile) (.+)$/, async (m, env) => {
  const verb = m[2] === 'lose' ? 'loses' : m[2] === 'gain' ? 'gains' : m[2] + 's';
  const before = env.unknown.length;
  await runSentence(`${m[1]} ${verb} ${m[3]}`, env);
  env.lastMay = env.unknown.length === before;
}, { first: true });
// Braids, Arisen Nightmare: "If you do, each opponent may sacrifice a permanent that shares a card type with it.
// For each opponent who doesn't, that player loses 2 life and you draw a card."
on(/^(?:if you do, )?each opponent may sacrifice a permanent that shares a card type with it\. for each opponent who doesn't, that player loses (\d+) life and you draw (a|one|two) cards?$/, async (m, env) => {
  const it = env.it && env.it.iid && card(env.it.iid);
  if (!it) return env.did.push('nothing was sacrificed');
  const TYPES = ['Artifact', 'Creature', 'Enchantment', 'Land', 'Planeswalker', 'Battle'];
  const types = TYPES.filter((t) => new RegExp('\\b' + t + '\\b').test((DB[it.def].faces[0].typeLine || DB[it.def].typeLine || '').split('—')[0]));
  const loss = +m[1];
  const draws = n(m[2]);
  for (const o of opponents(env.me).filter(inGame)) {
    const pool = cardsIn(o, 'battlefield').filter((c) => types.some((t) => new RegExp('\\b' + t + '\\b').test(typeLine(c).split('—')[0])));
    let pick = null;
    if (pool.length) {
      if (isAI(o)) {
        // the AI gives up something cheap (a token or a spare land) rather than take the hit, unless life is plentiful
        const cheap = pool.slice().sort((a, b) => cardValue(a) - cardValue(b))[0];
        const lands = cardsIn(o, 'battlefield').filter(isLand).length;
        const spare = cheap.token || (isLand(cheap) && lands > 6) || cardValue(cheap) < 1.5;
        if (spare || G.s.players[o].life <= loss * 2) pick = cheap.iid;
      } else {
        const r = await env.choosers[o].pickCards({
          prompt: `${cardName(env.src)}: sacrifice a ${types.join(' or ').toLowerCase()} — or choose none to lose ${loss} life and let ${who(env.me)} draw`,
          cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'sacrifice', src: env.src, forced: true, aiScore: (c) => -cardValue(c),
        });
        pick = r && r[0];
      }
    }
    if (pick) {
      env.did.push(`${who(o)} ${s_(o, 'sacrifice')} ${nameTag(card(pick))}`);
      sacrifice(pick);
    } else {
      changeLife(o, -loss, false);
      draw(env.me, draws, true);
      env.did.push(`${who(o)} ${s_(o, 'lose')} ${loss} life and ${who(env.me)} ${s_(env.me, 'draw')} ${draws}`);
    }
  }
}, { first: true, multi: true });
// Hedge Shredder: "put them onto the battlefield tapped" (the land cards just milled)
on(/^put them onto the battlefield( tapped)?(?: under your control)?$/, async (m, env) => {
  const ids = (env.trigThem || env.them_ || []).filter((i) => card(i) && card(i).zone === 'graveyard');
  if (!ids.length) return 'pass';
  for (const i of ids) toBattlefield(i, env.me, { tapped: !!m[1] });
  env.did.push(`puts ${ids.map((i) => nameTag(card(i))).join(', ')} onto the battlefield${m[1] ? ' tapped' : ''}`);
}, { first: true });
// ---- precon batch 1
// Nekusar, Kami of the Crescent Moon, Rites of Flourishing: "that player draws an additional card"
on(/^(that player|that opponent|they) draws? an additional card$/, async (m, env) => {
  const pid = env.thatPlayer || G.s.active;
  draw(pid, 1, true);
  env.did.push(`${who(pid)} ${s_(pid, 'draw')} an additional card`);
}, { first: true });
// Knight Rampager, Vial Smasher: "choose an opponent at random"
on(/^choose an opponent at random$/, async (m, env) => {
  const os = opponents(env.me).filter(inGame);
  if (!os.length) return;
  env.thatPlayer = os[Math.floor(Math.random() * os.length)];
  env.did.push(`randomly chooses ${who(env.thatPlayer)}`);
}, { first: true });
// Territorial Hellkite: "choose an opponent at random that ~ didn't attack during your last combat"
on(/^choose an opponent at random that ~ didn't attack during your last combat$/, async (m, env) => {
  const me = env.src && card(env.src.iid);
  const n = ((G.s.combatNo || {})[env.me] || 0) - 1;
  const hit = me && me.attackLog && me.attackLog.n === n ? me.attackLog.players : [];
  const os = opponents(env.me).filter(inGame).filter((p) => !hit.includes(p));
  if (!os.length) { env.thatPlayer = null; env.noChoice = true; return env.did.push('no opponent can be chosen'); }
  env.noChoice = false;
  env.thatPlayer = os[Math.floor(Math.random() * os.length)];
  env.did.push(`randomly chooses ${who(env.thatPlayer)}`);
}, { first: true });
on(/^if you can't choose an opponent this way, tap ~$/, async (m, env) => {
  const me = env.src && card(env.src.iid);
  if (!env.noChoice || !me || me.zone !== 'battlefield') return;
  tapPerm(me);
  env.did.push(`taps ${nameTag(me)}`);
}, { first: true });
// Hellkite Courser
on(/^(you may )?put a commander you own from the command zone onto the battlefield\. it gains haste\. return it to the command zone at the beginning of the next end step$/, async (m, env) => {
  const cm = cardsIn(env.me, 'command').filter((c) => c.isCommander && c.owner === env.me && !isType(c, 'Instant') && !isType(c, 'Sorcery'));
  if (!cm.length) return env.did.push('no commander in the command zone');
  let pick = cm[0];
  if (cm.length > 1) pick = cm.slice().sort((a, b) => cardValue(b) - cardValue(a))[0];
  if (m[1] && !isAI(env.me) && !(await mayAsk(env, `put ${nameTag(pick)} onto the battlefield (returns at end step)`))) return;
  toBattlefield(pick.iid, env.me);
  const c = card(pick.iid);
  if (!c) return;
  c.grants = [...(c.grants || []), 'haste'];
  env.it = { iid: c.iid };
  G.s.delayed = G.s.delayed || [];
  G.s.delayed.push({ at: 'endStep', kind: 'toCommand', iid: c.iid, pid: env.me, enteredTurn: G.s.turn });
  env.did.push(`puts ${nameTag(c)} onto the battlefield with haste; it returns to the command zone at the next end step`);
}, { first: true, multi: true });
// Stormbreath Dragon
on(/^(?:it|~) deals damage to each opponent equal to the number of cards in that player's hand$/, async (m, env) => {
  const src = (env.src && card(env.src.iid)) || env.src;
  for (const o of opponents(env.me).filter(inGame)) {
    const k = cardsIn(o, 'hand').length;
    if (!k) continue;
    env.thatPlayer = o;
    await dealDamage(env, src, k, 'that player');
  }
}, { first: true });
// "~ attacks that player this combat if able"
on(/^(?:~|it|that creature) attacks that player this combat if able$/, async (m, env) => {
  const c = /^~/.test(m[0]) ? env.src && card(env.src.iid) : env.it && env.it.iid && card(env.it.iid);
  if (!c) return;
  c.mustAttackTurn = G.s.turn;
  if (env.thatPlayer) c.mustAttackPlayer = env.thatPlayer;
  env.did.push(`${nameTag(c)} must attack ${who(env.thatPlayer || opp(env.me))} this combat`);
}, { first: true });
// Sandstone Oracle, Slithermuse: "If that player has more cards in hand than you, draw cards equal to the difference."
on(/^if that player has more cards in hand than you, draw cards equal to the difference$/, async (m, env) => {
  const o = env.thatPlayer || opp(env.me);
  const d = cardsIn(o, 'hand').length - cardsIn(env.me, 'hand').length;
  if (d <= 0) return env.did.push('no difference to draw');
  draw(env.me, d, true);
  env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${d}`);
}, { first: true });
// Black Widow, Intellectual Offering: "you and that player each draw two cards" / "… that many cards"
on(/^you and (that player|target opponent|that opponent) each draw (a|one|two|three|four|that many|x|\d+) cards?$/, async (m, env) => {
  const k = m[2] === 'that many' ? env.lastAmount || 0 : m[2] === 'a' ? 1 : n(m[2], env.x);
  const o = m[1] === 'target opponent' ? (await playerTarget(env, 'target opponent'))[0] : env.thatPlayer || opp(env.me);
  if (!k) return;
  draw(env.me, k, true);
  if (o) draw(o, k, true);
  env.did.push(`${who(env.me)} and ${o ? who(o) : 'nobody'} each draw ${k}`);
}, { first: true });
// Flawless Forgery, Renegade Bull, Wildfire Devils: "Copy that card. You may cast the copy without paying its mana cost."
on(/^copy (that card|it)$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  if (!c || !['exile', 'graveyard', 'hand', 'library'].includes(c.zone)) return 'pass';
  if (G.s.stack && G.s.stack.iid === c.iid) return 'pass';
  const cid = makeCard(c.def, env.me, 'exile');
  const cc = card(cid);
  cc.copyCard = true; // ceases to exist when it leaves the stack (state.js)
  cc.face = c.face || 0;
  env.copyCard = cid;
  env.did.push(`copies ${nameTag(c)}`);
}, { first: true });
on(/^(?:you may )?cast the copy without paying its mana cost$/, async (m, env) => {
  const cid = env.copyCard;
  if (!cid || !card(cid)) return env.did.push('has no copy to cast');
  const cast_ = await castFromPool(env, [cid], { free: true, max: 1, prompt: `Cast the copy of ${cardName(card(cid))} without paying its mana cost?` });
  if (!cast_.length && card(cid)) { delete G.s.cards[cid]; const z = zoneOf(env.me, 'exile'); const i = z.indexOf(cid); if (i >= 0) z.splice(i, 1); }
  env.copyCard = null;
}, { first: true });
// Afterlife from the Loam, Dredge the Mire: "For each player, choose up to one target creature card in that player's graveyard."
on(/^for each (player|opponent), choose up to one target ([a-z ]+?) card in that player's graveyard$/, async (m, env) => {
  const picks = [];
  for (const pid of (m[1] === 'player' ? seats() : opponents(env.me)).filter(inGame)) {
    const pool = cardsIn(pid, 'graveyard').filter((c) => matchesFilter(c, m[2]));
    if (!pool.length) continue;
    const [p] = await env.choosers[env.me].pickCards({ prompt: `Choose up to one ${m[2]} card in ${pid === 'p' ? 'your' : seatName(pid) + "'s"} graveyard`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'reanimate', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
    if (p) picks.push(p);
  }
  env.them_ = picks;
  env.it = picks[0] ? { iid: picks[0] } : null;
  env.did.push(picks.length ? `chooses ${picks.map((i) => nameTag(card(i))).join(', ')}` : 'chooses nothing');
}, { first: true });
on(/^(?:put|return) those cards onto the battlefield( tapped)?(?: under your control)?$/, async (m, env) => {
  const ids = (env.them_ || []).filter((i) => card(i) && card(i).zone !== 'battlefield');
  if (!ids.length) return env.them_ ? undefined : 'pass'; // already put there by the search (Celebrate the Harvest)
  for (const i of ids) toBattlefield(i, env.me, { tapped: !!m[1] });
  env.did.push(ids.length ? `puts ${ids.map((i) => nameTag(card(i))).join(', ')} onto the battlefield` : 'puts nothing onto the battlefield');
}, { first: true });
on(/^they're ([a-z]+)s in addition to their other types$/, async (m, env) => {
  const t = m[1].replace(/^\w/, (x) => x.toUpperCase());
  for (const i of env.them_ || []) if (card(i) && card(i).zone === 'battlefield') card(i).addTypes = ((card(i).addTypes || '') + ' ' + t).trim();
}, { first: true });
// Ethereal Valkyrie: "exile a card from your hand face down. It becomes foretold. Its foretell cost is its mana cost reduced by {2}."
on(/^(?:draw a card, then )?exile a card from your hand face down\. it becomes foretold\. its foretell cost is its mana cost reduced by \{(\d+)\}$/, async (m, env) => {
  if (/^draw a card/.test(m[0])) { draw(env.me, 1, true); env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} 1`); }
  const hand = cardsIn(env.me, 'hand');
  if (!hand.length) return env.did.push('has no card to foretell');
  const [p] = await env.choosers[env.me].pickCards({ forced: true, prompt: 'Exile a card from your hand face down — it becomes foretold', cards: hand.map((c) => c.iid), min: 1, max: 1, purpose: 'foretell', src: env.src, aiScore: (c) => (isLand(c) ? -5 : DB[c.def].cmc || 0) });
  if (!p) return;
  move(p, 'exile');
  const c = card(p);
  const mc = DB[c.def].manaCost || DB[c.def].faces[0].manaCost || '';
  const gen = (mc.match(/\{(\d+)\}/) || [0, 0])[1];
  const red = Math.max(0, +gen - +m[1]);
  Object.assign(c, { faceDown: true, foretold: true, foretoldTurn: G.s.turn, faceDownOwnerSees: true, foretellCost: mc.replace(/\{\d+\}/, red ? `{${red}}` : '') || '{0}' });
  env.did.push(`${who(env.me)} ${s_(env.me, 'foretell')} a card`);
}, { first: true, multi: true });
// ---- precon batch 3
// Lorcan: "pay life equal to its mana value" / "It's a Warlock in addition to its other types."
on(/^pay life equal to (?:its|that card's|that creature's) mana value$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  const k = c ? DB[c.def].cmc || 0 : 0;
  changeLife(env.me, -k, false);
  env.lastMay = true;
  env.did.push(`${who(env.me)} ${s_(env.me, 'pay')} ${k} life`);
}, { first: true });
on(/^it's an? ([a-z]+) in addition to its other types$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  if (!c || c.zone !== 'battlefield') return;
  c.addTypes = ((c.addTypes || '') + ' ' + m[1].replace(/^\w/, (x) => x.toUpperCase())).trim();
}, { first: true });
// Kessig Cagebreakers: "create a 2/2 green Wolf creature token that's tapped and attacking for each creature card in your graveyard"
on(/^create (?:a|an|one) (.+?) tokens? that's tapped and attacking for each (.+)$/, async (m, env) => {
  const k = Math.max(0, countPhrase(env.me, m[2], helpers, env.src && env.src.iid) || 0);
  if (!k) return env.did.push('creates no tokens');
  return runSentence(`create ${k} ${m[1]} tokens that are tapped and attacking`, env);
}, { first: true });
// Maddening Hex: "~ deals damage to that player equal to the result"
on(/^(?:~|it) deals damage to (that player|each opponent|target opponent|any target) equal to the result$/, async (m, env) => {
  const k = env.roll || env.lastAmount || 0;
  return runSentence(`~ deals ${k} damage to ${m[1]}`, env);
}, { first: true });
// Heroic Reinforcements: "Until end of turn, creatures you control get +1/+1 and gain haste."
on(/^until end of turn, ((?:other )?creatures you control|each creature you control) gets? ([+-]\d+)\/([+-]\d+)(?: and gains? (.+))?$/, async (m, env) => {
  return runSentence(`${m[1]} get ${m[2]}/${m[3]}${m[4] ? ' and gain ' + m[4] : ''} until end of turn`, env);
}, { first: true });
// Hammer of Nazahn: "you may attach that Equipment to target creature you control"
on(/^attach (?:that equipment|it|~) to target creature you control$/, async (m, env) => {
  const eq = (env.it && env.it.iid && card(env.it.iid)) || (env.src && card(env.src.iid));
  if (!eq || eq.zone !== 'battlefield' || !hasSubtype(eq, 'Equipment')) return 'pass';
  const [t] = await objects(env, 'target creature you control', { harm: false });
  if (!t) return;
  attachTo(eq, t);
  env.did.push(`attaches ${nameTag(eq)} to ${nameTag(t)}`);
}, { first: true });
// Learn from the Past: "Target player shuffles their graveyard into their library."
on(/^(target player|each player|you) shuffles? (?:their|your) graveyard into (?:their|your) library$/, async (m, env) => {
  const pids = m[1] === 'you' ? [env.me] : await playerTarget(env, m[1], false);
  for (const pid of pids) {
    const ids = zoneOf(pid, 'graveyard').slice();
    for (const i of ids) move(i, 'library');
    shuffle(pid);
    env.did.push(`${who(pid)} ${s_(pid, 'shuffle')} ${ids.length} card${ids.length === 1 ? '' : 's'} from the graveyard into the library`);
  }
}, { first: true });
// Loaming Shaman: "target player shuffles any number of target cards from their graveyard into their library"
on(/^target player shuffles any number of target cards from their graveyard into their library$/, async (m, env) => {
  const [pid] = await playerTarget(env, 'target player', false);
  if (!pid) return;
  const pool = cardsIn(pid, 'graveyard');
  const picks = pool.length ? await env.choosers[env.me].pickCards({ prompt: 'Choose any number of cards to shuffle into the library', cards: pool.map((c) => c.iid), min: 0, max: pool.length, purpose: 'recur', src: env.src, aiScore: (c) => (pid === env.me ? DB[c.def].cmc || 0 : -1) }) : [];
  for (const i of picks) move(i, 'library');
  shuffle(pid);
  env.did.push(`${who(pid)} ${s_(pid, 'shuffle')} ${picks.length} card${picks.length === 1 ? '' : 's'} into the library`);
}, { first: true });
// Last March of the Ents: "then put any number of creature cards from your hand onto the battlefield"
on(/^(?:then )?put any number of (creature|land|permanent|artifact) cards from your hand onto the battlefield$/, async (m, env) => {
  const pool = cardsIn(env.me, 'hand').filter((c) => matchesFilter(c, m[1]));
  const picks = pool.length ? await env.choosers[env.me].pickCards({ prompt: `Put any number of ${m[1]} cards onto the battlefield`, cards: pool.map((c) => c.iid), min: 0, max: pool.length, purpose: 'cheat', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 }) : [];
  for (const i of picks) toBattlefield(i, env.me);
  env.did.push(`puts ${picks.length} card${picks.length === 1 ? '' : 's'} onto the battlefield`);
}, { first: true });
// Neheb: "you may discard any number of cards. If you do, draw that many cards and add that much {R}."
on(/^discard any number of cards$/, async (m, env) => {
  const hand = cardsIn(env.me, 'hand');
  env.lastMay = false;
  const picks = hand.length ? await env.choosers[env.me].pickCards({ prompt: 'Discard any number of cards', cards: hand.map((c) => c.iid), min: 0, max: hand.length, purpose: 'discard', src: env.src, aiScore: (c) => (isLand(c) && cardsIn(env.me, 'battlefield').filter(isLand).length >= 5 ? 5 : -(DB[c.def].cmc || 0)) }) : [];
  for (const i of picks) discardCard(i);
  env.lastAmount = env.thatMuch = picks.length;
  env.lastMay = picks.length > 0;
  env.did.push(`${who(env.me)} ${s_(env.me, 'discard')} ${picks.length}`);
}, { first: true });
on(/^draw that many cards and add that much \{([wubrgc])\}$/, async (m, env) => {
  const k = env.lastAmount || 0;
  if (!k) return;
  draw(env.me, k, true);
  addMana(env.me, Array(k).fill(m[1].toUpperCase()));
  env.lastManaAdded = { list: Array(k).fill(m[1].toUpperCase()) };
  env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${k} and ${s_(env.me, 'add')} ${'{' + m[1].toUpperCase() + '}'}×${k}`);
}, { first: true });
// Nils: "for each player, put a +1/+1 counter on up to one target creature that player controls"
on(/^for each player, put a (\+1\/\+1|[a-z]+) counter on up to one target creature that player controls$/, async (m, env) => {
  const got = [];
  for (const pid of seats().filter(inGame)) {
    const pool = cardsIn(pid, 'battlefield').filter((c) => isCreature(c) && canTarget(c, env.me, env.src));
    if (!pool.length) continue;
    const pick = await env.choosers[env.me].target({ prompt: `Put a ${m[1]} counter on a creature ${pid === 'p' ? 'you control' : seatName(pid) + ' controls'}`, candidates: pool.map((c) => c.iid), harm: pid !== env.me, src: env.src, optional: true });
    if (pick && pick.iid) { addCounters(card(pick.iid), m[1], 1, { by: env.me }); got.push(nameTag(card(pick.iid))); }
  }
  env.did.push(got.length ? `puts a ${m[1]} counter on ${got.join(', ')}` : 'puts no counters');
}, { first: true });
// Ink-Eyes: "put target creature card from that player's graveyard onto the battlefield under your control"
on(/^put target ([a-z ]+?) card from that player's graveyard onto the battlefield under your control$/, async (m, env) => {
  const o = env.thatPlayer || opp(env.me);
  const pool = cardsIn(o, 'graveyard').filter((c) => matchesFilter(c, m[1]));
  if (!pool.length) return env.did.push('finds no card');
  const pick = await env.choosers[env.me].target({ prompt: `Choose a ${m[1]} card in ${o === 'p' ? 'your' : seatName(o) + "'s"} graveyard`, candidates: pool.map((c) => c.iid), harm: false, src: env.src, forced: true });
  if (!pick || !pick.iid) return;
  toBattlefield(pick.iid, env.me);
  env.it = { iid: pick.iid };
  env.did.push(`puts ${nameTag(card(pick.iid))} onto the battlefield`);
}, { first: true });
// ---- precon batch 2
// Archon of Redemption: "you may gain life equal to that creature's power"
on(/^gain life equal to (.+)$/, async (m, env) => {
  const k = amountOf('equal to ' + m[1], env);
  changeLife(env.me, k, false);
  env.did.push(`${who(env.me)} ${s_(env.me, 'gain')} ${k} life`);
}, { first: true });
// Aether Snap: "Remove all counters from all permanents and exile all tokens."
on(/^remove all counters from all permanents and exile all tokens$/, async (m, env) => {
  for (const c of seats().flatMap((k) => cardsIn(k, 'battlefield'))) c.counters = {};
  const toks = seats().flatMap((k) => cardsIn(k, 'battlefield')).filter((c) => c.token);
  for (const t of toks) move(t.iid, 'exile');
  env.did.push(`removes all counters and exiles ${toks.length} token${toks.length === 1 ? '' : 's'}`);
}, { first: true });
// Bribery: "Search target opponent's library for a creature card and put that card onto the battlefield under your control. Then that player shuffles."
on(/^search target opponent's library for an? ([a-z ]+?) card and put that card onto the battlefield under your control(?:\. then that player shuffles)?$/, async (m, env) => {
  const [o] = await playerTarget(env, 'target opponent');
  if (!o) return;
  const pool = zoneOf(o, 'library').map(card).filter((c) => c && matchesFilter(c, m[1]));
  const [p] = pool.length ? await env.choosers[env.me].pickCards({ prompt: `Search ${seatName(o)}'s library for a ${m[1]} card`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'tutor', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 }) : [];
  if (p) toBattlefield(p, env.me);
  shuffle(o);
  env.did.push(p ? `puts ${nameTag(card(p))} from ${whoseLib(o)} library onto the battlefield` : 'finds nothing');
}, { first: true, multi: true });
// Aspiring Champion & co.: "then shuffle the rest into your library"
on(/^(?:then )?shuffle the rest into your library$/, async (m, env) => {
  shuffle(env.me);
}, { first: true });
// Cavalier of Thorns: "put another target card from your graveyard on top of your library"
on(/^put (?:another )?target card from your graveyard on top of your library$/, async (m, env) => {
  const pool = cardsIn(env.me, 'graveyard').filter((c) => !env.src || c.iid !== env.src.iid);
  if (!pool.length) return env.did.push('has no card to put back');
  const [p] = await env.choosers[env.me].pickCards({ prompt: 'Put a card from your graveyard on top of your library', cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'recur', src: env.src, aiScore: (c) => (isLand(c) ? 0 : DB[c.def].cmc || 0) });
  if (!p) return;
  move(p, 'library');
  env.did.push(`puts ${nameTag(card(p))} on top of the library`);
}, { first: true });
// Clone Legion: "For each creature target player controls, create a token that's a copy of that creature."
on(/^for each creature target player controls, create a token that's a copy of that creature$/, async (m, env) => {
  const [pid] = await playerTarget(env, 'target player', false);
  if (!pid) return;
  const made = [];
  for (const c of cardsIn(pid, 'battlefield').filter(isCreature)) made.push(...createToken(c.def, env.me, 1));
  env.them_ = made;
  env.did.push(`creates ${made.length} token cop${made.length === 1 ? 'y' : 'ies'}`);
}, { first: true });
// Benevolent Offering, Bloodroot Apothecary: "You and that player each create …", "you and target opponent each create a Treasure token"
on(/^you and (that player|target opponent|that opponent) each create (.+)$/, async (m, env) => {
  const o = m[1] === 'target opponent' ? (await playerTarget(env, 'target opponent'))[0] : env.thatPlayer || opp(env.me);
  await runSentence(`create ${m[2]}`, env);
  if (o) await runSentence(`create ${m[2]}`, { ...env, me: o });
}, { first: true });
// Determined Iteration: "The token created this way gains haste."
on(/^the tokens? created this way gains? haste$/, async (m, env) => {
  const ids = (env.made || env.them_ || []).filter((i) => card(i));
  for (const i of ids) card(i).eotGrants = [...(card(i).eotGrants || []), 'haste'];
  if (/sacrifice it at the beginning of the next end step/i.test(env.text || '')) for (const i of ids) card(i).endOfTurn = 'sacrifice';
}, { first: true });
// Devilish Valet: "double ~'s power until end of turn"
on(/^double (~'s|its|target creature's|that creature's) power until end of turn$/, async (m, env) => {
  const c = /^~/.test(m[1]) ? env.src && card(env.src.iid) : /target/.test(m[1]) ? (await objects(env, 'target creature', { harm: false }))[0] : env.it && env.it.iid && card(env.it.iid);
  if (!c || c.zone !== 'battlefield') return;
  const p = Math.max(0, power(c));
  pumpEOT(c, { p, t: 0 });
  env.did.push(`${nameTag(c)}'s power doubles to ${p * 2}`);
}, { first: true });
// Endurance: "up to one target player puts all the cards from their graveyard on the bottom of their library in a random order"
on(/^(?:up to one )?target player puts all the cards from their graveyard on the bottom of their library in a random order$/, async (m, env) => {
  const [pid] = await playerTarget(env, 'target player');
  if (!pid) return;
  const ids = zoneOf(pid, 'graveyard').slice().sort(() => Math.random() - 0.5);
  for (const i of ids) move(i, 'library', { to: 'bottom' });
  env.did.push(`${who(pid)} ${s_(pid, 'put')} ${ids.length} card${ids.length === 1 ? '' : 's'} from the graveyard on the bottom of the library`);
}, { first: true });
on(/^bolster (\w+)/, async (m, env) => {
  const cs = cardsIn(env.me, 'battlefield').filter(isCreature).sort((a, b) => toughness(a) - toughness(b));
  if (!cs.length) return;
  const k = n(m[1], env.x);
  addCounters(cs[0], '+1/+1', k);
  env.did.push(`bolsters ${k} onto ${nameTag(cs[0])}`);
});
on(/^support (\w+)/, async (m, env) => {
  const k = n(m[1], env.x);
  const cs = cardsIn(env.me, 'battlefield').filter((c) => isCreature(c) && c.iid !== env.src.iid);
  const picks = cs.length ? await env.choosers[env.me].pickCards({ prompt: `Support ${k}: put a +1/+1 counter on up to ${k} other creatures`, cards: cs.map((c) => c.iid), min: 0, max: k, purpose: 'support', src: env.src, aiScore: cardValue }) : [];
  picks.forEach((i) => addCounters(card(i), '+1/+1', 1));
  env.did.push(`supports ${picks.length}`);
});
on(/^adapt (\w+)/, async (m, env) => {
  const k = n(m[1], env.x);
  if ((env.src.counters || {})['+1/+1']) return env.did.push(`can't adapt (already has +1/+1 counters)`);
  addCounters(env.src, '+1/+1', k);
  queueEvent({ type: 'adapted', iid: env.src.iid, controller: env.me });
  env.did.push(`adapts ${k}`);
});
on(/^monstrosity (\w+)/, async (m, env) => {
  if (env.src.monstrous) return env.did.push('is already monstrous');
  const k = n(m[1], env.x);
  addCounters(env.src, '+1/+1', k);
  env.src.monstrous = true;
  queueEvent({ type: 'monstrous', iid: env.src.iid, controller: env.me });
  env.did.push(`becomes monstrous (${k} counters)`);
});

// --- pumps, keyword grants, base P/T
on(/^(.+?) gets? ([+-]\d+|[+-]x)\/([+-]\d+|[+-]x)(?: and gains? ([^.]+?))?(?: for each ([^.]+?))? until (?:end of turn|your next turn)/, async (m, env) => {
  // "Creatures you control gain trample and get +X/+X until end of turn" (Craterhoof Behemoth)
  const gm = m[1].match(/^(.+?) gains? ([a-z ,]+?) and$/);
  if (gm) {
    m = [...m];
    m[1] = gm[1];
    m[4] = m[4] ? gm[2] + ', ' + m[4] : gm[2];
  }
  const objs = await objects(env, m[1], { harm: /^-/.test(m[2]) || /^-/.test(m[3]) });
  let mult = 1;
  if (m[5]) mult = countPhrase(env.me, m[5], helpers, env.src.iid) || 0;
  const p = (m[2].includes('x') ? (m[2][0] === '-' ? -1 : 1) * (env.x || 0) : +m[2]) * mult;
  const t = (m[3].includes('x') ? (m[3][0] === '-' ? -1 : 1) * (env.x || 0) : +m[3]) * mult;
  const nextTurn = /until your next turn/.test(env.sentence);
  for (const c of objs) {
    pumpEOT(c, { p, t, grants: kwList(m[4]) });
    if (nextTurn) c.ntTurn = G.s.turn + 1;
  }
  if (objs.length) env.did.push(`${objs.length > 2 ? objs.length + ' creatures get' : objs.map(nameTag).join(', ') + ' get' + (objs.length === 1 ? 's' : '')} ${p >= 0 ? '+' : ''}${p}/${t >= 0 ? '+' : ''}${t}${m[4] ? ' and ' + m[4] : ''} until ${nextTurn ? 'your next turn' : 'end of turn'}`);
});
// "It gains haste." (no duration: for as long as it stays)
on(/^(it|that creature|they|those creatures|those tokens|that token|the token|the tokens) gains? (?!.*\buntil\b)([a-z, ]+?)$/, async (m, env) => {
  const objs = await objects(env, m[1].replace(/^the tokens?$/, 'them'), { harm: false });
  const grants = kwList(m[2]);
  if (!grants.length) return env.unknown.push(env.sentence);
  for (const c of objs) c.grants = [...(c.grants || []), ...grants];
  if (objs.length) env.did.push(`${objs.map(nameTag).join(', ')} gain${objs.length === 1 ? 's' : ''} ${grants.join(', ')}`);
});
on(/^(.+?) gains? ([a-z, ]+?|protection from (?:the color of your choice|[a-z]+)|hexproof from [a-z]+) until (?:end of turn|your next turn)/, async (m, env) => {
  if (/ gets? /.test(m[1])) return;
  const objs = await objects(env, m[1], { harm: false });
  let grants = kwList(m[2]);
  if (/color of your choice/.test(m[2])) {
    const k = await env.choosers[env.me].choose({ prompt: 'Choose a color', options: ['white', 'blue', 'black', 'red', 'green'].map((x) => ({ label: x })), aiPick: () => 2 });
    grants = ['protection from ' + ['white', 'blue', 'black', 'red', 'green'][k]];
  }
  const nextTurn = /until your next turn/.test(env.sentence);
  for (const c of objs) {
    c.eotGrants = [...(c.eotGrants || []), ...grants];
    if (nextTurn) c.ntTurn = G.s.turn + 1;
  }
  if (objs.length) env.did.push(`${objs.length > 2 ? objs.length + ' creatures gain' : objs.map(nameTag).join(', ') + ' gain' + (objs.length === 1 ? 's' : '')} ${grants.join(', ')} until ${nextTurn ? 'your next turn' : 'end of turn'}`);
});
// Metamorphic Blast: "Until end of turn, target creature becomes a white Rabbit with base power and toughness 0/1."
on(/^(?:until end of turn, )?(target creature|it|that creature|~) becomes an? ([a-z ]+?) with base power and toughness (\d+)\/(\d+)(?: until end of turn)?(?: and gains ([a-z, ]+?))?$/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: +m[3] < 3 });
  const words = m[2].trim().split(/\s+/);
  const col = COLOR_WORD[words[0]] !== undefined || words[0] === 'colorless' ? words.shift() : null;
  for (const c of objs) {
    c.setPT = { ts: nextStamp(), p: +m[3], t: +m[4] };
    if (/until end of turn/.test(env.sentence)) c.setPTUntil = 'eot';
    // "becomes a white Rabbit": its color and creature type change too
    addLayerFx(c, { until: /until end of turn/.test(env.sentence) ? 'eot' : true, types: { subSet: capWords(words.join(' ')) }, ...(col ? { colors: { set: col === 'colorless' ? [] : [COLOR_WORD[col]] } } : {}) });
    // Nogi: "… and gains flying"
    if (m[5]) {
      const kws = kwList(m[5]);
      if (/until end of turn/.test(env.sentence)) c.eotGrants = [...(c.eotGrants || []), ...kws];
      else c.grants = [...(c.grants || []), ...kws];
    }
  }
  env.did.push(`${objs.map(nameTag).join(', ')} becomes a ${m[3]}/${m[4]} ${m[2]}${m[5] ? ' with ' + m[5] : ''}`);
}, { first: true });
// Legion Warboss: "That token gains haste until end of turn and attacks this combat if able."
on(/^(that token|those tokens|that creature|it|target creature(?: you control)?)( gains haste until end of turn and)? attacks? this combat if able$/, async (m, env) => {
  const objs = /^target/.test(m[1]) ? await objects(env, m[1], { harm: false }) : (/those/.test(m[1]) && env.them_ ? env.them_ : env.it && env.it.iid ? [env.it.iid] : env.made || []).map((i) => (typeof i === 'object' ? i : card(i))).filter(Boolean);
  for (const c of objs) {
    if (m[2]) c.eotGrants = [...(c.eotGrants || []), 'haste'];
    c.mustAttackTurn = G.s.turn;
  }
  if (objs.length) env.did.push(`${objs.map(nameTag).join(', ')}${m[2] ? ' gains haste and' : ''} must attack this combat`);
}, { first: true });
// Edgar Markov's Coffin: "create a 1/1 … token with lifelink and put a bloodline counter on ~"
on(/^(create .+?) and put an? ([a-z+\/0-9-]+) counter on ~$/, async (m, env) => {
  await runSentence(m[1], env);
  const me = env.src && card(env.src.iid);
  if (me && me.zone === 'battlefield') {
    addCounters(me, m[2], 1);
    env.did.push(`puts a ${m[2]} counter on ${nameTag(me)}`);
  }
}, { first: true });
// "… remove those counters and transform it"
on(/^remove those counters and transform (?:it|~)$/, async (m, env) => {
  const me = env.src && card(env.src.iid);
  const k = env.prevSent && (env.prevSent.match(/([a-z+\/0-9-]+) counters? on (?:it|~)/i) || [])[1];
  const kind = (env.sentence.match(/there are \w+ or more ([a-z+\/0-9-]+) counters/i) || [])[1] || k;
  if (!me || me.zone !== 'battlefield') return;
  if (kind && me.counters) delete me.counters[kind.toLowerCase()];
  if (DB[me.def].faces.length > 1) {
    const before = nameTag(me);
    me.face = me.face ? 0 : 1;
    queueEvent({ type: 'transformed', iid: me.iid, controller: me.controller });
    env.did.push(`removes the counters; ${before} transforms into ${nameTag(me)}`);
  }
}, { first: true });
// Leyline Tyrant: "you may pay any amount of {R}. When you do, it deals that much damage to any target."
on(/^(?:you may )?pay any amount of \{([wubrgc])\}$/, async (m, env) => {
  const col = m[1].toUpperCase();
  env.lastMay = false;
  if (!castMod) return;
  let max = 0;
  while (max < 30 && payCost(`{${col}}`.repeat(max + 1), castMod.manaSources(env.me))) max++;
  if (!max) return env.did.push(`has no {${col}} to pay`);
  let k = max;
  if (env.me === 'p') k = await env.choosers.p.chooseNumber({ prompt: `${cardName(env.src)}: pay how much {${col}}? (0–${max})`, min: 0, max, ai: max });
  k = Math.max(0, Math.min(max, +k || 0));
  if (!k) return env.did.push('pays nothing');
  const paid = T && T.payMana ? await T.payMana(env.me, `{${col}}`.repeat(k), cardName(env.src)) : false;
  if (!paid) return env.did.push('pays nothing');
  env.lastMay = true;
  env.lastAmount = env.thatMuch = k;
  env.did.push(`pays {${col}}×${k}`);
}, { first: true });
// Karn, Living Legacy −1: "Pay any amount of mana. Look at that many cards from the top of your library, …"
on(/^(?:you may )?pay any amount of mana$/, async (m, env) => {
  env.lastMay = false;
  if (!castMod) return;
  let max = 0;
  while (max < 30 && payCost(`{${max + 1}}`, castMod.manaSources(env.me))) max++;
  if (!max) { env.lastAmount = env.thatMuch = 0; return env.did.push('has no mana to pay'); }
  let k = await env.choosers[env.me].chooseNumber({ prompt: `${cardName(env.src)}: pay how much mana? (0–${max})`, min: 0, max, ai: Math.min(max, 6) });
  k = Math.max(0, Math.min(max, +k || 0));
  env.lastAmount = env.thatMuch = 0;
  if (!k) return env.did.push('pays nothing');
  const paid = T && T.payMana ? await T.payMana(env.me, `{${k}}`, cardName(env.src)) : false;
  if (!paid) return env.did.push('pays nothing');
  env.lastMay = true;
  env.lastAmount = env.thatMuch = k;
  env.did.push(`pays {${k}}`);
}, { first: true });
// the second half of "look at that many cards …, then put one of those cards into your hand and the rest on the bottom" (done by the look)
on(/^put one of (?:those cards|them) into your hand and the rest on the bottom of your library in (?:a random|any) order$/, async () => {}, { first: true });
// Realms Uncharted, Gifts Ungiven: "Search your library for up to four [land] cards with different names and reveal them.
// An opponent chooses two of those cards. Put the chosen cards into your graveyard and the rest into your hand. Then shuffle."
on(/^search your library for up to (\w+) (land |creature |nonland )?cards with different names and reveal them\. (an opponent|target opponent) chooses (\w+) of those cards\. put the chosen cards into your graveyard and the rest into your hand(?:\. then shuffle)?$/, async (m, env) => {
  const k = n(m[1]);
  const pick = n(m[4]);
  const kind = (m[2] || '').trim();
  const lib = zoneOf(env.me, 'library').map(card).filter((c) => !kind || matchesFilter(c, kind));
  const names = (ids) => new Set(ids.map((i) => DB[card(i).def].name)).size === ids.length;
  let found = await env.choosers[env.me].pickCards({
    prompt: `Search for up to ${k} ${kind ? kind + ' ' : ''}cards with different names`, cards: lib.map((c) => c.iid), min: 0, max: Math.min(k, lib.length), purpose: kind === 'land' ? 'land' : 'tutor', src: env.src,
    validate: (ids) => (names(ids) ? '' : 'They must all have different names.'),
    aiScore: (c) => (isAI(env.me) ? (kind === 'land' ? aiHelpers.landScore(c) : DB[c.def].cmc || 0) : 0),
  });
  // the AI's pick (or an old dialog) with a repeated name: keep the first of each name
  const seen = new Set();
  found = found.filter((i) => { const nm = DB[card(i).def].name; if (seen.has(nm)) return false; seen.add(nm); return true; });
  shuffle(env.me);
  if (!found.length) return env.did.push('finds nothing');
  const opps = opponents(env.me).filter(inGame);
  const chooser = m[3] === 'target opponent' ? (await playerTarget(env, 'target opponent'))[0] || opps[0] : opps.length === 1 ? opps[0] : opps[0];
  const toGy = found.length <= pick ? found.slice() : await env.choosers[chooser].pickCards({
    forced: true, prompt: `${cardName(env.src)}: choose ${pick} of these to go to ${env.me === 'p' ? 'your' : seatName(env.me) + "'s"} graveyard (the rest go to ${env.me === 'p' ? 'your' : 'their'} hand)`,
    cards: found, min: pick, max: pick, purpose: 'giftsGy', src: env.src,
    // the opponent bins the best ones
    aiScore: (c) => (isLand(c) ? aiHelpers.landScore({ ...c, controller: env.me }) : DB[c.def].cmc || 0),
  });
  for (const i of found) move(i, toGy.includes(i) ? 'graveyard' : 'hand');
  env.did.push(`reveals ${found.map((i) => nameTag(card(i))).join(', ')}; ${who(chooser)} ${s_(chooser, 'put')} ${toGy.map((i) => nameTag(card(i))).join(' and ')} into the graveyard`);
}, { first: true, multi: true });
// Hildibrand Manderville: "you may cast it from your graveyard as an Adventure until the end of your next turn"
on(/^(?:you may )?cast (?:it|~) from your graveyard as an adventure until the end of your next turn$/, async (m, env) => {
  const c = env.src && card(env.src.iid);
  if (!c || c.zone !== 'graveyard') return env.did.push('is no longer in the graveyard');
  c.advFromGyUntil = G.s.active === env.me ? G.s.turn + 2 : G.s.turn + 1;
  c.advFromGyBy = env.me;
  env.did.push(`${nameTag(c)} can be cast as an Adventure from the graveyard until the end of ${who(env.me) === 'you' ? 'your' : "the AI's"} next turn`);
}, { first: true });
// Rabid Attack: "Until end of turn, any number of target creatures you control each get +1/+0 and gain "When this creature dies, draw a card.""
on(/^(?:until end of turn, )?((?:any number of |up to \w+ )?target creatures?(?: you control)?) (?:each )?gets? ([+-]\d+)\/([+-]\d+) and gains? "(.+)"(?: until end of turn)?$/, async (m, env) => {
  const raw = (env.sentence.match(/"(.+)"/) || [])[1] || m[4];
  const objs = await objects(env, m[1], { harm: false });
  for (const c of objs) {
    pumpEOT(c, { p: +m[2], t: +m[3] });
    c.eotText = (c.eotText ? c.eotText + '\n' : '') + raw;
  }
  env.did.push(objs.length ? `${objs.map(nameTag).join(', ')} get${objs.length === 1 ? 's' : ''} ${m[2]}/${m[3]} and “${raw}” until end of turn` : 'no creatures chosen');
}, { first: true });
// Trash the Town: "Until end of turn, target creature gains "Whenever this creature deals combat damage to a player, draw two cards.""
on(/^(?:until end of turn, )?(target creature(?: you control)?|it|that creature|~) gains "(.+)"(?: until end of turn)?$/, async (m, env) => {
  const raw = (env.sentence.match(/"(.+)"/) || [])[1] || m[2];
  const objs = await objects(env, m[1], { harm: false });
  const eot = /until end of turn/i.test(env.sentence);
  for (const c of objs) {
    if (eot) c.eotText = (c.eotText ? c.eotText + '\n' : '') + raw;
    else c.extraText = (c.extraText ? c.extraText + '\n' : '') + raw;
  }
  env.did.push(`${objs.map(nameTag).join(', ')} gains “${raw}”${eot ? ' until end of turn' : ''}`);
}, { first: true });
// Final Showdown: "Choose a creature you control. It gains indestructible until end of turn." (chosen, not targeted)
on(/^choose (?:a|an|one) ([a-z ]+?) you control$/, async (m, env) => {
  const pool = cardsIn(env.me, 'battlefield').filter((c) => matchesFilter(c, m[1]));
  if (!pool.length) {
    env.it = null;
    return env.did.push(`has no ${m[1]} to choose`);
  }
  const [pick] = await env.choosers[env.me].pickCards({ forced: true, prompt: `Choose a ${m[1]} you control`, cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'choose', src: env.src, aiScore: (c) => cardValue(c) });
  env.it = pick ? { iid: pick } : null;
  if (pick) env.did.push(`chooses ${nameTag(card(pick))}`);
});
on(/^(.+?) (?:has|have) base power and toughness (\d+)\/(\d+)(?: until end of turn)?/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: +m[2] < 3 });
  for (const c of objs) {
    c.setPT = { ts: nextStamp(), p: +m[2], t: +m[3] };
    if (/until end of turn/.test(env.sentence)) c.setPTUntil = 'eot';
  }
  env.did.push(`sets base P/T to ${m[2]}/${m[3]}`);
});
// ---- layered changes on one permanent (types, colors, abilities, base P/T), timestamped
const COLOR_WORD = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
function addLayerFx(c, fx) {
  c.layerFx = [...(c.layerFx || []), { ts: nextStamp(), ...fx }];
}
const capWords = (w) => w.split(/\s+/).filter(Boolean).map((x) => x[0].toUpperCase() + x.slice(1)).join(' ');
// Turn to Frog: "Until end of turn, target creature loses all abilities and becomes a blue Frog with base power and toughness 1/1."
on(/^(?:until end of turn, )?(target creature|it|that creature|enchanted creature) loses all abilities and becomes an? (white |blue |black |red |green |colorless )?([a-z -]+?) with base power and toughness (\d+)\/(\d+)( until end of turn)?$/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: true });
  const eot = /until end of turn/.test(env.sentence);
  for (const c of objs) {
    addLayerFx(c, {
      until: eot ? 'eot' : true, loseAll: true, base: { p: +m[4], t: +m[5] },
      types: { subSet: capWords(m[3]) },
      ...(m[2] ? { colors: { set: m[2].trim() === 'colorless' ? [] : [COLOR_WORD[m[2].trim()]] } } : {}),
    });
  }
  env.did.push(`${objs.map(nameTag).join(', ')} becomes a ${m[2] || ''}${m[3]} ${m[4]}/${m[5]} with no abilities${eot ? ' until end of turn' : ''}`);
}, { first: true });
// Ovinize: "Until end of turn, target creature loses all abilities and has base power and toughness 0/1."
on(/^(?:until end of turn, )?(target creature|it|that creature) loses all abilities and has base power and toughness (\d+)\/(\d+)( until end of turn)?$/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: true });
  const eot = /until end of turn/.test(env.sentence);
  for (const c of objs) addLayerFx(c, { until: eot ? 'eot' : true, loseAll: true, base: { p: +m[2], t: +m[3] } });
  env.did.push(`${objs.map(nameTag).join(', ')} loses all abilities and becomes ${m[2]}/${m[3]}${eot ? ' until end of turn' : ''}`);
}, { first: true });
// "Target creature becomes black until end of turn." / "becomes colorless" / "becomes the color of your choice" (Distorting Lens)
on(/^(?:until end of turn, )?(target [a-z ]+?|it|that creature|~) becomes (white|blue|black|red|green|colorless|the color of your choice|the colors? of your choice)( until end of turn)?$/, async (m, env) => {
  const objs = /^~$/.test(m[1]) ? [card(env.src.iid)].filter(Boolean) : await objects(env, m[1], { harm: false });
  let col = m[2];
  if (/choice/.test(col)) {
    const names = ['white', 'blue', 'black', 'red', 'green'];
    const k = await env.choosers[env.me].choose({ prompt: `${cardName(env.src)}: choose a color`, options: names.map((x) => ({ label: x })), aiPick: () => 2 });
    col = names[k] || 'black';
  }
  const eot = /until end of turn/.test(env.sentence);
  for (const c of objs) addLayerFx(c, { until: eot ? 'eot' : true, colors: { set: col === 'colorless' ? [] : [COLOR_WORD[col]] } });
  env.did.push(`${objs.map(nameTag).join(', ')} becomes ${col}${eot ? ' until end of turn' : ''}`);
}, { first: true });
// Layer 7d: "Switch target creature's power and toughness until end of turn." (applied after every other P/T effect)
on(/^switch its power and toughness(?: until end of turn)?$/, async (m, env) => {
  const c = env.it && card(env.it.iid) ? card(env.it.iid) : env.src && card(env.src.iid);
  if (!c) return;
  c.switchPT = /until end of turn/.test(env.sentence) ? 'eot' : true;
  env.did.push(`switches ${nameTag(c)}'s power and toughness`);
}, { first: true });
on(/^switch (.+?)(?:'s|') power and toughness(?: until end of turn)?$/, async (m, env) => {
  const objs = /^(?:~|this creature)$/.test(m[1]) ? [env.src && card(env.src.iid)].filter(Boolean) : await objects(env, m[1], { harm: true });
  for (const c of objs) c.switchPT = /until end of turn/.test(env.sentence) ? 'eot' : true;
  env.did.push(`switches ${objs.map(nameTag).join(', ')}'s power and toughness`);
}, { first: true });
on(/^(.+?) loses? all abilities(?: until end of turn)?/, async (m, env) => {
  const objs = await objects(env, m[1]);
  for (const c of objs) loseAllAbilities(c, /until end of turn/.test(env.sentence) ? 'eot' : true);
  env.did.push(`${objs.map(nameTag).join(', ')} lose${objs.length === 1 ? 's' : ''} all abilities`);
});
// Aragorn, King of Gondor: "creatures can't block this turn"
on(/^creatures can't block this turn$/, async (m, env) => {
  G.s.noBlocksTurn = G.s.turn;
  env.did.push("creatures can't block this turn");
}, { first: true });
on(/^(.+?) can't block this turn/, async (m, env) => {
  const objs = await objects(env, m[1]);
  objs.forEach((c) => (c.cantBlockTurn = G.s.turn));
  env.did.push(`${objs.length > 2 ? objs.length + ' creatures' : objs.map(nameTag).join(', ')} can't block this turn`);
});
on(/^(.+?) can't be blocked this turn/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: false });
  const ex = env.sentence.match(/except by creatures with ([a-z ]+?)\.?$/i);
  objs.forEach((c) => {
    c.unblockableTurn = G.s.turn;
    c.unblockableExcept = ex ? ex[1].toLowerCase() : null;
  });
  env.did.push(`${objs.map(nameTag).join(', ')} can't be blocked this turn${ex ? ' except by creatures with ' + ex[1].toLowerCase() : ''}`);
});
on(/^(.+?) (can't attack or block|can't block|can't attack)(?:,? and its activated abilities can't be activated)? until your next turn/, async (m, env) => {
  const objs = await objects(env, m[1]);
  objs.forEach((c) => {
    if (m[2] === "can't attack or block") c.detainedUntil = nextTurnNumber(env.me);
    else if (m[2] === "can't attack") c.noAttackUntil = nextTurnNumber(env.me);
    else c.noBlockUntil = nextTurnNumber(env.me);
  });
  if (objs.length) env.did.push(`${objs.map(nameTag).join(', ')} ${m[2]} until your next turn`);
});
on(/^damage can't be prevented this turn/, async (m, env) => {
  G.s.noPreventTurn = G.s.turn;
  env.did.push("damage can't be prevented this turn");
});
on(/^detain (.+)$/, async (m, env) => {
  const objs = await objects(env, m[1]);
  objs.forEach((c) => (c.detainedUntil = nextTurnNumber(env.me)));
  env.did.push(`detains ${objs.map(nameTag).join(', ')}`);
});
on(/^goad (.+)$/, async (m, env) => {
  const objs = await objects(env, m[1]);
  objs.forEach((c) => goad(c, env.me, multiplayer() ? goadUntil(env.me) : nextTurnNumber(env.me)));
  if (objs.length) env.did.push(`goads ${objs.map(nameTag).join(', ')}`);
});
on(/^suspect (.+)$/, async (m, env) => {
  const objs = await objects(env, m[1]);
  objs.forEach((c) => {
    c.suspected = true;
    c.grants = [...(c.grants || []), 'menace'];
  });
  env.did.push(`suspects ${objs.map(nameTag).join(', ')}`);
});

// --- tap / untap / phasing / stun
on(/^(tap|untap) (.+?)(?:\. (?:it|that creature|they) (?:doesn't|don't) untap during (?:its|their) controllers?'? next untap steps?)?$/, async (m, env) => {
  const objs = await objects(env, m[2], { harm: m[1] === 'tap' });
  const freeze = /doesn't untap|don't untap/.test(env.sentence);
  for (const c of objs) {
    if (m[1] === 'tap') tapPerm(c); else c.tapped = false;
    if (freeze) c.noUntapUntil = G.s.turn + (c.controller === G.s.active ? 3 : 2);
  }
  if (objs.length) env.did.push(`${m[1]}s ${objs.length > 3 ? objs.length + ' permanents' : objs.map(nameTag).join(', ')}`);
});
on(/^(.+?) (?:doesn't|don't) untap during (?:its|their) controllers?'? next untap steps?/, async (m, env) => {
  const objs = await objects(env, m[1]);
  objs.forEach((c) => (c.noUntapUntil = G.s.turn + (c.controller === G.s.active ? 3 : 2)));
});
on(/^(.+?) phases? out/, async (m, env) => {
  const until = /until ~ leaves the battlefield/.test(env.sentence);
  const harm = until || /you don't control|an opponent controls|your opponents control/.test(m[1]);
  const objs = await objects(env, m[1], { harm });
  objs.forEach((c) => {
    c.phasedOut = true;
    // Oubliette: stays phased out until the source leaves, then phases in tapped
    if (until && env.src) {
      c.phasedUntil = env.src.iid;
      c.phaseInTapped = /tap that creature as it phases in/i.test(env.text || '');
    }
    for (const a of Object.values(G.s.cards)) if (a.attachedTo === c.iid) a.phasedOut = true;
  });
  env.did.push(`${objs.map(nameTag).join(', ')} phase${objs.length === 1 ? 's' : ''} out`);
});
on(/^regenerate (.+)$/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: false });
  objs.forEach((c) => (c.regen = (c.regen || 0) + 1));
  env.did.push(`regeneration shield on ${objs.map(nameTag).join(', ')}`);
});
on(/^transform (~|it|target [^.]+)/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: false });
  for (const c of objs) {
    if (DB[c.def].faces.length < 2) continue;
    const before = nameTag(c);
    c.face = c.face ? 0 : 1;
    queueEvent({ type: 'transformed', iid: c.iid, controller: c.controller });
    env.did.push(`${before} transforms into ${nameTag(c)}`);
  }
});
on(/^convert (~|it)/, async (m, env) => {
  const c = env.src;
  if (DB[c.def].faces.length < 2) return;
  c.face = c.face ? 0 : 1;
  env.did.push(`converts into ${nameTag(c)}`);
});
on(/^turn (~|it|target [^.]+) face (up|down)/, async (m, env) => {
  const objs = await objects(env, m[1]);
  objs.forEach((c) => (c.faceDown = m[2] === 'down'));
  env.did.push(`turns ${objs.length} card${objs.length === 1 ? '' : 's'} face ${m[2]}`);
});

// --- control
on(/^gain control of (.+?)(?: until end of turn| until your next turn)?(?:\. untap (?:it|that creature)\. it gains haste until end of turn)?$/, async (m, env) => {
  const whileM = m[1].match(/ for as long as (?:~ remains on the battlefield|you control ~)$/);
  const objs = await objects(env, whileM ? m[1].slice(0, whileM.index) : m[1]);
  const temp = /until end of turn/.test(env.text);
  for (const c of objs) {
    const prev = c.controller;
    move(c.iid, 'battlefield', { controller: env.me });
    c.zone = 'battlefield';
    if (/untap/.test(env.text)) c.tapped = false;
    if (/haste/.test(env.text)) c.eotGrants = [...(c.eotGrants || []), 'haste'];
    if (temp) G.s.delayed.push({ at: 'cleanup', kind: 'returnControl', iid: c.iid, pid: prev });
    if (whileM && env.src) c.controlWhile = { src: env.src.iid, prev, by: env.me, youControl: /you control/.test(whileM[0]) };
    env.did.push(`gains control of ${nameTag(c)}${temp ? ' until end of turn' : ''}`);
  }
});
// Hithlain Rope: "The player to your right gains control of ~." (two players: your opponent)
on(/^the player to your (?:right|left) gains control of (~|it|this [a-z]+)$/, async (m, env) => {
  const c = env.src && card(env.src.iid);
  if (!c || c.zone !== 'battlefield') return;
  const to = /left/.test(m[0]) ? leftOf(c.controller) : rightOf(c.controller); // in 1v1 both are the opponent
  move(c.iid, 'battlefield', { controller: to });
  c.zone = 'battlefield';
  env.did.push(`${who(to)} ${s_(to, 'gain')} control of ${nameTag(c)}`);
}, { first: true });
on(/^exchange control of (.+)$/, async (m, env) => {
  const objs = await objects(env, m[1].replace(/^(?:target|two target)/, 'two target').replace(/ and /, ' and '));
  if (objs.length === 2) {
    const [a, b] = objs;
    const ca = a.controller;
    const cb = b.controller;
    move(a.iid, 'battlefield', { controller: cb });
    move(b.iid, 'battlefield', { controller: ca });
    env.did.push(`exchanges control of ${nameTag(a)} and ${nameTag(b)}`);
  }
});

// --- sacrifice
on(/^(each opponent|target opponent|target player|each player|that player|defending player|you|its controller) sacrifices? (a|an|one|two|three|x|\d+|all|half the) ([^.]+?)(?: of (?:their|his or her) choice)?(?:\.|$| for each)/, async (m, env) => {
  const pids = await playerTarget(env, m[1]);
  for (const pid of pids) {
    // All Is Dust: "all permanents they control that are one or more colors"
    const colored = / that are one or more colors$| that are colored$/.test(m[3]) ? 'colored' : / that are colorless$/.test(m[3]) ? 'colorless' : null;
    let kindPhrase = m[3].replace(/ that are (?:one or more colors|colored|colorless)$/, '').replace(/ they control$| you control$/, '').replace(/s$/, '');
    // Consumed by Greed: "a creature with the greatest power among creatures they control"
    const ext = kindPhrase.match(/^(.+?) with the (greatest|highest|least|lowest) (power|toughness|mana value)(?: among [^.]+)?$/);
    if (ext) kindPhrase = ext[1];
    let pool = cardsIn(pid, 'battlefield').filter((c) => matchesAny(c, kindPhrase || 'permanent') && (!colored || (colored === 'colored' ? colorsOf(c).length > 0 : colorsOf(c).length === 0)));
    if (ext && pool.length) {
      const val = (c) => (ext[3] === 'power' ? power(c) : ext[3] === 'toughness' ? toughness(c) : DB[c.def].cmc || 0);
      const best = /greatest|highest/.test(ext[2]) ? Math.max(...pool.map(val)) : Math.min(...pool.map(val));
      pool = pool.filter((c) => val(c) === best);
    }
    if (!pool.length) {
      env.couldntSac = [...(env.couldntSac || []), pid];
      continue;
    }
    let k = m[2] === 'all' ? pool.length : /half/.test(m[2]) ? Math.ceil(pool.length / 2) : n(m[2], env.x);
    k = Math.min(k, pool.length);
    const picks = k === pool.length ? pool.map((c) => c.iid) : await env.choosers[pid].pickCards({
      forced: true, prompt: `Choose ${k === 1 ? 'a' : k} ${kindPhrase} to sacrifice`, cards: pool.map((c) => c.iid), min: k, max: k,
      purpose: 'sacrifice', src: env.src, aiScore: (c) => -cardValue(c),
    });
    for (const i of picks) {
      const c = card(i);
      env.did.push(`${who(pid)} ${s_(pid, 'sacrifice')} ${nameTag(c)}`);
      env.it = { iid: i, power: power(c) };
      env.lastAmount = power(c);
      sacrifice(i);
    }
  }
});
on(/^shuffle(?: your library)?$/, async (m, env) => {
  shuffle(env.me);
});
// "Sacrifice another creature or artifact", "sacrifice two lands" (you choose)
on(/^sacrifice (a|an|another|one|two|three|x|\d+) ([^.]+?)$/, async (m, env) => {
  const kind = m[2].replace(/ you control$/, '');
  const pool = cardsIn(env.me, 'battlefield').filter((c) => (m[1] !== 'another' || c.iid !== env.src.iid) && matchesAny(c, kind));
  const k = Math.min(m[1] === 'another' ? 1 : n(m[1], env.x), pool.length);
  if (!k) {
    env.lastMay = false;
    return;
  }
  const picks = await env.choosers[env.me].pickCards({
    forced: true, prompt: `Sacrifice ${k === 1 ? 'a' : k} ${kind}`, cards: pool.map((c) => c.iid), min: k, max: k, purpose: 'sacrifice', src: env.src,
    aiScore: (c) => -cardValue(c) + (c.token ? 3 : 0),
  });
  for (const i of picks) {
    const c = card(i);
    env.did.push(`${who(env.me)} ${s_(env.me, 'sacrifice')} ${nameTag(c)}`);
    env.it = { iid: i, power: power(c) };
    env.lastAmount = power(c);
    sacrifice(i);
  }
  env.lastMay = picks.length > 0;
});
on(/^sacrifice (~|it|that creature|that token|them|enchanted creature|equipped creature)$/, async (m, env) => {
  const objs = (await objects(env, m[1])).filter((c) => c && c.zone === 'battlefield');
  objs.forEach((c) => {
    env.did.push(`sacrifices ${nameTag(c)}`);
    sacrifice(c.iid);
  });
  env.lastMay = objs.length > 0; // "Sacrifice it. If you do, …"
});

// "You may cast one of them without paying its mana cost" (Mad Wizard's Lair, Discover-like effects)
on(/^(?:you may )?cast (?:one|a spell|up to one|any number|any number of spells) (?:of them|from among them|of those cards)(?: [^.]*?)? without paying (?:its|their) mana costs?/, async (m, env) => {
  const many = /any number/.test(m[0]);
  const zone0 = new Map((env.them_ || []).map((i) => [i, card(i) && card(i).zone]));
  for (let k = 0; k < (many ? 20 : 1); k++) {
    // still where they were put (not cast yet)
    const pool = (env.them_ || []).map(card).filter((c) => c && ['hand', 'exile', 'library', 'graveyard'].includes(c.zone) && c.zone === zone0.get(c.iid) && !isLand(c));
    if (!pool.length || !(env.castFree || T.castFree)) return;
    const [pick] = await env.choosers[env.me].pickCards({ prompt: many ? 'Cast another of them without paying its mana cost?' : 'Cast one of them without paying its mana cost?', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => DB[c.def].cmc });
    if (!pick) return;
    env.did.push(`casts ${nameTag(card(pick))} for free`);
    zone0.set(pick, null);
    await (env.castFree || T.castFree)(env.me, pick, {});
  }
});
// Glorious Purpose: "...You may cast any number of spells from among them without paying their mana costs. Put the rest into your hand."
on(/^put the rest into your hand$/, async (m, env) => {
  const rest = (env.them_ || []).map(card).filter((c) => c && (c.zone === 'exile' || c.zone === 'library') && c.owner === env.me);
  for (const c of rest) move(c.iid, 'hand');
  env.did.push(`puts ${rest.length} card${rest.length === 1 ? '' : 's'} into hand`);
});
// "Reveal the top X cards of your library, where X is that spell's mana value." (Sunbird's Invocation)
on(/^(reveal|exile|look at) the top x cards? of your library, where x is (.+)$/, async (m, env) => {
  env.x = xFrom(m[2], env);
  const ids = libTop(env.me, env.x);
  if (m[1] === 'exile') for (const i of ids) move(i, 'exile');
  env.them_ = ids;
  env.revealed = ids;
  env.did.push(`${m[1] === 'look at' ? 'looks at' : m[1] + 's'} the top ${ids.length} card${ids.length === 1 ? '' : 's'}`);
});
// "You may cast a spell with mana value X or less from among cards revealed this way without paying its mana cost."
on(/^(?:you may )?cast (?:a|an|one|up to one) ?([a-z ]*?)(?:spell|card)(?: with mana value (x|\d+) or less)? from among (?:them|those cards|(?:the )?cards (?:revealed|exiled) this way)(?: with mana value (x|\d+) or less)? without paying its mana cost/, async (m, env) => {
  const capW = m[2] || m[3];
  const cap = capW ? (capW === 'x' ? env.x || 0 : +capW) : Infinity;
  const kind = (m[1] || '').trim();
  const pool = (env.them_ || []).map(card).filter((c) => c && ['exile', 'library', 'graveyard', 'hand'].includes(c.zone) && !isLand(c) && (DB[c.def].cmc || 0) <= cap && (!kind || matchesAny(c, kind)));
  if (!pool.length || !env.castFree) {
    env.lastMay = false;
    return;
  }
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Cast a spell${cap < Infinity ? ` with mana value ${cap} or less` : ''} without paying its mana cost?`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => DB[c.def].cmc });
  env.lastMay = !!pick;
  if (!pick) return;
  env.them_ = env.them_.filter((i) => i !== pick);
  env.did.push(`casts ${nameTag(card(pick))} for free`);
  await (env.castFree || T.castFree)(env.me, pick, {});
});
// Loki's Scepter: "Until end of turn, it becomes a Villain in addition to its other types and gains haste."
on(/^until end of turn, (it|~|that creature|target creature) becomes an? ([a-z][a-z ]*?) in addition to its other types(?: and gains ([a-z ]+))?$/, async (m, env) => {
  const [c] = await objects(env, m[1]);
  if (!c) return;
  const sub = m[2].split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  c.layerFx = [...(c.layerFx || []), { ts: nextStamp(), until: 'eot', types: { subAdd: sub } }];
  if (m[3]) c.eotGrants = [...(c.eotGrants || []), ...m[3].split(/,? and |, /).map((x) => x.trim())];
  env.did.push(`${nameTag(c)} becomes a ${sub}${m[3] ? ' and gains ' + m[3] : ''} until end of turn`);
}, { first: true });
// Will of the Jeskai: "Each player may discard their hand and draw five cards."
on(/^each player may discard their hand and draw (\w+) cards$/, async (m, env) => {
  const k = n(m[1], env.x);
  for (const pid of [env.me, ...opponents(env.me)]) {
    const hand = cardsIn(pid, 'hand');
    const lands = cardsIn(pid, 'battlefield').filter(isLand).length;
    const yes = isAI(pid)
      ? hand.length < k || hand.filter((c) => (isLand(c) ? lands >= 5 : (DB[c.def].cmc || 0) > lands + 2)).length * 2 >= hand.length
      : await env.choosers.p.confirm(cardName(env.src), `Discard your hand (${hand.length} card${hand.length === 1 ? '' : 's'}) and draw ${k}?`, {});
    if (!yes) {
      env.did.push(`${who(pid)} ${pid === 'p' ? 'keep' : 'keeps'} ${pid === 'p' ? 'your' : 'its'} hand`);
      continue;
    }
    for (const c of hand) discardCard(c.iid);
    draw(pid, k, true);
    env.did.push(`${who(pid)} ${s_(pid, 'discard')} ${hand.length} and ${s_(pid, 'draw')} ${k}`);
  }
}, { first: true });
// Curse of the Swine: "For each creature exiled this way, its controller creates a 2/2 green Boar creature token."
on(/^for each (?:creature|permanent) (?:exiled|destroyed) this way, its controller creates (.+? tokens?)$/, async (m, env) => {
  const gone = (env.exiledThisWay || env.them_ || []).map(card).filter(Boolean);
  const by = {};
  for (const c of gone) {
    const ctl = c.lastController || c.controller || c.owner;
    by[ctl] = (by[ctl] || 0) + 1;
  }
  for (const [pid, k] of Object.entries(by)) for (let i = 0; i < k; i++) await runSentence(`create ${m[1]}`, { ...env, me: pid, did: env.did });
}, { first: true });
// Killmonger: "that player sacrifices an artifact of their choice and you create a Treasure token"
on(/^((?:that|target|defending) player|each opponent|target opponent) (sacrifices|discards|exiles|mills|loses) (.+?) and you (create|draw|gain|put|scry|surveil) (.+)$/, async (m, env, raw) => {
  const at = raw.toLowerCase().indexOf(' and you ');
  await runSentence(raw.slice(0, at), env);
  await runSentence(raw.slice(at + 5), env);
}, { first: true });
// Transcendent Dragon: "When this creature enters, if you cast it, counter target spell. If that spell is countered this way,
// exile it instead of putting it into its owner's graveyard, then you may cast it without paying its mana cost."
on(/^if you cast it, (counter target .+)$/, async (m, env, raw) => {
  const src = (env.src && card(env.src.iid)) || env.src;
  if (!(env.castFrom || (src && src.castFrom))) return env.did.push("wasn't cast, so nothing is countered");
  await runSentence(raw.replace(/^if you cast it,\s*/i, ''), env);
}, { first: true });
on(/^if that spell is countered this way, exile it instead of putting it into its owner's graveyard, then you may cast it without paying its mana cost$/, async (m, env) => {
  const slot = [G.s.stack, G.s.pstack].find((x) => x && x.countered && env.it && x.iid === env.it.iid);
  if (!slot) return;
  slot.exileCountered = true;
  slot.stealCast = env.me; // cast.js casts it for us once it's in exile
  env.did.push('will exile it and may cast it for free');
}, { first: true });
// Living Laser: "for each card you've discarded this turn, create a token that's a copy of ~, except the token isn't legendary.
// The tokens enter tapped and attacking."
on(/^for each card you've discarded this turn, create a token that's a copy of ~(, except .+)?$/, async (m, env) => {
  const k = ((G.s.ts[env.me] || {}).discarded || []).length;
  if (!k) return env.did.push("hasn't discarded a card this turn");
  const attacking = /the tokens enter tapped and attacking/i.test(env.fullText || env.text || '');
  await runSentence(`create ${k} ${attacking ? 'tapped and attacking ' : ''}tokens that are copies of ~${m[1] || ''}`, env);
}, { first: true });
on(/^the tokens enter tapped and attacking$/, async () => {}, { first: true }); // done when they were made
// Lady Loki: "~ deals damage to each opponent equal to the difference between that spell's mana value and that nonland card's mana value"
on(/^~ deals damage to each opponent equal to the difference between that spell's mana value and that nonland card's mana value$/, async (m, env) => {
  const sp = env.event && env.event.iid && card(env.event.iid);
  const nl = env.it && env.it.iid && card(env.it.iid);
  if (!sp || !nl || nl.iid === sp.iid) return env.did.push('no difference to deal');
  const k = Math.abs((DB[sp.def].cmc || 0) - (DB[nl.def].cmc || 0));
  if (k > 0) await dealDamage(env, (env.src && card(env.src.iid)) || env.src, k, 'each opponent');
  else env.did.push('deals no damage (same mana value)');
}, { first: true });
on(/^it gains "(?:~|this permanent|this creature|this artifact) can't be sacrificed" until the end of your next turn$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  if (!c || c.zone !== 'battlefield') return;
  c.cantSacUntil = G.s.turn + (G.s.active === env.me ? 2 : 1);
  env.did.push(`${nameTag(c)} can't be sacrificed until the end of ${who(env.me) === 'you' ? 'your' : "the AI's"} next turn`);
}, { first: true });
// Glorious Purpose: "put a +1/+1 counter on that creature and a plan counter on ~"
on(/^put (a|an|one|two|three) ([^ ]+) counters? on (that creature|it|target creature you control) and (a|an|one|two|three) ([^ ]+) counters? on ~$/, async (m, env) => {
  await runSentence(`put ${m[1]} ${m[2]} counter${n(m[1]) > 1 ? 's' : ''} on ${m[3]}`, env);
  await runSentence(`put ${m[4]} ${m[5]} counter${n(m[4]) > 1 ? 's' : ''} on ~`, env);
}, { first: true });
// Transforming Flourish: "If that permanent is destroyed this way, its controller exiles cards from the top of their library until
// they exile a nonland card, then they may cast that card without paying its mana cost."
on(/^if that permanent is destroyed this way, its controller exiles cards from the top of their library until they exile a nonland card, then they may cast that card without paying its mana cost$/, async (m, env) => {
  const snap = (env.thisWay || [])[0];
  if (!snap) return env.did.push('nothing was destroyed');
  const pid = snap.controller;
  const lib = zoneOf(pid, 'library');
  let hit = null;
  let k = 0;
  while (lib.length && !hit) {
    const i = lib[lib.length - 1];
    move(i, 'exile');
    k++;
    if (!isLand(card(i))) hit = card(i);
  }
  env.did.push(`${who(pid)} ${s_(pid, 'exile')} ${k} card${k === 1 ? '' : 's'}${hit ? `, revealing ${nameTag(hit)}` : ''}`);
  if (!hit) return;
  const { T } = await import('./triggers.js');
  const yes = isAI(pid) || (await env.choosers.p.confirm(cardName(env.src), `Cast ${cardName(hit)} without paying its mana cost?`, {}));
  if (yes && T.castFree) await T.castFree(pid, hit.iid, {});
}, { first: true });
// Kang Dynasty: "Until your next turn, whenever any of those creatures deals combat damage to a player, draw a card."
on(/^until your next turn, whenever (?:any of those creatures|that creature|those creatures) deals? combat damage to a player, (draw a card|you draw a card)$/, async (m, env) => {
  const objs = (await objects(env, 'those creatures')).filter((c) => c && c.zone === 'battlefield');
  const until = G.s.turn + (G.s.active === env.me ? 2 : 1);
  for (const c of objs) c.dmgDraw = [...(c.dmgDraw || []), { pid: env.me, src: env.src && env.src.iid, until, text: 'Draw a card.' }];
  if (objs.length) env.did.push(`until ${seatPoss(env.me)} next turn, ${who(env.me)} ${s_(env.me, 'draw')} a card whenever ${objs.map(nameTag).join(' or ')} deals combat damage to a player`);
}, { first: true });
// Syphon Mind (two players: "each other player" is your opponent)
on(/^each other player (.+)$/, async (m, env) => runSentence(`each opponent ${m[1]}`, env));
// Baral's Expertise / Electrodominance: "You may cast a spell with mana value 4 (X) or less from your hand without paying its mana cost."
// Baral and Kari Zev: "you may cast a spell with lesser mana value that shares a card type with it from your hand without paying its mana cost"
const CARD_TYPES = ['artifact', 'creature', 'enchantment', 'instant', 'sorcery', 'planeswalker', 'battle', 'kindred'];
const cardTypesOfDef = (d) => CARD_TYPES.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(((d.faces && d.faces[0] && d.faces[0].typeLine) || d.typeLine || '').split('—')[0]));
on(/^(?:you may )?cast (?:a|an) ?([a-z ]*?)spell with (?:mana value (x|\d+|one|two|three|four|five|six) or less|lesser mana value(?: that shares a card type with it)?) from your hand without paying its mana cost$/, async (m, env) => {
  const it = env.it && env.it.iid ? card(env.it.iid) : null;
  const lesser = /lesser mana value/.test(m[0]);
  const cap = lesser ? (it ? (DB[it.def].cmc || 0) - 1 : -1) : m[2] === 'x' ? env.x || 0 : n(m[2]);
  const share = /shares a card type/.test(m[0]) && it ? cardTypesOfDef(DB[it.def]) : null;
  const kind = (m[1] || '').trim();
  const pool = cardsIn(env.me, 'hand').filter((c) => !isLand(c) && (DB[c.def].cmc || 0) <= cap && (!kind || matchesAny(c, kind)) && (!share || cardTypesOfDef(DB[c.def]).some((t) => share.includes(t))));
  const cf = env.castFree || T.castFree;
  if (!pool.length || !cf) {
    env.lastMay = false;
    return env.did.push('no spell in hand to cast for free');
  }
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Cast a spell${lesser ? ' with lesser mana value' : ` with mana value ${cap} or less`} from your hand for free?`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => DB[c.def].cmc });
  env.lastMay = !!pick;
  if (!pick) return;
  env.did.push(`casts ${nameTag(card(pick))} from hand for free`);
  await cf(env.me, pick, {});
});
// Shiko and Narset, Unified (Flurry): "copy that spell if it targets a permanent or player, and you may choose new targets for the copy.
// If you don't copy a spell this way, draw a card."
export const targetsPermOrPlayer = (text) =>
  /\bany target\b|\btarget (?:[\w-]+ ){0,4}?(?:creatures?|players?|opponents?|permanents?|artifacts?|enchantments?|lands?|planeswalkers?|battles?)\b(?! cards?\b)/i.test(String(text || '').replace(/\([^)]*\)/g, ''));
on(/^copy that spell if it targets a permanent or player, and you may choose new targets for the copy$/, async (m, env) => {
  const sp = env.it && env.it.iid ? card(env.it.iid) : null;
  env.copiedSpell = false;
  if (!sp || !targetsPermOrPlayer(spellText({ ...sp, face: sp.castFace || 0 }))) return env.did.push("that spell doesn't target a permanent or player");
  env.copiedSpell = true;
  await runSentence('copy that spell', env);
});
on(/^if you don't copy a spell this way, (.+)$/, async (m, env) => {
  if (env.copiedSpell) return;
  await runSentence(m[1], env);
});
function xFrom(phrase, env) {
  const p = phrase.toLowerCase();
  const it = env.it && env.it.iid ? card(env.it.iid) : null;
  if (/^(?:that spell's|its|that card's|the exiled card's|that creature's) mana value/.test(p)) return it ? DB[it.def].cmc || 0 : 0;
  if (/^(?:that spell's|its|that creature's) power/.test(p)) return it ? Math.max(0, power(it)) : 0;
  if (/^~'s power/.test(p)) return env.src ? Math.max(0, power(env.src)) : 0;
  return countPhrase(env.me, p.replace(/^the number of /, ''), helpers, env.src && env.src.iid) || 0;
}
// "Reveal the top ten cards of your library." — remembered for "from among them"
on(/^reveal the top (\w+) cards? of your library$/, async (m, env) => {
  const ids = libTop(env.me, n(m[1], env.x));
  env.them_ = ids;
  env.revealed = ids;
  env.did.push(`reveals ${ids.length} card${ids.length === 1 ? '' : 's'}`);
});
// "Put a creature card from among them onto the battlefield with three +1/+1 counters on it."
on(/^put (?:a|an|one|up to one) ([a-z ]*?)cards? from among them (onto the battlefield|into your hand)( tapped)?(?: with (\w+) ([+-]\d\/[+-]\d|[a-z]+) counters? on it)?/, async (m, env) => {
  const pool = (env.them_ || []).map(card).filter((c) => c && c.zone !== 'battlefield' && matchesAny(c, (m[1] || 'card').trim() || 'card'));
  if (!pool.length) return env.did.push('finds nothing');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Choose a ${(m[1] || '').trim() || ''} card`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'fromAmong', src: env.src, aiScore: (c) => DB[c.def].cmc + (isCreature(c) ? 2 : 0) });
  if (!pick) return;
  const c = card(pick);
  if (/battlefield/.test(m[2])) {
    toBattlefield(pick, env.me, { tapped: !!m[3] });
    if (m[4]) addCounters(c, m[5], n(m[4], env.x));
  } else move(pick, 'hand');
  env.it = { iid: pick };
  env.did.push(`puts ${nameTag(c)} ${/battlefield/.test(m[2]) ? 'onto the battlefield' : 'into hand'}`);
});
// "Sacrifice an artifact, a creature, and a land" — one of each
on(/^sacrifice ((?:an? [a-z]+, )+and an? [a-z]+)$/, async (m, env) => {
  const kinds = m[1].split(/, and |, /).map((x) => x.replace(/^an? /, '').trim());
  for (const k of kinds) {
    const pool = cardsIn(env.me, 'battlefield').filter((c) => matchesFilter(c, k));
    if (!pool.length) continue;
    const [pick] = pool.length === 1 ? [pool[0].iid] : await env.choosers[env.me].pickCards({ forced: true, prompt: `Sacrifice a ${k}`, cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'sacrifice', src: env.src, aiScore: (c) => -cardValue(c) + (c.token ? 3 : 0) });
    env.did.push(`${who(env.me)} ${s_(env.me, 'sacrifice')} ${nameTag(card(pick))}`);
    sacrifice(pick);
  }
});

on.first = true; // the handlers below are specific and take priority over the general ones
// --- mana payments inside effects: "You may pay {2}. If you do, …"
on(/^pay (?!\{e\})((?:\{[^}]+\})+)$/, async (m, env) => {
  const { T } = await import('./triggers.js');
  // Tilonalli's Summoner: "you may pay {X}{R}. If you do, create X …" — choose X (as much as you can afford)
  if (/\{x\}/i.test(m[1]) && castMod) {
    const base = m[1].replace(/\{x\}/gi, '');
    let max = 0;
    while (max < 20 && payCost(base + `{${max + 1}}`, castMod.manaSources(env.me))) max++;
    if (!payCost(base || '{0}', castMod.manaSources(env.me))) { env.lastMay = false; return env.did.push(`can't pay ${m[1]}`); }
    let x = await env.choosers[env.me].chooseNumber({ prompt: `${cardName(env.src)}: choose X for ${m[1].toUpperCase()} (0–${max})`, min: 0, max, ai: max });
    x = Math.max(0, Math.min(max, +x || 0));
    const cost = base + (x ? `{${x}}` : '');
    const paid = !cost || (T.payMana ? await T.payMana(env.me, cost, cardName(env.src)) : false);
    env.lastMay = !!paid;
    if (paid) { env.x = x; env.did.push(`${who(env.me)} ${s_(env.me, 'pay')} ${m[1]} with X = ${x}`); }
    return;
  }
  const paid = T.payMana ? await T.payMana(env.me, m[1], cardName(env.src)) : false;
  env.lastMay = !!paid;
  if (paid) env.did.push(`${who(env.me)} ${s_(env.me, 'pay')} ${m[1]}`);
});
// "Sacrifice ~ unless you pay {2}"
on(/^(sacrifice ~|sacrifice it|exile ~|return ~ to its owner's hand|tap ~|~ deals (\d+) damage to you|you lose (\d+) life|counter (?:it|that spell)) unless you (pay ((?:\{[^}]+\})+)|discard (?:a|one) cards?|sacrifice [^.]+|pay (\d+) life|return [^.]+)$/, async (m, env) => {
  const ch = env.choosers[env.me];
  let paid = false;
  const cost = m[4];
  const want = isAI(env.me) ? true : await ch.confirm(cardName(env.src), `${m[1].replace(/~/g, cardName(env.src))} unless you ${cost}. Pay?`, {});
  if (want) {
    if (m[5]) {
      const { T } = await import('./triggers.js');
      paid = T.payMana ? await T.payMana(env.me, m[5], cardName(env.src)) : false;
    } else if (m[6]) {
      if (G.s.players[env.me].life > +m[6] + (isAI(env.me) ? 5 : 0)) {
        changeLife(env.me, -m[6], false);
        paid = true;
      }
    } else {
      const { payOtherCost } = await import('./cast.js');
      try {
        paid = await payOtherCost(env.me, cost, env.src, { choosers: env.choosers, pay: async () => null });
      } catch (e) {
        if (!(e instanceof Cancelled)) throw e;
      }
    }
  }
  if (paid) return env.did.push(`${who(env.me)} ${s_(env.me, 'pay')} (${cost})`);
  await runSentence(m[1], env);
});
// --- hands: reveal, look, choose a card from it
on(/^(target opponent|target player|each opponent|that player|an opponent) reveals (?:their|his or her) hand$|^look at (target opponent's|target player's|an opponent's|that player's|each opponent's) hand$|^reveal your hand$/, async (m, env) => {
  const who_ = m[1] || m[2] ? (await playerTarget(env, (m[1] || m[2]).replace(/'s$/, '')))[0] : env.me;
  if (!who_) return;
  env.handOf = who_;
  env.thatPlayer = who_;
  const hand = cardsIn(who_, 'hand');
  env.did.push(`${who_ === 'p' ? 'you reveal' : 'the AI reveals'} ${hand.length ? hand.map(nameTag).join(', ') : 'an empty hand'}`);
});
on(/^(?:you )?(?:may )?(?:choose|look at it and choose) (?:a|an|one|up to one|up to two|two|x) ([a-z ,/-]*?)cards? from (?:it|their hand|among them|that player's hand)(?:,? (?:and )?(exile|that player discards|discard|put) (?:it|that card|those cards|them)(?: on the bottom of (?:its owner's|their) library| on top of (?:its owner's|their) library| into (?:its owner's|their) graveyard)?)?$/, async (m, env) => {
  const pid = env.handOf || opp(env.me);
  const kind = (m[1] || '').trim().replace(/^(?:a|an) /, '') || 'card';
  const pool = cardsIn(pid, 'hand').filter((c) => matchesAny(c, kind));
  if (!pool.length) return env.did.push(`finds no ${kind} card`);
  const k = /two/.test(env.sentence.split(' card')[0]) ? 2 : 1;
  const picks = await env.choosers[env.me].pickCards({
    forced: !/up to/.test(env.sentence), prompt: `Choose ${k === 1 ? 'a' : k} ${kind} card${k === 1 ? '' : 's'} from ${seatPoss(pid)} hand`, cards: pool.map((c) => c.iid),
    min: /up to/.test(env.sentence) ? 0 : Math.min(k, pool.length), max: Math.min(k, pool.length), purpose: 'handChoice', src: env.src,
    aiScore: (c) => DB[c.def].cmc + (isCreature(c) ? 1 : 0),
  });
  env.them_ = picks;
  env.it = picks[0] ? { iid: picks[0] } : null;
  const what = m[2] || (/exile/.test(env.next || '') ? 'exile' : /discards? (?:that|the chosen) card/.test(env.next || '') ? 'pending' : '');
  for (const i of picks) {
    const nm = nameTag(card(i));
    if (/exile/.test(what)) {
      move(i, 'exile');
      env.did.push(`exiles ${nm} from hand`);
    } else if (/discard/.test(what)) {
      discardCard(i);
      env.did.push(`${who(pid)} ${s_(pid, 'discard')} ${nm}`);
    } else if (/put/.test(what) && /bottom/.test(env.sentence)) move(i, 'library', { to: 'bottom' });
    else if (/put/.test(what)) move(i, 'library');
    else env.did.push(`chooses ${nm}`);
  }
});
on(/^(?:that player|target player|target opponent|its owner) (?:discards|discard) (?:that|the chosen) cards?$|^(?:exile|that player exiles) (?:that|the chosen) cards?$/, async (m, env) => {
  for (const i of env.them_ || (env.it && env.it.iid ? [env.it.iid] : [])) {
    const c = card(i);
    if (!c || c.zone !== 'hand') continue;
    if (/exile/.test(env.sentence)) move(i, 'exile');
    else discardCard(i);
    env.did.push(`${/exile/.test(env.sentence) ? 'exiles' : 'discards'} ${nameTag(c)}`);
  }
});
// --- top of library
on(/^(?:reveal|exile|look at) the top card of (?:your|target player's|each player's) library$/, async (m, env) => {
  const [top] = libTop(env.me, 1);
  if (!top) return;
  if (/^exile/.test(env.sentence)) move(top, 'exile');
  env.it = { iid: top };
  env.them_ = [top];
  env.revealed = [top];
  env.did.push(`${/^exile/.test(env.sentence) ? 'exiles' : 'reveals'} ${nameTag(card(top))}`);
});
on(/^exile the top (\w+) cards? of your library$/, async (m, env) => {
  const ids = libTop(env.me, n(m[1], env.x));
  ids.forEach((i) => move(i, 'exile'));
  env.them_ = ids;
  env.it = ids[0] ? { iid: ids[0] } : null;
  env.did.push(`exiles the top ${ids.length} card${ids.length === 1 ? '' : 's'}`);
});
on(/^(?:if it's|if that card is|if it is) an? ([a-z ]+?) card, (?:you may )?(?:put it|reveal it and put it) (into your hand|onto the battlefield(?: tapped)?)(?:\. otherwise, (?:put it|you may put it) (into your graveyard|on the bottom of your library))?$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  if (!c) return;
  if (matchesAny(c, m[1])) {
    if (/battlefield/.test(m[2])) toBattlefield(c.iid, env.me, { tapped: /tapped/.test(m[2]) });
    else move(c.iid, 'hand');
    env.did.push(`${/reveal it/.test(env.sentence) ? 'reveals and ' : ''}puts ${nameTag(c)} ${/battlefield/.test(m[2]) ? 'onto the battlefield' : 'into hand'}`);
  } else if (!m[3]) {
    if (env.me === 'p') env.did.push(`${nameTag(c)} isn't a ${m[1]} card, so it stays on top`);
  } else if (m[3]) {
    move(c.iid, /graveyard/.test(m[3]) ? 'graveyard' : 'library', /bottom/.test(m[3]) ? { to: 'bottom' } : {});
  }
});
on(/^(look at|reveal) the top card of your library$/, async (m, env) => {
  const top = libTop(env.me, 1)[0];
  if (!top) return;
  env.it = { iid: top };
  env.did.push(m[1] === 'reveal' ? `reveals ${nameTag(card(top))}` : env.me === 'p' ? `looks at the top card of your library: ${nameTag(card(top))}` : 'looks at the top card of its library');
});
on(/^put (that card|it|them|those cards) into your hand$/, async (m, env) => {
  // "that card" / "it" is the one card (Breaching Dragonstorm: the nonland card, not every card exiled on the way)
  const one = /^(?:that card|it)$/.test(m[1]);
  const ids = one && env.it && env.it.iid ? [env.it.iid] : env.them_ && env.them_.length ? env.them_ : env.it && env.it.iid ? [env.it.iid] : [];
  for (const i of ids) if (card(i) && card(i).zone !== 'hand') move(i, 'hand');
  if (ids.length) env.did.push(`puts ${ids.map((i) => nameTag(card(i))).join(', ')} into hand`);
});
on(/^put the rest (?:on the bottom of your library(?: in (?:a|any) (?:random )?order)?|into your graveyard)$/, async (m, env) => {
  const rest = (env.revealed || []).filter((i) => card(i) && card(i).zone === 'library');
  if (/random/.test(env.sentence)) rest.sort(() => Math.random() - 0.5);
  for (const i of rest) move(i, /graveyard/.test(env.sentence) ? 'graveyard' : 'library', /bottom/.test(env.sentence) ? { to: 'bottom' } : {});
});
// Brainstorm: "Put two cards from your hand on top of your library in any order"
on(/^put (\w+) cards? from your hand on (?:top|the bottom) of your library(?: in any order)?$/, async (m, env) => {
  const hand = cardsIn(env.me, 'hand');
  const k = Math.min(n(m[1], env.x), hand.length);
  if (!k) return;
  const lands = cardsIn(env.me, 'battlefield').filter(isLand).length;
  if (T.render) T.render(); // show the cards just drawn before choosing
  const picks = await env.choosers[env.me].pickCards({ forced: true, prompt: `Put ${k} card${k > 1 ? 's' : ''} from your hand ${/bottom/.test(env.sentence) ? 'on the bottom of' : 'on top of'} your library${k > 1 && !/bottom/.test(env.sentence) ? ' (the last one you pick ends up on top)' : ''}`, cards: hand.map((c) => c.iid), min: k, max: k, purpose: 'putBack', src: env.src, aiScore: (c) => (isLand(c) ? (lands >= 5 ? 10 : -5) : DB[c.def].cmc - lands) });
  for (const i of picks) move(i, 'library', /bottom/.test(env.sentence) ? { to: 'bottom' } : {});
  env.did.push(`puts ${k} card${k > 1 ? 's' : ''} back`);
});
// --- flicker and delayed returns
on(/^return (it|that card|the exiled card|them|those cards|the exiled cards|that creature|each card exiled this way) to the battlefield( transformed)?(?: under (its owner's|their owners'|their owner's|your|its controller's) control)?( tapped)?( at the beginning of the next end step)?(?: with an? ([a-z+\/0-9-]+) counter on (?:it|them|each of them))?$/, async (m, env) => {
  let ids = env.them_ && env.them_.length && /them|those|each/.test(m[1]) ? env.them_ : env.it && env.it.iid ? [env.it.iid] : env.them_ || [];
  // Edgar, Charmed Groom: "When ~ dies, return it to the battlefield transformed" — "it" is the card that died
  if (!ids.length && m[1] === 'it' && env.src && card(env.src.iid) && card(env.src.iid).zone !== 'battlefield') ids = [env.src.iid];
  // Oblivion Ring & co.: "the exiled card" is whatever this permanent exiled
  const src = env.src && env.src.iid;
  const linked = /exiled/.test(m[1]) && src ? Object.values(G.s.cards).filter((x) => x.zone === 'exile' && x.exiledLinked === src) : [];
  if (linked.length) ids = linked.map((x) => x.iid);
  for (const i of ids) {
    const c = card(i);
    if (!c || c.zone === 'battlefield') continue;
    delete c.exiledLinked;
    const ctlr = m[3] === 'your' ? env.me : c.owner;
    if (m[5]) {
      G.s.delayed.push({ at: 'endStep', kind: 'returnFromExile', iid: i, pid: ctlr });
      env.did.push(`${nameTag(c)} will return at the next end step`);
      continue;
    }
    toBattlefield(i, ctlr, { tapped: !!m[4] });
    if (m[2] && DB[c.def].faces.length > 1) card(i).face = 1;
    // Luminous Broodmoth: "with a flying counter on it"
    if (m[6] && card(i) && card(i).zone === 'battlefield') addCounters(card(i), m[6], 1);
    env.did.push(`returns ${nameTag(card(i))} to the battlefield${m[2] ? ' transformed' : ''}${m[6] ? ` with a ${m[6]} counter` : ''}`);
  }
});
// Otherworldly Journey, Semester's End: "At the beginning of the next end step, return that card / each of them to the battlefield …"
on(/^at the beginning of the next end step, return (that card|those cards|them|it|each of them|the exiled cards?) to the battlefield(?: under (?:its|their) owners?'?s?'? control| under your control)?(?: with (?:a|an|one|two) (\+1\/\+1) counters? on (?:it|them|each of them))?/, async (m, env) => {
  const ids = (env.them_ && env.them_.length ? env.them_ : env.it && env.it.iid ? [env.it.iid] : []).filter((i) => card(i) && card(i).zone === 'exile');
  env.delayedNow = [];
  for (const i of ids) {
    const d = { at: 'endStep', kind: 'returnFromExile', iid: i, pid: /under your control/.test(env.sentence) ? env.me : card(i).owner };
    if (m[2]) d.counter = '+1/+1';
    G.s.delayed.push(d);
    env.delayedNow.push(d);
    env.did.push(`${nameTag(card(i))} will return at the next end step`);
  }
});
on(/^each of them enters with an additional \+1\/\+1 counter on it/, async (m, env) => {
  for (const d of env.delayedNow || []) d.counter = '+1/+1';
  if ((env.delayedNow || []).length) env.did.push('each returns with an extra counter');
});
on(/^(?:(?:sacrifice|exile) (it|them|that creature|those creatures|that token|those tokens) at the beginning of (?:the|your) next end step|at the beginning of (?:the|your) next end step, (?:sacrifice|exile) (it|them|that creature|those creatures|that token|those tokens))( unless you have the city's blessing)?$/, async (m, env) => {
  m[1] = m[1] || m[2];
  const ids = /them|those/.test(m[1]) && (env.them_ || env.made) ? env.them_ || env.made : env.it && env.it.iid ? [env.it.iid] : [];
  if (ids.length) env.did.push(`${ids.length === 1 && card(ids[0]) ? nameTag(card(ids[0])) : ids.length + ' permanents'} will ${/exile/.test(env.sentence) ? 'be exiled' : 'be sacrificed'} at end of turn${m[3] ? " unless you have the city's blessing" : ''}`);
  for (const i of ids) if (card(i)) { card(i).endOfTurn = /^exile|, exile/.test(env.sentence) ? 'exile' : 'sacrifice'; if (m[3]) card(i).eotUnlessBlessing = true; }
});
on(/^(that creature|it|that permanent|those creatures|target creature|that land) (?:doesn't|don't) untap during (?:its|their) controller'?s'? next untap step$/, async (m, env) => {
  const objs = await objects(env, m[1]);
  for (const c of objs) c.noUntapUntil = G.s.turn + (c.controller === G.s.active ? 3 : 2);
  if (objs.length) env.did.push(`${objs.map(nameTag).join(', ')} won't untap next turn`);
});
// --- bare life changes ("…and gain 3 life")
on(/^(gain|lose) (\d+|x) life$/, async (m, env) => {
  const k = n(m[2], env.x);
  changeLife(env.me, m[1] === 'gain' ? k : -k, false);
  env.did.push(`${who(env.me)} ${s_(env.me, m[1])} ${k} life`);
});
// --- choices
on(/^choose (an opponent|target opponent|target player)$/, async (m, env) => {
  const [pid] = m[1] === 'an opponent' ? [opp(env.me)] : await playerTarget(env, m[1]);
  env.thatPlayer = pid;
  env.it = { player: pid };
});
on(/^choose (target [^.]+)$/, async (m, env) => {
  const [c] = await objects(env, m[1], { harm: !/you control/.test(m[1]) });
  if (c) env.chosenObj = c;
  if (c) env.did.push(`chooses ${nameTag(c)}`);
});
on(/^choose (?:a|one) (color|creature type|card type|basic land type|nonland card name|card name|land type)(?: other than [a-z]+)?$/, async (m, env) => {
  let pick = '';
  if (m[1] === 'color') {
    const counts = { white: 0, blue: 0, black: 0, red: 0, green: 0 };
    const map = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
    for (const c of opponents(env.me).flatMap((o) => cardsIn(o, 'battlefield'))) for (const col of colorsOf(c)) counts[map[col]]++;
    const opts = Object.keys(counts);
    const k = await env.choosers[env.me].choose({ prompt: 'Choose a color', options: opts.map((x) => ({ label: x })), aiPick: () => opts.indexOf(opts.sort((a, b) => counts[b] - counts[a])[0]) });
    pick = opts[k];
  } else if (m[1] === 'creature type') {
    const counts = {};
    for (const c of cardsIn(env.me, 'battlefield').concat(cardsIn(env.me, 'hand'))) for (const t of (typeLine(c).split('—')[1] || '').trim().split(/\s+/).filter(Boolean)) if (isCreature(c) || /Creature/.test(typeLine(c))) counts[t] = (counts[t] || 0) + 1;
    const opts = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    if (!opts.length) opts.push('Human');
    const k = await env.choosers[env.me].choose({ prompt: 'Choose a creature type', options: opts.slice(0, 12).map((x) => ({ label: x })), aiPick: () => 0 });
    pick = opts[k];
  } else {
    pick = 'your choice';
  }
  env.chosen = pick;
  if (env.src) env.src.chosen = pick;
  env.did.push(`chooses ${pick}`);
});
// Sozin's Comet: "Each creature you control gains firebending 5 until end of turn."
on(/^(each creature you control|creatures you control|target creature(?: you control)?|it|~) gains? firebending (\d+|x) until end of turn$/, async (m, env) => {
  const objs = /^each creature you control|^creatures you control/.test(m[1]) ? cardsIn(env.me, 'battlefield').filter(isCreature) : await objects(env, m[1], { harm: false });
  const k = n(m[2], env.x);
  for (const c of objs) c.eotGrants = [...(c.eotGrants || []), `firebending ${k}`];
  env.did.push(`${objs.length} creature${objs.length === 1 ? '' : 's'} gain firebending ${k} until end of turn`);
}, { first: true });
// Raise the Palisade: "Return all creatures that aren't of the chosen type to their owners' hands."
on(/^return all creatures that aren't of the chosen type to their owners' hands$/, async (m, env) => {
  const t = env.chosen || (env.src && env.src.chosen);
  const objs = seats().flatMap((k) => cardsIn(k, 'battlefield')).filter((c) => isCreature(c) && !(t && hasSubtype(c, t)));
  for (const c of objs) move(c.iid, 'hand');
  env.did.push(`returns ${objs.length} creature${objs.length === 1 ? '' : 's'} that aren't ${t || 'the chosen type'} to their owners' hands`);
}, { first: true });
// Where Ancients Tread: "you may have ~ deal 5 damage to any target"
on(/^have ~ deal (\d+|x) damage to (.+)$/, async (m, env) => runSentence(`~ deals ${m[1]} damage to ${m[2]}`, env), { first: true });
// Well of Lost Dreams: "you may pay {X}, where X is less than or equal to the amount of life you gained. If you do, draw X cards."
on(/^(?:you may )?pay \{x\}(?:, where x is less than or equal to the amount of life you gained)?$/, async (m, env) => {
  if (!/where x is less than or equal to the amount of life you gained/.test(env.text || '')) return 'pass';
  const most = env.thatMuch || env.lastAmount || 0;
  const { manaSources: ms } = await import('./cast.js');
  const avail = ms(env.me, { ability: true }).reduce((a, s_) => a + (s_.amount || 1), 0);
  const cap = Math.min(most, avail);
  env.lastMay = false;
  if (cap <= 0) return env.did.push("can't pay any mana");
  let k = 0;
  try {
    k = await env.choosers[env.me].chooseNumber({ prompt: `${cardName(env.src)}: pay {X} to draw X cards (up to ${cap})`, min: 0, max: cap, ai: cap });
  } catch (e) {
    k = 0;
  }
  if (!k) return;
  const { applyPayment: ap } = await import('./cast.js');
  const pay = payCost(`{${k}}`, ms(env.me, { ability: true }));
  if (!pay) return env.did.push(`can't pay {${k}}`);
  ap(env.me, pay);
  env.x = k;
  env.lastMay = true;
  env.did.push(`pays {${k}}`);
}, { first: true });
// --- flashback for cards in the graveyard (Snapcaster Mage, Past in Flames)
on(/^(target instant or sorcery card in your graveyard|each instant and sorcery card in your graveyard|target instant card in your graveyard|target sorcery card in your graveyard) gains flashback until end of turn/, async (m, env) => {
  let ids;
  if (/^each/.test(m[1])) ids = cardsIn(env.me, 'graveyard').filter((c) => /Instant|Sorcery/.test(DB[c.def].typeLine)).map((c) => c.iid);
  else {
    const pool = cardsIn(env.me, 'graveyard').filter((c) => matchesAny(c, m[1].replace(/^target | card in your graveyard$/g, '')));
    ids = pool.length ? await env.choosers[env.me].pickCards({ prompt: 'Choose a card to give flashback', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'flashback', src: env.src, aiScore: (c) => DB[c.def].cmc }) : [];
  }
  for (const i of ids) card(i).tempFlashback = G.s.turn;
  if (ids.length) env.did.push(`${ids.length === 1 ? nameTag(card(ids[0])) + ' gains' : ids.length + ' cards gain'} flashback this turn`);
});
// --- graveyard exile: "Exile target creature card from your graveyard", "exile up to one target card from a graveyard"
on(/^exile (?!all |(?:that|those) cards? )(up to (\w+) )?(?:another )?(target )?(?:(a|an|one|two|three|x|\d+) )?([a-z ,/-]*?)cards? from (your|a|target player's|an opponent's|their|each opponent's|any) graveyards?$/, async (m, env) => {
  const pids = m[6] === 'your' || m[6] === 'their' ? [env.me] : /opponent/.test(m[6]) ? opponents(env.me) : seats();
  const kind = (m[5] || '').trim() || 'card';
  const pool = pids.flatMap((pid) => cardsIn(pid, 'graveyard')).filter((c) => c.iid !== (env.src || {}).iid && matchesAny(c, kind));
  const k = Math.min(m[2] ? n(m[2], env.x) : m[4] ? n(m[4], env.x) : 1, pool.length);
  if (!k) {
    env.lastMay = false;
    return;
  }
  const picks = await env.choosers[env.me].pickCards({
    forced: !m[1], prompt: `Exile ${m[1] ? 'up to ' : ''}${k} ${kind} card${k > 1 ? 's' : ''} from ${m[6] === 'your' ? 'your graveyard' : 'a graveyard'}`, cards: pool.map((c) => c.iid), min: m[1] ? 0 : k, max: k,
    purpose: 'gy-exile', src: env.src, aiScore: (c) => (c.owner === env.me ? -DB[c.def].cmc : DB[c.def].cmc + (isCreature(c) ? 2 : 0)),
  });
  for (const i of picks) move(i, 'exile');
  env.them_ = picks;
  env.it = picks[0] ? { iid: picks[0] } : null;
  env.lastMay = picks.length > 0;
  if (picks.length) env.did.push(`exiles ${picks.map((i) => nameTag(card(i))).join(', ')} from ${picks.length === 1 ? 'a graveyard' : 'graveyards'}`);
});
// Nissa, Who Shakes the World / Koth-style animation: "It becomes a 0/0 Elemental creature with vigilance and haste that's still a land."
on(/^(it|that land|target land you control|~|that creature|that permanent) becomes an? (\d+)\/(\d+) ([a-z ]*?)creature(?: with ([a-z, ]+?))?(?: that's still a (?:land|artifact|enchantment))?( until end of turn)?$/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: false });
  for (const c of objs) {
    const types = (m[4] || '').trim().replace(/\b\w/g, (x) => x.toUpperCase()) || 'Creature';
    c.animated = { ts: nextStamp(), p: +m[2], t: +m[3], types, until: m[6] ? 'eot' : 'forever', setsPT: true };
    if (m[5]) c.grants = [...(c.grants || []), ...kwList(m[5].replace(/ and /g, ', '))];
    env.did.push(`${nameTag(c)} becomes a ${m[2]}/${m[3]} ${types} creature`);
  }
});
// --- earthbend N: target land you control becomes a 0/0 creature with haste (still a land) with N +1/+1 counters
on(/^earthbend (\d+|x)$/, async (m, env) => {
  const k = n(m[1], env.x);
  const lands = cardsIn(env.me, 'battlefield').filter(isLand);
  if (!lands.length) return;
  const pick = await env.choosers[env.me].target({ forced: true, prompt: `Earthbend ${k}: choose a land you control`, candidates: lands.map((c) => c.iid), harm: false, src: env.src });
  const l = pick && pick.iid && card(pick.iid);
  if (!l) return;
  l.animated = { ts: nextStamp(), p: 0, t: 0, types: 'Creature', until: 'forever' };
  l.grants = [...(l.grants || []), 'haste'];
  l.earthbent = true;
  addCounters(l, '+1/+1', k);
  env.did.push(`earthbends ${nameTag(l)} (${k} counters)`);
});
// --- copying a spell on the stack: "Copy it", "Copy target instant or sorcery spell"
on(/^copy (it|that spell|target (?:instant or sorcery |instant |sorcery )?spell(?: you control)?)(?: (twice|thrice|\w+ times))?(?:, except the copy isn't legendary)?(?:\. you may choose new targets for the cop(?:y|ies))?$/, async (m, env) => {
  const target = env.it && env.it.iid && card(env.it.iid) ? card(env.it.iid) : env.stackTarget ? card(env.stackTarget) : (G.s.stack && card(G.s.stack.iid)) || (G.s.pstack && card(G.s.pstack.iid));
  if (!target) return env.did.push('nothing to copy');
  if (env.src && card(env.src.iid) && /do this only once each turn/i.test(env.text || '') && card(env.src.iid).onceTurn === G.s.turn) {
    env.lastMay = false;
    return env.did.push('already copied a spell this turn');
  }
  const times = !m[2] ? 1 : m[2] === 'twice' ? 2 : m[2] === 'thrice' ? 3 : n(m[2].replace(/ times$/, '')) || 1;
  // a copy of a permanent spell becomes a token (Tomb of Horrors Adventurer, Double Major…)
  if (isPermanentCard({ faces: [DB[target.def].faces[target.castFace || 0] || DB[target.def].faces[0]] })) {
    const made = createToken(target.def, env.me, times);
    for (const i of made) if (card(i)) card(i).face = target.castFace || 0;
    // The Sixth Doctor: "except the copy isn't legendary"
    if (/except the copy isn't legendary/.test(env.sentence)) for (const i of made) if (card(i)) card(i).notLegendary = true;
    // Spider-Verse: "If the copy is a permanent spell, it gains haste."
    if (/if the copy is a permanent spell, it gains haste/i.test(env.text || '')) for (const i of made) if (card(i)) card(i).grants = [...(card(i).grants || []), 'haste'];
    queueEvent({ type: 'copySpell', controller: env.me, iid: target.iid });
    if (env.src && card(env.src.iid) && /do this only once each turn/i.test(env.text || '')) card(env.src.iid).onceTurn = G.s.turn;
    env.did.push(`copies ${nameTag(target)} (${made.length} token${made.length === 1 ? '' : 's'})`);
    env.did.push(...(await attachLooseAuras(made, env.me, env.choosers)));
    return;
  }
  if (env.src && card(env.src.iid) && /do this only once each turn/i.test(env.text || '')) card(env.src.iid).onceTurn = G.s.turn;
  queueEvent({ type: 'copySpell', controller: env.me, iid: target.iid });
  for (let k = 0; k < times; k++) {
    const did = await resolveEffects(spellText({ ...target, face: target.castFace || 0 }), { ...target, face: target.castFace || 0, controller: env.me }, { me: env.me, choosers: env.choosers, castFree: env.castFree, x: target.xPaid || 0, kicked: target.kicked });
    env.did.push(`copies ${nameTag(target)}${did.length ? ': ' + did.join('; ') : ''}`);
  }
});
// "Discard up to two cards"
on(/^discard up to (\w+) cards?(?:, then draw that many cards)?$/, async (m, env) => {
  const hand = cardsIn(env.me, 'hand');
  const k = Math.min(n(m[1], env.x), hand.length);
  const lands = cardsIn(env.me, 'battlefield').filter(isLand).length;
  const picks = k ? await env.choosers[env.me].pickCards({ prompt: `Discard up to ${k} card${k > 1 ? 's' : ''}`, cards: hand.map((c) => c.iid), min: 0, max: k, purpose: 'discard', src: env.src, aiScore: (c) => (isLand(c) ? (lands >= 6 ? 10 : -10) : DB[c.def].cmc - lands - 3) }) : [];
  picks.forEach((i) => discardCard(i));
  env.lastAmount = picks.length;
  if (/then draw that many/.test(env.sentence) && picks.length) draw(env.me, picks.length, true);
  env.did.push(`discards ${picks.length}${/then draw/.test(env.sentence) ? ' and draws ' + picks.length : ''}`);
});
// Tokens that come with an ability: 'They have "Sacrifice this creature: Add {C}."'
on(/^(it|they|that token|those tokens|the tokens?) (?:has|have) "(.+)"$/, async (m, env, raw) => {
  const quoted = (raw.match(/"(.+)"/) || [])[1];
  const ids = env.them_ && env.them_.length ? env.them_ : env.it && env.it.iid ? [env.it.iid] : [];
  for (const i of ids) if (card(i)) card(i).extraText = ((card(i).extraText || '') + '\n' + quoted).trim();
});
// "Target creature attacks this turn if able"
on(/^(target creature|that creature|it|each creature (?:target|your) opponents? controls?) attacks this turn if able$/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: true });
  for (const c of objs) goad(c, env.me);
  if (objs.length) env.did.push(`${objs.map(nameTag).join(', ')} must attack this turn`);
});
// "You may have ~ become a copy of it until end of turn, except its name is ~ and it's legendary"
on(/^(?:have )?(~|target creature you control) becomes? a copy of (it|that creature|target [^,]+?|another target [^,]+?)( until end of turn)?(?:, except (.+))?$/, async (m, env, raw) => {
  const [self] = await objects(env, m[1], { harm: false });
  const [model] = await objects(env, m[2], { harm: false });
  if (!self || !model || self.iid === model.iid) return;
  const keepName = /its name is/i.test(m[4] || '') ? cardName(self) : null;
  const wasName = nameTag(self);
  if (!self.origDef) {
    self.origDef = self.def;
    self.origFace = self.face || 0;
  }
  self.def = model.def;
  self.face = model.face || 0;
  if (m[3]) self.copyUntil = 'eot';
  if (keepName) self.nameOverride = keepName;
  if (/it's legendary|is legendary/i.test(m[4] || '')) self.addTypes = ((self.addTypes || '') + ' Legendary').trim();
  if (/it has haste/i.test(m[4] || '')) self.eotGrants = [...(self.eotGrants || []), 'haste'];
  env.did.push(`${keepName || wasName} becomes a copy of ${nameTag(model)}${m[3] ? ' until end of turn' : ''}`);
});
// Clone, Phantasmal Image, Spark Double, Vesuva: "You may have ~ enter (tapped) as a copy of any creature on the battlefield[, except …]."
// Called just before the permanent enters, so a 0/0 Clone becomes the copy instead of dying.
export async function enterAsCopy(pid, c, choosers) {
  const o = stripName(DB[c.def].faces[c.face || 0].oracle || DB[c.def].faces[0].oracle || '', c);
  const m = o.match(/You may have (?:~|this (?:creature|permanent|artifact|enchantment|land)) enter(?: the battlefield)?( tapped)? as a copy of (?:any|a|an) ([a-z ]+?) (on the battlefield|you control)(?: with (power|toughness|mana value) (\d+) or (greater|less))?(?:, except ([^\n]+?))?\.?(?:\n|$)/i);
  if (!m) return null;
  const kinds = m[2].toLowerCase().split(/ or /).map((k) => k.trim());
  // Deceptive Frostkite: "a creature you control with power 4 or greater"
  const statOk = (x) => {
    if (!m[4]) return true;
    const v = m[4] === 'power' ? power(x) : m[4] === 'toughness' ? toughness(x) : DB[x.def].cmc || 0;
    return m[6] === 'greater' ? v >= +m[5] : v <= +m[5];
  };
  const pool = [...(/you control/i.test(m[3]) ? [] : opponents(pid).flatMap((o2) => cardsIn(o2, 'battlefield'))), ...cardsIn(pid, 'battlefield')]
    .filter((x) => x.iid !== c.iid && !x.phasedOut && !x.faceDown && kinds.some((k) => (k === 'creature' ? isCreature(x) : isType(x, k[0].toUpperCase() + k.slice(1)))) && statOk(x));
  if (!pool.length) return null;
  const [pick] = await choosers[pid].pickCards({ prompt: `${cardName(c)}: enter as a copy of… (or choose none)`, cards: pool.map((x) => x.iid), min: 0, max: 1, purpose: 'copy', src: c, aiScore: (x) => cardValue(x) + (x.controller === pid ? 0.5 : 0) });
  if (!pick || !card(pick)) return null;
  const model = card(pick);
  const except = (m[7] || '').toLowerCase();
  c.origDef = c.origDef || c.def;
  c.origFace = c.origFace || c.face || 0;
  c.def = model.def;
  c.face = model.face || 0;
  if (m[1]) c.tapped = true;
  if (/isn't legendary|not legendary/.test(except)) c.notLegendary = true;
  // Chameleon, Master of Disguise: "except his name is Chameleon, Master of Disguise"
  if (/\b(?:his|her|its|their) name is ~/.test(except)) c.nameOverride = DB[c.origDef].name;
  if (/it's an? ([a-z]+) in addition to its other types/.test(except)) c.addTypes = ((c.addTypes || '') + ' ' + except.match(/it's an? ([a-z]+) in addition/)[1].replace(/^\w/, (x) => x.toUpperCase())).trim();
  // "… and it has flying"
  { const hm = except.match(/\bit has ([a-z, ]+?)(?:$|\.|,? and (?:it|its)\b)/); if (hm && !/"/.test(except)) c.grants = [...(c.grants || []), ...kwList(hm[1])]; }
  const quoted = (m[7] || '').match(/"([^"]+)"/);
  if (quoted) c.extraText = ((c.extraText || '') + '\n' + quoted[1].replace(/this creature/gi, '~')).trim();
  // Spark Double: "it enters with an additional +1/+1 counter on it if it's a creature, it enters with an additional loyalty counter on it if it's a planeswalker"
  c.enterExtra = {
    plus: /additional \+1\/\+1 counter/.test(except) && /Creature/.test(DB[model.def].faces[model.face || 0].typeLine || '') ? 1 : 0,
    loyalty: /additional loyalty counter/.test(except) && /Planeswalker/.test(DB[model.def].faces[model.face || 0].typeLine || '') ? 1 : 0,
  };
  return model;
}
// "Put a permanent card with mana value less than or equal to that damage from your hand (or graveyard) onto the battlefield"
on(/^put (?:a|an|up to one) ([a-z ]*?)cards? with mana value (\d+|x|less than or equal to [^,]+?|[a-z ]+? or less) from your (hand|graveyard|hand or graveyard) onto the battlefield( tapped)?(?: under your control)?$/, async (m, env) => {
  const mvText = m[2];
  let max = /^\d+$/.test(mvText) ? +mvText : /^x$/.test(mvText) ? env.x : null;
  if (max === null) {
    const t = mvText.replace(/^less than or equal to /, '').replace(/ or less$/, '');
    max = /that (?:damage|much|many)/.test(t) ? env.lastAmount || 0 : amountOf(t, env);
  }
  const zones = m[3].split(' or ');
  const pool = zones.flatMap((z) => cardsIn(env.me, z)).filter((c) => DB[c.def].cmc <= max && matchesAny(c, (m[1] || 'permanent').trim() || 'permanent') && isPermanentCard(DB[c.def]));
  if (!pool.length) return env.did.push(`has nothing with mana value ${max} or less to put onto the battlefield`);
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Put a ${(m[1] || 'permanent').trim()} card with mana value ${max} or less onto the battlefield`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'cheat', src: env.src, aiScore: (c) => DB[c.def].cmc + (isCreature(c) ? 1 : 0) });
  if (!pick) return;
  toBattlefield(pick, env.me, { tapped: !!m[4] });
  env.did.push(`puts ${nameTag(card(pick))} onto the battlefield`);
});
on.first = false;
// --- library searches & graveyard returns
on(/^search (?:your|its controller's|their) library (?:and(?:\/or)? graveyard )?for ([^.]+?)(?:(?:,| and) [^.]*)?$/, async (m, env) => {
  const t = env.sentence + ' ' + (env.next || '');
  if (/land card|basic|forest|island|swamp|mountain|plains/.test(m[1] || '') && !/creature|artifact|enchantment|instant|sorcery/.test(m[1] || '')) await fetchLands(t, env.me, env.choosers[env.me], env.src, env.did, env);
  else await tutor(t, env.me, env.choosers[env.me], env.src, env.did, env);
});
on(/^return (.+?) from (your|a|target player's|an opponent's|each player's|all) graveyards? (?:to|onto) (the battlefield|your hand|its owner's hand|the top of your library)(?: under your control)?( tapped)?/, async (m, env) => {
  const pids = m[2] === 'your' ? [env.me] : m[2] === "an opponent's" ? opponents(env.me) : seats();
  const phrase = m[1].toLowerCase();
  let count = 1;
  let all = false;
  let mm;
  if ((mm = phrase.match(/^up to (\w+)/))) count = n(mm[1], env.x);
  if (/^(?:all|each)\b/.test(phrase)) all = true;
  if (/^(?:~|it|that card)$/.test(phrase)) {
    const c = /^(?:~)$/.test(phrase) ? env.src : env.it && card(env.it.iid);
    if (!c || c.zone !== 'graveyard') return;
    moveReturned(env, c, m[3], m[4]);
    return;
  }
  const filter = phrase.replace(/^(?:up to \w+|another|all|each|target|other|a|an|one|two)\s+/g, '').replace(/^target /, '').replace(/cards?.*$/, '').trim();
  // keep "with power 2 or less", "with mana value 3 or less" (Dawn, Sun Titan-style)
  const withPart = (phrase.match(/cards? (with [^.]+?)$/) || [])[1] || '';
  const pool = pids.flatMap((pid) => cardsIn(pid, 'graveyard')).filter((c) => c.iid !== env.src.iid && matchesFilter(c, filter || 'card') && (!withPart || matchesFilter(c, withPart)) && (!/permanent/.test(filter) || isPermanentCard(DB[c.def])));
  const mvMax = phrase.match(/mana value (\d+|x) or less/);
  const pool2 = mvMax ? pool.filter((c) => DB[c.def].cmc <= (mvMax[1] === 'x' ? env.x : +mvMax[1])) : pool;
  env.lastAmount = 0;
  env.thatMuch = 0;
  if (!pool2.length) return env.did.push('finds nothing to return');
  const picks = all ? pool2.map((c) => c.iid) : await env.choosers[env.me].pickCards({
    prompt: `Choose ${count > 1 ? 'up to ' + count + ' cards' : 'a card'} to return to ${m[3].replace('the ', '')}`,
    cards: pool2.map((c) => c.iid), min: /up to/.test(phrase) ? 0 : 1, max: Math.min(count, pool2.length), purpose: m[3] === 'the battlefield' ? 'reanimate' : 'regrowth', src: env.src,
    aiScore: (c) => DB[c.def].cmc + (/Creature/.test(DB[c.def].typeLine) ? 2 : 0),
  });
  for (const i of picks) moveReturned(env, card(i), m[3], m[4]);
  // Vengeful Regrowth: "Create that many 4/2 Plant Warrior tokens"
  env.lastAmount = picks.length;
  env.thatMuch = picks.length;
  env.them_ = picks;
});
function moveReturned(env, c, dest, tapped) {
  const nm = nameTag(c);
  if (/battlefield/.test(dest)) {
    const sent = String(env.sentence || '').toLowerCase();
    toBattlefield(c.iid, /under your control/.test(sent) ? env.me : c.owner, { tapped: !!tapped });
    const y = card(c.iid);
    // Grim Reaper, Interceptor: "… to the battlefield tapped and attacking (with a finality counter on it)"
    if (y && y.zone === 'battlefield') {
      if (/tapped and attacking/.test(sent) && G.s.combat) {
        y.tapped = true;
        y.attacking = true;
        if (!G.s.combat.attackers.includes(y.iid)) G.s.combat.attackers.push(y.iid);
        const tg = G.s.combat.targets || (G.s.combat.targets = {});
        const first = G.s.combat.attackers.find((a) => a !== y.iid && tg[a]);
        tg[y.iid] = (first && tg[first]) || opp(env.me);
      }
      const cm = sent.match(/with an? ([a-z+\/0-9-]+) counter on it/);
      if (cm) addCounters(y, cm[1], 1);
      // Pre-War Formalwear: "… to the battlefield and attach ~ to it"
      if (/ and attach (?:~|this (?:equipment|aura|artifact)) to it\b/.test(sent) && env.src && card(env.src.iid) && card(env.src.iid).zone === 'battlefield' && isCreature(y)) {
        attachTo(card(env.src.iid), y);
        var attachNote = `attaches ${nameTag(card(env.src.iid))} to it`;
      }
    }
  } else if (/top of your library/.test(dest)) move(c.iid, 'library');
  else move(c.iid, 'hand');
  env.it = { iid: c.iid };
  env.did.push(`returns ${nm} to ${/battlefield/.test(dest) ? 'the battlefield' : /library/.test(dest) ? 'the top of the library' : 'hand'}`);
  if (typeof attachNote === 'string') env.did.push(attachNote);
}
on(/^put (?:an?|up to (\w+)) ((?:[a-z]+ )?(?:land|creature|permanent|[a-z]+)|[a-z]+(?:, [a-z]+)*,? or [a-z]+) cards? from your hand onto the battlefield( tapped)?/, async (m, env) => {
  const k = m[1] ? n(m[1]) : 1;
  // Dr. Eggman: "a Construct, Robot, or Vehicle card"
  const pool = cardsIn(env.me, 'hand').filter((c) => (/ or /.test(m[2]) ? matchesAny(c, m[2]) : matchesFilter(c, m[2])) && (m[2] !== 'permanent' || isPermanentCard(DB[c.def])));
  if (!pool.length) return;
  const picks = await env.choosers[env.me].pickCards({ prompt: `Put ${k > 1 ? 'up to ' + k : 'a'} ${m[2]} card${k > 1 ? 's' : ''} from your hand onto the battlefield`, cards: pool.map((c) => c.iid), min: 0, max: k, purpose: 'cheat', src: env.src, aiScore: (c) => DB[c.def].cmc });
  for (const i of picks) {
    toBattlefield(i, env.me, { tapped: !!m[3] });
    env.did.push(`puts ${nameTag(card(i))} onto the battlefield`);
  }
});

// --- looking at the library
on(/^look at the top (\w+) cards? of (?:your|target player's) library(?:\. put (\w+|up to \w+) of them into your hand and the rest (?:on the bottom of your library|into your graveyard)(?: in (?:any|a random) order)?)?/, async (m, env) => {
  const k = n(m[1], env.x);
  const ids = libTop(env.me, k);
  const rest = env.text.toLowerCase();
  // Ureni of the Unwritten, Selvala's Stampede & co.: "You may put a Dragon creature card from among them onto the battlefield"
  const bf = rest.match(/(?:you may )?put (a|an|one|two|up to (?:one|two|three)|any number of) ([^.]*?)cards? from among them onto the battlefield( tapped(?: and attacking)?)?/);
  let mm = bf || rest.match(/(?:you may reveal|put) (a|an|one|two|up to (?:one|two|three)) ([^.]*?)cards? (?:from among them|of them)? ?(?:and put (?:it|them) )?into your hand/) || rest.match(/put (\w+) of them into your hand/);
  const take = mm ? (/any number/.test(mm[1]) ? k : n(mm[1].replace(/up to /, ''))) : 1;
  const filter = mm && mm[2] && !/^of (?:those|them|these)\b/.test(mm[2].trim()) ? mm[2].trim() : '';
  // Acclaimed Contender: "a Knight, Aura, Equipment, or legendary artifact card" — any of the listed kinds
  const fparts = filter.replace(/^(?:a|an) /, '').split(/,\s*(?:or\s+)?|\s+or\s+/).map((x) => x.trim()).filter(Boolean);
  const pool = ids.filter((i) => !filter || (fparts.length > 1 ? fparts.some((f) => matchesFilter(card(i), f)) : matchesFilter(card(i), filter.replace(/^(?:a|an) /, ''))));
  const picks = pool.length ? await env.choosers[env.me].pickCards({
    prompt: `Look at the top ${k}: choose ${take > 1 ? 'up to ' + take : 'one'}${filter ? ' ' + filter : ''} to put ${bf ? 'onto the battlefield' : 'into your hand'}`, cards: pool, min: 0, max: Math.min(take, pool.length), purpose: bf ? 'cheat' : 'dig', src: env.src,
    aiScore: (c) => (bf ? DB[c.def].cmc + 1 : isLand(c) ? (cardsIn(env.me, 'battlefield').filter(isLand).length < 5 ? 3 : 0) : DB[c.def].cmc + 1),
  }) : [];
  for (const i of picks) {
    if (bf) {
      toBattlefield(i, env.me, { tapped: !!bf[3] });
      env.did.push(`puts ${nameTag(card(i))} onto the battlefield${/attacking/.test(bf[3] || '') ? ' tapped and attacking' : ''}`);
      // Arthur, Marigold Knight: "… tapped and attacking … Return that creature to its owner's hand at end of combat."
      const pc = card(i);
      if (pc && /attacking/.test(bf[3] || '') && G.s.combat && isCreature(pc)) {
        G.s.combat.attackers.push(i);
        joinAttack(i, env.src && env.src.iid);
        pc.attacking = true;
      }
      if (pc && /return that creature to its owner's hand at end of combat/.test(rest)) pc.endOfCombat = 'hand';
    } else move(i, 'hand');
  }
  const toGy = /rest into your graveyard/.test(rest);
  for (const i of ids) if (!picks.includes(i)) move(i, toGy ? 'graveyard' : 'library', toGy ? {} : { to: 'bottom' });
  if (!bf || !picks.length) env.did.push(`looks at the top ${k}${bf ? '' : ` and takes ${picks.length}`}`);
}, { consumesRest: true });
on(/^reveal the top (\w+) cards? of your library\. put (?:all|each) ([a-z ]+?) cards? revealed this way into your hand(?: and the rest (?:on the bottom|into your graveyard))?/, async (m, env) => {
  const ids = libTop(env.me, n(m[1], env.x));
  const hits = ids.filter((i) => matchesFilter(card(i), m[2]));
  hits.forEach((i) => move(i, 'hand'));
  const toGy = /into your graveyard/.test(env.sentence);
  ids.filter((i) => !hits.includes(i)).forEach((i) => move(i, toGy ? 'graveyard' : 'library', toGy ? {} : { to: 'bottom' }));
  env.did.push(`reveals ${ids.length}, takes ${hits.length}`);
}, { multi: true });
on(/^(?:you )?(scry|surveil) (\d+|x)/, async (m, env) => {
  const sv = m[1] === 'surveil';
  let k = n(m[2], env.x);
  // Enhanced Surveillance and friends: look at additional cards each time you surveil
  if (sv) for (const c of cardsIn(env.me, 'battlefield')) {
    const em = oracle(c).match(/look at an additional (\w+) cards? each time you surveil/i);
    if (em) k += n(em[1]);
  }
  const before = new Set(zoneOf(env.me, 'graveyard'));
  await env.choosers[env.me].scry({ n: k, surveil: sv, src: env.src, pid: env.me });
  const toGy = zoneOf(env.me, 'graveyard').filter((i) => !before.has(i));
  env.surveilled = toGy;
  const ts = (G.s.ts || {})[env.me];
  if (ts) {
    ts.scried = true;
    if (sv) ts.surveilledCards = [...(ts.surveilledCards || []), ...toGy];
  }
  queueEvent({ type: sv ? 'surveil' : 'scry', pid: env.me, n: k, toGraveyard: toGy.length });
  env.did.push(`${m[1]} ${k}${toGy.length ? ` (${toGy.length} to the graveyard)` : ''}`);
});
// "If you put a noncreature, nonland card into your graveyard this way, put that card into your hand."
on(/^if you put an? ([a-z, ]+?) card into your graveyard this way, put that card into your hand/, async (m, env) => {
  const words = m[1].split(/,\s*|\s+/).filter(Boolean);
  const hit = (env.surveilled || []).find((i) => {
    const c = card(i);
    if (!c || c.zone !== 'graveyard') return false;
    return words.every((w) => (w.startsWith('non') ? !isType(c, w.slice(3)) : isType(c, w)));
  });
  if (!hit) return;
  move(hit, 'hand');
  env.did.push(`returns ${cardName(card(hit))} to hand`);
});
on(/^fateseal (\d+)/, async (m, env) => {
  const k = +m[1];
  const o = opp(env.me);
  const ids = libTop(o, k);
  const picks = await env.choosers[env.me].pickCards({ prompt: `Fateseal ${k}: choose cards to put on the bottom of the opponent's library`, cards: ids, min: 0, max: ids.length, purpose: 'fateseal', src: env.src, aiScore: (c) => DB[c.def].cmc });
  picks.forEach((i) => move(i, 'library', { to: 'bottom' }));
  env.did.push(`fateseals ${k}`);
});
on(/^(~|it|target creature you control|each creature you control|that creature) explores?/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: false });
  for (const c of objs) {
    const [top] = libTop(env.me, 1);
    if (!top) continue;
    const tc = card(top);
    if (isLand(tc)) {
      move(top, 'hand');
      env.did.push(`${nameTag(c)} explores: ${nameTag(tc)} to hand`);
    } else {
      addCounters(c, '+1/+1', 1);
      const keep = isAI(env.me) ? DB[tc.def].cmc <= 4 : await env.choosers[env.me].confirm('Explore', `Keep ${cardName(tc)} on top of your library? (No puts it into your graveyard.)`);
      if (!keep) move(top, 'graveyard');
      env.did.push(`${nameTag(c)} explores (+1/+1 counter${keep ? '' : ', ' + nameTag(tc) + ' milled'})`);
    }
    queueEvent({ type: 'explored', iid: c.iid, controller: env.me });
  }
});
on(/^(?:have )?(~|it|he|she|they|(?:up to (?:one|two) )?(?:another )?target creatures?(?: you control)?|that creature|each creature you control|those creatures) connives?(?: (\w+))?/, async (m, env) => {
  const subj = /^(he|she|they)$/.test(m[1]) ? '~' : m[1];
  const objs = /^up to/.test(subj) || /^~$|^it$|^that creature$/.test(subj) || /target/.test(subj) ? await objects(env, subj, { harm: false }) : await objects(env, subj);
  if (/target|each|those/.test(subj) && !objs.length) return;
  for (const c of objs.length ? objs : [null]) await connive(c, m[2] ? n(m[2], env.x) : 1, env);
});
async function connive(c, k, env) {
  const who_ = c ? ctl(c) : env.me;
  // Leader, Super-Genius: "If a creature you control would connive, instead you draw a card, then that creature connives."
  const extra = cardsIn(who_, 'battlefield').filter((x) => /If a creature you control would connive, instead you draw a card, then that creature connives/i.test(oracle(x))).length;
  if (extra) {
    draw(who_, extra, true);
    env.did.push(`${who(who_)} draw${isAI(who_) ? 's' : ''} ${extra} extra card${extra > 1 ? 's' : ''} before conniving`);
  }
  const me = who_;
  draw(me, k, true);
  const hand = cardsIn(me, 'hand');
  const lands = cardsIn(me, 'battlefield').filter(isLand).length;
  const picks = hand.length ? await env.choosers[me].pickCards({
    forced: true, prompt: `Connive: discard ${k === 1 ? 'a card' : k + ' cards'}${c && c.zone === 'battlefield' ? ` — each nonland card discarded puts a +1/+1 counter on ${cardName(c)}` : ''}`, cards: hand.map((x) => x.iid), min: Math.min(k, hand.length), max: Math.min(k, hand.length),
    purpose: 'discard', src: env.src, aiScore: (x) => (isLand(x) ? (lands >= 6 ? 10 : -10) : DB[x.def].cmc - lands),
  }) : [];
  const nonland = picks.filter((i) => !isLand(card(i))).length;
  env.did.push(`connives: draws ${k}, discards ${picks.map((i) => nameTag(card(i))).join(', ')}`);
  picks.forEach((i) => discardCard(i));
  if (c && nonland && c.zone === 'battlefield') {
    addCounters(c, '+1/+1', nonland);
    env.did.push(`${nameTag(c)} gets ${nonland === 1 ? 'a +1/+1 counter' : nonland + ' +1/+1 counters'}`);
  }
  queueEvent({ type: 'connived', iid: c && c.iid, controller: me });
}
on(/^discover (\d+|x)/, async (m, env) => {
  const k = n(m[1], env.x);
  const lib = zoneOf(env.me, 'library');
  const exiled = [];
  let hit = null;
  while (lib.length) {
    const iid = lib[lib.length - 1];
    const c = card(iid);
    move(iid, 'exile');
    if (!isLand(c) && DB[c.def].cmc <= k) {
      hit = c;
      break;
    }
    exiled.push(iid);
  }
  if (hit) {
    const cast = await env.choosers[env.me].confirm('Discover', `Cast ${cardName(hit)} without paying its mana cost? (No puts it into your hand.)`, env);
    if (cast && env.castFree) await env.castFree(env.me, hit.iid);
    else move(hit.iid, 'hand');
    env.did.push(`discovers ${nameTag(hit)}${cast ? ' and casts it' : ''}`);
  }
  env.discovered = hit ? { iid: hit.iid, mv: DB[hit.def].cmc || 0 } : { mv: k };
  exiled.sort(() => Math.random() - 0.5).forEach((i) => move(i, 'library', { to: 'bottom' }));
});
// Hit the Mother Lode: "If the discovered card's mana value is less than 10, create a number of tapped Treasure tokens equal to the difference."
on(/^if the discovered card's mana value is less than (\d+), create a number of (tapped )?treasure tokens equal to the difference/, async (m, env) => {
  const mv = env.discovered ? env.discovered.mv : +m[1];
  const k = Math.max(0, +m[1] - mv);
  if (!k) return env.did.push('no Treasures (mana value too high)');
  createToken(genericTokenDef(0, 0, 'Treasure'), env.me, k, { tapped: !!m[2] });
  env.did.push(`creates ${k} ${m[2] ? 'tapped ' : ''}Treasure token${k === 1 ? '' : 's'}`);
}, { first: true });
on(/^cascade/, async () => {}, { never: true });
on(/^manifest (dread|the top card of (?:your|their) library|the top (\w+) cards of (?:your|their) library)/, async (m, env) => {
  const k = m[1] === 'dread' ? 2 : m[2] ? n(m[2]) : 1;
  const ids = libTop(env.me, k);
  if (!ids.length) env.did.push(`${who(env.me)} ${isAI(env.me) ? 'has' : 'have'} no cards to manifest`);
  if (!ids.length) return;
  let pick = ids[0];
  if (m[1] === 'dread' && ids.length > 1) [pick] = await env.choosers[env.me].pickCards({ prompt: 'Manifest dread: choose one to manifest (the other goes to your graveyard)', cards: ids, min: 1, max: 1, purpose: 'manifest', src: env.src, aiScore: (c) => (isCreature(c) ? 5 : 0) + DB[c.def].cmc });
  for (const i of ids) if (i !== pick && m[1] === 'dread') move(i, 'graveyard');
  toBattlefield(pick, env.me, { faceDown: true });
  card(pick).manifested = true;
  env.did.push(m[1] === 'dread' ? 'manifests dread' : 'manifests the top card');
});
// Behold (Tarkir: Dragonstorm): "you may behold a Dragon" — choose a Dragon you control or reveal a Dragon card from your hand
on(/^(you may )?behold an? ([a-z]+)$/, async (m, env) => {
  const kind = m[2];
  const onField = cardsIn(env.me, 'battlefield').filter((c) => matchesFilter(c, kind));
  const inHand = cardsIn(env.me, 'hand').filter((c) => matchesAny(c, kind));
  if (!onField.length && !inHand.length) {
    env.lastMay = false;
    return env.did.push(`has no ${kind} to behold`);
  }
  const yes = !m[1] || isAI(env.me) || (await env.choosers.p.confirm(cardName(env.src), `Behold a ${kind}?`, {}));
  env.lastMay = !!yes;
  if (!yes) return;
  const shown = onField[0] || inHand[0];
  env.beheld = shown.iid;
  env.did.push(`beholds ${onField.length ? nameTag(shown) : `${nameTag(shown)} (revealed from hand)`}`);
}, { first: true });
// Kozilek, the Broken Reality: "up to two target players each manifest two cards from their hands.
// For each card manifested this way, you draw a card."
on(/^up to (one|two) target players each manifest (\w+) cards? from their hands?$/, async (m, env) => {
  const k = n(m[2]);
  const pids = [];
  for (const pid of [env.me, ...opponents(env.me)]) {
    if (!cardsIn(pid, 'hand').length) continue;
    const yes = isAI(env.me)
      ? pid === env.me || cardsIn(pid, 'hand').length >= 2 // itself (lands become 2/2s), and the opponent when it has cards to lose
      : await env.choosers.p.confirm(cardName(env.src), `Target ${pid === 'p' ? 'yourself' : 'the AI'}? ${pid === 'p' ? 'You' : 'It'} manifest${pid === 'p' ? '' : 's'} ${k} cards from ${pid === 'p' ? 'your' : 'its'} hand and you draw that many.`, {});
    if (yes) pids.push(pid);
  }
  let total = 0;
  for (const pid of pids.slice(0, n(m[1]))) {
    const hand = cardsIn(pid, 'hand');
    const want = Math.min(k, hand.length);
    const picks = await env.choosers[pid].pickCards({ forced: true, prompt: `Manifest ${want} card${want === 1 ? '' : 's'} from your hand (face down 2/2 creatures)`, cards: hand.map((c) => c.iid), min: want, max: want, purpose: 'manifest', src: env.src, aiScore: (c) => (isLand(c) ? 8 : isCreature(c) ? 4 - (DB[c.def].cmc || 0) / 2 : -(DB[c.def].cmc || 0)) });
    for (const i of picks) {
      toBattlefield(i, pid, { faceDown: true });
      if (card(i)) card(i).manifested = true;
    }
    total += picks.length;
    env.did.push(`${who(pid)} ${s_(pid, 'manifest')} ${picks.length} card${picks.length === 1 ? '' : 's'} from hand`);
  }
  env.manifestedN = total;
}, { first: true });
on(/^for each card manifested this way, you draw a card$/, async (m, env) => {
  const k = env.manifestedN || 0;
  if (k) draw(env.me, k, true);
  env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${k}`);
}, { first: true });
on(/^cloak (the top card of your library|.+)$/, async (m, env) => {
  const [top] = libTop(env.me, 1);
  if (!top) return;
  toBattlefield(top, env.me, { faceDown: true });
  card(top).manifested = true;
  card(top).wardTwo = true;
  env.did.push('cloaks the top card');
});
on(/^clash with (?:an|target) opponent/, async (m, env) => {
  const mine = libTop(env.me, 1)[0];
  const theirs = libTop(opp(env.me), 1)[0];
  const a = mine ? DB[card(mine).def].cmc : -1;
  const b = theirs ? DB[card(theirs).def].cmc : -1;
  env.wonClash = a > b;
  env.lastMay = env.wonClash;
  env.did.push(`clashes (${a} vs ${b}) and ${env.wonClash ? 'wins' : 'loses'}`);
});
on(/^flip a coin/, async (m, env) => {
  env.wonFlip = Math.random() < 0.5;
  env.did.push(`flips a coin and ${env.wonFlip ? 'wins' : 'loses'}`);
});
on(/^roll (?:a|an) (d\d+|six-sided die|twenty-sided die)/, async (m, env) => {
  const sides = /20|twenty/.test(m[1]) ? 20 : /6|six/.test(m[1]) ? 6 : +(m[1].match(/\d+/) || [6])[0];
  const r = 1 + Math.floor(Math.random() * sides);
  env.roll = r;
  env.lastAmount = r;
  env.did.push(`rolls a d${sides}: ${r}`);
  // die-result tables follow on lines like "1—9 | effect"
  // the table is on the card's own lines, not always part of this ability's text (Chaos Channeler's attack trigger)
  const rowRe = /(?:^|\n)(\d+)(?:(?:—|-|–)(\d+))? ?\| ?([^\n]+)/g;
  let rows = [...String(env.fullText || '').matchAll(rowRe)];
  if (!rows.length && env.src) rows = [...stripName(oracle(env.src), env.src).matchAll(rowRe)];
  for (const row of rows) {
    const lo = +row[1];
    const hi = row[2] ? +row[2] : lo;
    if (r >= lo && r <= hi) {
      await runText(row[3], env);
      break;
    }
  }
});

// --- the turn, the game
on(/^(?:you )?take an extra turn after this one/, async (m, env) => {
  G.s.extraTurns[env.me] = (G.s.extraTurns[env.me] || 0) + 1;
  env.did.push(`${who(env.me)} will take an extra turn`);
});
on(/^(?:after this (?:main |combat )?phase, )?there is an additional combat phase/, async (m, env) => {
  G.s.extraCombats = (G.s.extraCombats || 0) + 1;
  env.did.push('adds an extra combat phase');
});
// Tifa, Martial Artist
on(/^if it's the first combat phase of your turn, there is an additional combat phase after this phase$/, async (m, env) => {
  const ct = G.s.combatsThisTurn;
  if (G.s.active !== env.me || (ct && ct.turn === G.s.turn && ct.n > 1)) return env.did.push('no extra combat (not the first combat)');
  G.s.extraCombats = (G.s.extraCombats || 0) + 1;
  env.did.push('adds an extra combat phase');
}, { first: true });
on(/^prevent all combat damage that would be dealt this turn/, async (m, env) => {
  G.s.fogTurn = G.s.turn;
  env.did.push('prevents all combat damage this turn');
});
on(/^prevent all (?:combat )?damage that would be dealt (?:to and dealt )?by (.+?) this turn/, async (m, env) => {
  const objs = await objects(env, m[1]);
  objs.forEach((c) => (c.eotGrants = [...(c.eotGrants || []), 'protection from everything']));
  env.did.push(`prevents damage from ${objs.map(nameTag).join(', ')}`);
});
on(/^(?:you )?become the monarch/, async (m, env) => {
  if (G.s.monarch !== env.me) queueEvent({ type: 'becameMonarch', pid: env.me });
  G.s.monarch = env.me;
  env.did.push(`${who(env.me)} ${env.me === 'p' ? 'become' : 'becomes'} the monarch`);
});
on(/^(?:you )?take the initiative/, async (m, env) => {
  await takeInitiative(env.me, env);
  env.did.push(`${who(env.me)} ${s_(env.me, 'take')} the initiative`);
});
on(/^venture into the dungeon(?: (\w+) times)?/, async (m, env) => {
  const k = m[1] ? n(m[1]) : 1;
  for (let i = 0; i < k; i++) env.did.push(...(await venture(env.me, env)));
});
on(/^(?:it becomes|if it's neither day nor night, it becomes) (day|night)/, async (m, env) => {
  G.s.dayNight = m[1];
  env.did.push(`it becomes ${m[1]}`);
});
on(/^the ring tempts you/, async (m, env) => {
  const pl = G.s.players[env.me];
  pl.ring = Math.min(4, (pl.ring || 0) + 1);
  pl.ringTimes = (pl.ringTimes || 0) + 1;
  const cs = cardsIn(env.me, 'battlefield').filter(isCreature);
  if (cs.length) {
    const [pick] = await env.choosers[env.me].pickCards({ forced: true, prompt: 'The Ring tempts you: choose your Ring-bearer',
      detail: `The Ring is now at level ${pl.ring} of 4. Your Ring-bearer gets:\n` + RING_TEXT.slice(0, pl.ring).map((t, k) => `${k + 1}. ${t}`).join('\n') + (pl.ring < 4 ? `\n(Next time: ${RING_TEXT[pl.ring]})` : ''), cards: cs.map((c) => c.iid), min: 1, max: 1, purpose: 'ringbearer', src: env.src, aiScore: (c) => (hasKw(c, 'flying') ? 3 : 0) + power(c) });
    for (const c of cs) c.ringBearer = false;
    card(pick).ringBearer = true;
    pl.ringBearer = pick;
    env.did.push(`the Ring tempts ${who(env.me)} (level ${pl.ring}); ${nameTag(card(pick))} is the Ring-bearer`);
  } else env.did.push(`the Ring tempts ${who(env.me)} (level ${pl.ring})`);
  // the table shows what the Ring now does (you already saw it if you just picked your Ring-bearer)
  if (env.me !== 'p' || !cs.length) (G.s.ringNotes = G.s.ringNotes || []).push(env.me);
  queueEvent({ type: 'ringTempts', pid: env.me });
});
on(/^(?:you )?win the game/, async (m, env) => {
  winGame(env.me, `${cardName(env.src)} says so`);
  env.did.push('wins the game');
});
on(/^(?:you )?lose the game/, async (m, env) => {
  loseGame(env.me, `${cardName(env.src)}`);
  env.did.push('loses the game');
});
on(/^(?:target player|each player) shuffles (?:their|his or her) hand (?:and graveyard )?into (?:their|his or her) library, then draws (seven|\w+) cards/, async (m, env) => {
  for (const pid of seats()) {
    [...zoneOf(pid, 'hand')].forEach((i) => move(i, 'library'));
    if (/graveyard/.test(env.sentence)) [...zoneOf(pid, 'graveyard')].forEach((i) => move(i, 'library'));
    shuffle(pid);
    draw(pid, n(m[1]), true);
  }
  env.did.push(`each player shuffles and draws ${n(m[1])}`);
});
// Windfall: "Each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way."
on(/^each player discards (?:their|his or her) hand,? then draws cards equal to the greatest number of cards a player discarded this way/, async (m, env) => {
  let most = 0;
  for (const pid of seats()) {
    const hand = [...zoneOf(pid, 'hand')];
    hand.forEach((i) => discardCard(i));
    most = Math.max(most, hand.length);
  }
  for (const pid of seats()) draw(pid, most, true);
  env.lastAmount = most;
  env.did.push(`each player discards their hand and draws ${most}`);
}, { first: true });
on(/^each player discards (?:their|his or her) hand,? then draws (seven|\w+) cards/, async (m, env) => {
  for (const pid of seats()) {
    [...zoneOf(pid, 'hand')].forEach((i) => discardCard(i));
    draw(pid, n(m[1]), true);
  }
  env.did.push(`each player wheels for ${n(m[1])}`);
});
on(/^(?:you )?(?:may )?play (?:up to )?(an|one|two|three) additional lands? this turn/, async (m, env) => {
  const k = /^(an|one)$/.test(m[1]) ? 1 : n(m[1]);
  G.s.extraLandThisTurn = (G.s.extraLandThisTurn || 0) + k;
  env.did.push(`may play ${k === 1 ? 'an additional land' : k + ' additional lands'} this turn`);
});

// --- mana (rituals): a small mana pool, emptied between steps
on(/^add ((?:\{[wubrgc]\})+)(?: for each ([^.]+))?/, async (m, env) => {
  let syms = m[1].toUpperCase().match(/[WUBRGC]/g);
  if (m[2]) {
    const k = countPhrase(env.me, m[2], helpers, env.src.iid) || 0;
    syms = Array.from({ length: k }, () => syms).flat();
  }
  // Cabal Ritual: "Add {B}{B}{B}{B}{B} instead if …" replaces what was just added
  if (/\binstead\b/.test(env.sentence) && env.lastAdded && G.s.pool) {
    for (const x of env.lastAdded) {
      const i = G.s.pool[env.me].lastIndexOf(x);
      if (i >= 0) G.s.pool[env.me].splice(i, 1);
    }
  }
  addMana(env.me, syms);
  env.lastAdded = syms;
  env.lastManaAdded = { list: syms }; // Rousing Refrain: "Until end of turn, you don't lose this mana…"
  env.did.push(`adds ${syms.map((x) => `{${x}}`).join('') || 'no mana'}`);
});
// Irencrag Feat: "Add seven {R}."
on(/^add (two|three|four|five|six|seven|eight|nine|ten|x|\d+) (\{[wubrgc]\})(?: for each ([^.]+))?$/, async (m, env) => {
  let k = n(m[1], env.x);
  if (m[3]) k *= countPhrase(env.me, m[3], helpers, env.src.iid) || 0;
  const syms = Array.from({ length: k }, () => m[2][1].toUpperCase());
  addMana(env.me, syms);
  env.lastAdded = syms;
  env.lastManaAdded = { list: syms };
  env.did.push(`adds ${syms.map((x) => `{${x}}`).join('')}`);
});
// Mana Seism: "… then add that much {C}"
on(/^add that much (\{[wubrgc]\})$/, async (m, env) => {
  const k = env.lastAmount || 0;
  const syms = Array.from({ length: k }, () => m[1][1].toUpperCase());
  addMana(env.me, syms);
  env.did.push(`adds ${syms.map((x) => `{${x}}`).join('') || 'no mana'}`);
});
on(/^sacrifice any number of (other )?(lands|creatures|artifacts|permanents|nonland permanents)(?: you control)?$/, async (m, env) => {
  const kind = m[2].replace(/s$/, '');
  const pool = cardsIn(env.me, 'battlefield').filter((c) => (!m[1] || !env.src || c.iid !== env.src.iid) && matchesAny(c, kind));
  // the AI gives up only what it won't miss: Treasures/Clues/Food, 1-power tokens, and tapped lands beyond its seventh
  const landsOut = cardsIn(env.me, 'battlefield').filter(isLand).length;
  const spare = (c) => (c.token && !isCreature(c) ? 3 : c.token && isCreature(c) && power(c) <= 1 ? 2 : isLand(c) ? (c.tapped && landsOut > 7 ? 1 : -2) : -cardValue(c));
  let chosen = [];
  if (pool.length && isAI(env.me)) {
    let lands = landsOut;
    for (const c of pool.filter((c) => spare(c) > 0)) {
      if (isLand(c)) { if (lands <= 7) continue; lands--; }
      chosen.push(c.iid);
    }
  } else if (pool.length) chosen = await env.choosers[env.me].pickCards({ prompt: `Sacrifice any number of ${m[1] || ''}${m[2]}`, cards: pool.map((c) => c.iid), min: 0, max: pool.length, purpose: 'sacrifice', src: env.src, aiScore: spare });
  for (const i of chosen) sacrifice(i);
  env.lastAmount = chosen.length;
  env.did.push(`sacrifices ${chosen.length} ${chosen.length === 1 ? kind : m[2]}`);
});
on(/^if you control a creature with power (\d+) or greater, add (two|three) mana of any one color instead$/, async (m, env) => {
  if (!cardsIn(env.me, 'battlefield').some((c) => isCreature(c) && power(c) >= +m[1])) return;
  const pool = (G.s.pool && G.s.pool[env.me]) || [];
  const i = pool.lastIndexOf('ANY');
  if (i >= 0) pool.splice(i, 1);
  const k = n(m[2]);
  addMana(env.me, Array.from({ length: k }, () => 'ANY'));
  env.did.push(`adds ${k} mana of one color instead`);
}, { first: true });
on(/^add (one|two|three|x|\d+) mana of any (?:one )?color/, async (m, env) => {
  const k = n(m[1], env.x);
  addMana(env.me, Array.from({ length: k }, () => 'ANY'));
  env.did.push(`adds ${k} mana of any color`);
});
on(/^add (x|\d+|one|two|three|four|five) mana in any combination of colors/, async (m, env) => {
  let k = n(m[1], env.x);
  // Hazel of the Rootbloom: "{T}, Pay 2 life, Tap X untapped tokens you control: Add X mana in any combination of colors."
  if (m[1] === 'x' && env.src && /Tap X untapped tokens you control: Add X mana/i.test(oracle(env.src))) {
    const pool = cardsIn(env.me, 'battlefield').filter((c) => c.token && !c.tapped && !c.phasedOut);
    const picks = pool.length ? await env.choosers[env.me].pickCards({ prompt: 'Tap any number of untapped tokens (one mana each)', cards: pool.map((c) => c.iid), min: 0, max: pool.length, purpose: 'tapCost', src: env.src, aiScore: (c) => (isCreature(c) ? -1 : 1) }) : [];
    picks.forEach((i) => card(i) && tapPerm(card(i)));
    k = picks.length;
  }
  addMana(env.me, Array.from({ length: k }, () => 'ANY'));
  env.did.push(`adds ${k} mana`);
});
on(/^for each color among permanents you control, add one mana of that color/, async (m, env) => {
  const syms = colorsAmong(env.me);
  addMana(env.me, syms);
  env.did.push(syms.length ? `adds ${syms.map((x) => `{${x}}`).join('')}` : 'adds no mana');
});
export function colorsAmong(pid) {
  const set = new Set();
  for (const iid of G.s.players[pid].zones.battlefield) {
    const c = G.s.cards[iid];
    if (c && !c.phasedOut) for (const col of DB[c.def].colors || []) set.add(col);
  }
  return ['W', 'U', 'B', 'R', 'G'].filter((x) => set.has(x));
}
export function addMana(pid, syms) {
  G.s.pool = G.s.pool || Object.fromEntries(seats().map((k) => [k, []]));
  G.s.pool[pid].push(...syms);
}

// --- Space sculptor sectors (Space Beleren)
async function chooseSector(env, what, score) {
  const inSec = (sec) => seats().flatMap((k) => cardsIn(k, 'battlefield')).filter((c) => isCreature(c) && c.sector === sec);
  const k = await env.choosers[env.me].choose({
    prompt: `${cardName(env.src)}: choose a sector — ${what}`,
    options: SECTORS.map((sec) => {
      const cs = inSec(sec);
      return { label: `${SECTOR_SIGN[sec]} ${sec[0].toUpperCase() + sec.slice(1)}`, detail: cs.length ? cs.map((c) => cardName(c) + (c.controller === 'p' ? ' (you)' : ' (AI)')).join(', ') : 'no creatures' };
    }),
    aiPick: () => SECTORS.map((sec, i) => [i, score(inSec(sec))]).sort((a, b) => b[1] - a[1])[0][0],
  });
  const sec = SECTORS[k] || 'alpha';
  return { sec, cards: inSec(sec) };
}
on(/^creatures in each sector can be blocked this turn only by creatures in the same sector/, async (m, env) => {
  G.s.sectorBlockTurn = G.s.turn;
  env.did.push('creatures can only be blocked by creatures in the same sector this turn');
}, { first: true });
on(/^put an? \+1\/\+1 counter on each creature in the sector of your choice/, async (m, env) => {
  const { sec, cards } = await chooseSector(env, 'put a +1/+1 counter on each creature there', (cs) => cs.reduce((a, c) => a + (c.controller === env.me ? 1 : -1), 0));
  for (const c of cards) addCounters(c, '+1/+1', 1);
  env.did.push(`puts a +1/+1 counter on each creature in the ${sec} sector (${cards.length})`);
}, { first: true });
on(/^destroy all creatures in the sector of your choice/, async (m, env) => {
  const { sec, cards } = await chooseSector(env, 'destroy all creatures there', (cs) => cs.reduce((a, c) => a + (c.controller === env.me ? -1 : 1) * (cardValue(c) + 1), 0));
  for (const c of cards) destroy(c.iid);
  env.did.push(`destroys all creatures in the ${sec} sector (${cards.length})`);
}, { first: true });
// --- auras, equipment, attaching
on(/^(?:you may )?attach (?:this aura|~) to (that player|target player|target opponent|you)$/, async (m, env) => {
  const pl = m[1] === 'you' ? env.me : m[1] === 'that player' ? env.thatPlayer || opp(env.me) : opp(env.me);
  if (!env.src || !pl) return;
  if (env.src.enchantedPlayer === pl) return;
  if (/^you may/.test(env.sentence || '') && !(await mayAsk(env, `attach ${cardName(env.src)} to ${seatName(pl)}`))) return;
  env.src.enchantedPlayer = pl;
  delete env.src.attachedTo;
  env.did.push(`now enchants ${seatName(pl)}`);
});
on(/^attach (~|it|target [^.]+?) to (.+?)(?:\.|$)/, async (m, env) => {
  const [what] = await objects(env, m[1], { harm: false });
  const [to] = await objects(env, m[2], { harm: false });
  if (what && to) {
    attachTo(what, to);
    env.did.push(`attaches ${nameTag(what)} to ${nameTag(to)}`);
  }
});

// Disa the Restless: "put it onto the battlefield"
on(/^put (it|that card) onto the battlefield( tapped)?( under your control)?$/, async (m, env) => {
  const c = env.it && env.it.iid ? card(env.it.iid) : null;
  if (!c || c.zone === 'battlefield') return;
  toBattlefield(c.iid, m[3] ? env.me : c.owner, { tapped: !!m[2] });
  env.did.push(`puts ${nameTag(c)} onto the battlefield`);
}, { first: true });
// Villainous choice (Doctor Who, Marvel): the opponent picks one of two outcomes.
// "each opponent faces…", "that player faces…", "…, then faces…" (This Is How It Ends), Davros's "who lost 3 or more life this turn".
// The Valeyard: the opponent faces each villainous choice one more time.
function villainCost(text, them, me) {
  // how bad an outcome is for the player choosing (them): the AI takes the cheaper one
  const t = text.toLowerCase();
  let v = 0;
  const creatures = cardsIn(them, 'battlefield').filter(isCreature);
  const lose = t.match(/lose (\w+) life/);
  if (lose) v += G.s.players[them].life <= n(lose[1]) ? 100 : n(lose[1]) * 0.6;
  if (/sacrifices? (?:a|one) (nontoken )?creature/.test(t)) {
    const pool = creatures.filter((c) => !(/nontoken/.test(t) && c.token));
    v += pool.length ? Math.min(...pool.map(cardValue)) + 0.5 : 0;
  }
  const disc = t.match(/discards? (a|one|two|three|\w+) cards?/);
  if (disc) v += Math.min(n(disc[1]), cardsIn(them, 'hand').length) * 1.2;
  if (/discards? all the cards in (?:their|your) hand/.test(t)) v += 0.5;
  const dr = t.match(/you draw (a|one|two|three|\w+) cards?/);
  if (dr) v += n(dr[1]) * 1.3;
  if (/chaos ensues/.test(t)) v += 0.5;
  if (/you create [^,]*token/.test(t)) v += /copy/.test(t) ? 4 : 3;
  if (/you gain control/.test(t)) v += creatures.length ? Math.max(...creatures.map(cardValue)) : 0;
  if (/you may cast a spell from your hand without paying/.test(t)) v += 4;
  if (/you may put [^,]* card from your hand onto the battlefield/.test(t)) v += 3;
  if (/shuffles? another creature they own into their library/.test(t)) v += creatures.length ? Math.min(...creatures.map(cardValue)) : 0;
  if (/deals damage to that player equal to the number of cards in their hand/.test(t)) v += cardsIn(them, 'hand').length * 0.6;
  if (/each artifact creature you control deals (\w+) damage/.test(t)) v += cardsIn(me, 'battlefield').filter((c) => isCreature(c) && isType(c, 'Artifact')).length * n(t.match(/deals (\w+) damage/)[1]) * 0.6;
  if (/exiles? the top (\w+) cards of their library and .* deals damage equal to the total mana value/.test(t)) v += 6;
  if (/exile cards from the top of their library until they exile a nonland card, then you may cast/.test(t)) v += 3.5;
  if (/becomes a 1\/1/.test(t)) v += 3;
  if (/destroy all dalek/.test(t)) v += 2;
  return v;
}
async function villainousChoice(env, them, opts, label) {
  const times = 1 + cardsIn(env.me, 'battlefield').filter((c) => /If an opponent would face a villainous choice, they face that choice an additional time/i.test(oracle(c))).length;
  for (let i = 0; i < times; i++) {
    const k = await env.choosers[them].choose({
      prompt: `${label || cardName(env.src)}: villainous choice${times > 1 ? ` (${i + 1} of ${times})` : ''} — ${them === 'p' ? 'you choose' : 'the AI chooses'}`,
      // the choices as you read them: "they lose 5 life" is you, "you draw two cards" is the AI
      options: opts.map((o) => {
        let t = o;
        t = origCase(env, t);
        if (them === 'p' && env.me !== 'p') t = t.replace(/\byour\b/g, '\u0001').replace(/\byou\b/g, 'the AI').replace(/\u0001/g, "the AI's").replace(/\b(?:they|that player|that opponent) (\w+?)s?\b(?= )/gi, (x, v) => `you ${v.replace(/e$/, (e) => (/(?:los|sacrific|shuffl|exil|discard)$/.test(v) ? e : e))}`).replace(/\btheir\b/g, 'your').replace(/\bthey\b/g, 'you').replace(/\bthe AI (\w+)/g, (x, v) => (/s$/.test(v) || /^(?:can|may|will)$/.test(v) ? x : `the AI ${/(?:sh|ch|x)$/.test(v) ? v + 'es' : v + 's'}`));
        return { label: t[0].toUpperCase() + t.slice(1) };
      }),
      aiPick: () => {
        // Damocles Base: sacrifice a nontoken creature, or lose life and the opponent draws — give up a creature that matters little
        if (/sacrifices? a (nontoken )?creature/.test(opts[0]) && /lose \w+ life and you draw/.test(opts[1])) {
          const mine = cardsIn(them, 'battlefield').filter((c) => isCreature(c) && !(/nontoken/.test(opts[0]) && c.token));
          if (!mine.length) return 0;
          const cheapest = Math.min(...mine.map((c) => (DB[c.def].cmc || 0) + power(c)));
          return cheapest <= 4 || G.s.players[them].life <= 6 ? 0 : 1;
        }
        const a = villainCost(opts[0], them, env.me);
        const b = villainCost(opts[1], them, env.me);
        return b < a ? 1 : 0;
      },
    });
    env.thatPlayer = them;
    env.it = { player: them };
    env.did.push(`${who(them)} ${s_(them, 'choose')}: ${opts[k]}`);
    // "they sacrifice …" / "they lose 2 life and you draw two cards" / "that player discards a card"
    const third = (v) => (/(?:s|sh|ch|x|z)$/.test(v) ? v + 'es' : v + 's');
    const pick = opts[k]
      .replace(/^they (\w+)/, (x, v) => `target opponent ${third(v)}`)
      .replace(/^(?:that player|that opponent) /, 'target opponent ')
      .replace(/ (?:they|that player) controls?\b/, '');
    for (const part of pick.split(/(?<=\S) and (?=you |~ |that player |they )/)) await runSentence(part.replace(/^they /, 'target opponent '), env);
  }
}
const origCase = (env, t) => {
  const at = (env.fullText || '').toLowerCase().indexOf(t.toLowerCase());
  return at >= 0 ? env.fullText.slice(at, at + t.length) : t;
};
on(/^(.*?)\b(?:faces|face) a villainous choice — (.+?), or (.+)$/, async (m, env) => {
  let subj = m[1].trim();
  // "Target creature's owner shuffles it into their library, then faces a villainous choice — …"
  const then = subj.match(/^(.+?),? then$/);
  let them = opp(env.me);
  if (then) {
    if (env.it && env.it.iid && card(env.it.iid)) them = card(env.it.iid).owner;
    await runSentence(then[1], env);
    if (env.it && env.it.iid && card(env.it.iid)) them = card(env.it.iid).owner;
    subj = 'that player';
  }
  const lost = subj.match(/who lost (\w+) or more life this turn$/);
  if (lost && ((G.s.ts[them] || {}).lifeLost || 0) < n(lost[1])) return;
  if (them === env.me) them = opp(env.me);
  await villainousChoice(env, them, [m[2], m[3]]);
}, { first: true });
// Hunted by The Family: "Choose up to four target creatures you don't control. For each of them, that creature's controller faces a villainous choice — That creature becomes a 1/1 white Human creature and loses all abilities, or you create a token that's a copy of it."
on(/^choose up to (\w+) target creatures? you don't control$/, async (m, env) => {
  const ts = await objects(env, `up to ${m[1]} target creatures you don't control`);
  env.them_ = ts.map((c) => c.iid);
}, { first: true });
on(/^for each of them, that creature's controller faces a villainous choice — (.+?), or (.+)$/, async (m, env) => {
  m = [m[0], '', m[1], m[2]];
  const ts = (env.them_ || []).map(card).filter((c) => c && c.zone === 'battlefield');
  for (const t of ts) {
    env.it = { iid: t.iid };
    const opts = [m[2], m[3]];
    const k = await env.choosers[t.controller].choose({
      prompt: `${cardName(env.src)}: villainous choice for ${cardName(t)}`,
      options: opts.map((o) => ({ label: o[0].toUpperCase() + o.slice(1) })),
      aiPick: () => (cardValue(t) >= 5 ? 1 : 0),
    });
    env.did.push(`${who(t.controller)} ${s_(t.controller, 'choose')}: ${opts[k]}`);
    if (k === 0) {
      loseAllAbilities(t);
      t.setPT = { ts: nextStamp(), p: 1, t: 1 };
      t.layerFx = [...(t.layerFx || []), { ts: nextStamp(), types: { set: 'Creature', sub: 'Human' }, colors: { set: ['W'] } }];
      env.did.push(`${nameTag(t)} becomes a 1/1 white Human with no abilities`);
    } else {
      const made = createToken(t.def, env.me, 1);
      for (const i of made) card(i).face = t.face || 0;
      env.did.push(`creates a token copy of ${nameTag(t)}`);
    }
  }
}, { first: true });
// Sycorax Commander: "That opponent discards all the cards in their hand, then draws that many cards minus one"
on(/^target opponent discards all the cards in their hand, then draws that many cards minus one$/, async (m, env) => {
  const them = env.thatPlayer || opp(env.me);
  const hand = cardsIn(them, 'hand');
  for (const c of hand) discardCard(c.iid);
  const k = Math.max(0, hand.length - 1);
  if (k) draw(them, k);
  env.did.push(`${who(them)} ${s_(them, 'discard')} ${hand.length} and ${s_(them, 'draw')} ${k}`);
}, { first: true });
// Missy: "Each artifact creature you control deals 1 damage to that opponent"
on(/^each (artifact creature|creature|[a-z]+) you control deals (\w+) damage to (that opponent|that player|target opponent|each opponent)$/, async (m, env) => {
  const them = env.thatPlayer || opp(env.me);
  const srcs = cardsIn(env.me, 'battlefield').filter((c) => matchesFilter(c, m[1]));
  for (const c of srcs) damagePlayer(env, c, them, n(m[2]));
  if (!srcs.length) env.did.push(`no ${m[1]}s to deal damage`);
}, { first: true });
// Ensnared by the Mara: "that player exiles the top four cards of their library and ~ deals damage equal to the total mana value of those exiled cards to that player"
on(/^target opponent exiles the top (\w+) cards of their library and ~ deals damage equal to the total mana value of those exiled cards to that player$/, async (m, env) => {
  const them = env.thatPlayer || opp(env.me);
  const ids = libTop(them, n(m[1]));
  let tot = 0;
  for (const i of ids) {
    tot += DB[card(i).def].cmc || 0;
    move(i, 'exile');
  }
  env.did.push(`exiles ${ids.length} cards from ${who(them)}'s library`);
  if (tot) damagePlayer(env, env.src, them, tot);
}, { first: true });
// This Is How It Ends: "they shuffle another creature they own into their library"
on(/^target opponent shuffles another creature they own into their library$/, async (m, env) => {
  const them = env.thatPlayer || opp(env.me);
  const cs = cardsIn(them, 'battlefield').filter((c) => isCreature(c) && c.owner === them);
  if (!cs.length) return env.did.push('has no other creature');
  const [pick] = await env.choosers[them].pickCards({ forced: true, prompt: 'Shuffle a creature you own into your library', cards: cs.map((c) => c.iid), min: 1, max: 1, purpose: 'shuffle', src: env.src, aiScore: (c) => -cardValue(c) });
  move(pick, 'library');
  shuffle(them);
  env.did.push(`${who(them)} ${s_(them, 'shuffle')} ${nameTag(card(pick))} into ${them === 'p' ? 'your' : 'its'} library`);
}, { first: true });
// Hazel of the Rootbloom: "If that token is a Squirrel, instead create two tokens that are copies of it."
on(/^if that token is an? ([a-z]+), instead create (\w+) tokens that are copies of it/, async (m, env) => {
  const t = env.it && env.it.iid ? card(env.it.iid) : null;
  if (!t || !hasSubtype(t, m[1])) return;
  const extra = Math.max(0, n(m[2]) - 1);
  const made = createToken(t.def, env.me, extra);
  for (const i of made) card(i).face = t.face || 0;
  env.did.push(`creates ${extra} more cop${extra === 1 ? 'y' : 'ies'} (it's a ${m[1]})`);
}, { first: true });
function partySize(pid) {
  const roles = ['Cleric', 'Rogue', 'Warrior', 'Wizard'];
  const cs = cardsIn(pid, 'battlefield').filter(isCreature);
  let best = 0;
  const go = (i, used, k) => {
    if (i === roles.length) return void (best = Math.max(best, k));
    go(i + 1, used, k);
    for (const c of cs) if (!used.has(c.iid) && hasSubtype(c, roles[i])) go(i + 1, new Set([...used, c.iid]), k + 1);
  };
  go(0, new Set(), 0);
  return best;
}
// --- voting (Will of the council, Council's dilemma, Secret council)
// Each player votes, starting with the caster. Brago's Representative / Ballot Broker / Tivit give extra votes.
// The tally lives on env.votes, and the sentences after it read it: "If X gets more votes (or the vote is tied), …",
// "For each X vote, …", "… for each X vote", "a number of … equal to the number of X votes", "each permanent with the most votes".
function extraVotes(pid) {
  let k = 0;
  for (const c of cardsIn(pid, 'battlefield')) {
    const o = oracle(c);
    if (/While voting, you (?:get an additional vote|may vote an additional time)/i.test(o)) k++;
  }
  return k;
}
// How good an outcome sentence is for the caster (rough: the AI only needs to rank two or three choices)
function voteOutcomeValue(text, me) {
  const t = String(text || '').toLowerCase();
  const them = opp(me);
  const foes = opponents(me);
  const creatures = (pid) => cardsIn(pid, 'battlefield').filter(isCreature);
  const all = (f) => foes.flatMap(f); // across every opponent
  const worth = (cs) => cs.reduce((a, c) => a + cardValue(c), 0);
  let v = 0;
  if (/take an extra turn/.test(t)) v += 7;
  const dr = t.match(/draws? (a|one|two|three|four|\w+) cards?/);
  if (dr && !/each opponent draws|each player draws/.test(t)) v += 1.4 * n(dr[1]);
  if (/destroy all (?:other )?creatures|destroy all creatures other than/.test(t)) v += worth(all(creatures)) - worth(creatures(me).filter((c) => !env_src_is(c)));
  if (/destroy all nonland permanents/.test(t)) v += worth(all((k) => cardsIn(k, 'battlefield')).filter((c) => !isLand(c))) - worth(cardsIn(me, 'battlefield').filter((c) => !isLand(c)));
  if (/each player returns each creature card from their graveyard to the battlefield/.test(t)) v += worth(cardsIn(me, 'graveyard').filter((c) => isType(c, 'Creature'))) - worth(all((k) => cardsIn(k, 'graveyard')).filter((c) => isType(c, 'Creature')));
  const lose = t.match(/each opponent loses (\w+) life/);
  if (lose) v += foes.reduce((a, f) => a + n(lose[1]) * (G.s.players[f].life <= n(lose[1]) ? 10 : 0.7), 0);
  if (/each opponent sacrifices a creature/.test(t)) v += foes.reduce((a, f) => a + (creatures(f).length ? Math.min(...creatures(f).map(cardValue)) + 1 : 0), 0);
  const shrink = t.match(/creatures your opponents control get -(\d+)\/-(\d+)/);
  if (shrink) v += worth(all(creatures).filter((c) => toughness(c) - (c.damage || 0) <= +shrink[2])) + 0.5;
  const disc = t.match(/each opponent discards (\w+) cards?/);
  if (disc) v += foes.reduce((a, f) => a + Math.min(n(disc[1]), cardsIn(f, 'hand').length) * 1.1, 0);
  if (/\+1\/\+1 counters? on/.test(t)) v += 1.6;
  if (/create (?:a|one|two|\w+) [^.]*treasure|treasure tokens?/.test(t)) v += 1.4;
  if (/create (?:a|an|one|two|\w+) 1\/1 [^.]*creature token/.test(t)) v += 1.3;
  if (/\binvestigate\b/.test(t)) v += 1.2;
  if (/you gain (\w+) life/.test(t)) v += 0.4 * n(t.match(/you gain (\w+) life/)[1]);
  if (/search your library for a basic land/.test(t)) v += 1.3;
  if (/return a card from your graveyard to your hand/.test(t)) v += cardsIn(me, 'graveyard').length ? 1.5 : 0;
  if (/gain control of/.test(t)) v += 3;
  if (/counter the spell/.test(t)) v += 2;
  if (/copy the spell/.test(t)) v += 2;
  return v;
  function env_src_is(c) { return /other than/.test(t) && voteOutcomeValue.src && c.iid === voteOutcomeValue.src; }
}
// Pods: what an outcome does to a voter who isn't the caster ("each opponent loses 2 life" includes them)
function ownOutcome(text, caster, voter) {
  const t = String(text || '').toLowerCase();
  let v = 0;
  const pl = G.s.players[voter];
  const lose = t.match(/each opponent loses (\w+) life/);
  if (lose) v -= n(lose[1]) * (pl.life <= n(lose[1]) ? 10 : 0.7);
  if (/each opponent sacrifices a creature/.test(t)) v -= 2;
  const disc = t.match(/each opponent discards (\w+) cards?/);
  if (disc) v -= Math.min(n(disc[1]), cardsIn(voter, 'hand').length) * 1.1;
  const creatures = cardsIn(voter, 'battlefield').filter(isCreature);
  if (/destroy all (?:other )?creatures|destroy all creatures other than/.test(t)) v -= creatures.reduce((a, c) => a + cardValue(c), 0);
  if (/destroy all nonland permanents/.test(t)) v -= cardsIn(voter, 'battlefield').filter((c) => !isLand(c)).reduce((a, c) => a + cardValue(c), 0);
  if (/each player draws|each opponent draws/.test(t)) v += 1;
  return v;
}
async function holdVote(env, spec) {
  const caster = env.me;
  const order = multiplayer() ? turnOrderFrom(caster) : [caster, ...opponents(caster)]; // starting with the caster, in turn order
  const tally = new Map();
  const byVoter = Object.fromEntries(seats().map((k) => [k, []]));
  const words = spec.kind === 'words';
  const text = String(env.text || '').toLowerCase();
  // what each word choice does, for the prompt and for the AI
  const outcome = (o) => {
    const ol = o.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sents = text.split(/(?<=\.)\s+|\n/).filter((x) => new RegExp(`\\b${ol}\\b (?:gets more votes|votes?\\b)`).test(x) && !/votes for /.test(x));
    return sents.map((x) => x.replace(new RegExp(`^if ${ol} gets more votes(?: or the vote is tied)?, `), '').replace(/\.$/, '')).join(' / ');
  };
  const tieOpt = words ? spec.options.find((o) => new RegExp(`if ${o.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} gets more votes or the vote is tied`).test(text)) : null;
  voteOutcomeValue.src = env.src && env.src.iid;
  const ctl = G.s.voteControl && G.s.voteControl.turn === G.s.turn ? G.s.voteControl.pid : null;
  for (const voter of order) {
    const times = 1 + extraVotes(voter);
    const decider = ctl || voter;
    for (let k = 0; k < times; k++) {
      const nth = times > 1 ? ` (vote ${k + 1} of ${times})` : '';
      const vname = (v) => (v === 'p' ? 'Your' : multiplayer() ? `${seatName(v)}'s` : "The AI's");
      const whose = decider === voter ? `${vname(voter)} vote` : `${vname(voter)} vote (you choose it)`;
      let pick = null;
      if (words) {
        const vals = spec.options.map((o) => voteOutcomeValue(outcome(o), caster));
        // the outcome text as the player reading it sees it: on the AI's card, "each opponent" is you
        const persp = (t) => (decider === 'p' && caster !== 'p'
          ? t.replace(/\byour\b/g, '\u0001').replace(/\byou\b/g, 'the AI').replace(/\u0001/g, "the AI's").replace(/\b(?:each|target) opponent (\w+?)s\b/g, 'you $1').replace(/\beach opponent\b|\btarget opponent\b/g, 'you')
          : t);
        const sofar = order.flatMap((v) => byVoter[v].map((x) => `${v === 'p' ? 'You' : multiplayer() ? seatName(v) : 'The AI'} voted ${x}`)).join('. ');
        const k2 = await env.choosers[decider].choose({
          prompt: `${env.src ? cardName(env.src) + ' — ' : ''}${whose}${nth}${sofar ? ` (${sofar})` : ''}`,
          options: spec.options.map((o) => ({ label: o[0].toUpperCase() + o.slice(1), detail: persp(outcome(o)) + (o === tieOpt ? ' (also wins a tie)' : '') })),
          aiPick: () => {
            // voting for yourself (or the caster's side): the best outcome for the caster; against: the worst.
            // In a pod a voter weighs the outcomes from its own seat too ("each opponent loses 2 life" hits it).
            const forCaster = decider === caster;
            const own = multiplayer() && !forCaster ? spec.options.map((o) => ownOutcome(outcome(o), caster, decider)) : null;
            const score = (i) => (forCaster ? vals[i] : own ? own[i] - vals[i] * 0.5 : -vals[i]);
            let best = 0;
            for (let i = 1; i < vals.length; i++) if (score(i) > score(best)) best = i;
            return best;
          },
        });
        pick = spec.options[k2];
      } else if (spec.kind === 'players') {
        // an AI votes for itself when it may, otherwise for the opponent it's focused on
        const cands = spec.another ? (multiplayer() ? opponents(voter).sort((a, b) => (b === opp(voter)) - (a === opp(voter))) : [opp(voter)]) : [voter, ...opponents(voter)];
        if (cands.length === 1) pick = cands[0];
        else {
          const k2 = await env.choosers[decider].choose({ prompt: `${env.src ? cardName(env.src) + ' — ' : ''}${whose}${nth}: vote for a player`, options: cands.map((x) => ({ label: x === 'p' ? 'You' : multiplayer() ? seatName(x) : 'The AI' })), aiPick: () => 0 });
          pick = cands[k2];
        }
      } else {
        const cands = spec.cands();
        if (!cands.length) continue;
        const res = await env.choosers[decider].pickCards({
          prompt: `${env.src ? cardName(env.src) + ' — ' : ''}${whose}${nth}: vote for ${spec.phrase}`,
          cards: cands.map((c) => c.iid), min: spec.upTo ? 0 : 1, max: 1, forced: !spec.upTo, purpose: 'vote', src: env.src,
          // the AI votes for what hurts the other side most: their best permanent, or its own least valuable one
          aiScore: (c) => (c.controller === voter || (c.zone !== 'battlefield' && c.owner === voter) ? (spec.good ? cardValue(c) : -cardValue(c)) : spec.good ? -cardValue(c) : cardValue(c)),
        });
        pick = res && res[0];
        if (!pick) continue;
      }
      tally.set(pick, (tally.get(pick) || 0) + 1);
      byVoter[voter].push(pick);
    }
  }
  const label = (x) => (words ? x : x === 'p' ? 'you' : isAI(x) && G.s.players[x] ? seatName(x) : card(x) ? nameTag(card(x)) : x);
  env.votes = { tally, byVoter, kind: spec.kind, options: spec.options || [] };
  env.did.push(`vote: ${order.map((v) => `${v === 'p' ? 'you' : multiplayer() ? seatName(v) : 'the AI'} — ${byVoter[v].map(label).join(', ') || 'nothing'}`).join('; ')}`);
  queueEvent({ type: 'votingDone', controller: caster, byVoter });
}
// Messenger Jays: "For each card drawn this way, discard a card."
on(/^for each card drawn this way, discard a card$/, async (m, env) => {
  const k = Math.min(env.voteDrawn || 0, cardsIn(env.me, 'hand').length);
  if (!k) return;
  const picks = await env.choosers[env.me].pickCards({ forced: true, prompt: `Discard ${k} card${k > 1 ? 's' : ''}`, cards: cardsIn(env.me, 'hand').map((c) => c.iid), min: k, max: k, purpose: 'discard', src: env.src, aiScore: (c) => (isLand(c) ? 3 : -(DB[c.def].cmc || 0)) });
  for (const i of picks) discardCard(i);
  env.did.push(`discards ${picks.length}`);
}, { first: true });
// "Whenever players finish voting": who agreed with you (the votes ride on the event)
// sameList / diffList: the opponents who voted for something you voted for / something you didn't
function agreeing(env) {
  const bv = (env.event && env.event.byVoter) || Object.fromEntries(seats().map((k) => [k, []]));
  const mine = new Set(bv[env.me] || []);
  const them = opp(env.me);
  const theirs = bv[them] || [];
  const opps = multiplayer() ? opponents(env.me) : [them];
  const sameList = opps.filter((o) => (bv[o] || []).some((v) => mine.has(v)));
  const diffList = opps.filter((o) => (bv[o] || []).some((v) => !mine.has(v)));
  return { same: theirs.some((v) => mine.has(v)), different: theirs.some((v) => !mine.has(v)), them, sameList, diffList };
}
// Grudge Keeper
on(/^each opponent who voted for a choice you didn't vote for loses (\w+) life$/, async (m, env) => {
  const a = agreeing(env);
  for (const o of a.diffList) changeLife(o, -n(m[1]));
  env.did.push(a.diffList.length ? a.diffList.map((o) => `${who(o)} ${s_(o, 'lose')} ${n(m[1])} life`).join('; ') : 'no one voted differently');
}, { first: true });
// Model of Unity
on(/^you and each opponent who voted for a choice you voted for may scry (\w+)$/, async (m, env) => {
  const a = agreeing(env);
  for (const pid of [env.me, ...a.sameList]) await runSentence(`scry ${m[1]}`, { ...env, me: pid });
}, { first: true });
// Erestor of the Council
on(/^each opponent who voted for a choice you voted for creates a treasure token$/, async (m, env) => {
  const a = agreeing(env);
  for (const o of a.sameList) {
    createToken(genericTokenDef(0, 0, 'Treasure'), o, 1);
    env.did.push(`${who(o)} ${s_(o, 'create')} a Treasure`);
  }
}, { first: true });
on(/^you scry x, where x is the number of opponents who voted for a choice you didn't vote for$/, async (m, env) => {
  const k = agreeing(env).diffList.length;
  if (k) await runSentence(`scry ${k}`, env);
}, { first: true });
const mostVoted = (env) => {
  const t = env.votes ? env.votes.tally : new Map();
  const top = Math.max(0, ...t.values());
  return top ? [...t.entries()].filter(([, v]) => v === top).map(([k]) => k) : [];
};
const votesFor = (env, word) => (env.votes ? env.votes.tally.get(word.toLowerCase()) || 0 : 0);
export const _votesFor = votesFor;
on(/^(?:will of the council|council's dilemma|secret council)? ?(?:—|-)? ?(?:starting with you, )?each player (secretly )?votes for (.+?)(?:, then those votes are revealed)?$/, async (m, env) => {
  const what = m[2].trim();
  let spec;
  let pm;
  if ((pm = what.match(/^(another player|a player)$/))) spec = { kind: 'players', another: pm[1] === 'another player' };
  else if ((pm = what.match(/^(up to one |an? )(.+)$/)) && !/ or /.test(what.replace(/^(?:an?|up to one) [^,]*,.* or /, 'x'))) {
    // "a nonland permanent you don't control", "a creature you don't control", "an artifact, creature, or enchantment card in your graveyard"
    const ph = pm[2];
    const gy = ph.match(/^(.+?) cards? in your graveyard$/);
    spec = {
      kind: 'objects', phrase: (pm[1].trim() === 'up to one' ? 'up to one ' : 'a ') + ph, upTo: /up to/.test(pm[1]), good: !!gy,
      cands: () => gy
        ? cardsIn(env.me, 'graveyard').filter((c) => matchesAny(c, gy[1]))
        : seats().flatMap((k) => cardsIn(k, 'battlefield')).filter((c) => matchesAny(c, ph.replace(/ you don't control$| an opponent controls$/, '')) && (!/you don't control|an opponent controls/.test(ph) || c.controller !== env.me) && (!/ you control$/.test(ph) || c.controller === env.me)),
    };
  } else {
    // "sickness or psychosis", "blue, black, red, or green"
    const options = what.split(/,? or |, /).map((x) => x.trim().toLowerCase()).filter(Boolean);
    spec = { kind: 'words', options };
  }
  await holdVote(env, spec);
}, { first: true });
// Illusion of Choice
on(/^you choose how each player votes this turn$/, async (m, env) => {
  G.s.voteControl = { pid: env.me, turn: G.s.turn };
  env.did.push(`${who(env.me)} ${s_(env.me, 'choose')} how each player votes this turn`);
}, { first: true });
// "Exile each permanent with the most votes or tied for most votes." (Council's Judgment), Custodi Squire, Vault 11, Prime Minister's Cabinet Room
on(/^(exile|destroy|return) each (?:nonland )?(permanent|creature|card) with the most votes or tied for most votes(?: to your hand)?$/, async (m, env) => {
  const win = mostVoted(env).map(card).filter(Boolean);
  for (const c of win) {
    if (m[1] === 'return') { if (c.zone === 'graveyard') move(c.iid, 'hand'); }
    else if (c.zone !== 'battlefield') continue;
    else if (m[1] === 'exile') move(c.iid, 'exile');
    else destroy(c.iid);
  }
  env.did.push(win.length ? `${m[1] === 'return' ? 'returns' : m[1] === 'exile' ? 'exiles' : 'destroys'} ${win.map(nameTag).join(', ')}` : 'nothing got votes');
}, { first: true });
on(/^if no creature got votes, (.+)$/, async (m, env) => {
  env.lastCond = !mostVoted(env).length;
  if (env.lastCond) await runSentence(m[1], env);
}, { first: true });
// Council Guardian: "~ gains protection from each color with the most votes or tied for most votes"
on(/^~ gains protection from each color with the most votes or tied for most votes$/, async (m, env) => {
  const c = env.src && card(env.src.iid);
  if (!c) return;
  const cols = mostVoted(env);
  c.grants = [...(c.grants || []), ...cols.map((x) => 'protection from ' + x)];
  env.did.push(`gains protection from ${cols.join(' and ') || 'nothing'}`);
}, { first: true });
// Trap the Trespassers
on(/^for each creature with one or more votes, put that many stun counters on it, then tap it$/, async (m, env) => {
  const t = env.votes ? env.votes.tally : new Map();
  for (const [iid, k] of t) {
    const c = card(iid);
    if (!c || c.zone !== 'battlefield') continue;
    addCounters(c, 'stun', k);
    tapPerm(c);
    env.did.push(`puts ${k} stun counter${k > 1 ? 's' : ''} on ${nameTag(c)} and taps it`);
  }
}, { first: true });
// Jean-Luc Picard, Luminary: "put a +1/+1 counter on up to one other target creature and two charge counters on up to one target Spacecraft"
on(/^put an? ([+\-\d\/a-z]+) counter on up to one (other )?target creature(?: you control)? and (a|an|one|two|three) ([a-z]+) counters? on up to one target ([a-z]+)$/, async (m, env) => {
  const out = [];
  const crs = cardsIn(env.me, 'battlefield').concat(...opponents(env.me).map((o) => cardsIn(o, 'battlefield')))
    .filter((c) => isCreature(c) && (!m[2] || !env.src || c.iid !== env.src.iid) && canTarget(c, env.me, env.src));
  const [a] = crs.length ? await env.choosers[env.me].pickCards({ prompt: `Put a ${m[1]} counter on up to one ${m[2] || ''}creature`, cards: crs.map((c) => c.iid), min: 0, max: 1, purpose: 'counters', src: env.src, aiScore: (c) => (c.controller === env.me ? cardValue(c) : -100) }) : [];
  if (a && card(a) && (!isAI(env.me) || card(a).controller === env.me)) { addCounters(card(a), m[1], 1); out.push(`a ${m[1]} counter on ${nameTag(card(a))}`); }
  const kind = m[5].replace(/s$/, '');
  const pool = seats().flatMap((p) => cardsIn(p, 'battlefield')).filter((c) => (hasSubtype(c, capWords(kind)) || isType(c, capWords(kind))) && canTarget(c, env.me, env.src));
  const [b] = pool.length ? await env.choosers[env.me].pickCards({ prompt: `Put ${m[3]} ${m[4]} counters on up to one ${kind}`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'counters', src: env.src, aiScore: (c) => (c.controller === env.me ? 10 : -100) }) : [];
  if (b && card(b) && (!isAI(env.me) || card(b).controller === env.me)) { addCounters(card(b), m[4], n(m[3])); out.push(`${n(m[3])} ${m[4]} counters on ${nameTag(card(b))}`); }
  env.did.push(out.length ? `puts ${out.join(' and ')}` : 'puts no counters');
}, { first: true });
// Fall from Favor: "tap enchanted creature and you become the monarch"
on(/^tap enchanted creature and you become the monarch$/, async (m, env) => {
  await runSentence('tap enchanted creature', env);
  await runSentence('you become the monarch', env);
}, { first: true });
// The Borg Queen: "target opponent exiles cards from the top of their library until they exile a creature card. Assimilate that card. They put the rest on the bottom in a random order."
on(/^target opponent exiles cards from the top of their library until they exile an? ([a-z ]+?) card\. assimilate that card\. they put the rest on the bottom(?: of their library)? in a random order$/, async (m, env) => {
  const [o] = await playerTarget(env, 'target opponent');
  const who_ = o || opp(env.me);
  const exiled = [];
  let hit = null;
  while (zoneOf(who_, 'library').length) {
    const [top] = libTop(who_, 1);
    move(top, 'exile');
    exiled.push(top);
    if (matchesFilter(card(top), m[1])) { hit = top; break; }
  }
  if (hit) {
    toBattlefield(hit, env.me);
    const c = card(hit);
    if (c) {
      addCounters(c, '+1/+1', 1);
      addLayerFx(c, { until: true, types: { add: 'Artifact', subSet: 'Borg' } });
      if (!isCreature(c)) addLayerFx(c, { until: true, types: { add: 'Creature' } });
    }
  }
  const rest = exiled.filter((i) => i !== hit && card(i) && card(i).zone === 'exile').sort(() => Math.random() - 0.5);
  rest.forEach((i) => move(i, 'library', { to: 'bottom' }));
  env.did.push(`${who(who_)} ${s_(who_, 'exile')} ${exiled.length} card${exiled.length === 1 ? '' : 's'}${hit ? `; assimilates ${nameTag(card(hit))}` : ', finding no creature'}`);
}, { first: true, multi: true });
// ---- precon batch 4 (Scryfall wording) ----
// Abundant Harvest: "Choose land or nonland. Reveal cards … until you reveal a card of the chosen kind. Put that card into your hand and the rest on the bottom …"
on(/^choose land or nonland\. reveal cards from the top of your library until you reveal a card of the chosen kind\. put that card into your hand and the rest on the bottom of your library in a random order$/, async (m, env) => {
  const lands = cardsIn(env.me, 'battlefield').filter(isLand).length;
  const k = await env.choosers[env.me].choose({ prompt: `${cardName(env.src)}: choose`, options: [{ label: 'Land' }, { label: 'Nonland' }], aiPick: () => (lands < 5 ? 0 : 1) });
  const wantLand = k === 0;
  const seen = [];
  let hit = null;
  for (const i of zoneOf(env.me, 'library').slice().reverse()) {
    seen.push(i);
    if (isLand(card(i)) === wantLand) { hit = i; break; }
  }
  if (hit) move(hit, 'hand');
  seen.filter((i) => i !== hit).sort(() => Math.random() - 0.5).forEach((i) => move(i, 'library', { to: 'bottom' }));
  env.did.push(`reveals ${seen.length}${hit ? `, takes ${env.me === 'p' ? nameTag(card(hit)) : 'a ' + (wantLand ? 'land' : 'nonland card')}` : ''}`);
}, { first: true, multi: true });
// Acolyte Hybrid: "If an artifact is destroyed this way, its controller draws a card."
on(/^if an? ([a-z]+) is destroyed this way, its controller draws a card$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  if (!c || c.zone !== 'graveyard' || !new RegExp(m[1], 'i').test(DB[c.def].typeLine || '')) return;
  const pid = env.lastDestroyedCtl || c.owner;
  draw(pid, 1, true);
  env.did.push(`${who(pid)} ${s_(pid, 'draw')} a card`);
}, { first: true });
// Aerial Extortionist: "For as long as that card remains exiled, its owner may cast it."
on(/^for as long as that card remains exiled, its owner may cast it$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  if (!c || c.zone !== 'exile') return;
  grantPlay([c.iid], c.owner, { castOnly: true });
  env.did.push(`${who(c.owner)} may cast ${nameTag(c)} from exile`);
}, { first: true });
// Aetherspouts
on(/^for each attacking creature, its owner puts it on their choice of the top or bottom of their library$/, async (m, env) => {
  const ids = ((G.s.combat && G.s.combat.attackers) || []).filter((i) => card(i) && card(i).zone === 'battlefield');
  for (const i of ids) {
    const c = card(i);
    const owner = c.owner;
    const top = c.token ? true : isAI(owner) ? cardValue(c) >= 4 : await env.choosers[owner].confirm(cardName(c), `Put ${cardName(c)} on top of your library? (No = bottom)`);
    move(i, 'library', top ? {} : { to: 'bottom' });
    env.did.push(`${nameTag(c)} goes to the ${top ? 'top' : 'bottom'} of ${who(owner) === 'you' ? 'your' : "the AI's"} library`);
  }
  if (G.s.combat) G.s.combat.attackers = G.s.combat.attackers.filter((i) => card(i) && card(i).zone === 'battlefield');
}, { first: true });
// Agent's Toolkit: "move a counter from ~ onto that creature"
on(/^(?:you may )?move a counter from ~ onto (that creature|it|target creature you control)$/, async (m, env) => {
  const src = env.src && card(env.src.iid);
  const dst = env.it && env.it.iid && card(env.it.iid);
  if (!src || !dst || dst.zone !== 'battlefield') return;
  const kinds = Object.entries(src.counters || {}).filter(([, v]) => v > 0).map(([k]) => k);
  if (!kinds.length) return env.did.push('has no counters left');
  const pref = ['+1/+1', 'flying', 'deathtouch', 'shield', 'lifelink', 'trample', 'indestructible'];
  const kind = kinds.length === 1 ? kinds[0] : kinds[await env.choosers[env.me].choose({ prompt: `Move which counter onto ${cardName(dst)}?`, options: kinds.map((k) => ({ label: k })), aiPick: () => Math.max(0, kinds.indexOf(pref.find((p) => kinds.includes(p)) || kinds[0])) })];
  if (isAI(env.me) && (dst.counters || {})[kind]) return;
  src.counters[kind]--;
  if (!src.counters[kind]) delete src.counters[kind];
  addCounters(dst, kind, 1);
  env.did.push(`moves a ${kind} counter onto ${nameTag(dst)}`);
}, { first: true });
// Aid from the Cowl: "Otherwise, you may put it on the bottom of your library."
on(/^(?:otherwise, )?(?:you may )?put it on the bottom of your library$/, async (m, env) => {
  if (!/otherwise/i.test(env.prevSent || '') && !/otherwise/i.test(env.sentence || '') && !/Otherwise, you may put it on the bottom/i.test(env.text || '')) return 'pass';
  const c = env.it && env.it.iid && card(env.it.iid);
  if (!c || c.zone !== 'library' || isPermanentCard(DB[c.def])) return;
  const yes = isAI(env.me) ? !isLand(c) && (DB[c.def].cmc || 0) > 4 : await env.choosers[env.me].confirm(cardName(env.src), `Put ${cardName(c)} on the bottom of your library?`);
  if (yes) move(c.iid, 'library', { to: 'bottom' });
  env.did.push(yes ? 'puts it on the bottom' : 'leaves it on top');
}, { first: true });
// Aminatou's Augury
on(/^exile the top eight cards of your library\. you may put a land card from among them onto the battlefield\. until end of turn, for each nonland card type, you may cast a spell of that type from among the exiled cards without paying its mana cost$/, async (m, env) => {
  const ids = libTop(env.me, 8);
  ids.forEach((i) => move(i, 'exile'));
  env.did.push(`exiles ${ids.length} cards`);
  const lands = ids.filter((i) => card(i) && isLand(card(i)));
  if (lands.length) {
    const [l] = await env.choosers[env.me].pickCards({ prompt: 'You may put a land onto the battlefield', cards: lands, min: 0, max: 1, purpose: 'cheat', src: env.src, aiScore: () => 1 });
    if (l) { toBattlefield(l, env.me); env.did.push(`puts ${nameTag(card(l))} onto the battlefield`); }
  }
  const used = new Set();
  for (const ty of ['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Instant', 'Sorcery', 'Battle', 'Kindred']) {
    if (used.has(ty)) continue;
    const pool = ids.filter((i) => card(i) && card(i).zone === 'exile' && !isLand(card(i)) && new RegExp('\\b' + ty + '\\b').test(DB[card(i).def].faces[0].typeLine || ''));
    if (!pool.length) continue;
    const got = await castFromPool(env, pool, { free: true, max: 1, prompt: `Cast a ${ty.toLowerCase()} spell free?` });
    for (const g of got) for (const t2 of ['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Instant', 'Sorcery', 'Battle', 'Kindred']) if (new RegExp('\\b' + t2 + '\\b').test(DB[card(g).def].faces[0].typeLine || '')) { used.add(t2); break; }
    used.add(ty);
  }
}, { first: true, multi: true });
// Amy Pond: "choose a suspended card you own and remove that many time counters from it"
on(/^choose a suspended card you own and remove that many time counters from it$/, async (m, env) => {
  const k = env.amount || (env.event && env.event.amount) || env.lastAmount || 0;
  const pool = cardsIn(env.me, 'exile').filter((c) => (c.counters || {}).time > 0);
  if (!pool.length || !k) return env.did.push('has no suspended card');
  const [p] = await env.choosers[env.me].pickCards({ prompt: `Remove ${k} time counters from a suspended card`, cards: pool.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'counters', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
  const c = card(p);
  if (!c) return;
  c.counters.time = Math.max(0, c.counters.time - k);
  env.did.push(`removes ${k} time counters from ${nameTag(c)}`);
  if (!c.counters.time) {
    delete c.counters.time;
    if (T.castFree) await T.castFree(env.me, c.iid, {});
  }
}, { first: true });
// Angel of Serenity
on(/^(?:you may )?exile up to three other target creatures from the battlefield and\/or creature cards from graveyards$/, async (m, env) => {
  const bf = seats().flatMap((p) => cardsIn(p, 'battlefield')).filter((c) => isCreature(c) && (!env.src || c.iid !== env.src.iid) && canTarget(c, env.me, env.src));
  const gy = seats().flatMap((p) => cardsIn(p, 'graveyard')).filter((c) => /Creature/.test(DB[c.def].faces[0].typeLine || ''));
  const pool = [...bf, ...gy];
  if (!pool.length) return;
  const picks = await env.choosers[env.me].pickCards({ prompt: 'Exile up to three creatures and/or creature cards in graveyards', cards: pool.map((c) => c.iid), min: 0, max: 3, purpose: 'exile', src: env.src, aiScore: (c) => (c.zone === 'battlefield' ? (c.controller === env.me ? -20 : cardValue(c) + 5) : c.owner === env.me ? cardValue(c) : cardValue(c) / 2) });
  for (const i of picks) {
    const c = card(i);
    if (!c) continue;
    move(i, 'exile');
    if (card(i) && env.src) card(i).exiledLinked = env.src.iid;
  }
  env.did.push(`exiles ${picks.map((i) => nameTag(card(i))).join(', ') || 'nothing'}`);
}, { first: true });
on(/^return the exiled cards to their owners' hands$/, async (m, env) => {
  const src = env.src && env.src.iid;
  const ids = Object.values(G.s.cards).filter((x) => x.zone === 'exile' && x.exiledLinked === src).map((x) => x.iid);
  ids.forEach((i) => { delete card(i).exiledLinked; move(i, 'hand'); });
  env.did.push(`returns ${ids.length} exiled card${ids.length === 1 ? '' : 's'} to their owners' hands`);
}, { first: true });
// Angelic Aberration
on(/^sacrifice any number of creatures each with base power or toughness (\d+) or less\. create that many (.+?) tokens?(.*)$/, async (m, env) => {
  const lim = +m[1];
  const pool = cardsIn(env.me, 'battlefield').filter((c) => isCreature(c) && (!env.src || c.iid !== env.src.iid) && (() => { const b = basePT(c); return b.p <= lim || b.t <= lim; })());
  const picks = pool.length ? await env.choosers[env.me].pickCards({ prompt: `Sacrifice any number of creatures with base power or toughness ${lim} or less`, cards: pool.map((c) => c.iid), min: 0, max: pool.length, purpose: 'sacrifice', src: env.src, aiScore: (c) => (c.token ? 5 : 3 - cardValue(c)) }) : [];
  const sac = isAI(env.me) ? picks.filter((i) => card(i) && (card(i).token || cardValue(card(i)) < 3)) : picks;
  sac.forEach((i) => sacrifice(i));
  env.did.push(`sacrifices ${sac.length}`);
  if (sac.length) await runSentence(`create ${sac.length} ${m[2]} tokens${m[3] || ''}`, env);
}, { first: true, multi: true });
// Animate Dead & co.: the reanimation happens as the Aura is cast (see attachAura); its enters line has nothing left to do
on(/^(?:if it's on the battlefield, )?it loses "enchant creature card in a graveyard"/, async (m, env) => { env.did.push('(its creature came back as it was cast)'); return 'rest'; }, { first: true, consumesRest: true });
on(/^when ~ leaves the battlefield, that creature's controller sacrifices it$/, async () => {}, { first: true });
// Arcane Bombardment
on(/^exile an instant or sorcery card at random from your graveyard\. then copy each card exiled with ~\. you may cast any number of the copies without paying their mana costs$/, async (m, env) => {
  const gy = cardsIn(env.me, 'graveyard').filter((c) => /Instant|Sorcery/.test(DB[c.def].faces[0].typeLine || ''));
  const src = env.src && env.src.iid;
  if (gy.length) {
    const pick = gy[Math.floor(Math.random() * gy.length)];
    move(pick.iid, 'exile');
    if (card(pick.iid)) card(pick.iid).exiledLinked = src;
    env.did.push(`exiles ${nameTag(card(pick.iid))} at random`);
  }
  const linked = Object.values(G.s.cards).filter((x) => x.zone === 'exile' && x.exiledLinked === src && !x.copyCard);
  const copies = linked.map((x) => { const cid = makeCard(x.def, env.me, 'exile'); card(cid).copyCard = true; card(cid).face = x.face || 0; return cid; });
  if (!copies.length) return;
  env.did.push(`copies ${linked.length} exiled card${linked.length === 1 ? '' : 's'}`);
  await castFromPool(env, copies, { free: true, max: copies.length, prompt: 'Cast a copy without paying its mana cost?' });
  for (const cid of copies) if (card(cid) && card(cid).zone === 'exile') { delete G.s.cards[cid]; const z = zoneOf(env.me, 'exile'); const i = z.indexOf(cid); if (i >= 0) z.splice(i, 1); }
}, { first: true, multi: true });
on(/^that creature's controller sacrifices it$/, async (m, env) => {
  const src = env.src && (card(env.src.iid) || env.src);
  const t = src && (src.reanimated || src.attachedTo) && card(src.reanimated || src.attachedTo);
  if (!t || t.zone !== 'battlefield') return;
  sacrifice(t.iid);
  env.did.push(`${nameTag(t)} is sacrificed`);
}, { first: true });
// Animist's Awakening
on(/^reveal the top (x|\w+) cards of your library\. put all land cards from among them onto the battlefield tapped and the rest on the bottom of your library in a random order$/, async (m, env) => {
  const ids = libTop(env.me, n(m[1], env.x));
  const lands = ids.filter((i) => isLand(card(i)));
  lands.forEach((i) => toBattlefield(i, env.me, { tapped: true }));
  ids.filter((i) => !lands.includes(i)).sort(() => Math.random() - 0.5).forEach((i) => move(i, 'library', { to: 'bottom' }));
  env.them_ = lands;
  env.did.push(`reveals ${ids.length}, puts ${lands.length} land${lands.length === 1 ? '' : 's'} onto the battlefield tapped`);
}, { first: true, multi: true });
on(/^(?:spell mastery — )?if there are two or more instant and\/or sorcery cards in your graveyard, untap those lands$/, async (m, env) => {
  if (cardsIn(env.me, 'graveyard').filter((c) => /Instant|Sorcery/.test(DB[c.def].faces[0].typeLine || '')).length < 2) return;
  await runSentence('untap those lands', env);
}, { first: true });
on(/^untap those lands$/, async (m, env) => {
  const ids = (env.them_ || []).filter((i) => card(i) && card(i).zone === 'battlefield');
  ids.forEach((i) => (card(i).tapped = false));
  env.did.push(`untaps ${ids.length} land${ids.length === 1 ? '' : 's'}`);
}, { first: true });
// Anrakyr the Traveller
on(/^(?:you may )?cast an? ([a-z]+) spell from your hand or graveyard by paying life equal to its mana value rather than paying its mana cost$/, async (m, env) => {
  const pl = G.s.players[env.me];
  const pool = [...cardsIn(env.me, 'hand'), ...cardsIn(env.me, 'graveyard')].filter((c) => new RegExp('\\b' + m[1] + '\\b', 'i').test(DB[c.def].faces[0].typeLine || '') && !isLand(c) && (DB[c.def].cmc || 0) < pl.life);
  if (!pool.length) return env.did.push(`has no ${m[1]} to cast`);
  const [p] = await env.choosers[env.me].pickCards({ prompt: `Cast a ${m[1]} spell for life equal to its mana value?`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => (pl.life - (DB[c.def].cmc || 0) >= 15 ? DB[c.def].cmc || 0 : -1) });
  const c = p && card(p);
  if (!c || (isAI(env.me) && pl.life - (DB[c.def].cmc || 0) < 15)) return;
  changeLife(env.me, -(DB[c.def].cmc || 0), false);
  env.did.push(`pays ${DB[c.def].cmc || 0} life`);
  if (T.castFree) await T.castFree(env.me, c.iid, {});
}, { first: true });
// Apex of Power: "Until end of turn, you may cast spells from among them."
on(/^(?:until end of turn, )?(?:you may )?cast spells from among them(?: until end of turn| this turn)?$/, async (m, env) => {
  const ids = (env.them_ || []).filter((i) => card(i) && card(i).zone === 'exile');
  grantPlay(ids, env.me, { until: G.s.turn, castOnly: true });
  env.did.push(`may cast spells from among ${ids.length} exiled cards this turn`);
}, { first: true });
// Arcane Endeavor
on(/^roll two d8 and choose one result\. draw cards equal to that result\. then you may cast an instant or sorcery spell with mana value less than or equal to the other result from your hand without paying its mana cost$/, async (m, env) => {
  const a = 1 + Math.floor(Math.random() * 8);
  const b = 1 + Math.floor(Math.random() * 8);
  const k = await env.choosers[env.me].choose({ prompt: `Rolled ${a} and ${b}: which result is the number of cards to draw?`, options: [{ label: `Draw ${a} (free spell up to ${b})` }, { label: `Draw ${b} (free spell up to ${a})` }], aiPick: () => (a >= b ? 0 : 1) });
  const drawN = k === 1 ? b : a;
  const mv = k === 1 ? a : b;
  draw(env.me, drawN, true);
  env.did.push(`rolls ${a} and ${b}; draws ${drawN}`);
  const pool = cardsIn(env.me, 'hand').filter((c) => /Instant|Sorcery/.test(DB[c.def].faces[0].typeLine || '') && (DB[c.def].cmc || 0) <= mv).map((c) => c.iid);
  if (pool.length) await castFromPool(env, pool, { free: true, max: 1 });
}, { first: true, multi: true });
// Archfiend of Depravity
on(/^that player chooses up to (one|two|three) creatures they control, then sacrifices the rest$/, async (m, env) => {
  const pid = env.thatPlayer || opp(env.me);
  const mine = cardsIn(pid, 'battlefield').filter(isCreature);
  const k = n(m[1]);
  if (mine.length <= k) return env.did.push(`${who(pid)} ${s_(pid, 'keep')} all creatures`);
  const keep = await env.choosers[pid].pickCards({ prompt: `Choose up to ${k} creatures to keep (the rest are sacrificed)`, cards: mine.map((c) => c.iid), min: Math.min(k, mine.length), max: k, forced: true, purpose: 'keep', src: env.src, aiScore: (c) => cardValue(c) });
  const gone = mine.filter((c) => !keep.includes(c.iid));
  gone.forEach((c) => sacrifice(c.iid));
  env.did.push(`${who(pid)} ${s_(pid, 'sacrifice')} ${gone.length} creature${gone.length === 1 ? '' : 's'}`);
}, { first: true });
// Armory Automaton
on(/^(?:you may )?attach any number of target equipment to (it|~)$/, async (m, env) => {
  const host = env.src && card(env.src.iid);
  if (!host || host.zone !== 'battlefield') return;
  const pool = cardsIn(env.me, 'battlefield').filter((c) => hasSubtype(c, 'Equipment') && c.attachedTo !== host.iid && canTarget(c, env.me, env.src));
  if (!pool.length) return;
  const picks = await env.choosers[env.me].pickCards({ prompt: `Attach any number of Equipment to ${cardName(host)}`, cards: pool.map((c) => c.iid), min: 0, max: pool.length, purpose: 'attach', src: env.src, aiScore: (c) => (c.attachedTo ? -1 : 2) });
  const ids = isAI(env.me) ? picks.filter((i) => !card(i).attachedTo) : picks;
  ids.forEach((i) => attachTo(card(i), host));
  if (ids.length) env.did.push(`attaches ${ids.map((i) => nameTag(card(i))).join(', ')}`);
}, { first: true });
// Ashling, the Limitless / generic: "At the beginning of your next end step, sacrifice it unless you pay {W}{U}{B}{R}{G}."
on(/^at the beginning of your next end step, sacrifice (it|that token|them) unless you pay ((?:\{[^}]+\})+)$/, async (m, env) => {
  const ids = (env.them_ && env.them_.length ? env.them_ : env.it && env.it.iid ? [env.it.iid] : []).filter((i) => card(i));
  G.s.delayed = G.s.delayed || [];
  for (const i of ids) G.s.delayed.push({ at: 'endStep', whoseEnd: env.me, kind: 'sacUnlessPay', iid: i, pid: env.me, cost: m[2].toUpperCase() });
  if (ids.length) env.did.push(`${ids.map((i) => nameTag(card(i))).join(', ')} will be sacrificed at your next end step unless you pay ${m[2].toUpperCase()}`);
}, { first: true });
// Audacious Swap: "… exiles the top card of their library. If it's a land card, they put it onto the battlefield. Otherwise, they may cast it without paying its mana cost."
on(/^the owner of target (nonenchantment permanent|permanent|nonland permanent|creature) shuffles it into their library, then exiles the top card of their library\. if it's a land card, they put it onto the battlefield\. otherwise, they may cast it without paying its mana cost$/, async (m, env) => {
  const [t] = await objects(env, `target ${m[1]}`, { harm: true });
  if (!t) return;
  const owner = t.owner;
  move(t.iid, 'library');
  shuffle(owner);
  env.did.push(`shuffles ${whose(t)} ${nameTag(t)} into its owner's library`);
  const [top] = libTop(owner, 1);
  if (!top) return;
  move(top, 'exile');
  const c = card(top);
  env.did.push(`${who(owner)} ${s_(owner, 'exile')} ${nameTag(c)}`);
  if (isLand(c)) { toBattlefield(top, owner); return; }
  const yes = isAI(owner) ? true : await env.choosers[owner].confirm(cardName(c), `Cast ${cardName(c)} without paying its mana cost?`);
  if (yes && T.castFree) await T.castFree(owner, top, {});
}, { first: true, multi: true });
// Augusta, Order Returned
on(/^each player exiles a card from their graveyard\. when one or more nonland cards are exiled this way, put that many \+1\/\+1 counters on target attacking creature$/, async (m, env) => {
  let k = 0;
  for (const pid of seats().filter(inGame)) {
    const gy = cardsIn(pid, 'graveyard');
    if (!gy.length) continue;
    const mine = pid === env.me;
    const [p] = await env.choosers[pid].pickCards({ prompt: 'Exile a card from your graveyard', cards: gy.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'exile', src: env.src, aiScore: (c) => (mine ? (isLand(c) ? -1 : 1) : isLand(c) ? 5 : -cardValue(c)) });
    if (p && card(p)) { if (!isLand(card(p))) k++; move(p, 'exile'); }
  }
  env.did.push(`${k} nonland card${k === 1 ? '' : 's'} exiled`);
  if (!k) return;
  const atk = ((G.s.combat && G.s.combat.attackers) || []).map(card).filter((c) => c && c.controller === env.me);
  if (!atk.length) return;
  const [t] = await env.choosers[env.me].pickCards({ prompt: `Put ${k} +1/+1 counters on an attacking creature`, cards: atk.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'counters', src: env.src, aiScore: (c) => power(c) });
  if (t) { addCounters(card(t), '+1/+1', k); env.did.push(`puts ${k} +1/+1 counters on ${nameTag(card(t))}`); }
}, { first: true, multi: true });
// Aunt May: "If it's a Spider, put a +1/+1 counter on it."
on(/^if it's an? ([A-Za-z]+), put an? ([+\-\d\/a-z]+) counter on it$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  if (!c || c.zone !== 'battlefield' || !hasSubtype(c, capWords(m[1]))) return;
  addCounters(c, m[2], 1);
  env.did.push(`puts a ${m[2]} counter on ${nameTag(c)}`);
}, { first: true });
// Aven Courier
on(/^choose a counter on a permanent you control\. put a counter of that kind on target permanent you control if it doesn't have a counter of that kind on it$/, async (m, env) => {
  const kinds = [...new Set(cardsIn(env.me, 'battlefield').flatMap((c) => Object.entries(c.counters || {}).filter(([, v]) => v > 0).map(([k]) => k)))];
  if (!kinds.length) return env.did.push('finds no counters');
  const pref = ['+1/+1', 'flying', 'shield', 'deathtouch', 'lifelink', 'loyalty'];
  const kind = kinds.length === 1 ? kinds[0] : kinds[await env.choosers[env.me].choose({ prompt: 'Choose a kind of counter', options: kinds.map((k) => ({ label: k })), aiPick: () => Math.max(0, kinds.indexOf(pref.find((p) => kinds.includes(p)) || kinds[0])) })];
  const pool = cardsIn(env.me, 'battlefield').filter((c) => !((c.counters || {})[kind] > 0) && canTarget(c, env.me, env.src) && (kind !== '+1/+1' || isCreature(c)));
  if (!pool.length) return;
  const [t] = await env.choosers[env.me].pickCards({ prompt: `Put a ${kind} counter on a permanent you control`, cards: pool.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'counters', src: env.src, aiScore: (c) => cardValue(c) + (isCreature(c) ? 2 : 0) });
  if (t) { addCounters(card(t), kind, 1); env.did.push(`puts a ${kind} counter on ${nameTag(card(t))}`); }
}, { first: true, multi: true });
// Ancient Cellarspawn: "if the amount of mana spent to cast it was less than its mana value, target opponent loses life equal to the difference"
on(/^if the amount of mana spent to cast it was less than its mana value, target opponent loses life equal to the difference$/, async (m, env) => {
  const c = env.it && env.it.iid && card(env.it.iid);
  if (!c || c.manaSpent === undefined) return;
  const d = (DB[c.def].cmc || 0) + (c.xPaid || 0) - c.manaSpent;
  if (d <= 0) return;
  const [o] = await playerTarget(env, 'target opponent');
  if (!o) return;
  changeLife(o, -d, false);
  env.did.push(`${who(o)} ${s_(o, 'lose')} ${d} life`);
}, { first: true });
// Abstract Performance
on(/^exile the top four cards of your library in a face-down pile, then exile the top four cards of your library in a face-up pile\. an opponent chooses one of those piles\. put that pile into your graveyard\. look at the cards in the other pile\. you may cast a spell from among them without paying its mana cost\. put the rest into your hand$/, async (m, env) => {
  const a = libTop(env.me, 4);
  a.forEach((i) => move(i, 'exile'));
  const b = libTop(env.me, 4);
  b.forEach((i) => move(i, 'exile'));
  const o = opponents(env.me).filter(inGame)[0] || opp(env.me);
  const val = (ids) => ids.reduce((s, i) => s + cardValue(card(i)), 0);
  const k = await env.choosers[o].choose({ prompt: `${cardName(env.src)}: which pile goes to the graveyard? (face-up: ${b.map((i) => cardName(card(i))).join(', ')})`, options: [{ label: 'The face-down pile (4 cards)' }, { label: 'The face-up pile' }], aiPick: () => (val(b) >= 4 * 3 ? 1 : 0) });
  const gone = k === 1 ? b : a;
  const keep = k === 1 ? a : b;
  gone.forEach((i) => card(i) && move(i, 'graveyard'));
  env.did.push(`${who(o)} ${s_(o, 'choose')} the ${k === 1 ? 'face-up' : 'face-down'} pile for the graveyard`);
  await castFromPool(env, keep.filter((i) => card(i) && card(i).zone === 'exile'), { free: true, max: 1 });
  const rest = keep.filter((i) => card(i) && card(i).zone === 'exile');
  rest.forEach((i) => move(i, 'hand'));
  env.did.push(`puts ${rest.length} into hand`);
}, { first: true, multi: true });
// Alex Wilder: handled by evalCond "you cast it from anywhere other than your hand"
// ---- sweep batch 5 ----
// Avenging Huntbonder: "put a double strike counter on another target attacking creature"
on(/^put an? ([a-z +\/0-9-]+?) counter on another target attacking creature$/, async (m, env) => {
  const pool = ((G.s.combat && G.s.combat.attackers) || []).map(card).filter((c) => c && c.zone === 'battlefield' && (!env.src || c.iid !== env.src.iid) && canTarget(c, env.me, env.src));
  if (!pool.length) return env.did.push('has no other attacker');
  const [p] = await env.choosers[env.me].pickCards({ prompt: `Put a ${m[1]} counter on another attacking creature`, cards: pool.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'counters', src: env.src, aiScore: (c) => (c.controller === env.me ? power(c) : -10) });
  if (p) { addCounters(card(p), m[1], 1); env.did.push(`puts a ${m[1]} counter on ${nameTag(card(p))}`); }
}, { first: true });
// Barret: "attach up to one target Equipment you control to target Rebel you control"
on(/^attach up to one target equipment you control to target ([a-z]+) you control$/, async (m, env) => {
  const eq = cardsIn(env.me, 'battlefield').filter((c) => hasSubtype(c, 'Equipment') && canTarget(c, env.me, env.src));
  const hosts = cardsIn(env.me, 'battlefield').filter((c) => isCreature(c) && (m[1] === 'creature' || hasSubtype(c, capWords(m[1]))) && canTarget(c, env.me, env.src));
  if (!eq.length || !hosts.length) return env.did.push('attaches nothing');
  const [e] = await env.choosers[env.me].pickCards({ prompt: 'Attach up to one Equipment', cards: eq.map((c) => c.iid), min: 0, max: 1, purpose: 'attach', src: env.src, aiScore: (c) => (c.attachedTo ? 0 : 3) });
  if (!e) return;
  const [h] = await env.choosers[env.me].pickCards({ prompt: `Attach ${cardName(card(e))} to which ${m[1]}?`, cards: hosts.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'attach', src: env.src, aiScore: (c) => power(c) + (c.attachedTo ? 0 : 1) - (card(e).attachedTo === c.iid ? 50 : 0) });
  if (h && card(e).attachedTo !== h) { attachTo(card(e), card(h)); env.did.push(`attaches ${nameTag(card(e))} to ${nameTag(card(h))}`); }
}, { first: true });
// Battle at the Helvault: "For each player, exile up to one target non-Saga, nonland permanent that player controls until ~ leaves the battlefield."
on(/^for each player, exile up to one target non-saga, nonland permanent that player controls until ~ leaves the battlefield$/, async (m, env) => {
  for (const pid of seats().filter(inGame)) {
    const pool = cardsIn(pid, 'battlefield').filter((c) => !isLand(c) && !hasSubtype(c, 'Saga') && canTarget(c, env.me, env.src));
    if (!pool.length) continue;
    const mine = pid === env.me;
    const [p] = await env.choosers[env.me].pickCards({ prompt: `Exile up to one non-Saga, nonland permanent ${mine ? 'you control' : seatName(pid) + ' controls'}`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'exile', src: env.src, aiScore: (c) => (mine ? (/When(?:ever)? ~ enters/i.test(stripName(oracle(c), c)) ? 2 : -10) : cardValue(c)) });
    if (!p) continue;
    if (isAI(env.me) && mine && !/When(?:ever)? ~ enters/i.test(stripName(oracle(card(p)), card(p)))) continue;
    const nm = nameTag(card(p));
    move(p, 'exile');
    if (card(p) && env.src) card(p).exiledBy = env.src.iid;
    env.did.push(`exiles ${nm}`);
  }
}, { first: true });
// Battle for Bretagard III
on(/^choose any number of artifact tokens and\/or creature tokens you control with different names\. for each of them, create a token that's a copy of it$/, async (m, env) => {
  const seen = new Set();
  const pool = cardsIn(env.me, 'battlefield').filter((c) => c.token && (isCreature(c) || isType(c, 'Artifact')) && !seen.has(cardName(c)) && seen.add(cardName(c)));
  if (!pool.length) return env.did.push('has no tokens');
  const picks = await env.choosers[env.me].pickCards({ prompt: 'Choose tokens with different names to copy', cards: pool.map((c) => c.iid), min: 0, max: pool.length, purpose: 'copy', src: env.src, aiScore: (c) => cardValue(c) + 1 });
  for (const i of picks) {
    const c = card(i);
    if (!c) continue;
    const [t] = createToken(c.def, env.me, 1);
    if (card(t)) card(t).face = c.face || 0;
  }
  env.did.push(`copies ${picks.length} token${picks.length === 1 ? '' : 's'}`);
}, { first: true, multi: true });
// Benthic Anomaly
on(/^(?:for each opponent, )?choose a creature (?:that player|an opponent) controls\. create a token that's a copy of one of those creatures, except its power is equal to the total power of those creatures, its toughness is equal to the total toughness of those creatures, and it's a colorless eldrazi creature$/, async (m, env) => {
  const chosen = [];
  for (const o of opponents(env.me).filter(inGame)) {
    const pool = cardsIn(o, 'battlefield').filter(isCreature);
    if (!pool.length) continue;
    const [p] = await env.choosers[env.me].pickCards({ prompt: `Choose a creature ${seatName(o)} controls`, cards: pool.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'copy', src: env.src, aiScore: (c) => power(c) + toughness(c) + cardValue(c) / 2 });
    if (p) chosen.push(card(p));
  }
  if (!chosen.length) return env.did.push('finds no creatures');
  const [model] = chosen.length > 1 ? await env.choosers[env.me].pickCards({ prompt: 'Copy which one?', cards: chosen.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'copy', src: env.src, aiScore: (c) => cardValue(c) }).then((r) => r.map(card)) : chosen;
  const p = chosen.reduce((a, c) => a + power(c), 0);
  const t = chosen.reduce((a, c) => a + toughness(c), 0);
  const [tk] = createToken(model.def, env.me, 1);
  const c = card(tk);
  if (!c) return;
  c.face = model.face || 0;
  c.setPT = { ts: nextStamp(), p, t };
  addLayerFx(c, { until: true, types: { subSet: 'Eldrazi' }, colors: { set: [] } });
  env.did.push(`creates a ${p}/${t} Eldrazi copy of ${nameTag(model)}`);
}, { first: true, multi: true });
// Betor: "put a number of +1/+1 counters on up to one other target creature you control equal to the amount of life you gained this turn"
on(/^put a number of \+1\/\+1 counters on up to one other target creature you control equal to the amount of life you gained this turn$/, async (m, env) => {
  const k = (G.s.ts[env.me] && G.s.ts[env.me].lifeGained) || 0;
  if (!k) return env.did.push('gained no life this turn');
  const pool = cardsIn(env.me, 'battlefield').filter((c) => isCreature(c) && (!env.src || c.iid !== env.src.iid) && canTarget(c, env.me, env.src));
  if (!pool.length) return;
  const [p] = await env.choosers[env.me].pickCards({ prompt: `Put ${k} +1/+1 counters on up to one other creature`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'counters', src: env.src, aiScore: (c) => cardValue(c) });
  if (p) { addCounters(card(p), '+1/+1', k); env.did.push(`puts ${k} +1/+1 counters on ${nameTag(card(p))}`); }
}, { first: true });
on(/^return up to one target creature card with mana value less than or equal to the amount of life you lost this turn from your graveyard to the battlefield$/, async (m, env) => {
  const k = (G.s.ts[env.me] && G.s.ts[env.me].lifeLost) || 0;
  const pool = cardsIn(env.me, 'graveyard').filter((c) => /Creature/.test(DB[c.def].faces[0].typeLine || '') && (DB[c.def].cmc || 0) <= k);
  if (!pool.length) return env.did.push(`has no creature card with mana value ${k} or less`);
  const [p] = await env.choosers[env.me].pickCards({ prompt: `Return a creature card with mana value ${k} or less`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'reanimate', src: env.src, aiScore: (c) => cardValue(c) });
  if (p) { toBattlefield(p, env.me); env.did.push(`returns ${nameTag(card(p))}`); }
}, { first: true });
// Bilbo: "put up to one target nonland permanent card with mana value 3 or less from a graveyard onto the battlefield under its owner's control"
on(/^put up to one target nonland permanent card with mana value (\d+) or less from a graveyard onto the battlefield under its owner's control$/, async (m, env) => {
  const pool = seats().flatMap((p) => cardsIn(p, 'graveyard')).filter((c) => !isLand(c) && isPermanentCard(DB[c.def]) && (DB[c.def].cmc || 0) <= +m[1]);
  if (!pool.length) return env.did.push('finds nothing');
  const [p] = await env.choosers[env.me].pickCards({ prompt: `Put a nonland permanent card (mana value ${m[1]} or less) from a graveyard onto the battlefield under its owner's control`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'reanimate', src: env.src, aiScore: (c) => (c.owner === env.me ? cardValue(c) : -10) });
  if (!p || (isAI(env.me) && card(p).owner !== env.me)) return;
  toBattlefield(p, card(p).owner);
  env.did.push(`puts ${nameTag(card(p))} onto the battlefield`);
}, { first: true });
// Biomass Mutation
on(/^creatures you control have base power and toughness x\/x until end of turn$/, async (m, env) => {
  const x = env.x || 0;
  const objs = cardsIn(env.me, 'battlefield').filter(isCreature);
  for (const c of objs) { c.setPT = { ts: nextStamp(), p: x, t: x }; c.setPTUntil = 'eot'; }
  env.did.push(`${objs.length} creatures become ${x}/${x} until end of turn`);
}, { first: true });
// Bottle-Cap Blast: "If excess damage was dealt to a permanent this way, create that many tapped Treasure tokens."
on(/^if excess damage was dealt to a permanent this way, create that many tapped treasure tokens$/, async (m, env) => {
  const k = env.excessDamage || 0;
  if (k > 0) await runSentence(`create ${k} tapped treasure tokens`, env);
}, { first: true });
// Bribe Taker
on(/^for each kind of counter on permanents you control, you may put your choice of a \+1\/\+1 counter or a counter of that kind on ~$/, async (m, env) => {
  const me = env.src && card(env.src.iid);
  if (!me) return;
  const kinds = [...new Set(cardsIn(env.me, 'battlefield').flatMap((c) => Object.entries(c.counters || {}).filter(([, v]) => v > 0).map(([k]) => k)))];
  const good = ['flying', 'first strike', 'double strike', 'deathtouch', 'lifelink', 'trample', 'vigilance', 'menace', 'reach', 'hexproof', 'indestructible', 'shield', 'haste'];
  for (const k of kinds) {
    const pick = k === '+1/+1' ? 0 : await env.choosers[env.me].choose({ prompt: `${cardName(me)}: for the ${k} counter kind, put…`, options: [{ label: 'a +1/+1 counter' }, { label: `a ${k} counter` }, { label: 'nothing' }], aiPick: () => (good.includes(k) ? 1 : 0) });
    if (pick === 2) continue;
    addCounters(me, pick === 1 ? k : '+1/+1', 1);
  }
  env.did.push(`puts counters on ${nameTag(me)} for ${kinds.length} kind${kinds.length === 1 ? '' : 's'}`);
}, { first: true });
// Bright-Palm: "That creature can't be blocked by creatures with power 2 or less this turn."
on(/^(that creature|it|target creature) can't be blocked by creatures with power (\d+) or (less|greater) this turn$/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: false });
  for (const c of objs) c.eotText = (c.eotText ? c.eotText + '\n' : '') + `This creature can't be blocked by creatures with power ${m[2]} or ${m[3]}.`;
  if (objs.length) env.did.push(`${objs.map(nameTag).join(', ')} can't be blocked by creatures with power ${m[2]} or ${m[3]} this turn`);
}, { first: true });
// Brudiclad: "each other token you control becomes a copy of that token"
on(/^(?:then )?(?:you may choose a token you control\. if you do, )?each other token you control becomes a copy of that token(?: until end of turn)?$/, async (m, env) => {
  const toks = cardsIn(env.me, 'battlefield').filter((c) => c.token);
  if (toks.length < 2) return;
  const [p] = await env.choosers[env.me].pickCards({ prompt: 'Choose a token: each other token becomes a copy of it', cards: toks.map((c) => c.iid), min: 0, max: 1, purpose: 'copy', src: env.src, aiScore: (c) => cardValue(c) + power(c) });
  const model = p && card(p);
  if (!model) return;
  if (isAI(env.me) && toks.filter((c) => c.iid !== model.iid).reduce((a, c) => a + cardValue(c), 0) > cardValue(model) * (toks.length - 1)) return;
  for (const c of toks) if (c.iid !== model.iid) { c.def = model.def; c.face = model.face || 0; delete c.setPT; }
  env.did.push(`each other token becomes a copy of ${nameTag(model)}`);
}, { first: true });
on(/^(?:then )?you may choose a token you control$/, async (m, env) => {
  if (/each other token you control becomes a copy of that token/i.test(env.text || '')) return;
  return 'pass';
}, { first: true });
on(/^if you do, each other token you control becomes a copy of that token(?: until end of turn)?$/, async (m, env) => runSentence('each other token you control becomes a copy of that token', env), { first: true });
// Cacophony Unleashed
on(/^until end of turn, ~ becomes a legendary (\d+)\/(\d+) ([a-z ]+?) creature with ([a-z ,]+?)(?:\. it's still an? ([a-z]+))?$/, async (m, env) => {
  const c = env.src && card(env.src.iid);
  if (!c || c.zone !== 'battlefield') return;
  c.setPT = { ts: nextStamp(), p: +m[1], t: +m[2] };
  c.setPTUntil = 'eot';
  addLayerFx(c, { until: 'eot', types: { add: 'Creature', subAdd: capWords(m[3]), legendary: true } });
  c.eotGrants = [...(c.eotGrants || []), ...kwList(m[4])];
  env.did.push(`${nameTag(c)} becomes a ${m[1]}/${m[2]} ${capWords(m[3])} until end of turn`);
}, { first: true, multi: true });
on(/^it's still an? ([a-z]+)$/, async () => {}, { first: true });
// Cait, Cage Brawler
on(/^you and defending player each draw a card, then discard a card\. put two \+1\/\+1 counters on ~ if you discarded the card with the greatest mana value among those cards or tied for greatest$/, async (m, env) => {
  const d = env.thatPlayer || opp(env.me);
  const disc = {};
  for (const pid of [env.me, d]) {
    draw(pid, 1, true);
    const hand = cardsIn(pid, 'hand');
    if (!hand.length) continue;
    const [p] = await env.choosers[pid].pickCards({ prompt: 'Discard a card', cards: hand.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'discard', src: env.src, aiScore: (c) => (pid === env.me ? DB[c.def].cmc || 0 : -(DB[c.def].cmc || 0) + (isLand(c) ? 3 : 0)) });
    if (p) { disc[pid] = DB[card(p).def].cmc || 0; discardCard(p); }
  }
  env.did.push('you both draw and discard');
  const me = env.src && card(env.src.iid);
  if (me && disc[env.me] !== undefined && disc[env.me] >= (disc[d] ?? -1)) { addCounters(me, '+1/+1', 2); env.did.push(`puts two +1/+1 counters on ${nameTag(me)}`); }
}, { first: true, multi: true });
// Call Forth the Tempest
on(/^~ deals damage to each creature your opponents control equal to the total mana value of other spells you've cast this turn$/, async (m, env) => {
  const ids = (G.s.ts[env.me].castIids || []).filter((i) => !env.src || i !== env.src.iid);
  const k = ids.reduce((a, i) => a + ((card(i) && DB[card(i).def].cmc) || 0), 0);
  if (!k) return env.did.push('deals no damage');
  await dealDamage(env, (env.src && card(env.src.iid)) || env.src, k, 'each creature your opponents control');
}, { first: true });
// Call for Aid
on(/^you can't attack that player this turn$/, async (m, env) => {
  const pid = env.thatPlayer || (env.targetPlayer) || opp(env.me);
  G.s.cantAttack = [...(G.s.cantAttack || []).filter((x) => x.turn === G.s.turn), { by: env.me, player: pid, turn: G.s.turn }];
  env.did.push(`${who(env.me)} can't attack ${who(pid)} this turn`);
}, { first: true });
on(/^you can't sacrifice those creatures this turn$/, async (m, env) => {
  for (const i of env.them_ || []) if (card(i)) card(i).cantSacUntil = G.s.turn + 1;
}, { first: true });
// Call the Coppercoats
on(/^choose any number of target opponents\. create x (.+?) tokens(?:, where x is the number of creatures those opponents control)?$/, async (m, env) => {
  const k = opponents(env.me).filter(inGame).reduce((a, o) => a + cardsIn(o, 'battlefield').filter(isCreature).length, 0);
  if (k) await runSentence(`create ${k} ${m[1]} tokens`, env);
  else env.did.push('creates no tokens');
}, { first: true, multi: true });
// Canopy Gargantuan
on(/^put a number of \+1\/\+1 counters on each other creature you control equal to that creature's toughness$/, async (m, env) => {
  const objs = cardsIn(env.me, 'battlefield').filter((c) => isCreature(c) && (!env.src || c.iid !== env.src.iid));
  for (const c of objs) { const t = Math.max(0, toughness(c)); if (t) addCounters(c, '+1/+1', t); }
  env.did.push(`puts counters on ${objs.length} creature${objs.length === 1 ? '' : 's'}`);
}, { first: true });
// Celestial Judgment
on(/^for each different power among creatures on the battlefield, choose a creature with that power\. destroy each creature not chosen this way$/, async (m, env) => {
  const all = seats().flatMap((p) => cardsIn(p, 'battlefield')).filter(isCreature);
  const byP = new Map();
  for (const c of all) { const p = power(c); if (!byP.has(p)) byP.set(p, []); byP.get(p).push(c); }
  const keep = new Set();
  for (const [p, list] of byP) {
    if (list.length === 1) { keep.add(list[0].iid); continue; }
    const [k] = await env.choosers[env.me].pickCards({ prompt: `Keep which creature with power ${p}?`, cards: list.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'keep', src: env.src, aiScore: (c) => (c.controller === env.me ? 10 : 0) + cardValue(c) / 5 });
    keep.add(k);
  }
  const gone = all.filter((c) => !keep.has(c.iid));
  for (const c of gone) destroy(c.iid);
  env.did.push(`destroys ${gone.length} creature${gone.length === 1 ? '' : 's'}`);
}, { first: true, multi: true });
// Chalice of the Void: "counter that spell"
on(/^counter that spell$/, async (m, env) => {
  const sp = env.it && env.it.iid ? card(env.it.iid) : null;
  const slot = sp && G.s.stack && G.s.stack.iid === sp.iid ? G.s.stack : sp && G.s.pstack && G.s.pstack.iid === sp.iid ? G.s.pstack : null;
  if (!sp || sp.zone !== 'stack' && !slot) return env.did.push('has no spell to counter');
  if (cantBeCountered(sp)) return env.did.push(`${nameTag(sp)} can't be countered`);
  if (slot) slot.countered = true;
  else sp.counteredNow = true;
  env.did.push(`counters ${nameTag(sp)}`);
}, { first: true });
// Bloodthirsty Adversary
on(/^(?:you may )?pay ((?:\{[^}]+\})+) any number of times\. when you pay this cost one or more times, put that many \+1\/\+1 counters on ~, then exile up to that many target instant and\/or sorcery cards with mana value (\d+) or less from your graveyard and copy them\. you may cast any number of the copies without paying their mana costs$/, async (m, env) => {
  const cost = m[1].toUpperCase();
  let k = 0;
  if (isAI(env.me)) {
    const gyN = cardsIn(env.me, 'graveyard').filter((c) => /Instant|Sorcery/.test(DB[c.def].faces[0].typeLine || '') && (DB[c.def].cmc || 0) <= +m[2]).length;
    while (k < Math.max(1, gyN) && T.payMana && (await T.payMana(env.me, cost, cardName(env.src)))) k++;
  } else {
    while (await env.choosers[env.me].confirm(cardName(env.src), `Pay ${cost}${k ? ' again' : ''}? (${k} so far)`)) {
      if (!T.payMana || !(await T.payMana(env.me, cost, cardName(env.src)))) break;
      k++;
    }
  }
  if (!k) return env.did.push('pays nothing');
  const me = env.src && card(env.src.iid);
  if (me) addCounters(me, '+1/+1', k);
  const pool = cardsIn(env.me, 'graveyard').filter((c) => /Instant|Sorcery/.test(DB[c.def].faces[0].typeLine || '') && (DB[c.def].cmc || 0) <= +m[2]);
  const picks = pool.length ? await env.choosers[env.me].pickCards({ prompt: `Exile up to ${k} instant/sorcery cards to copy`, cards: pool.map((c) => c.iid), min: 0, max: k, purpose: 'copy', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 }) : [];
  const copies = [];
  for (const i of picks) { move(i, 'exile'); const cid = makeCard(card(i).def, env.me, 'exile'); card(cid).copyCard = true; copies.push(cid); }
  env.did.push(`pays ${k} time${k === 1 ? '' : 's'}: ${k} +1/+1 counters, ${copies.length} cop${copies.length === 1 ? 'y' : 'ies'}`);
  if (copies.length) await castFromPool(env, copies, { free: true, max: copies.length });
  for (const cid of copies) if (card(cid) && card(cid).zone === 'exile') { delete G.s.cards[cid]; const z = zoneOf(env.me, 'exile'); const i = z.indexOf(cid); if (i >= 0) z.splice(i, 1); }
}, { first: true, multi: true });
// Boreas Charger
on(/^choose an opponent who controls more lands than you\. search your library for a number of ([a-z]+) cards equal to the difference, reveal those cards, put one of them onto the battlefield tapped and the rest into your hand, then shuffle$/, async (m, env) => {
  const mine = cardsIn(env.me, 'battlefield').filter(isLand).length;
  const os = opponents(env.me).filter(inGame).map((o) => [o, cardsIn(o, 'battlefield').filter(isLand).length - mine]).filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]);
  if (!os.length) return env.did.push('no opponent has more lands');
  const k = os[0][1];
  const pool = cardsIn(env.me, 'library').filter((c) => hasSubtype(c, capWords(m[1]))).slice(0, k);
  pool.forEach((c, i) => (i === 0 ? toBattlefield(c.iid, env.me, { tapped: true }) : move(c.iid, 'hand')));
  shuffle(env.me);
  env.did.push(`finds ${pool.length} ${capWords(m[1])}${pool.length === 1 ? '' : 's'}`);
}, { first: true, multi: true });
// Teferi, Temporal Pilgrim −12
on(/^target opponent chooses a permanent they control and returns it to its owner's hand\. then they shuffle each nonland permanent they control into its owner's library$/, async (m, env) => {
  const [o] = await playerTarget(env, 'target opponent');
  if (!o) return;
  const mine = cardsIn(o, 'battlefield').filter((c) => !c.phasedOut);
  let saved = null;
  if (mine.length) {
    const [pick] = await env.choosers[o].pickCards({ prompt: 'Choose a permanent you control to return to your hand (everything else nonland gets shuffled away)', cards: mine.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'save', src: env.src, aiScore: (c) => cardValue(c) * (c.token ? 0.2 : 1) + (isLand(c) ? -5 : 0) });
    if (pick && card(pick)) {
      saved = nameTag(card(pick));
      move(pick, 'hand');
    }
  }
  const gone = cardsIn(o, 'battlefield').filter((c) => !isLand(c) && !c.phasedOut);
  const owners = new Set();
  for (const c of gone) {
    owners.add(c.owner);
    move(c.iid, 'library');
  }
  for (const w of owners) shuffle(w);
  env.did.push(`${who(o)} ${s_(o, 'return')} ${saved || 'nothing'} to hand and ${s_(o, 'shuffle')} ${gone.length} nonland permanent${gone.length === 1 ? '' : 's'} into ${who(o) === 'you' ? 'your' : 'their'} library`);
}, { first: true, multi: true });
// Selvala's Stampede: "Reveal cards from the top of your library until you reveal a creature card for each wild vote. Put those creature cards onto the battlefield, then shuffle the rest into your library."
on(/^reveal cards from the top of your library until you reveal a creature card for each (\w+) vote\. put those creature cards onto the battlefield, then shuffle the rest(?: of the revealed cards)? into your library$/, async (m, env) => {
  const k = (env.votes && env.votes.tally.get(m[1])) || 0;
  if (!k) return env.did.push(`no ${m[1]} votes`);
  const got = revealCreaturesOnto(env.me, k);
  env.them_ = got;
  env.did.push(`${got.length} creature${got.length === 1 ? '' : 's'} onto the battlefield`);
}, { first: true, multi: true });
// Expropriate: "For each money vote, choose a permanent owned by the voter and gain control of it."
on(/^for each (\w+) vote, choose a permanent owned by the voter and gain control of it$/, async (m, env) => {
  for (const voter of seats()) {
    for (const v of (env.votes ? env.votes.byVoter[voter] : []).filter((x) => x === m[1])) {
      void v;
      if (voter === env.me) continue; // your own permanents are yours already
      const cs = cardsIn(voter, 'battlefield').filter((c) => c.owner === voter);
      if (!cs.length) continue;
      const [pick] = await env.choosers[env.me].pickCards({ forced: true, prompt: `Gain control of a permanent ${voter === 'p' ? 'you own' : 'the AI owns'}`, cards: cs.map((c) => c.iid), min: 1, max: 1, purpose: 'steal', src: env.src, aiScore: (c) => cardValue(c) });
      if (!pick) continue;
      move(pick, 'battlefield', { controller: env.me });
      env.did.push(`gains control of ${nameTag(card(pick))}`);
    }
  }
}, { first: true });
// Mob Verdict: "For each vote an opponent received, ~ deals 2 damage to that player and each creature that player controls. For each vote you received, draw a card."
on(/^for each vote an opponent received, ~ deals (\w+) damage to that player and each creature that player controls$/, async (m, env) => {
  const them = opp(env.me);
  const k = env.votes ? env.votes.tally.get(them) || 0 : 0;
  const amt = n(m[1]) * k;
  if (!amt) return env.did.push('the opponent got no votes');
  damagePlayer(env, env.src, them, amt);
  const cs = cardsIn(them, 'battlefield').filter(isCreature);
  for (const c of cs) damagePermanent(env, env.src, c, amt);
  env.did.push(`and to each creature ${them === 'p' ? 'you control' : 'the AI controls'}`);
}, { first: true });
on(/^for each vote you received, draw a card$/, async (m, env) => {
  const k = env.votes ? env.votes.tally.get(env.me) || 0 : 0;
  if (k) draw(env.me, k);
  env.did.push(k ? `draws ${k}` : 'got no votes');
}, { first: true });
// Círdan: "Each player draws a card for each vote they received. Each player who received no votes may put a permanent card from their hand onto the battlefield."
on(/^each player draws a card for each vote they received$/, async (m, env) => {
  for (const pid of seats()) {
    const k = env.votes ? env.votes.tally.get(pid) || 0 : 0;
    if (k) draw(pid, k);
  }
  env.did.push('each player draws for their votes');
}, { first: true });
on(/^each player who received no votes may put a permanent card from their hand onto the battlefield$/, async (m, env) => {
  for (const pid of seats()) {
    if (env.votes && env.votes.tally.get(pid)) continue;
    const hand = cardsIn(pid, 'hand').filter(isPermanentCard);
    if (!hand.length) continue;
    const [pick] = await env.choosers[pid].pickCards({ prompt: 'You may put a permanent card from your hand onto the battlefield', cards: hand.map((c) => c.iid), min: 0, max: 1, purpose: 'put', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
    if (pick) {
      toBattlefield(pick, pid);
      env.did.push(`${who(pid)} ${s_(pid, 'put')} ${nameTag(card(pick))} onto the battlefield`);
    }
  }
}, { first: true });
// Elrond: "For each fellowship vote, the voter chooses a creature they control. You gain control of each creature chosen this way, …"
on(/^for each (\w+) vote, the voter chooses a creature they control$/, async (m, env) => {
  env.chosenThisWay = [];
  for (const voter of seats()) {
    for (const v of (env.votes ? env.votes.byVoter[voter] : []).filter((x) => x === m[1])) {
      void v;
      const cs = cardsIn(voter, 'battlefield').filter(isCreature);
      if (!cs.length) continue;
      const [pick] = await env.choosers[voter].pickCards({ forced: true, prompt: 'Choose a creature you control', cards: cs.map((c) => c.iid), min: 1, max: 1, purpose: 'give', src: env.src, aiScore: (c) => (voter === env.me ? cardValue(c) : -cardValue(c)) });
      if (pick) env.chosenThisWay.push(pick);
    }
  }
}, { first: true });
on(/^you gain control of each creature chosen this way(?:, and they gain "[^"]*")?$/, async (m, env) => {
  for (const iid of env.chosenThisWay || []) if (card(iid) && card(iid).controller !== env.me) {
    move(iid, 'battlefield', { controller: env.me });
    env.did.push(`gains control of ${nameTag(card(iid))}`);
  }
}, { first: true });

// --- learn: no sideboard here, so learn is a rummage
on(/^learn/, async (m, env) => {
  const hand = cardsIn(env.me, 'hand');
  if (!hand.length) return;
  const yes = await env.choosers[env.me].confirm('Learn', 'Discard a card to draw a card? (There is no sideboard to fetch a Lesson from.)', env);
  if (!yes) return;
  const [pick] = await env.choosers[env.me].pickCards({ forced: true, prompt: 'Discard a card', cards: hand.map((c) => c.iid), min: 1, max: 1, purpose: 'discard', src: env.src, aiScore: (c) => (isLand(c) ? 5 : -DB[c.def].cmc) });
  discardCard(pick);
  draw(env.me, 1, true);
  env.did.push('learns (rummages)');
});

// --- endure (Duskmourn)
on(/^(~|it|target creature you control) endures (\d+|x)/, async (m, env) => {
  const [c] = await objects(env, m[1], { harm: false });
  const k = n(m[2], env.x);
  const asToken = !c || c.zone !== 'battlefield' || (env.me === 'p' && !(await env.choosers.p.confirm('Endure', `Put ${k} +1/+1 counters on ${cardName(c)}? (No creates a ${k}/${k} Spirit instead.)`)));
  if (asToken) createToken(genericTokenDef(k, k, 'Spirit', ['W']), env.me, 1);
  else addCounters(c, '+1/+1', k);
  env.did.push(`endures ${k}`);
});

// --- forage / collect evidence as effects (usually costs, handled by the cast code)
on(/^(?:you may )?forage/, async (m, env) => {
  const food = cardsIn(env.me, 'battlefield').find((c) => hasSubtype(c, 'Food'));
  if (food) sacrifice(food.iid);
  else cardsIn(env.me, 'graveyard').slice(0, 3).forEach((c) => move(c.iid, 'exile'));
  env.did.push('forages');
});

// ------------------------------------------------------------ running text
function prep(text, src) {
  return stripName(String(text || ''), src).replace(/\([^)]*\)/g, '').replace(/\s+\./g, '.').trim();
}

async function runText(text, env) {
  // modal spells: "Choose one —" with bullet modes
  const mm = text.match(/^([\s\S]*?)Choose (one|two|three|four|one or both|one or more|any number|up to (?:one|two|three|four|five)|one that hasn't been chosen(?: this turn)?)(?: or more)?(?:\. You may choose the same mode more than once)?(?: at random(?:\. If you discarded a card this turn, you choose one instead)?)?(?: ?(?:—|-)|\.)\s*\n?((?:\s*•[^\n]*\n?)+)([\s\S]*)$/i);
  if (mm) {
    // "Whenever a player casts a spell, if it isn't that player's turn, choose one —" (an intervening if before the modes)
    const ifm = mm[1].match(/(^|[.\n]\s*)if ([^,.]+),\s*$/i);
    if (ifm) {
      const pre = mm[1].slice(0, ifm.index + ifm[1].length);
      if (pre.trim()) await runText(pre, env);
      if (!evalCond(ifm[2], env)) return;
    } else if (/(^|[.\n]\s*)When you do,\s*$/i.test(mm[1])) {
      // Caesar: "you may sacrifice another creature. When you do, choose two —" (a reflexive trigger)
      const pre = mm[1].replace(/When you do,\s*$/i, '');
      env.lastMay = undefined;
      if (pre.trim()) await runText(pre, env);
      if (env.lastMay === false || env.lastDone === false) return;
    } else if (mm[1].trim()) await runText(mm[1], env);
    let modes = mm[3].split('•').map((x) => x.trim()).filter(Boolean);
    const want = mm[2].toLowerCase();
    // "choose one that hasn't been chosen" (Silent Hallcreeper, the Hidden Ones…): each mode once per object
    let fresh = null;
    if (/hasn't been chosen/.test(want)) {
      const holder = (env.src && card(env.src.iid)) || env.src;
      // Lita: "choose one that hasn't been chosen this turn" — the list starts over each turn
      if (/this turn/.test(want) && holder && holder.modesUsedTurn !== G.s.turn) {
        holder.modesUsed = [];
        holder.modesUsedTurn = G.s.turn;
      }
      const used = (holder && holder.modesUsed) || [];
      fresh = { holder, idx: modes.map((t, k) => k).filter((k) => !used.includes(modes[k])) };
      if (!fresh.idx.length) {
        env.did.push('every mode has already been chosen');
        if (mm[4].trim()) await runText(mm[4], env);
        return;
      }
    }
    const allModes = modes;
    if (fresh) modes = fresh.idx.map((k) => allModes[k]);
    let max = /^one(?: that hasn't been chosen(?: this turn)?)?$/.test(want) ? 1 : /^two$/.test(want) ? 2 : /^three$/.test(want) ? 3 : modes.length;
    if (/up to one/.test(want)) max = 1;
    if (/up to two/.test(want)) max = 2;
    if (/up to three/.test(want)) max = 3;
    if (/up to four|^four$/.test(want)) max = 4;
    if (/up to five/.test(want)) max = 5;
    // Moment of Reckoning: "You may choose the same mode more than once." — offer each mode that many times
    if (/You may choose the same mode more than once/i.test(mm[0]) && !fresh && max < 99) modes = Array.from({ length: max }, () => modes).flat();
    if (env.entwined) max = modes.length;
    const min = /any number|up to/.test(want) ? 0 : /one or (?:both|more)/.test(want) ? 1 : Math.min(max, modes.length);
    // Typhoid Mary: "Choose one at random. If you discarded a card this turn, you choose one instead."
    const atRandom = / at random/i.test(mm[0].slice(mm[1].length, mm[0].length - mm[3].length - mm[4].length)) && !(/If you discarded a card this turn, you choose one instead/i.test(mm[0]) && (G.s.ts[env.me].discarded || []).length);
    const picks = env.modes || (atRandom ? [Math.floor(Math.random() * modes.length)] : null) || (await env.choosers[env.me].chooseModes({
      prompt: `${cardName(env.src)}: choose ${want}`, modes: modes.map((t) => t.replace(/\s+$/, '')), min, max: Math.min(max, modes.length), src: env.src,
      escalate: kwCostText(env.src, 'Escalate'), spree: /Spree/i.test(oracle(env.src)),
      aiScore: (t) => modeValue(t, env),
    }));
    env.modesChosen = picks;
    if (fresh && fresh.holder) fresh.holder.modesUsed = [...(fresh.holder.modesUsed || []), ...picks.map((k) => modes[k])];
    for (const k of picks) {
      let t = modes[k];
      t = t.replace(/^\+((?:\{[^}]+\})+) — /, ''); // spree costs are paid when casting
      t = t.replace(/^(?:[A-Z][A-Za-z' ,-]{2,40}|~) — (?=[A-Z])/, ''); // mode names ("Sell Contraband — Create a Treasure token.")
      if (atRandom) env.did.push(`randomly chose: ${t.replace(/\.$/, '')}`);
      await runText(t, env);
    }
    if (mm[4].trim()) await runText(mm[4], env);
    return;
  }
  const sentences = splitSentences(text);
  const skip = new Set();
  // "If X, … instead": when X holds, the previous sentence doesn't happen
  for (let i = 0; i < sentences.length; i++) {
    // Andúril: "If that creature is legendary, instead create two of those tokens that are tapped and attacking."
    const sm2 = i > 0 && sentences[i].match(/^if (.+?), instead (.+?)\.?$/i);
    if (sm2) {
      if (!evalCond(sm2[1], env)) {
        skip.add(i);
        continue;
      }
      const prev = sentences[i - 1];
      const ta = sm2[2].match(/^create (\w+) of (?:those|these) tokens that are tapped and attacking$/i);
      if (ta && /^create /i.test(prev)) {
        sentences[i - 1] = prev.replace(/^create \w+ /i, `create ${ta[1]} `).replace(/\btapped (?!and attacking)/i, '').replace(/\b(tokens?)\b( with [^.]+)?\.?$/i, '$1 that are tapped and attacking$2.');
        skip.add(i);
      } else {
        skip.add(i - 1);
        sentences[i] = sm2[2] + '.';
      }
      continue;
    }
    const sm = sentences[i].match(/^if (.+?), (.+?) instead\.?$/i);
    if (!(sm && i > 0)) continue;
    if (!evalCond(sm[1], env)) {
      skip.add(i);
      continue;
    }
    // "…deals 2 damage to any target. If kicked, it deals 4 damage instead." → change the number in place
    const prev = sentences[i - 1];
    const dm = sm[2].match(/^(?:it|~|this spell) deals (\w+) damage(?: to (?:that|those|each of those) [a-z ]+)?$/i);
    const dr = sm[2].match(/^(?:you )?draws? (\w+) cards?$/i);
    const gm = sm[2].match(/^(?:you )?gains? (\w+) life$/i);
    const cm = sm[2].match(/^copy (?:it|that spell) (twice|thrice|\w+ times)$/i);
    if (cm && /^copy (?:it|that spell)\.?$/i.test(prev.trim())) {
      sentences[i - 1] = prev.replace(/^(copy (?:it|that spell))\.?/i, `$1 ${cm[1]}.`);
      skip.add(i);
      continue;
    }
    const tm = sm[2].match(/^create (\w+) of (?:those|these) tokens$/i);
    if (dm && /deals \w+ damage/i.test(prev)) {
      sentences[i - 1] = prev.replace(/deals \w+ damage/i, `deals ${dm[1]} damage`);
      skip.add(i);
    } else if (dr && /draws? \w+ cards?/i.test(prev)) {
      sentences[i - 1] = prev.replace(/(draws?) \w+ (cards?)/i, `$1 ${dr[1]} cards`);
      skip.add(i);
    } else if (tm && /\bcreates? (?:a|an|one|\w+) /i.test(prev)) {
      // "Create a Treasure token. If …, create three of those tokens instead."
      sentences[i - 1] = prev.replace(/\b(creates?) (?:a|an|one|\w+) /i, `$1 ${tm[1]} `).replace(/\btoken\b(?!s)/i, 'tokens');
      skip.add(i);
    } else if (gm && /gains? \w+ life/i.test(prev)) {
      sentences[i - 1] = prev.replace(/(gains?) \w+ life/i, `$1 ${gm[1]} life`);
      skip.add(i);
    } else skip.add(i - 1);
  }
  for (let i = 0; i < sentences.length; i++) {
    if (skip.has(i)) continue;
    if (G.s.winner || env.wardCountered) return;
    env.next = sentences[i + 1] || '';
    env.prevSent = i > 0 ? sentences[i - 1] : '';
    if (env.skipDependent) {
      if (/^(?:put|return|exile|cast|play|shuffle) (?:that card|those cards|it|them|the rest)\b/i.test(sentences[i].trim())) continue;
      env.skipDependent = false;
    }
    // handlers written for several sentences at once (marked multi): "Reveal the top three cards… An opponent separates…"
    let joinedRun = false;
    for (let k = 6; k >= 1 && !joinedRun; k--) {
      if (i + k >= sentences.length) continue;
      const joined = sentences.slice(i, i + k + 1).map((x) => x.trim().replace(/\.$/, '')).join('. ');
      const low = joined.toLowerCase();
      if (H.some((h) => h.multi && h.re.test(low))) {
        await runSentence(joined, env);
        i += k;
        joinedRun = true;
      }
    }
    if (joinedRun) continue;
    if (env.xWhere && /\bx\b/i.test(sentences[i])) whereX(env);
    const consumed = await runSentence(sentences[i], env);
    if (consumed === 'rest') return;
  }
}

// Hideaway: play (or cast) the hidden card for free, if the condition holds
async function hideawayPlay(env, hidden, canPlayLand, cond) {
  env.lastMay = false;
  if (cond) {
    let ok = null;
    try {
      ok = evalCond(cond, env);
    } catch (e) {
      ok = null;
    }
    // a condition the engine can't check: you say whether it holds; the AI assumes it doesn't
    if (ok === null) ok = isAI(env.me) ? false : await env.choosers[env.me].confirm(cardName(env.src), `Is this true: “${cond}”?`, { yes: 'Yes', no: 'No' });
    if (!ok) return env.did.push(`can't play the hidden card yet (${cond})`);
  }
  let pick = hidden[0];
  if (hidden.length > 1) [pick] = await env.choosers[env.me].pickCards({ prompt: 'Play which hidden card?', cards: hidden.map((c) => c.iid), min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 }).then((r) => [r[0] && card(r[0])]);
  if (!pick) return;
  const c = card(pick.iid || pick);
  if (isLand(c)) {
    if (!canPlayLand) return env.did.push(`can't cast ${nameTag(c)} (a land)`);
    const { landsAllowed } = await import('./cast.js');
    if ((G.s.landsPlayed || 0) >= landsAllowed(env.me) || G.s.active !== env.me) return env.did.push(`can't play ${nameTag(c)} now (no land drop left)`);
    if (!(await env.choosers[env.me].confirm(cardName(c), `Play ${cardName(c)} (your land for the turn)?`, { aiPick: () => true }))) return;
    delete c.hiddenBy;
    delete c.hiddenExile;
    G.s.lastLandPlay = { iid: c.iid, from: 'exile', pid: env.me };
    toBattlefield(c.iid, env.me);
    G.s.landsPlayed = (G.s.landsPlayed || 0) + 1;
    env.lastMay = true;
    return env.did.push(`plays ${nameTag(c)} from hideaway`);
  }
  if (!T.castFree) return;
  if (!(await env.choosers[env.me].confirm(cardName(c), `Cast ${cardName(c)} without paying its mana cost?`, { aiPick: () => true }))) return;
  delete c.hiddenExile;
  let ok = false;
  try {
    ok = await T.castFree(env.me, c.iid);
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
  }
  if (ok === false) return;
  env.lastMay = true;
  env.did.push(`casts ${nameTag(c)} from hideaway for free`);
}
// Prepared: "this creature becomes prepared" (Joined Researchers, Lorehold Archivist, Harmonized Trio)
on(/^(?:~|it|this creature) becomes prepared$/, async (m, env) => {
  const c = env.src && card(env.src.iid);
  if (!c || c.zone !== 'battlefield') return env.did.push('is no longer on the battlefield');
  c.prepared = true;
  env.did.push(`${nameTag(c)} becomes prepared`);
}, { first: true });
// The War Doctor: "If a creature dealt damage this way would die this turn, exile it instead."
on(/^if a creature dealt damage this way would die this turn, exile it instead$/, async (m, env) => {
  for (const i of env.damagedThisWay || []) if (card(i) && card(i).zone === 'battlefield') card(i).exileIfDiesTurn = G.s.turn;
}, { first: true });
// Doom's Time Platform: "exile target nonland card from your graveyard with two time counters on it"
on(/^exile (target (?:nonland )?card from your graveyard) with (\w+) time counters? on it$/, async (m, env) => {
  const [r] = await pickTargets(env, m[1], { harm: false, purpose: 'reanimate' });
  const c = r && r.iid && card(r.iid);
  if (!c || c.zone !== 'graveyard') return env.did.push('no card to exile');
  move(c.iid, 'exile');
  c.counters = { ...(c.counters || {}), time: n(m[2]) };
  env.it = { iid: c.iid };
  env.did.push(`exiles ${nameTag(c)} with ${n(m[2])} time counters`);
}, { first: true });
// The Tenth / Eleventh Doctor: suspend by time counters
on(/^if it doesn't have suspend, it gains suspend$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  if (!c || c.zone !== 'exile') return;
  c.suspended = true;
  if (c.mayPlay) c.mayPlay = null;
  env.did.push(`${nameTag(c)} is suspended (${(c.counters || {}).time || 0} time counter${(c.counters || {}).time === 1 ? '' : 's'})`);
}, { first: true });
on(/^put (\w+) time counters? on it$/, async (m, env) => {
  const c = env.it && card(env.it.iid);
  if (!c || c.zone === 'battlefield') return 'pass'; // a permanent: the normal counter handler
  c.counters = c.counters || {};
  c.counters.time = (c.counters.time || 0) + n(m[1]);
  env.did.push(`puts ${n(m[1])} time counter${n(m[1]) === 1 ? '' : 's'} on ${nameTag(c)}`);
}, { first: true });
on(/^(?:you may )?exile a card from your hand with a number of time counters on it equal to its mana value$/, async (m, env) => {
  const hand = cardsIn(env.me, 'hand');
  if (!hand.length) return env.did.push('has no cards in hand');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'Exile a card from your hand with time counters equal to its mana value (it gains suspend)', cards: hand.map((c) => c.iid), min: 0, max: 1, purpose: 'suspend', src: env.src, aiScore: (c) => (isLand(c) ? -10 : (DB[c.def].cmc || 0) <= 3 ? 10 - (DB[c.def].cmc || 0) : 0) });
  if (!pick) return;
  const c = card(pick);
  move(pick, 'exile');
  c.counters = c.counters || {};
  c.counters.time = DB[c.def].cmc || 0;
  env.it = { iid: pick };
  env.lastMay = true;
  env.did.push(`exiles ${nameTag(c)} with ${c.counters.time} time counter${c.counters.time === 1 ? '' : 's'}`);
}, { first: true });
// Time travel: "For each suspended card you own and each permanent you control with a time counter on it, you may add or remove
// a time counter." Doing it N times is the same as picking a net change of up to N for each one.
on(/^time travel(?: (twice|three times|(\w+) times))?$/, async (m, env) => {
  const times = !m[1] ? 1 : m[1] === 'twice' ? 2 : m[1] === 'three times' ? 3 : n(m[2]) || 1;
  const pool = Object.values(G.s.cards).filter((c) => (c.zone === 'exile' && c.owner === env.me && c.suspended && (c.counters || {}).time > 0)
    || (c.zone === 'battlefield' && c.controller === env.me && (c.counters || {}).time > 0));
  if (!pool.length) return env.did.push('has nothing to time travel');
  for (const c of pool) {
    const have = c.counters.time;
    const opts = [];
    for (let k = -Math.min(times, have); k <= times; k++) opts.push(k);
    const aiPick = () => opts.indexOf(c.zone === 'exile' ? opts[0] : opts[opts.length - 1]);
    const k = await env.choosers[env.me].choose({ prompt: `Time travel: ${cardName(c)} has ${have} time counter${have === 1 ? '' : 's'}`, options: opts.map((d) => ({ label: d < 0 ? `Remove ${-d}` : d > 0 ? `Add ${d}` : 'Leave it' })), aiPick });
    const d = opts[k] || 0;
    if (!d) continue;
    c.counters.time = have + d;
    env.did.push(`${d > 0 ? 'adds' : 'removes'} ${Math.abs(d)} time counter${Math.abs(d) === 1 ? '' : 's'} ${d > 0 ? 'to' : 'from'} ${nameTag(c)}`);
    // the last time counter removed from a suspended card: cast it without paying its mana cost
    if (c.zone === 'exile' && c.suspended && !c.counters.time && T.castFree) {
      env.did.push(`casts ${nameTag(c)} (suspend)`);
      await T.castFree(c.owner, c.iid);
      if (card(c.iid) && card(c.iid).zone === 'battlefield' && isCreature(card(c.iid))) card(c.iid).grants = [...(card(c.iid).grants || []), 'haste'];
    }
  }
}, { first: true });
// Hex Magic: "Exile all the cards from your hand, then draw that many cards. Until the end of your next turn, you may play cards exiled this way."
on(/^exile all the cards from your hand, then draw that many cards\. until the end of your next turn, you may play cards exiled this way$/, async (m, env) => {
  const ids = [...zoneOf(env.me, 'hand')];
  ids.forEach((i) => move(i, 'exile'));
  draw(env.me, ids.length, true);
  grantPlay(ids, env.me, { until: nextTurnNumber(env.me) });
  env.did.push(`exiles ${ids.length} card${ids.length === 1 ? '' : 's'} from ${env.me === 'p' ? 'your' : 'its'} hand and draws ${ids.length}; they can be played until the end of ${env.me === 'p' ? 'your' : 'its'} next turn`);
}, { first: true, multi: true });
// Heroes' Hangout (Date Night): "Exile the top two cards of your library. Choose one of them. Until the end of your next turn, you may play that card."
on(/^exile the top (\w+) cards of your library\. choose one of them\. until the end of your next turn, you may play that card$/, async (m, env) => {
  const ids = exileTop(env.me, n(m[1]));
  if (!ids.length) return env.did.push('has no library left');
  const [pick] = await env.choosers[env.me].pickCards({ forced: true, prompt: 'Choose one of them — you may play it until the end of your next turn', cards: ids, min: 1, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => (isLand(c) ? 1 : DB[c.def].cmc || 0) });
  if (pick) grantPlay([pick], env.me, { until: nextTurnNumber(env.me) });
  env.did.push(`exiles ${ids.map((i) => nameTag(card(i))).join(', ')}${pick ? `; may play ${nameTag(card(pick))} until the end of ${env.me === 'p' ? 'your' : 'its'} next turn` : ''}`);
}, { first: true, multi: true });
// Dance with Calamity: "Shuffle your library. As many times as you choose, you may exile the top card of your library. If the total mana value
// of the cards exiled this way is 13 or less, you may cast any number of spells from among those cards without paying their mana costs."
on(/^shuffle your library\. as many times as you choose, you may exile the top card of your library\. if the total mana value of the cards exiled this way is (\d+) or less, you may cast any number of spells from among those cards without paying their mana costs$/, async (m, env) => {
  const cap = +m[1];
  shuffle(env.me);
  const ids = [];
  let total = 0;
  for (;;) {
    const lib = zoneOf(env.me, 'library');
    if (!lib.length) break;
    // the AI stops once another card would likely bust it (an average card is ~3)
    const aiWants = () => total <= cap - 4;
    const shown = ids.length ? ` So far: ${ids.map((i) => cardName(card(i))).join(', ')} (total ${total}).` : '';
    const more = await env.choosers[env.me].confirm(cardName(env.src), `Exile the top card of your library? Total mana value must stay ${cap} or less.${shown}`, { aiPick: aiWants, yes: 'Exile another', no: 'Stop' });
    if (isAI(env.me) ? !aiWants() : !more) break;
    const [i] = exileTop(env.me, 1);
    if (!i) break;
    ids.push(i);
    total += DB[card(i).def].cmc || 0;
    if (env.me === 'p') log('p', `Dance with Calamity exiles ${nameTag(card(i))} (total ${total}).`);
  }
  env.did.push(`exiles ${ids.length} card${ids.length === 1 ? '' : 's'} (total mana value ${total})`);
  if (total > cap) return env.did.push(`over ${cap} — no free spells`);
  await castFromPool(env, ids, { free: true });
}, { first: true, multi: true });
// Advanced Reconstruction: "exile a card from your graveyard at random. You may play the exiled card this turn."
on(/^exile (a|one|two) cards? from your graveyard at random$/, async (m, env) => {
  const gy = [...zoneOf(env.me, 'graveyard')];
  if (!gy.length) {
    env.it = null;
    env.them_ = [];
    return env.did.push('has an empty graveyard');
  }
  const k = Math.min(gy.length, n(m[1]));
  const ids = gy.sort(() => Math.random() - 0.5).slice(0, k);
  ids.forEach((i) => move(i, 'exile'));
  env.it = { iid: ids[0] };
  env.them_ = ids;
  env.did.push(`exiles ${ids.map((i) => nameTag(card(i))).join(', ')} from ${env.me === 'p' ? 'your' : 'its'} graveyard at random`);
}, { first: true });
// Sevinne's Reclamation: "If this spell was cast from a graveyard, you may copy this spell and may choose a new target for the copy."
on(/^(?:you may )?copy (?:this spell|~)(?: and (?:you )?may choose (?:a )?new targets? for the copy)?$/, async (m, env) => {
  if (!env.src) return;
  // the copy does what the spell does (minus this copying sentence and its condition)
  const text = spellText(env.src)
    .split(/(?<=\.)\s+|\n/)
    .filter((x) => x.trim() && !/copy (?:this spell|~)/i.test(x) && !/^if this spell was cast from/i.test(x.trim()))
    .join(' ');
  if (!text.trim()) return;
  queueEvent({ type: 'copySpell', controller: env.me, iid: env.src.iid });
  const did = await resolveEffects(text, env.src, { me: env.me, choosers: env.choosers, castFree: env.castFree, x: env.x || 0 });
  env.did.push(`copies ${nameTag(env.src)}${did.length ? ': ' + did.join('; ') : ''}`);
}, { first: true });
// Demonstrate: "When you cast this spell, you may copy it. If you do, choose an opponent to also copy it."
on(/^demonstrate$/, async (m, env) => {
  const sp = env.it && card(env.it.iid);
  if (!sp) return;
  const yes = await env.choosers[env.me].confirm(cardName(env.src), `Demonstrate: copy ${cardName(sp)}? If you do, your opponent also copies it.`, { aiPick: () => true });
  if (!yes) return;
  await runSentence('copy it', env);
  const o = opp(env.me);
  const did = [];
  await runSentence('copy it', { ...env, me: o, did, src: { ...sp, controller: o } });
  env.did.push(`${who(o)} also ${o === "ai" ? "copies" : "copy"} it${did.length ? ' (' + did.join('; ') + ')' : ''}`);
}, { first: true });
// Watcher for Tomorrow: "When ~ leaves the battlefield, put the exiled card into its owner's hand."
on(/^put the exiled card into its owner's hand$/, async (m, env) => {
  const hidden = env.src ? Object.values(G.s.cards).filter((x) => x.zone === 'exile' && x.hiddenBy === env.src.iid) : [];
  for (const c of hidden) {
    delete c.hiddenExile;
    move(c.iid, 'hand');
  }
  env.did.push(hidden.length ? `puts ${hidden.map(nameTag).join(', ')} into ${hidden[0].seatPoss(owner)} hand` : 'has no card hidden away');
}, { first: true });

async function runSentence(sentence, env) {
  let s = sentence.trim().replace(/\s{2,}/g, ' ').replace(/ ([.,])/g, '$1').replace(/\.$/, '').replace(/^then,? /i, '').replace(/^also,? /i, '');
  // Marvel/Spider-Man cards name their creature "he"/"she": "He gets +1/+0 until end of turn"
  // Karn, Living Legacy: "Look at that many cards from the top of your library" after paying mana
  if (/^look at that many cards\b/i.test(s) && env.lastAmount != null) {
    if (!env.lastAmount) return env.did.push('looks at no cards');
    s = s.replace(/^look at that many cards\b/i, `look at the top ${env.lastAmount} cards`).replace(/ from the top of your library/i, ' of your library');
  }
  // energy paid earlier in this ability: "the amount of {E} paid this way", "{1} for each {E} paid this way"
  if (env.energyPaid != null && /\{e\} paid this way/i.test(s)) {
    const k = env.energyPaid;
    s = s.replace(/\{1\} for each \{e\} paid this way/i, `{${k}}`).replace(/(?:to )?the amount of \{e\} paid this way/gi, (x) => (/^to /i.test(x) ? 'to ' : '') + k);
  }
  s = s.replace(/^(return|exile|sacrifice|tap|untap|destroy) (?:him|her)\b/i, '$1 it').replace(/\b(?:his|her) owner's\b/gi, "its owner's"); // Bob: "return him to his owner's hand"
  s = s.replace(/^(?:he|she) (?=gets|gains|has|can't|connives|fights|explores|becomes|loses|attacks|blocks|isn't)/i, 'it ');
  // Brass's Bounty: "For each land you control, create a Treasure token." → "create a Treasure token for each land you control"
  s = s.replace(/^for each ([^,]+), create (a|an|one|two|three) (.+? tokens?(?: with [a-z ,]+)?)$/i, 'create $2 $3 for each $1');
  // voting results: "For each evidence vote, investigate.", "… for each feather vote and draw a card for each quill vote",
  // "create a number of Treasure tokens equal to twice the number of profit votes", "draw cards equal to the number of truth votes"
  if (env.votes && env.votes.kind === 'words' && /\bvotes?\b/i.test(s) && !/gets more votes|each player (?:secretly )?votes for|^reveal cards from the top of your library until you reveal a creature card for each/i.test(s)) {
    const cnt = (w) => env.votes.tally.get(w.trim().toLowerCase()) || 0;
    let vm = s.match(/^(.*?)\ba number of (.+?) equal to (twice )?the number of ([\w' ]+?) votes(.*)$/i);
    if (vm) {
      const k = cnt(vm[4]) * (vm[3] ? 2 : 1);
      if (!k) return;
      return runSentence(`${vm[1]}${k} ${vm[2]}${vm[5]}`.replace(/\s+/g, ' '), env);
    }
    vm = s.match(/^(.*?)\bcards equal to the number of ([\w' ]+?) votes(.*)$/i);
    if (vm) {
      const k = cnt(vm[2]);
      if (!k) return;
      return runSentence(`${vm[1]}${k} cards${vm[3]}`, env);
    }
    vm = s.match(/^for each ([\w' ]+?) vote, (.+)$/i);
    if (vm && env.votes.options.includes(vm[1].toLowerCase()) && !/\bthe voter\b/i.test(vm[2])) {
      for (let i = 0; i < cnt(vm[1]); i++) await runSentence(vm[2], env);
      return;
    }
    if (/ for each [\w' ]+? vote\b/i.test(s)) {
      const parts = s.split(/(?<=for each [\w' ]+? vote) and (?:then )?/i);
      const subj = (parts[0].match(/^(each opponent|each player|target opponent|you) /i) || [])[1];
      for (let part of parts) {
        const pm = part.match(/^(.*?) for each ([\w' ]+?) vote(.*)$/i);
        if (!pm) {
          await runSentence(part, env);
          continue;
        }
        let body = (pm[1] + pm[3]).trim();
        if (subj && !new RegExp('^(?:' + subj + '|each|you|target|put|create|draw|return|search|exile|investigate|mill|scry|gain)\\b', 'i').test(body)) body = `${subj} ${body}`;
        for (let i = 0; i < cnt(pm[2]); i++) await runSentence(body, env);
        const dm = body.match(/^draw (a|one|two|\w+) cards?$/i);
        if (dm) env.voteDrawn = (env.voteDrawn || 0) + n(dm[1]) * cnt(pm[2]);
      }
      return;
    }
  }
  // "gets +1/+0 until end of turn for each artifact defending player controls" → "gets +1/+0 for each … until end of turn"
  s = s.replace(/^(.+? gets? [+-][\dx]+\/[+-][\dx]+) (until end of turn) (for each .+)$/i, '$1 $3 $2');
  // X that depends on something done earlier in this same effect (Spellbound Dragon: "where X is the discarded card's mana value")
  {
    const dm = s.match(/, where X is (?:the discarded card's|that card's|the total) mana value(?: of the discarded cards| of those cards)?$/i);
    if (dm && env.discarded && env.discarded.length) env.x = env.discarded.reduce((a, i) => a + ((DB[card(i).def] || {}).cmc || 0), 0);
    // Cait Sith: "…, where X is that card's mana value" — the card just exiled / revealed
    else if (dm && /that card's/i.test(dm[0]) && env.it && env.it.iid && card(env.it.iid)) env.x = (DB[card(env.it.iid).def] || {}).cmc || 0;
  }
  // X was worked out up front: "create X tokens, where X is …"
  if (/^(?!where)/i.test(s) && /, where X is [^.]+$/i.test(s) && env.x !== undefined) s = s.replace(/, where X is [^.]+$/i, '');
  // "When you do, X" (reflexive trigger) works like "If you do, X"
  if (/^when you do, /i.test(s) && env.prevSent !== undefined && !/\bmay\b|\bunless\b/i.test(env.prevSent)) s = s.replace(/^when you do, /i, '');
  else s = s.replace(/^when you do, /i, 'If you do, ');
  // "Until the end of your next turn, you may play that card" → "you may play that card until the end of your next turn"
  let um0 = s.match(/^(until (?:the end of your next turn|end of turn|your next end step)), (.+)$/i);
  if (um0 && /\b(?:may play|may cast)\b/i.test(um0[2])) s = `${um0[2]} ${um0[1].toLowerCase()}`;
  // "For each opponent, …" in a two-player game is just "the opponent"
  if (/^for each opponent, /i.test(s)) s = s.replace(/^for each opponent, /i, '').replace(/that player controls/gi, 'an opponent controls').replace(/that player/gi, 'target opponent');
  // pure rules reminders that need no action
  if (/^(?:activate (?:this ability )?only (?:as a sorcery|once each turn|during your turn|any time you could cast a sorcery)|choose new targets for the cop(?:y|ies)|(?:it|they) can't be regenerated|you can cast only one more spell this turn|if you search your library this way, shuffle|this ability triggers only once each turn|do this only once each turn|put them back in any order|each mode must target a different player|you may choose the same mode more than once|if that spell is countered this way, exile it instead of putting it into its owner's graveyard|those votes are revealed|it's still a land|exile ~ with \w+ time counters on it|if the copy is a permanent spell, it gains haste|the flashback cost is equal to its mana cost)$/i.test(s)) return;
  if (!s) return;
  {
    const aw = s.match(/^([A-Z][A-Za-z' ]{2,30}?) — (.+)$/);
    if (aw && !/^(?:choose|•)/i.test(aw[1]) && handled(aw[2].toLowerCase().replace(/ instead if .*$/, ''))) s = aw[2];
  }
  const low = s.toLowerCase();
  // conditions
  let m = low.match(/^if (.+?), (.+)$/);
  const condHandled = m && H.some((h) => !h.never && h.re.test(low) && /^\^(?:\(\?:)?if /.test(h.re.source));
  if (m && !/^if you do(?:n't)?,|^if (?:they|that player|the player) (?:do|does|don't|doesn't),/.test(low) && !condHandled) {
    const instead = /instead$/.test(m[2]);
    const c = evalCond(m[1], env);
    if (c === null) {
      env.unknown.push(sentence);
      return;
    }
    env.lastCond = !!c;
    if (!c) {
      env.condFalse = true;
      env.skipDependent = true; // "Then if …, reveal … a creature card. Put that card onto the battlefield…" — the follow-up goes too
      return;
    }
    return runSentence(s.slice(s.indexOf(',', m[1].length + 2) + 1).replace(/ instead$/i, '').trim(), env) || (instead ? undefined : undefined);
  }
  // "Draw a card if it was attacking." — a trailing condition the engine can check
  if ((m = low.match(/^(.+?) if (.+)$/)) && !/^(?:counter|destroy|exile|return|you may)\b/.test(low)) {
    let c = null;
    try {
      c = evalCond(m[2], env);
    } catch (e) {
      c = null;
    }
    if (c !== null && handled(m[1])) {
      env.lastCond = !!c;
      if (!c) return;
      return runSentence(s.slice(0, m[1].length), env);
    }
  }
  if ((m = low.match(/^if you do, (.+)$/))) {
    // after a "you may …" (or a cost that can fail) only if it was done; after a plain action ("Return him to his owner's hand. If you do, …") it was
    if (env.lastMay === false || (env.lastMay === undefined && /\byou may\b/i.test(env.text || ''))) return;
    return runSentence(s.slice(s.toLowerCase().indexOf('if you do,') + 10).trim(), env);
  }
  if ((m = low.match(/^if you don't, (.+)$/))) {
    if (env.lastMay) return;
    return runSentence(s.slice(s.indexOf(',') + 1).trim(), env);
  }
  if ((m = low.match(/^if (?:they|that player|the player) (do|does|don't|doesn't), (.+)$/))) {
    if (/n't/.test(m[1]) ? env.lastMay : !env.lastMay) return;
    return runSentence(s.slice(s.indexOf(',') + 1).trim(), env);
  }
  if ((m = low.match(/^(?:otherwise|if not), (.+)$/))) {
    if (env.lastCond) return;
    return runSentence(s.slice(s.indexOf(',') + 1).trim(), env);
  }
  if ((m = low.match(/^you may (.+)$/)) && !/^you may (?:cast|play) (?:it|that card|those cards|them|the exiled card|spells from among|(?:the )?cards exiled (?:this way|with)|an additional land|up to (?:one|two|three) additional lands?|two additional lands)/.test(low) && !H.some((h) => h.multi && /^\^you may /.test(h.re.source) && h.re.test(low))) {
    // "…Do this only once each turn." (Spider-Verse): after the first time, it's not offered again this turn
    if (env.src && /do this only once each turn/i.test(env.text || '') && card(env.src.iid) && card(env.src.iid).onceTurn === G.s.turn) {
      env.lastMay = false;
      return;
    }
    const yes = await mayAsk(env, s.slice(8));
    if (!yes) return;
    return runSentence(s.slice(8), env);
  }
  // Hideaway: "You may play the exiled card without paying its mana cost if …" — the card this permanent hid away
  {
    const hm = low.match(/^(?:if there are cards exiled with (?:it|~), )?(?:you may )?(play|cast) (?:the exiled card|one of them|k of them|it) without paying (?:its|their) mana cost(?: if (.+))?$/);
    const hidden = hm && env.src ? Object.values(G.s.cards).filter((x) => x.zone === 'exile' && x.hiddenBy === env.src.iid) : [];
    if (hm && hidden.length) return hideawayPlay(env, hidden, hm[1] === 'play', hm[2]);
    if (hm && /the exiled card/.test(low) && env.src && /\bHideaway\b/i.test(oracle(env.src))) return env.did.push('has no card hidden away');
  }
  if (!/ as an adventure /.test(low) && (m = low.match(/^(?:you may )?(?:cast|play) (it|that card|the exiled card|those cards|them|a spell from among them|that spell)(?: this turn| until end of turn| until the end of your next turn)?(?: without paying its mana cost)?/))) {
    const free = /without paying/.test(low);
    // Breaching Dragonstorm: "…without paying its mana cost if that spell's mana value is 8 or less"
    const capm = low.match(/if (?:that spell's|its) mana value is (\d+) or less/);
    const targets = /^(?:you may )?cast (?:it|that card)\b/.test(low) && env.it && env.it.iid ? [env.it.iid] : env.them_ && env.them_.length ? env.them_ : env.it && env.it.iid ? [env.it.iid] : [];
    env.lastMay = false;
    for (const iid of targets) {
      const c = card(iid);
      if (!c || (c.zone !== 'exile' && c.zone !== 'library' && c.zone !== 'graveyard' && c.zone !== 'hand')) continue;
      // lands can be played ("you may play those cards") but never cast
      if (isLand(c) && (free || !/\bplay\b/.test(low))) continue;
      if (capm && (DB[c.def].cmc || 0) > +capm[1]) continue;
      if (free && env.castFree) {
        const yes = /^you may/.test(low) ? await env.choosers[env.me].confirm(cardName(c), `Cast ${cardName(c)} without paying its mana cost?`, env) : true;
        env.lastMay = !!yes;
        if (yes) {
          await env.castFree(env.me, iid);
          env.did.push(`casts ${nameTag(c)} for free`);
        }
      } else {
        // Superior Foes of Spider-Man: "…until you exile another card with this creature" — the newest card replaces the last
        const untilNext = /until you exile another card with (?:this creature|~)(?![a-z])/.test(env.text || low) && env.src;
        if (untilNext) for (const x of Object.values(G.s.cards)) if (x.exiledWithSrc === env.src.iid && x.iid !== c.iid) { x.mayPlay = null; delete x.exiledWithSrc; }
        if (untilNext) c.exiledWithSrc = env.src.iid;
        Object.assign(c, {
          mayPlay: env.me,
          mayPlayUntil: /for as long as (?:it|they|that card|those cards) remains? exiled|for as long as you control (?:this creature|this permanent|~|it)(?![a-z])|until you exile another card with/.test(env.text || low) ? FOREVER : /next turn/.test(low) ? nextTurnNumber(env.me) : G.s.turn,
          ...(/for as long as you control (?:this creature|this permanent|~)(?![a-z])/.test(env.text || low) && env.src ? { playWhileCtl: env.src.iid } : {}),
          anyColorMana: anyManaText(env.text || low),
          castOnly: /^(?:you may )?cast\b/.test(low),
        });
        env.did.push(`may play ${nameTag(c)}`);
      }
      if (/^(?:you may )?cast (?:it|that card)/.test(low)) break;
    }
    return;
  }
  // "Draw a card, then discard a card." / "Scry 1, then draw a card."
  const parts = s.split(/,? then (?=[a-z])/i);
  if (parts.length > 1 && !/^search/i.test(s) && !/faces a villainous choice/i.test(s) && !/\bemblem with ["']/i.test(s) && !BLINK_RE.test(s.toLowerCase()) && !H.some((h) => h.first && !h.never && h.re.test(s.toLowerCase()) && /then/.test(h.re.source))) {
    for (const p of parts) await runSentence(p, env);
    return;
  }
  // "Each player loses 2 life unless they discard a card": each player may pay to avoid it
  const um = s.match(/^(.+?) unless (?:they|he or she|that player|its controller|you) (.+)$/i);
  if (um && SUBJECT.test(um[1]) && !/^counter /i.test(um[1])) {
    await unlessEach(um[1], um[2], env);
    return;
  }
  // "Discard a card and sacrifice a creature": two actions joined by "and"
  if (!coveredByOne(low)) {
    const am = s.match(/^(.+?),? and (sacrifice|discard|draw|mill|scry|surveil|create|exile|destroy|return|put|tap|untap|shuffle|you gain|you lose|lose \d+ life|gain \d+ life|investigate|proliferate|you get|copy it|it can't|~ can't|it gains|~ gains|it gets|~ gets|it deals|~ deals|it becomes|~ becomes)\b(.*)$/i);
    if (am && handled(am[1].toLowerCase()) && handled((am[2] + am[3]).toLowerCase())) {
      await runSentence(am[1], env);
      await runSentence(am[2] + am[3], env);
      return;
    }
  }
  env.sentence = low;
  let matched = false;
  for (const h of H) {
    if (h.never) continue;
    const mm = low.match(h.re);
    if (!mm) continue;
    if (h.skipIf && h.skipIf.test(low)) continue;
    const before = env.did.length;
    // a handler can pass (return 'pass') to let the next one that matches take the sentence
    if ((await h.run(mm, env, s)) === 'pass') continue;
    matched = true;
    if (h.consumesRest) return 'rest';
    void before;
    break;
  }
  if (!matched && !(await playerSubject(s, env))) env.unknown.push(sentence);
}

// Does one handler read (almost) the whole sentence?
function coveredByOne(low) {
  for (const h of H) {
    if (h.never) continue;
    const mm = low.match(h.re);
    if (mm && mm.index === 0 && mm[0].length >= low.length - 2 && !(h.skipIf && h.skipIf.test(low))) return true;
  }
  return false;
}
function handled(low) {
  low = low.trim().replace(/\.$/, '');
  return H.some((h) => !h.never && h.re.test(low) && !(h.skipIf && h.skipIf.test(low))) || SUBJECT.test(low);
}
async function unlessEach(clause, cost, env) {
  const sm = clause.match(SUBJECT);
  const subj = sm[1].toLowerCase();
  const pids = /^target (player|opponent)$/.test(subj) ? await playerTarget(env, subj) : playersOf(env, subj);
  const { payOtherCost } = await import('./cast.js');
  const { aiPay } = await import('./ai.js');
  const costText = cost.replace(/\btheir\b/g, 'your').replace(/\.$/, '');
  for (const pid of pids || []) {
    const ch = env.choosers[pid];
    let paid = false;
    const lifeHit = (clause.match(/loses? (\d+) life/) || [])[1];
    const want = isAI(pid)
      ? (lifeHit ? +lifeHit >= 3 || G.s.players[pid].life <= 12 : true)
      : await ch.confirm(cardName(env.src), `${clause.replace(/^each (?:player|opponent)/i, 'You')} unless you ${costText}. Pay "${costText}"?`, {});
    if (want) {
      try {
        paid = await payOtherCost(pid, costText, env.src, { choosers: env.choosers, pay: async (p2, c2, l2, o2) => (isAI(p2) ? aiPay(p2, c2, l2, o2) : null) });
      } catch (e) {
        if (!(e instanceof Cancelled)) throw e;
        paid = false;
      }
    }
    if (paid) {
      env.did.push(`${who(pid)} ${isAI(pid) ? 'pays' : 'pay'} (${costText})`);
      continue;
    }
    const rest = clause.slice(sm[1].length).trim();
    const sub = Object.assign(Object.create(null), env, { me: pid, it: { player: pid }, did: env.did, unknown: env.unknown });
    await playerSubject(`that player ${rest}`, sub);
  }
}

// "Its controller creates a 3/3 Beast", "Each opponent sacrifices a creature", "Target player mills
// three cards": run the action as that player, reading "their" as "your".
const SUBJECT = /^(each player|each opponent|each of your opponents|your opponents|target opponent|target player|that player|its controller|its owner|their controller|that creature's controller|that permanent's controller|that spell's controller|defending player|the defending player|an opponent|you)\s+(.+)$/i;
function deconjugate(v) {
  v = v.toLowerCase();
  const irregular = { has: 'have', does: 'do', is: 'be', may: 'may' };
  if (irregular[v]) return irregular[v];
  if (/(ss|sh|ch|x|z)es$/.test(v)) return v.slice(0, -2);
  if (/[^aeiou]ies$/.test(v)) return v.slice(0, -3) + 'y';
  if (/s$/.test(v) && !/ss$/.test(v)) return v.slice(0, -1);
  return null;
}
async function playerSubject(s, env) {
  const m = s.match(SUBJECT);
  if (!m) return false;
  const subj = m[1].toLowerCase();
  const vm = m[2].match(/^(\w+)\b(.*)$/);
  if (!vm) return false;
  let text;
  if (subj === 'you') text = m[2];
  else {
    const base = deconjugate(vm[1]);
    if (!base || base === 'be' || base === 'have') return false;
    text = (base === 'may' ? 'you may' : base) + vm[2];
  }
  text = text.replace(/\btheir\b/gi, 'your').replace(/\bthey\b/gi, 'you').replace(/\bthemselves\b/gi, 'yourself').replace(/\bhis or her\b/gi, 'your');
  const okText = (t) => /^you may /.test(t) || H.some((h) => !h.never && h.re.test(t) && !(h.skipIf && h.skipIf.test(t)));
  // handlers are written either for "you lose 2 life" or for the bare "draw a card"
  const withYou = /^you /i.test(text) ? text : 'you ' + text;
  if (okText(withYou.toLowerCase()) && withYou.toLowerCase() !== s.toLowerCase()) text = withYou;
  const low = text.toLowerCase();
  if (low === s.toLowerCase()) return false;
  if (!okText(low)) return false;
  const good = /^you (?:draw|gain \d+ life|gain life|create|untap|scry|return|search)/i.test(withYou) && !/\bloses?\b|\bdiscards?\b|\bsacrifices?\b/i.test(withYou);
  const pids = /^target (player|opponent)$/.test(subj) ? await playerTarget(env, subj, !good) : playersOf(env, subj);
  if (!pids || !pids.length) return false;
  for (const pid of pids) {
    const sub = Object.assign(Object.create(null), env, { me: pid, did: env.did, unknown: env.unknown });
    const before = env.unknown.length;
    await runSentence(text, sub);
    if (env.unknown.length > before) return true; // the inner sentence was recorded as unknown already
    if (sub.it) env.it = sub.it;
    env.lastMay = sub.lastMay;
  }
  return true;
}

/**
 * Resolve an effect text.
 * ctx: { me, x, choosers: {p, ai}, forced, thatPlayer, stackTarget, kicked, castFrom, modes, castFree, … }
 * chooser API: target, pickCards, scry, choose, chooseModes, confirm, payUnless
 * Returns a list of short descriptions of what happened (env.unknown lists sentences left to the player).
 */
export async function resolveEffects(text, src, ctx) {
  if (!text || !src) return [];
  const env = {
    ...ctx, src, did: [], unknown: [], it: ctx.it || null, them_: ctx.them_ || null,
    x: ctx.x || 0, fullText: prep(text, src),
  };
  env.text = env.fullText.toLowerCase();
  // X defined in the text ("where X is the number of …")
  const xm = env.text.match(/where x is (half |twice )?(?:the number of |your |the total number of |the greatest )?([^.]+?)(?:, rounded (up|down))?(?:\.|$)/);
  // Shark Typhoon: "where X is that spell's mana value"
  if (xm && /^that spell's mana value$/.test(xm[2].trim()) && ctx.it && card(ctx.it.iid)) {
    // on the stack, X counts: Blaze with X=4 has mana value 5
    const sp = card(ctx.it.iid);
    const f = DB[sp.def].faces[sp.castFace || 0] || DB[sp.def].faces[0];
    const xs = ((f.manaCost || DB[sp.def].manaCost || '').match(/\{X\}/g) || []).length;
    env.x = (DB[sp.def].faces.length > 1 && f.manaCost ? manaValueOf(f.manaCost) : DB[sp.def].cmc || 0) + xs * (sp.xPaid || 0);
  }
  else if (xm) {
    env.xWhere = xm;
    whereX(env);
  }
  const prevActor = G.curActor;
  G.curActor = env.me;
  try {
    await runText(env.fullText, env);
  } finally {
    G.curActor = prevActor;
  }
  if (env.condFalse && !env.did.length && !env.unknown.length) env.did.skipped = true;
  stateBased();
  if (ctx.unknownOut) ctx.unknownOut.push(...env.unknown);
  if (G.unknownSink && env.unknown.length) G.unknownSink.push(...env.unknown);
  if (env.unknown.length && env.did.length) env.did.push(`<i>by hand: ${esc(env.unknown.join(' ').slice(0, 140))}</i>`);
  ctx.lastEnv = env;
  return env.did;
}

// "where X is …": worked out when the effect starts and again before each sentence that uses X
// (Savanti Romero puts a counter on itself first, then draws X)
function whereX(env) {
  const xm = env.xWhere;
  if (!xm) return;
  const ph = xm[2].trim();
  const me = env.me;
  const ts = (G.s.ts || {})[me] || {};
  const src = env.src && card(env.src.iid) && card(env.src.iid).zone === env.src.zone ? card(env.src.iid) : env.src;
  let v = null;
  // Elenda's Hierophant: "where X is its power" as it died (last known information)
  if (/^(?:its|~'s) power$/.test(ph)) v = env.event && env.event.type === 'dies' && env.event.iid === (env.src || {}).iid && env.event.power !== undefined ? env.event.power : src ? lkiPT(src).p : 0;
  else if (/^(?:its|~'s) toughness$/.test(ph)) v = env.event && env.event.type === 'dies' && env.event.iid === (env.src || {}).iid && env.event.toughness !== undefined ? env.event.toughness : src ? toughness(src) : 0;
  else if (/^(?:the )?amount of life you(?:'ve)? gained this turn$/.test(ph)) v = ts.lifeGained || 0;
  else if (/^speed$/.test(ph)) v = G.s.players[me].speed || 0;
  else if (/^(?:the number of )?times (?:~|he|she|it|this spell) was kicked$/.test(ph)) v = typeof env.kicked === 'number' ? env.kicked : env.kicked ? 1 : 0;
  else if (/^counters on (?:~|it|this [a-z]+)$/.test(ph)) v = Object.values((src && src.counters) || {}).reduce((a, k) => a + (k > 0 ? k : 0), 0);
  else if (/^permanents you(?:'ve| have) sacrificed this turn$/.test(ph)) v = ts.sacrificed || 0;
  else v = countPhrase(me, ph, helpers, env.src && env.src.iid);
  if (v !== null) env.x = xm[1] === 'half ' ? (xm[3] === 'up' ? Math.ceil(v / 2) : Math.floor(v / 2)) : xm[1] === 'twice ' ? v * 2 : v;
}

function kwCostText(c, name) {
  const k = kwCost(c, name);
  return k ? k.mana : null;
}

function pumpEOT(c, pump) {
  c.eot = { p: (c.eot ? c.eot.p : 0) + pump.p, t: (c.eot ? c.eot.t : 0) + pump.t };
  if (pump.grants && pump.grants.length) c.eotGrants = [...(c.eotGrants || []), ...pump.grants.map((g) => g.toLowerCase())];
}
export { pumpEOT };

async function fetchLands(t, me, choose, src, did, env) {
  const lib = zoneOf(me, 'library');
  const basic = /basic/.test(t);
  const types = (t.match(/search your library for [^.]*?card/) || [''])[0].match(/forest|island|swamp|mountain|plains/g) || [];
  const m = t.match(/up to (\w+) (?:basic )?land cards?|up to (\w+) basic|up to (\w+) cards?|up to (\w+) (?:forest|island|swamp|mountain|plains)(?:,? (?:and\/)?or (?:forest|island|swamp|mountain|plains))* cards?/);
  const count = m ? n(m[1] || m[2] || m[3] || m[4], env && env.x) : /two basic land|two land/.test(t) ? 2 : 1;
  const cands = lib.map(card).filter((c) => {
    if (!isLand(c)) return false;
    if (basic && !/Basic/.test(DB[c.def].typeLine)) return false;
    if (types.length && !types.some((ty) => new RegExp(ty, 'i').test(DB[c.def].typeLine))) return false;
    return true;
  });
  if (!cands.length) {
    shuffle(me);
    did.push('finds no land');
    return;
  }
  const share = /that share a land type/.test(t) && count > 1;
  const BASICS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  const ltypes = (c) => BASICS.filter((b) => new RegExp('\\b' + b + '\\b').test(DB[c.def].typeLine || ''));
  const sharesType = (ids) => {
    if (ids.length < 2) return true;
    const common = ltypes(card(ids[0])).filter((y) => ids.every((i) => ltypes(card(i)).includes(y)));
    return common.length > 0;
  };
  let picks = await choose.pickCards({
    prompt: `Search your library for ${count > 1 ? 'up to ' + count : 'a'} ${basic ? 'basic ' : ''}${types.length ? types.join(' or ') : 'land'} card${count > 1 ? 's' : ''}${share ? ' that share a land type' : ''}`,
    cards: cands.map((c) => c.iid), min: 0, max: Math.min(count, cands.length), purpose: 'land', src,
    // Myriad Landscape: pick both at once; the choice has to share a land type
    ...(share ? { validate: (ids) => (sharesType(ids) ? '' : 'These must share a land type (for example two Forests).') } : {}),
    aiScore: (c) => (isAI(me) ? aiHelpers.landScore(c) + (share ? cands.filter((x) => ltypes(x).some((y) => ltypes(c).includes(y))).length / 10 : 0) : 0),
  });
  if (share && picks.length > 1 && !sharesType(picks)) {
    // the AI's pick (or an old dialog) didn't share a type: keep the first and the ones that match it
    const ty = ltypes(card(picks[0]));
    const rest = cands.filter((c) => c.iid !== picks[0] && ltypes(c).some((y) => ty.includes(y))).map((c) => c.iid);
    picks = [picks[0], ...rest.slice(0, count - 1)];
  }
  const onlyOneToField = /the other into your hand|put one onto the battlefield/.test(t);
  const toField = /onto the battlefield/.test(t);
  const toTop = /on top of your library|top of your library/.test(t) && !toField;
  const tapped = /battlefield tapped/.test(t);
  let fieldPicks = picks;
  if (toField && onlyOneToField && picks.length > 1 && picks.every((i) => card(i).def === card(picks[0]).def)) fieldPicks = [picks[0]]; // two Forests: nothing to choose
  else if (toField && onlyOneToField && picks.length > 1) {
    fieldPicks = await choose.pickCards({
      prompt: 'Choose the land to put onto the battlefield (the other goes to your hand)',
      cards: picks, min: 1, max: 1, purpose: 'land-field', src, aiScore: (c) => (isAI(me) ? aiHelpers.landScore(c) : 0),
    });
  } else if (!toField) fieldPicks = [];
  shuffle(me);
  for (const iid of picks) {
    if (fieldPicks.includes(iid)) toBattlefield(iid, me, { tapped });
    else if (toTop) move(iid, 'library');
    else move(iid, 'hand');
  }
  if (env) env.it = picks[0] ? { iid: picks[0] } : null;
  if (env) env.them_ = picks.slice();
  if (picks.length) did.push(`searches for ${picks.map((i) => nameTag(card(i))).join(' and ')}`);
}

// AI land-choice helpers (filled in by ai.js so the AI can pick the colors it needs)
export const aiHelpers = { landScore: () => 0 };

async function tutor(t, me, choose, src, did, env) {
  const m = t.match(/search your library (?:and graveyard )?for (?:a|an|up to (\w+)|two|three) ([^.,]*?)cards?(?: with ([^,.]+))?/);
  const count = m && m[1] ? n(m[1]) : /for two /.test(t) ? 2 : /for three /.test(t) ? 3 : 1;
  const phrase = m ? (m[2] + ' ' + (m[3] || '')).trim() : '';
  const lib = [...zoneOf(me, 'library'), ...(/and graveyard/.test(t) ? zoneOf(me, 'graveyard') : [])].map(card).filter((c) => {
    if (/creature/.test(phrase) && !/Creature/.test(DB[c.def].typeLine)) return false;
    if (/artifact/.test(phrase) && !/Artifact/.test(DB[c.def].typeLine)) return false;
    if (/enchantment/.test(phrase) && !/Enchantment/.test(DB[c.def].typeLine)) return false;
    if (/instant or sorcery|instant and\/or sorcery/.test(phrase) && !/Instant|Sorcery/.test(DB[c.def].typeLine)) return false;
    if (/^instant\b/.test(phrase) && !/Instant/.test(DB[c.def].typeLine)) return false;
    if (/^sorcery\b/.test(phrase) && !/Sorcery/.test(DB[c.def].typeLine)) return false;
    if (/legendary/.test(phrase) && !/Legendary/.test(DB[c.def].typeLine)) return false;
    if (/planeswalker/.test(phrase) && !/Planeswalker/.test(DB[c.def].typeLine)) return false;
    if (/equipment/.test(phrase) && !/Equipment/.test(DB[c.def].typeLine)) return false;
    if (/aura/.test(phrase) && !/Aura/.test(DB[c.def].typeLine)) return false;
    const mv = phrase.match(/mana value (\d+|x) or less/);
    if (mv && DB[c.def].cmc > (mv[1] === 'x' ? (env && env.x) || 0 : +mv[1])) return false;
    const mvEq = phrase.match(/mana value (?:equal to|of) (\d+|x)\b/);
    if (mvEq && DB[c.def].cmc !== (mvEq[1] === 'x' ? (env && env.x) || 0 : +mvEq[1])) return false;
    const mcost = phrase.match(/mana cost ((?:\{[^}]+\})(?: or \{[^}]+\})*)/);
    if (mcost && !mcost[1].split(' or ').includes(DB[c.def].manaCost || '{0}')) return false;
    const named = phrase.match(/named ([^,.]+)/);
    if (named && DB[c.def].name.toLowerCase() !== named[1].trim()) return false;
    return true;
  });
  const picks = await choose.pickCards({
    prompt: `Search your library for ${count > 1 ? count : 'a'} ${phrase ? phrase.trim() : ''} card${count > 1 ? 's' : ''}`, cards: lib.map((c) => c.iid),
    min: 0, max: count, purpose: 'tutor', src, aiScore: (c) => (isLand(c) ? -5 : DB[c.def].cmc),
  });
  const dest = /onto the battlefield/.test(t) ? 'battlefield' : /on top of your library|on top\b/.test(t) ? 'top' : /into your graveyard/.test(t) ? 'graveyard' : 'hand';
  shuffle(me);
  for (const iid of picks) {
    if (dest === 'battlefield') toBattlefield(iid, me, { tapped: /battlefield tapped/.test(t) });
    else if (dest === 'top') move(iid, 'library');
    else if (dest === 'graveyard') move(iid, 'graveyard');
    else move(iid, 'hand');
    did.push(me === 'p' || dest !== 'hand' ? `tutors ${nameTag(card(iid))}` : 'tutors a card');
  }
  if (env) env.it = picks[0] ? { iid: picks[0] } : null;
}

// ------------------------------------------------------------ auras & equipment
// A copy of an Aura that enters without being cast (token copies, clones of Auras, copies of an Aura spell):
// its controller picks something it can enchant (not targeted, so hexproof and ward don't matter)
export async function attachLooseAuras(ids, pid, choosers) {
  const out = [];
  for (const i of ids || []) {
    const a = card(i);
    if (!a || a.zone !== 'battlefield' || a.attachedTo || !hasSubtype(a, 'Aura') || a.enchantedPlayer) continue;
    const r = await attachAura(a, pid, choosers[pid], { noTarget: true });
    out.push(...r.map((x) => `${nameTag(a)} ${x}`));
  }
  return out;
}
export async function attachAura(aura, me, choose, opts = {}) {
  const o = oracle(aura);
  const em = o.match(/^Enchant ([^\n]+)/m);
  if (!em && !opts.bestow) return [];
  const what = opts.bestow ? 'creature' : em[1].toLowerCase();
  const isPlayerAura = /^(?:player|opponent)$/.test(what);
  if (isPlayerAura) return [];
  // Animate Dead, Necromancy, Dance of the Dead: "Enchant creature card in a graveyard" — return it and attach
  if (/^creature card in a graveyard$/.test(what)) {
    const gy = seats().flatMap((k) => cardsIn(k, 'graveyard')).filter((c) => /Creature/.test(DB[c.def].faces[0].typeLine || ''));
    if (!gy.length) return [];
    const [p] = await choose.pickCards({ prompt: `Choose a creature card in a graveyard for ${cardName(aura)}`, cards: gy.map((c) => c.iid), min: 1, max: 1, forced: true, purpose: 'reanimate', src: aura, aiScore: (c) => cardValue(c) });
    if (!p || !card(p)) return [];
    toBattlefield(p, me);
    const t = card(p);
    if (!t || t.zone !== 'battlefield') return [];
    attachTo(aura, t);
    aura.reanimated = t.iid;
    return [`returns ${nameTag(t)} to the battlefield and enchants it`];
  }
  const buff = o.match(/Enchanted creature gets ([+-]\d+)\/([+-]\d+)/i);
  const lock = /Enchanted creature can't attack|Enchanted creature can't block|Enchanted creature doesn't untap|enchanted creature's activated abilities can't/i.test(o);
  const cands = seats().flatMap((k) => cardsIn(k, 'battlefield')).filter(
    (c) => (opts.noTarget ? c.iid !== aura.iid : canTarget(c, me, aura)) && matchesFilter(c, what.replace(/ you control$/, '')) && (!/you control/.test(what) || c.controller === me) && (!/an opponent controls|you don't control/.test(what) || c.controller !== me)
  );
  const pick = await choose.target({
    prompt: `Choose ${/^creature/.test(what) ? 'a creature' : 'a ' + what} to enchant with ${cardName(aura)}`, candidates: cands.map((c) => c.iid),
    harm: lock || (buff && +buff[1] < 0) || /control/.test(o.match(/You control enchanted/i) ? 'control' : ''), src: aura, optional: !cands.length,
  });
  if (!pick || !pick.iid) return [];
  const t = card(pick.iid);
  if (!opts.noTarget && t.controller !== me && !(await payWard(me, t, choose, aura))) return [`is countered by ${nameTag(t)}'s ward`];
  attachTo(aura, t);
  if (/^You control enchanted (?:creature|permanent|land|artifact)/m.test(o)) move(t.iid, 'battlefield', { controller: aura.controller });
  return [`enchants ${whose(t)} ${nameTag(t)}`];
}

// What an Aura / Equipment line gives: keywords ("has flying, haste, and …"), base P/T, quoted abilities.
const GRANTABLE = /^(?:flying|trample|haste|vigilance|reach|lifelink|deathtouch|menace|first strike|double strike|defender|hexproof|shroud|indestructible|infect|wither|prowess|intimidate|fear|shadow|horsemanship|flanking|banding|exalted|undying|persist|islandwalk|swampwalk|forestwalk|mountainwalk|plainswalk|protection from [a-z ]+|ward \{\d+\}|ward—.+|toxic \d+|annihilator \d+|bushido \d+|rampage \d+|afflict \d+|skulk|changeling|devoid|absorb \d+)$/;
export function auraGrants(o) {
  const out = { kws: [], base: null, texts: [], conds: [] };
  for (const raw of String(o || '').split('\n')) {
    const cm = raw.trim().replace(/\([^)]*\)/g, '').match(/^As long as enchanted creature is (white|blue|black|red|green|an? ([A-Z]\w+)), it (.+)$/i);
    if (cm) {
      const rest = cm[3].replace(/"[^"]*"/g, '¤');
      const pt = rest.match(/gets ([+-]\d+)\/([+-]\d+)/);
      const kws = [];
      for (let part of rest.split(/\b(?:has|gains?)\b/i).slice(1)) {
        part = part.split(/,? and (?:is|can't|attacks|loses|gets)\b|\.|¤/i)[0];
        for (const k of kwList(part.toLowerCase().trim())) if (GRANTABLE.test(k)) kws.push(k);
      }
      out.conds.push({ ...(cm[2] ? { sub: cm[2] } : { color: cm[1].toLowerCase() }), p: pt ? +pt[1] : 0, t: pt ? +pt[2] : 0, kws });
      continue;
    }
    if (!/^(?:Enchanted|Equipped) (?:creature|permanent|planeswalker)\b/i.test(raw.trim())) continue;
    const quotes = [...raw.matchAll(/"([^"]+)"/g)].map((q) => q[1]);
    out.texts.push(...quotes);
    const line = raw.replace(/"[^"]*"/g, '¤').replace(/\([^)]*\)/g, '');
    const bp = line.match(/base power and toughness (\d+)\/(\d+)/i);
    if (bp) out.base = { p: +bp[1], t: +bp[2] };
    const parts = line.split(/\b(?:has|have|gains?)\b/i).slice(1);
    for (let part of parts) {
      part = part.split(/,? and (?:is|are|can't|attacks|loses|gets)\b|, (?:is|can't|attacks)\b|\.|¤|\bas long as\b|\buntil\b/i)[0];
      for (const k of kwList(part.toLowerCase().replace(/^\s+/, '').replace(/,\s*$/, ''))) if (GRANTABLE.test(k)) out.kws.push(k);
    }
  }
  return out;
}

export function attachTo(src, t) {
  if (G.s) G.s.bfv = (G.s.bfv || 0) + 1; // board changed (caches key on this)
  let o = oracle(src).replace(/\b(?:Enchanted|Equipped) creature/g, (x) => x);
  if (src.attachedTo && card(src.attachedTo)) {
    const old = card(src.attachedTo);
    if (old.auraBuffs) delete old.auraBuffs[src.iid];
    if (old.pacifiedBy === src.iid) old.pacifiedBy = null;
    // Grafted Exoskeleton: "Whenever ~ becomes unattached from a permanent, sacrifice that permanent."
    if (old.iid !== t.iid && old.zone === 'battlefield' && /Whenever ~ becomes unattached from a permanent, sacrifice that permanent/i.test(stripName(o, src))) {
      log(src.controller, `${nameTag(src)} becomes unattached: ${nameTag(old)} is sacrificed.`);
      sacrifice(old.iid);
    }
  }
  src.attachedTo = t.iid;
  // bestow creatures: "Nighthowler and enchanted creature each get +X/+X, where X is …"
  {
    const nm = DB[src.def].name.split(' // ')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    o = o.replace(new RegExp(`(^|\\n)(?:${nm}|~|This creature) and enchanted creature each get `, 'g'), '$1Enchanted creature gets ');
  }
  const buff = o.match(/(?:^|\n)(?:Enchanted|Equipped) (?:creature|permanent) gets ([+-]\d+)\/([+-]\d+)/i);
  let fe = o.match(/(?:^|\n)(?:Enchanted|Equipped) creature gets ([+-]\d+)\/([+-]\d+) for each ([^.]+)/i);
  // Tangleweave Armor: "Equipped creature gets +X/+X, where X is the greatest mana value among your commanders."
  const xb = !fe && o.match(/(?:^|\n)(?:Enchanted|Equipped) creature gets \+X\/\+(X|0), where X is (?:the )?([^.]+)/i);
  if (xb) fe = [xb[0], '+1', xb[1] === 'X' ? '+1' : '+0', xb[2]];
  const g = auraGrants(o);
  const kwm = g.kws.length ? [null, g.kws.join(', ')] : null;
  if (buff || fe || kwm || g.base || g.texts.length || g.conds.length) {
    let p = buff ? +buff[1] : 0;
    let tt = buff ? +buff[2] : 0;
    // Eidolon of Countless Battles: "+1/+1 for each creature you control and +1/+1 for each Aura you control"
    let each2 = null;
    if (fe) {
      const two = fe[3].match(/^(.+?) and ([+-]\d+)\/([+-]\d+) for each (.+)$/);
      if (two) {
        fe = [fe[0], fe[1], fe[2], two[1]];
        each2 = { each: two[4], perP: +two[2], perT: +two[3] };
      }
      const k = countPhrase(src.controller, fe[3], helpers, src.iid) || 0;
      p = +fe[1] * k;
      tt = +fe[2] * k;
    }
    t.auraBuffs = t.auraBuffs || {};
    t.auraBuffs[src.iid] = {
      ts: nextStamp(), p, t: tt, grants: g.kws, ...(fe ? { each: fe[3], perP: +fe[1], perT: +fe[2] } : {}), ...(each2 ? { each2 } : {}),
      ...(g.base ? { base: g.base } : {}),
      ...(g.conds.length ? { conds: g.conds } : {}),
      // granted abilities in quotes (Teferi's Talent's "[-12]: …", Rancor-style "Whenever this creature…")
      ...(g.texts.length ? { text: g.texts.map((q) => q.replace(/^\[([+−-]?\d+)\]:/, '$1:')).join('\n') } : {}),
    };
  }
  // (an Aura that only stops untapping — Fall from Favor, Claustrophobia — is checked in the untap step instead)
  if (/Enchanted creature can't attack|Enchanted creature can't block/i.test(o)) t.pacifiedBy = src.iid;
  if (/Enchanted creature has base power and toughness 1\/1|Cursed/i.test(o) && /base power and toughness 1\/1/i.test(o)) t.setPT = { ts: nextStamp(), p: 1, t: 1 };
  // Layered Auras: Frogify / Kenrith's Transformation, Darksteel Mutation, Deep Freeze, Song of the Dryads, Imprisoned in the Moon
  {
    const until = 'aura:' + src.iid;
    t.layerFx = (t.layerFx || []).filter((e) => e.until !== until);
    let mm;
    if ((mm = o.match(/Enchanted creature loses all abilities and is an? (white|blue|black|red|green) ([A-Z][\w-]+) creature with base power and toughness (\d+)\/(\d+)/))) {
      addLayerFx(t, { until, loseAll: true, base: { p: +mm[3], t: +mm[4] }, types: { set: 'Creature', sub: mm[2] }, colors: { set: [COLOR_WORD[mm[1]]] } });
    } else if ((mm = o.match(/Enchanted creature is an? ([A-Z][\w-]+) artifact creature with base power and toughness (\d+)\/(\d+) and has ([a-z ]+?), and it loses all other abilities, card types, and creature types/))) {
      addLayerFx(t, { until, loseAll: true, base: { p: +mm[2], t: +mm[3] }, types: { set: 'Artifact Creature', sub: mm[1] }, grants: [mm[4].trim()] });
    } else if ((mm = o.match(/Enchanted creature has base power and toughness (\d+)\/(\d+), has ([a-z ]+?), loses all other abilities, and is an? (white|blue|black|red|green) ([A-Z][\w-]+) in addition to its other colors and types/))) {
      addLayerFx(t, { until, loseAll: true, base: { p: +mm[1], t: +mm[2] }, grants: [mm[3].trim()], types: { subAdd: mm[5] }, colors: { add: [COLOR_WORD[mm[4]]] } });
    } else if ((mm = o.match(/Enchanted permanent is a colorless ([A-Z][\w-]+) land\./))) {
      addLayerFx(t, { until, types: { set: 'Land', sub: mm[1], dropSuper: false }, colors: { set: [] } });
    } else if (/Enchanted permanent is a colorless land with "\{T\}: Add \{C\}" and loses all other card types and abilities/.test(o)) {
      addLayerFx(t, { until, loseAll: true, types: { set: 'Land', sub: '' }, colors: { set: [] }, mana: ['C'] });
    }
  }
  // Spider-Man No More / Frogify-style: "Enchanted creature is a Citizen with base power and toughness 1/1. It has defender and loses all other abilities."
  {
    const im = o.match(/Enchanted creature is an? ([A-Z][a-z]+) with base power and toughness (\d+)\/(\d+)/);
    if (im) {
      t.setPT = { ts: nextStamp(), p: +im[2], t: +im[3] };
      t.auraType = { src: src.iid, type: im[1] };
    }
    if (/Enchanted creature[^.\n]*\. It has [^.\n]*and loses all other abilities|Enchanted creature loses all (?:other )?abilities/i.test(o)) loseAllAbilities(t, 'aura:' + src.iid);
  }
  queueEvent({ type: 'attached', iid: src.iid, to: t.iid, controller: src.controller });
}

export { makeCard, manaValueOf, payCost, H as HANDLERS, runText, prep };

// What the AI's spell will target, worked out as it's cast so you can see it before you respond.
// Returns [{iid}|{player}]; the same picks are then used when the spell resolves (chooser.plan).
export async function predictTargets(pid, c, face, choosers, x = 0, textOverride = null) {
  let text;
  try {
    text = prep(textOverride != null ? textOverride : spellText({ ...c, face: face || 0 }), c).toLowerCase();
  } catch (e) {
    return [];
  }
  if (!/\btarget\b/.test(text) || /•/.test(text)) return [];
  const env = { me: pid, src: c, choosers, x, forced: true, did: [], stackTarget: null };
  const out = [];
  const PH = /(?:(?:up to (?:one|two|three|four|five|x|\d+)|any number of|one|two|three|four) )?(?:another |other )?target [a-z' ,/-]+?(?=\.|;|, (?:then|and|where|untap|tap|it|that)\b|,? and (?:gains?|gets?|deals?|you|its|draw|put|return|exile|destroy|create|that)\b| gets?\b| gains?\b| deals?\b| to (?:its|their|the)\b| into\b| on (?:top|the bottom)\b| from\b| with (?:power|toughness|mana)?\b| can't\b| attacks\b| loses?\b| becomes?\b| fights?\b| $|$)|any (?:other )?target/g;
  for (const sentence of text.split(/(?<=\.)\s+|\n/)) {
    for (const mm of sentence.matchAll(PH)) {
      const phrase = mm[0].trim();
      const blink = /exile [^.]*,? then return (?:it|that card|them|that permanent) to the battlefield/.test(sentence);
      // judge good/bad from this target's own clause (Blood Artist: "target player loses 1 life and you gain 1 life")
      const clause = sentence.slice(0, mm.index) + sentence.slice(mm.index).split(/ and you | and its controller | and that player |, then /)[0];
      const harm = !blink && (!/(?:gets? \+|gains? (?!control)|untap|\+1\/\+1 counter|return [^.]* to the battlefield|hexproof|indestructible|protection)/.test(clause) || /destroy|exile|damage|sacrifice|loses? \d+ life|-\d/.test(clause));
      // Sign in Blood: "target player draws two cards and loses 2 life" — card draw for yourself, unless the life loss finishes an opponent
      let harm2 = harm;
      // Will of the Temur: "Target player draws cards equal to …" — draw for yourself
      if (/^[•\s]*target player draws? (?!.*\bloses?\b)/i.test(clause)) harm2 = false;
      const dl = clause.match(/^target player draws? (?:a|an|one|two|three|\d+) cards? and loses? (\d+) life/);
      if (dl) harm2 = opponents(pid).some((o) => inGame(o) && G.s.players[o].life <= +dl[1] && !playerHexproof(o, pid, c));
      let picks = [];
      try {
        picks = await pickTargets(env, phrase, { harm: harm2, noWard: true });
      } catch (e) {
        picks = [];
      }
      for (const p of picks) if (!out.some((o) => (o.iid && o.iid === p.iid) || (o.player && o.player === p.player))) out.push(p);
    }
  }
  return out;
}

// How much one mode of a modal spell is worth to `env.me` right now (the AI picks modes with this).
export function modeValue(t, env) {
  // two players: there is no "other opponent" (Parapet Thrasher)
  if (/\beach other opponent\b/i.test(t)) return -10;
  const me = env.me;
  const them = opp(me);
  const low = t.toLowerCase();
  const a = analyze(t, env.x);
  let v = Object.keys(a).length;
  const theirs = (phrase) => legalTargets(phrase, me, env.src).map((x) => (typeof x === 'object' ? x : card(x))).filter((c) => c && c.controller === them);
  const creatures = (pid) => cardsIn(pid, 'battlefield').filter(isCreature).length;
  if (a.removal) {
    const ts = theirs(a.removal.phrase);
    v += ts.length ? 3 + Math.max(...ts.map(cardValue)) / 2 : -10;
  }
  if (a.bounce) {
    const ts = theirs(a.bounce.phrase);
    v += ts.length ? 1 + Math.max(...ts.map(cardValue)) / 4 : -8;
  }
  if (a.burn && /creature/.test(a.burn.to) && !/any target|player/.test(a.burn.to)) {
    v += cardsIn(them, 'battlefield').some((c) => isCreature(c) && toughness(c) - (c.damage || 0) <= a.burn.amount) ? 4 : -6;
  } else if (a.burn) v += 3;
  if (a.wipe) v += 2 * (creatures(them) - creatures(me));
  if (a.draw) v += 2 * a.draw;
  let m;
  // Return of the Wildspeaker: "Draw cards equal to the greatest power among non-Human creatures you control."
  if ((m = low.match(/draws? cards equal to ([^.]+)/))) {
    try {
      v += 2 * Math.max(0, xFrom(m[1], { ...env, me }) || 0);
    } catch (e) {
      /* unknown count */
    }
  }
  if ((m = low.match(/each creature deals (\d+) damage to its controller/))) v += (creatures(them) - creatures(me)) * +m[1] * 1.5;
  // Aetheric Amplifier, Deepglow Skate: doubling counters is worth what's there to double
  if (/double the number of each kind of counter on target permanent/.test(low)) {
    const mine = cardsIn(me, 'battlefield').map((c) => Object.entries(c.counters || {}).filter(([k]) => k !== '-1/-1' && k !== 'stun').reduce((a, [, v]) => a + v, 0));
    v += mine.length ? Math.max(...mine) * 1.5 - 1 : -5;
  }
  if (/double the number of each kind of counter you have/.test(low)) {
    const pc = G.s.players[me].counters || {};
    v += Object.values(pc).reduce((a, x) => a + (x || 0), 0) - (G.s.players[me].poison || 0) * 3 - 1;
  }
  // Moment of Reckoning: "Return target nonland permanent card from your graveyard to the battlefield"
  if ((m = low.match(/return target ([a-z ]+?) cards? from your graveyard to (the battlefield|your hand)/))) {
    const gy = cardsIn(me, 'graveyard').filter((c) => matchesFilter(c, m[1]) && (!/permanent/.test(m[1]) || isPermanentCard(DB[c.def])));
    v += gy.length ? 2 + Math.max(...gy.map((c) => DB[c.def].cmc || 0)) / (m[2] === 'the battlefield' ? 2 : 4) : -8;
  }
  if (/exile (?:all cards from )?target (?:player|opponent)'s graveyard/.test(low)) {
    const gy = cardsIn(them, 'graveyard');
    v += gy.length ? 1 + gy.filter((c) => /Creature/.test(DB[c.def]?.typeLine || '')).length * 0.7 + (/reanimat|graveyard/i.test(JSON.stringify(cardsIn(them, 'battlefield').map((c) => oracle(c)))) ? 2 : 0) : -5;
  }
  return v;
}

export const _whichHandler = (s) => H.findIndex((h) => !h.never && h.re.test(s.toLowerCase())) >= 0 ? String(H.find((h) => !h.never && h.re.test(s.toLowerCase())).re).slice(0, 120) : null;
export const _wardCost = (c) => wardCost(c);
