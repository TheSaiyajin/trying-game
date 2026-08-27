const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const { connect, getClient, initializeDatabase } = require('./db');
const { issueToken, verifyToken, hashPassword, verifyPassword } = require('./auth');
const {
  getUpgradeCost,
  getProductionFromBuildings,
  getFactionTerritoryBonuses,
} = require('./game-logic');
const { AttackError, performAttack } = require('./attack-logic');
const {
  isSafeUsername,
  isAuthorizedAdminPlayer,
  getRegistrationRole,
} = require('./admin-policy');
const { buildArmyName, changePlayerFaction } = require('./admin-faction-change');
const {
  getSeasonResetPlan,
  resetAllPlayerResources,
  resetPlayerProgress,
  resetWorldState,
  runAdminTransaction,
} = require('./admin-resets');
const {
  logAdminAction,
  updatePlayerResources,
  updatePlayerRole,
  updatePlayerSoldiers,
  updateTerritory,
  assignFactionLeader,
  updateCapital,
} = require('./admin-write-operations');
const {
  applyDefenderCasualties,
  getLockedTerritoryDefenders,
  getTerritoryDefenseState,
} = require('./defender-garrisons');
const { resolveBattle } = require('./resolve-battle');
const {
 CHAT_RESPONSE_LIMIT,
 createFactionChatMessage,
 getFactionChatMessagesForPlayer,
} = require('./faction-chat');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const validFactions = ['blue', 'red', 'green'];
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

const factionChatSendRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user?.userId || req.ip),
  message: { error: 'Too many faction chat messages. Please wait a moment.' },
});

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

async function getCurrentAuthedPlayer(req) {
  if (req.currentPlayer) return req.currentPlayer;
  const player = await getPlayerById(req.user.userId);
  req.currentPlayer = player;
  return player;
}

function syncAuthUser(req, player) {
  if (!req.user || !player) return;
  req.user = {
    ...req.user,
    username: player.username,
    faction: player.faction,
    role: player.role,
    factionLocked: player.faction_locked,
  };
}

async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const player = await getCurrentAuthedPlayer(req);
    if (!isAuthorizedAdminPlayer(player)) {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    syncAuthUser(req, player);
    next();
  } catch (error) {
    next(error);
  }
}

async function requireLeaderOrAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const player = await getCurrentAuthedPlayer(req);
    if (!player || (!isAuthorizedAdminPlayer(player) && player.role !== 'leader')) {
      return res.status(403).json({ error: 'Leader or admin access required.' });
    }
    syncAuthUser(req, player);
    next();
  } catch (error) {
    next(error);
  }
}

function parsePositiveInt(value, fallback = 0, maxValue = 1000000) {
  const num = Number(value) || fallback;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(Math.max(0, Math.floor(num)), maxValue);
}

async function getPlayerById(playerId, db = null) {
  const queryable = db || await connect();
  const result = await queryable.query('SELECT * FROM players WHERE id = $1', [playerId]);
  return result.rows[0] || null;
}

async function getPlayerByUsername(username) {
  const db = await connect();
  const result = await db.query('SELECT * FROM players WHERE username = $1', [username]);
  return result.rows[0] || null;
}

async function getPlayerBuildingLevels(playerId, db = null) {
  const queryable = db || await connect();
  const result = await queryable.query('SELECT * FROM buildings WHERE player_id = $1', [playerId]);
  const row = result.rows[0] || {};
  return {
    farm: Number(row.farm || 1),
    lumbermill: Number(row.lumbermill || 1),
    ironmine: Number(row.ironmine || 1),
    barracks: Number(row.barracks || 1),
  };
}

