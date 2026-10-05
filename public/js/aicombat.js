// The AI's combat brain: how dangerous each permanent is, a combat simulator (first strike,
// double strike, deathtouch, trample, indestructible, infect), a blocking planner that works for
// either player (the AI uses it to block, and to predict how you'll block its attacks), and an
// attack planner that weighs damage, trades, lethal and the counter-attack.
import { DB } from './data.js';
import {
  isCreature, isType, isLand, oracle, hasKw, power, toughness, canBlock, canAttack, mustAttack, manaAbility, kwNum,
} from './rules.js';
import { G, card, cardsIn, opp, casualAI } from './state.js';

// ------------------------------------------------------------ how dangerous is it?
export function threat(c) {
  if (!c) return 0;
  const o = oracle(c);
  let t = 0;
  if (isCreature(c)) {
    const p = Math.max(0, power(c));
    t += p * 1.4 + Math.max(0, toughness(c)) * 0.4;
    if (evasive(c)) t += p * 0.6 + 1;
    if (hasKw(c, 'trample')) t += p * 0.2;
    if (hasKw(c, 'double strike')) t += p;
    else if (hasKw(c, 'first strike')) t += 0.8;
    if (hasKw(c, 'lifelink')) t += p * 0.3;
    if (hasKw(c, 'deathtouch')) t += 2;
    if (hasKw(c, 'infect')) t += p * 1.8;
    if (kwNum(c, 'Toxic')) t += kwNum(c, 'Toxic') * 1.2;
    if (hasKw(c, 'indestructible')) t += 2;
    if (hasKw(c, 'hexproof') || hasKw(c, 'shroud')) t += 1;
    if (hasKw(c, 'vigilance')) t += 0.5;
    if (kwNum(c, 'Annihilator')) t += kwNum(c, 'Annihilator') * 3;
  }
  if (isType(c, 'Planeswalker')) t += 4 + ((c.counters || {}).loyalty || 0) * 0.8;
  if (isType(c, 'Battle')) t += 1;
  if (c.isCommander) {
    t += 4;
    const foe = opp(c.controller || c.owner);
    const dmg = G.s ? G.s.players[foe].cmdDmg[c.iid] || 0 : 0;
    if (isCreature(c) && dmg + power(c) >= 21) t += 8;
    else if (dmg >= 10) t += 3;
  }
  // engines: triggered abilities, anthems, activated abilities, mana
  t += (o.match(/(?:^|\n)(?:[A-Z][\w' ]+ — )?(?:Whenever|At the beginning)/g) || []).length * 1.5;
  if (/creatures you control get \+|other [a-z ]*creatures you control get \+|creatures you control have/i.test(o)) t += 3;
  if (/(?:^|\n)[^:\n]*: (?!Add\b)/.test(o) && !isType(c, 'Planeswalker')) t += 1;
  if (/(?:spells|abilities) your opponents cast cost|can't cast|can't attack you|doesn't untap/i.test(o)) t += 2;
  if (manaAbility({ ...c, tapped: false, sick: false })) t += isLand(c) ? 0 : 1;
  if (isLand(c) && !isCreature(c)) t = Math.min(t, 1) + 0.3;
  t += ((DB[c.def] && DB[c.def].cmc) || 0) * 0.3;
  if (c.token && !isCreature(c)) t *= 0.5;
  return t;
}

export function evasive(c) {
  const o = oracle(c);
  return hasKw(c, 'flying') || hasKw(c, 'shadow') || hasKw(c, 'horsemanship') || hasKw(c, 'fear') || hasKw(c, 'intimidate') ||
    /can't be blocked(?!\s+by creatures with power)/i.test(o) || hasKw(c, 'menace');
}

// ------------------------------------------------------------ combat simulator
/**
 * Simulate one attacker against its blockers.
 * mods: {iid: {p, t, indestructible, firstStrike, deathtouch}} temporary changes (pump spells)
 * Returns {aDies, dead:[blocker iids], through: damage to the player, lifelink}
 */
export function fight(a, blockers, mods = {}) {
  const md = (x) => mods[x.iid] || {};
  const P = (x) => Math.max(0, power(x) + (md(x).p || 0));
  const Tg = (x) => toughness(x) + (md(x).t || 0);
  const kw = (x, k) => hasKw(x, k) || (k === 'indestructible' && md(x).indestructible) || (k === 'first strike' && md(x).firstStrike) || (k === 'deathtouch' && md(x).deathtouch);
  const fs = (x) => kw(x, 'first strike') || kw(x, 'double strike');
  const ds = (x) => kw(x, 'double strike');
  const state = new Map();
  for (const x of [a, ...blockers]) state.set(x.iid, { dmg: x.damage || 0, dt: false, minus: 0 });
  const dead = (x) => {
    const st = state.get(x.iid);
    if (Tg(x) - st.minus <= 0) return true;
    if (kw(x, 'indestructible')) return false;
    return st.dmg >= Tg(x) - st.minus || st.dt;
  };
  const hit = (src, tgt, n) => {
    if (n <= 0) return;
    const st = state.get(tgt.iid);
    if (kw(src, 'infect') || kw(src, 'wither')) st.minus += n;
    else st.dmg += n;
    if (kw(src, 'deathtouch')) st.dt = true;
  };
  let through = 0;
  let lifelink = 0;
  const anyFirst = [a, ...blockers].some(fs);
  for (const step of anyFirst ? ['first', 'regular'] : ['regular']) {
    const deals = (x) => (step === 'first' ? fs(x) : !fs(x) || ds(x));
    const pending = [];
    if (!dead(a) && deals(a)) {
      let left = P(a);
      const alive = blockers.filter((b) => !dead(b));
      if (!blockers.length) through += left;
      else {
        alive.forEach((b, k) => {
          if (left <= 0) return;
          const st = state.get(b.iid);
          const lethal = kw(a, 'deathtouch') ? 1 : Math.max(0, Tg(b) - st.minus - st.dmg);
          const give = k === alive.length - 1 && !kw(a, 'trample') ? left : Math.min(left, lethal);
          pending.push([a, b, give]);
          left -= give;
        });
        if (left > 0 && (kw(a, 'trample') || !alive.length)) {
          if (kw(a, 'trample')) through += left;
        }
      }
      if (kw(a, 'lifelink')) lifelink += P(a);
    }
    for (const b of blockers) if (!dead(b) && deals(b)) pending.push([b, a, P(b)]);
    for (const [src, tgt, n] of pending) hit(src, tgt, n);
  }
  return { aDies: dead(a), dead: blockers.filter(dead).map((b) => b.iid), through, lifelink };
}

// ------------------------------------------------------------ blocking
// How much a point of damage matters to a player at this life total.
export function lifeWeight(life) {
  return 0.35 + 12 / Math.max(1, life);
}

/**
 * Choose blocks for `defender` against `attackerIds`.
 * opts.untapAll: pretend the defender's creatures are untapped (for predicting next turn)
 * Returns {blockerIid: ...} as {attackerIid: [blockerIids]}
 */
export function planBlocks(defender, attackerIds, opts = {}) {
  const s = G.s;
  const pl = s.players[defender];
  const atk = attackerIds.map((i) => (typeof i === 'string' ? card(i) : i)).filter(Boolean);
  const targets = (s.combat && s.combat.targets) || opts.targets || {};
  const atMe = (a) => !targets[a.iid] || targets[a.iid] === defender;
  let pool = cardsIn(defender, 'battlefield').filter((c) => isCreature(c) && !c.pacifiedBy);
  if (opts.untapAll) pool = pool.map((c) => ({ ...c, tapped: false }));
  pool = pool.filter((c) => !c.tapped);
  if (opts.exclude) pool = pool.filter((c) => !opts.exclude.includes(c.iid));
  const ok = (b, a) => canBlock(b, a) || (opts.untapAll && canBlock({ ...b, tapped: false }, a));
  const blocks = {};
  const used = new Set();
  const w = lifeWeight(pl.life);
  const incoming = atk.filter(atMe).reduce((n, a) => n + Math.max(0, power(a)), 0);
  const pressure = incoming >= pl.life * 0.5 ? 1.6 : 1;
  // provoked creatures must block their provoker
  for (const b of pool) {
    const a = b.provokedBy && atk.find((x) => x.iid === b.provokedBy);
    if (a && ok(b, a)) {
      blocks[a.iid] = [...(blocks[a.iid] || []), b.iid];
      used.add(b.iid);
    }
  }
  const order = [...atk].sort((x, y) => threat(y) - threat(x));
  const dmgCost = (a, through) => {
    if (!atMe(a)) return through * 0.3; // hitting a planeswalker/battle
    if (hasKw(a, 'infect')) return through * w * 3;
    let v = through * w * pressure;
    if (a.isCommander && (pl.cmdDmg[a.iid] || 0) + through >= 21) v += 100;
    return v;
  };
  for (const a of order) {
    if (blocks[a.iid]) continue;
    const cands = pool.filter((b) => !used.has(b.iid) && ok(b, a)).sort((x, y) => threat(x) - threat(y));
    if (!cands.length) continue;
    const needTwo = hasKw(a, 'menace') || /can't be blocked except by two or more/i.test(oracle(a));
    const options = [];
    const evalOpt = (bl) => {
      const r = fight(a, bl);
      const unblocked = fight(a, []);
      let v = dmgCost(a, unblocked.through) - dmgCost(a, r.through);
      if (r.aDies) v += threat(a) + 1;
      for (const d of r.dead) v -= threat(pool.find((b) => b.iid === d)) + 0.5;
      return { bl, v, chump: !r.aDies && r.dead.length === bl.length };
    };
    if (!needTwo) for (const b of cands.slice(0, 8)) options.push(evalOpt([b]));
    const top = cands.slice(0, 5);
    for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) options.push(evalOpt([top[i], top[j]]));
    options.sort((x, y) => y.v - x.v);
    const best = options[0];
    if (best && best.v > 0.5 && !best.chump) {
      blocks[a.iid] = best.bl.map((b) => b.iid);
      best.bl.forEach((b) => used.add(b.iid));
    }
  }
  // still dying? chump-block the biggest hits
  const through = () => order.filter((a) => atMe(a)).reduce((n, a) => n + fight(a, (blocks[a.iid] || []).map((i) => pool.find((b) => b.iid === i) || card(i))).through, 0);
  const poisonIn = () => order.filter((a) => atMe(a) && hasKw(a, 'infect') && !(blocks[a.iid] || []).length).reduce((n, a) => n + Math.max(0, power(a)), 0) +
    order.filter((a) => atMe(a) && kwNum(a, 'Toxic') && !(blocks[a.iid] || []).length).reduce((n, a) => n + kwNum(a, 'Toxic'), 0);
  const cmdLethal = (a) => a.isCommander && atMe(a) && !(blocks[a.iid] || []).length && (pl.cmdDmg[a.iid] || 0) + power(a) >= 21;
  for (const a of order) {
    if (opts.noChump) break;
    const dying = through() >= pl.life || pl.poison + poisonIn() >= 10 || cmdLethal(a);
    if (!dying) break;
    if ((blocks[a.iid] || []).length || !atMe(a)) continue;
    const needTwo = hasKw(a, 'menace');
    const cands = pool.filter((b) => !used.has(b.iid) && ok(b, a)).sort((x, y) => threat(x) - threat(y));
    const take = needTwo ? cands.slice(0, 2) : cands.slice(0, 1);
    if (take.length < (needTwo ? 2 : 1)) continue;
    blocks[a.iid] = take.map((b) => b.iid);
    take.forEach((b) => used.add(b.iid));
  }
  return blocks;
}

// ------------------------------------------------------------ attacking
// Score an attack: damage and trades now, minus what the counter-attack costs.
export function scoreAttack(attacker, ids) {
  const s = G.s;
  const def = opp(attacker);
  const dpl = s.players[def];
  const me = s.players[attacker];
  const atk = ids.map(card).filter(Boolean);
  if (!atk.length) return { score: -crackBack(attacker, []) * lifeWeight(me.life) * 0.3, lethal: false };
  const blocks = planBlocks(def, ids, { targets: {} });
  let score = 0;
  let dmg = 0;
  let poison = 0;
  let cmdHit = false;
  for (const a of atk) {
    const bl = (blocks[a.iid] || []).map(card).filter(Boolean);
    const r = fight(a, bl);
    dmg += hasKw(a, 'infect') ? 0 : r.through;
    if (hasKw(a, 'infect')) poison += r.through;
    if (r.through && kwNum(a, 'Toxic')) poison += kwNum(a, 'Toxic');
    if (a.isCommander && r.through && (dpl.cmdDmg[a.iid] || 0) + r.through >= 21) cmdHit = true;
    if (r.aDies) score -= (threat(a) + 1);
    for (const d of r.dead) score += threat(card(d)) + 0.5;
    if (r.through && a.isCommander) score += r.through * 0.3;
  }
  const lethal = dmg >= dpl.life || dpl.poison + poison >= 10 || cmdHit;
  if (lethal) return { score: 1000 + dmg, lethal: true, blocks };
  score += dmg * lifeWeight(dpl.life - dmg) + poison * 1.2;
  const back = crackBack(attacker, atk.filter((a) => !hasKw(a, 'vigilance')).map((a) => a.iid));
  if (back >= me.life) score -= 500;
  else score -= back * lifeWeight(me.life) * 0.35;
  return { score, lethal: false, blocks };
}

// How much damage the opponent could swing back with next turn if `tappedIds` stay tapped.
export function crackBack(pid, tappedIds) {
  const foe = opp(pid);
  const theirs = cardsIn(foe, 'battlefield').filter((c) => isCreature(c) && !c.pacifiedBy && !hasKw(c, 'defender'));
  if (!theirs.length) return 0;
  const home = cardsIn(pid, 'battlefield').filter((c) => isCreature(c) && !tappedIds.includes(c.iid) && !c.pacifiedBy);
  const blocks = planBlocks(pid, theirs.map((c) => ({ ...c, tapped: false, sick: false })), { exclude: tappedIds, noChump: true, untapAll: true });
  let dmg = 0;
  for (const a of theirs) {
    const bl = (blocks[a.iid] || []).map((i) => home.find((h) => h.iid === i)).filter(Boolean);
    dmg += fight(a, bl).through;
  }
  return dmg;
}

// Choose attackers: start from everything that can attack, drop the worst until no drop helps;
// also build up from nothing, and keep the better plan.
export function planAttack(pid) {
  const mine = cardsIn(pid, 'battlefield').filter((c) => canAttack(c) && !c.pacifiedBy && Math.max(0, power(c)) + kwNum(c, 'Annihilator') > 0 || (canAttack(c) && mustAttack(c)));
  const forced = mine.filter(mustAttack).map((c) => c.iid);
  const all = mine.map((c) => c.iid);
  if (!all.length) return [];
  const score = (ids) => scoreAttack(pid, ids).score;
  // top-down
  let down = [...all];
  let best = score(down);
  for (let guard = 0; guard < all.length; guard++) {
    let pick = null;
    for (const i of down) {
      if (forced.includes(i)) continue;
      const v = score(down.filter((x) => x !== i));
      if (v > best + 0.01) {
        best = v;
        pick = i;
      }
    }
    if (!pick) break;
    down = down.filter((x) => x !== pick);
  }
  // bottom-up
  let up = [...forced];
  let bestUp = score(up);
  for (let guard = 0; guard < all.length; guard++) {
    let pick = null;
    for (const i of all) {
      if (up.includes(i)) continue;
      const v = score([...up, i]);
      if (v > bestUp + 0.01) {
        bestUp = v;
        pick = i;
      }
    }
    if (!pick) break;
    up.push(pick);
  }
  let chosen = bestUp > best ? up : down;
  // Casual AI: no all-in swings. Unless the attack is lethal, keep enough creatures home to block
  // (the best blockers stay back), the way a friendly pod plays.
  if (casualAI() && pid === 'ai' && chosen.length && !scoreAttack(pid, chosen).lethal) {
    const foes = cardsIn(opp(pid), 'battlefield').filter((c) => isCreature(c) && !hasKw(c, 'defender'));
    const keep = Math.min(Math.ceil(foes.length / 2), Math.max(0, mine.length - 1));
    const home = mine.filter((c) => !chosen.includes(c.iid) && !hasKw(c, 'vigilance')).length;
    let need = keep - home;
    if (need > 0) {
      const byBlock = chosen.map(card).filter((c) => !forced.includes(c.iid) && !hasKw(c, 'vigilance')).sort((a, b) => toughness(b) + power(b) / 2 - (toughness(a) + power(a) / 2));
      for (const c of byBlock) {
        if (need <= 0) break;
        chosen = chosen.filter((i) => i !== c.iid);
        need--;
      }
    }
  }
  // temporary creatures (dash, blitz, unearth, decayed) attack anyway — they're leaving
  for (const c of mine) if ((c.endOfTurn || hasKw(c, 'decayed')) && !chosen.includes(c.iid)) chosen.push(c.iid);
  return chosen;
}

// How a pump spell changes a fight: "+3/+3", "gains indestructible", "first strike", "deathtouch".
export function pumpOf(text) {
  const t = String(text || '').toLowerCase();
  if (!/target creature/.test(t) || !/until end of turn/.test(t)) return null;
  const m = t.match(/target creature(?: you control)? gets \+(\d+)\/\+(\d+)/);
  const out = { p: m ? +m[1] : 0, t: m ? +m[2] : 0 };
  if (/gains? [^.]*indestructible/.test(t)) out.indestructible = true;
  if (/gains? [^.]*(first strike|double strike)/.test(t)) out.firstStrike = true;
  if (/gains? [^.]*deathtouch/.test(t)) out.deathtouch = true;
  if (!out.p && !out.t && !out.indestructible && !out.firstStrike && !out.deathtouch) return null;
  return out;
}
