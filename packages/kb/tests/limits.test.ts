import { afterEach, expect, it, vi } from 'vitest';
import { readWorkspaceBytes } from '@inventarch/db';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Foundation } from '../src/foundation.js';
import { digest, LIMITS } from '../src/format.js';
import { captureKnowledge } from '../src/local.js';
import type { KnowledgeSelection } from '../src/package.js';
import { executeKnowledge } from '../src/protocol.js';
import { openKnowledgeView } from '../src/view.js';
vi.mock('@inventarch/db', { spy: true });
const base = JSON.parse(
  readFileSync(new URL('./fixtures/legacy-foundation.json', import.meta.url), 'utf8'),
) as Foundation;
const sources = base.capture.sources
  .filter((s) => s.location.placement.kind === 'adopted')
  .map((s) => ({ path: s.path.replace(/^\.ia\/distributions\/store\/[^/]+\//, ''), text: s.text }));
const input = { adopted: [{ id: 'public-base', revision: digest(sources), sources }] };
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ia knowledge limits '));
  roots.push(root);
  mkdirSync(join(root, '.ia/src'), { recursive: true });
  return root;
}
const name = (i: number) => 'k' + String(i).padStart(3, '0');
const identity = (i: number) => 'work-system/contract/spec/' + name(i);
const record = (i: number, says: string, body?: string) =>
  '@spec ' +
  name(i) +
  '\n  meaning\n    says "' +
  says +
  '"\n  work\n    title "T"\n    status draft\n' +
  (body === undefined ? '' : '    source "' + body + '"\n');
/** One native file holding `count` records, each bound to its own body file of `bytes(i)` bytes. */
function bound(root: string, count: number, bytes: (i: number) => number): string {
  const text =
    '#! ia 1.0\n' +
    Array.from({ length: count }, (_, i) => record(i, 'Record.', 'bodies/' + name(i) + '.md')).join('\n');
  writeFileSync(join(root, '.ia/src/notes.ia'), text);
  mkdirSync(join(root, 'bodies'), { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(root, 'bodies', name(i) + '.md'), 'x'.repeat(bytes(i)));
  return text;
}
const outcome = (root: string, options: { selection?: KnowledgeSelection } = {}) => {
  const snapshot = captureKnowledge(root, { input, ...options });
  return { records: snapshot.records.length, unavailable: snapshot.unavailable.map((u) => u.code) };
};

it('reads a body listed in the selection and leaves an unlisted one unavailable', () => {
  const root = workspace();
  bound(root, 1, () => 1);
  const selection = (resources: string[]): KnowledgeSelection => ({
    format: 'ia.kb.selection.v1',
    sourceId: 'example',
    records: [identity(0)],
    resources,
  });
  expect(outcome(root, { selection: selection(['bodies/k000.md']) })).toEqual({ records: 1, unavailable: [] });
  expect(readWorkspaceBytes).toHaveBeenCalledWith(root, 'bodies/k000.md', LIMITS.fileBytes);
  vi.mocked(readWorkspaceBytes).mockClear();
  expect(outcome(root, { selection: selection([]) })).toMatchObject({ records: 0, unavailable: [expect.any(String)] });
  expect(vi.mocked(readWorkspaceBytes).mock.calls.some(([, path]) => path === 'bodies/k000.md')).toBe(false);
});

it('reads a body of exactly the file byte limit and refuses one byte more', () => {
  const root = workspace();
  bound(root, 1, () => LIMITS.fileBytes);
  expect(outcome(root)).toEqual({ records: 1, unavailable: [] });
  bound(root, 1, () => LIMITS.fileBytes + 1);
  expect(outcome(root)).toMatchObject({ records: 0, unavailable: [expect.any(String)] });
});

it('reads exactly the file limit across native and body files and refuses the next body', () => {
  const root = workspace();
  // One native file plus 99 bodies is exactly LIMITS.files.
  bound(root, LIMITS.files - 1, () => 1);
  expect(outcome(root)).toEqual({ records: LIMITS.files - 1, unavailable: [] });
  bound(root, LIMITS.files, () => 1);
  expect(outcome(root)).toMatchObject({ records: LIMITS.files - 1, unavailable: [expect.any(String)] });
});

it('admits exactly LIMITS.files native files and refuses one more before reading bodies', () => {
  const root = workspace();
  for (let i = 0; i < LIMITS.files; i++)
    writeFileSync(join(root, '.ia/src', name(i) + '.ia'), '#! ia 1.0\n' + record(i, 'Record.'));
  expect(captureKnowledge(root, { input }).records).toHaveLength(LIMITS.files);
  writeFileSync(join(root, '.ia/src', name(LIMITS.files) + '.ia'), '#! ia 1.0\n' + record(LIMITS.files, 'Record.'));
  expect(() => captureKnowledge(root, { input })).toThrow('Knowledge selection exceeds capture budget');
});

it('reads exactly the selected byte budget and refuses one byte more', () => {
  const root = workspace(),
    count = LIMITS.selectedBytes / LIMITS.fileBytes;
  // Native bytes count toward the budget, so the last body takes what the native file left.
  const native = Buffer.byteLength(bound(root, count, () => 1));
  const fill = (extra: number) => (i: number) =>
    i === count - 1 ? LIMITS.fileBytes - native + extra : LIMITS.fileBytes;
  bound(root, count, fill(0));
  expect(outcome(root)).toEqual({ records: count, unavailable: [] });
  bound(root, count, fill(1));
  expect(outcome(root)).toMatchObject({ records: count - 1, unavailable: [expect.any(String)] });
});

it.each([10, 1])('truncates search with a bare result %i bytes below the response boundary', (margin) => {
  const root = workspace(),
    count = 100,
    write = (padding: (i: number) => number) =>
      writeFileSync(
        join(root, '.ia/src/notes.ia'),
        '#! ia 1.0\n' +
          Array.from({ length: count }, (_, i) => record(i, 'needle ' + 'y'.repeat(padding(i)))).join('\n'),
      );
  const measure = () => {
    const view = openKnowledgeView(captureKnowledge(root, { input }));
    // The value as the view alone bounds it: what the protocol wrapped before it reserved its envelope.
    const value = view.search('needle');
    return { view, results: value.results.length, bytes: Buffer.byteLength(JSON.stringify(value)) };
  };
  write(() => 110);
  const first = measure();
  first.view.close();
  expect(first.results).toBeLessThan(count);
  // Grow the kept results until the bare value sits just under the limit: inside the bound alone, over it
  // once `{"version":1,"ok":true,"value":…}` wraps it.
  let gap = LIMITS.responseBytes - margin - first.bytes;
  const extra = Array.from({ length: count }, () => 0);
  for (let i = 0; gap > 0 && i < first.results; i++) {
    extra[i] = Math.min(gap, 40);
    gap -= extra[i]!;
  }
  write((i) => 110 + extra[i]!);
  const edge = measure();
  try {
    expect(edge).toMatchObject({ results: first.results, bytes: LIMITS.responseBytes - margin });
    const wrapped = Buffer.byteLength(JSON.stringify({ version: 1, ok: true, value: edge.view.search('needle') }));
    expect(wrapped).toBeGreaterThan(LIMITS.responseBytes);
    const response = executeKnowledge(edge.view, 'search', { query: 'needle' });
    expect(response).toMatchObject({ ok: true, value: { truncated: true } });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(LIMITS.responseBytes);
    expect((response.value as { results: unknown[] }).results).toHaveLength(first.results - 1);
  } finally {
    edge.view.close();
  }
});
