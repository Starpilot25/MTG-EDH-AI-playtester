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

Card data and images come from Scryfall. Digital-only printings (such as the Arena *Through the Omenpaths* versions of Spider-Man cards) are swapped for the paper printing so the art matches the real card.

## Arena-style casting (on by default)

When you cast a spell — double-click it, drag it onto the battlefield, or right-click → Cast — the playtester works like MTG Arena:

- **Mana is paid for you.** Your untapped lands, mana rocks and dorks are tapped automatically, commander tax included. Spells with X ask for X (it suggests the most you can afford). If you can't pay, it asks whether to cast anyway.
- **Targets light up.** Legal targets glow; click one. Burn spells also offer *Target the AI* / *Target yourself* (or click a life total). Hexproof, shroud and "an opponent controls" are respected.
- **Choices open a picker.** Land searches (Cultivate puts one on the battlefield and one in hand), tutors, returning cards from the graveyard, scry and surveil.
- **The effect happens.** Removal, burn, board wipes, mass damage, card draw, tokens, life gain and drain, ramp, reanimation, edicts (the AI picks what it sacrifices), +1/+1 counters, until-end-of-turn pumps like Overrun, Auras and enter-the-battlefield triggers.
- **Abilities on permanents** show up at the top of the right-click menu: planeswalker loyalty abilities, Equip (pick the creature), and activated abilities like "{2}, {T}, Sacrifice: draw a card" — costs are paid automatically.
- **Changed your mind?** Press Esc or *Cancel* while choosing and the whole spell is rolled back.

**Timing and counterspells work like Arena.** On the AI's turn — while it casts a spell or attacks you — you can only cast instants and flash cards, and the ones you can afford glow green. To counter an AI spell you need a real counterspell: cast it in response and it counters the spell on the stack (filters like "noncreature spell" and "unless its controller pays {3}" are respected). Sorceries and other cards wait for your main phase. The AI plays by the same rules: if it holds a counterspell and the mana, it may counter your important spells.

**The legend rule** applies to both players. If you end up with two legendary permanents with the same name (including legendary token copies), you pick which one to keep; the AI keeps the one with counters or equipment on it. Exceptions are handled: Mirror Gallery, "the legend rule doesn't apply to permanents you control" (Sakashima of a Thousand Faces, Mirror Box), Brothers Yamazaki, and token copies made "except it isn't legendary". Token-copy effects ("create a token that's a copy of target creature…") work, and the right-click menu offers a normal or non-legendary token copy.

**Dungeons and the initiative.** "Venture into the dungeon" lets you pick Lost Mine of Phandelver, Dungeon of the Mad Mage or Tomb of Annihilation, then choose a branch at each fork; every room's effect resolves. "Take the initiative" ventures into Undercity, again at each of your upkeeps, and the initiative moves to whoever deals combat damage to its holder. Your current room shows under your life total — click it to see the whole dungeon. Room text is loaded from the real dungeon cards on Scryfall.

**Triggered abilities fire on their own** — yours and the AI's:

- combat damage: "Whenever ~ deals combat damage to a player…" (Norman Osborn connives, Ninjas, Rogues), "Whenever a creature you control deals combat damage…", "Whenever one or more creatures you control deal combat damage…"
- attacking: "Whenever ~ attacks…", "Whenever a creature you control attacks…", "Whenever you attack…"
- dying: "When ~ dies…", "Whenever another creature dies…" (Blood Artist and friends)
- upkeep, beginning of combat, end step and main-phase triggers (Phyrexian Arena)
- landfall, and "Whenever you cast a (noncreature / instant or sorcery…) spell"

"That player" means the player who was hit. "You may" asks you first. Connive, loot ("draw, then discard"), investigate, transform, discard, mill, and +1/+1 counters or pumps on the creature itself are all handled. Treasure, Clue and Food tokens come with their abilities.
Effects the engine doesn't understand are noted in the log so you can apply them by hand. To play it purely as a tabletop, untick *Arena-style casting* on the setup screen or in the ☰ menu; right-click → *Put onto battlefield (no cost)* skips it for one card.

## Game mechanics

Keyword abilities and actions from across Magic's history are built in (Un-set mechanics are not). Anything printed as one-off rules text that the engine doesn't understand is noted in the log so you can apply it by hand.

**Ways to cast.** When a card can be played more than one way, double-clicking it asks which: adventures (the card goes on an adventure, then you cast the creature from exile), split cards and fuse, modal double-faced cards (either side, including the land side), omens, and alternative costs — dash, evoke, blitz, bestow, prototype, mutate, surge, spectacle, prowl, emerge, overload, awaken, impending, warp, freerunning, web-slinging, sneak, and casting face down for {3} (morph, megamorph, disguise). From the graveyard: flashback, escape, jump-start, retrace, aftermath, disturb, harmonize, mayhem and "you may cast this from your graveyard". From exile: foretold and plotted cards, adventures, impulse draw ("you may play it this turn"), hideaway and suspend. Companions start outside the game — pay {3} at sorcery speed to put yours into your hand (right-click it in the command zone).

