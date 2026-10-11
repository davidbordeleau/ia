import type { ListItem, Value } from '../ast.js';
import { parse } from '../parser/index.js';
import type { SchemaField, SchemaSection } from '../registry/types.js';
import { isId } from '../taxonomy.js';

export interface DraftSchema {
  readonly sections: readonly Pick<SchemaSection, 'name' | 'must'>[];
  readonly fields: readonly Pick<SchemaField, 'section' | 'key' | 'type' | 'must' | 'values' | 'target' | 'form'>[];
}
export type DraftField = DraftSchema['fields'][number];
export const quotedText = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

function inlineValue(text: string): Value {
  const parsed = parse(`#! ia 1.0\n@schema probe\n  value ${text}\n`, 'value.ia');
  const field = parsed.ast.records[0]?.head[0];
  if (parsed.diagnostics.length || !field || field.when || parsed.ast.records[0]!.head.length !== 1)
    throw new Error('Expected one unconditional typed value');
  return field.value;
}
function scalar(field: DraftField, value: Value): string {
  const type = field.type.replace(/^list of /, '');
  if (type === 'text' && (value.kind === 'string' || value.kind === 'scalar')) {
    if (field.form === 'iso-date' && !/^\d{4}-\d{2}-\d{2}$/.test(value.text)) throw new Error('Expected an ISO date');
    return quotedText(value.text);
  }
  if (type === 'ref' && value.kind === 'ref') {
    if (field.target && value.discriminator !== field.target) throw new Error(`Expected a reference to ${field.target}`);
    return value.raw;
  }
  if (value.kind !== 'scalar') throw new Error(`Expected ${type}`);
  const text = value.text;
  if (type === 'id' && isId(text) && (!field.values || field.values.includes(text))) return text;
  if (type === 'qname' && /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/.test(text)) return text;
  if (type === 'number' && /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) && Number.isFinite(Number(text))) return text;
  if (type === 'flag' && ['true', 'false'].includes(text)) return text;
  throw new Error(`Expected ${type}${field.values ? ` in [${field.values.join(', ')}]` : ''}`);
}
/** Form strings are data. Structural types accept exactly their canonical IA value grammar. */
export function encodeValue(field: DraftField, text: string, item = false): string {
  if (typeof text !== 'string' || /[\r\n]/.test(text)) throw new Error('Form fields must be single-line');
  if (field.type === 'text') return scalar(field, { kind: 'string', text, raw: quotedText(text) });
  const value = inlineValue(text);
  // A trailing comment would otherwise be silently discarded by the parser.
  const normalized = text.trim();
  if (value.kind === 'ref' && normalized !== value.raw) throw new Error('Expected one reference without trailing syntax');
  if (value.kind === 'scalar' && normalized !== value.text) throw new Error('Expected one scalar without trailing syntax');
  if (field.type.startsWith('list of ') && !item) {
    if (value.kind !== 'list') throw new Error('Expected a bracketed list');
    const items = value.items.map(v => scalar(field, v));
    if (new Set(items).size !== items.length) throw new Error('Duplicate list value');
    // Lists also reject comments: they are input data, not a source editor.
    if (parse(`#! ia 1.0\n@schema probe\n  value ${text}\n`, 'value.ia').ast.trivia.some(t => t.kind === 'comment'))
      throw new Error('Expected a list without comments');
    return `[${items.join(', ')}]`;
  }
  return scalar(field, value);
}
export function encodeItem(field: DraftField, item: ListItem): string {
  return scalar(field, item);
}
