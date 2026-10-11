import type { ReadHandle } from '@inventarch/db';
import { selects } from '@inventarch/graph';
import { RuntimeError } from './errors.js';
import { defaultActor, governingMandates, profileRefusal } from './mandate-modes.js';
import type { GoverningMandate, ProfileVerdict } from './mandate-modes.js';
import type { HostHookDeclaration } from './packet-host.js';
import type { HookCode } from './steward.js';
import { freeze } from './types.js';

/**
 * The `@mandate` edit guard (milestone generation-binding, plan amendment C10; operator decision OD4): whether one file
 * edit an authored `@hook` selects may proceed, decided from admitted records only. The caller (steward-hook's
 * `--hook` mode) owns the event, the path's safety and the hook record's admission as a declaration; this module only
 * reads the reader through the scope token, as evaluateSteward does for the retired steward guard.
 *
 * - A hook decides an edit when its tools name the event's tool and its `paths` select the file, or when the file is
 *   under `.ia/src`, the authored source tree that holds the hook, the mandates and the profiles the guard itself reads:
 *   no authored selection can leave the guard's own governing records open to the actors it restricts. Any other edit
 *   is allowed.
 * - The mandates that govern a decided edit are C1's (`governingMandates`) for the file's path, and for a file under
 *   `.ia/src` also those scoped to the repository's own `@workspace`. With none, nothing is restricted.
 * - The actor (OD4): an event that carries `agent_id` is a subagent, which acts as the `composition.agent` of the one
 *   authored `@agent-profile` whose name is its `agent_type`, and is refused when there is none. Any other event is the
 *   main session, a session launched with `--agent` included: it acts as the workspace's default actor (OD1).
 * - The edit is allowed when C1's profile allows the author mode (Synthesis) for that actor; otherwise it is refused
 *   with the hook's message and the profile's one next command, `ia position --seat <mandate> --shape governance`.
 *
 * Excluded words are not judged: the guard sees file bytes, not records, and `ia author` and `ia preview` enforce them.
 * Paths are matched in the G06c dialect (`selects`): `!`, `[` and every other character but `*`, `?` and `/` are
 * literal. `fold` (db `pathKey`) folds both a selection and the path where the volume folds names, for `hook.paths` and
 * `authority.covers` alike.
 */
export interface MandateGuardRequest {
  /** The authored hook the registration names, as hook generation declares it. */
  readonly hook: Pick<HostHookDeclaration, 'identity' | 'tools' | 'paths' | 'message'>;
  /** The event's `tool_name`. */
  readonly tool: string;
  /** Every workspace-relative spelling the caller resolved for the edited file, the canonical one first. */
  readonly paths: readonly string[];
  /** The event's `agent_id`, as received; present marks a subagent. */
  readonly agentId?: unknown;
  /** The event's `agent_type`, as received. */
  readonly agentType?: unknown;
  /** A key applied to a selection and a path before they are matched, for a volume that folds names. */
  readonly fold?: (text: string) => string;
}
export interface MandateGuardDecision {
  readonly allowed: boolean;
  /** Whether the hook decides the edit at all; an edit it does not select is allowed. */
  readonly selected: boolean;
  /** Present exactly when refused. */
  readonly code?: HookCode;
  readonly message: string;
  /** The `@agent` the edit acts as, once established. */
  readonly actor?: string;
  /** The one next command a refusal names. */
  readonly next?: string;
}

/** The authored source tree; the guard decides every edit under it (see above). */
export const GUARDED_SOURCES = '.ia/src/';
const LIMIT = 512;
const governance = (seat: string): string => `ia position --seat ${seat} --shape governance`;
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether the hook decides the edit: its tools name the tool, and its paths or the authored source tree select a spelling. */
export function mandateGuardSelects(request: MandateGuardRequest): boolean {
  const fold = request.fold ?? ((text: string) => text);
  if (!request.hook.tools.includes(request.tool as 'Write')) return false;
  return request.paths.some(
    (path) =>
      selects(fold(GUARDED_SOURCES), fold(path)) ||
      request.hook.paths.some((selection) => selects(fold(selection), fold(path))),
  );
}

type Acting = { readonly agent?: string; readonly as: string } | { readonly refusal: string; readonly next?: string };

