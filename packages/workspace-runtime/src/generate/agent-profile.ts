import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import type { CompiledValue } from '@inventarch/language';
import { PACKET_MARKER } from '@inventarch/runtime';
import type { PacketHost } from '@inventarch/runtime';
import { inputFailure } from '../projection-format.js';
import { claudeProseCatalog, nativeValue, PROSE_EFFECT_TOOLS } from '../projection-host.js';
import { frozen } from '../resource-format.js';
import { fieldsOf, stated, textsAt, valuesAt } from '../record-fields.js';

/**
 * Generation of host agent files from authored `@agent-profile` records (milestone generation-binding, task
 * generation-agent-profile; plan amendments C5, C6 and C12). Each band-100 profile in the scope renders one claude
 * agent file, `.claude/agents/<profile name>.md`: YAML frontmatter naming the profile and describing its agent, the
 * packet's marker on its own line, then the profile's mandate bounds, voice, tools and delegates, read from the records
 * the profile's own fields reference. Codex renders none: a codex agent needs an entry in `.codex/config.toml`, which
 * holds the owned MCP block (C12). A profile below band 100, an installed or adopted base, renders nothing, and no
 * system steward does, a steward being an `@agent` (design §4); a workspace that authors public systems, as this
 * repository does, renders their profiles. The bytes are a function of the scope's records alone: no absolute path,
 * time or scope token is written.
 *
 * Nothing applies these files yet: milestone generation-binding task host-consumes-generated-set hands them to the one
 * projection writer, and adds the participant's governing mandate for a profile that names none.
 */

/** The words a generator renders records of. */
export type GeneratedWord = 'agent-profile';
/** One generated host file and the record it renders. */
export interface GeneratedFile {
  /** Workspace-relative and `/`-separated. */
  readonly path: string;
  readonly text: string;
  /** The identity of the rendered record. */
  readonly identity: string;
  readonly word: GeneratedWord;
}

/** Records the workspace itself authors; an installed or adopted base sits at a lower band. */
const AUTHORED = 100;
/**
 * The claude host's tool names by tool id, the prose catalog's default selections. The generated files carry no profile
 * pin, so the implementation digest the catalog requires is a placeholder that no file names.
 */
const CLAUDE_TOOLS: ReadonlyMap<string, string> = new Map(
  claudeProseCatalog('0'.repeat(64)).tools.map((tool) => [tool.id, tool.name]),
);

// The field readers are the package's shared ones (../record-fields.ts). The markup helpers mirror runtime's private ones
// (packet-host.ts's `inline` and `code`), which runtime does not export: a fix to either copy belongs in both.

