// Triggered abilities. Game code queues events (state.queueEvent / fire); settle() finds every
// permanent whose rules text (or keyword) triggers on each event and resolves it.
import { DB } from './data.js';
import {
  abilitiesGone, isCreature, sculptors, SECTORS, SECTOR_SIGN, isLand, isType, oracle, face, hasKw, kwNum, power, toughness, cardValue, hasSubtype, payCost, typeLine,
} from './rules.js';
import {
  G, card, cardsIn, zoneOf, log, nameTag, eventQueue, queueEvent, stateBased, cardName, move, toBattlefield, addCounters, changeLife,
  createToken, genericTokenDef, sacrifice, opp, libTop, esc,
  withReadCache, discard as discardCard, draw as drawCards, ringLevel,
} from './state.js';
import { tapPerm } from './state.js';
import { emblemObjects } from './statics.js';
import {
  resolveEffects, stripName, knownEffect, bindTriggerHooks, addMana, Cancelled, attachTo, matchesFilter, spellText, pumpEOT, subtypeWords, evalCond,
} from './effects.js';
import { kwList } from './statics.js';
// Intervening "if" (rule 603.4): "At the beginning of your end step, if you gained life this turn, …" doesn't trigger at all
// when the condition is false (it's checked again when it resolves)
function interveningIfFails(hit, ev) {
  const m = String(hit.trig.text || '').match(/^if ([^,]+?), /i);
  if (!m || /^(?:you do|you don't|you did|they do|they don't|that player does|that player doesn't|it does|you can't)$/i.test(m[1]) || /\bx\b/i.test(m[1])) return false;
  try {
    const src = hit.src;
    return evalCond(m[1], { me: hit.controller || src.controller, src, thatPlayer: hit.thatPlayer, it: hit.it || null, event: ev, kicked: src.kicked, bargained: src.bargained, did: [], unknown: [] }) === false;
  } catch (e) {
    return false;
  }
}
import { venture, takeInitiative } from './dungeon.js';
import { seats, opponents, isAI, isPlayer, multiplayer } from './state.js';
import { isGoaded, noteBend, noteExert } from './state.js';
import { seatName } from './state.js';

// Filled in by ui.js: choosers for both players, a yes/no prompt, render, and casting hooks.
// The player an attacking creature is attacking (or who controls the planeswalker/battle it attacks).
// In 1v1 that's always the opponent.
function attackedPlayer(c) {
  if (!multiplayer()) return opp(c.controller);
  const t = G.s.combat && G.s.combat.targets && G.s.combat.targets[c.iid];
  if (t && isPlayer(t)) return t;
  const tc = t && card(t);
  return tc ? tc.protector || tc.controller : opp(c.controller);
}

export const T = {
  choosers: null,
  confirm: async () => true,
  render: () => {},
  castFree: null, // (pid, iid, opts) => Promise
  payMana: null, // (pid, cost, label) => Promise<boolean>
};
bindTriggerHooks(T);

