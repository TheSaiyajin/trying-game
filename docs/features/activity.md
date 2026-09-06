# Activity

War log and bragging rights. Screen: Activity (four tabs).

## Intent

The feed is the shared story of the season. Rankings are **per-season**, not all-time, so a new campaign is a clean ladder. Retakes exist so flipping a hex you already held this season is visible — it is not extra score, just a stat. History is a trophy shelf of completed seasons.

## Player sees

Tabs persist only in memory (`activeActivityTab`), default **Feed**.

- **Feed** — newest battles: who hit which hex, troops, winner, owner before/after. Empty: no battles yet.
- **Rankings** — eight boards (labels below), top `activity.rankingsTop`.
- **My Stats** — the same eight counters for you (zeros if no row yet).
- **Seasons** — last few completed seasons: dates UTC, three scores, winner or Draw.

While Activity is visible, the feed refreshes on the activity poll ([Realtime](realtime.md)).

## Rules

Stats (snake_case keys, same as DB / contract):

| key | meaning |
|---|---|
| `kills` | enemy troops killed |
| `losses` | own troops lost |
| `battles_joined` | attacks you launched |
| `battles_won` | those attacks that captured |
| `successful_defences` | you were stationed and the hex held |
| `territories_captured` | hexes you took |
| `retakes` | capture of a hex your faction owned earlier this season (`season_territory_faction_ownership`) |
| `reinforcement_troops_sent` | troops you stationed |

Defense kills are split across stationed players in proportion to troops.

Feed limit `activity.battleFeedLimit`. History default/max `seasonHistoryDefault` / `seasonHistoryMax` (vanilla history fetch uses `limit=5`).

## Edges

- Rankings omit password hashes and resource fields — username, faction, counters only.
- Neutral “owner” in the feed is valid.
- Tab switch re-fetches; do not invent client-side stat math.

## Tune

`config/balance.json` → `activity.*`

## API

`GET /game/battles`, `GET /game/activity-stats`, `GET /game/season-history`, `GET /public/activity` (unauthenticated feed)

## Code

BE: `backend/player-season-stats.js`  
FE: `renderActivity`, `showActivityTab`, `renderRankings`, `renderMyStats`, `renderSeasonHistory`
