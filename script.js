/* ====================================================
   TERRITORY CONQUEST — script.js
   Beginner-friendly, heavily commented game logic
   ==================================================== */

// ============================================================
// SECTION 1 — GAME STATE
// Everything the game "remembers" is stored in this object.
// We save/load it from localStorage so progress persists.
// ============================================================

const DEFAULT_STATE = {
  // --- Resources ---
  food:     200,
  wood:     200,
  iron:     100,
  manpower: 50,
  soldiers: 10,   // soldiers waiting in the city

  // --- Buildings (level 0 = not built; upgrades start at level 1) ---
  // Each building produces a resource per tick
  buildings: {
    farm:       { level: 1, name: "Farm",        icon: "🌾", resource: "food",     baseProd: 5,  upgradeCost: { food:50, wood:80,  iron:0   } },
    lumbermill: { level: 1, name: "Lumber Mill",  icon: "🪵", resource: "wood",     baseProd: 4,  upgradeCost: { food:40, wood:0,   iron:60  } },
    ironmine:   { level: 1, name: "Iron Mine",    icon: "⚙️", resource: "iron",     baseProd: 3,  upgradeCost: { food:30, wood:100, iron:0   } },
    barracks:   { level: 1, name: "Barracks",     icon: "🏟", resource: "manpower", baseProd: 2,  upgradeCost: { food:80, wood:60,  iron:80  } },
  },

  // --- Territories ---
  // Each territory has: name, owner (blue/red/green), troops, bonus type,
  // and a list of adjacent territory ids for connectivity checks
  territories: {
    // Player starts in the center-ish with a small cluster
    t1:  { name: "Ironholt",    owner: "blue",  troops: 20, bonus: "iron +2",    adj: ["t2","t4","t5"] },
    t2:  { name: "Greenfields", owner: "blue",  troops: 15, bonus: "food +3",    adj: ["t1","t3","t6"] },
    t3:  { name: "Millwood",    owner: "blue",  troops: 10, bonus: "wood +3",    adj: ["t2","t7"] },
    t4:  { name: "Steelpass",   owner: "red",   troops: 18, bonus: "iron +3",    adj: ["t1","t5","t8","t9"] },
    t5:  { name: "Dustplain",   owner: "red",   troops: 12, bonus: "none",       adj: ["t1","t4","t6","t10"] },
    t6:  { name: "Ashvale",     owner: "green", troops: 14, bonus: "food +2",    adj: ["t2","t5","t7","t11"] },
    t7:  { name: "Pinegrove",   owner: "green", troops: 16, bonus: "wood +2",    adj: ["t3","t6","t12"] },
    t8:  { name: "Redkeep",     owner: "red",   troops: 25, bonus: "troops +5",  adj: ["t4","t9","t13"] },
    t9:  { name: "Cragfort",    owner: "red",   troops: 20, bonus: "none",       adj: ["t4","t5","t8","t14"] },
    t10: { name: "Stonemarsh",  owner: "red",   troops: 18, bonus: "iron +1",    adj: ["t5","t9","t15"] },
    t11: { name: "Fernhaven",   owner: "green", troops: 22, bonus: "food +4",    adj: ["t6","t12","t15"] },
    t12: { name: "Evermoore",   owner: "green", troops: 19, bonus: "wood +4",    adj: ["t7","t11","t13"] },
    t13: { name: "Duskwall",    owner: "green", troops: 28, bonus: "troops +5",  adj: ["t8","t12","t14"] },
    t14: { name: "Grimhaven",   owner: "red",   troops: 24, bonus: "none",       adj: ["t9","t13","t15"] },
    t15: { name: "Thornwatch",  owner: "green", troops: 30, bonus: "troops +8",  adj: ["t10","t11","t14"] },
  },

  // --- Faction data ---
  attackTarget: "",   // territory id chosen by leader
  soldiers_on_map: 0, // soldiers currently deployed to territories (informational)

  // --- Leaderboard (fake) ---
  leaderboard: [
    { name: "You",       kills: 0,  territories: 0 },
    { name: "Zara",      kills: 47, territories: 3 },
    { name: "Korvax",    kills: 35, territories: 2 },
    { name: "Lira",      kills: 28, territories: 1 },
    { name: "Draxis",    kills: 19, territories: 1 },
    { name: "Syndra",    kills: 12, territories: 0 },
  ],
};

// The live game state — will be overwritten by loadGame() if save exists
let G = deepClone(DEFAULT_STATE);

