import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import type { HarnessDefinition, OperationDefinition, PacketDefinition, PacketHost } from '@inventarch/runtime';
import { frozen } from '../resource-format.js';
import { authoredOf, knownHost, textsAt } from './format.js';
import { generateAgentProfiles } from './agent-profile.js';
import { generatePlaybookSkills } from './playbook.js';
import { generateHooks } from './hook.js';

/** Definitions only. Validator and implementation ids are metadata, never imported or executed. */
export function generateDefinitions(reader: ReadHandle, within: string, host: PacketHost): readonly PacketDefinition[] {
  knownHost(host);
  const records = reader.records({ within }),
    nodes = new Map(records.map((node) => [node.identity, node]));
  const targets = (node: Node, field: string): readonly string[] =>
    reader
      .directedView(node.identity, { within })
      .filter((row) => row.kind === 'field-ref' && row.direction === 'out' && row.field === field)
      .map((row) => row.counterpart);
  const agents = generateAgentProfiles(reader, within, host),
    skills = generatePlaybookSkills(reader, within, host),
    hooks = generateHooks(reader, within, host);
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
      if (!profile) continue;
      for (const capabilityId of targets(profile, 'composition.capabilities')) {
        const capability = nodes.get(capabilityId);
        if (capability) for (const playbook of targets(capability, 'composition.playbooks')) selected.add(playbook);
      }
    }
    for (const id of bindings) {
      const binding = nodes.get(id);
      if (binding) for (const bound of targets(binding, 'binding.target')) selected.add(bound);
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
