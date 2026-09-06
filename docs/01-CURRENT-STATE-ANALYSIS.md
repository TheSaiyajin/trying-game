# 01 — Current State Analysis (deep dive)

> Everything here was verified against the actual code on 2026-09-05. Line numbers refer to the
> files as currently in the repository; re-verify before relying on them if files have changed.

## 1. State management map — where every piece of state lives

### 1.1 Server / PostgreSQL (authoritative — ALL game state)

Every gameplay value lives in Postgres and is only ever mutated by the Express server. The client
receives read-only snapshots. See §4 for table shapes.

| State | Table(s) | Mutated by |
|---|---|---|
| Accounts, credentials, role | `players` (`username`, `password_hash`, `role`, `season_wins`) | register/login, admin role ops, bootstrap CLI |
| Per-player economy | `players` (`resource_food/wood/iron/manpower`, `soldiers`, `resource_last_updated`) + `buildings` | resource tick, offline catch-up, train/upgrade/attack/defend/recall, admin edits, season reset |
| Current faction | `players.faction` (**cache**) + `season_memberships` (**authoritative**, per season) | `ensurePlayerFactionAssignment`, admin faction change, season reset (sets NULL) |
| World map | `territories`, `territory_neighbors`, `topology_version` | seeding, topology migration, attacks, admin territory edits, season reseed |
| Garrisons (per-player stationed troops) | `territory_defenders` | defend/recall/attack casualty allocation, admin owner-change reconciliation |
| Battles | `battle_history` | `performAttack`, legacy `resolveBattle` |
| Seasons | `seasons`, `season_memberships`, `season_territory_faction_ownership` | `runSeasonRollover`, join, stats recorder |
| Per-season player stats | `player_season_stats` | `recordBattleStats`, `addPlayerSeasonStats` |
| Chat | `faction_chat_messages` (scoped `season_id` + `faction`) | POST faction-chat |
| Admin audit | `admin_actions` | `logAdminAction` from every admin op |
| Legacy/dead | `attack_contributions`, `attack_targets`, `faction_leaders` | see §6.4 |

Server-side **in-memory** state (must be re-homed in NestJS): the 60-second resource tick interval
(`startResourceTickLoop`, `backend/server.js` line 466), the Socket.IO revision counter
(`backend/realtime.js`), and `observedSeasonId` (line 77, used to broadcast on season change).

### 1.2 Client (`script.js`) — render cache + UI-only state

| Variable (line) | Contents | Notes |
|---|---|---|
| `G` (line 29, shape from `DEFAULT_STATE` line 11) | Last server snapshot: `player` (incl. `resources`, `buildings`, `production`, `factionBonuses`, `storageCaps`, `stationedTroops`, `soldiers`, `fortressTroopCap`), `territories` (map by id, normalized by `mapTerritories` line 66), `chatMessages`, `season`. Also vestigial `attackTarget`/`attackContributions` (never populated). | Replaced wholesale by `setGameStateFromSnapshot` (line 197) after every fetch/action. Never the source of truth. |
| `selectedTerritoryId` (30) | Selected hex | UI-only |
| `attackSendCount`, `defendSendCount`, `recallSendCount`, `trainAmount` (31–33, 1190) | Input steppers | UI-only |
| `mapView` (35) | Pan/zoom/pointer gesture state for the SVG map | UI-only, portable "camera" concept |
| `realtimeSocket`, `realtimeRefresh*` (36–39) | Socket + debounced refetch | transport |
| `activeActivityTab` (40), `factionChatPollHandle` (34), `seasonGateCountdownHandle` (41) | Tab/timer handles | UI-only |
| `localStorage` | `trying_game_token` (JWT, `AUTH_STORAGE_KEY` line 7) and `trying_game_screen_<playerId>` (last screen, line 8) | Only persistent client state |

**Client-side duplicated game rules** (render-only conveniences that must move into the shared
contract or be served by the API, else they will drift):
- `calculateTrainingCost` (line 723) and `getAffordableTrainingAmount` (line 853) duplicate
  `getTrainingCost`/bonus math from `backend/game-logic.js`.
