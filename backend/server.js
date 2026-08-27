const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { connect, initializeDatabase } = require('./db');
const { issueToken, verifyToken, hashPassword, verifyPassword } = require('./auth');
const {
  getUpgradeCost,
  getProductionFromBuildings,
  getFactionTerritoryBonuses,
  calculateBattleOutcome,
} = require('./game-logic');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const validFactions = ['blue', 'red', 'green'];
const validRoles = ['member', 'leader', 'admin'];
const buildingNames = ['farm', 'lumbermill', 'ironmine', 'barracks'];

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
}));

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  try {
    req.user = verifyToken(token);
    next();
  } catch (error) {
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

function parsePositiveInt(value, fallback = 0, maxValue = 1000000) {
  const num = Number(value) || fallback;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(0, Math.floor(num)), maxValue);
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

async function getPlayerBuildingLevels(playerId) {
  const db = await connect();
  const result = await db.query('SELECT * FROM buildings WHERE player_id = $1', [playerId]);
  const row = result.rows[0] || {};
  return {
    farm: Number(row.farm || 1),
    lumbermill: Number(row.lumbermill || 1),
    ironmine: Number(row.ironmine || 1),
    barracks: Number(row.barracks || 1),
  };
}

async function getTerritoriesSnapshot() {
  const db = await connect();
  const result = await db.query(`
    SELECT t.*,
      COALESCE(ARRAY_AGG(n.neighbor_id ORDER BY n.neighbor_id) FILTER (WHERE n.neighbor_id IS NOT NULL), ARRAY[]::varchar[]) AS neighbors
    FROM territories t
    LEFT JOIN territory_neighbors n ON n.territory_id = t.id
    GROUP BY t.id
    ORDER BY t.id
  `);

  return result.rows.map((row) => ({
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
}

async function getPlayerState(playerId) {
  const db = await connect();
  const player = await getPlayerById(playerId);
  if (!player) return null;

  const buildings = await getPlayerBuildingLevels(playerId);
  const territories = await getTerritoriesSnapshot();
  const production = getProductionFromBuildings(buildings, territories, player.faction, true);

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
    buildings,
    production,
    territories,
  };
}

async function applyOfflineResourceEarnings(playerId) {
  const db = await connect();
  const player = await getPlayerById(playerId);
  if (!player) return null;

  const faction = player.faction || 'blue';
  const lastUpdated = player.resource_last_updated ? new Date(player.resource_last_updated) : new Date();
  const secondsSince = Math.max(0, Math.min((Date.now() - lastUpdated.getTime()) / 1000, 60 * 60 * 12));
  if (secondsSince <= 0) return player;

  const buildings = await getPlayerBuildingLevels(playerId);
  const territories = await getTerritoriesSnapshot();
  const production = getProductionFromBuildings(buildings, territories, faction, true);
  const gain = {
    food: Math.floor((production.food / 60) * secondsSince),
    wood: Math.floor((production.wood / 60) * secondsSince),
    iron: Math.floor((production.iron / 60) * secondsSince),
    manpower: Math.floor((production.manpower / 60) * secondsSince),
  };

  await db.query(
    `UPDATE players
     SET resource_food = resource_food + $1,
         resource_wood = resource_wood + $2,
         resource_iron = resource_iron + $3,
         resource_manpower = resource_manpower + $4,
         resource_last_updated = NOW(),
         last_action_at = NOW()
     WHERE id = $5`,
    [gain.food, gain.wood, gain.iron, gain.manpower, playerId]
  );

  return { ...player, resource_food: Number(player.resource_food) + gain.food, resource_wood: Number(player.resource_wood) + gain.wood, resource_iron: Number(player.resource_iron) + gain.iron, resource_manpower: Number(player.resource_manpower) + gain.manpower };
}

async function getPlayerWorldState(playerId) {
  const player = await applyOfflineResourceEarnings(playerId) || await getPlayerById(playerId);
  if (!player) return null;

  const db = await connect();
  const territories = await getTerritoriesSnapshot();
  const players = await db.query(
    `SELECT id, username, faction, role, resource_food, resource_wood, resource_iron, resource_manpower, soldiers
     FROM players ORDER BY id`
  );
  const buildings = await getPlayerBuildingLevels(playerId);
  const production = getProductionFromBuildings(buildings, territories, player.faction || 'blue', true);

  return {
    player: {
      id: player.id,
      username: player.username,
      faction: player.faction,
      role: player.role,
      needsFactionSelection: !player.faction,
      resources: {
        food: Number(player.resource_food),
        wood: Number(player.resource_wood),
        iron: Number(player.resource_iron),
        manpower: Number(player.resource_manpower),
      },
      soldiers: Number(player.soldiers),
      buildings,
      production,
    },
    world: {
      territories,
      players: players.rows.map((row) => ({
        id: row.id,
        username: row.username,
        faction: row.faction,
        role: row.role,
        resources: {
          food: Number(row.resource_food),
          wood: Number(row.resource_wood),
          iron: Number(row.resource_iron),
          manpower: Number(row.resource_manpower),
        },
        soldiers: Number(row.soldiers),
      })),
    },
  };
}

async function isPlayerTerritoryAdjacentToTarget(playerId, targetId) {
  const db = await connect();
  const owned = await db.query(
    `SELECT t.id
     FROM territories t
     INNER JOIN territory_neighbors n ON n.territory_id = t.id AND n.neighbor_id = $1
     WHERE t.owner_faction = $2
     LIMIT 1`,
    [targetId, (await getPlayerById(playerId)).faction]
  );
  return owned.rowCount > 0;
}

function sanitizeBuildingName(value) {
  const key = String(value || '').trim().toLowerCase();
  return buildingNames.includes(key) ? key : null;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

app.post('/api/register', asyncHandler(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const rawFaction = String(req.body.faction || '').trim().toLowerCase();
  const faction = rawFaction && validFactions.includes(rawFaction) ? rawFaction : null;

  if (!username || username.length < 3 || username.length > 32) {
    return res.status(400).json({ error: 'Username must be 3-32 characters.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (rawFaction && !validFactions.includes(rawFaction)) {
    return res.status(400).json({ error: 'Faction must be blue, red, or green.' });
  }

  const existing = await getPlayerByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already exists.' });
  }

  const db = await connect();
  const passwordHash = await hashPassword(password);
  const insertPlayer = await db.query(
    `INSERT INTO players (username, password_hash, faction, faction_locked, role, army_name)
     VALUES ($1, $2, $3, $4, 'member', $5)
     RETURNING id, username, faction, role, faction_locked`,
    [username, passwordHash, faction, Boolean(faction), faction ? `${faction.charAt(0).toUpperCase()}${faction.slice(1)} Army` : 'Unassigned Army']
  );

  const player = insertPlayer.rows[0];
  await db.query(
    `INSERT INTO buildings (player_id, farm, lumbermill, ironmine, barracks)
     VALUES ($1, 1, 1, 1, 1)`,
    [player.id]
  );

  const token = issueToken({ userId: player.id, username: player.username, faction: player.faction, role: player.role, factionLocked: player.faction_locked });
  res.status(201).json({ token, user: { id: player.id, username: player.username, faction: player.faction, role: player.role, factionLocked: player.faction_locked, needsFactionSelection: !player.faction } });
}));

app.post('/api/login', asyncHandler(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  const player = await getPlayerByUsername(username);
  if (!player) return res.status(401).json({ error: 'Invalid credentials.' });

  const valid = await verifyPassword(password, player.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials.' });

  const db = await connect();
  await db.query('UPDATE players SET last_login_at = NOW(), last_action_at = NOW() WHERE id = $1', [player.id]);

  const payload = { userId: player.id, username: player.username, faction: player.faction, role: player.role, factionLocked: player.faction_locked }; 
  const token = issueToken(payload);
  res.json({ token, user: { id: player.id, username: player.username, faction: player.faction, role: player.role, factionLocked: player.faction_locked } });
}));

app.get('/api/me', requireAuth, asyncHandler(async (req, res) => {
  const player = await getPlayerById(req.user.userId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  res.json({ id: player.id, username: player.username, faction: player.faction, role: player.role, factionLocked: player.faction_locked, needsFactionSelection: !player.faction });
}));

app.post('/api/player/faction', requireAuth, asyncHandler(async (req, res) => {
  const faction = String(req.body.faction || '').trim().toLowerCase();
  const player = await getPlayerById(req.user.userId);

  if (!validFactions.includes(faction)) {
    return res.status(400).json({ error: 'Faction must be blue, red, or green.' });
  }
  if (player.faction_locked && player.faction && player.faction !== faction) {
    return res.status(409).json({ error: 'Faction is permanent and cannot be changed.' });
  }

  const db = await connect();
  await db.query('UPDATE players SET faction = $1, faction_locked = TRUE, army_name = $3 WHERE id = $2', [faction, player.id, `${faction.charAt(0).toUpperCase()}${faction.slice(1)} Army`]);
  res.json({ ok: true, faction, factionLocked: true, needsFactionSelection: false });
}));

app.get('/api/world', requireAuth, asyncHandler(async (req, res) => {
  const snapshot = await getPlayerWorldState(req.user.userId);
  if (!snapshot) return res.status(404).json({ error: 'Player not found.' });
  res.json(snapshot.world);
}));

app.get('/api/player/state', requireAuth, asyncHandler(async (req, res) => {
  const snapshot = await getPlayerWorldState(req.user.userId);
  if (!snapshot) return res.status(404).json({ error: 'Player not found.' });
  res.json(snapshot.player);
}));

app.get('/api/game/state', requireAuth, asyncHandler(async (req, res) => {
  const snapshot = await getPlayerWorldState(req.user.userId);
  if (!snapshot) return res.status(404).json({ error: 'Player not found.' });
  res.json({
    player: snapshot.player,
    world: snapshot.world,
    serverTime: Date.now(),
  });
}));

app.post('/api/game/upgrade-building', requireAuth, asyncHandler(async (req, res) => {
  const buildingKey = sanitizeBuildingName(req.body.building);
  if (!buildingKey) return res.status(400).json({ error: 'Invalid building.' });

  const player = await getPlayerById(req.user.userId);
  const buildings = await getPlayerBuildingLevels(player.id);
  const nextLevel = (buildings[buildingKey] || 1) + 1;
  const cost = getUpgradeCost(buildingKey, nextLevel);

  const resources = {
    food: Number(player.resource_food),
    wood: Number(player.resource_wood),
    iron: Number(player.resource_iron),
  };

  if (resources.food < cost.food || resources.wood < cost.wood || resources.iron < cost.iron) {
    return res.status(400).json({ error: 'Not enough resources for the building upgrade.' });
  }

  const db = await connect();
  await db.query(
    `UPDATE players SET resource_food = resource_food - $1, resource_wood = resource_wood - $2, resource_iron = resource_iron - $3 WHERE id = $4`,
    [cost.food, cost.wood, cost.iron, player.id]
  );
  await db.query(
    `UPDATE buildings SET ${buildingKey} = ${buildingKey} + 1, updated_at = NOW() WHERE player_id = $1`,
    [player.id]
  );

  const snapshot = await getPlayerWorldState(player.id);
  res.json({ ok: true, state: snapshot });
}));

app.post('/api/game/train-soldiers', requireAuth, asyncHandler(async (req, res) => {
  const count = parsePositiveInt(req.body.amount || 0, 0, 5000);
  if (count <= 0) return res.status(400).json({ error: 'Training amount must be positive.' });

  const player = await getPlayerById(req.user.userId);
  if (!player.faction) return res.status(400).json({ error: 'Choose a faction before training troops.' });

  const territories = await getTerritoriesSnapshot();
  const territoryBonuses = getFactionTerritoryBonuses(territories, player.faction);
  const trainingMultiplier = Math.max(0.4, 1 - (territoryBonuses.training || 0));
  const cost = {
    food: Math.max(1, Math.round(50 * count * trainingMultiplier)),
    iron: Math.max(1, Math.round(20 * count * trainingMultiplier)),
    manpower: Math.max(1, Math.round(1 * count * trainingMultiplier)),
  };

  if (Number(player.resource_food) < cost.food || Number(player.resource_iron) < cost.iron || Number(player.resource_manpower) < cost.manpower) {
    return res.status(400).json({ error: 'Not enough resources to train soldiers.' });
  }

  const db = await connect();
  await db.query(
    `UPDATE players SET resource_food = resource_food - $1, resource_iron = resource_iron - $2, resource_manpower = resource_manpower - $3, soldiers = soldiers + $4, last_action_at = NOW() WHERE id = $5`,
    [cost.food, cost.iron, cost.manpower, count, player.id]
  );

  const snapshot = await getPlayerWorldState(player.id);
  res.json({ ok: true, state: snapshot, trainingCost: cost, trained: count });
}));

app.post('/api/game/defend', requireAuth, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  const troops = parsePositiveInt(req.body.troops || 0, 0, 5000);
  if (!territoryId) return res.status(400).json({ error: 'Territory required.' });
  if (troops <= 0) return res.status(400).json({ error: 'Defender count must be positive.' });

  const db = await connect();
  const player = await getPlayerById(req.user.userId);
  if (!player || !player.faction) return res.status(400).json({ error: 'Choose a faction before defending a territory.' });

  const territory = await db.query('SELECT * FROM territories WHERE id = $1', [territoryId]);
  if (!territory.rows[0]) return res.status(404).json({ error: 'Territory not found.' });
  if (territory.rows[0].owner_faction !== player.faction) return res.status(400).json({ error: 'You can only defend your faction territory.' });
  if (Number(player.soldiers) < troops) return res.status(400).json({ error: 'Not enough soldiers available to defend.' });

  await db.query(
    `INSERT INTO territory_defenders (territory_id, player_id, faction, troops)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (territory_id, player_id)
     DO UPDATE SET troops = territory_defenders.troops + EXCLUDED.troops, faction = EXCLUDED.faction, updated_at = NOW()`,
    [territoryId, player.id, player.faction, troops]
  );

  await db.query(
    `UPDATE players SET soldiers = soldiers - $1, last_action_at = NOW() WHERE id = $2`,
    [troops, player.id]
  );

  const snapshot = await getPlayerWorldState(player.id);
  res.json({ ok: true, state: snapshot, stationed: troops, territoryId });
}));

app.post('/api/game/recall-defenders', requireAuth, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  const troops = parsePositiveInt(req.body.troops || 0, 0, 5000);
  if (!territoryId) return res.status(400).json({ error: 'Territory required.' });
  if (troops <= 0) return res.status(400).json({ error: 'Recall count must be positive.' });

  const db = await connect();
  const player = await getPlayerById(req.user.userId);
  const guard = await db.query('SELECT * FROM territory_defenders WHERE territory_id = $1 AND player_id = $2', [territoryId, player.id]);
  if (!guard.rows[0]) return res.status(404).json({ error: 'No defenders to recall from this territory.' });
  if (Number(guard.rows[0].troops) < troops) return res.status(400).json({ error: 'You cannot recall more troops than are stationed.' });

  await db.query(
    `UPDATE territory_defenders SET troops = troops - $1, updated_at = NOW() WHERE territory_id = $2 AND player_id = $3`,
    [troops, territoryId, player.id]
  );
  await db.query(
    `DELETE FROM territory_defenders WHERE territory_id = $1 AND player_id = $2 AND troops <= 0`,
    [territoryId, player.id]
  );
  await db.query(
    `UPDATE players SET soldiers = soldiers + $1, last_action_at = NOW() WHERE id = $2`,
    [troops, player.id]
  );

  const snapshot = await getPlayerWorldState(player.id);
  res.json({ ok: true, state: snapshot, recalled: troops, territoryId });
}));

app.post('/api/game/attack', requireAuth, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  const soldiers = parsePositiveInt(req.body.soldiers || 0, 0, 5000);
  if (!territoryId) return res.status(400).json({ error: 'Target territory required.' });
  if (soldiers <= 0) return res.status(400).json({ error: 'Attack must send at least one soldier.' });

  const db = await connect();
  const player = await getPlayerById(req.user.userId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (!player.faction) return res.status(400).json({ error: 'Choose a faction before attacking.' });

  const target = await db.query('SELECT * FROM territories WHERE id = $1', [territoryId]);
  if (!target.rows[0]) return res.status(404).json({ error: 'Territory not found.' });
  if (target.rows[0].owner_faction === player.faction) return res.status(400).json({ error: 'You cannot attack your own territory.' });

  const adjacent = await db.query(
    `SELECT 1
     FROM territory_neighbors n
     INNER JOIN territories t ON t.id = n.territory_id
     WHERE n.neighbor_id = $1 AND t.owner_faction = $2
     LIMIT 1`,
    [territoryId, player.faction]
  );
  if (!adjacent.rowCount) return res.status(400).json({ error: 'This territory is not adjacent to your faction.' });

  if (Number(player.soldiers) < soldiers) return res.status(400).json({ error: 'Not enough soldiers to send.' });

  await db.query('BEGIN');
  try {
    const currentPlayer = await db.query('SELECT soldiers FROM players WHERE id = $1 FOR UPDATE', [player.id]);
    if (Number(currentPlayer.rows[0].soldiers) < soldiers) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Not enough soldiers to send.' });
    }

    await db.query(
      `INSERT INTO attack_contributions (territory_id, player_id, contribution, faction)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (territory_id, player_id)
       DO UPDATE SET contribution = attack_contributions.contribution + EXCLUDED.contribution,
                    faction = EXCLUDED.faction,
                    updated_at = NOW()`,
      [territoryId, player.id, soldiers, player.faction]
    );

    await db.query(
      `UPDATE players SET soldiers = soldiers - $1, last_action_at = NOW() WHERE id = $2`,
      [soldiers, player.id]
    );
    await db.query('COMMIT');

    const snapshot = await getPlayerWorldState(player.id);
    res.json({ ok: true, state: snapshot, sent: soldiers, territoryId });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}));

