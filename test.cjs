#!/usr/bin/env node
/* intl-drift test suite. Run: node test.cjs
 * Groups: serialization invariants · display rendering · incident
 * regressions (against stored snapshots) · CLI exit-code contract.
 * Exit 0 = all pass, 1 = failures.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var probe = require('./probe.cjs');
var diffMod = require('./diff.cjs');

var passed = 0, failed = 0, failures = [];
function t(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; failures.push(name + (extra ? '  [' + extra + ']' : '')); }
}

var NODE = process.execPath;
var HERE = __dirname;
function run(args, cwd) {
  return spawnSync(NODE, args, { cwd: cwd || HERE, encoding: 'utf8' });
}
function cli(args, cwd) { return run([path.join(HERE, 'intl-drift.cjs')].concat(args), cwd); }

/* ---------- 1. serialization invariants ---------- */

var snap = probe.run();
var text1 = probe.serialize(snap);

t('serialize: pure ASCII', !/[^\x00-\x7f]/.test(text1));
t('serialize: LF only, single trailing newline',
  text1.indexOf('\r') === -1 && /[^\n]\n$/.test(text1));
t('serialize: canonical form is idempotent (parse -> reserialize -> identical)',
  probe.serialize(JSON.parse(text1)) === text1);
var floatThrew = false;
try { probe.serialize({ x: 1.5 }); } catch (eF) { floatThrew = true; }
t('serialize: refuses floats (determinism guard)', floatThrew);
var nanThrew = false;
try { probe.serialize({ x: NaN }); } catch (eN) { nanThrew = true; }
t('serialize: refuses non-finite numbers', nanThrew);

var pkg = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
t('version: probe TOOL.version matches package.json',
  probe.toolVersion === pkg.version);
var api = require('./index.cjs');
t('api: index.cjs exposes probe/serialize/diff/disp/deriveRule/version',
  typeof api.probe === 'function' && typeof api.serialize === 'function'
  && typeof api.diff === 'function' && typeof api.disp === 'function'
  && typeof api.deriveRule === 'function' && api.version === pkg.version);
t('api: package.json main points at index.cjs', pkg.main === './index.cjs');
t('api: bin file is listed in files', pkg.files.indexOf('index.cjs') !== -1
  && pkg.files.indexOf('probe.cjs') !== -1);
t('matrix: id core@1', snap.matrix.id === 'core' && snap.matrix.version === 1);
t('matrix: definition embedded and digest present',
  !!snap.matrix.definition && /^[0-9a-f]{8}$/.test(snap.matrix.digest));
t('env: every versions key present (absence sentinel, never omitted)',
  ['icu', 'cldr', 'tz', 'unicode'].every(function (k) {
    return typeof snap.env.versions[k] !== 'undefined';
  }));
t('results: 27 locales', Object.keys(snap.results).length === 27);
t('results: de-CH ym set exists (incident 5 seed)',
  typeof snap.results['de-CH'].DateTimeFormat.ym === 'object');

/* stored snapshot files must be pure ASCII too */
['fixtures/phase1/node-18.13.0.json', 'demo/node-baseline.json',
 'refs/node-22.json'].forEach(function (f) {
  var p = path.join(HERE, f);
  if (fs.existsSync(p)) {
    t('file is pure ASCII: ' + f, !/[^\x00-\x7f]/.test(fs.readFileSync(p, 'utf8')));
  }
});

/* ---------- 2. display rendering ---------- */

t('disp: NNBSP escaped', diffMod.disp('1:45\u202fPM') === '1:45<U+202F>PM');
t('disp: NBSP escaped', diffMod.disp('a\u00a0b') === 'a<U+00A0>b');
t('disp: THIN SPACE escaped (formatRange lesson)',
  diffMod.disp('x\u2009y') === 'x<U+2009>y');
t('disp: bidi marks escaped',
  diffMod.disp('\u061c\u200f9') === '<U+061C><U+200F>9');
t('disp: plain ASCII untouched', diffMod.disp('Jan 15, 2024') === 'Jan 15, 2024');
t('disp: ideographic space escaped', diffMod.disp('a\u3000b') === 'a<U+3000>b');
t('disp: visible Unicode NOT escaped (grn stays readable)',
  diffMod.disp('\u0433\u0440\u043d') === '\u0433\u0440\u043d');

/* ---------- 3. incident regressions on stored snapshots ---------- */

function fileDiff(a, b, extraArgs) {
  return run([path.join(HERE, 'diff.cjs'),
    path.join(HERE, a), path.join(HERE, b)].concat(extraArgs || []));
}

