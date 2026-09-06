# 05 — API Contract v1 (normative)

> This is the contract `saiwars-web` mocks and `saiwars-api` implements. It is a 1:1 port of the
> current Express behavior (`backend/server.js`) with the deltas listed in
> `02-SPLIT-ARCHITECTURE.md` §6 (prefix `/api/v1`, camelCase-only territory DTO, dead endpoints
> removed, `GET /world/map/:mapKey` added). Where this doc and the legacy code conflict during the
> port, legacy behavior wins and this doc must be corrected.

## Conventions

- Base path: `/api/v1`. All bodies JSON. All timestamps ISO-8601 strings (UTC).
- Auth: `Authorization: Bearer <JWT>` unless marked *public*. JWT payload:
  `{userId, username, faction, role, factionLocked, iat, exp}` — 24 h expiry. The server must never
  trust `faction`/`role` from the token for authorization; it re-reads the DB (current behavior).
- **Error envelope** (every non-2xx): 

```jsonc
{ "error": "Human-readable message.", "code": "OPTIONAL_MACHINE_CODE", "startsAt": "optional ISO (only SEASON_NOT_STARTED)" }
```

- Status usage: 400 validation, 401 missing/invalid token, 403 forbidden (incl.
  `SEASON_JOIN_REQUIRED`), 404 not found, 409 conflict (incl. `SEASON_NOT_STARTED`, concurrent
  attack), 429 rate-limited, 500 `{"error":"Internal server error."}`.
- Rate limits: global `limits.globalRate` per IP (`config/balance.json`; env `RATE_LIMIT_*` may override);
  chat send `chat.sendPerMinute`. 429 body follows the envelope.
- Client behavior contract (the frontend implements this; the mock must allow testing it): only 401
  invalidates the stored token; 429/5xx/network errors are retried without logout.
- Numeric tunables live in [`config/balance.json`](../config/balance.json). Feature behavior: [`docs/features/`](features/README.md).

## Shared DTOs

```ts
type Faction = 'blue' | 'red' | 'green';
type Owner = Faction | 'neutral';

interface Resources { food: number; wood: number; iron: number; manpower: number; }
interface BuildingLevels { farm: number; lumbermill: number; ironmine: number; barracks: number; }

interface FactionBonuses {
  food: number; wood: number; iron: number; manpower: number;   // fractions, e.g. 0.10
  training: number; storage: number; fortressTroops: number; allResources: number;
}

interface TerritoryDto {
  id: string;               // 'b1' | 'r1' | 'g1' | 'n1'.. | 'c1'..
  name: string;
  owner: Owner;
  defense: number;          // base troops + all stationed troops
  bonusType: string;        // 'food'|'wood'|'iron'|'manpower'|'training'|'storage'|'fortress'|'resource'|'none'|'attack'|'defense'
  bonusValue: number;       // fraction
  resourceBonus: number;
  storageBonus: number;
  fortress: boolean;
  capital: boolean;         // capitals cannot be attacked, score 0
  scoreValue: number;       // 0 capital, 1 normal, 2 core, 3 crown
  neighbors: string[];      // adjacency (bidirectional graph)
}

interface PlayerSelfDto {
  id: number; username: string; faction: Faction | null; role: 'member'|'leader'|'admin';
  needsFactionSelection: boolean;
  resources: Resources; soldiers: number;
  buildings: BuildingLevels;
  production: Resources;                 // per minute, bonuses included
  factionBonuses: FactionBonuses;
  storageCaps: Resources;
  stationedTroops: Record<string, number>;  // territoryId -> troops stationed by THIS player
  fortressTroopCap: number;              // 250
}

interface SeasonSummaryDto {
  seasonNumber: number;
  startsAt: string; endsAt: string;
  status: 'active' | 'preparing';
  hasStarted: boolean;
  scores: Record<Faction, number>;       // live territory scores
  memberCounts: Record<Faction, number>;
  joinedCount: number;
  mapKey: string; mapName: string;
}

interface GameSnapshot {
  player: PlayerSelfDto;
  world: {
    territories: TerritoryDto[];
    players: { id: number; username: string; faction: Faction|null; role: string }[];
  };
  season: SeasonSummaryDto | null;
  serverTime: number;                    // epoch ms; use for countdowns instead of client clock
}
```

