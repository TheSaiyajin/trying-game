const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { connect, initializeDatabase } = require('./db');
const { issueToken, verifyToken, hashPassword, verifyPassword } = require('./auth');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
}));

const validFactions = ['blue', 'red', 'green'];
const validRoles = ['member', 'leader', 'admin'];

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session token.' });
  }
}

function requireRole(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  if (req.user.role !== 'admin' && req.user.role !== 'leader') {
    return res.status(403).json({ error: 'Permission denied.' });
  }
  next();
}

async function getPlayerById(playerId) {
  const db = await connect();
  const result = await db.query('SELECT * FROM players WHERE id = $1', [playerId]);
  return result.rows[0] || null;
}

async function getPlayerByUsername(username) {
  const db = await connect();
  const result = await db.query('SELECT * FROM players WHERE username = $1', [username]);
  return result.rows[0] || null;
}

async function getPlayerState(playerId) {
  const db = await connect();
  const playerResult = await db.query('SELECT * FROM players WHERE id = $1', [playerId]);
  const player = playerResult.rows[0];
  if (!player) return null;

  const buildingResult = await db.query(
    'SELECT * FROM buildings WHERE player_id = $1',
    [playerId]
  );

  return {
    id: player.id,
    username: player.username,
    faction: player.faction,
    role: player.role,
    resources: {
      food: Number(player.resource_food),
      wood: Number(player.resource_wood),
      iron: Number(player.resource_iron),
      manpower: Number(player.resource_manpower),
    },
    soldiers: Number(player.soldiers),
    buildings: buildingResult.rows[0] || {
      farm: 1,
      lumbermill: 1,
      ironmine: 1,
      barracks: 1,
    },
  };
}

