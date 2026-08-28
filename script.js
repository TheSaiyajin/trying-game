/* ====================================================
   TERRITORY CONQUEST — authoritative client wrapper
   The browser may only render and submit actions.
   All critical state is calculated and stored on the server.
   ==================================================== */

const AUTH_STORAGE_KEY = 'trying_game_token';
const USERNAME_REGEX = /^[A-Za-z0-9_-]{3,32}$/;
const DEFAULT_STATE = {
  player: {
    id: null,
    username: 'Guest',
    faction: 'blue',
    role: 'member',
    resources: { food: 0, wood: 0, iron: 0, manpower: 0 },
    soldiers: 0,
    buildings: { farm: 1, lumbermill: 1, ironmine: 1, barracks: 1 },
    production: { food: 0, wood: 0, iron: 0, manpower: 0 },
  },
  territories: {},
  attackTarget: '',
  attackContributions: {},
  chatMessages: [],
  season: null,
};

let G = structuredClone(DEFAULT_STATE);
let selectedTerritoryId = null;
let attackSendCount = 10;
let defendSendCount = 10;
let trainAmount = 1;
let factionChatPollHandle = null;

// Canonical topology module (world-topology.js): required directly under Node (tests),
// exposed as window.WORLD_TOPOLOGY when loaded via <script> in the browser.
const WORLD_TOPOLOGY = (typeof module !== 'undefined' && typeof require === 'function')
  ? require('./world-topology')
  : (typeof window !== 'undefined' ? window.WORLD_TOPOLOGY : undefined);

function showToast(msg) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('fade'), 1800);
  setTimeout(() => toast.remove(), 2400);
}

