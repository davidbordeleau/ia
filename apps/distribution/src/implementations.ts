import { existsSync } from 'node:fs';
import { decodeDistributionJson } from '@inventarch/db/distribution';
import {
  acquireHostRegistrationLock,
  assertHostRegistrationIdle,
  HOST_REGISTRATION,
  saved,
  verifyHostCache,
} from './host.js';
import type { WorkspaceHost } from './hosts.js';
import { asWorkspaceHost } from './hosts.js';
import { bytes, contained, fail, json, locate, object, portable, replace, sha256, utf8, workspace } from './files.js';

/**
 * Plan amendments C16 and C24 (milestone generation-binding; design item 9): the installed-implementation catalog a v2
 * host payload carries at its root. The payload builder (tools/distribution/host-payload.mjs) generates it and lists it
 * in the payload inventory, because `verifyHostCache` refuses any file the inventory does not list. It describes
 * implementations no host app may import, so this module reads data only: it never imports, loads or runs a handler.
 *
 * Nothing is read from a payload that fails `verifyHostCache`: every entry under the payload directory must be a file
 * the inventory lists, with its bytes, and no link or junction, so a module planted anywhere Node's resolution could
 * reach (beside or above the handler's packages) refuses the whole catalog. An operation is then `available` only when
 * the payload ships its handler: the handler module and every file of the packages its closure names are in the
 * verified inventory, the catalog's handler digest is the SHA-256 the inventory pins for the module, and the closure
 * digest is the digest of those inventory rows. A declaration whose bytes are not shipped is `unavailable`, never
 * available; a payload that fails verification, or catalog pins that disagree with its inventory, are refusals.
 */
export const INSTALLED_IMPLEMENTATIONS = 'implementations.json';
export const INSTALLED_IMPLEMENTATIONS_FORMAT = 'ia.installed-implementations.v1';
/** The implementation id a consumer's join names for the catalog itself. */
export const INSTALLED_IMPLEMENTATIONS_ID = 'installed-implementations';
/** Design item 9: the join receipts each consumer records under its own name, beside the host state files. */
export const JOINS = '.ia/distributions/hosts/joins.json';
export const JOINS_FORMAT = 'ia.host-joins.v1';

/** An operation implementation whose handler bytes the payload ships. Digests are bare SHA-256 hex. */
export interface AvailableOperation {
  readonly id: string;
  readonly status: 'available';
  /** The installed descriptor's version. */
  readonly version: number;
  /** The canonical identity of the `@operation` the implementation serves. */
  readonly operation: string;
  readonly handler: string;
  /** The input and output validator ids. */
  readonly input: string;
  readonly output: string;
  /** The payload path of the shipped handler module. */
  readonly module: string;
  /** The SHA-256 of the shipped handler module's bytes. */
  readonly digest: string;
  /** The installed packages whose shipped files are the handler's closure: its own package and its dependencies. */
  readonly packages: readonly string[];
  /** `closureDigest` over every payload file of `packages`, as the inventory pins them. */
  readonly closure: string;
}
/** An operation implementation the payload does not ship, with the reason. It binds nothing. */
export interface UnavailableOperation {
  readonly id: string;
  readonly status: 'unavailable';
  readonly reason: string;
}
export type InstalledOperation = AvailableOperation | UnavailableOperation;
export interface InstalledImplementationsValue {
  readonly format: typeof INSTALLED_IMPLEMENTATIONS_FORMAT;
  /** An `ia-evaluator-catalog/1.x` value as compliance's `createEvaluatorCatalog` takes it: its built-ins are implicit. */
  readonly evaluators: { readonly format: string; readonly entries: readonly unknown[] };
  readonly operations: readonly InstalledOperation[];
}
/** The catalog as `readInstalledImplementations` verified it in one materialized payload. */
export interface InstalledImplementations extends InstalledImplementationsValue {
  readonly status: 'present';
  /** The payload release whose inventory lists the catalog. */
  readonly release: string;
  /** The payload's version (its inventory's `version`). */
  readonly version: string;
  /** The SHA-256 of the catalog's bytes, as the inventory lists it. */
  readonly digest: string;
}
/** A payload that carries no catalog, such as one built before the catalog existed: unavailable, not damaged. */
export interface InstalledImplementationsUnavailable {
  readonly status: 'unavailable';
  readonly release: string;
  readonly reason: string;
}
export type InstalledCatalog = InstalledImplementations | InstalledImplementationsUnavailable;
/**
 * One consumer's join: the catalog it joined (implementation id, payload version, catalog digest and payload release)
 * at its own revision. A workspace host's consumer revision is the workspace's authored revision when it joined.
 */
