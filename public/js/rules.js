// Rules helpers: card faces, types, keywords, power/toughness, mana, evasion, combat damage.
import { DB } from './data.js';
import { G, readCache, cacheTwin, queueEvent, nextStamp, ringLevel } from './state.js';
import { staticMods, setTextFn, countPhrase, playerFlag } from './statics.js';
import { seats, opponents, isPlayer } from './state.js';

export const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];
const COLOR_WORDS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

export function def(inst) {
  return DB[inst.def];
}
export function face(inst) {
  const d = DB[inst.def];
  return d.faces[inst.face || 0] || d.faces[0];
}
// ============================================================ layers 4–7b: timestamped continuous effects
// Board-wide ones come from the permanents on the battlefield (their timestamp is when they entered);
// ones on a single permanent live in inst.layerFx: [{ ts, until, types, colors, loseAll, base, grants, mana }].
const LAYER_RE = [
  ['humility', /All creatures lose all abilities and have base power and toughness (\d+)\/(\d+)/i],
  ['dressDown', /(?:^|\n)Creatures lose all abilities\./],
  ['opal', /Each other non-Aura enchantment is a creature in addition to its other types and has base power and base toughness each equal to its mana value/i],
  ['march', /Each noncreature artifact is an artifact creature with power and toughness each equal to its mana value/i],
  ['bloodMoon', /(?:^|\n)Nonbasic lands are Mountains\./],
  ['lattice', /All permanents are artifacts in addition to their other types/i],
  ['latticeColor', /spells, and permanents are colorless/i],
  ['painter', /spells, and permanents are the chosen color in addition to their other colors/i],
  ['shifting', /All nonland permanents are the chosen color/i],
  ['adapt', /Creatures you control are the chosen type( in addition to their other types)?/i],
];
function layerFlags(def) {
  const d = DB[def];
  if (!d) return null;
  if (d._lf === undefined) {
    const txt = d.faces.map((f) => f.oracle || '').join('\n');
    const out = [];
    for (const [k, re] of LAYER_RE) {
      const m = txt.match(re);
      if (m) out.push([k, m]);
    }
    d._lf = out.length ? out : null;
  }
  return d._lf;
}
// Short-lived cache: valid for the same game, the same board version and the same synchronous run of code
// (cleared on the next microtask), so a big board (Scute Swarm making 100+ copies) doesn't rescan every permanent
// for every type check.
let glfCache = null;
export function globalLayerFx() {
  if (!G.s) return [];
  if (readCache.on && readCache.layerFx) return readCache.layerFx;
  if (glfCache && glfCache.s === G.s && glfCache.v === (G.s.bfv || 0)) return glfCache.out;
  const out = computeGlobalLayerFx();
  glfCache = { s: G.s, v: G.s.bfv || 0, out };
  queueMicrotask(() => { glfCache = null; });
  if (readCache.on) readCache.layerFx = out;
  return out;
}
function computeGlobalLayerFx() {
  const out = [];
  for (const pid of seats())
    for (const iid of G.s.players[pid].zones.battlefield) {
      const x = G.s.cards[iid];
      if (!x || x.phasedOut || x.faceDown) continue;
      const f = layerFlags(x.def);
      if (f) for (const [k, m] of f) out.push({ k, m, src: x, ts: x.ts || 0 });
    }
  if (readCache.on) readCache.layerFx = out;
  return out;
}
const printedTypes = (inst) => (face(inst).typeLine || DB[inst.def].typeLine || '').split(' // ')[0];
const BASIC_COLOR = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
// apply one type change to a type line ("Legendary Creature — Elf Druid")
function applyTypes(t, ty) {
  let [main, sub = ''] = t.split(' — ');
  main = main.trim();
  sub = sub.trim();
  if (ty.set) {
    // "is a blue Frog creature" / "is a colorless Forest land": loses its other card types and creature types (keeps supertypes)
    const sup = (main.match(/\b(?:Legendary|Basic|Snow|World)\b/g) || []).filter((x) => !ty.dropSuper);
    main = [...sup, ty.set].join(' ').trim();
    sub = ty.sub || '';
  } else {
    if (ty.add && !new RegExp('\\b' + ty.add + '\\b').test(main)) main = (main.replace(/\bCreature\b/, '').trim() + ' ' + ty.add + (/\bCreature\b/.test(main) && ty.add !== 'Creature' ? ' Creature' : '')).replace(/\s+/g, ' ').trim();
    if (ty.subSet !== undefined) sub = ty.subSet;
    if (ty.subAdd) for (const w of ty.subAdd.split(' ')) if (w && !new RegExp('\\b' + w + '\\b').test(sub)) sub = (sub + ' ' + w).trim();
  }
  return sub ? `${main} — ${sub}` : main;
}
function typeFxOf(inst, base) {
  const fx = [];
  if (inst.animated && !/Creature/.test(base.split('—')[0])) fx.push({ ts: stampOf(inst.animated), ty: { add: 'Creature', subAdd: inst.animated.types && inst.animated.types !== 'Creature' ? inst.animated.types : '' } });
  if (inst.auraType && G.s && G.s.cards[inst.auraType.src] && G.s.cards[inst.auraType.src].attachedTo === inst.iid) fx.push({ ts: stampOf((inst.auraBuffs || {})[inst.auraType.src] || inst.auraType), ty: { subSet: inst.auraType.type } });
  if (inst.addTypes) {
    if (!inst.addTypesTs) inst.addTypesTs = nextStamp();
    const sup = /\bLegendary\b/.test(inst.addTypes);
    const rest = inst.addTypes.replace(/\bLegendary\b/, '').replace(/^—\s*/, '').trim();
    fx.push({ ts: inst.addTypesTs, ty: { legendary: sup, subAdd: rest } });
  }
  for (const e of inst.layerFx || []) if (e.types) fx.push({ ts: e.ts, ty: e.types });
  if (inst.typeWhileCounter && ((inst.counters || {})[inst.typeWhileCounter.counter] || 0) > 0) fx.push({ ts: 0, ty: { subAdd: inst.typeWhileCounter.type } }); // Xolatoyac
  // Metallic Mimic, Adaptive Automaton, Roaming Throne: "~ is the chosen type in addition to its other types."
  if (inst.chosenType && /(?:^|\n)(?:[^\n]*?) is the chosen type in addition to its other types/i.test(DB[inst.def].faces[inst.face || 0].oracle || ''))
    fx.push({ ts: 0, ty: { subAdd: inst.chosenType } });
  if (inst.zone === 'battlefield')
    for (const g of globalLayerFx()) {
      if (g.k === 'opal' && g.src.iid !== inst.iid) fx.push({ ts: g.ts, ty: { add: 'Creature' }, when: (t) => /\bEnchantment\b/.test(t.split('—')[0]) && !/\bAura\b/.test(t) });
      else if (g.k === 'march') fx.push({ ts: g.ts, ty: { add: 'Creature' }, when: (t) => /\bArtifact\b/.test(t.split('—')[0]) && !/\bCreature\b/.test(t.split('—')[0]) });
      else if (g.k === 'bloodMoon') fx.push({ ts: g.ts, ty: { subSet: 'Mountain' }, when: (t) => /\bLand\b/.test(t.split('—')[0]) && !/\bBasic\b/.test(t.split('—')[0]) });
      else if (g.k === 'lattice') fx.push({ ts: g.ts, ty: { add: 'Artifact' } });
      else if (g.k === 'adapt' && g.src.chosenType && g.src.controller === inst.controller) fx.push({ ts: g.ts, ty: g.m[1] ? { subAdd: g.src.chosenType } : { subSet: g.src.chosenType }, when: (t) => /\bCreature\b/.test(t.split('—')[0]) });
    }
  return fx.sort((a, b) => a.ts - b.ts);
}
// Ultima, Origin of Oblivion: "For as long as that land has a blight counter on it, it loses all land types and abilities and has "{T}: Add {C}.""
export const blighted = (inst) => !!(inst && inst.blightLand && ((inst.counters || {}).blight || 0) > 0);
export function typeLine(inst) {
  if (inst.faceDown) return 'Creature';
  if (inst.becameTreasure) return 'Artifact — Treasure'; // Vraska, Betrayal's Sting
  if (inst.bestowed && inst.zone === 'battlefield') return 'Enchantment — Aura'; // bestowed: an Aura, not a creature (702.103)
  let t = printedTypes(inst);
  if (inst.becameLand && inst.zone === 'battlefield') t = /^Legendary/.test(t) ? 'Legendary Land' : 'Land'; // Princess Yue as Moon
  if (blighted(inst)) t = t.split(' — ')[0];
  if (inst.notLegendary) t = t.replace(/^Legendary /, '');
  // Layer 4, in timestamp order (each one sees the result of the ones before it: Opalescence after March of the Machines…)
  for (const f of typeFxOf(inst, t)) {
    if (f.when && !f.when(t)) continue;
    if (f.ty.legendary && !/^Legendary/.test(t)) t = 'Legendary ' + t;
    t = applyTypes(t, f.ty);
  }
  return t;
}
// Layer 5: colors, in timestamp order
function colorFx(inst) {
  const fx = [];
  for (const e of inst.layerFx || []) if (e.colors) fx.push({ ts: e.ts, c: e.colors });
  if (inst.zone === 'battlefield')
    for (const g of globalLayerFx()) {
      if (g.k === 'latticeColor') fx.push({ ts: g.ts, c: { set: [] } });
      else if (g.k === 'painter' && g.src.chosenColor) fx.push({ ts: g.ts, c: { add: [g.src.chosenColor] } });
      else if (g.k === 'shifting' && g.src.chosenColor && !isLand(inst)) fx.push({ ts: g.ts, c: { set: [g.src.chosenColor] } });
    }
  return fx.sort((a, b) => a.ts - b.ts);
}
// Layer 6: when (if at all) it lost all its abilities — its own effects, Auras, Humility / Dress Down, Blood Moon
export function lostAbilitiesAt(inst) {
  if (!inst) return 0;
  let lt = inst.lostAbilities ? inst.lostAt || 1 : 0;
  if (blighted(inst)) lt = Math.max(lt, 1); // Ultima's blight counter
  for (const e of inst.layerFx || []) if (e.loseAll) lt = Math.max(lt, e.ts);
  if (inst.zone === 'battlefield' && G.s) {
    const fx = globalLayerFx();
    if (fx.length) {
      const creature = fx.some((g) => g.k === 'humility' || g.k === 'dressDown') && isCreature(inst);
      for (const g of fx) {
        if ((g.k === 'humility' || g.k === 'dressDown') && creature) lt = Math.max(lt, g.ts || 1);
        if (g.k === 'bloodMoon' && /\bLand\b/.test(printedTypes(inst).split('—')[0]) && !/\bBasic\b/.test(printedTypes(inst))) lt = Math.max(lt, g.ts || 1);
      }
    }
  }
  return lt;
}
export const abilitiesGone = (inst) => lostAbilitiesAt(inst) > 0;
const typeRe = new Map();
export function isType(inst, t) {
  let re = typeRe.get(t);
  if (!re) typeRe.set(t, (re = new RegExp('\\b' + t + '\\b', 'i')));
  return re.test(typeLine(inst).split('—')[0]);
}
// Subtypes live after the dash: "Enchantment — Aura", "Artifact — Equipment". Changelings have them all.
// Omo, Queen of Vesuva: "Each land with an everything counter on it is every land type … Each nonland creature with an everything counter on it is every creature type."
function omoOut() {
  if (!G.s) return false;
  return Object.values(G.s.cards).some((x) => x.zone === 'battlefield' && !x.phasedOut && /with an everything counter on it is every (?:land|creature) type/i.test((DB[x.def].faces[x.face || 0] || {}).oracle || ''));
}
export function everythingCounter(inst) {
  return !!(inst && inst.zone === 'battlefield' && inst.counters && inst.counters.everything > 0 && omoOut());
}
const LAND_TYPES = /^(plains|island|swamp|mountain|forest|desert|gate|cave|lair|locus|mine|power-plant|tower|urza's|sphere|town|cloud)$/i;
const lanternCache = { v: -1, s: null, m: {} };
function landsAnyColor(pid) {
  if (!G.s || !pid || !G.s.players[pid]) return false;
  if (lanternCache.s !== G.s || lanternCache.v !== G.s.bfv) Object.assign(lanternCache, { s: G.s, v: G.s.bfv, m: {} });
  if (lanternCache.m[pid] === undefined) {
    lanternCache.m[pid] = G.s.players[pid].zones.battlefield.some((i) => {
      const x = G.s.cards[i];
      return x && !x.phasedOut && /Lands you control have "\{T\}: Add one mana of any color\."/.test((DB[x.def].faces[x.face || 0] || {}).oracle || '') && !abilitiesGone(x);
    });
  }
  return lanternCache.m[pid];
}
export function hasSubtype(inst, t) {
  if (everythingCounter(inst)) {
    if (isLand(inst) && LAND_TYPES.test(t)) return true;
    if (!isLand(inst) && isCreature(inst) && !/^(aura|equipment|vehicle|saga|class|case|room|food|treasure|clue)$/i.test(t) && !LAND_TYPES.test(t)) return true;
  }
  const parts = typeLine(inst).split('—');
  if (parts.length > 1 && new RegExp('\\b' + t + 's?\\b', 'i').test(parts.slice(1).join(' '))) return true;
  // changeling (intrinsic only, so lords can't loop back into themselves)
  if (!inst.faceDown && (isCreature(inst) || /\b(?:Kindred|Tribal)\b/.test(typeLine(inst).split('—')[0])) && (DB[inst.def].keywords.includes('changeling') || (inst.grants || []).includes('changeling') || (inst.eotGrants || []).includes('changeling') || (inst.allTypesTurn != null && G.s && inst.allTypesTurn === G.s.turn) || /(?:^|\n)Changeling\b/.test((DB[inst.def].faces[inst.face || 0] || {}).oracle || '')) &&
      !/^(aura|equipment|vehicle|saga|class|case|room|food|treasure|clue)$/i.test(t)) return true;
  // Don Andres ("…is a Pirate in addition to its other types"), Laughing Jasper Flint ("…are Mercenaries…"):
  // creatures you control but don't own gain a creature type
  if (G.s && inst.zone === 'battlefield' && inst.owner && inst.controller && inst.owner !== inst.controller && !inst.token && isCreature(inst)) {
    for (const iid of G.s.players[inst.controller].zones.battlefield) {
      const x = G.s.cards[iid];
      if (!x || x.phasedOut || abilitiesGone(x) || x === inst) continue;
      const m = (face(x).oracle || '').match(/(?:Each creature|Creatures) you control but don't own[^.\n]*?(?:is an?|are) ([A-Z][a-z]+) in addition to (?:its|their) other types/);
      const sing = (w) => String(w).toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');
      if (m && sing(m[1]) === sing(t)) return true;
    }
  }
  return false;
}
export const isLand = (i) => isType(i, 'Land');

export function isCreature(i) {
  if (!i) return false;
  if (i.faceDown) return true; // morph / manifest / disguise / cloak: a 2/2 creature
  if (i.bestowed && i.zone === 'battlefield') return false; // bestowed: an Aura until what it enchants leaves
  if (i.becameLand && i.zone === 'battlefield') return false; // Princess Yue as Moon
  if (i.impending && (i.counters || {}).time > 0) return false;
  // layer 4: Opalescence, March of the Machines, Song of the Dryads, Darksteel Mutation… can make it a creature or stop it being one
  const layered = (i.layerFx && i.layerFx.some((e) => e.types)) || (i.zone === 'battlefield' && globalLayerFx().some((g) => g.k === 'opal' || g.k === 'march'));
  if (layered) {
    if (/\bCreature\b/.test(typeLine(i).split('—')[0])) return true;
    if ((i.layerFx || []).some((e) => e.types && e.types.set)) return false;
  }
  const base = (face(i).typeLine || DB[i.def].typeLine).split('—')[0];
  if (/\bCreature\b/.test(base)) return true;
  if (i.animated) return true;
  if (G.s && i.crewedTurn === G.s.turn) return true; // crewed Vehicle / saddled? (crew only)
  if (i.stationCreature) return true;
  // Spacecraft: "It's an artifact creature at 8+." (charge counters)
  {
    const raw = face(i).oracle || '';
    const at = raw.match(/It's an artifact creature at (\d+)\+/i);
    if (at && ((i.counters || {}).charge || 0) >= +at[1] && face(i).power !== undefined && face(i).power !== null && face(i).power !== '') return true;
  }
  if (/\bVehicle\b/.test(face(i).typeLine || '') && /Living metal/i.test(face(i).oracle || '') && G.s && G.s.active === i.controller) return true;
  return false;
}
export const isPermanentCard = (d) => !/\b(Instant|Sorcery)\b/.test(d.faces[0].typeLine.split('—')[0]);

// ------------------------------------------------------------ the text that is "on" right now
// Levelers, Classes and Spacecraft only have the abilities of the level they've reached;
// a mutated creature has the abilities of every card in it.
export function sections(text, kind) {
  const ls = String(text || '').split('\n');
  const out = { base: [], parts: [] };
  let cur = null;
  for (const l of ls) {
    let m;
    if (kind === 'level' && (m = l.match(/^LEVEL (\d+)(?:-(\d+)|\+)/))) {
      cur = { min: +m[1], max: m[2] ? +m[2] : 999, lines: [], pt: null };
      out.parts.push(cur);
      continue;
    }
    if (kind === 'station' && (m = l.match(/^STATION (\d+)\+/))) {
      cur = { min: +m[1], max: 999, lines: [], pt: null };
      out.parts.push(cur);
      continue;
    }
    if (kind === 'class' && (m = l.match(/^((?:\{[^}]+\})+): Level (\d+)/))) {
      cur = { min: +m[2], max: 999, lines: [], pt: null, cost: m[1] };
      out.parts.push(cur);
      continue;
    }
    if (cur && /^\d+\/\d+$/.test(l.trim()) && !cur.pt) {
      const [p, t] = l.trim().split('/');
      cur.pt = { p: +p, t: +t };
      continue;
    }
    (cur ? cur.lines : out.base).push(l);
  }
  return out;
}

export function oracle(inst) {
  if (!inst || inst.faceDown) return '';
  const twin = readCache.on ? cacheTwin(inst) : null;
  if (twin) {
    const hit = readCache.oracle.get(twin);
    if (hit !== undefined) return hit;
    const v = oracleRaw(twin);
    readCache.oracle.set(twin, v);
    return v;
  }
  return oracleRaw(inst);
}
// "Max speed — …" abilities exist only while their controller's speed is 4
export function maxSpeedText(text, pid) {
  if (!/(?:^|\n)Max speed — /.test(text || '')) return text;
  const on = !!(G.s && pid && G.s.players[pid] && (G.s.players[pid].speed || 0) >= 4);
  return text.split('\n').map((l) => (/^Max speed — /.test(l) ? (on ? l.replace(/^Max speed — /, '') : null) : l)).filter((l) => l !== null).join('\n');
}
export const isRoomCard = (d) => !!d && d.faces && d.faces.length === 2 && /Room/.test(d.faces[0].typeLine || '') && /Room/.test(d.faces[1].typeLine || '');
// soulbond: what the pair gives each of its creatures ("each of those creatures has "…"")
export function pairGrantText(inst) {
  if (!inst || !inst.pairedWith || !G.s) return '';
  const mate = G.s.cards[inst.pairedWith];
  if (!mate || mate.zone !== 'battlefield' || mate.controller !== inst.controller || mate.pairedWith !== inst.iid) return '';
  const out = [];
  for (const x of [inst, mate]) {
    const fo = (DB[x.def].faces[x.face || 0] || DB[x.def].faces[0]).oracle || '';
    const gm = fo.match(/As long as [^\n]*? is paired with another creature, (?:each of those creatures has|both creatures have) "([^"]+)"/i);
    if (gm) out.push(gm[1]);
    // Wolfir Silverheart: "each of those creatures gets +4/+4" / Silverblade Paladin: "both creatures have double strike"
    else {
      const gs = fo.match(/As long as [^\n]*? is paired with another creature, (?:each of those creatures|both creatures) ((?:gets?|ha(?:s|ve)) [^"\n]+?)\.?(?:\n|$)/i);
      if (gs) out.push('This creature ' + gs[1].replace(/^get /i, 'gets ').replace(/^have /i, 'has ').replace(/ and have /i, ' and has ') + '.');
    }
  }
  return out.join('\n');
}
function oracleRaw(inst) {
  const f = face(inst);
  if (inst.becameTreasure) return inst.extraText || '';
  let text = f.oracle || '';
  // a Room on the battlefield has the abilities of its unlocked doors ("this door" → which one)
  if (inst.zone === 'battlefield' && inst.unlocked && isRoomCard(DB[inst.def])) {
    text = DB[inst.def].faces.map((x, k) => (inst.unlocked[k] ? (x.oracle || '').replace(/\([^)]*\)/g, '').replace(/\bthis door\b/gi, `door ${k + 1}`) : '')).filter((t) => t.trim()).join('\n');
  }
  // Spacecraft written as "2+ | {1}, {T}: …" instead of "STATION 2+" sections
  if (/(?:^|\n)Station\b/i.test(text) && /^\d+\+ \| /m.test(text)) text = text.replace(/^(\d+)\+ \| /gm, 'STATION $1+\n');
  if (/^STATION \d+\+ ?[|:—–-] ?\S/m.test(text)) text = text.replace(/^STATION (\d+)\+ ?[|:—–-] ?/gm, 'STATION $1+\n');
  if (/^LEVEL \d/m.test(text)) {
    const sec = sections(text, 'level');
    const lv = (inst.counters || {}).level || 0;
    text = [...sec.base, ...sec.parts.filter((p) => lv >= p.min && lv <= p.max).flatMap((p) => p.lines)].join('\n');
  } else if (/^((?:\{[^}]+\})+): Level \d/m.test(text)) {
    const sec = sections(text, 'class');
    const lv = inst.classLevel || 1;
    text = [...sec.base, ...sec.parts.filter((p) => lv >= p.min).flatMap((p) => p.lines)].join('\n');
  } else if (/^STATION \d+\+/m.test(text)) {
    const sec = sections(text, 'station');
    const ch = (inst.counters || {}).charge || 0;
    text = [...sec.base, ...sec.parts.filter((p) => ch >= p.min).flatMap((p) => p.lines)].join('\n');
  }
  if (inst.merged && inst.merged.length && G.s) {
    for (const iid of inst.merged) {
      const m = G.s.cards[iid];
      if (m) text += '\n' + (face(m).oracle || '');
    }
  }
  text = maxSpeedText(text, inst.controller || inst.owner);
  if (inst.extraText) text += '\n' + inst.extraText;
  // Koh, the Face Stealer: "Koh has all activated and triggered abilities of the last chosen card."
  if (inst.kohChosen && DB[inst.kohChosen] && inst.zone === 'battlefield') {
    const kd = DB[inst.kohChosen];
    const kn = kd.name.split(' // ')[0];
    const lines = ((kd.faces[0] || {}).oracle || '').replace(/\([^)]*\)/g, '').split('\n').map((l) => l.trim()).filter((l) => /^(?:[A-Z][\w' ]{1,30} — )?(?:When|Whenever|At)\b/.test(l) || /^[^"\n]*?(?:\{[^}]+\}|Pay [^:]+|Sacrifice [^:]+|Discard [^:]+|Exile [^:]+|Tap [^:]+)[^"\n:]*:/.test(l));
    const own = face(inst).name;
    if (lines.length) text += '\n' + lines.join('\n').split(kn).join(own).split(kn.split(',')[0]).join(own.split(',')[0]);
  }
  // soulbond: "As long as ~ is paired with another creature, each of those creatures has "…"" (both halves of the pair)
  if (inst.pairedWith && inst.zone === 'battlefield') { const pg = pairGrantText(inst); if (pg) text += '\n' + pg; }
  // Harold and Bob: "Enchanted Forest has '…'" — only while that Aura is still attached
  if (inst.grantedText && G.s && G.s.cards[inst.grantedBy] && G.s.cards[inst.grantedBy].zone === 'battlefield' && G.s.cards[inst.grantedBy].attachedTo === inst.iid) text += '\n' + inst.grantedText;
  if (inst.eotText) text += '\n' + inst.eotText; // "until end of turn, it gains \"…\"" (Trash the Town)
  for (const b of Object.values(inst.auraBuffs || {})) if (b.text) text += '\n' + b.text;
  // Locus of Enlightenment: "has each activated ability of the exiled cards used to craft it" (once each turn)
  if (inst.craftedFrom && /has each activated ability of the exiled cards used to craft it/i.test(text)) {
    for (const u of inst.craftedFrom) {
      const fd = (DB[u.def] || { faces: [] }).faces[u.face || 0];
      if (!fd) continue;
      const nm = fd.name;
      for (const l of (fd.oracle || '').split('\n')) {
        const line = l.replace(/\([^)]*\)/g, '').trim();
        if (!/^[^"]*(?:\{[^}]+\}|Sacrifice|Discard|Pay|Remove|Exile)[^"]*:/.test(line) || /^(?:Equip|Craft|Crew|Ninjutsu|Cycling|[+−-]?\d+:)/.test(line)) continue;
        text += '\n' + line.split(nm).join('this artifact') + (/once each turn/i.test(line) ? '' : ' Activate only once each turn.');
      }
    }
  }
  // Bootleggers' Stash: 'Lands you control have "{T}: Create a Treasure token."' (non-mana activated abilities; mana ones come from grantedManaText)
  if (inst.zone === 'battlefield' && G.s && /\bLand\b/.test(typeLine(inst).split('—')[0])) {
    for (const iid of G.s.players[inst.controller].zones.battlefield) {
      const src = G.s.cards[iid];
      if (!src || src.phasedOut || src.faceDown || abilitiesGone(src)) continue;
      for (const m of (face(src).oracle || '').matchAll(/(?:^|\n)Lands you control have "([^"]+)"/g)) if (/:/.test(m[1]) && !/: Add /.test(m[1])) text += '\n' + m[1].replace(/\bthis land\b/gi, '~');
    }
  }
  // Way of the Pyromancer and friends: "Planeswalkers you control have "[+1]: Add {R}.""
  if (inst.zone === 'battlefield' && G.s && /Planeswalker/.test(typeLine(inst).split('—')[0])) {
    for (const iid of G.s.players[inst.controller].zones.battlefield) {
      const src = G.s.cards[iid];
      if (!src || src.phasedOut || src.faceDown) continue;
      const raw = face(src).oracle || '';
      for (const m of raw.matchAll(/Planeswalkers you control have "([^"]+)"(?: and "([^"]+)")?/g)) {
        for (const ab of [m[1], m[2]].filter(Boolean)) text += '\n' + ab.replace(/^\[([+−-]?\d+|[+−-]?X)\]:/, '$1:').replace(/\bthis planeswalker\b/gi, '~');
      }
    }
  }
  // Folk Hero & co.: "Commander creatures you own have "…""
  if (inst.isCommander && inst.zone === 'battlefield' && G.s && /Creature/.test(typeLine(inst).split('—')[0])) {
    const owner = inst.owner || inst.controller;
    for (const iid of G.s.players[owner].zones.battlefield) {
      const src = G.s.cards[iid];
      if (!src || src.phasedOut || src.faceDown || src.iid === inst.iid) continue;
      const raw = face(src).oracle || '';
      for (const m of raw.matchAll(/Commander creatures you own have "([^"]+)"/g)) text += '\n' + m[1].replace(/\bthis creature\b/gi, '~');
    }
  }
  // Serra's Emissary: "As ~ enters, choose a card type. You and creatures you control have protection from the chosen type."
  if (inst.chosenCardType) text = text.replace(/protection from the chosen (?:card )?type/gi, `protection from ${inst.chosenCardType.toLowerCase()}s`);
  // Sieges: keep only the chosen bullet
  if (inst.chosenMode) {
    text = text.split('\n').map((l) => {
      const bm = l.match(/^• ([A-Z][a-z]+) — (.+)$/);
      if (!bm) return l;
      return bm[1] === inst.chosenMode ? bm[2] : null;
    }).filter((l) => l !== null).join('\n');
  } else if (/(?:^|\n)As [^,\n]+ enters(?: the battlefield)?, choose ([A-Z][a-z]+) or ([A-Z][a-z]+)\./.test(text)) {
    text = text.split('\n').filter((l) => !/^• [A-Z][a-z]+ — /.test(l)).join('\n'); // nothing chosen yet
  }
  // "As ~ enters, choose a creature type" (Herald's Horn, Vanquisher's Banner…): write the choice into the text
  if (inst.chosenType) {
    const T = inst.chosenType;
    text = text
      .replace(/\b(creature spells?|creatures?|creature cards?|permanents?|spells?|cards?)( you (?:control|cast))? of the chosen type/gi, `${T} $1$2`)
      .replace(/\bthe chosen type\b/gi, T);
  }
  return text;
}
setTextFn(oracle);

// "Flying, trample" lines and keywords from Scryfall's list, limited to the active text.
const KW_LINE = /^[A-Za-z][A-Za-z' -]*(?: \d+| \{[^}]+\}+| from [a-z ]+)?(?:, [A-Za-z][A-Za-z' -]*(?: \d+| \{[^}]+\}+| from [a-z ]+)?)*$/;
// keyword lookups in rules text are pure, so remember them (texts repeat a lot: tokens, copies)
const kwMemo = new Map();
function kwInText(text, kw) {
  const key = kw + '\u0000' + text;
  let v = kwMemo.get(key);
  if (v === undefined) {
    if (kwMemo.size > 20000) kwMemo.clear();
    v = kwInTextRaw(text, kw);
    kwMemo.set(key, v);
  }
  return v;
}
function kwInTextRaw(text, kw) {
  for (const l of text.split('\n')) {
    const line = l.replace(/\([^)]*\)/g, '').trim();
    if (!KW_LINE.test(line)) continue;
    for (const part of line.toLowerCase().split(/, /)) if (part === kw || part.startsWith(kw + ' ')) return true;
  }
  return false;
}

