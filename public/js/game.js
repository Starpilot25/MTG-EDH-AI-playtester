// Turn structure, combat flow, and the AI turn driver.
// Handles the turn-based keywords too: phasing, day/night, echo, cumulative upkeep, vanishing,
// fading, suspend, rebound, impending, the monarch, extra turns and extra combats, and the
// "at the beginning of the next end step" clean-ups (dash, blitz, unearth, warp, mobilize…).
import { DB } from './data.js';
import {
  oracle, isCreature, hasKw, power, combatDamage, canBlock, isLand, isType, kwCost, canAttack, mustAttack, face, parseCost,
} from './rules.js';
import {
  G, card, cardsIn, allOnField, zoneOf, move, draw, log, nameTag, untapAll, cleanupDamage, stateBased, shuffle, opp, checkLoss,
  freshTurnStats, changeLife, setLife, sacrifice, addCounters, toBattlefield, cardName, queueEvent,
} from './state.js';
import { fire, settle, T } from './triggers.js';
import {
  aiMainPhase, aiChooseAttackers, aiChooseBlocks, aiCleanup, aiKeepHand, aiBottom, aiAttackTargets, aiPrepareCombat, aiPay, aiEnv,
  aiInstantWindow,
} from './ai.js';
import { emptyPools, castFree, applyPayment } from './cast.js';

// UI hooks, filled in by ui.js
export const hooks = {
  render: () => {},
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  respond: async () => 'resolve',
  askBlocks: async () => {},
  attackTargets: async (attackers) => Object.fromEntries(attackers.map((i) => [i, 'ai'])),
  turnStarted: () => {},
  envFor: null, // (pid) => cast.js env
};

export const run = { aiBusy: false };

const envFor = (pid) => (hooks.envFor ? hooks.envFor(pid) : aiEnv(hooks));
const who = (pid) => (pid === 'p' ? 'you' : 'the AI');

// ------------------------------------------------------------ mulligans
export function mulligan(pid) {
  const pl = G.s.players[pid];
  for (const iid of [...zoneOf(pid, 'hand')]) move(iid, 'library');
  shuffle(pid);
  draw(pid, 7, true);
  pl.mulligans++;
}

export function bottomCount(pid) {
  const m = G.s.players[pid].mulligans;
  return Math.max(0, m - (G.settings.freeMulligan ? 1 : 0));
}

export function aiMulligans() {
  while (!aiKeepHand() && G.s.players.ai.mulligans < 3) mulligan('ai');
  const b = bottomCount('ai');
  if (b) aiBottom(b);
  const m = G.s.players.ai.mulligans;
  log('ai', m ? `AI mulligans ${m === 1 ? 'once' : m + ' times'} and keeps ${7 - b}.` : 'AI keeps its opening seven.');
}

export async function startPlay() {
  G.s.phase = 'play';
  G.s.turn = 0;
  await beginTurn(G.s.first);
}

function setStep(step) {
  G.s.step = step;
  emptyPools();
}

// Pay a mana cost for an upkeep keyword. AI pays when it can; you get asked.
async function payOrNot(pid, cost, question) {
  if (pid === 'ai') {
    const p = await aiPay('ai', cost, question, {});
    if (!p) return false;
    applyPayment('ai', p);
    return true;
  }
  const yes = await T.confirm('Upkeep', question);
  if (!yes) return false;
  return T.payMana ? T.payMana(pid, cost, question) : true;
}