/* Frozen snapshots from the incident-reproduction runs, committed as test
   fixtures: phase0/* were captured on the phase0@1 matrix, phase1/* on
   core@1 — which is itself what the matrix-mismatch tests rely on. */
var P0 = 'fixtures/phase0/', P1 = 'fixtures/phase1/';

if (fs.existsSync(path.join(HERE, P0, 'node-14.16.1.json'))) {
  var d1 = fileDiff(P0 + 'node-14.16.1.json', P0 + 'node-14.17.0.json', ['--verbose']);
  t('incident 1: exit 1', d1.status === 1);
  t('incident 1: fr-CA $ -> $ CA with escaped NBSP',
    d1.stdout.indexOf('<U+00A0>$<U+00A0>CA') !== -1);

  var d2 = fileDiff(P0 + 'node-7.10.1-small.json', P0 + 'node-8.0.0-small.json', ['--verbose']);
  t('incident 2: exit 1', d2.status === 1);
  t('incident 2: resolution section shows fallback-locale change',
    d2.stdout.indexOf('en-US-u-va-posix') !== -1 && d2.stdout.indexOf('und') !== -1);

  var d2c = fileDiff(P0 + 'node-7.10.1-full.json', P0 + 'node-8.0.0-full.json', ['--verbose']);
  t('incident 2 control: full-icu pair has NO ru-RU curUSD drift',
    d2c.stdout.indexOf('ru-RU  curUSD') === -1);

  var d4 = fileDiff(P0 + 'node-22.5.0.json', P0 + 'node-22.14.0.json');
  t('incident 4: exit 1', d4.status === 1);
  t('incident 4: en-GB dateFull comma', d4.stdout.indexOf('Monday, 15 January') !== -1);

  var clean = fileDiff(P0 + 'node-22.14.0.json', P0 + 'node-22.16.0.json');
  t('ICU 76->77: clean, exit 0', clean.status === 0);
  t('ICU 76->77: says "no drift in N locales" (C1 phrasing)',
    /no drift in \d+ locales/.test(clean.stdout));

  var mm = fileDiff(P0 + 'node-22.16.0.json', P1 + 'node-18.13.0.json');
  t('matrix mismatch phase0-vs-core: exit 4', mm.status === 4);

  var env3 = fileDiff(P0 + 'node-7.10.1-small.json', P0 + 'node-14.16.1.json');
  t('small-vs-full: refused, exit 3', env3.status === 3);
  var env3b = fileDiff(P0 + 'node-7.10.1-small.json', P0 + 'node-14.16.1.json',
    ['--allow-env-mismatch']);
  t('small-vs-full with override: proceeds, exit 1', env3b.status === 1);
}

if (fs.existsSync(path.join(HERE, P1, 'node-14.17.0.json'))) {
  var d5 = fileDiff(P1 + 'node-14.17.0.json', P1 + 'node-18.13.0.json', ['--verbose']);
  t('incident 5: exit 1', d5.status === 1);
  t('incident 5: de-CH ym separator caught', /de-CH\s+ym\./.test(d5.stdout));
  t('NNBSP arrival rendered escaped', d5.stdout.indexOf('<U+202F>') !== -1);
  t('collator canary never prints raw permutation',
    !/collation[\s\S]*\d+,\d+,\d+,\d+,\d+/.test(d5.stdout));
}

/* ---------- 3b. uniform-transformation collapse ---------- */

t('deriveRule: space -> NNBSP',
  diffMod.deriveRule('1:45 PM', '1:45 PM') === '"U+0020" -> "U+202F"');
t('deriveRule: insertion renders (nothing)',
  diffMod.deriveRule('15 mars 101 12', '15 mars 101, 12') === '(nothing) -> ","');
t('deriveRule: long rewrites refuse to collapse (null)',
  diffMod.deriveRule('Dydd Iau, 15 Mawrth', 'Thursday, March 15') === null);
t('deriveRule: non-string returns null',
  diffMod.deriveRule({ threw: 'X' }, 'y') === null);
t('deriveRule: overlapping prefix/suffix safe ("aa" -> "aaa")',
  diffMod.deriveRule('aa', 'aaa') === '(nothing) -> "a"');

if (fs.existsSync(path.join(HERE, P1, 'node-14.17.0.json'))) {
  var dCollapse = fileDiff(P1 + 'node-14.17.0.json', P1 + 'node-18.13.0.json');
  t('collapse: NNBSP group collapses to one rule line',
    dCollapse.stdout.indexOf('* uniform substitution: "U+0020" -> "U+202F"') !== -1);
  t('collapse: incident 5 forms its own group ("1." -> "01/")',
    dCollapse.stdout.indexOf('* uniform substitution: "1." -> "01/"') !== -1);
  t('collapse: fa-IR RLM removal grouped',
    dCollapse.stdout.indexOf('"U+200F" -> (nothing)') !== -1);
  t('collapse: formatRange thin-space arrival grouped',
    dCollapse.stdout.indexOf('"U+0020U+2013U+0020" -> "U+2009U+2013U+2009"') !== -1);
  t('collapse: group states entry count and locales',
    /\d+ entries · /.test(dCollapse.stdout));
}

