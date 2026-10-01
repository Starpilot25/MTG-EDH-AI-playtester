// Shared effect engine. Reads oracle text, works out what a spell or ability does,
// asks the controller's "chooser" for targets and choices, and applies the result.
// The AI's chooser picks automatically; the player's chooser asks through the UI
// (highlighted targets, card pickers), the way MTG Arena does.
import { DB } from './data.js';
import {
  hasSubtype, isLand, isCreature, isType, oracle, hasKw, power, toughness, cardValue, face,
} from './rules.js';
import {
  G, card, cardsIn, zoneOf, move, draw, log, nameTag, changeLife, toBattlefield, createToken,
  genericTokenDef, stateBased, shuffle, cardName, opp,
} from './state.js';

const WORDNUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
export const n = (w, x = 0) => {
  if (w === undefined || w === null) return 1;
  w = String(w).toLowerCase();
  if (w === 'x') return x;
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return WORDNUM[w] || 1;
};

export class Cancelled extends Error {}

export function costOf(c) {
  const f = face(c);
  return f.manaCost || DB[c.def].manaCost || '';
}

// "your Questing Beast" / "the AI's Questing Beast", always from the human's point of view
export function whose(c) {
  return (c.zone === 'battlefield' ? c.controller : c.owner) === 'p' ? 'your' : "the AI's";
}
export const who = (pid) => (pid === 'p' ? 'you' : 'the AI');

// ------------------------------------------------------------ text helpers
export function stripName(text, c) {
  const name = cardName(c);
  let t = text.split(name).join('~');
  const short = name.split(',')[0];
  if (short.length > 3) t = t.split(short).join('~');
  return t;
}

export function etbText(c) {
  const t = stripName(oracle(c), c);
  const out = [];
  for (const m of t.matchAll(
    /When(?:ever)? (?:~|this (?:creature|artifact|enchantment|permanent|land|Saga))(?: enters| enters the battlefield)(?: or attacks)?[^,]*, ([^]+?)(?:\n|$)/g
  ))
    out.push(m[1]);
  return out.join(' ');
}

export function spellText(c) {
  return stripName(oracle(c), c)
    .replace(/\([^)]*\)/g, '')
    .split('\n')
    .filter((l) => !/^(Kicker|Flashback|Buyback|Cycling|Escape|Overload|Entwine|Foretell|Madness|Retrace|Jump-start)\b/.test(l))
    .join('\n');
}

// Activated abilities a player can use from a permanent ("{2}, {T}: Draw a card.")
export function activatedAbilities(c) {
  const t = stripName(oracle(c), c).replace(/\([^)]*\)/g, '');
  const out = [];
  for (const line of t.split('\n')) {
    const loyal = line.match(/^([+−\-]?\d+|0):\s*(.+)$/);
    if (loyal && isType(c, 'Planeswalker')) {
      out.push({ kind: 'loyalty', cost: parseInt(loyal[1].replace('−', '-'), 10) || 0, label: loyal[1], text: loyal[2], raw: line });
      continue;
    }
    const eq = line.match(/^Equip(?: [^{]*?)? ((?:\{[^}]+\})+)/);
    if (eq) {
      out.push({ kind: 'equip', mana: eq[1], text: '', raw: line });
      continue;
    }
    const m = line.match(/^([^:"]{1,90}?):\s*(.+)$/);
    if (!m) continue;
    const cost = m[1];
    if (!/\{|Sacrifice|Discard|Pay|Remove|Exile|Tap/i.test(cost)) continue;
    if (/^Add\b/.test(m[2])) continue; // mana abilities are handled by auto-pay
    out.push({
      kind: 'ability',
      tap: /\{T\}/.test(cost),
      sac: /Sacrifice ~|Sacrifice this/i.test(cost),
      mana: (cost.match(/\{(?!T\}|Q\})[^}]+\}/g) || []).join(''),
      costText: cost,
      text: m[2],
      raw: line,
    });
  }
  return out;
}

// ------------------------------------------------------------ targeting filters
export function canTarget(c, casterPid) {
  if (hasKw(c, 'shroud')) return false;
  const theirs = (c.zone === 'battlefield' ? c.controller : c.owner) !== casterPid;
  if (theirs && (hasKw(c, 'hexproof') || /protection from everything/i.test(oracle(c)))) return false;
  return true;
}

