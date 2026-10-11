import { isAbsolute, join, relative, sep } from 'node:path';
import { decodeDistributionJson } from '@inventarch/db/distribution';
import { registrableHook } from '@inventarch/workspace-runtime/internal/generate';
import {
  acquireHostRegistrationLock,
  assertHostRegistrationIdle,
  doorServer,
  HOST_REGISTRATION,
  verifyHostCache,
} from './host.js';
import type { HostCacheTarget } from './host.js';
import { bytes, digest, fail, json, locate, object, replace, sha256, utf8, workspace } from './files.js';
import { editJson, emptyJson, keptPaths, presentJson } from './json-edit.js';
import type { JsonPath } from './json-edit.js';

const area = '.ia/distributions/hosts',
  pendingPath = area + '/guard-pending.json',
  configPath = '.claude/settings.local.json',
  projectPath = '.claude/settings.json';
const identity = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value))
    fail('INPUT-INVALID', 'Invalid guard registration identity');
  return value;
};
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    fail('INPUT-INVALID', 'Invalid guard registration digest');
  return value;
};
const statePath = (id: string): string => `${area}/claude-guard-${identity(id)}.json`;
/** Containers on the owned path; those that existed before the first apply are retained as `existing` and never pruned. */
const containers: readonly JsonPath[] = [['hooks'], ['hooks', 'PreToolUse']];
const GUARD_MATCHER = 'Write|Edit|MultiEdit';
export type GuardRequest = { readonly cache: string } | { readonly remove: string };
interface Side {
  readonly config: string | null;
  readonly state: string | null;
}
export interface Group {
  readonly matcher: string;
  readonly hooks: readonly {
    readonly type: 'command';
    readonly command: string;
    readonly args: readonly string[];
    readonly timeout: number;
  }[];
}
interface State {
  readonly format: 'ia.guard-registration-state.v1';
  readonly id: string;
  readonly cache: string;
  readonly release: string;
  readonly created: boolean;
  readonly group: Group;
  readonly existing?: readonly JsonPath[];
}
export interface GuardPlan {
  readonly format: 'ia.guard-registration-plan.v1';
  readonly root: string;
  readonly id: string;
  readonly request: GuardRequest;
  readonly release: string | null;
  readonly before: {
    readonly config: string | null;
    readonly state: string | null;
    readonly projectConfig: string | null;
  };
  readonly after: Side;
  readonly digest: string;
}
const read = (root: string, path: string, limit = 1024 * 1024): string | null => {
  const value = bytes(root, path, limit);
  return value === null ? null : utf8(value);
};
const pin = (value: string | null): string | null => (value === null ? null : sha256(value));
function plain(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('INPUT-INVALID', 'Expected host settings object');
  return value as Record<string, unknown>;
}
/**
 * One group that runs the launcher's guard mode with `args` after it: the direct form on win32, and elsewhere through
 * `/bin/sh` with `FAIL_CLOSED`. Every group IA registers for the guard, the retired steward guard's and each `@hook`'s,
 * is this derivation, so `guardNode` reads both.
 */
function fixedGroup(matcher: string, launcher: string, args: readonly string[], platform: NodeJS.Platform): Group {
  const server = doorServer(launcher, ['guard', ...args]);
  return {
    matcher,
    hooks: [
      {
        type: 'command',
        ...(platform === 'win32'
          ? server
          : { command: '/bin/sh', args: ['-c', FAIL_CLOSED, server.command, ...server.args] }),
        timeout: GUARD_TIMEOUT,
      },
    ],
  };
}
const GUARD_TIMEOUT = 10;
/** Spec §5.1: explicit root, not claude-guard's CLAUDE_PROJECT_DIR, so the recorded root is the one run; on POSIX through `/bin/sh`, so a guard that cannot run denies (`FAIL_CLOSED`). */
export function guardGroup(launcher: string, root: string, platform: NodeJS.Platform = process.platform): Group {
  return fixedGroup(GUARD_MATCHER, launcher, ['--root', root], platform);
}
/**
 * The retained group must be the fixed guard derivation for its cache and root, in either form (`guardNode`); the
 * recorded Node executable is kept as written. Exported for `host-observe.ts`, which reuses this real validator rather than a weaker local
 * copy so observation can never drift from what `planGuardRegistration`/`applyGuardRegistration` themselves accept.
 */
