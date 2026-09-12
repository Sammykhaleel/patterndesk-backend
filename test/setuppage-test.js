'use strict';

/**
 * The rescue page's own behaviour.
 *
 * It runs in a browser, so nothing else in this suite would notice it
 * breaking — and the one time it matters is when every frontend is already
 * locked out. So its script is executed here against a small DOM stub rather
 * than being checked by reading it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { setupPage } = require('../setuppage');

const HTML = setupPage();
const SCRIPT = (HTML.match(/<script>([\s\S]*?)<\/script>/) || [])[1];

const OLD = 'https://heartfelt-sundae-eca675.netlify.app';
const NEW = 'https://gorgeous-blancmange-1eab4d.netlify.app';

/** Just enough DOM for this page: ids it asks for, and nodes it builds. */
function mkNode(tag = 'div') {
  const node = {
    tag, textContent: '', className: '', value: '', hidden: false,
    checked: false, onclick: null, children: [],
    appendChild(n) { this.children.push(n); return n; },
    addEventListener() {},
  };
  // A browser drops the children when innerHTML is cleared, and the page
  // relies on that to re-render the list. A plain string property would let
  // rows accumulate and quietly pass a test that counted them.
  let html = '';
  Object.defineProperty(node, 'innerHTML', {
    get() { return html; },
    set(v) { html = String(v); if (html === '') node.children.length = 0; },
  });
  return node;
}

function run({ hash = '', origins = [OLD, NEW], persists = true, confirmAnswer = true } = {}) {
  const ids = ['token', 'remember', 'load', 'authMsg', 'listCard', 'newOrigin', 'add', 'list', 'listMsg', 'persistNote'];
  const els = Object.fromEntries(ids.map((id) => [id, mkNode()]));
  els.listCard.hidden = true;   // <div id="listCard" hidden> in the markup
  const calls = [];
  const confirms = [];
  const store = {};

  const ctx = {
    document: {
      getElementById: (id) => els[id] || null,
      createElement: (tag) => mkNode(tag),
    },
    location: { hash },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    confirm: (msg) => { confirms.push(msg); return confirmAnswer; },
    fetch: async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      calls.push({ url, method: (init && init.method) || 'GET', body, token: init.headers['X-Auth-Token'] });
      if (body && body.remove) origins = origins.filter((o) => o !== body.remove);
      if (body && body.add && !origins.includes(body.add)) origins = [...origins, body.add];
      return { ok: true, async json() { return { success: true, allowed: { origins, persistsAcrossRestart: persists } }; } };
    },
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  return { els, calls, confirms, store, list: () => els.list.children };
}

/** The page renders nothing until a token is accepted, so every test starts here. */
async function loaded(opts) {
  const h = run(opts);
  h.els.token.value = 'a'.repeat(64);
  await h.els.load.onclick();
  return h;
}

test('the page script parses and runs', () => {
  assert.ok(SCRIPT, 'there is an inline script');
  assert.doesNotThrow(() => run());
});

test('nothing is shown until a token is accepted', async () => {
  const h = run();
  await h.els.load.onclick();
  assert.equal(h.calls.length, 0, 'no token, no request');
  assert.match(h.els.authMsg.textContent, /Enter the auth token/);
  assert.equal(h.els.listCard.hidden, true, 'and the list stays hidden');
});

test('the list appears once the token works', async () => {
  const h = await loaded();
  assert.equal(h.calls[0].url, '/api/origins');
  assert.equal(h.calls[0].token, 'a'.repeat(64), 'sent in the header, not the URL');
  assert.equal(h.els.listCard.hidden, false);
  assert.equal(h.list().length, 2, 'both origins rendered');
  assert.match(h.els.persistNote.textContent, /survive a restart/);
});

test('the address that sent you here is labelled', async () => {
  // This page is served by the backend, so which frontend you are actually
  // running is not otherwise knowable from it — and it is the one fact you
  // need before deleting one of two near-identical URLs.
  const h = await loaded({ hash: `#origin=${encodeURIComponent(NEW)}` });
  const badges = h.list().map((li) => li.children.filter((c) => c.className === 'badge').map((b) => b.textContent));
  assert.deepEqual(badges, [[], ['you came from here']], 'exactly the one you arrived from');
});

test('with no fragment nothing is labelled', async () => {
  const h = await loaded();
  const badged = h.list().filter((li) => li.children.some((c) => c.className === 'badge'));
  assert.equal(badged.length, 0, 'guessing would be worse than saying nothing');
});

