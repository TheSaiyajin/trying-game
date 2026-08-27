const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'trying_game',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function connect() {
  if (!client._connected) {
    await client.connect();
    client._connected = true;
  }
  return client;
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
    `ALTER TABLE attack_contributions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE attack_contributions ADD COLUMN IF NOT EXISTS faction VARCHAR(16) NOT NULL DEFAULT 'blue'`,
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
  await connect();
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error('Missing schema.sql');
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await client.query(sql);
  await applySchemaMigrations(client);
  console.log('Database initialized');
}

module.exports = {
  client,
  connect,
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
