// Rules helpers: card faces, types, keywords, power/toughness, mana, evasion, combat damage.
import { DB } from './data.js';
import { G } from './state.js';
import { staticMods, setTextFn, countPhrase, playerFlag } from './statics.js';

export const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];
const COLOR_WORDS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

export function def(inst) {
  return DB[inst.def];
}
export function face(inst) {
  const d = DB[inst.def];
  return d.faces[inst.face || 0] || d.faces[0];
}
export function typeLine(inst) {
  if (inst.faceDown) return 'Creature';
  let t = face(inst).typeLine || DB[inst.def].typeLine;
  if (inst.notLegendary) t = t.replace(/^Legendary /, '');
  if (inst.animated && !/Creature/.test(t.split('—')[0])) t = t.replace(/^([^—]*)/, (m) => m.trim() + ' Creature ') + (inst.animated.types ? ' ' + inst.animated.types : '');
  if (inst.addTypes) {
    const sup = /\bLegendary\b/.test(inst.addTypes) && !/^Legendary/.test(t);
    const rest = inst.addTypes.replace(/\bLegendary\b/, '').trim();
    t = (sup ? 'Legendary ' : '') + t + (rest ? ' ' + rest : '');
  }
  return t;
}
export function isType(inst, t) {
  return new RegExp('\\b' + t + '\\b', 'i').test(typeLine(inst).split('—')[0]);
}
// Subtypes live after the dash: "Enchantment — Aura", "Artifact — Equipment". Changelings have them all.
export function hasSubtype(inst, t) {
  const parts = typeLine(inst).split('—');
  if (parts.length > 1 && new RegExp('\\b' + t + 's?\\b', 'i').test(parts.slice(1).join(' '))) return true;
  // changeling (intrinsic only, so lords can't loop back into themselves)
  if (!inst.faceDown && (isCreature(inst) || /\b(?:Kindred|Tribal)\b/.test(typeLine(inst).split('—')[0])) && (DB[inst.def].keywords.includes('changeling') || (inst.grants || []).includes('changeling') || /(?:^|\n)Changeling\b/.test((DB[inst.def].faces[inst.face || 0] || {}).oracle || '')) &&
      !/^(aura|equipment|vehicle|saga|class|case|room|food|treasure|clue)$/i.test(t)) return true;
  return false;
}
export const isLand = (i) => isType(i, 'Land');

export function isCreature(i) {
  if (!i) return false;
  if (i.faceDown) return true; // morph / manifest / disguise / cloak: a 2/2 creature
  if (i.impending && (i.counters || {}).time > 0) return false;
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
  const f = face(inst);
  let text = f.oracle || '';
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
  if (inst.extraText) text += '\n' + inst.extraText;
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
function kwInText(text, kw) {
  for (const l of text.split('\n')) {
    const line = l.replace(/\([^)]*\)/g, '').trim();
    if (!KW_LINE.test(line)) continue;
    for (const part of line.toLowerCase().split(/, /)) if (part === kw || part.startsWith(kw + ' ')) return true;
  }
  return false;
}

export function grantsOf(inst) {
  const g = [...(inst.grants || []), ...(inst.eotGrants || [])];
  for (const b of Object.values(inst.auraBuffs || {})) g.push(...b.grants);
  if (inst.zone === 'battlefield') g.push(...staticMods(inst, helpers).grants);
  return g;
}

