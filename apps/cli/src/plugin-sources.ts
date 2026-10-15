import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createFile } from '@inventarch/distribution/services';
import type { PluginAsset, PluginFile, PluginResource } from '@inventarch/workspace-runtime/internal/generate';
import { ASSET_ROOT, HostPluginError } from '@inventarch/workspace-runtime/internal/host-plugin';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}
interface Association {
  owner: { identity: string };
  resources: { key: { path: string }; role: string; delivery: 'inline' | 'installed-reference' }[];
}

/** Whether `relative(base, path)` leaves `base`: `..` itself or a `..` segment first, never a name like `..x`. */
const leaves = (here: string): boolean => here === '..' || here.startsWith(`..${sep}`) || isAbsolute(here);

/** `path` with its longest existing prefix resolved through links, junctions and the volume's own spelling. */
export function canonical(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  try {
    head = realpathSync.native(head);
  } catch {
    // An unreadable prefix is compared as spelled.
  }
  return join(head, ...rest);
}

const contained = (base: string, path: string): string => {
  const resolved = resolve(base, path);
  const inside = relative(base, resolved);
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..') || inside === '' || leaves(inside))
    throw new HostPluginError('IA-PLUGIN-PRODUCT', `${path} escapes the workspace`);
  return resolved;
};

const readJson = <T>(root: string, path: string): T => {
  try {
    return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as T;
  } catch (error) {
    throw new HostPluginError(
      'IA-PLUGIN-PRODUCT',
      `${path} is missing or not valid JSON (${(error as Error).message}); lower the plugin again`,
    );
  }
};

/**
 * A resource or asset's bytes, read only through real directories: a symbolic link or junction on any segment below the
 * workspace root is refused (IA-PLUGIN-INPUT), so projection never reads, pins or copies bytes from outside the root.
 */
const readContained = (root: string, path: string): Buffer => {
  const resolved = contained(root, path);
  const segments = relative(root, resolved).split(sep);
  for (let index = 1; index <= segments.length; index += 1) {
    const below = segments.slice(0, index).join('/');
    if (lstatSync(resolve(root, below), { throwIfNoEntry: false })?.isSymbolicLink() === true)
      throw new HostPluginError(
        'IA-PLUGIN-INPUT',
        `${below} is a symbolic link or junction; ${path} is read only through real directories below the workspace`,
      );
  }
  try {
    return readFileSync(resolved);
  } catch {
    throw new HostPluginError('IA-PLUGIN-PRODUCT', `${path} cannot be read; lower the plugin again`);
  }
};

/** The resources a lowered workspace's authoring manifest binds, each verified against its pin, and its plugin assets. */
export function readPluginSources(root: string): { resources: PluginResource[]; assets: PluginAsset[] } {
  const manifest = readJson<{ files: ManifestFile[]; associations: Association[] }>(
    root,
    '.ia/authoring.resources.json',
  );
  const bytesOf = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const bytes = readContained(root, file.path);
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256)
      throw new HostPluginError(
        'IA-RESOURCE-DIGEST',
        `${file.path} differs from its pinned sha256; nothing was written`,
      );
    bytesOf.set(file.path, bytes);
  }
  const plugin = /^\.ia\/src\/systems\/[a-z][a-z0-9-]*\/plugin\//;
  const resources = manifest.associations.flatMap((association) =>
    association.resources.map((use) => {
      const bytes = bytesOf.get(use.key.path);
      if (bytes === undefined)
        throw new HostPluginError(
          'IA-PLUGIN-PRODUCT',
          `${use.key.path} is bound to ${association.owner.identity} but not pinned in the manifest`,
        );
      return {
        owner: association.owner.identity,
        role: use.role,
        delivery: use.delivery,
        output: use.key.path.replace(plugin, ''),
        bytes,
      };
    }),
  );
  const release = readJson<{ assets: { path: string }[] }>(root, '.ia/release.json');
  const assets = release.assets
    .filter((asset) => asset.path.startsWith(`${ASSET_ROOT}/`))
    .map((asset) => ({ output: asset.path.slice(ASSET_ROOT.length + 1), bytes: readContained(root, asset.path) }));
  return { resources, assets };
}

/**
 * Refuses an `--out` that is a file, is not empty, or lies in, equals or contains the workspace; returns it resolved.
 * Run for the plan as well as the apply, so a plan never promises what the apply refuses.
 */
export function checkPluginOut(root: string, out: string): string {
  const resolved = resolve(out);
  // Judged on the volume's own paths, so an --out reached through a link or junction into the workspace is inside it.
  const [here, base] = [canonical(resolved), canonical(root)];
  const inside = !leaves(relative(base, here));
  const contains = !leaves(relative(here, base));
  if (inside || contains)
    throw new HostPluginError(
      'IA-PLUGIN-OUT',
      `${resolved} is the workspace, inside it or above it; choose a directory outside ${resolve(root)}${sep}`,
    );
  if (existsSync(resolved)) {
    if (!statSync(resolved).isDirectory())
      throw new HostPluginError('IA-PLUGIN-OUT', `${resolved} is a file; --out takes an absent or empty directory`);
    if (readdirSync(resolved).length > 0)
      throw new HostPluginError('IA-PLUGIN-OUT', `${resolved} is not empty; --out takes an absent or empty directory`);
  }
  return resolved;
}

/** Writes every file create-only into `out`, which must be absent or empty; a refusal writes nothing. */
export function writeFreshPlugin(out: string, files: readonly PluginFile[]): void {
  if (existsSync(out)) {
    if (!statSync(out).isDirectory())
      throw new HostPluginError('IA-PLUGIN-OUT', `${out} is a file; --out takes an absent or empty directory`);
    if (readdirSync(out).length > 0)
      throw new HostPluginError('IA-PLUGIN-OUT', `${out} is not empty; --out takes an absent or empty directory`);
  }
  mkdirSync(out, { recursive: true });
  for (const file of files) createFile(out, file.path, file.bytes, 0o644);
}
