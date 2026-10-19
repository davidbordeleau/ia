import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveRun, pages, integer, pinnedSha, DEFAULT_UPSTREAM_WORKFLOW } from './github.mjs';

export const digest = (text) => createHash('sha256').update(text).digest('hex');
export function safeSource(path) {
  return (
    typeof path === 'string' &&
    path.length <= 500 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/[\x00-\x1f\x7f]/.test(path) &&
    !path.split('/').some((p) => !p || p === '..' || p === '.') &&
    !/(^|\/)(node_modules|vendor|dist|\.git|\.env[^/]*|\.npmrc|\.netrc|credentials[^/]*|secrets?[^/]*)(\/|$)/i.test(
      path,
    ) &&
    !/\.(pem|key|p12|pfx|keystore|lock|map|min\.js)$/i.test(path) &&
    !/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(path) &&
    /\.(ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|md|ia|sql|py|go|rs|java|cs|sh|ps1|toml|css|html|vue|svelte)$/.test(path)
  );
}
export function evidenceFiles(directory, omissions) {
  if (!directory || !existsSync(directory)) {
    omissions.push('Quality evidence artifacts unavailable');
    return [];
  }
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
    throw new Error('Evidence must be a real directory');
  const reports = [];
  let bytes = 0,
    entries = 0;
  const visit = (relative = '', depth = 0) => {
    // Each entry is classified by its directory entry type; only an evidence.json listed as a file is opened.
    const listed = readdirSync(resolve(directory, relative), { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of listed) {
      if (++entries > 2000) throw new Error('Evidence inventory exceeds disclosure bound');
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        omissions.push(`Evidence symlink omitted: ${name}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (depth >= 3) omissions.push(`Evidence nesting omitted: ${name}`);
        else visit(name, depth + 1);
        continue;
      }
      // Public quality emits <task>/evidence.json alongside raw logs/Vitest output.
      if (!entry.isFile() || entry.name !== 'evidence.json') continue;
      const report = evidenceReport(resolve(directory, name), name, bytes, omissions);
      if (!report) continue;
      JSON.parse(report.content);
      reports.push({ name, digest: digest(report.content), content: report.content });
      bytes += report.size;
    }
  };
  visit();
  if (!reports.length) omissions.push('No task-level execution evidence disclosed');
  return reports;
}
/**
 * One listed evidence.json, opened before it is judged so that its bounds and its text are of one file (CodeQL
 * js/file-system-race): its text and the size it was opened at, or undefined when it is omitted or is no regular file.
 * `disclosed` is the size of the reports already admitted.
 */
function evidenceReport(path, name, disclosed, omissions) {
  let fd;
  try {
    // NOFOLLOW refuses a link put in place after the listing; NONBLOCK keeps a FIFO from blocking the open.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    // A link fails the open (ELOOP), and so does a directory if the platform refuses to open one: omitted or skipped
    // as the listing would.
    const named = lstatSync(path);
    if (named.isSymbolicLink()) {
      omissions.push(`Evidence symlink omitted: ${name}`);
      return undefined;
    }
    if (!named.isFile()) return undefined;
    // A report it cannot read is still omitted past either bound before any read, as it always was; no read follows.
    if (named.size > 600000 || disclosed + named.size > 800000) {
      omissions.push(`Evidence omitted by disclosure bound: ${name}`);
      return undefined;
    }
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) return undefined;
    const size = Number(opened.size);
    if (size > 600000 || disclosed + size > 800000) {
      omissions.push(`Evidence omitted by disclosure bound: ${name}`);
      return undefined;
    }
    // Read at most one byte past the opened size, so a report that grows while it is read is not admitted.
    const buffer = Buffer.alloc(size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    // Windows follows a link on open, so the name must still be the file that was read, unchanged.
    const named = lstatSync(path, { bigint: true });
    if (named.isSymbolicLink()) {
      omissions.push(`Evidence symlink omitted: ${name}`);
      return undefined;
    }
    // The size and the modification time of the opened file catch a rewrite while it was read, at any size.
    const after = fstatSync(fd, { bigint: true });
    if (
      length !== size ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    )
      throw new Error(`Evidence changed while it was read: ${name}`);
    return { content: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)), size };
  } finally {
    closeSync(fd);
  }
}
export async function evidenceCommit(gh, repository, reports, head, base, fallback) {
  const commits = [...new Set(reports.map((r) => JSON.parse(r.content).current?.commit).filter(Boolean))];
  if (!commits.length) return fallback;
  if (commits.length !== 1) throw new Error('Execution reports disagree on the tested commit');
  const commit = pinnedSha(commits[0]);
  if (commit !== head) {
    // pull_request checkout normally tests a synthetic merge, not the PR head.
    // Bind its exact parents instead of confusing those distinct commit identities.
    const tested = await gh(`/repos/${repository}/git/commits/${commit}`);
    if (
      tested.sha !== commit ||
      tested.parents?.length !== 2 ||
      tested.parents[0].sha !== base ||
      tested.parents[1].sha !== head
    )
      throw new Error('Tested merge does not bind the current PR base and head');
  }
  return commit;
}
export async function collectSubject(gh, repository, runId, evidenceDirectory, workflow = DEFAULT_UPSTREAM_WORKFLOW) {
  const { run, pr } = await resolveRun(gh, repository, runId, workflow);
  const comparison = await gh(`/repos/${repository}/compare/${pr.base.sha}...${pr.head.sha}`);
  const base = pinnedSha(comparison.merge_base_commit?.sha),
    head = pr.head.sha;
  const changed = (await pages(gh, `/repos/${repository}/pulls/${pr.number}/files`, null, 5)).map((f) => ({
    path: f.filename,
    previousPath: f.previous_filename ?? null,
    status: f.status,
  }));
  if (changed.length > 400 || changed.length !== pr.changed_files) throw new Error('Incomplete changed-path inventory');
  const trees = {};
  for (const [side, sha] of [
    ['base', base],
    ['head', head],
  ]) {
    const tree = await gh(`/repos/${repository}/git/trees/${sha}?recursive=1`);
    if (tree.truncated) throw new Error('Git tree inventory was truncated');
    trees[side] = tree.tree.filter((f) => f.type === 'blob' && f.mode !== '120000');
  }
  const inventory = trees.head.map((f) => f.path);
  if (inventory.length > 30000) throw new Error('Repository inventory exceeds review bound');
  const omissions = [],
    files = [],
    selected = [],
    keys = new Set();
  const select = (side, path) => {
    const key = `${side}:${path}`;
    if (!keys.has(key)) {
      keys.add(key);
      selected.push({ side, path });
    }
  };
  for (const change of changed) {
    if (change.status !== 'removed') select('head', change.path);
    if (change.status !== 'added') select('base', change.previousPath ?? change.path);
  }
  // Prioritize neighboring contracts, tests, producers and consumers; the full inventory remains visible.
  const folders = new Set(changed.map((f) => dirname(f.path)));
  const neighbors = trees.head
    .filter((f) => safeSource(f.path))
    .sort(
      (a, b) =>
        Number(folders.has(dirname(b.path))) - Number(folders.has(dirname(a.path))) || a.path.localeCompare(b.path),
    );
  for (const file of neighbors) select('head', file.path);
  let bytes = 0;
  const cache = new Map();
  for (const { side, path } of selected) {
    const entry = trees[side].find((f) => f.path === path);
    if (!safeSource(path) || !entry || entry.size > 150000 || bytes + entry.size > 1700000 || files.length >= 1000) {
      omissions.push(`${side}:${path}`);
      continue;
    }
    let content = cache.get(entry.sha);
    if (content === undefined) {
      const blob = await gh(`/repos/${repository}/git/blobs/${pinnedSha(entry.sha)}`);
      if (blob.encoding !== 'base64') throw new Error('Unsupported Git blob encoding');
      const buffer = Buffer.from(blob.content, 'base64');
      if (buffer.length !== entry.size || buffer.includes(0)) {
        omissions.push(`${side}:${path}`);
        continue;
      }
      // Git blob identity protects against a mismatched response independently of our SHA-256 capture.
      if (createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex') !== entry.sha)
        throw new Error('Git blob identity mismatch');
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        omissions.push(`${side}:${path}: invalid UTF-8 source omitted`);
        continue;
      }
      cache.set(entry.sha, content);
    }
    bytes += Buffer.byteLength(content);
    files.push({ side, path, content, digest: digest(content) });
  }
  const obligations = [];
  const issueIds = [
    ...new Set(
      [...(pr.body ?? '').matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|part of)\s+#(\d+)/gi)].map((m) => m[1]),
    ),
  ];
  if (issueIds.length > 20) throw new Error('Too many linked obligations');
  for (const number of issueIds) {
    const issue = await gh(`/repos/${repository}/issues/${integer(number)}`);
    obligations.push({ source: `${repository}#${number}`, text: `${issue.title}\n${issue.body ?? ''}` });
  }
  const jobs = await pages(
    gh,
    `/repos/${repository}/actions/runs/${run.id}/attempts/${integer(run.run_attempt)}/jobs`,
    'jobs',
  );
  const evidenceOmissions = [];
  const reports = evidenceFiles(evidenceDirectory, evidenceOmissions);
  const testedCommit = await evidenceCommit(gh, repository, reports, head, pr.base.sha, run.head_sha);
  omissions.push(...evidenceOmissions);
  let protection = 'unknown',
    requiredChecks = [],
    checks = 'unknown';
  let note = 'Branch protection/ruleset requirements were not established; review is advisory and incomplete.';
  // These independent sources can each contribute requirements even when the other is unavailable.
  const [policyRead, rulesRead] = await Promise.allSettled([
    gh(`/repos/${repository}/branches/${encodeURIComponent(pr.base.ref)}/protection`),
    pages(gh, `/repos/${repository}/rules/branches/${encodeURIComponent(pr.base.ref)}`, null),
  ]);
  const policy = policyRead.status === 'fulfilled' ? policyRead.value : {};
  const rules = rulesRead.status === 'fulfilled' ? rulesRead.value : [];
  requiredChecks = [
    ...new Set([
      ...(policy.required_status_checks?.contexts ?? []),
      ...(policy.required_status_checks?.checks ?? []).map((c) => c.context),
      ...rules
        .filter((r) => r.type === 'required_status_checks')
        .flatMap((r) => r.parameters?.required_status_checks?.map((c) => c.context) ?? []),
    ]),
  ];
  if (policyRead.status === 'fulfilled' && rulesRead.status === 'fulfilled') {
    protection = 'observed';
    // Only observed check jobs from this exact upstream attempt can establish these contexts.
    checks =
      requiredChecks.length &&
      requiredChecks.every((name) => jobs.some((job) => job.name === name && job.conclusion === 'success')) &&
      run.conclusion === 'success' &&
      reports.length &&
      !evidenceOmissions.length
        ? 'passed'
        : 'unknown';
    note =
      'Required contexts checked against this exact quality run; external required checks remain unknown. Artifact reports are caller evidence, not signed attestations.';
  } else {
    note = `Policy reads: branch protection ${policyRead.status}, rulesets ${rulesRead.status}. Observed contexts may be incomplete; review is advisory.`;
  }
  const subject = {
    version: 1,
    repository,
    pr: pr.number,
    base,
    head,
    title: pr.title,
    description: pr.body ?? '',
    obligations,
    changed,
    files,
    inventory,
    omissions,
    environment: { protection, requiredChecks, checks, note },
    evidence: {
      runId: String(run.id),
      attempt: run.run_attempt,
      commit: testedCommit,
      conclusion: run.conclusion ?? 'unknown',
      jobs: jobs.map((job) => ({
        name: job.name,
        conclusion: job.conclusion ?? 'unknown',
        steps: (job.steps ?? []).map((step) => ({ name: step.name, conclusion: step.conclusion ?? 'unknown' })),
      })),
      reports,
    },
  };
  const current = await gh(`/repos/${repository}/pulls/${pr.number}`);
  if (current.head.sha !== head || current.base.sha !== pr.base.sha || current.state !== 'open')
    throw new Error('PR changed during collection');
  if (Buffer.byteLength(JSON.stringify(subject)) > 3 * 1024 * 1024)
    throw new Error('Complete review packet exceeds disclosure bound');
  return subject;
}