export const fire = (ev) => queueEvent(ev);
function mvLimit(line) {
  const m = line.match(/spell with mana value (\d+) or (greater|more|less|fewer)/i);
  if (!m) return {};
  return /greater|more/i.test(m[2]) ? { mvMin: +m[1] } : { mvMax: +m[1] };
}

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
  const speed = G.s && c.controller ? G.s.players[c.controller].speed : 0;
  // the parse only depends on the text (and max speed): remember it (hundreds of identical tokens share one entry)
  const pkey = text + '|' + (speed >= 4 ? 1 : 0);
  let parsed = trigParseCache.get(pkey);
  if (!parsed) {
    parsed = parseTriggerText(text, speed);
    if (trigParseCache.size > 5000) trigParseCache.clear();
    trigParseCache.set(pkey, parsed);
  }
  return parsed.concat(keywordTriggers(c));
}
// helpers for the predicate triggers ('p:<event>')
const P = {
  tl: (ev) => { const d = DB[ev.def || (card(ev.iid) || {}).def]; return d ? ((d.faces[ev.face || 0] || d.faces[0]).typeLine || d.typeLine || '') : ''; },
  ntypes: (tl) => (tl.split('—')[0].match(/\b(?:Artifact|Creature|Enchantment|Instant|Sorcery|Land|Planeswalker|Battle|Kindred|Tribal)\b/g) || []).length,
  num: (w) => ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 })[String(w).toLowerCase()] || +w || 0,
  defP: (ev) => { const t = ((G.s.combat || {}).targets || {})[ev.iid] || ev.defender; if (!t) return null; if (G.s.players[t]) return t; const x = card(t); return x ? x.controller : null; },
  defenders: (ev) => {
    const out = new Set();
    for (const a of (G.s.combat || {}).attackers || []) { const ac = card(a); if (!ac || ac.controller !== ev.controller) continue; const d = P.defP({ iid: a, defender: ev.defender }); if (d) out.add(d); }
    if (!out.size && ev.defender) { const d = G.s.players[ev.defender] ? ev.defender : (card(ev.defender) || {}).controller; if (d) out.add(d); }
    return [...out];
  },
  attachedTo: (iid) => Object.values(G.s.cards).filter((a) => a.attachedTo === iid && a.zone === 'battlefield'),
  wasModified: (ev) => Object.values(ev.counters || {}).some((v) => v > 0) || (ev.attached || []).some((a) => card(a) && card(a).controller === ev.controller && /Equipment|Aura/.test(typeLine(card(a)))),
  joinAttack: (iid, d) => { const t = card(iid); const cb = G.s.combat; if (!t) return; t.tapped = true; if (!cb) return; t.attacking = true; cb.attackers = [...(cb.attackers || []), iid]; cb.targets = { ...(cb.targets || {}), [iid]: d }; },
};
const trigParseCache = new Map();
function parseTriggerText(text, speed) {
  const out = [];
  for (let line of text.split('\n')) {
    line = line.trim();
    if (/^Max speed — /i.test(line)) {
      if (speed < 4) continue;
      line = line.replace(/^Max speed — /i, '');
    }
    line = line.replace(/^[A-Z][A-Za-z0-9',.!?&\-:/ ]{1,40} — (?=When|At|Whenever|As )/, ''); // ability words: "Landfall — …", "Allons-y! — …"
    if (/^"/.test(line)) continue;
    let m;
    const add = (event, effect, extra = {}) => {
      let t = extra.fn ? '' : effect.trim().replace(/ ¶•/g, '\n•');
      // Adaptive Training Post: "if this artifact has fewer than three charge counters on it, put a charge counter on it" — "it" is the artifact
      t = t.replace(/^(if (?:this [a-z]+|~) has [^,]*counters? on it, put [^.]*?counters? on) it\b/i, '$1 ~');
      const oncePerTurn = /This ability triggers only once each turn\.?|Do this only once each turn\.?/i.test(t);
      t = t.replace(/\s*(?:This ability triggers|Do this) only once each turn\.?/i, '');
      // Bloodghast, Darklight Phoenix, Interceptor: abilities that work while the card is in its owner's graveyard
      const fromGy = !extra.self && !extra.attachedTo && /\b(?:return|put|exile) (?:~|this card) from your graveyard\b|\bif (?:~|this card) is in your graveyard\b/i.test(t) && !/return it to the battlefield tapped and attacking/i.test(t);
      out.push({ event, text: t, optional: /^you may\b/i.test(t), raw: line, oncePerTurn, ...(/Do this only once each turn/i.test(effect) ? { doOnce: true } : {}), ...(fromGy ? { fromGy } : {}), ...extra });
    };
    // Animate Dead: the leaves part is written inside the enters paragraph
    if (/^When ~ enters/.test(line) && /When ~ leaves the battlefield, that creature's controller sacrifices it\./.test(line)) add('leaves', "that creature's controller sacrifices it.", { self: true });
    // ---- scene-box sweep forms (checked first) ----
    {
      let q;
      // plural names: "Whenever Aang and Katara enter or attack", "Whenever Don & Raph attack", "attack or block"
      if ((q = line.match(/^Whenever ~ enter or attack, (.+)$/))) { add('enters', q[1], { self: true }); add('attacks', q[1], { self: true }); continue; }
      if ((q = line.match(/^Whenever ~ attack or block, (.+)$/))) { add('attacks', q[1], { self: true }); add('blocks', q[1], { self: true }); continue; }
      if ((q = line.match(/^Whenever ~ attack, (.+)$/))) { add('attacks', q[1], { self: true }); continue; }
      // Aragorn, Company Leader
      if ((q = line.match(/^Whenever you put one or more counters on ~, (.+)$/i))) { add('counterPut', q[1], { self: true, anyKindSelf: true }); continue; }
      // Invisible Woman, Sue Storm: "Whenever you put one or more +1/+1 counters on one or more other Heroes you control"
      if ((q = line.match(/^Whenever you put one or more ([+\-\d\/]+) counters on one or more other ([A-Z][\w-]+) you control, (.+)$/))) { add('counterPut', q[3], { anyKind: true, other: true, counterKindOnly: q[1], kindF: kindWords(q[2]), oncePerEvent: true }); continue; }
      if ((q = line.match(/^When ~ enters? and whenever you cast a spell with power, toughness, or mana value (\d+), (.+)$/))) {
        const k = +q[1];
        add('enters', q[2], { self: true });
        add('p:cast', q[2], { pred: (c, ev) => { if (ev.controller !== c.controller) return false; const d = DB[ev.def]; const f = d && (d.faces[0] || {}); return !!d && ((d.cmc || 0) === k || +f.power === k || +f.toughness === k); } });
        continue;
      }
      // Sower of Discord
      if (/^As ~ enters, choose two players\.$/i.test(line)) {
        add('enters', '', { self: true, fn: async (ctx, hit) => {
          const me = card(hit.src.iid);
          if (!me) return [];
          const ps = seats().filter((p) => G.s.players[p] && !G.s.players[p].lost);
          let pick = [];
          if (isAI(ctx.me)) pick = [...opponents(ctx.me).filter((p) => ps.includes(p)), ctx.me].slice(0, 2);
          else { const a = await T.choosers[ctx.me].choose({ prompt: 'Choose the first player', options: ps.map((p) => ({ label: seatName(p) })), aiPick: () => 0 }); const rest = ps.filter((_, i) => i !== a); const b2 = await T.choosers[ctx.me].choose({ prompt: 'Choose the second player', options: rest.map((p) => ({ label: seatName(p) })), aiPick: () => 0 }); pick = [ps[a], rest[b2]]; }
          me.chosenPlayers = pick;
          return [`chooses ${pick.map((p) => seatName(p)).join(' and ')}`];
        } });
        continue;
      }
      if (/^Whenever damage is dealt to one of the chosen players, the other chosen player also loses that much life\.$/i.test(line)) {
        add('p:lifeLost', '', { pred: (c, ev) => ev.byDamage && ev.amount > 0 && (c.chosenPlayers || []).includes(ev.pid) && { thatPlayer: ev.pid, amount: ev.amount },
          fn: async (ctx, hit, ev) => { const o = (card(hit.src.iid).chosenPlayers || []).find((p) => p !== ev.pid); if (!o) return []; changeLife(o, -ev.amount); return [`${seatName(o)} loses ${ev.amount} life`]; } });
        continue;
      }
      // Hordewing Skaab: one trigger for the whole combat damage step, counting the opponents hit
      if ((q = line.match(/^Whenever one or more ([A-Z]\w+?)s you control deal combat damage to one or more of your opponents, (.+)$/))) {
        const sub = q[1];
        add('p:combatDamageAll', q[2], { pred: (c, ev) => { if (ev.controller !== c.controller) return false; const hit = Object.entries(ev.players || {}).filter(([v, srcs]) => opponents(c.controller).includes(v) && srcs.some((x) => card(x.iid) && hasSubtype(card(x.iid), sub))); return hit.length > 0 && { amount: hit.length }; } });
        continue;
      }
      // U.S.S. Enterprise-D: "Whenever one or more charge counters are put on ~ for the first time each turn, …"
      if ((q = line.match(/^Whenever one or more ([a-z+\/0-9-]+) counters are put on ~ for the first time each turn, (.+)$/i))) {
        const kind = q[1].toLowerCase();
        add('p:counterPut', q[2], { pred: (c, ev) => { if (ev.iid !== c.iid || ev.kind !== kind || !(ev.n > 0)) return false; const key = G.s.turn; if (c.firstCtrTurn === key) return false; c.firstCtrTurn = key; return true; } });
        continue;
      }
      // Coveted Jewel: "Whenever one or more creatures an opponent controls attack you and aren't blocked, that player draws three cards and gains control of ~. Untap it."
      if (/^Whenever one or more creatures an opponent controls attack you and aren't blocked, that player draws three cards and gains control of (?:~|this artifact)\. Untap it\.$/i.test(line)) {
        add('p:unblocked', '', { pred: (c, ev) => { const a = card(ev.iid); if (!a || ev.defender !== c.controller || a.controller === c.controller) return false; const key = G.s.turn + ':' + ((G.s.combatNo || {})[a.controller] || 0) + ':' + a.controller; if (c.jewelKey === key) return false; c.jewelKey = key; return { thatPlayer: a.controller }; },
          fn: async (ctx, hit) => { const me = card(hit.src.iid); const who = hit.thatPlayer; if (!me || me.zone !== 'battlefield' || !who) return []; drawCards(who, 3); move(me.iid, 'battlefield', { controller: who }); me.zone = 'battlefield'; me.tapped = false; return [`${nameTag(me)} goes to ${seatName(who)} (untapped)`]; } });
        continue;
      }
      // Mindblade Render: "Whenever your opponents are dealt combat damage, if any of that damage was dealt by a Warrior, ..."
      if ((q = line.match(/^Whenever your opponents are dealt combat damage, if any of that damage was dealt by an? ([A-Z]\w+), (.+)$/))) {
        const sub = q[1];
        add('p:combatDamageAll', q[2], { pred: (c, ev) => Object.entries(ev.players || {}).some(([v, srcs]) => opponents(c.controller).includes(v) && srcs.some((x) => x.amount > 0 && card(x.iid) && hasSubtype(card(x.iid), sub))) });
        continue;
      }
      // Glowing One
      if ((q = line.match(/^Whenever an opponent mills a nonland card, (.+)$/i))) { add('p:mill', q[1], { pred: (c, ev) => ev.pid !== c.controller && (ev.ids || []).some((i) => card(i) && !isLand(card(i))) && { thatPlayer: ev.pid } }); continue; } // Infesting Radroach
      if ((q = line.match(/^Whenever a player mills a nonland card, (.+)$/i))) { add('mill', q[1], { anyPlayer: true, kind: 'nonland', perCard: true }); continue; }
      // Lynde, Cheerful Tormentor
      if ((q = line.match(/^Whenever a Curse is put into your graveyard from the battlefield, (.+)$/i))) { add('dies', q[1], { kind: 'curse', anyPermanent: true, ownedByMe: true }); continue; }
      // Overencumbered
      if ((q = line.match(/^At the beginning of combat on enchanted opponent's turn, (.+)$/i))) { add('beginCombat', q[1], { whose: 'enchanted' }); continue; }
      // Parnesse (first ability: like ward, handled where targets are chosen)
      if (/^Whenever you or a permanent you control becomes the target of a spell or ability an opponent controls, counter that spell or ability unless that player pays (\d+) life\.$/i.test(line)) { add('ruleMarker', 'rule marker noop', {}); continue; }
      // Unbound Flourishing
      if ((q = line.match(/^Whenever you cast an instant or sorcery spell or activate an ability, if that spell's mana cost or that ability's activation cost contains \{X\}, (.+)$/i))) { add('cast', q[1], { spell: 'instant or sorcery', mine: true, hasX: true }); continue; }
      if ((q = line.match(/^Whenever you cast a permanent spell with a mana cost that contains \{X\}, (.+)$/i))) { add('cast', q[1], { spell: 'permanent', mine: true, hasX: true }); continue; }
      // Storm, Queen of Wakanda
      if ((q = line.match(/^Whenever a creature with flying attacks you, (.+)$/i))) { add('attacks', q[1], { attacksMeFlying: true }); continue; }
      // The Fantasticar
      if ((q = line.match(/^Whenever you cast your fourth noncreature spell each turn, (.+)$/i))) { add('cast', q[1], { spell: 'noncreature', mine: true, nthNoncreature: 4 }); continue; }
      // Zurzoth
      if ((q = line.match(/^Whenever an opponent draws their first card each turn, (.+)$/i))) { add('draw', q[1], { who: 'an opponent', nthDraw: 1 }); continue; }
      // Mirrorwing Dragon
      // Feather, Radiant Arbiter: copies chosen as the spell picks its target (effects.js pickTargets)
      if (/^Whenever you cast a noncreature spell that targets only ~, you may choose any number of other creatures that spell could target and pay \{2\} for each of those creatures\./i.test(line)) { add('ruleMarker', 'rule marker noop', {}); continue; }
      // Mirrorwing Dragon / Zada: copied as the spell picks its target (effects.js pickTargets), not as a trigger
      if (/^Whenever (?:a player casts|you cast) an instant or sorcery spell that targets only ~, (?:that player copies|copy) that spell for each other creature (?:they|you) control that the spell could target\. Each copy targets a different one of those creatures\.$/i.test(line)) { add('ruleMarker', 'rule marker noop', {}); continue; }
      if (false) { out.push({ event: 'becomesTarget', self: true, spellOnly: true, mirrorwing: true, raw: line, fn: async (ctx, hit, ev) => {
        const sp = ev && ev.spell && card(ev.spell);
        if (!sp || !/Instant|Sorcery/.test(DB[sp.def].faces[0].typeLine || '')) return [];
        // "targets only this creature": the spell chose no other target
        if ((ev.tlog || []).length !== 1) return [];
        const caster = ev.controller;
        const others = cardsIn(caster, 'battlefield').filter((c) => isCreature(c) && c.iid !== hit.src.iid);
        const did = [];
        for (const o of others) { const d = await resolveEffects(spellText(sp), { ...sp, controller: caster }, { me: caster, choosers: T.choosers, castFree: T.castFree, forcePick: o.iid, x: sp.xPaid || 0, forced: true }); did.push(`copy at ${nameTag(o)}${d.length ? ': ' + d.join('; ') : ''}`); }
        return did;
      } }); continue; }
      // Giggling Skitterspike
      if ((q = line.match(/^Whenever ~ attacks, blocks, or becomes the target of a spell, (.+)$/i))) { add('attacks', q[1], { self: true }); add('blocks', q[1], { self: true }); add('becomesTarget', q[1], { self: true, spellOnly: true }); continue; }
      // Trouble in Pairs
      if ((q = line.match(/^Whenever an opponent attacks you with two or more creatures, draws their second card each turn, or casts their second spell each turn, (.+)$/i))) { add('youAttack', q[1], { oppAttacksMe: 2 }); add('draw', q[1], { who: 'an opponent', nthDraw: 2 }); add('cast', q[1], { spell: '', theirs: true, second: true }); continue; }
      // Daredevil, Fearless Fighter
      if ((q = line.match(/^Whenever a source you control deals damage to you, (.+)$/i))) { add('dealsDamage', q[1], { anySourceMine: true, toSelf: true }); continue; }
      // Marvo, Deep Operative
      if ((q = line.match(/^Whenever you win a clash, (.+)$/i))) { add('clashWon', q[1], {}); continue; }
      // Turf War
      if ((q = line.match(/^Whenever a creature deals combat damage to a player, (if .+)$/i))) { add('combatDamagePlayer', q[1], { anyCreatureAny: true }); continue; }
      // Tetzin, Gnome Champion
      if ((q = line.match(/^Whenever ~ or another double-faced artifact you control enters, (.+)$/i))) { add('enters', q[1], { self: true }); add('enters', q[1], { mine: true, other: true, dfcArt: true }); continue; }
      // Avatar Aang
      if ((q = line.match(/^Whenever you waterbend, earthbend, firebend, or airbend, (.+)$/i))) { add('bend', q[1], {}); continue; }
      // Rohirrim Chargers
      if ((q = line.match(/^Whenever you exert a creature, (.+)$/i))) { add('exerted', q[1], {}); continue; }
      // Vivi's Persistence / Endless Ranks of HYDRA (from the graveyard too)
      if ((q = line.match(/^Whenever your commander enters or attacks, (.+)$/i))) { add('enters', q[1], { mine: true, commander: true }); add('attacks', q[1], { anyOfMine: true, commander: true }); continue; }
      // Squall, Gunblade Duelist
      if ((q = line.match(/^Whenever one or more creatures attack one of your opponents, if any of those creatures have power or toughness equal to the chosen number, (.+)$/i))) { add('youAttack', q[1], { chosenNumberAtk: true }); continue; }
      // Seifer, Balamb Rival
      if ((q = line.match(/^Whenever a creature attacking one of your opponents becomes blocked by (two|three) or more creatures, (.+)$/i))) { add('blocked', q[2], { attackingMyOpp: true, minBlockers: q[1] === 'two' ? 2 : 3 }); continue; }
      // Loki, God of Mischief
      if ((q = line.match(/^Whenever a player or permanent becomes the target of an ability you control, (.+)$/i))) { add('abilityTargets', q[1], {}); continue; }
      // Firebender Ascension: handled where attack triggers are gathered (matches)
      if ((q = line.match(/^Whenever a creature you control attacking causes a triggered ability of that creature to trigger, (.+)$/i))) { add('ascensionMarker', q[1], {}); continue; }

      if ((q = line.match(/^Whenever you put (?:a|one or more) counters? on (?:a|an|one or more) ([A-Z][\w-]+(?:, [A-Z][\w-]+)*,? or [A-Z][\w-]+|[^,]+?)(?: you control)?, (.+)$/))) { add('counterPut', q[2], { anyKind: true, kindF: kindWords(q[1]) }); continue; }
      // Abomination: "Whenever a Gamma or Villain you control deals combat damage to a player"
      if ((q = line.match(/^Whenever an? ([A-Z][\w-]+) or ([A-Z][\w-]+) you control deals combat damage to a player, (.+)$/))) { add('combatDamagePlayer', q[3], { anyOfMine: true, kind: `${q[1].toLowerCase()} or ${q[2].toLowerCase()}` }); continue; }
      // Aang, at the Crossroads
      if ((q = line.match(/^When(?:ever)? another creature you control leaves the battlefield, (.+)$/i))) { add('leaves', q[1], { mine: true, kind: 'creature' }); continue; }
      // Fangorn: "Whenever one or more Treefolk you control attack"
      if ((q = line.match(/^Whenever one or more ([A-Z][\w-]+) you control attack, (.+)$/))) { add('youAttack', q[2], { kindCount: q[1] }); continue; }
      // Fire Lord Azula
      if ((q = line.match(/^Whenever you cast a spell while ~ is attacking, (.+)$/i))) { add('cast', q[1], { spell: '', mine: true, whileAttacking: true }); continue; }
      // Mirkwood Bats
      if ((q = line.match(/^Whenever you create or sacrifice a token, (.+)$/i))) { add('tokensCreated', q[1]); add('sacrificed', q[1], { kind: 'token', who: 'you' }); continue; }
      // Necklace of Girion
      if ((q = line.match(/^Whenever you cast an? ([a-z]+) spell and whenever an? ([A-Z][a-z]+) you control enters, (.+)$/))) { add('cast', q[3], { spell: q[1], mine: true }); add('enters', q[3], { mine: true, kind: q[2].toLowerCase() }); continue; }
      // Noctis
      if ((q = line.match(/^Whenever a creature you control enters during combat, (.+)$/i))) { add('enters', q[1], { mine: true, kind: 'creature', duringCombat: true }); continue; }
      // Orcish Bowmasters
      if ((q = line.match(/^When ~ enters and whenever an opponent draws a card except the first one they draw in each of their draw steps, (.+)$/i))) { add('enters', q[1], { self: true }); add('draw', q[1], { who: 'an opponent', notFirstInDrawStep: true }); continue; }
      // Smaug the Impenetrable
      if ((q = line.match(/^Whenever ~ is dealt noncombat damage, (.+)$/i))) { add('dealtDamage', q[1], { self: true, noncombat: true }); continue; }
      // The Great Goblin: "Whenever another Goblin, Orc, or Army you control dies"
      if ((q = line.match(/^Whenever another ([A-Z][\w-]+(?:, [A-Z][\w-]+)*,? or [A-Z][\w-]+) you control dies, (.+)$/))) { add('dies', q[2], { other: true, mine: true, kind: kindWords(q[1]) }); continue; }
      // Witch-king of Angmar
      if ((q = line.match(/^Whenever one or more creatures deal combat damage to you, (.+)$/i))) { add('combatDamagedMe', q[1], {}); continue; }
      // Thor, Guardian of Midgard
      if ((q = line.match(/^Whenever a source you control deals noncombat damage to an opponent, (.+)$/i))) { add('dealsDamage', q[1], { anySourceMine: true, noncombat: true, toOpp: true }); continue; }
      // Edea
      if ((q = line.match(/^Whenever a creature you control but don't own dies, (.+)$/i))) { add('dies', q[1], { mine: true, kind: 'creature', notOwnedDies: true }); continue; }
      // Elrond: "Whenever a creature you control with a +1/+1 counter on it becomes the target of a spell or ability an opponent controls"
      if ((q = line.match(/^Whenever a creature you control with an? ([+\-\d\/a-z]+) counter on it becomes the target of a spell or ability an opponent controls, (.+)$/i))) { add('becomesTarget', q[2], { sub: 'Creature', withCounter: q[1], oppOnly: true }); continue; }
      // Éomer
      if ((q = line.match(/^Whenever one or more other attacking ([a-z]+ )?creatures you control die, (.+)$/i))) { add('dies', q[2], { other: true, mine: true, kind: (q[1] || '').trim() ? (q[1] || '').trim() + ' creature' : 'creature', attackingOnly: true }); continue; }
      // The Sensational She-Hulk
      if ((q = line.match(/^Whenever a creature you control is dealt damage, (.+)$/i))) { add('dealtDamage', q[1], { anyMineDealt: true }); continue; }
      // Rinoa
      if ((q = line.match(/^Whenever one or more attacking creatures you control die, (.+)$/i))) { add('dies', q[1], { mine: true, kind: 'creature', attackingOnly: true }); continue; }
    }
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
    } else if ((m = line.match(/^Whenever ~ deals (\w+) or more damage, (.+)$/i))) {
      // Spinneret and Spiderling: "Whenever ~ deals 4 or more damage"
      add('dealsDamage', m[2], { self: true, minAmount: /^\d+$/.test(m[1]) ? +m[1] : { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 }[m[1].toLowerCase()] || 1 });
    } else if ((m = line.match(/^Whenever ~ deals damage(?: to a player| to an opponent)?, (.+)$/i)) && !/combat damage/i.test(line)) {
      add(/to a player|to an opponent/i.test(line) ? 'dealsDamagePlayer' : 'dealsDamage', m[1], { self: true, oppOnly: /to an opponent/i.test(line) });
    } else if ((m = line.match(/^Whenever (?:enchanted|equipped) creature deals damage, (.+)$/i))) {
      add('dealsDamage', m[1], { attachedTo: true });
    } else if ((m = line.match(/^Whenever (?:enchanted|equipped) creature deals damage to (a player|an opponent), (.+)$/i))) {
      // Curiosity, Ophidian Eye, Sigil of Sleep: any damage, combat or not
      add('dealsDamagePlayer', m[2], { attachedTo: true, oppOnly: /opponent/i.test(m[1]) });
    } else if ((m = line.match(/^Whenever ~ deals combat damage to a creature, (.+)$/i))) {
      add('combatDamageCreature', m[1], { self: true });
    } else if ((m = line.match(/^Whenever ~ and at least (one|two|three|\d+) other creatures? attack, (.+)$/i))) {
      add('attacks', m[2], { self: true, minAttackers: 1 + ({ one: 1, two: 2, three: 3 }[m[1].toLowerCase()] || +m[1]) });
    } else if ((m = line.match(/^Whenever one or more creatures you control with (counters on them|power (\d+) or greater) deal combat damage to a player, (.+)$/i))) {
      // Tidus, Yuna's Guardian / Tifa, Martial Artist
      add('combatDamageOnce', m[3], m[2] ? { minPower: +m[2] } : { withCounters: true });
    } else if ((m = line.match(/^At the beginning of (?:your second main phase|your postcombat main phase|each of your postcombat main phases|your second main phase each turn), (.+)$/i))) {
      add('main2', m[1], { whose: 'your' });
    } else if ((m = line.match(/^At the beginning of (?:the upkeep of enchanted creature's controller|enchanted creature's controller's upkeep|enchanted player's upkeep), (.+)$/i))) {
      add('upkeep', m[1], { whose: 'enchanted' });
    } else if ((m = line.match(/^Whenever (?:a player|an opponent|you) cycles? (?:a|another) card, (.+)$/i))) {
      add('cycle', m[1], { anyPlayer: /a player/i.test(line), oppOnly: /an opponent/i.test(line) });
    }
    // ---- precon batch 3
    // Grafted Exoskeleton: handled when it moves (effects attachTo / state move)
    else if (/^Whenever ~ becomes unattached from a permanent, sacrifice that permanent/i.test(line)) add('ruleMarker', 'rule marker noop', {});
    // Hammer of Nazahn: "Whenever ~ or another Equipment you control enters"
    else if ((m = line.match(/^Whenever ~ or another (Equipment|Aura|artifact|enchantment) you control enters, (.+)$/i))) {
      add('enters', m[2], { self: true });
      add('enters', m[2], { other: true, mine: true, kind: m[1].toLowerCase() });
    }
    // Glimmer Lens: "Whenever equipped creature and at least one other creature attack"
    else if ((m = line.match(/^Whenever equipped creature and at least (one|two) other creatures? attack, (.+)$/i)))
      add('youAttack', m[2], { equippedPlus: m[1].toLowerCase() === 'two' ? 2 : 1 });
    // Holy Avenger, Living Lore: "Whenever equipped creature / ~ deals combat damage" (to anything)
    else if ((m = line.match(/^Whenever (~|equipped creature) deals combat damage, (.+)$/i))) {
      const o = m[1] === '~' ? { self: true } : { attachedTo: true };
      add('combatDamagePlayer', m[2], o);
      add('combatDamageCreature', m[2], o);
    }
    // Komainu Battle Armor, Millicent: "Whenever ~ or equipped creature deals combat damage to a player"
    else if ((m = line.match(/^Whenever ~ or equipped creature deals combat damage to a player, (.+)$/i))) {
      add('combatDamagePlayer', m[1], { self: true });
      add('combatDamagePlayer', m[1], { attachedTo: true });
    } else if ((m = line.match(/^Whenever ~ or another (nontoken )?([A-Z][\w-]+) you control dies or deals combat damage to a player, (.+)$/i))) {
      add('dies', m[3], { self: true });
      add('dies', m[3], { other: true, mine: true, nontoken: !!m[1], kind: m[2].toLowerCase() });
      add('combatDamagePlayer', m[3], { self: true });
      add('combatDamagePlayer', m[3], { anyOfMine: true, other: true, kind: m[2].toLowerCase() });
    }
    // Jedit Ojanen: "Whenever ~ or another legendary creature enters"
    else if ((m = line.match(/^Whenever ~ or another ((?:[\w-]+ )?creature) enters, (.+)$/i))) {
      add('enters', m[2], { self: true });
      add('enters', m[2], { other: true, kind: m[1].toLowerCase() });
    }
    // Nick Valentine: "Whenever ~ or another artifact creature you control dies"
    else if ((m = line.match(/^Whenever ~ or another ((?:[\w-]+ )?creature) you control dies, (.+)$/i))) {
      add('dies', m[2], { self: true });
      add('dies', m[2], { other: true, mine: true, kind: m[1].toLowerCase() });
    }
    // Kingpin: "Whenever you sacrifice ~ or another creature"
    else if ((m = line.match(/^Whenever you sacrifice ~ or another (creature|artifact|permanent), (.+)$/i)))
      add('sacrificed', m[2], { kind: m[1].toLowerCase(), who: 'you' });
    // Knights of the Black Rose: "Whenever an opponent becomes the monarch"
    else if ((m = line.match(/^Whenever an opponent becomes the monarch, (.+)$/i)))
      add('becameMonarch', m[1], { theirs: true });
    // Kothophed: "Whenever a permanent owned by another player is put into a graveyard from the battlefield"
    else if ((m = line.match(/^Whenever a (permanent|creature|artifact|land) owned by another player is put into a graveyard from the battlefield, (.+)$/i)))
      add('toGraveyard', m[2], { kind: m[1].toLowerCase(), fromBf: true, theirs: true });
    // Lorcan: "Whenever a creature card is put into an opponent's graveyard from anywhere"
    else if ((m = line.match(/^Whenever an? ((?:[a-z]+ )?card) is put into an opponent's graveyard from anywhere, (.+)$/i)))
      add('toGraveyard', m[2], { kind: m[1].toLowerCase().replace(/ card$/, '') || 'card', theirs: true });
    // MACH-1: "When ~ enters and whenever you gain life"
    else if ((m = line.match(/^When ~ enters and whenever you gain life, (.+)$/i))) {
      add('enters', m[1], { self: true });
      add('lifeGained', m[1], { who: 'you', oncePerTurn: /only once each turn/i.test(line) });
    }
    // MacCready: "Whenever a creature with power 4 or greater attacks you"
    else if ((m = line.match(/^Whenever a creature with power (\d+) or greater attacks you, (.+)$/i)))
      add('youAttack', m[2], { defend: true, minPowerAtk: +m[1] });
    // Nakia: "Whenever your commander enters"
    else if ((m = line.match(/^Whenever your commander enters, (.+)$/i)))
      add('enters', m[1], { mine: true, commander: true });
    // Maddening Hex: "Whenever enchanted player casts a noncreature spell"
    else if ((m = line.match(/^Whenever enchanted player casts (?:a|an) ([^,]*?)spell, (.+)$/i)))
      add('cast', m[2], { spell: m[1].toLowerCase().trim(), enchantedPlayer: true });
    // Midnight Clock: "When the twelfth hour counter is put on ~"
    else if ((m = line.match(/^When the (twelfth|eighth|ninth|fourth|second) ([a-z]+) counter is put on ~, (.+)$/i)))
      add('counterPut', m[3], { self: true, kind: m[2].toLowerCase(), nth: { second: 2, fourth: 4, eighth: 8, ninth: 9, twelfth: 12 }[m[1].toLowerCase()] });
    // ---- precon batch 2
    // Amulet of Vigor: "Whenever a permanent you control enters tapped, untap it."
    else if ((m = line.match(/^Whenever (?:a|another) (permanent|creature|land|artifact) you control enters tapped, (.+)$/i)))
      add('enters', m[2], { mine: true, kind: m[1].toLowerCase() === 'permanent' ? '' : m[1].toLowerCase(), enteredTapped: true });
    // Mystic Sanctuary & co.: "When ~ enters untapped"
    else if ((m = line.match(/^When ~ enters untapped, (.+)$/i)))
      add('enters', m[1], { self: true, untappedOnly: true });
    // Dark Depths: "When ~ has no ice counters on it"; Darksteel Reactor: "When ~ has twenty or more charge counters on it"
    else if ((m = line.match(/^When ~ has no ([a-z]+) counters on it, (.+)$/i)))
      add('stateCounters', m[2], { self: true, kind: m[1].toLowerCase(), cmp: 'none' });
    else if ((m = line.match(/^When ~ has (\w+) or more ([a-z+\/1-]+) counters on it, (.+)$/i)))
      add('stateCounters', m[3], { self: true, kind: m[2].toLowerCase(), cmp: 'atLeast', n: { ten: 10, twenty: 20, five: 5, seven: 7, three: 3, four: 4, six: 6, eight: 8, nine: 9, fifteen: 15 }[m[1].toLowerCase()] || +m[1] || 1 });
    // Custodi Lich: "Whenever you become the monarch"
    else if ((m = line.match(/^Whenever you become the monarch, (.+)$/i)))
      add('becameMonarch', m[1], {});
    // Captain Ripley Vance: "Whenever you cast your third spell each turn"
    else if ((m = line.match(/^Whenever you cast your (third|fourth|fifth) spell each turn, (.+)$/i)))
      add('cast', m[2], { spell: '', mine: true, nth: { third: 3, fourth: 4, fifth: 5 }[m[1].toLowerCase()] });
    // Alandra: "Whenever you draw your fifth card each turn"
    else if ((m = line.match(/^Whenever you draw your (second|third|fourth|fifth|sixth|seventh) card each turn, (.+)$/i)))
      add('draw', m[2], { who: 'you', nthDraw: { second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7 }[m[1].toLowerCase()] });
    // Bob, Bilbo's Ring: "Whenever ~ attacks alone", "Whenever equipped creature attacks alone"
    else if ((m = line.match(/^Whenever ~ attacks alone, (.+)$/i)))
      add('attacksAlone', m[1], { self: true });
    else if ((m = line.match(/^Whenever (?:equipped|enchanted) creature attacks alone, (.+)$/i)))
      add('attacksAlone', m[1], { attachedTo: true });
    // Ever-Watching Threshold: "Whenever an opponent attacks, if they attacked you and/or a planeswalker you control"
    else if ((m = line.match(/^Whenever an opponent attacks(?:, if they attacked you and\/or a planeswalker you control| you(?: and\/or planeswalkers you control)?)?, (.+)$/i)))
      add('youAttack', m[1], { defend: true });
    // Duelist's Heritage: "Whenever one or more creatures attack"
    else if ((m = line.match(/^Whenever one or more creatures attack, (.+)$/i)))
      add('youAttack', m[1], { anyAttacker: true });
    // Field of Souls: "Whenever a nontoken creature is put into your graveyard from the battlefield"
    else if ((m = line.match(/^Whenever a (nontoken )?creature is put into your graveyard from the battlefield, (.+)$/i)))
      add('dies', m[2], { mine: true, nontoken: !!m[1] });
    // Boomer Scrapper: "Whenever a token you control leaves the battlefield"
    else if ((m = line.match(/^Whenever a token you control leaves the battlefield, (.+)$/i)))
      add('leaves', m[1], { mine: true, kind: 'token' });
    // Cruel Celebrant, Azlask, Caldaia Guardian: "Whenever ~ or another creature or planeswalker / colorless creature / creature … with mana value 4 or greater … you control dies"
    else if ((m = line.match(/^Whenever ~ or another (creature or planeswalker|colorless creature|creature) you control( with mana value \d+ or greater)? dies, (.+)$/i))) {
      add('dies', m[3], { self: true });
      add('dies', m[3], { other: true, mine: true, kind: m[1].toLowerCase() === 'creature' ? (m[2] ? 'creature' + m[2] : '') : m[1].toLowerCase(), noncreatureToo: /planeswalker/i.test(m[1]) });
    }
    // Archon of Redemption, Campsite Cuisine: "Whenever ~ or another creature you control with flying enters", "~ or a legendary creature you control enters"
    else if ((m = line.match(/^Whenever ~ or (?:another|a|an) ((?:[\w-]+ )?creature) you control( with [a-z ]+?)? enters, (.+)$/i))) {
      add('enters', m[3], { self: true });
      // Gylwain: "~ or another nontoken creature you control enters" — tokens don't count
      const kd = (m[1] + (m[2] || '')).toLowerCase().trim();
      add('enters', m[3], { other: true, mine: true, kind: kd.replace(/^nontoken /, ''), nontoken: /^nontoken /.test(kd) });
    }
    // Fathom Mage: "Whenever a +1/+1 counter is put on ~"
    else if ((m = line.match(/^Whenever a (\+1\/\+1|[a-z]+) counter is put on ~, (.+)$/i)))
      add('counterPut', m[2], { self: true, kind: m[1].toLowerCase() });
    // Crypt Ghast, Mirari's Wake, Caged Sun: mana abilities handled when the mana is made (rules.js)
    else if (/^Whenever (?:you tap|a player taps) (?:a|an) [^,]*for mana, add /i.test(line) || /^Whenever a land's ability causes you to add/i.test(line)) add('ruleMarker', 'rule marker noop', {});
    // Frontier Siege (Khans): "At the beginning of each of your main phases, add {G}{G}."
    else if ((m = line.match(/^At the beginning of each of your main phases, (.+)$/i))) {
      add('mainPhase', m[1], { whose: 'your' });
      add('main2', m[1], { whose: 'your' });
    }
    else if ((m = line.match(/^When(?:ever)? ~ (?:enters?|enters? the battlefield)(?: or attacks| or dies| or deals combat damage to a player)?(?: under your control)?(?: from your graveyard| from exile)?, (.+)$/i))) {
      add('enters', m[1], { self: true });
      if (/or attacks/i.test(line)) add('attacks', m[1], { self: true });
      if (/or dies/i.test(line)) add('dies', m[1], { self: true });
      if (/or deals combat damage to a player/i.test(line)) add('combatDamagePlayer', m[1], { self: true }); // Tivit
    } else if ((m = line.match(/^When(?:ever)? ~ or another (nontoken )?(creature|artifact|enchantment|permanent|[A-Z]\w+) (?:you control )?enters(?: the battlefield)?(?: under your control)?, (.+)$/i))) {
      add('enters', m[3], { self: true });
      add('enters', m[3], { other: true, kind: m[2].toLowerCase(), mine: true, nontoken: !!m[1] });
    } else if ((m = line.match(/^When(?:ever)? (another|a|an|one or more|one or more other) (nontoken )?([A-Z][\w-]+s?, (?:[A-Z][\w-]+s?, )*(?:or|and\/or) )([A-Z][\w-]+)s? you control enters?(?: the battlefield)?, (.+)$/))) {
      add('enters', m[5], { other: /another|other/.test(m[1]), kind: kindWords(m[3] + m[4]), mine: true, nontoken: !!m[2], once: /one or more/.test(m[1]) });
    } else if ((m = line.match(/^Whenever (another|a|an) (nontoken )?((?:[\w-]+ ){0,2}?)(creature|[A-Z][\w-]+) you control enters or dies, (.+)$/i))) {
      // Daxos, Blessed by the Sun: "Whenever another creature you control enters or dies, you gain 1 life."
      const other = m[1].toLowerCase() === 'another';
      const sub = m[4].toLowerCase() === 'creature' ? '' : m[4].toLowerCase();
      add('enters', m[5], { other, kind: (m[3] + m[4]).toLowerCase().trim(), mine: true, nontoken: !!m[2] });
      add('dies', m[5], { other, mine: true, nontoken: !!m[2], kind: m[3].trim().toLowerCase() + sub });
    } else if ((m = line.match(/^When(?:ever)? (another|a|an|one or more|one or more other) (nontoken )?((?:[\w-]+ ){0,3}?)(creature|artifact|enchantment|land|permanent|planeswalker|token|[A-Z][\w-]+)s? (?:you control )?(with [^,]+? )?enters?(?: the battlefield)?( under your control| under an opponent's control)?, (.+)$/i))) {
      const theirs = /opponent/.test(m[6] || '');
      const mine = /under your control/.test(m[6] || '') || /you control/i.test(line.split(',')[0]);
      add('enters', m[7], { other: /another|other/.test(m[1]), kind: ((m[3] + m[4]).toLowerCase().trim() + (m[5] ? ' ' + m[5].trim() : '')).trim(), mine, theirs, nontoken: !!m[2], once: /one or more/.test(m[1]) });
    }
    // dies / leaves / graveyard
    else if ((m = line.match(/^When(?:ever)? ~ dies or is put into exile from the battlefield, (.+)$/i))) {
      add('dies', m[1], { self: true });
      add('leaves', m[1], { self: true, toZone: 'exile' });
    } else if ((m = line.match(/^When(?:ever)? ~ dies or is put into exile while its power is (\d+) or greater, (.+)$/i))) {
      // Syr Vondam, Sunstar Exemplar
      add('dies', m[2], { self: true, minPower: +m[1] });
      add('leaves', m[2], { self: true, toZone: 'exile', minPower: +m[1] });
    } else if ((m = line.match(/^Whenever (another|a) (nontoken )?creature you control dies or is put into exile, (.+)$/i))) {
      // Syr Vondam: "Whenever another creature you control dies or is put into exile"
      add('dies', m[3], { mine: true, other: m[1] === 'another', nontoken: !!m[2] });
      add('leaves', m[3], { mine: true, kind: 'creature', toZone: 'exile', nontoken: !!m[2] });
    } else if ((m = line.match(/^Whenever (another|an?|one or more) (nontoken )?creatures? you control (with|without) (flying|[a-z ]+?) dies?, (.+)$/i))) {
      // Luminous Broodmoth: "Whenever a creature you control without flying dies"
      add('dies', m[5], { mine: true, other: m[1] === 'another', nontoken: !!m[2], kind: `creature ${m[3].toLowerCase()} ${m[4].toLowerCase()}` });
    } else if ((m = line.match(/^Whenever (?:one or more )?(other )?creatures and\/or artifacts you control die, (.+)$/i))) {
      // G'raha Tia: artifacts going to the graveyard from the battlefield count too
      add('dies', m[2], { mine: true, other: !!m[1], kind: 'creature or artifact', noncreatureToo: true });
    } else if ((m = line.match(/^Whenever another player loses the game, (.+)$/i))) {
      add('playerLost', m[1], {}); // Sengir, the Dark Baron (in a two-player game the game is over by then)
    } else if ((m = line.match(/^When(?:ever)? ~ dies, (.+)$/i)) || (m = line.match(/^When ~ is put into (?:a|your) graveyard from the battlefield, (.+)$/i)))
      add('dies', m[1], { self: true });
    else if ((m = line.match(/^Whenever ~ or another (nontoken )?(creature|[A-Z][\w-]+) (you control )?dies, (.+)$/i))) {
      add('dies', m[4], { self: true });
      add('dies', m[4], { other: true, nontoken: !!m[1], mine: !!m[3], kind: m[2] === 'creature' ? '' : m[2].toLowerCase() });
    } else if ((m = line.match(/^Whenever (another|an|a|one or more) (nontoken )?((?:[\w-]+ ){0,2}?)(creature|creatures|[A-Z]\w+s?) (you control )?dies?, (.+)$/i)))
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
    else if ((m = line.match(/^Whenever one or more (?:other )?cards? leave your graveyard, (.+)$/i)))
      add('leftGraveyard', m[1], { mine: true }); // Advanced Reconstruction (level 2)
    // Cyan, Grim Reaper's Scythe: "Whenever one or more creature cards leave your graveyard"
    else if ((m = line.match(/^Whenever one or more (creature|artifact|land|nonland|permanent|instant and\/or sorcery) cards leave your graveyard, (.+)$/i)))
      add('leftGraveyard', m[2], { mine: true, kind: m[1].toLowerCase() });
    // Mirelurk Queen: "Whenever one or more nonland cards are milled"
    else if ((m = line.match(/^Whenever one or more (nonland |land |creature )?cards are milled, (.+)$/i)))
      add('mill', m[2], { kind: (m[1] || '').trim(), anyPlayer: true });
    // Darien, Sun Droplet: "Whenever you're dealt damage"
    else if ((m = line.match(/^Whenever you're dealt damage, (.+)$/i)))
      add('lifeLost', m[1], { who: 'you', byDamage: true });
    else if ((m = line.match(/^Whenever one or more (?:other )?cards? (?:are put into|leave) your graveyard(?: from anywhere)?, (.+)$/i)))
      add('putIntoGraveyard', m[1], { mine: true });
    // theft decks: Don Andres, Gonti, Brainstealer Dragon, Breeches, J. Jonah Jameson, Labyrinth Raptor
    else if ((m = line.match(/^Whenever you cast a (noncreature |creature |)spell you don't own, (.+)$/i)))
      add('cast', m[2], { spell: m[1].trim().toLowerCase(), mine: true, notOwned: true });
    else if ((m = line.match(/^Whenever a player casts a spell they don't own, (.+)$/i)))
      add('cast', m[1], { spell: '', notOwned: true });
    else if ((m = line.match(/^Whenever a (nonland )?permanent an opponent owns enters(?: the battlefield)? under your control, (.+)$/i)))
      add('enters', m[2], { mine: true, notOwned: true, kind: m[1] ? 'nonland' : '' });
    else if ((m = line.match(/^Whenever a creature deals combat damage to one of your opponents, (.+)$/i)))
      add('combatDamagePlayer', m[1], { anyCreatureToOpp: true });
    else if ((m = line.match(/^Whenever one or more ([A-Z][\w-]+)s you control deal (?:combat )?damage to (?:your opponents|an opponent|a player), (.+)$/)))
      add('combatDamageOnce', m[2], { kind: m[1].toLowerCase() });
    else if ((m = line.match(/^Whenever a creature you control with ([a-z ]+?) (attacks|becomes blocked), (.+)$/i)))
      add(m[2] === 'attacks' ? 'attacks' : 'blocked', m[3], { anyOfMine: true, kind: `creature with ${m[1].toLowerCase()}` });
    // Avengers: commander combat damage, plural names ("Falcon and Redwing deal"), Hercules, She-Hulk, Kindred Discovery…
    else if ((m = line.match(/^Whenever (?:your commander|a commander you control) deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[1], { anyOfMine: true, commander: true });
    else if (/^Whenever you attack with your commander, if (?:this card|~) is in your graveyard/i.test(line)) void 0; // handled in specialEvent (Jocasta)
    else if (/^Whenever a creature you control becomes tapped during your turn, if it's the first time/i.test(line)) void 0; // tappedHook (Captain America)
    else if ((m = line.match(/^Whenever one or more creatures deal combat damage to you while you're the monarch, (.+)$/i)))
      add('combatDamagedMe', m[1], { monarch: true });
    else if ((m = line.match(/^Whenever ~ is dealt damage for the first time each turn, (.+)$/i)))
      add('dealtDamage', m[1], { self: true, oncePerTurn: true });
    else if ((m = line.match(/^Whenever (?:a|an) ([A-Z][\w-]+) you control becomes blocked, (.+)$/)))
      add('blocked', m[2], { anyOfMine: true, kind: m[1].toLowerCase() });
    else if ((m = line.match(/^Whenever (?:a|an) ((?:[\w-]+ )*?)creature you control (?:of the chosen type )?enters or attacks, (.+)$/i))) {
      const kind = /of the chosen type/i.test(line) ? 'chosen type' : m[1].trim().toLowerCase();
      add('attacks', m[2], { anyOfMine: true, kind, chosenType: kind === 'chosen type' });
      add('enters', m[2], { mine: true, kind: kind === 'chosen type' ? '' : kind, chosenType: kind === 'chosen type' });
    }
    // Mazemind Tome: "When there are four or more page counters on ~, exile it. If you do, you gain 4 life."
    else if ((m = line.match(/^When there are (\w+) or more ([a-z+\/1-]+) counters on ~, (.+)$/i)))
      add('counterPut', m[3], { self: true, kind: m[2].toLowerCase(), nth: { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10 }[m[1].toLowerCase()] || +m[1] || 4 });
    else if ((m = line.match(/^When the (tenth|fifth|third|sixth|seventh|twentieth) (\+1\/\+1|[a-z]+) counter is put on ~, (.+)$/i)))
      add('counterPut', m[3], { self: true, kind: m[2].toLowerCase(), nth: { third: 3, fifth: 5, sixth: 6, seventh: 7, tenth: 10, twentieth: 20 }[m[1].toLowerCase()] });
    else if ((m = line.match(/^Whenever you put one or more counters on another creature, (.+)$/i)))
      add('counterPut', m[1], { anyCreature: true, byMe: true, other: true, anyKind: true });
    // combat
    else if ((m = line.match(/^When(?:ever)? ~ deals? (?:combat )?damage to (?:a player|an opponent|one or more players|a player or planeswalker|a player or battle)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[1], { self: true });
    // Setzer, Brood Sliver, Black Widow: "Whenever a Vehicle/Sliver you control deals combat damage to a player", "a creature you control with deathtouch"
    else if ((m = line.match(/^Whenever (?:a|an|another) ([A-Z][\w-]+) you control deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/)) || (m = line.match(/^Whenever (?:a|an|another) ([A-Z][\w-]+) deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/)))
      add('combatDamagePlayer', m[2], line.includes('you control') ? { anyOfMine: true, kind: m[1].toLowerCase() } : { anyCreatureAny: true, kind: m[1].toLowerCase() });
    else if ((m = line.match(/^Whenever (?:a|another) creature you control with (deathtouch|flying|trample|menace|lifelink|haste|first strike|double strike|vigilance|reach) deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[2], { anyOfMine: true, kind: 'creature with ' + m[1].toLowerCase() });
    else if ((m = line.match(/^Whenever (?:a|another) creature you control with (?:a|one or more) (\+1\/\+1 )?counters? on it deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[2], { anyOfMine: true, withCounter: m[1] ? '+1/+1' : 'any' });
    else if ((m = line.match(/^Whenever (?:a|an|another) ((?:[\w-]+ ){0,2}?)creature you control deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[2], { anyOfMine: true, kind: m[1].trim() });
    else if ((m = line.match(/^Whenever equipped creature deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)) || (m = line.match(/^Whenever enchanted creature deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[1], { attachedTo: true });
    else if ((m = line.match(/^Whenever one or more (other )?((?:[\w-]+ )*?)(?:creatures|[A-Z][\w-]+s|(?:[A-Z][\w-]+s?, )*[A-Z][\w-]+s?,? (?:and\/or|or|and) [A-Z][\w-]+s)? ?you control deal combat damage to (?:a player|an opponent|one or more players)[^,]*, (.+)$/i)))
      add('combatDamageOnce', m[3], { kind: kindWords(line.match(/one or more (?:other )?(.+?) you control deal/i)[1]) });
    else if ((m = line.match(/^When(?:ever)? ~ (?:attacks or blocks|blocks or attacks)[^,]*, (.+)$/i))) {
      add('attacks', m[1], { self: true });
      add('blocks', m[1], { self: true });
    } else if ((m = line.match(/^Whenever ~ attacks or becomes the target of a spell(?: or ability)?(?: an opponent controls)?, (.+)$/i))) {
      // Goldspan Dragon
      add('attacks', m[1], { self: true });
      add('becomesTarget', m[1], { self: true, spellOnly: !/or ability/i.test(line), oppOnly: /an opponent controls/i.test(line) });
    } else if ((m = line.match(/^Whenever an? ([A-Z][a-z]+) you control becomes the target of a spell or ability an opponent controls, (.+)$/))) {
      // Thunderbreak Regent
      add('becomesTarget', m[2], { sub: m[1], oppOnly: true });
    } else if ((m = line.match(/^Whenever a goaded creature attacks, (.+)$/i))) {
      // Vengeful Ancestor
      add('attacks', m[1], { goadedAttacker: true });
    } else if ((m = line.match(/^Whenever ~ becomes the target of a spell(?: or ability)?(?: an opponent controls| you control)?(?: for the first time each turn)?, (.+)$/i))) {
      add('becomesTarget', m[1], { self: true, spellOnly: !/or ability/i.test(line), oppOnly: /an opponent controls/i.test(line), mineOnly: /you control,/i.test(line) });
    } else if ((m = line.match(/^Whenever ~ attacks while (you (?:don't )?control [^,]+), (.+)$/i)))
      // Pugnacious Hammerskull: "Whenever ~ attacks while you don't control another Dinosaur"
      add('attacks', `If ${m[1]}, ${m[2]}`, { self: true });
    else if ((m = line.match(/^When(?:ever)? ~ attacks(?: and isn't blocked)?(?: alone)?[^,]*, (.+)$/i)))
      add(/isn't blocked/i.test(line) ? 'unblocked' : /alone/i.test(line) ? 'attacksAlone' : 'attacks', m[1], { self: true });
    else if ((m = line.match(/^When(?:ever)? ~ blocks(?: or becomes blocked)?[^,]*, (.+)$/i))) {
      add('blocks', m[1], { self: true });
      if (/becomes blocked/i.test(line)) add('blocked', m[1], { self: true });
    } else if ((m = line.match(/^Whenever ~ becomes blocked(?: by a creature)?[^,]*, (.+)$/i)))
      add('blocked', m[1], { self: true });
    else if ((m = line.match(/^Whenever equipped creature attacks, (.+)$/i)) || (m = line.match(/^Whenever enchanted creature attacks, (.+)$/i)))
      add('attacks', m[1], { attachedTo: true });
    else if ((m = line.match(/^Whenever (a|another) ((?:[\w-]+ ){0,2}?)creature you control (with [^,]+?) attacks, (.+)$/i)))
      // Duskana: "Whenever a creature you control with base power and toughness 2/2 attacks"
      add('attacks', m[4], { anyOfMine: true, kind: `${m[2].trim()} creature ${m[3]}`.trim(), other: m[1] === 'another' });
    else if ((m = line.match(/^Whenever (?:a|another) ((?:[\w-]+ ){0,2}?)creature you control attacks[^,]*, (.+)$/i)))
      add('attacks', m[2], { anyOfMine: true, kind: m[1].trim() });
    else if ((m = line.match(/^Whenever (a|an|another) ([A-Z][\w-]+) you control attacks[^,]*, (.+)$/)))
      add('attacks', m[3], { anyOfMine: true, kind: m[2].toLowerCase(), other: m[1] === 'another' });
    else if ((m = line.match(/^Whenever (?:your commander|a commander you control) attacks[^,]*, (.+)$/i)))
      add('attacks', m[1], { anyOfMine: true, commander: true });
    else if ((m = line.match(/^Whenever (?:your commander|a commander you control) enters or attacks[^,]*, (.+)$/i))) {
      add('attacks', m[1], { anyOfMine: true, commander: true });
      add('enters', m[1], { other: true, mine: true, commander: true });
    }
    else if ((m = line.match(/^Whenever you attack enchanted player[^,]*, (.+)$/i)))
      add('youAttack', m[1], { enchanted: true });
    else if ((m = line.match(/^Whenever (?:a player|an opponent) attacks you(?: or a planeswalker you control)?[^,]*, (.+)$/i)))
      add('youAttack', m[1], { defend: true });
    else if ((m = line.match(/^Whenever (?:you attack|one or more (?:other )?(?:[\w-]+ )*?(?:creatures|[A-Z][\w-]+s) you control attack)[^,]*, (.+)$/i)))
      {
      const km = line.match(/one or more (?:other )?(.+?) you control attack/i) || line.match(/with one or more (.+?)(?:,| with power)/i) || line.match(/attack with (?:two|three|four|five|\d+) or more (.+?)(?:,| with power)/i);
      const mn = line.match(/attack with (two|three|four|five|\d+) or more /i);
      // Love on the Battlefield: "Whenever you attack with exactly two creatures"
      const ex = line.match(/attack with exactly (one|two|three|four|\d+) /i);
      const W = { one: 1, two: 2, three: 3, four: 4, five: 5 };
      const tp = line.match(/with total power (\d+) or greater/i); // Ugin's Mastery
      add('youAttack', m[1], { kind: km ? kindWords(km[1]) : '', minCount: mn ? W[mn[1].toLowerCase()] || +mn[1] : 0, ...(ex ? { exactCount: W[ex[1].toLowerCase()] || +ex[1] } : {}), ...(tp ? { totalPower: +tp[1] } : {}) });
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
    else if ((m = line.match(/^At the beginning of (?:combat on your turn|each combat|combat on each opponent's turn|combat on each player's turn), (.+)$/i)))
      add('beginCombat', m[1], { whose: /each combat|each player's/i.test(line) ? 'each' : /each opponent's/i.test(line) ? "each opponent's" : 'your' });
    else if ((m = line.match(/^At the beginning of (your|each|each opponent's|each player's) end step, (.+)$/i)) || (m = line.match(/^At the beginning of (the|the next) end step, (.+)$/i)))
      add('endStep', m[2], { whose: /^the/i.test(m[1]) || /each player's/i.test(m[1]) ? 'each' : m[1].toLowerCase() });
    else if ((m = line.match(/^At the beginning of your (?:precombat |first )?main phase, (.+)$/i)))
      add('mainPhase', m[1], { whose: 'your' });
    else if ((m = line.match(/^At end of combat, (.+)$/i)))
      add('endCombat', m[1], { whose: 'your' });
    // Cursed Mirror: "As ~ enters, you may have it become a copy of any creature on the battlefield until end of turn, except it has haste."
    else if ((m = line.match(/^As ~ enters(?: the battlefield)?, you may have it become a copy of any creature on the battlefield( until end of turn)?(?:, except (.+?))?\.?$/i)))
      add('enters', `you may have ~ become a copy of target creature${m[1] || ''}${m[2] ? ', except ' + m[2] : ''}`, { self: true });
    // spells
    else if ((m = line.match(/^When you cast this spell, (.+)$/i)) || (m = line.match(/^When you cast ~, (.+)$/i)))
      add('castSelf', m[1], { self: true });
    else if ((m = line.match(/^Whenever you cast or copy (?:an|a) ([^,]*?)spell, (.+)$/i)))
      add('cast', m[2], { spell: m[1].toLowerCase().trim(), mine: true });
    else if ((m = line.match(/^Whenever you cast a spell that shares a creature type with (?:this creature|~), (.+)$/i)))
      add('cast', m[1], { spell: '', mine: true, sharesType: true });
    else if ((m = line.match(/^Whenever you cast (?:a|an|another|your first|your second) ([^,]*?)spell(?: each turn| during [^,]+| from [^,]+| with [^,]+| that [^,]+| this turn)?, (.+)$/i)))
      add('cast', m[2], { spell: (m[1].toLowerCase().trim() + ((line.match(/spell with (power \d+ or (?:greater|less))/i) || [])[1] ? ' ' + line.match(/spell with (power \d+ or (?:greater|less))/i)[1] : '')).trim(), mine: true, first: /your first/i.test(line), second: /your second/i.test(line), notSelf: /another/i.test(line), from: (line.match(/spell from (your hand|your graveyard|exile|anywhere other than your hand)/i) || [])[1],
        ...mvLimit(line) });
    else if ((m = line.match(/^Whenever you cast an? ((?:Aura|Equipment|Vehicle|historic|[A-Z]\w+)(?:(?:,|, or| or) (?:Aura|Equipment|Vehicle|[A-Z]\w+))*)(?: spell)?, (.+)$/)))
      add('cast', m[2], { spell: m[1].toLowerCase(), mine: true });
    else if ((m = line.match(/^Whenever you cast your (first|second) ((?:[A-Za-z]+, )+or [A-Za-z]+) spell each turn, (.+)$/i)))
      add('cast', m[3], { spell: m[2].toLowerCase(), mine: true, first: /first/i.test(m[1]), second: /second/i.test(m[1]) });
    // Puppet Master, String Puller
    else if ((m = line.match(/^Whenever one or more goaded creatures deal combat damage to (?:one of your opponents|an opponent), (.+)$/i)))
      add('goadedDamage', m[1]);
    // Up the Beanstalk: "When ~ enters and whenever you cast a spell with mana value 5 or greater, draw a card."
    else if ((m = line.match(/^When ~ enters and whenever you cast (?:a|an) ([^,]*?)spell(?: with [^,]+)?, (.+)$/i))) {
      add('enters', m[2], { self: true });
      add('cast', m[2], { spell: m[1].toLowerCase().trim(), mine: true, ...mvLimit(line) });
    }
    // Quilled Greatwurm: "Whenever a creature you control deals combat damage during your turn, put that many +1/+1 counters on it."
    else if ((m = line.match(/^Whenever a creature you control deals combat damage during your turn, (.+)$/i)))
      add('anyCombatDamage', m[1], { yourTurn: true });
    // Dirtcowl Wurm
    else if ((m = line.match(/^Whenever an opponent plays a land, (.+)$/i)))
      add('landfall', m[1], { theirs: true, played: true });
    // Dreamtide Whale: "Whenever a player casts their second spell each turn, proliferate."
    else if ((m = line.match(/^Whenever a player casts their second spell each turn, (.+)$/i)))
      add('cast', m[1], { spell: '', second: true });
    else if ((m = line.match(/^When(?:ever)? an opponent casts their second spell each turn, (.+)$/i)))
      add('cast', m[1], { spell: '', theirs: true, second: true });
    else if ((m = line.match(/^When(?:ever)? an opponent casts (?:a|an|their first) ([^,]*?)spell[^,]*, (.+)$/i)))
      add('cast', m[2], { spell: m[1].toLowerCase().trim(), theirs: true, first: /their first/i.test(line) });
    // Pain Distributor: "Whenever a player casts their first spell each turn"
    else if ((m = line.match(/^Whenever a player casts their first ([^,]*?)spell each turn, (.+)$/i)))
      add('cast', m[2], { spell: m[1].toLowerCase().trim(), first: true });
    else if ((m = line.match(/^Whenever a player casts (?:a|an) ([^,]*?)spell[^,]*, (.+)$/i)))
      add('cast', m[2], { spell: m[1].toLowerCase().trim() });
    // cards and life
    else if ((m = line.match(/^Whenever (you|an opponent|a player) draws? (?:a|your second|their second) card[^,]*, (.+)$/i)))
      add('draw', m[2], { who: m[1].toLowerCase(), second: /second/i.test(line) });
    else if ((m = line.match(/^Whenever (you|an opponent|a player) discards? (?:a|an|one or more) ((?:[a-z]+ )*?)cards?, (.+)$/i)))
      // Hashaton: "Whenever you discard a creature card"
      add('discard', m[3], { who: m[1].toLowerCase(), kind: m[2].trim() });
    else if ((m = line.match(/^Whenever you cycle(?: or discard)? (?:a|another) card, (.+)$/i)) || (m = line.match(/^When you cycle ~, (.+)$/i)))
      add('cycle', m[1], { self: /When you cycle ~/i.test(line) });
    else if ((m = line.match(/^Whenever you get (one|two|three|four|five|\d+) or more \{E\}\s*(?:\([^)]*\))?\s*( during your turn)?\s*, (.+)$/i)) || (m = line.match(/^Whenever you get (\{E\})\s*(?:\([^)]*\))?\s*( during your turn)?\s*, (.+)$/i)))
      // Territorial Gorger, Aether Revolt, Brotherhood Scribe: "Whenever you get one or more {E}"
      add('energyGained', m[3], { min: { one: 1, two: 2, three: 3, four: 4, five: 5 }[m[1].toLowerCase()] || +m[1] || 1, yourTurn: !!m[2] });
    else if ((m = line.match(/^Whenever (you|an opponent) gains? life( for the first time each turn)?, (.+)$/i)))
      add('lifeGained', m[3], { who: m[1].toLowerCase(), ...(m[2] ? { oncePerTurn: true } : {}) });
    else if ((m = line.match(/^Whenever (you|an opponent|a player) loses? life(?: during your turn)?, (.+)$/i)))
      add('lifeLost', m[2], { who: m[1].toLowerCase() });
    else if ((m = line.match(/^When you unlock door (\d), (.+)$/i)))
      add('unlock', m[2], { self: true, door: +m[1] - 1 });
    else if ((m = line.match(/^Whenever you (?:fully )?unlock a (?:door|Room)[^,]*, (.+)$/i)))
      add('unlock', m[1], { anyRoom: true, fully: /fully/i.test(line) });
    else if ((m = line.match(/^Whenever (?:one or more|a) (land |creature |nonland |permanent )?cards? (?:are|is) put into your graveyard from your library, (.+)$/i)) || (m = line.match(/^Whenever you mill (?:one or more|a) (land |creature |nonland )?cards?, (.+)$/i)))
      // Hedge Shredder: "Whenever one or more land cards are put into your graveyard from your library, put them onto the battlefield tapped."
      add('mill', m[2], { kind: (m[1] || '').trim() });
    else if ((m = line.match(/^Whenever one or more cards are put into exile from your library and\/or your graveyard, (.+)$/i)))
      add('exiledBatch', m[1], { fromZones: ['library', 'graveyard'], mineOnly: true });
    else if ((m = line.match(/^Whenever one or more (?:other )?permanents phase out and whenever one or more (other )?cards are put into exile from anywhere, (.+)$/i)))
      add('exiledBatch', m[2], { other: !!m[1] });
    else if ((m = line.match(/^Whenever one or more (other )?cards are put into exile(?: from anywhere)?, (.+)$/i)))
      add('exiledBatch', m[2], { other: !!m[1] });
    else if (/^The first spell you cast from anywhere other than your hand each turn has demonstrate\b/i.test(line))
      add('cast', 'Demonstrate.', { spell: '', mine: true, from: 'anywhere other than your hand', firstNotHand: true });
    else if ((m = line.match(/^Whenever you copy a spell, (.+)$/i)))
      add('copySpell', m[1], {});
    else if ((m = line.match(/^Whenever (you play a land|a land you control enters from anywhere other than your hand) or (?:you )?cast a spell from anywhere other than your hand, (.+)$/i))) {
      // Shadow of the Goblin, The Lost and the Damned
      add('landfall', m[2], /^you play/i.test(m[1]) ? { playedFrom: 'notHand' } : { enteredFrom: 'notHand' });
      add('cast', m[2], { spell: '', mine: true, from: 'anywhere other than your hand' });
    } else if ((m = line.match(/^Whenever you play a land from exile or cast a spell from exile, (.+)$/i)) || (m = line.match(/^Whenever you play a card from exile, (.+)$/i))) {
      // Ghost-Spider
      add('landfall', m[1], { playedFrom: 'exile' });
      add('cast', m[1], { spell: '', mine: true, from: 'exile' });
    } else if ((m = line.match(/^Whenever you play a land from (exile|your graveyard), (.+)$/i)))
      add('landfall', m[2], { playedFrom: m[1].toLowerCase() === 'exile' ? 'exile' : 'graveyard' });
    else if ((m = line.match(/^Whenever a land (?:you control enters|enters(?: the battlefield)? under your control)[^,]*, (.+)$/i)))
      add('landfall', m[1]);
    else if ((m = line.match(/^Whenever an? ([A-Z][\w-]+) token you control with power (\d+) or greater attacks, (.+)$/i)))
      add('attacks', m[3], { anyOfMine: true, kind: `${m[1].toLowerCase()} token with power ${m[2]} or greater` });
    else if ((m = line.match(/^Whenever you activate an ability that isn't a mana ability, copy it/i))) void 0; // handled when the ability resolves
    else if ((m = line.match(/^Whenever you activate a loyalty ability(?: of a [A-Za-z]+ planeswalker| of a planeswalker)?, (.+)$/i)))
      add('loyaltyActivated', m[1]);
    else if ((m = line.match(/^Whenever you put one or more loyalty counters on a planeswalker(?: you control)?, (.+)$/i)))
      add('counterPut', m[1], { anyOfMine: true, kind: 'loyalty' });
    // -1/-1 counter matters (Lorwyn Eclipsed blight): Auntie Ool, Wickersmith's Tools, Hapatra, Flourishing Defenses
    else if ((m = line.match(/^Whenever one or more -1\/-1 counters are put on (?:a|another) creature( you control| an opponent controls)?, (.+)$/i)))
      add('counterPut', m[2], { kind: '-1/-1', anyCreature: true, mine: /you control/i.test(m[1] || ''), theirs: /opponent controls/i.test(m[1] || '') });
    else if ((m = line.match(/^Whenever an? -1\/-1 counter is put on (?:a|another) creature( you control| an opponent controls)?, (.+)$/i)))
      add('counterPut', m[2], { kind: '-1/-1', anyCreature: true, perCounter: true, mine: /you control/i.test(m[1] || ''), theirs: /opponent controls/i.test(m[1] || '') });
    else if ((m = line.match(/^Whenever you put one or more -1\/-1 counters on (?:a|another) creature(?: you don't control)?, (.+)$/i)))
      add('counterPut', m[1], { kind: '-1/-1', anyCreature: true, byMe: true });
    else if ((m = line.match(/^Whenever an? creature (an opponent controls |you control |your opponents control )?with an? ((?:-1\/-1|\+1\/\+1) )?counter on it dies, (.+)$/i)))
      add('dies', m[3], { withCounter: m[2] ? m[2].trim() : 'any', mine: /you control/i.test(m[1] || ''), theirs: /opponent/i.test(m[1] || '') });
    else if ((m = line.match(/^Whenever one or more \+1\/\+1 counters are put on ~, (.+)$/i)))
      add('counterPut', m[1], { self: true, kind: '+1/+1' });
    else if ((m = line.match(/^Whenever you put one or more \+1\/\+1 counters on ~, (.+)$/i)))
      add('counterPut', m[1], { self: true, kind: '+1/+1', byMe: true });
    else if ((m = line.match(/^Whenever one or more \+1\/\+1 counters are put on (?:a|another) creature you control, (.+)$/i)))
      add('counterPut', m[1], { anyOfMine: true, kind: '+1/+1' });
    else if ((m = line.match(/^Whenever you put one or more \+1\/\+1 counters on a creature you control, (.+)$/i)))
      add('counterPut', m[1], { anyOfMine: true, kind: '+1/+1', amountIsN: true });
    else if ((m = line.match(/^Whenever (you|a player|an opponent) sacrifices? (a|an|another|one or more|one or more other) ([^,]+?)( during your turn)?, (.+)$/i)))
      add('sacrificed', m[5], { kind: m[3].toLowerCase().replace(/^nontoken /, ''), who: m[1].toLowerCase(), other: /another|other/i.test(m[2]), nontoken: /nontoken/i.test(m[3]), yourTurn: !!m[4] });
    else if ((m = line.match(/^Whenever you create (?:a|one or more) (?:creature )?tokens?, (.+)$/i)))
      add('tokensCreated', m[1]);
    else if ((m = line.match(/^Whenever you (scry or surveil|scry|surveil)( for the first time each turn)?[^,]*, (.+)$/i))) {
      for (const ev of m[1].toLowerCase().split(' or ')) add(ev, m[3], m[2] ? { oncePerTurn: true } : {});
    }
    else if ((m = line.match(/^Whenever (?:~|a creature you control) explores, (.+)$/i)))
      add('explored', m[1]);
    else if ((m = line.match(/^Whenever (~|a creature you control) connives, (.+)$/i)))
      add('connived', m[2], { self: m[1] === '~' });
    // Mangara, the Diplomat
    else if ((m = line.match(/^Whenever an opponent attacks with creatures, if two or more of those creatures are attacking you(?: and\/or planeswalkers you control)?, (.+)$/i)))
      add('youAttack', m[1], { defend: true, minCount: 2 });
    // Curse of Opulence (two-player: the only one attacking the enchanted player is you)
    else if ((m = line.match(/^Whenever enchanted player is attacked, (.+?)(?: Each opponent attacking that player does the same\.)?$/i)))
      add('youAttack', m[1], { enchanted: true });
    else if ((m = line.match(/^When(?:ever)? ~ becomes monstrous, (.+)$/i)))
      add('monstrous', m[1], { self: true });
    else if ((m = line.match(/^When ~ exploits a creature, (.+)$/i)))
      add('exploited', m[1], { self: true });
    else if ((m = line.match(/^When(?:ever)? ~ (?:transforms into|becomes) (?!tapped,)[^,]+, (.+)$/i)))
      add('transformed', m[1], { self: true });
    else if ((m = line.match(/^When this Class becomes level (\d+), (.+)$/i)))
      add('classLevel', m[2], { self: true, level: +m[1] });
    else if ((m = line.match(/^Whenever the Ring tempts you, (.+)$/i)))
      add('ringTempts', m[1]);
    else if ((m = line.match(/^Whenever players finish voting, (.+)$/i)))
      add('votingDone', m[1]); // Grudge Keeper, Model of Unity, Erestor of the Council
    else if ((m = line.match(/^Whenever you complete a dungeon, (.+)$/i)))
      add('dungeonDone', m[1]);
    else if ((m = line.match(/^Whenever ~ becomes tapped, (.+)$/i)))
      add('tapped', m[1], { self: true });
    else if ((m = line.match(/^When(?:ever)? ~ mutates, (.+)$/i)))
      add('mutates', m[1], { self: true });
    // saga chapters
    else if ((m = line.match(/^((?:[IVX]+)(?:, [IVX]+)*) — (.+)$/))) {
      const chapters = m[1].split(/, /).map((r) => ROMAN[r] || 0);
      out.push({ event: 'chapter', chapters, text: m[2].replace(/ ¶•/g, '\n•'), raw: line, self: true, optional: /^you may/i.test(m[2]) });
    } else {
      let q;
      // ---- batch 13: triggers with their own conditions (predicate triggers, matched in matches()) ----
      // "When ~ enters and whenever …" / "Whenever X and whenever Y, …": each half is its own trigger
      if ((q = line.match(/^(When|Whenever) (.+?) and whenever (.+?), (.+)$/)) && !/^Whenever (?:you|a player) (?:cast|play)/.test(line)) {
        for (const t of parseTriggerText(`${q[1]} ${q[2]}, ${q[4]}`, speed).concat(parseTriggerText(`Whenever ${q[3]}, ${q[4]}`, speed))) out.push({ ...t, raw: line });
        continue;
      }
      if ((q = line.match(/^When ~ enters? and at the beginning of your (upkeep|end step|precombat main phase|first main phase), (.+)$/))) {
        add('enters', q[2], { self: true });
        add({ upkeep: 'upkeep', 'end step': 'endStep' }[q[1]] || 'mainPhase', q[2], {});
        continue;
      }
      // static mana abilities written as triggers (rules.js manaAbility applies them)
      if (/^Whenever (?:you tap an? (?:Plains|Island|Swamp|Mountain|Forest) for mana, add an additional|a player taps a (?:basic )?land for mana, that player adds one mana|you tap a land for mana, add one mana of any type|a land's ability causes you to add one or more mana of the chosen color|enchanted land is tapped for mana, its controller adds an additional|a basic land is tapped for mana of the chosen color|you tap a land for mana while you're the monarch, add an additional|a land with the same name as the exiled card is tapped for mana)/i.test(line)) { add('ruleMarker', 'rule marker noop', {}); continue; }
      // ability copiers (cast.js activationCopies), Grafted Exoskeleton (state.js), Selfless Squire (state.inkshieldFlush)
      if (/^Whenever (?:you activate an ability|an ability of equipped creature is activated)\b[^,]*, if (?:it isn't a mana ability|one or more permanents were sacrificed to activate it|life was paid to activate it), you may (?:pay|copy)/i.test(line)
        || /^Whenever damage that would be dealt to you is prevented, put that many \+1\/\+1 counters on/i.test(line)) { add('ruleMarker', 'rule marker noop', {}); continue; }
      if ((q = line.match(/^Whenever a player taps a land for mana, if ~ is tapped, that player adds one mana of any type that land produced\. Then that land deals 1 damage to that player\.$/i))) {
        add('p:manaTapped', '', { pred: (c, ev) => ev.land && c.tapped && { thatPlayer: ev.pid }, fn: async (ctx, hit, ev) => { changeLife(ev.pid, -1); return [`${nameTag(card(ev.iid))} deals 1 damage to ${seatName(ev.pid)}`]; } });
        continue;
      }
      // casting
      if ((q = line.match(/^Whenever another player casts a spell from anywhere other than their hand, (.+)$/i))) { add('p:cast', q[1], { pred: (c, ev) => ev.controller !== c.controller && card(ev.iid) && card(ev.iid).castFrom && card(ev.iid).castFrom !== 'hand' && { thatPlayer: ev.controller } }); continue; }
      if ((q = line.match(/^Whenever you play (a|a legendary) land or cast (?:a|a legendary) spell, (.+)$/i))) {
        const leg = q[1] !== 'a';
        add('p:cast', q[2], { pred: (c, ev) => ev.controller === c.controller && !ev.copy && (!leg || /Legendary/.test(P.tl(ev))) });
        add('p:landfall', q[2], { pred: (c, ev) => ev.controller === c.controller && G.s.lastLandPlay && G.s.lastLandPlay.iid === ev.iid && (!leg || /Legendary/.test(P.tl(ev))) });
        continue;
      }
      if ((q = line.match(/^Whenever you play a card with two or more card types, (.+)$/i))) {
        add('p:cast', q[1], { pred: (c, ev) => ev.controller === c.controller && !ev.copy && P.ntypes(P.tl(ev)) >= 2 });
        add('p:landfall', q[1], { pred: (c, ev) => ev.controller === c.controller && G.s.lastLandPlay && G.s.lastLandPlay.iid === ev.iid && P.ntypes(P.tl(ev)) >= 2 });
        continue;
      }
      if ((q = line.match(/^Whenever you cast an instant, sorcery, or ([A-Z]\w+) spell, (.+)$/))) { const ty = q[1]; add('p:cast', q[2], { pred: (c, ev) => ev.controller === c.controller && (/Instant|Sorcery/.test(P.tl(ev)) || new RegExp('\\b' + ty + '\\b').test(P.tl(ev))) }); continue; }
      if ((q = line.match(/^Whenever you cast a spell using teamwork, (.+)$/i))) { add('p:cast', q[1], { pred: (c, ev) => ev.controller === c.controller && card(ev.iid) && card(ev.iid).teamworkUsed }); continue; }
      if ((q = line.match(/^Whenever you cast a spell with power, toughness, or mana value (\d+), (.+)$/i))) {
        const k = +q[1];
        add('p:cast', q[2], { pred: (c, ev) => { if (ev.controller !== c.controller) return false; const d = DB[ev.def]; const f = d && (d.faces[0] || {}); return !!d && ((d.cmc || 0) === k || +f.power === k || +f.toughness === k); } });
        continue;
      }
      if ((q = line.match(/^Whenever you cast your first spell with \{X\} in its mana cost each turn, (.+)$/i))) {
        add('p:cast', q[1], { pred: (c, ev) => { if (ev.controller !== c.controller || ev.copy) return false; const d = DB[ev.def]; if (!d || !/\{X\}/.test(d.manaCost || (d.faces[0] || {}).manaCost || '')) return false; const st = (G.s.xFirst = G.s.xFirst || {}); if (st[c.controller] === G.s.turn) return false; st[c.controller] = G.s.turn; return true; } });
        continue;
      }
      if ((q = line.match(/^When you cast ~ from anywhere other than exile, (.+)$/i))) { add('castSelf', q[1], { notFromExile: true }); continue; }
      // abilities activated
      if ((q = line.match(/^Whenever an opponent activates an ability of an artifact they control, (.+)$/i))) { add('p:activated', q[1], { pred: (c, ev) => ev.controller !== c.controller && /Artifact/.test(P.tl(ev)) && { thatPlayer: ev.controller } }); continue; }
      if ((q = line.match(/^Whenever an opponent activates an ability of an? ([a-z, ]+?) (?:on the battlefield, if it isn't a mana ability|that isn't a mana ability), (.+)$/i))) {
        const kinds = q[1].replace(/,? or /, ', ').split(/,\s*/).map((x) => x.trim()).filter(Boolean);
        add('p:activated', q[2], { pred: (c, ev) => ev.controller !== c.controller && kinds.some((k) => new RegExp('\\b' + k + '\\b', 'i').test(P.tl(ev))) && { thatPlayer: ev.controller } });
        continue;
      }
      if ((q = line.match(/^Whenever you activate a power-up ability, (.+)$/i))) { add('p:activated', q[1], { pred: (c, ev) => ev.controller === c.controller && ev.powerUp }); continue; }
      if ((q = line.match(/^Whenever you activate a loyalty ability of enchanted planeswalker, (.+)$/i))) {
        if (/^copy that ability/i.test(q[1])) { add('ruleMarker', 'rule marker noop', {}); continue; } // Rowan's Talent: cast.js copies it
        add('p:loyaltyActivated', q[1], { pred: (c, ev) => ev.iid === c.attachedTo });
        continue;
      }
      // mana
      if ((q = line.match(/^Whenever fortified land is tapped for mana, (.+)$/i))) { add('p:manaTapped', q[1], { pred: (c, ev) => ev.iid === c.attachedTo && { it: { iid: ev.iid } } }); continue; }
      if ((q = line.match(/^Whenever an opponent taps an artifact for mana, (.+)$/i))) { add('p:manaTapped', q[1], { pred: (c, ev) => ev.artifact && ev.pid !== c.controller && card(ev.iid) && card(ev.iid).zone === 'battlefield' && { it: { iid: ev.iid }, thatPlayer: ev.pid } }); continue; }
      // entering
      if ((q = line.match(/^When ~ enters from a graveyard, (.+)$/i))) { add('p:enters', q[1], { pred: (c, ev) => ev.iid === c.iid && card(c.iid) && card(c.iid).enteredFrom === 'graveyard' }); continue; }
      if ((q = line.match(/^Whenever ~ or another creature enters from your graveyard, (.+)$/i))) { add('p:enters', q[1], { pred: (c, ev) => { const nc = card(ev.iid); return nc && isCreature(nc) && nc.controller === c.controller && nc.owner === c.controller && nc.enteredFrom === 'graveyard' && { it: { iid: nc.iid } }; } }); continue; }
      if ((q = line.match(/^Whenever ~ or another permanent enters from a graveyard, (.+)$/i))) { add('p:enters', q[1], { pred: (c, ev) => { const nc = card(ev.iid); return nc && nc.enteredFrom === 'graveyard' && { it: { iid: nc.iid } }; } }); continue; }
      if ((q = line.match(/^When ~ enters or becomes monstrous, (.+)$/i))) { add('enters', q[1], { self: true }); add('p:monstrous', q[1], { pred: (c, ev) => ev.iid === c.iid }); continue; }
      if ((q = line.match(/^Whenever an artifact or creature an opponent controls enters untapped, they may tap that permanent\. If they don't, you create (a 1\/1 [^.]+ token[^.]*)\.$/i))) {
        const tok = q[1];
        add('p:enters', '', { pred: (c, ev) => { const nc = card(ev.iid); return nc && nc.controller !== c.controller && !nc.tapped && (isCreature(nc) || isType(nc, 'Artifact')) && { it: { iid: nc.iid }, thatPlayer: nc.controller }; },
          fn: async (ctx, hit) => {
            const nc = card(hit.it.iid);
            if (!nc || nc.zone !== 'battlefield' || nc.tapped) return [];
            const o = nc.controller;
            const yes = isAI(o) ? !(isCreature(nc) && hasKw(nc, 'haste')) && !(/\{T\}/.test(oracle(nc)) && !isCreature(nc)) : await T.confirm(cardName(hit.src), `Tap ${cardName(nc)}? If you don't, ${seatName(ctx.me)} creates a Vampire token.`);
            if (yes) { tapPerm(nc); return [`${seatName(o)} taps ${nameTag(nc)}`]; }
            return await resolveEffects(`Create ${tok}.`, hit.src, ctx);
          } });
        continue;
      }
      if ((q = line.match(/^Whenever ~ or another ([A-Z]\w+) or ([A-Z]\w+) you control enters, (.+)$/))) { const a = q[1], b = q[2]; add('p:enters', q[3], { pred: (c, ev) => { const nc = card(ev.iid); return nc && (nc.iid === c.iid || (nc.controller === c.controller && (hasSubtype(nc, a) || hasSubtype(nc, b)))) && { it: { iid: nc.iid } }; } }); continue; }
      if ((q = line.match(/^Whenever ~ or another creature you control with power (\d+) or less enters, (.+)$/i))) { const k = +q[1]; add('p:enters', q[2], { pred: (c, ev) => { const nc = card(ev.iid); return nc && (nc.iid === c.iid || (nc.controller === c.controller && isCreature(nc) && power(nc) <= k)) && { it: { iid: nc.iid } }; } }); continue; }
      if ((q = line.match(/^When you control (\w+) or more ([A-Z]\w+?)s, (.+)$/))) { const k = P.num(q[1]), ty = q[2]; add('p:enters', q[3], { pred: (c, ev) => card(ev.iid) && card(ev.iid).controller === c.controller && cardsIn(c.controller, 'battlefield').filter((x) => hasSubtype(x, ty)).length >= k }); continue; }
      if ((q = line.match(/^When ~ enters during the declare attackers step, (.+)$/i))) { add('p:enters', q[1], { pred: (c, ev) => ev.iid === c.iid && !!(G.s.combat && (G.s.combat.attackers || []).length && !G.s.combat.damageDone) }); continue; }
      // attacking
      if ((q = line.match(/^Whenever a creature (with a counter on it |with flying )?attacks one of your opponents(?: or a planeswalker an opponent controls)?, (.+)$/i))) {
        const w = (q[1] || '').trim();
        add('p:attacks', q[2], { pred: (c, ev) => { const a = card(ev.iid); const d = P.defP(ev); return a && d && opponents(c.controller).includes(d) && (!w || (w === 'with flying' ? hasKw(a, 'flying') : Object.values(a.counters || {}).some((v) => v > 0))) && { it: { iid: a.iid }, thatPlayer: d }; } });
        continue;
      }
      if ((q = line.match(/^Whenever a creature with flying attacks, (.+)$/i))) { add('p:attacks', q[1], { pred: (c, ev) => card(ev.iid) && hasKw(card(ev.iid), 'flying') && { it: { iid: ev.iid } } }); continue; }
      if ((q = line.match(/^Whenever a creature you control that((?: entered this turn)|(?:'s enchanted or equipped)) attacks, (.+)$/i))) {
        const ent = /entered/.test(q[1]);
        add('p:attacks', q[2], { pred: (c, ev) => { const a = card(ev.iid); return a && a.controller === c.controller && (ent ? a.enteredTurn === G.s.turn : P.attachedTo(a.iid).length > 0) && { it: { iid: a.iid } }; } });
        continue;
      }
      if ((q = line.match(/^Whenever equipped creature attacks the monarch, (.+)$/i))) { add('p:attacks', q[1], { pred: (c, ev) => ev.iid === c.attachedTo && P.defP(ev) === G.s.monarch && { thatPlayer: G.s.monarch, it: { iid: ev.iid } } }); continue; }
      if ((q = line.match(/^Whenever ~ or equipped creature attacks, (.+)$/i))) { add('attacks', q[1], { self: true }); add('attacks', q[1], { attachedTo: true }); continue; }
      if ((q = line.match(/^Whenever equipped creature attacks or blocks, (.+)$/i))) { add('attacks', q[1], { attachedTo: true }); add('p:blocks', q[1], { pred: (c, ev) => ev.iid === c.attachedTo && { it: { iid: ev.iid } } }); continue; }
      if ((q = line.match(/^Whenever a player attacks you(?: or a planeswalker you control)?, (.+)$/i))) { add('youAttack', q[1], { defend: true }); continue; }
      if ((q = line.match(/^Whenever a player attacks, (.+)$/i))) { add('youAttack', q[1], { anyAttacker: true }); continue; }
      if ((q = line.match(/^Whenever (a player|an opponent) attacks (one|one or more|another one) of your opponents, (.+)$/i))) {
        const oppOnly = q[1] === 'an opponent';
        const t = q[3];
        add('p:youAttack', t, { pred: (c, ev) => { if (oppOnly && ev.controller === c.controller) return false; const ds = P.defenders(ev).filter((d) => d !== c.controller && opponents(c.controller).includes(d) && d !== ev.controller); if (!ds.length) return false; return /^that attacking player creates a tapped 2\/1/i.test(t) ? ds.map((d) => ({ thatPlayer: d, attacker: ev.controller })) : { thatPlayer: ev.controller, attacker: ev.controller }; },
          ...(/^that attacking player creates a tapped 2\/1/i.test(t) ? { fn: async (ctx, hit, ev) => { const [tk] = createToken(genericTokenDef(2, 1, 'Inkling', ['W', 'B'], { keywords: ['flying'] }), ev.controller, 1); P.joinAttack(tk, hit.thatPlayer); return [`${seatName(ev.controller)} creates an attacking Inkling`]; } }
            : /^that attacking player creates a Treasure token/i.test(t) ? { fn: async (ctx, hit, ev) => { createToken(genericTokenDef(0, 0, 'Treasure'), ev.controller, 1); return [`${seatName(ev.controller)} creates a Treasure`]; } }
            : /^you and the attacking player each draw a card and lose 1 life/i.test(t) ? { fn: async (ctx, hit, ev) => { for (const p of [ctx.me, ev.controller]) { drawCards(p, 1, true); changeLife(p, -1); } return ['you and the attacking player each draw a card and lose 1 life']; } } : {}) });
        continue;
      }
      if ((q = line.match(/^Whenever one or more creatures attack one of your opponents or a planeswalker they control, (.+)$/i))) {
        add('p:youAttack', q[1], { pred: (c, ev) => { const cb = G.s.combat || {}; const by = {}; for (const a of cb.attackers || []) { const ac = card(a); if (!ac || ac.controller !== ev.controller) continue; const d = P.defP({ iid: a, defender: ev.defender }); if (d && opponents(c.controller).includes(d)) (by[d] = by[d] || []).push(a); } const r = Object.entries(by).map(([d, ids]) => ({ thatPlayer: d, them: ids })); return r.length ? r : false; } });
        continue;
      }
      if ((q = line.match(/^Whenever one or more creatures (you control that entered this turn attack a player|that are enchanted by an Aura you control attack), (.+)$/i))) {
        const ent = /entered/.test(q[1]);
        add('p:youAttack', q[2], { pred: (c, ev) => { const ids = ((G.s.combat || {}).attackers || []).map(card).filter((a) => a && (ent ? a.controller === c.controller && a.enteredTurn === G.s.turn : P.attachedTo(a.iid).some((x) => x.controller === c.controller && /Aura/.test(typeLine(x))))); return ids.length && (!ent || ev.controller === c.controller) && { thatPlayer: ev.defender && G.s.players[ev.defender] ? ev.defender : opp(c.controller), them: ids.map((a) => a.iid) }; } });
        continue;
      }
      if ((q = line.match(/^When you attack enchanted opponent or a planeswalker they control or when they attack you or a planeswalker you control, (.+)$/i))) {
        add('p:youAttack', q[1], { pred: (c, ev) => { const e = c.enchantedPlayer || (card(c.attachedTo) || {}).controller; return !!e && ((ev.controller === c.controller && P.defenders(ev).includes(e)) || (ev.controller === e && P.defenders(ev).includes(c.controller))); } });
        continue;
      }
      if ((q = line.match(/^At the beginning of enchanted (?:player|opponent)'s (upkeep|draw step|end step), (.+)$/i))) { add({ upkeep: 'upkeep', 'draw step': 'drawStep', 'end step': 'endStep' }[q[1]], q[2], { whose: 'enchanted' }); continue; }
      if ((q = line.match(/^At the beginning of the monarch's end step, (.+)$/i))) { add('p:endStep', q[1], { pred: (c, ev) => !!G.s.monarch && ev.active === G.s.monarch && { thatPlayer: ev.active } }); continue; }
      if ((q = line.match(/^At end of combat on your turn, (.+)$/i))) { add('endCombat', q[1], {}); continue; }
      if ((q = line.match(/^Whenever a creature you control becomes blocked, (.+)$/i))) { add('blocked', q[1], { anyOfMine: true }); continue; }
      // combat damage
      if ((q = line.match(/^When your commander deals combat damage to a player, (.+)$/i))) { add('p:combatDamagePlayer', q[1], { pred: (c, ev) => { const a = card(ev.iid); return a && a.isCommander && a.controller === c.controller && { thatPlayer: ev.player, it: { iid: a.iid } }; } }); continue; }
      if ((q = line.match(/^Whenever (a creature token you control|~ or another ([A-Z]\w+) you control|an? ([A-Z]\w+(?:, [A-Z]\w+)*,? or [A-Z]\w+) you control|a creature you control with power greater than its base power|a creature) deals combat damage to (a player|you), (.+)$/))) {
        const who_ = q[1], sub = q[2], subs = q[3] ? q[3].replace(/,? or /, ', ').split(/,\s*/) : null, toMe = q[4] === 'you';
        add('p:combatDamagePlayer', q[5], { pred: (c, ev) => {
          const a = card(ev.iid);
          if (!a || !(ev.amount > 0)) return false;
          if (toMe) return ev.player === c.controller && { it: { iid: a.iid }, thatPlayer: a.controller, amount: ev.amount };
          if (who_ === 'a creature' ) return false;
          if (a.controller !== c.controller) return false;
          const ok = /token/.test(who_) ? a.token : sub ? a.iid === c.iid || hasSubtype(a, sub) : subs ? subs.some((t) => hasSubtype(a, t)) : power(a) > (+face(a).power || 0);
          return ok && { it: { iid: a.iid }, thatPlayer: ev.player, amount: ev.amount };
        } });
        continue;
      }
      if ((q = line.match(/^Whenever one or more (creatures you control that entered this turn|creature tokens you control|creatures you control with (trample|flying)|([A-Z]\w+?)s you control|creatures an opponent controls) deal combat damage to (a player|one or more of your opponents), (.+)$/))) {
        const w = q[1], kw = q[2], sub = q[3];
        const t = q[5];
        add('p:combatDamageOnce', t, { pred: (c, ev) => {
          if (/opponent controls/.test(w)) return ev.controller !== c.controller && ev.player !== c.controller && { thatPlayer: ev.controller };
          if (ev.controller !== c.controller) return false;
          if (/one or more of your opponents/.test(q[4]) && !opponents(c.controller).includes(ev.player)) return false;
          const srcs = (ev.sources || []).filter((x) => { const a = card(x.iid); return a && (/entered/.test(w) ? a.enteredTurn === G.s.turn : /token/.test(w) ? a.token : kw ? hasKw(a, kw) : hasSubtype(a, sub)); });
          if (!srcs.length) return false;
          const amt = srcs.reduce((n, x) => n + x.amount, 0);
          return { thatPlayer: ev.player, amount: amt, x: amt, them: srcs.map((x) => x.iid) };
        }, ...(/^you and the controller of those creatures each draw a card/i.test(t) ? { fn: async (ctx, hit) => { drawCards(ctx.me, 1, true); drawCards(hit.thatPlayer, 1, true); return ['you and that player each draw a card']; } } : {}) });
        continue;
      }
      if ((q = line.match(/^Whenever one or more creatures an opponent controls deal combat damage to you, (.+)$/i))) { add('combatDamagedMe', q[1], {}); continue; }
      // damage
      if ((q = line.match(/^Whenever (a ([A-Z]\w+)|a source you control|another source you control|a red source you control|~|an ([A-Z]\w+) you control) deals (exactly (\d+) |(\d+) or more |noncombat )?damage to (you|a player|a permanent or player|a creature|one or more permanents and\/or players|one or more of your opponents during your turn), (.+)$/))) {
        const who_ = q[1], sub = q[2] || q[3], exact = q[5] ? +q[5] : null, min = q[6] ? +q[6] : null, noncombat = /noncombat/.test(q[4] || ''), to = q[7];
        const t = q[8];
        add('p:dealsDamage', t, { pred: (c, ev) => {
          const s0 = card(ev.iid);
          if (!s0 || !(ev.amount > 0)) return false;
          if (who_ === '~' ? s0.iid !== c.iid : /source you control/.test(who_) ? s0.controller !== c.controller || (/another/.test(who_) && s0.iid === c.iid) || (/red/.test(who_) && !(DB[s0.def].colors || []).includes('R')) : sub ? !hasSubtype(s0, sub) || (/you control/.test(who_) && s0.controller !== c.controller) : false) return false;
          if (exact !== null && ev.amount !== exact) return false;
          if (min !== null && ev.amount < min) return false;
          if (noncombat && ev.combat) return false;
          if (to === 'you' && ev.player !== c.controller) return false;
          if (to === 'a player' && !ev.player) return false;
          if (to === 'a creature' && !(ev.other && card(ev.other) && isCreature(card(ev.other)))) return false;
          if (/opponents during your turn/.test(to) && !(ev.player && opponents(c.controller).includes(ev.player) && G.s.active === c.controller)) return false;
          const r = { amount: ev.amount, it: { iid: ev.other || s0.iid }, thatPlayer: ev.player || (ev.other && card(ev.other) ? card(ev.other).controller : null) };
          if (to === 'you') r.it = { iid: s0.iid };
          if (exact !== null) r.text = ev.player ? `~ deals 2 damage to that player.` : `~ deals 2 damage to that creature.`;
          return r;
        } });
        continue;
      }
      if ((q = line.match(/^Whenever (?:~ or a creature it's paired with|a ([A-Z]\w+) you control|a creature deals damage to enchanted planeswalker,?) ?(?:is dealt damage)?, (.+)$/))) {
        const sub = q[1];
        const pw = /enchanted planeswalker/.test(line.split(',')[0]);
        add('p:dealtDamage', q[2], { pred: (c, ev) => {
          const t0 = card(ev.iid);
          if (!t0 || !(ev.amount > 0)) return false;
          if (pw) return ev.iid === c.attachedTo && ev.other && card(ev.other) && isCreature(card(ev.other)) && { it: { iid: ev.other } };
          if (sub) return t0.controller === c.controller && hasSubtype(t0, sub) && { it: { iid: t0.iid }, amount: ev.amount, text: `It deals ${ev.amount} damage to any target that isn't a ${sub}.` };
          return (ev.iid === c.iid || (c.pairedWith && ev.iid === c.pairedWith)) && { amount: ev.amount };
        } });
        continue;
      }
      // dying / leaving
      if ((q = line.match(/^Whenever a nontoken creature you control with a \+1\/\+1 counter on it dies, (.+)$/i))) { add('dies', q[1], { mine: true, nontoken: true, withCounter: '+1/+1' }); continue; }
      if ((q = line.match(/^Whenever a creature with an? ([a-z]+) counter on it dies, (.+)$/i))) { add('dies', q[2], { withCounter: q[1] }); continue; }
      if ((q = line.match(/^When a creature you control dies, (.+)$/i))) { add('dies', q[1], { mine: true }); continue; }
      if ((q = line.match(/^Whenever a creature with a coin counter on it dies or is put into exile, (.+)$/i))) { add('p:leaves', q[1], { pred: (c, ev) => ev.creature && (ev.to === 'graveyard' || ev.to === 'exile') && (ev.counters || {}).coin > 0 && { it: { iid: ev.iid }, thatPlayer: ev.controller } }); continue; }
      if ((q = line.match(/^Whenever a creature other than ~ is exiled from the battlefield, you gain life equal to its power\.$/i))) { add('p:leaves', '', { pred: (c, ev) => ev.to === 'exile' && ev.creature && ev.iid !== c.iid && { text: `You gain ${Math.max(0, ev.power || 0)} life.` } }); continue; }
      if ((q = line.match(/^Whenever a creature is exiled from the battlefield, (.+)$/i))) { add('p:leaves', q[1], { pred: (c, ev) => ev.to === 'exile' && ev.creature && { it: { iid: ev.iid } } }); continue; }
      if ((q = line.match(/^Whenever a creature with (toughness|power) (\d+) or (greater|less) is put into your graveyard from the battlefield, (.+)$/i))) {
        const st = q[1], k = +q[2], gt = q[3] === 'greater';
        add('p:dies', q[4], { pred: (c, ev) => ev.owner === c.controller && (gt ? (ev[st] || 0) >= k : (ev[st] || 0) <= k) && { it: { iid: ev.iid } } });
        continue;
      }
      if ((q = line.match(/^Whenever a creature you control exploits a creature, (.+)$/i))) { add('p:exploited', q[1], { pred: (c, ev) => ev.controller === c.controller }); continue; }
      if ((q = line.match(/^Whenever a modified creature you control leaves the battlefield, (.+)$/i))) { add('p:leaves', q[1], { pred: (c, ev) => ev.creature && ev.controller === c.controller && P.wasModified(ev) }); continue; }
      if ((q = line.match(/^Whenever enchanted creature or another modified creature you control dies, (.+)$/i))) { add('p:dies', q[1], { pred: (c, ev) => ((ev.attached || []).includes(c.iid) || (ev.controller === c.controller && P.wasModified(ev))) && { it: { iid: ev.iid }, x: Math.max(0, ev.power || 0) } }); continue; }
      if ((q = line.match(/^Whenever one or more creature cards are put into your graveyard from anywhere during your turn, (.+)$/i))) { add('p:toGraveyard', q[1], { pred: (c, ev) => ev.owner === c.controller && G.s.active === c.controller && /Creature/.test(P.tl(ev)) }); continue; }
      if ((q = line.match(/^Whenever a nontoken creature enchanted player controls dies, (.+)$/i))) { add('p:dies', q[1], { pred: (c, ev) => !ev.token && ev.controller === (c.enchantedPlayer || opp(c.controller)) && { it: { iid: ev.iid } } }); continue; }
      if ((q = line.match(/^Whenever an attacking creature you control or a blocking creature an opponent controls dies, (.+)$/i))) { add('p:dies', q[1], { pred: (c, ev) => (ev.controller === c.controller && ev.wasAttacking) || (ev.controller !== c.controller && ev.wasBlocking) }); continue; }
      if ((q = line.match(/^Whenever a nontoken artifact you control is put into a graveyard from the battlefield, (.+)$/i))) { add('p:leaves', q[1], { pred: (c, ev) => ev.to === 'graveyard' && ev.artifact && !ev.token && ev.controller === c.controller && { it: { iid: ev.iid } } }); continue; }
      if ((q = line.match(/^Whenever an artifact an opponent controls is put into a graveyard from the battlefield, (.+)$/i))) { add('p:leaves', q[1], { pred: (c, ev) => ev.to === 'graveyard' && ev.artifact && ev.controller !== c.controller && { thatPlayer: ev.controller } }); continue; }
      if ((q = line.match(/^Whenever (~ or another nontoken artifact you control|an artifact) is put into a graveyard from the battlefield or is put into exile from the battlefield, (.+)$/i))) {
        const mine = /you control/.test(q[1]);
        add('p:leaves', q[2], { pred: (c, ev) => (ev.to === 'graveyard' || ev.to === 'exile') && ev.artifact && ev.iid !== c.iid && (!mine || (ev.controller === c.controller && !ev.token)) });
        if (mine) add('p:leaves', q[2], { selfGone: true, pred: (c, ev) => ev.iid === c.iid && (ev.to === 'graveyard' || ev.to === 'exile') });
        continue;
      }
      if ((q = line.match(/^Whenever another artifact is put into your graveyard from the battlefield or an artifact card is put into your graveyard from anywhere other than the battlefield, (.+)$/i))) { add('p:toGraveyard', q[1], { pred: (c, ev) => ev.owner === c.controller && ev.iid !== c.iid && /Artifact/.test(P.tl(ev)) }); continue; }
      if ((q = line.match(/^Whenever a creature card is put into an opponent's graveyard from their library, (.+)$/i))) { add('p:toGraveyard', q[1], { pred: (c, ev) => ev.from === 'library' && ev.owner !== c.controller && /Creature/.test(P.tl(ev)) && { it: { iid: ev.iid }, thatPlayer: ev.owner } }); continue; }
      if ((q = line.match(/^Whenever one or more (artifacts you control leave the battlefield during your turn|other creatures you control leave the battlefield), (.+)$/i))) {
        const art = /artifacts/.test(q[1]);
        add('p:leaves', q[2], { pred: (c, ev) => ev.controller === c.controller && ev.iid !== c.iid && (art ? ev.artifact && G.s.active === c.controller : ev.creature) });
        continue;
      }
      if ((q = line.match(/^Whenever another permanent you control is put into a graveyard from the battlefield, if it had one or more counters on it, you may put that number of \+1\/\+1 counters on target creature\.$/i))) {
        add('p:leaves', '', { pred: (c, ev) => { const k = Object.values(ev.counters || {}).reduce((a, v) => a + Math.max(0, v), 0); return ev.to === 'graveyard' && ev.controller === c.controller && ev.iid !== c.iid && k > 0 && { amount: k, text: `You may put ${k} +1/+1 counters on target creature.` }; }, optional: true });
        continue;
      }
      if ((q = line.match(/^Whenever another nontoken ([A-Z]\w+) is put into your graveyard from the battlefield, (.+)$/))) { const ty = q[1]; add('p:leaves', q[2], { pred: (c, ev) => ev.to === 'graveyard' && ev.owner === c.controller && !ev.token && ev.iid !== c.iid && new RegExp('\\b' + ty + '\\b').test(P.tl(ev)) }); continue; }
      if ((q = line.match(/^Whenever a commander an opponent controls dies, (.+)$/i))) { add('p:dies', q[1], { pred: (c, ev) => ev.isCommander && ev.controller !== c.controller }); continue; }
      if ((q = line.match(/^Whenever a creature dealt damage by ~ this turn dies, (.+)$/i))) { add('p:dies', q[1], { pred: (c, ev) => (ev.dmgBy || []).includes(c.iid) && { it: { iid: ev.iid } } }); continue; }
      if ((q = line.match(/^When you sacrifice ~, (.+)$/i))) { add('p:sacrificed', q[1], { selfGone: true, pred: (c, ev) => ev.iid === c.iid }); continue; }
      if ((q = line.match(/^When ~ is put into a graveyard from anywhere, (.+)$/i))) { add('p:toGraveyard', q[1], { fromGy: true, pred: (c, ev) => ev.iid === c.iid }); continue; }
      if ((q = line.match(/^When you lose control of ~, (.+)$/i))) { add('p:controlLost', q[1], { pred: (c, ev) => ev.iid === c.iid && { controller: ev.from } }); continue; }
      // exile batches (Hero of Bretagard, Ranar)
      if ((q = line.match(/^Whenever one or more cards are put into exile from your hand or a spell or ability you control exiles one or more permanents from the battlefield, (.+)$/i))) {
        add('p:exiledBatch', q[1], { pred: (c, ev) => { const k = (ev.items || []).filter((x) => (x.from === 'hand' && x.owner === c.controller) || (x.from === 'battlefield' && x.by === c.controller)).length; return k > 0 && { amount: k }; } });
        continue;
      }
      // targets
      if ((q = line.match(/^Whenever a Sliver creature you control becomes the target of a spell or ability an opponent controls, (.+)$/i))) { add('becomesTarget', q[1], { sub: 'Sliver' }); continue; }
      if ((q = line.match(/^Whenever a creature or planeswalker you control becomes the target of a spell or ability an opponent controls, (.+)$/i))) { add('p:becomesTarget', q[1], { pred: (c, ev) => { const t0 = card(ev.iid); return t0 && t0.controller === c.controller && ev.controller !== c.controller && (isCreature(t0) || isType(t0, 'Planeswalker')) && { thatPlayer: ev.controller }; } }); continue; }
      if ((q = line.match(/^Whenever one or more creatures you control become the target of an activated ability, (.+)$/i))) { add('p:becomesTarget', q[1], { pred: (c, ev) => { const t0 = card(ev.iid); return t0 && !ev.bySpell && t0.controller === c.controller && isCreature(t0); } }); continue; }
      // counters
      if ((q = line.match(/^Whenever an opponent puts one or more counters on a creature they control, they put the same number and kind of counters on ~\.$/i))) {
        add('p:counterPut', '', { pred: (c, ev) => { const t0 = card(ev.iid); return ev.by && ev.by !== c.controller && t0 && t0.controller === ev.by && isCreature(t0) && ev.iid !== c.iid && ev.n > 0; },
          fn: async (ctx, hit, ev) => { const me = card(hit.src.iid); if (!me || me.zone !== 'battlefield') return []; addCounters(me, ev.kind, ev.n); return [`gets ${ev.n} ${ev.kind} counter${ev.n === 1 ? '' : 's'}`]; } });
        continue;
      }
      if ((q = line.match(/^Whenever you put one or more time counters on a permanent you control, (.+)$/i))) { add('p:counterPut', q[1], { pred: (c, ev) => ev.kind === 'time' && (!ev.by || ev.by === c.controller) && card(ev.iid) && card(ev.iid).controller === c.controller && card(ev.iid).zone === 'battlefield' }); continue; }
      if ((q = line.match(/^Whenever (?:a|you remove a) time counter is removed from ~ while it's exiled, (.+)$/i)) || (q = line.match(/^Whenever you remove a time counter from ~ while it's exiled, (.+)$/i))) { add('p:timeRemoved', q[1], { inExile: true, selfGone: true, pred: (c, ev) => ev.iid === c.iid }); continue; }
      if ((q = line.match(/^Whenever one or more time counters are removed from ~, (.+)$/i))) { add('p:timeRemoved', q[1], { pred: (c, ev) => ev.iid === c.iid }); continue; }
      // life
      if ((q = line.match(/^Whenever one or more opponents lose life, (.+)$/i))) { add('p:lifeLost', q[1], { pred: (c, ev) => ev.amount > 0 && opponents(c.controller).includes(ev.pid) && { thatPlayer: ev.pid } }); continue; }
      if ((q = line.match(/^Whenever an opponent loses life for the first time during each of their turns, (.+)$/i))) {
        add('p:lifeLost', q[1], { pred: (c, ev) => { if (!(ev.amount > 0) || !opponents(c.controller).includes(ev.pid) || G.s.active !== ev.pid) return false; const st = (G.s.firstLoss = G.s.firstLoss || {}); const key = c.iid + ':' + ev.pid; if (st[key] === G.s.turn) return false; st[key] = G.s.turn; return { thatPlayer: ev.pid }; } });
        continue;
      }
      if ((q = line.match(/^Whenever an opponent who controls an artifact named ~ (draws a card|gains life) during their turn, (.+)$/i))) {
        const ev_ = /draws/.test(q[1]) ? 'p:draw' : 'p:lifeGained';
        add(ev_, q[2], { pred: (c, ev) => ev.pid !== c.controller && G.s.active === ev.pid && cardsIn(ev.pid, 'battlefield').some((x) => DB[x.def].name === DB[c.def].name) && { thatPlayer: ev.pid } });
        continue;
      }
      // misc events
      if ((q = line.match(/^Whenever you investigate for the first time each turn, (.+)$/i))) { add('p:investigated', q[1], { pred: (c, ev) => ev.pid === c.controller && ev.first }); continue; }
      if ((q = line.match(/^Whenever a creature you control fights, (.+)$/i))) { add('p:fought', q[1], { pred: (c, ev) => ev.controller === c.controller && card(ev.iid) && { it: { iid: ev.iid } } }); continue; }
      if ((q = line.match(/^Whenever you roll a (\d+) or higher, (.+)$/i))) {
        const k = +q[1];
        add('p:dieRolled', q[2], { pred: (c, ev) => ev.pid === c.controller && ev.result >= k && { amount: ev.result, x: ev.result, ...(/If you rolled (\d+) or higher, instead create that token and a Treasure token/i.test(q[2]) ? { text: ev.result >= +q[2].match(/If you rolled (\d+) or higher/i)[1] ? 'Create a 3/3 colorless Robot artifact creature token and a Treasure token.' : 'Create a 3/3 colorless Robot artifact creature token.' } : {}) } });
        continue;
      }
      if ((q = line.match(/^Whenever you roll a die's highest natural result, (.+)$/i))) { add('p:dieRolled', q[1], { pred: (c, ev) => ev.pid === c.controller && ev.result === ev.sides }); continue; }
      if ((q = line.match(/^Whenever you roll one or more dice, (.+)$/i))) { add('p:dieRolled', q[1], { pred: (c, ev) => ev.pid === c.controller }); continue; }
      if ((q = line.match(/^Whenever you win a coin flip, (.+)$/i))) { add('p:coinFlipWon', q[1], { pred: (c, ev) => ev.pid === c.controller }); continue; }
      if ((q = line.match(/^Whenever an opponent commits a crime, (.+)$/i))) { add('p:crime', q[1], { pred: (c, ev) => ev.pid !== c.controller && { thatPlayer: ev.pid } }); continue; }
      if ((q = line.match(/^Whenever you expend (\d+), (.+)$/i))) { const k = +q[1]; add('p:expend', q[2], { pred: (c, ev) => ev.pid === c.controller && ev.n === k }); continue; }
      if ((q = line.match(/^Whenever (a player|an opponent) loses the game, (.+)$/i))) {
        const oppOnly = /opponent/.test(q[1]);
        add('p:playerLost', q[2], { pred: (c, ev) => (!oppOnly || ev.pid !== c.controller) && { thatPlayer: ev.pid } });
        continue;
      }
      if ((q = line.match(/^Whenever an opponent (scries|surveils), (?:surveils, )?(?:or )?(?:searches their library, )?(.+)$/i)) || (q = line.match(/^Whenever an opponent scries, surveils, or searches their library, (.+)$/i))) {
        const t = q[2] || q[1];
        add('p:scry', t, { pred: (c, ev) => ev.pid !== c.controller && { thatPlayer: ev.pid } });
        add('p:surveil', t, { pred: (c, ev) => ev.pid !== c.controller && { thatPlayer: ev.pid } });
        add('p:searched', t, { pred: (c, ev) => ev.pid !== c.controller && { thatPlayer: ev.pid } });
        continue;
      }
      if ((q = line.match(/^Whenever a creature an opponent controls becomes tapped, if it isn't being declared as an attacker, (.+)$/i))) { add('p:tapped', q[1], { pred: (c, ev) => { const t0 = card(ev.iid); return t0 && isCreature(t0) && t0.controller !== c.controller && !t0.attacking && !(G.s.declaringAttack) && { it: { iid: t0.iid } }; } }); continue; }
      if ((q = line.match(/^Whenever ~ evolves, (.+)$/i))) { add('p:evolved', q[1], { pred: (c, ev) => ev.iid === c.iid }); continue; }
      if ((q = line.match(/^Whenever you discard one or more nonland cards for the first time each turn, (.+)$/i))) {
        add('p:discard', q[1], { pred: (c, ev) => { if (ev.pid !== c.controller || !card(ev.iid) || isLand(card(ev.iid))) return false; const st = (G.s.firstDiscard = G.s.firstDiscard || {}); if (st[c.iid] === G.s.turn) return false; st[c.iid] = G.s.turn; return true; } });
        continue;
      }
      if ((q = line.match(/^Whenever the final chapter ability of a Saga you control (?:triggers|resolves), (.+)$/i))) {
        add('p:chapter', q[1], { pred: (c, ev) => { const sg = card(ev.iid); if (!sg || ev.controller !== c.controller) return false; const last = Math.max(0, ...((face(sg).oracle || '').match(/^(I|II|III|IV|V|VI)\b(?=[^\n]*—)/gm) || []).map((r) => ({ I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6 })[r] || 0)); return ev.chapter >= last && last > 0 && { it: { iid: sg.iid }, x: DB[sg.def].cmc || 0 }; } });
        continue;
      }
    }
  }
  return out;
}

// "When ~ has no ice counters on it" / "… twenty or more charge counters on it": triggers once when it becomes true
function stateTriggerCheck() {
  if (!G.s) return;
  for (const pid of seats()) for (const iid of G.s.players[pid].zones.battlefield) {
    const c = G.s.cards[iid];
    if (!c || c.phasedOut || !/ has (?:no|\w+ or more) [a-z+\/1-]+ counters on it/.test(oracle(c))) continue;
    for (const trig of triggersOf(c)) {
      if (trig.event !== 'stateCounters') continue;
      const k = (c.counters || {})[trig.kind] || 0;
      const on = trig.cmp === 'none' ? k === 0 && c.hadCtr && c.hadCtr[trig.kind] : k >= trig.n;
      if (k > 0) (c.hadCtr = c.hadCtr || {})[trig.kind] = true;
      c.stFired = c.stFired || {};
      if (on && !c.stFired[trig.raw]) {
        c.stFired[trig.raw] = true;
        queueEvent({ type: 'stateCounters', iid: c.iid, raw: trig.raw });
      } else if (!on) c.stFired[trig.raw] = false;
    }
  }
}

// ------------------------------------------------------------ keyword triggers
// Remembered per card until something relevant changes (the board, its grants, counters, face, the turn/step):
// with hundreds of tokens every event used to re-check every keyword on every permanent.
const kwTrigCache = new WeakMap();
function keywordTriggers(c) {
  if (!c || !G.s || G.s.cards[c.iid] !== c) return keywordTriggersRaw(c);
  const key = [G.s.bfv || 0, G.s.turn, G.s.step, G.s.active, c.zone, c.controller, c.face || 0, c.faceDown ? 1 : 0, c.lostAbilities ? 1 : 0,
    (c.grants || []).join(','), (c.eotGrants || []).join(','), JSON.stringify(c.counters || {}), c.extraText || '', (c.layerFx || []).length, c.attachedTo || '', c.bloodthirstGrant || 0,
    (G.s.players[c.controller] && (G.s.players[c.controller].emblems || []).length) || 0].join('|');
  const hit = kwTrigCache.get(c);
  if (hit && hit.key === key) return hit.out;
  const out = keywordTriggersRaw(c);
  kwTrigCache.set(c, { key, out });
  return out;
}
function keywordTriggersRaw(c) {
  if (!c || c.faceDown || (c.zone === 'battlefield' ? abilitiesGone(c) : c.lostAbilities) || c.zone === 'command') return [];
  const out = [];
  const t = (event, text, extra = {}) => out.push({ event, text, raw: text, kw: true, ...extra });
  const f = (event, fn, label, extra = {}) => out.push({ event, fn, raw: label, kw: true, ...extra });
  const o = oracle(c);
  if (hasKw(c, 'prowess')) t('cast', '~ gets +1/+1 until end of turn', { spell: 'noncreature', mine: true, self: false });
  // Soulbond: pair this creature with another unpaired creature you control when either enters
  if (/(?:^|\n|, )Soulbond\b/i.test(o)) {
    const unpaired = (x) => x && x.zone === 'battlefield' && isCreature(x) && !(x.pairedWith && card(x.pairedWith) && card(x.pairedWith).zone === 'battlefield' && card(x.pairedWith).controller === x.controller);
    const pair = async (me, other) => {
      if (!unpaired(me) || !unpaired(other) || me.iid === other.iid || me.controller !== other.controller) return [];
      const pid = me.controller;
      const yes = isAI(pid) ? true : await T.confirm(cardName(me), `Soulbond: pair ${cardName(me)} with ${cardName(other)}?`);
      if (!yes) return [];
      me.pairedWith = other.iid;
      other.pairedWith = me.iid;
      return [`pairs with ${nameTag(other)}`];
    };
    f('enters', async (ctx, hit) => {
      const me = card(c.iid);
      if (!unpaired(me)) return [];
      const pool = cardsIn(me.controller, 'battlefield').filter((x) => x.iid !== me.iid && unpaired(x));
      if (!pool.length) return [];
      let pick;
      if (isAI(me.controller)) pick = pool.sort((a, b) => cardValue(b) - cardValue(a))[0];
      else { const [i] = await T.choosers[me.controller].pickCards({ prompt: `Soulbond: pair ${cardName(me)} with another creature? (none to skip)`, cards: pool.map((x) => x.iid), min: 0, max: 1, purpose: 'pair', src: me, aiScore: (x) => cardValue(x) }); pick = i && card(i); if (!pick) return []; me.pairedWith = pick.iid; pick.pairedWith = me.iid; return [`pairs with ${nameTag(pick)}`]; }
      return pair(me, pick);
    }, 'Soulbond', { self: true });
    f('enters', async (ctx, hit, ev) => {
      const me = card(c.iid);
      const nc = card(ev.iid);
      if (!me || !nc || nc.iid === me.iid) return [];
      return pair(me, nc);
    }, 'Soulbond', { other: true, mine: true, kind: 'creature' });
  }
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
    const def = attackedPlayer(c);
    // "the player with the most life or tied for most life"
    const most = multiplayer() ? Math.max(...livingSeats().map((k) => G.s.players[k].life)) : G.s.players[c.controller].life;
    if (G.s.players[def].life >= most) {
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
    const def = attackedPlayer(c);
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
    tapPerm(card(pick));
    pumpEOT(c, { p: power(card(pick)), t: 0, grants: [] });
    if (card(c.iid)) card(c.iid).enlistedTurn = G.s.turn; // Aradesh
    return [`enlists ${nameTag(card(pick))} (+${power(card(pick))}/+0)`];
  }, 'Enlist', { self: true });
  if (hasKw(c, 'evolve')) f('enters', async (ctx, hit, ev) => {
    const nc = card(ev.iid);
    if (!nc || !isCreature(nc) || nc.iid === c.iid) return [];
    if (power(nc) > power(c) || toughness(nc) > toughness(c)) {
      addCounters(c, '+1/+1', 1);
      queueEvent({ type: 'evolved', iid: c.iid, controller: c.controller }); // Watchful Radstag
      return ['evolves'];
    }
    return [];
  }, 'Evolve', { other: true, mine: true, kind: 'creature' });
  // Sieges (Windcrag Siege, Outpost Siege…): "As this enchantment enters, choose Mardu or Jeskai."
  {
    const sm = (DB[c.def].faces[c.face || 0].oracle || '').match(/(?:^|\n)As (?:~|this [a-z]+|[^,\n]+) enters(?: the battlefield)?, choose ([A-Z][a-z]+) or ([A-Z][a-z]+)\./);
    if (sm && !c.chosenMode)
      f('enters', async () => {
        const opts = [sm[1], sm[2]];
        const raw = DB[c.def].faces[c.face || 0].oracle || '';
        // the AI takes the mode that does something every turn
        const aiPick = () => (new RegExp(`• ${opts[1]} — At the beginning`).test(raw) ? 1 : 0);
        const k = await (T.choosers[c.controller] || T.choosers.p).choose({ prompt: `${cardName(c)}: choose ${opts[0]} or ${opts[1]}`, options: opts.map((x) => ({ label: x })), aiPick });
        if (!card(c.iid)) return [];
        card(c.iid).chosenMode = opts[k === 1 ? 1 : 0];
        return [`chooses ${card(c.iid).chosenMode}`];
      }, 'Choose a mode', { self: true, asEnters: true });
  }
  if (/(?:^|\n|\. )As (?:~|this [a-z]+|it) enters(?: the battlefield)?, choose a creature type/i.test(o.split(DB[c.def].name).join('~')) && !c.chosenType)
    f('enters', async () => {
      const t = await chooseCreatureType(c.controller, `${cardName(c)}: choose a creature type`);
      if (!t || !card(c.iid)) return [];
      card(c.iid).chosenType = t;
      return [`chooses ${t}`];
    }, 'Choose a creature type', { self: true, asEnters: true });
  // Squall, Gunblade Duelist: "As Squall enters, choose a number."
  if (/(?:^|\n|\. )As (?:~|this [a-z]+|it) enters(?: the battlefield)?, choose a number/i.test(o.split(DB[c.def].name).join('~').split(String(DB[c.def].name).split(',')[0]).join('~')) && c.chosenNumber === undefined)
    f('enters', async () => {
      const mine = cardsIn(c.controller, 'battlefield').concat(cardsIn(c.controller, 'library')).filter(isCreature);
      const counts = {};
      for (const y of mine) { const p = parseInt(DB[y.def].faces[0].power, 10); if (!isNaN(p)) counts[p] = (counts[p] || 0) + 1; }
      const best = +(Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [3])[0];
      const ch = T.choosers[c.controller] || T.choosers.p;
      const k = ch.chooseNumber ? await ch.chooseNumber({ prompt: `${cardName(c)}: choose a number`, min: 0, max: 20, ai: best }) : best;
      if (!card(c.iid)) return [];
      card(c.iid).chosenNumber = +k || 0;
      return [`chooses ${card(c.iid).chosenNumber}`];
    }, 'Choose a number', { self: true, asEnters: true });
  // Serra's Emissary: "As ~ enters, choose a card type."
  if (/(?:^|\n|\. )As (?:~|this [a-z]+|it) enters(?: the battlefield)?, choose a card type/i.test(o.split(DB[c.def].name).join('~')) && !c.chosenCardType)
    f('enters', async () => {
      const types = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land', 'Battle', 'Kindred'];
      // the AI shuts off what the opponent has shown most of (usually creatures)
      const aiPick = () => {
        const seen = Object.values(G.s.cards).filter((y) => y.owner !== c.controller && ['battlefield', 'graveyard', 'exile', 'command'].includes(y.zone) && !/Land/.test(DB[y.def].typeLine || ''));
        const n = types.map((t) => seen.filter((y) => new RegExp('\\b' + t + '\\b').test((DB[y.def].typeLine || '').split('—')[0])).length);
        n[0] += 3; // creatures also stop attackers and blockers
        return n.indexOf(Math.max(...n));
      };
      const k = await (T.choosers[c.controller] || T.choosers.p).choose({ prompt: `${cardName(c)}: choose a card type`, options: types.map((x) => ({ label: x })), aiPick });
      if (!card(c.iid)) return [];
      card(c.iid).chosenCardType = types[k] || 'Creature';
      return [`chooses ${card(c.iid).chosenCardType.toLowerCase()}`];
    }, 'Choose a card type', { self: true, asEnters: true });
  // Cloud Key: "As ~ enters, choose artifact, creature, enchantment, instant, or sorcery."
  {
    const lm = o.split(DB[c.def].name).join('~').match(/(?:^|\n|\. )As (?:~|this [a-z]+|it) enters(?: the battlefield)?, choose ((?:(?:artifact|creature|enchantment|instant|sorcery|planeswalker|land|battle), )+or (?:artifact|creature|enchantment|instant|sorcery|planeswalker|land|battle))\./i);
    if (lm && !c.chosenCardType)
      f('enters', async () => {
        const types = lm[1].replace(/,? or /, ', ').split(/,\s*/).map((t) => t[0].toUpperCase() + t.slice(1).toLowerCase());
        // the AI names what it casts most (Cloud Key's discount is for its own spells)
        const aiPick = () => {
          const mine = [...cardsIn(c.controller, 'library'), ...cardsIn(c.controller, 'hand')];
          const n = types.map((t) => mine.filter((y) => new RegExp('\\b' + t + '\\b').test((DB[y.def].typeLine || '').split('—')[0])).length);
          return n.indexOf(Math.max(...n));
        };
        const k = await (T.choosers[c.controller] || T.choosers.p).choose({ prompt: `${cardName(c)}: choose ${types.join(', ')}`, options: types.map((x) => ({ label: x })), aiPick });
        if (!card(c.iid)) return [];
        card(c.iid).chosenCardType = types[k] || types[0];
        return [`chooses ${card(c.iid).chosenCardType.toLowerCase()}`];
      }, 'Choose a card type', { self: true, asEnters: true });
  }
  // "As ~ enters, choose a color" (Utopia Sprawl, Caged Sun, Gauntlet of Power…)
  if (/(?:^|\n|\. )As (?:~|this [a-z]+|it) enters(?: the battlefield)?, choose a color/i.test(o.split(DB[c.def].name).join('~')) && !c.chosenColor)
    f('enters', async () => {
      // "choose a color other than red" (Thriving lands)
      const other = (o.match(/choose a color other than (white|blue|black|red|green)/i) || [])[1];
      const allNames = ['white', 'blue', 'black', 'red', 'green'];
      const names = allNames.filter((x) => x !== (other || '').toLowerCase());
      const cols = names.map((x) => ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' })[x]);
      // the AI picks its most common color
      const aiPick = () => {
        const n = cols.map((x) => Object.values(G.s.cards).filter((y) => y.owner === c.controller && (DB[y.def].colors || []).includes(x)).length);
        return n.indexOf(Math.max(...n));
      };
      const k = await (T.choosers[c.controller] || T.choosers.p).choose({ prompt: `${cardName(c)}: choose a color`, options: names.map((x) => ({ label: x })), aiPick });
      if (!card(c.iid)) return [];
      card(c.iid).chosenColor = cols[k] || 'G';
      return [`chooses ${names[k] || 'green'}`];
    }, 'Choose a color', { self: true, asEnters: true });
  if (/\bExtort\b/.test(o)) f('cast', async () => {
    if (!T.payMana) return [];
    const paid = await T.payMana(c.controller, '{W/B}', `Extort (${cardName(c)})`);
    if (!paid) return [];
    const opps = opponents(c.controller);
    for (const def of opps) G.s.players[def].life -= 1;
    G.s.players[c.controller].life += opps.length;
    return [`extorts ${opps.length}`];
  }, 'Extort', { spell: '', mine: true });
  if (hasKw(c, 'exploit')) f('enters', async (ctx) => {
    const cands = cardsIn(c.controller, 'battlefield').filter(isCreature);
    const yes = isAI(c.controller) ? cands.some((x) => x.token || cardValue(x) < 3) : await T.confirm(cardName(c), 'Exploit: sacrifice a creature?');
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
      return [`fabricate ${k}: puts ${k} +1/+1 counter${k > 1 ? "s" : ""} on itself`];
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
    const eat = isAI(c.controller) ? picks.filter((i) => card(i).token) : picks;
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
    const cands = seats().flatMap((k) => cardsIn(k, 'battlefield')).filter(isCreature);
    // the AI backs up a creature that can still attack this turn (it gets the abilities too), else itself
    const me = c.controller;
    const aiScore = (x) => (x.controller !== me ? -100 : x.iid === c.iid ? 3 : !x.sick || hasKw(x, 'haste') ? 6 + power(x) : 1);
    const pick = await ctx.choosers[me].target({ forced: true, prompt: `Backup ${k}: put ${k} +1/+1 counter${k === 1 ? '' : 's'} on target creature (another creature also gets ${cardName(c)}'s abilities until end of turn)`, candidates: cands.map((x) => x.iid), harm: false, src: c, aiScore });
    if (!pick || !pick.iid) return [];
    const tgt = card(pick.iid);
    addCounters(tgt, '+1/+1', k);
    if (tgt.iid !== c.iid) {
      // "it gains the following abilities until end of turn": everything printed below the Backup line
      const lines = (face(c).oracle || DB[c.def].faces[0].oracle || '').replace(/\([^)]*\)/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
      const after = lines.slice(lines.findIndex((l) => /^Backup \d+/i.test(l)) + 1);
      const kws = [];
      const texts = [];
      for (const l of after) {
        const kl = kwList(l.toLowerCase());
        if (kl.length && l.split(/,\s*/).length === kl.length) kws.push(...kl);
        else texts.push(l.split(DB[c.def].name).join('this creature'));
      }
      tgt.eotGrants = [...(tgt.eotGrants || []), ...kws];
      if (texts.length) tgt.eotText = ((tgt.eotText ? tgt.eotText + '\n' : '') + texts.join('\n')).trim();
    }
    return [`backs up ${nameTag(tgt)}`];
  }, 'Backup', { self: true });
  if (/\bLiving weapon\b/.test(o)) void 0; // handled on 'germ'
  if (kwNum(c, 'Bloodthirst') || c.bloodthirstGrant) f('enters', async () => {
    const bt = kwNum(c, 'Bloodthirst') || c.bloodthirstGrant || 0;
    delete c.bloodthirstGrant;
    if (opponents(c.controller).some((o) => (G.s.ts[o] || {}).lifeLost > 0)) {
      addCounters(c, '+1/+1', bt);
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
    const yes = isAI(c.controller) ? true : await T.confirm(cardName(c), 'Unleash: enter with a +1/+1 counter? (It can\'t block while it has one.)');
    if (yes) {
      addCounters(c, '+1/+1', 1);
      c.grants = [...(c.grants || []), 'unleashed'];
    }
    void ctx;
    return yes ? ['unleashed'] : [];
  }, 'Unleash', { self: true });
  // Firebending N: "Whenever this creature attacks, add {R} N times. This mana lasts until end of combat."
  // also when it's been given firebending (Sozin's Comet: "Each creature you control gains firebending 5 until end of turn.")
  const fbGranted = [...(c.eotGrants || []), ...(c.grants || [])].map((g) => String(g).match(/^firebending (\d+)$/i)).filter(Boolean).map((m) => +m[1]);
  if (/(?:^|\n|, )Firebending (\d+)/i.test(o) || fbGranted.length) f('attacks', async () => {
    const live = card(c.iid) || c;
    const more = [...(live.eotGrants || []), ...(live.grants || [])].map((g) => String(g).match(/^firebending (\d+)$/i)).filter(Boolean).reduce((a, m) => a + +m[1], 0);
    const k = (+(o.match(/(?:^|\n|, )Firebending (\d+)/i) || [])[1] || 0) + more;
    if (!k) return [];
    addMana(c.controller, Array(k).fill('R'));
    noteBend(c.controller, 'firebend');
    return [`adds ${'{R}'.repeat(k)} (until end of combat)`];
  }, 'Firebending', { self: true });
  // Exert: "You may exert ~ as it attacks. (When you do, …)"
  {
    const em = o.split(DB[c.def].name).join('~').replace(/\bthis creature\b/gi, '~').match(/(?:^|\n)You may exert ~ as it attacks\.(?: When you do, ([^\n(]+))?/i);
    if (em) f('attacks', async (ctx) => {
      const live = card(c.iid);
      if (!live || live.zone !== 'battlefield') return [];
      const yes = isAI(live.controller) ? true : await T.confirm(cardName(live), `Exert ${cardName(live)}? (It won't untap during your next untap step.)`);
      if (!yes) return [];
      noteExert(live);
      const out_ = ['exerted'];
      if (em[1]) out_.push(...(await resolveEffects(em[1].trim(), live, { ...ctx, me: live.controller, forced: true })));
      return out_;
    }, 'Exert', { self: true });
  }
  if (kwNum(c, 'Hideaway')) f('enters', async (ctx) => {
    const k = kwNum(c, 'Hideaway');
    const ids = libTop(c.controller, k);
    if (!ids.length) return [];
    const [pick] = await ctx.choosers[c.controller].pickCards({ forced: true, prompt: `Hideaway ${k}: exile one face down`, cards: ids, min: 1, max: 1, purpose: 'hideaway', src: c, aiScore: (x) => DB[x.def].cmc });
    move(pick, 'exile');
    // you may look at it, the opponent can't; it's played only through the card's own condition ("play the exiled card…")
    Object.assign(card(pick), { hiddenBy: c.iid, hiddenExile: c.controller });
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
  // "instant, sorcery, or Villain spell" (Lady Loki)
  if (/, /.test(f)) return f.split(/,\s*(?:or\s+)?/).some((part) => spellMatches(part.trim(), d, c));
  if (/noncreature/.test(f)) return !/Creature/.test(t);
  if (/instant or sorcery|instant and sorcery/.test(f)) return /Instant|Sorcery/.test(t);
  if (/^creature/.test(f) || /^power \d+ or/.test(f)) {
    const mv = f.match(/mana value (\d+) or greater/);
    // Monstrous Vortex: "a creature spell with power 5 or greater"
    const pw = f.match(/power (\d+) or (greater|less)/);
    const pNow = () => { let v = null; try { if (c) v = power(c); } catch (e) { v = null; } if (v == null || isNaN(v)) v = +(d.faces[0].power || 0) || 0; return v; };
    return (/Creature/.test(t) || (/^power/.test(f) && d.faces[0].power != null)) && (!mv || d.cmc >= +mv[1]) && (!pw || (pw[2] === 'greater' ? pNow() >= +pw[1] : pNow() <= +pw[1]));
  }
  if (/^artifact/.test(f)) return /Artifact/.test(t);
  if (/^enchantment/.test(f)) return /Enchantment/.test(t);
  if (/^legendary/.test(f)) return /Legendary/.test(t);
  if (/^historic/.test(f)) return /Legendary|Artifact|Saga/.test(t);
  if (/^colorless/.test(f)) return !(d.colors || []).length && spellMatches(f.replace(/^colorless\s*/, ''), d, c); // Ugin's Mastery
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
  const out = seats().flatMap((k) => cardsIn(k, 'battlefield')).filter((c) => !c.faceDown);
  // Eminence: commanders' abilities that also work from the command zone
  for (const pid of seats()) for (const c of cardsIn(pid, 'command')) if (c.isCommander && /(?:^|\n)Eminence — /.test((DB[c.def].faces[0] || {}).oracle || '')) out.push(c);
  return out;
}

// graveyard cards with abilities that trigger from the graveyard (cached per card definition)
const gyTrigCache = new Map();
function gyTriggerCards() {
  const out = [];
  for (const pid of seats())
    for (const c of cardsIn(pid, 'graveyard')) {
      let k = gyTrigCache.get(c.def);
      if (k === undefined) {
        const txt = (DB[c.def].faces || []).map((f) => f.oracle || '').join('\n');
        const nm = String(DB[c.def].name || '').split(' // ')[0];
        const names = [nm, nm.split(',')[0]].filter(Boolean).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        k = new RegExp(`(?:^|\\n)(?:[^\\n]* — )?(?:When|Whenever|At)\\b[^\\n]*\\b(?:(?:return|put|exile) (?:this card|${names}) from your graveyard|is in your graveyard)`, 'i').test(txt);
        gyTrigCache.set(c.def, k);
      }
      if (k) out.push(c);
    }
  return out;
}

function matches(ev) {
  const out = [];
  const each = (fn) => {
    for (const c of onField()) for (const trig of triggersOf(c)) if (!trig.fromGy) fn(c, trig);
    for (const c of gyTriggerCards()) for (const trig of triggersOf({ ...c, controller: c.owner })) if (trig.fromGy) fn(c, trig);
    // emblems with triggered abilities (Garruk, Caller of Beasts: "Whenever you cast a creature spell, …")
    for (const pid of seats()) if ((G.s.players[pid].emblems || []).some((e) => /^(?:When|Whenever|At)\b/i.test(e))) for (const c of emblemObjects(pid)) for (const trig of triggersOf(c)) fn(c, trig);
  };
  const whoOk = (trigWho, c, pid) => !trigWho || (trigWho === 'you' ? pid === c.controller : trigWho === 'an opponent' ? pid !== c.controller : true);
  // predicate triggers ('p:<event>'): the parse supplies a test (c, ev) → false | true | hit fields | [hit fields…]
  const pushPred = (c, trig, extra = {}) => {
    let r;
    try { r = trig.pred(c, ev); } catch (e) { r = false; }
    if (!r) return;
    for (const x of [].concat(r)) out.push({ src: c, trig, ...extra, ...(x === true ? {} : x) });
  };
  each((c, trig) => { if (trig.event === 'p:' + ev.type && trig.pred && !trig.selfGone) pushPred(c, trig); });
  // the permanent itself just left the battlefield (Ordeal of Nylea: "When you sacrifice ~", Psychomancer)
  if (ev.iid && (ev.type === 'leaves' || ev.type === 'sacrificed' || ev.type === 'dies')) {
    const g = card(ev.iid);
    if (g && g.zone !== 'battlefield') for (const trig of triggersOf({ ...g, zone: 'battlefield', controller: ev.controller || g.controller }, ev.def)) if (trig.event === 'p:' + ev.type && trig.pred && trig.selfGone) pushPred({ ...g, controller: ev.controller || g.controller }, trig, { controller: ev.controller || g.controller });
  }
  // a card in exile (Dinosaurs on a Spaceship: "Whenever a time counter is removed from this card while it's exiled")
  if (ev.type === 'timeRemoved' && ev.exiled) {
    const g = card(ev.iid);
    if (g && g.zone === 'exile') for (const trig of triggersOf({ ...g, zone: 'battlefield', controller: g.owner })) if (trig.event === 'p:timeRemoved' && trig.pred && trig.inExile) pushPred({ ...g, controller: g.owner }, trig, { controller: g.owner });
  }
  switch (ev.type) {
    case 'enters': {
      const nc = card(ev.iid);
      if (!nc) break;
      // Theoretical Duplication: a token copy of each nontoken creature an opponent gets this turn
      if (!nc.token && isCreature(nc)) for (const e of (G.s.theoDup || []).filter((x) => x.turn === G.s.turn && x.pid !== nc.controller)) out.push({ src: card(e.src) || nc, controller: e.pid, trig: { event: 'enters', raw: 'Theoretical Duplication', fn: async () => { const [t] = createToken(nc.def, e.pid, 1); return t ? [`creates a token copy of ${nameTag(nc)}`] : []; } } });
      // the permanent's own "when ~ enters"
      if (!nc.faceDown) for (const trig of triggersOf(nc)) if (trig.event === 'enters' && trig.self && !(trig.untappedOnly && nc.tapped)) out.push({ src: nc, trig });
      const seenOnce = new Set();
      each((c, trig) => {
        if (trig.event !== 'enters' || trig.self) return;
        if (trig.enteredTapped && !nc.tapped) return; // Amulet of Vigor
        if (trig.other === true && c.iid === nc.iid && !trig.kw) return;
        if (c.iid === nc.iid && trig.kw) return;
        if (trig.mine && nc.controller !== c.controller) return;
        if (trig.theirs && nc.controller === c.controller) return;
        if (trig.commander && !nc.isCommander) return;
        if (trig.nontoken && nc.token) return;
        if (trig.dfcArt && !(DB[nc.def].doubleFaced && isType(nc, 'Artifact'))) return;
        if (!kindOk(nc, trig.kind)) return;
        if (trig.chosenType && !(c.chosenType && hasSubtype(nc, c.chosenType))) return;
        if (trig.notOwned && (nc.owner === c.controller || nc.token)) return;
        if (trig.duringCombat && !(G.s.combat && G.s.active === c.controller)) return;
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
      const ghost = { ...dead, zone: 'battlefield', counters: ev.counters || {}, controller: ev.controller, ...(ev.granted ? { extraText: ev.granted } : {}) };
      for (const trig of triggersOf(ghost, ev.def)) if (trig.event === 'dies' && trig.self && !(trig.minPower && !(ev.power >= trig.minPower))) out.push({ src: dead, trig, controller: ev.controller });
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
        if (trig.notOwnedDies && ev.owner === ev.controller) return;
        if (trig.attackingOnly && !ev.wasAttacking) return;
        if (trig.nontoken && ev.token) return;
        if (trig.mine && ev.controller !== c.controller) return;
        if (trig.theirs && ev.controller === c.controller) return;
        if (trig.kind && !matchesFilter({ ...ghost, zone: 'battlefield' }, trig.kind)) return;
        if (trig.withCounter) {
          const cs = ev.counters || {};
          if (trig.withCounter === 'any' ? !Object.values(cs).some((v) => v > 0) : !(cs[trig.withCounter] > 0)) return;
          if (ev.type === 'dies' && !(DB[ev.def] && /Creature/.test(DB[ev.def].typeLine || ''))) return;
        }
        out.push({ src: c, trig, it: { iid: ev.iid }, thatPlayer: ev.controller });
      });
      // equipment / auras: "whenever equipped creature dies"
      break;
    }
    case 'leaves': {
      const gone = card(ev.iid) || { iid: ev.iid, def: ev.def, face: ev.face, controller: ev.controller, owner: ev.owner, zone: ev.to, counters: {}, grants: [] };
      for (const trig of triggersOf({ ...gone, zone: 'battlefield', controller: ev.controller }, ev.def)) if (trig.event === 'leaves' && trig.self && (!trig.toZone || trig.toZone === ev.to) && !(trig.minPower && !(ev.power >= trig.minPower))) out.push({ src: gone, trig, controller: ev.controller });
      const goneDef = DB[ev.def];
      each((c, trig) => {
        if (trig.event !== 'leaves' || !(trig.mine || trig.anyController) || c.iid === ev.iid) return;
        if (trig.toZone && trig.toZone !== ev.to) return;
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
          // Intellect Devourer: a card exiled from a hand goes back to that hand
          if (x.exiledFromHand) {
            delete x.exiledFromHand;
            move(x.iid, 'hand');
            log(x.owner, `${nameTag(x)} returns to its owner's hand.`);
            continue;
          }
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
        if (trig.theirs && ev.owner === c.controller) return; // Lorcan, Kothophed: an opponent's card
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
      // G'raha Tia: "Whenever one or more other creatures and/or artifacts you control die"
      if (gone && ev.fromBattlefield)
        each((c, trig) => {
          if (trig.event !== 'dies' || !trig.noncreatureToo) return;
          if (trig.mine && ev.controller !== c.controller) return;
          if (trig.other && c.iid === ev.iid) return;
          if (trig.kind && !matchesFilter({ ...gone, zone: 'battlefield' }, trig.kind)) return;
          out.push({ src: c, trig, it: { iid: ev.iid }, thatPlayer: ev.controller });
        });
      break;
    }
    case 'combatDamagePlayer': {
      each((c, trig) => {
        if (trig.event !== 'anyCombatDamage') return;
        const dealer = card(ev.iid);
        if (!dealer || dealer.controller !== c.controller || (trig.yourTurn && G.s.active !== c.controller) || !(ev.amount > 0)) return;
        out.push({ src: c, trig, amount: ev.amount, it: { iid: ev.iid } });
      });
      // Surge to Victory: copy the exiled card and cast the copy
      { const h = card(ev.iid); for (const e of (G.s.surge || []).filter((x) => x.turn === G.s.turn && h && h.controller === x.pid && card(x.iid) && card(x.iid).zone === 'exile')) out.push({ src: card(e.src) || h, controller: e.pid, trig: { event: 'combatDamagePlayer', raw: 'Surge to Victory: copy the exiled card', text: 'Copy the exiled card. You may cast the copy without paying its mana cost.', optional: false }, it: { iid: e.iid } }); }
      // The Sea Devils III
      { const h = card(ev.iid); for (const e of (G.s.seaDevils || []).filter((x) => x.turn === G.s.turn && h && hasSubtype(h, x.type))) out.push({ src: h, controller: e.pid, trig: { event: 'combatDamagePlayer', raw: 'The Sea Devils: deal that much damage to a creature', text: `~ deals ${ev.amount} damage to target creature that player controls.`, optional: false }, thatPlayer: ev.player, amount: ev.amount }); }
      // Kang Dynasty: "Until your next turn, whenever any of those creatures deals combat damage to a player, draw a card."
      const hitter = card(ev.iid);
      for (const e of (hitter && hitter.dmgDraw) || []) {
        if (G.s.turn >= e.until) continue;
        const src = card(e.src) || hitter;
        out.push({ src, controller: e.pid, trig: { event: 'combatDamagePlayer', text: e.text || 'Draw a card.', raw: `dmgDraw:${e.src}`, optional: false }, amount: ev.amount });
      }
    }
      each((c, trig) => {
        if (trig.event !== 'combatDamagePlayer') return;
        const atk = card(ev.iid);
        if (trig.anyCreatureToOpp) {
          if (ev.player !== c.controller) out.push({ src: c, trig, thatPlayer: ev.player, amount: ev.amount, it: { iid: ev.iid } });
          return;
        }
        // Brood Sliver: "Whenever a Sliver deals combat damage to a player" (anyone's)
        if (trig.anyCreatureAny) {
          if (atk && (!trig.kind || matchesFilter(atk, trig.kind))) out.push({ src: c, trig, controller: atk.controller, thatPlayer: ev.player, amount: ev.amount, it: { iid: ev.iid } });
          return;
        }
        if (trig.self && c.iid === ev.iid) out.push({ src: c, trig, thatPlayer: ev.player, amount: ev.amount });
        else if (trig.anyOfMine && c.controller === ev.controller && !(trig.other && c.iid === ev.iid) && !(trig.commander && !(atk && atk.isCommander)) && (!trig.kind || (atk && matchesFilter(atk, trig.kind))) && (!trig.faceUpTurn || (atk && atk.turnedUpTurn === G.s.turn)) && (!trig.enchanted || (atk && Object.values(G.s.cards).some((a) => a.attachedTo === atk.iid && a.zone === 'battlefield' && /Aura/.test(typeLine(a))))) && (!trig.withCounter || (atk && Object.entries(atk.counters || {}).some(([k, v]) => v > 0 && (trig.withCounter === 'any' || k === trig.withCounter))))) out.push({ src: c, trig, thatPlayer: ev.player, it: { iid: ev.iid }, amount: ev.amount });
        else if (trig.attachedTo && c.attachedTo === ev.iid) out.push({ src: c, trig, thatPlayer: ev.player, it: { iid: ev.iid }, amount: ev.amount });
      });
      // ciphered spells cast a copy
      for (const x of Object.values(G.s.cards)) {
        if (x.zone === 'exile' && x.encodedOn === ev.iid && T.castFree) out.push({ src: x, trig: { event: 'cipher', fn: async () => { await T.castFree(x.owner, x.iid, { copy: true }); return ['casts a copy of the encoded spell']; }, raw: 'Cipher' }, controller: x.owner });
      }
      break;
    case 'combatDamageOnce':
      each((c, trig) => {
        if (trig.event !== 'goadedDamage' || ev.player === c.controller) return;
        const goaded = (ev.sources || []).filter((x) => isGoaded(card(x.iid)));
        if (goaded.length) out.push({ src: c, trig, thatPlayer: ev.player, them: goaded.map((x) => x.iid) });
      });
      each((c, trig) => {
        if (trig.event !== 'combatDamagedMe' || ev.player !== c.controller) return;
        if (trig.monarch && G.s.monarch !== c.controller) return;
        out.push({ src: c, trig, thatPlayer: ev.controller, them: (ev.sources || []).map((x) => x.iid) });
      });
      each((c, trig) => {
        if (trig.event !== 'combatDamageOnce' || c.controller !== ev.controller) return;
        const srcs = (ev.sources || []).filter((x) => !trig.kind || (card(x.iid) && matchesFilter(card(x.iid), trig.kind)))
          .filter((x) => !trig.withCounters || (card(x.iid) && Object.values(card(x.iid).counters || {}).some((v) => v > 0)))
          .filter((x) => !trig.minPower || (card(x.iid) && power(card(x.iid)) >= trig.minPower));
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
        } else if (trig.anyOfMine && c.controller === ev.controller && (trig.chosenType ? c.chosenType && hasSubtype(card(ev.iid), c.chosenType) : !trig.kind || matchesFilter(card(ev.iid), trig.kind)) && !(trig.other && c.iid === ev.iid) && !(trig.commander && !(card(ev.iid) || {}).isCommander)) out.push({ src: c, trig, thatPlayer: ev.defender, it: { iid: ev.iid } });
        else if (trig.attachedTo && c.attachedTo === ev.iid) out.push({ src: c, trig, thatPlayer: ev.defender, it: { iid: ev.iid } });
        else if (trig.attacksMeFlying) { const a = card(ev.iid); if (a && a.controller !== c.controller && ev.defender === c.controller && hasKw(a, 'flying')) out.push({ src: c, trig, it: { iid: ev.iid }, thatPlayer: a.controller }); }
        else if (trig.theirAttacker && c.controller !== ev.controller) out.push({ src: c, trig, it: { iid: ev.iid } });
        else if (trig.goadedAttacker) {
          const a = card(ev.iid);
          if (isGoaded(a)) out.push({ src: c, trig, thatPlayer: a.controller, it: { iid: ev.iid } });
        }
      });
      break;
    case 'attacksAlone':
      each((c, trig) => {
        if (trig.event !== 'attacksAlone') return;
        if (trig.self && c.iid === ev.iid) out.push({ src: c, trig, thatPlayer: ev.defender });
        else if (trig.attachedTo && c.attachedTo === ev.iid) out.push({ src: c, trig, thatPlayer: ev.defender, it: { iid: ev.iid } });
        else if (trig.anyOfMine && c.controller === ev.controller) out.push({ src: c, trig, thatPlayer: ev.defender, it: { iid: ev.iid } });
      });
      break;
    case 'youAttack':
      each((c, trig) => {
        if (trig.event !== 'youAttack') return;
        if (trig.anyAttacker) { out.push({ src: c, trig, thatPlayer: ev.controller }); return; }
        if (trig.oppAttacksMe) {
          if (ev.controller === c.controller) return;
          const cb = G.s.combat || {};
          const k = (cb.attackers || []).filter((a) => ((cb.targets || {})[a] || ev.defender) === c.controller).length;
          if (k >= trig.oppAttacksMe) out.push({ src: c, trig, thatPlayer: ev.controller });
          return;
        }
        // Squall: per opponent attacked, if an attacker there has power or toughness equal to the chosen number
        if (trig.chosenNumberAtk) {
          if (c.controller !== ev.controller || c.chosenNumber === undefined) return;
          const cb = G.s.combat || {};
          const defs = new Set();
          for (const aid of cb.attackers || []) {
            const a = card(aid);
            const d = (cb.targets || {})[aid] || ev.defender;
            if (a && a.controller === c.controller && opponents(c.controller).includes(d) && (power(a) === c.chosenNumber || toughness(a) === c.chosenNumber)) defs.add(d);
          }
          for (const d of defs) out.push({ src: c, trig, thatPlayer: d });
          return;
        }
        // Fangorn: "Whenever one or more Treefolk you control attack" — that much = how many
        if (trig.kindCount) {
          if (c.controller !== ev.controller) return;
          const one = trig.kindCount.replace(/ves$/, 'f').replace(/ies$/, 'y').replace(/(?<!s)s$/, ''); // "Dragons" → Dragon, "Elves" → Elf (Fangorn's Treefolk stays)
          const k = ((G.s.combat && G.s.combat.attackers) || []).map(card).filter((x) => x && (hasSubtype(x, trig.kindCount) || hasSubtype(x, one))).length;
          if (k) out.push({ src: c, trig, amount: k, thatPlayer: ev.defender });
          return;
        }
        // Glimmer Lens: equipped creature and at least one other creature attack
        if (trig.equippedPlus) {
          const ids = (G.s.combat && G.s.combat.attackers) || [];
          if (c.controller === ev.controller && c.attachedTo && ids.includes(c.attachedTo) && ids.length > trig.equippedPlus) out.push({ src: c, trig });
          return;
        }
        // MacCready: a creature with power 4 or greater attacks you (each one)
        if (trig.minPowerAtk) {
          if (c.controller !== ev.defender || c.controller === ev.controller) return;
          for (const a of ((G.s.combat && G.s.combat.attackers) || []).map(card).filter((x) => x && power(x) >= trig.minPowerAtk && (((G.s.combat.targets || {})[x.iid] || ev.defender) === c.controller)))
            out.push({ src: c, trig, thatPlayer: a.controller, it: { iid: a.iid } });
          return;
        }
        if (trig.defend) {
          if (c.controller !== ev.defender || c.controller === ev.controller) return;
          if (trig.minCount && ((G.s.combat && G.s.combat.attackers) || []).filter((a) => ((G.s.combat.targets || {})[a] || ev.defender) === c.controller || (card((G.s.combat.targets || {})[a]) || {}).controller === c.controller).length < trig.minCount) return;
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
        if (trig.minCount && atk.length < trig.minCount) return; // "attack with two or more Spiders"
        if (trig.exactCount && atk.length !== trig.exactCount) return;
        if (trig.totalPower && atk.reduce((n, x) => n + Math.max(0, power(x)), 0) < trig.totalPower) return; // "creatures with total power 6 or greater"
        out.push({ src: c, trig, thatPlayer: ev.defender, amount: atk.length, them: atk.map((a) => a.iid) });
      });
      break;
    case 'blocks':
    case 'clashWon':
      each((c, trig) => trig.event === 'clashWon' && c.controller === ev.pid && out.push({ src: c, trig }));
      break;
    case 'bend':
      each((c, trig) => trig.event === 'bend' && c.controller === ev.pid && out.push({ src: c, trig }));
      break;
    case 'exerted':
      each((c, trig) => trig.event === 'exerted' && c.controller === ev.controller && out.push({ src: c, trig, it: { iid: ev.iid } }));
      break;
    case 'abilityTargets':
      each((c, trig) => trig.event === 'abilityTargets' && c.controller === ev.controller && out.push({ src: c, trig }));
      break;
    case 'blocked':
    case 'unblocked':
      each((c, trig) => {
        if (trig.event !== ev.type) return;
        if (trig.attackingMyOpp) {
          const a = card(ev.iid);
          if (a && ev.defender && ev.defender !== c.controller && opponents(c.controller).includes(ev.defender) && (ev.blockers || []).length >= (trig.minBlockers || 1)) out.push({ src: c, trig, thatPlayer: ev.defender, it: { iid: ev.iid } });
          return;
        }
        if (trig.self && c.iid === ev.iid) out.push({ src: c, trig, thatPlayer: ev.defender, amount: (ev.blockers || []).length });
        else if (trig.anyOfMine && card(ev.iid) && card(ev.iid).controller === c.controller && (!trig.kind || matchesFilter(card(ev.iid), trig.kind))) out.push({ src: c, trig, thatPlayer: ev.defender, it: { iid: ev.iid }, amount: (ev.blockers || []).length });
      });
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
      // Quilled Greatwurm: any combat damage a creature you control deals during your turn
      if (ev.type === 'combatDamageCreature' || ev.type === 'combatDamagePlayer') each((c, trig) => {
        if (trig.event !== 'anyCombatDamage') return;
        const dealer = card(ev.iid);
        if (!dealer || dealer.controller !== c.controller || (trig.yourTurn && G.s.active !== c.controller) || !(ev.amount > 0)) return;
        out.push({ src: c, trig, amount: ev.amount, it: { iid: ev.iid } });
      });
      each((c, trig) => {
        if (trig.event !== ev.type) return;
        if (trig.noncombat && ev.combat) return;
        // Thor, Guardian of Midgard: any source you control dealing noncombat damage to an opponent
        if (trig.anySourceMine && trig.toSelf) {
          const s0 = card(ev.iid);
          if (s0 && s0.controller === c.controller && ev.player === c.controller && ev.type === 'dealsDamage') out.push({ src: c, trig, amount: ev.amount, thatPlayer: c.controller });
          return;
        }
        if (trig.anySourceMine) {
          const s0 = card(ev.iid);
          if (s0 && s0.controller === c.controller && ev.player && ev.player !== c.controller) out.push({ src: c, trig, amount: ev.amount, thatPlayer: ev.player });
          return;
        }
        // She-Hulk: a creature you control is dealt damage
        if (trig.anyMineDealt) {
          const t0 = card(ev.iid);
          if (ev.type === 'dealtDamage' && t0 && t0.controller === c.controller && isCreature(t0)) out.push({ src: c, trig, amount: ev.amount, it: { iid: ev.iid } });
          return;
        }
        if (trig.oppOnly && ev.player === c.controller) return;
        if (trig.minAmount && (ev.amount || 0) < trig.minAmount) return;
        if (trig.self && c.iid === ev.iid) out.push({ src: c, trig, amount: ev.amount, thatPlayer: ev.player, it: ev.other ? { iid: ev.other } : null });
        else if (trig.attachedTo && c.attachedTo === ev.iid) out.push({ src: c, trig, amount: ev.amount, thatPlayer: ev.player, it: { iid: ev.iid } });
      });
      break;
    case 'exiledBatch':
      each((c, trig) => {
        if (trig.event !== 'exiledBatch') return;
        const items = (ev.items || []).filter((x) => (!trig.other || x.iid !== c.iid) && (!trig.fromZones || trig.fromZones.includes(x.from)) && (!trig.mineOnly || x.owner === c.controller));
        if (items.length) out.push({ src: c, trig, amount: items.length, them: items.map((x) => x.iid) });
      });
      break;
    case 'becomesTarget':
      each((c, trig) => {
        if (trig.event !== 'becomesTarget') return;
        if (trig.sub) {
          const t = card(ev.iid);
          if (!t || t.controller !== c.controller || ev.controller === c.controller) return;
          if (trig.sub === 'Creature' ? !isCreature(t) : !hasSubtype(t, trig.sub)) return;
          if (trig.withCounter && !((t.counters || {})[trig.withCounter] > 0)) return;
          out.push({ src: c, trig, thatPlayer: ev.controller, it: { iid: ev.iid } });
          return;
        }
        if (!trig.self || c.iid !== ev.iid) return;
        if (trig.spellOnly && !ev.bySpell) return;
        if (trig.oppOnly && ev.controller === c.controller) return;
        if (trig.mineOnly && ev.controller !== c.controller) return;
        out.push({ src: c, trig, thatPlayer: ev.controller });
      });
      break;
    case 'copySpell':
      each((c, trig) => trig.event === 'copySpell' && c.controller === ev.controller && out.push({ src: c, trig }));
      break;
    case 'unlock':
      each((c, trig) => {
        if (trig.event !== 'unlock') return;
        if (trig.self && c.iid === ev.iid && trig.door === ev.door) out.push({ src: c, trig });
        else if (trig.anyRoom && c.controller === ev.controller) {
          const r = card(ev.iid);
          if (trig.fully && !(r && r.unlocked && r.unlocked.every(Boolean))) return;
          out.push({ src: c, trig, it: { iid: ev.iid } });
        }
      });
      break;
    case 'landfall':
      each((c, trig) => trig.event === 'landfall' && trig.theirs && c.controller !== ev.controller && G.s.lastLandPlay && G.s.lastLandPlay.iid === ev.iid && out.push({ src: c, trig, it: { iid: ev.iid }, thatPlayer: ev.controller }));
      each((c, trig) => trig.event === 'landfall' && !trig.theirs && c.controller === ev.controller
        && (!trig.playedFrom || (G.s.lastLandPlay && G.s.lastLandPlay.iid === ev.iid && (trig.playedFrom === 'notHand' ? G.s.lastLandPlay.from !== 'hand' : G.s.lastLandPlay.from === trig.playedFrom)))
        && (!trig.enteredFrom || (trig.enteredFrom === 'notHand' ? ev.from !== 'hand' : ev.from === trig.enteredFrom))
        && out.push({ src: c, trig, it: { iid: ev.iid } }));
      break;
    case 'cast': {
      // a copy of a prepared creature's spell: it's that half that was cast
      const d = ev.copyFace ? { ...DB[ev.def], ...DB[ev.def].faces[ev.copyFace], colors: DB[ev.def].colors, cmc: ((DB[ev.def].faces[ev.copyFace].manaCost || '').match(/\{(\d+)\}/g) || []).reduce((a, x) => a + +x.slice(1, -1), 0) + ((DB[ev.def].faces[ev.copyFace].manaCost || '').match(/\{[WUBRGC](?:\/[WUBRGP])?\}/g) || []).length } : DB[ev.def];
      const sc = card(ev.iid);
      const ts = G.s.ts[ev.controller];
      each((c, trig) => {
        if (trig.event !== 'cast') return;
        if (trig.mine && c.controller !== ev.controller) return;
        if (trig.whileAttacking && !c.attacking) return; // Fire Lord Azula
        if (trig.enchantedPlayer && (c.enchantedPlayer || opp(c.controller)) !== ev.controller) return; // Maddening Hex
        if (trig.theirs && c.controller === ev.controller) return;
        if (/casts? (?:a|an) [^,]*spell from (?:their|your) hand/i.test(trig.raw || '') && card(ev.iid) && card(ev.iid).castFrom !== 'hand') return; // Swindler's Scheme: from their hand only
        if (trig.notSelf && c.iid === ev.iid) return;
        // "your first instant or sorcery spell each turn": the first of that kind, not the first spell overall
        const nthOfKind = () => (ts.castIids || [ev.iid]).filter((i) => card(i) && spellMatches(trig.spell, DB[card(i).def], card(i))).length;
        if (trig.first && (trig.spell ? nthOfKind() !== 1 : ts.spells !== 1)) return;
        if (trig.firstNotHand && (ts.spellsNotHand || 0) !== 1) return;
        if (trig.second && (trig.spell ? nthOfKind() !== 2 : ts.spells !== 2)) return;
        if (trig.nth && ts.spells !== trig.nth) return; // Captain Ripley Vance: your third spell
        if (trig.nthNoncreature && nthOfKind() !== trig.nthNoncreature) return; // The Fantasticar
        if (trig.hasX && !/\{X\}/.test((d.faces[(sc && sc.castFace) || 0] || d.faces[0]).manaCost || d.manaCost || '')) return; // Unbound Flourishing
        if (!spellMatches(trig.spell, d, sc)) return;
        // "a spell with mana value 4 or greater / 2 or less"
        if (trig.mvMin !== undefined && (d.cmc || 0) < trig.mvMin) return;
        if (trig.mvMax !== undefined && (d.cmc || 0) > trig.mvMax) return;
        if (trig.notOwned && (!sc || sc.owner === ev.controller)) return;
        if (trig.sharesType) {
          const mine_ = (typeLine(c).split('—')[1] || '').trim().split(/\s+/).filter(Boolean);
          if (!sc || !mine_.some((t) => hasSubtype(sc, t))) return;
        }
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
      if (sc) for (const trig of triggersOf(sc)) if (trig.event === 'castSelf' && !(trig.notFromExile && sc.castFrom === 'exile')) out.push({ src: sc, trig, controller: ev.controller });
      break;
    }
    case 'draw':
      each((c, trig) => trig.event === 'draw' && whoOk(trig.who, c, ev.pid) && !(trig.notFirstInDrawStep && G.s.step === 'draw' && G.s.active === ev.pid && ev.nth === 1) && (!trig.second || ev.nth === 2) && (!trig.nthDraw || ev.nth === trig.nthDraw) && out.push({ src: c, trig, thatPlayer: ev.pid }));
      break;
    case 'discard':
      each((c, trig) => trig.event === 'discard' && whoOk(trig.who, c, ev.pid) && (!trig.kind || (card(ev.iid) && matchesFilter({ ...card(ev.iid), zone: 'battlefield' }, trig.kind.replace(/^non(\w)/, 'non$1')))) && out.push({ src: c, trig, thatPlayer: ev.pid, it: { iid: ev.iid } }));
      break;
    case 'cycle': {
      const sc = card(ev.iid);
      if (sc) for (const trig of triggersOf(sc)) if (trig.event === 'cycle' && trig.self) out.push({ src: sc, trig, controller: ev.pid, x: ev.x });
      each((c, trig) => trig.event === 'cycle' && !trig.self && (trig.anyPlayer || (trig.oppOnly ? c.controller !== ev.pid : c.controller === ev.pid)) && out.push({ src: c, trig, thatPlayer: ev.pid }));
      break;
    }
    case 'mill': {
      each((c, trig) => {
        if (trig.event !== 'mill' || (!trig.anyPlayer && c.controller !== ev.pid)) return;
        const ids = (ev.ids || []).filter((i) => card(i) && card(i).zone === 'graveyard' && (!trig.kind || (trig.kind === 'land' ? isLand(card(i)) : trig.kind === 'nonland' ? !isLand(card(i)) : trig.kind === 'creature' ? /Creature/.test(DB[card(i).def].typeLine || '') : /Artifact|Creature|Enchantment|Land|Planeswalker|Battle/.test(DB[card(i).def].typeLine || ''))));
        if (ids.length) out.push({ src: c, trig, them: ids, amount: ids.length });
      });
      break;
    }
    case 'energyGained':
      each((c, trig) => trig.event === 'energyGained' && c.controller === ev.pid && ev.amount >= (trig.min || 1) && (!trig.yourTurn || ev.yourTurn) && out.push({ src: c, trig, amount: ev.amount }));
      break;
    case 'lifeGained':
    case 'lifeLost':
      each((c, trig) => trig.event === ev.type && whoOk(trig.who, c, ev.pid) && !(trig.byDamage && !ev.byDamage) && out.push({ src: c, trig, thatPlayer: ev.pid, amount: ev.amount }));
      break;
    case 'loyaltyActivated':
      each((c, trig) => {
        if (trig.event !== 'loyaltyActivated' || c.controller !== ev.controller) return;
        // Way of the Mind Sculptor: "if you removed two or more loyalty counters to activate it, …"
        const im = (trig.text || '').match(/^if you removed (\w+) or more loyalty counters to activate it, (.+)$/i);
        if (im) {
          const need = { one: 1, two: 2, three: 3, four: 4, five: 5 }[im[1].toLowerCase()] || +im[1] || 1;
          if (-(ev.cost || 0) < need) return;
          out.push({ src: c, trig: { ...trig, text: im[2] }, it: { iid: ev.iid } });
        } else out.push({ src: c, trig, it: { iid: ev.iid } });
      });
      break;
    case 'counterPut': {
      const tgt = card(ev.iid);
      if (!tgt) break;
      each((c, trig) => {
        if (trig.event !== 'counterPut') return;
        // Captain Marvel: "Whenever you put one or more counters on another creature"
        // Aragorn, Company Leader: "Whenever you put one or more counters on ~" (any kind)
        if (trig.anyKindSelf) {
          if (c.iid === ev.iid && (ev.by || tgt.controller) === c.controller) out.push({ src: c, trig, amount: ev.n, counterKind: ev.kind });
          return;
        }
        if (trig.anyKind) {
          if (!isCreature(tgt) || (trig.other && tgt.iid === c.iid) || (ev.by || tgt.controller) !== c.controller || ev.kind === 'loyalty') return;
          if (trig.kindF && !(tgt.controller === c.controller && kindOk(tgt, trig.kindF))) return;
          if (trig.counterKindOnly && trig.counterKindOnly !== ev.kind) return;
          out.push({ src: c, trig, it: { iid: ev.iid }, thatPlayer: tgt.controller, amount: ev.n, counterKind: ev.kind });
          return;
        }
        if (ev.kind !== '+1/+1' && ev.kind !== 'loyalty' && ev.kind !== '-1/-1' && !(trig.nth && trig.kind === ev.kind)) return;
        if ((trig.kind || '+1/+1') !== ev.kind) return;
        if (trig.nth) {
          const now = (tgt.counters || {})[ev.kind] || 0;
          if (c.iid !== ev.iid || !(now >= trig.nth && now - ev.n < trig.nth)) return;
          out.push({ src: c, trig });
          return;
        }
        if (trig.anyCreature) {
          if (!isCreature(tgt)) return;
          if (trig.mine && tgt.controller !== c.controller) return;
          if (trig.theirs && tgt.controller === c.controller) return;
          if (trig.byMe && (ev.by ? ev.by !== c.controller : tgt.controller === c.controller)) return;
          const times = trig.perCounter ? ev.n : 1;
          for (let k = 0; k < times; k++) out.push({ src: c, trig, it: { iid: ev.iid }, thatPlayer: tgt.controller, amount: ev.n });
          return;
        }
        if (ev.kind === 'loyalty' && (c.controller !== tgt.controller || !isType(tgt, 'Planeswalker'))) return;
        if (ev.kind === 'loyalty') return void out.push({ src: c, trig, it: { iid: ev.iid }, amount: ev.n });
        if (trig.self && c.iid === ev.iid) {
          if (!(trig.byMe && ev.by && ev.by !== c.controller)) out.push({ src: c, trig });
        } else if (trig.anyOfMine && c.controller === tgt.controller && isCreature(tgt)) out.push({ src: c, trig, it: { iid: ev.iid }, amount: ev.n });
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
      // Elvish Mariner: "where X is the number of cards looked at while scrying this way"
      each((c, trig) => trig.event === ev.type && c.controller === ev.pid && out.push({ src: c, trig, ...(ev.n !== undefined ? { x: ev.n, amount: ev.n } : {}) }));
      break;
    case 'votingDone':
      each((c, trig) => trig.event === 'votingDone' && out.push({ src: c, trig }));
      break;
    // Custodi Lich: "Whenever you become the monarch"
    case 'becameMonarch':
      each((c, trig) => trig.event === 'becameMonarch' && (trig.theirs ? c.controller !== ev.pid : c.controller === ev.pid) && out.push({ src: c, trig, thatPlayer: ev.pid }));
      break;
    // Dark Depths, Darksteel Reactor: a state trigger noticed by settle()
    case 'stateCounters': {
      const sc = card(ev.iid);
      if (sc && sc.zone === 'battlefield') for (const trig of triggersOf(sc)) if (trig.event === 'stateCounters' && trig.raw === ev.raw) out.push({ src: sc, trig });
      break;
    }
    case 'leftGraveyard':
      each((c, trig) => trig.event === 'leftGraveyard' && c.controller === ev.owner && (!trig.kind || (ev.defs || [ev.def]).some((df) => df && DB[df] && (trig.kind === 'nonland' ? !/\bLand\b/.test(DB[df].typeLine || '') : trig.kind === 'permanent' ? /Artifact|Creature|Enchantment|Land|Planeswalker|Battle/.test(DB[df].typeLine || '') : new RegExp(trig.kind.split(' ')[0], 'i').test(DB[df].typeLine || '')))) && out.push({ src: c, trig, amount: ev.n }));
      break;
    case 'explored':
    case 'connived':
    case 'tapped':
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
  // Firebender Ascension: an attacking creature's own triggered ability triggering puts a quest counter on it; at four, copy that ability
  if (ev.type === 'attacks') {
    const own = out.filter((h) => h.src && h.src.iid === ev.iid && h.trig && !h.trig.ascensionCopy && !h.trig.ascension);
    const atk = card(ev.iid);
    const asc = atk ? cardsIn(atk.controller, 'battlefield').filter((x) => /attacking causes a triggered ability of that creature to trigger/i.test(oracle(x))) : [];
    for (const a of asc) for (const h of own) out.push({ src: a, thatPlayer: h.thatPlayer, trig: { event: 'attacks', ascension: true, raw: 'Whenever a creature you control attacking causes a triggered ability of that creature to trigger, put a quest counter on ~.', fn: async () => {
      const live = card(a.iid);
      if (!live || live.zone !== 'battlefield') return [];
      addCounters(live, 'quest', 1);
      const k = (live.counters || {}).quest || 0;
      const out_ = [`quest counter (${k})`];
      if (k >= 4 && card(h.src.iid)) {
        const yes = isAI(live.controller) ? true : await T.confirm(cardName(live), `Copy ${cardName(h.src)}'s triggered ability?`);
        if (yes) {
          await resolveTrigger({ ...h, trig: { ...h.trig, ascensionCopy: true } }, live.controller, ev);
          out_.push(`copies ${nameTag(h.src)}'s ability`);
        }
      }
      return out_;
    } } });
  }
  // The Ring's abilities on your Ring-bearer (level 2: loot on attack, 3: blockers are sacrificed, 4: opponents lose 3)
  {
    const rb = (ev.type === 'attacks' || ev.type === 'blocked' || ev.type === 'combatDamagePlayer') && card(ev.iid);
    const lvl = rb ? ringLevel(rb) : 0;
    if (ev.type === 'attacks' && lvl >= 2) out.push({ src: rb, trig: { event: 'attacks', text: 'Draw a card, then discard a card.', raw: 'The Ring (Ring-bearer attacks)' }, thatPlayer: ev.defender });
    if (ev.type === 'blocked' && lvl >= 3 && (ev.blockers || []).length)
      out.push({ src: rb, trig: { event: 'blocked', raw: 'The Ring (Ring-bearer blocked)', fn: async () => {
        const bs = (ev.blockers || []).map(card).filter((b) => b && b.zone === 'battlefield');
        for (const b of bs) b.endOfCombat = 'sacrifice';
        return bs.length ? [`${bs.map(nameTag).join(', ')} will be sacrificed at end of combat (the Ring)`] : [];
      } } });
    if (ev.type === 'combatDamagePlayer' && lvl >= 4 && ev.player !== rb.controller) out.push({ src: rb, trig: { event: 'combatDamagePlayer', text: 'Each opponent loses 3 life.', raw: 'The Ring (Ring-bearer deals combat damage)' }, thatPlayer: ev.player });
  }
  return out;
}

// ------------------------------------------------------------ special events
async function specialEvent(ev) {
  const ch = T.choosers;
  // draws replaced by Chains of Mephistopheles / Underrealm Lich
  if (ev.type === 'replacedDraw') {
    const pid = ev.pid;
    const src = card(ev.by);
    const c_ = ch[pid] || ch.ai;
    if (ev.kind === 'chains') {
      const hand = cardsIn(pid, 'hand');
      if (hand.length) {
        const [d] = await c_.pickCards({ forced: true, prompt: `${src ? cardName(src) : 'Chains of Mephistopheles'}: discard a card instead of drawing (then draw a card)`, cards: hand.map((x) => x.iid), min: 1, max: 1, purpose: 'discard', src, aiScore: (x) => (isLand(x) ? 5 : -(DB[x.def].cmc || 0)) });
        if (d) {
          log(pid, `${src ? nameTag(src) : 'Chains'}: ${pid === 'p' ? 'you discard' : 'the AI discards'} ${nameTag(card(d))} instead of drawing, then draw${pid === 'p' ? '' : 's'} a card.`);
          discardCard(d);
          drawCards(pid, 1, true, { noRepl: true });
        }
      } else {
        const ids = libTop(pid, 1);
        ids.forEach((i) => move(i, 'graveyard'));
        log(pid, `${src ? nameTag(src) : 'Chains'}: ${pid === 'p' ? 'you have' : 'the AI has'} no card to discard, so ${pid === 'p' ? 'you mill' : 'it mills'} ${ids.map((i) => nameTag(card(i))).join(', ') || 'nothing'} instead of drawing.`);
      }
    } else if (ev.kind === 'lich') {
      const ids = libTop(pid, 3);
      if (ids.length) {
        const [keep] = await c_.pickCards({ forced: true, prompt: `${src ? cardName(src) : 'Underrealm Lich'}: put one into your hand (the rest go to your graveyard)`, cards: ids, min: 1, max: 1, purpose: 'keep', src, aiScore: (x) => (isLand(x) ? 2 : DB[x.def].cmc || 0) });
        const k = keep || ids[0];
        move(k, 'hand');
        ids.filter((i) => i !== k).forEach((i) => move(i, 'graveyard'));
        log(pid, `${src ? nameTag(src) : 'Underrealm Lich'}: ${pid === 'p' ? 'you keep' : 'the AI keeps'} ${pid === 'p' ? nameTag(card(k)) : 'a card'} and put${pid === 'p' ? '' : 's'} ${ids.length - 1} into the graveyard instead of drawing.`);
      }
    }
    return true;
  }
  // Love on the Battlefield: those creatures get a +1/+1 counter when they deal combat damage to a player this combat
  if (ev.type === 'combatDamagePlayer' && card(ev.iid) && card(ev.iid).loveTurn === G.s.turn) {
    addCounters(card(ev.iid), '+1/+1', 1);
    log(card(ev.iid).controller, `${nameTag(card(ev.iid))} gets a +1/+1 counter (Love on the Battlefield).`);
  }
  // Jocasta: "Whenever you attack with your commander, if this card is in your graveyard, you may return it to the battlefield tapped and attacking."
  if (ev.type === 'attacks' && card(ev.iid) && card(ev.iid).isCommander && G.s.combat) {
    for (const x of cardsIn(ev.controller, 'graveyard')) {
      if (!/Whenever you attack with your commander, if (?:this card|~|[^,]+) is in your graveyard, you may return it to the battlefield tapped and attacking/i.test(oracle({ ...x, zone: 'battlefield' }))) continue;
      if (G.s.combat.jocasta === G.s.turn + ':' + x.iid) continue;
      G.s.combat.jocasta = G.s.turn + ':' + x.iid;
      const yes = isAI(ev.controller) ? true : await T.confirm(cardName(x), `Return ${cardName(x)} from your graveyard to the battlefield tapped and attacking?`);
      if (!yes) continue;
      toBattlefield(x.iid, ev.controller);
      const y = card(x.iid);
      if (!y) continue;
      tapPerm(y);
      y.attacking = true;
      G.s.combat.attackers.push(y.iid);
      if (G.s.combat.targets) G.s.combat.targets[y.iid] = G.s.combat.targets[ev.iid] || ev.defender;
      log(ev.controller, `${nameTag(y)} returns from the graveyard tapped and attacking.`);
    }
  }
  // Heroic Sacrifice: when the chosen creature dies this turn, move its counters and draw a card
  if (ev.type === 'dies' && G.s.redirect && G.s.redirect.onDie && G.s.redirect.iid === ev.iid && G.s.redirect.turn === G.s.turn) {
    const pid = G.s.redirect.pid;
    G.s.redirect = null;
    const cs = Object.entries(ev.counters || {}).filter(([, k]) => k > 0);
    const pool = cardsIn(pid, 'battlefield').filter(isCreature);
    if (cs.length && pool.length) {
      const [to] = await ch[pid].pickCards({ prompt: 'Put its counters on up to one target creature you control', cards: pool.map((c) => c.iid), min: 0, max: 1, purpose: 'counters', aiScore: (c) => cardValue(c) });
      if (to && card(to)) {
        for (const [k, n] of cs) addCounters(card(to), k, n);
        log(pid, `${nameTag(card(to))} gets ${cs.map(([k, n]) => `${n} ${k}`).join(', ')} counter(s).`);
      }
    }
    await resolveEffects('Draw a card.', { def: ev.def, face: ev.face, controller: pid, zone: 'graveyard' }, { me: pid, choosers: ch, forced: true });
  }
  // Jace, Reality Sculptor / Architect of Thought: attackers get −N/−0 until end of turn
  if (ev.type === 'attacks' && G.s.attackShrink && G.s.attackShrink.length) {
    const a = card(ev.iid);
    for (const sh of G.s.attackShrink) {
      if (!a || sh.until <= G.s.turn || sh.owner === ev.controller) continue;
      const tgt = ev.target || ev.defender;
      if (sh.onlyAtMe && !(tgt === sh.owner || (card(tgt) && card(tgt).controller === sh.owner))) continue;
      a.eot = { p: (a.eot ? a.eot.p : 0) - sh.n, t: a.eot ? a.eot.t : 0 };
      log(sh.owner, `${nameTag(a)} gets −${sh.n}/−0 as it attacks.`);
    }
  }
  if (ev.type === 'payToUntap') {
    const c = card(ev.iid);
    if (!c || c.zone !== 'battlefield' || !c.tapped) return true;
    const pl = G.s.players[ev.controller];
    let pay;
    if (isAI(ev.controller)) {
      // pay when it's the AI's own turn and it can afford the life (it wants to use the mana now)
      pay = isAI(G.s.active) && pl.life > 10 + ev.life && G.s.turn > 2;
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
    const yes = cost && T.castFree ? await (isAI(ev.pid) ? Promise.resolve(true) : T.confirm(cardName(c), `Madness: cast ${cardName(c)} for ${cost}?`)) : false;
    if (yes && (await T.castFree(ev.pid, ev.iid, { cost, mode: 'madness' }))) return true;
    if (card(ev.iid) && card(ev.iid).zone === 'exile') move(ev.iid, 'graveyard');
    return true;
  }
  if (ev.type === 'draw' && ev.nth === 1 && card(ev.iid) && T.castFree) {
    const c = card(ev.iid);
    let mc = (oracle(c).match(/Miracle ((?:\{[^}]+\})+)/) || [])[1];
    // Molecule Man: "Nonland cards in your hand have miracle {0}."
    if (!mc && !isLand(c)) {
      const giver = cardsIn(ev.pid, 'battlefield').find((x) => !x.phasedOut && /Nonland cards in your hand have miracle ((?:\{[^}]+\})+)/i.test(oracle(x)));
      if (giver) mc = oracle(giver).match(/Nonland cards in your hand have miracle ((?:\{[^}]+\})+)/i)[1];
    }
    if (mc && c.zone === 'hand') {
      const yes = isAI(ev.pid) ? true : await T.confirm(cardName(c), `Miracle: cast ${cardName(c)} for ${mc}?`);
      if (yes) await T.castFree(ev.pid, ev.iid, { cost: mc, mode: 'miracle' });
    }
  }
  if (ev.type === 'mainPhase') {
    // sagas get a lore counter; rad counters mill
    for (const c of cardsIn(ev.active, 'battlefield')) if (hasSubtype(c, 'Saga') || (c.counters && c.counters.lore !== undefined && /^[IVX]+(?:, [IVX]+)* — /m.test(face(c).oracle || ''))) loreUp(c);
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
    if (c && c.counters && c.counters.lore === 0 && /^[IVX]+(?:, [IVX]+)* — /m.test(face(c).oracle || '')) {
      // read ahead: choose a starting chapter
      let start = 1;
      if (/Read ahead/i.test(oracle(c))) {
        const max = Math.max(...[...face(c).oracle.matchAll(/^([IVX]+)(?:, ([IVX]+))* — /gm)].flatMap((m) => m[0].replace(' — ', '').split(', ').map((r) => ROMAN[r] || 0)));
        start = 1 + (await ch[c.controller].choose({ prompt: `Read ahead: start ${cardName(c)} on which chapter?`, options: Array.from({ length: max }, (_, k) => ({ label: `Chapter ${k + 1}` })), aiPick: () => readAheadPick(c) }));
        c.counters.lore = start - 1;
      }
      loreUp(c);
    }
  }
  return false;
}
const who = (pid) => (seatName(pid));

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
    let processed = 0; // runaway loops (Scute Swarm copying itself on every landfall…) stop after 400 events, as before
    stateTriggerCheck();
    while (eventQueue.length && guard++ < 400 && processed < 400) {
      // everything that happened at once triggers together: collect the whole batch, then put it on the stack
      // (active player's first, so the other player's resolve first), letting you order your own
      const batch = eventQueue.splice(0, Math.min(eventQueue.length, 400 - processed));
      processed += batch.length;
      const pending = [];
      const after = [];
      for (const ev of batch) {
      if (!ev) continue;
      if (G.s !== s0) break;
      if (await specialEvent(ev)) continue;
      // a copy of an Aura that entered without being cast (token copies, clones, Copy Enchantment): it goes on something
      if (ev.type === 'enters') { const ac = card(ev.iid); if (ac && ac.zone === 'battlefield' && !ac.attachedTo && !ac.enchantedPlayer && hasSubtype(ac, 'Aura') && !isCreature(ac)) { try { const { attachLooseAuras } = await import('./effects.js'); const d = await attachLooseAuras([ac.iid], ac.controller, T.choosers); if (d.length) log(ac.controller, d.join('; ') + '.'); } catch (e) { if (!(e instanceof Cancelled)) console.error(e); } } }
      let hits = withReadCache(() => matches(ev)); // finding who triggers only reads the board
      // Windcrag Siege (Mardu), Isshin: attack triggers trigger an additional time
      if (ev.type === 'attacks' && hits.length) {
        const extra = [];
        for (const h of hits) {
          const ctl = h.controller || h.src.controller;
          const n = cardsIn(ctl, 'battlefield').filter((x) => /If a creature attacking causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time/i.test(oracle(x))).length;
          for (let k = 0; k < n; k++) extra.push(h);
        }
        hits = hits.concat(extra);
      }
      // Panharmonicon, Yarok, Elesh Norn (Mother of Machines): entering triggers trigger an additional time;
      // Teysa Karlov, Drivnod: dying triggers trigger an additional time
      if ((ev.type === 'enters' || ev.type === 'dies') && hits.length) {
        const obj = ev.type === 'enters' ? card(ev.iid) : { def: ev.def, face: ev.face, zone: 'battlefield', controller: ev.controller, counters: {} };
        const extra = [];
        for (const h of hits) {
          const ctl = h.controller || h.src.controller;
          let n = 0;
          for (const x of cardsIn(ctl, 'battlefield')) {
            const o = oracle(x);
            const m = o.match(/If (?:an? |another )?([a-z ,]+?) (entering(?: the battlefield)?|dying) (?:under your control )?causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time/i);
            if (!m) {
              // Elesh Norn, Mother of Machines: "Permanents entering cause triggered abilities of permanents you control to trigger an additional time."
              if (ev.type === 'enters' && /Permanents entering (?:the battlefield )?cause triggered abilities of permanents you control to trigger an additional time/i.test(o)) n++;
              continue;
            }
            if ((m[2] === 'dying') !== (ev.type === 'dies')) continue;
            const kinds = m[1].toLowerCase().replace(/\b(?:or|and)\b/g, ',').split(',').map((k) => k.trim()).filter(Boolean);
            if (!obj || !kinds.some((k) => k === 'permanent' || (k === 'creature' ? (ev.type === 'dies' || isCreature(obj)) : isType(obj, k)))) continue;
            if (/under your control/i.test(m[0]) && ev.controller !== ctl && (obj.controller || ev.controller) !== ctl) continue;
            n++;
          }
          for (let k = 0; k < n; k++) extra.push(h);
        }
        hits = hits.concat(extra);
      }
      // more "that ability triggers an additional time": Krang (a player drawing), Felix Five-Boots (combat damage to a
      // player), Dr. Beverly Crusher (you gaining life), Veyran (you casting an instant or sorcery), Gandalf the White
      // (a legendary permanent or an artifact entering or leaving)
      if (hits.length && /^(?:draw|combatDamagePlayer|combatDamageOnce|lifeGained|cast|enters|leaves|dies|attacks|attacksAlone|youAttack)$/.test(ev.type)) {
        const extra = [];
        for (const h of hits) {
          const ctl = h.controller || h.src.controller;
          let n = 0;
          for (const x of cardsIn(ctl, 'battlefield')) {
            const o = oracle(x);
            if (!/triggers an additional time/i.test(o)) continue;
            if (ev.type === 'draw' && /If a player drawing a card causes a triggered ability of a permanent you control to trigger/i.test(o)) n++;
            if ((ev.type === 'combatDamagePlayer' || ev.type === 'combatDamageOnce') && ev.controller === ctl && /If a creature you control dealing combat damage to a player causes a triggered ability/i.test(o)) n++;
            if (ev.type === 'lifeGained' && ev.pid === ctl && /If you gaining life causes a triggered ability/i.test(o)) n++;
            // Wulfgar of Icewind Dale, Isshin: "If a creature you control attacking causes a triggered ability of a permanent you control to trigger"
            if (/^(?:attacks|attacksAlone|youAttack)$/.test(ev.type) && ev.controller === ctl && /If a creature you control attacking causes a triggered ability/i.test(o)) n++;
            if (ev.type === 'cast' && ev.controller === ctl && /If you casting or copying an instant or sorcery spell causes a triggered ability/i.test(o)) {
              const sp = card(ev.iid);
              if (sp && /\b(?:Instant|Sorcery)\b/.test(DB[sp.def].faces[ev.copyFace || sp.face || 0].typeLine || DB[sp.def].typeLine || '')) n++;
            }
            if (/^(?:enters|leaves|dies)$/.test(ev.type) && /If a legendary permanent or an artifact entering or leaving the battlefield causes a triggered ability/i.test(o)) {
              const ob = card(ev.iid);
              const tl = ob ? typeLine(ob) : DB[ev.def] ? DB[ev.def].typeLine : '';
              if (/\bLegendary\b|\bArtifact\b/.test(tl || '')) n++;
            }
          }
          for (let k = 0; k < n; k++) extra.push(h);
        }
        hits = hits.concat(extra);
      }
      // Annie Joins Up: "If a triggered ability of a legendary creature you control triggers, that ability triggers an additional time."
      if (hits.length) {
        const extra = [];
        for (const h of hits) {
          const src = h.src && h.src.iid ? card(h.src.iid) || h.src : h.src;
          if (!src || !src.iid || src.zone !== 'battlefield' || !isCreature(src) || !/\bLegendary\b/.test(typeLine(src))) continue;
          const ctl = src.controller;
          const k = cardsIn(ctl, 'battlefield').filter((x) => !x.phasedOut && /If a triggered ability of a legendary creature you control triggers, that ability triggers an additional time/i.test(oracle(x))).length;
          for (let i = 0; i < k; i++) extra.push(h);
        }
        hits = hits.concat(extra);
      }
      for (const hit of hits) {
        // "This ability triggers only once each turn" / "for the first time each turn": once it has triggered,
        // it doesn't trigger again this turn (so it never shows up on the stack)
        if (onceDone(hit)) continue;
        if (interveningIfFails(hit, ev)) continue;
        if (hit.trig && hit.trig.oncePerTurn && !hit.trig.doOnce) markOnce(hit);
        pending.push({ hit, ev });
      }
      if (ev.type === 'chapter') after.push(ev);
      }
      if (G.s !== s0) break;
      // the order they resolve in
      const act = G.s.active;
      // "As ~ enters, choose …" isn't really a trigger: it happens first (Gathering Stone's type before its ETB look)
      const asEnters = pending.filter((x) => x.hit.trig && x.hit.trig.asEnters);
      const rest = pending.filter((x) => !(x.hit.trig && x.hit.trig.asEnters));
      const mine = rest.filter((x) => (x.hit.controller || x.hit.src.controller) === 'p');
      const theirs = rest.filter((x) => (x.hit.controller || x.hit.src.controller) !== 'p');
      const ordered = mine.length > 1 ? await orderTriggers(mine) : mine;
      const queue = [...asEnters, ...(act === 'p' ? [...theirs, ...ordered] : [...ordered, ...theirs])];
      // the stack panel shows what's waiting (last to resolve at the bottom)
      const tText = (h) => String(h.trig.text || h.trig.raw || '').replace(/~/g, cardName(h.src).split(',')[0]);
      G.s.trigQueue = queue.map(({ hit }) => ({ iid: hit.src.iid, def: hit.src.def, face: hit.src.face || 0, name: cardName(hit.src), text: tText(hit), by: hit.controller || hit.src.controller }));
      // Identical token-making triggers resolve together (500 Scute Swarms: one step that makes 500 tokens, not 500 steps)
      const batchKey = (q) => {
        const h = q.hit;
        const txt = String(h.trig.text || h.trig.raw || '');
        if (!/\bcreate\b/i.test(txt) || /\btarget\b|\byou may\b|\bchoose\b|\bsacrifice\b|\bexile\b|\breturn\b|\bdestroy\b|\bdamage\b|\bdraw\b|\bdiscard\b|\bpay\b|\bcounter\b|\bvote\b|\bthat many\b|\bthat much\b|\bx\b/i.test(txt)) return null;
        return [h.controller || h.src.controller, h.src.def, h.src.face || 0, h.trig.raw, q.ev && q.ev.type, h.text || ''].join('|');
      };
      for (let qi = 0; qi < queue.length; qi++) {
        const { hit, ev } = queue[qi];
        const controller = hit.controller || hit.src.controller;
        let batch = 1;
        const bk = queue.length > 1 ? batchKey(queue[qi]) : null;
        if (bk) while (qi + batch < queue.length && batchKey(queue[qi + batch]) === bk) batch++;
        if (batch > 1) {
          qi += batch - 1;
          G.s.trigQueue = (G.s.trigQueue || []).slice(batch - 1);
        }
        G.s.trigNow = (G.s.trigQueue || []).shift() || null;
        T.render();
        if (controller === 'p' && !G.settings.arenaMode) {
          log('p', `${nameTag(hit.src)} triggers: <i>${esc(hit.trig.text || hit.trig.raw)}</i>`);
          continue;
        }
        // your trigger on the stack: the AI may counter it (Stifle)
        if (controller === 'p' && T.aiRespondTrigger && (await T.aiRespondTrigger(hit, tText(hit)))) {
          if (G.s !== s0) return;
          continue;
        }
        // the AI's trigger waits on the stack so you can respond to it (Stifle, an instant…)
        if (isAI(controller) && T.announceTrigger && (await T.announceTrigger(hit, tText(hit)))) {
          log('p', `You counter ${nameTag(hit.src)}'s triggered ability.`);
          if (G.s !== s0) return;
          continue;
        }
        if (G.s !== s0) return;
        // Strionic Resonator, Lithoform Engine: copy this trigger first (the copy resolves before the original)
        const copies = await copyTriggerWith(hit, controller, tText(hit));
        for (let k = 0; k < copies && G.s === s0; k++) {
          try {
            await resolveTrigger(hit, controller, ev);
          } catch (e) {
            if (!(e instanceof Cancelled)) console.error(e);
          }
        }
        if (G.s !== s0) return;
        try {
          G.s.tokenMult = batch;
          G.s.trigBatch = batch;
          await resolveTrigger(hit, controller, ev);
        } catch (e) {
          if (!(e instanceof Cancelled)) console.error(e);
        } finally {
          if (G.s) G.s.tokenMult = G.s.trigBatch = 0;
          // the targets announced for the AI's trigger are used up
          if (isAI(controller) && T.choosers && T.choosers[controller] && T.choosers[controller].plan) T.choosers[controller].plan = null;
        }
        if (G.s !== s0) return;
      }
      G.s.trigQueue = [];
      G.s.trigNow = null;
      for (const ev of after) {
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
    }
    if (G.s === s0) await assignSectors();
  } finally {
    running = false;
    if (G.s === s0) {
      G.s.trigQueue = [];
      G.s.trigNow = null;
      stateBased();
      T.render();
    }
  }
}

// Copying abilities on the stack: Strionic Resonator, Lithoform Engine, Adric, Tawnos, Echo, Weaver of Harmony, Abstruse
// Archaic, The Peregrine Dynamo, Peter Parker's Camera, Gogo, Mister Fantastic, Kirol, Scientist Supreme of A.I.M.
// ("Copy target [activated or] triggered ability you control [from a … source] [twice]") — offered while one of your
// abilities is on the stack; the copy resolves first. The AI copies abilities worth having twice.
const COPY_TOOL = /(?:^|\n)([^\n:]*?): Copy target (activated or )?triggered ability you control(?: from (?:an? )?(another legendary source that's not a commander|artifact source|enchantment source|creature source|colorless source))?( twice| X times)?\.([^\n]*)/i;
function copyWorthIt(text) {
  return /\b(?:draws?|create|destroy|exile|deals?|return|gain control|search|put [^.]* onto the battlefield|counters?|scry|investigate|treasure|untap|copy)\b/i.test(text) && !/\b(?:you lose|sacrifice|discard)\b/i.test(text);
}
function copyToolCost(controller, tool, cost, rest) {
  // can the cost be paid right now? → a plan (mana to pay, things to tap/remove), or null
  if (/\{T\}/.test(cost) && tool.tapped) return null;
  if (/Activate only once each turn/i.test(rest) && tool.copyUsedTurn === G.s.turn) return null;
  if (/Activate only during your turn/i.test(rest) && G.s.active !== controller) return null;
  const plan = { mana: (cost.match(/\{(?!T\})[^}]+\}/g) || []).join('').replace(/\{X\}\{X\}/, '{2}').replace(/\{X\}/g, '{1}'), tap: /\{T\}/.test(cost), life: 0, tapOthers: [], counter: null };
  const tm = cost.match(/Tap (two|three|\d+) untapped creatures you control/i);
  if (tm) {
    const k = { two: 2, three: 3 }[tm[1].toLowerCase()] || +tm[1];
    const pool = cardsIn(controller, 'battlefield').filter((x) => isCreature(x) && !x.tapped && x.iid !== tool.iid).sort((x, y) => cardValue(x) - cardValue(y));
    if (pool.length < k) return null;
    plan.tapOthers = pool.slice(0, k).map((x) => x.iid);
  }
  const lm = cost.match(/Pay (\d+) life/i);
  if (lm) {
    if (G.s.players[controller].life <= +lm[1]) return null;
    plan.life = +lm[1];
  }
  const rm = cost.match(/Remove an? (\w+) counter from/i);
  if (rm) {
    if (!((tool.counters || {})[rm[1].toLowerCase()] > 0)) return null;
    plan.counter = rm[1].toLowerCase();
  }
  return plan;
}
function sourceFits(kind, tool, src) {
  if (!kind) return true;
  if (/artifact/.test(kind)) return isType(src, 'Artifact');
  if (/enchantment/.test(kind)) return isType(src, 'Enchantment');
  if (/creature/.test(kind)) return isCreature(src);
  if (/colorless/.test(kind)) return !((DB[src.def] || {}).colors || []).length;
  if (/legendary/.test(kind)) return src.iid !== tool.iid && /\bLegendary\b/.test(typeLine(src)) && !src.isCommander;
  return true;
}
// How many times to copy this ability (each tool used once, after paying for it). kind: 'triggered' or 'activated'.
export async function copyAbilityWith(src, controller, text, kind) {
  if (!T.payMana) return 0;
  let n = 0;
  for (const tool of cardsIn(controller, 'battlefield')) {
    if (tool.phasedOut || tool.iid === src.iid && /\{T\}/.test(oracle(tool).match(COPY_TOOL)?.[1] || '')) continue;
    const m = oracle(tool).match(COPY_TOOL);
    if (!m || (kind === 'activated' && !m[2])) continue;
    if (!sourceFits((m[3] || '').toLowerCase(), tool, src)) continue;
    const plan = copyToolCost(controller, tool, m[1], m[5] || '');
    if (!plan) continue;
    const times = /twice/i.test(m[4] || '') ? 2 : 1;
    const costLabel = [plan.mana && `pay ${plan.mana}`, plan.tap && 'tap it', plan.life && `pay ${plan.life} life`, plan.tapOthers.length && `tap ${plan.tapOthers.map((i) => cardName(card(i))).join(' and ')}`, plan.counter && `remove a ${plan.counter} counter`].filter(Boolean).join(', ');
    const yes = isAI(controller)
      ? copyWorthIt(text) && (!plan.life || G.s.players[controller].life > 15)
      : await T.confirm(cardName(tool), `${cardName(src)}'s ${kind} ability is on the stack:\n${text}\n\nCopy it${times > 1 ? ' twice' : ''} with ${cardName(tool)}${costLabel ? ` (${costLabel})` : ''}? The copy resolves first.`);
    if (!yes) continue;
    if (plan.mana && !(await T.payMana(controller, plan.mana, cardName(tool)))) continue;
    if (plan.tap) tool.tapped = true;
    for (const i of plan.tapOthers) if (card(i)) card(i).tapped = true;
    if (plan.life) changeLife(controller, -plan.life, false);
    if (plan.counter) tool.counters[plan.counter]--;
    tool.copyUsedTurn = G.s.turn;
    log(controller, `${controller === 'p' ? 'You copy' : 'The AI copies'} ${nameTag(src)}'s ${kind} ability with ${nameTag(tool)}${times > 1 ? ' (twice)' : ''}.`);
    n += times;
  }
  return n;
}
T.copyAbilityWith = copyAbilityWith;
async function copyTriggerWith(hit, controller, text) {
  return copyAbilityWith(hit.src, controller, text, 'triggered');
}

// Several of your triggers at once: you choose the order they resolve in (identical ones needn't be ordered)
async function orderTriggers(list) {
  if (!G.settings.arenaMode || G.settings.orderTriggers === false || !T.choosers || !T.choosers.p || !T.choosers.p.choose) return list;
  const label = (x) => `${cardName(x.hit.src)}: ${String(x.hit.trig.text || x.hit.trig.raw || '').replace(/~/g, cardName(x.hit.src).split(',')[0]).slice(0, 110)}`;
  if (new Set(list.map(label)).size < 2) return list;
  const left = list.slice();
  const out = [];
  while (left.length > 1 && new Set(left.map(label)).size > 1) {
    const k = await T.choosers.p.choose({
      prompt: out.length ? `Which of your triggers resolves next? (${left.length} left)` : `${left.length} of your abilities triggered at the same time. Which resolves first?`,
      options: [...left.map((x) => ({ label: label(x) })), { label: 'Resolve all', detail: 'The rest resolve in the order shown above', cls: 'resolve-all' }],
      aiPick: () => 0,
    });
    if (k === left.length) break; // "Resolve all": keep the listed order
    const i = Math.max(0, Math.min(left.length - 1, typeof k === 'number' ? k : 0));
    out.push(left.splice(i, 1)[0]);
  }
  return [...out, ...left];
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

const onceKey = (hit) => `${hit.src && hit.src.iid}|${hit.trig.raw}`;
function onceDone(hit) {
  return !!(hit.trig && hit.trig.oncePerTurn && G.s.trigOnce && G.s.trigOnce[onceKey(hit)] === G.s.turn);
}
function markOnce(hit) {
  G.s.trigOnce = G.s.trigOnce || {};
  G.s.trigOnce[onceKey(hit)] = G.s.turn;
}
// While a triggered ability resolves there's nothing to cancel: the player's pickers offer "Choose none", not "Cancel spell"
async function resolveTrigger(hit, controller, ev) {
  T.inTrigger = (T.inTrigger || 0) + 1;
  try {
    return await resolveTriggerRaw(hit, controller, ev);
  } finally {
    T.inTrigger--;
  }
}
// The AI skips a first chapter that would hurt it more than the opponent (The Elder Dragon War: 2 damage to each creature)
function readAheadPick(c) {
  const m = (face(c).oracle || '').match(/^I — [^\n]*?deals (\d+) damage to each creature/m);
  if (!m) return 0;
  const k = +m[1];
  const dies = (pid) => cardsIn(pid, 'battlefield').filter((x) => isCreature(x) && toughness(x) - (x.damage || 0) <= k && !hasKw(x, 'indestructible')).length;
  return dies(c.controller) > opponents(c.controller).reduce((a, o) => a + dies(o), 0) ? 1 : 0;
}
async function resolveTriggerRaw(hit, controller, ev) {
  const { src, trig } = hit;
  // a graveyard ability whose card has left the graveyard since it triggered (Endless Ranks of HYDRA already returned)
  if (trig.fromGy && src.iid && card(src.iid) && card(src.iid).zone !== 'graveyard') return;
  // "Do this only once each turn": the ability still triggers, but does nothing after the first time
  if (trig.oncePerTurn && trig.doOnce) {
    if (onceDone(hit)) return;
    markOnce(hit);
  }
  const ctx = {
    me: controller, choosers: T.choosers, forced: true, thatPlayer: hit.thatPlayer, it: hit.it || null, wasAttacking: hit.wasAttacking, castFree: T.castFree, deadCounters: ev && ev.counters,
    kicked: src.kicked, bargained: src.bargained, x: hit.x !== undefined ? hit.x : src.xPaid || 0, castMode: src.castMode, castFrom: src.castFrom, event: ev,
    // a spell waiting on the other side of the stack (Transcendent Dragon: "counter target spell")
    stackTarget: controller === 'p' && G.s.stack && !G.s.stack.ability ? G.s.stack.iid : isAI(controller) && G.s.pstack ? G.s.pstack.iid : null,
  };
  if (hit.amount !== undefined) {
    ctx.lastAmount = hit.amount;
    ctx.thatMuch = hit.amount;
  }
  if (hit.them) ctx.them_ = ctx.trigThem = hit.them;
  if (hit.counterKind) ctx.counterKind = hit.counterKind;
  if (trig.fn) {
    const did = await trig.fn(ctx, hit, ev);
    if (did && did.length) log(controller, `${nameTag(src)}: ${did.join('; ')}.`);
    stateBased();
    T.render();
    return;
  }
  let text = hit.text || trig.text;
  if (trig.optional) {
    text = text.replace(/^you may /i, '');
    // the AI takes optional triggers unless they cost it something
    const yes = isAI(controller) ? /^pay that much life\. if you do, draw that many cards/i.test(text) /* Niv-Mizzet, Ghost Counsel: the effect decides */ || /^sacrifice one of them\. If you do, reveal cards/i.test(text) /* Descendants' Fury */ || /^sacrifice up to (?:one|two|three) [A-Za-z]+\. When you sacrifice/i.test(text) /* Ravenous Rotbelly: the handler decides */ || /^draw cards equal to the number of opponents dealt damage this way/i.test(text) /* Hordewing Skaab: looting */ || (/^pay life equal to its mana value\. If you do, put it onto the battlefield/i.test(text) && G.s.players[controller].life >= 20) /* Lorcan */ || /^pay (?:\{[^}]+\})+\. (?:If|When) you do, (?!sacrifice|discard|exile [^.]*you control)/i.test(text) || /^pay any amount of \{[WUBRGC]\}\. (?:If|When) you do, /i.test(text) || knownEffect(text) || !/sacrifice|discard|lose \d+ life|\bpay\b|exile [^.]*you control|return [^.]*you control to/i.test(text) : await T.confirm(cardName(src), `${trig.raw.replace(/~/g, cardName(src))}${ctx.thatMuch && /\bthat (?:much|many)\b/i.test(text) ? `\n\n(That's ${ctx.thatMuch}: ${text.replace(/\bthat much\b|\bthat many\b/gi, String(ctx.thatMuch)).replace(/^./, (x) => x.toUpperCase())})` : ''}\n\nDo it?`);
    if (!yes) return;
    ctx.lastMay = true; // "you may discard a card. If you do, draw two cards."
  }
  const did = await resolveEffects(text, src, ctx);
  if (did.length) log(controller, `${nameTag(src)} ${trig.event === 'chapter' ? 'chapter' : 'triggers'}${G.s.trigBatch > 1 ? ` ×${G.s.trigBatch}` : ''}: ${did.join('; ')}.`);
  else if (!trig.kw && !did.skipped && knownEffect(text)) log(controller, `${nameTag(src)} triggers, but it does nothing${/\btarget\b/i.test(text) ? ' (no legal targets)' : ''}.`);
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
  for (const pid of [...opponents(owner), owner]) {
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
  // your commander's creature types come first (Secluded Courtyard, Path of Ancestry-style choices usually want them)
  const cmdTypes = [];
  for (const c of Object.values(G.s.cards)) {
    if (!c.isCommander || (c.owner || c.controller) !== pid) continue;
    const tl = DB[c.def].faces[0].typeLine || '';
    if (/Creature|Kindred|Tribal/.test(tl.split('—')[0]) && tl.includes('—')) for (const w of tl.split('—')[1].trim().split(/\s+/)) if (w && !cmdTypes.includes(w)) cmdTypes.push(w);
  }
  const list = [...new Set([...cmdTypes, ...mine.slice(0, 12), ...COMMON_TYPES])].slice(0, 26);
  const cnt = (t) => mine.length - (mine.indexOf(t) < 0 ? mine.length : mine.indexOf(t));
  const aiBest = () => list.map((t, i) => [i, cnt(t) + (cmdTypes.includes(t) ? 6 : 0)]).sort((a, b) => b[1] - a[1])[0][0];
  const k = await T.choosers[pid].choose({ prompt, options: list.map((t) => ({ label: t, detail: [cmdTypes.includes(t) ? 'your commander' : '', mine.includes(t) ? 'in your deck' : ''].filter(Boolean).join(' · ') })), aiPick: aiBest });
  return list[k] || list[0];
}

