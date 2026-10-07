// Casting spells, playing lands and activating abilities — one pipeline for both players.
// Handles alternative costs (flashback, escape, dash, evoke, bestow, mutate, morph…), additional
// costs (kicker, buyback, entwine, bargain, casualty…), cost changes (convoke, delve, affinity,
// improvise, commander tax, Thalia/Helm effects), split/adventure/MDFC halves, storm, cascade,
// split second, rebound, cipher, and the special actions (cycling, ninjutsu, foretell, plot…).
import { DB } from './data.js';
import {
  isLand, isCreature, isType, hasSubtype, oracle, face, hasKw, kwNum, kwCost, power, toughness, cardValue,
  manaAbility, payCost, parseCost, isPermanentCard, typeLine, colorsOf,
} from './rules.js';
import {
  G, card, cardsIn, zoneOf, move, draw, log, nameTag, toBattlefield, createToken, genericTokenDef, stateBased,
  commanderTax, shuffle, opp, cardName, addCounters, queueEvent, sacrifice, discard as discardCard, mill as millCards,
  libTop, esc, makeCard, changeLife, aiSlaved,
  tappedHook,
} from './state.js';
import {
  resolveEffects, spellText, etbText, costOf, attachAura, attachTo, activatedAbilities, zoneAbilities, Cancelled,
  matchesFilter, analyze, stripName, spellFilterOk,
  predictTargets,
} from './effects.js';
import { costDelta, countPhrase } from './statics.js';
import { helpers } from './rules.js';
import { fire, settle } from './triggers.js';

const isLandFace = (f) => /\bLand\b/.test((f.typeLine || '').split('—')[0]);
const instantFace = (f) => /\bInstant\b/.test((f.typeLine || '').split('—')[0]);

// ------------------------------------------------------------ mana sources
export function manaSources(pid, opts = {}) {
  const out = [];
  const pool = (G.s.pool && G.s.pool[pid]) || [];
  pool.forEach((sym, k) => out.push({ iid: 'pool:' + k, colors: sym === 'ANY' ? ['W', 'U', 'B', 'R', 'G', 'C'] : [sym], amount: 1, kind: 'pool' }));
  const spell = opts.spell || (opts.self ? card(opts.self) : null);
  for (const c of cardsIn(pid, 'battlefield')) {
    const m = manaAbility(c);
    if (!m) continue;
    // restricted mana ("spend this mana only to cast an Angel spell")
    if (m.onlyFor === 'abilities') {
      // The Enigma Jewel: "Spend this mana only to activate abilities."
      if (!opts.ability) continue;
    } else if (m.onlyFor === 'fromExile') {
      if (!spell || spell.zone !== 'exile' || opts.ability) continue;
    } else if (m.onlyFor) {
      if (!spell || spell.zone === 'battlefield' || opts.ability) continue;
      const tl = DB[spell.def].faces[spell.face || 0].typeLine || DB[spell.def].typeLine;
      const ok = /^[A-Z]/.test(m.onlyFor) ? hasSubtype({ ...spell, zone: 'hand' }, m.onlyFor) : m.onlyFor === 'noncreature' ? !/Creature/.test(tl) : new RegExp(m.onlyFor.split(' or ').join('|'), 'i').test(tl);
      if (!ok) continue;
    }
    out.push({ iid: c.iid, colors: m.colors, amount: m.amount, sac: !!m.sac, each: m.each, pain: m.pain, activation: m.activation || 0 });
  }
  // Waterbend: untapped artifacts and creatures can each pay {1} of the waterbend cost
  if (opts.waterbend)
    for (const c of cardsIn(pid, 'battlefield')) if ((isCreature(c) || isType(c, 'Artifact')) && !c.tapped && c.iid !== opts.self && !out.some((o) => o.iid === c.iid)) out.push({ iid: c.iid, colors: [], amount: 1, kind: 'waterbend' });
  if (opts.convoke)
    for (const c of cardsIn(pid, 'battlefield')) if (isCreature(c) && !c.tapped && !out.some((o) => o.iid === c.iid)) out.push({ iid: c.iid, colors: colorsOf(c).length ? colorsOf(c) : [], amount: 1, kind: 'convoke' });
  if (opts.improvise)
    for (const c of cardsIn(pid, 'battlefield')) if (isType(c, 'Artifact') && !c.tapped && !out.some((o) => o.iid === c.iid)) out.push({ iid: c.iid, colors: [], amount: 1, kind: 'improvise' });
  if (opts.delve) for (const c of cardsIn(pid, 'graveyard')) if (c.iid !== opts.self) out.push({ iid: c.iid, colors: [], amount: 1, kind: 'delve' });
  return out;
}

// Tap / sacrifice / exile what paid for a cost.
export function applyPayment(pid, pay) {
  if (!pay) return;
  const usedPool = [];
  for (const iid of pay.payers || []) {
    if (String(iid).startsWith('pool:')) usedPool.push(+iid.slice(5));
    else if (card(iid)) {
      card(iid).tapped = true;
      tappedHook(card(iid));
    }
  }
  for (const sp of pay.special || []) {
    if (sp.kind === 'pool') usedPool.push(+String(sp.iid).slice(5));
    else if (sp.kind === 'delve') move(sp.iid, 'exile');
    else if (card(sp.iid)) card(sp.iid).tapped = true;
  }
  if (usedPool.length && G.s.pool) G.s.pool[pid] = G.s.pool[pid].filter((_, k) => !usedPool.includes(k));
  for (const iid of pay.sacs || []) if (card(iid) && card(iid).zone === 'battlefield') sacrifice(iid);
  // pain lands and friends: 1 damage (or life) for each colored mana they made
  const hurt = (pay.pains || []).filter((i) => card(i));
  if (hurt.length) {
    changeLife(pid, -hurt.length, false);
    log(pid, `${hurt.map((i) => nameTag(card(i))).join(', ')} ${hurt.length === 1 ? 'costs' : 'cost'} ${pid === 'p' ? 'you' : 'the AI'} ${hurt.length} life.`);
  }
}

export { anyColorCost };
export function emptyPools() {
  if (!G.s || !G.s.pool) return;
  const next = { p: [], ai: [] };
  for (const pid of ['p', 'ai']) {
    const left = G.s.pool[pid] || [];
    if (!left.length) continue;
    const field = cardsIn(pid, 'battlefield').map((x) => oracle(x));
    // Upwelling, Kruphix, Omnath, Horizon Stone…
    if (cardsIn('p', 'battlefield').concat(cardsIn('ai', 'battlefield')).some((x) => /Players don't lose unspent mana as steps and phases end/i.test(oracle(x)))) next[pid] = left;
    else if (field.some((o) => /If you would lose unspent (?:green )?mana, that mana becomes colorless instead/i.test(o))) next[pid] = left.map(() => 'C');
    else if (pid === 'p') log('p', `Unused mana empties from your pool (${left.length}).`);
  }
  G.s.pool = next;
}

// ------------------------------------------------------------ ways to cast a card
function altCost(text, name) {
  const m = text.match(new RegExp('(?:^|\\n)' + name + ' ((?:\\{[^}]+\\})+)', 'i'));
  return m ? m[1] : null;
}
function altCostAny(text, name) {
  const m = text.match(new RegExp('(?:^|\\n)' + name + '(?: ((?:\\{[^}]+\\})+))?(?:—|,? ?)([^\\n(]*)', 'i'));
  return m ? { mana: m[1] || '', other: (m[2] || '').trim().replace(/\.$/, '') } : null;
}

export function castOptions(pid, c) {
  const d = DB[c.def];
  const zone = c.zone;
  const f0 = d.faces[0];
  const o0 = stripName(f0.oracle || '', c);
  const opts = [];
  const add = (o) => opts.push({ face: 0, from: zone, ...o });
  const s = G.s;
  const ts = s.ts[pid];
  if (zone === 'hand' || (zone === 'command' && c.isCommander)) {
    // a card with no mana cost (Lotus Bloom, Ancestral Vision) can't be cast normally — only suspended
    const noCost = !(f0.manaCost || d.manaCost) && /(?:^|\n)Suspend\b/.test(o0);
    if (!isLandFace(f0) && !noCost) add({ mode: 'normal', label: zone === 'command' ? `Cast commander (tax +${commanderTax(pid, c.iid)})` : d.faces[1] && (d.layout === 'split' || d.layout === 'modal_dfc') ? `Cast ${f0.name}` : 'Cast', cost: f0.manaCost || d.manaCost || '' });
    if (d.layout === 'split' && d.faces[1]) {
      add({ mode: 'normal', face: 1, label: `Cast ${d.faces[1].name}`, cost: d.faces[1].manaCost });
      if (/\bFuse\b/.test(d.faces[1].oracle || '') && zone === 'hand') add({ mode: 'fuse', label: 'Cast both halves (fuse)', cost: f0.manaCost + d.faces[1].manaCost });
      if (/\bAftermath\b/.test(d.faces[1].oracle || '')) opts.splice(opts.findIndex((x) => x.face === 1), 1);
    }
    if (d.layout === 'adventure' && d.faces[1]) add({ mode: 'adventure', face: 1, label: `Cast ${d.faces[1].name} (Adventure)`, cost: d.faces[1].manaCost });
    if ((d.layout === 'modal_dfc' || d.layout === 'omen') && d.faces[1] && !isLandFace(d.faces[1])) add({ mode: d.layout === 'omen' ? 'omen' : 'back', face: 1, label: `Cast ${d.faces[1].name}`, cost: d.faces[1].manaCost });
    let m;
    const alts = [
      ['Dash', 'dash'], ['Evoke', 'evoke'], ['Blitz', 'blitz'], ['Bestow', 'bestow'], ['Overload', 'overload'], ['Surge', 'surge'],
      ['Spectacle', 'spectacle'], ['Prowl', 'prowl'], ['Emerge', 'emerge'], ['Warp', 'warp'], ['Freerunning', 'freerunning'], ['Web-slinging', 'webslinging'],
      ['Sneak', 'sneak'],
    ];
    for (const [kw, mode] of alts) {
      const cost = altCost(o0, kw);
      if (!cost) continue;
      if (mode === 'surge' && ts.spells < 1) continue;
      if (mode === 'spectacle' && !(s.ts[opp(pid)].lifeLost > 0)) continue;
      if (mode === 'prowl' && !ts.damagedOpp) continue;
      if (mode === 'freerunning' && !ts.damagedOpp) continue;
      if (mode === 'webslinging' && !cardsIn(pid, 'battlefield').some((x) => isCreature(x) && x.tapped)) continue;
      if (mode === 'sneak' && !(s.combat && s.combat.attackers.some((a) => card(a) && card(a).controller === pid))) continue;
      add({ mode, label: `${kw} ${cost}`, cost });
    }
    // "You may pay {W} and tap four untapped creatures you control with flying rather than pay this spell's mana cost." (Sephara, Force of Will…)
    if ((m = o0.match(/(?:^|\n)You may (.+?) rather than pay (?:this spell's|~'s) mana cost\./i)) && !/^cast\b/i.test(m[1])) {
      let rest = m[1];
      let mana = '';
      const pm = rest.match(/\bpay ((?:\{[^}]+\})+)(?:,? and |, |$)/i);
      if (pm) {
        mana = pm[1];
        rest = rest.replace(pm[0], '').replace(/^,? ?and /i, '').trim();
      }
      if (altPayable(pid, c, rest)) add({ mode: 'altcost', label: `Alternative cost: ${m[1]}`, cost: mana, other: rest || undefined, free: !mana && !rest ? true : undefined });
    }
    if ((m = o0.match(/(?:^|\n)Prototype ((?:\{[^}]+\})+) — (\d+)\/(\d+)/))) add({ mode: 'prototype', label: `Prototype ${m[1]} (${m[2]}/${m[3]})`, cost: m[1], proto: { p: +m[2], t: +m[3] } });
    if ((m = o0.match(/(?:^|\n)Mutate ((?:\{[^}]+\})+)/))) {
      if (cardsIn(pid, 'battlefield').some((x) => isCreature(x) && !hasSubtype(x, 'Human') && x.owner === pid)) add({ mode: 'mutate', label: `Mutate ${m[1]}`, cost: m[1] });
    }
    if ((m = o0.match(/(?:^|\n)Awaken (\d+)—((?:\{[^}]+\})+)/))) add({ mode: 'awaken', label: `Awaken ${m[1]} — ${m[2]}`, cost: m[2], awaken: +m[1] });
    if ((m = o0.match(/(?:^|\n)Impending (\d+)—((?:\{[^}]+\})+)/))) add({ mode: 'impending', label: `Impending ${m[1]} — ${m[2]}`, cost: m[2], impending: +m[1] });
    if (/(?:^|\n)(?:Morph|Megamorph|Disguise) /.test(o0)) add({ mode: 'faceDown', label: 'Cast face down for {3}', cost: '{3}' });
  }
  if (zone === 'graveyard') {
    let a;
    // Locke, Treasure Hunter: "Until end of turn, you may cast a spell from among those cards."
    if (c.mayCastFromGy === pid && c.mayCastFromGyTurn === s.turn && !isLandFace(f0)) add({ mode: 'impulse', label: 'Cast from graveyard (this turn)', cost: f0.manaCost || d.manaCost });
    // Hildibrand Manderville: "you may cast it from your graveyard as an Adventure until the end of your next turn"
    if (c.advFromGyUntil >= s.turn && c.advFromGyBy === pid && d.layout === 'adventure' && d.faces[1]) add({ mode: 'adventure', face: 1, label: `Cast ${d.faces[1].name} (Adventure, from graveyard)`, cost: d.faces[1].manaCost });
    if ((a = altCostAny(o0, 'Flashback'))) add({ mode: 'flashback', label: `Flashback ${a.mana}${a.other ? ' — ' + a.other : ''}`, cost: a.mana, other: a.other });
    else if (c.tempFlashback === s.turn && !isLandFace(f0)) add({ mode: 'flashback', label: `Flashback ${f0.manaCost}`, cost: f0.manaCost });
    if ((a = altCostAny(o0, 'Escape'))) add({ mode: 'escape', label: `Escape ${a.mana}${a.other ? ', ' + a.other : ''}`, cost: a.mana, other: a.other });
    if ((a = altCost(o0, 'Jump-start') !== null ? f0.manaCost : null) !== null && /Jump-start/.test(o0)) add({ mode: 'jumpstart', label: 'Jump-start (discard a card)', cost: f0.manaCost });
    if (/(?:^|\n)Retrace\b/.test(o0)) add({ mode: 'retrace', label: 'Retrace (discard a land)', cost: f0.manaCost });
    if (d.layout === 'split' && d.faces[1] && /\bAftermath\b/.test(d.faces[1].oracle || '')) add({ mode: 'aftermath', face: 1, label: `Cast ${d.faces[1].name} (Aftermath)`, cost: d.faces[1].manaCost });
    const dist = altCost(o0, 'Disturb');
    if (dist && d.faces[1]) add({ mode: 'disturb', face: 1, label: `Disturb ${dist}`, cost: dist });
    const harm = altCost(o0, 'Harmonize');
    if (harm) add({ mode: 'harmonize', label: `Harmonize ${harm}`, cost: harm });
    const may = altCost(o0, 'Mayhem');
    if (may && ts.discarded.includes(c.iid)) add({ mode: 'mayhem', label: `Mayhem ${may}`, cost: may });
    // "You may cast ~ from your graveyard" (not flashback's reminder text "…from your graveyard for its flashback cost")
    if (/You may cast ~ from your graveyard(?! for its)/i.test(o0.replace(/\([^)]*\)/g, ''))) add({ mode: 'fromGraveyard', label: 'Cast from graveyard', cost: f0.manaCost });
    if (cardsIn(pid, 'battlefield').some((x) => /Spells you cast from your graveyard cost|each nonland card in your graveyard has mayhem/i.test(oracle(x))) && ts.discarded.includes(c.iid) && !isLandFace(f0) && !may)
      add({ mode: 'mayhem', label: `Mayhem ${f0.manaCost}`, cost: f0.manaCost });
  }
  if (zone === 'exile') {
    if (c.foretold && c.foretoldTurn < s.turn) {
      const fc = altCost(o0, 'Foretell');
      if (fc) add({ mode: 'foretold', label: `Cast foretold (${fc})`, cost: fc });
    }
    if (c.plotted && c.plottedTurn < s.turn) add({ mode: 'plotted', label: 'Cast plotted card (free)', cost: '', free: true, sorcery: true });
    if (c.onAdventure) add({ mode: 'normal', label: `Cast ${f0.name} (from Adventure)`, cost: f0.manaCost });
    const anyMana = c.anyColorMana || (c.owner !== pid && cardsIn(pid, 'battlefield').some((x) => /You may spend mana as though it were mana of any color to cast spells you don't own/i.test(oracle(x))));
    // Ian Malcolm: only while he's on the battlefield, and one spell each turn
    const ianOk = !c.ianSrc || (card(c.ianSrc) && card(c.ianSrc).zone === 'battlefield' && (s.ianUsed || {})[pid + ':' + c.ianSrc] !== s.turn);
    if (c.mayPlay === pid && (c.mayPlayUntil || 0) >= s.turn && !isLandFace(f0) && (!c.myTurnOnly || s.active === pid) && ianOk) add({ mode: 'impulse', label: anyMana ? 'Cast from exile (mana of any color)' : 'Cast from exile', cost: anyMana ? anyColorCost(f0.manaCost || d.manaCost) : f0.manaCost || d.manaCost });
    if (c.mayPlayFree === pid && (c.mayPlayFreeUntil ?? 1e9) >= s.turn && !isLandFace(f0)) add({ mode: 'hideaway', label: 'Cast for free', cost: '', free: true });
    if (c.warped) add({ mode: 'normal', label: 'Cast (warped earlier)', cost: f0.manaCost });
  }
  return opts.filter((x) => x.cost !== undefined);
}

// Can the non-mana part of an alternative cost be paid right now? (only checks what's easy to check)
function altPayable(pid, c, text) {
  const t = String(text || '').toLowerCase();
  const W = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  let m;
  if ((m = t.match(/tap (a|an|one|two|three|four|five|six|\d+) untapped ([a-z ]+?)s? you control(?: with ([a-z ]+))?(?:$|,| and)/))) {
    const k = W[m[1]] || +m[1];
    const pool = cardsIn(pid, 'battlefield').filter((x) => !x.tapped && matchesFilter(x, m[2]) && (!m[3] || hasKw(x, m[3])));
    if (pool.length < k) return false;
  }
  if ((m = t.match(/pay (\d+) life/)) && G.s.players[pid].life < +m[1]) return false;
  if ((m = t.match(/exile (?:a|an) ([a-z ]+?) card from your hand/)) && !cardsIn(pid, 'hand').some((x) => x.iid !== c.iid && matchesFilter(x, m[1]))) return false;
  return true;
}

// "You may spend mana as though it were mana of any color to cast those spells": colored symbols become generic
function anyColorCost(cost) {
  let gen = 0;
  const keep = [];
  for (const sym of String(cost || '').match(/\{[^}]+\}/g) || []) {
    const v = sym.slice(1, -1);
    if (/^\d+$/.test(v)) gen += +v;
    else if (/^[WUBRG](?:\/[WUBRGP])?$|^[WUBRG]\/P$|^2\/[WUBRG]$/.test(v)) gen += /^2\//.test(v) ? 2 : 1;
    else keep.push(sym);
  }
  return keep.join('') + (gen ? `{${gen}}` : keep.length ? '' : '{0}');
}

