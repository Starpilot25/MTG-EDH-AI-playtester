// The tabletop: rendering, drag and drop, menus, dialogs and shortcuts.
import { DB, searchTokens } from './data.js';
import {
  hasSubtype, isLand, isCreature, isType, power, toughness, basePT, oracle, isPermanentCard, canBlock, canAttack, hasKw, face, payCostKeep,
} from './rules.js';
import {
  G, card, cardsIn, zoneOf, move, draw, log, nameTag, esc, snapshot, undo, redo, shuffle, mill, libTop,
  setLife, toBattlefield, createToken, stateBased, commanderTax, cardName, makeCard, CARD_W, CARD_H,
  STEPS, STEP_LABEL, checkLoss, untapAll, opp, freeSpot, genericTokenDef, onChange, eventQueue, isLegendary, restoreInPlace, sacrifice, changeLife, withReadCache, aiSlaved, handControl,
} from './state.js';
import {
  hooks, run, playerNextStep, playerEndTurn, toggleAttacker, confirmAttacks, resolvePlayerCombat, beginTurn, attackTax, attackTaxOf,
} from './game.js';
import { aiChooser, aiMaybeCounter, aiPay, aiEnv } from './ai.js';
import {
  manaSources, castOptions, castSpell, castFree, timingOk, effectiveCost, landOptions, playLand, landsAllowed, applyPayment,
  activateAbility, useZoneAbility, turnFaceUp, companionToHand, loyaltyUsesLeft, instantLoyalty,
} from './cast.js';
import { T, fire, settle } from './triggers.js';
import { DUNGEONS, venture, takeInitiative } from './dungeon.js';
import {
  Cancelled, activatedAbilities, zoneAbilities,
} from './effects.js';
import { payCost, totalMana, sculptors, SECTORS, SECTOR_SIGN, manaAbility } from './rules.js';

// Boards can be popped out into their own windows; lookups search those windows too.
const popouts = new Map(); // pid -> { win, doc }
const popDocs = () => [...popouts.values()].map((x) => x.doc).filter((d) => d && d.defaultView && !d.defaultView.closed);
const $ = (sel, root = document) => root.querySelector(sel) || (root === document ? popDocs().map((d) => d.querySelector(sel)).find(Boolean) || null : null);
const $$ = (sel, root = document) => (root === document ? [document, ...popDocs()].flatMap((d) => [...d.querySelectorAll(sel)]) : [...root.querySelectorAll(sel)]);
let menuDoc = document;

let hoverIid = null;
let pendingRespond = null;
let pendingBlocks = null;
let revealAiHand = false;
let logScrolledUp = false;

// ------------------------------------------------------------ helpers
function act(fn) {
  snapshot();
  fn();
  stateBased();
  render();
  refreshViewer();
  settle(); // dies / landfall triggers from what you just did
}

function isMine(c) {
  return c && ((c.zone === 'battlefield' ? c.controller : c.owner) === 'p');
}

function imgOf(c, large = false) {
  if (c.faceDown) return null;
  const f = DB[c.def].faces[c.face || 0];
  return large ? f.imgLarge || f.img : f.img;
}

function manaSymbols(cost) {
  return String(cost || '')
    .replace(/\{([^}]+)\}/g, (m, s) => `<span class="ms ms-${s.replace('/', '').toLowerCase()}">${s}</span>`);
}

// cards exiled face down by the AI (Expensive Taste, Gonti, Black Cat…) stay hidden from you
const hiddenFromMe = (c) => c && c.zone === 'exile' && c.hiddenExile && c.hiddenExile !== 'p';
function cardHTML(c, opts = {}) {
  if (hiddenFromMe(c)) c = { ...c, faceDown: true };
  const d = DB[c.def];
  const f = d.faces[c.face || 0];
  const src = imgOf(c);
  const cls = ['card'];
  if (c.tapped) cls.push('tapped');
  if (c.faceDown) cls.push('facedown');
  if (c.token) cls.push('token');
  if (opts.small) cls.push('small');
  if (opts.stacked) cls.push('stacked');
  const cb = G.s.combat;
  if (cb && cb.attackers.includes(c.iid)) cls.push('attacking');
  else if (cb && cb.by === 'p' && cb.stage === 'declare' && c.controller === 'p' && c.zone === 'battlefield' && canAttack(c)) cls.push('can-attack');
  if (cb && Object.values(cb.blocks).some((b) => b.includes(c.iid))) cls.push('blocking');
  if (cb && cb.selected === c.iid) cls.push('selected');
  if ((G.s.stack && G.s.stack.iid === c.iid) || (G.s.pstack && G.s.pstack.iid === c.iid)) cls.push('on-stack');
  if (respondable(c)) cls.push('playable');
  if (G.s && G.s.stack && (G.s.stack.targets || []).some((t) => t.iid === c.iid) && c.zone === 'battlefield') cls.push('stack-target');
  if (pendingTarget && pendingTarget.req.candidates.includes(c.iid)) cls.push('targetable');
  if (pendingTarget && pendingTarget.req.src && pendingTarget.req.src.iid === c.iid) cls.push('source');
  const style = opts.abs ? `style="left:${c.x}px;top:${c.y}px"` : '';
  let inner = src && !opts.textOnly
    ? `<img src="${src}" alt="${esc(f.name)}" draggable="false" loading="lazy" onerror="this.parentNode.classList.add('noimg');this.remove()">`
    : '';
  const typeShort = (f.typeLine || '').replace(/^Legendary /, '');
  inner += `<div class="ctext"><div class="ctop"><b>${esc(c.faceDown ? 'Face-down' : f.name)}</b><span>${c.faceDown ? '' : manaSymbols(f.manaCost)}</span></div><div class="ctype">${esc(c.faceDown ? '' : typeShort)}</div><div class="cora">${esc(c.faceDown ? '' : (f.oracle || '').slice(0, 160))}</div></div>`;
  if (!src || opts.textOnly) cls.push('noimg');
  // badges
  const badges = [];
  const counters = c.counters || {};
  for (const [k, v] of Object.entries(counters)) {
    if (!v) continue;
    if (k === '+1/+1') badges.push(`<span class="badge plus">+${v}/+${v}</span>`);
    else if (k === '-1/-1') badges.push(`<span class="badge minus">−${v}/−${v}</span>`);
    else if (k === 'loyalty') badges.push(`<span class="badge loyal">${v}</span>`);
    else badges.push(`<span class="badge misc" title="${esc(k)}">${esc(k.slice(0, 6))} ${v}</span>`);
  }
  if (c.zone === 'battlefield' && isCreature(c)) {
    const p = power(c);
    const t = toughness(c);
    const b = basePT(c);
    const mod = p !== b.p || t !== b.t || c.damage;
    badges.push(`<span class="pt ${mod ? 'mod' : ''} ${c.damage ? 'hurt' : ''}">${p}/${t - (c.damage || 0)}${c.damage ? '' : ''}</span>`);
  }
  if (c.zone === 'battlefield') {
    const tx = attackTaxOf(c);
    if (tx) badges.push(`<span class="badge tax" title="Attacking ${c.controller === 'p' ? 'you' : 'the AI'}${tx.andPws ? ' or ' + (c.controller === 'p' ? 'your' : 'its') + ' planeswalkers' : ''} costs {${tx.per}} per creature">⚔ {${tx.per}} each</span>`);
  }
  if (c.pacifiedBy) badges.push('<span class="badge lock" title="Can\'t attack or block">⛓</span>');
  if (c.zone === 'battlefield' && c.prepared && d.faces[1]) badges.push(`<span class="badge chosen" title="Prepared: right-click to cast a copy of ${esc(d.faces[1].name)} (${esc(d.faces[1].manaCost || '')})">✦ Prepared</span>`);
  // Rooms: which doors are unlocked
  if (c.zone === 'battlefield' && c.unlocked && d.faces.length === 2)
    d.faces.forEach((x, k) => badges.push(`<span class="badge door ${c.unlocked[k] ? 'open' : 'shut'}" title="${esc(x.name)}: ${c.unlocked[k] ? 'unlocked' : 'locked — unlock it for ' + esc(x.manaCost || '{0}') + ' as a sorcery (right-click)'}">${c.unlocked[k] ? '🔓' : '🔒'} ${esc(x.name.split(' ').slice(0, 2).join(' '))}</span>`));
  // choices made as it entered (Thriving lands' color, Cavern of Souls' creature type, Serra's Emissary's card type, Sieges' mode)
  if (c.zone === 'battlefield') {
    const COLN = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
    if (c.chosenColor) badges.push(`<span class="badge chosen" title="Chosen color: ${COLN[c.chosenColor] || c.chosenColor}"><i class="cdot c-${c.chosenColor}"></i>${COLN[c.chosenColor] || c.chosenColor}</span>`);
    for (const [v, what] of [[c.chosenType, 'creature type'], [c.chosenCardType, 'card type'], [c.chosenMode, 'mode']])
      if (v) badges.push(`<span class="badge chosen" title="Chosen ${what}: ${esc(v)}">${esc(v)}</span>`);
  }
  if (c.sector && c.zone === 'battlefield' && sculptors().length) badges.push(`<span class="badge sector" title="${c.sector} sector">${SECTOR_SIGN[c.sector]}</span>`);
  // planeswalkers: can this one still use a loyalty ability this turn?
  if (c.zone === 'battlefield' && isType(c, 'Planeswalker') && !isCreature(c) && (c.controller === G.s.active || instantLoyalty(c)) && G.s.phase === 'play') {
    const left = loyaltyUsesLeft(c);
    if (left > 0) {
      cls.push('pw-ready');
      badges.push(`<span class="badge pw-ready" title="Can use ${left > 1 ? left + ' more loyalty abilities' : 'a loyalty ability'} this turn">⚡${left > 1 ? '×' + left : ''}</span>`);
    } else badges.push('<span class="badge pw-used" title="Already used its loyalty ability this turn">✓ used</span>');
  }
  if (c.zone === 'battlefield' && c.sick && isCreature(c) && c.controller === G.s.active && !hasKw(c, 'haste') && G.s.phase === 'play')
    badges.push('<span class="badge sick" title="Summoning sick">zz</span>');
  if (cb) {
    const ai = cb.attackers.indexOf(c.iid);
    if (ai >= 0) {
      // who it's attacking: a player or a planeswalker/battle
      const tg = (cb.targets || {})[c.iid];
      const tc = tg && tg !== 'p' && tg !== 'ai' ? card(tg) : null;
      const defender = tc ? null : tg || opp(c.controller);
      const label = tc ? cardName(tc) : defender === 'p' ? 'You' : 'AI';
      badges.push(`<span class="tag atk ${tc ? 'atk-pw' : 'atk-player'}" title="Attacking ${esc(tc ? cardName(tc) : defender === 'p' ? 'you' : 'the AI')}">⚔ ${ai + 1} → ${esc(label.length > 12 ? label.split(/[ ,]/)[0] : label)}</span>`);
    }
    // a planeswalker or battle being attacked
    const hitBy = cb.attackers.map((a, k) => ((cb.targets || {})[a] === c.iid ? k + 1 : 0)).filter(Boolean);
    if (hitBy.length && c.zone === 'battlefield') {
      cls.push('under-attack');
      badges.push(`<span class="tag under" title="Being attacked">⚔ ${hitBy.join(', ')}</span>`);
    }
    for (const [a, bs] of Object.entries(cb.blocks)) {
      if (bs.includes(c.iid)) badges.push(`<span class="tag blk">⛨ ${cb.attackers.indexOf(a) + 1}</span>`);
    }
  }
  if (opts.count > 1) badges.push(`<span class="badge count">×${opts.count}</span>`);
  if (c.isCommander && c.zone === 'command') {
    const tax = commanderTax(c.owner, c.iid);
    if (tax) badges.push(`<span class="badge tax">Tax +${tax}</span>`);
  }
  return `<div class="${cls.join(' ')}" data-iid="${c.iid}" ${style}>${inner}<div class="badges">${badges.join('')}</div></div>`;
}

// ------------------------------------------------------------ render
export function render() {
  if (!G.s) return;
  withReadCache(renderAll);
  drawBlockLines();
  showStealNotes();
}

// Combat: a line from each blocker to the attacker it blocks (numbered like the attack tags)
function drawBlockLines() {
  let svg = document.getElementById('block-lines');
  const cb = G.s && G.s.combat;
  const pairs = [];
  if (cb && cb.blocks) {
    for (const [aid, bs] of Object.entries(cb.blocks)) for (const bid of bs || []) pairs.push([aid, bid, cb.attackers.indexOf(aid) + 1]);
  }
  if (!pairs.length) {
    if (svg) svg.innerHTML = '';
    return;
  }
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'block-lines';
    svg.setAttribute('aria-hidden', 'true');
    document.body.appendChild(svg);
  }
  const at = (iid) => {
    const el = document.querySelector(`.field .card[data-iid="${iid}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  let out = '';
  for (const [aid, bid, k] of pairs) {
    const a = at(aid);
    const b = at(bid);
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    out += `<line class="bl-line" x1="${b.x}" y1="${b.y}" x2="${a.x}" y2="${a.y}"/><circle class="bl-dot" cx="${b.x}" cy="${b.y}" r="5"/><circle class="bl-end" cx="${a.x}" cy="${a.y}" r="7"/>`;
    if (k > 0) out += `<g class="bl-num"><circle cx="${mx}" cy="${my}" r="11"/><text x="${mx}" y="${my + 4}" text-anchor="middle">${k}</text></g>`;
  }
  svg.innerHTML = out;
}
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => G.s && drawBlockLines());
  document.addEventListener('scroll', () => G.s && drawBlockLines(), true);
}

// "The AI gained control of your Sol Ring" — a popup whenever a card changes hands
function showStealNotes() {
  const s = G.s;
  if (!s.stealNotes || !s.stealNotes.length) return;
  const wrap = $('#dialog');
  if (!wrap || !wrap.hidden) return; // don't cover a choice the player is making; try again on the next render
  const notes = s.stealNotes.splice(0).filter((n) => card(n.iid) && card(n.iid).zone === 'battlefield');
  if (!notes.length) return;
  const where = (z) => (z === 'library' ? ' library' : z === 'graveyard' ? ' graveyard' : z === 'hand' ? ' hand' : z === 'exile' ? ' exile' : '');
  const line = (n) => {
    const c = card(n.iid);
    const nm = `<b>${esc(cardName(c))}</b>`;
    return n.by === 'p' ? `You gained control of ${nm} from the AI's${where(n.fromZone) || ' battlefield'}.` : `The AI gained control of your ${nm}${n.fromZone !== 'battlefield' ? ` (from your${where(n.fromZone)})` : ''}.`;
  };
  const theirs = notes.some((n) => n.by === 'ai');
  const dlg = openDialog(`
    <span class="eyebrow">${theirs && notes.every((n) => n.by === 'ai') ? 'Stolen' : 'Gained control'}</span>
    <h3>${notes.length === 1 ? esc(cardName(card(notes[0].iid))) : `${notes.length} cards changed hands`}</h3>
    <div class="steal-cards">${notes.map((n) => `<div class="steal-card">${DB[card(n.iid).def].faces[0].img ? `<img src="${DB[card(n.iid).def].faces[card(n.iid).face || 0].img || DB[card(n.iid).def].faces[0].img}" alt="${esc(cardName(card(n.iid)))}">` : cardHTML({ ...card(n.iid), tapped: false, sick: false })}</div>`).join('')}</div>
    <p>${notes.map(line).join('<br>')}</p>
    <div class="btns"><button class="primary" id="steal-ok">OK</button></div>`, { small: notes.length === 1 });
  $('#steal-ok', dlg).addEventListener('click', () => closeDialog());
}
function renderAll() {
  const s = G.s;
  if (!s) return;
  document.querySelectorAll('.card.ghost').forEach((g) => (!drag || g !== drag.ghost) && g.remove());
  renderTop();
  renderOpp();
  renderMine();
  {
    // (an older cached index.html may not have the box yet: add it to the side rail)
    let dz = $('#dungeons');
    if (!dz && $('#log')) { dz = document.createElement('div'); dz.id = 'dungeons'; $('#log').after(dz); }
    if (dz) { const h = dungeonMap('p') + dungeonMap('ai'); if (dz.innerHTML !== h) dz.innerHTML = h; }
  }
  renderHand();
  renderBanner();
  renderLog();
  renderPreview();
  // highlight a player who's being attacked directly
  {
    const cb = s.combat;
    for (const [pid, sel] of [['p', '#my-panel'], ['ai', '#opp-panel']]) {
      const el = $(sel);
      if (!el) continue;
      const n = cb && cb.by ? (cb.attackers || []).filter((a) => ((cb.targets || {})[a] || opp(cb.by)) === pid).length : 0;
      el.classList.toggle('under-attack', !!n);
    }
  }
  document.body.classList.toggle('ai-turn', s.active === 'ai');
  document.body.classList.toggle('target-mode', !!pendingTarget);
  document.body.classList.toggle('block-mode', !!(s.combat && s.combat.by === 'ai' && pendingBlocks));
  document.body.classList.toggle('attack-mode', !!(s.combat && s.combat.by === 'p' && s.combat.stage === 'declare'));
  document.body.classList.toggle('opp-popped', popouts.has('ai'));
  for (const d of popDocs()) d.body.className = document.body.className + ' popout-body';
}

