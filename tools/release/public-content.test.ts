import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { contentFindings, scanContent, validateContentPolicy } from './public/content-scan.mjs';

const root = resolve(import.meta.dirname, '../..');

it('keeps personal address and local-path refusals under public membership policy', () => {
  const policy = JSON.parse(readFileSync(resolve(root, 'tools/distribution/public-content-policy.json'), 'utf8'));
  expect(() => validateContentPolicy(policy)).not.toThrow();
  const outputs = new Map([
    [
      'packages/language/README.md',
      { bytes: Buffer.from(['person', 'unlisted.dev'].join('@') + ' and /' + 'home/person/private.txt') },
    ],
  ]);
  expect(
    contentFindings(outputs, policy)
      .map((row) => row.rule)
      .sort(),
  ).toEqual(['email', 'local-path']);
  expect(() => scanContent(outputs, policy)).toThrow(/private-content leak/);
  expect(() =>
    validateContentPolicy({ ...policy, packageNames: [{ root: 'apps/cli', name: '@inventarch/cli' }] }),
  ).toThrow(/invalid public package owner/);
});

interface Pin {
  readonly words: number;
  readonly length: number;
  readonly sha256: string;
}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
/**
 * Names of planning documents, decisions and repositories kept outside this public repository, pinned by word count,
 * length and the SHA-256 of their lowercase spelling, as content-scan pins its denied tokens, so this file does not
 * list them. A tracked file that cites one points its readers at material they cannot open: cite the public SPEC clause
 * that states the rule instead.
 */
const PRIVATE_REFERENCES: readonly Pin[] = [
  { words: 3, length: 23, sha256: '193ec15baf8a62057fe1a3fa4712bfb2b86d54936d36c3aa410d7fdd0fc9bf49' },
  { words: 2, length: 13, sha256: 'c99493c61e8b9b6565ffc59643a0a74f6ea61f26a23718ed4255a7e7fdf028d6' },
  { words: 4, length: 33, sha256: '6828cf9c6c4f10c82561f2f64e2e96144310c741dbef2b9f24fb38322e8013dc' },
  { words: 3, length: 18, sha256: '642ae76c673fccd0861647434ce6f4af053cc400bc33ad41380588acf7b4a00a' },
];
/** Phrasing that points at a private knowledge base's tasks or decisions, whatever their names. */
const PRIVATE_PHRASE = /\bkb[ -](?:task|decision|plan|spec|document)s?\b/i;
/** Published release history is immutable: a consumed changeset and the changelog generated from it keep their bytes. */
const IMMUTABLE = (path: string): boolean => path === 'CHANGELOG.md' || path.startsWith('releases/changesets/');

/** Each private reference in `files` (path to text), as `path:line`. */
function privateReferences(files: ReadonlyMap<string, string>, pins: readonly Pin[]): string[] {
  const widest = Math.max(...pins.map((pin) => pin.words)),
    found: string[] = [];
  for (const [path, text] of files) {
    const at = (index: number): string => `${path}:${text.slice(0, index).split('\n').length}`,
      phrase = PRIVATE_PHRASE.exec(text);
    if (phrase) found.push(at(phrase.index));
    const words = [...text.matchAll(/\b\w+\b/g)];
    for (let index = 0; index < words.length; index++)
      for (let width = 1; width <= widest && index + width <= words.length; width++) {
        const start = words[index]!.index,
          last = words[index + width - 1]!,
          length = last.index + last[0].length - start,
          candidates = pins.filter((pin) => pin.words === width && pin.length === length);
        if (
          candidates.length &&
          candidates.some((pin) => pin.sha256 === sha256(text.slice(start, start + length).toLowerCase()))
        )
          found.push(at(start));
      }
  }
  return found;
}

it('finds a pinned name in any case and a knowledge-base pointer, by line', () => {
  const name = 'sample-planning-note',
    pin = { words: 3, length: name.length, sha256: sha256(name) },
    files = new Map([
      ['a.md', 'intro\nsee Sample-Planning-Note §3 and the sample planning note\n'],
      ['b.ts', ['// as the KB', 'task names it\n'].join(' ')],
      ['c.md', 'roughly 360 KB of payload\n'],
    ]);
  expect(privateReferences(files, [pin])).toEqual(['a.md:2', 'b.ts:1']);
});

it('keeps tracked files free of pointers to private planning material', () => {
  const files = new Map<string, string>();
  for (const path of execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\0')
    .filter((path) => path && !IMMUTABLE(path))) {
    const bytes = readFileSync(resolve(root, path));
    if (!bytes.includes(0)) files.set(path, bytes.toString('utf8'));
  }
  expect(files.size).toBeGreaterThan(1000);
  expect(privateReferences(files, PRIVATE_REFERENCES)).toEqual([]);
});
