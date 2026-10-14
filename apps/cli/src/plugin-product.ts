/** `ia project <host> --product plugin`: renders a lowered workspace back into a plugin directory, create-only. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginFile } from '@inventarch/workspace-runtime/internal/generate';
import {
  comparePlugin,
  HostPluginError,
  inventoryOf,
  lowerPlugin,
  readEntries,
} from '@inventarch/workspace-runtime/internal/host-plugin';
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

/** Renders in memory, lowers the result again and proves content-exact plus fixed point; writes nothing. */
function checkPluginProduct(context: Context, root: string, files: readonly PluginFile[]): Result {
  const { args, json } = context;
  const compare = args.value('compare');
  const diffs = compare === undefined ? [] : comparePlugin(readEntries(resolve(compare)), files);
  const drift = diffs.filter((d) => d.status === 'drift' || d.status === 'missing' || d.status === 'extra');
  const systems = readdirSync(resolve(root, '.ia/src/systems'));
  if (systems.length !== 1)
    throw new Refusal(
      'IA-PLUGIN-PRODUCT',
      `A lowered workspace holds one system under .ia/src/systems; found ${systems.length}`,
      1,
      { path: root },
      'Run "ia init --help" to lower the plugin into a kit workspace first.',
    );
  const system = systems[0]!;
  const again = lowerPlugin(inventoryOf(files.map((f) => ({ path: f.path, bytes: f.bytes }))), system);
  const fixedPoint = again.files
    .filter((f) => !existsSync(resolve(root, f.path)) || !readFileSync(resolve(root, f.path)).equals(f.bytes))
    .map((f) => f.path);
  const report = {
    compared: compare !== undefined,
    diffs,
    drift,
    fixedPoint,
    unresolved: again.unresolved,
  };
  if (drift.length > 0 || fixedPoint.length > 0 || again.unresolved.length > 0)
    throw new Refusal(
      'IA-ROUNDTRIP-DRIFT',
      `${drift.length} drifted file(s) and ${fixedPoint.length} fixed-point mismatch(es): ${[...drift.map((d) => d.path), ...fixedPoint].slice(0, 20).join(', ')}`,
      1,
      { path: root },
      `Run "ia project ${args.positionals[0] ?? 'claude'} --product plugin --check --root ${quote(root)} --json" for the full report.`,
    );
  return {
    exitCode: 0,
    stdout: json ? `${JSON.stringify(report)}\n` : renderCheck(report),
    stderr: '',
  };
}

const renderCheck = (report: { diffs: { path: string; status: string; rules: readonly string[] }[] }): string =>
  [
    'Round trip: content-exact and a fixed point.',
    ...report.diffs.filter((d) => d.status !== 'identical').map((d) => `  ${d.path}: ${d.rules.join(', ')}`),
    '',
  ].join('\n');

export async function runPluginProduct(context: Context): Promise<Result> {
  const { args, json } = context;
  const root = requireRoot(context);
  const next = `Run "ia project ${args.positionals[0] ?? 'claude'} --product plugin --check --root ${quote(root)}" to compare without writing.`;
  try {
    if (args.flag('check')) return checkPluginProduct(context, root, renderPluginFor(root));
    const given = args.value('out');
    if (given === undefined)
      throw new Refusal('IA-CLI-USAGE', '--product plugin needs --out <directory> or --check', 2, null, next);
    const out = checkPluginOut(root, given);
    const files: readonly PluginFile[] = renderPluginFor(root);
    const view: PluginView = {
      out,
      files: files.map((file) => ({
        path: file.path,
        sha256: sha(file.bytes),
      })),
    };
    if (!args.flag('apply'))
      return {
        exitCode: 0,
        stdout: json ? `${JSON.stringify({ plan: view })}\n` : renderPluginPlan(view),
        stderr: '',
      };
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
