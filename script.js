/* ====================================================
   TERRITORY CONQUEST — script.js
   Beginner-friendly, heavily commented game logic
   ==================================================== */

// ============================================================
// SECTION 1 — GAME STATE
// ============================================================

// Territories are laid out in a 3-column × 5-row visual grid:
//
//  [t3: Blue ] [t7: Green ] [t12: Green]  (row 0 — north)
//  [t2: Blue ] [t6: Green ] [t11: Green]  (row 1)
//  [t1: Blue ] [t5: Red   ] [t10: Red  ]  (row 2)  ← Blue borders Red here
//  [t4: Red  ] [t9: Red   ] [t15: Green]  (row 3)
//  [t8: Red  ] [t14: Red  ] [t13: Green]  (row 4 — south)
//
// Adjacency matches orthogonal (edge-sharing) grid neighbors.

const DEFAULT_STATE = {
  food:     500,
  wood:     400,
  iron:     300,
  manpower: 250,
  soldiers: 100,

  buildings: {
    farm:       { level: 1, name: "Farm",        icon: "🌾", resource: "food",     baseProd: 5,  upgradeCost: { food:50,  wood:80,  iron:0  } },
    lumbermill: { level: 1, name: "Lumber Mill",  icon: "🪵", resource: "wood",     baseProd: 4,  upgradeCost: { food:40,  wood:0,   iron:60 } },
    ironmine:   { level: 1, name: "Iron Mine",    icon: "⚙️", resource: "iron",     baseProd: 3,  upgradeCost: { food:30,  wood:100, iron:0  } },
    barracks:   { level: 1, name: "Barracks",     icon: "🏟", resource: "manpower", baseProd: 2,  upgradeCost: { food:80,  wood:60,  iron:80 } },
  },

  territories: {
    // Blue (col 0) — player controls these 3 at start
    t1:  { name: "Ironholt",    owner: "blue",  troops: 30, bonus: "+10% Iron",         adj: ["t2","t4","t5"] },
    t2:  { name: "Greenfields", owner: "blue",  troops: 25, bonus: "+10% Food",         adj: ["t1","t3","t6"] },
    t3:  { name: "Millwood",    owner: "blue",  troops: 20, bonus: "+10% Wood",         adj: ["t2","t7"] },

    // Red (centre / bottom-left) — t5 and t4 both border Blue
    t4:  { name: "Steelpass",   owner: "red",   troops: 35, bonus: "+10% Iron",         adj: ["t1","t8","t9"] },
    t5:  { name: "Dustplain",   owner: "red",   troops: 28, bonus: "None",              adj: ["t1","t6","t9","t10"] },
    t8:  { name: "Redkeep",     owner: "red",   troops: 50, bonus: "Fortress +20% Def", adj: ["t4","t14"] },
    t9:  { name: "Cragfort",    owner: "red",   troops: 40, bonus: "None",              adj: ["t4","t5","t14","t15"] },
    t10: { name: "Stonemarsh",  owner: "red",   troops: 38, bonus: "+10% Iron",         adj: ["t5","t11","t15"] },
    t14: { name: "Grimhaven",   owner: "red",   troops: 45, bonus: "+10% Manpower",     adj: ["t8","t9","t13"] },

    // Green (right column + bottom-right)
    t6:  { name: "Ashvale",     owner: "green", troops: 32, bonus: "+10% Food",         adj: ["t2","t5","t7","t11"] },
    t7:  { name: "Pinegrove",   owner: "green", troops: 30, bonus: "+10% Wood",         adj: ["t3","t6","t12"] },
    t11: { name: "Fernhaven",   owner: "green", troops: 42, bonus: "+10% Food",         adj: ["t6","t10","t12"] },
    t12: { name: "Evermoore",   owner: "green", troops: 36, bonus: "+10% Wood",         adj: ["t7","t11"] },
    t13: { name: "Duskwall",    owner: "green", troops: 55, bonus: "Fortress +20% Def", adj: ["t14","t15"] },
    t15: { name: "Thornwatch",  owner: "green", troops: 60, bonus: "+5% Train Speed",   adj: ["t9","t10","t13"] },
  },

  attackTarget: "",
  leaderboard: [
    { name: "You",    kills: 0,  territories: 3 },
    { name: "Zara",   kills: 47, territories: 3 },
    { name: "Korvax", kills: 35, territories: 2 },
    { name: "Lira",   kills: 28, territories: 2 },
    { name: "Draxis", kills: 19, territories: 2 },
    { name: "Syndra", kills: 12, territories: 3 },
  ],
};

