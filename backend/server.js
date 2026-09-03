const http = require('http');
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
  getFactionStorageCaps,
  limitResourceGain,
  limitPassiveFortressTroopGain,
  MAX_BUILDING_LEVEL,
  PASSIVE_FORTRESS_TROOP_CAP,
} = require('./game-logic');
const { AttackError, performAttack } = require('./attack-logic');
const { TrainingError, performSoldierTraining } = require('./soldier-training');
const {
  isSafeUsername,
  isAuthorizedAdminPlayer,
  getRegistrationRole,
} = require('./admin-policy');
const { changePlayerFaction } = require('./admin-faction-change');
const {
  STARTING_PLAYER_RESOURCES,
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
  getActiveRallies,
  getExpiredRallyTerritoryIds,
  launchRally,
  startOrJoinRally,
} = require('./rally-battles');
const {
  ensureCurrentSeason,
  ensurePlayerFactionAssignment,
  forceFinishCurrentSeason,
  startCurrentSeasonNow,
  getFactionMemberCounts,
  getSeasonMembership,
  hasSeasonStarted,
  computeScores,
} = require('./season');
const { getCurrentUtcDayBounds } = require('./season-time');
const { resolveTrustProxySetting } = require('./trust-proxy');
const { attachRealtime } = require('./realtime');
const { addPlayerSeasonStats, getSeasonStats } = require('./player-season-stats');
const {
 CHAT_RESPONSE_LIMIT,
 createFactionChatMessage,
 getFactionChatMessagesForPlayer,
 listFactionMembersForPlayer,
} = require('./faction-chat');

dotenv.config();

const app = express();
const server = http.createServer(app);
const { notifyStateChanged } = attachRealtime(server, { verifyToken });
const PORT = Number(process.env.PORT || 3000);
const validFactions = ['blue', 'red', 'green'];
const buildingNames = ['farm', 'lumbermill', 'ironmine', 'barracks', 'storage'];
let observedSeasonId = null;

// Must be set before any express-rate-limit middleware: SaiWars sits behind
// Cloudflare -> Nginx -> Express (2 hops), and rate limiting needs the real client IP, not
// the proxy's, to key limits correctly. See trust-proxy.js for the validated resolution.
app.set('trust proxy', resolveTrustProxySetting());

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  max: Number(process.env.RATE_LIMIT_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
}));

app.use('/api', (req, res, next) => {
  const isStateMutation = req.method !== 'GET' && (
    /^\/game\/(upgrade-building|train-soldiers|defend|recall-defenders|attack|launch-rally)$/.test(req.path)
    || req.path === '/season/join'
    || req.path.startsWith('/admin/')
  );
  if (isStateMutation) {
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) notifyStateChanged();
    });
  }
  next();
});

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

// Verifies the JWT and confirms/rotates the current season. Joining is deliberately separate:
// merely logging in must never enroll a player or bypass the pre-season Join button.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  try {
    req.user = verifyToken(token);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired session token.' });
  }

  const client = await getClient();
  try {
    const season = await ensureCurrentSeason(client);
    if (observedSeasonId !== null && observedSeasonId !== season.id) notifyStateChanged();
    observedSeasonId = season.id;
    req.currentSeason = season;
    next();
  } catch (error) {
    next(error);
  } finally {
    client.release();
  }
}

async function getRequestSeasonMembership(req) {
  if (req.currentSeasonMembership !== undefined) return req.currentSeasonMembership;
  const db = await connect();
  req.currentSeasonMembership = await getSeasonMembership(
    db,
    req.currentSeason.id,
    req.user.userId
  );
  return req.currentSeasonMembership;
}

// All gameplay reads and writes use this gate. Client-side hiding is only presentation;
// direct API calls cannot play before the start time or without joining the current season.
async function requirePlayableSeason(req, res, next) {
  try {
    if (!hasSeasonStarted(req.currentSeason)) {
      return res.status(409).json({
        error: 'The season has not started yet.',
        code: 'SEASON_NOT_STARTED',
        startsAt: req.currentSeason.starts_at,
      });
    }
    const membership = await getRequestSeasonMembership(req);
    if (!membership) {
      return res.status(403).json({
        error: 'Join the current season before playing.',
        code: 'SEASON_JOIN_REQUIRED',
      });
    }
    next();
  } catch (error) {
    next(error);
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
  const numberValue = typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())
    ? Number(value)
    : value;
  if (typeof numberValue !== 'number' || !Number.isSafeInteger(numberValue) || numberValue <= 0) return fallback;
  return Math.min(numberValue, maxValue);
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
    storage: Number(row.storage || 1),
  };
}