**Pre-join snapshot variant** (`GET /game/state` before the player joined / before season start):
`player` reduced to `{id, username, faction: null, role, joinedSeason, needsSeasonJoin}`;
`world: {territories: [], players: []}`; `season` present. The client shows the season gate when
`season && (!season.hasStarted || player.needsSeasonJoin)`.

---

## Endpoints

### Health

`GET /health` — *public* → `200 {"ok": true, "status": "healthy"}`

### Auth

`POST /auth/register` — *public*
Request `{ "username": "Alice", "password": "secret1" }`
Rules: username `/^[A-Za-z0-9_-]{3,32}$/`; password ≥ 6 chars; faction is NEVER accepted.
`201 { "token": "<jwt>", "user": { "id": 1, "username": "Alice", "faction": null, "role": "member", "factionLocked": false, "needsFactionSelection": true } }`
Errors: 400 invalid input; 409 `{"error":"Username already exists."}`.

`POST /auth/login` — *public*
Request `{ "username": "Alice", "password": "secret1" }`
`200 { "token": "<jwt>", "user": { "id": 1, "username": "Alice", "faction": "blue", "role": "member", "factionLocked": true } }`
Errors: 400 missing fields; 401 `{"error":"Invalid credentials."}` (same for unknown user / bad password).

`GET /auth/me`
`200 { "id": 1, "username": "Alice", "faction": "blue" | null, "role": "member", "factionLocked": true, "joinedSeason": true, "needsSeasonJoin": false }`
Note: `faction` is null until the season has started AND the player joined (server.js 641).

### Season

`POST /season/join`
Request `{}` — assigns the player to the smallest faction of the current season (idempotent).
`200 { "joined": true, "seasonNumber": 4, "startsAt": "…", "hasStarted": false, "faction": null }`
(`faction` is the assigned faction string once `hasStarted` is true.)

`GET /game/season-history?limit=5` (limit 1–20, default 10)
`200 { "seasons": [ { "seasonNumber": 3, "startsAt": "…", "endsAt": "…", "blueScore": 9, "redScore": 7, "greenScore": 8, "result": "blue" | "red" | "green" | "draw", "completedAt": "…" } ] }`

### Game state

`GET /game/state` → `200 GameSnapshot` (or pre-join variant). This endpoint also triggers lazy
offline resource catch-up server-side. It is the ONLY read most of the UI needs.

`GET /world/map/:mapKey` — *public* (NEW)
`200 { "mapKey": "three-frontiers", "mapName": "Three Frontiers", "viewBox": { "width": 800, "height": 800 }, "layout": { "b1": { "cx": 106, "cy": 210 }, … } }`
404 for unknown key.

### Game actions

All require an active, joined season (else 409 `SEASON_NOT_STARTED` / 403 `SEASON_JOIN_REQUIRED`).
All mutating responses return the fresh full snapshot in `state` so the client can replace `G`.

`POST /game/upgrade-building`
Request `{ "building": "farm" | "lumbermill" | "ironmine" | "barracks" }`
`200 { "ok": true, "state": GameSnapshot }`
Errors: 400 invalid building / `{"error":"Not enough resources for the building upgrade."}`
Cost rule: `baseCost × nextLevel` per `economy.buildings` in `config/balance.json`.

`POST /game/train-soldiers`
Request `{ "amount": 25 }` (int 1–5000)
`200 { "ok": true, "state": GameSnapshot, "trainingCost": { "food": 1250, "iron": 500, "manpower": 25 }, "trained": 25 }`
Errors: 400 non-positive / `{"error":"Not enough resources to train soldiers."}`
Cost rule: `getTrainingCost(amount, max(economy.training.discountFloor, 1 - trainingBonus))`.

