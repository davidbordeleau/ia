import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ENVIRONMENT, NPM_VERSION, publicationPlan, REPOSITORY, WORKFLOW } from './npm-release.mjs';
import { stableVersion } from './release-changes.mjs';
import {
  BOOTSTRAP_TAG,
  BOOTSTRAP_VERSION,
  accessState,
  applyNpm,
  bootstrapManifest,
  bootstrapStageId,
  compatibleNodeVersions,
  declaresPermissions,
  githubSetupPlan,
  inspectNpm,
  npmEngineSupported,
  npmSetupPlan,
  stageState,
  trustArgs,
  trustState,
} from './release-setup.mjs';

const root = resolve(import.meta.dirname, '../..');
const name = '@inventarch/runner';
const stageId = '13816920-8c62-4e6e-ae8f-cfc61f12fb71';
const otherStageId = 'bc61464c-63ad-48de-a66e-f42c0143b626';
const publisher = {
  id: 'tp_1',
  type: 'github',
  file: 'npm-publish.yml',
  repository: 'inventarch/ia',
  environment: 'npm',
  permissions: ['createPackage'],
};
const stage = { id: stageId, packageName: name, version: BOOTSTRAP_VERSION, status: 'staged' };
const packument = { name, versions: { '0.0.0-stage': {} }, 'dist-tags': { latest: '0.0.0-stage' } };
const staged = { [name]: { id: `${name}@${BOOTSTRAP_VERSION}`, name, version: BOOTSTRAP_VERSION, stageId } };
type Observation = { access: unknown; stages: unknown; trust: unknown; public: unknown };
const ready: Observation = { access: { [name]: 'public' }, stages: [], trust: publisher, public: packument };
const absent: Observation = {
  access: new Error('E404'),
  stages: [],
  trust: new Error('E404'),
  public: null,
};

// Every registry read is injected. Each public read completes one authenticated + anonymous inspection.
function registryFixture(observations: Observation[], write = (_args: string[]) => '') {
  let inspection = 0;
  const writes: string[][] = [];
  const npm = vi.fn((args: string[]) => {
    const current = observations[Math.min(inspection, observations.length - 1)]!;
    let result: unknown;
    if (args[0] === 'access' && args[1] === 'get') {
      expect(args).toEqual(['access', 'get', 'status', name, '--json']);
      result = current.access;
    } else if (args[0] === 'stage' && args[1] === 'list') {
      expect(args).toEqual(['stage', 'list', name, '--json']);
      result = current.stages;
    } else if (args[0] === 'trust' && args[1] === 'list') {
      expect(args).toEqual(['trust', 'list', name, '--json']);
      result = current.trust;
    } else {
      writes.push(args);
      return write(args);
    }
    if (result instanceof Error) throw result;
    return typeof result === 'string' ? result : JSON.stringify(result);
  });
  const readPublic = vi.fn(async (requested: string) => {
    expect(requested).toBe(name);
    const value = observations[Math.min(inspection++, observations.length - 1)]!.public;
    if (value instanceof Error) throw value;
    return value;
  });
  const log = vi.fn();
  return { npm, readPublic, log, writes };
}