async function getTerritoriesSnapshot(db = null) {
  const queryable = db || await connect();
  const result = await queryable.query(`
    SELECT t.*,
      EXISTS (
        SELECT 1 FROM attack_targets at
        WHERE at.territory_id = t.id AND at.phase = 'active'
      ) AS contested,
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
    contested: !!row.contested,
    protectedUntil: row.protected_until || null,
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
  const storageCaps = getFactionStorageCaps(territories, player.faction, buildings);
  const buildingUpgradeCosts = Object.fromEntries(buildingNames.map((key) => [
    key,
    buildings[key] >= MAX_BUILDING_LEVEL ? null : getUpgradeCost(key, buildings[key] + 1),
  ]));

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
    buildingUpgradeCosts,
    storageCaps,
    nextStorageCaps: buildings.storage >= MAX_BUILDING_LEVEL
      ? null
      : getFactionStorageCaps(territories, player.faction, { ...buildings, storage: buildings.storage + 1 }),
    territories,
  };
}

async function applyOfflineResourceEarnings(playerId, db = null) {
  const queryable = db || await connect();
  const player = await getPlayerById(playerId, queryable);
  if (!player) return null;

  if (!validFactions.includes(player.faction)) {
    await queryable.query(
      `UPDATE players
       SET resource_food = $1,
           resource_wood = $2,
           resource_iron = $3,
           resource_manpower = $4,
           soldiers = $5,
           resource_last_updated = NOW()
       WHERE id = $6`,
      [
        STARTING_PLAYER_RESOURCES.food,
        STARTING_PLAYER_RESOURCES.wood,
        STARTING_PLAYER_RESOURCES.iron,
        STARTING_PLAYER_RESOURCES.manpower,
        STARTING_PLAYER_RESOURCES.soldiers,
        playerId,
      ]
    );
    return {
      ...player,
      resource_food: STARTING_PLAYER_RESOURCES.food,
      resource_wood: STARTING_PLAYER_RESOURCES.wood,
      resource_iron: STARTING_PLAYER_RESOURCES.iron,
      resource_manpower: STARTING_PLAYER_RESOURCES.manpower,
      soldiers: STARTING_PLAYER_RESOURCES.soldiers,
    };
  }

  const faction = player.faction;
  const lastUpdated = player.resource_last_updated ? new Date(player.resource_last_updated) : new Date();
  const secondsSince = Math.max(0, Math.min((Date.now() - lastUpdated.getTime()) / 1000, 60 * 60 * 12));
  if (secondsSince < 60) return player;

  const wholeMinutes = Math.floor(secondsSince / 60);
  if (wholeMinutes <= 0) return player;

  const buildings = await getPlayerBuildingLevels(playerId, queryable);
  const territories = await getTerritoriesSnapshot(queryable);
  const production = getProductionFromBuildings(buildings, territories, faction, true);
  const gain = limitResourceGain({
    food: player.resource_food,
    wood: player.resource_wood,
    iron: player.resource_iron,
    manpower: player.resource_manpower,
  }, {
    food: Math.max(0, Math.floor(production.food * wholeMinutes)),
    wood: Math.max(0, Math.floor(production.wood * wholeMinutes)),
    iron: Math.max(0, Math.floor(production.iron * wholeMinutes)),
    manpower: Math.max(0, Math.floor(production.manpower * wholeMinutes)),
  }, getFactionStorageCaps(territories, faction, buildings));
  const generatedFortressTroops = getFactionTerritoryBonuses(territories, faction).fortressTroops * wholeMinutes;
  const fortressTroops = limitPassiveFortressTroopGain(player.soldiers, generatedFortressTroops);

  await queryable.query(
    `UPDATE players
     SET resource_food = resource_food + $1,
         resource_wood = resource_wood + $2,
         resource_iron = resource_iron + $3,
         resource_manpower = resource_manpower + $4,
         soldiers = soldiers + $5,
         resource_last_updated = resource_last_updated + ($6 * INTERVAL '1 minute'),
         last_action_at = NOW()
     WHERE id = $7`,
    [gain.food, gain.wood, gain.iron, gain.manpower, fortressTroops, wholeMinutes, playerId]
  );

  return {
    ...player,
    resource_food: Number(player.resource_food) + gain.food,
    resource_wood: Number(player.resource_wood) + gain.wood,
    resource_iron: Number(player.resource_iron) + gain.iron,
    resource_manpower: Number(player.resource_manpower) + gain.manpower,
    soldiers: Number(player.soldiers) + fortressTroops,
  };
}

// Authoritative resource generation: runs on the server every minute for every
// player, independent of whether anyone is actively making requests. The lazy
// catch-up above only covers the gap after a server restart/downtime.
async function runGlobalResourceTick(db = null, options = {}) {
  const { suppressErrors = true } = options;
  try {
    const queryable = db || await connect();
    const season = await ensureCurrentSeason(queryable);
    if (!hasSeasonStarted(season)) {
      return { skipped: true, reason: 'preseason' };
    }
    const territories = await getTerritoriesSnapshot(queryable);
    const playersResult = await queryable.query(
      `SELECT id, faction, resource_food, resource_wood, resource_iron, resource_manpower, soldiers
       FROM players`
    );

    for (const row of playersResult.rows) {
      if (!validFactions.includes(row.faction)) {
        await queryable.query(
          `UPDATE players
           SET resource_food = $1,
               resource_wood = $2,
               resource_iron = $3,
               resource_manpower = $4,
               soldiers = $5,
               resource_last_updated = NOW()
           WHERE id = $6`,
          [
            STARTING_PLAYER_RESOURCES.food,
            STARTING_PLAYER_RESOURCES.wood,
            STARTING_PLAYER_RESOURCES.iron,
            STARTING_PLAYER_RESOURCES.manpower,
            STARTING_PLAYER_RESOURCES.soldiers,
            row.id,
          ]
        );
        continue;
      }

      const buildings = await getPlayerBuildingLevels(row.id, queryable);
      const faction = row.faction;
      const production = getProductionFromBuildings(buildings, territories, faction, true);
      const gain = limitResourceGain({
        food: row.resource_food,
        wood: row.resource_wood,
        iron: row.resource_iron,
        manpower: row.resource_manpower,
      }, production, getFactionStorageCaps(territories, faction, buildings));
      const generatedFortressTroops = getFactionTerritoryBonuses(territories, faction).fortressTroops;
      const fortressTroops = limitPassiveFortressTroopGain(row.soldiers, generatedFortressTroops);
      await queryable.query(
        `UPDATE players
         SET resource_food = resource_food + $1,
             resource_wood = resource_wood + $2,
             resource_iron = resource_iron + $3,
             resource_manpower = resource_manpower + $4,
             soldiers = soldiers + $5,
             resource_last_updated = NOW()
         WHERE id = $6`,
        [gain.food, gain.wood, gain.iron, gain.manpower, fortressTroops, row.id]
      );
    }
    if (playersResult.rowCount > 0) notifyStateChanged();
    return { skipped: false };
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

let rallyResolutionHandle = null;
let rallyResolutionRunning = false;

async function runExpiredRallyResolution({ now = new Date(), suppressErrors = true } = {}) {
  if (rallyResolutionRunning) return { resolved: 0, skipped: true };
  rallyResolutionRunning = true;
  let resolved = 0;
  try {
    const db = await connect();
    const territoryIds = await getExpiredRallyTerritoryIds(db, { now });
    for (const territoryId of territoryIds) {
      const client = await getClient();
      try {
        const result = await resolveBattle(client, { territoryId, now });
        if (result.ok || result.cancelled) resolved += 1;
      } finally {
        client.release();
      }
    }
    if (resolved > 0) notifyStateChanged();
    return { resolved, skipped: false };
  } catch (error) {
    if (!suppressErrors) throw error;
    console.error('Rally resolution failed:', error);
    return { resolved, skipped: false, error };
  } finally {
    rallyResolutionRunning = false;
  }
}

function startRallyResolutionLoop() {
  if (rallyResolutionHandle) return;
  runExpiredRallyResolution();
  rallyResolutionHandle = setInterval(runExpiredRallyResolution, 5 * 1000);
}

async function getPlayerWorldState(playerId, season = null) {
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
  const storageCaps = getFactionStorageCaps(territories, player.faction || 'blue', buildings);
  const buildingUpgradeCosts = Object.fromEntries(buildingNames.map((key) => [
    key,
    buildings[key] >= MAX_BUILDING_LEVEL ? null : getUpgradeCost(key, buildings[key] + 1),
  ]));

  const stationedResult = await db.query(
    `SELECT territory_id, troops FROM territory_defenders WHERE player_id = $1`,
    [playerId]
  );
  const stationedTroops = {};
  for (const row of stationedResult.rows) {
    stationedTroops[row.territory_id] = Number(row.troops);
  }
  const rallies = season
    ? await getActiveRallies(db, { seasonId: season.id, playerId, playerFaction: player.faction })
    : [];

  return {
    player: {
      id: player.id,
      username: player.username,
      faction: player.faction,
      role: player.role,
      needsFactionSelection: !player.faction,
      joinedSeason: true,
      resources: {
        food: Number(player.resource_food),
        wood: Number(player.resource_wood),
        iron: Number(player.resource_iron),
        manpower: Number(player.resource_manpower),
      },
      soldiers: Number(player.soldiers),
      buildings,
      production,
      buildingUpgradeCosts,
      factionBonuses,
      storageCaps,
      nextStorageCaps: buildings.storage >= MAX_BUILDING_LEVEL
        ? null
        : getFactionStorageCaps(territories, player.faction || 'blue', { ...buildings, storage: buildings.storage + 1 }),
      stationedTroops,
      fortressTroopCap: PASSIVE_FORTRESS_TROOP_CAP,
    },
    world: {
      territories,
      rallies,
      players: players.rows.map((row) => ({
        id: row.id,
        username: row.username,
        faction: row.faction,
        role: row.role,
      })),
    },
    season: await buildSeasonSummary(db, season, territories),
  };
}

async function buildSeasonSummary(db, season, territories = [], now = new Date()) {
  if (!season) return null;
  const liveScores = computeScores(territories);
  const memberCounts = await getFactionMemberCounts(db, season.id);
  const started = hasSeasonStarted(season, now);
  return {
    seasonNumber: season.season_number,
    startsAt: season.starts_at,
    endsAt: season.ends_at,
    status: started ? 'active' : 'preparing',
    hasStarted: started,
    scores: liveScores,
    memberCounts,
    joinedCount: memberCounts.blue + memberCounts.red + memberCounts.green,
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
  // Faction is never accepted from the client: it is only ever assigned by the current
  // season's automatic balancing on first authenticated activity (see season.js). Any
  // faction submitted here is silently ignored, never validated or trusted.

  if (!isSafeUsername(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 letters, numbers, underscores, or hyphens.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
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
     VALUES ($1, $2, NULL, FALSE, $3, 'Unassigned Army')
     RETURNING id, username, faction, role, faction_locked`,
    [username, passwordHash, role]
  );

  const player = insertPlayer.rows[0];
  await db.query(
    `INSERT INTO buildings (player_id, farm, lumbermill, ironmine, barracks, storage)
     VALUES ($1, 1, 1, 1, 1, 1)`,
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
  const membership = await getRequestSeasonMembership(req);
  const started = hasSeasonStarted(req.currentSeason);
  res.json({
    id: player.id,
    username: player.username,
    faction: started && membership ? membership.faction : null,
    role: player.role,
    factionLocked: Boolean(started && membership),
    joinedSeason: Boolean(membership),
    needsSeasonJoin: !membership,
  });
}));

