import type { PluginHost } from './inventory.js';

/** The product a plugin's manifests carry: a product `@distribution`'s section, or what lowering reads from a plugin. */
export interface PluginProduct {
  readonly name: string;
  readonly displayName?: string | undefined;
  readonly version?: string | undefined;
  readonly description?: string | undefined;
  readonly author?: string | undefined;
  readonly license?: string | undefined;
  readonly keywords?: readonly string[] | undefined;
  readonly shortDescription?: string | undefined;
  readonly category?: string | undefined;
}

/** An object of the given entries in their order, each entry whose value is undefined left out. */
const stated = (entries: readonly (readonly [string, unknown])[]): Record<string, unknown> =>
  Object.fromEntries(entries.filter(([, value]) => value !== undefined));

/**
 * The manifest object one host's `plugin.json` holds for `product`, in the key order it is written. Claude and Grok
 * take the same object; Codex takes the shared keys, its skills path, an empty hook map and the interface, when the
 * product states any of its display name, short description or category. Lowering compares each original manifest with
 * this object, so a plugin lowers only when the renderer would write its manifests back (content-exact).
 */
export function pluginManifest(product: PluginProduct, host: PluginHost): Record<string, unknown> {
  const author = product.author === undefined ? undefined : { name: product.author };
  const keywords = product.keywords === undefined ? undefined : [...product.keywords];
  if (host === 'codex') {
    const face = stated([
      ['displayName', product.displayName],
      ['shortDescription', product.shortDescription],
      ['category', product.category],
    ]);
    return stated([
      ['name', product.name],
      ['version', product.version],
      ['description', product.description],
      ['author', author],
      ['license', product.license],
      ['keywords', keywords],
      ['skills', './skills/'],
      ['hooks', { hooks: {} }],
      ['interface', Object.keys(face).length === 0 ? undefined : face],
    ]);
  }
  return stated([
    ['name', product.name],
    ['displayName', product.displayName],
    ['version', product.version],
    ['description', product.description],
    ['author', author],
    ['license', product.license],
    ['keywords', keywords],
  ]);
}
