'use strict';

// Build a `Module.decl -> { file, line }` manifest by scanning an Elm project's
// source. Elm's compiled JS carries no source locations, so jump-to-source
// derives them here: a module maps to a file under one of elm.json's
// source-directories, and a top-level declaration is the first column-0
// occurrence of its name (its type annotation when present, else its definition).

const fs = require('fs');
const path = require('path');

// keywords / non-decl tokens that can appear at column 0
const KW = new Set([
  'module', 'import', 'port', 'type', 'exposing', 'as', 'where', 'effect', 'infix',
]);

function sourceDirs(projectDir) {
  const elmJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'elm.json'), 'utf8'));
  const dirs = elmJson['source-directories'] || ['src'];
  return dirs.map((d) => path.resolve(projectDir, d));
}

function walkElm(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return acc;
  }
  for (const e of entries) {
    if (e.name === 'elm-stuff' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkElm(p, acc);
    else if (e.name.endsWith('.elm')) acc.push(p);
  }
  return acc;
}

function moduleNameFor(file, dirs) {
  for (const d of dirs) {
    if (file === d || file.startsWith(d + path.sep)) {
      return file.slice(d.length + 1).replace(/\.elm$/, '').split(path.sep).join('.');
    }
  }
  return null;
}

function indexFile(file, mod, manifest) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-z][A-Za-z0-9_]*)\b/.exec(lines[i]);
    if (!m || KW.has(m[1]) || seen.has(m[1])) continue;
    seen.add(m[1]);
    manifest[mod + '.' + m[1]] = { file: file, line: i + 1 };
  }
}

/** Returns { "Module.decl": { file: <abs path>, line: <1-based> }, ... }. */
function buildManifest(projectDir) {
  const dirs = sourceDirs(projectDir);
  const manifest = {};
  for (const d of dirs) {
    for (const file of walkElm(d, [])) {
      const mod = moduleNameFor(file, dirs);
      if (mod) indexFile(file, mod, manifest);
    }
  }
  return manifest;
}

module.exports = { buildManifest };
