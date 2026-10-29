const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/resolver.js');

const defs = [
  ['public class PetValidator implements Validator {', 'PetValidator'],
  ['data class Invoice(val id: Long)', 'Invoice'],
  ['public sealed record Money(decimal Amount);', 'Money'],
  ['class Invoice(BaseModel):', 'Invoice'],
  ['    def total(self) -> Decimal:', 'total'],
  ['async def fetch_rates():', 'fetch_rates'],
  ['export default function Button({ label }) {', 'Button'],
  ['export const Button = ({ label }: Props) => {', 'Button'],
  ['export interface ButtonProps {', 'ButtonProps'],
  ['export type Theme = "light" | "dark";', 'Theme'],
  ['pub struct Ledger {', 'Ledger'],
  ['pub(crate) fn post_entry(&mut self, e: Entry) -> Result<()> {', 'post_entry'],
  ['impl Ledger { fn new() -> Self {', 'new'],
  ['func (s *Server) Handle(w http.ResponseWriter) {', 'Handle'],
  ['type Server struct {', 'Server'],
  ['    public Optional<Pet> findByName(String name) {', 'findByName'],
  ['    private static <T> List<T> copyOf(Collection<T> c) {', 'copyOf'],
  ['  async loadUser(id: string): Promise<User> {', 'loadUser'],
  ['MAX_RETRIES = 3', 'MAX_RETRIES'],
  ['defmodule Billing.Invoice do', 'Billing'],
];

for (const [line, id] of defs) {
  test(`definition: ${line}`, () => assert.ok(R.definitionScore(line, id) > 0));
}

const usages = [
  ['        PetValidator validator = new PetValidator();', 'PetValidator'],
  ['    return findByName(name);', 'findByName'],
  ['import com.acme.PetValidator;', 'PetValidator'],
  ['from acme.models import Invoice', 'Invoice'],
  ['    const x = Button;', 'Button'],
  ['    invoice.total()', 'total'],
  ['    this.validator.validate(pet, errors);', 'validate'],
  ['        Pet pet = findByName(name);', 'findByName'],
];
for (const [line, id] of usages) {
  test(`not a definition: ${line}`, () => assert.strictEqual(R.definitionScore(line, id), 0));
}

test('parsePatch tracks new-side line numbers', () => {
  const p = '@@ -10,4 +10,5 @@ class A\n ctx\n-old\n+new1\n+new2\n ctx2\n@@ -40 +41 @@\n+tail';
  assert.deepStrictEqual(R.parsePatch(p), [
    { line: 10, text: 'ctx' }, { line: 11, text: 'new1' }, { line: 12, text: 'new2' }, { line: 13, text: 'ctx2' }, { line: 41, text: 'tail' },
  ]);
});

test('importHints across languages', () => {
  assert.deepStrictEqual(R.importHints('import com.acme.billing.Invoice;', 'Invoice'), ['com/acme/billing/invoice']);
  assert.deepStrictEqual(R.importHints('from acme.billing.models import Invoice, Line', 'Invoice'), ['acme/billing/models']);
  assert.deepStrictEqual(R.importHints("import { Invoice } from '../billing/invoice';", 'Invoice', 'web/src/pages/Home.tsx'), ['web/src/billing/invoice']);
  assert.deepStrictEqual(R.importHints('use crate::billing::Invoice;', 'Invoice'), ['billing/invoice']);
  assert.deepStrictEqual(R.importHints("const { Invoice } = require('./invoice')", 'Invoice', 'lib/a.js'), ['lib/invoice']);
});

test('rankCandidatePaths prefers same language, import hint, non-test', () => {
  const paths = [
    'src/test/java/com/acme/billing/InvoiceTest.java',
    'scripts/invoice.py',
    'src/main/java/com/acme/legacy/Invoice.java',
    'src/main/java/com/acme/billing/Invoice.java',
    'web/src/components/Invoice/index.tsx',
  ];
  const ranked = R.rankCandidatePaths(paths, 'Invoice', {
    currentPath: 'src/main/java/com/acme/api/InvoiceController.java',
    hints: ['com/acme/billing/invoice'],
  });
  assert.strictEqual(ranked[0], 'src/main/java/com/acme/billing/Invoice.java');
  assert.ok(!ranked.includes('src/test/java/com/acme/billing/InvoiceTest.java'));
  const tsx = R.rankCandidatePaths(paths, 'Invoice', { currentPath: 'web/src/pages/Home.tsx' });
  assert.strictEqual(tsx[0], 'web/src/components/Invoice/index.tsx');
  assert.strictEqual(R.rankCandidatePaths(['a/fetch_rates.py', 'b/FetchRates.java'], 'fetchRates', { currentPath: 'x/y.py' })[0], 'a/fetch_rates.py');
});

test('receiverOf', () => {
  assert.strictEqual(R.receiverOf('        petValidator.'), 'petValidator');
  assert.strictEqual(R.receiverOf('  Ledger::'), 'Ledger');
  assert.strictEqual(R.receiverOf('  $this->repo->'), 'repo');
  assert.strictEqual(R.receiverOf('  user?.'), 'user');
  assert.strictEqual(R.receiverOf('  this.'), null);
  assert.strictEqual(R.receiverOf('  call('), null);
});

test('receiverTypes infers declared types', () => {
  assert.deepStrictEqual(R.receiverTypes('private final PetValidator validator;', 'validator'), ['PetValidator', 'validator']);
  assert.deepStrictEqual(R.receiverTypes('constructor(private readonly svc: BillingService) {}', 'svc'), ['BillingService', 'svc']);
  assert.deepStrictEqual(R.receiverTypes('    repo = InvoiceRepo(session)', 'repo'), ['InvoiceRepo', 'repo']);
  assert.deepStrictEqual(R.receiverTypes('fn post(ledger: &mut Ledger) {', 'ledger'), ['Ledger', 'ledger']);
  assert.deepStrictEqual(R.receiverTypes('', 'petValidator'), ['petValidator']);
});

test('python relative imports and rust constructors', () => {
  assert.deepStrictEqual(R.importHints('    from .app import Flask', 'Flask', 'src/flask/sessions.py'), ['src/flask/app']);
  assert.deepStrictEqual(R.importHints('from ..core import Engine', 'Engine', 'pkg/sub/x.py'), ['pkg/core']);
  assert.deepStrictEqual(R.receiverTypes('let mut builder = WalkBuilder::new(td.path());', 'builder'), ['WalkBuilder', 'builder']);
});

test('pathsForHints resolves imports to repo files', () => {
  const tree = ['src/flask/app.py', 'tests/test_app.py', 'packages/excalidraw/actions/actionProperties.tsx', 'src/main/java/com/acme/billing/Invoice.java', 'web/src/billing/invoice/index.ts'];
  assert.deepStrictEqual(R.pathsForHints(tree, ['src/flask/app']), ['src/flask/app.py']);
  assert.deepStrictEqual(R.pathsForHints(tree, ['excalidraw/excalidraw/actions/actionproperties']), ['packages/excalidraw/actions/actionProperties.tsx']);
  assert.deepStrictEqual(R.pathsForHints(tree, ['com/acme/billing/invoice']), ['src/main/java/com/acme/billing/Invoice.java']);
  assert.deepStrictEqual(R.pathsForHints(tree, ['web/src/billing/invoice']), ['web/src/billing/invoice/index.ts']);
});