export function saved(content: string | null, root: string, id: string, removal = false): State | null {
  if (content === null) return null;
  const value = plain(decodeDistributionJson(content)),
    row = object(value, [
      'format',
      'id',
      'cache',
      'release',
      'created',
      'group',
      ...(Object.hasOwn(value, 'existing') ? ['existing'] : []),
    ]);
  if (
    row['format'] !== 'ia.guard-registration-state.v1' ||
    row['id'] !== id ||
    typeof row['cache'] !== 'string' ||
    !isAbsolute(row['cache']) ||
    typeof row['created'] !== 'boolean'
  )
    fail('INPUT-INVALID', 'Invalid guard ownership state');
  hash(row['release']);
  const group = object(row['group'], ['matcher', 'hooks']);
  if (group['matcher'] !== GUARD_MATCHER || !Array.isArray(group['hooks']) || group['hooks'].length !== 1)
    fail('INPUT-INVALID', 'Invalid owned guard hook group');
  const handler = object(group['hooks'][0], ['type', 'command', 'args', 'timeout']),
    launcher = join(row['cache'], 'scripts/ia.mjs'),
    recorded = Array.isArray(handler['args']) ? handler['args'].at(-1) : null,
    fixedRoot = removal && typeof recorded === 'string' && isAbsolute(recorded) ? recorded : root,
    node = guardNode(handler, launcher, fixedRoot);
  if (
    handler['type'] !== 'command' ||
    typeof node !== 'string' ||
    !isAbsolute(node) ||
    handler['timeout'] !== guardGroup(launcher, root).hooks[0]!.timeout
  )
    fail('INPUT-INVALID', 'Owned guard command differs from its fixed root');
  keptPaths(row['existing'], containers);
  return row as unknown as State;
}
/**
 * What a group's guard invocation names: undefined when no handler runs the launcher's guard mode, null when one does and
 * names no `@hook` (the retired steward guard's), else the value after its `--hook`, as written. Released direct and
 * POSIX wrappers both contain this fixed launcher/verb/root argv sequence; a `@hook`'s group follows it with
 * `--hook <identity>`.
 */
