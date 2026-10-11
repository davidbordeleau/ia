// D14 and D15 (milestone generation-binding; plan amendments C14, C15, C21 and C22): every `@check` bound at validate
// against the verdicts its scope selects or the host's evaluator catalog, and the runtime evidence a validate effect
// records for the bound checks that passed or failed. Binding and discovery only read; `writeEvidence` is the writer.
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { Verdict } from '@inventarch/compliance';
import {
  bindChecks,
  checkVerdicts,
  EVIDENCE_DIRECTORY,
  evidenceText,
  open,
  readEvidence,
  WHOLE_WORKSPACE_SCOPE,
  writeEvidence,
} from '../src/index.js';
import type { CheckCatalog, Handle } from '../src/index.js';
import { methodId, put, workspace } from './workspace.js';

const CHECKS = '.ia/src/systems/compliance-system/checks/bound-checks.ia';
/** A `@check` in the native compliance system naming `runner` with the text scope `scope`. */
const check = (name: string, runner: string, scope: string) => `@check ${name}
  meaning
    says "Bind ${name} for the test."
    answers "What does ${name} select?"
  check
    runs ${runner}
    scope "${scope}"
  governance
    severity blocking
  relationships
    enforces @contract foundation-authoring-contract
`;
const fixture = (root: string, ...checks: string[]) => put(root, CHECKS, `#! ia 1.0\n\n${checks.join('\n')}`);
const NONE: CheckCatalog = { status: 'unavailable', reason: 'no host has joined a catalog' };
const structural = (root: string, evidence = false): Handle =>
  open(root, { cache: false, checks: 'structural', ...(evidence ? { evidence: true } : {}) });
const using = <T>(db: Handle, read: (db: Handle) => T): T => {
  try {
    return read(db);
  } finally {
    db.close();
  }
};
const byName = (db: Handle, catalog: CheckCatalog = NONE) =>
  Object.fromEntries(bindChecks(db.records(), db.report, catalog).map((binding) => [binding.name, binding]));
const code = (value: string) => expect.objectContaining({ code: value });
const sha = (c: string) => `sha256:${c.repeat(64)}`;
const entry = (id: string, availability: Record<string, string>, digest = 'a') => ({
  id,
  contractVersion: '1.0.0',
  implementationVersion: '2.1.0',
  implementationDigest: sha(digest),
  inputSchemaId: 'acme-typing-input@1',
  outputSchemaId: 'acme-typing-result@1',
  supportedScopes: ['package'],
  effects: ['read'],
  environmentProfile: { id: 'node-22-offline', credentials: 'none' },
  limits: { timeoutMs: 60000, memoryBytes: 536870912, outputBytes: 4096, concurrency: 2 },
  evidencePolicy: { kind: 'fresh-run' },
  availability,
});

it('aggregates the verdicts a scope selects: fail, then not-evaluated, then pass; nothing selected is not-evaluated (C22)', () => {
  const verdict = (scope: string, outcome: Verdict['outcome'], check = 'COMP-X'): Verdict =>
    ({ check, scope, outcome, findings: [], revision: 'r' }) as Verdict;
  const all = [
    verdict('a', 'pass'),
    verdict('b', 'not-evaluated'),
    verdict('c', 'fail'),
    verdict('a', 'fail', 'COMP-Y'),
  ];
  expect(checkVerdicts(all, 'COMP-X', WHOLE_WORKSPACE_SCOPE).outcome).toBe('fail');
  expect(checkVerdicts(all.slice(0, 2), 'COMP-X', '*').outcome).toBe('not-evaluated');
  expect(checkVerdicts([verdict('a', 'pass'), verdict('d', 'pass')], 'COMP-X', '*')).toMatchObject({ outcome: 'pass' });
  // Exact scope identity only: another runner's verdict on the same scope is never selected.
  expect(checkVerdicts(all, 'COMP-X', 'a')).toMatchObject({ outcome: 'pass', selected: [all[0]] });
  expect(checkVerdicts(all, 'COMP-X', 'c').outcome).toBe('fail');
  // Prose, an unknown scope, no scope, and an evaluator that reported nothing: an empty selection, never a pass.
  for (const scope of ['every admitted native record', 'A', 'workspace', '', null])
    expect(checkVerdicts(all, 'COMP-X', scope)).toEqual({ outcome: 'not-evaluated', selected: [] });
  expect(checkVerdicts(all, 'COMP-Z', '*')).toEqual({ outcome: 'not-evaluated', selected: [] });
  // A verdict about an excluded record (the runtime evidence) is never selected.
  expect(checkVerdicts(all, 'COMP-X', '*', new Set(['c'])).outcome).toBe('not-evaluated');
});

