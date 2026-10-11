import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { open } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { PACKET_MARKER } from '@inventarch/runtime';
import { adoptWorkspace } from '../src/corpus.js';
import {
  generateDefinitions,
  generateHooks,
  generateHookSet,
  generatePlaybookSkills,
  hookDeclaration,
} from '../src/generate/index.js';

// Milestone generation-binding task generation-playbook-skill (plan amendments C8 and C12): the authored `@playbook` of
// apps/cli's composition fixture renders one skill per host. The fixture's `.ia/src` is laid over the conformance
// corpus adopted at band 90, as an installed base would be, so its records are the authored ones and the corpus's own
// playbook is an adopted one.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repository = resolve(import.meta.dirname, '../../..'),
  FIXTURE = resolve(repository, 'apps/cli/tests/fixtures/composition-workspace/.ia/src'),
  NATIVE = resolve(repository, 'examples/conformance/native'),
  PLAYBOOK = readFileSync(resolve(FIXTURE, 'playbook.ia'), 'utf8'),
  IDENTITY = 'governance-system/definition/procedure/note-review',
  temporary = mkdtempSync(join(tmpdir(), 'ia-generate-')),
  handles: Handle[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};
/**
 * The fixture over the adopted conformance corpus: `authored` replaces or adds files under the workspace root, and
 * `adopted` adds files to the base before it is pinned. Admission must find no error.
 */
function fixture(
  authored: Readonly<Record<string, string | null>> = {},
  adopted: Readonly<Record<string, string>> = {},
): { readonly root: string; readonly db: Handle; readonly within: string } {
  const base = mkdtempSync(join(temporary, 'w-')),
    root = join(base, 'root'),
    vendor = join(base, 'vendor');
  cpSync(NATIVE, join(vendor, '.ia/src'), { recursive: true });
  for (const [path, text] of Object.entries(adopted)) put(vendor, path, text);
  cpSync(FIXTURE, join(root, '.ia/src'), { recursive: true });
  for (const [path, text] of Object.entries(authored))
    if (text === null) rmSync(resolve(root, path));
    else put(root, path, text);
  const db = open(root, { cache: false, adopted: [adoptWorkspace(vendor, 'foundation')] });
  handles.push(db);
  expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  return { root, db, within: db.resolveScope().token };
}

const SKILL = `---
name: "note-review"
description: "Review one of the demo workspace's notes and report what the review finds."
---

${PACKET_MARKER}

# note-review

- playbook \`${IDENTITY}\`

## orient

- Memory (primary): Recall the findings already reported on the note.
- Attention: Notice which records the note cites.

## plan

- Inference (primary): Infer which of the note's claims its cited records can confirm.
- Decision: Decide which claims to check first.

## act

- Decision (primary): Report each finding with the record and field behind it.
- Escalation (when severity is blocking): Name the demo participant before reporting a blocking finding.

## learn

- Learning (primary): Record what the review did not check.
`;

it('renders the fixture playbook as one claude skill with its four phase sections in cycle order', () => {
  const { db, within } = fixture(),
    files = generatePlaybookSkills(db, within, 'claude');
  // The adopted corpus's own playbook renders nothing.
  expect(files).toEqual([
    { path: '.claude/skills/note-review/SKILL.md', text: SKILL, identity: IDENTITY, word: 'playbook' },
  ]);
  expect(Object.isFrozen(files) && Object.isFrozen(files[0])).toBe(true);
  // Frontmatter first, describing the playbook by its meaning; the marker next, on its own line.
  const lines = files[0]!.text.split('\n');
  expect(lines.slice(0, 4)).toEqual([
    '---',
    'name: "note-review"',
    `description: ${JSON.stringify("Review one of the demo workspace's notes and report what the review finds.")}`,
    '---',
  ]);
  expect(lines.slice(4, 7)).toEqual(['', PACKET_MARKER, '']);
  expect(lines.filter((line) => line === PACKET_MARKER)).toHaveLength(1);
  expect(lines.filter((line) => line.startsWith('## '))).toEqual(['## orient', '## plan', '## act', '## learn']);
});

it('renders the same skill for codex under .agents/skills', () => {
  const { db, within } = fixture();
  expect(generatePlaybookSkills(db, within, 'codex')).toEqual([
    { path: '.agents/skills/note-review/SKILL.md', text: SKILL, identity: IDENTITY, word: 'playbook' },
  ]);
});