function guardInvocation(value: unknown): string | null | undefined {
  if (value === null || typeof value !== 'object' || !('hooks' in value) || !Array.isArray(value.hooks))
    return undefined;
  for (const handler of value.hooks as unknown[]) {
    if (handler === null || typeof handler !== 'object' || !('args' in handler) || !Array.isArray(handler.args))
      continue;
    const args = handler.args as unknown[];
    const index = args.findIndex(
      (arg, at) =>
        typeof arg === 'string' &&
        /[/\\]scripts[/\\]ia\.mjs$/.test(arg) &&
        args[at + 1] === 'guard' &&
        args[at + 2] === '--root',
    );
    if (index < 0) continue;
    return args[index + 4] === '--hook' ? String(args[index + 5]) : null;
  }
  return undefined;
}
/** Whether a group is the retired steward guard's: it runs the guard and names no `@hook` (B11 retires exactly these). */
const referencesGuard = (value: unknown): boolean => guardInvocation(value) === null;
/** Refuse an unowned guard before retiring the agents it depends on. Never alter unrelated hooks. */
export function assertRetirableGuard(root: string): void {
  const state = locate(statePath(HOST_REGISTRATION), () =>
    saved(read(root, statePath(HOST_REGISTRATION)), root, HOST_REGISTRATION, true),
  );
  for (const path of [configPath, projectPath])
    locate(path, () => {
      const text = read(root, path);
      if (text === null) return;
      const config = plain(decodeDistributionJson(text));
      const hooks = config['hooks'] === undefined ? {} : plain(config['hooks']);
      const rows = hooks['PreToolUse'] ?? [];
      if (!Array.isArray(rows)) fail('INPUT-INVALID', 'Expected PreToolUse hook array');
      for (const row of rows) {
        if (!referencesGuard(row)) continue;
        if (path === configPath && state !== null && json(row) === json(state.group)) continue;
        fail(
          'LOCAL-MODIFICATION',
          'An IA guard group has no matching ownership state; remove only that guard group before retiring steward files',
        );
      }
    });
}
export function planGuardRegistration(rootInput: string, request: GuardRequest): GuardPlan {
  const root = workspace(rootInput);
  assertHostRegistrationIdle(root);
  const remove = Object.hasOwn(plain(request), 'remove');
  object(request, remove ? ['remove'] : ['cache']);
  return planGuardWith(
    root,
    remove ? null : verifyHostCache((request as { cache: string }).cache),
    remove ? (request as { remove: string }).remove : null,
  );
}
/** `planGuardRegistration` against an expected, unverified cache (`expectedHostCache`); never reads the cache. Apply re-plans with verification. */
export function planGuardFor(rootInput: string, expected: HostCacheTarget): GuardPlan {
  const root = workspace(rootInput);
  assertHostRegistrationIdle(root);
  return planGuardWith(root, expected, null);
}
function planGuardWith(root: string, cache: HostCacheTarget | null, removeId: string | null): GuardPlan {
  if (cache && cache.host !== null && cache.host !== 'claude')
    fail('HOST-UNSUPPORTED', 'Guard registration requires a Claude-compatible cache');
  if (cache) {
    const path = relative(cache.directory, root);
    if (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
      fail('PATH-UNSAFE', 'Consumer root cannot be inside its immutable host cache');
  }
  const id = cache ? HOST_REGISTRATION : identity(removeId);
  const before: Side = {
      config: read(root, configPath),
      state: locate(statePath(id), () => read(root, statePath(id))),
    },
    prior = locate(statePath(id), () => saved(before.state, root, id, cache === null));
  if (!cache && !prior) fail('INPUT-INVALID', 'Guard registration is not owned');
  const config = before.config === null ? {} : plain(decodeDistributionJson(before.config)),
    hooks = config['hooks'] === undefined ? {} : plain(config['hooks']);
  const projectText = read(root, projectPath),
    project = projectText === null ? {} : plain(decodeDistributionJson(projectText));
  if (
    cache &&
    (config['disableAllHooks'] === true ||
      (config['disableAllHooks'] === undefined && project['disableAllHooks'] === true))
  )
    fail('HOST-UNSUPPORTED', 'Project hooks are explicitly disabled by disableAllHooks');
  const rows: unknown[] = hooks['PreToolUse'] === undefined ? [] : (hooks['PreToolUse'] as unknown[]);
  if (!Array.isArray(rows) || rows.length > 256) fail('INPUT-INVALID', 'Expected a bounded PreToolUse hook array');
  const matching = prior
    ? rows.map((row, at) => (json(row) === json(prior.group) ? at : -1)).filter((at) => at >= 0)
    : [];
  // A removal whose owned group the user already deleted — no group names this root's guard — removes only the ownership state; a changed or duplicated group still refuses.
  const gone = !cache && prior !== null && matching.length === 0 && !rows.some(referencesGuard);
  if (prior && !gone && matching.length !== 1)
    fail('LOCAL-MODIFICATION', 'Owned guard hook group changed or was duplicated');
  const group = cache ? guardGroup(cache.launcher, root) : null,
    remaining = rows.filter((_row, at) => !matching.includes(at));
  if (group && remaining.some((row) => json(row) === json(group)))
    fail('LOCAL-MODIFICATION', 'An unmanaged identical guard group already exists');
  // In place (spec §5.1): replace or append the owned group, or remove it by index; every other byte is kept.
  const existing = prior ? keptPaths(prior.existing, containers) : presentJson(before.config, containers),
    owned = ['hooks', 'PreToolUse', prior ? matching[0]! : -1];
  const edited = gone ? before.config : editJson(before.config, owned, group ?? undefined, existing),
    nextConfig = !gone && prior?.created && emptyJson(edited!) ? null : edited;
  const after: Side = {
    config: nextConfig,
    state:
      cache && group
        ? json({
            format: 'ia.guard-registration-state.v1',
            id,
            cache: cache.directory,
            release: cache.release,
            created: prior?.created ?? before.config === null,
            group,
            ...(existing.length ? { existing } : {}),
          })
        : null,
  };
  if (Buffer.byteLength(after.config ?? '') > 1024 * 1024 || Buffer.byteLength(after.state ?? '') > 1024 * 1024)
    fail('LIMIT-EXCEEDED', 'Guard registration exceeds its publication bounds');
  const body = {
    format: 'ia.guard-registration-plan.v1' as const,
    root,
    id,
    request: cache ? { cache: cache.directory } : { remove: id },
    release: cache?.release ?? null,
    before: { config: pin(before.config), state: pin(before.state), projectConfig: pin(projectText) },
    after,
  };
  return { ...body, digest: digest(body) };
}
const current = (root: string, id: string): Side => ({
  config: read(root, configPath),
  state: read(root, statePath(id)),
});
function same(root: string, id: string, side: Side): void {
  if (json(current(root, id)) !== json(side))
    fail('LOCAL-MODIFICATION', 'Guard configuration or ownership changed during publication');
}
const write = (root: string, path: string, content: string | null): void =>
  replace(root, path, content === null ? null : Buffer.from(content));
export function applyGuardRegistration(
  input: unknown,
  checkpoint: (stage: string) => void = () => {},
): { status: 'guard-registered' | 'guard-removed'; id: string } {
  const row = object(input, ['format', 'root', 'id', 'request', 'release', 'before', 'after', 'digest']);
  if (row['format'] !== 'ia.guard-registration-plan.v1' || typeof row['root'] !== 'string')
    fail('INPUT-INVALID', 'Invalid guard registration plan');
  const root = workspace(row['root']),
    unlock = acquireHostRegistrationLock(root);
  try {
    const plan = planGuardRegistration(root, row['request'] as GuardRequest);
    if (json(plan) !== json(input)) fail('PLAN-STALE', 'Guard plan no longer matches its current inputs');
    const before = current(root, plan.id);
    write(
      root,
      pendingPath,
      json({ format: 'ia.guard-registration-pending.v1', id: plan.id, before, after: plan.after }),
    );
    checkpoint('pending');
    same(root, plan.id, before);
    write(root, configPath, plan.after.config);
    checkpoint('config');
    same(root, plan.id, { ...before, config: plan.after.config });
    if (
      pin(read(root, projectPath)) !== plan.before.projectConfig ||
      ('cache' in plan.request && verifyHostCache(plan.request.cache).release !== plan.release)
    )
      fail('PLAN-STALE', 'Project settings or host cache changed before registration commit');
    write(root, statePath(plan.id), plan.after.state);
    checkpoint('state');
    write(root, pendingPath, null);
    checkpoint('complete');
    return { status: 'cache' in plan.request ? 'guard-registered' : 'guard-removed', id: plan.id };
  } finally {
    unlock();
  }
}

/*
 * Hook groups (milestone generation-binding, plan amendments C9 and C10). Each authored `@hook` becomes exactly one
 * PreToolUse group in `.claude/settings.local.json`, which runs the launcher's guard mode for that hook,
 * `guard --root <root> --hook <identity>`, through the derivation the retired steward guard's group used. A JSON entry
 * cannot carry a marker line, so the groups are owned as that group was: by exact match against the group an ownership
 * state records (`claude-hooks-<id>.json`, beside the guard's state), published under the host lock through the same
 * journal (`guard-pending.json`, which every host write already waits on) and recovered by the same `recover-guard`.
 * Every other group, key and byte of the file is kept. `@hook` gains no field: the record's `hook.paths` decide what the
 * guard selects when it runs, and only its identity and tools reach the registration.
 */
/** The edit tools a hook group can match, in matcher order. */
export const HOOK_TOOLS = ['Write', 'Edit', 'MultiEdit'] as const;
export type HookTool = (typeof HOOK_TOOLS)[number];
const MAX_HOOKS = 64;
/** The ownership state of a registration's hook groups. */
export const hookStatePath = (id: string): string => `${area}/claude-hooks-${identity(id)}.json`;
/** One group to register: the authored `@hook`'s identity and the edit tools its matcher names. */
export interface HookRow {
  readonly identity: string;
  readonly tools: readonly HookTool[];
}
/** Register exactly `hooks` against a verified cache (an empty list removes every owned group), or remove them all. */
export type HookRequest = { readonly cache: string; readonly hooks: readonly HookRow[] } | { readonly remove: string };
export interface OwnedHook {
  readonly hook: string;
  readonly group: Group;
}
export interface HookState {
  readonly format: 'ia.hook-registration-state.v1';
  readonly id: string;
  readonly cache: string;
  readonly release: string;
  readonly created: boolean;
  /** One row per owned group, in identity order. */
  readonly groups: readonly OwnedHook[];
  readonly existing?: readonly JsonPath[];
}
/** What a plan does to one hook's group: `remove` also covers a group the user already deleted, whose ownership goes. */
export interface HookAction {
  readonly hook: string;
  readonly action: 'create' | 'update' | 'unchanged' | 'remove';
}
export interface HookPlan {
  readonly format: 'ia.hook-registration-plan.v1';
  readonly root: string;
  readonly id: string;
  /** The request as planned: rows in identity order, tools in matcher order. */
  readonly request: HookRequest;
  readonly release: string | null;
  readonly hooks: readonly HookAction[];
  readonly before: {
    readonly config: string | null;
    readonly state: string | null;
    readonly projectConfig: string | null;
  };
  readonly after: Side;
  readonly digest: string;
}
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
function hookIdentity(value: unknown): string {
  // The identities hook generation registers, which the guard's --hook accepts (workspace-runtime registrableHook).
  if (!registrableHook(value)) fail('INPUT-INVALID', 'Invalid hook identity');
  return value;
}
function hookTools(value: unknown): HookTool[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    value.some((tool) => !(HOOK_TOOLS as readonly unknown[]).includes(tool))
  )
    fail('INPUT-INVALID', 'Hook tools must name Write, Edit or MultiEdit, each at most once');
  return HOOK_TOOLS.filter((tool) => value.includes(tool));
}
/** A request's rows in identity order with tools in matcher order; a repeated identity is refused. */
function hookRows(value: unknown): HookRow[] {
  if (!Array.isArray(value) || value.length > MAX_HOOKS)
    fail('INPUT-INVALID', `Expected a list of at most ${MAX_HOOKS} hook rows`);
  const rows = value
    .map((item): HookRow => {
      const row = object(item, ['identity', 'tools']);
      return { identity: hookIdentity(row['identity']), tools: hookTools(row['tools']) };
    })
    .sort((a, b) => order(a.identity, b.identity));
  if (new Set(rows.map((row) => row.identity)).size !== rows.length)
    fail('INPUT-INVALID', 'Each hook is registered at most once');
  return rows;
}
/** The group a `@hook` registers: its matcher names the hook's tools, and the guard runs with this root and that identity. */
export function hookGroup(
  launcher: string,
  root: string,
  hook: HookRow,
  platform: NodeJS.Platform = process.platform,
): Group {
  return fixedGroup(
    hookTools(hook.tools).join('|'),
    launcher,
    ['--root', root, '--hook', hookIdentity(hook.identity)],
    platform,
  );
}
/**
 * A hook ownership state, or null for none. Each recorded group must be `hookGroup`'s derivation for the state's cache,
 * this root and its hook, in either form (`guardNode`), the recorded Node kept as written; a removal accepts the root
 * the group records, so a moved workspace can still remove what it registered.
 */
