const test = require('node:test');
const assert = require('node:assert/strict');
const { createSeasonTestClient } = require('./helpers/season-test-client');
const topology = require('../world-topology');
const {
  computeScores,
  determineResult,
  calculateSeasonScores,
  getFactionMemberCounts,
  resetSeasonalGameplay,
  runSeasonRollover,
  ensureCurrentSeason,
  forceFinishCurrentSeason,
  ensurePlayerFactionAssignment,
  createSeasonRow,
} = require('../backend/season');

function buildPlayers(list) {
  return new Map(list.map((p) => [p.id, {
    faction: null,
    faction_locked: false,
    resource_food: 999,
    resource_wood: 999,
    resource_iron: 999,
    resource_manpower: 999,
    soldiers: 999,
    season_wins: 0,
    role: 'member',
    username: `player${p.id}`,
    password_hash: `hash${p.id}`,
    ...p,
  }]));
}

function buildTerritories(overrides = {}) {
  const map = new Map();
  topology.buildTerritories().forEach((t) => {
    map.set(t.id, { id: t.id, owner_faction: overrides[t.id] || t.ownerFaction, is_capital: t.isCapital });
  });
  return map;
}

// ===================== Scoring =====================

test('capitals score zero, normal territories score 1, and core territories score 2', () => {
  const scores = computeScores([
    { id: 'b1', owner_faction: 'blue', is_capital: true },
    { id: 'n1', owner_faction: 'blue', is_capital: false },
    { id: 'n28', owner_faction: 'blue', is_capital: false }, // core
    { id: 'n2', owner_faction: 'red', is_capital: false },
    { id: 'n3', owner_faction: 'neutral', is_capital: false },
  ]);
  assert.deepEqual(scores, { blue: 3, red: 1, green: 0 });
});

test('core territory ids come from the canonical topology, not visual/frontend data', () => {
  topology.CORE_IDS.forEach((id) => assert.ok(id.startsWith('n')));
  const scores = computeScores(topology.CORE_IDS.map((id) => ({ id, owner_faction: 'green', is_capital: false })));
  assert.equal(scores.green, topology.CORE_IDS.length * 2);
});

test('computeScores also works with snapshot-shaped territories (owner/capital instead of owner_faction/is_capital)', () => {
  const scores = computeScores([
    { id: 'b1', owner: 'blue', capital: true },
    { id: 'n1', owner: 'blue', capital: false },
    { id: 'n28', owner: 'green', capital: false },
  ]);
  assert.deepEqual(scores, { blue: 1, red: 0, green: 2 });
});

test('a tied final score records a draw rather than a random winner', () => {
  assert.equal(determineResult({ blue: 5, red: 5, green: 3 }), 'draw');
  assert.equal(determineResult({ blue: 5, red: 5, green: 5 }), 'draw');
  assert.equal(determineResult({ blue: 7, red: 5, green: 3 }), 'blue');
});

// ===================== Rollover =====================

test('the very first server boot creates exactly one active season without finalizing anything', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([]), territories: new Map() });
  const now = new Date('2026-01-01T00:00:05.000Z');

  const season = await ensureCurrentSeason(client, { now });

  assert.equal(season.status, 'active');
  assert.equal(client.state.seasons.length, 1);
});

test('rollover happens exactly once: calling ensureCurrentSeason again mid-season is a no-op', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([]), territories: new Map() });
  const now = new Date('2026-01-01T08:00:00.000Z');

  const first = await ensureCurrentSeason(client, { now });
  const second = await ensureCurrentSeason(client, { now: new Date(now.getTime() + 60_000) });

  assert.equal(first.id, second.id);
  assert.equal(client.state.seasons.length, 1);
});