// Keywords a permanent has that aren't printed on it (from Auras, Equipment, anthems, counters, spells, its own "as long as …"),
// and printed ones it has lost — for the badges on the card
const KW_SHOW = ['flying', 'first strike', 'double strike', 'deathtouch', 'lifelink', 'trample', 'vigilance', 'haste', 'reach', 'menace', 'hexproof', 'indestructible',
  'shroud', 'defender', 'infect', 'wither', 'prowess', 'skulk', 'fear', 'intimidate', 'shadow', 'horsemanship', 'decayed', 'ward', 'flanking', 'banding', 'changeling'];
export function keywordChanges(inst) {
  if (!inst || inst.faceDown || inst.zone !== 'battlefield') return { gained: [], lost: [] };
  const printed = ((DB[inst.def].faces[inst.face || 0] || DB[inst.def].faces[0]).oracle || '');
  const gained = [];
  const lost = [];
  for (const kw of KW_SHOW) {
    const has = hasKw(inst, kw);
    const onCard = kwInText(printed, kw);
    if (has && !onCard) gained.push(kw);
    else if (!has && onCard) lost.push(kw);
  }
  // "protection from red", "hexproof from black", "landwalk"
  for (const g of grantsOf(inst)) {
    const x = String(g).toLowerCase();
    if (/^(?:protection|hexproof) from |walk$/.test(x) && !gained.includes(x) && !kwInText(printed, x)) gained.push(x);
  }
  return { gained, lost };
}