it('binds a built-in check to the admission verdicts its scope selects, and a prose scope to not-evaluated (C15, C22)', () => {
  const root = workspace();
  fixture(
    root,
    check('whole-schema-check', 'COMP-SCHEMA', WHOLE_WORKSPACE_SCOPE),
    check('method-schema-check', 'COMP-SCHEMA', methodId),
    check('unknown-scope-check', 'COMP-SCHEMA', 'no-such-scope'),
  );
  using(structural(root), (db) => {
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    const bound = byName(db),
      schema = db.report.verdicts.filter((verdict) => verdict.check === 'COMP-SCHEMA');
    expect(bound['whole-schema-check']).toMatchObject({
      runner: 'COMP-SCHEMA',
      scope: '*',
      status: 'bound',
      implementation: 'built-in',
      outcome: 'pass',
      selected: schema.length,
    });
    expect(schema.length).toBeGreaterThan(1);
    expect(bound['method-schema-check']).toMatchObject({ status: 'bound', outcome: 'pass', selected: 1 });
    // The native check's prose scope selects nothing: bound, but not-evaluated, and never a pass.
    expect(bound['instance-schema-check']).toMatchObject({
      status: 'bound',
      outcome: 'not-evaluated',
      selected: 0,
      reason: expect.stringContaining('check.scope "every admitted native record" selects no COMP-SCHEMA verdict'),
    });
    expect(bound['unknown-scope-check']).toMatchObject({ outcome: 'not-evaluated', selected: 0 });
  });
});

it('admits an unknown evaluator only structurally, and binds it unavailable, revoked or supported-but-not-run (C15, C21)', () => {
  const root = workspace();
  fixture(root, check('typing-check', 'acme-strict-typing', 'package'), check('lint-check', 'acme-lint', 'package'));
  // Strict admission, every existing reader's default, still refuses the record.
  using(open(root, { cache: false }), (db) => {
    expect(db.records().some((record) => record.name === 'typing-check')).toBe(false);
    expect(db.report.findings.map((finding) => finding.code)).toContain('IA-COMP-CHECK-UNKNOWN');
  });
  using(structural(root), (db) => {
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    // No catalog: unavailable, not-evaluated, with the reason the catalog source gives.
    expect(byName(db)['typing-check']).toMatchObject({
      status: 'unavailable',
      implementation: null,
      outcome: 'not-evaluated',
      reason: 'no host has joined a catalog',
    });
    // A catalog that failed verification revokes every catalog check, never a built-in one.
    const damaged = byName(db, { status: 'damaged', reason: 'IA-DIST-INTEGRITY-MISMATCH: Host payload changed' });
    expect(damaged['typing-check']).toMatchObject({ status: 'revoked', outcome: 'not-evaluated' });
    expect(damaged['instance-schema-check']).toMatchObject({ status: 'bound', implementation: 'built-in' });
    const present = (...entries: unknown[]): CheckCatalog => ({
      status: 'present',
      evaluators: { format: 'ia-evaluator-catalog/1.0', entries },
    });
    // The 2.0.0-era empty catalog lists nothing.
    expect(byName(db, present())['typing-check']).toMatchObject({
      status: 'unavailable',
      reason: 'the installed evaluator catalog lists no evaluator acme-strict-typing',
    });
    const listed = byName(
      db,
      present(
        entry('acme-strict-typing', { status: 'supported' }),
        entry('acme-lint', { status: 'revoked', reason: 'Superseded after advisory 7' }, 'b'),
      ),
    );
    // Supported, but no host implementation runs it in this release: bound, never invoked, so not-evaluated.
    expect(listed['typing-check']).toMatchObject({
      status: 'bound',
      implementation: 'acme-strict-typing@2.1.0',
      outcome: 'not-evaluated',
      reason: 'acme-strict-typing@2.1.0 is supported, but no host implementation ran it, so nothing was evaluated',
    });
    expect(listed['lint-check']).toMatchObject({
      status: 'revoked',
      reason: 'the installed evaluator catalog revokes acme-lint@2.1.0: Superseded after advisory 7',
    });
    const unavailable = byName(db, present(entry('acme-lint', { status: 'unavailable', reason: 'Not installed' })));
    expect(unavailable['lint-check']).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('Not installed'),
    });
    // A catalog compliance does not accept is unavailable, not revoked: it vouches for nothing.
    expect(byName(db, present({ id: 'acme-strict-typing' }))['typing-check']).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining('the installed evaluator catalog is not valid'),
    });
  });
});

