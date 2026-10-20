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
const unrecognized = 'Refusing unrecognized release/next commits; preserve and reconcile maintainer amendments';
/** The message the automation writes: stable subject, ownership marker and base trailer. */
const marked = (version: string, base: string) =>
  `Release ${version}\n\nIA-Release-Automation: v1\nIA-Release-Base: ${base}`;
const stageVersion = async (root: string, text: string) => {
  writeFileSync(resolve(root, 'version.txt'), `${text}\n`);
  await git(root, 'add', 'version.txt');
};
const originOf = (root: string) => resolve(root, '.git/remote.git');
/** A repository on main whose origin is a fresh bare remote holding the one base commit. */
const withOrigin = (run: (root: string, base: string) => Promise<void>) =>
  inRepository(async (root) => {
    await git(root, 'init', '--bare', '--quiet', originOf(root));
    await stageVersion(root, 'base');
    await git(root, 'commit', '--quiet', '-m', 'Base');
    await git(root, 'remote', 'add', 'origin', originOf(root));
    await git(root, 'push', '--quiet', 'origin', 'main');
    await git(root, 'fetch', '--quiet', 'origin');
    await run(root, await git(root, 'rev-parse', 'HEAD'));
  });
/** Moves main and origin/main one commit past the base and returns the new tip. */
const advanceMain = async (root: string) => {
  writeFileSync(resolve(root, 'other.txt'), 'main\n');
  await git(root, 'add', 'other.txt');
  await git(root, 'commit', '--quiet', '-m', 'Advance main');
  await git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  await git(root, 'fetch', '--quiet', 'origin');
  return git(root, 'rev-parse', 'HEAD');
};
/** Commits the staged change with the release bot as committer and, unless another is named, as author. */
const botCommit = async (root: string, message: string, author = `github-actions[bot] <${bot}>`) => {
  await git(
    root,
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    `user.email=${bot}`,
    'commit',
    '--quiet',
    '--author',
    author,
    '-m',
    message,
  );
  return git(root, 'rev-parse', 'HEAD');
};
/** Amends HEAD in place as a maintainer, which keeps its author, message and parent and changes its committer. */
const amendAsMaintainer = async (root: string) => {
  await stageVersion(root, 'maintainer fix');
  await git(
    root,
    '-c',
    'user.name=Maintainer',
    '-c',
    'user.email=maintainer@example.com',
    'commit',
    '--quiet',
    '--amend',
    '--no-edit',
  );
  return git(root, 'rev-parse', 'HEAD');
};
/** Author, committer, parents and message: every commit field the recognition reads. */
const recognitionInputs = (root: string, commit: string) =>
  git(root, 'show', '-s', '--format=%ae%n%ce%n%P%n%B', commit);
const remoteHead = (root: string) => git(root, 'ls-remote', 'origin', 'refs/heads/release/next');

/**
 * Publishes the commit `build` returns as release/next, then requires both operations, run from origin/main, to fail
 * with the exact refusal and leave that commit in place. Each builder breaks one recognition clause and keeps the rest.
 * The message must be exact: without the single-commit or single-parent clause the code still throws, but from
 * `git merge-base`.
 */
const refusesAndPreserves = (name: string, build: (root: string, base: string) => Promise<string>) =>
  it.each(['update', 'delete'] as const)(
    `refuses and preserves ${name} for %s`,
    async (operation) => {
      const { updateReleaseBranch, deleteReleaseBranch } = await import('./release-branch.mjs');
      await withOrigin(async (root, base) => {
        const preserved = await build(root, base);
        await git(root, 'push', '--quiet', '--force', 'origin', `${preserved}:refs/heads/release/next`);
        await git(root, 'switch', '--quiet', '--detach', 'origin/main');
        if (operation === 'update') await stageVersion(root, 'next');
        expect(() => (operation === 'update' ? updateReleaseBranch(root, '9.9.9') : deleteReleaseBranch(root))).toThrow(
          new Error(unrecognized),
        );
        expect(await remoteHead(root)).toBe(`${preserved}\trefs/heads/release/next`);
      });
    },
    60_000,
  );

