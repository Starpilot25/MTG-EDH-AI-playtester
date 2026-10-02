// Continuous effects read from permanents' rules text: anthems and lords, keyword grants,
// cost changes, replacement effects, and counting phrases ("the number of creatures you control").
import { DB } from './data.js';
import { G } from './state.js';
import { evalCond } from './effects.js';

const COLOR_WORDS = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const parsedCache = new Map();

const lines = (text) =>
  String(text || '')
    .replace(/\([^)]*\)/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

export function kwList(s) {
  return s
    ? s
        .replace(/\.$/, '')
        .split(/, and |, | and /)
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean)
    : [];
}

// Words that narrow "creatures you control": subtypes, colors, token/nontoken, legendary, attacking…
function filterFrom(words) {
  const f = {};
  for (const w of String(words || '').toLowerCase().split(/\s+/).filter(Boolean)) {
    if (w === 'other') continue;
    if (w === 'nontoken') f.nontoken = true;
    else if (w === 'token') f.token = true;
    else if (w === 'legendary') f.legendary = true;
    else if (w === 'attacking') f.attacking = true;
    else if (w === 'blocking') f.blocking = true;
    else if (w === 'tapped') f.tapped = true;
    else if (w === 'untapped') f.untapped = true;
    else if (w === 'artifact') f.artifact = true;
    else if (w === 'enchantment') f.enchantment = true;
    else if (w === 'multicolored') f.multicolored = true;
    else if (w === 'colorless') f.colorless = true;
    else if (COLOR_WORDS[w]) f.color = COLOR_WORDS[w];
    else if (/^non/.test(w)) f.not = (f.not || []).concat(w.slice(3));
    else if (!['creature', 'creatures', 'each', 'all', 'the', 'and', 'or'].includes(w)) f.subtypes = (f.subtypes || []).concat(w.replace(/s$/, ''));
  }
  return f;
}

