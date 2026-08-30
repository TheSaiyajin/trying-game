const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { ADMIN_USERNAME } = require('./admin-policy');
const topology = require('../world-topology');
const topologySql = require('./topology-sql');
const { ensureCurrentSeason } = require('./season');
require('dotenv').config();

// A connection pool (not a single shared Client) is required here: routes that run
// explicit BEGIN/COMMIT/ROLLBACK transactions (attack, defend, recall, resolve-battle)
// must run on a dedicated connection. Sharing one Client across concurrent requests lets
// unrelated queries interleave inside another request's open transaction, which is what
// caused attack requests to intermittently fail with a generic 500 in production.
// Supports either discrete DB_* vars or a single DATABASE_URL (common on hosted
// Postgres providers), and opts into SSL when required by the host.
const useSsl = String(process.env.DB_SSL || '').toLowerCase() === 'true'
  || /sslmode=require/i.test(process.env.DATABASE_URL || '');

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
      connectionString: process.env.DATABASE_URL,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: Number(process.env.DB_POOL_MAX || 10),
    }
    : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      database: process.env.DB_NAME || 'trying_game',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: Number(process.env.DB_POOL_MAX || 10),
    }
);

pool.on('error', (error) => {
  console.error('Unexpected idle Postgres client error:', error);
});

// Returns the pool itself. Safe for one-off queries: pool.query() checks out and
// releases a connection automatically. Not safe for multi-statement transactions.
async function connect() {
  return pool;
}

// Returns a dedicated client checked out from the pool. Callers MUST call
// client.release() when done (use try/finally). Required for any BEGIN/COMMIT/ROLLBACK.
async function getClient() {
  return pool.connect();
}