beforeEach(() => {
  vi.spyOn(console, 'table').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it('trusts exactly the publishing workflow, environment and repository', () => {
  expect(trustArgs('@inventarch/cli')).toEqual([
    'trust',
    'github',
    '@inventarch/cli',
    '--file',
    'npm-publish.yml',
    '--repo',
    'inventarch/ia',
    '--environment',
    'npm',
    '--allow-publish',
    '--yes',
  ]);
  expect([WORKFLOW, REPOSITORY, ENVIRONMENT]).toEqual(['npm-publish.yml', 'inventarch/ia', 'npm']);
  expect(() => trustArgs('@inventarch/cli --allow-stage-publish')).toThrow(/Unexpected package name/);
  expect(() => trustArgs('left-pad')).toThrow(/Unexpected package name/);
});

it('reads npm trust list --json: nothing is missing, ours is configured, anything else is never overwritten', () => {
  // The shape npm 12.2.0 prints: one object of { id, type, file, repository, environment, permissions } per config.
  const ours = publisher;
  expect(trustState('')).toEqual({ state: 'missing' });
  expect(trustState('\n')).toEqual({ state: 'missing' });
  expect(trustState(JSON.stringify(ours, null, 2)).state).toBe('configured');
  expect(trustState(JSON.stringify({ ...ours, file: '.github/workflows/npm-publish.yml' })).state).toBe('configured');
  for (const other of [
    { environment: 'production' },
    { file: 'release.yml' },
    { repository: 'someone/ia' },
    { type: 'gitlab' },
    { permissions: [] },
    { permissions: ['createStagedPackage'] },
    { permissions: undefined },
  ])
    expect(trustState(JSON.stringify({ ...ours, ...other })).state).toBe('different');
  expect(trustState('No trust configurations found').state).toBe('unknown');
});

it('runs npm with the newest installed Node its engine admits', () => {
  expect(compatibleNodeVersions(['v22.22.0', 'v22.22.2', '.downloads', 'v24.15.1', 'v20.19.0'])).toEqual([
    'v24.15.1',
    'v22.22.2',
  ]);
  expect(compatibleNodeVersions(['v22.22.0'])).toEqual([]);
});

it('creates a name with a placeholder prerelease that can never be a cohort version', () => {
  const manifest = bootstrapManifest('@inventarch/work-system');
  expect(manifest).toMatchObject({
    name: '@inventarch/work-system',
    version: BOOTSTRAP_VERSION,
    license: 'Apache-2.0',
  });
  expect(stableVersion(BOOTSTRAP_VERSION)).toBe(false);
  expect(BOOTSTRAP_TAG).not.toBe('latest');
  expect(manifest).not.toHaveProperty('scripts');
  expect(() => bootstrapManifest('@other/work-system')).toThrow();
});

it('distinguishes authenticated private existence from public 404 and refuses recovery writes', async () => {
  const fixture = registryFixture([{ ...ready, access: { [name]: 'private' }, public: null }]);
  const state = await inspectNpm(fixture.npm, [name], fixture.readPublic);
  expect(state[name]).toMatchObject({ access: 'private', public: 'not-found', trust: { state: 'configured' } });
  expect(npmSetupPlan([name], state)[0]).toMatchObject({ existence: 'existing', ready: false, actions: [] });
  await expect(applyNpm(fixture.npm, [name], fixture)).rejects.toThrow(/exists but is private/);
  expect(fixture.writes).toEqual([]);
});

it('treats authenticated and public 404 as unconfirmed absence requiring an explicit owner decision', async () => {
  const fixture = registryFixture([absent]);
  const state = await inspectNpm(fixture.npm, [name], fixture.readPublic);
  expect(npmSetupPlan([name], state)[0]).toMatchObject({ existence: 'unconfirmed', ready: false, actions: [] });
  expect(npmSetupPlan([name], state, [name])[0]).toMatchObject({ actions: ['bootstrap', 'trust'], blocked: [] });
  expect(() => npmSetupPlan([name], state, ['@inventarch/other'])).toThrow(/Unknown bootstrap package/);
  await expect(applyNpm(fixture.npm, [name], fixture)).rejects.toThrow(/404 does not prove absence/);
  expect(fixture.writes).toEqual([]);
});

it('refuses all-404 inspection even with explicit bootstrap permission when stages cannot be listed', async () => {
  const fixture = registryFixture([{ ...absent, stages: new Error('E404') }]);
  await expect(applyNpm(fixture.npm, [name], { ...fixture, bootstrapNames: [name] })).rejects.toThrow(
    /inspection failed/,
  );
  expect(fixture.writes).toEqual([]);
});

it('requires a reviewed main-only environment, pull-request creation and every declared ruleset', () => {
  const ready = {
    environment: { reviewers: ['crowncodes'], branches: ['main'] },
    workflow: { can_approve_pull_request_reviews: true },
    rulesets: ['main', 'tags'],
  };
  expect(githubSetupPlan(ready, ['main', 'tags'])).toEqual([]);
  expect(githubSetupPlan({ ...ready, environment: null }, ['main'])).toEqual([
    { setting: 'environment', fix: 'create' },
  ]);
  expect(
    githubSetupPlan(
      { ...ready, environment: { reviewers: [], branches: ['main', 'release/*'] }, workflow: {}, rulesets: ['main'] },
      ['main', 'tags'],
    ).map((issue) => issue.setting),
  ).toEqual(['environment-reviewers', 'environment-branches', 'actions-create-pull-requests', 'ruleset:tags']);
  // A write default token is narrowed only when every workflow declares its own permissions.
  const writeToken = { ...ready, workflow: { ...ready.workflow, default_workflow_permissions: 'write' } };
  expect(githubSetupPlan(writeToken, ['main', 'tags'])).toEqual([]);
  expect(githubSetupPlan(writeToken, ['main', 'tags'], { everyWorkflowDeclaresPermissions: true })).toEqual([
    { setting: 'default-token-permissions', fix: 'read' },
  ]);
});

it('narrows the default token only for workflows that each declare top-level permissions', () => {
  expect(declaresPermissions(['name: x', 'on: push', 'permissions:', '  contents: read', 'jobs: {}'].join('\n'))).toBe(
    true,
  );
  // Job-level permissions alone leave any other job on the repository default.
  expect(declaresPermissions(['name: x', 'jobs:', '  a:', '    permissions:', '      contents: read'].join('\n'))).toBe(
    false,
  );
  const workflows = [
    'codeql.yml',
    'inventarch-review.yml',
    'npm-publish.yml',
    'platform-quality.yml',
    'release-pr.yml',
  ];
  for (const name of workflows)
    expect([name, declaresPermissions(readFileSync(resolve(root, '.github/workflows', name), 'utf8'))]).toEqual([
      name,
      true,
    ]);
});

it('runs the pinned npm only on a Node its engine range admits', () => {
  for (const version of ['v22.22.2', 'v22.23.0', 'v24.15.0', 'v26.0.0']) expect(npmEngineSupported(version)).toBe(true);
  for (const version of ['v22.22.0', 'v22.21.9', 'v24.14.1', 'v25.9.0', 'v20.19.0'])
    expect(npmEngineSupported(version)).toBe(false);
});

it('captures only an exact package, bootstrap version and UUID from stage publish', () => {
  expect(bootstrapStageId(JSON.stringify(staged), name)).toBe(stageId);
  for (const change of [
    { stageId: undefined },
    { stageId: 'stg_1' },
    { stageId: 7 },
    { name: '@inventarch/other' },
    { id: `${name}@1.0.0` },
    { version: '1.0.0' },
  ])
    expect(bootstrapStageId(JSON.stringify({ [name]: { ...staged[name], ...change } }), name)).toBeNull();
  expect(bootstrapStageId(JSON.stringify({ '@inventarch/other': staged[name] }), name)).toBeNull();
  expect(bootstrapStageId(JSON.stringify([stage]), name)).toBeNull();
  expect(bootstrapStageId('not json', name)).toBeNull();
});

it('validates listed stage identities without guessing from malformed or cross-package results', () => {
  expect(stageState(JSON.stringify([stage]), name)).toEqual({ state: 'known', items: [stage] });
  expect(stageState('[]', name)).toEqual({ state: 'known', items: [] });
  for (const value of [
    { stages: [stage] },
    null,
    [stage, stage],
    [{ ...stage, id: 'stg_1' }],
    [{ ...stage, id: 7 }],
    [{ ...stage, packageName: '@inventarch/other' }],
    [{ ...stage, status: undefined }],
    [{ ...stage, version: undefined }],
  ])
    expect(stageState(JSON.stringify(value), name)).toEqual({ state: 'unknown', items: [] });
  expect(stageState('not json', name).state).toBe('unknown');
});

it('requires exact authenticated access status instead of interpreting malformed output as absence', () => {
  expect(accessState(JSON.stringify({ [name]: 'public' }), name)).toBe('public');
  expect(accessState(JSON.stringify({ [name]: 'private' }), name)).toBe('private');
  for (const value of [null, {}, [], { '@inventarch/other': 'public' }, { [name]: 'public', other: 'public' }])
    expect(accessState(JSON.stringify(value), name)).toBe('unknown');
  expect(accessState('public', name)).toBe('unknown');
});

it('stages an explicitly confirmed new name, retains its exact identity and verifies readiness', async () => {
  const fixture = registryFixture(
    [absent, { ...ready, stages: [stage], trust: '' }, { ...ready, stages: [stage] }],
    (args) => {
      if (args[0] === 'stage') {
        expect(args).toEqual([
          'stage',
          'publish',
          expect.any(String),
          '--access',
          'public',
          '--tag',
          BOOTSTRAP_TAG,
          '--ignore-scripts',
          '--json',
        ]);
        expect(JSON.parse(readFileSync(resolve(args[2]!, 'package.json'), 'utf8'))).toEqual(bootstrapManifest(name));
        return JSON.stringify(staged);
      }
      expect(args).toEqual(trustArgs(name));
      return '';
    },
  );
  const result = await applyNpm(fixture.npm, [name], { ...fixture, bootstrapNames: [name] });
  expect(result[0]).toMatchObject({ ready: true, stages: { items: [stage] } });
  expect(fixture.writes.map((args) => args.slice(0, 2))).toEqual([
    ['stage', 'publish'],
    ['trust', 'github'],
  ]);
  expect(fixture.readPublic).toHaveBeenCalledTimes(3);
  expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining(stageId));
  expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining('readiness verified'));
});

