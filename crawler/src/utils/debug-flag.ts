/**
 * `npm run <script> --debug` (no `--` separator) makes npm swallow the flag and
 * expose it to the script as the environment variable npm_config_debug. The
 * correct form is `npm run <script> -- --debug`. Because a missed dry-run flag
 * means a real publish, treat the swallowed flag as debug too. This only ever
 * errs toward debug; nothing here can turn a debug request into a live run.
 */
export function isDebugRequested(
  argv: string[],
  env: Record<string, string | undefined>
): { debug: boolean; fromNpm: boolean } {
  const inArgv = argv.includes('--debug');
  const inNpm = env.npm_config_debug === 'true';
  return { debug: inArgv || inNpm, fromNpm: !inArgv && inNpm };
}
