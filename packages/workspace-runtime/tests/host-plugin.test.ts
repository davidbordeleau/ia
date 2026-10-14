import { describe, expect, it } from 'vitest';
import { emitFrontmatter, isPlain, parseFrontmatter } from '../src/host-plugin/frontmatter.js';

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
});
