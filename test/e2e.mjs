// Runs the real content script against live GitHub PRs, faking only the DOM click and chrome.* APIs.
// Usage: GITHUB_TOKEN=$(gh auth token) node test/e2e.mjs   (without a token, code search is skipped)
import fs from 'node:fs';
import vm from 'node:vm';

const TOKEN = process.env.GITHUB_TOKEN;
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));

const CASES = [
  // [pr, clicked file, source line, clicked word, expected path suffix, expected definition line regex, mode, needs token]
  ['spring-projects/spring-petclinic/pull/2697', 'src/test/java/org/springframework/samples/petclinic/owner/PetControllerTests.java', 'given(owners.saveAndFlush(any(Owner.class))).willThrow(exception);', 'Owner', 'owner/Owner.java', /class Owner\b/, 'tab'],
  ['spring-projects/spring-petclinic/pull/2697', 'src/test/java/org/springframework/samples/petclinic/owner/PetValidatorTests.java', '\t\t\tpetValidator.validate(pet, errors);', 'validate', 'owner/PetValidator.java', /void validate\(/, 'tab'],
  ['excalidraw/excalidraw/pull/12458', 'packages/element/src/elbowArrow.ts', 'import { ELBOW_ARROW_CORNER_RADIUS } from "./shape";', 'ELBOW_ARROW_CORNER_RADIUS', 'element/src/shape.ts', /ELBOW_ARROW_CORNER_RADIUS = /, 'scroll'],
  ['excalidraw/excalidraw/pull/12458', 'packages/element/src/elbowArrow.ts', '  getArrowheadSize,', 'getArrowheadSize', 'element/src/bounds.ts', /getArrowheadSize\s*=/, 'tab', true],
  ['excalidraw/excalidraw/pull/12458', 'packages/element/tests/elbowArrow.test.tsx', 'import { actionChangeArrowhead } from "@excalidraw/excalidraw/actions/actionProperties";', 'actionChangeArrowhead', 'actions/actionProperties.tsx', /actionChangeArrowhead\s*=/, 'tab', true],
  ['excalidraw/excalidraw/pull/12458', 'packages/element/tests/elbowArrow.test.tsx', '    await render(<Excalidraw handleKeyboardGlobally={true} />);', 'Excalidraw', 'packages/excalidraw/index.tsx', /Excalidraw\s*=/, 'tab'],
  ['BurntSushi/ripgrep/pull/3564', 'crates/ignore/src/walk.rs', '        assert_paths(td.path(), &WalkBuilder::new(td.path()), &["visible."]);', 'WalkBuilder', 'crates/ignore/src/walk.rs', /pub struct WalkBuilder/, 'tab'],
  ['BurntSushi/ripgrep/pull/3564', 'crates/ignore/src/walk.rs', '        builder.hidden(false);', 'hidden', 'crates/ignore/src/walk.rs', /pub fn hidden\(/, 'tab'],
  ['BurntSushi/ripgrep/pull/3564', 'crates/ignore/src/pathutil.rs', '    use super::{file_name, is_hidden_path};', 'is_hidden_path', 'crates/ignore/src/pathutil.rs', /fn is_hidden_path/, 'tab'],
  ['pallets/flask/pull/6168', 'src/flask/sessions.py', '    def get_expiration_time(self, app: Flask, session: SessionMixin) -> datetime | None:', 'Flask', 'src/flask/app.py', /class Flask\b/, 'tab', true],
  ['pallets/flask/pull/6168', 'src/flask/sessions.py', '    def get_expiration_time(self, app: Flask, session: SessionMixin) -> datetime | None:', 'SessionMixin', 'src/flask/sessions.py', /class SessionMixin\b/, 'tab'],
  ['pallets/flask/pull/6168', 'src/flask/cli.py', '        items = self.split_envvar_value(value)', 'split_envvar_value', null, null, 'search'],
];

async function api(path, raw) {
  const headers = { Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) return { ok: false, status: res.status, hasToken: !!TOKEN };
  return { ok: true, data: raw ? await res.text() : await res.json() };
}

async function runCase([pr, file, srcLine, word, wantPath, wantLine, wantMode, needsToken]) {
  if (needsToken && !TOKEN) return { skip: true };
  const result = { opened: [], scrolledTo: null, toasts: [] };
  const listeners = {};
  const parentEl = { id: '', dataset: { tagsearchPath: file }, getAttribute: () => null, closest: () => true, parentElement: null, tagName: 'TD' };
  const textNode = { nodeType: 3, textContent: srcLine, parentElement: parentEl };
  const at = srcLine.search(new RegExp(`\\b${word}\\b`));
  const fakeEl = (id) => ({ id, scrollIntoView() {}, closest() { return this; }, classList: { add() {}, remove() {} }, offsetWidth: 0 });
  const ctx = {
    console, setTimeout, clearTimeout, URL, TextEncoder, Promise, Map, Set, crypto: globalThis.crypto,
    navigator: { platform: 'MacIntel' },
    location: { pathname: `/${pr}/files`, set hash(_) {} },
    history: { pushState: (_s, _t, url) => { result.scrolledTo = url; } },
    Node: { TEXT_NODE: 3 },
    CSS: {},
    chrome: { runtime: { sendMessage: async (m) => (m.type === 'openTab' ? void result.opened.push(m.url) : api(m.path, m.raw)) } },
    document: {
      addEventListener: (t, fn) => { listeners[t] = fn; },
      documentElement: { appendChild() {}, classList: { add() {}, remove() {} } },
      createElement: () => ({ classList: { add() {}, remove() {} } }),
      caretPositionFromPoint: () => ({ offsetNode: textNode, offset: at + 1 }),
      createRange: () => { let end = 0; return { setStart() {}, setEnd(_n, o) { end = o; }, toString: () => srcLine.slice(0, end), getClientRects: () => [{ left: 0, right: 100, top: 0, bottom: 20 }] }; },
      getElementById: (id) => fakeEl(id),
    },
    window: { addEventListener() {} },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(`${root}src/resolver.js`, 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(`${root}src/content.js`, 'utf8'), ctx);
  const origToast = ctx.document.createElement;
  ctx.document.createElement = () => { const el = origToast(); Object.defineProperty(el, 'textContent', { set: (v) => result.toasts.push(v) }); return el; };

  await listeners.click({ metaKey: true, button: 0, clientX: 10, clientY: 10, preventDefault() {}, stopImmediatePropagation() {} });

  // Work out where we landed: an opened blob URL, or an in-diff anchor resolved back to a path via the PR files.
  let path, line, mode;
  if (result.opened.length && result.opened[0].includes('/search?')) {
    return { pass: wantMode === 'search', mode: 'search', path: '(symbol search)', toasts: result.toasts.slice(-1) };
  } else if (result.opened.length) {
    const m = /\/blob\/([0-9a-f]+)\/(.+)#L(\d+)$/.exec(result.opened[0]);
    if (!m) return { ...result, pass: false, why: 'opened non-blob URL' };
    [, , path, line] = m; path = decodeURIComponent(path); mode = 'tab';
  } else if (result.scrolledTo) {
    const [, hash, l] = /#diff-([0-9a-f]{64})R(\d+)/.exec(result.scrolledTo);
    const files = (await api(`/repos/${pr.replace('/pull/', '/pulls/')}/files?per_page=100`)).data;
    for (const f of files) {
      const h = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(f.filename))).toString('hex');
      if (h === hash) path = f.filename;
    }
    line = l; mode = 'scroll';
  }
  if (!path) return { ...result, pass: false, why: 'no navigation' };
  const head = (await api(`/repos/${pr.replace('/pull/', '/pulls/')}`)).data.head.sha;
  const repo = pr.split('/pull/')[0];
  const text = (await api(`/repos/${repo}/contents/${path}?ref=${head}`, true)).data;
  const lineText = text.split('\n')[line - 1];
  const pass = path.endsWith(wantPath) && wantLine.test(lineText) && mode === wantMode;
  return { pass, path, line, mode, lineText: lineText.trim().slice(0, 80), toasts: result.toasts.slice(-1) };
}

let failed = 0;
for (const c of CASES) {
  const r = await runCase(c);
  if (r.skip) { console.log(`SKIP ${c[3]} (needs GITHUB_TOKEN)`); continue; }
  if (!r.pass) failed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${c[0].split('/')[1]} ${c[3]} -> ${r.path}:${r.line} [${r.mode}] ${r.lineText || r.why || ''} ${r.pass ? '' : JSON.stringify(r.toasts)}`);
}
process.exit(failed ? 1 : 0);
