import type { ChildNode, FieldNode, RecordNode } from '../ast.js';
import { format } from '../formatter.js';
import { parse } from '../parser/index.js';
import { verbOf } from '../semantic/vocabulary.js';
import { encodeItem, encodeValue } from './values.js';
import type { DraftSchema } from './values.js';

const PATH = 'edit.ia';
function normalized(text: string): string {
  const result = format(text, PATH);
  if (result.text === null) throw new Error(result.diagnostics.map(d => d.message).join('\n'));
  return result.text;
}
function recordAt(text: string, identity: string): RecordNode {
  const parsed = parse(text, PATH);
  if (parsed.diagnostics.length) throw new Error('Source must parse before editing');
  const reference = /^@([a-z][a-z0-9-]*) ([A-Za-z][A-Za-z0-9-]*)$/.exec(identity);
  const name = reference?.[2] ?? identity.split('/').at(-1);
  const all = (records: readonly RecordNode[]): RecordNode[] => records.flatMap(r => [r, ...all(r.nested)]);
  const matches = all(parsed.ast.records).filter(r => r.name.toLowerCase() === name?.toLowerCase() && (!reference || r.discriminator === reference[1]));
  if (matches.length !== 1) throw new Error('Expected one record for the edit identity');
  return matches[0]!;
}
function insert(text: string, record: RecordNode, section: string, row: string): string {
  const lines = text.split('\n');
  const block = record.sections.find(s => s.name === section);
  const indent = /^ */.exec(lines[record.span.line - 1]!)![0];
  if (block) lines.splice(block.span.endLine, 0, `${indent}    ${row}`);
  else if (section === 'head') lines.splice(record.span.line, 0, `${indent}  ${row}`);
  else lines.splice(record.span.endLine, 0, `${indent}  ${section}`, `${indent}    ${row}`);
  return normalized(lines.join('\n'));
}
/** A complete standalone draft, including its pragma, appended to a whole source file. */
export function appendRecord(text: string, draft: string): string {
  const parsed = parse(draft, PATH);
  if (parsed.diagnostics.length || parsed.ast.records.length !== 1) throw new Error('Expected one standalone record draft');
  const before = text === '' ? '#! ia 1.0\n' : normalized(text);
  return normalized(`${before.trimEnd()}\n\n${draft.replace(/^\uFEFF?#! ia [^\n]+\r?\n/, '').trim()}\n`);
}
export function addRelationship(text: string, identity: string, spelling: string, target: string): string {
  if (!verbOf(spelling)) throw new Error('Unknown relationship spelling');
  if (!/^@[a-z][a-z0-9-]* [A-Za-z][A-Za-z0-9-]*(?:#[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)*)?$/.test(target) &&
      !/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[^\s/#]+\/[A-Za-z][A-Za-z0-9-]*(?:#[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)*)?$/.test(target))
    throw new Error('Expected a canonical identity or @word name target');
  const source = normalized(text), record = recordAt(source, identity);
  const row = `${spelling} ${target}`;
  const block = record.sections.filter(s => s.name === 'relationships');
  if (block.length > 1) throw new Error('Repeated relationships section');
  if (block[0] && source.split('\n').slice(block[0].span.line, block[0].span.endLine).some(line => line.trim() === row))
    throw new Error('Duplicate relationship');
  return insert(source, record, 'relationships', row);
}
export function setField(text: string, identity: string, path: string, value: string, schema: DraftSchema, append = false): string {
  const field = schema.fields.find(f => `${f.section}.${f.key}` === path);
  if (!field) throw new Error(`Undeclared schema field: ${path}`);
  if (append && !field.type.startsWith('list of ')) throw new Error('Append requires a list field');
  const source = normalized(text), record = recordAt(source, identity);
  const blocks = record.sections.filter(s => s.name === field.section);
  if (blocks.length > 1) throw new Error('Repeated section');
  const children: readonly ChildNode[] = field.section === 'head' ? record.head : blocks[0]?.children ?? [];
  const fields = children.filter((c): c is FieldNode => c.kind === 'field' && c.words.slice(0, field.key.split(' ').length).join(' ') === field.key);
  if (fields.length > 1) throw new Error('Repeated field key');
  const previous = fields[0];
  if (previous && (previous.when || previous.children.length)) throw new Error('Cannot overwrite a conditional or structured field');
  let encoded = encodeValue(field, value, append);
  if (append) {
    if (previous && previous.value.kind !== 'list') throw new Error('Append requires an inline list');
    const items = previous?.value.kind === 'list' ? previous.value.items.map(i => encodeItem(field, i)) : [];
    if (items.includes(encoded)) throw new Error('Duplicate list value');
    encoded = `[${[...items, encoded].join(', ')}]`;
  }
  const row = `${field.key} ${encoded}`;
  if (!previous) return insert(source, record, field.section, row);
  const lines = source.split('\n'), indent = /^ */.exec(lines[previous.span.line - 1]!)![0];
  lines.splice(previous.span.line - 1, previous.span.endLine - previous.span.line + 1, `${indent}${row}`);
  return normalized(lines.join('\n'));
}