async function applySchemaMigrations(currentClient) {
  const migrationStatements = [
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS faction VARCHAR(16) NULL`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS faction_locked BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'member'`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS army_name VARCHAR(64) DEFAULT 'Blue Army'`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS resource_last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS resource_food INTEGER NOT NULL DEFAULT 500`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS resource_wood INTEGER NOT NULL DEFAULT 400`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS resource_iron INTEGER NOT NULL DEFAULT 300`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS resource_manpower INTEGER NOT NULL DEFAULT 250`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS soldiers INTEGER NOT NULL DEFAULT 100`,
    `ALTER TABLE buildings ADD COLUMN IF NOT EXISTS farm INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE buildings ADD COLUMN IF NOT EXISTS lumbermill INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE buildings ADD COLUMN IF NOT EXISTS ironmine INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE buildings ADD COLUMN IF NOT EXISTS barracks INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE buildings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS owner_faction VARCHAR(16) NOT NULL DEFAULT 'neutral'`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS defense_troops INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS bonus_type VARCHAR(32) NOT NULL DEFAULT 'none'`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS bonus_value NUMERIC(6, 3) NOT NULL DEFAULT 0`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS is_fortress BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS is_capital BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS resource_bonus NUMERIC(6, 3) NOT NULL DEFAULT 0`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS storage_bonus NUMERIC(6, 3) NOT NULL DEFAULT 0`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS last_battle_at TIMESTAMPTZ`,
    `ALTER TABLE territory_defenders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE territory_defenders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE territory_defenders ADD COLUMN IF NOT EXISTS faction VARCHAR(16) NOT NULL DEFAULT 'blue'`,
    `ALTER TABLE territory_defenders ADD COLUMN IF NOT EXISTS troops INTEGER NOT NULL DEFAULT 0`,
    `CREATE UNIQUE INDEX IF NOT EXISTS territory_defenders_territory_player_idx ON territory_defenders (territory_id, player_id)`,
    `ALTER TABLE attack_contributions ADD COLUMN IF NOT EXISTS contribution INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE attack_contributions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE attack_contributions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE attack_contributions ADD COLUMN IF NOT EXISTS faction VARCHAR(16) NOT NULL DEFAULT 'blue'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS attack_contributions_territory_player_idx ON attack_contributions (territory_id, player_id)`,
    `ALTER TABLE faction_leaders ALTER COLUMN player_id DROP NOT NULL`,
    `ALTER TABLE admin_actions ADD COLUMN IF NOT EXISTS action_detail TEXT`,
    `CREATE TABLE IF NOT EXISTS faction_chat_messages (
      id SERIAL PRIMARY KEY,
      faction VARCHAR(16) NOT NULL,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_faction_chat_messages_faction_time ON faction_chat_messages (faction, created_at DESC, id DESC)`,
    `CREATE TABLE IF NOT EXISTS topology_version (
      id INTEGER PRIMARY KEY DEFAULT 1,
      version INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS season_wins INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS seasons (
      id SERIAL PRIMARY KEY,
      season_number INTEGER UNIQUE NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      blue_score INTEGER,
      red_score INTEGER,
      green_score INTEGER,
      result VARCHAR(16),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_seasons_status ON seasons (status, id DESC)`,
    `CREATE TABLE IF NOT EXISTS season_memberships (
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      faction VARCHAR(16) NOT NULL,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (season_id, player_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_season_memberships_season_faction ON season_memberships (season_id, faction)`,
    `ALTER TABLE faction_chat_messages ADD COLUMN IF NOT EXISTS season_id INTEGER REFERENCES seasons(id)`,
    `CREATE INDEX IF NOT EXISTS idx_faction_chat_messages_season_faction ON faction_chat_messages (season_id, faction, created_at DESC, id DESC)`,
    `CREATE TABLE IF NOT EXISTS player_season_stats (
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      kills INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      battles_joined INTEGER NOT NULL DEFAULT 0,
      battles_won INTEGER NOT NULL DEFAULT 0,
      successful_defences INTEGER NOT NULL DEFAULT 0,
      territories_captured INTEGER NOT NULL DEFAULT 0,
      retakes INTEGER NOT NULL DEFAULT 0,
      reinforcement_troops_sent INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (season_id, player_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_player_season_stats_rankings ON player_season_stats (season_id)`,
    `CREATE TABLE IF NOT EXISTS season_territory_faction_ownership (
      season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
      territory_id VARCHAR(8) NOT NULL REFERENCES territories(id) ON DELETE CASCADE,
      faction VARCHAR(16) NOT NULL,
      PRIMARY KEY (season_id, territory_id, faction)
    )`,
  ];


  for (const statement of migrationStatements) {
    try {
      await currentClient.query(statement);
    } catch (error) {
      if (!/does not exist|column .* already exists|constraint/i.test(error.message)) {
        throw error;
      }
    }
  }
  await currentClient.query(`
    INSERT INTO season_territory_faction_ownership (season_id, territory_id, faction)
    SELECT s.id, t.id, t.owner_faction
    FROM seasons s
    CROSS JOIN territories t
    WHERE s.status = 'active' AND t.owner_faction IN ('blue', 'red', 'green')
    ON CONFLICT DO NOTHING
  `);
  await currentClient.query(`
    WITH stationed AS (
      SELECT territory_id, COALESCE(SUM(GREATEST(troops, 0)), 0) AS stationed_troops
      FROM territory_defenders
      GROUP BY territory_id
    )
    UPDATE territories t
    SET defense_troops = GREATEST(t.defense_troops, COALESCE(stationed.stationed_troops, 0))
    FROM stationed
    WHERE t.id = stationed.territory_id
      AND t.defense_troops < COALESCE(stationed.stationed_troops, 0)
  `);
  // NOTE: role is intentionally NOT auto-granted to username === ADMIN_USERNAME here.
  // Admin is only ever granted via the bootstrap CLI (node backend/db.js --bootstrap-admin
  // <token>, guarded by ADMIN_BOOTSTRAP_TOKEN). This is a defense-in-depth safety net that
  // only ever removes an unexpected admin role from a non-Sai account; it never grants one.
  await currentClient.query(`UPDATE players SET role = 'member' WHERE username <> $1 AND role = 'admin'`, [ADMIN_USERNAME]);

  // Reserved "legacy" season (season_number = 0, already completed) so pre-season chat rows
  // have somewhere to live. Normal chat endpoints only ever query the active season's id, so
  // this legacy bucket is never returned to players -- idempotent to run on every startup.
  const legacySeasonInsert = await currentClient.query(
    `INSERT INTO seasons (season_number, starts_at, ends_at, status, completed_at)
     VALUES (0, TO_TIMESTAMP(0), TO_TIMESTAMP(0), 'completed', TO_TIMESTAMP(0))
     ON CONFLICT (season_number) DO NOTHING
     RETURNING id`
  );
  const legacySeasonRow = legacySeasonInsert.rows[0]
    || (await currentClient.query('SELECT id FROM seasons WHERE season_number = 0')).rows[0];
  if (legacySeasonRow) {
    await currentClient.query(
      'UPDATE faction_chat_messages SET season_id = $1 WHERE season_id IS NULL',
      [legacySeasonRow.id]
    );
  }

  await renumberSeasonsSequentially(currentClient);
}

// Older deployments numbered seasons by UTC day-since-epoch (e.g. 20520), which broke Force
// Finish: a forced rollover tries to create a new season the same calendar day, collides with
// the just-completed season's number, and silently leaves zero active seasons. This safely
// renumbers existing seasons to a sequential 1, 2, 3... display order (oldest first) without
// touching season ids, memberships, chat, or history -- everything else references seasons by
// id, never by season_number. Only runs when non-sequential numbering is actually detected, and
// is idempotent (a no-op on every later startup).
async function renumberSeasonsSequentially(currentClient) {
  const check = await currentClient.query(
    `SELECT COUNT(*)::int AS cnt, COALESCE(MAX(season_number), 0) AS max_number
     FROM seasons WHERE season_number > 0`
  );
  const { cnt = 0, max_number: maxNumber = 0 } = check.rows[0] || {};
  if (Number(maxNumber) === Number(cnt)) {
    return; // already sequential (or no real seasons yet)
  }

  // Two passes to avoid transient UNIQUE(season_number) collisions when reordering: first
  // move every real season to a guaranteed-distinct negative placeholder, then assign final
  // sequential numbers in chronological (id) order.
  await currentClient.query('UPDATE seasons SET season_number = -id WHERE season_number > 0');
  await currentClient.query(`
    WITH ordered AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM seasons WHERE season_number < 0
    )
    UPDATE seasons s SET season_number = ordered.rn
    FROM ordered
    WHERE s.id = ordered.id
  `);
}

async function initializeDatabase() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error('Missing schema.sql');
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const setupClient = await pool.connect();
  try {
    await setupClient.query(sql);
    await applySchemaMigrations(setupClient);
  } finally {
    setupClient.release();
  }
  console.log('Database initialized');
  await applyTopologyMigrationIfNeeded();
  await ensureCurrentSeasonOnStartup();
}

// Startup safety net for "server was offline at midnight": ensures exactly one active
// season exists, completing any missed rollover(s) using the same transactional,
// advisory-lock-protected code path as a live request would use.
async function ensureCurrentSeasonOnStartup() {
  const client = await pool.connect();
  try {
    const season = await ensureCurrentSeason(client);
    console.log(`Active season: #${season.season_number} (ends ${new Date(season.ends_at).toISOString()})`);
  } finally {
    client.release();
  }
}

// Idempotent, transactional migration that brings an EXISTING database's territory graph
// up to the canonical topology (world-topology.js) without touching anything else. Safe to
// run on every startup: once topology_version.version reaches TOPOLOGY_VERSION, this is a
// no-op (a single indexed SELECT), so restarting the server repeatedly never re-runs it or
// duplicates edges.
async function applyTopologyMigrationIfNeeded(externalClient = null) {
  const client = externalClient || await pool.connect();
  const shouldRelease = !externalClient;
  try {
    await client.query('BEGIN');
    const versionResult = await client.query('SELECT version FROM topology_version WHERE id = 1 FOR UPDATE');
    const currentVersion = versionResult.rowCount ? Number(versionResult.rows[0].version) : 0;

    if (currentVersion >= topology.TOPOLOGY_VERSION) {
      await client.query('COMMIT');
      return { migrated: false, currentVersion };
    }

    const territoryCount = await client.query('SELECT COUNT(*) AS cnt FROM territories');
    if (Number(territoryCount.rows[0]?.cnt || 0) === 0) {
      // Nothing to migrate yet (seedWorldIfEmpty will set the version once it seeds).
      await client.query('COMMIT');
      return { migrated: false, currentVersion };
    }

    // Only territory_neighbors is touched. Players, ownership, defenders, resources, chat,
    // factions, bonuses, and battle history are never modified by this migration.
    await client.query('DELETE FROM territory_neighbors');
    await client.query(topologySql.buildNeighborValuesSQL());
    await client.query(
      `INSERT INTO topology_version (id, version) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, updated_at = NOW()`,
      [topology.TOPOLOGY_VERSION]
    );
    await client.query('COMMIT');
    console.log(`Topology migrated: v${currentVersion} -> v${topology.TOPOLOGY_VERSION} (territory_neighbors replaced only).`);
    return { migrated: true, previousVersion: currentVersion, currentVersion: topology.TOPOLOGY_VERSION };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (shouldRelease) client.release();
  }
}

async function seedWorldIfEmpty() {
  const result = await pool.query('SELECT COUNT(*) AS cnt FROM territories');
  const count = Number(result.rows[0]?.cnt || 0);
  if (count > 0) {
    console.log(`World seed skipped: ${count} territories already exist.`);
    return;
  }
  // Territories/neighbors are generated directly from the canonical topology module
  // (world-topology.js via topology-sql.js), not parsed from world-seed.sql, so a fresh
  // database can never drift from the same graph the migration and frontend use. This also
  // means world seeding can never contain a DELETE FROM players/buildings statement.
  await pool.query(topologySql.buildTerritoryValuesSQL());
  await pool.query(topologySql.buildNeighborValuesSQL());
  await pool.query(
    `INSERT INTO topology_version (id, version) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version, updated_at = NOW()`,
    [topology.TOPOLOGY_VERSION]
  );
  console.log('World seeded from the canonical topology.');
}

module.exports = {
  pool,
  connect,
  getClient,
  applySchemaMigrations,
  applyTopologyMigrationIfNeeded,
  initializeDatabase,
  seedWorldIfEmpty,
};

if (require.main === module) {
  const command = process.argv[2];
  if (command === '--init') {
    (async () => {
      await initializeDatabase();
      await seedWorldIfEmpty();
      process.exit(0);
    })().catch((err) => {
      console.error('DB init failed:', err.message);
      process.exit(1);
    });
  } else if (command === '--bootstrap-admin') {
    const token = process.argv[3];
    (async () => {
      const { bootstrapAdmin } = require('./admin-bootstrap');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await bootstrapAdmin(client, { token });
        if (!result.ok) {
          await client.query('ROLLBACK');
          console.error(`Bootstrap failed: ${result.error}`);
          process.exit(1);
        }
        await client.query('COMMIT');
        console.log(`"${result.username}" is now an admin.`);
        process.exit(0);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    })().catch((err) => {
      console.error('Bootstrap failed:', err.message);
      process.exit(1);
    });
  }
}
