// Where a Cmd/Ctrl+click lands, end to end: the real content script in a VM, with a fake PR served by a
// scripted GitHub API and a fake diff DOM that records what was scrolled to and which tabs were opened.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const SRC = [read('src/resolver.js'), read('src/content.js')];
const hash = (p) => crypto.createHash('sha256').update(p).digest('hex');

// Every file below is added by the PR, so all of its lines are in the diff.
const FILES = {
  'src/shop/OrderService.java': [
    'package shop;',
    '',
    '@Service',
    'public class OrderService {',
    '    private final OrderRepository orderRepository;',
    '',
    '    public List<OrderEntity> open(String store) {',
    '        return orderRepository.findByStoreAndStatus(store, OrderStatusEnum.OPEN);',
    '    }',
    '',
    '    public OrderEntity place(OrderEntity order) {',
    '        return orderRepository.save(order);',
    '    }',
    '}',
  ],
  'src/shop/OrderRepository.java': [
    'package shop;',
    '',
    'public interface OrderRepository extends JpaRepository<OrderEntity, UUID> {',
    '    List<OrderEntity> findByStoreAndStatus(String store, OrderStatusEnum status);',
    '}',
  ],
  'src/chat/MessageService.java': [
    'package chat;',
    '',
    'public class MessageService {',
    '    private MessageEntity save(MessageEntity message) {',
    '        return message;',
    '    }',
    '}',
  ],
  'src/queue/Worker.java': [
    'public class Worker {',
    '    static String key(String tenant, String handle) {',
    '        return tenant + ":" + handle;',
    '    }',
    '',
    '    public void submit(String handle, Message message) {',
    '        var key = key(Tenants.current(), handle);',
    '        queue.enqueue(key, message);',
    '    }',
    '}',
  ],
  'src/pets/PetController.java': [
    'public class PetController {',
    '    private final PetValidator petValidator;',
    '    void check(Pet pet) {',
    '        petValidator.validate(pet);',
    '    }',
    '}',
  ],
  'src/pets/PetValidator.java': [
    'public class PetValidator extends BaseValidator<Pet> {',
    '}',
  ],
  'src/pets/BaseValidator.java': [
    'public abstract class BaseValidator<T> {',
    '    public void validate(T target) {',
    '    }',
    '}',
  ],
};

