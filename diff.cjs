#!/usr/bin/env node
/* intl-drift diff — comparison engine (module) + CLI.
 *
 * CLI: node diff.cjs <baseline.json> <current.json> [--allow-env-mismatch]
 *                    [--verbose] [--json] [--locales a,b,c]
 * Module: require('./diff.cjs').runDiff(snapA, snapB, opts) -> {code, ...}
 *
 * Exit codes (design 4.6):
 *   0 no drift · 1 drift found · 2 baseline missing/unreadable
 *   3 env mismatch refused · 4 matrix mismatch refused · 5 tool failure
 *   64 usage error
 */
'use strict';

var fs = require('fs');
var canonSerialize = require('./probe.cjs').serialize;

var JSON_SCHEMA_VERSION = 1; /* --json document schema, independent of the
                                snapshot formatVersion (design 4.5) */
var CAP = 12; /* per-API drift lines shown without --verbose */
var MIN_COLLAPSE = 4; /* smallest bucket that collapses to a rule line */

/* Encode one side of a substitution rule as a display token containing no
   spaces (the removed side is frequently ITSELF a space — U+0020 vs U+202F
   is the flagship case, so sides must be encoded before keying/printing). */
function encSide(s) {
  if (s === '') { return '(nothing)'; }
  var out = '', i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    if (c > 32 && c < 127) { out += s.charAt(i); }
    else { out += 'U+' + ('0000' + c.toString(16).toUpperCase()).slice(-4); }
  }
  return '"' + out + '"';
}

/* Derive the character-level substitution turning a into b, or null when the
   change is not a short substitution (design 4.2: character substitutions
   only — anything cleverer risks mis-describing a diff). */
function deriveRule(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') { return null; }
  var maxp = Math.min(a.length, b.length), p = 0, s = 0;
  while (p < maxp && a.charAt(p) === b.charAt(p)) { p++; }
  while (s < maxp - p
      && a.charAt(a.length - 1 - s) === b.charAt(b.length - 1 - s)) { s++; }
  var rem = a.slice(p, a.length - s), add = b.slice(p, b.length - s);
  if (rem.length > 4 || add.length > 4) { return null; }
  return encSide(rem) + ' -> ' + encSide(add);
}

/* Display rendering (design 3.4/4.3): decoded text, invisibles re-escaped.
   Covers every Unicode space separator except U+0020 — ICU emits U+2009
   around formatRange dashes and it must never render as a plain space. */
function invisible(c) {
  return c < 32 || c === 127 || (c >= 128 && c <= 160)
    || c === 0x061c || c === 0x1680 || c === 0x180e
    || (c >= 0x2000 && c <= 0x200f)
    || (c >= 0x2028 && c <= 0x202f) || (c >= 0x205f && c <= 0x206f)
    || c === 0x3000 || c === 0xfeff;
}
function disp(s) {
  if (typeof s !== 'string') { return JSON.stringify(s); }
  var out = '', i, c;
  for (i = 0; i < s.length; i++) {
    c = s.charCodeAt(i);
    if (invisible(c)) {
      out += '<U+' + ('0000' + c.toString(16).toUpperCase()).slice(-4) + '>';
    } else {
      out += s.charAt(i);
    }
  }
  return out;
}

function leafKind(v) {
  if (typeof v === 'string') { return 'value'; }
  if (v && typeof v === 'object') {
    if (v.unsupported) { return 'unsupported'; }
    if (v.threw) { return 'threw'; }
  }
  return null; /* interior node */
}

function envVal(v) {
  if (v && typeof v === 'object' && v.unavailable) { return '(' + v.unavailable + ')'; }
  return String(v);
}

function keysOf(o) {
  var ks = [], k;
  for (k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { ks.push(k); } }
  return ks;
}
function union(a, b) {
  var seen = {}, out = [], i, ka = keysOf(a || {}), kb = keysOf(b || {});
  for (i = 0; i < ka.length; i++) { if (!seen[ka[i]]) { seen[ka[i]] = 1; out.push(ka[i]); } }
  for (i = 0; i < kb.length; i++) { if (!seen[kb[i]]) { seen[kb[i]] = 1; out.push(kb[i]); } }
  out.sort();
  return out;
}

function envLine(s) {
  var e = s.env || {};
  var r = e.runtime || {};
  var v = e.versions || {};
  return (r.name || '?') + ' ' + envVal(r.version) + ' · icu ' + envVal(v.icu)
    + ' · cldr ' + envVal(v.cldr) + ' · ' + (e.icuVariant || '?') + '-icu';
}

