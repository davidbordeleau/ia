/**
 * `ia author` and the mandate profile on every gated mode (milestone generation-binding plan amendments C1, C3, C19 and
 * C20; continuation lane C; review claude-v1 B2), on an `ia init` workspace with the CLI composition fixture laid over
 * it and a small plan authored. A successful author writes exactly the candidate its preview showed, with one
 * attribution comment, and moves no other record's digest; every refusal writes nothing, and its next command runs in
 * the state that refused.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { open } from '@inventarch/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Result } from '../src/consumer.js';
import { cleanup, cli, nextArgv, run, scratch } from './workspace-fixture.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });
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
  milestone = (name: string) => `work-system/definition/milestone/${name}`,
  EMPTY = createHash('sha256').update('').digest('hex');
const MANDATE = (name: string, authority: readonly string[]) =>
  `\n@mandate ${name}\n  meaning\n    says "Fixture mandate ${name}."\n    answers "What may its participant do?"\n  governance\n    requires "Claim no host permission or execution from this mandate."\n  authority\n${authority.map((line) => `    ${line}\n`).join('')}`;
const AGENT = (name: string) =>
  `\n@agent ${name}\n  meaning\n    says "Fixture participant ${name}."\n    answers "Who is ${name}?"\n  governance\n    applies []\n`;

let base = '';
beforeAll(async () => {
  base = resolve(scratch('author-base'), 'demo');
  const init = await run(['init', base, '--apply', '--yes', '--host', 'none', '--json']);
  expect(init.exitCode, init.stdout).toBe(0);
  cpSync(resolve(cli, 'tests/fixtures/composition-workspace'), base, { recursive: true });
  writeFileSync(resolve(base, '.ia/src/work.ia'), WORK);
});
function workspace(edit: (root: string) => void = () => {}): string {
  const root = resolve(scratch('author'), 'demo');
  cpSync(base, root, { recursive: true });
  edit(root);
  return root;
}
const rewrite = (root: string, path: string, change: (text: string) => string): void =>
  writeFileSync(resolve(root, path), change(readFileSync(resolve(root, path), 'utf8')));
const moves = (root: string, list: string): void =>
  rewrite(root, '.ia/src/workspace.ia', (text) =>
    text.replace('moves [Observation, Verification, Synthesis, Delegation, Execution]', `moves [${list}]`),
  );
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
/** Every admitted record's digest, read by a db handle of its own. */
function digests(root: string): ReadonlyMap<string, string> {
  const db = open(root, { cache: false });
  try {
    return new Map(db.records().map((node) => [node.identity, node.digest]));
  } finally {
    db.close();
  }
}
const body = (result: Result) => JSON.parse(result.stdout) as Record<string, unknown> & { readonly next?: string };
const ia = (root: string, argv: readonly string[]): Promise<Result> =>
  run([...argv, '--root', root, '--json'], { env: HOMES });
/** The IA homes every command here runs with (review C-N6), so a write to either is seen. */
const HOMES = { IA_HOST_HOME: scratch('author-host-home'), IA_CONFIG_HOME: scratch('author-config-home') };
const trees = (root: string) => ({
  root: tree(root),
  host: tree(HOMES.IA_HOST_HOME),
  config: tree(HOMES.IA_CONFIG_HOME),
});
/** One command that must write nothing, whatever it returns. */
async function unchanged(root: string, argv: readonly string[]): Promise<Result> {
  const before = trees(root);
  const result = await ia(root, argv);
  expect(trees(root), `ia ${argv.join(' ')} wrote`).toEqual(before);
  return result;
}
/**
 * A refusal that writes nothing, its code, and (unless `follow` is false) its next command run in the same state:
 * that command refuses nothing of its own (a preview whose candidate has findings is a verdict, at exit 1 with nothing
 * on stderr) and writes nothing unless it is itself an author form.
 */
