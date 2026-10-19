import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  COPY_MARK,
  EXPERIMENT_MARK,
  GATE_ROW_PREFIX,
  GATE_WAIT_MS,
  POLL_MS,
  RELEASE_BRANCH,
  VERDICT_STEP,
  WAIT_MS,
  awaitVerdict,
  copiedVerdict,
  testsMerge,
  verdictArgs,
  type PullRequestHead,
  type RunJob,
  type Verdict,
  type WorkflowRun,
} from './verdict.js';
import { workflowJobs } from './workflow.js';

const CURRENT = 100;
const HEAD: PullRequestHead = { repository: 'inventarch/ia', branch: 'feature' };
const run = (
  id: number,
  created: string,
  status: string,
  conclusion: string | null,
  event = 'pull_request',
  head_branch: string | null = HEAD.branch,
  repository: string | null = HEAD.repository,
): WorkflowRun => ({
  id,
  created_at: created,
  status,
  conclusion,
  html_url: `https://github.com/inventarch/ia/actions/runs/${id}`,
  event,
  head_branch,
  head_repository: repository === null ? null : { full_name: repository },
});
/** A full run's Plan job skips the copy mark, its first step; a copy run's Plan job runs it. */
const plan = (mark: { status: string; conclusion: string | null }): readonly RunJob[] => [
  {
    name: 'Plan',
    steps: [
      { name: COPY_MARK, ...mark },
      { name: 'Assign tasks to shards', status: 'completed', conclusion: 'success' },
    ],
  },
  { name: 'Build (ubuntu-latest)', steps: [] },
];
const full = plan({ status: 'completed', conclusion: 'skipped' }),
  copy = plan({ status: 'completed', conclusion: 'success' });
/** A full run whose gate rows exist, in the given job status. */
const withGate = (status: string): readonly RunJob[] => [...full, { name: `${GATE_ROW_PREFIX}ubuntu-latest)`, status }];
const verdict = (
  runs: readonly WorkflowRun[],
  jobs: Readonly<Record<number, readonly RunJob[]>>,
  head: PullRequestHead = HEAD,
) =>
  copiedVerdict(runs, CURRENT, head, async (id) => {
    const found = jobs[id];
    if (!found) throw new Error(`no jobs fixture for run ${id}`);
    return found;
  });

it('fails when no other run exists for the head commit', async () => {
  const result = await verdict([run(CURRENT, '2026-10-16T10:00:00Z', 'in_progress', null)], {});
  expect(result.passed).toBe(false);
  expect(result.reason).toContain('no full run');
});

it('copies a pass from the last full run on the head commit', async () => {
  const result = await verdict([run(1, '2026-10-16T09:00:00Z', 'completed', 'success')], { 1: full });
  expect(result).toEqual({ passed: true, reason: expect.stringContaining('runs/1 passed') });
});

it('fails when the last full run failed, even if an earlier one passed', async () => {
  const result = await verdict(
    [run(1, '2026-10-16T08:00:00Z', 'completed', 'success'), run(2, '2026-10-16T09:00:00Z', 'completed', 'failure')],
    { 1: full, 2: full },
  );
  expect(result).toEqual({ passed: false, reason: expect.stringContaining('runs/2 finished as failure') });
});

it('treats a timed-out or otherwise unfinished full run as no pass', async () => {
  for (const conclusion of ['timed_out', 'startup_failure', 'action_required', 'neutral', null]) {
    const result = await verdict([run(1, '2026-10-16T09:00:00Z', 'completed', conclusion)], { 1: full });
    expect(result.passed).toBe(false);
  }
});

it('fails while the last full run is still running, and names it', async () => {
  const result = await verdict(
    [run(1, '2026-10-16T08:00:00Z', 'completed', 'success'), run(2, '2026-10-16T09:00:00Z', 'in_progress', null)],
    { 1: full, 2: full },
  );
  // Pending, so the command waits for it rather than outlive its gate rows with failed ones.
  expect(result).toEqual({
    passed: false,
    pending: true,
    gateStarted: false,
    reason: expect.stringContaining('runs/2 is still in_progress'),
  });
});

it("tells when a running full run's gate rows exist, so the copy waits past them", async () => {
  // Once they exist, failing would create this copy's failed rows after them, and GitHub reports the newest row of a name.
  const pendingRuns = [run(2, '2026-10-16T09:00:00Z', 'in_progress', null)];
  for (const status of ['queued', 'in_progress', 'completed'])
    expect((await verdict(pendingRuns, { 2: withGate(status) })).gateStarted).toBe(true);
  // A gate job still waiting for the jobs it needs has no row yet.
  expect((await verdict(pendingRuns, { 2: withGate('waiting') })).gateStarted).toBe(false);
});

