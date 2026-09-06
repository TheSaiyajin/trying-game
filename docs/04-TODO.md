# 04 — Master TODO

> Rules for executing agents:
> - Each task is sized for one working session. Do tasks in listed order within a phase unless the
>   `deps:` note says otherwise; tasks in different projects within a phase may run in parallel.
> - "Contract" always means `docs/05-API-CONTRACT.md`. "Analysis" means
>   `docs/01-CURRENT-STATE-ANALYSIS.md`. "Arch" means `docs/02-SPLIT-ARCHITECTURE.md`.
>   Feature specs: `docs/features/` (start at `docs/INTENT.md`). Tunables: `config/balance.json` (copy the JSON; do not retype numbers).
> - Never change game rules/values while porting. When old and new disagree, the old code wins and
>   the docs get corrected. Change a number only by editing `config/balance.json`.
> - Check items off (`- [x]`) in this file as part of the task's commit.

## Phase 0 — Scaffolding

Local run is two npm projects, no Docker. See `docs/06-LOCAL-LAUNCH.md`.
`Realms-At-War-BE` and `Realms-At-War-FE` already exist as standalone folders.

### repo/infra
- [x] P0.1 Split into `Realms-At-War-FE` (Next.js host) and `Realms-At-War-BE` (Nest-hosted 1:1 Express API). No Docker; `DATABASE_URL` is enough.
- [ ] P0.2 CI workflow: install, lint, typecheck, build, test for all workspaces on push/PR. *(deps: P0.1)*
- [ ] P0.3 Add eslint boundary rule forbidding `react`/`next` imports inside `apps/web/src/game-ui/**`. *(deps: P0.1)*

## Phase 1 — `@saiwars/game-content`

- [ ] P1.1 Port `world-topology.js` → `topologies/three-frontiers.ts` (same exports: `TOPOLOGY_VERSION`, `FACTIONS`, `CAPITAL_ID`, `HOME_IDS`, `FRONTIER_IDS`, `BORDER_PAIRS`, `CORE_IDS`, `buildTerritories`, `buildEdges`, `buildRotationMap`, `buildLayout`, `LAYOUT_VIEWBOX`). Typed interfaces for territory defs.
- [ ] P1.2 Port `crownlands-topology.js` → `topologies/crownlands-64.ts` and `map-registry.js` → `mapRegistry.ts`. *(deps: P1.1)*
- [ ] P1.3 Port `config/balance.json` + `backend/game-logic.js` → `rules.ts` verbatim (load numbers
  from the JSON; all functions + constants listed in Analysis §2.3), plus `isCapitalTerritory` /
  `CAPITAL_ATTACK_ERROR` from `territory-protection.js`.
- [ ] P1.4 Port pure functions from `backend/defender-garrisons.js` (`sumStationedDefenders`, `getTerritoryDefenseState`, `allocateDefenderCasualties`, `resolveDefenderCasualties`) → `garrisons.ts`. *(deps: P1.3)*
- [ ] P1.5 Write `dto.ts` with every request/response type from the Contract (GameSnapshot, TerritoryDto, SeasonSummary, BattleDto, StatsDto, ChatMessageDto, admin DTOs, error envelope). 
- [ ] P1.6 Port tests: `tests/world_topology.test.js` (structure/symmetry/geometry), battle-outcome and training-cost golden values extracted from `tests/attack_logic.test.js` + `tests/resource_earnings.test.js`. *(deps: P1.1–P1.4)*
- [ ] P1.7 Comparison harness: script in the OLD repo (`X:\KristupoProjektas`) requiring both old JS modules and built game-content, asserting identical `buildTerritories()`, `buildLayout()`, `calculateBattleOutcome` over a 0–200×0–200 grid, `getTrainingCost` for 1–5000, bonuses/caps over sample territory sets. *(deps: P1.6)*
- [ ] P1.8 Add `exportJson()` producing `{territories, edges, layout, viewBox}` per map (for Godot later) + snapshot test. *(deps: P1.2)*

## Phase 2 — Frontend `apps/web` (all on mocks)

