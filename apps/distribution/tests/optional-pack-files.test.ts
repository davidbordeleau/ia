import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { packOptionalDistribution } from '../../../tools/release/distribution.mjs';
import { productStructure } from '../../../tools/release/product-structure.mjs';
import { DISTRIBUTION_LIMITS } from '@inventarch/db/distribution';
import { repository } from './snapshot-fixture.js';

let baseline: ReturnType<typeof productStructure>;
const roots: string[] = [];
beforeAll(() => {
  baseline = productStructure(repository);
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const parent = fs.mkdtempSync(join(tmpdir(), 'ia-optional-pack-')),
    directory = join(parent, 'owned');
  roots.push(parent);
  fs.cpSync(join(repository, 'distributions/product-structure'), directory, { recursive: true });
  const assets = baseline.product.manifest.files.filter(({ role }) => role !== 'source').map(({ path }) => path);
  for (const path of assets) {
    fs.mkdirSync(dirname(join(directory, path)), { recursive: true });
    fs.writeFileSync(join(directory, path), baseline.product.files.get(path)!);
  }
  const pack = (selected: readonly string[] | ReadonlyMap<string, Uint8Array> = assets) =>
    packOptionalDistribution(repository, {
      directory,
      systems: ['product-system'],
      descriptor: {
        formatVersion: 1,
        id: 'fixture/optional-files',
        version: '0.1.0',
        distribution: 'workspace-system/definition/distribution/product-structure',
        source: { repository: null, commit: null, recipe: 'ustar-v1', epoch: 0 },
        license: 'Apache-2.0',
        description: 'Explicitly selected optional input fixture',
      },
      assets: selected,
    });
  return { parent, directory, assets, pack };
}

it('packs unchanged explicitly selected files with the same bytes as selected asset buffers', () => {
  const { pack, assets } = fixture();
  const selected = new Map(assets.map((path) => [path, baseline.product.files.get(path)!]));
  expect(pack().product.bytes).toEqual(pack(selected).product.bytes);
});

function mutateAfterCheck(target: string, mutate: () => void) {
  const lstat = fs.lstatSync;
  let checks = 0,
    replaced = false;
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args) => {
    const stat = Reflect.apply(lstat, fs, args);
    if (String(args[0]) === target && ++checks === 2) {
      mutate();
      replaced = true;
    }
    return stat;
  });
  syncBuiltinESMExports();
  return () => replaced;
}

function trackedReads(target: string, onRead?: () => void) {
  const open = fs.openSync,
    close = fs.closeSync,
    read = fs.readSync;
  const descriptors = new Set<number>(),
    measured = { opened: 0, closed: 0, bytes: 0 };
  vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    const fd = Reflect.apply(open, fs, args);
    if (String(args[0]) === target) {
      descriptors.add(fd);
      measured.opened++;
    }
    return fd;
  });
  vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
    if (descriptors.has(args[0])) onRead?.();
    const count = Reflect.apply(read, fs, args) as number;
    if (descriptors.has(args[0])) measured.bytes += count;
    return count;
  });
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    if (descriptors.delete(fd)) measured.closed++;
    close(fd);
  });
  syncBuiltinESMExports();
  return measured;
}

function expectReplacementRefused(pack: () => unknown, replaced: () => boolean) {
  let refusal: unknown;
  try {
    pack();
  } catch (error) {
    refusal = error;
  }
  expect(replaced()).toBe(true);
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toMatch(/changed|unaliased/i);
}

it.each([true, false])('refuses an asset replaced after its physical check (hard link: %s)', (hardLink) => {
  const { parent, directory, pack } = fixture(),
    target = join(directory, 'README.md'),
    outside = join(parent, 'outside.md');
  fs.copyFileSync(target, outside);
  const measured = trackedReads(target),
    replaced = mutateAfterCheck(target, () => {
      fs.renameSync(target, target + '.saved');
      if (hardLink) fs.linkSync(outside, target);
      else fs.copyFileSync(outside, target);
    });
  expectReplacementRefused(pack, replaced);
  expect(measured).toEqual({ opened: 1, closed: 1, bytes: 0 });
});

