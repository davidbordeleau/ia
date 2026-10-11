import type { ReadHandle } from '@inventarch/db';
import { isSelection } from '@inventarch/graph';
import type { Node } from '@inventarch/graph';
import type { HostHookDeclaration, PacketHost } from '@inventarch/runtime';
import { inputFailure } from '../projection-format.js';
import { frozen } from '../resource-format.js';
import { authoredOf, knownHost, safeName, textsAt } from './format.js';

const TOOLS = new Map([
  ['write', 'Write'],
  ['edit', 'Edit'],
  ['multiedit', 'MultiEdit'],
] as const);
/** Narrow the declaration to the edit events this guard can decide. Never interpret tool values as regex/shell. */
export function hookDeclaration(node: Node): HostHookDeclaration {
  safeName(node.name);
  const event = textsAt(node, 'hook.event')[0],
    tools = textsAt(node, 'hook.tools'),
    paths = textsAt(node, 'hook.paths'),
    message = textsAt(node, 'hook.message')[0];
  if (
    node.discriminator !== 'hook' ||
    node.band !== 100 ||
    event?.toLowerCase() !== 'pretooluse' ||
    tools.length === 0 ||
    tools.some((tool) => !TOOLS.has(tool.toLowerCase() as 'write')) ||
    paths.some((path) => !isSelection(path) || /[\u0000-\u001f]/.test(path)) ||
    message === undefined
  )
    inputFailure(
      `Unsupported or unsafe authored hook: ${node.identity}; use PreToolUse and Write, Edit or MultiEdit with relative path selections`,
    );
  return frozen({
    identity: node.identity,
    event: 'PreToolUse',
    tools: [...new Set(tools.map((tool) => TOOLS.get(tool.toLowerCase() as 'write')!))],
    paths,
    message,
  });
}
export function generateHooks(reader: ReadHandle, within: string, host: PacketHost): readonly HostHookDeclaration[] {
  knownHost(host);
  const hooks = authoredOf(reader.records({ within }), 'hook');
  return frozen(host === 'codex' ? [] : hooks.map(hookDeclaration));
}
