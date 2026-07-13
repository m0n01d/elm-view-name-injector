'use strict';

/**
 * Compile the example Elm corpus and tag it, so you can open it and inspect the
 * elm-view-name attributes in a browser / DevTools.
 *
 *   node scripts/build-example.js            # standard dev build
 *   node scripts/build-example.js --debug    # elm --debug (time-travel debugger)
 *
 * Finds an `elm` binary from $ELM_BINARY, node_modules/.bin, or PATH.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { transform } = require('../src/inject-view-names');
const { buildManifest } = require('../src/manifest');

const exampleDir = path.join(__dirname, '..', 'example');
const raw = path.join(exampleDir, 'out.js');
const tagged = path.join(exampleDir, 'out.tagged.js');
const debug = process.argv.includes('--debug');

function findElm() {
  if (process.env.ELM_BINARY) return process.env.ELM_BINARY;
  const local = path.join(__dirname, '..', 'node_modules', '.bin', 'elm');
  if (fs.existsSync(local)) return local;
  return 'elm'; // fall back to PATH
}

const elm = findElm();
const args = ['make', 'src/Main.elm', '--output=' + raw];
if (debug) args.push('--debug');

console.log(`$ ${elm} ${args.join(' ')}  (cwd: example)`);
execFileSync(elm, args, { cwd: exampleDir, stdio: 'inherit' });

const withOverlay = process.argv.includes('--overlay');
const { code, stats } = transform(fs.readFileSync(raw, 'utf8'), {
  wrap: process.argv.includes('--wrap'),
  overlay: withOverlay,
  capture: process.argv.includes('--capture'),
  manifest: withOverlay ? buildManifest(exampleDir) : undefined,
});
fs.writeFileSync(tagged, code);

console.log(
  `\ntagged ${stats.spliced} elements` +
    (stats.wrapped ? ` + wrapped ${stats.wrapped}` : '') +
    ` -> ${path.relative(process.cwd(), tagged)}`
);
console.log('Unique view names tagged:');
[...new Set(stats.tagged)].sort().forEach((q) => console.log('  ' + q));