/* ---------- 3c. --json output (design 4.5) ---------- */

if (fs.existsSync(path.join(HERE, P1, 'node-14.17.0.json'))) {
  var j1 = fileDiff(P1 + 'node-14.17.0.json', P1 + 'node-18.13.0.json', ['--json']);
  t('json: drift run still exits 1', j1.status === 1);
  t('json: output is pure ASCII', !/[^\x00-\x7f]/.test(j1.stdout));
  var doc = null;
  try { doc = JSON.parse(j1.stdout); } catch (e) {}
  t('json: parses as JSON', doc !== null);
  if (doc) {
    t('json: schemaVersion 1', doc.schemaVersion === 1);
    t('json: status drift', doc.status === 'drift');
    t('json: baseline/current env summaries present',
      doc.baseline.icuVariant === 'full' && /^node /.test(doc.current.runtime));
    t('json: matrix identity present', /^[0-9a-f]{8}$/.test(doc.matrix.digest));
    t('json: summary counts consistent',
      doc.summary.total === doc.summary.byCategory.output
        + doc.summary.byCategory.resolution + doc.summary.byCategory.errorStatus
        + doc.summary.byCategory.collation);
    t('json: changes array matches counted categories',
      doc.changes.length === doc.summary.byCategory.output
        + doc.summary.byCategory.resolution + doc.summary.byCategory.errorStatus);
    var nnbsp = doc.groups.filter(function (g) {
      return g.rule === '"U+0020" -> "U+202F"';
    });
    t('json: NNBSP group present with entries and locales',
      nnbsp.length === 1 && nnbsp[0].entries > 100 && nnbsp[0].locales.length > 10);
    var grouped = doc.changes.filter(function (c) { return c.group === nnbsp[0].id; });
    t('json: grouped changes reference the group id',
      nnbsp.length === 1 && grouped.length === nnbsp[0].entries);
    t('json: no raw collator permutation anywhere',
      !/"\d+(,\d+){10,}"/.test(j1.stdout));
    t('json: idempotent canonical serialization',
      probe.serialize(JSON.parse(j1.stdout)) === j1.stdout);
  }

  var j0 = fileDiff(P0 + 'node-22.14.0.json', P0 + 'node-22.16.0.json', ['--json']);
  var doc0 = null;
  try { doc0 = JSON.parse(j0.stdout); } catch (e2) {}
  t('json: clean run -> status clean, exit 0',
    j0.status === 0 && doc0 && doc0.status === 'clean' && doc0.summary.total === 0);

  var j3 = fileDiff(P0 + 'node-7.10.1-small.json', P0 + 'node-14.16.1.json', ['--json']);
  var doc3 = null;
  try { doc3 = JSON.parse(j3.stdout); } catch (e3) {}
  t('json: env mismatch -> status env-mismatch, exit 3',
    j3.status === 3 && doc3 && doc3.status === 'env-mismatch');

  var j4 = fileDiff(P0 + 'node-22.16.0.json', P1 + 'node-18.13.0.json', ['--json']);
  var doc4 = null;
  try { doc4 = JSON.parse(j4.stdout); } catch (e4) {}
  t('json: matrix mismatch -> status matrix-mismatch with both identities, exit 4',
    j4.status === 4 && doc4 && doc4.status === 'matrix-mismatch'
    && doc4.matrix.baseline.digest !== doc4.matrix.current.digest);
}

/* ---------- 3d. --locales coverage (C1/C2) ---------- */

