/* ====================================================
   TERRITORY CONQUEST — authoritative client wrapper
   The browser may only render and submit actions.
   All critical state is calculated and stored on the server.
   ==================================================== */

const AUTH_STORAGE_KEY = 'trying_game_token';
const SCREEN_STORAGE_PREFIX = 'trying_game_screen_';
const VALID_SCREENS = new Set(['city', 'map', 'activity', 'chat', 'admin']);
const USERNAME_REGEX = /^[A-Za-z0-9_-]{3,32}$/;
const DEFAULT_STATE = {
  player: {
    id: null,
    username: 'Guest',
    faction: 'blue',
    role: 'member',
    resources: { food: 0, wood: 0, iron: 0, manpower: 0 },
    soldiers: 0,
    buildings: { farm: 1, lumbermill: 1, ironmine: 1, barracks: 1, storage: 1 },
    production: { food: 0, wood: 0, iron: 0, manpower: 0 },
  },
  territories: {},
  rallies: {},
  factionMap: { faction: null, cities: [] },
  chatMessages: [],
  season: null,
};

let G = structuredClone(DEFAULT_STATE);
let selectedTerritoryId = null;
let attackSendCount = 10;
let defendSendCount = 10;
let trainAmount = 1;
let factionChatPollHandle = null;
const mapView = { scale: 1, x: 0, y: 0, pointers: new Map(), dragStart: null, pinchStart: null, dragged: false, hadMultiplePointers: false, desktopPan: null, suppressClickUntil: 0, boundSvg: null, resizeBound: false, desktopPanBound: false };
let realtimeSocket = null;
let realtimeRefreshTimer = null;
let realtimeRefreshInFlight = false;
let realtimeRefreshQueued = false;
let activeActivityTab = 'feed';
let seasonGateClockOffset = 0;
let seasonGateRefreshPending = false;
let seasonJoinInFlight = false;
let activeMapView = 'world';

// Canonical topology module (world-topology.js): required directly under Node (tests),
// exposed as window.WORLD_TOPOLOGY when loaded via <script> in the browser.
const WORLD_TOPOLOGY = (typeof module !== 'undefined' && typeof require === 'function')
  ? require('./world-topology')
  : (typeof window !== 'undefined' ? window.WORLD_TOPOLOGY : undefined);
const MAP_REGISTRY = (typeof module !== 'undefined' && typeof require === 'function')
  ? require('./map-registry')
  : (typeof window !== 'undefined' ? window.MAP_REGISTRY : undefined);

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
      storageBonus: Number(territory.storageBonus ?? territory.storage_bonus ?? 0),
      adj: Array.isArray(territory.neighbors) ? territory.neighbors : [],
      fortress: !!(territory.fortress ?? territory.is_fortress),
      capital: !!(territory.capital ?? territory.is_capital),
      contested: !!territory.contested,
      protectedUntil: territory.protectedUntil || territory.protected_until || null,
      scoreValue: Number(territory.scoreValue ?? territory.score_value ?? 1),
      mapX: Number(territory.mapX ?? territory.map_x ?? 0),
      mapY: Number(territory.mapY ?? territory.map_y ?? 0),
    };
  });
  return entryMap;
}

function mapRallies(rawRallies) {
  const rallies = {};
  (rawRallies || []).forEach((rally) => {
    rallies[rally.territoryId] = {
      territoryId: rally.territoryId,
      attackerFaction: rally.attackerFaction,
      defenderFaction: rally.defenderFaction,
      startedBy: rally.startedBy,
      phase: rally.phase || 'rally',
      resolvesAt: rally.resolvesAt,
      nextTickAt: rally.nextTickAt || null,
      roundNumber: Number(rally.roundNumber || 0),
      totalAttackers: Number(rally.totalAttackers || 0),
      myContribution: Number(rally.myContribution || 0),
      attackersLost: Number(rally.attackersLost || 0),
      defendersLost: Number(rally.defendersLost || 0),
      attackBonus: Number(rally.attackBonus || 0),
      defenseBonus: Number(rally.defenseBonus || 0),
    };
  });
  return rallies;
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

function formatScoreboardFaction(faction, territoryCount, score, memberCount) {
  const icon = { blue: '🔵', red: '🔴', green: '🟢' }[faction];
  return `${icon} ${territoryCount} territories · ${score} pts · ${memberCount} players`;
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

  seasonEl.textContent = `Season ${season.seasonNumber} · ${season.mapName || 'Three Frontiers'}`;
  countdownEl.textContent = formatCountdown(new Date(season.endsAt).getTime() - Date.now());

  const scores = season.scores || { blue: 0, red: 0, green: 0 };
  const memberCounts = season.memberCounts || { blue: 0, red: 0, green: 0 };
  const territoryCounts = { blue: 0, red: 0, green: 0 };
  Object.values(G.territories).forEach((territory) => {
    if (territoryCounts[territory.owner] !== undefined) territoryCounts[territory.owner] += 1;
  });
  ['blue', 'red', 'green'].forEach((faction) => {
    document.getElementById(`scoreboard-${faction}-score`).textContent = formatScoreboardFaction(
      faction,
      territoryCounts[faction],
      scores[faction] ?? 0,
      memberCounts[faction] ?? 0
    );
  });
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
          <span class="info-text">🗺️ ${s.mapName || 'Three Frontiers'}</span>
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
      buildings: snapshot.player?.buildings || { farm: 1, lumbermill: 1, ironmine: 1, barracks: 1, storage: 1 },
      production: snapshot.player?.production || { food: 0, wood: 0, iron: 0, manpower: 0 },
      factionBonuses: snapshot.player?.factionBonuses || { food: 0, wood: 0, iron: 0, manpower: 0, training: 0 },
      stationedTroops: snapshot.player?.stationedTroops || {},
    },
    territories: mapTerritories(snapshot.world?.territories || snapshot.territories || []),
    rallies: mapRallies(snapshot.world?.rallies || []),
    factionMap: snapshot.world?.factionMap || { faction: snapshot.player?.faction || null, cities: [] },
    // A season/faction change invalidates any cached chat: never show the previous
    // faction's messages, even briefly, while the new season's chat loads.
    chatMessages: previousFaction && previousFaction === G.player?.faction ? (G.chatMessages || []) : [],
    season: snapshot.season || null,
  };
  renderMapLegend(G.player.faction);
  updateAdminVisibility(G.player);
  updatePlayerIdentity();
  updateFactionTheme();
  renderFactionBonuses();
  renderScoreboard();
  renderFactionMap();
  if (previousFaction && snapshot.player?.faction && previousFaction !== snapshot.player.faction) {
    G.chatMessages = [];
    document.getElementById('chat-messages')?.replaceChildren();
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

function scheduleRealtimeRefresh(delay = 150) {
  realtimeRefreshQueued = true;
  clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = setTimeout(async () => {
    if (realtimeRefreshInFlight) return;
    realtimeRefreshQueued = false;
    realtimeRefreshInFlight = true;
    try {
      await refreshGameStateInBackground();
    } finally {
      realtimeRefreshInFlight = false;
      if (realtimeRefreshQueued) scheduleRealtimeRefresh(0);
    }
  }, delay);
}

function connectRealtime() {
  const token = getToken();
  if (!token || typeof io !== 'function') return null;
  if (realtimeSocket) {
    realtimeSocket.auth = { token };
    if (!realtimeSocket.connected) realtimeSocket.connect();
    return realtimeSocket;
  }

  realtimeSocket = io({ auth: { token }, reconnection: true });
  realtimeSocket.on('connect', () => scheduleRealtimeRefresh(0));
  realtimeSocket.on('state:changed', () => scheduleRealtimeRefresh());
  return realtimeSocket;
}

function disconnectRealtime() {
  clearTimeout(realtimeRefreshTimer);
  realtimeRefreshQueued = false;
  if (realtimeSocket) realtimeSocket.disconnect();
  realtimeSocket = null;
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

function setSeasonGateVisible(isVisible) {
  const gate = document.getElementById('season-gate');
  if (gate) gate.style.display = isVisible ? 'grid' : 'none';
}

function hideBootLoading() {
  const bootLoading = document.getElementById('boot-loading');
  if (bootLoading) bootLoading.style.display = 'none';
}

function showBootLoading() {
  const bootLoading = document.getElementById('boot-loading');
  if (bootLoading) bootLoading.style.display = 'flex';
}

function hideAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  if (authScreen) authScreen.style.display = 'none';
  setSeasonGateVisible(false);
  setGameShellVisible(true);
  hideBootLoading();
}

function showSeasonGate() {
  const authScreen = document.getElementById('auth-screen');
  if (authScreen) authScreen.style.display = 'none';
  stopFactionChatPolling();
  setGameShellVisible(false);
  setSeasonGateVisible(true);
  hideBootLoading();
}

function showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  if (authScreen) authScreen.style.display = 'flex';
  stopFactionChatPolling();
  setSeasonGateVisible(false);
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
    await loadGame();
  } catch (error) {
    message.textContent = error.message;
  }
}

