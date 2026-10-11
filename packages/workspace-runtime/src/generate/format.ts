import type { Node } from '@inventarch/graph';
import type { CompiledField, CompiledRecord, CompiledValue } from '@inventarch/language';
import type { PacketHost } from '@inventarch/runtime';
import {
  code as packetCode,
  inline as packetInline,
  prose as packetProse,
} from '@inventarch/runtime/internal/packet-host';
import { inputFailure, ProjectionError } from '../projection-format.js';
import { inert } from '../projection-host.js';
import { frozen } from '../resource-format.js';

/**
 * What the host generators share (milestone generation-binding): the generated file and the unsupported row they
 * return, the per-record rendering that reports a record instead of failing the others, the host and name checks, the
 * authored records they render, and the field readers and text helpers their bodies are written with.
 */

/** The words a generator renders records of. */
export type GeneratedWord = 'agent-profile' | 'playbook' | 'hook' | 'operation' | 'harness';
/** One generated host file and the record it renders. */
export interface GeneratedFile {
  /** Workspace-relative and `/`-separated. */
  readonly path: string;
  readonly text: string;
  /** The identity of the rendered record. */
  readonly identity: string;
  readonly word: GeneratedWord;
}
/** An authored record a host does not render or register, and why: the projection receipt's `unsupported` row. */
export interface UnsupportedRecord {
  readonly identity: string;
  readonly word: 'agent-profile' | 'playbook' | 'hook';
  readonly reason: string;
}
/** What a file generator returns: the files it renders, and one row for each authored record it does not. */
export interface GeneratedSet {
  readonly files: readonly GeneratedFile[];
  readonly unsupported: readonly UnsupportedRecord[];
}

/** Records the workspace itself authors; an installed or adopted base sits at a lower band. */
const AUTHORED = 100;

/** An unknown host is IA-PROJECTION-INPUT-INVALID. */
export function knownHost(host: PacketHost): void {
  if (host !== 'claude' && host !== 'codex') inputFailure(`Unknown host: ${String(host)}`);
}
/**
 * A name that becomes a host path segment: lower-case letters, digits and single hyphens, a letter first and no hyphen
 * last, at most 64 characters (the agent and skill name rule), and no Windows device name (`con`, `prn`, `aux`, `nul`,
 * `com0`-`com9`, `lpt0`-`lpt9`, the rule db's input paths apply). IA-PROJECTION-INPUT-INVALID otherwise.
 */
export function safeName(name: string): string {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
    name.endsWith('-') ||
    name.includes('--') ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name)
  )
    inputFailure(`Unsafe generated host name: ${name}`);
  return name;
}
/** The records of `word` among `records` that the workspace authors (band 100), by identity. */
export const authoredOf = (records: readonly Node[], word: GeneratedWord): readonly Node[] =>
  records
    .filter((node) => node.discriminator === word && node.band === AUTHORED)
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
/**
 * Render each record with `render`, in order. A record `render` or its text refuses with an IA-PROJECTION-* error is
 * not rendered and becomes an unsupported row naming the record and the reason, and the others still render (review
 * findings A-R3 and A-R6). Every rendered text must be inert prose (projection-host's `inert`: no executable dynamic
 * context, no active HTML), as the prose projector requires of the same records. Any other error still fails.
 */
export function perRecord(
  word: UnsupportedRecord['word'],
  nodes: readonly Node[],
  render: (node: Node) => GeneratedFile,
): GeneratedSet {
  const files: GeneratedFile[] = [],
    unsupported: UnsupportedRecord[] = [];
  for (const node of nodes)
    try {
      const file = render(node);
      inert(file.text);
      files.push(file);
    } catch (error) {
      if (!(error instanceof ProjectionError)) throw error;
      unsupported.push({ identity: node.identity, word, reason: error.message });
    }
  return frozen({ files, unsupported });
}
// The field readers mirror runtime's private ones (packet.ts's `fieldsAt`, `valuesAt`, `textsAt` and `stated`), which
// runtime does not export: a fix to either copy belongs in both.
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

// Built from strings: the class names the control characters themselves.
const CONTROLS = new RegExp(
  '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]',
  'g',
);
/**
 * Authored text as a generated file may hold it (review finding N2): every C0 or C1 control but tab and the line breaks
 * `inline` folds, the Unicode line and paragraph separators, and the bidirectional controls become a space, so no value
 * can start a YAML or Markdown line, drive a terminal or reorder what a reader sees.
 */
const plain = (text: string): string => text.replace(CONTROLS, ' ');
/** `text` on one line, as the packet writes an entry (runtime's `inline`), its controls made spaces. */
export const inline = (text: string): string => packetInline(plain(text));
/** `text` as one code span, as the packet writes one (runtime's `code`). */
export const code = (text: string): string => packetCode(plain(text));
/**
 * Authored free text for a Markdown body: on one line, each bare IA word token a code span as the packet writes it
 * (runtime's `prose`, review finding N1), and every `<!--` written `&lt;!--`, so no authored value opens an HTML comment
 * that hides what follows, or reads as a marker line (review findings N3 and N4).
 */
export const prose = (text: string): string => packetProse(plain(text)).replaceAll('<!--', '&lt;!--');
/** A list's items, comma-separated, or `none`. */
export const list = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join(', '));
export const section = (heading: string, lines: readonly string[]): readonly string[] => [
  '',
  `## ${heading}`,
  '',
  ...lines,
];