function renderTop() {
  const s = G.s;
  const steps = STEPS.map(
    (k) => `<li class="${s.step === k ? 'on' : ''} ${STEPS.indexOf(k) < STEPS.indexOf(s.step) ? 'past' : ''}">${STEP_LABEL[k]}</li>`
  ).join('');
  const who = s.phase !== 'play' ? 'Mulligans' : s.active === 'p' ? 'Your turn' : "AI's turn";
  let next = 'Next step';
  if (s.step === 'main1') next = 'To combat';
  if (s.step === 'combat' && s.combat && s.combat.by === 'p') {
    next = s.combat.stage === 'declare' ? (s.combat.attackers.length ? `Attack (${s.combat.attackers.length})` : 'Skip combat') : s.combat.stage === 'triggers' ? 'Resolving…' : 'Deal damage';
  }
  if (s.step === 'main2') next = 'To end step';
  if (s.step === 'end') next = 'Pass turn';
  const mine = s.active === 'p' && !run.aiBusy && s.phase === 'play';
  if (!mine) next = s.phase === 'play' ? "AI's turn" : 'Mulligans';
  $('#turninfo').innerHTML = `<span class="tnum" title="Your turns: ${(s.turns || {}).p || 0} · AI turns: ${(s.turns || {}).ai || 0}">T${((s.turns || {})[s.active]) || s.turn || 0}</span><span class="who ${s.active === 'ai' ? 'ai' : 'you'}">${who}</span>`;
  $('#steps').innerHTML = steps;
  $('#btn-next').textContent = next;
  $('#btn-next').disabled = !mine;
  $('#btn-end').disabled = !mine;
  $('#btn-undo').disabled = !G.undo.length || run.aiBusy;
  $('#btn-redo').disabled = !G.redo.length || run.aiBusy;
}

function dungeonLine(pid) {
  const pl = G.s.players[pid];
  const bits = [];
  if (G.s.initiative === pid) bits.push('<span class="init" title="Venture into Undercity at your upkeep; whoever deals combat damage to you takes it">Initiative</span>');
  if (pl.dungeon) {
    const dg = DUNGEONS[pl.dungeon.name];
    const d = dg ? dungeonDepths(dg) : null;
    const k = d ? (d.depth[pl.dungeon.room] || 0) + 1 : 0;
    bits.push(`<button class="dg" data-dungeon="${pid}" title="See the dungeon">${esc(pl.dungeon.name.replace(/ of .*/, ''))} · ${esc(pl.dungeon.room)} <small>${k}/${d ? d.rows.length : '?'}</small></button>`);
  }
  if (pl.dungeonsCompleted) bits.push(`<span class="dg-done">${pl.dungeonsCompleted} dungeon${pl.dungeonsCompleted > 1 ? 's' : ''} completed</span>`);
  return bits.length ? `<div class="dungeon-row">${bits.join('')}</div>` : '';
}

// depth of each room = longest path from the first room; rows of rooms by depth
function dungeonDepths(dg) {
  const depth = { [dg.first]: 0 };
  for (const n of dg.order) for (const nx of (dg.rooms[n] || { next: [] }).next) if (depth[n] !== undefined) depth[nx] = Math.max(depth[nx] || 0, depth[n] + 1);
  const rows = [];
  for (const n of dg.order) (rows[depth[n] || 0] = rows[depth[n] || 0] || []).push(n);
  return { depth, rows };
}

// The dungeon as a little map on the side: rooms by depth, where you are, where you can go next.
function dungeonMap(pid) {
  const pl = G.s.players[pid];
  if (!pl.dungeon) return pl.dungeonsCompleted ? `<div class="dg-map done"><div class="er-title">${pid === 'p' ? 'You have' : 'The AI has'} completed <b>${pl.dungeonsCompleted}</b> dungeon${pl.dungeonsCompleted > 1 ? 's' : ''}</div></div>` : '';
  const dg = DUNGEONS[pl.dungeon.name];
  if (!dg) return '';
  const { depth, rows } = dungeonDepths(dg);
  const here = pl.dungeon.room;
  const next = (dg.rooms[here] || { next: [] }).next;
  const visited = pl.dungeon.visited || [];
  const total = rows.length;
  const at = (depth[here] || 0) + 1;
  return `<div class="dg-map" data-dungeon="${pid}" title="Click to see every room">
    <div class="er-title">${pid === 'p' ? 'Your dungeon' : "AI's dungeon"} · ${esc(dg.name)} <b>${at}/${total}</b></div>
    ${rows.filter(Boolean).map((row) => `<div class="dg-rowmap">${row.map((n) => {
      const cls = n === here ? 'here' : next.includes(n) ? 'next' : visited.includes(n) ? 'been' : '';
      return `<span class="dg-room ${cls}" title="${esc(n)} — ${esc(dg.rooms[n].text)}">${n === here ? '◆ ' : visited.includes(n) ? '✓ ' : ''}${esc(n)}</span>`;
    }).join('')}</div>`).join('<div class="dg-arrow">↓</div>')}
    ${next.length ? '' : '<div class="dg-last">Last room — the next venture completes it</div>'}
  </div>`;
}

function dungeonDialog(pid) {
  const pl = G.s.players[pid];
  if (!pl.dungeon) return;
  const dg = DUNGEONS[pl.dungeon.name];
  openDialog(`<span class="eyebrow">${pid === 'p' ? 'Your' : "The AI's"} dungeon</span><h3>${esc(dg.name)}</h3>
    <ol class="rooms">${dg.order
      .map((n) => {
        const r = dg.rooms[n];
        const cls = n === pl.dungeon.room ? 'here' : pl.dungeon.visited.includes(n) ? 'been' : '';
        return `<li class="${cls}"><b>${esc(n)}</b> — ${esc(r.text)}${r.next.length ? `<small>→ ${esc(r.next.join(' or '))}</small>` : '<small>last room</small>'}</li>`;
      })
      .join('')}</ol>`);
}

// Monarch, day/night, speed, the Ring, energy and other player counters, floating mana.
function statusLine(pid) {
  const s = G.s;
  const pl = s.players[pid];
  const bits = [];
  if (s.monarch === pid) bits.push('<span class="st monarch" title="Draws a card at the beginning of their end step; combat damage to them steals it">♛ Monarch</span>');
  if (pl.cityBlessing) bits.push('<span class="st" title="City\'s blessing">City\'s blessing</span>');
  if (pl.speed) bits.push(`<span class="st" title="Speed">Speed ${pl.speed}${pl.speed >= 4 ? ' (max)' : ''}</span>`);
  {
    const xt = (G.s.extraTurns || {})[pid] || 0;
    if (G.s.active === pid && G.s.inExtraTurn) bits.push('<span class="st xturn now" title="This is an extra turn">⟳ Extra turn</span>');
    if (xt) bits.push(`<span class="st xturn" title="${pid === 'p' ? 'You take' : 'The AI takes'} ${xt} more turn${xt > 1 ? 's' : ''} after this one">⟳ ${xt} extra turn${xt > 1 ? 's' : ''} left</span>`);
  }
  for (const e of pl.emblems || []) bits.push(`<span class="st" title="${esc(e)}">Emblem: ${esc(e.length > 28 ? e.slice(0, 26) + '…' : e)}</span>`);
  if (pl.ring) bits.push(`<span class="st" title="The Ring has tempted ${pid === 'p' ? 'you' : 'the AI'} ${pl.ring} time(s)">Ring ${pl.ring}</span>`);
  const names = { energy: 'Energy', experience: 'Experience', rad: 'Rad', ticket: 'Tickets' };
  for (const [k, v] of Object.entries(pl.counters || {})) if (v) bits.push(`<span class="st">${esc(names[k] || k)} ${v}</span>`);
  const pool = (s.pool && s.pool[pid]) || [];
  if (pool.length) bits.push(`<span class="st pool" title="Floating mana (empties between steps)">Pool ${manaSymbols(pool.map((x) => `{${x === 'ANY' ? '*' : x}}`).join(''))}</span>`);
  if (pid === 'p' && s.dayNight) bits.push(`<span class="st daynight ${s.dayNight}">${s.dayNight === 'day' ? '☀ Day' : '☾ Night'}</span>`);
  return bits.length ? `<div class="status-row">${bits.join('')}</div>` : '';
}

function lifeBlock(pid) {
  const pl = G.s.players[pid];
  // Commander damage rows: creature commanders, any commander that's a creature right now (an animated Background), and any row with damage.
  const foes = Object.values(G.s.cards).filter(
    (c) => c.isCommander && c.owner === opp(pid) && (/Creature/.test(DB[c.def].typeLine) || (c.zone === 'battlefield' && isCreature(c)) || pl.cmdDmg[c.iid])
  );
  const cmd = foes
    .map((c) => {
      const v = pl.cmdDmg[c.iid] || 0;
      return `<div class="cmd-dmg ${v >= 15 ? 'warn' : ''}" title="Commander damage from ${esc(cardName(c))}">
        <span class="lbl">from ${esc(cardName(c).split(',')[0])}</span>
        <button class="mini" data-cmd="${pid}:${c.iid}:-1" aria-label="Less commander damage">−</button>
        <b>${v}</b><small>/21</small>
        <button class="mini" data-cmd="${pid}:${c.iid}:1" aria-label="More commander damage">+</button></div>`;
    })
    .join('');
  return `<div class="life ${pl.life <= 10 ? 'low' : ''}">
      <button class="lbtn" data-life="${pid}:-1" title="−1 (Shift: −5)">−</button>
      <button class="lval" data-setlife="${pid}" title="Click to set life">${pl.life}</button>
      <button class="lbtn" data-life="${pid}:1" title="+1 (Shift: +5)">+</button>
    </div>
    ${dungeonLine(pid)}
    ${statusLine(pid)}
    <div class="subcounters">
      <div class="poison" title="Poison counters"><span class="lbl">poison</span>
        <button class="mini" data-poison="${pid}:-1" aria-label="Less poison">−</button><b>${pl.poison}</b><small>/10</small>
        <button class="mini" data-poison="${pid}:1" aria-label="More poison">+</button></div>
      ${cmd}
    </div>`;
}

function pile(pid, zone, label) {
  const ids = zoneOf(pid, zone);
  const top = ids.length ? card(ids[ids.length - 1]) : null;
  let face = '';
  if (zone === 'library') face = ids.length ? '<div class="back"></div>' : '';
  else if (top && pid === 'ai' && zone === 'exile' && (top.foretold || top.faceDown)) face = '<div class="card small facedown"></div>'; // foretold cards are hidden
  else if (top) face = cardHTML(top, { small: true });
  return `<div class="pile ${zone}" data-pile="${pid}:${zone}" ${pid === 'p' ? `data-drop="${zone}"` : ''} title="${label} (${ids.length})">
      <div class="pile-face">${face}<b class="pile-n">${ids.length}</b></div>
      <div class="pile-label">${label}</div>
    </div>`;
}

// Cards you can cast from exile (or will be able to): foretold, plotted, on an adventure, impulse draws, suspend…
function exileReady(pid) {
  const s = G.s;
  const items = [];
  for (const c of Object.values(s.cards)) {
    if (c.zone !== 'exile') continue;
    let tag = null;
    let ready = true;
    if (c.owner === pid && c.foretold) { tag = 'Foretold'; ready = c.foretoldTurn < s.turn; }
    else if (c.owner === pid && c.plotted) { tag = 'Plotted'; ready = c.plottedTurn < s.turn; }
    else if (c.owner === pid && c.onAdventure) tag = 'Adventure';
    else if (c.mayPlayFree === pid && (c.mayPlayFreeUntil ?? 1e9) >= s.turn) tag = 'Free';
    else if (c.mayPlay === pid && (c.mayPlayUntil || 0) >= s.turn) tag = c.mayPlayUntil > s.turn + 50 ? (c.myTurnOnly ? 'Your turns' : 'While exiled') : c.mayPlayUntil > s.turn ? 'Until next turn' : 'This turn';
    else if (c.owner === pid && c.warped) tag = 'Warp';
    else if (c.owner === pid && c.suspended && c.counters && c.counters.time > 0) { tag = `Suspend ⏳${c.counters.time}`; ready = false; }
    if (!tag) continue;
    // the AI's foretold cards stay face down to you
    const hidden = (pid === 'ai' && c.foretold) || hiddenFromMe(c);
    items.push({ c, tag, ready, hidden });
  }
  if (!items.length) return '';
  const order = { Foretold: 0, Plotted: 1, Adventure: 2, Free: 3, 'This turn': 4, 'Until next turn': 5, Warp: 6 };
  items.sort((a, b) => (order[a.tag] ?? 9) - (order[b.tag] ?? 9));
  return `<div class="exile-ready" title="Cards ${pid === 'p' ? 'you' : 'the AI'} can cast from exile">
    <div class="er-title">From exile <b>${items.length}</b></div>
    <div class="er-cards">${items.map(({ c, tag, ready, hidden }) => `<div class="er-item ${ready ? 'ready' : 'waiting'}">${hidden ? '<div class="card small facedown"></div>' : cardHTML(c, { small: true })}<span class="er-tag">${esc(tag)}</span></div>`).join('')}</div>
  </div>`;
}

// your commander just left play: you choose whether it goes to the command zone
function commanderChoice() {
  const items = Object.values(G.s.cards).filter((c) => c.owner === 'p' && c.isCommander && c.cmdAsk && c.cmdAsk === c.zone);
  if (!items.length) return '';
  const where = { graveyard: 'graveyard', exile: 'exile', hand: 'hand', library: 'library' };
  return items.map((c) => `<div class="cmd-choice" data-iid="${c.iid}">
    <div class="er-title">Commander went to your ${where[c.zone]}</div>
    <div class="cc-row">${cardHTML(c, { small: true })}
      <div class="cc-btns"><button class="primary" data-cmdzone="yes" data-iid="${c.iid}">Command zone</button><button data-cmdzone="no" data-iid="${c.iid}">Leave in ${where[c.zone]}</button></div>
    </div></div>`).join('');
}

function commandZone(pid) {
  const ids = zoneOf(pid, 'command');
 const inner = ids.map((i, k) => `<div class="cz-slot" style="--k:${k}">${cardHTML(card(i), { small: true })}</div>`).join('');
  return `<div class="pile cmdtile ${ids.length > 1 ? 'multi' : ''}" data-pile="${pid}:command" ${pid === 'p' ? 'data-drop="command"' : ''} title="Command zone">
    <div class="pile-face">${inner}</div><div class="pile-label">Command</div></div>`;
}

function renderOpp() {
  const s = G.s;
  const hand = zoneOf('ai', 'hand');
  const shown = revealAiHand || aiSlaved() || handControl('p', 'ai') || (s.handRevealed && s.handRevealed.pid === 'ai' && s.handRevealed.turn === s.turn);
  const backs = shown
    ? `<div class="ai-hand-reveal">${hand.map((i) => cardHTML(card(i), { small: true })).join('')}</div>`
    : `<div class="ai-hand" title="AI hand">${hand.map(() => '<i></i>').join('')}<b>${hand.length}</b></div>`;
  $('#opp-panel').innerHTML = `
    <div class="pname"><span class="dot ai"></span>AI <small>${esc(s.decks.ai.name)}</small><button class="popout-btn" data-act="${popouts.has('ai') ? 'popin' : 'popout'}" data-pid="ai" title="${popouts.has('ai') ? 'Put the AI\'s board back in the main window' : 'Pop the AI\'s board out into its own window (for a second screen)'}">${popouts.has('ai') ? '⇲ Bring back' : '⧉ Pop out'}</button></div>
    ${lifeBlock('ai')}
    <div class="piles">${pile('ai', 'library', 'Library')}${pile('ai', 'graveyard', 'Grave')}${pile('ai', 'exile', 'Exile')}${commandZone('ai')}</div>
    ${exileReady('ai')}
    <div class="hand-row"><span class="lbl">Hand</span>${backs}</div>
    ${handControl('p', 'ai') ? '<p class="hint sl-hint">Sen Triplets: double-click the AI\'s cards to play or cast them with your mana.</p>' : ''}`;

  // AI battlefield: lanes, mirrored (its creatures face yours)
  const of = $('#opp-field');
  of.classList.add('organized');
  of.innerHTML = boardLanes('ai');
  fitLanes(of);
}

