import { isId, isIsoDate, isNumberText, isQualifiedName } from '@inventarch/language';
import type { CompiledValue, FieldType, TextForm, ValueType } from '@inventarch/language';

/** Whether a schema field type is `list of T`: the one family a key may carry more than once (D3). */
export function isListType(type: FieldType): boolean {
  return type.startsWith('list of ');
}
/** Type predicates over already parsed values, never over IA source. */
export function matchesType(value: CompiledValue, type: FieldType): boolean {
  if (isListType(type)) {
    return value.kind === 'list' && value.items.every((item) => matchesScalar(item, type.slice(8) as ValueType));
  }
  return matchesScalar(value, type as ValueType);
}
function matchesScalar(value: CompiledValue, type: ValueType): boolean {
  if (type === 'ref') return value.kind === 'ref';
  if (type === 'flag')
    return value.kind === 'none' || (value.kind === 'scalar' && ['true', 'false'].includes(value.text));
  if (type === 'text') return value.kind === 'scalar' || value.kind === 'string' || value.kind === 'prose';
  if (value.kind !== 'scalar' && value.kind !== 'string') return false;
  switch (type) {
    case 'id':
      return isId(value.text);
    case 'number':
      return isNumberText(value.text);
    case 'qname':
      return isQualifiedName(value.text);
  }
}

/** Text-form predicates (W0-L5) over already type-checked text. `iso-date` is `YYYY-MM-DD` and a real calendar date. */
export function matchesForm(text: string, form: TextForm): boolean {
  switch (form) {
    case 'iso-date':
      return isIsoDate(text);
  }
}
