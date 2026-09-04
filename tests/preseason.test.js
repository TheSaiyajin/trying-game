const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');

test('login does not enroll a player and only the explicit Join endpoint creates membership', () => {
  const requireAuthStart = serverSource.indexOf('async function requireAuth');
  const requireAuthEnd = serverSource.indexOf('async function getRequestSeasonMembership', requireAuthStart);
  const requireAuthSource = serverSource.slice(requireAuthStart, requireAuthEnd);
  const joinRoute = serverSource.match(/app\.post\('\/api\/season\/join'[\s\S]*?\n\}\)\);/);

  assert.doesNotMatch(requireAuthSource, /ensurePlayerFactionAssignment/);
  assert.ok(joinRoute, 'explicit season join route must exist');
  assert.match(joinRoute[0], /ensurePlayerFactionAssignment/);
  assert.match(joinRoute[0], /resourceStartAt/);
});

test('all production gameplay endpoints enforce joined and started season middleware', () => {
  const endpoints = [
    "app.get('/api/world'",
    "app.get('/api/player/state'",
    "app.get('/api/game/battles'",
    "app.get('/api/game/activity-stats'",
    "app.post('/api/game/upgrade-building'",
    "app.post('/api/game/train-soldiers'",
    "app.post('/api/game/defend'",
    "app.post('/api/game/recall-defenders'",
    "app.post('/api/game/attack'",
    "app.get('/api/game/faction-chat'",
    "app.get('/api/game/faction-members'",
    "app.post('/api/game/faction-chat'",
    "app.post('/api/game/resolve-battle'",
  ];

  endpoints.forEach((endpoint) => {
    const start = serverSource.indexOf(endpoint);
    const routeLine = serverSource.slice(start, serverSource.indexOf('\n', start));
    assert.match(routeLine, /requireAuth, requirePlayableSeason/, `${endpoint} must be season-gated`);
  });
  assert.match(serverSource, /code: 'SEASON_NOT_STARTED'/);
  assert.match(serverSource, /code: 'SEASON_JOIN_REQUIRED'/);
});

test('registration state exposes map identity and no gameplay world before season start', () => {
  assert.match(serverSource, /mapKey: selectedMap\.key/);
  assert.match(serverSource, /mapName: selectedMap\.name/);
  assert.match(serverSource, /joinedCount:/);
  assert.match(serverSource, /world: \{ territories: \[\], players: \[\] \}/);
});

test('registration UI shows season, map, countdown, joined count, and explicit Join button', () => {
  assert.match(html, /id="season-gate"/);
  assert.match(html, /id="season-gate-countdown"/);
  assert.match(html, /id="season-gate-joined-count"/);
  assert.match(html, /id="season-join-btn"/);
  assert.match(script, /REGISTRATION OPEN/);
  assert.match(script, /apiFetch\('\/season\/join'/);
});