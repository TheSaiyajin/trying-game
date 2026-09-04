const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mapRegistry = require('../map-registry');
const { applyTopologyMigrationIfNeeded } = require('../backend/db');
const {
  ensureCurrentSeason,
  ensurePlayerFactionAssignment,
  getSeasonMembership,
  hasSeasonStarted,
} = require('../backend/season');
const { createSeasonTestClient } = require('./helpers/season-test-client');

function buildPlayers() {
  return new Map([1, 2].map((id) => [id, {
    id,
    username: `Player${id}`,
    faction: null,
    faction_locked: false,
    resource_food: 500,
    resource_wood: 400,
    resource_iron: 300,
    resource_manpower: 250,
    soldiers: 100,
  }]));
}

function buildTerritories(topology) {
  return new Map(topology.buildTerritories().map((territory) => [territory.id, {
    id: territory.id,
    owner_faction: territory.ownerFaction,
    is_capital: territory.isCapital,
    score_value: Number(territory.scoreValue ?? (territory.isCapital ? 0 : 1)),
  }]));
}

test('registration season survives a later full indev startup without duplicate rollover or lost joins', async () => {
  const classic = mapRegistry.getMap('three-frontiers').topology;
  const client = createSeasonTestClient({ players: buildPlayers(), territories: buildTerritories(classic) });
  const firstSeason = await ensureCurrentSeason(client, { now: new Date('2026-10-01T00:00:00Z') });

  const rolloverAt = new Date(firstSeason.ends_at);
  const registrationSeason = await ensureCurrentSeason(client, { now: rolloverAt });
  assert.equal(registrationSeason.map_key, 'crownlands-64');
  assert.equal(client.state.territories.size, 64);
  assert.deepEqual(client.state.topologyVersion, { version: 1, map_key: 'crownlands-64' });
  assert.equal(hasSeasonStarted(registrationSeason, rolloverAt), false);

  await ensurePlayerFactionAssignment(client, {
    seasonId: registrationSeason.id,
    playerId: 1,
    resourceStartAt: registrationSeason.starts_at,
  });
  await ensurePlayerFactionAssignment(client, {
    seasonId: registrationSeason.id,
    playerId: 2,
    resourceStartAt: registrationSeason.starts_at,
  });
  const membershipsBeforeDeploy = structuredClone(client.state.seasonMemberships);

  const topologyCheck = await applyTopologyMigrationIfNeeded(client);
  const seasonAfterDeploy = await ensureCurrentSeason(client, {
    now: new Date(new Date(registrationSeason.starts_at).getTime() - 1),
  });

  assert.equal(topologyCheck.migrated, false);
  assert.equal(topologyCheck.mapKey, 'crownlands-64');
  assert.equal(seasonAfterDeploy.id, registrationSeason.id);
  assert.equal(client.state.seasons.length, 2);
  assert.deepEqual(client.state.seasonMemberships, membershipsBeforeDeploy);
  assert.equal(client.state.territories.size, 64);
  assert.deepEqual(await getSeasonMembership(client, registrationSeason.id, 1), { faction: 'blue' });

  const atStart = new Date(registrationSeason.starts_at);
  const playableSeason = await ensureCurrentSeason(client, { now: atStart });
  assert.equal(playableSeason.id, registrationSeason.id);
  assert.equal(hasSeasonStarted(playableSeason, atStart), true);
  assert.equal(client.state.seasons.length, 2);
  assert.deepEqual(client.state.seasonMemberships, membershipsBeforeDeploy);
});

test('production schema is additive and matches indev map identifiers', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../backend/schema.sql'), 'utf8');
  const migrations = fs.readFileSync(path.join(__dirname, '../backend/db.js'), 'utf8');

  assert.deepEqual(mapRegistry.maps, [
    { key: 'three-frontiers', name: 'Three Frontiers' },
    { key: 'crownlands-64', name: 'Crownlands 64' },
  ]);
  assert.match(schema, /map_key VARCHAR\(64\) NOT NULL DEFAULT 'three-frontiers'/);
  assert.match(migrations, /ALTER TABLE seasons ADD COLUMN IF NOT EXISTS map_key/);
  assert.match(migrations, /ALTER TABLE territories ADD COLUMN IF NOT EXISTS score_value/);
  assert.match(migrations, /ALTER TABLE topology_version ADD COLUMN IF NOT EXISTS map_key/);
  assert.doesNotMatch(migrations, /["'`]\s*(?:DROP TABLE|DELETE FROM players|UPDATE players SET password_hash)/i);
});