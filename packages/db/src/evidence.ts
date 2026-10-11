import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Node } from '@inventarch/graph';
import type { CheckBinding } from './checks.js';
import { DbError } from './errors.js';
import { EVIDENCE_DIRECTORY, EVIDENCE_FILE, safePath } from './inputs.js';
import { discard, entryAt, staged, syncDirectory } from './retention.js';

/**
 * D14: runtime evidence (milestone generation-binding, plan amendment C14). The validate effect records each bound check
 * whose selected verdicts passed or failed as one `@observation` in `.ia/work/evidence/<authored revision>.ia`, a source
 * at runtime placement band 0 that only a reader opened with `evidence` reads, and that never moves the authored
 * revision. An observation is named `<check name>-<12-hex authored revision>`; pass is verdict `success`, fail is
 * `refusal`, and a not-evaluated check records nothing. Nothing else writes this directory.
 */
/** The word an evidence record is an instance of; a workspace whose vocabulary lacks it records no evidence. */
export const CHECK_EVIDENCE_WORD = 'observation';
export interface EvidenceObservation {
  /** The observation's name. */
  readonly name: string;
  /** The identity of the `@check` it observed. */
  readonly check: string;
  readonly verdict: 'success' | 'refusal';
}
/** What a validate effect recorded. */
export interface EvidenceWrite {
  /** The evidence file of the authored revision; null when nothing passed or failed, and none is kept. */
  readonly path: string | null;
  readonly observations: readonly EvidenceObservation[];
  /** False when the file already held exactly these bytes, or when there was nothing to write and nothing to remove. */
  readonly written: boolean;
  /** The evidence files of other authored revisions removed, and this revision's when it has nothing to record. */
  readonly pruned: readonly string[];
}
const HEX = /^[0-9a-f]{64}$/,
  STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
/** A text value as a quoted literal, with no character the string syntax would have to escape. */
const quoted = (text: string): string => `"${text.replace(/["\\\u0000-\u001f]/g, ' ').trim()}"`;
const short = (revision: string): string => revision.slice(0, 12);

/**
 * The prior evidence file's observation times, by observation name, with the verdict and subject digest they were taken
 * for: an observation that would be recorded again unchanged keeps the time it was first made, so validating twice at
 * one authored revision writes the same bytes. Read from this writer's own layout; anything else is ignored.
 */
function priorTimes(
  text: string | null,
): ReadonlyMap<string, { observedAt: string; capturedAt: string; verdict: string; digest: string }> {
  const times = new Map<string, { observedAt: string; capturedAt: string; verdict: string; digest: string }>();
  if (text === null) return times;
  for (const block of text.split(/^(?=@observation )/m)) {
    const name = /^@observation ([a-z][a-z0-9-]*)\n/.exec(block)?.[1],
      observedAt = /^ {4}observed-at "([^"\n]*)"$/m.exec(block)?.[1],
      capturedAt = /^ {4}captured-at "([^"\n]*)"$/m.exec(block)?.[1],
      verdict = /^ {4}verdict ([a-z]+)$/m.exec(block)?.[1],
      digest = /^ {4}subject-revision "([0-9a-f]{64})"$/m.exec(block)?.[1];
    if (name && observedAt && capturedAt && verdict && digest && STAMP.test(observedAt) && STAMP.test(capturedAt))
      times.set(name, { observedAt, capturedAt, verdict, digest });
  }
  return times;
}

/**
 * The evidence file for `bindings` at `authoredRevision`, or null when no bound check passed or failed. `records` are the
 * admitted records the checks were read from (for their digests and for whether a check's name refers to it alone);
 * `prior` is the file this revision already has, whose times an unchanged observation keeps; `now` stamps the rest. A
 * check whose observation name an authored `@observation` already holds records nothing, so evidence never shadows,
 * duplicates or overwrites an authored record (a reader would refuse the whole file for it).
 */
export function evidenceText(input: {
  readonly authoredRevision: string;
  readonly bindings: readonly CheckBinding[];
  readonly records: readonly Node[];
  readonly prior: string | null;
  readonly now?: Date;
}): { readonly text: string | null; readonly observations: readonly EvidenceObservation[] } {
  const { authoredRevision, bindings, records } = input;
  if (!HEX.test(authoredRevision)) throw new TypeError('An authored revision is 64 hex digits');
  const stamp = (input.now ?? new Date()).toISOString(),
    times = priorTimes(input.prior),
    checks = records.filter((record) => record.discriminator === 'check'),
    authored = new Set(
      records
        .filter((record) => record.discriminator === CHECK_EVIDENCE_WORD && record.band !== 0)
        .map((record) => record.name),
    );
  const observations: EvidenceObservation[] = [],
    blocks: string[] = [];
  for (const binding of bindings) {
    if (binding.status !== 'bound' || binding.outcome === 'not-evaluated') continue;
    const record = checks.find((check) => check.identity === binding.identity);
    if (record === undefined) continue;
    const name = `${binding.name}-${short(authoredRevision)}`;
    if (authored.has(name)) continue;
    const verdict = binding.outcome === 'pass' ? 'success' : 'refusal',
      prior = times.get(name),
      kept = prior !== undefined && prior.verdict === verdict && prior.digest === record.digest ? prior : undefined;
    // A typed subject only when the check's name refers to it alone; the locator always carries its identity.
    const unique = checks.filter((check) => check.name === binding.name).length === 1;
    observations.push(Object.freeze({ name, check: binding.identity, verdict }));
    blocks.push(
      [
        `@observation ${name}`,
        '  meaning',
        `    says ${quoted(`ia validate observed check ${binding.name} ${binding.outcome === 'pass' ? 'passing' : 'failing'} at authored revision ${short(authoredRevision)}.`)}`,
        `    answers ${quoted(`Did check ${binding.name} pass at authored revision ${short(authoredRevision)}?`)}`,
        '  evidence',
        '    origin check',
        `    actor ${quoted('ia validate')}`,
        `    observed-at ${quoted(kept?.observedAt ?? stamp)}`,
        `    captured-at ${quoted(kept?.capturedAt ?? stamp)}`,
        `    workspace ${quoted('.')}`,
        `    locator ${quoted(binding.identity)}`,
        `    revision ${quoted(authoredRevision)}`,
        `    bundle ${quoted(`${EVIDENCE_DIRECTORY}/${authoredRevision}.ia`)}`,
        `    digest ${quoted(record.digest)}`,
        '    availability available',
        ...(unique ? [`    subject @check ${binding.name}`] : []),
        `    subject-revision ${quoted(record.digest)}`,
        `    snapshot-revision ${quoted(authoredRevision)}`,
        `    evaluator ${quoted(`${binding.implementation ?? 'none'} ${binding.runner ?? ''}`)}`,
        '    move Verification',
        `    verdict ${verdict}`,
        '  interpretation',
        `    applies ${quoted(`The admitted records of authored revision ${short(authoredRevision)} that check.scope ${binding.scope ?? ''} selects.`)}`,
        `    limits ${quoted('The verdicts of a built-in evaluator in admission at one authored revision; no external evaluator ran and nothing was executed.')}`,
        `    reason ${quoted(binding.reason)}`,
        '    basis evaluation',
        '  retention',
        '    status retained',
      ].join('\n'),
    );
  }
  return Object.freeze({
    text: blocks.length === 0 ? null : `#! ia 1.0\n\n${blocks.join('\n\n')}\n`,
    observations: Object.freeze(observations),
  });
}

