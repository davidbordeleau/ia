import type { ListItem, Value } from '../ast.js';
import { parse } from '../parser/index.js';
import type { SchemaField, SchemaSection } from '../registry/types.js';
import { isId, isIsoDate, isNumberText, isQualifiedName } from '../taxonomy.js';

/** The schema facts a source edit reads: a registry `SchemaDeclaration` is one. */
export interface DraftSchema {
  readonly sections: readonly Pick<SchemaSection, 'name' | 'must'>[];
  readonly fields: readonly Pick<SchemaField, 'section' | 'key' | 'type' | 'must' | 'values' | 'target' | 'form'>[];
}
export type DraftField = DraftSchema['fields'][number];

/** Why a source edit was refused. Each is a defect in the requested edit, never in the file being edited. */
export type SourceEditReason =
  /** The file does not parse, so no edit can be placed in it. */
  | 'parse'
  /** No top-level record of the file answers the identity, or the identity is not `@word name`. */
  | 'identity'
  /** The record is nested in another record; nested records are edited in their source. */
  | 'nested'
  /** The schema declares no such field. */
  | 'field'
  /** The value is not one canonical value of the field's type, or would carry syntax beyond it. */
  | 'value'
  /** The record states the section, field or record more than once, so no single place can be edited. */
  | 'repeated'
  /** The row, list item or record is already there. */
  | 'duplicate'
  /** The relationship spelling is no verb of the kernel. */
  | 'spelling'
  /** The relationship target is not a canonical identity or an `@word name` reference. */
  | 'target'
  /** The field is conditional, structured or commented inside its value, so a one-line edit would lose source. */
  | 'structure';

/** A refused source edit. The language registers no diagnostic code for it: the caller reports the refusal. */
export class SourceEditError extends Error {
  constructor(
    readonly reason: SourceEditReason,
    message: string,
  ) {
    super(message);
    this.name = 'SourceEditError';
  }
}
export const refuse = (reason: SourceEditReason, message: string): never => {
  throw new SourceEditError(reason, message);
};

/** IA strings escape only quotes and backslashes. JSON escapes would change tabs and newlines into literal text. */
export const quotedText = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * Line breaks, and the controls a terminal or a line scanner could read as structure: C0 but the tab, DEL, C1, the
 * Unicode line and paragraph separators, and the bidirectional embedding, override and isolate controls.
 */