function fmt(value) {
  const num = Math.floor(Number(value) || 0);
  if (num >= 10000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

function mapTerritories(rawTerritories) {
  const entryMap = {};
  rawTerritories.forEach((territory) => {
    entryMap[territory.id] = {
      id: territory.id,
      name: territory.name,
      owner: territory.owner || territory.owner_faction || 'neutral',
      troops: Number(territory.defense || territory.defense_troops || 0),
      bonus: territory.bonus || territory.bonus_type || 'None',
      bonusValue: Number(territory.bonusValue ?? territory.bonus_value ?? 0),
      adj: Array.isArray(territory.neighbors) ? territory.neighbors : [],
      fortress: !!(territory.fortress ?? territory.is_fortress),
      capital: !!(territory.capital ?? territory.is_capital),
    };
  });
  return entryMap;
}

function isAdminUser(user) {
  return user?.username === 'Sai' && user?.role === 'admin';
}

function getFactionLegendEntries(playerFaction) {
  const currentFaction = String(playerFaction || '').toLowerCase();
  return [
    { key: 'blue', label: currentFaction === 'blue' ? 'Blue (You)' : 'Blue' },
    { key: 'red', label: currentFaction === 'red' ? 'Red (You)' : 'Red' },
    { key: 'green', label: currentFaction === 'green' ? 'Green (You)' : 'Green' },
    { key: 'target', label: 'Target' },
  ];
}

function renderMapLegend(playerFaction, root = document) {
  if (!root?.getElementById) return;
  const container = root.getElementById('map-legend');
  if (!container) return;
  container.replaceChildren();
  getFactionLegendEntries(playerFaction).forEach((entry) => {
    const item = root.createElement ? root.createElement('span') : document.createElement('span');
    item.className = `leg-${entry.key}`;
    item.textContent = entry.key === 'target' ? `⬡ ${entry.label}` : `■ ${entry.label}`;
    container.appendChild(item);
  });
}

function formatCountdown(msRemaining) {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function renderScoreboard() {
  const season = G.season;
  const seasonEl = document.getElementById('scoreboard-season');
  const countdownEl = document.getElementById('scoreboard-countdown');
  if (!seasonEl || !countdownEl) return;

  if (!season) {
    seasonEl.textContent = 'Season —';
    countdownEl.textContent = '--:--:--';
    return;
  }

  seasonEl.textContent = `Season ${season.seasonNumber}`;
  countdownEl.textContent = formatCountdown(new Date(season.endsAt).getTime() - Date.now());

  const scores = season.scores || { blue: 0, red: 0, green: 0 };
  const counts = season.memberCounts || { blue: 0, red: 0, green: 0 };
  document.getElementById('scoreboard-blue-score').textContent = scores.blue ?? 0;
  document.getElementById('scoreboard-red-score').textContent = scores.red ?? 0;
  document.getElementById('scoreboard-green-score').textContent = scores.green ?? 0;
  document.getElementById('scoreboard-blue-count').textContent = `(${counts.blue ?? 0})`;
  document.getElementById('scoreboard-red-count').textContent = `(${counts.red ?? 0})`;
  document.getElementById('scoreboard-green-count').textContent = `(${counts.green ?? 0})`;
}

function tickScoreboardCountdown() {
  const countdownEl = document.getElementById('scoreboard-countdown');
  if (!countdownEl || !G.season) return;
  countdownEl.textContent = formatCountdown(new Date(G.season.endsAt).getTime() - Date.now());
}

async function renderSeasonHistory() {
  const container = document.getElementById('season-history-list');
  if (!container) return;
  try {
    const data = await apiFetch('/game/season-history?limit=5');
    const seasons = data.seasons || [];
    if (!seasons.length) {
      container.textContent = 'No completed seasons yet.';
      return;
    }
    container.innerHTML = seasons.map((s) => {
      const resultLabel = s.result === 'draw' ? 'Draw' : `${s.result?.charAt(0).toUpperCase()}${s.result?.slice(1)} won`;
      return `
        <div class="season-history-row">
          <strong>Season ${s.seasonNumber}</strong>
          <span class="info-text">${new Date(s.startsAt).toISOString().slice(0, 10)} → ${new Date(s.endsAt).toISOString().slice(0, 10)} UTC</span>
          <span>🔵${s.blueScore ?? 0} 🔴${s.redScore ?? 0} 🟢${s.greenScore ?? 0}</span>
          <span class="season-history-result">${resultLabel}</span>
        </div>
      `;
    }).join('');
  } catch (error) {
    container.textContent = `Error: ${error.message}`;
  }
}

function updateAdminVisibility(player) {
  const adminNav = document.getElementById('nav-admin');
  const adminScreen = document.getElementById('screen-admin');
  if (!adminNav || !adminScreen) return;
  const isAdmin = isAdminUser(player);
  adminNav.style.display = isAdmin ? '' : 'none';
  adminScreen.style.display = '';
}

function setGameStateFromSnapshot(snapshot) {
  const previousFaction = G.player?.faction || null;
  G = {
    player: {
      ...(snapshot.player || {}),
      resources: snapshot.player?.resources || { food: 0, wood: 0, iron: 0, manpower: 0 },
      buildings: snapshot.player?.buildings || { farm: 1, lumbermill: 1, ironmine: 1, barracks: 1 },
      production: snapshot.player?.production || { food: 0, wood: 0, iron: 0, manpower: 0 },
      factionBonuses: snapshot.player?.factionBonuses || { food: 0, wood: 0, iron: 0, manpower: 0, training: 0 },
      stationedTroops: snapshot.player?.stationedTroops || {},
    },
    territories: mapTerritories(snapshot.world?.territories || snapshot.territories || []),
    attackTarget: '',
    attackContributions: {},
    // A season/faction change invalidates any cached chat: never show the previous
    // faction's messages, even briefly, while the new season's chat loads.
    chatMessages: previousFaction && previousFaction === G.player?.faction ? (G.chatMessages || []) : [],
    season: snapshot.season || null,
  };
  renderMapLegend(G.player.faction);
  updateAdminVisibility(G.player);
  renderScoreboard();
  if (previousFaction && snapshot.player && previousFaction !== snapshot.player.faction) {
    renderFactionChat({ scrollToNewest: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getToken() {
  return localStorage.getItem(AUTH_STORAGE_KEY) || '';
}

function setToken(token) {
  if (token) localStorage.setItem(AUTH_STORAGE_KEY, token);
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers,
    });
  } catch (networkError) {
    // No response at all (offline, DNS failure, proxy hiccup during a rollover, etc). This
    // is never a reason to log the player out -- status 0 marks it as temporary/retryable.
    const error = new Error('Network error. Please check your connection.');
    error.status = 0;
    error.isNetworkError = true;
    throw error;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Preserve the HTTP status so callers (ensureSession, loadGame) can tell a real
    // authentication failure (401) apart from a temporary server/network hiccup (429, 5xx,
    // or a dropped connection) instead of treating every non-2xx response the same way.
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function fetchCurrentUser() {
  const user = await apiFetch('/me');
  return user && user.username ? user : null;
}

async function ensureSession() {
  const token = getToken();
  if (!token) {
    throw new Error('No active session.');
  }

  try {
    return await fetchCurrentUser();
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      throw new Error('Session expired. Please log in again.');
    }

    // 429, 5xx, or a network error (e.g. mid-rollover, brief outage): never delete the
    // token for these. Retry once briefly before surfacing a "reconnecting" state.
    await sleep(500);
    try {
      return await fetchCurrentUser();
    } catch (retryError) {
      if (retryError.status === 401) {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        throw new Error('Session expired. Please log in again.');
      }
      const temporaryError = new Error('Could not reach the server. Retrying…');
      temporaryError.isTemporary = true;
      throw temporaryError;
    }
  }
}

function buildAuthPayload({ username, password }) {
  // Faction is never chosen by the player or sent by the frontend: it is assigned
  // automatically by the current season's balancing on first authenticated activity.
  return { username, password };
}

function setAuthMode(mode) {
  document.querySelectorAll('.auth-mode-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });

  const isRegister = mode === 'register';
  const confirmInput = document.getElementById('auth-confirm-password');
  const factionPanel = document.getElementById('auth-faction-panel');
  const submitButton = document.getElementById('auth-submit-btn');

  if (confirmInput) confirmInput.style.display = isRegister ? 'block' : 'none';
  if (factionPanel) factionPanel.style.display = isRegister ? 'block' : 'none';
  if (submitButton) submitButton.textContent = isRegister ? 'Create account' : 'Enter the war';

  const message = document.getElementById('auth-message');
  if (message) message.textContent = '';
}

function setGameShellVisible(isVisible) {
  const shell = document.getElementById('game-shell');
  if (shell) shell.style.display = isVisible ? 'block' : 'none';
}

function hideBootLoading() {
  const bootLoading = document.getElementById('boot-loading');
  if (bootLoading) bootLoading.style.display = 'none';
}

function hideAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  if (authScreen) authScreen.style.display = 'none';
  setGameShellVisible(true);
  showScreen('city');
  hideBootLoading();
}

function showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  if (authScreen) authScreen.style.display = 'flex';
  stopFactionChatPolling();
  setGameShellVisible(false);
  document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((button) => button.classList.remove('active'));
  hideBootLoading();
}

async function submitAuth(event) {
  event.preventDefault();
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const confirmPassword = document.getElementById('auth-confirm-password').value;
  const isRegister = document.querySelector('.auth-mode-btn.active')?.dataset.mode === 'register';
  const message = document.getElementById('auth-message');

  if (!username || username.length < 3) {
    message.textContent = 'Username must be at least 3 characters.';
    return;
  }
  if (!USERNAME_REGEX.test(username)) {
    message.textContent = 'Username must be 3-32 letters, numbers, underscores, or hyphens.';
    return;
  }
  if (!password || password.length < 6) {
    message.textContent = 'Password must be at least 6 characters.';
    return;
  }

  if (isRegister) {
    if (password !== confirmPassword) {
      message.textContent = 'Passwords do not match.';
      return;
    }
  }

  try {
    const path = isRegister ? '/register' : '/login';
    const payload = await apiFetch(path, {
      method: 'POST',
      body: JSON.stringify(buildAuthPayload({ username, password })),
    });

    setToken(payload.token);
    message.textContent = isRegister ? 'Registration successful.' : 'Login successful.';
    setTimeout(() => {
      hideAuthScreen();
      loadGame();
    }, 250);
  } catch (error) {
    message.textContent = error.message;
  }
}

function logoutPlayer() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  const form = document.getElementById('auth-form');
  if (form) form.reset();
  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
  document.getElementById('auth-confirm-password').value = '';
  const message = document.getElementById('auth-message');
  if (message) message.textContent = 'Logged out.';
  showAuthScreen();
  setAuthMode('login');
  showToast('🚪 Logged out.');
}

async function loadGame() {
  let user;
  try {
    user = await ensureSession();
  } catch (error) {
    if (error.isTemporary) {
      // A transient 429/5xx/network error (e.g. mid season-rollover): keep the token and
      // the current screen, and just try again shortly instead of bouncing to login.
      console.warn('Session check temporarily unavailable, retrying:', error.message);
      showToast('⚠️ Reconnecting…');
      setTimeout(loadGame, 1500);
      return;
    }
    console.error('Session check failed:', error);
    showAuthScreen();
    return;
  }

  if (!user) {
    showAuthScreen();
    return;
  }

  hideAuthScreen();
  startFactionChatPolling();

  try {
    const payload = await apiFetch('/game/state');
    if (!payload.player?.faction) {
      // Faction is assigned automatically on the server (see season.js); this only ever
      // shows up as a brief gap right after registration or during a season rollover. Retry
      // shortly instead of sending the player to a manual "choose your faction" screen.
      setTimeout(loadGame, 750);
      return;
    }

    setGameStateFromSnapshot(payload);

    renderCity();
    renderMap();
    updateResourceBar();
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      showAuthScreen();
      return;
    }
    console.error('Failed to load authoritative game state:', error);
    showToast('⚠️ Could not load the server state. Retrying…');
    setTimeout(loadGame, 1500);
  }
}

// Periodic 60s poll while logged in. This is what picks up a season rollover/faction
// reassignment that happened while the player stayed on the page (setGameStateFromSnapshot
// already refreshes the map legend, scoreboard, and chat when the faction changes). Only a
// real 401 logs the player out; every other error (mid-rollover 5xx, rate limiting, a dropped
// connection) is left for the next poll to retry.
async function refreshGameStateInBackground() {
  try {
    const payload = await apiFetch('/game/state');
    setGameStateFromSnapshot(payload);
    renderCity();
    renderMap();
    updateResourceBar();
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      showAuthScreen();
      return;
    }
    console.warn('Background refresh failed:', error.message);
  }
}

function saveGame() {
  if (getToken()) {
    showToast('✅ Session saved securely on the server.');
    return;
  }
  showToast('⚠️ No active session.');
}

function resetGame() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  showToast('🔄 Session reset.');
  loadGame();
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((button) => button.classList.remove('active'));
  const targetScreen = document.getElementById('screen-' + name);
  if (!targetScreen) {
    console.warn('Unknown screen requested:', name);
    return;
  }
  targetScreen.classList.add('active');
  const targetNav = document.getElementById('nav-' + name);
  if (targetNav) targetNav.classList.add('active');
  if (name === 'city') renderCity();
  if (name === 'map') { renderMap(); renderScoreboard(); renderSeasonHistory(); }
  if (name === 'activity') renderActivity();
  if (name === 'chat') { renderFactionChat({ scrollToNewest: true }); renderFactionMembers(); }
  if (name === 'admin') renderAdminPanel();
}

