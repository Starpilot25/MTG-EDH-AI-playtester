// Dungeons: "venture into the dungeon" and the initiative (Undercity).
// Room text comes from the real dungeon cards on Scryfall and runs through the effect engine.
import { DB, fetchCards } from './data.js';
import { G, log, esc } from './state.js';
import { resolveEffects } from './effects.js';

export const DUNGEON_NAMES = ['Lost Mine of Phandelver', 'Dungeon of the Mad Mage', 'Tomb of Annihilation', 'Undercity'];
export const DUNGEONS = {}; // name -> {id, name, rooms: {roomName: {name, text, next:[]}}, first, order:[]}

export function parseRooms(oracle) {
  const rooms = {};
  const order = [];
  for (const raw of String(oracle || '').split('\n')) {
    const line = raw.trim();
    const m = line.match(/^(.+?) — (.+?)(?:\s*\(→\s*(.+?)\))?$/);
    if (!m) continue;
    const next = m[3] ? m[3].split(/\s+or\s+/).map((x) => x.trim()) : [];
    rooms[m[1].trim()] = { name: m[1].trim(), text: m[2].trim(), next };
    order.push(m[1].trim());
  }
  return { rooms, order, first: order[0] };
}

export async function loadDungeons() {
  const missing = DUNGEON_NAMES.filter((n) => !DUNGEONS[n]);
  if (!missing.length) return;
  try {
    const defs = await fetchCards(missing.map((name) => ({ name })));
    defs.forEach((d, i) => {
      if (!d) return;
      const parsed = parseRooms(d.faces[0].oracle);
      if (parsed.first) DUNGEONS[missing[i]] = { id: d.id, name: d.name, ...parsed };
    });
  } catch (e) {
    console.warn('Could not load dungeons', e);
  }
}

function dungeonSrc(pid, dg) {
  return { iid: 'dungeon-' + pid, def: dg.id, controller: pid, owner: pid, zone: 'command', counters: {}, face: 0 };
}

// Venture into the dungeon (or into Undercity for the initiative).
export async function venture(pid, ctx, opts = {}) {
  const pl = G.s.players[pid];
  const chooser = ctx.choosers[pid];
  const who = pid === 'p' ? 'You venture' : 'The AI ventures';
  // already in a dungeon? the initiative advances that one instead of starting Undercity
  let dg;
  if (!pl.dungeon) {
    const options = opts.undercity
      ? ['Undercity'].filter((n) => DUNGEONS[n])
      : DUNGEON_NAMES.filter((n) => n !== 'Undercity' && DUNGEONS[n]);
    if (!options.length) {
      log(pid, `${who} into the dungeon — dungeon cards couldn't be loaded from Scryfall, so track it by hand.`);
      return [];
    }
    const k = options.length === 1 ? 0 : await chooser.choose({
      prompt: 'Choose a dungeon to enter',
      options: options.map((n) => ({ label: n, detail: DUNGEONS[n].order.join(' → ') })),
      aiPick: () => Math.max(0, options.indexOf('Lost Mine of Phandelver')),
    });
    dg = DUNGEONS[options[k]];
    pl.dungeon = { name: dg.name, room: dg.first, visited: [dg.first] };
  } else {
    dg = DUNGEONS[pl.dungeon.name];
    const room = dg.rooms[pl.dungeon.room];
    let nextName = room.next[0];
    if (room.next.length > 1) {
      const k = await chooser.choose({
        prompt: `${dg.name}: choose the next room`,
        options: room.next.map((n) => ({ label: n, detail: dg.rooms[n] ? dg.rooms[n].text : '' })),
        aiPick: () => 0,
      });
      nextName = room.next[k];
    }
    pl.dungeon.room = nextName;
    pl.dungeon.visited.push(nextName);
  }
  const room = dg.rooms[pl.dungeon.room];
  log(pid, `${who} into ${esc(dg.name)}: <b>${esc(room.name)}</b> — ${esc(room.text)}`);
  ctx.render && ctx.render();
  const did = await resolveEffects(room.text, dungeonSrc(pid, dg), { ...ctx, me: pid, forced: true });
  if (did.length) log(pid, `${esc(room.name)}: ${did.join('; ')}.`);
  else log(pid, `${esc(room.name)}: apply “${esc(room.text)}” by hand.`);
  if (!room.next.length) {
    pl.dungeonsCompleted = (pl.dungeonsCompleted || 0) + 1;
    log(pid, `${pid === 'p' ? 'You complete' : 'The AI completes'} ${esc(dg.name)}.`);
    pl.dungeon = null;
  }
  return [`ventures into ${dg.name} (${room.name})`];
}

export async function takeInitiative(pid, ctx) {
  const had = G.s.initiative;
  G.s.initiative = pid;
  if (had !== pid) log(pid, `${pid === 'p' ? 'You take' : 'The AI takes'} the initiative.`);
  await venture(pid, ctx, { undercity: true });
}

export { DB };
