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
