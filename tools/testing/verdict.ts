import { isEntry } from '../entry/is-entry.mjs';

/**
 * The verdict a pull request's title or description edit reports instead of re-running every lane: the result of the
 * last full run of this workflow on the same head commit, from the same head branch, that tested what the pull request
 * merges (`testsMerge`). The verdict is copied, never invented. A copy passes only when that run finished and succeeded.
 * While it is still running the copy waits for it, for a bounded time, and longer once that run's gate rows exist
 * (`gateStarted`); no full run, one still running at the bound and any other conclusion all fail.
 */

/**
 * The Plan job step that copies a verdict. The classifier never reads it (a copy is known by `COPY_MARK`); the tests
 * pin it so the workflow and this module name the step alike.
 */
export const VERDICT_STEP = "Copy the verdict of this commit's last full run";
/**
 * The Plan job's first step in a copy run, before anything that can fail. A run that ran it is a copy whatever it did
 * next, so a later copy never mistakes a copy that failed early (an audit or install error) for a failed full run.
 */
export const COPY_MARK = 'Mark this run as a copied verdict';
/** The Plan job step an experiment run takes (a dispatch with a Windows I/O arm or task parallelism): never a verdict. */
export const EXPERIMENT_MARK = 'Mark this run as an experiment';
/** How long a copy waits for a full run that is still going, and how often it looks again. */
export const WAIT_MS = 15 * 60_000;
/**
 * How much longer a copy waits once the full run's gate rows exist: the gate job's own 20-minute timeout. Failing then would
 * create this copy's failed rows after the full run's, and GitHub reports the newest row of a name. Both waits fit in the
 * Plan job's timeout on reuse. The gate job's timeout counts from the job's start, not from its row's creation, so a row
 * that waits longer than this for a runner (a macOS slot) can still finish after the copy gives up.
 */
export const GATE_WAIT_MS = 20 * 60_000;
/**
 * The name every row of the gate job starts with in a full run. A check-name prefix, unlike `GATE_JOB` in
 * `workflow.ts`, which is the gate's job key (`qualify`).
 */
export const GATE_ROW_PREFIX = 'Emitted platform (';
export const POLL_MS = 30_000;

export interface WorkflowRun {
  readonly id: number;
  readonly created_at: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly event: string;
  readonly head_branch: string | null;
  /** Absent or null when the run's head repository was deleted. */
  readonly head_repository?: { readonly full_name: string } | null;
}
/** The pull request's head: the repository and branch its runs come from. */
export interface PullRequestHead {
  readonly repository: string;
  readonly branch: string;
}
export interface RunJob {
  readonly name: string;
  readonly status?: string;
  readonly steps?: readonly { readonly name: string; readonly status: string; readonly conclusion: string | null }[];
}
export interface Verdict {
  readonly passed: boolean;
  readonly reason: string;
  /** The newest full run has not finished: its result may still come. */
  readonly pending?: boolean;
  /**
   * That unfinished run has created its gate rows (queued or later). Once a row runs, it is at most the gate job's
   * timeout from its result; a queued row waits for a runner first.
   */
  readonly gateStarted?: boolean;
}

/** Job statuses whose check row exists already. A job still waiting for the jobs it needs has none yet. */
const CREATED = new Set(['queued', 'in_progress', 'completed']);
/**
 * Conclusions of a run that may have stopped, or never started (`action_required`: waiting for a maintainer's approval),
 * before it decided anything. Such a run decides only when it created its gate rows: a cancelled run's gate rows still
 * run (`always()`) and fail, and a copy that skipped the run would write newer passed rows over them.
 */
const UNDECIDED = new Set(['cancelled', 'skipped', 'action_required']);
/** The branch whose dispatched runs are the release pull request's check (`.github/workflows/release-pr.yml`). */
export const RELEASE_BRANCH = 'release/next';

/**
 * Whether a run tested what this pull request merges. It must come from the pull request's own head repository and
 * branch: another pull request at the same head commit (a fork's, waiting for approval) merges into its own base and
 * is not this one's check. A `pull_request` run tests the merge commit. A dispatched run tests only the head, which can
 * pass after the merge failed, so only the release pull request's dispatched run counts: `release/next` is cut from the
 * tip of main, so its head is that merge result. The release pull request's bot-pushed head also starts a
 * `pull_request` run, which waits for approval (`action_required`) and runs nothing unless a maintainer approves it.
 * A push runs only on main, never on a pull request's head.
 */
export const testsMerge = (run: WorkflowRun, head: PullRequestHead): boolean =>
  run.head_branch === head.branch &&
  run.head_repository?.full_name === head.repository &&
  (run.event === 'pull_request' || (run.event === 'workflow_dispatch' && run.head_branch === RELEASE_BRANCH));

/** Whether a run's Plan job ran the named step, or is running it. A step not reached yet counts as not run. */
export function ranStep(jobs: readonly RunJob[], name: string): boolean {
  const step = jobs.find((job) => job.name === 'Plan')?.steps?.find((candidate) => candidate.name === name);
  return step?.status === 'in_progress' || (step?.status === 'completed' && step.conclusion !== 'skipped');
}
/** Whether a run copied a verdict: it ran the copy mark, its first step. */
const isCopy = (jobs: readonly RunJob[]): boolean => ranStep(jobs, COPY_MARK);

/**
 * The verdict of the newest full run among `runs` that tested what `head`'s pull request merges, other than `current`.
 * Jobs are read newest first, until one decides.
 */
