---
id: spec-workspace-initialization-apply
genre: spec
title: Workspace initialization apply
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-18"
owners: [inventarch]
---

# Workspace initialization apply

[init.ts](../../../apps/cli/src/init.ts) runs the steps of `ia init --apply` in a fixed order and reports each completed effect. This contract accompanies [the starter definition](../workspace-initialization/README.md).

## 1 Plan and apply

The plan lists the paths init would own, the conflicts it finds, the starter, the base pin and the steps: install, author, admission, descriptor, capture and, with `--host`, project. It exits 0 whether or not it finds conflicts. `--apply` computes the same plan in the same invocation, rereads the base pin, and applies only a plan without conflicts. On a terminal without `--yes` or `--json` it asks once, and a declined answer writes nothing (exit 0). `--json` never asks, so `--apply --json` needs `--yes`.

With `--json` the plan holds `state` (`fresh`; `resumable` when an earlier run completed a step or left temporary files; or `conflict`), `owns`, `conflicts` (`{path, reason}`), `leftovers`, `steps` (`{id, status}`, with status `done` for a step an earlier run completed), `starter` (its id, paths, records, descriptor, base pin and provenance status), `host` (`{selected, status}`), `adoption` with `--adopt`, and `next` for a target that is already initialized.

Unrelated content in the target is preserved, and an existing `.ia/.gitignore` is left as it is. These are conflicts, which `--apply` refuses with `IA-CLI-CONFLICT` before any write:

- a starter file with other bytes, or any other file under `.ia/src/` that init does not write;
- a name that does not resolve (see [Inputs](../workspace-initialization/README.md#2-inputs));
- an existing `.ia/distributions.lock.json`, unless the bundled base is already installed and active as its one request; another active generation; or installation state that cannot be read;
- a target directory this process cannot write;
- an existing `.ia/release.json`: the target is already initialized, and the refusal names `ia position --root <directory>`.

Temporary files that an interrupted write left beside init's own targets are listed and removed. A pending install journal or a held install lock is not a conflict: the plan and `--apply` both refuse before any write, with `IA-DB-SOURCE-UNAVAILABLE` or `IA-CLI-RECOVERY-REQUIRED` (exit 3), and name `ia recover installation --root <directory>`. An installer that takes the lock between the plan and the apply refuses the apply with `IA-DIST-INSTALL-BUSY`.

## 2 Base artifact

[language-base.ts](../../../tools/native/language-base.ts) `--write` builds the bundled base from public repository sources. It refuses to write while any check fails: the pinned id is not `inventarch/language`, the version differs from the native version policy, the archive or manifest digest differs from the pin, the archive does not verify, or the archive's engine range rejects the CLI's distribution engine. It writes the archive before the pin and removes every other file under `assets/base/`, so exactly one archive ships. Packing uses the `ustar-v1` recipe at epoch 0, so fixed inputs on one zlib build produce the same bytes and the same pin. Both files are gitignored build output that the root build regenerates.

## 3 Installation

The bundled base is installed offline through the shared distribution installer, resolved the way `ia install` resolves a local archive, with exact digest and manifest checks. No init step makes a network request; `--adopt` reads its registry while planning, before any step, and that read uses the network when the registry is a URL. The step is skipped when the planned base is already installed. Installation acquires no remote credential and grants no executable authority. With `--adopt`, init then writes the pinned source mount and its `.ia/workspace.json` binding.

## 4 Authoring and admission

Starter writes are create-only: an existing starter file is skipped only when its bytes agree. `.ia/.gitignore` is written only where none exists. Admission must report zero errors and compile each starter record at its planned path before initialization completes. The identities init reports are read from the compiled graph.

## 5 Descriptor completion

Writing `.ia/release.json` marks the workspace initialized. Before that point an interruption names the rerun of `ia init`. No journal is written: the rerun derives from the workspace which steps are done and skips each one whose result still matches.

## 6 Effects after completion

Capture and host projection follow the descriptor and report independently. Capture writes `.ia/work/snapshot/current.json` as `ia capture` does. A failed capture keeps the initialization and names `ia capture --root <root>`. With `--host`, the projection still runs after a failed capture, because the packet reads the live revision rather than the capture. A failed or interrupted projection names `ia host <host> --root <root> --apply`. The next action of each of these refusals opens by saying that the workspace is initialized. Earlier effects are never rolled back.

## 7 Migration recovery

Migration preflights every move, delete, write, identity and registered projection before its first write. It then records an operation journal, `.ia/migration.json`, holding the plan, the exact bytes and digests of each file before and after, and a cursor. A failed or interrupted step names the migration rerun, `ia init <directory> --migrate --apply --yes` (with `--system` when the migration was planned with it), with host transaction recovery first when one is pending. The rerun verifies the journal and every completed state before it resumes, and refuses an edited destination, a corrupt journal, changed flags or a different bundled base. The journal is removed only after every effect completes. A migrated workspace that fails admission names `ia validate`, and its findings must be repaired before the migration can finish.

Projection recovery is conservative: unowned hooks, foreign files and external validation evidence are not adopted or removed while resuming. Receipts are reused only when their recorded inputs and current bytes still match; otherwise the apply refuses with the exact repair target. When migration creates `.ia/.gitignore` it omits `distributions/` if `.ia/distributions` is already tracked, and it refuses before any change when Git ignore rules or attributes could hide or rewrite tracked installation bytes. Repository history or a caller-owned backup supplies rollback; the CLI claims no transaction across all effects.

## 8 Acceptance evidence

[Init tests](../../../apps/cli/tests/init.test.ts), [migration tests](../../../apps/cli/tests/init-migrate.test.ts), [language-base tests](../../../tools/native/language-base.test.ts) and the [installed view checks](../../../tools/distribution/installed-views.mjs), which `pnpm packages:qualify` runs against the packed and installed CLI, exercise the authored shape, the descriptor, capture, the omission of a host projection without `--host`, interrupted steps and effects, and the offline base. Publication and host activation need evidence of their own.
