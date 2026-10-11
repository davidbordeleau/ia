import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import type { CompiledValue } from '@inventarch/language';
import type { HarnessDefinition, OperationDefinition, PacketDefinition, PacketHost } from '@inventarch/runtime';
import { frozen } from '../resource-format.js';
import { authoredOf, capabilityClosure, knownHost, textsAt, valuesAt } from './format.js';
import { generateAgentProfiles } from './agent-profile.js';
import { generatePlaybookSkills } from './playbook.js';
import { generateHookSet } from './hook.js';

/**
 * Definitions of authored `@operation` and `@harness` records (milestone generation-binding, task
 * generation-operation-harness; plan amendment C11), for the receipt's `definitions` section. An operation's
 * `execution.handler`, `input` and `output` are catalog keys an installed implementation answers, copied as authored:
 * nothing here imports, resolves, serves or executes them (milestone 7 owns execution). A harness lists the registration
 * set its profiles and bindings select: the agent files rendered for its profiles, the skills rendered for the
 * playbooks their capabilities and every capability those include name, and the registered hooks its bindings target.
 * A record that renders or registers nothing for the host (an unsupported one, or any agent or hook for codex) selects
 * nothing, so hook or agent support never fails the definitions. Only authored (band 100) records are defined.
 */
export function generateDefinitions(reader: ReadHandle, within: string, host: PacketHost): readonly PacketDefinition[] {
  knownHost(host);
  const records = reader.records({ within }),
    nodes = new Map(records.map((node) => [node.identity, node]));
  const targets = (node: Node, field: string): readonly string[] =>
    reader
      .directedView(node.identity, { within })
      .filter((row) => row.kind === 'field-ref' && row.direction === 'out' && row.field === field)
      .map((row) => row.counterpart);
  const target = (value: CompiledValue): Node | undefined => {
    if (value.kind !== 'ref') return undefined;
    const resolved = reader.resolve(value, { within });
    return resolved.ok ? nodes.get(resolved.identity) : undefined;
  };
  const agents = generateAgentProfiles(reader, within, host).files,
    skills = generatePlaybookSkills(reader, within, host).files,
    hooks = generateHookSet(reader, within, host).hooks;
  const first = (node: Node, field: string): string | undefined => textsAt(node, field)[0];
  const operation = (node: Node): PacketDefinition => {
    const handler = first(node, 'execution.handler'),
      input = first(node, 'execution.input'),
      output = first(node, 'execution.output');
    const definition: OperationDefinition = {
      name: node.name,
      description: first(node, 'meaning.says') ?? '',
      ...(handler === undefined ? {} : { handler }),
      ...(input === undefined ? {} : { input }),
      ...(output === undefined ? {} : { output }),
      effects: textsAt(node, 'execution.effects'),
    };
    return { identity: node.identity, word: 'operation', definition };
  };
  const harness = (node: Node): PacketDefinition => {
    const profiles = targets(node, 'composition.profiles'),
      bindings = targets(node, 'composition.bindings'),
      workspace = targets(node, 'composition.workspace')[0],
      hostProfile = first(node, 'execution.host-profile');
    const selected = new Set(profiles);
    for (const id of profiles) {
      const profile = nodes.get(id);
      if (profile === undefined) continue;
      for (const capability of capabilityClosure(valuesAt(profile, 'composition.capabilities'), target))
        for (const playbook of targets(capability, 'composition.playbooks')) selected.add(playbook);
    }
    for (const id of bindings) {
      const binding = nodes.get(id);
      if (binding !== undefined) for (const bound of targets(binding, 'binding.target')) selected.add(bound);
    }
    const definition: HarnessDefinition = {
      name: node.name,
      description: first(node, 'meaning.says') ?? '',
      ...(workspace === undefined ? {} : { workspace }),
      ...(hostProfile === undefined ? {} : { hostProfile }),
      profiles,
      bindings,
      registrations: {
        agents: agents.filter((file) => selected.has(file.identity)).map(({ identity, path }) => ({ identity, path })),
        skills: skills.filter((file) => selected.has(file.identity)).map(({ identity, path }) => ({ identity, path })),
        hooks: hooks.filter((hook) => selected.has(hook.identity)),
      },
    };
    return { identity: node.identity, word: 'harness', definition };
  };
  return frozen([...authoredOf(records, 'operation').map(operation), ...authoredOf(records, 'harness').map(harness)]);
}