// Identity: the committer alone changes; author, subject, marker, base trailer and parent stay the automation's.
refusesAndPreserves('a marked bot release commit a maintainer amended in place', async (root, base) => {
  const { updateReleaseBranch } = await import('./release-branch.mjs');
  await stageVersion(root, '1.1.0');
  updateReleaseBranch(root, '1.1.0');
  const amended = await amendAsMaintainer(root);
  expect(await recognitionInputs(root, amended)).toBe(
    `${bot}\nmaintainer@example.com\n${base}\n${marked('1.1.0', base)}`,
  );
  return amended;
});

// Identity: the legacy form, whose base is its parent, with the committer alone changed.
refusesAndPreserves('a legacy bot release commit a maintainer amended in place', async (root, base) => {
  await stageVersion(root, 'legacy');
  await botCommit(root, 'Release 3.2.2');
  const amended = await amendAsMaintainer(root);
  expect(await recognitionInputs(root, amended)).toBe(`${bot}\nmaintainer@example.com\n${base}\nRelease 3.2.2`);
  return amended;
});

// Identity: the author alone differs; the bot committed it.
refusesAndPreserves('a marked release commit the bot committed for a maintainer author', async (root, base) => {
  await stageVersion(root, '1.2.0');
  const commit = await botCommit(root, marked('1.2.0', base), 'Maintainer <maintainer@example.com>');
  expect(await recognitionInputs(root, commit)).toBe(
    `maintainer@example.com\n${bot}\n${base}\n${marked('1.2.0', base)}`,
  );
  return commit;
});

// Single commit: the upper commit's base trailer names its own parent, the lower automation commit.
refusesAndPreserves('two stacked bot release commits', async (root) => {
  const { updateReleaseBranch } = await import('./release-branch.mjs');
  await stageVersion(root, '1.1.0');
  const lower = updateReleaseBranch(root, '1.1.0').head;
  await stageVersion(root, '1.2.0');
  const upper = await botCommit(root, marked('1.2.0', lower));
  expect(await recognitionInputs(root, upper)).toBe(`${bot}\n${bot}\n${lower}\n${marked('1.2.0', lower)}`);
  return upper;
});

// Base: the trailer names an older main commit, still an ancestor of origin/main, instead of the parent.
refusesAndPreserves('a bot release commit whose base trailer names an older main commit', async (root, base) => {
  const tip = await advanceMain(root);
  await stageVersion(root, '1.2.0');
  const commit = await botCommit(root, marked('1.2.0', base));
  expect(await recognitionInputs(root, commit)).toBe(`${bot}\n${bot}\n${tip}\n${marked('1.2.0', base)}`);
  return commit;
});

// Single parent: a legacy-form merge whose two parents are both on main.
refusesAndPreserves('a legacy bot release merge commit', async (root, base) => {
  const tip = await advanceMain(root);
  await stageVersion(root, '1.2.0');
  const tree = await git(root, 'write-tree');
  const args = ['commit-tree', tree, '-p', tip, '-p', base, '-m', 'Release 1.2.0'];
  const merge = await git(root, '-c', 'user.name=github-actions[bot]', '-c', `user.email=${bot}`, ...args);
  expect(await recognitionInputs(root, merge)).toBe(`${bot}\n${bot}\n${tip} ${base}\nRelease 1.2.0`);
  return merge;
});

// Marker: subject and base trailer present, so not legacy, but the only marker-like line names another version.
refusesAndPreserves('a bot release commit without the exact automation marker line', async (root, base) => {
  await stageVersion(root, '1.2.0');
  const message = `Release 1.2.0\n\nIA-Release-Automation: v10\nIA-Release-Base: ${base}`;
  const commit = await botCommit(root, message);
  expect(await recognitionInputs(root, commit)).toBe(`${bot}\n${bot}\n${base}\n${message}`);
  return commit;
});

