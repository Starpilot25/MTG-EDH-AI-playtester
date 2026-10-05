// Shared effect engine. Reads rules text sentence by sentence, asks the controller's "chooser" for
// targets and choices, and applies the result. The AI's chooser picks automatically; the player's
// chooser asks through the UI (highlighted targets, card pickers), the way MTG Arena does.
import { DB } from './data.js';
import {
  hasSubtype, isLand, isCreature, isType, oracle, hasKw, power, toughness, cardValue, face, typeLine, colorsOf,
  isProtectedFrom, SECTORS, SECTOR_SIGN, kwCost, payCost, manaValueOf, isPermanentCard, manaAbility,
} from './rules.js';
import {
  G, card, cardsIn as cardsInZone, zoneOf as zoneOfRaw, move, draw, log, nameTag, changeLife, toBattlefield, createToken, genericTokenDef, namedTokenDef,
  stateBased, shuffle, cardName, opp, addCounters, destroy, sacrifice, discard as discardCard, mill as millCards,
  libTop, queueEvent, winGame, loseGame, esc, makeCard,
} from './state.js';
// A spell being cast stays in its zone until it resolves; effects must not see it in the hand
// (Brainsurge can't put itself back, Windfall doesn't shuffle itself away, "cards in hand" counts exclude it).
// triggers.js's shared hooks (castFree, render…), loaded lazily to avoid a circular import
let T = {};
import('./triggers.js').then((m) => {
  T = m.T;
}).catch(() => {});
const onStackIid = (i) => !!(G.s && ((G.s.stack && G.s.stack.iid === i) || (G.s.pstack && G.s.pstack.iid === i) || (G.s.resolving || []).includes(i)));
function cardsIn(pid, z) {
  const out = cardsInZone(pid, z);
  return z === 'hand' ? out.filter((c) => !onStackIid(c.iid)) : out;
}
function zoneOf(pid, z) {
  const out = zoneOfRaw(pid, z);
  return z === 'hand' ? out.filter((i) => !onStackIid(i)) : out;
}
import { countPhrase, kwList } from './statics.js';
import { helpers, damageMods, redirectTarget, playerProtectedFrom } from './rules.js';
import { venture, takeInitiative } from './dungeon.js';

const WORDNUM = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fifteen: 15, twenty: 20, once: 1, twice: 2, thrice: 3,
};
export const n = (w, x = 0) => {
  if (w === undefined || w === null) return 1;
  w = String(w).toLowerCase().trim();
  if (w === 'x') return x;
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return WORDNUM[w] || 1;
};
const NUM = '(a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\\d+)';

export class Cancelled extends Error {}

export function costOf(c) {
  const f = face(c);
  return f.manaCost || DB[c.def].manaCost || '';
}

// "your Questing Beast" / "the AI's Questing Beast", always from the human's point of view
export function whose(c) {
  return (c.zone === 'battlefield' ? c.controller : c.owner) === 'p' ? 'your' : "the AI's";
}
export const who = (pid) => (pid === 'p' ? 'you' : 'the AI');
const s_ = (pid, verb) => (pid === 'ai' ? verb + 's' : verb);
const ctl = (c) => (c.zone === 'battlefield' ? c.controller : c.owner);