// ------------------------------------------------------------ organized battlefield
// Identical permanents stack into one card with a ×N badge; Auras and Equipment tuck behind what they're attached to;
// each lane (creatures / other permanents / lands) shrinks its cards to fit before it wraps.
function stackKey(c) {
  const cb = G.s.combat;
  if (cb && (cb.attackers.includes(c.iid) || Object.values(cb.blocks || {}).some((b) => b.includes(c.iid)) || cb.selected === c.iid)) return null;
  if (pendingTarget && pendingTarget.req.candidates.includes(c.iid)) return null;
  if (G.s.stack && G.s.stack.iid === c.iid) return null;
  if (isType(c, 'Planeswalker') || c.isCommander || c.faceDown) return null;
  const sick = isCreature(c) && c.sick && !hasKw(c, 'haste') && c.controller === G.s.active;
  return [c.def, c.face || 0, c.tapped ? 1 : 0, c.token ? 1 : 0, sick ? 1 : 0, c.damage || 0, JSON.stringify(c.counters || {}), JSON.stringify(c.grants || []), JSON.stringify(c.eot || null),
    JSON.stringify(c.eotGrants || []), JSON.stringify(c.auraBuffs || {}), c.chosenType || '', c.chosenMode || '', c.chosenColor || '', c.chosenCardType || '', JSON.stringify(c.unlocked || null), c.prepared ? 1 : 0, c.pacifiedBy || '', c.notLegendary ? 1 : 0, c.sector || '', c.floated ? 1 : 0].join('|');
}

function boardLanes(pid) {
  const bf = cardsIn(pid, 'battlefield');
  const onField = new Set(bf.map((c) => c.iid));
  const all = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')];
  // attachments live with their host (even an Aura you put on the opponent's creature)
  const att = {};
  for (const a of all) if (a.attachedTo && card(a.attachedTo) && card(a.attachedTo).zone === 'battlefield' && !isCreature(a)) (att[a.attachedTo] = att[a.attachedTo] || []).push(a);
  const tucked = new Set(Object.values(att).flat().map((a) => a.iid));
  const free = bf.filter((c) => !tucked.has(c.iid));
  const nm = (c) => cardName(c);
  const byName = (a, b) => nm(a).localeCompare(nm(b)) || (a.tapped ? 1 : 0) - (b.tapped ? 1 : 0);
  // mana rocks (noncreature, nonland permanents that make mana) live next to the lands
  const isRock = (c) => !isCreature(c) && !isLand(c) && !isType(c, 'Planeswalker') && !!manaAbility({ ...c, tapped: false, sick: false });
  const creatures = free.filter((c) => isCreature(c));
  const lands = free.filter((c) => isLand(c) && !isCreature(c));
  const rocks = free.filter(isRock);
  const other = free.filter((c) => !creatures.includes(c) && !lands.includes(c) && !rocks.includes(c));
  // creatures: commanders, then cards, then tokens; others: planeswalkers, enchantments, artifacts, the rest
  const cSort = (c) => (c.isCommander ? 0 : c.token ? 2 : 1);
  creatures.sort((a, b) => cSort(a) - cSort(b) || byName(a, b));
  const oSort = (c) => (isType(c, 'Planeswalker') ? 0 : isType(c, 'Battle') ? 1 : isType(c, 'Enchantment') ? 2 : isType(c, 'Artifact') ? 3 : 4);
  other.sort((a, b) => oSort(a) - oSort(b) || byName(a, b));
  // lands: basics by type first, then the rest by name
  const BASIC = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'];
  const lSort = (c) => { const k = BASIC.indexOf(nm(c)); return k >= 0 ? k : 10; };
  lands.sort((a, b) => lSort(a) - lSort(b) || byName(a, b));
  rocks.sort(byName);
  const lane = (arr, cls, empty, groupOf) => {
    const groups = [];
    const byKey = {};
    for (const c of arr) {
      const k = att[c.iid] ? null : stackKey(c);
      if (k && byKey[k]) byKey[k].n++;
      else {
        const g = { c, n: 1 };
        if (k) byKey[k] = g;
        groups.push(g);
      }
    }
    let lastGroup = null;
    const html = groups.map(({ c, n }) => {
      const g = groupOf ? groupOf(c) : null;
      const sep = lastGroup !== null && g !== lastGroup ? '<span class="lane-sep"></span>' : '';
      lastGroup = g;
      const host = sep + cardHTML(c, { count: n, stacked: n > 1 });
      const a = (att[c.iid] || []).filter((x) => !onField.has(x.iid) || true);
      if (!a.length) return host;
      return `${sep}<div class="host" style="--att:${a.length}">${a.map((x, k) => `<div class="att" style="--k:${k}">${cardHTML(x)}</div>`).join('')}${host.slice(sep.length)}</div>`;
    }).join('');
    return `<div class="lane ${cls}">${html || (empty ? `<span class="row-empty">${empty}</span>` : '')}</div>`;
  };
  const lanes = [
    lane(creatures, 'creatures', pid === 'ai' ? 'No creatures' : '', (c) => (c.token ? 't' : 'c')),
    lane(other, 'others', '', oSort),
    lane([...lands, ...rocks], 'lands', '', (c) => (rocks.includes(c) ? 'rock' : 'land')),
  ];
  return pid === 'ai' ? lanes.reverse().join('') : lanes.join('');
}

// shrink a lane's cards until they fit on one line (down to 60%), then let it wrap; then make the whole board fit
// the height. Sizes are worked out arithmetically from the lane contents, so the browser only lays out once.
function fitLanes(root) {
  const cs = getComputedStyle(root);
  const bw = parseFloat(cs.getPropertyValue('--cw')) || 80;
  const bh = parseFloat(cs.getPropertyValue('--ch')) || 112;
  const W = root.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const H = root.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  const lanes = [...root.querySelectorAll('.lane')].map((ln) => {
    const items = [...ln.children].filter((x) => !x.classList.contains('lane-sep') && !x.classList.contains('row-empty'));
    let tapped = 0;
    let stacked = 0;
    let att = 0;
    for (const it of items) {
      const cardEl = it.classList.contains('host') ? it.lastElementChild : it;
      if (cardEl && cardEl.classList.contains('tapped')) tapped++;
      if (cardEl && cardEl.classList.contains('stacked')) stacked++;
      if (it.classList.contains('host')) att = Math.max(att, +(it.style.getPropertyValue('--att') || 0));
    }
    const seps = ln.querySelectorAll(':scope > .lane-sep').length;
    const base = ln.classList.contains('lands') ? 0.78 : ln.classList.contains('others') ? 0.9 : 1;
    return { ln, n: items.length, tapped, stacked, att, seps, base };
  });
  const widthAt = (L, w, h) => L.n * w + L.tapped * (h - w) + L.stacked * 6 + Math.max(0, L.n - 1) * 8 + L.seps * 13;
  const layout = (g) => {
    let total = 0;
    for (const L of lanes) {
      if (!L.n) {
        L.h = 0;
        continue;
      }
      let sc = L.base;
      const need = widthAt(L, bw * g * sc, bh * g * sc);
      if (need > W) sc = Math.max(0.6, sc * (W / need));
      const w = bw * g * sc;
      const h = bh * g * sc;
      const rows = Math.max(1, Math.ceil(widthAt(L, w, h) / Math.max(1, W)));
      L.sc = sc;
      L.rows = rows;
      L.h = rows * (h + 6) + L.att * 18 + (rows - 1) * 10;
      total += L.h + 10;
    }
    return total;
  };
  let g = 1;
  let total = layout(g);
  for (let k = 0; k < 8 && total > H && g > 0.55; k++) {
    g = Math.max(0.55, g * Math.max(0.8, Math.min(0.97, H / total)));
    total = layout(g);
  }
  for (const L of lanes) {
    if (!L.n) continue;
    L.ln.style.setProperty('--cw', `${Math.round(bw * g * L.sc)}px`);
    L.ln.style.setProperty('--ch', `${Math.round(bh * g * L.sc)}px`);
    L.ln.classList.toggle('wrap', L.rows > 1);
  }
}

function renderMine() {
  const s = G.s;
  const field = $('#my-field');
  window.__fieldWidth = field.clientWidth;
  window.__fieldHeight = field.clientHeight;
  const bf = cardsIn('p', 'battlefield');
  const organized = G.settings.boardLayout !== 'free';
  field.classList.toggle('organized', organized);
  if (organized) {
    field.innerHTML = bf.length ? boardLanes('p') : '<div class="field-hint">Drag cards here from your hand, or double-click them.</div>';
    fitLanes(field);
  } else {
    for (const c of bf) if (c.x === null || c.x === undefined) Object.assign(c, freeSpotFor(c));
    field.innerHTML = bf.map((c) => cardHTML(c, { abs: true })).join('') +
      (bf.length ? '' : '<div class="field-hint">Drag cards here from your hand, or double-click them.</div>');
  }
  const tb = $('#btn-tidy');
  if (tb) tb.hidden = organized;
  $('#my-panel').innerHTML = `
    <div class="pname"><span class="dot you"></span>You <small>${esc(s.decks.p.name)}</small></div>
    ${lifeBlock('p')}
    <div class="piles">${pile('p', 'library', 'Library')}${pile('p', 'graveyard', 'Grave')}${pile('p', 'exile', 'Exile')}${commandZone('p')}</div>
    ${commanderChoice()}
    ${exileReady('p')}`;
}

function freeSpotFor(c) {
  return freeSpot(c);
}

function renderHand() {
  const hand = cardsIn('p', 'hand');
  $('#hand').innerHTML = hand.map((c) => cardHTML(c)).join('') ||
    '<div class="field-hint">Your hand is empty.</div>';
  $('#hand-count').textContent = hand.length;
}

function renderBanner() {
  const s = G.s;
  const el = $('#banner');
  let html = '';
  if (pendingTarget) {
    const r = pendingTarget.req;
    const srcName = r.src ? cardName(card(r.src.iid) || r.src) : '';
    html = `<div class="combat-bar targeting"><span class="eyebrow">${esc(srcName)}</span>
      <p>${esc(r.prompt)}. ${r.candidates.length ? 'Legal targets are highlighted — click one.' : ''}</p>
      <div class="btns">
        ${(r.players || []).map((pid) => `<button class="${pid === 'ai' ? 'primary' : ''}" data-tgt-player="${pid}">${pid === 'ai' ? 'Target the AI' : 'Target yourself'}</button>`).join('')}
        ${r.optional ? '<button data-act="tgt-skip">No target</button>' : ''}
        ${r.forced ? '' : '<button data-act="tgt-cancel">Cancel <kbd>Esc</kbd></button>'}
      </div></div>`;
  } else if (s.pstack) {
    html = `<div class="thinking"><span class="spinner"></span>Resolving ${esc(cardName(card(s.pstack.iid)))}…</div>`;
  } else if (s.stack) {
    const c = card(s.stack.iid);
    const arena = G.settings.arenaMode;
    const responses = arena ? cardsIn('p', 'hand').concat(cardsIn('p', 'command')).filter(respondable).length : 0;
    html = `<div class="stack">
      <div class="stack-card">${cardHTML(c)}</div>
      <div class="stack-copy"><span class="eyebrow">${s.stack.ability ? 'AI is activating an ability' : 'AI is casting'}</span><h3>${esc(cardName(c))}</h3>
      <p>${esc(s.stack.ability || oracle(c)).replace(/~/g, esc(cardName(c))).replace(/\n/g, '<br>')}</p>
      ${(s.stack.targets || []).length ? `<p class="stack-targets">Targeting: ${s.stack.targets.map((t) => t.player ? `<b>${t.player === 'p' ? 'you' : 'the AI'}</b>` : card(t.iid) ? `<b>${card(t.iid).controller === 'p' ? 'your' : 'its own'} ${esc(cardName(card(t.iid)))}</b>` : '').filter(Boolean).join(', ')}</p>` : ''}
      ${arena ? `<p class="hint">${responses ? `You have ${responses} instant-speed card${responses > 1 ? 's' : ''} you can afford (glowing in your hand) — double-click one to respond, or let it resolve.` : 'You have nothing you can cast in response.'}</p>` : ''}
      <div class="btns"><button class="primary" data-act="resolve">Let it resolve <kbd>Enter</kbd></button>
      ${arena ? '' : '<button data-act="counter" title="Tabletop mode: counter it by hand">Counter it</button>'}</div></div></div>`;
  } else if (s.combat && s.combat.by === 'p') {
    const cb = s.combat;
    if (cb.stage === 'declare') {
      const pw = cb.attackers.reduce((a, i) => a + Math.max(0, power(card(i))), 0);
      const perTax = cardsIn('ai', 'battlefield').map(attackTaxOf).filter(Boolean).reduce((a, t) => a + t.per, 0);
      const taxNow = cb.attackers.length ? attackTax(cb.attackers, cb.targets || {}, 'p') : 0;
      const taxLine = perTax ? ` <span class="taxline">Attack tax: {${perTax}} per attacker${taxNow ? ` — <b>{${taxNow}}</b> for these` : ''}.</span>` : '';
      html = `<div class="combat-bar"><span class="eyebrow">Declare attackers</span>
        <p>Click your untapped creatures to attack the AI. ${cb.attackers.length ? `<b>${cb.attackers.length}</b> attacking for <b>${pw}</b>.` : ''}${taxLine}</p>
        <div class="btns"><button class="primary" data-act="attack" ${cb.attackers.length ? '' : 'disabled'}>Attack</button>
        <button data-act="all-attack">Select all</button><button data-act="skip-combat">Skip combat</button></div></div>`;
    } else if (cb.stage === 'damage') {
      const bl = Object.keys(cb.blocks).length;
      html = `<div class="combat-bar"><span class="eyebrow">Blocks declared</span>
        <p>${bl ? `The AI blocked ${bl} attacker${bl > 1 ? 's' : ''}. Numbered tags show who blocks whom.` : 'The AI did not block.'} Use tricks now by hand, then deal damage.</p>
        <div class="btns"><button class="primary" data-act="damage">Deal damage <kbd>Enter</kbd></button></div></div>`;
    }
  } else if (s.combat && s.combat.by === 'ai' && pendingBlocks) {
    const cb = s.combat;
    const total = cb.attackers.filter((a) => !(cb.blocks[a] || []).length).reduce((a, i) => a + Math.max(0, power(card(i))), 0);
    html = `<div class="combat-bar danger"><span class="eyebrow">The AI attacks you</span>
      <p>${cb.selected ? `Now click the attacker that <b>${esc(cardName(card(cb.selected)))}</b> should block.` : 'Click one of your untapped creatures, then the attacker it blocks. Click a blocker again to remove it.'}
      Unblocked damage: <b>${total}</b>${total >= G.s.players.p.life ? ' — <b class="lethal">lethal</b>' : ''}.</p>
      <div class="btns"><button class="primary" data-act="blocks">${Object.values(cb.blocks).some((b) => b.length) ? 'Confirm blocks' : 'No blocks'} <kbd>Enter</kbd></button></div></div>`;
  } else if (run.aiBusy) {
    html = `<div class="thinking"><span class="spinner"></span>${s.active === 'p' ? 'AI is deciding whether to respond…' : 'AI is taking its turn…'}</div>`;
  } else if (s.winner && !s.continueAfterWin) {
    html = `<div class="combat-bar ${s.winner === 'p' ? 'win' : 'danger'}"><span class="eyebrow">Game over</span>
      <h3>${s.winner === 'p' ? 'You win' : 'The AI wins'}</h3><p>${esc(s.players[opp(s.winner)].lost || '')}</p>
      <div class="btns"><button class="primary" data-act="rematch">Rematch</button><button data-act="continue">Keep playing</button><button data-act="newdecks">Change decks</button></div></div>`;
  }
  el.innerHTML = html;
  el.hidden = !html;
  // leave room at the middle seam for the banner, so it doesn't sit on top of the creatures
  const on = !!html;
  if (document.body.classList.contains('banner-on') !== on) {
    document.body.classList.toggle('banner-on', on);
    for (const f of [$('#opp-field'), $('#my-field')]) if (f && f.classList.contains('organized')) fitLanes(f);
  }
}

function renderLog() {
  const el = $('#log');
  el.innerHTML = G.s.log
    .map((l) => (l.who === 'turn' ? `<li class="turn">${esc(l.html)}</li>` : `<li class="${l.who}">${l.html}</li>`))
    .join('');
  if (!logScrolledUp) el.scrollTop = el.scrollHeight;
}