- `renderCity` (line 745) hardcodes a `defs` object duplicating `BUILDING_DEFS` (names, base rates,
  upgrade costs) from `backend/game-logic.js`.
- `canAttack` (line 927) duplicates the server adjacency/capital rule from `attack-logic.js`.
- `computeScores`-equivalent territory counting in `renderScoreboard` (line 125).

## 2. Game systems inventory (with implementing functions)

### 2.1 Auth & session
- Client: `submitAuth` (script.js 461), `ensureSession` (319), `fetchCurrentUser` (314), `apiFetch`
  (279, adds `Authorization: Bearer`), `logoutPlayer` (504), token helpers (233–239).
  Retry semantics: only HTTP 401 deletes the token; 429/5xx/network errors retry (comments at 293–299, 333).
- Server: `POST /api/register` (server.js 572), `POST /api/login` (612), `GET /api/me` (633),
  `requireAuth` middleware (122) which also **rolls the season over on demand** via
  `ensureCurrentSeason`. JWT payload: `{userId, username, faction, role, factionLocked}` (auth.js).

### 2.2 Season lifecycle
- Gate UI: `showSeasonGate` (script.js 388), `joinSeason` (420); shown when
  `!season.hasStarted || player.needsSeasonJoin` (loadGame 547).
- Server: `backend/season.js` — `ensureCurrentSeason` (225), `runSeasonRollover` (161, advisory lock
  `ROLLOVER_LOCK_KEY`), `createSeasonRow` (46), `resetSeasonalGameplay` (110, full world+player
  reseed), `ensurePlayerFactionAssignment` (241, smallest-faction balancing under
  `ASSIGNMENT_LOCK_KEY`), `computeScores` (71), `hasSeasonStarted` (28). Durations from
  `config/balance.json` `season.*`. Feature spec: `docs/features/seasons.md`. Startup safety net:
  `ensureCurrentSeasonOnStartup` (db.js 294).
- Gating middleware: `requirePlayableSeason` (server.js 154) → 409 `SEASON_NOT_STARTED` /
  403 `SEASON_JOIN_REQUIRED`.

### 2.3 Economy (resources, buildings, training)
- Rules (pure): `backend/game-logic.js` — numbers from `config/balance.json`
  (`BUILDING_DEFS`, `getUpgradeCost`, `getTrainingCost`,
  `getProductionFromBuildings`, `getFactionTerritoryBonuses`, `getFactionStorageCaps`
  (`BASE_STORAGE_CAP`), `limitResourceGain`, `limitPassiveFortressTroopGain`
  (`PASSIVE_FORTRESS_TROOP_CAP`)). Feature spec: `docs/features/economy.md`.
- Generation: `runGlobalResourceTick` (server.js 398, every 60 s for **all** players) +
  `applyOfflineResourceEarnings` (311, lazy catch-up on state fetch, capped at 12 h).
- Actions: `POST /api/game/upgrade-building` (762), `POST /api/game/train-soldiers` (795).
- Client render: `renderCity` (745), `updateResourceBar` (681), `renderFactionBonuses` (703),
  `trainSoldiers` (821), `upgradeBuilding` (799).

### 2.4 Map & territories (presentation)
- Layout source: `WORLD_TOPOLOGY.buildLayout()` — the same module the DB is seeded from.
  `buildTerritoryLayout` (script.js 892) filters layout to territories present in the snapshot and
  grids any unknown ids.
- Rendering: `renderMap` (933, full SVG rebuild per refresh), `createHexPoints` (916),
  `sortTerritoryIds` (873), bonus icons `getBonusIcon` (1275), faction colors `FACTION_FILL/STROKE` (870).
- Interaction: `initializeMobileMap` (1053, wheel-zoom, desktop drag-pan, touch pinch/pan with
  click-suppression), `applyMapView` (1026), `changeMapZoom` (1046), `resetMapView` (1038),
  `selectTerritory` (1192), `closeTerritoryPanel` (1247).

