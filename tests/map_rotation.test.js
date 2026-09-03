const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mapRegistry = require('../map-registry');
const crownlands = require('../crownlands-topology');
const {
  computeScores,
  ensureCurrentSeason,
  ensurePlayerFactionAssignment,
  forceFinishCurrentSeason,
  getFactionCityTiles,
} = require('../backend/season');
const { createSeasonTestClient } = require('./helpers/season-test-client');

function buildPlayers(count) {
  return new Map(Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    return [id, {
      id,
      username: `Player${id}`,
      faction: null,
      faction_locked: false,
      role: 'member',
      resource_food: 500,
      resource_wood: 400,
      resource_iron: 300,
      resource_manpower: 250,
      soldiers: 100,
    }];
  }));
}

function buildTerritoryMap(topology) {
  return new Map(topology.buildTerritories().map((territory) => [territory.id, {
    id: territory.id,
    owner_faction: territory.ownerFaction,
    is_capital: territory.isCapital,
    score_value: territory.scoreValue,
  }]));
}

function buildAdjacency(edges) {
  const adjacency = {};
  edges.forEach(([a, b]) => {
    (adjacency[a] = adjacency[a] || []).push(b);
    (adjacency[b] = adjacency[b] || []).push(a);
  });
  return adjacency;
}

function segmentsProperlyIntersect(p1, p2, p3, p4) {
  const cross = (o, a, b) => ((a.cx - o.cx) * (b.cy - o.cy)) - ((a.cy - o.cy) * (b.cx - o.cx));
  const straddles = (x, y) => (x > 0 && y < 0) || (x < 0 && y > 0);
  return straddles(cross(p3, p4, p1), cross(p3, p4, p2))
    && straddles(cross(p1, p2, p3), cross(p1, p2, p4));
}

test('map registry permanently keeps the original map and Crownlands 64', () => {
  assert.deepEqual(mapRegistry.maps, [
    { key: 'three-frontiers', name: 'Three Frontiers' },
    { key: 'crownlands-64', name: 'Crownlands 64' },
  ]);
  assert.equal(mapRegistry.getMap('three-frontiers').topology.buildTerritories().length, 33);
  assert.equal(mapRegistry.getMap('crownlands-64').topology.buildTerritories().length, 64);
  assert.equal(mapRegistry.getNextMapKey('three-frontiers'), 'crownlands-64');
  assert.equal(mapRegistry.getNextMapKey('crownlands-64'), 'three-frontiers');
});

test('Crownlands has three mirrored 21-tile regions and one central Crown', () => {
  const territories = crownlands.buildTerritories();
  assert.equal(territories.length, 64);
  assert.equal(territories.filter((territory) => territory.isCapital).length, 3);
  assert.equal(territories.filter((territory) => territory.ownerFaction === 'neutral').length, 61);
  assert.equal(territories.find((territory) => territory.id === 'c1').scoreValue, 3);

  const expectedBonuses = crownlands.REGION_IDS.blue.map((id) => territories.find((territory) => territory.id === id).bonusType);
  for (const faction of crownlands.FACTIONS) {
    const region = crownlands.REGION_IDS[faction].map((id) => territories.find((territory) => territory.id === id));
    assert.equal(region.length, 20);
    assert.deepEqual(region.map((territory) => territory.bonusType), expectedBonuses);
    assert.equal(region.filter((territory) => territory.bonusType === 'food').length, 2);
    assert.equal(region.filter((territory) => territory.bonusType === 'wood').length, 2);
    assert.equal(region.filter((territory) => territory.bonusType === 'iron').length, 2);
    assert.equal(region.filter((territory) => territory.bonusType === 'manpower').length, 2);
    assert.equal(region.filter((territory) => territory.bonusType === 'attack').length, 2);
    assert.equal(region.filter((territory) => territory.bonusType === 'defense').length, 2);
    assert.equal(region.filter((territory) => territory.isFortress).length, 2);
  }
});

