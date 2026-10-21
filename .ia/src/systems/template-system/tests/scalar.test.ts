import type { CompiledRecord } from '@inventarch/language';
import { expect, it } from 'vitest';
import { renderScalarTemplate } from '../src/index.js';

const text = (value: string) => ({ kind: 'text', text: value });
const list = (...items: string[]) => ({ kind: 'list', items: items.map(text) });
const record = (fields: Record<string, unknown>): CompiledRecord =>
  ({
    discriminator: 'template',
    sections: [{ name: 'template', fields: Object.entries(fields).map(([key, value]) => ({ key, value })) }],
  }) as unknown as CompiledRecord;

it('renders a scalar template that declares its parameters and lines', () => {
  const note = record({ filename: text('notes/{{name}}.md'), parameters: list('name'), lines: list('# {{name}}') });
  expect(renderScalarTemplate(note, { name: 'note' })).toEqual({ path: 'notes/note.md', text: '# note' });
});

it('refuses a scalar template that omits the parameters or lines the schema leaves optional', () => {
  for (const fields of [
    { filename: text('notes/note.md'), lines: list('# note') },
    { filename: text('notes/note.md'), parameters: list('name') },
  ])
    expect(() => renderScalarTemplate(record(fields), {})).toThrow(
      expect.objectContaining({ code: 'IA-EXEC-TEMPLATE-INVALID' }),
    );
});
