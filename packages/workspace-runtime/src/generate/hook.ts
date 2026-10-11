import type { ReadHandle } from '@inventarch/db';
import { isSelection } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import type { HostHookDeclaration, PacketHost } from '@inventarch/runtime';
import { inputFailure, ProjectionError } from '../projection-format.js';
import { frozen } from '../resource-format.js';
import { authoredOf, knownHost, textsAt } from './format.js';
import type { UnsupportedRecord } from './format.js';

const TOOLS = new Map([
  ['write', 'Write'],
  ['edit', 'Edit'],
  ['multiedit', 'MultiEdit'],
] as const);
/**
 * The characters no registered selection may hold: every C0 and C1 control, DEL, the Unicode line and paragraph
 * separators and the bidirectional controls (built from a string, which names them).
 */
const CONTROL = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]',
);
/**
 * The identities a hook registration can carry on the guard's command line: a canonical `system/kind/facet/name` of the
 * language's lower-cased name characters, bounded. Every admitted record's identity has this shape (its name is
 * `[A-Za-z][A-Za-z0-9-]*`, lower-cased), so only the bound can refuse one. A hook's name is not a host path, so no
 * portable-name rule applies to it.
 */
export const HOOK_IDENTITY = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*){3}$/;
export const HOOK_IDENTITY_LIMIT = 512;
export const registrableHook = (identity: unknown): identity is string =>
  typeof identity === 'string' && identity.length <= HOOK_IDENTITY_LIMIT && HOOK_IDENTITY.test(identity);
/**
 * The bounds a registration holds (review finding H-N2): at most `HOOK_LIMIT` hooks, each with one to
 * `HOOK_SELECTION_LIMIT` selections of at most `HOOK_SELECTION_LENGTH` characters. Generation applies them, so a hook
 * beyond them is an unsupported row rather than a refusal of the whole registration; distribution's hook registration
 * holds its rows to the same ones.
 */
export const HOOK_LIMIT = 64;
export const HOOK_SELECTION_LIMIT = 64;
export const HOOK_SELECTION_LENGTH = 512;
/**
 * A selection a registration can record: a workspace-relative G06c selection written with `/`, none empty, absolute,
 * escaping or holding a `.` or `..` segment, an empty segment but a trailing one, a backslash or a control, and at most
 * `HOOK_SELECTION_LENGTH` characters.
 */
export const registrableSelection = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length > 0 &&
  path.length <= HOOK_SELECTION_LENGTH &&
  isSelection(path) &&
  !path.includes('\\') &&
  !path.startsWith('/') &&
  !/^[A-Za-z]:/.test(path) &&
  !CONTROL.test(path) &&
  !path
    .split('/')
    .some((segment, at, all) => (segment === '' && at < all.length - 1) || segment === '.' || segment === '..');
/**
 * Narrow an authored `@hook` to the edit events the `@mandate` guard can decide: PreToolUse, one or more of Write, Edit
 * and MultiEdit, one or more workspace-relative path selections written with `/`, and a message. A hook that selects no
 * path could never deny, so it is refused rather than registered as a guard that guards nothing. Tool values are never
 * read as a regex or shell text, and nothing authored but the identity and the tools reaches a registration.
 * IA-PROJECTION-INPUT-INVALID names what is unsupported.
 */
export function hookDeclaration(node: Node): HostHookDeclaration {
  const unsupported = (why: string): never =>
    inputFailure(`Unsupported authored hook ${node.identity}: ${why}; the edit guard decides PreToolUse edits only`);
  if (node.discriminator !== 'hook' || node.band !== 100) unsupported('not an authored @hook');
  if (!registrableHook(node.identity))
    unsupported(`its identity exceeds the ${HOOK_IDENTITY_LIMIT} characters a registration carries`);
  const event = textsAt(node, 'hook.event')[0],
    tools = textsAt(node, 'hook.tools'),
    paths = textsAt(node, 'hook.paths'),
    message = textsAt(node, 'hook.message')[0];
  if (event?.toLowerCase() !== 'pretooluse') unsupported(`event ${event ?? 'none'} is not PreToolUse`);
  if (tools.length === 0 || tools.some((tool) => !TOOLS.has(tool.toLowerCase() as 'write')))
    unsupported('hook.tools must name Write, Edit or MultiEdit');
  if (paths.length === 0) unsupported('hook.paths selects no path, so the hook could never deny');
  if (paths.length > HOOK_SELECTION_LIMIT)
    unsupported(
      `hook.paths holds ${paths.length} selections, and a registration records at most ${HOOK_SELECTION_LIMIT}`,
    );
  if (paths.some((path) => path.length > HOOK_SELECTION_LENGTH))
    unsupported(
      `hook.paths holds a selection longer than the ${HOOK_SELECTION_LENGTH} characters a registration records`,
    );
  if (paths.some((path) => !registrableSelection(path)))
    unsupported('hook.paths must hold workspace-relative path selections written with /');
  if (message === undefined || message.trim() === '') unsupported('hook.message is required and not blank');
  return frozen({
    identity: node.identity,
    event: 'PreToolUse',
    tools: [...new Set(tools.map((tool) => TOOLS.get(tool.toLowerCase() as 'write')!))],
    paths,
    message: message!,
  });
}
/** What a host registers of the workspace's authored hooks, and what it reports instead of registering. */
export interface HookSet {
  readonly hooks: readonly HostHookDeclaration[];
  readonly unsupported: readonly UnsupportedRecord[];
}
/**
 * Every authored (band 100) `@hook`, by identity: each one `hookDeclaration` accepts is registered and each one it refuses
 * is reported with its reason, so one unsupported record never blocks the others (plan amendment C9); past the first
 * `HOOK_LIMIT` accepted hooks, each is reported, since a registration holds no more (review finding H-N2). Codex
 * registers none and reports each (C12: Codex hooks are unsupported).
 */
export function generateHookSet(reader: ReadHandle, within: string, host: PacketHost): HookSet {
  knownHost(host);
  const hooks: HostHookDeclaration[] = [],
    unsupported: UnsupportedRecord[] = [];
  for (const node of authoredOf(reader.records({ within }), 'hook')) {
    if (host === 'codex') {
      unsupported.push({ identity: node.identity, word: 'hook', reason: 'Codex hooks are unsupported' });
      continue;
    }
    try {
      const declaration = hookDeclaration(node);
      if (hooks.length === HOOK_LIMIT)
        unsupported.push({
          identity: node.identity,
          word: 'hook',
          reason: `Unsupported authored hook ${node.identity}: a registration holds at most ${HOOK_LIMIT} hooks, and ${HOOK_LIMIT} come before it`,
        });
      else hooks.push(declaration);
    } catch (error) {
      if (!(error instanceof ProjectionError)) throw error;
      unsupported.push({ identity: node.identity, word: 'hook', reason: error.message });
    }
  }
  return frozen({ hooks, unsupported });
}
/** The authored hooks a host registers (`generateHookSet`'s supported ones). */
export function generateHooks(reader: ReadHandle, within: string, host: PacketHost): readonly HostHookDeclaration[] {
  return generateHookSet(reader, within, host).hooks;
}
