// Heuristic AI opponent. It plays lands, casts what it can afford (using every way the card can be
// cast: kicker, flashback, adventures, commander from the command zone…), uses abilities, attacks
// and blocks. All casting goes through cast.js, the same pipeline the player uses.
import { DB } from './data.js';
import {
  hasSubtype, isLand, isCreature, isType, oracle, hasKw, power, toughness, cardValue, manaAbility, payCost,
  parseCost, canAttack, canBlock, isPermanentCard, mustAttack, totalMana,
} from './rules.js';
import {
  G, card, cardsIn, move, log, nameTag, opp, cardName, checkLoss, discard as discardCard, restoreInPlace, eventQueue,
} from './state.js';
import {
  spellFilterOk, analyze, etbText, spellText, costOf, legalTargets, activatedAbilities, aiHelpers, knownEffect, zoneAbilities,
  Cancelled,
} from './effects.js';
import { fire, settle } from './triggers.js';
import {
  manaSources, castOptions, castSpell as castThrough, effectiveCost, landOptions, playLand as playLandThrough, landsAllowed,
  activateAbility, useZoneAbility, turnFaceUp, companionToHand, applyPayment,
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
  return payCost(cost, src, {
    extraGeneric: opts.extraGeneric || 0,
    maxX: hasX ? (fixed !== undefined ? fixed : 20) : 0,
    minX: hasX ? (fixed !== undefined ? fixed : 1) : 0,
  });
}

// ------------------------------------------------------------ the AI's choices
function bestTarget(pid, phrase, pred = () => true) {
  const list = legalTargets(phrase, AI).filter((c) => c.controller === pid && pred(c));
  list.sort((a, b) => cardValue(b) - cardValue(a));
  return list[0] || null;
}

function threatLevel(pid) {
  return cardsIn(pid, 'battlefield').filter((c) => !isLand(c)).reduce((a, c) => a + cardValue(c), 0);
}

