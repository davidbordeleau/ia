// Host generators over authored records (milestone generation-binding). Internal: nothing applies what they render
// until task host-consumes-generated-set hands it to the one projection writer.
export { generateAgentProfiles } from './agent-profile.js';
export { generatePlaybookSkills } from './playbook.js';
export { generateDefinitions } from './definitions.js';
export {
  generateHooks,
  generateHookSet,
  HOOK_IDENTITY,
  HOOK_IDENTITY_LIMIT,
  hookDeclaration,
  registrableHook,
} from './hook.js';
export type { HookSet, UnsupportedHook } from './hook.js';
export type { GeneratedFile, GeneratedWord } from './format.js';
