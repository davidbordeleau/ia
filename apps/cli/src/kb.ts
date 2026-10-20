import { isAbsolute, relative, resolve } from 'node:path';
import { readWorkspaceBytes } from '@inventarch/db';
import {
  captureKnowledge,
  foundationFromWorkspace,
  openKnowledgeView,
  packageFromCommit,
  KnowledgeError,
} from '@inventarch/kb';
import { executeKnowledge, parseKnowledgeRequest } from '@inventarch/kb/protocol';
import type { KnowledgeOperation } from '@inventarch/kb/protocol';
import type { Context, Result } from './consumer.js';
import { confirm, requireRoot, Refusal } from './consumer.js';
import { UsageError } from './args.js';
import { knowledgeMode } from './kb-commands.js';
import { requireProfile } from './profile.js';
import { openSession } from './session.js';
import { knowledgeOutput } from './kb-output.js';
import { document, headerLine } from './render.js';
/** Request refusals: the input, the scope or the response bound. Every other knowledge code is operational. */
const REQUEST_CODES: ReadonlySet<string> = new Set(['IA-KB-INVALID', 'IA-KB-UNAVAILABLE', 'IA-KB-RESPONSE-LIMIT']);
/** The one next command for a knowledge refusal, chosen by its cause. */
function knowledgeNext(code: string, operation: string): string {
  if (code === 'IA-KB-UNAVAILABLE') return 'Run "ia kb search --help" to find an identity selected in this scope.';
  if (code === 'IA-KB-SNAPSHOT-UNAVAILABLE')
    return 'Run "ia kb read --help" and read the identity again for a current citation.';
  if (code === 'IA-KB-SCOPE-STALE' || code === 'IA-KB-SNAPSHOT-CHANGED')
    return `Run "ia kb ${operation} --help" and retry once the workspace stops changing.`;
  if (code === 'IA-KB-SOURCE-UNAVAILABLE')
    return 'Run "ia doctor" for the observed runtime, workspace and repository state.';
  return `Run "ia kb ${operation} --help" for the accepted input and limits.`;
}
/** Request refusals exit 1; operational failures (stale or changed sources, unreadable repository) exit 3. */
const knowledgeRefusal = (code: string, message: string, operation: string): Refusal =>
  new Refusal(code, message, REQUEST_CODES.has(code) ? 1 : 3, null, knowledgeNext(code, operation));
const answer = (value: { ok: boolean }, context: Context): Result => ({
  exitCode: value.ok ? 0 : 1,
  stdout:
    (context.json ? '' : document([headerLine('Knowledge', value.ok ? 'ready' : 'unavailable', [], context.caps)])) +
    JSON.stringify(value, null, context.json ? undefined : 2) +
    '\n',
  stderr: '',
});
/** A citation file read within the workspace; malformed JSON is invalid knowledge input, not a CLI failure. */
function citationFile(root: string, given: string): unknown {
  const text = Buffer.from(
    readWorkspaceBytes(root, isAbsolute(given) ? relative(root, given).replaceAll('\\', '/') : given, 16 * 1024),
  ).toString('utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new KnowledgeError('IA-KB-INVALID', 'Citation file is not valid JSON');
  }
}
export async function runKnowledge(context: Context): Promise<Result> {
  const { args } = context,
    operation = args.positionals[0]!,
    root = requireRoot(context);
  const session = openSession(root);
  try {
    const mode = knowledgeMode(args);
    requireProfile({
      reader: session.reader,
      within: session.reader.resolveScope().token,
      context,
      mode,
      ...(operation === 'pack'
        ? { path: relative(root, resolve(root, args.value('out')!)).replaceAll('\\', '/') }
        : {}),
    });
    try {
      if (operation === 'pack') {
        const pkg = packageFromCommit({
          repository: root,
          commit: args.value('commit')!,
          selection: args.value('selection')!,
          foundation: foundationFromWorkspace(root),
        });
        const bytes = JSON.stringify(pkg) + '\n';
        const destination = knowledgeOutput(
          root,
          args.value('out')!,
          [
            ...pkg.files.map((file) => file.path),
            relative(root, resolve(root, args.value('selection')!)).replaceAll('\\', '/'),
          ],
          bytes,
        );
        const output = destination.absolute;
        if (destination.unchanged)
          return answer(
            { ok: true, ...{ version: 1, value: { applied: false, unchanged: true, digest: pkg.digest, output } } },
            context,
          );
        if (!args.flag('apply'))
          return answer(
            {
              ok: true,
              ...{
                version: 1,
                value: {
                  applied: false,
                  digest: pkg.digest,
                  files: pkg.files.length,
                  bytes: Buffer.byteLength(bytes),
                  output,
                },
              },
            },
            context,
          );
        if (
          !args.flag('yes') &&
          !(await confirm(context.host.interaction, 'Write validated knowledge package.\n', 'Apply? [y/N] '))
        )
          return answer(
            { ok: true, ...{ version: 1, value: { applied: false, digest: pkg.digest, output } } },
            context,
          );
        // Confirmation is an asynchronous boundary; authority and sources must still be current.
        const current = openSession(root);
        try {
          requireProfile({
            reader: current.reader,
            within: current.reader.resolveScope().token,
            context,
            mode,
            path: destination.path,
          });
          if (current.reader.revision !== session.reader.revision)
            throw new Refusal(
              'IA-CLI-CONFLICT',
              'Workspace changed before export',
              3,
              null,
              'Run "ia kb pack --help" and preview the export again',
            );
          const applied = destination.write();
          return answer(
            { ok: true, ...{ version: 1, value: { applied, unchanged: !applied, digest: pkg.digest, output } } },
            context,
          );
        } finally {
          current.close();
        }
      }
      const citation = args.value('citation');
      const input =
        operation === 'search'
          ? { query: args.positionals[1], limit: args.integer('limit', 100) }
          : operation === 'read'
            ? { locator: args.positionals[1] }
            : operation === 'traverse'
              ? { identity: args.positionals[1], steps: args.integer('steps', 64) }
              : operation === 'resolve'
                ? { citation: citationFile(root, citation!) }
                : {};
      try {
        parseKnowledgeRequest(operation, input);
      } catch {
        throw new UsageError('Invalid kb request; see ia kb ' + operation + ' --help');
      }
      const view = openKnowledgeView(captureKnowledge(root, { expectedRevision: session.reader.revision }));
      try {
        const result = executeKnowledge(view, operation as KnowledgeOperation, input);
        if (result.error) throw knowledgeRefusal(result.error.code, result.error.message, operation);
        return answer(result, context);
      } finally {
        view.close();
      }
    } catch (error) {
      if (error instanceof KnowledgeError) throw knowledgeRefusal(error.code, error.message, operation);
      throw error;
    }
  } finally {
    session.close();
  }
}