// ------------------------------------------------------------ text helpers
export function stripName(text, c) {
  const name = cardName(c);
  // whole words only: "Ginger" must not eat the start of "Gingerbrute"
  const esc_ = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = (x) => new RegExp('(?<![A-Za-z])' + esc_(x) + '(?![A-Za-z])', 'g');
  let t = String(text || '').replace(word(name), '~');
  const short = name.split(',')[0];
  if (short.length > 3 && short !== name) t = t.replace(word(short), '~');
  // "Gríma, Saruman's Footman" is written "Grima" in its own text
  const plain = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (plain(short) !== short && short.length > 3) t = t.replace(word(plain(short)), '~').replace(word(plain(name)), '~');
  // legends called by their first name: "Ureni of the Unwritten" → "Ureni", "Thrakkus the Butcher" → "Thrakkus"
  else if (short === name && c && DB[c.def] && /Legendary/.test(DB[c.def].typeLine || '')) {
    const fm = name.match(/^([A-Z][\w'-]{2,}) (?:of|the|from|and)\b/);
    if (fm) t = t.replace(new RegExp('\\b' + fm[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b(?! (?:of|the|from|and)\\b)', 'g'), '~');
  }
  return t
    .replace(/\bthis (creature|artifact|enchantment|permanent|land|card|Aura|Equipment|Vehicle|spell|Saga|Class|Case|planeswalker|battle|Spacecraft)\b/gi, '~')
    .replace(/[“”]/g, '"')
    .replace(/’/g, "'");
}

const KEYWORD_LINE = /^(Kicker|Multikicker|Flashback|Buyback|Cycling|\w+cycling|Escape|Overload|Entwine|Foretell|Madness|Retrace|Jump-start|Splice|Replicate|Conspire|Evoke|Dash|Blitz|Bestow|Mutate|Prototype|Disturb|Encore|Unearth|Embalm|Eternalize|Scavenge|Ninjutsu|Commander ninjutsu|Transmute|Forecast|Suspend|Morph|Megamorph|Disguise|Echo|Cumulative upkeep|Fading|Vanishing|Emerge|Surge|Spectacle|Prowl|Awaken|Aftermath|Fuse|Plot|Offspring|Gift|Bargain|Casualty|Squad|Cleave|Freerunning|Impending|Warp|Mayhem|Harmonize|Web-slinging|Sneak|Spree|Tiered|Escalate|Affinity|Convoke|Delve|Improvise|Assist|Undaunted|Split second|Storm|Cascade|Rebound|Ripple|Gravestorm|Epic|Cipher|Hideaway|Miracle|Channel|Bloodrush|Reinforce|Level up|Outlast|Reconfigure|Crew|Saddle|Station|Craft|Equip|Fortify|Ward|Companion|Partner|Choose a Background|Read ahead|More Than Meets the Eye|Living metal|Enlist|Training|Backup|Toxic|Squad|Devoid|Changeling|Ingest|Myriad|Melee|Skulk|Menace|Flash|Haste|Vigilance|Trample|Reach|Flying|Lifelink|Deathtouch|First strike|Double strike|Defender|Hexproof|Shroud|Indestructible|Infect|Wither|Prowess|Exalted|Persist|Undying|Afterlife|Riot|Decayed|Annihilator|Afflict|Bushido|Rampage|Flanking|Provoke|Renown|Dethrone|Evolve|Extort|Exploit|Fabricate|Devour|Modular|Graft|Soulshift|Bloodthirst|Amplify|Sunburst|Tribute|Unleash|Frenzy|Horsemanship|Shadow|Fear|Intimidate|Banding|Phasing|Mobilize|Exhaust|Max speed|Start your engines|Job select|Daybound|Nightbound|Compleated|Ravenous|For Mirrodin|Living weapon|Umbra armor|Totem armor|Poisonous|Absorb|Frenzy|Ascend|Mentor|Haunt|Champion|Changeling|Battle cry|Soulbond|Totem)\b/i;

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
  return stripName(oracle(c), c)
    .replace(/Choose one\. If you control a commander as you cast (?:this spell|~), you may choose both\.\s*/i, cmdr ? 'Choose one or both —\n' : 'Choose one —\n')
    .replace(/\([^)]*\)/g, '')
    .split('\n')
    .filter((l) => l.trim() && !KEYWORD_LINE.test(l.trim()) && !/^(As an additional cost|This spell costs|~ costs|You may cast ~|Spend only|This spell can't be countered|~ can't be countered|When you cast ~|When you cycle ~|Split second|Cast ~ only|Cast this spell only|Strive|Kicker|Flash$)/i.test(l.trim()))
    .join('\n');
}

// Activated abilities on a permanent ("{2}, {T}: Draw a card.", loyalty, equip, crew, level up…)
// Modal abilities put each "•" choice on its own line; keep them with the line that says "choose one —".
export function joinBullets(text) {
  return String(text || '').replace(/\n(?=•)/g, ' ¶');
}
export const unjoin = (t) => String(t || '').replace(/ ¶•/g, '\n•');
export function activatedAbilities(c) {
  const t = joinBullets(stripName(oracle(c), c).replace(/\([^)]*\)/g, ''));
  const out = [];
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
      removeCounters: cost.match(/Remove (a|an|one|two|three|\d+|X) ([+-]\d+\/[+-]\d+|\w+) counters? from ~/i),
      payLife: (cost.match(/Pay (\d+) life/i) || [])[1] || (/Pay life equal to the number of colors in your commanders?'? color identity/i.test(cost) ? 'identity' : undefined),
      payEnergy: (cost.match(/\{E\}/g) || []).length,
      exileFromGy: cost.match(/Exile (a|two|three|\d+|X) (?:other )?(?:([a-z]+) )?cards? from your graveyard/i),
      collectEvidence: (cost.match(/Collect evidence (\d+)/i) || [])[1],
      forage: /Forage/i.test(cost),
      returnToHand: /Return ~ to its owner's hand/i.test(cost),
      mana: (cost.match(/\{(?!T\}|Q\}|E\})[^}]+\}/g) || []).join(''),
      costText: cost,
      text: unjoin(m[2]),
      raw: line,
      sorcery: /Activate only as a sorcery/i.test(m[2]),
      once: /Activate only once each turn|Activate this ability only once each turn/i.test(m[2]) || /^\s*Exhaust\b/i.test(raw),
      exhaust: /^\s*Exhaust\b/i.test(raw),
    });
  }
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
  if (/\blegendary\b/.test(phrase) && !/nonlegendary/.test(phrase) && !/Legendary/.test(typeLine(c))) return false;
  if (/with flying/.test(phrase) && !hasKw(c, 'flying')) return false;
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
  if (/with a \+1\/\+1 counter on it/.test(phrase) && !(c.counters || {})['+1/+1']) return false;
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
  if (/an opponent controls|you don't control|your opponents control|defending player controls|that player controls/.test(phrase)) return [opp(me)];
  if (/you control|you own/.test(phrase)) return [me];
  return [me, opp(me)];
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
  const tl = DB[c.def].faces[0].typeLine;
  filter = (filter || '').trim();
  if (!filter) return true;
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
export function evalCond(cond, env) {
  const c = cond.toLowerCase().replace(/^it's |^it is /, "it's ").trim();
  const me = env.me;
  const them = opp(me);
  const s = G.s;
  const ts = s.ts || { p: {}, ai: {} };
  let m;
  if (/(?:this spell|~|it) was kicked|kicker was paid/.test(c)) return !!env.kicked;
  if (/was kicked twice|kicked \w+ times/.test(c)) return (env.kicked || 0) >= 2;
  if (/(?:this spell|~|it) was bargained/.test(c)) return !!env.bargained;
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
  if (/you have at least (\d+) life more than your starting life total/.test(c)) return s.players[me].life >= G.settings.startingLife + +c.match(/(\d+)/)[1];
  if ((m = c.match(/you have (\w+) or more \{e\}/))) return s.players[me].counters.energy >= n(m[1]);
  if ((m = c.match(/x is (\d+) or (?:more|greater)/))) return (env.x || 0) >= +m[1];
  if ((m = c.match(/you control (another|a|an|two or more|three or more|four or more|five or more|seven or more) ([^,.]+?)$/))) {
    const need = /two/.test(m[1]) ? 2 : /three/.test(m[1]) ? 3 : /four/.test(m[1]) ? 4 : /five/.test(m[1]) ? 5 : /seven/.test(m[1]) ? 7 : 1;
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
  if ((m = c.match(/^the ring has tempted you (\w+) or more times this game$/))) return (s.players[me].ring || 0) >= n(m[1]);
  if ((m = c.match(/^an opponent lost (\w+) or more life this turn$/))) return ((ts[them] || {}).lifeLost || 0) >= n(m[1]);
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
  const anyTarget = /^any (?:other )?target|creature or player|player or planeswalker|creature or planeswalker|planeswalker or battle|creature, player, or planeswalker/.test(kind) || /any target/.test(p);
  const playerTarget = /^(?:player|opponent)s?\b/.test(kind) || anyTarget || /or player|player or/.test(kind);
  let cands;
  if (/^spell/.test(kind)) {
    cands = env.stackTarget ? [card(env.stackTarget)].filter(Boolean) : [];
  } else if (/card(?:s)? (?:from|in) (?:a|your|an opponent's|target player's) graveyard/.test(kind)) {
    const pids = /your graveyard/.test(kind) ? [me] : /opponent's/.test(kind) ? [opp(me)] : ['p', 'ai'];
    cands = pids.flatMap((pid) => cardsIn(pid, 'graveyard')).filter((c) => matchesFilter(c, kind.replace(/cards? (?:from|in) .*$/, '').trim() || 'card'));
  } else if (anyTarget) {
    cands = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter(
      (c) => canTarget(c, me, env.src) && (isCreature(c) || isType(c, 'Planeswalker') || isType(c, 'Battle')) && (/^any other/.test(kind) ? c.iid !== env.src.iid : true)
    );
  } else if (/^(?:player|opponent)/.test(kind)) cands = [];
  else cands = legalTargets(kind, me, env.src);
  if (/\bother\b|\banother\b/.test(p) && env.src) cands = cands.filter((c) => c.iid !== env.src.iid);
  // "Tap target permanent, then untap another target permanent": not one already chosen by this ability
  if (/\banother target\b/.test(p) && env.pickedSoFar) cands = cands.filter((c) => !env.pickedSoFar.includes(c.iid));
  if (opts.filter) cands = cands.filter(opts.filter);
  let players = [];
  if (playerTarget) {
    players = /opponent/.test(kind) ? [opp(me)] : [opp(me), me];
    players = players.filter((pid) => !playerHexproof(pid, me, env.src));
  }
  for (let k = 0; k < count; k++) {
    const left = cands.filter((c) => !results.some((r) => r.iid === c.iid));
    const pl = players.filter((pid) => !results.some((r) => r.player === pid));
    if (!left.length && !pl.length) break;
    const pick = await env.choosers[me].target({
      ...(env.forced ? { forced: true } : {}),
      prompt: opts.prompt || `Choose ${count > 1 && count < 99 ? `target ${k + 1} of ${count}` : 'a target'}: ${kind}`,
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
  return kept;
}

// Ward: the caster pays the ward cost or the spell/ability is countered. Returns true if paid (or no ward).
export async function payWard(me, t, chooser, src, choosers) {
  const w = wardCost(t);
  if (!w) return true;
  const label = `Ward on ${cardName(t)}`;
  if (w.n !== undefined) return chooser.payUnless(w.n, label, w);
  if (w.life) {
    if (me === 'ai') {
      if (G.s.players.ai.life <= w.life + 5) return false;
    } else if (!(await chooser.confirm(label, `Pay ${w.life} life? If you don't, your spell or ability is countered.`, {}))) return false;
    changeLife(me, -w.life);
    return true;
  }
  if (w.other) {
    if (me !== 'ai' && !(await chooser.confirm(label, `${w.other}? If you don't, your spell or ability is countered.`, {}))) return false;
    const { payOtherCost, applyPayment } = await import('./cast.js');
    const { aiPay } = await import('./ai.js');
    const pay = async (pid, cost, lbl, o) => (pid === 'ai' ? aiPay(pid, cost, lbl, o) : null);
    try {
      return await payOtherCost(me, w.other, src || t, { choosers: choosers || { [me]: chooser }, pay, applyPayment });
    } catch (e) {
      if (e instanceof Cancelled) return false;
      throw e;
    }
  }
  return true;
}

function wardCost(c) {
  if (c.faceDown && c.wardTwo) return { n: 2 };
  // Gold-Forged Thopteryx: "Each legendary permanent you control has ward {2}."
  if (c.zone === 'battlefield' && /Legendary/.test(typeLine(c))) {
    for (const x of cardsIn(c.controller, 'battlefield')) {
      const wm = !x.lostAbilities && oracle(x).match(/Each legendary permanent you control has ward \{(\d+)\}/i);
      if (wm) return { n: +wm[1] };
    }
  }
  const m = oracle(c).match(/\bWard (?:\{(\d+)\}|—(.+?)(?:\.|$))/m) || [...(c.grants || []), ...(c.eotGrants || [])].join('|').match(/ward \{(\d+)\}/);
  if (!m) return null;
  if (m[1]) return { n: +m[1] };
  const wb = (m[2] || '').match(/^Waterbend \{(\d+)\}/i);
  if (wb) return { n: +wb[1], waterbend: true };
  const life = (m[2] || '').match(/Pay (\d+) life/i);
  if (life) return { life: +life[1] };
  return { other: m[2] };
}

function playerHexproof(pid, caster, src) {
  if (src && playerProtectedFrom(pid, src)) return true;
  if (pid === caster) return false;
  if (G.s.players[pid].protectedUntil && G.s.turn < G.s.players[pid].protectedUntil) return true;
  return cardsIn(pid, 'battlefield').some((c) => /^You have (?:hexproof|shroud)/m.test(oracle(c)));
}

// Objects named by a phrase: "~", "it", "each creature you control", "target creature", "enchanted creature"…
async function objects(env, phrase, opts = {}) {
  const p = phrase.toLowerCase().trim().replace(/\.$/, '');
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
  if (/^(?:each opponent|each of your opponents|your opponents|an opponent|target opponent|defending player|the defending player)$/.test(p)) return [opp(me)];
  if (/^(?:each player|all players|everyone)$/.test(p)) return [me, opp(me)];
  if (/^(?:that player|its controller|its owner|their controller|that creature's controller|that permanent's controller|that spell's controller)$/.test(p)) {
    if (env.it && env.it.player) return [env.it.player];
    if (env.it && env.it.iid && card(env.it.iid)) return [ctl(card(env.it.iid))];
    if (env.thatPlayer) return [env.thatPlayer];
    return [opp(me)];
  }
  if (/^target player$/.test(p)) return null; // needs a choice
  return [];
}

async function playerTarget(env, phrase, harm = true) {
  const direct = playersOf(env, phrase);
  if (direct) return direct;
  const pick = await env.choosers[env.me].target({
    ...(env.forced ? { forced: true } : {}),
    prompt: `Choose a player`, candidates: [], players: [opp(env.me), env.me].filter((p) => !playerHexproof(p, env.me, env.src)), harm, src: env.src,
  });
  return pick && pick.player ? [pick.player] : [];
}

function amountOf(word, env) {
  const w = String(word || '').toLowerCase().trim();
  if (/^x$/.test(w)) return env.x || 0;
  if (/^\d+$/.test(w) || WORDNUM[w]) return n(w, env.x);
  let m;
  if ((m = w.match(/^(?:damage )?equal to (?:~'s|its|that creature's|the sacrificed creature's|enchanted creature's|equipped creature's) power/))) {
    const it = /^(?:damage )?equal to (?:~'s)/.test(w) ? env.src : env.it && env.it.iid ? card(env.it.iid) : env.src;
    return it ? Math.max(0, power(it)) : 0;
  }
  if ((m = w.match(/^(?:damage )?equal to (?:~'s|its|that creature's|the sacrificed creature's|enchanted creature's|equipped creature's) toughness/))) {
    const it = /^(?:damage )?equal to ~'s/.test(w) ? env.src : env.it && env.it.iid ? card(env.it.iid) : env.src;
    return it ? Math.max(0, toughness(it)) : 0;
  }
  if ((m = w.match(/^(?:damage )?equal to (?:that creature's|its) (?:mana value|converted mana cost)/))) {
    const it = env.it && env.it.iid ? card(env.it.iid) : env.src;
    return it ? DB[it.def].cmc || 0 : 0;
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
  const tgt = env.stackTarget && card(env.stackTarget);
  const filter = m[1].replace(/^target /, '').replace(/spell.*$/, '');
  if (!tgt) return env.did.push('has no spell to counter');
  // an activated ability on the stack: only "counter target … ability" can counter it
  if (G.s.stack && G.s.stack.ability) {
    if (!/ability/.test(m[1])) return env.did.push(`can't counter an ability (only spells)`);
    G.s.stack.countered = true;
    return env.did.push(`counters ${nameTag(tgt)}'s ability`);
  }
  if (!spellFilterOk(filter, tgt)) return env.did.push(`can't counter ${nameTag(tgt)} (wrong kind of spell)`);
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
  env.did.push(`${who(env.me)} may play lands and cast spells from ${of === 'p' ? 'your' : "the AI's"} hand this turn`);
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
  env.did.push(`${who(env.me)} will control ${of === 'p' ? 'you' : 'the AI'} during ${of === 'p' ? 'your' : 'its'} next turn`);
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
// The Reaper, King No More: "Put a -1/-1 counter on each of up to two target creatures."
on(/^put an? ([+-]\d+\/[+-]\d+|[a-z]+) counter on each of (up to (?:one|two|three|four)|two|three|four) target ([a-z ]+?)$/, async (m, env) => {
  const objs = await objects(env, `${m[2]} target ${m[3]}`, { harm: m[1].startsWith('-') || m[1] === 'stun' });
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
  env.did.push(`all damage to ${env.me === 'p' ? 'you' : 'the AI'} and ${env.me === 'p' ? 'your' : 'its'} creatures is dealt to ${nameTag(t)} this turn`);
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
  addMana(env.me, Array.from({ length: k }, () => 'ANY'));
  env.did.push(`adds ${k} mana of any one color`);
}, { first: true });
on(/^until end of turn, you don't lose this mana as steps and phases end$/, async () => {}, { first: true });
// Niv-Mizzet, Ghost Counsel: "you may pay that much life. if you do, draw that many cards"
on(/^(?:you may )?pay that much life\. if you do, draw that many cards$/, async (m, env) => {
  const k = env.thatMuch || 0;
  if (!k) return;
  const pl = G.s.players[env.me];
  const yes = env.me === 'ai' ? pl.life - k >= 15 : await env.choosers.p.confirm?.(`Pay ${k} life to draw ${k} card${k === 1 ? '' : 's'}?`) ?? true;
  if (!yes) return;
  changeLife(env.me, -k, false);
  draw(env.me, k, true);
  env.did.push(`pays ${k} life and draws ${k}`);
}, { first: true, multi: true });
// Eventide's Shadow
on(/^remove any number of counters from among permanents on the battlefield\. you draw cards and lose life equal to the number of counters removed this way$/, async (m, env) => {
  const all = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter((c) => Object.values(c.counters || {}).some((k) => k > 0));
  let picks;
  if (env.me === 'ai') {
    const budget = Math.max(0, G.s.players.ai.life - 12);
    picks = [];
    let tot = 0;
    for (const c of all.filter((c) => c.controller !== 'ai').sort((a, b) => cardValue(b) - cardValue(a))) {
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
  const pool = [...cardsIn('p', 'graveyard'), ...cardsIn('ai', 'graveyard')].filter((c) => /Creature/.test(DB[c.def].typeLine || ''));
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
  for (const pid of ['p', 'ai']) {
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
  for (const i of env.them_ || []) if (card(i)) card(i).loveTurn = G.s.turn;
}, { first: true });
// Gift of Immortality
on(/^return ~ to the battlefield attached to that creature at the beginning of the next end step$/, async (m, env) => {
  const host = env.it && env.it.iid;
  if (!env.src) return;
  G.s.delayed.push({ at: 'endStep', kind: 'returnAttached', iid: env.src.iid, host, pid: env.src.owner || env.me });
  env.did.push(`${nameTag(env.src)} will return attached at the next end step`);
}, { first: true });
// Arcane Denial: "Its controller may draw up to two cards at the beginning of the next turn's upkeep. You draw a card at the beginning of the next turn's upkeep."
on(/^(its controller|you) (?:may )?draws? (up to )?(a|one|two|three) cards? at the beginning of the next turn's upkeep$/, async (m, env) => {
  const tc = env.it && env.it.iid && card(env.it.iid);
  const pid = m[1] === 'you' ? env.me : tc ? tc.controller || tc.owner : env.it && env.it.player;
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
    card(i).tapped = true;
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
  env.did.push(`puts ${nameTag(t)} on the bottom of ${owner === 'p' ? 'your' : "the AI's"} library`);
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
  for (const pid of [opp(env.me), env.me]) {
    const pool = cardsIn(pid, 'graveyard').filter((c) => kinds.some((k) => matchesAny(c, k)));
    if (!pool.length) continue;
    const [pick] = await env.choosers[env.me].pickCards({ prompt: `You may exile a ${m[1]} card from ${pid === 'p' ? 'your' : "the AI's"} graveyard`, cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'gy-exile', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
    if (!pick) continue;
    move(pick, 'exile');
    if (card(pick) && env.src) card(pick).exiledWith = env.src.iid;
    got.push(pick);
  }
  env.them_ = got;
  env.did.push(got.length ? `exiles ${got.map((i) => nameTag(card(i))).join(' and ')}` : 'exiles nothing');
}, { first: true });
// King Narfi's Betrayal II, III
on(/^(?:until end of turn, )?you may cast spells from among cards exiled with ~(, and you may spend mana as though it were mana of any color to cast those spells)?(?: until end of turn)?$/, async (m, env) => {
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
    const [pick] = await env.choosers[env.me].pickCards({
      prompt: o.prompt || (o.free ? 'Cast a spell from among them without paying its mana cost?' : 'Cast a spell from among them?'),
      cards: pool, min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => (DB[c.def].cmc || 0) + (o.free ? 2 : 0),
    });
    if (!pick) break;
    const c = card(pick);
    const cost = DB[c.def].faces[0].manaCost || DB[c.def].manaCost || '';
    const ok = await T.castFree(env.me, pick, o.free ? {} : { cost: o.anyMana ? anyColorCost_(cost) : cost || '{0}', mode: 'impulse' });
    if (ok === false) {
      if (env.me === 'ai') break; // couldn't pay
      continue;
    }
    cast_.push(pick);
    env.did.push(`casts ${nameTag(c)}${o.free ? ' for free' : ''}`);
  }
  return cast_;
}
const whoseLib = (pid) => (pid === 'p' ? 'your' : "the AI's");

// Black Cat, Cunning Thief
on(/^look at the top (\w+) cards of target opponent's library, exile (\w+) of them face down, then put the rest on the bottom of their library in a random order\. you may play the exiled cards for as long as they remain exiled\. mana of any type can be spent to cast spells this way$/, async (m, env) => {
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
on(/^exile all cards from all opponents' graveyards\. choose a nonland card exiled this way\. you may cast that card for as long as it remains exiled, and you may spend mana as though it were mana of any color to cast that spell$/, async (m, env) => {
  const o = opp(env.me);
  const ids = zoneOf(o, 'graveyard').slice();
  ids.forEach((i) => move(i, 'exile'));
  const pool = spellCards(ids);
  env.did.push(`exiles ${ids.length} card${ids.length === 1 ? '' : 's'} from ${whoseLib(o)} graveyard`);
  if (!pool.length) return;
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'Choose a nonland card you may cast while it stays exiled', cards: pool, min: 1, max: 1, purpose: 'steal', src: env.src, aiScore: (c) => DB[c.def].cmc || 0 });
  grantPlay([pick], env.me, { anyMana: true, castOnly: true });
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
  for (const pid of [env.me, opp(env.me)]) {
    const pool = cardsIn(pid, 'graveyard').filter((c) => /Creature|Planeswalker/.test(DB[c.def].typeLine || ''));
    if (!pool.length) continue;
    const [pick] = await env.choosers[env.me].pickCards({ prompt: `Choose a creature or planeswalker card in ${pid === 'p' ? 'your' : "the AI's"} graveyard`, cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'reanimate', src: env.src, aiScore: (c) => cardValue(c) });
    if (pick) got.push(pick);
  }
  for (const i of got) toBattlefield(i, env.me);
  for (const c of cardsIn(env.me, 'battlefield').filter(isCreature)) if (!/Phyrexian/.test(c.addTypes || '')) c.addTypes = ((c.addTypes || '') + ' Phyrexian').trim();
  env.did.push(got.length ? `puts ${got.map((i) => nameTag(card(i))).join(' and ')} onto the battlefield` : 'finds nothing to return');
}, { first: true, multi: true });
// Brainstealer Dragon / Breeches / Ramirez / Nathan Drake / Etali / Gonti: exile the top card(s) of libraries
on(/^exile the top card of (each opponent's|each player's|that player's|each of those opponents') librar(?:y|ies)(?:, then|\.) (.+)$/, async (m, env) => {
  const pids = /each player/.test(m[1]) ? [env.me, opp(env.me)] : /that player/.test(m[1]) ? [env.thatPlayer || opp(env.me)] : [opp(env.me)];
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
on(/^(?:you may )?cast target nonland permanent card from that player's graveyard, and mana of any type can be spent to cast that spell$/, async (m, env) => {
  const pid = env.thatPlayer || opp(env.me);
  const pool = cardsIn(pid, 'graveyard').filter((c) => isPermanentCard(DB[c.def]) && !isLandFace_(c));
  if (!pool.length) return env.did.push('finds no permanent card');
  await castFromPool(env, pool.map((c) => c.iid), { max: 1, anyMana: true, prompt: `Cast a nonland permanent card from ${pid === 'p' ? 'your' : "the AI's"} graveyard?` });
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
on(/^draw a card for each creature you control but don't own$/, async (m, env) => {
  const k = cardsIn(env.me, 'battlefield').filter((c) => isCreature(c) && c.owner !== env.me).length;
  if (k) draw(env.me, k, true);
  env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${k}`);
}, { first: true });
on(/^starting with you, each player chooses a creature\. destroy each creature chosen this way$/, async (m, env) => {
  const chosen = [];
  for (const pid of [env.me, opp(env.me)]) {
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
on(/^each player exiles cards from the top of their library until they exile a nonland card\. an opponent choses a nonland card exiled this way\. you may cast up to two spells from among the other cards exiled this way without paying their mana costs$/, async (m, env) => {
  const hits = [];
  for (const pid of [env.me, opp(env.me)]) {
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
// Laughing Jasper Flint
on(/^exile the top x cards of target opponent's library, where x is the number of outlaws you control\. until end of turn, you may cast spells from among those cards, and mana of any type can be spent to cast those spells$/, async (m, env) => {
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
  const ids = [env.me, opp(env.me)].flatMap((pid) => libTop(pid, 1));
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
on(/^exile all creature cards from target player's graveyard\. you may cast spells from among those cards for as long as they remain exiled, and mana of any type can be spent to cast them$/, async (m, env) => {
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
  env.did.push(`looks at ${o === 'p' ? 'your' : "the AI's"} hand`);
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
on(/^exile cards equal to its mana value from the top of target player's library\. until your next end step, you may play those cards and mana of any type can be spent to cast those spells$/, async (m, env) => {
  const sac = env.it && card(env.it.iid);
  const k = sac ? DB[sac.def].cmc || 0 : 0;
  const [t] = await playerTarget(env, 'target player');
  const o = t || opp(env.me);
  const ids = exileTop(o, k);
  grantPlay(ids, env.me, { anyMana: true, until: G.s.turn + (G.s.active === env.me ? 0 : 1) });
  env.did.push(`exiles the top ${ids.length} of ${whoseLib(o)} library to play`);
}, { first: true, multi: true });
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
on(/^exile the top card of each of those opponents' libraries\. you may play those cards this turn, and you may spend mana as though it were mana of any color to cast those spells$/, async (m, env) => {
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
on(/^its controller looks at the top card of that opponent's library and exiles it face down\. they may play that card for as long as it remains exiled\. mana of any type can be spent to cast a spell this way$/, async (m, env) => {
  const atk = env.it && card(env.it.iid);
  const pid = atk ? atk.controller : env.me;
  const ids = exileTop(env.thatPlayer || opp(pid), 1);
  grantPlay(ids, pid, { anyMana: true, hidden: true });
  env.did.push(`${who(pid)} ${s_(pid, 'exile')} the top card of ${whoseLib(env.thatPlayer || opp(pid))} library to play`);
}, { first: true, multi: true });
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
on(/^roll a d20\. each opponent exiles cards from the top of their library until they exile an instant or sorcery card, then shuffles the rest into their library\. you may cast up to x instant and\/or sorcery spells from among cards exiled this way without paying their mana costs\./, async (m, env) => {
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
  for (const c of objs) c.goaded = { by: env.me, until: G.s.turn + 1 };
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
  env.did.push(hit ? `takes ${nameTag(card(hit))} from ${t === 'p' ? 'your' : "the AI's"} library and loses ${DB[card(hit).def].cmc || 0} life` : 'finds no historic permanent');
}, { first: true, multi: true });
// Dack Fayden, Helping Hand (1 opponent): reveal until a creature card, it enters goaded and the opponent gains control of it
on(/^reveal cards from the top of your library until you reveal x creature cards, where x is the number of opponents you have\. put those creature cards onto the battlefield, then shuffle\. they're goaded for the rest of the game\. for each of those permanents, choose a different opponent\. each opponent gains control of the permanent for which they were chosen$/, async (m, env) => {
  const got = revealCreaturesOnto(env.me, 1);
  for (const i of got) {
    const c = card(i);
    move(i, 'battlefield', { controller: opp(env.me) });
    if (card(i)) card(i).goaded = { by: env.me, until: 99999 };
  }
  env.did.push(got.length ? `${nameTag(card(got[0]))} enters goaded under ${opp(env.me) === 'p' ? 'your' : "the AI's"} control` : 'finds no creature');
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
  const until = /next turn/.test(env.text) ? G.s.turn + 2 : G.s.turn;
  for (const i of ids) {
    move(i, 'exile');
    if (/you may (?:play|cast)/.test(env.text)) Object.assign(card(i), { mayPlay: env.me, mayPlayUntil: until });
  }
  env.them_ = ids;
  env.it = ids[0] ? { iid: ids[0] } : null;
  env.did.push(`exiles ${ids.length ? ids.map((i) => nameTag(card(i))).join(', ') : 'nothing'} from the top of ${pid === env.me ? 'the' : who(pid) + "'s"} library${/you may (?:play|cast)/.test(env.text) ? ' (playable from exile)' : ''}`);
  // Chandra, Torch of Defiance: "You may cast that card. If you don't, …" — decide now
  if (/you may cast that card\. if you don't/.test(env.text) && ids.length === 1) {
    const c = card(ids[0]);
    const aiWants = () => !isLand(c) && (DB[c.def].cmc || 0) <= cardsIn(env.me, 'battlefield').filter((x) => !x.tapped && (isLand(x) || DB[x.def].produced.length)).length;
    const yes = isLand(c) ? false : await env.choosers[env.me].confirm(cardName(c), `Cast ${cardName(c)} this turn? If you don't, the other effect happens instead.`, { aiPick: aiWants, ...(env.me === 'ai' ? {} : {}) });
    env.lastMay = env.me === 'ai' ? aiWants() : !!yes;
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
    const pool = [...cardsIn('p', 'graveyard'), ...cardsIn('ai', 'graveyard')];
    if (pool.length) ids = await env.choosers[env.me].pickCards({ prompt: 'Choose card(s) to exile from a graveyard', cards: pool.map((c) => c.iid), min: 0, max: cnt, purpose: 'gy-exile', src: env.src, aiScore: (c) => (c.owner === env.me ? -5 : DB[c.def].cmc) });
  } else {
    const pids = /all graveyards|all cards from all/.test(m[1]) ? ['p', 'ai'] : [opp(env.me)];
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
on(/^(~|it|that creature|enchanted creature|equipped creature|target creature you control|each creature|each other creature)?\s?deals? (\d+|x|damage equal to [^.]+?|that much damage|twice that much damage) (?:damage )?to (.+?)(?:\. |$)/, async (m, env) => {
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
  let to = m[3].replace(/\.$/, '');
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
      const ps = /^each player/.test(part) ? ['p', 'ai'] : await playerTarget(env, part.replace(/ and .*/, ''));
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
async function pickTargetsForDamage(env, part, amount) {
  const p = part.replace(/^(?:one |)/, '');
  return pickTargets(env, /target/.test(p) ? p : 'any target', { harm: true, amount });
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
  if (payer === 'ai') {
    // worth it only if the AI has creatures that could go after a Jace and mana to spare
    const wants = cardsIn('ai', 'battlefield').some((c) => isCreature(c) && !c.tapped && power(c) > 0) && cardsIn(env.me, 'battlefield').some((c) => isType(c, 'Planeswalker') && hasSubtype(c, 'Jace'));
    if (wants) paid = T.payMana ? await T.payMana('ai', m[2], cardName(env.src)) : false;
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
  G.s.mustAttackAll = { pid: opp(env.me), until: G.s.turn + 2 };
  env.did.push(`${who(opp(env.me)) === 'you' ? 'your' : "the AI's"} creatures must attack until ${who(env.me) === 'you' ? 'your' : "the AI's"} next turn`);
}, { first: true });
// The Akroan War: "Each tapped creature deals damage to itself equal to its power."
on(/^each tapped creature deals damage to itself equal to its power$/, async (m, env) => {
  const hit = [];
  for (const pid of ['p', 'ai']) for (const c of cardsIn(pid, 'battlefield').filter((x) => isCreature(x) && x.tapped)) {
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
  G.s.tempCosts = [...(G.s.tempCosts || []).filter((t) => t.until > G.s.turn), { who: 'theirs', owner: env.me, filter: m[1].trim(), delta: +m[2], until: G.s.turn + 2 }];
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
  const want = env.me === 'ai' ? true : await env.choosers.p.confirm(cardName(env.src), `Waterbend {${k}} so you don't have to ${m[1].replace(/^then /i, '')}? (Tap artifacts and creatures to help.)`, {});
  const paid = want && T.payMana ? await T.payMana(env.me, `{${k}}`, `Waterbend {${k}}`, { waterbend: k }) : false;
  if (paid) return env.did.push(`${who(env.me)} ${s_(env.me, 'waterbend')} {${k}}`);
  await runSentence(m[1], env);
}, { first: true });
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
  const c = env.me === 'ai' || (await env.choosers.p.confirm(cardName(env.src), `Return ${m[1] ? 'an untapped ' : 'a '}${m[2]} to your hand? If you don't, ${cardName(env.src)} is sacrificed.`, {}))
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
  if (env.me === 'ai') pids = [opp(env.me)]; // deck the opponent
  else {
    const ch = await env.choosers[env.me].choose({ prompt: `Who draws ${k}?`, options: [{ label: 'The AI' }, { label: 'You' }, { label: 'Both' }], aiPick: () => 0 });
    pids = ch === 1 ? ['p'] : ch === 2 ? ['p', 'ai'] : ['ai'];
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
  G.s.attackShrink = [...(G.s.attackShrink || []).filter((x) => x.until > G.s.turn), { owner: env.me, n: +m[2], until: G.s.turn + 2, onlyAtMe: /attacks you/.test(m[1]) }];
  env.did.push(`until ${who(env.me) === 'you' ? 'your' : "the AI's"} next turn, attacking creatures get −${m[2]}/−0`);
}, { first: true });
// Jace, Architect of Thought −2: piles
on(/^reveal the top (three|two|four|five) cards of your library\. an opponent separates those cards into two piles\. put one pile into your hand and the other (on the bottom of your library in any order|into your graveyard)$/, async (m, env) => {
  const ids = libTop(env.me, n(m[1]));
  if (!ids.length) return;
  const sep = opp(env.me);
  let pile1;
  if (sep === 'ai') {
    // the AI puts the best card alone against the rest
    const best = ids.slice().sort((a, b) => cardValue(card(b)) - cardValue(card(a)))[0];
    pile1 = [best];
  } else {
    pile1 = await env.choosers.p.pickCards({ prompt: `Separate ${cardName(env.src)}'s cards into two piles: choose pile 1 (the rest is pile 2)`, cards: ids, min: 0, max: ids.length, purpose: 'pile', src: env.src, forced: true });
  }
  const pile2 = ids.filter((i) => !pile1.includes(i));
  const val = (p) => p.reduce((a, i) => a + cardValue(card(i)) + 1, 0);
  let take;
  if (env.me === 'ai') take = val(pile1) >= val(pile2) ? pile1 : pile2;
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
  const yes = env.me === 'ai' ? aiPick() : await env.choosers[env.me].confirm(cardName(c), `Top of ${who_ === 'p' ? 'your' : "the AI's"} library: ${cardName(c)}. Put it on the bottom?`, {});
  if (yes) move(top, 'library', { to: 'bottom' });
  env.did.push(`looks at the top card of ${who_ === env.me ? 'its own' : (who_ === 'p' ? 'your' : "the AI's")} library${yes ? ' and puts it on the bottom' : ' and leaves it'}`);
}, { first: true, multi: true });
// Jace, the Mind Sculptor −12
on(/^exile all cards from (target player's|target opponent's|each opponent's) library, then that player shuffles (?:their|his or her) hand into (?:their|his or her) library$/, async (m, env) => {
  const [pid] = await playerTarget(env, /opponent/.test(m[1]) ? 'target opponent' : 'target player');
  const t = pid || opp(env.me);
  const lib = zoneOf(t, 'library').slice();
  lib.forEach((i) => move(i, 'exile'));
  zoneOf(t, 'hand').slice().forEach((i) => move(i, 'library'));
  shuffle(t);
  env.did.push(`exiles ${t === 'p' ? 'your' : "the AI's"} library (${lib.length} cards); ${t === 'p' ? 'you shuffle your' : 'the AI shuffles its'} hand into ${t === 'p' ? 'your' : 'its'} library`);
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
  for (const pid of ['p', 'ai']) {
    const pool = cardsIn(pid, 'library').filter((c) => !isLand(c));
    if (!pool.length) continue;
    const [pick] = await env.choosers[env.me].pickCards({ prompt: `Exile a nonland card from ${pid === 'p' ? 'your' : "the AI's"} library`, cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'tutor', src: env.src, aiScore: (c) => DB[c.def].cmc });
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
    const yes = env.me === 'ai' ? true : await env.choosers.p.confirm(cardName(c), `Cast ${cardName(c)} without paying its mana cost?`, {});
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
  c.lostAbilities = true;
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
  const top = owner === 'ai' ? false : (await env.choosers.p.choose({ prompt: `Put ${cardName(c)} on top or bottom of your library?`, options: [{ label: 'Top' }, { label: 'Bottom' }], aiPick: () => 1 })) === 0;
  move(c.iid, 'library', top ? {} : { to: 'bottom' });
  env.did.push(`puts ${whose(c)} ${nameTag(c)} on the ${top ? 'top' : 'bottom'} of its owner's library`);
}, { first: true });
// Deepglow Skate, Aetheric Amplifier: double counters
on(/^double the number of each kind of counter on (any number of target permanents|target permanent|each permanent you control)$/, async (m, env) => {
  let objs;
  if (/any number/.test(m[1])) {
    const pool = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter((c) => Object.values(c.counters || {}).some((v) => v > 0));
    objs = (await env.choosers[env.me].pickCards({ prompt: 'Double the counters on which permanents?', cards: pool.map((c) => c.iid), min: 0, max: pool.length, purpose: 'counters', src: env.src,
      aiScore: (c) => (c.controller === env.me ? 1 + Object.entries(c.counters).filter(([k]) => k !== '-1/-1' && k !== 'stun').reduce((a, [, v]) => a + v, 0) : (c.counters['-1/-1'] || 0) - 1) })).map(card);
  } else if (/target permanent/.test(m[1])) {
    // pick the permanent whose counters are best to double: your own loyalty/+1/+1, or an opponent's -1/-1
    const good = (c) => Object.entries(c.counters || {}).reduce((a, [k, v]) => a + (k === '-1/-1' || k === 'stun' ? -v : v), 0);
    const pool = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter((c) => canTarget(c, env.me, env.src));
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
  G.s.mustAttackAll = { pid, from: G.s.turn + 1, until: G.s.turn + 2 };
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
  for (const pid of ['p', 'ai']) {
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
    if (env.me === 'ai') pid = 'ai';
    else {
      const k = await env.choosers.p.choose({ prompt: 'Who gets the emblem?', options: [{ label: 'You' }, { label: 'The AI' }], aiPick: () => 0 });
      pid = k === 1 ? 'ai' : 'p';
    }
  }
  const pl = G.s.players[pid];
  const at = (env.fullText || '').toLowerCase().indexOf(m[1].slice(0, 30));
  const txt = at >= 0 ? env.fullText.slice(at, at + m[1].length) : m[1];
  pl.emblems = [...(pl.emblems || []), txt];
  env.did.push(`${who(pid)} ${s_(pid, 'get')} an emblem: “${esc(txt)}”`);
}, { first: true });
// Way of the Cryomancer: "When you next cast an instant or sorcery spell this turn, copy that spell."
on(/^when you next cast an? (instant or sorcery|instant|sorcery|creature|noncreature) spell this turn, copy that spell$/, async (m, env) => {
  G.s.copyNext = [...(G.s.copyNext || []), { pid: env.me, turn: G.s.turn, types: m[1] === 'instant or sorcery' ? ['Instant', 'Sorcery'] : [m[1][0].toUpperCase() + m[1].slice(1)] }];
  env.did.push(`will copy ${who(env.me) === 'you' ? 'your' : 'its'} next ${m[1]} spell this turn`);
}, { first: true });
// Way of the Warlord: "~ deals 2 damage to up to one target creature or planeswalker and 2 damage to target player"
on(/^(~|it|this planeswalker) deals (\d+|x) damage to ([^.]+?) and (\d+|x) damage to ([^.]+)$/, async (m, env) => {
  await runSentence(`${m[1]} deals ${m[2]} damage to ${m[3]}`, env);
  await runSentence(`${m[1]} deals ${m[4]} damage to ${m[5]}`, env);
}, { first: true });
// Way of the Healer, Hexhaven Battalion: "create a 2/2 colorless Wizard Soldier creature token named Cadet"
on(/^create (.+?) tokens? named ([a-z~][a-z~' -]*?)(?: with ([^.]+))?$/, async (m, env) => {
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
on(/^(?:the owner of (target [^.]+?)|(target [^.]+?)'s owner|its owner) shuffles it into (?:their|his or her) library(?:, then reveals the top card of (?:their|his or her) library)?$/, async (m, env) => {
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
  for (const pid of [env.me, opp(env.me)]) {
    draw(pid, k);
    env.did.push(`${who(pid)} ${s_(pid, 'draw')} ${k}`);
  }
}, { first: true });
// Mortuary Mire, Noxious Revival: "Put target creature card from your graveyard on top of your library."
on(/^put (target [^.]+?) from (your|a|target player's) graveyard on top of (?:your|its owner's|their) library$/, async (m, env) => {
  const pids = m[2] === 'your' ? [env.me] : ['p', 'ai'];
  const filter = m[1].replace(/^target /, '').replace(/ ?cards?$/, '').trim() || 'card';
  const pool = pids.flatMap((pid) => cardsIn(pid, 'graveyard')).filter((c) => matchesFilter(c, filter));
  if (!pool.length) return env.did.push('finds nothing');
  const [pick] = await env.choosers[env.me].pickCards({ prompt: `Put a ${filter} card on top of its owner's library`, cards: pool.map((c) => c.iid), min: 1, max: 1, purpose: 'regrowth', src: env.src, aiScore: (c) => (c.owner === env.me ? DB[c.def].cmc : -DB[c.def].cmc) });
  if (!pick) return;
  move(pick, 'library');
  env.did.push(`puts ${nameTag(card(pick))} on top of its owner's library`);
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
    if (/exile it instead/.test(env.text)) c.exileOnResolve = true;
    await T.castFree(env.me, pick, {});
    env.did.push(`casts ${nameTag(c)} for free`);
  }
}, { first: true });
// Ox Drover: "Target opponent creates a 1/1 white Ox creature token and you draw a card."
on(/^(target opponent|each opponent) creates (.+?) tokens?(?: and you draw (a|one|two) cards?)?$/, async (m, env) => {
  const saved = env.me;
  env.me = opp(saved);
  await makeTokens(env, m[2], null);
  env.me = saved;
  if (m[3]) {
    draw(env.me, n(m[3]));
    env.did.push(`${who(env.me)} ${s_(env.me, 'draw')} ${n(m[3])}`);
  }
}, { first: true });
// Teferi's Protection: "Until your next turn, your life total can't change and you gain protection from everything."
on(/^until your next turn, your life total can't change and you gain protection from everything$/, async (m, env) => {
  G.s.players[env.me].lifeLocked = G.s.turn + 2;
  G.s.players[env.me].protectedUntil = G.s.turn + 2;
  env.did.push(`${env.me === 'p' ? 'your' : "the AI's"} life total can't change and ${env.me === 'p' ? 'you have' : 'it has'} protection until ${env.me === 'p' ? 'your' : 'its'} next turn`);
}, { first: true });
// Living Death, split into its three steps
on(/^each player exiles all creature cards from their graveyard$/, async (m, env) => {
  env.livingDeath = {};
  for (const pid of ['p', 'ai']) {
    env.livingDeath[pid] = cardsIn(pid, 'graveyard').filter((c) => /Creature/.test(DB[c.def].typeLine)).map((c) => c.iid);
    env.livingDeath[pid].forEach((i) => move(i, 'exile'));
  }
  env.did.push(`exiles ${env.livingDeath.p.length + env.livingDeath.ai.length} creature cards from graveyards`);
}, { first: true });
on(/^(?:each player )?sacrifices all creatures they control$/, async (m, env) => {
  let k = 0;
  for (const pid of ['p', 'ai']) for (const c of cardsIn(pid, 'battlefield').filter(isCreature)) {
    sacrifice(c.iid);
    k++;
  }
  env.did.push(`${k} creatures are sacrificed`);
}, { first: true });
on(/^(?:each player )?puts all cards they exiled this way onto the battlefield$/, async (m, env) => {
  const ld = env.livingDeath || { p: [], ai: [] };
  let k = 0;
  for (const pid of ['p', 'ai']) for (const i of ld[pid] || []) if (card(i) && card(i).zone === 'exile') {
    toBattlefield(i, pid);
    k++;
  }
  env.did.push(`${k} creatures return to the battlefield`);
}, { first: true });
on(/^each player exiles all creature cards from their graveyard, then sacrifices all creatures they control, then puts all cards they exiled this way onto the battlefield$/, async (m, env) => {
  const ex = {};
  for (const pid of ['p', 'ai']) {
    ex[pid] = cardsIn(pid, 'graveyard').filter((c) => /Creature/.test(DB[c.def].typeLine)).map((c) => c.iid);
    ex[pid].forEach((i) => move(i, 'exile'));
  }
  for (const pid of ['p', 'ai']) for (const c of cardsIn(pid, 'battlefield').filter(isCreature)) sacrifice(c.iid);
  for (const pid of ['p', 'ai']) for (const i of ex[pid]) if (card(i) && card(i).zone === 'exile') toBattlefield(i, pid);
  env.did.push(`swaps graveyards and battlefields: ${ex.p.length} for you, ${ex.ai.length} for the AI`);
}, { first: true });
// Rakdos Charm: "Each creature deals 1 damage to its controller."
on(/^each creature deals (\d+|x) damage to its controller$/, async (m, env) => {
  const k = n(m[1], env.x);
  for (const pid of ['p', 'ai']) {
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
    changeLife(pid, -amount, false);
    env.did.push(`deals ${amount} damage to ${who(pid)}`);
  }
  if (source && source.zone === 'battlefield' && hasKw(source, 'lifelink')) changeLife(ctl(source), amount, false);
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
  if (isType(c, 'Planeswalker') && !isCreature(c)) c.counters.loyalty = Math.max(0, (c.counters.loyalty || 0) - amount);
  else if (isType(c, 'Battle') && !isCreature(c)) c.counters.defense = Math.max(0, (c.counters.defense || 0) - amount);
  else if (source && (hasKw(source, 'infect') || hasKw(source, 'wither'))) addCounters(c, '-1/-1', amount);
  else c.damage += amount;
  if (source && hasKw(source, 'deathtouch') && isCreature(c)) c.deathtouched = true;
  if (source && source.zone === 'battlefield' && hasKw(source, 'lifelink')) changeLife(ctl(source), amount, false);
  env.lastAmount = amount;
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
on(/^(you |target player |each player |that player |its controller |target opponent |each opponent )?draws? (a|an|one|two|three|four|five|six|seven|eight|x|\d+|cards? equal to [^,.]+?|that many) cards?(?: and (?:you )?lose (\d+) life)?/, async (m, env) => {
  const pids = m[1] ? await playerTarget(env, m[1].trim(), false) : [env.me];
  let k = /that many/.test(m[2]) ? env.lastAmount || 0 : /equal to/.test(m[2]) ? amountOf(m[2].replace(/^cards? /, ''), env) : n(m[2], env.x);
  for (const pid of pids) {
    const before = new Set(zoneOf(pid, 'hand'));
    draw(pid, k, true);
    env.them_ = zoneOf(pid, 'hand').filter((i) => !before.has(i));
    env.did.push(`${who(pid)} ${s_(pid, 'draw')} ${k}`);
    if (m[3]) changeLife(pid, -+m[3], false);
  }
});
on(/^(you |target player |each player |that player |target opponent |each opponent |its controller )?discards? (a|one|two|three|x|\d+|your|their|his or her) (?:cards?|hand)( at random)?/, async (m, env) => {
  const pids = m[1] ? await playerTarget(env, m[1].trim()) : [env.me];
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
    let k = /half/.test(m[2]) ? Math.ceil(G.s.players[pid].life / 2) : /third/.test(m[2]) ? Math.ceil(G.s.players[pid].life / 3) : m[2] === 'that much' ? env.lastAmount || 0 : /^life equal/.test(m[2]) ? amountOf(m[2].replace(/^life /, ''), env) : n(m[2], env.x);
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
on(/^(?:you|target player|each player|that player) (?:gets?|get) (a|an|one|two|three|x|\d+|\{e\}(?:\{e\})*)(?: (?:poison counters?|rad counters?|experience counters?|energy counters?|\{e\}))?$/, async (m, env) => {
  const s = env.sentence;
  const pids = /^target player/.test(s) ? await playerTarget(env, 'target player') : /^each player/.test(s) ? ['p', 'ai'] : /^that player/.test(s) ? [env.thatPlayer || opp(env.me)] : [env.me];
  const k = /\{e\}/.test(m[1]) ? (m[1].match(/\{e\}/g) || []).length : n(m[1], env.x);
  const kind = /poison/.test(s) ? 'poison' : /rad/.test(s) ? 'rad' : /experience/.test(s) ? 'experience' : 'energy';
  for (const pid of pids) {
    if (kind === 'poison') G.s.players[pid].poison += k;
    else G.s.players[pid].counters[kind] = (G.s.players[pid].counters[kind] || 0) + k;
    env.did.push(`${who(pid)} ${s_(pid, 'get')} ${k} ${kind === 'energy' ? 'energy' : kind + ' counter' + (k === 1 ? '' : 's')}`);
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
  else if (/^(?:~|it|that creature|the exiled card|the sacrificed creature)/.test(of)) orig = env.it && env.it.iid ? card(env.it.iid) || null : env.src;
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
    if (/it's 1\/1|it's a 1\/1|they're 1\/1|base power and toughness 1\/1/.test(except)) tk.setPT = { p: 1, t: 1 };
    if (/and attacking/.test(m[1]) && G.s.combat) {
      G.s.combat.attackers.push(i);
      tk.attacking = true;
    }
    if (/sacrifice (?:it|that token|them) at the beginning of the next end step|exile (?:it|that token|them) at the beginning of the next end step/.test(env.text)) tk.endOfTurn = /exile/.test(env.text) ? 'exile' : 'sacrifice';
  }
  env.them_ = made;
  env.it = made[0] ? { iid: made[0] } : null;
  env.did.push(`creates ${count > 1 ? count + ' token copies' : 'a token copy'} of ${nameTag(orig)}`);
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
  if (forcedPT) for (const i of made) if (card(i)) card(i).setPT = { ...forcedPT };
  if (attacking && G.s.combat) {
    for (const i of made) {
      G.s.combat.attackers.push(i);
      card(i).attacking = true;
      card(i).tapped = true;
      G.s.combat.targets = G.s.combat.targets || {};
      G.s.combat.targets[i] = opp(me);
    }
  }
  if (/sacrifice (?:it|that token|them|those tokens) at the beginning of the next end step/.test(env.text)) made.forEach((i) => (card(i).endOfTurn = 'sacrifice'));
  if (/exile (?:it|that token|them|those tokens) at the beginning of the next end step/.test(env.text)) made.forEach((i) => (card(i).endOfTurn = 'exile'));
  if (attachPhrase || /role/.test(d)) {
    const [t] = await objects(env, attachPhrase || 'target creature', { harm: /cursed/.test(d) });
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
  else if (fe) k *= countPhrase(env.me, fe[1], helpers, env.src.iid) || 0;
  const kind = m[2];
  const objs = await objects(env, m[3], { harm: /^-/.test(kind) || kind === 'stun' });
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
  for (let t = 0; t < times; t++) {
    const perms = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter((c) => Object.keys(c.counters || {}).length);
    const picks = perms.length ? await env.choosers[env.me].pickCards({
      prompt: 'Proliferate: choose permanents to get one more of each counter they have', cards: perms.map((c) => c.iid), min: 0, max: perms.length,
      purpose: 'proliferate', src: env.src, forced: env.forced,
      aiScore: (c) => {
        const good = (c.counters['+1/+1'] || 0) + (c.counters.loyalty || 0) + (c.counters.lore || 0) * 0.1;
        const bad = (c.counters['-1/-1'] || 0) + (c.counters.stun || 0);
        return c.controller === env.me ? good - bad : bad - good;
      },
    }) : [];
    for (const i of picks) {
      const c = card(i);
      if (env.me === 'ai' && ((c.controller === 'ai' && !c.counters['+1/+1'] && !c.counters.loyalty) || (c.controller === 'p' && !c.counters['-1/-1'] && !c.counters.stun))) continue;
      for (const k of Object.keys(c.counters)) addCounters(c, k, 1);
    }
    const o = opp(env.me);
    if (G.s.players[o].poison > 0) G.s.players[o].poison++;
    for (const k of ['energy', 'experience']) if (G.s.players[env.me].counters[k] > 0) G.s.players[env.me].counters[k]++;
    env.did.push(`proliferates (${picks.length} permanent${picks.length === 1 ? '' : 's'}${G.s.players[o].poison ? ', poison' : ''})`);
  }
});
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
on(/^(it|that creature|they|those creatures|those tokens|that token|the token|the tokens) gains? ([a-z, ]+?)$/, async (m, env) => {
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
on(/^(.+?) (?:has|have) base power and toughness (\d+)\/(\d+)(?: until end of turn)?/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: +m[2] < 3 });
  for (const c of objs) {
    c.setPT = { p: +m[2], t: +m[3] };
    if (/until end of turn/.test(env.sentence)) c.setPTUntil = 'eot';
  }
  env.did.push(`sets base P/T to ${m[2]}/${m[3]}`);
});
on(/^(.+?) loses? all abilities(?: until end of turn)?/, async (m, env) => {
  const objs = await objects(env, m[1]);
  for (const c of objs) c.lostAbilities = /until end of turn/.test(env.sentence) ? 'eot' : true;
  env.did.push(`${objs.map(nameTag).join(', ')} lose${objs.length === 1 ? 's' : ''} all abilities`);
});
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
    if (m[2] === "can't attack or block") c.detainedUntil = G.s.turn + 2;
    else if (m[2] === "can't attack") c.noAttackUntil = G.s.turn + 2;
    else c.noBlockUntil = G.s.turn + 2;
  });
  if (objs.length) env.did.push(`${objs.map(nameTag).join(', ')} ${m[2]} until your next turn`);
});
on(/^damage can't be prevented this turn/, async (m, env) => {
  G.s.noPreventTurn = G.s.turn;
  env.did.push("damage can't be prevented this turn");
});
on(/^detain (.+)$/, async (m, env) => {
  const objs = await objects(env, m[1]);
  objs.forEach((c) => (c.detainedUntil = G.s.turn + 2));
  env.did.push(`detains ${objs.map(nameTag).join(', ')}`);
});
on(/^goad (.+)$/, async (m, env) => {
  const objs = await objects(env, m[1]);
  objs.forEach((c) => (c.goaded = { by: env.me, until: G.s.turn + 2 }));
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
    c.tapped = m[1] === 'tap';
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
    const kindPhrase = m[3].replace(/ they control$| you control$/, '').replace(/s$/, '');
    const pool = cardsIn(pid, 'battlefield').filter((c) => matchesAny(c, kindPhrase || 'permanent'));
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
  const objs = await objects(env, m[1]);
  objs.forEach((c) => {
    env.did.push(`sacrifices ${nameTag(c)}`);
    sacrifice(c.iid);
  });
});

// "You may cast one of them without paying its mana cost" (Mad Wizard's Lair, Discover-like effects)
on(/^(?:you may )?cast (?:one|a spell|up to one|any number) (?:of them|from among them|of those cards)(?: [^.]*?)? without paying (?:its|their) mana costs?/, async (m, env) => {
  const pool = (env.them_ || []).map(card).filter((c) => c && ['hand', 'exile', 'library', 'graveyard'].includes(c.zone) && !isLand(c));
  if (!pool.length || !(env.castFree || T.castFree)) return;
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'Cast one of them without paying its mana cost?', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => DB[c.def].cmc });
  if (!pick) return;
  env.did.push(`casts ${nameTag(card(pick))} for free`);
  await (env.castFree || T.castFree)(env.me, pick, {});
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
on(/^pay ((?:\{[^}]+\})+)$/, async (m, env) => {
  const { T } = await import('./triggers.js');
  const paid = T.payMana ? await T.payMana(env.me, m[1], cardName(env.src)) : false;
  env.lastMay = !!paid;
  if (paid) env.did.push(`${who(env.me)} ${s_(env.me, 'pay')} ${m[1]}`);
});
// "Sacrifice ~ unless you pay {2}"
on(/^(sacrifice ~|sacrifice it|exile ~|return ~ to its owner's hand|tap ~|~ deals (\d+) damage to you|you lose (\d+) life|counter (?:it|that spell)) unless you (pay ((?:\{[^}]+\})+)|discard (?:a|one) cards?|sacrifice [^.]+|pay (\d+) life|return [^.]+)$/, async (m, env) => {
  const ch = env.choosers[env.me];
  let paid = false;
  const cost = m[4];
  const want = env.me === 'ai' ? true : await ch.confirm(cardName(env.src), `${m[1].replace(/~/g, cardName(env.src))} unless you ${cost}. Pay?`, {});
  if (want) {
    if (m[5]) {
      const { T } = await import('./triggers.js');
      paid = T.payMana ? await T.payMana(env.me, m[5], cardName(env.src)) : false;
    } else if (m[6]) {
      if (G.s.players[env.me].life > +m[6] + (env.me === 'ai' ? 5 : 0)) {
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
    forced: !/up to/.test(env.sentence), prompt: `Choose ${k === 1 ? 'a' : k} ${kind} card${k === 1 ? '' : 's'} from ${pid === 'p' ? 'your' : "the AI's"} hand`, cards: pool.map((c) => c.iid),
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
on(/^put (?:that card|it|them|those cards) into your hand$/, async (m, env) => {
  const ids = env.them_ && env.them_.length ? env.them_ : env.it && env.it.iid ? [env.it.iid] : [];
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
on(/^return (it|that card|the exiled card|them|those cards|the exiled cards|that creature|each card exiled this way) to the battlefield( transformed)?(?: under (its owner's|their owners'|their owner's|your|its controller's) control)?( tapped)?( at the beginning of the next end step)?$/, async (m, env) => {
  let ids = env.them_ && env.them_.length && /them|those|each/.test(m[1]) ? env.them_ : env.it && env.it.iid ? [env.it.iid] : env.them_ || [];
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
    env.did.push(`returns ${nameTag(card(i))} to the battlefield${m[2] ? ' transformed' : ''}`);
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
on(/^(?:(?:sacrifice|exile) (it|them|that creature|those creatures|that token|those tokens) at the beginning of (?:the|your) next end step|at the beginning of (?:the|your) next end step, (?:sacrifice|exile) (it|them|that creature|those creatures|that token|those tokens))$/, async (m, env) => {
  m[1] = m[1] || m[2];
  const ids = /them|those/.test(m[1]) && (env.them_ || env.made) ? env.them_ || env.made : env.it && env.it.iid ? [env.it.iid] : [];
  if (ids.length) env.did.push(`${ids.length === 1 && card(ids[0]) ? nameTag(card(ids[0])) : ids.length + ' permanents'} will ${/exile/.test(env.sentence) ? 'be exiled' : 'be sacrificed'} at end of turn`);
  for (const i of ids) if (card(i)) card(i).endOfTurn = /^exile/.test(env.sentence) ? 'exile' : 'sacrifice';
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
    for (const c of cardsIn(env.me === 'ai' ? 'p' : 'ai', 'battlefield')) for (const col of colorsOf(c)) counts[map[col]]++;
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
  const pids = m[6] === 'your' || m[6] === 'their' ? [env.me] : /opponent/.test(m[6]) ? [opp(env.me)] : ['p', 'ai'];
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
    c.animated = { p: +m[2], t: +m[3], types, until: m[6] ? 'eot' : 'forever' };
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
  l.animated = { p: 0, t: 0, types: 'Creature', until: 'forever' };
  l.grants = [...(l.grants || []), 'haste'];
  l.earthbent = true;
  addCounters(l, '+1/+1', k);
  env.did.push(`earthbends ${nameTag(l)} (${k} counters)`);
});
// --- copying a spell on the stack: "Copy it", "Copy target instant or sorcery spell"
on(/^copy (it|that spell|target (?:instant or sorcery |instant |sorcery )?spell(?: you control)?)(?: (twice|thrice|\w+ times))?(?:\. you may choose new targets for the cop(?:y|ies))?$/, async (m, env) => {
  const target = env.it && env.it.iid && card(env.it.iid) ? card(env.it.iid) : env.stackTarget ? card(env.stackTarget) : (G.s.stack && card(G.s.stack.iid)) || (G.s.pstack && card(G.s.pstack.iid));
  if (!target) return env.did.push('nothing to copy');
  const times = !m[2] ? 1 : m[2] === 'twice' ? 2 : m[2] === 'thrice' ? 3 : n(m[2].replace(/ times$/, '')) || 1;
  // a copy of a permanent spell becomes a token (Tomb of Horrors Adventurer, Double Major…)
  if (isPermanentCard({ faces: [DB[target.def].faces[target.castFace || 0] || DB[target.def].faces[0]] })) {
    const made = createToken(target.def, env.me, times);
    for (const i of made) if (card(i)) card(i).face = target.castFace || 0;
    env.did.push(`copies ${nameTag(target)} (${made.length} token${made.length === 1 ? '' : 's'})`);
    return;
  }
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
  for (const c of objs) c.goaded = { by: env.me, until: G.s.turn + 1 };
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
  const pids = m[2] === 'your' ? [env.me] : m[2] === "an opponent's" ? [opp(env.me)] : ['p', 'ai'];
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
  if (/battlefield/.test(dest)) toBattlefield(c.iid, /under your control/.test(env.sentence) ? env.me : c.owner, { tapped: !!tapped });
  else if (/top of your library/.test(dest)) move(c.iid, 'library');
  else move(c.iid, 'hand');
  env.it = { iid: c.iid };
  env.did.push(`returns ${nm} to ${/battlefield/.test(dest) ? 'the battlefield' : /library/.test(dest) ? 'the top of the library' : 'hand'}`);
}
on(/^put (?:a|up to (\w+)) (land|creature|permanent|[a-z]+) cards? from your hand onto the battlefield( tapped)?/, async (m, env) => {
  const k = m[1] ? n(m[1]) : 1;
  const pool = cardsIn(env.me, 'hand').filter((c) => matchesFilter(c, m[2]) && (m[2] !== 'permanent' || isPermanentCard(DB[c.def])));
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
  const bf = rest.match(/(?:you may )?put (a|an|one|two|up to (?:one|two|three)|any number of) ([^.]*?)cards? from among them onto the battlefield( tapped)?/);
  let mm = bf || rest.match(/(?:you may reveal|put) (a|an|one|two|up to (?:one|two|three)) ([^.]*?)cards? (?:from among them|of them)? ?(?:and put (?:it|them) )?into your hand/) || rest.match(/put (\w+) of them into your hand/);
  const take = mm ? (/any number/.test(mm[1]) ? k : n(mm[1].replace(/up to /, ''))) : 1;
  const filter = mm && mm[2] ? mm[2].trim() : '';
  const pool = ids.filter((i) => !filter || matchesFilter(card(i), filter.replace(/^(?:a|an) /, '')));
  const picks = pool.length ? await env.choosers[env.me].pickCards({
    prompt: `Look at the top ${k}: choose ${take > 1 ? 'up to ' + take : 'one'}${filter ? ' ' + filter : ''} to put ${bf ? 'onto the battlefield' : 'into your hand'}`, cards: pool, min: 0, max: Math.min(take, pool.length), purpose: bf ? 'cheat' : 'dig', src: env.src,
    aiScore: (c) => (bf ? DB[c.def].cmc + 1 : isLand(c) ? (cardsIn(env.me, 'battlefield').filter(isLand).length < 5 ? 3 : 0) : DB[c.def].cmc + 1),
  }) : [];
  for (const i of picks) {
    if (bf) {
      toBattlefield(i, env.me, { tapped: !!bf[3] });
      env.did.push(`puts ${nameTag(card(i))} onto the battlefield`);
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
});
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
      const keep = env.me === 'ai' ? DB[tc.def].cmc <= 4 : await env.choosers[env.me].confirm('Explore', `Keep ${cardName(tc)} on top of your library? (No puts it into your graveyard.)`);
      if (!keep) move(top, 'graveyard');
      env.did.push(`${nameTag(c)} explores (+1/+1 counter${keep ? '' : ', ' + nameTag(tc) + ' milled'})`);
    }
    queueEvent({ type: 'explored', iid: c.iid, controller: env.me });
  }
});
on(/^(~|it|he|she|they|(?:up to (?:one|two) )?(?:another )?target creatures?(?: you control)?|that creature|each creature you control|those creatures) connives?(?: (\w+))?/, async (m, env) => {
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
    env.did.push(`${who(who_)} draw${who_ === 'ai' ? 's' : ''} ${extra} extra card${extra > 1 ? 's' : ''} before conniving`);
  }
  const me = who_;
  draw(me, k, true);
  const hand = cardsIn(me, 'hand');
  const lands = cardsIn(me, 'battlefield').filter(isLand).length;
  const picks = hand.length ? await env.choosers[me].pickCards({
    forced: true, prompt: `Connive: discard ${k === 1 ? 'a card' : k + ' cards'}`, cards: hand.map((x) => x.iid), min: Math.min(k, hand.length), max: Math.min(k, hand.length),
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
  if (!ids.length) env.did.push(`${who(env.me)} ${env.me === 'ai' ? 'has' : 'have'} no cards to manifest`);
  if (!ids.length) return;
  let pick = ids[0];
  if (m[1] === 'dread' && ids.length > 1) [pick] = await env.choosers[env.me].pickCards({ prompt: 'Manifest dread: choose one to manifest (the other goes to your graveyard)', cards: ids, min: 1, max: 1, purpose: 'manifest', src: env.src, aiScore: (c) => (isCreature(c) ? 5 : 0) + DB[c.def].cmc });
  for (const i of ids) if (i !== pick && m[1] === 'dread') move(i, 'graveyard');
  toBattlefield(pick, env.me, { faceDown: true });
  card(pick).manifested = true;
  env.did.push(m[1] === 'dread' ? 'manifests dread' : 'manifests the top card');
});
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
  const rows = [...env.fullText.matchAll(/(?:^|\n)(\d+)(?:—|-|–)(\d+)? ?\| ?([^\n]+)/g)];
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
  const cs = cardsIn(env.me, 'battlefield').filter(isCreature);
  if (cs.length) {
    const [pick] = await env.choosers[env.me].pickCards({ forced: true, prompt: 'The Ring tempts you: choose your Ring-bearer', cards: cs.map((c) => c.iid), min: 1, max: 1, purpose: 'ringbearer', src: env.src, aiScore: (c) => (hasKw(c, 'flying') ? 3 : 0) + power(c) });
    for (const c of cs) c.ringBearer = false;
    card(pick).ringBearer = true;
    pl.ringBearer = pick;
    env.did.push(`the Ring tempts ${who(env.me)} (level ${pl.ring}); ${nameTag(card(pick))} is the Ring-bearer`);
  } else env.did.push(`the Ring tempts ${who(env.me)} (level ${pl.ring})`);
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
  for (const pid of ['p', 'ai']) {
    [...zoneOf(pid, 'hand')].forEach((i) => move(i, 'library'));
    if (/graveyard/.test(env.sentence)) [...zoneOf(pid, 'graveyard')].forEach((i) => move(i, 'library'));
    shuffle(pid);
    draw(pid, n(m[1]), true);
  }
  env.did.push(`each player shuffles and draws ${n(m[1])}`);
});
on(/^each player discards (?:their|his or her) hand,? then draws (seven|\w+) cards/, async (m, env) => {
  for (const pid of ['p', 'ai']) {
    [...zoneOf(pid, 'hand')].forEach((i) => discardCard(i));
    draw(pid, n(m[1]), true);
  }
  env.did.push(`each player wheels for ${n(m[1])}`);
});
on(/^(?:you )?(?:may )?play an additional land this turn/, async (m, env) => {
  G.s.extraLandThisTurn = (G.s.extraLandThisTurn || 0) + 1;
  env.did.push('may play an additional land this turn');
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
  env.did.push(`adds ${syms.map((x) => `{${x}}`).join('') || 'no mana'}`);
});
// Irencrag Feat: "Add seven {R}."
on(/^add (two|three|four|five|six|seven|eight|nine|ten|x|\d+) (\{[wubrgc]\})(?: for each ([^.]+))?$/, async (m, env) => {
  let k = n(m[1], env.x);
  if (m[3]) k *= countPhrase(env.me, m[3], helpers, env.src.iid) || 0;
  const syms = Array.from({ length: k }, () => m[2][1].toUpperCase());
  addMana(env.me, syms);
  env.lastAdded = syms;
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
  if (pool.length && env.me === 'ai') {
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
  const k = n(m[1], env.x);
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
  G.s.pool = G.s.pool || { p: [], ai: [] };
  G.s.pool[pid].push(...syms);
}

// --- Space sculptor sectors (Space Beleren)
async function chooseSector(env, what, score) {
  const inSec = (sec) => [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter((c) => isCreature(c) && c.sector === sec);
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
  if (/^you may/.test(env.sentence || '') && !(await mayAsk(env, `attach ${cardName(env.src)} to ${pl === 'p' ? 'you' : 'the AI'}`))) return;
  env.src.enchantedPlayer = pl;
  delete env.src.attachedTo;
  env.did.push(`now enchants ${pl === 'p' ? 'you' : 'the AI'}`);
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
// Davros: "each opponent who lost 3 or more life this turn faces a villainous choice — A, or B"
on(/^each opponent (?:who lost (\w+) or more life this turn )?faces a villainous choice — (.+?), or (.+)$/, async (m, env) => {
  const them = opp(env.me);
  if (m[1] && ((G.s.ts[them] || {}).lifeLost || 0) < n(m[1])) return;
  const raw = env.sentence.split(' — ')[1] || '';
  const opts = [m[2], m[3]];
  const k = await env.choosers[them].choose({
    prompt: `${cardName(env.src)}: villainous choice`,
    options: opts.map((o) => ({ label: o[0].toUpperCase() + o.slice(1) })),
    aiPick: () => (/discards?/.test(opts[1]) && cardsIn(them, 'hand').length > 2 ? 1 : 0),
  });
  env.thatPlayer = them;
  env.it = { player: them };
  env.did.push(`${who(them)} ${s_(them, 'choose')}: ${opts[k]}`);
  void raw;
  await runSentence(opts[k].replace(/^that player /, 'target opponent '), env);
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
// --- vote / villainous choice: the AI answers for itself, you choose for yourself
on(/^(?:will of the council|council's dilemma)? ?(?:—|-)? ?starting with you, each player votes for (.+?)(?:\.|$)/, async (m, env) => {
  const options = m[1].split(/ or /).map((x) => x.trim());
  const k = await env.choosers[env.me].choose({ prompt: 'Vote', options: options.map((o) => ({ label: o })), aiPick: () => 0 });
  env.vote = options[k];
  env.did.push(`votes for ${options[k]}`);
});

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
  const mm = text.match(/^([\s\S]*?)Choose (one|two|three|one or both|one or more|any number|up to (?:one|two|three)|one that hasn't been chosen)(?: or more)?(?:\. You may choose the same mode more than once)?(?: at random)?(?: ?(?:—|-)|\.)\s*\n?((?:\s*•[^\n]*\n?)+)([\s\S]*)$/i);
  if (mm) {
    // "Whenever a player casts a spell, if it isn't that player's turn, choose one —" (an intervening if before the modes)
    const ifm = mm[1].match(/(^|[.\n]\s*)if ([^,.]+),\s*$/i);
    if (ifm) {
      const pre = mm[1].slice(0, ifm.index + ifm[1].length);
      if (pre.trim()) await runText(pre, env);
      if (!evalCond(ifm[2], env)) return;
    } else if (mm[1].trim()) await runText(mm[1], env);
    let modes = mm[3].split('•').map((x) => x.trim()).filter(Boolean);
    const want = mm[2].toLowerCase();
    // "choose one that hasn't been chosen" (Silent Hallcreeper, the Hidden Ones…): each mode once per object
    let fresh = null;
    if (/hasn't been chosen/.test(want)) {
      const holder = (env.src && card(env.src.iid)) || env.src;
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
    let max = /^one(?: that hasn't been chosen)?$/.test(want) ? 1 : /^two$/.test(want) ? 2 : /^three$/.test(want) ? 3 : modes.length;
    if (/up to one/.test(want)) max = 1;
    if (/up to two/.test(want)) max = 2;
    if (env.entwined) max = modes.length;
    const min = /any number|up to/.test(want) ? 0 : /one or (?:both|more)/.test(want) ? 1 : Math.min(max, modes.length);
    const picks = env.modes || (await env.choosers[env.me].chooseModes({
      prompt: `${cardName(env.src)}: choose ${want}`, modes: modes.map((t) => t.replace(/\s+$/, '')), min, max: Math.min(max, modes.length), src: env.src,
      escalate: kwCostText(env.src, 'Escalate'), spree: /Spree/i.test(oracle(env.src)),
      aiScore: (t) => modeValue(t, env),
    }));
    env.modesChosen = picks;
    if (fresh && fresh.holder) fresh.holder.modesUsed = [...(fresh.holder.modesUsed || []), ...picks.map((k) => modes[k])];
    for (const k of picks) {
      let t = modes[k];
      t = t.replace(/^\+((?:\{[^}]+\})+) — /, ''); // spree costs are paid when casting
      t = t.replace(/^[A-Z][A-Za-z' ,-]{2,40} — (?=[A-Z])/, ''); // mode names ("Sell Contraband — Create a Treasure token.")
      await runText(t, env);
    }
    if (mm[4].trim()) await runText(mm[4], env);
    return;
  }
  const sentences = splitSentences(text);
  const skip = new Set();
  // "If X, … instead": when X holds, the previous sentence doesn't happen
  for (let i = 0; i < sentences.length; i++) {
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
    for (let k = 4; k >= 1 && !joinedRun; k--) {
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
    const consumed = await runSentence(sentences[i], env);
    if (consumed === 'rest') return;
  }
}

async function runSentence(sentence, env) {
  let s = sentence.trim().replace(/\.$/, '').replace(/^then,? /i, '');
  // X that depends on something done earlier in this same effect (Spellbound Dragon: "where X is the discarded card's mana value")
  {
    const dm = s.match(/, where X is (?:the discarded card's|that card's|the total) mana value(?: of the discarded cards| of those cards)?$/i);
    if (dm && env.discarded && env.discarded.length) env.x = env.discarded.reduce((a, i) => a + ((DB[card(i).def] || {}).cmc || 0), 0);
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
  if (/^(?:activate (?:this ability )?only (?:as a sorcery|once each turn|during your turn|any time you could cast a sorcery)|choose new targets for the cop(?:y|ies)|(?:it|they) can't be regenerated|you can cast only one more spell this turn|if you search your library this way, shuffle|this ability triggers only once each turn|do this only once each turn|put them back in any order|each mode must target a different player|you may choose the same mode more than once|until end of turn, you don't lose this mana as steps and phases end|if that spell is countered this way, exile it instead of putting it into its owner's graveyard|those votes are revealed|it's still a land|the flashback cost is equal to its mana cost)$/i.test(s)) return;
  if (!s) return;
  {
    const aw = s.match(/^([A-Z][A-Za-z' ]{2,30}?) — (.+)$/);
    if (aw && !/^(?:choose|•)/i.test(aw[1]) && handled(aw[2].toLowerCase().replace(/ instead if .*$/, ''))) s = aw[2];
  }
  const low = s.toLowerCase();
  // conditions
  let m = low.match(/^if (.+?), (.+)$/);
  const condHandled = m && H.some((h) => !h.never && h.re.test(low) && /^\^(?:\(\?:)?if /.test(h.re.source));
  if (m && !/^if you do\b|^if you don't\b|^if (?:they|that player|the player) (?:do|does|don't|doesn't)\b/.test(low) && !condHandled) {
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
    if (!env.lastMay) return;
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
  if ((m = low.match(/^you may (.+)$/)) && !/^you may (?:cast|play) (?:it|that card|those cards|them|the exiled card|spells from among|(?:the )?cards exiled (?:this way|with))/.test(low)) {
    const yes = await mayAsk(env, s.slice(8));
    if (!yes) return;
    return runSentence(s.slice(8), env);
  }
  if ((m = low.match(/^(?:you may )?(?:cast|play) (it|that card|the exiled card|those cards|them|a spell from among them|that spell)(?: this turn| until end of turn| until the end of your next turn)?(?: without paying its mana cost)?/))) {
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
        Object.assign(c, {
          mayPlay: env.me,
          mayPlayUntil: /for as long as (?:it|they|that card|those cards) remains? exiled/.test(env.text || low) ? FOREVER : /next turn/.test(low) ? G.s.turn + 2 : G.s.turn,
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
  if (parts.length > 1 && !/^search/i.test(s) && !BLINK_RE.test(s.toLowerCase()) && !H.some((h) => h.first && !h.never && h.re.test(s.toLowerCase()) && /then/.test(h.re.source))) {
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
    const am = s.match(/^(.+?),? and (sacrifice|discard|draw|mill|scry|surveil|create|exile|destroy|return|put|tap|untap|shuffle|you gain|you lose|lose \d+ life|gain \d+ life|investigate|proliferate|it can't|~ can't|it gains|~ gains|it gets|~ gets|it deals|~ deals|it becomes|~ becomes)\b(.*)$/i);
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
    await h.run(mm, env, s);
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
    const want = pid === 'ai'
      ? (lifeHit ? +lifeHit >= 3 || G.s.players.ai.life <= 12 : true)
      : await ch.confirm(cardName(env.src), `${clause.replace(/^each (?:player|opponent)/i, 'You')} unless you ${costText}. Pay "${costText}"?`, {});
    if (want) {
      try {
        paid = await payOtherCost(pid, costText, env.src, { choosers: env.choosers, pay: async (p2, c2, l2, o2) => (p2 === 'ai' ? aiPay(p2, c2, l2, o2) : null) });
      } catch (e) {
        if (!(e instanceof Cancelled)) throw e;
        paid = false;
      }
    }
    if (paid) {
      env.did.push(`${who(pid)} ${pid === 'ai' ? 'pays' : 'pay'} (${costText})`);
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
  const pids = /^target (player|opponent)$/.test(subj) ? await playerTarget(env, subj) : playersOf(env, subj);
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
    const v = countPhrase(env.me, xm[2], helpers, src.iid);
    if (v !== null) env.x = xm[1] === 'half ' ? (xm[3] === 'up' ? Math.ceil(v / 2) : Math.floor(v / 2)) : xm[1] === 'twice ' ? v * 2 : v;
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
  const m = t.match(/up to (\w+) (?:basic )?land cards?|up to (\w+) basic|up to (\w+) cards?/);
  const count = m ? n(m[1] || m[2] || m[3]) : /two basic land|two land/.test(t) ? 2 : 1;
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
  let picks = await choose.pickCards({
    prompt: share ? `Search your library for a ${basic ? 'basic ' : ''}land card (the others must share a land type with it)` : `Search your library for ${count > 1 ? 'up to ' + count : 'a'} ${basic ? 'basic ' : ''}${types.length ? types.join(' or ') : 'land'} card${count > 1 ? 's' : ''}`,
    cards: cands.map((c) => c.iid), min: 0, max: share ? 1 : Math.min(count, cands.length), purpose: 'land', src,
    aiScore: (c) => (me === 'ai' ? aiHelpers.landScore(c) + (share ? cands.filter((x) => ltypes(x).some((y) => ltypes(c).includes(y))).length / 10 : 0) : 0),
  });
  // Myriad Landscape: "up to two basic land cards that share a land type"
  if (share && picks.length) {
    const ty = ltypes(card(picks[0]));
    const more = cands.filter((c) => c.iid !== picks[0] && ltypes(c).some((y) => ty.includes(y)));
    if (more.length) {
      const extra = await choose.pickCards({ prompt: `Search for up to ${count - 1} more ${ty.join('/')} card${count > 2 ? 's' : ''}`, cards: more.map((c) => c.iid), min: 0, max: Math.min(count - 1, more.length), purpose: 'land', src, aiScore: () => 1 });
      picks = [...picks, ...extra];
    }
  }
  const onlyOneToField = /the other into your hand|put one onto the battlefield/.test(t);
  const toField = /onto the battlefield/.test(t);
  const toTop = /on top of your library|top of your library/.test(t) && !toField;
  const tapped = /battlefield tapped/.test(t);
  let fieldPicks = picks;
  if (toField && onlyOneToField && picks.length > 1) {
    fieldPicks = await choose.pickCards({
      prompt: 'Choose the land to put onto the battlefield (the other goes to your hand)',
      cards: picks, min: 1, max: 1, purpose: 'land-field', src, aiScore: () => 0,
    });
  } else if (!toField) fieldPicks = [];
  shuffle(me);
  for (const iid of picks) {
    if (fieldPicks.includes(iid)) toBattlefield(iid, me, { tapped });
    else if (toTop) move(iid, 'library');
    else move(iid, 'hand');
  }
  if (env) env.it = picks[0] ? { iid: picks[0] } : null;
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
export async function attachAura(aura, me, choose, opts = {}) {
  const o = oracle(aura);
  const em = o.match(/^Enchant ([^\n]+)/m);
  if (!em && !opts.bestow) return [];
  const what = opts.bestow ? 'creature' : em[1].toLowerCase();
  const isPlayerAura = /^(?:player|opponent)$/.test(what);
  if (isPlayerAura) return [];
  const buff = o.match(/Enchanted creature gets ([+-]\d+)\/([+-]\d+)/i);
  const lock = /Enchanted creature can't attack|Enchanted creature can't block|Enchanted creature doesn't untap|enchanted creature's activated abilities can't/i.test(o);
  const cands = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter(
    (c) => canTarget(c, me, aura) && matchesFilter(c, what.replace(/ you control$/, '')) && (!/you control/.test(what) || c.controller === me) && (!/an opponent controls|you don't control/.test(what) || c.controller !== me)
  );
  const pick = await choose.target({
    prompt: `Choose ${/^creature/.test(what) ? 'a creature' : 'a ' + what} to enchant with ${cardName(aura)}`, candidates: cands.map((c) => c.iid),
    harm: lock || (buff && +buff[1] < 0) || /control/.test(o.match(/You control enchanted/i) ? 'control' : ''), src: aura, optional: !cands.length,
  });
  if (!pick || !pick.iid) return [];
  const t = card(pick.iid);
  if (t.controller !== me && !(await payWard(me, t, choose, aura))) return [`is countered by ${nameTag(t)}'s ward`];
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
  const o = oracle(src).replace(/\b(?:Enchanted|Equipped) creature/g, (x) => x);
  if (src.attachedTo && card(src.attachedTo)) {
    const old = card(src.attachedTo);
    if (old.auraBuffs) delete old.auraBuffs[src.iid];
    if (old.pacifiedBy === src.iid) old.pacifiedBy = null;
  }
  src.attachedTo = t.iid;
  const buff = o.match(/(?:^|\n)(?:Enchanted|Equipped) (?:creature|permanent) gets ([+-]\d+)\/([+-]\d+)/i);
  const fe = o.match(/(?:^|\n)(?:Enchanted|Equipped) creature gets ([+-]\d+)\/([+-]\d+) for each ([^.]+)/i);
  const g = auraGrants(o);
  const kwm = g.kws.length ? [null, g.kws.join(', ')] : null;
  if (buff || kwm || g.base || g.texts.length || g.conds.length) {
    let p = buff ? +buff[1] : 0;
    let tt = buff ? +buff[2] : 0;
    if (fe) {
      const k = countPhrase(src.controller, fe[3], helpers, src.iid) || 0;
      p = +fe[1] * k;
      tt = +fe[2] * k;
    }
    t.auraBuffs = t.auraBuffs || {};
    t.auraBuffs[src.iid] = {
      p, t: tt, grants: g.kws, ...(fe ? { each: fe[3], perP: +fe[1], perT: +fe[2] } : {}),
      ...(g.base ? { base: g.base } : {}),
      ...(g.conds.length ? { conds: g.conds } : {}),
      // granted abilities in quotes (Teferi's Talent's "[-12]: …", Rancor-style "Whenever this creature…")
      ...(g.texts.length ? { text: g.texts.map((q) => q.replace(/^\[([+−-]?\d+)\]:/, '$1:')).join('\n') } : {}),
    };
  }
  if (/Enchanted creature can't attack|Enchanted creature can't block|Enchanted creature doesn't untap/i.test(o)) t.pacifiedBy = src.iid;
  if (/Enchanted creature has base power and toughness 1\/1|Cursed/i.test(o) && /base power and toughness 1\/1/i.test(o)) t.setPT = { p: 1, t: 1 };
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
      const harm = !blink && (!/(?:gets? \+|gains? (?!control)|untap|\+1\/\+1 counter|return [^.]* to the battlefield|hexproof|indestructible|protection)/.test(sentence) || /destroy|exile|damage|sacrifice|-\d/.test(sentence));
      let picks = [];
      try {
        picks = await pickTargets(env, phrase, { harm, noWard: true });
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
  if (/exile (?:all cards from )?target (?:player|opponent)'s graveyard/.test(low)) {
    const gy = cardsIn(them, 'graveyard');
    v += gy.length ? 1 + gy.filter((c) => /Creature/.test(DB[c.def]?.typeLine || '')).length * 0.7 + (/reanimat|graveyard/i.test(JSON.stringify(cardsIn(them, 'battlefield').map((c) => oracle(c)))) ? 2 : 0) : -5;
  }
  return v;
}

export const _whichHandler = (s) => H.findIndex((h) => !h.never && h.re.test(s.toLowerCase())) >= 0 ? String(H.find((h) => !h.never && h.re.test(s.toLowerCase())).re).slice(0, 120) : null;
export const _wardCost = (c) => wardCost(c);
