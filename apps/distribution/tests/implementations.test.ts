// Plan amendments C16 and C24 (milestone generation-binding): the installed-implementation catalog a host payload
// carries, read only through its release pins and the handler bytes the payload actually ships, and the per-consumer
// join receipts a host registration records from its committed state.
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { json, sha256 } from '../src/files.js';
import { acquireHostRegistrationLock, verifyHostCache } from '../src/host.js';
import { hostVerifier, observeHosts } from '../src/host-observe.js';
import {
  installedImplementationsValue,
  joinedCatalog,
  joinHost,
  JOINS,
  leaveHost,
  readInstalledImplementations,
  readJoins,
} from '../src/implementations.js';

// Spies that keep the real behaviour, so a test can count how often a payload is verified.
vi.mock('../src/host.js', { spy: true });

const roots: string[] = [];
const temp = () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'ia-implementations-')));
  roots.push(root);
  return root;
};
const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const code = (value: string) => expect.objectContaining({ code: value });

const MODULE = 'runtime/node_modules/@acme/handler/dist/handler.js',
  HELPER = 'runtime/node_modules/@acme/handler/dist/helper.js',
  BASE = 'runtime/node_modules/@acme/base/index.js',
  PACKAGES = ['@acme/base', '@acme/handler'];
type Operation = Record<string, unknown>;
/**
 * A materialized v2 payload as the builder lays one out: a handler package and the package it depends on, a package
 * outside that closure, an optional catalog naming the handler with pins computed from the shipped bytes, and the
 * inventory, launcher and release that pin them all. `mutate` edits the catalog row before it is pinned.
 */
function payload(options: { catalog?: boolean; mutate?: (operation: Operation) => Operation } = {}) {
  const root = temp(),
    files = new Map<string, string>([
      [
        'runtime/node_modules/@acme/handler/package.json',
        json({ name: '@acme/handler', dependencies: { '@acme/base': '1' } }),
      ],
      [MODULE, "import { helper } from './helper.js';\nexport const read = () => helper;\n"],
      [HELPER, 'export const helper = 1;\n'],
      ['runtime/node_modules/@acme/base/package.json', json({ name: '@acme/base' })],
      [BASE, 'export default 1;\n'],
      ['runtime/node_modules/@acme/other/package.json', json({ name: '@acme/other' })],
    ]);
  const operation = (options.mutate ?? ((row) => row))({
    id: 'read-v1',
    status: 'available',
    version: 1,
    operation: 'acme/binding/operation/read',
    handler: 'acme.read.v1',
    input: 'read-input-v1',
    output: 'read-output-v1',
    module: MODULE,
    digest: sha256(files.get(MODULE)!),
    packages: PACKAGES,
  });
  if (options.catalog !== false)
    files.set(
      'implementations.json',
      json({
        format: 'ia.installed-implementations.v1',
        evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] },
        operations: [operation],
      }),
    );
  const inventory = json({
    format: 'ia.host-cache.v2',
    version: '2.1.0',
    packages: [],
    files: [...files]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, text]) => ({ path, bytes: Buffer.byteLength(text), sha256: sha256(text) })),
  });
  const launcher = '// launcher\n',
    release = json({ format: 'ia.host-release.v2', inventory: sha256(inventory), launcher: sha256(launcher) });
  for (const [path, text] of files) put(root, path, text);
  put(root, 'inventory.json', inventory);
  put(root, 'scripts/ia.mjs', launcher);
  put(root, 'release.json', release);
  return { root, release: sha256(release), catalog: files.get('implementations.json') ?? null };
}

it('lists an operation as available only with the handler bytes the payload ships, pinned by their digest', () => {
  const { root, release, catalog } = payload();
  expect(verifyHostCache(root).release).toBe(release);
  const read = readInstalledImplementations(root, release);
  expect(read).toMatchObject({
    status: 'present',
    release,
    version: '2.1.0',
    digest: sha256(catalog!),
    evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] },
  });
  expect(read.status === 'present' && read.operations).toEqual([
    expect.objectContaining({
      id: 'read-v1',
      status: 'available',
      module: MODULE,
      digest: sha256(readFileSync(resolve(root, MODULE))),
    }),
  ]);
});

