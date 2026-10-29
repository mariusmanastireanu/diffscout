// Language-agnostic helpers for finding where a symbol is defined.
// Pure functions only: no DOM, no network. Loaded by the content script and by tests.

(function (root) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Each pattern gets the escaped identifier; higher score = more likely the definition.
  const DEFINITION_PATTERNS = [
    // Types: Java, Kotlin, C#, TS, Rust, Swift, Scala, Go, C/C++, PHP, Ruby, Elixir...
    { score: 100, re: (x) => new RegExp(`\\b(class|interface|enum|record|struct|trait|object|protocol|union|module|namespace|typealias|defmodule)\\s+${x}\\b`) },
    { score: 95, re: (x) => new RegExp(`\\btype\\s+${x}\\b`) },
    // Functions: Python, Rust, Go, JS/TS, Kotlin, PHP, Elixir, Perl, Swift, Ruby...
    { score: 90, re: (x) => new RegExp(`\\b(def|defp|fn|func|function|fun|sub|proc)\\s+${x}\\b`) },
    { score: 90, re: (x) => new RegExp(`\\bfunc\\s*\\([^)]*\\)\\s*${x}\\s*\\(`) }, // Go method
    { score: 85, re: (x) => new RegExp(`\\bmacro_rules!\\s*${x}\\b`) },
    // Bindings: JS/TS const components, Kotlin/Scala val, Rust let/const/static
    { score: 70, re: (x) => new RegExp(`\\b(const|let|var|val|static)\\s+(mut\\s+)?${x}\\s*[:=]`) },
    { score: 65, re: (x) => new RegExp(`^\\s*(export\\s+)?(default\\s+)?${x}\\s*=\\s*(\\(|async\\b|function\\b|class\\b|React\\.|styled)`) },
    // Methods in C-family languages: `<modifiers> <ReturnType> name(` on a line that does not end in `;`
    { score: 55, re: (x) => new RegExp(`^\\s*(@\\w+\\s+)*((public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|open|suspend|inline|extern|const|unsafe|pub(\\([^)]*\\))?)\\s+)*(<[^>]*>\\s+)?[\\w<>\\[\\],.?:&*]+\\s+[&*]?${x}\\s*(<[^>]*>)?\\s*\\((?!.*;\\s*$)`) },
    // JS/TS class or object methods: `name(args) {`
    { score: 50, re: (x) => new RegExp(`^\\s*((async|static|get|set|public|private|protected|override)\\s+)*${x}\\s*\\([^)]*\\)\\s*(:\\s*[^{]+)?\\{`) },
    { score: 45, re: (x) => new RegExp(`^\\s*${x}\\s*:\\s*(async\\s+)?(function\\b|\\()`) },
    // Module-level assignment (Python constants etc.)
    { score: 30, re: (x) => new RegExp(`^${x}\\s*(:[^=]+)?=[^=]`) },
  ];

  const NOT_DEFINITION = /^\s*(return|new|throw|else|await|yield|import|from|package|using|#include|\/\/|\*|\/\*|#(?!\[))/;

  function definitionScore(line, ident) {
    if (NOT_DEFINITION.test(line)) return 0;
    const x = esc(ident);
    let best = 0;
    for (const p of DEFINITION_PATTERNS) if (p.score > best && p.re(x).test(line)) best = p.score;
    return best;
  }

  // Best definition line in a full file text. Returns { line (1-based), score } or null.
  function findDefinitionInText(text, ident) {
    if (!text || !text.includes(ident)) return null;
    let best = null;
    text.split('\n').forEach((l, i) => {
      const s = definitionScore(l, ident);
      if (s && (!best || s > best.score)) best = { line: i + 1, score: s };
    });
    return best;
  }

  // Parse a unified-diff patch into the new-side lines: [{ line, text }].
  function parsePatch(patch) {
    const out = [];
    if (!patch) return out;
    let n = 0;
    for (const raw of patch.split('\n')) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (h) { n = parseInt(h[1], 10); continue; }
      const c = raw[0];
      if (c === '+' || c === ' ') { out.push({ line: n, text: raw.slice(1) }); n++; }
    }
    return out;
  }

  const normalize = (s) => s.toLowerCase().replace(/[_\-.]/g, '');
  const stem = (path) => { const b = path.split('/').pop(); const i = b.indexOf('.'); return i > 0 ? b.slice(0, i) : b; };
  const ext = (path) => { const b = path.split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1) : ''; };
  const INDEX_STEMS = new Set(['index', 'mod', '__init__', 'main', 'lib']);

  // Language families, so a click in a .tsx file prefers .ts/.tsx/.js over .py.
  const FAMILIES = [
    ['java', 'kt', 'kts', 'scala', 'groovy'], ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'],
    ['py', 'pyi'], ['rs'], ['go'], ['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh'], ['cs'], ['rb'], ['php'],
    ['swift', 'm', 'mm'], ['ex', 'exs'], ['dart'],
  ];
  const family = (e) => FAMILIES.findIndex((f) => f.includes(e));

  // Turn import lines that mention `ident` into path hints, e.g.
  //   import com.acme.billing.Invoice;        -> "com/acme/billing/invoice"
  //   from acme.billing.models import Invoice -> "acme/billing/models"
  //   import { Invoice } from '../billing/invoice' -> resolved relative to the current file
  //   use crate::billing::Invoice;            -> "billing/invoice"
  function importHints(fileText, ident, currentPath) {
    const hints = [];
    if (!fileText) return hints;
    const dir = currentPath ? currentPath.split('/').slice(0, -1) : [];
    for (const line of fileText.split('\n')) {
      if (!line.includes(ident)) continue;
      if (!/^\s*(import|from|use|using|require|include|#include|@import|export\s+.*\bfrom\b|const .*require\()/.test(line) && !/\brequire\(/.test(line)) continue;
      const quoted = /['"]([^'"]+)['"]/.exec(line);
      let mod;
      if (quoted) {
        mod = quoted[1];
        if (mod.startsWith('.')) {
          const parts = [...dir];
          for (const seg of mod.split('/')) {
            if (seg === '..') parts.pop(); else if (seg !== '.' && seg) parts.push(seg);
          }
          mod = parts.join('/');
        } else mod = mod.replace(/^[@~]\/?/, '');
      } else {
        const m = /^\s*(?:from\s+(\S+)\s+import|import\s+(?:static\s+)?([\w.$]+)|use\s+([\w:]+)|using\s+([\w.]+))/.exec(line);
        if (!m) continue;
        mod = m[1] || m[2] || m[3] || m[4] || '';
        const rel = /^\.+/.exec(mod); // Python relative import: `.` = this package, `..` = parent
        const prefix = rel ? dir.slice(0, dir.length - (rel[0].length - 1)).join('/') + '/' : '';
        mod = prefix + mod.slice(rel ? rel[0].length : 0).replace(/::/g, '/').replace(/^(crate|self|super)\//, '').replace(/\./g, '/');
        mod = mod.replace(/\/\*$/, '');
      }
      if (mod) hints.push(mod.toLowerCase());
    }
    return hints;
  }

  // Rank repo paths that could define `ident`. Returns paths, best first.
  function rankCandidatePaths(paths, ident, { currentPath, hints = [] } = {}) {
    const want = normalize(ident);
    const curFam = currentPath ? family(ext(currentPath)) : -1;
    const curDir = currentPath ? currentPath.split('/').slice(0, -1) : [];
    const scored = [];
    for (const p of paths) {
      const s = stem(p);
      const segs = p.split('/');
      const parentDir = segs.length > 1 ? segs[segs.length - 2] : '';
      let score = 0;
      if (normalize(s) === want) score = s === ident ? 100 : 90;
      else if (INDEX_STEMS.has(s) && normalize(parentDir) === want) score = 80;
      if (!score) continue;
      const fam = family(ext(p));
      if (curFam >= 0) score += fam === curFam ? 30 : -40;
      const lp = p.toLowerCase();
      if (hints.some((h) => lp.includes(h) || h.includes(lp.replace(/\.[^/.]+$/, '')))) score += 60;
      let shared = 0;
      while (shared < curDir.length && segs[shared] === curDir[shared]) shared++;
      score += Math.min(shared, 10);
      if (/(^|\/)(test|tests|__tests__|spec|mocks?|fixtures?)\//i.test(p)) score -= 15;
      scored.push({ p, score });
    }
    return scored.sort((a, b) => b.score - a.score).map((x) => x.p);
  }

  // Repo files an import hint points at. Leading hint segments are dropped one at a time so that
  // aliased roots still resolve: "excalidraw/excalidraw/actions/x" finds "packages/excalidraw/actions/x.tsx".
  function pathsForHints(paths, hints) {
    const out = [];
    const noExt = paths.map((p) => [p, p.toLowerCase().replace(/\.[^/.]+$/, '')]);
    for (const hint of hints) {
      const segs = hint.split('/').filter(Boolean);
      for (let k = 0; k <= Math.max(0, segs.length - 2); k++) {
        const suffix = segs.slice(k).join('/');
        const hits = noExt
          .filter(([, n]) => [suffix, `${suffix}/index`, `${suffix}/__init__`, `${suffix}/mod`].some((s) => n === s || n.endsWith(`/${s}`)))
          .map(([p]) => p);
        if (hits.length) { out.push(...hits.filter((p) => !out.includes(p))); break; }
      }
    }
    return out;
  }

  // `petValidator.validate(` -> receiver "petValidator". Ignores this/self-style receivers.
  function receiverOf(linePrefix) {
    const m = /([A-Za-z_$][\w$]*)\s*(?:\)\s*)?(?:\?\.|\.|::|->)\s*$/.exec(linePrefix);
    return m && !/^(this|self|super|cls|Self|it)$/.test(m[1]) ? m[1] : null;
  }

  // Guess the type names a receiver might have: its declared type in the file, plus the name itself
  // (fields are often named after their type, and a capitalized receiver is usually a type).
  //   PetValidator validator = ...   validator: PetValidator   validator = new PetValidator(...)
  function receiverTypes(fileText, receiver) {
    const types = [];
    if (fileText) {
      const r = esc(receiver);
      const pats = [
        new RegExp(`\\b([A-Z][\\w$]*)(?:<[^>\\n]*>)?(?:\\[\\])?\\s+${r}\\s*[=;,)]`, 'g'),
        new RegExp(`\\b${r}\\s*\\??:\\s*(?:&\\s*(?:mut\\s+)?)?([A-Z][\\w$]*)`, 'g'),
        new RegExp(`\\b${r}\\s*:?=\\s*(?:new\\s+|&)?([A-Z][\\w$]*)(?:::\\w+)?\\s*[({]`, 'g'),
      ];
      for (const p of pats) for (const m of fileText.matchAll(p)) if (!types.includes(m[1])) types.push(m[1]);
    }
    if (!types.includes(receiver)) types.push(receiver);
    return types;
  }

  const api = { pathsForHints, receiverOf, receiverTypes, definitionScore, findDefinitionInText, parsePatch, importHints, rankCandidatePaths, stem, normalize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DiffScout = api;
})(typeof self !== 'undefined' ? self : this);
