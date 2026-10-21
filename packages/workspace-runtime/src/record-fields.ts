import type { CompiledField, CompiledRecord } from '@inventarch/language';
import { fieldsAt, stated, textsAt, valuesAt } from '@inventarch/runtime/internal/packet';

/**
 * Readers over a compiled record's unconditional fields, one copy shared by the host generators and the execution
 * binder. `fieldsAt`, `valuesAt`, `textsAt` and `stated` are runtime's own (packet.ts on `./internal/packet`, the
 * readers the position packet reads records with); `fieldsOf` reads a whole section the same way. A field under a
 * `when` condition is never read: these say what a record states whatever the phase.
 */
export { fieldsAt, stated, textsAt, valuesAt };
/** The unconditional fields of `record`'s `section`, in authored order. */
export const fieldsOf = (record: CompiledRecord, section: string): readonly CompiledField[] =>
  record.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields)
    .filter((f): f is CompiledField => 'key' in f && f.when === undefined);