it('knows a copy that failed before its copy step for a copy, never for a failed full run', async () => {
  // Run 2 marked itself, then its audit failed, so its copy step was skipped: still a copy, and run 1 decides.
  const early: readonly RunJob[] = [
    {
      name: 'Plan',
      steps: [
        { name: COPY_MARK, status: 'completed', conclusion: 'success' },
        { name: 'Check dependency advisories', status: 'completed', conclusion: 'failure' },
        { name: VERDICT_STEP, status: 'completed', conclusion: 'skipped' },
      ],
    },
  ];
  const result = await verdict(
    [run(1, '2026-10-16T08:00:00Z', 'completed', 'success'), run(2, '2026-10-16T09:00:00Z', 'completed', 'failure')],
    { 1: full, 2: early },
  );
  expect(result).toEqual({ passed: true, reason: expect.stringContaining('runs/1 passed') });
});

it('skips cancelled runs that stopped before their gate, and earlier copies, so a copy never copies a copy', async () => {
  // Newest first: a full run cancelled before its gate, a copy that failed while run 1 was still going, then run 1.
  const runs = [
    run(1, '2026-10-16T08:00:00Z', 'completed', 'success'),
    run(2, '2026-10-16T08:30:00Z', 'completed', 'failure'),
    run(3, '2026-10-16T09:00:00Z', 'completed', 'cancelled'),
    run(CURRENT, '2026-10-16T10:00:00Z', 'in_progress', null),
  ];
  const result = await verdict(runs, { 1: full, 2: copy, 3: full });
  expect(result).toEqual({ passed: true, reason: expect.stringContaining('runs/1 passed') });
  // A copy whose step is still running is a copy too.
  expect(
    (
      await verdict([runs[0]!, run(2, '2026-10-16T08:30:00Z', 'in_progress', null)], {
        1: full,
        2: plan({ status: 'in_progress', conclusion: null }),
      })
    ).passed,
  ).toBe(true);
});

it('counts a run whose copy step has not been decided yet as a full run, so it cannot pass', async () => {
  // Its Plan job has not reached the step, so nothing says it is a copy; a full run that is still running cannot pass.
  const pending = plan({ status: 'queued', conclusion: null });
  const result = await verdict(
    [run(1, '2026-10-16T08:00:00Z', 'completed', 'success'), run(2, '2026-10-16T09:00:00Z', 'in_progress', null)],
    { 1: full, 2: pending },
  );
  expect(result.passed).toBe(false);
  // A run with no Plan job at all is not a copy either.
  expect((await verdict([run(1, '2026-10-16T08:00:00Z', 'completed', 'failure')], { 1: [] })).passed).toBe(false);
});

it("never copies a dispatched run on a pull request's branch: it tested the head, not the merge", async () => {
  // Run 1, the pull request run, failed on the merge commit; run 2, a later manual baseline run on the head, passed.
  const runs = [
    run(1, '2026-10-16T08:00:00Z', 'completed', 'failure'),
    run(2, '2026-10-16T09:00:00Z', 'completed', 'success', 'workflow_dispatch', 'feature'),
  ];
  const result = await verdict(runs, { 1: full, 2: full });
  expect(result).toEqual({ passed: false, reason: expect.stringContaining('runs/1 finished as failure') });
  // With only the dispatched run, there is no full run to copy.
  expect((await verdict([runs[1]!], { 2: full })).reason).toContain('no full run');
});

it("copies the release pull request's dispatched run, its only full run", async () => {
  const dispatched = run(1, '2026-10-16T08:00:00Z', 'completed', 'success', 'workflow_dispatch', RELEASE_BRANCH);
  expect(await verdict([dispatched], { 1: full }, { repository: HEAD.repository, branch: RELEASE_BRANCH })).toEqual({
    passed: true,
    reason: expect.stringContaining('runs/1 passed'),
  });
  // Seen from another pull request at the same head commit, it is not that one's check.
  expect((await verdict([dispatched], { 1: full })).reason).toContain('no full run');
});

it("never copies an experiment's result, whether it passed or failed", async () => {
  const experiment = (conclusion: string): readonly RunJob[] => [
    {
      name: 'Plan',
      steps: [
        { name: COPY_MARK, status: 'completed', conclusion: 'skipped' },
        { name: EXPERIMENT_MARK, status: 'completed', conclusion },
      ],
    },
  ];
  // Run 2, the newest, is an experiment: run 1 decides either way.
  for (const outcome of ['success', 'failure'] as const) {
    const result = await verdict(
      [run(1, '2026-10-16T08:00:00Z', 'completed', 'success'), run(2, '2026-10-16T09:00:00Z', 'completed', outcome)],
      { 1: full, 2: experiment('success') },
    );
    expect(result, outcome).toEqual({ passed: true, reason: expect.stringContaining('runs/1 passed') });
  }
  // With only an experiment on the head, there is no full run to copy.
  expect(
    (await verdict([run(2, '2026-10-16T09:00:00Z', 'completed', 'success')], { 2: experiment('success') })).reason,
  ).toContain('no full run');
});