/** `text` on one line: a line break and the blanks around it become one space, so each entry stays one line. */
const inline = (text: string): string => text.replace(/[ \t]*(?:\r\n|\r|\n)\s*/g, ' ');
/** `text` as one code span, its fence one backtick longer than the longest run inside, padded where one touches it. */
function code(text: string): string {
  const one = inline(text),
    fence = '`'.repeat(Math.max(0, ...(one.match(/`+/g) ?? []).map((run) => run.length)) + 1),
    pad = one.startsWith('`') || one.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${one}${pad}${fence}`;
}
/** A list's items, comma-separated, or `none`. */
const list = (items: readonly string[]): string => (items.length === 0 ? 'none' : items.join(', '));
const section = (heading: string, lines: readonly string[]): readonly string[] => ['', `## ${heading}`, '', ...lines];

/**
 * The agent files of the authored `@agent-profile` records the scope token `within` admits, by identity; none for
 * codex. An unknown host is IA-PROJECTION-INPUT-INVALID, and for either host an unknown or stale token keeps its
 * database code.
 */
export function generateAgentProfiles(reader: ReadHandle, within: string, host: PacketHost): readonly GeneratedFile[] {
  if (host !== 'claude' && host !== 'codex') inputFailure(`Unknown host: ${String(host)}`);
  // The token is read before the codex answer, so codex refuses a token claude would refuse.
  const records = reader.records({ within });
  if (host === 'codex') return frozen([]);
  const nodes = new Map(records.map((node) => [node.identity, node]));
  /** The admitted record a reference resolves to in the scope, or undefined. */
  const target = (value: CompiledValue): Node | undefined => {
    if (value.kind !== 'ref') return undefined;
    const resolved = reader.resolve(value, { within });
    return resolved.ok ? nodes.get(resolved.identity) : undefined;
  };
  /** A reference printed as the identity it resolves to, or as authored when none admitted answers it. */
  const named = (value: CompiledValue): string => code(target(value)?.identity ?? nativeValue(value));
  const profiles = records
    .filter((node) => node.discriminator === 'agent-profile' && node.band === AUTHORED)
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  return frozen(
    profiles.map((profile) => ({
      path: `.claude/agents/${profile.name}.md`,
      text: agentFile(profile, target, named),
      identity: profile.identity,
      word: 'agent-profile' as const,
    })),
  );
}

function agentFile(
  profile: Node,
  target: (value: CompiledValue) => Node | undefined,
  named: (value: CompiledValue) => string,
): string {
  const agent = valuesAt(profile, 'composition.agent')[0],
    agentNode = agent === undefined ? undefined : target(agent),
    says = textsAt(profile, 'meaning.says')[0],
    description = (agentNode === undefined ? undefined : textsAt(agentNode, 'meaning.says')[0]) ?? says ?? '';
  // Both frontmatter values are JSON-quoted, so a name YAML reads as a keyword (`true`, `null`) stays a string.
  const out = [
    '---',
    `name: ${JSON.stringify(profile.name)}`,
    `description: ${JSON.stringify(inline(description))}`,
    '---',
    '',
    PACKET_MARKER,
    '',
    `# ${profile.name}`,
    ...(says === undefined ? [] : ['', inline(says)]),
    '',
    `- profile ${code(profile.identity)}`,
    ...(agent === undefined
      ? []
      : [`- agent ${named(agent)}${agentNode === undefined ? ': not admitted in this scope' : ''}`]),
  ];

  // The mandate bounds: the authority and limits of the mandate the profile itself names.
  const mandate = valuesAt(profile, 'composition.mandate')[0],
    mandateNode = mandate === undefined ? undefined : target(mandate);
  out.push(
    ...section(
      'Mandate',
      mandate === undefined
        ? ['This profile names no mandate.']
        : mandateNode === undefined
          ? [`- ${named(mandate)}: not admitted in this scope`]
          : mandateLines(mandateNode, named),
    ),
  );

  const voice = valuesAt(profile, 'composition.voice')[0];
  if (voice !== undefined) {
    const voiceNode = target(voice);
    out.push(
      ...section('Voice', [
        `- ${named(voice)}${voiceNode === undefined ? ': not admitted in this scope' : ''}`,
        ...(voiceNode === undefined
          ? []
          : fieldsOf(voiceNode, 'communication').map((f) => `- ${f.key}: ${inline(nativeValue(f.value))}`)),
      ]),
    );
  }

  // The tools: each capability's operations, and the host tools its effects cover through the prose profiles' table.
  const capabilities = valuesAt(profile, 'composition.capabilities');
  out.push(
    ...section(
      'Tools',
      capabilities.length === 0
        ? ['This profile composes no capability.']
        : capabilities.map((capability) => {
            const node = target(capability);
            if (node === undefined) return `- ${named(capability)}: not admitted in this scope`;
            const effects = textsAt(node, 'execution.effects'),
              tools = [
                ...new Set(
                  effects
                    .flatMap((effect) => PROSE_EFFECT_TOOLS.get(effect) ?? [])
                    .map((id) => CLAUDE_TOOLS.get(id) ?? id),
                ),
              ];
            return `- ${code(node.identity)}: operations ${list(valuesAt(node, 'composition.operations').map(named))}; effects ${list(effects)}; host tools ${list(tools)}`;
          }),
    ),
  );

  const delegates = valuesAt(profile, 'composition.delegates');
  if (delegates.length > 0)
    out.push(
      ...section(
        'Delegates',
        delegates.map((delegate) => `- ${named(delegate)}`),
      ),
    );
  return `${out.join('\n')}\n`;
}

/** A mandate's identity, then each authority field and `execution.limit-*` it states, as authored. */
function mandateLines(mandate: Node, named: (value: CompiledValue) => string): readonly string[] {
  const lines = [`- ${code(mandate.identity)}`];
  const participant = valuesAt(mandate, 'authority.participant');
  if (participant.length > 0) lines.push(`- participant ${list(participant.map(named))}`);
  if (stated(mandate, 'authority.moves')) lines.push(`- moves ${list(textsAt(mandate, 'authority.moves'))}`);
  if (stated(mandate, 'authority.scope'))
    lines.push(`- scope ${list(valuesAt(mandate, 'authority.scope').map(named))}`);
  if (stated(mandate, 'authority.excluded-words'))
    lines.push(`- excluded words ${list(textsAt(mandate, 'authority.excluded-words'))}`);
  if (stated(mandate, 'authority.covers'))
    lines.push(`- covers ${list(textsAt(mandate, 'authority.covers').map(code))}`);
  for (const field of fieldsOf(mandate, 'execution'))
    if (field.key.startsWith('limit-')) lines.push(`- ${field.key} ${inline(nativeValue(field.value))}`);
  return lines;
}
