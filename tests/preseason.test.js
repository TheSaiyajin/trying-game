const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

test('logging in never enrolls a player without the explicit season Join action', () => {
  const requireAuthStart = serverSource.indexOf('async function requireAuth');
  const requireAuthEnd = serverSource.indexOf('async function getRequestSeasonMembership', requireAuthStart);
  const requireAuthSource = serverSource.slice(requireAuthStart, requireAuthEnd);
  const joinRoute = serverSource.match(/app\.post\('\/api\/season\/join'[\s\S]*?\n\}\)\);/);

  assert.ok(requireAuthStart >= 0 && requireAuthEnd > requireAuthStart);
  assert.doesNotMatch(requireAuthSource, /ensurePlayerFactionAssignment/);
  assert.ok(joinRoute, 'explicit season join route must exist');
  assert.match(joinRoute[0], /ensurePlayerFactionAssignment/);
  assert.match(joinRoute[0], /resourceStartAt/);
});

test('all gameplay endpoints enforce joined and started season middleware', () => {
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
    "app.post('/api/game/launch-rally'",
    "app.get('/api/game/faction-chat'",
    "app.get('/api/game/faction-members'",
    "app.post('/api/game/faction-chat'",
  ];

  endpoints.forEach((endpoint) => {
    const routeLine = serverSource.slice(serverSource.indexOf(endpoint), serverSource.indexOf('\n', serverSource.indexOf(endpoint)));
    assert.match(routeLine, /requireAuth, requirePlayableSeason/, `${endpoint} must be season-gated`);
  });
  assert.match(serverSource, /code: 'SEASON_NOT_STARTED'/);
  assert.match(serverSource, /code: 'SEASON_JOIN_REQUIRED'/);
});

test('lobby state exposes no map, faction, or gameplay state before the season starts', () => {
  const stateRouteStart = serverSource.indexOf("app.get('/api/game/state'");
  const stateRouteEnd = serverSource.indexOf("app.get('/api/game/battles'", stateRouteStart);
  const stateRoute = serverSource.slice(stateRouteStart, stateRouteEnd);

  assert.match(stateRoute, /faction: null/);
  assert.match(stateRoute, /world: \{ territories: \[\], rallies: \[\], players: \[\] \}/);
  assert.match(stateRoute, /joinedSeason: Boolean\(membership\)/);
});

test('the responsive pre-season screen has countdown, Join, confirmation, and admin start controls', () => {
  assert.match(html, /id="season-gate"/);
  assert.match(html, /id="season-gate-countdown"/);
  assert.match(html, /id="season-join-btn"/);
  assert.match(html, /id="season-joined-confirmation"/);
  assert.match(html, /id="season-admin-start-btn"/);
  assert.match(html, /Players may also join after the season starts\./);
});
