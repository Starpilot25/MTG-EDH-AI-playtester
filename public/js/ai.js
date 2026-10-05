// Heuristic AI opponent. It plays lands, casts what it can afford (using every way the card can be
// cast: kicker, flashback, adventures, commander from the command zone…), uses abilities, attacks
// and blocks. All casting goes through cast.js, the same pipeline the player uses.
import { DB } from './data.js';
import {
  hasSubtype, isLand, isCreature, isType, oracle, hasKw, power, toughness, cardValue, manaAbility, payCost, payCostKeep,
  parseCost, canAttack, canBlock, isPermanentCard, mustAttack, totalMana,
} from './rules.js';
import {
  G, card, cardsIn, zoneOf, move, log, nameTag, libTop, opp, cardName, checkLoss, discard as discardCard, restoreInPlace, eventQueue, entersTapped,
 casualAI, withReadCache, handControl } from './state.js';
import {
  spellFilterOk, analyze, etbText, spellText, costOf, legalTargets, activatedAbilities, aiHelpers, knownEffect, zoneAbilities, understood, matchesFilter,
  Cancelled,
} from './effects.js';
import { fire, settle } from './triggers.js';
import { maxHandSize } from './statics.js';
import { threat, planBlocks, planAttack, fight, pumpOf, evasive, lifeWeight } from './aicombat.js';
import {
  manaSources, castOptions, castSpell as castThrough, effectiveCost, landOptions, playLand as playLandThrough, landsAllowed,
  activateAbility, useZoneAbility, turnFaceUp, companionToHand, applyPayment, timingOk, loyaltyUsesLeft,
} from './cast.js';

const AI = 'ai';
const P = 'p';
// ------------------------------------------------------------ mulligans
export function aiKeepHand() {
  const hand = cardsIn(AI, 'hand');
  const lands = hand.filter(isLand).length;
  const rocks = hand.filter((c) => !isLand(c) && DB[c.def].produced.length && DB[c.def].cmc <= 2).length;
  const mulls = G.s.players.ai.mulligans;
  if (mulls >= 2) return true;
  return lands + Math.min(rocks, 1) >= 3 && lands <= 5 && lands >= 2;
}

export function aiBottom(count) {
  const hand = cardsIn(AI, 'hand');
  const lands = hand.filter(isLand);
  const spells = hand.filter((c) => !isLand(c)).sort((a, b) => DB[b.def].cmc - DB[a.def].cmc);
  const picks = [];
  for (let k = 0; k < count; k++) {
    if (lands.length - picks.filter(isLand).length > 4) picks.push(lands.find((l) => !picks.includes(l)));
    else picks.push(spells.find((s) => !picks.includes(s)) || lands.find((l) => !picks.includes(l)));
  }
  picks.filter(Boolean).forEach((c) => move(c.iid, 'library', { to: 'bottom' }));
}

// ------------------------------------------------------------ mana
const sources = (pid = AI, opts = {}) => manaSources(pid, opts);
const cmcOf = (cost) => {
  const c = parseCost(cost || '');
  return c.generic + c.pips.length;
};

// Pay a cost automatically (used for both the AI's own costs and "pay {N}" questions).
export async function aiPay(pid, cost, label, opts = {}) {
  const src = sources(pid, opts).filter((m) => !(opts.exclude || []).includes(m.iid));
  const hasX = /\{X\}/.test(cost);
  const fixed = opts.xFixed;
  if (!hasX) return payCostKeep(cost, src, { extraGeneric: opts.extraGeneric || 0, waterbend: opts.waterbend || 0, self: opts.self }, pid);
  return payCost(cost, src, {
    extraGeneric: opts.extraGeneric || 0,
    waterbend: opts.waterbend || 0,
    maxX: hasX ? (fixed !== undefined ? fixed : 20) : 0,
    minX: hasX ? (fixed !== undefined ? fixed : 1) : 0,
  });
}

// ------------------------------------------------------------ the AI's choices
function bestTarget(pid, phrase, pred = () => true) {
  const list = legalTargets(phrase, AI).filter((c) => c.controller === pid && pred(c));
  list.sort((a, b) => threat(b) - threat(a));
  return list[0] || null;
}

function threatLevel(pid) {
  return cardsIn(pid, 'battlefield').filter((c) => !isLand(c)).reduce((a, c) => a + threat(c), 0);
}

