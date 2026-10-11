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
 * Schema-aware source edits (milestone generation-binding plan amendment C18). Each takes one whole `.ia` file's text and
 * returns the whole new text, normalized by `format()`, that changes exactly one top-level record of it: a record
 * appended, one relationship row added, or one field set. Every other record keeps its source bytes, comments and blank
 * lines included, so only the edited record's digest can change. Admission is not judged here: the caller compiles the
 * result (db's draft overlay) and reads its findings. A refused edit throws SourceEditError and changes nothing.
 */

const PATH = 'edit.ia';
const REFERENCE = /^@([a-z][a-z0-9-]*) ([A-Za-z][A-Za-z0-9-]*)$/;
const FRAGMENT = '(?:#[A-Za-z0-9][A-Za-z0-9-]*(?:/[A-Za-z0-9][A-Za-z0-9-]*)*)?';
const TARGETS = [
  new RegExp(`^@[a-z][a-z0-9-]* [A-Za-z][A-Za-z0-9-]*${FRAGMENT}$`),
  new RegExp(`^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*/[a-z][a-z0-9-]*/[A-Za-z][A-Za-z0-9-]*${FRAGMENT}$`),
];

interface Parsed {
  readonly text: string;
  readonly ast: FileNode;
  readonly lines: string[];
}
/** The file formatted and parsed again, so every span below is a span of the text the edit splices. */
function normalized(text: string): Parsed {
  const formatted = format(text, PATH);
  if (formatted.text === null)
    refuse(
      'parse',
      `The file must parse before it is edited: ${formatted.diagnostics.map((d) => d.message).join('; ')}`,
    );
  const out = formatted.text!;
  return { text: out, ast: parse(out, PATH).ast, lines: out.split('\n') };
}
/** Format a spliced candidate; a splice that does not parse is a defect of the edit, never written. */
function finish(lines: readonly string[]): string {
  const formatted = format(lines.join('\n'), PATH);
  if (formatted.text === null)
    refuse('parse', `The edit does not parse: ${formatted.diagnostics.map((d) => d.message).join('; ')}`);
  return formatted.text!;
}
const nestedIn = (record: RecordNode): readonly RecordNode[] =>
  record.nested.flatMap((child) => [child, ...nestedIn(child)]);
/** The one top-level record `@word name` names, case-insensitively by name as identity is. */
function recordAt(file: Parsed, identity: string): RecordNode {
  const reference = REFERENCE.exec(identity);
  if (reference === null)
    return refuse('identity', `Expected a record as @<word> <name>; got ${JSON.stringify(identity)}`);
  const [, word, name] = reference;
  const matches = (record: RecordNode) =>
    record.discriminator === word && record.name.toLowerCase() === name!.toLowerCase();
  const top = file.ast.records.filter(matches);
  if (top.length > 1) refuse('repeated', `${identity} is declared ${top.length} times in this file`);
  if (top.length === 0)
    return file.ast.records.flatMap(nestedIn).some(matches)
      ? refuse('nested', `${identity} is nested in another record; edit it in its source`)
      : refuse('identity', `No top-level record ${identity} in this file`);
  return top[0]!;
}
const indentOf = (line: string): string => /^ */.exec(line)![0];
const sectionsNamed = (record: RecordNode, name: string): readonly SectionNode[] => {
  const found = record.sections.filter((section) => section.name === name);
  if (found.length > 1)
    refuse('repeated', `@${record.discriminator} ${record.name} states ${name} ${found.length} times`);
  return found;
};
/** Insert `row` as the last child of the record's `section` block, opening the block at the record's end if absent. */
function insert(file: Parsed, record: RecordNode, section: string, row: string): string {
  const lines = [...file.lines],
    indent = indentOf(lines[record.span.line - 1]!);
  if (section === 'head') {
    const last = record.head.at(-1);
    lines.splice(last === undefined ? record.span.line : last.span.endLine, 0, `${indent}  ${row}`);
    return finish(lines);
  }
  const block = sectionsNamed(record, section)[0];
  if (block !== undefined) lines.splice(block.span.endLine, 0, `${indent}    ${row}`);
  else lines.splice(record.span.endLine, 0, `${indent}  ${section}`, `${indent}    ${row}`);
  return finish(lines);
}
const rowText = (line: string): string => line.trim().replace(/\s+/g, ' ');

/**
 * Append one record to a file: `draft` is a complete standalone draft (`draftSource`'s), whose pragma is dropped. An
 * empty file becomes a new file with the draft's pragma. A record the file already declares, nested or not, is refused.
 */
export function appendRecord(text: string, draft: string): string {
  const parsed = parse(draft, PATH);
  const record = parsed.ast.records[0];
  if (parsed.diagnostics.length > 0 || parsed.ast.records.length !== 1 || record === undefined)
    refuse('parse', 'Expected one standalone record draft');
  const pragma = /^\uFEFF?(#! ia [^\r\n]+)\r?\n/.exec(draft);
  if (text.trim() === '')
    return finish([
      `${pragma?.[1] ?? '#! ia 1.0'}`,
      '',
      ...draft
        .slice(pragma?.[0].length ?? 0)
        .trim()
        .split('\n'),
      '',
    ]);
  const file = normalized(text);
  if (
    [...file.ast.records, ...file.ast.records.flatMap(nestedIn)].some(
      (existing) =>
        existing.discriminator === record!.discriminator && existing.name.toLowerCase() === record!.name.toLowerCase(),
    )
  )
    refuse('duplicate', `This file already declares @${record!.discriminator} ${record!.name}`);
  const body = draft.slice(pragma?.[0].length ?? 0).trim();
  return finish([...file.text.trimEnd().split('\n'), '', ...body.split('\n'), '']);
}

/**
 * Add one relationship row `<spelling> <target>` to the record `identity` (`@word name`): the last row of its
 * `relationships` section, or a new section at the record's end. The spelling must be a kernel verb, active, inverse or
 * present; the target a canonical identity or `@word name`, either with an optional fragment, and nothing else, so no
 * condition or comment rides along. A row the section already holds is refused. Consent is the caller's to judge
 * (`relationshipConsent`), as is whether the target is admitted.
 */
export function addRelationship(text: string, identity: string, spelling: string, target: string): string {
  if (typeof spelling !== 'string' || verbOf(spelling) === undefined)
    refuse('spelling', `${JSON.stringify(spelling)} is not a relationship verb`);
  if (typeof target !== 'string' || !TARGETS.some((pattern) => pattern.test(target)))
    refuse('target', `Expected a canonical identity or @<word> <name> target; got ${JSON.stringify(target)}`);
  const file = normalized(text),
    record = recordAt(file, identity),
    row = `${spelling} ${target}`;
  const block = sectionsNamed(record, 'relationships')[0];
  if (
    block !== undefined &&
    file.lines.slice(block.span.line, block.span.endLine).some((line) => rowText(line) === row)
  )
    refuse('duplicate', `${identity} already states ${row}`);
  return insert(file, record, 'relationships', row);
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
  const file = normalized(text),
    record = recordAt(file, identity);
  const children = field.section === 'head' ? record.head : (sectionsNamed(record, field.section)[0]?.children ?? []);
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
  if (previous === undefined) return insert(file, record, field.section, row);
  const comments = file.ast.trivia.filter(
    (trivia) => trivia.kind === 'comment' && trivia.line >= previous.span.line && trivia.line <= previous.span.endLine,
  );
  const kept =
    previous.span.line === previous.span.endLine && comments.length === 1 && comments[0]!.trailing
      ? (comments[0] as { readonly text: string }).text
      : undefined;
  if (comments.length > 0 && kept === undefined)
    refuse('structure', `${identity} carries a comment inside ${path}; edit it in its source`);
  const lines = [...file.lines];
  lines.splice(
    previous.span.line - 1,
    previous.span.endLine - previous.span.line + 1,
    `${indentOf(lines[previous.span.line - 1]!)}${row}${kept === undefined ? '' : ` ${kept}`}`,
  );
  return finish(lines);
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
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(comment)
  )
    refuse('value', `Expected one comment line # <text>; got ${JSON.stringify(comment)}`);
  const file = normalized(text),
    record = recordAt(file, identity),
    lines = [...file.lines],
    header = record.span.line - 1,
    first = comment.split(' ')[1]!;
  const above = file.ast.trivia.find(
    (trivia) => trivia.kind === 'comment' && trivia.line === record.span.line - 1 && !trivia.trailing,
  );
  if (above !== undefined && (above as { readonly text: string }).text.split(' ')[1] === first)
    lines.splice(header - 1, 1, `${indentOf(lines[header]!)}${comment}`);
  else lines.splice(header, 0, `${indentOf(lines[header]!)}${comment}`);
  return finish(lines);
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
