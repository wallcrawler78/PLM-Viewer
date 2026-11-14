/** Local qualification uses a fixed inventory; a launch URL cannot select a source. */
export const RUNTIME_CHECK_DEFINITIONS = [
  { id: 'assets', title: 'Packaged assets', detail: 'Runtime versions and synthetic source hashes', timeoutMs: 15_000 },
  { id: 'step', title: 'STEP import', detail: 'Original STEP → local worker → 180 × 136 × 8 mm envelope', timeoutMs: 45_000 },
  { id: 'pdf', title: 'PDF rendering', detail: 'Local worker, page pixels, and extractable text', timeoutMs: 25_000 },
  { id: 'docx', title: 'Word rendering', detail: 'Validated DOCX package and sanitized page layout', timeoutMs: 25_000 },
  { id: 'graphics', title: '3D graphics', detail: 'WebGL2 availability and an actual software render', timeoutMs: 10_000 },
] as const;

export type RuntimeCheckId = typeof RUNTIME_CHECK_DEFINITIONS[number]['id'];
export type RuntimeCheckStatus = 'pending' | 'running' | 'passed' | 'failed' | 'unavailable' | 'cancelled';
export const RUNTIME_MESSAGES = {
  pending: 'Ready to run.',
  running: 'Checking the bundled fixture…',
  assetsVerified: 'Runtime versions and all three source hashes match the packaged manifests.',
  stepVerified: 'The local STEP worker imported the original fixture and returned the expected millimeter envelope.',
  pdfVerified: 'A real local PDF worker opened the fixture, extracted the expected text, and rendered visible page pixels.',
  wordVerified: 'The DOCX passed package validation and rendered the expected text and pages through the local Word runtime.',
  graphicsVerified: 'WebGL2 is available. The software fallback also rendered a test model successfully.',
  softwareVerified: 'WebGL2 is unavailable in this session. The software fallback rendered a test model successfully.',
  graphicsUnavailable: 'This session could not create a usable graphics canvas.',
  missingDependency: 'This check needs the packaged manifests and source hashes to pass first.',
  manifestInvalid: 'A packaged manifest is missing, incompatible, or does not describe the expected synthetic fixtures.',
  sourceUnavailable: 'A required bundled resource could not be read within its size or time limit.',
  hashMismatch: 'A bundled fixture does not match its SHA-256 source hash.',
  unexpectedStep: 'The STEP result did not match the expected finite geometry and millimeter envelope.',
  unexpectedPdf: 'The PDF did not produce the expected pages, text, and visible page pixels.',
  unexpectedWord: 'The Word document did not produce the expected sanitized pages and text.',
  unexpectedGraphics: 'The software renderer did not produce the expected visible test geometry.',
  failed: 'The local runtime could not complete this check. Rebuild or reinstall the package and run it again.',
  timedOut: 'This check reached its time limit. Its owned work was cancelled.',
  cancelled: 'Cancelled by the user or by leaving this screen.',
  notRun: 'Not run because this qualification was cancelled.',
} as const;
export type RuntimeMessageCode = keyof typeof RUNTIME_MESSAGES;

const METRIC_NAMES = ['sourceFiles', 'sourceBytes', 'vertices', 'triangles', 'widthMm', 'depthMm', 'heightMm', 'pages', 'renderedPixels', 'textCharacters', 'wordElements', 'webgl2', 'software', 'elapsedMs'] as const;
export type RuntimeMetrics = Partial<Record<typeof METRIC_NAMES[number], number | boolean>>;
export interface RuntimeObservation { status: 'passed' | 'unavailable'; code: RuntimeMessageCode; metrics?: RuntimeMetrics }
export interface RuntimeCheckResult {
  id: RuntimeCheckId;
  status: RuntimeCheckStatus;
  code: RuntimeMessageCode;
  elapsedMs: number;
  metrics?: RuntimeMetrics;
}
export interface RuntimeEnvironment {
  surface: 'chrome-extension' | 'hosted-preview';
  viewerVersion: string | null;
  extensionVersion: string | null;
  browserMajor: string | null;
  packages: { pdf: string | null; word: string | null; cad: string | null; graphics: string | null };
}
export interface RuntimeReport {
  formatVersion: 1;
  startedAt: string;
  finishedAt: string;
  outcome: 'passed' | 'attention' | 'cancelled';
  environment: RuntimeEnvironment;
  checks: RuntimeCheckResult[];
  scope: string[];
}