if (fs.existsSync(path.join(HERE, P1, 'node-14.17.0.json'))) {
  var c1 = fileDiff(P1 + 'node-14.17.0.json', P1 + 'node-18.13.0.json',
    ['--locales', 'de-AT,de-DE,en-US']);
  t('coverage: uncovered app locale named', c1.stdout.indexOf('NOT covered') !== -1
    && c1.stdout.indexOf('de-AT') !== -1);
  t('coverage: exit code unchanged by coverage warning', c1.status === 1);

  var c2 = fileDiff(P1 + 'node-14.17.0.json', P1 + 'node-18.13.0.json',
    ['--locales', 'de-DE,en-US']);
  t('coverage: all-covered message', c2.stdout.indexOf('All app locales are covered') !== -1);

  var c3 = fileDiff(P1 + 'node-14.17.0.json', P1 + 'node-18.13.0.json',
    ['--json', '--locales', 'de-AT,en-US']);
  var doc5 = null;
  try { doc5 = JSON.parse(c3.stdout); } catch (e5) {}
  t('coverage: json carries appLocales and uncovered',
    doc5 && doc5.coverage.uncovered.length === 1 && doc5.coverage.uncovered[0] === 'de-AT');

  t('coverage: --locales without value -> 64',
    fileDiff(P1 + 'node-14.17.0.json', P1 + 'node-18.13.0.json', ['--locales']).status === 64);

  var cTrim = fileDiff(P1 + 'node-14.17.0.json', P1 + 'node-18.13.0.json',
    ['--locales', ' de-DE , en-US ']);
  t('coverage: --locales entries are trimmed',
    cTrim.stdout.indexOf('All app locales are covered') !== -1);
}

/* ---------- 4. CLI exit-code contract (isolated temp dir) ---------- */

var os = require('os');
var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'intl-drift-test-'));

t('cli: no command -> 64', cli([], TMP).status === 64);
t('cli: unknown command -> 64', cli(['bogus'], TMP).status === 64);
t('cli: diff with one file -> 64', cli(['diff', 'x.json'], TMP).status === 64);
t('cli: --baseline without value -> 64', cli(['check', '--baseline'], TMP).status === 64);
t('cli: unknown flag -> 64', cli(['check', '--frobnicate'], TMP).status === 64);

t('cli: check without baseline -> 2', cli(['check'], TMP).status === 2);
t('cli: accept without baseline -> 2 (never creates)',
  cli(['accept'], TMP).status === 2);

var rInit = cli(['init'], TMP);
t('cli: init -> 0', rInit.status === 0);
t('cli: init writes baseline',
  fs.existsSync(path.join(TMP, '.intl-drift', 'baseline.json')));
t('cli: baseline file is pure ASCII',
  !/[^\x00-\x7f]/.test(fs.readFileSync(path.join(TMP, '.intl-drift', 'baseline.json'), 'utf8')));

t('cli: check clean -> 0', cli(['check'], TMP).status === 0);
var rChk = cli(['check'], TMP);
t('cli: clean check prints coverage footer (C1)',
  rChk.stdout.indexOf('COVERAGE') !== -1);
t('cli: init over existing -> 64', cli(['init'], TMP).status === 64);
t('cli: init --force -> 0', cli(['init', '--force'], TMP).status === 0);

/* drifted baseline: use a stored core@1 snapshot from another runtime */
if (fs.existsSync(path.join(HERE, P1, 'node-18.13.0.json'))) {
  fs.copyFileSync(path.join(HERE, P1, 'node-18.13.0.json'),
    path.join(TMP, '.intl-drift', 'baseline.json'));
  var rDrift = cli(['check'], TMP);
  t('cli: drifted check -> 1', rDrift.status === 1);
  t('cli: drifted check prints accept hint',
    rDrift.stdout.indexOf('intl-drift accept') !== -1);
  var rAcc = cli(['accept'], TMP);
  t('cli: accept -> 0', rAcc.status === 0);
  t('cli: accept prints honest count', /accepted \d+ changes across \d+ locales/.test(rAcc.stdout));
  t('cli: check after accept -> 0', cli(['check'], TMP).status === 0);
}

/* matrix migration: phase0 snapshot as baseline, accept must migrate */
if (fs.existsSync(path.join(HERE, P0, 'node-22.16.0.json'))) {
  fs.copyFileSync(path.join(HERE, P0, 'node-22.16.0.json'),
    path.join(TMP, '.intl-drift', 'baseline.json'));
  t('cli: check across matrix change -> 4', cli(['check'], TMP).status === 4);
  var rMig = cli(['accept'], TMP);
  t('cli: accept migrates matrix -> 0', rMig.status === 0);
  t('cli: migration message states counts unavailable',
    rMig.stdout.indexOf('change counts unavailable') !== -1);
  t('cli: check after migration -> 0', cli(['check'], TMP).status === 0);
}

var rOut = cli(['probe', '--out', path.join(TMP, 'p.json')], TMP);
t('cli: probe --out -> 0 and writes file',
  rOut.status === 0 && fs.existsSync(path.join(TMP, 'p.json')));
t('cli: selftest -> 0', cli(['selftest'], TMP).status === 0);

/* ---------- report ---------- */

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* leave it */ }

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) {
  failures.forEach(function (f) { console.log('  FAIL: ' + f); });
  process.exit(1);
}
process.exit(0);