let G = deepClone(DEFAULT_STATE);

// ============================================================
// SECTION 2 — UTILITY
// ============================================================

function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function showToast(msg) {
  const old = document.querySelector(".toast");
  if (old) old.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("fade"), 1800);
  setTimeout(() => toast.remove(), 2400);
}

function fmt(n) {
  n = Math.floor(n);
  if (n >= 10000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

// ============================================================
// SECTION 3 — SAVE / LOAD
// ============================================================

function saveGame() {
  localStorage.setItem("tc_save", JSON.stringify(G));
  showToast("✅ Game saved!");
}

function loadGame() {
  const raw = localStorage.getItem("tc_save");
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      G = Object.assign(deepClone(DEFAULT_STATE), saved);
      G.buildings   = Object.assign(deepClone(DEFAULT_STATE.buildings),   saved.buildings   || {});
      G.territories = Object.assign(deepClone(DEFAULT_STATE.territories), saved.territories || {});
    } catch (e) {
      console.warn("Save data corrupt, using defaults.", e);
      G = deepClone(DEFAULT_STATE);
    }
  }
}

function resetGame() {
  if (!confirm("Reset to default test state? All progress will be lost.")) return;
  localStorage.removeItem("tc_save");
  G = deepClone(DEFAULT_STATE);
  trainAmount = 1;
  attackSendCount = 10;
  selectedTerritoryId = null;
  updateResourceBar();
  renderCity();
  if (document.getElementById("screen-map").classList.contains("active"))     renderMap();
  if (document.getElementById("screen-faction").classList.contains("active")) renderFaction();
  showToast("🔄 Game reset!");
}

// ============================================================
// SECTION 4 — SCREEN NAVIGATION
// ============================================================

function showScreen(name) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById("screen-" + name).classList.add("active");
  document.getElementById("nav-" + name).classList.add("active");
  if (name === "city")    renderCity();
  if (name === "map")     renderMap();
  if (name === "faction") renderFaction();
}

// ============================================================
// SECTION 5 — RESOURCE PRODUCTION TICK
// ============================================================

const TICK_MS = 3000;

