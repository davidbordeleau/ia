import type { ReadHandle } from '@inventarch/db';
import { isSelection } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import type { HostHookDeclaration, PacketHost } from '@inventarch/runtime';
import { inputFailure, ProjectionError } from '../projection-format.js';
import { frozen } from '../resource-format.js';
import { authoredOf, knownHost, textsAt } from './format.js';

const TOOLS = new Map([
  ['write', 'Write'],
  ['edit', 'Edit'],
  ['multiedit', 'MultiEdit'],
] as const);
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
  if (paths.some((path) => !isSelection(path) || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)))
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
/** An authored `@hook` the host cannot register, as the projection receipt's `unsupported` section reports one. */
export interface UnsupportedHook {
  readonly identity: string;
  readonly word: 'hook';
  readonly reason: string;
}
/** What a host registers of the workspace's authored hooks, and what it reports instead of registering. */
export interface HookSet {
  readonly hooks: readonly HostHookDeclaration[];
  readonly unsupported: readonly UnsupportedHook[];
}
/**
 * Every authored (band 100) `@hook`, by identity: each one `hookDeclaration` accepts is registered and each one it refuses
 * is reported with its reason, so one unsupported record never blocks the others (plan amendment C9). Codex registers
 * none and reports each (C12: Codex hooks are unsupported).
 */
export function generateHookSet(reader: ReadHandle, within: string, host: PacketHost): HookSet {
  knownHost(host);
  const hooks: HostHookDeclaration[] = [],
    unsupported: UnsupportedHook[] = [];
  for (const node of authoredOf(reader.records({ within }), 'hook')) {
    if (host === 'codex') {
      unsupported.push({ identity: node.identity, word: 'hook', reason: 'Codex hooks are unsupported' });
      continue;
    }
    try {
      hooks.push(hookDeclaration(node));
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