let previewDef = null;
let previewFace = 0;
let previewIid = null;
function renderPreview() {
  const el = $('#preview');
  let c = previewIid ? card(previewIid) : null;
  if (previewIid && !c) previewIid = null;
  const d = c ? DB[c.def] : previewDef ? DB[previewDef] : null;
  if (!d || (c && c.faceDown && !isMine(c)) || hiddenFromMe(c)) {
    el.innerHTML = '<div class="pv-empty">Hover a card to see it here.</div>';
    return;
  }
  const fi = c ? c.face || 0 : previewFace;
  const f = d.faces[fi] || d.faces[0];
  const src = f.imgLarge || f.img;
  const extras = [];
  if (c && c.zone === 'battlefield' && isCreature(c)) {
    extras.push(`<span>P/T <b>${power(c)}/${toughness(c)}</b>${c.damage ? ` · ${c.damage} damage` : ''}</span>`);
  }
  if (c && c.attachedTo && card(c.attachedTo)) extras.push(`<span>Attached to ${esc(cardName(card(c.attachedTo)))}</span>`);
  el.innerHTML = `${src ? `<img src="${src}" alt="${esc(f.name)}">` : ''}
    <div class="pv-text">
      <div class="pv-head"><b>${esc(f.name)}</b><span>${manaSymbols(f.manaCost)}</span></div>
      <div class="pv-type">${esc(f.typeLine)}</div>
      <p>${esc(f.oracle).replace(/\n/g, '<br>')}</p>
      ${f.power !== undefined && f.power !== null ? `<div class="pv-pt">${esc(f.power)}/${esc(f.toughness)}</div>` : ''}
      ${f.loyalty ? `<div class="pv-pt">Loyalty ${esc(f.loyalty)}</div>` : ''}
      ${extras.length ? `<div class="pv-extra">${extras.join('')}</div>` : ''}
      ${d.faces.length > 1 ? `<div class="pv-faces">${d.faces.map((x, k) => `<span class="${k === fi ? 'on' : ''}">${esc(x.name)}</span>`).join(' // ')}</div>` : ''}
    </div>`;
}

function setPreview(iid, defId, faceIdx = 0) {
  if (iid === previewIid && defId === previewDef) return;
  previewIid = iid;
  previewDef = defId;
  previewFace = faceIdx;
  renderPreview();
}

// ------------------------------------------------------------ hooks for the game loop
hooks.render = render;
hooks.wait = (ms) => new Promise((r) => setTimeout(r, ms));
hooks.respond = (iid) => {
  setPreview(iid, null);
  if (!G.settings.pauseOnAiSpells) return new Promise((r) => setTimeout(() => r('resolve'), Math.max(500, G.settings.aiSpeed)));
  return new Promise((r) => {
    pendingRespond = r;
    render(); // light up the cards you can respond with
  });
};
hooks.askBlocks = () =>
  new Promise((r) => {
    pendingBlocks = r;
    render();
  });
// Attacking planeswalkers and battles: choose what each attacker goes after.
hooks.attackTargets = (attackers, options) =>
  new Promise((resolve) => {
    const sel = (iid) => `<select data-atk="${iid}">${options.map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}</select>`;
    const dlg = openDialog(`<span class="eyebrow">Declare attackers</span><h3>What is each creature attacking?</h3>
      <div class="atk-targets">${attackers.map((i) => `<label class="atk-row"><span>${esc(cardName(card(i)))} <small>${power(card(i))}/${toughness(card(i))}</small></span>${sel(i)}</label>`).join('')}</div>
      <div class="btns"><button class="primary" id="at-ok">Attack</button><button id="at-cancel">Back</button></div>`, { onClose: () => resolve(null) });
    $('#at-ok', dlg).addEventListener('click', () => {
      const out = {};
      $$('select[data-atk]', dlg).forEach((el) => (out[el.dataset.atk] = el.value));
      closeDialog(true);
      resolve(out);
    });
    $('#at-cancel', dlg).addEventListener('click', () => {
      closeDialog(true);
      resolve(null);
    });
  });
hooks.turnStarted = (pid) => {
  if (pid === 'p') flash('Your turn', G.s ? `Turn ${(G.s.turns || {}).p || G.s.turn}` : '');
};

export function cancelPending() {
  if (pendingRespond) pendingRespond('resolve');
  if (pendingBlocks) pendingBlocks();
  pendingRespond = null;
  pendingBlocks = null;
}

function flash(text, sub = '') {
  const el = $('#flash');
  el.innerHTML = `<div class="big">${esc(text)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

export function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}


// ------------------------------------------------------------ Arena-style casting
let pendingTarget = null; // {req, resolve, reject}
let casting = false;

export const playerChooser = {
  target(req) {
    if (!req.candidates.length && !(req.players || []).length) {
      toast('No legal targets.');
      return Promise.resolve(null);
    }
    return new Promise((resolve, reject) => {
      pendingTarget = { req, resolve, reject };
      render();
    });
  },
  pickCards(req) {
    return new Promise((resolve, reject) => pickCardsDialog(req, resolve, reject));
  },
  scry({ n: count, surveil, pid }) {
    return scryDialog(count, surveil ? 'surveil' : 'scry', true, pid || 'p');
  },
  choose(req) {
    return new Promise((resolve) => {
      const dlg = openDialog(`<h3>${esc(req.prompt)}</h3>
        <div class="choices">${req.options
          .map((o, k) => `<button class="choice" data-k="${k}"><b>${esc(o.label)}</b>${o.detail ? `<span>${esc(o.detail)}</span>` : ''}</button>`)
          .join('')}</div>`, { noClose: true });
      dlg.addEventListener('click', (e) => {
        const b = e.target.closest('.choice');
        if (!b) return;
        closeDialog(true);
        resolve(+b.dataset.k);
      });
    });
  },
  async payUnless(amount, what, ward) {
    const src = manaSources('p');
    const pay = payCost(`{${amount}}`, src);
    if (!pay) return false;
    const body = ward ? `${what} — pay {${amount}} or your spell or ability is countered.` : `${what} — pay {${amount}} or your spell is countered.`;
    const yes = await confirmDialog({ title: `Pay {${amount}}?`, body }, `Pay {${amount}}`, 'Let it be countered');
    if (yes) applyPayment('p', pay);
    return yes;
  },
  confirm(title, body, info = {}) {
    const extra = info && info.cost ? ` (${String(info.cost).replace(/[{}]/g, '')})` : '';
    return confirmDialog({ title, body }, info && info.cost ? `Pay${extra}` : (info && info.yes) || 'Yes', info && info.cost ? "Don't" : (info && info.no) || 'No');
  },
  chooseNumber(req) {
    return askNumber(req.prompt, req.min ?? 0, { min: req.min ?? 0 }).then((v) => {
      if (v === null) throw new Cancelled();
      return Math.max(req.min ?? 0, Math.min(req.max ?? 99, v));
    });
  },
  chooseModes(req) {
    return new Promise((resolve, reject) => {
      const chosen = [];
      const dlg = openDialog(`<span class="eyebrow">${esc(req.src ? cardName(req.src) : '')}</span><h3>${esc(req.prompt)}</h3>
        <div class="choices modes">${req.modes
          .map((m, k) => `<button class="choice" data-k="${k}"><b>${esc(m.replace(/~/g, req.src ? cardName(req.src).split(',')[0] : 'it'))}</b></button>`)
          .join('')}</div>
        ${req.escalate ? `<p class="hint">Escalate: each mode after the first costs ${esc(req.escalate)} more.</p>` : ''}
        <div class="btns"><button class="primary" id="md-ok"></button><button id="md-cancel">Cancel</button></div>`, { noClose: true });
      const sync = () => {
        $$('.choice', dlg).forEach((b) => b.classList.toggle('on', chosen.includes(+b.dataset.k)));
        const ok = $('#md-ok', dlg);
        ok.disabled = chosen.length < (req.min ?? 1) || chosen.length > req.max;
        ok.textContent = chosen.length ? `Choose ${chosen.length}` : 'Choose';
      };
      dlg.addEventListener('click', (e) => {
        const b = e.target.closest('.choice');
        if (!b) return;
        const k = +b.dataset.k;
        if (chosen.includes(k)) chosen.splice(chosen.indexOf(k), 1);
        else {
          if (req.max === 1) chosen.length = 0;
          if (chosen.length < req.max) chosen.push(k);
        }
        sync();
      });
      $('#md-ok', dlg).addEventListener('click', () => {
        closeDialog(true);
        resolve(chosen.sort((a, b) => a - b));
      });
      $('#md-cancel', dlg).addEventListener('click', () => {
        closeDialog(true);
        reject(new Cancelled());
      });
      sync();
    });
  },
};
hooks.playerChooser = playerChooser;
T.choosers = { p: playerChooser, ai: aiChooser };

// ------------------------------------------------------------ Mindslaver: you control the AI's turn
// While you control the AI, every choice it would make (targets, modes, "may" questions, cards to pick) comes to you.
for (const k of ['target', 'pickCards', 'scry', 'choose', 'chooseModes', 'confirm', 'chooseNumber']) {
  const orig = aiChooser[k];
  aiChooser[k] = function (...a) {
    if (aiSlaved() && playerChooser[k]) {
      if (k === 'scry') return playerChooser.scry({ ...(a[0] || {}), pid: 'ai' });
      return playerChooser[k](...a);
    }
    return orig.apply(aiChooser, a);
  };
}

function slavedEnv() {
  return { ...aiEnv(hooks), respond: async () => 'resolve', aiCounter: async () => false, say: (m) => { toast(m); return false; } };
}
function aiAffordable(c, o) {
  const eff = effectiveCost('ai', c, o);
  return !!payCost((o.cost || '').replace(/\{X\}/g, ''), manaSources('ai', { convoke: hasKw(c, 'convoke'), improvise: hasKw(c, 'improvise'), delve: hasKw(c, 'delve'), self: c.iid }), { extraGeneric: eff.generic });
}
// Everything the AI could do right now in its main phase, for you to pick from.
function slavedActions() {
  const s = G.s;
  const out = [];
  const seen = new Set();
  const once = (key) => (seen.has(key) ? false : (seen.add(key), true));
  const main = s.step === 'main1' || s.step === 'main2';
  if (main && (s.landsPlayed || 0) < landsAllowed('ai')) {
    for (const c of cardsIn('ai', 'hand')) {
      const lo = landOptions('ai', c);
      if (lo.length && once('land:' + c.def)) out.push({ group: 'Play a land', c, label: lo[0].label || `Play ${cardName(c)}`, run: async () => playLand('ai', c.iid, lo[0].face) });
    }
  }
  for (const zone of ['hand', 'command', 'graveyard', 'exile']) {
    for (const c of cardsIn('ai', zone)) {
      for (const o of castOptions('ai', c)) {
        if (!timingOk('ai', c, o) || !aiAffordable(c, o) || !once(`cast:${zone}:${c.def}:${o.mode}:${o.face || 0}`)) continue;
        out.push({ group: zone === 'hand' ? 'Cast a spell' : 'Cast from ' + (zone === 'command' ? 'the command zone' : zone === 'graveyard' ? 'the graveyard' : 'exile'), c, label: o.label + (o.cost ? ' ' + o.cost : ''), run: async (env) => castSpell('ai', c.iid, o, env) });
      }
    }
  }
  for (const c of cardsIn('ai', 'battlefield')) {
    for (const ab of activatedAbilities(c)) {
      if (ab.kind === 'loyalty') {
        if (!main || loyaltyUsesLeft(c) <= 0 || (c.counters.loyalty || 0) + ab.cost < 0) continue;
      } else if (ab.kind === 'ability' || ab.kind === 'equip' || ab.kind === 'crew') {
        if (ab.tap && (c.tapped || (isCreature(c) && c.sick && !hasKw(c, 'haste')))) continue;
        if (ab.mana && !payCost(ab.mana.replace(/\{X\}/g, ''), manaSources('ai', {}).filter((m) => m.iid !== c.iid || !ab.tap))) continue;
        if (ab.sorcery && !main) continue;
      } else continue;
      out.push({ group: 'Activate an ability', c, label: `${ab.label || ab.costText || (ab.mana || '')}: ${(ab.text || '').slice(0, 80)}`, run: async (env) => activateAbility('ai', c, ab, env) });
    }
  }
  return out;
}
function slavedDialog(post, acts) {
  return new Promise((resolve) => {
    const groups = [...new Set(acts.map((a) => a.group))];
    const dlg = openDialog(`<span class="eyebrow">You control the AI this turn</span>
      <h3>AI's ${post ? 'second' : 'first'} main phase — what should it do?</h3>
      <p class="hint">The AI's mana is tapped for it automatically. You make every choice its cards ask for.</p>
      ${acts.length ? groups.map((g) => `<h4 class="sl-group">${esc(g)}</h4><div class="sl-list">${acts.map((a, k) => (a.group === g ? `<button class="sl-act" data-k="${k}">${cardHTML(a.c, { small: true })}<span>${esc(a.label)}</span></button>` : '')).join('')}</div>`).join('') : '<p>Nothing the AI can do right now.</p>'}
      <div class="btns"><button class="primary" data-done="1">${post ? 'End the AI\'s turn' : 'Go to combat'}</button></div>`, { wide: true, noClose: true });
    dlg.addEventListener('click', (e) => {
      const b = e.target.closest('.sl-act, [data-done]');
      if (!b) return;
      closeDialog(true);
      resolve(b.dataset.done ? null : acts[+b.dataset.k]);
    });
  });
}
hooks.slavedMain = async (post) => {
  for (let guard = 0; guard < 80; guard++) {
    if (!aiSlaved() || G.s.winner) return;
    render();
    const pick = await slavedDialog(post, slavedActions());
    if (!pick) return;
    const snap = JSON.stringify({ s: G.s, nextId: 0 });
    try {
      await pick.run(slavedEnv());
    } catch (e) {
      if (e instanceof Cancelled) restoreInPlace(snap);
      else console.error(e);
    }
    await settle();
    render();
  }
};
// Declare the AI's attackers (and what each attacks) for it.
hooks.slavedAttack = () =>
  new Promise((resolve) => {
    const can = cardsIn('ai', 'battlefield').filter((c) => isCreature(c) && canAttack(c));
    if (!can.length) return resolve({ attackers: [], targets: {} });
    const foes = [{ id: 'p', label: 'You' }, ...cardsIn('p', 'battlefield').filter((c) => isType(c, 'Planeswalker') || isType(c, 'Battle')).map((c) => ({ id: c.iid, label: cardName(c) }))];
    const sel = (iid) => `<select data-atk="${iid}">${foes.map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}</select>`;
    const dlg = openDialog(`<span class="eyebrow">You control the AI this turn</span><h3>Which of the AI's creatures attack?</h3>
      <div class="atk-targets">${can.map((c) => `<label class="atk-row"><input type="checkbox" data-pick="${c.iid}"> <span>${esc(cardName(c))} <small>${power(c)}/${toughness(c)}</small></span>${foes.length > 1 ? sel(c.iid) : ''}</label>`).join('')}</div>
      <div class="btns"><button class="primary" id="sl-atk">Attack</button><button id="sl-none">No attack</button></div>`, { noClose: true });
    $('#sl-atk', dlg).addEventListener('click', () => {
      const attackers = $$('[data-pick]', dlg).filter((x) => x.checked).map((x) => x.dataset.pick);
      const targets = {};
      for (const a of attackers) {
        const sl = $(`select[data-atk="${a}"]`, dlg);
        targets[a] = sl ? sl.value : 'p';
      }
      closeDialog(true);
      resolve({ attackers, targets });
    });
    $('#sl-none', dlg).addEventListener('click', () => {
      closeDialog(true);
      resolve({ attackers: [], targets: {} });
    });
  });
T.confirm = (title, body) => confirmDialog({ title, body }, 'Yes', 'No');
T.render = () => render();

function finishTarget(result) {
  const pt = pendingTarget;
  pendingTarget = null;
  render();
  if (pt) pt.resolve(result);
}
function cancelTarget() {
  const pt = pendingTarget;
  if (!pt || pt.req.forced) return;
  pendingTarget = null;
  render();
  pt.reject(new Cancelled());
}

function pickCardsDialog(req, resolve, reject) {
  const chosen = [];
  const min = req.min ?? 1;
  const max = req.max ?? 1;
  // Identical cards (eight Forests) show as one tile with a count, like Arena's search.
  const groups = [];
  for (const iid of req.cards) {
    const c = card(iid);
    // legend-rule choices show every copy separately (their counters may differ)
    const key = req.purpose === 'legend' ? iid : c.def + ':' + (c.face || 0);
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, ids: [] }));
    g.ids.push(iid);
  }
  groups.sort((a, b) => cardName(card(a.ids[0])).localeCompare(cardName(card(b.ids[0]))));
  const dlg = openDialog(`
    <span class="eyebrow">${esc(req.src ? cardName(req.src) : '')}</span>
    <h3>${esc(req.prompt)}</h3>
    ${groups.length > 10 ? '<input class="filter" id="pk-filter" placeholder="Filter by name or type…" autocomplete="off">' : ''}
    <div class="zv-grid pick">${groups
      .map((g, k) => `<button class="zv-item" data-group="${k}">${cardHTML(card(g.ids[0]), { small: true, count: g.ids.length })}<span>${esc(cardName(card(g.ids[0])))}</span><b class="pk-sel" hidden></b></button>`)
      .join('')}</div>
    <div class="btns"><button class="primary" id="pk-ok"></button>${req.forced ? '' : '<button id="pk-cancel">Cancel spell</button>'}<span class="hint" id="pk-n"></span></div>`,
    { wide: true, noClose: true });
  const sync = () => {
    $$('[data-group]', dlg).forEach((b) => {
      const g = groups[+b.dataset.group];
      const k = g.ids.filter((i) => chosen.includes(i)).length;
      b.classList.toggle('on', k > 0);
      const tag = $('.pk-sel', b);
      tag.hidden = !k || g.ids.length === 1;
      tag.textContent = `${k} chosen`;
    });
    const ok = $('#pk-ok', dlg);
    ok.disabled = chosen.length < min || chosen.length > max;
    ok.textContent = chosen.length ? `Choose ${chosen.length}` : min === 0 ? 'Choose none' : 'Choose';
    $('#pk-n', dlg).textContent = max > 1 ? `Pick ${min === max ? max : `up to ${max}`}. Click a stack again to take another copy.` : '';
  };
  dlg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-group]');
    if (!b) return;
    e.stopPropagation();
    const g = groups[+b.dataset.group];
    const mine = g.ids.filter((i) => chosen.includes(i));
    const next = g.ids.find((i) => !chosen.includes(i));
    if (max === 1) {
      const had = mine.length;
      chosen.length = 0;
      if (!had) chosen.push(g.ids[0]);
    } else if (next && chosen.length < max) chosen.push(next);
    else mine.forEach((i) => chosen.splice(chosen.indexOf(i), 1)); // full or out of copies: clear this stack
    sync();
  });
  const f = $('#pk-filter', dlg);
  if (f)
    f.addEventListener('input', () => {
      const q = f.value.toLowerCase();
      $$('[data-group]', dlg).forEach((el) => {
        const c = card(groups[+el.dataset.group].ids[0]);
        el.hidden = q && !(cardName(c) + ' ' + face(c).typeLine).toLowerCase().includes(q);
      });
    });
  $('#pk-ok', dlg).addEventListener('click', () => {
    closeDialog(true);
    resolve([...chosen]);
  });
  const cancel = $('#pk-cancel', dlg);
  if (cancel)
    cancel.addEventListener('click', () => {
      closeDialog(true);
      reject(new Cancelled());
    });
  sync();
}

function confirmDialog(text, yes, no) {
  return new Promise((resolve) => {
    const dlg = openDialog(`<h3>${esc(text.title)}</h3><p>${esc(text.body)}</p>
      <div class="btns"><button class="primary" id="cf-yes">${esc(yes)}</button><button id="cf-no">${esc(no)}</button></div>`,
      { small: true, onClose: () => resolve(false) });
    $('#cf-yes', dlg).addEventListener('click', () => {
      closeDialog(true);
      resolve(true);
    });
    $('#cf-no', dlg).addEventListener('click', () => {
      closeDialog(true);
      resolve(false);
    });
  });
}

// When the player may act: their own turn, or while the AI waits on them (its spell, its attack).
function canActNow() {
  if (G.s.phase !== 'play') return false;
  if (!run.aiBusy) return true;
  return !!(pendingRespond || pendingBlocks);
}

// Pay a mana cost with your mana pool, untapped lands, rocks and dorks (and convoke/delve/improvise
// when the spell has them). Returns {payers, special, sacs, x}, or null if cancelled.
async function playerPay(pid, cost, label, opts = {}) {
  if (pid !== 'p') return aiPay(pid, cost, label, opts);
  cost = cost || '';
  const allSrc = manaSources('p', opts).filter((m) => !(opts.exclude || []).includes(m.iid));
  // "Auto-sacrifice Treasures" off: pay without Treasures (and other sacrifice-for-mana sources) unless you agree
  let src = allSrc;
  if (G.settings.autoTreasure === false && allSrc.some((m) => m.sac)) {
    const noSac = allSrc.filter((m) => !m.sac);
    const probe = (list) => payCost(cost.replace(/\{X\}/g, ''), list, { extraGeneric: opts.extraGeneric || 0, waterbend: opts.waterbend || 0 });
    if (probe(noSac) || /\{X\}/.test(cost)) src = noSac;
    else if (probe(allSrc)) {
      const need = probe(allSrc).sacs.length;
      const ok = await confirmDialog({ title: 'Use Treasures?', body: `Your other mana can't pay for ${label}. Sacrifice ${need} Treasure${need === 1 ? '' : 's'} (or other sacrifice-for-mana permanents) to pay?` }, 'Sacrifice and pay', 'Cancel');
      if (!ok) return null;
    }
  }
  const extra = opts.extraGeneric || 0;
  let x = 0;
  let pay;
  if (/\{X\}/.test(cost)) {
    const xs = (cost.match(/\{X\}/g) || []).length;
    if (opts.xFixed !== undefined) x = opts.xFixed;
    else {
      const base = payCost(cost.replace(/\{X\}/g, ''), src, { extraGeneric: extra, waterbend: opts.waterbend || 0 });
      const used = base ? base.payers.length + base.special.length : 0;
      const max = base ? Math.floor((totalMana(src) - used) / xs) : 0;
      const v = await askNumber(`Choose X for ${label}`, Math.max(0, max), { min: 0, hint: `Your untapped mana can pay up to X = ${Math.max(0, max)}.` });
      if (v === null) return null;
      x = v;
    }
    pay = payCostKeep(cost.replace(/\{X\}/g, ''), src, { extraGeneric: extra + x * xs, waterbend: opts.waterbend || 0, self: opts.self }, 'p');
  } else pay = payCostKeep(cost, src, { extraGeneric: extra, waterbend: opts.waterbend || 0, self: opts.self }, 'p');
  if (!pay) {
    const shown = (cost.replace(/[{}]/g, '') || '0') + (extra > 0 ? ` + ${extra}` : extra < 0 ? ` − ${-extra}` : '');
    const ok = await confirmDialog(
      { title: 'Not enough mana', body: `You can't pay ${shown} for ${label} with your untapped permanents.` },
      'Do it anyway', 'Cancel'
    );
    if (!ok) return null;
    pay = { payers: [], special: [], sacs: [] };
  }
  return { ...pay, x };
}

