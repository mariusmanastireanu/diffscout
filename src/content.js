// Cmd/Ctrl+click an identifier in a PR diff to jump to its definition.
// Resolution order: definition inside the PR diff (scroll there) -> elsewhere in the clicked file
// -> elsewhere in other PR files -> file named after the symbol (repo tree) -> GitHub code search
// (needs token) -> GitHub symbol search page.

(() => {
  const R = self.DiffScout;
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  const PR_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
  const CACHE_MS = 5 * 60 * 1000;
  const KEYWORDS = new Set(('abstract as async await boolean break case catch char class const continue def default defer do double ' +
    'elif else enum export extends false final finally float fn for from func function go if impl implements import in instanceof ' +
    'int interface let long match mod module mut new nil none null object override package pass private protected pub public ' +
    'raise return self static string struct super switch synchronized this throw throws trait true try type typeof use val var ' +
    'void while with yield').split(' '));

  const isModifier = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);
  const prInfo = () => {
    const m = PR_PATH.exec(location.pathname);
    return m && { owner: m[1], repo: m[2], number: m[3], key: `${m[1]}/${m[2]}/${m[3]}` };
  };

  // ---------- GitHub API (through the service worker, which holds the token) ----------

  const api = (path, raw = false) => chrome.runtime.sendMessage({ type: 'api', path, raw });
  const cache = new Map();
  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
    const v = fn();
    cache.set(key, { t: Date.now(), v });
    v.catch(() => cache.delete(key));
    return v;
  }

  class ApiError extends Error {
    constructor(res) {
      super(res.rateLimited ? 'GitHub API rate limit hit' : `GitHub API error ${res.status || res.error}`);
      this.res = res;
    }
  }
  async function must(p) { const r = await p; if (!r.ok) throw new ApiError(r); return r.data; }

  async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function loadPr(pr) {
    return cached(`pr:${pr.key}`, async () => {
      const base = `/repos/${pr.owner}/${pr.repo}`;
      const meta = await must(api(`${base}/pulls/${pr.number}`));
      const files = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await must(api(`${base}/pulls/${pr.number}/files?per_page=100&page=${page}`));
        files.push(...batch);
        if (batch.length < 100) break;
      }
      const byPath = new Map();
      const byHash = new Map();
      for (const f of files) {
        const lines = R.parsePatch(f.patch);
        const entry = { path: f.filename, hash: await sha256(f.filename), lines, newLines: new Set(lines.map((l) => l.line)) };
        byPath.set(entry.path, entry);
        byHash.set(entry.hash, entry);
      }
      return { base, headSha: meta.head.sha, byPath, byHash };
    });
  }

  const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
  const fileText = (ctx, path) =>
    cached(`file:${ctx.headSha}:${path}`, () => must(api(`${ctx.base}/contents/${encodePath(path)}?ref=${ctx.headSha}`, true)));
  const repoTree = (ctx) =>
    cached(`tree:${ctx.headSha}`, async () => {
      const t = await must(api(`${ctx.base}/git/trees/${ctx.headSha}?recursive=1`));
      return t.tree.filter((n) => n.type === 'blob').map((n) => n.path);
    });

  // ---------- DOM helpers ----------

  function wordAt(x, y) {
    let node, offset;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      node = p.offsetNode; offset = p.offset;
    } else {
      const r = document.caretRangeFromPoint(x, y);
      if (!r) return null;
      node = r.startContainer; offset = r.startOffset;
    }
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const cell = node.parentElement?.closest('.blob-code-inner, td.blob-code, [class*="diff-text"], [class*="DiffLine"], [class*="diff-line"], [data-testid*="diff"], [role="gridcell"], pre, code');
    if (!cell) return null;
    const t = node.textContent;
    const isWordChar = (c) => /[\w$]/.test(c);
    let s = offset, e = offset;
    while (s > 0 && isWordChar(t[s - 1])) s--;
    while (e < t.length && isWordChar(t[e])) e++;
    const word = t.slice(s, e);
    if (!/^[A-Za-z_$][\w$]*$/.test(word) || KEYWORDS.has(word)) return null;
    const range = document.createRange();
    range.setStart(node, s); range.setEnd(node, e);
    const hit = [...range.getClientRects()].some((r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1);
    if (!hit) return null;
    const before = document.createRange();
    before.setStart(cell, 0); before.setEnd(node, s);
    return { word, range, node, receiver: R.receiverOf(before.toString().split('\n').pop()) };
  }

  // Which PR file does this element belong to? GitHub tags files and line numbers with diff-<sha256(path)>.
  function fileOf(el) {
    const HASH = /^diff-([0-9a-f]{64})/;
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const m = HASH.exec(a.id || '');
      if (m) return { hash: m[1] };
      const path = a.dataset?.tagsearchPath || a.dataset?.path || a.getAttribute?.('data-file-path');
      if (path) return { path };
      if (a.tagName === 'TR' || a.getAttribute('role') === 'row') {
        const inner = [...a.querySelectorAll('[id*="diff-"]')].map((n) => HASH.exec(n.id)).find(Boolean);
        if (inner) return { hash: inner[1] };
      }
    }
    return null;
  }

  let toastEl, toastTimer;
  function toast(msg, ms = 2500) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'diffscout-toast';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('diffscout-show');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => toastEl.classList.remove('diffscout-show'), ms);
  }

  function flash(el) {
    const row = el.closest('tr') || el;
    row.classList.remove('diffscout-flash');
    void row.offsetWidth;
    row.classList.add('diffscout-flash');
  }

  const waitFor = (fn, ms) => new Promise((resolve) => {
    const end = Date.now() + ms;
    (function tick() {
      const v = fn();
      if (v || Date.now() > end) resolve(v); else setTimeout(tick, 100);
    })();
  });

  // ---------- Resolution ----------

  async function resolve(pr, word, clicked, receiver) {
    const ctx = await loadPr(pr);
    const cur = clicked && (clicked.hash ? ctx.byHash.get(clicked.hash) : ctx.byPath.get(clicked.path));
    const currentPath = cur?.path || clicked?.path;
    const curText = currentPath ? await fileText(ctx, currentPath).catch(() => null) : null;

    // For `obj.method`, only files named after obj's (guessed) type count as the method's home.
    const types = receiver ? R.receiverTypes(curText, receiver).map(R.normalize) : [];
    const isTypeFile = (path) => types.includes(R.normalize(R.stem(path)));

    // 1. Definition visible in the PR diff (prefer the clicked file, then a file named after the symbol).
    const diffDefinition = (onlyTypeFiles) => {
      let best = null;
      for (const f of ctx.byPath.values()) {
        if (onlyTypeFiles && !isTypeFile(f.path)) continue;
        for (const l of f.lines) {
          let s = R.definitionScore(l.text, word);
          if (!s) continue;
          if (f.path === currentPath && !receiver) s += 5;
          if (R.normalize(R.stem(f.path)) === R.normalize(word)) s += 10;
          if (!best || s > best.score) best = { path: f.path, line: l.line, score: s };
        }
      }
      return best;
    };
    let best = diffDefinition(types.length > 0);
    if (best) return best;

    // 1b. Receiver's type file anywhere in the repo, e.g. petValidator.validate -> PetValidator.java.
    const tree = await repoTree(ctx).catch(() => []);
    for (const type of types) {
      for (const path of R.rankCandidatePaths(tree, type, { currentPath }).slice(0, 2)) {
        const d = R.findDefinitionInText(await fileText(ctx, path).catch(() => null), word);
        if (d) return { path, line: d.line };
      }
    }
    if (types.length && (best = diffDefinition(false))) return best;

    // 2. Defined elsewhere in the clicked file (outside the visible hunks).
    const own = R.findDefinitionInText(curText, word);
    if (own) return { path: currentPath, line: own.line };

    // 2b. Follow the clicked file's import of the symbol, e.g. `from .app import Flask` -> src/flask/app.py.
    const hints = R.importHints(curText, word, currentPath);
    for (const path of R.pathsForHints(tree, hints).slice(0, 4)) {
      const d = R.findDefinitionInText(await fileText(ctx, path).catch(() => null), word);
      if (d) return { path, line: d.line };
    }

    // 3. Defined in another file this PR touches, outside its hunks (covers methods called across changed files).
    const prFiles = [...ctx.byPath.keys()].filter((p) => p !== currentPath).slice(0, 40);
    const texts = await Promise.all(prFiles.map((p) => fileText(ctx, p).catch(() => null)));
    best = null;
    texts.forEach((text, i) => {
      const d = R.findDefinitionInText(text, word);
      if (d && (!best || d.score > best.score)) best = { path: prFiles[i], line: d.line, score: d.score };
    });
    if (best && best.score >= 50) return best;

    // 4. A file named after the symbol, ranked by language and import statements in the clicked file.
    const tried = new Set(prFiles);
    const checkPaths = async (paths) => {
      let fallback = null;
      for (const path of paths) {
        tried.add(path);
        const text = await fileText(ctx, path).catch(() => null);
        const d = R.findDefinitionInText(text, word);
        if (d && d.score >= 50) return { path, line: d.line };
        if (d && !fallback) fallback = { path, line: d.line };
      }
      return fallback;
    };
    const byName = R.rankCandidatePaths(tree, word, { currentPath, hints }).slice(0, 4);
    const named = await checkPaths(byName);
    if (named) return named;
    if (byName.length && R.stem(byName[0]) === word) return { path: byName[0], line: 1 };

    // 5. GitHub code search (requires a token; searches the default branch, verified against PR head).
    const q = encodeURIComponent(`${word} repo:${pr.owner}/${pr.repo}`);
    const search = await api(`/search/code?q=${q}&per_page=30`);
    if (search.ok) {
      const paths = search.data.items.map((i) => i.path).filter((p) => !tried.has(p));
      const fam = (p) => (currentPath && p.split('.').pop() === currentPath.split('.').pop() ? 0 : 1);
      const hinted = (p) => (hints.some((h) => p.toLowerCase().includes(h)) ? 0 : 1);
      paths.sort((a, b) => hinted(a) - hinted(b) || fam(a) - fam(b));
      const found = await checkPaths(paths.slice(0, 6));
      if (found) return found;
    }
    return null;
  }

  // The new-side cell for `line` of a PR file. The classic diff view ids it diff-<hash>R<line>; newer views may
  // only tag cells with data-line-number, so fall back to that inside the file's container, right side first.
  function findLine(file, line) {
    const byId = document.getElementById(`diff-${file.hash}R${line}`);
    if (byId) return byId;
    const box = fileBox(file);
    if (!box) return null;
    const cells = [...box.querySelectorAll(`[data-line-number="${line}"]`)];
    return cells.find((c) => /R\d+$/.test(c.id) || c.closest('[data-split-side="right"]') || /rnum|right|new/i.test(c.className)) || null;
  }

  const fileBox = (file) => document.getElementById(`diff-${file.hash}`) ||
    [...document.querySelectorAll('[data-tagsearch-path], [data-path], [data-file-path]')]
      .find((n) => [n.dataset.tagsearchPath, n.dataset.path, n.dataset.filePath].includes(file.path)) || null;

  async function go(pr, ctx, target) {
    const file = ctx.byPath.get(target.path);
    const name = target.path.split('/').pop();
    if (file && file.newLines.has(target.line)) {
      let el = findLine(file, target.line);
      if (!el) {
        // File may be collapsed or not rendered yet; let GitHub load it via its own anchor handling.
        location.hash = `diff-${file.hash}`;
        el = await waitFor(() => findLine(file, target.line), 4000);
      }
      if (el) {
        history.pushState(null, '', `#diff-${file.hash}R${target.line}`);
        el.scrollIntoView({ block: 'center' });
        flash(el);
        toast(`${name}:${target.line}`, 1500);
        return;
      }
      // The line is in this PR, so stay on the page: we already scrolled to its file.
      fileBox(file)?.scrollIntoView({ block: 'start' });
      toast(`${name}:${target.line} is in this file`, 2500);
      return;
    }
    const url = `https://github.com/${pr.owner}/${pr.repo}/blob/${ctx.headSha}/${encodePath(target.path)}#L${target.line}`;
    chrome.runtime.sendMessage({ type: 'openTab', url });
    toast(`Opened ${name}:${target.line} in a new tab`, 2000);
  }

  let busy = false;
  async function onClick(e) {
    if (!isModifier(e) || e.button !== 0) return;
    const pr = prInfo();
    if (!pr) return;
    const hit = wordAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (busy) return;
    busy = true;
    toast(`Looking up ${hit.word}…`, 0);
    try {
      const ctx = await loadPr(pr);
      const target = await resolve(pr, hit.word, fileOf(hit.node.parentElement), hit.receiver);
      if (target) {
        await go(pr, ctx, target);
      } else {
        const url = `https://github.com/search?type=code&q=${encodeURIComponent(`repo:${pr.owner}/${pr.repo} symbol:${hit.word}`)}`;
        chrome.runtime.sendMessage({ type: 'openTab', url });
        toast(`No definition found for ${hit.word}; opened GitHub symbol search`, 3000);
      }
    } catch (err) {
      const r = err.res;
      if (r && !r.hasToken && (r.status === 404 || r.status === 403 || r.rateLimited)) {
        toast('Private repo or rate limit: add a GitHub token in the extension options', 5000);
      } else {
        toast(`DiffScout: ${err.message}`, 4000);
      }
    } finally {
      busy = false;
    }
  }

  // ---------- Hover affordance: underline the identifier while the modifier is held ----------

  let lastMove = null, raf = 0;
  const clearHover = () => {
    CSS.highlights?.delete('diffscout-hover');
    document.documentElement.classList.remove('diffscout-link');
  };
  function updateHover() {
    raf = 0;
    if (!lastMove || !isModifier(lastMove) || !prInfo()) return clearHover();
    const hit = wordAt(lastMove.clientX, lastMove.clientY);
    if (!hit) return clearHover();
    CSS.highlights?.set('diffscout-hover', new Highlight(hit.range));
    document.documentElement.classList.add('diffscout-link');
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(updateHover); };

  document.addEventListener('click', onClick, true);
  document.addEventListener('mousemove', (e) => { lastMove = e; schedule(); }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (lastMove && (e.key === 'Meta' || e.key === 'Control')) {
      lastMove = new MouseEvent('mousemove', { clientX: lastMove.clientX, clientY: lastMove.clientY, metaKey: e.metaKey, ctrlKey: e.ctrlKey });
      schedule();
    }
  });
  document.addEventListener('keyup', (e) => { if (e.key === 'Meta' || e.key === 'Control') clearHover(); });
  window.addEventListener('blur', clearHover);
})();
