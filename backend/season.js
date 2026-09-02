// Core season logic: rollover (finalize + reseed + start next), balanced faction
// assignment, and scoring. Every function here takes a caller-supplied `client` (pool or a
// dedicated checked-out connection) so it stays unit-testable with a fake client, matching
// the rest of this codebase (admin-write-operations.js, admin-resets.js, etc.).
const topology = require('../world-topology');
const topologySql = require('./topology-sql');
const { STARTING_PLAYER_RESOURCES, STARTING_BUILDING_LEVELS } = require('./admin-resets');
const { logAdminAction } = require('./admin-write-operations');
const { buildArmyName } = require('./admin-faction-change');

// Postgres advisory lock keys (arbitrary but fixed int4-range constants). Transaction-scoped
// (pg_advisory_xact_lock) so they auto-release on COMMIT/ROLLBACK regardless of which pooled
// connection ran the query -- safe to use with a pool, unlike session-scoped advisory locks.
const ROLLOVER_LOCK_KEY = 837221001;
const ASSIGNMENT_LOCK_KEY = 837221002;
const SEASON_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

const VALID_FACTIONS = ['blue', 'red', 'green'];
const CORE_ID_SET = new Set(topology.CORE_IDS);

async function getActiveSeason(client) {
  const result = await client.query(`SELECT * FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1`);
  return result.rows[0] || null;
}

// season_number is a sequential display counter (1, 2, 3, ...), completely independent of
// starts_at/ends_at scheduling. Using the calendar day as the number (the previous approach)
// meant force-finishing a season mid-day tried to create a new season with the SAME number as
// the one just completed today, hit the UNIQUE constraint, and silently left zero active
// seasons. This always runs inside runSeasonRollover's advisory-locked transaction, so
// concurrent callers can never compute/insert the same next number.
async function createSeasonRow(client, { startsAt, endsAt }) {
  const nextNumberResult = await client.query(
    'SELECT COALESCE(MAX(season_number), 0) + 1 AS next_number FROM seasons WHERE season_number > 0'
  );
  const seasonNumber = Number(nextNumberResult.rows[0].next_number);
  const inserted = await client.query(
    `INSERT INTO seasons (season_number, starts_at, ends_at, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING *`,
    [seasonNumber, startsAt, endsAt]
  );
  const season = inserted.rows[0];
  await client.query(
    `INSERT INTO season_territory_faction_ownership (season_id, territory_id, faction)
     SELECT $1, id, owner_faction FROM territories WHERE owner_faction = ANY($2::varchar[])
     ON CONFLICT DO NOTHING`,
    [season.id, VALID_FACTIONS]
  );
  return season;
}

// Capitals score nothing and stay protected; core territories (from the canonical topology,
// never frontend/visual data) are worth double a normal territory. Accepts either raw
// DB-shaped territories (owner_faction/is_capital) or snapshot-shaped ones (owner/capital),
// matching the dual-shape pattern already used by getFactionTerritoryBonuses.
function computeScores(territories) {
  const scores = { blue: 0, red: 0, green: 0 };
  for (const territory of territories) {
    const isCapital = Boolean(territory.is_capital ?? territory.capital);
    if (isCapital) continue;
    const ownerFaction = territory.owner_faction || territory.owner;
    if (!VALID_FACTIONS.includes(ownerFaction)) continue;
    scores[ownerFaction] += CORE_ID_SET.has(territory.id) ? 2 : 1;
  }
  return scores;
}

function determineResult(scores) {
  const max = Math.max(scores.blue, scores.red, scores.green);
  const topFactions = VALID_FACTIONS.filter((faction) => scores[faction] === max);
  return topFactions.length === 1 ? topFactions[0] : 'draw';
}

async function calculateSeasonScores(client) {
  const result = await client.query('SELECT id, owner_faction, is_capital FROM territories');
  const scores = computeScores(result.rows);
  return { scores, result: determineResult(scores) };
}