export function matchesFilter(c, phrase) {
  phrase = phrase.toLowerCase();
  const d = DB[c.def];
  const colorWord = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
  for (const m of phrase.matchAll(/non-?(\w+)/g)) {
    const w = m[1];
    if (colorWord[w] && d.colors.includes(colorWord[w])) return false;
    if (['artifact', 'creature', 'land', 'legendary', 'token', 'enchantment'].includes(w)) {
      if (w === 'token' ? c.token : isType(c, w)) return false;
    }
  }
  if (/\btapped\b/.test(phrase) && !/untapped/.test(phrase) && !c.tapped) return false;
  if (/attacking/.test(phrase) && !c.attacking) return false;
  const mv = phrase.match(/mana value (\d+) or less/);
  if (mv && d.cmc > parseInt(mv[1], 10)) return false;
  const pw = phrase.match(/power (\d+) or greater/);
  if (pw && power(c) < parseInt(pw[1], 10)) return false;
  const kinds = [];
  if (/creature/.test(phrase)) kinds.push('Creature');
  if (/artifact/.test(phrase.replace(/nonartifact/g, ''))) kinds.push('Artifact');
  if (/enchantment/.test(phrase.replace(/nonenchantment/g, ''))) kinds.push('Enchantment');
  if (/planeswalker/.test(phrase)) kinds.push('Planeswalker');
  if (/\bland\b/.test(phrase.replace(/nonland/g, ''))) kinds.push('Land');
  if (/nonland permanent|\bpermanent\b/.test(phrase) && !kinds.length) return !isLand(c) || !/nonland/.test(phrase);
  if (!kinds.length) return true;
  return kinds.some((k) => (k === 'Creature' ? isCreature(c) : isType(c, k)));
}

// Which battlefields a phrase allows: "an opponent controls" / "you control" / either.
function sidesFor(phrase, me) {
  if (/an opponent controls|you don't control|your opponents control/.test(phrase)) return [opp(me)];
  if (/you control/.test(phrase)) return [me];
  return [me, opp(me)];
}

export function legalTargets(phrase, me) {
  return sidesFor(phrase, me)
    .flatMap((pid) => cardsIn(pid, 'battlefield'))
    .filter((c) => canTarget(c, me) && matchesFilter(c, phrase));
}

// ------------------------------------------------------------ X values
function devotion(pid, color) {
  const sym = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[color];
  let k = 0;
  for (const c of cardsIn(pid, 'battlefield')) for (const m of costOf(c).matchAll(/\{([^}]+)\}/g)) if (m[1].includes(sym)) k++;
  return k;
}

function resolveX(text, me, x) {
  let m;
  if ((m = text.match(/X is your devotion to (white|blue|black|red|green)/i))) return devotion(me, m[1].toLowerCase());
  if (/X is the number of creatures you control/i.test(text)) return cardsIn(me, 'battlefield').filter(isCreature).length;
  if (/X is the number of lands you control/i.test(text)) return cardsIn(me, 'battlefield').filter(isLand).length;
  if (/X is the number of cards in your hand/i.test(text)) return zoneOf(me, 'hand').length;
  return x;
}