export interface ImplementationJoin {
  readonly consumer: WorkspaceHost;
  readonly implementation: string;
  readonly version: string;
  readonly digest: string;
  readonly release: string;
  readonly consumerRevision: string;
}
export type JoinResult =
  | { readonly status: 'joined'; readonly join: ImplementationJoin }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'unregistered' };

const ROWS = 1024;
const TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  HANDLER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/,
  IDENTITY = /^[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)+$/,
  PACKAGE = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/,
  MODULE = /\.[cm]?js$/,
  HEX = /^[a-f0-9]{64}$/,
  EVALUATOR_FORMAT = /^ia-evaluator-catalog\/1\.(?:0|[1-9][0-9]*)$/;
const AVAILABLE_KEYS = [
    'id',
    'status',
    'version',
    'operation',
    'handler',
    'input',
    'output',
    'module',
    'digest',
    'packages',
    'closure',
  ] as const,
  UNAVAILABLE_KEYS = ['id', 'status', 'reason'] as const,
  JOIN_KEYS = ['consumer', 'implementation', 'version', 'digest', 'release', 'consumerRevision'] as const;
const prose = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value);
const text = (value: Buffer | null): string | null => (value === null ? null : utf8(value));
/** The payload directory of an installed package, with its trailing slash. */
const packageDirectory = (name: string): string => `runtime/node_modules/${name}/`;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The digest an operation's `closure` pins: the SHA-256 of one `<sha256>  <path>` line per file, sorted by path, as
 * `sha256sum` prints them. The payload builder computes it from the bytes it ships; a reader recomputes it from the
 * inventory, so both name exactly the same files and bytes.
 */
export function closureDigest(files: readonly { readonly path: string; readonly sha256: string }[]): string {
  return sha256(
    [...files]
      .sort((a, b) => byText(a.path, b.path))
      .map((file) => `${file.sha256}  ${file.path}\n`)
      .join(''),
  );
}

function operationRow(item: unknown): InstalledOperation {
  if (item === null || typeof item !== 'object' || Array.isArray(item))
    fail('INPUT-INVALID', 'Invalid installed operation');
  const status = (item as { status?: unknown }).status;
  if (status === 'unavailable') {
    const row = object(item, UNAVAILABLE_KEYS);
    if (typeof row['id'] !== 'string' || !TOKEN.test(row['id']) || row['id'].length > 128 || !prose(row['reason'], 512))
      fail('INPUT-INVALID', 'Invalid unavailable installed operation');
    return row as unknown as UnavailableOperation;
  }
  if (status !== 'available') fail('INPUT-INVALID', 'An installed operation is available or unavailable');
  const row = object(item, AVAILABLE_KEYS),
    packages = row['packages'];
  if (
    typeof row['id'] !== 'string' ||
    !TOKEN.test(row['id']) ||
    row['id'].length > 128 ||
    !Number.isSafeInteger(row['version']) ||
    (row['version'] as number) < 1 ||
    typeof row['operation'] !== 'string' ||
    !IDENTITY.test(row['operation']) ||
    row['operation'].length > 256 ||
    typeof row['handler'] !== 'string' ||
    !HANDLER.test(row['handler']) ||
    row['handler'].length > 128 ||
    typeof row['input'] !== 'string' ||
    !TOKEN.test(row['input']) ||
    typeof row['output'] !== 'string' ||
    !TOKEN.test(row['output']) ||
    typeof row['digest'] !== 'string' ||
    !HEX.test(row['digest']) ||
    typeof row['closure'] !== 'string' ||
    !HEX.test(row['closure']) ||
    !Array.isArray(packages) ||
    packages.length === 0 ||
    packages.length > 64 ||
    !packages.every(
      (name, index) =>
        typeof name === 'string' &&
        PACKAGE.test(name) &&
        name.length <= 214 &&
        (index === 0 || (packages[index - 1] as string) < name),
    ) ||
    typeof row['module'] !== 'string' ||
    !MODULE.test(row['module'])
  )
    fail('INPUT-INVALID', 'Invalid available installed operation');
  portable(row['module']);
  // The handler module belongs to one of the packages its closure names, so its bytes are part of what is checked.
  if (!(packages as string[]).some((name) => (row['module'] as string).startsWith(packageDirectory(name))))
    fail('INPUT-INVALID', 'An installed handler module lies outside its package closure');
  return row as unknown as AvailableOperation;
}

