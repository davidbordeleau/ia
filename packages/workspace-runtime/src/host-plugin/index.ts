export { HostPluginError, type HostPluginCode } from './errors.js';
export {
  emitFrontmatter,
  isPlain,
  parseFrontmatter,
  sameValue,
  type FrontField,
  type FrontValue,
  type Frontmatter,
} from './frontmatter.js';
export {
  inventoryOf,
  MANIFESTS,
  NAME,
  readEntries,
  readPlugin,
  type PluginEntry,
  type PluginHost,
  type PluginInventory,
} from './inventory.js';
export {
  ASSET_ROOT,
  IDENTITY,
  lowerPlugin,
  RECORDS_PATH,
  RESOURCE_ROOT,
  toolsOf,
  type AssetRole,
  type LoweredFile,
  type LoweringMap,
  type LoweringPlan,
} from './lower.js';
export { comparePlugin, DIFF_RULES, type DiffRule, type FileDiff } from './compare.js';