async function refused(
  root: string,
  argv: readonly string[],
  code: string,
  follow = true,
): Promise<Record<string, unknown>> {
  const result = await unchanged(root, argv);
  expect(result.exitCode, result.stdout).not.toBe(0);
  const refusal = body(result);
  expect(refusal, argv.join(' ')).toMatchObject({ ok: false, code });
  if (!follow) return refusal;
  const next = nextArgv(refusal.next!);
  expect(next, refusal.next).toContain('--root');
  const before = tree(root);
  const followed = await run(next, { env: HOMES });
  expect(followed.stderr, refusal.next).toBe('');
  expect(followed.exitCode, `${refusal.next}\n${followed.stdout}`).toBeLessThanOrEqual(1);
  if (next[0] !== 'author') expect(tree(root), refusal.next).toEqual(before);
  return refusal;
}
/** The digest `ia preview` prints for a form, asserting the candidate is clean. */
async function previewed(root: string, argv: readonly string[]): Promise<string> {
  const result = await ia(root, ['preview', ...argv]);
  expect(result.exitCode, result.stdout).toBe(0);
  return body(result)['digest'] as string;
}
/** An author form after its preview: the result, and the admitted digests before and after. */
async function authored(root: string, argv: readonly string[], extra: readonly string[] = []) {
  const digest = await previewed(root, [...argv, ...extra]);
  const before = digests(root);
  const result = await ia(root, ['author', ...argv, ...extra, '--digest', digest]);
  expect(result.exitCode, result.stdout).toBe(0);
  return { view: body(result), before, after: digests(root), digest };
}
/** Of every admitted record, only `changed` may differ, appear or vanish. */
const onlyChanged = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): readonly string[] =>
  [...new Set([...before.keys(), ...after.keys()])].filter((id) => before.get(id) !== after.get(id)).sort();

