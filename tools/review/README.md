# InventArch CI caller

[![InventArch advisory review](https://github.com/inventarch/ia/actions/workflows/inventarch-review.yml/badge.svg)](https://github.com/inventarch/ia/actions/workflows/inventarch-review.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-green)](../../LICENSE)

> `runner.mjs` is the caller behind the [InventArch advisory review](../../.github/workflows/inventarch-review.yml) workflow. It runs on Node 22 with no installed dependencies. After a Public quality run on a pull request, it collects the pull request's source as Git blobs, sends a bounded subject to the configured InventArch review API and posts the retained result as an advisory `COMMENT` review. It never checks out or runs pull request code.

## Enable it

The workflow and the caller always load from the default branch. Set three repository variables:

| Variable | Value |
| --- | --- |
| `IA_REVIEW_ENABLED` | `true` admits the job. It does not enable the API or a model. |
| `IA_REVIEW_API` | The review API's HTTPS origin, with no path, query or credentials |
| `IA_REVIEW_BINDING` | The ID of the account-owned repository binding the API issued for this repository |

The job holds no inference key or long-lived service token. It exchanges the job's GitHub OIDC identity with the API for a review-only API token. Model credentials, model selection and inference stay in the API.

The workflow runs when Public quality completes for a pull request, or by manual dispatch with a completed Public quality pull request run ID. Its permissions are `contents: read`, `actions: read`, `issues: read`, `pull-requests: write` and `id-token: write`.

A repository whose quality workflow has another path sets `IA_REVIEW_UPSTREAM_WORKFLOW` to that `.github/workflows/<name>.yml` path on both caller steps, and names its own evidence artifact in the download step. Task evidence is read as `<task>/evidence.json`. A copy of this caller in another repository is that repository's own default-branch code; keep it current from this file.

## What it does

1. **Validates the subject.** The upstream run must be a completed `pull_request` run of the upstream workflow in this repository, for exactly one open pull request whose base and head match. Stale or ambiguous associations refuse before anything is disclosed.
2. **Collects source.** It reads the base and head versions of changed files, then neighboring files, as Git blobs whose identity it verifies. It also keeps the full head path inventory, linked issues named in the pull request body, the upstream jobs and steps, task evidence and the observed branch protection and required checks.
3. **Binds execution evidence.** If CI tested a synthetic merge rather than the head, that commit must have exactly the current base and head as parents. Reports that disagree on the tested commit refuse.
4. **Runs the review.** It uploads the subject by its SHA-256, starts or reuses a review keyed by run, attempt and head, and advances it for up to 15 minutes, then cancels it.
5. **Delivers.** It saves the result as the `inventarch-review` artifact, re-reads the pull request and posts a `COMMENT` review bound to the reviewed commit. A closed pull request or a moved head suppresses delivery, and a bot review with the same commit and marker is not posted twice.

| Limit | Value |
| --- | --- |
| Changed paths | 400; more refuses |
| Disclosed source | 1.7 MB in total, 150 KB per file, 1,000 file versions |
| Task evidence | 0.8 MB in total, 600 KB per file |
| Serialized subject | 3 MiB |
| Review comment | 60,000 bytes |

The contents of credential-like paths, dependency, build and lock files, symlinks and unsupported file types are never disclosed. Omitted files are listed in the subject, and the full path inventory stays available to the reviewer.

## What it does not do

- It never checks out, installs or executes pull request code.
- Its review is advisory. It neither approves nor blocks merging.
- `IA_REVIEW_ENABLED` admits the job only. It does not show that the API, the binding or a model is available.
- Missing source, incomplete execution evidence or an unreadable required-check policy is reported as a limitation, never as a clean approval. Required checks outside the observed branch protection and rulesets stay unknown, and artifact reports are caller evidence, not signed attestations.
- The result artifact is the retained report. It does not show that GitHub delivery succeeded.

## Test

```sh
pnpm exec vitest run --config vitest.tools.config.mts tools/review/runner.test.ts
```

The tests cover collection, refusal, rendering and delivery against simulated GitHub responses and publish nothing. They do not establish hosted API activation, live model behavior or production delivery.

## Learn more

- [Caller contract](SPEC.md)
- [Workflow](../../.github/workflows/inventarch-review.yml) and the [Public quality workflow](../../.github/workflows/platform-quality.yml)
- [Root README](../../README.md)
