/** Closed, configuration-only administrator reports. Never invoke provider operations. */
const MCP_REQUIRED = Object.freeze({
  endpoint: 'MCP endpoint', sessionResolver: 'User session resolver', approvedReadTools: 'Reviewed read-tool allowlist',
  getSchema: 'Workspace schema mapping', resolveBom: 'Exact BOM mapping', listRevisions: 'Revision mapping',
  listAttachments: 'Attachment mapping', readContent: 'Exact file delivery mapping',
});
const MCP_LIMITS = ['timeoutMs', 'maxPages', 'maxTools', 'maxItems', 'maxJsonBytes', 'maxContentBytes', 'maxMcpResponseBytes'];
const OAUTH_REQUIRED = Object.freeze({
  endpoint: 'OAuth MCP endpoint', callback: 'HTTPS callback', clientIdentity: 'Application client identity',
  clientAuthentication: 'Configured client authentication', identityResolver: 'Trusted user/workspace resolver',
  approvedOrigins: 'Reviewed OAuth origins', sessionStore: 'Session store interface',
});
const OAUTH_DEPLOYMENT = Object.freeze({
  cookieKeyProvided: 'Explicit cookie signing key', productionStoreDeclared: 'Production session store declared',
  encryptedStoreDeclared: 'Encrypted session storage declared', sharedStoreDeclared: 'Shared session storage declared',
});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function field(value, key) {
  if (!object(value)) return undefined;
  // Static reports contain data, never executable accessors. Read each known
  // scalar once so validation and output cannot observe different values.
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function booleanFields(value, keys) {
  const result = Object.fromEntries(keys.map(key => [key, field(value, key)]));
  return Object.values(result).every(item => typeof item === 'boolean') ? result : undefined;
}

/** Read only known scalar fields; extension fields cannot enter a report or log. */
export function readMcpReadiness(value) {
  try {
    const version = field(value, 'version'), scope = field(value, 'scope'), configured = field(value, 'configured');
    if (version !== 1 || scope !== 'configuration-only' || typeof configured !== 'boolean') return undefined;
    const required = booleanFields(field(value, 'required'), Object.keys(MCP_REQUIRED));
    const deployment = booleanFields(field(value, 'deployment'), ['connectionKeyProvided']);
    const sourceLimits = field(value, 'limits');
    const limits = Object.fromEntries(MCP_LIMITS.map(key => [key, field(sourceLimits, key)]));
    if (!required || !deployment || Object.values(limits).some(item => !Number.isSafeInteger(item) || item < 1 || item > 512 * 1024 * 1024)) return undefined;
    if (configured !== Object.values(required).every(Boolean)) return undefined;
    return { version: 1, scope: 'configuration-only', configured, required, deployment, limits };
  } catch { return undefined; }
}
export function readOAuthReadiness(value) {
  try {
    const version = field(value, 'version'), scope = field(value, 'scope'), configured = field(value, 'configured'), development = field(value, 'development'), clientMode = field(value, 'clientMode');
    if (version !== 1 || scope !== 'configuration-only' || typeof configured !== 'boolean' || typeof development !== 'boolean' || !['manual', 'cimd', 'unconfigured'].includes(clientMode)) return undefined;
    const required = booleanFields(field(value, 'required'), Object.keys(OAUTH_REQUIRED));
    const deployment = booleanFields(field(value, 'deployment'), Object.keys(OAUTH_DEPLOYMENT));
    if (!required || !deployment || configured && (!Object.values(required).every(Boolean) || clientMode === 'unconfigured')) return undefined;
    return { version: 1, scope: 'configuration-only', configured, clientMode, development, required, deployment };
  } catch { return undefined; }
}

const acceptance = () => [
  { id: 'arena-contract', status: 'not-run', requirement: 'Verify the actual endpoint, OAuth client/discovery, identity contract and authenticated read-tool schemas.' },
  { id: 'exact-sources', status: 'not-run', requirement: 'Retrieve representative STEP, PDF and DOCX bytes; verify frozen BOMs, revisions, file editions/hashes, custom attributes and supplier mappings.' },
  { id: 'user-permissions', status: 'not-run', requirement: 'Test two users with different access, denied sources, refresh/expiry, logout, revocation and workspace changes.' },
  { id: 'deployed-service', status: 'not-run', requirement: 'Verify the same-origin HTTPS proxy, callback, encrypted store, atomic refresh/logout locks, expiration and stable keys across replicas/restarts.' },
  { id: 'installed-chrome', status: 'not-run', requirement: 'Install the emitted extension on a permitted company Chrome profile; run local diagnostics and verify actual Arena launch behavior.' },
  { id: 'representative-files', status: 'not-run', requirement: 'Qualify company CAD/document fidelity and performance on supported laptops, including accelerated graphics and large comparisons.' },
];

/**
 * Does not call authorize/status, OAuth handlers, stores, bindings or fetch.
 * Reports describe trusted deployment code, not its behavior or a user's rights.
 */
export function buildArenaPreflight(provider) {
  const checks = [];
  const add = (id, label, passed, detail) => checks.push({ id, label, status: passed ? 'pass' : 'blocked', detail });
  const mcp = readMcpReadiness(provider?.readiness);
  const oauth = readOAuthReadiness(provider?.oauthAuth?.readiness);
  add('provider.report', 'MCP configuration report', Boolean(mcp), 'A supported configuration-only report is required; an opaque custom provider cannot be assessed by this command.');
  add('provider.configured', 'Viewer data provider configured', Boolean(mcp?.configured && provider?.configured === true && provider?.transport === 'mcp' && provider?.readOnly === true), 'The read-only MCP provider and its required mappings must be configured. This does not test them.');
  for (const [key, label] of Object.entries(MCP_REQUIRED)) {
    const method = key === 'sessionResolver' ? 'authorize' : key;
    const present = ['endpoint', 'approvedReadTools'].includes(key) || typeof provider?.[method] === 'function';
    add(`mcp.${key}`, label, Boolean(mcp?.required[key] && present), 'Configuration presence only; vendor behavior and access are untested.');
  }
  add('mcp.connectionKey', 'Explicit connection signing key', Boolean(mcp?.deployment.connectionKeyProvided), 'A supplied key is required for deployment. Its secure storage and stability across replicas/restarts must be verified separately.');
  add('oauth.report', 'OAuth configuration report', Boolean(oauth), 'The bundled OAuth runtime must expose its configuration report. A custom session bridge needs a separate deployment review.');
  add('oauth.configured', 'OAuth runtime configured', Boolean(oauth?.configured && provider?.oauthAuth?.configured === true && typeof provider.oauthAuth.resolveSession === 'function' && typeof provider.oauthAuth.handleRequest === 'function'), 'Validated local OAuth configuration is required; no discovery, login or identity lookup is attempted.');
  for (const [key, label] of Object.entries(OAUTH_REQUIRED)) add(`oauth.${key}`, label, Boolean(oauth?.required[key]), 'Presence in the OAuth runtime configuration; external acceptance remains untested.');
  add('oauth.productionMode', 'Production session mode', Boolean(oauth && !oauth.development), 'Development memory sessions are unsuitable for a production deployment.');
  for (const [key, label] of Object.entries(OAUTH_DEPLOYMENT)) add(`oauth.${key}`, label, Boolean(oauth?.deployment[key]), key === 'cookieKeyProvided' ? 'Only the presence of a sufficiently sized supplied key is reported; key bytes are never included.' : 'This is a deployment declaration, not an audit of encryption, persistence or distributed locking.');
  const blockers = checks.filter(check => check.status === 'blocked').map(check => check.id);
  return {
    schemaVersion: 1, scope: 'configuration-only', state: blockers.length ? 'blocked' : 'configuration-complete',
    liveAcceptance: 'not-tested', networkChecks: 'not-run', runtimePath: 'hosted-bff',
    checks, blockers, ...(mcp ? { limits: mcp.limits } : {}),
    ...(oauth ? { clientMode: oauth.clientMode } : {}),
    optionalCapabilities: { supplierItems: provider?.capabilities?.supplierItems === true, sourceConversion: provider?.capabilities?.sourceConversion === true },
    acceptance: acceptance(),
    notes: [
      'Configuration-complete permits the next deployment tests; it is not a live connection or production approval.',
      'The preflight does not invoke provider operations. Importing a trusted deployment module can execute its own code; this command is not a network sandbox.',
      'The current live path uses the hosted viewer/BFF. Direct extension-to-MCP authentication is not implemented or qualified by this report.',
      'Read-only MCP does not enable shared comments or saved views. Local viewing and deterministic comparisons require no AI service.',
    ],
  };
}

export function formatArenaPreflight(report) {
  const rows = ['Arena deployment preflight — configuration only', `State: ${report.state}; live acceptance: ${report.liveAcceptance}`, '', 'Status\tCheck\tDetail'];
  for (const check of report.checks) rows.push(`${check.status.toUpperCase()}\t${check.label}\t${check.detail}`);
  rows.push('', 'Acceptance still required');
  for (const gate of report.acceptance) rows.push(`NOT RUN\t${gate.id}\t${gate.requirement}`);
  rows.push('', ...report.notes);
  return `${rows.join('\n')}\n`;
}
