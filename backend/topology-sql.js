// Generates SQL for the canonical world topology (world-topology.js) so the fresh-install
// seed (world-seed.sql), the legacy-topology migration, and any manual re-seeding all use
// the exact same territory/neighbor data — never hand-authored SQL that can drift.
const mapRegistry = require('../map-registry');

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlBool(value) {
  return value ? 'TRUE' : 'FALSE';
}

function getTopology(mapKey) {
  return mapRegistry.getMap(mapKey).topology;
}

function buildTerritoryRows(mapKey = mapRegistry.DEFAULT_MAP_KEY) {
  const topology = getTopology(mapKey);
  const layout = topology.buildLayout();
  return topology.buildTerritories().map((t) => (
    `  (${sqlString(t.id)}, ${sqlString(t.name)}, ${sqlString(t.ownerFaction)}, ${t.defense}, `
    + `${sqlString(t.bonusType)}, ${t.bonusValue}, ${sqlBool(t.isFortress)}, ${sqlBool(t.isCapital)}, `
    + `${t.resourceBonus}, ${t.storageBonus}, ${Number(t.scoreValue ?? (t.isCapital ? 0 : 1))}, `
    + `${Number(layout[t.id]?.cx || 0)}, ${Number(layout[t.id]?.cy || 0)})`
  ));
}

function buildTerritoryValuesSQL(mapKey = mapRegistry.DEFAULT_MAP_KEY) {
  const header = 'INSERT INTO territories (id, name, owner_faction, defense_troops, bonus_type, bonus_value, is_fortress, is_capital, resource_bonus, storage_bonus, score_value, map_x, map_y) VALUES';
  return `${header}\n${buildTerritoryRows(mapKey).join(',\n')};`;
}

// Bidirectional neighbor rows (both directions of every undirected edge).
function buildNeighborRows(mapKey = mapRegistry.DEFAULT_MAP_KEY) {
  const rows = [];
  const topology = getTopology(mapKey);
  topology.buildEdges().forEach(([a, b]) => {
    rows.push([a, b]);
    rows.push([b, a]);
  });
  return rows;
}

function buildNeighborValuesSQL(mapKey = mapRegistry.DEFAULT_MAP_KEY) {
  const header = 'INSERT INTO territory_neighbors (territory_id, neighbor_id) VALUES';
  const rows = buildNeighborRows(mapKey).map(([a, b]) => `  (${sqlString(a)}, ${sqlString(b)})`);
  return `${header}\n${rows.join(',\n')};`;
}

module.exports = {
  buildTerritoryRows,
  buildTerritoryValuesSQL,
  buildNeighborRows,
  buildNeighborValuesSQL,
};
