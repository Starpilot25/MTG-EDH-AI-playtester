// Rules helpers: card faces, types, keywords, power/toughness, mana, combat damage.
import { DB } from './data.js';

export const COLORS = ['W', 'U', 'B', 'R', 'G', 'C'];

export function def(inst) {
  return DB[inst.def];
}
export function face(inst) {
  const d = DB[inst.def];
  return d.faces[inst.face || 0] || d.faces[0];
}
export function typeLine(inst) {
  return face(inst).typeLine || DB[inst.def].typeLine;
}
export function isType(inst, t) {
  return new RegExp('\\b' + t + '\\b', 'i').test(typeLine(inst).split('—')[0]);
}
// Subtypes live after the dash: "Enchantment — Aura", "Artifact — Equipment".
export function hasSubtype(inst, t) {
  const parts = typeLine(inst).split('—');
  return parts.length > 1 && new RegExp('\\b' + t + '\\b', 'i').test(parts.slice(1).join(' '));
}
export const isLand = (i) => isType(i, 'Land');
export const isCreature = (i) => !i.faceDown && isType(i, 'Creature');
export const isPermanentCard = (d) => !/\b(Instant|Sorcery)\b/.test(d.faces[0].typeLine.split('—')[0]);
export function oracle(inst) {
  return face(inst).oracle || '';
}

export function hasKw(inst, kw) {
  if (inst.faceDown) return false;
  kw = kw.toLowerCase();
  if ((inst.grants || []).includes(kw)) return true;
  for (const b of Object.values(inst.auraBuffs || {})) if (b.grants.includes(kw)) return true;
  if ((inst.eotGrants || []).includes(kw)) return true;
  const d = DB[inst.def];
  if (d.keywords.includes(kw)) {
    // keywords array covers every face; double-check this face mentions it.
    const o = oracle(inst).toLowerCase();
    return d.faces.length === 1 || o.includes(kw);
  }
  return false;
}

function num(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

export function basePT(inst) {
  if (inst.faceDown) return { p: 2, t: 2 };
  const f = face(inst);
  return { p: num(f.power), t: num(f.toughness) };
}
const auraSum = (inst, k) =>
  Object.values(inst.auraBuffs || {}).reduce((a, b) => a + b[k], 0) + (inst.eot ? inst.eot[k] : 0);
export function power(inst) {
  const c = inst.counters || {};
  return basePT(inst).p + (c['+1/+1'] || 0) - (c['-1/-1'] || 0) + (inst.ptMod ? inst.ptMod.p : 0) + auraSum(inst, 'p');
}
export function toughness(inst) {
  const c = inst.counters || {};
  return basePT(inst).t + (c['+1/+1'] || 0) - (c['-1/-1'] || 0) + (inst.ptMod ? inst.ptMod.t : 0) + auraSum(inst, 't');
}

export function cardValue(inst) {
  const d = DB[inst.def];
  let v = d.cmc || 0;
  if (isCreature(inst)) {
    v += (power(inst) + toughness(inst)) / 2;
    for (const k of ['flying', 'trample', 'deathtouch', 'lifelink', 'double strike', 'first strike', 'hexproof', 'indestructible', 'menace'])
      if (hasKw(inst, k)) v += 1;
  }
  if (inst.isCommander) v += 4;
  if (inst.token && !isCreature(inst)) v -= 1;
  return v;
}

// ------------------------------------------------------------ mana
// Returns {generic, pips:[[colors...]], x, phyrexian}
export function parseCost(cost) {
  const out = { generic: 0, pips: [], x: 0 };
  for (const m of String(cost || '').matchAll(/\{([^}]+)\}/g)) {
    const s = m[1].toUpperCase();
    if (/^\d+$/.test(s)) out.generic += parseInt(s, 10);
    else if (s === 'X') out.x++;
    else if (s === 'C') out.pips.push(['C']);
    else if (COLORS.includes(s)) out.pips.push([s]);
    else if (s.includes('/')) {
      const parts = s.split('/');
      if (parts.includes('P')) out.pips.push(parts.filter((p) => p !== 'P')); // pay with mana; ignore life option
      else if (parts.some((p) => /^\d$/.test(p))) out.pips.push([...parts.filter((p) => !/^\d$/.test(p)), '2GEN']);
      else out.pips.push(parts);
    } else if (s === 'S') out.pips.push(['ANY']);
  }
  return out;
}

// What a permanent can tap for: list of colors (one mana) or null.
export function manaAbility(inst) {
  if (inst.tapped || inst.faceDown) return null;
  const d = DB[inst.def];
  const o = oracle(inst);
  const produced = d.produced.length ? d.produced : [];
  if (isLand(inst)) {
    if (produced.length) return { colors: produced, amount: 1 };
    // basic land types without produced data
    const t = typeLine(inst);
    const map = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
    const cs = Object.keys(map).filter((k) => t.includes(k)).map((k) => map[k]);
    return cs.length ? { colors: cs, amount: 1 } : null;
  }
  if (!produced.length) return null;
  // Rocks and dorks: need a "{T}: Add" ability that costs nothing else.
  const m = o.match(/\{T\}: Add ([^.]+)\./);
  if (!m) return null;
  if (isCreature(inst) && inst.sick && !hasKw(inst, 'haste')) return null;
  let amount = 1;
  const syms = m[1].match(/\{[WUBRGC]\}/g);
  if (syms && !/\bor\b/.test(m[1]) && /^(\{[WUBRGC]\})+$/.test(m[1].replace(/\s/g, ''))) amount = syms.length;
  return { colors: produced, amount };
}

