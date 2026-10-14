import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** The resources a lowered workspace's authoring manifest binds, each verified against its pin, and its plugin assets. */
export function readPluginSources(root: string): { resources: PluginResource[]; assets: PluginAsset[] } {
  const manifest = JSON.parse(readFileSync(resolve(root, '.ia/authoring.resources.json'), 'utf8')) as {
    files: ManifestFile[];
    associations: Association[];
  };
  const bytesOf = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const bytes = readFileSync(resolve(root, file.path));
    if (bytes.length !== file.bytes || sha(bytes) !== file.sha256)
      throw new HostPluginError(
        'IA-RESOURCE-DIGEST',
        `${file.path} differs from its pinned sha256; nothing was written`,
      );
    bytesOf.set(file.path, bytes);
  }
  const plugin = /^\.ia\/src\/systems\/[a-z][a-z0-9-]*\/plugin\//;
  const resources = manifest.associations.flatMap((association) =>
    association.resources.map((use) => ({
      owner: association.owner.identity,
      role: use.role,
      delivery: use.delivery,
      output: use.key.path.replace(plugin, ''),
      bytes: bytesOf.get(use.key.path)!,
    })),
  );
  const release = JSON.parse(readFileSync(resolve(root, '.ia/release.json'), 'utf8')) as { assets: { path: string }[] };
  const assets = release.assets
    .filter((asset) => asset.path.startsWith(`${ASSET_ROOT}/`))
    .map((asset) => ({
      output: asset.path.slice(ASSET_ROOT.length + 1),
      bytes: readFileSync(resolve(root, asset.path)),
    }));
  return { resources, assets };
}

/** Writes every file create-only into `out`, which must be absent or empty; a refusal writes nothing. */
export function writeFreshPlugin(out: string, files: readonly PluginFile[]): void {
  if (existsSync(out) && readdirSync(out).length > 0)
    throw new HostPluginError('IA-PLUGIN-OUT', `${out} is not empty; --out takes an absent or empty directory`);
  mkdirSync(out, { recursive: true });
  for (const file of files) createFile(out, file.path, file.bytes, 0o644);
}
