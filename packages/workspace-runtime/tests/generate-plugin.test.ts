import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { open } from '@inventarch/db';
import type { Handle } from '@inventarch/db';
import { adoptWorkspace } from '../src/corpus.js';
import { renderPlugin } from '../src/generate/plugin.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const repository = resolve(import.meta.dirname, '../../..'),
  FIXTURE = resolve(repository, 'apps/cli/tests/fixtures/composition-workspace/.ia/src'),
  NATIVE = resolve(repository, 'examples/conformance/native'),
  temporary = mkdtempSync(join(tmpdir(), 'ia-plugin-')),
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

const RECORDS = [
  '#! ia 1.0',
  '',
  '@distribution probe-distribution',
  '  meaning',
  '    says "A probe plugin."',
  '    answers "Which records does the probe ship?"',
  '  distribution',
  '    records [@capability probe-run]',
  '  product',
  '    name probe-plugin',
  '    display-name "Probe Plugin"',
  '    version "0.1.0"',
  '    description "A probe plugin."',
  '    hosts [claude, codex]',
  '    short-description "Probes"',
  '    category "Developer Tools"',
  '',
  '@capability probe-run',
  '  meaning',
  '    says "Run the probe on one target."',
  '    answers "Lowered from skills/probe-run/SKILL.md."',
  '  execution',
  '    effects []',
  '  invocation',
  '    mode user',
  '    argument-hint "[target]"',
  '',
].join('\n');

it('renders the manifests and a user-invoked skill with its inline body (A8)', () => {
  const { db, within } = fixture({ '.ia/src/probe.ia': RECORDS });
  const files = renderPlugin(
    db,
    within,
    [
      {
        owner: 'agent-composition-system/definition/capability/probe-run',
        role: 'body',
        delivery: 'inline',
        output: '',
        bytes: Buffer.from('\nRun it.\n'),
      },
    ],
    [],
  );
  const text = (path: string): string => files.find((file) => file.path === path)!.bytes.toString('utf8');
  expect(files.map((file) => file.path)).toEqual([
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'skills/probe-run/SKILL.md',
  ]);
  expect(text('skills/probe-run/SKILL.md')).toBe(
    '---\nname: probe-run\ndescription: Run the probe on one target.\ndisable-model-invocation: true\nargument-hint: "[target]"\n---\n\nRun it.\n',
  );
  expect(JSON.parse(text('.codex-plugin/plugin.json'))).toEqual({
    name: 'probe-plugin',
    version: '0.1.0',
    description: 'A probe plugin.',
    skills: './skills/',
    hooks: { hooks: {} },
    interface: { displayName: 'Probe Plugin', shortDescription: 'Probes', category: 'Developer Tools' },
  });
});
it('refuses a workspace with no product distribution', () => {
  const { db, within } = fixture();
  expect(() => renderPlugin(db, within, [], [])).toThrow(/exactly one @distribution with a product section/);
});
it('does not render an authored agent-profile that states no invocation (R3)', () => {
  const { db, within } = fixture({ '.ia/src/probe.ia': RECORDS });
  const files = renderPlugin(
    db,
    within,
    [
      {
        owner: 'agent-composition-system/definition/capability/probe-run',
        role: 'body',
        delivery: 'inline',
        output: '',
        bytes: Buffer.from('\nRun it.\n'),
      },
    ],
    [],
  );
  expect(files.some((file) => file.path.startsWith('agents/'))).toBe(false);
});

const PROBE_BODY = {
  owner: 'agent-composition-system/definition/capability/probe-run',
  role: 'body',
  delivery: 'inline',
  output: '',
  bytes: Buffer.from('\nRun it.\n'),
} as const;
const AGENT_RECORDS = [
  '@agent probe-agent',
  '  meaning',
  '    says "The probe agent."',
  '    answers "Who probes?"',
  '  governance',
  '    applies []',
  '',
  '@capability probe-agent-tools',
  '  meaning',
  '    says "Read access for the probe agent."',
  '    answers "What may the probe agent do?"',
  '  execution',
  '    effects [read]',
  '',
  '@agent-profile probe-agent',
  '  meaning',
  '    says "Probes one target."',
  '    answers "Which profile probes?"',
  '  composition',
  '    agent @agent probe-agent',
  '    voice @voice reviewer-voice',
  '    mandate @mandate demo-mandate',
  '    capabilities [@capability probe-agent-tools]',
  '  execution',
  '    role prober',
  '    outcomes probe-findings-v1',
  '    mandate-contract probe-v1',
  '  invocation',
  '    mode model',
  '',
].join('\n');

