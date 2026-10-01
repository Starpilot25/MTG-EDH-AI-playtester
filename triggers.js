// Triggered abilities: "Whenever ~ deals combat damage to a player…", "Whenever ~ attacks…",
// "At the beginning of your upkeep…", "Whenever a creature dies…", landfall, cast triggers.
// Game code queues events (state.queueEvent / fire); settle() resolves every matching trigger.
import { DB } from './data.js';
import { isCreature, isLand, isType, oracle, face } from './rules.js';
import { G, card, cardsIn, log, nameTag, eventQueue, queueEvent, stateBased, cardName } from './state.js';
import { resolveEffects, stripName, knownEffect, Cancelled } from './effects.js';

// Filled in by ui.js: choosers for both players, a yes/no prompt for "you may", and render.
export const T = {
  choosers: null,
  confirm: async () => true,
  render: () => {},
};

export const fire = (ev) => queueEvent(ev);

// Parse a permanent's triggered abilities into {event, text, optional, filter}
export function triggersOf(c, defOverride) {
  const d = DB[defOverride || c.def];
  const f = d.faces[c.face || 0] || d.faces[0];
  let text = stripName(f.oracle || '', { ...c, def: d.id });
  text = text.replace(/\([^)]*\)/g, '');
  const out = [];
  for (let line of text.split('\n')) {
    line = line.trim().replace(/^[A-Z][A-Za-z' ]{2,30} — (?=When|At)/, ''); // ability words: "Landfall — …"
    let m;
    const add = (event, effect, extra = {}) =>
      out.push({ event, text: effect.trim(), optional: /^you may\b/i.test(effect.trim()), raw: line, ...extra });
    if ((m = line.match(/^Whenever ~ deals (?:combat )?damage to (?:a player|an opponent|one or more players|a player or planeswalker)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[1], { self: true });
    else if ((m = line.match(/^Whenever (?:a|another) creature you control deals combat damage to (?:a player|an opponent)[^,]*, (.+)$/i)))
      add('combatDamagePlayer', m[1], { anyOfMine: true });
    else if ((m = line.match(/^Whenever one or more (?:other )?creatures you control deal combat damage to (?:a player|an opponent|one or more players)[^,]*, (.+)$/i)))
      add('combatDamageOnce', m[1]);
    else if ((m = line.match(/^Whenever ~ (?:enters or attacks|attacks or blocks|attacks)[^,]*, (.+)$/i)))
      add('attacks', m[1], { self: true });
    else if ((m = line.match(/^Whenever (?:a|another) creature you control attacks[^,]*, (.+)$/i)))
      add('attacks', m[1], { anyOfMine: true });
    else if ((m = line.match(/^Whenever you attack[^,]*, (.+)$/i)))
      add('youAttack', m[1]);
    else if ((m = line.match(/^At the beginning of (your|each) upkeep, (.+)$/i)))
      add('upkeep', m[2], { each: m[1].toLowerCase() === 'each' });
    else if ((m = line.match(/^At the beginning of (?:combat on your turn|each combat), (.+)$/i)))
      add('beginCombat', m[1]);
    else if ((m = line.match(/^At the beginning of (your|each) end step, (.+)$/i)))
      add('endStep', m[2], { each: m[1].toLowerCase() === 'each' });
    else if ((m = line.match(/^At the beginning of your (?:precombat |first )?main phase, (.+)$/i)))
      add('mainPhase', m[1]);
    else if ((m = line.match(/^When(?:ever)? ~ dies, (.+)$/i)))
      add('dies', m[1], { self: true });
    else if ((m = line.match(/^Whenever ~ or another (nontoken )?creature (you control )?dies, (.+)$/i))) {
      add('dies', m[3], { self: true });
      add('dies', m[3], { other: true, nontoken: !!m[1], mine: !!m[2] });
    }
    else if ((m = line.match(/^Whenever (another|a) (nontoken )?creature you control dies, (.+)$/i)))
      add('dies', m[3], { mine: true, other: m[1] === 'another', nontoken: !!m[2] });
    else if ((m = line.match(/^Whenever (another|a) (nontoken )?creature (?:an opponent controls )?dies, (.+)$/i)))
      add('dies', m[3], { other: m[1] === 'another', nontoken: !!m[2], theirs: /an opponent controls/i.test(line) });
    else if ((m = line.match(/^Whenever a land (?:you control enters|enters(?: the battlefield)? under your control)[^,]*, (.+)$/i)))
      add('landfall', m[1]);
    else if ((m = line.match(/^Whenever you cast (?:a|an|your first) ([^,]*?)spell[^,]*, (.+)$/i)))
      add('cast', m[2], { spell: m[1].toLowerCase().trim() });
  }
  return out;
}

function spellMatches(filter, d) {
  const t = d.faces[0].typeLine;
  if (!filter) return true;
  if (/noncreature/.test(filter)) return !/Creature/.test(t);
  if (/instant or sorcery/.test(filter)) return /Instant|Sorcery/.test(t);
  if (/creature/.test(filter)) return /Creature/.test(t);
  if (/artifact/.test(filter)) return /Artifact/.test(t);
  if (/enchantment/.test(filter)) return /Enchantment/.test(t);
  if (/legendary/.test(filter)) return /Legendary/.test(t);
  return true;
}

// Which triggers does an event set off? Returns [{src, trig, thatPlayer}]
function matches(ev) {
  const out = [];
  const s = G.s;
  const onField = [...cardsIn('p', 'battlefield'), ...cardsIn('ai', 'battlefield')].filter((c) => !c.faceDown);
  const each = (fn) => {
    for (const c of onField) for (const trig of triggersOf(c)) fn(c, trig);
  };
  switch (ev.type) {
    case 'combatDamagePlayer':
      each((c, trig) => {
        if (trig.event !== 'combatDamagePlayer') return;
        if (trig.self && c.iid === ev.iid) out.push({ src: c, trig, thatPlayer: ev.player });
        else if (trig.anyOfMine && c.controller === ev.controller) out.push({ src: c, trig, thatPlayer: ev.player });
      });
      break;
    case 'combatDamageOnce':
      each((c, trig) => trig.event === 'combatDamageOnce' && c.controller === ev.controller && out.push({ src: c, trig, thatPlayer: ev.player }));
      break;
    case 'attacks':
      each((c, trig) => {
        if (trig.event !== 'attacks') return;
        if (trig.self && c.iid === ev.iid) out.push({ src: c, trig, thatPlayer: ev.defender });
        else if (trig.anyOfMine && c.controller === ev.controller) out.push({ src: c, trig, thatPlayer: ev.defender });
      });
      break;
    case 'youAttack':
      each((c, trig) => trig.event === 'youAttack' && c.controller === ev.controller && out.push({ src: c, trig, thatPlayer: ev.defender }));
      break;
    case 'upkeep':
    case 'beginCombat':
    case 'endStep':
    case 'mainPhase':
      each((c, trig) => {
        if (trig.event !== ev.type) return;
        if (trig.each || c.controller === ev.active) out.push({ src: c, trig });
      });
      break;
    case 'landfall':
      each((c, trig) => trig.event === 'landfall' && c.controller === ev.controller && out.push({ src: c, trig }));
      break;
    case 'cast':
      each((c, trig) => trig.event === 'cast' && c.controller === ev.controller && spellMatches(trig.spell, DB[ev.def]) && out.push({ src: c, trig }));
      break;
    case 'dies': {
      // the creature's own "when ~ dies" (it is in the graveyard now, or gone if a token)
      const dead = card(ev.iid) || { iid: ev.iid, def: ev.def, face: ev.face, controller: ev.controller, owner: ev.owner, zone: 'graveyard', counters: {}, token: ev.token };
      for (const trig of triggersOf(dead, ev.def)) if (trig.event === 'dies' && trig.self) out.push({ src: dead, trig, controller: ev.controller });
      each((c, trig) => {
        if (trig.event !== 'dies' || trig.self) return;
        if (trig.other && c.iid === ev.iid) return;
        if (trig.nontoken && ev.token) return;
        if (trig.mine && ev.controller !== c.controller) return;
        if (trig.theirs && ev.controller === c.controller) return;
        out.push({ src: c, trig });
      });
      break;
    }
  }
  void s;
  return out;
}

let running = false;

// Resolve everything waiting in the event queue (and anything those triggers cause).
export async function settle() {
  if (running || !T.choosers) return;
  running = true;
  const s0 = G.s;
  try {
    let guard = 0;
    while (eventQueue.length && guard++ < 200) {
      const ev = eventQueue.shift();
      if (G.s !== s0) break;
      for (const hit of matches(ev)) {
        const controller = hit.controller || hit.src.controller;
        // with Arena-style casting off, your own triggers are left to you (the log reminds you)
        if (controller === 'p' && !G.settings.arenaMode) {
          log('p', `${nameTag(hit.src)} triggers: <i>${hit.trig.text}</i>`);
          continue;
        }
        try {
          await resolveTrigger(hit, controller);
        } catch (e) {
          if (!(e instanceof Cancelled)) console.error(e);
        }
        if (G.s !== s0) return;
      }
    }
  } finally {
    running = false;
    if (G.s === s0) {
      stateBased();
      T.render();
    }
  }
}

async function resolveTrigger(hit, controller) {
  const { src, trig } = hit;
  let text = trig.text;
  if (trig.optional) {
    text = text.replace(/^you may /i, '');
    const yes = controller === 'ai' ? knownEffect(text) : await T.confirm(cardName(src), `${trig.raw.replace(/~/g, cardName(src))}\n\nDo it?`);
    if (!yes) return;
  }
  const ctx = { me: controller, choosers: T.choosers, forced: true, thatPlayer: hit.thatPlayer };
  const did = await resolveEffects(text, src, ctx);
  const who = controller === 'p' ? 'p' : 'ai';
  if (did.length) log(who, `${nameTag(src)} triggers: ${did.join('; ')}.`);
  else log(who, `${nameTag(src)} triggers: <i>${text.slice(0, 120)}</i> — apply it by hand.`);
  stateBased();
  T.render();
}

export { isCreature, isLand, isType, oracle, face };
