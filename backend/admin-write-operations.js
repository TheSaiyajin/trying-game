const { isSaiUsername, normalizeRequestedRole } = require('./admin-policy');
const { isCapitalTerritory } = require('./territory-protection');
const {
  getLockedTerritoryDefenders,
  reconcileTerritoryDefendersForNewOwner,
  sumStationedDefenders,
} = require('./defender-garrisons');

const POSTGRES_INT_MAX = 2147483647;

function parseNonNegativeInteger(value, fieldName) {
  if (value === null || value === undefined) {
    return { ok: false, status: 400, error: `${fieldName} must be a valid number.` };
  }
  if (typeof value === 'string' && value.trim() === '') {
    return { ok: false, status: 400, error: `${fieldName} must be a valid number.` };
  }
  if (typeof value === 'boolean') {
    return { ok: false, status: 400, error: `${fieldName} must be a valid number.` };
  }
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return { ok: false, status: 400, error: `${fieldName} must be a valid number.` };
  }
  return {
    ok: true,
    value: Math.min(POSTGRES_INT_MAX, Math.max(0, Math.floor(num))),
  };
}

async function logAdminAction(client, actorId, actionName, actionDetail) {
  await client.query(
    'INSERT INTO admin_actions (actor_id, action_name, action_detail) VALUES ($1, $2, $3)',
    [actorId, actionName, JSON.stringify(actionDetail)]
  );
}