it("names the workflow's copy step as this module does, and the copy mark as the classifier reads it, the mark first", () => {
  const text = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/platform-quality.yml'), 'utf8');
  const plan = workflowJobs(text).get('plan')!;
  expect(plan).toContain(`- name: ${VERDICT_STEP}\n`);
  // The mark is the Plan job's first step, on the same condition as the reuse plan and the edit concurrency group.
  expect(plan).toMatch(
    new RegExp(
      `^steps:\\n- name: ${COPY_MARK}\\nif: github\\.event\\.action == 'edited' && !github\\.event\\.changes\\.base\\n`,
      'm',
    ),
  );
});

it("names the gate rows as the workflow does, and gives a copy's Plan job time for both waits", () => {
  const text = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/platform-quality.yml'), 'utf8');
  const jobs = workflowJobs(text);
  expect(jobs.get('qualify')).toContain(`|| '${GATE_ROW_PREFIX.slice(0, -2)}' }} (\${{ matrix.os }})`);
  const timeout =
    /^timeout-minutes: \$\{\{ github\.event\.action == 'edited' && !github\.event\.changes\.base && (\d+) \|\| 20 \}\}$/m.exec(
      jobs.get('plan')!,
    );
  expect(timeout).not.toBeNull();
  // Ten minutes for the Plan job's other steps.
  expect(Number(timeout![1]) * 60_000).toBeGreaterThanOrEqual(WAIT_MS + GATE_WAIT_MS + 10 * 60_000);
});

it('fails on a newer cancelled full run that reached its gate, rather than copy an older pass over its failed rows', async () => {
  // Run 2 was cancelled after its gate rows existed; they still ran (always()) and failed. Copying run 1 would cover them.
  const runs = [
    run(1, '2026-10-16T08:00:00Z', 'completed', 'success'),
    run(2, '2026-10-16T09:00:00Z', 'completed', 'cancelled'),
  ];
  for (const status of ['queued', 'in_progress', 'completed'])
    expect(await verdict(runs, { 1: full, 2: withGate(status) }), status).toEqual({
      passed: false,
      reason: expect.stringContaining('runs/2 finished as cancelled'),
    });
  // A skipped run that reached its gate decides the same way.
  const skipped = [runs[0]!, run(2, '2026-10-16T09:00:00Z', 'completed', 'skipped')];
  expect((await verdict(skipped, { 1: full, 2: withGate('completed') })).passed).toBe(false);
  expect((await verdict(skipped, { 1: full, 2: full })).passed).toBe(true);
});

it("skips a run that waits for approval and ran nothing, like the release pull request's bot-pushed run", async () => {
  // The release PR's head gets a dispatched run and a pull_request run that waits for approval, often the newer one.
  const runs = [
    run(1, '2026-10-16T08:00:00Z', 'completed', 'success', 'workflow_dispatch', RELEASE_BRANCH),
    run(2, '2026-10-16T08:00:02Z', 'completed', 'action_required', 'pull_request', RELEASE_BRANCH),
  ];
  const release = { repository: HEAD.repository, branch: RELEASE_BRANCH };
  expect(await verdict(runs, { 1: full, 2: [] }, release)).toEqual({
    passed: true,
    reason: expect.stringContaining('runs/1 passed'),
  });
});

it("copies only runs from the pull request's own head repository and branch", async () => {
  // A newer run at the same head commit from another pull request (a fork's, or another branch) is not this one's check.
  const mine = run(1, '2026-10-16T08:00:00Z', 'completed', 'success');
  for (const other of [
    run(2, '2026-10-16T09:00:00Z', 'completed', 'failure', 'pull_request', HEAD.branch, 'someone/ia'),
    run(2, '2026-10-16T09:00:00Z', 'completed', 'failure', 'pull_request', 'other-branch'),
    run(2, '2026-10-16T09:00:00Z', 'completed', 'failure', 'pull_request', HEAD.branch, null),
  ])
    expect(await verdict([mine, other], { 1: full, 2: full })).toEqual({
      passed: true,
      reason: expect.stringContaining('runs/1 passed'),
    });
  // Seen from the other pull request, run 1 is not its check.
  expect((await verdict([mine], { 1: full }, { repository: 'someone/ia', branch: HEAD.branch })).reason).toContain(
    'no full run',
  );
});

