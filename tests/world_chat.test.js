const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWorldChatMessage,
  getWorldChatMessagesForPlayer,
} = require('../backend/world-chat');

function createFakeChatClient() {
  const messages = [];
  return {
    messages,
    async query(sql, params = []) {
      const text = sql.trim();
      if (text.startsWith('INSERT INTO world_chat_messages')) {
        const [seasonId, faction, playerId, message] = params;
        const row = {
          id: messages.length + 1,
          season_id: seasonId,
          faction,
          player_id: playerId,
          message,
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, messages.length)).toISOString(),
        };
        messages.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('SELECT wcm.id')) {
        const [seasonId, limit] = params;
        const rows = messages
          .filter((row) => row.season_id === seasonId)
          .sort((left, right) => right.id - left.id)
          .slice(0, limit)
          .map((row) => ({ ...row, username: `Player${row.player_id}` }));
        return { rows };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

test('all factions can see world messages with their send-time faction', async () => {
  const client = createFakeChatClient();
  const players = [
    { id: 1, username: 'BlueUser', faction: 'blue' },
    { id: 2, username: 'RedUser', faction: 'red' },
    { id: 3, username: 'GreenUser', faction: 'green' },
  ];
  for (const player of players) {
    await createWorldChatMessage(client, { player, seasonId: 7, message: `From ${player.faction}` });
  }

  for (const player of players) {
    const result = await getWorldChatMessagesForPlayer(client, player, 7);
    assert.deepEqual(result.messages.map((row) => row.faction), ['blue', 'red', 'green']);
  }
  assert.equal(client.messages[1].faction, 'red');
});

test('world chat is season scoped', async () => {
  const client = createFakeChatClient();
  const player = { id: 1, username: 'BlueUser', faction: 'blue' };
  await createWorldChatMessage(client, { player, seasonId: 1, message: 'Old season' });

  const result = await getWorldChatMessagesForPlayer(client, player, 2);
  assert.deepEqual(result.messages, []);
});

test('world chat uses faction chat validation and response limit', async () => {
  const client = createFakeChatClient();
  const player = { id: 1, username: 'BlueUser', faction: 'blue' };
  assert.equal((await createWorldChatMessage(client, { player, seasonId: 1, message: ' '.repeat(3) })).ok, false);
  assert.equal((await createWorldChatMessage(client, { player, seasonId: 1, message: 'x'.repeat(501) })).ok, false);

  for (let index = 0; index < 105; index += 1) {
    await createWorldChatMessage(client, { player, seasonId: 1, message: `message-${index}` });
  }
  const result = await getWorldChatMessagesForPlayer(client, player, 1);
  assert.equal(result.messages.length, 100);
  assert.equal(result.messages[0].message, 'message-5');
});