it('renders an agent-profile with its tools and inline body, with no marker line (A8)', () => {
  const { db, within } = fixture({ '.ia/src/probe.ia': `${RECORDS}\n${AGENT_RECORDS}` });
  const files = renderPlugin(
    db,
    within,
    [
      PROBE_BODY,
      {
        owner: 'agent-composition-system/binding/agent-profile/probe-agent',
        role: 'body',
        delivery: 'inline',
        output: '',
        bytes: Buffer.from('\nYou probe.\n'),
      },
    ],
    [],
  );
  const agent = files.find((file) => file.path === 'agents/probe-agent.md')!;
  expect(agent.bytes.toString('utf8')).toBe(
    '---\nname: probe-agent\ndescription: Probes one target.\ntools: Read, Grep, Glob\n---\n\nYou probe.\n',
  );
});
it('writes an installed reference and an asset at their output paths with their bytes (A8)', () => {
  const { db, within } = fixture({ '.ia/src/probe.ia': RECORDS });
  const files = renderPlugin(
    db,
    within,
    [
      PROBE_BODY,
      {
        owner: PROBE_BODY.owner,
        role: 'reference',
        delivery: 'installed-reference',
        output: 'skills/probe-run/references/guide.md',
        bytes: Buffer.from('guide\n'),
      },
    ],
    [{ output: 'CODEX.md', bytes: Buffer.from('codex\n') }],
  );
  const bytes = (path: string): string => files.find((file) => file.path === path)!.bytes.toString('utf8');
  expect(bytes('skills/probe-run/references/guide.md')).toBe('guide\n');
  expect(bytes('CODEX.md')).toBe('codex\n');
});
it('refuses two sources that render one path', () => {
  const { db, within } = fixture({ '.ia/src/probe.ia': RECORDS });
  expect(() =>
    renderPlugin(db, within, [PROBE_BODY], [{ output: 'skills/probe-run/SKILL.md', bytes: Buffer.from('x') }]),
  ).toThrow(/Two sources render/);
});
it('refuses an output path that is not portable', () => {
  const { db, within } = fixture({ '.ia/src/probe.ia': RECORDS });
  for (const output of ['../escape.md', 'C:/x.md', '/abs.md', './a.md', 'a//b.md', 'a\\b.md', ''])
    expect(() => renderPlugin(db, within, [PROBE_BODY], [{ output, bytes: Buffer.from('x') }])).toThrow(
      /not a portable plugin path/,
    );
});
it('renders the Claude manifest with the product fields only', () => {
  const { db, within } = fixture({ '.ia/src/probe.ia': RECORDS });
  const files = renderPlugin(db, within, [PROBE_BODY], []);
  expect(files.find((file) => file.path === '.claude-plugin/plugin.json')!.bytes.toString('utf8')).toBe(
    `${JSON.stringify({ name: 'probe-plugin', displayName: 'Probe Plugin', version: '0.1.0', description: 'A probe plugin.' }, null, 2)}\n`,
  );
});
it('refuses a delegated capability with IA-PROJECT-FEATURE', () => {
  const { db, within } = fixture({ '.ia/src/probe.ia': RECORDS.replace('mode user', 'mode delegated') });
  expect(() => renderPlugin(db, within, [PROBE_BODY], [])).toThrow(/delegated skills are rendered from slice 2/);
  try {
    renderPlugin(db, within, [PROBE_BODY], []);
  } catch (error) {
    expect((error as { code?: string }).code).toBe('IA-PROJECT-FEATURE');
  }
});