// ============================================================
// SECTION 2 — UTILITY FUNCTIONS
// ============================================================

/** Deep-clone an object (simple JSON method — fine for plain data) */
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

/** Show a temporary pop-up message at the bottom of the screen */
function showToast(msg) {
  // Remove any existing toast first
  const old = document.querySelector(".toast");
  if (old) old.remove();

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = msg;
  document.body.appendChild(toast);

  // Start fading out after 1.8 s, then remove
  setTimeout(() => toast.classList.add("fade"), 1800);
  setTimeout(() => toast.remove(), 2400);
}

/** Format a number nicely (1250 → 1.25k for large values) */
function fmt(n) {
  n = Math.floor(n);
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// ============================================================
// SECTION 3 — SAVE / LOAD (localStorage)
// ============================================================

function saveGame() {
  localStorage.setItem("tc_save", JSON.stringify(G));
  showToast("✅ Game saved!");
}

function loadGame() {
  const raw = localStorage.getItem("tc_save");
  if (raw) {
    try {
      // Merge saved state over defaults so new fields added in updates still appear
      const saved = JSON.parse(raw);
      G = Object.assign(deepClone(DEFAULT_STATE), saved);
      // Also deep-merge nested objects
      G.buildings   = Object.assign(deepClone(DEFAULT_STATE.buildings),   saved.buildings   || {});
      G.territories = Object.assign(deepClone(DEFAULT_STATE.territories), saved.territories || {});
    } catch (e) {
      console.warn("Save data corrupt, using defaults.", e);
      G = deepClone(DEFAULT_STATE);
    }
  }
}

// ============================================================
// SECTION 4 — SCREEN NAVIGATION
// ============================================================

/** Switch between city / map / faction screens */
function showScreen(name) {
  // Hide all screens
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  // Hide all nav active states
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));

  // Show the chosen screen
  document.getElementById("screen-" + name).classList.add("active");
  document.getElementById("nav-" + name).classList.add("active");

  // Refresh the relevant screen's data
  if (name === "city")    renderCity();
  if (name === "map")     renderMap();
  if (name === "faction") renderFaction();
}

// ============================================================
// SECTION 5 — RESOURCE PRODUCTION TICK
// ============================================================

/** Run this every N milliseconds to add resources based on building levels */
const TICK_MS = 3000; // 3 seconds per tick

function resourceTick() {
  const b = G.buildings;

  // Each building produces: baseProd × level per tick
  G.food     += b.farm.baseProd       * b.farm.level;
  G.wood     += b.lumbermill.baseProd * b.lumbermill.level;
  G.iron     += b.ironmine.baseProd   * b.ironmine.level;
  G.manpower += b.barracks.baseProd   * b.barracks.level;

  // Cap resources at a reasonable maximum to prevent overflow
  G.food     = Math.min(G.food,     9999);
  G.wood     = Math.min(G.wood,     9999);
  G.iron     = Math.min(G.iron,     9999);
  G.manpower = Math.min(G.manpower, 9999);

  // Update the always-visible resource bar
  updateResourceBar();
}

function updateResourceBar() {
  document.getElementById("res-food").textContent     = fmt(G.food);
  document.getElementById("res-wood").textContent     = fmt(G.wood);
  document.getElementById("res-iron").textContent     = fmt(G.iron);
  document.getElementById("res-manpower").textContent = fmt(G.manpower);
}

// ============================================================
// SECTION 6 — CITY SCREEN
// ============================================================

let trainAmount = 1; // how many soldiers to train at once

function renderCity() {
  renderBuildings();
  document.getElementById("soldiers-count").textContent = G.soldiers;
  document.getElementById("train-count").textContent    = trainAmount;
}

/** Rebuild the building card list from G.buildings */
function renderBuildings() {
  const container = document.getElementById("building-list");
  container.innerHTML = ""; // clear old cards

  Object.entries(G.buildings).forEach(([id, b]) => {
    const prod = b.baseProd * b.level;
    const cost = upgradeCostAt(b, b.level + 1);

    const card = document.createElement("div");
    card.className = "building-card";
    card.innerHTML = `
      <div class="building-info">
        <div class="building-name">${b.icon} ${b.name}</div>
        <div class="building-level">Level ${b.level}</div>
        <div class="building-prod">+${prod} ${b.resource}/tick</div>
        <div class="building-cost">Upgrade: 🌾${cost.food} 🪵${cost.wood} ⚙️${cost.iron}</div>
      </div>
      <button class="btn-upgrade" onclick="upgradeBuilding('${id}')">⬆ Upgrade</button>
    `;
    container.appendChild(card);
  });
}