// Try to pay a cost with sources [{iid, colors, amount}].  Returns {payers:[iid], x} or null.
export function payCost(cost, sources, opts = {}) {
  const c = parseCost(cost);
  const extra = opts.extraGeneric || 0;
  // expand sources into single-mana units
  const units = [];
  for (const s of sources) for (let k = 0; k < s.amount; k++) units.push({ iid: s.iid, colors: s.colors });
  const used = new Array(units.length).fill(false);
  // colored pips first, most constrained first
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
    let bestFlex = 99;
    units.forEach((u, k) => {
      if (used[k]) return;
      if (u.colors.some((col) => want.includes(col)) && u.colors.length < bestFlex) {
        best = k;
        bestFlex = u.colors.length;
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
  }
  let generic = c.generic + genericFromHybrid + extra;
  // generic: use least flexible units first (colorless before 5-color)
  const order = units.map((u, k) => k).filter((k) => !used[k]).sort((a, b) => units[a].colors.length - units[b].colors.length);
  if (order.length < generic) return null;
  for (let k = 0; k < generic; k++) used[order[k]] = true;
  let x = 0;
  if (c.x && opts.maxX) {
    const left = order.length - generic;
    x = Math.min(left, opts.maxX);
    for (let k = generic; k < generic + x; k++) used[order[k]] = true;
  }
  if (c.x && x < (opts.minX || 1) && opts.maxX) return null;
  const payers = [];
  used.forEach((u, k) => u && payers.push(units[k].iid));
  return { payers, x };
}

export function totalMana(sources) {
  return sources.reduce((a, s) => a + s.amount, 0);
}

// ------------------------------------------------------------ combat
export function canBlock(blocker, attacker) {
  if (!isCreature(blocker) || blocker.tapped || blocker.pacifiedBy) return false;
  if (/can't block/i.test(oracle(blocker)) && !/can't block (?:creatures with|.*unless)/i.test(oracle(blocker))) return false;
  if (hasKw(attacker, 'flying') && !hasKw(blocker, 'flying') && !hasKw(blocker, 'reach')) return false;
  if (/can't be blocked(?! by| except| unless)/i.test(oracle(attacker))) return false;
  if (hasKw(attacker, 'shadow') && !hasKw(blocker, 'shadow')) return false;
  return true;
}

export function canAttack(inst) {
  if (!isCreature(inst) || inst.tapped || inst.pacifiedBy) return false;
  if (hasKw(inst, 'defender') || /can't attack/i.test(oracle(inst))) return false;
  if (inst.sick && !hasKw(inst, 'haste')) return false;
  return true;
}

export function isDead(inst) {
  if (!isCreature(inst)) return false;
  if (toughness(inst) <= 0) return true;
  if (hasKw(inst, 'indestructible')) return false;
  return inst.damage >= toughness(inst) || inst.deathtouched;
}

/**
 * Resolve combat damage.
 * attackers: [iid], blocks: {attackerIid: [blockerIid,...]}
 * Returns events: [{type:'player', from, to, amount, commander}, {type:'creature', from, to, amount}, {type:'life', who, amount}]
 * Mutates damage on creatures only; caller applies player events and deaths.
 */
export function combatDamage(cards, attackers, blocks, defender, ownerOf) {
  const events = [];
  const fs = (i) => hasKw(i, 'first strike') || hasKw(i, 'double strike');
  const ds = (i) => hasKw(i, 'double strike');
  const alive = (iid) => cards[iid] && cards[iid].zone === 'battlefield' && !isDead(cards[iid]);
  const anyFirst = attackers.some((a) => fs(cards[a])) ||
    Object.values(blocks).flat().some((b) => cards[b] && fs(cards[b]));

  const steps = anyFirst ? ['first', 'regular'] : ['regular'];
  for (const step of steps) {
    const deals = (i) => (step === 'first' ? fs(i) : !fs(i) || ds(i));
    const pending = [];
    for (const aid of attackers) {
      const a = cards[aid];
      if (!alive(aid)) continue;
      const bl = (blocks[aid] || []).filter(alive);
      const wasBlocked = (blocks[aid] || []).length > 0;
      // attacker deals damage
      if (deals(a)) {
        let dmg = Math.max(0, power(a));
        if (!wasBlocked) {
          if (dmg > 0) pending.push({ type: 'player', from: aid, to: defender, amount: dmg });
        } else {
          for (const bid of bl) {
            if (dmg <= 0) break;
            const b = cards[bid];
            const lethal = hasKw(a, 'deathtouch') ? 1 : Math.max(0, toughness(b) - b.damage);
            const give = bl.length === 1 && !hasKw(a, 'trample') ? dmg : Math.min(dmg, lethal);
            pending.push({ type: 'creature', from: aid, to: bid, amount: give });
            dmg -= give;
          }
          if (dmg > 0 && bl.length && hasKw(a, 'trample')) pending.push({ type: 'player', from: aid, to: defender, amount: dmg });
          else if (dmg > 0 && bl.length) {
            // dump leftover on the first blocker
            pending.push({ type: 'creature', from: aid, to: bl[0], amount: dmg });
          } else if (dmg > 0 && !bl.length && hasKw(a, 'trample')) {
            pending.push({ type: 'player', from: aid, to: defender, amount: dmg });
          }
        }
      }
      // blockers deal damage to the attacker
      for (const bid of bl) {
        const b = cards[bid];
        if (deals(b) && power(b) > 0) pending.push({ type: 'creature', from: bid, to: aid, amount: power(b) });
      }
    }
    for (const ev of pending) {
      if (ev.amount <= 0) continue;
      const src = cards[ev.from];
      if (ev.type === 'creature') {
        const t = cards[ev.to];
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
