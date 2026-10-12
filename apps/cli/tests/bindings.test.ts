/**
 * Task execution-binding-host-entry (plan amendments C16 and C24): `ia validate`'s Bindings section. Each authored
 * `@execution-binding` is joined against the catalog its host joined; only a bound one is ever a pass, an unavailable
 * one says so, and a revoked one is an error. Nothing is executed. tests/equivalence.test.ts compares the section the
 * two validation binaries report and proves neither writes; this file owns its presentation.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { host, initialized, put } from './host-fixture.js';
import { cleanup, run } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000 });
afterAll(cleanup, 120_000);

const BINDINGS = `#! ia 1.0

@execution-binding read-captured-source-binding
  meaning
    says "Select the installed first-party captured-source read adapter."
    answers "Which installed implementation serves captured reads here?"
  binding
    kind operation
    implementation captured-source-read-v1

@execution-binding missing-binding
  meaning
    says "Select an implementation no host ships."
    answers "What does an implementation that is not installed bind to?"
  binding
    kind operation
    implementation missing-read-v1
`;
/** The canonical binding's own target line, which no `ia init` consumer can resolve (review finding B2-R1). */
const TARGETED = `#! ia 1.0

@execution-binding targeted-read-binding
  meaning
    says "Select the installed read adapter for the captured-source read operation."
    answers "Does a binding whose target resolves to nothing bind?"
  binding
    kind operation
    target @operation read-captured-source
    implementation captured-source-read-v1
`;
/** A check naming a catalog evaluator, which only structural admission admits. */
const TYPING = `#! ia 1.0

@check typing-check
  meaning
    says "Run an evaluator the host catalog would list."
    answers "Which evaluator checks typing?"
  check
    runs acme-strict-typing
    scope "package"
  governance
    severity blocking
`;
const TYPING_ID = 'compliance-system/check/gate/typing-check';
const READ = 'agent-composition-system/binding/execution-binding/read-captured-source-binding',
  MISSING = 'agent-composition-system/binding/execution-binding/missing-binding',
  TARGETED_ID = 'agent-composition-system/binding/execution-binding/targeted-read-binding';
/** The report with every run of whitespace one space, so assertions do not depend on where lines wrap. */
const validate = async (root: string, env: Record<string, string>, ...extra: string[]) => {
  const result = await run(['validate', '--root', root, ...extra], { env });
  return { ...result, text: result.stdout.replace(/\s+/g, ' ') };
};