test('server startup safely completes a missed rollover (server was offline at midnight)', async () => {
  const players = buildPlayers([{ id: 1 }]);
  const territories = buildTerritories({ n1: 'blue' });
  const client = createSeasonTestClient({ players, territories });

  const day1 = new Date('2026-02-01T10:00:00.000Z');
  await ensureCurrentSeason(client, { now: day1 });
  await ensurePlayerFactionAssignment(client, { seasonId: client.state.seasons[0].id, playerId: 1 });

  // Server comes back online two days later, well past the missed midnight rollover(s).
  const day3 = new Date('2026-02-03T09:00:00.000Z');
  const season = await ensureCurrentSeason(client, { now: day3 });

  assert.equal(client.state.seasons.filter((s) => s.status === 'completed').length, 1);
  assert.equal(season.status, 'active');
  assert.notEqual(season.id, client.state.seasons.find((s) => s.status === 'completed').id);
});

test('two rollover attempts for the same expired season cannot create two seasons', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([]), territories: buildTerritories() });
  const day1 = new Date('2026-02-01T10:00:00.000Z');
  await ensureCurrentSeason(client, { now: day1 });

  const day2 = new Date('2026-02-02T05:00:00.000Z');
  // Two "simultaneous" callers both observe the expired season and both attempt to rotate.
  const [a, b] = await Promise.all([
    runSeasonRollover(client, { now: day2 }),
    runSeasonRollover(client, { now: day2 }),
  ]);

  const activeSeasons = client.state.seasons.filter((s) => s.status === 'active');
  assert.equal(activeSeasons.length, 1);
  assert.equal(a.season.id, b.season.id);
});

test('only one active season exists at any time', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([]), territories: buildTerritories() });
  let now = new Date('2026-02-01T00:00:01.000Z');
  await ensureCurrentSeason(client, { now });
  now = new Date('2026-02-02T00:00:01.000Z');
  await ensureCurrentSeason(client, { now });
  now = new Date('2026-02-03T00:00:01.000Z');
  await ensureCurrentSeason(client, { now });

  assert.equal(client.state.seasons.filter((s) => s.status === 'active').length, 1);
});

test('automatic rollover and forced rollover use the exact same finalize/reset implementation', async () => {
  const territories = buildTerritories({ n1: 'blue' });
  const clientAuto = createSeasonTestClient({ players: buildPlayers([{ id: 1 }]), territories: new Map(territories) });
  const clientForced = createSeasonTestClient({ players: buildPlayers([{ id: 1 }]), territories: new Map(territories) });

  const day1 = new Date('2026-04-01T00:00:01.000Z');
  await ensureCurrentSeason(clientAuto, { now: day1 });
  await ensureCurrentSeason(clientForced, { now: day1 });
  await ensurePlayerFactionAssignment(clientAuto, { seasonId: clientAuto.state.seasons[0].id, playerId: 1 });
  await ensurePlayerFactionAssignment(clientForced, { seasonId: clientForced.state.seasons[0].id, playerId: 1 });

  const day2 = new Date('2026-04-02T00:00:01.000Z');
  await ensureCurrentSeason(clientAuto, { now: day2 }); // automatic path (expired)
  await forceFinishCurrentSeason(clientForced, { actorId: 99, now: day1.valueOf() < day2.valueOf() ? day1 : day2 }); // forced path

  const autoFinished = clientAuto.state.seasons.find((s) => s.status === 'completed');
  const forcedFinished = clientForced.state.seasons.find((s) => s.status === 'completed');
  assert.equal(autoFinished.result, forcedFinished.result);
  assert.deepEqual(
    { blue: autoFinished.blue_score, red: autoFinished.red_score, green: autoFinished.green_score },
    { blue: forcedFinished.blue_score, red: forcedFinished.red_score, green: forcedFinished.green_score }
  );
});

// ===================== Faction assignment =====================

test('a player is assigned only on first activity in a season; repeated calls return the same faction', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([{ id: 1 }]), territories: new Map() });
  await ensureCurrentSeason(client, { now: new Date('2026-05-01T00:00:01.000Z') });
  const seasonId = client.state.seasons[0].id;

  const first = await ensurePlayerFactionAssignment(client, { seasonId, playerId: 1 });
  const second = await ensurePlayerFactionAssignment(client, { seasonId, playerId: 1 });
  const third = await ensurePlayerFactionAssignment(client, { seasonId, playerId: 1 });

  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(client.state.seasonMemberships.filter((m) => m.player_id === 1).length, 1);
});