/** The admitted root view's authored revision and the evidence file path for it. */
const evidencePath = (db: Handle) => `${EVIDENCE_DIRECTORY}/${db.authoredRevision}.ia`;
/** Binds and writes evidence as the validate request does; returns what was written. */
function validateOnce(root: string, now = new Date('2026-10-11T12:00:00.000Z')) {
  return using(structural(root, true), (db) => {
    const bindings = bindChecks(db.records(), db.report, NONE),
      built = evidenceText({
        authoredRevision: db.authoredRevision,
        bindings,
        records: db.records(),
        prior: readEvidence(root, evidencePath(db)),
        now,
      });
    return { ...writeEvidence(root, db.authoredRevision, built.text), observations: built.observations };
  });
}

it('records a passing built-in check as an admitted runtime observation without moving the authored revision (C14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const before = using(structural(root), (db) => ({ authored: db.authoredRevision, revision: db.revision }));
  const first = validateOnce(root);
  expect(first).toEqual({
    path: `${EVIDENCE_DIRECTORY}/${before.authored}.ia`,
    written: true,
    pruned: [],
    observations: [
      {
        name: `whole-schema-check-${before.authored.slice(0, 12)}`,
        check: 'compliance-system/check/gate/whole-schema-check',
        verdict: 'success',
      },
    ],
  });
  // Read with evidence: the observation is admitted at runtime placement, and the authored revision is unchanged.
  using(structural(root, true), (db) => {
    const observation = db.records().find((record) => record.name === first.observations[0]!.name)!;
    expect(observation).toMatchObject({ discriminator: 'observation', band: 0 });
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(db.authoredRevision).toBe(before.authored);
    expect(db.revision).not.toBe(before.revision);
    // Its own verdicts never feed a check: the binding does not move once evidence exists.
    expect(byName(db)['whole-schema-check']).toMatchObject({ outcome: 'pass' });
  });
  // Every existing reader, which reads no evidence, sees exactly what it saw.
  using(open(root, { cache: false }), (db) => {
    expect(db.records().some((record) => record.discriminator === 'observation' && record.band === 0)).toBe(false);
    expect(db.revision).toBe(before.revision);
  });
  // A second validate at the same authored revision writes nothing: same observations, same times, same bytes.
  const bytes = readFileSync(resolve(root, first.path!));
  expect(validateOnce(root, new Date('2026-10-12T00:00:00.000Z'))).toMatchObject({ written: false, pruned: [] });
  expect(readFileSync(resolve(root, first.path!))).toEqual(bytes);
  expect(using(structural(root), (db) => db.authoredRevision)).toBe(before.authored);
});

it('records nothing for an unbound, unavailable or not-evaluated check, and keeps no file then (C14, C22)', () => {
  const root = workspace();
  fixture(root, check('typing-check', 'acme-strict-typing', 'package'), check('prose-check', 'COMP-SCHEMA', 'prose'));
  expect(validateOnce(root)).toEqual({ path: null, written: false, pruned: [], observations: [] });
  expect(existsSync(resolve(root, EVIDENCE_DIRECTORY))).toBe(false);
});