// Disabled for normal players: factions are only ever assigned by the current season's
// automatic balancing (see season.js), never chosen manually. Kept as a route (rather than
// removed) so old clients get a clear, stable error instead of a raw 404.
app.post('/api/player/faction', requireAuth, asyncHandler(async (req, res) => {
  res.status(403).json({ error: 'Faction is assigned automatically at the start of each season and cannot be chosen manually.' });
}));

app.post('/api/season/join', requireAuth, asyncHandler(async (req, res) => {
  const client = await getClient();
  let faction;
  try {
    const now = new Date();
    const resourceStartAt = hasSeasonStarted(req.currentSeason, now)
      ? now
      : new Date(req.currentSeason.starts_at);
    faction = await ensurePlayerFactionAssignment(client, {
      seasonId: req.currentSeason.id,
      playerId: req.user.userId,
      resourceStartAt,
    });
  } finally {
    client.release();
  }

  res.json({
    joined: true,
    seasonNumber: req.currentSeason.season_number,
    startsAt: req.currentSeason.starts_at,
    hasStarted: hasSeasonStarted(req.currentSeason),
    faction: hasSeasonStarted(req.currentSeason) ? faction : null,
  });
}));

app.get('/api/world', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
  const snapshot = await getPlayerWorldState(req.user.userId, req.currentSeason);
  if (!snapshot) return res.status(404).json({ error: 'Player not found.' });
  res.json(snapshot.world);
}));

