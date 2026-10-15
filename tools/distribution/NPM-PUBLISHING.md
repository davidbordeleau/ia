# Publishing IA packages to npm

The public scope is `@inventarch`. Every public npm package moves together at the single version selected in [releases/current.json](../../releases/current.json). The private workspace root is never published. The VS Code extension follows the cohort version and ships as a GitHub release asset, not an npm package. Native systems, language syntax and protocol formats keep independent versions, joined by the compatibility manifest.

## The release flow

1. **Pull request.** A change to a public package adds a pending release note with `pnpm release:note`. `pnpm release:check` runs in CI and refuses a changed package without one. Tooling, workflow and documentation changes outside package directories need no note.
2. **Release pull request.** On every push to main, the [Release pull request](../../.github/workflows/release-pr.yml) workflow runs `pnpm release:version`. It folds the pending notes into the next version and opens or updates a pull request from `release/next`. Review that changeset and changelog like any other change. If the full description exceeds its conservative 60,000-byte budget, the PR links to those complete files on `release/next` instead of copying the notes inline; the changeset digest and merge/publication warning stay visible.
3. **Publication.** Merging the release pull request changes `releases/current.json` and the changeset, which starts [Publish npm packages](../../.github/workflows/npm-publish.yml) for that merge commit. It waits for Public quality on that exact commit. Then it prepares and preflights the archives and pauses for approval on the `npm` environment. After approval it publishes with OIDC, verifies the registry cohort, tags `v<version>` and creates the GitHub release with the VSIX.

| Command | When | What it does |
| --- | --- | --- |
| `pnpm release:note` | In a pull request that changes a public package | Drafts `releases/pending/<id>.json` from the branch diff |
| `pnpm release:check` | CI on every pull request and push | Checks package manifest form and published exports, cohort versions, published changeset integrity and a note for every changed package |
| `pnpm release:version` | Dry run at any time; `--write` by the release workflow or a maintainer | Computes the next version and, with `--write`, applies it |
| `pnpm release:check --strict` | Before preparing archives | Requires exact changed-file coverage and no pending notes |
| `pnpm release:collect` | After editing release prose by hand | Re-derives coverage and regenerates `CHANGELOG.md` |
| `pnpm npm:inputs` | Release preparation only; `release:version` runs it | Reseals `.ia/public-package-inputs.json` |
| `pnpm npm:prepare`, `npm:consumer`, `npm:plan`, `npm:preflight` | Release preparation, in the workflow or locally | Builds, qualifies, inspects and registry-checks the exact archives |
| `pnpm npm:setup` | Once, after adding a package, and when registry state is unclear | Inspects public readiness, authenticated package state, stages, trust and GitHub settings; `--apply` makes only supported setup writes |
| `pnpm npm:trust-commands` | Reference | Prints the trusted-publisher commands without running them |

## Release notes

A note is one JSON file under `releases/pending/`. The file name is the change id:

```json
{
  "format": "ia.npm-change-note.v1",
  "bump": "minor",
  "title": "Add selected-context workflows to the CLI",
  "summary": "What changes for package consumers, and any limits that still apply.",
  "packages": ["@inventarch/cli"],
  "paths": ["apps/cli/"]
}
```

`pnpm release:note` fills `packages` and `paths` from the files the branch changes. It infers `bump` only when every branch commit has a conventional type (`fix:` is a patch, `feat:` is minor, and `!` or `BREAKING CHANGE:` is major). Otherwise pass `--bump patch|minor|major`. Use `--bump none` for a package change with no consumer impact, such as tests or an internal refactor. Such a note satisfies the check and is folded into the next release, but never starts one. Pass `--title` and `--summary` to replace the commit-derived defaults. Review the file and commit it. Record user-facing behavior and limits, not filenames or test counts. Automated checks establish completeness and freshness only; a reviewer judges whether the prose is accurate.

## How the version is chosen

A version is published when its immutable `v<version>` tag exists. The tag is created only after registry verification. `pnpm release:version --write` behaves differently in each state.

