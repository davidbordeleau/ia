import { readFileSync } from 'node:fs';
import { KERNEL_DIGEST, KERNEL_SOURCES, LANGUAGE_VERSION } from '@inventarch/language';
import { kernelAssessment, kernelDigest } from '../kernel.js';
import type { KernelSource } from '../kernel.js';
import type { Assessment } from '../types.js';
import { INVENTORY, INVENTORY_DIGEST } from './inventory.generated.js';
import type { OutOfProfileSuite } from './inventory.js';
import { runProfile } from './verify.js';

/** The conformance profile a sandboxed consumer can run itself (C31). */
export const CONFORMANCE_PROFILE = 'package-v1';
export type ConformanceProfile = typeof CONFORMANCE_PROFILE;
/** The running toolchain an evidence object was produced by. */
export interface ConformanceToolchain {
  readonly languageVersion: string;
  readonly kernelDigest: string;
  readonly compliance: string;
  readonly node: string;
}
export interface KernelEvidence {
  readonly subject: 'COMP-KERNEL';
  readonly profile: ConformanceProfile;
  readonly toolchain: ConformanceToolchain;
  /** `kernelDigest` of the floor this evidence verified. */
  readonly floorDigest: string;
  readonly assessment: Assessment;
}
export interface FixtureEvidence {
  readonly subject: 'COMP-FIXTURES';
  readonly profile: ConformanceProfile;
  readonly toolchain: ConformanceToolchain;
  /** `INVENTORY_DIGEST` of the inventory this evidence ran. */
  readonly inventoryDigest: string;
  /** The codes passing failing cases observed. */
  readonly observedCodes: readonly string[];
  /** The suites the profile does not run, so a pass says nothing about them. */
  readonly outOfProfile: readonly OutOfProfileSuite[];
  readonly assessment: Assessment;
}

let compliance: string | undefined;
function complianceVersion(): string {
  if (compliance === undefined)
    try {
      const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
        readonly name?: unknown;
        readonly version?: unknown;
      };
      compliance =
        manifest.name === '@inventarch/compliance' && typeof manifest.version === 'string'
          ? manifest.version
          : 'unknown';
    } catch {
      compliance = 'unknown';
    }
  return compliance;
}
/** The toolchain this process runs. */
export function runningToolchain(): ConformanceToolchain {
  return Object.freeze({
    languageVersion: LANGUAGE_VERSION,
    kernelDigest: KERNEL_DIGEST,
    compliance: complianceVersion(),
    node: process.version,
  });
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}
function floorOf(floor: unknown): readonly KernelSource[] {
  if (
    !Array.isArray(floor) ||
    floor.some(
      (source) =>
        typeof source !== 'object' ||
        source === null ||
        typeof (source as KernelSource).path !== 'string' ||
        typeof (source as KernelSource).text !== 'string',
    )
  )
    throw new TypeError('A floor is an array of {path, text} sources');
  return (floor as readonly KernelSource[]).map(({ path, text }) => ({ path, text }));
}

/**
 * Verifies COMP-KERNEL in this process: regenerates the kernel from `floor` (the embedded floor by default) and
 * compares it with the running language. The evidence records the digest of the floor it verified.
 */
export function verifyKernel(floor: readonly KernelSource[] = KERNEL_SOURCES): KernelEvidence {
  const sources = floorOf(floor);
  return freeze({
    subject: 'COMP-KERNEL' as const,
    profile: CONFORMANCE_PROFILE,
    toolchain: runningToolchain(),
    floorDigest: kernelDigest(sources),
    assessment: kernelAssessment(sources),
  });
}

/**
 * Verifies COMP-FIXTURES in this process for the package-v1 profile: runs the language fixtures this package ships
 * against its generated inventory, and the refusal and evidence suites over the conformance corpus it embeds. It reads
 * the package's own fixture files and writes nothing.
 */
export function verifyFixtures(): FixtureEvidence {
  const result = runProfile(INVENTORY, INVENTORY_DIGEST, new URL('../../fixtures/language/', import.meta.url));
  return freeze({
    subject: 'COMP-FIXTURES' as const,
    profile: CONFORMANCE_PROFILE,
    toolchain: runningToolchain(),
    inventoryDigest: INVENTORY_DIGEST,
    observedCodes: [...result.observedCodes],
    outOfProfile: INVENTORY.outOfProfile.map((suite) => ({ ...suite, codes: [...suite.codes] })),
    assessment: result.assessment,
  });
}
