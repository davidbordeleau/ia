import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loweredLicense } from '../src/init.js';
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

describe('ia project --product plugin (A9 fix round 1)', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const project = (kit: string, out: string, ...more: string[]) =>
    run(['project', 'claude', '--product', 'plugin', '--out', out, '--root', kit, '--json', ...more]);

  it('writes every file byte-identical to the sample', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-tree'), 'sample');
    const applied = await project(kit, out, '--apply', '--yes');
    expect(applied.exitCode, applied.stdout).toBe(0);
    const names = (dir: string) =>
      walk(dir)
        .map((file) => relative(dir, file))
        .sort();
    expect(names(out)).toEqual(names(SAMPLE));
    for (const name of names(SAMPLE))
      expect(readFileSync(join(out, name)).equals(readFileSync(join(SAMPLE, name))), name).toBe(true);
  });
  it('refuses a manifest path that escapes the workspace', async () => {
    const kit = await lowered();
    const file = join(kit, '.ia/authoring.resources.json');
    const manifest = json(readFileSync(file, 'utf8')) as {
      files: { path: string }[];
    };
    manifest.files[0]!.path = '../../etc/hosts';
    writeFileSync(file, JSON.stringify(manifest));
    const out = join(scratch('host-plugin-escape'), 'sample');
    const result = await project(kit, out, '--apply', '--yes');
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-PRODUCT');
    expect(existsSync(out)).toBe(false);
  });
  it('refuses a missing authoring manifest with a code', async () => {
    const kit = await lowered();
    rmSync(join(kit, '.ia/authoring.resources.json'));
    const out = join(scratch('host-plugin-nomanifest'), 'sample');
    const result = await project(kit, out, '--apply', '--yes');
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-PRODUCT');
    expect(result.exitCode).not.toBe(3);
    expect(existsSync(out)).toBe(false);
  });
  it('refuses an --out that is a file', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-file'), 'afile');
    writeFileSync(out, 'x');
    const result = await project(kit, out, '--apply', '--yes');
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-OUT');
  });
  it('refuses an --out inside the workspace', async () => {
    const kit = await lowered();
    const out = join(kit, '.ia/out');
    const result = await project(kit, out, '--apply', '--yes');
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-OUT');
    expect(existsSync(out)).toBe(false);
  });
  it('refuses a non-empty --out while planning', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-planbusy'), 'busy');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'keep.txt'), 'mine\n');
    const result = await project(kit, out);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-OUT');
  });
});

describe('ia project --product plugin --check (A10)', () => {
  it('passes on the sample: content-exact against the original and a fixed point', async () => {
    const kit = await lowered();
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--check',
      '--compare',
      SAMPLE,
      '--root',
      kit,
      '--json',
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const report = json(result.stdout) as {
      drift: unknown[];
      fixedPoint: unknown[];
    };
    expect(report.drift).toEqual([]);
    expect(report.fixedPoint).toEqual([]);
  });
  it('reports drift when a regenerated file cannot be explained by a rule', async () => {
    const plugin = join(scratch('host-plugin-drift'), 'sample');
    cpSync(SAMPLE, plugin, { recursive: true });
    const kit = join(scratch('host-plugin-drift-kit'), 'sample-kit');
    expect((await run(['init', kit, '--from', plugin, '--apply', '--yes', '--json'])).exitCode).toBe(0);
    writeFileSync(join(plugin, 'README.md'), '# Changed after lowering\n');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--check',
      '--compare',
      plugin,
      '--root',
      kit,
      '--json',
    ]);
    expect(json(result.stdout)['code']).toBe('IA-ROUNDTRIP-DRIFT');
  });
});

