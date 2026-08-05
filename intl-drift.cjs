#!/usr/bin/env node
/* intl-drift — CLI entry point (modern Node; the probe itself stays the
 * separate zero-dep ES5 file so it can run on Node 7 and in browsers).
 *
 *   intl-drift probe [--out FILE]        emit a snapshot (stdout by default)
 *   intl-drift selftest                  determinism proof: probe twice, compare
 *   intl-drift diff  A B [flags]         compare two snapshot files
 *   intl-drift init  [--baseline FILE]   create the committed baseline
 *   intl-drift check [--baseline FILE]   probe this runtime vs baseline (CI gate)
 *   intl-drift accept [--baseline FILE]  intentional update: rewrite baseline
 *
 * Flags: --allow-env-mismatch  --verbose  --force
 *
 * Exit codes (design 4.6):
 *   0 no drift · 1 drift found · 2 baseline missing/unreadable
 *   3 env mismatch refused · 4 matrix mismatch refused · 5 tool failure
 *   64 usage error
 */
'use strict';

var fs = require('fs');
var path = require('path');
var probe = require('./probe.cjs');
var diffMod = require('./diff.cjs');

var DEFAULT_BASELINE = path.join('.intl-drift', 'baseline.json');

function usage(code) {
  console.error('usage: intl-drift <probe|selftest|diff|init|check|accept> [options]\n'
    + '  probe   [--out FILE]\n'
    + '  selftest\n'
    + '  diff    <baseline.json> <current.json> [--allow-env-mismatch] [--verbose] [--json] [--locales a,b]\n'
    + '  init    [--baseline FILE] [--force]\n'
    + '  check   [--baseline FILE] [--allow-env-mismatch] [--verbose] [--json] [--locales a,b]\n'
    + '  accept  [--baseline FILE] [--force]');
  process.exit(code);
}

var argv = process.argv.slice(2);
var cmd = argv.shift();
var flags = { positional: [] };
for (var i = 0; i < argv.length; i++) {
  var a = argv[i];
  if (a === '--allow-env-mismatch') { flags.allowEnv = true; }
  else if (a === '--verbose') { flags.verbose = true; }
  else if (a === '--force') { flags.force = true; }
  else if (a === '--json') { flags.json = true; }
  else if (a === '--locales') {
    var lv = argv[++i];
    if (typeof lv === 'undefined' || lv.indexOf('--') === 0) {
      console.error('--locales requires a comma-separated list');
      usage(64);
    }
    flags.appLocales = lv.split(',').map(function (x) { return x.trim(); })
      .filter(function (x) { return x.length; });
  }
  else if (a === '--out' || a === '--baseline') {
    var val = argv[++i];
    if (typeof val === 'undefined' || val.indexOf('--') === 0) {
      console.error(a + ' requires a file path');
      usage(64);
    }
    if (a === '--out') { flags.out = val; } else { flags.baseline = val; }
  }
  else if (a.indexOf('--') === 0) {
    console.error('unknown flag: ' + a);
    usage(64);
  }
  else { flags.positional.push(a); }
}
var baselinePath = flags.baseline || DEFAULT_BASELINE;

function readSnapshot(file, role) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    console.error('cannot read ' + role + ' ' + file + ': ' + e.message);
    return null;
  }
}

