// Task execution-binding-host-entry (plan amendments C16 and C24): an `@execution-binding` joined against the installed
// catalog's operation rows. Only an available, shipped implementation of the binding's own operation is bound; nothing
// is ever executed.
import { resolve } from 'node:path';
import { open } from '@inventarch/db';
import { afterAll, expect, it } from 'vitest';
import { bindExecution, executionBindings } from '../src/bind.js';
import type { InstalledOperation } from '@inventarch/db/distribution';
import type { BindingCatalog, ExecutionBinding } from '../src/bind.js';

const READ = 'authoring-system/binding/operation/read-captured-source';
const available: InstalledOperation = {
  id: 'captured-source-read-v1',
  status: 'available',
  version: 1,
  operation: READ,
  handler: 'ia.captured-source.read.v1',
  input: 'captured-source-read-input-v1',
  output: 'captured-source-read-output-v1',
  module: 'runtime/node_modules/@inventarch/agent-composition-system/dist/installed-read.js',
  digest: 'c'.repeat(64),
  packages: ['@inventarch/agent-composition-system'],
};
const present = (...operations: InstalledOperation[]): BindingCatalog => ({ status: 'present', operations });
const binding = (fields: Partial<ExecutionBinding> = {}): ExecutionBinding => ({
  identity: 'agent-composition-system/binding/execution-binding/probe',
  kind: 'operation',
  implementation: 'captured-source-read-v1',
  target: READ,
  ...fields,
});

it('binds an available shipped implementation of the binding’s own operation, and executes nothing', () => {
  expect(bindExecution(binding(), present(available))).toEqual({
    identity: 'agent-composition-system/binding/execution-binding/probe',
    implementation: 'captured-source-read-v1',
    status: 'bound',
    reason: `captured-source-read-v1 ships handler ia.captured-source.read.v1 (bytes ${'c'.repeat(12)}); nothing was executed`,
    handler: 'ia.captured-source.read.v1',
    digest: 'c'.repeat(64),
    version: 1,
  });
  // A binding that names no target binds the implementation the catalog lists under its id.
  expect(bindExecution(binding({ target: null }), present(available)).status).toBe('bound');
});

it('reports every binding without a bound implementation as unavailable, never as bound', () => {
  const cases: [ExecutionBinding, BindingCatalog, string][] = [
    [binding({ implementation: 'missing-read-v1' }), present(available), 'lists no implementation missing-read-v1'],
    // A metadata-only declaration and missing handler bytes both reach the binder as an unavailable row.
    [
      binding(),
      present({
        id: 'captured-source-read-v1',
        status: 'unavailable',
        reason: 'its handler module is not in the inventory',
      }),
      'unavailable on this host: its handler module is not in the inventory',
    ],
    [binding(), { status: 'unavailable', reason: 'no host has joined a catalog' }, 'no host has joined a catalog'],
    [binding({ kind: 'entry' }), present(available), 'none of kind entry'],
    [binding({ kind: null }), present(available), 'none of kind (none stated)'],
    [binding({ implementation: null }), present(available), 'names no implementation'],
    [
      binding({ target: 'acme/binding/operation/other' }),
      present(available),
      `serves ${READ}, not acme/binding/operation/other`,
    ],
  ];
  for (const [subject, catalog, reason] of cases)
    expect(bindExecution(subject, catalog)).toEqual({
      identity: subject.identity,
      implementation: subject.implementation,
      status: 'unavailable',
      reason: expect.stringContaining(reason),
    });
});

it('reports a revoked implementation and a catalog that failed verification as revoked, distinctly', () => {
  expect(
    bindExecution(
      binding(),
      present({ id: 'captured-source-read-v1', status: 'revoked', reason: 'withdrawn by its producer' }),
    ),
  ).toMatchObject({
    status: 'revoked',
    reason: 'the installed catalog revokes captured-source-read-v1: withdrawn by its producer',
  });
  expect(
    bindExecution(binding(), { status: 'damaged', reason: 'IA-DIST-INTEGRITY-MISMATCH: Shipped handler bytes differ' }),
  ).toMatchObject({
    status: 'revoked',
    reason: expect.stringContaining('failed verification: IA-DIST-INTEGRITY-MISMATCH'),
  });
  // The kind decides first: a binding no catalog section provides is unavailable, not revoked, even then.
  expect(bindExecution(binding({ kind: 'entry' }), { status: 'damaged', reason: 'x' }).status).toBe('unavailable');
});

const repository = resolve(import.meta.dirname, '../../..'),
  reader = open(repository, { cache: false });
afterAll(() => reader.close());
it('reads the repository’s execution bindings with their targets resolved, and binds the read adapter’s', () => {
  const bindings = executionBindings(reader);
  expect(bindings).toEqual(
    expect.arrayContaining([
      {
        identity: 'agent-composition-system/binding/execution-binding/read-captured-source-binding',
        kind: 'operation',
        implementation: 'captured-source-read-v1',
        target: READ,
      },
      expect.objectContaining({
        identity: 'agent-composition-system/binding/execution-binding/example-entry',
        kind: 'entry',
        implementation: 'example-entry-v1',
      }),
    ]),
  );
  expect(bindings.map((row) => row.identity)).toEqual([...bindings.map((row) => row.identity)].sort());
  const read = bindings.find((row) => row.implementation === 'captured-source-read-v1')!;
  expect(bindExecution(read, present(available)).status).toBe('bound');
  expect(bindExecution(read, present({ ...available, operation: 'acme/binding/operation/other' })).status).toBe(
    'unavailable',
  );
});