/**
 * The directories evidence lives in, contained the D01 way from the root: a link or junction refuses as
 * IA-DB-PATH-UNSAFE (safePath), as does an entry at `.ia`, `.ia/work` or the evidence directory that is not a directory.
 */
function directories(root: string): void {
  for (const path of ['.ia', '.ia/work', EVIDENCE_DIRECTORY]) {
    const stat = lstatSync(safePath(root, path), { throwIfNoEntry: false });
    if (stat === undefined) return;
    if (!stat.isDirectory()) throw new DbError('IA-DB-PATH-UNSAFE', `${path} is not a directory`, path);
  }
}
/** Whether `error` is D01's refusal of a link, junction or entry of the wrong kind. */
const unsafe = (error: unknown): boolean => error instanceof DbError && error.code === 'IA-DB-PATH-UNSAFE';
/**
 * The bytes of the evidence file at `path`, or null when there is none, including when a link, junction or entry of the
 * wrong kind stands on the way: nothing is read through one, and the writer refuses there.
 */
export function readEvidence(root: string, path: string): string | null {
  try {
    directories(root);
    const target = entryAt(root, path);
    return target === undefined ? null : readFileSync(target, 'utf8');
  } catch (error) {
    if (unsafe(error)) return null;
    throw error;
  }
}

/**
 * Write `text` as the evidence of `authoredRevision` (D14), or, for null, keep none for it, and prune the evidence files of
 * other authored revisions. Every check passes before the first write: a link or junction on the way, or an entry at
 * either a directory's or the file's path of the wrong kind, refuses as IA-DB-PATH-UNSAFE, except that with nothing to
 * record (null) such a directory is left alone and nothing is done. The bytes are staged in the
 * evidence directory, flushed, and renamed into place, so a reader sees the whole old file or the whole new one; a file
 * that already holds `text` is not rewritten. Only regular files named `<64 hex>.ia` are pruned; nothing else in the
 * directory, temporary files included, is touched. A failure leaves the evidence it found, and only the error escapes.
 */
export function writeEvidence(
  root: string,
  authoredRevision: string,
  text: string | null,
): Omit<EvidenceWrite, 'observations'> {
  if (!HEX.test(authoredRevision)) throw new TypeError('An authored revision is 64 hex digits');
  const name = `${authoredRevision}.ia`,
    path = `${EVIDENCE_DIRECTORY}/${name}`;
  try {
    directories(root);
  } catch (error) {
    // With nothing to record, a directory that is not plain holds nothing this writer may prune: nothing is done.
    if (text === null && unsafe(error)) return Object.freeze({ path: null, written: false, pruned: Object.freeze([]) });
    throw error;
  }
  const existing = entryAt(root, path),
    before = existing === undefined ? null : readFileSync(existing);
  let written = false;
  if (text !== null && (before === null || !before.equals(Buffer.from(text, 'utf8')))) {
    mkdirSync(safePath(root, EVIDENCE_DIRECTORY), { recursive: true });
    directories(root);
    let temporary: string | undefined = staged(root, path, Buffer.from(text, 'utf8'));
    try {
      renameSync(safePath(root, temporary), safePath(root, path));
      temporary = undefined;
      syncDirectory(dirname(safePath(root, path)));
      written = true;
    } finally {
      discard(root, temporary);
    }
  }
  const pruned: string[] = [];
  const directory = safePath(root, EVIDENCE_DIRECTORY);
  if (lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() === true)
    for (const entry of readdirSync(directory).sort()) {
      if (!EVIDENCE_FILE.test(entry) || (entry === name && text !== null)) continue;
      const other = `${EVIDENCE_DIRECTORY}/${entry}`;
      if (lstatSync(safePath(root, other), { throwIfNoEntry: false })?.isFile() !== true) continue;
      unlinkSync(safePath(root, other));
      pruned.push(other);
    }
  if (pruned.length > 0) syncDirectory(directory);
  return Object.freeze({
    path: text === null ? null : path,
    written: written || (text === null && pruned.includes(path)),
    pruned: Object.freeze(pruned),
  });
}
