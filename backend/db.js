const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// A connection pool (not a single shared Client) is required here: routes that run
// explicit BEGIN/COMMIT/ROLLBACK transactions (attack, defend, recall, resolve-battle)
// must run on a dedicated connection. Sharing one Client across concurrent requests lets
// unrelated queries interleave inside another request's open transaction, which is what
// caused attack requests to intermittently fail with a generic 500 in production.
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'trying_game',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max: Number(process.env.DB_POOL_MAX || 10),
});

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

async function applySchemaMigrations(currentClient = client) {
  const migrationStatements = [
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS faction_locked BOOLEAN NOT NULL DEFAULT TRUE`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS role VARCHAR(16) NOT NULL DEFAULT 'member'`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS army_name VARCHAR(64) DEFAULT 'Blue Army'`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS resource_food INTEGER NOT NULL DEFAULT 500`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS resource_wood INTEGER NOT NULL DEFAULT 400`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS resource_iron INTEGER NOT NULL DEFAULT 300`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS resource_manpower INTEGER NOT NULL DEFAULT 250`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS soldiers INTEGER NOT NULL DEFAULT 100`,
    `ALTER TABLE buildings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS resource_bonus NUMERIC(6, 3) NOT NULL DEFAULT 0`,
    `ALTER TABLE territories ADD COLUMN IF NOT EXISTS storage_bonus NUMERIC(6, 3) NOT NULL DEFAULT 0`,
    `ALTER TABLE territory_defenders ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE territory_defenders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE territory_defenders ADD COLUMN IF NOT EXISTS faction VARCHAR(16) NOT NULL DEFAULT 'blue'`,
    `ALTER TABLE territory_defenders ADD COLUMN IF NOT EXISTS troops INTEGER NOT NULL DEFAULT 0`,
    `CREATE UNIQUE INDEX IF NOT EXISTS territory_defenders_territory_player_idx ON territory_defenders (territory_id, player_id)`,
    `ALTER TABLE attack_contributions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE attack_contributions ADD COLUMN IF NOT EXISTS faction VARCHAR(16) NOT NULL DEFAULT 'blue'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS attack_contributions_territory_player_idx ON attack_contributions (territory_id, player_id)`,
    `ALTER TABLE admin_actions ADD COLUMN IF NOT EXISTS action_detail TEXT`,
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

module.exports = {
  pool,
  connect,
  getClient,
  applySchemaMigrations,
  initializeDatabase,
};

if (require.main === module) {
  const command = process.argv[2];
  if (command === '--init') {
    initializeDatabase().then(() => process.exit(0)).catch((err) => {
      console.error('DB init failed:', err.message);
      process.exit(1);
    });
  }
}