it('reads a payload with no catalog, such as one built before it existed, as unavailable while it still verifies', () => {
  const { root, release } = payload({ catalog: false });
  expect(verifyHostCache(root).release).toBe(release);
  expect(readInstalledImplementations(root, release)).toMatchObject({
    status: 'unavailable',
    release,
    reason: expect.stringContaining('carries no installed-implementation catalog'),
  });
  // A v1 payload carries none either; a payload whose release no longer matches its pin is damaged, not old.
  const v1 = temp(),
    inventory = json({
      format: 'ia.host-cache.v1',
      host: 'claude',
      name: 'legacy',
      version: '1.0.0',
      native: 'a'.repeat(64),
      packages: [],
      files: [],
    }),
    launcher = '// launcher\n',
    text = json({ format: 'ia.host-release.v1', inventory: sha256(inventory), launcher: sha256(launcher) });
  put(v1, 'inventory.json', inventory);
  put(v1, 'scripts/ia.mjs', launcher);
  put(v1, 'release.json', text);
  expect(verifyHostCache(v1).format).toBe(1);
  expect(readInstalledImplementations(v1, sha256(text))).toMatchObject({ status: 'unavailable' });
  expect(() => readInstalledImplementations(root, 'c'.repeat(64))).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
  expect(() => readInstalledImplementations(temp(), release)).toThrow(code('IA-DIST-ARTIFACT-UNAVAILABLE'));
});

it('reports a declaration whose handler bytes are not shipped as unavailable, never available', () => {
  const unavailable = (read: ReturnType<typeof readInstalledImplementations>) =>
    read.status === 'present' ? read.operations[0] : read;
  // Metadata only: the catalog names a module the inventory does not list.
  const absent = payload({
    mutate: (row) => ({ ...row, module: 'runtime/node_modules/@acme/handler/dist/absent.js' }),
  });
  expect(unavailable(readInstalledImplementations(absent.root, absent.release))).toEqual({
    id: 'read-v1',
    status: 'unavailable',
    reason: expect.stringContaining('is not in this payload'),
  });
  // A closure package the payload does not ship.
  const missing = payload({ mutate: (row) => ({ ...row, packages: ['@acme/base', '@acme/handler', '@acme/zzz'] }) });
  expect(unavailable(readInstalledImplementations(missing.root, missing.release))).toMatchObject({
    status: 'unavailable',
    reason: expect.stringContaining('@acme/zzz'),
  });
  // Handler or closure bytes deleted from a materialized payload: the payload no longer verifies, so nothing in it is
  // read, let alone available (binders report it as unavailable).
  for (const path of [MODULE, BASE]) {
    const { root, release } = payload();
    unlinkSync(resolve(root, path));
    expect(() => readInstalledImplementations(root, release)).toThrow(code('IA-DIST-ARTIFACT-UNAVAILABLE'));
    expect(() => verifyHostCache(root)).toThrow(code('IA-DIST-ARTIFACT-UNAVAILABLE'));
  }
});

it('refuses a payload with any file its inventory does not list, inside a closure package or outside every one (B-R1)', () => {
  // A module planted where Node's resolution prefers it to the shipped dependency: in the handler package's own
  // node_modules, or in a node_modules beside the scope directories, outside every closure package.
  for (const directory of [
    'runtime/node_modules/@acme/handler/node_modules/@acme/base',
    'runtime/node_modules/@acme/node_modules/@acme/base',
  ]) {
    const { root, release } = payload(),
      workspaceRoot = temp();
    put(root, `${directory}/package.json`, json({ name: '@acme/base', main: 'index.js' }));
    put(root, `${directory}/index.js`, 'export default "planted";\n');
    expect(() => verifyHostCache(root), directory).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
    expect(() => readInstalledImplementations(root, release), directory).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
    // A registration naming that payload records no join: the join refuses rather than vouch for it.
    registered(workspaceRoot, 'claude', root, release);
    expect(() => joinHost(workspaceRoot, 'claude', REVISION), directory).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
    expect(existsSync(resolve(workspaceRoot, JOINS))).toBe(false);
  }
});

