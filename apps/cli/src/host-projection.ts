/**
 * Host registration spec §6: a workspace's projection for one host, rendered from its own admitted records.
 *
 * Milestone position-packet task replace-renderers (plan amendments B9, B11 and B12): the projection is the position
 * packet (`renderPacket`, runtime R19) rendered by the host's adapter for the consumer target (`renderHost`, R20), with
 * the command catalog this CLI tags (`packetCatalog`). One render feeds `ia host`, `ia doctor`'s projection rows and the
 * install/update/remove refresh, so no two of them can disagree about what the projection should contain.
 *
 * Milestone generation-binding task host-consumes-generated-set (plan amendments C4, C5, C9 and C12): the render also
 * holds the host set workspace-runtime generates from the workspace's authored records, computed once
 * (`generateHostSet`): the agent and skill files beside the packet's, the `@hook` declarations whose groups the writer
 * registers, the operation and harness definitions, and a row for each authored record the host does not take.
 *
 * `applyHostProjection` is the only writer of projection files and hook groups. Before any file changes it retires a
 * steward-guard registration an earlier release made (B11), then registers the hook groups of the authored `@hook`
 * records (distribution's guard-registration, owned by exact match through their own state), then applies the planned
 * files through `@inventarch/distribution/projection`, which owns packet and generated files alike through the
 * projection state, deletes the owned 1.x steward files and obsolete generated files and leaves foreign ones (B9), and
 * writes the receipt beside the projection state last (B12). Ownership is the states', never the receipt's.
 */
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type BigIntStats,
} from 'node:fs';
import { resolve } from 'node:path';
import { renderHost, renderPacket, PACKET_MARKER } from '@inventarch/runtime';
import type {
  HookGroupRow,
  HookToolName,
  HostFile,
  HostOutput,
  PacketReceipt,
  UnsupportedRow,
} from '@inventarch/runtime';
import { ProjectionError } from '@inventarch/workspace-runtime/projections';
import { generateHostSet } from '@inventarch/workspace-runtime/internal/generate';
import type { GuardPlan, HookPlan } from '@inventarch/distribution/guard-registration';
import {
  applyGuardRegistration,
  applyHookRegistration,
  assertRetirableGuard,
  hookGroupDigest,
  planGuardRegistration,
  planHookRegistration,
  planHooksFor,
  readHookRegistration,
} from '@inventarch/distribution/guard-registration';
import type { HostCacheTarget } from '@inventarch/distribution/host';
import {
  acquireHostRegistrationLock,
  assertHostRegistrationIdle,
  HOST_REGISTRATION,
} from '@inventarch/distribution/host';
import type { WorkspaceHost } from '@inventarch/distribution/hosts';
import type { ProjectionPlan } from '@inventarch/distribution/projection';
import { applyProjection, planProjection, projectionOwnable } from '@inventarch/distribution/projection';
import {
  DistributionError,
  json,
  readWorkspaceFile,
  readWorkspaceJson,
  replace,
  sha256,
} from '@inventarch/distribution/services';
import { packetCatalog } from './commands.js';
import { Refusal } from './consumer.js';
import { refusedPath, SETTINGS, STATE } from './host.js';
import type { Session } from './session.js';
import { codeOf, openSession } from './session.js';

export type HostName = WorkspaceHost;
export type Artifact = HostFile;

/** This CLI's id@version, which the receipt records and only the applying CLI knows (design item 12). */
const CLI = `@inventarch/cli@${
  (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
}`;

/**
 * §4: the target must admit — zero error findings — before anything is rendered or registered. The refusal is the
 * CLI's own classification of the target, so it is IA-CLI-CONFLICT and names the command that shows the findings.
 */
function requireAdmitted(session: Session, root: string): void {
  if (session.admission().status !== 'admitted')
    throw new Refusal(
      'IA-CLI-CONFLICT',
      'The workspace does not admit; host registration needs a workspace with zero error findings',
      3,
      { path: root },
      'Run "ia validate" and fix the reported errors.',
    );
}
/** §4's admission gate alone, for a removal, which renders nothing. */
export function checkAdmitted(root: string): void {
  const session = openSession(root);
  try {
    requireAdmitted(session, root);
  } finally {
    session.close();
  }
}