/* Structured env summary for --json (design 4.5). */
function envSummary(s) {
  var e = s.env || {};
  var r = e.runtime || {};
  var v = e.versions || {};
  return {
    runtime: envVal(r.name || 'unknown') + ' ' + envVal(r.version),
    icu: envVal(v.icu), cldr: envVal(v.cldr),
    tz: envVal(v.tz), unicode: envVal(v.unicode),
    icuVariant: e.icuVariant || 'unknown'
  };
}

/* Compare two parsed snapshots, render a report, return a result object.
   opts: labelA, labelB, allowEnv, verbose, json, appLocales (array).
   Never calls process.exit — callers own the exit. */
function runDiff(snapA, snapB, opts) {
  opts = opts || {};
  var json = !!opts.json;
  var log = json ? function () {} : console.log;

  function matrixIdOf(s) {
    return { digest: s.matrix.digest, id: s.matrix.id, version: s.matrix.version };
  }
  /* Emit the §4.5 JSON document (canonical serialization, ASCII-safe). */
  function emitJson(status, extra) {
    if (!json) { return; }
    var doc = {
      baseline: envSummary(snapA),
      current: envSummary(snapB),
      schemaVersion: JSON_SCHEMA_VERSION,
      status: status
    };
    var k;
    for (k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) { doc[k] = extra[k]; }
    }
    process.stdout.write(canonSerialize(doc));
  }

  if (!snapA.results || !snapB.results || !snapA.matrix || !snapB.matrix) {
    if (json) {
      process.stdout.write(canonSerialize(
        { schemaVersion: JSON_SCHEMA_VERSION, status: 'error',
          error: 'not intl-drift snapshots' }));
    } else {
      console.error('not intl-drift snapshots');
    }
    return { code: 5, totalDrift: 0 };
  }

  log('');
  log('  baseline  ' + (opts.labelA || 'a') + '   ' + envLine(snapA));
  log('  current   ' + (opts.labelB || 'b') + '   ' + envLine(snapB));

  /* matrix identity (design 3.2) */
  if (snapA.matrix.digest !== snapB.matrix.digest) {
    log('');
    log('  MATRIX MISMATCH - comparison refused');
    log('  baseline matrix ' + snapA.matrix.id + '@' + snapA.matrix.version
      + ' digest ' + snapA.matrix.digest);
    log('  current  matrix ' + snapB.matrix.id + '@' + snapB.matrix.version
      + ' digest ' + snapB.matrix.digest);
    log('  (regenerate one side with the same tool version)');
    emitJson('matrix-mismatch',
      { matrix: { baseline: matrixIdOf(snapA), current: matrixIdOf(snapB) } });
    return { code: 4, totalDrift: 0, matrixMismatch: true };
  }
  log('  matrix    ' + snapA.matrix.id + '@' + snapA.matrix.version
    + ' · digest ' + snapA.matrix.digest);

  /* env deltas — the frame, never drift (design 4.1) */
  log('');
  log('  ENVIRONMENT');
  var va = (snapA.env && snapA.env.versions) || {};
  var vb = (snapB.env && snapB.env.versions) || {};
  ['icu', 'cldr', 'tz', 'unicode'].forEach(function (k) {
    var a = envVal(va[k]), b = envVal(vb[k]);
    log('    ' + k + '\t' + a + (a === b ? '' : '  ->  ' + b));
  });
  var variantA = (snapA.env && snapA.env.icuVariant) || 'unknown';
  var variantB = (snapB.env && snapB.env.icuVariant) || 'unknown';
  log('    icu build\t' + variantA + (variantA === variantB ? '' : '  ->  ' + variantB));

  /* env-mismatch refusal (design 4.3): full-vs-small is meaningless */
  if (variantA !== variantB && (variantA === 'small' || variantB === 'small')
      && !opts.allowEnv) {
    log('');
    log('  ENVIRONMENT MISMATCH - comparison refused');
    log('  One snapshot is ' + variantA + '-icu, the other ' + variantB + '-icu.');
    log('  A diff would report thousands of phantom changes that are missing');
    log('  data, not drift. Fix the environment, or override with');
    log('  --allow-env-mismatch.');
    emitJson('env-mismatch',
      { matrix: matrixIdOf(snapA) });
    return { code: 3, totalDrift: 0, envMismatch: true };
  }

  /* ----------------------- walk the results ----------------------------- */

  var drift = [];
  var resolution = [];
  var availability = {};
  var errorStatus = [];
  var collationLocales = [];
  var localesChanged = {};

  function record(locale, api, path, a, b) {
    var ka = leafKind(a), kb = leafKind(b);
    if (ka === 'unsupported' && kb === 'unsupported'
        && a.unsupported === b.unsupported) {
      return; /* absent on both sides — not a change */
    }
    if (ka === 'unsupported' || kb === 'unsupported'
        || typeof a === 'undefined' || typeof b === 'undefined') {
      availability[api] = (availability[api] || 0) + 1;
      return;
    }
    /* A leaf facing an interior subtree (e.g. a threw-marker replacing a
       populated group): render the subtree as a placeholder, never raw JSON. */
    function shortVal(v) {
      return (leafKind(v) === null && v !== null && typeof v === 'object')
        ? '[subtree]' : v;
    }
    if (ka === 'threw' || kb === 'threw') {
      if (ka === 'threw' && kb === 'threw' && a.threw === b.threw) { return; }
      errorStatus.push({ locale: locale, api: api, path: path,
        a: shortVal(a), b: shortVal(b) });
      localesChanged[locale] = 1;
      return;
    }
    if (a === b) { return; }
    localesChanged[locale] = 1;
    if (api === 'collator') {
      /* amendment 4: never print the permutation */
      if (collationLocales.indexOf(locale) === -1) { collationLocales.push(locale); }
      return;
    }
    if (api === 'resolvedOptions') {
      resolution.push({ locale: locale, path: path, a: a, b: b });
      return;
    }
    drift.push({ locale: locale, api: api, path: path,
      a: shortVal(a), b: shortVal(b) });
  }

  function walk(locale, api, a, b, path) {
    var ka = leafKind(a), kb = leafKind(b);
    if (ka !== null || kb !== null
        || typeof a === 'undefined' || typeof b === 'undefined') {
      record(locale, api, path, a, b);
      return;
    }
    var keys = union(a, b), i;
    for (i = 0; i < keys.length; i++) {
      walk(locale, api, a[keys[i]], b[keys[i]], path ? path + '.' + keys[i] : keys[i]);
    }
  }

  var locales = union(snapA.results, snapB.results);
  locales.forEach(function (locale) {
    var ra = snapA.results[locale] || {};
    var rb = snapB.results[locale] || {};
    union(ra, rb).forEach(function (api) {
      walk(locale, api, ra[api], rb[api], '');
    });
  });

  /* ------------- uniform-transformation collapse (design 4.2) ----------- */
  /* Computed once, consumed by both renderers. */

  var byApi = {};
  drift.forEach(function (d) {
    if (!byApi[d.api]) { byApi[d.api] = []; }
    byApi[d.api].push(d);
  });

  var groups = [];       /* {id, api, rule, entries[], locales[]} */
  var looseByApi = {};   /* api -> entries not in any collapsed group */
  var groupSeq = 0;
  keysOf(byApi).sort().forEach(function (api) {
    var buckets = {}, loose = [];
    byApi[api].forEach(function (d) {
      var rule = deriveRule(d.a, d.b);
      if (rule === null) { loose.push(d); return; }
      if (!buckets[rule]) { buckets[rule] = []; }
      buckets[rule].push(d);
    });
    keysOf(buckets).sort().forEach(function (rule) {
      if (buckets[rule].length < MIN_COLLAPSE) {
        loose = loose.concat(buckets[rule]);
        return;
      }
      var locs = [];
      buckets[rule].forEach(function (d) {
        if (locs.indexOf(d.locale) === -1) { locs.push(d.locale); }
        d.group = 'g' + (groupSeq + 1); /* provisional; set below */
      });
      groupSeq++;
      var gid = 'g' + groupSeq;
      buckets[rule].forEach(function (d) { d.group = gid; });
      groups.push({ id: gid, api: api, rule: rule,
        entries: buckets[rule], locales: locs.sort() });
    });
    loose.sort(function (x, y) {
      var k1 = x.locale + ' ' + x.path, k2 = y.locale + ' ' + y.path;
      return k1 < k2 ? -1 : k1 > k2 ? 1 : 0;
    });
    looseByApi[api] = loose;
  });

  /* ----------------------------- totals ---------------------------------- */

  var totalDrift = drift.length + resolution.length + errorStatus.length
    + (collationLocales.length ? 1 : 0);
  var changedCount = keysOf(localesChanged).length;
  var verbose = !!opts.verbose;

  /* Coverage vs app locales (C1/C2). Case-insensitive exact match — de-AT is
     NOT covered by de-DE being probed; that is the point of the warning. */
  var appLocales = opts.appLocales || null;
  var uncovered = [];
  if (appLocales) {
    var probedLower = {};
    locales.forEach(function (l) { probedLower[l.toLowerCase()] = 1; });
    appLocales.forEach(function (l) {
      if (!probedLower[l.toLowerCase()]) { uncovered.push(l); }
    });
  }

  /* ------------------------- human rendering ------------------------------ */

  log('');
  if (totalDrift === 0) {
    log('  no drift in ' + locales.length + ' locales ('
      + snapA.matrix.id + '@' + snapA.matrix.version + ')');
  } else {
    log('  DRIFT    ' + totalDrift + ' changes in '
      + changedCount + ' of ' + locales.length + ' locales');
  }

  if (resolution.length) {
    log('');
    log('  Resolution (resolvedOptions) ........... ' + resolution.length + ' changes');
    (verbose ? resolution : resolution.slice(0, CAP)).forEach(function (d) {
      log('    ' + d.locale + '  ' + d.path);
      log('      - ' + disp(d.a));
      log('      + ' + disp(d.b));
    });
    if (!verbose && resolution.length > CAP) {
      log('    ... ' + (resolution.length - CAP) + ' more   (--verbose)');
    }
  }

  keysOf(byApi).sort().forEach(function (api) {
    log('');
    log('  ' + api + ' ' + new Array(Math.max(2, 40 - api.length)).join('.')
      + ' ' + byApi[api].length + ' changes');
    groups.forEach(function (g) {
      if (g.api !== api) { return; }
      log('    * uniform substitution: ' + g.rule);
      log('      ' + g.entries.length + ' entries · ' + g.locales.join(' '));
      (verbose ? g.entries : g.entries.slice(0, 2)).forEach(function (d) {
        log('        ' + d.locale + '  ' + d.path);
        log('          - ' + disp(d.a));
        log('          + ' + disp(d.b));
      });
      if (!verbose && g.entries.length > 2) {
        log('        ... ' + (g.entries.length - 2) + ' more   (--verbose)');
      }
    });
    var loose = looseByApi[api] || [];
    (verbose ? loose : loose.slice(0, CAP)).forEach(function (d) {
      log('    ' + d.locale + '  ' + d.path);
      log('      - ' + disp(d.a));
      log('      + ' + disp(d.b));
    });
    if (!verbose && loose.length > CAP) {
      log('    ... ' + (loose.length - CAP) + ' more   (--verbose)');
    }
  });

  if (collationLocales.length) {
    log('');
    log('  Collator ............................... 1 change');
    log('    collation order changed in ' + collationLocales.length
      + ' locale' + (collationLocales.length === 1 ? '' : 's')
      + (collationLocales.length === locales.length ? '  (root collation)' : ''));
  }

  if (errorStatus.length) {
    log('');
    log('  Error-status changes ................... ' + errorStatus.length);
    (verbose ? errorStatus : errorStatus.slice(0, CAP)).forEach(function (d) {
      log('    ' + d.locale + '  ' + d.api + '.' + d.path
        + '  ' + disp(d.a) + '  ->  ' + disp(d.b));
    });
  }

  var availApis = keysOf(availability).sort();
  if (availApis.length) {
    log('');
    log('  Availability (never enumerated)');
    availApis.forEach(function (api) {
      log('    ' + api + '\t' + availability[api] + ' entries');
    });
  }

  /* coverage footer — requirement C1: always printed */
  log('');
  if (appLocales) {
    log('  COVERAGE  ' + locales.length + ' locales probed ('
      + snapA.matrix.id + '@' + snapA.matrix.version + '). Your app lists '
      + appLocales.length + ' locale' + (appLocales.length === 1 ? '' : 's') + '.');
    if (uncovered.length) {
      log('    NOT covered by this matrix: ' + uncovered.join(' '));
      log('    -> drift in these locales is invisible to this check.');
    } else {
      log('    All app locales are covered.');
    }
  } else {
    log('  COVERAGE  ' + locales.length + ' locales probed ('
      + snapA.matrix.id + '@' + snapA.matrix.version + '). No app locale list supplied.');
  }
  log('');

  /* -------------------------- JSON rendering ------------------------------ */

  if (json) {
    var changes = [];
    resolution.forEach(function (d) {
      changes.push({ after: d.b, api: 'resolvedOptions', before: d.a,
        group: null, kind: 'resolution', locale: d.locale, path: d.path });
    });
    drift.forEach(function (d) {
      changes.push({ after: d.b, api: d.api, before: d.a,
        group: d.group || null, kind: 'output', locale: d.locale, path: d.path });
    });
    errorStatus.forEach(function (d) {
      changes.push({ after: d.b, api: d.api, before: d.a,
        group: null, kind: 'error-status', locale: d.locale, path: d.path });
    });
    changes.sort(function (x, y) {
      var k1 = x.locale + '|' + x.api + '|' + x.path + '|' + x.kind;
      var k2 = y.locale + '|' + y.api + '|' + y.path + '|' + y.kind;
      return k1 < k2 ? -1 : k1 > k2 ? 1 : 0;
    });

    var byApiCount = {}, byLocaleCount = {};
    keysOf(byApi).forEach(function (api) { byApiCount[api] = byApi[api].length; });
    changes.forEach(function (c) {
      byLocaleCount[c.locale] = (byLocaleCount[c.locale] || 0) + 1;
    });

    emitJson(totalDrift === 0 ? 'clean' : 'drift', {
      changes: changes,
      coverage: appLocales
        ? { appLocales: appLocales.slice().sort(), probed: locales.length,
            uncovered: uncovered.slice().sort() }
        : { probed: locales.length },
      groups: groups.map(function (g) {
        return { api: g.api, entries: g.entries.length, id: g.id,
          locales: g.locales, rule: g.rule };
      }),
      matrix: matrixIdOf(snapA),
      summary: {
        availability: availability,
        byApi: byApiCount,
        byCategory: {
          collation: collationLocales.length ? 1 : 0,
          errorStatus: errorStatus.length,
          output: drift.length,
          resolution: resolution.length
        },
        byLocale: byLocaleCount,
        collationLocales: collationLocales.slice().sort(),
        localesChanged: changedCount,
        localesProbed: locales.length,
        total: totalDrift
      }
    });
  }

  return {
    code: totalDrift === 0 ? 0 : 1,
    totalDrift: totalDrift,
    localesChanged: changedCount,
    localesProbed: locales.length,
    uncovered: uncovered
  };
}