export function grantsOf(inst) {
  const g = [...(inst.grants || []), ...(inst.eotGrants || [])];
  for (const b of Object.values(inst.auraBuffs || {})) {
    g.push(...b.grants);
    for (const c of b.conds || []) if (auraCondOk(inst, c)) g.push(...c.kws);
  }
  if (inst.zone === 'battlefield') g.push(...staticMods(inst, helpers).grants);
  return g;
}

export function hasKw(inst, kw) {
  if (!inst) return false;
  kw = kw.toLowerCase();
  if (kw === 'indestructible' && G.s && inst.loseIndestructibleTurn === G.s.turn) return false; // Exterminatus, Smite the Deathless
  if (readCache.on) {
    const twin = cacheTwin(inst);
    if (twin && twin.grants === inst.grants && twin.eotGrants === inst.eotGrants && twin.auraBuffs === inst.auraBuffs) {
      let m = readCache.kw;
      if (!m) m = readCache.kw = new WeakMap();
      let per = m.get(twin);
      if (!per) m.set(twin, (per = new Map()));
      let v = per.get(kw);
      if (v === undefined) per.set(kw, (v = hasKwRaw(inst, kw)));
      return v;
    }
  }
  return hasKwRaw(inst, kw);
}
// Keyword counters (Ikoria and later): a deathtouch counter gives deathtouch, and so on
const KEYWORD_COUNTERS = new Set(['flying', 'first strike', 'double strike', 'deathtouch', 'decayed', 'hexproof', 'indestructible', 'lifelink', 'menace', 'reach', 'shadow', 'trample', 'vigilance', 'haste']);
function hasKwRaw(inst, kw) {
  const gone = lostAbilitiesAt(inst);
  if (KEYWORD_COUNTERS.has(kw) && ((inst.counters || {})[kw] || 0) > 0 && !gone) return true;
  // keywords given by the same effect that took the rest away (Darksteel Mutation's indestructible, Deep Freeze's defender)
  for (const e of inst.layerFx || []) if ((e.grants || []).includes(kw)) return true;
  if (gone && !inst.lostAbilities) {
    // Humility / Dress Down / an Aura: abilities granted after it still apply
    const is = (g) => g === kw || String(g).startsWith(kw + ' ');
    if ((inst.eotGrants || []).some(is)) return true;
    for (const b of Object.values(inst.auraBuffs || {})) if (stampOf(b) > gone && (b.grants || []).some(is)) return true;
    if (inst.zone === 'battlefield' && G.s) for (const x of staticMods(inst, helpers).timed || []) if (x.ts > gone && is(x.kw)) return true;
    return false;
  }
  if (inst.lostAbilities) {
    // Layer 6 by timestamp: abilities granted after it lost its abilities still apply
    const is = (g) => g === kw || String(g).startsWith(kw + ' ');
    // an Aura that says "it has defender and loses all other abilities" still grants its own keywords
    if (String(inst.lostAbilities).startsWith('aura:')) {
      const b = (inst.auraBuffs || {})[inst.lostAbilities.slice(5)];
      if (b && (b.grants || []).some(is)) return true;
    }
    const lt = inst.lostAt || 0;
    if ((inst.grants || []).slice(inst.lostGrantsN || 0).some(is)) return true;
    if ((inst.eotGrants || []).slice(inst.lostEotN || 0).some(is)) return true;
    for (const b of Object.values(inst.auraBuffs || {})) if (stampOf(b) > lt && (b.grants || []).some(is)) return true;
    if (inst.zone === 'battlefield' && G.s) for (const x of staticMods(inst, helpers).timed || []) if (x.ts > lt && is(x.kw)) return true;
    return false;
  }
  for (const g of grantsOf(inst)) if (g === kw || g.startsWith(kw + ' ')) return true;
  if (inst.faceDown) return false;
  const text = oracle(inst);
  const d = DB[inst.def];
  if (d.keywords.includes(kw) && new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) return true;
  return kwInText(text, kw);
}

// "Annihilator 2", "Bushido 1", "Toxic 3" → the number (summing every instance)
export function kwNum(inst, name) {
  if (!inst || inst.faceDown) return 0;
  let n = 0;
  const re = new RegExp('(?:^|\\n|, )' + name + ' (\\d+|X)\\b', 'gi');
  for (const m of oracle(inst).matchAll(re)) n += m[1] === 'X' ? inst.xPaid || 0 : +m[1];
  for (const g of grantsOf(inst)) {
    const m = g.match(new RegExp('^' + name.toLowerCase() + ' (\\d+)'));
    if (m) n += +m[1];
  }
  return n;
}
// "Ward {2}", "Echo {2}{R}", "Flashback—Sacrifice a creature." → the cost text
export function kwCost(inst, name, text) {
  const t = text || oracle(inst);
  const m = t.match(new RegExp('(?:^|\\n)' + name + '(?: (\\d+))?(?: ((?:\\{[^}]+\\})+))?(?:—([^\\n(]+))?', 'i'));
  if (!m) return null;
  return { n: m[1] ? +m[1] : 0, mana: m[2] || '', other: (m[3] || '').trim().replace(/\.$/, '') };
}

export function colorsOf(inst) {
  if (inst.faceDown) return [];
  let cols = /\bDevoid\b/.test(face(inst).oracle || '') ? [] : DB[inst.def].colors || [];
  for (const f of colorFx(inst)) {
    if (f.c.set) cols = [...f.c.set];
    if (f.c.add) cols = [...new Set([...cols, ...f.c.add])];
  }
  return cols;
}

// ------------------------------------------------------------ protection
export function protections(inst) {
  const out = [];
  for (const m of oracle(inst).matchAll(/[Pp]rotection from ([a-z ,]+?)(?:\.|\n|$)/g))
    out.push(...m[1].split(/, and from | and from |, from | from /).map((x) => x.trim()));
  for (const g of grantsOf(inst)) {
    const m = g.match(/^protection from (.+)$/);
    if (m) out.push(m[1]);
  }
  return out;
}

export function isProtectedFrom(inst, src) {
  if (!src) return false;
  return protectedByList(protections(inst), src);
}
// Serra's Emissary: "You … have protection from the chosen type"
export function playerProtectedFrom(pid, src) {
  if (!src || !G.s) return false;
  const list = playerFlag(pid, 'protection');
  return !!(list && list.length && protectedByList(list, src));
}
function protectedByList(list, src) {
  for (const p of list) {
    if (p === 'everything') return true;
    const cols = colorsOf(src);
    if (COLOR_WORDS[p.replace(/s$/, '')] && cols.includes(COLOR_WORDS[p.replace(/s$/, '')])) return true;
    if (p === 'each color' || p === 'all colors') if (cols.length) return true;
    if (p === 'multicolored' && cols.length > 1) return true;
    if (p === 'monocolored' && cols.length === 1) return true;
    if (p === 'colorless' && !cols.length && !isLand(src)) return true;
    if (/^creatures?$/.test(p) && isCreature(src)) return true;
    if (/^artifacts?$/.test(p) && isType(src, 'Artifact')) return true;
    if (/^enchantments?$/.test(p) && isType(src, 'Enchantment')) return true;
    if (/^instants?$/.test(p) && isType(src, 'Instant')) return true;
    if (/^sorcer(?:y|ies)$/.test(p) && isType(src, 'Sorcery')) return true;
    if (/^planeswalkers?$/.test(p) && isType(src, 'Planeswalker')) return true;
    if (/^(land|battle|kindred)s?$/.test(p) && isType(src, p.replace(/s$/, '')[0].toUpperCase() + p.replace(/s$/, '').slice(1))) return true;
    const sub = p.replace(/s$/, '');
    if (/^[a-z]+$/.test(sub) && !COLOR_WORDS[sub] && hasSubtype(src, sub)) return true;
  }
  return false;
}