### api & state plumbing
- [ ] P2.1 `src/api/ApiClient.ts` interface + `RealtimeClient.ts` interface — one method per Contract endpoint, typed with `@saiwars/game-content/dto`. *(deps: P1.5)*
- [ ] P2.2 `MockApiClient` + fixtures: in-memory world seeded from `three-frontiers` topology, fake auth, mutable state using game-content rules; `MockRealtimeClient` emitting `state:changed` after mutations (Arch §1.5). *(deps: P2.1)*
- [ ] P2.3 `HttpApiClient` port of `apiFetch` (script.js 279): bearer header, `{error}` parsing, `error.status`, network-error flag; and `state/session.ts` (token in localStorage `trying_game_token`, per-player last-screen key). *(deps: P2.1)*
- [ ] P2.4 `state/GameStore.ts`: snapshot holder + commands (`join`, `train`, `upgrade`, `attack`, `defend`, `recall`, `sendChat`, admin ops). Preserve `setGameStateFromSnapshot` semantics incl. chat cache invalidation on faction change (script.js 197–227). *(deps: P2.2)*
- [ ] P2.5 `state/refresh.ts`: debounced realtime refetch (150 ms, in-flight queue — script.js 241–255), 60 s snapshot poll, 1 s countdown tick, 401-only-logout rules (script.js 598–627). *(deps: P2.4)*

### portable game-ui layer
- [ ] P2.6 `game-ui/format.ts` + `game-ui/selectors.ts`: port `fmt`, `formatCountdown`, `formatScoreboardFaction`, `ownerLabel`, `formatBonusLabel`, `getBonusIcon`, `factionIcon`, `canAttack`, `getAffordableTrainingAmount` (delegate cost math to game-content), `sortTerritoryIds`, `getFactionLegendEntries`, `isAdminUser`. Unit tests. *(deps: P1.3)*
- [ ] P2.7 `game-ui/map/layout.ts` + `mapScene.ts`: port `buildTerritoryLayout` (incl. unknown-id fallback grid, script.js 892–914), `createHexPoints`, faction fill/stroke tables; produce pure draw-op lists (edges first, then hexes/labels/troops/bonus/capital markers — script.js 933–1024). Unit tests on draw-op output. *(deps: P2.6)*
- [ ] P2.8 `game-ui/map/camera.ts`: port `mapView` pan/zoom/pinch state machine with injected events (wheel zoom-to-cursor, desktop drag with 5 px threshold + 400 ms click suppression, touch pinch/pan — script.js 1026–1188). Unit tests with synthetic event sequences. *(deps: P2.7)*
- [ ] P2.9 View-models: `cityVm.ts` (building cards from snapshot + `BUILDING_DEFS`), `territoryPanelVm.ts` (fields + attack/defend/recall section visibility + stepper max rules — script.js 1192–1245, 1281–1413), `activityVm.ts` (feed lines, rankings, my-stats — script.js 1445–1585), `seasonVm.ts` (gate + scoreboard + history rows). Unit tests. *(deps: P2.6)*

### screens (React, thin wrappers)
- [ ] P2.10 App shell + boot flow: `app/page.tsx` port of `loadGame` routing logic (session check → auth | gate | game; temporary-error retry loop — script.js 519–578), boot spinner, toast component. *(deps: P2.4, P2.5)*
- [ ] P2.11 Auth screen (`app/auth/page.tsx`): login/register modes, client validation (username regex, password ≥6, confirm match — script.js 461–502), styling from `style.css` `.auth-*`. *(deps: P2.10)*
- [ ] P2.12 Season gate (`app/gate/page.tsx`): countdown, joined count, join button, logout (index.html 46–57 + script.js 388–430). *(deps: P2.10)*
- [ ] P2.13 Game layout (`app/game/layout.tsx`): top bar, identity, info modal, resource bar, bottom nav, faction theming (`data-faction`), last-screen persistence. *(deps: P2.10)*
- [ ] P2.14 City screen: building cards, upgrade buttons, train section with cost preview + steppers (`changeTrain`, ±1/±10), faction bonuses card incl. fortress reserve line (script.js 703–868). *(deps: P2.9, P2.13)*
- [ ] P2.15 Map screen: `<SvgMap/>` rendering mapScene ops, scoreboard, legend, zoom controls, territory panel with attack/defend/recall forms (steppers ±10/50%/MAX, input validation port of `readTroopInput`), battle result popup. *(deps: P2.7, P2.8, P2.9, P2.13)*
- [ ] P2.16 Activity screen: 4 tabs, feed (30 s refresh while visible), rankings, my stats, season history. *(deps: P2.9, P2.13)*
- [ ] P2.17 Chat screen: member list, message list with near-bottom autoscroll rule (script.js 1600–1651), emoji row, composer (Enter-to-send, Shift+Enter newline), 4 s polling while visible. *(deps: P2.13)*
- [ ] P2.18 Admin screen: season info + force-finish, world controls (reset world/resources/force tick), player list editors (role/faction/soldiers/resources/reset), territory editors (owner/defense/capital) with the same confirm() prompts (script.js 1714–2036). *(deps: P2.13)*
- [ ] P2.19 Port `style.css` fully (module or global css per screen); visual parity pass vs. legacy game running locally. *(deps: P2.11–P2.18)*
- [ ] P2.20 Mock-mode walkthrough test (Playwright against `NEXT_PUBLIC_API_MODE=mock`): full flow auth→gate→train→attack→chat. *(deps: P2.19)*

