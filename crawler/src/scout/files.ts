import * as fs from 'fs/promises';
import * as path from 'path';

/** Absolute path from `--flag <path>` on the command line, or `fallback` (relative to the cwd). */
export function pathArg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.resolve(fallback);
}

/** File contents, or null if the file does not exist (other errors propagate). */
export async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Write via a temp file + rename so an interrupted run never leaves a half-written file. */
export async function writeFileAtomic(
  file: string,
  content: string
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, file);
}
