import type { ReadHandle } from '@inventarch/db';
import type { InstalledOperation } from '@inventarch/db/distribution';
import type { Node } from '@inventarch/graph';
import type { CompiledValue } from '@inventarch/language';
import { fieldsAt } from './record-fields.js';

/**
 * Execution binding against the installed-implementation catalog. An `@execution-binding` names the implementation it
 * selects (`binding.implementation`), its kind and, optionally, its target; the host's catalog says which operation
 * implementations its payload actually ships. This module joins the two and nothing else: it never loads, imports,
 * serves or executes an implementation, and it reads only the records and the catalog it is given. The catalog comes
 * from the materialized host payload, read by `@inventarch/distribution`'s `readInstalledImplementations`, which
 * already checked every available operation's shipped handler bytes against their pins; this package cannot import
 * the composition system that holds the handlers (tools/dependencies/check.ts).
 *
 * Results are distinct, and only `bound` is ever a pass:
 * - `bound`: the catalog is present, lists the implementation as available (its shipped bytes matched their pins when
 *   the catalog was read), the binding is an operation binding, and its target, when it states one, resolves to an
 *   admitted record that is the operation the implementation serves.
 * - `unavailable`: there is no catalog, it does not list the implementation, it lists it as unavailable (a
 *   metadata-only declaration or missing handler bytes), the binding is of a kind no installed catalog section
 *   provides, it states a target that resolves to no admitted record (a typo is never a pass),
 *   or the implementation serves another operation. Nothing is wrong with the host; nothing is bound.
 * - `revoked`, an error: the catalog revokes the implementation, or the catalog failed verification (bytes or pins that
 *   no longer match), so the implementation it vouched for is not the one installed. A revoked binding must block,
 *   where an unavailable one is only not bound.
 */

/**
 * The catalog a binding is joined against: `present`, its operation rows as `@inventarch/db/distribution` shapes them
 * and its reader verified them against the payload (one shape for reader and binder),
 * `unavailable` (no catalog, or none this workspace joined) with the reason, or `damaged` (it failed verification)
 * with the reason.
 */
export type BindingCatalog =
  | { readonly status: 'present'; readonly operations: readonly InstalledOperation[] }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'damaged'; readonly reason: string };
/**
 * `binding.target` as a binding states it: the reference as written and the identity of the admitted record it
 * resolves to, null when none answers it. A stated target and a resolved one are kept apart, so an unresolved target
 * is never read as no target.
 */
export interface BindingTarget {
  readonly reference: string;
  readonly identity: string | null;
}
/** An `@execution-binding` as the binder reads it: its unconditional binding fields, its target resolved. */
export interface ExecutionBinding {
  readonly identity: string;
  readonly kind: string | null;
  readonly implementation: string | null;
  /** The target the binding states, resolved; null only when it states none. */
  readonly target: BindingTarget | null;
}
export type BindingStatus = 'bound' | 'unavailable' | 'revoked';
export interface BindingResult {
  readonly identity: string;
  readonly implementation: string | null;
  readonly status: BindingStatus;
  /** One line: why the binding has this result. */
  readonly reason: string;
  /** For a bound binding: the handler, its shipped bytes' SHA-256 and the descriptor version the catalog lists. */
  readonly handler?: string;
  readonly digest?: string;
  readonly version?: number;
}

/** The catalog sections a binding kind joins against; only operations have installed implementations so far. */
const OPERATION_KIND = 'operation';

/** The first unconditional value `record` states at `field` (the package's one field reader). */
const firstValue = (record: Node, field: string): CompiledValue | undefined => fieldsAt(record, field)[0]?.value;
const textOf = (value: CompiledValue | undefined): string | null =>
  value !== undefined && 'text' in value && typeof value.text === 'string' ? value.text : null;

const referenceText = (value: CompiledValue): string =>
  value.kind === 'ref'
    ? `@${value.discriminator} ${value.name}${value.fragment === undefined ? '' : `#${value.fragment}`}`
    : (textOf(value) ?? `(a ${value.kind} value)`);
/**
 * `record`'s binding fields, with a stated `binding.target` resolved through `resolve`. Without a resolver, or for a
 * value that is not a reference, a stated target resolves to nothing, so the binding cannot bind.
 */
export function executionBindingOf(
  record: Node,
  resolve: (value: Extract<CompiledValue, { kind: 'ref' }>) => string | null = () => null,
): ExecutionBinding {
  const target = firstValue(record, 'binding.target');
  return {
    identity: record.identity,
    kind: textOf(firstValue(record, 'binding.kind')),
    implementation: textOf(firstValue(record, 'binding.implementation')),
    target:
      target === undefined
        ? null
        : { reference: referenceText(target), identity: target.kind === 'ref' ? resolve(target) : null },
  };
}

/**
 * Every admitted `@execution-binding` `reader` holds, by identity, with its target resolved in the same view. It reads
 * the root view without a scope token, so a workspace with admission errors still reports the bindings admission
 * admitted. Reads only.
 */
export function executionBindings(reader: ReadHandle): readonly ExecutionBinding[] {
  return reader
    .records()
    .filter((record) => record.discriminator === 'execution-binding')
    .sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0))
    .map((record) =>
      executionBindingOf(record, (value) => {
        const resolved = reader.resolve(value);
        return resolved.ok ? resolved.identity : null;
      }),
    );
}

/** `binding` joined against `catalog` (see the module comment for what each result means). Executes nothing. */
export function bindExecution(binding: ExecutionBinding, catalog: BindingCatalog): BindingResult {
  const { identity, implementation } = binding;
  const result = (status: BindingStatus, reason: string): BindingResult => ({
    identity,
    implementation,
    status,
    reason,
  });
  if (implementation === null) return result('unavailable', 'the binding names no implementation');
  if (binding.kind !== OPERATION_KIND)
    return result(
      'unavailable',
      `the installed catalog lists operation implementations only, none of kind ${binding.kind ?? '(none stated)'}`,
    );
  if (catalog.status === 'damaged')
    return result('revoked', `the installed-implementation catalog failed verification: ${catalog.reason}`);
  if (catalog.status === 'unavailable') return result('unavailable', catalog.reason);
  const operation = catalog.operations.find((row) => row.id === implementation);
  if (operation === undefined)
    return result('unavailable', `the installed catalog lists no implementation ${implementation}`);
  if (operation.status === 'revoked')
    return result('revoked', `the installed catalog revokes ${implementation}: ${operation.reason}`);
  if (operation.status === 'unavailable')
    return result('unavailable', `${implementation} is unavailable on this host: ${operation.reason}`);
  if (binding.target !== null && binding.target.identity === null)
    return result('unavailable', `binding.target ${binding.target.reference} resolves to no admitted record`);
  if (binding.target !== null && binding.target.identity !== operation.operation)
    return result('unavailable', `${implementation} serves ${operation.operation}, not ${binding.target.identity}`);
  return {
    ...result(
      'bound',
      `${implementation} ships handler ${operation.handler} (bytes ${operation.digest.slice(0, 12)}); nothing was executed`,
    ),
    handler: operation.handler,
    digest: operation.digest,
    version: operation.version,
  };
}