function resourceTick() {
  const b = G.buildings;
  G.food     += b.farm.baseProd       * b.farm.level;
  G.wood     += b.lumbermill.baseProd * b.lumbermill.level;
  G.iron     += b.ironmine.baseProd   * b.ironmine.level;
  G.manpower += b.barracks.baseProd   * b.barracks.level;
  G.food     = Math.min(G.food,     9999);
  G.wood     = Math.min(G.wood,     9999);
  G.iron     = Math.min(G.iron,     9999);
  G.manpower = Math.min(G.manpower, 9999);
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

let trainAmount = 1;

function renderCity() {
  renderBuildings();
  document.getElementById("soldiers-count").textContent = G.soldiers;
  document.getElementById("train-count").textContent    = trainAmount;
}

function renderBuildings() {
  const container = document.getElementById("building-list");
  container.innerHTML = "";
  Object.entries(G.buildings).forEach(([id, b]) => {
    const prod = b.baseProd * b.level;
    const cost = upgradeCostAt(b, b.level + 1);
    const canAfford = G.food >= cost.food && G.wood >= cost.wood && G.iron >= cost.iron;
    const card = document.createElement("div");
    card.className = "building-card";
    card.innerHTML = `
      <div class="building-info">
        <div class="building-name">${b.icon} ${b.name}</div>
        <div class="building-level">Level ${b.level}</div>
        <div class="building-prod">+${prod} ${b.resource}/tick</div>
        <div class="building-cost">Upgrade: 🌾${cost.food} 🪵${cost.wood} ⚙️${cost.iron}</div>
      </div>
      <button class="btn-upgrade" onclick="upgradeBuilding('${id}')" ${canAfford ? "" : "disabled"}>⬆ Lvl ${b.level + 1}</button>
    `;
    container.appendChild(card);
  });
}

function upgradeCostAt(b, level) {
  const mult = level;
  return {
    food: b.upgradeCost.food * mult,
    wood: b.upgradeCost.wood * mult,
    iron: b.upgradeCost.iron * mult,
  };
}

function upgradeBuilding(id) {
  const b    = G.buildings[id];
  const cost = upgradeCostAt(b, b.level + 1);
  if (G.food < cost.food || G.wood < cost.wood || G.iron < cost.iron) {
    showToast("❌ Not enough resources!");
    return;
  }
  G.food -= cost.food;
  G.wood -= cost.wood;
  G.iron -= cost.iron;
  b.level += 1;
  showToast(`✅ ${b.name} upgraded to level ${b.level}!`);
  renderCity();
  updateResourceBar();
  autoSave();
}

function changeTrain(delta) {
  trainAmount = Math.max(1, trainAmount + delta);
  document.getElementById("train-count").textContent = trainAmount;
}

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
  autoSave();
}

// ============================================================
// SECTION 7 — WORLD MAP (SVG, properly-tiling polygons)
// ============================================================

// The map is a 3-column × 5-row tiling grid drawn on a 360×370 viewBox.
// Junction points (where 4 cells meet) are slightly offset for organic look:
//
//   J1=(118,76)  J2=(242,72)
//   J3=(122,150) J4=(238,146)
//   J5=(120,224) J6=(244,220)
//   J7=(116,298) J8=(240,294)
//
// Grid cell → territory mapping:
//   (col0,row0)=t3  (col1,row0)=t7  (col2,row0)=t12
//   (col0,row1)=t2  (col1,row1)=t6  (col2,row1)=t11
//   (col0,row2)=t1  (col1,row2)=t5  (col2,row2)=t10
//   (col0,row3)=t4  (col1,row3)=t9  (col2,row3)=t15
//   (col0,row4)=t8  (col1,row4)=t14 (col2,row4)=t13

const TERRITORY_SHAPES = {
  // col0 (left)
  t3:  "0,0   120,0  118,76  0,74",
  t2:  "0,74  118,76 122,150 0,148",
  t1:  "0,148 122,150 120,224 0,222",
  t4:  "0,222 120,224 116,298 0,296",
  t8:  "0,296 116,298 120,370 0,370",
  // col1 (centre)
  t7:  "120,0  240,0  242,72  118,76",
  t6:  "118,76 242,72 238,146 122,150",
  t5:  "122,150 238,146 244,220 120,224",
  t9:  "120,224 244,220 240,294 116,298",
  t14: "116,298 240,294 240,370 120,370",
  // col2 (right)
  t12: "240,0  360,0  360,74  242,72",
  t11: "242,72 360,74 360,148 238,146",
  t10: "238,146 360,148 360,222 244,220",
  t15: "244,220 360,222 360,296 240,294",
  t13: "240,294 360,296 360,370 240,370",
};

// Approximate label centres for each polygon (cx, cy)
const TERRITORY_LABEL = {
  t3:  [60,  37 ], t7:  [182, 36 ], t12: [300, 36 ],
  t2:  [61,  111], t6:  [180, 110], t11: [299, 110],
  t1:  [61,  185], t5:  [183, 185], t10: [300, 185],
  t4:  [60,  259], t9:  [183, 258], t15: [302, 258],
  t8:  [60,  333], t14: [182, 333], t13: [300, 333],
};

