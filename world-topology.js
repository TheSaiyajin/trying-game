// Canonical, versioned world map topology. This is the single source of truth for the
// territory graph shared by:
//   - backend/world-seed.sql generation (fresh databases)
//   - backend/db.js legacy-topology migration (existing databases)
//   - the frontend map layout (script.js)
//   - the automated tests (structure, symmetry, geometry)
//
// Never hand-edit territory/neighbor data anywhere else; change it here and regenerate.
//
// Shape: capital -> home ring (3) -> frontier ring (3), identical for blue/red/green, plus
// three border zones (one per faction pair) and a shared core, all rotated 120 degrees so
// every faction has the exact same structure, bonus types, defense totals, and distances.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.WORLD_TOPOLOGY = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Bump this whenever the territory/neighbor graph changes. db.js uses it to decide
  // whether an existing database needs its territory_neighbors replaced.
  const TOPOLOGY_VERSION = 2;

  const FACTIONS = ['blue', 'red', 'green'];

  const CAPITAL_ID = { blue: 'b1', red: 'r1', green: 'g1' };
  const CAPITAL_NAME = { blue: 'Blue Capital', red: 'Red Capital', green: 'Green Capital' };

  const HOME_IDS = { blue: ['n1', 'n2', 'n3'], red: ['n4', 'n5', 'n6'], green: ['n7', 'n8', 'n9'] };
  const FRONTIER_IDS = { blue: ['n10', 'n11', 'n12'], red: ['n13', 'n14', 'n15'], green: ['n16', 'n17', 'n18'] };

  const HOME_SLOT_BONUS = ['food', 'wood', 'manpower'];
  const HOME_SLOT_NAME = ['Farmstead', 'Timberland', 'Muster Camp'];
  const HOME_DEFENSE = 18;

  const FRONTIER_SLOT_BONUS = ['iron', 'training', 'resource'];
  const FRONTIER_SLOT_NAME = ['Ore Ridge', 'Drill Yard', 'Trade Post'];
  const FRONTIER_DEFENSE = 21;

  // Rotation order blue -> red -> green -> blue. `a` touches ids[0] (its own side),
  // `b` touches ids[2] (its own side); ids[1] is the shared middle node linking to the core.
  const BORDER_PAIRS = [
    { key: 'blue_red', a: 'blue', b: 'red', ids: ['n19', 'n20', 'n21'], prefix: 'Stonewatch' },
    { key: 'red_green', a: 'red', b: 'green', ids: ['n22', 'n23', 'n24'], prefix: 'Ember' },
    { key: 'green_blue', a: 'green', b: 'blue', ids: ['n25', 'n26', 'n27'], prefix: 'Verdant' },
  ];
  const BORDER_SLOT_BONUS = ['fortress', 'storage', 'resource'];
  const BORDER_SLOT_NAME = ['Keep', 'Vault', 'Market'];
  const BORDER_DEFENSE = 24;

  const CORE_IDS = ['n28', 'n29', 'n30'];
  const CORE_SLOT_BONUS = ['fortress', 'storage', 'resource'];
  const CORE_SLOT_NAME = ['Crown Bastion', 'Crown Treasury', 'Crown Spire'];
  const CORE_DEFENSE = 28;

  const CAPITAL_DEFENSE = 35;

  function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function bonusFields(bonusType, isCore) {
    if (isCore) {
      if (bonusType === 'fortress') return { bonusValue: 0.25, resourceBonus: 0, storageBonus: 0, isFortress: true };
      if (bonusType === 'storage') return { bonusValue: 0.25, resourceBonus: 0, storageBonus: 0.25, isFortress: false };
      if (bonusType === 'attack' || bonusType === 'defense') return { bonusValue: 0.15, resourceBonus: 0, storageBonus: 0, isFortress: false };
      return { bonusValue: 0.15, resourceBonus: 0.15, storageBonus: 0, isFortress: false };
    }
    switch (bonusType) {
      case 'food':
      case 'wood':
      case 'iron':
      case 'manpower':
        return { bonusValue: 0.10, resourceBonus: 0.10, storageBonus: 0, isFortress: false };
      case 'training':
        return { bonusValue: 0.05, resourceBonus: 0.05, storageBonus: 0, isFortress: false };
      case 'attack':
      case 'defense':
        return { bonusValue: 0.10, resourceBonus: 0, storageBonus: 0, isFortress: false };
      case 'resource':
        return { bonusValue: 0.10, resourceBonus: 0.10, storageBonus: 0, isFortress: false };
      case 'fortress':
        return { bonusValue: 0.20, resourceBonus: 0, storageBonus: 0, isFortress: true };
      case 'storage':
        return { bonusValue: 0.20, resourceBonus: 0, storageBonus: 0.20, isFortress: false };
      default:
        throw new Error(`Unknown bonus type: ${bonusType}`);
    }
  }

  function buildTerritories() {
    const territories = [];

    FACTIONS.forEach((faction) => {
      territories.push({
        id: CAPITAL_ID[faction],
        name: CAPITAL_NAME[faction],
        ownerFaction: faction,
        defense: CAPITAL_DEFENSE,
        bonusType: 'resource',
        isCapital: true,
        ...bonusFields('resource', false),
      });

      HOME_SLOT_BONUS.forEach((bonusType, i) => {
        territories.push({
          id: HOME_IDS[faction][i],
          name: `${capitalize(faction)} ${HOME_SLOT_NAME[i]}`,
          ownerFaction: 'neutral',
          defense: HOME_DEFENSE,
          bonusType,
          isCapital: false,
          ...bonusFields(bonusType, false),
        });
      });

      FRONTIER_SLOT_BONUS.forEach((bonusType, i) => {
        territories.push({
          id: FRONTIER_IDS[faction][i],
          name: `${capitalize(faction)} ${FRONTIER_SLOT_NAME[i]}`,
          ownerFaction: 'neutral',
          defense: FRONTIER_DEFENSE,
          bonusType,
          isCapital: false,
          ...bonusFields(bonusType, false),
        });
      });
    });

    BORDER_PAIRS.forEach(({ ids, prefix }) => {
      BORDER_SLOT_BONUS.forEach((bonusType, i) => {
        territories.push({
          id: ids[i],
          name: `${prefix} ${BORDER_SLOT_NAME[i]}`,
          ownerFaction: 'neutral',
          defense: BORDER_DEFENSE,
          bonusType,
          isCapital: false,
          ...bonusFields(bonusType, false),
        });
      });
    });

    CORE_IDS.forEach((id, i) => {
      const bonusType = CORE_SLOT_BONUS[i];
      territories.push({
        id,
        name: CORE_SLOT_NAME[i],
        ownerFaction: 'neutral',
        defense: CORE_DEFENSE,
        bonusType,
        isCapital: false,
        ...bonusFields(bonusType, true),
      });
    });

    return territories;
  }

  // Undirected edges (each pair listed once). Consumers expand to bidirectional rows.
  // Ring-internal connections are a path (slot0-slot1-slot2), not a closed triangle: a
  // slot0-slot2 "wrap" chord geometrically dips inward and crosses the slot1 node's own
  // outward connector (home/border) at this layout's radii, which would create unrelated
  // line crossings on the rendered map. A path keeps the ring connected without that flaw.
  function buildEdges() {
    const edges = [];
    const addEdge = (a, b) => edges.push([a, b]);

    FACTIONS.forEach((faction) => {
      const capital = CAPITAL_ID[faction];
      const [h0, h1, h2] = HOME_IDS[faction];
      const [f0, f1, f2] = FRONTIER_IDS[faction];

      addEdge(capital, h0);
      addEdge(capital, h1);
      addEdge(capital, h2);
      addEdge(h0, h1);
      addEdge(h1, h2);
      addEdge(h0, f0);
      addEdge(h1, f1);
      addEdge(h2, f2);
      addEdge(f0, f1);
      addEdge(f1, f2);
    });

    BORDER_PAIRS.forEach(({ a, b, ids }) => {
      const [b0, b1, b2] = ids;
      addEdge(b0, b1);
      addEdge(b1, b2);
      addEdge(FRONTIER_IDS[a][2], b0);
      addEdge(FRONTIER_IDS[b][0], b2);
    });

    const [c0, c1, c2] = CORE_IDS;
    addEdge(c0, c1);
    addEdge(c1, c2);
    addEdge(c2, c0);
    BORDER_PAIRS.forEach(({ ids }, i) => {
      addEdge(ids[1], CORE_IDS[i]);
    });

    return edges;
  }

  // A 120-degree rotation blue -> red -> green -> blue that is an automorphism of the
  // graph: applying it to every edge endpoint yields another edge in the same graph.
  // Used to prove the three factions have an identical, merely-rotated structure.
  function buildRotationMap() {
    const map = {};
    const factionOrder = ['blue', 'red', 'green'];
    factionOrder.forEach((faction, i) => {
      const next = factionOrder[(i + 1) % factionOrder.length];
      map[CAPITAL_ID[faction]] = CAPITAL_ID[next];
      HOME_IDS[faction].forEach((id, slot) => { map[id] = HOME_IDS[next][slot]; });
      FRONTIER_IDS[faction].forEach((id, slot) => { map[id] = FRONTIER_IDS[next][slot]; });
    });
    BORDER_PAIRS.forEach((pair, i) => {
      const next = BORDER_PAIRS[(i + 1) % BORDER_PAIRS.length];
      pair.ids.forEach((id, slot) => { map[id] = next.ids[slot]; });
    });
    CORE_IDS.forEach((id, i) => {
      map[id] = CORE_IDS[(i + 1) % CORE_IDS.length];
    });
    return map;
  }

  // ---------------------------------------------------------------------------------
  // Layout (shared by the frontend SVG map and the geometry crossing test).
  // Compass-style bearings (0 = north, clockwise), 120 degrees apart per faction, with
  // enough radial/angular spacing between rings that hexes never touch.
  // ---------------------------------------------------------------------------------
  const LAYOUT_CENTER = { cx: 400, cy: 380 };
  const FACTION_BEARING = { blue: 300, red: 60, green: 180 };
  const BORDER_BEARING = { blue_red: 0, red_green: 120, green_blue: 240 };
  const RING_RADIUS = { capital: 340, home: 250, frontier: 165, border: 95, core: 45 };
  const RING_OFFSET = { home: 20, frontier: 28, border: 46 };
  const LAYOUT_VIEWBOX = { width: 800, height: 800 };

  function polarToXY(bearingDeg, radius) {
    const angle = (bearingDeg * Math.PI) / 180;
    return {
      cx: Math.round(LAYOUT_CENTER.cx + (radius * Math.sin(angle))),
      cy: Math.round(LAYOUT_CENTER.cy - (radius * Math.cos(angle))),
    };
  }

  function buildLayout() {
    const layout = {};

    FACTIONS.forEach((faction) => {
      layout[CAPITAL_ID[faction]] = polarToXY(FACTION_BEARING[faction], RING_RADIUS.capital);

      const homeOffset = RING_OFFSET.home;
      HOME_IDS[faction].forEach((id, slot) => {
        const offset = (slot - 1) * homeOffset;
        layout[id] = polarToXY(FACTION_BEARING[faction] + offset, RING_RADIUS.home);
      });

      const frontierOffset = RING_OFFSET.frontier;
      FRONTIER_IDS[faction].forEach((id, slot) => {
        const offset = (slot - 1) * frontierOffset;
        layout[id] = polarToXY(FACTION_BEARING[faction] + offset, RING_RADIUS.frontier);
      });
    });

    BORDER_PAIRS.forEach(({ key, ids }) => {
      const borderOffset = RING_OFFSET.border;
      ids.forEach((id, slot) => {
        const offset = (slot - 1) * borderOffset;
        layout[id] = polarToXY(BORDER_BEARING[key] + offset, RING_RADIUS.border);
      });
    });

    CORE_IDS.forEach((id, i) => {
      const pair = BORDER_PAIRS[i];
      layout[id] = polarToXY(BORDER_BEARING[pair.key], RING_RADIUS.core);
    });

    return layout;
  }

  return {
    TOPOLOGY_VERSION,
    FACTIONS,
    CAPITAL_ID,
    HOME_IDS,
    FRONTIER_IDS,
    BORDER_PAIRS,
    CORE_IDS,
    buildTerritories,
    buildEdges,
    buildRotationMap,
    buildLayout,
    LAYOUT_VIEWBOX,
  };
}));