function parseStatics(text, selfName) {
  const out = { anthems: [], costs: [], repl: {}, player: {}, self: [] };
  const me = String(selfName || '').split(' // ')[0].toLowerCase();
  const short = me.split(',')[0];
  for (let l of lines(text)) {
    l = l.toLowerCase();
    if (/^(when|whenever|at the beginning|\{|[+−-]?\d+:|level|station)/.test(l)) continue;
    let m;
    // buffs to this creature itself: "~ gets +1/+1 for each …", "As long as …, ~ gets +2/+2 and has flying"
    const sl = (me ? l.split(me).join('~') : l).split(short && short.length > 3 ? short : '\u0000').join('~').replace(/\bthis (?:creature|permanent|vehicle|artifact|enchantment)\b/g, '~');
    if ((m = sl.match(/^~ gets ([+-]\d+)\/([+-]\d+) for each (.+?)\.?$/))) {
      out.self.push({ p: +m[1], t: +m[2], each: m[3], grants: [] });
      continue;
    }
    if ((m = sl.match(/^as long as (.+?), ~ gets ([+-]\d+)\/([+-]\d+)(?: and (?:has|gains) (.+?))?\.?$/))) {
      out.self.push({ cond: m[1], p: +m[2], t: +m[3], grants: kwList(m[4]) });
      continue;
    }
    if ((m = sl.match(/^~ gets ([+-]\d+)\/([+-]\d+)(?: and (?:has|gains) (.+?))? as long as (.+?)\.?$/))) {
      out.self.push({ cond: m[4], p: +m[1], t: +m[2], grants: kwList(m[3]) });
      continue;
    }
    if ((m = sl.match(/^as long as (.+?), ~ (?:has|gains) (.+?)\.?$/)) || ((m = sl.match(/^~ has (.+?) as long as (.+?)\.?$/)) && (m = [m[0], m[2], m[1]]))) {
      const g = kwList(m[2]);
      if (g.length) {
        out.self.push({ cond: m[1], p: 0, t: 0, grants: g });
        continue;
      }
    }
    // anthems: "Other Elf creatures you control get +1/+1 and have …"
    if ((m = l.match(/^(other )?((?:[\w-]+ ){0,3}?)creatures you control get ([+-]\d+)\/([+-]\d+)(?: and (?:have|gain) (.+?))?(?: for each [^.]+)?\.?$/))) {
      out.anthems.push({ who: 'mine', other: !!m[1], f: filterFrom(m[2]), p: +m[3], t: +m[4], grants: kwList(m[5]) });
      continue;
    }
    if ((m = l.match(/^(other )?([\w-]+?)s you control get ([+-]\d+)\/([+-]\d+)(?: and (?:have|gain) (.+?))?\.?$/)) && m[2] !== 'creature') {
      out.anthems.push({ who: 'mine', other: !!m[1], f: filterFrom(m[2]), p: +m[3], t: +m[4], grants: kwList(m[5]) });
      continue;
    }
    if ((m = l.match(/^(other )?((?:[\w-]+ ){0,3}?)creatures you control have (.+?)\.?$/))) {
      out.anthems.push({ who: 'mine', other: !!m[1], f: filterFrom(m[2]), p: 0, t: 0, grants: kwList(m[3]) });
      continue;
    }
    if ((m = l.match(/^(other )?([\w-]+?)s you control have (.+?)\.?$/)) && !/^(spell|land|permanent)$/.test(m[2])) {
      out.anthems.push({ who: 'mine', other: !!m[1], f: filterFrom(m[2]), p: 0, t: 0, grants: kwList(m[3]) });
      continue;
    }
    if ((m = l.match(/^creatures your opponents control get ([+-]\d+)\/([+-]\d+)/))) {
      out.anthems.push({ who: 'theirs', f: {}, p: +m[1], t: +m[2], grants: [] });
      continue;
    }
    if ((m = l.match(/^(?:all|each) (other )?((?:[\w-]+ ){0,2}?)creatures get ([+-]\d+)\/([+-]\d+)/))) {
      out.anthems.push({ who: 'all', other: !!m[1], f: filterFrom(m[2]), p: +m[3], t: +m[4], grants: [] });
      continue;
    }
    if ((m = l.match(/^all ([\w-]+?)s get ([+-]\d+)\/([+-]\d+)/))) {
      out.anthems.push({ who: 'all', f: filterFrom(m[1]), p: +m[2], t: +m[3], grants: [] });
      continue;
    }
    // cost changes
    if ((m = l.match(/^((?:[\w-]+ ){0,4}?)spells you cast(?: from (your graveyard|exile|anywhere other than your hand))? cost \{(\d+)\} less to cast/))) {
      out.costs.push({ who: 'mine', filter: m[1].trim(), from: m[2] || '', delta: -m[3] });
      continue;
    }
    if ((m = l.match(/^((?:[\w-]+ ){0,4}?)spells your opponents cast cost \{(\d+)\} more to cast/))) {
      out.costs.push({ who: 'theirs', filter: m[1].trim(), delta: +m[2] });
      continue;
    }
    if ((m = l.match(/^((?:[\w-]+ ){0,4}?)spells cost \{(\d+)\} (more|less) to cast/))) {
      out.costs.push({ who: 'all', filter: m[1].trim(), delta: m[3] === 'more' ? +m[2] : -m[2] });
      continue;
    }
    // replacement effects
    if (/if a card or token would be put into a graveyard from anywhere, exile it instead/.test(l)) out.repl.gyExile = 'all';
    if (/if a (?:card|nontoken card) would be put into an opponent's graveyard from anywhere, exile it instead/.test(l)) out.repl.gyExile = out.repl.gyExile || 'opponents';
    if (/if an effect would create one or more tokens under your control, it creates twice that many/.test(l)) out.repl.tokenDouble = (out.repl.tokenDouble || 0) + 1;
    if (/would be put on [^,.]+ you control, (?:that many plus one|it puts that many plus one)/.test(l)) out.repl.counterPlusOne = (out.repl.counterPlusOne || 0) + 1;
    if (/would be put on [^,.]+ you control, it puts twice that many|twice that many of each of those kinds of counters/.test(l)) out.repl.counterDouble = (out.repl.counterDouble || 0) + 1;
    if (/creatures your opponents control enter (?:the battlefield )?tapped|creatures entering the battlefield under your opponents' control enter tapped/.test(l)) out.repl.oppEnterTapped = true;
    if (/^permanents your opponents control enter (?:the battlefield )?tapped/.test(l)) out.repl.oppPermsTapped = true;
    if ((m = l.match(/if a source you control would deal damage to (?:a permanent or player|an opponent or a permanent an opponent controls)[^,]*, it deals (double|triple) that damage/))) out.repl.damageMult = m[1] === 'triple' ? 3 : 2;
    if (/^you have hexproof/.test(l)) out.player.hexproof = true;
    if (/^you have shroud/.test(l)) out.player.shroud = true;
    if (/^you have no maximum hand size/.test(l)) out.player.noMaxHand = true;
    if (/^(?:your opponents|players) can't gain life/.test(l)) out.player.noLifeGain = /^players/.test(l) ? 'all' : 'opponents';
    if (/^(?:spells|creature spells|noncreature spells) you control can't be countered/.test(l)) out.player.uncounterable = l.split(' ')[0];
    if (/^damage can't be prevented/.test(l)) out.player.noPrevent = true;
    if (/^you may look at the top card of your library any time/.test(l)) out.player.seeTop = true;
    if (/^you may play lands from your graveyard/.test(l)) out.player.landsFromGy = true;
    if (/^you may play an additional land on each of your turns/.test(l)) out.player.extraLands = (out.player.extraLands || 0) + 1;
  }
  void selfName;
  return out;
}

let textFn = null;
export function setTextFn(fn) {
  textFn = fn;
}

// Eminence: "As long as ~ is in the command zone or on the battlefield, …" — usable from either place.
export function eminenceText(text, name) {
  return String(text || '')
    .split('\n')
    .filter((l) => /^Eminence — /.test(l))
    .map((l) => l.replace(/^Eminence — /, '').replace(/^As long as [^,]+? is in the command zone or on the battlefield, /i, '').replace(/, if [^,]+? is in the command zone or on the battlefield,/i, ','))
    .join('\n')
    .split(name).join('~');
}
export function staticsOf(c) {
  const d = DB[c.def];
  if (!d) return { anthems: [], costs: [], repl: {}, player: {} };
  let text = textFn ? textFn(c) : (d.faces[c.face || 0] || d.faces[0]).oracle;
  if (c.zone === 'command') text = eminenceText(text, d.name);
  else text = text.replace(/(^|\n)Eminence — As long as [^,]+? is in the command zone or on the battlefield, /g, '$1');
  const key = c.def + ':' + (c.face || 0) + ':' + c.zone + ':' + text.length + ':' + (c.chosenType || '');
  if (!parsedCache.has(key)) parsedCache.set(key, parseStatics(text, d.name));
  return parsedCache.get(key);
}

function field() {
  if (!G.s) return [];
  const out = [];
  for (const pid of ['p', 'ai'])
  {
    for (const iid of G.s.players[pid].zones.battlefield) {
      const c = G.s.cards[iid];
      if (c && !c.phasedOut && !c.faceDown && !c.lostAbilities) out.push(c);
    }
    for (const iid of G.s.players[pid].zones.command) {
      const c = G.s.cards[iid];
      if (c && c.isCommander && /(?:^|\n)Eminence — /.test((DB[c.def].faces[0] || {}).oracle || '')) out.push(c);
    }
  }
  return out;
}

function matchesFilter(c, f, helpers) {
  const d = DB[c.def];
  const tl = helpers.typeLine(c);
  if (f.nontoken && c.token) return false;
  if (f.token && !c.token) return false;
  if (f.legendary && !/Legendary/.test(tl)) return false;
  if (f.attacking && !c.attacking) return false;
  if (f.blocking && !c.blocking) return false;
  if (f.tapped && !c.tapped) return false;
  if (f.untapped && c.tapped) return false;
  if (f.artifact && !/Artifact/.test(tl)) return false;
  if (f.enchantment && !/Enchantment/.test(tl)) return false;
  if (f.color && !d.colors.includes(f.color)) return false;
  if (f.multicolored && d.colors.length < 2) return false;
  if (f.colorless && d.colors.length) return false;
  if (f.not) for (const w of f.not) if (new RegExp('\\b' + w + '\\b', 'i').test(tl) || (COLOR_WORDS[w] && d.colors.includes(COLOR_WORDS[w]))) return false;
  if (f.subtypes && !f.subtypes.some((st) => helpers.hasSubtype(c, st))) return false;
  return true;
}

// Sum of anthem effects on a creature: {p, t, grants[]}
export function staticMods(c, helpers) {
  const out = { p: 0, t: 0, grants: [] };
  if (!G.s || c.zone !== 'battlefield') return out;
  for (const src of field()) {
    const st = staticsOf(src);
    for (const a of st.anthems) {
      if (a.other && src.iid === c.iid) continue;
      if (a.who === 'mine' && src.controller !== c.controller) continue;
      if (a.who === 'theirs' && src.controller === c.controller) continue;
      if (!matchesFilter(c, a.f, helpers)) continue;
      out.p += a.p;
      out.t += a.t;
      out.grants.push(...a.grants);
    }
  }
  selfBuffs(c, helpers, out);
  return out;
}

let inSelf = 0;
function selfBuffs(c, helpers, out) {
  if (c.phasedOut || c.faceDown || c.lostAbilities || inSelf > 2) return;
  const list = staticsOf(c).self;
  if (!list || !list.length) return;
  inSelf++;
  try {
    for (const b of list) {
      let k = 1;
      if (b.each) k = countPhrase(c.controller, b.each, helpers, c.iid) || 0;
      if (b.cond) {
        let ok = null;
        try {
          ok = evalCond(b.cond.replace(/\byou control\b/, 'you control'), { me: c.controller, src: c });
        } catch (e) {
          ok = null;
        }
        if (!ok) continue;
      }
      out.p += b.p * k;
      out.t += b.t * k;
      if (k > 0) out.grants.push(...b.grants);
    }
  } finally {
    inSelf--;
  }
}

const NOT_CREATURE_TYPE = /^(creature|artifact|enchantment|land|planeswalker|battle|kindred|tribal|legendary|snow|basic|permanent|card|aura|equipment|vehicle|saga|class|case|room|food|treasure|clue|spell|nonland|token)s?$/;
function isChangelingDef(d) {
  return (d.keywords || []).includes('changeling') || /(?:^|\n)Changeling\b/.test((d.faces[0] || {}).oracle || '');
}
function spellFits(filter, d) {
  if (!filter) return true;
  const tl = d.faces[0].typeLine;
  return filter.replace(/\b(?:other|another)\b/g, '').split(/\s+(?:and|or)\s+|\s+/).filter(Boolean).every((w) => {
    if (w === 'noncreature') return !/Creature/.test(tl);
    if (w === 'nonartifact') return !/Artifact/.test(tl);
    if (/^non/.test(w)) return !new RegExp(w.slice(3), 'i').test(tl);
    if (COLOR_WORDS[w]) return d.colors.includes(COLOR_WORDS[w]);
    if (w === 'multicolored') return d.colors.length > 1;
    if (w === 'instant' || w === 'sorcery') return /Instant|Sorcery/.test(tl);
    if (w === 'historic') return /Legendary|Artifact|Saga/.test(tl);
    if (w === 'commander') return true;
    if (new RegExp('\\b' + w.replace(/s$/, ''), 'i').test(tl)) return true;
    // changelings (Firdoch Core, Mirror Entity…) are every creature type
    return isChangelingDef(d) && /Creature|Kindred|Tribal/.test(tl.split('—')[0]) && !NOT_CREATURE_TYPE.test(w);
  });
}

// Generic mana added to (or taken off) a spell's cost by permanents on the battlefield.
export function costDelta(pid, c, fromZone) {
  const d = DB[c.def];
  let delta = 0;
  for (const src of field()) {
    for (const cm of staticsOf(src).costs) {
      if (cm.who === 'mine' && src.controller !== pid) continue;
      if (cm.who === 'theirs' && src.controller === pid) continue;
      if (cm.from === 'your graveyard' && fromZone !== 'graveyard') continue;
      if (cm.from === 'exile' && fromZone !== 'exile') continue;
      if (/commander/.test(cm.filter) && !c.isCommander) continue;
      if (!spellFits(cm.filter.replace(/commander/, '').trim(), d)) continue;
      delta += cm.delta;
    }
  }
  return delta;
}

// Replacement effects that matter for `pid` (or anyone when pid is null).
export function repl(kind, pid) {
  let v = 0;
  for (const src of field()) {
    const r = staticsOf(src).repl[kind];
    if (!r) continue;
    if (kind === 'gyExile') {
      if (r === 'all' || (r === 'opponents' && pid && src.controller !== pid)) return true;
      continue;
    }
    if (kind === 'oppEnterTapped' || kind === 'oppPermsTapped') {
      if (pid && src.controller !== pid) return true;
      continue;
    }
    if (pid && src.controller !== pid) continue;
    if (kind === 'damageMult') v = (v || 1) * r;
    else v = typeof r === 'number' ? v + r : 1;
  }
  return v;
}

export function playerFlag(pid, flag) {
  for (const src of field()) {
    const v = staticsOf(src).player[flag];
    if (!v) continue;
    if (flag === 'noLifeGain') {
      if (v === 'all' || src.controller !== pid) return true;
      continue;
    }
    if (src.controller === pid) return v;
  }
  return false;
}

// ------------------------------------------------------------ counting phrases
// "the number of creatures you control", "cards in your hand", "your devotion to black"…
export function countPhrase(pid, phrase, helpers, srcIid) {
  let p = String(phrase || '').toLowerCase().replace(/^the (?:total )?number of /, '').replace(/\.$/, '').trim();
  // "for each tapped land your opponents control", "for each Goblin on the battlefield", "creature card in your graveyard"
  p = p.replace(/^((?:[\w-]+ ){0,3}?)([\w-]*[^s\s]) (you control|your opponents control|an opponent controls|on the battlefield)$/, '$1$2s $3')
    .replace(/\bcard (in|from) /, 'cards $1 ');
  // Ghalta: "the total power of creatures you control"; also "greatest power among creatures you control"
  {
    const pm = p.match(/^(?:total |the total )?(power|toughness) of ((?:other )?(?:[\w-]+ ){0,2}?creatures) (you control|your opponents control|on the battlefield)$/);
    if (pm && G.s && helpers) {
      const who = pm[3] === 'you control' ? [pid] : pm[3] === 'on the battlefield' ? ['p', 'ai'] : [pid === 'p' ? 'ai' : 'p'];
      const words = pm[2].replace(/creatures$/, '').trim();
      const f = filterFrom(words);
      return who.flatMap((w) => G.s.players[w].zones.battlefield.map((i) => G.s.cards[i]))
        .filter((c) => c && !c.phasedOut && helpers.isCreature(c) && (!/other/.test(words) || c.iid !== srcIid) && matchesFilter(c, f, helpers))
        .reduce((a, c) => a + Math.max(0, pm[1] === 'power' ? helpers.power(c) : helpers.toughness(c)), 0);
    }
    const gm = p.match(/^(?:the )?greatest (power|toughness|mana value) among (?:other )?creatures you control$/);
    if (gm && G.s && helpers) {
      const cs = G.s.players[pid].zones.battlefield.map((i) => G.s.cards[i]).filter((c) => c && helpers.isCreature(c));
      return cs.reduce((a, c) => Math.max(a, gm[1] === 'power' ? helpers.power(c) : gm[1] === 'toughness' ? helpers.toughness(c) : DB[c.def].cmc || 0), 0);
    }
  }
  {
    const nm = p.match(/^cards? named (.+?) in (?:each|all) graveyards?$/);
    if (nm && G.s) return ['p', 'ai'].flatMap((w) => G.s.players[w].zones.graveyard).filter((i) => G.s.cards[i] && DB[G.s.cards[i].def].name.toLowerCase() === nm[1]).length;
  }
  const s = G.s;
  const opp = pid === 'p' ? 'ai' : 'p';
  const bf = (who) => s.players[who].zones.battlefield.map((i) => s.cards[i]).filter((c) => c && !c.phasedOut);
  const gy = (who) => s.players[who].zones.graveyard.map((i) => s.cards[i]);
  let m;
  if ((m = p.match(/^(?:your )?devotion to (white|blue|black|red|green)(?: and (white|blue|black|red|green))?/))) {
    const syms = [COLOR_WORDS[m[1]], m[2] && COLOR_WORDS[m[2]]].filter(Boolean);
    let k = 0;
    for (const c of bf(pid)) for (const mm of ((DB[c.def].faces[c.face || 0] || {}).manaCost || DB[c.def].manaCost).matchAll(/\{([^}]+)\}/g)) if (syms.some((y) => mm[1].includes(y))) k++;
    return k;
  }
  if (/^cards? in your hand/.test(p)) return s.players[pid].zones.hand.length;
  if (/^cards? in (?:target opponent's|an opponent's|each opponent's) hand/.test(p)) return s.players[opp].zones.hand.length;
  if (/^cards? in all graveyards/.test(p)) return gy('p').length + gy('ai').length;
  if (/^creature cards in all graveyards/.test(p)) return [...gy('p'), ...gy('ai')].filter((c) => /Creature/.test(DB[c.def].typeLine)).length;
  if (/^creature cards in your graveyard/.test(p)) return gy(pid).filter((c) => /Creature/.test(DB[c.def].typeLine)).length;
  if (/^(?:instant and sorcery|instant or sorcery) cards in your graveyard/.test(p)) return gy(pid).filter((c) => /Instant|Sorcery/.test(DB[c.def].typeLine)).length;
  if (/^land cards in your graveyard/.test(p)) return gy(pid).filter((c) => /Land/.test(DB[c.def].typeLine)).length;
  if (/^cards? in your graveyard/.test(p)) return gy(pid).length;
  if (/^card types among cards in (?:your|all) graveyards?/.test(p)) {
    const types = new Set();
    for (const c of /all/.test(p) ? [...gy('p'), ...gy('ai')] : gy(pid))
      for (const t of ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery'])
        if (new RegExp(t).test(DB[c.def].typeLine.split('—')[0])) types.add(t);
    return types.size;
  }
  if (/^basic land types among lands you control/.test(p)) {
    const types = new Set();
    for (const c of bf(pid)) for (const t of ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']) if (helpers.typeLine(c).includes(t)) types.add(t);
    return types.size;
  }
  if (/^opponents you have|^opponents/.test(p)) return 1;
  if (/^\+1\/\+1 counters on (?:creatures|permanents) you control/.test(p)) return bf(pid).reduce((a, c) => a + (c.counters['+1/+1'] || 0), 0);
  if (/^colou?rs? among permanents you control/.test(p)) return new Set(bf(pid).flatMap((c) => DB[c.def].colors)).size;
  if ((m = p.match(/^(other )?((?:[\w-]+ ){0,3}?)(creatures|artifacts|enchantments|lands|planeswalkers|permanents|[\w-]+s) (you control|your opponents control|an opponent controls|on the battlefield)/))) {
    const who = m[4] === 'you control' ? [pid] : m[4] === 'on the battlefield' ? ['p', 'ai'] : [opp];
    const kind = m[3].replace(/s$/, '');
    const f = filterFrom(m[2]);
    return who
      .flatMap(bf)
      .filter((c) => {
        if (m[1] && c.iid === srcIid) return false;
        if (kind === 'creature' && !helpers.isCreature(c)) return false;
        else if (kind === 'permanent') void 0;
        else if (['artifact', 'enchantment', 'land', 'planeswalker'].includes(kind)) {
          if (!new RegExp(kind, 'i').test(helpers.typeLine(c))) return false;
        } else if (kind !== 'creature' && !helpers.hasSubtype(c, kind)) return false;
        return matchesFilter(c, f, helpers);
      }).length;
  }
  return null;
}
