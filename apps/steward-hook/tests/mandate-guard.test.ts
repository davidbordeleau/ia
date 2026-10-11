/**
 * Milestone generation-binding plan amendments C9 and C10, operator decision OD4: the guard re-keyed to `@mandate`. A
 * registration for one authored `@hook` runs `guard --root <root> --hook <identity>`; the hook decides an edit its tools
 * and paths select (or one under the authored `.ia/src` tree), and the edit proceeds only when the acting `@agent` holds
 * a governing mandate that grants Synthesis there. The workspace is the conformance corpus with apps/cli's composition
 * fixture laid over it, so its `.ia/src` holds the fixture's `@hook note-edits` (PreToolUse Write|Edit|MultiEdit over
 * `docs/**` and `restricted/**`), `docs-mandate` (the demo participant, Synthesis, covers `docs/`), `reviewer-docs` (the
 * reviewer, Observation, covers `restricted/`), `demo-mandate` (the demo participant, every move, scoped to the demo
 * workspace, whose steward it is) and the `reviewer` `@agent-profile`. The corpus adds its own `sample-mandate`
 * (agent-steward; Observation, Verification; covers `docs/**`) and `agent-steward-profile`.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HOOK_CODES } from '@inventarch/runtime';
import { runBounded } from '@tools/testing/subprocess.js';
import { evaluateMandateHook, printable, runHook } from '../src/main.js';
import type { HookOutput } from '../src/main.js';

// Every decision opens the disk-backed workspace.
vi.setConfig({ testTimeout: 60_000 });

const repository = resolve(import.meta.dirname, '../../..'),
  NATIVE = resolve(repository, 'examples/conformance/native'),
  FIXTURE = resolve(repository, 'apps/cli/tests/fixtures/composition-workspace/.ia/src'),
  HOOKS = readFileSync(resolve(FIXTURE, 'hooks.ia'), 'utf8'),
  HOOK = 'hook-authoring-system/binding/hook/note-edits',
  MESSAGE = "Use the participant's documentation mandate.",
  SUBPROCESS = Number(process.env['IA_TEST_SUBPROCESS_TIMEOUT_MS']) || 20_000;
const mandate = (name: string): string => `agent-system/policy/mandate/${name}`,
  governance = (name: string): string => `ia position --seat ${mandate(name)} --shape governance`;
/** The fixture's reviewer as a subagent: OD4's subagent carries `agent_id`. */
const reviewer = { agent_id: 'subagent-1', agent_type: 'reviewer' };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const path = relative(tmpdir(), root);
    if (isAbsolute(path) || !path.startsWith('ia-mandate-guard-') || path.includes('..'))
      throw new Error('Unsafe cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});
const put = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), text);
};
/** The workspace, with `overlay` replacing (or, null, deleting) files under its root. */
function workspace(overlay: Readonly<Record<string, string | null>> = {}): string {
  const root = mkdtempSync(resolve(tmpdir(), 'ia-mandate-guard-'));
  roots.push(root);
  cpSync(NATIVE, resolve(root, '.ia/src'), { recursive: true });
  cpSync(FIXTURE, resolve(root, '.ia/src'), { recursive: true });
  for (const [path, text] of Object.entries(overlay))
    if (text === null) rmSync(resolve(root, path));
    else put(root, path, text);
  return root;
}
const event = (root: string, path: string, extra: Record<string, unknown> = {}, tool = 'Write') => ({
  hook_event_name: 'PreToolUse',
  tool_name: tool,
  tool_input: { file_path: resolve(root, path), content: 'x', ...(tool === 'MultiEdit' ? { edits: [] } : {}) },
  ...extra,
});
const check = (root: string, path: string, extra: Record<string, unknown> = {}, tool = 'Write', hook = HOOK) =>
  evaluateMandateHook(root, hook, event(root, path, extra, tool));
const reason = (output: HookOutput): string | undefined => output.hookSpecificOutput?.permissionDecisionReason;
const code = (output: HookOutput): string | undefined => reason(output)?.split(':')[0];
/** The fixture's hooks.ia with `from` replaced by `to`. */
const hooks = (...edits: readonly (readonly [string, string])[]): string =>
  edits.reduce((text, [from, to]) => {
    if (!text.includes(from)) throw new Error(`hooks.ia lacks ${from}`);
    return text.replace(from, to);
  }, HOOKS);

