const { distributeProportionally } = require('./player-season-stats');

const SUPPLY_ATTRITION_INTERVAL_MS = 10 * 60 * 1000;
const SUPPLY_ATTRITION_RATE = 0.05;
const SUPPLY_FACTIONS = new Set(['blue', 'red', 'green']);

function computeSuppliedTerritoryIds(territories) {
  const byId = new Map(territories.map((territory) => [territory.id, territory]));
  const supplied = new Set();
  const queue = territories.filter((territory) => (
    territory.is_capital && SUPPLY_FACTIONS.has(territory.owner_faction)
  )).map((territory) => territory.id);

  for (const territoryId of queue) supplied.add(territoryId);
  for (let index = 0; index < queue.length; index += 1) {
    const territory = byId.get(queue[index]);
    for (const neighborId of territory.neighbors || []) {
      const neighbor = byId.get(neighborId);
      if (!neighbor || supplied.has(neighborId)) continue;
      if (neighbor.owner_faction !== territory.owner_faction) continue;
      supplied.add(neighborId);
      queue.push(neighborId);
    }
  }
  return supplied;
}

function calculateSupplyAttritionLoss(totalStationed) {
  const troops = Math.max(0, Math.floor(Number(totalStationed) || 0));
  return troops > 0 ? Math.max(1, Math.ceil(troops * SUPPLY_ATTRITION_RATE)) : 0;
}

function getDueAttritionAt(territory) {
  const previousTick = territory.last_supply_attrition_at || territory.supply_cut_since;
  if (!previousTick) return null;
  return new Date(new Date(previousTick).getTime() + SUPPLY_ATTRITION_INTERVAL_MS);
}

async function processTerritorySupply(client, territory, { supplied, activeBattle, now }) {
  const hasSupplyState = territory.supply_cut_since || territory.last_supply_attrition_at;
  if (territory.is_capital || supplied || !SUPPLY_FACTIONS.has(territory.owner_faction)) {
    if (!hasSupplyState) return { changed: false, troopsLost: 0 };
    await client.query(
      'UPDATE territories SET supply_cut_since = NULL, last_supply_attrition_at = NULL WHERE id = $1',
      [territory.id]
    );
    return { changed: true, troopsLost: 0 };
  }

  if (!territory.supply_cut_since) {
    await client.query(
      'UPDATE territories SET supply_cut_since = $1, last_supply_attrition_at = NULL WHERE id = $2',
      [now, territory.id]
    );
    return { changed: true, troopsLost: 0 };
  }

  const dueAt = getDueAttritionAt(territory);
  if (activeBattle || !dueAt || now < dueAt) return { changed: false, troopsLost: 0 };

  const defendersResult = await client.query(
    `SELECT territory_id, player_id, faction, troops
     FROM territory_defenders
     WHERE territory_id = $1 AND faction = $2
     ORDER BY player_id
     FOR UPDATE`,
    [territory.id, territory.owner_faction]
  );
  const totalStationed = defendersResult.rows.reduce((sum, defender) => sum + Number(defender.troops), 0);
  const troopsLost = calculateSupplyAttritionLoss(totalStationed);
  const losses = distributeProportionally(troopsLost, defendersResult.rows);
  for (const defender of defendersResult.rows) {
    const loss = losses.get(Number(defender.player_id)) || 0;
    if (loss > 0) {
      await client.query(
        'UPDATE territory_defenders SET troops = troops - $1, updated_at = NOW() WHERE territory_id = $2 AND player_id = $3',
        [loss, territory.id, defender.player_id]
      );
    }
  }
  await client.query('DELETE FROM territory_defenders WHERE territory_id = $1 AND troops <= 0', [territory.id]);
  await client.query(
    `UPDATE territories
     SET defense_troops = GREATEST(0, defense_troops - $1), last_supply_attrition_at = $2
     WHERE id = $3`,
    [troopsLost, dueAt, territory.id]
  );
  return { changed: true, troopsLost };
}

async function runSupplyLineCheck(client, { now = new Date() } = {}) {
  await client.query('BEGIN');
  try {
    const territoryResult = await client.query(
      `SELECT id, owner_faction, is_capital, supply_cut_since, last_supply_attrition_at
       FROM territories
       ORDER BY id
       FOR UPDATE`
    );
    const neighborResult = await client.query(
      'SELECT territory_id, neighbor_id FROM territory_neighbors ORDER BY territory_id, neighbor_id'
    );
    const activeResult = await client.query('SELECT territory_id FROM attack_targets');
    const neighborsById = new Map();
    for (const row of neighborResult.rows) {
      if (!neighborsById.has(row.territory_id)) neighborsById.set(row.territory_id, []);
      neighborsById.get(row.territory_id).push(row.neighbor_id);
    }
    const territories = territoryResult.rows.map((territory) => ({
      ...territory,
      neighbors: neighborsById.get(territory.id) || [],
    }));
    const suppliedIds = computeSuppliedTerritoryIds(territories);
    const activeIds = new Set(activeResult.rows.map((row) => row.territory_id));
    let changed = false;
    let troopsLost = 0;
    for (const territory of territories) {
      const result = await processTerritorySupply(client, territory, {
        supplied: suppliedIds.has(territory.id),
        activeBattle: activeIds.has(territory.id),
        now,
      });
      changed = changed || result.changed;
      troopsLost += result.troopsLost;
    }
    await client.query('COMMIT');
    return { changed, troopsLost, suppliedIds };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

module.exports = {
  SUPPLY_ATTRITION_INTERVAL_MS,
  computeSuppliedTerritoryIds,
  calculateSupplyAttritionLoss,
  getDueAttritionAt,
  processTerritorySupply,
  runSupplyLineCheck,
};