describe('ia author', () => {
  it('writes one relationship row with its attribution, and the workspace still validates', async () => {
    const root = workspace();
    const work = readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8');
    const db = open(root, { cache: false }),
      authoredRevision = db.authoredRevision;
    db.close();
    const { view, before, after, digest } = await authored(root, [
      '--relate',
      '@milestone m2',
      'requires',
      '@milestone m1',
    ]);
    expect(onlyChanged(before, after)).toEqual([milestone('m2')]);
    const written = readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8');
    const attribution = `# authored-by @agent demo under @mandate demo-mandate at ${view['authoredRevision']}`;
    expect(view).toMatchObject({
      mode: 'relate',
      path: '.ia/src/work.ia',
      created: false,
      previousDigest: digest,
      digest: createHash('sha256').update(written).digest('hex'),
      identity: milestone('m2'),
      attribution,
      profile: { actor: participant, grantedBy: mandate('demo-mandate') },
    });
    // The file gains the attribution line and the relationships section, and nothing else.
    expect(written).toBe(
      work.replace('\n@milestone m2\n', `\n${attribution}\n@milestone m2\n`) +
        '  relationships\n    requires @milestone m1\n',
    );
    // The attribution names the authored revision the candidate was compiled against (db's, not the full revision).
    expect(view['authoredRevision']).toBe(authoredRevision);
    expect((await ia(root, ['validate'])).exitCode).toBe(0);
    // A second author replaces the attribution rather than stacking another.
    await authored(root, ['--set', '@milestone m2', 'work.owner=Tom']);
    expect(readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8').match(/# authored-by/g)).toHaveLength(1);
  });
  it('sets one field and appends one new record, moving no other digest', async () => {
    const root = workspace();
    const set = await authored(root, ['--set', '@milestone m1', 'work.owner=Tom Crown']);
    expect(onlyChanged(set.before, set.after)).toEqual([milestone('m1')]);
    expect(set.view['record']).toContain('    owner "Tom Crown"');
    const created = await authored(root, [
      'task',
      't1',
      'meaning.says=The first task',
      'work.title=First task',
      'work.status=open',
      'work.milestone=@milestone m1',
    ]);
    expect(created.digest).toBe(EMPTY);
    expect(created.view).toMatchObject({
      created: true,
      path: '.ia/src/task.ia',
      identity: 'work-system/definition/task/t1',
    });
    expect(onlyChanged(created.before, created.after)).toEqual(['work-system/definition/task/t1']);
    expect(readFileSync(resolve(root, '.ia/src/task.ia'), 'utf8')).toMatch(
      /^#! ia 1\.0\n\n# authored-by @agent demo under @mandate demo-mandate at [0-9a-f]{64}\n@task t1\n/,
    );
    expect((await ia(root, ['validate'])).exitCode).toBe(0);
  });
  it('writes an edit beside an error already in another record of the file (review C-R4)', async () => {
    const root = workspace((at) =>
      rewrite(
        at,
        '.ia/src/work.ia',
        (text) =>
          `${text}\n@milestone m4\n  meaning\n    says "No exit."\n  work\n    title "Fourth"\n    status open\n    plan @plan p1\n`,
      ),
    );
    const { before, after } = await authored(root, ['--set', '@milestone m1', 'work.owner=Tom']);
    expect(onlyChanged(before, after)).toEqual([milestone('m1')]);
  });
  it('writes a starter system, whose next command composes it into the workspace', async () => {
    const root = workspace();
    const guidance = body(await ia(root, ['preview', 'system']));
    expect(guidance).toMatchObject({ word: 'system', system: 'floor', template: '.ia/src/systems/<name>/system.ia' });
    expect((guidance['schema'] as { fields: { path: string }[] }).fields.map((field) => field.path)).toEqual([
      'head.provider',
      'head.version',
      'head.steward',
      'head.describes',
    ]);
    expect(body(await ia(root, ['preview', 'schema']))).toMatchObject({ word: 'schema', system: 'floor' });
    const before = digests(root);
    const result = await ia(root, ['author', 'system', 'notes']);
    expect(result.exitCode, result.stdout).toBe(0);
    const view = body(result);
    expect(view).toMatchObject({
      created: true,
      path: '.ia/src/systems/notes/system.ia',
      identity: 'floor/definition/system/notes',
    });
    expect(onlyChanged(before, digests(root))).toEqual([
      'agent-system/binding/agent/notes-steward',
      'floor/definition/system/notes',
    ]);
    const next = nextArgv(view['next'] as string);
    expect(next.slice(0, 4)).toEqual(['author', '--set', demo, 'composition.systems+=@system notes']);
    const composed = await run([...next, '--json']);
    expect(composed.exitCode, composed.stdout).toBe(0);
    expect(readFileSync(resolve(root, '.ia/src/workspace.ia'), 'utf8')).toContain(
      '@system workspace-system, @system notes]',
    );
    expect((await ia(root, ['validate'])).exitCode).toBe(0);
    // The file now exists, so a second one refuses.
    await refused(root, ['author', 'system', 'notes'], 'IA-CLI-EDIT-INVALID');
  });
});

describe('ia author refusals, each writing nothing', () => {
  it('refuses a missing, malformed or stale digest, naming the preview that prints the current one', async () => {
    const root = workspace();
    const form = ['--set', '@milestone m1', 'work.owner=Tom'];
    const missing = await refused(root, ['author', ...form], 'IA-CLI-USAGE');
    expect(nextArgv(missing['next'] as string)).toEqual([
      'preview',
      '@milestone m1',
      'work.owner=Tom',
      '--set',
      '--root',
      root,
    ]);
    await refused(root, ['author', ...form, '--digest', 'abc'], 'IA-CLI-USAGE');
    const digest = await previewed(root, form);
    rewrite(root, '.ia/src/work.ia', (text) =>
      text.replace('says "The second milestone."', 'says "Edited after the preview."'),
    );
    const stale = await refused(root, ['author', ...form, '--digest', digest], 'IA-CLI-EDIT-STALE');
    expect(stale['message']).toContain('is not the file the preview named');
    // A new file that appeared after its preview is stale too.
    const draft = ['task', 't1', 'meaning.says=x', 'work.title=x', 'work.status=open', 'work.milestone=@milestone m1'];
    const empty = await previewed(root, draft);
    writeFileSync(resolve(root, '.ia/src/task.ia'), '#! ia 1.0\n');
    await refused(root, ['author', ...draft, '--digest', empty], 'IA-CLI-EDIT-STALE');
  });
  it('refuses a source replaced by a link or junction between the preview and the author', async () => {
    const root = workspace((at) => {
      mkdirSync(resolve(at, '.ia/src/notes'));
      writeFileSync(
        resolve(at, '.ia/src/notes/notes.ia'),
        '#! ia 1.0\n\n@milestone m3\n  meaning\n    says "Third."\n  work\n    title "Third"\n    status open\n    plan @plan p1\n    exit "Done."\n',
      );
    });
    const form = ['--set', '@milestone m3', 'work.owner=Tom'];
    const digest = await previewed(root, form);
    const moved = resolve(scratch('author-moved'), 'notes');
    renameSync(resolve(root, '.ia/src/notes'), moved);
    symlinkSync(moved, resolve(root, '.ia/src/notes'), 'junction');
    const outside = tree(moved);
    // The db refuses to read a source through the junction, so nothing is compiled or written; its next asks for the
    // link to go first, a step the CLI cannot take.
    const linked = await refused(root, ['author', ...form, '--digest', digest], 'IA-DB-PATH-UNSAFE', false);
    expect(linked['next']).toContain('Replace or remove the source path named above');
    expect(tree(moved)).toEqual(outside);
    // A file link, where this host grants one.
    rmSync(resolve(root, '.ia/src/notes'));
    renameSync(moved, resolve(root, '.ia/src/notes'));
    const target = resolve(root, '.ia/src/notes/notes.ia'),
      elsewhere = resolve(scratch('author-file'), 'notes.ia');
    renameSync(target, elsewhere);
    try {
      symlinkSync(elsewhere, target, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      return;
    }
    await refused(root, ['author', ...form, '--digest', digest], 'IA-DB-PATH-UNSAFE', false);
  });
  it('refuses an unowned target, an unconsented relation, a type mismatch and an unclean candidate', async () => {
    const root = workspace();
    const fake = 'a'.repeat(64);
    await refused(
      root,
      [
        'author',
        '--set',
        'agent-system/binding/agent/public-work-system-steward',
        'meaning.says=Mine',
        '--digest',
        fake,
      ],
      'IA-CLI-EDIT-UNOWNED',
    );
    await refused(
      root,
      ['author', 'task', 't9', 'meaning.says=x', '--at', 'docs/task.ia', '--digest', EMPTY],
      'IA-CLI-EDIT-UNOWNED',
    );
    // Another spelling of an existing source is judged as the volume spells it (review C-R1), on a volume that folds case.
    if (existsSync(resolve(root, '.IA/SRC'))) {
      const digest = createHash('sha256')
        .update(readFileSync(resolve(root, '.ia/src/work.ia')))
        .digest('hex');
      const alias = await refused(
        root,
        ['author', 'milestone', 'm3', 'meaning.says=x', '--at', '.ia/src/WORK.ia', '--digest', digest],
        'IA-DB-PATH-UNSAFE',
      );
      expect(nextArgv(alias['next'] as string)).toContain('.ia/src/work.ia');
    }
    await refused(
      root,
      ['author', '--relate', '@milestone m1', 'requires', '@plan p1', '--digest', fake],
      'IA-LANG-EDGE-UNCONSENTED',
    );
    await refused(
      root,
      ['author', '--set', '@milestone m1', 'work.status=alien', '--digest', fake],
      'IA-CLI-EDIT-INVALID',
    );
    // A candidate with errors (a new task missing its required fields) refuses, naming the preview that lists them.
    const unclean = await refused(
      root,
      ['author', 'task', 't9', 'milestone=@milestone', 'm1', '--digest', EMPTY],
      'IA-CLI-EDIT-UNCLEAN',
    );
    expect(unclean['message']).toContain('IA-COMP-FIELD-MISSING');
    expect(nextArgv(unclean['next'] as string)[0]).toBe('preview');
  });
  it('refuses a move outside the mandate and an excluded word', async () => {
    const root = workspace((at) => moves(at, 'Observation, Verification'));
    const form = ['--set', '@milestone m1', 'work.owner=Tom'];
    const digest = await previewed(root, form);
    const move = await refused(root, ['author', ...form, '--digest', digest], 'IA-RUNTIME-MANDATE-MOVE');
    expect(move['message']).toBe(`${mandate('demo-mandate')} allows Observation, Verification; author needs Synthesis`);
    const excluded = workspace((at) =>
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace(
          '    scope [@workspace demo]\n',
          '    scope [@workspace demo]\n    excluded-words [milestone, system]\n',
        ),
      ),
    );
    await refused(excluded, ['author', ...form, '--digest', digest], 'IA-RUNTIME-MANDATE-WORD');
    await refused(excluded, ['author', 'system', 'notes'], 'IA-RUNTIME-MANDATE-WORD');
  });
});

describe('the mandate profile on every gated mode', () => {
  it('refuses each gated mode its mandate does not grant, naming a position that runs, and never gates position', async () => {
    const root = workspace((at) => moves(at, 'Delegation'));
    const fake = 'a'.repeat(64);
    for (const [argv, mode, move] of [
      [['read', participant], 'read', 'Observation'],
      [['next'], 'read', 'Observation'],
      [['validate'], 'validate', 'Verification'],
      [['preview', 'task'], 'validate', 'Verification'],
      [['author', '--set', '@milestone m1', 'work.owner=x', '--digest', fake], 'author', 'Synthesis'],
      [['capture'], 'effect', 'Execution'],
      [['capture', '--preview'], 'effect', 'Execution'],
      [['compile'], 'effect', 'Execution'],
      [['project', 'claude'], 'effect', 'Execution'],
    ] as const) {
      const refusal = await refused(root, argv, 'IA-RUNTIME-MANDATE-MOVE');
      expect(refusal['message'], argv.join(' ')).toBe(
        `${mandate('demo-mandate')} allows Delegation; ${mode} needs ${move}`,
      );
      expect(nextArgv(refusal['next'] as string), argv.join(' ')).toEqual([
        'position',
        '--seat',
        mandate('demo-mandate'),
        '--shape',
        'governance',
        '--root',
        root,
      ]);
    }
    expect((await ia(root, ['position'])).exitCode).toBe(0);
    expect((await ia(root, ['position', '--seat', mandate('demo-mandate'), '--shape', 'governance'])).exitCode).toBe(0);
  });
  it("lets ia next name ia preview plan only when the actor's profile allows Verification", async () => {
    const noPlan = (list: string) =>
      workspace((at) => {
        rmSync(resolve(at, '.ia/src/work.ia'));
        moves(at, list);
      });
    const allowed = noPlan('Observation, Verification');
    const named = body(await unchanged(allowed, ['next']));
    expect(nextArgv(named.next!)).toEqual(['preview', 'plan', '--root', allowed]);
    const readOnly = noPlan('Observation');
    const refusal = await refused(readOnly, ['next'], 'IA-RUNTIME-NEXT-NO-PLAN');
    expect(nextArgv(refusal['next'] as string)).toEqual([
      'position',
      '--seat',
      mandate('demo-mandate'),
      '--shape',
      'governance',
      '--root',
      readOnly,
    ]);
    expect(refusal['next']).toContain('preview needs Verification and @plan');
    // Review C-R6: an excluded @plan is no command the profile allows either.
    const excluded = workspace((at) => {
      rmSync(resolve(at, '.ia/src/work.ia'));
      rewrite(at, '.ia/src/workspace.ia', (text) =>
        text.replace('    scope [@workspace demo]\n', '    scope [@workspace demo]\n    excluded-words [plan]\n'),
      );
    });
    const word = await refused(excluded, ['next'], 'IA-RUNTIME-NEXT-NO-PLAN');
    expect(nextArgv(word['next'] as string)[0]).toBe('position');
    // Under an open actor choice, the named actor's preview carries --actor.
    const open = workspace((at) => {
      rmSync(resolve(at, '.ia/src/work.ia'));
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace('    steward @agent demo\n', ''));
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation]', 'scope [@workspace demo]'])}`,
      );
    });
    const actor = await refused(open, ['next', '--actor', participant], 'IA-RUNTIME-NEXT-NO-PLAN');
    expect(nextArgv(actor['next'] as string)).toEqual(['preview', 'plan', '--root', open, '--actor', participant]);
    // ops may read but not preview: its next names no preview.
    const ops = await refused(open, ['next', '--actor', 'agent-system/binding/agent/ops'], 'IA-RUNTIME-NEXT-NO-PLAN');
    expect(nextArgv(ops['next'] as string)[0]).toBe('position');
  });
  it('keeps CRLF line endings and a byte-order mark in what it writes (review C-R8)', async () => {
    const bom = String.fromCharCode(0xfeff);
    for (const [label, encode] of [
      ['CRLF', (text: string) => text.replaceAll('\n', '\r\n')],
      ['BOM', (text: string) => `${bom}${text}`],
    ] as const) {
      const root = workspace((at) => rewrite(at, '.ia/src/work.ia', encode));
      const original = readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8');
      const { before, after } = await authored(root, ['--set', '@milestone m2', 'work.owner=Tom']);
      expect(onlyChanged(before, after), label).toEqual([milestone('m2')]);
      const written = readFileSync(resolve(root, '.ia/src/work.ia'), 'utf8');
      // Everything before the attribution of m2 is the file's own bytes.
      expect(written.slice(0, written.indexOf('# authored-by')), label).toBe(
        original.slice(0, original.indexOf('@milestone m2')),
      );
      if (label === 'CRLF') expect(/[^\r]\n/.test(written), label).toBe(false);
      else expect(written.startsWith(bom), label).toBe(true);
      expect((await ia(root, ['validate'])).exitCode, label).toBe(0);
    }
  });
  it('resolves an open actor choice with --actor on every gated mode, carrying it into the next command', async () => {
    const root = workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace('    steward @agent demo\n', ''));
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation]', 'scope [@workspace demo]'])}`,
      );
    });
    for (const argv of [
      ['read', participant],
      ['next'],
      ['validate'],
      ['capture', '--preview'],
      ['project', 'claude'],
    ]) {
      const ambiguous = await refused(root, argv, 'IA-RUNTIME-MANDATE-ACTOR');
      expect(nextArgv(ambiguous['next'] as string), argv.join(' ')).toContain('--actor');
      expect((await ia(root, [...argv, '--actor', participant])).exitCode, argv.join(' ')).toBe(0);
    }
    // ops may read but not validate: naming it lifts no move.
    expect((await ia(root, ['read', participant, '--actor', ops])).exitCode).toBe(0);
    await refused(root, ['validate', '--actor', ops], 'IA-RUNTIME-MANDATE-MOVE');
    // A non-participant refuses on every gated mode.
    await refused(root, ['validate', '--actor', '@agent reviewer'], 'IA-RUNTIME-MANDATE-ACTOR');
    await refused(root, ['next', '--actor', 'nobody'], 'IA-RUNTIME-MANDATE-ACTOR');
    // A refusal raised after the profile names a gated command with the actor this invocation named.
    const seat = await refused(
      root,
      ['next', '--seat', milestone('m9'), '--actor', participant],
      'IA-RUNTIME-NEXT-SEAT',
    );
    expect(nextArgv(seat['next'] as string)).toContain('--actor');
  });
  it('lets an ambiguous workspace name its steward with --actor and the preview digest, then run without one', async () => {
    const root = workspace((at) => {
      rewrite(at, '.ia/src/workspace.ia', (text) => text.replace('    steward @agent demo\n', ''));
      writeFileSync(
        resolve(at, '.ia/src/ops.ia'),
        `#! ia 1.0\n${AGENT('ops')}${MANDATE('ops-mandate', ['participant @agent ops', 'moves [Observation, Verification]', 'scope [@workspace demo]'])}`,
      );
    });
    const form = ['--set', `@workspace demo`, 'composition.steward=@agent demo'];
    // The preview refuses the open choice and names itself with the first participant allowed to run it.
    const ambiguous = await refused(root, ['preview', ...form], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(ambiguous['next'] as string)).toEqual([
      'preview',
      '@workspace demo',
      'composition.steward=@agent demo',
      '--set',
      '--actor',
      participant,
      '--root',
      root,
    ]);
    const digest = await previewed(root, [...form, '--actor', participant]);
    // The author without --actor refuses the same way, and its next command is the author naming demo, which writes.
    const author = await refused(root, ['author', ...form, '--digest', digest], 'IA-RUNTIME-MANDATE-ACTOR');
    expect(nextArgv(author['next'] as string)).toContain('--actor');
    expect(readFileSync(resolve(root, '.ia/src/workspace.ia'), 'utf8')).toContain('    steward @agent demo\n');
    // The workspace names its steward now, so commands resolve the default actor again.
    expect((await ia(root, ['validate'])).exitCode).toBe(0);
    expect(body(await ia(root, ['preview', 'task']))).toMatchObject({ profile: { actor: participant, by: 'steward' } });
  });
  it('refuses every gated mode, rather than failing, under a mandate whose authority the resolver cannot read', async () => {
    const root = workspace((at) =>
      writeFileSync(
        resolve(at, '.ia/src/empty.ia'),
        `#! ia 1.0\n${MANDATE('empty-mandate', ['participant @agent demo', 'moves []', 'scope [@workspace demo]'])}`,
      ),
    );
    for (const argv of [['read', participant], ['validate'], ['next'], ['capture'], ['project', 'claude']]) {
      const refusal = await refused(root, argv, 'IA-RUNTIME-REQUEST-INVALID');
      expect(nextArgv(refusal['next'] as string), argv.join(' ')).toEqual([
        'position',
        '--seat',
        mandate('empty-mandate'),
        '--shape',
        'governance',
        '--root',
        root,
      ]);
    }
  });
});