describe('ia project --product plugin --check (A10 fix round 1)', () => {
  const readdirRecursive = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
      .sort();
  const check = (kit: string, ...compare: string[]) =>
    run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--check',
      ...(compare.length > 0 ? ['--compare', compare[0]!] : []),
      '--root',
      kit,
      '--json',
    ]);
  type Report = {
    compared: boolean;
    diffs: { path: string; status: string }[];
    drift: unknown[];
    fixedPoint: string[];
    unresolved: string[];
  };
  async function pair(label: string): Promise<{ plugin: string; kit: string }> {
    const plugin = join(scratch(`host-plugin-${label}`), 'sample');
    cpSync(SAMPLE, plugin, { recursive: true });
    const kit = join(scratch(`host-plugin-${label}-kit`), 'sample-kit');
    expect((await run(['init', kit, '--from', plugin, '--apply', '--yes', '--json'])).exitCode).toBe(0);
    return { plugin, kit };
  }

  it('reports the compared files and no unresolved entries on the sample', async () => {
    const kit = await lowered();
    const result = await check(kit, SAMPLE);
    const report = json(result.stdout) as unknown as Report;
    expect(report.compared).toBe(true);
    expect(report.unresolved).toEqual([]);
    expect(report.diffs.map((d) => d.path)).toEqual(readdirRecursive(SAMPLE));
    expect(report.diffs.every((d) => d.status === 'identical')).toBe(true);
  });
  it('says it is a fixed point only, without --compare', async () => {
    const kit = await lowered();
    const result = await run(['project', 'claude', '--product', 'plugin', '--check', '--root', kit]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('fixed point');
    expect(result.stdout).not.toContain('content-exact');
  });
  it('names a lowered file the workspace holds differently, and keeps the report in the refusal', async () => {
    const kit = await lowered();
    const map = join(kit, 'assets/lowering-map.json');
    writeFileSync(map, JSON.stringify(JSON.parse(readFileSync(map, 'utf8'))));
    const result = await check(kit);
    const body = json(result.stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    expect((body['details'] as Report).fixedPoint).toContain('assets/lowering-map.json');
    expect(String(body['message'])).toContain('assets/lowering-map.json');
  });
  it('names a stray file under the plugin resources as a fixed-point mismatch', async () => {
    const kit = await lowered();
    writeFileSync(join(kit, '.ia/src/systems/sample-kit/plugin/stray.md'), 'not indexed\n');
    const body = json((await check(kit)).stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    expect((body['details'] as Report).fixedPoint).toContain('.ia/src/systems/sample-kit/plugin/stray.md');
  });
  it('reports unresolved entries when the rendered plugin cannot be lowered again', async () => {
    const kit = await lowered();
    writeFileSync(join(kit, 'assets/plugin/README.md'), 'one\r\ntwo\r\n');
    const body = json((await check(kit)).stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    expect((body['details'] as Report).unresolved.length).toBeGreaterThan(0);
  });
  it('reports a file the original lacks as extra and one it holds as missing, and re-runs with --compare', async () => {
    const { plugin, kit } = await pair('extra-missing');
    rmSync(join(plugin, 'README.md'));
    writeFileSync(join(plugin, 'NOTES.md'), 'added after lowering\n');
    const body = json((await check(kit, plugin)).stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    const byPath = new Map((body['details'] as Report).diffs.map((d) => [d.path, d.status]));
    expect(byPath.get('README.md')).toBe('extra');
    expect(byPath.get('NOTES.md')).toBe('missing');
    expect(String(body['next'])).toContain('--compare');
  });
  it('calls frontmatter the lowering never parsed drift', async () => {
    const { plugin, kit } = await pair('unparsed');
    const agent = join(plugin, 'agents/sample-reader.md');
    writeFileSync(agent, readFileSync(agent, 'utf8').replace('\n---\n', '\nmetadata:\n  owner: someone-else\n---\n'));
    const body = json((await check(kit, plugin)).stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    const drift = (body['details'] as { drift: { path: string }[] }).drift;
    expect(drift.map((d) => d.path)).toContain('agents/sample-reader.md');
  });
  it('refuses a workspace that does not hold exactly one system', async () => {
    const kit = await lowered();
    mkdirSync(join(kit, '.ia/src/systems/other'), { recursive: true });
    const body = json((await check(kit)).stdout);
    expect(body['code']).toBe('IA-PLUGIN-PRODUCT');
  });
  it('counts directories only under .ia/src/systems', async () => {
    const kit = await lowered();
    writeFileSync(join(kit, '.ia/src/systems/NOTES.txt'), 'a file, not a system\n');
    const result = await check(kit, SAMPLE);
    expect(result.exitCode, result.stdout).toBe(0);
  });
});

describe('final review: lowering admits only what renders back', () => {
  const AGENT = 'agents/sample-reader.md';
  const CODEX = '.codex-plugin/plugin.json';
  const CLAUDE = '.claude-plugin/plugin.json';
  const TOOLS = 'tools: Read, Grep, Glob';
  const edit = (plugin: string, path: string, change: (text: string) => string): void =>
    writeFileSync(join(plugin, path), change(readFileSync(join(plugin, path), 'utf8')));
  const manifest = (plugin: string, path: string, change: (value: Record<string, unknown>) => void): void =>
    edit(plugin, path, (text) => {
      const value = json(text);
      change(value);
      return `${JSON.stringify(value, null, 2)}\n`;
    });
  type Variant = readonly [label: string, change: (plugin: string) => void, refused: boolean];
  const VARIANTS: readonly Variant[] = [
    ['the sample', () => {}, false],
    ['reordered tools', (p) => edit(p, AGENT, (t) => t.replace(TOOLS, 'tools: Glob, Grep, Read')), false],
    ['double-quoted tools', (p) => edit(p, AGENT, (t) => t.replace(TOOLS, 'tools: "Read, Grep, Glob"')), false],
    [
      'swapped frontmatter keys',
      (p) =>
        edit(p, AGENT, (t) =>
          t.replace(/name: (.*)\ndescription: (.*)\n/, (_m, n: string, d: string) => `description: ${d}\nname: ${n}\n`),
        ),
      false,
    ],
    // The renderer omits the default, so the lowering map of the output lacks the key and the fixed point would fail.
    [
      'an explicit default disable-model-invocation',
      (p) =>
        edit(p, 'skills/sample-guide/SKILL.md', (t) =>
          t.replace('\n---\n', '\ndisable-model-invocation: false\n---\n'),
        ),
      true,
    ],
    [
      'a Codex manifest without hooks',
      (p) =>
        manifest(p, CODEX, (m) => {
          delete m['hooks'];
        }),
      false,
    ],
    [
      'a reordered, minified Claude manifest',
      (p) =>
        edit(p, CLAUDE, (t) => {
          const value = json(t);
          return JSON.stringify({ license: value['license'], ...value });
        }),
      false,
    ],
    ['list-form tools', (p) => edit(p, AGENT, (t) => t.replace(TOOLS, 'tools: [Read, Grep, Glob]')), true],
    ['tools without spaces', (p) => edit(p, AGENT, (t) => t.replace(TOOLS, 'tools: Read,Grep,Glob')), true],
    [
      'a Codex interface without displayName',
      (p) =>
        manifest(p, CODEX, (m) => {
          delete (m['interface'] as Record<string, unknown>)['displayName'];
        }),
      true,
    ],
    [
      'a Codex manifest without interface',
      (p) =>
        manifest(p, CODEX, (m) => {
          delete m['interface'];
        }),
      true,
    ],
  ];
  it.each(VARIANTS)(
    '%s: zero unresolved entries means the check finds only identical or ruled files',
    async (_label, change, refused) => {
      const plugin = join(scratch('host-plugin-variant'), 'sample');
      cpSync(SAMPLE, plugin, { recursive: true });
      change(plugin);
      const kit = join(scratch('host-plugin-variant-kit'), 'sample-kit');
      const plan = await run(['init', kit, '--from', plugin, '--json']);
      if (refused) {
        expect(plan.exitCode, plan.stdout).toBe(1);
        expect(json(plan.stdout)['code']).toBe('IA-LOWER-UNRESOLVED');
        expect(existsSync(kit)).toBe(false);
        return;
      }
      expect(plan.exitCode, plan.stdout).toBe(0);
      const applied = await run(['init', kit, '--from', plugin, '--apply', '--yes', '--json']);
      expect(applied.exitCode, applied.stdout).toBe(0);
      const result = await run([
        'project',
        'claude',
        '--product',
        'plugin',
        '--check',
        '--compare',
        plugin,
        '--root',
        kit,
        '--json',
      ]);
      expect(result.exitCode, result.stdout).toBe(0);
      const report = json(result.stdout) as { diffs: { path: string; status: string }[] };
      expect(report.diffs.filter((d) => d.status !== 'identical' && d.status !== 'ruled')).toEqual([]);
    },
  );
});

describe('final review: ia project plugin flags', () => {
  it.each([[['--out', 'elsewhere']], [['--check']], [['--compare', 'elsewhere']]])(
    'refuses %j without --product plugin as usage, naming the --product plugin form',
    async (flags) => {
      const result = await run(['project', 'claude', ...flags, '--json']);
      expect(result.exitCode, result.stdout).toBe(2);
      const body = json(result.stdout);
      expect(body['code']).toBe('IA-CLI-USAGE');
      expect(String(body['next'])).toContain('--product plugin');
    },
  );
  it('refuses --compare without --check', async () => {
    const kit = await lowered();
    const out = join(scratch('host-plugin-compare-out'), 'sample');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--out',
      out,
      '--compare',
      SAMPLE,
      '--root',
      kit,
      '--json',
    ]);
    expect(result.exitCode, result.stdout).toBe(2);
    expect(json(result.stdout)['code']).toBe('IA-CLI-USAGE');
    expect(String(json(result.stdout)['message'])).toContain('--check');
  });
  it.each(['grok', 'cursor'])('refuses the host %s for --product plugin as usage', async (host) => {
    const kit = await lowered();
    const result = await run(['project', host, '--product', 'plugin', '--check', '--root', kit, '--json']);
    expect(result.exitCode, result.stdout).toBe(2);
    expect(json(result.stdout)['code']).toBe('IA-CLI-USAGE');
  });
  it('refuses a --compare directory that does not exist with IA-PLUGIN-INPUT', async () => {
    const kit = await lowered();
    const missing = join(scratch('host-plugin-nocompare'), 'absent');
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--check',
      '--compare',
      missing,
      '--root',
      kit,
      '--json',
    ]);
    expect(result.exitCode, result.stdout).toBe(1);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-INPUT');
  });
  it('judges an --out named ..x below the workspace as inside it', async () => {
    const kit = await lowered();
    const out = join(kit, '..x');
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
    expect(existsSync(out)).toBe(false);
  });
  it.each(['.ia/src/systems/sample-kit/plugin/skills', 'assets/plugin/tests'])(
    'refuses a resource or asset read through a link or junction at %s',
    async (directory) => {
      const kit = await lowered();
      const linked = join(kit, directory);
      const real = join(scratch('host-plugin-linked'), 'real');
      cpSync(linked, real, { recursive: true });
      rmSync(linked, { recursive: true });
      try {
        symlinkSync(real, linked, 'junction');
      } catch {
        return; // a platform that can create neither a junction nor a directory link: only this case is skipped
      }
      const result = await run(['project', 'claude', '--product', 'plugin', '--check', '--root', kit, '--json']);
      expect(result.exitCode, result.stdout).toBe(1);
      expect(json(result.stdout)['code']).toBe('IA-PLUGIN-INPUT');
    },
  );
  it('separates the drift counts from the file list, and a --json refusal does not ask for --json', async () => {
    const plugin = join(scratch('host-plugin-wording'), 'sample');
    cpSync(SAMPLE, plugin, { recursive: true });
    const kit = join(scratch('host-plugin-wording-kit'), 'sample-kit');
    expect((await run(['init', kit, '--from', plugin, '--apply', '--yes', '--json'])).exitCode).toBe(0);
    writeFileSync(join(plugin, 'README.md'), '# Changed after lowering\n');
    const argv = ['project', 'claude', '--product', 'plugin', '--check', '--compare', plugin, '--root', kit];
    const body = json((await run([...argv, '--json'])).stdout);
    expect(body['code']).toBe('IA-ROUNDTRIP-DRIFT');
    expect(String(body['message'])).toMatch(/^1 drifted, 0 fixed-point mismatches, 0 unresolved\. Files: README\.md /);
    expect(String(body['next'])).not.toContain('--json');
    const human = await run(argv);
    expect(human.exitCode).toBe(1);
    expect(human.stderr.replace(/\s+/g, ' ')).toContain('--json');
  });
});

