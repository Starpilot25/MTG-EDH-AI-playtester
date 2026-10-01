// Turn structure, combat flow, and the AI turn driver.
import { DB } from './data.js';
import { isCreature, hasKw, power, combatDamage, canBlock, isLand } from './rules.js';
import {
  G, card, cardsIn, zoneOf, move, draw, log, nameTag, untapAll, cleanupDamage, stateBased, shuffle, opp, checkLoss,
} from './state.js';
import { fire, settle } from './triggers.js';
import { aiMainPhase, aiChooseAttackers, aiChooseBlocks, aiCleanup, aiKeepHand, aiBottom } from './ai.js';

// UI hooks, filled in by ui.js
export const hooks = {
  render: () => {},
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  respond: async () => 'resolve',
  askBlocks: async () => {},
  turnStarted: () => {},
};

export const run = { aiBusy: false };

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

// ------------------------------------------------------------ turns
export async function beginTurn(pid) {
  const s = G.s;
  if (s.winner && !s.continueAfterWin) return hooks.render();
  s.turn++;
  s.active = pid;
  s.landPlayed = false;
  s.combat = null;
  log('turn', `Turn ${s.turn} · ${pid === 'p' ? 'Your turn' : "AI's turn"}`);
  s.step = 'untap';
  if (pid === 'ai' || G.settings.autoUntap) untapAll(pid);
  else for (const c of cardsIn(pid, 'battlefield')) c.sick = false;
  s.step = 'upkeep';
  hooks.render();
  fire({ type: 'upkeep', active: pid });
  await settle();
  if (G.s !== s) return;
  s.step = 'draw';
  const skipDraw = s.turn === 1;
  if (!skipDraw && (pid === 'ai' || G.settings.autoDraw)) draw(pid, 1);
  s.step = 'main1';
  hooks.render();
  hooks.turnStarted(pid);
  fire({ type: 'mainPhase', active: pid });
  await settle();
  if (G.s !== s) return;
  if (pid === 'ai') await runAiTurn();
}

export function playerNextStep() {
  const s = G.s;
  if (s.active !== 'p' || run.aiBusy) return;
  if (s.combat && s.combat.stage === 'triggers') return;
  if (s.step === 'main1') {
    s.step = 'combat';
    s.combat = { by: 'p', attackers: [], blocks: {}, stage: 'declare' };
    fire({ type: 'beginCombat', active: 'p' });
    settle();
  } else if (s.step === 'combat') {
    if (s.combat && s.combat.stage === 'declare' && s.combat.attackers.length) return confirmAttacks();
    if (s.combat && s.combat.stage === 'damage') return resolvePlayerCombat();
    s.combat = null;
    s.step = 'main2';
  } else if (s.step === 'main2') {
    s.step = 'end';
    fire({ type: 'endStep', active: 'p' });
    settle();
  } else if (s.step === 'end') {
    return playerEndTurn();
  } else s.step = 'main1';
  hooks.render();
}

export async function playerEndTurn() {
  const s = G.s;
  if (s.active !== 'p' || run.aiBusy) return;
  s.combat = null;
  if (s.step !== 'end') {
    s.step = 'end';
    fire({ type: 'endStep', active: 'p' });
    await settle();
    if (G.s !== s) return;
  }
  const hand = zoneOf('p', 'hand').length;
  if (hand > 7) log('p', `You have ${hand} cards in hand — discard down to 7 (drag extras to the graveyard).`);
  cleanupDamage();
  hooks.render();
  await beginTurn('ai');
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
    if (c.tapped) return;
    cb.attackers.push(iid);
  }
  hooks.render();
}

export async function confirmAttacks() {
  const s = G.s;
  const cb = s.combat;
  if (!cb.attackers.length) {
    s.combat = null;
    s.step = 'main2';
    return hooks.render();
  }
  for (const iid of cb.attackers) {
    const c = card(iid);
    c.attacking = true;
    if (!hasKw(c, 'vigilance')) c.tapped = true;
  }
  log('p', `You attack with ${cb.attackers.map((i) => nameTag(card(i))).join(', ')}.`);
  cb.stage = 'triggers';
  hooks.render();
  fireAttacks(cb.attackers, 'p', 'ai');
  await settle();
  if (G.s !== s || !s.combat) return;
  cb.attackers = cb.attackers.filter((i) => card(i) && card(i).zone === 'battlefield');
  cb.blocks = aiChooseBlocks(cb.attackers);
  const bl = Object.entries(cb.blocks);
  if (bl.length)
    log('ai', bl.map(([a, bs]) => `AI blocks ${nameTag(card(a))} with ${bs.map((b) => nameTag(card(b))).join(' + ')}`).join('. ') + '.');
  else log('ai', 'AI does not block.');
  cb.stage = 'damage';
  hooks.render();
}

