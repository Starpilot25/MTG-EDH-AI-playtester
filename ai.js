// Heuristic AI opponent. It plays lands, casts what it can afford, uses simple
// oracle-text parsing to resolve common effects, attacks and blocks.
import { DB } from './data.js';
import {
  hasSubtype, isLand, isCreature, isType, oracle, hasKw, power, toughness, cardValue, manaAbility, payCost,
  parseCost, canAttack, canBlock, isPermanentCard, face,
} from './rules.js';
import {
  G, card, cardsIn, zoneOf, move, draw, log, nameTag, changeLife, toBattlefield, createToken,
  genericTokenDef, stateBased, commanderTax, shuffle, opp, cardName, checkLoss,
} from './state.js';
import {
  analyze, etbText, spellText, costOf, legalTargets, resolveEffects, attachAura, attachTo, activatedAbilities, aiHelpers, knownEffect,
} from './effects.js';
import { fire, settle } from './triggers.js';

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
function sources(pid) {
  return cardsIn(pid, 'battlefield')
    .map((c) => {
      const m = manaAbility(c);
      return m ? { iid: c.iid, colors: m.colors, amount: m.amount } : null;
    })
    .filter(Boolean);
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
      return null;
    }
    const own = cands.filter((c) => c.controller === AI).sort(byValue);
    return own[0] ? { iid: own[0].iid } : null;
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
    while (picks.length < req.min && list.length > picks.length) picks.push(list.find((c) => !picks.includes(c.iid)).iid);
    return picks;
  },
  async scry() {},
};

aiHelpers.landScore = (c) => scoreLandForColors(c, neededColors());

