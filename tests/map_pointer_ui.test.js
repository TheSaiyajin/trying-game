const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function createElement(tagName = 'div') {
  const listeners = new Map();
  const element = {
    tagName,
    style: {},
    dataset: {},
    children: [],
    parentElement: null,
    textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    appendChild(child) { child.parentElement = element; element.children.push(child); },
    replaceChildren(...children) {
      element.children = [];
      children.forEach((child) => element.appendChild(child));
    },
    setAttribute(name, value) {
      if (name === 'data-id') element.dataset.id = String(value);
    },
    setPointerCapture() {},
    getBoundingClientRect() { return { width: 360, height: 370 }; },
    dispatch(type, event = {}) {
      (listeners.get(type) || []).forEach((handler) => handler({
        pointerId: 1,
        pointerType: 'touch',
        clientX: 0,
        clientY: 0,
        target: element,
        ...event,
      }));
    },
    listenerCount(type) { return (listeners.get(type) || []).length; },
  };
  Object.defineProperty(element, 'innerHTML', {
    set() { element.children = []; },
    get() { return ''; },
  });
  return element;
}

function loadMapHarness({ mobile = true } = {}) {
  const previous = {
    document: global.document,
    window: global.window,
    localStorage: global.localStorage,
  };
  const elements = new Map();
  const svg = createElement('svg');
  const container = createElement();
  svg.parentElement = container;
  elements.set('map-svg', svg);
  elements.set('territory-panel', createElement());
  ['tp-name', 'tp-owner', 'tp-troops', 'tp-city-soldiers', 'tp-stationed', 'tp-battle-rule', 'tp-bonus', 'tp-neighbors',
    'attack-section', 'defend-section', 'recall-section', 'attack-count', 'defend-count', 'recall-count'].forEach((id) => elements.set(id, createElement()));

  global.document = {
    getElementById(id) { return elements.get(id) || createElement(); },
    createElement() { return createElement(); },
    createElementNS(namespace, tagName) { return createElement(tagName); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    body: { appendChild() {} },
  };
  global.window = { matchMedia() { return { matches: mobile }; } };
  global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  delete require.cache[require.resolve('../script.js')];
  const script = require('../script.js');
  script.setGameStateFromSnapshot({
    player: { faction: 'blue', soldiers: 50, stationedTroops: {}, resources: {}, buildings: {} },
    world: { territories: [{ id: 'n1', name: 'North', owner: 'neutral', defense: 5, neighbors: [] }] },
  });

  return {
    ...script,
    svg,
    elements,
    polygon() { return svg.children.find((child) => child.tagName === 'polygon'); },
    restore() {
      global.document = previous.document;
      global.window = previous.window;
      global.localStorage = previous.localStorage;
      delete require.cache[require.resolve('../script.js')];
    },
  };
}

test('a single touch tap selects exactly once and an immediate synthetic click is suppressed', () => {
  const harness = loadMapHarness();
  try {
    harness.renderMap();
    const polygon = harness.polygon();
    harness.svg.dispatch('pointerdown', { target: polygon, clientX: 20, clientY: 20 });
    harness.svg.dispatch('pointerup', { target: polygon, clientX: 20, clientY: 20 });
    assert.equal(harness.elements.get('territory-panel').style.display, 'block');

    harness.closeTerritoryPanel();
    polygon.dispatch('click');
    assert.equal(harness.elements.get('territory-panel').style.display, 'none');
  } finally {
    harness.restore();
  }
});

test('a touch tap with movement inside the drag threshold still selects', () => {
  const harness = loadMapHarness();
  try {
    harness.renderMap();
    const polygon = harness.polygon();
    harness.svg.dispatch('pointerdown', { target: polygon, clientX: 20, clientY: 20 });
    harness.svg.dispatch('pointermove', { target: polygon, clientX: 23, clientY: 22 });
    harness.svg.dispatch('pointerup', { target: polygon, clientX: 23, clientY: 22 });
    assert.equal(harness.elements.get('territory-panel').style.display, 'block');
  } finally {
    harness.restore();
  }
});

test('desktop mouse selection remains on the polygon click path', () => {
  const harness = loadMapHarness({ mobile: false });
  try {
    harness.renderMap();
    const polygon = harness.polygon();
    harness.svg.dispatch('pointerdown', { pointerType: 'mouse', target: polygon });
    harness.svg.dispatch('pointerup', { pointerType: 'mouse', target: polygon });
    assert.notEqual(harness.elements.get('territory-panel').style.display, 'block');
    polygon.dispatch('click', { pointerType: 'mouse' });
    assert.equal(harness.elements.get('territory-panel').style.display, 'block');
  } finally {
    harness.restore();
  }
});

test('untracked mobile pointer events do not suppress the next territory click', () => {
  const harness = loadMapHarness();
  try {
    harness.renderMap();
    const polygon = harness.polygon();
    harness.svg.dispatch('pointermove', { pointerId: 9, target: polygon });
    harness.svg.dispatch('pointerup', { pointerId: 9, target: polygon });
    harness.svg.dispatch('pointercancel', { pointerId: 9, target: polygon });
    polygon.dispatch('click');
    assert.equal(harness.elements.get('territory-panel').style.display, 'block');
  } finally {
    harness.restore();
  }
});

test('dragging past the movement threshold never selects a territory', () => {
  const harness = loadMapHarness();
  try {
    harness.renderMap();
    const polygon = harness.polygon();
    harness.svg.dispatch('pointerdown', { target: polygon, clientX: 10, clientY: 10 });
    harness.svg.dispatch('pointermove', { target: polygon, clientX: 20, clientY: 10 });
    harness.svg.dispatch('pointerup', { target: polygon, clientX: 20, clientY: 10 });
    assert.notEqual(harness.elements.get('territory-panel').style.display, 'block');
  } finally {
    harness.restore();
  }
});

test('pinching never selects a territory', () => {
  const harness = loadMapHarness();
  try {
    harness.renderMap();
    const polygon = harness.polygon();
    harness.svg.dispatch('pointerdown', { pointerId: 1, target: polygon, clientX: 10, clientY: 10 });
    harness.svg.dispatch('pointerdown', { pointerId: 2, target: polygon, clientX: 30, clientY: 10 });
    harness.svg.dispatch('pointermove', { pointerId: 2, target: polygon, clientX: 40, clientY: 10 });
    harness.svg.dispatch('pointerup', { pointerId: 1, target: polygon });
    harness.svg.dispatch('pointerup', { pointerId: 2, target: polygon });
    assert.notEqual(harness.elements.get('territory-panel').style.display, 'block');
  } finally {
    harness.restore();
  }
});

test('repeated map renders do not stack pointer listeners', () => {
  const harness = loadMapHarness();
  try {
    harness.renderMap();
    harness.renderMap();
    harness.renderMap();
    assert.equal(harness.svg.listenerCount('pointerdown'), 1);
    assert.equal(harness.svg.listenerCount('pointermove'), 1);
    assert.equal(harness.svg.listenerCount('pointerup'), 1);
  } finally {
    harness.restore();
  }
});

test('the action panel shows only valid actions and compact quantity presets', () => {
  const harness = loadMapHarness();
  try {
    harness.setGameStateFromSnapshot({
      player: { faction: 'blue', soldiers: 50, stationedTroops: {}, resources: {}, buildings: {} },
      world: { territories: [
        { id: 'b1', name: 'Blue Base', owner: 'blue', defense: 10, neighbors: ['n1'] },
        { id: 'n1', name: 'North', owner: 'neutral', defense: 5, neighbors: ['b1'] },
      ] },
    });
    harness.selectTerritory('n1');
    assert.equal(harness.elements.get('attack-section').style.display, 'block');
    assert.equal(harness.elements.get('defend-section').style.display, 'none');
    harness.changeAttack('half');
    assert.equal(harness.elements.get('attack-count').value, '25');

    harness.setGameStateFromSnapshot({
      player: { faction: 'blue', soldiers: 40, stationedTroops: { b1: 12 }, resources: {}, buildings: {} },
      world: { territories: [{ id: 'b1', name: 'Blue Base', owner: 'blue', defense: 22, neighbors: [] }] },
    });
    harness.selectTerritory('b1');
    assert.equal(harness.elements.get('attack-section').style.display, 'none');
    assert.equal(harness.elements.get('defend-section').style.display, 'block');
    assert.equal(harness.elements.get('recall-section').style.display, 'block');
    harness.changeDefend('half');
    harness.changeRecall('half');
    assert.equal(harness.elements.get('defend-count').value, '20');
    assert.equal(harness.elements.get('recall-count').value, '6');

    harness.closeTerritoryPanel();
    assert.equal(harness.elements.get('territory-panel').style.display, 'none');
  } finally {
    harness.restore();
  }
});

test('territory actions use a desktop sticky panel and mobile bottom sheet above navigation', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../style.css'), 'utf8');

  assert.match(html, /class="map-workspace"[\s\S]*?class="map-container"[\s\S]*?id="territory-panel"/);
  assert.match(html, /id="season-history-card"/);
  assert.doesNotMatch(html, /id="season-history-card"[^>]*open/);
  assert.match(html, /changeAttack\('half'\)/);
  assert.match(html, /changeDefend\('half'\)/);
  assert.match(html, /changeRecall\('half'\)/);
  assert.match(css, /@media \(min-width: 760px\)[\s\S]*?\.map-workspace \{ display: grid;[\s\S]*?\.territory-panel \{ position: sticky;/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.territory-panel \{[\s\S]*?position: fixed;[\s\S]*?bottom: calc\(var\(--nav-h\) \+ env\(safe-area-inset-bottom\)\);[\s\S]*?overflow-y: auto;/);
});