## Phase 3 — Backend `apps/api` + Supabase

### foundation
- [ ] P3.1 Supabase project + `supabase/migrations/0001_init.sql` exactly per Arch §4; enable RLS deny-all; document session-mode `DATABASE_URL` requirement. Verification: schema-diff script vs. legacy `npm run db:init` database (column-by-column, excluding intentional deltas listed in Arch §4).
- [ ] P3.2 `database/` module: pg Pool provider, `query`/`withClient`/`withTransaction` helpers (port db.js 44–52 + `runAdminTransaction`); config validation (env: `DATABASE_URL`, `JWT_SECRET` prod check from auth.js 9–15, `ADMIN_BOOTSTRAP_TOKEN`, `TRUST_PROXY_HOPS`). *(deps: P3.1)*
- [ ] P3.3 `cli/db-init.ts`: run migrations check + seed world from game-content when `territories` empty (port db.js `seedWorldIfEmpty` + topology-sql), set `topology_version`. *(deps: P3.2, P1.2)*

### modules (port with their tests; old test files noted)
- [ ] P3.4 Auth module: register/login/me controllers + JWT strategy + guards (`JwtAuthGuard`, `AdminGuard` re-checking DB role per request like server.js 193–205). Same bcrypt/JWT params. Tests: `auth_bcrypt.test.js`, relevant parts of `frontend_session.test.js` server behavior, `admin_bootstrap.test.js` for policy. *(deps: P3.2)*
- [ ] P3.5 Seasons module: port `season.js` whole (rollover, `createSeasonRow`, `resetSeasonalGameplay`, `ensurePlayerFactionAssignment`, scoring) + season-context middleware + `PlayableSeasonGuard` (409/403 codes per Contract) + `POST /season/join` + `GET /game/season-history`. Tests: `season.test.js`, `season_time` drop, `preseason.test.js`, `map_rotation.test.js` (port fake client from `tests/helpers/season-test-client.js`). *(deps: P3.4, P1.2)*
- [ ] P3.6 World/snapshot module: `getTerritoriesSnapshot` (camelCase-only DTO), `getPlayerWorldState`, `buildSeasonSummary`, `GET /game/state` (incl. pre-join empty-world variant, server.js 693–722), `GET /world/map/:mapKey`, `GET /health`. Tests: `authoritative_game.test.js`, `db_topology_migration.test.js`. *(deps: P3.5)*
- [ ] P3.7 Economy module: upgrade-building + train-soldiers endpoints (server.js 762–819), offline catch-up on snapshot read (`applyOfflineResourceEarnings` port incl. 12 h cap and no-faction reset branch), 60 s resource-tick cron (`runGlobalResourceTick` port). Tests: `resource_earnings.test.js`, `production_preseason_upgrade.test.js`, `new_features.test.js` (economy parts). *(deps: P3.6)*
- [ ] P3.8 Combat module: `performAttack` port (advisory lock, adjacency SQL, loot, battle_history) + defend + recall endpoints (server.js 821–973) + garrison service (DB parts of defender-garrisons.js). Tests: `attack_logic.test.js`, `defender` sections of `new_features.test.js`, `resolve_battle.test.js` is NOT ported (dead feature). *(deps: P3.7)*
- [ ] P3.9 Activity module: battles feed + activity-stats endpoints + `player-season-stats.js` port (recordBattleStats wired into combat). Tests: `player_season_stats.test.js`. *(deps: P3.8)*
- [ ] P3.10 Chat module: 3 endpoints + `@Throttle` 10/min on send + global rate limit 120/min (main.ts). Tests: `faction_chat.test.js`, `trust_proxy.test.js` equivalent for proxy config. *(deps: P3.5)*
- [ ] P3.11 Admin module: all 14 admin routes + audit logging + resets + faction change + capital + leader ops (ports of admin-write-operations/admin-resets/admin-faction-change). Tests: `admin_write_operations.test.js`, `admin_resets.test.js`, `admin_faction_change.test.js`. *(deps: P3.8)*
- [ ] P3.12 Realtime gateway: socket.io, JWT handshake (`auth.token`), `state:changed {revision}`; state-change interceptor on mutating 2xx responses (port of server.js 94–105) + emit from tick/rollover. Tests: `realtime_info.test.js`. *(deps: P3.6)*
- [ ] P3.13 `cli/bootstrap-admin.ts`: port admin-bootstrap.js (token check, promote `Sai`). Tests: `admin_bootstrap.test.js`. *(deps: P3.4)*
- [ ] P3.14 Integration smoke test against a real Postgres (local docker or Supabase branch): register→join→train→attack race (two concurrent attacks on one territory → one 409)→chat→force-finish→new season gate. *(deps: P3.11, P3.12)*

