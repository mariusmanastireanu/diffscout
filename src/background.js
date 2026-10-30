// Service worker: the only place the GitHub token is read, so it never enters the page.
// Also runs "Sign in with GitHub" (OAuth device flow), which needs no client secret.

const CLIENT_ID = 'Ov23liUs9sMejZ9ZcmZW';
const APP_SETTINGS_URL = `https://github.com/settings/connections/applications/${CLIENT_ID}`;

async function githubApi({ path, raw }) {
  const { token } = await chrome.storage.local.get('token');
  const headers = {
    Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Without a token, read public file contents from raw.githubusercontent.com: it doesn't count against
  // the 60 requests/hour anonymous API limit.
  const contents = /^\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)\?ref=([0-9a-f]+)$/.exec(path);
  const url = raw && !token && contents
    ? `https://raw.githubusercontent.com/${contents[1]}/${contents[2]}/${contents[4]}/${contents[3]}`
    : `https://api.github.com${path}`;
  const res = await fetch(url, { headers: url.startsWith('https://api.') ? headers : {} });
  if (!res.ok) return { ok: false, ...(await describeFailure(res, !!token)) };
  return { ok: true, data: raw ? await res.text() : await res.json() };
}

// Turn a failed response into something the page can explain: expired sign-in, SAML SSO, an org that
// restricts OAuth apps, or the rate limit.
async function describeFailure(res, hasToken) {
  const message = res.headers.get('content-type')?.includes('json') ? (await res.json().catch(() => ({}))).message || '' : '';
  const sso = /url=(\S+)/.exec(res.headers.get('x-github-sso') || '');
  const restricted = /`([^`]+)` organization has enabled OAuth App access restrictions/.exec(message);
  return {
    status: res.status,
    hasToken,
    rateLimited: res.headers.get('x-ratelimit-remaining') === '0',
    authFailed: hasToken && res.status === 401,
    ssoUrl: sso ? sso[1] : null,
    restrictedOrg: restricted ? restricted[1] : null,
  };
}

// ---------- Sign in with GitHub (device flow) ----------
// The pending flow lives in chrome.storage.session, so polling resumes if Chrome restarts the worker.

const postForm = (url, body) => fetch(url, {
  method: 'POST',
  headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
}).then((r) => r.json());

async function whoAmI(token) {
  const res = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  return res.ok ? (await res.json()).login : null;
}

async function startSignIn() {
  const d = await postForm('https://github.com/login/device/code', { scope: 'repo' });
  if (!d.device_code) throw new Error(d.error_description || d.error || 'GitHub did not return a sign-in code');
  const signIn = {
    status: 'waiting', userCode: d.user_code, verificationUri: d.verification_uri,
    deviceCode: d.device_code, interval: d.interval || 5, expiresAt: Date.now() + d.expires_in * 1000,
  };
  await chrome.storage.session.set({ signIn });
  poll(signIn); // the options page shows the code and opens GitHub when the user is ready
}

let polling = null;
async function poll(signIn) {
  if (polling === signIn.deviceCode) return;
  polling = signIn.deviceCode;
  let interval = signIn.interval;
  const fail = (error) => chrome.storage.session.set({ signIn: { status: 'error', error } });
  while (polling === signIn.deviceCode) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const { signIn: current } = await chrome.storage.session.get('signIn'); // also keeps the worker alive
    if (current?.deviceCode !== signIn.deviceCode) break; // cancelled or restarted
    if (Date.now() > signIn.expiresAt) { await fail('The code expired. Try again.'); break; }
    const r = await postForm('https://github.com/login/oauth/access_token', {
      device_code: signIn.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }).catch(() => ({ error: 'network' }));
    if (r.access_token) {
      const login = await whoAmI(r.access_token);
      await chrome.storage.local.set({ token: r.access_token, auth: { method: 'github', login } });
      await chrome.storage.session.remove('signIn');
      break;
    }
    if (r.error === 'authorization_pending' || r.error === 'network') continue;
    if (r.error === 'slow_down') { interval = r.interval || interval + 5; continue; }
    await fail(r.error === 'access_denied' ? 'Sign-in was cancelled on GitHub.'
      : r.error === 'expired_token' ? 'The code expired. Try again.'
      : r.error_description || r.error || 'Sign-in failed.');
    break;
  }
  if (polling === signIn.deviceCode) polling = null;
}

chrome.storage.session.get('signIn').then(({ signIn }) => {
  if (signIn?.status === 'waiting') poll(signIn);
});

// Save a personal access token, after checking it works.
async function saveToken(token) {
  const login = await whoAmI(token);
  if (!login) throw new Error('GitHub rejected this token.');
  await chrome.storage.local.set({ token, auth: { method: 'token', login } });
  return login;
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => { p.then((v) => sendResponse({ ok: true, ...v }), (e) => sendResponse({ ok: false, error: e.message || String(e) })); return true; };
  switch (msg.type) {
    case 'api':
      githubApi(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    case 'openTab':
      chrome.tabs.create({ url: msg.url, active: msg.active !== false });
      break;
    case 'openOptions':
      chrome.runtime.openOptionsPage();
      break;
    case 'openAppSettings':
      chrome.tabs.create({ url: APP_SETTINGS_URL });
      break;
    case 'signIn':
      return reply(startSignIn().then(() => ({})));
    case 'signInCancel':
      return reply(chrome.storage.session.remove('signIn').then(() => ({})));
    case 'saveToken':
      return reply(saveToken(msg.token).then((login) => ({ login })));
    case 'signOut':
      return reply(chrome.storage.local.remove(['token', 'auth']).then(() => ({})));
  }
});
