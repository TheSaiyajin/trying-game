# City & economy

Private city that funds the war. Screen: City. Resource bar is global ([Shell](shell.md)).

## Intent

Everyone starts equal each season. Growth comes from **time + upgrades + faction land**, not from logging in more often than others: the tick runs for everyone, and offline catch-up is capped so a week AFK does not dump a stockpile. Fortress troops fill the **city reserve only**, so parking armies on the map does not freeze generation.

## Player sees

- **Faction bonuses** card: fortress reserve `n/cap · Active|Paused`, then only bonuses that are > 0 (production %, training discount, storage, fortress/min, all-resources).
- Four building cards plus storage: name, level, current production/min (storage has none), upgrade cost, Upgrade button.
- Train block: discount %, live cost, steppers −10/−1/input/+1/+10, Train, city soldier count.

Production numbers on the cards come from the **snapshot** (`player.production`), not from the client re-simulating the world.

## Rules

- Four production buildings (farm, lumber, iron, barracks) plus **storage**. Upgrade cost uses `nextLevel * 1.4^(nextLevel-2)`, ceil, max level 10.
- Train cost = ceil(`50/25/20` food/iron/manpower × amount × max(0.4, 1 − trainingBonus)).
- Tick every `tickIntervalMs` for **all** players with a faction. Catch-up on snapshot read, cap `offlineCapSeconds`, whole minutes only.
- Storage: `baseStorageCap × (1 + storage bonus)`. Over-cap stock is kept; **new** gain is clipped.
- Fortresses the faction owns: `+troopsPerOwnedFortressPerMinute` each, into city `soldiers`, until `passiveTroopCap`. Training may go above that cap.
- No faction → resources/soldiers reset to `economy.starting` on tick/catch-up (pre-join / mid-reset).

## Edges

- Client `calculateTrainingCost` / building `defs` **duplicate** `balance.json`. Display can drift; server rejects unaffordable actions. Next.js must import the JSON.
- `GET /game/state` is what applies offline earnings — opening the app is enough; sitting on City is not required.
- Train max per request `training.maxPerRequest`.

## Tune

[`config/balance.json`](../../config/balance.json) → `economy.*`

## API

`GET /game/state`, `POST /game/upgrade-building`, `POST /game/train-soldiers`

## Code

BE: `backend/game-logic.js`, `applyOfflineResourceEarnings`, `runGlobalResourceTick`  
FE: `renderCity`, `renderFactionBonuses`, `trainSoldiers`, `upgradeBuilding`, `changeTrain`