const FACTION_FILL   = { blue: "#1a4d8f", red: "#7a1a1a", green: "#1a5c2a" };
const FACTION_STROKE = { blue: "#2e78e0", red: "#d93030", green: "#2ea840" };

let selectedTerritoryId = null;
let attackSendCount = 10;

function isAdjacentToBlue(id) {
  if (!G.territories[id]) return false;
  return G.territories[id].adj.some(adjId => G.territories[adjId] && G.territories[adjId].owner === "blue");
}

function canAttack(id) {
  return G.territories[id] && G.territories[id].owner !== "blue" && isAdjacentToBlue(id);
}

function renderMap() {
  const svg = document.getElementById("map-svg");
  svg.innerHTML = "";

  Object.entries(G.territories).forEach(([id, ter]) => {
    const shape = TERRITORY_SHAPES[id];
    if (!shape) return;

    const fill    = FACTION_FILL[ter.owner]   || "#333";
    const stroke  = FACTION_STROKE[ter.owner] || "#888";
    const isSel   = id === selectedTerritoryId;
    const isTgt   = id === G.attackTarget;
    const [lx, ly] = TERRITORY_LABEL[id] || [180, 185];

    // Main polygon
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", shape);
    poly.setAttribute("fill", fill);
    poly.setAttribute("stroke", isSel ? "#ffffff" : stroke);
    poly.setAttribute("stroke-width", isSel ? "3" : "1.5");
    poly.setAttribute("class", "territory" + (isSel ? " selected" : ""));
    poly.setAttribute("data-id", id);
    poly.addEventListener("click", () => selectTerritory(id));
    svg.appendChild(poly);

    // Faction attack-target dashed gold border
    if (isTgt) {
      const glow = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      glow.setAttribute("points", shape);
      glow.setAttribute("fill", "none");
      glow.setAttribute("stroke", "#e3b341");
      glow.setAttribute("stroke-width", "3");
      glow.setAttribute("stroke-dasharray", "7,4");
      glow.setAttribute("pointer-events", "none");
      svg.appendChild(glow);
    }

    // Territory name label
    const nameEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    nameEl.setAttribute("x", lx);
    nameEl.setAttribute("y", ly - 6);
    nameEl.setAttribute("class", "ter-label");
    nameEl.setAttribute("font-size", "8.5");
    nameEl.setAttribute("fill", "#e6edf3");
    nameEl.setAttribute("pointer-events", "none");
    nameEl.textContent = ter.name;
    svg.appendChild(nameEl);

    // Troop count label
    const troopEl = document.createElementNS("http://www.w3.org/2000/svg", "text");
    troopEl.setAttribute("x", lx);
    troopEl.setAttribute("y", ly + 8);
    troopEl.setAttribute("class", "ter-label");
    troopEl.setAttribute("font-size", "10");
    troopEl.setAttribute("fill", "#e3b341");
    troopEl.setAttribute("pointer-events", "none");
    troopEl.textContent = "⚔" + ter.troops;
    svg.appendChild(troopEl);
  });
}

function selectTerritory(id) {
  selectedTerritoryId = id;
  renderMap();

  const ter    = G.territories[id];
  const panel  = document.getElementById("territory-panel");
  const atkSec = document.getElementById("attack-section");

  panel.style.display = "block";

  document.getElementById("tp-name").textContent    = ter.name;
  document.getElementById("tp-owner").textContent   = ownerLabel(ter.owner);
  document.getElementById("tp-troops").textContent  = ter.troops;
  document.getElementById("tp-bonus").textContent   = ter.bonus;

  const neighNames = ter.adj
    .map(nid => G.territories[nid] ? G.territories[nid].name : nid)
    .join(", ");
  document.getElementById("tp-neighbors").textContent = neighNames;

  if (canAttack(id)) {
    atkSec.style.display = "block";
    attackSendCount = Math.max(1, Math.min(10, G.soldiers));
    document.getElementById("attack-count").textContent = attackSendCount;
  } else {
    atkSec.style.display = "none";
  }
}

