const test = require('node:test');
const assert = require('node:assert/strict');

function createFakeElement() {
  const el = {
    style: {},
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    addEventListener() {},
    appendChild() {},
    setAttribute() {},
    remove() {},
    replaceChildren() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

function createFakeDocument() {
  return {
    getElementById() { return createFakeElement(); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return createFakeElement(); },
    createElementNS() { return createFakeElement(); },
    addEventListener() {},
    body: { appendChild() {} },
  };
}

function createFakeStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    _store: store,
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function withFrontendGlobals(fn) {
  return async () => {
    const previousDocument = global.document;
    const previousFetch = global.fetch;
    const previousLocalStorage = global.localStorage;
    const previousSetInterval = global.setInterval;
    const previousClearInterval = global.clearInterval;
    const previousIo = global.io;
    global.document = createFakeDocument();
    global.localStorage = createFakeStorage();
    // loadGame()/startFactionChatPolling() start a real setInterval for chat polling; a
    // fresh module instance per test never clears it, which would otherwise hang the test
    // process. Nothing under test needs a real interval to fire.
    global.setInterval = () => 0;
    global.clearInterval = () => {};
    try {
      await fn();
    } finally {
      global.document = previousDocument;
      global.fetch = previousFetch;
      global.localStorage = previousLocalStorage;
      global.setInterval = previousSetInterval;
      global.clearInterval = previousClearInterval;
      global.io = previousIo;
    }
  };
}

// Re-require script.js fresh inside each test (after globals are set up) so its top-level
// `localStorage`/`fetch` references resolve to our fakes instead of whatever Node provides.
function loadScriptModule() {
  delete require.cache[require.resolve('../script.js')];
  return require('../script.js');
}

test('restores a saved Map screen for the authenticated player', withFrontendGlobals(async () => {
  const elements = new Map();
  global.document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, createFakeElement());
    return elements.get(id);
  };
  global.localStorage.setItem('trying_game_screen_42', 'map');
  const { restoreSavedScreen } = loadScriptModule();

  const restored = restoreSavedScreen({ id: 42, username: 'Player1', role: 'member' });

  assert.equal(restored, 'map');
}));

test('rejects saved Admin restoration for a non-admin player', withFrontendGlobals(async () => {
  const elements = new Map();
  global.document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, createFakeElement());
    return elements.get(id);
  };
  global.localStorage.setItem('trying_game_screen_42', 'admin');
  const { restoreSavedScreen } = loadScriptModule();

  const restored = restoreSavedScreen({ id: 42, username: 'Player1', role: 'member' });

  assert.equal(restored, 'city');
}));

test('restores Map before revealing the game shell', withFrontendGlobals(async () => {
  const elements = new Map();
  const mapScreen = createFakeElement();
  let mapActive = false;
  mapScreen.classList.add = (name) => {
    if (name === 'active') mapActive = true;
  };
  mapScreen.classList.remove = (name) => {
    if (name === 'active') mapActive = false;
  };
  elements.set('screen-map', mapScreen);

  const shell = createFakeElement();
  let mapWasActiveAtReveal = false;
  Object.defineProperty(shell.style, 'display', {
    set(value) {
      if (value === 'block') mapWasActiveAtReveal = mapActive;
    },
  });
  elements.set('game-shell', shell);
  global.document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, createFakeElement());
    return elements.get(id);
  };
  global.document.querySelectorAll = (selector) => selector === '.screen' ? [mapScreen] : [];
  global.localStorage.setItem('trying_game_screen_42', 'map');
  global.fetch = async (url) => {
    if (String(url).includes('/api/me')) return jsonResponse(200, { id: 42, username: 'Player1', role: 'member' });
    if (String(url).includes('/api/game/state')) {
      return jsonResponse(200, {
        player: { id: 42, username: 'Player1', faction: 'blue', role: 'member' },
        world: { territories: [] },
      });
    }
    return jsonResponse(404, {});
  };

  const { loadGame, setToken } = loadScriptModule();
  setToken('token-abc');
  await loadGame();

  assert.equal(mapWasActiveAtReveal, true);
}));

