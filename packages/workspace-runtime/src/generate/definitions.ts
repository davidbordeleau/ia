import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import type { PacketDefinition, PacketHost } from '@inventarch/runtime';
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
  return frozen([
    ...authoredOf(records, 'operation').map(
      (node): PacketDefinition => ({
        identity: node.identity,
        word: 'operation',
        definition: {
          name: node.name,
          description: textsAt(node, 'meaning.says')[0] ?? '',
          handler: textsAt(node, 'execution.handler')[0],
          input: textsAt(node, 'execution.input')[0],
          output: textsAt(node, 'execution.output')[0],
          effects: textsAt(node, 'execution.effects'),
        },
      }),
    ),
    ...authoredOf(records, 'harness').map((node): PacketDefinition => {
      const profiles = targets(node, 'composition.profiles'),
        bindings = targets(node, 'composition.bindings');
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
        if (binding) for (const target of targets(binding, 'binding.target')) selected.add(target);
      }
      return {
        identity: node.identity,
        word: 'harness',
        definition: {
          name: node.name,
          description: textsAt(node, 'meaning.says')[0] ?? '',
          workspace: targets(node, 'composition.workspace')[0],
          hostProfile: textsAt(node, 'execution.host-profile')[0],
          profiles,
          bindings,
          registrations: {
            agents: agents
              .filter((file) => selected.has(file.identity))
              .map(({ identity, path }) => ({ identity, path })),
            skills: skills
              .filter((file) => selected.has(file.identity))
              .map(({ identity, path }) => ({ identity, path })),
            hooks: hooks.filter((hook) => selected.has(hook.identity)),
          },
        },
      };
    }),
  ]);
}
