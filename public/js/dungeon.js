// Dungeons: "venture into the dungeon" and the initiative (Undercity).
// Room text comes from the real dungeon cards on Scryfall and runs through the effect engine.
import { DB, fetchCards } from './data.js';
import { G, log, esc, cardsIn } from './state.js';
import { oracle, isCreature } from './rules.js';
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

// The four dungeons, room by room. Built in so venturing never depends on how Scryfall formats the card text.
const ROOMS = {
  'Lost Mine of Phandelver': [
    ['Cave Entrance', 'Scry 1.', ['Goblin Lair', 'Mine Tunnels']],
    ['Goblin Lair', 'Create a 1/1 red Goblin creature token.', ['Storeroom', 'Dark Pool']],
    ['Mine Tunnels', 'Create a Treasure token.', ['Dark Pool', 'Fungi Cavern']],
    ['Storeroom', 'Put a +1/+1 counter on target creature.', ['Temple of Dumathoin']],
    ['Dark Pool', 'Each opponent loses 1 life and you gain 1 life.', ['Temple of Dumathoin']],
    ['Fungi Cavern', 'Target creature gets -4/-0 until your next turn.', ['Temple of Dumathoin']],
    ['Temple of Dumathoin', 'Draw a card.', []],
  ],
  'Dungeon of the Mad Mage': [
    ['Yawning Portal', 'You gain 1 life.', ['Dungeon Level']],
    ['Dungeon Level', 'Scry 1.', ['Goblin Bazaar', 'Twisted Caverns']],
    ['Goblin Bazaar', 'Create a Treasure token.', ['Lost Level']],
    ['Twisted Caverns', "Target creature can't attack until your next turn.", ['Lost Level']],
    ['Lost Level', 'Scry 2.', ['Runestone Caverns', "Muiral's Graveyard"]],
    ['Runestone Caverns', 'Exile the top two cards of your library. You may play them.', ['Deep Mines']],
    ["Muiral's Graveyard", 'Create two 1/1 black Skeleton creature tokens.', ['Deep Mines']],
    ['Deep Mines', 'Scry 3.', ["Mad Wizard's Lair"]],
    ["Mad Wizard's Lair", 'Draw three cards and reveal them. You may cast one of them without paying its mana cost.', []],
  ],
  'Tomb of Annihilation': [
    ['Trapped Entry', 'Each player loses 1 life.', ['Veils of Fear', 'Oubliette']],
    ['Veils of Fear', 'Each player loses 2 life unless they discard a card.', ['Sandfall Cell']],
    ['Sandfall Cell', 'Each player loses 2 life unless they sacrifice an artifact, a creature, or a land.', ['Cradle of the Death God']],
    ['Oubliette', 'Discard a card and sacrifice an artifact, a creature, and a land.', ['Cradle of the Death God']],
    ['Cradle of the Death God', 'Create The Atropal, a legendary 4/4 black God Horror creature token with deathtouch.', []],
  ],
  Undercity: [
    ['Secret Entrance', 'Search your library for a basic land card, reveal it, put it into your hand, then shuffle.', ['Forge', 'Lost Well']],
    ['Forge', 'Put two +1/+1 counters on target creature.', ['Trap!', 'Arena']],
    ['Lost Well', 'Scry 2.', ['Arena', 'Stash']],
    ['Trap!', 'Target player loses 5 life.', ['Archives']],
    ['Arena', 'Goad target creature.', ['Archives', 'Catacombs']],
    ['Stash', 'Create a Treasure token.', ['Catacombs']],
    ['Archives', 'Draw a card.', ['Throne of the Dead Three']],
    ['Catacombs', 'Create a 4/1 black Skeleton creature token with menace.', ['Throne of the Dead Three']],
    ['Throne of the Dead Three', 'Reveal the top ten cards of your library. Put a creature card from among them onto the battlefield with three +1/+1 counters on it. It gains hexproof until your next turn. Then shuffle.', []],
  ],
};
function builtIn(name) {
  const rows = ROOMS[name];
  const rooms = {};
  for (const [n, text, next] of rows) rooms[n] = { name: n, text, next };
  return { rooms, order: rows.map((r) => r[0]), first: rows[0][0] };
}

