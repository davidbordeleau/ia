import { isDeepStrictEqual } from 'node:util';
import { parseFrontmatter, sameValue } from './frontmatter.js';
import { MANIFESTS, type PluginEntry } from './inventory.js';

export const DIFF_RULES = [
  'frontmatter-scalar-style',
  'frontmatter-field-order',
  'frontmatter-default-omitted',
  'tool-order',
  'manifest-format',
  'codex-hooks-suppressed',
] as const;
export type DiffRule = (typeof DIFF_RULES)[number];
export interface FileDiff {
  readonly path: string;
  readonly status: 'identical' | 'ruled' | 'drift' | 'missing' | 'extra';
  readonly rules: readonly DiffRule[];
  readonly reason: string | null;
}
const DEFAULTS: Readonly<Record<string, string>> = {
  'disable-model-invocation': 'false',
  'user-invocable': 'true',
};
const isFrontmatterFile = (path: string): boolean =>
  /^skills\/[^/]+\/SKILL\.md$/.test(path) || /^agents\/[^/]+\.md$/.test(path);

function manifestDiff(path: string, a: Buffer, b: Buffer): FileDiff {
  const before = JSON.parse(a.toString('utf8')) as Record<string, unknown>;
  const after = JSON.parse(b.toString('utf8')) as Record<string, unknown>;
  if (isDeepStrictEqual(before, after)) return { path, status: 'ruled', rules: ['manifest-format'], reason: null };
  if (path === MANIFESTS.codex && before['hooks'] === undefined) {
    const { hooks, ...rest } = after;
    if (isDeepStrictEqual(hooks, { hooks: {} }) && isDeepStrictEqual(before, rest))
      return {
        path,
        status: 'ruled',
        rules: ['codex-hooks-suppressed', 'manifest-format'],
        reason: null,
      };
  }
  return {
    path,
    status: 'drift',
    rules: [],
    reason: 'manifest content differs',
  };
}

function frontmatterDiff(path: string, a: Buffer, b: Buffer): FileDiff {
  const before = parseFrontmatter(a, path),
    after = parseFrontmatter(b, path);
  if (!before.body.equals(after.body)) return { path, status: 'drift', rules: [], reason: 'body bytes differ' };
  const rules = new Set<DiffRule>();
  const kept = before.fields.filter((field) => {
    const omitted =
      DEFAULTS[field.key] !== undefined &&
      field.value.kind === 'boolean' &&
      String(field.value.value) === DEFAULTS[field.key];
    if (omitted && !after.fields.some((f) => f.key === field.key)) rules.add('frontmatter-default-omitted');
    return !(omitted && !after.fields.some((f) => f.key === field.key));
  });
  if (kept.map((f) => f.key).join() !== after.fields.map((f) => f.key).join()) {
    if ([...kept.map((f) => f.key)].sort().join() !== [...after.fields.map((f) => f.key)].sort().join())
      return {
        path,
        status: 'drift',
        rules: [],
        reason: 'frontmatter keys differ',
      };
    rules.add('frontmatter-field-order');
  }
  for (const field of kept) {
    const other = after.fields.find((f) => f.key === field.key)!;
    if (sameValue(field.value, other.value)) {
      if (field.value.kind === 'string' && other.value.kind === 'string' && field.value.style !== other.value.style)
        rules.add('frontmatter-scalar-style');
      continue;
    }
    const list = (v: typeof field.value): string[] =>
      v.kind === 'string' ? v.text.split(',').map((t) => t.trim()) : v.kind === 'list' ? [...v.items] : [];
    if (field.key === 'tools' && [...list(field.value)].sort().join() === [...list(other.value)].sort().join()) {
      rules.add('tool-order');
      if (field.value.kind === 'string' && other.value.kind === 'string' && field.value.style !== other.value.style)
        rules.add('frontmatter-scalar-style');
      continue;
    }
    return {
      path,
      status: 'drift',
      rules: [],
      reason: `frontmatter ${field.key} differs`,
    };
  }
  return {
    path,
    status: 'ruled',
    rules: DIFF_RULES.filter((rule) => rules.has(rule)),
    reason: null,
  };
}

/** Original files against rendered ones: identical, explained by named rules, or drift. */
export function comparePlugin(
  original: readonly PluginEntry[],
  rendered: readonly { readonly path: string; readonly bytes: Buffer }[],
): FileDiff[] {
  const before = new Map(original.map((e) => [e.path, e.bytes])),
    after = new Map(rendered.map((e) => [e.path, e.bytes]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((path): FileDiff => {
    const a = before.get(path),
      b = after.get(path);
    if (b === undefined) return { path, status: 'missing', rules: [], reason: 'not rendered' };
    if (a === undefined)
      return {
        path,
        status: 'extra',
        rules: [],
        reason: 'not in the original',
      };
    if (a.equals(b)) return { path, status: 'identical', rules: [], reason: null };
    if (Object.values(MANIFESTS).includes(path)) return manifestDiff(path, a, b);
    if (isFrontmatterFile(path)) return frontmatterDiff(path, a, b);
    return { path, status: 'drift', rules: [], reason: 'bytes differ' };
  });
}
