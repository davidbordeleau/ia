import { KERNEL_DIGEST, LANGUAGE_VERSION, canonicalPath } from '@inventarch/language';
import { revisionOf, stableSerialize } from '@inventarch/graph';
import type { Graph, RevisionInputs } from '@inventarch/graph';
import { kernelDigest } from '../kernel.js';
import { assess } from '../types.js';
import type { Assessment } from '../types.js';
import { isConformanceEvidence, runningToolchain } from './evidence.js';
import type { ConformanceProfile, ConformanceToolchain, FixtureEvidence, KernelEvidence } from './evidence.js';
import { INVENTORY_DIGEST } from './inventory.generated.js';
import type { OutOfProfileSuite } from './inventory.js';

/** `ReportOptions.conformance`: the graph's own revision inputs and the evidence verifyKernel and verifyFixtures returned. */
export interface ConformanceOptions {
  readonly inputs: RevisionInputs;
  readonly kernel: KernelEvidence;
  readonly fixtures: FixtureEvidence;
}
/** `Report.conformance`: present only when both results are verified evidence bound to the graph. */
export interface ConformanceSummary {
  readonly profile: ConformanceProfile;
  readonly toolchain: ConformanceToolchain;
  readonly floorDigest: string;
  readonly inventoryDigest: string;
  readonly observedCodes: readonly string[];
  readonly outOfProfile: readonly OutOfProfileSuite[];
}
export interface BoundConformance {
  /** The assessment for each check; `verified` is false where the evidence did not bind and it is NOT-EVALUATED. */
  readonly results: readonly { readonly assessment: Assessment; readonly verified: boolean }[];
  readonly summary?: ConformanceSummary;
}
const notEvaluated = (check: string, reason: string): Assessment =>
  assess(check, 'graph', [
    { code: 'IA-COMP-NOT-EVALUATED', severity: 'warning', path: '', line: 1, message: `${check}: ${reason}` },
  ]);

/**
 * Binds conformance evidence to `graph` (C31). Unbranded, copied or swapped evidence and inputs that are not revision
 * inputs are a TypeError. Evidence counts only for the graph whose revision the inputs recompute, loaded for the
 * running language version and kernel digest, from evidence the running toolchain produced, and, for COMP-KERNEL,
 * from a floor whose digest is the inputs' floor: the sources under `.ia/src/floor/` at floor placement. Anything
 * else, including a source with only one of that path and that placement, is NOT-EVALUATED.
 */
export function bindConformance(graph: Graph, conformance: ConformanceOptions): BoundConformance {
  if (typeof conformance !== 'object' || conformance === null)
    throw new TypeError('conformance requires {inputs, kernel, fixtures}');
  const { inputs, kernel, fixtures } = conformance;
  if (!isConformanceEvidence(kernel, 'COMP-KERNEL'))
    throw new TypeError('conformance.kernel must be evidence verifyKernel returned');
  if (!isConformanceEvidence(fixtures, 'COMP-FIXTURES'))
    throw new TypeError('conformance.fixtures must be evidence verifyFixtures returned');
  if (typeof inputs !== 'object' || inputs === null || !Array.isArray(inputs.sources))
    throw new TypeError("conformance.inputs must be the graph's revision inputs");
  const running = stableSerialize(runningToolchain());
  const graphReason =
    revisionOf(graph.registry, inputs) !== graph.revision
      ? "the conformance inputs do not recompute this graph's revision"
      : inputs.languageVersion !== LANGUAGE_VERSION || inputs.kernelDigest !== KERNEL_DIGEST
        ? 'the graph was loaded for another language version or kernel digest than the running one'
        : undefined;
  const stale = 'the evidence was produced by another toolchain';
  let kernelReason = graphReason ?? (stableSerialize(kernel.toolchain) === running ? undefined : stale);
  if (kernelReason === undefined) {
    const floor: { path: string; text: string }[] = [],
      ambiguous: string[] = [];
    for (const source of inputs.sources) {
      const path = canonicalPath(source.path),
        atPath = path.startsWith('.ia/src/floor/'),
        atPlacement = source.location.placement.kind === 'floor';
      if (atPath && atPlacement) floor.push({ path, text: source.text });
      else if (atPath || atPlacement) ambiguous.push(path);
    }
    kernelReason =
      ambiguous.length > 0
        ? `floor source ${ambiguous.sort()[0]} has a floor path or a floor placement, not both`
        : kernelDigest(floor) !== kernel.floorDigest
          ? 'the kernel evidence verified another floor'
          : undefined;
  }
  const fixturesReason =
    graphReason ??
    (stableSerialize(fixtures.toolchain) === running && fixtures.inventoryDigest === INVENTORY_DIGEST
      ? undefined
      : stale);
  const results = [
    kernelReason === undefined
      ? { assessment: kernel.assessment, verified: true }
      : { assessment: notEvaluated('COMP-KERNEL', kernelReason), verified: false },
    fixturesReason === undefined
      ? { assessment: fixtures.assessment, verified: true }
      : { assessment: notEvaluated('COMP-FIXTURES', fixturesReason), verified: false },
  ];
  return kernelReason !== undefined || fixturesReason !== undefined
    ? { results }
    : {
        results,
        summary: Object.freeze({
          profile: kernel.profile,
          toolchain: kernel.toolchain,
          floorDigest: kernel.floorDigest,
          inventoryDigest: fixtures.inventoryDigest,
          observedCodes: fixtures.observedCodes,
          outOfProfile: fixtures.outOfProfile,
        }),
      };
}