// How the AI answers the effect engine's questions.
export const aiChooser = {
  budget: 0, // spare mana for optional costs (kicker, buyback…) while casting
  prefer: null, // a specific target the AI planned for (instant-speed tricks and removal)
  plan: null, // targets announced when the AI cast its spell (shown to you before you respond)
  async target(req) {
    const cands = req.candidates.map(card).filter(Boolean);
    if (aiChooser.plan && aiChooser.plan.length && !req.predict) {
      const k = aiChooser.plan.findIndex((w) => (w.player && (req.players || []).includes(w.player)) || (w.iid && req.candidates.includes(w.iid)));
      if (k >= 0) {
        const [w] = aiChooser.plan.splice(k, 1);
        return w.player ? { player: w.player } : { iid: w.iid };
      }
    }
    if (aiChooser.prefer) {
      const want = aiChooser.prefer;
      if (want.player && (req.players || []).includes(want.player)) return { player: want.player };
      if (want.iid && req.candidates.includes(want.iid)) return { iid: want.iid };
    }
    if (req.aiScore && cands.length) return { iid: cands.slice().sort((a, b) => req.aiScore(b) - req.aiScore(a))[0].iid };
    const byThreat = (a, b) => threat(b) - threat(a);
    const plife = G.s.players[P].life;
    if (req.purpose === 'blink') {
      // flicker our own permanents that get something out of it: enters-the-battlefield effects, a reset
      const val = (c) => {
        if (c.controller !== AI) return -1;
        if (c.token) return -100;
        const o = oracle(c);
        let v = 0;
        if (/When(?:ever)? (?:~|this [a-z]+|[^,.]*?) enters(?! tapped)[^.]*?,/i.test(o.split(DB[c.def].name).join('~'))) v += 6;
        if (c.tapped) v += 1;
        if (c.damage > 0) v += 1;
        if ((c.counters || {})['-1/-1']) v += 2;
        if (Object.values(G.s.cards).some((a) => a.attachedTo === c.iid && a.controller !== AI)) v += 4;
        if ((c.counters || {})['+1/+1']) v -= 2 * c.counters['+1/+1'];
        if (Object.values(G.s.cards).some((a) => a.attachedTo === c.iid && a.controller === AI)) v -= 3;
        if (isLand(c)) v -= 0.5;
        return v;
      };
      const best = cands.map((c) => [c, val(c)]).sort((a, b) => b[1] - a[1])[0];
      if (best && (best[1] > 0 || (req.forced && !req.optional))) return { iid: best[0].iid };
      return null;
    }
    if (req.harm) {
      // burn to the face when it's lethal
      if (req.amount !== undefined && req.players && req.players.includes(P) && req.amount >= plife) return { player: P };
      let pool = cands.filter((c) => c.controller !== AI);
      if (req.amount !== undefined) {
        const killable = pool.filter((c) =>
          isCreature(c) ? toughness(c) - c.damage <= req.amount && !hasKw(c, 'indestructible') : isType(c, 'Planeswalker') ? (c.counters.loyalty || 0) <= req.amount : false
        );
        if (killable.length) pool = killable;
        else if (req.players && req.players.includes(P)) return { player: P };
      }
      pool.sort(byThreat);
      if (pool[0] && (req.amount === undefined || threat(pool[0]) >= 2 || !(req.players || []).includes(P))) return { iid: pool[0].iid };
      if (req.players && req.players.includes(P)) return { player: P };
      if (pool[0]) return { iid: pool[0].iid };
      if (req.forced && cands[0]) return { iid: cands.sort((a, b) => threat(a) - threat(b))[0].iid };
      return null;
    }
    const own = cands.filter((c) => c.controller === AI).sort(byThreat);
    if (own[0]) return { iid: own[0].iid };
    if (req.players && req.players.includes(AI)) return { player: AI };
    if (req.forced && cands[0]) return { iid: cands.sort((a, b) => threat(a) - threat(b))[0].iid };
    return null;
  },
  async pickCards(req) {
    const list = req.cards.map(card).filter(Boolean);
    const score = req.aiScore || (() => 0);
    list.sort((a, b) => score(b) - score(a));
    const picks = [];
    for (const c of list) {
      if (picks.length >= req.max) break;
      // land searches: prefer different lands for color coverage
      if (req.purpose === 'land' && picks.some((p) => card(p).def === c.def) && list.some((o) => o.def !== c.def && !picks.includes(o.iid))) continue;
      picks.push(c.iid);
    }
    while (picks.length < (req.min || 0) && list.length > picks.length) picks.push(list.find((c) => !picks.includes(c.iid)).iid);
    return picks;
  },
  // scry / surveil: keep what it can use soon on top, bottom (or bin) the rest
  async scry({ n = 1, surveil = false, pid = AI } = {}) {
    const ids = libTop(pid, n);
    if (!ids.length) return;
    const bf = cardsIn(pid, 'battlefield');
    const lands = bf.filter(isLand).length + cardsIn(pid, 'hand').filter(isLand).length;
    const mana = lands + bf.filter((c) => !isLand(c) && DB[c.def].produced.length).length;
    // graveyard matters: Uurg, delirium, threshold, reanimation, "cards in your graveyard"
    const gyText = bf.map((c) => oracle(c)).join('\n');
    const landsInGy = /land cards? in your graveyard/i.test(gyText);
    const gyGood = landsInGy || /cards? in your graveyard|delirium|threshold|from your graveyard/i.test(gyText);
    const score = (c) => {
      const d = DB[c.def];
      const t = oracle(c);
      if (isLand(c)) return lands < 4 ? 3 : lands < 6 ? 1 : -1;
      let v = 1.5 + Math.min(d.cmc, 6) * 0.15;
      if (d.cmc > mana + 2) v -= 2;
      if (surveil && /flashback|unearth|escape|disturb|embalm|eternalize|jump-start|retrace|aftermath|mayhem|dredge/i.test(t)) v -= 1.5;
      return v;
    };
    const plan = ids.map((iid) => {
      const c = card(iid);
      let v = score(c);
      if (surveil && gyGood && isLand(c) && landsInGy && lands >= 4) v = -2;
      return { iid, v };
    });
    const keep = plan.filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
    const drop = plan.filter((x) => x.v <= 0);
    for (const x of [...keep].reverse()) move(x.iid, 'library');
    for (const x of drop) move(x.iid, surveil ? 'graveyard' : 'library', surveil ? {} : { to: 'bottom' });
    log(pid, `${pid === AI ? 'The AI' : 'You'} ${pid === AI ? (surveil ? 'surveils' : 'scries') : surveil ? 'surveil' : 'scry'} ${ids.length}: ${keep.length} on top, ${drop.length} ${surveil ? 'into the graveyard' : 'on the bottom'}${surveil && drop.length ? ` (${drop.map((x) => nameTag(card(x.iid))).join(', ')})` : ''}.`);
  },
  async choose(req) {
    return req.aiPick ? req.aiPick() : 0;
  },
  async confirm(title, question, info = {}) {
    info = info || {};
    if (info.gift) return false;
    if (info.cost) {
      const need = cmcOf(info.cost);
      if (aiChooser.budget >= need) {
        aiChooser.budget -= need;
        return true;
      }
      return false;
    }
    if (info.bargain) return cardsIn(AI, 'battlefield').some((x) => x.token);
    if (info.casualty) return cardsIn(AI, 'battlefield').some((x) => isCreature(x) && x.token);
    return true;
  },
  async chooseModes(req) {
    const score = req.aiScore || (() => 1);
    const order = req.modes.map((t, k) => ({ k, s: score(t) })).sort((a, b) => b.s - a.s);
    let want = Math.max(req.min ?? 1, 1);
    if (!req.spree && !req.escalate) want = Math.max(want, Math.min(req.max, req.min ?? 1));
    else
      for (const o of order.slice(1)) {
        const extra = req.spree ? (req.modes[o.k].match(/^\+((?:\{[^}]+\})+)/) || [])[1] : req.escalate;
        if (o.s > 0 && extra && aiChooser.budget >= cmcOf(extra) && want < req.max) {
          aiChooser.budget -= cmcOf(extra);
          want++;
        }
      }
    return order.slice(0, Math.min(want, req.max)).map((o) => o.k).sort((a, b) => a - b);
  },
  async chooseNumber(req) {
    if (aiChooser.nextX !== undefined && aiChooser.nextX !== null) {
      const v = Math.max(req.min ?? 0, Math.min(req.max ?? 99, aiChooser.nextX));
      aiChooser.nextX = null;
      return v;
    }
    return req.ai ?? req.min ?? 0;
  },
  // "Counter target spell unless its controller pays {N}" / ward: the AI pays when it can
  async payUnless(amount) {
    const pay = payCost(`{${amount}}`, sources(AI));
    if (!pay) return false;
    applyPayment(AI, pay);
    return true;
  },
};

// When you cast a spell, the AI may counter it if it holds a counterspell it can pay for.
export async function aiMaybeCounter(spell, h) {
  const d = DB[spell.def];
  const text = (isPermanentCard(d) ? etbText(spell) : spellText(spell)).toLowerCase();
  const a = analyze(text);
  // how much the AI cares about this spell
  let worth = d.cmc + (spell.isCommander ? 3 : 0) + (a.edict ? 3 : 0);
  if (isCreature(spell)) worth += threat({ ...spell, zone: 'battlefield', controller: P }) / 2;
  if (a.wipe) worth += threatLevel(AI) > threatLevel(P) ? 10 : -4; // only fight wipes that hurt us
  if (a.removal || a.bounce) worth += cardsIn(AI, 'battlefield').some((c) => !isLand(c) && threat(c) >= 6) ? 4 : 0;
  if (a.extraTurn || a.steal) worth += 6;
  if (a.burn && a.burn.amount >= G.s.players.ai.life) worth += 50;
  // save a hard counter for something that matters if the player still has cards
  let bar = zoneOf(P, 'hand').length >= 3 && G.s.turn > 6 ? 6 : 4;
  if (casualAI()) bar += 4; // casual: let most spells resolve
  if (worth < bar) return false;
  const src = sources(AI);
  for (const c of cardsIn(AI, 'hand')) {
    const m = oracle(c).match(/Counter target ([^.]*?)spell(?:[^.]*?unless its controller pays \{(\d+)\})?/i);
    if (!m) continue;
    if (!spellFilterOk(m[1].toLowerCase(), spell)) continue;
    const pay = payCost(costOf(c), src);
    if (!pay) continue;
    applyPayment(AI, pay);
    log(AI, `AI responds with ${nameTag(c)}, targeting your ${nameTag(spell)}.`);
    move(c.iid, 'graveyard');
    G.s.ts.ai.spells++;
    fire({ type: 'cast', iid: c.iid, def: c.def, controller: AI, from: 'hand' });
    h.render();
    await h.wait(G.settings.aiSpeed);
    if (m[2] && (await h.playerChooser.payUnless(+m[2], cardName(c)))) {
      log(P, `You pay {${m[2]}}; ${nameTag(spell)} isn't countered.`);
      return false;
    }
    log(AI, `${nameTag(c)} counters your ${nameTag(spell)}.`);
    return true;
  }
  return false;
}

