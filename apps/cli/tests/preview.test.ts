/**
 * `ia preview` (milestone generation-binding plan amendments C18, C19 and C3; continuation lane C): the read-only half of
 * record authoring, on an `ia init` workspace with the CLI composition fixture laid over it and a small plan authored.
 * Every form, refused ones included, leaves the whole workspace directory byte for byte as it was, and every refusal's
 * next command runs in the state that caused it.
 */
import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { open } from '@inventarch/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Result } from '../src/consumer.js';
import { cleanup, cli, nextArgv, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
afterAll(cleanup);

const WORK = `#! ia 1.0

@plan p1
  meaning
    says "The demo plan."
  work
    title "Demo plan"
    status open

@milestone m1
  meaning
    says "The first milestone."
  work
    title "First"
    status open
    plan @plan p1
    exit "Done."

@milestone m2
  meaning
    says "The second milestone."
  work
    title "Second"
    status open
    plan @plan p1
    exit "Done again."
`;
const demo = 'workspace-system/definition/workspace/demo',
  participant = 'agent-system/binding/agent/demo',
  ops = 'agent-system/binding/agent/ops',
  mandate = (name: string) => `agent-system/policy/mandate/${name}`,
  EMPTY = createHash('sha256').update('').digest('hex');

let base = '';
beforeAll(async () => {
  base = resolve(scratch('preview-base'), 'demo');
  const init = await run(['init', base, '--apply', '--yes', '--host', 'none', '--json']);
  expect(init.exitCode, init.stdout).toBe(0);
  cpSync(resolve(cli, 'tests/fixtures/composition-workspace'), base, { recursive: true });
  writeFileSync(resolve(base, '.ia/src/work.ia'), WORK);
  const validated = await run(['validate', '--root', base, '--json']);
  expect(JSON.parse(validated.stdout)).toMatchObject({ status: 'admitted', counts: { errors: 0 } });
});
/** A fresh copy of the base workspace, with `edit` applied to its sources. */
function workspace(edit: (root: string) => void = () => {}): string {
  const root = resolve(scratch('preview'), 'demo');
  cpSync(base, root, { recursive: true });
  edit(root);
  return root;
}
const rewrite = (root: string, path: string, change: (text: string) => string): void =>
  writeFileSync(resolve(root, path), change(readFileSync(resolve(root, path), 'utf8')));
/** Every directory and file under `root`, files with the sha256 of their bytes; links are listed, never followed. */
function tree(root: string): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) entries[path] = 'link';
      else if (entry.isDirectory()) {
        entries[`${path}/`] = 'directory';
        walk(path);
      } else
        entries[path] = createHash('sha256')
          .update(readFileSync(join(root, path)))
          .digest('hex');
    }
  };
  walk('');
  return entries;
}
/** One preview, with the workspace directory checked unchanged by it whatever it returned. */
async function preview(root: string, argv: readonly string[], json = true): Promise<Result> {
  const before = tree(root);
  const result = await run(['preview', ...argv, '--root', root, ...(json ? ['--json'] : [])]);
  expect(tree(root), `ia preview ${argv.join(' ')} wrote`).toEqual(before);
  return result;
}
const body = (result: Result) => JSON.parse(result.stdout) as Record<string, unknown> & { readonly next?: string };
/**
 * A refusal: its code, and its next command run in the same state, which must run without a refusal of its own (a
 * preview whose candidate has findings is a verdict, at exit 1 with nothing on stderr) and write nothing.
 */
async function refused(root: string, argv: readonly string[], code: string): Promise<Record<string, unknown>> {
  const result = await preview(root, argv);
  expect(result.exitCode, result.stdout).not.toBe(0);
  const refusal = body(result);
  expect(refusal).toMatchObject({ ok: false, code });
  const next = nextArgv(refusal.next!);
  expect(next, refusal.next).toContain('--root');
  const before = tree(root);
  const followed = await run(next);
  expect(followed.stderr, refusal.next).toBe('');
  expect(followed.exitCode, `${refusal.next}\n${followed.stdout}`).toBeLessThanOrEqual(1);
  expect(tree(root)).toEqual(before);
  return refusal;
}