function playerEnv(extra = {}) {
  return {
    choosers: { p: playerChooser, ai: aiChooser },
    pay: playerPay,
    render: () => render(),
    wait: (ms) => hooks.wait(ms),
    aiCounter: (spell) => aiMaybeCounter(spell, hooks),
    say: (text) => {
      toast(text);
      return false;
    },
    ...extra,
  };
}
hooks.payFor = playerPay;
hooks.envFor = (pid) => (pid === 'p' ? playerEnv() : aiEnv(hooks));
T.castFree = (pid, iid, o = {}) => castFree(pid, iid, hooks.envFor(pid), o);
T.payMana = async (pid, cost, label, opts = {}) => {
  const p = await hooks.envFor(pid).pay(pid, cost, label, opts);
  if (!p) return false;
  applyPayment(pid, p);
  return true;
};

// Run fn with an undo point; if the player cancels (Esc / Cancel), roll everything back.
async function withRollback(fn) {
  if (casting) {
    toast('Finish the spell you are casting first.');
    return;
  }
  snapshot();
  const depth = G.undo.length;
  const queued = eventQueue.length;
  casting = true;
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    if (eventQueue.length > queued) eventQueue.length = queued; // the cancelled spell never happened, so nothing triggers
    restoreInPlace(G.undo[depth - 1]); // same object, so a paused AI turn carries on
    G.undo.length = depth - 1;
    G.redo = [];
    toast('Cancelled');
  } finally {
    casting = false;
    pendingTarget = null;
    if (G.s) G.s.pstack = null;
    stateBased();
    render();
    refreshViewer();
  }
}

async function castByPlayer(iid, opts = {}) {
  await castInner(iid, opts);
  // your counterspell hit the AI's spell: let the AI's turn move on
  if (G.s.stack && G.s.stack.countered && pendingRespond) {
    const r = pendingRespond;
    pendingRespond = null;
    r('resolve');
  }
  settle();
}

// Cards that glow while the AI waits on you: things you can cast right now and afford.
function respondable(c) {
  if (!G.settings.arenaMode || !G.s || c.owner !== 'p' || !['hand', 'command', 'graveyard', 'exile'].includes(c.zone)) return false;
  if (!(pendingRespond || pendingBlocks)) return false;
  return castOptions('p', c).some((o) => timingOk('p', c, o) && affordable(c, o));
}
function affordable(c, o) {
  const eff = effectiveCost('p', c, o);
  return !!payCost((o.cost || '').replace(/\{X\}/g, ''), manaSources('p', { convoke: hasKw(c, 'convoke'), improvise: hasKw(c, 'improvise'), delve: hasKw(c, 'delve'), self: c.iid }), { extraGeneric: eff.generic });
}

// Pick one of several ways to cast a card (adventure, flashback, dash, kicker-less…).
function chooseOption(c, options) {
  if (options.length === 1) return Promise.resolve(options[0]);
  return new Promise((resolve) => {
    const dlg = openDialog(`<span class="eyebrow">${esc(cardName(c))}</span><h3>How do you want to play it?</h3>
      <div class="choices">${options
        .map((o, k) => `<button class="choice" data-k="${k}"><b>${esc(o.label)}</b>${o.cost ? `<span>${manaSymbols(o.cost)}</span>` : ''}${o.why ? `<span>${esc(o.why)}</span>` : ''}</button>`)
        .join('')}</div>`, { onClose: () => resolve(null) });
    dlg.addEventListener('click', (e) => {
      const b = e.target.closest('.choice');
      if (!b) return;
      closeDialog(true);
      resolve(options[+b.dataset.k]);
    });
  });
}

async function castInner(iid, opts = {}) {
  const c = card(iid);
  if (!c) return;
  if (!G.settings.arenaMode || opts.faceDown || opts.tapped || opts.free) return playFromHand(iid, opts);
  if (!canActNow()) return toast('Wait until the AI gives you a chance to respond.');
  if (G.s.pstack) return toast('Finish the spell you are casting first.');
  const name = cardName(c);
  // lands (and the land side of modal double-faced cards)
  const lands = c.zone === 'hand' || (c.zone === 'exile' && c.mayPlay === 'p' && !c.castOnly && (c.mayPlayUntil || 0) >= G.s.turn && (!c.myTurnOnly || G.s.active === 'p')) ? landOptions('p', c) : [];
  const casts = castOptions('p', c);
  const options = [
    ...lands.map((l) => ({ ...l, land: true, label: l.label })),
    ...casts,
  ];
  if (!options.length) return toast(`There's no way to cast ${name} from here — use the right-click menu to move it by hand.`);
  const opt = opts.option || (await chooseOption(c, options));
  if (!opt) return;
  if (opt.land) {
    const s = G.s;
    if (!(s.active === 'p' && (s.step === 'main1' || s.step === 'main2') && !s.stack && !run.aiBusy)) return toast('Lands can only be played in your main phase.');
    // one land a turn (more with Explore, Azusa…), from your hand or from exile alike
    if ((s.landsPlayed || 0) >= landsAllowed('p')) {
      const k = landsAllowed('p');
      return toast(k > 1 ? `You've already played your ${k} lands this turn.` : "You've already played a land this turn.");
    }
    act(() => playLand('p', iid, opt.face, opts.pos || {}));
    return;
  }
  if (!timingOk('p', c, opt)) return toast(`${name} can only be cast in your main phase when nothing else is happening.`);
  await withRollback(async () => {
    await castSpell('p', iid, opt, playerEnv({ pos: opts.pos }));
  });
}

async function activate(c, ab) {
  await activateInner(c, ab);
  settle();
}

async function activateInner(c, ab) {
  if (!canActNow()) return toast('Wait until the AI gives you a chance to respond.');
  if (ab.sorcery && !(G.s.active === 'p' && (G.s.step === 'main1' || G.s.step === 'main2') && !run.aiBusy)) return toast('Activate only as a sorcery.');
  return withRollback(async () => {
    const ok = await activateAbility('p', c, ab, playerEnv());
    if (ok === false) throw new Cancelled();
  });
}

async function zoneAbility(c, ab) {
  if (!canActNow()) return toast('Wait until the AI gives you a chance to respond.');
  if (ab.sorcery && !(G.s.active === 'p' && (G.s.step === 'main1' || G.s.step === 'main2') && !run.aiBusy)) return toast('Only at sorcery speed.');
  await withRollback(async () => {
    const ok = await useZoneAbility('p', c.iid, ab, playerEnv());
    if (ok === false) throw new Cancelled();
  });
  settle();
}

async function specialAction(fn) {
  await withRollback(async () => {
    const ok = await fn(playerEnv());
    if (ok === false) throw new Cancelled();
  });
  settle();
}

// ------------------------------------------------------------ player actions
function playFromHand(iid, opts = {}) {
  const c = card(iid);
  const d = DB[c.def];
  const fromCmd = c.zone === 'command';
  act(() => {
    if (fromCmd) G.s.players.p.tax[iid] = (G.s.players.p.tax[iid] || 0) + 1;
    if (!isPermanentCard(d) && !opts.faceDown) {
      move(iid, 'graveyard');
      log('p', `You cast ${nameTag(c)}.`);
      return;
    }
    if (isLand(c) && !opts.faceDown) {
      if (G.s.landPlayed && G.s.active === 'p') toast('That is your second land this turn.');
      if (G.s.active === 'p') {
        G.s.landsPlayed = (G.s.landsPlayed || 0) + 1;
        G.s.landPlayed = true;
      }
    }
    toBattlefield(iid, 'p', { faceDown: !!opts.faceDown, tapped: !!opts.tapped, ...(opts.pos || {}) });
    log('p', `You ${isLand(c) && !opts.faceDown ? 'play' : 'put'} ${opts.faceDown ? 'a card face down' : nameTag(c)}${fromCmd ? ` from the command zone (tax now +${commanderTax('p', iid)})` : ''}${isLand(c) ? '' : ' onto the battlefield'}.`);
  });
}

function toggleTap(iid) {
  const c = card(iid);
  // Arena-style: tapping your own mana source adds its mana to your pool ("floating" mana)
  if (G.settings.arenaMode && c && c.controller === 'p' && !c.tapped && manaAbility(c)) return floatMana(c);
  act(() => {
    // untapping a land you just tapped for mana takes that mana back out of the pool
    if (c.tapped && c.floated && c.floated.step === G.s.step && c.floated.turn === G.s.turn && G.s.pool) {
      for (const x of c.floated.syms) {
        const i = G.s.pool.p.lastIndexOf(x);
        if (i >= 0) G.s.pool.p.splice(i, 1);
      }
      delete c.floated;
    }
    c.tapped = !c.tapped;
  });
}

async function floatMana(c) {
  const m = manaAbility(c);
  let syms = [];
  // Signets: pay their {1} out of the mana pool first
  if (m.activation) {
    const pool = (G.s.pool && G.s.pool.p) || [];
    if (pool.length < m.activation) return toast(`${cardName(c)} needs {${m.activation}} to activate — tap a land for mana first, then tap ${cardName(c)}.`);
  }
  if (m.each) syms = [...m.each];
  else {
    let col = m.colors[0];
    if (m.colors.length > 1) {
      const names = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
      const k = await playerChooser.choose({ prompt: `Tap ${cardName(c)} for which color?`, options: m.colors.map((x) => ({ label: names[x] || x })), aiPick: () => 0 });
      if (k === null || k === undefined || k < 0) return;
      col = m.colors[k] || col;
    }
    syms = Array.from({ length: m.amount || 1 }, () => col);
  }
  act(() => {
    G.s.pool = G.s.pool || { p: [], ai: [] };
    if (m.activation) {
      // spend colorless first, then whatever is most plentiful
      for (let k = 0; k < m.activation; k++) {
        const pool = G.s.pool.p;
        const i = pool.indexOf('C') >= 0 ? pool.indexOf('C') : 0;
        pool.splice(i, 1);
      }
      log('p', `You pay {${m.activation}} to activate ${nameTag(c)}.`);
    }
    G.s.pool.p.push(...syms);
    c.tapped = true;
    c.floated = { syms, step: G.s.step, turn: G.s.turn };
    log('p', `You tap ${nameTag(c)} for ${manaSymbols(syms.map((x) => `{${x}}`).join(''))}.`);
    if (m.sac) sacrifice(c.iid);
    if (m.pain && syms.some((x) => m.pain.includes(x))) {
      changeLife('p', -1, false);
      log('p', `${nameTag(c)} costs you 1 life.`);
    }
  });
}

