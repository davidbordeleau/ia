import type { ReadHandle } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import { PHASES } from '@inventarch/language';
import type { Cell } from '@inventarch/language';
import { PACKET_MARKER } from '@inventarch/runtime';
import type { PacketHost } from '@inventarch/runtime';
import { inputFailure } from '../projection-format.js';
import { frozen } from '../resource-format.js';
import { authoredOf, code, inline, knownHost, safeName, section, textsAt } from './format.js';
import type { GeneratedFile } from './format.js';

/**
 * Generation of host skills from authored `@playbook` records (milestone generation-binding, task
 * generation-playbook-skill; plan amendments C6, C8 and C12). Each band-100 playbook in the scope renders one skill,
 * `.claude/skills/<playbook name>/SKILL.md` for claude and `.agents/skills/<playbook name>/SKILL.md` for codex, with the
 * same text for both: YAML frontmatter naming the playbook and describing it by its `meaning.says`, the packet's marker
 * on its own line, then one section per phase in the cycle order (orient, plan, act, learn) holding the playbook's
 * cells, the primary primitive's first. A phase with no cell is left out. A playbook below band 100, an installed or
 * adopted base, renders nothing (C8, operator decision OD3: public and adopted playbooks stay cells that `ia position`
 * delivers), and a workspace that authors public systems, as this repository does, renders their playbooks. The bytes
 * are a function of the playbook's record alone: no absolute path, time or scope token is written.
 *
 * Nothing applies these files yet: milestone generation-binding task host-consumes-generated-set hands them to the one
 * projection writer.
 */

/**
 * The name of the one skill the position packet renders for each host (runtime's packet-host.ts PATHS), which the
 * projection writer owns: a playbook of that name would render over it.
 */
const RESERVED = 'ia-authoring';
const SKILLS: Readonly<Record<PacketHost, string>> = { claude: '.claude/skills', codex: '.agents/skills' };

/**
 * The skills of the authored `@playbook` records the scope token `within` admits, by identity. An unknown host, and an
 * authored playbook named `ia-authoring`, are IA-PROJECTION-INPUT-INVALID; an unknown or stale token keeps its database
 * code.
 */
export function generatePlaybookSkills(reader: ReadHandle, within: string, host: PacketHost): readonly GeneratedFile[] {
  knownHost(host);
  const playbooks = authoredOf(reader.records({ within }), 'playbook');
  // A record's name is lowercase, so no spelling of the reserved name escapes this, on a case-insensitive file system
  // either.
  const reserved = playbooks.find((playbook) => playbook.name === RESERVED);
  if (reserved !== undefined)
    inputFailure(`Playbook ${reserved.identity} would render over the packet's ${RESERVED} skill; rename the playbook`);
  return frozen(
    playbooks.map((playbook) => ({
      path: `${SKILLS[host]}/${safeName(playbook.name)}/SKILL.md`,
      text: skillFile(playbook),
      identity: playbook.identity,
      word: 'playbook' as const,
    })),
  );
}

function skillFile(playbook: Node): string {
  // Both frontmatter values are JSON-quoted, so a name YAML reads as a keyword (`true`, `null`) stays a string.
  const out = [
    '---',
    `name: ${JSON.stringify(playbook.name)}`,
    `description: ${JSON.stringify(inline(textsAt(playbook, 'meaning.says')[0] ?? ''))}`,
    '---',
    '',
    PACKET_MARKER,
    '',
    `# ${playbook.name}`,
    '',
    `- playbook ${code(playbook.identity)}`,
  ];
  for (const phase of PHASES) {
    const cells = playbook.cells.filter((cell) => cell.phase === phase);
    // The primary primitive first, then each named primitive in authored order.
    if (cells.length > 0)
      out.push(
        ...section(phase, [...cells.filter((c) => c.primary), ...cells.filter((c) => !c.primary)].map(cellLine)),
      );
  }
  return `${out.join('\n')}\n`;
}

/** One cell: its primitive, marked when it is the phase's primary, its condition's terms as they read, and its text. */
const cellLine = (cell: Cell): string =>
  `- ${cell.primitive}${cell.primary ? ' (primary)' : ''}${
    cell.condition === undefined
      ? ''
      : ` (when ${cell.condition.map((term) => `${term.axis} is ${term.value}`).join(' and ')})`
  }: ${inline(cell.text)}`;
