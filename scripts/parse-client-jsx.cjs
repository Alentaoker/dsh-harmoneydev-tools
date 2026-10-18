// Parser-only JSX check: parse the bundle source with Babel's parser.
// No transform, no code generation, no bundler, no output artifacts.
// Usage: node scripts/parse-client-jsx.cjs [file...]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function loadParser() {
  const candidates = [
    // Playwright shipped with the local Codex/DSH runtime.
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules', 'playwright', 'lib', 'transform', 'babelBundle.js'),
    // Any local install.
    'playwright/lib/transform/babelBundle.js',
    '@babel/parser',
  ];
  const errors = [];
  for (const candidate of candidates) {
    try {
      if (candidate === '@babel/parser') return { parse: require('@babel/parser').parse, from: candidate };
      const mod = require(candidate);
      if (typeof mod.babelParse === 'function') return { parse: mod.babelParse, from: candidate };
    } catch (error) { errors.push(`${candidate}: ${error.message}`); }
  }
  return { parse: undefined, errors };
}

const files = process.argv.slice(2);
if (!files.length) files.push(path.resolve(__dirname, '..', 'plugin', 'dsh-e2e', 'src', 'client.jsx'));
const parser = loadParser();
if (!parser.parse) {
  console.error(JSON.stringify({ parsed: false, reason: 'NO_PARSER', errors: parser.errors }, null, 2));
  process.exit(2);
}
let failed = false;
const results = [];
for (const file of files) {
  try {
    const code = fs.readFileSync(file, 'utf8');
    parser.parse(code, file, true);
    results.push({ file, parsed: true });
  } catch (error) {
    failed = true;
    results.push({ file, parsed: false, code: error.code, reasonCode: error.reasonCode, line: error.loc?.line, column: error.loc?.column, message: error.message.split('\n')[0] });
  }
}
console.log(JSON.stringify({ parser: parser.from, results }, null, 2));
process.exit(failed ? 1 : 0);
