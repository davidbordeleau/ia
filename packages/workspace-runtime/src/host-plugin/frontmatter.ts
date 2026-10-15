import { HostPluginError } from './errors.js';

/** One frontmatter value in the strict subset lowering admits; anything else is unresolved, never guessed. */
export type FrontValue =
  | { readonly kind: 'string'; readonly text: string; readonly style: 'plain' | 'double' | 'single' }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'list'; readonly items: readonly string[] };
export interface FrontField {
  readonly key: string;
  readonly value: FrontValue;
}
export interface Frontmatter {
  readonly fields: readonly FrontField[];
  /** Every byte after the closing `---` line, unchanged. */
  readonly body: Buffer;
  readonly unresolved: readonly string[];
}

const KEY = /^[a-z][a-z0-9-]*$/;
const RESERVED = /^(?:true|false|yes|no|on|off|null|~)$/i;
const NUMERIC = /^[-+.]?\d/;
const INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;
const control = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** A string YAML reads back unchanged as a one-line plain scalar. */
export function isPlain(text: string): boolean {
  return (
    text.length > 0 &&
    text === text.trim() &&
    !control(text) &&
    !INDICATOR.test(text) &&
    !text.includes(': ') &&
    !text.includes(' #') &&
    !text.endsWith(':') &&
    !RESERVED.test(text) &&
    !NUMERIC.test(text)
  );
}

function parseValue(raw: string): FrontValue | null {
  if (raw === 'true' || raw === 'false') return { kind: 'boolean', value: raw === 'true' };
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      // Only the canonical spelling is admitted: trailing text or non-canonical escapes would not regenerate byte-exact.
      return typeof parsed === 'string' && JSON.stringify(parsed) === raw
        ? { kind: 'string', text: parsed, style: 'double' }
        : null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) return null;
    const inner = raw.slice(1, -1);
    if (inner.replaceAll("''", '').includes("'")) return null;
    return { kind: 'string', text: inner.replaceAll("''", "'"), style: 'single' };
  }
  if (raw.startsWith('[')) {
    if (!raw.endsWith(']')) return null;
    const inner = raw.slice(1, -1).trim();
    const items = inner === '' ? [] : inner.split(',').map((item) => item.trim());
    return items.every(isPlain) ? { kind: 'list', items } : null;
  }
  return isPlain(raw) ? { kind: 'string', text: raw, style: 'plain' } : null;
}

const only = (bytes: Buffer, reason: string): Frontmatter => ({ fields: [], body: bytes, unresolved: [reason] });

export function parseFrontmatter(bytes: Buffer, path: string): Frontmatter {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return only(bytes, `${path}: not UTF-8`);
  if (text.charCodeAt(0) === 0xfeff) return only(bytes, `${path}: a byte-order mark precedes the frontmatter`);
  if (text.includes('\r')) return only(bytes, `${path}: CRLF line endings; lowering keeps bytes exact and needs LF`);
  if (!text.startsWith('---\n')) return { fields: [], body: bytes, unresolved: [] };
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) return only(bytes, `${path}: the frontmatter has no closing --- line`);
  const fields: FrontField[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();
  // An empty block (`---\n---\n`) has no lines; `''.split('\n')` would otherwise yield one bogus empty line.
  const lines = end === 3 ? [] : text.slice(4, end).split('\n');
  for (const line of lines) {
    const colon = line.indexOf(':');
    const key = colon < 0 ? '' : line.slice(0, colon);
    if (!KEY.test(key) || line[colon + 1] !== ' ') {
      unresolved.push(`${path}: unsupported frontmatter line ${JSON.stringify(line)}`);
      continue;
    }
    if (seen.has(key)) {
      unresolved.push(`${path}: duplicate frontmatter key ${key}`);
      continue;
    }
    seen.add(key);
    const value = parseValue(line.slice(colon + 2));
    if (value === null) unresolved.push(`${path}: unsupported value for ${key}`);
    else fields.push(Object.freeze({ key, value: Object.freeze(value) }));
  }
  const body = bytes.subarray(Buffer.byteLength(text.slice(0, end + 5), 'utf8'));
  return Object.freeze({ fields: Object.freeze(fields), body, unresolved: Object.freeze(unresolved) });
}

export function sameValue(a: FrontValue, b: FrontValue): boolean {
  if (a.kind === 'boolean' && b.kind === 'boolean') return a.value === b.value;
  if (a.kind === 'list' && b.kind === 'list') return JSON.stringify(a.items) === JSON.stringify(b.items);
  if (a.kind === 'string' && b.kind === 'string') return a.text === b.text;
  return false;
}

function emitValue(value: FrontValue): string {
  if (value.kind === 'boolean') return String(value.value);
  if (value.kind === 'list') {
    if (!value.items.every(isPlain))
      throw new HostPluginError('IA-PROJECT-FEATURE', 'A list item is not a plain scalar');
    return `[${value.items.join(', ')}]`;
  }
  return isPlain(value.text) ? value.text : JSON.stringify(value.text);
}

/** `---`, one `key: value` line per field in the order given, `---`; the caller appends the body bytes. */
export function emitFrontmatter(fields: readonly FrontField[]): string {
  return ['---', ...fields.map(({ key, value }) => `${key}: ${emitValue(value)}`), '---', ''].join('\n');
}