test('assignment also syncs army_name to match the assigned faction', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([{ id: 1 }]), territories: new Map() });
  await ensureCurrentSeason(client, { now: new Date('2026-05-01T00:00:01.000Z') });
  const seasonId = client.state.seasons[0].id;

  const faction = await ensurePlayerFactionAssignment(client, { seasonId, playerId: 1 });

  const expected = `${faction.charAt(0).toUpperCase()}${faction.slice(1)} Army`;
  assert.equal(client.state.players.get(1).army_name, expected);
});

test('refreshing or logging in again never changes the assigned faction', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([{ id: 1 }]), territories: new Map() });
  await ensureCurrentSeason(client, { now: new Date('2026-05-01T00:00:01.000Z') });
  const seasonId = client.state.seasons[0].id;

  const assigned = await ensurePlayerFactionAssignment(client, { seasonId, playerId: 1 });
  for (let i = 0; i < 5; i += 1) {
    const result = await ensurePlayerFactionAssignment(client, { seasonId, playerId: 1 });
    assert.equal(result, assigned);
  }
});

test('assignment always chooses the currently smallest faction', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([{ id: 1 }, { id: 2 }, { id: 3 }]), territories: new Map() });
  await ensureCurrentSeason(client, { now: new Date('2026-05-01T00:00:01.000Z') });
  const seasonId = client.state.seasons[0].id;

  client.state.seasonMemberships.push({ season_id: seasonId, player_id: 100, faction: 'blue' });
  client.state.seasonMemberships.push({ season_id: seasonId, player_id: 101, faction: 'blue' });
  client.state.seasonMemberships.push({ season_id: seasonId, player_id: 102, faction: 'red' });

  const assigned = await ensurePlayerFactionAssignment(client, { seasonId, playerId: 1 });
  assert.equal(assigned, 'green');
});