function ownerLabel(owner) {
  const map = { blue: "🔵 Blue (You)", red: "🔴 Red Empire", green: "🟢 Green League" };
  return map[owner] || owner;
}

function changeAttack(delta) {
  attackSendCount = Math.max(1, Math.min(G.soldiers, attackSendCount + delta));
  document.getElementById("attack-count").textContent = attackSendCount;
}

function launchAttack() {
  if (!selectedTerritoryId) return;
  const ter     = G.territories[selectedTerritoryId];
  const sending = attackSendCount;

  if (G.soldiers < sending || sending < 1) {
    showToast("❌ Not enough soldiers!");
    return;
  }
  if (!canAttack(selectedTerritoryId)) {
    showToast("❌ Cannot attack this territory!");
    return;
  }

  // Fortress bonus gives defenders extra power
  const fortBonus    = ter.bonus.toLowerCase().includes("fortress") ? 1.2 : 1.0;
  const attackPower  = sending    * (0.7 + Math.random() * 0.6);
  const defensePower = ter.troops * fortBonus * (0.7 + Math.random() * 0.6);

  G.soldiers -= sending;

  let resultHTML;
  const terName = ter.name;

  if (attackPower >= defensePower) {
    const losses    = Math.ceil(sending * 0.4 * Math.random());
    const surviving = Math.max(1, sending - losses);
    ter.owner  = "blue";
    ter.troops = surviving;
    G.leaderboard[0].kills += Math.max(0, sending - losses);
    G.leaderboard[0].territories = countBlue();
    resultHTML = `<span class="result-victory">⚔️ VICTORY!</span><br>
      ${sending} attackers vs ${ter.troops} defenders<br>
      <strong>Blue captured ${terName}!</strong><br>
      Losses: ${losses} &nbsp;|&nbsp; Garrison: ${surviving}`;
  } else {
    const enemyLosses = Math.floor(ter.troops * 0.3 * Math.random());
    ter.troops = Math.max(1, ter.troops - enemyLosses);
    resultHTML = `<span class="result-defeat">💀 DEFEAT!</span><br>
      ${sending} attackers vs ${ter.troops} defenders<br>
      <strong>Attack on ${terName} failed!</strong><br>
      All ${sending} soldiers lost. Enemy weakened by ~${enemyLosses}.`;
  }

  document.getElementById("battle-result-text").innerHTML = resultHTML;
  document.getElementById("battle-popup").style.display = "block";
  document.getElementById("territory-panel").style.display = "none";
  selectedTerritoryId = null;

  renderMap();
  updateResourceBar();
  autoSave();
}

function closeBattlePopup() {
  document.getElementById("battle-popup").style.display = "none";
}

function countBlue() {
  return Object.values(G.territories).filter(t => t.owner === "blue").length;
}

// ============================================================
// SECTION 8 — FACTION SCREEN
// ============================================================

