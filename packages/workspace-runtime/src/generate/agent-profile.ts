import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import type { CompiledValue } from '@inventarch/language';
import { defaultActor, governingMandates, PACKET_MARKER } from '@inventarch/runtime';
import type { PacketHost } from '@inventarch/runtime';
import { claudeProseCatalog, nativeValue, PROSE_EFFECT_TOOLS } from '../projection-host.js';
import { frozen } from '../resource-format.js';
import {
  authoredOf,
  code,
  fieldsOf,
  inline,
  knownHost,
  list,
  safeName,
  section,
  stated,
  textsAt,
  valuesAt,
} from './format.js';
import type { GeneratedFile } from './format.js';

/**
 * Generation of host agent files from authored `@agent-profile` records (milestone generation-binding, task
 * generation-agent-profile; plan amendments C5, C6 and C12). Each band-100 profile in the scope renders one claude
 * agent file, `.claude/agents/<profile name>.md`: YAML frontmatter naming the profile, describing its agent and listing
 * the host tools its capabilities allow, the packet's marker on its own line, then the profile's mandate bounds, voice,
 * tools and delegates, read from the records the profile's own fields reference. A profile whose capabilities allow no
 * host tool renders no file (task generation-playbook-skill): claude reads an agent with no tool list as one given every
 * tool and states no reading of an empty list, so only a file left unwritten grants nothing under every reading. Codex
 * renders none: a codex agent needs an entry in `.codex/config.toml`, which holds the owned MCP block (C12). A profile below band 100, an installed or adopted base, renders nothing, and no system
 * steward does, a steward being an `@agent` (design §4); a workspace that authors public systems, as this repository
 * does, renders their profiles. The bytes are a function of the scope's records alone: no absolute path, time or scope
 * token is written.
 *
 * Nothing applies these files yet: milestone generation-binding task host-consumes-generated-set hands them to the one
 * projection writer, and adds the participant's governing mandate for a profile that names none.
 */

/**
 * The claude host's tool names by tool id, the prose catalog's default selections. The generated files carry no profile
 * pin, so the implementation digest the catalog requires is a placeholder that no file names.
 */
const CLAUDE_TOOLS: ReadonlyMap<string, string> = new Map(
  claudeProseCatalog('0'.repeat(64)).tools.map((tool) => [tool.id, tool.name]),
);
/**
 * The claude names of the host tools `effects` cover through the prose profiles' table, in first-stated order, each
 * once. The same table is the ceiling `compileProjection` holds an agent's tools to.
 */
const hostTools = (effects: readonly string[]): readonly string[] => [
  ...new Set(effects.flatMap((effect) => PROSE_EFFECT_TOOLS.get(effect) ?? []).map((id) => CLAUDE_TOOLS.get(id) ?? id)),
];

/**
 * The agent files of the authored `@agent-profile` records the scope token `within` admits, by identity, leaving out a
 * profile whose admitted capabilities allow no host tool; none for codex. An unknown host is
 * IA-PROJECTION-INPUT-INVALID, and for either host an unknown or stale token keeps its database code.
 */
export function generateAgentProfiles(reader: ReadHandle, within: string, host: PacketHost): readonly GeneratedFile[] {
  knownHost(host);
  // The token is read before the codex answer, so codex refuses a token claude would refuse.
  const records = reader.records({ within });
  if (host === 'codex') return frozen([]);
  const nodes = new Map(records.map((node) => [node.identity, node]));
  const workspace = reader.resolveSeat('', { within }).seat;
  const participant =
    workspace !== undefined && nodes.get(workspace)?.discriminator === 'workspace'
      ? defaultActor(reader, within, workspace).actor
      : undefined;
  const fallback =
    participant === undefined || workspace === undefined
      ? []
      : governingMandates(reader, within, { workspace, actor: participant })
          .filter((mandate) => mandate.binds && mandate.participant === participant)
          .flatMap((mandate) => nodes.get(mandate.identity) ?? []);
  /** The admitted record a reference resolves to in the scope, or undefined. */
  const target = (value: CompiledValue): Node | undefined => {
    if (value.kind !== 'ref') return undefined;
    const resolved = reader.resolve(value, { within });
    return resolved.ok ? nodes.get(resolved.identity) : undefined;
  };
  /** A reference printed as the identity it resolves to, or as authored when none admitted answers it. */
  const named = (value: CompiledValue): string => code(target(value)?.identity ?? nativeValue(value));
  return frozen(
    authoredOf(records, 'agent-profile').flatMap((profile) => {
      // A capability no admitted record answers allows no tool: its effects are not read.
      const tools = hostTools(
        valuesAt(profile, 'composition.capabilities').flatMap((capability) => {
          const node = target(capability);
          return node === undefined ? [] : textsAt(node, 'execution.effects');
        }),
      );
      return tools.length === 0
        ? []
        : [
            {
              path: `.claude/agents/${safeName(profile.name)}.md`,
              text: agentFile(profile, tools, target, named, fallback),
              identity: profile.identity,
              word: 'agent-profile' as const,
            },
          ];
    }),
  );
}

function agentFile(
  profile: Node,
  tools: readonly string[],
  target: (value: CompiledValue) => Node | undefined,
  named: (value: CompiledValue) => string,
  fallback: readonly Node[],
): string {
  const agent = valuesAt(profile, 'composition.agent')[0],
    agentNode = agent === undefined ? undefined : target(agent),
    says = textsAt(profile, 'meaning.says')[0],
    description = (agentNode === undefined ? undefined : textsAt(agentNode, 'meaning.says')[0]) ?? says ?? '';
  // Every frontmatter value is JSON-quoted, so a name YAML reads as a keyword (`true`, `null`) stays a string; the
  // tools are one comma-separated string, as `compileProjection` writes an agent's.
  const out = [
    '---',
    `name: ${JSON.stringify(profile.name)}`,
    `description: ${JSON.stringify(inline(description))}`,
    `tools: ${JSON.stringify(tools.join(', '))}`,
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
        ? fallback.length === 0
          ? ['This profile names no mandate; no default participant mandate resolves.']
          : fallback.flatMap((node) => mandateLines(node, named))
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

  // The tools: each capability's operations, and the host tools its effects cover through the prose profiles' table. A
  // rendered profile composes at least one capability, the one that allows its tools.
  out.push(
    ...section(
      'Tools',
      valuesAt(profile, 'composition.capabilities').map((capability) => {
        const node = target(capability);
        if (node === undefined) return `- ${named(capability)}: not admitted in this scope`;
        const effects = textsAt(node, 'execution.effects');
        return `- ${code(node.identity)}: operations ${list(valuesAt(node, 'composition.operations').map(named))}; effects ${list(effects)}; host tools ${list(hostTools(effects))}`;
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
