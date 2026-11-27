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

// Cmd+click the `nth` (0-based) occurrence of `word` on `line` (1-based) of `file`. Returns where the page scrolled, the tabs opened and the last toast.
async function click(file, line, word, nth = 0) {
  const text = FILES[file][line - 1];
  // Like GitHub's highlighted diff, the clicked word is a text node of its own inside the line cell.
  const at0 = [...text.matchAll(new RegExp(`\\b${word}\\b`, 'g'))][nth].index;
  const scrolled = [];
  const tabs = [];
  const toasts = [];
  const listeners = {};
  const cell = { id: `diff-${hash(file)}R${line}`, dataset: {}, getAttribute: () => null, closest: () => cell, parentElement: null, tagName: 'TD', childNodes: [1, 2, 3] };
  const node = { nodeType: 3, textContent: word, parentElement: cell };
  const pos = (n, o) => (n === cell ? (o === 0 ? 0 : text.length) : at0 + o); // offset within the line
  const el = (tag) => {
    const n = { tag, children: [], classList: { add() {}, remove() {}, toggle() {} }, appendChild: (c) => n.children.push(c) };
    let t = '';
    Object.defineProperty(n, 'textContent', { get: () => t, set: (v) => { t = v; if (tag === 'div') toasts.push(v); } });
    return n;
  };
  const row = (id) => ({ id, closest: () => null, classList: { add() {}, remove() {} }, scrollIntoView: () => scrolled.push(id) });
  const ctx = {
    console, setTimeout, clearTimeout, URL, TextEncoder, crypto: globalThis.crypto,
    navigator: { platform: 'MacIntel' },
    location: { pathname: '/acme/app/pull/7/changes', hash: '' },
    history: { pushState() {} },
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
      createElement: el,
      caretPositionFromPoint: () => ({ offsetNode: node, offset: 1 }),
      createRange: () => {
        let start = 0, end = 0;
        return {
          setStart(n, o) { start = pos(n, o); }, setEnd(n, o) { end = pos(n, o); },
          toString: () => text.slice(start, end), getClientRects: () => [{ left: 0, right: 100, top: 0, bottom: 20 }],
        };
      },
      getElementById: (id) => (/^diff-[0-9a-f]{64}R\d+$/.test(id) ? row(id) : null),
      querySelectorAll: () => [],
    },
    window: { addEventListener() {} },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const s of SRC) vm.runInContext(s, ctx);
  await listeners.click({ metaKey: true, button: 0, clientX: 10, clientY: 10, preventDefault() {}, stopImmediatePropagation() {} });
  const at = scrolled.map((id) => {
    const [, h, l] = /^diff-([0-9a-f]{64})R(\d+)$/.exec(id);
    return `${Object.keys(FILES).find((f) => hash(f) === h)}:${l}`;
  });
  return { at, tabs, toast: toasts[toasts.length - 1] };
}

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