test('training UI shows the active discount and rounded total for the selected quantity', withFrontendGlobals(async () => {
  const elements = new Map();
  global.document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, createFakeElement());
    return elements.get(id);
  };
  global.document.getElementById('train-count').value = '10';
  const { setGameStateFromSnapshot, updateTrainingCostDisplay, calculateTrainingCost } = loadScriptModule();
  setGameStateFromSnapshot({
    player: { faction: 'blue', factionBonuses: { training: 0.05 } },
    world: { territories: [] },
  });

  updateTrainingCostDisplay();

  assert.equal(elements.get('training-discount').textContent, '5%');
  assert.equal(elements.get('training-total-cost').textContent, '475🌾 + 190⚙️ + 10👥');
  assert.deepEqual(calculateTrainingCost(20, 0.05), { food: 950, iron: 380, manpower: 19 });
}));

test('faction bonus UI shows the passive fortress cap, total troops, and paused state', withFrontendGlobals(async () => {
  const elements = new Map();
  global.document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, createFakeElement());
    return elements.get(id);
  };
  const { setGameStateFromSnapshot } = loadScriptModule();

  setGameStateFromSnapshot({
    player: {
      faction: 'blue',
      soldiers: 230,
      totalTroops: 250,
      fortressTroopCap: 250,
      fortressTroopsPaused: true,
      factionBonuses: { fortressTroops: 1 },
    },
    world: { territories: [] },
  });

  assert.match(elements.get('faction-bonuses').innerHTML, /Fortress Troops 250\/250 total · Paused/);
  assert.match(elements.get('faction-bonuses').innerHTML, /Fortress Generation \+1\/min/);
}));

test('apiFetch preserves the HTTP status on a thrown error', withFrontendGlobals(async () => {
  global.fetch = async () => jsonResponse(429, { error: 'Too many requests' });
  const { apiFetch, setToken } = loadScriptModule();
  setToken('token-abc');

  await assert.rejects(() => apiFetch('/me'), (error) => {
    assert.equal(error.status, 429);
    return true;
  });
}));

test('apiFetch marks a network failure as status 0 / temporary instead of losing the error', withFrontendGlobals(async () => {
  global.fetch = async () => { throw new TypeError('fetch failed'); };
  const { apiFetch, setToken } = loadScriptModule();
  setToken('token-abc');

  await assert.rejects(() => apiFetch('/me'), (error) => {
    assert.equal(error.status, 0);
    assert.equal(error.isNetworkError, true);
    return true;
  });
}));

test('real-time connection authenticates with the token and debounces duplicate updates', withFrontendGlobals(async () => {
  const handlers = {};
  let socketOptions = null;
  global.io = (options) => {
    socketOptions = options;
    return {
      connected: true,
      on(event, handler) { handlers[event] = handler; },
      connect() {},
      disconnect() {},
    };
  };
  global.fetch = async () => jsonResponse(200, {
    player: { faction: 'blue', resources: {}, buildings: {} },
    world: { territories: [] },
  });

  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const timers = new Map();
  let timerId = 0;
  global.setTimeout = (fn) => {
    timerId += 1;
    timers.set(timerId, fn);
    return timerId;
  };
  global.clearTimeout = (id) => timers.delete(id);
  try {
    const { connectRealtime, setToken } = loadScriptModule();
    setToken('token-abc');
    connectRealtime();

    assert.deepEqual(socketOptions, { auth: { token: 'token-abc' }, reconnection: true });
    handlers['state:changed']();
    handlers['state:changed']();
    assert.equal(timers.size, 1);
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
}));

test('ensureSession deletes the token and rejects only on a real 401', withFrontendGlobals(async () => {
  global.fetch = async () => jsonResponse(401, { error: 'Invalid token' });
  const { ensureSession, setToken, getToken } = loadScriptModule();
  setToken('token-abc');

  await assert.rejects(() => ensureSession(), /Session expired/);
  assert.equal(getToken(), '');
}));

test('ensureSession keeps the token and retries once on a temporary 500, then succeeds', withFrontendGlobals(async () => {
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    if (callCount === 1) return jsonResponse(500, { error: 'Internal server error' });
    return jsonResponse(200, { username: 'Player1', role: 'member' });
  };
  const { ensureSession, setToken, getToken } = loadScriptModule();
  setToken('token-abc');

  const user = await ensureSession();
  assert.equal(user.username, 'Player1');
  assert.equal(callCount, 2);
  assert.equal(getToken(), 'token-abc'); // never deleted for a temporary failure
}));