// Generic mana added or removed by the card itself and the battlefield.
function genericAdjust(pid, c, opt) {
  const d = DB[c.def];
  const f = d.faces[opt.face || 0] || d.faces[0];
  const o = stripName(f.oracle || '', c);
  let delta = costDelta(pid, c, c.zone);
  if (c.zone === 'command' && c.isCommander) delta += commanderTax(pid, c.iid);
  let m;
  if ((m = o.match(/(?:This spell|~) costs \{(\d+)\} less to cast for each ([^.]+)\./i))) delta -= +m[1] * (countPhrase(pid, m[2], helpers, c.iid) || 0);
  else if ((m = o.match(/(?:This spell|~) costs \{X\} less to cast, where X is (?:the number of |your |the total )?([^.]+)\./i))) delta -= countPhrase(pid, m[1], helpers, c.iid) || 0;
  else if ((m = o.match(/(?:This spell|~) costs \{(\d+)\} less to cast if ([^.]+)\./i))) {
    if (/you control (a|an|two or more) /i.test(m[2]) && cardsIn(pid, 'battlefield').some((x) => matchesFilter(x, m[2].replace(/^.*?you control (?:a|an|two or more) /i, '')))) delta -= +m[1];
    else if (/it targets/i.test(m[2])) delta -= +m[1];
  }
  if ((m = o.match(/Affinity for ([^\n(]+)/i))) delta -= countPhrase(pid, m[1].trim() + ' you control', helpers, c.iid) || 0;
  if (/\bUndaunted\b/.test(o)) delta -= 1;
  if (opt.extraGeneric) delta += opt.extraGeneric;
  return delta;
}

export function effectiveCost(pid, c, opt) {
  return { cost: opt.free ? '' : opt.cost || '', generic: opt.free ? 0 : genericAdjust(pid, c, opt) };
}

// Can this card be cast right now (timing only)?
export function timingOk(pid, c, opt) {
  const s = G.s;
  const d = DB[c.def];
  const f = d.faces[opt.face || 0] || d.faces[0];
  if (opt.sorcery || !(instantFace(f) || hasKw(c, 'flash') || opt.mode === 'faceDown' && false)) {
    const flashAll = cardsIn(pid, 'battlefield').some((x) => /You may cast (?:spells|creature spells|[a-z ]+ spells) as though they had flash/i.test(oracle(x)) &&
      (/You may cast spells/i.test(oracle(x)) || (/creature spells/i.test(oracle(x)) && /Creature/.test(f.typeLine))));
    if (flashAll && !opt.sorcery) return true;
    return s.active === pid && (s.step === 'main1' || s.step === 'main2') && !s.stack && !(s.combat && s.combat.stage && s.combat.stage !== 'declare');
  }
  return true;
}

// ------------------------------------------------------------ casting
/**
 * env: {choosers, pay(pid, cost, label, opts) -> pay|null, render, wait, respond(iid) -> 'resolve'|'counter',
 *       aiCounter(spell) -> bool, pos, free, costOverride, mode, quiet}
 * Returns true when the spell was cast.
 */
export async function castSpell(pid, iid, opt, env) {
  const s = G.s;
  const c = card(iid);
  if (!c) return false;
  const d = DB[c.def];
  const ch = env.choosers[pid];
  const fIdx = opt.face || 0;
  const f = d.faces[fIdx] || d.faces[0];
  const o = stripName(f.oracle || '', c);
  const fromZone = c.zone;
  if (s.silenced && s.silenced.pid === pid && s.silenced.turn === s.turn && !opt.copy) {
    log(pid, `${who_(pid)} can't cast spells this turn.`);
    return false;
  }
  if (c.faceDown && fromZone === 'exile' && opt.mode !== 'faceDown') c.faceDown = false; // foretold / hidden cards are revealed as they're cast
  const info = { kicked: 0, x: 0, modes: null, gift: false, bargained: false, additionalPaid: false, entwined: false, buyback: false, replicate: 0, squad: 0, offspring: false, casualty: null, extraGeneric: 0, spreeCost: '' };
  const label = f.name;
  // --- modes chosen up front when they change the cost (escalate, spree, entwine, tiered)
  const modal = (spellText({ ...c, face: fIdx }) || '').match(/Choose (one|two|three|one or both|one or more|any number)[^—]*—\s*\n?((?:\s*•[^\n]*\n?)+)/i);
  const escalate = kwCost(c, 'Escalate', o);
  const entwine = altCost(o, 'Entwine');
  const spree = /(?:^|\n)Spree\b/.test(o);
  const tiered = /(?:^|\n)Tiered\b/.test(o);
  if (modal && (escalate || spree || entwine || tiered)) {
    const modes = modal[2].split('•').map((x) => x.trim()).filter(Boolean);
    if (entwine) {
      const yes = await ch.confirm(label, `Pay entwine ${entwine} to choose all modes?`, { cost: entwine });
      if (yes) {
        info.entwined = true;
        info.extraMana = (info.extraMana || '') + entwine;
        info.modes = modes.map((_, k) => k);
      }
    }
    if (!info.modes) {
      const want = modal[1].toLowerCase();
      const max = /^one$/.test(want) ? 1 : /^two$/.test(want) ? 2 : modes.length;
      info.modes = await ch.chooseModes({
        prompt: `${label}: choose ${want}`, modes, min: /any number/.test(want) ? 0 : 1, max: spree || escalate ? modes.length : max, src: c, spree, escalate: escalate && escalate.mana,
        aiScore: (t) => Object.keys(analyze(t)).length,
      });
      if (!info.modes || (!info.modes.length && !/any number/.test(want))) throw new Cancelled();
      if (escalate && info.modes.length > 1) for (let k = 1; k < info.modes.length; k++) info.extraMana = (info.extraMana || '') + escalate.mana;
      if (spree || tiered) for (const k of info.modes) {
        const sm = modes[k].match(/^\+((?:\{[^}]+\})+)/);
        if (sm) info.extraMana = (info.extraMana || '') + sm[1];
      }
    }
  }
  // --- kicker / multikicker
  const kick = o.match(/(?:^|\n)Kicker((?: (?:\{[^}]+\})+| — [^\n]+)?)(?: and\/or ((?:\{[^}]+\})+))?/i);
  if (kick && !env.free) {
    const k1 = (kick[1] || '').trim();
    if (k1.startsWith('{')) {
      const yes = await ch.confirm(label, `Kick ${label} for ${k1}?`, { cost: k1, kicker: true });
      if (yes) {
        info.kicked = 1;
        info.extraMana = (info.extraMana || '') + k1;
      }
      if (kick[2] && (await ch.confirm(label, `Also pay the second kicker ${kick[2]}?`, { cost: kick[2], kicker: true }))) {
        info.kicked2 = true;
        info.extraMana = (info.extraMana || '') + kick[2];
      }
    } else if (/sacrifice|discard|pay \d+ life/i.test(k1)) {
      const yes = await ch.confirm(label, `Kicker — ${k1.replace(/^—\s*/, '')}?`, {});
      if (yes && (await payOtherCost(pid, k1.replace(/^—\s*/, ''), c, env))) info.kicked = 1;
    }
  }
  const mk = altCost(o, 'Multikicker');
  if (mk && !env.free) {
    const times = await ch.chooseNumber({ prompt: `Multikicker ${mk}: how many times?`, min: 0, max: 10, ai: 0 });
    for (let k = 0; k < times; k++) info.extraMana = (info.extraMana || '') + mk;
    info.kicked = times;
  }
  const bb = altCost(o, 'Buyback');
  if (bb && !env.free && (await ch.confirm(label, `Pay buyback ${bb} to return ${label} to your hand?`, { cost: bb }))) {
    info.buyback = true;
    info.extraMana = (info.extraMana || '') + bb;
  }
  const rep = altCost(o, 'Replicate');
  if (rep && !env.free) {
    info.replicate = await ch.chooseNumber({ prompt: `Replicate ${rep}: how many copies?`, min: 0, max: 8, ai: 0 });
    for (let k = 0; k < info.replicate; k++) info.extraMana = (info.extraMana || '') + rep;
  }
  const sq = altCost(o, 'Squad');
  if (sq && !env.free) {
    info.squad = await ch.chooseNumber({ prompt: `Squad ${sq}: how many copies?`, min: 0, max: 6, ai: 0 });
    for (let k = 0; k < info.squad; k++) info.extraMana = (info.extraMana || '') + sq;
  }
  const off = altCost(o, 'Offspring');
  if (off && !env.free && (await ch.confirm(label, `Pay offspring ${off}?`, { cost: off }))) {
    info.offspring = true;
    info.extraMana = (info.extraMana || '') + off;
  }
  const gift = o.match(/(?:^|\n)Gift an? ([^\n(]+)/i);
  if (gift) info.gift = await ch.confirm(label, `Promise the gift (${gift[1].trim()}) to your opponent?`, { gift: true });
  if (/(?:^|\n)Bargain\b/.test(o)) {
    const pool = cardsIn(pid, 'battlefield').filter((x) => isType(x, 'Artifact') || isType(x, 'Enchantment') || x.token);
    if (pool.length && (await ch.confirm(label, 'Bargain: sacrifice an artifact, enchantment, or token?', { bargain: true }))) {
      const [pick] = await ch.pickCards({ prompt: 'Bargain: choose what to sacrifice', cards: pool.map((x) => x.iid), min: 1, max: 1, purpose: 'sacrifice', src: c, aiScore: (x) => -cardValue(x) + (x.token ? 3 : 0) });
      if (pick) {
        sacrifice(pick);
        info.bargained = true;
      }
    }
  }
  const cas = o.match(/(?:^|\n)Casualty (\d+|X)/i);
  if (cas) {
    const nn = cas[1] === 'X' ? 0 : +cas[1];
    const pool = cardsIn(pid, 'battlefield').filter((x) => isCreature(x) && power(x) >= nn);
    if (pool.length && (await ch.confirm(label, `Casualty ${cas[1]}: sacrifice a creature with power ${nn} or greater to copy this spell?`, { casualty: true }))) {
      const [pick] = await ch.pickCards({ prompt: 'Casualty: choose a creature to sacrifice', cards: pool.map((x) => x.iid), min: 1, max: 1, purpose: 'sacrifice', src: c, aiScore: (x) => -cardValue(x) });
      if (pick) {
        sacrifice(pick);
        info.casualty = true;
      }
    }
  }
  // --- additional costs printed as "As an additional cost to cast this spell, …"
  const addl = o.match(/As an additional cost to cast (?:this spell|~), ([^.]+)\./i);
  const wbm = addl && addl[1].match(/^(you may )?waterbend \{(\d+|X)\}$/i);
  if (wbm) {
    // waterbend: extra generic mana that your untapped artifacts and creatures can help pay
    let n = wbm[2] === 'X' ? (env.x !== undefined ? env.x : await ch.chooseNumber({ prompt: `${label}: waterbend X — choose X`, min: 0, max: 20, ai: 2 })) : +wbm[2];
    let go = true;
    if (wbm[1]) go = await ch.confirm(label, `Waterbend {${n}} as an additional cost? (Tap artifacts and creatures to help pay.)`, {});
    if (go) {
      info.extraGeneric += n;
      info.waterbend = n;
      info.additionalPaid = true;
      if (wbm[2] === 'X') info.waterbendX = n;
    }
  } else if (addl && /^(.+?) or pay ((?:\{[^}]+\})+)$/i.test(addl[1])) {
    // "blight 2 or pay {1}": either one
    const om = addl[1].match(/^(.+?) or pay ((?:\{[^}]+\})+)$/i);
    const canOther = !/^blight/i.test(om[1]) || cardsIn(pid, 'battlefield').some(isCreature);
    const k = canOther ? await ch.choose({ prompt: `${label}: additional cost`, options: [{ label: om[1].replace(/^\w/, (x) => x.toUpperCase()) }, { label: `Pay ${om[2]}` }], aiPick: () => (cardsIn(pid, 'battlefield').some((x) => isCreature(x) && x.token) ? 0 : 1) }) : 1;
    if (k === 0) {
      if (!(await payOtherCost(pid, om[1], c, env))) throw new Cancelled();
    } else info.extraMana = (info.extraMana || '') + om[2];
    info.additionalPaid = true;
  } else if (addl && !/^you may/i.test(addl[1])) {
    if (!(await payOtherCost(pid, addl[1], c, env))) throw new Cancelled();
    info.additionalPaid = true;
  } else if (addl && /^you may/i.test(addl[1])) {
    if (await ch.confirm(label, `Additional cost: ${addl[1].replace(/^you may /i, '')}?`, {})) info.additionalPaid = await payOtherCost(pid, addl[1].replace(/^you may /i, ''), c, env);
  }
  // --- alternative-cost extras
  if (opt.other) {
    if (!(await payOtherCost(pid, opt.other, c, env))) throw new Cancelled();
  }
  if (opt.mode === 'jumpstart') {
    if (!(await payOtherCost(pid, 'discard a card', c, env))) throw new Cancelled();
  }
  if (opt.mode === 'retrace') {
    if (!(await payOtherCost(pid, 'discard a land card', c, env))) throw new Cancelled();
  }
  if (opt.mode === 'emerge') {
    const pool = cardsIn(pid, 'battlefield').filter(isCreature);
    const [pick] = pool.length ? await ch.pickCards({ prompt: 'Emerge: sacrifice a creature (its mana value reduces the cost)', cards: pool.map((x) => x.iid), min: 1, max: 1, purpose: 'sacrifice', src: c, aiScore: (x) => DB[x.def].cmc - cardValue(x) / 2 }) : [];
    if (!pick) throw new Cancelled();
    info.extraGeneric -= DB[card(pick).def].cmc;
    sacrifice(pick);
  }
  if (opt.mode === 'webslinging') {
    const pool = cardsIn(pid, 'battlefield').filter((x) => isCreature(x) && x.tapped);
    const [pick] = await ch.pickCards({ prompt: 'Web-slinging: return a tapped creature you control to your hand', cards: pool.map((x) => x.iid), min: 1, max: 1, purpose: 'bounce', src: c, aiScore: (x) => -cardValue(x) });
    if (!pick) throw new Cancelled();
    move(pick, 'hand');
  }
  if (opt.mode === 'harmonize') {
    const pool = cardsIn(pid, 'battlefield').filter((x) => isCreature(x) && !x.tapped);
    if (pool.length && (await ch.confirm(label, 'Harmonize: tap a creature to reduce the cost by its power?', {}))) {
      const [pick] = await ch.pickCards({ prompt: 'Tap a creature', cards: pool.map((x) => x.iid), min: 1, max: 1, purpose: 'tap', src: c, aiScore: power });
      if (pick) {
        info.extraGeneric -= power(card(pick));
        card(pick).tapped = true;
      }
    }
  }
  // --- X and paying
  let costStr = (env.costOverride !== undefined ? env.costOverride : opt.cost || '') + (info.extraMana || '');
  if (env.free || opt.free) costStr = (info.extraMana || '');
  const eff = env.free || opt.free ? { generic: 0 } : effectiveCost(pid, c, opt);
  const extraGeneric = eff.generic + info.extraGeneric;
  const pay = await env.pay(pid, costStr, label, {
    extraGeneric, convoke: hasKw(c, 'convoke'), improvise: hasKw(c, 'improvise'), delve: hasKw(c, 'delve'), self: c.iid, waterbend: info.waterbend || 0,
    xFixed: env.x,
  });
  if (!pay) throw new Cancelled();
  applyPayment(pid, pay);
  c.convokedBy = (pay.special || []).filter((x) => x.kind === 'convoke').map((x) => x.iid); // Lethal Scheme: "each creature that convoked it"
  if (c.lockeGroup) for (const x of Object.values(s.cards)) if (x.lockeGroup === c.lockeGroup) delete x.mayCastFromGy;
  if (c.ianSrc && opt.mode === 'impulse') s.ianUsed = { ...(s.ianUsed || {}), [pid + ':' + c.ianSrc]: s.turn };
  info.x = env.x !== undefined ? env.x : pay.x || 0;
  if (info.waterbendX !== undefined) info.x = info.waterbendX;
  // --- the spell is on the stack
  if (fromZone === 'command' && c.isCommander) s.players[pid].tax[c.iid] = (s.players[pid].tax[c.iid] || 0) + 1;
  const ts = s.ts[pid];
  ts.spells++;
  if (fromZone === 'hand') ts.spellsFromHand = (ts.spellsFromHand || 0) + 1; // Jem Lightfoote
  else if (!opt.copy) ts.spellsNotHand = (ts.spellsNotHand || 0) + 1; // The Twelfth Doctor: "the first spell you cast from anywhere other than your hand"
  if (!/Creature/.test(f.typeLine)) ts.noncreatureSpells++;
  if (opt.mode === 'warp') s.ts.warped = true;
  Object.assign(c, { castMode: opt.mode === 'normal' ? null : opt.mode, kicked: info.kicked, xPaid: info.x, castFrom: fromZone, castFace: fIdx });
  c.colorsSpent = new Set((f.manaCost || '').match(/[WUBRG]/g) || []).size;
  const tag = `${pid === 'p' ? 'You cast' : 'AI casts'} ${opt.mode === 'faceDown' ? 'a card face down' : nameTag({ ...c, face: fIdx })}${fromZone === 'hand' && c.owner !== pid ? (c.owner === 'p' ? ' from your hand' : " from the AI's hand") : fromZone === 'command' ? ' from the command zone' : fromZone === 'graveyard' ? ' from the graveyard' : fromZone === 'exile' ? ' from exile' : ''}${opt.mode && !/^(normal|faceDown|back|adventure|impulse)$/.test(opt.mode) ? ` (${opt.mode === 'altcost' ? 'alternative cost' : opt.mode})` : ''}${info.kicked ? ' (kicked)' : ''}${info.x ? ` (X = ${info.x})` : ''}.`;
  log(pid, tag);
  const stackSlot = pid === 'p' && s.stack ? 'pstack' : pid === 'p' ? 'pstack' : 'stack';
  s[stackSlot] = { iid, by: pid, face: fIdx };
  fire({ type: 'castSelf', iid, controller: pid });
  fire({ type: 'cast', iid, def: c.def, controller: pid });
  env.render();
  await settle();
  if (G.s !== s) return false;
  // storm / gravestorm / replicate / casualty copies, cascade
  let copies = (hasKw(c, 'storm') ? ts.spells - 1 + s.ts[opp(pid)].spells : 0) + info.replicate + (info.casualty ? 1 : 0);
  // Way of the Cryomancer: "When you next cast an instant or sorcery spell this turn, copy that spell."
  // Jace Reawakened −6: copy every spell this turn
  if (s.copyAll && s.copyAll.pid === pid && s.copyAll.turn === s.turn && !opt.copy) {
    copies += 1;
    log(pid, `${nameTag(c)} is copied.`);
  }
  if (s.copyNext && s.copyNext.length && !opt.copy) {
    const tl = (d.faces[fIdx] || d.faces[0]).typeLine || d.typeLine;
    const k = s.copyNext.findIndex((e) => e.pid === pid && e.turn === s.turn && new RegExp(e.types.join('|'), 'i').test(tl));
    if (k >= 0) {
      copies += 1;
      s.copyNext.splice(k, 1);
      log(pid, `${nameTag(c)} is copied.`);
    }
  }
  let cascades = (oracle({ ...c, face: fIdx }).replace(/\([^)]*\)/g, '').match(/(?:^|\n|, )cascade\b/gi) || []).length;
  // --- responses
  let countered = false;
  // Jace, Unraveler of Secrets emblem: "Whenever an opponent casts their first spell each turn, counter that spell."
  if (!opt.copy && ts.spells === 1 && !cantBeCountered(c) && ((s.players[opp(pid)].emblems || []).some((e) => /Whenever an opponent casts their first spell each turn, counter that spell/i.test(e)))) {
    log(opp(pid), `The emblem counters ${nameTag(c)} (first spell this turn).`);
    s[stackSlot] = s[stackSlot] || {};
    s[stackSlot].countered = true;
    countered = true;
  }
  const splitSecond = hasKw(c, 'split second');
  if (!countered && !splitSecond && !cantBeCountered(c)) {
    if (pid === 'ai' && env.respond && !aiSlaved()) {
      // announce the targets so you can see them while deciding whether to respond
      const ch0 = env.choosers[pid];
      if (ch0 && !isPermanentCard({ faces: [d.faces[fIdx] || d.faces[0]] })) {
        ch0.plan = null;
        const tg = await predictTargets(pid, c, fIdx, { ...env.choosers, [opp(pid)]: ch0 }, info.x || 0).catch(() => []);
        if (tg.length) {
          ch0.plan = tg.slice();
          if (s[stackSlot]) s[stackSlot].targets = tg;
          env.render();
        }
      }
      const verdict = await env.respond(iid);
      if (G.s !== s) return false;
      countered = verdict === 'counter' || !!(s.stack && s.stack.countered);
    } else if (pid === 'p' && env.aiCounter && !aiSlaved()) {
      countered = await env.aiCounter(c);
    }
  }
  const exileCountered = s[stackSlot] && s[stackSlot].exileCountered;
  const bounced = s[stackSlot] && s[stackSlot].bounced;
  const counteredByEffect = !!(s[stackSlot] && s[stackSlot].countered);
  s[stackSlot] = null;
  if (countered) {
    if (pid === 'ai' && !counteredByEffect) log(opp(pid), `You counter ${nameTag(c)}.`);
    move(iid, bounced ? 'hand' : exileCountered || /^(flashback|escape|jumpstart|disturb)$/.test(opt.mode) ? 'exile' : 'graveyard');
    env.render();
    return true;
  }
  // cascade: exile until a nonland card with lesser mana value, cast it free
  for (; cascades > 0; cascades--) await cascade(pid, DB[c.def].cmc, env);
  for (let k = 0; k < copies; k++) await resolveCopy(pid, c, fIdx, info, env);
  // --- resolve
  // while it resolves, the spell isn't in its old zone as far as effects can see ("put two cards from your hand…")
  s.resolving = [...(s.resolving || []), iid];
  try {
    await resolveSpell(pid, c, opt, info, env);
  } finally {
    s.resolving = (s.resolving || []).filter((x) => x !== iid);
    if (env.choosers[pid] && env.choosers[pid].plan) env.choosers[pid].plan = null;
  }
  stateBased();
  env.render();
  if (G.s === s) await settle();
  return true;
}

