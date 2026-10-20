import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { inRepository, git } from './release-fixtures.js';

const race = vi.hoisted(() => ({
  beforePush: undefined as (() => void) | undefined,
  beforeFetch: undefined as (() => void) | undefined,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      // Advance the remote before push starts, including before its advertisement.
      // A pre-push hook runs too late to distinguish --force from an expected-head lease.
      if (args[0] === 'git' && Array.isArray(args[1]) && args[1][0] === 'push' && race.beforePush) {
        const advance = race.beforePush;
        race.beforePush = undefined;
        advance();
      }
      // Advance the remote between the inspection's ls-remote and its fetch.
      if (args[0] === 'git' && Array.isArray(args[1]) && args[1][0] === 'fetch' && race.beforeFetch) {
        const advance = race.beforeFetch;
        race.beforeFetch = undefined;
        advance();
      }
      return actual.execFileSync(...args);
    },
  };
});

it('requires guarded release-branch updates in the workflow', () => {
  const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/release-pr.yml'), 'utf8');
  expect(workflow).not.toContain('git push --force origin');
  expect(workflow).toContain('release-branch.mjs update');
  expect(workflow).not.toContain('--delete-branch');
});

it('preserves foreign branch commits and updates only an identified automation commit', async () => {
  const { updateReleaseBranch, deleteReleaseBranch } = await import('./release-branch.mjs');
  await inRepository(async (root) => {
    const remote = resolve(root, '.git/test-remote.git');
    await git(root, 'init', '--bare', '--quiet', remote);
    writeFileSync(resolve(root, 'version.txt'), '1.0.0\n');
    await git(root, 'add', 'version.txt');
    await git(root, 'commit', '--quiet', '-m', 'Initial');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '--quiet', 'origin', 'main');
    await git(root, 'fetch', '--quiet', 'origin');
    const base = await git(root, 'rev-parse', 'HEAD');
    const stage = async (version: string) => {
      writeFileSync(resolve(root, 'version.txt'), version + '\n');
      await git(root, 'add', 'version.txt');
    };
    await stage('1.1.0');
    const first = updateReleaseBranch(root, '1.1.0');
    expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toContain(first.head);
    await git(root, 'switch', '--detach', base);
    await stage('1.2.0');
    const second = updateReleaseBranch(root, '1.2.0');
    expect(second.previous).toBe(first.head);
    // A maintainer's generated amendment is a distinct commit and must survive the next update attempt.
    await stage('human amendment');
    await git(root, 'commit', '--quiet', '-m', 'Maintain generated assets');
    await git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/release/next');
    const human = await git(root, 'rev-parse', 'HEAD');
    await git(root, 'switch', '--detach', base);
    await stage('1.3.0');
    expect(() => updateReleaseBranch(root, '1.3.0')).toThrow('unrecognized release/next commits');
    expect(() => deleteReleaseBranch(root)).toThrow('unrecognized release/next commits');
    expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toContain(human);
  });
}, 60_000);

it.each(['update', 'delete'] as const)(
  'preserves a concurrent remote amendment before %s push advertisement',
  async (operation) => {
    const { execFileSync } = await import('node:child_process');
    const { updateReleaseBranch, deleteReleaseBranch } = await import('./release-branch.mjs');
    await inRepository(async (root) => {
      const remote = resolve(root, '.git/remote.git');
      await git(root, 'init', '--bare', '--quiet', remote);
      writeFileSync(resolve(root, 'version.txt'), 'base\n');
      await git(root, 'add', 'version.txt');
      await git(root, 'commit', '--quiet', '-m', 'Base');
      await git(root, 'remote', 'add', 'origin', remote);
      await git(root, 'push', '--quiet', 'origin', 'main');
      await git(root, 'fetch', '--quiet', 'origin');
      const base = await git(root, 'rev-parse', 'HEAD');
      writeFileSync(resolve(root, 'version.txt'), 'release\n');
      await git(root, 'add', 'version.txt');
      const first = updateReleaseBranch(root, '1.0.1');
      const human = await git(
        root,
        'commit-tree',
        `${first.head}^{tree}`,
        '-p',
        first.head,
        '-m',
        'Concurrent maintainer amendment',
      );
      await git(root, 'push', '--quiet', 'origin', `${human}:refs/heads/human-object`);
      await git(root, 'switch', '--quiet', '--detach', base);
      writeFileSync(resolve(root, 'version.txt'), 'next\n');
      await git(root, 'add', 'version.txt');
      race.beforePush = () => {
        execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/release/next', human, first.head], {
          timeout: 10000,
        });
      };
      try {
        expect(() =>
          operation === 'update' ? updateReleaseBranch(root, '1.0.2') : deleteReleaseBranch(root),
        ).toThrow();
        expect(race.beforePush).toBeUndefined();
        expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toContain(human);
        // The race is gone; a recognized branch can be deleted and repeated deletion is harmless.
        await git(root, '--git-dir', remote, 'update-ref', 'refs/heads/release/next', first.head, human);
        expect(deleteReleaseBranch(root).previous).toBe(first.head);
        expect(deleteReleaseBranch(root).previous).toBe('');
      } finally {
        race.beforePush = undefined;
      }
    });
  },
  60000,
);