app.get('/api/player/state', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
  const snapshot = await getPlayerWorldState(req.user.userId, req.currentSeason);
  if (!snapshot) return res.status(404).json({ error: 'Player not found.' });
  res.json(snapshot.player);
}));

app.get('/api/game/state', requireAuth, asyncHandler(async (req, res) => {
  const db = await connect();
  const player = await getPlayerById(req.user.userId, db);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const membership = await getRequestSeasonMembership(req);
  const now = new Date();
  const started = hasSeasonStarted(req.currentSeason, now);

  if (!membership || !started) {
    return res.json({
      player: {
        id: player.id,
        username: player.username,
        faction: null,
        role: player.role,
        joinedSeason: Boolean(membership),
        needsSeasonJoin: !membership,
      },
      world: { territories: [], rallies: [], players: [] },
      season: await buildSeasonSummary(db, req.currentSeason, [], now),
      serverTime: now.getTime(),
    });
  }

  const snapshot = await getPlayerWorldState(req.user.userId, req.currentSeason);
  res.json({
    player: snapshot.player,
    world: snapshot.world,
    season: snapshot.season,
    serverTime: Date.now(),
  });
}));

app.get('/api/game/battles', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
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

app.get('/api/game/activity-stats', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
  const db = await connect();
  const stats = await getSeasonStats(db, {
    seasonId: req.currentSeason.id,
    playerId: req.user.userId,
  });
  res.json(stats);
}));

