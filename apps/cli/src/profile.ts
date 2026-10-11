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
 *
 * Read (`ia read`, `ia next`), validate (`ia validate`, `ia preview`), author (`ia author`) and effect (`ia capture`, its
 * `ia compile` alias, `ia project`) are gated; `ia position` is not, and neither is a command outside those modes. A gated
 * command's profile stays on the invocation's gate, so a refusal it raises later names only a command the same actor may
 * run there (`gatedNext`): one the profile refuses is replaced by the governance position, and one that needs the
 * actor named by `--actor` carries it.
 */
import type { ReadHandle } from '@inventarch/db';
import { defaultActor, governingMandates, MODE_MOVES, profileRefusal, RuntimeError } from '@inventarch/runtime';
import type { GoverningMandate, Mode, ProfileVerdict } from '@inventarch/runtime';
import type { Context } from './consumer.js';
import { Refusal, respell } from './consumer.js';
import { quote } from './render.js';
import { openSession } from './session.js';

/**
 * The gated commands and their modes; every other command, `ia position` included, is never gated, and `ia host` is
 * gated only as a workspace `--apply` (`hostMode`).
 */
export const GATED_MODES: Readonly<Record<string, Mode>> = Object.freeze({
  read: 'read',
  next: 'read',
  validate: 'validate',
  preview: 'validate',
  author: 'author',
  capture: 'effect',
  compile: 'effect',
  project: 'effect',
});
/**
 * Review C2-R7: `ia host <host> --apply` for a workspace is the effect mode; its plan, `--remove` and `--user` are never
 * gated.
 */
const hostMode = (argv: readonly string[]): Mode | undefined =>
  argv.includes('--apply') && !argv.includes('--remove') && !argv.includes('--user') ? 'effect' : undefined;
/** What a gated command's profile leaves on its invocation for the refusals it raises later. */
export interface GateState {
  readonly workspace?: string;
  readonly actor?: string;
  readonly by?: Profile['by'];
  /** The mandates that govern at the workspace for the actor, whatever path the command targets. */
  readonly mandates: readonly GoverningMandate[];
  /** ` --root <root>` as the invocation gave it, or nothing. */
  readonly rooted: string;
}
/** One invocation's gate: empty until a gated command's profile allows it. */
export interface Gate {
  state?: GateState;
}

