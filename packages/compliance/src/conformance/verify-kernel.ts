import * as language from '@inventarch/language';
import { stableSerialize } from '@inventarch/graph';
import { generateKernel } from '../kernel.js';
import type { KernelSource } from '../kernel.js';
import { assess } from '../types.js';
import type { Assessment, Finding } from '../types.js';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** `PRESENT_PHRASES` is not exported; what it determines is: `VERB_PHRASES` and each phrase's `verbOf`. */
function phrasesAgree(pairs: readonly (readonly string[])[], phrases: readonly string[]): boolean {
  const expected = new Set([...pairs.flat(), ...phrases]),
    shipped = new Set(language.VERB_PHRASES);
  return (
    expected.size === shipped.size &&
    [...expected].every((phrase) => shipped.has(phrase)) &&
    phrases.every((phrase, index) => {
      const verb = language.verbOf(phrase);
      return verb?.predicate === pairs[index]?.[0] && verb?.direction === 'out';
    })
  );
}

/**
 * COMP-KERNEL over `floor`: regenerate it and compare every regenerated constant, `KERNEL_DIGEST` and
 * `KERNEL_SOURCES` included, with the running `@inventarch/language`'s public exports. A floor that does not
 * regenerate, or regenerates to anything else, fails. Only the public entry is read, so no built output is needed.
 */
export function kernelAssessment(floor: readonly KernelSource[]): Assessment {
  const findings: Finding[] = [];
  const fail = (message: string): void => {
    findings.push({
      code: 'IA-COMP-FIXTURE-MISMATCH',
      severity: 'error',
      path: '.ia/src/floor',
      line: 1,
      message: `Kernel verification: ${message}`,
    });
  };
  try {
    const regenerated = generateKernel(floor).constants,
      exported: Readonly<Record<string, unknown>> = language;
    for (const name of Object.keys(regenerated).sort(compare))
      if (name === 'PRESENT_PHRASES') {
        if (
          !phrasesAgree(
            regenerated['PREDICATE_PAIRS'] as readonly (readonly string[])[],
            regenerated[name] as readonly string[],
          )
        )
          fail(`${name} differs from regeneration`);
      } else if (!(name in exported)) fail(`${name} regenerates from the floor but the language does not export it`);
      else if (stableSerialize(regenerated[name]) !== stableSerialize(exported[name]))
        fail(`${name} differs from regeneration`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return assess('COMP-KERNEL', 'floor', findings);
}
