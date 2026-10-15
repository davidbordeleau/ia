export const NATIVE_SYSTEM_POLICY: string;
export const NATIVE_LANGUAGE_POLICY: string;
export const NATIVE_COMPOSITION_FIXTURE: string;
export interface NativeReleaseTarget {
  format: 'ia.npm-cohort.v1';
  version: string;
  tag: 'latest';
  baseline: { commit: string; version: string };
  cycles: string[][];
}
export function readNativeReleaseTarget(root: string): NativeReleaseTarget;
export function declarationVersion(text: string, from: string, to: string): string;
export function prepareNativeSelection(root: string, target: string): Map<string, string>;
export function nativeVersionOnly(
  root: string,
  path: string,
  beforeText: string | null,
  afterText: string | null,
): boolean;
