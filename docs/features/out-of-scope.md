# Out of scope

Do not port, revive, or “finish” these unless the user explicitly asks. They look like features; they are not.

## Dead client combat UI

- `script.js` `resolveSelectedTargetBattle` — players do not click to resolve. The server tick resolves live battles.

## Dead client persistence

- `saveGame`, `resetGame`, `autoSave` — the server already holds the world

## Dead / redundant API

- `POST /api/player/faction` — always 403 (tombstone so old clients fail closed)
- `GET /api/world`, `GET /api/player/state` — UI uses `GET /api/game/state` only
- `requireLeaderOrAdmin`, `isPlayerTerritoryAdjacentToTarget`, unused `getCurrentUtcDayBounds` import

## Soft-dead

- **Leader role** + `faction_leaders`: admin can set it; nothing in gameplay reads it. Port as-is or drop in a later phase (`docs/04-TODO.md` P6.1). Do not invent leader powers in the meantime.

## Live (do not treat as dead)

These shipped on original `origin/main` (indev merge). They **are** current logic:

- Hidden rallies + live battle rounds (`rally-battles.js`, `battle-rules.js`, `resolve-battle.js` used by the tick)
- Crownlands `attack` / `defense` bonuses as combat modifiers (capped 25%)
- Storage building, public activity, rotating maps, preseason gate

## Future (Info modal / INTENT)

Comeback systems, map events, extra season rewards, paid perks. Support donations must not become pay-to-win.
