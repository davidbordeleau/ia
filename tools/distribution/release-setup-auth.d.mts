export type InteractiveTrustResult = { ok: true; listing: string } | { ok: false; code: string };
export function readMaskedOtp(
  prompt: string,
  options: {
    read: (options: { prompt: string; silent: boolean }) => Promise<string>;
    input: { read: (operation: () => Promise<string>, options: Record<string | symbol, unknown>) => Promise<string> };
    meta: symbol;
  },
): Promise<string>;
export function readTrustInteractive(
  cli: string,
  name: string,
  options?: {
    stdinIsTTY?: boolean;
    stdoutIsTTY?: boolean;
    load?: (cli: string) => {
      Npm: new (options: {
        npmRoot: string;
        argv: string[];
      }) => {
        config: { load: () => Promise<void> };
        unload: () => void;
      };
      Display: new (options: {
        stdout: NodeJS.WriteStream;
        stderr: NodeJS.WriteStream;
      }) => {
        load: (options: Record<string, unknown>) => Promise<void>;
        off: () => void;
      };
      TrustList: {
        new (
          npm: unknown,
        ): {
          displayResponseBody: (response: { body: unknown; packageName: string }) => void;
          exec: (args: string[]) => Promise<void>;
        };
        bodyToOptions: (item: Record<string, unknown>) => Record<string, unknown>;
      };
      npmRoot: string;
      maskOtp: () => () => void;
    };
  },
): Promise<InteractiveTrustResult>;
