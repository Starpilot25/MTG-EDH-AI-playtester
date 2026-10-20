// Turn structure, combat flow, and the AI turn driver.
// Handles the turn-based keywords too: phasing, day/night, echo, cumulative upkeep, vanishing,
// fading, suspend, rebound, impending, the monarch, extra turns and extra combats, and the
// "at the beginning of the next end step" clean-ups (dash, blitz, unearth, warp, mobilize…).
import { DB } from './data.js';
import {
  oracle, hasSubtype, isCreature, hasKw, power, toughness, combatDamage, canBlock, isLand, isType, kwCost, canAttack, mustAttack, face, parseCost, typeLine,
} from './rules.js';
import {
  G, card, cardsIn, allOnField, zoneOf, move, draw, log, nameTag, aiSlaved, untapAll, cleanupDamage, stateBased, shuffle, opp, checkLoss,
  freshTurnStats, changeLife, setLife, sacrifice, addCounters, toBattlefield, cardName, queueEvent, discard as discardCard,
  tappedHook,
} from './state.js';
import { maxHandSize } from './statics.js';
import { fire, settle, T } from './triggers.js';
import {
  aiMainPhase, aiChooseAttackers, aiChooseBlocks, aiCleanup, aiKeepHand, aiBottom, aiAttackTargets, aiPrepareCombat, aiPay, aiEnv,
  aiInstantWindow, asSeat,
} from './ai.js';
import { emptyPools, castFree, applyPayment } from './cast.js';
import { seats, opponents, isAI, isPlayer, multiplayer, nextSeat, inGame, seatName } from './state.js';

// UI hooks, filled in by ui.js
export const hooks = {
  render: () => {},
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  respond: async () => 'resolve',
  askBlocks: async () => {},
  attackTargets: async (attackers) => Object.fromEntries(attackers.map((i) => [i, opp('p')])),
  turnStarted: () => {},
  envFor: null, // (pid) => cast.js env
};

export const run = { aiBusy: false };

const envFor = (pid) => (hooks.envFor ? hooks.envFor(pid) : aiEnv(hooks));
const who = (pid) => seatName(pid);
const aiName = (pid) => (multiplayer() ? seatName(pid) : 'AI');

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
  if (pid === 'p' && G.settings.unlimitedMulligans) return 0;
  return Math.max(0, m - (G.settings.freeMulligan ? 1 : 0));
}