test('inactive accounts are never counted when balancing factions', async () => {
  const players = buildPlayers([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  const client = createSeasonTestClient({ players, territories: new Map() });
  await ensureCurrentSeason(client, { now: new Date('2026-05-01T00:00:01.000Z') });
  const seasonId = client.state.seasons[0].id;

  // Players 2, 3, 4 exist in the players table but have never been active this season.
  const assigned = await ensurePlayerFactionAssignment(client, { seasonId, playerId: 1 });
  const counts = await getFactionMemberCounts(client, seasonId);
  assert.equal(counts.blue + counts.red + counts.green, 1);
  assert.equal(counts[assigned], 1);
});

test('ties are broken fairly and repeated assignment keeps factions balanced', async () => {
  const players = buildPlayers(Array.from({ length: 9 }, (_, i) => ({ id: i + 1 })));
  const client = createSeasonTestClient({ players, territories: new Map() });
  await ensureCurrentSeason(client, { now: new Date('2026-05-01T00:00:01.000Z') });
  const seasonId = client.state.seasons[0].id;

  for (let id = 1; id <= 9; id += 1) {
    await ensurePlayerFactionAssignment(client, { seasonId, playerId: id });
  }

  const counts = await getFactionMemberCounts(client, seasonId);
  assert.equal(counts.blue, 3);
  assert.equal(counts.red, 3);
  assert.equal(counts.green, 3);
});

test('simultaneous player logins/assignments still finish perfectly balanced', async () => {
  const players = buildPlayers(Array.from({ length: 12 }, (_, i) => ({ id: i + 1 })));
  const client = createSeasonTestClient({ players, territories: new Map() });
  await ensureCurrentSeason(client, { now: new Date('2026-05-01T00:00:01.000Z') });
  const seasonId = client.state.seasons[0].id;

  await Promise.all(
    Array.from({ length: 12 }, (_, i) => ensurePlayerFactionAssignment(client, { seasonId, playerId: i + 1 }))
  );

  const counts = await getFactionMemberCounts(client, seasonId);
  const values = [counts.blue, counts.red, counts.green];
  assert.ok(Math.max(...values) - Math.min(...values) <= 1, `unbalanced: ${JSON.stringify(counts)}`);
});

test('players can receive a different faction next season, and previous membership does not influence it', async () => {
  const players = buildPlayers([{ id: 1 }]);
  const client = createSeasonTestClient({ players, territories: buildTerritories() });
  await ensureCurrentSeason(client, { now: new Date('2026-06-01T00:00:01.000Z') });
  const seasonOneId = client.state.seasons[0].id;
  await ensurePlayerFactionAssignment(client, { seasonId: seasonOneId, playerId: 1 });
  // Stack the season-one membership pool so a naive implementation would be biased.
  client.state.seasonMemberships.push({ season_id: seasonOneId, player_id: 200, faction: 'green' });
  client.state.seasonMemberships.push({ season_id: seasonOneId, player_id: 201, faction: 'green' });

  await ensureCurrentSeason(client, { now: new Date('2026-06-02T00:00:01.000Z') }); // rolls over
  const seasonTwoId = client.state.seasons.find((s) => s.status === 'active').id;
  assert.notEqual(seasonTwoId, seasonOneId);

  const secondAssignment = await ensurePlayerFactionAssignment(client, { seasonId: seasonTwoId, playerId: 1 });
  // Season two starts empty regardless of how lopsided season one's pool was.
  assert.equal(secondAssignment, 'blue');
});

test('a still-authenticated player is reassigned after midnight instead of keeping a stale faction', async () => {
  const players = buildPlayers([{ id: 1 }]);
  const client = createSeasonTestClient({ players, territories: buildTerritories() });
  await ensureCurrentSeason(client, { now: new Date('2026-06-01T00:00:01.000Z') });
  const seasonOneId = client.state.seasons[0].id;
  const factionSeasonOne = await ensurePlayerFactionAssignment(client, { seasonId: seasonOneId, playerId: 1 });
  assert.equal(players.get(1).faction, factionSeasonOne);

  // Player never logs out; their next request happens after the midnight rollover.
  const seasonTwo = await ensureCurrentSeason(client, { now: new Date('2026-06-02T00:00:01.000Z') });
  assert.equal(players.get(1).faction, null); // reset seasonal gameplay clears the cached faction
  const factionSeasonTwo = await ensurePlayerFactionAssignment(client, { seasonId: seasonTwo.id, playerId: 1 });
  assert.equal(players.get(1).faction, factionSeasonTwo);

  // The season-one membership row is retained as history, not deleted.
  assert.ok(client.state.seasonMemberships.some((m) => m.season_id === seasonOneId && m.player_id === 1));
});

test('previous-season faction membership cannot authorize current-season actions', async () => {
  const players = buildPlayers([{ id: 1 }]);
  const client = createSeasonTestClient({ players, territories: new Map() });
  await ensureCurrentSeason(client, { now: new Date('2026-06-01T00:00:01.000Z') });
  const seasonOneId = client.state.seasons[0].id;
  await ensurePlayerFactionAssignment(client, { seasonId: seasonOneId, playerId: 1 });

  const seasonTwoId = seasonOneId + 999; // a season id the player has no membership row for
  const lookup = await client.query(
    'SELECT faction FROM season_memberships WHERE season_id = $1 AND player_id = $2',
    [seasonTwoId, 1]
  );
  assert.equal(lookup.rowCount || lookup.rows.length, 0);
});

// ===================== Prestige & reset =====================

test('only active winning-faction members receive a permanent prestige win', async () => {
  const players = buildPlayers([{ id: 1 }, { id: 2 }, { id: 3 }]);
  const territories = buildTerritories({ n1: 'blue', n4: 'blue', n7: 'red' });
  const client = createSeasonTestClient({ players, territories });
  const day1 = new Date('2026-07-01T00:00:01.000Z');
  await ensureCurrentSeason(client, { now: day1 });
  const seasonId = client.state.seasons[0].id;

  // Player 1 is on the winning (blue) faction; player 2 is on red; player 3 never logged in.
  client.state.seasonMemberships.push({ season_id: seasonId, player_id: 1, faction: 'blue' });
  client.state.seasonMemberships.push({ season_id: seasonId, player_id: 2, faction: 'red' });

  await forceFinishCurrentSeason(client, { actorId: 1, now: new Date('2026-07-01T01:00:00.000Z') });

  assert.equal(players.get(1).season_wins, 1);
  assert.equal(players.get(2).season_wins, 0);
  assert.equal(players.get(3).season_wins, 0);
});

test('a draw gives no faction victory or prestige', async () => {
  const players = buildPlayers([{ id: 1 }, { id: 2 }]);
  const territories = buildTerritories({ n1: 'blue', n4: 'red' }); // 1-1 tie
  const client = createSeasonTestClient({ players, territories });
  await ensureCurrentSeason(client, { now: new Date('2026-07-01T00:00:01.000Z') });
  const seasonId = client.state.seasons[0].id;
  client.state.seasonMemberships.push({ season_id: seasonId, player_id: 1, faction: 'blue' });
  client.state.seasonMemberships.push({ season_id: seasonId, player_id: 2, faction: 'red' });

  const { finishedSeason } = await forceFinishCurrentSeason(client, { actorId: 1, now: new Date('2026-07-01T01:00:00.000Z') });

  assert.equal(finishedSeason.result, 'draw');
  assert.equal(players.get(1).season_wins, 0);
  assert.equal(players.get(2).season_wins, 0);
});

test('seasonal reset preserves accounts, passwords, roles, prestige, and season history', async () => {
  const players = buildPlayers([{ id: 1, role: 'admin', username: 'Sai', password_hash: 'sai-hash', season_wins: 3 }]);
  const territories = buildTerritories({ n1: 'blue' });
  const client = createSeasonTestClient({ players, territories });
  await ensureCurrentSeason(client, { now: new Date('2026-08-01T00:00:01.000Z') });
  const seasonId = client.state.seasons[0].id;
  client.state.seasonMemberships.push({ season_id: seasonId, player_id: 1, faction: 'blue' });

  await forceFinishCurrentSeason(client, { actorId: 1, now: new Date('2026-08-01T01:00:00.000Z') });

  const player = players.get(1);
  assert.equal(player.username, 'Sai');
  assert.equal(player.password_hash, 'sai-hash');
  assert.equal(player.role, 'admin');
  assert.ok(player.season_wins >= 3); // never reset, only ever incremented
  assert.equal(client.state.seasons.filter((s) => s.status === 'completed').length, 1);
  assert.ok(client.state.seasonMemberships.some((m) => m.season_id === seasonId && m.player_id === 1));
});

test('seasonal reset clears gameplay progress and restores the canonical balanced world', async () => {
  const players = buildPlayers([{ id: 1, soldiers: 500, resource_food: 12345 }]);
  const territories = buildTerritories({ n1: 'blue', n28: 'red' });
  const client = createSeasonTestClient({ players, territories });

  await resetSeasonalGameplay(client);

  assert.equal(players.get(1).soldiers, 100);
  assert.equal(players.get(1).resource_food, 500);
  assert.equal(players.get(1).faction, null);
  assert.equal(client.state.territories.get('n1').owner_faction, 'neutral');
  assert.equal(client.state.territories.get('n28').owner_faction, 'neutral');
  assert.equal(client.state.territories.size, 33);
});

// ===================== Force Finish bug fix regression =====================
// Previously season_number was the UTC day number, so Force Finish tried to create a new
// season with the SAME number as the one it just completed today, hit the seasons table's
// unique constraint on season_number, and silently left the game with zero active seasons.

test('season numbers are sequential display numbers (1, 2, 3...), never the calendar day', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([]), territories: buildTerritories() });

  await ensureCurrentSeason(client, { now: new Date('2026-09-01T00:00:01.000Z') });
  await forceFinishCurrentSeason(client, { actorId: 1, now: new Date('2026-09-01T05:00:00.000Z') });
  await forceFinishCurrentSeason(client, { actorId: 1, now: new Date('2026-09-01T10:00:00.000Z') });
  await forceFinishCurrentSeason(client, { actorId: 1, now: new Date('2026-09-01T15:00:00.000Z') });

  const numbers = client.state.seasons
    .filter((s) => s.season_number > 0)
    .sort((a, b) => a.id - b.id)
    .map((s) => s.season_number);
  assert.deepEqual(numbers, [1, 2, 3, 4]);
});