app.post('/api/game/upgrade-building', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
  const buildingKey = sanitizeBuildingName(req.body.building);
  if (!buildingKey) return res.status(400).json({ error: 'Invalid building.' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const playerResult = await client.query('SELECT * FROM players WHERE id = $1 FOR UPDATE', [req.user.userId]);
    const buildingResult = await client.query('SELECT * FROM buildings WHERE player_id = $1 FOR UPDATE', [req.user.userId]);
    const player = playerResult.rows[0];
    const buildings = buildingResult.rows[0];
    if (!player || !buildings) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Player not found.' });
    }

    const currentLevel = Number(buildings[buildingKey] || 1);
    if (currentLevel >= MAX_BUILDING_LEVEL) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `${buildingKey} is already at the maximum level of ${MAX_BUILDING_LEVEL}.` });
    }

    const cost = getUpgradeCost(buildingKey, currentLevel + 1);
    if (Number(player.resource_food) < cost.food || Number(player.resource_wood) < cost.wood || Number(player.resource_iron) < cost.iron) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Not enough resources for the building upgrade.' });
    }

    await client.query(
      `UPDATE players SET resource_food = resource_food - $1, resource_wood = resource_wood - $2, resource_iron = resource_iron - $3 WHERE id = $4`,
      [cost.food, cost.wood, cost.iron, player.id]
    );
    await client.query(
      `UPDATE buildings SET ${buildingKey} = ${buildingKey} + 1, updated_at = NOW() WHERE player_id = $1`,
      [player.id]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const snapshot = await getPlayerWorldState(req.user.userId, req.currentSeason);
  res.json({ ok: true, state: snapshot });
}));

