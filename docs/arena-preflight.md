# Arena deployment preflight

Version 0.6 adds a server-side administrator command for the existing hosted viewer/BFF integration. It answers **“Is the required local configuration present?”** before a user attempts live Arena testing. It does not answer whether the configured functions actually map Arena correctly or whether a user can retrieve a file.

## Run it

From an installed source checkout, inspect the deliberately unconfigured example:

```bash
npm run preflight:arena -- --provider server/provider.example.mjs
```

For your trusted, private deployment module:

```bash
npm run preflight:arena -- --provider /absolute/private/provider.mjs
```

For a machine-readable report, use the underlying Node command so npm's own command banner does not enter redirected JSON:

```bash
node server/preflight.mjs --provider /absolute/private/provider.mjs --json > arena-preflight.json
```

The command also accepts the existing server-only `ARENA_PROVIDER_MODULE` environment variable when `--provider` is omitted. An explicit argument takes precedence. Without either, it produces an unconfigured report. `--help` explains the command. No HTTP endpoint is added, and the normal review workspace gains no administrator controls.

| Exit code | Meaning | Next action |
| --- | --- | --- |
| `0` | `configuration-complete`: recognized local configuration passes the presence/contract checks | Begin the separately listed deployment and Arena acceptance tests. This is not production approval. |
| `2` | `blocked`: required configuration is missing, opaque, inconsistent, or unsuitable for production | Inspect the named blockers, complete the private module and rerun. The checked-in example intentionally returns this code. |
| `1` | Invalid arguments, module load/inspection failure, or a stalled module load | Review the trusted module on the server. The report omits raw exceptions and private paths. |

## What it checks

The MCP constructor exposes an immutable configuration report. The preflight accepts its known scalar fields and checks the actual provider method surface. A complete file viewer now requires `readContent` as well as `getSchema`, `resolveBom`, `listRevisions` and `listAttachments`. A metadata-only provider cannot report configured/ready.

| Area | Required local evidence | What is still unverified |
| --- | --- | --- |
| MCP transport | Explicit endpoint, user session resolver, reviewed read-tool allowlist | Reachability, actual catalog and vendor operation semantics |
| Metadata | Schema, exact BOM, revision and attachment binding functions | Real payload mapping, pagination, configuration/edition correctness and custom attributes |
| Original content | `readContent` binding function | Each user's authorized item-file relationship and actual bytes/hash/MIME delivery |
| Connection identity | Explicitly supplied key accepted by the provider | Secret storage and stability across replicas/restarts |
| OAuth | Configured bundled OAuth runtime, client mode, callback, identity resolver, approved origins, store interface | Discovery, client registration/CIMD availability, token resource, login and verified identity behavior |
| Production sessions | Production mode, explicit cookie key, declared production/encrypted/shared store guarantees | Actual encryption, persistence, expiration, atomic consume and distributed locking |

The provider records validated configuration presence; it does not inspect binding implementations. A function that returns unusable data still needs acceptance tests. Store flags are declarations made by trusted deployment code, not an encryption or concurrency audit. A custom session bridge or opaque provider stays blocked by this command until it receives a separate deployment review; this does not remove the existing custom-provider runtime interface.

Supplier items and source conversion are optional declared capabilities. Raw STEP rendering does not require source conversion. Read-only MCP does not enable shared comments, saved views or writes to a hidden Arena attribute.

## Report and privacy boundary

JSON uses schema version `1` and scope `configuration-only`. It contains check IDs, fixed explanatory messages, booleans, validated numeric limits, the client-mode enum and unperformed acceptance gates. It always records `liveAcceptance: "not-tested"`, `networkChecks: "not-run"`, and the currently implemented `runtimePath: "hosted-bff"`. Extra fields, getters and malformed values in reported configuration are rejected or excluded.

The command does not call provider `authorize` or `status`, OAuth handlers, session-store operations, mappings, MCP tools/resources, or file reads. It does not initiate discovery, login, or a network probe. No endpoint, tool name, user/workspace/source identity, private path, token, client secret, signing key or raw exception is copied into the generated report.

**The selected module is trusted server code.** Importing it and calling its `createProvider()` factory can execute its own code, logging, network calls or side effects, just as normal server startup can. This preflight is not a network sandbox or a log scrubber for arbitrary module code. Keep construction free of probes and secret logging. Run only reviewed deployment modules; do not accept a module path from a browser request. The CLI bounds a stalled asynchronous load to 30 seconds and exits after flushing its report so persistent store connections do not keep the one-shot command alive.

The normal authenticated status probe still checks the current user's approved catalog. Its successful state is a connection signal; it cannot certify every binding or every file. Protected content delivery still reauthorizes exact sources and checks their bytes separately.

## Acceptance after configuration is complete

| Gate | Required evidence |
| --- | --- |
| Arena contract | Environment-specific endpoint, OAuth registration/discovery, verified identity and authenticated tool schemas |
| Exact sources | Representative STEP/PDF/DOCX bytes, exact frozen revisions/editions/hashes, BOM placement mapping, custom attributes and supplier relationships |
| User permissions | Two differing permission profiles; denied attachments; refresh/expiry, logout, revocation and workspace changes |
| Deployed service | Same-origin HTTPS proxy, callback, storage protection, expiry/locks and key continuity across deployment replicas/restarts |
| Installed Chrome | Exact emitted package installed on a permitted company profile; local diagnostics and actual Arena launch actions |
| Representative files | SolidWorks/Onshape/Creo and company document fidelity/performance; large comparisons; accelerated graphics and software fallback |

Direct extension-to-MCP authentication remains a separate unimplemented path pending Arena's public-client and file-delivery contract. The static private Preview does not deploy this Node command, the BFF or OAuth callback service. The administrator runs preflight from the source handoff/server deployment.

See [Arena MCP setup](arena-mcp-setup.md), [Chrome qualification](chrome-extension.md), [0.6 plan](release-06-plan.md), and [0.6 verification](release-06-qa.md).