it('reuses an existing bootstrap stage, writes only missing trust, and repeats without writes', async () => {
  const fixture = registryFixture([
    { ...ready, stages: [stage], trust: '' },
    { ...ready, stages: [stage] },
  ]);
  expect((await applyNpm(fixture.npm, [name], fixture))[0]!.ready).toBe(true);
  expect(fixture.writes).toEqual([trustArgs(name)]);
  fixture.writes.length = 0;
  expect((await applyNpm(fixture.npm, [name], fixture))[0]!.ready).toBe(true);
  expect(fixture.writes).toEqual([]);
  expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining(stageId));
});

it('rechecks an already configured public package without creating a stage or changing trust', async () => {
  const fixture = registryFixture([ready]);
  expect((await applyNpm(fixture.npm, [name], fixture))[0]!.ready).toBe(true);
  expect(fixture.writes).toEqual([]);
  expect(fixture.readPublic).toHaveBeenCalledTimes(2);
});

it.each([
  ['different trust', { ...ready, trust: { ...publisher, repository: 'other/repository' } }],
  ['stage-only trust', { ...ready, trust: { ...publisher, permissions: ['createStagedPackage'] } }],
  ['unparseable trust', { ...ready, trust: 'No trust configurations found' }],
  ['malformed workflow', { ...ready, trust: { ...publisher, file: ['npm-publish.yml'] } }],
  ['unexpected workflow path', { ...ready, trust: { ...publisher, file: 'other-folder/npm-publish.yml' } }],
  ['malformed stages', { ...ready, stages: { stages: [stage] } }],
  ['wrong package stage', { ...ready, stages: [{ ...stage, packageName: '@inventarch/other' }] }],
  ['multiple bootstrap stages', { ...ready, stages: [stage, { ...stage, id: otherStageId }] }],
  ['validating bootstrap', { ...ready, stages: [{ ...stage, status: 'validating' }] }],
  ['unknown bootstrap status', { ...ready, stages: [{ ...stage, status: 'pending' }] }],
  ['nonpending bootstrap', { ...ready, stages: [{ ...stage, status: 'rejected' }] }],
  ['authenticated access 404 conflicts with package evidence', { ...ready, access: new Error('E404') }],
  ['authenticated trust 404 conflicts with package evidence', { ...ready, trust: new Error('E404') }],
])('refuses %s before performing writes', async (_label, observation) => {
  const fixture = registryFixture([observation]);
  await expect(applyNpm(fixture.npm, [name], fixture)).rejects.toThrow();
  expect(fixture.writes).toEqual([]);
  expect(fixture.log).not.toHaveBeenCalledWith(expect.stringContaining('readiness verified'));
});

