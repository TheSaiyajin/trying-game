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
    rect: { left: 0, top: 0, width: 360, height: 370 },
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
    getBoundingClientRect() { return element.rect; },
    dispatch(type, event = {}) {
      (listeners.get(type) || []).forEach((handler) => handler({
        pointerId: 1,
        pointerType: 'touch',
        clientX: 0,
        clientY: 0,
        target: element,
        preventDefault() {},
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
  const windowListeners = new Map();
  global.window = {
    matchMedia() { return { matches: mobile }; },
    addEventListener(type, handler) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(handler);
    },
  };
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
    windowListenerCount(type) { return (windowListeners.get(type) || []).length; },
    dispatchWindow(type, event = {}) { (windowListeners.get(type) || []).forEach((handler) => handler(event)); },
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
    assert.equal(harness.svg.listenerCount('mousedown'), 1);
    assert.equal(harness.svg.listenerCount('wheel'), 1);
    assert.equal(harness.svg.listenerCount('contextmenu'), 1);
    assert.equal(harness.windowListenerCount('resize'), 1);
    assert.equal(harness.windowListenerCount('mousemove'), 1);
    assert.equal(harness.windowListenerCount('mouseup'), 1);
    assert.equal(harness.windowListenerCount('blur'), 1);
    assert.equal(harness.windowListenerCount('pointercancel'), 1);
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

test('desktop wheel zooms toward the cursor and stays between 1x and 3x', () => {
  const harness = loadMapHarness({ mobile: false });
  try {
    harness.renderMap();
    const preventions = [];
    for (let index = 0; index < 15; index += 1) {
      harness.svg.dispatch('wheel', {
        deltaY: -100,
        clientX: 320,
        clientY: 185,
        preventDefault() { preventions.push(true); },
      });
    }
    assert.match(harness.svg.style.transform, /translate\(-?\d+(?:\.\d+)?px, -?\d+(?:\.\d+)?px\) scale\(3\)/);
    assert.doesNotMatch(harness.svg.style.transform, /translate\(0px, 0px\)/);
    assert.equal(preventions.length, 15);

    for (let index = 0; index < 20; index += 1) {
      harness.svg.dispatch('wheel', { deltaY: 100, clientX: 320, clientY: 185 });
    }
    assert.match(harness.svg.style.transform, /scale\(1\)$/);
  } finally {
    harness.restore();
  }
});

test('desktop resize re-clamps the zoomed map inside its container', () => {
  const harness = loadMapHarness({ mobile: false });
  try {
    harness.renderMap();
    for (let index = 0; index < 5; index += 1) {
      harness.svg.dispatch('wheel', { deltaY: -100, clientX: 360, clientY: 185 });
    }
    harness.svg.parentElement.rect = { left: 0, top: 0, width: 100, height: 100 };
    harness.dispatchWindow('resize');
    const translateX = Number(harness.svg.style.transform.match(/translate\((-?\d+(?:\.\d+)?)px/)?.[1]);
    assert.ok(Math.abs(translateX) <= 50);
  } finally {
    harness.restore();
  }
});

test('Season History exists once under the fourth Activity tab and reuses its renderer', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../script.js'), 'utf8');
  const mapMarkup = html.match(/id="screen-map"[\s\S]*?id="screen-activity"/)?.[0] || '';
  const activityMarkup = html.match(/id="screen-activity"[\s\S]*?id="screen-admin"/)?.[0] || '';

  assert.doesNotMatch(mapMarkup, /season-history-card|season-history-list/);
  assert.match(activityMarkup, /id="activity-tab-seasons"[\s\S]*?id="activity-panel-seasons"[\s\S]*?id="season-history-card"[\s\S]*?id="season-history-list"/);
  assert.equal((html.match(/id="season-history-list"/g) || []).length, 1);
  assert.match(script, /activeActivityTab === 'seasons'[\s\S]*?await renderSeasonHistory\(\)/);
  assert.doesNotMatch(script, /if \(name === 'map'\)[^{\n]*renderSeasonHistory/);
});

test('desktop map consumes the available screen height without overflow', () => {
  const css = fs.readFileSync(path.join(__dirname, '../style.css'), 'utf8');

  assert.match(css, /@media \(min-width: 760px\)[\s\S]*?#screen-map\.active \{ display: flex; flex-direction: column; overflow: hidden; \}/);
  assert.match(css, /\.map-workspace \{[^}]*flex: 1;[^}]*min-height: 0;[^}]*overflow: hidden;/);
  assert.match(css, /\.map-container \{[^}]*height: 100%;[^}]*overflow: hidden;/);
  assert.match(css, /#map-svg \{[^}]*width: 100%;[^}]*height: 100%;[^}]*max-height: 100%;/);
  assert.match(css, /\.territory-panel \{[^}]*max-height: 100%;[^}]*overflow-y: auto;/);
  assert.match(css, /\.activity-tabs \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
});

test('desktop right-drag pans through window mouse events with clamping and no selection', () => {
  const harness = loadMapHarness({ mobile: false });
  try {
    harness.renderMap();
    for (let index = 0; index < 5; index += 1) {
      harness.svg.dispatch('wheel', { deltaY: -100, clientX: 180, clientY: 185 });
    }
    harness.svg.dispatch('mousedown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    assert.equal(harness.svg.style.cursor, 'grabbing');
    harness.dispatchWindow('mousemove', { buttons: 2, clientX: 1000, clientY: 1000 });
    const translation = harness.svg.style.transform.match(/translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)/);
    assert.ok(Math.abs(Number(translation[1])) <= 180);
    assert.ok(Math.abs(Number(translation[2])) <= 185);
    assert.notEqual(harness.elements.get('territory-panel').style.display, 'block');
    harness.dispatchWindow('mouseup', { button: 2, buttons: 0 });
    assert.equal(harness.svg.style.cursor, '');
    harness.polygon().dispatch('click', { button: 0 });
    assert.equal(harness.elements.get('territory-panel').style.display, 'block');
  } finally {
    harness.restore();
  }
});

test('right mouse does not pan at 1x and lost button, blur, or cancel stop active pans', () => {
  const harness = loadMapHarness({ mobile: false });
  try {
    harness.renderMap();
    const initialTransform = harness.svg.style.transform;
    harness.svg.dispatch('mousedown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
    harness.dispatchWindow('mousemove', { buttons: 2, clientX: 200, clientY: 200 });
    assert.equal(harness.svg.style.transform, initialTransform);
    assert.notEqual(harness.svg.style.cursor, 'grabbing');
    harness.svg.dispatch('wheel', { deltaY: -100, clientX: 180, clientY: 185 });
    for (const endEvent of ['mousemove', 'blur', 'pointercancel']) {
      harness.svg.dispatch('mousedown', { button: 2, buttons: 2, clientX: 100, clientY: 100 });
      assert.equal(harness.svg.style.cursor, 'grabbing');
      harness.dispatchWindow(endEvent, endEvent === 'mousemove' ? { buttons: 0, clientX: 200, clientY: 200 } : {});
      assert.equal(harness.svg.style.cursor, '');
    }
  } finally {
    harness.restore();
  }
});

test('context menu is prevented by the map handler only', () => {
  const harness = loadMapHarness({ mobile: false });
  try {
    harness.renderMap();
    let prevented = false;
    harness.svg.dispatch('contextmenu', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(harness.windowListenerCount('contextmenu'), 0);
  } finally {
    harness.restore();
  }
});