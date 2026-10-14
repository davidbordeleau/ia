---
id: spec-host-registration
genre: spec
title: Host registration
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-14"
owners: [inventarch]
---

# Host registration

This contract describes how `ia host` registers a workspace with an agent host and how `ia doctor` reports the result. The [host handler](../../../apps/cli/src/host.ts) plans and applies through the distribution services, and [host-projection.ts](../../../apps/cli/src/host-projection.ts) is the only writer of projection files. Supported hosts come from [hosts.ts](../../../apps/distribution/src/hosts.ts): `claude` and `codex` take a workspace registration, and `ia host cursor` refuses with `IA-DIST-HOST-UNSUPPORTED` and writes nothing. The user-level Claude plugin is described in [host plugin distribution](../host-plugin-distribution/README.md).

## 3 Payload and ownership

The CLI carries a generated host payload: a release identity, an inventory of its packages with byte digests, the runtime closure, a launcher and an installed-implementation catalog. `ia host --apply` materializes the payload in the IA home and verifies it. The MCP entry runs the payload's launcher.

When every element is applied, the registration records a join: the catalog of the payload it names, at the workspace's authored revision. `ia validate` reports each `@execution-binding` against that catalog as `bound`, `unavailable` or `revoked`, and `ia doctor` reports the catalog and the join. Neither registry content nor an authored binding loads or runs code.

### 3.2 Bundling

[host-payload.mjs](../../../tools/distribution/host-payload.mjs) follows the dependency closure of the public CLI, distribution, MCP server and edit-guard packages and of the implementation handlers the payload ships. It strips `development` export conditions, refuses a manifest or module that reaches an omitted capability, and refuses a runtime closure over 256 MiB. The public manifests must already describe the complete payload; apart from dropping development exports, the bundler does not change what they declare.

## 4 Commands

| Command | What it does |
| --- | --- |
| `ia host <claude\|codex>` | Plans the workspace registration. Nothing is written, the payload included. |
| `ia host <claude\|codex> --apply` | Materializes the payload, then applies the MCP entry and the projection, in that order. |
| `ia host <claude\|codex> --remove` | Plans removal of the owned host set; with `--apply` it removes it in reverse order. |
| `ia init --host <claude\|codex>` | Runs the same `--apply` path once the workspace is initialized. |
| `ia project <claude\|codex>` | Plans, or with `--apply` writes, the projection alone, with no MCP entry. |

The plan lists three elements:

| Element | Claude | Codex |
| --- | --- | --- |
| `mcp` | `.mcp.json` | `.codex/config.toml` |
| `context` | not selected | unsupported by host |
| `projection` | the packet `.claude/rules/ia-workspace.md` and the `ia-authoring` skill; an agent per authored `@agent-profile` under `.claude/agents/`; a skill per authored `@playbook` under `.claude/skills/`; a hook group per authored `@hook` in `.claude/settings.local.json` | the packet `AGENTS.md` and the `ia-authoring` skill under `.agents/skills/`; a skill per authored `@playbook`; each `@agent-profile` and `@hook` listed as not taken, with the reason |

The `context` element is not available in this release: `--context <identity>` refuses with `IA-DIST-HOST-UNSUPPORTED` for Claude and is a usage error for Codex.

Each hook group refuses an edit its paths and tools select unless the acting agent holds a governing `@mandate` that grants Synthesis there. `ia host` registers no per-system steward guard; applying the projection retires one that an earlier release registered.

A workspace `host --apply` writes the projection, so it is judged as Execution against the acting participant's mandates and takes `--actor <agent>`, as `ia project` does. The plan, `--remove` and `--user` are not judged.

After `install`, `update`, `remove` or `adopt` changes the workspace, each registered projection is re-rendered; the MCP entry is not touched. A refresh that fails after an install committed refuses at exit 3 and says that the installation is applied.

Every file these commands write is machine-local. Do not commit them.

## 5 Plan safety

A plan records the owned paths, their current state and the expected payload. A file without the generated marker at a path the projection writes, or an owned file or hook group changed by hand, makes the element refused: the plan still exits 0 and names the file and its repair, and `--apply` refuses with the same code before it writes anything. A pending host journal refuses the plan itself and names its recovery. Applying plans again and rechecks its inputs. The IA home and the workspace may not contain each other, and an IA home that holds `src/` refuses, so it can never pass for a workspace root.

## 6 Recovery

Host registration and installation keep journals. `ia recover host --root <directory>` (and `installation`, `guard` or `lifecycle`) repairs an interrupted transaction, and while a journal is pending, `ia host` and `ia project` refuse and name that recovery. A partially applied host action is never reported as registered. No cross-file atomicity is claimed; a rerun converges. Removal respects ownership and leaves foreign files in place.

Projection recovery also keeps unowned hook registrations and foreign generated files. A legacy or unowned guard is never adopted or deleted during a recovery; the refusal names the exact settings file and the safe removal or repair. A projection receipt is reused only when its render inputs, owned-file digests and removal evidence still match, so an interrupted apply cannot turn an external change into owned state.

## 7 Doctor and support

[Doctor](../../../apps/cli/src/doctor.ts) only observes and writes nothing. A matching registration is reported as written, not observed answering. A stale registration is `fail`, and doctor then exits 1.

Projection rows read the receipt the last apply wrote. A listed file that is missing is `warn` and one that changed is `fail`; records that now render a different packet are `warn` (outdated); with none of these, one `ok` row reports no drift. An owned hook group deleted or changed by hand is `fail`. A malformed state file is a `fail` row, never a crash. The `implementations` and `join-<host>` rows inspect pinned bytes without importing or running a handler.

The support row compares the observed Node and platform with the declared target in the package engine and the doctor implementation. Matching the target is not qualification. A platform outside the declaration is a warning, and a check that cannot run stays `unknown`. Test evidence is platform-specific.

## 8–10 Qualification boundaries

[Host tests](../../../apps/cli/tests/host-registration.test.ts), [generated-set tests](../../../apps/cli/tests/host-generated.test.ts), [recovery tests](../../../apps/cli/tests/host-recovery.test.ts) and [doctor tests](../../../apps/cli/tests/host-doctor.test.ts) establish local write, read and refusal behavior. A written configuration does not prove that a fresh host session loaded it or invoked a handler.
