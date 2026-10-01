# EDH Playtester

Play a 1v1 Commander game against an AI opponent to test your decks — a free-form tabletop in the style of the Moxfield playtester.

## Run it

You need **Node.js 18 or newer** (https://nodejs.org). No install step, no dependencies.

```
cd edh-playtester
node server.js
```

Then open **http://localhost:5173** in your browser. Stop the server with Ctrl+C.
(Use a different port with `PORT=8080 node server.js`.)

## Loading decks

- **Deck link** — paste a public Moxfield or Archidekt deck URL.
- **Paste list** — any plain-text export works (`1 Sol Ring`, `1x Sol Ring (CMR) 472`, a "Commander" section header, or `*CMDR*` after the commander).
- **Sample** — two built-in decks so you can try it right away.
- **Mirror** (AI only) — the AI plays a copy of your deck.

Partners, Partner with, Friends Forever, Doctor's companions and Backgrounds are supported: mark both commanders in your list (deck links do this automatically). If no commander is marked, one is picked from the list — a legend with a matching partner or Background if there is one — and you can change both from the dropdowns. Each commander has its own tax and its own commander-damage count (Backgrounds don't deal commander damage, so they get no counter).

> Moxfield sometimes blocks automated requests. If a Moxfield link fails, open the deck on Moxfield → **Export → Copy as plain text**, and use **Paste list**.

Card data and images come from Scryfall.

## Arena-style casting (on by default)

When you cast a spell — double-click it, drag it onto the battlefield, or right-click → Cast — the playtester works like MTG Arena:

- **Mana is paid for you.** Your untapped lands, mana rocks and dorks are tapped automatically, commander tax included. Spells with X ask for X (it suggests the most you can afford). If you can't pay, it asks whether to cast anyway.
- **Targets light up.** Legal targets glow; click one. Burn spells also offer *Target the AI* / *Target yourself* (or click a life total). Hexproof, shroud and "an opponent controls" are respected.
- **Choices open a picker.** Land searches (Cultivate puts one on the battlefield and one in hand), tutors, returning cards from the graveyard, scry and surveil.
- **The effect happens.** Removal, burn, board wipes, mass damage, card draw, tokens, life gain and drain, ramp, reanimation, edicts (the AI picks what it sacrifices), +1/+1 counters, until-end-of-turn pumps like Overrun, Auras and enter-the-battlefield triggers.
- **Abilities on permanents** show up at the top of the right-click menu: planeswalker loyalty abilities, Equip (pick the creature), and activated abilities like "{2}, {T}, Sacrifice: draw a card" — costs are paid automatically.
- **Changed your mind?** Press Esc or *Cancel* while choosing and the whole spell is rolled back.

You can also cast instants while the AI casts a spell or attacks you (combat tricks, removal in response).

**Triggered abilities fire on their own** — yours and the AI's:

- combat damage: "Whenever ~ deals combat damage to a player…" (Norman Osborn connives, Ninjas, Rogues), "Whenever a creature you control deals combat damage…", "Whenever one or more creatures you control deal combat damage…"
- attacking: "Whenever ~ attacks…", "Whenever a creature you control attacks…", "Whenever you attack…"
- dying: "When ~ dies…", "Whenever another creature dies…" (Blood Artist and friends)
- upkeep, beginning of combat, end step and main-phase triggers (Phyrexian Arena)
- landfall, and "Whenever you cast a (noncreature / instant or sorcery…) spell"

"That player" means the player who was hit. "You may" asks you first. Connive, loot ("draw, then discard"), investigate, transform, discard, mill, and +1/+1 counters or pumps on the creature itself are all handled. Treasure, Clue and Food tokens come with their abilities.
Effects the engine doesn't understand are noted in the log so you can apply them by hand. To play it purely as a tabletop, untick *Arena-style casting* on the setup screen or in the ☰ menu; right-click → *Put onto battlefield (no cost)* skips it for one card.

## Playing

| Action | How |
| --- | --- |
| Play a card | Drag it to the battlefield, or double-click it |
| Tap / untap | Click a card on your battlefield |
| Card options | Right-click any card (counters, flip, face down, P/T modifiers, token copy, move to zone) |
| Library options | Right-click your library: draw X, scry, surveil, mill, look at top X, search, exile top… |
| Browse a zone | Click a graveyard or exile pile |
| Your removal on the AI | Right-click an AI permanent → Destroy / Exile / Bounce / Damage / Gain control |
| Attack | **To combat**, click your creatures, **Attack**; the AI blocks; **Deal damage** |
| Block | When the AI attacks, click your creature, then the attacker; **Confirm blocks** |
| Counter an AI spell | When the AI casts something, choose **Counter it** (or **Let it resolve**) |
| Fix anything | Life totals, poison, commander damage all have +/−; Undo / Redo (Ctrl+Z / Ctrl+Shift+Z) |

Shortcuts: `Enter` next step · `Shift+Enter` pass turn · `D` draw · `U` untap all · `S` shuffle · `C` create token · `L` search library · hover a card + `T` tap, `G` graveyard, `X` exile, `H` hand, `B` library bottom, `F` flip, `=`/`-` +1/+1 counter · `?` all shortcuts.

Commander rules handled for you: 40 life, commander tax, commanders return to the command zone, 21 commander damage, poison, London mulligan (first one free by default).

## How the AI plays

The AI runs in your browser — no account or API key. Each turn it:

1. plays the land that best fixes its colors,
2. taps its lands, rocks and dorks to cast the best spell it can afford (commander, ramp early, removal when you have a threat, board wipes only when it's behind, big threats otherwise), repeating while it has mana,
3. uses planeswalker abilities it understands,
4. attacks when its creatures survive or trade well, goes all-in when it sees lethal, and keeps blockers home when you threaten it,
5. blocks to eat attackers, trade evenly, or chump when it would otherwise die.

It reads oracle text to automate common effects: draw, destroy/exile/bounce, damage, board wipes, tokens, life gain and drain, land searches, reanimation, edicts, +1/+1 counters, and buff/lockdown auras. Anything it can't automate is noted in the game log so you can apply it by hand — the table is free-form, so you can always move, tap or adjust anything.

## Files

```
server.js          local server + proxy for Moxfield, Archidekt and Scryfall
public/index.html  the page
public/css/        styles
public/js/data.js  decklist parsing, deck import, card data, sample decks
public/js/rules.js mana payment, power/toughness, keywords, combat damage
public/js/state.js game state, zones, undo
public/js/game.js  turn structure and combat flow
public/js/ai.js    the AI opponent
public/js/ui.js    the tabletop UI
public/js/main.js  setup screen and mulligans
```
