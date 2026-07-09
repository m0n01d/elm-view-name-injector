'use strict';

/**
 * Self-contained test: transforms the committed compiled fixture
 * (test/fixtures/corpus.compiled.js) and asserts each permutation was handled
 * correctly. No Elm toolchain required.
 *
 * Assertions run against `stats.tagged` (the list of qualified names actually
 * spliced) rather than the printed JS, so they're independent of formatting.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const babelParser = require('@babel/parser');
const { transform, demangle } = require('../src/inject-view-names');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/corpus.compiled.js'), 'utf8');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (e) {
    failures++;
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

// --- unit: demangle ---------------------------------------------------------
console.log('demangle');
check('single-segment module', () =>
  assert.strictEqual(demangle('$author$project$Main$viewA1', '$author$project$'), 'Main.viewA1')
);
check('multi-segment module', () =>
  assert.strictEqual(
    demangle('$author$project$Ui$Button$primary', '$author$project$'),
    'Ui.Button.primary'
  )
);
check('3-segment module path', () =>
  assert.strictEqual(
    demangle('$author$project$Page$Settings$Form$viewField', '$author$project$'),
    'Page.Settings.Form.viewField'
  )
);
check('non-app symbol -> null', () =>
  assert.strictEqual(demangle('$elm$html$Html$div', '$author$project$'), null)
);

// --- integration: transform the whole fixture -------------------------------
const { code, stats } = transform(fixture);
console.log(`\ntransform (spliced=${stats.spliced}, wrapped=${stats.wrapped}, skipped=${stats.skipped})`);

const bag = stats.tagged; // multiset of qnames
const count = (q) => bag.filter((x) => x === q).length;
const has = (q) => bag.includes(q);

const SHOULD_TAG = [
  // Main — arity + return shapes + attrs/events
  'Main.viewA0', 'Main.viewA1', 'Main.viewA2', 'Main.viewA3',
  'Main.viewElemEmptyAttrs', 'Main.viewCase', 'Main.viewPipeElem',
  'Main.viewConsAttrs', 'Main.viewChildrenMap', 'Main.viewCustomNode',
  'Main.viewKeyed', 'Main.viewOneAttr', 'Main.viewTwoAttrs',
  'Main.viewAttrPlusEvent', 'Main.viewEventsOnly', 'Main.viewManyAttrsEvents',
  'Main.viewAttrsAppended', 'Main.view',
  // spread across many modules (demangling)
  'Ui.Button.primary', 'Ui.Button.secondary',
  'Ui.Layout.card', 'Ui.Layout.page',
  'Widget.Badge.view', 'Widget.Counter.view',
  'Page.Home.viewToolbar',
  'Page.Settings.Form.view', 'Page.Settings.Form.viewField',
  'Page.Settings.Form.viewStatus', // the `if` shape, now in a 3-segment module
];

const SHOULD_NOT_TAG = [
  'Main.viewText',      // bare text node — opaque
  'Main.viewPipeText',  // pipeline ending in text
  'Main.viewMap',       // Html.map
  'Main.viewLazy',      // Html.Lazy.lazy
  'Main.viewDelegate',  // returns viewA1(model) — callee self-tags instead
  'Main.viewPointFree', // alias `var x = viewA1;`
  'Main.viewItems',     // returns List (Html Msg), not a single element
  'Main.init',          // record value
  'Main.update',        // returns model records
  'Page.Home.view',     // returns Layout.page(...) — cross-module delegation; Ui.Layout.page self-tags
];

console.log('\nsplice coverage');
for (const q of SHOULD_TAG) check(`tags ${q}`, () => assert.ok(has(q), 'expected tag missing'));

console.log('\nnegative cases (must NOT tag)');
for (const q of SHOULD_NOT_TAG) check(`skips ${q}`, () => assert.ok(!has(q), 'wrongly tagged'));

console.log('\nbranch handling (one tag per branch)');
check('viewStatus (if) tags both ternary branches', () =>
  assert.strictEqual(
    count('Page.Settings.Form.viewStatus'),
    2,
    `got ${count('Page.Settings.Form.viewStatus')}`
  )
);
check('viewCase tags its two element branches (not the text branch)', () =>
  assert.strictEqual(count('Main.viewCase'), 2, `got ${count('Main.viewCase')}`)
);

console.log('\nmulti-module coverage');
check('tags survive across 7 modules', () => {
  const modules = new Set(bag.map((q) => q.slice(0, q.lastIndexOf('.'))));
  for (const m of ['Main', 'Ui.Button', 'Ui.Layout', 'Widget.Badge', 'Widget.Counter', 'Page.Home', 'Page.Settings.Form'])
    assert.ok(modules.has(m), `no tags from module ${m}`);
});
check('distinct `view`s in different modules stay distinct', () => {
  assert.ok(has('Main.view') && has('Widget.Counter.view') && has('Page.Settings.Form.view'));
});

console.log('\noutput validity');
check('transformed bundle is still valid JS', () =>
  babelParser.parse(code, { sourceType: 'script' })
);
check('injects via the tree-shake-proof kernel helper _VirtualDom_attribute', () => {
  const baseline = (fixture.match(/_VirtualDom_attribute/g) || []).length; // kernel def + internal uses
  const after = (code.match(/_VirtualDom_attribute/g) || []).length;
  assert.strictEqual(after - baseline, stats.spliced, `added ${after - baseline}, spliced ${stats.spliced}`);
});

console.log('\nidempotency');
check('second pass is a no-op', () => {
  const again = transform(code);
  assert.strictEqual(again.stats.spliced, 0, `re-splice count ${again.stats.spliced}`);
});

console.log('\n--wrap mode');
const wrapped = transform(fixture, { wrap: true });
check('wraps the opaque forms (text/map/lazy)', () =>
  assert.ok(wrapped.stats.wrapped >= 3, `wrapped=${wrapped.stats.wrapped}`)
);
check('wrapped output still valid JS', () =>
  babelParser.parse(wrapped.code, { sourceType: 'script' })
);

console.log('');
if (failures) {
  console.error(`FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log(`All checks passed (${stats.spliced} elements tagged).`);