/**
 * The shape of a catalog: the evaluators section's format and entry list (compliance validates each entry when it
 * binds), and one row per operation, sorted by id and unique, each `available` with its handler pins or `unavailable`
 * with a reason. The payload builder checks what it writes with it too.
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
  const operations = row['operations'].map((item) => {
    const operation = operationRow(item);
    if (operation.id <= previous) fail('INPUT-INVALID', 'Installed operations must be sorted by id and unique');
    previous = operation.id;
    return operation;
  });
  return {
    format: INSTALLED_IMPLEMENTATIONS_FORMAT,
    evaluators: evaluators as unknown as InstalledImplementationsValue['evaluators'],
    operations,
  };
}

interface Listed {
  readonly bytes: number;
  readonly sha256: string;
}
/**
 * C24: `operation` as this payload ships it, against the inventory of a payload `verifyHostCache` has verified, so
 * every listed file is present with the bytes the inventory pins and nothing else is there. A handler module or closure
 * package the inventory does not list makes the operation unavailable; catalog pins that disagree with the inventory
 * are IA-DIST-INTEGRITY-MISMATCH.
 */
function shipped(operation: AvailableOperation, inventory: ReadonlyMap<string, Listed>): InstalledOperation {
  const unavailable = (reason: string): UnavailableOperation => ({ id: operation.id, status: 'unavailable', reason });
  const module = inventory.get(operation.module);
  if (module === undefined)
    return unavailable(`its handler module ${operation.module} is not in this payload's inventory`);
  if (module.sha256 !== operation.digest)
    fail('INTEGRITY-MISMATCH', `The catalog's handler digest for ${operation.id} differs from the payload inventory`);
  const missing = operation.packages.find((name) => !inventory.has(packageDirectory(name) + 'package.json'));
  if (missing !== undefined) return unavailable(`its closure package ${missing} is not in this payload`);
  const files = [...inventory]
    .filter(([path]) => operation.packages.some((name) => path.startsWith(packageDirectory(name))))
    .map(([path, listed]) => ({ path, sha256: listed.sha256 }));
  if (closureDigest(files) !== operation.closure)
    fail('INTEGRITY-MISMATCH', `The catalog's closure digest for ${operation.id} differs from the payload inventory`);
  return operation;
}

/**
 * The catalog of the materialized host payload at `directory`. The whole payload is verified first, as `verifyHostCache`
 * verifies it before a registration may launch it, and must verify as `release`: a file the inventory does not list
 * (wherever Node's resolution could find it), a link or junction, a missing file or changed bytes refuse, with that
 * verification's code (release.json hashing to `release`, inventory.json to the digest release.json names, every listed
 * file to its pin). The catalog is the file that verified inventory lists, read again and compared with its pin. Each
 * available operation is checked against the verified inventory (`shipped`). A v1 payload, or a v2 payload whose
 * inventory lists no catalog (one built before the catalog existed), is `unavailable`, not an integrity failure. A
 * missing payload file or release.json is IA-DIST-ARTIFACT-UNAVAILABLE; unexpected or changed bytes are
 * IA-DIST-INTEGRITY-MISMATCH; a link is IA-DIST-PATH-UNSAFE; malformed metadata is IA-DIST-INPUT-INVALID. Nothing is
 * written, imported or executed.
 */
export function readInstalledImplementations(directory: string, release: string): InstalledCatalog {
  if (!HEX.test(release)) fail('INPUT-INVALID', 'Invalid host release pin');
  // B-R1: never read a catalog from a payload that fails verification; an uninventoried module could be loaded in place
  // of a shipped one, inside a closure package or outside every one.
  const verified = verifyHostCache(workspace(directory));
  if (verified.release !== release) fail('INTEGRITY-MISMATCH', 'Host release differs from its pin');
  if (verified.format === 1)
    return { status: 'unavailable', release, reason: 'a v1 host payload carries no installed-implementation catalog' };
  const catalog = verified.files.get(INSTALLED_IMPLEMENTATIONS);
  if (catalog === undefined)
    return {
      status: 'unavailable',
      release,
      reason:
        'this host payload carries no installed-implementation catalog; payloads built before the catalog existed carry none',
    };
  // Read again through the inventory's pin, so the bytes parsed are the bytes verification hashed.
  const content = bytes(verified.directory, INSTALLED_IMPLEMENTATIONS);
  if (content === null || content.length !== catalog.bytes || sha256(content) !== catalog.sha256)
    fail('INTEGRITY-MISMATCH', 'Installed-implementation catalog is missing or changed');
  const value = installedImplementationsValue(decodeDistributionJson(utf8(content)));
  return {
    status: 'present',
    format: value.format,
    evaluators: value.evaluators,
    operations: value.operations.map((operation) =>
      operation.status === 'available' ? shipped(operation, verified.files) : operation,
    ),
    release,
    version: verified.version,
    digest: catalog.sha256,
  };
}

