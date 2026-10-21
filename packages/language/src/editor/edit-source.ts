import type { FieldNode, FileNode, RecordNode, SectionNode } from '../ast.js';
import { format } from '../formatter.js';
import { parse } from '../parser/index.js';
import { consentFor } from '../registry/consent.js';
import type { FrozenRegistry } from '../registry/types.js';
import { verbOf } from '../semantic/vocabulary.js';
import type { Predicate } from '../taxonomy.js';
import { encodeItem, encodeValue, refuse } from './values.js';
import type { DraftSchema } from './values.js';

/**
 * Schema-aware source edits (language E04). Each takes one whole `.ia` file's text and returns the whole new text with
 * exactly one top-level record changed: a record appended, one relationship row added, one field set, or one comment
 * put above it. The edit is spliced into the file as it is: every other line keeps its bytes, line endings, comments
 * and spacing included, and a byte-order mark stays. Only the edited record is formatted (`format()`), and its lines
 * take the file's line ending, so only its digest can change. The file must parse; it need not be formatted.
 * Admission is not judged here: the caller compiles the result (db's draft overlay) and reads its findings. A refused
 * edit throws SourceEditError and returns no text.
 */

const PATH = 'edit.ia';
const BOM = '\uFEFF';
const REFERENCE = /^@([a-z][a-z0-9-]*) ([A-Za-z][A-Za-z0-9-]*)$/;
const FRAGMENT = '(?:#[A-Za-z0-9][A-Za-z0-9-]*(?:/[A-Za-z0-9][A-Za-z0-9-]*)*)?';
const TARGETS = [
  new RegExp(`^@[a-z][a-z0-9-]* [A-Za-z][A-Za-z0-9-]*${FRAGMENT}$`),
  new RegExp(`^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*/[a-z][a-z0-9-]*/[A-Za-z][A-Za-z0-9-]*${FRAGMENT}$`),
];

/** A file as it is: each line's text and its own ending, a byte-order mark, and the parse of its text. */
interface Raw {
  readonly bom: boolean;
  readonly texts: readonly string[];
  readonly endings: readonly string[];
  /** The ending new lines take: the file's first, or LF for a file with none. */
  readonly eol: string;
  readonly ast: FileNode;
}
function read(text: string): Raw {
  const bom = text.startsWith(BOM),
    body = bom ? text.slice(1) : text;
  const pieces = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const texts = pieces.map((piece) => piece.replace(/\r?\n$/, '')),
    endings = pieces.map((piece, index) => piece.slice(texts[index]!.length));
  const parsed = parse(texts.join('\n'), PATH);
  if (parsed.diagnostics.length > 0)
    refuse(
      'parse',
      `The file must parse before it is edited: ${parsed.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`,
    );
  return { bom, texts, endings, eol: endings.find((ending) => ending !== '') ?? '\n', ast: parsed.ast };
}
/** The file with lines `start`..`end` (0-based, inclusive) replaced by `lines`, each other line's bytes kept. */
function assemble(raw: Raw, start: number, end: number, lines: readonly string[]): string {
  // The last new line takes the replaced range's own ending (none at a file's unterminated end); the others the file's.
  const last = raw.endings[end]!;
  const middle = lines.map((line, index) => line + (index === lines.length - 1 ? last : raw.eol));
  const before = raw.texts.slice(0, start).map((line, index) => line + raw.endings[index]!),
    after = raw.texts.slice(end + 1).map((line, index) => line + raw.endings[end + 1 + index]!);
  return (raw.bom ? BOM : '') + [...before, ...middle, ...after].join('');
}

