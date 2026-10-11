/**
 * The participant's mandate refusal profile for a consumer command: milestone generation-binding plan amendments C1 and
 * C19, and the continuation's lane C. One helper, so every gated mode judges the same way.
 *
 * The acting `@agent` is the one `--actor` names, which must be an authored participant of the repository's
 * `@workspace` (a mandate scoped to it names the agent as its participant, or the workspace names it as its
 * `composition.steward`); else the workspace's default actor (operator decision OD1). Naming an actor is a local
 * declaration, not authentication: it resolves a choice the workspace leaves open and never lifts a restriction, since the
 * chosen actor's mandates are judged exactly as the default actor's would be. The mandates that govern there (the
 * workspace's, and those whose `authority.covers` claims the command's target path) are judged for the mode's move and,
 * when the command authors or previews a word, for that word's exclusion (runtime `profileRefusal`).
 *
 * Every refusal names one next command that runs in the state that caused it: the command again with an `--actor` whose
 * mandates allow it, or the governance position of the mandate or workspace concerned. `ia position` is never gated,
 * so a position is always a command that runs. With no governing mandate nothing is restricted and the profile carries
 * the runtime's notice instead.
 */
import type { ReadHandle } from '@inventarch/db';
import { defaultActor, governingMandates, profileRefusal, RuntimeError } from '@inventarch/runtime';
import type { Mode, ProfileVerdict } from '@inventarch/runtime';
import type { Context } from './consumer.js';
import { Refusal, respell } from './consumer.js';
import { quote } from './render.js';

export interface Profile {
  /** The repository's `@workspace`, when the workspace authors one. */
  readonly workspace?: string;
  /** The acting `@agent`; absent when the workspace names none and the command did not. */
  readonly actor?: string;
  /** What chose the actor: `--actor`, the workspace's `composition.steward`, or its one participant. */
  readonly by?: 'actor' | 'steward' | 'participant';
  /** The governing mandates the profile judged, by identity. */
  readonly mandates: readonly string[];
  /** Present when no mandate governs, so nothing is restricted. */
  readonly notice?: string;
}
export interface ProfileRequest {
  /** The open workspace; any reader, an editor snapshot included. */
  readonly reader: ReadHandle;
  /** A scope token of the whole workspace; it need not be clean. */
  readonly within: string;
  /** The invocation, so a next command carries what it supplied (design row 27). */
  readonly context: Pick<Context, 'command' | 'args'>;
  readonly mode: Mode;
  /** The words the command authors or previews: excluded words apply to them. */
  readonly words?: readonly string[];
  /** The workspace-relative path the command targets: a mandate whose `authority.covers` claims it governs there. */
  readonly path?: string;
}

const rootedOf = (context: Pick<Context, 'args'>): string => {
  const supplied = context.args.value('root');
  return supplied === undefined ? '' : ` --root ${quote(supplied)}`;
};
/** The repository's own `@workspace`: the record position seats the repository root at, when it is one. */
export function repositoryWorkspace(reader: ReadHandle, within: string): string | undefined {
  const seat = reader.resolveSeat('', { within }).seat;
  return seat !== undefined && reader.get(seat, { within })?.discriminator === 'workspace' ? seat : undefined;
}
/** The `@agent` an `--actor` value names: a canonical identity, `@agent <name>`, or a bare name. */
function namedAgent(reader: ReadHandle, within: string, spelled: string): string | undefined {
  const value = spelled.trim();
  if (value.includes('/'))
    return reader.records({ within }).some((node) => node.identity === value && node.discriminator === 'agent')
      ? value
      : undefined;
  const name = value.startsWith('@agent ') ? value.slice('@agent '.length).trim() : value;
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(name)) return undefined;
  const resolved = reader.resolve({ kind: 'ref', discriminator: 'agent', name }, { within });
  return resolved.ok ? resolved.identity : undefined;
}
/**
 * The workspace's authored participants: the authored `@agent` records its scoped mandates name (the position packet's
 * participants), and its `composition.steward` when that is an authored `@agent`.
 */
export function participantsOf(reader: ReadHandle, within: string, workspace: string): readonly string[] {
  const named = defaultActor(reader, within, workspace),
    steward = named.by === 'steward' ? named.actor : undefined;
  return [
    ...new Set([
      ...named.participants,
      ...(steward !== undefined && reader.get(steward, { within })?.band === 100 ? [steward] : []),
    ]),
  ].sort();
}
/** The seat a runtime mandate refusal's next command (`ia position --seat <seat> --shape governance`) names. */
const seatOf = (next: string): string | undefined => /--seat (\S+)/.exec(next)?.[1];

/**
 * A governing mandate whose authority the runtime cannot read (IA-RUNTIME-REQUEST-INVALID, such as `authority.moves []`,
 * which admission accepts) refuses the command rather than failing it: the governance position of that mandate shows it
 * and is never gated.
 */
