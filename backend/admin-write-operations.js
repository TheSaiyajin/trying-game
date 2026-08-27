const { isSaiUsername, normalizeRequestedRole } = require('./admin-policy');
const { isCapitalTerritory } = require('./territory-protection');

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
  const existing = await client.query('SELECT id, username, role FROM players WHERE id = $1 FOR UPDATE', [playerId]);
  if (!existing.rowCount) {
    return { ok: false, status: 404, error: 'Player not found.' };
  }
  const normalized = normalizeRequestedRole(existing.rows[0], role);
  if (!normalized.ok) return { ...normalized, status: 400 };

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
    params.push(parsed.value);
    updates.push(`defense_troops = $${params.length}`);
    detail.defense = parsed.value;
  }

  if (!updates.length) {
    return { ok: false, status: 400, error: 'No fields to update.' };
  }

  params.push(territoryId);
  await client.query(`UPDATE territories SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
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

module.exports = {
  POSTGRES_INT_MAX,
  parseNonNegativeInteger,
  logAdminAction,
  updatePlayerResources,
  updatePlayerSoldiers,
  updatePlayerRole,
  updateTerritory,
  assignFactionLeader,
};
