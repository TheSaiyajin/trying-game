const fs = require('fs');
const path = require('path');
const { logAdminAction } = require('./admin-write-operations');
const { clearPlayerStationedDefenders } = require('./defender-garrisons');
const mapRegistry = require('../map-registry');
const topologySql = require('./topology-sql');

const STARTING_PLAYER_RESOURCES = Object.freeze({
  food: 500,
  wood: 400,
  iron: 300,
  manpower: 250,
  soldiers: 100,
});

const STARTING_BUILDING_LEVELS = Object.freeze({
  farm: 1,
  lumbermill: 1,
  ironmine: 1,
  barracks: 1,
  storage: 1,
});

function getWorldResetSeedSql(seedSql = null) {
  const rawSeed = seedSql ?? fs.readFileSync(path.join(__dirname, 'world-seed.sql'), 'utf8');
  const seedLines = rawSeed.split('\n').filter((line) => {
    const trimmed = line.trim().toUpperCase();
    return !(trimmed.startsWith('DELETE FROM PLAYERS')
      || trimmed.startsWith('DELETE FROM BUILDINGS')
      || trimmed.startsWith('DELETE FROM ATTACK_CONTRIBUTIONS')
      || trimmed.startsWith('DELETE FROM ATTACK_TARGETS')
      || trimmed.startsWith('DELETE FROM TERRITORY_NEIGHBORS')
      || trimmed.startsWith('DELETE FROM TERRITORIES'));
  });
  return seedLines.join('\n');
}

async function applyWorldSeed(client, options = {}) {
  if (options.seedSql) {
    await client.query(getWorldResetSeedSql(options.seedSql));
    return;
  }
  const active = await client.query(`SELECT map_key FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1`);
  const selectedMap = mapRegistry.getMap(options.mapKey || active.rows[0]?.map_key);
  await client.query(topologySql.buildTerritoryValuesSQL(selectedMap.key));
  await client.query(topologySql.buildNeighborValuesSQL(selectedMap.key));
  await client.query(
    `INSERT INTO topology_version (id, version, map_key) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, map_key = EXCLUDED.map_key, updated_at = NOW()`,
    [selectedMap.topology.TOPOLOGY_VERSION, selectedMap.key]
  );
}

async function runAdminTransaction(client, operation) {
  await client.query('BEGIN');
  try {
    const result = await operation();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Preserve the original failure.
    }
    throw error;
  }
}

async function resetPlayerProgress(client, { actorId, playerId }) {
  const existing = await client.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
  if (!existing.rowCount) {
    return { ok: false, status: 404, error: 'Player not found.' };
  }

  await clearPlayerStationedDefenders(client, playerId);

  await client.query(
    `UPDATE players
     SET resource_food = $1,
         resource_wood = $2,
         resource_iron = $3,
         resource_manpower = $4,
         soldiers = $5,
         last_action_at = NOW(),
         resource_last_updated = NOW()
     WHERE id = $6`,
    [
      STARTING_PLAYER_RESOURCES.food,
      STARTING_PLAYER_RESOURCES.wood,
      STARTING_PLAYER_RESOURCES.iron,
      STARTING_PLAYER_RESOURCES.manpower,
      STARTING_PLAYER_RESOURCES.soldiers,
      playerId,
    ]
  );
  await client.query(
    `UPDATE buildings
     SET farm = $1,
         lumbermill = $2,
         ironmine = $3,
         barracks = $4,
         storage = $5,
         updated_at = NOW()
       WHERE player_id = $6`,
    [
      STARTING_BUILDING_LEVELS.farm,
      STARTING_BUILDING_LEVELS.lumbermill,
      STARTING_BUILDING_LEVELS.ironmine,
      STARTING_BUILDING_LEVELS.barracks,
      STARTING_BUILDING_LEVELS.storage,
      playerId,
    ]
  );
  await logAdminAction(client, actorId, 'reset_player', { playerId });
  return { ok: true, playerId };
}

async function resetAllPlayerResources(client, { actorId }) {
  const playerResult = await client.query('SELECT id FROM players FOR UPDATE');
  for (const player of playerResult.rows) {
    await clearPlayerStationedDefenders(client, player.id);
  }

  await client.query(
    `UPDATE players
     SET resource_food = $1,
         resource_wood = $2,
         resource_iron = $3,
         resource_manpower = $4,
         soldiers = $5,
         last_action_at = NOW(),
         resource_last_updated = NOW()`,
    [
      STARTING_PLAYER_RESOURCES.food,
      STARTING_PLAYER_RESOURCES.wood,
      STARTING_PLAYER_RESOURCES.iron,
      STARTING_PLAYER_RESOURCES.manpower,
      STARTING_PLAYER_RESOURCES.soldiers,
    ]
  );
  await logAdminAction(client, actorId, 'reset_all_resources', { scope: 'all_players_resources_and_soldiers' });
  return { ok: true };
}

async function resetWorldState(client, { actorId, applyWorldSeedFn = applyWorldSeed } = {}) {
  await client.query('DELETE FROM attack_contributions');
  await client.query('DELETE FROM attack_targets');
  await client.query('DELETE FROM territory_defenders');
  await client.query('DELETE FROM battle_history');
  await client.query('DELETE FROM territory_neighbors');
  await client.query('DELETE FROM territories');

  await client.query(
    `UPDATE players
     SET resource_food = $1,
         resource_wood = $2,
         resource_iron = $3,
         resource_manpower = $4,
         soldiers = $5,
         last_action_at = NOW(),
         resource_last_updated = NOW()`,
    [
      STARTING_PLAYER_RESOURCES.food,
      STARTING_PLAYER_RESOURCES.wood,
      STARTING_PLAYER_RESOURCES.iron,
      STARTING_PLAYER_RESOURCES.manpower,
      STARTING_PLAYER_RESOURCES.soldiers,
    ]
  );
  await client.query(
    `UPDATE buildings
     SET farm = $1,
         lumbermill = $2,
         ironmine = $3,
         barracks = $4,
         storage = $5,
         updated_at = NOW()`,
    [
      STARTING_BUILDING_LEVELS.farm,
      STARTING_BUILDING_LEVELS.lumbermill,
      STARTING_BUILDING_LEVELS.ironmine,
      STARTING_BUILDING_LEVELS.barracks,
      STARTING_BUILDING_LEVELS.storage,
    ]
  );

  await applyWorldSeedFn(client);
  await logAdminAction(client, actorId, 'reset_world', { preservedAccounts: true });
  return { ok: true };
}

function getSeasonResetPlan() {
  return {
    preserve: ['player_accounts', 'usernames', 'password_hashes', 'account_ids', 'admin_roles'],
    reset: ['seasonal_rankings', 'seasonal_leaderboards', 'seasonal_progression'],
    undecided: ['battle_history_retention', 'territory_ownership_retention', 'resource_carryover_rules'],
  };
}

module.exports = {
  STARTING_PLAYER_RESOURCES,
  STARTING_BUILDING_LEVELS,
  getWorldResetSeedSql,
  applyWorldSeed,
  runAdminTransaction,
  resetPlayerProgress,
  resetAllPlayerResources,
  resetWorldState,
  getSeasonResetPlan,
};