test('ensureSession keeps the token through a 429, then a network error, and reports a temporary failure', withFrontendGlobals(async () => {
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    if (callCount === 1) return jsonResponse(429, { error: 'Too many requests' });
    throw new TypeError('fetch failed');
  };
  const { ensureSession, setToken, getToken } = loadScriptModule();
  setToken('token-abc');

  await assert.rejects(() => ensureSession(), (error) => {
    assert.equal(error.isTemporary, true);
    return true;
  });
  assert.equal(getToken(), 'token-abc');
}));

test('ensureSession still deletes the token if the retry itself comes back 401', withFrontendGlobals(async () => {
  let callCount = 0;
  global.fetch = async () => {
    callCount += 1;
    if (callCount === 1) return jsonResponse(500, { error: 'Internal server error' });
    return jsonResponse(401, { error: 'Invalid token' });
  };
  const { ensureSession, setToken, getToken } = loadScriptModule();
  setToken('token-abc');

  await assert.rejects(() => ensureSession(), /Session expired/);
  assert.equal(getToken(), '');
}));

// ===================== loadGame: never bounces to a manual faction-selection screen =====================

test('loadGame retries instead of showing registration when the faction is briefly missing (e.g. mid rollover)', withFrontendGlobals(async () => {
  const calls = [];
  let stateCallCount = 0;
  global.fetch = async (url) => {
    calls.push(url);
    if (String(url).includes('/api/me')) return jsonResponse(200, { username: 'Player1', role: 'member' });
    if (String(url).includes('/api/game/state')) {
      stateCallCount += 1;
      return jsonResponse(200, { player: { faction: null }, world: { territories: [] } });
    }
    return jsonResponse(404, {});
  };
  const previousSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (fn, ms) => { scheduled.push({ fn, ms }); return 0; };
  try {
    const { loadGame, setToken, getToken } = loadScriptModule();
    setToken('token-abc');

    await loadGame();

    assert.equal(stateCallCount, 1);
    assert.equal(getToken(), 'token-abc'); // never logged out just because faction is pending
    assert.ok(scheduled.some((s) => s.fn === loadGame || s.ms === 750), 'loadGame should schedule a retry');
  } finally {
    global.setTimeout = previousSetTimeout;
  }
}));

test('loadGame keeps the session and retries on a temporary /me failure instead of logging out', withFrontendGlobals(async () => {
  global.fetch = async (url) => {
    if (String(url).includes('/api/me')) return jsonResponse(503, { error: 'Service unavailable' });
    return jsonResponse(200, {});
  };
  const previousSetTimeout = global.setTimeout;
  let retryScheduled = false;
  global.setTimeout = (fn, ms) => {
    // ensureSession's internal retry-once (sleep(500)) must actually fire so the temporary
    // error surfaces; loadGame's own reconnect-retry (1500ms) must NOT recurse for real,
    // or this test would loop forever against the same mocked 503 response.
    if (ms === 500) {
      fn();
      return 0;
    }
    if (ms === 1500) retryScheduled = true;
    return 0;
  };
  try {
    const { loadGame, setToken, getToken } = loadScriptModule();
    setToken('token-abc');

    await loadGame();

    assert.equal(getToken(), 'token-abc');
    assert.ok(retryScheduled, 'a retry should be scheduled instead of logging out');
  } finally {
    global.setTimeout = previousSetTimeout;
  }
}));

