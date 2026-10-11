export { EditorWorkspace, EditorError } from './workspace.js';
export type * from './types.js';
export { PHASES, PRIMITIVES, VERB_PHRASES } from '@inventarch/language';
export { cursorContext, projectSource, lineRange } from '@inventarch/language/editor';
// Milestone generation-binding plan amendment C18: language's schema-aware source edits, for hosts that may not import
// the language package (the CLI's `ia preview`).
export {
  addRelationship,
  appendRecord,
  draftSource,
  encodeValue,
  relationshipConsent,
  setField,
  SourceEditError,
} from '@inventarch/language/editor';
export type { DraftField, DraftSchema, RelationshipConsent, SourceEditReason } from '@inventarch/language/editor';
