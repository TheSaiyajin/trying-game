const { isCapitalTerritory } = require('./territory-protection');

function parseTerritoryUpdate(existingTerritory, body, validFactions) {
  if (!existingTerritory) {
    return { ok: false, status: 404, error: 'Territory not found.' };
  }

  const updates = [];
  const params = [];
  const changes = {};

  if (body.owner !== undefined) {
    const owner = String(body.owner || '').trim().toLowerCase();
    if (!validFactions.includes(owner) && owner !== 'neutral') {
      return { ok: false, status: 400, error: 'Invalid owner faction.' };
    }
    if (isCapitalTerritory(existingTerritory) && owner !== String(existingTerritory.owner_faction || '').toLowerCase()) {
      return { ok: false, status: 400, error: 'Capital ownership cannot be changed.' };
    }
    params.push(owner);
    updates.push(`owner_faction = $${params.length}`);
    changes.owner = owner;
  }

  if (body.defense !== undefined) {
    const defense = Number(body.defense);
    if (!Number.isFinite(defense)) {
      return { ok: false, status: 400, error: 'Invalid defense value.' };
    }
    params.push(Math.max(0, Math.floor(defense)));
    updates.push(`defense_troops = $${params.length}`);
    changes.defense = Math.max(0, Math.floor(defense));
  }

  if (!updates.length) {
    return { ok: false, status: 400, error: 'No fields to update.' };
  }

  return { ok: true, updates, params, changes };
}

async function updateAdminTerritory(client, { territoryId, body, validFactions, actorId }) {
  const existing = await client.query('SELECT * FROM territories WHERE id = $1', [territoryId]);
  const territory = existing.rows[0];
  const parsed = parseTerritoryUpdate(territory, body, validFactions);
  if (!parsed.ok) return parsed;

  const params = [...parsed.params, territoryId];
  await client.query(`UPDATE territories SET ${parsed.updates.join(', ')} WHERE id = $${params.length}`, params);
  if (actorId !== undefined) {
    await client.query(
      'INSERT INTO admin_actions (actor_id, action_name, action_detail) VALUES ($1, $2, $3)',
      [actorId, 'edit_territory', JSON.stringify({ territoryId, ...parsed.changes })]
    );
  }

  return { ok: true, territory: { ...territory, ...parsed.changes } };
}

module.exports = {
  parseTerritoryUpdate,
  updateAdminTerritory,
};