function sendTo(iid, zone, opts = {}) {
  const c = card(iid);
  if (!c) return;
  const label = { hand: 'hand', graveyard: 'graveyard', exile: 'exile', library: opts.to === 'bottom' ? 'bottom of library' : 'top of library', command: 'command zone' }[zone];
  act(() => {
    const nm = nameTag(c);
    const whose = c.owner === 'ai' ? "the AI's " : 'your ';
    const from = c.zone;
    move(iid, zone, opts);
    if (from !== zone || zone === 'library') log('p', `${nm} → ${zone === 'hand' && c.owner === 'ai' ? "the AI's hand" : whose + label}.`);
  });
}

async function askNumber(title, def = 1, opts = {}) {
  return new Promise((resolve) => {
    const dlg = openDialog(`
      <form class="numform">
        <h3>${esc(title)}</h3>
        ${opts.hint ? `<p class="hint">${esc(opts.hint)}</p>` : ''}
        <input id="num-input" type="number" value="${def}" ${opts.min !== undefined ? `min="${opts.min}"` : ''} step="1" autofocus>
        <div class="btns"><button type="submit" class="primary">OK</button><button type="button" data-close>Cancel</button></div>
      </form>`, { small: true, onClose: () => resolve(null) });
    const input = $('#num-input', dlg);
    input.select();
    $('form', dlg).addEventListener('submit', (e) => {
      e.preventDefault();
      const v = parseInt(input.value, 10);
      closeDialog(true);
      resolve(Number.isFinite(v) ? v : null);
    });
  });
}

// ------------------------------------------------------------ dialogs
let dialogClose = null;
export function openDialog(html, opts = {}) {
  closeDialog();
  const wrap = $('#dialog');
  wrap.innerHTML = `<div class="dlg ${opts.wide ? 'wide' : ''} ${opts.small ? 'small' : ''}" role="dialog" aria-modal="true">${opts.noClose ? '' : '<button class="dlg-x" data-close aria-label="Close">×</button>'}${html}</div>`;
  wrap.hidden = false;
  dialogClose = opts.onClose || null;
  wrap.dataset.noclose = opts.noClose ? '1' : '';
  return $('.dlg', wrap);
}
export function closeDialog(silent) {
  const wrap = $('#dialog');
  if (wrap.hidden) return;
  wrap.hidden = true;
  wrap.innerHTML = '';
  const cb = dialogClose;
  dialogClose = null;
  if (cb && !silent) cb();
}
const dialogOpen = () => !$('#dialog').hidden;

function zoneViewer(pid, zone, opts = {}) {
  const ids = opts.ids || [...zoneOf(pid, zone)].reverse(); // top first
  const title = opts.title || `${pid === 'p' ? 'Your' : "AI's"} ${zone}`;
  const dlg = openDialog(`
    <h3>${esc(title)} <small>${ids.length} card${ids.length === 1 ? '' : 's'}</small></h3>
    ${opts.filter !== false && ids.length > 8 ? '<input class="filter" id="zv-filter" placeholder="Filter by name or type…" autocomplete="off">' : ''}
    <div class="zv-grid">${ids.map((i) => `<div class="zv-item" data-iid="${i}">${cardHTML(card(i), { small: true })}<span>${esc(cardName(card(i)))}</span></div>`).join('') || '<p class="hint">Empty.</p>'}</div>
    ${opts.footer || ''}`, { wide: true });
  const f = $('#zv-filter', dlg);
  if (f) {
    f.focus();
    f.addEventListener('input', () => {
      const q = f.value.toLowerCase();
      $$('.zv-item', dlg).forEach((el) => {
        const c = card(el.dataset.iid);
        el.hidden = q && !(cardName(c) + ' ' + face(c).typeLine).toLowerCase().includes(q);
      });
    });
  }
  dlg.dataset.viewer = opts.ids ? `${pid}:static` : `${pid}:${zone}`;
  dlg._view = { pid, zone, opts };
  return dlg;
}

function refreshViewer() {
  const dlg = $('#dialog .dlg');
  if (!dlg || !dlg.dataset.viewer) return;
  const [pid, zone] = dlg.dataset.viewer.split(':');
  if (zone === 'library-search') return searchLibrary();
  if (zone === 'static') {
    const v = dlg._view;
    const ids = v.opts.ids.filter((i) => card(i) && card(i).zone === v.zone && card(i).owner === v.pid);
    return zoneViewer(v.pid, v.zone, { ...v.opts, ids });
  }
  zoneViewer(pid, zone);
}

function searchLibrary() {
  const dlg = zoneViewer('p', 'library', {
    title: 'Search your library',
    ids: [...zoneOf('p', 'library')].sort((a, b) => cardName(card(a)).localeCompare(cardName(card(b)))),
    footer: '<div class="btns"><button class="primary" data-act="shuffle-close">Shuffle and close</button></div>',
  });
  dlg.dataset.viewer = 'p:library-search';
}

function scryDialog(n, mode = 'scry', inEffect = false, who = 'p') {
  return new Promise((resolve) => {
  const ids = libTop(who, n);
  if (!ids.length) return resolve();
  const state = ids.map((iid) => ({ iid, dest: 'top' }));
  const draw_ = () => {
    const dlg = openDialog(`
      <h3>${mode === 'surveil' ? 'Surveil' : 'Scry'} ${ids.length}</h3>
      <p class="hint">First card listed ends up on top. Choose where each card goes.</p>
      <div class="scry-list">${state
        .map((st, k) => `<div class="scry-row" data-k="${k}">
          <div class="scry-card">${cardHTML(card(st.iid), { small: true })}</div>
          <div class="scry-name">${esc(cardName(card(st.iid)))}</div>
          <div class="seg">${(mode === 'surveil' ? ['top', 'graveyard'] : ['top', 'bottom'])
            .map((d) => `<button class="${st.dest === d ? 'on' : ''}" data-dest="${d}">${d === 'top' ? 'Top' : d === 'bottom' ? 'Bottom' : 'Graveyard'}</button>`)
            .join('')}</div>
          <div class="seg arrows"><button data-move="-1" aria-label="Move up">↑</button><button data-move="1" aria-label="Move down">↓</button></div>
        </div>`)
        .join('')}</div>
      <div class="btns"><button class="primary" id="scry-done">Done</button></div>`, { wide: true, noClose: inEffect });
    $$('.scry-row', dlg).forEach((row) => {
      const k = +row.dataset.k;
      row.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.dest) state[k].dest = b.dataset.dest;
        if (b.dataset.move) {
          const j = k + +b.dataset.move;
          if (j >= 0 && j < state.length) [state[k], state[j]] = [state[j], state[k]];
        }
        draw_();
      });
    });
    $('#scry-done', dlg).addEventListener('click', () => {
      (inEffect ? (fn) => { fn(); render(); } : act)(() => {
        const tops = state.filter((x) => x.dest === 'top').map((x) => x.iid);
        const bottoms = state.filter((x) => x.dest === 'bottom').map((x) => x.iid);
        const gys = state.filter((x) => x.dest === 'graveyard').map((x) => x.iid);
        // remove all, then rebuild order: last pushed = top
        for (const iid of [...tops].reverse()) move(iid, 'library');
        for (const iid of bottoms) move(iid, 'library', { to: 'bottom' });
        for (const iid of gys) move(iid, 'graveyard');
        log(who, `${who === 'p' ? 'You' : 'The AI (you choose)'} ${mode} ${state.length}: ${tops.length} on top${mode === 'surveil' ? '' : `, ${bottoms.length} on the bottom`}${gys.length ? `, ${gys.length} to the graveyard` : ''}.`);
      });
      closeDialog(true);
      resolve();
    });
  };
  draw_();
  });
}

async function tokenDialog() {
  const deckTokens = [
    ...new Set(
      Object.values(G.s.cards)
        .filter((c) => c.owner === 'p')
        .flatMap((c) => DB[c.def].tokens)
        .filter((id) => DB[id])
    ),
  ];
  const quick = ['Treasure', 'Clue', 'Food', 'Soldier', 'Zombie', 'Goblin', 'Saproling', 'Spirit', 'Beast', 'Elf Warrior', 'Thopter', 'Human'];
  const dlg = openDialog(`
    <h3>Create a token</h3>
    <form id="tok-form" class="tok-search"><input id="tok-q" placeholder="Search tokens, e.g. “3/3 beast” or “treasure”" autocomplete="off">
      <label class="tok-count">Count <input id="tok-n" type="number" min="1" value="1"></label>
      <button class="primary" type="submit">Search</button></form>
    <div class="chips">${quick.map((q) => `<button class="chip" data-q="${q}">${q}</button>`).join('')}</div>
    ${deckTokens.length ? `<h4>From your deck</h4><div class="zv-grid" id="tok-deck">${deckTokens.map((id) => tokenTile(id)).join('')}</div>` : ''}
    <h4 id="tok-res-h" hidden>Results</h4><div class="zv-grid" id="tok-res"></div>
    <h4>Quick blank token</h4>
    <form id="tok-blank" class="tok-search"><input id="tok-bname" placeholder="Name" value="Creature">
      <input id="tok-bp" type="number" value="1" aria-label="Power" class="pt-in"> / <input id="tok-bt" type="number" value="1" aria-label="Toughness" class="pt-in">
      <button type="submit">Create</button></form>`, { wide: true });
  const run_ = async (q) => {
    $('#tok-res', dlg).innerHTML = '<p class="hint">Searching Scryfall…</p>';
    $('#tok-res-h', dlg).hidden = false;
    try {
      const res = await searchTokens(q);
      $('#tok-res', dlg).innerHTML = res.map((d) => tokenTile(d.id)).join('') || '<p class="hint">No tokens found.</p>';
    } catch (e) {
      $('#tok-res', dlg).innerHTML = `<p class="hint err">${esc(e.message)}</p>`;
    }
  };
  $('#tok-form', dlg).addEventListener('submit', (e) => {
    e.preventDefault();
    run_($('#tok-q', dlg).value);
  });
  dlg.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) {
      $('#tok-q', dlg).value = chip.dataset.q;
      run_(chip.dataset.q);
    }
    const t = e.target.closest('.tok-tile');
    if (t) {
      const n = Math.max(1, parseInt($('#tok-n', dlg).value, 10) || 1);
      act(() => {
        createToken(t.dataset.def, 'p', n);
        log('p', `You create ${n} ${esc(DB[t.dataset.def].name)} token${n > 1 ? 's' : ''}.`);
      });
      toast(`Created ${n} ${DB[t.dataset.def].name}`);
    }
  });
  $('#tok-blank', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = genericTokenDef($('#tok-bp', dlg).value, $('#tok-bt', dlg).value, $('#tok-bname', dlg).value || 'Token');
    const n = Math.max(1, parseInt($('#tok-n', dlg).value, 10) || 1);
    act(() => {
      createToken(id, 'p', n);
      log('p', `You create ${n} ${esc(DB[id].name)} token${n > 1 ? 's' : ''}.`);
    });
    toast(`Created ${n} ${DB[id].name}`);
  });
  $('#tok-q', dlg).focus();
}

function tokenTile(id) {
  const d = DB[id];
  const f = d.faces[0];
  return `<button class="tok-tile" data-def="${id}" title="${esc(d.name)} — ${esc(f.typeLine)}">
    ${f.img ? `<img src="${f.img}" alt="" loading="lazy">` : `<div class="tok-blank">${esc(d.name)}</div>`}
    <span>${esc(d.name)}${f.power !== undefined && f.power !== null ? ` ${esc(f.power)}/${esc(f.toughness)}` : ''}</span></button>`;
}

export function helpDialog() {
  const rows = [
    ['Enter / Space', 'Next step · confirm attacks, blocks, “let it resolve”'],
    ['Shift + Enter', 'Pass the turn'],
    ['D', 'Draw a card'],
    ['U', 'Untap all your permanents'],
    ['S', 'Shuffle your library'],
    ['C', 'Create a token'],
    ['L', 'Search your library'],
    ['Ctrl/⌘ + Z', 'Undo (Shift for redo)'],
    ['Hover + T', 'Tap / untap the hovered card'],
    ['Hover + G / X / H', 'Send hovered card to graveyard / exile / hand'],
    ['Hover + B', 'Put hovered card on the bottom of your library'],
    ['Hover + F', 'Flip (double-faced) / turn face up'],
    ['Hover + = / −', 'Add / remove a +1/+1 counter'],
    ['Double-click', 'Cast a card from your hand or command zone (pays mana, asks for targets)'],
    ['Esc', 'Cancel the spell you are casting'],
    ['Right-click', 'Card and pile menus'],
    ['?', 'This list'],
  ];
  openDialog(`<h3>Shortcuts</h3><table class="keys">${rows.map(([k, v]) => `<tr><td><kbd>${k}</kbd></td><td>${v}</td></tr>`).join('')}</table>
  <p class="hint">Mouse: click a library to draw, click a graveyard or exile to browse it, click a card on your battlefield to tap it. During combat, clicks pick attackers and blockers instead.</p>`);
}

// ------------------------------------------------------------ context menu
function openMenu(x, y, items) {
  for (const d of [document, ...popDocs()]) if (d !== menuDoc && d.querySelector('#menu')) d.querySelector('#menu').hidden = true;
  const m = menuDoc.querySelector('#menu') || document.querySelector('#menu');
  const window = m.ownerDocument.defaultView;
  m.innerHTML = items
    .map((it) => {
      if (it === '-') return '<hr>';
      if (it.head) return `<div class="mhead">${it.head}</div>`;
      return `<button data-k="${items.indexOf(it)}" ${it.disabled ? 'disabled' : ''}>${it.label}${it.key ? `<kbd>${it.key}</kbd>` : ''}</button>`;
    })
    .join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  m.onclick = (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    closeMenu();
    items[+b.dataset.k].fn();
  };
}
function closeMenu() {
  $$('#menu').forEach((m) => (m.hidden = true));
}

function counterItems(c) {
  const add = (k, d) => () => act(() => {
    c.counters[k] = Math.max(0, (c.counters[k] || 0) + d);
    if (!c.counters[k]) delete c.counters[k];
  });
  const items = [
    { label: 'Add +1/+1 counter', key: '=', fn: add('+1/+1', 1) },
    { label: 'Remove +1/+1 counter', key: '−', fn: add('+1/+1', -1), disabled: !c.counters['+1/+1'] },
    { label: 'Add −1/−1 counter', fn: add('-1/-1', 1) },
  ];
  if (c.counters['-1/-1']) items.push({ label: 'Remove −1/−1 counter', fn: add('-1/-1', -1) });
  if (isType(c, 'Planeswalker') || c.counters.loyalty !== undefined) {
    items.push({ label: 'Loyalty +1', fn: add('loyalty', 1) }, { label: 'Loyalty −1', fn: add('loyalty', -1) });
  }
  items.push({
    label: 'Other counter…',
    fn: async () => {
      const dlg = openDialog(`<form class="numform"><h3>Add counters</h3>
        <input id="ctr-name" placeholder="Counter name (charge, time, oil…)" value="charge" autocomplete="off">
        <input id="ctr-n" type="number" value="1">
        <div class="btns"><button class="primary" type="submit">Add</button><button type="button" data-close>Cancel</button></div></form>`, { small: true });
      $('#ctr-name', dlg).select();
      $('form', dlg).addEventListener('submit', (e) => {
        e.preventDefault();
        const k = $('#ctr-name', dlg).value.trim() || 'counter';
        const n = parseInt($('#ctr-n', dlg).value, 10) || 0;
        closeDialog(true);
        add(k, n)();
      });
    },
  });
  return items;
}