function joinRow(value: unknown): ImplementationJoin {
  const row = object(value, JOIN_KEYS);
  asWorkspaceHost(row['consumer']);
  if (
    typeof row['implementation'] !== 'string' ||
    !TOKEN.test(row['implementation']) ||
    row['implementation'].length > 128 ||
    !prose(row['version'], 128)
  )
    fail('INPUT-INVALID', 'Invalid join receipt');
  for (const key of ['digest', 'release', 'consumerRevision'] as const)
    if (typeof row[key] !== 'string' || !HEX.test(row[key])) fail('INPUT-INVALID', 'Invalid join receipt digest');
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
/** Replace `consumer`'s row with `row` (or drop it for null), keeping every other consumer's; with none left, delete. */
function writeJoin(root: string, consumer: WorkspaceHost, row: ImplementationJoin | null): void {
  const current = readJoins(root);
  const others = (current ?? []).filter((join) => join.consumer !== consumer);
  const joins = [...others, ...(row === null ? [] : [row])].sort((a, b) => byText(a.consumer, b.consumer));
  if (current === null && joins.length === 0) return;
  if (current !== null && json(joins) === json(current)) return;
  replace(root, JOINS, joins.length === 0 ? null : Buffer.from(json({ format: JOINS_FORMAT, joins })));
}
/** Run `work` under the host lock, as every host write runs; a pending host journal refuses it first. */
function locked<T>(root: string, work: () => T): T {
  assertHostRegistrationIdle(root);
  const unlock = acquireHostRegistrationLock(root);
  try {
    return work();
  } finally {
    unlock();
  }
}

/**
 * Record `host`'s join (design item 9) from its committed registration, under the host lock: the catalog of the payload
 * that `<host>-workspace.json` names, read and checked by `readInstalledImplementations` at that state's own cache and
 * release, at `consumerRevision`. The row is derived from the registration as written, never from what a caller
 * expected to register, so it cannot name a catalog the registration does not use. With no registration, or a payload
 * that carries no catalog, the host's row is dropped instead, so a stale join never outlives what it described; every
 * other consumer's row is kept. Receipts that cannot be read refuse, located at `JOINS`, rather than be replaced.
 */
export function joinHost(rootInput: string, hostInput: string, consumerRevision: string): JoinResult {
  const root = workspace(rootInput),
    host = asWorkspaceHost(hostInput);
  if (!HEX.test(consumerRevision)) fail('INPUT-INVALID', 'Invalid consumer revision');
  return locked(root, () => {
    const path = `.ia/distributions/hosts/${host}-${HOST_REGISTRATION}.json`;
    const state = locate(path, () => {
      const content = bytes(root, path);
      return saved(content === null ? null : utf8(content), host, HOST_REGISTRATION);
    });
    if (state === null) {
      writeJoin(root, host, null);
      return { status: 'unregistered' };
    }
    const catalog = readInstalledImplementations(state.cache, state.release);
    if (catalog.status === 'unavailable') {
      writeJoin(root, host, null);
      return { status: 'unavailable', reason: catalog.reason };
    }
    const join = joinRow({
      consumer: host,
      implementation: INSTALLED_IMPLEMENTATIONS_ID,
      version: catalog.version,
      digest: catalog.digest,
      release: catalog.release,
      consumerRevision,
    });
    writeJoin(root, host, join);
    return { status: 'joined', join };
  });
}
/** Drop `host`'s join under the host lock, keeping every other consumer's; true when a row was removed. */
export function leaveHost(rootInput: string, hostInput: string): boolean {
  const root = workspace(rootInput),
    host = asWorkspaceHost(hostInput);
  if (!existsSync(contained(root, JOINS))) return false;
  return locked(root, () => {
    const present = (readJoins(root) ?? []).some((join) => join.consumer === host);
    if (present) writeJoin(root, host, null);
    return present;
  });
}