### 2.5 Combat (attack / defend / recall)
- Client: `launchAttack` (1293), `sendDefenders` (1345), `recallDefenders` (1389), steppers
  `changeAttack/Defend/Recall` (1281/1333/1376), input validation `readTroopInput` (844), battle
  popup (1318–1321, 1441).
- Server attack: `performAttack` (`backend/attack-logic.js` 32) — validations (capital via
  `territory-protection.js`, own-territory, adjacency SQL, soldier count), per-territory advisory
  lock, `calculateBattleOutcome` (game-logic.js 139: strictly-more-attackers-wins, deterministic),
  proportional garrison casualties (`applyDefenderCasualties`, defender-garrisons.js 137), capture
  (+25 food/wood/iron loot), `battle_history` insert, `recordBattleStats`.
- Server defend/recall: inline transactions in server.js (`/api/game/defend` 821,
  `/api/game/recall-defenders` 883) using `getLockedTerritoryDefenders` /
  `getTerritoryDefenseState` (defender-garrisons.js). `defense_troops` on the territory =
  base (seeded/NPC) troops + sum of stationed player troops.

### 2.6 Activity / stats / rankings / history
- Client: `renderActivity` (1521), tabs `showActivityTab` (1462), `renderRankings` (1476),
  `renderMyStats` (1502), `renderSeasonHistory` (162), labels `ACTIVITY_STAT_LABELS` (1451).
- Server: `GET /api/game/battles` (724), `GET /api/game/activity-stats` (753) →
  `getSeasonStats` (player-season-stats.js 129), `GET /api/game/season-history` (1246).
  Stat writing: `recordBattleStats` (93) with proportional kill distribution
  (`distributeProportionally` 12) and retake detection via `season_territory_faction_ownership`.

### 2.7 Faction chat & members
- Client: `renderFactionChat` (1613), `sendFactionChatMessage` (1683), `renderFactionMembers`
  (1653), 4-second polling `startFactionChatPolling` (1698), emoji insert (1589).
- Server: `backend/faction-chat.js` (list last 100 by `season_id`+`faction`, 500-char limit,
  member list from `players.faction`); routes at server.js 975/983/991 with a dedicated
  10-msg/min rate limit (107).

### 2.8 Admin
- Client: `renderAdminPanel` (1716) and the whole `admin*` family (1723–2036) — season info,
  force-finish, world/resource resets, force tick, per-player role/faction/soldiers/resources
  editors, per-territory owner/defense editor, capital setter. Gated client-side by `isAdminUser`
  (85: `username === 'Sai' && role === 'admin'`).
- Server: `requireAdmin` (server.js 193) → `isAuthorizedAdminPlayer` (admin-policy.js, re-checks DB
  each request). Operations in `admin-write-operations.js`, `admin-resets.js`,
  `admin-faction-change.js`; every op writes an `admin_actions` audit row. Admin promotion only via
  CLI `node backend/db.js --bootstrap-admin <token>` (admin-bootstrap.js).

### 2.9 Realtime & refresh
- Server: `attachRealtime` (realtime.js), mutation-detection middleware (server.js 94–105) →
  `notifyStateChanged()` global broadcast; also fired by resource ticks (458) and observed season
  changes (136).
- Client: `connectRealtime` (257), `scheduleRealtimeRefresh` (241, 150 ms debounce + in-flight
  queueing), `refreshGameStateInBackground` (603), 60 s poll + 30 s activity poll + 1 s countdown
  tick (DOMContentLoaded block 2096–2156).

## 3. Current API surface (complete route list)

All under `/api`, JSON, `Authorization: Bearer <JWT>` unless noted. Global rate limit 120 req/min/IP.
Full request/response shapes are specified in `05-API-CONTRACT.md`; this is the as-is inventory with
server.js line numbers.