function ctxFor(h, x = 0) {
  return { me: AI, x, choosers: { ai: aiChooser, p: h.playerChooser || aiChooser } };
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
function scoreSpell(c, pay) {
  const d = DB[c.def];
  const turn = G.s.turn;
  const text = isPermanentCard(d) ? etbText(c) : spellText(c);
  const a = analyze(text, pay.x);
  let s = d.cmc + 1;
  if (c.zone === 'command') s += 6;
  const isRamp = (d.produced.length && !isLand(c)) || a.ramp;
  if (isRamp) s += turn <= 6 ? 5 + Math.max(0, 4 - d.cmc) : 0.5;
  if (isCreature(c)) s += (power(c) + toughness(c)) / 3;
  if (a.counterspell) return -1;
  if (/^(?:Instant|Sorcery)/.test(d.faces[0].typeLine)) {
    const useful = a.removal || a.bounce || a.burn || a.wipe || a.massDamage || a.draw || a.token || a.ramp || a.tutor || a.drain || a.gain || a.edict || a.reanimate || a.regrowth || a.counters;
    if (!useful) {
      // pump spells, tricks, counters, unknown effects: hold them unless nothing else to do
      if (/until end of turn/i.test(text)) return -1;
      s -= 3;
    }
  }
  if (a.removal) {
    const tgt = bestTarget(P, a.removal.phrase);
    if (!tgt) return isPermanentCard(d) ? s - 2 : -1;
    s += cardValue(tgt);
  }
  if (a.bounce) {
    const tgt = bestTarget(P, a.bounce.phrase);
    if (!tgt && !isPermanentCard(d)) return -1;
    if (tgt) s += cardValue(tgt) / 2;
  }
  if (a.wipe) {
    const diff = threatLevel(P) - threatLevel(AI);
    if (diff < 8 && !isPermanentCard(d)) return -1;
    s += diff;
  }
  if (a.massDamage && /creature/.test(a.massDamage.phrase)) {
    const onlyThem = /your opponents control|an opponent controls/.test(a.massDamage.phrase);
    const loss = (pid) => cardsIn(pid, 'battlefield')
      .filter((x) => isCreature(x) && x.iid !== c.iid && toughness(x) - x.damage <= a.massDamage.amount && !hasKw(x, 'indestructible'))
      .reduce((sum, x) => sum + cardValue(x), 0);
    const net = loss(P) - (onlyThem ? 0 : loss(AI));
    if (net < 3 && !isPermanentCard(d)) return -1;
    s += Math.max(0, net);
  }
  if (a.edict) {
    if (!cardsIn(P, 'battlefield').some(isCreature) && !isPermanentCard(d)) return -1;
  }
  if (a.burn && /creature/.test(a.burn.to) && !/any target|player/.test(a.burn.to)) {
    if (!bestTarget(P, 'creature', (t) => toughness(t) - t.damage <= a.burn.amount) && !isPermanentCard(d)) return -1;
  }
  if (a.reanimate && !cardsIn(AI, 'graveyard').some((g) => isType(g, 'Creature')) && !isPermanentCard(d)) return -1;
  if (a.draw) s += a.draw * (cardsIn(AI, 'hand').length < 3 ? 1.5 : 0.8);
  if (hasSubtype(c, 'Aura')) {
    const buff = /enchanted creature gets \+/i.test(oracle(c));
    const lock = /enchanted creature can't attack|enchanted creature can't block|enchanted creature doesn't untap/i.test(oracle(c));
    if (buff && !cardsIn(AI, 'battlefield').some(isCreature)) return -1;
    if (lock && !bestTarget(P, 'creature')) return -1;
    if (!buff && !lock && /^Enchant creature/m.test(oracle(c))) return -1;
  }
  if (hasSubtype(c, 'Equipment') && !cardsIn(AI, 'battlefield').some(isCreature)) s -= 2;
  return s;
}

function castable() {
  const src = sources(AI);
  const out = [];
  const pool = [...cardsIn(AI, 'hand').filter((c) => !isLand(c)), ...cardsIn(AI, 'command')];
  for (const c of pool) {
    const tax = c.zone === 'command' ? commanderTax(AI, c.iid) : 0;
    const cost = costOf(c);
    if (!cost && !DB[c.def].faces[0].manaCost) continue; // uncastable (suspend-only, lands etc.)
    const hasX = /\{X\}/.test(cost);
    const pay = payCost(cost, src, { extraGeneric: tax, maxX: hasX ? 20 : 0, minX: 1 });
    if (!pay) continue;
    const score = scoreSpell(c, pay);
    if (score > 0) out.push({ c, pay, score, tax });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

async function castSpell(h, opt) {
  const { c, pay } = opt;
  const s = G.s;
  for (const iid of pay.payers) card(iid).tapped = true;
  const fromCmd = c.zone === 'command';
  if (fromCmd) s.players.ai.tax[c.iid] = (s.players.ai.tax[c.iid] || 0) + 1;
  const xs = pay.x ? ` (X = ${pay.x})` : '';
  // shown on the "stack" while the player decides whether to respond
  s.stack = { iid: c.iid, x: pay.x };
  log(AI, `AI casts ${nameTag(c)}${fromCmd ? ' from the command zone' : ''}${xs}.`);
  fire({ type: 'cast', iid: c.iid, def: c.def, controller: AI });
  h.render();
  const verdict = await h.respond(c.iid);
  if (G.s !== s) return;
  s.stack = null;
  if (verdict === 'counter') {
    move(c.iid, 'graveyard');
    log(P, `You counter ${nameTag(c)}.`);
    h.render();
    return;
  }
  const d = DB[c.def];
  const ctx = ctxFor(h, pay.x);
  if (isPermanentCard(d)) {
    toBattlefield(c.iid, AI);
    if (isType(c, 'Planeswalker')) c.counters.loyalty = parseInt(face(c).loyalty, 10) || 3;
    if (hasSubtype(c, 'Aura')) {
      const did = await attachAura(c, AI, ctx.choosers.ai);
      if (did.length) log(AI, `${nameTag(c)} ${did.join('; ')}.`);
    }
    const etb = etbText(c);
    const did = await resolveEffects(etb, c, ctx);
    if (did && did.length) log(AI, `${nameTag(c)} enters: ${did.join('; ')}.`);
    else if (etb) log(AI, `${nameTag(c)} has an enters trigger the AI couldn't automate — resolve it by hand if needed.`);
  } else {
    const did = await resolveEffects(spellText(c), c, ctx);
    move(c.iid, 'graveyard');
    if (did && did.length) log(AI, `${nameTag(c)} resolves: ${did.join('; ')}.`);
    else log(AI, `${nameTag(c)} resolves (effect not automated — apply it by hand if needed).`);
  }
  stateBased();
  h.render();
  await settle();
}

function playLand(h) {
  if (G.s.landPlayed) return false;
  const lands = cardsIn(AI, 'hand').filter(isLand);
  if (!lands.length) return false;
  const want = neededColors();
  lands.sort((a, b) => scoreLandForColors(b, want) - scoreLandForColors(a, want));
  const l = lands[0];
  const tapped = /enters (?:the battlefield )?tapped/i.test(oracle(l)) && !/unless/i.test(oracle(l));
  toBattlefield(l.iid, AI, { tapped });
  G.s.landPlayed = true;
  log(AI, `AI plays ${nameTag(l)}${tapped ? ' (tapped)' : ''}.`);
  h.render();
  return true;
}

async function planeswalkers(h) {
  for (const pw of cardsIn(AI, 'battlefield').filter((c) => isType(c, 'Planeswalker'))) {
    if (pw.usedTurn === G.s.turn) continue;
    const loyalty = pw.counters.loyalty || 0;
    const abilities = activatedAbilities(pw).filter((ab) => ab.kind === 'loyalty');
    if (!abilities.length) continue;
    const known = (ab) => knownEffect(ab.text);
    let pick = abilities.find((ab) => ab.cost >= 0 && known(ab));
    if (!pick) pick = abilities.find((ab) => ab.cost < 0 && loyalty + ab.cost >= 1 && known(ab));
    if (!pick) pick = abilities.find((ab) => ab.cost >= 0);
    if (!pick) continue;
    pw.counters.loyalty = loyalty + pick.cost;
    pw.usedTurn = G.s.turn;
    const did = await resolveEffects(pick.text, pw, ctxFor(h));
    log(AI, `${nameTag(pw)} uses ${pick.label}: ${did && did.length ? did.join('; ') : '<i>' + pick.text.slice(0, 90) + '</i> (resolve by hand if needed)'}.`);
    if (pw.counters.loyalty <= 0) move(pw.iid, 'graveyard');
    h.render();
  }
}

// Move unattached equipment onto the best creature when the AI can pay the equip cost.
function equipGear(h) {
  const creatures = cardsIn(AI, 'battlefield').filter((c) => isCreature(c)).sort((a, b) => cardValue(b) - cardValue(a));
  if (!creatures.length) return;
  for (const eq of cardsIn(AI, 'battlefield').filter((c) => hasSubtype(c, 'Equipment'))) {
    if (eq.attachedTo && card(eq.attachedTo) && card(eq.attachedTo).zone === 'battlefield') continue;
    const ab = activatedAbilities(eq).find((x) => x.kind === 'equip');
    if (!ab) continue;
    const pay = payCost(ab.mana, sources(AI));
    if (!pay) continue;
    pay.payers.forEach((i) => (card(i).tapped = true));
    attachTo(eq, creatures[0]);
    log(AI, `AI equips ${nameTag(eq)} to ${nameTag(creatures[0])}.`);
    h.render();
  }
}

// After combat, spend leftover mana on simple activated abilities (draw, transform, tokens, counters).
async function useAbilities(h) {
  const s0 = G.s;
  for (const c of cardsIn(AI, 'battlefield')) {
    if (G.s !== s0) return;
    for (const [k, ab] of activatedAbilities(c).entries()) {
      if (ab.kind !== 'ability' || ab.sac || /Discard|Pay \d+ life|Exile/i.test(ab.costText)) continue;
      const a = analyze(ab.text);
      if (!(a.draw || a.transform || a.token || a.selfCounters || a.counters || a.investigate || a.drain || a.burn)) continue;
      if (a.transform && c.face) continue; // already transformed
      c.usedAbilities = c.usedAbilities || {};
      if (c.usedAbilities[k] === G.s.turn) continue;
      if (ab.tap && (c.tapped || (isCreature(c) && c.sick && !hasKw(c, 'haste')))) continue;
      const pay = ab.mana ? payCost(ab.mana, sources(AI).filter((m) => m.iid !== c.iid || !ab.tap)) : { payers: [] };
      if (!pay) continue;
      pay.payers.forEach((i) => (card(i).tapped = true));
      if (ab.tap) c.tapped = true;
      c.usedAbilities[k] = G.s.turn;
      log(AI, `AI activates ${nameTag(c)}: <i>${ab.costText.replace(/~/g, cardName(c).split(',')[0])}</i>.`);
      const did = await resolveEffects(ab.text, c, ctxFor(h));
      if (did.length) log(AI, `${nameTag(c)}: ${did.join('; ')}.`);
      h.render();
      await settle();
      await h.wait(G.settings.aiSpeed);
    }
  }
}

export async function aiMainPhase(h, post = false) {
  const s0 = G.s;
  const wait = () => h.wait(G.settings.aiSpeed);
  if (playLand(h)) await wait();
  for (let guard = 0; guard < 20 && G.s === s0 && !G.s.winner; guard++) {
    const opts = castable();
    if (!opts.length) break;
    await castSpell(h, opts[0]);
    if (G.s !== s0) return;
    await wait();
  }
  if (G.s !== s0) return;
  await planeswalkers(h);
  if (G.s === s0) equipGear(h);
  if (G.s === s0 && post) await useAbilities(h);
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

  const attackers = [];
  for (const a of mine) {
    if (power(a) <= 0) continue;
    const k = killers(a);
    const survivesAll = k.length === 0;
    const goodTrade = k.every((b) => power(a) >= toughness(b) && cardValue(b) >= cardValue(a) - 1);
    const cmdLethalish = a.isCommander && (G.s.players.p.cmdDmg[a.iid] || 0) + power(a) >= 21;
    if (survivesAll || goodTrade || cmdLethalish) attackers.push(a);
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
      const keep = attackers.find((c) => !hasKw(c, 'vigilance'));
      if (!keep) break;
      attackers.splice(attackers.indexOf(keep), 1);
    }
  }
  return attackers.map((c) => c.iid);
}

export function aiChooseBlocks(attackerIds) {
  const blocks = {};
  const avail = potentialBlockers(AI);
  const used = new Set();
  const life = G.s.players.ai.life;
  const atk = attackerIds.map(card).sort((a, b) => power(b) - power(a));
  const incomingIf = () =>
    atk.filter((a) => !blocks[a.iid]).reduce((s, a) => s + Math.max(0, power(a)), 0);
  const cmdThreat = (a) => a.isCommander && (G.s.players.ai.cmdDmg[a.iid] || 0) + power(a) >= 21;

  for (const a of atk) {
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
    if (blocks[a.iid]) continue;
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
  if (hand.length <= 7) return;
  const lands = cardsIn(AI, 'battlefield').filter(isLand).length;
  hand.sort((a, b) => {
    const va = isLand(a) ? (lands >= 7 ? 0 : 10) : 10 - Math.abs(DB[a.def].cmc - lands);
    const vb = isLand(b) ? (lands >= 7 ? 0 : 10) : 10 - Math.abs(DB[b.def].cmc - lands);
    return va - vb;
  });
  const discard = hand.slice(0, hand.length - 7);
  discard.forEach((c) => move(c.iid, 'graveyard'));
  log(AI, `AI discards ${discard.map(nameTag).join(', ')} to hand size.`);
}

export { sources as manaSources, opp, checkLoss };
