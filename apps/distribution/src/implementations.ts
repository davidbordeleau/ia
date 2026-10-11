import { existsSync } from 'node:fs';
import { decodeDistributionJson } from '@inventarch/db/distribution';
import { acquireHostRegistrationLock, assertHostRegistrationIdle } from './host.js';
import { bytes, contained, fail, json, locate, object, replace, sha256, utf8, workspace } from './files.js';

/**
 * Plan amendment C16 (design item 9): the installed-implementation catalog a v2 host payload carries at its root. The
 * payload builder (tools/distribution/host-payload.mjs) generates it and lists it in the payload inventory, because
 * `verifyHostCache` refuses any file the inventory does not list, and it describes implementations no host app may
 * import, so this module reads it without importing them.
 */
export const INSTALLED_IMPLEMENTATIONS = 'implementations.json';
export const INSTALLED_IMPLEMENTATIONS_FORMAT = 'ia.installed-implementations.v1';
/** Design item 9: the join receipts each consumer records under its own name, beside the host state files. */
export const JOINS = '.ia/distributions/hosts/joins.json';
export const JOINS_FORMAT = 'ia.host-joins.v1';
/** One installed operation implementation as its package reports it; the digest is the package's bare SHA-256. */
export interface InstalledOperation {
  readonly id: string;
  readonly version: number;
  readonly handler: string;
  readonly input: string;
  readonly output: string;
  readonly digest: string;
}
export interface InstalledImplementationsValue {
  readonly format: typeof INSTALLED_IMPLEMENTATIONS_FORMAT;
  /** An `ia-evaluator-catalog/1.x` value as compliance's `createEvaluatorCatalog` takes it: its built-ins are implicit. */
  readonly evaluators: { readonly format: string; readonly entries: readonly unknown[] };
  readonly operations: readonly InstalledOperation[];
}
/** The catalog as `readInstalledImplementations` verified it in one materialized payload. */
export interface InstalledImplementations extends InstalledImplementationsValue {
  /** The payload release whose inventory lists the catalog. */
  readonly release: string;
  /** The payload's version (its inventory's `version`). */
  readonly version: string;
  /** The SHA-256 of the catalog's bytes, as the inventory lists it. */
  readonly digest: string;
}
/** One consumer's join: the implementation it joined at the version and digest it read, at its own revision. */
export interface ImplementationJoin {
  readonly consumer: string;
  readonly implementation: string;
  readonly version: string;
  readonly digest: string;
  readonly consumerRevision: string;
}
const ROWS = 1024;
const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  HANDLER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/,
  HEX = /^[a-f0-9]{64}$/,
  EVALUATOR_FORMAT = /^ia-evaluator-catalog\/1\.(?:0|[1-9][0-9]*)$/;
const OPERATION_KEYS = ['id', 'version', 'handler', 'input', 'output', 'digest'] as const,
  JOIN_KEYS = ['consumer', 'implementation', 'version', 'digest', 'consumerRevision'] as const;
const text = (value: Buffer | null): string | null => (value === null ? null : utf8(value));
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The shape of a catalog: the evaluators section's format and entry list (compliance validates each entry when it
 * binds), and one row per operation, sorted by id and unique. The payload builder checks what it writes with it too.
 */
export function installedImplementationsValue(value: unknown): InstalledImplementationsValue {
  const row = object(value, ['format', 'evaluators', 'operations']),
    evaluators = object(row['evaluators'], ['format', 'entries']);
  if (row['format'] !== INSTALLED_IMPLEMENTATIONS_FORMAT)
    fail('INPUT-INVALID', 'Unknown installed-implementation catalog format');
  if (
    typeof evaluators['format'] !== 'string' ||
    !EVALUATOR_FORMAT.test(evaluators['format']) ||
    !Array.isArray(evaluators['entries']) ||
    evaluators['entries'].length > ROWS
  )
    fail('INPUT-INVALID', 'The evaluators section is not an ia-evaluator-catalog/1.x value');
  if (!Array.isArray(row['operations']) || row['operations'].length > ROWS)
    fail('INPUT-INVALID', 'Invalid installed operation list');
  let previous = '';
  for (const item of row['operations']) {
    const operation = object(item, OPERATION_KEYS);
    if (
      typeof operation['id'] !== 'string' ||
      !TOKEN.test(operation['id']) ||
      operation['id'].length > 128 ||
      operation['id'] <= previous ||
      !Number.isSafeInteger(operation['version']) ||
      (operation['version'] as number) < 1 ||
      typeof operation['handler'] !== 'string' ||
      !HANDLER.test(operation['handler']) ||
      operation['handler'].length > 128 ||
      typeof operation['input'] !== 'string' ||
      !TOKEN.test(operation['input']) ||
      typeof operation['output'] !== 'string' ||
      !TOKEN.test(operation['output']) ||
      typeof operation['digest'] !== 'string' ||
      !HEX.test(operation['digest'])
    )
      fail('INPUT-INVALID', 'Invalid installed operation');
    previous = operation['id'];
  }
  return row as unknown as InstalledImplementationsValue;
}