/** Calculate the upgrade cost at a given level (costs scale with level) */
function upgradeCostAt(b, level) {
  const mult = level; // each upgrade costs level × base cost
  return {
    food: b.upgradeCost.food * mult,
    wood: b.upgradeCost.wood * mult,
    iron: b.upgradeCost.iron * mult,
  };
}

/** Attempt to upgrade a building, spending resources */
function upgradeBuilding(id) {
  const b    = G.buildings[id];
  const cost = upgradeCostAt(b, b.level + 1);

  if (G.food < cost.food || G.wood < cost.wood || G.iron < cost.iron) {
    showToast("❌ Not enough resources to upgrade!");
    return;
  }

  G.food -= cost.food;
  G.wood -= cost.wood;
  G.iron -= cost.iron;
  b.level += 1;

  showToast(`✅ ${b.name} upgraded to level ${b.level}!`);
  renderCity();
  updateResourceBar();
}

/** Change how many soldiers to train (clamp to at least 1) */
function changeTrain(delta) {
  trainAmount = Math.max(1, trainAmount + delta);
  document.getElementById("train-count").textContent = trainAmount;
}

/** Spend resources to add soldiers */
function trainSoldiers() {
  const costFood     = 50 * trainAmount;
  const costIron     = 20 * trainAmount;
  const costManpower = 1  * trainAmount;

  if (G.food < costFood || G.iron < costIron || G.manpower < costManpower) {
    showToast("❌ Not enough resources to train soldiers!");
    return;
  }

  G.food     -= costFood;
  G.iron     -= costIron;
  G.manpower -= costManpower;
  G.soldiers += trainAmount;

  showToast(`✅ Trained ${trainAmount} soldier(s)!`);
  renderCity();
  updateResourceBar();
}

// ============================================================
// SECTION 7 — WORLD MAP (SVG)
// ============================================================

// Pixel positions (cx, cy) for each territory centre on a 360×400 viewBox
const TERRITORY_POS = {
  t1:  [180, 200], // centre — player start
  t2:  [130, 170],
  t3:  [90,  130],
  t4:  [240, 170],
  t5:  [200, 240],
  t6:  [150, 260],
  t7:  [100, 210],
  t8:  [310, 130],
  t9:  [280, 200],
  t10: [250, 290],
  t11: [130, 320],
  t12: [80,  290],
  t13: [200, 130],
  t14: [330, 270],
  t15: [200, 360],
};

// Colour map for factions
const FACTION_COLOUR = { blue: "#1f6feb", red: "#c0392b", green: "#27ae60" };
const FACTION_HOVER  = { blue: "#388bfd", red: "#e74c3c", green: "#3fb950" };

let selectedTerritoryId = null; // currently tapped territory
let attackSendCount = 10;       // soldiers to send in next attack

function renderMap() {
  const svg = document.getElementById("map-svg");
  svg.innerHTML = ""; // clear old elements

  // --- Draw connection lines first (so they appear under circles) ---
  const drawn = new Set();
  Object.entries(G.territories).forEach(([id, ter]) => {
    ter.adj.forEach(adjId => {
      const key = [id, adjId].sort().join("-"); // deduplicate A-B and B-A
      if (drawn.has(key)) return;
      drawn.add(key);

      const [x1, y1] = TERRITORY_POS[id];
      const [x2, y2] = TERRITORY_POS[adjId];
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", x1); line.setAttribute("y1", y1);
      line.setAttribute("x2", x2); line.setAttribute("y2", y2);
      line.setAttribute("stroke", "#30363d");
      line.setAttribute("stroke-width", "2");
      svg.appendChild(line);
    });
  });

  // --- Draw territory circles ---
  Object.entries(G.territories).forEach(([id, ter]) => {
    const [cx, cy] = TERRITORY_POS[id];
    const colour   = FACTION_COLOUR[ter.owner];
    const isSelected = (id === selectedTerritoryId);

    // Circle
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", cx); circle.setAttribute("cy", cy);
    circle.setAttribute("r", 22);
    circle.setAttribute("fill", colour);
    circle.setAttribute("stroke", isSelected ? "#fff" : "#000");
    circle.setAttribute("stroke-width", isSelected ? "3" : "1.5");
    circle.setAttribute("class", "territory" + (isSelected ? " selected" : ""));
    circle.setAttribute("data-id", id);
    circle.addEventListener("click", () => selectTerritory(id));
    svg.appendChild(circle);

    // Name label (abbreviated to 6 chars max to fit)
    const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", cx); label.setAttribute("y", cy - 3);
    label.setAttribute("class", "ter-label");
    label.textContent = ter.name.substring(0, 6);
    label.addEventListener("click", () => selectTerritory(id));
    svg.appendChild(label);

    // Troop count label
    const troops = document.createElementNS("http://www.w3.org/2000/svg", "text");
    troops.setAttribute("x", cx); troops.setAttribute("y", cy + 11);
    troops.setAttribute("class", "ter-label");
    troops.setAttribute("font-size", "9");
    troops.textContent = "⚔" + ter.troops;
    troops.addEventListener("click", () => selectTerritory(id));
    svg.appendChild(troops);
  });
}