app.post('/api/game/resolve-battle', requireAuth, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  if (!territoryId) return res.status(400).json({ error: 'No territory selected.' });

  const db = await connect();
  const player = await getPlayerById(req.user.userId);
  const target = await db.query('SELECT * FROM territories WHERE id = $1', [territoryId]);
  if (!target.rows[0]) return res.status(404).json({ error: 'Territory not found.' });

  await db.query('BEGIN');
  try {
    const totalContribution = await db.query(
      `SELECT COALESCE(SUM(contribution), 0) AS total FROM attack_contributions WHERE territory_id = $1 FOR UPDATE`,
      [territoryId]
    );
    const attackTotal = parsePositiveInt(totalContribution.rows[0]?.total || 0, 0, 100000);
    if (attackTotal <= 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'No attack contribution recorded for this target.' });
    }

    const defensePower = Number(target.rows[0].defense_troops || 0);
    const fortBonus = target.rows[0].is_fortress ? 1.2 : 1;
    const outcome = calculateBattleOutcome({ attackers: attackTotal, attackBonus: 1.1 }, { defenders: defensePower, defenseBonus: fortBonus });

    const ownerBefore = target.rows[0].owner_faction;
    const attackerFaction = player.faction || 'neutral';
    const defenderFaction = ownerBefore;
    const survivingAttackers = outcome.victory ? Math.max(1, outcome.attackersRemaining) : 0;
    const remainingDefenders = outcome.victory ? Math.max(1, Math.max(0, defensePower - outcome.defendersLost)) : Math.max(1, Math.max(0, defensePower - outcome.defendersLost));

    if (outcome.victory) {
      await db.query(
        `UPDATE territories SET owner_faction = $1, defense_troops = $2, last_battle_at = NOW() WHERE id = $3`,
        [attackerFaction, survivingAttackers, territoryId]
      );
      await db.query(
        `UPDATE players SET resource_food = resource_food + 25, resource_wood = resource_wood + 25, resource_iron = resource_iron + 25 WHERE id = $1`,
        [player.id]
      );
    } else {
      await db.query(
        `UPDATE territories SET defense_troops = $1, last_battle_at = NOW() WHERE id = $2`,
        [Math.max(1, remainingDefenders), territoryId]
      );
    }

    await db.query(
      `INSERT INTO battle_history (attacker_faction, defender_faction, territory_id, attacker_player_id, troops_sent, defender_total, applied_bonuses, winner, attackers_lost, attackers_surviving, defenders_lost, defenders_surviving, owner_before, owner_after)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [attackerFaction, defenderFaction, territoryId, player.id, attackTotal, defensePower, JSON.stringify({ fortBonus, attackBonus: 1.1 }), outcome.victory ? attackerFaction : defenderFaction, outcome.attackersLost, survivingAttackers, outcome.defendersLost, remainingDefenders, ownerBefore, outcome.victory ? attackerFaction : ownerBefore]
    );

    await db.query('DELETE FROM attack_contributions WHERE territory_id = $1', [territoryId]);
    await db.query(
      `INSERT INTO admin_actions (actor_id, action_name, action_detail) VALUES ($1, $2, $3)`,
      [player.id, 'battle_resolution', JSON.stringify({ territoryId, outcome })]
    );
    await db.query('COMMIT');

    const snapshot = await getPlayerWorldState(player.id);
    res.json({ ok: true, outcome, state: snapshot });
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}));

app.post('/api/admin/reset-world', requireAuth, requireRole, asyncHandler(async (req, res) => {
  const db = await connect();
  await db.query('TRUNCATE TABLE attack_contributions, attack_targets, territory_neighbors, territories, buildings, players RESTART IDENTITY CASCADE');
  const seedSql = fs.readFileSync(path.join(__dirname, 'world-seed.sql'), 'utf8');
  await db.query(seedSql);
  await db.query('INSERT INTO admin_actions (actor_id, action_name, action_detail) VALUES ($1, $2, $3)', [req.user.userId, 'reset_world', 'Server reset world']);
  res.json({ message: 'World reset.' });
}));

app.post('/api/admin/reset-player', requireAuth, requireRole, asyncHandler(async (req, res) => {
  const playerId = parsePositiveInt(req.body.playerId || 0, 0, 100000);
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
  const faction = String(req.body.faction || '').trim().toLowerCase();
  const playerId = parsePositiveInt(req.body.playerId || 0, 0, 100000);
  if (!validFactions.includes(faction)) return res.status(400).json({ error: 'Invalid faction.' });

  const db = await connect();
  await db.query(
    `INSERT INTO faction_leaders (faction, player_id)
     VALUES ($1, $2)
     ON CONFLICT (faction) DO UPDATE SET player_id = EXCLUDED.player_id`,
    [faction, playerId]
  );
  await db.query('UPDATE players SET role = $1 WHERE id = $2', ['leader', playerId]);
  await db.query('INSERT INTO admin_actions (actor_id, action_name, action_detail) VALUES ($1, $2, $3)', [req.user.userId, 'change_leader', JSON.stringify({ faction, playerId })]);
  res.json({ message: 'Leader updated.' });
}));

app.listen(PORT, async () => {
  try {
    await initializeDatabase();
    console.log(`Server ready on http://localhost:${PORT}`);
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  }
});
