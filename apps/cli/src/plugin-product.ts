/** `ia project <host> --product plugin`: renders a lowered workspace back into a plugin directory, create-only. */
import { createHash } from 'node:crypto';
import type { PluginFile } from '@inventarch/workspace-runtime/internal/generate';
import { HostPluginError } from '@inventarch/workspace-runtime/internal/host-plugin';
import type { Context, Result } from './consumer.js';
import { confirm, Refusal, requireRoot } from './consumer.js';
import { renderPluginFor } from './host-projection.js';
import { checkPluginOut, writeFreshPlugin } from './plugin-sources.js';
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
    const given = args.value('out');
    if (given === undefined)
      throw new Refusal('IA-CLI-USAGE', '--product plugin needs --out <directory> or --check', 2, null, next);
    const out = checkPluginOut(root, given);
    const files: readonly PluginFile[] = renderPluginFor(root);
    const view: PluginView = {
      out,
      files: files.map((file) => ({ path: file.path, sha256: sha(file.bytes) })),
    };
    if (!args.flag('apply'))
      return { exitCode: 0, stdout: json ? `${JSON.stringify({ plan: view })}\n` : renderPluginPlan(view), stderr: '' };
    if (
      !args.flag('yes') &&
      !(await confirm(context.host.interaction, renderPluginPlan(view), 'Write this plugin? [y/N] '))
    )
      return { exitCode: 0, stdout: `Nothing was applied.${'\n'}`, stderr: '' };
    writeFreshPlugin(view.out, files);
    return {
      exitCode: 0,
      stdout: json ? `${JSON.stringify({ applied: view })}\n` : `Wrote ${files.length} files to ${view.out}.\n`,
      stderr: '',
    };
  } catch (error) {
    if (error instanceof HostPluginError) {
      const fix =
        error.code === 'IA-PLUGIN-OUT'
          ? 'Run "ia project --help" for the options, and choose an absent or empty output directory outside the workspace.'
          : error.code === 'IA-RESOURCE-DIGEST' || error.code === 'IA-PLUGIN-PRODUCT'
            ? 'Run "ia init --help" to lower the plugin again from its source, then project it.'
            : next;
      throw new Refusal(error.code, error.message, 1, { path: root }, fix);
    }
    throw error;
  }
}
