const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { ADMIN_USERNAME } = require('./admin-policy');
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
    `ALTER TABLE admin_actions ADD COLUMN IF NOT EXISTS action_detail TEXT`,
    `CREATE TABLE IF NOT EXISTS faction_chat_messages (
      id SERIAL PRIMARY KEY,
      faction VARCHAR(16) NOT NULL,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_faction_chat_messages_faction_time ON faction_chat_messages (faction, created_at DESC, id DESC)`,
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
  await currentClient.query(`UPDATE players SET role = 'admin' WHERE username = $1`, [ADMIN_USERNAME]);
  await currentClient.query(`UPDATE players SET role = 'member' WHERE username <> $1 AND role = 'admin'`, [ADMIN_USERNAME]);
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
}

async function seedWorldIfEmpty() {
  const seedPath = path.join(__dirname, 'world-seed.sql');
  if (!fs.existsSync(seedPath)) {
    throw new Error('Missing world-seed.sql');
  }
  const result = await pool.query('SELECT COUNT(*) AS cnt FROM territories');
  const count = Number(result.rows[0]?.cnt || 0);
  if (count > 0) {
    console.log(`World seed skipped: ${count} territories already exist.`);
    return;
  }
  const seedSql = fs.readFileSync(seedPath, 'utf8');
  // Strip DELETE statements so seeding is safe on existing accounts
  const lines = seedSql.split('\n').filter((line) => {
    const t = line.trim().toUpperCase();
    return !(t.startsWith('DELETE FROM PLAYERS') ||
             t.startsWith('DELETE FROM BUILDINGS') ||
             t.startsWith('DELETE FROM ATTACK_CONTRIBUTIONS') ||
             t.startsWith('DELETE FROM ATTACK_TARGETS') ||
             t.startsWith('DELETE FROM TERRITORY_NEIGHBORS') ||
             t.startsWith('DELETE FROM TERRITORIES'));
  });
  await pool.query(lines.join('\n'));
  console.log('World seeded from world-seed.sql');
}

module.exports = {
  pool,
  connect,
  getClient,
  applySchemaMigrations,
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
  }
}