| Method & path | Line | Auth | Purpose |
|---|---|---|---|
| GET `/api/health` | 568 | none | health check (used by deploy) |
| POST `/api/register` | 572 | none | create account (always role `member`, faction NULL) → `{token, user}` |
| POST `/api/login` | 612 | none | → `{token, user}` |
| GET `/api/me` | 633 | JWT | identity + season membership flags (`joinedSeason`, `needsSeasonJoin`) |
| POST `/api/player/faction` | 652 | JWT | **always 403** — kept as tombstone for old clients |
| POST `/api/season/join` | 656 | JWT | join current season → faction assignment |
| GET `/api/world` | 681 | JWT+season | world sub-snapshot (redundant with `/game/state`) |
| GET `/api/player/state` | 687 | JWT+season | player sub-snapshot (redundant) |
| GET `/api/game/state` | 693 | JWT | **the** full snapshot: `{player, world, season, serverTime}`; pre-join variant has empty world |
| GET `/api/game/battles` | 724 | JWT+season | last ≤50 battle_history rows (joined names) |
| GET `/api/game/activity-stats` | 753 | JWT+season | `{myStats, rankings}` for current season |
| POST `/api/game/upgrade-building` | 762 | JWT+season | `{building}` → new snapshot |
| POST `/api/game/train-soldiers` | 795 | JWT+season | `{amount}` → snapshot + `trained` |
| POST `/api/game/defend` | 821 | JWT+season | `{territoryId, troops}` → snapshot |
| POST `/api/game/recall-defenders` | 883 | JWT+season | `{territoryId, troops}` → snapshot |
| POST `/api/game/attack` | 949 | JWT+season | `{territoryId, soldiers}` → snapshot + `outcome` |
| GET `/api/game/faction-chat` | 975 | JWT+season | last 100 messages of own faction+season |
| GET `/api/game/faction-members` | 983 | JWT+season | own faction roster |
| POST `/api/game/faction-chat` | 991 | JWT+season+10/min | `{message}` → created message |
| POST `/api/game/resolve-battle` | 1000 | JWT+season | **legacy** — reads `attack_contributions`, no writer exists |
| GET `/api/game/season-history` | 1246 | JWT | completed seasons (≤20) |
| POST `/api/admin/reset-world` | 1019 | admin | reseed world, keep accounts |
| POST `/api/admin/reset-player` | 1032 | admin | `{playerId}` |
| POST `/api/admin/reset-all-resources` | 1051 | admin | |
| POST `/api/admin/force-tick` | 1061 | admin | run resource tick now |
| GET `/api/admin/players` | 1074 | admin | all players + buildings |
| POST `/api/admin/player/:id/resources` | 1088 | admin | partial `{food?,wood?,iron?,manpower?}` |
| POST `/api/admin/player/:id/soldiers` | 1107 | admin | `{soldiers}` |
| POST `/api/admin/player/:id/faction` | 1126 | admin | `{faction}` + garrison reconciliation |
| POST `/api/admin/player/:id/role` | 1151 | admin | `{role}` member/leader (Sai locked to admin) |
| GET `/api/admin/factions` | 1170 | admin | player/faction listing |
| GET `/api/admin/territories` | 1176 | admin | raw territory rows |
| POST `/api/admin/territory/:id` | 1182 | admin | `{owner?, defense?}` |
| POST `/api/admin/change-leader` | 1203 | admin | `{playerId, faction}` |
| POST `/api/admin/capital` | 1222 | admin | `{territoryId, faction}` |
| GET `/api/admin/season-reset-plan` | 1242 | admin | static plan description |
| GET `/api/admin/season` | 1271 | admin | live season info |
| POST `/api/admin/season/force-finish` | 1289 | admin | `{confirm: true}` → rollover now |
| Socket.IO `/socket.io` | realtime.js | JWT in handshake `auth.token` | server→client `state:changed {revision}` only |

Error shape everywhere: `{ "error": string }` (+ optional `code`, e.g. `SEASON_NOT_STARTED`,
`SEASON_JOIN_REQUIRED`; `startsAt` on 409). Unhandled → 500 `{error: "Internal server error."}`
(server.js 1320).

## 4. Data structures

### 4.1 Database tables (schema.sql + db.js migrations — migrations are the superset)