export interface Profile {
  /** The repository's `@workspace`, when the workspace authors one. */
  readonly workspace?: string;
  /** The acting `@agent`; absent when the workspace names none and the command did not. */
  readonly actor?: string;
  /** What chose the actor: `--actor`, the workspace's `composition.steward`, or its one participant. */
  readonly by?: 'actor' | 'steward' | 'participant';
  /** The governing mandates the profile judged, by identity. */
  readonly mandates: readonly string[];
  /** The first governing mandate that binds the actor and grants the mode's move, by identity; absent when none governs. */
  readonly grantedBy?: string;
  /** Present when no mandate governs, so nothing is restricted. */
  readonly notice?: string;
}
export interface ProfileRequest {
  /** The open workspace; any reader, an editor snapshot included. */
  readonly reader: ReadHandle;
  /** A scope token of the whole workspace; it need not be clean. */
  readonly within: string;
  /** The invocation, so a next command carries what it supplied (design row 27). */
  readonly context: Pick<Context, 'command' | 'args' | 'gate'>;
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
  const governing = (actor: string | undefined, path: string | undefined): readonly GoverningMandate[] =>
    governingMandates(reader, within, {
      ...(actor === undefined ? {} : { actor }),
      ...(workspace === undefined ? {} : { workspace }),
      ...(path === undefined ? {} : { path }),
    });
  const judge = (actor: string | undefined): { mandates: readonly GoverningMandate[]; verdict: ProfileVerdict } => {
    const mandates = governing(actor, request.path);
    return { mandates, verdict: profileRefusal(mandates, mode, words) };
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
  /**
   * The next command after an `--actor` that names no participant (review C-N1): where the workspace's default actor may
   * run this command, the command without `--actor`; where it may not, the governance position; only where the choice
   * is open, the first participant allowed (`choose`).
   */
  const mistyped = (participants: readonly string[]): string => {
    const fallback = workspace === undefined ? undefined : defaultActor(reader, within, workspace);
    if (fallback?.actor !== undefined)
      return judge(fallback.actor).verdict.refusal === undefined
        ? `Run "${respell(context, { options: { actor: [] } })}" as the workspace's default actor, ${fallback.actor}.`
        : `Run "ia position --seat ${workspace} --shape governance${rooted}" for the workspace's participants and the mandates that bind them.`;
    return participants.length === 0
      ? `Run "${respell(context, { options: { actor: [] } })}" without naming an actor.`
      : choose(participants);
  };
  try {
    const spelled = context.args.value('actor');
    let actor: string | undefined, by: Profile['by'];
    if (spelled !== undefined) {
      const participants = workspace === undefined ? [] : defaultActor(reader, within, workspace).actors,
        named = namedAgent(reader, within, spelled);
      if (named === undefined || !participants.includes(named))
        throw new Refusal(
          'IA-RUNTIME-MANDATE-ACTOR',
          `${named ?? spelled} is not an authored participant of ${workspace ?? 'this repository, which authors no @workspace'}${
            participants.length === 0 ? '' : `; its participants are ${participants.join(', ')}`
          }`,
          1,
          workspace === undefined ? null : { identity: workspace },
          mistyped(participants),
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
          choose(fallback.actors),
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
      const unbound = verdict.refusal.code === 'IA-RUNTIME-MANDATE-ACTOR' && by !== 'actor' && workspace !== undefined;
      throw new Refusal(
        verdict.refusal.code,
        verdict.refusal.message,
        1,
        seat === undefined ? null : { identity: seat },
        unbound
          ? choose(defaultActor(reader, within, workspace).actors.filter((participant) => participant !== actor))
          : seat === undefined
            ? `Run "ia position${rooted}" for the repository's position and the mandates that govern it.`
            : `Run "ia position --seat ${seat} --shape governance${rooted}" for the mandates that govern here and what they allow.`,
      );
    }
    const move = MODE_MOVES[mode],
      granted = mandates.find(
        (mandate) => mandate.binds !== false && (mandate.moves === undefined || mandate.moves.includes(move)),
      );
    if (context.gate !== undefined)
      context.gate.state = Object.freeze({
        ...(workspace === undefined ? {} : { workspace }),
        ...(actor === undefined ? {} : { actor }),
        ...(by === undefined ? {} : { by }),
        mandates: request.path === undefined ? mandates : governing(actor, undefined),
        rooted,
      });
    return Object.freeze({
      ...(workspace === undefined ? {} : { workspace }),
      ...(actor === undefined ? {} : { actor }),
      ...(by === undefined ? {} : { by }),
      mandates: mandates.map((mandate) => mandate.identity),
      ...(granted === undefined ? {} : { grantedBy: granted.identity }),
      ...(verdict.notice === undefined ? {} : { notice: verdict.notice }),
    });
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'IA-RUNTIME-REQUEST-INVALID')
      throw unreadable(error, reader, within, workspace, rooted);
    throw error;
  }
}

/**
 * A gated command's profile for a mode, read through a session of its own: for a command whose workspace reads happen
 * inside services that open their own session, so the profile is judged before any of them.
 */
export function gateMode(context: Context, root: string, mode: Mode): Profile {
  const session = openSession(root);
  try {
    return requireProfile({ reader: session.reader, within: session.reader.resolveScope().token, context, mode });
  } finally {
    session.close();
  }
}

/**
 * Review C-R2: the characters a printed command may repeat from caller or authored input and stay inert pasted into sh,
 * PowerShell or cmd, inside the double quotes `quote()` adds for a space.
 */
const INERT = /^[A-Za-z0-9@+=:,./_~#\- ]*$/;
/**
 * Review C2-R8: a token as a printed command spells it. One with a space, or one opening a comment (`#`), a PowerShell
 * splat (`@`) or a tilde expansion (`~`), is double-quoted, which keeps those literal in sh, PowerShell and cmd; INERT has
 * already kept every character double quotes leave live out of it. The quotes are JSON's, as `quote()` spells every
 * printed argument, so the command parses as design row 27's other commands do.
 */
const spelled = (token: string): string => (/^[#@~]/.test(token) ? JSON.stringify(token) : quote(token));
/** The word a preview or author form names: a new record's word, or the owned record's `@word` or identity facet. */
function wordOf(args: Context['args']): string | undefined {
  const first = args.positionals[0] ?? '';
  if (!args.flag('relate') && !args.flag('set')) return /^[a-z][a-z0-9-]*$/.test(first) ? first : undefined;
  const reference = /^@([a-z][a-z0-9-]*)/.exec(first)?.[1],
    facet = first.split('/')[2];
  return reference ?? (facet !== undefined && /^[a-z][a-z0-9-]*$/.test(facet) ? facet : undefined);
}
/**
 * Review C-R2: a refusal of `ia preview` or `ia author`, or a mandate refusal of any command, whose next command would
 * repeat a value holding shell syntax (`$(...)`, a backtick, `%`, a quote, `;` and the like) names an inert command in its
 * place: the word's preview, keeping an `--actor` the command named, or else the repository's position. The `--root` value
 * is the invocation's own and is repeated as every command repeats it: only that value, as the option before any `--`, is
 * exempt (review C2-R8). Every token the command keeps is spelled by `spelled`, so a bare `#`, `@` or `~` token is quoted.
 */
export function inertNext(refusal: Refusal, context: Pick<Context, 'command' | 'args'>): Refusal {
  const verb = context.command.name;
  if (
    refusal.next === null ||
    (verb !== 'preview' && verb !== 'author' && !refusal.code.startsWith('IA-RUNTIME-MANDATE-'))
  )
    return refusal;
  const match = QUOTED.exec(refusal.next);
  if (match === null) return refusal;
  const argv = [...match[1]!.matchAll(ARGUMENT)].map((token) =>
    token[0].startsWith('"') ? (JSON.parse(token[0]) as string) : token[0],
  );
  const supplied = context.args.value('root'),
    end = argv.indexOf('--'),
    own = (index: number): boolean =>
      supplied !== undefined && argv[index - 1] === '--root' && (end === -1 || index < end) && argv[index] === supplied;
  if (argv.every((arg, index) => own(index) || INERT.test(arg))) {
    const command = argv.map((arg, index) => (own(index) ? quote(arg) : spelled(arg))).join(' ');
    return command === match[1]
      ? refusal
      : new Refusal(
          refusal.code,
          refusal.message,
          refusal.exit,
          refusal.where,
          refusal.next.replace(match[0], `"${command}"`),
          refusal.at,
        );
  }
  const rooted = supplied === undefined ? '' : ` --root ${quote(supplied)}`,
    at = argv.indexOf('--actor'),
    actor = at !== -1 && INERT.test(argv[at + 1] ?? '-') ? ` --actor ${spelled(argv[at + 1]!)}` : '',
    word = verb === 'preview' || verb === 'author' ? wordOf(context.args) : undefined;
  return new Refusal(
    refusal.code,
    refusal.message,
    refusal.exit,
    refusal.where,
    word === undefined
      ? `Run "ia position${rooted}" for the repository's position; the command this refusal names would repeat a value that holds shell syntax, so it is not printed.`
      : `Run "ia preview ${word}${actor}${rooted}" for what a @${word} record holds; the command this refusal names would repeat a value that holds shell syntax, so it is not printed.`,
    refusal.at,
  );
}

const ARGUMENT = /"(?:[^"\\]|\\.)*"|[^\s"]+/g;
const QUOTED = /"(ia(?: (?:"(?:[^"\\]|\\.)*"|[^\s"]+))*)"/;
/**
 * Design row 27 under the profile: the refusal a gated command raised, its next command judged by the profile that let
 * the command run. A next command of a gated mode the profile refuses (its move, or for `ia preview` and `ia author` the
 * word it names) becomes the governance position, which is never gated; one the profile allows carries `--actor` when the
 * command named its actor so. A refusal raised before any profile, or naming an ungated command, is returned as it is.
 */
export function gatedNext(refusal: Refusal, gate: Gate | undefined): Refusal {
  const state = gate?.state;
  if (state === undefined || refusal.next === null) return refusal;
  const match = QUOTED.exec(refusal.next);
  if (match === null) return refusal;
  const argv = [...match[1]!.matchAll(ARGUMENT)].map((token) =>
    token[0].startsWith('"') ? (JSON.parse(token[0]) as string) : token[0],
  );
  const verb = argv[1] ?? '',
    mode = verb === 'host' ? hostMode(argv) : GATED_MODES[verb];
  if (mode === undefined) return refusal;
  const word =
    (verb === 'preview' || verb === 'author') && !argv.includes('--relate') && !argv.includes('--set')
      ? argv.slice(2).find((token) => !token.startsWith('-'))
      : undefined;
  const verdict = profileRefusal(state.mandates, mode, word === undefined ? [] : [word]);
  if (verdict.refusal !== undefined) {
    const seat = seatOf(verdict.refusal.next) ?? state.workspace;
    const why = `${verb} needs ${MODE_MOVES[mode]}${word === undefined ? '' : ` and @${word}`}, which they do not grant${state.actor === undefined ? '' : ` ${state.actor}`}`;
    return new Refusal(
      refusal.code,
      refusal.message,
      refusal.exit,
      refusal.where,
      seat === undefined
        ? `Run "ia position${state.rooted}" for the repository's position and the mandates that govern it; ${why}.`
        : `Run "ia position --seat ${seat} --shape governance${state.rooted}" for what the mandates that govern here allow; ${why}.`,
      refusal.at,
    );
  }
  if (state.by !== 'actor' || state.actor === undefined || argv.includes('--actor')) return refusal;
  const actor = ` --actor ${quote(state.actor)}`;
  const command = match[1]!.includes(' -- ') ? match[1]!.replace(' -- ', `${actor} -- `) : `${match[1]}${actor}`;
  return new Refusal(
    refusal.code,
    refusal.message,
    refusal.exit,
    refusal.where,
    refusal.next.replace(match[0], `"${command}"`),
    refusal.at,
  );
}
