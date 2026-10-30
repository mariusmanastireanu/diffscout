// What the page shows when a Cmd/Ctrl+click hits a GitHub API failure: the message and the fix-it button.
// Runs the real content script in a VM with a fake click and a scripted API reply.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const SRC = [read('src/resolver.js'), read('src/content.js')];

async function clickWithFailure(failure) {
  const sent = [];
  const toasts = [];
  const listeners = {};
  const line = '    Invoice invoice = new Invoice();';
  const cell = { id: '', dataset: {}, getAttribute: () => null, closest: () => true, parentElement: null, tagName: 'TD' };
  const text = { nodeType: 3, textContent: line, parentElement: cell };
  const el = (tag) => {
    const node = { tag, children: [], classList: { add() {}, remove() {}, toggle() {} }, appendChild: (c) => node.children.push(c) };
    let t = '';
    Object.defineProperty(node, 'textContent', { get: () => t, set: (v) => { t = v; node.children = []; if (tag === 'div') toasts.push(node); } });
    return node;
  };
  const ctx = {
    console, setTimeout, clearTimeout, URL, TextEncoder, crypto: globalThis.crypto,
    navigator: { platform: 'MacIntel' },
    location: { pathname: '/acme/app/pull/7/changes' },
    history: { pushState() {} },
    Node: { TEXT_NODE: 3 },
    CSS: {},
    chrome: { runtime: { sendMessage: async (m) => { sent.push(m); return m.type === 'api' ? { ok: false, ...failure } : undefined; } } },
    document: {
      addEventListener: (t, fn) => { listeners[t] = fn; },
      documentElement: { appendChild() {}, classList: { add() {}, remove() {} } },
      createElement: el,
      caretPositionFromPoint: () => ({ offsetNode: text, offset: line.indexOf('Invoice') + 1 }),
      createRange: () => { let end = 0; return { setStart() {}, setEnd(_n, o) { end = o; }, toString: () => line.slice(0, end), getClientRects: () => [{ left: 0, right: 100, top: 0, bottom: 20 }] }; },
      getElementById: () => null,
    },
    window: { addEventListener() {} },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const s of SRC) vm.runInContext(s, ctx);
  await listeners.click({ metaKey: true, button: 0, clientX: 10, clientY: 10, preventDefault() {}, stopImmediatePropagation() {} });
  const last = toasts[toasts.length - 1];
  const button = last.children[0];
  return { message: last.textContent, button: button?.textContent, press: () => { button.onclick(); return sent[sent.length - 1]; } };
}

test('private repo while signed out offers Sign in', async () => {
  const t = await clickWithFailure({ status: 404, hasToken: false });
  assert.match(t.message, /private repository/);
  assert.strictEqual(t.button, 'Sign in');
  assert.deepStrictEqual({ ...t.press() }, { type: 'openOptions' });
});

test('expired sign-in offers Sign in again', async () => {
  const t = await clickWithFailure({ status: 401, hasToken: true, authFailed: true });
  assert.match(t.message, /expired or was revoked/);
  assert.strictEqual(t.button, 'Sign in again');
});

test('SAML SSO offers Authorize, opening the SSO page', async () => {
  const t = await clickWithFailure({ status: 403, hasToken: true, ssoUrl: 'https://github.com/orgs/acme/sso?x' });
  assert.strictEqual(t.button, 'Authorize');
  assert.deepStrictEqual({ ...t.press() }, { type: 'openTab', url: 'https://github.com/orgs/acme/sso?x' });
});

test('org that restricts OAuth apps offers Request access', async () => {
  const t = await clickWithFailure({ status: 403, hasToken: true, restrictedOrg: 'acme' });
  assert.match(t.message, /acme restricts third-party apps/);
  assert.deepStrictEqual({ ...t.press() }, { type: 'openAppSettings' });
});

test('rate limit: signed out suggests signing in, signed in just says wait', async () => {
  const out = await clickWithFailure({ status: 403, hasToken: false, rateLimited: true });
  assert.strictEqual(out.button, 'Sign in');
  const inn = await clickWithFailure({ status: 403, hasToken: true, rateLimited: true });
  assert.match(inn.message, /Try again in a few minutes/);
  assert.strictEqual(inn.button, undefined);
});