it.each(['update', 'delete'] as const)(
  'migrates a single legacy bot release commit for %s',
  async (operation) => {
    const { updateReleaseBranch, deleteReleaseBranch } = await import('./release-branch.mjs');
    await inRepository(async (root) => {
      const remote = resolve(root, '.git/legacy-remote.git');
      await git(root, 'init', '--bare', '--quiet', remote);
      writeFileSync(resolve(root, 'version.txt'), 'base');
      await git(root, 'add', 'version.txt');
      await git(root, 'commit', '--quiet', '-m', 'Base');
      await git(root, 'remote', 'add', 'origin', remote);
      await git(root, 'push', '--quiet', 'origin', 'main');
      await git(root, 'fetch', '--quiet', 'origin');
      const base = await git(root, 'rev-parse', 'HEAD');
      writeFileSync(resolve(root, 'version.txt'), 'legacy');
      await git(root, 'add', 'version.txt');
      await git(
        root,
        '-c',
        'user.name=github-actions[bot]',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit',
        '--quiet',
        '-m',
        'Release 3.2.2',
      );
      const legacy = await git(root, 'rev-parse', 'HEAD');
      await git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/release/next');
      await git(root, 'switch', '--detach', base);
      if (operation === 'update') {
        writeFileSync(resolve(root, 'version.txt'), 'next');
        await git(root, 'add', 'version.txt');
        expect(updateReleaseBranch(root, '3.2.3').previous).toBe(legacy);
      } else {
        expect(deleteReleaseBranch(root).previous).toBe(legacy);
        expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toBe('');
      }
    });
  },
  60000,
);

const bot = '41898282+github-actions[bot]@users.noreply.github.com';
/** A remote whose main has two commits, plus a commit factory with explicit author and committer identities. */
async function clauseFixture(root: string) {
  const { execFileSync } = await import('node:child_process');
  const remote = resolve(root, '.git/clause-remote.git');
  await git(root, 'init', '--bare', '--quiet', remote);
  writeFileSync(resolve(root, 'version.txt'), 'first\n');
  await git(root, 'add', 'version.txt');
  await git(root, 'commit', '--quiet', '-m', 'First');
  const first = await git(root, 'rev-parse', 'HEAD');
  writeFileSync(resolve(root, 'version.txt'), 'base\n');
  await git(root, 'add', 'version.txt');
  await git(root, 'commit', '--quiet', '-m', 'Base');
  const base = await git(root, 'rev-parse', 'HEAD');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '--quiet', 'origin', 'main');
  await git(root, 'fetch', '--quiet', 'origin');
  const commit = (
    parents: string[],
    message: string,
    { author = bot, committer = bot }: { author?: string; committer?: string } = {},
  ) =>
    execFileSync(
      'git',
      ['commit-tree', `${base}^{tree}`, ...parents.flatMap((parent) => ['-p', parent]), '-m', message],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'author',
          GIT_AUTHOR_EMAIL: author,
          GIT_COMMITTER_NAME: 'committer',
          GIT_COMMITTER_EMAIL: committer,
        },
      },
    ).trim();
  const publish = async (head: string) =>
    git(root, 'push', '--quiet', '--force', 'origin', `${head}:refs/heads/release/next`);
  const automation = (parent = base) => `Release 1.1.0\n\nIA-Release-Automation: v1\nIA-Release-Base: ${parent}`;
  return { first, base, commit, publish, automation };
}