function logoutPlayer() {
  disconnectRealtime();
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

function shouldShowSeasonGate(snapshot) {
  return !snapshot?.season?.hasStarted || !snapshot?.player?.joinedSeason;
}

function renderSeasonGate(snapshot) {
  const season = snapshot?.season || {};
  const player = snapshot?.player || {};
  const joined = Boolean(player.joinedSeason);
  const started = Boolean(season.hasStarted);
  seasonGateClockOffset = Number(snapshot?.serverTime || Date.now()) - Date.now();

  const label = document.getElementById('season-gate-label');
  const title = document.getElementById('season-gate-title');
  const countdown = document.getElementById('season-gate-countdown');
  const message = document.getElementById('season-gate-message');
  const joinedCount = document.getElementById('season-gate-joined-count');
  const joinButton = document.getElementById('season-join-btn');
  const confirmation = document.getElementById('season-joined-confirmation');
  const adminStartButton = document.getElementById('season-admin-start-btn');

  if (label) label.textContent = started
    ? `SEASON ${season.seasonNumber} · ${season.mapName || 'Three Frontiers'} · LIVE`
    : `SEASON ${season.seasonNumber} · ${season.mapName || 'Three Frontiers'} · REGISTRATION OPEN`;
  if (title) {
    title.textContent = started
      ? `Season ${season.seasonNumber} is underway`
      : (joined ? `You're ready for Season ${season.seasonNumber}` : 'Season starts in');
  }
  if (message) {
    message.textContent = started
      ? 'You can still join and will be placed in the faction with the fewest players.'
      : (joined
        ? 'Congratulations—you joined. Wait for the countdown and the game will open automatically.'
        : 'Join now to be assigned to a balanced faction and start from the first minute.');
  }
  if (joinedCount) {
    const count = Number(season.joinedCount || 0);
    joinedCount.textContent = `${count} ${count === 1 ? 'player' : 'players'} joined`;
  }
  if (joinButton) {
    joinButton.hidden = joined;
    joinButton.disabled = seasonJoinInFlight;
    joinButton.textContent = seasonJoinInFlight ? 'Joining…' : '⚔️ Join Season';
  }
  if (confirmation) confirmation.hidden = !joined;
  if (adminStartButton) adminStartButton.hidden = started || !isAdminUser(player);
  if (countdown) {
    countdown.textContent = started
      ? 'LIVE'
      : formatCountdown(new Date(season.startsAt).getTime() - (Date.now() + seasonGateClockOffset));
  }
}

function tickSeasonGateCountdown() {
  const gate = document.getElementById('season-gate');
  const countdown = document.getElementById('season-gate-countdown');
  if (!gate || gate.style.display === 'none' || !countdown || !G.season) return;
  if (G.season.hasStarted) {
    countdown.textContent = 'LIVE';
    return;
  }

  const remaining = new Date(G.season.startsAt).getTime() - (Date.now() + seasonGateClockOffset);
  countdown.textContent = formatCountdown(remaining);
  if (remaining <= 0 && !seasonGateRefreshPending) {
    seasonGateRefreshPending = true;
    loadGame().finally(() => { seasonGateRefreshPending = false; });
  }
}

async function joinCurrentSeason() {
  if (seasonJoinInFlight) return;
  seasonJoinInFlight = true;
  renderSeasonGate({ player: G.player, season: G.season, serverTime: Date.now() + seasonGateClockOffset });
  try {
    await apiFetch('/season/join', { method: 'POST', body: '{}' });
    showToast('✅ You joined the season.');
    await loadGame();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  } finally {
    seasonJoinInFlight = false;
    const button = document.getElementById('season-join-btn');
    if (button) {
      button.disabled = false;
      button.textContent = '⚔️ Join Season';
    }
  }
}

async function adminStartSeasonNow() {
  if (!confirm('Start this season now?\n\nThis ends the remaining registration countdown and begins the full seven-day season.')) return;
  try {
    const result = await apiFetch('/admin/season/start-now', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    });
    showToast(`✅ ${result.message}`);
    await loadGame();
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function loadGame() {
  setGameShellVisible(false);
  setSeasonGateVisible(false);
  showBootLoading();
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

  try {
    const payload = await apiFetch('/game/state');
    setGameStateFromSnapshot(payload);
    if (shouldShowSeasonGate(payload)) {
      renderSeasonGate(payload);
      showSeasonGate();
      connectRealtime();
      return;
    }

    renderCity();
    renderMap();
    updateResourceBar();
    restoreSavedScreen(G.player);
    hideAuthScreen();
    startFactionChatPolling();
    connectRealtime();
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

function openInfoModal() {
  const modal = document.getElementById('info-modal');
  if (!modal) return;
  modal.hidden = false;
  modal.querySelector('.info-modal-close')?.focus();
}

function closeInfoModal() {
  const modal = document.getElementById('info-modal');
  if (!modal) return;
  modal.hidden = true;
  document.getElementById('info-btn')?.focus();
}

function closeInfoModalFromBackdrop(event) {
  if (event.target === event.currentTarget) closeInfoModal();
}

async function loadChangelog() {
  const response = await fetch(`changelog.json?${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load changelog.');
  const entries = await response.json();
  if (!Array.isArray(entries)) throw new Error('Invalid changelog.');
  return entries;
}

function renderChangelogEntries(entries) {
  const container = document.getElementById('changelog-entries');
  if (!container) return;
  container.replaceChildren();

  entries.forEach((entry) => {
    if (!entry || typeof entry.title !== 'string' || !Array.isArray(entry.changes)) return;
    const article = document.createElement('article');
    article.className = 'changelog-entry';
    const heading = document.createElement('h3');
    heading.textContent = entry.title;
    const list = document.createElement('ul');
    entry.changes.forEach((change) => {
      if (typeof change !== 'string') return;
      const item = document.createElement('li');
      item.textContent = change;
      list.appendChild(item);
    });
    article.append(heading, list);
    container.appendChild(article);
  });

  if (!container.childElementCount) {
    const message = document.createElement('p');
    message.textContent = 'No changelog entries are available yet.';
    container.appendChild(message);
  }
}

async function openChangelogModal() {
  const modal = document.getElementById('changelog-modal');
  const container = document.getElementById('changelog-entries');
  if (!modal || !container) return;
  modal.hidden = false;
  modal.querySelector('.info-modal-close')?.focus();

  const loading = document.createElement('p');
  loading.textContent = 'Loading changelog...';
  container.replaceChildren(loading);
  try {
    renderChangelogEntries(await loadChangelog());
  } catch (error) {
    const message = document.createElement('p');
    message.textContent = 'The changelog is unavailable right now. Please try again later.';
    container.replaceChildren(message);
  }
}

function closeChangelogModal() {
  const modal = document.getElementById('changelog-modal');
  if (!modal) return;
  modal.hidden = true;
  document.getElementById('changelog-btn')?.focus();
}

function closeChangelogModalFromBackdrop(event) {
  if (event.target === event.currentTarget) closeChangelogModal();
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
    if (shouldShowSeasonGate(payload)) {
      renderSeasonGate(payload);
      showSeasonGate();
      return;
    }

    renderCity();
    renderMap();
    updateResourceBar();
    const gate = document.getElementById('season-gate');
    if (gate?.style.display !== 'none') {
      restoreSavedScreen(G.player);
      hideAuthScreen();
      startFactionChatPolling();
    }
    const territoryPanel = document.getElementById('territory-panel');
    if (selectedTerritoryId && territoryPanel?.style.display !== 'none') {
      selectTerritory(selectedTerritoryId, { preserveTroopInputs: true });
    }
    if (document.getElementById('screen-activity')?.classList.contains('active')) renderActivity();
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

function getScreenStorageKey(player) {
  return player?.id ? `${SCREEN_STORAGE_PREFIX}${player.id}` : '';
}

function restoreSavedScreen(player) {
  const storageKey = getScreenStorageKey(player);
  const savedScreen = storageKey ? localStorage.getItem(storageKey) : null;
  const screen = VALID_SCREENS.has(savedScreen) && (savedScreen !== 'admin' || isAdminUser(player))
    ? savedScreen
    : 'city';
  showScreen(screen, { persist: false });
  return screen;
}

function showScreen(name, { persist = true } = {}) {
  if (!VALID_SCREENS.has(name)) {
    console.warn('Unknown screen requested:', name);
    return;
  }
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
  const storageKey = getScreenStorageKey(G.player);
  if (persist && storageKey) localStorage.setItem(storageKey, name);
  if (name === 'city') renderCity();
  if (name === 'map') { renderMap(); renderFactionMap(); renderScoreboard(); showMapView(activeMapView); }
  if (name === 'activity') renderActivity();
  if (name === 'chat') { renderFactionChat({ scrollToNewest: true }); renderFactionMembers(); }
  if (name === 'admin') renderAdminPanel();
}

function updateResourceBar() {
  const resources = G.player.resources || { food: 0, wood: 0, iron: 0, manpower: 0 };
  const caps = G.player.storageCaps || {};
  ['food', 'wood', 'iron', 'manpower'].forEach((resource) => {
    const element = document.getElementById(`res-${resource}`);
    if (element) element.textContent = `${fmt(resources[resource])} / ${fmt(caps[resource] || 10000)}`;
  });
}

function updatePlayerIdentity() {
  const element = document.getElementById('player-identity');
  if (!element) return;
  const faction = String(G.player.faction || '').toLowerCase();
  element.textContent = G.player.username && faction ? `${G.player.username} · ${faction.charAt(0).toUpperCase()}${faction.slice(1)} Faction` : '—';
}

function updateFactionTheme() {
  const shell = document.getElementById('game-shell');
  if (!shell) return;
  shell.dataset.faction = ['blue', 'red', 'green'].includes(G.player.faction) ? G.player.faction : '';
}

function renderFactionBonuses() {
  const container = document.getElementById('faction-bonuses');
  if (!container) return;
  const bonuses = G.player.factionBonuses || {};
  const reserveTroops = Number(G.player.soldiers) || 0;
  const fortressTroopCap = Number(G.player.fortressTroopCap || 250);
  const fortressStatus = reserveTroops >= fortressTroopCap ? 'Paused' : 'Active';
  const entries = [`<span>Fortress reserve: ${reserveTroops}/${fortressTroopCap} · ${fortressStatus}</span>`, ...[
    ['food', '🌾 Food Production', '+', '%'], ['wood', '🪵 Wood Production', '+', '%'],
    ['iron', '⚙️ Iron Production', '+', '%'], ['manpower', '👥 Manpower Production', '+', '%'],
    ['training', '⚔️ Training Cost', '-', '%'], ['storage', '📦 Storage', '+', '%'],
    ['attack', '🗡️ Attack Strength', '+', '%'], ['defense', '🛡️ Defense Strength', '+', '%'],
    ['fortressTroops', '🏰 Fortress Generation', '+', '/min'],
  ].map(([key, label, prefix, suffix]) => {
    const value = Number(bonuses[key] || 0);
    if (value <= 0) return null;
    return `<span>${label} ${prefix}${suffix === '%' ? Math.round(value * 100) : value}${suffix}</span>`;
  }).filter(Boolean)];
  container.innerHTML = entries.join('');
}

function calculateTrainingCost(count, trainingBonus = 0) {
  const amount = Math.max(0, Math.floor(Number(count) || 0));
  const multiplier = Math.max(0.4, 1 - (Number(trainingBonus) || 0));
  const minimum = amount > 0 ? 1 : 0;
  return {
    food: Math.max(minimum, Math.ceil(50 * amount * multiplier)),
    iron: Math.max(minimum, Math.ceil(25 * amount * multiplier)),
    manpower: Math.max(minimum, Math.ceil(20 * amount * multiplier)),
  };
}

function updateTrainingCostDisplay() {
  const trainingBonus = Number(G.player.factionBonuses?.training || 0);
  const amount = document.getElementById('train-count')?.value || trainAmount;
  const multiplier = Math.max(0.4, 1 - trainingBonus);
  const cost = calculateTrainingCost(amount, trainingBonus);
  const discount = document.getElementById('training-discount');
  const total = document.getElementById('training-total-cost');
  if (discount) discount.textContent = `${Math.round((1 - multiplier) * 100)}%`;
  if (total) total.textContent = `${cost.food}🌾 + ${cost.iron}⚙️ + ${cost.manpower}👥`;
}

function renderCity() {
  const buildings = G.player.buildings || { farm: 1, lumbermill: 1, ironmine: 1, barracks: 1, storage: 1 };
  const serverProduction = G.player.production || { food: 0, wood: 0, iron: 0, manpower: 0 };
  const factionBonuses = G.player.factionBonuses || { food: 0, wood: 0, iron: 0, manpower: 0, training: 0 };
  const container = document.getElementById('building-list');
  container.innerHTML = '';

  const defs = {
    farm: { name: 'Farm', icon: '🌾', resource: 'food', baseRate: 5 },
    lumbermill: { name: 'Lumber Mill', icon: '🪵', resource: 'wood', baseRate: 4 },
    ironmine: { name: 'Iron Mine', icon: '⚙️', resource: 'iron', baseRate: 3 },
    barracks: { name: 'Barracks', icon: '🏟', resource: 'manpower', baseRate: 2 },
    storage: { name: 'Storage', icon: '📦' },
  };

  Object.entries(defs).forEach(([key, def]) => {
    const level = Number(buildings[key] || 1);
    const isStorage = key === 'storage';
    const baseProd = isStorage ? 0 : def.baseRate * level;
    const totalProd = isStorage ? 0 : Number(serverProduction[def.resource] || baseProd);
    const bonusPct = Math.round((factionBonuses[def.resource] || 0) * 100);
    const nextLevel = level + 1;
    const isMaxLevel = level >= 10;
    const cost = G.player.buildingUpgradeCosts?.[key];
    const costParts = [];
    if (cost?.food > 0) costParts.push(`${fmt(cost.food)}🌾`);
    if (cost?.wood > 0) costParts.push(`${fmt(cost.wood)}🪵`);
    if (cost?.iron > 0) costParts.push(`${fmt(cost.iron)}⚙️`);

    const bonusLine = !isStorage && bonusPct > 0
      ? `<div class="building-bonus">Territory bonus: +${bonusPct}%</div>`
      : '';
        const currentCapacity = Number(G.player.storageCaps?.food) || 0;
    const buildingDetail = isStorage
      ? `<div class="building-capacity">Capacity: ${fmt(currentCapacity)} each</div>
          <div class="building-next-capacity">Next capacity: ${isMaxLevel ? 'MAX' : `${fmt(G.player.nextStorageCaps?.food || 0)} each`}</div>`
      : `<div class="building-prod">+${totalProd} ${def.resource}/min</div>`;
    const costLine = isMaxLevel ? '' : `<div class="building-cost">Next: ${costParts.join(' + ')}</div>`;

    const card = document.createElement('div');
    card.className = 'building-card';
    card.innerHTML = `
      <div class="building-info">
        <div class="building-name">${def.icon} ${def.name}</div>
        <div class="building-level">Level ${level}</div>
        ${buildingDetail}
        ${bonusLine}
        ${costLine}
      </div>
      <button class="btn-upgrade" onclick="upgradeBuilding('${key}')" ${isMaxLevel ? 'disabled' : ''}>${isMaxLevel ? 'MAX' : `⬆ Lvl ${nextLevel}`}</button>
    `;
    container.appendChild(card);
  });

  document.getElementById('soldiers-count').textContent = G.player.soldiers || 0;
  document.getElementById('train-count').textContent = trainAmount;
  updateTrainingCostDisplay();
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
  trainAmount = Math.max(1, Math.min(getAffordableTrainingAmount(), trainAmount + delta));
  setTroopInput('train-count', trainAmount);
  updateTrainingCostDisplay();
}

async function trainSoldiers() {
  const amount = readTroopInput('train-count', getAffordableTrainingAmount(), 'Training amount');
  if (!amount) return;
  trainAmount = amount;
  try {
    const response = await apiFetch('/game/train-soldiers', {
      method: 'POST',
      body: JSON.stringify({ amount }),
    });
    setGameStateFromSnapshot(response.state);
    renderCity();
    updateResourceBar();
    showToast(`✅ Trained ${response.trained} soldier(s) on the server.`);
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

function setTroopInput(inputId, amount) {
  const input = document.getElementById(inputId);
  if (input) input.value = String(amount);
}

function readTroopInput(inputId, maxAmount, label) {
  const value = document.getElementById(inputId)?.value;
  if (!/^[1-9]\d*$/.test(String(value || '')) || !Number.isSafeInteger(Number(value)) || Number(value) > maxAmount) {
    showToast(`❌ ${label} must be a whole number from 1 to ${maxAmount}.`);
    return 0;
  }
  return Number(value);
}

function getAffordableTrainingAmount() {
  const resources = G.player.resources || {};
  const trainingBonus = Object.values(G.territories).reduce((total, territory) => (
    territory.owner === G.player.faction && String(territory.bonus).toLowerCase() === 'training'
      ? total + Number(territory.bonusValue || 0)
      : total
  ), 0);
  const multiplier = Math.max(0.4, 1 - trainingBonus);
  const maximum = Math.min(5000, Math.floor(Number(resources.food || 0) / (50 * multiplier)), Math.floor(Number(resources.iron || 0) / (25 * multiplier)), Math.floor(Number(resources.manpower || 0) / (20 * multiplier)));
  for (let amount = Math.max(0, maximum); amount > 0; amount -= 1) {
    const cost = calculateTrainingCost(amount, trainingBonus);
    if (cost.food <= Number(resources.food || 0)
      && cost.iron <= Number(resources.iron || 0)
      && cost.manpower <= Number(resources.manpower || 0)) return amount;
  }
  return 0;
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
  const selectedMap = MAP_REGISTRY?.getMap?.(G.season?.mapKey);
  const topology = selectedMap?.topology || WORLD_TOPOLOGY;
  // The selected season map supplies the canonical layout. Server-provided coordinates
  // take priority so rendering still follows the authoritative active-world rows.
  const layout = { ...topology.buildLayout() };
  Object.values(territoriesById).forEach((territory) => {
    if (Number.isFinite(territory.mapX) && Number.isFinite(territory.mapY)
      && (territory.mapX !== 0 || territory.mapY !== 0)) {
      layout[territory.id] = { cx: territory.mapX, cy: territory.mapY };
    }
  });
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

  const { width, height } = topology.LAYOUT_VIEWBOX;
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
  if (territory.protectedUntil && new Date(territory.protectedUntil).getTime() > Date.now()) return false;
  const rally = gameState.rallies?.[id];
  if (rally && rally.attackerFaction !== gameState.player.faction) return false;
  return territory.adj.some((neighborId) => gameState.territories[neighborId] && gameState.territories[neighborId].owner === gameState.player.faction);
}

function showMapView(view) {
  activeMapView = view === 'faction' ? 'faction' : 'world';
  document.getElementById('world-map-view')?.classList.toggle('active', activeMapView === 'world');
  document.getElementById('faction-map-view')?.classList.toggle('active', activeMapView === 'faction');
  const worldTab = document.getElementById('map-view-world-tab');
  const factionTab = document.getElementById('map-view-faction-tab');
  worldTab?.classList.toggle('active', activeMapView === 'world');
  factionTab?.classList.toggle('active', activeMapView === 'faction');
  worldTab?.setAttribute('aria-selected', String(activeMapView === 'world'));
  factionTab?.setAttribute('aria-selected', String(activeMapView === 'faction'));
  if (activeMapView === 'faction') renderFactionMap();
  else renderMap();
}

function buildFactionCityCoordinates(count) {
  const coordinates = [];
  const directions = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  for (let radius = 1; coordinates.length < count; radius += 1) {
    let q = 0;
    let r = -radius;
    for (const [dq, dr] of directions) {
      for (let step = 0; step < radius && coordinates.length < count; step += 1) {
        coordinates.push({ q, r });
        q += dq;
        r += dr;
      }
    }
  }
  return coordinates;
}

function renderFactionMap() {
  const svg = document.getElementById('faction-map-svg');
  if (!svg) return;
  svg.replaceChildren();

  const faction = String(G.factionMap?.faction || G.player?.faction || 'unassigned').toLowerCase();
  const cities = [...(G.factionMap?.cities || [])].sort((a, b) => Number(a.slotIndex) - Number(b.slotIndex));
  const title = document.getElementById('faction-map-title');
  const count = document.getElementById('faction-map-count');
  if (title) title.textContent = `${faction.charAt(0).toUpperCase()}${faction.slice(1)} Homeland`;
  if (count) count.textContent = `${cities.length} ${cities.length === 1 ? 'city' : 'cities'}`;

  const center = { x: 400, y: 310 };
  const hexSize = 30;
  const axialToPoint = ({ q, r }) => ({
    x: center.x + (Math.sqrt(3) * 35 * (q + (r / 2))),
    y: center.y + (1.5 * 35 * r),
  });
  const cityCoordinates = buildFactionCityCoordinates(cities.length);
  const nodes = [{ key: 'capital', q: 0, r: 0, point: center }].concat(cities.map((city, index) => ({
    key: `city-${city.playerId}`,
    city,
    ...cityCoordinates[index],
    point: axialToPoint(cityCoordinates[index]),
  })));
  const nodeByCoordinate = new Map(nodes.map((node) => [`${node.q},${node.r}`, node]));
  const neighborSteps = [[1, 0], [0, 1], [-1, 1]];

  nodes.forEach((node) => {
    neighborSteps.forEach(([dq, dr]) => {
      const neighbor = nodeByCoordinate.get(`${node.q + dq},${node.r + dr}`);
      if (!neighbor) return;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', node.point.x);
      line.setAttribute('y1', node.point.y);
      line.setAttribute('x2', neighbor.point.x);
      line.setAttribute('y2', neighbor.point.y);
      line.setAttribute('class', 'faction-city-link');
      svg.appendChild(line);
    });
  });

  nodes.forEach((node) => {
    const isCapital = node.key === 'capital';
    const isOwnCity = Number(node.city?.playerId) === Number(G.player?.id);
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', createHexPoints(node.point.x, node.point.y, isCapital ? 36 : hexSize));
    polygon.setAttribute('class', `faction-city-tile faction-city-${faction}${isCapital ? ' faction-city-capital' : ''}${isOwnCity ? ' own-city' : ''}`);
    svg.appendChild(polygon);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', node.point.x);
    label.setAttribute('y', node.point.y + (isCapital ? 5 : 3));
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('class', 'faction-city-label');
    label.textContent = isCapital ? '👑 Capital' : String(node.city.username || 'City').slice(0, 14);
    svg.appendChild(label);

    if (isOwnCity) {
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      marker.setAttribute('x', node.point.x);
      marker.setAttribute('y', node.point.y + 18);
      marker.setAttribute('text-anchor', 'middle');
      marker.setAttribute('class', 'faction-city-own-label');
      marker.textContent = 'YOU';
      svg.appendChild(marker);
    }
  });
}

function renderMap() {
  const svg = document.getElementById('map-svg');
  if (!svg) return;
  svg.innerHTML = '';
  const { layout, viewBox } = buildTerritoryLayout(G.territories);
  svg.setAttribute('viewBox', viewBox);
  initializeMobileMap(svg);

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
    poly.setAttribute('class', `territory${selectedTerritoryId === id ? ' selected' : ''}${canAttack(id) ? ' attackable' : ''}${G.rallies[id] ? ' rally-active' : ''}`);
    poly.setAttribute('data-id', id);
    poly.addEventListener('click', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      if (Date.now() < mapView.suppressClickUntil) return;
      selectTerritory(id);
    });
    svg.appendChild(poly);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', y - 5);
    label.setAttribute('fill', '#e6edf3');
    label.setAttribute('font-size', '7.5');
    label.setAttribute('text-anchor', 'middle');
    label.textContent = String(id).toUpperCase();
    svg.appendChild(label);

    const bonusIcon = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    bonusIcon.setAttribute('x', x + 18);
    bonusIcon.setAttribute('y', y - 14);
    bonusIcon.setAttribute('text-anchor', 'middle');
    bonusIcon.setAttribute('class', 'territory-bonus-icon');
    bonusIcon.textContent = getBonusIcon(territory.bonus);
    svg.appendChild(bonusIcon);

    if (territory.capital) {
      const capitalMarker = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      capitalMarker.setAttribute('x', x);
      capitalMarker.setAttribute('y', y - 20);
      capitalMarker.setAttribute('text-anchor', 'middle');
      capitalMarker.setAttribute('class', 'territory-capital-marker');
      capitalMarker.textContent = '👑';
      svg.appendChild(capitalMarker);
    }

    if (G.rallies[id]) {
      const rallyMarker = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      rallyMarker.setAttribute('x', x - 18);
      rallyMarker.setAttribute('y', y - 14);
      rallyMarker.setAttribute('text-anchor', 'middle');
      rallyMarker.setAttribute('class', 'territory-rally-marker');
      rallyMarker.textContent = '⏳';
      svg.appendChild(rallyMarker);
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

function applyMapView(svg) {
  const container = svg.parentElement;
  if (!container) return;
  const bounds = container.getBoundingClientRect();
  const maxX = ((mapView.scale - 1) * bounds.width) / 2;
  const maxY = ((mapView.scale - 1) * bounds.height) / 2;
  mapView.x = Math.max(-maxX, Math.min(maxX, mapView.x));
  mapView.y = Math.max(-maxY, Math.min(maxY, mapView.y));
  svg.style.transformOrigin = 'center';
  svg.style.transform = `translate(${mapView.x}px, ${mapView.y}px) scale(${mapView.scale})`;
}

function resetMapView() {
  mapView.scale = 1;
  mapView.x = 0;
  mapView.y = 0;
  const svg = document.getElementById('map-svg');
  if (svg) applyMapView(svg);
}

function changeMapZoom(delta) {
  if (!window.matchMedia('(max-width: 520px)').matches) return;
  mapView.scale = Math.max(1, Math.min(3, mapView.scale + delta));
  const svg = document.getElementById('map-svg');
  if (svg) applyMapView(svg);
}

function initializeMobileMap(svg) {
  if (mapView.boundSvg === svg) return;
  mapView.boundSvg = svg;
  svg.addEventListener('wheel', (event) => {
    if (window.matchMedia('(max-width: 520px)').matches) return;
    event.preventDefault();
    const container = svg.parentElement;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const oldScale = mapView.scale;
    const newScale = Math.max(1, Math.min(3, oldScale + (event.deltaY < 0 ? 0.2 : -0.2)));
    if (newScale === oldScale) return;
    const ratio = newScale / oldScale;
    const cursorX = event.clientX - bounds.left - (bounds.width / 2);
    const cursorY = event.clientY - bounds.top - (bounds.height / 2);
    mapView.x += (1 - ratio) * (cursorX - mapView.x);
    mapView.y += (1 - ratio) * (cursorY - mapView.y);
    mapView.scale = newScale;
    applyMapView(svg);
  }, { passive: false });
  if (!mapView.resizeBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    mapView.resizeBound = true;
    window.addEventListener('resize', () => {
      const currentSvg = document.getElementById('map-svg');
      if (currentSvg) applyMapView(currentSvg);
    });
  }
  svg.addEventListener('mousedown', (event) => {
    if (!window.matchMedia('(max-width: 520px)').matches && event.button === 0) {
      mapView.desktopPan = {
        svg,
        x: event.clientX,
        y: event.clientY,
        mapX: mapView.x,
        mapY: mapView.y,
        dragged: false,
      };
    }
  });
  if (!mapView.desktopPanBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    mapView.desktopPanBound = true;
    const stopDesktopPan = () => {
      if (!mapView.desktopPan) return;
      if (mapView.desktopPan.dragged) mapView.suppressClickUntil = Date.now() + 400;
      mapView.desktopPan.svg.style.cursor = '';
      mapView.desktopPan = null;
    };
    window.addEventListener('mousemove', (event) => {
      if (!mapView.desktopPan) return;
      if ((event.buttons & 1) === 0) {
        stopDesktopPan();
        return;
      }
      const deltaX = event.clientX - mapView.desktopPan.x;
      const deltaY = event.clientY - mapView.desktopPan.y;
      if (!mapView.desktopPan.dragged && Math.hypot(deltaX, deltaY) <= 5) return;
      mapView.desktopPan.dragged = true;
      mapView.desktopPan.svg.style.cursor = 'grabbing';
      mapView.x = mapView.desktopPan.mapX + deltaX;
      mapView.y = mapView.desktopPan.mapY + deltaY;
      applyMapView(mapView.desktopPan.svg);
      event.preventDefault();
    });
    window.addEventListener('mouseup', stopDesktopPan);
    window.addEventListener('blur', stopDesktopPan);
  }
  svg.addEventListener('pointerdown', (event) => {
    if (!window.matchMedia('(max-width: 520px)').matches || !['touch', 'pen'].includes(event.pointerType)) return;
    if (mapView.pointers.size === 0) {
      mapView.dragged = false;
      mapView.hadMultiplePointers = false;
    }
    svg.setPointerCapture(event.pointerId);
    mapView.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      territoryId: event.target?.dataset?.id || null,
      pointerType: event.pointerType,
    });
    mapView.dragStart = { x: event.clientX, y: event.clientY, mapX: mapView.x, mapY: mapView.y };
    if (mapView.pointers.size === 2) {
      mapView.hadMultiplePointers = true;
      const [first, second] = [...mapView.pointers.values()];
      mapView.pinchStart = { distance: Math.hypot(first.x - second.x, first.y - second.y), scale: mapView.scale };
    }
  });
  svg.addEventListener('pointermove', (event) => {
    if (!mapView.pointers.has(event.pointerId)) return;
    mapView.pointers.set(event.pointerId, {
      ...mapView.pointers.get(event.pointerId),
      x: event.clientX,
      y: event.clientY,
    });
    if (mapView.pointers.size === 2 && mapView.pinchStart) {
      const [first, second] = [...mapView.pointers.values()];
      mapView.scale = Math.max(1, Math.min(3, mapView.pinchStart.scale * (Math.hypot(first.x - second.x, first.y - second.y) / mapView.pinchStart.distance)));
      mapView.dragged = true;
    } else if (mapView.dragStart) {
      const deltaX = event.clientX - mapView.dragStart.x;
      const deltaY = event.clientY - mapView.dragStart.y;
      if (Math.hypot(deltaX, deltaY) > 5) mapView.dragged = true;
      if (mapView.dragged) {
        mapView.x = mapView.dragStart.mapX + deltaX;
        mapView.y = mapView.dragStart.mapY + deltaY;
      }
    }
    if (mapView.dragged) applyMapView(svg);
  });
  svg.addEventListener('pointerup', (event) => {
    const pointer = mapView.pointers.get(event.pointerId);
    if (!pointer) return;
    const shouldSelect = !mapView.dragged
      && !mapView.hadMultiplePointers
      && pointer?.territoryId;
    mapView.pointers.delete(event.pointerId);
    mapView.suppressClickUntil = Date.now() + 400;
    if (mapView.pointers.size === 0) {
      mapView.pinchStart = null;
      mapView.dragStart = null;
      mapView.dragged = false;
      mapView.hadMultiplePointers = false;
    }
    if (shouldSelect) selectTerritory(pointer.territoryId);
  });
  svg.addEventListener('pointercancel', (event) => {
    if (!mapView.pointers.has(event.pointerId)) return;
    mapView.pointers.delete(event.pointerId);
    mapView.suppressClickUntil = Date.now() + 400;
    if (mapView.pointers.size === 0) {
      mapView.pinchStart = null;
      mapView.dragStart = null;
      mapView.dragged = false;
      mapView.hadMultiplePointers = false;
    }
  });
}

let recallSendCount = 1;

function formatRallyCountdown(resolvesAt, now = Date.now()) {
  const totalSeconds = Math.max(0, Math.ceil((new Date(resolvesAt).getTime() - now) / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function renderSelectedRallyStatus() {
  const status = document.getElementById('rally-status');
  if (!status) return;
  const rally = selectedTerritoryId ? G.rallies[selectedTerritoryId] : null;
  const territory = selectedTerritoryId ? G.territories[selectedTerritoryId] : null;
  if (!rally || !territory) {
    status.style.display = 'none';
    return;
  }

  status.style.display = 'flex';
  const isPreparing = rally.phase === 'rally';
  document.getElementById('rally-status-title').textContent = isPreparing
    ? `🤫 Hidden ${ownerLabel(rally.attackerFaction)} rally`
    : `⚔️ ${ownerLabel(rally.attackerFaction)} live battle`;
  const remaining = new Date(rally.resolvesAt).getTime() - Date.now();
  const phaseCountdown = remaining > 0 ? formatRallyCountdown(rally.resolvesAt) : 'Advancing…';
  const nextRound = !isPreparing && rally.nextTickAt
    ? ` · Next losses ${formatRallyCountdown(rally.nextTickAt)}`
    : '';
  document.getElementById('rally-status-countdown').textContent = isPreparing
    ? `Auto-launches in ${phaseCountdown}`
    : `Ends in ${phaseCountdown}${nextRound}`;
  const attackBuff = rally.attackBonus > 0 ? ` (+${Math.round(rally.attackBonus * 100)}% attack damage)` : '';
  const defenseBuff = rally.defenseBonus > 0 ? ` (+${Math.round(rally.defenseBonus * 100)}% counterattack damage)` : '';
  document.getElementById('rally-status-troops').textContent = `Attackers: ${rally.totalAttackers}${attackBuff} · Defenders: ${territory.troops}${defenseBuff}`;
  const personal = document.getElementById('rally-status-personal');
  personal.textContent = rally.attackerFaction === G.player.faction
    ? isPreparing
      ? `Your rally troops: ${rally.myContribution} · Enemy cannot see this rally.`
      : `Your troops still fighting: ${rally.myContribution}`
    : 'Reinforce this territory before the next casualty round.';
  const launchButton = document.getElementById('launch-rally-button');
  if (launchButton) {
    launchButton.style.display = isPreparing && Number(rally.startedBy) === Number(G.player.id) ? 'block' : 'none';
  }
}

function tickRallyCountdowns() {
  if (selectedTerritoryId) renderSelectedRallyStatus();
}

function selectTerritory(id, { preserveTroopInputs = false } = {}) {
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
  const rally = G.rallies[id] || null;
  const protectedMinutes = territory.protectedUntil
    ? Math.max(0, Math.ceil((new Date(territory.protectedUntil).getTime() - Date.now()) / 60000))
    : 0;
  document.getElementById('tp-battle-rule').textContent = territory.capital
    ? 'Protected capital — cannot be attacked or occupied.'
    : rally
      ? rally.phase === 'rally'
        ? 'Hidden rally preparation — starter can launch early'
        : 'Live battle — both sides lose troops every minute'
      : protectedMinutes > 0
        ? `Protected from attacks for ${protectedMinutes} more minutes`
      : territory.owner === 'neutral'
        ? 'Neutral attacks resolve immediately'
        : 'Choose a solo attack or a hidden rally';
  document.getElementById('tp-bonus').textContent = territory.contested
    ? `${formatBonusLabel(territory.bonus, territory.bonusValue)} — inactive during battle`
    : formatBonusLabel(territory.bonus, territory.bonusValue);
  document.getElementById('tp-neighbors').textContent = (territory.adj || []).map((neighborId) => G.territories[neighborId]?.name || neighborId).join(', ');

  const attackSection = document.getElementById('attack-section');
  const defendSection = document.getElementById('defend-section');
  const recallSection = document.getElementById('recall-section');
  const attackLabel = document.getElementById('attack-action-label');
  const attackButton = document.getElementById('attack-action-button');
  const rallyButton = document.getElementById('start-rally-button');
  renderSelectedRallyStatus();
  if (canAttack(id)) {
    attackSection.style.display = 'block';
    if (attackLabel) attackLabel.textContent = rally
      ? rally.phase === 'rally' ? '🤫 Hidden Rally' : '⚔️ Reinforce Attack'
      : '⚔️ Attack';
    if (attackButton) attackButton.textContent = rally
      ? rally.phase === 'rally' ? '🤫 Add Troops to Rally' : '⚔️ Reinforce Attack'
      : territory.owner === 'neutral' ? '⚔️ Attack Territory' : '⚔️ Start Solo Attack';
    if (rallyButton) rallyButton.style.display = !rally && territory.owner !== 'neutral' ? 'block' : 'none';
    defendSection.style.display = 'none';
    if (recallSection) recallSection.style.display = 'none';
    if (!preserveTroopInputs) {
      attackSendCount = Math.max(1, Math.min(10, Number(G.player.soldiers) || 1));
      setTroopInput('attack-count', attackSendCount);
    }
  } else if (territory.owner === G.player.faction) {
    attackSection.style.display = 'none';
    if (rallyButton) rallyButton.style.display = 'none';
    defendSection.style.display = 'block';
    if (!preserveTroopInputs) {
      defendSendCount = Math.max(1, Math.min(10, Number(G.player.soldiers) || 1));
      setTroopInput('defend-count', defendSendCount);
    }
    if (recallSection) {
      if (stationed > 0 && rally?.phase !== 'active') {
        recallSection.style.display = 'block';
        if (!preserveTroopInputs) {
          recallSendCount = Math.max(1, Math.min(1, stationed));
          setTroopInput('recall-count', recallSendCount);
        }
      } else {
        recallSection.style.display = 'none';
      }
    }
  } else {
    attackSection.style.display = 'none';
    if (rallyButton) rallyButton.style.display = 'none';
    defendSection.style.display = 'none';
    if (recallSection) recallSection.style.display = 'none';
  }
}

function closeTerritoryPanel() {
  selectedTerritoryId = null;
  const panel = document.getElementById('territory-panel');
  if (panel) panel.style.display = 'none';
  renderMap();
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
    attack: `🗡️ +${pct}% Attack Strength`,
    defense: `🛡️ +${pct}% Defense Strength`,
    fortress: '🏰 Fortress — +1 Troop/min up to 250 city reserve',
    storage: `📦 +${pct}% Storage`,
    resource: `✨ +${pct}% All Resources`,
    none: '—',
  };
  return map[type] || (type ? type : '—');
}

function getBonusIcon(bonusType) {
  return {
    food: '🌾', wood: '🪵', iron: '⚙️', manpower: '👥', training: '⚔️', storage: '📦', fortress: '🏰', resource: '✨', attack: '🗡️', defense: '🛡️',
  }[String(bonusType || '').toLowerCase()] || '';
}

function changeAttack(delta) {
  const maxAmount = Math.max(1, Number(G.player.soldiers) || 1);
  if (delta === 'max') {
    attackSendCount = maxAmount;
  } else if (delta === 'half') {
    attackSendCount = Math.max(1, Math.floor(maxAmount / 2));
  } else {
    attackSendCount = Math.max(1, Math.min(maxAmount, attackSendCount + delta));
  }
  setTroopInput('attack-count', attackSendCount);
}

async function launchAttack(mode = 'solo') {
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
  const soldiers = readTroopInput('attack-count', Number(G.player.soldiers || 0), 'Attack amount');
  if (!soldiers) return;
  attackSendCount = soldiers;

  try {
    const response = await apiFetch('/game/attack', {
      method: 'POST',
      body: JSON.stringify({ territoryId: selectedTerritoryId, soldiers, mode }),
    });
    setGameStateFromSnapshot(response.state);
    const result = response.outcome;
    if (result) {
      document.getElementById('battle-result-text').innerHTML = result.victory
        ? `<span class="result-victory">⚔️ VICTORY!</span><br>Territory captured.<br>Attackers left: ${result.attackersRemaining}`
        : `<span class="result-defeat">💀 HELD!</span><br>Attack failed.<br>Defenders left: ${result.defendersRemaining}`;
      document.getElementById('battle-popup').style.display = 'block';
    }
    if (response.rally) {
      showToast(response.rallyCreated
        ? response.rally.phase === 'rally'
          ? '🤫 Hidden rally started. Allies have 10 minutes to join.'
          : '⚔️ Live battle started. Casualties begin in one minute.'
        : `⚔️ ${response.sent} troops added.`);
    } else {
      showToast(result?.victory ? '✅ Territory captured.' : '⚠️ Neutral attack resolved by troop count.');
    }
    renderCity();
    renderMap();
    updateResourceBar();
    if (selectedTerritoryId) selectTerritory(selectedTerritoryId);
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

async function launchPreparedRally() {
  if (!selectedTerritoryId) return;
  try {
    const response = await apiFetch('/game/launch-rally', {
      method: 'POST',
      body: JSON.stringify({ territoryId: selectedTerritoryId }),
    });
    setGameStateFromSnapshot(response.state);
    showToast('⚔️ Rally launched. The live battle has begun.');
    renderMap();
    selectTerritory(selectedTerritoryId);
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

function changeDefend(delta) {
  const maxAmount = Math.max(1, Number(G.player.soldiers) || 1);
  if (delta === 'max') {
    defendSendCount = maxAmount;
  } else if (delta === 'half') {
    defendSendCount = Math.max(1, Math.floor(maxAmount / 2));
  } else {
    defendSendCount = Math.max(1, Math.min(maxAmount, defendSendCount + delta));
  }
  setTroopInput('defend-count', defendSendCount);
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
  const troops = readTroopInput('defend-count', Number(G.player.soldiers || 0), 'Defender amount');
  if (!troops) return;
  defendSendCount = troops;

  try {
    const response = await apiFetch('/game/defend', {
      method: 'POST',
      body: JSON.stringify({ territoryId: selectedTerritoryId, troops }),
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
  } else if (delta === 'half') {
    recallSendCount = Math.max(1, Math.floor(maxAmount / 2));
  } else {
    recallSendCount = Math.max(1, Math.min(maxAmount, recallSendCount + delta));
  }
  setTroopInput('recall-count', recallSendCount);
}

async function recallDefenders() {
  if (!selectedTerritoryId) {
    showToast('❌ Select a territory first.');
    return;
  }
  const stationed = Number((G.player.stationedTroops || {})[selectedTerritoryId] || 0);
  const troops = readTroopInput('recall-count', stationed, 'Recall amount');
  if (!troops) return;
  recallSendCount = troops;

  try {
    const response = await apiFetch('/game/recall-defenders', {
      method: 'POST',
      body: JSON.stringify({ territoryId: selectedTerritoryId, troops }),
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

function closeBattlePopup() {
  document.getElementById('battle-popup').style.display = 'none';
}

// ===================== ACTIVITY FEED =====================

function factionIcon(faction) {
  return { blue: '🔵', red: '🔴', green: '🟢', neutral: '⚪' }[faction] || '❓';
}

const ACTIVITY_STAT_LABELS = {
  kills: 'Kills',
  losses: 'Losses',
  battles_joined: 'Battles Joined',
  battles_won: 'Battles Won',
  successful_defences: 'Successful Defences',
  territories_captured: 'Territories Captured',
  retakes: 'Retakes',
  reinforcement_troops_sent: 'Reinforcement Troops Sent',
};

function showActivityTab(name) {
  if (!['feed', 'rankings', 'my-stats', 'seasons'].includes(name)) return;
  activeActivityTab = name;
  document.querySelectorAll('.activity-tab').forEach((tab) => {
    const selected = tab.id === `activity-tab-${name}`;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  document.querySelectorAll('.activity-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `activity-panel-${name}`);
  });
  renderActivity();
}

function renderRankings(container, rankings) {
  container.replaceChildren();
  Object.entries(ACTIVITY_STAT_LABELS).forEach(([key, label]) => {
    const section = document.createElement('section');
    section.className = 'activity-ranking-section';
    const title = document.createElement('h3');
    title.className = 'activity-ranking-title';
    title.textContent = label;
    section.appendChild(title);
    (rankings[key] || []).slice(0, 5).forEach((player, index) => {
      const row = document.createElement('div');
      row.className = 'activity-ranking-row';
      const rank = document.createElement('span');
      rank.textContent = `#${index + 1}`;
      const name = document.createElement('span');
      name.textContent = `${factionIcon(player.faction)} ${player.username}`;
      const value = document.createElement('span');
      value.className = 'activity-ranking-value';
      value.textContent = fmt(player[key]);
      row.append(rank, name, value);
      section.appendChild(row);
    });
    container.appendChild(section);
  });
}

function renderMyStats(container, stats) {
  container.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'activity-stats-grid';
  Object.entries(ACTIVITY_STAT_LABELS).forEach(([key, label]) => {
    const item = document.createElement('div');
    item.className = 'activity-stat';
    const value = document.createElement('span');
    value.className = 'activity-stat-value';
    value.textContent = fmt(stats[key]);
    const name = document.createElement('span');
    name.className = 'activity-stat-label';
    name.textContent = label;
    item.append(value, name);
    grid.appendChild(item);
  });
  container.appendChild(grid);
}

function getBattleBonusSummary(appliedBonuses) {
  let bonuses = appliedBonuses;
  if (typeof bonuses === 'string') {
    try {
      bonuses = JSON.parse(bonuses);
    } catch {
      bonuses = {};
    }
  }
  const attack = Math.round(Math.max(0, Number(bonuses?.attackBonus) || 0) * 100);
  const defense = Math.round(Math.max(0, Number(bonuses?.defenseBonus) || 0) * 100);
  return `Damage bonuses: Attack +${attack}% · Counterattack +${defense}%`;
}

async function renderActivity() {
  const container = document.getElementById('activity-feed');
  if (!container) return;
  try {
    if (activeActivityTab === 'seasons') {
      await renderSeasonHistory();
      return;
    }
    if (activeActivityTab !== 'feed') {
      const data = await apiFetch('/game/activity-stats');
      if (activeActivityTab === 'rankings') {
        renderRankings(document.getElementById('activity-rankings'), data.rankings || {});
      } else {
        renderMyStats(document.getElementById('activity-my-stats'), data.myStats || {});
      }
      return;
    }
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

      const bonuses = document.createElement('div');
      bonuses.className = 'activity-losses';
      bonuses.textContent = getBattleBonusSummary(b.applied_bonuses);

      const time = document.createElement('div');
      time.className = 'activity-time';
      time.textContent = ts;

      entry.append(headline, result, losses, bonuses, time);
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
        <span class="admin-badge">🗺️ ${s.mapName || 'Three Frontiers'}</span>
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
  if (!confirm('Force-finish the current season right now?\n\nThis finalizes scores, awards prestige to the winner, resets seasonal progress, and opens the next season’s 24-hour registration window.')) return;
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
    await loadGame();
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

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeInfoModal();
        closeChangelogModal();
      }
    });

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
    const trainInput = document.getElementById('train-count');
    if (trainInput) trainInput.addEventListener('input', updateTrainingCostDisplay);
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
        // Smooth HH:MM:SS countdown to the current season end; the season data
        // itself only refreshes with the 60s background poll above.
        setInterval(tickScoreboardCountdown, 1000);
        setInterval(tickSeasonGateCountdown, 1000);
        setInterval(tickRallyCountdowns, 1000);
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
    getBattleBonusSummary,
    renderMapLegend,
    mapTerritories,
    mapRallies,
    calculateTrainingCost,
    getAffordableTrainingAmount,
    loadChangelog,
    renderChangelogEntries,
    openChangelogModal,
    updateTrainingCostDisplay,
    trainSoldiers,
    selectTerritory,
    restoreSavedScreen,
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
    renderMap,
    initializeMobileMap,
    renderRankings,
    closeTerritoryPanel,
    changeAttack,
    changeDefend,
    changeRecall,
    launchAttack,
    launchPreparedRally,
    formatCountdown,
    formatRallyCountdown,
    tickRallyCountdowns,
    formatScoreboardFaction,
    renderScoreboard,
    shouldShowSeasonGate,
    renderSeasonGate,
    tickSeasonGateCountdown,
    joinCurrentSeason,
    adminStartSeasonNow,
    apiFetch,
    ensureSession,
    fetchCurrentUser,
    loadGame,
    refreshGameStateInBackground,
    scheduleRealtimeRefresh,
    connectRealtime,
    disconnectRealtime,
    getToken,
    setToken,
  };
}
