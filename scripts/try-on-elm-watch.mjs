// One-shot: build an elm-watch target (dev, non-optimized) and tag it in place.
//
//   node scripts/try-on-elm-watch.mjs --ui /path/to/ui --target Client
//
// Why non-optimized: elm-watch's postprocess minifies only in `optimize` mode,
// so a plain `elm-watch make <target>` keeps the `$author$project$` symbols the
// injector needs. The output path (public/pre-compiled/elm/<target>/index.js)
// is gitignored, so tagging it in place doesn't touch your PR diff.
//
// NOTE: don't run this while `elm-watch hot` is running — hot recompiles will
// overwrite the tagged file. For live tagging under hot, use the postprocess
// integration (see integrations/elm-watch-postprocess.md).

import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const { transform } = require('../src/inject-view-names.js');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
    return process.argv[i + 1];
  if (process.argv.includes('--' + name)) return true; // boolean flag
  return fallback;
}

const uiDir = path.resolve(arg('ui', '/Users/dwightdoane/AVETTA/ui'));
const target = arg('target', 'Client');
const attr = arg('attr', 'elm-view-name');
const wrap = !!arg('wrap', false);

const binDir = path.join(uiDir, 'node_modules', '.bin');
const elmWatch = path.join(binDir, 'elm-watch');
if (!fs.existsSync(elmWatch)) {
  console.error(`elm-watch not found at ${elmWatch} — is --ui correct?`);
  process.exit(1);
}

// elm-watch finds `elm` on PATH; elm-tooling puts it in node_modules/.bin.
const env = { ...process.env, PATH: binDir + path.delimiter + process.env.PATH };

console.log(`> elm-watch make ${target}   (cwd: ${uiDir})`);
execFileSync(elmWatch, ['make', target], { cwd: uiDir, env, stdio: 'inherit' });

const out = path.join(uiDir, 'public', 'pre-compiled', 'elm', target, 'index.js');
if (!fs.existsSync(out)) {
  console.error(`expected output not found: ${out}`);
  process.exit(1);
}

const { code, stats } = transform(fs.readFileSync(out, 'utf8'), { attr, wrap });
fs.writeFileSync(out, code);

const unique = [...new Set(stats.tagged)];
console.log(
  `\ntagged ${stats.spliced} elements` +
    (stats.wrapped ? ` + wrapped ${stats.wrapped}` : '') +
    ` (${unique.length} unique view fns) -> ${path.relative(process.cwd(), out)}`
);
console.log('  e.g. ' + unique.slice(0, 6).join(', ') + (unique.length > 6 ? ', …' : ''));
console.log(
  `\nNow serve WITHOUT hot (so it isn't overwritten), e.g.:\n` +
    `  cd ${uiDir} && npm run start:express   # + your usual mocks/env\n` +
    `Then in the app: document.querySelectorAll('[${attr}]')`
);