it.each(['access', 'stages', 'trust', 'public'] as const)(
  'refuses a failed %s read without disclosing error bodies',
  async (field) => {
    const failure = new Error('E401 token=fixture-secret');
    const fixture = registryFixture([{ ...ready, [field]: failure }]);
    const state = await inspectNpm(fixture.npm, [name], fixture.readPublic);
    expect(JSON.stringify(state)).toContain('E401');
    expect(JSON.stringify(state)).not.toContain('fixture-secret');
    await expect(applyNpm(fixture.npm, [name], fixture)).rejects.toThrow(/inspection failed/);
    expect(fixture.writes).toEqual([]);
  },
);

it.each([
  ['wrong package', { ...packument, name: '@inventarch/other' }],
  ['malformed versions', { ...packument, versions: [] }],
  ['unstructured response', 'not a packument'],
])('refuses %s in public metadata', async (_label, metadata) => {
  const fixture = registryFixture([{ ...ready, public: metadata }]);
  await expect(applyNpm(fixture.npm, [name], fixture)).rejects.toThrow(/inspection failed/);
  expect(fixture.writes).toEqual([]);
});

it.each([
  ['public 404', { ...ready, public: null }],
  ['private visibility', { ...ready, access: { [name]: 'private' } }],
  ['trust still missing', { ...ready, trust: '' }],
])('does not report setup success when a successful trust write is followed by %s', async (_label, afterWrite) => {
  const fixture = registryFixture([
    { ...ready, stages: [stage], trust: '' },
    { ...afterWrite, stages: [stage] },
  ]);
  await expect(applyNpm(fixture.npm, [name], fixture)).rejects.toThrow(/npm setup is not ready/);
  expect(fixture.writes).toEqual([trustArgs(name)]);
  expect(fixture.log).not.toHaveBeenCalledWith(expect.stringContaining('readiness verified'));
});