**Extra costs and cost changes.** Kicker and multikicker, buyback, entwine, escalate, spree, tiered, replicate, squad, offspring, gift, bargain, casualty and "as an additional cost…" (sacrifice, discard, pay life, exile from your graveyard, collect evidence, forage, tap creatures…) are asked for as you cast. Cost reductions are applied automatically: convoke, delve and improvise (your creatures, graveyard and artifacts help pay), affinity, undaunted, "this spell costs {1} less for each…", commander tax, and Thalia- and Helm-style effects. Your mana pool is shown under your life total and empties between steps.

**On the stack.** Storm, cascade, replicate and casualty copies, split second (no one can respond), "can't be countered", rebound, cipher, madness and miracle.

**Abilities.** The right-click menu lists equip, reconfigure, crew, saddle, station, level up, Class levels, loyalty abilities and activated abilities; from your hand, cycling and landcycling, channel, bloodrush, ninjutsu, transmute, reinforce, forecast, foretell, plot and suspend; from your graveyard, unearth, embalm, eternalize, scavenge, encore and dredge. Face-down creatures can be turned face up for their morph or disguise cost.

**Turn by turn.** Phasing, day and night (it flips when a turn passes with no spells, or two or more), echo, cumulative upkeep, vanishing, fading, impending, suspend counters, the monarch (draw at your end step; combat damage steals it), extra turns and extra combats, goad and "attacks each combat if able", provoke, and the end-step clean-ups for dash, blitz, unearth, warp and tokens that are sacrificed or exiled at the next end step.

**Combat.** You can attack the AI's planeswalkers and battles — when there's a choice, *Attack* asks what each creature attacks — and the AI does the same to yours. First strike and double strike, trample, deathtouch, lifelink, infect, wither, toxic, menace, flying/reach, protection, shield counters, fog effects, and the attack and block triggers (exalted, annihilator, battle cry, melee, bushido, rampage, flanking, afflict, training, mentor, enlist, renown, frenzy, mobilize, decayed…) all work.

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
| Counter an AI spell | When the AI casts something, double-click a glowing counterspell in your hand (or **Let it resolve**). With Arena-style casting off, a manual **Counter it** button appears instead |
| Fix anything | Life totals, poison, commander damage all have +/−; Undo / Redo (Ctrl+Z / Ctrl+Shift+Z) |

Shortcuts: `Enter` next step · `Shift+Enter` pass turn · `D` draw · `U` untap all · `S` shuffle · `C` create token · `L` search library · hover a card + `T` tap, `G` graveyard, `X` exile, `H` hand, `B` library bottom, `F` flip, `=`/`-` +1/+1 counter · `?` all shortcuts.

Commander rules handled for you: 40 life, commander tax, commanders return to the command zone, 21 commander damage, poison, London mulligan (first one free by default).

## How the AI plays

The AI runs in your browser — no account or API key.

- **It knows what matters.** Every permanent gets a threat score (power, evasion, deathtouch, infect, lifelink, engines and anthems, planeswalker loyalty, commanders close to 21 damage). Removal, burn and counterspells go after the biggest threat, and burn goes to your face when it's lethal.
- **It simulates combat.** First strike, double strike, deathtouch, trample, indestructible and infect are played out before it decides. It blocks to eat attackers, double-blocks big ones, trades when it's worth it, and only chump-blocks when the damage would actually kill it (or give you commander lethal).
- **It attacks like a player.** It predicts how you'll block, weighs the damage and trades against the swing back on its next turn, goes all-in for lethal, sends spare attackers at your planeswalkers, and keeps blockers home when your counter-attack would kill it.
- **It plans its mana.** Each main phase it picks the best set of spells it can afford rather than just the biggest one, plays ramp first, and leaves mana open for a counterspell or instant-speed removal it's holding (it still taps out for a bomb).
- **It plays at instant speed on your turn.** When you attack it can kill your biggest attacker, flash in a blocker, or fog a lethal attack; after blocks it pumps a blocker to win the fight; when you block its creatures it pumps an attacker or removes a blocker; and at the end of your turn it casts flash creatures, card draw and leftover removal, and uses its abilities. You can respond to anything it casts.
- **Everything else:** it plays the land that best fixes its colors, picks the best planeswalker ability (removal when you have a threat, tokens and card draw otherwise, the ultimate when it can), levels Classes, flips morphs, equips, crews vehicles, and cycles or unearths spare cards.

Anything it can't automate is noted in the game log so you can apply it by hand — the table is free-form, so you can always move, tap or adjust anything.

## Files

```
server.js          local server + proxy for Moxfield, Archidekt and Scryfall
public/index.html  the page
public/css/        styles
public/js/data.js  decklist parsing, deck import, card data, sample decks
public/js/rules.js mana payment, power/toughness, keywords, combat damage
public/js/statics.js anthems, cost changes, replacement effects
public/js/state.js game state, zones, undo
public/js/effects.js rules-text interpreter (what spells and abilities do)
public/js/triggers.js triggered and keyword abilities
public/js/cast.js  casting, alternative and additional costs, abilities, special actions
public/js/dungeon.js dungeons and the initiative
public/js/game.js  turn structure, turn-based keywords and combat flow
public/js/ai.js    the AI opponent (spell choice, instant-speed play)
public/js/aicombat.js threat scores, combat simulator, attack and block planning
public/js/ui.js    the tabletop UI
public/js/main.js  setup screen and mulligans
```