async function getTerritoriesSnapshot(db = null) {
  const queryable = db || await connect();
  const result = await queryable.query(`
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
    owner_faction: row.owner_faction,
    defense: Number(row.defense_troops),
    bonus: row.bonus_type,
    bonus_type: row.bonus_type,
    bonusValue: Number(row.bonus_value),
    bonus_value: Number(row.bonus_value),
    resourceBonus: Number(row.resource_bonus),
    storageBonus: Number(row.storage_bonus),
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
  if (secondsSince < 60) return player;

  const wholeMinutes = Math.floor(secondsSince / 60);
  if (wholeMinutes <= 0) return player;

  const buildings = await getPlayerBuildingLevels(playerId);
  const territories = await getTerritoriesSnapshot();
  const production = getProductionFromBuildings(buildings, territories, faction, true);
  const gain = {
    food: Math.max(0, Math.floor(production.food * wholeMinutes)),
    wood: Math.max(0, Math.floor(production.wood * wholeMinutes)),
    iron: Math.max(0, Math.floor(production.iron * wholeMinutes)),
    manpower: Math.max(0, Math.floor(production.manpower * wholeMinutes)),
  };

  await db.query(
    `UPDATE players
     SET resource_food = resource_food + $1,
         resource_wood = resource_wood + $2,
         resource_iron = resource_iron + $3,
         resource_manpower = resource_manpower + $4,
         resource_last_updated = resource_last_updated + ($5 * INTERVAL '1 minute'),
         last_action_at = NOW()
     WHERE id = $6`,
    [gain.food, gain.wood, gain.iron, gain.manpower, wholeMinutes, playerId]
  );

  return { ...player, resource_food: Number(player.resource_food) + gain.food, resource_wood: Number(player.resource_wood) + gain.wood, resource_iron: Number(player.resource_iron) + gain.iron, resource_manpower: Number(player.resource_manpower) + gain.manpower };
}

// Authoritative resource generation: runs on the server every minute for every
// player, independent of whether anyone is actively making requests. The lazy
// catch-up above only covers the gap after a server restart/downtime.
async function runGlobalResourceTick(db = null, options = {}) {
  const { suppressErrors = true } = options;
  try {
    const queryable = db || await connect();
    const territories = await getTerritoriesSnapshot(queryable);
    const playersResult = await queryable.query('SELECT id, faction FROM players');

    for (const row of playersResult.rows) {
      const buildings = await getPlayerBuildingLevels(row.id, queryable);
      const production = getProductionFromBuildings(buildings, territories, row.faction || 'blue', true);
      await queryable.query(
        `UPDATE players
         SET resource_food = resource_food + $1,
             resource_wood = resource_wood + $2,
             resource_iron = resource_iron + $3,
             resource_manpower = resource_manpower + $4,
             resource_last_updated = NOW()
         WHERE id = $5`,
        [production.food, production.wood, production.iron, production.manpower, row.id]
      );
    }
  } catch (error) {
    if (!suppressErrors) throw error;
    console.error('Resource tick failed:', error);
  }
}

let resourceTickHandle = null;
function startResourceTickLoop() {
  if (resourceTickHandle) return;
  resourceTickHandle = setInterval(runGlobalResourceTick, 60 * 1000);
}

async function getPlayerWorldState(playerId) {
  const player = await applyOfflineResourceEarnings(playerId) || await getPlayerById(playerId);
  if (!player) return null;

  const db = await connect();
  const territories = await getTerritoriesSnapshot();
  const players = await db.query(
    `SELECT id, username, faction, role
     FROM players ORDER BY id`
  );
  const buildings = await getPlayerBuildingLevels(playerId);
  const production = getProductionFromBuildings(buildings, territories, player.faction || 'blue', true);
  const factionBonuses = getFactionTerritoryBonuses(territories, player.faction || 'blue');

  const stationedResult = await db.query(
    `SELECT territory_id, troops FROM territory_defenders WHERE player_id = $1`,
    [playerId]
  );
  const stationedTroops = {};
  for (const row of stationedResult.rows) {
    stationedTroops[row.territory_id] = Number(row.troops);
  }

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
      factionBonuses,
      stationedTroops,
    },
    world: {
      territories,
      players: players.rows.map((row) => ({
        id: row.id,
        username: row.username,
        faction: row.faction,
        role: row.role,
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

  if (!isSafeUsername(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 letters, numbers, underscores, or hyphens.' });
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
  const role = getRegistrationRole(username);
  const insertPlayer = await db.query(
    `INSERT INTO players (username, password_hash, faction, faction_locked, role, army_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, username, faction, role, faction_locked`,
    [username, passwordHash, faction, Boolean(faction), role, faction ? buildArmyName(faction) : 'Unassigned Army']
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
  await db.query('UPDATE players SET faction = $1, faction_locked = TRUE, army_name = $3 WHERE id = $2', [faction, player.id, buildArmyName(faction)]);
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

app.get('/api/game/battles', requireAuth, asyncHandler(async (req, res) => {
  const db = await connect();
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 50)));
  const result = await db.query(`
    SELECT
      bh.id,
      bh.attacker_faction,
      bh.defender_faction,
      bh.territory_id,
      t.name AS territory_name,
      p.username AS attacker_username,
      bh.troops_sent,
      bh.attackers_lost,
      bh.defenders_lost,
      bh.attackers_surviving,
      bh.defenders_surviving,
      bh.winner,
      bh.owner_before,
      bh.owner_after,
      bh.created_at
    FROM battle_history bh
    LEFT JOIN territories t ON t.id = bh.territory_id
    LEFT JOIN players p ON p.id = bh.attacker_player_id
    ORDER BY bh.id DESC
    LIMIT $1
  `, [limit]);
  res.json({ battles: result.rows });
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

  const player = await getPlayerById(req.user.userId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (!player.faction) return res.status(403).json({ error: 'Choose a faction before defending a territory.' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const territory = await client.query('SELECT * FROM territories WHERE id = $1 FOR UPDATE', [territoryId]);
    if (!territory.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Territory not found.' });
    }
    if (territory.rows[0].owner_faction !== player.faction) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You can only defend your faction territory.' });
    }

    const lockedPlayer = await client.query('SELECT soldiers FROM players WHERE id = $1 FOR UPDATE', [player.id]);
    if (Number(lockedPlayer.rows[0]?.soldiers) < troops) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Not enough soldiers available to defend.' });
    }

    const lockedDefenders = await getLockedTerritoryDefenders(client, territoryId);
    const defenseState = getTerritoryDefenseState(territory.rows[0].defense_troops, lockedDefenders);

    await client.query(
      `INSERT INTO territory_defenders (territory_id, player_id, faction, troops)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (territory_id, player_id)
       DO UPDATE SET troops = territory_defenders.troops + EXCLUDED.troops, faction = EXCLUDED.faction, updated_at = NOW()`,
      [territoryId, player.id, player.faction, troops]
    );
    await client.query(
      `UPDATE players SET soldiers = soldiers - $1, last_action_at = NOW() WHERE id = $2`,
      [troops, player.id]
    );
    await client.query(
      `UPDATE territories SET defense_troops = $1 WHERE id = $2`,
      [defenseState.totalDefenseTroops + troops, territoryId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const snapshot = await getPlayerWorldState(player.id);
  res.json({ ok: true, state: snapshot, stationed: troops, territoryId });
}));

app.post('/api/game/recall-defenders', requireAuth, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  const troops = parsePositiveInt(req.body.troops || 0, 0, 5000);
  if (!territoryId) return res.status(400).json({ error: 'Territory required.' });
  if (troops <= 0) return res.status(400).json({ error: 'Recall count must be positive.' });

  const player = await getPlayerById(req.user.userId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const territory = await client.query('SELECT defense_troops FROM territories WHERE id = $1 FOR UPDATE', [territoryId]);
    if (!territory.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Territory not found.' });
    }

    const lockedDefenders = await getLockedTerritoryDefenders(client, territoryId);
    const guard = lockedDefenders.find((defender) => Number(defender.player_id) === Number(player.id));
    if (!guard) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No defenders to recall from this territory.' });
    }
    if (Number(guard.troops) < troops) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot recall more troops than are stationed.' });
    }

    const defenseState = getTerritoryDefenseState(territory.rows[0].defense_troops, lockedDefenders);

    await client.query(
      `UPDATE territory_defenders SET troops = troops - $1, updated_at = NOW() WHERE territory_id = $2 AND player_id = $3`,
      [troops, territoryId, player.id]
    );
    await client.query(
      `DELETE FROM territory_defenders WHERE territory_id = $1 AND player_id = $2 AND troops <= 0`,
      [territoryId, player.id]
    );
    const remainingDefenders = await client.query(
      `SELECT COALESCE(SUM(troops), 0) AS total
       FROM territory_defenders
       WHERE territory_id = $1`,
      [territoryId]
    );
    await client.query(
      `UPDATE players SET soldiers = soldiers + $1, last_action_at = NOW() WHERE id = $2`,
      [troops, player.id]
    );
    const remainingStationedTroops = Math.max(0, Number(remainingDefenders.rows[0]?.total) || 0);
    await client.query(
      `UPDATE territories SET defense_troops = $1 WHERE id = $2`,
      [defenseState.baseDefenseTroops + remainingStationedTroops, territoryId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const snapshot = await getPlayerWorldState(player.id);
  res.json({ ok: true, state: snapshot, recalled: troops, territoryId });
}));

app.post('/api/game/attack', requireAuth, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  const soldiers = req.body.soldiers;

  const client = await getClient();
  let result;
  try {
    result = await performAttack(client, {
      playerId: req.user.userId,
      territoryId,
      soldiers,
    });
  } catch (error) {
    if (error instanceof AttackError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  } finally {
    client.release();
  }

  const snapshot = await getPlayerWorldState(req.user.userId);
  res.json({ ok: true, state: snapshot, sent: result.sent, territoryId: result.territoryId, outcome: result.outcome });
}));

app.get('/api/game/faction-chat', requireAuth, asyncHandler(async (req, res) => {
  const player = await getCurrentAuthedPlayer(req);
  const db = await connect();
  const result = await getFactionChatMessagesForPlayer(db, player);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ faction: result.faction, messages: result.messages });
}));

app.post('/api/game/faction-chat', requireAuth, factionChatSendRateLimit, asyncHandler(async (req, res) => {
  const player = await getCurrentAuthedPlayer(req);
  const db = await connect();
  const result = await createFactionChatMessage(db, { player, message: req.body.message });
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  res.status(201).json({ faction: player.faction, message: result.message });
}));

app.post('/api/game/resolve-battle', requireAuth, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  if (!territoryId) return res.status(400).json({ error: 'No territory selected.' });

  const player = await getPlayerById(req.user.userId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const db = await getClient();
  try {
    const result = await resolveBattle(db, { player, territoryId });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    const snapshot = await getPlayerWorldState(player.id);
    res.json({ ok: true, outcome: result.outcome, state: snapshot });
  } finally {
    db.release();
  }
}));

app.post('/api/admin/reset-world', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const adminId = req.user.userId;
  const client = await getClient();
  try {
    await runAdminTransaction(client, async () => {
      await resetWorldState(client, { actorId: adminId });
    });
    res.json({ message: 'World reset. Player accounts preserved.' });
  } finally {
    client.release();
  }
}));

app.post('/api/admin/reset-player', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const playerId = parsePositiveInt(req.body.playerId || 0, 0, 100000);
  if (!playerId) return res.status(400).json({ error: 'playerId required.' });

  const client = await getClient();
  try {
    const result = await runAdminTransaction(client, async () => resetPlayerProgress(client, {
      actorId: req.user.userId,
      playerId,
    }));
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
  } finally {
    client.release();
  }
  res.json({ message: 'Player reset.' });
}));

app.post('/api/admin/reset-all-resources', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const client = await getClient();
  try {
    await runAdminTransaction(client, async () => resetAllPlayerResources(client, { actorId: req.user.userId }));
  } finally {
    client.release();
  }
  res.json({ message: 'All player resources reset.' });
}));

app.post('/api/admin/force-tick', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const client = await getClient();
  try {
    await runAdminTransaction(client, async () => {
      await runGlobalResourceTick(client, { suppressErrors: false });
      await logAdminAction(client, req.user.userId, 'force_tick', { mode: 'manual_admin_trigger' });
    });
  } finally {
    client.release();
  }
  res.json({ message: 'Resource tick applied.' });
}));

app.get('/api/admin/players', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = await connect();
  const result = await db.query(`
    SELECT p.id, p.username, p.faction, p.role, p.soldiers,
           p.resource_food, p.resource_wood, p.resource_iron, p.resource_manpower,
           p.last_login_at, p.created_at,
           b.farm, b.lumbermill, b.ironmine, b.barracks
    FROM players p
    LEFT JOIN buildings b ON b.player_id = p.id
    ORDER BY p.id
  `);
  res.json({ players: result.rows });
}));

app.post('/api/admin/player/:id/resources', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const playerId = parsePositiveInt(req.params.id || 0, 0, 100000);
  if (!playerId) return res.status(400).json({ error: 'playerId required.' });

  const client = await getClient();
  let result;
  try {
    result = await runAdminTransaction(client, async () => updatePlayerResources(client, {
      actorId: req.user.userId,
      playerId,
      input: req.body || {},
    }));
  } finally {
    client.release();
  }
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Resources updated.' });
}));

app.post('/api/admin/player/:id/soldiers', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const playerId = parsePositiveInt(req.params.id || 0, 0, 100000);
  if (!playerId) return res.status(400).json({ error: 'playerId required.' });

  const client = await getClient();
  let result;
  try {
    result = await runAdminTransaction(client, async () => updatePlayerSoldiers(client, {
      actorId: req.user.userId,
      playerId,
      soldiers: req.body.soldiers,
    }));
  } finally {
    client.release();
  }
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Soldiers updated.' });
}));

app.post('/api/admin/player/:id/faction', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const playerId = parsePositiveInt(req.params.id || 0, 0, 100000);
  if (!playerId) return res.status(400).json({ error: 'playerId required.' });

  const faction = String(req.body.faction || '').trim().toLowerCase();
  if (!validFactions.includes(faction)) return res.status(400).json({ error: 'Invalid faction.' });

  const db = await getClient();
  let result;
  try {
    result = await runAdminTransaction(db, async () => changePlayerFaction(db, {
      actorId: req.user.userId,
      playerId,
      faction,
    }));
  } finally {
    db.release();
  }
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  const message = result.recalledTroops > 0
    ? `Faction updated. Recalled ${result.recalledTroops} stationed troops from territories that no longer match the player faction.`
    : 'Faction updated.';
  res.json({ message, recalledTroops: result.recalledTroops, clearedTerritories: result.clearedTerritories });
}));

app.post('/api/admin/player/:id/role', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const playerId = parsePositiveInt(req.params.id || 0, 0, 100000);
  if (!playerId) return res.status(400).json({ error: 'playerId required.' });

  const client = await getClient();
  let result;
  try {
    result = await runAdminTransaction(client, async () => updatePlayerRole(client, {
      actorId: req.user.userId,
      playerId,
      role: req.body.role,
    }));
  } finally {
    client.release();
  }
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Role updated.' });
}));

app.get('/api/admin/factions', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = await connect();
  const players = await db.query('SELECT id, username, faction, role FROM players ORDER BY username');
  res.json({ factions: players.rows });
}));

app.get('/api/admin/territories', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = await connect();
  const result = await db.query('SELECT * FROM territories ORDER BY id');
  res.json({ territories: result.rows });
}));

app.post('/api/admin/territory/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const territoryId = String(req.params.id || '').trim();
  if (!territoryId) return res.status(400).json({ error: 'Territory ID required.' });

  const client = await getClient();
  let result;
  try {
    result = await runAdminTransaction(client, async () => updateTerritory(client, {
      actorId: req.user.userId,
      territoryId,
      owner: req.body.owner,
      defense: req.body.defense,
      validFactions,
    }));
  } finally {
    client.release();
  }
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Territory updated.' });
}));

app.post('/api/admin/change-leader', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const playerId = parsePositiveInt(req.body.playerId || 0, 0, 100000);
  if (!playerId) return res.status(400).json({ error: 'playerId required.' });
  const client = await getClient();
  let result;
  try {
    result = await runAdminTransaction(client, async () => assignFactionLeader(client, {
      actorId: req.user.userId,
      playerId,
      faction: req.body.faction,
      validFactions,
    }));
  } finally {
    client.release();
  }
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Leader updated.' });
}));

app.post('/api/admin/capital', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  if (!territoryId) return res.status(400).json({ error: 'Territory ID required.' });

  const client = await getClient();
  let result;
  try {
    result = await runAdminTransaction(client, async () => updateCapital(client, {
      actorId: req.user.userId,
      territoryId,
      faction: req.body.faction,
      validFactions,
    }));
  } finally {
    client.release();
  }
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ message: 'Capital updated.' });
}));

app.get('/api/admin/season-reset-plan', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json({ plan: getSeasonResetPlan() });
}));

// Must be registered last, before listen. Logs the real exception server-side (never
// hidden from operators) but returns a generic JSON 500 to the client instead of
// Express's default HTML error page, which previously made every unexpected failure
// look like an opaque "Request failed: 500" with no detail in the browser.
app.use((err, req, res, next) => {
  const errorCode = err && err.code ? ` [code=${err.code}]` : '';
  const errorMessage = err && err.message ? err.message : String(err);
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}${errorCode}: ${errorMessage}`);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error.' });
});

app.listen(PORT, async () => {
  try {
    await initializeDatabase();
    startResourceTickLoop();
    console.log(`Server ready on http://localhost:${PORT}`);
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    process.exit(1);
  }
});