it('prints the Bindings section: unbound is never a pass, bound names the shipped handler, revoked is an error', async () => {
  const { root, env } = await initialized();
  // A workspace with no execution binding keeps the report it had, with an empty bindings result in JSON.
  const plain = await validate(root, env);
  expect(plain.text).not.toContain('Bindings');
  expect(JSON.parse((await validate(root, env, '--json')).stdout).bindings).toEqual({ catalog: null, results: [] });

  put(root, '.ia/src/bindings.ia', BINDINGS);
  const unjoined = await validate(root, env);
  expect(unjoined.exitCode).toBe(0);
  expect(unjoined.text).toContain('2 execution bindings are not bound; an unbound binding is not a pass.');
  expect(unjoined.text).toContain(
    'No installed-implementation catalog: no host has joined an installed-implementation catalog in this workspace',
  );
  expect(unjoined.text).toContain(`${READ} captured-source-read-v1: unavailable`);

  expect((await host(root, env, 'claude', '--apply', '--yes')).exitCode).toBe(0);
  const joined = await validate(root, env);
  expect(joined.exitCode).toBe(0);
  expect(joined.text).toContain('1 execution binding is not bound; an unbound binding is not a pass.');
  expect(joined.text).toMatch(
    /Catalog [0-9a-f]{12}… in release [0-9a-f]{12}… \([^)]+\), joined by host claude\. Nothing is executed\./,
  );
  expect(joined.text).toContain(`${READ} captured-source-read-v1: bound`);
  expect(joined.text).toContain('captured-source-read-v1 ships handler ia.captured-source.read.v1 (bytes ');
  expect(joined.text).toContain(`${MISSING} missing-read-v1: unavailable`);
  expect(joined.text).toContain('the installed catalog lists no implementation missing-read-v1');
  const envelope = JSON.parse((await validate(root, env, '--json')).stdout);
  expect(envelope.bindings.results.map((row: { status: string }) => row.status)).toEqual(['unavailable', 'bound']);
  expect(envelope.counts.errors).toBe(0);

  // Altered shipped handler bytes: the catalog fails verification, both bindings are revoked, and the run fails.
  const handler = resolve(
    env.IA_HOST_HOME,
    'hosts',
    envelope.bindings.catalog.release,
    'runtime/node_modules/@inventarch/agent-composition-system/dist/installed-read.js',
  );
  const original = readFileSync(handler);
  writeFileSync(handler, Buffer.concat([original, Buffer.from('\n// altered\n')]));
  try {
    const revoked = await validate(root, env);
    expect(revoked.exitCode).toBe(1);
    expect(revoked.text).toContain('2 execution bindings are revoked, which is an error.');
    expect(revoked.text).toContain('The catalog host claude joined failed verification: IA-DIST-INTEGRITY-MISMATCH');
    expect(revoked.text).toContain(`${READ} captured-source-read-v1: revoked`);
    // Review finding B2-N8: no admission error is listed, so the closing names the repair instead.
    expect(revoked.text).not.toContain('Fix the errors above');
    expect(revoked.text).toContain(
      `Delete ${resolve(env.IA_HOST_HOME, 'hosts', envelope.bindings.catalog.release)}, the host payload that failed verification, then run "ia host claude --root ${root} --apply".`,
    );
    expect(JSON.parse((await validate(root, env, '--json')).stdout).bindings.catalog).toMatchObject({
      status: 'damaged',
      payload: resolve(env.IA_HOST_HOME, 'hosts', envelope.bindings.catalog.release),
    });
    // Revocation is the bindings' own error: admission's findings and their counts are unchanged.
    expect(JSON.parse((await validate(root, env, '--json')).stdout).counts).toEqual(envelope.counts);
    // Review findings B3-R2 and B3-R3: a check naming a catalog evaluator is revoked by the same damaged catalog and
    // fails the run on its own; since ia host refuses the check, the repair names it before the payload.
    put(root, '.ia/src/typing.ia', TYPING);
    const checked = await validate(root, env, '--json'),
      body = JSON.parse(checked.stdout);
    expect(checked.exitCode).toBe(1);
    expect(body.checks.results).toEqual([
      expect.objectContaining({ identity: TYPING_ID, status: 'revoked', outcome: 'not-evaluated' }),
    ]);
    const repair = (await validate(root, env)).text;
    expect(repair).toContain('1 check is revoked, which is an error.');
    expect(repair).toContain(
      `Remove or replace ${TYPING_ID}, which ia validate, ia preview and ia author admit but ia host refuses, then delete ${resolve(env.IA_HOST_HOME, 'hosts', envelope.bindings.catalog.release)}, the host payload that failed verification, and run "ia host claude --root ${root} --apply".`,
    );
    rmSync(resolve(root, '.ia/src/typing.ia'));
  } finally {
    writeFileSync(handler, original);
  }
  expect((await validate(root, env)).exitCode).toBe(0);
  // Only the shipped handler deleted (review finding B2-N4): the payload is incomplete rather than changed, so the
  // catalog is unavailable, every binding is unbound rather than revoked, and the run does not fail.
  rmSync(handler);
  try {
    const deleted = await validate(root, env);
    expect(deleted.exitCode).toBe(0);
    expect(deleted.text).toContain('IA-DIST-ARTIFACT-UNAVAILABLE: Host payload is incomplete');
    expect(deleted.text).toContain(`${READ} captured-source-read-v1: unavailable`);
    expect(deleted.text).not.toContain('revoked');
  } finally {
    writeFileSync(handler, original);
  }
  // The canonical binding's target line: this consumer admits no `@operation read-captured-source`, so the stated
  // target resolves to nothing and the binding is unavailable though its implementation is shipped; the binding that
  // states no target still binds.
  put(root, '.ia/src/targeted.ia', TARGETED);
  const targeted = await validate(root, env);
  expect(targeted.exitCode).toBe(0);
  expect(targeted.text).toContain('2 execution bindings are not bound; an unbound binding is not a pass.');
  expect(targeted.text).toContain(`${TARGETED_ID} captured-source-read-v1: unavailable`);
  expect(targeted.text).toContain('binding.target @operation read-captured-source resolves to no admitted record');
  expect(targeted.text).toContain(`${READ} captured-source-read-v1: bound`);
});