`POST /game/attack`
Request `{ "territoryId": "n10", "soldiers": 30 }`
`200 { "ok": true, "state": GameSnapshot, "sent": 30, "territoryId": "n10", "outcome": {
  "victory": true, "attackPower": 30, "defensePower": 21,
  "attackersLost": 21, "attackersRemaining": 9,
  "defendersLost": 21, "defendersRemaining": 0 } }`
Rules: target not own faction, not capital, adjacent to a territory owned by the attacker's
faction, soldiers ≤ reserve. Victory iff `attackers > defenders` (strict). On victory the attacker
becomes the sole garrison with `attackersRemaining` troops and loots `combat.lootOnCapture`.
Errors: 400 count/not enough soldiers; 403 capital / own territory / not adjacent; 404 unknown
territory; 409 `{"error":"An attack on this territory is already in progress."}`.

`POST /game/defend`
Request `{ "territoryId": "n1", "troops": 10 }`
`200 { "ok": true, "state": GameSnapshot, "stationed": 10, "territoryId": "n1" }`
Errors: 400 count/`Not enough soldiers available to defend.`; 403 not own faction territory; 404.

`POST /game/recall-defenders`
Request `{ "territoryId": "n1", "troops": 5 }`
`200 { "ok": true, "state": GameSnapshot, "recalled": 5, "territoryId": "n1" }`
Errors: 400 more than stationed; 404 territory / `No defenders to recall from this territory.`

### Activity

`GET /game/battles?limit=50` (1–50)
`200 { "battles": [ {
  "id": 12, "attackerFaction": "blue", "defenderFaction": "neutral", "territoryId": "n10",
  "territoryName": "Blue Ore Ridge", "attackerUsername": "Alice",
  "troopsSent": 30, "attackersLost": 21, "defendersLost": 21,
  "attackersSurviving": 9, "defendersSurviving": 0,
  "winner": "blue", "ownerBefore": "neutral", "ownerAfter": "blue", "createdAt": "…" } ] }`
(Newest first. Legacy used snake_case keys — v1 normalizes to camelCase; update client mapping.)

`GET /game/activity-stats`
`200 { "myStats": StatsRow, "rankings": { "<statKey>": StatsRow[] } }` where
`StatsRow = { "username": "Alice", "faction": "blue", "kills": 0, "losses": 0, "battles_joined": 0,
"battles_won": 0, "successful_defences": 0, "territories_captured": 0, "retakes": 0,
"reinforcement_troops_sent": 0 }` and `<statKey>` iterates those 8 stat fields (top 5 each).
(Stat keys stay snake_case — they mirror DB columns and the UI label map `ACTIVITY_STAT_LABELS`.)
`myStats` omits `username`/`faction` when the player has no stats row yet (all-zero object).

### Faction chat

`GET /game/faction-chat`
`200 { "faction": "blue", "seasonId": 4, "messages": [ { "id": 9, "seasonId": 4, "faction": "blue",
"playerId": 1, "username": "Alice", "message": "hi", "createdAt": "…" } ] }` (oldest→newest, last 100)

`POST /game/faction-chat` — rate limit 10/min/user
Request `{ "message": "⚔️ push n10" }` (trimmed, 1–500 chars)
`201 { "faction": "blue", "message": ChatMessageDto }`
Errors: 400 empty/too long; 403 no faction; 429.

`GET /game/faction-members`
`200 { "faction": "blue", "total": 3, "members": [ { "id": 1, "username": "Alice" } ] }` (own faction only)

### Admin (all require role=admin AND username='Sai', re-checked in DB per request)

Success responses are `{ "message": "…" }` unless noted; failures use the standard envelope.