// ------------------------------------------------------------ analysis
export function analyze(text, x = 0) {
  const t = text.toLowerCase();
  const a = {};
  let m;
  if ((m = t.match(/(?:^|\. |\n)(?:you |target player )?draws? (a|an|one|two|three|four|five|x|\d+) cards?/)) ||
      (m = t.match(/(?:^|\n|\. |, )draw (a|an|one|two|three|four|five|x|\d+) cards?/)))
    a.draw = n(m[1], x);
  if ((m = t.match(/(destroy|exile) (?:up to one )?target ([^.]+?)(?:\.|,| and| with| an opponent| you don't| that)/)))
    a.removal = { verb: m[1], phrase: m[2] + (/an opponent controls/.test(t) ? ' an opponent controls' : '') };
  if ((m = t.match(/return (?:up to one )?target ([^.]+?) to (?:its|their) owner's hand/))) a.bounce = { phrase: m[1] };
  if ((m = t.match(/deals? (\d+|x) damage to (any target|target creature or planeswalker|target creature|target player or planeswalker|target opponent|target player|each opponent)/)))
    a.burn = { amount: n(m[1], x), to: m[2] };
  if (/destroy all (?:creatures|nonland permanents|other creatures)|exile all creatures|all creatures get -\d+\/-\d+|destroy each creature/.test(t))
    a.wipe = true;
  if ((m = t.match(/deals? (\d+|x) damage to each (creature[^.]*?|player)(?:\.|$)/)))
    a.massDamage = { amount: n(m[1], x), phrase: m[2], players: /each player|and each player|each opponent/.test(m[0]) };
  if ((m = t.match(/create (a|an|one|two|three|four|five|x|\d+) (?:tapped )?([^.]*?)tokens?/))) a.token = { count: n(m[1], x), desc: m[2] };
  if ((m = t.match(/you gain (\d+|x) life/))) a.gain = n(m[1], x);
  if ((m = t.match(/(?:each opponent|target opponent|target player|that player|defending player) loses (\d+|x) life/))) a.drain = n(m[1], x);
  if ((m = t.match(/(?:and |, )?you lose (\d+|x) life|(?:target player )?draws? \w+ cards? and loses? (\d+) life/))) a.loseSelf = n(m[1] || m[2], x);
  if (/search your library for [^.]*?land cards?|search your library for (?:a|up to \w+) (?:basic )?(?:forest|island|swamp|mountain|plains)/.test(t)) a.ramp = true;
  else if (/search your library for (?:a|an) (?:\w+ )?card/.test(t)) a.tutor = true;
  if (/return target creature card from your graveyard to the battlefield/.test(t)) a.reanimate = true;
  if (/return (?:up to \w+ )?target (?:creature |permanent |nonland permanent |instant or sorcery |land )?cards? from your graveyard to your hand/.test(t)) a.regrowth = true;
  if ((m = t.match(/(?:each|target) opponent sacrifices (a|two|\d+) creatures?/))) a.edict = n(m[1]);
  if ((m = t.match(/put (a|one|two|three|\d+|x) \+1\/\+1 counters? on (target creature|each creature you control)/)))
    a.counters = { amount: n(m[1], x), each: /each/.test(m[2]) };
  if ((m = t.match(/target creature (?:you control )?gets \+(\d+|x)\/\+(\d+|x)(?: and gains ([a-z, ]+?))? until end of turn/)))
    a.pump = { p: n(m[1], x), t: n(m[2], x), grants: kwList(m[3]) };
  if ((m = t.match(/creatures you control get \+(\d+|x)\/\+(\d+|x)(?: and gain ([a-z, ]+?))? until end of turn/)) ||
      (m = t.match(/creatures you control gain ([a-z, ]+?) and get \+(\d+|x)\/\+(\d+|x) until end of turn/)))
    a.teamPump = m[0].includes('gain ') && m[0].indexOf('gain') < m[0].indexOf('get')
      ? { p: n(m[2], x), t: n(m[3], x), grants: kwList(m[1]) }
      : { p: n(m[1], x), t: n(m[2], x), grants: kwList(m[3]) };
  if ((m = t.match(/(?:^|\. |\n)scry (\d+)/))) a.scry = +m[1];
  if ((m = t.match(/(?:^|\. |\n)surveil (\d+)/))) a.surveil = +m[1];
  if (/counter target/.test(t)) a.counterspell = true;
  // card selection
  if (/\bconnives?\b/.test(t)) {
    a.draw = 1;
    a.discard = 1;
    a.connive = true;
  }
  if ((m = t.match(/then discard (a|one|two|three|\d+) cards?/))) a.discard = n(m[1]);
  // effects on the source itself
  if (/\btransform ~|\btransform it\b|\btransform (?:him|her|this creature)\b/.test(t)) a.transform = true;
  if ((m = t.match(/put (a|one|two|three|\d+|x) \+1\/\+1 counters? on (?:~|it|him|her|this creature)(?:\.|,| and|$)/))) a.selfCounters = n(m[1], x);
  if ((m = t.match(/~ gets \+(\d+|x)\/\+(\d+|x)(?: and gains ([a-z, ]+?))? until end of turn/))) a.selfPump = { p: n(m[1], x), t: n(m[2], x), grants: kwList(m[3]) };
  if ((m = t.match(/\binvestigate\b/))) a.investigate = true;
  // "that player" = the player a combat-damage trigger hit
  if ((m = t.match(/deals? (\d+|x) damage to (that player|defending player)/))) a.thatDamage = n(m[1], x);
  if ((m = t.match(/(?:that player|defending player) sacrifices (a|two|\d+) creatures?/))) a.edict = n(m[1]);
  if ((m = t.match(/(?:that player|each opponent|target opponent) discards (a|one|two|\d+) cards?/))) a.oppDiscard = n(m[1]);
  if ((m = t.match(/(?:that player|each opponent|target player|target opponent) mills (a|one|two|three|four|five|\d+|x) cards?/))) a.mill = n(m[1], x);
  return a;
}

function kwList(s) {
  return s ? s.split(/, | and /).map((k) => k.trim()).filter(Boolean) : [];
}

export function knownEffect(text) {
  return Object.keys(analyze(text)).filter((k) => k !== 'counterspell').length > 0;
}

// ------------------------------------------------------------ resolving
/**
 * Resolve an effect text.
 * ctx: { me, x, choosers: {p, ai} }   chooser API:
 *   target({prompt, candidates:[iid], players:[pid], optional, harm, amount, src}) -> {iid} | {player} | null
 *   pickCards({prompt, cards:[iid], min, max, purpose, aiScore, src}) -> [iid]
 *   scry({n, surveil}) -> void
 * Returns a list of short descriptions of what happened.
 */
export async function resolveEffects(text, src, ctx) {
  if (!text) return [];
  const me = ctx.me;
  const them = opp(me);
  const choose = ctx.choosers[me];
  const x = resolveX(text, me, ctx.x || 0);
  const a = analyze(text, x);
  const t = text.toLowerCase();
  const did = [];
  const F = ctx.forced ? { forced: true } : {};

  if (a.wipe) {
    const all = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter(isCreature);
    let killed = 0;
    for (const c of all) {
      if (c.iid === src.iid) continue;
      if (/destroy/.test(t) && hasKw(c, 'indestructible')) continue;
      const m = t.match(/get -(\d+)\/-(\d+)/);
      if (m && toughness(c) > n(m[2], x)) continue;
      move(c.iid, /exile all/.test(t) ? 'exile' : 'graveyard');
      killed++;
    }
    did.push(`a board wipe hits ${killed} creature${killed === 1 ? '' : 's'}`);
  }

  if (a.massDamage) {
    const { amount, phrase } = a.massDamage;
    if (/creature/.test(phrase)) {
      const sides = /your opponents control|an opponent controls|you don't control/.test(phrase) ? [them] : /you control/.test(phrase) ? [me] : ['p', 'ai'];
      const hit = sides.flatMap((pid) => cardsIn(pid, 'battlefield')).filter((c) => {
        if (!isCreature(c)) return false;
        if (/without flying/.test(phrase)) return !hasKw(c, 'flying');
        if (/with flying/.test(phrase)) return hasKw(c, 'flying');
        return true;
      });
      hit.forEach((c) => (c.damage += amount));
      did.push(`deals ${amount} damage to ${hit.length} creature${hit.length === 1 ? '' : 's'}`);
    }
    if (/each player|each opponent/.test(text.toLowerCase())) {
      for (const pid of /each opponent/.test(text.toLowerCase()) ? [them] : ['p', 'ai']) changeLife(pid, -amount, false);
      did.push(`deals ${amount} damage to ${/each opponent/.test(text.toLowerCase()) ? who(them) : 'each player'}`);
    }
  }

  if (a.removal) {
    const cands = legalTargets(a.removal.phrase, me);
    const pick = await choose.target({
      ...F,
      prompt: `Choose a target to ${a.removal.verb}: ${a.removal.phrase}`,
      candidates: cands.map((c) => c.iid), harm: true, src, optional: !cands.length,
    });
    if (pick && pick.iid) {
      const tgt = card(pick.iid);
      const nm = `${whose(tgt)} ${nameTag(tgt)}`;
      if (a.removal.verb === 'destroy' && hasKw(tgt, 'indestructible')) did.push(`targets ${nm} (indestructible, it survives)`);
      else {
        move(tgt.iid, a.removal.verb === 'exile' ? 'exile' : 'graveyard');
        did.push(`${a.removal.verb === 'exile' ? 'exiles' : 'destroys'} ${nm}`);
      }
    }
  }

  if (a.bounce) {
    const cands = legalTargets(a.bounce.phrase, me);
    const pick = await choose.target({
      ...F,
      prompt: `Choose a ${a.bounce.phrase} to return to its owner's hand`,
      candidates: cands.map((c) => c.iid), harm: true, src, optional: !cands.length,
    });
    if (pick && pick.iid) {
      const tgt = card(pick.iid);
      const nm = `${whose(tgt)} ${nameTag(tgt)}`;
      move(tgt.iid, 'hand');
      did.push(`returns ${nm} to its owner's hand`);
    }
  }

  if (a.burn) {
    const amt = a.burn.amount;
    const to = a.burn.to;
    if (to === 'each opponent') {
      changeLife(them, -amt, false);
      did.push(`deals ${amt} damage to ${who(them)}`);
    } else {
      const creatures = /creature|any target/.test(to);
      const walkers = /planeswalker|any target/.test(to);
      const cands = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter(
        (c) => canTarget(c, me) && ((creatures && isCreature(c)) || (walkers && isType(c, 'Planeswalker')))
      );
      const players = /any target|player/.test(to) ? [them, me] : /opponent/.test(to) ? [them] : [];
      const pick = await choose.target({
      ...F,
        prompt: `Choose a target for ${amt} damage`, candidates: cands.map((c) => c.iid), players,
        harm: true, amount: amt, src, optional: !cands.length && !players.length,
      });
      if (pick && pick.iid) {
        const tgt = card(pick.iid);
        if (isType(tgt, 'Planeswalker') && !isCreature(tgt)) tgt.counters.loyalty = Math.max(0, (tgt.counters.loyalty || 0) - amt);
        else tgt.damage += amt;
        if (hasKw(src, 'deathtouch')) tgt.deathtouched = true;
        did.push(`deals ${amt} damage to ${whose(tgt)} ${nameTag(tgt)}`);
        if (isType(tgt, 'Planeswalker') && !isCreature(tgt) && tgt.counters.loyalty <= 0) move(tgt.iid, 'graveyard');
      } else if (pick && pick.player) {
        changeLife(pick.player, -amt, false);
        did.push(`deals ${amt} damage to ${who(pick.player)}`);
      }
    }
  }

  if (a.edict) {
    // the opponent chooses what to sacrifice
    const theirs = cardsIn(ctx.thatPlayer || them, 'battlefield').filter(isCreature);
    if (theirs.length) {
      const picks = await ctx.choosers[them].pickCards({
        ...F,
        prompt: `Choose ${a.edict} creature${a.edict > 1 ? 's' : ''} to sacrifice`, cards: theirs.map((c) => c.iid),
        min: Math.min(a.edict, theirs.length), max: Math.min(a.edict, theirs.length), purpose: 'sacrifice', src, forced: true,
        aiScore: (c) => -cardValue(c),
      });
      for (const iid of picks) {
        did.push(`${who(them)} sacrifice${them === 'ai' ? 's' : ''} ${nameTag(card(iid))}`);
        move(iid, 'graveyard');
      }
    }
  }

  if (a.draw) {
    draw(me, a.draw, true);
    did.push(`${me === 'p' ? 'you draw' : 'draws'} ${a.draw}`);
  }
  if (a.discard) {
    const hand = cardsIn(me, 'hand');
    const k = Math.min(a.discard, hand.length);
    if (k) {
      const lands = cardsIn(me, 'battlefield').filter(isLand).length;
      const picks = await choose.pickCards({
        ...F, forced: true,
        prompt: `Choose ${k === 1 ? 'a card' : k + ' cards'} to discard`, cards: hand.map((c) => c.iid), min: k, max: k,
        purpose: 'discard', src,
        // AI: pitch extra lands late, expensive spells early
        aiScore: (c) => (isLand(c) ? (lands >= 6 ? 10 : -10) : DB[c.def].cmc - lands),
      });
      const nonland = picks.some((i) => !isLand(card(i)));
      did.push(`discards ${picks.map((i) => nameTag(card(i))).join(', ')}`);
      picks.forEach((i) => move(i, 'graveyard'));
      if (a.connive && nonland && src.zone === 'battlefield') {
        src.counters['+1/+1'] = (src.counters['+1/+1'] || 0) + 1;
        did.push(`${nameTag(src)} gets a +1/+1 counter`);
      }
    }
  }
  if (a.transform && src.zone === 'battlefield' && DB[src.def].faces.length > 1) {
    const before = nameTag(src);
    src.face = src.face ? 0 : 1;
    did.push(`${before} transforms into ${nameTag(src)}`);
  }
  if (a.selfCounters && src.zone === 'battlefield') {
    src.counters['+1/+1'] = (src.counters['+1/+1'] || 0) + a.selfCounters;
    did.push(`${nameTag(src)} gets ${a.selfCounters} +1/+1 counter${a.selfCounters > 1 ? 's' : ''}`);
  }
  if (a.selfPump && src.zone === 'battlefield') {
    pumpEOT(src, a.selfPump);
    did.push(`${nameTag(src)} gets +${a.selfPump.p}/+${a.selfPump.t} until end of turn`);
  }
  if (a.investigate) {
    createToken(genericTokenDef(0, 0, 'Clue'), me, 1);
    did.push('investigates');
  }
  if (a.thatDamage) {
    const tp = ctx.thatPlayer || them;
    changeLife(tp, -a.thatDamage, false);
    did.push(`deals ${a.thatDamage} damage to ${who(tp)}`);
  }
  if (a.oppDiscard) {
    const tp = ctx.thatPlayer || them;
    const hand = cardsIn(tp, 'hand');
    const k = Math.min(a.oppDiscard, hand.length);
    if (k) {
      const picks = await ctx.choosers[tp].pickCards({
        forced: true, prompt: `Choose ${k === 1 ? 'a card' : k + ' cards'} to discard`, cards: hand.map((c) => c.iid),
        min: k, max: k, purpose: 'discard', src, aiScore: (c) => (isLand(c) ? 5 : -DB[c.def].cmc),
      });
      did.push(`${who(tp)} discard${tp === 'ai' ? 's' : ''} ${picks.map((i) => nameTag(card(i))).join(', ')}`);
      picks.forEach((i) => move(i, 'graveyard'));
    }
  }
  if (a.mill) {
    const tp = /you mill|mill (?:a|\w+) cards?$/.test(t) && !/player|opponent/.test(t) ? me : ctx.thatPlayer || them;
    const lib = zoneOf(tp, 'library');
    const ids = lib.slice(Math.max(0, lib.length - a.mill));
    ids.forEach((i) => move(i, 'graveyard'));
    did.push(`${who(tp)} mill${tp === 'ai' ? 's' : ''} ${ids.length}`);
  }
  if (a.scry || a.surveil) {
    await choose.scry({ n: a.scry || a.surveil, surveil: !!a.surveil, src });
    did.push(`${a.scry ? 'scry' : 'surveil'} ${a.scry || a.surveil}`);
  }
  if (a.token) makeTokens(src, a.token, me, did);
  if (a.gain) {
    changeLife(me, a.gain, false);
    did.push(`${me === 'p' ? 'you gain' : 'gains'} ${a.gain} life`);
  }
  if (a.drain) {
    const tp = /that player|defending player/.test(t) ? ctx.thatPlayer || them : them;
    changeLife(tp, -a.drain, false);
    did.push(`${who(tp)} lose${tp === 'ai' ? 's' : ''} ${a.drain} life`);
    if (/gain life equal to the life lost/.test(t)) {
      changeLife(me, a.drain, false);
      did.push(`${me === 'p' ? 'you gain' : 'gains'} ${a.drain} life`);
    }
  }
  if (a.loseSelf) {
    changeLife(me, -a.loseSelf, false);
    did.push(`${me === 'p' ? 'you lose' : 'loses'} ${a.loseSelf} life`);
  }
  if (a.ramp) await fetchLands(t, me, choose, src, did);
  if (a.tutor) await tutor(t, me, choose, src, did);
  if (a.reanimate || a.regrowth) {
    const gy = cardsIn(me, 'graveyard').filter((c) => (a.reanimate ? isType(c, 'Creature') : true) && c.iid !== src.iid);
    if (gy.length) {
      const picks = await choose.pickCards({
        prompt: a.reanimate ? 'Choose a creature card to return to the battlefield' : 'Choose a card to return to your hand',
        cards: gy.map((c) => c.iid), min: 1, max: 1, purpose: a.reanimate ? 'reanimate' : 'regrowth', src,
        aiScore: (c) => DB[c.def].cmc + (isCreature(c) ? 2 : 0),
      });
      for (const iid of picks) {
        const nm = nameTag(card(iid));
        if (a.reanimate) toBattlefield(iid, me);
        else move(iid, 'hand');
        did.push(a.reanimate ? `returns ${nm} to the battlefield` : `returns ${nm} to hand`);
      }
    }
  }
  if (a.counters) {
    const own = cardsIn(me, 'battlefield').filter(isCreature);
    let targets = [];
    if (a.counters.each) targets = own;
    else {
      const cands = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter((c) => isCreature(c) && canTarget(c, me));
      const pick = await choose.target({
      ...F,
        prompt: `Choose a creature to get ${a.counters.amount} +1/+1 counter${a.counters.amount > 1 ? 's' : ''}`,
        candidates: cands.map((c) => c.iid), harm: false, src, optional: !cands.length,
      });
      if (pick && pick.iid) targets = [card(pick.iid)];
    }
    targets.forEach((c) => (c.counters['+1/+1'] = (c.counters['+1/+1'] || 0) + a.counters.amount));
    if (targets.length) did.push(`puts +1/+1 counters on ${targets.map(nameTag).join(', ')}`);
  }
  if (a.pump) {
    const cands = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter(
      (c) => isCreature(c) && canTarget(c, me) && (!/target creature you control/.test(t) || c.controller === me)
    );
    const pick = await choose.target({
      ...F,
      prompt: `Choose a creature to get +${a.pump.p}/+${a.pump.t}`, candidates: cands.map((c) => c.iid),
      harm: false, src, optional: !cands.length,
    });
    if (pick && pick.iid) {
      pumpEOT(card(pick.iid), a.pump);
      did.push(`${nameTag(card(pick.iid))} gets +${a.pump.p}/+${a.pump.t}${a.pump.grants.length ? ' and ' + a.pump.grants.join(', ') : ''} until end of turn`);
    }
  }
  if (a.teamPump) {
    const own = cardsIn(me, 'battlefield').filter(isCreature);
    own.forEach((c) => pumpEOT(c, a.teamPump));
    if (own.length) did.push(`creatures get +${a.teamPump.p}/+${a.teamPump.t}${a.teamPump.grants.length ? ' and ' + a.teamPump.grants.join(', ') : ''} until end of turn`);
  }
  stateBased();
  return did;
}

function pumpEOT(c, pump) {
  c.eot = { p: (c.eot ? c.eot.p : 0) + pump.p, t: (c.eot ? c.eot.t : 0) + pump.t };
  if (pump.grants.length) c.eotGrants = [...(c.eotGrants || []), ...pump.grants.map((g) => g.toLowerCase())];
}

function makeTokens(src, tok, me, did) {
  const d = DB[src.def];
  const desc = tok.desc.toLowerCase();
  let defId = null;
  for (const id of d.tokens) {
    const td = DB[id];
    if (!td) continue;
    const nm = td.name.toLowerCase();
    if (desc.includes(nm) || desc.includes(nm.split(' ')[0])) {
      defId = id;
      break;
    }
  }
  if (!defId && d.tokens.length === 1 && DB[d.tokens[0]]) defId = d.tokens[0];
  if (!defId) {
    let m2;
    const m = desc.match(/(\d+|x)\/(\d+|x)\s+(?:(\w+) )?(?:(\w+) )?(?:(\w+) )?creature/);
    if (m) {
      const words = [m[3], m[4], m[5]].filter((w) => w && !/white|blue|black|red|green|colorless|and|artifact|legendary/.test(w));
      const label = words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : 'Creature';
      defId = genericTokenDef(m[1], m[2], label);
    } else if ((m2 = desc.match(/\b(treasure|clue|food|blood|map)\b/))) defId = genericTokenDef(0, 0, m2[1][0].toUpperCase() + m2[1].slice(1));
    else defId = genericTokenDef(1, 1, 'Token');
  }
  const made = createToken(defId, me, tok.count);
  if (/tapped/.test(desc)) made.forEach((i) => (card(i).tapped = true));
  did.push(`creates ${tok.count} ${DB[defId].name} token${tok.count > 1 ? 's' : ''}`);
}

async function fetchLands(t, me, choose, src, did) {
  const lib = zoneOf(me, 'library');
  const basic = /basic/.test(t);
  const types = (t.match(/search your library for [^.]*?card/) || [''])[0].match(/forest|island|swamp|mountain|plains/g) || [];
  const m = t.match(/up to (\w+) (?:basic )?land cards?|up to (\w+) basic/);
  const count = m ? n(m[1] || m[2]) : /two basic land|two land/.test(t) ? 2 : 1;
  const cands = lib.map(card).filter((c) => {
    if (!isLand(c)) return false;
    if (basic && !/Basic/.test(DB[c.def].typeLine)) return false;
    if (types.length && !types.some((ty) => new RegExp(ty, 'i').test(DB[c.def].typeLine))) return false;
    return true;
  });
  if (!cands.length) {
    shuffle(me);
    did.push('finds no land');
    return;
  }
  let picks = await choose.pickCards({
    prompt: `Search your library for ${count > 1 ? 'up to ' + count : 'a'} ${basic ? 'basic ' : ''}${types.length ? types.join(' or ') : 'land'} card${count > 1 ? 's' : ''}`,
    cards: cands.map((c) => c.iid), min: 0, max: Math.min(count, cands.length), purpose: 'land', src,
    aiScore: (c) => (ctxNeeds(me, c) || 0) - (picksDupPenalty(c) || 0),
  });
  const onlyOneToField = /the other into your hand|put one onto the battlefield/.test(t);
  const toField = /onto the battlefield/.test(t);
  const tapped = /battlefield tapped/.test(t);
  let fieldPicks = picks;
  if (toField && onlyOneToField && picks.length > 1) {
    fieldPicks = await choose.pickCards({
      prompt: 'Choose the land to put onto the battlefield (the other goes to your hand)',
      cards: picks, min: 1, max: 1, purpose: 'land-field', src, aiScore: () => 0,
    });
  } else if (!toField) fieldPicks = [];
  for (const iid of picks) {
    if (fieldPicks.includes(iid)) toBattlefield(iid, me, { tapped });
    else move(iid, 'hand');
  }
  shuffle(me);
  if (picks.length) did.push(`searches for ${picks.map((i) => nameTag(card(i))).join(' and ')}`);
}

// AI land-choice helpers (filled in by ai.js so the AI can pick the colors it needs)
export const aiHelpers = { landScore: () => 0 };
const ctxNeeds = (me, c) => (me === 'ai' ? aiHelpers.landScore(c) : 0);
const picksDupPenalty = () => 0;

async function tutor(t, me, choose, src, did) {
  const m = t.match(/search your library for (?:a|an) ([^.]*?)card/);
  const phrase = m ? m[1] : '';
  const lib = zoneOf(me, 'library').map(card).filter((c) => {
    if (/creature/.test(phrase) && !isType(c, 'Creature')) return false;
    if (/artifact/.test(phrase) && !isType(c, 'Artifact')) return false;
    if (/enchantment/.test(phrase) && !isType(c, 'Enchantment')) return false;
    if (/instant or sorcery/.test(phrase) && !/Instant|Sorcery/.test(DB[c.def].typeLine)) return false;
    return true;
  });
  const picks = await choose.pickCards({
    prompt: `Search your library for ${phrase ? 'a ' + phrase.trim() : 'a'} card`, cards: lib.map((c) => c.iid),
    min: 0, max: 1, purpose: 'tutor', src, aiScore: (c) => (isLand(c) ? -5 : DB[c.def].cmc),
  });
  const dest = /onto the battlefield/.test(t) ? 'battlefield' : /on top of your library|on top\b/.test(t) ? 'top' : 'hand';
  for (const iid of picks) {
    shuffle(me);
    if (dest === 'battlefield') toBattlefield(iid, me);
    else if (dest === 'top') move(iid, 'library');
    else move(iid, 'hand');
    did.push(me === 'p' ? `tutors ${nameTag(card(iid))}` : 'tutors a card');
  }
  if (!picks.length) shuffle(me);
}

// ------------------------------------------------------------ auras & equipment
export async function attachAura(aura, me, choose) {
  const o = oracle(aura);
  if (!/^Enchant creature/m.test(o)) return [];
  const buff = o.match(/Enchanted creature gets ([+-]\d+)\/([+-]\d+)/i);
  const lock = /Enchanted creature can't attack|Enchanted creature can't block|Enchanted creature doesn't untap/i.test(o);
  const cands = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter((c) => isCreature(c) && canTarget(c, me));
  const pick = await choose.target({
    prompt: `Choose a creature to enchant with ${cardName(aura)}`, candidates: cands.map((c) => c.iid),
    harm: lock || (buff && +buff[1] < 0), src: aura, optional: !cands.length,
  });
  if (!pick || !pick.iid) return [];
  const t = card(pick.iid);
  attachTo(aura, t);
  return [`enchants ${whose(t)} ${nameTag(t)}`];
}

export function attachTo(src, t) {
  const o = oracle(src);
  // drop a previous attachment
  if (src.attachedTo && card(src.attachedTo)) {
    const old = card(src.attachedTo);
    if (old.auraBuffs) delete old.auraBuffs[src.iid];
    if (old.pacifiedBy === src.iid) old.pacifiedBy = null;
  }
  src.attachedTo = t.iid;
  const buff = o.match(/(?:Enchanted|Equipped) creature gets ([+-]\d+)\/([+-]\d+)/i);
  const kws = (o.match(/(?:Enchanted|Equipped) creature (?:gets [+-]\d+\/[+-]\d+ and )?(?:has|gains) ([a-z, ]+?)(?:\.|$)/im) || [])[1];
  if (buff || kws) {
    t.auraBuffs = t.auraBuffs || {};
    t.auraBuffs[src.iid] = { p: buff ? +buff[1] : 0, t: buff ? +buff[2] : 0, grants: kws ? kwList(kws.toLowerCase()) : [] };
  }
  if (/Enchanted creature can't attack|Enchanted creature can't block|Enchanted creature doesn't untap/i.test(o)) t.pacifiedBy = src.iid;
}
