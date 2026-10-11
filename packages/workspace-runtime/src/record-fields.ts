import type { CompiledField, CompiledRecord, CompiledValue } from '@inventarch/language';

/**
 * Readers over a compiled record's unconditional fields, shared by the generators and the execution binder (review
 * finding B2-N11: one copy in this package). They mirror runtime's private ones (packet.ts's `fieldsAt`, `valuesAt`,
 * `textsAt` and `stated`), which runtime does not export: a fix to either copy belongs in both. A field under a `when`
 * condition is never read: these say what a record states whatever the phase.
 */
type Sectioned = Pick<CompiledRecord, 'sections'>;
/** The unconditional fields of `record`'s `section`, in authored order. */
export const fieldsOf = (record: Sectioned, section: string): readonly CompiledField[] =>
  record.sections
    .filter((s) => s.name === section)
    .flatMap((s) => s.fields)
    .filter((f): f is CompiledField => 'key' in f && f.when === undefined);
/** The fields `record` states unconditionally at `field`, a `section.key` path. */
export const fieldsAt = (record: Sectioned, field: string): readonly CompiledField[] => {
  const [section = '', key] = field.split('.');
  return fieldsOf(record, section).filter((f) => f.key === key);
};
/** The values `record` states unconditionally at `field`, a list's items one by one. */
export const valuesAt = (record: Sectioned, field: string): readonly CompiledValue[] =>
  fieldsAt(record, field).flatMap((f) => (f.value.kind === 'list' ? f.value.items : [f.value]));
export const textsAt = (record: Sectioned, field: string): readonly string[] =>
  valuesAt(record, field).flatMap((value) => ('text' in value ? [value.text] : []));
/** Whether `record` states `field` at all: a declared empty list is stated, an absent key is not. */
export const stated = (record: Sectioned, field: string): boolean => fieldsAt(record, field).length > 0;
