// Host generators over authored records (milestone generation-binding). The CLI's projection writer applies
// generateHostSet's set (task host-consumes-generated-set).
export { generateAgentProfiles } from './agent-profile.js';
export { generatePlaybookSkills } from './playbook.js';
export { generateDefinitions, generateHostSet } from './definitions.js';
export type { HostSet } from './definitions.js';
export {
  generateHooks,
  generateHookSet,
  HOOK_IDENTITY,
  HOOK_IDENTITY_LIMIT,
  hookDeclaration,
  registrableHook,
} from './hook.js';
export type { HookSet } from './hook.js';
export type { GeneratedFile, GeneratedSet, GeneratedWord, UnsupportedRecord } from './format.js';