it('keeps each condition, lists a phase without a primary as authored, and leaves out a phase with no cell', () => {
  // An inline condition and a child when both read as their terms; a multi-paragraph cell is printed on one line.
  // Authored act before orient, with no plan or learn: the sections follow the cycle, and only phases with cells show.
  const playbook = [
    '#! ia 1.0',
    '',
    '@playbook triage',
    '  meaning',
    '    says """',
    '      Triage a note.',
    '',
    '      Escalate what blocks.',
    '    """',
    '    answers "How is a note triaged?"',
    '  cognition',
    '    act',
    '      Escalation means "Escalate a blocking note." when shape is governance and severity is blocking',
    '      Decision means "Decide the next step."',
    '        when phase is act',
    '    orient',
    '      primary Attention',
    '      Memory means """',
    '        Recall the note.',
    '',
    '        Say what it cites.',
    '      """',
    '      Attention means "Read the note."',
    '',
  ].join('\n');
  const { db, within } = fixture({ '.ia/src/triage.ia': playbook }),
    files = generatePlaybookSkills(db, within, 'claude');
  expect(files.map((file) => file.path)).toEqual([
    '.claude/skills/note-review/SKILL.md',
    '.claude/skills/triage/SKILL.md',
  ]);
  expect(files[1]!.text).toBe(`---
name: "triage"
description: "Triage a note. Escalate what blocks."
---

${PACKET_MARKER}

# triage

- playbook \`governance-system/definition/procedure/triage\`

## orient

- Attention (primary): Read the note.
- Memory: Recall the note. Say what it cites.

## act

- Escalation (when shape is governance and severity is blocking): Escalate a blocking note.
- Decision (when phase is act): Decide the next step.
`);
});

it('renders nothing for an adopted playbook', () => {
  const { db, within } = fixture({ '.ia/src/playbook.ia': null }, { '.ia/src/playbook.ia': PLAYBOOK });
  expect(db.get(IDENTITY, { within })?.band).toBe(90);
  for (const host of ['claude', 'codex'] as const) expect(generatePlaybookSkills(db, within, host), host).toEqual([]);
});

it("refuses an authored playbook named after the packet's ia-authoring skill, however it is spelled, for either host", () => {
  const { db, within } = fixture({
    '.ia/src/playbook.ia': PLAYBOOK.replace('@playbook note-review', '@playbook IA-Authoring'),
  });
  for (const host of ['claude', 'codex'] as const)
    expect(() => generatePlaybookSkills(db, within, host), host).toThrow(
      expect.objectContaining({
        diagnostic: {
          code: 'IA-PROJECTION-INPUT-INVALID',
          message:
            "Playbook governance-system/definition/procedure/ia-authoring would render over the packet's ia-authoring skill; rename the playbook",
        },
      }),
    );
});

it("renders a public system's playbook where the workspace authors that system, as this repository does", () => {
  // The band filter is the only one: this repository authors the public systems at band 100, so their example playbook
  // renders here, while a consumer's installed base, adopted below band 100, renders nothing (the case above).
  const db = open(repository, { cache: false });
  handles.push(db);
  expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
  const within = db.resolveScope().token;
  for (const [host, root] of [
    ['claude', '.claude/skills'],
    ['codex', '.agents/skills'],
  ] as const)
    expect(generatePlaybookSkills(db, within, host).map((file) => [file.path, file.identity])).toEqual([
      [`${root}/example-method/SKILL.md`, 'governance-system/definition/procedure/example-method'],
    ]);
});

it('refuses an unknown host, and a forged or stale token for either host', () => {
  const { root, db, within } = fixture();
  expect(() => generatePlaybookSkills(db, within, 'cursor' as 'claude')).toThrow(
    expect.objectContaining({ diagnostic: { code: 'IA-PROJECTION-INPUT-INVALID', message: 'Unknown host: cursor' } }),
  );
  for (const host of ['claude', 'codex'] as const)
    expect(() => generatePlaybookSkills(db, 'forged', host), host).toThrow('IA-DB-SCOPE-UNAVAILABLE');
  put(root, '.ia/src/new.ia', '#! ia 1.0\n');
  db.refresh();
  for (const host of ['claude', 'codex'] as const)
    expect(() => generatePlaybookSkills(db, within, host), host).toThrow('IA-DB-STALE');
});

it('writes the same bytes at two roots and names neither root nor scope token', () => {
  const one = fixture(),
    two = fixture();
  for (const host of ['claude', 'codex'] as const) {
    const first = generatePlaybookSkills(one.db, one.within, host);
    expect(generatePlaybookSkills(two.db, two.within, host)).toEqual(first);
    expect(generatePlaybookSkills(one.db, one.db.resolveScope().token, host)).toEqual(first);
    for (const { root, within } of [one, two])
      for (const file of first) {
        expect(file.text).not.toContain(root);
        expect(file.text).not.toContain(within);
      }
  }
});

