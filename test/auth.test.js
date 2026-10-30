// Sign-in (device flow), token saving and API failure classification in the service worker,
// run in a VM with fake chrome.* storage and a scripted fetch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '../src/background.js'), 'utf8');

function store(initial = {}) {
  const data = { ...initial };
  return {
    data,
    get: async (keys) => {
      const ks = keys == null ? Object.keys(data) : [].concat(keys);
      return Object.fromEntries(ks.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    set: async (o) => { Object.assign(data, o); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
  };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// `routes` maps a URL prefix to a function returning a Response; calls are recorded.
function load({ routes = {}, local = {}, session = {} } = {}) {
  const calls = [];
  const tabs = [];
  let onMessage;
  const ctx = {
    console, URLSearchParams, Response,
    setTimeout: (fn) => setImmediate(fn),
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      const key = Object.keys(routes).find((p) => url.startsWith(p));
      if (!key) throw new Error(`unexpected fetch ${url}`);
      return routes[key](url, init);
    },
    chrome: {
      storage: { local: store(local), session: store(session) },
      tabs: { create: (t) => tabs.push(t.url) },
      runtime: {
        openOptionsPage: () => tabs.push('options'),
        onInstalled: { addListener() {} },
        onMessage: { addListener: (fn) => { onMessage = fn; } },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  const send = (msg) => new Promise((resolve) => { if (!onMessage(msg, {}, resolve)) resolve(undefined); });
  return { ctx, calls, tabs, send, local: ctx.chrome.storage.local.data, session: ctx.chrome.storage.session.data };
}

const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setImmediate(r)); assert.ok(fn(), 'condition not reached'); };

test('sign-in: shows a code, waits, backs off, then stores the token and username', async () => {
  const replies = [{ error: 'authorization_pending' }, { error: 'slow_down', interval: 10 }, { access_token: 'gho_abc' }];
  const bg = load({
    routes: {
      'https://github.com/login/device/code': () => json({ device_code: 'dev1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 }),
      'https://github.com/login/oauth/access_token': () => json(replies.shift()),
      'https://api.github.com/user': (_u, init) => json({ login: init.headers.Authorization === 'Bearer gho_abc' ? 'octo' : 'wrong' }),
    },
  });
  const res = await bg.send({ type: 'signIn' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(bg.tabs, [], 'must not jump to GitHub before the user copied the code');
  assert.strictEqual(bg.session.signIn.userCode, 'ABCD-1234');

  await until(() => bg.local.token);
  assert.strictEqual(bg.local.token, 'gho_abc');
  assert.deepStrictEqual({ ...bg.local.auth }, { method: 'github', login: 'octo' });
  assert.strictEqual(bg.session.signIn, undefined);
  const deviceCall = bg.calls.find((c) => c.url.endsWith('/device/code'));
  assert.match(deviceCall.init.body.toString(), /client_id=Ov23liUs9sMejZ9ZcmZW/);
  assert.match(deviceCall.init.body.toString(), /scope=repo/);
});

test('sign-in: denial on GitHub is reported, nothing stored', async () => {
  const bg = load({
    routes: {
      'https://github.com/login/device/code': () => json({ device_code: 'dev2', user_code: 'X', verification_uri: 'u', expires_in: 900, interval: 5 }),
      'https://github.com/login/oauth/access_token': () => json({ error: 'access_denied' }),
    },
  });
  await bg.send({ type: 'signIn' });
  await until(() => bg.session.signIn?.status === 'error');
  assert.match(bg.session.signIn.error, /cancelled/);
  assert.strictEqual(bg.local.token, undefined);
});

test('sign-in: cancelling stops polling', async () => {
  let polls = 0;
  const bg = load({
    routes: {
      'https://github.com/login/device/code': () => json({ device_code: 'dev3', user_code: 'X', verification_uri: 'u', expires_in: 900, interval: 5 }),
      'https://github.com/login/oauth/access_token': () => { polls++; return json({ error: 'authorization_pending' }); },
    },
  });
  await bg.send({ type: 'signIn' });
  await until(() => polls > 0);
  await bg.send({ type: 'signInCancel' });
  const after = polls;
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.ok(polls <= after + 1, 'kept polling after cancel');
  assert.strictEqual(bg.local.token, undefined);
});

test('sign-in resumes polling after the service worker restarts', async () => {
  const bg = load({
    session: { signIn: { status: 'waiting', userCode: 'X', deviceCode: 'dev4', interval: 5, expiresAt: Date.now() + 60000 } },
    routes: {
      'https://github.com/login/oauth/access_token': () => json({ access_token: 'gho_resumed' }),
      'https://api.github.com/user': () => json({ login: 'octo' }),
    },
  });
  await until(() => bg.local.token);
  assert.strictEqual(bg.local.token, 'gho_resumed');
});

test('saveToken checks the token before storing it', async () => {
  const bg = load({ routes: { 'https://api.github.com/user': (_u, init) => (init.headers.Authorization === 'Bearer good' ? json({ login: 'octo' }) : json({ message: 'Bad credentials' }, 401)) } });
  const bad = await bg.send({ type: 'saveToken', token: 'bad' });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bg.local.token, undefined);
  const good = await bg.send({ type: 'saveToken', token: 'good' });
  assert.strictEqual(good.login, 'octo');
  assert.deepStrictEqual({ ...bg.local.auth }, { method: 'token', login: 'octo' });
});

test('signOut removes the token and username', async () => {
  const bg = load({ local: { token: 't', auth: { method: 'github', login: 'octo' } } });
  await bg.send({ type: 'signOut' });
  assert.deepStrictEqual(Object.keys(bg.local), []);
});

test('API failures are classified so the page can explain them', async () => {
  const cases = [
    ['expired sign-in', true, () => json({ message: 'Bad credentials' }, 401), { authFailed: true }],
    ['SAML SSO', true, () => json({ message: 'Resource protected by organization SAML enforcement.' }, 403, { 'x-github-sso': 'required; url=https://github.com/orgs/acme/sso?authorization_request=x' }), { ssoUrl: 'https://github.com/orgs/acme/sso?authorization_request=x' }],
    ['org restricts OAuth apps', true, () => json({ message: 'Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.' }, 403), { restrictedOrg: 'acme' }],
    ['rate limit', false, () => json({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }), { rateLimited: true, hasToken: false }],
    ['private repo, signed out', false, () => json({ message: 'Not Found' }, 404), { status: 404, hasToken: false, authFailed: false }],
  ];
  for (const [name, signedIn, reply, want] of cases) {
    const bg = load({ local: signedIn ? { token: 't' } : {}, routes: { 'https://api.github.com/': reply } });
    const res = await bg.send({ type: 'api', path: '/repos/acme/app/pulls/1' });
    assert.strictEqual(res.ok, false, name);
    for (const [k, v] of Object.entries(want)) assert.strictEqual(res[k], v, `${name}: ${k}`);
  }
});

test('signed out, public file contents come from raw.githubusercontent.com', async () => {
  const bg = load({ routes: { 'https://raw.githubusercontent.com/': () => new Response('class A {}') } });
  const res = await bg.send({ type: 'api', path: '/repos/o/r/contents/src/A.java?ref=abc123', raw: true });
  assert.strictEqual(res.data, 'class A {}');
  assert.strictEqual(bg.calls[0].url, 'https://raw.githubusercontent.com/o/r/abc123/src/A.java');
});
