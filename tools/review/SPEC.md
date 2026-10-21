# review tooling contract

## Purpose

Collect an advisory review subject, call the review service, validate its identity and render/deliver results.

## Modules

- [github.mjs](github.mjs).
- [main.test.ts](main.test.ts) — offline entrypoint, retained evidence and delivery integration coverage.
- [render.mjs](render.mjs).
- [result.mjs](result.mjs).
- [runner.d.mts](runner.d.mts) — interface declaration; implementation checking is tracked separately.
- [runner.mjs](runner.mjs).
- [runner.test.ts](runner.test.ts) — behavior and refusal coverage.
- [subject.mjs](subject.mjs).
- [fixtures/main.mjs](fixtures/main.mjs) — offline entrypoint fixture for main.test.ts.

## Commands

No public pnpm entry; callers import the modules or use the manual contract below.

Commands report success as exit 0 and evaluated failure as exit 1. Corrected strict parsers use exit 2 for usage errors. Existing command-specific defaults, flags and refusal behavior are described below; a check never implies a write.

## Inputs

Pinned repository/PR/head, source blobs, gate evidence, independent GitHub protection/ruleset reads and service responses.

## Outputs

Preparation writes a bounded packet; service invocation writes its bound result; delivery writes only its explicitly selected GitHub advisory outputs.

## Prerequisites

Bare Node with built-ins and relative modules; credentials and network are needed only by invoked external operations.

## Validation

Task ownership: `tools:test-review`. `tools/testing/tasks.json` declares platform, timeout, prerequisite, output and input-profile contracts; `nx.json` defines their actual file/runtime inputs. Live discovery and mutation tests validate coverage and caching.

## Invariants

All four result identity fields match the original packet before delivery. The returned result is retained first, unverified, so a mismatch stays inspectable. Invalid UTF-8 is explicitly omitted; malformed gate evidence refuses. Partial policy reads never imply complete checks.

## Limits

Advisory output cannot approve or merge a PR. Truncation, missing evidence and denied policy reads remain visible limitations.

## Detailed behavior

This owner contains the dependency-free Node 22 caller, its TypeScript declarations and behavioral tests. The [workflow](../../.github/workflows/inventarch-review.yml) loads the caller from the default branch after a completed Public quality pull-request run, or through manual dispatch with that run's ID. Repository configuration explicitly enables it; [README.md](README.md) describes the API binding and activation variables.

`runner.mjs` owns the executable and API lifecycle. `github.mjs` owns bounded repository reads, pagination and upstream-run identity; `subject.mjs` owns immutable source and evidence collection; `result.mjs` validates result identity and delivers it; `render.mjs` owns presentation. Their transitive imports use local modules and Node built-ins, so workflow execution needs no dependency installation. Entry detection follows physical paths, including Windows junctions.

`runner.mjs` treats PR source and downloaded execution evidence as data. It never checks out or executes PR code. It validates the upstream workflow, repository, open PR and current base/head identities before disclosure. An execution commit distinct from the reviewed head must have the exact current base/head merge parents. Ambiguous associations, stale revisions and conflicting execution commits refuse.

Source collection reads pinned Git trees and blobs, verifies blob identity and retains base/head versions, the head path inventory and omissions. Credential-like paths, unsupported files and symlinks are excluded. Bounds include 400 changed paths, 1.7 MB of source, 0.8 MB of task evidence and a 3 MiB serialized subject. Downloaded task evidence is classified by directory entry type, and each `evidence.json` listed as a file is opened without following a link, then judged and read through that descriptor: its bounds count the bytes opened, a link put in its place is omitted like any other link, a hard-linked report is omitted as another name for a file outside the listed evidence, and a report that changes while it is read refuses. Missing evidence and omitted source remain explicit review limitations; they do not establish clean approval.

Invalid UTF-8 source is explicitly omitted after blob identity verification. Malformed gate JSON refuses with its evidence path and never discloses its body in the diagnostic. Branch protection and rulesets are read independently: available contexts are retained when the other read fails, while complete policy and passing checks remain unknown.

The caller exchanges GitHub OIDC identity for a review-only API token using the configured HTTPS origin and account-owned repository binding. It uploads a SHA-256-addressed subject, starts or reuses a review keyed by run, attempt and head, and advances bounded inspection passes. The first receipt must carry a review id in the form a retained result's id has, and every advance must return that same review; the caller sends its advance, cancel and delivery requests for that id alone. An advance for another review cancels the started review before it is refused, and a cancel that fails leaves that refusal the error. A result that does not name the started review, whether it names another, has no id in that form or is no object, is refused once it is retained, before delivery reads the PR or posts anything. A review without a result at the caller deadline is cancelled. The job summary names only that id and one of the four advisory verdicts. Model credentials and inference execution belong to the API, not this owner.

Delivery renders the retained advisory verdict, findings, evidence gaps and provenance as a GitHub review with event `COMMENT` bound to the reviewed commit. A final PR read suppresses closed or stale-head delivery; a bot-authored review with the same commit and stable review marker suppresses duplicate delivery. Review text escapes supplied Markdown/HTML and mentions and refuses bodies over 60,000 bytes. It neither grants approval nor blocks merging. The retained result artifact is distinct from a successful delivery receipt.

The caller retains the returned result as `artifacts/review/result.json` before checking it, so a refused result remains available for inspection; retention is not acceptance. Before GitHub delivery, the result id must equal the started review and the repository, PR number, head commit and SHA-256 subject identity must exactly match the submitted packet. A mismatch, from the first receipt or an advance, refuses before any delivery API call. The original subject remains the authority for delivery even when another PR has a matching current head.

`runner.test.ts` checks the 2,000-entry inventory boundary with a scoped directory-listing stand-in whose entries retain real file classification; its missing, linked, non-directory and malformed evidence fixtures remain real. It qualifies collection, refusal, rendering and delivery with simulated GitHub responses, and tests the helpers `main()` calls directly, among them `receiptId` and `reviewSummary`. `main.test.ts` runs `main()` as the workflow does, `node tools/review/runner.mjs` in a fresh working directory, with [fixtures/main.mjs](fixtures/main.mjs) preloaded to answer every GitHub, OIDC and review API request from a script, record each request and run timers on a virtual clock, so the caller's deadline passes at once. It covers a completed first receipt, advances to a result, cancellation at the deadline, stale and duplicate delivery and an invalid retained verdict. A malformed first receipt id and an advance for another review refuse before any request for another id, any review comment and any summary; the advance first cancels the started review, and still refuses with its identity error when that cancel fails. Every request, the comment marker, the delivery and the summary carry only the started id: a result that names another id, from the first receipt or an advance, or that has no id, a malformed one or no object, is refused after it is retained and before anything is posted. Four `runner.test.ts` cases need a FIFO or a file mode that denies reads, and are declared Windows skips; a fifth, the report symbolic link, is declared skipped only where Windows denies file-symlink creation. Run as root, the three unreadable-report cases return early without asserting, which no gate skip condition can express. The `tools:test-review` task owns these tests. Local tests establish caller behavior, not hosted API activation, live-model calibration or production delivery. Hosted deployment owns those broader gates.

The directory-swap regression covers a junction substituted after listing, before open, and a swap attempted during the descriptor recheck. Windows refuses the latter rename with EPERM while the file is open; the test pins that refusal and verifies the descriptor closes. No evidence is admitted in either case.
