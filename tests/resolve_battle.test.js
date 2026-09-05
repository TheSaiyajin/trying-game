const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  applyAttackerCasualties,
  sumAttackers,
} = require('../backend/resolve-battle');

test('attacker casualties are distributed proportionally across allied contributors', async () => {
  const updates = [];
  const client = {
    async query(sql, params) {
      updates.push({ sql, params });
      return { rows: [] };
    },
  };
  const contributors = [
    { player_id: 1, contribution: 60 },
    { player_id: 2, contribution: 40 },
  ];
  const remaining = await applyAttackerCasualties(client, 'r2', contributors, 25);
  assert.equal(remaining, 75);
  assert.deepEqual(contributors.map((row) => row.contribution), [45, 30]);
  assert.deepEqual(updates.map((row) => row.params[0]), [45, 30]);
});

test('attacker casualty allocation never produces negative troops', async () => {
  const client = { async query() { return { rows: [] }; } };
  const contributors = [
    { player_id: 1, contribution: 3 },
    { player_id: 2, contribution: 2 },
  ];
  assert.equal(await applyAttackerCasualties(client, 'r2', contributors, 999), 0);
  assert.equal(sumAttackers(contributors), 0);
});

test('live battle processing supports minute catch-up, early endings, and timed defense', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'resolve-battle.js'), 'utf8');
  assert.match(source, /while \([\s\S]*nextTickAt\.getTime\(\) <= now\.getTime\(\)/);
  assert.match(source, /attackersRemaining <= 0 \|\| defendersRemaining <= 0 \|\| deadlineReached/);
  assert.match(source, /defendersRemaining <= 0 && attackersRemaining > 0/);
  assert.match(source, /SET owner_faction = \$1[\s\S]*protected_until = \$4/);
  assert.match(source, /SET soldiers = p\.soldiers \+ refunds\.troops/);
});

test('battle history stores the combat bonus values used by the server', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'backend', 'resolve-battle.js'), 'utf8');
  assert.match(source, /attackBonus,/);
  assert.match(source, /defenseBonus,/);
  assert.match(source, /mode: 'live_battle'/);
});