/**
 * A host-generation refusal (workspace-runtime's ProjectionError, which carries its code in `diagnostic`) as this CLI's
 * refusal: its IA-PROJECTION-* code and message, located at the workspace, naming the command that shows the records.
 * Generation reports a record it cannot render as an unsupported row, so this is a refusal of the whole render.
 */
function generationRefusal(error: unknown, root: string): unknown {
  if (!(error instanceof ProjectionError)) return error;
  return new Refusal(
    error.diagnostic.code,
    error.diagnostic.message,
    3,
    { path: root },
    'Correct the record the message names, then run "ia validate".',
  );
}
/**
 * §6.1: the packet over the whole workspace, through the session's own scope, rendered by `host`'s adapter for the
 * consumer target, and the host set generated from the workspace's authored records through the same scope: the
 * packet's files, then the generated agent and skill files, each carrying `PACKET_MARKER`; the `@hook` declarations
 * (`hooks`, claude only); and the receipt the render fills (B12), whose `files` list every file with its SHA-256,
 * `generated` the generated ones with their records, `definitions` the operation and harness definitions and
 * `unsupported` each authored record the host does not take. Its `hooks` rows are the applying caller's.
 */
export function renderProjectionFor(root: string, host: HostName): HostOutput {
  const session = openSession(root);
  try {
    requireAdmitted(session, root);
    const within = session.reader.resolveScope().token;
    const { packet, digest, hostNote } = renderPacket(session.reader, within, packetCatalog());
    const output = renderHost(host, packet, digest, hostNote, 'consumer');
    let set: ReturnType<typeof generateHostSet>;
    try {
      set = generateHostSet(session.reader, within, host);
    } catch (error) {
      throw generationRefusal(error, root);
    }
    const generated = set.files.map(({ identity, word, path, text }) => ({
      identity,
      word,
      path,
      sha256: sha256(text),
    }));
    return Object.freeze({
      files: Object.freeze([...output.files, ...set.files.map(({ path, text }) => Object.freeze({ path, text }))]),
      receipt: Object.freeze({
        ...output.receipt,
        files: Object.freeze([...output.receipt.files, ...generated.map(({ path, sha256 }) => ({ path, sha256 }))]),
        generated: Object.freeze(generated),
        definitions: set.definitions,
        unsupported: set.unsupported,
      }),
      hooks: set.hooks,
    });
  } finally {
    session.close();
  }
}

/**
 * Where hook groups run from (plan amendment C9): the payload `ia host` materialized and verified (`verified`), the one
 * it is about to (`expected`, for a plan), or none (null), when the caller registers no host: `ia project`, the install
 * refresh and a migration then keep the groups an earlier `ia host` registration owns in step with the records, against
 * the payload that registration recorded, and register none themselves.
 */
export type HookCache = { readonly verified: string } | { readonly expected: HostCacheTarget } | null;
/** The step's plan, or null when there is nothing to register or remove, and the hooks it cannot register. */
export interface HookStep {
  readonly plan: HookPlan | null;
  readonly unregistered: readonly UnsupportedRow[];
}
/** Why a declared hook is not registered when no host payload is known: `ia host` materializes one. */
export const HOOKS_NEED_HOST =
  'Not registered: a hook group runs the guard in the host payload "ia host claude --apply" materializes; run it to register this hook';
/**
 * The hook groups `rendered` declares, planned for `host` (claude only; Codex hooks are unsupported, C12): with no
 * declared hook, the removal of every owned group; else their registration against `cache`, or against the payload the
 * owned registration recorded; with neither, none, and each declared hook comes back unregistered. A removal
 * (`rendered` null) removes every owned group. Reads only.
 */
