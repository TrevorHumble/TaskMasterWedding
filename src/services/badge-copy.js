// src/services/badge-copy.js
// The single composer of an auto badge's synced `description` string (issue
// #1094 plan step 4): "Completed N tasks." with the singular "task" at N=1
// (a legal threshold — an admin can set a milestone at 1 task). Pure and
// zero-require by design — both writers that need this exact text
// (src/services/scoring/badge-engine.js's setAutoBadgeThresholds, the admin
// save path, and scripts/badge-catalog.js's ensureBadgeCatalog, the boot
// re-sync path) import this ONE function rather than each formatting their
// own copy of the same string, so the two can never diverge on plural vs
// singular wording (AC6).
'use strict';

/**
 * @param {number} n - the badge's threshold (completed-task count).
 * @returns {string} e.g. "Completed 5 tasks." or "Completed 1 task."
 */
function autoBadgeDescription(n) {
  return `Completed ${n} task${n === 1 ? '' : 's'}.`;
}

module.exports = { autoBadgeDescription };