export function savedHooks(content: string | null, root: string, id: string, removal = false): HookState | null {
  if (content === null) return null;
  const value = plain(decodeDistributionJson(content)),
    row = object(value, [
      'format',
      'id',
      'cache',
      'release',
      'created',
      'groups',
      ...(Object.hasOwn(value, 'existing') ? ['existing'] : []),
    ]);
  if (
    row['format'] !== 'ia.hook-registration-state.v1' ||
    row['id'] !== id ||
    typeof row['cache'] !== 'string' ||
    !isAbsolute(row['cache']) ||
    typeof row['created'] !== 'boolean' ||
    !Array.isArray(row['groups']) ||
    row['groups'].length === 0 ||
    row['groups'].length > MAX_HOOKS
  )
    fail('INPUT-INVALID', 'Invalid hook ownership state');
  hash(row['release']);
  const launcher = join(row['cache'], 'scripts/ia.mjs');
  let previous = '';
  for (const item of row['groups'] as unknown[]) {
    const owned = object(item, ['hook', 'group']),
      hook = hookIdentity(owned['hook']);
    if (hook <= previous) fail('INPUT-INVALID', 'Hook ownership rows must be unique and in identity order');
    previous = hook;
    const group = object(owned['group'], ['matcher', 'hooks']);
    if (
      typeof group['matcher'] !== 'string' ||
      hookTools(group['matcher'].split('|')).join('|') !== group['matcher'] ||
      !Array.isArray(group['hooks']) ||
      group['hooks'].length !== 1
    )
      fail('INPUT-INVALID', 'Invalid owned hook group');
    const handler = object(group['hooks'][0], ['type', 'command', 'args', 'timeout']),
      recorded = Array.isArray(handler['args']) ? handler['args'].at(-3) : null,
      fixedRoot = removal && typeof recorded === 'string' && isAbsolute(recorded) ? recorded : root,
      node = guardNode(handler, launcher, fixedRoot, hook);
    if (
      handler['type'] !== 'command' ||
      typeof node !== 'string' ||
      !isAbsolute(node) ||
      handler['timeout'] !== GUARD_TIMEOUT
    )
      fail('INPUT-INVALID', 'Owned hook command differs from its fixed root');
  }
  keptPaths(row['existing'], containers);
  return row as unknown as HookState;
}
/** Plan the registration of exactly `request.hooks`, or the removal of every owned group. Reads only; writes nothing. */
export function planHookRegistration(rootInput: string, request: HookRequest): HookPlan {
  const root = workspace(rootInput);
  assertHostRegistrationIdle(root);
  const remove = Object.hasOwn(plain(request), 'remove'),
    row = object(request, remove ? ['remove'] : ['cache', 'hooks']);
  if (remove) return planHooksWith(root, null, [], row['remove']);
  const hooks = hookRows(row['hooks']);
  return planHooksWith(root, verifyHostCache(row['cache'] as string), hooks, null);
}
/** `planHookRegistration` against an expected, unverified cache (`expectedHostCache`); apply re-plans with verification. */
export function planHooksFor(rootInput: string, expected: HostCacheTarget, hooks: readonly HookRow[]): HookPlan {
  const root = workspace(rootInput);
  assertHostRegistrationIdle(root);
  return planHooksWith(root, expected, hookRows(hooks), null);
}
function planHooksWith(
  root: string,
  cache: HostCacheTarget | null,
  desired: readonly HookRow[],
  removeId: unknown,
): HookPlan {
  if (cache && cache.host !== null && cache.host !== 'claude')
    fail('HOST-UNSUPPORTED', 'Hook registration requires a Claude-compatible cache');
  if (cache) {
    const path = relative(cache.directory, root);
    if (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep))
      fail('PATH-UNSAFE', 'Consumer root cannot be inside its immutable host cache');
  }
  const id = cache ? HOST_REGISTRATION : identity(removeId),
    stateFile = hookStatePath(id);
  const before: Side = {
      config: read(root, configPath),
      state: locate(stateFile, () => read(root, stateFile)),
    },
    prior = locate(stateFile, () => savedHooks(before.state, root, id, cache === null));
  if (!cache && !prior) fail('INPUT-INVALID', 'Hook registration is not owned');
  const config = before.config === null ? {} : plain(decodeDistributionJson(before.config)),
    hooks = config['hooks'] === undefined ? {} : plain(config['hooks']);
  const projectText = read(root, projectPath),
    project = projectText === null ? {} : plain(decodeDistributionJson(projectText));
  if (
    desired.length > 0 &&
    (config['disableAllHooks'] === true ||
      (config['disableAllHooks'] === undefined && project['disableAllHooks'] === true))
  )
    fail('HOST-UNSUPPORTED', 'Project hooks are explicitly disabled by disableAllHooks');
  const rows: unknown[] = hooks['PreToolUse'] === undefined ? [] : (hooks['PreToolUse'] as unknown[]);
  if (!Array.isArray(rows) || rows.length > 256) fail('INPUT-INVALID', 'Expected a bounded PreToolUse hook array');
  const wanted = new Map(desired.map((row) => [row.identity, hookGroup(cache!.launcher, root, row)]));
  // Each owned group is found by exact match, exactly once. One the user already deleted, so that no group names its
  // hook any more, has only its ownership dropped, and only when the hook is no longer wanted, as the guard's removal
  // does; a changed or duplicated group refuses.
  const owned = (prior?.groups ?? []).map(({ hook, group }) => {
    const at = rows.flatMap((row, index) => (json(row) === json(group) ? [index] : []));
    const gone = at.length === 0 && !wanted.has(hook) && !rows.some((row) => guardInvocation(row) === hook);
    if (!gone && at.length !== 1) fail('LOCAL-MODIFICATION', `Owned hook group for ${hook} changed or was duplicated`);
    return { hook, group, at: at[0] ?? null };
  });
  const claimed = new Set(owned.flatMap(({ at }) => (at === null ? [] : [at])));
  for (const [hook, group] of wanted)
    if (rows.some((row, index) => !claimed.has(index) && json(row) === json(group)))
      fail('LOCAL-MODIFICATION', `An unmanaged identical hook group already exists for ${hook}`);
  // In place (spec §5.1): replace each owned group whose derivation changed at its own index, append each new one in
  // identity order, then remove the unwanted ones from the highest index down; every other byte is kept.
  const existing = prior ? keptPaths(prior.existing, containers) : presentJson(before.config, containers);
  let edited = before.config;
  for (const { hook, group, at } of owned)
    if (at !== null && wanted.has(hook) && json(group) !== json(wanted.get(hook)))
      edited = editJson(edited, ['hooks', 'PreToolUse', at], wanted.get(hook), existing);
  for (const [hook, group] of wanted)
    if (!owned.some((row) => row.hook === hook))
      edited = editJson(edited, ['hooks', 'PreToolUse', -1], group, existing);
  const removed = owned.filter(({ hook, at }) => at !== null && !wanted.has(hook)).sort((a, b) => b.at! - a.at!);
  for (const { at } of removed) edited = editJson(edited, ['hooks', 'PreToolUse', at!], undefined, existing);
  const created = prior?.created ?? before.config === null;
  const after: Side = {
    // A file the first registration created goes again once its last owned group is removed and it holds nothing else.
    config: wanted.size === 0 && removed.length > 0 && created && emptyJson(edited!) ? null : edited,
    state:
      wanted.size === 0
        ? null
        : json({
            format: 'ia.hook-registration-state.v1',
            id,
            cache: cache!.directory,
            release: cache!.release,
            created,
            groups: [...wanted].map(([hook, group]) => ({ hook, group })),
            ...(existing.length ? { existing } : {}),
          }),
  };
  if (Buffer.byteLength(after.config ?? '') > 1024 * 1024 || Buffer.byteLength(after.state ?? '') > 1024 * 1024)
    fail('LIMIT-EXCEEDED', 'Hook registration exceeds its publication bounds');
  const actions: HookAction[] = [
    ...[...wanted].map(([hook, group]): HookAction => {
      const prior = owned.find((row) => row.hook === hook);
      return {
        hook,
        action: prior === undefined ? 'create' : json(prior.group) === json(group) ? 'unchanged' : 'update',
      };
    }),
    ...owned.filter(({ hook }) => !wanted.has(hook)).map(({ hook }): HookAction => ({ hook, action: 'remove' })),
  ].sort((a, b) => order(a.hook, b.hook));
  const body = {
    format: 'ia.hook-registration-plan.v1' as const,
    root,
    id,
    request: cache ? { cache: cache.directory, hooks: [...desired] } : { remove: id },
    release: cache?.release ?? null,
    hooks: actions,
    before: { config: pin(before.config), state: pin(before.state), projectConfig: pin(projectText) },
    after,
  };
  return { ...body, digest: digest(body) };
}
/** The registration's hook ownership state as `savedHooks` reads it for this root, or null when it owns none. */
export function readHookRegistration(rootInput: string, id: string = HOST_REGISTRATION): HookState | null {
  const root = workspace(rootInput),
    stateFile = hookStatePath(id);
  return locate(stateFile, () => savedHooks(read(root, stateFile), root, id));
}
/** One owned or IA-looking hook group as the settings hold it now (`observeHookRegistration`). */
export interface HookDrift {
  readonly hook: string;
  /**
   * `missing`: an owned group is not in the settings; `modified`: a group runs that hook's guard but is not the owned
   * group byte for byte, or the owned group is there more than once; `foreign`: a group runs the guard for a hook this
   * registration does not own.
   */
  readonly drift: 'missing' | 'modified' | 'foreign';
}
/**
 * Read-only drift of the hook groups (doctor): each owned group found exactly once is current and not listed. Reads the
 * ownership state and `.claude/settings.local.json` as the planner does, so a file the planner would refuse to read
 * refuses here too, located at that file. Writes nothing.
 */
