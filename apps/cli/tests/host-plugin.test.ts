import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  it('refuses a plugin directory that does not exist, even before a name resolves', async () => {
    const kit = join(scratch('host-plugin-missing-kit'), 'sample-kit');
    const result = await run(['init', kit, '--from', join(kit, 'no-such-plugin'), '--json']);
    expect(result.exitCode).toBe(1);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-INPUT');
    expect(existsSync(kit)).toBe(false);
  });
  it('reports the already-initialized conflict, not a lowering refusal', async () => {
    const kit = await lowered();
    const again = await run(['init', kit, '--from', SAMPLE, '--json']);
    expect(again.exitCode, again.stdout).toBe(0);
    expect(again.stdout).toContain('already initialized');
  });
  it('writes the lowered license asset with the sample bytes', async () => {
    const kit = await lowered();
    const written = readFileSync(join(kit, 'assets/plugin/LICENSE'));
    expect(written.equals(readFileSync(join(SAMPLE, 'LICENSE')))).toBe(true);
  });
});

describe('ia project --product plugin (A9)', () => {
  it('plans, then writes the plugin into an empty directory', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-out'), 'sample');
    const plan = await run(['project', 'claude', '--product', 'plugin', '--out', out, '--root', kit, '--json']);
    expect(plan.exitCode, plan.stdout).toBe(0);
    expect(existsSync(out)).toBe(false);
    const applied = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--out',
      out,
      '--root',
      kit,
      '--apply',
      '--yes',
      '--json',
    ]);
    expect(applied.exitCode, applied.stdout).toBe(0);
    expect(readFileSync(join(out, 'skills/sample-run/SKILL.md'), 'utf8')).toBe(
      readFileSync(join(SAMPLE, 'skills/sample-run/SKILL.md'), 'utf8'),
    );
  });
  it('refuses a non-empty --out before writing anything', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-busy'), 'busy');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'mine\n');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--out',
      out,
      '--root',
      kit,
      '--apply',
      '--yes',
      '--json',
    ]);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-OUT');
    expect(readdirSync(out)).toEqual(['keep.txt']);
  });
  it('refuses a resource edited after lowering, writing nothing', async () => {
    const kit = await lowered();
    writeFileSync(join(kit, '.ia/src/systems/sample-kit/plugin/skills/sample-run/SKILL.body.md'), 'edited\n');
    const out = join(scratch('host-plugin-digest'), 'sample');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--out',
      out,
      '--root',
      kit,
      '--apply',
      '--yes',
      '--json',
    ]);
    expect(json(result.stdout)['code']).toBe('IA-RESOURCE-DIGEST');
    expect(existsSync(out)).toBe(false);
  });
});
