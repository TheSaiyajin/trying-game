# Seasons

The campaign clock. Screen: season gate. Scoreboard also lives on Map.

## Intent

A season is a timed war, not an endless lobby. People must **opt in** each season so a forgotten account does not sit in a faction. Factions stay even because join always fills the smallest. At the bell, prestige (`season_wins`) goes to the winning faction’s accounts, the world is wiped, and the **other map** loads. That rotation is the variety — not random generated maps.

## Player sees

**Gate (preseason, or not yet joined)**

- Title: season number, map name, registration open.
- Countdown until start (or until end once started but they still must join).
- Joined-player count. Join button. Confirmation once registered. Logout.

**In-game scoreboard (Map)**

- `Season N` + countdown to `endsAt`.
- Per faction: territory **count**, **points**, **member** count.

**Activity → Seasons:** completed campaigns (see [Activity](activity.md)).

## Rules

- Preseason `season.preseasonMs`, then season `season.durationMs`.
- `POST /season/join` is idempotent. Assignment uses an advisory lock; smallest faction wins ties by the server’s existing order.
- `players.faction` is a **cache**. `season_memberships` is authoritative. Keep them in sync; do not half-migrate.
- Gameplay routes: `409 SEASON_NOT_STARTED` or `403 SEASON_JOIN_REQUIRED`.
- Score = sum of owned hex `scoreValue`. Capitals score 0. Tie → `draw` (no prestige).
- Rollover: finalize → award wins → reseed world from next map key → new preseason row. Same code path as admin force-finish.
- Production and fortress ticks **do not run** in preseason.

## Edges

- Force-finishing mid-day must still create the **next** `season_number` (never reuse today’s number).
- `GET /game/state` before join returns an empty world on purpose so the client can show the gate.
- Countdowns should prefer `serverTime` from the snapshot over the browser clock when both exist (contract); the vanilla client currently uses `Date.now()` against `endsAt`.

## Tune

`config/balance.json` → `season.*`, `scoring.*`, `economy.starting*`

## API

[`05-API-CONTRACT.md`](../05-API-CONTRACT.md) — Season, pre-join snapshot.

## Code

BE: `backend/season.js` (`ensureCurrentSeason`, `ensurePlayerFactionAssignment`, `runSeasonRollover`)  
FE: `showSeasonGate`, `joinSeason`, `renderScoreboard`, `tickScoreboardCountdown`