async function getFactionMemberCounts(client, seasonId) {
  const result = await client.query(
    'SELECT faction, COUNT(*)::int AS count FROM season_memberships WHERE season_id = $1 GROUP BY faction',
    [seasonId]
  );
  const counts = { blue: 0, red: 0, green: 0 };
  for (const row of result.rows) {
    if (counts[row.faction] !== undefined) counts[row.faction] = row.count;
  }
  return counts;
}

// Resets everything seasonal (territories/neighbors reseeded from the canonical topology,
// resources, soldiers, buildings, defenders, attack/battle state, and faction assignment) but
// never touches accounts, password hashes, admin roles, season history, or season_wins.
async function resetSeasonalGameplay(client) {
  await client.query('DELETE FROM attack_contributions');
  await client.query('DELETE FROM attack_targets');
  await client.query('DELETE FROM territory_defenders');
  await client.query('DELETE FROM battle_history');
  await client.query('DELETE FROM territory_neighbors');
  await client.query('DELETE FROM territories');
  await client.query(topologySql.buildTerritoryValuesSQL());
  await client.query(topologySql.buildNeighborValuesSQL());

  await client.query(
    `UPDATE players
     SET resource_food = $1,
         resource_wood = $2,
         resource_iron = $3,
         resource_manpower = $4,
         soldiers = $5,
         faction = NULL,
         faction_locked = FALSE,
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
      SET farm = $1, lumbermill = $2, ironmine = $3, barracks = $4, storage = $5, updated_at = NOW()`,
    [
      STARTING_BUILDING_LEVELS.farm,
      STARTING_BUILDING_LEVELS.lumbermill,
      STARTING_BUILDING_LEVELS.ironmine,
      STARTING_BUILDING_LEVELS.barracks,
      STARTING_BUILDING_LEVELS.storage,
    ]
  );
  await client.query('UPDATE faction_leaders SET player_id = NULL');
}

// The single implementation used by both the automatic midnight rollover and the Sai-only
// force-finish admin control. Transactional and protected by an advisory lock so multiple
// server processes (or a request racing the scheduler) can never finalize/reset twice.
async function runSeasonRollover(client, { actorId = null, now = new Date(), force = false } = {}) {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [ROLLOVER_LOCK_KEY]);

    const activeResult = await client.query(`SELECT * FROM seasons WHERE status = 'active' ORDER BY id DESC LIMIT 1 FOR UPDATE`);
    const current = activeResult.rows[0] || null;
    // Existing active seasons retain their scheduled end time. Only a newly created season
    // receives the seven-day duration, including after a forced finish.
    const endsAt = new Date(now.getTime() + SEASON_DURATION_MS);

    if (current && !force && new Date(current.ends_at) > now) {
      await client.query('COMMIT');
      return { rotated: false, season: current, finishedSeason: null };
    }

    let finishedSeason = null;
    if (current) {
      const { scores, result } = await calculateSeasonScores(client);
      await client.query(
        `UPDATE seasons
         SET status = 'completed', blue_score = $1, red_score = $2, green_score = $3,
             result = $4, completed_at = NOW()
         WHERE id = $5`,
        [scores.blue, scores.red, scores.green, result, current.id]
      );

      if (result !== 'draw') {
        await client.query(
          `UPDATE players p
           SET season_wins = season_wins + 1
           FROM season_memberships sm
           WHERE sm.season_id = $1 AND sm.player_id = p.id AND sm.faction = $2`,
          [current.id, result]
        );
      }

      await resetSeasonalGameplay(client);
      finishedSeason = { ...current, blue_score: scores.blue, red_score: scores.red, green_score: scores.green, result };

      if (actorId !== null) {
        await logAdminAction(client, actorId, force ? 'season_force_finish' : 'season_rollover', {
          finishedSeasonId: current.id,
          result,
          scores,
          forced: force,
        });
      }
    }

    const newSeason = await createSeasonRow(client, { startsAt: now, endsAt });
    await client.query('COMMIT');
    return { rotated: true, season: newSeason, finishedSeason };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

