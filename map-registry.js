// Stable map registry. Map definitions are never overwritten or deleted; seasons store a
// map key and rotation selects the next entry. Works in Node and in the browser.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./world-topology'), require('./crownlands-topology'));
  } else {
    root.MAP_REGISTRY = factory(root.WORLD_TOPOLOGY, root.CROWNLANDS_TOPOLOGY);
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (classicTopology, crownlandsTopology) {
  const maps = [
    { key: 'three-frontiers', name: 'Three Frontiers', topology: classicTopology },
    { key: 'crownlands-64', name: 'Crownlands 64', topology: crownlandsTopology },
  ];
  const DEFAULT_MAP_KEY = maps[0].key;

  function getMap(mapKey) {
    return maps.find((entry) => entry.key === mapKey) || maps[0];
  }

  function getNextMapKey(mapKey) {
    const index = maps.findIndex((entry) => entry.key === mapKey);
    return maps[(index < 0 ? 0 : index + 1) % maps.length].key;
  }

  return {
    DEFAULT_MAP_KEY,
    maps: maps.map(({ key, name }) => ({ key, name })),
    getMap,
    getNextMapKey,
  };
}));