describe('the four forms', () => {
  it('previews a new record into the default file, clean with its fields, and prints the absent file digest', async () => {
    const root = workspace();
    const clean = await preview(root, [
      'task',
      't1',
      'meaning.says=The first task',
      'work.title=First',
      'task',
      'work.status=open',
      'milestone=@milestone',
      'm1',
    ]);
    expect(clean.exitCode, clean.stdout).toBe(0);
    expect(body(clean)).toMatchObject({
      mode: 'record',
      path: '.ia/src/task.ia',
      exists: false,
      digest: EMPTY,
      identity: 'work-system/definition/task/t1',
      admitted: true,
      before: null,
      after:
        '@task t1\n  meaning\n    says "The first task"\n  work\n    title "First task"\n    status open\n    milestone @milestone m1',
      clean: true,
      counts: { errors: 0, warnings: 0 },
      records: [{ identity: 'work-system/definition/task/t1', before: null, after: expect.any(String) }],
      profile: { actor: participant, by: 'steward', mandates: [mandate('demo-mandate')] },
    });
    expect(body(clean)['revision']).not.toBe(body(clean)['baseRevision']);
    // The literal plan form prints the candidate and its digest, with the schema's missing fields as findings.
    const bare = await preview(root, ['task', 't1', 'milestone=@milestone', 'm1'], false);
    expect(bare.exitCode).toBe(1);
    expect(bare.stdout).toContain('Preview  .ia/src/task.ia');
    expect(bare.stdout).toContain(EMPTY);
    expect(bare.stdout).toContain('    milestone @milestone m1');
    expect(bare.stdout).toContain("IA-COMP-FIELD-MISSING  @schema task requires 'meaning.says'");
    expect(bare.stdout).toContain('Preview writes nothing.');
  });
  it('previews into an existing owned file named by --at, keeping every other record of it', async () => {
    const root = workspace();
    const result = await preview(root, [
      'milestone',
      'm3',
      'meaning.says=Third',
      'work.title=Third',
      'work.status=proposed',
      'work.plan=@plan p1',
      'work.exit=Shipped',
      '--at',
      '.ia/src/work.ia',
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const view = body(result);
    expect(view).toMatchObject({ path: '.ia/src/work.ia', exists: true, clean: true });
    expect(view['digest']).toBe(
      createHash('sha256')
        .update(readFileSync(resolve(root, '.ia/src/work.ia')))
        .digest('hex'),
    );
    const records = view['records'] as readonly { identity: string; before: string | null; after: string | null }[];
    expect(records.map((row) => row.identity)).toEqual([
      'work-system/definition/milestone/m1',
      'work-system/definition/milestone/m2',
      'work-system/definition/milestone/m3',
      'work-system/definition/plan/p1',
    ]);
    for (const row of records)
      if (row.identity.endsWith('/m3')) expect(row.before).toBeNull();
      else expect(row.after, row.identity).toBe(row.before);
  });
  it('previews --relate as exactly one changed record, its digest the only one that moves', async () => {
    const root = workspace();
    for (const argv of [
      ['--relate', '@milestone', 'm2', 'requires', '@milestone', 'm1'],
      ['--relate', '@milestone m2', 'requires', '@milestone m1'],
      ['--relate', 'work-system/definition/milestone/m2', 'requires', 'work-system/definition/milestone/m1'],
    ]) {
      const result = await preview(root, argv);
      expect(result.exitCode, result.stdout).toBe(0);
      const view = body(result);
      expect(view).toMatchObject({ mode: 'relate', identity: 'work-system/definition/milestone/m2', clean: true });
      expect(view['after']).toBe(
        `${view['before']}\n  relationships\n    requires ${argv.at(-1) === 'm1' ? '@milestone m1' : argv.at(-1)}`,
      );
      const records = view['records'] as readonly { identity: string; before: string; after: string }[];
      expect(records.filter((row) => row.before !== row.after).map((row) => row.identity)).toEqual([
        'work-system/definition/milestone/m2',
      ]);
      expect(records).toHaveLength(3);
    }
  });
  it('previews --set and += as exactly one changed record', async () => {
    const root = workspace();
    const set = await preview(root, ['--set', '@milestone', 'm1', 'work.owner=Tom', 'Crown']);
    expect(set.exitCode, set.stdout).toBe(0);
    expect(body(set)['after']).toBe(`${body(set)['before']}\n    owner "Tom Crown"`);
    expect(
      (body(set)['records'] as readonly { identity: string; before: string; after: string }[])
        .filter((row) => row.before !== row.after)
        .map((row) => row.identity),
    ).toEqual(['work-system/definition/milestone/m1']);
    const appended = await preview(root, ['--set', '@agent demo', 'applies+=task']);
    expect(appended.exitCode, appended.stdout).toBe(0);
    expect(body(appended)).toMatchObject({ path: '.ia/src/workspace.ia', identity: participant, clean: true });
    expect(body(appended)['after']).toContain('    applies [task]');
    expect(
      (body(appended)['records'] as readonly { identity: string; before: string; after: string }[])
        .filter((row) => row.before !== row.after)
        .map((row) => row.identity),
    ).toEqual([participant]);
  });
  it("prints a word's lowering, schema, default file and consent", async () => {
    const root = workspace();
    const human = await preview(root, ['task'], false);
    expect(human.exitCode).toBe(0);
    for (const text of [
      'Word  task',
      'work-system',
      'lowers to  definition',
      'must work.milestone',
      'ref to milestone',
      'work-system: require task, milestone, decision using task, milestone, any-adopter',
      'ia preview task <name> meaning.says=<text>',
    ])
      expect(human.stdout).toContain(text);
    const json = body(await preview(root, ['task']));
    expect(json).toMatchObject({
      mode: 'word',
      word: 'task',
      system: 'work-system',
      lowering: { kind: 'definition', category: 'process', primitive: 'Decision', move: 'Execution' },
      file: { path: '.ia/src/task.ia', exists: false, digest: EMPTY },
      profile: { actor: participant },
    });
    expect((json['schema'] as { fields: { path: string; type: string; must: boolean }[] }).fields).toContainEqual({
      path: 'work.status',
      type: 'id in [proposed, open, held, closed, dropped, superseded]',
      must: true,
    });
  });
});

describe('refusals', () => {
  it('refuses an unconsented relationship row, naming the system whose registration refuses it', async () => {
    const root = workspace();
    const refusal = await refused(
      root,
      ['--relate', '@milestone m1', 'requires', '@plan p1'],
      'IA-LANG-EDGE-UNCONSENTED',
    );
    expect(refusal['message']).toBe(
      'The source system work-system, which registers @milestone, does not consent to require milestone -> plan: no row of its consent ledger admits it',
    );
    expect(refusal['next']).toContain('ia preview milestone');
    const target = await refused(
      root,
      ['--relate', '@agent reviewer', 'requires', '@milestone m1'],
      'IA-LANG-EDGE-UNCONSENTED',
    );
    expect(target['message']).toContain('The target system work-system');
  });
  it('refuses a type mismatch, an unknown field and a value that would inject syntax', async () => {
    const root = workspace();
    for (const [argv, message] of [
      [['--set', '@milestone m1', 'work.status=alien'], 'work.status expects one of proposed'],
      [['--set', '@milestone m1', 'work.plan=@milestone m2'], 'work.plan expects a reference to @plan'],
      [['--set', '@milestone m1', 'work.status=open # hidden'], 'without a comment'],
      [['--set', '@milestone m1', 'work.status=open when phase act'], 'one unconditional value'],
      [['--set', '@milestone m1', 'work.title=x\n  relationships\n    requires @milestone m2'], 'single-line'],
      [['--set', '@milestone m1', 'work.foo=x'], '@milestone declares no field work.foo'],
      [['--set', '@milestone m1', 'title+=x'], 'not a list'],
      [['task', 't9', 'meaning.colour=blue'], '@task declares no field meaning.colour'],
      [['task', 't9', 'work.due=tomorrow'], 'ISO date'],
    ] as const) {
      const refusal = await refused(root, argv, 'IA-CLI-EDIT-INVALID');
      expect(refusal['message'], argv.join(' ')).toContain(message);
    }
  });
  it('refuses a record that is not owned, an unadmitted record and a path outside the authored root', async () => {
    const root = workspace();
    const installed = await refused(
      root,
      ['--set', 'agent-system/binding/agent/public-work-system-steward', 'meaning.says=Mine now'],
      'IA-CLI-EDIT-UNOWNED',
    );
    expect(installed['message']).toContain('adopted placement (band 90)');
    expect(installed['next']).toContain('ia position --seat floor/definition/system/agent-system');
    await refused(root, ['--relate', '@milestone m9', 'requires', '@milestone m1'], 'IA-CLI-EDIT-MISSING');
    await refused(root, ['--relate', '@milestone m1', 'requires', '@milestone m9'], 'IA-CLI-EDIT-MISSING');
    await refused(root, ['--set', 'work-system/definition/milestone/m9', 'work.owner=x'], 'IA-CLI-EDIT-MISSING');
    const outside = await refused(root, ['task', 't9', '--at', 'docs/task.ia'], 'IA-CLI-EDIT-UNOWNED');
    expect(outside['message']).toBe('docs/task.ia is no .ia file inside .ia/src');
    await refused(root, ['task', 't9', '--at', '.ia/src/floor/task.ia'], 'IA-CLI-EDIT-UNOWNED');
    await refused(root, ['task', 't9', '--at', '.ia/src/../task.ia'], 'IA-DB-PATH-UNSAFE');
    await refused(root, ['nosuchword', 't9'], 'IA-CLI-EDIT-INVALID');
  });
  it('refuses malformed forms as usage before reading the workspace', async () => {
    const root = workspace();
    for (const argv of [
      ['--relate', '@milestone m1', 'needs', '@milestone m2'],
      ['--relate', '@milestone m1', 'requires'],
      ['--relate', '@milestone m1', 'requires', '@milestone m2', 'extra'],
      ['--set', '@milestone m1', 'no assignment'],
      ['--set', '--relate', '@milestone m1', 'requires', '@milestone m2'],
      ['--relate', '@milestone m1', 'requires', '@milestone m2', '--at', '.ia/src/x.ia'],
      ['Task'],
      ['task', '9t'],
      ['task', 't1', 'loose'],
      ['task', 't1', 'work.title=a', 'work.title=b'],
    ]) {
      const result = await preview(root, argv);
      expect(result.exitCode, argv.join(' ')).toBe(2);
      expect(body(result)).toMatchObject({ code: 'IA-CLI-USAGE' });
    }
  });
});

describe('the mandate profile', () => {
  const MANDATE = (name: string, authority: readonly string[]) =>
    `\n@mandate ${name}\n  meaning\n    says "Fixture mandate ${name}."\n    answers "What may its participant do?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n${authority.map((line) => `    ${line}\n`).join('')}`;
  const AGENT = (name: string) =>
    `\n@agent ${name}\n  meaning\n    says "Fixture participant ${name}."\n    answers "Who is ${name}?"\n  governance\n    applies []\n`;
  const moves = (root: string, list: string) =>
    rewrite(root, '.ia/src/workspace.ia', (text) =>
      text.replace('moves [Observation, Verification, Synthesis, Delegation, Execution]', `moves [${list}]`),
    );
  it('refuses preview under a mandate without Verification, naming its governance position, while position runs', async () => {
    const root = workspace((at) => moves(at, 'Observation, Synthesis'));
    const refusal = await refused(root, ['task'], 'IA-RUNTIME-MANDATE-MOVE');
    expect(refusal['message']).toBe(
      `${mandate('demo-mandate')} allows Observation, Synthesis; validate needs Verification`,
    );
    expect(nextArgv(refusal['next'] as string)).toEqual([
      'position',
      '--seat',
      mandate('demo-mandate'),
      '--shape',
      'governance',
      '--root',
      root,
    ]);
    await refused(root, ['--set', '@milestone m1', 'work.owner=x'], 'IA-RUNTIME-MANDATE-MOVE');
    // An unadmitted record does not get past the move either, and `ia position` stays ungated.
    await refused(root, ['--set', '@milestone m9', 'work.owner=x'], 'IA-RUNTIME-MANDATE-MOVE');
    expect((await run(['position', '--root', root])).exitCode).toBe(0);
  });
  it('refuses an excluded word in every form that previews it, and no other', async () => {
    const root = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace('    scope [@workspace demo]\n', '    scope [@workspace demo]\n    excluded-words [milestone]\n'),
      ),
    );
    const refusal = await refused(root, ['milestone'], 'IA-RUNTIME-MANDATE-WORD');
    expect(refusal['message']).toBe(`${mandate('demo-mandate')} excludes milestone`);
    await refused(root, ['milestone', 'm3', 'meaning.says=x'], 'IA-RUNTIME-MANDATE-WORD');
    await refused(root, ['--set', '@milestone m1', 'work.owner=x'], 'IA-RUNTIME-MANDATE-WORD');
    await refused(root, ['--relate', '@milestone m2', 'requires', '@milestone m1'], 'IA-RUNTIME-MANDATE-WORD');
    expect((await preview(root, ['task'])).exitCode).toBe(0);
  });
  it('refuses an open actor choice, and --actor resolves it without lifting moves or excluded words', async () => {
    // Two participants and no steward: OD1 names no default actor.
    const root = workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace('    steward @agent demo\n', ''));
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation, Verification]', 'scope [@workspace demo]', 'excluded-words [task]'])}`,
      );
    });
    const ambiguous = await refused(root, ['task'], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(ambiguous['message']).toContain('its authored mandates name 2 participants');
    // The next command is this one as the first participant whose mandates allow it: demo, since ops excludes task.
    expect(nextArgv(ambiguous['next'] as string)).toEqual(['preview', 'task', '--actor', participant, '--root', root]);
    const milestone = await refused(root, ['milestone'], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(milestone['next'] as string)).toEqual([
      'preview',
      'milestone',
      '--actor',
      participant,
      '--root',
      root,
    ]);
    const chosen = body(await preview(root, ['milestone', '--actor', ops]));
    expect(chosen).toMatchObject({
      mode: 'word',
      profile: { actor: ops, by: 'actor', mandates: [mandate('demo-mandate'), mandate('ops-mandate')] },
    });
    expect(body(await preview(root, ['milestone', '--actor', '@agent ops']))).toMatchObject({
      profile: { actor: ops },
    });
    expect(body(await preview(root, ['milestone', '--actor', 'demo']))).toMatchObject({
      profile: { actor: participant },
    });
    // Naming ops never lifts its own mandate's exclusion, and a move its mandate lacks stays refused.
    expect((await refused(root, ['task', '--actor', ops], 'IA-RUNTIME-MANDATE-WORD'))['message']).toBe(
      `${mandate('ops-mandate')} excludes task`,
    );
    rewrite(root, '.ia/src/ops.ia', (text) => text.replace('moves [Observation, Verification]', 'moves [Observation]'));
    await refused(root, ['milestone', '--actor', ops], 'IA-RUNTIME-MANDATE-MOVE');
  });
  it('refuses an --actor that is not an authored participant of the workspace', async () => {
    const root = workspace();
    for (const actor of [
      '@agent reviewer',
      'agent-system/binding/agent/public-work-system-steward',
      'nobody',
      mandate('demo-mandate'),
    ]) {
      const refusal = await refused(root, ['task', '--actor', actor], 'IA-RUNTIME-MANDATE-ACTOR');
      expect(refusal['message'], actor).toContain(
        `is not an authored participant of ${demo}; its participants are ${participant}`,
      );
      expect(nextArgv(refusal['next'] as string)).toEqual(['preview', 'task', '--actor', participant, '--root', root]);
    }
  });
  it('refuses, rather than fails, under a mandate whose authority the resolver cannot read', async () => {
    const root = workspace((at) =>
      writeFileSync(
        resolve(at, '.ia/src/empty.ia'),
        `#! ia 1.0\n${MANDATE('empty-mandate', ['participant @agent demo', 'moves []', 'scope [@workspace demo]'])}`,
      ),
    );
    // Admission accepts `moves []`; the runtime's mandate reader does not (`ia validate` is gated now, so db is asked).
    const db = open(root, { cache: false });
    expect(db.report.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    db.close();
    const refusal = await refused(root, ['task'], 'IA-RUNTIME-REQUEST-INVALID');
    expect(refusal['message']).toBe(
      `The mandate profile cannot be read: ${mandate('empty-mandate')}: authority.moves must name at least one kernel move`,
    );
    expect(nextArgv(refusal['next'] as string)).toEqual([
      'position',
      '--seat',
      mandate('empty-mandate'),
      '--shape',
      'governance',
      '--root',
      root,
    ]);
  });
  it('restricts nothing where no mandate governs, and says so', async () => {
    const root = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) => text.slice(0, text.indexOf('\n@mandate demo-mandate')) + '\n'),
    );
    const view = body(await preview(root, ['task']));
    expect(view['profile']).toEqual({
      actor: participant,
      by: 'steward',
      mandates: [],
      notice: 'no authored @mandate governs here, so no move or word is restricted (a mandate only adds restrictions)',
    });
  });
});

describe('the catalog row', () => {
  it('lets ia next, on a workspace that registers @plan and authors none, name ia preview plan', async () => {
    const root = workspace((at) => rmSync(resolve(at, '.ia/src/work.ia')));
    const refusal = await run(['next', '--root', root, '--json']);
    expect(refusal.exitCode).toBe(1);
    const next = body(refusal);
    expect(next).toMatchObject({ code: 'IA-RUNTIME-NEXT-NO-PLAN' });
    expect(nextArgv(next.next!)).toEqual(['preview', 'plan', '--root', root]);
    const before = tree(root);
    const followed = await run(nextArgv(next.next!));
    expect(followed.exitCode).toBe(0);
    expect(followed.stdout).toContain('Word  plan');
    expect(tree(root)).toEqual(before);
  });
});
