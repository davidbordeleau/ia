---
id: spec-host-plugin-distribution
genre: spec
title: Host plugin distribution
status: implemented
created: "2026-10-12"
last-reviewed: "2026-10-14"
owners: [inventarch]
---

# Host plugin distribution

This contract describes the user-level side of host support: the IA home, the Claude plugin that `ia host claude --user` installs, the session briefing that plugin runs, and the initialization choice it records. The implementation is [user-host](../../../apps/cli/src/user-host.ts), [doctor-user](../../../apps/cli/src/doctor-user.ts), [briefing](../../../apps/cli/src/briefing.ts), [decline](../../../apps/cli/src/decline.ts), [channel](../../../apps/cli/src/channel.ts), the host table in [hosts.ts](../../../apps/distribution/src/hosts.ts) and the pure [plugin renderer](../../../packages/compliance/src/host-plugin.ts). Workspace registration is described in [host registration](../host-registration/README.md).

## 3 IA home

The IA home holds the materialized host payloads (`hosts/`), the Claude plugin marketplace (`claude/marketplace`), the initialization decisions (`state/decisions.json`) and the cached update check. It is `IA_HOME`, or `~/.ia` when that is unset; `IA_HOST_HOME` is still read and doctor warns that it is deprecated.

A relative home refuses with `IA-DIST-INPUT-INVALID`. A home that contains `src/` refuses with `IA-DIST-PATH-UNSAFE`, because it must never look like a workspace, and the IA home and a workspace may not contain each other. Doctor reports a registration that pins a payload outside the current home as a warning naming `ia host <host> --apply`; it does not rewrite the registration.

## 4 Host adapters

One row per host decides what each command accepts:

| Host | Status | Workspace registration | User-level entry point | Hooks |
| --- | --- | --- | --- | --- |
| `claude` | supported | yes | the Claude plugin | yes |
| `codex` | partial | yes | none | no |
| `cursor` | planned | no | none | no |

`ia host cursor` and `ia host codex --user` refuse with `IA-DIST-HOST-UNSUPPORTED` and write nothing. `ia doctor --host` accepts all three; for a host with no workspace registration, the briefing says so and never suggests `ia host`.

## 5 Install channel

Doctor reports how this `ia` is installed: a source `checkout`, with its commit and origin; an `npm` package; or `unknown`, which is a warning. It reads only the filesystem and local git. The channel decides the update instruction that doctor and the briefing give.

## 6 Plugin packaging

### 6.1 Rendering

The renderer is a pure function: the same input always yields the same files. It writes a marketplace manifest, the `ia` plugin manifest, an `ia-author` agent that reviews `.ia` records and proposes changes without editing files, a `SessionStart` hook, and `init`, `doctor` and `authoring` skills. The plugin has no MCP server; workspace registration stays with `ia host claude`. The CLI entry and the Node path are explicit renderer inputs.

### 6.2 Identity

The plugin version is `<cli version>+<12 hex digits>`. The digits come from a digest of the files rendered with a placeholder version, including the Node path the hook uses, so the version changes whenever the rendered content changes.

### 6.3 Apply

`ia host claude --user` needs no workspace, refuses `--root`, and plans by default. `--apply` writes the plugin to `<IA home>/claude/marketplace`, then runs Claude's own `claude plugin marketplace add <that directory>` and `claude plugin install ia@inventarch --scope user`. The plan prints both commands. If `claude` cannot be run, the apply writes the plugin and says to run them by hand. `claude` is looked up only on fully qualified `PATH` entries. The apply never reads or edits Claude's settings files. `--remove --apply` runs Claude's removal commands first and deletes the plugin directory last.

## 7 User state

### 7.1 Registration

The user-level plugin is owned and removed independently of any workspace registration. A workspace plan for Claude reports when the plugin is missing and names `ia host claude --user --apply`; it never runs it. A service refusal keeps its code and message and gains a command remedy. A `claude` command that fails refuses with `IA-CLI-HOST-COMMAND-FAILED`, naming the rerun.

### 7.2 Initialization choice

`ia init --decline today|forever` and `ia init --forget-decline` change only the IA home's decisions file, keyed to the repository; they write nothing in the repository. A successful `ia init --apply` clears the decision. A failure to clear it does not undo initialization.

### 7.3 Doctor

These rows exist with or without a workspace: install channel, IA home, Claude plugin and updates. With a workspace, doctor adds a local language compatibility row; without one, it adds the initialization decision. `ia doctor --host <host> --json` adds `session`, the briefing, and `nextActions`, each with its argument vector and the host's own invocation where it has one (`/ia:init` for Claude). Doctor repairs nothing, never runs `claude`, and makes no registry or update request.

## 8 Session hook

### 8.2 Briefing

The plugin's `SessionStart` hook runs `ia doctor --json --host claude` and gives it five seconds. It runs the CLI entry that rendered the plugin, or, when that file is gone, an `ia` found on a fully qualified `PATH` entry. It turns the `session` field into context lines for the model and at most one notice for the user. The briefing distinguishes:

- a directory that is not a workspace, where the model may offer `/ia:init` only when the request involves InventArch, `.ia` records or their governance;
- an initialization declined today or permanently, which the model does not offer again;
- a registered host, or a stale or missing registration with the `ia host <host> --apply` command;
- a host set doctor could not observe, naming recovery first;
- a plugin rendered by another `ia` version, naming `ia host claude --user --apply`;
- an available update, shown to the user at most once per local day;
- an `ia` that cannot be found, times out or does not report session state.

A briefing is evidence from observation. It grants no permission to execute anything.

## 9 Decision recovery

A decisions file that cannot be read is a doctor `warn` row naming the file and its repair. `ia init --decline` refuses with a remedy that depends on the cause. No session-start hook initializes a repository or rewrites authored records.

## 11 Updates and evidence

Doctor reads update state only from the cache in the IA home; it never asks npm or git. When a refresh is due, doctor returns the refresh command as data and the session hook starts it in the background. `IA_NO_UPDATE_CHECK=1`, a non-empty `CI`, or `"updateCheck": false` in the IA home's `config.json` turns update checks off.

[User host tests](../../../apps/cli/tests/user-host.test.ts) and [briefing tests](../../../apps/cli/tests/briefing.test.ts) cover state reporting and command behavior. Live plugin activation in Claude Code needs separate evidence.
