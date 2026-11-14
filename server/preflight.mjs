/** Server administrator CLI. Imports only an explicitly trusted deployment module. */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadConfiguredProvider } from './index.mjs';
import { buildArenaPreflight, formatArenaPreflight } from './readiness.mjs';

const USAGE = 'Use: npm run preflight:arena -- [--provider /absolute/private/provider.mjs] [--json]\nThe ARENA_PROVIDER_MODULE environment variable is used when --provider is omitted.\nNo module selects an unconfigured report. Exit 0: configuration complete, 2: blocked, 1: command/load failure.\n';
const failure = code => ({ schemaVersion: 1, scope: 'configuration-only', state: 'blocked', liveAcceptance: 'not-tested', networkChecks: 'not-run', error: { code, message: code === 'INVALID_ARGUMENTS' ? 'Use --provider with one trusted local module path and/or --json; no network URLs or unknown options.' : 'The trusted deployment module could not be loaded or its report could not be inspected. Review its configuration on the server; no raw error was included.' } });

export async function runArenaPreflight(args = [], { env = process.env, loadProvider = loadConfiguredProvider } = {}) {
  let modulePath = env.ARENA_PROVIDER_MODULE, json = false, provided = false;
  if (args.length === 1 && args[0] === '--help') return { exitCode: 0, output: USAGE };
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--json' && !json) json = true;
      else if (arg === '--provider' && !provided && typeof args[index + 1] === 'string' && args[index + 1] && !args[index + 1].startsWith('--')) { modulePath = args[++index]; provided = true; }
      else throw new Error('arguments');
    }
    if (modulePath !== undefined && (typeof modulePath !== 'string' || !modulePath.trim() || modulePath !== modulePath.trim() || /[\u0000-\u001f\u007f]/.test(modulePath) || /^[a-z][a-z0-9+.-]*:/i.test(modulePath))) throw new Error('arguments');
  } catch {
    return { exitCode: 1, output: `${JSON.stringify(failure('INVALID_ARGUMENTS'), null, 2)}\n` };
  }
  try {
    const provider = modulePath ? await loadProvider(modulePath) : null;
    const report = buildArenaPreflight(provider);
    return { exitCode: report.state === 'configuration-complete' ? 0 : 2, report, output: json ? `${JSON.stringify(report, null, 2)}\n` : formatArenaPreflight(report) };
  } catch { return { exitCode: 1, output: `${JSON.stringify(failure('PROVIDER_LOAD_FAILED'), null, 2)}\n` }; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Bound a stalled private module load; this does not sandbox trusted code.
  const timer = setTimeout(() => {
    process.stdout.write(`${JSON.stringify(failure('PROVIDER_LOAD_FAILED'), null, 2)}\n`, () => process.exit(1));
  }, 30_000);
  const result = await runArenaPreflight(process.argv.slice(2));
  // Private stores may own persistent sockets. Flush the report, then end this
  // one-shot command instead of waiting for their unrelated background handles.
  process.stdout.write(result.output, () => { clearTimeout(timer); process.exit(result.exitCode); });
}
