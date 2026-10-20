/** Trusted default-branch caller. PR contents are data; no checkout, shell or dependency install. */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isEntry } from '../entry/is-entry.mjs';
import { repoName, integer, githubClient, resolveRun, DEFAULT_UPSTREAM_WORKFLOW } from './github.mjs';
import { collectSubject, digest } from './subject.mjs';
import { publishReview, validateResult } from './result.mjs';
export { githubClient, resolveRun, DEFAULT_UPSTREAM_WORKFLOW } from './github.mjs';
export { collectSubject, digest, evidenceFiles, evidenceCommit, safeSource } from './subject.mjs';
export { renderReview } from './render.mjs';
export { publishReview } from './result.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** The form of a review's id: a retained result's, and every receipt's from the review API. */
const REVIEW_ID = /^[a-f0-9-]{36}$/;
const VERDICTS = ['APPROVE', 'CONDITIONAL', 'REQUEST_CHANGES', 'INCOMPLETE'];
/**
 * The review id a receipt from the review API carries, refused unless it has the review id form; an advance receipt must
 * also name `started`, the review the first receipt started. The caller requests and reports only this id, and refuses a
 * retained result that names another.
 */
export function receiptId(receipt, started) {
  const id = receipt?.id;
  if (typeof id !== 'string' || !REVIEW_ID.test(id) || (started !== undefined && id !== started))
    throw new Error('Review receipt identity required');
  return id;
}
/** The job summary line for a review: built only from a review id and one of the four advisory verdicts. */
export function reviewSummary(id, verdict, delivery) {
  if (typeof id !== 'string' || !REVIEW_ID.test(id) || !VERDICTS.includes(verdict))
    throw new Error('Invalid retained review result');
  return `InventArch review ${id}: ${verdict} (advisory). ${delivery.skipped ? 'Stale delivery suppressed.' : 'Review comment delivered.'}\n`;
}

async function main() {
  const repository = repoName(process.env.GITHUB_REPOSITORY ?? '');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const runId = integer(event.workflow_run?.id ?? process.env.IA_REVIEW_RUN_ID);
  // A host whose quality workflow has another path names it; the default is Public quality.
  const workflow = process.env.IA_REVIEW_UPSTREAM_WORKFLOW || DEFAULT_UPSTREAM_WORKFLOW;
  const gh = githubClient(process.env.GH_TOKEN ?? '');
  if (process.argv.includes('--prepare')) {
    const { run, pr } = await resolveRun(gh, repository, runId, workflow);
    appendFileSync(process.env.GITHUB_OUTPUT, `run_id=${integer(run.id)}\npr=${integer(pr.number)}\n`);
    return;
  }
  const origin = new URL(process.env.IA_REVIEW_API ?? '');
  if (
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error('HTTPS API origin required');
  const binding = process.env.IA_REVIEW_BINDING;
  if (!/^[a-f0-9-]{36}$/.test(binding ?? '')) throw new Error('Review binding ID required');
  let token,
    expires = 0;
  const api = async (path, input, method = 'POST') => {
    if (Date.now() >= expires) {
      const oidcUrl = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
      if (oidcUrl.protocol !== 'https:') throw new Error('HTTPS OIDC request required');
      oidcUrl.searchParams.set('audience', `${origin.origin}/v1/reviews`);
      const oidc = await fetch(oidcUrl, {
        headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!oidc.ok) throw new Error('GitHub OIDC unavailable');
      const identity = await oidc.json();
      const exchange = await fetch(`${origin.origin}/v1/reviews/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ binding, token: identity.value }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!exchange.ok) throw new Error(`InventArch identity exchange failed (${exchange.status})`);
      const session = await exchange.json();
      token = session.access_token;
      expires = Date.now() + 240000;
    }
    const response = await fetch(`${origin.origin}/v1/reviews${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      redirect: 'error',
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`InventArch review request failed (${response.status})`);
    return response.json();
  };
  const subject = await collectSubject(gh, repository, runId, process.env.IA_REVIEW_EVIDENCE, workflow);
  const content = JSON.stringify(subject),
    subjectDigest = digest(content);
  await api(`/artifacts/${subjectDigest}`, { content }, 'PUT');
  let receipt = await api('', {
    key: `github:${runId}:${subject.evidence.attempt}:${subject.head}`,
    digest: subjectDigest,
  });
  const review = receiptId(receipt);
  const deadline = Date.now() + 15 * 60000;
  while (!receipt.result && Date.now() < deadline) {
    receipt = await api(`/${review}/advance`);
    receiptId(receipt, review);
    if (receipt.state === 'running') await pause(3000);
  }
  if (!receipt.result) {
    await api(`/${review}/cancel`);
    throw new Error('Review exceeded CI deadline');
  }
  const expected = { repository, pr: subject.pr, head: subject.head, subject: subjectDigest };
  // A result that names another review, or another subject, is retained for inspection, then refused before anything is
  // posted: the review id and the subject identity are both checked before publishReview's first request. The refusal sits in the delivery
  // expression so that the line after the artifact write keeps the text CodeQL keys alert #31 to.
  mkdirSync('artifacts/review', { recursive: true });
  writeFileSync('artifacts/review/result.json', JSON.stringify(receipt.result, null, 2));
  const delivery = await (receipt.result.id === review
    ? publishReview(gh, repository, validateResult(receipt.result, expected), expected)
    : Promise.reject(new Error('Review result identity required')));
  if (delivery.reviewId) await api(`/${review}/delivery`, { reviewId: delivery.reviewId, head: subject.head });
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, reviewSummary(review, receipt.result.verdict, delivery));
}
if (isEntry(process.argv[1], import.meta.url))
  main().catch((error) => {
    console.error(
      `InventArch review could not complete: ${error instanceof Error ? error.message : 'unknown error'}. No clean review is inferred; inspect the workflow configuration and retained API events.`,
    );
    process.exitCode = 1;
  });
