/* intl-drift — programmatic API.
 *
 *   const intlDrift = require('intl-drift');
 *   const snap = intlDrift.probe();                    // snapshot object
 *   const text = intlDrift.serialize(snap);            // canonical JSON text
 *   const res  = intlDrift.diff(snapA, snapB, opts);   // prints report,
 *                                                      // returns {code, ...}
 *
 * The CLI (`npx intl-drift`) lives in intl-drift.cjs; the zero-dependency
 * probe that also runs on Node 7+ and in browsers lives in probe.cjs.
 */
'use strict';

var probeMod = require('./probe.cjs');
var diffMod = require('./diff.cjs');

module.exports = {
  probe: probeMod.run,
  serialize: probeMod.serialize,
  diff: diffMod.runDiff,
  disp: diffMod.disp,
  deriveRule: diffMod.deriveRule,
  version: probeMod.toolVersion
};
