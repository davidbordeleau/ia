import { emitFrontmatter, type FrontValue, parseFrontmatter, sameValue } from './frontmatter.js';
import { MANIFESTS, type PluginEntry } from './inventory.js';
import { sameJson } from './json.js';

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

const drift = (path: string, reason: string): FileDiff => ({ path, status: 'drift', rules: [], reason });

function manifestDiff(path: string, a: Buffer, b: Buffer): FileDiff {
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  try {
    before = JSON.parse(a.toString('utf8')) as Record<string, unknown>;
    after = JSON.parse(b.toString('utf8')) as Record<string, unknown>;
  } catch {
    return drift(path, 'manifest is not JSON');
  }
  if (sameJson(before, after)) return { path, status: 'ruled', rules: ['manifest-format'], reason: null };
  if (path === MANIFESTS.codex && before['hooks'] === undefined) {
    const { hooks, ...rest } = after;
    if (sameJson(hooks, { hooks: {} }) && sameJson(before, rest))
      return { path, status: 'ruled', rules: ['codex-hooks-suppressed', 'manifest-format'], reason: null };
  }
  return drift(path, 'manifest content differs');
}

/** The members of a tools value when it is a plain list or a comma-and-space string, else null. */
function members(value: FrontValue): string[] | null {
  if (value.kind === 'list') return [...value.items];
  if (value.kind === 'string') return value.text.split(', ');
  return null;
}

function frontmatterDiff(path: string, a: Buffer, b: Buffer): FileDiff {
  const before = parseFrontmatter(a, path),
    after = parseFrontmatter(b, path);
  const unparsed = [...before.unresolved, ...after.unresolved];
  if (unparsed.length > 0) return drift(path, `frontmatter not compared: ${unparsed[0]}`);
  if (!before.body.equals(after.body)) return drift(path, 'body bytes differ');
  if (b.toString('utf8').startsWith('---\n')) {
    const canonical = Buffer.concat([Buffer.from(emitFrontmatter(after.fields), 'utf8'), after.body]);
    if (!canonical.equals(b)) return drift(path, 'rendered frontmatter is not in the emitted form');
  }
  const rules = new Set<DiffRule>();
  const kept = before.fields.filter((field) => {
    const omitted =
      DEFAULTS[field.key] !== undefined &&
      field.value.kind === 'boolean' &&
      String(field.value.value) === DEFAULTS[field.key] &&
      !after.fields.some((f) => f.key === field.key);
    if (omitted) rules.add('frontmatter-default-omitted');
    return !omitted;
  });
  const keysBefore = kept.map((f) => f.key),
    keysAfter = after.fields.map((f) => f.key);
  if (keysBefore.join() !== keysAfter.join()) {
    if ([...keysBefore].sort().join() !== [...keysAfter].sort().join()) return drift(path, 'frontmatter keys differ');
    rules.add('frontmatter-field-order');
  }
  for (const field of kept) {
    const other = after.fields.find((f) => f.key === field.key)!;
    if (sameValue(field.value, other.value)) {
      if (field.value.kind === 'string' && other.value.kind === 'string' && field.value.style !== other.value.style)
        rules.add('frontmatter-scalar-style');
      continue;
    }
    const left = field.key === 'tools' && field.value.kind === other.value.kind ? members(field.value) : null;
    const right = left === null ? null : members(other.value);
    if (left !== null && right !== null && [...left].sort().join() === [...right].sort().join()) {
      rules.add('tool-order');
      if (field.value.kind === 'string' && other.value.kind === 'string' && field.value.style !== other.value.style)
        rules.add('frontmatter-scalar-style');
      continue;
    }
    return drift(path, `frontmatter ${field.key} differs`);
  }
  if (rules.size === 0) return drift(path, 'bytes differ and no rule explains them');
  return { path, status: 'ruled', rules: DIFF_RULES.filter((rule) => rules.has(rule)), reason: null };
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