app.post('/api/game/train-soldiers', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
  const count = parsePositiveInt(req.body.amount || 0, 0, 5000);
  if (count <= 0) return res.status(400).json({ error: 'Training amount must be positive.' });

  const client = await getClient();
  let result;
  try {
    result = await performSoldierTraining(client, { playerId: req.user.userId, count });
  } catch (error) {
    if (error instanceof TrainingError) return res.status(error.status).json({ error: error.message });
    throw error;
  } finally {
    client.release();
  }

  const snapshot = await getPlayerWorldState(req.user.userId, req.currentSeason);
  res.json({ ok: true, state: snapshot, trainingCost: result.cost, trained: result.trained });
}));

app.post('/api/game/defend', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
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
    const activeBattle = await client.query(
      'SELECT phase FROM attack_targets WHERE territory_id = $1 FOR UPDATE',
      [territoryId]
    );
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
    if (activeBattle.rows[0]?.phase === 'active') {
      await client.query(
        `INSERT INTO battle_defender_contributions (territory_id, player_id, faction, contribution)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (territory_id, player_id)
         DO UPDATE SET contribution = battle_defender_contributions.contribution + EXCLUDED.contribution,
                       faction = EXCLUDED.faction`,
        [territoryId, player.id, player.faction, troops]
      );
    }
    await addPlayerSeasonStats(client, req.currentSeason.id, player.id, {
      reinforcement_troops_sent: troops,
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const snapshot = await getPlayerWorldState(player.id, req.currentSeason);
  res.json({ ok: true, state: snapshot, stationed: troops, territoryId });
}));

app.post('/api/game/recall-defenders', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  const troops = parsePositiveInt(req.body.troops || 0, 0, 5000);
  if (!territoryId) return res.status(400).json({ error: 'Territory required.' });
  if (troops <= 0) return res.status(400).json({ error: 'Recall count must be positive.' });

  const player = await getPlayerById(req.user.userId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });

  const client = await getClient();
  try {
    await client.query('BEGIN');
    const activeBattle = await client.query(
      'SELECT phase FROM attack_targets WHERE territory_id = $1 FOR UPDATE',
      [territoryId]
    );
    if (activeBattle.rows[0]?.phase === 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Defenders cannot be recalled during an active battle.' });
    }
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

  const snapshot = await getPlayerWorldState(player.id, req.currentSeason);
  res.json({ ok: true, state: snapshot, recalled: troops, territoryId });
}));

app.post('/api/game/attack', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  const soldiers = req.body.soldiers;
  const mode = String(req.body.mode || 'rally').trim().toLowerCase();

  const client = await getClient();
  let result;
  try {
    const db = await connect();
    const targetResult = await db.query('SELECT owner_faction FROM territories WHERE id = $1', [territoryId]);
    const targetOwner = targetResult.rows[0]?.owner_faction;
    result = targetOwner === 'neutral'
      ? await performAttack(client, {
        playerId: req.user.userId,
        territoryId,
        soldiers,
        seasonId: req.currentSeason.id,
        neutralOnly: true,
      })
      : await startOrJoinRally(client, {
        playerId: req.user.userId,
        territoryId,
        soldiers,
        seasonId: req.currentSeason.id,
        mode,
      });
  } catch (error) {
    if (error instanceof AttackError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  } finally {
    client.release();
  }

  const snapshot = await getPlayerWorldState(req.user.userId, req.currentSeason);
  res.json({
    ok: true,
    state: snapshot,
    sent: result.sent,
    territoryId: result.territoryId || territoryId,
    outcome: result.outcome || null,
    rally: result.rally || null,
    rallyCreated: Boolean(result.rally && result.created),
  });
}));

app.post('/api/game/launch-rally', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
  const territoryId = String(req.body.territoryId || '').trim();
  if (!territoryId) return res.status(400).json({ error: 'Territory required.' });

  const client = await getClient();
  try {
    await launchRally(client, { territoryId, playerId: req.user.userId });
  } catch (error) {
    if (error instanceof AttackError) return res.status(error.status).json({ error: error.message });
    throw error;
  } finally {
    client.release();
  }

  const snapshot = await getPlayerWorldState(req.user.userId, req.currentSeason);
  res.json({ ok: true, launched: true, state: snapshot, territoryId });
}));

