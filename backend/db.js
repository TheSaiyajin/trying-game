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

async function initializeDatabase() {
  await connect();
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error('Missing schema.sql');
  }
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await client.query(sql);
  console.log('Database initialized');
}

module.exports = {
  client,
  connect,
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
