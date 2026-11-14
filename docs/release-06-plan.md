# Version 0.6 — configuration preflight and regression repair

Starting source: `d4b32e008703849f731f6878a02536ebf844c9fe` (0.5.0).

## Goal

Make the existing Arena integration ready for an honest deployment handoff. Distinguish present configuration from successful user authorization, exact file delivery, and installed Chrome qualification. Close the concrete document, model-lifetime, and transport defects found in an independent review before adding another review workflow.

## Scope and acceptance

| Workstream | Deliverable | Acceptance |
| --- | --- | --- |
| Provider readiness | A frozen, sanitized description of required bindings and operational limits. File delivery is required for a configured file viewer. | Missing `readContent` cannot report ready; report contains no endpoints, tool names, tokens, user/workspace IDs or source data. User-specific catalog checks remain authorized. |
| Deployment preflight | An administrator command that inspects configuration reports without calling authentication, catalog, business-data or file operations. | Report separates configuration checks, declared production-store guarantees, and unperformed Arena/Chrome acceptance. Unknown/custom reports fail closed. Output and errors use a closed schema. |
| Rate limiting | Preserve an upstream HTTP 429 as a safe viewer `RATE_LIMITED` response. | Actual MCP SDK synthetic-wire regression; no upstream body, automatic retry, or token exposure. |
| PDF physical dimensions | Retain page-size changes even when the common-scale raster rounds to identical dimensions. | A zero-pixel-change pair with different physical dimensions still reports a size change in both detail and overview. |
| Model resource ownership | Release imported geometry when all references fail placement validation. | Invalid current/baseline occurrences cannot retain unused geometry or its budget charge; successful shared occurrences retain their geometry. |
| STEP transport ownership | Discard source responses delivered after cancellation or the existing acquisition deadline. | Late responses cannot retain an unowned body or start a CAD worker; stalled cancellation remains nonblocking. |

The preflight imports a trusted server deployment module, just as server startup does. The preflight itself makes no network calls and never invokes provider operations. It is not a sandbox: a private module can perform its own work during import/construction. The command must run only against reviewed deployment code on the server. A complete configuration report is not a live connection or production approval.

## Deliberately separate acceptance work

Real Arena endpoint/client configuration, authenticated tool mappings, file delivery, two-user authorization/revocation, and actual attachment routes still require the vendor environment. The installed-extension gate also remains open: this environment rejected `chrome://extensions/` and forbids alternate routes around that restriction. Hosted checks cannot replace an installed-package test.

The next independent document capability is a reviewer-controlled page-pair map for inserted/reordered PDF pages. Existing same-number overview pairing remains disclosed; this phase does not add inferred alignment, OCR, legacy DOC conversion, retained B-rep measurement, or shared review writes.

## Verification

Use focused failing regressions, independent review of the new preflight boundary, the full type/test check, supported production build, extension-package validation, and a concise supported browser regression. Keep the current private Site audience and publish both matching source and extension artifacts. Record results in `release-06-qa.md`.

## Delivered

All scoped workstreams are implemented. The full check passed **561 tests across 46 files** plus TypeScript; production and extension builds passed. Hosted regression retained PDF overview/text tools, Word source/redline review and the combined STEP/document workspace. All five actual bundled-engine checks passed. The example preflight correctly remains blocked, and no Arena or installed-Chrome pass is claimed. See [0.6 verification](release-06-qa.md) for defects, evidence, the artifact checksum and next eligible phases.