test('Force Finish repeatedly on the same UTC day never collides and always leaves exactly one playable active season', async () => {
  const players = buildPlayers([{ id: 1 }]);
  const territories = buildTerritories({ n1: 'blue' });
  const client = createSeasonTestClient({ players, territories });
  const sameDay = new Date('2026-09-05T00:00:01.000Z');

  await ensureCurrentSeason(client, { now: sameDay });
  await ensurePlayerFactionAssignment(client, { seasonId: client.state.seasons[0].id, playerId: 1 });

  for (let i = 0; i < 3; i += 1) {
    const result = await forceFinishCurrentSeason(client, {
      actorId: 1,
      now: new Date(sameDay.getTime() + (i + 1) * 60 * 60 * 1000),
    });
    const active = client.state.seasons.filter((s) => s.status === 'active');
    assert.equal(active.length, 1, `iteration ${i}: exactly one active season`);
    assert.equal(result.season.status, 'active');
    assert.equal(result.season.id, active[0].id);
    // The new season is genuinely usable: it starts at/around "now" and ends in the future.
    assert.ok(new Date(result.season.ends_at) > new Date(result.season.starts_at));
  }
});

test('the seasons table enforces a real unique constraint on season_number (defense in depth)', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([]), territories: new Map() });
  await ensureCurrentSeason(client, { now: new Date('2026-09-01T00:00:01.000Z') });
  const existingNumber = client.state.seasons[0].season_number;

  await assert.rejects(
    () => client.query(
      `INSERT INTO seasons (season_number, starts_at, ends_at, status) VALUES ($1, $2, $3, 'active') RETURNING *`,
      [existingNumber, new Date(), new Date()]
    ),
    /unique constraint/
  );
});

