import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emitFrontmatter, isPlain, parseFrontmatter, sameValue } from '../src/host-plugin/frontmatter.js';
import { comparePlugin } from '../src/host-plugin/compare.js';
import { readEntries, readPlugin } from '../src/host-plugin/inventory.js';
import { lowerPlugin } from '../src/host-plugin/lower.js';

const b = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('frontmatter (A4)', () => {
  it('reads plain, double-quoted, boolean and list values and keeps the body bytes', () => {
    const source =
      '---\nname: audit\ndescription: "Use when: a game feels flat"\ndisable-model-invocation: true\ntools: [Read, Grep]\n---\n\nBody line\n';
    const parsed = parseFrontmatter(b(source), 'skills/audit/SKILL.md');
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.fields).toEqual([
      { key: 'name', value: { kind: 'string', text: 'audit', style: 'plain' } },
      {
        key: 'description',
        value: {
          kind: 'string',
          text: 'Use when: a game feels flat',
          style: 'double',
        },
      },
      {
        key: 'disable-model-invocation',
        value: { kind: 'boolean', value: true },
      },
      { key: 'tools', value: { kind: 'list', items: ['Read', 'Grep'] } },
    ]);
    expect(parsed.body.toString('utf8')).toBe('\nBody line\n');
  });
  it('writes back the same bytes for plain and necessarily quoted values', () => {
    const source = '---\nname: audit\nargument-hint: "[rules] [decision]"\n---\n';
    const parsed = parseFrontmatter(b(source), 'x');
    expect(emitFrontmatter(parsed.fields) + parsed.body.toString('utf8')).toBe(source);
  });
  it('lists CRLF and a byte-order mark as unresolved instead of normalizing them', () => {
    const crlf = parseFrontmatter(b('---\r\nname: a\r\n---\r\n'), 'skills/a/SKILL.md');
    expect(crlf.unresolved[0]).toContain('CRLF');
    const bom = parseFrontmatter(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b('---\nname: a\n---\n')]), 'p');
    expect(bom.unresolved[0]).toContain('byte-order mark');
  });
  it('lists block scalars, nested maps and duplicate keys as unresolved and never drops them silently', () => {
    const parsed = parseFrontmatter(b('---\ndescription: >\n  folded\nname: a\nname: b\n---\n'), 'p');
    expect(parsed.unresolved).toHaveLength(3);
    expect(parsed.fields.map((field) => field.key)).toEqual(['name']);
  });
  it('treats YAML-significant text as not plain', () => {
    for (const text of ['true', '12', '[x]', 'a: b', 'a #b', '-x', ' padded']) expect(isPlain(text)).toBe(false);
    for (const text of ['Read, Grep, Glob', "isn't it", 'Use when a game feels flat.'])
      expect(isPlain(text)).toBe(true);
  });
  it('lists non-UTF-8 bytes as unresolved instead of throwing', () => {
    const bytes = Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]);
    let parsed: ReturnType<typeof parseFrontmatter> | undefined;
    expect(() => {
      parsed = parseFrontmatter(bytes, 'skills/a/SKILL.md');
    }).not.toThrow();
    expect(parsed?.unresolved[0]).toContain('not UTF-8');
    expect(parsed?.fields).toEqual([]);
  });
  it('lists double-quoted values with trailing text or non-canonical escapes as unresolved', () => {
    const trailing = parseFrontmatter(b('---\nname: "a"  \n---\n'), 'p');
    expect(trailing.unresolved).toHaveLength(1);
    expect(trailing.fields).toEqual([]);
    const escaped = parseFrontmatter(b('---\ndescription: "a\\/b"\n---\n'), 'p');
    expect(escaped.unresolved).toHaveLength(1);
    expect(escaped.fields).toEqual([]);
  });
  it('reads an empty frontmatter block as zero fields and keeps the body', () => {
    const parsed = parseFrontmatter(b('---\n---\nbody\n'), 'p');
    expect(parsed.fields).toEqual([]);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.body.toString('utf8')).toBe('body\n');
    const back = parseFrontmatter(b(emitFrontmatter([]) + 'body\n'), 'p');
    expect(back.fields).toEqual([]);
    expect(back.unresolved).toEqual([]);
    expect(back.body.toString('utf8')).toBe('body\n');
  });
  it('compares values by kind and content, not by style', () => {
    const plain = { kind: 'string', text: 'a', style: 'plain' } as const;
    const double = { kind: 'string', text: 'a', style: 'double' } as const;
    expect(sameValue(plain, double)).toBe(true);
    expect(sameValue(plain, { kind: 'boolean', value: true })).toBe(false);
    expect(sameValue(plain, { kind: 'list', items: ['a'] })).toBe(false);
    expect(sameValue({ kind: 'list', items: ['a'] }, { kind: 'boolean', value: false })).toBe(false);
    expect(sameValue({ kind: 'list', items: ['a', 'b'] }, { kind: 'list', items: ['a', 'b'] })).toBe(true);
    expect(sameValue({ kind: 'boolean', value: true }, { kind: 'boolean', value: false })).toBe(false);
  });
});

