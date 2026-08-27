/* ====================================================
   TERRITORY CONQUEST — authoritative client wrapper
   The browser may only render and submit actions.
   All critical state is calculated and stored on the server.
   ==================================================== */

const AUTH_STORAGE_KEY = 'trying_game_token';
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
};

let G = structuredClone(DEFAULT_STATE);
let selectedTerritoryId = null;
let attackSendCount = 10;
let trainAmount = 1;

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
      adj: Array.isArray(territory.neighbors) ? territory.neighbors : [],
      fortress: !!territory.fortress,
      capital: !!territory.capital,
    };
  });
  return entryMap;
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

  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function ensureSession() {
  const token = getToken();
  if (!token) {
    throw new Error('No active session.');
  }

  try {
    const user = await apiFetch('/me');
    if (user && user.username) return user;
  } catch (error) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    throw new Error('Session expired. Please log in again.');
  }

  return null;
}

let selectedAuthFaction = 'blue';

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

function setFactionChoice(faction) {
  selectedAuthFaction = faction;
  document.querySelectorAll('.faction-choice-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.faction === faction);
  });
}

function setGameShellVisible(isVisible) {
  const shell = document.getElementById('game-shell');
  if (shell) shell.style.display = isVisible ? 'block' : 'none';
}

function hideAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  if (authScreen) authScreen.style.display = 'none';
  setGameShellVisible(true);
  showScreen('city');
}

function showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  if (authScreen) authScreen.style.display = 'flex';
  setGameShellVisible(false);
  document.querySelectorAll('.screen').forEach((screen) => screen.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach((button) => button.classList.remove('active'));
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
  if (!password || password.length < 6) {
    message.textContent = 'Password must be at least 6 characters.';
    return;
  }

  if (isRegister) {
    if (password !== confirmPassword) {
      message.textContent = 'Passwords do not match.';
      return;
    }
    if (!['blue', 'red', 'green'].includes(selectedAuthFaction)) {
      message.textContent = 'Please choose a faction.';
      return;
    }
  }

  try {
    const path = isRegister ? '/register' : '/login';
    const payload = await apiFetch(path, {
      method: 'POST',
      body: JSON.stringify(isRegister ? { username, password, faction: selectedAuthFaction } : { username, password }),
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
  setFactionChoice('blue');
  showAuthScreen();
  setAuthMode('login');
  showToast('🚪 Logged out.');
}

async function loadGame() {
  try {
    const user = await ensureSession();
    if (!user) {
      showAuthScreen();
      return;
    }

    hideAuthScreen();

    const payload = await apiFetch('/game/state');
    const territories = mapTerritories(payload.world.territories || payload.territories || []);

    if (!payload.player?.faction) {
      showAuthScreen();
      setAuthMode('register');
      const message = document.getElementById('auth-message');
      if (message) message.textContent = 'Choose your faction to begin playing.';
      const panel = document.getElementById('auth-faction-panel');
      if (panel) panel.style.display = 'block';
      const confirm = document.getElementById('auth-confirm-password');
      if (confirm) confirm.style.display = 'none';
      return;
    }

    G = {
      player: {
        ...(payload.player || {}),
        resources: payload.player?.resources || { food: 0, wood: 0, iron: 0, manpower: 0 },
        buildings: payload.player?.buildings || { farm: 1, lumbermill: 1, ironmine: 1, barracks: 1 },
        production: payload.player?.production || { food: 0, wood: 0, iron: 0, manpower: 0 },
      },
      territories,
      attackTarget: '',
      attackContributions: {},
    };

    renderCity();
    renderMap();
    updateResourceBar();
  } catch (error) {
    console.error('Failed to load authoritative game state:', error);
    showToast('⚠️ Could not load the server state.');
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
  if (name === 'map') renderMap();
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
  const container = document.getElementById('building-list');
  container.innerHTML = '';

  const defs = {
    farm: { name: 'Farm', icon: '🌾', resource: 'food', production: 5 },
    lumbermill: { name: 'Lumber Mill', icon: '🪵', resource: 'wood', production: 4 },
    ironmine: { name: 'Iron Mine', icon: '⚙️', resource: 'iron', production: 3 },
    barracks: { name: 'Barracks', icon: '🏟', resource: 'manpower', production: 2 },
  };

  Object.entries(defs).forEach(([key, def]) => {
    const level = Number(buildings[key] || 1);
    const prod = def.production * level;
    const card = document.createElement('div');
    card.className = 'building-card';
    card.innerHTML = `
      <div class="building-info">
        <div class="building-name">${def.icon} ${def.name}</div>
        <div class="building-level">Level ${level}</div>
        <div class="building-prod">+${prod} ${def.resource}/tick</div>
      </div>
      <button class="btn-upgrade" onclick="upgradeBuilding('${key}')">⬆ Lvl ${level + 1}</button>
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
    G = {
      ...G,
      player: response.state.player,
      territories: mapTerritories(response.state.world.territories),
    };
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
    G = {
      ...G,
      player: response.state.player,
      territories: mapTerritories(response.state.world.territories),
    };
    renderCity();
    updateResourceBar();
    showToast(`✅ Trained ${response.trained} soldier(s) on the server.`);
  } catch (error) {
    showToast(`❌ ${error.message}`);
  }
}

const TERRITORY_SHAPES = {
  t3: '0,0 120,0 118,76 0,74',
  t2: '0,74 118,76 122,150 0,148',
  t1: '0,148 122,150 120,224 0,222',
  t4: '0,222 120,224 116,298 0,296',
  t8: '0,296 116,298 120,370 0,370',
  t7: '120,0 240,0 242,72 118,76',
  t6: '118,76 242,72 238,146 122,150',
  t5: '122,150 238,146 244,220 120,224',
  t9: '120,224 244,220 240,294 116,298',
  t14: '116,298 240,294 240,370 120,370',
  t12: '240,0 360,0 360,74 242,72',
  t11: '242,72 360,74 360,148 238,146',
  t10: '238,146 360,148 360,222 244,220',
  t15: '244,220 360,222 360,296 240,294',
  t13: '240,294 360,296 360,370 240,370',
};

const TERRITORY_LABEL = {
  t3: [60, 37], t7: [182, 36], t12: [300, 36],
  t2: [61, 111], t6: [180, 110], t11: [299, 110],
  t1: [61, 185], t5: [183, 185], t10: [300, 185],
  t4: [60, 259], t9: [183, 258], t15: [302, 258],
  t8: [60, 333], t14: [182, 333], t13: [300, 333],
};

const FACTION_FILL = { blue: '#1a4d8f', red: '#7a1a1a', green: '#1a5c2a' };
const FACTION_STROKE = { blue: '#2e78e0', red: '#d93030', green: '#2ea840' };

function canAttack(id) {
  const territory = G.territories[id];
  if (!territory || territory.owner === G.player.faction) return false;
  return territory.adj.some((neighborId) => G.territories[neighborId] && G.territories[neighborId].owner === G.player.faction);
}

function renderMap() {
  const svg = document.getElementById('map-svg');
  svg.innerHTML = '';
  Object.entries(G.territories).forEach(([id, territory]) => {
    const shape = TERRITORY_SHAPES[id];
    if (!shape) return;

    const fill = FACTION_FILL[territory.owner] || '#333';
    const stroke = FACTION_STROKE[territory.owner] || '#888';
    const [x, y] = TERRITORY_LABEL[id] || [180, 185];

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', shape);
    poly.setAttribute('fill', fill);
    poly.setAttribute('stroke', selectedTerritoryId === id ? '#fff' : stroke);
    poly.setAttribute('stroke-width', selectedTerritoryId === id ? '3' : '1.5');
    poly.setAttribute('data-id', id);
    poly.addEventListener('click', () => selectTerritory(id));
    svg.appendChild(poly);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', y - 6);
    label.setAttribute('fill', '#e6edf3');
    label.setAttribute('font-size', '8.5');
    label.textContent = territory.name;
    svg.appendChild(label);

    const troops = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    troops.setAttribute('x', x);
    troops.setAttribute('y', y + 8);
    troops.setAttribute('fill', '#e3b341');
    troops.setAttribute('font-size', '10');
    troops.textContent = '⚔' + territory.troops;
    svg.appendChild(troops);
  });
}

function selectTerritory(id) {
  selectedTerritoryId = id;
  const territory = G.territories[id];
  if (!territory) return;

  renderMap();
  document.getElementById('territory-panel').style.display = 'block';
  document.getElementById('tp-name').textContent = territory.name;
  document.getElementById('tp-owner').textContent = ownerLabel(territory.owner);
  document.getElementById('tp-troops').textContent = territory.troops;
  document.getElementById('tp-bonus').textContent = territory.bonus;
  document.getElementById('tp-neighbors').textContent = (territory.adj || []).map((neighborId) => G.territories[neighborId]?.name || neighborId).join(', ');

  const attackSection = document.getElementById('attack-section');
  if (canAttack(id)) {
    attackSection.style.display = 'block';
    attackSendCount = Math.max(1, Math.min(10, Number(G.player.soldiers) || 1));
    document.getElementById('attack-count').textContent = attackSendCount;
  } else {
    attackSection.style.display = 'none';
  }
}

function ownerLabel(owner) {
  return { blue: '🔵 Blue', red: '🔴 Red', green: '🟢 Green', neutral: '⚪ Neutral' }[owner] || owner;
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
  if (!canAttack(selectedTerritoryId)) {
    showToast('❌ This target cannot be attacked from your faction.');
    return;
  }

  try {
    const response = await apiFetch('/game/attack', {
      method: 'POST',
      body: JSON.stringify({ territoryId: selectedTerritoryId, soldiers: attackSendCount }),
    });
    G = {
      ...G,
      player: response.state.player,
      territories: mapTerritories(response.state.world.territories),
    };
    showToast(`✅ ${attackSendCount} soldiers sent to the server.`);
    renderCity();
    renderMap();
    updateResourceBar();
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
    G = {
      ...G,
      player: response.state.player,
      territories: mapTerritories(response.state.world.territories),
    };

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

function aiTick() {
  // purposefully no client-side simulation; the backend owns all gameplay state
}

function autoSave() {
  // no browser-owned game save; only auth token remains client-side
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
    const authForm = document.getElementById('auth-form');
    const authModeButtons = document.querySelectorAll('.auth-mode-btn');

    authModeButtons.forEach((button) => {
      button.addEventListener('click', () => setAuthMode(button.dataset.mode));
    });

    if (authForm) {
      authForm.addEventListener('submit', submitAuth);
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
        setInterval(async () => {
          try {
            const payload = await apiFetch('/game/state');
            G = {
              ...G,
              player: payload.player,
              territories: mapTerritories(payload.world.territories),
            };
            renderCity();
            renderMap();
            updateResourceBar();
          } catch (error) {
            console.warn('Background refresh failed:', error.message);
          }
        }, 5000);
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
    mapTerritories,
    canAttack,
    ownerLabel,
  };
}
