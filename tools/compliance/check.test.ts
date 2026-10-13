import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { checkCompliance, readFixtures } from './check.js';
import { checkInventory } from './inventory.js';
import { EVIDENCE_CODES, fixtureCoverage } from '../../packages/compliance/src/index.js';
import { KERNEL_DIGEST, LANGUAGE_VERSION } from '../../packages/language/src/index.js';
import { load } from '../../packages/graph/src/index.js';
import { inputs, records, registry } from '../../packages/compliance/tests/native.js';
import { runEvidenceFixtures } from './evidence-fixtures.js';

const root = resolve(import.meta.dirname, '../..');
it('discovers the actual conformance tree without stray entries', () => {
  const listing = readFixtures(root);
  expect(listing.strays).toEqual([]);
  expect(listing.fixtures).toHaveLength(179);
});
it('executes native graph, all language fixtures, all refusal-code boundaries and kernel generation', () => {
  const { report, fixtures, boundaries, qualification } = checkCompliance(root);
  expect(fixtures).toBe(179);
  // IA-COMP-PROJECTION-INVALID retired with the projection renderers (milestone position-packet task replace-renderers);
  // the mandate resolver adds the default-actor and two profile refusals (milestone generation-binding task
  // mandate-resolution), the `@mandate` guard its three hook refusals (task generation-hook-governance), and lane D a
  // second IA-COMP-FIELD-VALUE boundary, the stated empty `authority.moves` admission refuses.
  expect(boundaries).toBe(120);
  expect(qualification).toEqual({
    platform: process.platform,
    deferredPlatformCodes:
      process.platform === 'win32' ? [] : ['IA-EXEC-OUTPUT-EXISTS', 'IA-PUBLICATION-BUSY', 'IA-PUBLICATION-CONFLICT'],
    reason:
      process.platform === 'win32'
        ? null
        : 'Managed draft publication is qualified only on local Windows NTFS; unsupported hosts verify refusal without effects.',
  });
  expect(report.verdicts.filter((v) => v.outcome === 'fail')).toEqual([]);
  expect(report.outcome).toBe('pass');
  expect(report.verdicts.filter((v) => v.outcome === 'not-evaluated')).toEqual([]);
  expect(report.verdicts.find((v) => v.check === 'COMP-ADOPTION')!.outcome).toBe('pass');
  expect(report.verdicts.find((v) => v.check === 'COMP-FIXTURES')!.outcome).toBe('pass');
  expect(report.verdicts.find((v) => v.check === 'COMP-KERNEL')!.outcome).toBe('pass');
});

it('requires a successful producer observation for every evaluator evidence code', () => {
  const graph = load(records, registry, {
    sources: inputs,
    languageVersion: LANGUAGE_VERSION,
    kernelDigest: KERNEL_DIGEST,
    location: '',
  });
  const observations = runEvidenceFixtures(graph);
  expect(observations).toHaveLength(EVIDENCE_CODES.length);
  expect(observations.flatMap((row) => row.assessment.findings)).toEqual([]);
  expect(fixtureCoverage(EVIDENCE_CODES, observations).outcome).toBe('pass');
  for (const code of EVIDENCE_CODES) {
    const missing = observations.filter((row) => !row.observedCodes.includes(code));
    expect(fixtureCoverage(EVIDENCE_CODES, missing).findings).toContainEqual(
      expect.objectContaining({ message: 'No passing failing-case observation covers ' + code }),
    );
    const failed = observations.map((row) =>
      row.observedCodes.includes(code) ? { ...row, assessment: { ...row.assessment, outcome: 'fail' as const } } : row,
    );
    expect(fixtureCoverage(EVIDENCE_CODES, failed).outcome, code).toBe('fail');
  }
});

it('fails the inventory gate after any fixture, companion or corpus edit until it is regenerated', () => {
  const temp = mkdtempSync(join(tmpdir(), 'ia-inventory-'));
  try {
    for (const path of [
      'packages/compliance/fixtures/language',
      'examples/conformance/native',
      'examples/public-language/manifest.json',
      'packages/compliance/src/conformance/inventory.generated.ts',
    ])
      cpSync(resolve(root, path), join(temp, path), { recursive: true });
    const first = checkInventory(temp);
    expect(first.digest).toBe(checkInventory(root).digest);
    expect(first.fixtures).toBe(179);
    const digests = new Set([first.digest]);
    for (const path of [
      'packages/compliance/fixtures/language/identity/fail/facet-undeclared.ia',
      'packages/compliance/fixtures/language/format/fail/lost-comment.candidate.txt',
      'examples/conformance/native/systems/agent-system/system.ia',
    ]) {
      appendFileSync(join(temp, path), '\n');
      expect(() => checkInventory(temp), path).toThrow('Inventory drift');
      digests.add(checkInventory(temp, true).digest);
      expect(checkInventory(temp).digest).toBe([...digests].at(-1));
    }
    expect(digests.size).toBe(4);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