function writeBaseline(snapshot) {
  var dir = path.dirname(baselinePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(baselinePath, probe.serialize(snapshot));
}

function probeNow() {
  try { return probe.run(); }
  catch (e) {
    console.error('probe failed: ' + (e && e.message));
    process.exit(5);
  }
}

switch (cmd) {

  case 'probe': {
    var snap = probeNow();
    var text = probe.serialize(snap);
    if (flags.out) {
      fs.writeFileSync(flags.out, text);
      console.error('wrote ' + flags.out + ' (' + text.length + ' bytes)');
    } else {
      process.stdout.write(text);
    }
    process.exitCode = 0; break;
  }

  case 'selftest': {
    var a1 = probe.serialize(probeNow());
    var a2 = probe.serialize(probeNow());
    if (a1 === a2) {
      console.error('selftest OK: two runs byte-identical (' + a1.length + ' bytes)');
      process.exitCode = 0; break;
    }
    console.error('selftest FAILED: runs differ');
    process.exitCode = 1; break;
  }

  case 'diff': {
    if (flags.positional.length !== 2) { usage(64); }
    var sA = readSnapshot(flags.positional[0], 'baseline');
    var sB = readSnapshot(flags.positional[1], 'current');
    if (!sA || !sB) { process.exitCode = 2; break; }
    var rd = diffMod.runDiff(sA, sB, {
      labelA: flags.positional[0], labelB: flags.positional[1],
      allowEnv: flags.allowEnv, verbose: flags.verbose,
      json: flags.json, appLocales: flags.appLocales
    });
    process.exitCode = rd.code; break;
  }

  case 'init': {
    if (fs.existsSync(baselinePath) && !flags.force) {
      console.error('baseline already exists at ' + baselinePath
        + ' — use "intl-drift accept" for intentional updates, or --force');
      process.exitCode = 64; break;
    }
    var s0 = probeNow();
    writeBaseline(s0);
    console.log('baseline written: ' + baselinePath);
    console.log('  ' + diffMod.envLine(s0) + ' · matrix '
      + s0.matrix.id + '@' + s0.matrix.version);
    process.exitCode = 0; break;
  }

  case 'check': {
    /* In --json mode every exit path must still emit a parseable document
       (design 4.5 status enum includes 'error'). */
    function jsonError(msg) {
      if (flags.json) {
        process.stdout.write(probe.serialize(
          { error: msg, schemaVersion: 1, status: 'error' }));
      }
    }
    if (!fs.existsSync(baselinePath)) {
      console.error('no baseline at ' + baselinePath + ' — run: intl-drift init');
      jsonError('baseline-missing: ' + baselinePath);
      process.exitCode = 2; break;
    }
    var base = readSnapshot(baselinePath, 'baseline');
    if (!base) { jsonError('baseline-unreadable: ' + baselinePath); process.exitCode = 2; break; }
    var cur = probeNow();
    var rc = diffMod.runDiff(base, cur, {
      labelA: baselinePath, labelB: 'this runtime',
      allowEnv: flags.allowEnv, verbose: flags.verbose,
      json: flags.json, appLocales: flags.appLocales
    });
    if (rc.code === 1 && !flags.json) {
      console.log('  ' + rc.totalDrift + ' changes.'
        + '  If this runtime change is intentional:  intl-drift accept');
      console.log('');
    }
    process.exitCode = rc.code; break;
  }

  case 'accept': {
    if (!fs.existsSync(baselinePath)) {
      /* Refuse to create baselines (design 4.4): accepting whatever the
         machine happens to produce must not become a first-run habit. */
      console.error('no baseline at ' + baselinePath
        + ' — accept never creates baselines; run: intl-drift init');
      process.exitCode = 2; break;
    }
    var old = readSnapshot(baselinePath, 'baseline');
    if (!old) { process.exitCode = 2; break; }
    var now = probeNow();

    /* Refuse full->small downgrades (design 4.4): accepting a small-icu
       baseline over a full-icu one silently bakes in degraded coverage. */
    var oldVariant = (old.env && old.env.icuVariant) || 'unknown';
    var newVariant = (now.env && now.env.icuVariant) || 'unknown';
    if (oldVariant === 'full' && newVariant === 'small' && !flags.force) {
      console.error('refusing to accept: baseline is full-icu, this runtime is'
        + ' small-icu.\nAccepting would permanently bake in degraded coverage.'
        + ' Use --force to override.');
      process.exitCode = 3; break;
    }

    if (old.matrix.digest !== now.matrix.digest) {
      /* Matrix changed (tool upgrade): accept IS the migration path — rewrite
         without change counts rather than refusing (design 3.2). */
      writeBaseline(now);
      console.log('matrix changed ' + old.matrix.id + '@' + old.matrix.version
        + ' (' + old.matrix.digest + ') -> ' + now.matrix.id + '@'
        + now.matrix.version + ' (' + now.matrix.digest + ')');
      console.log('baseline rewritten: ' + baselinePath
        + ' (change counts unavailable across matrix versions)');
      process.exitCode = 0; break;
    }

    var ra = diffMod.runDiff(old, now, {
      labelA: baselinePath, labelB: 'this runtime',
      allowEnv: true, verbose: flags.verbose
    });
    writeBaseline(now);
    console.log('  accepted ' + ra.totalDrift + ' change'
      + (ra.totalDrift === 1 ? '' : 's') + ' across ' + ra.localesChanged
      + ' locale' + (ra.localesChanged === 1 ? '' : 's')
      + '; baseline now: ' + diffMod.envLine(now));
    console.log('');
    process.exitCode = 0; break;
  }

  default:
    usage(64);
}