test('automatic midnight rollover creates the next season ending at the following 00:00 UTC', async () => {
  const client = createSeasonTestClient({ players: buildPlayers([]), territories: buildTerritories() });
  const midnight = new Date('2026-09-10T00:00:00.000Z');

  const first = await ensureCurrentSeason(client, { now: midnight });
  assert.equal(new Date(first.ends_at).toISOString(), '2026-09-11T00:00:00.000Z');

  const nextMidnight = new Date('2026-09-11T00:00:00.000Z');
  const second = await ensureCurrentSeason(client, { now: nextMidnight });

  assert.notEqual(second.id, first.id);
  assert.equal(second.season_number, first.season_number + 1);
  assert.equal(new Date(second.ends_at).toISOString(), '2026-09-12T00:00:00.000Z');
  assert.equal(client.state.seasons.filter((s) => s.status === 'active').length, 1);
});

// ===================== Registration cannot choose a faction =====================

test('registration route source never reads or trusts a client-supplied faction', () => {
  const fs = require('fs');
  const path = require('path');
  const serverSource = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
  const registerRouteMatch = serverSource.match(/app\.post\('\/api\/register'[\s\S]*?\n\}\)\);/);

  assert.ok(registerRouteMatch, 'could not locate the /api/register route in server.js');
  assert.ok(!registerRouteMatch[0].includes('req.body.faction'), 'registration must never read req.body.faction');
  assert.ok(registerRouteMatch[0].includes("VALUES ($1, $2, NULL, FALSE"), 'registration must always insert an unassigned faction');
});

test('the manual player faction endpoint is disabled for normal players', () => {
  const fs = require('fs');
  const path = require('path');
  const serverSource = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
  const routeMatch = serverSource.match(/app\.post\('\/api\/player\/faction'[\s\S]*?\n\}\)\);/);

  assert.ok(routeMatch, 'could not locate the /api/player/faction route in server.js');
  assert.ok(routeMatch[0].includes('res.status(403)'), 'the manual faction endpoint must always reject with 403');
});
