const {
  CHAT_RESPONSE_LIMIT,
  assertFactionPlayer,
  normalizeFactionChatMessage,
} = require('./faction-chat');

async function listWorldChatMessages(client, seasonId, limit = CHAT_RESPONSE_LIMIT) {
  const safeLimit = Math.max(1, Math.min(CHAT_RESPONSE_LIMIT, Number(limit) || CHAT_RESPONSE_LIMIT));
  const result = await client.query(
    `SELECT wcm.id, wcm.season_id, wcm.faction, wcm.player_id, p.username, wcm.message, wcm.created_at
     FROM world_chat_messages wcm
     INNER JOIN players p ON p.id = wcm.player_id
     WHERE wcm.season_id = $1
     ORDER BY wcm.created_at DESC, wcm.id DESC
     LIMIT $2`,
    [seasonId, safeLimit]
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

async function getWorldChatMessagesForPlayer(client, player, seasonId, limit = CHAT_RESPONSE_LIMIT) {
  const playerStatus = assertFactionPlayer(player);
  if (!playerStatus.ok) return playerStatus;
  return {
    ok: true,
    seasonId,
    messages: await listWorldChatMessages(client, seasonId, limit),
  };
}

async function createWorldChatMessage(client, { player, seasonId, message }) {
  const playerStatus = assertFactionPlayer(player);
  if (!playerStatus.ok) return playerStatus;

  const normalized = normalizeFactionChatMessage(message);
  if (!normalized.ok) {
    return { ok: false, status: 400, error: normalized.error };
  }

  const result = await client.query(
    `INSERT INTO world_chat_messages (season_id, faction, player_id, message)
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
  listWorldChatMessages,
  getWorldChatMessagesForPlayer,
  createWorldChatMessage,
};