- **Published.** It makes the tagged commit the new baseline. It applies the largest pending bump to the published version and consumes the notes into `releases/changesets/<version>.json`. With only `none` notes pending, it waits.

  First it checks that npm has the published cohort. That cohort is every package the changeset at the tag lists, by npm name, including packages moved, renamed or removed since. A missing one refuses as an unfinished publication, naming the packages npm lacks. npm isn't asked about a package that changeset doesn't list; it publishes with the next version.

  Each package's `previous` version follows its npm name, wherever its directory is now:
  - A package the tag lists gets the published version.
  - A package that returns after a release dropped it gets the newest version an earlier changeset lists it at.
  - A package no changeset lists is new: its `previous` is `null`, and it publishes first, with the other new names.

  A tag whose commit has no changeset, or one that lists no packages, falls back to every current package and to the manifest at the same path, which must name the same package.
- **Prepared but untagged.** The release workflow waits (`--published-only`), because that release may already be publishing from its own commit. A maintainer who abandons or extends an unpublished release can run `pnpm release:version --write` locally. That amends it with the pending notes, renaming it if they raise the bump. Pass `--refresh` to re-collect an unpublished release whose coverage went stale without new notes.

Each write updates every cohort `package.json`, the VS Code extension manifest and its dependency notices, each system's `npmVersion` in `system-package-policy.json`, and `releases/current.json`. It then writes the changeset with exact file coverage, regenerates `CHANGELOG.md`, deletes the consumed notes and reseals the public inputs. Packages that no note names receive a generated version-only entry. Changed files outside every package are accounted for by an internal maintenance entry, which the changelog omits. A changed package that no note names refuses before anything is written. The write requires a clean checkout and stages every file it changes. If a later step fails, it restores the files it touched. The release workflow uses only Node built-ins and Git, so it installs no dependencies while it holds a write token.

Historical changesets are immutable. A published changeset that differs from its tagged bytes fails `pnpm release:check`.

## What a pull request has to seal

Nothing. `.ia/public-package-inputs.json` seals every tracked file for release preparation, and only release preparation requires it to be current: `pnpm release:check --strict`, `pnpm npm:prepare`, and publication refuse a stale seal. Ordinary qualification reads the selection the checkout would seal instead. That covers `pnpm release:check`, `pnpm public:qualify` and the release tests, and it still refuses a renamed, added or removed public package. Likewise, only release preparation requires exact changed-file coverage. A pull request adds a release note when it changes a package, and `pnpm release:version` reseals and re-collects on the release branch.

## Qualify exact archives

Development and ordinary platform checks use Node `>=22.22.0 <23`. Release preparation uses Node **22.22.2**, npm **12.2.0** and the pinned pnpm in `package.json`. `workspace:*` dependencies become exact package versions during isolated packing. To reproduce the workflow's preparation locally, use the version in `releases/current.json`:

```sh
pnpm install --frozen-lockfile
pnpm release:check --strict
pnpm npm:prepare
pnpm npm:consumer
pnpm npm:plan --version <version>
pnpm npm:preflight --version <version>
```

`artifacts/npm` must be absent or empty before preparation. The installed consumers import JavaScript exports and separately verify native data archives, bindings and complete dependency closure. npm 12 uses its default install security settings. On Windows, invoke `npm:consumer --npm-cli /path/to/npm/bin/npm-cli.js`.

The version 2 release receipt retains exact source, changeset and compatibility digests, archive integrity, the complete packed dependency graph and explicit cycle groups. Packing adds native dependencies, so source manifests alone cannot define publication order. The reviewed complete cycle groups are recorded in `cycles` in `releases/current.json`; qualification compares them with the actual packed dependency graph. Native dependency edges added during packing participate in that graph alongside emitted-code dependencies. Every new package name publishes first; the existing packages follow, each group before its consumers. The receipt's `packages` list is that order. Every internal dependency must be present at the exact cohort version, and version alignment does not eliminate cycles. A new packed cycle refuses until `cycles` in `releases/current.json` records it.

`npm:plan` validates local artifacts. `npm:preflight` reads live registry metadata without publishing. It refuses missing names, immutable byte conflicts, newer versions or inconsistent retry tags. Package existence does not prove permission to publish.

## One-time account and repository setup