/** Only these authored codes reach the UI/report; library errors may contain source data. */
export class RuntimeCheckIssue extends Error {
  constructor(readonly code: RuntimeMessageCode, readonly status: 'failed' | 'unavailable' = 'failed') { super(RUNTIME_MESSAGES[code]); }
}

export function initialRuntimeResults(): RuntimeCheckResult[] {
  return RUNTIME_CHECK_DEFINITIONS.map(check => ({ id: check.id, status: 'pending', code: 'pending', elapsedMs: 0 }));
}

export function isRuntimeCheckRoute(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.getAll('mode').length === 1 && params.get('mode') === 'preview'
    && params.getAll('runtimeChecks').length === 1 && params.get('runtimeChecks') === 'true';
}

export function runtimeCheckTarget(pageUrl: string): string {
  const target = new URL(pageUrl);
  target.search = '?mode=preview&runtimeChecks=true';
  target.hash = '';
  target.username = ''; target.password = '';
  return target.href;
}

/** Match protocol AND host: URL.origin is "null" for extension URLs in some runtimes. */
export function packagedResourceUrl(path: string, pageUrl: string): string {
  const page = new URL(pageUrl);
  if (!['https:', 'http:', 'chrome-extension:'].includes(page.protocol)
    || !/^\/(?:fixtures|vendor)\/[A-Za-z0-9_./-]+$/.test(path)
    || path.split('/').some(part => part === '.' || part === '..')) throw new RuntimeCheckIssue('sourceUnavailable');
  const target = new URL(path, page);
  if (target.protocol !== page.protocol || target.host !== page.host || target.username || target.password) throw new RuntimeCheckIssue('sourceUnavailable');
  return target.href;
}

export async function verifyFixtureHash(bytes: ArrayBuffer, expected: string, digest: SubtleCrypto = crypto.subtle): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new RuntimeCheckIssue('manifestInvalid');
  const actual = Array.from(new Uint8Array(await digest.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== expected) throw new RuntimeCheckIssue('hashMismatch');
}

/** Table cell boundaries can be spaces in PDF extraction and adjacent text in DOCX DOM. */
export function matchesRuntimeFixtureText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ');
  return /ASM-1000/.test(normalized) && /Revision\s+B\b/i.test(normalized)
    && /Nominal base envelope\s*:?\s*180\s*x\s*136\s*x\s*8\s*mm/i.test(normalized)
    && /Maximum installed width\s*:?\s*140\.0\s*mm/i.test(normalized);
}

/** A deadline cancels the owned operation as well as settling the UI promise. */
export async function withRuntimeDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, milliseconds: number): Promise<T> {
  parent.throwIfAborted();
  const owned = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAborted: ((reason: unknown) => void) | undefined;
  const abort = () => { owned.abort(parent.reason ?? new DOMException('Cancelled', 'AbortError')); rejectAborted?.(owned.signal.reason); };
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
      parent.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        const issue = new RuntimeCheckIssue('timedOut');
        owned.abort(issue); reject(issue);
      }, Math.max(1, milliseconds));
    });
    if (parent.aborted) abort();
    return await Promise.race([Promise.resolve().then(() => { owned.signal.throwIfAborted(); return operation(owned.signal); }), cancelled]);
  } finally {
    clearTimeout(timer); parent.removeEventListener('abort', abort);
    // Release listeners held by a completed implementation too.
    if (!owned.signal.aborted) owned.abort(new DOMException('Check complete', 'AbortError'));
  }
}