const reply = (data) => ({ ok: true, data });
function apiFor(p) {
  const base = '/repos/acme/app';
  if (p === `${base}/pulls/7`) return reply({ head: { sha: 'abc123' } });
  if (p.startsWith(`${base}/pulls/7/files`)) {
    return reply(Object.entries(FILES).map(([filename, lines]) => ({
      filename, patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`,
    })));
  }
  if (p.startsWith(`${base}/git/trees/`)) return reply({ tree: Object.keys(FILES).map((p2) => ({ type: 'blob', path: p2 })) });
  const c = /\/contents\/(.+)\?ref=/.exec(p);
  if (c) {
    const f = FILES[decodeURIComponent(c[1])];
    return f ? reply(f.join('\n')) : { ok: false, status: 404, hasToken: true };
  }
  return { ok: false, status: 404, hasToken: true };
}

// A PR page running the real content script. `page.click` Cmd+clicks the `nth` (0-based) occurrence of `word` on
// `line` (1-based) of `file` and returns where the page scrolled, the tabs opened and the last toast.
// `page.back()` is the browser's Back button; `page.scroller.scrollTop` is how far the diff is scrolled.
function page({ fileTree = false } = {}) {
  let cur; // the line being clicked: { text, at0, cell, node }
  const tabs = [];
  const toasts = [];
  const listeners = {};
  const popstate = [];
  const winListeners = {};
  const flashes = [];
  const scroller = { scrollTop: 0 };
  const entries = [{ state: null, key: 'k0' }];
  const replaced = [];
  const hashNavs = [];
  let keys = 0;
  let idx = 0;
  const lineOf = (id) => {
    const [, h, l] = /^diff-([0-9a-f]{64})R(\d+)$/.exec(id);
    return `${Object.keys(FILES).find((f) => hash(f) === h)}:${l}`;
  };
  let scrolled = [];
  const el = (tag) => {
    const n = { tag, children: [], classList: { add() {}, remove() {}, toggle() {} }, appendChild: (c) => n.children.push(c) };
    let t = '';
    Object.defineProperty(n, 'textContent', { get: () => t, set: (v) => { t = v; if (tag === 'div') toasts.push(v); } });
    return n;
  };
  // Scrolling a line into view moves the diff to a position unique to that line.
  const posOf = (id) => 1000 * Object.keys(FILES).indexOf(lineOf(id).split(':')[0]) + 20 * +lineOf(id).split(':')[1];
  const row = (id) => ({
    id, closest: () => null, classList: { add: (c) => { if (c === 'diffscout-flash') flashes.push(lineOf(id)); }, remove() {} }, isConnected: true,
    getBoundingClientRect: () => ({ top: posOf(id) - scroller.scrollTop, bottom: posOf(id) - scroller.scrollTop + 20 }),
    scrollIntoView: () => { scrolled.push(lineOf(id)); scroller.scrollTop = 1000 * Object.keys(FILES).indexOf(lineOf(id).split(':')[0]) + 20 * +lineOf(id).split(':')[1]; },
  });
  const ctx = {
    console, setTimeout, clearTimeout, URL, TextEncoder, crypto: globalThis.crypto,
    navigator: { platform: 'MacIntel' },
    location: {
      pathname: '/acme/app/pull/7/changes',
      get hash() { return entries[idx].url || ''; },
      set hash(v) {
        const path = Object.keys(FILES).find((f) => `diff-${hash(f)}` === v.replace(/^#/, ''));
        hashNavs.push(path);
        entries.splice(idx + 1, Infinity, { state: null, key: `k${++keys}`, url: `#${v}` }); idx++;
        setTimeout(() => { scroller.scrollTop = 1000 * Object.keys(FILES).indexOf(path); }, 30);
      },
    },
    history: {
      get state() { return entries[idx].state; },
      pushState(state) { entries.splice(idx + 1, Infinity, { state, key: `k${++keys}` }); idx++; },
      replaceState(state, _t, url) { replaced.push(url); entries[idx] = { ...entries[idx], state, url: url ?? entries[idx].url }; },
    },
    navigation: { get currentEntry() { return { key: entries[idx].key }; } },
    getComputedStyle: () => ({ overflowY: 'visible' }),
    Node: { TEXT_NODE: 3 },
    chrome: {
      runtime: {
        sendMessage: async (m) => {
          if (m.type === 'api') return apiFor(m.path);
          if (m.type === 'openTab') tabs.push(m.url);
          return undefined;
        },
      },
    },
    document: {
      addEventListener: (t, fn) => { listeners[t] = fn; },
      documentElement: { appendChild() {}, classList: { add() {}, remove() {} } },
      body: {},
      scrollingElement: scroller,
      createElement: el,
      caretPositionFromPoint: () => ({ offsetNode: cur.node, offset: 1 }),
      createRange: () => {
        // Offsets within the line; like GitHub's highlighted diff, the clicked word is a text node of its own.
        const pos = (n, o) => (n === cur.cell ? (o === 0 ? 0 : cur.text.length) : cur.at0 + o);
        let start = 0, end = 0;
        return {
          setStart(n, o) { start = pos(n, o); }, setEnd(n, o) { end = pos(n, o); },
          toString: () => cur.text.slice(start, end), getClientRects: () => [{ left: 0, right: 100, top: 0, bottom: 20 }],
        };
      },
      getElementById: (id) => (/^diff-[0-9a-f]{64}R\d+$/.test(id) ? row(id) : null),
      // GitHub's newer view has a file tree; setting location.hash to a file adds a history entry and GitHub
      // scrolls to that file.
      querySelectorAll: (sel) => (fileTree && sel === '[role="treeitem"]' ? Object.keys(FILES).map((path) => ({ id: path })) : []),
    },
    innerHeight: 800,
    window: {
      addEventListener: (t, fn) => { if (t === 'popstate') popstate.push(fn); else (winListeners[t] ||= new Set()).add(fn); },
      removeEventListener: (t, fn) => winListeners[t]?.delete(fn),
    },
  };
  ctx.self = ctx;
  ctx.addEventListener = ctx.window.addEventListener;
  vm.createContext(ctx);
  for (const s of SRC) vm.runInContext(s, ctx);
  return {
    scroller,
    flashes,
    // The reader scrolls with the mouse wheel.
    scrollTo(y) { for (const fn of winListeners.wheel || []) fn({}); scroller.scrollTop = y; },
    replaced,
    hashNavs,
    urls: () => entries.map((e) => e.url || ''),
    entries: () => entries.length,
    async click(file, line, word, nth = 0) {
      const text = FILES[file][line - 1];
      const cell = { ...row(`diff-${hash(file)}R${line}`), dataset: {}, getAttribute: () => null, parentElement: null, tagName: 'TD', childNodes: [1, 2, 3] };
      cell.closest = () => cell;
      cur = { text, cell, node: { nodeType: 3, textContent: word, parentElement: cell }, at0: [...text.matchAll(new RegExp(`\\b${word}\\b`, 'g'))][nth].index };
      scrolled = [];
      await listeners.click({ metaKey: true, button: 0, clientX: 10, clientY: 10, preventDefault() {}, stopImmediatePropagation() {} });
      return { at: scrolled, tabs, toast: toasts[toasts.length - 1] };
    },
    async back() {
      idx--;
      for (const fn of popstate) fn({ state: entries[idx].state });
      await new Promise((r) => setTimeout(r, 450));
    },
  };
}
const click = (...args) => page().click(...args);

test('a repository method declared in an interface scrolls to its declaration', async () => {
  const r = await click('src/shop/OrderService.java', 8, 'findByStoreAndStatus');
  assert.deepStrictEqual(r.at, ['src/shop/OrderRepository.java:4']);
  assert.deepStrictEqual(r.tabs, []);
});

test('a field scrolls to its declaration', async () => {
  const r = await click('src/shop/OrderService.java', 12, 'orderRepository');
  assert.deepStrictEqual(r.at, ['src/shop/OrderService.java:5']);
  assert.deepStrictEqual(r.tabs, []);
});

test('an inherited method goes to the receiver type, not a same-named method elsewhere', async () => {
  const r = await click('src/shop/OrderService.java', 12, 'save');
  assert.deepStrictEqual(r.at, ['src/shop/OrderRepository.java:3']);
  assert.deepStrictEqual(r.tabs, []);
  assert.match(r.toast, /save isn't declared in OrderRepository \(inherited from JpaRepository\)/);
});

test('a method defined in a parent type goes to the parent', async () => {
  const r = await click('src/pets/PetController.java', 4, 'validate');
  assert.deepStrictEqual(r.at, ['src/pets/BaseValidator.java:2']);
});

test('a call goes to the method, not a local variable of the same name', async () => {
  const call = await click('src/queue/Worker.java', 7, 'key', 1); // var key = key(...)
  assert.deepStrictEqual(call.at, ['src/queue/Worker.java:2']);
  const variable = await click('src/queue/Worker.java', 8, 'key'); // queue.enqueue(key, ...)
  assert.deepStrictEqual(variable.at, ['src/queue/Worker.java:7']);
});

test('Back returns to where you clicked, one jump at a time', async () => {
  const p = page();
  p.scrollTo(777); // the reader scrolled down to the call site
  await p.click('src/shop/OrderService.java', 8, 'findByStoreAndStatus');
  const afterFirst = p.scroller.scrollTop;
  assert.notStrictEqual(afterFirst, 777);
  p.scrollTo(555); // reads on a bit, then jumps again
  await p.click('src/shop/OrderService.java', 12, 'orderRepository');
  p.flashes.length = 0;
  await p.back();
  assert.strictEqual(p.scroller.scrollTop, 555);
  assert.deepStrictEqual(p.flashes, ['src/shop/OrderService.java:12']); // the line you clicked from flashes
  await p.back();
  assert.strictEqual(p.scroller.scrollTop, 777);
  assert.deepStrictEqual(p.flashes, ['src/shop/OrderService.java:12', 'src/shop/OrderService.java:8']);
});

test('in the classic view, a jump adds exactly one history entry and never rewrites one', async () => {
  const p = page();
  await p.click('src/shop/OrderService.java', 8, 'findByStoreAndStatus');
  await p.click('src/shop/OrderService.java', 12, 'orderRepository');
  assert.strictEqual(p.entries(), 3);
  assert.deepStrictEqual(p.replaced, []);
});

test('in GitHub\'s file-tree view, a jump points the URL at the file, then scrolls to the line', async () => {
  const p = page({ fileTree: true });
  p.scroller.scrollTop = 777;
  const r = await p.click('src/shop/OrderService.java', 8, 'findByStoreAndStatus');
  assert.deepStrictEqual(p.hashNavs, ['src/shop/OrderRepository.java']); // GitHub moves the tree's highlight
  assert.deepStrictEqual(r.at, ['src/shop/OrderRepository.java:4']);
  assert.strictEqual(p.scroller.scrollTop, 1000 + 20 * 4); // the line, not the file's top
  // Two entries: the one left, stamped with the clicked file so Back highlights it again, and the target file.
  assert.deepStrictEqual(p.urls(), [`#diff-${hash('src/shop/OrderService.java')}`, `#diff-${hash('src/shop/OrderRepository.java')}`]);
  await p.back();
  assert.strictEqual(p.scroller.scrollTop, 777);
});