aiHelpers.landScore = (c) => scoreLandForColors(c, neededColors());

// Everything cast.js needs to act for the AI.
export function aiEnv(h, extra = {}) {
  return {
    choosers: { ai: aiChooser, p: h.playerChooser || aiChooser },
    pay: (pid, cost, label, opts) => (pid === AI ? aiPay(pid, cost, label, opts) : h.payFor ? h.payFor(pid, cost, label, opts) : aiPay(pid, cost, label, opts)),
    render: () => h.render(),
    wait: (ms) => h.wait(ms),
    respond: (iid) => h.respond(iid),
    say: () => false,
    ...extra,
  };
}

function neededColors() {
  const need = {};
  for (const c of cardsIn(AI, 'hand')) for (const p of parseCost(costOf(c)).pips) p.forEach((col) => (need[col] = (need[col] || 0) + 1));
  for (const c of cardsIn(AI, 'command')) for (const p of parseCost(costOf(c)).pips) p.forEach((col) => (need[col] = (need[col] || 0) + 2));
  const have = {};
  for (const s of sources(AI)) s.colors.forEach((col) => (have[col] = (have[col] || 0) + 1));
  for (const c of cardsIn(AI, 'battlefield')) {
    const m = manaAbility({ ...c, tapped: false, sick: false });
    if (m) m.colors.forEach((col) => (have[col] = (have[col] || 0) + 1));
  }
  const out = {};
  for (const k of Object.keys(need)) out[k] = need[k] / (1 + (have[k] || 0));
  return out;
}

function scoreLandForColors(c, want) {
  const m = manaAbility({ ...c, tapped: false });
  if (!m) return -1;
  let s = 0;
  m.colors.forEach((col) => (s += want[col] || 0));
  const et = entersTapped({ ...c, controller: AI });
  if (et === true) s -= 0.5;
  return s + m.colors.length * 0.1;
}

// ------------------------------------------------------------ choosing spells
function scoreSpell(c, pay, opt = {}) {
  const d = DB[c.def];
  const f = d.faces[opt.face || 0] || d.faces[0];
  const turn = G.s.turn;
  const perm = isPermanentCard({ faces: [f] }) && opt.mode !== 'adventure';
  const fc = { ...c, face: opt.face || 0 };
  const text = perm ? etbText(fc) : spellText(fc);
  const a = analyze(text, pay.x);
  let s = d.cmc + 1;
  if (c.zone === 'command') s += 6;
  const isRamp = (d.produced.length && !isLand(c)) || a.ramp;
  if (isRamp) s += turn <= 6 ? 5 + Math.max(0, 4 - d.cmc) : 0.5;
  if (perm && /Creature/.test(f.typeLine)) s += (power(fc) + toughness(fc)) / 3;
  if (a.counterspell) return -1;
  // spells that need a target the board doesn't have do nothing (reanimating an empty graveyard, removal with no target…)
  if (!perm && !targetsAvailable(text, c)) return -1;
  if (!perm) {
    const useful = a.removal || a.bounce || a.burn || a.wipe || a.massDamage || a.copy || a.venture || a.initiative || a.draw || a.token || a.ramp || a.tutor || a.drain || a.gain || a.edict || a.reanimate || a.regrowth || a.counters;
    if (!useful) {
      // pump spells, tricks, counters, unknown effects: hold them unless nothing else to do
      if (/until end of turn/i.test(text)) return -1;
      s -= 3;
    }
  }
  if (a.removal) {
    const tgt = bestTarget(P, a.removal.phrase, (t) => !(a.removal.verb === 'destroy' && hasKw(t, 'indestructible')));
    if (!tgt) return perm ? s - 2 : -1;
    // save removal for things that matter: a real threat, or when the AI is under pressure
    const worth = threat(tgt);
    if (!perm && worth < removalBar(c, f)) return -1;
    s += perm ? Math.min(worth, cardValue(tgt)) : worth;
  }
  if (a.bounce) {
    const tgt = bestTarget(P, a.bounce.phrase);
    if (!tgt && !perm) return -1;
    if (tgt) s += cardValue(tgt) / 2;
  }
  if (a.wipe) {
    // partial wipes (Dusk: "creatures with power 3 or greater") only count what they actually hit
    const pw = text.match(/creatures with power (\d+) or (greater|less)/i);
    const hits = (c) => isCreature(c) && (!pw || (pw[2] === 'greater' ? power(c) >= +pw[1] : power(c) <= +pw[1]));
    const lost = (pid) => cardsIn(pid, 'battlefield').filter((c) => !isLand(c) && (pw ? hits(c) : true)).reduce((x, c) => x + threat(c), 0);
    const diff = pw ? lost(P) - lost(AI) : threatLevel(P) - threatLevel(AI);
    if (diff < (casualAI() ? 14 : 8) && !perm) return -1;
    s += diff;
  }
  if (a.massDamage && /creature/.test(a.massDamage.phrase)) {
    const onlyThem = /your opponents control|an opponent controls/.test(a.massDamage.phrase);
    const loss = (pid) => cardsIn(pid, 'battlefield')
      .filter((x) => isCreature(x) && x.iid !== c.iid && toughness(x) - x.damage <= a.massDamage.amount && !hasKw(x, 'indestructible'))
      .reduce((sum, x) => sum + cardValue(x), 0);
    const net = loss(P) - (onlyThem ? 0 : loss(AI));
    if (net < 3 && !perm) return -1;
    s += Math.max(0, net);
  }
  if (a.edict && !cardsIn(P, 'battlefield').some(isCreature) && !perm) return -1;
  if (a.burn && /creature/.test(a.burn.to) && !/any target|player/.test(a.burn.to)) {
    const t = bestTarget(P, 'creature', (x) => toughness(x) - x.damage <= a.burn.amount && !hasKw(x, 'indestructible'));
    if (!perm && (!t || threat(t) < removalBar(c, f) - 1)) return -1;
  }
  if (a.burn && /any target/.test(a.burn.to) && !perm) {
    // burn to the face only when it finishes the game or there's nothing worth killing
    const t = bestTarget(P, 'creature', (x) => toughness(x) - x.damage <= a.burn.amount && !hasKw(x, 'indestructible'));
    const lethal = a.burn.amount >= G.s.players[P].life;
    if (!lethal && (!t || threat(t) < removalBar(c, f) - 1) && a.burn.amount < 4) return -1;
  }
  if (a.reanimate) {
    const best = cardsIn(AI, 'graveyard').filter((g) => isType(g, 'Creature')).sort((x, y) => cardValue(y) - cardValue(x))[0];
    if (!best && !perm) return -1;
    if (best) s += cardValue(best) / 2;
  }
  if (a.regrowth && !perm && !cardsIn(AI, 'graveyard').length) return -1;
  if (a.draw) s += a.draw * (cardsIn(AI, 'hand').length < 3 ? 1.5 : 0.8);
  if (a.initiative) s += G.s.initiative === AI ? 1 : 4;
  if (a.venture) s += 1.5 * a.venture;
  if (hasSubtype(fc, 'Aura') && opt.mode !== 'bestow') {
    const buff = /enchanted creature gets \+/i.test(oracle(fc));
    const lock = /enchanted creature can't attack|enchanted creature can't block|enchanted creature doesn't untap/i.test(oracle(fc));
    if (buff && !cardsIn(AI, 'battlefield').some(isCreature)) return -1;
    if (lock && !bestTarget(P, 'creature')) return -1;
    if (!buff && !lock && /^Enchant creature/m.test(oracle(fc))) return -1;
  }
  if (hasSubtype(fc, 'Equipment') && !cardsIn(AI, 'battlefield').some(isCreature)) s -= 2;
  // alternative ways of casting
  if (opt.mode === 'overload' || opt.mode === 'awaken') s += 4;
  if (opt.mode === 'flashback' || opt.mode === 'escape' || opt.mode === 'foretold' || opt.mode === 'plotted' || opt.mode === 'impulse' || opt.mode === 'hideaway') s += 1; // card advantage
  if (opt.mode === 'impulse' && c.mayPlayUntil === G.s.turn) s += 3; // use it or lose it
  if (opt.mode === 'prototype') s -= 1;
  return s;
}