function updateResourceBar() {
  const resources = G.player.resources || { food: 0, wood: 0, iron: 0, manpower: 0 };
  document.getElementById('res-food').textContent = fmt(resources.food);
  document.getElementById('res-wood').textContent = fmt(resources.wood);
  document.getElementById('res-iron').textContent = fmt(resources.iron);
  document.getElementById('res-manpower').textContent = fmt(resources.manpower);
}

function renderCity() {
  const buildings = G.player.buildings || { farm: 1, lumbermill: 1, ironmine: 1, barracks: 1 };
  const serverProduction = G.player.production || { food: 0, wood: 0, iron: 0, manpower: 0 };
  const factionBonuses = G.player.factionBonuses || { food: 0, wood: 0, iron: 0, manpower: 0, training: 0 };
  const container = document.getElementById('building-list');
  container.innerHTML = '';

  const defs = {
    farm: { name: 'Farm', icon: '🌾', resource: 'food', baseRate: 5, cost: { food: 50, wood: 80, iron: 0 } },
    lumbermill: { name: 'Lumber Mill', icon: '🪵', resource: 'wood', baseRate: 4, cost: { food: 40, wood: 0, iron: 60 } },
    ironmine: { name: 'Iron Mine', icon: '⚙️', resource: 'iron', baseRate: 3, cost: { food: 30, wood: 100, iron: 0 } },
    barracks: { name: 'Barracks', icon: '🏟', resource: 'manpower', baseRate: 2, cost: { food: 80, wood: 60, iron: 80 } },
  };

  Object.entries(defs).forEach(([key, def]) => {
    const level = Number(buildings[key] || 1);
    const baseProd = def.baseRate * level;
    const totalProd = Number(serverProduction[def.resource] || baseProd);
    const bonusPct = Math.round((factionBonuses[def.resource] || 0) * 100);
    const nextLevel = level + 1;
    const cost = {
      food: def.cost.food * nextLevel,
      wood: def.cost.wood * nextLevel,
      iron: def.cost.iron * nextLevel,
    };
    const costParts = [];
    if (cost.food > 0) costParts.push(`${fmt(cost.food)}🌾`);
    if (cost.wood > 0) costParts.push(`${fmt(cost.wood)}🪵`);
    if (cost.iron > 0) costParts.push(`${fmt(cost.iron)}⚙️`);

    const bonusLine = bonusPct > 0
      ? `<div class="building-bonus">Territory bonus: +${bonusPct}%</div>`
      : '';

    const card = document.createElement('div');
    card.className = 'building-card';
    card.innerHTML = `
      <div class="building-info">
        <div class="building-name">${def.icon} ${def.name}</div>
        <div class="building-level">Level ${level}</div>
        <div class="building-prod">+${totalProd} ${def.resource}/min</div>
        ${bonusLine}
        <div class="building-cost">Next: ${costParts.join(' + ')}</div>
      </div>
      <button class="btn-upgrade" onclick="upgradeBuilding('${key}')">⬆ Lvl ${nextLevel}</button>
    `;
    container.appendChild(card);
  });

  document.getElementById('soldiers-count').textContent = G.player.soldiers || 0;
  document.getElementById('train-count').textContent = trainAmount;
}

