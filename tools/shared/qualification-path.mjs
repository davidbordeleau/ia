import assert from 'node:assert/strict';
import { resolve } from 'node:path';

/** The producer owns this stable pointer; each cohort below it remains an immutable artifact set.
 * @param {string} root
 */
export function qualificationPath(root, run = process.env['IA_TEST_ORCHESTRATION']) {
  if (run !== undefined) assert(/^[a-f0-9-]{36}$/.test(run), 'Invalid qualification run');
  return resolve(root, 'artifacts/qualification/packed', process.platform, ...(run ? [run] : []), 'qualification.json');
}
