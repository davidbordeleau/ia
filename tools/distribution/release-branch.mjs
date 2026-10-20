// @ts-check
import { parseArgs } from 'node:util';
import { isEntry } from '../entry/is-entry.mjs';
import { gitText } from '../shared/git.mjs';

const branch = 'refs/heads/release/next';
const marker = 'IA-Release-Automation: v1';
/** Marks a maintainer's release-preparation commit on top of the automation commit. The next update replaces it. */
export const PREPARATION_MARKER = 'IA-Release-Preparation: v1';
const bot = '41898282+github-actions[bot]@users.noreply.github.com';
const SHA = /^[a-f0-9]{40}$/;
const RELEASE = /^Release (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** @param {string} root @param {string[]} args */
const git = (root, ...args) => gitText(root, args);
/** @param {string} root @param {string} format @param {string} commit */
const show = (root, format, commit) => git(root, 'show', '-s', `--format=${format}`, commit);

/**
 * The automation commit: authored and committed by the bot, with exactly one parent, which its marked message names
 * as its base; or a single-line legacy bot release commit. Returns that base, or null when the commit is not one.
 * @param {string} root @param {string} commit
 */
function automationBase(root, commit) {
  const message = show(root, '%B', commit),
    parents = show(root, '%P', commit),
    lines = message.split('\n');
  const legacy = lines.length === 1 && RELEASE.test(message);
  const marked = RELEASE.test(lines[0] ?? '') && lines[1] === '' && lines.includes(marker);
  const base = legacy ? parents : message.match(/^IA-Release-Base: ([a-f0-9]{40})$/m)?.[1];
  const recognized =
    SHA.test(parents) &&
    base === parents &&
    (legacy || marked) &&
    show(root, '%ae', commit) === bot &&
    show(root, '%ce', commit) === bot;
  return recognized ? base : null;
}

/**
 * Inspect the remote itself, then bind the fetched commit before examining its ownership. Accepted: a merged branch,
 * or the automation commit followed by a linear chain of maintainer preparation commits, each with PREPARATION_MARKER
 * on a line of its own. Everything else is preserved for reconciliation. @param {string} root
 */
export function inspectReleaseBranch(root) {
  const remote = git(root, 'ls-remote', '--heads', 'origin', branch);
  if (!remote) return '';
  const expected = remote.split(/\s+/)[0];
  if (!expected || !SHA.test(expected)) throw new Error('Invalid release branch commit');
  git(root, 'fetch', '--quiet', '--no-tags', 'origin', branch);
  if (git(root, 'rev-parse', 'FETCH_HEAD') !== expected) throw new Error('release/next changed during inspection');
  // Oldest first. A merged branch can be replaced.
  const commits = git(root, 'rev-list', '--topo-order', '--reverse', `origin/main..${expected}`)
    .split('\n')
    .filter(Boolean);
  if (!commits.length) return expected;
  const [automation = '', ...preparation] = commits;
  const base = automationBase(root, automation);
  let previous = automation;
  const linear = preparation.every((commit) => {
    const prepared =
      show(root, '%P', commit) === previous && show(root, '%B', commit).split('\n').includes(PREPARATION_MARKER);
    previous = commit;
    return prepared;
  });
  if (!base || !linear || previous !== expected)
    throw new Error(
      'Refusing unrecognized release/next commits; preserve and reconcile maintainer amendments ' +
        `(release preparation commits carry the line "${PREPARATION_MARKER}")`,
    );
  git(root, 'merge-base', '--is-ancestor', base, 'origin/main');
  return expected;
}

/** Commit the already staged versioning outputs and replace only the inspected remote head. @param {string} root @param {string} version */
export function updateReleaseBranch(root, version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Stable version required');
  const base = git(root, 'rev-parse', 'HEAD');
  if (base !== git(root, 'rev-parse', 'origin/main')) throw new Error('Release update must start at origin/main');
  const previous = inspectReleaseBranch(root);
  git(
    root,
    '-c',
    `user.name=github-actions[bot]`,
    '-c',
    `user.email=${bot}`,
    'commit',
    '--quiet',
    '--author',
    `github-actions[bot] <${bot}>`,
    '-m',
    `Release ${version}`,
    '-m',
    `${marker}\nIA-Release-Base: ${base}`,
  );
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'push', `--force-with-lease=${branch}:${previous}`, 'origin', `HEAD:${branch}`);
  return { head, previous };
}

/** @param {string} root */
export function deleteReleaseBranch(root) {
  const previous = inspectReleaseBranch(root);
  if (previous) git(root, 'push', `--force-with-lease=${branch}:${previous}`, 'origin', `:${branch}`);
  return { previous };
}

if (isEntry(process.argv[1], import.meta.url)) {
  let args;
  try {
    args = parseArgs({ allowPositionals: true, options: { version: { type: 'string' } } });
    if (
      args.positionals.length !== 1 ||
      !['update', 'delete'].includes(args.positionals[0] ?? '') ||
      (args.positionals[0] === 'update' ? !args.values.version : args.values.version !== undefined)
    )
      throw new Error();
  } catch {
    console.error('Usage: release-branch.mjs update --version <stable-version> | delete');
    process.exitCode = 2;
  }
  if (args && !process.exitCode)
    try {
      console.log(
        JSON.stringify(
          args.positionals[0] === 'update'
            ? updateReleaseBranch(process.cwd(), args.values.version ?? '')
            : deleteReleaseBranch(process.cwd()),
        ),
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