it('does not equate configured trust on a retained stage with public release readiness', async () => {
  const fixture = registryFixture([{ ...ready, stages: [stage], public: null }]);
  const state = await inspectNpm(fixture.npm, [name], fixture.readPublic);
  expect(npmSetupPlan([name], state)[0]).toMatchObject({ existence: 'existing', ready: false, actions: [] });
  await expect(applyNpm(fixture.npm, [name], fixture)).rejects.toThrow(/npm setup is not ready/);
  expect(fixture.writes).toEqual([]);
});

it.each([
  ['disappears', []],
  ['is replaced', [{ ...stage, id: otherStageId }]],
  ['is rejected', [{ ...stage, status: 'rejected' }]],
])('fails when the exact retained stage %s after the trust write', async (_label, afterStages) => {
  const fixture = registryFixture([
    { ...ready, stages: [stage], trust: '' },
    { ...ready, stages: afterStages },
  ]);
  await expect(applyNpm(fixture.npm, [name], fixture)).rejects.toThrow(/npm setup is not ready/);
  expect(console.error).toHaveBeenCalledWith(
    expect.stringContaining(`retained bootstrap stage ${stageId} changed or disappeared`),
  );
  expect(fixture.writes).toEqual([trustArgs(name)]);
});

it('fails the cleanup false-success case when public metadata and the retained stage disappear', async () => {
  const fixture = registryFixture([
    { ...ready, stages: [stage], trust: '' },
    { ...ready, public: null, stages: [] },
  ]);
  await expect(applyNpm(fixture.npm, [name], fixture)).rejects.toThrow(/npm setup is not ready/);
  expect(fixture.writes).toEqual([trustArgs(name)]);
  expect(fixture.log).not.toHaveBeenCalledWith(expect.stringContaining('readiness verified'));
});

