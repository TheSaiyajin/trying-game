const test = require('node:test');
const assert = require('node:assert/strict');
const mapRegistry = require('../map-registry');
const crownlands = require('../crownlands-topology');
const { computeScores } = require('../backend/season');

test('map rotation preserves Three Frontiers and selects Crownlands 64 next', () => {
  assert.deepEqual(mapRegistry.maps, [
    { key: 'three-frontiers', name: 'Three Frontiers' },
    { key: 'crownlands-64', name: 'Crownlands 64' },
  ]);
  assert.equal(mapRegistry.getNextMapKey('three-frontiers'), 'crownlands-64');
  assert.equal(mapRegistry.getMap('crownlands-64').topology.buildTerritories().length, 64);
});

test('Crownlands topology is connected and its central Crown has authoritative score metadata', () => {
  const territories = crownlands.buildTerritories();
  const adjacency = new Map(territories.map((territory) => [territory.id, []]));
  crownlands.buildEdges().forEach(([left, right]) => {
    adjacency.get(left).push(right);
    adjacency.get(right).push(left);
  });
  const visited = new Set([territories[0].id]);
  const queue = [territories[0].id];
  while (queue.length) {
    adjacency.get(queue.shift()).forEach((neighbor) => {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    });
  }

  assert.equal(visited.size, 64);
  assert.equal(territories.find((territory) => territory.id === 'c1').scoreValue, 3);
  assert.deepEqual(computeScores([
    { id: 'c1', owner_faction: 'green', is_capital: false, score_value: 3 },
  ]), { blue: 0, red: 0, green: 3 });
});