async function upgradeBuilding(key) {
  try {
    const response = await apiFetch('/game/upgrade-building', {
      method: 'POST',
      body: JSON.stringify({ building: key }),
    });
    setGameStateFromSnapshot(response.state);
    renderCity();
    renderMap();
    updateResourceBar();
    showToast(`✅ ${key} upgraded on the server.`);
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

function changeTrain(delta) {
  trainAmount = Math.max(1, trainAmount + delta);
  document.getElementById('train-count').textContent = trainAmount;
}

async function trainSoldiers() {
  try {
    const response = await apiFetch('/game/train-soldiers', {
      method: 'POST',
      body: JSON.stringify({ amount: trainAmount }),
    });
    setGameStateFromSnapshot(response.state);
    renderCity();
    updateResourceBar();
    showToast(`✅ Trained ${response.trained} soldier(s) on the server.`);
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

const FACTION_FILL = { blue: '#1a4d8f', red: '#7a1a1a', green: '#1a5c2a' };
const FACTION_STROKE = { blue: '#2e78e0', red: '#d93030', green: '#2ea840' };

function sortTerritoryIds(ids) {
  const factionOrder = { b: 0, r: 1, g: 2, n: 3 };
  return [...ids].sort((left, right) => {
    const leftPrefix = String(left || '').charAt(0).toLowerCase();
    const rightPrefix = String(right || '').charAt(0).toLowerCase();
    const leftOrder = factionOrder[leftPrefix] ?? 9;
    const rightOrder = factionOrder[rightPrefix] ?? 9;
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;

    const leftNumber = Number(String(left || '').slice(1));
    const rightNumber = Number(String(right || '').slice(1));
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }

    return String(left).localeCompare(String(right));
  });
}

function buildTerritoryLayout(territoriesById) {
  // Delegates to the canonical topology module (world-topology.js) so the rendered map
  // always matches the graph actually stored in PostgreSQL — never a hand-tuned layout
  // that can drift from world-seed.sql/the migration.
  const layout = { ...WORLD_TOPOLOGY.buildLayout() };
  Object.keys(layout).forEach((id) => {
    if (!(id in territoriesById)) delete layout[id];
  });

  // Any territory outside the known map shape (e.g. custom/test data) still gets a
  // reasonable spot instead of being dropped from the render.
  const placedIds = new Set(Object.keys(layout));
  const unplacedIds = sortTerritoryIds(Object.keys(territoriesById)).filter((id) => !placedIds.has(id));
  const cols = 6;
  unplacedIds.forEach((id, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    layout[id] = { cx: 60 + (col * 100), cy: 700 + (row * 92) };
  });

  const { width, height } = WORLD_TOPOLOGY.LAYOUT_VIEWBOX;
  return { layout, viewBox: `0 0 ${width} ${height}` };
}

function createHexPoints(cx, cy, radius = 28) {
  const points = [];
  for (let i = 0; i < 6; i += 1) {
    const angle = ((60 * i) - 30) * (Math.PI / 180);
    const px = cx + radius * Math.cos(angle);
    const py = cy + radius * Math.sin(angle);
    points.push(`${px.toFixed(2)},${py.toFixed(2)}`);
  }
  return points.join(' ');
}

function canAttack(id, gameState = G) {
  const territory = gameState.territories[id];
  if (!territory || territory.capital || territory.owner === gameState.player.faction) return false;
  return territory.adj.some((neighborId) => gameState.territories[neighborId] && gameState.territories[neighborId].owner === gameState.player.faction);
}

function renderMap() {
  const svg = document.getElementById('map-svg');
  if (!svg) return;
  svg.innerHTML = '';
  const { layout, viewBox } = buildTerritoryLayout(G.territories);
  svg.setAttribute('viewBox', viewBox);

  // Draw connection lines first so hex tiles render on top of them.
  const drawnEdges = new Set();
  Object.keys(G.territories).forEach((id) => {
    const territory = G.territories[id];
    const from = layout[id];
    if (!territory || !from) return;

    (territory.adj || []).forEach((neighborId) => {
      const to = layout[neighborId];
      if (!to) return;
      const edgeKey = [id, neighborId].sort().join('|');
      if (drawnEdges.has(edgeKey)) return;
      drawnEdges.add(edgeKey);

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', from.cx);
      line.setAttribute('y1', from.cy);
      line.setAttribute('x2', to.cx);
      line.setAttribute('y2', to.cy);
      line.setAttribute('class', 'territory-link');
      svg.appendChild(line);
    });
  });

  sortTerritoryIds(Object.keys(G.territories)).forEach((id) => {
    const territory = G.territories[id];
    const position = layout[id];
    if (!territory || !position) return;

    const fill = FACTION_FILL[territory.owner] || '#333';
    const stroke = FACTION_STROKE[territory.owner] || '#888';
    const { cx: x, cy: y } = position;

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', createHexPoints(x, y));
    poly.setAttribute('fill', fill);
    poly.setAttribute('stroke', selectedTerritoryId === id ? '#fff' : stroke);
    poly.setAttribute('stroke-width', selectedTerritoryId === id ? '3' : '1.5');
    poly.setAttribute('class', 'territory');
    poly.setAttribute('data-id', id);
    poly.addEventListener('click', () => selectTerritory(id));
    svg.appendChild(poly);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', y - 5);
    label.setAttribute('fill', '#e6edf3');
    label.setAttribute('font-size', '7.5');
    label.setAttribute('text-anchor', 'middle');
    label.textContent = String(id).toUpperCase();
    svg.appendChild(label);

    if (territory.capital) {
      const capitalMarker = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      capitalMarker.setAttribute('x', x);
      capitalMarker.setAttribute('y', y - 20);
      capitalMarker.setAttribute('text-anchor', 'middle');
      capitalMarker.setAttribute('class', 'territory-capital-marker');
      capitalMarker.textContent = '👑';
      svg.appendChild(capitalMarker);
    }

    const troops = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    troops.setAttribute('x', x);
    troops.setAttribute('y', y + 10);
    troops.setAttribute('fill', '#e3b341');
    troops.setAttribute('font-size', '9');
    troops.setAttribute('text-anchor', 'middle');
    troops.textContent = '⚔' + territory.troops;
    svg.appendChild(troops);
  });
}

let recallSendCount = 1;

function selectTerritory(id) {
  selectedTerritoryId = id;
  const territory = G.territories[id];
  if (!territory) return;

  renderMap();
  document.getElementById('territory-panel').style.display = 'block';
  document.getElementById('tp-name').textContent = territory.name;
  document.getElementById('tp-owner').textContent = ownerLabel(territory.owner);
  document.getElementById('tp-troops').textContent = territory.troops;
  document.getElementById('tp-city-soldiers').textContent = Number(G.player.soldiers || 0);
  const stationed = Number((G.player.stationedTroops || {})[id] || 0);
  document.getElementById('tp-stationed').textContent = stationed;
  document.getElementById('tp-battle-rule').textContent = territory.capital
    ? 'Protected capital — cannot be attacked or occupied.'
    : 'Send more troops than defenders to capture';
  document.getElementById('tp-bonus').textContent = formatBonusLabel(territory.bonus, territory.bonusValue);
  document.getElementById('tp-neighbors').textContent = (territory.adj || []).map((neighborId) => G.territories[neighborId]?.name || neighborId).join(', ');

  const attackSection = document.getElementById('attack-section');
  const defendSection = document.getElementById('defend-section');
  const recallSection = document.getElementById('recall-section');
  if (canAttack(id)) {
    attackSection.style.display = 'block';
    defendSection.style.display = 'none';
    attackSendCount = Math.max(1, Math.min(10, Number(G.player.soldiers) || 1));
    document.getElementById('attack-count').textContent = attackSendCount;
  } else if (territory.owner === G.player.faction) {
    attackSection.style.display = 'none';
    defendSection.style.display = 'block';
    defendSendCount = Math.max(1, Math.min(10, Number(G.player.soldiers) || 1));
    document.getElementById('defend-count').textContent = defendSendCount;
    if (recallSection) {
      if (stationed > 0) {
        recallSection.style.display = 'block';
        recallSendCount = Math.max(1, Math.min(1, stationed));
        document.getElementById('recall-count').textContent = recallSendCount;
      } else {
        recallSection.style.display = 'none';
      }
    }
  } else {
    attackSection.style.display = 'none';
    defendSection.style.display = 'none';
  }
}

function ownerLabel(owner) {
  return { blue: '🔵 Blue', red: '🔴 Red', green: '🟢 Green', neutral: '⚪ Neutral' }[owner] || owner;
}

function formatBonusLabel(bonusType, bonusValue) {
  const type = String(bonusType || '').toLowerCase();
  const pct = Math.round(Number(bonusValue || 0) * 100);
  const map = {
    food: `🌾 +${pct}% Food Production`,
    wood: `🪵 +${pct}% Wood Production`,
    iron: `⚙️ +${pct}% Iron Production`,
    manpower: `👥 +${pct}% Manpower Production`,
    training: `⚔️ -${pct}% Training Cost`,
    fortress: '🏰 Fortress',
    storage: `📦 +${pct}% Storage`,
    resource: `✨ +${pct}% All Resources`,
    none: '—',
  };
  return map[type] || (type ? type : '—');
}

function changeAttack(delta) {
  const maxAmount = Math.max(1, Number(G.player.soldiers) || 1);
  if (delta === 'max') {
    attackSendCount = maxAmount;
  } else {
    attackSendCount = Math.max(1, Math.min(maxAmount, attackSendCount + delta));
  }
  document.getElementById('attack-count').textContent = attackSendCount;
}

async function launchAttack() {
  if (!selectedTerritoryId) {
    showToast('❌ Select a territory first.');
    return;
  }
  if (G.territories[selectedTerritoryId]?.capital) {
    showToast('❌ Capital territories cannot be attacked or occupied.');
    return;
  }
  if (!canAttack(selectedTerritoryId)) {
    showToast('❌ This target cannot be attacked from your faction.');
    return;
  }

  try {
    const response = await apiFetch('/game/attack', {
      method: 'POST',
      body: JSON.stringify({ territoryId: selectedTerritoryId, soldiers: attackSendCount }),
    });
    setGameStateFromSnapshot(response.state);
    const result = response.outcome;
    if (result) {
      document.getElementById('battle-result-text').innerHTML = result.victory
        ? `<span class="result-victory">⚔️ VICTORY!</span><br>Territory captured.<br>Attackers left: ${result.attackersRemaining}`
        : `<span class="result-defeat">💀 HELD!</span><br>Attack failed.<br>Defenders left: ${result.defendersRemaining}`;
      document.getElementById('battle-popup').style.display = 'block';
    }
    showToast(result?.victory ? '✅ Territory captured.' : '⚠️ Attack resolved by troop count.');
    renderCity();
    renderMap();
    updateResourceBar();
    if (selectedTerritoryId) selectTerritory(selectedTerritoryId);
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

function changeDefend(delta) {
  const maxAmount = Math.max(1, Number(G.player.soldiers) || 1);
  if (delta === 'max') {
    defendSendCount = maxAmount;
  } else {
    defendSendCount = Math.max(1, Math.min(maxAmount, defendSendCount + delta));
  }
  document.getElementById('defend-count').textContent = defendSendCount;
}

async function sendDefenders() {
  if (!selectedTerritoryId) {
    showToast('❌ Select a territory first.');
    return;
  }

  const territory = G.territories[selectedTerritoryId];
  if (!territory || territory.owner !== G.player.faction) {
    showToast('❌ You can defend only your faction territory.');
    return;
  }

  try {
    const response = await apiFetch('/game/defend', {
      method: 'POST',
      body: JSON.stringify({ territoryId: selectedTerritoryId, troops: defendSendCount }),
    });
    setGameStateFromSnapshot(response.state);
    showToast(`🛡️ ${defendSendCount} troops sent to defend ${territory.name}.`);
    renderCity();
    renderMap();
    updateResourceBar();
    if (selectedTerritoryId) selectTerritory(selectedTerritoryId);
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

function changeRecall(delta) {
  const stationed = Number((G.player.stationedTroops || {})[selectedTerritoryId] || 0);
  const maxAmount = Math.max(1, stationed);
  if (delta === 'max') {
    recallSendCount = maxAmount;
  } else {
    recallSendCount = Math.max(1, Math.min(maxAmount, recallSendCount + delta));
  }
  document.getElementById('recall-count').textContent = recallSendCount;
}

async function recallDefenders() {
  if (!selectedTerritoryId) {
    showToast('❌ Select a territory first.');
    return;
  }

  try {
    const response = await apiFetch('/game/recall-defenders', {
      method: 'POST',
      body: JSON.stringify({ territoryId: selectedTerritoryId, troops: recallSendCount }),
    });
    setGameStateFromSnapshot(response.state);
    showToast(`↩️ ${recallSendCount} troops recalled.`);
    renderCity();
    renderMap();
    updateResourceBar();
    if (selectedTerritoryId) selectTerritory(selectedTerritoryId);
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function resolveSelectedTargetBattle() {
  if (!selectedTerritoryId) {
    showToast('❌ Select a target first.');
    return;
  }
  try {
    const response = await apiFetch('/game/resolve-battle', {
      method: 'POST',
      body: JSON.stringify({ territoryId: selectedTerritoryId }),
    });
    setGameStateFromSnapshot(response.state);

    const result = response.outcome;
    document.getElementById('battle-result-text').innerHTML = result.victory
      ? `<span class="result-victory">⚔️ VICTORY!</span><br>Attack succeeded.<br>Attackers left: ${result.attackersRemaining}`
      : `<span class="result-defeat">💀 DEFEAT!</span><br>Attack failed.<br>Defenders lost: ${result.defendersLost}`;
    document.getElementById('battle-popup').style.display = 'block';
    renderMap();
    renderCity();
    updateResourceBar();
    showToast(result.victory ? '✅ Victory resolved by the server.' : '⚠️ Battle resolved by the server.');
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

function closeBattlePopup() {
  document.getElementById('battle-popup').style.display = 'none';
}

// ===================== ACTIVITY FEED =====================

function factionIcon(faction) {
  return { blue: '🔵', red: '🔴', green: '🟢', neutral: '⚪' }[faction] || '❓';
}

async function renderActivity() {
  const container = document.getElementById('activity-feed');
  if (!container) return;
  try {
    const data = await apiFetch('/game/battles');
    const battles = data.battles || [];
    container.replaceChildren();
    if (!battles.length) {
      const empty = document.createElement('p');
      empty.className = 'info-text';
      empty.textContent = 'No battles yet.';
      container.appendChild(empty);
      return;
    }
    battles.forEach((b) => {
      const attacker = b.attacker_username ? b.attacker_username : `${factionIcon(b.attacker_faction)} ${b.attacker_faction}`;
      const won = b.winner === b.attacker_faction;
      const territory = b.territory_name || b.territory_id;
      const winnerIcon = factionIcon(b.winner);
      const resultLine = won
        ? `${winnerIcon} ${b.attacker_faction} captured ${territory} from ${b.owner_before}`
        : `${winnerIcon} ${b.defender_faction} successfully defended ${territory}`;
      const ts = b.created_at ? new Date(b.created_at).toLocaleString() : '';
      const entry = document.createElement('div');
      entry.className = 'activity-entry';

      const headline = document.createElement('div');
      headline.className = 'activity-headline';
      headline.textContent = `⚔️ ${attacker} attacked ${territory} with ${b.troops_sent} troops`;

      const result = document.createElement('div');
      result.className = 'activity-result';
      result.textContent = resultLine;

      const losses = document.createElement('div');
      losses.className = 'activity-losses';
      losses.textContent = `Attackers lost: ${b.attackers_lost} · Defenders lost: ${b.defenders_lost}`;

      const time = document.createElement('div');
      time.className = 'activity-time';
      time.textContent = ts;

      entry.append(headline, result, losses, time);
      container.appendChild(entry);
    });
  } catch (error) {
    const msg = document.createElement('p');
    msg.className = 'info-text';
    msg.textContent = `Could not load activity: ${error.message}`;
    container.replaceChildren(msg);
  }
}

// ===================== FACTION CHAT =====================

function insertChatEmoji(emoji) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
  const nextPosition = start + emoji.length;
  input.focus();
  input.setSelectionRange(nextPosition, nextPosition);
}

function scrollFactionChatToNewest() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.scrollTop = container.scrollHeight;
}

function isFactionChatNearBottom() {
  const container = document.getElementById('chat-messages');
  if (!container) return true;
  const remaining = container.scrollHeight - container.scrollTop - container.clientHeight;
  return remaining <= 24;
}

async function renderFactionChat({ scrollToNewest = false } = {}) {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  try {
    const data = await apiFetch('/game/faction-chat');
    G.chatMessages = data.messages || [];
    container.replaceChildren();
    if (!G.chatMessages.length) {
      const empty = document.createElement('p');
      empty.className = 'info-text';
      empty.textContent = 'No faction messages yet.';
      container.appendChild(empty);
    } else {
      G.chatMessages.forEach((entry) => {
        const row = document.createElement('div');
        row.className = 'chat-entry';

        const meta = document.createElement('div');
        meta.className = 'chat-meta';
        const createdAt = entry.createdAt || entry.created_at;
        const timestamp = createdAt ? new Date(createdAt).toLocaleString() : '';
        meta.textContent = `${entry.username} · ${timestamp}`;

        const message = document.createElement('div');
        message.className = 'chat-message';
        message.textContent = entry.message;

        row.append(meta, message);
        container.append(row);
      });
    }
    if (scrollToNewest) scrollFactionChatToNewest();
  } catch (error) {
    const msg = document.createElement('p');
    msg.className = 'info-text';
    msg.textContent = `Could not load faction chat: ${error.message}`;
    container.replaceChildren(msg);
  }
}

async function renderFactionMembers() {
  const container = document.getElementById('faction-member-list');
  const countLabel = document.getElementById('faction-member-count');
  if (!container) return;
  try {
    const data = await apiFetch('/game/faction-members');
    const members = data.members || [];
    if (countLabel) countLabel.textContent = String(data.total ?? members.length);
    container.replaceChildren();
    if (!members.length) {
      const empty = document.createElement('p');
      empty.className = 'info-text';
      empty.textContent = 'No faction members yet.';
      container.appendChild(empty);
      return;
    }
    members.forEach((member) => {
      const row = document.createElement('div');
      row.className = 'chat-meta';
      row.textContent = member.username;
      container.appendChild(row);
    });
  } catch (error) {
    const msg = document.createElement('p');
    msg.className = 'info-text';
    msg.textContent = `Could not load faction members: ${error.message}`;
    container.replaceChildren(msg);
  }
}

async function sendFactionChatMessage() {
  const input = document.getElementById('chat-input');
  if (!input) return;
  try {
    await apiFetch('/game/faction-chat', {
      method: 'POST',
      body: JSON.stringify({ message: input.value }),
    });
    input.value = '';
    await renderFactionChat({ scrollToNewest: true });
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

function startFactionChatPolling() {
  if (factionChatPollHandle) return;
  factionChatPollHandle = setInterval(() => {
    const chatScreen = document.getElementById('screen-chat');
    if (chatScreen && chatScreen.classList.contains('active')) {
      renderFactionChat({ scrollToNewest: isFactionChatNearBottom() });
    }
  }, 4000);
}

function stopFactionChatPolling() {
  if (!factionChatPollHandle) return;
  clearInterval(factionChatPollHandle);
  factionChatPollHandle = null;
}

// ===================== ADMIN PANEL =====================

async function renderAdminPanel() {
  if (!isAdminUser(G.player)) return;
  renderAdminSeasonInfo();
  renderAdminPlayers();
  renderAdminTerritories();
}

async function renderAdminSeasonInfo() {
  const container = document.getElementById('admin-season-info');
  if (!container) return;
  try {
    const data = await apiFetch('/admin/season');
    const s = data.season;
    const counts = s.memberCounts || {};
    const scores = s.liveScores || {};
    container.innerHTML = `
      <div class="admin-territory-row">
        <strong>Season ${s.seasonNumber}</strong>
        <span class="admin-badge">ends ${new Date(s.endsAt).toISOString()}</span>
      </div>
      <div class="admin-territory-row">
        <span>🔵 ${scores.blue ?? 0} pts (${counts.blue ?? 0} players)</span>
        <span>🔴 ${scores.red ?? 0} pts (${counts.red ?? 0} players)</span>
        <span>🟢 ${scores.green ?? 0} pts (${counts.green ?? 0} players)</span>
      </div>
    `;
  } catch (error) {
    container.textContent = `Error: ${error.message}`;
  }
}

async function adminForceFinishSeason() {
  if (!confirm('Force-finish the current season right now?\n\nThis finalizes scores, awards prestige to the winning faction, and immediately starts the next season using the same reset as an automatic midnight rollover.')) return;
  try {
    const res = await apiFetch('/admin/season/force-finish', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    showToast(`✅ ${res.message}`);
    await loadGame();
    renderAdminSeasonInfo();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function renderAdminPlayers() {
  const container = document.getElementById('admin-player-list');
  if (!container) return;
  try {
    const data = await apiFetch('/admin/players');
    container.replaceChildren();
    for (const p of (data.players || [])) {
      const row = document.createElement('div');
      row.className = 'admin-player-row';

      const title = document.createElement('strong');
      title.textContent = `#${p.id} ${p.username}`;

      const badge = document.createElement('span');
      badge.className = 'admin-badge';
      badge.textContent = `${p.faction || '—'} · ${p.role}`;

      const stats = document.createElement('div');
      stats.className = 'admin-player-stats';
      stats.textContent = `⚔️${p.soldiers} 🌾${p.resource_food} 🪵${p.resource_wood} ⚙️${p.resource_iron} 👥${p.resource_manpower}`;

      const actions = document.createElement('div');
      actions.className = 'admin-player-actions';

      const roleSelect = document.createElement('select');
      roleSelect.id = `admin-role-${p.id}`;
      const roleOptions = p.username === 'Sai' ? ['admin'] : ['member', 'leader'];
      roleOptions.forEach((roleValue) => {
        const option = document.createElement('option');
        option.value = roleValue;
        option.textContent = roleValue;
        option.selected = p.role === roleValue;
        roleSelect.appendChild(option);
      });
      roleSelect.disabled = p.username === 'Sai';

      const roleButton = document.createElement('button');
      roleButton.className = 'btn-small';
      roleButton.textContent = 'Set Role';
      roleButton.disabled = p.username === 'Sai';
      roleButton.addEventListener('click', () => adminSetRole(p.id));

      const factionSelect = document.createElement('select');
      factionSelect.id = `admin-faction-${p.id}`;
      ['blue', 'red', 'green'].forEach((factionValue) => {
        const option = document.createElement('option');
        option.value = factionValue;
        option.textContent = factionValue;
        option.selected = p.faction === factionValue;
        factionSelect.appendChild(option);
      });

      const factionButton = document.createElement('button');
      factionButton.className = 'btn-small';
      factionButton.textContent = 'Set Faction';
      factionButton.addEventListener('click', () => adminSetFaction(p.id));

      const resetButton = document.createElement('button');
      resetButton.className = 'btn-small';
      resetButton.textContent = 'Reset';
      resetButton.addEventListener('click', () => adminResetPlayer(p.id));

      const soldiersInput = document.createElement('input');
      soldiersInput.id = `admin-soldiers-${p.id}`;
      soldiersInput.type = 'number';
      soldiersInput.min = '0';
      soldiersInput.value = p.soldiers;

      const resources = ['food', 'wood', 'iron', 'manpower'];
      const resourceInputs = resources.map((resourceKey) => {
        const input = document.createElement('input');
        input.id = `admin-${resourceKey}-${p.id}`;
        input.type = 'number';
        input.min = '0';
        input.value = p[`resource_${resourceKey}`];
        return input;
      });

      const soldiersButton = document.createElement('button');
      soldiersButton.className = 'btn-small';
      soldiersButton.textContent = 'Set Soldiers';
      soldiersButton.addEventListener('click', () => adminSetSoldiers(p.id));

      const resourcesButton = document.createElement('button');
      resourcesButton.className = 'btn-small';
      resourcesButton.textContent = 'Set Resources';
      resourcesButton.addEventListener('click', () => adminSetResources(p.id));

      actions.append(roleSelect, roleButton, factionSelect, factionButton, soldiersInput, soldiersButton, ...resourceInputs, resourcesButton, resetButton);
      row.append(title, badge, stats, actions);
      container.appendChild(row);
    }
  } catch (error) {
    const msg = document.createElement('p');
    msg.className = 'info-text';
    msg.textContent = `Error: ${error.message}`;
    container.replaceChildren(msg);
  }
}

async function renderAdminTerritories() {
  const container = document.getElementById('admin-territory-list');
  if (!container) return;
  try {
    const data = await apiFetch('/admin/territories');
    container.innerHTML = (data.territories || []).map((t) => `
      <div class="admin-territory-row">
        <strong>${t.id}</strong> ${t.name}
        <span class="admin-badge">${t.owner_faction} · ${t.defense_troops}⚔️</span>
        <span class="admin-badge-bonus">${formatBonusLabel(t.bonus_type, t.bonus_value)}</span>
        ${t.is_capital ? '<span class="admin-badge admin-badge-protected">Protected capital</span>' : ''}
        <div class="admin-territory-actions">
          <select id="admin-owner-${t.id}" ${t.is_capital ? 'disabled' : ''}>
            <option value="blue" ${t.owner_faction === 'blue' ? 'selected' : ''}>blue</option>
            <option value="red" ${t.owner_faction === 'red' ? 'selected' : ''}>red</option>
            <option value="green" ${t.owner_faction === 'green' ? 'selected' : ''}>green</option>
            <option value="neutral" ${t.owner_faction === 'neutral' ? 'selected' : ''}>neutral</option>
          </select>
          <input id="admin-def-${t.id}" type="number" min="0" value="${t.defense_troops}" style="width:60px" />
          <button class="btn-small" onclick="adminEditTerritory('${t.id}')">Update</button>
        </div>
        ${!t.is_capital && t.owner_faction !== 'neutral' ? `
        <div class="admin-territory-actions">
          <button class="btn-small btn-secondary" onclick="adminSetCapital('${t.id}', '${t.owner_faction}')">Make ${t.owner_faction} capital</button>
        </div>` : ''}
      </div>
    `).join('');
  } catch (error) {
    const msg = document.createElement('p');
    msg.className = 'info-text';
    msg.textContent = `Error: ${error.message}`;
    container.innerHTML = '';
    container.appendChild(msg);
  }
}

async function adminResetWorld() {
  if (!confirm('Reset the entire game world? Player accounts will NOT be deleted.')) return;
  try {
    const res = await apiFetch('/admin/reset-world', { method: 'POST' });
    showToast(`✅ ${res.message}`);
    await loadGame();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function adminResetAllResources() {
  if (!confirm('Reset resources and soldiers for all players? Territory ownership and the world map will stay unchanged.')) return;
  try {
    const res = await apiFetch('/admin/reset-all-resources', { method: 'POST' });
    showToast(`✅ ${res.message}`);
    await loadGame();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function adminForceTick() {
  try {
    const res = await apiFetch('/admin/force-tick', { method: 'POST' });
    showToast(`✅ ${res.message}`);
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function adminResetPlayer(playerId) {
  if (!confirm(`Reset player #${playerId} to starting resources, soldiers, and buildings?`)) return;
  try {
    const res = await apiFetch('/admin/reset-player', { method: 'POST', body: JSON.stringify({ playerId }) });
    showToast(`✅ ${res.message}`);
    await loadGame();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function adminSetRole(playerId) {
  const role = document.getElementById(`admin-role-${playerId}`)?.value;
  if (!role) return;
  try {
    const res = await apiFetch(`/admin/player/${playerId}/role`, { method: 'POST', body: JSON.stringify({ role }) });
    showToast(`✅ ${res.message}`);
    renderAdminPlayers();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function adminSetFaction(playerId) {
  const faction = document.getElementById(`admin-faction-${playerId}`)?.value;
  if (!faction) return;
  if (!confirm(`Change player #${playerId} to the ${faction} faction?\n\nThis will keep the account, resources, buildings, and soldiers, lock the new faction, and recall any stationed defenders that no longer belong on that faction's territories.`)) return;
  try {
    const res = await apiFetch(`/admin/player/${playerId}/faction`, { method: 'POST', body: JSON.stringify({ faction }) });
    showToast(`✅ ${res.message}`);
    await loadGame();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function adminSetSoldiers(playerId) {
  const soldiers = Number(document.getElementById(`admin-soldiers-${playerId}`)?.value);
  if (!Number.isFinite(soldiers) || soldiers < 0) {
    showToast('❌ Soldiers must be a non-negative number.');
    return;
  }
  try {
    const res = await apiFetch(`/admin/player/${playerId}/soldiers`, { method: 'POST', body: JSON.stringify({ soldiers }) });
    showToast(`✅ ${res.message}`);
    renderAdminPlayers();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function adminSetResources(playerId) {
  const food = Number(document.getElementById(`admin-food-${playerId}`)?.value);
  const wood = Number(document.getElementById(`admin-wood-${playerId}`)?.value);
  const iron = Number(document.getElementById(`admin-iron-${playerId}`)?.value);
  const manpower = Number(document.getElementById(`admin-manpower-${playerId}`)?.value);
  if (![food, wood, iron, manpower].every((value) => Number.isFinite(value) && value >= 0)) {
    showToast('❌ Resources must be non-negative numbers.');
    return;
  }
  try {
    const res = await apiFetch(`/admin/player/${playerId}/resources`, {
      method: 'POST',
      body: JSON.stringify({
        food,
        wood,
        iron,
        manpower,
      }),
    });
    showToast(`✅ ${res.message}`);
    renderAdminPlayers();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function adminEditTerritory(territoryId) {
  const owner = document.getElementById(`admin-owner-${territoryId}`)?.value;
  const defense = document.getElementById(`admin-def-${territoryId}`)?.value;
  try {
    const res = await apiFetch(`/admin/territory/${territoryId}`, {
      method: 'POST',
      body: JSON.stringify({ owner, defense: Number(defense) }),
    });
    showToast(`✅ ${res.message}`);
    renderAdminTerritories();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function adminSetCapital(territoryId, faction) {
  if (!faction) return;
  if (!confirm(`Make ${territoryId} the ${faction} capital?\n\nThis only works on a territory ${faction} already owns. The faction's previous capital will lose its protected status; ownership, defenses, and troops are otherwise unchanged.`)) return;
  try {
    const res = await apiFetch('/admin/capital', {
      method: 'POST',
      body: JSON.stringify({ territoryId, faction }),
    });
    showToast(`✅ ${res.message}`);
    await loadGame();
    renderAdminTerritories();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

function autoSave() {
  // no browser-owned game save; only auth token remains client-side
}

function enablePullToRefreshFallback() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  let pullArmed = false;
  let pullReady = false;
  let startY = 0;
  const triggerDistance = 120;

  const getActiveScreen = () => document.querySelector('.screen.active');

  document.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;

    const screen = getActiveScreen();
    if (!screen) return;
    if (screen.scrollTop > 0) return;

    const touch = event.touches[0];
    if (touch.clientY > 96) return;

    startY = touch.clientY;
    pullArmed = true;
    pullReady = false;
  }, { passive: true });

  document.addEventListener('touchmove', (event) => {
    if (!pullArmed || event.touches.length !== 1) return;

    const screen = getActiveScreen();
    if (!screen || screen.scrollTop > 0) {
      pullArmed = false;
      pullReady = false;
      return;
    }

    const deltaY = event.touches[0].clientY - startY;
    if (deltaY >= triggerDistance && !pullReady) {
      pullReady = true;
      showToast('↻ Release to refresh');
    }
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (pullArmed && pullReady) {
      showToast('↻ Refreshing...');
      window.location.reload();
      return;
    }

    pullArmed = false;
    pullReady = false;
  }, { passive: true });
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
    enablePullToRefreshFallback();

    const authForm = document.getElementById('auth-form');
    const authModeButtons = document.querySelectorAll('.auth-mode-btn');

    authModeButtons.forEach((button) => {
      button.addEventListener('click', () => setAuthMode(button.dataset.mode));
    });

    if (authForm) {
      authForm.addEventListener('submit', submitAuth);
    }
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
      chatInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          sendFactionChatMessage();
        }
      });
    }
    const token = getToken();
    if (!token) {
      showAuthScreen();
      setAuthMode('login');
      return;
    }

    try {
      const hasToken = Boolean(getToken());
      if (hasToken) {
        await loadGame();
        setInterval(refreshGameStateInBackground, 60000);
        // Refresh activity feed every 30 seconds
        setInterval(() => {
          const activityScreen = document.getElementById('screen-activity');
          if (activityScreen && activityScreen.classList.contains('active')) {
            renderActivity();
          }
        }, 30000);
        // Smooth HH:MM:SS countdown to the next daily 00:00 UTC reset; the season data
        // itself only refreshes with the 60s background poll above.
        setInterval(tickScoreboardCountdown, 1000);
      } else {
        showAuthScreen();
        setAuthMode('login');
      }
    } catch (error) {
      showAuthScreen();
      setAuthMode('login');
      showToast(error.message || 'Please log in to continue.');
    }
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    buildAuthPayload,
    getFactionLegendEntries,
    renderMapLegend,
    mapTerritories,
    canAttack,
    ownerLabel,
    formatBonusLabel,
    isAdminUser,
    insertChatEmoji,
    isFactionChatNearBottom,
    setGameStateFromSnapshot,
    sendFactionChatMessage,
    renderFactionMembers,
    startFactionChatPolling,
    buildTerritoryLayout,
    formatCountdown,
    renderScoreboard,
    apiFetch,
    ensureSession,
    fetchCurrentUser,
    loadGame,
    refreshGameStateInBackground,
    getToken,
    setToken,
  };
}