it('renders operation and harness definitions without importing a handler or validator', () => {
  const { db, within } = fixture();
  const definitions = generateDefinitions(db, within, 'claude');
  expect(definitions.find((row) => row.word === 'operation')?.definition).toEqual({
    name: 'read-note',
    description: 'Read one captured note.',
    handler: 'read-note-v1',
    input: 'read-note-input-v1',
    output: 'read-note-output-v1',
    effects: ['read-only'],
  });
  expect(definitions.find((row) => row.word === 'harness')?.definition.registrations).toMatchObject({
    agents: [{ path: '.claude/agents/reviewer.md' }],
    skills: [{ path: '.claude/skills/note-review/SKILL.md' }],
    hooks: [
      {
        identity: 'hook-authoring-system/binding/hook/note-edits',
        event: 'PreToolUse',
        tools: ['Write', 'Edit', 'MultiEdit'],
      },
    ],
  });
  expect(
    generateDefinitions(db, within, 'codex').find((row) => row.word === 'harness')?.definition.registrations,
  ).toMatchObject({
    agents: [],
    hooks: [],
    skills: [{ path: '.agents/skills/note-review/SKILL.md' }],
  });
});

it('generates authored hooks only and reports tools and selections outside the edit guard contract', () => {
  const hooks = readFileSync(resolve(FIXTURE, 'hooks.ia'), 'utf8');
  const authored = fixture();
  expect(generateHooks(authored.db, authored.within, 'claude')).toHaveLength(1);
  expect(generateHooks(authored.db, authored.within, 'codex')).toEqual([]);
  // C12: Codex registers no hook and reports each authored one.
  expect(generateHookSet(authored.db, authored.within, 'codex')).toEqual({
    hooks: [],
    unsupported: [
      {
        identity: 'hook-authoring-system/binding/hook/note-edits',
        word: 'hook',
        reason: 'Codex hooks are unsupported',
      },
    ],
  });
  const adopted = fixture({ '.ia/src/hooks.ia': null }, { '.ia/src/hooks.ia': hooks });
  expect(generateHooks(adopted.db, adopted.within, 'claude')).toEqual([]);
  expect(generateHookSet(adopted.db, adopted.within, 'claude').unsupported).toEqual([]);
  for (const [text, why] of [
    [hooks.replace('[Write, Edit, MultiEdit]', '[Bash]'), 'hook.tools must name Write, Edit or MultiEdit'],
    [hooks.replace('"docs/**"', '"../docs/**"'), 'hook.paths must hold workspace-relative path selections'],
    [hooks.replace('event PreToolUse', 'event Stop'), 'event Stop is not PreToolUse'],
    // A hook that selects no path could never deny: it is reported, never registered as a guard that guards nothing.
    [hooks.replace('["docs/**", "restricted/**"]', '[]'), 'hook.paths selects no path'],
  ] as const) {
    const broken = fixture({ '.ia/src/hooks.ia': text });
    expect(generateHooks(broken.db, broken.within, 'claude')).toEqual([]);
    const { unsupported } = generateHookSet(broken.db, broken.within, 'claude');
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toMatchObject({ identity: 'hook-authoring-system/binding/hook/note-edits', word: 'hook' });
    expect(unsupported[0]!.reason).toContain(why);
    // The guard reads the same declaration, so it refuses what registration reports.
    const node = broken.db.records({ within: broken.within }).find((record) => record.discriminator === 'hook')!;
    expect(() => hookDeclaration(node)).toThrow(why);
  }
  // One unsupported hook leaves every supported one registered, and the harness definitions still render.
  const mixed = fixture({
    '.ia/src/extra-hooks.ia':
      '#! ia 1.0\n\n@hook session-start\n  meaning\n    says "Runs at session start."\n    answers "What runs at session start?"\n  hook\n    event Stop\n    tools [Write]\n    paths ["docs/**"]\n    message "Not an edit guard."\n',
  });
  const set = generateHookSet(mixed.db, mixed.within, 'claude');
  expect(set.hooks.map((hook) => hook.identity)).toEqual(['hook-authoring-system/binding/hook/note-edits']);
  expect(set.unsupported.map((hook) => hook.identity)).toEqual(['hook-authoring-system/binding/hook/session-start']);
  expect(generateDefinitions(mixed.db, mixed.within, 'claude').map((row) => row.word)).toEqual([
    'operation',
    'harness',
  ]);
});

it('refuses portable device names before emitting any host path', () => {
  const { db, within } = fixture({ '.ia/src/playbook.ia': PLAYBOOK.replace('note-review', 'con') });
  expect(() => generatePlaybookSkills(db, within, 'claude')).toThrow('Unsafe generated host name');
});