function renderFaction() {
  const blueTers = countBlue();
  const blueSols = G.soldiers + Object.values(G.territories)
                     .filter(t => t.owner === "blue")
                     .reduce((s, t) => s + t.troops, 0);
  const targetName = G.attackTarget && G.territories[G.attackTarget]
    ? G.territories[G.attackTarget].name : "None";

  document.getElementById("fac-territories").textContent = blueTers;
  document.getElementById("fac-soldiers").textContent    = blueSols;
  document.getElementById("fac-target").textContent      = targetName;

  // Dropdown: all enemy territories; ★ marks those adjacent to Blue
  const sel = document.getElementById("target-select");
  sel.innerHTML = '<option value="">— Pick Territory —</option>';
  Object.entries(G.territories).forEach(([id, t]) => {
    if (t.owner !== "blue") {
      const opt = document.createElement("option");
      opt.value = id;
      const adj = isAdjacentToBlue(id) ? " ★ (bordersBlue)" : "";
      opt.textContent = `${t.name} (${t.owner})${adj}`;
      if (id === G.attackTarget) opt.selected = true;
      sel.appendChild(opt);
    }
  });

  // Leaderboard
  G.leaderboard[0].territories = blueTers;
  const sorted = [...G.leaderboard].sort((a, b) => b.kills - a.kills);
  const tbody = document.getElementById("leaderboard-body");
  tbody.innerHTML = "";
  sorted.forEach((m, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${i + 1}</td><td>${m.name === "You" ? "⭐ You" : m.name}</td><td>${m.kills}</td><td>${m.territories}</td>`;
    tbody.appendChild(tr);
  });

  // Enemy faction overview
  const info = document.getElementById("enemy-faction-info");
  info.innerHTML = "";
  ["red", "green"].forEach(faction => {
    const ters   = Object.values(G.territories).filter(t => t.owner === faction);
    const troops = ters.reduce((s, t) => s + t.troops, 0);
    const label  = faction === "red" ? "🔴 Red Empire" : "🟢 Green League";
    const div = document.createElement("div");
    div.style.cssText = "margin-bottom:8px;font-size:14px;";
    div.innerHTML = `<span class="faction-${faction}">${label}</span>
      &nbsp;— <strong>${ters.length}</strong> territories &nbsp;| <strong>${troops}</strong> troops`;
    info.appendChild(div);
  });

  // Blue territory list
  const blueList = document.getElementById("blue-territory-list");
  if (blueList) {
    blueList.innerHTML = "";
    Object.values(G.territories)
      .filter(t => t.owner === "blue")
      .forEach(t => {
        const li = document.createElement("div");
        li.style.cssText = "font-size:13px;padding:3px 0;color:#7ab8ff;border-bottom:1px solid #30363d;";
        li.textContent = `📍 ${t.name} — ⚔${t.troops} — ${t.bonus}`;
        blueList.appendChild(li);
      });
  }
}

function setAttackTarget() {
  const val = document.getElementById("target-select").value;
  G.attackTarget = val;
  const msg = val && G.territories[val] ? `🎯 Target: ${G.territories[val].name}` : "Target cleared.";
  showToast(msg);
  renderFaction();
  if (document.getElementById("screen-map").classList.contains("active")) renderMap();
  autoSave();
}

function cancelAttackTarget() {
  G.attackTarget = "";
  document.getElementById("target-select").value = "";
  renderFaction();
  if (document.getElementById("screen-map").classList.contains("active")) renderMap();
  autoSave();
  showToast("Target cleared.");
}

// ============================================================
// SECTION 9 — AI TICK
// ============================================================

function aiTick() {
  Object.values(G.territories).forEach(ter => {
    if (ter.owner !== "blue") {
      ter.troops += Math.floor(Math.random() * 3);
    }
  });
  if (document.getElementById("screen-map").classList.contains("active")) {
    renderMap();
  }
}

// ============================================================
// SECTION 10 — AUTO SAVE
// ============================================================

function autoSave() {
  localStorage.setItem("tc_save", JSON.stringify(G));
}

// ============================================================
// SECTION 11 — INIT
// ============================================================

function init() {
  loadGame();
  updateResourceBar();
  renderCity();

  setInterval(() => {
    resourceTick();
    if (document.getElementById("screen-city").classList.contains("active")) {
      document.getElementById("soldiers-count").textContent = G.soldiers;
      renderBuildings();
    }
  }, TICK_MS);

  setInterval(aiTick, 10000);
  setInterval(autoSave, 30000);
}

document.addEventListener("DOMContentLoaded", init);