export async function loadDungeons() {
  const missing = DUNGEON_NAMES.filter((n) => !DUNGEONS[n]);
  if (!missing.length) return;
  // the card itself (for its image); the rooms always come from the built-in list
  let defs = [];
  try {
    defs = await fetchCards(missing.map((name) => ({ name })));
  } catch (e) {
    console.warn('Could not load dungeon cards', e);
  }
  missing.forEach((name, i) => {
    let d = (defs || []).find((x) => x && x.name === name) || null;
    if (!d) {
      const id = 'dungeon-def-' + name.replace(/\W+/g, '-');
      if (!DB[id]) DB[id] = { id, name, layout: 'normal', cmc: 0, manaCost: '', typeLine: 'Dungeon', colors: [], ci: [], keywords: [], produced: [], tokens: [], faces: [{ name, manaCost: '', typeLine: 'Dungeon', oracle: '', img: null, imgLarge: null }] };
      d = DB[id];
    }
    DUNGEONS[name] = { id: d.id, name, ...builtIn(name) };
  });
}

function dungeonSrc(pid, dg) {
  return { iid: 'dungeon-' + pid, def: dg.id, controller: pid, owner: pid, zone: 'command', counters: {}, face: 0 };
}

// Venture into the dungeon (or into Undercity for the initiative).
export async function venture(pid, ctx, opts = {}) {
  if (DUNGEON_NAMES.some((n) => !DUNGEONS[n])) await loadDungeons();
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
  const times = 1 + roomExtraTriggers(pid);
  try {
    for (let k = 0; k < times; k++) {
      let did = [];
      try {
        did = await resolveEffects(room.text, dungeonSrc(pid, dg), { ...ctx, me: pid, forced: true });
      } catch (e) {
        // a room you back out of still counts as visited
        console.warn('room ability', e);
      }
      const again = k ? ' (again)' : '';
      if (did.length) log(pid, `${esc(room.name)}${again}: ${did.join('; ')}.`);
      else log(pid, `${esc(room.name)}${again}: apply “${esc(room.text)}” by hand.`);
    }
  } finally {
    // the last room: the dungeon is completed (Safana, Acererak and friends count these)
    if (!room.next.length && pl.dungeon && pl.dungeon.name === dg.name) {
      pl.dungeonsCompleted = (pl.dungeonsCompleted || 0) + 1;
      log(pid, `${pid === 'p' ? 'You complete' : 'The AI completes'} ${esc(dg.name)}.`);
      pl.dungeon = null;
    }
  }
  return [`ventures into ${dg.name} (${room.name})`];
}

// Hama Pashar: "Room abilities of dungeons you own trigger an additional time."
// Dungeon Delver: commander creatures you own have that ability (one extra per commander creature out).
export function roomExtraTriggers(pid) {
  let n = 0;
  const bf = cardsIn(pid, 'battlefield');
  const cmdCreatures = bf.filter((c) => c.isCommander && c.owner === pid && isCreature(c)).length;
  for (const c of bf) {
    const o = oracle(c);
    if (/Commander creatures you own have "Room abilities of dungeons you own trigger an additional time/i.test(o)) n += cmdCreatures;
    else if (/(?:^|\n)Room abilities of dungeons you own trigger an additional time/i.test(o)) n += 1;
  }
  return n;
}

export async function takeInitiative(pid, ctx) {
  const had = G.s.initiative;
  G.s.initiative = pid;
  if (had !== pid) log(pid, `${pid === 'p' ? 'You take' : 'The AI takes'} the initiative.`);
  await venture(pid, ctx, { undercity: true });
}

export { DB };
