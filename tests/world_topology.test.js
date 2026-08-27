const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const topology = require('../world-topology');
const topologySql = require('../backend/topology-sql');

function buildAdjacency(edges) {
  const adj = {};
  edges.forEach(([a, b]) => {
    (adj[a] = adj[a] || []).push(b);
    (adj[b] = adj[b] || []).push(a);
  });
  return adj;
}

function bfsDistances(adj, start) {
  const dist = { [start]: 0 };
  const queue = [start];
  while (queue.length) {
    const current = queue.shift();
    for (const neighbor of adj[current] || []) {
      if (!(neighbor in dist)) {
        dist[neighbor] = dist[current] + 1;
        queue.push(neighbor);
      }
    }
  }
  return dist;
}

function segmentsProperlyIntersect(p1, p2, p3, p4) {
  const cross = (o, a, b) => ((a.cx - o.cx) * (b.cy - o.cy)) - ((a.cy - o.cy) * (b.cx - o.cx));
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  const straddles = (x, y) => (x > 0 && y < 0) || (x < 0 && y > 0);
  return straddles(d1, d2) && straddles(d3, d4);
}

test('topology has exactly three capitals and 30 neutral territories', () => {
  const territories = topology.buildTerritories();
  assert.equal(territories.length, 33);
  assert.equal(territories.filter((t) => t.isCapital).length, 3);
  assert.equal(territories.filter((t) => t.ownerFaction === 'neutral').length, 30);
});

test('each faction has exactly one capital', () => {
  const territories = topology.buildTerritories();
  for (const faction of topology.FACTIONS) {
    const capitals = territories.filter((t) => t.isCapital && t.ownerFaction === faction);
    assert.equal(capitals.length, 1, `${faction} should have exactly one capital`);
  }
});

test('the graph is fully connected', () => {
  const territories = topology.buildTerritories();
  const edges = topology.buildEdges();
  const adj = buildAdjacency(edges);
  const ids = territories.map((t) => t.id);
  const dist = bfsDistances(adj, ids[0]);
  assert.equal(Object.keys(dist).length, ids.length);
  assert.ok(ids.every((id) => id in dist));
});

test('all edges are reciprocal, with no duplicates or self-edges', () => {
  const edges = topology.buildEdges();
  const seen = new Set();
  for (const [a, b] of edges) {
    assert.notEqual(a, b, 'no self-edges allowed');
    const key = [a, b].sort().join('|');
    assert.ok(!seen.has(key), `duplicate edge: ${a} <-> ${b}`);
    seen.add(key);
  }

  // Consumers (world-seed.sql, the migration) expand every undirected edge into both
  // directions; confirm that expansion is reciprocal with no duplicate directed rows.
  const directedRows = topologySql.buildNeighborRows();
  const directedSet = new Set(directedRows.map(([a, b]) => `${a}->${b}`));
  assert.equal(directedRows.length, directedSet.size, 'no duplicate directed neighbor rows');
  for (const [a, b] of directedRows) {
    assert.ok(directedSet.has(`${b}->${a}`), `missing reciprocal row for ${a} -> ${b}`);
  }
});

test('most territories have between 2 and 4 neighbors', () => {
  const edges = topology.buildEdges();
  const degree = {};
  edges.forEach(([a, b]) => {
    degree[a] = (degree[a] || 0) + 1;
    degree[b] = (degree[b] || 0) + 1;
  });
  const degrees = Object.values(degree);
  assert.ok(degrees.every((d) => d >= 2 && d <= 4), 'every territory should have 2-4 neighbors');
});

test('no capital connects directly to another capital', () => {
  const edges = topology.buildEdges();
  const capitalIds = new Set(Object.values(topology.CAPITAL_ID));
  for (const [a, b] of edges) {
    if (capitalIds.has(a) && capitalIds.has(b)) {
      assert.fail(`capitals must never be directly connected: ${a} <-> ${b}`);
    }
  }
});

test('each capital only connects to its own three home territories', () => {
  const edges = topology.buildEdges();
  topology.FACTIONS.forEach((faction) => {
    const capital = topology.CAPITAL_ID[faction];
    const neighbors = edges
      .filter(([a, b]) => a === capital || b === capital)
      .map(([a, b]) => (a === capital ? b : a));
    assert.equal(neighbors.length, 3);
    assert.deepEqual([...neighbors].sort(), [...topology.HOME_IDS[faction]].sort());
  });
});

test('Blue, Red, and Green have identical rotated graph structures', () => {
  const edges = topology.buildEdges();
  const edgeSet = new Set(edges.map(([a, b]) => [a, b].sort().join('|')));
  const rotate = topology.buildRotationMap();

  // Applying the 120-degree rotation to every edge must yield another edge already in the
  // graph -- i.e. the rotation is a graph automorphism, proving all three factions share
  // exactly the same (merely rotated) structure.
  for (const [a, b] of edges) {
    const rotatedKey = [rotate[a], rotate[b]].sort().join('|');
    assert.ok(edgeSet.has(rotatedKey), `rotation is not an automorphism at edge ${a}-${b}`);
  }
});