`pnpm npm:setup` is a read-only inspection. It reads public package metadata from the same registry URL as the publisher, authenticated exact-package metadata, access status, pending stages and trusted publishers for every package, plus the GitHub settings below. It exits nonzero when npm readiness is incomplete or an npm inspection fails; review the separately reported GitHub settings as well. npm's access command labels a false visibility result `private`; setup reports this as `non-public`, which does not establish that the package exists. Existence requires positive exact-name metadata, an exact-package stage or a valid trust record returned for that package. Public release readiness is a separate fact. Neither an anonymous nor an authenticated 404, even with an empty stage list, proves that a name is available or owned by the caller. Without positive evidence, existence stays `unconfirmed`.

The authenticated metadata helper uses the existing configuration of pinned npm 12.2.0. It fetches the raw packument from the canonical registry with a fresh, bounded read, rather than using `npm view`, whose version/tag selection can hide an existing package. It checks the requested name and metadata shape and returns only validated identity or a sanitized error code. It does not initiate authentication, persist configuration or expose credentials or metadata bodies. An unreadable or malformed response blocks readiness; a 404 conflicting with positive package evidence requires investigation. Mocked regression tests do not prove live authenticated access.

`pnpm npm:setup --apply` inspects before making supported account writes, then inspects again before reporting readiness. Repeated runs reuse known state. Complete inspection requires a maintainer:

- logged in with `npm login` on an account with 2FA and write access;
- logged in with `gh auth login` as a repository admin;
- with Node 22.22.2 or later available, which the pinned npm 12.2.0 needs. The shell's own Node can be older: the command runs npm with the newest compatible Node that fnm has installed (`fnm install 22.22.2`), or with `--node <path>`. It installs the pinned npm into a temporary cache and uses the existing npm login without printing credentials.