function menuForCard(c, x, y) {
  const mine = isMine(c);
  const items = [];
  const d = DB[c.def];
  items.push({ head: esc(cardName(c)) });
  if (c.zone === 'battlefield' && mine) {
    if (G.settings.arenaMode && !c.faceDown) {
      const abs = activatedAbilities(c);
      for (const ab of abs) {
        const short = cardName(c).split(',')[0];
        const label = (ab.kind === 'loyalty' ? `${ab.label}: ${ab.text}`
          : ab.kind === 'equip' ? `Equip ${ab.mana}` : ab.kind === 'reconfigure' ? `Reconfigure ${ab.mana}`
          : ab.kind === 'crew' ? `Crew ${ab.n}` : ab.kind === 'saddle' ? `Saddle ${ab.n}` : ab.kind === 'station' ? 'Station (tap a creature)'
          : ab.kind === 'craft' ? `Craft ${ab.mana} (exile ${ab.more ? ab.min + '+' : ab.min} ${ab.filter}s)` : ab.kind === 'levelup' ? `Level up ${ab.mana}` : ab.kind === 'classlevel' ? `${ab.mana}: Level ${ab.level}`
          : `${ab.costText}: ${ab.text}`).replace(/~/g, short);
        items.push({ label: `<span class="ab">${esc(label.length > 70 ? label.slice(0, 68) + '…' : label)}</span>`, fn: () => activate(c, ab) });
      }
      if (abs.length) items.push('-');
    }
    items.push({ label: c.tapped ? 'Untap' : 'Tap', key: 'T', fn: () => toggleTap(c.iid) });
    if (d.doubleFaced || d.faces.length > 1) items.push({ label: 'Transform / flip', key: 'F', fn: () => act(() => (c.face = c.face ? 0 : 1)) });
    if (c.faceDown && G.settings.arenaMode && /(?:^|\n)(?:Morph|Megamorph|Disguise) \{/.test(oracle({ ...c, faceDown: false }))) {
      const m = oracle({ ...c, faceDown: false }).match(/(?:^|\n)(Morph|Megamorph|Disguise) ((?:\{[^}]+\})+)/);
      items.push({ label: `Turn face up — ${m[1]} ${manaSymbols(m[2])}`, fn: () => specialAction((env) => turnFaceUp('p', c, env)) });
    }
    if (c.faceDown && G.settings.arenaMode && c.manifested && /Creature/.test(DB[c.def].faces[0].typeLine))
      items.push({ label: `Turn face up — pay ${manaSymbols(DB[c.def].faces[0].manaCost)}`, fn: () => specialAction((env) => turnFaceUp('p', c, env)) });
    items.push({ label: c.faceDown ? 'Turn face up (free)' : 'Turn face down', fn: () => act(() => (c.faceDown = !c.faceDown)) });
    if (isCreature(c) && sculptors().length)
      for (const sec of SECTORS) if (c.sector !== sec) items.push({ label: `Move to ${SECTOR_SIGN[sec]} ${sec} sector`, fn: () => act(() => (c.sector = sec)) });
    items.push('-', ...counterItems(c));
    if (isCreature(c)) {
      items.push({
        label: 'Set P/T modifier…',
        fn: async () => {
          const p = await askNumber('Power modifier (e.g. 2 or −1)', c.ptMod ? c.ptMod.p : 0);
          if (p === null) return;
          const t = await askNumber('Toughness modifier', c.ptMod ? c.ptMod.t : 0);
          if (t === null) return;
          act(() => (c.ptMod = p || t ? { p, t } : null));
        },
      });
    }
    items.push({
      label: 'Create a token copy',
      fn: () => act(() => {
        const [t] = createToken(c.def, 'p', 1);
        card(t).face = c.face || 0;
        log('p', `You create a token copy of ${nameTag(c)}.`);
      }),
    });
    if (isLegendary(c))
      items.push({
        label: "Create a token copy that isn't legendary",
        fn: () => act(() => {
          const [t] = createToken(c.def, 'p', 1);
          Object.assign(card(t), { face: c.face || 0, notLegendary: true });
          log('p', `You create a non-legendary token copy of ${nameTag(c)}.`);
        }),
      });
    if (G.s.combat && G.s.combat.by === 'p' && G.s.combat.stage === 'declare' && isCreature(c))
      items.push({ label: G.s.combat.attackers.includes(c.iid) ? 'Remove from attack' : 'Attack with this', fn: () => toggleAttacker(c.iid) });
    items.push('-');
  }
  if ((mine || c.mayPlay === 'p' || c.mayPlayFree === 'p' || c.mayCastFromGy === 'p') && ['hand', 'command', 'graveyard', 'exile'].includes(c.zone) && G.settings.arenaMode) {
    const lands = c.zone === 'hand' || (c.zone === 'exile' && c.mayPlay === 'p' && !c.castOnly && (c.mayPlayUntil || 0) >= G.s.turn && (!c.myTurnOnly || G.s.active === 'p')) ? landOptions('p', c) : [];
    for (const l of lands) items.push({ label: esc(l.label), fn: () => castByPlayer(c.iid, { option: { ...l, land: true } }) });
    for (const o of castOptions('p', c)) items.push({ label: `${esc(o.label)}${o.cost && !/\{/.test(o.label) ? ' ' + manaSymbols(o.cost) : ''}`, fn: () => castByPlayer(c.iid, { option: o }) });
    for (const ab of zoneAbilities(c)) items.push({ label: `<span class="ab">${esc(ab.label)}</span>`, fn: () => zoneAbility(c, ab) });
    if (c.zone === 'command' && c.isCompanion) items.push({ label: 'Put companion into your hand ({3})', fn: () => specialAction((env) => companionToHand('p', c, env)) });
    if (items.length > 1) items.push('-');
  }
  if (c.zone === 'hand' && mine) {
    if (!G.settings.arenaMode) items.push({ label: isLand(c) ? 'Play land' : isPermanentCard(d) ? 'Cast' : 'Cast (to graveyard)', fn: () => castByPlayer(c.iid) });
    if (G.settings.arenaMode && !isLand(c))
      items.push({ label: isPermanentCard(d) ? 'Put onto battlefield (no cost, no effects)' : 'Cast without effects (to graveyard)', fn: () => playFromHand(c.iid, { free: true }) });
    if (isPermanentCard(d)) items.push({ label: 'Put onto battlefield tapped', fn: () => playFromHand(c.iid, { tapped: true }) });
    items.push({ label: 'Put onto battlefield face down', fn: () => playFromHand(c.iid, { faceDown: true }) });
    items.push({ label: 'Reveal to the log', fn: () => act(() => log('p', `You reveal ${nameTag(c)}.`)) });
    items.push('-');
  }
  if (c.zone === 'command' && mine) {
    if (!G.settings.arenaMode && c.isCommander) items.push({ label: `Cast commander (tax +${commanderTax('p', c.iid)})`, fn: () => castByPlayer(c.iid) });
    if (G.settings.arenaMode) items.push({ label: 'Put onto battlefield (no cost)', fn: () => playFromHand(c.iid, { free: true }) });
    items.push('-');
  }
  if (mine) {
    const z = c.zone;
    if (z !== 'hand') items.push({ label: 'To hand', key: 'H', fn: () => sendTo(c.iid, 'hand') });
    if (z !== 'battlefield' && z !== 'hand' && z !== 'command')
      items.push({ label: 'Onto battlefield', fn: () => act(() => { toBattlefield(c.iid, 'p'); log('p', `${nameTag(c)} enters the battlefield.`); }) });
    if (z !== 'graveyard') items.push({ label: z === 'hand' ? 'Discard' : 'To graveyard', key: 'G', fn: () => sendTo(c.iid, 'graveyard') });
    if (z !== 'exile') items.push({ label: 'Exile', key: 'X', fn: () => sendTo(c.iid, 'exile') });
    items.push({ label: 'Top of library', fn: () => sendTo(c.iid, 'library') });
    items.push({ label: 'Bottom of library', key: 'B', fn: () => sendTo(c.iid, 'library', { to: 'bottom' }) });
    if (c.isCommander && z !== 'command') items.push({ label: 'Command zone', fn: () => sendTo(c.iid, 'command') });
  } else if (c.zone === 'battlefield') {
    // Your spells and effects against the AI's permanents
    items.push({ head: 'Apply your effect' });
    items.push({ label: 'Destroy', fn: () => kill(c, 'graveyard', 'destroy') });
    items.push({ label: 'Exile', fn: () => kill(c, 'exile', 'exile') });
    items.push({ label: "Return to owner's hand", fn: () => kill(c, 'hand', 'bounce') });
    items.push({ label: 'Put on top of its library', fn: () => kill(c, 'library', 'tuck') });
    items.push({ label: 'Put on bottom of its library', fn: () => kill(c, 'library', 'tuck', { to: 'bottom' }) });
    if (isCreature(c)) {
      items.push({
        label: 'Deal damage…',
        fn: async () => {
          const n = await askNumber(`Damage to ${cardName(c)}`, 3, { min: 0 });
          if (n) act(() => {
            c.damage += n;
            log('p', `You deal ${n} damage to ${nameTag(c)}.`);
          });
        },
      });
    }
    items.push({ label: c.tapped ? 'Untap' : 'Tap', fn: () => toggleTap(c.iid) });
    items.push(...counterItems(c));
    items.push({
      label: 'Gain control',
      fn: () => act(() => {
        move(c.iid, 'battlefield', { controller: 'p', ...freeSpot(c) });
        log('p', `You gain control of ${nameTag(c)}.`);
      }),
    });
  } else {
    // AI graveyard/exile cards
    items.push({ label: 'Exile it', fn: () => sendTo(c.iid, 'exile') });
    items.push({
      label: 'Put onto battlefield under your control',
      fn: () => act(() => {
        toBattlefield(c.iid, 'p');
        card(c.iid).controller = 'p';
        log('p', `You put ${nameTag(c)} onto the battlefield under your control.`);
      }),
    });
  }
  openMenu(x, y, items);
}

function kill(c, zone, verb, opts = {}) {
  act(() => {
    const nm = nameTag(c);
    if (verb === 'destroy' && hasKw(c, 'indestructible')) {
      log('p', `${nm} is indestructible.`);
      return;
    }
    move(c.iid, zone, opts);
    log('p', `You ${verb === 'bounce' ? 'return' : verb === 'tuck' ? 'tuck' : verb} the AI's ${nm}${verb === 'bounce' ? ' to its hand' : ''}.`);
  });
}

function menuForPile(pid, zone, x, y) {
  if (pid !== 'p') {
    return openMenu(x, y, [
      { head: `AI ${zone}` },
      { label: 'View', fn: () => zoneViewer(pid, zone) },
      ...(zone === 'library'
        ? [{ label: 'Mill (your effect)…', fn: async () => { const n = await askNumber('Mill how many?', 3, { min: 1 }); if (n) act(() => mill('ai', n)); } }]
        : []),
    ]);
  }
  if (zone === 'library') {
    return openMenu(x, y, [
      { head: 'Library' },
      { label: 'Draw', key: 'D', fn: () => act(() => draw('p', 1)) },
      { label: 'Draw X…', fn: async () => { const n = await askNumber('Draw how many?', 2, { min: 1 }); if (n) act(() => draw('p', n)); } },
      { label: 'Shuffle', key: 'S', fn: () => act(() => { shuffle('p'); log('p', 'You shuffle your library.'); }) },
      { label: 'Scry X…', fn: async () => { const n = await askNumber('Scry how many?', 1, { min: 1 }); if (n) scryDialog(n); } },
      { label: 'Surveil X…', fn: async () => { const n = await askNumber('Surveil how many?', 1, { min: 1 }); if (n) scryDialog(n, 'surveil'); } },
      { label: 'Mill X…', fn: async () => { const n = await askNumber('Mill how many?', 1, { min: 1 }); if (n) act(() => mill('p', n)); } },
      { label: 'Look at top X…', fn: async () => { const n = await askNumber('Look at how many?', 3, { min: 1 }); if (n) zoneViewer('p', 'library', { ids: libTop('p', n), title: `Top ${n} of your library` }); } },
      { label: 'Exile top card', fn: () => { const t = libTop('p', 1)[0]; if (t) sendTo(t, 'exile'); } },
      { label: 'Exile top card face down', fn: () => { const t = libTop('p', 1)[0]; if (t) act(() => { move(t, 'exile', { faceDown: true }); log('p', 'You exile the top card of your library face down.'); }); } },
      { label: 'Reveal top card', fn: () => { const t = libTop('p', 1)[0]; if (t) act(() => log('p', `You reveal ${nameTag(card(t))} from the top of your library.`)); } },
      { label: 'Search library', key: 'L', fn: searchLibrary },
    ]);
  }
  if (zone === 'graveyard' || zone === 'exile') {
    return openMenu(x, y, [
      { head: zone === 'graveyard' ? 'Graveyard' : 'Exile' },
      { label: 'View', fn: () => zoneViewer('p', zone) },
      ...(zone === 'graveyard'
        ? [{ label: 'Exile entire graveyard', fn: () => act(() => { [...zoneOf('p', 'graveyard')].forEach((i) => move(i, 'exile')); log('p', 'You exile your graveyard.'); }) },
           { label: 'Shuffle graveyard into library', fn: () => act(() => { [...zoneOf('p', 'graveyard')].forEach((i) => move(i, 'library')); shuffle('p'); log('p', 'You shuffle your graveyard into your library.'); }) }]
        : []),
    ]);
  }
}

// ------------------------------------------------------------ drag and drop
let drag = null;

function dropStale() {
  if (drag) {
    const d = drag;
    drag = null;
    if (d.el) {
      d.el.classList.remove('dragging');
      d.el.ownerDocument.body.classList.remove('is-dragging');
    }
  }
  for (const doc of [document, ...[...popouts.values()].map((p) => p && p.doc).filter(Boolean)]) doc.querySelectorAll('.card.ghost').forEach((g) => g.remove());
  $$('.drop-hot').forEach((x) => x.classList.remove('drop-hot'));
}

function onPointerDown(e) {
  if (drag) dropStale();
  if (e.button !== 0 || pendingTarget) return;
  const el = e.target.closest('.card[data-iid]');
  if (!el || el.closest('#dialog') || el.closest('#banner')) return;
  const c = card(el.dataset.iid);
  if (!c || !isMine(c)) return;
  if (!['battlefield', 'hand', 'command'].includes(c.zone)) return;
  if (el.closest('.pile-face') && !el.closest('.cz-slot')) return;
  const r = el.getBoundingClientRect();
  drag = { iid: c.iid, el, sx: e.clientX, sy: e.clientY, ox: Math.min(e.clientX - r.left, CARD_W / 2), oy: Math.min(e.clientY - r.top, CARD_H / 2), moved: false };
}

function onPointerMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  if (!drag.moved) {
    drag.moved = true;
    const ghost = drag.el.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.classList.remove('tapped');
    ghost.style.left = ghost.style.top = '';
    drag.el.ownerDocument.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.el.classList.add('dragging');
    drag.el.ownerDocument.body.classList.add('is-dragging');
  }
  drag.ghost.style.transform = `translate(${e.clientX - drag.ox}px, ${e.clientY - drag.oy}px)`;
  const tgt = dropTarget(e.clientX, e.clientY);
  $$('.drop-hot').forEach((x) => x !== tgt && x.classList.remove('drop-hot'));
  if (tgt) tgt.classList.add('drop-hot');
}

function dropTarget(x, y) {
  if (drag && drag.ghost) drag.ghost.style.display = 'none';
  const el = ((drag && drag.el && drag.el.ownerDocument) || document).elementFromPoint(x, y);
  if (drag && drag.ghost) drag.ghost.style.display = '';
  return el ? el.closest('[data-drop]') : null;
}

function onPointerUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  d.el.ownerDocument.body.classList.remove('is-dragging');
  if (!d.moved) {
    d.el.classList.remove('dragging');
    return onCardClick(d.iid, e);
  }
  d.ghost.remove();
  d.el.classList.remove('dragging');
  $$('.drop-hot').forEach((x) => x.classList.remove('drop-hot'));
  const tgt = dropTarget(e.clientX, e.clientY);
  if (!tgt) return render();
  const zone = tgt.dataset.drop;
  const c = card(d.iid);
  if (zone === 'battlefield') {
    const field = $('#my-field');
    const fr = field.getBoundingClientRect();
    const x = Math.max(18, Math.min(fr.width - CARD_W - 18, e.clientX - d.ox - fr.left + field.scrollLeft));
    const y = Math.max(0, e.clientY - d.oy - fr.top + field.scrollTop);
    if (c.zone === 'battlefield') {
      if (G.settings.boardLayout !== 'free') return render();
      act(() => {
        c.x = Math.round(x);
        c.y = Math.round(y);
      });
    } else castByPlayer(d.iid, { pos: { x: Math.round(x), y: Math.round(y) } });
    return;
  }
  if (zone === c.zone && zone !== 'library') return render();
  if (zone === 'library') return sendTo(d.iid, 'library', e.shiftKey ? { to: 'bottom' } : {});
  if (zone === 'command' && !c.isCommander) {
    toast('Only commanders go to the command zone.');
    return render();
  }
  sendTo(d.iid, zone);
}

function onCardClick(iid, e) {
  const c = card(iid);
  const s = G.s;
  if (c.zone === 'battlefield') {
    if (s.combat && s.combat.by === 'p' && s.combat.stage === 'declare' && isCreature(c)) return toggleAttacker(iid);
    if (s.combat && s.combat.by === 'ai' && pendingBlocks) return blockClick(c);
    return toggleTap(iid);
  }
  if (c.zone === 'library') return act(() => draw('p', 1));
  void e;
}