// How good a target has to be before the AI spends a removal spell on it.
function removalBar(c, f) {
  let bar = 3.5;
  if (/\bInstant\b/.test(f.typeLine) || hasKw(c, 'flash')) bar += 1.5; // instants wait for a better moment
  const myLife = G.s.players[AI].life;
  const incoming = cardsIn(P, 'battlefield').filter(isCreature).reduce((n, x) => n + Math.max(0, power(x)), 0);
  if (myLife <= 15 || incoming * 2 >= myLife) bar -= 2; // under pressure: use it now
  if (cardsIn(AI, 'hand').length >= 6) bar -= 1; // plenty of cards: less precious
  if (casualAI()) bar += myLife <= 15 ? 1.5 : 3; // casual: only answer real threats
  return bar;
}

// Does every required target in this text have at least one legal choice?
function targetsAvailable(text, c) {
  const t = String(text || '').toLowerCase();
  if (/choose (?:one|two|one or both|one or more|any number)/.test(t)) return true;
  for (const sent of t.split(/(?<=\.)\s+|\n/)) {
    const m = sent.match(/(?:^|[^a-z])(up to (?:one|two|three|four|x|\d+) |any number of )?(?:other |another )?target ([^,.;]+)/);
    if (!m || m[1]) continue;
    const ph = m[2];
    if (/^(?:player|opponent|spell|any target|creature or player|player or planeswalker|activated|triggered|instant or sorcery spell|creature spell|noncreature spell)/.test(ph)) continue;
    const gm = sent.match(/target ([a-z ,/-]*?)cards? (?:from|in) (your|a|an opponent's|target player's|target opponent's) graveyard/);
    if (gm) {
      const who = gm[2] === 'your' ? [AI] : /opponent|player's/.test(gm[2]) ? [P] : [AI, P];
      const kind = gm[1].trim().replace(/ or /g, '|').replace(/ and\/or /g, '|').replace(/,/g, '');
      const ok = who.flatMap((w) => cardsIn(w, 'graveyard')).some((g) => !kind || kind === 'permanent' ? true : new RegExp(kind.split(/\s*\|\s*|\s+/).filter((w) => w && !/^non/.test(w) && w !== 'permanent').join('|') || '.', 'i').test(DB[g.def].typeLine));
      if (!ok) return false;
      continue;
    }
    if (/graveyard|library|hand|exile/.test(ph)) continue;
    const phrase = ph.replace(/ (?:to|from|into|onto|with(?! (?:mana value|power|toughness|flying|a counter|an? [+-]1\/[+-]1 counter|defender|reach))|gets?|gains?|deals?|and(?! toughness)|until|that|if) .*$/, '').trim();
    if (!phrase) continue;
    try {
      if (!legalTargets(phrase, AI, c).length) return false;
    } catch (e) {
      return true;
    }
  }
  return true;
}

// Modes the AI knows how to use well.
const AI_MODES = new Set(['normal', 'back', 'adventure', 'fuse', 'flashback', 'escape', 'foretold', 'plotted', 'impulse', 'hideaway', 'fromGraveyard',
  'mayhem', 'disturb', 'aftermath', 'prototype', 'surge', 'spectacle', 'prowl', 'freerunning', 'overload', 'awaken', 'bestow', 'harmonize', 'omen']);

// Every way the AI could cast something right now, best option per card.
function options(filter = () => true) {
  const units = totalMana(sources(AI));
  const out = [];
  const pool = [
    ...cardsIn(AI, 'hand').filter((c) => !isLand(c) || DB[c.def].faces.length > 1),
    ...cardsIn(AI, 'command').filter((c) => c.isCommander),
    ...cardsIn(AI, 'graveyard'),
    ...cardsIn(AI, 'exile'),
    // Sen Triplets: spells from your hand, cast with the AI's mana
    ...(handControl(AI, P) ? cardsIn(P, 'hand').filter((c) => !isLand(c) || DB[c.def].faces.length > 1) : []),
  ];
  for (const c of pool) {
    if (c.aiSkip === G.s.turn) continue;
    let best = null;
    for (const opt of castOptions(AI, c)) {
      if (!AI_MODES.has(opt.mode) || opt.other) continue;
      if (!timingOk(AI, c, opt)) continue;
      if (opt.mode === 'bestow' && !cardsIn(AI, 'battlefield').some(isCreature)) continue;
      const cost = opt.cost || '';
      if (!cost && !opt.free) continue; // uncastable (no mana cost)
      const eff = effectiveCost(AI, c, opt);
      const hasX = /\{X\}/.test(cost);
      const pay = payCost(cost, sources(AI, { convoke: hasKw(c, 'convoke'), improvise: hasKw(c, 'improvise'), delve: hasKw(c, 'delve'), self: c.iid }), { extraGeneric: eff.generic, maxX: hasX ? 20 : 0, minX: 1 });
      if (!pay) continue;
      const f = DB[c.def].faces[opt.face || 0] || DB[c.def].faces[0];
      const fc = { ...c, face: opt.face || 0 };
      const perm = isPermanentCard({ faces: [f] }) && opt.mode !== 'adventure';
      const text = perm ? etbText(fc) : spellText(fc);
      const o = { c, pay, opt, perm, text, a: analyze(text, pay.x), pump: perm ? null : pumpOf(text), u: pay.payers.length + pay.special.length };
      o.role = roleOf(o, f);
      o.score = scoreSpell(c, pay, opt);
      o.spare = units - o.u;
      if (!filter(o)) continue;
      if (!best || o.score > best.score) best = o;
    }
    if (best) out.push(best);
  }
  return out;
}

// What an instant-speed card is for, so the AI knows when to hold it.
function roleOf(o, f) {
  const instant = /\bInstant\b/.test(f.typeLine) || hasKw(o.c, 'flash');
  if (!instant) return 'sorcery';
  if (o.a.counterspell) return 'counter';
  if (o.a.fog) return 'fog';
  if (o.pump) return 'trick';
  if (o.perm && /Creature/.test(f.typeLine)) return 'flash';
  if (o.a.removal || o.a.burn || o.a.bounce) return 'removal';
  return 'value';
}

// Mana the AI keeps open on its own turn for counterspells and instant-speed removal.
function reserveMana() {
  const held = options((o) => ['counter', 'removal', 'fog'].includes(o.role));
  if (!held.length) return 0;
  let r = 0;
  const counter = held.filter((o) => o.role === 'counter').sort((x, y) => x.u - y.u)[0];
  if (counter) r += counter.u;
  const removal = held.filter((o) => o.role === 'removal').sort((x, y) => x.u - y.u)[0];
  if (removal && G.s.turn > 4) r += removal.u;
  return r;
}

// Pick the best set of spells for the mana available (a small knapsack), and return the one to cast first.
function planMain(post) {
  const units = totalMana(sources(AI));
  const all = options().filter((o) => o.score > 0);
  // hold instants for the opponent's turn unless they're worth casting now
  const now = all.filter((o) => {
    if (o.role === 'counter' || o.role === 'fog' || o.role === 'trick') return false;
    if (o.role === 'removal') {
      const t = o.a.removal ? bestTarget(P, o.a.removal.phrase) : o.a.bounce ? bestTarget(P, o.a.bounce.phrase) : null;
      return (t && threat(t) >= 7) || (post && G.s.turn > 8 && o.score > 6);
    }
    if (o.role === 'flash' || o.role === 'value') return false; // cast at the end of the opponent's turn instead
    return true;
  });
  if (!now.length) return null;
  const budget = Math.max(0, units - (G.s.turn <= 3 ? 0 : reserveMana()));
  const cand = now.sort((x, y) => y.score - x.score).slice(0, 10);
  let bestSet = [];
  let bestVal = 0;
  for (let mask = 1; mask < 1 << cand.length; mask++) {
    let u = 0;
    let v = 0;
    const set = [];
    for (let k = 0; k < cand.length; k++) if (mask & (1 << k)) {
      u += cand[k].u;
      v += cand[k].score;
      set.push(cand[k]);
    }
    if (u <= budget && v > bestVal) {
      bestVal = v;
      bestSet = set;
    }
  }
  // a bomb is worth tapping out for
  const bomb = cand.filter((o) => o.score >= 12).sort((x, y) => y.score - x.score)[0];
  if (bomb && bomb.score > bestVal) return bomb;
  if (!bestSet.length) return null;
  // ramp first (it may pay for the rest), then the most expensive
  bestSet.sort((x, y) => y.u - x.u);
  const ramp = bestSet.find((o) => o.a.ramp || (o.perm && DB[o.c.def].produced.length && !isCreature({ ...o.c, zone: 'battlefield' })));
  return ramp || bestSet[0];
}

// kept for tests and the end-of-turn window
function castable() {
  return options().filter((o) => o.score > 0).sort((a, b) => b.score - a.score);
}
export { castable as __test_castable, planMain as __test_plan };

async function castSpell(h, plan) {
  const s = G.s;
  const snap = JSON.stringify({ s, nextId: 0 });
  const queued = eventQueue.length;
  aiChooser.budget = Math.max(0, plan.spare || 0);
  try {
    await castThrough(AI, plan.c.iid, plan.opt, aiEnv(h, { x: plan.pay.x || undefined }));
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    if (G.s === s) {
      if (eventQueue.length > queued) eventQueue.length = queued;
      restoreInPlace(snap);
    }
    if (card(plan.c.iid)) card(plan.c.iid).aiSkip = G.s.turn;
  } finally {
    aiChooser.budget = 0;
  }
  h.render();
  await settle();
}

function playLand(h) {
  const s = G.s;
  if ((s.landsPlayed || 0) >= landsAllowed(AI)) return false;
  const lands = cardsIn(AI, 'hand').filter((c) => landOptions(AI, c).length);
  // lands from the top of the library or exile the AI may play
  for (const c of cardsIn(AI, 'exile')) if (c.mayPlay === AI && (c.mayPlayUntil || 0) >= s.turn && isLand(c)) lands.push(c);
  // Sen Triplets: your lands too
  if (handControl(AI, P) && s.handControl.lands) for (const c of cardsIn(P, 'hand')) if (landOptions(AI, c).length) lands.push(c);
  if (!lands.length) return false;
  const want = neededColors();
  const landsOnField = cardsIn(AI, 'battlefield').filter(isLand).length;
  // bounce lands: great with a land to pick back up, useless with none
  const karoo = (c) => /When [^.]+ enters, return a land you control to its owner's hand/i.test(oracle(c));
  const landScore = (c) => scoreLandForColors(c, want) + (karoo(c) ? (landsOnField ? 2 : -20) : 0);
  lands.sort((a, b) => landScore(b) - landScore(a));
  const l = lands[0];
  if (karoo(l) && !landsOnField) return false;
  const opts = landOptions(AI, l);
  // MDFC spell // land: only play the land side when short on lands
  const landsOut = cardsIn(AI, 'battlefield').filter(isLand).length;
  const pick = opts.length > 1 ? opts[opts.length - 1] : opts[0] || { face: 0 };
  if (opts.length && !/\bLand\b/.test(DB[l.def].faces[0].typeLine) && landsOut >= 5) return false;
  playLandThrough(AI, l.iid, pick.face);
  h.render();
  return true;
}

async function planeswalkers(h) {
  // Oath of Teferi lets each one go twice; The Chain Veil gives each one another go
  for (let round = 0; round < 4; round++) {
    const before = G.s.log.length;
    await planeswalkersOnce(h);
    if (!(await chainVeil(h)) && G.s.log.length === before) break;
    if (G.s.log.length === before) break;
  }
}

// The Chain Veil: worth it once every planeswalker has used its ability and at least one has a good one left
async function chainVeil(h) {
  const pws = cardsIn(AI, 'battlefield').filter((c) => isType(c, 'Planeswalker'));
  if (!pws.length || pws.some((pw) => loyaltyUsesLeft(pw) > 0)) return false;
  for (const c of cardsIn(AI, 'battlefield')) {
    const ab = activatedAbilities(c).find((a) => a.kind === 'ability' && /activate one of its loyalty abilities once this turn/i.test(a.text));
    if (!ab || (ab.tap && c.tapped)) continue;
    if (ab.mana && !payCost(ab.mana, sources(AI).filter((m) => m.iid !== c.iid || !ab.tap))) continue;
    const r = await safely(h, () => activateAbility(AI, c, ab, aiEnv(h)));
    h.render();
    return r !== false;
  }
  return false;
}

async function planeswalkersOnce(h) {
  for (const pw of cardsIn(AI, 'battlefield').filter((c) => isType(c, 'Planeswalker'))) {
    if (loyaltyUsesLeft(pw) <= 0 || pw.zone !== 'battlefield') continue;
    const loyalty = pw.counters.loyalty || 0;
    const abilities = activatedAbilities(pw).filter((ab) => ab.kind === 'loyalty');
    if (!abilities.length) continue;
    const mineCreatures = cardsIn(AI, 'battlefield').filter(isCreature).length;
    // how much damage could come at this planeswalker next turn (your creatures, minus the AI's possible blockers)
    const danger = Math.max(0, cardsIn(P, 'battlefield').filter((x) => isCreature(x) && !x.pacifiedBy).reduce((n, x) => n + Math.max(0, power(x)), 0)
      - cardsIn(AI, 'battlefield').filter((x) => isCreature(x) && !x.tapped).reduce((n, x) => n + Math.max(0, power(x)), 0) / 2);
    // X abilities: work out the best X (and target) first, then score it like a fixed cost
    const planX = (ab) => {
      if (!ab.x) return null;
      const t = ab.text.toLowerCase();
      const up = ab.label.startsWith('+');
      if (up) return { x: Math.max(1, Math.min(3, loyalty)), cost: Math.max(1, Math.min(3, loyalty)) };
      const max = loyalty; // −X can use every counter, but a planeswalker left on 0 dies
      const keep = (x) => (x >= loyalty ? -4 : 0);
      let m;
      if ((m = t.match(/deals x damage to (?:target|up to one target|each of up to \w+ targets?|target tapped) ?([a-z ]*)/)) && !/each creature/.test(t)) {
        const foes = legalTargets(/planeswalker/.test(m[1]) ? 'creature or planeswalker' : 'creature', AI, pw).filter((c) => c.controller === P && !hasKw(c, 'indestructible') && (!/tapped/.test(t) || c.tapped));
        let best = null;
        for (const c of foes) {
          const need = isCreature(c) ? Math.max(1, toughness(c) - (c.damage || 0)) : (c.counters.loyalty || 0);
          if (need > max) continue;
          const v = threat(c) - need * 0.6 + keep(need);
          if (!best || v > best.v) best = { x: need, v, target: c.iid };
        }
        if (!best && /any target|player/.test(t) && max >= 2) return { x: max - 1, cost: -(max - 1), bonus: (max - 1) * 0.8 };
        return best ? { x: best.x, cost: -best.x, bonus: best.v, target: best.target } : { x: 0, cost: 0, bonus: -99 };
      }
      if (/deals x damage to each creature/.test(t)) {
        let best = { x: 0, v: -99 };
        for (let x = 1; x <= max; x++) {
          const loss = (pid) => cardsIn(pid, 'battlefield').filter((c) => isCreature(c) && toughness(c) - (c.damage || 0) <= x && !hasKw(c, 'indestructible')).reduce((n, c) => n + cardValue(c), 0);
          const v = loss(P) - loss(AI) - x * 0.5 + keep(x);
          if (v > best.v) best = { x, v };
        }
        return { x: best.x, cost: -best.x, bonus: best.v };
      }
      if ((m = t.match(/(?:mana value x|mana value equal to x)/))) {
        // tutor/reanimate by mana value: take the best card it can reach
        const kind = (t.match(/for an? ([a-z ]+?) card with mana value/) || [])[1];
        const pool = /graveyard/.test(t) ? cardsIn(AI, 'graveyard') : /search your library/.test(t) ? cardsIn(AI, 'library').filter((c) => !kind || matchesFilter(c, kind)) : [];
        const pick = pool.filter((c) => (DB[c.def].cmc || 0) < loyalty && !isLand(c)).sort((a, b) => cardValue(b) - cardValue(a))[0];
        if (!pick && /search your library/.test(t)) return { x: 0, cost: 0, bonus: -99 };
        const x = pick ? DB[pick.def].cmc || 0 : Math.max(1, loyalty - 1);
        return { x, cost: -x, bonus: pick ? cardValue(pick) : x * 0.8 };
      }
      // tokens, counters, mill, stun…: as big as possible while keeping it alive
      const x = Math.max(1, loyalty - 1);
      return { x, cost: -x, bonus: /create x|x \+1\/\+1 counters/.test(t) ? x * 1.6 : x * 0.6 };
    };
    const value = (ab) => {
      if (ab.x) {
        if (!understood(ab.text, pw)) return -99;
        const px = planX(ab);
        if (!px || px.bonus <= -50 || loyalty + px.cost < 0) return -99;
        ab.plan = px;
        let v = px.bonus + px.cost * 0.8;
        if (loyalty + px.cost === 0) v -= 4;
        if (danger >= loyalty + px.cost && loyalty + px.cost > 0) v -= 2;
        return v;
      }
      if (loyalty + ab.cost < 0) return -99;
      const a = analyze(ab.text);
      let v = 0;
      if (a.removal) {
        const t = bestTarget(P, a.removal.phrase);
        v += t ? threat(t) : -6;
      }
      if (a.bounce) {
        const t = bestTarget(P, a.bounce.phrase);
        v += t ? threat(t) / 2 : -4;
      }
      if (a.burn) v += /creature/.test(a.burn.to) ? (bestTarget(P, 'creature', (t) => toughness(t) - t.damage <= a.burn.amount) ? 4 : -3) : a.burn.amount * 0.8;
      if (a.wipe) v += threatLevel(P) - threatLevel(AI);
      if (a.token) v += 2.5 * (a.token.count || 1);
      if (a.draw) v += 1.8 * a.draw;
      if (a.counters) v += mineCreatures ? 2 : -2;
      if (a.teamPump) v += mineCreatures * 1.5;
      if (a.ramp || a.ritual) v += 1.5;
      if (a.gain || a.drain) v += 1;
      if (a.tutor) v += 2;
      if (/untap/i.test(ab.text)) v += 0.5;
      // Jace, the Mind Sculptor's ultimate: exiling your library wins the game
      if (/exile all cards from target (?:player|opponent)'s library/i.test(ab.text)) v += 25;
      if (/^look at the top card of target player's library/i.test(ab.text)) v += 1.5;
      if (!knownEffect(ab.text)) v -= 3;
      if (!understood(ab.text, pw)) return -99; // the engine can't do it properly: leave it alone
      v += ab.cost * 0.8; // loyalty is worth keeping
      if (loyalty + ab.cost === 0) v -= 4;
      // keep it alive: if your board can kill it after this ability, favour going up
      if (danger >= loyalty + ab.cost && loyalty + ab.cost > 0) v -= 2 + (ab.cost < 0 ? 2 : 0);
      if (ab.cost <= -6 && loyalty + ab.cost >= 0 && knownEffect(ab.text)) v += 6; // ultimate
      return v;
    };
    const pick = [...abilities].sort((x, y) => value(y) - value(x))[0];
    if (!pick || value(pick) < -50) continue;
    if (pick.x && pick.plan) {
      aiChooser.nextX = pick.plan.x;
      if (pick.plan.target) aiChooser.prefer = { iid: pick.plan.target };
    }
    await safely(h, () => activateAbility(AI, pw, pick, aiEnv(h)));
    aiChooser.nextX = null;
    aiChooser.prefer = null;
    h.render();
  }
}

// Run an action; if it gets cancelled halfway, put everything back.
async function safely(h, fn) {
  const s = G.s;
  const snap = JSON.stringify({ s, nextId: 0 });
  const queued = eventQueue.length;
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    if (G.s === s) {
      if (eventQueue.length > queued) eventQueue.length = queued;
      restoreInPlace(snap);
    }
    return false;
  } finally {
    await settle();
  }
}

// Move unattached equipment onto the best creature when the AI can pay the equip cost.
async function equipGear(h) {
  const creatures = () => cardsIn(AI, 'battlefield').filter((c) => isCreature(c)).sort((a, b) => cardValue(b) - cardValue(a));
  if (!creatures().length) return;
  for (const eq of cardsIn(AI, 'battlefield').filter((c) => hasSubtype(c, 'Equipment') && !isCreature(c))) {
    if (eq.attachedTo && card(eq.attachedTo) && card(eq.attachedTo).zone === 'battlefield') continue;
    const ab = activatedAbilities(eq).find((x) => x.kind === 'equip');
    if (!ab || !payCost(ab.mana, sources(AI))) continue;
    await safely(h, () => activateAbility(AI, eq, ab, aiEnv(h)));
    h.render();
  }
}

// Class levels, level up, face-down creatures, companions.
async function upgrades(h) {
  for (const c of cardsIn(AI, 'battlefield')) {
    if (c.faceDown && !c.manifestedNonCreature) {
      const m = oracle({ ...c, faceDown: false }).match(/(?:^|\n)(?:Morph|Megamorph|Disguise) ((?:\{[^}]+\})+)/);
      if (m && payCost(m[1], sources(AI))) await safely(h, () => turnFaceUp(AI, c, aiEnv(h)));
      continue;
    }
    for (const ab of activatedAbilities(c)) {
      if (ab.kind !== 'classlevel' && ab.kind !== 'levelup') continue;
      if (!payCost(ab.mana, sources(AI))) continue;
      await safely(h, () => activateAbility(AI, c, ab, aiEnv(h)));
      h.render();
      break;
    }
  }
  for (const c of cardsIn(AI, 'command').filter((x) => x.isCompanion)) {
    if (payCost('{3}', sources(AI)) && totalMana(sources(AI)) >= 3 + 2) await safely(h, () => companionToHand(AI, c, aiEnv(h)));
  }
}

// Spend leftover mana on simple activated abilities (draw, transform, tokens, counters).
async function useAbilities(h) {
  const s0 = G.s;
  for (const c of cardsIn(AI, 'battlefield')) {
    if (G.s !== s0) return;
    for (const ab of activatedAbilities(c)) {
      if (ab.kind !== 'ability' || ab.sac || /Discard|Pay \d+ life|Exile|Sacrifice/i.test(ab.costText)) continue;
      const a = analyze(ab.text);
      const prolif = a.proliferate && (cardsIn(AI, 'battlefield').some((x) => Object.entries(x.counters || {}).some(([k, v]) => v > 0 && k !== '-1/-1' && k !== 'stun')) ||
        cardsIn(P, 'battlefield').some((x) => (x.counters || {})['-1/-1'] > 0) || G.s.players[P].poison > 0);
      if (!(a.draw || a.transform || a.token || a.selfCounters || a.counters || a.investigate || a.drain || a.burn || prolif)) continue;
      if (a.transform && c.face) continue; // already transformed
      c.usedAbilities = c.usedAbilities || {};
      if (c.usedAbilities[ab.raw] === G.s.turn) continue;
      if (ab.tap && (c.tapped || (isCreature(c) && c.sick && !hasKw(c, 'haste')))) continue;
      if (ab.untap || ab.removeCounters) continue;
      if (ab.mana && !payCost(ab.mana.replace(/\{X\}/g, ''), sources(AI).filter((m) => m.iid !== c.iid || !ab.tap))) continue;
      await safely(h, () => activateAbility(AI, c, ab, aiEnv(h)));
      h.render();
      await h.wait(G.settings.aiSpeed);
    }
  }
}

// Cycling, unearth, plot, foretell, encore… when there's nothing better to do with the mana.
async function zoneActions(h, post) {
  const s = G.s;
  for (const c of [...cardsIn(AI, 'graveyard'), ...cardsIn(AI, 'hand')]) {
    if (G.s !== s) return;
    for (const ab of zoneAbilities(c)) {
      if (ab.kind === 'dredge' || ab.kind === 'ninjutsu' || ab.kind === 'forecast' || ab.kind === 'reinforce' || ab.kind === 'transmute') continue;
      if (ab.other) continue;
      if (ab.mana && !payCost(ab.mana, sources(AI))) continue;
      if (ab.kind === 'cycling') {
        const lands = cardsIn(AI, 'battlefield').filter(isLand).length;
        const deadCard = isLand(c) ? lands >= 7 : DB[c.def].cmc > lands + 3;
        if (!post || !deadCard) continue;
      }
      if ((ab.kind === 'unearth' || ab.kind === 'encore') && !(isCreature({ ...c, zone: 'battlefield' }) && power({ ...c, zone: 'battlefield' }) >= 3)) continue;
      if ((ab.kind === 'embalm' || ab.kind === 'eternalize' || ab.kind === 'scavenge') && !post) continue;
      if ((ab.kind === 'foretell' || ab.kind === 'plot' || ab.kind === 'suspend') && !post) continue;
      if (ab.kind === 'channel' && !knownEffect(ab.text)) continue;
      if (ab.kind === 'channel' && !post) continue;
      await safely(h, () => useZoneAbility(AI, c.iid, ab, aiEnv(h)));
      h.render();
      break;
    }
  }
}

export async function aiMainPhase(h, post = false) {
  const s0 = G.s;
  const wait = () => h.wait(G.settings.aiSpeed);
  if (playLand(h)) await wait();
  await upgrades(h);
  // with The Chain Veil out, use the planeswalkers (and the Veil) before mana goes to spells
  if (!post && cardsIn(AI, 'battlefield').some((c) => isType(c, 'Planeswalker')) && cardsIn(AI, 'battlefield').some((c) => /activate one of its loyalty abilities once this turn/i.test(oracle(c)))) await planeswalkers(h);
  for (let guard = 0; guard < 20 && G.s === s0 && !G.s.winner; guard++) {
    const plan = withReadCache(() => planMain(post));
    if (!plan) break;
    await castSpell(h, plan);
    if (G.s !== s0) return;
    if (playLand(h)) await wait(); // a land drop unlocked by an extra-land effect
    await wait();
  }
  if (G.s !== s0) return;
  await planeswalkers(h);
  if (G.s === s0) await equipGear(h);
  if (G.s === s0) await zoneActions(h, post);
  if (G.s === s0 && post) await useAbilities(h);
}

// ------------------------------------------------------------ instant speed
/**
 * The AI gets a chance to act at instant speed:
 *  'attackers'  you declared attackers (removal on a big attacker, a flash blocker, a fog)
 *  'blocks'     it has blocked your attackers (pump a blocker to win the fight)
 *  'ownBlocked' you blocked its attackers (pump an attacker, or remove a blocker)
 *  'endStep'    the end of your turn (flash creatures, card draw, removal, abilities)
 */
export async function aiInstantWindow(h, kind) {
  const s0 = G.s;
  if (!s0 || s0.winner || s0.phase !== 'play') return;
  for (let guard = 0; guard < 4 && G.s === s0 && !s0.winner; guard++) {
    const play = chooseInstant(kind);
    if (!play) break;
    aiChooser.prefer = play.target || null;
    try {
      await castSpell(h, play.o);
    } finally {
      aiChooser.prefer = null;
    }
    if (G.s !== s0) return;
    h.render();
    await h.wait(Math.min(600, G.settings.aiSpeed));
  }
  if (kind === 'endStep' && G.s === s0) await useAbilities(h);
}

function chooseInstant(kind) {
  const s = G.s;
  const cb = s.combat;
  const opts = options((o) => o.role !== 'sorcery' && o.role !== 'counter');
  if (!opts.length) return null;
  const myLife = s.players.ai.life;
  const theirLife = s.players.p.life;
  const removalTargets = (o) => {
    const phrase = o.a.removal ? o.a.removal.phrase : o.a.bounce ? o.a.bounce.phrase : o.a.burn && /creature|any target/.test(o.a.burn.to) ? 'creature' : null;
    if (!phrase) return [];
    let list = legalTargets(phrase, AI).filter((c) => c.controller === P);
    if (o.a.burn && !o.a.removal) list = list.filter((c) => isCreature(c) && toughness(c) - (c.damage || 0) <= o.a.burn.amount && !hasKw(c, 'indestructible'));
    if (o.a.removal && o.a.removal.verb === 'destroy') list = list.filter((c) => !hasKw(c, 'indestructible'));
    return list;
  };
  let best = null;
  const consider = (o, gain, target) => {
    if (gain > 0 && (!best || gain > best.gain)) best = { o, gain, target };
  };
  if (kind === 'attackers' && cb) {
    const atk = cb.attackers.map(card).filter(Boolean);
    const blocks = planBlocks(AI, cb.attackers);
    const through = atk.reduce((n, a) => n + ((cb.targets || {})[a.iid] && cb.targets[a.iid] !== AI ? 0 : fight(a, (blocks[a.iid] || []).map(card)).through), 0);
    const dying = through >= myLife;
    for (const o of opts) {
      if (o.role === 'fog' && (dying || through >= myLife * 0.4)) consider(o, dying ? 100 : through * lifeWeight(myLife), null);
      if (o.role === 'removal') {
        for (const t of removalTargets(o).filter((c) => cb.attackers.includes(c.iid))) {
          const r = fight(t, (blocks[t.iid] || []).map(card));
          const gain = threat(t) + r.through * lifeWeight(myLife) + (dying && r.through ? 50 : 0) - (casualAI() ? 7 : 4);
          consider(o, gain, { iid: t.iid });
        }
      }
      if (o.role === 'flash') {
        // a surprise blocker that eats an attacker or saves a lot of damage
        const proto = { ...o.c, zone: 'battlefield', controller: AI, tapped: false, sick: true, damage: 0 };
        for (const a of atk) {
          if (!canBlock(proto, a)) continue;
          const r = fight(a, [proto]);
          const gain = (r.aDies ? threat(a) : 0) + (r.dead.length ? -threat(proto) * 0.5 : 2) + (dying ? 20 : 0);
          consider(o, gain, null);
        }
      }
    }
  }
  if ((kind === 'blocks' || kind === 'ownBlocked') && cb) {
    const mine = kind === 'blocks' ? 'blockers' : 'attackers';
    for (const aid of cb.attackers) {
      const a = card(aid);
      if (!a) continue;
      const bl = (cb.blocks[aid] || []).map(card).filter(Boolean);
      if (!bl.length && kind === 'blocks') continue;
      const base = fight(a, bl);
      for (const o of opts) {
        if (o.role === 'trick' && o.pump) {
          const mineList = mine === 'blockers' ? bl : [a];
          for (const m of mineList) {
            const r = fight(a, bl, { [m.iid]: o.pump });
            let gain = 0;
            if (mine === 'blockers') {
              if (base.dead.includes(m.iid) && !r.dead.includes(m.iid)) gain += threat(m) + 1;
              if (!base.aDies && r.aDies) gain += threat(a) + 1;
            } else {
              if (base.aDies && !r.aDies) gain += threat(a) + 1;
              for (const d of r.dead) if (!base.dead.includes(d)) gain += threat(card(d));
              const extra = r.through - base.through;
              if (extra > 0) {
                const total = cb.attackers.reduce((n, i) => n + (card(i) ? fight(card(i), (cb.blocks[i] || []).map(card).filter(Boolean)).through : 0), 0);
                gain += extra * lifeWeight(theirLife) + (total < theirLife && total + extra >= theirLife ? 100 : 0);
              }
            }
            consider(o, gain - 1.5, { iid: m.iid });
          }
        }
        if (o.role === 'removal' && kind === 'ownBlocked' && bl.length) {
          // kill a blocker so the attacker survives or gets through
          for (const t of removalTargets(o).filter((c) => bl.some((b) => b.iid === c.iid))) {
            const rest = bl.filter((b) => b.iid !== t.iid);
            const r = fight(a, rest);
            const gain = threat(t) + (base.aDies && !r.aDies ? threat(a) : 0) + (r.through - base.through) * lifeWeight(theirLife) - 3;
            consider(o, gain, { iid: t.iid });
          }
        }
      }
    }
  }
  if (kind === 'endStep') {
    for (const o of opts) {
      if (o.role === 'fog' || o.role === 'trick') continue;
      if (o.role === 'removal') {
        const t = removalTargets(o).sort((x, y) => threat(y) - threat(x))[0];
        if (t && threat(t) >= 4) consider(o, threat(t), { iid: t.iid });
        else if (o.a.burn && /any target|player/.test(o.a.burn.to) && o.a.burn.amount >= theirLife) consider(o, 100, { player: P });
        continue;
      }
      if (o.score > 0) consider(o, o.score, null);
    }
  }
  return best ? { o: best.o, target: best.target } : null;
}

// Crew vehicles / saddle mounts that would make good attackers.
export async function aiPrepareCombat(h) {
  for (const v of cardsIn(AI, 'battlefield')) {
    for (const ab of activatedAbilities(v)) {
      if (ab.kind !== 'crew' && ab.kind !== 'saddle') continue;
      if (ab.kind === 'crew' && (isCreature(v) || v.crewedTurn === G.s.turn)) continue;
      // a vehicle that just came in can't attack, so don't tap creatures to crew it
      if (ab.kind === 'crew' && v.sick && !hasKw(v, 'haste')) continue;
      if (ab.kind === 'saddle' && v.saddledTurn === G.s.turn) continue;
      const helpers = cardsIn(AI, 'battlefield').filter((x) => isCreature(x) && !x.tapped && x.iid !== v.iid && (x.sick || power(x) < (ab.n || 0) || !canAttack(x)));
      const total = helpers.reduce((a, x) => a + Math.max(0, power(x)), 0);
      if (total < (ab.n || 0)) continue;
      await safely(h, () => activateAbility(AI, v, ab, aiEnv(h)));
      h.render();
    }
  }
}

// ------------------------------------------------------------ combat
function potentialBlockers(pid) {
  return cardsIn(pid, 'battlefield').filter((c) => isCreature(c) && !c.tapped && !c.pacifiedBy);
}

export function aiChooseAttackers() {
  return withReadCache(() => aiChooseAttackersRaw());
}
function aiChooseAttackersRaw() {
  return planAttack(AI);
}

// Which player/planeswalker/battle each attacker goes after.
export function aiAttackTargets(attackers) {
  return withReadCache(() => aiAttackTargetsRaw(attackers));
}
function aiAttackTargetsRaw(attackers) {
  const targets = {};
  const jaceSafe = G.s.noAttackJace && G.s.noAttackJace.turn === G.s.turn && G.s.noAttackJace.owner === P;
  const pws = cardsIn(P, 'battlefield').filter((c) => isType(c, 'Planeswalker') && !(jaceSafe && hasSubtype(c, 'Jace'))).sort((a, b) => (b.counters.loyalty || 0) - (a.counters.loyalty || 0));
  const battles = cardsIn(AI, 'battlefield').concat(cardsIn(P, 'battlefield')).filter((c) => isType(c, 'Battle') && c.controller === P);
  const totalPower = attackers.reduce((a, i) => a + Math.max(0, power(card(i))), 0);
  const lethal = totalPower >= G.s.players.p.life;
  const left = [...attackers].sort((a, b) => power(card(a)) - power(card(b)));
  if (!lethal) {
    for (const pw of pws) {
      let need = pw.counters.loyalty || 0;
      const sent = [];
      for (const i of left) {
        if (need <= 0) break;
        if (card(i).isCommander) continue;
        sent.push(i);
        need -= power(card(i));
      }
      if (need <= 0 && sent.length < left.length) for (const i of sent) {
        targets[i] = pw.iid;
        left.splice(left.indexOf(i), 1);
      }
    }
    for (const b of battles) {
      const i = left.find((x) => power(card(x)) >= (b.counters.defense || 0) && !card(x).isCommander);
      if (i && left.length > 1) {
        targets[i] = b.iid;
        left.splice(left.indexOf(i), 1);
      }
    }
  }
  for (const i of left) targets[i] = P;
  return targets;
}

export function aiChooseBlocks(attackerIds) {
  return withReadCache(() => aiChooseBlocksRaw(attackerIds));
}
function aiChooseBlocksRaw(attackerIds) {
  return planBlocks(AI, attackerIds);
}

// End of turn: discard down to seven.
export function aiCleanup() {
  const hand = cardsIn(AI, 'hand');
  const max = maxHandSize(AI);
  if (hand.length <= max) return;
  const lands = cardsIn(AI, 'battlefield').filter(isLand).length;
  hand.sort((a, b) => {
    const va = isLand(a) ? (lands >= 7 ? 0 : 10) : 10 - Math.abs(DB[a.def].cmc - lands);
    const vb = isLand(b) ? (lands >= 7 ? 0 : 10) : 10 - Math.abs(DB[b.def].cmc - lands);
    return va - vb;
  });
  const toss = hand.slice(0, hand.length - max);
  toss.forEach((c) => discardCard(c.iid));
  log(AI, `AI discards ${toss.map(nameTag).join(', ')} to hand size.`);
}

export { sources as manaSources, opp, checkLoss };
