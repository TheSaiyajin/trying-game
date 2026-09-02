const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadChangelog,
  renderChangelogEntries,
  openChangelogModal,
} = require('../script');

function createElement(tagName = 'div') {
  return {
    tagName,
    className: '',
    textContent: '',
    children: [],
    hidden: true,
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    get childElementCount() { return this.children.length; },
    querySelector() { return { focus() {} }; },
  };
}

test('changelog button and accessible modal follow the Info modal controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

  assert.match(html, /id="info-btn"[\s\S]*id="changelog-btn"[\s\S]*id="logout-btn"/);
  assert.match(html, /id="changelog-modal" role="dialog" aria-modal="true" aria-labelledby="changelog-modal-title" hidden/);
  assert.match(html, /aria-label="Close changelog"/);
  assert.match(html, /closeChangelogModalFromBackdrop\(event\)/);
  assert.match(script, /event\.key === 'Escape'[\s\S]*closeChangelogModal\(\)/);
});

test('changelog loads newest-first data without browser caching', async () => {
  const previousFetch = global.fetch;
  let request = null;
  global.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, async json() { return [{ title: 'Newest', changes: [] }]; } };
  };

  try {
    assert.deepEqual(await loadChangelog(), [{ title: 'Newest', changes: [] }]);
    assert.match(request.url, /^changelog\.json\?\d+$/);
    assert.equal(request.options.cache, 'no-store');
  } finally {
    global.fetch = previousFetch;
  }
});

test('changelog entries render through textContent and preserve untrusted text', () => {
  const previousDocument = global.document;
  const container = createElement();
  global.document = {
    getElementById(id) { return id === 'changelog-entries' ? container : null; },
    createElement,
  };

  try {
    renderChangelogEntries([{ title: '<b>Title</b>', changes: ['<script>alert(1)</script>'] }]);
    assert.equal(container.children[0].children[0].textContent, '<b>Title</b>');
    assert.equal(container.children[0].children[1].children[0].textContent, '<script>alert(1)</script>');
  } finally {
    global.document = previousDocument;
  }
});

test('changelog loading failure shows a friendly message without throwing', async () => {
  const previousDocument = global.document;
  const previousFetch = global.fetch;
  const modal = createElement();
  const container = createElement();
  global.document = {
    getElementById(id) {
      if (id === 'changelog-modal') return modal;
      if (id === 'changelog-entries') return container;
      return null;
    },
    createElement,
  };
  global.fetch = async () => ({ ok: false });

  try {
    await openChangelogModal();
    assert.equal(modal.hidden, false);
    assert.equal(container.children[0].textContent, 'The changelog is unavailable right now. Please try again later.');
  } finally {
    global.document = previousDocument;
    global.fetch = previousFetch;
  }
});

test('initial changelog entry contains only simple player-facing information', () => {
  const entries = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'changelog.json'), 'utf8'));
  assert.deepEqual(entries, [{
    title: 'Storage and resource balancing',
    changes: [
      'Added a Storage building that increases resource capacity.',
      'Balanced building upgrade costs and limited building progression.',
      'Balanced the resources required to train soldiers.',
      'Territory storage bonuses now scale with upgraded storage.',
      'Made faction bonus information clearer.',
      'All Resources bonuses now improve production without increasing storage capacity.',
    ],
  }]);
  assert.deepEqual(Object.keys(entries[0]), ['title', 'changes']);
});