it('discovers only the current authored revision’s file, and the writer prunes the others and nothing else (C14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const older = `${EVIDENCE_DIRECTORY}/${'0'.repeat(64)}.ia`,
    notes = `${EVIDENCE_DIRECTORY}/notes.txt`,
    first = validateOnce(root);
  // An older revision's file, even one that would admit, is never read as evidence.
  put(root, older, readFileSync(resolve(root, first.path!), 'utf8').replaceAll('whole-schema-check-', 'older-check-'));
  put(root, notes, 'not evidence\n');
  using(structural(root, true), (db) =>
    expect(db.records().filter((record) => record.discriminator === 'observation' && record.band === 0)).toHaveLength(
      1,
    ),
  );
  // An authored change moves the revision: the old file is not this revision's, so nothing is admitted from it.
  put(
    root,
    '.ia/src/systems/compliance-system/checks/another.ia',
    `#! ia 1.0\n\n${check('another-check', 'COMP-SCHEMA', 'prose')}`,
  );
  using(structural(root, true), (db) => {
    expect(db.records().some((record) => record.discriminator === 'observation' && record.band === 0)).toBe(false);
  });
  const second = validateOnce(root);
  expect(second.written).toBe(true);
  expect(second.pruned).toEqual([older, first.path].sort());
  expect(readdirSync(resolve(root, EVIDENCE_DIRECTORY)).sort()).toEqual(
    [second.path!.split('/').at(-1), 'notes.txt'].sort(),
  );
});

it('ignores evidence that would collide with an authored observation or add a finding of its own (C14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const first = validateOnce(root),
    name = first.observations[0]!.name,
    evidence = readFileSync(resolve(root, first.path!), 'utf8');
  // An authored observation that holds the evidence's name: the authored record keeps it, and the evidence file is not
  // read at the authored revision it now has; the writer records nothing under that name either.
  const authoredPath = '.ia/src/systems/learning-system/records/held.ia';
  put(root, authoredPath, evidence.replace(name, 'held-observation'));
  const held = using(structural(root), (db) => db.authoredRevision);
  put(root, `${EVIDENCE_DIRECTORY}/${held}.ia`, evidence.replaceAll(name, 'held-observation'));
  using(structural(root, true), (db) => {
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    const observations = db.records().filter((record) => record.name === 'held-observation');
    expect(observations.map((record) => record.band)).toEqual([100]);
    expect(db.authoredRevision).toBe(held);
  });
  expect(readFileSync(resolve(root, authoredPath), 'utf8')).toBe(evidence.replace(name, 'held-observation'));
  // Evidence whose observation the schema refuses is not admitted either, and adds no finding.
  rmSync(resolve(root, authoredPath));
  const revision = using(structural(root), (db) => db.authoredRevision);
  put(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`, evidence.replace('verdict success', 'verdict banana'));
  using(structural(root, true), (db) => {
    expect(db.report.findings.filter((finding) => finding.path.startsWith(EVIDENCE_DIRECTORY))).toEqual([]);
    expect(db.records().some((record) => record.band === 0 && record.discriminator === 'observation')).toBe(false);
  });
  // Any other record kind in the evidence file (a requirement-bearing contract, a schema) is never evidence.
  put(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`, `${evidence}\n@schema planted\n`);
  using(structural(root, true), (db) =>
    expect(db.records().some((record) => record.band === 0 && record.discriminator === 'observation')).toBe(false),
  );
});

