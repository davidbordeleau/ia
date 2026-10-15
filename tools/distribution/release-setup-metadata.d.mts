export type PackageMetadataResult = { ok: true; name: string } | { ok: false; code: string };
export function readPackageMetadata(
  cli: string,
  name: string,
  options?: {
    load?: (cli: string) => {
      Npm: new (options: {
        npmRoot: string;
        argv: string[];
      }) => {
        config: { load: () => Promise<void> };
        flatOptions: Record<string, unknown>;
        unload: () => void;
      };
      fetch: { json: (url: string, options: Record<string, unknown>) => Promise<unknown> };
      npmRoot: string;
    };
  },
): Promise<PackageMetadataResult>;