export function aiMulligans() {
  for (const k of seats().filter(isAI)) asSeat(k, () => {
    while (!aiKeepHand() && G.s.players[k].mulligans < 3) mulligan(k);
    const b = bottomCount(k);
    if (b) aiBottom(b);
    const m = G.s.players[k].mulligans;
    log(k, m ? `${aiName(k)} mulligans ${m === 1 ? 'once' : m + ' times'} and keeps ${7 - b}.` : `${aiName(k)} keeps its opening seven.`);
  });
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
  if (isAI(pid)) {
    const p = await aiPay(pid, cost, question, {});
    if (!p) return false;
    applyPayment(pid, p);
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
  s.lastTurnSpells = { total: seats().reduce((a, k) => a + ((s.ts[k] || {}).spells || 0), 0), max: Math.max(...seats().map((k) => (s.ts[k] || {}).spells || 0)) };
  s.turn++;
  s.turns = s.turns || Object.fromEntries(seats().map((k) => [k, 0]));
  s.turns[pid] = (s.turns[pid] || 0) + 1;
  s.active = pid;
  s.landPlayed = false;
  s.landsPlayed = 0;
  s.extraLandThisTurn = 0;
  s.combat = null;
  s.lastTs = s.ts; // "if you lost life last turn"
  s.ts = freshTurnStats();
  log('turn', `${pid === 'p' ? 'Your turn' : `${aiName(pid)}'s turn`} ${s.turns[pid]} (round ${Math.ceil(s.turn / (multiplayer() ? seats().length : 2))})${s.extraTurnNow ? ' (extra turn)' : ''}`);
  // grudges fade: what an opponent did to this player a round ago matters less now
  if (s.grudge && s.grudge[pid]) for (const k of Object.keys(s.grudge[pid])) s.grudge[pid][k] *= 0.6;
  s.inExtraTurn = !!s.extraTurnNow;
  // Mindslaver / Emrakul: the controller of this turn
  s.slaved = null;
  if (s.slaveNext && s.slaveNext.of === pid) {
    const sl = s.slaveNext;
    s.slaveNext = null;
    if (isAI(sl.of) && sl.by === 'p') {
      s.slaved = { by: 'p', of: sl.of, turn: s.turn };
      log('sys', 'You control the AI during this turn: you make all of its choices and see its hand.');
    } else log('sys', "The AI would control your turn — this playtester doesn't support that, so play your turn as the AI would.");
    if (sl.extraAfter) s.extraTurns[pid] = (s.extraTurns[pid] || 0) + 1;
  }
  s.extraTurnNow = false;
  setStep('untap');
  phasing(pid);
  // day / night
  dayNight(prevSpells);
  if (isAI(pid) || G.settings.autoUntap) untapAll(pid);
  else for (const c of cardsIn(pid, 'battlefield')) c.sick = false;
  // the "Your turn" banner as the turn begins (not only once you reach the main phase)
  hooks.render();
  hooks.turnStarted(pid);
  // "Stop at every step": your turn waits in the untap step until you press Next step
  if (pid === 'p' && G.settings.everyStep) return hooks.render();
  await beginUpkeep(pid);
}
// the rest of the beginning phase, one step at a time (the player's Next step button walks through these)
async function beginUpkeep(pid) {
  const s = G.s;
  setStep('upkeep');
  hooks.render();
  fire({ type: 'upkeep', active: pid });
  await settle();
  if (G.s !== s) return;
  await upkeepKeywords(pid);
  if (G.s !== s) return;
  await settle();
  if (G.s !== s) return;
  if (pid === 'p' && G.settings.everyStep) return hooks.render();
  await beginDraw(pid);
}
async function beginDraw(pid) {
  const s = G.s;
  setStep('draw');
  const skipDraw = s.turn === 1;
  if (!skipDraw && (isAI(pid) || G.settings.autoDraw)) draw(pid, 1);
  fire({ type: 'drawStep', active: pid });
  await settle();
  if (G.s !== s) return;
  if (pid === 'p' && G.settings.everyStep) return hooks.render();
  await beginMain1(pid);
}
async function beginMain1(pid) {
  const s = G.s;
  setStep('main1');
  hooks.render();
  fire({ type: 'mainPhase', active: pid });
  await settle();
  if (G.s !== s) return;
  if (isAI(pid)) await runAiTurn(pid);
}

// Phasing: permanents with phasing phase out; phased-out ones phase back in (with what's attached).
export function phasing(pid) {
  for (const c of allOnField(pid)) {
    if (c.phasedOut) {
      if (c.phasedWith || c.phasedUntil) continue;
      delete c.phasedOut;
      for (const a of seats().flatMap(allOnField)) if (a.phasedWith === c.iid) {
        delete a.phasedOut;
        delete a.phasedWith;
      }
      log(pid, `${nameTag(c)} phases in.`);
    } else if (hasKw(c, 'phasing')) {
      c.phasedOut = true;
      for (const a of seats().flatMap(allOnField)) if (a.attachedTo === c.iid) {
        a.phasedOut = true;
        a.phasedWith = c.iid;
      }
      log(pid, `${nameTag(c)} phases out.`);
    }
  }
}

function dayNight(prevSpells) {
  const s = G.s;
  const any = seats().flatMap(allOnField).some((c) => /\b(?:Daybound|Nightbound)\b/.test(DB[c.def].faces.map((f) => f.oracle).join('\n')));
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
  for (const c of seats().flatMap(allOnField)) {
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
        log(pid, `${who(pid)} pay${isAI(pid) ? 's' : ''} echo for ${nameTag(c)}.`);
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
        const tooMuch = isAI(pid) && parseCost(total).generic + parseCost(total).pips.length > 4;
        paid = !tooMuch && (await payOrNot(pid, total, `Cumulative upkeep: pay ${total} for ${cardName(c)}? (Otherwise sacrifice it.)`));
      } else if (/pay (\d+) life/i.test(unit)) {
        const k = +unit.match(/pay (\d+) life/i)[1] * age;
        const yes = isAI(pid) ? s.players[pid].life > k + 10 : await T.confirm('Cumulative upkeep', `Pay ${k} life for ${cardName(c)}? (Otherwise sacrifice it.)`);
        if (yes) {
          changeLife(pid, -k);
          paid = true;
        }
      } else {
        paid = isAI(pid) ? false : await T.confirm('Cumulative upkeep', `${cardName(c)}: ${unit} × ${age}. Did you pay it? (No sacrifices it.)`);
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
  // Arcane Denial & co.: draws at the beginning of the next turn's upkeep
  for (const d of s.delayed.filter((x) => x.at === 'nextUpkeep' && x.after < s.turn)) {
    s.delayed.splice(s.delayed.indexOf(d), 1);
    let k = d.n;
    if (d.upTo && d.pid === 'p') k = (await T.confirm('Draw', `Draw ${d.n} card${d.n === 1 ? '' : 's'} (${d.why})?`)) ? d.n : 0;
    if (k) {
      draw(d.pid, k);
      log(d.pid, `${d.pid === 'p' ? 'You draw' : 'The AI draws'} ${k} card${k === 1 ? '' : 's'} (${d.why}).`);
    }
  }
  // delayed upkeep effects: rebound
  for (const d of s.delayed.filter((x) => x.at === 'upkeep' && x.turnOf === pid && x.after < s.turn)) {
    s.delayed.splice(s.delayed.indexOf(d), 1);
    const c = card(d.iid);
    if (!c || c.zone !== 'exile') continue;
    const yes = isAI(pid) ? true : await T.confirm('Rebound', `Cast ${cardName(c)} from exile without paying its mana cost?`);
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
  for (const c of seats().flatMap(allOnField)) {
    if (!c.endOfTurn || c.zone !== 'battlefield') continue;
    const what = c.endOfTurn;
    delete c.endOfTurn;
    // Tilonalli's Summoner: "… unless you have the city's blessing"
    if (c.eotUnlessBlessing && s.players[c.controller] && s.players[c.controller].cityBlessing) continue;
    if (what === 'hand') {
      log(c.controller, `${nameTag(c)} returns to its owner's hand (dash).`);
      move(c.iid, 'hand');
    } else if (what === 'sacrifice') {
      // Zurgo, Thunder's Decree: "During your end step, Warrior tokens you control have 'This token can't be sacrificed.'"
      if (c.token && c.controller === s.active && hasSubtype(c, 'Warrior') && allOnField(c.controller).some((x) => /During your end step, Warrior tokens you control have "This token can't be sacrificed\."/i.test(oracle(x)))) {
        log(c.controller, `${nameTag(c)} can't be sacrificed (Zurgo) and stays.`);
        continue;
      }
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
  for (const d of s.delayed.filter((x) => x.at === 'endStep' && (!x.whoseEnd || x.whoseEnd === s.active))) {
    s.delayed.splice(s.delayed.indexOf(d), 1);
    // Synthetic Destiny: reveal until that many creature cards, put them onto the battlefield
    if (d.kind === 'revealCreatures') {
      const { revealCreaturesOnto } = await import('./effects.js');
      revealCreaturesOnto(d.pid, d.n);
      continue;
    }
    // Glimpse the Impossible: what's still exiled goes to the graveyard, and a token for each
    if (d.kind === 'leftoverExileToGy') {
      const left = (d.ids || []).filter((i) => card(i) && card(i).zone === 'exile');
      for (const i of left) move(i, 'graveyard');
      const src = card(d.src);
      if (left.length && src) {
        const { resolveEffects } = await import('./effects.js');
        const { T } = await import('./triggers.js');
        const did = await resolveEffects(`Create ${left.length} ${d.tokens.replace(/^(?:a|an|one) /, '').replace(/ token$/, ' tokens')}.`, src, { me: d.pid, choosers: T.choosers, forced: true });
        log(d.pid, `${nameTag(src)}: ${left.length} unplayed card${left.length === 1 ? '' : 's'} go${left.length === 1 ? 'es' : ''} to the graveyard; ${did.join('; ')}.`);
      }
      continue;
    }
    // Dragonhawk: "~ deals 2 damage to each opponent for each of those cards that are still exiled"
    if (d.kind === 'exiledDamage') {
      const k = (d.ids || []).filter((i) => card(i) && card(i).zone === 'exile').length;
      const src = card(d.src);
      if (k && src) {
        const { resolveEffects } = await import('./effects.js');
        const { T } = await import('./triggers.js');
        const did = await resolveEffects(`~ deals ${k * d.per} damage to each opponent.`, src, { me: d.pid, choosers: T.choosers, forced: true });
        log(d.pid, `${nameTag(src)}: ${did.join('; ') || `${k} card${k === 1 ? '' : 's'} still exiled`}.`);
      }
      continue;
    }
    const c = card(d.iid);
    if (!c) continue;
    // Gift of Immortality: return attached to the creature it enchanted
    if (d.kind === 'returnAttached' && c.zone === 'graveyard') {
      const host = d.host && card(d.host);
      if (!host || host.zone !== 'battlefield') continue;
      toBattlefield(d.iid, d.pid || c.owner);
      if (card(d.iid)) {
        const { attachTo } = await import('./effects.js');
        attachTo(card(d.iid), host);
      }
      log(c.owner, `${nameTag(c)} returns attached to ${nameTag(host)}.`);
      continue;
    }
    if (d.kind === 'returnFromExile' && (c.zone === 'exile' || c.zone === 'graveyard')) {
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
  emptyPools(true);
}

// Who takes the next turn (extra turns first).
function nextTurnOf(pid) {
  const s = G.s;
  if (s.extraTurns[pid] > 0) {
    s.extraTurns[pid]--;
    s.extraTurnNow = true;
    return pid;
  }
  return nextSeat(pid); // the player to the left (in 1v1, the opponent)
}

// Let the AI seats act at instant speed during someone else's turn, in turn order after the active player.
// `only` limits it to some seats (in combat: the defending players).
async function aiWindow(kind, only = null) {
  const s = G.s;
  const was = run.aiBusy;
  run.aiBusy = true;
  hooks.render();
  try {
    for (const k of aiSeatsAfter(s.active)) {
      if (G.s !== s || s.winner) break;
      if (only && !only.includes(k)) continue;
      await asSeat(k, () => aiInstantWindow(hooks, kind));
    }
  } finally {
    run.aiBusy = was;
    hooks.render();
  }
}
// the AI seats still in the game, in turn order starting after `pid` (not including pid)
function aiSeatsAfter(pid) {
  const order = seats();
  const n = order.length;
  const k = Math.max(0, order.indexOf(pid));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const x = order[(k + i) % n];
    if (x !== pid && isAI(x) && inGame(x)) out.push(x);
  }
  return out;
}
// The player an attack target belongs to: a player is itself; a planeswalker its controller; a battle its protector.
function playerOfTarget(t, attackerPid) {
  if (isPlayer(t)) return t;
  const c = t && card(t);
  if (!c) return opp(attackerPid);
  return isType(c, 'Battle') ? c.protector || opp(c.controller) : c.controller;
}
// which players are being attacked (by at least one creature), in turn order
function defendersOf(cb, attackerPid) {
  const set = new Set(cb.attackers.map((i) => playerOfTarget((cb.targets || {})[i] || opp(attackerPid), attackerPid)));
  return seats().filter((k) => set.has(k));
}

export async function playerNextStep() {
  const s = G.s;
  if (s.active !== 'p' || run.aiBusy) return;
  // a game saved or undone mid-way through beginning-of-combat triggers: go on to declaring attackers
  if (s.combat && s.combat.stage === 'begin' && !run.beginning) s.combat.stage = 'declare';
  if (s.combat && s.combat.stage === 'window' && !run.inWindow) s.combat.stage = 'damage'; // reloaded mid-window
  if (s.combat && (s.combat.stage === 'triggers' || s.combat.stage === 'busy' || s.combat.stage === 'begin' || s.combat.stage === 'window')) return;
  // the beginning phase, step by step ("Stop at every step")
  if (s.step === 'untap') return beginUpkeep('p');
  if (s.step === 'upkeep') return beginDraw('p');
  if (s.step === 'draw') return beginMain1('p');
  if (s.step === 'main1') {
    setStep('combat');
    // beginning of combat: its triggers resolve before attackers are declared
    s.combat = { by: 'p', attackers: [], blocks: {}, targets: {}, stage: 'begin' };
    fire({ type: 'beginCombat', active: 'p' });
    hooks.render();
    run.beginning = true;
    try {
      await settle();
    } finally {
      run.beginning = false;
    }
    if (G.s !== s || s.winner || !s.combat || s.combat.stage !== 'begin') return hooks.render();
    s.combat.stage = 'declare';
    // goaded creatures and "attacks each combat if able" go in automatically
    for (const c of cardsIn('p', 'battlefield')) if (mustAttack(c) && canAttack(c) && !s.combat.attackers.includes(c.iid)) s.combat.attackers.push(c.iid);
    hooks.render();
  } else if (s.step === 'combat') {
    if (s.combat && s.combat.stage === 'declare' && s.combat.attackers.length) return confirmAttacks();
    if (s.combat && s.combat.stage === 'damage') return resolvePlayerCombat();
    await endCombat('p');
    if (G.s !== s) return;
    afterCombat();
  } else if (s.step === 'main2') {
    await extraBeginningPhases('p');
    if (G.s !== s) return;
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

// Sphinx of the Second Sun: extra beginning phases after the second main phase — untap, upkeep, draw.
export async function extraBeginningPhases(pid) {
  const s = G.s;
  while (s.extraBeginning && s.extraBeginning.pid === pid && s.extraBeginning.turn === s.turn && s.extraBeginning.n > 0) {
    s.extraBeginning.n--;
    log('sys', 'An additional beginning phase begins: untap, upkeep, draw.');
    setStep('untap');
    untapAll(pid);
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
    draw(pid, 1);
    fire({ type: 'drawStep', active: pid });
    await settle();
    if (G.s !== s) return;
    hooks.render();
  }
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
  // passing from the beginning phase still goes through upkeep and the draw
  if (['untap', 'upkeep', 'draw'].includes(s.step)) {
    const every = G.settings.everyStep;
    G.settings.everyStep = false;
    try {
      if (s.step === 'untap') await beginUpkeep('p');
      else if (s.step === 'upkeep') await beginDraw('p');
      else await beginMain1('p');
    } finally {
      G.settings.everyStep = every;
    }
    if (G.s !== s || s.active !== 'p') return;
  }
  if (s.combat && s.combat.stage !== 'declare') return;
  s.combat = null;
  if (s.step !== 'end') {
    // passing the turn still goes through the second main phase ("at the beginning of your postcombat main phase")
    if (s.step !== 'main2') {
      setStep('main2');
      fire({ type: 'main2', active: 'p' });
      await settle();
      if (G.s !== s) return;
    }
    await extraBeginningPhases('p');
    if (G.s !== s) return;
    setStep('end');
    fire({ type: 'endStep', active: 'p' });
    await settle();
    if (G.s !== s) return;
    await endStepThings('p');
    if (G.s !== s) return;
    await aiWindow('endStep');
    if (G.s !== s) return;
  }
  // cleanup: discard down to your maximum hand size
  const max = maxHandSize('p');
  const hand = zoneOf('p', 'hand').slice();
  if (hand.length > max) {
    const k = hand.length - max;
    const picks = await hooks.playerChooser.pickCards({ forced: true, prompt: `Discard ${k} card${k === 1 ? '' : 's'} to your maximum hand size (${max})`, cards: hand, min: k, max: k, purpose: 'discard', aiScore: () => 0 });
    const chosen = (picks && picks.length === k ? picks : hand.slice(0, k)).filter((i) => card(i) && card(i).zone === 'hand');
    for (const i of chosen) discardCard(i);
    log('p', `You discard ${chosen.map((i) => nameTag(card(i))).join(', ')} to hand size.`);
    await settle();
    if (G.s !== s) return;
  }
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
  // goaded / "attacks each combat if able": it has to attack (unless attacking costs something — that's never required)
  if (k >= 0 && mustAttack(c) && !opponents('p').some((o) => cardsIn(o, 'battlefield').some(attackTaxOf))) {
    if (hooks.say) hooks.say(`${cardName(c)} ${c.goaded ? 'is goaded and' : ''} must attack this combat.`.replace('  ', ' '));
    return;
  }
  if (k >= 0) cb.attackers.splice(k, 1);
  else {
    if (!canAttack(c)) return;
    cb.attackers.push(iid);
  }
  hooks.render();
}

// Planeswalkers and battles the attacker could go after instead of the player.
// In a pod: every opponent, and each of their planeswalkers and battles.
export function attackOptions(attackerPid) {
  const out = [];
  for (const def of opponents(attackerPid)) {
    out.push({ id: def, label: def === 'p' ? 'You' : multiplayer() ? seatName(def) : 'The AI' });
    const jaceSafe = G.s.noAttackJace && G.s.noAttackJace.turn === G.s.turn && G.s.noAttackJace.owner === def;
    for (const c of cardsIn(def, 'battlefield')) if (isType(c, 'Planeswalker') && !(jaceSafe && hasSubtype(c, 'Jace'))) out.push({ id: c.iid, label: `${cardName(c)} (${c.counters.loyalty || 0} loyalty)${multiplayer() ? ` — ${seatName(def)}` : ''}` });
    // battles: attack the ones your opponent protects (in 1v1, battles you control are protected by the AI)
    for (const c of seats().flatMap((k) => cardsIn(k, 'battlefield')))
      if (isType(c, 'Battle') && (c.protector || opp(c.controller)) === def) out.push({ id: c.iid, label: `${cardName(c)} (${c.counters.defense || 0} defense)` });
  }
  return out;
}

// "No more than one creature can attack ~ each combat" (The Eternal Wanderer, Tomik's grant): extras go at the player instead.
function attackLimits(cb, attackerPid) {
  const seen = {};
  for (const a of cb.attackers) {
    const t = (cb.targets || {})[a];
    const tc = t && !isPlayer(t) ? card(t) : null;
    if (!tc || !/No more than one creature can attack (?:~|this planeswalker|[^.]+?) each combat/i.test(oracle(tc))) continue;
    if (seen[t]) {
      const back = multiplayer() ? tc.controller : opp(attackerPid);
      cb.targets[a] = back;
      log(attackerPid, `Only one creature can attack ${nameTag(tc)}; ${nameTag(card(a))} attacks ${seatName(back)} instead.`);
    } else seen[t] = true;
  }
}

// What one tax permanent charges per attacker: {per, andPws} or null
export function attackTaxOf(x) {
  const o = oracle(x);
  const m = o.match(/Creatures can't attack you(?: or planeswalkers you control)? unless their controller pays \{(\d+|X)\} for each (?:creature they control that's attacking you|of those creatures)/i);
  if (!m) return null;
  const enchantments = cardsIn(x.controller, 'battlefield').filter((c) => isType(c, 'Enchantment')).length;
  return { per: m[1] === 'X' ? (/number of enchantments you control/i.test(o) ? enchantments : 0) : +m[1], andPws: /or planeswalkers you control/i.test(o) };
}

// Propaganda, Ghostly Prison, Sphere of Safety: what attacking costs
export function attackTax(attackers, targets, attackerPid) {
  let total = 0;
  for (const def of opponents(attackerPid)) {
    for (const x of cardsIn(def, 'battlefield')) {
      const tx = attackTaxOf(x);
      if (!tx) continue;
      const per = tx.per;
      const andPws = tx.andPws;
      for (const a of attackers) {
        const t = (targets || {})[a] || opp(attackerPid);
        if (t === def || (andPws && card(t) && card(t).controller === def)) total += per;
      }
    }
  }
  return total;
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
  } else cb.targets = Object.fromEntries(cb.attackers.map((i) => [i, opp('p')]));
  attackLimits(cb, 'p');
  {
    const tax = attackTax(cb.attackers, cb.targets, 'p');
    if (tax > 0) {
      const ok = T.payMana ? await T.payMana('p', `{${tax}}`, `Attack tax ({${tax}})`) : true;
      if (G.s !== s) return;
      if (!ok) {
        log('p', `You can't pay the {${tax}} attack tax.`);
        cb.stage = 'declare';
        return hooks.render();
      }
      log('p', `You pay {${tax}} to attack.`);
    }
  }
  declareAttack(cb, 'p');
  cb.stage = 'triggers';
  hooks.render();
  fireAttacks(cb.attackers, 'p', opp('p'));
  await settle();
  if (G.s !== s || !s.combat) return;
  cb.attackers = cb.attackers.filter((i) => card(i) && card(i).zone === 'battlefield');
  await aiWindow('attackers', multiplayer() ? defendersOf(cb, 'p') : null); // removal on an attacker, a flash blocker, a fog
  if (G.s !== s || !s.combat) return;
  // your window after attack triggers, before blockers (pump an attacker, sacrifice something, flash in a creature…)
  if (hooks.combatWindow) {
    cb.stage = 'window';
    run.inWindow = true;
    try {
      await hooks.combatWindow('beforeBlocks');
    } finally {
      run.inWindow = false;
    }
    if (G.s !== s || !s.combat) return;
    cb.stage = 'triggers';
  }
  cb.attackers = cb.attackers.filter((i) => card(i) && card(i).zone === 'battlefield');
  // each defending AI blocks the creatures attacking it (and its planeswalkers and battles)
  cb.blocks = {};
  const defenders = multiplayer() ? defendersOf(cb, 'p') : ['ai'];
  for (const d of defenders) {
    const mine = multiplayer() ? cb.attackers.filter((i) => playerOfTarget(cb.targets[i], 'p') === d) : cb.attackers;
    const blocks = asSeat(d, () => aiChooseBlocks(mine));
    Object.assign(cb.blocks, blocks);
    const bl = Object.entries(blocks);
    if (bl.length)
      log(d, bl.map(([a, bs]) => `${aiName(d)} blocks ${nameTag(card(a))} with ${bs.map((b) => nameTag(card(b))).join(' + ')}`).join('. ') + '.');
    else log(d, `${aiName(d)} does not block.`);
  }
  fireBlocks(cb, 'p');
  await settle();
  if (G.s !== s || !s.combat) return;
  await aiWindow('blocks', multiplayer() ? defenders : null); // combat tricks on its blockers
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
      tappedHook(c);
    }
  }
  s.ts[pid].attacked = true;
  s.ts[pid].attackedWith = (s.ts[pid].attackedWith || 0) + cb.attackers.length; // Windbrisk Heights: "attacked with three or more creatures this turn"
  const at = (i) => {
    const t = cb.targets[i];
    if (isPlayer(t)) return multiplayer() ? ` → ${seatName(t)}` : '';
    return ` → ${nameTag(card(t))}`;
  };
  log(pid, `${pid === 'p' ? 'You attack' : `${aiName(pid)} attacks`} with ${cb.attackers.map((i) => nameTag(card(i)) + at(i)).join(', ')}.`);
}

export async function resolvePlayerCombat() {
  const s = G.s;
  const cb = s.combat;
  cb.stage = 'busy';
  // you divide each attacker's damage among its blockers (and the player, with trample)
  if (G.settings.arenaMode && hooks.assignDamage) {
    cb.assign = {};
    for (const aid of cb.attackers) {
      const a = card(aid);
      const bl = (cb.blocks[aid] || []).filter((b) => card(b) && card(b).zone === 'battlefield');
      if (!a || a.zone !== 'battlefield' || !bl.length) continue;
      const trample = hasKw(a, 'trample');
      if (bl.length < 2 && !trample) continue;
      const dmg = Math.max(0, /assigns combat damage equal to its toughness/i.test(oracle(a)) ? toughness(a) : power(a));
      if (dmg <= 0) continue;
      const plan = await hooks.assignDamage(a, bl.map(card), dmg, trample, hasKw(a, 'deathtouch'));
      if (G.s !== s) return;
      if (plan) cb.assign[aid] = plan;
    }
  }
  applyCombat(cb.attackers, cb.blocks, opp('p'), cb.targets);
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
  for (const c of seats().flatMap(allOnField)) {
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

// `defender` is the default (in 1v1 the only) defending player; in a pod each attacker's own target decides it.
function fireAttacks(attackers, controller, defender) {
  const targets = (G.s.combat && G.s.combat.targets) || {};
  const defOf = (iid) => (multiplayer() ? playerOfTarget(targets[iid] || defender, controller) : defender);
  for (const iid of attackers) {
    if (card(iid)) card(iid).attackedTurn = G.s.turn;
    fire({ type: 'attacks', iid, controller, defender: defOf(iid), target: targets[iid] || defender });
  }
  if (attackers.length === 1) fire({ type: 'attacksAlone', iid: attackers[0], controller, defender: defOf(attackers[0]) });
  if (attackers.length) fire({ type: 'youAttack', controller, defender: defOf(attackers[0]) });
  // grudges (pods): AI seats remember who attacked them
  if (multiplayer()) {
    const s = G.s;
    s.grudge = s.grudge || {};
    for (const iid of attackers) {
      const d = defOf(iid);
      if (!isAI(d)) continue;
      s.grudge[d] = s.grudge[d] || {};
      s.grudge[d][controller] = (s.grudge[d][controller] || 0) + 1 + Math.max(0, (card(iid) && power(card(iid))) || 0) * 0.25;
    }
  }
}

// attacker: the attacking player
function fireBlocks(cb, attacker) {
  const defOf = (iid) => (multiplayer() ? playerOfTarget((cb.targets || {})[iid] || opp(attacker), attacker) : opp(attacker));
  for (const iid of cb.attackers) {
    const bl = (cb.blocks[iid] || []).filter((b) => card(b));
    if (bl.length) {
      fire({ type: 'blocked', iid, blockers: bl, defender: defOf(iid) });
      for (const b of bl) if (card(b)) card(b).blockedTurn = G.s.turn;
      for (const b of bl) {
        card(b).blocking = true;
        fire({ type: 'blocks', iid: b, attacker: iid, defender: attacker });
      }
    } else fire({ type: 'unblocked', iid, defender: defOf(iid) });
  }
}

function applyCombat(attackers, blocks, defender, targets = {}) {
  const s = G.s;
  const events = combatDamage(s.cards, attackers, blocks, defender, (iid) => card(iid).controller, targets);
  const lines = [];
  let toPlayer = 0;
  const toEach = {}; // damage dealt to each player (pods: an attack can be split across opponents)
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
      G.s.damageNow = true;
      setLife(victim, dpl.life - ev.amount, false);
      G.s.damageNow = false;
      toPlayer += ev.amount;
      toEach[victim] = (toEach[victim] || 0) + ev.amount;
      if (ev.commander) dpl.cmdDmg[ev.from] = (dpl.cmdDmg[ev.from] || 0) + ev.amount;
      lines.push(`${nameTag(src)} deals ${ev.amount}`);
    }
    s.ts[ev.controller].damagedOpp = true;
    if (ev.amount > 0 && multiplayer() && isAI(victim)) {
      s.grudge = s.grudge || {};
      s.grudge[victim] = s.grudge[victim] || {};
      s.grudge[victim][ev.controller] = (s.grudge[victim][ev.controller] || 0) + ev.amount;
    }
    if (ev.amount > 0) {
      fire({ type: 'combatDamagePlayer', iid: ev.from, controller: ev.controller, player: victim, amount: ev.amount });
      if (G.s.ts[victim]) {
        G.s.ts[victim].dmgTaken = (G.s.ts[victim].dmgTaken || 0) + ev.amount;
        G.s.ts[victim].combatDmgTaken = true;
        if (card(ev.from)) (G.s.ts[victim].combatDmgFromTypes = G.s.ts[victim].combatDmgFromTypes || []).push(typeLine(card(ev.from)));
      }
      if (card(ev.from)) card(ev.from).dmgPlayerTurn = G.s.turn;
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
  // each player who was dealt combat damage (in 1v1: the defender)
  const victimOf = (e) => e.to || defender;
  const victims = multiplayer() ? seats().filter((k) => events.some((e) => e.type === 'player' && e.amount > 0 && victimOf(e) === k)) : [defender];
  for (const v of victims) {
    const hitters = [...new Set(events.filter((e) => e.type === 'player' && e.amount > 0 && (!multiplayer() || victimOf(e) === v)).map((e) => e.controller))];
    hitters.forEach((controller) => {
      const sources = [];
      for (const e of events) if (e.type === 'player' && e.amount > 0 && e.controller === controller && (!multiplayer() || victimOf(e) === v)) {
        const x = sources.find((y) => y.iid === e.from);
        if (x) x.amount += e.amount;
        else sources.push({ iid: e.from, amount: e.amount });
      }
      fire({ type: 'combatDamageOnce', controller, player: v, sources });
    });
    if (hitters.length && s.initiative === v) fire({ type: 'takeInitiative', pid: hitters[0] });
    if (hitters.length && s.monarch === v) {
      if (s.monarch !== hitters[0]) queueEvent({ type: 'becameMonarch', pid: hitters[0] });
      s.monarch = hitters[0];
      log(hitters[0], `${hitters[0] === 'p' ? 'You become' : multiplayer() ? `${seatName(hitters[0])} becomes` : 'The AI becomes'} the monarch.`);
    }
  }
  const lifelinkTotal = events.filter((e) => e.lifelink).reduce((a, e) => a + e.amount, 0);
  const atkr = multiplayer() ? (s.combat && s.combat.by) || s.active : opp(defender);
  const toText = multiplayer()
    ? Object.entries(toEach).map(([k, n]) => `${n} to ${seatName(k)}`).join(', ')
    : `${toPlayer} to ${defender === 'p' ? 'you' : 'the AI'}`;
  if (lines.length) log(atkr, `Combat damage: ${lines.join(', ')}${toPlayer ? ` (${toText})` : ''}.`);
  if (lifelinkTotal) log(atkr, `Lifelink: ${atkr === 'p' ? 'you gain' : `${aiName(atkr)} gains`} ${lifelinkTotal}.`);
  stateBased();
  if (multiplayer()) for (const k of seats()) checkLoss(k);
  else checkLoss(defender);
}

// ------------------------------------------------------------ AI turn
// An AI seat's combat (runs inside asSeat(pid)). In a pod its attackers can go at different players; each
// defending player blocks the creatures attacking them.
async function aiCombat(pid = 'ai') {
  const s = G.s;
  const wait = (m = G.settings.aiSpeed) => hooks.wait(m);
  setStep('combat');
  fire({ type: 'beginCombat', active: pid });
  await settle();
  if (G.s !== s || s.winner || !inGame(pid)) return;
  const slaved = aiSlaved() && hooks.slavedAttack;
  if (!slaved) await aiPrepareCombat(hooks);
  if (G.s !== s) return;
  let picked = null;
  if (slaved) picked = await hooks.slavedAttack();
  if (G.s !== s) return;
  let attackers = slaved ? (picked ? picked.attackers : []) : aiChooseAttackers();
  if (!attackers.length || attackRestrictions(attackers)) {
    await endCombat(pid);
    return;
  }
  s.combat = { by: pid, attackers, blocks: {}, targets: {}, stage: 'blocks', selected: null };
  s.combat.targets = slaved ? picked.targets : aiAttackTargets(attackers);
  attackLimits(s.combat, pid);
  {
    // the AI pays attack taxes, dropping its weakest attackers until it can afford them
    let tax = attackTax(attackers, s.combat.targets, pid);
    while (tax > 0) {
      const p = await envFor(pid).pay(pid, `{${tax}}`, 'Attack tax', {});
      if (p) {
        applyPayment(pid, p);
        log(pid, `${aiName(pid)} pays {${tax}} to attack.`);
        break;
      }
      attackers = attackers.slice().sort((x, y) => power(card(y)) - power(card(x))).slice(0, -1);
      s.combat.attackers = attackers;
      tax = attackTax(attackers, s.combat.targets, pid);
    }
    if (!attackers.length) {
      await endCombat(pid);
      return;
    }
  }
  declareAttack(s.combat, pid);
  hooks.render();
  fireAttacks(attackers, pid, opp(pid));
  await settle();
  if (G.s !== s) return;
  attackers = attackers.filter((i) => card(i) && card(i).zone === 'battlefield');
  s.combat.attackers = attackers;
  const pod = multiplayer();
  const defenders = pod ? defendersOf(s.combat, pid) : ['p'];
  const aimedAt = (d) => s.combat.attackers.filter((i) => playerOfTarget(s.combat.targets[i], pid) === d);
  // pods: the AIs being attacked get to respond first (removal on an attacker, a flash blocker, a fog)
  if (pod) await aiWindow('attackers', defenders.filter(isAI));
  if (G.s !== s || !s.combat) return;
  const cb = s.combat;
  const atMe = pod ? aimedAt('p') : cb.attackers;
  const canAnyBlock = atMe.length && cardsIn('p', 'battlefield').some((b) => atMe.some((a) => card(a) && canBlock(b, card(a))));
  if (canAnyBlock) await hooks.askBlocks(); // (you can also cast instants and activate abilities while choosing blocks)
  else if (hooks.combatWindow) await hooks.combatWindow('aiAttack');
  if (G.s !== s) return;
  // you can only block creatures attacking you (or your planeswalkers and battles)
  if (pod) for (const k of Object.keys(cb.blocks)) if (!atMe.includes(k)) delete cb.blocks[k];
  // provoked creatures that could have blocked their provoker must
  for (const b of cardsIn('p', 'battlefield')) {
    if (!b.provokedBy || !cb.attackers.includes(b.provokedBy) || b.tapped || !canBlock(b, card(b.provokedBy))) continue;
    if (pod && !atMe.includes(b.provokedBy)) continue;
    if (Object.values(cb.blocks).some((v) => v.includes(b.iid))) continue;
    cb.blocks[b.provokedBy] = [...(cb.blocks[b.provokedBy] || []), b.iid];
    log('p', `${nameTag(b)} is provoked into blocking.`);
  }
  const bl = Object.entries(cb.blocks).filter(([, v]) => v.length);
  if (bl.length) log('p', bl.map(([a, bs]) => `You block ${nameTag(card(a))} with ${bs.map((b) => nameTag(card(b))).join(' + ')}`).join('. ') + '.');
  // the other defending AIs block what's coming at them
  if (pod) for (const d of defenders.filter(isAI)) {
    const mine = aimedAt(d);
    if (!mine.length) continue;
    const blocks = asSeat(d, () => aiChooseBlocks(mine));
    Object.assign(cb.blocks, blocks);
    const ent = Object.entries(blocks);
    if (ent.length) log(d, ent.map(([a, bs]) => `${aiName(d)} blocks ${nameTag(card(a))} with ${bs.map((b) => nameTag(card(b))).join(' + ')}`).join('. ') + '.');
    else log(d, `${aiName(d)} does not block.`);
  }
  fireBlocks(cb, pid);
  await settle();
  if (G.s !== s || !s.combat) return;
  if (pod) await aiWindow('blocks', defenders.filter(isAI)); // combat tricks on their blockers
  if (G.s !== s || !s.combat) return;
  await aiInstantWindow(hooks, 'ownBlocked'); // pump an attacker or remove a blocker
  if (G.s !== s || !s.combat) return;
  // your window after blocks, before damage: sacrifice a blocker (the attacker stays blocked), cast a trick…
  if (hooks.combatWindow && bl.length) await hooks.combatWindow('afterBlocks');
  if (G.s !== s || !s.combat) return;
  cb.attackers = cb.attackers.filter((i) => card(i) && card(i).zone === 'battlefield');
  applyCombat(cb.attackers, cb.blocks, opp(pid), cb.targets);
  hooks.render();
  await settle();
  if (G.s !== s) return;
  await endCombat(pid);
  s.combat = null;
  hooks.render();
  await wait();
}

export async function runAiTurn(pid = 'ai') {
  const s = G.s;
  run.aiBusy = true;
  hooks.render();
  const wait = (m = G.settings.aiSpeed) => hooks.wait(m);
  // the turn stops early if this player leaves the game (pods) or the game ends
  const over = () => G.s !== s || s.winner || !inGame(pid);
  try {
    await asSeat(pid, async () => {
      await wait();
      if (G.s !== s) return;
      if (aiSlaved() && hooks.slavedMain) await hooks.slavedMain(false);
      else await aiMainPhase(hooks);
      if (over()) return;
      await aiCombat(pid);
      while (G.s === s && !s.winner && inGame(pid) && s.extraCombats > 0) {
        s.extraCombats--;
        log('sys', 'An additional combat phase begins.');
        await aiCombat(pid);
      }
      if (over()) return;
      setStep('main2');
      hooks.render();
      fire({ type: 'main2', active: pid });
      await settle();
      if (over()) return;
      if (aiSlaved() && hooks.slavedMain) await hooks.slavedMain(true);
      else await aiMainPhase(hooks, true);
      if (over()) return;
      await extraBeginningPhases(pid);
      if (over()) return;
      setStep('end');
      hooks.render();
      fire({ type: 'endStep', active: pid });
      await settle();
      if (over()) return;
      await endStepThings(pid);
      if (over()) return;
      // pods: the other AIs act at the end of this turn (flash creatures, instants, abilities)
      if (multiplayer()) await aiWindow('endStep');
      if (over()) return;
      aiCleanup();
      cleanupStep();
      hooks.render();
      await wait(Math.min(400, G.settings.aiSpeed));
    });
  } catch (e) {
    if (G.s === s) throw e; // the player quit to the deck menu mid-turn: the abandoned game just stops
    return;
  } finally {
    if (G.s === s) {
      run.aiBusy = false;
      hooks.render(); // the game may have ended mid-turn: show the game-over banner, not the "AI is thinking" spinner
    }
  }
  if (G.s !== s) return;
  if (!s.winner || s.continueAfterWin) {
    // a player who left mid-turn: clean up what's left of the turn and move on
    if (multiplayer() && !inGame(pid)) {
      s.combat = null;
      cleanupStep();
    }
    await beginTurn(nextTurnOf(pid));
  } else hooks.render();
}

export { isLand, DB, face, toBattlefield, dayNight, upkeepKeywords, endStepThings, cleanupStep, applyCombat };
