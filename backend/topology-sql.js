// Generates SQL for the canonical world topology (world-topology.js) so the fresh-install
// seed (world-seed.sql), the legacy-topology migration, and any manual re-seeding all use
// the exact same territory/neighbor data — never hand-authored SQL that can drift.
const topology = require('../world-topology');

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlBool(value) {
  return value ? 'TRUE' : 'FALSE';
}

function buildTerritoryRows() {
  return topology.buildTerritories().map((t) => (
    `  (${sqlString(t.id)}, ${sqlString(t.name)}, ${sqlString(t.ownerFaction)}, ${t.defense}, `
    + `${sqlString(t.bonusType)}, ${t.bonusValue}, ${sqlBool(t.isFortress)}, ${sqlBool(t.isCapital)}, `
    + `${t.resourceBonus}, ${t.storageBonus})`
  ));
}

function buildTerritoryValuesSQL() {
  const header = 'INSERT INTO territories (id, name, owner_faction, defense_troops, bonus_type, bonus_value, is_fortress, is_capital, resource_bonus, storage_bonus) VALUES';
  return `${header}\n${buildTerritoryRows().join(',\n')};`;
}

// Bidirectional neighbor rows (both directions of every undirected edge).
function buildNeighborRows() {
  const rows = [];
  topology.buildEdges().forEach(([a, b]) => {
    rows.push([a, b]);
    rows.push([b, a]);
  });
  return rows;
}

function buildNeighborValuesSQL() {
  const header = 'INSERT INTO territory_neighbors (territory_id, neighbor_id) VALUES';
  const rows = buildNeighborRows().map(([a, b]) => `  (${sqlString(a)}, ${sqlString(b)})`);
  return `${header}\n${rows.join(',\n')};`;
}

module.exports = {
  buildTerritoryRows,
  buildTerritoryValuesSQL,
  buildNeighborRows,
  buildNeighborValuesSQL,
};
