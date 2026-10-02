// Triggered abilities. Game code queues events (state.queueEvent / fire); settle() finds every
// permanent whose rules text (or keyword) triggers on each event and resolves it.
import { DB } from './data.js';
import {
  isCreature, sculptors, SECTORS, SECTOR_SIGN, isLand, isType, oracle, face, hasKw, kwNum, power, toughness, cardValue, hasSubtype, payCost, typeLine,
} from './rules.js';
import {
  G, card, cardsIn, zoneOf, log, nameTag, eventQueue, queueEvent, stateBased, cardName, move, toBattlefield, addCounters,
  createToken, genericTokenDef, sacrifice, opp, libTop, esc,
} from './state.js';
import {
  resolveEffects, stripName, knownEffect, Cancelled, attachTo, matchesFilter, spellText, pumpEOT, subtypeWords,
} from './effects.js';
import { venture, takeInitiative } from './dungeon.js';

// Filled in by ui.js: choosers for both players, a yes/no prompt, render, and casting hooks.
export const T = {
  choosers: null,
  confirm: async () => true,
  render: () => {},
  castFree: null, // (pid, iid, opts) => Promise
  payMana: null, // (pid, cost, label) => Promise<boolean>
};

export const fire = (ev) => queueEvent(ev);

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };

// ------------------------------------------------------------ parsing printed triggers
export function triggersOf(c, defOverride) {
  const d = DB[defOverride || c.def];
  if (!d) return [];
  const inst = defOverride ? { ...c, def: d.id } : c;
  let text = stripName(oracle(inst) || (d.faces[c.face || 0] || d.faces[0]).oracle || '', inst);
  if (c.zone === 'command') text = text.split('\n').filter((l) => /^Eminence — /.test(l)).join('\n');
  text = text.replace(/(^|\n)Eminence — /g, '$1').replace(/, if ~ is in the command zone or on the battlefield,/gi, ',').replace(/(^|\n)As long as ~ is in the command zone or on the battlefield, /gi, '$1');
  text = text.replace(/\([^)]*\)/g, '').replace(/\n(?=•)/g, ' ¶');
  const out = [];
  const speed = G.s && c.controller ? G.s.players[c.controller].speed : 0;
  for (let line of text.split('\n')) {
    line = line.trim();
    if (/^Max speed — /i.test(line)) {
      if (speed < 4) continue;
      line = line.replace(/^Max speed — /i, '');
    }
    line = line.replace(/^[A-Z][A-Za-z',.! ]{2,40} — (?=When|At|Whenever)/, ''); // ability words: "Landfall — …"
    if (/^"/.test(line)) continue;
    let m;
    const add = (event, effect, extra = {}) => {
      let t = effect.trim().replace(/ ¶•/g, '\n•');
      const oncePerTurn = /This ability triggers only once each turn\.?/i.test(t);
      t = t.replace(/\s*This ability triggers only once each turn\.?/i, '');
      out.push({ event, text: t, optional: /^you may\b/i.test(t), raw: line, oncePerTurn, ...extra });
    };
    // enters
    if ((m = line.match(/^When(?:ever)? ~ enters(?: the battlefield)? or leaves the battlefield, (.+)$/i))) {
      add('enters', m[1], { self: true });
      add('leaves', m[1], { self: true });
    } else if ((m = line.match(/^When(?:ever)? ~ enters(?: the battlefield)? and at the beginning of your upkeep, (.+)$/i))) {
      add('enters', m[1], { self: true });
      add('upkeep', m[1], { whose: 'your' });
    } else if ((m = line.match(/^When(?:ever)? ~ enters(?: the battlefield)? or is put into a graveyard from the battlefield, (.+)$/i))) {
      add('enters', m[1], { self: true });
      add('dies', m[1], { self: true, anyPermanent: true });
    } else if ((m = line.match(/^When(?:ever)? (?:enchanted|equipped) creature dies, (.+)$/i))) {
      add('dies', m[1], { attachedTo: true });
    } else if ((m = line.match(/^When(?:ever)? ~ is turned face up, (.+)$/i))) {
      add('turnedFaceUp', m[1], { self: true });
    } else if ((m = line.match(/^Whenever ~ is dealt damage, (.+)$/i))) {
      add('dealtDamage', m[1], { self: true });
    } else if ((m = line.match(/^Whenever (?:enchanted|equipped) creature is dealt damage, (.+)$/i))) {
      add('dealtDamage', m[1], { attachedTo: true });
    } else if ((m = line.match(/^Whenever ~ deals damage(?: to a player| to an opponent)?, (.+)$/i)) && !/combat damage/i.test(line)) {
      add(/to a player|to an opponent/i.test(line) ? 'dealsDamagePlayer' : 'dealsDamage', m[1], { self: true });
    } else if ((m = line.match(/^Whenever (?:enchanted|equipped) creature deals damage, (.+)$/i))) {
      add('dealsDamage', m[1], { attachedTo: true });
    } else if ((m = line.match(/^Whenever ~ deals combat damage to a creature, (.+)$/i))) {
      add('combatDamageCreature', m[1], { self: true });
    } else if ((m = line.match(/^Whenever ~ and at least (two|three|\d+) other creatures attack, (.+)$/i))) {
      add('attacks', m[2], { self: true, minAttackers: 1 + ({ two: 2, three: 3 }[m[1].toLowerCase()] || +m[1]) });
    } else if ((m = line.match(/^At the beginning of (?:your second main phase|your postcombat main phase|each of your postcombat main phases|your second main phase each turn), (.+)$/i))) {
      add('main2', m[1], { whose: 'your' });
    } else if ((m = line.match(/^At the beginning of (?:the upkeep of enchanted creature's controller|enchanted creature's controller's upkeep|enchanted player's upkeep), (.+)$/i))) {
      add('upkeep', m[1], { whose: 'enchanted' });
    } else if ((m = line.match(/^Whenever (?:a player|an opponent|you) cycles? (?:a|another) card, (.+)$/i))) {
      add('cycle', m[1], { anyPlayer: /a player/i.test(line), oppOnly: /an opponent/i.test(line) });
    }
    else if ((m = line.match(/^When(?:ever)? ~ (?:enters?|enters? the battlefield)(?: or attacks| or dies)?(?: under your control)?(?: from your graveyard| from exile)?, (.+)$/i))) {
      add('enters', m[1], { self: true });
      if (/or attacks/i.test(line)) add('attacks', m[1], { self: true });
      if (/or dies/i.test(line)) add('dies', m[1], { self: true });
    } else if ((m = line.match(/^When(?:ever)? ~ or another (nontoken )?(creature|artifact|enchantment|permanent|[A-Z]\w+) (?:you control )?enters(?: the battlefield)?(?: under your control)?, (.+)$/i))) {
      add('enters', m[3], { self: true });
      add('enters', m[3], { other: true, kind: m[2].toLowerCase(), mine: true, nontoken: !!m[1] });
    } else if ((m = line.match(/^When(?:ever)? (another|a|an|one or more|one or more other) (nontoken )?([A-Z][\w-]+s?, (?:[A-Z][\w-]+s?, )*(?:or|and\/or) )([A-Z][\w-]+)s? you control enters?(?: the battlefield)?, (.+)$/))) {
      add('enters', m[5], { other: /another|other/.test(m[1]), kind: kindWords(m[3] + m[4]), mine: true, nontoken: !!m[2], once: /one or more/.test(m[1]) });
    } else if ((m = line.match(/^When(?:ever)? (another|a|an|one or more|one or more other) (nontoken )?((?:[\w-]+ ){0,3}?)(creature|artifact|enchantment|land|permanent|planeswalker|token|[A-Z][\w-]+)s? (?:you control )?(with [^,]+? )?enters?(?: the battlefield)?( under your control| under an opponent's control)?, (.+)$/i))) {
      const theirs = /opponent/.test(m[6] || '');
      const mine = /under your control/.test(m[6] || '') || /you control/i.test(line.split(',')[0]);
      add('enters', m[7], { other: /another|other/.test(m[1]), kind: ((m[3] + m[4]).toLowerCase().trim() + (m[5] ? ' ' + m[5].trim() : '')).trim(), mine, theirs, nontoken: !!m[2], once: /one or more/.test(m[1]) });
    }
    // dies / leaves / graveyard
    else if ((m = line.match(/^When(?:ever)? ~ dies or is put into exile from the battlefield, (.+)$/i))) {
      add('dies', m[1], { self: true });
      add('leaves', m[1], { self: true, toZone: 'exile' });
    } else if ((m = line.match(/^When(?:ever)? ~ dies, (.+)$/i)) || (m = line.match(/^When ~ is put into (?:a|your) graveyard from the battlefield, (.+)$/i)))
      add('dies', m[1], { self: true });
    else if ((m = line.match(/^Whenever ~ or another (nontoken )?(creature|[A-Z][\w-]+) (you control )?dies, (.+)$/i))) {
      add('dies', m[4], { self: true });
      add('dies', m[4], { other: true, nontoken: !!m[1], mine: !!m[3], kind: m[2] === 'creature' ? '' : m[2].toLowerCase() });
    } else if ((m = line.match(/^Whenever (another|a|one or more) (nontoken )?((?:[\w-]+ ){0,2}?)(creature|creatures|[A-Z]\w+s?) (you control )?dies?, (.+)$/i)))
      add('dies', m[6], { mine: !!m[5], other: m[1] === 'another', nontoken: !!m[2], kind: m[3].trim().toLowerCase() + (/^[A-Z]/.test(m[4]) ? m[4].replace(/s$/, '').toLowerCase() : '') });
    else if ((m = line.match(/^Whenever (another|a|one or more) (nontoken )?creatures? (?:an opponent controls|your opponents control) dies?, (.+)$/i)))
      add('dies', m[3], { theirs: true, nontoken: !!m[2] });
    else if ((m = line.match(/^When(?:ever)? ~ leaves the battlefield, (.+)$/i)))
      add('leaves', m[1], { self: true });
    else if ((m = line.match(/^Whenever (?:a|another) creature token (you control )?leaves the battlefield, (.+)$/i)))
      add('leaves', m[2], { mine: !!m[1], anyController: !m[1], tokenOnly: true, kind: 'creature', other: true });
    else if ((m = line.match(/^Whenever (~ or )?(?:another|a) (nontoken )?(creature|permanent) you control leaves the battlefield(?: without dying)?, (.+)$/i))) {
      if (m[1]) add('leaves', m[4], { self: true });
      add('leaves', m[4], { mine: true, nontoken: !!m[2], kind: m[3].toLowerCase(), other: true });
    }
    else if ((m = line.match(/^Whenever (?:a|an|one or more) ([A-Za-z ]+?) cards? (?:is|are) put into your graveyard from anywhere( other than the battlefield)?, (.+)$/i)))
      add('toGraveyard', m[3], { kind: m[1].toLowerCase(), notFromBf: !!m[2], mine: true });
    else if ((m = line.match(/^Whenever (?:a|an) (land|creature|artifact|enchantment|permanent) you control is put into a graveyard from the battlefield, (.+)$/i)))
      add('toGraveyard', m[2], { kind: m[1].toLowerCase(), fromBf: true, mine: true });
    else if ((m = line.match(/^Whenever a creature you control that was turned face up this turn deals combat damage to a player, (.+)$/i)))
      add('combatDamagePlayer', m[1], { anyOfMine: true, faceUpTurn: true });
    else if ((m = line.match(/^Whenever an enchanted creature you control deals combat damage to a player, (.+)$/i)))
      add('combatDamagePlayer', m[1], { anyOfMine: true, enchanted: true });
    else if ((m = line.match(/^Whenever one or more (?:other )?cards? (?:are put into|leave) your graveyard(?: from anywhere)?, (.+)$/i)))
      add('putIntoGraveyard', m[1], { mine: true });
    // combat
    else if ((m = line.match(/^Whenever ~ deals (?:combat )?damage to (?:a player|an opponent|one or more players|a player or planeswalker|a player or battle)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[1], { self: true });
    else if ((m = line.match(/^Whenever (?:a|another) creature you control with (?:a|one or more) (\+1\/\+1 )?counters? on it deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[2], { anyOfMine: true, withCounter: m[1] ? '+1/+1' : 'any' });
    else if ((m = line.match(/^Whenever (?:a|another) ((?:[\w-]+ ){0,2}?)creature you control deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[2], { anyOfMine: true, kind: m[1].trim() });
    else if ((m = line.match(/^Whenever equipped creature deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)) || (m = line.match(/^Whenever enchanted creature deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[1], { attachedTo: true });
    else if ((m = line.match(/^Whenever one or more (other )?((?:[\w-]+ )*?)(?:creatures|[A-Z][\w-]+s|(?:[A-Z][\w-]+s?, )*[A-Z][\w-]+s?,? (?:and\/or|or|and) [A-Z][\w-]+s)? ?you control deal combat damage to (?:a player|an opponent|one or more players)[^,]*, (.+)$/i)))
      add('combatDamageOnce', m[3], { kind: kindWords(line.match(/one or more (?:other )?(.+?) you control deal/i)[1]) });
    else if ((m = line.match(/^When(?:ever)? ~ (?:attacks or blocks|blocks or attacks)[^,]*, (.+)$/i))) {
      add('attacks', m[1], { self: true });
      add('blocks', m[1], { self: true });
    } else if ((m = line.match(/^When(?:ever)? ~ attacks(?: and isn't blocked)?(?: alone)?[^,]*, (.+)$/i)))
      add(/isn't blocked/i.test(line) ? 'unblocked' : /alone/i.test(line) ? 'attacksAlone' : 'attacks', m[1], { self: true });
    else if ((m = line.match(/^When(?:ever)? ~ blocks(?: or becomes blocked)?[^,]*, (.+)$/i))) {
      add('blocks', m[1], { self: true });
      if (/becomes blocked/i.test(line)) add('blocked', m[1], { self: true });
    } else if ((m = line.match(/^Whenever ~ becomes blocked(?: by a creature)?[^,]*, (.+)$/i)))
      add('blocked', m[1], { self: true });
    else if ((m = line.match(/^Whenever equipped creature attacks, (.+)$/i)) || (m = line.match(/^Whenever enchanted creature attacks, (.+)$/i)))
      add('attacks', m[1], { attachedTo: true });
    else if ((m = line.match(/^Whenever (?:a|another) ((?:[\w-]+ ){0,2}?)creature you control attacks[^,]*, (.+)$/i)))
      add('attacks', m[2], { anyOfMine: true, kind: m[1].trim() });
    else if ((m = line.match(/^Whenever you attack enchanted player[^,]*, (.+)$/i)))
      add('youAttack', m[1], { enchanted: true });
    else if ((m = line.match(/^Whenever (?:a player|an opponent) attacks you(?: or a planeswalker you control)?[^,]*, (.+)$/i)))
      add('youAttack', m[1], { defend: true });
    else if ((m = line.match(/^Whenever (?:you attack|one or more (?:other )?(?:[\w-]+ )*?(?:creatures|[A-Z][\w-]+s) you control attack)[^,]*, (.+)$/i)))
      {
      const km = line.match(/one or more (?:other )?(.+?) you control attack/i) || line.match(/with one or more (.+?)(?:,| with power)/i);
      add('youAttack', m[1], { kind: km ? kindWords(km[1]) : '' });
    }
    else if ((m = line.match(/^Whenever a creature you control attacks alone, (.+)$/i)))
      add('attacksAlone', m[1], { anyOfMine: true });
    else if ((m = line.match(/^Whenever a creature (?:attacks you|an opponent controls attacks)[^,]*, (.+)$/i)))
      add('attacks', m[1], { theirAttacker: true });
    // turn steps
    else if ((m = line.match(/^At the beginning of (your|each|each opponent's|each player's) upkeep, (.+)$/i)))
      add('upkeep', m[2], { whose: m[1].toLowerCase().replace("each player's", 'each') });
    else if ((m = line.match(/^At the beginning of (your|each|each player's|each opponent's) draw step, (.+)$/i)))
      add('drawStep', m[2], { whose: m[1].toLowerCase().replace("each player's", 'each') });
    else if ((m = line.match(/^At the beginning of (?:combat on your turn|each combat|combat on each opponent's turn), (.+)$/i)))
      add('beginCombat', m[1], { whose: /each combat/i.test(line) ? 'each' : /each opponent's/i.test(line) ? "each opponent's" : 'your' });
    else if ((m = line.match(/^At the beginning of (your|each|each opponent's|each player's) end step, (.+)$/i)) || (m = line.match(/^At the beginning of (the|the next) end step, (.+)$/i)))
      add('endStep', m[2], { whose: /^the/i.test(m[1]) || /each player's/i.test(m[1]) ? 'each' : m[1].toLowerCase() });
    else if ((m = line.match(/^At the beginning of your (?:precombat |first )?main phase, (.+)$/i)))
      add('mainPhase', m[1], { whose: 'your' });
    else if ((m = line.match(/^At end of combat, (.+)$/i)))
      add('endCombat', m[1], { whose: 'your' });
    // spells
    else if ((m = line.match(/^When you cast this spell, (.+)$/i)) || (m = line.match(/^When you cast ~, (.+)$/i)))
      add('castSelf', m[1], { self: true });
    else if ((m = line.match(/^Whenever you cast or copy (?:an|a) ([^,]*?)spell, (.+)$/i)))
      add('cast', m[2], { spell: m[1].toLowerCase().trim(), mine: true });
    else if ((m = line.match(/^Whenever you cast (?:a|an|another|your first|your second) ([^,]*?)spell(?: each turn| during [^,]+| from [^,]+| with [^,]+| that [^,]+| this turn)?, (.+)$/i)))
      add('cast', m[2], { spell: m[1].toLowerCase().trim(), mine: true, first: /your first/i.test(line), second: /your second/i.test(line), notSelf: /another/i.test(line), from: (line.match(/spell from (your hand|your graveyard|exile|anywhere other than your hand)/i) || [])[1] });
    else if ((m = line.match(/^When(?:ever)? an opponent casts (?:a|an|their first) ([^,]*?)spell[^,]*, (.+)$/i)))
      add('cast', m[2], { spell: m[1].toLowerCase().trim(), theirs: true });
    else if ((m = line.match(/^Whenever a player casts (?:a|an) ([^,]*?)spell[^,]*, (.+)$/i)))
      add('cast', m[2], { spell: m[1].toLowerCase().trim() });
    // cards and life
    else if ((m = line.match(/^Whenever (you|an opponent|a player) draws? (?:a|your second|their second) card[^,]*, (.+)$/i)))
      add('draw', m[2], { who: m[1].toLowerCase(), second: /second/i.test(line) });
    else if ((m = line.match(/^Whenever (you|an opponent) discards? (?:a|one or more) (?:nonland )?cards?, (.+)$/i)))
      add('discard', m[2], { who: m[1].toLowerCase() });
    else if ((m = line.match(/^Whenever you cycle(?: or discard)? (?:a|another) card, (.+)$/i)) || (m = line.match(/^When you cycle ~, (.+)$/i)))
      add('cycle', m[1], { self: /When you cycle ~/i.test(line) });
    else if ((m = line.match(/^Whenever (you|an opponent) gains? life, (.+)$/i)))
      add('lifeGained', m[2], { who: m[1].toLowerCase() });
    else if ((m = line.match(/^Whenever (you|an opponent|a player) loses? life(?: during your turn)?, (.+)$/i)))
      add('lifeLost', m[2], { who: m[1].toLowerCase() });
    else if ((m = line.match(/^Whenever a land (?:you control enters|enters(?: the battlefield)? under your control)[^,]*, (.+)$/i)))
      add('landfall', m[1]);
    else if ((m = line.match(/^Whenever one or more \+1\/\+1 counters are put on ~, (.+)$/i)))
      add('counterPut', m[1], { self: true, kind: '+1/+1' });
    else if ((m = line.match(/^Whenever one or more \+1\/\+1 counters are put on (?:a|another) creature you control, (.+)$/i)))
      add('counterPut', m[1], { anyOfMine: true, kind: '+1/+1' });
    else if ((m = line.match(/^Whenever you put one or more \+1\/\+1 counters on a creature you control, (.+)$/i)))
      add('counterPut', m[1], { anyOfMine: true, kind: '+1/+1', amountIsN: true });
    else if ((m = line.match(/^Whenever (you|a player|an opponent) sacrifices? (a|an|another|one or more|one or more other) ([^,]+?)( during your turn)?, (.+)$/i)))
      add('sacrificed', m[5], { kind: m[3].toLowerCase().replace(/^nontoken /, ''), who: m[1].toLowerCase(), other: /another|other/i.test(m[2]), nontoken: /nontoken/i.test(m[3]), yourTurn: !!m[4] });
    else if ((m = line.match(/^Whenever you create (?:a|one or more) (?:creature )?tokens?, (.+)$/i)))
      add('tokensCreated', m[1]);
    else if ((m = line.match(/^Whenever you (scry|surveil)[^,]*, (.+)$/i)))
      add(m[1].toLowerCase(), m[2]);
    else if ((m = line.match(/^Whenever (?:~|a creature you control) explores, (.+)$/i)))
      add('explored', m[1]);
    else if ((m = line.match(/^When(?:ever)? ~ becomes monstrous, (.+)$/i)))
      add('monstrous', m[1], { self: true });
    else if ((m = line.match(/^When ~ exploits a creature, (.+)$/i)))
      add('exploited', m[1], { self: true });
    else if ((m = line.match(/^When(?:ever)? ~ (?:transforms into|becomes) [^,]+, (.+)$/i)))
      add('transformed', m[1], { self: true });
    else if ((m = line.match(/^When this Class becomes level (\d+), (.+)$/i)))
      add('classLevel', m[2], { self: true, level: +m[1] });
    else if ((m = line.match(/^Whenever the Ring tempts you, (.+)$/i)))
      add('ringTempts', m[1]);
    else if ((m = line.match(/^Whenever you complete a dungeon, (.+)$/i)))
      add('dungeonDone', m[1]);
    else if ((m = line.match(/^Whenever ~ becomes tapped, (.+)$/i)))
      add('tapped', m[1], { self: true });
    else if ((m = line.match(/^When(?:ever)? ~ mutates, (.+)$/i)))
      add('mutates', m[1], { self: true });
    // saga chapters
    else if ((m = line.match(/^((?:[IVX]+)(?:, [IVX]+)*) — (.+)$/))) {
      const chapters = m[1].split(/, /).map((r) => ROMAN[r] || 0);
      out.push({ event: 'chapter', chapters, text: m[2], raw: line, self: true, optional: /^you may/i.test(m[2]) });
    }
  }
  return out.concat(keywordTriggers(c));
}

// ------------------------------------------------------------ keyword triggers
function keywordTriggers(c) {
  if (!c || c.faceDown || c.lostAbilities || c.zone === 'command') return [];
  const out = [];
  const t = (event, text, extra = {}) => out.push({ event, text, raw: text, kw: true, ...extra });
  const f = (event, fn, label, extra = {}) => out.push({ event, fn, raw: label, kw: true, ...extra });
  const o = oracle(c);
  if (hasKw(c, 'prowess')) t('cast', '~ gets +1/+1 until end of turn', { spell: 'noncreature', mine: true, self: false });
  const ex = (o.match(/\bExalted\b/g) || []).length + (hasKw(c, 'exalted') && !/\bExalted\b/.test(o) ? 1 : 0);
  for (let k = 0; k < ex; k++) t('attacksAlone', 'it gets +1/+1 until end of turn', { anyOfMine: true });
  if (hasKw(c, 'battle cry')) t('attacks', 'each other attacking creature you control gets +1/+0 until end of turn', { self: true });
  if (kwNum(c, 'Annihilator')) t('attacks', `defending player sacrifices ${kwNum(c, 'Annihilator')} permanents`, { self: true });
  if (kwNum(c, 'Afflict')) t('blocked', `defending player loses ${kwNum(c, 'Afflict')} life`, { self: true });
  if (kwNum(c, 'Bushido')) {
    t('blocks', `~ gets +${kwNum(c, 'Bushido')}/+${kwNum(c, 'Bushido')} until end of turn`, { self: true });
    t('blocked', `~ gets +${kwNum(c, 'Bushido')}/+${kwNum(c, 'Bushido')} until end of turn`, { self: true });
  }
  if (kwNum(c, 'Rampage')) f('blocked', async (ctx, hit, ev) => {
    const k = (ev.blockers || []).length - 1;
    if (k > 0) pumpEOT(c, { p: kwNum(c, 'Rampage') * k, t: kwNum(c, 'Rampage') * k, grants: [] });
    return k > 0 ? [`rampage: +${kwNum(c, 'Rampage') * k}/+${kwNum(c, 'Rampage') * k}`] : [];
  }, 'Rampage', { self: true });
  if (hasKw(c, 'flanking')) f('blocked', async (ctx, hit, ev) => {
    const did = [];
    for (const b of (ev.blockers || []).map(card).filter(Boolean)) {
      if (hasKw(b, 'flanking')) continue;
      pumpEOT(b, { p: -1, t: -1, grants: [] });
      did.push(`${nameTag(b)} gets -1/-1 (flanking)`);
    }
    return did;
  }, 'Flanking', { self: true });
  if (hasKw(c, 'melee')) t('attacks', '~ gets +1/+1 until end of turn', { self: true });
  if (hasKw(c, 'dethrone')) f('attacks', async () => {
    const def = opp(c.controller);
    if (G.s.players[def].life >= G.s.players[c.controller].life) {
      addCounters(c, '+1/+1', 1);
      return ['dethrone: +1/+1 counter'];
    }
    return [];
  }, 'Dethrone', { self: true });
  if (hasKw(c, 'training')) f('attacks', async () => {
    const atk = (G.s.combat ? G.s.combat.attackers : []).map(card).filter(Boolean);
    if (atk.some((a) => a.iid !== c.iid && power(a) > power(c))) {
      addCounters(c, '+1/+1', 1);
      queueEvent({ type: 'trains', iid: c.iid, controller: c.controller });
      return ['training: +1/+1 counter'];
    }
    return [];
  }, 'Training', { self: true });
  if (hasKw(c, 'mentor')) f('attacks', async (ctx) => {
    const atk = (G.s.combat ? G.s.combat.attackers : []).map(card).filter((a) => a && a.iid !== c.iid && power(a) < power(c));
    if (!atk.length) return [];
    const pick = await ctx.choosers[c.controller].target({ forced: true, prompt: 'Mentor: put a +1/+1 counter on an attacking creature with lesser power', candidates: atk.map((a) => a.iid), harm: false, src: c });
    if (pick && pick.iid) {
      addCounters(card(pick.iid), '+1/+1', 1);
      return [`mentors ${nameTag(card(pick.iid))}`];
    }
    return [];
  }, 'Mentor', { self: true });
  if (kwNum(c, 'Renown')) f('combatDamagePlayer', async () => {
    if (c.renowned) return [];
    addCounters(c, '+1/+1', kwNum(c, 'Renown'));
    c.renowned = true;
    return [`becomes renowned (+${kwNum(c, 'Renown')} counters)`];
  }, 'Renown', { self: true });
  if (kwNum(c, 'Frenzy')) t('unblocked', `~ gets +${kwNum(c, 'Frenzy')}/+0 until end of turn`, { self: true });
  if (kwNum(c, 'Mobilize')) t('attacks', `create ${kwNum(c, 'Mobilize')} 1/1 red Warrior creature tokens tapped and attacking. sacrifice them at the beginning of the next end step`, { self: true });
  if (hasKw(c, 'myriad')) void 0; // one opponent: nothing to copy
  if (hasKw(c, 'provoke')) f('attacks', async (ctx) => {
    const def = opp(c.controller);
    const cands = cardsIn(def, 'battlefield').filter(isCreature);
    if (!cands.length) return [];
    const pick = await ctx.choosers[c.controller].target({ prompt: 'Provoke: choose a creature that must block', candidates: cands.map((x) => x.iid), harm: true, src: c, optional: true });
    if (!pick || !pick.iid) return [];
    const b = card(pick.iid);
    b.tapped = false;
    b.provokedBy = c.iid;
    return [`provokes ${nameTag(b)}`];
  }, 'Provoke', { self: true });
  if (hasKw(c, 'enlist')) f('attacks', async (ctx) => {
    const cands = cardsIn(c.controller, 'battlefield').filter((x) => isCreature(x) && !x.attacking && !x.tapped && !x.sick && x.iid !== c.iid);
    if (!cands.length) return [];
    const [pick] = await ctx.choosers[c.controller].pickCards({ prompt: 'Enlist: tap a non-attacking creature to add its power', cards: cands.map((x) => x.iid), min: 0, max: 1, purpose: 'enlist', src: c, aiScore: (x) => power(x) - cardValue(x) / 3 });
    if (!pick) return [];
    card(pick).tapped = true;
    pumpEOT(c, { p: power(card(pick)), t: 0, grants: [] });
    return [`enlists ${nameTag(card(pick))} (+${power(card(pick))}/+0)`];
  }, 'Enlist', { self: true });
  if (hasKw(c, 'evolve')) f('enters', async (ctx, hit, ev) => {
    const nc = card(ev.iid);
    if (!nc || !isCreature(nc) || nc.iid === c.iid) return [];
    if (power(nc) > power(c) || toughness(nc) > toughness(c)) {
      addCounters(c, '+1/+1', 1);
      return ['evolves'];
    }
    return [];
  }, 'Evolve', { other: true, mine: true, kind: 'creature' });
  if (/(?:^|\n)As (?:~|this [a-z]+) enters(?: the battlefield)?, choose a creature type/i.test(o.split(DB[c.def].name).join('~')) && !c.chosenType)
    f('enters', async () => {
      const t = await chooseCreatureType(c.controller, `${cardName(c)}: choose a creature type`);
      if (!t || !card(c.iid)) return [];
      card(c.iid).chosenType = t;
      return [`chooses ${t}`];
    }, 'Choose a creature type', { self: true });
  if (/\bExtort\b/.test(o)) f('cast', async () => {
    if (!T.payMana) return [];
    const paid = await T.payMana(c.controller, '{W/B}', `Extort (${cardName(c)})`);
    if (!paid) return [];
    const def = opp(c.controller);
    G.s.players[def].life -= 1;
    G.s.players[c.controller].life += 1;
    return ['extorts 1'];
  }, 'Extort', { spell: '', mine: true });
  if (hasKw(c, 'exploit')) f('enters', async (ctx) => {
    const cands = cardsIn(c.controller, 'battlefield').filter(isCreature);
    const yes = c.controller === 'ai' ? cands.some((x) => x.token || cardValue(x) < 3) : await T.confirm(cardName(c), 'Exploit: sacrifice a creature?');
    if (!yes) return [];
    const [pick] = await ctx.choosers[c.controller].pickCards({ forced: true, prompt: 'Exploit: choose a creature to sacrifice', cards: cands.map((x) => x.iid), min: 1, max: 1, purpose: 'sacrifice', src: c, aiScore: (x) => -cardValue(x) + (x.iid === c.iid ? -3 : 0) });
    if (!pick) return [];
    const nm = nameTag(card(pick));
    sacrifice(pick);
    queueEvent({ type: 'exploited', iid: c.iid, controller: c.controller });
    return [`exploits ${nm}`];
  }, 'Exploit', { self: true });
  if (kwNum(c, 'Fabricate')) f('enters', async (ctx) => {
    const k = kwNum(c, 'Fabricate');
    const choice = await ctx.choosers[c.controller].choose({ prompt: `Fabricate ${k}`, options: [{ label: `Put ${k} +1/+1 counter${k > 1 ? 's' : ''} on ${cardName(c)}` }, { label: `Create ${k} 1/1 Servo token${k > 1 ? 's' : ''}` }], aiPick: () => (isCreature(c) && cardsIn(c.controller, 'battlefield').filter(isCreature).length >= 3 ? 0 : 1) });
    if (choice === 0) {
      addCounters(c, '+1/+1', k);
      return [`fabricates ${k} counters`];
    }
    createToken(genericTokenDef(1, 1, 'Servo', [], { types: 'Artifact' }), c.controller, k);
    return [`fabricates ${k} Servo${k > 1 ? 's' : ''}`];
  }, 'Fabricate', { self: true });
  if (hasKw(c, 'riot')) f('enters', async (ctx) => {
    const choice = await ctx.choosers[c.controller].choose({ prompt: `Riot: ${cardName(c)}`, options: [{ label: 'Haste' }, { label: '+1/+1 counter' }], aiPick: () => (G.s.active === c.controller && G.s.step === 'main1' ? 0 : 1) });
    if (choice === 0) c.grants = [...(c.grants || []), 'haste'];
    else addCounters(c, '+1/+1', 1);
    return [choice === 0 ? 'riots (haste)' : 'riots (+1/+1 counter)'];
  }, 'Riot', { self: true });
  if (kwNum(c, 'Devour')) f('enters', async (ctx) => {
    const k = kwNum(c, 'Devour');
    const cands = cardsIn(c.controller, 'battlefield').filter((x) => isCreature(x) && x.iid !== c.iid);
    if (!cands.length) return [];
    const picks = await ctx.choosers[c.controller].pickCards({ prompt: `Devour ${k}: sacrifice any number of other creatures`, cards: cands.map((x) => x.iid), min: 0, max: cands.length, purpose: 'devour', src: c, aiScore: (x) => (x.token ? 5 : -cardValue(x)) });
    const eat = c.controller === 'ai' ? picks.filter((i) => card(i).token) : picks;
    eat.forEach((i) => sacrifice(i));
    addCounters(c, '+1/+1', k * eat.length);
    return eat.length ? [`devours ${eat.length}`] : [];
  }, 'Devour', { self: true });
  if (kwNum(c, 'Afterlife')) t('dies', `create ${kwNum(c, 'Afterlife')} 1/1 white and black Spirit creature tokens with flying`, { self: true });
  if (hasKw(c, 'persist')) f('dies', async (ctx, hit, ev) => {
    if ((ev.counters || {})['-1/-1'] || ev.token || !card(ev.iid) || card(ev.iid).zone !== 'graveyard') return [];
    toBattlefield(ev.iid, ev.owner);
    addCounters(card(ev.iid), '-1/-1', 1);
    return ['persists'];
  }, 'Persist', { self: true });
  if (hasKw(c, 'undying')) f('dies', async (ctx, hit, ev) => {
    if ((ev.counters || {})['+1/+1'] || ev.token || !card(ev.iid) || card(ev.iid).zone !== 'graveyard') return [];
    toBattlefield(ev.iid, ev.owner);
    addCounters(card(ev.iid), '+1/+1', 1);
    return ['undying: returns'];
  }, 'Undying', { self: true });
  if (kwNum(c, 'Modular')) f('dies', async (ctx, hit, ev) => {
    const k = (ev.counters || {})['+1/+1'] || 0;
    if (!k) return [];
    const cands = cardsIn(ev.controller, 'battlefield').filter((x) => isCreature(x) && isType(x, 'Artifact'));
    if (!cands.length) return [];
    const pick = await ctx.choosers[ev.controller].target({ prompt: `Modular: move ${k} +1/+1 counters onto an artifact creature`, candidates: cands.map((x) => x.iid), harm: false, src: c, optional: true });
    if (!pick || !pick.iid) return [];
    addCounters(card(pick.iid), '+1/+1', k);
    return [`moves ${k} counters to ${nameTag(card(pick.iid))}`];
  }, 'Modular', { self: true });
  if (kwNum(c, 'Soulshift')) t('dies', `you may return target Spirit card with mana value ${kwNum(c, 'Soulshift')} or less from your graveyard to your hand`, { self: true, optional: true });
  if (hasKw(c, 'decayed')) f('attacks', async () => {
    c.endOfCombat = 'sacrifice';
    return [];
  }, 'Decayed', { self: true });
  if (kwNum(c, 'Backup')) f('enters', async (ctx) => {
    const k = kwNum(c, 'Backup');
    const cands = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter(isCreature);
    const pick = await ctx.choosers[c.controller].target({ forced: true, prompt: `Backup ${k}: put +1/+1 counters on a creature`, candidates: cands.map((x) => x.iid), harm: false, src: c });
    if (!pick || !pick.iid) return [];
    const tgt = card(pick.iid);
    addCounters(tgt, '+1/+1', k);
    if (tgt.iid !== c.iid) {
      const kws = DB[c.def].keywords.filter((kk) => kk !== 'backup');
      tgt.eotGrants = [...(tgt.eotGrants || []), ...kws];
    }
    return [`backs up ${nameTag(tgt)}`];
  }, 'Backup', { self: true });
  if (/\bLiving weapon\b/.test(o)) void 0; // handled on 'germ'
  if (kwNum(c, 'Bloodthirst')) f('enters', async () => {
    if (G.s.ts[opp(c.controller)].lifeLost > 0) {
      addCounters(c, '+1/+1', kwNum(c, 'Bloodthirst'));
      return ['bloodthirst'];
    }
    return [];
  }, 'Bloodthirst', { self: true });
  if (kwNum(c, 'Tribute')) f('enters', async (ctx) => {
    const k = kwNum(c, 'Tribute');
    const opponent = opp(c.controller);
    const choice = await ctx.choosers[opponent].choose({ prompt: `Tribute ${k}: give ${cardName(c)} ${k} +1/+1 counters?`, options: [{ label: `Put ${k} counters on it` }, { label: "Don't (it gets its tribute bonus)" }], aiPick: () => 0 });
    if (choice === 0) {
      addCounters(c, '+1/+1', k);
      c.tributePaid = true;
      return [`gets tribute (${k} counters)`];
    }
    const bonus = (oracle(c).match(/if tribute wasn't paid, ([^\n]+)/i) || [])[1];
    return bonus ? await resolveEffects(bonus, c, { ...ctx, me: c.controller, forced: true }) : [];
  }, 'Tribute', { self: true });
  if (hasKw(c, 'unleash')) f('enters', async (ctx) => {
    const yes = c.controller === 'ai' ? true : await T.confirm(cardName(c), 'Unleash: enter with a +1/+1 counter? (It can\'t block while it has one.)');
    if (yes) {
      addCounters(c, '+1/+1', 1);
      c.grants = [...(c.grants || []), 'unleashed'];
    }
    void ctx;
    return yes ? ['unleashed'] : [];
  }, 'Unleash', { self: true });
  if (kwNum(c, 'Hideaway')) f('enters', async (ctx) => {
    const k = kwNum(c, 'Hideaway');
    const ids = libTop(c.controller, k);
    if (!ids.length) return [];
    const [pick] = await ctx.choosers[c.controller].pickCards({ forced: true, prompt: `Hideaway ${k}: exile one face down`, cards: ids, min: 1, max: 1, purpose: 'hideaway', src: c, aiScore: (x) => DB[x.def].cmc });
    move(pick, 'exile', { faceDown: true });
    card(pick).hiddenBy = c.iid;
    card(pick).mayPlayFree = c.controller;
    ids.filter((i) => i !== pick).forEach((i) => move(i, 'library', { to: 'bottom' }));
    return ['hides a card away'];
  }, 'Hideaway', { self: true });
  if (/\bChampion an? /i.test(o)) f('enters', async (ctx) => {
    const what = (o.match(/Champion an? ([^\n(]+)/i) || [])[1] || 'creature';
    const cands = cardsIn(c.controller, 'battlefield').filter((x) => x.iid !== c.iid && matchesFilter(x, what.trim()));
    if (!cands.length) {
      sacrifice(c.iid);
      return ['is sacrificed (nothing to champion)'];
    }
    const [pick] = await ctx.choosers[c.controller].pickCards({ forced: true, prompt: `Champion a ${what}`, cards: cands.map((x) => x.iid), min: 1, max: 1, purpose: 'champion', src: c, aiScore: (x) => -cardValue(x) });
    move(pick, 'exile');
    card(pick).championedBy = c.iid;
    return [`champions ${nameTag(card(pick))}`];
  }, 'Champion', { self: true });
  if (hasKw(c, 'squad') && c.squadCount) f('enters', async () => {
    createToken(c.def, c.controller, c.squadCount);
    return [`creates ${c.squadCount} squad token${c.squadCount > 1 ? 's' : ''}`];
  }, 'Squad', { self: true });
  if (c.offspringPaid) f('enters', async () => {
    const [i] = createToken(c.def, c.controller, 1);
    card(i).setPT = { p: 1, t: 1 };
    return ['creates a 1/1 offspring'];
  }, 'Offspring', { self: true });
  if (c.castMode === 'evoke') f('enters', async () => {
    sacrifice(c.iid);
    return ['is evoked and sacrificed'];
  }, 'Evoke', { self: true });
  if (c.xPaid >= 5 && /\bRavenous\b/.test(o)) t('enters', 'draw a card', { self: true });
  if (hasKw(c, 'start your engines!') || /Start your engines!/i.test(o)) f('enters', async () => {
    const pl = G.s.players[c.controller];
    if (!pl.speed) pl.speed = 1;
    return pl.speed === 1 ? ['starts its engines (speed 1)'] : [];
  }, 'Start your engines', { self: true });
  return out;
}

// "Dragons" → "dragon", "creatures" → "", "Elves and/or Warriors" → "elf or warrior"
function kindWords(w) {
  w = String(w || '').trim().toLowerCase();
  if (/^creatures?$/.test(w)) return '';
  return w.replace(/,? and\/or /g, ' or ').replace(/,? or /g, ' or ').replace(/, /g, ' or ').replace(/\bcreatures\b/g, 'creature');
}
function kindOk(c, kind) {
  if (!kind) return true;
  if (/^(creature|nontoken creature)$/.test(kind)) return isCreature(c);
  if (/^permanent$/.test(kind)) return true;
  if (/^land$/.test(kind)) return isLand(c);
  if (/^(artifact|enchantment|planeswalker)$/.test(kind)) return isType(c, kind);
  if (/^token$/.test(kind)) return !!c.token;
  return matchesFilter(c, kind);
}

function spellMatches(filter, d, c) {
  const t = d.faces[0].typeLine;
  if (!filter) return true;
  const f = filter.replace(/\bspells?\b/, '').trim();
  if (!f) return true;
  if (/noncreature/.test(f)) return !/Creature/.test(t);
  if (/instant or sorcery|instant and sorcery/.test(f)) return /Instant|Sorcery/.test(t);
  if (/^creature/.test(f)) {
    const mv = f.match(/mana value (\d+) or greater/);
    return /Creature/.test(t) && (!mv || d.cmc >= +mv[1]);
  }
  if (/^artifact/.test(f)) return /Artifact/.test(t);
  if (/^enchantment/.test(f)) return /Enchantment/.test(t);
  if (/^legendary/.test(f)) return /Legendary/.test(t);
  if (/^historic/.test(f)) return /Legendary|Artifact|Saga/.test(t);
  if (/^multicolored/.test(f)) return d.colors.length > 1;
  if (/^(white|blue|black|red|green)/.test(f)) return d.colors.includes({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[f.split(' ')[0]]);
  if (/kicked/.test(f)) return !!(c && c.kicked);
  if (/^(instant|sorcery)/.test(f)) return new RegExp(f.split(' ')[0], 'i').test(t);
  // creature types: "Vampire spell", "Dragon spell", "Elf or Warrior spell"
  const subs = subtypeWords(f);
  if (subs.length) return subs.some((st) => (c ? hasSubtype(c, st) : new RegExp('\\b' + st + 's?\\b', 'i').test(t)));
  return true;
}

// ------------------------------------------------------------ which triggers does an event set off?
function onField() {
  const out = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter((c) => !c.faceDown);
  // Eminence: commanders' abilities that also work from the command zone
  for (const pid of ['p', 'ai']) for (const c of cardsIn(pid, 'command')) if (c.isCommander && /(?:^|\n)Eminence — /.test((DB[c.def].faces[0] || {}).oracle || '')) out.push(c);
  return out;
}

function matches(ev) {
  const out = [];
  const each = (fn) => {
    for (const c of onField()) for (const trig of triggersOf(c)) fn(c, trig);
  };
  const whoOk = (trigWho, c, pid) => !trigWho || (trigWho === 'you' ? pid === c.controller : trigWho === 'an opponent' ? pid !== c.controller : true);
  switch (ev.type) {
    case 'enters': {
      const nc = card(ev.iid);
      if (!nc) break;
      // the permanent's own "when ~ enters"
      if (!nc.faceDown) for (const trig of triggersOf(nc)) if (trig.event === 'enters' && trig.self) out.push({ src: nc, trig });
      const seenOnce = new Set();
      each((c, trig) => {
        if (trig.event !== 'enters' || trig.self) return;
        if (trig.other === true && c.iid === nc.iid && !trig.kw) return;
        if (c.iid === nc.iid && trig.kw) return;
        if (trig.mine && nc.controller !== c.controller) return;
        if (trig.theirs && nc.controller === c.controller) return;
        if (trig.nontoken && nc.token) return;
        if (!kindOk(nc, trig.kind)) return;
        if (trig.once) {
          const key = c.iid + trig.raw;
          if (seenOnce.has(key) || ev.batchSeen) return;
          seenOnce.add(key);
        }
        out.push({ src: c, trig, it: { iid: nc.iid } });
      });
      break;
    }
    case 'dies': {
      const dead = card(ev.iid) || { iid: ev.iid, def: ev.def, face: ev.face, controller: ev.controller, owner: ev.owner, zone: 'graveyard', counters: ev.counters || {}, token: ev.token, grants: [] };
      const ghost = { ...dead, zone: 'battlefield', counters: ev.counters || {}, controller: ev.controller };
      for (const trig of triggersOf(ghost, ev.def)) if (trig.event === 'dies' && trig.self) out.push({ src: dead, trig, controller: ev.controller });
      if (ev.wasBlitzed) out.push({ src: dead, trig: { event: 'dies', text: 'draw a card', raw: 'Blitz' }, controller: ev.controller });
      // "When enchanted creature dies" / "Whenever equipped creature dies"
      for (const aid of ev.attached || []) {
        const a = card(aid);
        if (!a) continue;
        for (const trig of triggersOf({ ...a, zone: 'battlefield' })) if (trig.event === 'dies' && trig.attachedTo) out.push({ src: a, trig, controller: ev.attachedCtl && ev.attachedCtl[aid] || a.controller, it: { iid: ev.iid } });
      }
      each((c, trig) => {
        if (trig.event !== 'dies' || trig.self || trig.attachedTo) return;
        if (trig.other && c.iid === ev.iid) return;
        if (trig.nontoken && ev.token) return;
        if (trig.mine && ev.controller !== c.controller) return;
        if (trig.theirs && ev.controller === c.controller) return;
        if (trig.kind && !matchesFilter({ ...ghost, zone: 'battlefield' }, trig.kind)) return;
        out.push({ src: c, trig, it: { iid: ev.iid } });
      });
      // equipment / auras: "whenever equipped creature dies"
      break;
    }
    case 'leaves': {
      const gone = card(ev.iid) || { iid: ev.iid, def: ev.def, face: ev.face, controller: ev.controller, owner: ev.owner, zone: ev.to, counters: {}, grants: [] };
      for (const trig of triggersOf({ ...gone, zone: 'battlefield', controller: ev.controller }, ev.def)) if (trig.event === 'leaves' && trig.self && (!trig.toZone || trig.toZone === ev.to)) out.push({ src: gone, trig, controller: ev.controller });
      const goneDef = DB[ev.def];
      each((c, trig) => {
        if (trig.event !== 'leaves' || !(trig.mine || trig.anyController) || c.iid === ev.iid) return;
        if (trig.mine && c.controller !== ev.controller) return;
        if (trig.tokenOnly && !ev.token) return;
        if (trig.nontoken && (ev.token || (gone && gone.token))) return;
        if (trig.kind === 'creature' && goneDef && !/Creature/.test(goneDef.faces[ev.face || 0] ? goneDef.faces[ev.face || 0].typeLine : goneDef.typeLine)) return;
        out.push({ src: c, trig, it: { iid: ev.iid }, wasAttacking: ev.wasAttacking });
      });
      // championed / exiled-until cards come back; Oubliette's creature phases back in
      for (const x of Object.values(G.s.cards)) {
        if (x.phasedOut && x.phasedUntil === ev.iid) {
          delete x.phasedOut;
          delete x.phasedUntil;
          if (x.phaseInTapped) x.tapped = true;
          delete x.phaseInTapped;
          for (const a of Object.values(G.s.cards)) if (a.attachedTo === x.iid) delete a.phasedOut;
          log(x.controller, `${nameTag(x)} phases in.`);
          continue;
        }
        if (x.zone === 'exile' && (x.championedBy === ev.iid || x.exiledBy === ev.iid)) {
          delete x.championedBy;
          delete x.exiledBy;
          toBattlefield(x.iid, x.owner);
          log(x.owner, `${nameTag(x)} returns to the battlefield.`);
        }
      }
      break;
    }
    case 'toGraveyard': {
      const gc = card(ev.iid);
      if (!gc) break;
      const tl = (DB[gc.def].faces[0].typeLine || DB[gc.def].typeLine || '');
      each((c, trig) => {
        if (trig.event !== 'toGraveyard') return;
        if (trig.mine && c.controller !== (trig.fromBf ? ev.controller : ev.owner)) return;
        if (trig.notFromBf && ev.from === 'battlefield') return;
        if (trig.fromBf && ev.from !== 'battlefield') return;
        const ok = trig.kind.split(/\s+/).every((w) => {
          if (w === 'permanent') return /Artifact|Creature|Enchantment|Land|Planeswalker|Battle/.test(tl);
          if (w === 'card') return true;
          return new RegExp('\\b' + w.replace(/s$/, ''), 'i').test(tl) || (/^[a-z]+$/.test(w) && hasSubtype({ ...gc, zone: 'battlefield' }, w));
        });
        if (ok) out.push({ src: c, trig, it: { iid: ev.iid } });
      });
      break;
    }
    case 'putIntoGraveyard': {
      // noncreature permanents: "When ~ is put into a graveyard from the battlefield"
      const gone = card(ev.iid);
      if (gone && ev.fromBattlefield) for (const trig of triggersOf({ ...gone, zone: 'battlefield', controller: ev.controller }, ev.def)) if (trig.event === 'dies' && trig.self) out.push({ src: gone, trig, controller: ev.controller });
      each((c, trig) => trig.event === 'putIntoGraveyard' && c.controller === ev.owner && out.push({ src: c, trig }));
      break;
    }
    case 'combatDamagePlayer':
      each((c, trig) => {
        if (trig.event !== 'combatDamagePlayer') return;
        const atk = card(ev.iid);
        if (trig.self && c.iid === ev.iid) out.push({ src: c, trig, thatPlayer: ev.player });
        else if (trig.anyOfMine && c.controller === ev.controller && (!trig.kind || (atk && matchesFilter(atk, trig.kind))) && (!trig.faceUpTurn || (atk && atk.turnedUpTurn === G.s.turn)) && (!trig.enchanted || (atk && Object.values(G.s.cards).some((a) => a.attachedTo === atk.iid && a.zone === 'battlefield' && /Aura/.test(typeLine(a))))) && (!trig.withCounter || (atk && Object.entries(atk.counters || {}).some(([k, v]) => v > 0 && (trig.withCounter === 'any' || k === trig.withCounter))))) out.push({ src: c, trig, thatPlayer: ev.player, it: { iid: ev.iid } });
        else if (trig.attachedTo && c.attachedTo === ev.iid) out.push({ src: c, trig, thatPlayer: ev.player, it: { iid: ev.iid } });
      });
      // ciphered spells cast a copy
      for (const x of Object.values(G.s.cards)) {
        if (x.zone === 'exile' && x.encodedOn === ev.iid && T.castFree) out.push({ src: x, trig: { event: 'cipher', fn: async () => { await T.castFree(x.owner, x.iid, { copy: true }); return ['casts a copy of the encoded spell']; }, raw: 'Cipher' }, controller: x.owner });
      }
      break;
    case 'combatDamageOnce':
      each((c, trig) => {
        if (trig.event !== 'combatDamageOnce' || c.controller !== ev.controller) return;
        const srcs = (ev.sources || []).filter((x) => !trig.kind || (card(x.iid) && matchesFilter(card(x.iid), trig.kind)));
        if (ev.sources && !srcs.length) return;
        const amount = srcs.reduce((n, x) => n + x.amount, 0);
        out.push({ src: c, trig, thatPlayer: ev.player, amount, them: srcs.map((x) => x.iid) });
      });
      break;
    case 'attacks':
      each((c, trig) => {
        if (trig.event !== 'attacks') return;
        if (trig.self && c.iid === ev.iid) {
          if (!trig.minAttackers || ((G.s.combat && G.s.combat.attackers.length) || 0) >= trig.minAttackers) out.push({ src: c, trig, thatPlayer: ev.defender });
        } else if (trig.anyOfMine && c.controller === ev.controller && (!trig.kind || matchesFilter(card(ev.iid), trig.kind))) out.push({ src: c, trig, thatPlayer: ev.defender, it: { iid: ev.iid } });
        else if (trig.attachedTo && c.attachedTo === ev.iid) out.push({ src: c, trig, thatPlayer: ev.defender, it: { iid: ev.iid } });
        else if (trig.theirAttacker && c.controller !== ev.controller) out.push({ src: c, trig, it: { iid: ev.iid } });
      });
      break;
    case 'attacksAlone':
      each((c, trig) => {
        if (trig.event !== 'attacksAlone') return;
        if (trig.self && c.iid === ev.iid) out.push({ src: c, trig, thatPlayer: ev.defender });
        else if (trig.anyOfMine && c.controller === ev.controller) out.push({ src: c, trig, thatPlayer: ev.defender, it: { iid: ev.iid } });
      });
      break;
    case 'youAttack':
      each((c, trig) => {
        if (trig.event !== 'youAttack') return;
        if (trig.defend) {
          if (c.controller !== ev.defender || c.controller === ev.controller) return;
          // "attach this Aura to that player" does nothing when it already enchants them
          if (/attach (?:this aura|~) to that player/i.test(trig.text) && (c.enchantedPlayer || opp(c.controller)) === ev.controller) return;
          out.push({ src: c, trig, thatPlayer: ev.controller });
          return;
        }
        if (c.controller !== ev.controller) return;
        let ids = (G.s.combat && G.s.combat.attackers) || [];
        if (trig.enchanted) {
          const pl = c.enchantedPlayer || opp(c.controller);
          const tg = (G.s.combat && G.s.combat.targets) || {};
          ids = ids.filter((a) => (tg[a] || ev.defender) === pl);
          if (!ids.length && G.s.combat) return;
          if (ev.defender !== pl && !ids.length) return;
          out.push({ src: c, trig, thatPlayer: pl, amount: ids.length, them: ids });
          return;
        }
        const atk = ids.map(card).filter((a) => a && (!trig.kind || matchesFilter(a, trig.kind)));
        if (trig.kind && !atk.length) return;
        out.push({ src: c, trig, thatPlayer: ev.defender, amount: atk.length, them: atk.map((a) => a.iid) });
      });
      break;
    case 'blocks':
    case 'blocked':
    case 'unblocked':
      each((c, trig) => trig.event === ev.type && trig.self && c.iid === ev.iid && out.push({ src: c, trig, thatPlayer: ev.defender }));
      break;
    case 'upkeep':
    case 'drawStep':
    case 'beginCombat':
    case 'endStep':
    case 'mainPhase':
    case 'main2':
    case 'endCombat':
      each((c, trig) => {
        if (trig.event !== ev.type) return;
        const w = trig.whose || 'your';
        if (w === 'enchanted') {
          const host = c.attachedTo && card(c.attachedTo);
          const pl = host ? host.controller : c.enchantedPlayer || opp(c.controller);
          if (pl === ev.active) out.push({ src: c, trig, thatPlayer: pl, it: host ? { iid: host.iid } : null });
          return;
        }
        if (w === 'each' || (w === 'your' && c.controller === ev.active) || (w === "each opponent's" && c.controller !== ev.active)) out.push({ src: c, trig, thatPlayer: ev.active });
      });
      break;
    case 'turnedFaceUp': {
      const c = card(ev.iid);
      if (c) for (const trig of triggersOf(c)) if (trig.event === 'turnedFaceUp' && trig.self) out.push({ src: c, trig });
      break;
    }
    case 'dealtDamage':
    case 'dealsDamage':
    case 'dealsDamagePlayer':
    case 'combatDamageCreature':
      each((c, trig) => {
        if (trig.event !== ev.type) return;
        if (trig.self && c.iid === ev.iid) out.push({ src: c, trig, amount: ev.amount, thatPlayer: ev.player, it: ev.other ? { iid: ev.other } : null });
        else if (trig.attachedTo && c.attachedTo === ev.iid) out.push({ src: c, trig, amount: ev.amount, thatPlayer: ev.player, it: { iid: ev.iid } });
      });
      break;
    case 'landfall':
      each((c, trig) => trig.event === 'landfall' && c.controller === ev.controller && out.push({ src: c, trig, it: { iid: ev.iid } }));
      break;
    case 'cast': {
      const d = DB[ev.def];
      const sc = card(ev.iid);
      const ts = G.s.ts[ev.controller];
      each((c, trig) => {
        if (trig.event !== 'cast') return;
        if (trig.mine && c.controller !== ev.controller) return;
        if (trig.theirs && c.controller === ev.controller) return;
        if (trig.notSelf && c.iid === ev.iid) return;
        if (trig.first && ts.spells !== 1) return;
        if (trig.second && ts.spells !== 2) return;
        if (!spellMatches(trig.spell, d, sc)) return;
        if (trig.from) {
          const z = ev.from || (sc && sc.castFrom) || 'hand';
          const want = trig.from.toLowerCase();
          if (want === 'your hand' && z !== 'hand') return;
          if (want === 'your graveyard' && z !== 'graveyard') return;
          if (want === 'exile' && z !== 'exile') return;
          if (want === 'anywhere other than your hand' && z === 'hand') return;
        }
        out.push({ src: c, trig, it: { iid: ev.iid }, thatPlayer: ev.controller });
      });
      break;
    }
    case 'castSelf': {
      const sc = card(ev.iid);
      if (sc) for (const trig of triggersOf(sc)) if (trig.event === 'castSelf') out.push({ src: sc, trig, controller: ev.controller });
      break;
    }
    case 'draw':
      each((c, trig) => trig.event === 'draw' && whoOk(trig.who, c, ev.pid) && (!trig.second || ev.nth === 2) && out.push({ src: c, trig, thatPlayer: ev.pid }));
      break;
    case 'discard':
      each((c, trig) => trig.event === 'discard' && whoOk(trig.who, c, ev.pid) && out.push({ src: c, trig, thatPlayer: ev.pid, it: { iid: ev.iid } }));
      break;
    case 'cycle': {
      const sc = card(ev.iid);
      if (sc) for (const trig of triggersOf(sc)) if (trig.event === 'cycle' && trig.self) out.push({ src: sc, trig, controller: ev.pid });
      each((c, trig) => trig.event === 'cycle' && !trig.self && (trig.anyPlayer || (trig.oppOnly ? c.controller !== ev.pid : c.controller === ev.pid)) && out.push({ src: c, trig, thatPlayer: ev.pid }));
      break;
    }
    case 'lifeGained':
    case 'lifeLost':
      each((c, trig) => trig.event === ev.type && whoOk(trig.who, c, ev.pid) && out.push({ src: c, trig, thatPlayer: ev.pid, amount: ev.amount }));
      break;
    case 'counterPut': {
      const tgt = card(ev.iid);
      if (!tgt || ev.kind !== '+1/+1') break;
      each((c, trig) => {
        if (trig.event !== 'counterPut') return;
        if (trig.self && c.iid === ev.iid) out.push({ src: c, trig });
        else if (trig.anyOfMine && c.controller === tgt.controller && isCreature(tgt)) out.push({ src: c, trig, it: { iid: ev.iid }, amount: ev.n });
      });
      break;
    }
    case 'sacrificed':
      each((c, trig) => {
        if (trig.event !== 'sacrificed') return;
        const who = trig.who || 'you';
        if (who === 'you' && c.controller !== ev.controller) return;
        if (who === 'an opponent' && c.controller === ev.controller) return;
        if (trig.other && c.iid === ev.iid) return;
        if (trig.nontoken && ev.token) return;
        if (trig.yourTurn && G.s.active !== c.controller) return;
        if (!(/permanent/.test(trig.kind) || new RegExp(trig.kind.replace(/^(?:another |one or more )/, '').replace(/s$/, ''), 'i').test(ev.types))) return;
        out.push({ src: c, trig, it: { iid: ev.iid }, thatPlayer: ev.controller });
      });
      break;
    case 'tokensCreated':
      each((c, trig) => trig.event === 'tokensCreated' && c.controller === ev.pid && out.push({ src: c, trig }));
      break;
    case 'scry':
    case 'surveil':
    case 'ringTempts':
      each((c, trig) => trig.event === ev.type && c.controller === ev.pid && out.push({ src: c, trig }));
      break;
    case 'explored':
    case 'monstrous':
    case 'exploited':
    case 'transformed':
    case 'mutates':
      each((c, trig) => trig.event === ev.type && (trig.self ? c.iid === ev.iid : c.controller === ev.controller) && out.push({ src: c, trig, it: { iid: ev.iid } }));
      break;
    case 'classLevel': {
      const c = card(ev.iid);
      if (c) for (const trig of triggersOf(c)) if (trig.event === 'classLevel' && trig.level === ev.level) out.push({ src: c, trig });
      break;
    }
    case 'chapter': {
      const c = card(ev.iid);
      if (c) for (const trig of triggersOf(c)) if (trig.event === 'chapter' && trig.chapters.includes(ev.chapter)) out.push({ src: c, trig });
      break;
    }
  }
  return out;
}

// ------------------------------------------------------------ special events
async function specialEvent(ev) {
  const ch = T.choosers;
  if (ev.type === 'payToUntap') {
    const c = card(ev.iid);
    if (!c || c.zone !== 'battlefield' || !c.tapped) return true;
    const pl = G.s.players[ev.controller];
    let pay;
    if (ev.controller === 'ai') {
      // pay when it's the AI's own turn and it can afford the life (it wants to use the mana now)
      pay = G.s.active === 'ai' && pl.life > 10 + ev.life && G.s.turn > 2;
    } else pay = await T.confirm(cardName(c), `Pay ${ev.life} life so ${cardName(c)} enters untapped?`);
    if (pay) {
      pl.life -= ev.life;
      G.s.ts[ev.controller].lifeLost += ev.life;
      c.tapped = false;
      log(ev.controller, `${ev.controller === 'p' ? 'You pay' : 'The AI pays'} ${ev.life} life; ${nameTag(c)} enters untapped.`);
    } else log(ev.controller, `${nameTag(c)} enters tapped.`);
    T.render();
    return true;
  }
  if (ev.type === 'legendRule') {
    await legendChoice(ev);
    return true;
  }
  if (ev.type === 'upkeep' && G.s.initiative === ev.active) {
    await venture(ev.active, { me: ev.active, choosers: ch, render: T.render }, { undercity: true });
    T.render();
  }
  if (ev.type === 'takeInitiative') {
    if (G.s.initiative !== ev.pid) await takeInitiative(ev.pid, { me: ev.pid, choosers: ch, render: T.render });
    return true;
  }
  if (ev.type === 'germ') {
    const eq = card(ev.iid);
    if (!eq) return true;
    const o = oracle(eq);
    let tok;
    if (/Living weapon/i.test(o)) [tok] = createToken(genericTokenDef(0, 0, 'Phyrexian Germ', ['B']), ev.controller, 1);
    else if (/For Mirrodin!/i.test(o)) [tok] = createToken(genericTokenDef(2, 2, 'Rebel', ['R']), ev.controller, 1);
    else if (/Job select/i.test(o)) [tok] = createToken(genericTokenDef(1, 1, 'Hero', [], {}), ev.controller, 1);
    if (tok) {
      attachTo(eq, card(tok));
      log(ev.controller, `${nameTag(eq)} enters attached to a new ${nameTag(card(tok))}.`);
    }
    return true;
  }
  if (ev.type === 'madness') {
    const c = card(ev.iid);
    if (!c || c.zone !== 'exile') return true;
    const cost = (oracle(c).match(/Madness ((?:\{[^}]+\})+)/) || [])[1];
    const yes = cost && T.castFree ? await (ev.pid === 'ai' ? Promise.resolve(true) : T.confirm(cardName(c), `Madness: cast ${cardName(c)} for ${cost}?`)) : false;
    if (yes && (await T.castFree(ev.pid, ev.iid, { cost, mode: 'madness' }))) return true;
    if (card(ev.iid) && card(ev.iid).zone === 'exile') move(ev.iid, 'graveyard');
    return true;
  }
  if (ev.type === 'draw' && ev.nth === 1 && card(ev.iid) && T.castFree) {
    const c = card(ev.iid);
    const mc = (oracle(c).match(/Miracle ((?:\{[^}]+\})+)/) || [])[1];
    if (mc && c.zone === 'hand') {
      const yes = ev.pid === 'ai' ? true : await T.confirm(cardName(c), `Miracle: cast ${cardName(c)} for ${mc}?`);
      if (yes) await T.castFree(ev.pid, ev.iid, { cost: mc, mode: 'miracle' });
    }
  }
  if (ev.type === 'mainPhase') {
    // sagas get a lore counter; rad counters mill
    for (const c of cardsIn(ev.active, 'battlefield')) if (hasSubtype(c, 'Saga') || (c.counters && c.counters.lore !== undefined && /^[IVX]+ — /m.test(face(c).oracle || ''))) loreUp(c);
    const pl = G.s.players[ev.active];
    if (pl.counters.rad > 0) {
      const ids = libTop(ev.active, pl.counters.rad);
      let lost = 0;
      for (const i of ids) {
        const nonland = !isLand(card(i));
        move(i, 'graveyard');
        if (nonland) lost++;
      }
      pl.life -= lost;
      pl.counters.rad -= lost;
      log(ev.active, `Rad counters: ${who(ev.active)} mill ${ids.length}, lose ${lost} life.`);
    }
  }
  if (ev.type === 'enters') {
    const c = card(ev.iid);
    if (c && c.counters && c.counters.lore === 0 && /^[IVX]+ — /m.test(face(c).oracle || '')) {
      // read ahead: choose a starting chapter
      let start = 1;
      if (/Read ahead/i.test(oracle(c))) {
        const max = Math.max(...[...face(c).oracle.matchAll(/^([IVX]+)(?:, ([IVX]+))* — /gm)].flatMap((m) => m[0].replace(' — ', '').split(', ').map((r) => ROMAN[r] || 0)));
        start = 1 + (await ch[c.controller].choose({ prompt: `Read ahead: start ${cardName(c)} on which chapter?`, options: Array.from({ length: max }, (_, k) => ({ label: `Chapter ${k + 1}` })), aiPick: () => 0 }));
        c.counters.lore = start - 1;
      }
      loreUp(c);
    }
  }
  return false;
}
const who = (pid) => (pid === 'p' ? 'you' : 'the AI');

function loreUp(c) {
  c.counters.lore = (c.counters.lore || 0) + 1;
  queueEvent({ type: 'chapter', iid: c.iid, chapter: c.counters.lore, controller: c.controller });
  const last = Math.max(...[...(face(c).oracle || '').matchAll(/^((?:[IVX]+)(?:, [IVX]+)*) — /gm)].flatMap((m) => m[1].split(', ').map((r) => ROMAN[r] || 0)), 0);
  if (c.counters.lore >= last && last > 0) c.sagaDone = true;
}

// ------------------------------------------------------------ settling
let running = false;

export async function settle() {
  if (running || !T.choosers) return;
  running = true;
  const s0 = G.s;
  try {
    let guard = 0;
    while (eventQueue.length && guard++ < 400) {
      const ev = eventQueue.shift();
      if (!ev) continue;
      if (G.s !== s0) break;
      if (await specialEvent(ev)) continue;
      for (const hit of matches(ev)) {
        const controller = hit.controller || hit.src.controller;
        if (controller === 'p' && !G.settings.arenaMode) {
          log('p', `${nameTag(hit.src)} triggers: <i>${esc(hit.trig.text || hit.trig.raw)}</i>`);
          continue;
        }
        try {
          await resolveTrigger(hit, controller, ev);
        } catch (e) {
          if (!(e instanceof Cancelled)) console.error(e);
        }
        if (G.s !== s0) return;
      }
      // sagas whose last chapter has resolved are sacrificed
      if (ev.type === 'chapter') {
        const c = card(ev.iid);
        if (c && c.sagaDone && c.zone === 'battlefield' && !isCreature(c)) {
          log(c.controller, `${nameTag(c)} has finished its chapters and is sacrificed.`);
          sacrifice(c.iid);
        } else if (c && c.sagaDone && isCreature(c) && /Saga Creature|Saga/.test(typeLine(c))) {
          // Final Fantasy saga creatures: exile and return transformed
          if (DB[c.def].faces.length > 1) {
            c.face = 1;
            c.counters.lore = 0;
            log(c.controller, `${nameTag(c)} transforms.`);
          }
        }
      }
    }
    if (G.s === s0) await assignSectors();
  } finally {
    running = false;
    if (G.s === s0) {
      stateBased();
      T.render();
    }
  }
}

async function legendChoice(ev) {
  const ids = ev.ids.filter((i) => card(i) && card(i).zone === 'battlefield' && card(i).controller === ev.controller);
  if (ids.length < 2) return;
  const keep = await T.choosers[ev.controller].pickCards({
    forced: true, prompt: `Legend rule: choose the ${ev.name} to keep`, cards: ids, min: 1, max: 1, purpose: 'legend',
    src: card(ids[0]), aiScore: () => 0,
  });
  for (const i of ids) {
    if (keep.includes(i)) continue;
    log(ev.controller, `Legend rule: ${nameTag(card(i))} goes to the graveyard.`);
    move(i, 'graveyard');
  }
  stateBased();
  T.render();
}

async function resolveTrigger(hit, controller, ev) {
  const { src, trig } = hit;
  if (trig.oncePerTurn) {
    src.trigTurns = src.trigTurns || {};
    if (src.trigTurns[trig.raw] === G.s.turn) return;
    src.trigTurns[trig.raw] = G.s.turn;
  }
  const ctx = {
    me: controller, choosers: T.choosers, forced: true, thatPlayer: hit.thatPlayer, it: hit.it || null, wasAttacking: hit.wasAttacking, castFree: T.castFree, deadCounters: ev && ev.counters,
    kicked: src.kicked, x: src.xPaid || 0, castMode: src.castMode, castFrom: src.castFrom, event: ev,
  };
  if (hit.amount !== undefined) {
    ctx.lastAmount = hit.amount;
    ctx.thatMuch = hit.amount;
  }
  if (hit.them) ctx.them_ = hit.them;
  if (trig.fn) {
    const did = await trig.fn(ctx, hit, ev);
    if (did && did.length) log(controller, `${nameTag(src)}: ${did.join('; ')}.`);
    stateBased();
    T.render();
    return;
  }
  let text = trig.text;
  if (trig.optional) {
    text = text.replace(/^you may /i, '');
    // the AI takes optional triggers unless they cost it something
    const yes = controller === 'ai' ? knownEffect(text) || !/sacrifice|discard|lose \d+ life|\bpay\b|exile [^.]*you control|return [^.]*you control to/i.test(text) : await T.confirm(cardName(src), `${trig.raw.replace(/~/g, cardName(src))}\n\nDo it?`);
    if (!yes) return;
  }
  const did = await resolveEffects(text, src, ctx);
  if (did.length) log(controller, `${nameTag(src)} ${trig.event === 'chapter' ? 'chapter' : 'triggers'}: ${did.join('; ')}.`);
  else if (!trig.kw && !did.skipped) log(controller, `${nameTag(src)} triggers: <i>${esc(text.slice(0, 140))}</i> — apply it by hand.`);
  stateBased();
  T.render();
}

export { isCreature, isLand, isType, oracle, face, spellText, payCost };

// Space sculptor: every creature needs a sector; its controller picks one (opponents of the sculptor's controller first).
export async function assignSectors() {
  const sc = sculptors();
  if (!sc.length) return;
  const owner = sc[0].controller;
  for (const pid of [opp(owner), owner]) {
    let all = null;
    for (const iid of [...G.s.players[pid].zones.battlefield]) {
      const c = card(iid);
      if (!c || c.phasedOut || !isCreature(c) || c.sector) continue;
      const count = (sec, who) => G.s.players[who].zones.battlefield.map(card).filter((x) => x && isCreature(x) && x.sector === sec).length;
      if (all) {
        c.sector = all;
        continue;
      }
      const left = G.s.players[pid].zones.battlefield.map(card).filter((x) => x && !x.phasedOut && isCreature(x) && !x.sector).length;
      const opts = SECTORS.map((sec) => ({ label: `${SECTOR_SIGN[sec]} ${sec[0].toUpperCase() + sec.slice(1)}`, detail: `yours: ${count(sec, pid)}, theirs: ${count(sec, opp(pid))}` }));
      if (left > 1) SECTORS.forEach((sec) => opts.push({ label: `All ${left} unassigned → ${SECTOR_SIGN[sec]} ${sec}` }));
      const k = await T.choosers[pid].choose({
        prompt: `Space sculptor: choose a sector for ${cardName(c)}`,
        options: opts,
        // the AI spreads its creatures out so one sector wipe can't take them all
        aiPick: () => SECTORS.map((sec, i) => [i, count(sec, pid)]).sort((a, b) => a[1] - b[1])[0][0],
      });
      if (k >= 3) {
        all = SECTORS[k - 3];
        c.sector = all;
      } else c.sector = SECTORS[k] || 'alpha';
    }
  }
  T.render && T.render();
}

// Creature types in a player's deck, most common first.
export function deckTypes(pid) {
  const count = {};
  const pl = G.s.players[pid];
  for (const z of ['library', 'hand', 'battlefield', 'graveyard', 'command', 'exile'])
    for (const iid of pl.zones[z]) {
      const c = card(iid);
      if (!c) continue;
      const tl = DB[c.def].faces[0].typeLine || '';
      if (!/Creature|Kindred|Tribal/.test(tl.split('—')[0]) || !tl.includes('—')) continue;
      for (const w of tl.split('—')[1].trim().split(/\s+/)) if (w) count[w] = (count[w] || 0) + 1;
    }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).map(([w]) => w);
}
const COMMON_TYPES = ['Human', 'Elf', 'Goblin', 'Zombie', 'Vampire', 'Dragon', 'Angel', 'Merfolk', 'Wizard', 'Warrior', 'Soldier', 'Knight', 'Cat', 'Dinosaur', 'Sliver', 'Spirit', 'Beast', 'Elemental', 'Faerie', 'Rogue', 'Cleric', 'Pirate', 'Dog', 'Squirrel', 'Rat', 'Bird', 'Demon', 'Hydra', 'Insect', 'Snake'];
async function chooseCreatureType(pid, prompt) {
  const mine = deckTypes(pid);
  const list = [...new Set([...mine.slice(0, 12), ...COMMON_TYPES])].slice(0, 24);
  const k = await T.choosers[pid].choose({ prompt, options: list.map((t) => ({ label: t, detail: mine.includes(t) ? 'in your deck' : '' })), aiPick: () => 0 });
  return list[k] || list[0];
}

