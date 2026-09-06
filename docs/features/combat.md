# Combat

Attack, reinforce, recall, hidden rallies, live battle rounds. UI: Map territory panel + battle popup.

## Intent

Neutral hexes still resolve in one click: **more bodies win**, no dice. Faction-owned hexes use a **hidden rally** then **live rounds** so allies can pile in. Attack/defense territory bonuses change round damage; they do not flip the “more troops” rule on neutrals. Capitals stay unconquerable. Two people resolving the same hex must not race: one `409`s.

## Player sees

- **Attack** on adjacent enemy/neutral hexes: troop steppers, then Attack.
- Neutral: instant outcome popup (victory / held).
- Faction-owned: `/game/attack` starts or joins a **hidden rally** (10 minutes). Allies can add troops. Launch turns it into a live battle (1-minute rounds, 20-minute cap, then 30-minute protection).
- **Reinforce** on own hexes; **Recall** if this player has troops stationed there (blocked during an active live battle).
- Contested hexes grant **no** faction bonuses until the live battle ends.

## Rules

### Neutral (instant)

- Victory iff `attackers > defenders` (`calculateBattleOutcome`). Survivors become the only garrison; loot +25 food/wood/iron.
- Stationed casualties: proportional (`defender-garrisons.js`). Concurrent lock: `pg_try_advisory_xact_lock` → `409`.

### Faction hexes (rally + live rounds)

- `startOrJoinRally` in `rally-battles.js`. Hidden prep `RALLY_PREPARATION_MS` (10 min). Live rounds `BATTLE_ROUND_MS` (60s), duration `BATTLE_DURATION_MS` (20 min), then protection `BATTLE_PROTECTION_MS` (30 min).
- Each round: simultaneous 10% casualties from **starting** counts (`calculateBattleRound` in `battle-rules.js`). Attack bonus increases damage dealt by attackers; defense bonus increases damage dealt by defenders; both capped at 25%.
- Tick loop every 5s (`startRallyResolutionLoop`). `resolve-battle.js` applies due rounds — this is live, not the old unused player-facing resolve button.

## Edges

- Client `canAttack` is display-only; server repeats every check.
- `POST /game/resolve-battle` as a player action is unused; the server tick calls `resolveBattle` internally.
- Cannot attack own faction, capital, or non-adjacent.

## Tune

Timings live in `battle-rules.js` until they move to [`config/balance.json`](../../config/balance.json). Neutral loot is still +25/+25/+25 in `attack-logic.js`.

## API

`POST /game/attack` (neutral instant or rally join)  
`POST /game/launch-rally`  
`POST /game/defend|recall-defenders`  
`GET /game/battles`

## Code

BE: `src/core/battle-rules.js`, `src/core/rally-battles.js`, `src/core/attack-logic.js`, `src/core/resolve-battle.js`, `src/core/defender-garrisons.js`  
Tests: `test/live_battle_rules.test.js`, `test/rally_battles.test.js`, `test/attack_logic.test.js`  
FE: `launchAttack` (`/game/attack`), defend/recall, battle popup