| Endpoint | Request | Notes |
|---|---|---|
| `POST /admin/reset-world` | `{}` | reseed territories/neighbors, reset all players' resources/buildings; accounts kept |
| `POST /admin/reset-player` | `{ "playerId": 3 }` | starting resources/soldiers/buildings; clears their garrisons |
| `POST /admin/reset-all-resources` | `{}` | all players → starting resources/soldiers |
| `POST /admin/force-tick` | `{}` | run one resource tick now |
| `GET /admin/players` | — | `{ "players": [ raw player row + building levels ] }` (snake_case DB fields: `resource_food` etc. — admin UI consumes as-is) |
| `POST /admin/player/:id/resources` | `{ "food"?, "wood"?, "iron"?, "manpower"? }` (≥0 ints, partial) | |
| `POST /admin/player/:id/soldiers` | `{ "soldiers": 100 }` | |
| `POST /admin/player/:id/faction` | `{ "faction": "red" }` | recalls invalid garrisons; response adds `recalledTroops`, `clearedTerritories` |
| `POST /admin/player/:id/role` | `{ "role": "member"\|"leader" }` | Sai locked to admin; leader ops maintain `faction_leaders` |
| `GET /admin/factions` | — | `{ "factions": [ {id, username, faction, role} ] }` |
| `GET /admin/territories` | — | `{ "territories": [ raw territory rows (snake_case) ] }` |
| `POST /admin/territory/:id` | `{ "owner"?, "defense"? }` | capital owner immutable; defense ≥ stationed troops; owner change reconciles garrisons |
| `POST /admin/change-leader` | `{ "playerId": 3, "faction": "blue" }` | |
| `POST /admin/capital` | `{ "territoryId": "n5", "faction": "red" }` | only on a territory the faction owns; demotes previous capital |
| `GET /admin/season` | — | `{ "season": { id, seasonNumber, startsAt, endsAt, status, memberCounts, liveScores } }` |
| `POST /admin/season/force-finish` | `{ "confirm": true }` | finalizes + starts next season (24 h preseason); response `{message, finishedSeason, newSeason}` |
| `GET /admin/season-reset-plan` | — | static informational plan object |

### Realtime channel

- Transport: socket.io on the API host. Handshake: `io(API_URL, { auth: { token: "<jwt>" } })`;
  invalid/missing token → connection error `"Authentication required."` / `"Invalid or expired session token."`.
- Server→client event: `state:changed` payload `{ "revision": number }` (monotonic). Emitted after
  any successful mutating request, any resource tick that changed players, and season changes.
- Client contract: on event, debounce-refetch `GET /game/state` (≥150 ms debounce, drop-if-in-flight
  then re-queue). No other events exist in v1. No client→server events.

---

## Frontend stub strategy (how mocks mirror this contract)

1. **One fixture per response type** in `apps/web/src/api/mocks/`, typed against
   `@saiwars/game-content/dto` — compilation enforces contract conformance of mocks.
2. **Seeded world**: `MockApiClient` builds its territory state from
   `gameContent.mapRegistry.getMap('three-frontiers').topology.buildTerritories()` + `buildEdges()`
   so the map screen renders the real 33-territory graph.
3. **Stateful mock**: holds `{players, territories, garrisons, battles, chat, season}` in memory.
   Mutations reuse game-content rules (`getTrainingCost`, `getUpgradeCost`,
   `calculateBattleOutcome`, garrison allocation) so UI flows behave like production. Mock state
   resets on reload; a `?scenario=` query can preload scenarios (fresh player, mid-season war,
   preseason gate, admin).
4. **Error simulation**: mock exposes `simulate({status: 401|429|500|'network'})` toggles used by
   tests to verify the client retry/logout rules in the Conventions section.
5. **Latency**: mock resolves with 50–150 ms artificial delay so loading states render.
6. **Realtime**: `MockRealtimeClient.emitStateChanged()` invoked after every mock mutation,
   exercising the debounced-refetch path identically to production.
7. **Contract drift guard**: when the contract changes, update `dto.ts` first — both the mock and
   `HttpApiClient` break at compile time until brought in line.
