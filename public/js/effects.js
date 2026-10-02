// Shared effect engine. Reads rules text sentence by sentence, asks the controller's "chooser" for
// targets and choices, and applies the result. The AI's chooser picks automatically; the player's
// chooser asks through the UI (highlighted targets, card pickers), the way MTG Arena does.
import { DB } from './data.js';
import {
  hasSubtype, isLand, isCreature, isType, oracle, hasKw, power, toughness, cardValue, face, typeLine, colorsOf,
  isProtectedFrom, SECTORS, SECTOR_SIGN, kwCost, payCost, manaValueOf, isPermanentCard,
} from './rules.js';
import {
  G, card, cardsIn, zoneOf, move, draw, log, nameTag, changeLife, toBattlefield, createToken, genericTokenDef,
  stateBased, shuffle, cardName, opp, addCounters, destroy, sacrifice, discard as discardCard, mill as millCards,
  libTop, queueEvent, winGame, loseGame, esc, makeCard,
} from './state.js';
import { countPhrase, kwList } from './statics.js';
import { helpers } from './rules.js';
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
  let t = String(text || '').split(name).join('~');
  const short = name.split(',')[0];
  if (short.length > 3 && short !== name) t = t.split(short).join('~');
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
  return stripName(oracle(c), c)
    .replace(/\([^)]*\)/g, '')
    .split('\n')
    .filter((l) => l.trim() && !KEYWORD_LINE.test(l.trim()) && !/^(As an additional cost|This spell costs|~ costs|You may cast ~|Spend only|This spell can't be countered|~ can't be countered|When you cast ~|Split second|Cast ~ only|Cast this spell only|Strive|Kicker|Flash$)/i.test(l.trim()))
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
    const line = raw.trim();
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
      discardN: (cost.match(/Discard (a|two|\d+) cards?/i) || [])[1],
      exert: /Exert ~/i.test(cost),
      removeCounters: cost.match(/Remove (a|an|one|two|three|\d+|X) ([+-]\d+\/[+-]\d+|\w+) counters? from ~/i),
      payLife: (cost.match(/Pay (\d+) life/i) || [])[1],
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
      once: /Activate only once each turn|Activate this ability only once each turn/i.test(m[2]) || /^Exhaust\b/i.test(line),
      exhaust: /^Exhaust\b/i.test(raw),
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
  'named', 'same', 'color', 'type', 'chosen', 'legendary', 'basic', 'enchanted', 'equipped', 'attacking', 'blocking', 'tapped', 'untapped', 'spell', 'ability', 'player',
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
  if (/\btoken\b/.test(phrase) && !/nontoken/.test(phrase) && !c.token) return false;
  if (/\blegendary\b/.test(phrase) && !/nonlegendary/.test(phrase) && !/Legendary/.test(typeLine(c))) return false;
  if (/with flying/.test(phrase) && !hasKw(c, 'flying')) return false;
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
  const kindOk = kinds.some((k) => (k === 'Creature' ? isCreature(c) : isType(c, k)));
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
  if ((m = t.match(/(destroy|exile) (?:up to (?:one|two) )?(?:another )?target ([^.]+?)(?:\.|,| and| with| an opponent| you don't| that|$)/)))
    a.removal = { verb: m[1], phrase: m[2] + (/an opponent controls/.test(t) ? ' an opponent controls' : '') };
  if ((m = t.match(/return (?:up to one )?target ([^.]+?) to (?:its|their) owner's hand/))) a.bounce = { phrase: m[1] };
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
  if (/return (?:target |up to \w+ target )?[^.]*?creature cards? from (?:your|a) graveyard to the battlefield/.test(t)) a.reanimate = true;
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
  if (/^you don't$/.test(c)) return !env.lastMay;
  if (/it's your turn/.test(c)) return s.active === me;
  if (/it's not your turn/.test(c)) return s.active !== me;
  if (/no spells were cast last turn/.test(c)) return (s.lastTurnSpells || { total: 1 }).total === 0;
  if (/a player cast two or more spells last turn/.test(c)) return (s.lastTurnSpells || { max: 0 }).max >= 2;
  if (/it's night/.test(c)) return s.dayNight === 'night';
  if (/it's day/.test(c)) return s.dayNight === 'day';
  if (/a creature died this turn/.test(c)) return !!s.ts.creatureDied;
  if (/you attacked (?:with a creature )?this turn/.test(c)) return !!ts[me].attacked;
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
  if (/you(?:'ve| have) completed a dungeon/.test(c)) return s.players[me].dungeonsCompleted > 0;
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
  if (opts.filter) cands = cands.filter(opts.filter);
  let players = [];
  if (playerTarget) {
    players = /opponent/.test(kind) ? [opp(me)] : [opp(me), me];
    players = players.filter((pid) => !playerHexproof(pid, me));
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
  const m = oracle(c).match(/\bWard (?:\{(\d+)\}|—(.+?)(?:\.|$))/m) || [...(c.grants || []), ...(c.eotGrants || [])].join('|').match(/ward \{(\d+)\}/);
  if (!m) return null;
  if (m[1]) return { n: +m[1] };
  const life = (m[2] || '').match(/Pay (\d+) life/i);
  if (life) return { life: +life[1] };
  return { other: m[2] };
}

function playerHexproof(pid, caster) {
  if (pid === caster) return false;
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
  if (/^(?:enchanted|equipped|fortified) (?:creature|permanent|land|artifact)$/.test(p)) {
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
  if ((m = p.match(/^(?:each|all|every) (other |another )?(.+)$/)) || (m = p.match(/^(other )?((?:[\w-]+ )*?(?:creatures|permanents|artifacts|enchantments|lands|planeswalkers|tokens|[A-Z]?[\w-]+s) (?:you control|your opponents control|an opponent controls))$/))) {
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
    prompt: `Choose a player`, candidates: [], players: [opp(env.me), env.me].filter((p) => !playerHexproof(p, env.me)), harm, src: env.src,
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
  if ((m = w.match(/^(?:damage )?equal to (?:~'s|its) toughness/))) return env.src ? toughness(env.src) : 0;
  if ((m = w.match(/^(?:damage )?equal to (?:the number of |your )?(.+)$/))) {
    const v = countPhrase(env.me, m[1], helpers, env.src && env.src.iid);
    return v === null ? 0 : v;
  }
  return 0;
}

// ------------------------------------------------------------ the handlers
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
  for (const c of objs) {
    const nm = `${whose(c)} ${nameTag(c)}`;
    if (destroy(c.iid, { noRegen })) {
      k++;
      if (objs.length <= 3) env.did.push(`destroys ${nm}`);
    } else if (objs.length <= 3) env.did.push(`${nm} survives`);
  }
  if (objs.length > 3) env.did.push(`destroys ${k} permanent${k === 1 ? '' : 's'}`);
});
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
on(/^exile (target player's graveyard|each opponent's graveyard|all graveyards|all cards from all graveyards|target card from a graveyard|up to (\w+) target cards? from (?:a single|target player's|an opponent's) graveyard|all (?:creature )?cards? from (?:target player's|each opponent's) graveyard)/, async (m, env) => {
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
    }
    env.did.push(`flickers ${nameTag(card(iid) || c)}`);
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
on(/^(?:put|shuffle) (.+?) (?:on top of|on the bottom of|into) (?:its|their) owner'?s?'? librar(?:y|ies)(?: second from the top)?/, async (m, env) => {
  const objs = await objects(env, m[1], { harm: true });
  const bottom = /on the bottom/.test(env.sentence);
  for (const c of objs) {
    const owner = c.owner;
    const nm = `${whose(c)} ${nameTag(c)}`;
    move(c.iid, 'library', bottom ? { to: 'bottom' } : {});
    if (/shuffle/.test(env.sentence)) shuffle(owner);
    env.did.push(`puts ${nm} ${bottom ? 'on the bottom of' : /shuffle/.test(env.sentence) ? 'into' : 'on top of'} its owner's library`);
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
export function damagePlayer(env, source, pid, amount) {
  if (amount <= 0) return;
  amount *= damageMult(source || {}, true);
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
  if (source && isProtectedFrom(c, source)) {
    env.did.push(`${nameTag(c)} is protected`);
    return;
  }
  amount *= damageMult(source || {}, false);
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
        purpose: 'discard', src: env.src, aiScore: (c) => (isLand(c) ? (lands >= 6 ? 10 : -10) : DB[c.def].cmc - lands) + (/Madness/.test(oracle(c)) ? 20 : 0),
      });
    }
    env.discardedNonland = picks.some((i) => !isLand(card(i)));
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
on(/^(you|target player|each player|its controller|that player|target opponent) gains? (\d+|x|life equal to [^.]+?|that much life)(?: life)?/, async (m, env) => {
  const pids = await playerTarget(env, m[1], false);
  const k = /that much/.test(m[2]) ? env.lastAmount || 0 : /^life equal/.test(m[2]) ? amountOf(m[2].replace(/^life /, ''), env) : n(m[2], env.x);
  for (const pid of pids) {
    changeLife(pid, k, false);
    env.did.push(`${who(pid)} ${s_(pid, 'gain')} ${k} life`);
  }
});
on(/^(each opponent|target opponent|target player|that player|each player|you|its controller|defending player|each other player) loses? (\d+|x|life equal to [^.]+?|half (?:their|your) life,? rounded up)(?: life)?(?: and you gain (\d+|x|that much) life)?/, async (m, env) => {
  const pids = await playerTarget(env, m[1]);
  for (const pid of pids) {
    let k = /half/.test(m[2]) ? Math.ceil(G.s.players[pid].life / 2) : /^life equal/.test(m[2]) ? amountOf(m[2].replace(/^life /, ''), env) : n(m[2], env.x);
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
    if (/isn't legendary|is not legendary/.test(except)) tk.notLegendary = true;
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
  // known token from the card's Scryfall parts
  for (const id of (DB[src.def] || { tokens: [] }).tokens) {
    const td = DB[id];
    if (!td) continue;
    const nm = td.name.toLowerCase();
    if (d.includes(nm) || (nm.split(' ')[0].length > 3 && d.includes(nm.split(' ')[0]))) {
      const pt = d.match(/(\d+)\/(\d+)/);
      if (pt && td.faces[0].power !== undefined && (td.faces[0].power !== pt[1] || td.faces[0].toughness !== pt[2])) continue;
      defId = id;
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
  if (!defId) defId = genericTokenDef(1, 1, 'Token');
  const made = createToken(defId, me, count, { tapped });
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
on(/^put (a|an|one|two|three|four|five|six|x|\d+|that many) ([+-]\d+\/[+-]\d+|[a-z]+) counters? on ((?:(?! and (?:draw|create|you|gain|scry|surveil|investigate|exile|destroy|return|untap|tap|mill|look)\b).)+?)(?: for each [^.]+)?(?:\.|$)/, async (m, env) => {
  let k = /that many/.test(m[1]) ? env.lastAmount || 0 : n(m[1], env.x);
  const fe = env.sentence.match(/for each ([^.]+)$/);
  if (fe) k *= countPhrase(env.me, fe[1], helpers, env.src.iid) || 0;
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
on(/^double the number of ([+-]\d+\/[+-]\d+|[a-z]+|each kind of) counters on (.+?)(?:\.|$)/, async (m, env) => {
  const objs = await objects(env, m[2]);
  for (const c of objs) {
    for (const k of Object.keys(c.counters || {})) if (m[1] === 'each kind of' || k === m[1]) addCounters(c, k, c.counters[k]);
    env.did.push(`doubles the counters on ${nameTag(c)}`);
  }
});
on(/^proliferate(?: (\w+) times)?/, async (m, env) => {
  const times = m[1] ? n(m[1]) : 1;
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
  objs.forEach((c) => (c.unblockableTurn = G.s.turn));
  env.did.push(`${objs.map(nameTag).join(', ')} can't be blocked this turn`);
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
    c.phaseInTurnOf = c.controller;
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
  const objs = await objects(env, m[1]);
  const temp = /until end of turn/.test(env.text);
  for (const c of objs) {
    const prev = c.controller;
    move(c.iid, 'battlefield', { controller: env.me });
    c.zone = 'battlefield';
    if (/untap/.test(env.text)) c.tapped = false;
    if (/haste/.test(env.text)) c.eotGrants = [...(c.eotGrants || []), 'haste'];
    if (temp) G.s.delayed.push({ at: 'cleanup', kind: 'returnControl', iid: c.iid, pid: prev });
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
    if (!pool.length) continue;
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
  if (!pool.length || !env.castFree) return;
  const [pick] = await env.choosers[env.me].pickCards({ prompt: 'Cast one of them without paying its mana cost?', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'castFree', src: env.src, aiScore: (c) => DB[c.def].cmc });
  if (!pick) return;
  env.did.push(`casts ${nameTag(card(pick))} for free`);
  await env.castFree(env.me, pick);
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
  await env.castFree(env.me, pick);
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
    env.did.push(`puts ${nameTag(c)} ${/battlefield/.test(m[2]) ? 'onto the battlefield' : 'into hand'}`);
  } else if (m[3]) {
    move(c.iid, /graveyard/.test(m[3]) ? 'graveyard' : 'library', /bottom/.test(m[3]) ? { to: 'bottom' } : {});
  }
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
  const picks = await env.choosers[env.me].pickCards({ forced: true, prompt: `Put ${k} card${k > 1 ? 's' : ''} from your hand ${/bottom/.test(env.sentence) ? 'on the bottom of' : 'on top of'} your library`, cards: hand.map((c) => c.iid), min: k, max: k, purpose: 'putBack', src: env.src, aiScore: (c) => (isLand(c) ? (lands >= 5 ? 10 : -5) : DB[c.def].cmc - lands) });
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
on(/^(?:sacrifice|exile) (it|them|that creature|those creatures|that token|those tokens) at the beginning of the next end step$/, async (m, env) => {
  const ids = /them|those/.test(m[1]) && env.them_ ? env.them_ : env.it && env.it.iid ? [env.it.iid] : [];
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
on(/^exile (up to (\w+) )?(?:another )?(target )?(?:(a|an|one|two|three|x|\d+) )?([a-z ,/-]*?)cards? from (your|a|target player's|an opponent's|their|each opponent's|any) graveyards?$/, async (m, env) => {
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
on(/^copy (it|that spell|target (?:instant or sorcery |instant |sorcery )?spell(?: you control)?)(?: (\w+) times)?(?:\. you may choose new targets for the cop(?:y|ies))?$/, async (m, env) => {
  const target = env.it && env.it.iid && card(env.it.iid) ? card(env.it.iid) : env.stackTarget ? card(env.stackTarget) : (G.s.stack && card(G.s.stack.iid)) || (G.s.pstack && card(G.s.pstack.iid));
  if (!target || isPermanentCard({ faces: [DB[target.def].faces[target.castFace || 0] || DB[target.def].faces[0]] })) return env.did.push('nothing to copy');
  const times = m[2] ? n(m[2]) : 1;
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
  if (!self.origDef) {
    self.origDef = self.def;
    self.origFace = self.face || 0;
  }
  self.def = model.def;
  self.face = model.face || 0;
  if (m[3]) self.copyUntil = 'eot';
  if (keepName) self.nameOverride = keepName;
  if (/it's legendary|is legendary/i.test(m[4] || '')) self.addTypes = ((self.addTypes || '') + ' Legendary').trim();
  env.did.push(`${keepName || nameTag(self)} becomes a copy of ${nameTag(model)}${m[3] ? ' until end of turn' : ''}`);
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
  const pool = pids.flatMap((pid) => cardsIn(pid, 'graveyard')).filter((c) => c.iid !== env.src.iid && matchesFilter(c, filter || 'card') && (!/permanent/.test(filter) || isPermanentCard(DB[c.def])));
  const mvMax = phrase.match(/mana value (\d+|x) or less/);
  const pool2 = mvMax ? pool.filter((c) => DB[c.def].cmc <= (mvMax[1] === 'x' ? env.x : +mvMax[1])) : pool;
  if (!pool2.length) return env.did.push('finds nothing to return');
  const picks = all ? pool2.map((c) => c.iid) : await env.choosers[env.me].pickCards({
    prompt: `Choose ${count > 1 ? 'up to ' + count + ' cards' : 'a card'} to return to ${m[3].replace('the ', '')}`,
    cards: pool2.map((c) => c.iid), min: /up to/.test(phrase) ? 0 : 1, max: Math.min(count, pool2.length), purpose: m[3] === 'the battlefield' ? 'reanimate' : 'regrowth', src: env.src,
    aiScore: (c) => DB[c.def].cmc + (/Creature/.test(DB[c.def].typeLine) ? 2 : 0),
  });
  for (const i of picks) moveReturned(env, card(i), m[3], m[4]);
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
  let mm = rest.match(/(?:you may reveal|put) (a|an|one|two|up to (?:one|two|three)) ([^.]*?)cards? (?:from among them|of them)? ?(?:and put (?:it|them) )?into your hand/) || rest.match(/put (\w+) of them into your hand/);
  const take = mm ? n(mm[1].replace(/up to /, '')) : 1;
  const filter = mm && mm[2] ? mm[2].trim() : '';
  const pool = ids.filter((i) => !filter || matchesFilter(card(i), filter.replace(/^(?:a|an) /, '')));
  const picks = pool.length ? await env.choosers[env.me].pickCards({
    prompt: `Look at the top ${k}: choose ${take > 1 ? 'up to ' + take : 'one'}${filter ? ' ' + filter : ''} to put into your hand`, cards: pool, min: 0, max: Math.min(take, pool.length), purpose: 'dig', src: env.src,
    aiScore: (c) => (isLand(c) ? (cardsIn(env.me, 'battlefield').filter(isLand).length < 5 ? 3 : 0) : DB[c.def].cmc + 1),
  }) : [];
  for (const i of picks) move(i, 'hand');
  const toGy = /rest into your graveyard/.test(rest);
  for (const i of ids) if (!picks.includes(i)) move(i, toGy ? 'graveyard' : 'library', toGy ? {} : { to: 'bottom' });
  env.did.push(`looks at the top ${k} and takes ${picks.length}`);
}, { consumesRest: true });
on(/^reveal the top (\w+) cards? of your library\. put (?:all|each) ([a-z ]+?) cards? revealed this way into your hand(?: and the rest (?:on the bottom|into your graveyard))?/, async (m, env) => {
  const ids = libTop(env.me, n(m[1], env.x));
  const hits = ids.filter((i) => matchesFilter(card(i), m[2]));
  hits.forEach((i) => move(i, 'hand'));
  const toGy = /into your graveyard/.test(env.sentence);
  ids.filter((i) => !hits.includes(i)).forEach((i) => move(i, toGy ? 'graveyard' : 'library', toGy ? {} : { to: 'bottom' }));
  env.did.push(`reveals ${ids.length}, takes ${hits.length}`);
});
on(/^(?:scry|surveil) (\d+|x)/, async (m, env) => {
  const k = n(m[1], env.x);
  await env.choosers[env.me].scry({ n: k, surveil: /^surveil/.test(env.sentence), src: env.src });
  queueEvent({ type: /^surveil/.test(env.sentence) ? 'surveil' : 'scry', pid: env.me });
  env.did.push(`${/^surveil/.test(env.sentence) ? 'surveil' : 'scry'} ${k}`);
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
  exiled.sort(() => Math.random() - 0.5).forEach((i) => move(i, 'library', { to: 'bottom' }));
});
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
on(/^(?:after this (?:main )?phase, )?there is an additional combat phase/, async (m, env) => {
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
  addMana(env.me, syms);
  env.did.push(`adds ${syms.map((x) => `{${x}}`).join('')}`);
});
on(/^add (one|two|three|x|\d+) mana of any (?:one )?color/, async (m, env) => {
  const k = n(m[1], env.x);
  addMana(env.me, Array.from({ length: k }, () => 'ANY'));
  env.did.push(`adds ${k} mana of any color`);
});
on(/^add (x|\d+) mana in any combination of colors/, async (m, env) => {
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
  const mm = text.match(/^([\s\S]*?)Choose (one|two|three|one or both|one or more|any number|up to (?:one|two|three)|one that hasn't been chosen)(?: or more)?(?:\. You may choose the same mode more than once)?(?: at random)? ?(?:—|-)\s*\n?((?:\s*•[^\n]*\n?)+)([\s\S]*)$/i);
  if (mm) {
    if (mm[1].trim()) await runText(mm[1], env);
    const modes = mm[3].split('•').map((x) => x.trim()).filter(Boolean);
    const want = mm[2].toLowerCase();
    let max = /^one$/.test(want) ? 1 : /^two$/.test(want) ? 2 : /^three$/.test(want) ? 3 : modes.length;
    if (/up to one/.test(want)) max = 1;
    if (/up to two/.test(want)) max = 2;
    if (env.entwined) max = modes.length;
    const min = /any number|up to/.test(want) ? 0 : /one or (?:both|more)/.test(want) ? 1 : Math.min(max, modes.length);
    const picks = env.modes || (await env.choosers[env.me].chooseModes({
      prompt: `${cardName(env.src)}: choose ${want}`, modes: modes.map((t) => t.replace(/\s+$/, '')), min, max: Math.min(max, modes.length), src: env.src,
      escalate: kwCostText(env.src, 'Escalate'), spree: /Spree/i.test(oracle(env.src)),
      aiScore: (t) => {
        const a = analyze(t, env.x);
        return Object.keys(a).length + (a.removal || a.burn || a.wipe ? 3 : 0) + (a.draw ? 2 : 0);
      },
    }));
    env.modesChosen = picks;
    for (const k of picks) {
      let t = modes[k];
      t = t.replace(/^\+((?:\{[^}]+\})+) — /, ''); // spree costs are paid when casting
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
    if (dm && /deals \w+ damage/i.test(prev)) {
      sentences[i - 1] = prev.replace(/deals \w+ damage/i, `deals ${dm[1]} damage`);
      skip.add(i);
    } else if (dr && /draws? \w+ cards?/i.test(prev)) {
      sentences[i - 1] = prev.replace(/(draws?) \w+ (cards?)/i, `$1 ${dr[1]} cards`);
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
    const consumed = await runSentence(sentences[i], env);
    if (consumed === 'rest') return;
  }
}

async function runSentence(sentence, env) {
  let s = sentence.trim().replace(/\.$/, '').replace(/^then,? /i, '');
  // "When you do, X" (reflexive trigger) works like "If you do, X"
  s = s.replace(/^when you do, /i, 'If you do, ');
  // "Until the end of your next turn, you may play that card" → "you may play that card until the end of your next turn"
  let um0 = s.match(/^(until (?:the end of your next turn|end of turn|your next end step)), (.+)$/i);
  if (um0 && /\b(?:may play|may cast)\b/i.test(um0[2])) s = `${um0[2]} ${um0[1].toLowerCase()}`;
  // "For each opponent, …" in a two-player game is just "the opponent"
  if (/^for each opponent, /i.test(s)) s = s.replace(/^for each opponent, /i, '').replace(/that player controls/gi, 'an opponent controls').replace(/that player/gi, 'target opponent');
  // pure rules reminders that need no action
  if (/^(?:choose new targets for the cop(?:y|ies)|(?:it|they) can't be regenerated|if you search your library this way, shuffle|this ability triggers only once each turn|do this only once each turn|put them back in any order|each mode must target a different player|you may choose the same mode more than once|until end of turn, you don't lose this mana as steps and phases end|if that spell is countered this way, exile it instead of putting it into its owner's graveyard|those votes are revealed|it's still a land|look at the top card of your library|the flashback cost is equal to its mana cost)$/i.test(s)) return;
  if (!s) return;
  const low = s.toLowerCase();
  // conditions
  let m = low.match(/^if (.+?), (.+)$/);
  const condHandled = m && H.some((h) => !h.never && h.re.test(low) && /^\^if /.test(h.re.source));
  if (m && !/^if you do\b|^if you don't\b/.test(low) && !condHandled) {
    const instead = /instead$/.test(m[2]);
    const c = evalCond(m[1], env);
    if (c === null) {
      env.unknown.push(sentence);
      return;
    }
    env.lastCond = !!c;
    if (!c) {
      env.condFalse = true;
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
    return runSentence(s.slice(11).trim(), env);
  }
  if ((m = low.match(/^(?:otherwise|if not), (.+)$/))) {
    if (env.lastCond) return;
    return runSentence(s.slice(s.indexOf(',') + 1).trim(), env);
  }
  if ((m = low.match(/^you may (.+)$/)) && !/^you may (?:cast|play) (?:it|that card|those cards|them|the exiled card)/.test(low)) {
    const yes = await mayAsk(env, s.slice(8));
    if (!yes) return;
    return runSentence(s.slice(8), env);
  }
  if ((m = low.match(/^(?:you may )?(?:cast|play) (it|that card|the exiled card|those cards|them|a spell from among them|that spell)(?: this turn| until end of turn| until the end of your next turn)?(?: without paying its mana cost)?/))) {
    const free = /without paying/.test(low);
    const targets = env.them_ && env.them_.length ? env.them_ : env.it && env.it.iid ? [env.it.iid] : [];
    for (const iid of targets) {
      const c = card(iid);
      if (!c || isLand(c) || (c.zone !== 'exile' && c.zone !== 'library' && c.zone !== 'graveyard' && c.zone !== 'hand')) continue;
      if (free && env.castFree) {
        const yes = /^you may/.test(low) ? await env.choosers[env.me].confirm(cardName(c), `Cast ${cardName(c)} without paying its mana cost?`, env) : true;
        if (yes) {
          await env.castFree(env.me, iid);
          env.did.push(`casts ${nameTag(c)} for free`);
        }
      } else {
        Object.assign(c, { mayPlay: env.me, mayPlayUntil: /next turn/.test(low) ? G.s.turn + 2 : G.s.turn });
        env.did.push(`may play ${nameTag(c)}`);
      }
      if (/^(?:you may )?cast (?:it|that card)/.test(low)) break;
    }
    return;
  }
  // "Draw a card, then discard a card." / "Scry 1, then draw a card."
  const parts = s.split(/,? then (?=[a-z])/i);
  if (parts.length > 1 && !/^search/i.test(s) && !BLINK_RE.test(s.toLowerCase())) {
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
    const am = s.match(/^(.+?),? and (sacrifice|discard|draw|mill|scry|surveil|create|exile|destroy|return|put|tap|untap|shuffle|you gain|you lose|lose \d+ life|gain \d+ life|investigate|proliferate)\b(.*)$/i);
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
  const xm = env.text.match(/where x is (?:the number of |your |the total number of |the greatest )?([^.]+?)(?:\.|$)/);
  if (xm) {
    const v = countPhrase(env.me, xm[1], helpers, src.iid);
    if (v !== null) env.x = v;
  }
  await runText(env.fullText, env);
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
  const picks = await choose.pickCards({
    prompt: `Search your library for ${count > 1 ? 'up to ' + count : 'a'} ${basic ? 'basic ' : ''}${types.length ? types.join(' or ') : 'land'} card${count > 1 ? 's' : ''}`,
    cards: cands.map((c) => c.iid), min: 0, max: Math.min(count, cands.length), purpose: 'land', src,
    aiScore: (c) => (me === 'ai' ? aiHelpers.landScore(c) : 0),
  });
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

export function attachTo(src, t) {
  const o = oracle(src).replace(/\b(?:Enchanted|Equipped) creature/g, (x) => x);
  if (src.attachedTo && card(src.attachedTo)) {
    const old = card(src.attachedTo);
    if (old.auraBuffs) delete old.auraBuffs[src.iid];
    if (old.pacifiedBy === src.iid) old.pacifiedBy = null;
  }
  src.attachedTo = t.iid;
  const buff = o.match(/(?:Enchanted|Equipped) (?:creature|permanent) gets ([+-]\d+)\/([+-]\d+)/i);
  const kwm = o.match(/(?:Enchanted|Equipped) (?:creature|permanent) (?:gets [+-]\d+\/[+-]\d+(?: for each [^.]+)? and )?(?:has|gains) ([a-z ,{}0-9]+?)(?:\.|$)/im);
  const fe = o.match(/(?:Enchanted|Equipped) creature gets ([+-]\d+)\/([+-]\d+) for each ([^.]+)/i);
  if (buff || kwm) {
    let p = buff ? +buff[1] : 0;
    let tt = buff ? +buff[2] : 0;
    if (fe) {
      const k = countPhrase(src.controller, fe[3], helpers, src.iid) || 0;
      p = +fe[1] * k;
      tt = +fe[2] * k;
    }
    t.auraBuffs = t.auraBuffs || {};
    t.auraBuffs[src.iid] = { p, t: tt, grants: kwm ? kwList(kwm[1].toLowerCase()) : [] };
  }
  const quoted = o.match(/(?:Enchanted|Equipped) creature has "([^"]+)"/i);
  if (quoted) t.extraText = ((t.extraText || '') + '\n' + quoted[1]).trim();
  if (/Enchanted creature can't attack|Enchanted creature can't block|Enchanted creature doesn't untap/i.test(o)) t.pacifiedBy = src.iid;
  if (/Enchanted creature has base power and toughness 1\/1|Cursed/i.test(o) && /base power and toughness 1\/1/i.test(o)) t.setPT = { p: 1, t: 1 };
  queueEvent({ type: 'attached', iid: src.iid, to: t.iid, controller: src.controller });
}

export { makeCard, manaValueOf, payCost, H as HANDLERS, runText, prep };