test('each faction has the same number of home, frontier, border, and core routes', () => {
  const edges = topology.buildEdges();
  topology.FACTIONS.forEach((faction) => {
    const capital = topology.CAPITAL_ID[faction];
    const homeIds = new Set(topology.HOME_IDS[faction]);
    const frontierIds = new Set(topology.FRONTIER_IDS[faction]);

    const capitalToHome = edges.filter(([a, b]) => (a === capital && homeIds.has(b)) || (b === capital && homeIds.has(a)));
    const homeInternal = edges.filter(([a, b]) => homeIds.has(a) && homeIds.has(b));
    const homeToFrontier = edges.filter(([a, b]) => (homeIds.has(a) && frontierIds.has(b)) || (homeIds.has(b) && frontierIds.has(a)));
    const frontierInternal = edges.filter(([a, b]) => frontierIds.has(a) && frontierIds.has(b));

    assert.equal(capitalToHome.length, 3);
    assert.equal(homeInternal.length, 2);
    assert.equal(homeToFrontier.length, 3);
    assert.equal(frontierInternal.length, 2);
  });
});

test('all capitals have equal shortest-path distance to the nearest border and to the core', () => {
  const edges = topology.buildEdges();
  const adj = buildAdjacency(edges);
  const borderIds = topology.BORDER_PAIRS.flatMap((pair) => pair.ids);

  const distances = topology.FACTIONS.map((faction) => {
    const dist = bfsDistances(adj, topology.CAPITAL_ID[faction]);
    return {
      faction,
      toBorder: Math.min(...borderIds.map((id) => dist[id])),
      toCore: Math.min(...topology.CORE_IDS.map((id) => dist[id])),
    };
  });

  const [first, ...rest] = distances;
  for (const entry of rest) {
    assert.equal(entry.toBorder, first.toBorder, `${entry.faction} border distance differs from ${first.faction}`);
    assert.equal(entry.toCore, first.toCore, `${entry.faction} core distance differs from ${first.faction}`);
  }
});

test('every faction has an equal shortest-path distance to both opposing factions (no shortcuts)', () => {
  const edges = topology.buildEdges();
  const adj = buildAdjacency(edges);

  topology.FACTIONS.forEach((faction) => {
    const dist = bfsDistances(adj, topology.CAPITAL_ID[faction]);
    const others = topology.FACTIONS.filter((f) => f !== faction);
    const distancesToOthers = others.map((other) => dist[topology.CAPITAL_ID[other]]);
    assert.equal(distancesToOthers[0], distancesToOthers[1], `${faction} has an unequal distance to its two opponents`);
  });
});

test('equivalent faction paths contain equivalent bonus types and defender totals', () => {
  const territories = topology.buildTerritories();
  const byId = Object.fromEntries(territories.map((t) => [t.id, t]));

  const homeBonusSets = topology.FACTIONS.map((faction) => (
    new Set(topology.HOME_IDS[faction].map((id) => byId[id].bonusType))
  ));
  const frontierBonusSets = topology.FACTIONS.map((faction) => (
    new Set(topology.FRONTIER_IDS[faction].map((id) => byId[id].bonusType))
  ));
  const homeDefenseTotals = topology.FACTIONS.map((faction) => (
    topology.HOME_IDS[faction].reduce((sum, id) => sum + byId[id].defense, 0)
  ));
  const frontierDefenseTotals = topology.FACTIONS.map((faction) => (
    topology.FRONTIER_IDS[faction].reduce((sum, id) => sum + byId[id].defense, 0)
  ));

  homeBonusSets.forEach((set) => assert.deepEqual([...set].sort(), [...homeBonusSets[0]].sort()));
  frontierBonusSets.forEach((set) => assert.deepEqual([...set].sort(), [...frontierBonusSets[0]].sort()));
  homeDefenseTotals.forEach((total) => assert.equal(total, homeDefenseTotals[0]));
  frontierDefenseTotals.forEach((total) => assert.equal(total, frontierDefenseTotals[0]));

  const capitals = territories.filter((t) => t.isCapital);
  capitals.forEach((capital) => {
    assert.equal(capital.defense, capitals[0].defense);
    assert.equal(capital.bonusType, capitals[0].bonusType);
    assert.equal(capital.bonusValue, capitals[0].bonusValue);
  });
});

test('no unrelated connection lines geometrically intersect in the SVG layout', () => {
  const layout = topology.buildLayout();
  const edges = topology.buildEdges();

  let crossings = 0;
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      const [a1, a2] = edges[i];
      const [b1, b2] = edges[j];
      if ([a1, a2].includes(b1) || [a1, a2].includes(b2)) continue; // shares an endpoint
      if (segmentsProperlyIntersect(layout[a1], layout[a2], layout[b1], layout[b2])) {
        crossings += 1;
      }
    }
  }
  assert.equal(crossings, 0);
});

test('layout keeps enough spacing between territory centers for hexes, crowns, and labels', () => {
  const layout = topology.buildLayout();
  const ids = Object.keys(layout);
  const MIN_SPACING = 40;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = layout[ids[i]];
      const b = layout[ids[j]];
      const distance = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      assert.ok(distance >= MIN_SPACING, `${ids[i]} and ${ids[j]} are only ${distance.toFixed(1)}px apart`);
    }
  }
});

test('world-seed.sql exactly matches the canonical topology generator (no drift)', () => {
  const seedPath = path.join(__dirname, '../backend/world-seed.sql');
  const seedContent = fs.readFileSync(seedPath, 'utf8');

  assert.ok(seedContent.includes(topologySql.buildTerritoryValuesSQL()), 'territories block does not match the generator');
  assert.ok(seedContent.includes(topologySql.buildNeighborValuesSQL()), 'neighbors block does not match the generator');
  assert.ok(!seedContent.toUpperCase().includes('DELETE FROM PLAYERS'));
  assert.ok(!seedContent.toUpperCase().includes('DELETE FROM BUILDINGS'));
});