/** OD4's actor, through the scope token `within`; `workspace` is the repository's own `@workspace`, if one. */
function acting(
  reader: ReadHandle,
  within: string,
  request: MandateGuardRequest,
  workspace: string | undefined,
): Acting {
  const { agentId, agentType } = request;
  if (agentId !== undefined) {
    if (typeof agentId !== 'string' || agentId === '' || agentId.length > LIMIT)
      return { refusal: 'the subagent event carries a malformed agent_id' };
    if (typeof agentType !== 'string' || agentType === '' || agentType.length > LIMIT)
      return { refusal: 'the subagent event names no agent_type' };
    const profiles = reader
      .records({ within })
      .filter((node) => node.discriminator === 'agent-profile' && node.band === 100 && node.name === agentType);
    if (profiles.length !== 1)
      return { refusal: `subagent ${agentType} matches no single authored @agent-profile of that name` };
    const profile = profiles[0]!.identity;
    const agents = reader
      .directedView(profile, { within })
      .filter(
        (row) =>
          row.kind === 'field-ref' &&
          row.direction === 'out' &&
          row.field === 'composition.agent' &&
          reader.get(row.counterpart, { within })?.discriminator === 'agent',
      )
      .map((row) => row.counterpart);
    if (agents.length !== 1) return { refusal: `${profile} names no admitted composition.agent` };
    return { agent: agents[0]!, as: `subagent ${agentType} acts as ${agents[0]!} (${profile})` };
  }
  if (workspace === undefined)
    return { as: 'the main session has no default actor: the repository names no single @workspace' };
  const fallback = defaultActor(reader, within, workspace);
  if (fallback.refusal !== undefined) return { refusal: fallback.refusal.message, next: fallback.refusal.next };
  return fallback.actor === undefined
    ? { as: `the main session has no default actor: ${fallback.reason!}` }
    : { agent: fallback.actor, as: `the main session acts as ${fallback.actor}` };
}

/** Decide one edit (see the module comment). A mandate whose authority cannot be read refuses as IA-HOOK-MANDATE-UNAVAILABLE. */
export function evaluateMandateGuard(
  reader: ReadHandle,
  within: string,
  request: MandateGuardRequest,
): MandateGuardDecision {
  const { hook } = request,
    paths = [...new Set(request.paths)],
    fold = request.fold ?? ((text: string) => text);
  if (!mandateGuardSelects({ ...request, paths }))
    return freeze({ allowed: true, selected: false, message: `${hook.identity} does not select this edit` });
  const deny = (code: HookCode, why: string, next: string, actor?: string): MandateGuardDecision =>
    freeze({
      allowed: false,
      selected: true,
      code,
      message: `${hook.message} (${hook.identity}: ${why}) Next: ${next}`,
      next,
      ...(actor === undefined ? {} : { actor }),
    });
  try {
    const repository = reader.resolveSeat('', { within }).seat,
      workspace =
        repository !== undefined && reader.get(repository, { within })?.discriminator === 'workspace'
          ? repository
          : undefined;
    const sources = paths.some((path) => selects(fold(GUARDED_SOURCES), fold(path)));
    // C1 for the path, and for the authored source tree the workspace's own mandates too; one row per mandate.
    const locate = (actor?: string): readonly GoverningMandate[] => {
      const found = new Map<string, GoverningMandate>();
      for (const path of paths)
        for (const mandate of governingMandates(reader, within, {
          path,
          ...(request.fold === undefined ? {} : { fold: request.fold }),
          ...(actor === undefined ? {} : { actor }),
          ...(sources && workspace !== undefined ? { workspace } : {}),
        }))
          if (!found.has(mandate.identity)) found.set(mandate.identity, mandate);
      return [...found.values()].sort((a, b) => order(a.identity, b.identity));
    };
    const governing = locate();
    if (governing.length === 0)
      return freeze({
        allowed: true,
        selected: true,
        message: `no authored @mandate governs ${paths[0]}, so ${hook.identity} restricts nothing there`,
      });
    const actor = acting(reader, within, request, workspace),
      first = governance(governing[0]!.identity);
    if ('refusal' in actor) return deny('IA-HOOK-IDENTITY-UNAVAILABLE', actor.refusal, actor.next ?? first);
    let verdict: ProfileVerdict;
    if (actor.agent === undefined) {
      // No actor to bind: a mandate that names a participant cannot be satisfied, and only participant-less ones judge.
      const named = governing.find((mandate) => mandate.participant !== undefined);
      if (named !== undefined)
        return deny(
          'IA-HOOK-IDENTITY-UNAVAILABLE',
          `${actor.as}; ${named.identity} binds ${named.participant}`,
          governance(named.identity),
        );
      verdict = profileRefusal(governing, 'author');
    } else verdict = profileRefusal(locate(actor.agent), 'author');
    if (verdict.refusal !== undefined)
      return deny('IA-HOOK-NOT-MANDATED', `${actor.as}; ${verdict.refusal.message}`, verdict.refusal.next, actor.agent);
    return freeze({
      allowed: true,
      selected: true,
      message: `${actor.as}, which a governing mandate allows to author here`,
      ...(actor.agent === undefined ? {} : { actor: actor.agent }),
    });
  } catch (error) {
    if (!(error instanceof RuntimeError)) throw error;
    return freeze({
      allowed: false,
      selected: true,
      code: 'IA-HOOK-MANDATE-UNAVAILABLE',
      message: `${hook.message} (${hook.identity}: the mandates that govern this edit cannot be read: ${error.message}) Next: ia validate`,
      next: 'ia validate',
    });
  }
}
