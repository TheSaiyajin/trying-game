const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHAT_RESPONSE_LIMIT,
  createFactionChatMessage,
  getFactionChatMessagesForPlayer,
  normalizeFactionChatMessage,
} = require('../backend/faction-chat');

function createFakeChatClient() {
  const messages = [];
  return {
    messages,
    async query(sql, params = []) {
      const text = sql.trim();
      if (text.startsWith('INSERT INTO faction_chat_messages')) {
        const [faction, playerId, message] = params;
        const row = {
          id: messages.length + 1,
          faction,
          player_id: playerId,
          username: null,
          message,
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, messages.length)).toISOString(),
        };
        messages.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('SELECT fcm.id, fcm.faction, fcm.player_id, p.username, fcm.message, fcm.created_at')) {
        const [faction, limit] = params;
        const rows = messages
          .filter((row) => row.faction === faction)
          .sort((left, right) => right.id - left.id)
          .slice(0, limit)
          .map((row) => ({
            ...row,
            username: row.player_id === 1 ? 'BlueUser' : row.player_id === 2 ? 'RedUser' : 'GreenUser',
          }));
        return { rows };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

test('empty faction chat messages are rejected', () => {
  assert.deepEqual(normalizeFactionChatMessage('   '), { ok: false, error: 'Message cannot be empty.' });
});

test('faction chat messages over 500 characters are rejected', () => {
  assert.deepEqual(normalizeFactionChatMessage('a'.repeat(501)), { ok: false, error: 'Message must be 500 characters or fewer.' });
});

test('emoji faction chat messages are accepted', async () => {
  const client = createFakeChatClient();
  const result = await createFactionChatMessage(client, {
    player: { id: 1, username: 'BlueUser', faction: 'blue' },
    message: '🔥 Ready ⚔️',
  });

  assert.equal(result.ok, true);
  assert.equal(result.message.message, '🔥 Ready ⚔️');
});

test('chat faction is derived from the authenticated player record', async () => {
  const client = createFakeChatClient();
  const result = await createFactionChatMessage(client, {
    player: { id: 1, username: 'BlueUser', faction: 'blue' },
    message: 'For blue only',
    faction: 'red',
  });

  assert.equal(result.ok, true);
  assert.equal(result.message.faction, 'blue');
  assert.equal(client.messages[0].faction, 'blue');
});

test('each faction only retrieves its own faction chat messages and only the latest 100', async () => {
  const client = createFakeChatClient();
  for (let i = 0; i < 105; i += 1) {
    await createFactionChatMessage(client, {
      player: { id: 1, username: 'BlueUser', faction: 'blue' },
      message: `blue-${i}`,
    });
  }
  await createFactionChatMessage(client, { player: { id: 2, username: 'RedUser', faction: 'red' }, message: 'red-1' });
  await createFactionChatMessage(client, { player: { id: 3, username: 'GreenUser', faction: 'green' }, message: 'green-1' });

  const blueMessages = await getFactionChatMessagesForPlayer(client, { id: 1, username: 'BlueUser', faction: 'blue' });
  const redMessages = await getFactionChatMessagesForPlayer(client, { id: 2, username: 'RedUser', faction: 'red' });
  const greenMessages = await getFactionChatMessagesForPlayer(client, { id: 3, username: 'GreenUser', faction: 'green' });

  assert.equal(blueMessages.ok, true);
  assert.equal(blueMessages.messages.length, CHAT_RESPONSE_LIMIT);
  assert.equal(blueMessages.messages[0].message, 'blue-5');
  assert.equal(blueMessages.messages.at(-1).message, 'blue-104');
  assert.deepEqual(redMessages.messages.map((row) => row.message), ['red-1']);
  assert.deepEqual(greenMessages.messages.map((row) => row.message), ['green-1']);
});