/** One record's lines, formatted on their own, and their parse: spans below are spans of `lines`, the pragma line 1. */
interface Block {
  readonly lines: readonly string[];
  readonly ast: FileNode;
  readonly record: RecordNode;
}
/** Format `lines` (a record, with the file's pragma first) on their own; a splice that does not parse is refused. */
function formatted(lines: readonly string[], what: string): string[] {
  const result = format(`${lines.join('\n')}\n`, PATH);
  if (result.text === null)
    refuse('parse', `${what}: ${result.diagnostics.map((diagnostic) => diagnostic.message).join('; ')}`);
  return result.text!.replace(/\n$/, '').split('\n');
}
function blockOf(raw: Raw, record: RecordNode): Block {
  const pragma = `#! ia ${raw.ast.version}`;
  const lines = formatted([pragma, ...raw.texts.slice(record.span.line - 1, record.span.endLine)], 'The record');
  const ast = parse(`${lines.join('\n')}\n`, PATH).ast;
  return { lines, ast, record: ast.records[0]! };
}
/** The file with the record replaced by `lines`, its block formatted again (pragma first, dropped from the result). */
function replaced(raw: Raw, record: RecordNode, lines: readonly string[]): string {
  const result = formatted(lines, 'The edit does not parse');
  return assemble(raw, record.span.line - 1, record.span.endLine - 1, result.slice(1));
}

const nestedIn = (record: RecordNode): readonly RecordNode[] =>
  record.nested.flatMap((child) => [child, ...nestedIn(child)]);
/** The one top-level record `@word name` names, case-insensitively by name as identity is. */
function recordAt(ast: FileNode, identity: string): RecordNode {
  const reference = REFERENCE.exec(identity);
  if (reference === null)
    return refuse('identity', `Expected a record as @<word> <name>; got ${JSON.stringify(identity)}`);
  const [, word, name] = reference;
  const matches = (record: RecordNode) =>
    record.discriminator === word && record.name.toLowerCase() === name!.toLowerCase();
  const top = ast.records.filter(matches);
  if (top.length > 1) refuse('repeated', `${identity} is declared ${top.length} times in this file`);
  if (top.length === 0)
    return ast.records.flatMap(nestedIn).some(matches)
      ? refuse('nested', `${identity} is nested in another record; edit it in its source`)
      : refuse('identity', `No top-level record ${identity} in this file`);
  return top[0]!;
}
const sectionsNamed = (record: RecordNode, name: string): readonly SectionNode[] => {
  const found = record.sections.filter((section) => section.name === name);
  if (found.length > 1)
    refuse('repeated', `@${record.discriminator} ${record.name} states ${name} ${found.length} times`);
  return found;
};
/** The block's lines with `row` the last child of the record's `section`, the section opened at its end if absent. */
function inserted(block: Block, section: string, row: string): string[] {
  const lines = [...block.lines],
    { record } = block;
  if (section === 'head') {
    const last = record.head.at(-1);
    lines.splice(last === undefined ? record.span.line : last.span.endLine, 0, `  ${row}`);
    return lines;
  }
  const found = sectionsNamed(record, section)[0];
  if (found !== undefined) lines.splice(found.span.endLine, 0, `    ${row}`);
  else lines.splice(record.span.endLine, 0, `  ${section}`, `    ${row}`);
  return lines;
}
const rowText = (line: string): string => line.trim().replace(/\s+/g, ' ');

/**
 * Append one record to a file: `draft` is a complete standalone draft (`draftSource`'s), whose pragma is dropped. It
 * follows the file's last line after one blank line, in the file's line ending; an empty file becomes a new file with the
 * draft's pragma. A record the file already declares, nested or not, is refused.
 */