export async function copiedVerdict(
  runs: readonly WorkflowRun[],
  current: number,
  head: PullRequestHead,
  jobsOf: (run: number) => Promise<readonly RunJob[]>,
): Promise<Verdict> {
  const candidates = runs
    .filter((run) => run.id !== current && testsMerge(run, head))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  for (const run of candidates) {
    const jobs = await jobsOf(run.id);
    // A copy decided nothing of its own, and an experiment's environment is not the contract's.
    if (isCopy(jobs) || ranStep(jobs, EXPERIMENT_MARK)) continue;
    const gateRows = jobs.some((job) => job.name.startsWith(GATE_ROW_PREFIX) && CREATED.has(job.status ?? ''));
    if (UNDECIDED.has(run.conclusion ?? '') && !gateRows) continue;
    if (run.status !== 'completed')
      return { passed: false, pending: true, gateStarted: gateRows, reason: `${run.html_url} is still ${run.status}` };
    return run.conclusion === 'success'
      ? { passed: true, reason: `${run.html_url} passed` }
      : { passed: false, reason: `${run.html_url} finished as ${run.conclusion ?? 'no conclusion'}` };
  }
  return { passed: false, reason: 'no full run of this workflow has finished on this head commit' };
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Every edit adds a run on the head commit; past this many, the lookup fails rather than read without bound. */
const MAX_RUN_PAGES = 10;

async function github<T>(path: string): Promise<T> {
  const token = process.env['GH_TOKEN'];
  if (!token) throw new Error('GH_TOKEN is not set');
  const response = await fetch(`${process.env['GITHUB_API_URL'] ?? 'https://api.github.com'}${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
    // Fails the step, and with it the copy, instead of holding the Plan job to its timeout.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${path}: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export interface VerdictArgs {
  readonly repository: string;
  readonly workflow: string;
  readonly runId: number;
  readonly headSha: string;
  readonly head: PullRequestHead;
}
const USAGE =
  'Usage: pnpm tests:verdict --repo <owner/name> --workflow <file> --run-id <id> --head-sha <sha> --head-repo <owner/name> --head-branch <branch>';
/** The command's arguments: every flag once, with a value, and nothing else; otherwise `null`. */
export function verdictArgs(args: readonly string[]): VerdictArgs | null {
  const names = ['--repo', '--workflow', '--run-id', '--head-sha', '--head-repo', '--head-branch'];
  const values = names.map((name) => {
    const index = args.indexOf(name);
    return index < 0 || args.lastIndexOf(name) !== index ? undefined : args[index + 1];
  });
  if (args.length !== names.length * 2 || values.some((value) => !value || names.includes(value))) return null;
  const [repository, workflow, runId, headSha, headRepository, headBranch] = values as string[];
  if (!/^[0-9]+$/.test(runId!)) return null;
  return {
    repository: repository!,
    workflow: workflow!,
    runId: Number(runId),
    headSha: headSha!,
    head: { repository: headRepository!, branch: headBranch! },
  };
}

export interface Clock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}
/**
 * Looks up the verdict until it is no longer pending, every `POLL_MS`: up to `WAIT_MS` from the first look, and
 * `GATE_WAIT_MS` more while the full run's gate rows exist, whose failed copies would otherwise outlive them.
 */
export async function awaitVerdict(
  lookup: () => Promise<Verdict>,
  clock: Clock,
  waiting: (verdict: Verdict) => void = () => {},
): Promise<Verdict> {
  const start = clock.now();
  for (;;) {
    const verdict = await lookup();
    const deadline = start + WAIT_MS + (verdict.gateStarted ? GATE_WAIT_MS : 0);
    if (!verdict.pending || clock.now() + POLL_MS > deadline) return verdict;
    waiting(verdict);
    await clock.sleep(POLL_MS);
  }
}

if (isEntry(process.argv[1], import.meta.url)) {
  const parsed = verdictArgs(process.argv.slice(2));
  if (parsed === null) {
    console.error(USAGE);
    process.exitCode = 2;
  } else
    try {
      const { repository, workflow, runId, headSha, head } = parsed;
      const lookup = async (): Promise<Verdict> => {
        // Every event's runs; testsMerge keeps this pull request's runs and the release PR's dispatched runs.
        const runs: WorkflowRun[] = [];
        for (let page = 1; ; page += 1) {
          if (page > MAX_RUN_PAGES) throw new Error(`more than ${MAX_RUN_PAGES * 100} runs on ${headSha}`);
          const { workflow_runs: found } = await github<{
            workflow_runs: WorkflowRun[];
          }>(`/repos/${repository}/actions/workflows/${workflow}/runs?head_sha=${headSha}&per_page=100&page=${page}`);
          runs.push(...found);
          if (found.length < 100) break;
        }
        return copiedVerdict(runs, runId, head, async (run) => {
          const { jobs } = await github<{ jobs: RunJob[] }>(
            `/repos/${repository}/actions/runs/${run}/jobs?filter=latest&per_page=100`,
          );
          return jobs;
        });
      };
      const verdict = await awaitVerdict(
        lookup,
        {
          now: Date.now,
          sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        },
        (pending) => console.error(`Head commit ${headSha}: ${pending.reason}; looking again in ${POLL_MS / 1000} s.`),
      );
      console.error(`Head commit ${headSha}: ${verdict.reason}.`);
      if (verdict.passed) console.log('verdict=success');
      else {
        console.error(
          'A title or description edit reports the last full run and runs nothing; push or re-run to verify.',
        );
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
}