- **players**: `id serial PK`, `username varchar(32) UNIQUE`, `password_hash text`,
  `faction varchar(16) NULL`, `faction_locked bool`, `role varchar(16) ('member'|'leader'|'admin')`,
  `created_at`, `last_login_at`, `last_action_at`, `resource_last_updated`,
  `resource_food int (500)`, `resource_wood int (400)`, `resource_iron int (300)`,
  `resource_manpower int (250)`, `soldiers int (100)`, `army_name varchar(64)`,
  `season_wins int (0, migration-only)`.
- **buildings**: `id`, `player_id FK`, `farm|lumbermill|ironmine|barracks int (1)`, `updated_at`.
  One row per player (no unique constraint, but treated as 1:1).
- **territories**: `id varchar(8) PK` (e.g. `b1`, `n17`, `c1`), `name`, `owner_faction ('neutral'|faction)`,
  `defense_troops int`, `bonus_type varchar(32)` (`food|wood|iron|manpower|training|storage|fortress|resource|none|attack|defense`),
  `bonus_value numeric(6,3)`, `is_fortress bool`, `is_capital bool`, `resource_bonus numeric`,
  `storage_bonus numeric`, `score_value int` (0 capital, 1 normal, 2 core, 3 Crown), `map_x`,
  `map_y`, `created_at`, `last_battle_at`.
- **territory_neighbors**: `(territory_id, neighbor_id)` PK, bidirectional rows.
- **territory_defenders**: `(territory_id, player_id)` PK, `faction`, `troops`, timestamps.
- **battle_history**: `id`, `attacker_faction`, `defender_faction`, `territory_id`,
  `attacker_player_id`, `troops_sent`, `defender_total`, `applied_bonuses text(JSON)`, `winner`,
  `attackers_lost`, `attackers_surviving`, `defenders_lost`, `defenders_surviving`, `owner_before`,
  `owner_after`, `created_at`.
- **seasons**: `id`, `season_number int UNIQUE` (sequential; row 0 = legacy bucket),
  `starts_at`, `ends_at`, `status ('active'|'completed')`, `map_key`, `blue_score`, `red_score`,
  `green_score`, `result ('blue'|'red'|'green'|'draw')`, `completed_at`, `created_at`.
- **season_memberships** (migration-only): `(season_id, player_id)` PK, `faction`, `assigned_at`.
  **Authoritative faction record**; `players.faction` is a synced cache (see comment season.js 269).
- **player_season_stats**: `(season_id, player_id)` PK + 8 int counters (`kills`, `losses`,
  `battles_joined`, `battles_won`, `successful_defences`, `territories_captured`, `retakes`,
  `reinforcement_troops_sent`), `updated_at`.
- **season_territory_faction_ownership**: `(season_id, territory_id, faction)` PK — "has faction F
  ever owned T this season" for retake detection.
- **faction_chat_messages**: `id`, `faction`, `player_id`, `message text`, `created_at`,
  `season_id FK (migration)`.
- **admin_actions**: `id`, `actor_id`, `action_name`, `action_detail text(JSON)`, `created_at`.
- **topology_version**: singleton row `{id: 1, version, map_key, updated_at}`.
- **faction_leaders**: `faction PK`, `player_id NULL` — written by admin role ops, never read by gameplay.
- **attack_contributions**, **attack_targets**: legacy coordinated-attack tables (see §6.4).

### 4.2 The game-state snapshot (the contract the frontend actually renders)

Built by `getPlayerWorldState` (server.js 472) + `buildSeasonSummary` (530):

```jsonc
{
  "player": {
    "id": 7, "username": "Alice", "faction": "blue", "role": "member",
    "needsFactionSelection": false,
    "resources": { "food": 500, "wood": 400, "iron": 300, "manpower": 250 },
    "soldiers": 100,
    "buildings": { "farm": 1, "lumbermill": 1, "ironmine": 1, "barracks": 1 },
    "production": { "food": 5, "wood": 4, "iron": 3, "manpower": 2 },
    "factionBonuses": { "food": 0.1, "wood": 0, "iron": 0, "manpower": 0, "training": 0.05,
                         "storage": 0.1, "fortressTroops": 1, "allResources": 0 },
    "storageCaps": { "food": 11000, "wood": 11000, "iron": 11000, "manpower": 11000 },
    "stationedTroops": { "n3": 25 },
    "fortressTroopCap": 250
  },
  "world": {
    "territories": [ /* snapshot territory, see below */ ],
    "players": [ { "id": 7, "username": "Alice", "faction": "blue", "role": "member" } ]
  },
  "season": {
    "seasonNumber": 4, "startsAt": "…ISO…", "endsAt": "…ISO…",
    "status": "active", "hasStarted": true,
    "scores": { "blue": 9, "red": 7, "green": 8 },
    "memberCounts": { "blue": 3, "red": 3, "green": 2 },
    "joinedCount": 8, "mapKey": "three-frontiers", "mapName": "Three Frontiers"
  },
  "serverTime": 1757000000000
}
```