function unreadable(
  error: RuntimeError,
  reader: ReadHandle,
  within: string,
  workspace: string | undefined,
  rooted: string,
) {
  const message = error.message.replace(/^IA-RUNTIME-[A-Z-]+: /, '');
  const named = /^([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*): /.exec(message)?.[1];
  const seat = named !== undefined && reader.get(named, { within })?.discriminator === 'mandate' ? named : workspace;
  return new Refusal(
    error.code,
    `The mandate profile cannot be read: ${message}`,
    1,
    seat === undefined ? null : { identity: seat },
    seat === undefined
      ? `Run "ia position${rooted}" for the repository's position and the mandates it reads.`
      : `Run "ia position --seat ${seat} --shape governance${rooted}" to see the mandate authority the profile cannot read; correct it, then run this command again.`,
  );
}

/** The profile `request.mode` meets for its actor, or the refusal it gives (exit 1, IA-RUNTIME-MANDATE-*). */
export function requireProfile(request: ProfileRequest): Profile {
  const { reader, within, context, mode } = request,
    words = request.words ?? [],
    rooted = rootedOf(context),
    workspace = repositoryWorkspace(reader, within);
  const judge = (actor: string | undefined): { mandates: readonly string[]; verdict: ProfileVerdict } => {
    const mandates = governingMandates(reader, within, {
      ...(actor === undefined ? {} : { actor }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(request.path === undefined ? {} : { path: request.path }),
    });
    return { mandates: mandates.map((mandate) => mandate.identity), verdict: profileRefusal(mandates, mode, words) };
  };
  /** The next command after an open or refused actor choice: this one as the first participant allowed to run it. */
  const choose = (participants: readonly string[]): string => {
    const allowed = participants.find((participant) => judge(participant).verdict.refusal === undefined);
    if (allowed !== undefined)
      return `Run "${respell(context, { options: { actor: [allowed] } })}" to act as ${allowed}, a participant whose mandates allow it here.`;
    return workspace === undefined
      ? `Run "${respell(context, { options: { actor: [] } })}" without naming an actor; this repository authors no @workspace.`
      : `Run "ia position --seat ${workspace} --shape governance${rooted}" for the workspace's participants and the mandates that bind them; none of them may run this command here.`;
  };
  try {
    const spelled = context.args.value('actor');
    let actor: string | undefined, by: Profile['by'];
    if (spelled !== undefined) {
      const participants = workspace === undefined ? [] : participantsOf(reader, within, workspace),
        named = namedAgent(reader, within, spelled);
      if (named === undefined || !participants.includes(named))
        throw new Refusal(
          'IA-RUNTIME-MANDATE-ACTOR',
          `${named ?? spelled} is not an authored participant of ${workspace ?? 'this repository, which authors no @workspace'}${
            participants.length === 0 ? '' : `; its participants are ${participants.join(', ')}`
          }`,
          1,
          workspace === undefined ? null : { identity: workspace },
          participants.length === 0
            ? `Run "${respell(context, { options: { actor: [] } })}" without naming an actor.`
            : choose(participants),
        );
      actor = named;
      by = 'actor';
    } else if (workspace !== undefined) {
      const fallback = defaultActor(reader, within, workspace);
      if (fallback.refusal !== undefined)
        throw new Refusal(
          fallback.refusal.code,
          `${fallback.refusal.message}, or name the acting participant`,
          1,
          { identity: workspace },
          choose(participantsOf(reader, within, workspace)),
        );
      if (fallback.actor !== undefined) {
        actor = fallback.actor;
        by = fallback.by;
      }
    }
    const { mandates, verdict } = judge(actor);
    if (verdict.refusal !== undefined) {
      // The runtime names the governance position of the mandate concerned (design §11); the CLI spells that command
      // itself, with the root this invocation gave.
      const seat = seatOf(verdict.refusal.next) ?? workspace;
      throw new Refusal(
        verdict.refusal.code,
        verdict.refusal.message,
        1,
        seat === undefined ? null : { identity: seat },
        seat === undefined
          ? `Run "ia position${rooted}" for the repository's position and the mandates that govern it.`
          : `Run "ia position --seat ${seat} --shape governance${rooted}" for the mandates that govern here and what they allow.`,
      );
    }
    return Object.freeze({
      ...(workspace === undefined ? {} : { workspace }),
      ...(actor === undefined ? {} : { actor }),
      ...(by === undefined ? {} : { by }),
      mandates,
      ...(verdict.notice === undefined ? {} : { notice: verdict.notice }),
    });
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'IA-RUNTIME-REQUEST-INVALID')
      throw unreadable(error, reader, within, workspace, rooted);
    throw error;
  }
}
