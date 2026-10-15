import { KERNEL_DIGEST, LANGUAGE_VERSION, canonicalPath } from '@inventarch/language';
import type { Location } from '@inventarch/language';
import { revisionOf, stableSerialize } from '@inventarch/graph';
import type { Graph, RevisionInputs, RevisionSource } from '@inventarch/graph';
import { kernelDigest } from '../kernel.js';
import { assess } from '../types.js';
import type { Assessment } from '../types.js';
import { isConformanceEvidence, runningToolchain } from './evidence.js';
import type { ConformanceProfile, ConformanceToolchain, FixtureEvidence, KernelEvidence } from './evidence.js';
import type { OutOfProfileSuite } from './inventory.js';

/** `ReportOptions.conformance`: the graph's own revision inputs and the evidence verifyKernel and verifyFixtures returned. */
export interface ConformanceOptions {
  readonly inputs: RevisionInputs;
  readonly kernel: KernelEvidence;
  readonly fixtures: FixtureEvidence;
}
/** `Report.conformance`: present when at least one check is verified evidence bound to the graph. */
export interface ConformanceSummary {
  readonly profile: ConformanceProfile;
  readonly toolchain: ConformanceToolchain;
  /** Present when COMP-KERNEL is verified: the floor it verified. */
  readonly kernel?: { readonly floorDigest: string };
  /** Present when COMP-FIXTURES is verified: what the profile ran, observed and did not run. */
  readonly fixtures?: {
    readonly inventoryDigest: string;
    readonly observedCodes: readonly string[];
    readonly outOfProfile: readonly OutOfProfileSuite[];
  };
}
export interface BoundConformance {
  /** The assessment for each check; `verified` only where the evidence bound and was evaluated. */
  readonly results: readonly { readonly assessment: Assessment; readonly verified: boolean }[];
  readonly summary?: ConformanceSummary;
}
const notEvaluated = (check: string, reason: string): Assessment =>
  assess(check, 'graph', [
    { code: 'IA-COMP-NOT-EVALUATED', severity: 'warning', path: '', line: 1, message: `${check}: ${reason}` },
  ]);
const record = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (typeof value !== 'object' || value === null) throw new TypeError(`${label} must be an object`);
  return value as Readonly<Record<string, unknown>>;
};
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
};
/**
 * The caller's inputs read once into frozen plain data, so every rule below sees what `revisionOf` hashed: a getter
 * cannot show the revision one value and the version or floor checks another.
 */
function snapshot(inputs: unknown): RevisionInputs {
  const { sources, languageVersion, kernelDigest: digest } = record(inputs, 'conformance.inputs');
  if (!Array.isArray(sources)) throw new TypeError('conformance.inputs.sources must be an array');
  // An index loop into a fresh array literal, reading the length once: Array methods would build their results through
  // the caller's constructor[Symbol.species], which can define other objects in place of the copies validated here.
  const length: unknown = sources.length;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
    throw new TypeError('conformance.inputs.sources must be an array');
  const copied: RevisionSource[] = [];
  for (let index = 0; index < length; index++) {
    const at = `conformance.inputs.sources[${index}]`;
    const { path, text: body, location } = record(sources[index], at);
    const { placement, provenance } = record(location, `${at}.location`);
    const { kind, band, reach } = record(placement, `${at}.location.placement`);
    if (typeof band !== 'number') throw new TypeError(`${at}.location.placement.band must be a number`);
    copied.push(
      Object.freeze({
        path: text(path, `${at}.path`),
        text: text(body, `${at}.text`),
        location: Object.freeze({
          placement: Object.freeze({
            kind: text(kind, `${at}.location.placement.kind`),
            band,
            reach: text(reach, `${at}.location.placement.reach`),
          }),
          provenance: text(provenance, `${at}.location.provenance`),
        }) as Location,
      }),
    );
  }
  return Object.freeze({
    languageVersion: text(languageVersion, 'conformance.inputs.languageVersion'),
    kernelDigest: text(digest, 'conformance.inputs.kernelDigest'),
    sources: Object.freeze(copied),
  });
}

/**
 * Binds conformance evidence to `graph` (C31). Unbranded, copied or swapped evidence and inputs that are not revision
 * inputs are a TypeError. The inputs are read once. Evidence counts only for the graph whose revision the inputs
 * recompute, loaded for the running language version and kernel digest, and only when the running toolchain produced
 * it; COMP-KERNEL also needs the inputs' floor (the sources under `.ia/src/floor/` at floor placement) to be the floor
 * it verified. Anything else, including a source with only one of that path and that placement, is NOT-EVALUATED.
 */
export function bindConformance(graph: Graph, conformance: ConformanceOptions): BoundConformance {
  const { inputs: given, kernel, fixtures } = record(conformance, 'conformance');
  if (!isConformanceEvidence(kernel, 'COMP-KERNEL'))
    throw new TypeError('conformance.kernel must be evidence verifyKernel returned');
  if (!isConformanceEvidence(fixtures, 'COMP-FIXTURES'))
    throw new TypeError('conformance.fixtures must be evidence verifyFixtures returned');
  const inputs = snapshot(given),
    toolchain = runningToolchain();
  const graphReason =
    revisionOf(graph.registry, inputs) !== graph.revision
      ? "the conformance inputs do not recompute this graph's revision"
      : inputs.languageVersion !== LANGUAGE_VERSION || inputs.kernelDigest !== KERNEL_DIGEST
        ? 'the graph was loaded for another language version or kernel digest than the running one'
        : undefined;
  // Each object is checked against the running toolchain on its own, so one stale object leaves the other bound.
  const staleness = (evidence: KernelEvidence | FixtureEvidence) =>
    stableSerialize(evidence.toolchain) === stableSerialize(toolchain)
      ? undefined
      : 'the evidence was produced by another toolchain';
  let kernelReason = graphReason ?? staleness(kernel);
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
  const fixturesReason = graphReason ?? staleness(fixtures);
  // Bound evidence whose own assessment is not-evaluated stays as it is: not verified, and not summarised.
  const result = (check: string, reason: string | undefined, assessment: Assessment) =>
    reason === undefined
      ? { assessment, verified: assessment.outcome !== 'not-evaluated' }
      : { assessment: notEvaluated(check, reason), verified: false };
  const [kernelResult, fixturesResult] = [
    result('COMP-KERNEL', kernelReason, kernel.assessment),
    result('COMP-FIXTURES', fixturesReason, fixtures.assessment),
  ] as const;
  const results = [kernelResult, fixturesResult];
  if (!kernelResult.verified && !fixturesResult.verified) return { results };
  return {
    results,
    summary: Object.freeze({
      profile: kernel.profile,
      toolchain,
      ...(kernelResult.verified ? { kernel: Object.freeze({ floorDigest: kernel.floorDigest }) } : {}),
      ...(fixturesResult.verified
        ? {
            fixtures: Object.freeze({
              inventoryDigest: fixtures.inventoryDigest,
              observedCodes: fixtures.observedCodes,
              outOfProfile: fixtures.outOfProfile,
            }),
          }
        : {}),
    }),
  };
}