Reading a trusted publisher can require 2FA even for a list. Ordinary inspection captures structured output, so npm cannot prompt through it: [npm 12.2.0's authentication helper](https://github.com/npm/cli/blob/v12.2.0/lib/utils/auth.js) requires both standard input and standard output to be terminals. An `EOTP` from trust inspection leaves trust unknown; being logged in does not satisfy a request-specific 2FA challenge.

An owner who wants to complete that challenge can explicitly opt in from a terminal at the repository root:

```sh
pnpm npm:setup --interactive-auth --skip-github
```

Run this command without pipes or output redirection. It uses the same resolved Node and pinned npm **12.2.0** as setup; it does not use the shell's `npm`, which may be older and report `Unknown command: trust`. Do not substitute a bare `npm trust list` command for this recovery path. The command remains an inspection: it does not log in, persist new credentials, change trust or visibility, or approve or reject stages.

For an `EOTP` trust read, the opt-in helper lets npm handle its browser challenge on the terminal and masks classic one-time-password input. A separate result channel returns the completed trust read for the same strict structured validation as ordinary inspection; terminal prompt text is never treated as a trust result. Setup never records the OTP, persists it, or passes it in command arguments or the result channel. A challenge is scoped to its request, so npm may prompt for each package and again during a fresh inspection; one completed challenge is not a promise that later reads are authenticated.

Without the opt-in, setup reports the failed read and the recovery command. With the opt-in but either input or output redirected, it refuses instead of prompting. Failed, cancelled or timed-out authentication stops further interactive attempts in that run and leaves unread state blocked; the helper has a five-minute deadline. Resolve the cause before starting another inspection. The option does not enable interactive retries of setup writes or authenticated metadata reads, or relax any `--apply` checks. A failed, malformed or ambiguous access, stage, trust or metadata response remains a blocker, not permission to write. If recovery needs a new login, credential or permission change, stop for separate owner authorization.

Mocked regression checks cover the authentication control flow and structured result handling. They do not establish that a live npm browser/OTP challenge succeeds, or that interactive terminal transport works on every supported platform. Successful authentication also does not repair a private package or an anonymous public 404.

**npm.** Every package must trust GitHub repository **inventarch/ia**, workflow **npm-publish.yml** and environment **npm** for direct publishing. npm accepts a trusted publisher only for a name that already exists. Setup readiness requires authenticated metadata consistent with the package evidence, public access, readable public package metadata, a successful unambiguous stage inspection and the intended direct-publish trust configuration. Non-public visibility, public 404s and unknown states remain not ready, even after a successful write. Setup does not change visibility. `npm:preflight` and the publisher retain their missing-name safety check and still read public metadata before publication; a setup pass does not replace that check or establish actual OIDC authorization.

`--apply` creates missing trust only after successful inspection permits it. Existing matching trust is retained. A configuration for another repository, workflow or environment, or one without direct-publish permission, blocks setup; the owner must review it separately. Setup never overwrites or revokes it. `pnpm npm:trust-commands` prints the intended trust commands without running them.

Creating a new name also requires the owner to explicitly confirm each full package name with the repeatable `--bootstrap-name` option, for example `pnpm npm:setup --apply --bootstrap-name @inventarch/new-package`. This confirmation is necessary even when authenticated inspection returns 404. It permits a bootstrap only when public metadata, authenticated metadata and authenticated access all return 404, stage listing succeeds with no stages, and trust is either explicitly absent or returns 404. Positive existence evidence, ambiguous data, authentication failure or permission failure refuses a new bootstrap. Non-public visibility with unconfirmed existence also remains blocked, even with the option; the detection correction does not broaden bootstrap authorization. The option cannot repair an existing blocked package.

For a confirmed new name, setup stages `0.0.0-bootstrap.0` under the `bootstrap` tag with public access using [staged publishing](https://docs.npmjs.com/staged-publishing/), then inspects the resulting state before configuring missing trust. It retains and reports the exact package, version and stage ID. An existing pending bootstrap stage for that exact package and version is reused, including after an interrupted run; multiple candidates or uncertain identity/status block setup. The confirmed status must be `staged`; a stage still `validating` is retained, and setup stops for a later read. Setup never approves or rejects a stage and never automatically cleans one up. Retaining the stage avoids destructive setup cleanup; it is not evidence that stage retention fixes inconsistent npm registry visibility.

Keep the stage identity with the release record until the normal workflow publishes and verifies a real cohort version, including its archive integrity, `latest` tag and provenance. Only after that verification may an owner separately authorize manual cleanup of the exact retained bootstrap stage, after checking its current identity and status. Never approve a bootstrap payload or publish dummy contents as a real version. Never overwrite a published version, repurpose an existing tag, or use a 404 as proof of name ownership. Final verification requires an npm provenance attestation on every published package, which only the workflow's OIDC publication adds, and none of the 1.0.0 versions carries one.

The six names new in 1.1.0 are `compliance-system`, `governance-system`, `hook-authoring-system`, `learning-system`, `work-system` and `workspace-system`, all in the `@inventarch` scope.

**GitHub.** `--apply` restricts the `npm` environment to main and makes the code owner, or `--reviewer <login>`, its required reviewer. Approving that environment is the publication checkpoint; the prepare job's summary shows the changeset digest and archive integrity being approved. It also allows Actions to create pull requests, so the release workflow can open `release/next`. It makes the default workflow token read-only, since every workflow declares its own permissions, and it creates any ruleset in `.github/rulesets/` that is missing. The tag ruleset must keep allowing tag creation, because the release job creates `v<version>`.

Pull requests and pushes made with the workflow token start no other workflows. The release workflow therefore dispatches Public quality on `release/next`, and the publish workflow dispatches the release workflow after tagging.

## Publication and recovery

When setup or the publisher reports a name as not publicly ready, begin with `pnpm npm:setup` without `--apply`. For trust-read `EOTP`, an owner can use `pnpm npm:setup --interactive-auth --skip-github` in a terminal as described above. This selects the pinned npm 12.2.0 even when the shell's npm lacks the `trust` command. Any additional read-only access, stage or trust diagnostics must also use that pinned CLI and the existing authorized login. Retain the reported package/version/stage identity and sanitized status results. Stop if further diagnosis requires a new login, credential or permission change; do not change account settings as part of inspection.

For `@inventarch/runner`, the non-public visibility result and anonymous public 404 do not settle current existence. Fresh randomly chosen scoped and unscoped control names also returned HTTP 200 with `public:false`; their metadata lookups were not completed, so those observations do not independently prove the controls absent. Inspect exact authenticated metadata and current stages/trust before asserting existence or choosing recovery. If positive existence evidence confirms a non-public package, visibility repair needs separate owner authorization; inconsistent or inaccessible state may require npm support. Unconfirmed existence is not permission to create a package. Successful historical staging, trust creation or rejection does not prove current public readiness, and the evidence does not establish that rejecting the bootstrap caused the registry inconsistency. Reinspect after any separately authorized recovery and proceed through the normal release workflow only when readiness checks pass. Do not approve dummy stages, publish placeholders, repeat setup writes blindly or weaken the publisher's missing-name check to recover.

The publish job receives OIDC only after approval. It performs no workspace install or build, and it publishes the same-run archives with public access, provenance and ignored scripts. A dispatcher may pass `reviewed_changeset_sha256`; when given, publication refuses any other changeset. A manual dispatch with `publish=false` is a dry run of main's head.

The publisher preflights the entire cohort before any write. It retries an existing version only when the archive bytes and `latest` tag match. npm has no atomic transaction across packages, so an interruption can leave a partial cycle or cohort. Publishing new names first means a failed first publish of a new name stops before any existing package moves its `latest` tag. Existing names also require the intended trusted-publisher configuration. Verify that configuration for every selected package before approving publication. After an interruption, the receipt's order shows which packages already moved. To retry, re-run the failed jobs of the same workflow run. The run keeps its commit even after main moves on, and identical rebuilt bytes are skipped. An unexpected tag is a blocker, not permission to rewrite it.

If Public quality fails on the release commit, re-run it and then re-run the publish workflow, or land a fix. For a fix that changes a package, add a note and run `pnpm release:version --write` to amend the unpublished release. For a fix outside packages, run `pnpm release:version --write --refresh` to re-collect it. Either rewrites the changeset, so merging starts publication automatically.

A separate read-only job downloads and checks every published archive, exact version, `latest` tag and provenance. npm accepts a publish before it serves the new version, so the job first waits until npm shows every package at the release version, for about 15 minutes from its first read. Every 20 seconds it reads again each package whose metadata answered 404 or lacked the version, or whose read timed out, failed on the network (including a body that fails to decompress) or returned HTTP 429 or a 5xx status. When its first read already shows every package, it checks that read; otherwise, once every package has shown, it reads the whole cohort once more and checks that read. It waits for nothing else: differing bytes, a newer stable version, an unexpected `latest` tag, missing provenance, an unexpected origin, another HTTP status or malformed JSON refuses at once. A package that still has not shown after about 15 minutes refuses the cohort as incomplete, with its last read failure if it had one. The job then downloads every archive, installs the registry cohort with scripts disabled and runs `npm audit signatures` to verify signatures and attestations; these steps do not wait. Publication is complete only when this verification passes; only then is the version tagged. A failed final verification requires investigation. It does not authorize unpublishing or republishing immutable versions. If the cohort was refused only as incomplete, or right after the wait an archive download returned 404 (`<name>: archive download returned 404`) or `npm install` reported "No matching version found" or "404 Not Found", re-run the failed jobs of the same run once npm shows every version.

The release job creates a tag or GitHub release only after an explicit HTTP 404 for that resource and a successful repository lookup. Authentication, rate-limit, network and other lookup failures stop the job. Existing lightweight and annotated tags must resolve to the exact verified release commit. Tag creation never replaces an existing tag; a race or conflict stops for investigation. After resolving a transient release failure, choose **Re-run failed jobs** on the same workflow run while its qualified artifacts remain available (retained for 14 days); no npm republish is needed. **Re-run all jobs** or a new dispatch repeats selection, which treats an existing version tag as complete and can skip the missing GitHub release. Once the artifacts expire, stop for explicit recovery using the verified release commit and artifacts whose provenance and integrity have been re-established; do not substitute current-main artifacts or replace the existing tag.

See [trusted publishing](https://docs.npmjs.com/trusted-publishers/), [immutable npm versions](https://docs.npmjs.com/cli/v12/commands/npm-publish/) and [dist-tags](https://docs.npmjs.com/cli/v12/commands/npm-dist-tag/). No preparation, dry run, local check or package-presence response establishes actual OIDC authorization or production framework readiness.