test('the box arrives prefilled from the fragment', async () => {
  const h = await loaded({ hash: `#origin=${encodeURIComponent(NEW)}` });
  assert.equal(h.els.newOrigin.value, NEW, 'so a Netlify address need not be retyped on a phone');
});

test('removing asks first, and declining sends nothing', async () => {
  const h = await loaded({ confirmAnswer: false });
  const before = h.calls.length;
  const removeBtn = h.list()[0].children.find((c) => c.textContent === 'remove');
  removeBtn.onclick();

  assert.equal(h.confirms.length, 1, 'it asked');
  assert.match(h.confirms[0], new RegExp(OLD.replace(/[.]/g, '\\.')), 'naming the address');
  assert.match(h.confirms[0], /blocked from this backend immediately/, 'and the consequence');
  assert.equal(h.calls.length, before, 'and nothing was sent');
});

test('removing the site you came from warns that it is yours', async () => {
  const h = await loaded({ hash: `#origin=${encodeURIComponent(NEW)}`, confirmAnswer: false });
  const mine = h.list().find((li) => li.children.some((c) => c.className === 'badge'));
  mine.children.find((c) => c.textContent === 'remove').onclick();
  assert.match(h.confirms[0], /site you came from/);
  assert.match(h.confirms[0], /until you add it back/, 'and that it is recoverable, so the warning is not just alarming');
});

test('accepting the confirmation does remove it', async () => {
  const h = await loaded({ confirmAnswer: true });
  h.list()[0].children.find((c) => c.textContent === 'remove').onclick();
  await new Promise((r) => setTimeout(r, 0));

  const post = h.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, { remove: OLD });
  assert.equal(h.list().length, 1, 'and the list re-renders without it');
  assert.match(h.els.listMsg.textContent, /Removed/);
});

test('adding sends the pasted value and clears the box', async () => {
  const h = await loaded({ origins: [OLD] });
  h.els.newOrigin.value = `${NEW}/charts?tf=15m`;
  h.els.add.onclick();
  await new Promise((r) => setTimeout(r, 0));

  const post = h.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post.body, { add: `${NEW}/charts?tf=15m` }, 'the server does the normalising, not the page');
  assert.equal(h.els.newOrigin.value, '', 'the box is cleared so a second tap cannot re-add it');
});

test('adding nothing says so rather than sending an empty request', async () => {
  const h = await loaded();
  const before = h.calls.length;
  h.els.newOrigin.value = '   ';
  h.els.add.onclick();
  assert.equal(h.calls.length, before);
  assert.match(h.els.listMsg.textContent, /Paste an address first/);
});

test('a server with no disk says the change is temporary', async () => {
  const h = await loaded({ persists: false });
  assert.match(h.els.persistNote.textContent, /no disk/);
  assert.doesNotMatch(h.els.persistNote.textContent, /survive a restart/);
});

test('an empty list is stated rather than shown as a blank card', async () => {
  const h = await loaded({ origins: [] });
  assert.equal(h.list().length, 1, 'one row of explanation');
  assert.match(h.list()[0].innerHTML, /every browser is locked out/i);
});

test('the token is only stored when asked for', async () => {
  const h = run();
  h.els.token.value = 'b'.repeat(64);
  h.els.remember.checked = false;
  await h.els.load.onclick();
  assert.equal(h.store['pd-setup-token'], undefined, 'unticked means it does not touch storage');

  const h2 = run();
  h2.els.token.value = 'b'.repeat(64);
  h2.els.remember.checked = true;
  await h2.els.load.onclick();
  assert.equal(h2.store['pd-setup-token'], 'b'.repeat(64));
});

test('a 401 leaves nothing on screen to act on', async () => {
  const ids = ['token', 'remember', 'load', 'authMsg', 'listCard', 'newOrigin', 'add', 'list', 'listMsg', 'persistNote'];
  const els = Object.fromEntries(ids.map((id) => [id, mkNode()]));
  const ctx = {
    document: { getElementById: (id) => els[id] || null, createElement: (t) => mkNode(t) },
    location: { hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    confirm: () => true,
    fetch: async () => ({ ok: false, status: 401, async json() { return { success: false }; } }),
    console,
  };
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);

  els.token.value = 'd'.repeat(64);
  await els.load.onclick();
  assert.match(els.authMsg.textContent, /401|token rejected/);
  assert.equal(els.listCard.hidden, true, 'no list, so nothing can be changed on a bad token');
});