// ------------------------------------------------------------ power / toughness
function num(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Characteristic-defining abilities: "~'s power and toughness are each equal to the number of …"
function cda(inst) {
  const nm = DB[inst.def].faces[inst.face || 0].name;
  const short = nm.split(',')[0];
  const first = (nm.match(/^([A-Z][\w'-]{2,}) (?:of|the|from|and)\b/) || [])[1];
  let o = (face(inst).oracle || '').split(nm).join('~');
  if (short !== nm && short.length > 2) o = o.split(short + "'s").join("~'s");
  if (first) o = o.split(first + "'s").join("~'s");
  o = o.replace(/\bthis (?:creature|vehicle|artifact)'s\b/gi, "~'s");
  let m;
  if ((m = o.match(/~'s power and toughness are each equal to (?:the number of |your )?([^.]+?)(?: plus (\d+))?\./i))) {
    const v = countPhrase(inst.controller, m[1], helpers, inst.iid);
    if (v !== null) return { p: v + (+m[2] || 0), t: v + (+m[2] || 0) };
  }
  if ((m = o.match(/~'s power is equal to (?:the (?:total )?number of |your )?([^.]+?)\./i))) {
    const v = countPhrase(inst.controller, m[1], helpers, inst.iid);
    if (v !== null) return { p: v, t: null };
  }
  if ((m = o.match(/~'s toughness is equal to (?:the number of |your )?([^.]+?)\./i))) {
    const v = countPhrase(inst.controller, m[1], helpers, inst.iid);
    if (v !== null) return { p: null, t: v };
  }
  return null;
}

// an effect's timestamp, given the first time the game sees it (effects are seen as they start: the board is redrawn after each action)
export function stampOf(o) {
  if (!o) return 0;
  if (!o.ts) o.ts = nextStamp();
  return o.ts;
}
export function basePT(inst) {
  if (inst.faceDown) return { p: 2, t: 2 };
  // Layer 7b: effects that set base power and toughness — the latest one wins
  {
    let best = null;
    const consider = (v, ts) => {
      if (!best || ts >= best.ts) best = { v, ts };
    };
    if (inst.setPT) consider(inst.setPT, stampOf(inst.setPT));
    for (const b of Object.values(inst.auraBuffs || {})) if (b.base) consider(b.base, stampOf(b));
    if (inst.animated && inst.animated.p !== undefined && (!/Creature/.test((face(inst).typeLine || '').split('—')[0]) || inst.animated.setsPT)) consider({ p: inst.animated.p, t: inst.animated.t }, stampOf(inst.animated));
    for (const e of inst.layerFx || []) if (e.base) consider(e.base, e.ts);
    if (inst.zone === 'battlefield' && G.s) {
      const fx = globalLayerFx();
      if (fx.length) {
        const tl = typeLine(inst);
        const mv = DB[inst.def].cmc || 0;
        for (const g of fx) {
          if (g.k === 'humility' && /\bCreature\b/.test(tl.split('—')[0])) consider({ p: +g.m[1], t: +g.m[2] }, g.ts);
          else if (g.k === 'opal' && g.src.iid !== inst.iid && /\bEnchantment\b/.test(printedTypes(inst).split('—')[0]) && !/\bAura\b/.test(tl)) consider({ p: mv, t: mv }, g.ts);
          else if (g.k === 'march' && /\bArtifact\b/.test(printedTypes(inst).split('—')[0]) && !/\bCreature\b/.test(printedTypes(inst).split('—')[0])) consider({ p: mv, t: mv }, g.ts);
        }
      }
    }
    if (best) return { p: best.v.p, t: best.v.t };
  }
  if (inst.proto) return { ...inst.proto };
  const f = face(inst);
  const text = f.oracle || '';
  // leveler / spacecraft sections carry their own P/T
  if (/^LEVEL \d/m.test(text) || /^STATION \d+\+/m.test(text)) {
    const lev = /^LEVEL/m.test(text);
    const sec = sections(text, lev ? 'level' : 'station');
    const v = lev ? (inst.counters || {}).level || 0 : (inst.counters || {}).charge || 0;
    const hit = sec.parts.filter((p) => v >= p.min && v <= p.max && p.pt).pop();
    if (hit) return { ...hit.pt };
  }
  let p = num(f.power);
  let t = num(f.toughness);
  if ((p === null || t === null) && (f.power !== undefined || f.toughness !== undefined)) {
    const c = G.s ? cda(inst) : null;
    if (c) {
      if (p === null && c.p !== null) p = c.p;
      if (t === null && c.t !== null) t = c.t;
    }
    const plus = (v) => {
      const m = String(v || '').match(/^\*\+(\d+)$/);
      return m ? +m[1] : 0;
    };
    if (p === null) p = (c && c.p !== null ? c.p : 1) + plus(f.power);
    if (t === null) t = (c && c.t !== null ? c.t : 1) + plus(f.toughness);
  }
  return { p: p || 0, t: t || 0 };
}

const counterPT = (c) => {
  let p = 0;
  let t = 0;
  for (const [k, v] of Object.entries(c || {})) {
    const m = k.match(/^([+-]\d+)\/([+-]\d+)$/);
    if (m) {
      p += +m[1] * v;
      t += +m[2] * v;
    }
  }
  return { p, t };
};
// Auras/Equipment buffs; "gets +1/+1 for each artifact you control" is counted live (Adaptive Omnitool, Lashwrithe)
// "As long as enchanted creature is red, it gets +1/+1 and has double strike"
const COLOR_CODE = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
export function auraCondOk(inst, c) {
  if (c.color) return colorsOf(inst).includes(COLOR_CODE[c.color]);
  if (c.sub) return hasSubtype(inst, c.sub);
  return false;
}
const auraSum = (inst, k) =>
  Object.entries(inst.auraBuffs || {}).reduce((a, [src, b]) => {
    for (const c of b.conds || []) if (auraCondOk(inst, c)) a += c[k] || 0;
    if (!b.each) return a + b[k];
    const sc = G.s && G.s.cards[src];
    const v = sc ? countPhrase(sc.controller, b.each, helpers, sc.iid) || 0 : 0;
    const v2 = sc && b.each2 ? countPhrase(sc.controller, b.each2.each, helpers, sc.iid) || 0 : 0;
    return a + (k === 'p' ? b.perP : b.perT) * v + (b.each2 ? (k === 'p' ? b.each2.perP : b.each2.perT) * v2 : 0);
  }, 0) + (inst.eot ? inst.eot[k] : 0);

// Layer 7: base (7a CDAs, 7b setting effects) + adjustments (7c: counters, pumps, Auras, anthems), then 7d switching
function rawPower(inst) {
  const st = inst.zone === 'battlefield' ? staticMods(inst, helpers) : { p: 0 };
  return basePT(inst).p + counterPT(inst.counters).p + (inst.ptMod ? inst.ptMod.p : 0) + auraSum(inst, 'p') + st.p;
}
function rawToughness(inst) {
  const st = inst.zone === 'battlefield' ? staticMods(inst, helpers) : { t: 0 };
  return basePT(inst).t + counterPT(inst.counters).t + (inst.ptMod ? inst.ptMod.t : 0) + auraSum(inst, 't') + st.t;
}
export function power(inst) {
  return inst.switchPT && inst.zone === 'battlefield' ? rawToughness(inst) : rawPower(inst);
}
export function toughness(inst) {
  return inst.switchPT && inst.zone === 'battlefield' ? rawPower(inst) : rawToughness(inst);
}

export function cardValue(inst) {
  const d = DB[inst.def];
  let v = d.cmc || 0;
  if (isCreature(inst)) {
    v += (power(inst) + toughness(inst)) / 2;
    for (const k of ['flying', 'trample', 'deathtouch', 'lifelink', 'double strike', 'first strike', 'hexproof', 'indestructible', 'menace', 'infect'])
      if (hasKw(inst, k)) v += 1;
  }
  if (isType(inst, 'Planeswalker')) v += 3 + ((inst.counters || {}).loyalty || 0) / 2;
  if (inst.isCommander) v += 4;
  if (inst.token && !isCreature(inst)) v -= 1;
  return v;
}

// ------------------------------------------------------------ mana
// Returns {generic, pips:[[colors...]], x}
export function parseCost(cost) {
  const out = { generic: 0, pips: [], x: 0, snow: 0 };
  for (const m of String(cost || '').matchAll(/\{([^}]+)\}/g)) {
    const s = m[1].toUpperCase();
    if (/^\d+$/.test(s)) out.generic += parseInt(s, 10);
    else if (s === 'X') out.x++;
    else if (s === 'C') out.pips.push(['C']);
    else if (COLORS.includes(s)) out.pips.push([s]);
    else if (s.includes('/')) {
      const parts = s.split('/');
      if (parts.includes('P')) out.pips.push(parts.filter((p) => p !== 'P')); // pay with mana; ignore the life option
      else if (parts.some((p) => /^\d$/.test(p))) out.pips.push([...parts.filter((p) => !/^\d$/.test(p)), '2GEN']);
      else out.pips.push(parts);
    } else if (s === 'S') out.pips.push(['ANY']);
  }
  return out;
}

export function manaValueOf(cost) {
  const c = parseCost(cost);
  return c.generic + c.pips.length;
}

// What a permanent can tap for: {colors, amount, sac?} or null.
// Pain lands, Talismans, horizon lands, Mana Confluence: some of the colors cost 1 life to make.
// Forsaken Monument: "Whenever you tap a permanent for {C}, add an additional {C}." / Ultima: "Whenever you tap a land for {C}, …"
function withExtraC(inst, r) {
  if (G.s && inst.zone === 'battlefield' && (r.colors || []).length === 1 && r.colors[0] === 'C') {
    const land = isLand(inst);
    const extra = G.s.players[inst.controller].zones.battlefield.filter((i) => { const x = G.s.cards[i]; if (!x || x.phasedOut || abilitiesGone(x)) return false; const o = oracle(x); return /Whenever you tap a permanent for \{C\}, add an additional \{C\}/i.test(o) || (land && /Whenever you tap a land for \{C\}, add an additional \{C\}/i.test(o)); }).length;
    if (extra) r = { ...r, amount: (r.amount || 1) + extra, ...(r.each ? { each: [...r.each, ...Array(extra).fill('C')] } : {}), ...(r.alts ? { alts: r.alts.map((a) => ({ ...a, amount: a.amount + extra })) } : {}) };
  }
  return r;
}
// creatures that can be tapped to pay a "Tap an untapped creature you control" cost — idle ones first
// (summoning-sick, no mana ability, not attacking, smallest)
export function tapFodder(pid, kind, exclude = []) {
  if (!G.s || !G.s.players[pid]) return [];
  const k = (kind || 'creature').toLowerCase();
  const sub = /creature$/.test(k) ? null : kind;
  const pool = G.s.players[pid].zones.battlefield.map((i) => G.s.cards[i]).filter((x) => x && !x.tapped && !x.phasedOut && isCreature(x) && !exclude.includes(x.iid) && (!sub || hasSubtype(x, sub)) && (!/legendary/.test(k) || /\bLegendary\b/.test(typeLine(x))));
  const busy = (x) => (x.attacking || x.blocking ? 4 : 0) + (manaAbilityRaw(x) ? 2 : 0) + (x.sick && !hasKw(x, 'haste') ? 0 : 1);
  return pool.sort((a, b) => busy(a) - busy(b) || power(a) - power(b));
}
export function manaAbility(inst) {
  if (inst.becameLand && inst.zone === 'battlefield') return inst.tapped || inst.phasedOut ? null : withExtraC(inst, { colors: ['C'], amount: 1 });
  if (blighted(inst)) return inst.tapped || inst.phasedOut ? null : withExtraC(inst, { colors: ['C'], amount: 1 });
  // an effect that gave it a mana ability (Imprisoned in the Moon: "{T}: Add {C}")
  for (const e of inst.layerFx || []) if (e.mana) return isCreature(inst) && inst.sick && !hasKw(inst, 'haste') ? null : { colors: e.mana, amount: 1 };
  // it lost all abilities: no mana abilities of its own (Vraska's Treasure keeps the one it was given) — but a land with a
  // basic land type taps for that color (Blood Moon's Mountains, Song of the Dryads' Forest)
  if ((inst.lostAbilities && !inst.becameTreasure) || (!inst.becameTreasure && abilitiesGone(inst)) || (inst.layerFx || []).some((e) => e.types && e.types.set)) {
    const tl = typeLine(inst);
    if (/\bLand\b/.test(tl.split('—')[0])) {
      const cols = Object.entries(BASIC_COLOR).filter(([k]) => new RegExp('\\b' + k + '\\b').test(tl.split('—')[1] || '')).map(([, v]) => v);
      if (cols.length && (abilitiesGone(inst) || (inst.layerFx || []).some((e) => e.types && e.types.set))) return { colors: cols, amount: 1 };
    }
    if (inst.lostAbilities && !inst.becameTreasure) return null;
    if (abilitiesGone(inst)) return null;
  }
  // Loot, the Pathfinder: "Exhaust — {G}, {T}: Add three mana of any one color." — pay {G} from the pool, once per game, by hand
  {
    const xm = oracle(inst).match(/(?:^|\n)Exhaust\s*[—-]\s*\{([WUBRG])\}, \{T\}: Add (two|three|four|five) mana of any one color\./);
    if (xm) {
      const key = 'mana:' + xm[0].trim();
      if (inst.tapped || inst.phasedOut || (inst.usedAbilities && inst.usedAbilities[key] === 'ever') || (isCreature(inst) && inst.sick && !hasKw(inst, 'haste'))) return null;
      return { colors: ['W', 'U', 'B', 'R', 'G'], amount: { two: 2, three: 3, four: 4, five: 5 }[xm[2]], oneColor: true, actColor: xm[1], exhaustKey: key, manualOnly: true };
    }
  }
  // Springleaf Drum: "{T}, Tap an untapped creature you control: Add one mana of any color."
  {
    const dm = oracle(inst).match(/(?:^|\n)\{T\}, Tap an untapped ([a-z ]*?creature|[A-Z][\w-]+) you control: Add (one mana of any color|\{[WUBRGC]\})\./);
    if (dm && !manaAbilityRaw(inst)) {
      if (inst.tapped || inst.phasedOut || (isCreature(inst) && inst.sick && !hasKw(inst, 'haste')) || !tapFodder(inst.controller, dm[1], [inst.iid]).length) return null;
      return withExtraC(inst, { colors: /any color/.test(dm[2]) ? ['W', 'U', 'B', 'R', 'G'] : [dm[2][1]], amount: 1, tapOther: dm[1] });
    }
  }
  let r = manaAbilityRaw(inst);
  // Haven of the Spirit Dragon: "{T}: Add {C}." plus "{T}: Add one mana of any color. Spend this mana only to cast a Dragon creature spell."
  if (r && !r.alts) {
    const o1 = oracle(inst);
    const rm = /(?:^|\n)\{T\}: Add \{C\}\.(?:\n|$)/.test(o1) && o1.match(/(?:^|\n)\{T\}: Add one mana of any color\. Spend this mana only to cast (?:an? )?([A-Z][\w-]+) (?:creature )?spells?\./);
    if (rm) r = { colors: ['C'], amount: 1, alts: [{ colors: ['C', 'W', 'U', 'B', 'R', 'G'], amount: 1, onlyFor: rm[1] }] };
  }
  // Aether Hub, Servant of the Conduit: "{T}, Pay {E}: Add one mana of any color." — only with energy to spend
  {
    const o0 = oracle(inst);
    const em = o0.match(/\{T\}, Pay ((?:\{E\})+): Add ([^.\n]+)\./);
    if (em && !inst.tapped && !inst.phasedOut && !(isCreature(inst) && inst.sick && !hasKw(inst, 'haste'))) {
      const need = em[1].match(/\{E\}/g).length;
      const have = G.s && G.s.players[inst.controller] ? G.s.players[inst.controller].counters.energy || 0 : 0;
      const symsOf = (t) => (/mana of any color/i.test(t) ? ['W', 'U', 'B', 'R', 'G'] : (t.match(/\{[WUBRGC]\}/g) || []).map((x) => x[1]));
      const free = new Set();
      for (const fm of o0.matchAll(/(?:^|\n)\{T\}: Add ([^.\n]+)\./g)) symsOf(fm[1]).forEach((x) => free.add(x));
      const eCols = symsOf(em[2]);
      if (have < need) {
        // no energy: only what its free ability makes
        if (!free.size) return null;
        r = r ? { ...r, colors: (r.colors || []).filter((x) => free.has(x)) } : { colors: [...free], amount: 1 };
        if (!r.colors.length) r = { ...r, colors: [...free] };
      } else {
        const all = [...new Set([...free, ...eCols])];
        r = { ...(r || { amount: 1 }), colors: all, amount: 1, energy: eCols.filter((x) => !free.has(x)), energyNeed: need };
      }
    }
  }
  // Chromatic Lantern: 'Lands you control have "{T}: Add one mana of any color."'
  if (isLand(inst) && inst.zone === 'battlefield' && !inst.tapped && !inst.phasedOut && landsAnyColor(inst.controller)) r = { ...(r || { amount: 1 }), colors: [...new Set([...((r && r.colors) || []), 'W', 'U', 'B', 'R', 'G'])] };
  // Omo: a land with an everything counter is every basic land type too
  if (everythingCounter(inst) && isLand(inst) && !inst.tapped) r = { ...(r || { amount: 1 }), colors: [...new Set([...((r && r.colors) || []), 'W', 'U', 'B', 'R', 'G'])] };
  if (!r) return r;
  r = withExtraC(inst, r);
  // Goldspan Dragon: "Treasures you control have "{T}, Sacrifice this artifact: Add two mana of any one color.""
  if (r.sac && G.s && inst.zone === 'battlefield' && hasSubtype(inst, 'Treasure') && G.s.players[inst.controller].zones.battlefield.some((i) => {
    const x = G.s.cards[i];
    return x && !x.phasedOut && !abilitiesGone(x) && /Treasures you control have "\{T\}, Sacrifice this artifact: Add two mana of any one color\."/i.test(oracle(x));
  })) r = { ...r, colors: ['W', 'U', 'B', 'R', 'G'], amount: 2 };
  // Utopia Sprawl, Wild Growth, Fertile Ground, Wolfwillow Haven: "Whenever enchanted land is tapped for mana, its controller adds an additional …"
  if (G.s && isLand(inst)) {
    for (const a of Object.values(G.s.cards)) {
      if (a.attachedTo !== inst.iid || a.zone !== 'battlefield') continue;
      const ao = oracle(a);
      const am = ao.match(/Whenever enchanted (?:land|[A-Z]\w+) is tapped for mana, its controller adds an additional ([^.]+?)( \(in addition to the mana the land produces\))?(?: during your turn)?\./i)
        || ao.match(/Whenever enchanted (?:land|[A-Z]\w+) is tapped for mana, its controller adds an additional (.+?)\./i);
      if (!am) continue;
      if (/during your turn/i.test(ao) && G.s.active !== inst.controller) continue;
      let extra;
      if (/one mana of any color/i.test(am[1])) extra = ['W', 'U', 'B', 'R', 'G'];
      else if (/one mana of the chosen color/i.test(am[1])) extra = a.chosenColor ? [a.chosenColor] : ['W', 'U', 'B', 'R', 'G'];
      else extra = (am[1].match(/\{([WUBRGC])\}/g) || []).map((x) => x[1]);
      if (!extra.length) continue;
      const fixed = r.each && extra.length === 1 ? [...r.each, extra[0]] : !r.each && (r.colors || []).length === 1 && extra.length === 1 ? [r.colors[0], extra[0]] : null;
      r = fixed ? { ...r, amount: (r.amount || 1) + 1, each: fixed, colors: [...new Set(fixed)] }
        : { ...r, amount: (r.amount || 1) + 1, each: undefined, colors: [...new Set([...(r.colors || []), ...extra])] };
    }
  }
  // Lavaleaper, Heartbeat of Spring, Mana Flare, Zendikar Resurgent, Mirari's Wake, Vorinclex, Crypt Ghast, Nissa, Gauntlet of
  // Power, Caged Sun, Mana Reflection: extra mana whenever a land (or permanent) is tapped for mana
  if (G.s && inst.zone === 'battlefield' && r.amount) {
    const isBasic = /\bBasic\b/.test(typeLine(inst));
    const land = isLand(inst);
    const same = (r_, k = 1) => {
      // k more of the same mana the permanent makes
      if (r_.each && r_.each.length) return { ...r_, amount: r_.each.length + k, each: [...r_.each, ...Array(k).fill(r_.each[0])] };
      if ((r_.colors || []).length === 1 && (r_.amount || 1) === 1) return { ...r_, amount: 1 + k, each: Array(1 + k).fill(r_.colors[0]) };
      return { ...r_, amount: (r_.amount || 1) + k };
    };
    const addColor = (r_, col) => {
      const base = r_.each || ((r_.colors || []).length === 1 ? Array(r_.amount || 1).fill(r_.colors[0]) : null);
      return base ? { ...r_, amount: base.length + 1, each: [...base, col], colors: [...new Set([...base, col])] } : { ...r_, amount: (r_.amount || 1) + 1, colors: [...new Set([...(r_.colors || []), col])], each: undefined };
    };
    let doubles = 0;
    for (const i of seats().flatMap((k) => G.s.players[k].zones.battlefield)) {
      const x = G.s.cards[i];
      if (!x || x.phasedOut) continue;
      const xr = DB[x.def].faces[x.face || 0].oracle || DB[x.def].faces[0].oracle || '';
      if (!/(?:taps?|tapped) an? [^.]*?for mana|tap a permanent for mana|is tapped for mana|ability causes you to add/i.test(xr) || abilitiesGone(x)) continue; // cheap check on the printed text first
      const xo = oracle(x);
      const mine = x.controller === inst.controller;
      if (land && isBasic && /Whenever a player taps a basic land for mana, that player adds one mana of any type that land produced/i.test(xo)) r = same(r);
      if (land && /Whenever a player taps a land for mana, that player adds one mana of any type that land produced/i.test(xo)) r = same(r);
      if (land && mine && /Whenever you tap a land for mana, add one mana of any type that land produced/i.test(xo)) r = same(r);
      let tm;
      if (land && mine && (tm = xo.match(/Whenever you tap an? (Plains|Island|Swamp|Mountain|Forest) for mana, add an additional \{([WUBRG])\}/i)) && hasSubtype(inst, tm[1])) r = addColor(r, tm[2].toUpperCase());
      if (land && isBasic && x.chosenColor && /Whenever a basic land is tapped for mana of the chosen color, its controller adds an additional one mana of that color/i.test(xo) && (r.colors || []).includes(x.chosenColor)) r = addColor(r, x.chosenColor);
      if (land && mine && x.chosenColor && /Whenever a land's ability causes you to add one or more mana of the chosen color, add an additional one mana of that color/i.test(xo) && (r.colors || []).includes(x.chosenColor)) r = addColor(r, x.chosenColor);
      if (mine && /If you tap a permanent for mana, it produces twice as much of that mana instead/i.test(xo)) doubles++;
    }
    // Molten Tide / High Tide: until end of turn
    for (const b of G.s.eotLandBonus || []) if (land && b.turn === G.s.turn && (!b.pid || b.pid === inst.controller) && hasSubtype(inst, b.type)) r = addColor(r, b.col);
    if (doubles) r = same(r, (r.amount || 1) * (2 ** doubles - 1));
  }
  const o = oracle(inst);
  const painful = new Set();
  const symsOf = (t) => (/one mana of any color/i.test(t) ? ['W', 'U', 'B', 'R', 'G'] : (t.match(/\{[WUBRGC]\}/g) || []).map((x) => x[1]));
  for (const m of o.matchAll(/\{T\}: Add ([^.\n]+)\. [^.\n]*?deals 1 damage to you/g)) symsOf(m[1]).forEach((x) => painful.add(x));
  for (const m of o.matchAll(/\{T\}, Pay 1 life: Add ([^.\n]+)\./g)) symsOf(m[1]).forEach((x) => painful.add(x));
  if (!painful.size) return r;
  return { ...r, pain: (r.colors || []).filter((x) => painful.has(x)) };
}
// Command Tower, Arcane Signet, Commander's Sphere: "any color in your commander's color identity"
function commanderIdentity(pid) {
  const cols = new Set();
  if (!G.s) return ['W', 'U', 'B', 'R', 'G'];
  for (const c of Object.values(G.s.cards)) if (c.isCommander && c.owner === pid) for (const x of (DB[c.def].ci && DB[c.def].ci.length ? DB[c.def].ci : DB[c.def].colors) || []) cols.add(x);
  return ['W', 'U', 'B', 'R', 'G'].filter((x) => cols.has(x));
}
// Mana abilities other permanents give this one: "Creatures you control have "{T}: Add {G}."" (Citanul Hierophants),
// "Enchanted land has "{T}: Add one mana of any color."" (Abundant Growth), "All Slivers have …", "Equipped creature … has …"
function grantedManaText(inst) {
  if (!G.s || inst.zone !== 'battlefield') return '';
  const out = [];
  const sing = (w) => w.replace(/ves$/, 'f').replace(/ies$/, 'y').replace(/(?<!s)s$/, '');
  const fits = (words) => words.every((w) => {
    if (!w) return true;
    if (/^(?:permanents?)$/.test(w)) return true;
    if (/^creatures?$/.test(w)) return isCreature(inst);
    if (/^lands?$/.test(w)) return isLand(inst);
    if (/^artifacts?$/.test(w)) return isType(inst, 'Artifact');
    if (/^basic$/.test(w)) return /\bBasic\b/.test(typeLine(inst));
    if (/^tokens?$/.test(w)) return !!inst.token;
    if (/^nontoken$/.test(w)) return !inst.token;
    return hasSubtype(inst, w[0].toUpperCase() + w.slice(1)) || hasSubtype(inst, sing(w[0].toUpperCase() + w.slice(1)));
  });
  for (const pid of seats()) for (const i of G.s.players[pid].zones.battlefield) {
    const x = G.s.cards[i];
    if (!x || x.phasedOut || x.faceDown) continue;
    const raw = (DB[x.def].faces[x.face || 0] || DB[x.def].faces[0]).oracle || '';
    if (!/(?:has|have)[^".]*"[^"]*\bAdd\b/i.test(raw) || abilitiesGone(x)) continue;
    for (const m of raw.matchAll(/(?:^|\n|\. )((?:[A-Z][^.\n"]*?)) (?:has|have)(?: [a-z ,]+? and)? "([^"]*\bAdd\b[^"]*)"/g)) {
      const subj = m[1].trim().toLowerCase();
      if (/^(?:it|they|the token|the tokens)\b/.test(subj) || /\btreasures you control\b/.test(subj)) continue; // tokens it makes; Treasures are handled above
      let ok = false;
      if (/^(?:enchanted|equipped) (?:land|creature|permanent|artifact)\b/.test(subj)) ok = x.attachedTo === inst.iid;
      else {
        const mine = /\byou control\b/.test(subj);
        if (mine && x.controller !== inst.controller) continue;
        const other = /\bother\b/.test(subj);
        if (other && x.iid === inst.iid) continue;
        const words = subj.replace(/\byou control\b|\bother\b|^all\b|^each\b/g, ' ').trim().split(/\s+/).filter(Boolean);
        ok = words.length > 0 && fits(words);
      }
      if (ok) out.push(m[2]);
    }
  }
  return out.join('\n');
}
function manaAbilityRaw(inst) {
  if (inst.tapped || inst.faceDown || inst.phasedOut) return null;
  const d = DB[inst.def];
  // quoted text is an ability something else has (Warren Soultrader's Treasure reminder: "{T}, Sacrifice this token: Add …"), not this card's
  const o = grantedManaText(inst) + '\n' + oracle(inst).replace(/"[^"]*"/g, '""'); // granted ones first: "any color" beats a Forest's {G}
  // Nyx Lotus, Karametra's Acolyte-likes: "{T}: Choose a color. Add an amount of mana of that color equal to your devotion to that color."
  if (/\{T\}: Choose a color\. Add an amount of mana of that color equal to your devotion to that color/i.test(o)) {
    if (isCreature(inst) && inst.sick && !hasKw(inst, 'haste')) return null;
    const dev = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
    const vals = Object.entries(dev).map(([k, w]) => [k, (G.s && countPhrase(inst.controller, `your devotion to ${w}`, helpers, inst.iid)) || 0]);
    const best = Math.max(...vals.map((v) => v[1]));
    if (best <= 0) return null;
    return { colors: vals.filter((v) => v[1] === best).map((v) => v[0]), amount: best, oneColor: true, byColor: Object.fromEntries(vals.filter((v) => v[1] > 0)) };
  }
  // Harold and Bob's Forest: "{T}: Add three mana of any one color. You get two rad counters." (better than its {G})
  if (/\{T\}: Add three mana of any one color\. You get two rad counters\./i.test(o)) return { colors: ['W', 'U', 'B', 'R', 'G'], amount: 3, oneColor: true };
  // Sceptre of Eternal Glory: "{T}: Add three mana of any one color. Activate only if you control three or more lands with the same name."
  {
    const sm = o.match(/\{T\}: Add (two|three) mana of any one color\. Activate only if you control (two|three|four) or more lands with the same name/i);
    if (sm && G.s) {
      const need = { two: 2, three: 3, four: 4 }[sm[2].toLowerCase()];
      const names = {};
      for (const i of G.s.players[inst.controller].zones.battlefield) {
        const x = G.s.cards[i];
        if (x && isLand(x)) names[DB[x.def].name] = (names[DB[x.def].name] || 0) + 1;
      }
      if (Object.values(names).some((k) => k >= need)) return { colors: ['W', 'U', 'B', 'R', 'G'], amount: sm[1].toLowerCase() === 'three' ? 3 : 2 };
    }
  }
  // Urza's Tower / Mine / Power-Plant: "If you control an Urza's Mine and an Urza's Power-Plant, add {C}{C}{C} instead."
  {
    const um = o.match(/\{T\}: Add \{C\}\. If you control an (Urza's [\w-]+) and an (Urza's [\w-]+), add ((?:\{C\})+) instead/i);
    if (um) {
      const mine = G.s ? G.s.players[inst.controller].zones.battlefield.map((i) => G.s.cards[i]).filter((x) => x && !x.phasedOut) : [];
      const has = (t) => mine.some((x) => typeLine(x).toLowerCase().includes(t.toLowerCase().replace('power plant', 'power-plant')));
      const k = has(um[1]) && has(um[2]) ? (um[3].match(/\{C\}/g) || []).length : 1;
      return { colors: ['C'], amount: k };
    }
  }
  // Shrine of the Forsaken Gods: "{T}: Add {C}." plus "{T}: Add {C}{C}. Spend this mana only to cast colorless spells. Activate only if you control seven or more lands."
  {
    const rm = o.match(/\{T\}: Add ((?:\{C\})+)\. Spend this mana only to cast colorless spells\. Activate only if you control (\w+) or more lands/i);
    if (rm && /(?:^|\n)\{T\}: Add \{C\}\.(?:\n|$)/.test(o)) {
      const lands = G.s ? G.s.players[inst.controller].zones.battlefield.filter((i) => G.s.cards[i] && isLand(G.s.cards[i])).length : 0;
      const need = { five: 5, six: 6, seven: 7, eight: 8 }[rm[2].toLowerCase()] || +rm[2] || 7;
      const big = (rm[1].match(/\{C\}/g) || []).length;
      return lands >= need ? { colors: ['C'], amount: 1, alts: [{ colors: ['C'], amount: big, onlyFor: 'colorless' }] } : { colors: ['C'], amount: 1 };
    }
  }
  {
    const km = o.match(/\{T\}: Add an amount of \{([WUBRG])\} equal to your devotion to (white|blue|black|red|green)/i);
    if (km) {
      if (isCreature(inst) && inst.sick && !hasKw(inst, 'haste')) return null;
      const k = (G.s && countPhrase(inst.controller, `your devotion to ${km[2].toLowerCase()}`, helpers, inst.iid)) || 0;
      return k > 0 ? { colors: [km[1].toUpperCase()], amount: k } : null;
    }
  }
  // Prismatic Lens, Manalith-likes with a paid upgrade: "{T}: Add {C}." plus "{1}, {T}: Add one mana of any color."
  {
    const fm = o.match(/(?:^|\n)\{T\}: Add (\{[WUBRGC]\})\.(?:\n|$)/);
    const pm = o.match(/(?:^|\n)\{(\d)\}, \{T\}: Add (one mana of any color|\{[WUBRGC]\}(?: or \{[WUBRGC]\})*)\.(?:\n|$)/);
    if (fm && pm && !(isCreature(inst) && inst.sick && !hasKw(inst, 'haste'))) {
      const paid = /any color/.test(pm[2]) ? ['W', 'U', 'B', 'R', 'G'] : pm[2].match(/\{([WUBRGC])\}/g).map((x) => x[1]);
      return { colors: [fm[1][1]], amount: 1, filterAlt: { colors: paid, amount: 1, activation: +pm[1] } };
    }
  }
  // Signets and other filters: "{1}, {T}: Add {W}{U}." — pay {1} from another source, get both colors
  {
    const sg = o.match(/(?:^|\n)\{(\d)\}, \{T\}: Add ((?:\{[WUBRGC]\}){2,3})\./);
    if (sg && !/\{T\}: Add/.test(o.replace(sg[0], ''))) {
      const each = sg[2].match(/\{([WUBRGC])\}/g).map((x) => x[1]);
      return { colors: [...new Set(each)], amount: each.length, each, activation: +sg[1] };
    }
  }
  if (/\{T\}: Add one mana of any color in your commander's color identity/i.test(o)) {
    const cols = commanderIdentity(inst.controller);
    if (isCreature(inst) && inst.sick && !hasKw(inst, 'haste')) return null;
    return cols.length ? { colors: cols, amount: 1 } : null;
  }
  // Orb of Dragonkind: "{1}, {T}: Add two mana in any combination of colors. Spend this mana only to cast Dragon spells or activate abilities of Dragons."
  {
    const om = o.match(/(?:^|\n)\{(\d)\}, \{T\}: Add (two|three) mana in any combination of colors\. Spend this mana only to cast ([A-Z][\w-]+) spells( or activate abilities of \3s)?\./);
    if (om) {
      if (isCreature(inst) && inst.sick && !hasKw(inst, 'haste')) return null;
      return { colors: ['W', 'U', 'B', 'R', 'G'], amount: om[2] === 'three' ? 3 : 2, combo: true, activation: +om[1], onlyFor: om[3], ...(om[4] ? { abilitiesOf: om[3] } : {}) };
    }
  }
  // Interdimensional Web Watch: "{T}: Add two mana in any combination of colors. Spend this mana only to cast spells from exile."
  {
    const am = o.match(/(?:^|\n)\{T\}: Add (two|three) mana in any combination of colors\.(?: Spend this mana only to cast spells from exile\.)?/);
    if (am && !/Spend this mana only to cast (?:creature|[A-Z])/.test(o)) {
      if (isCreature(inst) && inst.sick && !hasKw(inst, 'haste')) return null;
      return { colors: ['W', 'U', 'B', 'R', 'G'], amount: am[1] === 'three' ? 3 : 2, combo: true, ...(/only to cast spells from exile/.test(am[0]) ? { onlyFor: 'fromExile' } : {}) };
    }
  }
  // Thriving lands & co.: "{T}: Add {R} or one mana of the chosen color."
  {
    const tc = o.match(/(?:^|\n)\{T\}: Add \{([WUBRGC])\} or one mana of the chosen color\./);
    if (tc) {
      if (isCreature(inst) && inst.sick && !hasKw(inst, 'haste')) return null;
      return { colors: [...new Set([tc[1], ...(inst.chosenColor ? [inst.chosenColor] : [])])], amount: 1 };
    }
  }
  // what it can make: from the card data, or read off its own "Add …" text when the data has none
  const produced0 = d.produced.length ? d.produced : (() => {
    const adds = (o.match(/Add [^.\n]*/g) || []).join(' ');
    const set = new Set((adds.match(/\{[WUBRGC]\}/g) || []).map((x) => x[1]));
    if (/mana of any (?:one )?color|any combination of colors/i.test(adds)) ['W', 'U', 'B', 'R', 'G'].forEach((x) => set.add(x));
    return [...set];
  })();
  // mana abilities other permanents give it (Abundant Growth on a Forest: {G} or any color)
  const produced = (() => {
    const g = grantedManaText(inst);
    if (!g) return produced0;
    const adds = (g.match(/Add [^.\n]*/g) || []).join(' ');
    const set = new Set([...produced0, ...(adds.match(/\{[WUBRGC]\}/g) || []).map((x) => x[1])]);
    if (/mana of any (?:one )?color|any combination of colors/i.test(adds)) ['W', 'U', 'B', 'R', 'G'].forEach((x) => set.add(x));
    return [...set];
  })();
  // Selvala, Heart of the Wilds: "{G}, {T}: Add X mana in any combination of colors, where X is the greatest power among creatures you control."
  {
    const xm = o.match(/(?:^|\n)((?:\{[^}]+\})*),? ?\{T\}: Add X mana in any combination of colors, where X is ([^.]+)\./);
    if (xm && G.s) {
      if (isCreature(inst) && inst.sick && !hasKw(inst, 'haste')) return null;
      const k = countPhrase(inst.controller, xm[2].replace(/^the /, ''), helpers, inst.iid) || 0;
      const act = (xm[1].match(/\{\d+\}/g) || []).reduce((a, x) => a + +x.slice(1, -1), 0) + (xm[1].match(/\{[WUBRGC]\}/g) || []).length;
      return k > act ? { colors: ['W', 'U', 'B', 'R', 'G'], amount: k, combo: true, ...(act ? { activation: act } : {}) } : null;
    }
  }
  if (isCreature(inst) && inst.sick && !hasKw(inst, 'haste') && /\{T\}/.test(o)) {
    if (!isLand(inst)) return null;
  }
  // Gaea's Cradle, Priest of Titania, Cabal Coffers: "{T}: Add {G} for each …" (a {N} activation cost comes off the total)
  {
    const fe = o.match(/(?:^|\n)(?:\{(\d+)\}, )?\{T\}: Add (\{[WUBRGC]\}) for each ([^.]+)\./);
    if (fe && G.s) {
      const k = (countPhrase(inst.controller, fe[3], helpers, inst.iid) || 0) - (+fe[1] || 0);
      return k > 0 ? { colors: [fe[2][1]], amount: k } : null;
    }
  }
  // Exotic Orchard, Fellwar Stone, Reflecting Pool: "Add one mana of any color that a land an opponent controls could produce."
  {
    const cp = o.match(/\{T\}: Add one mana of any (color|type) that a land (an opponent controls|you control|your opponents control) could produce/i);
    if (cp) {
      if (!G.s) return { colors: produced, amount: 1 };
      const pids = /you control/.test(cp[2]) && !/opponent/.test(cp[2]) ? [inst.controller] : opponents(inst.controller);
      const set = new Set();
      for (const iid of pids.flatMap((k) => G.s.players[k].zones.battlefield)) {
        const x = G.s.cards[iid];
        if (!x || x.phasedOut || !isLand(x) || /could produce/.test(oracle(x))) continue;
        const r = manaAbility({ ...x, tapped: false, sick: false });
        if (r) for (const col of r.colors || []) set.add(col);
      }
      const cols = ['W', 'U', 'B', 'R', 'G', ...(cp[1] === 'type' ? ['C'] : [])].filter((x) => set.has(x));
      return cols.length ? { colors: cols, amount: 1 } : null;
    }
  }
  if (isLand(inst)) {
    // bounce lands, Sol lands: "{T}: Add {W}{U}." makes both
    {
      const two = o.match(/(?:^|\n)\{T\}: Add ((?:\{[WUBRGC]\}){2,3})\./);
      if (two) {
        const each = two[1].match(/\{([WUBRGC])\}/g).map((x) => x[1]);
        return { colors: [...new Set(each)], amount: each.length, each };
      }
    }
    if (produced.length) return { colors: produced, amount: 1 };
    {
      const tm = o.match(/(?:^|\n)\{T\}: Add ((?:\{[WUBRGC]\})+)\./);
      if (tm) {
        const syms = tm[1].match(/\{([WUBRGC])\}/g).map((x) => x[1]);
        return { colors: [...new Set(syms)], amount: syms.length };
      }
    }
    const t = typeLine(inst);
    const map = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
    const cs = Object.keys(map).filter((k) => t.includes(k)).map((k) => map[k]);
    return cs.length ? { colors: cs, amount: 1 } : null;
  }
  // Faeburrow Elder, Bloom Tender: one mana of each color among your permanents
  if (/\{T\}: For each color among permanents you control, add one mana of that color/i.test(o)) {
    const set = new Set();
    for (const iid of (G.s ? G.s.players[inst.controller].zones.battlefield : [])) {
      const x = G.s.cards[iid];
      if (x && !x.phasedOut) for (const col of DB[x.def].colors || []) set.add(col);
    }
    const each = ['W', 'U', 'B', 'R', 'G'].filter((x) => set.has(x));
    return each.length ? { colors: each, amount: each.length, each } : null;
  }
  // Black Lotus, Lion's Eye Diamond style: "Sacrifice <name>: Add three mana of any one color."
  {
    const nm = DB[inst.def].name.split(' // ')[0];
    const sm = o.split(nm).join('~').match(/(?:\{T\}, )?Sacrifice (?:this (?:artifact|token|permanent)|~): Add (one|two|three|\w+) mana of any (?:one )?color/);
    if (sm && !/Discard your hand/.test(o)) return { colors: ['W', 'U', 'B', 'R', 'G'], amount: { one: 1, two: 2, three: 3 }[sm[1]] || 1, sac: true };
  }
  if (!produced.length) return null;
  if (/\{T\}: Add [^.]+\. Spend this mana only to activate abilities/.test(o)) {
    const r = manaAbilityPlain(inst, o, produced);
    return r ? { ...r, onlyFor: 'abilities' } : r;
  }
  // Powerstone: "This mana can't be spent to cast a nonartifact spell." (artifact spells and any ability are fine)
  if (/\{T\}: Add [^.]+\. This mana can't be spent to cast (?:a )?nonartifact spells?/.test(o)) {
    const r = manaAbilityPlain(inst, o, produced);
    return r ? { ...r, onlyFor: 'artifactOrAbility' } : r;
  }
  // Giada: "Spend this mana only to cast an Angel spell."
  // Vedalken Engineer: "Spend this mana only to cast artifact spells or activate abilities of artifacts."
  const only = o.match(/\{T\}: Add [^.]+\. Spend this mana only to cast (?:an? )?([A-Z][\w-]+|creature|artifact|instant or sorcery|noncreature) (?:creature )?spells?( or activate abilities of (?:artifacts|\1s))?/);
  if (only) {
    const r = manaAbilityPlain(inst, o, produced);
    return r ? { ...r, onlyFor: only[1], ...(only[2] ? { abilitiesOf: only[1] } : {}) } : r;
  }
  return manaAbilityPlain(inst, o, produced);
}
function manaAbilityPlain(inst, o, produced) {
  let m = o.match(/\{T\}: Add ([^.]+)\./);
  // Ilysian Caryatid: "If you control a creature with power 4 or greater, add two mana of any one color instead."
  {
    const im = o.match(/If you control a creature with power (\d+) or greater, add (two|three) mana of any one color instead/i);
    if (im && G.s && G.s.players[inst.controller].zones.battlefield.some((i) => G.s.cards[i] && isCreature(G.s.cards[i]) && power(G.s.cards[i]) >= +im[1]))
      return { colors: produced.length ? produced : ['W', 'U', 'B', 'R', 'G'], amount: im[2] === 'three' ? 3 : 2 };
  }
  // Whisperer of the Wilds, Marwyn-likes: "Ferocious — {T}: Add {G}{G}. Activate only if you control a creature with power 4 or greater."
  {
    const fm = o.match(/(?:^|\n)(?:Ferocious — )?\{T\}: Add ((?:\{[WUBRGC]\}){2,})\. Activate only if you control a creature with power (\d+) or greater/);
    if (fm && G.s && G.s.players[inst.controller].zones.battlefield.some((i) => G.s.cards[i] && isCreature(G.s.cards[i]) && power(G.s.cards[i]) >= +fm[2])) {
      const syms = fm[1].match(/[WUBRGC]/g);
      return { colors: [...new Set(syms)], amount: syms.length };
    }
    // otherwise use the plain "{T}: Add {G}." line, not the conditional one
    if (fm) m = o.replace(fm[0], '').match(/\{T\}: Add ([^.]+)\./);
  }
  if (m) {
    let amount = 1;
    // "{T}: Add two mana of any one color." (Vedalken Engineer, Gilded Lotus-style)
    const am = m[1].match(/^(two|three|four|five) mana of any one color$/i);
    if (am) return { colors: produced.length ? produced : ['W', 'U', 'B', 'R', 'G'], amount: { two: 2, three: 3, four: 4, five: 5 }[am[1].toLowerCase()] };
    // Rivaz of the Claw: "{T}: Add two mana in any combination of colors."
    const cm = m[1].match(/^(two|three|four|five) mana in any combination of colors$/i);
    if (cm) return { colors: ['W', 'U', 'B', 'R', 'G'], amount: { two: 2, three: 3, four: 4, five: 5 }[cm[1].toLowerCase()] };
    const syms = m[1].match(/\{[WUBRGC]\}/g);
    if (syms && !/\bor\b/.test(m[1]) && /^(\{[WUBRGC]\})+$/.test(m[1].replace(/\s/g, ''))) amount = syms.length;
    // Timeless Lotus, Jegantha: "{T}: Add {W}{U}{B}{R}{G}." — one of each, not five of any
    const noGeneric = /This mana can't be spent to pay generic mana costs/i.test(o) ? { noGeneric: true } : {};
    if (amount > 1 && syms && new Set(syms).size > 1) return { colors: produced, amount, each: syms.map((x) => x[1]), ...noGeneric };
    return { colors: produced, amount, ...noGeneric };
  }
  // Signets and filters: "{1}, {T}: Add {R}{G}." nets one extra mana of those colors
  if ((m = o.match(/\{1\}, \{T\}: Add (\{[WUBRGC]\})(\{[WUBRGC]\})/))) return { colors: produced, amount: 1 };
  // Treasure-like: "{T}, Sacrifice this artifact: Add one mana of any color."
  if (/\{T\}, Sacrifice (?:this (?:artifact|token|permanent)|~|it): Add/.test(o) || /^Sacrifice (?:this (?:artifact|token|permanent)|~): Add/m.test(o)) return { colors: produced, amount: 1, sac: true };
  return null;
}

// Pay a cost with sources [{iid, colors, amount, sac?}]. Returns {payers:[iid], x} or null.
// Signets cost {1} to activate: try paying with no signets, then with more of them switched on
// Auto-tapping that keeps your other spells castable: if the cheapest way to pay would strand a card in your hand
// (or your commander) that you could otherwise also cast, pick a payment that leaves it castable.
export function payCostKeep(cost, sources, opts = {}, pid) {
  const best = payCost(cost, sources, opts);
  if (!best || !G.s || !pid) return best;
  const seen = new Set();
  const others = [];
  for (const z of ['hand', 'command']) {
    for (const iid of G.s.players[pid].zones[z]) {
      const h = G.s.cards[iid];
      if (!h || iid === opts.self || isLand(h)) continue;
      const mc = (DB[h.def].manaCost || '').replace(/\{X\}/g, '');
      if (!mc || seen.has(mc)) continue;
      seen.add(mc);
      others.push({ mc, cmc: DB[h.def].cmc || 0 });
    }
  }
  if (!others.length || !best.payers) return best;
  const both = (h) => !!payCost(cost + h.mc, sources, { ...opts, nodeCap: 6000 });
  const keepable = others.filter(both);
  if (!keepable.length) return best;
  const score = (P) => {
    const used = new Set(P.payers || []);
    const rest = sources.filter((m) => !used.has(m.iid));
    return keepable.reduce((a, h) => a + (payCost(h.mc, rest, { nodeCap: 6000 }) ? 10 + h.cmc : 0), 0);
  };
  let pick = best;
  let top = score(best);
  const max = keepable.reduce((a, h) => a + 10 + h.cmc, 0);
  // try leaving out each source the cheapest payment used, twice over
  for (let round = 0; round < 3 && top < max; round++) {
    let improved = false;
    for (const u of new Set(pick.payers)) {
      const alt = payCost(cost, sources.filter((m) => m.iid !== u && !(pick.avoid || []).includes(m.iid)), opts);
      if (!alt) continue;
      const sc = score(alt);
      if (sc > top) {
        pick = { ...alt, avoid: [...(pick.avoid || []), u] };
        top = sc;
        improved = true;
      }
    }
    if (!improved) break;
  }
  return pick;
}

function signetChainOk(on, genericUnits) {
  const ids = new Set(on.map((s) => s.iid));
  let spendable = genericUnits.filter((u) => !ids.has(u)).length;
  const left = on.map((s) => ({ act: s.activation, gives: genericUnits.filter((u) => u === s.iid).length }));
  left.sort((a, b) => b.gives - a.gives);
  for (const s of left) {
    if (spendable < s.act) return false;
    spendable += s.gives - s.act;
  }
  return true;
}
// Phyrexian mana ({U/P}): paid with mana when possible, otherwise with 2 life each (cheapest first)
export function payCost(cost, sources, opts = {}) {
  const r = payCostMana(cost, sources, opts);
  const phy = String(cost || '').match(/\{[WUBRGC]\/P\}|\{P\/[WUBRGC]\}/gi) || [];
  if (r || !phy.length || opts.noPhyLife) return r;
  let life = opts.life;
  if (life === undefined && G.s) {
    const owner = sources.map((s) => (s.iid && !String(s.iid).startsWith('pool:') ? G.s.cards[s.iid] : null)).find(Boolean);
    const pid = opts.pid || (owner && owner.controller);
    if (pid && G.s.players[pid]) life = G.s.players[pid].life;
  }
  for (let k = 1; k <= phy.length; k++) {
    if (life !== undefined && life - 2 * k < 1) break; // never pay yourself to 0
    let rest = String(cost);
    for (let i = 0; i < k; i++) rest = rest.replace(phy[i], '');
    const rr = payCostMana(rest, sources, opts);
    if (rr) return { ...rr, phyLife: 2 * k };
  }
  return null;
}
function payCostMana(cost, sources, opts = {}) {
  const filters = sources.filter((s) => s.activation || s.filterAlt).map((s) => (s.filterAlt ? { ...s, ...s.filterAlt, filterAlt: undefined, kind: '' } : s));
  const plain = sources.filter((s) => !s.activation);
  let best = payCostRaw(cost, plain, opts);
  if (best || !filters.length) return best;
  const n = Math.min(filters.length, 6);
  for (let mask = 1; mask < 1 << n && !best; mask++) {
    const on = filters.filter((_, k) => mask & (1 << k));
    const plainHere = plain.filter((p) => !on.some((o) => o.iid === p.iid));
    const extra = on.reduce((a, s) => a + s.activation, 0);
    const r = payCostRaw(cost, [...plainHere, ...on.map((s) => ({ ...s, kind: '' }))], { ...opts, extraGeneric: (opts.extraGeneric || 0) + extra, signets: on.map((s) => s.iid), nodeCap: 4000 });
    if (!r) continue;
    // a signet can't pay for its own activation, but it can pay for another one: a land pays signet A, A's mana pays
    // signet B, and so on. Activate them in order, paying each from the generic mana of lands and signets already on.
    if (!signetChainOk(on, r.genericUnits || [])) continue;
    best = r;
  }
  return best;
}
// Mana payment, optimised: colored pips are matched by a small search that minimises a "cost" of tapping each
// source (keep dual lands, rocks with other uses, creatures and Treasures for later; avoid pain), then generic mana
// is paid with whatever is least valuable to keep, saving the colors still needed for the rest of the hand.
function payCostRaw(cost, sources, opts = {}) {
  const c = parseCost(cost);
  const extra = opts.extraGeneric || 0;
  const units = [];
  for (const s of sources) {
    if (s.each) for (const col of s.each) units.push({ iid: s.iid, colors: [col], sac: !!s.sac, kind: s.kind || '', act: !!s.activation, multi: true, noGeneric: !!s.noGeneric });
    else for (let k = 0; k < s.amount; k++) units.push({ iid: s.iid, colors: s.colors, sac: !!s.sac, kind: s.kind || '', pain: s.pain || null, energy: s.energy || null, energyNeed: s.energyNeed || 0, multi: s.amount > 1, restricted: !!s.restricted, noGeneric: !!s.noGeneric });
  }
  // quick no: not enough mana at all, or a color nobody makes
  if (units.length < c.pips.length + c.generic + extra + (opts.minX || 0) * c.x) return null;
  for (const pip of c.pips) if (!pip.includes('ANY') && !pip.includes('2GEN') && !units.some((u) => u.colors.some((col) => pip.includes(col)))) return null;
  const pains = [];
  const ALL = ['C', 'W', 'U', 'B', 'R', 'G'];
  const hurts = (u, want) => !!(u.pain && u.pain.length && !u.colors.some((col) => want.includes(col) && !u.pain.includes(col)));
  // energy-powered mana (Aether Hub's colored mana, Servant of the Conduit): which units have to spend {E}
  const energies = [];
  const needsE = (u, want) => !!(u.energy && u.energy.length && !u.colors.some((col) => want.includes(col) && !u.energy.includes(col)));
  const cardOf = (iid) => (G.s && !String(iid).startsWith('pool:') ? G.s.cards[iid] : null);
  // colors the controller still needs for other cards in hand (keep those sources for later)
  const owner = (units.map((u) => cardOf(u.iid)).find(Boolean) || {}).controller;
  const need = {};
  if (owner && G.s) {
    for (const iid of G.s.players[owner].zones.hand) {
      const h = G.s.cards[iid];
      if (!h || h.iid === opts.self) continue;
      for (const m of (DB[h.def].manaCost || '').matchAll(/\{([WUBRG])\}/g)) need[m[1]] = (need[m[1]] || 0) + 1;
    }
  }
  const supply = {};
  for (const u of units) for (const col of u.colors) supply[col] = (supply[col] || 0) + 1;
  // what it costs to spend this unit (lower is better)
  const srcCost = new Map();
  const needTotal = c.pips.length + c.generic + extra + (opts.minX || 0) * c.x;
  const perSrc = new Map();
  for (const u of units) perSrc.set(u.iid, (perSrc.get(u.iid) || 0) + 1);
  const baseCost = (u) => {
    if (srcCost.has(u.iid)) return srcCost.get(u.iid);
    let v = 0;
    if (u.kind === 'pool') v = -100;
    else if (u.kind === 'convoke') v = 30;
    else if (u.kind === 'improvise') v = 25;
    else if (u.kind === 'delve') v = 35;
    else if (u.kind === 'lifeC') v = 60; // Channel (Yavimaya Bloomsage): life is the last resort
    else if (u.kind === 'waterbend') v = cardOf(u.iid) && isCreature(cardOf(u.iid)) ? 9 : 5;
    else {
      const cc = cardOf(u.iid);
      if (u.sac) v += 40; // Treasures, Lotus Petal
      // mana creatures: kept back by default (they can still attack or block); the setting can make them go first
      if (cc && isCreature(cc)) v += G.settings && G.settings.dorks === 'first' && cc.controller === 'p' ? -2 : 6;
      if (cc && !isLand(cc)) v += 0.5;
      // sources with other things to do (utility lands, rocks with abilities)
      if (cc && /(?:^|\n)[^\n:]*\{[^}]+\}[^\n:]*: (?!Add\b)/.test(oracle(cc))) v += 3;
      if (!u.restricted) v += (u.colors.length - 1) * 1.2; // keep flexible sources
      if (u.colors.every((col) => col === 'C')) v -= 1; // colorless rocks pay generic first
      if (u.multi) v -= (perSrc.get(u.iid) || 1) > needTotal ? -1.5 : 0.6; // one tap, several mana (Sol Ring, bounce lands) — unless most of it would go to waste
      if (u.restricted) v -= 8; // mana that can only pay for some things: spend it whenever it's allowed
      if (u.act) v -= 4;
    }
    srcCost.set(u.iid, v);
    return v;
  };
  const unitCost = (u, want, tapped) => {
    if (tapped.has(u.iid) && u.multi) return -50; // the source already made this mana
    let v = baseCost(u);
    if (want && hurts(u, want)) v += 12;
    if (want && needsE(u, want)) v += 8;
    return v;
  };
  // --- colored pips: search for the cheapest assignment
  const pips = c.pips.filter((p) => !p.includes('ANY'));
  const anyPips = c.pips.length - pips.length;
  const cands = pips.map((pip) => {
    const want = pip.filter((p) => p !== '2GEN');
    return units.map((u, k) => k).filter((k) => units[k].colors.some((col) => want.includes(col)));
  });
  const orderIdx = pips.map((_, i) => i).sort((a, b) => cands[a].length - cands[b].length);
  let best = null;
  let nodes = 0;
  const used = new Array(units.length).fill(false);
  const pick = new Array(pips.length).fill(-1);
  const tapped = new Map();
  const dfs = (d, acc, gen2) => {
    if (++nodes > (opts.nodeCap || 40000)) return;
    if (best && acc >= best.cost) return;
    if (d === orderIdx.length) {
      best = { cost: acc, pick: [...pick], gen2 };
      return;
    }
    const pi = orderIdx[d];
    const want = pips[pi].filter((p) => p !== '2GEN');
    const opts2 = cands[pi].filter((k) => !used[k]).map((k) => ({ k, v: unitCost(units[k], want, tapped) })).sort((a, b) => a.v - b.v);
    for (const { k, v } of opts2) {
      used[k] = true;
      pick[pi] = k;
      tapped.set(units[k].iid, (tapped.get(units[k].iid) || 0) + 1);
      dfs(d + 1, acc + v, gen2);
      if (tapped.get(units[k].iid) === 1) tapped.delete(units[k].iid);
      else tapped.set(units[k].iid, tapped.get(units[k].iid) - 1);
      used[k] = false;
      pick[pi] = -1;
    }
    // {2/W}: pay two generic instead
    if (pips[pi].includes('2GEN')) dfs(d + 1, acc + 4, gen2 + 2);
  };
  dfs(0, 0, 0);
  if (!best) return null;
  const finalUsed = new Array(units.length).fill(false);
  const tappedSet = new Set();
  const paidAs = new Map(); // source -> the color one of its units paid a colored pip with
  best.pick.forEach((k, pi) => {
    if (k < 0) return;
    finalUsed[k] = true;
    tappedSet.add(units[k].iid);
    paidAs.set(units[k].iid, units[k].colors.find((col) => pips[pi].includes(col)));
    if (hurts(units[k], pips[pi].filter((p) => p !== '2GEN'))) pains.push(units[k].iid);
    if (needsE(units[k], pips[pi].filter((p) => p !== '2GEN'))) energies.push({ iid: units[k].iid, n: units[k].energyNeed || 1 });
  });
  // --- generic (and snow/any pips), then X
  const remaining = new Set(units.map((u, k) => k).filter((k) => !finalUsed[k]));
  const genericCost = (k) => {
    const u = units[k];
    if (tappedSet.has(u.iid) && u.multi) return -50;
    let v = baseCost(u) + (hurts(u, ALL) ? 12 : 0) + (needsE(u, ALL) ? 8 : 0);
    // keep colors that the rest of the hand needs and are in short supply
    for (const col of u.colors) if (col !== 'C' && need[col]) v += Math.min(3, need[col] / Math.max(1, supply[col])) / u.colors.length;
    return v;
  };
  let wbLeft = opts.waterbend || 0;
  const takeCheapest = () => {
    let bk = -1;
    let bv = Infinity;
    for (const k of remaining) {
      if (units[k].kind === 'waterbend' && wbLeft <= 0) continue;
      if (units[k].noGeneric) continue; // Jegantha
      const v = genericCost(k);
      if (v < bv) {
        bv = v;
        bk = k;
      }
    }
    if (bk < 0) return -1;
    remaining.delete(bk);
    if (units[bk].kind === 'waterbend') wbLeft--;
    finalUsed[bk] = true;
    tappedSet.add(units[bk].iid);
    if (hurts(units[bk], ALL)) pains.push(units[bk].iid);
    if (needsE(units[bk], ALL)) energies.push({ iid: units[bk].iid, n: units[bk].energyNeed || 1 });
    for (const col of units[bk].colors) supply[col] = Math.max(0, (supply[col] || 0) - 1);
    return bk;
  };
  const generic = Math.max(0, c.generic + best.gen2 + extra) + anyPips;
  const genericUnits = [];
  for (let k = 0; k < generic; k++) {
    const bk = takeCheapest();
    if (bk < 0) return null;
    genericUnits.push(units[bk].iid);
  }
  let x = 0;
  if (c.x && opts.maxX) {
    const left = remaining.size;
    x = Math.floor(Math.min(left, opts.maxX * c.x) / c.x);
    for (let k = 0; k < x * c.x; k++) takeCheapest();
  }
  if (c.x && x < (opts.minX ?? 1) && opts.maxX) return null;
  const payers = [];
  const sacs = [];
  const special = [];
  finalUsed.forEach((u, k) => {
    if (!u) return;
    if (units[k].kind) special.push({ iid: units[k].iid, kind: units[k].kind });
    else payers.push(units[k].iid);
    if (units[k].sac) sacs.push(units[k].iid);
  });
  const unitsUsed = units.filter((u, k) => finalUsed[k]).map((u) => u.iid);
  if (opts.signets && opts.signets.some((i) => !unitsUsed.includes(i))) return null;
  // Mana a tapped source made but this cost didn't need (Sol Ring for a one-drop): it goes to the mana pool.
  // A source whose units can each be any of several colors (Gilded Lotus) leaves mana of the color it was used for.
  const leftover = [];
  const usedSrc = new Set(payers);
  units.forEach((u, k) => {
    if (finalUsed[k] || u.kind || u.restricted || u.sac || !usedSrc.has(u.iid)) return;
    if (u.noGeneric) return void leftover.push(u.colors[0] + '@nogeneric'); // Jegantha's mana keeps its restriction
    if (u.colors.length === 1) return void leftover.push(u.colors[0]);
    const spent = units.find((v, j) => finalUsed[j] && v.iid === u.iid);
    leftover.push(paidAs.get(u.iid) || (spent && spent.colors.length === 1 ? spent.colors[0] : 'ANY'));
  });
  return { payers, x, sacs: [...new Set(sacs)], special, pains: [...new Set(pains)], energies, unitsUsed, genericUnits, leftover };
}

export function totalMana(sources) {
  // a signet nets one mana (two out, one in)
  return sources.reduce((a, s) => a + s.amount - (s.activation || 0), 0);
}

// ------------------------------------------------------------ combat
const LANDWALK = { swampwalk: 'Swamp', islandwalk: 'Island', forestwalk: 'Forest', mountainwalk: 'Mountain', plainswalk: 'Plains' };

// Space sculptor (Space Beleren): creatures live in the alpha, beta or gamma sector.
export const SECTORS = ['alpha', 'beta', 'gamma'];
export const SECTOR_SIGN = { alpha: 'α', beta: 'β', gamma: 'γ' };
export function sculptors() {
  if (!G.s) return [];
  const out = [];
  for (const pid of seats()) for (const i of G.s.players[pid].zones.battlefield) {
    const c = G.s.cards[i];
    if (c && !c.phasedOut && /(?:^|\n)Space sculptor\b/i.test(oracle(c))) out.push(c);
  }
  return out;
}

export function canBlock(blocker, attacker) {
  if (!isCreature(blocker) || blocker.tapped || blocker.pacifiedBy || blocker.phasedOut) return false;
  if (G.s && blocker.detainedUntil && blocker.detainedUntil > G.s.turn) return false;
  if (G.s && G.s.sectorBlockTurn === G.s.turn && attacker && blocker.sector !== attacker.sector) return false;
  if (G.s && blocker.noBlockUntil && blocker.noBlockUntil > G.s.turn) return false;
  if (blocker.cantBlockTurn === (G.s && G.s.turn)) return false;
  if (attacker && blocker.dutyVs && (blocker.counters || {}).duty > 0 && attacker.controller === blocker.dutyVs) return false; // Immortal Obligation
  if (G.s && G.s.noBlocksTurn === G.s.turn) return false;
  const bo = oracle(blocker);
  if ((/(?:^|\n|\. )(?:~|This creature|[A-Z][^.\n]*?) can't block\.?/.test(bo) && !/can't block (?:creatures with|unless|alone)/i.test(bo)) || hasKw(blocker, 'decayed') || blocker.suspected) return false;
  if ((blocker.grants || []).includes('unleashed') && (blocker.counters || {})['+1/+1']) return false;
  // Bedlam: "Creatures can't block." (also "Creatures your opponents control can't block", "Creatures you control can't block")
  if (G.s && Object.values(G.s.players).some((P) => (P.zones.battlefield || []).some((i) => {
    const x = G.s.cards[i];
    if (!x || x.phasedOut || abilitiesGone(x)) return false;
    const bm = oracle(x).match(/(?:^|\n)(?:All )?creatures( your opponents control| you control)? can't block(?: this turn)?\.?(?:$|\n)/i);
    return !!bm && (!bm[1] || (/opponents/i.test(bm[1]) ? blocker.controller !== x.controller : blocker.controller === x.controller));
  }))) return false;
  if (blocker.goaded && false) return false;
  if (/can block only creatures with flying/i.test(bo) && !hasKw(attacker, 'flying')) return false;
  if (hasKw(blocker, 'shadow') && !hasKw(attacker, 'shadow')) return false;
  const ao = oracle(attacker);
  if (hasKw(attacker, 'flying') && !hasKw(blocker, 'flying') && !hasKw(blocker, 'reach')) return false;
  if (hasKw(attacker, 'shadow') && !hasKw(blocker, 'shadow')) return false;
  if (hasKw(attacker, 'horsemanship') && !hasKw(blocker, 'horsemanship')) return false;
  if (hasKw(attacker, 'fear') && !isType(blocker, 'Artifact') && !colorsOf(blocker).includes('B')) return false;
  if (hasKw(attacker, 'intimidate') && !isType(blocker, 'Artifact') && !colorsOf(blocker).some((c) => colorsOf(attacker).includes(c))) return false;
  if (hasKw(attacker, 'skulk') && power(blocker) > power(attacker)) return false;
  if (ringLevel(attacker) >= 1 && power(blocker) > power(attacker)) return false;
  // Herald of Secret Streams: "Creatures you control with +1/+1 counters on them can't be blocked."
  if (G.s && attacker.controller && G.s.players[attacker.controller].zones.battlefield.some((i) => {
    const x = G.s.cards[i];
    if (!x || x.phasedOut || abilitiesGone(x)) return false;
    const um = oracle(x).match(/(?:^|\n)(Other )?creatures you control with (?:a |one or more )?\+1\/\+1 counters? on (?:them|it) can't be blocked/i);
    return !!um && !(um[1] && x.iid === attacker.iid) && ((attacker.counters || {})['+1/+1'] || 0) > 0;
  })) return false; // the Ring: can't be blocked by creatures with greater power
  for (const [kw, land] of Object.entries(LANDWALK)) {
    if (hasKw(attacker, kw) && G.s && G.s.players[blocker.controller].zones.battlefield.some((i) => G.s.cards[i] && typeLine(G.s.cards[i]).includes(land))) return false;
  }
  if (/(?:^|\n|\. )[^.\n]*can't be blocked\.?(?:$|\n)/.test(ao)) return false;
  // Whispersilk Cloak, Rogue's Passage-style grants: "Equipped creature can't be blocked and has shroud." / "Enchanted creature can't be blocked."
  if (G.s && Object.values(G.s.cards).some((x) => x.attachedTo === attacker.iid && x.zone === 'battlefield' && !abilitiesGone(x) && /(?:^|\n)(?:Equipped|Enchanted) creature (?:gets [+-]\d+\/[+-]\d+,? (?:and )?)?can't be blocked(?:\.| and )/i.test(oracle(x)))) return false;
  if (attacker.unblockableTurn === (G.s && G.s.turn) && !(attacker.unblockableExcept && hasKw(blocker, attacker.unblockableExcept))) return false;
  let m;
  // "can't be blocked as long as it's attacking alone" (Yuan-Ti Malison), "... as long as you're the monarch / have the initiative"
  if ((m = ao.match(/can't be blocked as long as ([^.\n]+)/i))) {
    const cond = m[1].toLowerCase();
    const atk = (G.s && G.s.combat && G.s.combat.attackers) || [];
    if (/(?:it's|it is) attacking alone/.test(cond) && atk.length === 1 && atk[0] === attacker.iid) return false;
    if (/you(?:'re| are) the monarch/.test(cond) && G.s && G.s.monarch === attacker.controller) return false;
    if (/you have the initiative/.test(cond) && G.s && G.s.initiative === attacker.controller) return false;
  }
  if ((m = ao.match(/can't be blocked by creatures with power (\d+) or less/i)) && power(blocker) <= +m[1]) return false;
  if ((m = ao.match(/can't be blocked by creatures with power (\d+) or greater/i)) && power(blocker) >= +m[1]) return false;
  if (/can't be blocked except by creatures with flying/i.test(ao) && !hasKw(blocker, 'flying')) return false;
  if (/can't be blocked except by artifact creatures and\/or (\w+) creatures/i.test(ao)) {
    const col = COLOR_WORDS[ao.match(/and\/or (\w+) creatures/i)[1]];
    if (!isType(blocker, 'Artifact') && !colorsOf(blocker).includes(col)) return false;
  }
  if ((m = ao.match(/can't be blocked by (\w+) creatures/i)) && COLOR_WORDS[m[1]] && colorsOf(blocker).includes(COLOR_WORDS[m[1]])) return false;
  if ((m = ao.match(/can't be blocked by ([A-Z]\w+)s\b/)) && hasSubtype(blocker, m[1])) return false;
  if (isProtectedFrom(attacker, blocker)) return false;
  return true;
}

export function canAttack(inst) {
  if (!isCreature(inst) || inst.tapped || inst.pacifiedBy || inst.phasedOut) return false;
  // Call for Aid: "You can't attack that player this turn" (with one opponent, that's no attacks at all)
  if (G.s && (G.s.cantAttack || []).some((x) => x.turn === G.s.turn && x.by === inst.controller) && seats().filter((p) => p !== inst.controller && G.s.players[p] && !G.s.players[p].lost).every((p) => (G.s.cantAttack || []).some((x) => x.turn === G.s.turn && x.by === inst.controller && x.player === p))) return false;
  if (G.s && inst.detainedUntil && inst.detainedUntil > G.s.turn) return false;
  if (G.s && inst.noAttackUntil && inst.noAttackUntil > G.s.turn) return false;
  if (G.s && G.s.noAttackTurn && G.s.noAttackTurn.turn === G.s.turn && G.s.noAttackTurn.pid === inst.controller) return false; // Overencumbered
  { // Immortal Obligation (duty), Promise of Loyalty (vow), Lightning Rager: can't attack that player — with nobody else to attack, it can't attack
    const vs = [((inst.counters || {}).duty > 0) && inst.dutyVs, ((inst.counters || {}).vow > 0) && inst.vowVs, inst.raggerVs].filter(Boolean);
    if (G.s && vs.length && seats().filter((p) => p !== inst.controller && G.s.players[p] && !G.s.players[p].lost).every((p) => vs.includes(p))) return false;
  }
  if (G.s && G.s.onlyAttackers && G.s.onlyAttackers.turn === G.s.turn && (G.s.combatNo || {})[inst.controller] >= 1 && !G.s.onlyAttackers.ids.includes(inst.iid) && (G.s.ts[inst.controller] || {}).attacked) return false; // Last Night Together
  if (hasKw(inst, 'defender') && !/can attack as though it didn't have defender/i.test(oracle(inst))) return false;
  if (/(?:^|\n|\. )[^.\n]*can't attack\.?(?:$|\n)/.test(oracle(inst)) && !/can't attack (?:alone|unless)/i.test(oracle(inst))) return false;
  if (inst.sick && !hasKw(inst, 'haste')) return false;
  return true;
}

export function mustAttack(inst) {
  const all = G.s && G.s.mustAttackAll;
  if (all && (all.pids || [all.pid]).includes(inst.controller) && G.s.turn < all.until && (!all.from || G.s.turn >= all.from)) return true;
  if (G.s && inst.mustAttackTurn === G.s.turn) return true; // Legion Warboss: "That token … attacks this combat if able"
  return !!inst.goaded || /attacks each (?:combat|turn) if able/i.test(oracle(inst));
}

export function isDead(inst) {
  if (!isCreature(inst)) return false;
  if (toughness(inst) <= 0) return true;
  if (hasKw(inst, 'indestructible')) return false;
  return inst.damage >= toughness(inst) || inst.deathtouched;
}

/**
 * Combat damage.
 * attackers: [iid], blocks: {attackerIid: [blockerIid]}, targets: {attackerIid: pid | permanent iid}
 * Returns events: {type:'player'|'permanent'|'creature', from, to, amount, ...}
 * Applies damage, -1/-1 counters, shield counters and protection to creatures; caller applies the rest.
 */
// Damage replacement: Fiery Emancipation & co. (sources you control), Gisela (double to opponents, half to you),
// The Wanderer (no noncombat damage to you or your other permanents).
// Heroic Sacrifice: damage to a player or their other creatures is dealt to the chosen creature instead
export function redirectTarget(victimPid, victimIid) {
  const r = G.s && G.s.redirect;
  if (!r || r.turn !== G.s.turn || r.pid !== victimPid || victimIid === r.iid) return null;
  const c = G.s.cards[r.iid];
  return c && c.zone === 'battlefield' && !c.phasedOut ? c : null;
}
// Selfless Squire: remember damage to a player that got prevented (flushed by state.inkshieldFlush)
export function damageMods(amount, src, victimPid, opts = {}) {
  const r = damageModsRaw(amount, src, victimPid, opts);
  if (opts.real && !opts.victim && victimPid && amount > 0 && r < amount && G.s) G.s.preventedQ = [...(G.s.preventedQ || []), { pid: victimPid, n: amount - r }];
  return r;
}
function damageModsRaw(amount, src, victimPid, opts = {}) {
  if (!G.s || amount <= 0) return amount;
  const srcCtl = src ? src.controller || src.owner : null;
  // Judgment of Alexander: "Prevent all damage that would be dealt to you this turn by sources your opponents control."
  const po = victimPid && !opts.victim && G.s.preventOppDmg && G.s.preventOppDmg[victimPid];
  if (po && po.turn === G.s.turn && srcCtl && srcCtl !== victimPid) {
    return 0;
  }
  if (opts.victim && opts.victim.preventDmgTurn === G.s.turn) return 0; // Mutational Advantage
  if (victimPid && !opts.victim && G.s.preventAllTo && G.s.preventAllTo[victimPid] === G.s.turn) { if (opts.real && G.s.inkshield && G.s.inkshield.pid === victimPid && G.s.inkshield.turn === G.s.turn) G.s.inkshield.n = (G.s.inkshield.n || 0) + amount; return 0; } // Inkshield, Selfless Squire
  if (opts.combat && G.s.preventCombatTo && victimPid && G.s.preventCombatTo[victimPid] === G.s.turn && (!opts.victim || isType(opts.victim, 'Planeswalker'))) { if (opts.real && !opts.victim && G.s.inkshield && G.s.inkshield.pid === victimPid && G.s.inkshield.turn === G.s.turn) G.s.inkshield.n = (G.s.inkshield.n || 0) + amount; return 0; } // Take the Bait, Inkshield
  // Obscuring Haze: "Prevent all damage that would be dealt this turn by creatures your opponents control."
  if (G.s.hazePrevent && src && srcCtl && isCreature(src) && Object.entries(G.s.hazePrevent).some(([p, t]) => t === G.s.turn && p !== srcCtl)) return 0;
  let a = amount;
  for (const pid of seats()) {
    for (const iid of G.s.players[pid].zones.battlefield) {
      const x = G.s.cards[iid];
      if (!x || x.phasedOut || x.faceDown || abilitiesGone(x)) continue;
      const o = oracle(x);
      if (!/damage/i.test(o)) continue;
      if (pid === srcCtl && /If a source you control would deal damage to (?:a permanent or player|an opponent or a permanent an opponent controls), it deals (double|triple) that damage/i.test(o)
        && (!/an opponent/i.test(o.match(/If a source you control would deal damage to ([^,]+),/i)[1]) || victimPid !== pid)) a *= /it deals triple/i.test(o) ? 3 : 2;
      if (/If a source would deal damage to an opponent or a permanent an opponent controls, that source deals double that damage/i.test(o) && victimPid && victimPid !== pid) a *= 2;
    }
  }
  for (const pid of seats()) {
    if (victimPid !== pid) continue;
    for (const iid of G.s.players[pid].zones.battlefield) {
      const x = G.s.cards[iid];
      if (!x || x.phasedOut || x.faceDown || abilitiesGone(x)) continue;
      const o = oracle(x);
      if (/If a source would deal damage to you or a permanent you control, prevent half that damage, rounded up/i.test(o)) a = Math.floor(a / 2);
      if (!opts.combat && /Prevent all noncombat damage that would be dealt to you and other permanents you control/i.test(o) && (!opts.victim || opts.victim.iid !== x.iid)) a = 0;
    }
  }
  return a;
}

export function combatDamage(cards, attackers, blocks, defender, ownerOf, targets = {}) {
  const events = [];
  const fs = (i) => hasKw(i, 'first strike') || hasKw(i, 'double strike');
  const ds = (i) => hasKw(i, 'double strike');
  const alive = (iid) => cards[iid] && cards[iid].zone === 'battlefield' && !isDead(cards[iid]);
  const fog = G.s && G.s.fogTurn === G.s.turn;
  const anyFirst = attackers.some((a) => cards[a] && fs(cards[a])) || Object.values(blocks).flat().some((b) => cards[b] && fs(cards[b]));
  const steps = anyFirst ? ['first', 'regular'] : ['regular'];
  for (const step of steps) {
    const deals = (i) => (step === 'first' ? fs(i) : !fs(i) || ds(i));
    const pending = [];
    for (const aid of attackers) {
      const a = cards[aid];
      if (!alive(aid)) continue;
      const bl = (blocks[aid] || []).filter(alive);
      const wasBlocked = (blocks[aid] || []).length > 0 || !!(G.s && G.s.combat && G.s.combat.blocks === blocks && (G.s.combat.wasBlocked || {})[aid]);
      const tgt = targets[aid] || defender;
      const toPlayer = isPlayer(tgt);
      const dest = (amount) => (toPlayer ? { type: 'player', from: aid, to: tgt, amount } : { type: 'permanent', from: aid, to: tgt, amount });
      if (deals(a)) {
        let dmg = Math.max(0, combatDmgOf(a));
        const plan = G.s && G.s.combat && G.s.combat.blocks === blocks && (G.s.combat.assign || {})[aid];
        if (!wasBlocked) {
          if (dmg > 0) pending.push(dest(dmg));
        } else if (plan && bl.length) {
          // the attacking player's own division (blockers that are gone pass their share on)
          const tr = hasKw(a, 'trample');
          const parts = bl.map((bid) => ({ bid, n: Math.max(0, plan[bid] || 0) }));
          let toPl = tr ? Math.max(0, plan.player || 0) : 0;
          let extra = Object.entries(plan).filter(([k]) => k !== 'player' && !bl.includes(k)).reduce((x, [, v]) => x + (v || 0), 0);
          let total = parts.reduce((x, p) => x + p.n, 0) + toPl + extra;
          // the damage changed since you divided it: trim or add (player first with trample, else the first blocker)
          while (total > dmg) {
            if (extra > 0) extra--;
            else if (toPl > 0) toPl--;
            else {
              const last = [...parts].reverse().find((p) => p.n > 0);
              if (!last) break;
              last.n--;
            }
            total--;
          }
          if (total < dmg || extra > 0) {
            const more = dmg - total + extra;
            if (tr) toPl += more;
            else parts[0].n += more;
          }
          for (const p of parts) if (p.n > 0) pending.push({ type: 'creature', from: aid, to: p.bid, amount: p.n });
          if (toPl > 0) pending.push(dest(toPl));
        } else {
          for (const bid of bl) {
            if (dmg <= 0) break;
            const b = cards[bid];
            const lethal = hasKw(a, 'deathtouch') ? 1 : Math.max(0, toughness(b) - b.damage);
            const give = bl.length === 1 && !hasKw(a, 'trample') ? dmg : Math.min(dmg, lethal);
            pending.push({ type: 'creature', from: aid, to: bid, amount: give });
            dmg -= give;
          }
          if (dmg > 0 && hasKw(a, 'trample')) pending.push(dest(dmg));
          else if (dmg > 0 && bl.length) pending.push({ type: 'creature', from: aid, to: bl[0], amount: dmg });
        }
      }
      for (const bid of bl) {
        const b = cards[bid];
        if (deals(b) && combatDmgOf(b) > 0) pending.push({ type: 'creature', from: bid, to: aid, amount: combatDmgOf(b) });
      }
    }
    for (const ev of pending) {
      if (ev.amount <= 0) continue;
      const src = cards[ev.from];
      if (!src) continue;
      {
        const vp = ev.type === 'player' ? ev.to || defender : cards[ev.to] ? cards[ev.to].controller : null;
        const rd = vp && (ev.type === 'player' || (cards[ev.to] && isCreature(cards[ev.to]))) ? redirectTarget(vp, ev.type === 'player' ? null : ev.to) : null;
        if (rd) {
          ev.type = 'creature';
          ev.to = rd.iid;
          ev.redirected = true;
        }
      }
      {
        const victim = ev.type === 'player' ? ev.to || defender : cards[ev.to] ? cards[ev.to].controller : null;
        ev.amount = damageMods(ev.amount, src, victim, { combat: true, real: cards === G.s.cards, victim: ev.type === 'player' ? null : cards[ev.to] });
        if (ev.amount <= 0) continue;
      }
      const noPrevent = playerFlag(src.controller, 'noPrevent') || G.s.noPreventTurn === G.s.turn;
      if (fog && !noPrevent) continue;
      if (ev.type === 'player' && !noPrevent && playerProtectedFrom(ev.to || defender, src)) continue;
      if (ev.type === 'creature') {
        const t = cards[ev.to];
        if (!t) continue;
        if (!noPrevent && isProtectedFrom(t, src)) continue;
        if (!noPrevent && (t.counters || {}).shield) {
          t.counters.shield -= 1;
          if (!t.counters.shield) delete t.counters.shield;
          continue;
        }
        if (G.s.dmgShield && t === G.s.cards[t.iid]) { for (const sh of G.s.dmgShield) if (sh.turn === G.s.turn && sh.iid === t.iid && sh.n > 0 && ev.amount > 0) { const k = Math.min(sh.n, ev.amount); sh.n -= k; ev.amount -= k; } if (ev.amount <= 0) continue; }
        if (t.dmgToCounters === G.s.turn) { // Gatta and Luzzu
          t.counters = t.counters || {};
          t.counters['+1/+1'] = (t.counters['+1/+1'] || 0) + ev.amount;
          if (t === G.s.cards[t.iid]) queueEvent({ type: 'counterPut', iid: t.iid, kind: '+1/+1', n: ev.amount, controller: t.controller, by: t.controller });
          continue;
        }
        t.damage = (t.damage || 0) + ev.amount;
        if (hasKw(src, 'deathtouch')) t.deathtouched = true;
        if (hasKw(src, 'infect') || hasKw(src, 'wither')) {
          t.counters = t.counters || {};
          t.counters['-1/-1'] = (t.counters['-1/-1'] || 0) + ev.amount;
          t.damage -= ev.amount;
          queueEvent({ type: 'counterPut', iid: t.iid, kind: '-1/-1', n: ev.amount, controller: t.controller, by: src.controller });
        }
      }
      ev.commander = !!src.isCommander;
      ev.infect = hasKw(src, 'infect');
      ev.lifelink = hasKw(src, 'lifelink');
      ev.controller = ownerOf(ev.from);
      events.push(ev);
    }
  }
  return events;
}

// handed to statics.js so it can test types without importing this module's state
export const helpers = { typeLine, hasSubtype, isCreature, power, toughness };

// combat damage a creature assigns: its power, or its toughness (Kingpin of Crime, "assigns combat damage equal to its toughness")
export function combatDmgOf(c) {
  if (/assigns combat damage equal to its toughness/i.test(oracle(c))) return toughness(c);
  const td = G.s && G.s.toughDmg && G.s.toughDmg[c.controller];
  if (td === G.s.turn && toughness(c) > power(c)) return toughness(c);
  return power(c);
}