// ------------------------------------------------------------ turns
export async function beginTurn(pid) {
  const s = G.s;
  if (s.winner && !s.continueAfterWin) return hooks.render();
  const prevActive = s.active;
  const prevSpells = prevActive ? s.ts[prevActive].spells : -1;
  s.lastTurnSpells = { total: s.ts.p.spells + s.ts.ai.spells, max: Math.max(s.ts.p.spells, s.ts.ai.spells) };
  s.turn++;
  s.active = pid;
  s.landPlayed = false;
  s.landsPlayed = 0;
  s.extraLandThisTurn = 0;
  s.combat = null;
  s.ts = freshTurnStats();
  log('turn', `Turn ${s.turn} · ${pid === 'p' ? 'Your turn' : "AI's turn"}${s.extraTurnNow ? ' (extra turn)' : ''}`);
  s.extraTurnNow = false;
  setStep('untap');
  phasing(pid);
  // day / night
  dayNight(prevSpells);
  if (pid === 'ai' || G.settings.autoUntap) untapAll(pid);
  else for (const c of cardsIn(pid, 'battlefield')) c.sick = false;
  setStep('upkeep');
  hooks.render();
  fire({ type: 'upkeep', active: pid });
  await settle();
  if (G.s !== s) return;
  await upkeepKeywords(pid);
  if (G.s !== s) return;
  await settle();
  if (G.s !== s) return;
  setStep('draw');
  const skipDraw = s.turn === 1;
  if (!skipDraw && (pid === 'ai' || G.settings.autoDraw)) draw(pid, 1);
  fire({ type: 'drawStep', active: pid });
  await settle();
  if (G.s !== s) return;
  setStep('main1');
  hooks.render();
  hooks.turnStarted(pid);
  fire({ type: 'mainPhase', active: pid });
  await settle();
  if (G.s !== s) return;
  if (pid === 'ai') await runAiTurn();
}

// Phasing: permanents with phasing phase out; phased-out ones phase back in (with what's attached).
export function phasing(pid) {
  for (const c of allOnField(pid)) {
    if (c.phasedOut) {
      if (c.phasedWith || c.phasedUntil) continue;
      delete c.phasedOut;
      for (const a of [...allOnField('p'), ...allOnField('ai')]) if (a.phasedWith === c.iid) {
        delete a.phasedOut;
        delete a.phasedWith;
      }
      log(pid, `${nameTag(c)} phases in.`);
    } else if (hasKw(c, 'phasing')) {
      c.phasedOut = true;
      for (const a of [...allOnField('p'), ...allOnField('ai')]) if (a.attachedTo === c.iid) {
        a.phasedOut = true;
        a.phasedWith = c.iid;
      }
      log(pid, `${nameTag(c)} phases out.`);
    }
  }
}

function dayNight(prevSpells) {
  const s = G.s;
  const any = [...allOnField('p'), ...allOnField('ai')].some((c) => /\b(?:Daybound|Nightbound)\b/.test(DB[c.def].faces.map((f) => f.oracle).join('\n')));
  if (!s.dayNight && any) {
    s.dayNight = 'day';
    log('sys', 'It becomes day.');
  } else if (s.dayNight && prevSpells >= 0 && s.turn > 1) {
    if (s.dayNight === 'day' && prevSpells === 0) {
      s.dayNight = 'night';
      log('sys', 'No spells were cast last turn — it becomes night.');
    } else if (s.dayNight === 'night' && prevSpells >= 2) {
      s.dayNight = 'day';
      log('sys', 'Two or more spells were cast last turn — it becomes day.');
    }
  }
  if (!s.dayNight) return;
  for (const c of [...allOnField('p'), ...allOnField('ai')]) {
    const d = DB[c.def];
    if (d.faces.length < 2 || !/\bDaybound\b/.test(d.faces[0].oracle || '')) continue;
    const want = s.dayNight === 'night' ? 1 : 0;
    if ((c.face || 0) !== want) {
      c.face = want;
      queueEvent({ type: 'transformed', iid: c.iid, controller: c.controller });
    }
  }
}