Snapshot territory (`getTerritoriesSnapshot`, server.js 253 — note it deliberately emits **both**
camelCase and snake_case aliases; the split should keep only camelCase):

```jsonc
{ "id": "n1", "name": "Blue Farmstead", "owner": "neutral", "owner_faction": "neutral",
  "defense": 18, "bonus": "food", "bonus_type": "food", "bonusValue": 0.1, "bonus_value": 0.1,
  "resourceBonus": 0.1, "storageBonus": 0, "fortress": false, "capital": false,
  "scoreValue": 1, "score_value": 1, "neighbors": ["b1", "n2", "n10"] }
```

Client normalization: `mapTerritories` (script.js 66) → `{id, name, owner, troops, bonus,
bonusValue, storageBonus, adj, fortress, capital}` keyed by id.

### 4.3 Topology module shape (`world-topology.js` / `crownlands-topology.js`)

UMD modules exposing: `TOPOLOGY_VERSION`, `FACTIONS`, `CAPITAL_ID`, `CORE_IDS`,
`buildTerritories()` → `[{id, name, ownerFaction, defense, bonusType, bonusValue, resourceBonus,
storageBonus, isFortress, isCapital, scoreValue}]`, `buildEdges()` → `[[a,b],…]` undirected,
`buildLayout()` → `{[id]: {cx, cy}}`, `buildRotationMap()`, `LAYOUT_VIEWBOX {width, height}`.
`map-registry.js` wraps both with `{key, name, topology}` + `getNextMapKey` rotation.
`crownlands-topology.js` defines `attack`/`defense` bonus types that **no game logic consumes**
(`getFactionTerritoryBonuses` ignores them) — presentation shows them via generic labels only.

## 5. Coupling analysis — what is tangled with what

1. **Frontend render ↔ DOM ↔ network in single functions.** Nearly every screen renderer both
   fetches and paints (`renderFactionChat`, `renderActivity`, `renderSeasonHistory`,
   `renderAdminPanel` family all call `apiFetch` internally). Action handlers
   (`launchAttack`, `trainSoldiers`, …) do validation + fetch + state replace + re-render + toast in
   one function. There is **no** separation between "state in" and "render out" today — this is the
   main refactor the Next.js/Godot-portable frontend needs.
2. **HTML ↔ JS global namespace.** `index.html` wires ~40 inline `onclick="fn(...)"` attributes to
   global functions in `script.js` (e.g. `joinSeason()`, `showScreen('map')`,
   `adminForceFinishSeason()`). Any rename breaks the UI silently.
3. **Shared topology modules.** `world-topology.js`/`crownlands-topology.js`/`map-registry.js` are
   consumed by the browser (layout), the backend (seeding via `topology-sql.js`, scoring via
   `CORE_ID_SET` in season.js), and tests. After the split, both projects need the same data —
   see `02-SPLIT-ARCHITECTURE.md` §5 for the resolution (server-owned, served via API; DB already
   stores `map_x`/`map_y`/`score_value`).
4. **Duplicated rules in the client** (training cost, building defs, attackability, storage caps
   default 10k in `updateResourceBar`) — see §1.2. Drift risk during the split; the target design
   moves these into a shared `game-content` package or derives them from API data.
5. **Snapshot dual-shape hack.** `getTerritoriesSnapshot` emits both naming conventions because
   `game-logic.js`/`season.js` accept either (`territory.owner_faction || territory.owner`). Clean
   DTOs in the NestJS port remove this.
