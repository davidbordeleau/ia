import { expect, it } from 'vitest';
import { open } from '@inventarch/db';
import type { Node } from '@inventarch/graph';
import { resolve } from 'node:path';
import { bindExecution } from '../src/bind.js';

const reader = open(resolve(import.meta.dirname, '../../../examples/conformance/native'), { cache: false });
// This fixture lives as a source tree; explicitly select its authored sources through an editor-free corpus instead.
reader.close();
const binding = (implementation: string, kind = 'operation') => ({
  discriminator: 'execution-binding', identity: 'agent-composition-system/binding/execution-binding/probe',
  sections: [{ name: 'binding', fields: [
    { key: 'implementation', value: { kind: 'scalar', text: implementation } },
    { key: 'kind', value: { kind: 'scalar', text: kind } },
  ] }],
}) as unknown as Node;
const operation = { id: 'captured-source-read-v1', version: 1, digest: 'a'.repeat(64), handler: 'ia.captured-source.read.v1', input: 'read-input', output: 'read-output' };
it('binds a declared operation without executing it, and never passes a missing implementation', () => {
  expect(bindExecution(binding(operation.id), { operations: [operation] })).toMatchObject({ status: 'bound', implementation: operation.id });
  expect(bindExecution(binding('missing-v1'), { operations: [operation] })).toMatchObject({ status: 'unavailable' });
  expect(bindExecution(binding(operation.id, 'hook'), { operations: [operation] })).toMatchObject({ status: 'unavailable' });
});
it('reports unavailable and revoked installed descriptions distinctly', () => {
  for (const status of ['unavailable', 'revoked'] as const)
    expect(bindExecution(binding(operation.id), { operations: [{ ...operation, availability: { status, reason: 'withdrawn' } }] }))
      .toMatchObject({ status, message: expect.stringContaining('withdrawn') });
});
