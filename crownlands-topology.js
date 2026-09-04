// Crownlands 64: three identical 21-tile faction regions plus one shared Crown.
// This module is data-only and works in both Node and the browser. Every faction region
// is a 120-degree rotation of the others, including bonuses, defenses, and connections.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.CROWNLANDS_TOPOLOGY = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TOPOLOGY_VERSION = 1;
  const FACTIONS = ['blue', 'red', 'green'];
  const CAPITAL_ID = { blue: 'b1', red: 'r1', green: 'g1' };
  const CORE_IDS = ['c1'];
  const LAYOUT_CENTER = { cx: 600, cy: 360 };
  const LAYOUT_VIEWBOX = { width: 1200, height: 960 };
  const FACTION_BEARING = { blue: 300, red: 60, green: 180 };

  const REGION_IDS = Object.fromEntries(FACTIONS.map((faction) => [
    faction,
    Array.from({ length: 20 }, (_, index) => `${faction.charAt(0)}${index + 2}`),
  ]));

  const SLOT_BONUSES = [
    'food', 'wood', 'iron', 'manpower',
    'attack', 'defense', 'food', 'wood', 'iron', 'manpower',
    'storage', 'training', 'fortress', 'resource', 'attack', 'defense', 'fortress',
    'attack', 'defense', 'resource',
  ];

  const SLOT_NAMES = [
    'Granary', 'Timber Camp', 'Ironworks', 'Muster Hall',
    'Vanguard Post', 'Shieldwall', 'Farmland', 'Lumber Yard', 'Ore Basin', 'Recruitment Camp',
    'Great Vault', 'Drill Grounds', 'North Fortress', 'Trade Hub', 'Assault Camp',
    'Defender Keep', 'South Fortress', 'Scout Post', 'Guard Post', 'Supply Hub',
  ];

  function capitalize(word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }

  function bonusFields(bonusType) {
    if (['food', 'wood', 'iron', 'manpower'].includes(bonusType)) {
      return { bonusValue: 0.05, resourceBonus: 0.05, storageBonus: 0, isFortress: false };
    }
    if (bonusType === 'storage') {
      return { bonusValue: 0.10, resourceBonus: 0, storageBonus: 0.10, isFortress: false };
    }
    if (bonusType === 'training') {
      return { bonusValue: 0.03, resourceBonus: 0.03, storageBonus: 0, isFortress: false };
    }
    if (bonusType === 'resource') {
      return { bonusValue: 0.03, resourceBonus: 0.03, storageBonus: 0, isFortress: false };
    }
    if (bonusType === 'attack' || bonusType === 'defense') {
      return { bonusValue: 0.05, resourceBonus: 0, storageBonus: 0, isFortress: false };
    }
    if (bonusType === 'fortress') {
      return { bonusValue: 0, resourceBonus: 0, storageBonus: 0, isFortress: true };
    }
    return { bonusValue: 0, resourceBonus: 0, storageBonus: 0, isFortress: false };
  }

  function buildTerritories() {
    const territories = [];
    FACTIONS.forEach((faction) => {
      territories.push({
        id: CAPITAL_ID[faction],
        name: `${capitalize(faction)} Capital`,
        ownerFaction: faction,
        defense: 40,
        bonusType: 'none',
        isCapital: true,
        scoreValue: 0,
        ...bonusFields('none'),
      });

      REGION_IDS[faction].forEach((id, slot) => {
        const bonusType = SLOT_BONUSES[slot];
        const bonus = bonusFields(bonusType);
        if (slot >= 17) {
          bonus.bonusValue = 0.02;
          if (bonusType === 'resource') bonus.resourceBonus = 0.02;
        }
        territories.push({
          id,
          name: `${capitalize(faction)} ${SLOT_NAMES[slot]}`,
          ownerFaction: 'neutral',
          defense: slot < 4 ? 20 : slot < 10 ? 24 : 28,
          bonusType,
          isCapital: false,
          scoreValue: 1,
          ...bonus,
        });
      });
    });

    territories.push({
      id: 'c1',
      name: 'Crown of Sai',
      ownerFaction: 'neutral',
      defense: 45,
      bonusType: 'resource',
      isCapital: false,
      scoreValue: 3,
      bonusValue: 0.05,
      resourceBonus: 0.05,
      storageBonus: 0,
      isFortress: false,
    });
    return territories;
  }

  function buildEdges() {
    const edges = [];
    const add = (a, b) => edges.push([a, b]);

    FACTIONS.forEach((faction) => {
      const ids = REGION_IDS[faction];
      const home = ids.slice(0, 4);
      const middle = ids.slice(4, 10);
      const frontier = ids.slice(10, 20);

      home.forEach((id) => add(CAPITAL_ID[faction], id));
      for (let i = 0; i < home.length - 1; i += 1) add(home[i], home[i + 1]);
      for (let i = 0; i < middle.length - 1; i += 1) add(middle[i], middle[i + 1]);
      for (let i = 0; i < 4; i += 1) {
        add(frontier[i], frontier[i + 1]);
        add(frontier[i + 5], frontier[i + 6]);
      }
      for (let i = 0; i < 5; i += 1) add(frontier[i], frontier[i + 5]);

      add(home[0], middle[0]); add(home[0], middle[1]);
      add(home[1], middle[1]); add(home[1], middle[2]);
      add(home[2], middle[3]); add(home[2], middle[4]);
      add(home[3], middle[4]); add(home[3], middle[5]);

      add(middle[0], frontier[0]); add(middle[0], frontier[1]);
      add(middle[1], frontier[1]);
      add(middle[2], frontier[2]);
      add(middle[3], frontier[2]);
      add(middle[4], frontier[3]);
      add(middle[5], frontier[3]); add(middle[5], frontier[4]);
    });

    // Five links at every faction border create direct and outer flanking routes.
    [['blue', 'red'], ['red', 'green'], ['green', 'blue']].forEach(([left, right]) => {
      const a = REGION_IDS[left].slice(10);
      const b = REGION_IDS[right].slice(10);
      add(a[4], b[0]);
      add(a[9], b[5]);
    });

    // Every faction has two independent routes into the central Crown.
    FACTIONS.forEach((faction) => {
      const frontier = REGION_IDS[faction].slice(10);
      add(frontier[6], 'c1');
      add(frontier[8], 'c1');
    });
    return edges;
  }

  function localToXY(bearingDeg, outward, sideways = 0) {
    const angle = (bearingDeg * Math.PI) / 180;
    const sideAngle = angle + (Math.PI / 2);
    return {
      cx: Math.round(LAYOUT_CENTER.cx + (outward * Math.sin(angle)) + (sideways * Math.sin(sideAngle))),
      cy: Math.round(LAYOUT_CENTER.cy - (outward * Math.cos(angle)) - (sideways * Math.cos(sideAngle))),
    };
  }

  function buildLayout() {
    const layout = { c1: { ...LAYOUT_CENTER } };
    FACTIONS.forEach((faction) => {
      const bearing = FACTION_BEARING[faction];
      layout[CAPITAL_ID[faction]] = localToXY(bearing, 540);
      const ids = REGION_IDS[faction];
      const placeRow = (rowIds, outward, spacing) => rowIds.forEach((id, index) => {
        layout[id] = localToXY(bearing, outward, (index - ((rowIds.length - 1) / 2)) * spacing);
      });
      placeRow(ids.slice(0, 4), 425, 66);
      placeRow(ids.slice(4, 10), 305, 62);
      placeRow(ids.slice(10, 15), 190, 64);
      placeRow(ids.slice(15, 20), 105, 64);
    });
    return layout;
  }

  function buildRotationMap() {
    const rotation = { c1: 'c1' };
    FACTIONS.forEach((faction, index) => {
      const next = FACTIONS[(index + 1) % FACTIONS.length];
      rotation[CAPITAL_ID[faction]] = CAPITAL_ID[next];
      REGION_IDS[faction].forEach((id, slot) => { rotation[id] = REGION_IDS[next][slot]; });
    });
    return rotation;
  }

  return {
    TOPOLOGY_VERSION,
    FACTIONS,
    CAPITAL_ID,
    CORE_IDS,
    REGION_IDS,
    SLOT_BONUSES,
    buildTerritories,
    buildEdges,
    buildLayout,
    buildRotationMap,
    LAYOUT_VIEWBOX,
  };
}));