export function hasKw(inst, kw) {
  if (!inst) return false;
  kw = kw.toLowerCase();
  if (inst.lostAbilities) return (inst.eotGrants || []).includes(kw);
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
  if (/\bDevoid\b/.test(face(inst).oracle || '')) return [];
  return DB[inst.def].colors || [];
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
  for (const p of protections(inst)) {
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
  const o = (face(inst).oracle || '').replace(DB[inst.def].faces[inst.face || 0].name, '~');
  let m;
  if ((m = o.match(/~'s power and toughness are each equal to (?:the number of |your )?([^.]+?)(?: plus (\d+))?\./i))) {
    const v = countPhrase(inst.controller, m[1], helpers, inst.iid);
    if (v !== null) return { p: v + (+m[2] || 0), t: v + (+m[2] || 0) };
  }
  if ((m = o.match(/~'s power is equal to (?:the number of |your )?([^.]+?)\./i))) {
    const v = countPhrase(inst.controller, m[1], helpers, inst.iid);
    if (v !== null) return { p: v, t: null };
  }
  if ((m = o.match(/~'s toughness is equal to (?:the number of |your )?([^.]+?)\./i))) {
    const v = countPhrase(inst.controller, m[1], helpers, inst.iid);
    if (v !== null) return { p: null, t: v };
  }
  return null;
}

export function basePT(inst) {
  if (inst.faceDown) return { p: 2, t: 2 };
  if (inst.setPT) return { ...inst.setPT };
  if (inst.proto) return { ...inst.proto };
  if (inst.animated && inst.animated.p !== undefined && !/Creature/.test((face(inst).typeLine || '').split('—')[0])) return { p: inst.animated.p, t: inst.animated.t };
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
const auraSum = (inst, k) =>
  Object.entries(inst.auraBuffs || {}).reduce((a, [src, b]) => {
    if (!b.each) return a + b[k];
    const sc = G.s && G.s.cards[src];
    const v = sc ? countPhrase(sc.controller, b.each, helpers, sc.iid) || 0 : 0;
    return a + (k === 'p' ? b.perP : b.perT) * v;
  }, 0) + (inst.eot ? inst.eot[k] : 0);

export function power(inst) {
  const st = inst.zone === 'battlefield' ? staticMods(inst, helpers) : { p: 0 };
  return basePT(inst).p + counterPT(inst.counters).p + (inst.ptMod ? inst.ptMod.p : 0) + auraSum(inst, 'p') + st.p;
}
export function toughness(inst) {
  const st = inst.zone === 'battlefield' ? staticMods(inst, helpers) : { t: 0 };
  return basePT(inst).t + counterPT(inst.counters).t + (inst.ptMod ? inst.ptMod.t : 0) + auraSum(inst, 't') + st.t;
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
export function manaAbility(inst) {
  const r = manaAbilityRaw(inst);
  if (!r) return r;
  const o = oracle(inst);
  const painful = new Set();
  const symsOf = (t) => (/one mana of any color/i.test(t) ? ['W', 'U', 'B', 'R', 'G'] : (t.match(/\{[WUBRGC]\}/g) || []).map((x) => x[1]));
  for (const m of o.matchAll(/\{T\}: Add ([^.\n]+)\. [^.\n]*?deals 1 damage to you/g)) symsOf(m[1]).forEach((x) => painful.add(x));
  for (const m of o.matchAll(/\{T\}, Pay 1 life: Add ([^.\n]+)\./g)) symsOf(m[1]).forEach((x) => painful.add(x));
  if (!painful.size) return r;
  return { ...r, pain: (r.colors || []).filter((x) => painful.has(x)) };
}
function manaAbilityRaw(inst) {
  if (inst.tapped || inst.faceDown || inst.phasedOut) return null;
  const d = DB[inst.def];
  const o = oracle(inst);
  const produced = d.produced.length ? d.produced : [];
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
      const pid = /you control/.test(cp[2]) && !/opponent/.test(cp[2]) ? inst.controller : inst.controller === 'p' ? 'ai' : 'p';
      const set = new Set();
      for (const iid of G.s.players[pid].zones.battlefield) {
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
    const sm = o.split(nm).join('~').match(/(?:\{T\}, )?Sacrifice (?:this artifact|~): Add (one|two|three|\w+) mana of any (?:one )?color/);
    if (sm && !/Discard your hand/.test(o)) return { colors: ['W', 'U', 'B', 'R', 'G'], amount: { one: 1, two: 2, three: 3 }[sm[1]] || 1, sac: true };
  }
  if (!produced.length) return null;
  if (/\{T\}: Add [^.]+\. Spend this mana only to activate abilities/.test(o)) {
    const r = manaAbilityPlain(inst, o, produced);
    return r ? { ...r, onlyFor: 'abilities' } : r;
  }
  // Giada: "Spend this mana only to cast an Angel spell."
  const only = o.match(/\{T\}: Add [^.]+\. Spend this mana only to cast (?:an? )?([A-Z][\w-]+|creature|artifact|instant or sorcery|noncreature) (?:creature )?spells?/);
  if (only) {
    const r = manaAbilityPlain(inst, o, produced);
    return r ? { ...r, onlyFor: only[1] } : r;
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
  if (m) {
    let amount = 1;
    const syms = m[1].match(/\{[WUBRGC]\}/g);
    if (syms && !/\bor\b/.test(m[1]) && /^(\{[WUBRGC]\})+$/.test(m[1].replace(/\s/g, ''))) amount = syms.length;
    return { colors: produced, amount };
  }
  // Signets and filters: "{1}, {T}: Add {R}{G}." nets one extra mana of those colors
  if ((m = o.match(/\{1\}, \{T\}: Add (\{[WUBRGC]\})(\{[WUBRGC]\})/))) return { colors: produced, amount: 1 };
  // Treasure-like: "{T}, Sacrifice this artifact: Add one mana of any color."
  if (/\{T\}, Sacrifice (?:this artifact|~|it): Add/.test(o) || /^Sacrifice (?:this artifact|~): Add/m.test(o)) return { colors: produced, amount: 1, sac: true };
  return null;
}

// Pay a cost with sources [{iid, colors, amount, sac?}]. Returns {payers:[iid], x} or null.
export function payCost(cost, sources, opts = {}) {
  const c = parseCost(cost);
  const extra = opts.extraGeneric || 0;
  const units = [];
  for (const s of sources) {
    if (s.each) for (const col of s.each) units.push({ iid: s.iid, colors: [col], sac: !!s.sac, kind: s.kind || '' });
    else for (let k = 0; k < s.amount; k++) units.push({ iid: s.iid, colors: s.colors, sac: !!s.sac, kind: s.kind || '', pain: s.pain || null });
  }
  const pains = [];
  // a unit that can only make this pip's colors by hurting
  const hurts = (u, want) => !!(u.pain && u.pain.length && !u.colors.some((col) => want.includes(col) && !u.pain.includes(col)));
  // spend real mana before treasures, convoke/improvise/delve last
  const rank = (u) => (u.kind === 'pool' ? -1 : u.kind ? 2 : u.sac ? 1 : 0);
  const used = new Array(units.length).fill(false);
  const pips = [...c.pips].sort((a, b) => a.length - b.length);
  let genericFromHybrid = 0;
  for (const pip of pips) {
    if (pip.includes('ANY')) {
      const i = units.findIndex((u, k) => !used[k]);
      if (i < 0) return null;
      used[i] = true;
      continue;
    }
    const want = pip.filter((p) => p !== '2GEN');
    let best = -1;
    let bestScore = 1e9;
    units.forEach((u, k) => {
      if (used[k]) return;
      if (!u.colors.some((col) => want.includes(col))) return;
      const sc = rank(u) * 100 + u.colors.length + (hurts(u, want) ? 50 : 0);
      if (sc < bestScore) {
        best = k;
        bestScore = sc;
      }
    });
    if (best < 0) {
      if (pip.includes('2GEN')) {
        genericFromHybrid += 2;
        continue;
      }
      return null;
    }
    used[best] = true;
    if (hurts(units[best], want)) pains.push(units[best].iid);
  }
  const generic = Math.max(0, c.generic + genericFromHybrid + extra);
  // generic mana: spend colorless first, then the most plentiful colors, keeping scarce colors for later
  const plenty = {};
  units.forEach((u, k) => !used[k] && u.colors.forEach((col) => (plenty[col] = (plenty[col] || 0) + 1)));
  const keepScore = (u) => (u.colors.length ? Math.min(...u.colors.map((col) => plenty[col] || 0)) : 1e6) - u.colors.length * 0.1;
  const order = units
    .map((u, k) => k)
    .filter((k) => !used[k])
    .sort((a, b) => rank(units[a]) - rank(units[b]) || (hurts(units[a], ['C', 'W', 'U', 'B', 'R', 'G']) ? 1 : 0) - (hurts(units[b], ['C', 'W', 'U', 'B', 'R', 'G']) ? 1 : 0) || keepScore(units[b]) - keepScore(units[a]));
  if (order.length < generic) return null;
  for (let k = 0; k < generic; k++) {
    used[order[k]] = true;
    if (hurts(units[order[k]], ['C', 'W', 'U', 'B', 'R', 'G'])) pains.push(units[order[k]].iid);
  }
  let x = 0;
  if (c.x && opts.maxX) {
    const left = order.length - generic;
    x = Math.floor(Math.min(left, opts.maxX * c.x) / c.x);
    for (let k = generic; k < generic + x * c.x; k++) {
      used[order[k]] = true;
      if (hurts(units[order[k]], ['C', 'W', 'U', 'B', 'R', 'G'])) pains.push(units[order[k]].iid);
    }
  }
  if (c.x && x < (opts.minX ?? 1) && opts.maxX) return null;
  const payers = [];
  const sacs = [];
  const special = [];
  used.forEach((u, k) => {
    if (!u) return;
    if (units[k].kind) special.push({ iid: units[k].iid, kind: units[k].kind });
    else payers.push(units[k].iid);
    if (units[k].sac) sacs.push(units[k].iid);
  });
  return { payers, x, sacs: [...new Set(sacs)], special, pains };
}

export function totalMana(sources) {
  return sources.reduce((a, s) => a + s.amount, 0);
}

// ------------------------------------------------------------ combat
const LANDWALK = { swampwalk: 'Swamp', islandwalk: 'Island', forestwalk: 'Forest', mountainwalk: 'Mountain', plainswalk: 'Plains' };

// Space sculptor (Space Beleren): creatures live in the alpha, beta or gamma sector.
export const SECTORS = ['alpha', 'beta', 'gamma'];
export const SECTOR_SIGN = { alpha: 'α', beta: 'β', gamma: 'γ' };
export function sculptors() {
  if (!G.s) return [];
  const out = [];
  for (const pid of ['p', 'ai']) for (const i of G.s.players[pid].zones.battlefield) {
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
  const bo = oracle(blocker);
  if ((/(?:^|\n|\. )(?:~|This creature|[A-Z][^.\n]*?) can't block\.?/.test(bo) && !/can't block (?:creatures with|unless|alone)/i.test(bo)) || hasKw(blocker, 'decayed') || blocker.suspected) return false;
  if ((blocker.grants || []).includes('unleashed') && (blocker.counters || {})['+1/+1']) return false;
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
  for (const [kw, land] of Object.entries(LANDWALK)) {
    if (hasKw(attacker, kw) && G.s && G.s.players[blocker.controller].zones.battlefield.some((i) => G.s.cards[i] && typeLine(G.s.cards[i]).includes(land))) return false;
  }
  if (/(?:^|\n|\. )[^.\n]*can't be blocked\.?(?:$|\n)/.test(ao) || attacker.unblockableTurn === (G.s && G.s.turn)) return false;
  let m;
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
  if (G.s && inst.detainedUntil && inst.detainedUntil > G.s.turn) return false;
  if (G.s && inst.noAttackUntil && inst.noAttackUntil > G.s.turn) return false;
  if (hasKw(inst, 'defender') && !/can attack as though it didn't have defender/i.test(oracle(inst))) return false;
  if (/(?:^|\n|\. )[^.\n]*can't attack\.?(?:$|\n)/.test(oracle(inst)) && !/can't attack (?:alone|unless)/i.test(oracle(inst))) return false;
  if (inst.sick && !hasKw(inst, 'haste')) return false;
  return true;
}

export function mustAttack(inst) {
  const all = G.s && G.s.mustAttackAll;
  if (all && all.pid === inst.controller && G.s.turn < all.until) return true;
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
      const wasBlocked = (blocks[aid] || []).length > 0;
      const tgt = targets[aid] || defender;
      const toPlayer = tgt === 'p' || tgt === 'ai';
      const dest = (amount) => (toPlayer ? { type: 'player', from: aid, to: tgt, amount } : { type: 'permanent', from: aid, to: tgt, amount });
      if (deals(a)) {
        let dmg = Math.max(0, /assigns combat damage equal to its toughness/i.test(oracle(a)) ? toughness(a) : power(a));
        if (!wasBlocked) {
          if (dmg > 0) pending.push(dest(dmg));
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
        if (deals(b) && power(b) > 0) pending.push({ type: 'creature', from: bid, to: aid, amount: power(b) });
      }
    }
    for (const ev of pending) {
      if (ev.amount <= 0) continue;
      const src = cards[ev.from];
      if (!src) continue;
      const noPrevent = playerFlag(src.controller, 'noPrevent') || G.s.noPreventTurn === G.s.turn;
      if (fog && !noPrevent) continue;
      if (ev.type === 'creature') {
        const t = cards[ev.to];
        if (!t) continue;
        if (!noPrevent && isProtectedFrom(t, src)) continue;
        if (!noPrevent && (t.counters || {}).shield) {
          t.counters.shield -= 1;
          if (!t.counters.shield) delete t.counters.shield;
          continue;
        }
        t.damage = (t.damage || 0) + ev.amount;
        if (hasKw(src, 'deathtouch')) t.deathtouched = true;
        if (hasKw(src, 'infect') || hasKw(src, 'wither')) {
          t.counters = t.counters || {};
          t.counters['-1/-1'] = (t.counters['-1/-1'] || 0) + ev.amount;
          t.damage -= ev.amount;
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