const SAMPLE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../tools/projections/fixtures/host-plugin/sample',
);
const copy = (): string => {
  const target = join(mkdtempSync(join(tmpdir(), 'ia-host-plugin-')), 'sample');
  cpSync(SAMPLE, target, { recursive: true });
  return target;
};

describe('plugin inventory (A5)', () => {
  it('classifies manifests, skills with their owned files, agents and other files', () => {
    const inventory = readPlugin(SAMPLE);
    expect(Object.keys(inventory.manifests).sort()).toEqual(['claude', 'codex', 'grok']);
    expect(inventory.skills.map((skill) => [skill.name, skill.owned.map((entry) => entry.path)])).toEqual([
      ['sample-guide', ['skills/sample-guide/assets/templates/card.md', 'skills/sample-guide/references/guide.md']],
      ['sample-run', []],
    ]);
    expect(inventory.agents.map((agent) => agent.name)).toEqual(['sample-reader']);
    expect(inventory.other.map((entry) => entry.path)).toEqual([
      'CODEX.md',
      'LICENSE',
      'README.md',
      'tests/sample.check.mjs',
    ]);
    expect(inventory.unresolved).toEqual([]);
  });
  it('lists hooks and commands as unresolved', () => {
    const root = copy();
    mkdirSync(join(root, 'hooks'));
    writeFileSync(join(root, 'hooks/hooks.json'), '{}\n');
    mkdirSync(join(root, 'commands'));
    writeFileSync(join(root, 'commands/x.md'), 'x\n');
    expect(readPlugin(root).unresolved).toHaveLength(2);
  });
  it('refuses a symbolic link', () => {
    const linked = copy();
    try {
      symlinkSync(join(linked, 'README.md'), join(linked, 'LINK.md'));
    } catch {
      return; // Windows without symlink privilege: only this test is skipped
    }
    expect(() => readPlugin(linked)).toThrow(/symbolic link/);
  });
  it('refuses a .git file (linked worktree) before reading on', () => {
    const git = copy();
    writeFileSync(join(git, '.git'), 'gitdir: /elsewhere\n');
    expect(() => readPlugin(git)).toThrow(/not plugin content/);
  });
  it('refuses a .git directory before reading on', () => {
    const git = copy();
    mkdirSync(join(git, '.git'));
    expect(() => readPlugin(git)).toThrow(/not plugin content/);
  });
});

