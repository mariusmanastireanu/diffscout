// Service worker: the only place the GitHub token is read, so it never enters the page.

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
  if (!res.ok) {
    return { ok: false, status: res.status, rateLimited: res.headers.get('x-ratelimit-remaining') === '0', hasToken: !!token };
  }
  return { ok: true, data: raw ? await res.text() : await res.json() };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'api') {
    githubApi(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'openTab') {
    chrome.tabs.create({ url: msg.url, active: msg.active !== false });
  }
});