export function observeHookRegistration(rootInput: string, id: string = HOST_REGISTRATION): readonly HookDrift[] {
  const root = workspace(rootInput),
    state = readHookRegistration(root, id),
    text = read(root, configPath);
  const config = locate(configPath, () => (text === null ? {} : plain(decodeDistributionJson(text)))),
    hooks = config['hooks'] === undefined ? {} : plain(config['hooks']),
    rows: unknown[] = hooks['PreToolUse'] === undefined ? [] : (hooks['PreToolUse'] as unknown[]);
  if (!Array.isArray(rows)) fail('INPUT-INVALID', 'Expected PreToolUse hook array');
  const owned = state?.groups ?? [],
    drift: HookDrift[] = [];
  for (const { hook, group } of owned) {
    const exact = rows.filter((row) => json(row) === json(group)).length;
    if (exact === 1) continue;
    drift.push({
      hook,
      drift: exact > 1 || rows.some((row) => guardInvocation(row) === hook) ? 'modified' : 'missing',
    });
  }
  const ownedHooks = new Set(owned.map(({ hook }) => hook));
  for (const hook of new Set(rows.map(guardInvocation)))
    if (typeof hook === 'string' && !ownedHooks.has(hook)) drift.push({ hook, drift: 'foreign' });
  return drift.sort((a, b) => order(a.hook, b.hook));
}
/** The canonical JSON digest of an owned group, as a receipt's hook row records it. */
export const hookGroupDigest = (group: unknown): string => sha256(json(group));
/**
 * Apply a hook plan under the host lock: re-plan, refuse a stale plan, journal, write the settings, then the ownership
 * state (the commit), then clear the journal. A plan that changes nothing writes nothing. `checkpoint` runs after each
 * write, where an interruption test cuts; `recoverGuardRegistration` finishes or rolls back an interrupted one.
 */