describe('lowering (A6)', () => {
  it('lowers the sample into records, byte-exact resources and assets, with no unresolved entry', () => {
    const plan = lowerPlugin(readPlugin(SAMPLE), 'sample-kit');
    expect(plan.unresolved).toEqual([]);
    const paths = plan.files.map((file) => file.path);
    expect(paths).toEqual([
      '.ia/authoring.resources.json',
      '.ia/src/systems/sample-kit/plugin/agents/sample-reader.body.md',
      '.ia/src/systems/sample-kit/plugin/skills/sample-guide/SKILL.body.md',
      '.ia/src/systems/sample-kit/plugin/skills/sample-guide/assets/templates/card.md',
      '.ia/src/systems/sample-kit/plugin/skills/sample-guide/references/guide.md',
      '.ia/src/systems/sample-kit/plugin/skills/sample-run/SKILL.body.md',
      '.ia/src/systems/sample-kit/records/plugin.ia',
      '.ia/src/systems/sample-kit/system.ia',
      'assets/MIGRATION.md',
      'assets/lowering-map.json',
      'assets/plugin/CODEX.md',
      'assets/plugin/LICENSE',
      'assets/plugin/README.md',
      'assets/plugin/tests/sample.check.mjs',
    ]);
    const body = plan.files.find((file) => file.path.endsWith('sample-run/SKILL.body.md'))!;
    expect(body.bytes.toString('utf8')).toBe('\nRun the sample method on $ARGUMENTS.\n');
    const records = plan.files.find((file) => file.path.endsWith('records/plugin.ia'))!.bytes.toString('utf8');
    expect(records).toContain('@capability sample-run');
    expect(records).toContain('    mode user\n    argument-hint "[target]"');
    expect(records).toContain('@agent-profile sample-reader');
    expect(records.slice(records.indexOf('@agent-profile sample-reader'))).toContain('  invocation\n    mode model');
    expect(records).toContain('    hosts [claude, codex, grok]');
    expect(plan.assets).toEqual([
      { path: 'assets/MIGRATION.md', role: 'documentation' },
      { path: 'assets/lowering-map.json', role: 'asset' },
      { path: 'assets/plugin/CODEX.md', role: 'documentation' },
      { path: 'assets/plugin/LICENSE', role: 'license' },
      { path: 'assets/plugin/README.md', role: 'documentation' },
      { path: 'assets/plugin/tests/sample.check.mjs', role: 'asset' },
    ]);
  });
  it('is deterministic', () => {
    const one = lowerPlugin(readPlugin(SAMPLE), 'sample-kit'),
      two = lowerPlugin(readPlugin(copy()), 'sample-kit');
    expect(two.files.map((f) => [f.path, f.bytes.toString('base64')])).toEqual(
      one.files.map((f) => [f.path, f.bytes.toString('base64')]),
    );
  });
  it('lists a double quote in a description and an unknown frontmatter key as unresolved', () => {
    const root = copy();
    writeFileSync(
      join(root, 'skills/sample-run/SKILL.md'),
      '---\nname: sample-run\ndescription: Say "hi".\nmodel: haiku\n---\nx\n',
    );
    const plan = lowerPlugin(readPlugin(root), 'sample-kit');
    expect(plan.unresolved.join('\n')).toMatch(/double quote/);
    expect(plan.unresolved.join('\n')).toMatch(/model/);
  });
  it('lists an agent whose tools match no effect as unresolved', () => {
    const root = copy();
    writeFileSync(
      join(root, 'agents/sample-reader.md'),
      '---\nname: sample-reader\ndescription: Edit.\ntools: Edit\n---\nx\n',
    );
    expect(lowerPlugin(readPlugin(root), 'sample-kit').unresolved.join('\n')).toMatch(/tools Edit/);
  });
  it('lists an unquoted list-form argument-hint as unresolved instead of dropping it', () => {
    const root = copy();
    writeFileSync(
      join(root, 'skills/sample-run/SKILL.md'),
      '---\nname: sample-run\ndescription: Run it.\nargument-hint: [issue-number]\n---\nx\n',
    );
    expect(lowerPlugin(readPlugin(root), 'sample-kit').unresolved.join('\n')).toMatch(/argument-hint/);
  });
  it('lists a null author and a non-string version as unresolved without throwing', () => {
    const root = copy();
    const manifest = join(root, '.claude-plugin/plugin.json');
    writeFileSync(manifest, JSON.stringify({ name: 'sample-plugin', author: null, version: 1 }));
    let unresolved: readonly string[] = [];
    expect(() => {
      unresolved = lowerPlugin(readPlugin(root), 'sample-kit').unresolved;
    }).not.toThrow();
    expect(unresolved.join('\n')).toMatch(/author must be/);
    expect(unresolved.join('\n')).toMatch(/version must be a string/);
  });
  it('lists a CRLF reference and a byte-order-marked README as unresolved, naming each', () => {
    const root = copy();
    writeFileSync(join(root, 'skills/sample-guide/references/guide.md'), 'one\r\ntwo\r\n');
    writeFileSync(join(root, 'README.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# hi\n')]));
    const text = lowerPlugin(readPlugin(root), 'sample-kit').unresolved.join('\n');
    expect(text).toMatch(/references[/]guide[.]md: has CR line endings/);
    expect(text).toMatch(/README[.]md: has a byte-order mark/);
  });
  it('lists an agent model that is not an IA id as unresolved', () => {
    const root = copy();
    writeFileSync(
      join(root, 'agents/sample-reader.md'),
      '---\nname: sample-reader\ndescription: Read.\ntools: Read, Grep, Glob\nmodel: opus[1m]\n---\nx\n',
    );
    expect(lowerPlugin(readPlugin(root), 'sample-kit').unresolved.join('\n')).toMatch(
      /model "opus\[1m\]" is not an IA id/,
    );
  });
  it('does not report a skill and an agent of one name as colliding', () => {
    const root = copy();
    mkdirSync(join(root, 'skills/x'));
    writeFileSync(join(root, 'skills/x/SKILL.md'), '---\nname: x\ndescription: Skill x.\n---\nx\n');
    writeFileSync(join(root, 'agents/x.md'), '---\nname: x\ndescription: Agent x.\ntools: Read, Grep, Glob\n---\nx\n');
    expect(lowerPlugin(readPlugin(root), 'sample-kit').unresolved.join('\n')).not.toMatch(/collides/);
  });
  it('refuses a system name that is not portable', () => {
    expect(() => lowerPlugin(readPlugin(SAMPLE), 'Bad Name')).toThrow(/portable system name/);
  });
});

