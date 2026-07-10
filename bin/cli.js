#!/usr/bin/env node
'use strict';

/**
 * CLI + elm-watch/elm-make postprocess entry point.
 *
 *   inject-view-names <input.js> -o <output.js>      # file -> file
 *   elm make src/Main.elm --output=out.js && inject-view-names out.js -i
 *   cat out.js | inject-view-names --stdin > tagged.js
 *
 * elm-watch integration (elm-watch.json):
 *   "postprocess": ["node", "path/to/bin/cli.js", "--stdin"]
 *   (elm-watch pipes the compiled JS on stdin and appends its own args, which
 *    we ignore; run this BEFORE any minifier in the chain.)
 */

const fs = require('fs');
const path = require('path');
const { transform } = require('../src/inject-view-names');
const { buildManifest } = require('../src/manifest');

function parseArgs(argv) {
  const opts = { input: null, output: null, stdin: false, inPlace: false, stats: false, wrap: false };
  const transformOpts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
        break;
      case '--stdin':
        opts.stdin = true;
        break;
      case '-i':
      case '--in-place':
        opts.inPlace = true;
        break;
      case '--stats':
        opts.stats = true;
        break;
      case '--wrap':
        transformOpts.wrap = true;
        break;
      case '--overlay':
        transformOpts.overlay = true;
        break;
      case '--manifest':
        // build a Module.decl -> file:line manifest from an Elm project dir and
        // embed it for jump-to-source (implies --overlay)
        transformOpts.overlay = true;
        transformOpts.manifest = buildManifest(argv[++i]);
        break;
      case '-o':
      case '--output':
        opts.output = argv[++i];
        break;
      case '--attr':
        transformOpts.attr = argv[++i];
        break;
      case '--prefix':
        transformOpts.prefix = argv[++i];
        break;
      default:
        // First real positional that is an existing file = input. elm-watch
        // appends extra positionals (target/mode/version) which we ignore.
        if (!a.startsWith('-') && !opts.input && fileExists(a)) opts.input = a;
    }
  }
  return { opts, transformOpts };
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function printHelp() {
  process.stdout.write(
    [
      'inject-view-names — tag Elm view functions with an elm-view-name attribute',
      '',
      'Usage:',
      '  inject-view-names <input.js> [-o out.js | -i] [options]',
      '  cat out.js | inject-view-names --stdin > tagged.js',
      '',
      'Options:',
      '  -o, --output <file>  write to file (default: stdout)',
      '  -i, --in-place       overwrite the input file',
      '      --stdin          read source from stdin',
      '      --attr <name>    attribute name (default: elm-view-name)',
      '      --prefix <str>   app symbol prefix (default: $author$project$)',
      '      --wrap           also tag text/map/lazy via a display:contents div',
      '      --overlay        append the in-page DevTools overlay (experimental)',
      '      --manifest <dir> embed a source manifest from an Elm project (jump-to-source; implies --overlay)',
      '      --stats          print tag counts to stderr',
      '  -h, --help           show this help',
      '',
    ].join('\n')
  );
}

function main() {
  const { opts, transformOpts } = parseArgs(process.argv.slice(2));

  const useStdin = opts.stdin || (!opts.input && !process.stdin.isTTY);
  const code = useStdin ? readStdin() : opts.input ? fs.readFileSync(opts.input, 'utf8') : null;

  if (code == null) {
    printHelp();
    process.exit(1);
  }

  const { code: out, stats } = transform(code, transformOpts);

  if (opts.stats) {
    process.stderr.write(
      `inject-view-names: spliced ${stats.spliced}, wrapped ${stats.wrapped}, skipped ${stats.skipped}\n`
    );
  }

  const dest = opts.inPlace ? opts.input : opts.output;
  if (dest) {
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    fs.writeFileSync(dest, out);
  } else {
    process.stdout.write(out);
  }
}

main();