async function updatePlayerResources(client, { actorId, playerId, input }) {
  const existing = await client.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
  if (!existing.rowCount) {
    return { ok: false, status: 404, error: 'Player not found.' };
  }

  const fields = [
    ['food', 'resource_food'],
    ['wood', 'resource_wood'],
    ['iron', 'resource_iron'],
    ['manpower', 'resource_manpower'],
  ];
  const updates = [];
  const params = [];
  const detail = { playerId };

  for (const [inputKey, columnName] of fields) {
    if (input[inputKey] === undefined) continue;
    const parsed = parseNonNegativeInteger(input[inputKey], inputKey);
    if (!parsed.ok) return parsed;
    params.push(parsed.value);
    updates.push(`${columnName} = $${params.length}`);
    detail[inputKey] = parsed.value;
  }

  if (!updates.length) {
    return { ok: false, status: 400, error: 'No resource values provided.' };
  }

  params.push(playerId);
  await client.query(`UPDATE players SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
  await logAdminAction(client, actorId, 'edit_resources', detail);
  return { ok: true, detail };
}

async function updatePlayerSoldiers(client, { actorId, playerId, soldiers }) {
  const existing = await client.query('SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
  if (!existing.rowCount) {
    return { ok: false, status: 404, error: 'Player not found.' };
  }

  const parsed = parseNonNegativeInteger(soldiers, 'soldiers');
  if (!parsed.ok) return parsed;

  await client.query('UPDATE players SET soldiers = $1 WHERE id = $2', [parsed.value, playerId]);
  await logAdminAction(client, actorId, 'edit_soldiers', { playerId, soldiers: parsed.value });
  return { ok: true, soldiers: parsed.value };
}

async function updatePlayerRole(client, { actorId, playerId, role }) {
  const existing = await client.query('SELECT id, username, faction, role FROM players WHERE id = $1 FOR UPDATE', [playerId]);
  if (!existing.rowCount) {
    return { ok: false, status: 404, error: 'Player not found.' };
  }
  const player = existing.rows[0];
  const normalized = normalizeRequestedRole(player, role);
  if (!normalized.ok) return { ...normalized, status: 400 };

  if (normalized.role === 'leader') {
    const currentLeader = await client.query(
      'SELECT player_id FROM faction_leaders WHERE faction = $1 FOR UPDATE',
      [player.faction]
    );
    const previousLeaderId = currentLeader.rows[0]?.player_id;
    if (previousLeaderId && Number(previousLeaderId) !== Number(playerId)) {
      await client.query(
        "UPDATE players SET role = 'member' WHERE id = $1 AND username <> 'Sai' AND role <> 'admin'",
        [previousLeaderId]
      );
    }
    await client.query('UPDATE faction_leaders SET player_id = NULL WHERE player_id = $1', [playerId]);
    await client.query(
      `INSERT INTO faction_leaders (faction, player_id)
       VALUES ($1, $2)
       ON CONFLICT (faction) DO UPDATE SET player_id = EXCLUDED.player_id`,
      [player.faction, playerId]
    );
  } else {
    await client.query('UPDATE faction_leaders SET player_id = NULL WHERE player_id = $1', [playerId]);
  }
  await client.query('UPDATE players SET role = $1 WHERE id = $2', [normalized.role, playerId]);
  await logAdminAction(client, actorId, 'change_role', { playerId, role: normalized.role });
  return { ok: true, role: normalized.role };
}

async function updateTerritory(client, { actorId, territoryId, owner, defense, validFactions }) {
  const existing = await client.query('SELECT * FROM territories WHERE id = $1 FOR UPDATE', [territoryId]);
  if (!existing.rowCount) {
    return { ok: false, status: 404, error: 'Territory not found.' };
  }
  const existingTerritory = existing.rows[0];

  const updates = [];
  const params = [];
  const detail = { territoryId };

  if (owner !== undefined) {
    const normalizedOwner = String(owner || '').trim().toLowerCase();
    if (!validFactions.includes(normalizedOwner) && normalizedOwner !== 'neutral') {
      return { ok: false, status: 400, error: 'Invalid owner faction.' };
    }
    if (isCapitalTerritory(existingTerritory) && normalizedOwner !== String(existingTerritory.owner_faction || '').toLowerCase()) {
      return { ok: false, status: 400, error: 'Capital ownership cannot be changed.' };
    }
    params.push(normalizedOwner);
    updates.push(`owner_faction = $${params.length}`);
    detail.owner = normalizedOwner;
  }

  if (defense !== undefined) {
    const parsed = parseNonNegativeInteger(defense, 'defense');
    if (!parsed.ok) return parsed;
    const defenders = await getLockedTerritoryDefenders(client, territoryId);
    const stationedTroops = sumStationedDefenders(defenders);
    if (parsed.value < stationedTroops) {
      return { ok: false, status: 400, error: 'Defense cannot be below currently stationed troops.' };
    }
    params.push(parsed.value);
    updates.push(`defense_troops = $${params.length}`);
    detail.defense = parsed.value;
  }

  if (!updates.length) {
    return { ok: false, status: 400, error: 'No fields to update.' };
  }

  params.push(territoryId);
  await client.query(`UPDATE territories SET ${updates.join(', ')} WHERE id = $${params.length}`, params);

  const ownerChanged = detail.owner !== undefined && detail.owner !== String(existingTerritory.owner_faction || '').toLowerCase();
  if (ownerChanged) {
    const totalDefense = detail.defense !== undefined ? detail.defense : Number(existingTerritory.defense_troops);
    const reconciliation = await reconcileTerritoryDefendersForNewOwner(client, territoryId, detail.owner, totalDefense);
    if (reconciliation.refundedTroops > 0) {
      detail.defendersRefunded = reconciliation.refundedTroops;
    }
  }

  await logAdminAction(client, actorId, 'edit_territory', detail);
  return { ok: true, detail };
}

async function assignFactionLeader(client, { actorId, playerId, faction, validFactions }) {
  const normalizedFaction = String(faction || '').trim().toLowerCase();
  if (!validFactions.includes(normalizedFaction)) {
    return { ok: false, status: 400, error: 'Invalid faction.' };
  }

  const existing = await client.query('SELECT id, username, faction, role FROM players WHERE id = $1 FOR UPDATE', [playerId]);
  const player = existing.rows[0];
  if (!player) {
    return { ok: false, status: 404, error: 'Player not found.' };
  }
  if (isSaiUsername(player.username)) {
    return { ok: false, status: 400, error: 'Sai must remain admin.' };
  }
  if (player.faction !== normalizedFaction) {
    return { ok: false, status: 400, error: 'Player must belong to the selected faction.' };
  }

  const currentLeader = await client.query(
    'SELECT player_id FROM faction_leaders WHERE faction = $1 FOR UPDATE',
    [normalizedFaction]
  );
  const previousLeaderId = currentLeader.rows[0]?.player_id;
  if (previousLeaderId && Number(previousLeaderId) !== Number(playerId)) {
    await client.query(
      "UPDATE players SET role = 'member' WHERE id = $1 AND username <> 'Sai' AND role <> 'admin'",
      [previousLeaderId]
    );
  }
  await client.query('UPDATE faction_leaders SET player_id = NULL WHERE player_id = $1', [playerId]);
  await client.query(
    `INSERT INTO faction_leaders (faction, player_id)
     VALUES ($1, $2)
     ON CONFLICT (faction) DO UPDATE SET player_id = EXCLUDED.player_id`,
    [normalizedFaction, playerId]
  );
  await client.query('UPDATE players SET role = $1 WHERE id = $2', ['leader', playerId]);
  await logAdminAction(client, actorId, 'change_leader', { faction: normalizedFaction, playerId });
  return { ok: true, faction: normalizedFaction, playerId };
}

async function updateCapital(client, { actorId, territoryId, faction, validFactions }) {
  const normalizedFaction = String(faction || '').trim().toLowerCase();
  if (!validFactions.includes(normalizedFaction)) {
    return { ok: false, status: 400, error: 'Invalid faction.' };
  }

  const existing = await client.query('SELECT id, owner_faction, is_capital FROM territories WHERE id = $1 FOR UPDATE', [territoryId]);
  if (!existing.rowCount) {
    return { ok: false, status: 404, error: 'Territory not found.' };
  }
  const territory = existing.rows[0];
  const territoryOwner = String(territory.owner_faction || '').trim().toLowerCase();

  // A capital can only ever be a territory the faction already owns. This also rejects
  // trying to make another faction's existing capital your own: that territory's owner is
  // the other faction, not this one, so it fails the ownership check below.
  if (territoryOwner !== normalizedFaction) {
    return { ok: false, status: 400, error: 'A territory can only become a capital for the faction that already owns it.' };
  }

  const previousCapital = await client.query(
    'SELECT id FROM territories WHERE is_capital = TRUE AND owner_faction = $1 FOR UPDATE',
    [normalizedFaction]
  );
  const previousCapitalId = previousCapital.rows[0]?.id || null;

  if (previousCapitalId === territoryId) {
    // Already the capital for this faction: nothing to change.
    return { ok: true, territoryId, faction: normalizedFaction, previousCapitalId };
  }

  if (previousCapitalId) {
    await client.query('UPDATE territories SET is_capital = FALSE WHERE id = $1', [previousCapitalId]);
  }
  await client.query('UPDATE territories SET is_capital = TRUE WHERE id = $1', [territoryId]);
  await logAdminAction(client, actorId, 'change_capital', { territoryId, faction: normalizedFaction, previousCapitalId });
  return { ok: true, territoryId, faction: normalizedFaction, previousCapitalId };
}

module.exports = {
  POSTGRES_INT_MAX,
  parseNonNegativeInteger,
  logAdminAction,
  updatePlayerResources,
  updatePlayerSoldiers,
  updatePlayerRole,
  updateTerritory,
  assignFactionLeader,
  updateCapital,
};