export function planHooks(root: string, host: HostName, rendered: HostOutput | null, cache: HookCache): HookStep {
  if (host !== 'claude') return { plan: null, unregistered: [] };
  const rows = (rendered?.hooks ?? []).map(({ identity, tools, paths }) => ({ identity, tools, paths }));
  const prior = readHookRegistration(root);
  if (rows.length === 0)
    return {
      plan: prior === null ? null : planHookRegistration(root, { remove: HOST_REGISTRATION }),
      unregistered: [],
    };
  if (cache !== null && 'expected' in cache)
    return { plan: planHooksFor(root, cache.expected, rows), unregistered: [] };
  const directory = cache?.verified ?? prior?.cache;
  if (directory === undefined)
    return {
      plan: null,
      unregistered: rows.map((row) => ({ identity: row.identity, word: 'hook' as const, reason: HOOKS_NEED_HOST })),
    };
  return { plan: planHookRegistration(root, { cache: directory, hooks: rows }), unregistered: [] };
}
/** The hook groups the workspace owns now, as a receipt lists them: one row per `@hook`, keyed by identity. */
function hookRows(root: string): readonly HookGroupRow[] {
  return (readHookRegistration(root)?.groups ?? []).map(({ hook, group }) => ({
    identity: hook,
    tools: group.matcher.split('|') as HookToolName[],
    sha256: hookGroupDigest(group),
  }));
}

/**
 * B11: whether this workspace holds a steward-guard registration an earlier release made, which the projection apply
 * retires. Only Claude ever registered one; its ownership state is the registration, as `ia host` and `ia doctor`
 * decide it.
 */
export const ownsGuard = (root: string, host: HostName): boolean =>
  host === 'claude' && existsSync(resolve(root, STATE.hooks));
/**
 * B11: the removal of the steward-guard registration this workspace owns, or null when it owns none. A refusal the
 * mechanism does not locate at a file concerns the guard group in the settings file — a group changed by hand, or
 * settings that do not parse — except a pending host journal, which is the journal's.
 */