// One case per recognition clause: each differs from an accepted automation commit in that clause alone.
it.each([
  ['a merge parent', 'merge'],
  ['a declared base other than its parent', 'base'],
  ['no automation marker', 'marker'],
  ['a subject that is not a stable release', 'subject'],
  ['a maintainer author', 'author'],
  ['a maintainer committer', 'committer'],
  ['an unmarked commit on top', 'unmarked'],
  ['a marked preparation merge on top', 'preparation-merge'],
  ['a preparation commit without the automation commit', 'preparation-only'],
] as const)(
  'refuses an automation commit with %s',
  async (_label, clause) => {
    const { deleteReleaseBranch } = await import('./release-branch.mjs');
    await inRepository(async (root) => {
      const { first, base, commit, publish, automation } = await clauseFixture(root);
      const valid = () => commit([base], automation());
      const head = {
        merge: () => commit([base, first], automation()),
        base: () => commit([base], automation(first)),
        marker: () => commit([base], `Release 1.1.0\n\nIA-Release-Base: ${base}`),
        subject: () => commit([base], automation().replace('1.1.0', '1.1')),
        author: () => commit([base], automation(), { author: 'maintainer@example.com' }),
        committer: () => commit([base], automation(), { committer: 'maintainer@example.com' }),
        unmarked: () => commit([valid()], 'Regenerate assets'),
        'preparation-merge': () =>
          commit([valid(), first], 'Regenerate assets\n\nIA-Release-Preparation: v1', {
            author: 'maintainer@example.com',
          }),
        'preparation-only': () => commit([base], 'Regenerate assets\n\nIA-Release-Preparation: v1'),
      }[clause]();
      await publish(head);
      expect(() => deleteReleaseBranch(root)).toThrow('unrecognized release/next commits');
      expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toContain(head);
      // The same fixture accepts the unmodified automation commit.
      const accepted = valid();
      await publish(accepted);
      expect(deleteReleaseBranch(root).previous).toBe(accepted);
    });
  },
  60_000,
);

it.each(['update', 'delete'] as const)(
  'replaces marked maintainer preparation commits on %s',
  async (operation) => {
    const { PREPARATION_MARKER, updateReleaseBranch, deleteReleaseBranch } = await import('./release-branch.mjs');
    await inRepository(async (root) => {
      const { base, commit, publish, automation } = await clauseFixture(root);
      const maintainer = { author: 'maintainer@example.com', committer: 'maintainer@example.com' };
      const prepared = commit([commit([base], automation())], `Regenerate assets\n\n${PREPARATION_MARKER}`, maintainer);
      const refreshed = commit([prepared], `Refresh coverage\n\n${PREPARATION_MARKER}`, maintainer);
      await publish(refreshed);
      if (operation === 'update') {
        writeFileSync(resolve(root, 'version.txt'), 'next\n');
        await git(root, 'add', 'version.txt');
        const result = updateReleaseBranch(root, '1.2.0');
        expect(result.previous).toBe(refreshed);
        expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toContain(result.head);
      } else {
        expect(deleteReleaseBranch(root).previous).toBe(refreshed);
        expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toBe('');
      }
    });
  },
  60_000,
);

/** The exact refusal: without the single-parent clause, a legacy merge passes recognition and fails in `git merge-base`. */
const unrecognized =
  'Refusing unrecognized release/next commits; preserve and reconcile maintainer amendments ' +
  '(release preparation commits carry the line "IA-Release-Preparation: v1")';
const byMaintainer = { author: 'maintainer@example.com', committer: 'maintainer@example.com' };
type Clauses = Awaited<ReturnType<typeof clauseFixture>>;