## Phase 4 — Integration

- [ ] P4.1 CORS + env wiring: API allows web origin; web `NEXT_PUBLIC_API_MODE=http`, `NEXT_PUBLIC_API_URL`; socket.io-client connect to API host. *(deps: P2.20, P3.14)*
- [ ] P4.2 Contract conformance sweep: run the web app against the real API; fix mismatches on whichever side violates the Contract; update mocks/fixtures to match any contract corrections. *(deps: P4.1)*
- [ ] P4.3 Playwright e2e vs. staging: auth, gate join, train, attack neutral adjacent territory, feed entry appears, chat send/receive, admin force-finish (with `Sai`). *(deps: P4.2)*
- [ ] P4.4 Realtime verification: two browser sessions; action in one triggers snapshot refresh in the other ≤2 s. *(deps: P4.2)*

## Phase 5 — Cutover

- [ ] P5.1 Decide fresh-world vs. data copy (default: fresh world at a season boundary). If copying: write + test the transform-load script (skip `attack_contributions`/`attack_targets`, cast text→jsonb columns). 
- [ ] P5.2 Production Supabase: apply migrations, run db-init seed, register + bootstrap `Sai`. *(deps: P5.1)*
- [ ] P5.3 Deploy API (host + systemd/container), deploy web (Vercel/static), health checks, env secrets set (`JWT_SECRET` strong, `ADMIN_BOOTSTRAP_TOKEN`, `TRUST_PROXY_HOPS` for new topology). *(deps: P5.2)*
- [ ] P5.4 New CI/CD workflows per app replacing `.github/workflows/deploy.yml`; delete the `__BUILD_VERSION__` sed mechanism. *(deps: P5.3)*
- [ ] P5.5 DNS/Cloudflare cutover at season boundary; monitor first rollover + resource ticks in production; archive the legacy repo with a pointer README. *(deps: P5.4)*

## Phase 6 — Post-split (optional)

- [ ] P6.1 Remove tombstone endpoints and decide `faction_leaders`/leader-role feature (keep or drop; if drop: migration + admin UI removal + contract bump).
- [ ] P6.2 Godot prep: publish game-content JSON export (`P1.8`) as build artifact; document the mapScene draw-op schema for Node2D consumption.
- [ ] P6.3 Scoped realtime events (per-faction/per-player channels) replacing global broadcast; contract bump + mock update.
- [ ] P6.4 Evaluate Supabase Auth/RLS adoption (only if a second API consumer appears).

## Docs maintenance

- [ ] D.1 After each phase: update the Contract with any corrections discovered, regenerate mock fixtures, and record deviations in a `docs/CHANGELOG.md` in the new monorepo.