/**
 * The catalog of the materialized v2 payload at `directory`, read through the chain its release digest pins: release.json
 * must hash to `release`, inventory.json to the inventory release.json names, and the catalog to the digest the
 * inventory lists, so the bytes returned are the bytes the release pins without verifying every payload file again.
 * A payload whose inventory lists no catalog is ARTIFACT-UNAVAILABLE; changed bytes are INTEGRITY-MISMATCH.
 */
export function readInstalledImplementations(directory: string, release: string): InstalledImplementations {
  const root = workspace(directory),
    releaseText = text(bytes(root, 'release.json'));
  if (!HEX.test(release)) fail('INPUT-INVALID', 'Invalid host release pin');
  if (releaseText === null) fail('ARTIFACT-UNAVAILABLE', 'Missing host release');
  if (sha256(releaseText) !== release) fail('INTEGRITY-MISMATCH', 'Host release differs from its pin');
  const pinned = object(decodeDistributionJson(releaseText), ['format', 'inventory', 'launcher']);
  if (pinned['format'] !== 'ia.host-release.v2')
    fail('ARTIFACT-UNAVAILABLE', 'Only a v2 host payload carries an installed-implementation catalog');
  const inventoryText = text(bytes(root, 'inventory.json', 4 * 1024 * 1024));
  if (inventoryText === null || sha256(inventoryText) !== pinned['inventory'])
    fail('INTEGRITY-MISMATCH', 'Host release inventory changed');
  const inventory = object(decodeDistributionJson(inventoryText), ['format', 'version', 'packages', 'files']);
  if (inventory['format'] !== 'ia.host-cache.v2' || typeof inventory['version'] !== 'string')
    fail('INPUT-INVALID', 'Invalid host cache inventory');
  const listed = Array.isArray(inventory['files'])
    ? (inventory['files'] as unknown[]).find(
        (row) =>
          row !== null && typeof row === 'object' && (row as { path?: unknown }).path === INSTALLED_IMPLEMENTATIONS,
      )
    : undefined;
  if (listed === undefined) fail('ARTIFACT-UNAVAILABLE', 'The host payload lists no installed-implementation catalog');
  const content = bytes(root, INSTALLED_IMPLEMENTATIONS);
  if (content === null || sha256(content) !== (listed as { sha256?: unknown }).sha256)
    fail('INTEGRITY-MISMATCH', 'Installed-implementation catalog changed');
  return {
    ...installedImplementationsValue(decodeDistributionJson(utf8(content))),
    release,
    version: inventory['version'],
    digest: sha256(content),
  };
}

function joinRow(value: unknown): ImplementationJoin {
  const row = object(value, JOIN_KEYS);
  for (const key of ['consumer', 'implementation', 'version', 'consumerRevision'] as const)
    if (typeof row[key] !== 'string' || !row[key] || row[key].length > 256 || /[\u0000-\u001f]/.test(row[key]))
      fail('INPUT-INVALID', 'Invalid join receipt');
  if (typeof row['digest'] !== 'string' || !HEX.test(row['digest'])) fail('INPUT-INVALID', 'Invalid join digest');
  return row as unknown as ImplementationJoin;
}
/** The joins recorded at `root`, one per consumer, or null when none was ever recorded. Refusals locate at `JOINS`. */
export function readJoins(rootInput: string): readonly ImplementationJoin[] | null {
  const root = workspace(rootInput);
  return locate(JOINS, () => {
    const content = text(bytes(root, JOINS));
    if (content === null) return null;
    const row = object(decodeDistributionJson(content), ['format', 'joins']);
    if (row['format'] !== JOINS_FORMAT || !Array.isArray(row['joins']) || row['joins'].length > ROWS)
      fail('INPUT-INVALID', 'Invalid join receipts');
    const joins = row['joins'].map(joinRow);
    if (new Set(joins.map((join) => join.consumer)).size !== joins.length)
      fail('INPUT-INVALID', 'Join receipts repeat a consumer');
    return joins;
  });
}
/**
 * Record `join` under the host lock as its consumer's one row, keeping every other consumer's, and return the rows
 * written. A pending host journal refuses it as it refuses every host write, and receipts that cannot be read refuse
 * it, located at `JOINS`, rather than be replaced.
 */
export function recordJoin(rootInput: string, join: ImplementationJoin): readonly ImplementationJoin[] {
  const root = workspace(rootInput),
    row = joinRow({ ...join });
  assertHostRegistrationIdle(root);
  const unlock = acquireHostRegistrationLock(root);
  try {
    const joins = [...(readJoins(root) ?? []).filter((other) => other.consumer !== row.consumer), row].sort((a, b) =>
      byText(a.consumer, b.consumer),
    );
    replace(root, JOINS, Buffer.from(json({ format: JOINS_FORMAT, joins })));
    return joins;
  } finally {
    unlock();
  }
}
/** Delete the join receipts under the host lock; with none recorded nothing is written, the host area included. */
export function removeJoins(rootInput: string): void {
  const root = workspace(rootInput);
  if (!existsSync(contained(root, JOINS))) return;
  const unlock = acquireHostRegistrationLock(root);
  try {
    replace(root, JOINS, null);
  } finally {
    unlock();
  }
}