// Near misses the per-clause table leaves open: each refused head differs from the accepted head beside it in one
// detail, which a looser pattern, a substring match, a dropped single-parent test or an identity check limited to
// marked commits would admit.
it.each<[string, (fixture: Clauses) => [refused: string, accepted: string]]>([
  [
    'a legacy prerelease subject',
    ({ base, commit }) => [commit([base], 'Release 1.1.0-rc.1'), commit([base], 'Release 1.1.0')],
  ],
  [
    'no blank line after the subject',
    ({ base, commit, automation }) => [
      commit([base], automation().replace('\n\n', '\n')),
      commit([base], automation()),
    ],
  ],
  [
    'an automation marker for another version',
    ({ base, commit, automation }) => [
      commit([base], automation().replace('Automation: v1', 'Automation: v10')),
      commit([base], automation()),
    ],
  ],
  [
    'a legacy merge commit',
    ({ first, base, commit }) => [commit([base, first], 'Release 1.1.0'), commit([base], 'Release 1.1.0')],
  ],
  [
    // An in-place amend keeps the bot author and makes the maintainer the committer.
    'a legacy commit a maintainer amended in place',
    ({ base, commit }) => [
      commit([base], 'Release 1.1.0', { committer: 'maintainer@example.com' }),
      commit([base], 'Release 1.1.0'),
    ],
  ],
  [
    'a legacy commit a maintainer authored',
    ({ base, commit }) => [
      commit([base], 'Release 1.1.0', { author: 'maintainer@example.com' }),
      commit([base], 'Release 1.1.0'),
    ],
  ],
])(
  'refuses a near miss with %s',
  async (_label, build) => {
    const { deleteReleaseBranch } = await import('./release-branch.mjs');
    await inRepository(async (root) => {
      const fixture = await clauseFixture(root);
      const [refused, accepted] = build(fixture);
      await fixture.publish(refused);
      expect(() => deleteReleaseBranch(root)).toThrow(new Error(unrecognized));
      expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toBe(
        `${refused}\trefs/heads/release/next`,
      );
      // The same fixture accepts the head that differs only in that detail.
      await fixture.publish(accepted);
      expect(deleteReleaseBranch(root).previous).toBe(accepted);
    });
  },
  60_000,
);

it.each(['update', 'delete'] as const)(
  'accepts a release/next head already merged into origin/main on %s',
  async (operation) => {
    const { updateReleaseBranch, deleteReleaseBranch } = await import('./release-branch.mjs');
    await inRepository(async (root) => {
      // A maintainer's commit on main: unmerged it would be refused; merged, it is part of main.
      const { first, publish } = await clauseFixture(root);
      await publish(first);
      if (operation === 'update') {
        writeFileSync(resolve(root, 'version.txt'), 'next\n');
        await git(root, 'add', 'version.txt');
        const { head, previous } = updateReleaseBranch(root, '1.2.0');
        expect(previous).toBe(first);
        expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toBe(
          `${head}\trefs/heads/release/next`,
        );
      } else {
        expect(deleteReleaseBranch(root).previous).toBe(first);
        expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toBe('');
      }
    });
  },
  60_000,
);

it('refuses an update that does not start at origin/main and preserves release/next', async () => {
  const { updateReleaseBranch } = await import('./release-branch.mjs');
  await inRepository(async (root) => {
    const { first, base, commit, publish, automation } = await clauseFixture(root);
    const accepted = commit([base], automation());
    await publish(accepted);
    // origin/main is base; start one commit behind it.
    await git(root, 'switch', '--quiet', '--detach', first);
    writeFileSync(resolve(root, 'version.txt'), 'next\n');
    await git(root, 'add', 'version.txt');
    expect(() => updateReleaseBranch(root, '1.2.0')).toThrow(new Error('Release update must start at origin/main'));
    expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toBe(
      `${accepted}\trefs/heads/release/next`,
    );
  });
}, 60_000);

it('refuses and preserves release/next when it moves between listing and fetch', async () => {
  const { execFileSync } = await import('node:child_process');
  const { deleteReleaseBranch } = await import('./release-branch.mjs');
  await inRepository(async (root) => {
    const { base, commit, publish, automation } = await clauseFixture(root);
    // Either head alone is accepted, so only the move can cause the refusal.
    const listed = commit([base], automation());
    const moved = commit([listed], 'Regenerate assets\n\nIA-Release-Preparation: v1', byMaintainer);
    await publish(listed);
    await git(root, 'push', '--quiet', 'origin', `${moved}:refs/heads/moved`);
    const remote = await git(root, 'remote', 'get-url', 'origin');
    race.beforeFetch = () => {
      const move = ['--git-dir', remote, 'update-ref', 'refs/heads/release/next', moved, listed];
      execFileSync('git', move, { timeout: 10_000 });
    };
    try {
      expect(() => deleteReleaseBranch(root)).toThrow(new Error('release/next changed during inspection'));
      expect(race.beforeFetch).toBeUndefined();
      expect(await git(root, 'ls-remote', 'origin', 'refs/heads/release/next')).toBe(
        `${moved}\trefs/heads/release/next`,
      );
      // With the race over, the moved head is recognized and deleted.
      expect(deleteReleaseBranch(root).previous).toBe(moved);
    } finally {
      race.beforeFetch = undefined;
    }
  });
}, 60_000);