async function getWorldState() {
  const db = await connect();
  const territories = await db.query('SELECT * FROM territories ORDER BY id');
  return {
    territories: territories.rows.map((t) => ({
      id: t.id,
      name: t.name,
      owner: t.owner_faction,
      defense: Number(t.defense_troops),
      bonus: t.bonus_type,
      bonusValue: Number(t.bonus_value),
      fortress: !!t.is_fortress,
      capital: !!t.is_capital,
      neighbors: [],
    })),
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

app.post('/api/register', asyncHandler(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const faction = String(req.body.faction || '').trim().toLowerCase();

  if (!username || username.length < 3 || username.length > 32) {
    return res.status(400).json({ error: 'Username must be 3-32 characters.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (!validFactions.includes(faction)) {
    return res.status(400).json({ error: 'Faction must be blue, red, or green.' });
  }

  const existing = await getPlayerByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already exists.' });
  }

  const passwordHash = await hashPassword(password);
  const db = await connect();

  const insertPlayer = await db.query(
    `
      INSERT INTO players (username, password_hash, faction, role, army_name)
      VALUES ($1, $2, $3, 'member', $4)
      RETURNING id, username, faction, role
    `,
    [username, passwordHash, faction, `${faction.charAt(0).toUpperCase() + faction.slice(1)} Army`]
  );

  const player = insertPlayer.rows[0];
  await db.query(
    `INSERT INTO buildings (player_id, farm, lumbermill, ironmine, barracks)
     VALUES ($1, 1, 1, 1, 1)`,
    [player.id]
  );

  const token = issueToken({ userId: player.id, username: player.username, faction: player.faction, role: player.role });
  res.status(201).json({
    message: 'Account created.',
    token,
    user: {
      id: player.id,
      username: player.username,
      faction: player.faction,
      role: player.role,
    },
  });
}));

app.post('/api/login', asyncHandler(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  const player = await getPlayerByUsername(username);
  if (!player) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const valid = await verifyPassword(password, player.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const db = await connect();
  await db.query('UPDATE players SET last_login_at = NOW(), last_action_at = NOW() WHERE id = $1', [player.id]);

  const token = issueToken({
    userId: player.id,
    username: player.username,
    faction: player.faction,
    role: player.role,
  });

  res.json({
    token,
    user: {
      id: player.id,
      username: player.username,
      faction: player.faction,
      role: player.role,
    },
  });
}));

app.get('/api/me', requireAuth, asyncHandler(async (req, res) => {
  const player = await getPlayerById(req.user.userId);
  if (!player) {
    return res.status(404).json({ error: 'Player not found.' });
  }

  res.json({
    id: player.id,
    username: player.username,
    faction: player.faction,
    role: player.role,
  });
}));

app.get('/api/world', requireAuth, asyncHandler(async (req, res) => {
  const db = await connect();
  const territoryResult = await db.query(`
    SELECT t.*, array_agg(n.neighbor_id ORDER BY n.neighbor_id) AS neighbors
    FROM territories t
    LEFT JOIN territory_neighbors n ON n.territory_id = t.id
    GROUP BY t.id
    ORDER BY t.id
  `);

  const playersResult = await db.query(`
    SELECT p.id, p.username, p.faction, p.role, p.resource_food, p.resource_wood, p.resource_iron, p.resource_manpower, p.soldiers
    FROM players p
    ORDER BY p.id
  `);

  const territories = territoryResult.rows.map((row) => ({
    id: row.id,
    name: row.name,
    owner: row.owner_faction,
    defense: Number(row.defense_troops),
    bonus: row.bonus_type,
    bonusValue: Number(row.bonus_value),
    fortress: !!row.is_fortress,
    capital: !!row.is_capital,
    neighbors: row.neighbors || [],
  }));

  res.json({
    territories,
    players: playersResult.rows.map((player) => ({
      id: player.id,
      username: player.username,
      faction: player.faction,
      role: player.role,
      resources: {
        food: Number(player.resource_food),
        wood: Number(player.resource_wood),
        iron: Number(player.resource_iron),
        manpower: Number(player.resource_manpower),
      },
      soldiers: Number(player.soldiers),
    })),
  });
}));

app.get('/api/player/state', requireAuth, asyncHandler(async (req, res) => {
  const state = await getPlayerState(req.user.userId);
  if (!state) {
    return res.status(404).json({ error: 'Player not found.' });
  }
  res.json(state);
}));

app.post('/api/admin/reset-world', requireAuth, requireRole, asyncHandler(async (req, res) => {
  const db = await connect();
  await db.query('TRUNCATE TABLE attack_contributions, attack_targets, territory_neighbors, territories, buildings, players RESTART IDENTITY CASCADE');
  const seedSql = fs.readFileSync(require('path').join(__dirname, 'world-seed.sql'), 'utf8');
  await db.query(seedSql);
  await db.query('INSERT INTO admin_actions (actor_id, action_name, action_detail) VALUES ($1, $2, $3)', [req.user.userId, 'reset_world', 'Server reset world']);
  res.json({ message: 'World reset.' });
}));

app.post('/api/admin/reset-player', requireAuth, requireRole, asyncHandler(async (req, res) => {
  const playerId = Number(req.body.playerId || 0);
  if (!playerId) return res.status(400).json({ error: 'playerId required.' });

  const db = await connect();
  await db.query(`
    UPDATE players
    SET resource_food = 500, resource_wood = 400, resource_iron = 300, resource_manpower = 250,
        soldiers = 100, last_action_at = NOW()
    WHERE id = $1
  `, [playerId]);
  await db.query(`
    UPDATE buildings
    SET farm = 1, lumbermill = 1, ironmine = 1, barracks = 1, updated_at = NOW()
    WHERE player_id = $1
  `, [playerId]);
  await db.query('INSERT INTO admin_actions (actor_id, action_name, action_detail) VALUES ($1, $2, $3)', [req.user.userId, 'reset_player', `playerId=${playerId}`]);
  res.json({ message: 'Player reset.' });
}));

const fs = require('fs');
const path = require('path');

app.get('/api/admin/factions', requireAuth, requireRole, asyncHandler(async (req, res) => {
  const db = await connect();
  const players = await db.query('SELECT id, username, faction, role FROM players ORDER BY username');
  res.json({ factions: players.rows });
}));

app.get('/api/admin/territories', requireAuth, requireRole, asyncHandler(async (req, res) => {
  const db = await connect();
  const result = await db.query('SELECT * FROM territories ORDER BY id');
  res.json({ territories: result.rows });
}));

app.post('/api/admin/change-leader', requireAuth, requireRole, asyncHandler(async (req, res) => {
  const { faction, playerId } = req.body;
  if (!validFactions.includes(String(faction || '').toLowerCase())) {
    return res.status(400).json({ error: 'Invalid faction.' });
  }

  const db = await connect();
  await db.query(
    `INSERT INTO faction_leaders (faction, player_id)
     VALUES ($1, $2)
     ON CONFLICT (faction) DO UPDATE SET player_id = EXCLUDED.player_id`,
    [String(faction).toLowerCase(), Number(playerId)]
  );

  await db.query('UPDATE players SET role = $1 WHERE id = $2', ['leader', Number(playerId)]);
  await db.query('INSERT INTO admin_actions (actor_id, action_name, action_detail) VALUES ($1, $2, $3)', [req.user.userId, 'change_leader', JSON.stringify({ faction, playerId })]);
  res.json({ message: 'Leader updated.' });
}));

app.listen(PORT, async () => {
  try {
    await initializeDatabase();
    console.log(`Server ready on http://localhost:${PORT}`);
  } catch (err) {
    console.error('Database initialization failed:', err.message);
    process.exit(1);
  }
});