export function appendRecord(text: string, draft: string): string {
  const parsed = parse(draft, PATH);
  const record = parsed.ast.records[0];
  if (parsed.diagnostics.length > 0 || parsed.ast.records.length !== 1 || record === undefined)
    refuse('parse', 'Expected one standalone record draft');
  const pragma = /^\uFEFF?(#! ia [^\r\n]+)\r?\n/.exec(draft);
  const body = formatted(
    [
      pragma?.[1] ?? '#! ia 1.0',
      ...draft
        .slice(pragma?.[0].length ?? 0)
        .trim()
        .replace(/\r\n/g, '\n')
        .split('\n'),
    ],
    'The draft',
  ).slice(1);
  if (text.replace(BOM, '').trim() === '') {
    const eol = /\r\n/.test(text) ? '\r\n' : '\n';
    return `${text.startsWith(BOM) ? BOM : ''}${[pragma?.[1] ?? '#! ia 1.0', '', ...body].join(eol)}${eol}`;
  }
  const raw = read(text);
  if (
    [...raw.ast.records, ...raw.ast.records.flatMap(nestedIn)].some(
      (existing) =>
        existing.discriminator === record!.discriminator && existing.name.toLowerCase() === record!.name.toLowerCase(),
    )
  )
    refuse('duplicate', `This file already declares @${record!.discriminator} ${record!.name}`);
  const end = raw.texts.length - 1;
  // The file keeps its bytes, the last line its own ending, gaining the file's only if it had none; one blank line
  // separates the record, and only the new lines take the file's ending.
  const blank = raw.texts[end]!.trim() === '' ? [] : [''];
  return `${text}${raw.endings[end] === '' ? raw.eol : ''}${[...blank, ...body].map((line) => `${line}${raw.eol}`).join('')}`;
}

/**
 * Add one relationship row `<spelling> <target>` to the record `identity` (`@word name`): the last row of its
 * `relationships` section, or a new section at the record's end. The spelling must be a kernel verb, active, inverse or
 * present; the target a canonical identity or `@word name`, either with an optional fragment, and nothing else, so no
 * condition or comment rides along. A row the section already holds, word for word, is refused; a row that differs only
 * in spelling (a canonical identity for a reference, say) is left to admission. Consent is the caller's to judge
 * (`relationshipConsent`), as is whether the target is admitted.
 */
export function addRelationship(text: string, identity: string, spelling: string, target: string): string {
  if (typeof spelling !== 'string' || verbOf(spelling) === undefined)
    refuse('spelling', `${JSON.stringify(spelling)} is not a relationship verb`);
  if (typeof target !== 'string' || !TARGETS.some((pattern) => pattern.test(target)))
    refuse('target', `Expected a canonical identity or @<word> <name> target; got ${JSON.stringify(target)}`);
  const raw = read(text),
    record = recordAt(raw.ast, identity),
    block = blockOf(raw, record),
    row = `${spelling} ${target}`;
  const found = sectionsNamed(block.record, 'relationships')[0];
  if (
    found !== undefined &&
    block.lines.slice(found.span.line, found.span.endLine).some((line) => rowText(line) === row)
  )
    refuse('duplicate', `${identity} already states ${row}`);
  return replaced(raw, record, inserted(block, 'relationships', row));
}

/**
 * Set the schema field `path` (`<section>.<key>`) of the record `identity` (`@word name`) to `value`, a form value
 * `encodeValue` spells for the field's type; with `append`, add `value` as one item to a list field, creating the field
 * when absent. An undeclared field, a value of another type or carrying syntax, a field stated twice, a conditional or
 * structured field, and a multi-line value with a comment inside are refused. A trailing comment on a one-line field is
 * kept.
 */
export function setField(
  text: string,
  identity: string,
  path: string,
  value: string,
  schema: DraftSchema,
  append = false,
): string {
  const field = schema.fields.find((candidate) => `${candidate.section}.${candidate.key}` === path);
  if (field === undefined) return refuse('field', `The schema declares no field ${path}`);
  if (append && !field.type.startsWith('list of '))
    refuse('value', `${path} is ${field.type}, not a list; set it with =`);
  let encoded = encodeValue(field, value, append);
  const raw = read(text),
    record = recordAt(raw.ast, identity),
    block = blockOf(raw, record),
    target = block.record;
  const children = field.section === 'head' ? target.head : (sectionsNamed(target, field.section)[0]?.children ?? []);
  const fields = children.filter((child): child is FieldNode => child.kind === 'field' && child.key === field.key);
  if (fields.length > 1) refuse('repeated', `${identity} states ${path} ${fields.length} times`);
  const previous = fields[0];
  if (previous !== undefined && (previous.when !== undefined || previous.children.length > 0))
    refuse('structure', `${identity} states ${path} conditionally or as a block; edit it in its source`);
  if (append) {
    if (previous !== undefined && previous.value.kind !== 'list')
      refuse('structure', `${identity} states ${path} as something other than an inline list`);
    const items = previous?.value.kind === 'list' ? previous.value.items.map((item) => encodeItem(field, item)) : [];
    if (items.includes(encoded)) refuse('duplicate', `${identity} already lists ${encoded} in ${path}`);
    encoded = `[${[...items, encoded].join(', ')}]`;
  }
  const row = `${field.key} ${encoded}`;
  if (previous === undefined) return replaced(raw, record, inserted(block, field.section, row));
  const comments = block.ast.trivia.filter(
    (trivia) => trivia.kind === 'comment' && trivia.line >= previous.span.line && trivia.line <= previous.span.endLine,
  );
  const kept =
    previous.span.line === previous.span.endLine && comments.length === 1 && comments[0]!.trailing
      ? (comments[0] as { readonly text: string }).text
      : undefined;
  if (comments.length > 0 && kept === undefined)
    refuse('structure', `${identity} carries a comment inside ${path}; edit it in its source`);
  const lines = [...block.lines],
    indent = /^ */.exec(lines[previous.span.line - 1]!)![0];
  lines.splice(
    previous.span.line - 1,
    previous.span.endLine - previous.span.line + 1,
    `${indent}${row}${kept === undefined ? '' : ` ${kept}`}`,
  );
  return replaced(raw, record, lines);
}

/**
 * Put the one-line comment `comment` (`# <text>`) directly above the top-level record `identity` (`@word name`), in
 * place of a comment there that starts with the same first word (`# authored-by`, say), so an attribution is replaced,
 * not stacked. A comment is trivia, so no record's digest moves; every other line keeps its bytes. A comment that is not
 * one `#` line of plain text is refused.
 */
export function annotateRecord(text: string, identity: string, comment: string): string {
  if (
    typeof comment !== 'string' ||
    !/^# \S[^\r\n\u2028\u2029]*$/.test(comment) ||
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(comment)
  )
    refuse('value', `Expected one comment line # <text>; got ${JSON.stringify(comment)}`);
  const raw = read(text),
    record = recordAt(raw.ast, identity),
    header = record.span.line - 1,
    first = comment.split(' ')[1]!;
  const above = raw.ast.trivia.find(
    (trivia) => trivia.kind === 'comment' && trivia.line === record.span.line - 1 && !trivia.trailing,
  );
  if (above !== undefined && (above as { readonly text: string }).text.split(' ')[1] === first)
    return assemble(raw, header - 1, header - 1, [comment]);
  return assemble(raw, header, header, [comment, raw.texts[header]!]);
}

/** What `relationshipConsent` finds for one relationship row. */
export interface RelationshipConsent {
  readonly predicate: Predicate;
  /** `in` for an inverse spelling: the row's target is then the edge's source. */
  readonly direction: 'out' | 'in';
  /** The words at the edge's two ends, in the predicate's active direction. */
  readonly from: string;
  readonly to: string;
  /**
   * Present when the two-sided consent rule (spec 6.4) refuses the edge: the side whose system refuses, and that
   * system, the one registering the word at that side.
   */
  readonly refused?: { readonly side: 'source' | 'target'; readonly system: string };
}
/**
 * The consent `registry` gives one relationship row of a `@<word>` record: `<spelling>` towards a `@<target>` record,
 * judged as admission judges it (`consentFor`), so a row it refuses would be IA-LANG-EDGE-UNCONSENTED. An unknown
 * spelling is a SourceEditError; a word the registry does not register is no refusal here, as admission refuses its
 * record on its own.
 */
export function relationshipConsent(
  registry: FrozenRegistry,
  word: string,
  spelling: string,
  target: string,
  fragment?: string,
): RelationshipConsent {
  const verb = verbOf(spelling);
  if (verb === undefined) return refuse('spelling', `${JSON.stringify(spelling)} is not a relationship verb`);
  const [from, to] = verb.direction === 'out' ? [word, target] : [target, word];
  const side = consentFor(registry, verb.predicate, from, to, verb.direction === 'out' ? fragment : undefined);
  const system = side === undefined ? undefined : registry.registrations.get(side === 'source' ? from : to)?.system;
  return Object.freeze({
    predicate: verb.predicate,
    direction: verb.direction,
    from,
    to,
    ...(side === undefined || system === undefined ? {} : { refused: Object.freeze({ side, system }) }),
  });
}