export async function resolvePlayerCombat() {
  const cb = G.s.combat;
  applyCombat(cb.attackers, cb.blocks, 'ai');
  G.s.combat = null;
  G.s.step = 'main2';
  hooks.render();
  await settle();
}

function fireAttacks(attackers, controller, defender) {
  for (const iid of attackers) fire({ type: 'attacks', iid, controller, defender });
  if (attackers.length) fire({ type: 'youAttack', controller, defender });
}

function applyCombat(attackers, blocks, defender) {
  const s = G.s;
  const events = combatDamage(s.cards, attackers, blocks, defender, (iid) => card(iid).controller);
  const dpl = s.players[defender];
  let toPlayer = 0;
  const lines = [];
  for (const ev of events) {
    const src = card(ev.from);
    if (ev.lifelink) s.players[ev.controller].life += ev.amount;
    if (ev.type === 'player') {
      if (ev.infect) {
        dpl.poison += ev.amount;
        lines.push(`${nameTag(src)} gives ${ev.amount} poison`);
      } else {
        dpl.life -= ev.amount;
        toPlayer += ev.amount;
        if (ev.commander) dpl.cmdDmg[ev.from] = (dpl.cmdDmg[ev.from] || 0) + ev.amount;
        lines.push(`${nameTag(src)} deals ${ev.amount}`);
      }
      if (ev.amount > 0) fire({ type: 'combatDamagePlayer', iid: ev.from, controller: ev.controller, player: defender });
    }
  }
  const hitters = [...new Set(events.filter((e) => e.type === 'player' && e.amount > 0).map((e) => e.controller))];
  hitters.forEach((controller) => fire({ type: 'combatDamageOnce', controller, player: defender }));
  const lifelinkTotal = events.filter((e) => e.lifelink).reduce((a, e) => a + e.amount, 0);
  if (lines.length) log(defender === 'p' ? 'ai' : 'p', `Combat damage to ${defender === 'p' ? 'you' : 'the AI'}: ${lines.join(', ')} (${toPlayer} total).`);
  if (lifelinkTotal) log(opp(defender), `Lifelink: ${opp(defender) === 'p' ? 'you gain' : 'AI gains'} ${lifelinkTotal}.`);
  for (const iid of attackers) if (card(iid)) card(iid).attacking = false;
  stateBased();
  checkLoss(defender);
}

// ------------------------------------------------------------ AI turn
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
    // combat
    fire({ type: 'beginCombat', active: 'ai' });
    await settle();
    if (G.s !== s || s.winner) return;
    let attackers = aiChooseAttackers();
    if (attackers.length) {
      s.step = 'combat';
      s.combat = { by: 'ai', attackers, blocks: {}, stage: 'blocks', selected: null };
      for (const iid of attackers) {
        const c = card(iid);
        c.attacking = true;
        if (!hasKw(c, 'vigilance')) c.tapped = true;
      }
      const dmg = attackers.reduce((a, i) => a + Math.max(0, power(card(i))), 0);
      log('ai', `AI attacks with ${attackers.map((i) => nameTag(card(i))).join(', ')} (${dmg} power).`);
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
      const bl = Object.entries(cb.blocks).filter(([, v]) => v.length);
      if (bl.length) log('p', bl.map(([a, bs]) => `You block ${nameTag(card(a))} with ${bs.map((b) => nameTag(card(b))).join(' + ')}`).join('. ') + '.');
      applyCombat(cb.attackers, cb.blocks, 'p');
      s.combat = null;
      hooks.render();
      await settle();
      if (G.s !== s) return;
      await wait();
      if (G.s !== s || s.winner) return;
    }
    s.step = 'main2';
    hooks.render();
    await aiMainPhase(hooks, true);
    if (G.s !== s) return;
    s.step = 'end';
    hooks.render();
    fire({ type: 'endStep', active: 'ai' });
    await settle();
    if (G.s !== s) return;
    aiCleanup();
    cleanupDamage();
    hooks.render();
    await wait(Math.min(400, G.settings.aiSpeed));
  } finally {
    if (G.s === s) run.aiBusy = false;
  }
  if (G.s !== s) return;
  if (!s.winner || s.continueAfterWin) await beginTurn('p');
  else hooks.render();
}

export { isLand, DB };
