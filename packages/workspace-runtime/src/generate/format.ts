import type { Node } from '@inventarch/graph';
import type { CompiledField, CompiledRecord, CompiledValue } from '@inventarch/language';
import type { PacketHost } from '@inventarch/runtime';
import { inputFailure } from '../projection-format.js';

/**
 * What the host generators share (milestone generation-binding): the generated file they return, the host check, the
 * authored records they render, and the field readers and markup helpers their bodies are written with.
 */

/** The words a generator renders records of. */
export type GeneratedWord = 'agent-profile' | 'playbook';
/** One generated host file and the record it renders. */
export interface GeneratedFile {
  /** Workspace-relative and `/`-separated. */
  readonly path: string;
  readonly text: string;
  /** The identity of the rendered record. */
  readonly identity: string;
  readonly word: GeneratedWord;
}

/** Records the workspace itself authors; an installed or adopted base sits at a lower band. */
const AUTHORED = 100;

/** An unknown host is IA-PROJECTION-INPUT-INVALID. */
export function knownHost(host: PacketHost): void {
  if (host !== 'claude' && host !== 'codex') inputFailure(`Unknown host: ${String(host)}`);
}
/** The records of `word` among `records` that the workspace authors (band 100), by identity. */
export const authoredOf = (records: readonly Node[], word: GeneratedWord): readonly Node[] =>
  records
    .filter((node) => node.discriminator === word && node.band === AUTHORED)
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));

// The field readers and the markup helpers mirror runtime's private ones (packet.ts's `fieldsAt`, `valuesAt`, `textsAt`
// and `stated`; packet-host.ts's `inline` and `code`), which runtime does not export: a fix to either copy belongs in
// both.
/** The unconditional fields of `record`'s `section`, in authored order. */
export const fieldsOf = (record: CompiledRecord, section: string): readonly CompiledField[] =>
  record.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields)
    .filter((f): f is CompiledField => 'key' in f && f.when === undefined);
/** The fields `record` states unconditionally at `field`, a `section.key` path. */
const fieldsAt = (record: CompiledRecord, field: string): readonly CompiledField[] => {
  const [section = '', key] = field.split('.');
  return fieldsOf(record, section).filter((f) => f.key === key);
};
/** The values `record` states unconditionally at `field`, a list's items one by one. */
export const valuesAt = (record: CompiledRecord, field: string): readonly CompiledValue[] =>
  fieldsAt(record, field).flatMap((f) => (f.value.kind === 'list' ? f.value.items : [f.value]));
export const textsAt = (record: CompiledRecord, field: string): readonly string[] =>
  valuesAt(record, field).flatMap((value) => ('text' in value ? [value.text] : []));
/** Whether `record` states `field` at all: a declared empty list is stated, an absent key is not. */
export const stated = (record: CompiledRecord, field: string): boolean => fieldsAt(record, field).length > 0;

/** `text` on one line: a line break and the blanks around it become one space, so each entry stays one line. */
export const inline = (text: string): string => text.replace(/[ \t]*(?:\r\n|\r|\n)\s*/g, ' ');
/** `text` as one code span, its fence one backtick longer than the longest run inside, padded where one touches it. */
export function code(text: string): string {
  const one = inline(text),
    fence = '`'.repeat(Math.max(0, ...(one.match(/`+/g) ?? []).map((run) => run.length)) + 1),
    pad = one.startsWith('`') || one.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${one}${pad}${fence}`;
}
/** A list's items, comma-separated, or `none`. */
export const list = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join(', '));
export const section = (heading: string, lines: readonly string[]): readonly string[] => [
  '',
  `## ${heading}`,
  '',
  ...lines,
];