/** Called when a territory circle is tapped */
function selectTerritory(id) {
  selectedTerritoryId = id;
  renderMap(); // re-render to update selection highlight

  const ter    = G.territories[id];
  const panel  = document.getElementById("territory-panel");
  const atkSec = document.getElementById("attack-section");

  panel.style.display = "block";
  document.getElementById("tp-name").textContent   = ter.name;
  document.getElementById("tp-owner").textContent  = ownerLabel(ter.owner);
  document.getElementById("tp-troops").textContent = ter.troops;
  document.getElementById("tp-bonus").textContent  = ter.bonus;

  // Show attack controls only if:
  // 1. Territory is not already ours (blue)
  // 2. Territory is adjacent to at least one territory we own
  const isEnemy     = ter.owner !== "blue";
  const isAdjacent  = isAdjacentToBlue(id);

  if (isEnemy && isAdjacent) {
    atkSec.style.display = "block";
    attackSendCount = Math.max(1, Math.min(10, G.soldiers));
    document.getElementById("attack-count").textContent = attackSendCount;
  } else {
    atkSec.style.display = "none";
  }
}

/** Returns a coloured text label for a faction name */
function ownerLabel(owner) {
  const map = { blue: "🔵 Blue (You)", red: "🔴 Red", green: "🟢 Green" };
  return map[owner] || owner;
}

/** Check if territory <id> is adjacent to any blue territory */
function isAdjacentToBlue(id) {
  return G.territories[id].adj.some(adjId => G.territories[adjId].owner === "blue");
}

/** Adjust attack send count */
function changeAttack(delta) {
  attackSendCount = Math.max(1, Math.min(G.soldiers, attackSendCount + delta));
  document.getElementById("attack-count").textContent = attackSendCount;
}

/** Launch an attack on the selected territory */
function launchAttack() {
  if (!selectedTerritoryId) return;

  const ter     = G.territories[selectedTerritoryId];
  const sending = attackSendCount;

  if (G.soldiers < sending) {
    showToast("❌ Not enough soldiers!");
    return;
  }

  // --- Battle Calculation ---
  // Simple formula: each attacker has a 55% chance to beat one defender.
  // Attacker wins if: attack_power > defense_power
  // attack_power  = sending  × random(0.7, 1.3)
  // defense_power = ter.troops × random(0.7, 1.3)
  const attackPower  = sending    * (0.7 + Math.random() * 0.6);
  const defensePower = ter.troops * (0.7 + Math.random() * 0.6);

  G.soldiers -= sending; // soldiers always leave the city

  let resultText;

  if (attackPower >= defensePower) {
    // Victory!
    const losses      = Math.ceil(sending * 0.4 * Math.random()); // attacker loses ~0–40%
    const surviving   = Math.max(1, sending - losses);
    ter.owner         = "blue";
    ter.troops        = surviving;  // survivors garrison the captured territory
    resultText = `⚔️ VICTORY!\n${ter.name} captured!\n`
               + `Sent: ${sending} soldiers\nLosses: ${losses}\nGarrison: ${surviving}`;

    // Update leaderboard kills count (player entry is index 0)
    G.leaderboard[0].kills += ter.troops; // original defenders killed
    G.leaderboard[0].territories = countBlue();

  } else {
    // Defeat
    const enemyLosses = Math.floor(ter.troops * 0.3 * Math.random());
    ter.troops        = Math.max(1, ter.troops - enemyLosses);
    resultText = `💀 DEFEAT!\nThe attack on ${ter.name} failed.\n`
               + `Sent: ${sending} soldiers — all lost!\nEnemy weakened by ~${enemyLosses} troops.`;
  }

  // Show battle popup
  const popup = document.getElementById("battle-popup");
  document.getElementById("battle-result-text").textContent = resultText;
  popup.style.display = "block";

  // Hide territory panel until popup is closed
  document.getElementById("territory-panel").style.display = "none";
  selectedTerritoryId = null;

  renderMap();
  updateResourceBar();
  autoSave();
}

