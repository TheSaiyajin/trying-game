const CHAT_MAX_LENGTH = 500;
const CHAT_RESPONSE_LIMIT = 100;

function getMessageLength(message) {
  return Array.from(String(message || '')).length;
}

function normalizeFactionChatMessage(message) {
  const trimmed = String(message || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Message cannot be empty.' };
  }
  if (getMessageLength(trimmed) > CHAT_MAX_LENGTH) {
    return { ok: false, error: 'Message must be 500 characters or fewer.' };
  }
  return { ok: true, message: trimmed };
}

function assertFactionPlayer(player) {
  if (!player) {
    return { ok: false, status: 404, error: 'Player not found.' };
  }
  if (!player.faction) {
    return { ok: false, status: 403, error: 'Choose a faction before using faction chat.' };
  }
  return { ok: true };
}

// Messages are always scoped to a specific season_id + faction: a player reassigned to a
// different faction next season (or a season that has since ended) must never see chat from
// a faction/season combination they were not a current member of at the time.
async function listFactionChatMessages(client, seasonId, faction, limit = CHAT_RESPONSE_LIMIT) {
  const safeLimit = Math.max(1, Math.min(CHAT_RESPONSE_LIMIT, Number(limit) || CHAT_RESPONSE_LIMIT));
  const result = await client.query(
    `SELECT fcm.id, fcm.season_id, fcm.faction, fcm.player_id, p.username, fcm.message, fcm.created_at
     FROM faction_chat_messages fcm
     INNER JOIN players p ON p.id = fcm.player_id
     WHERE fcm.season_id = $1 AND fcm.faction = $2
     ORDER BY fcm.created_at DESC, fcm.id DESC
     LIMIT $3`,
    [seasonId, faction, safeLimit]
  );

  return result.rows.reverse().map((row) => ({
    id: row.id,
    seasonId: row.season_id,
    faction: row.faction,
    playerId: row.player_id,
    username: row.username,
    message: row.message,
    createdAt: row.created_at,
  }));
}

async function getFactionChatMessagesForPlayer(client, player, seasonId, limit = CHAT_RESPONSE_LIMIT) {
  const playerStatus = assertFactionPlayer(player);
  if (!playerStatus.ok) {
    return playerStatus;
  }
  return {
    ok: true,
    faction: player.faction,
    seasonId,
    messages: await listFactionChatMessages(client, seasonId, player.faction, limit),
  };
}

// Membership is read from the authenticated player's own faction column; a faction supplied
// by the client is never used, so enemy faction rosters can't be requested.
async function listFactionMembersForPlayer(client, player) {
  const playerStatus = assertFactionPlayer(player);
  if (!playerStatus.ok) {
    return playerStatus;
  }
  const result = await client.query(
    `SELECT id, username FROM players WHERE faction = $1 ORDER BY username ASC`,
    [player.faction]
  );
  const members = result.rows.map((row) => ({ id: row.id, username: row.username }));
  return { ok: true, faction: player.faction, members, total: members.length };
}

async function createFactionChatMessage(client, { player, seasonId, message }) {
  const playerStatus = assertFactionPlayer(player);
  if (!playerStatus.ok) {
    return playerStatus;
  }

  const normalized = normalizeFactionChatMessage(message);
  if (!normalized.ok) {
    return { ok: false, status: 400, error: normalized.error };
  }

  const result = await client.query(
    `INSERT INTO faction_chat_messages (season_id, faction, player_id, message)
     VALUES ($1, $2, $3, $4)
     RETURNING id, season_id, faction, player_id, message, created_at`,
    [seasonId, player.faction, player.id, normalized.message]
  );
  const row = result.rows[0];
  return {
    ok: true,
    message: {
      id: row.id,
      seasonId: row.season_id,
      faction: row.faction,
      playerId: row.player_id,
      username: player.username,
      message: row.message,
      createdAt: row.created_at,
    },
  };
}

module.exports = {
  CHAT_MAX_LENGTH,
  CHAT_RESPONSE_LIMIT,
  normalizeFactionChatMessage,
  assertFactionPlayer,
  listFactionChatMessages,
  getFactionChatMessagesForPlayer,
  listFactionMembersForPlayer,
  createFactionChatMessage,
};
