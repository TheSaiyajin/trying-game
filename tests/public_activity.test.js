const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildBattleActivityText } = require('../backend/server');

test('battle activity text describes captures and defended attacks', () => {
  assert.equal(buildBattleActivityText({
    attacker_faction: 'green',
    territory_name: 'T14',
    winner: 'green',
    owner_before: 'red',
    owner_after: 'green',
  }), 'Green captured T14 from Red');

  assert.equal(buildBattleActivityText({
    attacker_faction: 'blue',
    territory_name: 'T22',
    winner: 'red',
    owner_before: 'red',
    owner_after: 'red',
  }), 'Red defended T22 from Blue');
});

test('public activity route is unauthenticated, read-only, limited, and oldest-first', () => {
  const serverSource = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
  const route = serverSource.match(/app\.get\('\/api\/public\/activity'[\s\S]*?\n\}\)\);/);

  assert.ok(route, 'public activity route must exist');
  assert.doesNotMatch(route[0], /requireAuth|INSERT|UPDATE|DELETE/);
  assert.match(route[0], /ORDER BY bh\.id DESC/);
  assert.match(route[0], /LIMIT 50/);
  assert.match(route[0], /result\.rows\.reverse\(\)/);
  assert.match(route[0], /id: Number\(battle\.id\)/);
});