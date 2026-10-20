import type { Door } from '@inventarch/runtime';
import { captureKnowledge, openKnowledgeView, KnowledgeError } from '@inventarch/kb';
import { executeKnowledge, knowledgeFailure, parseKnowledgeRequest } from '@inventarch/kb/protocol';
import type { KnowledgeOperation } from '@inventarch/kb/protocol';
/** Selectable authored records a Door scope may carry into one knowledge capture. */
export const MEMBERSHIP = Object.freeze({ records: 1000, bytes: 8 * 1024 * 1024 });
/** Tokens are interpreted only by their issuing Door. Transfer membership and graph revision, never the token. */
export function knowledgeTool(
  root: string,
  door: Door,
  operation: KnowledgeOperation,
  input: unknown,
  budget: { readonly records: number; readonly bytes: number } = MEMBERSHIP,
) {
  try {
    const args = parseKnowledgeRequest(operation, input);
    const membership = door.request({
      operation: 'records',
      params: args.within === undefined ? {} : { within: args.within },
    });
    if (!membership.ok) throw new KnowledgeError('IA-KB-SCOPE-UNAVAILABLE', 'Knowledge scope unavailable');
    const snapshot = membership.result as {
      revision: string;
      records: readonly { identity: string; placement: { kind: string }; source: { path: string } }[];
    };
    // The budget counts only what capture can select: authored records under .ia/src, never floor records.
    const authored = snapshot.records.filter(
      (r) =>
        r.placement.kind === 'authored' &&
        r.source.path.startsWith('.ia/src/') &&
        !r.source.path.startsWith('.ia/src/floor/'),
    );
    if (authored.length > budget.records || Buffer.byteLength(JSON.stringify(authored)) > budget.bytes)
      throw new KnowledgeError('IA-KB-SCOPE-LIMIT', 'Knowledge scope exceeds membership budget');
    const view = openKnowledgeView(
      captureKnowledge(root, {
        identities: authored.map((r) => r.identity),
        expectedRevision: snapshot.revision,
      }),
    );
    try {
      return executeKnowledge(view, operation, args);
    } finally {
      view.close();
    }
  } catch (error) {
    return knowledgeFailure(error);
  }
}
