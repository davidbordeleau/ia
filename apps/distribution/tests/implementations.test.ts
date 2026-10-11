import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { json, sha256 } from '../src/files.js';
import { JOINS, readInstalledImplementations, readJoins, recordJoin, removeJoins } from '../src/implementations.js';

const roots: string[] = [];
const temp = () => { const root = mkdtempSync(resolve(tmpdir(), 'ia-implementations-')); roots.push(root); return root; };
const put = (root: string, path: string, text: string) => { mkdirSync(resolve(root, path, '..'), { recursive: true }); writeFileSync(resolve(root, path), text); };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function payload(withCatalog = true) {
  const root = temp();
  const catalog = json({ format: 'ia.installed-implementations.v1', evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] }, operations: [] });
  const inventory = json({ format: 'ia.host-cache.v2', version: '2.0.0', packages: [], files: withCatalog ? [{ path: 'implementations.json', bytes: Buffer.byteLength(catalog), sha256: sha256(catalog) }] : [] });
  const release = json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: 'a'.repeat(64) });
  put(root, 'inventory.json', inventory); put(root, 'release.json', release);
  if (withCatalog) put(root, 'implementations.json', catalog);
  return { root, release: sha256(release) };
}
it('reads release-pinned catalog bytes and refuses altered bytes and file aliases', () => {
  const { root, release } = payload();
  expect(readInstalledImplementations(root, release)).toMatchObject({ version: '2.0.0', operations: [] });
  const original = readFileSync(resolve(root, 'implementations.json'), 'utf8');
  put(root, 'implementations.json', original + ' ');
  expect(() => readInstalledImplementations(root, release)).toThrow(expect.objectContaining({ code: 'IA-DIST-INTEGRITY-MISMATCH' }));
  put(root, 'implementations.json', original);
  linkSync(resolve(root, 'implementations.json'), resolve(root, 'alias.json'));
  expect(() => readInstalledImplementations(root, release)).toThrow(expect.objectContaining({ code: 'IA-DB-PATH-UNSAFE' }));
});
it('reports old inventoried payloads with no catalog as unavailable', () => {
  const { root, release } = payload(false);
  expect(() => readInstalledImplementations(root, release)).toThrow(expect.objectContaining({ code: 'IA-DIST-ARTIFACT-UNAVAILABLE' }));
});
it('joins, upgrades and removes one consumer while preserving the other', () => {
  const root = temp(), join = { consumer: 'claude', implementation: 'installed-catalog', version: '2.0.0', digest: 'a'.repeat(64), consumerRevision: 'b'.repeat(64) };
  recordJoin(root, join); recordJoin(root, { ...join, consumer: 'codex' });
  recordJoin(root, { ...join, version: '3.0.0', digest: 'c'.repeat(64) });
  expect(readJoins(root)).toEqual([{ ...join, version: '3.0.0', digest: 'c'.repeat(64) }, { ...join, consumer: 'codex' }]);
  removeJoins(root, 'claude'); expect(readJoins(root)).toEqual([{ ...join, consumer: 'codex' }]);
  removeJoins(root, 'codex'); expect(readJoins(root)).toBeNull();
});
it('does not overwrite malformed joins or write through directory aliases', () => {
  const root = temp(), join = { consumer: 'claude', implementation: 'installed-catalog', version: '2.0.0', digest: 'a'.repeat(64), consumerRevision: 'b'.repeat(64) };
  put(root, JOINS, '{broken');
  expect(() => recordJoin(root, join)).toThrow(); expect(readFileSync(resolve(root, JOINS), 'utf8')).toBe('{broken');
  rmSync(resolve(root, '.ia/distributions/hosts'), { recursive: true });
  const other = temp(); symlinkSync(other, resolve(root, '.ia/distributions/hosts'), 'junction');
  expect(() => recordJoin(root, join)).toThrow(expect.objectContaining({ code: 'IA-DIST-PATH-UNSAFE' }));
});
