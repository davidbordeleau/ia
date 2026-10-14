import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanup, scratch } from './scratch-fixture.js';
import { repository, run } from './workspace-fixture.js';

afterAll(cleanup);
async function workspace(): Promise<string> {
  const root = join(scratch('host-plugin'), 'ws');
  const result = await run(['init', root, '--apply', '--yes', '--host', 'none', '--json']);
  expect(result.exitCode, result.stdout).toBe(0);
  return root;
}
const validate = (root: string) => run(['validate', '--root', root, '--json']);
const capability = (mode: string): string =>
  [
    '#! ia 1.0',
    '',
    '@capability probe-skill',
    '  meaning',
    '    says "A probe skill."',
    '    answers "Does the invocation section admit?"',
    '  execution',
    '    effects []',
    '  invocation',
    `    mode ${mode}`,
    '    argument-hint "[target]"',
    '    triggers ["probe this", "run the probe"]',
    '',
  ].join('\n');

describe('invocation section (A1)', () => {
  it('admits a capability invocation section', async () => {
    const root = await workspace();
    writeFileSync(join(root, '.ia/src/probe.ia'), capability('user'));
    const result = await validate(root);
    expect(result.exitCode, result.stdout).toBe(0);
  });
  it('refuses an invocation mode outside the closed set', async () => {
    const root = await workspace();
    writeFileSync(join(root, '.ia/src/probe.ia'), capability('sometimes'));
    const result = await validate(root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('IA-COMP-FIELD-VALUE');
  });
});

describe('product section (A2)', () => {
  const distribution = (hosts: string): string =>
    [
      '#! ia 1.0',
      '',
      '@distribution probe-distribution',
      '  meaning',
      '    says "A probe plugin."',
      '    answers "Which records does the probe ship?"',
      '  distribution',
      '    records [@capability probe-skill]',
      '  product',
      '    name probe',
      '    display-name "Probe"',
      '    version "0.1.0"',
      '    description "A probe plugin."',
      `    hosts [${hosts}]`,
      '',
    ].join('\n');
  it('admits a product section', async () => {
    const root = await workspace();
    writeFileSync(join(root, '.ia/src/probe.ia'), capability('user'));
    writeFileSync(join(root, '.ia/src/probe-distribution.ia'), distribution('claude, codex'));
    expect((await validate(root)).exitCode).toBe(0);
  });
  it('refuses a host outside the closed set', async () => {
    const root = await workspace();
    writeFileSync(join(root, '.ia/src/probe.ia'), capability('user'));
    writeFileSync(join(root, '.ia/src/probe-distribution.ia'), distribution('claude, cursor'));
    const result = await validate(root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('IA-COMP-FIELD-VALUE');
  });
});

const json = (text: string): Record<string, unknown> => JSON.parse(text) as Record<string, unknown>;
const SAMPLE = resolve(repository, 'tools/projections/fixtures/host-plugin/sample');
async function lowered(): Promise<string> {
  const kit = join(scratch('host-plugin-kit'), 'sample-kit');
  const plan = await run(['init', kit, '--from', SAMPLE, '--json']);
  expect(plan.exitCode, plan.stdout).toBe(0);
  expect(existsSync(kit)).toBe(false);
  const applied = await run(['init', kit, '--from', SAMPLE, '--apply', '--yes', '--json']);
  expect(applied.exitCode, applied.stdout).toBe(0);
  return kit;
}
describe('ia init --from (A7)', () => {
  it('plans without writing, then lowers the sample into an admitted workspace', async () => {
    const kit = await lowered();
    expect(readFileSync(join(kit, '.ia/src/systems/sample-kit/plugin/skills/sample-run/SKILL.body.md'), 'utf8')).toBe(
      '\nRun the sample method on $ARGUMENTS.\n',
    );
    const release = JSON.parse(readFileSync(join(kit, '.ia/release.json'), 'utf8')) as { assets: unknown[] };
    expect(release.assets).toContainEqual({
      path: 'assets/plugin/LICENSE',
      role: 'license',
    });
    expect((await validate(kit)).exitCode).toBe(0);
  });
  it('refuses a plugin with an unresolved construct and writes nothing', async () => {
    const plugin = join(scratch('host-plugin-hooks'), 'sample');
    cpSync(SAMPLE, plugin, { recursive: true });
    mkdirSync(join(plugin, 'hooks'));
    writeFileSync(join(plugin, 'hooks/hooks.json'), '{}\n');
    const kit = join(scratch('host-plugin-hooks-kit'), 'sample-kit');
    const result = await run(['init', kit, '--from', plugin, '--json']);
    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)['code']).toBe('IA-LOWER-UNRESOLVED');
    expect(result.stdout).toContain('hooks/hooks.json');
    expect(existsSync(kit)).toBe(false);
  });
});