// ===================== Season rollover / Force Finish: refresh without logging out =====================

test('a background refresh after midnight rollover updates the new faction without logging out', withFrontendGlobals(async () => {
  global.fetch = async (url) => {
    if (String(url).includes('/api/game/state')) {
      return jsonResponse(200, {
        player: { faction: 'green', username: 'Player1' },
        world: { territories: [] },
        season: { seasonNumber: 7, endsAt: new Date(Date.now() + 3600000).toISOString(), scores: { blue: 0, red: 0, green: 0 }, memberCounts: { blue: 1, red: 1, green: 1 } },
      });
    }
    if (String(url).includes('/api/game/faction-chat')) {
      // A faction change also triggers a fire-and-forget chat refresh; give it a real
      // response so it settles instead of leaking past the end of this test.
      return jsonResponse(200, { faction: 'green', messages: [] });
    }
    return jsonResponse(404, {});
  };
  const { refreshGameStateInBackground, setToken, getToken, setGameStateFromSnapshot } = loadScriptModule();
  setToken('token-abc');
  setGameStateFromSnapshot({ player: { faction: 'blue', username: 'Player1' }, world: { territories: [] } });

  await refreshGameStateInBackground();
  await new Promise((resolve) => setImmediate(resolve)); // let the fire-and-forget chat refresh settle

  assert.equal(getToken(), 'token-abc');
}));

test('a live tick updates city and open territory soldier counts without replacing typed troop values', withFrontendGlobals(async () => {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, createFakeElement());
    return elements.get(id);
  };
  global.document.getElementById = getElement;
  getElement('territory-panel').style.display = 'block';
  getElement('attack-count').value = '37';
  getElement('defend-count').value = '23';
  getElement('recall-count').value = '11';
  global.fetch = async () => jsonResponse(200, {
    player: {
      faction: 'blue',
      soldiers: 75,
      resources: {},
      buildings: {},
      stationedTroops: { A1: 18 },
    },
    world: {
      territories: [{ id: 'A1', name: 'Alpha', owner: 'blue', defense: 44, neighbors: [] }],
    },
  });

  const { setGameStateFromSnapshot, selectTerritory, refreshGameStateInBackground, setToken } = loadScriptModule();
  setToken('token-abc');
  setGameStateFromSnapshot({
    player: { faction: 'blue', soldiers: 10, resources: {}, buildings: {}, stationedTroops: { A1: 2 } },
    world: { territories: [{ id: 'A1', name: 'Alpha', owner: 'blue', defense: 5, neighbors: [] }] },
  });
  selectTerritory('A1');
  getElement('attack-count').value = '37';
  getElement('defend-count').value = '23';
  getElement('recall-count').value = '11';

  await refreshGameStateInBackground();

  assert.equal(getElement('soldiers-count').textContent, 75);
  assert.equal(getElement('tp-city-soldiers').textContent, 75);
  assert.equal(getElement('tp-troops').textContent, 44);
  assert.equal(getElement('tp-stationed').textContent, 18);
  assert.equal(getElement('defend-count').value, '23');
  assert.equal(getElement('recall-count').value, '11');
}));

test('a background refresh during a Force Finish transition (temporary 500) never logs the player out', withFrontendGlobals(async () => {
  global.fetch = async () => jsonResponse(500, { error: 'Internal server error' });
  const { refreshGameStateInBackground, setToken, getToken } = loadScriptModule();
  setToken('token-abc');

  await refreshGameStateInBackground();

  assert.equal(getToken(), 'token-abc');
}));

test('a background refresh only logs out on a genuine 401', withFrontendGlobals(async () => {
  global.fetch = async () => jsonResponse(401, { error: 'Invalid token' });
  const { refreshGameStateInBackground, setToken, getToken } = loadScriptModule();
  setToken('token-abc');

  await refreshGameStateInBackground();

  assert.equal(getToken(), '');
}));