export function applyHookRegistration(
  input: unknown,
  checkpoint: (stage: string) => void = () => {},
): { status: 'hooks-registered' | 'hooks-removed' | 'hooks-unchanged'; id: string } {
  const row = object(input, ['format', 'root', 'id', 'request', 'release', 'hooks', 'before', 'after', 'digest']);
  if (row['format'] !== 'ia.hook-registration-plan.v1' || typeof row['root'] !== 'string')
    fail('INPUT-INVALID', 'Invalid hook registration plan');
  const root = workspace(row['root']),
    unlock = acquireHostRegistrationLock(root);
  try {
    const plan = planHookRegistration(root, row['request'] as HookRequest);
    if (json(plan) !== json(input)) fail('PLAN-STALE', 'Hook plan no longer matches its current inputs');
    if (pin(plan.after.config) === plan.before.config && pin(plan.after.state) === plan.before.state)
      return { status: 'hooks-unchanged', id: plan.id };
    const stateFile = hookStatePath(plan.id),
      now = (): Side => ({ config: read(root, configPath), state: read(root, stateFile) });
    const unchanged = (side: Side): void => {
      if (json(now()) !== json(side))
        fail('LOCAL-MODIFICATION', 'Hook configuration or ownership changed during publication');
    };
    const before = now();
    write(
      root,
      pendingPath,
      json({ format: 'ia.hook-registration-pending.v1', id: plan.id, before, after: plan.after }),
    );
    checkpoint('pending');
    unchanged(before);
    write(root, configPath, plan.after.config);
    checkpoint('config');
    unchanged({ ...before, config: plan.after.config });
    if (
      pin(read(root, projectPath)) !== plan.before.projectConfig ||
      ('cache' in plan.request && verifyHostCache(plan.request.cache).release !== plan.release)
    )
      fail('PLAN-STALE', 'Project settings or host cache changed before registration commit');
    write(root, stateFile, plan.after.state);
    checkpoint('state');
    write(root, pendingPath, null);
    checkpoint('complete');
    return { status: plan.after.state === null ? 'hooks-removed' : 'hooks-registered', id: plan.id };
  } finally {
    unlock();
  }
}
export function recoverGuardRegistration(rootInput: string): { status: 'guard-recovered' | 'current' } {
  const root = workspace(rootInput),
    unlock = acquireHostRegistrationLock(root, true);
  try {
    if (read(root, area + '/pending.json', 8 * 1024 * 1024) !== null)
      fail('RECOVERY-REQUIRED', 'Run recover-host for pending MCP registration');
    if (read(root, area + '/lifecycle-pending.json', 8 * 1024 * 1024) !== null)
      fail('RECOVERY-REQUIRED', 'Run recover-lifecycle for the pending context registration');
    const content = read(root, pendingPath, 8 * 1024 * 1024);
    if (content === null) return { status: 'current' };
    const row = object(decodeDistributionJson(content), ['format', 'id', 'before', 'after']);
    // One journal serves both registrations this module publishes: the retired steward guard's and the hook groups'.
    const hooks = row['format'] === 'ia.hook-registration-pending.v1';
    if (row['format'] !== 'ia.guard-registration-pending.v1' && !hooks)
      fail('INPUT-INVALID', 'Unknown guard recovery format');
    const id = identity(row['id']),
      state = hooks ? hookStatePath(id) : statePath(id);
    const side = (value: unknown): Side => {
      const data = object(value, ['config', 'state']);
      for (const v of Object.values(data))
        if (!(v === null || (typeof v === 'string' && Buffer.byteLength(v) <= 1024 * 1024)))
          fail('INPUT-INVALID', 'Invalid guard recovery bytes');
      const result = data as unknown as Side;
      const removal = plain(row['after'])['state'] === null;
      if (hooks) savedHooks(result.state, root, id, removal);
      else saved(result.state, root, id, removal);
      if (result.config !== null) plain(decodeDistributionJson(result.config));
      return result;
    };
    const before = side(row['before']),
      after = side(row['after']),
      actual = { config: read(root, configPath), state: read(root, state) };
    if (![before.config, after.config].includes(actual.config) || ![before.state, after.state].includes(actual.state))
      fail('LOCAL-MODIFICATION', 'Unexpected local guard edit must be reconciled');
    const desired = actual.state === after.state ? after : before;
    write(root, configPath, desired.config);
    write(root, state, desired.state);
    write(root, pendingPath, null);
    return { status: 'guard-recovered' };
  } finally {
    unlock();
  }
}
/**
 * The script `/bin/sh` runs the guard with, on POSIX: Node and its arguments come in as `$0` and `$@`, never as script text,
 * and any failure to run the guard at all exits 2, naming the remedy on stderr, which Claude Code shows with the block.
 * Claude Code lets a tool call through when a hook command cannot start or fails any other way, and blocks only on exit 2 or
 * a deny (code.claude.com/docs/en/hooks); the guard's own decisions exit 0 and pass through unchanged. win32 has no
 * `/bin/sh` and keeps the direct form, which still fails open (#323).
 */