it('allows the main session where its mandate grants Synthesis, a session launched with --agent included (OD4)', () => {
  const root = workspace();
  expect(check(root, 'docs/guide.md')).toEqual({});
  // A main session launched with --agent carries agent_type but no agent_id: still the main session, the demo steward.
  expect(check(root, 'docs/guide.md', { agent_type: 'reviewer' })).toEqual({});
  expect(check(root, 'docs/deep/new.md', { agent_type: 'stranger' }, 'Edit')).toEqual({});
  expect(check(root, 'docs/guide.md', {}, 'MultiEdit')).toEqual({});
});

it("denies an actor outside the governing mandate with the hook's message and the mandate's governance position", () => {
  const root = workspace();
  // The reviewer subagent acts as the reviewer @agent, which docs-mandate (the demo participant's) does not bind.
  const denied = check(root, 'docs/guide.md', reviewer);
  expect(code(denied)).toBe('IA-HOOK-NOT-MANDATED');
  expect(reason(denied)).toContain(MESSAGE);
  expect(reason(denied)).toContain('subagent reviewer acts as agent-system/binding/agent/reviewer');
  expect(reason(denied)).toContain(`Next: ${governance('docs-mandate')}`);
  expect(denied.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' });
  // The main session is outside reviewer-docs, the reviewer's mandate over restricted/.
  const main = check(root, 'restricted/plan.md');
  expect(code(main)).toBe('IA-HOOK-NOT-MANDATED');
  expect(reason(main)).toContain('the main session acts as agent-system/binding/agent/demo');
  expect(reason(main)).toContain(`Next: ${governance('reviewer-docs')}`);
  // The reviewer's own mandate there grants Observation only.
  const observation = check(root, 'restricted/plan.md', reviewer);
  expect(code(observation)).toBe('IA-HOOK-NOT-MANDATED');
  expect(reason(observation)).toContain('reviewer-docs allows Observation; author needs Synthesis');
});

it("lets a subagent act as its profile's composition.agent, and denies an unknown subagent under a selected path", () => {
  const root = workspace({
    '.ia/src/hooks.ia': hooks(['moves [Observation]', 'moves [Observation, Synthesis]']),
  });
  expect(check(root, 'restricted/plan.md', reviewer)).toEqual({});
  expect(code(check(root, 'restricted/plan.md'))).toBe('IA-HOOK-NOT-MANDATED');
  // The corpus's agent-steward-profile acts as agent-steward, which sample-mandate binds without Synthesis.
  const steward = check(root, 'docs/guide.md', { agent_id: 'subagent-2', agent_type: 'agent-steward-profile' });
  expect(code(steward)).toBe('IA-HOOK-NOT-MANDATED');
  expect(reason(steward)).toContain('acts as agent-system/binding/agent/agent-steward');
  expect(reason(steward)).toContain(`Next: ${governance('sample-mandate')}`);
  // A subagent no authored profile names, one with no agent_type, and a malformed agent_id are not established.
  for (const extra of [
    { agent_id: 'subagent-3', agent_type: 'stranger' },
    { agent_id: 'subagent-4' },
    { agent_id: '', agent_type: 'reviewer' },
    { agent_id: 7, agent_type: 'reviewer' },
    // A profile name is matched exactly, as the generated agent file names it.
    { agent_id: 'subagent-5', agent_type: 'Reviewer' },
  ]) {
    const unknown = check(root, 'docs/guide.md', extra);
    expect(code(unknown), JSON.stringify(extra)).toBe('IA-HOOK-IDENTITY-UNAVAILABLE');
    expect(reason(unknown)).toContain(MESSAGE);
    expect(reason(unknown)).toContain(`Next: ${governance('docs-mandate')}`);
  }
});

it('allows any actor where the hook selects nothing, and denies nothing until a mandate governs the path', () => {
  const root = workspace({ '.ia/src/hooks.ia': hooks(['"restricted/**"]', '"restricted/**", "open/**"]']) });
  for (const extra of [{}, reviewer, { agent_id: 'subagent-3', agent_type: 'stranger' }]) {
    expect(check(root, 'src/app.ts', extra), JSON.stringify(extra)).toEqual({});
    expect(check(root, 'README.md', extra, 'Edit'), JSON.stringify(extra)).toEqual({});
    // open/** is selected, but no mandate claims it: nothing is restricted there.
    expect(check(root, 'open/notes.md', extra), JSON.stringify(extra)).toEqual({});
  }
});

it('decides each hook independently when several select one path, each by its own tools and message', () => {
  const second =
    '\n@hook write-only\n  meaning\n    says "Guard documentation writes."\n    answers "Who may write documentation?"\n  hook\n    event PreToolUse\n    tools [Write]\n    paths ["docs/**"]\n    message "Second hook: writes need the documentation mandate."\n';
  const root = workspace({ '.ia/src/hooks.ia': HOOKS + second }),
    other = 'hook-authoring-system/binding/hook/write-only';
  expect(reason(check(root, 'docs/guide.md', reviewer, 'Write'))).toContain(MESSAGE);
  expect(reason(check(root, 'docs/guide.md', reviewer, 'Write', other))).toContain(
    'Second hook: writes need the documentation mandate.',
  );
  // write-only does not select Edit; note-edits does.
  expect(check(root, 'docs/guide.md', reviewer, 'Edit', other)).toEqual({});
  expect(code(check(root, 'docs/guide.md', reviewer, 'Edit'))).toBe('IA-HOOK-NOT-MANDATED');
  expect(check(root, 'docs/guide.md', {}, 'Write', other)).toEqual({});
});

it("keeps the guard's own records and registration protected whatever the hook's paths select", () => {
  const root = workspace();
  // Every edit under the authored .ia/src tree is decided, with the workspace's own mandates: demo-mandate binds the demo
  // steward, so the main session may author records and the reviewer subagent may neither change the hook or a mandate
  // nor add a mandate that would grant it docs/.
  expect(check(root, '.ia/src/hooks.ia', {}, 'Edit')).toEqual({});
  expect(check(root, '.ia/src/new-notes.ia')).toEqual({});
  for (const path of ['.ia/src/hooks.ia', '.ia/src/composition.ia', '.ia/src/workspace.ia', '.ia/src/evil.ia']) {
    const denied = check(root, path, reviewer);
    expect(code(denied), path).toBe('IA-HOOK-NOT-MANDATED');
    expect(reason(denied), path).toContain(`Next: ${governance('demo-mandate')}`);
  }
  expect(code(check(root, '.ia/src/hooks.ia', { agent_id: 'subagent-3', agent_type: 'stranger' }))).toBe(
    'IA-HOOK-IDENTITY-UNAVAILABLE',
  );
  // The installation state and, once the hook groups are owned, the settings that hold them and the project settings
  // that could disable them are managed: no actor edits them through a file tool.
  expect(code(check(root, '.ia/distributions.lock.json'))).toBe('IA-HOOK-PROJECTION-MANAGED');
  expect(check(root, '.claude/settings.local.json')).toEqual({});
  put(
    root,
    '.ia/distributions/hosts/claude-hooks-workspace.json',
    JSON.stringify({
      format: 'ia.hook-registration-state.v1',
      id: 'workspace',
      cache: resolve(root, '..', 'cache'),
      release: 'a'.repeat(64),
      created: true,
      groups: [],
    }),
  );
  for (const path of ['.claude/settings.local.json', '.claude/settings.json', '.ia/distributions/hosts/x.json'])
    for (const extra of [{}, reviewer]) expect(code(check(root, path, extra)), path).toBe('IA-HOOK-PROJECTION-MANAGED');
  // The retired steward rule is not restored: a system folder is decided like any other authored path.
  expect(check(root, '.ia/src/systems/agent-system/records/new.ia')).toEqual({});
  expect(code(check(root, '.ia/src/systems/agent-system/records/new.ia', reviewer))).toBe('IA-HOOK-NOT-MANDATED');
});

it('folds path case where the volume folds names, for hook.paths and authority.covers alike', () => {
  const folds = process.platform === 'win32' || process.platform === 'darwin';
  // Authored in another case than the edit: `Docs/**` selects and `docs/` covers `DOCS/x.md` exactly where the volume
  // opens the three as one file; elsewhere `DOCS/x.md` is another path that neither names.
  const root = workspace({ '.ia/src/hooks.ia': hooks(['"docs/**"', '"Docs/**"']) });
  expect(code(check(root, 'DOCS/x.md', reviewer))).toBe(folds ? 'IA-HOOK-NOT-MANDATED' : undefined);
  expect(check(root, 'DOCS/x.md')).toEqual({});
  expect(code(check(root, 'docs/x.md', reviewer))).toBe(folds ? 'IA-HOOK-NOT-MANDATED' : undefined);
  const covers = workspace({ '.ia/src/hooks.ia': hooks(['covers ["docs/"]', 'covers ["Docs/"]']) });
  // docs/** selects DOCS/x.md where names fold; Docs/ then covers it, and binds the demo participant only.
  expect(code(check(covers, 'DOCS/x.md', reviewer))).toBe(folds ? 'IA-HOOK-NOT-MANDATED' : undefined);
  expect(check(covers, 'DOCS/x.md')).toEqual({});
  // Where names fold, the demo participant is allowed under docs/ only because Docs/ covers it; elsewhere sample-mandate
  // (docs/**) governs docs/x.md alone and binds agent-steward, so the main session is not allowed there.
  expect(code(check(covers, 'docs/x.md'))).toBe(folds ? undefined : 'IA-HOOK-NOT-MANDATED');
});

it('decides a typed path by its on-disk name: a case variant is the same path, and an 8.3 alias is refused, never matched', () => {
  const folds = process.platform === 'win32' || process.platform === 'darwin';
  const root = workspace({
    'docs/secret.md': 'x\n',
    'restricted/plan.md': 'x\n',
    'src/longdirectory/app.ts': 'x\n',
  });
  // Where the volume folds names, another case of an existing folder resolves to it: the hook selects it and the
  // mandates that cover it govern, so the reviewer is refused and the demo participant allowed, as under docs/.
  for (const path of ['Docs/secret.md', 'DOCS/secret.md', 'DOCS/new/deep.md']) {
    expect(code(check(root, path, reviewer)), path).toBe(folds ? 'IA-HOOK-NOT-MANDATED' : undefined);
    expect(check(root, path), path).toEqual({});
  }
  expect(code(check(root, 'Restricted/plan.md'))).toBe(folds ? 'IA-HOOK-NOT-MANDATED' : undefined);
  expect(code(check(root, '.IA/SRC/hooks.ia', reviewer))).toBe(folds ? 'IA-HOOK-NOT-MANDATED' : undefined);
  // A Windows 8.3 short name spells an existing folder or file another way than by case: the on-disk name is selected,
  // and the typed spelling is refused as an alias rather than matched or decided. Where the volume keeps no short
  // names, there is no such spelling to test.
  const short = (name: string): boolean => process.platform === 'win32' && existsSync(resolve(root, name));
  if (short('RESTRI~1'))
    for (const extra of [{}, reviewer])
      expect(code(check(root, 'RESTRI~1/plan.md', extra)), JSON.stringify(extra)).toBe('IA-HOOK-PATH-UNSAFE');
  if (short('.ia/src/COMPOS~1.IA'))
    for (const extra of [{}, reviewer])
      expect(code(check(root, '.ia/src/COMPOS~1.IA', extra)), JSON.stringify(extra)).toBe('IA-HOOK-PATH-UNSAFE');
  // A short name of a folder the hook does not select is no edit it decides.
  if (short('src/LONGDI~1')) expect(check(root, 'src/LONGDI~1/app.ts', reviewer)).toEqual({});
});

it('matches selections in the G06c dialect, where !, [ and shell metacharacters are literal', () => {
  const root = workspace({
    '.ia/src/hooks.ia': hooks(
      ['"restricted/**"]', '"restricted/**", "[ab]/**", "!x/**", "$(id)/**"]'],
      ['covers ["docs/"]', 'covers ["docs/", "[ab]/", "!x/", "$(id)/"]'],
    ),
  });
  for (const path of ['[ab]/f.md', '!x/f.md', '$(id)/f.md'])
    expect(code(check(root, path, reviewer)), path).toBe('IA-HOOK-NOT-MANDATED');
  // Not a character class, not a negation, not a substitution: none of these is selected.
  for (const path of ['a/f.md', 'b/f.md', 'x/f.md', 'y/f.md', 'id/f.md'])
    expect(check(root, path, reviewer), path).toEqual({});
});

it('refuses malformed input, unsafe paths and an unreadable declaration or mandate with registered codes', () => {
  const root = workspace(),
    args = ['--root', root, '--hook', HOOK],
    valid = JSON.stringify(event(root, 'docs/guide.md', reviewer));
  const codes = new Set<string>(HOOK_CODES);
  const refused = (output: HookOutput): string => {
    const found = code(output)!;
    expect(codes.has(found), found).toBe(true);
    return found;
  };
  expect(refused(runHook(args, '{'))).toBe('IA-HOOK-INPUT-INVALID');
  expect(refused(runHook(args, '{}'))).toBe('IA-HOOK-INPUT-INVALID');
  expect(refused(runHook(args, JSON.stringify({ ...event(root, 'docs/x.md'), tool_name: 'Bash' })))).toBe(
    'IA-HOOK-INPUT-INVALID',
  );
  for (const bad of [
    ['--root', root, '--hook'],
    ['--root', root, '--hook', ''],
    ['--root', root, '--hook', 'Note Edits'],
    ['--root', root, '--hook', 'hook-authoring-system/binding/hook/note-edits/extra'],
    ['--root', root, '--hook', HOOK, '--actors', resolve(root, 'actors.json')],
    ['--hook', HOOK, '--root', root],
  ])
    expect(refused(runHook(bad, valid)), bad.join(' ')).toBe('IA-HOOK-INPUT-INVALID');
  expect(refused(runHook(args, ' '.repeat(1024 * 1024 + 1)))).toBe('IA-HOOK-INPUT-INVALID');
  // A relative path needs a cwd inside the fixed root; a root that is not absolute is unusable.
  expect(
    refused(evaluateMandateHook(root, HOOK, { ...event(root, 'x'), tool_input: { file_path: 'docs/guide.md' } })),
  ).toBe('IA-HOOK-PATH-UNSAFE');
  expect(refused(evaluateMandateHook('relative-root', HOOK, event(root, 'docs/guide.md')))).toBe('IA-HOOK-PATH-UNSAFE');
  // A selected path reached through a link or junction, either way round, is refused rather than decided.
  const outside = mkdtempSync(resolve(tmpdir(), 'ia-mandate-guard-'));
  roots.push(outside);
  mkdirSync(resolve(root, 'docs'), { recursive: true });
  symlinkSync(resolve(root, 'docs'), resolve(root, 'notes'), 'junction');
  symlinkSync(outside, resolve(root, 'docs/linked'), 'junction');
  expect(refused(check(root, 'notes/guide.md'))).toBe('IA-HOOK-PATH-UNSAFE');
  expect(refused(check(root, 'docs/linked/guide.md'))).toBe('IA-HOOK-PATH-UNSAFE');
  // A registration whose hook is not admitted, or not a declaration the guard can decide, cannot know what it selects:
  // it refuses every edit it receives, naming the re-registration.
  for (const path of ['docs/guide.md', 'src/app.ts']) {
    const absent = check(root, path, {}, 'Write', 'hook-authoring-system/binding/hook/absent');
    expect(refused(absent)).toBe('IA-HOOK-DECLARATION-UNAVAILABLE');
    expect(reason(absent)).toContain(`ia host claude --root ${JSON.stringify(root)} --apply --yes`);
    expect(reason(absent)).toContain(`ia host claude --root ${JSON.stringify(root)} --remove --apply --yes`);
  }
  const stop = workspace({ '.ia/src/hooks.ia': hooks(['event PreToolUse', 'event Stop']) });
  expect(refused(check(stop, 'src/app.ts'))).toBe('IA-HOOK-DECLARATION-UNAVAILABLE');
  const empty = workspace({ '.ia/src/hooks.ia': hooks(['["docs/**", "restricted/**"]', '[]']) });
  expect(reason(check(empty, 'docs/guide.md'))).toContain('selects no path');
  // A governing mandate whose authority cannot be read refuses the edit it governs, and only that edit.
  const malformed = workspace({ '.ia/src/hooks.ia': hooks(['moves [Synthesis]', 'moves []']) });
  expect(refused(check(malformed, 'docs/guide.md'))).toBe('IA-HOOK-MANDATE-UNAVAILABLE');
  expect(check(malformed, 'src/app.ts')).toEqual({});
});

it('prints the authored message without terminal escapes, controls or bidirectional overrides', () => {
  expect(printable('a\u001b[31mred\u001b[0m\u001b]0;title\u0007b\u202ec\u2066d\u0085e\u2028f\ng\u0000h')).toBe(
    'aredb c d e f g h',
  );
  const root = workspace({
    '.ia/src/hooks.ia': hooks([`"${MESSAGE}"`, '"Use \u001b[31mthe\u202e mandate\u2028 $(rm -rf ~)."']),
  });
  const denied = reason(check(root, 'docs/guide.md', reviewer))!;
  expect(denied).toContain('Use the  mandate  $(rm -rf ~).');
  expect(denied).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2028\u2066-\u2069]/);
});

it('runs from the built entry with --hook, as the launcher passes its guard arguments through', async () => {
  const root = workspace();
  const run = async (extra: Record<string, unknown>) => {
    const result = await runBounded(
      process.execPath,
      [resolve(repository, 'apps/steward-hook/dist/main.js'), '--root', root, '--hook', HOOK],
      { input: JSON.stringify(event(root, 'docs/guide.md', extra)), timeoutMs: SUBPROCESS },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout) as HookOutput;
  };
  expect(await run({})).toEqual({});
  expect(code(await run(reviewer))).toBe('IA-HOOK-NOT-MANDATED');
});