it('stops after an uncertain stage write without retrying, configuring trust, approving or rejecting', async () => {
  const fixture = registryFixture([absent], () => {
    throw new Error('ECONNRESET token=fixture-secret');
  });
  await expect(applyNpm(fixture.npm, [name], { ...fixture, bootstrapNames: [name] })).rejects.toThrow(
    /staging outcome is uncertain \(ECONNRESET\); inspect stages before retrying/,
  );
  expect(fixture.writes.map((args) => args.slice(0, 2))).toEqual([['stage', 'publish']]);
  expect(fixture.readPublic).toHaveBeenCalledTimes(1);
});

it('stops after an uncertain trust write and preserves the stage for inspection', async () => {
  const fixture = registryFixture([{ ...ready, stages: [stage], trust: '' }], () => {
    throw new Error('E403 token=fixture-secret');
  });
  await expect(applyNpm(fixture.npm, [name], fixture)).rejects.toThrow(
    /trust write was not confirmed \(E403\); inspect before retrying; stages retained/,
  );
  expect(fixture.writes).toEqual([trustArgs(name)]);
  expect(fixture.readPublic).toHaveBeenCalledTimes(1);
});

it('refuses to guess a bootstrap identity from a successful but malformed staging response', async () => {
  const fixture = registryFixture([absent], () =>
    JSON.stringify({ [name]: { ...staged[name], stageId: 'stg_unknown' } }),
  );
  await expect(applyNpm(fixture.npm, [name], { ...fixture, bootstrapNames: [name] })).rejects.toThrow(
    /no exact bootstrap identity; inspect stages before retrying/,
  );
  expect(fixture.writes.map((args) => args.slice(0, 2))).toEqual([['stage', 'publish']]);
});

it('does not configure trust unless the newly created exact stage is confirmed pending', async () => {
  const fixture = registryFixture([absent, { ...ready, stages: [{ ...stage, id: otherStageId }], trust: '' }], () =>
    JSON.stringify(staged),
  );
  await expect(applyNpm(fixture.npm, [name], { ...fixture, bootstrapNames: [name] })).rejects.toThrow(
    /was not confirmed staged; retained for owner investigation/,
  );
  expect(fixture.writes.map((args) => args.slice(0, 2))).toEqual([['stage', 'publish']]);
});

it('pins the same npm CLI in the setup command and every publishing workflow job', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/npm-publish.yml'), 'utf8');
  const pins = [...workflow.matchAll(/npm@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
  expect(pins.length).toBeGreaterThanOrEqual(3);
  expect(new Set(pins)).toEqual(new Set([NPM_VERSION]));
});

it('publishes over the staged placeholder a bootstrap leaves as the only version of a new name', () => {
  // What the registry holds for a name created by staging: npm's placeholder, which also holds the latest tag.
  const placeholder = {
    'dist-tags': { latest: '0.0.0-stage' },
    versions: { '0.0.0-stage': { dist: { integrity: 'sha512-placeholder' } } },
  };
  const release = {
    version: '1.1.0',
    tag: 'latest',
    baselineVersions: { '@inventarch/work-system': null },
    packages: [
      { name: '@inventarch/work-system', version: '1.1.0', filename: 'w.tgz', bytes: 1, integrity: 'sha512-qualified' },
    ],
  };
  expect(publicationPlan(release, { '@inventarch/work-system': placeholder })[0]!.action).toBe('publish');
  // A rejected/removed bootstrap may leave trust configured while anonymous metadata disappears.
  // The publisher must independently reread and refuse that state before any real publication.
  expect(() => publicationPlan(release, { '@inventarch/work-system': null })).toThrow(
    /public registry metadata is missing/,
  );
});