it('detects altered handler bytes and disagreeing pins as an integrity failure, never as available', () => {
  for (const path of [MODULE, HELPER, BASE]) {
    const { root, release } = payload();
    writeFileSync(resolve(root, path), readFileSync(resolve(root, path), 'utf8') + '// altered after the build\n');
    expect(() => readInstalledImplementations(root, release)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
    expect(() => verifyHostCache(root)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
  }
  // A catalog whose handler digest disagrees with the inventory the release pins.
  {
    const { root, release } = payload({ mutate: (row: Operation) => ({ ...row, digest: 'f'.repeat(64) }) });
    expect(verifyHostCache(root).release).toBe(release);
    expect(() => readInstalledImplementations(root, release)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
  }
  // Changed catalog bytes.
  const { root, release, catalog } = payload();
  writeFileSync(resolve(root, 'implementations.json'), catalog + ' ');
  expect(() => readInstalledImplementations(root, release)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
});

it('refuses handler bytes reached through a hard link or a junction', () => {
  // The second name lives outside the payload, so the inventoried file is aliased without an unexpected entry in it.
  const linked = payload();
  linkSync(resolve(linked.root, BASE), resolve(temp(), 'alias.js'));
  expect(() => readInstalledImplementations(linked.root, linked.release)).toThrow(code('IA-DIST-PATH-UNSAFE'));
  const junction = payload(),
    copy = temp(),
    base = resolve(junction.root, 'runtime/node_modules/@acme/base');
  cpSync(base, copy, { recursive: true });
  rmSync(base, { recursive: true });
  symlinkSync(copy, base, 'junction');
  expect(() => readInstalledImplementations(junction.root, junction.release)).toThrow(code('IA-DIST-PATH-UNSAFE'));
});

it('accepts only well-formed catalogs', () => {
  const available = JSON.parse(payload().catalog!).operations[0] as Operation;
  const catalog = (
    operations: unknown[],
    evaluators: unknown = { format: 'ia-evaluator-catalog/1.0', entries: [] },
  ) => ({
    format: 'ia.installed-implementations.v1',
    evaluators,
    operations,
  });
  const unavailable = { id: 'zeta-v1', status: 'unavailable', reason: 'not shipped' };
  expect(installedImplementationsValue(catalog([available, unavailable])).operations).toHaveLength(2);
  for (const bad of [
    catalog([unavailable, available]),
    catalog([available, available]),
    catalog([{ ...available, packages: undefined }]),
    catalog([{ ...available, closure: 'f'.repeat(64) }]),
    catalog([{ ...available, extra: 1 }]),
    catalog([{ ...available, module: 'runtime/node_modules/@acme/other/index.js' }]),
    catalog([{ ...available, packages: ['@acme/handler', '@acme/base'] }]),
    catalog([{ ...available, status: 'revoked' }]),
    catalog([{ ...unavailable, reason: '' }]),
    catalog([available], { format: 'ia-evaluator-catalog/2.0', entries: [] }),
    { ...catalog([available]), format: 'ia.installed-implementations.v2' },
  ])
    expect(() => installedImplementationsValue(bad)).toThrow(code('IA-DIST-INPUT-INVALID'));
});

/** A workspace whose `host` registration names the payload at `cache`, as `applyHost` records one. */
function registered(root: string, host: 'claude' | 'codex', cache: string, release: string): void {
  put(
    root,
    `.ia/distributions/hosts/${host}-workspace.json`,
    json({ format: 'ia.host-state.v1', host, id: 'workspace', cache, release, owned: '{}\n', created: true }),
  );
}
const REVISION = 'd'.repeat(64);

it('joins each registered host from its committed registration and drops a join with its registration', () => {
  const root = temp(),
    { root: cache, release, catalog } = payload();
  registered(root, 'claude', cache, release);
  registered(root, 'codex', cache, release);
  const join = {
    consumer: 'claude',
    implementation: 'installed-implementations',
    version: '2.1.0',
    digest: sha256(catalog!),
    release,
    consumerRevision: REVISION,
  };
  expect(joinHost(root, 'claude', REVISION)).toEqual({ status: 'joined', join });
  expect(joinHost(root, 'codex', 'e'.repeat(64))).toMatchObject({ status: 'joined' });
  expect(readJoins(root)).toEqual([join, { ...join, consumer: 'codex', consumerRevision: 'e'.repeat(64) }]);
  // Re-joining at another revision replaces only that consumer's row.
  joinHost(root, 'claude', 'f'.repeat(64));
  expect(readJoins(root)!.map((row) => [row.consumer, row.consumerRevision])).toEqual([
    ['claude', 'f'.repeat(64)],
    ['codex', 'e'.repeat(64)],
  ]);
  expect(leaveHost(root, 'claude')).toBe(true);
  expect(leaveHost(root, 'claude')).toBe(false);
  expect(readJoins(root)!.map((row) => row.consumer)).toEqual(['codex']);
  // No registration any more: the join goes with it, and so does the receipt file once it is empty.
  rmSync(resolve(root, '.ia/distributions/hosts/codex-workspace.json'));
  expect(joinHost(root, 'codex', REVISION)).toEqual({ status: 'unregistered' });
  expect(existsSync(resolve(root, JOINS))).toBe(false);
  expect(readJoins(root)).toBeNull();
});

it('records no join for a registered payload without a catalog, and drops the one it had', () => {
  const root = temp(),
    current = payload(),
    old = payload({ catalog: false });
  registered(root, 'claude', current.root, current.release);
  expect(joinHost(root, 'claude', REVISION).status).toBe('joined');
  registered(root, 'claude', old.root, old.release);
  expect(joinHost(root, 'claude', REVISION)).toMatchObject({
    status: 'unavailable',
    reason: expect.stringContaining('carries no installed-implementation catalog'),
  });
  expect(readJoins(root)).toBeNull();
});

it('refuses to replace unreadable receipts, to write through aliases or past a pending host journal', () => {
  const root = temp(),
    { root: cache, release } = payload();
  registered(root, 'claude', cache, release);
  put(root, JOINS, '{broken');
  expect(() => joinHost(root, 'claude', REVISION)).toThrow(expect.objectContaining({ path: JOINS }));
  expect(readFileSync(resolve(root, JOINS), 'utf8')).toBe('{broken');
  rmSync(resolve(root, JOINS));
  put(root, '.ia/distributions/hosts/pending.json', '{}');
  expect(() => joinHost(root, 'claude', REVISION)).toThrow(code('IA-DIST-RECOVERY-REQUIRED'));
  expect(existsSync(resolve(root, JOINS))).toBe(false);
  const hosts = resolve(root, '.ia/distributions/hosts'),
    other = temp();
  cpSync(hosts, other, { recursive: true });
  rmSync(hosts, { recursive: true });
  rmSync(resolve(other, 'pending.json'));
  symlinkSync(other, hosts, 'junction');
  expect(() => joinHost(root, 'claude', REVISION)).toThrow(code('IA-DIST-PATH-UNSAFE'));
  expect(existsSync(resolve(other, 'joins.json'))).toBe(false);
  expect(() => joinHost(temp(), 'claude', 'not-a-revision')).toThrow(code('IA-DIST-INPUT-INVALID'));
  expect(() => joinHost(temp(), 'cursor', REVISION)).toThrow(code('IA-DIST-HOST-UNSUPPORTED'));
});

it('carries a catalog-declared revocation distinctly from an implementation that is not shipped', () => {
  const { root, release } = payload({
    mutate: () => ({ id: 'read-v1', status: 'revoked', reason: 'withdrawn by its producer' }),
  });
  const read = readInstalledImplementations(root, release);
  expect(read.status === 'present' && read.operations).toEqual([
    { id: 'read-v1', status: 'revoked', reason: 'withdrawn by its producer' },
  ]);
  expect(() =>
    installedImplementationsValue({
      format: 'ia.installed-implementations.v1',
      evaluators: { format: 'ia-evaluator-catalog/1.0', entries: [] },
      operations: [{ id: 'read-v1', status: 'revoked' }],
    }),
  ).toThrow(code('IA-DIST-INPUT-INVALID'));
});

it('finds the catalog a host joined for binding, and says why there is none', () => {
  const root = temp(),
    current = payload(),
    old = payload({ catalog: false });
  // No join receipt: an ia project-only workspace, or one registered before joins existed.
  expect(joinedCatalog(root)).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining('no host has joined an installed-implementation catalog'),
  });
  registered(root, 'claude', current.root, current.release);
  joinHost(root, 'claude', REVISION);
  const joined = joinedCatalog(root);
  expect(joined).toMatchObject({
    status: 'joined',
    consumer: 'claude',
    release: current.release,
    version: '2.1.0',
    digest: sha256(current.catalog!),
  });
  expect(joined.status === 'joined' && joined.catalog.operations[0]).toMatchObject({
    id: 'read-v1',
    status: 'available',
  });
  // The registration moved to another payload without a new join: drifted, so nothing binds through it.
  registered(root, 'claude', old.root, old.release);
  expect(joinedCatalog(root)).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining("host claude's join names release"),
  });
  // Another current join is used instead, in consumer order.
  registered(root, 'codex', current.root, current.release);
  joinHost(root, 'codex', REVISION);
  expect(joinedCatalog(root)).toMatchObject({ status: 'joined', consumer: 'codex' });
  rmSync(resolve(root, '.ia/distributions/hosts/codex-workspace.json'));
  expect(joinedCatalog(root)).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining('host codex joined a catalog but is no longer registered'),
  });
  put(root, JOINS, '{broken');
  expect(joinedCatalog(root)).toEqual({
    status: 'unavailable',
    reason: `${JOINS} cannot be read (IA-DB-SOURCE-UNAVAILABLE)`,
  });
});