// Subject: marker and base trailer present, subject a prerelease rather than a stable version.
refusesAndPreserves('a bot release commit whose subject is not a stable version', async (root, base) => {
  await stageVersion(root, '1.2.0');
  const commit = await botCommit(root, marked('1.2.0-rc.1', base));
  expect(await recognitionInputs(root, commit)).toBe(`${bot}\n${bot}\n${base}\n${marked('1.2.0-rc.1', base)}`);
  return commit;
});

it.each(['update', 'delete'] as const)(
  'replaces or deletes a maintainer release/next head already merged into origin/main for %s',
  async (operation) => {
    const { updateReleaseBranch, deleteReleaseBranch } = await import('./release-branch.mjs');
    await withOrigin(async (root) => {
      // Unmerged, this maintainer commit would be refused; merged, it is part of main.
      await stageVersion(root, 'maintained');
      await git(root, 'commit', '--quiet', '-m', 'Maintain generated assets');
      const merged = await git(root, 'rev-parse', 'HEAD');
      await git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/release/next', 'HEAD:refs/heads/main');
      await git(root, 'fetch', '--quiet', 'origin');
      if (operation === 'update') {
        await stageVersion(root, 'next');
        const { head, previous } = updateReleaseBranch(root, '1.2.0');
        expect(previous).toBe(merged);
        expect(await remoteHead(root)).toBe(`${head}\trefs/heads/release/next`);
      } else {
        expect(deleteReleaseBranch(root).previous).toBe(merged);
        expect(await remoteHead(root)).toBe('');
      }
    });
  },
  60_000,
);

it('refuses an update that does not start at origin/main and preserves release/next', async () => {
  const { updateReleaseBranch } = await import('./release-branch.mjs');
  await withOrigin(async (root) => {
    await stageVersion(root, '1.1.0');
    const { head } = updateReleaseBranch(root, '1.1.0');
    // HEAD is still the previous release commit, one past origin/main.
    await stageVersion(root, '1.2.0');
    expect(() => updateReleaseBranch(root, '1.2.0')).toThrow(new Error('Release update must start at origin/main'));
    expect(await remoteHead(root)).toBe(`${head}\trefs/heads/release/next`);
  });
}, 60_000);

it.each(['update', 'delete'] as const)(
  'refuses and preserves release/next when it moves to a child commit between listing and fetch for %s',
  async (operation) => {
    const { execFileSync } = await import('node:child_process');
    const { updateReleaseBranch, deleteReleaseBranch } = await import('./release-branch.mjs');
    await withOrigin(async (root) => {
      await stageVersion(root, '1.1.0');
      const { head } = updateReleaseBranch(root, '1.1.0');
      const child = await git(
        root,
        'commit-tree',
        `${head}^{tree}`,
        '-p',
        head,
        '-m',
        'Concurrent maintainer amendment',
      );
      await git(root, 'push', '--quiet', 'origin', `${child}:refs/heads/human-object`);
      await git(root, 'switch', '--quiet', '--detach', 'origin/main');
      if (operation === 'update') await stageVersion(root, 'next');
      race.beforeFetch = () => {
        const move = ['--git-dir', originOf(root), 'update-ref', 'refs/heads/release/next', child, head];
        execFileSync('git', move, { timeout: 10_000 });
      };
      try {
        expect(() => (operation === 'update' ? updateReleaseBranch(root, '9.9.9') : deleteReleaseBranch(root))).toThrow(
          new Error('release/next changed during inspection'),
        );
        expect(race.beforeFetch).toBeUndefined();
        expect(await remoteHead(root)).toBe(`${child}\trefs/heads/release/next`);
      } finally {
        race.beforeFetch = undefined;
      }
    });
  },
  60_000,
);
