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
const MAIN_SECTIONS = /^(deck|main|mainboard|main deck|library|companion)\b/i;

export function parseDecklist(text) {
  const commanders = [];
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
      else if (SKIP_SECTIONS.test(h)) section = 'skip';
      else if (MAIN_SECTIONS.test(h)) section = 'main';
      continue;
    }
    const header = line.replace(/:$/, '');
    if (!/^\d/.test(header) && header.split(' ').length <= 3) {
      if (CMD_SECTIONS.test(header)) { section = 'cmd'; continue; }
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
    else main.push(e);
  }
  void sawBlankAfterMain;
  return { commanders, main };
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

export async function searchTokens(q) {
  const { cards } = await api('/api/tokens?q=' + encodeURIComponent(q || ''));
  return cards.map(normalize);
}

// Resolve a parsed deck ({name, commanders, main}) into card definitions.
// Returns {name, commanders:[defId], cards:[defId,... one per copy], missing:[names]}
export async function resolveDeck(parsed) {
  const all = [...parsed.commanders.map((e) => ({ ...e, cmd: true })), ...parsed.main];
  const idents = all.map((e) =>
    e.set && e.collector_number ? { name: e.name, set: e.set, collector_number: e.collector_number } : { name: e.name }
  );
  const defs = await fetchCards(idents);
  const out = { name: parsed.name || 'Deck', commanders: [], cards: [], missing: [] };
  all.forEach((e, i) => {
    const d = defs[i];
    if (!d) return out.missing.push(e.name);
    if (e.cmd) out.commanders.push(d.id);
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
  return {
    partner: kw.includes('partner') && !pw,
    partnerWith: pw ? pw[1].trim() : null,
    friendsForever: kw.includes('friends forever'),
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
    (x.chooseBackground && y.isBackground) ||
    (y.chooseBackground && x.isBackground) ||
    (x.doctorsCompanion && y.isDoctor) ||
    (y.doctorsCompanion && x.isDoctor)
  );
}

export function wantsPair(d) {
  const x = pairing(d);
  return x.partner || !!x.partnerWith || x.friendsForever || x.chooseBackground || x.doctorsCompanion || x.isDoctor || x.isBackground;
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

export const SAMPLE_DECKS = {
  gruul: {
    label: 'Gruul Stompy (Xenagos)',
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
    label: 'Golgari Value (Meren)',
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
};