export const FAIL_CLOSED =
  '"$0" "$@" || { echo "IA steward guard could not run: run ia doctor, then ia host claude --apply" >&2; exit 2; }';
/**
 * Every script a released `guardGroup` has written, the current one first. A registration made with an earlier one stays an
 * owned registration, so plan, remove and doctor still read it and re-applying rewrites it (`currentGuardForm`); a script
 * this list does not hold is not one IA wrote. A change to `FAIL_CLOSED` MUST keep the previous script here.
 */
export const FAIL_CLOSED_ACCEPTED: readonly string[] = [FAIL_CLOSED, '"$0" "$@" || exit 2'];
/**
 * The Node a guard handler runs when its arguments are the fixed derivation for this launcher and root, and for `hook`
 * when one is given (a `@hook`'s group, `--hook <identity>` last): the direct form's command (win32, and registrations
 * made before the POSIX form), or the POSIX form's `$0` under any accepted script. Null for any other handler.
 */
export function guardNode(
  handler: { readonly command?: unknown; readonly args?: unknown },
  launcher: string,
  root: string,
  hook?: string,
): unknown {
  const fixed = [launcher, 'guard', '--root', root, ...(hook === undefined ? [] : ['--hook', hook])],
    direct = json(fixed),
    args = handler.args;
  if (!Array.isArray(args)) return null;
  if (json(args) === direct) return handler.command;
  return handler.command === '/bin/sh' &&
    args.length === 3 + fixed.length &&
    args[0] === '-c' &&
    FAIL_CLOSED_ACCEPTED.includes(args[1]) &&
    json(args.slice(3)) === direct
    ? args[2]
    : null;
}
/**
 * An owned guard handler is in the form `guardGroup` writes now on this platform: the direct form on win32, and elsewhere the
 * `/bin/sh` form with the current `FAIL_CLOSED` script. The direct form on POSIX fails open when its Node cannot run, and an
 * earlier script lacks what the current one adds; both still work, and re-applying rewrites them.
 */
export function currentGuardForm(
  handler: { readonly command?: unknown; readonly args?: unknown },
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === 'win32') return handler.command !== '/bin/sh';
  return handler.command === '/bin/sh' && Array.isArray(handler.args) && handler.args[1] === FAIL_CLOSED;
}