module.exports = { runDiff: runDiff, disp: disp, envLine: envLine,
  deriveRule: deriveRule };

/* ------------------------------- CLI ------------------------------------- */

if (require.main === module) {
  var args = process.argv.slice(2);
  var files = [], allowEnv = false, verbose = false, jsonMode = false;
  var appLocales = null, i;
  for (i = 0; i < args.length; i++) {
    if (args[i] === '--allow-env-mismatch') { allowEnv = true; }
    else if (args[i] === '--verbose') { verbose = true; }
    else if (args[i] === '--json') { jsonMode = true; }
    else if (args[i] === '--locales') {
      var val = args[++i];
      if (typeof val === 'undefined' || val.indexOf('--') === 0) {
        console.error('--locales requires a comma-separated list');
        process.exit(64);
      }
      appLocales = val.split(',').map(function (x) { return x.trim(); })
        .filter(function (x) { return x.length; });
    }
    else if (args[i].indexOf('--') === 0) {
      console.error('unknown flag: ' + args[i]);
      process.exit(64);
    }
    else { files.push(args[i]); }
  }
  if (files.length !== 2) {
    console.error('usage: node diff.cjs <baseline.json> <current.json>'
      + ' [--allow-env-mismatch] [--verbose] [--json] [--locales a,b]');
    process.exit(64);
  }
  var snapA, snapB;
  try { snapA = JSON.parse(fs.readFileSync(files[0], 'utf8')); }
  catch (e) {
    console.error('cannot read baseline ' + files[0] + ': ' + e.message);
    process.exit(2);
  }
  try { snapB = JSON.parse(fs.readFileSync(files[1], 'utf8')); }
  catch (e2) {
    console.error('cannot read current ' + files[1] + ': ' + e2.message);
    process.exit(2);
  }
  var r = runDiff(snapA, snapB,
    { labelA: files[0], labelB: files[1], allowEnv: allowEnv,
      verbose: verbose, json: jsonMode, appLocales: appLocales });
  /* Never process.exit() after large stdout writes: on Linux, writes past
     the 64KB pipe buffer are async and exit() discards the unflushed tail
     (this bit us as Windows-pass/Linux-flake in CI). exitCode + natural
     exit flushes everything. */
  process.exitCode = r.code;
}
