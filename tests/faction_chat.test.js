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
        const [seasonId, faction, playerId, message] = params;
        const row = {
          id: messages.length + 1,
          season_id: seasonId,
          faction,
          player_id: playerId,
          username: null,
          message,
          created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, messages.length)).toISOString(),
        };
        messages.push(row);
        return { rows: [row] };
      }
      if (text.startsWith('SELECT fcm.id, fcm.season_id, fcm.faction, fcm.player_id, p.username, fcm.message, fcm.created_at')) {
        const [seasonId, faction, limit] = params;
        const rows = messages
          .filter((row) => row.season_id === seasonId && row.faction === faction)
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
    seasonId: 1,
    message: '🔥 Ready ⚔️',
  });

  assert.equal(result.ok, true);
  assert.equal(result.message.message, '🔥 Ready ⚔️');
});

test('chat faction is derived from the authenticated player record', async () => {
  const client = createFakeChatClient();
  const result = await createFactionChatMessage(client, {
    player: { id: 1, username: 'BlueUser', faction: 'blue' },
    seasonId: 1,
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
      seasonId: 1,
      message: `blue-${i}`,
    });
  }
  await createFactionChatMessage(client, { player: { id: 2, username: 'RedUser', faction: 'red' }, seasonId: 1, message: 'red-1' });
  await createFactionChatMessage(client, { player: { id: 3, username: 'GreenUser', faction: 'green' }, seasonId: 1, message: 'green-1' });

  const blueMessages = await getFactionChatMessagesForPlayer(client, { id: 1, username: 'BlueUser', faction: 'blue' }, 1);
  const redMessages = await getFactionChatMessagesForPlayer(client, { id: 2, username: 'RedUser', faction: 'red' }, 1);
  const greenMessages = await getFactionChatMessagesForPlayer(client, { id: 3, username: 'GreenUser', faction: 'green' }, 1);

  assert.equal(blueMessages.ok, true);
  assert.equal(blueMessages.messages.length, CHAT_RESPONSE_LIMIT);
  assert.equal(blueMessages.messages[0].message, 'blue-5');
  assert.equal(blueMessages.messages.at(-1).message, 'blue-104');
  assert.deepEqual(redMessages.messages.map((row) => row.message), ['red-1']);
  assert.deepEqual(greenMessages.messages.map((row) => row.message), ['green-1']);
});

test('chat is scoped per season: a new season never sees the previous season\'s messages', async () => {
  const client = createFakeChatClient();
  await createFactionChatMessage(client, { player: { id: 1, username: 'BlueUser', faction: 'blue' }, seasonId: 1, message: 'season one chat' });

  const seasonTwoMessages = await getFactionChatMessagesForPlayer(client, { id: 1, username: 'BlueUser', faction: 'blue' }, 2);
  assert.deepEqual(seasonTwoMessages.messages, []);

  const seasonOneMessages = await getFactionChatMessagesForPlayer(client, { id: 1, username: 'BlueUser', faction: 'blue' }, 1);
  assert.equal(seasonOneMessages.messages.length, 1);
});

test('chat is scoped per faction within the same season: a reassigned player cannot see their old faction\'s messages', async () => {
  const client = createFakeChatClient();
  await createFactionChatMessage(client, { player: { id: 1, username: 'BlueUser', faction: 'blue' }, seasonId: 1, message: 'blue only' });

  // Same player, same season, but now on a different faction (e.g. after a manual re-check).
  const asRed = await getFactionChatMessagesForPlayer(client, { id: 1, username: 'BlueUser', faction: 'red' }, 1);
  assert.deepEqual(asRed.messages, []);
});