function closeBattlePopup() {
  document.getElementById("battle-popup").style.display = "none";
}

/** Count territories owned by blue */
function countBlue() {
  return Object.values(G.territories).filter(t => t.owner === "blue").length;
}

// ============================================================
// SECTION 8 — FACTION SCREEN
// ============================================================

function renderFaction() {
  // --- Stats ---
  const blueTers   = countBlue();
  const blueSols   = G.soldiers + Object.values(G.territories)
                        .filter(t => t.owner === "blue")
                        .reduce((s, t) => s + t.troops, 0);
  const targetName = G.attackTarget
    ? G.territories[G.attackTarget].name
    : "None";

  document.getElementById("fac-territories").textContent = blueTers;
  document.getElementById("fac-soldiers").textContent    = blueSols;
  document.getElementById("fac-target").textContent      = targetName;

  // --- Attack target dropdown (only show territories not owned by blue) ---
  const sel = document.getElementById("target-select");
  sel.innerHTML = '<option value="">— Pick Territory —</option>';
  Object.entries(G.territories).forEach(([id, t]) => {
    if (t.owner !== "blue") {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = `${t.name} (${t.owner})`;
      if (id === G.attackTarget) opt.selected = true;
      sel.appendChild(opt);
    }
  });

  // --- Leaderboard: update player's row ---
  G.leaderboard[0].territories = blueTers;
  // Sort by kills descending
  const sorted = [...G.leaderboard].sort((a, b) => b.kills - a.kills);
  const tbody = document.getElementById("leaderboard-body");
  tbody.innerHTML = "";
  sorted.forEach((m, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i + 1}</td><td>${m.name === "You" ? "⭐ " + m.name : m.name}</td><td>${m.kills}</td><td>${m.territories}</td>`;
    tbody.appendChild(tr);
  });

  // --- Enemy faction overview ---
  const info = document.getElementById("enemy-faction-info");
  info.innerHTML = "";
  ["red", "green"].forEach(faction => {
    const ters  = Object.values(G.territories).filter(t => t.owner === faction);
    const troops = ters.reduce((s, t) => s + t.troops, 0);
    const div = document.createElement("div");
    div.style.marginBottom = "8px";
    div.innerHTML = `<span class="faction-${faction}">${faction === "red" ? "🔴 Red Empire" : "🟢 Green League"}</span>
      — <strong>${ters.length}</strong> territories, <strong>${troops}</strong> troops`;
    info.appendChild(div);
  });
}

/** Set the alliance's attack target (leader test mode) */
function setAttackTarget() {
  const val = document.getElementById("target-select").value;
  G.attackTarget = val;
  showToast(val ? `🎯 Target set: ${G.territories[val].name}` : "Target cleared.");
  renderFaction();
  autoSave();
}

// ============================================================
// SECTION 9 — AI TICK (simple enemy troop growth)
// ============================================================

/** Every 10 seconds, enemy territories gain a small number of troops */
function aiTick() {
  Object.values(G.territories).forEach(ter => {
    if (ter.owner !== "blue") {
      ter.troops += Math.floor(Math.random() * 3); // 0-2 troops per tick
    }
  });
  // Silently update map if visible
  if (document.getElementById("screen-map").classList.contains("active")) {
    renderMap();
  }
}

// ============================================================
// SECTION 10 — AUTO SAVE
// ============================================================

/** Save silently every 30 seconds */
function autoSave() {
  localStorage.setItem("tc_save", JSON.stringify(G));
}

// ============================================================
// SECTION 11 — INIT
// ============================================================

function init() {
  loadGame();              // restore saved state (if any)
  updateResourceBar();     // show initial resource counts
  renderCity();            // render default screen

  // Resource production tick
  setInterval(() => {
    resourceTick();
    // If city screen is active, refresh building list to show live numbers
    if (document.getElementById("screen-city").classList.contains("active")) {
      document.getElementById("soldiers-count").textContent = G.soldiers;
    }
  }, TICK_MS);

  // AI enemy tick (every 10 seconds)
  setInterval(aiTick, 10000);

  // Auto-save every 30 seconds
  setInterval(autoSave, 30000);
}

// Start the game once the DOM is ready
document.addEventListener("DOMContentLoaded", init);