async function upkeepKeywords(pid) {
  const s = G.s;
  for (const c of [...cardsIn(pid, 'battlefield')]) {
    if (!card(c.iid) || c.zone !== 'battlefield') continue;
    const o = oracle(c);
    // echo
    const echo = kwCost(c, 'Echo');
    if (echo && !c.echoPaid) {
      const cost = echo.mana || DB[c.def].manaCost;
      if (await payOrNot(pid, cost, `Pay echo ${cost} for ${cardName(c)}? (Otherwise sacrifice it.)`)) {
        c.echoPaid = true;
        log(pid, `${who(pid)} pay${pid === 'ai' ? 's' : ''} echo for ${nameTag(c)}.`);
      } else {
        log(pid, `${nameTag(c)} is sacrificed (echo not paid).`);
        sacrifice(c.iid);
        continue;
      }
    }
    // cumulative upkeep
    const cu = o.match(/(?:^|\n)Cumulative upkeep[—\s]+((?:\{[^}]+\})+|[^\n(]+)/i);
    if (cu) {
      addCounters(c, 'age', 1, { silent: true });
      const age = c.counters.age;
      const unit = cu[1].trim();
      let paid = false;
      if (/^\{/.test(unit)) {
        const total = unit.repeat(age);
        const tooMuch = pid === 'ai' && parseCost(total).generic + parseCost(total).pips.length > 4;
        paid = !tooMuch && (await payOrNot(pid, total, `Cumulative upkeep: pay ${total} for ${cardName(c)}? (Otherwise sacrifice it.)`));
      } else if (/pay (\d+) life/i.test(unit)) {
        const k = +unit.match(/pay (\d+) life/i)[1] * age;
        const yes = pid === 'ai' ? s.players.ai.life > k + 10 : await T.confirm('Cumulative upkeep', `Pay ${k} life for ${cardName(c)}? (Otherwise sacrifice it.)`);
        if (yes) {
          changeLife(pid, -k);
          paid = true;
        }
      } else {
        paid = pid === 'ai' ? false : await T.confirm('Cumulative upkeep', `${cardName(c)}: ${unit} × ${age}. Did you pay it? (No sacrifices it.)`);
      }
      if (!paid) {
        log(pid, `${nameTag(c)} is sacrificed (cumulative upkeep not paid).`);
        sacrifice(c.iid);
        continue;
      }
    }
    // vanishing
    if (/(?:^|\n)Vanishing\b/.test(o) && (c.counters.time || 0) > 0) {
      c.counters.time--;
      if (!c.counters.time) {
        log(pid, `${nameTag(c)} loses its last time counter and is sacrificed (vanishing).`);
        sacrifice(c.iid);
        continue;
      }
    }
    // fading
    if (/(?:^|\n)Fading\b/.test(o)) {
      if ((c.counters.fade || 0) > 0) c.counters.fade--;
      else {
        log(pid, `${nameTag(c)} is sacrificed (fading).`);
        sacrifice(c.iid);
        continue;
      }
    }
    // impending
    if (c.impending && (c.counters.time || 0) > 0) {
      c.counters.time--;
      if (!c.counters.time) {
        delete c.impending;
        log(pid, `${nameTag(c)} is no longer impending — it's a creature now.`);
      }
    }
  }
  // suspend: remove a time counter; cast it for free when the last is removed
  for (const c of [...cardsIn(pid, 'exile')]) {
    if (!c.suspended || !(c.counters.time > 0)) continue;
    c.counters.time--;
    if (c.counters.time) {
      log(pid, `${nameTag(c)}: ${c.counters.time} time counter${c.counters.time > 1 ? 's' : ''} left.`);
      continue;
    }
    log(pid, `The last time counter is removed from ${nameTag(c)} — cast it without paying its mana cost.`);
    const iid = c.iid;
    await castFree(pid, iid, envFor(pid), {});
    if (card(iid) && card(iid).zone === 'battlefield' && isCreature(card(iid))) card(iid).grants = [...(card(iid).grants || []), 'haste'];
    if (G.s !== s) return;
  }
  // delayed upkeep effects: rebound
  for (const d of s.delayed.filter((x) => x.at === 'upkeep' && x.turnOf === pid && x.after < s.turn)) {
    s.delayed.splice(s.delayed.indexOf(d), 1);
    const c = card(d.iid);
    if (!c || c.zone !== 'exile') continue;
    const yes = pid === 'ai' ? true : await T.confirm('Rebound', `Cast ${cardName(c)} from exile without paying its mana cost?`);
    if (yes) await castFree(pid, d.iid, envFor(pid), {});
    if (card(d.iid) && card(d.iid).zone === 'exile') move(d.iid, 'graveyard');
    if (G.s !== s) return;
  }
  stateBased();
  hooks.render();
}

// "At the beginning of the next end step" clean-ups, the monarch's draw, delayed returns.
async function endStepThings(pid) {
  const s = G.s;
  if (s.monarch === pid) {
    draw(pid, 1, true);
    log(pid, `The monarch (${who(pid)}) draws a card.`);
  }
  for (const c of [...allOnField('p'), ...allOnField('ai')]) {
    if (!c.endOfTurn || c.zone !== 'battlefield') continue;
    const what = c.endOfTurn;
    delete c.endOfTurn;
    if (what === 'hand') {
      log(c.controller, `${nameTag(c)} returns to its owner's hand (dash).`);
      move(c.iid, 'hand');
    } else if (what === 'sacrifice') {
      log(c.controller, `${nameTag(c)} is sacrificed at end of turn.`);
      sacrifice(c.iid); // blitz's "when it dies, draw a card" comes from the dies trigger
    } else if (what === 'exile') {
      log(c.controller, `${nameTag(c)} is exiled at end of turn.`);
      move(c.iid, 'exile');
    } else if (what === 'warp') {
      log(c.controller, `${nameTag(c)} is exiled (warp) — it can be cast from exile later.`);
      move(c.iid, 'exile');
      if (card(c.iid)) card(c.iid).warped = true;
    }
  }
  for (const d of s.delayed.filter((x) => x.at === 'endStep')) {
    s.delayed.splice(s.delayed.indexOf(d), 1);
    const c = card(d.iid);
    if (!c) continue;
    if (d.kind === 'returnFromExile' && c.zone === 'exile') {
      toBattlefield(d.iid, d.pid || c.owner);
      if (d.counter && card(d.iid)) {
        const r = card(d.iid);
        if (isType(r, 'Planeswalker') && !isCreature(r)) r.counters.loyalty = (r.counters.loyalty || 0) + 1;
        else r.counters[d.counter] = (r.counters[d.counter] || 0) + 1;
      }
      log(c.owner, `${nameTag(c)} returns to the battlefield.`);
    } else if (d.kind === 'sacrifice' && c.zone === 'battlefield') sacrifice(d.iid);
  }
  stateBased();
  await settle();
}

function cleanupStep() {
  const s = G.s;
  for (const d of s.delayed.filter((x) => x.at === 'cleanup')) {
    s.delayed.splice(s.delayed.indexOf(d), 1);
    const c = card(d.iid);
    if (c && c.zone === 'battlefield' && d.kind === 'returnControl' && c.controller !== d.pid) {
      move(d.iid, 'battlefield', { controller: d.pid, x: null, y: null });
      log(d.pid, `${nameTag(c)} returns to its controller.`);
    }
  }
  for (const c of Object.values(s.cards)) {
    if (c.goaded && c.goaded.until && c.goaded.until <= s.turn) delete c.goaded;
  }
  cleanupDamage();
  emptyPools();
}

// Who takes the next turn (extra turns first).
function nextTurnOf(pid) {
  const s = G.s;
  if (s.extraTurns[pid] > 0) {
    s.extraTurns[pid]--;
    s.extraTurnNow = true;
    return pid;
  }
  return opp(pid);
}

// Let the AI act at instant speed during your turn.
async function aiWindow(kind) {
  const was = run.aiBusy;
  run.aiBusy = true;
  hooks.render();
  try {
    await aiInstantWindow(hooks, kind);
  } finally {
    run.aiBusy = was;
    hooks.render();
  }
}

export async function playerNextStep() {
  const s = G.s;
  if (s.active !== 'p' || run.aiBusy) return;
  if (s.combat && (s.combat.stage === 'triggers' || s.combat.stage === 'busy')) return;
  if (s.step === 'main1') {
    setStep('combat');
    s.combat = { by: 'p', attackers: [], blocks: {}, targets: {}, stage: 'declare' };
    // goaded creatures and "attacks each combat if able" go in automatically
    for (const c of cardsIn('p', 'battlefield')) if (mustAttack(c) && canAttack(c)) s.combat.attackers.push(c.iid);
    fire({ type: 'beginCombat', active: 'p' });
    hooks.render();
    await settle();
  } else if (s.step === 'combat') {
    if (s.combat && s.combat.stage === 'declare' && s.combat.attackers.length) return confirmAttacks();
    if (s.combat && s.combat.stage === 'damage') return resolvePlayerCombat();
    await endCombat('p');
    if (G.s !== s) return;
    afterCombat();
  } else if (s.step === 'main2') {
    setStep('end');
    hooks.render();
    fire({ type: 'endStep', active: 'p' });
    await settle();
    if (G.s !== s) return;
    await endStepThings('p');
    if (G.s !== s) return;
    await aiWindow('endStep');
    if (G.s !== s) return;
  } else if (s.step === 'end') {
    return playerEndTurn();
  } else setStep('main1');
  hooks.render();
}

// After a combat: another combat if one was granted, otherwise the second main phase.
function afterCombat() {
  const s = G.s;
  s.combat = null;
  if (s.extraCombats > 0) {
    s.extraCombats--;
    log('sys', 'An additional combat phase begins.');
    setStep('main1');
    if (s.active === 'p') return playerNextStep();
    return;
  }
  setStep('main2');
  fire({ type: 'main2', active: s.active });
  settle();
}

export async function playerEndTurn() {
  const s = G.s;
  if (s.active !== 'p' || run.aiBusy) return;
  if (s.combat && s.combat.stage !== 'declare') return;
  s.combat = null;
  if (s.step !== 'end') {
    setStep('end');
    fire({ type: 'endStep', active: 'p' });
    await settle();
    if (G.s !== s) return;
    await endStepThings('p');
    if (G.s !== s) return;
    await aiWindow('endStep');
    if (G.s !== s) return;
  }
  const hand = zoneOf('p', 'hand').length;
  const noMax = /You have no maximum hand size/i.test(cardsIn('p', 'battlefield').map(oracle).join('\n'));
  if (hand > 7 && !noMax) log('p', `You have ${hand} cards in hand — discard down to 7 (drag extras to the graveyard).`);
  cleanupStep();
  hooks.render();
  await beginTurn(nextTurnOf('p'));
}

// ------------------------------------------------------------ player combat
export function toggleAttacker(iid) {
  const cb = G.s.combat;
  if (!cb || cb.by !== 'p' || cb.stage !== 'declare') return;
  const c = card(iid);
  if (!isCreature(c) || c.controller !== 'p') return;
  const k = cb.attackers.indexOf(iid);
  if (k >= 0) cb.attackers.splice(k, 1);
  else {
    if (!canAttack(c)) return;
    cb.attackers.push(iid);
  }
  hooks.render();
}

// Planeswalkers and battles the attacker could go after instead of the player.
export function attackOptions(attackerPid) {
  const def = opp(attackerPid);
  const out = [{ id: def, label: def === 'ai' ? 'The AI' : 'You' }];
  for (const c of cardsIn(def, 'battlefield')) if (isType(c, 'Planeswalker')) out.push({ id: c.iid, label: `${cardName(c)} (${c.counters.loyalty || 0} loyalty)` });
  // battles: attack the ones your opponent protects (in 1v1, battles you control are protected by the AI)
  for (const c of [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')])
    if (isType(c, 'Battle') && (c.protector || opp(c.controller)) === def) out.push({ id: c.iid, label: `${cardName(c)} (${c.counters.defense || 0} defense)` });
  return out;
}

function attackRestrictions(attackers) {
  for (const iid of attackers) {
    const c = card(iid);
    if (/can't attack alone/i.test(oracle(c)) && attackers.length < 2) return `${cardName(c)} can't attack alone.`;
  }
  return null;
}

export async function confirmAttacks() {
  const s = G.s;
  const cb = s.combat;
  if (!cb.attackers.length) {
    await endCombat('p');
    afterCombat();
    return hooks.render();
  }
  const bad = attackRestrictions(cb.attackers);
  if (bad) {
    log('p', bad);
    return hooks.render();
  }
  cb.stage = 'busy';
  if (attackOptions('p').length > 1) {
    cb.targets = await hooks.attackTargets(cb.attackers, attackOptions('p'));
    if (G.s !== s) return;
    if (!cb.targets) {
      cb.stage = 'declare';
      cb.targets = {};
      return hooks.render();
    }
  } else cb.targets = Object.fromEntries(cb.attackers.map((i) => [i, 'ai']));
  declareAttack(cb, 'p');
  cb.stage = 'triggers';
  hooks.render();
  fireAttacks(cb.attackers, 'p', 'ai');
  await settle();
  if (G.s !== s || !s.combat) return;
  cb.attackers = cb.attackers.filter((i) => card(i) && card(i).zone === 'battlefield');
  await aiWindow('attackers'); // removal on an attacker, a flash blocker, a fog
  if (G.s !== s || !s.combat) return;
  cb.attackers = cb.attackers.filter((i) => card(i) && card(i).zone === 'battlefield');
  cb.blocks = aiChooseBlocks(cb.attackers);
  const bl = Object.entries(cb.blocks);
  if (bl.length)
    log('ai', bl.map(([a, bs]) => `AI blocks ${nameTag(card(a))} with ${bs.map((b) => nameTag(card(b))).join(' + ')}`).join('. ') + '.');
  else log('ai', 'AI does not block.');
  fireBlocks(cb, 'ai');
  await settle();
  if (G.s !== s || !s.combat) return;
  await aiWindow('blocks'); // combat tricks on its blockers
  if (G.s !== s || !s.combat) return;
  cb.stage = 'damage';
  hooks.render();
}

function declareAttack(cb, pid) {
  const s = G.s;
  for (const iid of cb.attackers) {
    const c = card(iid);
    c.attacking = true;
    if (!hasKw(c, 'vigilance')) {
      c.tapped = true;
      queueEvent({ type: 'tapped', iid, controller: pid });
    }
  }
  s.ts[pid].attacked = true;
  const at = (i) => {
    const t = cb.targets[i];
    return t === 'p' || t === 'ai' ? '' : ` → ${nameTag(card(t))}`;
  };
  log(pid, `${pid === 'p' ? 'You attack' : 'AI attacks'} with ${cb.attackers.map((i) => nameTag(card(i)) + at(i)).join(', ')}.`);
}

export async function resolvePlayerCombat() {
  const s = G.s;
  const cb = s.combat;
  cb.stage = 'busy';
  applyCombat(cb.attackers, cb.blocks, 'ai', cb.targets);
  hooks.render();
  await settle();
  if (G.s !== s) return;
  await endCombat('p');
  if (G.s !== s) return;
  afterCombat();
  hooks.render();
}

async function endCombat(pid) {
  const s = G.s;
  fire({ type: 'endCombat', active: pid });
  for (const c of [...allOnField('p'), ...allOnField('ai')]) {
    if (c.endOfCombat === 'sacrifice' && c.zone === 'battlefield') {
      delete c.endOfCombat;
      log(c.controller, `${nameTag(c)} is sacrificed at end of combat.`);
      sacrifice(c.iid);
    }
    c.attacking = false;
    c.blocking = false;
    delete c.provokedBy;
  }
  stateBased();
  await settle();
  void s;
}

function fireAttacks(attackers, controller, defender) {
  const targets = (G.s.combat && G.s.combat.targets) || {};
  for (const iid of attackers) fire({ type: 'attacks', iid, controller, defender, target: targets[iid] || defender });
  if (attackers.length === 1) fire({ type: 'attacksAlone', iid: attackers[0], controller, defender });
  if (attackers.length) fire({ type: 'youAttack', controller, defender });
}

function fireBlocks(cb, defender) {
  for (const iid of cb.attackers) {
    const bl = (cb.blocks[iid] || []).filter((b) => card(b));
    if (bl.length) {
      fire({ type: 'blocked', iid, blockers: bl, defender });
      for (const b of bl) {
        card(b).blocking = true;
        fire({ type: 'blocks', iid: b, attacker: iid, defender: opp(defender) });
      }
    } else fire({ type: 'unblocked', iid, defender });
  }
}

function applyCombat(attackers, blocks, defender, targets = {}) {
  const s = G.s;
  const events = combatDamage(s.cards, attackers, blocks, defender, (iid) => card(iid).controller, targets);
  const lines = [];
  let toPlayer = 0;
  for (const ev of events) {
    const src = card(ev.from);
    if (!src) continue;
    if (ev.lifelink) changeLife(ev.controller, ev.amount, false);
    if (ev.amount > 0) {
      fire({ type: 'dealsDamage', iid: ev.from, amount: ev.amount, other: ev.type !== 'player' ? ev.to : null, player: ev.type === 'player' ? ev.to || defender : null });
      if (ev.type !== 'player') fire({ type: 'dealtDamage', iid: ev.to, amount: ev.amount, other: ev.from });
      if (ev.type === 'creature') fire({ type: 'combatDamageCreature', iid: ev.from, amount: ev.amount, other: ev.to });
      if (ev.type === 'player') fire({ type: 'dealsDamagePlayer', iid: ev.from, amount: ev.amount, player: ev.to || defender });
    }
    if (ev.type === 'permanent') {
      const t = card(ev.to);
      if (!t || t.zone !== 'battlefield') continue;
      if (isType(t, 'Planeswalker')) {
        t.counters.loyalty = Math.max(0, (t.counters.loyalty || 0) - ev.amount);
        lines.push(`${nameTag(src)} deals ${ev.amount} to ${nameTag(t)}`);
      } else if (isType(t, 'Battle')) {
        t.counters.defense = Math.max(0, (t.counters.defense || 0) - ev.amount);
        t.lastDamagedBy = ev.controller;
        lines.push(`${nameTag(src)} deals ${ev.amount} to ${nameTag(t)}`);
      } else if (isCreature(t)) t.damage += ev.amount;
      continue;
    }
    if (ev.type !== 'player') continue;
    const victim = ev.to || defender;
    const dpl = s.players[victim];
    if (ev.infect) {
      dpl.poison += ev.amount;
      lines.push(`${nameTag(src)} gives ${ev.amount} poison`);
    } else {
      setLife(victim, dpl.life - ev.amount, false);
      toPlayer += ev.amount;
      if (ev.commander) dpl.cmdDmg[ev.from] = (dpl.cmdDmg[ev.from] || 0) + ev.amount;
      lines.push(`${nameTag(src)} deals ${ev.amount}`);
    }
    s.ts[ev.controller].damagedOpp = true;
    if (ev.amount > 0) {
      fire({ type: 'combatDamagePlayer', iid: ev.from, controller: ev.controller, player: victim, amount: ev.amount });
      // toxic N / poisonous N: extra poison on top of the damage
      const o = oracle(src);
      const tox = o.match(/\bToxic (\d+)/i);
      const psn = o.match(/\bPoisonous (\d+)/i);
      const extra = (tox ? +tox[1] : 0) + (psn ? +psn[1] : 0);
      if (extra) {
        dpl.poison += extra;
        lines.push(`${nameTag(src)} adds ${extra} poison`);
      }
      // ingest: that player exiles the top card of their library
      if (hasKw(src, 'ingest')) {
        const lib = zoneOf(victim, 'library');
        if (lib.length) {
          const top = card(lib[lib.length - 1]);
          move(top.iid, 'exile');
          lines.push(`${nameTag(src)} ingests ${nameTag(top)}`);
        }
      }
    }
  }
  const hitters = [...new Set(events.filter((e) => e.type === 'player' && e.amount > 0).map((e) => e.controller))];
  hitters.forEach((controller) => {
    const sources = [];
    for (const e of events) if (e.type === 'player' && e.amount > 0 && e.controller === controller) {
      const x = sources.find((y) => y.iid === e.from);
      if (x) x.amount += e.amount;
      else sources.push({ iid: e.from, amount: e.amount });
    }
    fire({ type: 'combatDamageOnce', controller, player: defender, sources });
  });
  if (hitters.length && s.initiative === defender) fire({ type: 'takeInitiative', pid: hitters[0] });
  if (hitters.length && s.monarch === defender) {
    s.monarch = hitters[0];
    log(hitters[0], `${hitters[0] === 'p' ? 'You become' : 'The AI becomes'} the monarch.`);
  }
  const lifelinkTotal = events.filter((e) => e.lifelink).reduce((a, e) => a + e.amount, 0);
  if (lines.length) log(opp(defender), `Combat damage: ${lines.join(', ')}${toPlayer ? ` (${toPlayer} to ${defender === 'p' ? 'you' : 'the AI'})` : ''}.`);
  if (lifelinkTotal) log(opp(defender), `Lifelink: ${opp(defender) === 'p' ? 'you gain' : 'AI gains'} ${lifelinkTotal}.`);
  stateBased();
  checkLoss(defender);
}

// ------------------------------------------------------------ AI turn
async function aiCombat() {
  const s = G.s;
  const wait = (m = G.settings.aiSpeed) => hooks.wait(m);
  setStep('combat');
  fire({ type: 'beginCombat', active: 'ai' });
  await settle();
  if (G.s !== s || s.winner) return;
  await aiPrepareCombat(hooks);
  if (G.s !== s) return;
  let attackers = aiChooseAttackers();
  if (!attackers.length || attackRestrictions(attackers)) {
    await endCombat('ai');
    return;
  }
  s.combat = { by: 'ai', attackers, blocks: {}, targets: {}, stage: 'blocks', selected: null };
  s.combat.targets = aiAttackTargets(attackers);
  declareAttack(s.combat, 'ai');
  hooks.render();
  fireAttacks(attackers, 'ai', 'p');
  await settle();
  if (G.s !== s) return;
  attackers = attackers.filter((i) => card(i) && card(i).zone === 'battlefield');
  s.combat.attackers = attackers;
  const canAnyBlock = cardsIn('p', 'battlefield').some((b) => attackers.some((a) => canBlock(b, card(a))));
  if (canAnyBlock) await hooks.askBlocks();
  if (G.s !== s) return;
  const cb = s.combat;
  // provoked creatures that could have blocked their provoker must
  for (const b of cardsIn('p', 'battlefield')) {
    if (!b.provokedBy || !cb.attackers.includes(b.provokedBy) || b.tapped || !canBlock(b, card(b.provokedBy))) continue;
    if (Object.values(cb.blocks).some((v) => v.includes(b.iid))) continue;
    cb.blocks[b.provokedBy] = [...(cb.blocks[b.provokedBy] || []), b.iid];
    log('p', `${nameTag(b)} is provoked into blocking.`);
  }
  const bl = Object.entries(cb.blocks).filter(([, v]) => v.length);
  if (bl.length) log('p', bl.map(([a, bs]) => `You block ${nameTag(card(a))} with ${bs.map((b) => nameTag(card(b))).join(' + ')}`).join('. ') + '.');
  fireBlocks(cb, 'p');
  await settle();
  if (G.s !== s || !s.combat) return;
  await aiInstantWindow(hooks, 'ownBlocked'); // pump an attacker or remove a blocker
  if (G.s !== s || !s.combat) return;
  cb.attackers = cb.attackers.filter((i) => card(i) && card(i).zone === 'battlefield');
  applyCombat(cb.attackers, cb.blocks, 'p', cb.targets);
  hooks.render();
  await settle();
  if (G.s !== s) return;
  await endCombat('ai');
  s.combat = null;
  hooks.render();
  await wait();
}

export async function runAiTurn() {
  const s = G.s;
  run.aiBusy = true;
  hooks.render();
  const wait = (m = G.settings.aiSpeed) => hooks.wait(m);
  try {
    await wait();
    if (G.s !== s) return;
    await aiMainPhase(hooks);
    if (G.s !== s || s.winner) return;
    await aiCombat();
    while (G.s === s && !s.winner && s.extraCombats > 0) {
      s.extraCombats--;
      log('sys', 'An additional combat phase begins.');
      await aiCombat();
    }
    if (G.s !== s || s.winner) return;
    setStep('main2');
    hooks.render();
    fire({ type: 'main2', active: 'ai' });
    await settle();
    if (G.s !== s) return;
    await aiMainPhase(hooks, true);
    if (G.s !== s) return;
    setStep('end');
    hooks.render();
    fire({ type: 'endStep', active: 'ai' });
    await settle();
    if (G.s !== s) return;
    await endStepThings('ai');
    if (G.s !== s) return;
    aiCleanup();
    cleanupStep();
    hooks.render();
    await wait(Math.min(400, G.settings.aiSpeed));
  } finally {
    if (G.s === s) run.aiBusy = false;
  }
  if (G.s !== s) return;
  if (!s.winner || s.continueAfterWin) await beginTurn(nextTurnOf('ai'));
  else hooks.render();
}

export { isLand, DB, face, toBattlefield, dayNight, upkeepKeywords, endStepThings, cleanupStep, applyCombat };