6. **`players.faction` cache vs `season_memberships`.** Every gameplay query filters by
   `players.faction`; correctness depends on `ensurePlayerFactionAssignment`/season reset keeping
   the cache in sync. Carry this design (it works, is tested) or normalize later — do NOT half-migrate.
7. **Season rollover piggybacks on request auth.** `requireAuth` calls `ensureCurrentSeason` on
   *every* authed request; there is no cron. In NestJS, replace with a scheduled job + keep the
   lazy check as a safety net.
8. **Socket.IO client is loaded from the backend** (`<script src="/socket.io/socket.io.js">` in
   index.html) — a frontend↔backend deploy coupling that must break in the split.
9. **Frontend tests import `script.js` directly into Node** with fake DOM objects
   (`tests/frontend_session.test.js`, `tests/map_pointer_ui.test.js`). The `module.exports` block at
   script.js 2159 exists solely for this. The new frontend needs a proper test setup instead.
10. **Express serves no static files** — Nginx does (deploy.yml). The API is origin-relative
    (`fetch('/api'+path)`); the split introduces cross-origin (CORS) concerns the current code
    never had.

## 6. Surprises & gotchas found

1. **The backend is not "minimal".** Despite the README ("Minimal multiplayer test project"), the
   `backend/` folder is a mature, transaction-safe, advisory-locked, audit-logged, well-tested
   server (~140 KB of code + 23 test files). Plan the split as a **port**, not a rewrite.
2. **`schema.sql` is not the full schema.** `season_memberships`, `players.season_wins`,
   `faction_chat_messages.season_id`, and several indexes exist only in
   `applySchemaMigrations` (db.js 54–240). The Supabase schema must be derived from the migration
   superset (done in `02-SPLIT-ARCHITECTURE.md` §4).
3. **Two combat implementations.** `attack-logic.js` (used) and `resolve-battle.js` (legacy, reads
   `attack_contributions` which nothing writes; `calculateBattleOutcome` ignores its
   `attackBonus`/`defenseBonus` args). Frontend `resolveSelectedTargetBattle` (script.js 1415) is
   not reachable from any UI element.
4. **Dead code inventory** (do not port):
   - `backend/resolve-battle.js` + route `POST /api/game/resolve-battle` + tables
     `attack_contributions`, `attack_targets`.
   - `script.js`: `resolveSelectedTargetBattle` (1415), `saveGame` (629), `resetGame` (637),
     `autoSave` (2038).
   - `server.js`: `requireLeaderOrAdmin` (207), `isPlayerTerritoryAdjacentToTarget` (550),
     `getPlayerState` (284), dead import `getCurrentUtcDayBounds` (58).
   - Routes `GET /api/world`, `GET /api/player/state` (frontend only uses `/api/game/state`).
   - `faction_leaders` table + leader role: written by admin ops, never read by gameplay. Decide:
     port as-is (cheap) or drop (see TODO).
   - `season-time.js` is only used by tests (`season_time.test.js`) — the scheduler moved to
     relative 7-day/24-h windows in season.js.
5. **Admin identity is hardcoded**: username `Sai` (`admin-policy.js`) + DB role, promoted only via
   CLI with `ADMIN_BOOTSTRAP_TOKEN`. Client shows admin UI via the same check (`isAdminUser`).
6. **Rate limits are part of the contract**: 120 req/min global, 10 chat msgs/min; the client has
   explicit UX for 429s (never logs out). Keep equivalents in NestJS (`@nestjs/throttler`).
7. **`notifyStateChanged` broadcasts to everyone** on any mutation — simple, but O(players) refetch
   amplification. Fine to keep initially; noted as a scale risk in the migration plan.
8. **Crownlands `attack`/`defense` bonuses are inert** (see §4.3) — document as "reserved" in the
   new content package, don't invent mechanics for them.
9. **Deploy substitutes `__BUILD_VERSION__`** into `index.html` via `sed` (deploy.yml 64) — Next.js
   makes this obsolete.
