import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKernel } from '../../packages/compliance/src/kernel.js';
import type { KernelSource } from '../../packages/compliance/src/kernel.js';
import { isEntry } from '../entry/is-entry.mjs';

export { generateKernel };
export type { KernelSource };
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function readKernel(root: string): readonly KernelSource[] {
  return readdirSync(resolve(root, '.ia/src/floor'))
    .filter((p) => p.endsWith('.ia'))
    .sort(compare)
    .map((name) => ({
      path: `.ia/src/floor/${name}`,
      text: readFileSync(resolve(root, '.ia/src/floor', name), 'utf8').replaceAll('\r\n', '\n'),
    }));
}

export function checkKernel(root: string, write = false): { digest: string; records: number } {
  const result = generateKernel(readKernel(root));
  const path = resolve(root, 'packages/language/src/kernel.generated.ts');
  if (write) writeFileSync(path, result.text);
  else if (readFileSync(path, 'utf8').replaceAll('\r\n', '\n') !== result.text)
    throw new Error('Kernel output drift: run pnpm kernel:generate and review the result');
  return result;
}
if (isEntry(process.argv[1], import.meta.url)) {
  const flag = process.argv[2] ?? '--check';
  if (!['--check', '--write'].includes(flag)) throw new Error('Usage: generate.ts [--check|--write]');
  const result = checkKernel(fileURLToPath(new URL('../../', import.meta.url)), flag === '--write');
  process.stdout.write(`Validated ${result.records} kernel records; digest ${result.digest}.\n`);
}