const UNSAFE = /[\u0000-\u0008\n-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const PROBE = (text: string): string => `#! ia 1.0\n@schema probe\n  value ${text}\n`;

function inlineValue(text: string): Value {
  const parsed = parse(PROBE(text), 'value.ia');
  const record = parsed.ast.records[0];
  const field = record?.head[0];
  if (
    parsed.diagnostics.length > 0 ||
    parsed.ast.records.length !== 1 ||
    record === undefined ||
    field === undefined ||
    record.head.length !== 1 ||
    record.sections.length > 0 ||
    field.when !== undefined ||
    field.assertive === true ||
    field.children.length > 0 ||
    // The key, then the scalar's one word; a string, list or reference leaves the key as the only word.
    field.words.length !== (field.value.kind === 'scalar' ? 2 : 1)
  )
    refuse('value', `Expected one unconditional value; got ${JSON.stringify(text)}`);
  if (parsed.ast.trivia.some((trivia) => trivia.kind === 'comment'))
    refuse('value', `Expected a value without a comment; got ${JSON.stringify(text)}`);
  return field!.value;
}

const path = (field: DraftField): string => `${field.section}.${field.key}`;
/**
 * One canonical scalar spelling of `value` for the field's item type, by the predicates compliance applies to it: an id,
 * qname or number may be quoted, as compliance admits, and is spelled bare.
 */
function scalar(field: DraftField, value: Value): string {
  const type = field.type.replace(/^list of /, '');
  const expected = (what: string): never => refuse('value', `${path(field)} expects ${what}`);
  const text = value.kind === 'scalar' || value.kind === 'string' ? value.text : undefined;
  switch (type) {
    case 'text':
      if (text === undefined) return expected('text');
      if (field.form === 'iso-date' && !isIsoDate(text)) return expected('an ISO date (YYYY-MM-DD)');
      return quotedText(text);
    case 'ref':
      if (value.kind !== 'ref')
        return expected(`a reference @<word> <name>${field.target ? ` to @${field.target}` : ''}`);
      if (field.target !== undefined && value.discriminator !== field.target)
        return expected(`a reference to @${field.target}, not @${value.discriminator}`);
      return value.raw;
    case 'id':
      if (text === undefined || !isId(text)) return expected('an id');
      if (field.values !== undefined && !field.values.includes(text))
        return expected(`one of ${field.values.join(', ')}`);
      return text;
    case 'qname': {
      if (text === undefined || !isQualifiedName(text)) return expected('a qualified name system/kind/facet/name');
      return text;
    }
    case 'number':
      if (text === undefined || !isNumberText(text)) return expected('a number');
      return text;
    case 'flag':
      if (value.kind !== 'scalar' || !['true', 'false'].includes(value.text)) return expected('true or false');
      return value.text;
    default:
      return expected(`a ${type} value`);
  }
}

/**
 * The strict spelling of one form value for `field`, or a SourceEditError: the opt-in `setField` and the CLI's
 * `ia preview` and `ia author` use. A form value is data: text is always quoted, so quotes and backslashes cannot end it,
 * and every other type must parse as exactly one value of its type, by the predicates compliance applies, with nothing
 * after it, so no comment, condition, section, record or second field can ride along. A list type takes a bracketed
 * list, or with `item` one list item. Line breaks, C0 and C1 controls but the tab, DEL, the Unicode line and paragraph
 * separators and the bidirectional controls are refused outright.
 */
export function encodeValue(field: DraftField, text: string, item = false): string {
  if (typeof text !== 'string' || UNSAFE.test(text)) refuse('value', 'Form fields must be single-line plain text');
  if (field.type === 'text' || (item && field.type === 'list of text'))
    return scalar(field, { kind: 'string', text, raw: quotedText(text) });
  const value = inlineValue(text.trim());
  const list = field.type.startsWith('list of ');
  if (list && !item) {
    if (value.kind !== 'list') refuse('value', `${path(field)} expects a bracketed list`);
    const items = (value as Extract<Value, { kind: 'list' }>).items.map((entry) => scalar(field, entry));
    if (new Set(items).size !== items.length) refuse('duplicate', `${path(field)} lists a value twice`);
    return `[${items.join(', ')}]`;
  }
  return scalar(field, value);
}
/** The scanner's findings for a string, prose or list a value opens and does not close. */
const OPEN: readonly string[] = [
  'IA-LANG-STRING-UNTERMINATED',
  'IA-LANG-PROSE-UNTERMINATED',
  'IA-LANG-LIST-UNTERMINATED',
];
/**
 * A form value as 2.0.0's `draftSource` spelled it: text quoted, every other type written as given, so a value the
 * strict encoder refuses but the parser admits is still written and left to admission. Only what would add structure is
 * refused, with SourceEditError: a line break the scanner splits on (CR or LF), a `when` condition, a comment, or a
 * string, prose or list it opens and does not close, which would join the rows after it into this one. Short of those, a
 * value cannot add a field, section or record.
 */
export function draftValue(field: DraftField, text: string): string {
  if (typeof text !== 'string' || /[\r\n]/.test(text))
    refuse('value', 'Form fields must be single-line; use the source draft for multiline prose or structure');
  if (field.type === 'text') return quotedText(text);
  const parsed = parse(PROBE(text), 'value.ia');
  // Review C-RC2: an opener left open would join the rows after it (another value's closer, a comment) into this one.
  if (parsed.diagnostics.some((diagnostic) => OPEN.includes(diagnostic.code)))
    refuse('value', `${path(field)} would open a string, prose or list it does not close: ${JSON.stringify(text)}`);
  if (parsed.ast.records[0]?.head.some((row) => row.when !== undefined))
    refuse('value', `${path(field)} would gain a condition: ${JSON.stringify(text)}`);
  if (parsed.ast.trivia.some((trivia) => trivia.kind === 'comment'))
    refuse('value', `${path(field)} would carry a comment: ${JSON.stringify(text)}`);
  return text;
}
/** An authored list item, re-spelled canonically for the field's item type; one the type refuses is refused here too. */
export function encodeItem(field: DraftField, item: ListItem): string {
  return scalar(field, item);
}
