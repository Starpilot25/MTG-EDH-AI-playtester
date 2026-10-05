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
    layout: c.layout,
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
      else if (SKIP_SECTIONS.test(h)) section = 'skip';
      else if (MAIN_SECTIONS.test(h)) section = 'main';
      continue;
    }
    const header = line.replace(/:$/, '');
    if (!/^\d/.test(header) && header.split(' ').length <= 3) {
      if (CMD_SECTIONS.test(header)) { section = 'cmd'; continue; }
      if (COMPANION_SECTIONS.test(header)) { section = 'companion'; continue; }
      if (SKIP_SECTIONS.test(header)) { section = 'skip'; continue; }
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
    if (isCmdTag || section === 'cmd') commanders.push(e);
    else if (section === 'companion') companions.push(e);
    else main.push(e);
  }
  void sawBlankAfterMain;
  return { commanders, main, companions };
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

export async function fetchCards(identifiers) {
  const { cards } = await api('/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifiers }),
  });
  return cards.map((c) => (c ? normalize(c) : null));
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
    ...parsed.main,
  ];
  const idents = all.map((e) =>
    e.set && e.collector_number ? { name: e.name, set: e.set, collector_number: e.collector_number } : { name: e.name }
  );
  const defs = await fetchCards(idents);
  const out = { name: parsed.name || 'Deck', commanders: [], companions: [], cards: [], missing: [] };
  all.forEach((e, i) => {
    const d = defs[i];
    if (!d) return out.missing.push(e.name);
    if (e.cmd) out.commanders.push(d.id);
    else if (e.companion && /(?:^|\n)Companion —/.test(d.faces[0].oracle || '')) out.companions.push(d.id);
    else for (let k = 0; k < (e.qty || 1); k++) out.cards.push(d.id);
  });
  // Pre-load the tokens these cards can make, so the AI (and the token menu) can use them.
  const tokenIds = [...new Set([...out.commanders, ...out.cards].flatMap((id) => DB[id].tokens))].filter(
    (id) => !DB[id]
  );
  if (tokenIds.length) {
    try {
      await fetchCards(tokenIds.slice(0, 150).map((id) => ({ id })));
    } catch (e) {
      /* tokens are optional */
    }
  }
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
    return (/Legendary/.test(t) && /Creature/.test(t)) || /can be your commander/i.test(d.faces[0].oracle);
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