describe('compare (A10)', () => {
  const entries = readEntries(SAMPLE);
  const as = (path: string, text: string) => ({
    path,
    bytes: Buffer.from(text),
  });
  it('marks identical bytes identical and a reformatted manifest as manifest-format', () => {
    const rendered = entries.map((e) =>
      e.path === '.claude-plugin/plugin.json'
        ? {
            path: e.path,
            bytes: Buffer.from(JSON.stringify(JSON.parse(e.bytes.toString('utf8')))),
          }
        : e,
    );
    const diffs = comparePlugin(entries, rendered);
    expect(diffs.find((d) => d.path === '.claude-plugin/plugin.json')).toMatchObject({
      status: 'ruled',
      rules: ['manifest-format'],
    });
    expect(diffs.filter((d) => d.status === 'identical')).toHaveLength(entries.length - 1);
  });
  it('names scalar style and tool order, and calls a changed body drift', () => {
    const agent = 'agents/sample-reader.md';
    // The original is styled by hand; the rendered side is the emitter's form.
    const original = entries.map((e) =>
      e.path === agent
        ? as(
            agent,
            '---\nname: "sample-reader"\ndescription: Read the supplied target and report what it says, without editing anything.\ntools: Read, Glob, Grep\n---\n\nRead only the target you are given and report what it says.\n',
          )
        : e,
    );
    expect(comparePlugin(original, entries).find((d) => d.path === agent)).toMatchObject({
      status: 'ruled',
      rules: ['frontmatter-scalar-style', 'tool-order'],
    });
    const changed = entries.map((e) =>
      e.path === agent ? as(agent, e.bytes.toString('utf8').replace('Read only', 'Read all')) : e,
    );
    expect(comparePlugin(entries, changed).find((d) => d.path === agent)!.status).toBe('drift');
  });
});