describe('final review: ia init --from', () => {
  const listed = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
      .sort();
  async function plugin(label: string): Promise<string> {
    const root = join(scratch(`host-plugin-${label}`), 'sample');
    cpSync(SAMPLE, root, { recursive: true });
    return root;
  }
  it('refuses ia init --from . run inside the plugin, writing nothing into it', async () => {
    const source = await plugin('self');
    const before = listed(source);
    const result = await run(['init', '--from', '.', '--apply', '--yes', '--json'], { cwd: source });
    expect(result.exitCode, result.stdout).toBe(1);
    const body = json(result.stdout);
    expect(body['code']).toBe('IA-PLUGIN-INPUT');
    expect(String(body['message'])).toMatch(/inside/);
    expect(String(body['next'])).toMatch(/outside/);
    expect(listed(source)).toEqual(before);
  });
  it('refuses ia init ./kit --from . (a target inside the plugin)', async () => {
    const source = await plugin('inside');
    const before = listed(source);
    const result = await run(['init', './kit', '--from', '.', '--apply', '--yes', '--json'], { cwd: source });
    expect(result.exitCode, result.stdout).toBe(1);
    expect(json(result.stdout)['code']).toBe('IA-PLUGIN-INPUT');
    expect(String(json(result.stdout)['message'])).toMatch(/inside/);
    expect(listed(source)).toEqual(before);
  });
  it('keeps a target that contains the plugin legal', async () => {
    const parent = join(scratch('host-plugin-parent'), 'outer-kit');
    mkdirSync(parent);
    cpSync(SAMPLE, join(parent, 'plugin'), { recursive: true });
    const result = await run(['init', '.', '--from', './plugin', '--json'], { cwd: parent });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).not.toContain('IA-PLUGIN-INPUT');
  });
  it('carries every unresolved entry in the refusal details', async () => {
    const source = await plugin('details');
    mkdirSync(join(source, 'hooks'));
    for (let index = 0; index < 25; index += 1) writeFileSync(join(source, `hooks/h${index}.json`), '{}\n');
    const kit = join(scratch('host-plugin-details-kit'), 'sample-kit');
    const body = json((await run(['init', kit, '--from', source, '--json'])).stdout);
    expect(body['code']).toBe('IA-LOWER-UNRESOLVED');
    expect(body['details']).toHaveLength(25);
  });
  it('takes the descriptor licence from the Claude manifest when it is an SPDX identifier', async () => {
    const kit = await lowered();
    expect(json(readFileSync(join(kit, '.ia/release.json'), 'utf8'))['license']).toBe('Apache-2.0');
  });
  it.each(['SEE LICENSE IN LICENSE', 'Proprietary'])(
    'keeps UNLICENSED when the Claude manifest licence is %s, no SPDX identifier',
    async (license) => {
      const source = await plugin('licence');
      for (const path of ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.grok-plugin/plugin.json']) {
        const value = json(readFileSync(join(source, path), 'utf8'));
        value['license'] = license;
        writeFileSync(join(source, path), `${JSON.stringify(value, null, 2)}\n`);
      }
      const kit = join(scratch('host-plugin-licence-kit'), 'sample-kit');
      const applied = await run(['init', kit, '--from', source, '--apply', '--yes', '--json']);
      expect(applied.exitCode, applied.stdout).toBe(0);
      expect(json(readFileSync(join(kit, '.ia/release.json'), 'utf8'))['license']).toBe('UNLICENSED');
    },
  );
  it('judges a licence by the SPDX License List, not by its spelling', () => {
    for (const id of ['Apache-2.0', 'MIT', '0BSD', 'GPL-2.0', 'LicenseRef-Acme-1'])
      expect(loweredLicense(id), id).toBe(id);
    for (const other of ['Proprietary', 'MIT OR Apache-2.0', 'Apache2', 'mit', '', 'LicenseRef-'])
      expect(loweredLicense(other), other).toBe('UNLICENSED');
    expect(loweredLicense(null)).toBe('UNLICENSED');
  });
  it('admits authored trigger records beside the lowered ones without breaking the fixed point (item 17)', async () => {
    const kit = await lowered();
    writeFileSync(
      join(kit, '.ia/src/systems/sample-kit/records/triggers.ia'),
      [
        '#! ia 1.0',
        '',
        '@contract sample-guide-triggers',
        '  version "0.1.0"',
        '  meaning',
        '    says "When the sample-guide skill is invoked."',
        '    answers "Does the skill trigger on sample-method questions and not on adjacent work?"',
        '  invariants',
        '    REQ-SAMPLE-01 "The sample-guide skill is invoked for sample-method questions and not for adjacent work."',
        '  relationships',
        '    governs @capability sample-guide',
        '',
        '@case sample-guide-t-01',
        '  meaning',
        '    says "Trigger case sample-guide-t-01."',
        '    answers "Does the skill trigger on this request?"',
        '  scenario',
        '    kind success',
        '    given "A fresh session with the plugin loaded."',
        '    request "When does a fixture need a model-invocable skill?"',
        '    expected "invokes sample-plugin:sample-guide"',
        '    evaluator "eval-triggers.mjs"',
        '  relationships',
        '    implements @contract sample-guide-triggers#REQ-SAMPLE-01',
        '',
        '@case sample-guide-n-01',
        '  meaning',
        '    says "Trigger case sample-guide-n-01."',
        '    answers "Does the skill stay silent on this request?"',
        '  scenario',
        '    kind refusal',
        '    given "A fresh session with the plugin loaded."',
        '    request "Fix the failing build in my web app."',
        '    expected "does not invoke it"',
        '    evaluator "eval-triggers.mjs"',
        '  relationships',
        '    implements @contract sample-guide-triggers#REQ-SAMPLE-01',
        '',
      ].join('\n'),
    );
    const validated = await validate(kit);
    expect(validated.exitCode, validated.stdout).toBe(0);
    expect(json(validated.stdout)['ok'] ?? true).toBe(true);
    const result = await run([
      'project',
      'claude',
      '--product',
      'plugin',
      '--check',
      '--compare',
      SAMPLE,
      '--root',
      kit,
      '--json',
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
  });
});
