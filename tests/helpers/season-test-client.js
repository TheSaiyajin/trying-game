const DAY_MS = 24 * 60 * 60 * 1000;

function normalize(sql) {
  return sql.trim().replace(/\s+/g, ' ');
}

// Simulates a real Postgres transaction-scoped advisory lock: concurrent "connections"
// sharing this fake client actually serialize (FIFO) between pg_advisory_xact_lock and the
// matching COMMIT/ROLLBACK, exactly like real concurrent sessions would block on the lock.
function createMutex() {
  let tail = Promise.resolve();
  return {
    async acquire() {
      let release;
      const acquired = new Promise((resolve) => { release = resolve; });
      const previousTail = tail;
      tail = tail.then(() => acquired);
      await previousTail;
      return release;
    },
  };
}

// A minimal in-memory Postgres-like client covering exactly the queries season.js issues,
// so the core season logic (rollover, scoring, assignment) is fully unit-testable without a
// real database -- matching the existing style used for admin-resets/admin-write-operations.
function createSeasonTestClient({ players = new Map(), territories = new Map() } = {}) {
  const state = {
    seasons: [],
    seasonMemberships: [],
    seasonTerritoryOwnership: new Set(),
    players,
    territories,
    buildings: new Map([...players.keys()].map((id) => [id, { farm: 5, lumbermill: 5, ironmine: 5, barracks: 5 }])),
    factionLeaders: new Map([['blue', 1], ['red', 2], ['green', 3]]),
    adminActions: [],
    queryLog: [],
  };
  const mutexes = new Map();
  let pendingLockRelease = null;
  let nextSeasonId = 1;

  const client = {
    state,
    async query(sql, params = []) {
      const text = normalize(sql);
      state.queryLog.push(text);

      if (text === 'BEGIN') return { rows: [] };
      if (text === 'COMMIT' || text === 'ROLLBACK') {
        if (pendingLockRelease) {
          pendingLockRelease();
          pendingLockRelease = null;
        }
        return { rows: [] };
      }
      if (text.startsWith('SELECT pg_advisory_xact_lock')) {
        const key = params[0];
        if (!mutexes.has(key)) mutexes.set(key, createMutex());
        pendingLockRelease = await mutexes.get(key).acquire();
        return { rows: [] };
      }

      if (text.startsWith('SELECT * FROM seasons WHERE status = \'active\' ORDER BY id DESC LIMIT 1')) {
        const active = state.seasons.filter((s) => s.status === 'active').sort((a, b) => b.id - a.id);
        return { rows: active.slice(0, 1) };
      }

      if (text.startsWith('SELECT COALESCE(MAX(season_number), 0) + 1 AS next_number FROM seasons')) {
        const maxNumber = state.seasons
          .filter((s) => s.season_number > 0)
          .reduce((max, s) => Math.max(max, s.season_number), 0);
        return { rows: [{ next_number: maxNumber + 1 }] };
      }

      if (text.startsWith('INSERT INTO seasons')) {
        const [seasonNumber, startsAt, endsAt] = params;
        if (state.seasons.some((s) => s.season_number === seasonNumber)) {
          throw new Error(`duplicate key value violates unique constraint "seasons_season_number_key" (${seasonNumber})`);
        }
        const row = {
          id: nextSeasonId++,
          season_number: seasonNumber,
          starts_at: startsAt,
          ends_at: endsAt,
          status: 'active',
          blue_score: null,
          red_score: null,
          green_score: null,
          result: null,
          completed_at: null,
        };
        state.seasons.push(row);
        return { rows: [row] };
      }

      if (text.startsWith('INSERT INTO season_territory_faction_ownership')) {
        const [seasonId, validFactions] = params;
        for (const territory of state.territories.values()) {
          if (validFactions.includes(territory.owner_faction)) {
            state.seasonTerritoryOwnership.add(`${seasonId}:${territory.id}:${territory.owner_faction}`);
          }
        }
        return { rows: [] };
      }

      if (text.startsWith('SELECT id, owner_faction, is_capital FROM territories')) {
        return { rows: [...state.territories.values()] };
      }

      if (text.startsWith('SELECT faction, COUNT(*)::int AS count FROM season_memberships')) {
        const [seasonId] = params;
        const counts = new Map();
        state.seasonMemberships
          .filter((m) => m.season_id === seasonId)
          .forEach((m) => counts.set(m.faction, (counts.get(m.faction) || 0) + 1));
        return { rows: [...counts.entries()].map(([faction, count]) => ({ faction, count })) };
      }

      if (text.startsWith('SELECT faction FROM season_memberships WHERE season_id = $1 AND player_id = $2')) {
        const [seasonId, playerId] = params;
        const row = state.seasonMemberships.find((m) => m.season_id === seasonId && m.player_id === playerId);
        return { rows: row ? [{ faction: row.faction }] : [] };
      }

      if (text.startsWith('INSERT INTO season_memberships')) {
        const [seasonId, playerId, faction] = params;
        if (state.seasonMemberships.some((m) => m.season_id === seasonId && m.player_id === playerId)) {
          return { rows: [] };
        }
        state.seasonMemberships.push({ season_id: seasonId, player_id: playerId, faction, assigned_at: new Date() });
        return { rows: [] };
      }

      if (text === 'DELETE FROM attack_contributions'
        || text === 'DELETE FROM attack_targets'
        || text === 'DELETE FROM territory_defenders'
        || text === 'DELETE FROM battle_history') {
        return { rows: [] };
      }

      if (text === 'DELETE FROM territory_neighbors') {
        state.territoryNeighborsCleared = true;
        return { rows: [] };
      }

      if (text === 'DELETE FROM territories') {
        state.territories.clear();
        return { rows: [] };
      }

      if (text.startsWith('INSERT INTO territories')) {
        // Re-seed with the canonical topology (mirrors what topology-sql.js generates).
        const topology = require('../../world-topology');
        topology.buildTerritories().forEach((t) => {
          state.territories.set(t.id, { id: t.id, owner_faction: t.ownerFaction, is_capital: t.isCapital });
        });
        return { rows: [] };
      }

      if (text.startsWith('INSERT INTO territory_neighbors')) {
        state.territoryNeighborsSeeded = true;
        return { rows: [] };
      }

      if (text.startsWith('UPDATE players') && text.includes('resource_food = $1')) {
        for (const player of state.players.values()) {
          player.resource_food = params[0];
          player.resource_wood = params[1];
          player.resource_iron = params[2];
          player.resource_manpower = params[3];
          player.soldiers = params[4];
          player.faction = null;
          player.faction_locked = false;
        }
        return { rows: [] };
      }

      if (text.startsWith('UPDATE buildings')) {
        for (const building of state.buildings.values()) {
          building.farm = params[0];
          building.lumbermill = params[1];
          building.ironmine = params[2];
          building.barracks = params[3];
        }
        return { rows: [] };
      }

      if (text === 'UPDATE faction_leaders SET player_id = NULL') {
        for (const faction of state.factionLeaders.keys()) state.factionLeaders.set(faction, null);
        return { rows: [] };
      }

      if (text.startsWith('UPDATE seasons SET status = \'completed\'')) {
        const [blueScore, redScore, greenScore, result, seasonId] = params;
        const row = state.seasons.find((s) => s.id === seasonId);
        if (row) {
          row.status = 'completed';
          row.blue_score = blueScore;
          row.red_score = redScore;
          row.green_score = greenScore;
          row.result = result;
          row.completed_at = new Date();
        }
        return { rows: [] };
      }

      if (text.startsWith('UPDATE players p SET season_wins')) {
        const [seasonId, faction] = params;
        const winningPlayerIds = new Set(
          state.seasonMemberships
            .filter((m) => m.season_id === seasonId && m.faction === faction)
            .map((m) => m.player_id)
        );
        for (const [id, player] of state.players.entries()) {
          if (winningPlayerIds.has(id)) {
            player.season_wins = (player.season_wins || 0) + 1;
          }
        }
        return { rows: [] };
      }

      if (text.startsWith('UPDATE players SET faction = $1, faction_locked = TRUE, army_name = $2, resource_food = $3')) {
        const [faction, armyName, food, wood, iron, manpower, soldiers, playerId] = params;
        const player = state.players.get(playerId);
        if (player) {
          player.faction = faction;
          player.faction_locked = true;
          player.army_name = armyName;
          player.resource_food = food;
          player.resource_wood = wood;
          player.resource_iron = iron;
          player.resource_manpower = manpower;
          player.soldiers = soldiers;
          player.resource_last_updated = new Date();
        }
        return { rows: [] };
      }

      if (text.startsWith('INSERT INTO admin_actions')) {
        state.adminActions.push({ actorId: params[0], actionName: params[1], detail: JSON.parse(params[2]) });
        return { rows: [] };
      }

      throw new Error(`Unexpected query in season test client: ${text}`);
    },
  };

  return client;
}

module.exports = { createSeasonTestClient, DAY_MS };
