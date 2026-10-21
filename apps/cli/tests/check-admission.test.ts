/**
 * Structural `@check` admission is the validate path's alone. The nine frozen machine routes and `ia scope` keep strict
 * admission, under which a check naming an evaluator that is not built in is IA-COMP-CHECK-UNKNOWN and is not
 * admitted, as every released reader has it.
 * Each route is answered over an unknown-runner fixture by the CLI's machine route, by a door opened with strict
 * admission named explicitly, and by one opened structurally: the first two agree byte for byte, and the structural one
 * differs, which proves the fixture tells the two admissions apart.
 */
import { afterAll, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Door } from '@inventarch/runtime';
import type { DoorOptions } from '@inventarch/runtime';
import { LEGACY_OPERATIONS } from '../src/commands.js';
import { runCli } from '../src/main.js';
import { cleanup, workspace } from './workspace-fixture.js';

afterAll(cleanup);

const CHECK = 'compliance-system/check/gate/typing-check',
  CONTRACT = 'compliance-system/contract/signature/foundation-authoring-contract';
const UNKNOWN = `#! ia 1.0

@check typing-check
  meaning
    says "Run the acme strict typing evaluator, which no host here installs."
    answers "Which evaluator checks typing?"
  check
    runs acme-strict-typing
    scope "package"
  governance
    severity blocking
  relationships
    enforces @contract foundation-authoring-contract
`;
/** Each machine route with parameters that reach the unknown check where the route can name it. */
const REQUESTS: readonly (readonly [(typeof LEGACY_OPERATIONS)[number], Record<string, unknown>])[] = [
  ['scope', {}],
  ['context', { text: 'typing check evaluator' }],
  ['select', { text: 'typing', candidates: [CHECK, CONTRACT] }],
  ['get', { identity: CHECK }],
  ['records', {}],
  ['resolve', { reference: { kind: 'ref', discriminator: 'check', name: 'typing-check' } }],
  ['search', { text: 'typing' }],
  ['traverse', { start: [CONTRACT], depth: 1, direction: 'in' }],
  ['report', {}],
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** A response line with the per-door scope token, a fresh UUID on every door, written as one placeholder. */
const line = (value: unknown) => `${JSON.stringify(value)}\n`.replace(UUID, '<token>');
/** Every route answered by one door per request, as each machine route invocation opens its own. */
const served = (root: string, options: Partial<DoorOptions>) =>
  REQUESTS.map(([operation, params]) => {
    const door = new Door(root, { cache: false, allowReport: true, protocol: 1, ...options });
    try {
      return line(door.request({ operation, params }));
    } finally {
      door.close();
    }
  });

it('answers the nine machine routes and ia scope over an unknown evaluator as strict admission does', () => {
  const root = workspace();
  writeFileSync(resolve(root, '.ia/src/systems/compliance-system/checks/typing-check.ia'), UNKNOWN);
  expect(REQUESTS.map(([operation]) => operation)).toEqual([...LEGACY_OPERATIONS]);
  const cli = REQUESTS.map(([operation, params]) =>
      runCli([operation, '--root', root, '--params', JSON.stringify(params)]).stdout.replace(UUID, '<token>'),
    ),
    strict = served(root, { checks: 'strict' }),
    structural = served(root, { checks: 'structural' });
  expect(cli).toEqual(strict);
  // Released behaviour: the record is not admitted, so no route names it, and report carries the refusal.
  const routes = Object.fromEntries(REQUESTS.map(([operation], index) => [operation, JSON.parse(strict[index]!)]));
  expect(routes['get']).toMatchObject({ ok: false, code: 'IA-DB-OUT-OF-SCOPE' });
  expect(routes['resolve'].result.ok).toBe(false);
  expect(strict.slice(1, 8).some((response) => response.includes(`"${CHECK}"`))).toBe(false);
  expect(
    routes['report'].result.findings.some(
      (finding: { code: string; path: string }) =>
        finding.code === 'IA-COMP-CHECK-UNKNOWN' && finding.path.endsWith('typing-check.ia'),
    ),
  ).toBe(true);
  // The structural door does admit it: the fixture separates the two admissions on every route that can name it.
  const changed = REQUESTS.filter((_, index) => structural[index] !== strict[index]).map(([operation]) => operation);
  expect(changed).toEqual(expect.arrayContaining(['get', 'records', 'resolve', 'search', 'report']));
  expect(JSON.parse(structural[3]!).result.identity).toBe(CHECK);
  // Every `ia scope` form the route parses stays the strict one too.
  for (const params of [{}, { phase: 'orient' }, { identities: [CONTRACT] }, { root: 'compliance-system' }])
    expect(runCli(['scope', '--root', root, '--params', JSON.stringify(params)]).stdout.replace(UUID, '<token>')).toBe(
      (() => {
        const door = new Door(root, { cache: false, allowReport: true, protocol: 1, checks: 'strict' });
        try {
          return line(door.request({ operation: 'scope', params }));
        } finally {
          door.close();
        }
      })(),
    );
});
