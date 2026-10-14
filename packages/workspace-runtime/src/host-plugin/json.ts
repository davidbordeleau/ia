/**
 * Structural equality of parsed JSON values: objects by key set regardless of key order, arrays in order.
 *
 * Not `isDeepStrictEqual`: an ESM import of `node:util` evaluates its lazy `diff` export, whose colour probe prints a
 * warning to stderr whenever both NO_COLOR and FORCE_COLOR are set, so every CLI command would write to stderr.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>,
    keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  );
}