describe('compare, fix round 1', () => {
  const entries = readEntries(SAMPLE);
  const AGENT = 'agents/sample-reader.md';
  const SKILL = 'skills/sample-run/SKILL.md';
  const text = (path: string): string => entries.find((e) => e.path === path)!.bytes.toString('utf8');
  const withFile = (path: string, next: string) =>
    entries.map((e) => (e.path === path ? { path, bytes: Buffer.from(next) } : e));
  const diffOf = (path: string, next: string) =>
    comparePlugin(entries, withFile(path, next)).find((d) => d.path === path)!;
  const agent = text(AGENT);

  it.each([
    ['an unsupported nested key', agent.replace('\n---\n', '\nmetadata:\n  owner: someone-else\n---\n')],
    ['a comment line', agent.replace('tools:', '# a comment\ntools:')],
    ['a duplicate key', agent.replace('\n---\n', '\nname: sample-reader\n---\n')],
    ['an unterminated list', agent.replace('tools: Read, Grep, Glob', 'model: [haiku')],
  ])('calls %s drift when the rendered side carries it', (_label, changed) => {
    expect(diffOf(AGENT, changed).status).toBe('drift');
  });
  it('calls unparsed content in the original drift', () => {
    const original = entries.map((e) =>
      e.path === AGENT ? { path: AGENT, bytes: Buffer.from(agent.replace('tools:', '# a comment\ntools:')) } : e,
    );
    expect(comparePlugin(original, entries).find((d) => d.path === AGENT)).toMatchObject({
      status: 'drift',
      reason: expect.stringContaining('# a comment'),
    });
  });
  it('calls a changed unterminated list and a respaced list drift', () => {
    const open = (value: string) => agent.replace('tools: Read, Grep, Glob', `model: ${value}`);
    const original = entries.map((e) => (e.path === AGENT ? { path: AGENT, bytes: Buffer.from(open('[opus')) } : e));
    const rendered = withFile(AGENT, open('[haiku'));
    expect(comparePlugin(original, rendered).find((d) => d.path === AGENT)!.status).toBe('drift');
    const tight = entries.map((e) =>
      e.path === AGENT
        ? { path: AGENT, bytes: Buffer.from(agent.replace('tools: Read, Grep, Glob', 'tools: [Read,Grep,Glob]')) }
        : e,
    );
    const spaced = withFile(AGENT, agent.replace('tools: Read, Grep, Glob', 'tools: [Read, Grep, Glob]'));
    expect(comparePlugin(tight, spaced).find((d) => d.path === AGENT)!.status).toBe('drift');
  });
  it('names frontmatter-field-order', () => {
    const swapped = agent.replace(
      /name: (.*)\ndescription: (.*)\n/,
      (_m, name: string, description: string) => `description: ${description}\nname: ${name}\n`,
    );
    expect(diffOf(AGENT, swapped)).toMatchObject({ status: 'ruled', rules: ['frontmatter-field-order'] });
  });
  it('names frontmatter-default-omitted', () => {
    const original = entries.map((e) =>
      e.path === SKILL
        ? { path: SKILL, bytes: Buffer.from(text(SKILL).replace('\n---\n', '\nuser-invocable: true\n---\n')) }
        : e,
    );
    expect(comparePlugin(original, entries).find((d) => d.path === SKILL)).toMatchObject({
      status: 'ruled',
      rules: ['frontmatter-default-omitted'],
    });
  });
  it('names codex-hooks-suppressed', () => {
    const codex = '.codex-plugin/plugin.json';
    const parsed = JSON.parse(text(codex)) as Record<string, unknown>;
    expect(parsed['hooks']).toEqual({ hooks: {} });
    const { hooks: _hooks, ...without } = parsed;
    const original = entries.map((e) =>
      e.path === codex ? { path: codex, bytes: Buffer.from(JSON.stringify(without, null, 2) + '\n') } : e,
    );
    expect(comparePlugin(original, entries).find((d) => d.path === codex)).toMatchObject({
      status: 'ruled',
      rules: ['codex-hooks-suppressed', 'manifest-format'],
    });
  });
  it('applies the tools rule to a pure reorder only', () => {
    const tools = (value: string) => agent.replace('tools: Read, Grep, Glob', `tools: ${value}`);
    const base = (value: string) =>
      entries.map((e) => (e.path === AGENT ? { path: AGENT, bytes: Buffer.from(tools(value)) } : e));
    const status = (from: string, to: string) =>
      comparePlugin(base(from), withFile(AGENT, tools(to))).find((d) => d.path === AGENT)!.status;
    expect(status('Read, Grep, Glob', 'Glob, Grep, Read')).toBe('ruled');
    expect(status('false', '[]')).toBe('drift');
    expect(status('Read, Grep', '[Read, Grep]')).toBe('drift');
    expect(status('Read,Grep', 'Read, Grep')).toBe('drift');
    expect(status('Read, Grep', 'Read, Glob')).toBe('drift');
  });
  it('calls an invalid manifest drift instead of throwing', () => {
    const claude = '.claude-plugin/plugin.json';
    const original = entries.map((e) => (e.path === claude ? { path: claude, bytes: Buffer.from('{ not json') } : e));
    expect(comparePlugin(original, entries).find((d) => d.path === claude)).toMatchObject({
      status: 'drift',
      reason: 'manifest is not JSON',
    });
  });
  it('reports missing and extra files', () => {
    const rendered = entries.filter((e) => e.path !== 'LICENSE').concat({ path: 'stray.txt', bytes: Buffer.from('x') });
    const diffs = comparePlugin(entries, rendered);
    expect(diffs.find((d) => d.path === 'LICENSE')!.status).toBe('missing');
    expect(diffs.find((d) => d.path === 'stray.txt')!.status).toBe('extra');
  });
});
