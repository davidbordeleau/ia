/** `ia project <host> --product plugin`: renders a lowered workspace back into a plugin directory, create-only. */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { PluginFile } from '@inventarch/workspace-runtime/internal/generate';
import { HostPluginError } from '@inventarch/workspace-runtime/internal/host-plugin';
import type { Context, Result } from './consumer.js';
import { Refusal, requireRoot } from './consumer.js';
import { renderPluginFor } from './host-projection.js';
import { writeFreshPlugin } from './plugin-sources.js';
import { quote } from './render.js';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface PluginView {
  out: string;
  files: { path: string; sha256: string }[];
}

const renderPluginPlan = (view: PluginView): string =>
  [`Would write ${view.files.length} files to ${view.out}:`, ...view.files.map((file) => `  ${file.path}`), ''].join(
    '\n',
  );

/** Replaced by the compare task. */
function checkPluginProduct(next: string): Result {
  throw new Refusal('IA-CLI-USAGE', '--check lands in the next task', 2, null, next);
}

export async function runPluginProduct(context: Context): Promise<Result> {
  const { args, json } = context;
  const root = requireRoot(context);
  const next = `Run "ia project ${args.positionals[0] ?? 'claude'} --product plugin --check --root ${quote(root)}" to compare without writing.`;
  try {
    if (args.flag('check')) return checkPluginProduct(next);
    const files: readonly PluginFile[] = renderPluginFor(root);
    const out = args.value('out');
    if (out === undefined)
      throw new Refusal('IA-CLI-USAGE', '--product plugin needs --out <directory> or --check', 2, null, next);
    const view: PluginView = {
      out: resolve(out),
      files: files.map((file) => ({ path: file.path, sha256: sha(file.bytes) })),
    };
    if (!args.flag('apply'))
      return { exitCode: 0, stdout: json ? `${JSON.stringify({ plan: view })}\n` : renderPluginPlan(view), stderr: '' };
    writeFreshPlugin(view.out, files);
    return {
      exitCode: 0,
      stdout: json ? `${JSON.stringify({ applied: view })}\n` : `Wrote ${files.length} files to ${view.out}.\n`,
      stderr: '',
    };
  } catch (error) {
    if (error instanceof HostPluginError) throw new Refusal(error.code, error.message, 1, { path: root }, next);
    throw error;
  }
}
