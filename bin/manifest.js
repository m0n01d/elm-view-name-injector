#!/usr/bin/env node
'use strict';

// Emit a Module.decl -> file:line manifest for jump-to-source.
//
//   inject-view-manifest <elm-project-dir> -o public/elm-view-manifest.json
//   inject-view-manifest . > manifest.json
//
// For big apps, generate this once (and on source changes) and serve the JSON;
// the overlay fetches /elm-view-manifest.json when no manifest is embedded.
// That avoids re-scanning source on every hot reload.

const fs = require('fs');
const { buildManifest } = require('../src/manifest');

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith('-')) || '.';
const oi = Math.max(argv.indexOf('-o'), argv.indexOf('--output'));
const out = oi > -1 ? argv[oi + 1] : null;

const manifest = buildManifest(dir);
const json = JSON.stringify(manifest);

if (out) {
  fs.writeFileSync(out, json);
  process.stderr.write('wrote ' + Object.keys(manifest).length + ' entries -> ' + out + '\n');
} else {
  process.stdout.write(json);
}