export function planRetirement(root: string, host: HostName): GuardPlan | null {
  try {
    if (host === 'claude') assertRetirableGuard(root);
    if (!ownsGuard(root, host)) return null;
    return planGuardRegistration(root, { remove: HOST_REGISTRATION });
  } catch (error) {
    const code = codeOf(error, '');
    if (
      error instanceof Error &&
      /^IA-/.test(code) &&
      code !== 'IA-DIST-RECOVERY-REQUIRED' &&
      refusedPath(error) === null
    )
      throw new DistributionError(code, error.message, SETTINGS);
    throw error;
  }
}
/** The file plan `applyHostProjection` applies for `rendered`, or the removal of the owned set for null. */
export const planFiles = (root: string, host: HostName, rendered: HostOutput | null): ProjectionPlan => {
  preflightReceipt(root, host);
  return planProjection({ root, host, artifacts: rendered?.files ?? [], marker: PACKET_MARKER });
};
/** Check every destination ancestor and the opened destination without changing bytes. */
export function preflightReceipt(root: string, host: HostName): void {
  for (const path of [STATE.receipt(host), pendingPath(host)]) {
    const parts = path.split('/'),
      ancestors: { stat: BigIntStats }[] = [];
    const unsafe = (relative = path): DistributionError =>
      new DistributionError(
        'IA-DIST-PATH-UNSAFE',
        'Expected an unaliased receipt file and directory ancestors',
        relative,
      );
    for (let i = 1; i < parts.length; i++) {
      const relative = parts.slice(0, i).join('/'),
        absolute = resolve(root, relative);
      let stat: BigIntStats;
      try {
        stat = lstatSync(absolute, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafe(relative);
      ancestors.push({ stat });
      accessSync(absolute, constants.W_OK);
    }
    const checkAncestors = (): void => {
      for (let i = 1; i < parts.length; i++) {
        const relative = parts.slice(0, i).join('/'),
          current = lstatSync(resolve(root, relative), { bigint: true, throwIfNoEntry: false }),
          before = ancestors[i - 1]?.stat;
        if (!current) {
          if (before) throw unsafe(relative);
          break;
        }
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          (before && (current.dev !== before.dev || current.ino !== before.ino))
        )
          throw unsafe(relative);
      }
    };
    const absolute = resolve(root, path);
    let fd: number;
    try {
      // No pathname precheck: validate the handle actually opened. O_NOFOLLOW protects the leaf where supported;
      // the identity checks below also cover Windows and ancestor replacement. No creation or truncation occurs.
      fd = openSync(absolute, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (error) {
      // A bad kind may itself prevent opening (directories on Windows, or a dangling link). Preserve its path remedy.
      const named = lstatSync(absolute, { bigint: true, throwIfNoEntry: false });
      if (named && (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n)) throw unsafe();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !named) {
        checkAncestors();
        continue;
      }
      throw error;
    }
    try {
      // Windows file IDs can exceed Number.MAX_SAFE_INTEGER; retain every bit when comparing identities.
      const opened = fstatSync(fd, { bigint: true }),
        named = lstatSync(absolute, { bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1n ||
        opened.dev !== named.dev ||
        opened.ino !== named.ino
      )
        throw unsafe();
      checkAncestors();
    } finally {
      closeSync(fd);
    }
  }
  readPending(root, host);
}

const pendingPath = (host: HostName): string => `.ia/distributions/hosts/${host}-receipt-pending.json`;
interface PendingReceipt {
  readonly format: 'ia.packet-receipt-pending.v1';
  readonly host: HostName;
  readonly guard: boolean;
  readonly receipt?: string;
  readonly removed: readonly { readonly path: string; readonly sha256: string }[];
}
function readPending(root: string, host: HostName): PendingReceipt | null {
  const path = pendingPath(host);
  if (!existsSync(resolve(root, path))) return null;
  let value: PendingReceipt & { digest?: string };
  try {
    value = readWorkspaceJson({ root, path }) as typeof value;
  } catch (error) {
    throw new DistributionError(
      codeOf(error, 'IA-CLI-FAILED'),
      error instanceof Error ? error.message : String(error),
      path,
    );
  }
  const { digest, ...body } = value ?? {};
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.format !== 'ia.packet-receipt-pending.v1' ||
    value.host !== host ||
    typeof value.guard !== 'boolean' ||
    !digests(value.removed) ||
    value.removed.some((file) => !projectionOwnable(host, file.path)) ||
    (value.receipt !== undefined && !HEX.test(value.receipt)) ||
    Object.keys(body).sort().join(',') !==
      (value.receipt === undefined ? 'format,guard,host,removed' : 'format,guard,host,receipt,removed') ||
    digest !== sha256(json(body))
  )
    throw new DistributionError('IA-DIST-INPUT-INVALID', 'Invalid pending projection receipt evidence', path);
  // The receipt committed but a kill left the pending cleanup undone: that was a successful last apply.
  if (
    value.receipt !== undefined &&
    existsSync(resolve(root, STATE.receipt(host))) &&
    sha256(readWorkspaceFile({ root, path: STATE.receipt(host) })) === value.receipt
  )
    return null;
  return body;
}

/** Verified deletion provenance shared by projection apply and a migration's durable effect plan. */
export function projectionEvidence(
  root: string,
  host: HostName,
  actions: readonly { readonly action: string; readonly path: string }[],
  retirement: boolean,
  previous?: PacketReceipt,
): PendingReceipt {
  if (
    previous !== undefined &&
    (JSON.stringify(readReceipt(root, host)) !== JSON.stringify(previous) ||
      !previous.files.every((file) => sha256(readWorkspaceFile({ root, path: file.path })) === file.sha256) ||
      !previous.removed.every((file) => !existsSync(resolve(root, file.path))))
  )
    throw new DistributionError(
      'IA-DIST-LOCAL-MODIFICATION',
      'Completed projection differs from its receipt',
      STATE.receipt(host),
    );
  const removed = actions.flatMap((action) =>
    action.action === 'remove' && existsSync(resolve(root, action.path))
      ? [{ path: action.path, sha256: sha256(readWorkspaceFile({ root, path: action.path })) }]
      : [],
  );
  const pending = readPending(root, host);
  const prior =
    pending ?? (previous === undefined ? null : { guard: previous.guard === 'retired', removed: previous.removed });
  for (const file of removed) {
    const recorded = prior?.removed.find((row) => row.path === file.path);
    if (recorded !== undefined && recorded.sha256 !== file.sha256)
      throw new DistributionError(
        'IA-DIST-LOCAL-MODIFICATION',
        'Pending removal evidence differs from the current owned bytes',
        file.path,
      );
  }
  return {
    format: 'ia.packet-receipt-pending.v1',
    host,
    guard: prior?.guard === true || retirement,
    removed: [...new Map([...(prior?.removed ?? []), ...removed].map((file) => [file.path, file])).values()],
  };
}

/** What `applyHostProjection` did. */
export interface HostProjectionApplied {
  /** `projected` after a render; after a removal `projection-removed`, or `absent` when it removed no file. */
  readonly status: 'projected' | 'projection-removed' | 'absent';
  /** B11: `retired` when a steward-guard registration was removed before any projection file changed. */
  readonly guard: 'retired' | 'none';
  /** The receipt written (B12); null after a removal, which deletes it. */
  readonly receipt: PacketReceipt | null;
}

/**
 * The one writer of projection files: B11, then the files, then B12. `rendered` is `renderProjectionFor`'s output,
 * or null to remove the owned set. Both the guard retirement and the file plan are planned before anything is written,
 * so a refusal either planner finds changes nothing; then the guard registration is removed (its group in
 * `.claude/settings.local.json` and its ownership state), and only then are the files written and the owned 1.x
 * steward files deleted. A failure past the retirement so leaves the guard retired and never the steward files
 * deleted with the guard still registered; a rerun converges. The receipt (`<host>-receipt.json` beside the
 * projection state) describes the files as an apply left them, so it is deleted, under the host lock, before any of
 * them changes: an interrupted apply leaves none, which `ia doctor` reports as unknown, never as a hand edit. It is
 * written last, under the host lock, with the legacy files deleted (`removed`), the foreign files left in place, the
 * retirement, this CLI's id@version and the time; a removal leaves it deleted. `checkpoint` runs after the retirement
 * (`guard`), at each of `applyProjection`'s own stages and after the receipt (`receipt`), which is where an
 * interruption test cuts. A migration may supply its verified previous receipt to refresh host notes while retaining
 * that operation's retirement and deletion evidence; ordinary applies omit it and keep last-apply semantics.
 */
export function applyHostProjection(
  root: string,
  host: HostName,
  rendered: HostOutput | null,
  checkpoint: (stage: string) => void = () => {},
  previous?: PacketReceipt,
  cache: HookCache = null,
): HostProjectionApplied {
  // A pending host journal refuses every host write, as it refuses the plan (§8).
  assertHostRegistrationIdle(root);
  const retirement = planRetirement(root, host),
    hooks = planHookStep(root, host, rendered, cache),
    plan = planFiles(root, host, rendered);
  const writeEvidence = (path: string, value: unknown | null): void => {
    const unlock = acquireHostRegistrationLock(root);
    try {
      replace(root, path, value === null ? null : Buffer.from(json(value)));
    } finally {
      unlock();
    }
  };
  const evidence = projectionEvidence(root, host, plan.actions, retirement !== null, previous);
  // Evidence precedes retirement and every deletion; it survives failure and the projection state's collapse.
  writeEvidence(pendingPath(host), { ...evidence, digest: sha256(json(evidence)) });
  checkpoint('evidence');
  if (retirement !== null) applyGuardRegistration(retirement);
  checkpoint('guard');
  // The hook groups next, through their own journal and lock; a plan that changes nothing writes nothing.
  if (hooks.plan !== null) applyHookRegistration(hooks.plan);
  checkpoint('hooks');
  // The last apply's receipt goes before any projection file changes (B12).
  writeEvidence(STATE.receipt(host), null);
  const result = applyProjection(plan, checkpoint),
    guard = evidence.guard ? 'retired' : 'none';
  const receipt: PacketReceipt | null =
    rendered === null
      ? null
      : {
          ...rendered.receipt,
          cli: CLI,
          removed: evidence.removed.filter((file) => !existsSync(resolve(root, file.path))),
          foreign: plan.actions.filter((action) => action.action === 'foreign').map((action) => action.path),
          guard,
          ...(host === 'claude' ? { hooks: hookRows(root) } : {}),
          unsupported: [...(rendered.receipt.unsupported ?? []), ...hooks.unregistered],
          writtenAt: new Date().toISOString(),
        };
  if (receipt !== null) {
    const completed = { ...evidence, receipt: sha256(json(receipt)) };
    writeEvidence(pendingPath(host), { ...completed, digest: sha256(json(completed)) });
  }
  writeEvidence(STATE.receipt(host), receipt);
  writeEvidence(pendingPath(host), null);
  checkpoint('receipt');
  return {
    status: rendered !== null ? 'projected' : result.removed > 0 ? 'projection-removed' : 'absent',
    guard,
    receipt,
  };
}

/** `planHooks`, a refusal it does not locate at a file located at the settings the hook groups live in. */
export function planHookStep(root: string, host: HostName, rendered: HostOutput | null, cache: HookCache): HookStep {
  try {
    return planHooks(root, host, rendered, cache);
  } catch (error) {
    const code = codeOf(error, '');
    if (
      error instanceof Error &&
      /^IA-/.test(code) &&
      code !== 'IA-DIST-RECOVERY-REQUIRED' &&
      refusedPath(error) === null
    )
      throw new DistributionError(code, error.message, SETTINGS);
    throw error;
  }
}

const HEX = /^[a-f0-9]{64}$/;
const digests = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.every(
    (row) =>
      row !== null &&
      typeof row === 'object' &&
      typeof (row as { path?: unknown }).path === 'string' &&
      HEX.test(String((row as { sha256?: unknown }).sha256)),
  );
/**
 * B12: the receipt `applyHostProjection` wrote for `host`, or null when there is none — a 1.x registration, or one
 * whose receipt was deleted. A receipt that cannot be read, or that lacks the fields `ia doctor` checks, refuses at
 * its own path.
 */
export function readReceipt(root: string, host: HostName): PacketReceipt | null {
  const path = STATE.receipt(host);
  if (!existsSync(resolve(root, path))) return null;
  let value: unknown;
  try {
    value = readWorkspaceJson({ root, path });
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string')
      throw new DistributionError(error.code, error.message, path);
    throw error;
  }
  const row = value as Partial<Record<keyof PacketReceipt, unknown>> | null;
  if (
    row === null ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    row.format !== 'ia.packet-receipt.v1' ||
    row.host !== host ||
    !HEX.test(String(row.packetDigest)) ||
    !digests(row.files) ||
    !digests(row.removed) ||
    !Array.isArray(row.foreign) ||
    !row.foreign.every((item) => typeof item === 'string') ||
    (row.generated !== undefined &&
      (!digests(row.generated) ||
        !(row.generated as unknown[]).every(
          (item) =>
            typeof (item as { identity?: unknown }).identity === 'string' &&
            ['agent-profile', 'playbook'].includes(String((item as { word?: unknown }).word)),
        ))) ||
    (row.hooks !== undefined &&
      (!Array.isArray(row.hooks) ||
        !(row.hooks as unknown[]).every(
          (item) =>
            item !== null &&
            typeof item === 'object' &&
            typeof (item as { identity?: unknown }).identity === 'string' &&
            Array.isArray((item as { tools?: unknown }).tools) &&
            HEX.test(String((item as { sha256?: unknown }).sha256)),
        ))) ||
    (row.unsupported !== undefined && !Array.isArray(row.unsupported)) ||
    (row.definitions !== undefined && !Array.isArray(row.definitions))
  )
    throw new DistributionError('IA-DIST-INPUT-INVALID', 'Invalid projection receipt', path);
  return row as PacketReceipt;
}