function blockClick(c) {
  const cb = G.s.combat;
  if (c.controller === 'p') {
    if (!isCreature(c) || c.tapped) return toast('Pick an untapped creature to block with.');
    // clicking an assigned blocker removes it
    for (const k of Object.keys(cb.blocks)) {
      if (cb.blocks[k].includes(c.iid)) {
        cb.blocks[k] = cb.blocks[k].filter((b) => b !== c.iid);
        cb.selected = null;
        return render();
      }
    }
    cb.selected = cb.selected === c.iid ? null : c.iid;
    return render();
  }
  if (cb.attackers.includes(c.iid)) {
    if (!cb.selected) return toast('First click one of your creatures, then this attacker.');
    const b = card(cb.selected);
    if (!canBlock(b, c)) {
      toast(`${cardName(b)} can't block ${cardName(c)}.`);
      return;
    }
    cb.blocks[c.iid] = [...(cb.blocks[c.iid] || []), cb.selected];
    cb.selected = null;
    render();
  }
}

function confirmBlocks() {
  const cb = G.s.combat;
  for (const [a, bs] of Object.entries(cb.blocks)) {
    if (bs.length === 1 && hasKw(card(a), 'menace')) {
      toast(`${cardName(card(a))} has menace — it needs two or more blockers.`);
      return;
    }
  }
  cb.selected = null;
  const r = pendingBlocks;
  pendingBlocks = null;
  if (r) r();
}

// ------------------------------------------------------------ events
export function bindEvents() {
  bindDoc = (document) => {
  // While choosing a target, clicks pick targets and nothing else.
  document.addEventListener(
    'click',
    (e) => {
      if (!pendingTarget) return;
      const b = e.target.closest('button');
      if (b && b.dataset.tgtPlayer) {
        e.stopPropagation();
        return finishTarget({ player: b.dataset.tgtPlayer });
      }
      if (b && b.dataset.act === 'tgt-skip') {
        e.stopPropagation();
        return finishTarget(null);
      }
      if (b && b.dataset.act === 'tgt-cancel') {
        e.stopPropagation();
        return cancelTarget();
      }
      const el = e.target.closest('.card[data-iid]');
      if (el && pendingTarget.req.candidates.includes(el.dataset.iid)) {
        e.stopPropagation();
        return finishTarget({ iid: el.dataset.iid });
      }
      const lifePanel = e.target.closest('#opp-panel .life, #my-panel .life');
      const players = pendingTarget.req.players || [];
      if (lifePanel) {
        const pid = lifePanel.closest('#opp-panel') ? 'ai' : 'p';
        if (players.includes(pid)) {
          e.stopPropagation();
          return finishTarget({ player: pid });
        }
      }
      if (!e.target.closest('#banner')) e.stopPropagation();
    },
    true
  );
  document.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  // never leave a drag ghost behind: the pointer can be released over a dialog, outside the window, or the drag cancelled
  window.addEventListener('pointerup', () => setTimeout(dropStale, 0), true);
  document.addEventListener('pointercancel', dropStale);
  window.addEventListener('blur', dropStale);

  document.addEventListener('click', (e) => {
    const dm = e.target.closest('.dg-map:not(.done)');
    if (dm && G.s) return dungeonDialog(dm.dataset.dungeon);
    const b = e.target.closest("[data-cmdzone]");
    if (!b || !G.s) return;
    const c = card(b.dataset.iid);
    if (!c || !c.cmdAsk) return;
    if (b.dataset.cmdzone === "yes") act(() => { move(c.iid, 'command', { noCommandZone: true }); log('p', `${nameTag(c)} returns to the command zone.`); });
    else act(() => { delete c.cmdAsk; });
  });

  document.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.card[data-iid]');
    if (!el || el.closest('#dialog')) return;
    const c = card(el.dataset.iid);
    if (c && isMine(c) && (c.zone === 'hand' || c.zone === 'command')) castByPlayer(c.iid);
    else if (c && c.owner === 'ai' && c.zone === 'hand' && handControl('p', 'ai')) castByPlayer(c.iid);
    else if (c && c.zone === 'exile' && el.closest('.exile-ready') && (c.owner === 'p' || c.mayPlay === 'p' || c.mayPlayFree === 'p')) castByPlayer(c.iid);
  });

  document.addEventListener('contextmenu', (e) => {
    if (!G.s || e.target.closest('input, textarea')) return;
    menuDoc = e.target.ownerDocument;
    const cardEl = e.target.closest('.card[data-iid]');
    const pileEl = e.target.closest('[data-pile]');
    if (cardEl && (!cardEl.closest('.pile-face') || cardEl.closest('.cz-slot'))) {
      e.preventDefault();
      const c = card(cardEl.dataset.iid);
      if (c) menuForCard(c, e.clientX, e.clientY);
      return;
    }
    if (pileEl) {
      e.preventDefault();
      const [pid, zone] = pileEl.dataset.pile.split(':');
      if (zone === 'command') return;
      menuForPile(pid, zone, e.clientX, e.clientY);
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu')) closeMenu();
    menuDoc = e.target.ownerDocument;
    const t = e.target;
    // blocking: after picking your creature, click the AI's attacker it blocks
    const oppCard = t.closest('#opp-field .card[data-iid]');
    if (oppCard && G.s && G.s.combat && G.s.combat.by === 'ai' && pendingBlocks) {
      const c = card(oppCard.dataset.iid);
      if (c) return blockClick(c);
    }
    if (t.closest('[data-close]') || (t.id === 'dialog' && !t.dataset.noclose)) return closeDialog();
    const zv = t.closest('.zv-item');
    if (zv) {
      const c = card(zv.dataset.iid);
      if (c) menuForCard(c, e.clientX, e.clientY);
      e.stopPropagation();
      return;
    }
    const pileEl = t.closest('[data-pile]');
    if (pileEl && !t.closest('.cz-slot .card')) {
      const [pid, zone] = pileEl.dataset.pile.split(':');
      if (zone === 'library' && pid === 'p') return act(() => draw('p', 1));
      if (zone === 'command') return;
      return zoneViewer(pid, zone);
    }
    const b = t.closest('button');
    if (!b) return;
    if (b.dataset.dungeon) return dungeonDialog(b.dataset.dungeon);
    if (b.dataset.life) {
      const [pid, d] = b.dataset.life.split(':');
      const delta = +d * (e.shiftKey ? 5 : 1);
      return act(() => setLife(pid, G.s.players[pid].life + delta, false));
    }
    if (b.dataset.setlife) {
      const pid = b.dataset.setlife;
      return askNumber(`Set ${pid === 'p' ? 'your' : "the AI's"} life`, G.s.players[pid].life).then((v) => {
        if (v !== null) act(() => setLife(pid, v));
      });
    }
    if (b.dataset.poison) {
      const [pid, d] = b.dataset.poison.split(':');
      return act(() => {
        const pl = G.s.players[pid];
        pl.poison = Math.max(0, pl.poison + +d);
        checkLoss(pid);
      });
    }
    if (b.dataset.cmd) {
      const [pid, iid, d] = b.dataset.cmd.split(':');
      return act(() => {
        const pl = G.s.players[pid];
        pl.cmdDmg[iid] = Math.max(0, (pl.cmdDmg[iid] || 0) + +d);
        checkLoss(pid);
      });
    }
    const a = b.dataset.act;
    if (!a) return;
    if (a === 'popout') return popOut(b.dataset.pid);
    if (a === 'popin') return popIn(b.dataset.pid);
    if (a === 'resolve' || a === 'counter') {
      const r = pendingRespond;
      pendingRespond = null;
      if (r) r(a);
      return;
    }
    if (a === 'attack') return confirmAttacks();
    if (a === 'all-attack') {
      const cb = G.s.combat;
      for (const c of cardsIn('p', 'battlefield'))
        if (canAttack(c) && !cb.attackers.includes(c.iid)) cb.attackers.push(c.iid);
      return render();
    }
    if (a === 'skip-combat') {
      G.s.combat = null;
      G.s.step = 'main2';
      return render();
    }
    if (a === 'damage') return act(() => resolvePlayerCombat());
    if (a === 'blocks') return confirmBlocks();
    if (a === 'shuffle-close') {
      act(() => {
        shuffle('p');
        log('p', 'You shuffle your library.');
      });
      return closeDialog(true);
    }
    if (a === 'continue') {
      G.s.continueAfterWin = true;
      render();
      if (G.s.active === 'ai' && !run.aiBusy) beginTurn('p');
      return;
    }
    if (a === 'rematch' || a === 'newdecks') return window.dispatchEvent(new CustomEvent('edh:' + a));
  });

  // hover preview
  document.addEventListener('mouseover', onHover);
  document.addEventListener('mouseout', onHoverOut);
  document.addEventListener('keydown', onKey);
  };
  bindDoc(document);
  onChange(() => {
    render();
    refreshViewer();
  });

  $('#btn-next').addEventListener('click', () => {
    if (G.s.step === 'combat' && G.s.combat && G.s.combat.stage === 'damage') return act(() => resolvePlayerCombat());
    snapshot();
    playerNextStep();
  });
  $('#btn-end').addEventListener('click', () => {
    snapshot();
    playerEndTurn();
  });
  $('#btn-undo').addEventListener('click', () => !run.aiBusy && undo());
  $('#btn-redo').addEventListener('click', () => !run.aiBusy && redo());
  $('#btn-untap').addEventListener('click', () => act(() => { untapAll('p'); log('p', 'You untap everything.'); }));
  $('#btn-token').addEventListener('click', tokenDialog);
  $('#btn-tidy').addEventListener('click', tidy);
  $('#btn-help').addEventListener('click', helpDialog);
  $('#btn-reveal').addEventListener('click', (e) => {
    revealAiHand = !revealAiHand;
    e.currentTarget.setAttribute('aria-pressed', revealAiHand);
    render();
  });

  // Only the reader's own scrolling decides whether the log stops following new entries.
  const logEl = $('#log');
  const userScrolled = () =>
    setTimeout(() => (logScrolledUp = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight > 30), 60);
  logEl.addEventListener('wheel', userScrolled, { passive: true });
  logEl.addEventListener('touchmove', userScrolled, { passive: true });
  logEl.addEventListener('pointerup', userScrolled);

  window.addEventListener('resize', () => G.s && render());
}

function onHover(e) {
    const el = e.target.closest('.card[data-iid], .cn[data-def]');
    if (!el) return;
    if (el.dataset.iid) {
      const c = card(el.dataset.iid);
      if (!c) return;
      hoverIid = c.iid;
      if (c.owner === 'ai' && c.zone === 'hand' && !revealAiHand) return;
      if (c.zone === 'library' && !el.closest('#dialog')) return;
      if (hiddenFromMe(c)) return;
      setPreview(c.iid, null);
    } else setPreview(null, el.dataset.def, +el.dataset.face || 0);
}
function onHoverOut(e) {
    const el = e.target.closest('.card[data-iid]');
    if (el && hoverIid === el.dataset.iid && !el.contains(e.relatedTarget)) hoverIid = null;
  }

// ------------------------------------------------------------ pop-out boards (second screen)
let bindDoc = () => {};
function popOut(pid) {
  if (popouts.has(pid)) return;
  const name = pid === 'ai' ? "AI" : 'Your';
  const w = window.open('', 'edh-board-' + pid, 'width=1200,height=720');
  if (!w || !w.document) {
    toast('Couldn\'t open a new window. In the desktop app this needs version 1.1 or newer — download the latest installer from the Releases page.');
    return;
  }
  const doc = w.document;
  doc.open();
  doc.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>EDH Playtester — ${name} board</title>
    <link rel="stylesheet" href="${location.origin}/css/style.css"></head>
    <body class="popout-body"><div class="board popout-board"></div><div id="menu" class="pop" hidden></div></body></html>`);
  doc.close();
  const holder = doc.querySelector('.popout-board');
  const ids = pid === 'ai' ? ['#opp-panel', '#opp-field'] : ['#my-panel', '#my-field'];
  const ph = document.createElement('div');
  ph.className = 'pop-ph';
  ph.id = 'pop-ph-' + pid;
  ph.innerHTML = `<span>${pid === 'ai' ? "The AI's board" : 'Your board'} is in its own window.</span><button class="popout-btn" data-act="popin" data-pid="${pid}">⇲ Bring it back</button>`;
  document.querySelector(ids[1]).before(ph);
  for (const sel of ids) holder.appendChild(doc.adoptNode(document.querySelector(sel)));
  popouts.set(pid, { win: w, doc, ids });
  bindDoc(doc);
  w.addEventListener('resize', () => G.s && render());
  w.addEventListener('pagehide', () => popIn(pid, true));
  render();
}
function popIn(pid, closing) {
  const pop = popouts.get(pid);
  if (!pop) return;
  popouts.delete(pid);
  const ph = document.getElementById('pop-ph-' + pid);
  for (const sel of pop.ids) {
    const el = pop.doc.querySelector(sel);
    if (el && ph) ph.before(document.adoptNode(el));
  }
  if (ph) ph.remove();
  if (!closing) try { pop.win.close(); } catch (e) { void e; }
  render();
}
window.addEventListener('beforeunload', () => popDocs().forEach((d) => d.defaultView.close()));

function tidy() {
  act(() => {
    const bf = cardsIn('p', 'battlefield');
    const W = $('#my-field').clientWidth;
    const H = $('#my-field').clientHeight;
    const step = CARD_W + 8;
    const perRow = Math.max(1, Math.floor((W - 44) / step));
    const groups = [
      bf.filter((c) => isCreature(c)),
      bf.filter((c) => !isCreature(c) && !isLand(c)),
    ];
    let y = 8;
    for (const g of groups) {
      g.forEach((c, k) => {
        c.x = 22 + (k % perRow) * step;
        c.y = y + Math.floor(k / perRow) * (CARD_H + 10);
      });
      if (g.length) y += Math.ceil(g.length / perRow) * (CARD_H + 10);
    }
    const lands = bf.filter((c) => isLand(c) && !isCreature(c));
    const lrows = Math.ceil(lands.length / perRow) || 1;
    const ly = Math.max(y, H - lrows * (CARD_H + 10));
    lands.forEach((c, k) => {
      c.x = 22 + (k % perRow) * step;
      c.y = ly + Math.floor(k / perRow) * (CARD_H + 10);
    });
  });
}

function onKey(e) {
  if (!G.s || G.s.phase !== 'play') return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const k = e.key;
  if (k === 'Escape') {
    closeMenu();
    if (pendingTarget) return cancelTarget();
    return closeDialog();
  }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
    e.preventDefault();
    if (run.aiBusy || casting) return;
    return e.shiftKey ? redo() : undo();
  }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') {
    e.preventDefault();
    return !run.aiBusy && redo();
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (dialogOpen() || pendingTarget || casting) return;
  const s = G.s;
  if (k === 'Enter' || k === ' ') {
    e.preventDefault();
    if (s.stack && pendingRespond) {
      const r = pendingRespond;
      pendingRespond = null;
      return r('resolve');
    }
    if (pendingBlocks) return confirmBlocks();
    if (s.active === 'p' && !run.aiBusy) {
      if (e.shiftKey) return $('#btn-end').click();
      return $('#btn-next').click();
    }
    return;
  }
  const hc = hoverIid ? card(hoverIid) : null;
  const lk = k.toLowerCase();
  if (hc && isMine(hc)) {
    if (lk === 't' && hc.zone === 'battlefield') return toggleTap(hc.iid);
    if (lk === 'g') return sendTo(hc.iid, 'graveyard');
    if (lk === 'x') return sendTo(hc.iid, 'exile');
    if (lk === 'h') return sendTo(hc.iid, 'hand');
    if (lk === 'b') return sendTo(hc.iid, 'library', { to: 'bottom' });
    if (lk === 'f' && hc.zone === 'battlefield')
      return act(() => (hc.faceDown ? (hc.faceDown = false) : (hc.face = hc.face ? 0 : DB[hc.def].faces.length > 1 ? 1 : 0)));
    if ((k === '=' || k === '+') && hc.zone === 'battlefield') return act(() => (hc.counters['+1/+1'] = (hc.counters['+1/+1'] || 0) + 1));
    if ((k === '-' || k === '_') && hc.zone === 'battlefield')
      return act(() => {
        hc.counters['+1/+1'] = Math.max(0, (hc.counters['+1/+1'] || 0) - 1);
        if (!hc.counters['+1/+1']) delete hc.counters['+1/+1'];
      });
  }
  if (lk === 'd') return act(() => draw('p', 1));
  if (lk === 'u') return $('#btn-untap').click();
  if (lk === 's') return act(() => { shuffle('p'); log('p', 'You shuffle your library.'); toast('Library shuffled'); });
  if (lk === 'c') return e.preventDefault(), tokenDialog();
  if (lk === 'l') return e.preventDefault(), searchLibrary();
  if (k === '?') return e.preventDefault(), helpDialog();
}

export { refreshViewer, makeCard };