it('counts only pull_request runs and the release dispatch as testing the merge, never a push or a schedule', () => {
  for (const event of ['push', 'schedule', 'pull_request_target', 'workflow_run'])
    expect(testsMerge(run(1, '2026-10-16T08:00:00Z', 'completed', 'success', event), HEAD), event).toBe(false);
  expect(testsMerge(run(1, '2026-10-16T08:00:00Z', 'completed', 'success'), HEAD)).toBe(true);
});

it('breaks a tie in creation time by the higher run id, the newer run', async () => {
  const runs = [
    run(2, '2026-10-16T09:00:00Z', 'completed', 'failure'),
    run(1, '2026-10-16T09:00:00Z', 'completed', 'success'),
  ];
  expect((await verdict(runs, { 1: full, 2: full })).reason).toContain('runs/2 finished as failure');
  expect((await verdict([...runs].reverse(), { 1: full, 2: full })).reason).toContain('runs/2 finished as failure');
});

/** A clock that only moves when the loop sleeps, with the lookups it answered. */
const fakeClock = () => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => void (now += ms),
    at: () => now,
  };
};
const pending = (gateStarted: boolean): Verdict => ({
  passed: false,
  pending: true,
  gateStarted,
  reason: 'running',
});

it('waits up to WAIT_MS for a full run still going, looking again every POLL_MS', async () => {
  const clock = fakeClock();
  let looks = 0;
  const result = await awaitVerdict(async () => (looks++, pending(false)), clock);
  expect(result.pending).toBe(true);
  expect(clock.at()).toBeLessThanOrEqual(WAIT_MS);
  expect(clock.at()).toBeGreaterThan(WAIT_MS - 2 * POLL_MS);
  expect(looks).toBe(clock.at() / POLL_MS + 1);
});

it("waits GATE_WAIT_MS more once the full run's gate rows exist", async () => {
  const clock = fakeClock();
  await awaitVerdict(async () => pending(true), clock);
  expect(clock.at()).toBeGreaterThan(WAIT_MS + GATE_WAIT_MS - 2 * POLL_MS);
  expect(clock.at()).toBeLessThanOrEqual(WAIT_MS + GATE_WAIT_MS);
});

it('stops at the first look that is no longer pending, and returns it', async () => {
  const clock = fakeClock();
  const answers: Verdict[] = [pending(false), pending(true), { passed: true, reason: 'run/1 passed' }];
  const seen: Verdict[] = [];
  const result = await awaitVerdict(
    async () => answers.shift()!,
    clock,
    (verdict) => seen.push(verdict),
  );
  expect(result).toEqual({ passed: true, reason: 'run/1 passed' });
  expect(seen).toHaveLength(2);
  expect(clock.at()).toBe(2 * POLL_MS);
});

it('reads every flag once, with a value, and refuses anything else', () => {
  const args = [
    '--repo',
    'inventarch/ia',
    '--workflow',
    'platform-quality.yml',
    '--run-id',
    '42',
    '--head-sha',
    'abc',
    '--head-repo',
    'someone/ia',
    '--head-branch',
    'feature/x',
  ];
  expect(verdictArgs(args)).toEqual({
    repository: 'inventarch/ia',
    workflow: 'platform-quality.yml',
    runId: 42,
    headSha: 'abc',
    head: { repository: 'someone/ia', branch: 'feature/x' },
  });
  expect(verdictArgs(args.slice(0, -2))).toBeNull();
  expect(verdictArgs([...args, '--extra'])).toBeNull();
  expect(verdictArgs(args.map((arg) => (arg === '42' ? '4x' : arg)))).toBeNull();
  expect(verdictArgs(args.map((arg) => (arg === 'feature/x' ? '' : arg)))).toBeNull();
  // A flag given twice, in place of another, is refused rather than read as the first.
  expect(verdictArgs(args.map((arg) => (arg === '--head-repo' ? '--repo' : arg)))).toBeNull();
});

it("passes the copy step this run's id and the pull request's head, its branch only through env", () => {
  const text = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/platform-quality.yml'), 'utf8');
  const plan = workflowJobs(text).get('plan')!;
  expect(plan).toContain(
    'run: pnpm --silent tests:verdict --repo ${{ github.repository }} --workflow platform-quality.yml --run-id ${{ github.run_id }} --head-sha ${{ github.event.pull_request.head.sha }} --head-repo "$HEAD_REPO" --head-branch "$HEAD_BRANCH" >> "$GITHUB_OUTPUT"',
  );
  expect(plan).toContain('HEAD_REPO: ${{ github.event.pull_request.head.repo.full_name }}\n');
  expect(plan).toContain('HEAD_BRANCH: ${{ github.event.pull_request.head.ref }}\n');
});