type RuntimeOperations = Record<RuntimeCheckId, (signal: AbortSignal) => Promise<RuntimeObservation>>;
export async function runRuntimeChecks(operations: RuntimeOperations, signal: AbortSignal, onUpdate: (results: RuntimeCheckResult[]) => void, deadlines?: Partial<Record<RuntimeCheckId, number>>): Promise<RuntimeCheckResult[]> {
  const results = initialRuntimeResults();
  const publish = () => onUpdate(results.map(result => ({ ...result, ...(result.metrics ? { metrics: { ...result.metrics } } : {}) })));
  for (let index = 0; index < results.length; index++) {
    if (signal.aborted) {
      for (let next = index; next < results.length; next++) results[next] = { ...results[next], status: 'cancelled', code: 'notRun' };
      publish(); break;
    }
    const check = RUNTIME_CHECK_DEFINITIONS[index];
    const start = performance.now();
    results[index] = { id: check.id, status: 'running', code: 'running', elapsedMs: 0 }; publish();
    try {
      const observation = await withRuntimeDeadline(operations[check.id], signal, deadlines?.[check.id] ?? check.timeoutMs);
      signal.throwIfAborted();
      results[index] = { id: check.id, ...observation, elapsedMs: Math.max(0, Math.round(performance.now() - start)) };
    } catch (error) {
      results[index] = {
        id: check.id,
        status: signal.aborted ? 'cancelled' : error instanceof RuntimeCheckIssue ? error.status : 'failed',
        code: signal.aborted ? 'cancelled' : error instanceof RuntimeCheckIssue ? error.code : 'failed',
        elapsedMs: Math.max(0, Math.round(performance.now() - start)),
      };
    }
    publish();
  }
  return results;
}

function safeVersion(value: unknown): string | null { return typeof value === 'string' && /^\d{1,5}(?:\.\d{1,5}){0,3}(?:[-+][A-Za-z0-9.-]{1,30})?$/.test(value) ? value : null; }
function safeTimestamp(value: string): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString() : 'unavailable'; }

/** Copy a closed schema. Never spread browser objects, manifest fields, URLs, or exceptions. */
export function createRuntimeReport(environment: RuntimeEnvironment, results: RuntimeCheckResult[], startedAt: string, finishedAt: string): RuntimeReport {
  const checks = RUNTIME_CHECK_DEFINITIONS.map(definition => {
    const result = results.find(candidate => candidate.id === definition.id);
    const status = result && ['pending', 'running', 'passed', 'failed', 'unavailable', 'cancelled'].includes(result.status) ? result.status : 'unavailable';
    const code = result && Object.hasOwn(RUNTIME_MESSAGES, result.code) ? result.code : 'failed';
    const metrics: RuntimeMetrics = {};
    for (const key of METRIC_NAMES) {
      const value = result?.metrics?.[key];
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e12)) metrics[key] = value;
    }
    return { id: definition.id, status, code, elapsedMs: typeof result?.elapsedMs === 'number' && Number.isFinite(result.elapsedMs) ? Math.max(0, Math.min(600_000, Math.round(result.elapsedMs))) : 0, ...(Object.keys(metrics).length ? { metrics } : {}) } as RuntimeCheckResult;
  });
  const extension = environment.surface === 'chrome-extension';
  return {
    formatVersion: 1, startedAt: safeTimestamp(startedAt), finishedAt: safeTimestamp(finishedAt),
    outcome: checks.some(check => check.status === 'cancelled') ? 'cancelled' : checks.every(check => check.status === 'passed') ? 'passed' : 'attention',
    environment: {
      surface: extension ? 'chrome-extension' : 'hosted-preview', viewerVersion: safeVersion(environment.viewerVersion),
      extensionVersion: extension ? safeVersion(environment.extensionVersion) : null, browserMajor: safeVersion(environment.browserMajor),
      packages: { pdf: safeVersion(environment.packages.pdf), word: safeVersion(environment.packages.word), cad: safeVersion(environment.packages.cad), graphics: safeVersion(environment.packages.graphics) },
    },
    checks,
    scope: [
      'User-initiated checks of bundled synthetic fixtures only. No Arena request, customer source, sign-in, AI, or remote conversion.',
      extension ? 'Executed on a chrome-extension page. This is local runtime evidence, not a complete Chrome release qualification.' : 'Executed in hosted Preview. This does not qualify an installed Chrome extension or its Manifest V3 policy.',
      'Small fixtures do not qualify arbitrary source files, large assemblies, engineering accuracy, document fidelity, or all fonts and codecs.',
      'Arena authorization, exact source launch, deployment policy, and shared review storage require separate acceptance tests.',
      'Asynchronous operations have deadlines. Browser main-thread work and garbage collection cannot be forcibly interrupted.',
    ],
  };
}
