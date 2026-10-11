/**
 * Milestone generation-binding task check-runner-join-validate (plan amendments C14, C15, C21, C22 and C23): `ia
 * validate` binds every `@check`, reports a Checks section, and records the bound checks that passed or failed as runtime
 * evidence, the one write it makes. A not-evaluated check is never a pass and records nothing; the authored revision,
 * the position packet and the host projection never move for it; and no other command writes or prunes evidence.
 * tests/equivalence.test.ts holds the two validation binaries to one result and one evidence file.
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { open } from '@inventarch/db';
import { doctor, host, initialized, put } from './host-fixture.js';
import { cleanup, repository, run } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 240_000 });
afterAll(cleanup, 120_000);

const EVIDENCE = '.ia/work/evidence',
  /** The workspace rules file `ia host claude` projects, the consumer's CLAUDE.md. */
  PROJECTED = '.claude/rules/ia-workspace.md';
/** A local check in an `ia init` workspace naming `runner`, with the text scope `scope`. */
const check = (name: string, runner: string, scope: string) => `@check ${name}
  meaning
    says "Bind ${name} for the test."
    answers "What does ${name} select?"
  check
    runs ${runner}
    scope "${scope}"
  governance
    severity blocking
`;
const CHECKS = `#! ia 1.0

${check('demo-schema-check', 'COMP-SCHEMA', '*')}
${check('prose-check', 'COMP-SCHEMA', 'every admitted record')}
${check('typing-check', 'acme-strict-typing', 'package')}`;
/** Only built-in evaluators, so every strict reader (`ia host`, `ia capture`, `ia position`) admits the workspace too. */
const BUILT_IN = `#! ia 1.0

${check('demo-schema-check', 'COMP-SCHEMA', '*')}
${check('prose-check', 'COMP-SCHEMA', 'every admitted record')}`;
const ID = (name: string) => `compliance-system/check/gate/${name}`;
const validate = async (root: string, env: Record<string, string>, ...extra: string[]) => {
  const result = await run(['validate', '--root', root, ...extra], { env });
  return { ...result, text: result.stdout.replace(/\s+/g, ' ') };
};
const json = async (root: string, env: Record<string, string>) => {
  const result = await run(['validate', '--root', root, '--json'], { env });
  return { exitCode: result.exitCode, envelope: JSON.parse(result.stdout) };
};
/** Every entry under each root and the root itself, with directory mtimes and file sizes, mtimes and digests. */
function tree(...roots: string[]): Record<string, string> {
  const entries: Record<string, string> = {};
  const describe = (path: string) => {
    const stat = statSync(path);
    return stat.isDirectory()
      ? `directory ${stat.mtimeMs}`
      : `${stat.size} ${stat.mtimeMs} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
  };
  for (const top of roots) {
    entries[top] = existsSync(top) ? describe(top) : 'absent';
    if (existsSync(top))
      for (const entry of readdirSync(top, { recursive: true, encoding: 'utf8' }))
        entries[resolve(top, entry)] = describe(resolve(top, entry));
  }
  return entries;
}
const authoredRevision = (root: string) => {
  const db = open(root, { cache: false });
  try {
    return db.authoredRevision;
  } finally {
    db.close();
  }
};

it('binds every check, reports one Checks section, and records the passing one as admitted runtime evidence', async () => {
  const { root, env } = await initialized();
  // A workspace with no check keeps its report, with empty checks and nothing recorded in JSON.
  const plain = await validate(root, env);
  expect(plain.text).not.toContain('Checks');
  const before = await json(root, env);
  expect(before.envelope.checks).toEqual({ catalog: null, results: [] });
  expect(before.envelope.evidence).toEqual({ path: null, written: false, pruned: [], observations: [] });

  put(root, '.ia/src/checks.ia', CHECKS);
  const revision = authoredRevision(root),
    path = `${EVIDENCE}/${revision}.ia`,
    name = `demo-schema-check-${revision.slice(0, 12)}`;
  const { exitCode, envelope } = await json(root, env);
  expect(exitCode).toBe(0);
  const results = Object.fromEntries(envelope.checks.results.map((row: { name: string }) => [row.name, row])) as Record<
    string,
    Record<string, unknown>
  >;
  // A built-in evaluator over the whole-workspace token: bound, with the aggregate of its verdicts.
  expect(results['demo-schema-check']).toMatchObject({
    identity: ID('demo-schema-check'),
    runner: 'COMP-SCHEMA',
    scope: '*',
    status: 'bound',
    implementation: 'built-in',
    outcome: 'pass',
  });
  // A prose scope selects nothing, and an evaluator no catalog lists is unavailable: neither is a pass.
  expect(results['prose-check']).toMatchObject({ status: 'bound', outcome: 'not-evaluated', selected: 0 });
  expect(results['typing-check']).toMatchObject({
    status: 'unavailable',
    implementation: null,
    outcome: 'not-evaluated',
    reason: expect.stringContaining('no host has joined'),
  });
  // Only the passing check is recorded, as one observation of the authored revision.
  expect(envelope.evidence).toEqual({
    path,
    written: true,
    pruned: [],
    observations: [{ name, check: ID('demo-schema-check'), verdict: 'success' }],
  });
  const db = open(root, { cache: false, checks: 'structural', evidence: true });
  try {
    const observation = db.records().find((record) => record.name === name)!;
    expect(observation).toMatchObject({ discriminator: 'observation', band: 0 });
    const verdict = observation.sections
      .find((section) => section.name === 'evidence')!
      .fields.find((field) => 'key' in field && field.key === 'verdict');
    expect(verdict && 'value' in verdict && verdict.value).toMatchObject({ text: 'success' });
    expect(db.authoredRevision).toBe(revision);
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  } finally {
    db.close();
  }
  // The human report: one entry per check, its result and reason under its identity, and what was recorded.
  const human = await validate(root, env);
  expect(human.exitCode).toBe(0);
  expect(human.text).toContain(`✔ ${ID('demo-schema-check')} COMP-SCHEMA: bound, pass built-in COMP-SCHEMA: `);
  expect(human.text).toContain(
    '1 check names an evaluator that is not built in: ia validate admits it to bind it, but every other reader of the admitted graph still refuses it as IA-COMP-CHECK-UNKNOWN.',
  );
  expect(human.text).toContain(
    `${ID('prose-check')} COMP-SCHEMA: bound, not-evaluated check.scope "every admitted record"`,
  );
  expect(human.text).toContain(`${ID('typing-check')} acme-strict-typing: unavailable, not-evaluated`);
  expect(human.text).toContain('2 checks were not evaluated; a not-evaluated check is not a pass.');
  expect(human.text).toContain(`Recorded 1 observation in ${path}, unchanged.`);
  expect(human.text).toContain('A not-evaluated result is not a pass. Supply the named evaluator to obtain one.');
});

it('leaves the authored revision, the position packet and the host projection unchanged across two validates', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/checks.ia', BUILT_IN);
  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const revision = authoredRevision(root),
    position = (await run(['position', '--root', root, '--json'], { env })).stdout,
    projected = readFileSync(resolve(root, PROJECTED));
  const first = await json(root, env),
    second = await json(root, env);
  expect(first.envelope.evidence).toMatchObject({ path: `${EVIDENCE}/${revision}.ia`, written: true });
  expect(second.envelope.evidence).toMatchObject({ path: `${EVIDENCE}/${revision}.ia`, written: false });
  expect(second.envelope.checks).toEqual(first.envelope.checks);
  expect(authoredRevision(root)).toBe(revision);
  expect((await run(['position', '--root', root, '--json'], { env })).stdout).toBe(position);
  expect(readFileSync(resolve(root, PROJECTED))).toEqual(projected);
  const rows = (await doctor(root, env)).checks;
  expect(rows.find((row) => row.id === 'projection-claude')).toMatchObject({
    status: 'ok',
    detail: expect.stringContaining('No drift: '),
  });
});

it('never creates or prunes evidence from doctor, capture --preview or a refused effect (C23)', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/checks.ia', BUILT_IN);
  expect((await json(root, env)).envelope.evidence.written).toBe(true);
  // An older revision's file a writer would prune, beside the current one.
  put(root, `${EVIDENCE}/${'0'.repeat(64)}.ia`, '#! ia 1.0\n');
  const home = env.IA_HOST_HOME,
    before = tree(root, home);
  for (const argv of [
    ['doctor', '--root', root],
    ['doctor', '--root', root, '--json'],
    ['capture', '--root', root, '--preview'],
    ['capture', '--root', root, '--preview', '--json'],
    // Refused effects: an initialized target, and a host this release does not project.
    ['init', root, '--apply', '--yes'],
    ['host', 'cursor', '--root', root, '--apply', '--yes'],
  ]) {
    const result = await run(argv, { env });
    expect(tree(root, home), argv.join(' ')).toEqual(before);
    if (argv[0] === 'init' || argv[0] === 'host') expect(result.exitCode, argv.join(' ')).not.toBe(0);
  }
});

it('refuses cleanly where the evidence cannot be written, and through a junction, leaving what it found', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/checks.ia', CHECKS);
  const revision = authoredRevision(root),
    target = resolve(root, `${EVIDENCE}/${revision}.ia`),
    directory = resolve(root, EVIDENCE);
  // A stale file at this revision that the writer must replace: not admitted as evidence, so validate rewrites it.
  put(root, `${EVIDENCE}/${revision}.ia`, '#! ia 1.0\n// stale\n');
  const lock = process.platform === 'win32' ? target : directory;
  if (process.platform !== 'win32' && process.getuid?.() === 0) return;
  chmodSync(lock, process.platform === 'win32' ? 0o444 : 0o555);
  try {
    const refused = await run(['validate', '--root', root, '--json'], { env });
    expect(refused.exitCode).toBe(3);
    const body = JSON.parse(refused.stdout || refused.stderr);
    expect(body).toMatchObject({
      ok: false,
      code: 'IA-DIST-EVIDENCE-UNWRITABLE',
      next: expect.stringContaining(`Make ${EVIDENCE} writable, then run "ia validate --root`),
    });
    expect(readFileSync(target, 'utf8')).toBe('#! ia 1.0\n// stale\n');
    expect(readdirSync(directory).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  } finally {
    chmodSync(lock, process.platform === 'win32' ? 0o644 : 0o755);
  }
  expect((await json(root, env)).envelope.evidence.written).toBe(true);
});

it('keeps one whole evidence file when several validates run at once', async () => {
  const { root, env } = await initialized();
  put(root, '.ia/src/checks.ia', CHECKS);
  const main = resolve(repository, 'apps/cli/dist/main.js');
  const runs = await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<{ code: number | null; stdout: string }>((done) => {
          const child = spawn(process.execPath, [main, 'validate', '--root', root, '--json'], {
            env: { ...process.env, ...env, NODE_OPTIONS: '' },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let stdout = '';
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.on('close', (code) => done({ code, stdout }));
        }),
    ),
  );
  for (const result of runs) expect(result.code, result.stdout).toBe(0);
  const revision = authoredRevision(root);
  expect(readdirSync(resolve(root, EVIDENCE))).toEqual([`${revision}.ia`]);
  const db = open(root, { cache: false, checks: 'structural', evidence: true });
  try {
    expect(db.records().filter((record) => record.band === 0 && record.discriminator === 'observation')).toHaveLength(
      1,
    );
  } finally {
    db.close();
  }
});
