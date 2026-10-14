import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emitFrontmatter, isPlain, parseFrontmatter, sameValue } from '../src/host-plugin/frontmatter.js';
import { readPlugin } from '../src/host-plugin/inventory.js';
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
      { key: 'description', value: { kind: 'string', text: 'Use when: a game feels flat', style: 'double' } },
      { key: 'disable-model-invocation', value: { kind: 'boolean', value: true } },
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