it('never reads or writes evidence through a link or junction or at an entry of the wrong kind (C14)', () => {
  const root = workspace(),
    elsewhere = workspace(false);
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const revision = using(structural(root), (db) => db.authoredRevision);
  const noEvidence = () =>
    using(structural(root, true), (db) =>
      expect(db.records().some((record) => record.band === 0 && record.discriminator === 'observation')).toBe(false),
    );
  // The evidence directory as a junction to a directory outside the workspace. Read: nothing behind it is evidence,
  // and the workspace still opens. Write: a passing check refuses, and with nothing to record nothing is pruned
  // through it either.
  mkdirSync(resolve(root, '.ia/work'), { recursive: true });
  symlinkSync(elsewhere, resolve(root, EVIDENCE_DIRECTORY), 'junction');
  const planted = `${'1'.repeat(64)}.ia`;
  put(elsewhere, planted, '#! ia 1.0\n');
  noEvidence();
  expect(() => validateOnce(root)).toThrow(code('IA-DB-PATH-UNSAFE'));
  expect(() => writeEvidence(root, revision, '#! ia 1.0\n')).toThrow(code('IA-DB-PATH-UNSAFE'));
  expect(writeEvidence(root, revision, null)).toEqual({ path: null, written: false, pruned: [] });
  expect(readdirSync(elsewhere)).toEqual([planted]);
  rmSync(resolve(root, EVIDENCE_DIRECTORY));
  // The evidence directory as a file, and the evidence file as a directory or a hard link.
  put(root, EVIDENCE_DIRECTORY, 'not a directory');
  expect(() => writeEvidence(root, revision, '#! ia 1.0\n')).toThrow(code('IA-DB-PATH-UNSAFE'));
  expect(writeEvidence(root, revision, null)).toEqual({ path: null, written: false, pruned: [] });
  noEvidence();
  rmSync(resolve(root, EVIDENCE_DIRECTORY));
  mkdirSync(resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`), { recursive: true });
  expect(() => writeEvidence(root, revision, '#! ia 1.0\n')).toThrow(code('IA-DB-PATH-UNSAFE'));
  rmSync(resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`), { recursive: true });
  put(elsewhere, 'outside.ia', '#! ia 1.0\n');
  linkSync(resolve(elsewhere, 'outside.ia'), resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`));
  // A hard-linked evidence file is never read as evidence, and the writer replaces the entry rather than writing
  // through it, so the file outside never changes.
  noEvidence();
  expect(writeEvidence(root, revision, '#! ia 1.0\n\n')).toMatchObject({ written: true });
  expect(readFileSync(resolve(elsewhere, 'outside.ia'), 'utf8')).toBe('#! ia 1.0\n');
  expect(statSync(resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`)).nlink).toBe(1);
});

it('fails cleanly where the evidence cannot be written, leaving what it found and no staged file (C14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const first = validateOnce(root),
    target = resolve(root, first.path!),
    directory = resolve(root, EVIDENCE_DIRECTORY),
    before = readFileSync(target);
  // Windows refuses to replace a read-only file; elsewhere a read-only directory refuses the staged file.
  const lock = process.platform === 'win32' ? target : directory;
  chmodSync(lock, process.platform === 'win32' ? 0o444 : 0o555);
  try {
    if (process.platform !== 'win32' && process.getuid?.() === 0) return;
    expect(() => writeEvidence(root, first.path!.slice(-67, -3), '#! ia 1.0\n')).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/^E(?:PERM|ACCES|ROFS|BUSY)$/) }),
    );
    expect(readFileSync(target)).toEqual(before);
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    chmodSync(lock, process.platform === 'win32' ? 0o644 : 0o755);
  }
  expect(statSync(target).isFile()).toBe(true);
});

it('stages and renames, so repeated writes of differing evidence always leave one whole file (C14)', () => {
  const root = workspace();
  fixture(root, check('whole-schema-check', 'COMP-SCHEMA', '*'));
  const revision = using(structural(root), (db) => db.authoredRevision),
    path = resolve(root, `${EVIDENCE_DIRECTORY}/${revision}.ia`);
  for (let round = 0; round < 20; round++) {
    const text = `#! ia 1.0\n\n// round ${round}\n${'x'.repeat(round * 1000)}\n`;
    expect(writeEvidence(root, revision, text)).toMatchObject({ written: true });
    expect(readFileSync(path, 'utf8')).toBe(text);
  }
  expect(readdirSync(resolve(root, EVIDENCE_DIRECTORY))).toEqual([`${revision}.ia`]);
  expect(writeEvidence(root, revision, null)).toEqual({
    path: null,
    written: true,
    pruned: [`${EVIDENCE_DIRECTORY}/${revision}.ia`],
  });
});