it('refuses a native source replaced after the directory walk checked it', () => {
  const { parent, directory, pack } = fixture(),
    target = join(directory, '.ia/src/systems/product-system/system.ia'),
    outside = join(parent, 'outside.ia');
  fs.copyFileSync(target, outside);
  const measured = trackedReads(target),
    replaced = mutateAfterCheck(target, () => {
      fs.renameSync(target, target + '.saved');
      fs.linkSync(outside, target);
    });
  expectReplacementRefused(pack, replaced);
  expect(measured).toEqual({ opened: 1, closed: 1, bytes: 0 });
});

it('refuses an asset whose ancestor is replaced after the physical check', () => {
  const { parent, directory, pack } = fixture(),
    target = join(directory, 'README.md'),
    outside = join(parent, 'outside');
  fs.mkdirSync(outside);
  fs.copyFileSync(target, join(outside, 'README.md'));
  const measured = trackedReads(target),
    replaced = mutateAfterCheck(target, () => {
      fs.renameSync(directory, directory + '.saved');
      fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
    });
  expectReplacementRefused(pack, replaced);
  expect(measured).toEqual({ opened: 1, closed: 1, bytes: 0 });
});

it('rechecks containment when a replaced ancestor still reaches the selected file', () => {
  const { directory, assets, pack } = fixture(),
    target = join(directory, 'README.md'),
    before = fs.lstatSync(target, { bigint: true }),
    identity = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs];
  expect(assets).toContain('README.md');
  // Read this asset last so a later asset's initial containment check cannot hide a missing final recheck.
  const selected = [...assets.filter((path) => path !== 'README.md'), 'README.md'],
    measured = trackedReads(target),
    replaced = mutateAfterCheck(target, () => {
      fs.renameSync(directory, directory + '.saved');
      fs.symlinkSync(directory + '.saved', directory, process.platform === 'win32' ? 'junction' : 'dir');
      expect(identity(fs.lstatSync(target, { bigint: true }))).toEqual(identity(before));
    });
  let refusal: unknown;
  try {
    pack(selected);
  } catch (error) {
    refusal = error;
  } finally {
    if (replaced() && fs.lstatSync(directory).isSymbolicLink()) fs.unlinkSync(directory);
  }
  expect(replaced()).toBe(true);
  expect(refusal).toMatchObject({ code: 'IA-DIST-PATH-UNSAFE' });
  expect(measured).toEqual({ opened: 1, closed: 1, bytes: Number(before.size) });
});

it.each(['grow', 'replace'] as const)('refuses an asset changed after descriptor validation: %s', (change) => {
  const { parent, directory, pack } = fixture(),
    target = join(directory, 'README.md'),
    outside = join(parent, 'outside.md'),
    size = fs.statSync(target).size;
  fs.copyFileSync(target, outside);
  let changed = false;
  const measured = trackedReads(target, () => {
    if (changed) return;
    changed = true;
    if (change === 'grow') fs.appendFileSync(target, Buffer.alloc(65536, 32));
    else {
      fs.renameSync(target, target + '.saved');
      fs.copyFileSync(outside, target);
    }
  });
  expectReplacementRefused(pack, () => changed);
  expect(measured.bytes).toBe(size);
  expect(measured.closed).toBe(measured.opened);
});

it('refuses a preexisting hard-linked selected asset', () => {
  const { parent, directory, pack } = fixture();
  fs.linkSync(join(directory, 'README.md'), join(parent, 'alias.md'));
  expect(() => pack()).toThrow('Hard-linked distribution asset');
});

it('refuses an oversized selected asset before opening or reading it', () => {
  const { directory, pack } = fixture(),
    target = join(directory, 'README.md');
  fs.writeFileSync(target, Buffer.alloc(DISTRIBUTION_LIMITS.file + 1, 32));
  const measured = trackedReads(target);
  expect(() => pack()).toThrow('exceeds file limit');
  expect(measured).toEqual({ opened: 0, closed: 0, bytes: 0 });
});

it('refuses a nonregular selected asset before opening or reading it', () => {
  const { directory, pack } = fixture(),
    target = join(directory, 'README.md');
  fs.unlinkSync(target);
  fs.mkdirSync(target);
  const measured = trackedReads(target);
  expect(() => pack()).toThrow(/unaliased|Hard-linked/);
  expect(measured).toEqual({ opened: 0, closed: 0, bytes: 0 });
});