function cantBeCountered(c) {
  if (/(?:This spell|~) can't be countered|can't be countered\./i.test(face(c).oracle || '')) return true;
  return cardsIn(c.owner, 'battlefield').some((p) => /^(?:Spells|Creature spells|Noncreature spells) you control can't be countered/m.test(oracle(p)));
}

function altCost_(text, name) {
  return altCost(text, name);
}

async function resolveCopy(pid, c, fIdx, info, env) {
  const d = DB[c.def];
  const f = d.faces[fIdx] || d.faces[0];
  if (isPermanentCard({ faces: [f] })) {
    const [tok] = createToken(c.def, pid, 1);
    card(tok).face = fIdx;
    log(pid, `A copy of ${nameTag(c)} enters as a token.`);
    return;
  }
  const did = await resolveEffects(spellText({ ...c, face: fIdx }), { ...c, face: fIdx }, ctxFor(pid, env, { kicked: info.kicked, x: info.x, modes: info.modes }));
  log(pid, `Copy of ${nameTag(c)}: ${did.join('; ') || 'resolves'}.`);
}

async function cascade(pid, mv, env) {
  const lib = zoneOf(pid, 'library');
  const exiled = [];
  let hit = null;
  while (lib.length) {
    const iid = lib[lib.length - 1];
    const x = card(iid);
    move(iid, 'exile');
    if (!isLand(x) && DB[x.def].cmc < mv) {
      hit = x;
      break;
    }
    exiled.push(iid);
  }
  if (hit) {
    log(pid, `Cascade reveals ${nameTag(hit)}.`);
    const yes = await env.choosers[pid].confirm(cardName(hit), `Cascade: cast ${cardName(hit)} without paying its mana cost?`, {});
    if (yes) await castFree(pid, hit.iid, env);
    else exiled.push(hit.iid);
  }
  exiled.sort(() => Math.random() - 0.5).forEach((i) => card(i) && card(i).zone === 'exile' && move(i, 'library', { to: 'bottom' }));
}

export async function castFree(pid, iid, env, extra = {}) {
  const c = card(iid);
  if (!c) return false;
  const d = DB[c.def];
  if (extra.copy) {
    // a copy of the card (cipher, "copy the exiled card"): resolve it without moving the card
    const did = await resolveEffects(spellText(c), c, ctxFor(pid, env));
    log(pid, `Copy of ${nameTag(c)}: ${did.join('; ') || 'resolves'}.`);
    return true;
  }
  let fIdx = 0;
  if (d.faces.length > 1 && (d.layout === 'adventure' || d.layout === 'split' || d.layout === 'modal_dfc') && !isLandFace(d.faces[1])) {
    fIdx = await env.choosers[pid].choose({ prompt: `Cast which half of ${d.name}?`, options: d.faces.map((x) => ({ label: x.name })), aiPick: () => 0 });
  }
  if (isLandFace(d.faces[fIdx])) return false;
  try {
    return await castSpell(pid, iid, { mode: extra.mode || 'free', face: fIdx, cost: extra.cost || '', free: !extra.cost }, { ...env, free: !extra.cost, costOverride: extra.cost });
  } catch (e) {
    if (e instanceof Cancelled) return false;
    throw e;
  }
}

function ctxFor(pid, env, extra = {}) {
  return {
    me: pid, choosers: env.choosers, castFree: (p, i) => castFree(p, i, env), stackTarget: pid === 'p' && G.s.stack ? G.s.stack.iid : pid === 'ai' && G.s.pstack ? G.s.pstack.iid : null,
    ...extra,
  };
}

async function resolveSpell(pid, c, opt, info, env) {
  const s = G.s;
  const d = DB[c.def];
  const fIdx = opt.face || 0;
  const f = d.faces[fIdx] || d.faces[0];
  const ch = env.choosers[pid];
  const ctx = ctxFor(pid, env, {
    kicked: info.kicked, x: info.x, modes: info.modes, entwined: info.entwined, gift: info.gift, bargained: info.bargained,
    additionalPaid: info.additionalPaid, castFrom: c.castFrom, castMode: opt.mode,
  });
  // the gift goes to the opponent first
  if (info.gift) {
    const gm = (oracle({ ...c, face: fIdx }).match(/Gift an? ([^\n(]+)/i) || [])[1] || '';
    const o2 = opp(pid);
    if (/card/i.test(gm)) draw(o2, 1, true);
    else if (/Food/i.test(gm)) createToken(genericTokenDef(0, 0, 'Food'), o2, 1);
    else if (/Treasure/i.test(gm)) createToken(genericTokenDef(0, 0, 'Treasure'), o2, 1);
    else if (/Fish/i.test(gm)) createToken(genericTokenDef(1, 1, 'Fish', ['U']), o2, 1, { tapped: /tapped/i.test(gm) });
    else if (/Octopus/i.test(gm)) createToken(genericTokenDef(8, 8, 'Octopus', ['U']), o2, 1);
    else if (/extra turn/i.test(gm)) s.extraTurns[o2]++;
    log(pid, `The gift (${esc(gm.trim())}) goes to ${o2 === 'p' ? 'you' : 'the AI'}.`);
  }
  const permanent = isPermanentCard({ faces: [f] }) && opt.mode !== 'adventure' && opt.mode !== 'fuse' && opt.mode !== 'omen';
  if (permanent) {
    c.face = fIdx;
    if (opt.mode === 'faceDown') {
      toBattlefield(c.iid, pid, { faceDown: true, ...(env.pos || {}) });
      c.morph = (oracle({ ...c, faceDown: false }).match(/(?:^|\n)(Morph|Megamorph|Disguise) ((?:\{[^}]+\})+)/) || []).slice(1);
      if (/Disguise/.test(c.morph[0] || '')) c.wardTwo = true;
      return;
    }
    if (opt.mode === 'mutate') {
      const pool = cardsIn(pid, 'battlefield').filter((x) => isCreature(x) && !hasSubtype(x, 'Human') && x.owner === pid);
      const pick = await ch.target({ forced: true, prompt: 'Mutate onto which creature?', candidates: pool.map((x) => x.iid), harm: false, src: c });
      const host = pick && pick.iid ? card(pick.iid) : null;
      if (host) {
        const onTop = await ch.choose({ prompt: `Put ${cardName(c)} on top or underneath?`, options: [{ label: 'On top (its name, P/T and types)' }, { label: 'Underneath (keep the host)' }], aiPick: () => (power(c) + toughness(c) > power(host) + toughness(host) ? 0 : 1) });
        mergeMutate(c, host, onTop === 0, pid);
        log(pid, `${nameTag(c)} mutates ${onTop === 0 ? 'onto' : 'under'} ${nameTag(host)}.`);
        queueEvent({ type: 'mutates', iid: onTop === 0 ? c.iid : host.iid, controller: pid });
        return;
      }
    }
    if (opt.mode === 'bestow') {
      const pool = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter(isCreature);
      if (pool.length) {
        toBattlefield(c.iid, pid, env.pos || {});
        c.bestowed = true;
        c.addTypes = '— Aura';
        await attachAura(c, pid, ch, { bestow: true });
        if (!c.attachedTo) delete c.bestowed;
        return;
      }
    }
    if (hasSubtype({ ...c, face: fIdx }, 'Aura') && !/^Enchant (?:player|opponent)/m.test(oracle(c))) {
      const did = await attachAura(c, pid, ch);
      if (did.length && /^is countered/.test(did[0])) {
        log(pid, `${nameTag(c)} ${did[0]}.`);
        move(c.iid, 'graveyard');
        return;
      }
      if (!did.length && /^Enchant /m.test(oracle(c))) {
        log(pid, `${nameTag(c)} has nothing to enchant and goes to the graveyard.`);
        move(c.iid, 'graveyard');
        return;
      }
      toBattlefield(c.iid, pid, env.pos || {});
      if (did.length) log(pid, `${nameTag(c)} ${did.join('; ')}.`);
      return;
    }
    if (opt.mode === 'prototype') c.proto = opt.proto;
    if (opt.mode === 'impending') c.impending = true;
    toBattlefield(c.iid, pid, env.pos || {});
    // Curses and other "Enchant player" Auras sit on the battlefield and remember whom they enchant
    const ep = hasSubtype(c, 'Aura') && oracle(c).match(/^Enchant (player|opponent)/m);
    if (ep) {
      c.enchantedPlayer = opp(pid);
      if (ep[1] === 'player' && pid === 'p') {
        const k = await env.choosers[pid].choose({ prompt: `${cardName(c)}: enchant which player?`, options: [{ label: 'The AI' }, { label: 'Yourself' }], aiPick: () => 0 });
        c.enchantedPlayer = k === 1 ? 'p' : 'ai';
      }
      log(pid, `${nameTag(c)} enchants ${c.enchantedPlayer === 'p' ? 'you' : 'the AI'}.`);
    }
    if (opt.mode === 'impending') addCounters(c, 'time', opt.impending, { silent: true });
    if (opt.mode === 'dash') {
      c.grants = [...(c.grants || []), 'haste'];
      c.endOfTurn = 'hand';
    }
    if (opt.mode === 'blitz') {
      c.grants = [...(c.grants || []), 'haste'];
      c.endOfTurn = 'sacrifice';
      c.castMode = 'blitz';
    }
    if (opt.mode === 'warp') c.endOfTurn = 'warp';
    if (opt.mode === 'escape') {
      const em = oracle(c).match(/escapes with (a|an|one|two|three|four|five|\d+) \+1\/\+1 counters?/i);
      if (em) addCounters(c, '+1/+1', { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 }[em[1].toLowerCase()] || +em[1]);
      if (/escapes? with haste|it gains haste/i.test(oracle(c))) c.grants = [...(c.grants || []), 'haste'];
    }
    if (info.squad) c.squadCount = info.squad;
    if (info.offspring) c.offspringPaid = true;
    if (opt.mode === 'evoke') c.castMode = 'evoke';
    return;
  }
  // --- instants and sorceries (and adventures, fused halves)
  let text = '';
  if (opt.mode === 'fuse') text = spellText({ ...c, face: 0 }) + '\n' + spellText({ ...c, face: 1 });
  else text = spellText({ ...c, face: fIdx });
  if (opt.mode === 'overload') text = text.replace(/\btarget\b/gi, 'each').replace(/\beach (creature|permanent|artifact|enchantment|nonland permanent)(?! you)/gi, 'each $1').replace(/each ([a-z ]+?) you don't control/gi, "each $1 your opponents control");
  if (opt.mode === 'awaken') {
    // awaken: a land you control becomes a 0/0 Elemental with haste and N +1/+1 counters
    const lands = cardsIn(pid, 'battlefield').filter(isLand);
    const pick = lands.length ? await ch.target({ forced: true, prompt: `Awaken ${opt.awaken}: choose a land you control`, candidates: lands.map((x) => x.iid), harm: false, src: c }) : null;
    if (pick && pick.iid) {
      const l = card(pick.iid);
      l.animated = { p: 0, t: 0, types: 'Elemental', until: 'forever' };
      l.grants = [...(l.grants || []), 'haste'];
      addCounters(l, '+1/+1', opt.awaken);
      log(pid, `${nameTag(l)} awakens.`);
    }
  }
  const did = await resolveEffects(text, { ...c, face: fIdx }, ctx);
  log(pid, did.length ? `${nameTag({ ...c, face: fIdx })} resolves: ${did.join('; ')}.` : `${nameTag({ ...c, face: fIdx })} resolves — its effect isn't automated, apply it by hand.`);
  if (G.s !== s || !card(c.iid)) return;
  // where it goes now
  const o = oracle({ ...c, face: fIdx });
  if (opt.mode === 'adventure') {
    move(c.iid, 'exile');
    c.onAdventure = true;
  } else if (opt.mode === 'omen') {
    move(c.iid, 'library');
    shuffle(c.owner);
  } else if (info.buyback) move(c.iid, 'hand');
  else if (/^(flashback|escape|jumpstart|disturb|aftermath|harmonize)$/.test(opt.mode)) move(c.iid, 'exile');
  else if (/\bRebound\b/.test(o) && c.castFrom === 'hand') {
    move(c.iid, 'exile');
    c.rebound = true;
    s.delayed.push({ at: 'upkeep', kind: 'rebound', iid: c.iid, pid, turnOf: pid, after: s.turn });
  } else if (/\bCipher\b/.test(o)) {
    const pool = cardsIn(pid, 'battlefield').filter(isCreature);
    const pick = pool.length ? await ch.target({ prompt: 'Cipher: encode this spell on a creature you control', candidates: pool.map((x) => x.iid), harm: false, src: c, optional: true }) : null;
    move(c.iid, 'exile');
    if (pick && pick.iid) {
      c.encodedOn = pick.iid;
      log(pid, `${nameTag(c)} is encoded on ${nameTag(card(pick.iid))}.`);
    }
  } else if (/^Shuffle ~ into its owner's library/m.test(o)) {
    move(c.iid, 'library');
    shuffle(c.owner);
  } else if (/Exile (?:~|this spell) with (\w+) time counters on it/i.test(stripName(o, c))) {
    // Rousing Refrain: "Exile Rousing Refrain with three time counters on it." — it's suspended again
    const k = { one: 1, two: 2, three: 3, four: 4, five: 5 }[(stripName(o, c).match(/Exile (?:~|this spell) with (\w+) time counters/i) || [])[1].toLowerCase()] || 3;
    move(c.iid, 'exile');
    const cc = card(c.iid);
    if (cc) {
      cc.suspended = true;
      cc.counters = { ...(cc.counters || {}), time: k };
      log(pid, `${nameTag(cc)} is exiled with ${k} time counters (suspended).`);
    }
  } else move(c.iid, 'graveyard');
}

function mergeMutate(c, host, onTop, pid) {
  const state = { tapped: host.tapped, counters: host.counters, damage: host.damage, sick: host.sick, x: host.x, y: host.y, attacking: host.attacking, auraBuffs: host.auraBuffs, grants: host.grants };
  if (onTop) {
    const under = [host.iid, ...(host.merged || [])];
    host.merged = [];
    // swap the battlefield slot to the new top card
    const arr = G.s.players[host.controller].zones.battlefield;
    arr[arr.indexOf(host.iid)] = c.iid;
    const fromArr = G.s.players[c.owner].zones[c.zone];
    if (fromArr && fromArr.indexOf(c.iid) >= 0) fromArr.splice(fromArr.indexOf(c.iid), 1);
    host.zone = 'merged';
    Object.assign(c, state, { zone: 'battlefield', controller: pid, merged: under, enteredTurn: host.enteredTurn });
    for (const a of Object.values(G.s.cards)) if (a.attachedTo === host.iid) a.attachedTo = c.iid;
  } else {
    const fromArr = G.s.players[c.owner].zones[c.zone];
    if (fromArr && fromArr.indexOf(c.iid) >= 0) fromArr.splice(fromArr.indexOf(c.iid), 1);
    c.zone = 'merged';
    host.merged = [...(host.merged || []), c.iid];
  }
}

// "Sacrifice a creature", "Discard a card", "Pay 3 life", "Exile three other cards from your graveyard", "Tap an untapped creature you control"…
export async function payOtherCost(pid, text, src, env) {
  const t = text.toLowerCase().replace(/\.$/, '');
  const ch = env.choosers[pid];
  const parts = t.split(/, and |, | and (?=sacrifice|discard|pay|exile|tap|return|remove|collect|forage|reveal)/);
  for (const p of parts) {
    let m;
    // blight N: put N -1/-1 counters on a creature you control
    if ((m = p.match(/^blight (\d+)$/))) {
      const pool = cardsIn(pid, 'battlefield').filter(isCreature);
      if (!pool.length) return false;
      const [pick] = await ch.pickCards({ prompt: `Blight ${m[1]}: put ${m[1]} -1/-1 counter${+m[1] > 1 ? 's' : ''} on a creature you control`, cards: pool.map((x) => x.iid), min: 1, max: 1, purpose: 'blight', src, aiScore: (x) => (x.token ? 5 : 0) + toughness(x) - cardValue(x) / 3 });
      if (!pick) return false;
      addCounters(card(pick), '-1/-1', +m[1], { by: pid });
      log(pid, `${pid === 'p' ? 'You blight' : 'The AI blights'} ${m[1]} (${nameTag(card(pick))}).`);
      continue;
    }
    if ((m = p.match(/^sacrifice (a|an|one|two|three|another|\d+|x) (.+)$/))) {
      const k = { a: 1, an: 1, one: 1, two: 2, three: 3, another: 1 }[m[1]] || +m[1] || 1;
      const pool = cardsIn(pid, 'battlefield').filter((x) => x.iid !== src.iid && matchesFilter(x, m[2].replace(/s$/, '')));
      if (pool.length < k) return false;
      const picks = await ch.pickCards({ prompt: `Sacrifice ${k === 1 ? 'a' : k} ${m[2]}`, cards: pool.map((x) => x.iid), min: k, max: k, purpose: 'sacrifice', src, aiScore: (x) => -cardValue(x) + (x.token ? 3 : 0) });
      if (picks.length < k) return false;
      picks.forEach((i) => sacrifice(i));
      continue;
    }
    if ((m = p.match(/^discard (a|an|one|two|three|\d+|your hand) ?(land |creature |nonland |instant or sorcery )?(?:cards?)?$/))) {
      const hand = cardsIn(pid, 'hand').filter((x) => x.iid !== src.iid && (!m[2] || matchesFilter(x, m[2].trim())));
      const k = m[1] === 'your hand' ? hand.length : { a: 1, an: 1, one: 1, two: 2, three: 3 }[m[1]] || +m[1];
      if (hand.length < k) return false;
      const picks = k === hand.length && m[1] === 'your hand' ? hand.map((x) => x.iid) : await ch.pickCards({ prompt: `Discard ${k === 1 ? 'a' : k} ${m[2] || ''}card${k > 1 ? 's' : ''}`, cards: hand.map((x) => x.iid), min: k, max: k, purpose: 'discard', src, aiScore: (x) => (isLand(x) ? 3 : -DB[x.def].cmc) });
      if (picks.length < k) return false;
      picks.forEach((i) => discardCard(i));
      continue;
    }
    if ((m = p.match(/^pay (\d+) life$/))) {
      if (G.s.players[pid].life < +m[1]) return false;
      changeLife(pid, -m[1]);
      continue;
    }
    // War Room: "Pay life equal to the number of colors in your commanders' color identity"
    if (/^pay life equal to the number of colors in your commanders?'? color identity$/.test(p)) {
      const k = identityColors(pid);
      if (G.s.players[pid].life < k) return false;
      if (k) changeLife(pid, -k);
      continue;
    }
    if ((m = p.match(/^pay ((?:\{[^}]+\})+)$/))) {
      const pay = await env.pay(pid, m[1], cardName(src), {});
      if (!pay) return false;
      applyPayment(pid, pay);
      continue;
    }
    if ((m = p.match(/^pay (\{e\}(?:\{e\})*|(\w+) \{e\})$/))) {
      const k = (p.match(/\{e\}/g) || []).length;
      if (G.s.players[pid].counters.energy < k) return false;
      G.s.players[pid].counters.energy -= k;
      continue;
    }
    if ((m = p.match(/^exile (a|an|one|two|three|four|five|six|seven|eight|\d+|x) (?:other )?(?:([a-z]+) )?cards? from your graveyard$/))) {
      const k = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 }[m[1]] || +m[1] || 0;
      const pool = cardsIn(pid, 'graveyard').filter((x) => x.iid !== src.iid && (!m[2] || m[2] === 'other' || matchesFilter(x, m[2])));
      if (pool.length < k) return false;
      const picks = await ch.pickCards({ prompt: `Exile ${k} card${k > 1 ? 's' : ''} from your graveyard`, cards: pool.map((x) => x.iid), min: k, max: k, purpose: 'exileGy', src, aiScore: (x) => (isLand(x) ? 3 : -DB[x.def].cmc) });
      if (picks.length < k) return false;
      picks.forEach((i) => move(i, 'exile'));
      continue;
    }
    if ((m = p.match(/^collect evidence (\d+)$/))) {
      const need = +m[1];
      const pool = cardsIn(pid, 'graveyard').filter((x) => x.iid !== src.iid);
      if (pool.reduce((a, x) => a + DB[x.def].cmc, 0) < need) return false;
      const picks = await ch.pickCards({ prompt: `Collect evidence ${need}: exile cards with total mana value ${need}+`, cards: pool.map((x) => x.iid), min: 1, max: pool.length, purpose: 'evidence', src, aiScore: (x) => DB[x.def].cmc });
      let total = 0;
      const used = [];
      for (const i of picks) {
        if (total >= need) break;
        total += DB[card(i).def].cmc;
        used.push(i);
      }
      if (total < need) return false;
      used.forEach((i) => move(i, 'exile'));
      continue;
    }
    if (/^forage$/.test(p)) {
      const food = cardsIn(pid, 'battlefield').find((x) => hasSubtype(x, 'Food'));
      if (food) sacrifice(food.iid);
      else {
        const gy = cardsIn(pid, 'graveyard').filter((x) => x.iid !== src.iid);
        if (gy.length < 3) return false;
        const picks = await ch.pickCards({ prompt: 'Forage: exile three cards from your graveyard', cards: gy.map((x) => x.iid), min: 3, max: 3, purpose: 'exileGy', src, aiScore: (x) => -DB[x.def].cmc });
        picks.forEach((i) => move(i, 'exile'));
      }
      continue;
    }
    if ((m = p.match(/^tap (a|an|one|two|three|four|five|six|\d+) untapped ([a-z ]+?)s? you control(?: with ([a-z ]+))?$/))) {
      const k = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 }[m[1]] || +m[1];
      const pool = cardsIn(pid, 'battlefield').filter((x) => !x.tapped && (!/\bother\b/.test(m[2]) || x.iid !== src.iid) && matchesFilter(x, m[2].replace(/^other /, '')) && (!m[3] || hasKw(x, m[3])));
      if (pool.length < k) return false;
      const picks = await ch.pickCards({ prompt: `Tap ${k} untapped ${m[2]}`, cards: pool.map((x) => x.iid), min: k, max: k, purpose: 'tap', src, aiScore: (x) => -cardValue(x) });
      picks.forEach((i) => (card(i).tapped = true));
      continue;
    }
    // Force of Will & co.: "exile a blue card from your hand"
    if ((m = p.match(/^exile (a|an) ([a-z ]+?) card from your hand$/))) {
      const pool = cardsIn(pid, 'hand').filter((x) => x.iid !== src.iid && matchesFilter(x, m[2]));
      if (!pool.length) return false;
      const [pick] = await ch.pickCards({ prompt: `Exile a ${m[2]} card from your hand`, cards: pool.map((x) => x.iid), min: 1, max: 1, purpose: 'exileHand', src, aiScore: (x) => -cardValue(x) });
      if (!pick) return false;
      move(pick, 'exile');
      continue;
    }
    if ((m = p.match(/^return (a|an) ([a-z ]+?) you control to its owner's hand$/))) {
      const pool = cardsIn(pid, 'battlefield').filter((x) => x.iid !== src.iid && matchesFilter(x, m[2]));
      if (!pool.length) return false;
      const [pick] = await ch.pickCards({ prompt: `Return a ${m[2]} you control to its owner's hand`, cards: pool.map((x) => x.iid), min: 1, max: 1, purpose: 'bounce', src, aiScore: (x) => -cardValue(x) });
      move(pick, 'hand');
      continue;
    }
    if ((m = p.match(/^reveal (a|an) ([a-z ]+?) card from your hand$/))) {
      if (!cardsIn(pid, 'hand').some((x) => x.iid !== src.iid && matchesFilter(x, m[2]))) return false;
      continue;
    }
    if ((m = p.match(/^remove (a|an|one|two|three|\d+|x) ([+-]\d+\/[+-]\d+|[a-z]+) counters? from (?:~|a creature you control|among permanents you control)$/))) {
      const k = { a: 1, an: 1, one: 1, two: 2, three: 3 }[m[1]] || +m[1] || 0;
      const tgt = /^~$/.test(p.split(' from ')[1]) ? src : cardsIn(pid, 'battlefield').find((x) => (x.counters || {})[m[2]] >= k);
      if (!tgt || ((tgt.counters || {})[m[2]] || 0) < k) return false;
      tgt.counters[m[2]] -= k;
      continue;
    }
    if (/^exert ~$/.test(p)) {
      src.noUntapUntil = G.s.turn + 2;
      continue;
    }
    // unknown cost: let the player pay it by hand
    log(pid, `<i>Pay by hand: ${esc(p)}</i>`);
  }
  return true;
}

// ------------------------------------------------------------ lands
export function landOptions(pid, c) {
  const d = DB[c.def];
  const out = [];
  if (isLandFace(d.faces[0])) out.push({ face: 0, label: `Play ${d.faces[0].name}` });
  if ((d.layout === 'modal_dfc' || d.layout === 'transform') && d.faces[1] && isLandFace(d.faces[1]) && d.layout === 'modal_dfc') out.push({ face: 1, label: `Play ${d.faces[1].name}` });
  return out;
}
export function landsAllowed(pid) {
  let k = 1 + (G.s.extraLandThisTurn || 0);
  for (const c of cardsIn(pid, 'battlefield')) {
    const o = oracle(c);
    if (/You may play an additional land on each of your turns/i.test(o)) k++;
    const m = o.match(/You may play (two|three) additional lands on each of your turns/i);
    if (m) k += m[1] === 'two' ? 2 : 3;
  }
  return k;
}
export function playLand(pid, iid, faceIdx = 0, pos = {}) {
  const c = card(iid);
  if (!c) return false;
  c.face = faceIdx;
  G.s.landsPlayed = (G.s.landsPlayed || 0) + 1;
  G.s.landPlayed = G.s.landsPlayed >= landsAllowed(pid);
  G.s.ts[pid].landsPlayed++;
  G.s.lastLandPlay = { iid, from: c.zone, pid }; // Ghost-Spider: "whenever you play a land from exile"
  toBattlefield(iid, pid, pos);
  log(pid, `${pid === 'p' ? 'You play' : 'AI plays'} ${nameTag(c)}${c.owner !== pid ? (c.owner === 'p' ? ' from your hand' : " from the AI's hand") : ''}${c.tapped ? ' (tapped)' : ''}.`);
  return true;
}

// ------------------------------------------------------------ abilities from hand / graveyard
// The AI's activated abilities use the stack too: you get a chance to respond (and see what it's aimed at).
// Mana abilities don't use the stack, so they never stop here.
async function announceAbility(pid, c, text, env) {
  const s = G.s;
  if (pid !== 'ai' || !env.respond || !G.settings.pauseOnAiSpells || s.stack || s.pstack || aiSlaved()) return false;
  if (/^add\b/i.test(String(text || '').trim())) return false;
  const ch0 = env.choosers[pid];
  if (ch0) ch0.plan = null;
  const tg = await predictTargets(pid, c, c.face || 0, { ...env.choosers, [opp(pid)]: ch0 }, 0, text).catch(() => []);
  if (ch0 && tg.length) ch0.plan = tg.slice();
  s.stack = { iid: c.iid, by: pid, face: c.face || 0, ability: text, targets: tg };
  env.render();
  let countered = false;
  try {
    await env.respond(c.iid);
    countered = !!(G.s === s && s.stack && s.stack.countered);
  } finally {
    if (G.s === s) s.stack = null;
  }
  if (countered) log(opp(pid), `The ability of ${nameTag(c)} is countered.`);
  return countered;
}

// One loyalty ability a turn; Oath of Teferi makes it two; each The Chain Veil activation adds one more.
export function loyaltyAllowed(pid) {
  const s = G.s;
  const all = cardsIn(pid, 'battlefield').map(oracle).join('\n');
  let allowed = /activate (?:the )?loyalty abilities of [^.]+ twice/i.test(all) ? 2 : 1;
  if (s.chainVeil && s.chainVeil.pid === pid && s.chainVeil.turn === s.turn) allowed += s.chainVeil.n;
  return allowed;
}
// Teferi's Talent / Teferi, Temporal Archmage emblem, Jace's Machinations: loyalty abilities on any player's turn
export function instantLoyalty(c) {
  const pl = G.s.players[c.controller];
  if ((pl.emblems || []).some((e) => /activate loyalty abilities of planeswalkers you control on any player's turn/i.test(e))) return true;
  if (cardsIn(c.controller, 'battlefield').some((x) => /(?:^|\n)You may activate (?:the )?loyalty abilities of planeswalkers you control on any player's turn/i.test(oracle(x)))) return true;
  const il = G.s.instantLoyalty;
  return !!(il && il.pid === c.controller && il.turn === G.s.turn && (!il.subtype || hasSubtype(c, il.subtype)));
}
export function loyaltyUsesLeft(c) {
  const s = G.s;
  const used = c.loyaltyUses && c.loyaltyUses.turn === s.turn ? c.loyaltyUses.n : c.usedLoyaltyTurn === s.turn ? 1 : 0;
  return Math.max(0, loyaltyAllowed(c.controller) - used);
}

export async function useZoneAbility(pid, iid, ab, env) {
  const c = card(iid);
  const ch = env.choosers[pid];
  const s = G.s;
  const payM = async (cost) => {
    if (!cost) return true;
    const p = await env.pay(pid, cost, cardName(c), { ability: true });
    if (!p) return false;
    applyPayment(pid, p);
    return p;
  };
  switch (ab.kind) {
    case 'gyAbility':
      return activateAbility(pid, c, ab.ab, env);
    case 'cycling': {
      if (ab.other && !(await payOtherCost(pid, ab.other, c, env))) return false;
      const cp = await payM(ab.mana);
      if (!cp) return false;
      discardCard(iid);
      queueEvent({ type: 'cycle', iid, pid, x: (cp && cp.x) || 0 });
      if (ab.type) {
        const typ = ab.type;
        const lib = zoneOf(pid, 'library').map(card).filter((x) => (typ === 'land' ? isLand(x) : typ === 'basic land' || typ === 'basiclanding' ? /Basic/.test(DB[x.def].typeLine) : new RegExp(typ, 'i').test(DB[x.def].typeLine)));
        const [pick] = await ch.pickCards({ prompt: `${ab.label}: search for a ${typ} card`, cards: lib.map((x) => x.iid), min: 0, max: 1, purpose: 'tutor', src: c, aiScore: () => 0 });
        shuffle(pid);
        if (pick) move(pick, 'hand');
        log(pid, `${pid === 'p' ? 'You' : 'The AI'} ${typ}cycle${pid === 'ai' ? 's' : ''} ${nameTag(c)}${pick ? ' and find' + (pid === 'ai' ? 's' : '') + ' a card' : ''}.`);
      } else {
        draw(pid, 1, true);
        log(pid, `${pid === 'p' ? 'You cycle' : 'The AI cycles'} ${nameTag(c)}.`);
      }
      return true;
    }
    case 'channel':
    case 'forecast': {
      if (ab.kind === 'forecast' && !(s.step === 'upkeep' && s.active === pid)) return false;
      if (!(await payM(ab.mana))) return false;
      if (ab.kind === 'channel') discardCard(iid);
      const did = await resolveEffects(ab.text, c, { me: pid, choosers: env.choosers, castFree: (p, i) => castFree(p, i, env) });
      log(pid, `${ab.label} — ${nameTag(c)}: ${did.join('; ') || 'apply by hand'}.`);
      return true;
    }
    case 'transmute': {
      if (!(await payM(ab.mana))) return false;
      const mv = DB[c.def].cmc;
      discardCard(iid);
      const lib = zoneOf(pid, 'library').map(card).filter((x) => DB[x.def].cmc === mv);
      const [pick] = await ch.pickCards({ prompt: `Transmute: search for a card with mana value ${mv}`, cards: lib.map((x) => x.iid), min: 0, max: 1, purpose: 'tutor', src: c, aiScore: () => 0 });
      shuffle(pid);
      if (pick) move(pick, 'hand');
      log(pid, `Transmute ${nameTag(c)}.`);
      return true;
    }
    case 'reinforce': {
      const pool = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter(isCreature);
      if (!pool.length || !(await payM(ab.mana))) return false;
      discardCard(iid);
      const pick = await ch.target({ forced: true, prompt: `Reinforce ${ab.n}`, candidates: pool.map((x) => x.iid), harm: false, src: c });
      if (pick && pick.iid) addCounters(card(pick.iid), '+1/+1', ab.n);
      return true;
    }
    case 'ninjutsu': {
      const cb = s.combat;
      if (!cb || !cb.attackers.length) return false;
      const unblocked = cb.attackers.filter((a) => card(a) && card(a).controller === pid && !(cb.blocks[a] || []).length && !(cb.wasBlocked || {})[a]);
      if (!unblocked.length) return false;
      const [pick] = await ch.pickCards({ prompt: 'Ninjutsu: return an unblocked attacker to your hand', cards: unblocked, min: 1, max: 1, purpose: 'ninjutsu', src: c, aiScore: (x) => -cardValue(x) });
      if (!pick || !(await payM(ab.mana))) return false;
      const target = (cb.targets || {})[pick];
      move(pick, 'hand');
      toBattlefield(iid, pid, { tapped: true });
      cb.attackers.push(iid);
      card(iid).attacking = true;
      if (target) cb.targets[iid] = target;
      log(pid, `Ninjutsu: ${nameTag(card(iid))} replaces an unblocked attacker.`);
      return true;
    }
    case 'foretell': {
      if (s.active !== pid || !(await payM('{2}'))) return false;
      move(iid, 'exile', { faceDown: true });
      Object.assign(card(iid), { foretold: true, foretoldTurn: s.turn, faceDownOwnerSees: true });
      log(pid, `${pid === 'p' ? 'You foretell' : 'The AI foretells'} a card.`);
      return true;
    }
    case 'plot': {
      if (!(await payM(ab.mana))) return false;
      move(iid, 'exile');
      Object.assign(card(iid), { plotted: true, plottedTurn: s.turn });
      log(pid, `${pid === 'p' ? 'You plot' : 'The AI plots'} ${nameTag(c)}.`);
      return true;
    }
    case 'suspend': {
      if (!(await payM(ab.mana))) return false;
      move(iid, 'exile');
      card(iid).suspended = true;
      addCounters(card(iid), 'time', ab.n, { silent: true });
      log(pid, `${pid === 'p' ? 'You suspend' : 'The AI suspends'} ${nameTag(c)} with ${ab.n} time counters.`);
      return true;
    }
    case 'unearth': {
      if (!(await payM(ab.mana))) return false;
      toBattlefield(iid, pid);
      Object.assign(card(iid), { exileIfLeaves: true, endOfTurn: 'exile' });
      card(iid).grants = [...(card(iid).grants || []), 'haste'];
      log(pid, `Unearth: ${nameTag(c)} returns with haste.`);
      return true;
    }
    case 'embalm':
    case 'eternalize': {
      if (!(await payM(ab.mana))) return false;
      move(iid, 'exile');
      const [tok] = createToken(c.def, pid, 1);
      if (ab.kind === 'eternalize') card(tok).setPT = { p: 4, t: 4 };
      card(tok).addTypes = 'Zombie';
      log(pid, `${ab.kind === 'embalm' ? 'Embalm' : 'Eternalize'}: a token copy of ${nameTag(c)}.`);
      return true;
    }
    case 'scavenge': {
      const pool = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter(isCreature);
      if (!pool.length || !(await payM(ab.mana))) return false;
      const k = power({ ...c, zone: 'graveyard' });
      move(iid, 'exile');
      const pick = await ch.target({ forced: true, prompt: `Scavenge: put ${k} +1/+1 counters on a creature`, candidates: pool.map((x) => x.iid), harm: false, src: c });
      if (pick && pick.iid) addCounters(card(pick.iid), '+1/+1', k);
      return true;
    }
    case 'encore': {
      if (!(await payM(ab.mana))) return false;
      move(iid, 'exile');
      const [tok] = createToken(c.def, pid, 1);
      Object.assign(card(tok), { endOfTurn: 'sacrifice', goaded: { by: pid, until: s.turn + 1 } });
      card(tok).grants = ['haste'];
      log(pid, `Encore: a hasty token copy of ${nameTag(c)} that must attack.`);
      return true;
    }
    case 'dredge': {
      s.players[pid].dredge = { iid, n: ab.n };
      log(pid, `${nameTag(c)} will be dredged instead of the next draw.`);
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------ abilities on permanents
export async function activateAbility(pid, c, ab, env) {
  const s = G.s;
  const ch = env.choosers[pid];
  const name = cardName(c);
  const payM = async (cost, opts = {}) => {
    if (!cost) return { payers: [], x: 0 };
    const p = await env.pay(pid, cost, name, { ability: true, ...opts });
    if (!p) return null;
    applyPayment(pid, p);
    return p;
  };
  const ctx = (extra = {}) => ({ me: pid, choosers: env.choosers, castFree: (p, i) => castFree(p, i, env), stackTarget: pid === 'p' && s.stack ? s.stack.iid : null, ...extra });
  if (s.noAbilities && s.noAbilities.pid === pid && s.noAbilities.turn === s.turn && ab.kind !== 'mana') {
    return env.say(`${pid === 'p' ? "You" : 'The AI'} can't activate abilities this turn.`);
  }
  switch (ab.kind) {
    case 'prepared': {
      // cast a copy of its spell (the card's other half): pay its cost, at that spell's speed; the creature is no longer prepared
      const f1 = DB[c.def].faces[1];
      if (!c.prepared || !f1) return env.say(`${name} isn't prepared.`);
      if (!ab.instant && !(s.active === pid && (s.step === 'main1' || s.step === 'main2') && !s.stack && !s.pstack)) return env.say(`${f1.name} can only be cast at sorcery speed.`);
      const paid = await payM(ab.mana);
      if (!paid) return false;
      c.prepared = false;
      const ts = s.ts[pid];
      ts.spells++;
      ts.spellsNotHand = (ts.spellsNotHand || 0) + 1;
      if (!/Creature/.test(f1.typeLine || '')) ts.noncreatureSpells++;
      log(pid, `${pid === 'p' ? 'You cast' : 'AI casts'} a copy of ${esc(f1.name)} (${nameTag(c)} is no longer prepared).`);
      // the copy goes on the stack like any spell: the other player gets a chance to respond (and counter it)
      const slot = pid === 'p' ? 'pstack' : 'stack';
      s[slot] = { iid: c.iid, by: pid, face: 1, copyFace: 1 };
      queueEvent({ type: 'cast', iid: c.iid, def: c.def, controller: pid, from: 'battlefield', copyFace: 1 });
      if (env.render) env.render();
      await settle();
      const spellSrc = { ...c, face: 1 };
      let countered = false;
      if (pid === 'ai' && env.respond && !aiSlaved()) {
        const verdict = await env.respond(c.iid);
        countered = verdict === 'counter';
      } else if (pid === 'p' && env.aiCounter && !aiSlaved()) countered = await env.aiCounter(spellSrc);
      countered = countered || !!(s[slot] && s[slot].countered);
      s[slot] = null;
      if (env.render) env.render();
      if (countered) {
        log(pid, `The copy of ${esc(f1.name)} is countered.`);
        return true;
      }
      const did = await resolveEffects(spellText(spellSrc), spellSrc, ctx({ x: paid.x || 0 }));
      log(pid, `Copy of ${esc(f1.name)}: ${did.join('; ') || 'resolves'}.`);
      return true;
    }
    case 'unlock': {
      // Rooms: pay a locked door's mana cost as a sorcery to unlock it — a special action, it doesn't use the stack
      if (!(s.active === pid && (s.step === 'main1' || s.step === 'main2') && !s.stack && !s.pstack)) return env.say('You can unlock a door only as a sorcery.');
      if (!c.unlocked || c.unlocked[ab.door]) return env.say('That door is already unlocked.');
      const paid = await payM(ab.mana);
      if (!paid) return false;
      c.unlocked = c.unlocked.map((u, k) => u || k === ab.door);
      log(pid, `${pid === 'p' ? 'You unlock' : 'AI unlocks'} ${esc(DB[c.def].faces[ab.door].name)}${c.unlocked.every(Boolean) ? ` — ${nameTag(c)} is fully unlocked` : ''}.`);
      queueEvent({ type: 'unlock', iid: c.iid, door: ab.door, controller: pid });
      return true;
    }
    case 'loyalty': {
      // sorcery speed unless something lets you activate them at instant speed
      if (!instantLoyalty(c) && !(s.active === pid && (s.step === 'main1' || s.step === 'main2') && !s.stack && !s.pstack && !(s.combat && s.combat.attackers && s.combat.attackers.length))) {
        return env.say(s.active !== pid ? 'Loyalty abilities can only be activated on your own turn.' : 'Loyalty abilities can only be activated in your main phase with nothing on the stack.');
      }
      {
        // one loyalty ability per turn; Oath of Teferi makes it two, The Chain Veil adds one more
        const allowed = loyaltyAllowed(pid);
        if (loyaltyUsesLeft(c) <= 0) return env.say(allowed > 1 ? `${name} has already used ${allowed} loyalty abilities this turn.` : 'Only one loyalty ability per turn.');
      }
      let cost = ab.cost;
      let x = 0;
      if (ab.x) {
        x = await ch.chooseNumber({ prompt: `Choose X for ${ab.label}`, min: 0, max: c.counters.loyalty || 0, ai: Math.min(c.counters.loyalty || 0, 3) });
        cost = ab.label.startsWith('+') ? x : -x;
      }
      if ((c.counters.loyalty || 0) + cost < 0) return env.say(`${name} doesn't have enough loyalty.`);
      {
        const req = (ab.raw || ab.text || '').match(/Activate only if there are ([\w-]+) or more loyalty counters among ([\w~]+?)s? you control/i);
        if (req) {
          if (req[2] === '~') req[2] = name.split(/[ ,]/)[0];
          const need = { 'twenty-five': 25, twenty: 20, ten: 10 }[req[1].toLowerCase()] || +req[1] || 0;
          const have = cardsIn(pid, 'battlefield').filter((x) => isType(x, 'Planeswalker') && hasSubtype(x, req[2])).reduce((a, x) => a + (x.counters.loyalty || 0), 0);
          if (have < need) return env.say(`Needs ${need} loyalty among your ${req[2]}s (you have ${have}).`);
        }
      }
      c.counters.loyalty = (c.counters.loyalty || 0) + cost;
      c.loyaltyUses = { turn: s.turn, n: (c.loyaltyUses && c.loyaltyUses.turn === s.turn ? c.loyaltyUses.n : 0) + 1 };
      c.usedLoyaltyTurn = s.turn;
      if (s.ts[pid]) s.ts[pid].loyaltyActivated = (s.ts[pid].loyaltyActivated || 0) + 1;
      log(pid, `${nameTag(c)} uses ${ab.label}.`);
      // "whenever you activate a loyalty ability" (Way of the Paradox / Mind Sculptor) and "whenever you put loyalty counters on a planeswalker"
      queueEvent({ type: 'loyaltyActivated', iid: c.iid, controller: pid, cost });
      if (cost > 0) queueEvent({ type: 'counterPut', iid: c.iid, kind: 'loyalty', n: cost, controller: c.controller });
      await settle();
      const copiers = abilityCopiers(pid);
      if (await announceAbility(pid, c, ab.text, env)) return true;
      let did;
      try {
        did = await resolveEffects(ab.text, c, ctx({ x }));
      } finally {
        if (env.choosers[pid] && env.choosers[pid].plan) env.choosers[pid].plan = null;
      }
      log(pid, `${nameTag(c)}: ${did.join('; ') || '<i>' + esc(ab.text.slice(0, 90)) + '</i> — apply by hand'}.`);
      await copyAbility(pid, ab.text, c, ctx({ x }), copiers); // loyalty abilities aren't mana abilities either
      return true;
    }
    case 'equip':
    case 'reconfigure': {
      const pool = cardsIn(pid, 'battlefield').filter((x) => isCreature(x) && x.iid !== c.iid && x.iid !== c.attachedTo && (!ab.filter || matchesFilter(x, ab.filter)));
      if (ab.kind === 'reconfigure' && c.attachedTo) {
        if (!(await payM(ab.mana))) return false;
        c.attachedTo = null;
        log(pid, `${nameTag(c)} unattaches and is a creature again.`);
        return true;
      }
      if (!pool.length) return env.say('No creature to attach to.');
      const pick = await ch.target({ prompt: `Attach ${name} to which creature?`, candidates: pool.map((x) => x.iid), harm: false, src: c });
      if (!pick || !pick.iid) throw new Cancelled();
      if (!(await payM(ab.mana))) throw new Cancelled();
      attachTo(c, card(pick.iid));
      if (ab.kind === 'reconfigure') c.reconfigured = true;
      log(pid, `${pid === 'p' ? 'You' : 'The AI'} ${ab.kind === 'equip' ? 'equip' : 'attach'}${pid === 'ai' ? 's' : ''} ${nameTag(c)} to ${nameTag(card(pick.iid))}.`);
      return true;
    }
    case 'crew':
    case 'saddle':
    case 'station': {
      const pool = cardsIn(pid, 'battlefield').filter((x) => isCreature(x) && !x.tapped && x.iid !== c.iid && (ab.kind !== 'saddle' || !x.attacking));
      if (!pool.length) return env.say('No untapped creatures.');
      const need = ab.n || 0;
      // the AI taps as little as it can: creatures that can't attack well this turn first, and only up to the power it needs
      const aiPicks = () => {
        const order = [...pool].sort((x, y) => {
          const bad = (z) => (z.sick && !hasKw(z, 'haste') ? 0 : 1);
          return bad(x) - bad(y) || cardValue(x) - cardValue(y) || power(y) - power(x);
        });
        const out = [];
        let sum = 0;
        if (ab.kind === 'station') return order.length ? [order.sort((x, y) => power(y) - power(x)).find((z) => z.sick) ? order.find((z) => z.sick).iid : order[0].iid] : [];
        for (const z of order) {
          if (sum >= need) break;
          out.push(z.iid);
          sum += Math.max(0, power(z));
        }
        // drop any creature that isn't actually needed
        for (const i of [...out].reverse()) {
          const rest = sum - Math.max(0, power(card(i)));
          if (rest >= need && out.length > 1) {
            out.splice(out.indexOf(i), 1);
            sum = rest;
          }
        }
        return out;
      };
      const picks = pid === 'ai' ? aiPicks() : await ch.pickCards({
        prompt: ab.kind === 'station' ? `Station: tap a creature to put charge counters equal to its power on ${name}` : `${ab.kind === 'crew' ? 'Crew' : 'Saddle'} ${need}: tap creatures with total power ${need} or more`,
        cards: pool.map((x) => x.iid), min: 1, max: ab.kind === 'station' ? 1 : pool.length, purpose: 'crew', src: c, aiScore: (x) => power(x) - cardValue(x) / 2,
      });
      const total = picks.reduce((a, i) => a + Math.max(0, power(card(i))), 0);
      if (ab.kind !== 'station' && total < need) return env.say(`Not enough power (${total}/${need}).`);
      picks.forEach((i) => (card(i).tapped = true));
      if (ab.kind === 'crew') c.crewedTurn = s.turn;
      else if (ab.kind === 'saddle') c.saddledTurn = s.turn;
      else {
        addCounters(c, 'charge', total);
        const thresholds = [...(face(c).oracle || '').matchAll(/^STATION (\d+)\+/gm)].map((m) => +m[1]);
        const max = thresholds.length ? Math.max(...thresholds) : 99;
        if ((c.counters.charge || 0) >= max && /\d+\/\d+/.test((face(c).oracle || '').split(/STATION \d+\+/).pop())) c.stationCreature = true;
      }
      log(pid, `${nameTag(c)} is ${ab.kind === 'crew' ? 'crewed' : ab.kind === 'saddle' ? 'saddled' : 'stationed (+' + total + ' charge)'}.`);
      return true;
    }
    case 'craft': {
      // Craft: exile this and the materials (other permanents you control and/or cards in your graveyard), return it transformed
      if (c.zone !== 'battlefield') return false;
      const hasAbility = (x) => /(?:^|\n)[^"\n]*\{[^}]+\}[^"\n]*:/.test(oracle({ ...x, zone: 'battlefield' }));
      const fits = (x) => {
        let f = ab.filter.replace(/ with (?:an? )?activated abilit(?:y|ie)/, '').trim();
        if (/with (?:an? )?activated abilit/.test(ab.filter) && !hasAbility(x)) return false;
        if (/^nonland$/.test(f)) return !isLand({ ...x, zone: 'battlefield' });
        if (/^(?:permanent|card)$/.test(f)) return true;
        return matchesFilter({ ...x }, f);
      };
      const pool = [...cardsIn(pid, 'battlefield').filter((x) => x.iid !== c.iid), ...cardsIn(pid, 'graveyard')].filter(fits);
      if (pool.length < ab.min) return env.say(`${name} needs ${ab.min} ${ab.filter}${ab.min > 1 ? 's' : ''} to craft with.`);
      const picks = await ch.pickCards({ prompt: `Craft ${name}: choose ${ab.more ? ab.min + ' or more' : ab.min} to exile`, cards: pool.map((x) => x.iid), min: ab.min, max: ab.more ? pool.length : ab.min, purpose: 'craft', src: c,
        aiScore: (x) => (x.zone === 'graveyard' ? 5 : 0) - cardValue(x) });
      if (!picks || picks.length < ab.min) return false;
      if (!(await payM(ab.mana))) return false;
      const used = picks.map((i) => ({ def: card(i).def, face: card(i).face || 0 }));
      for (const i of picks) move(i, 'exile');
      move(c.iid, 'exile');
      toBattlefield(c.iid, c.owner);
      if (DB[c.def].faces.length > 1) c.face = 1;
      c.craftedFrom = used;
      log(pid, `${nameTag(c)} is crafted from ${picks.map((i) => nameTag(card(i))).join(', ')}.`);
      queueEvent({ type: 'transformed', iid: c.iid, controller: c.controller });
      return true;
    }
    case 'levelup': {
      if (!(await payM(ab.mana))) return false;
      addCounters(c, 'level', 1);
      log(pid, `${nameTag(c)} levels up (level ${c.counters.level}).`);
      return true;
    }
    case 'classlevel': {
      if (!(await payM(ab.mana))) return false;
      c.classLevel = ab.level;
      log(pid, `${nameTag(c)} becomes level ${ab.level}.`);
      queueEvent({ type: 'classLevel', iid: c.iid, level: ab.level, controller: pid });
      return true;
    }
  }
  // generic activated ability
  if (ab.tap && (c.tapped || (isCreature(c) && c.sick && !hasKw(c, 'haste')))) return env.say(`${name} can't tap right now.`);
  if (ab.untap && !c.tapped) return env.say(`${name} must be tapped.`);
  if (ab.sorcery && !(s.active === pid && (s.step === 'main1' || s.step === 'main2'))) return env.say('Activate only as a sorcery.');
  c.usedAbilities = c.usedAbilities || {};
  if (ab.once && c.usedAbilities[ab.raw] === (ab.exhaust ? 'ever' : s.turn)) return env.say('Already used.');
  const lifeCost = ab.payLife === 'identity' ? identityColors(pid) : +ab.payLife || 0;
  if (ab.payLife && s.players[pid].life < lifeCost) return env.say('Not enough life.');
  if (ab.payEnergy && s.players[pid].counters.energy < ab.payEnergy) return env.say('Not enough energy.');
  if (ab.removeCounters) {
    const k = { a: 1, an: 1, one: 1, two: 2, three: 3 }[ab.removeCounters[1].toLowerCase()] || +ab.removeCounters[1] || 0;
    const have = ab.removeCounters[2] ? (c.counters || {})[ab.removeCounters[2].toLowerCase()] || 0 : Object.values(c.counters || {}).reduce((a, v) => a + (v > 0 ? v : 0), 0);
    if (have < k) return env.say('Not enough counters.');
  }
  // Cryptbreaker: "Tap three untapped Zombies you control" — check there are enough before paying anything
  const W_ = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };
  const tapK = ab.tapOther ? W_[ab.tapOther[1].toLowerCase()] || +ab.tapOther[1] || 1 : 0;
  if (ab.tapOther) {
    const what = ab.tapOther[2].toLowerCase().replace(/ you control$/, '');
    const other = /^other /.test(what);
    const avail = cardsIn(pid, 'battlefield').filter((x) => !x.tapped && (!other || x.iid !== c.iid) && (!ab.tap || x.iid !== c.iid) && matchesFilter(x, what.replace(/^other /, '').replace(/s$/, '')));
    if (avail.length < tapK) return env.say(`You need ${tapK} untapped ${what}.`);
  }
  let x = 0;
  if (/\{X\}/.test(ab.mana)) {
    const p = await env.pay(pid, ab.mana, name, { ability: true, exclude: ab.tap ? [c.iid] : [], waterbend: /Waterbend/i.test(ab.costText || '') ? +((ab.costText.match(/Waterbend \{(\d+)\}/i) || [])[1] || 0) : 0, self: ab.tap ? c.iid : undefined });
    if (!p) return false;
    applyPayment(pid, p);
    x = p.x || 0;
  } else if (ab.mana) {
    const p = await env.pay(pid, ab.mana, name, { ability: true, exclude: ab.tap ? [c.iid] : [] });
    if (!p) return false;
    applyPayment(pid, p);
  }
  // other costs
  if (ab.tapOther) {
    if (!(await payOtherCost(pid, `tap ${tapK} untapped ${ab.tapOther[2].toLowerCase().replace(/ you control$/, '')} you control`, c, env))) throw new Cancelled();
  }
  if (ab.sacOther) {
    const k = { a: 1, an: 1, another: 1, two: 2, three: 3 }[ab.sacOther[1].toLowerCase()] || +ab.sacOther[1] || 1;
    if (!(await payOtherCost(pid, `sacrifice ${k === 1 ? 'a' : k} ${ab.sacOther[2]}`, c, env))) throw new Cancelled();
  }
  if (ab.discardN && !(await payOtherCost(pid, `discard ${ab.discardN} card`, c, env))) throw new Cancelled();
  if (ab.exileFromGy && !(await payOtherCost(pid, ab.exileFromGy[0].toLowerCase(), c, env))) throw new Cancelled();
  if (ab.collectEvidence && !(await payOtherCost(pid, `collect evidence ${ab.collectEvidence}`, c, env))) throw new Cancelled();
  if (ab.forage && !(await payOtherCost(pid, 'forage', c, env))) throw new Cancelled();
  if (ab.tap) {
    c.tapped = true;
    tappedHook(c);
  }
  if (ab.untap) c.tapped = false;
  if (ab.payLife && lifeCost) changeLife(pid, -lifeCost);
  if (ab.payEnergy) s.players[pid].counters.energy -= ab.payEnergy;
  if (ab.removeCounters) {
    const k = { a: 1, an: 1, one: 1, two: 2, three: 3 }[ab.removeCounters[1].toLowerCase()] || +ab.removeCounters[1] || 0;
    if (ab.removeCounters[2]) c.counters[ab.removeCounters[2].toLowerCase()] -= k;
    else {
      // any kind of counter: take from the most plentiful first
      let left = k;
      while (left > 0) {
        const [kind] = Object.entries(c.counters || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0] || [];
        if (!kind) break;
        c.counters[kind]--;
        if (!c.counters[kind]) delete c.counters[kind];
        left--;
      }
    }
  }
  if (ab.exert) c.noUntapUntil = s.turn + 2;
  c.usedAbilities[ab.raw] = ab.exhaust ? 'ever' : s.turn;
  log(pid, `${pid === 'p' ? 'You activate' : 'AI activates'} ${nameTag(c)}: <i>${esc(ab.costText.replace(/~/g, name.split(',')[0]))}</i>.`);
  const srcSnap = c;
  if (ab.sac) sacrifice(c.iid);
  if (ab.returnToHand) move(c.iid, 'hand');
  if (ab.exileSelf && c.zone !== 'exile') move(c.iid, 'exile');
  const copiers = abilityCopiers(pid);
  const abText = ab.text.replace(/Activate only (?:as a sorcery|once each turn)[^.]*\.?/gi, '').trim();
  if (await announceAbility(pid, srcSnap, abText, env)) return true;
  if (env.render) env.render(); // show the costs as paid (the source tapped, mana spent) while the ability resolves
  let did;
  try {
    did = await resolveEffects(abText, srcSnap, ctx({ x }));
  } finally {
    if (env.choosers[pid] && env.choosers[pid].plan) env.choosers[pid].plan = null;
  }
  log(pid, did.length ? `${nameTag(srcSnap)}: ${did.join('; ')}.` : `Apply “${esc(ab.text.slice(0, 90))}” by hand.`);
  await copyAbility(pid, ab.text.replace(/Activate only (?:as a sorcery|once each turn)[^.]*\.?/gi, '').trim(), srcSnap, ctx({ x }), copiers);
  return true;
}

// Locus of Enlightenment, Rowan Kenrith's emblem: "Whenever you activate an ability that isn't a mana ability, copy it."
function abilityCopiers(pid) {
  const RE = /Whenever you activate an ability that isn't a mana ability, copy it/i;
  return [
    ...cardsIn(pid, 'battlefield').filter((x) => RE.test(oracle(x).replace(/"[^"]*"/g, ''))).map((x) => nameTag(x)), // not Rowan's quoted emblem text
    ...(G.s.players[pid].emblems || []).filter((e) => RE.test(e)).map(() => 'The emblem'),
  ];
}
// copiers are counted when the ability is activated (an emblem it creates doesn't copy it)
async function copyAbility(pid, text, src, cx, copiers) {
  for (const who of copiers) {
    const again = await resolveEffects(text, src, cx);
    log(pid, `${who} copies the ability${again.length ? ': ' + again.join('; ') : ''}.`);
  }
}

// Turn a face-down permanent face up (special action) — morph/megamorph/disguise/manifest.
export async function turnFaceUp(pid, c, env) {
  const real = { ...c, faceDown: false };
  const m = (oracle(real).match(/(?:^|\n)(Morph|Megamorph|Disguise) ((?:\{[^}]+\})+)/) || []);
  let cost = m[2];
  if (!cost && c.manifested && /Creature/.test(DB[c.def].faces[0].typeLine)) cost = DB[c.def].faces[0].manaCost;
  if (!cost) return env.say("This card can't be turned face up that way.");
  const p = await env.pay(pid, cost, cardName(real), {});
  if (!p) return false;
  applyPayment(pid, p);
  c.faceDown = false;
  c.turnedUpTurn = G.s.turn;
  delete c.wardTwo;
  if (m[1] === 'Megamorph') addCounters(c, '+1/+1', 1);
  log(pid, `${nameTag(c)} is turned face up.`);
  queueEvent({ type: 'turnedFaceUp', iid: c.iid, controller: pid });
  return true;
}

// Companion: pay {3} to put it into your hand (sorcery speed).
export async function companionToHand(pid, c, env) {
  const s = G.s;
  if (!(s.active === pid && (s.step === 'main1' || s.step === 'main2'))) return env.say('Only at sorcery speed.');
  const p = await env.pay(pid, '{3}', 'Companion', {});
  if (!p) return false;
  applyPayment(pid, p);
  move(c.iid, 'hand');
  log(pid, `${pid === 'p' ? 'You put' : 'The AI puts'} companion ${nameTag(c)} into hand.`);
  return true;
}

export { cascade, resolveSpell, costOf, etbText, altCost_ as altCost, mergeMutate, spellFilterOk, millCards, libTop, makeCard, typeLine, parseCost, kwNum, toughness };

// Number of colors in a player's commanders' color identity (War Room, Command Beacon-style costs)
export function identityColors(pid) {
  const cols = new Set();
  for (const c of Object.values(G.s.cards)) if (c.isCommander && c.owner === pid) for (const x of (DB[c.def].ci && DB[c.def].ci.length ? DB[c.def].ci : DB[c.def].colors) || []) cols.add(x);
  return cols.size;
}
function who_(pid) {
  return pid === 'p' ? 'You' : 'The AI';
}