app.get('/api/game/faction-chat', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
  const player = await getCurrentAuthedPlayer(req);
  const db = await connect();
  const result = await getFactionChatMessagesForPlayer(db, player, req.currentSeason.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ faction: result.faction, seasonId: result.seasonId, messages: result.messages });
}));

app.get('/api/game/faction-members', requireAuth, requirePlayableSeason, asyncHandler(async (req, res) => {
  const player = await getCurrentAuthedPlayer(req);
  const db = await connect();
  const result = await listFactionMembersForPlayer(db, player);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ faction: result.faction, total: result.total, members: result.members });
}));

app.post('/api/game/faction-chat', requireAuth, requirePlayableSeason, factionChatSendRateLimit, asyncHandler(async (req, res) => {
  const player = await getCurrentAuthedPlayer(req);
  const db = await connect();
  const result = await createFactionChatMessage(db, { player, seasonId: req.currentSeason.id, message: req.body.message });
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  res.status(201).json({ faction: player.faction, message: result.message });
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

app.get('/api/game/season-history', requireAuth, asyncHandler(async (req, res) => {
  const db = await connect();
  const limit = Math.min(20, Math.max(1, Number(req.query.limit || 10)));
  const result = await db.query(
    `SELECT season_number, starts_at, ends_at, status, blue_score, red_score, green_score, result, completed_at
     FROM seasons
     WHERE season_number > 0 AND status = 'completed'
     ORDER BY season_number DESC
     LIMIT $1`,
    [limit]
  );
  res.json({
    seasons: result.rows.map((row) => ({
      seasonNumber: row.season_number,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      blueScore: row.blue_score,
      redScore: row.red_score,
      greenScore: row.green_score,
      result: row.result,
      completedAt: row.completed_at,
    })),
  });
}));

app.get('/api/admin/season', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const db = await connect();
  const season = req.currentSeason;
  const memberCounts = await getFactionMemberCounts(db, season.id);
  const territories = await getTerritoriesSnapshot();
  res.json({
    season: {
      id: season.id,
      seasonNumber: season.season_number,
      startsAt: season.starts_at,
      endsAt: season.ends_at,
      status: hasSeasonStarted(season) ? 'active' : 'preparing',
      hasStarted: hasSeasonStarted(season),
      memberCounts,
      liveScores: computeScores(territories),
    },
  });
}));

app.post('/api/admin/season/force-finish', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.body.confirm !== true) {
    return res.status(400).json({ error: 'Set confirm: true to force-finish the current season.' });
  }

  const client = await getClient();
  let result;
  try {
    result = await forceFinishCurrentSeason(client, { actorId: req.user.userId });
  } finally {
    client.release();
  }

  res.json({
    message: result.finishedSeason
      ? `Season #${result.finishedSeason.season_number} force-finished (${result.finishedSeason.result}). Registration for Season #${result.season.season_number} is open.`
      : `Registration for Season #${result.season.season_number} is open.`,
    finishedSeason: result.finishedSeason,
    newSeason: {
      id: result.season.id,
      seasonNumber: result.season.season_number,
      startsAt: result.season.starts_at,
      endsAt: result.season.ends_at,
    },
  });
}));

app.post('/api/admin/season/start-now', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (req.body.confirm !== true) {
    return res.status(400).json({ error: 'Set confirm: true to start the season now.' });
  }

  const client = await getClient();
  let result;
  try {
    result = await startCurrentSeasonNow(client, { actorId: req.user.userId });
  } finally {
    client.release();
  }

  res.json({
    message: result.started
      ? `Season #${result.season.season_number} started. The seven-day timer is now running.`
      : `Season #${result.season.season_number} is already active.`,
    started: result.started,
    season: {
      seasonNumber: result.season.season_number,
      startsAt: result.season.starts_at,
      endsAt: result.season.ends_at,
    },
  });
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

if (require.main === module) {
  server.listen(PORT, async () => {
    try {
      await initializeDatabase();
      startResourceTickLoop();
      startRallyResolutionLoop();
      console.log(`Server ready on http://localhost:${PORT}`);
    } catch (error) {
      console.error('Database initialization failed:', error.message);
      process.exit(1);
    }
  });
}

module.exports = { applyOfflineResourceEarnings, runExpiredRallyResolution, runGlobalResourceTick };