test('Crownlands is connected, rotationally equal, spaced, and has no crossed routes', () => {
  const territories = crownlands.buildTerritories();
  const edges = crownlands.buildEdges();
  const adjacency = buildAdjacency(edges);
  const visited = new Set([territories[0].id]);
  const queue = [territories[0].id];
  while (queue.length) {
    for (const neighbor of adjacency[queue.shift()] || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  assert.equal(visited.size, 64);

  const edgeSet = new Set(edges.map(([a, b]) => [a, b].sort().join('|')));
  const rotation = crownlands.buildRotationMap();
  edges.forEach(([a, b]) => assert.ok(edgeSet.has([rotation[a], rotation[b]].sort().join('|'))));

  const layout = crownlands.buildLayout();
  const ids = Object.keys(layout);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      assert.ok(Math.hypot(layout[ids[i]].cx - layout[ids[j]].cx, layout[ids[i]].cy - layout[ids[j]].cy) >= 54);
    }
  }
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const [a, b] = edges[i];
      const [c, d] = edges[j];
      if (new Set([a, b, c, d]).size < 4) continue;
      assert.equal(segmentsProperlyIntersect(layout[a], layout[b], layout[c], layout[d]), false, `${a}-${b} crosses ${c}-${d}`);
    }
  }
});

test('season rollover alternates maps without changing the currently running map', async () => {
  const classic = mapRegistry.getMap('three-frontiers').topology;
  const client = createSeasonTestClient({ players: buildPlayers(0), territories: buildTerritoryMap(classic) });
  const first = await ensureCurrentSeason(client, { now: new Date('2026-01-01T00:00:00Z') });
  assert.equal(first.map_key, 'three-frontiers');
  assert.equal(client.state.territories.size, 33);

  const secondResult = await forceFinishCurrentSeason(client, { actorId: 1, now: new Date('2026-01-02T00:00:00Z') });
  assert.equal(secondResult.season.map_key, 'crownlands-64');
  assert.equal(client.state.territories.size, 64);

  const thirdResult = await forceFinishCurrentSeason(client, { actorId: 1, now: new Date('2026-01-03T00:00:00Z') });
  assert.equal(thirdResult.season.map_key, 'three-frontiers');
  assert.equal(client.state.territories.size, 33);
});

test('joining creates one private city tile and faction queries never expose enemy cities', async () => {
  const players = buildPlayers(4);
  const client = createSeasonTestClient({ players, territories: buildTerritoryMap(mapRegistry.getMap('three-frontiers').topology) });
  const season = await ensureCurrentSeason(client, { now: new Date('2026-01-01T00:00:00Z') });
  for (let playerId = 1; playerId <= 4; playerId += 1) {
    await ensurePlayerFactionAssignment(client, { seasonId: season.id, playerId });
  }

  assert.equal(client.state.factionCityTiles.length, 4);
  const blueCities = await getFactionCityTiles(client, { seasonId: season.id, faction: 'blue' });
  assert.deepEqual(blueCities.map((city) => city.playerId), [1, 4]);
  assert.deepEqual(blueCities.map((city) => city.slotIndex), [0, 1]);
  assert.ok(blueCities.every((city) => city.faction === 'blue'));

  await ensurePlayerFactionAssignment(client, { seasonId: season.id, playerId: 1 });
  assert.equal(client.state.factionCityTiles.length, 4, 'rejoining must not duplicate a city tile');
});

test('map UI separates the war map from non-combat faction city tiles', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.match(html, /Faction Homeland/);
  assert.match(html, /id="faction-map-svg"/);
  assert.match(html, /cannot be attacked and provide no score/);
  assert.match(script, /function renderFactionMap\(/);
  assert.match(script, /faction-city-tile/);
  assert.match(server, /getFactionCityTiles/);
  assert.match(server, /mapName/);
});

test('existing databases migrate season maps and faction city tiles idempotently', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'backend', 'schema.sql'), 'utf8');
  const migrations = fs.readFileSync(path.join(__dirname, '..', 'backend', 'db.js'), 'utf8');
  assert.match(schema, /map_key VARCHAR\(64\) NOT NULL DEFAULT 'three-frontiers'/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS faction_city_tiles/);
  assert.match(schema, /score_value INTEGER NOT NULL DEFAULT 1/);
  assert.match(migrations, /ALTER TABLE seasons ADD COLUMN IF NOT EXISTS map_key/);
  assert.match(migrations, /CREATE TABLE IF NOT EXISTS faction_city_tiles/);
  assert.match(migrations, /WHERE tile\.player_id IS NULL/);
});

test('Crown score comes from map data instead of hard-coded classic IDs', () => {
  assert.deepEqual(computeScores([
    { id: 'c1', owner_faction: 'green', is_capital: false, score_value: 3 },
    { id: 'b2', owner_faction: 'blue', is_capital: false, score_value: 1 },
  ]), { blue: 1, red: 0, green: 3 });
});