it('reports a joined payload whose handler bytes no longer match their pins as damaged, and a missing one as unavailable', () => {
  const root = temp(),
    { root: cache, release } = payload();
  registered(root, 'claude', cache, release);
  joinHost(root, 'claude', REVISION);
  writeFileSync(resolve(cache, MODULE), readFileSync(resolve(cache, MODULE), 'utf8') + '// altered\n');
  expect(joinedCatalog(root)).toEqual({
    status: 'damaged',
    consumer: 'claude',
    release,
    reason: expect.stringContaining('IA-DIST-INTEGRITY-MISMATCH'),
  });
  rmSync(cache, { recursive: true });
  expect(joinedCatalog(root)).toEqual({
    status: 'unavailable',
    reason: expect.stringContaining("host claude's payload catalog cannot be read"),
  });
});

it('records no join while another holder has the host lock, and checks for a pending journal under it (B-N4)', () => {
  const root = temp(),
    { root: cache, release } = payload();
  registered(root, 'claude', cache, release);
  const unlock = acquireHostRegistrationLock(root);
  try {
    expect(() => joinHost(root, 'claude', REVISION)).toThrow(code('IA-DIST-INSTALL-BUSY'));
    expect(() => leaveHost(root, 'claude')).not.toThrow();
  } finally {
    unlock();
  }
  expect(existsSync(resolve(root, JOINS))).toBe(false);
  expect(joinHost(root, 'claude', REVISION).status).toBe('joined');
  // With receipts present, a removal under a held lock refuses too, and leaves them as they were.
  const before = readFileSync(resolve(root, JOINS), 'utf8'),
    held = acquireHostRegistrationLock(root);
  try {
    expect(() => leaveHost(root, 'claude')).toThrow(code('IA-DIST-INSTALL-BUSY'));
  } finally {
    held();
  }
  expect(readFileSync(resolve(root, JOINS), 'utf8')).toBe(before);
});

it('verifies a payload once for every read of one report that shares a verifier (B-N7)', () => {
  const root = temp(),
    { root: cache, release } = payload();
  registered(root, 'claude', cache, release);
  const verify = hostVerifier();
  vi.mocked(verifyHostCache).mockClear();
  // The host row's observation, the catalog row and a join row, as ia doctor reads them.
  expect(observeHosts(root, release, verify)).toHaveLength(1);
  expect(readInstalledImplementations(cache, release, verify).status).toBe('present');
  expect(readInstalledImplementations(cache, release, verify).status).toBe('present');
  expect(vi.mocked(verifyHostCache)).toHaveBeenCalledTimes(1);
  // A failure is kept too: a damaged payload is scanned once, and every read of it refuses.
  writeFileSync(resolve(cache, MODULE), readFileSync(resolve(cache, MODULE), 'utf8') + '// altered\n');
  const again = hostVerifier();
  vi.mocked(verifyHostCache).mockClear();
  for (let read = 0; read < 2; read++)
    expect(() => readInstalledImplementations(cache, release, again)).toThrow(code('IA-DIST-INTEGRITY-MISMATCH'));
  expect(vi.mocked(verifyHostCache)).toHaveBeenCalledTimes(1);
});
