/** Refusals of the host-plugin lowering and the plugin product; the CLI maps each to a Refusal with its next step. */
export type HostPluginCode =
  | 'IA-LOWER-UNRESOLVED'
  | 'IA-PLUGIN-INPUT'
  | 'IA-PLUGIN-PRODUCT'
  | 'IA-PROJECT-FEATURE'
  | 'IA-RESOURCE-DIGEST'
  | 'IA-ROUNDTRIP-DRIFT'
  | 'IA-PLUGIN-OUT';

export class HostPluginError extends Error {
  constructor(
    readonly code: HostPluginCode,
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'HostPluginError';
  }
}