// Cheap on the common path: a single indexed SELECT when the active season hasn't expired.
// Only escalates to the locked transactional rollover when a season boundary was actually
// crossed (including after downtime spanning any number of missed midnights).
async function ensureCurrentSeason(client, { now = new Date() } = {}) {
  const existing = await getActiveSeason(client);
  if (existing && new Date(existing.ends_at) > now) {
    return existing;
  }
  const { season } = await runSeasonRollover(client, { now, force: false });
  return season;
}

async function forceFinishCurrentSeason(client, { actorId, now = new Date() } = {}) {
  return runSeasonRollover(client, { actorId, now, force: true });
}

// Assigns a player to the smallest current-season faction on their first activity this
// season, and never again. Ties are broken by rotating through the tied factions in a
// stable order based on how many players have been assigned so far this season.
async function ensurePlayerFactionAssignment(client, { seasonId, playerId }) {
  const existing = await client.query(
    'SELECT faction FROM season_memberships WHERE season_id = $1 AND player_id = $2',
    [seasonId, playerId]
  );
  if (existing.rowCount) {
    return existing.rows[0].faction;
  }

  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [ASSIGNMENT_LOCK_KEY]);

    const recheck = await client.query(
      'SELECT faction FROM season_memberships WHERE season_id = $1 AND player_id = $2',
      [seasonId, playerId]
    );
    if (recheck.rowCount) {
      await client.query('COMMIT');
      return recheck.rows[0].faction;
    }

    const counts = await getFactionMemberCounts(client, seasonId);
    const totalAssigned = counts.blue + counts.red + counts.green;
    const minCount = Math.min(counts.blue, counts.red, counts.green);
    const tied = VALID_FACTIONS.filter((faction) => counts[faction] === minCount);
    const faction = tied[totalAssigned % tied.length];

    await client.query(
      `INSERT INTO season_memberships (season_id, player_id, faction)
       VALUES ($1, $2, $3)
       ON CONFLICT (season_id, player_id) DO NOTHING`,
      [seasonId, playerId, faction]
    );
    // Existing game logic reads players.faction (and army_name) directly; keep them in sync
    // as a cache of the authoritative current-season assignment so attack/defense/chat/
    // production code needs no rewrite. faction is never trusted on its own for authorization
    // -- callers must confirm it matches a season_memberships row for the active season.
    await client.query(
      `UPDATE players
       SET faction = $1,
           faction_locked = TRUE,
           army_name = $2,
           resource_food = $3,
           resource_wood = $4,
           resource_iron = $5,
           resource_manpower = $6,
           soldiers = $7,
           resource_last_updated = NOW()
       WHERE id = $8`,
      [
        faction,
        buildArmyName(faction),
        STARTING_PLAYER_RESOURCES.food,
        STARTING_PLAYER_RESOURCES.wood,
        STARTING_PLAYER_RESOURCES.iron,
        STARTING_PLAYER_RESOURCES.manpower,
        STARTING_PLAYER_RESOURCES.soldiers,
        playerId,
      ]
    );

    const finalRow = await client.query(
      'SELECT faction FROM season_memberships WHERE season_id = $1 AND player_id = $2',
      [seasonId, playerId]
    );
    await client.query('COMMIT');
    return finalRow.rows[0].faction;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = {
  ROLLOVER_LOCK_KEY,
  ASSIGNMENT_LOCK_KEY,
  VALID_FACTIONS,
  CORE_ID_SET,
  computeScores,
  determineResult,
  calculateSeasonScores,
  getFactionMemberCounts,
  resetSeasonalGameplay,
  runSeasonRollover,
  ensureCurrentSeason,
  forceFinishCurrentSeason,
  ensurePlayerFactionAssignment,
  getActiveSeason,
  createSeasonRow,
};