// How the AI answers the effect engine's questions.
export const aiChooser = {
  budget: 0, // spare mana for optional costs (kicker, buyback…) while casting
  async target(req) {
    const cands = req.candidates.map(card).filter(Boolean);
    const byValue = (a, b) => cardValue(b) - cardValue(a);
    if (req.harm) {
      let pool = cands.filter((c) => c.controller !== AI);
      if (req.amount !== undefined) {
        const killable = pool.filter((c) =>
          isCreature(c) ? toughness(c) - c.damage <= req.amount && !hasKw(c, 'indestructible') : (c.counters.loyalty || 0) <= req.amount
        );
        if (killable.length) pool = killable;
        else if (req.players && req.players.includes(P)) return { player: P };
      }
      pool.sort(byValue);
      if (pool[0]) return { iid: pool[0].iid };
      if (req.players && req.players.includes(P)) return { player: P };
      if (req.forced && cands[0]) return { iid: cands.sort((a, b) => cardValue(a) - cardValue(b))[0].iid };
      return null;
    }
    const own = cands.filter((c) => c.controller === AI).sort(byValue);
    if (own[0]) return { iid: own[0].iid };
    if (req.players && req.players.includes(AI)) return { player: AI };
    if (req.forced && cands[0]) return { iid: cands.sort((a, b) => cardValue(a) - cardValue(b))[0].iid };
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
  async scry() {},
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
  let worth = d.cmc + (spell.isCommander ? 3 : 0) + (a.wipe ? 6 : 0) + (a.removal || a.bounce || a.edict ? 3 : 0);
  if (isCreature(spell)) worth += (power(spell) + toughness(spell)) / 4;
  if (worth < 4) return false;
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
    fire({ type: 'cast', iid: c.iid, def: c.def, controller: AI });
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
  if (/enters (?:the battlefield )?tapped/i.test(oracle(c))) s -= 0.5;
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
  if (!perm) {
    const useful = a.removal || a.bounce || a.burn || a.wipe || a.massDamage || a.copy || a.venture || a.initiative || a.draw || a.token || a.ramp || a.tutor || a.drain || a.gain || a.edict || a.reanimate || a.regrowth || a.counters;
    if (!useful) {
      // pump spells, tricks, counters, unknown effects: hold them unless nothing else to do
      if (/until end of turn/i.test(text)) return -1;
      s -= 3;
    }
  }
  if (a.removal) {
    const tgt = bestTarget(P, a.removal.phrase);
    if (!tgt) return perm ? s - 2 : -1;
    s += cardValue(tgt);
  }
  if (a.bounce) {
    const tgt = bestTarget(P, a.bounce.phrase);
    if (!tgt && !perm) return -1;
    if (tgt) s += cardValue(tgt) / 2;
  }
  if (a.wipe) {
    const diff = threatLevel(P) - threatLevel(AI);
    if (diff < 8 && !perm) return -1;
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
    if (!bestTarget(P, 'creature', (t) => toughness(t) - t.damage <= a.burn.amount) && !perm) return -1;
  }
  if (a.reanimate && !cardsIn(AI, 'graveyard').some((g) => isType(g, 'Creature')) && !perm) return -1;
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

// Modes the AI knows how to use well.
const AI_MODES = new Set(['normal', 'back', 'adventure', 'fuse', 'flashback', 'escape', 'foretold', 'plotted', 'impulse', 'hideaway', 'fromGraveyard',
  'mayhem', 'disturb', 'aftermath', 'prototype', 'surge', 'spectacle', 'prowl', 'freerunning', 'overload', 'awaken', 'bestow', 'harmonize', 'omen']);

function castable() {
  const src = sources(AI);
  const units = totalMana(src);
  const out = [];
  const pool = [
    ...cardsIn(AI, 'hand').filter((c) => !isLand(c) || DB[c.def].faces.length > 1),
    ...cardsIn(AI, 'command').filter((c) => c.isCommander),
    ...cardsIn(AI, 'graveyard'),
    ...cardsIn(AI, 'exile'),
  ];
  for (const c of pool) {
    let best = null;
    for (const opt of castOptions(AI, c)) {
      if (!AI_MODES.has(opt.mode) || opt.other) continue;
      if (opt.mode === 'bestow' && !cardsIn(AI, 'battlefield').some(isCreature)) continue;
      const cost = opt.cost || '';
      if (!cost && !opt.free) continue; // uncastable (no mana cost)
      const eff = effectiveCost(AI, c, opt);
      const hasX = /\{X\}/.test(cost);
      const pay = payCost(cost, sources(AI, { convoke: hasKw(c, 'convoke'), improvise: hasKw(c, 'improvise'), delve: hasKw(c, 'delve'), self: c.iid }), { extraGeneric: eff.generic, maxX: hasX ? 20 : 0, minX: 1 });
      if (!pay) continue;
      const score = scoreSpell(c, pay, opt);
      if (score > 0 && (!best || score > best.score)) best = { c, pay, score, opt, spare: units - pay.payers.length - pay.special.length };
    }
    if (best) out.push(best);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

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
  if (!lands.length) return false;
  const want = neededColors();
  lands.sort((a, b) => scoreLandForColors(b, want) - scoreLandForColors(a, want));
  const l = lands[0];
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
  for (const pw of cardsIn(AI, 'battlefield').filter((c) => isType(c, 'Planeswalker'))) {
    if (pw.usedLoyaltyTurn === G.s.turn || pw.zone !== 'battlefield') continue;
    const loyalty = pw.counters.loyalty || 0;
    const abilities = activatedAbilities(pw).filter((ab) => ab.kind === 'loyalty');
    if (!abilities.length) continue;
    const known = (ab) => knownEffect(ab.text);
    let pick = abilities.find((ab) => ab.cost >= 0 && !ab.x && known(ab));
    if (!pick) pick = abilities.find((ab) => ab.cost < 0 && loyalty + ab.cost >= 1 && known(ab));
    if (!pick) pick = abilities.find((ab) => ab.cost >= 0 && !ab.x);
    if (!pick) continue;
    await safely(h, () => activateAbility(AI, pw, pick, aiEnv(h)));
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
      if (!(a.draw || a.transform || a.token || a.selfCounters || a.counters || a.investigate || a.drain || a.burn)) continue;
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
  for (let guard = 0; guard < 20 && G.s === s0 && !G.s.winner; guard++) {
    const opts = castable().filter((o) => o.c.aiSkip !== G.s.turn);
    if (!opts.length) break;
    await castSpell(h, opts[0]);
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

// Crew vehicles / saddle mounts that would make good attackers.
export async function aiPrepareCombat(h) {
  for (const v of cardsIn(AI, 'battlefield')) {
    for (const ab of activatedAbilities(v)) {
      if (ab.kind !== 'crew' && ab.kind !== 'saddle') continue;
      if (ab.kind === 'crew' && (isCreature(v) || v.crewedTurn === G.s.turn)) continue;
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
  const mine = cardsIn(AI, 'battlefield').filter((c) => canAttack(c) && !c.pacifiedBy);
  const theirs = potentialBlockers(P);
  const life = G.s.players.p.life;
  if (!mine.length) return [];
  const forced = mine.filter(mustAttack);

  const killers = (a) =>
    theirs.filter((b) => canBlock(b, a) && (power(b) >= toughness(a) - a.damage || hasKw(b, 'deathtouch')) && !hasKw(a, 'indestructible'));
  const blockableBy = (a) => theirs.filter((b) => canBlock(b, a));

  // all-in if lethal: unblockable damage + everything else minus the best blockers
  const evasive = mine.filter((a) => blockableBy(a).length === 0);
  const evasiveDmg = evasive.reduce((s, a) => s + Math.max(0, power(a)), 0);
  const rest = mine.filter((a) => !evasive.includes(a)).sort((a, b) => power(b) - power(a));
  const unblockedRest = rest.slice(theirs.length);
  const total = evasiveDmg + unblockedRest.reduce((s, a) => s + Math.max(0, power(a)), 0);
  if (total >= life) return mine.map((c) => c.iid);

  const attackers = [...forced];
  for (const a of mine) {
    if (attackers.includes(a) || power(a) <= 0) continue;
    const k = killers(a);
    const survivesAll = k.length === 0;
    const goodTrade = k.every((b) => power(a) >= toughness(b) && cardValue(b) >= cardValue(a) - 1);
    const cmdLethalish = a.isCommander && (G.s.players.p.cmdDmg[a.iid] || 0) + power(a) >= 21;
    const temporary = a.endOfTurn || hasKw(a, 'decayed'); // dashed, blitzed, unearthed: use it or lose it
    if (survivesAll || goodTrade || cmdLethalish || temporary) attackers.push(a);
  }
  // keep enough defense home
  const theirPower = cardsIn(P, 'battlefield').filter((c) => isCreature(c) && !c.pacifiedBy).reduce((s, c) => s + Math.max(0, power(c)), 0);
  const myLife = G.s.players.ai.life;
  if (theirPower >= myLife * 0.7) {
    attackers.sort((a, b) => toughness(a) - toughness(b));
    while (attackers.length) {
      const home = mine.filter((c) => !attackers.includes(c) || hasKw(c, 'vigilance'));
      const absorbed = home.length;
      if (theirPower - absorbed * 3 < myLife * 0.7 || absorbed >= cardsIn(P, 'battlefield').filter(isCreature).length) break;
      const keep = attackers.find((c) => !hasKw(c, 'vigilance') && !forced.includes(c));
      if (!keep) break;
      attackers.splice(attackers.indexOf(keep), 1);
    }
  }
  return attackers.map((c) => c.iid);
}

// Which player/planeswalker/battle each attacker goes after.
export function aiAttackTargets(attackers) {
  const targets = {};
  const pws = cardsIn(P, 'battlefield').filter((c) => isType(c, 'Planeswalker')).sort((a, b) => (b.counters.loyalty || 0) - (a.counters.loyalty || 0));
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
  const blocks = {};
  const avail = potentialBlockers(AI);
  const used = new Set();
  const life = G.s.players.ai.life;
  const atk = attackerIds.map(card).filter(Boolean).sort((a, b) => power(b) - power(a));
  const targets = (G.s.combat && G.s.combat.targets) || {};
  const atMe = (a) => !targets[a.iid] || targets[a.iid] === AI;
  const incomingIf = () =>
    atk.filter((a) => !blocks[a.iid] && atMe(a)).reduce((s, a) => s + Math.max(0, power(a)), 0);
  const cmdThreat = (a) => a.isCommander && atMe(a) && (G.s.players.ai.cmdDmg[a.iid] || 0) + power(a) >= 21;

  // provoked creatures must block their provoker
  for (const b of avail) {
    if (!b.provokedBy || !attackerIds.includes(b.provokedBy) || !canBlock(b, card(b.provokedBy))) continue;
    blocks[b.provokedBy] = [...(blocks[b.provokedBy] || []), b.iid];
    used.add(b.iid);
  }
  for (const a of atk) {
    if (blocks[a.iid]) continue;
    const cands = avail.filter((b) => !used.has(b.iid) && canBlock(b, a));
    if (!cands.length) continue;
    const kills = (b) => power(b) >= toughness(a) - a.damage || (hasKw(b, 'deathtouch') && power(b) > 0);
    const survives = (b) => hasKw(b, 'indestructible') || (toughness(b) - b.damage > power(a) && !hasKw(a, 'deathtouch'));
    const needTwo = hasKw(a, 'menace');
    let pick = null;
    // 1) eat it for free
    pick = cands.filter((b) => kills(b) && survives(b)).sort((x, y) => cardValue(x) - cardValue(y))[0];
    // 2) safe wall
    if (!pick) pick = cands.filter((b) => survives(b)).sort((x, y) => cardValue(x) - cardValue(y))[0];
    // 3) fair trade
    if (!pick) pick = cands.filter((b) => kills(b) && cardValue(b) <= cardValue(a) + 0.5).sort((x, y) => cardValue(x) - cardValue(y))[0];
    if (needTwo && pick) {
      const second = cands.find((b) => b !== pick);
      if (!second) pick = null;
      else {
        blocks[a.iid] = [pick.iid, second.iid];
        used.add(pick.iid);
        used.add(second.iid);
        continue;
      }
    }
    if (pick) {
      blocks[a.iid] = [pick.iid];
      used.add(pick.iid);
    }
  }
  // 4) chump if we'd die (or take commander lethal)
  for (const a of atk) {
    if (blocks[a.iid] || !atMe(a)) continue;
    const dying = incomingIf() >= life || cmdThreat(a) || (hasKw(a, 'infect') && G.s.players.ai.poison + power(a) >= 10);
    if (!dying) continue;
    const cands = avail.filter((b) => !used.has(b.iid) && canBlock(b, a)).sort((x, y) => cardValue(x) - cardValue(y));
    if (hasKw(a, 'menace')) {
      if (cands.length >= 2) {
        blocks[a.iid] = [cands[0].iid, cands[1].iid];
        used.add(cands[0].iid);
        used.add(cands[1].iid);
      }
    } else if (cands[0]) {
      blocks[a.iid] = [cands[0].iid];
      used.add(cands[0].iid);
    }
  }
  return blocks;
}

// End of turn: discard down to seven.
export function aiCleanup() {
  const hand = cardsIn(AI, 'hand');
  const max = /You have no maximum hand size/i.test(cardsIn(AI, 'battlefield').map(oracle).join('\n')) ? 99 : 7;
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
