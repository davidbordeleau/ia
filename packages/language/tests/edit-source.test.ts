import { describe, expect, it } from 'vitest';
import { parse } from '../src/index.js';
import * as editor from '../src/editor/index.js';

const schema = {
  sections: [{ name: 'meaning', must: true }, { name: 'work', must: true }],
  fields: [
    { section: 'meaning', key: 'says', type: 'text' as const, must: true },
    { section: 'work', key: 'status', type: 'id' as const, must: true, values: ['open', 'closed'] },
    { section: 'work', key: 'peers', type: 'list of ref' as const, must: false, target: 'task' },
  ],
};
const source = '#! ia 1.0\n\n@task one\n  meaning\n    says "First"\n  work\n    status open\n    peers [@task two]\n\n# keep this comment\n@task two\n  meaning\n    says "Second"\n  work\n    status open\n';

describe('schema-aware source edits', () => {
  it('appends one record, retaining the pragma and existing records', () => {
    const draft = editor.draftSource('task', 'three', schema, { 'meaning/says': 'Third', 'work/status': 'open' });
    const result = editor.appendRecord(source, draft);
    expect(result.match(/#! ia/g)).toHaveLength(1);
    expect(parse(result, 'x.ia').ast.records.map(r => r.name)).toEqual(['one', 'two', 'three']);
    expect(result).toContain('# keep this comment');
  });
  it('sets and appends typed values without changing a sibling record', () => {
    const set = editor.setField(source, '@task one', 'meaning.says', 'A "quote" and \\path', schema);
    const appended = editor.setField(set, '@task one', 'work.peers', '@task three', schema, true);
    expect(parse(appended, 'x.ia').diagnostics).toEqual([]);
    expect(appended.slice(appended.indexOf('@task two\n'))).toBe(source.slice(source.indexOf('@task two\n')));
    expect(appended).toContain('peers [@task two, @task three]');
    expect(() => editor.setField(appended, '@task one', 'work.peers', '@task three', schema, true)).toThrow('Duplicate');
  });
  it('inserts a relationship in the selected record and rejects duplicate rows and injection', () => {
    const related = editor.addRelationship(source, '@task one', 'requires', '@task two');
    expect(related).toContain('  relationships\n    requires @task two');
    expect(() => editor.addRelationship(related, '@task one', 'requires', '@task two')).toThrow('Duplicate');
    for (const target of ['@task two\n@task injected', '@task two #hidden', '@task two when phase act'])
      expect(() => editor.addRelationship(source, '@task one', 'requires', target)).toThrow();
  });
  it('refuses unknown fields, narrowed types, structural injection, scalar appends and repeated field keys', () => {
    for (const [path, value, append] of [
      ['work.foreign', 'x', false], ['work.status', 'alien', false],
      ['work.status', 'open # hidden', false], ['work.status', 'open\n@task injected', false],
      ['work.status', 'open', true], ['work.peers', '[@task two, @agent wrong]', false],
    ] as const) expect(() => editor.setField(source, '@task one', path, value, schema, append)).toThrow();
    expect(() => editor.setField(source.replace('status open', 'status open\n    status closed'), '@task one', 'work.status', 'open', schema)).toThrow('Repeated');
    expect(() => editor.draftSource('task', 'bad', schema, { 'work/status': 'open when phase act' })).toThrow();
  });
});
