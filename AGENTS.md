# Development instructions

## Product and scope

This repository is an Assembly Review prototype for Arena-oriented BOM, CAD, and document review. Preview mode uses original synthetic fixtures. Preserve a clear distinction between implemented preview behavior, integration scaffolding, and verified live capability. Read `README.md`, `docs/arena-integration.md`, and the relevant source before changing behavior.

Keep UI language about the review task. Explain precision, unavailable sources, and current integration state where they affect a decision. Do not present demo people as authenticated collaborators or review prompts as validated engineering findings.

## Integration boundary

- Preview must remain usable without Arena credentials and must not contact Arena.
- A live-mode launch must fail closed when the workspace provider is absent, unauthorized, or invalid. Never substitute preview data after a live error.
- `/api/viewer/v1` is the viewer-owned BFF contract. Verify current Arena API details before implementing a provider; do not guess endpoints or request payloads.
- Keep credentials and session tokens on the authorized server. Do not add them to source, Git history, browser storage, the extension, logs, or client environment variables.
- A broad service account is not proof of each human viewer's access. Authorize source reads and review writes in the proper user/workspace context.
- This portable checkout omits deployment identity and is for local/extension development. Do not create or alter a hosted deployment as part of extension qualification. If working in a separately authorized Sites checkout that contains `.openai/hosting.json`, preserve its project identity and audience and use its supported source/package/deployment workflow.

## Domain and geometry

- Use `src/domain.ts` contracts and validation at data boundaries. Keep fixture and Arena providers interchangeable at that boundary.
- Treat attribute IDs as opaque identities. Labels, types, units, options, default visibility, and item/BOM-line scope come from the workspace schema. Preserve zero, false, and missing as distinct values.
- Resolve exact assembly snapshots, child item revisions, file editions, and source hashes. Never replace an unavailable source with the latest file silently.
- A component occurrence has its own identity and placement. Do not use part number alone as a scene key, derive poses from quantity, or independently center parts.
- The renderer consumes millimeters, Z up, right-handed coordinates and XYZ Euler rotations. Convert other source frames explicitly. Omitted/`world` placementSpace preserves world poses; explicit `parent` poses use the shared normalizer before the flat renderer. Parent IDs alone do not imply relative coordinates. Keep CAD sourceToPart normalization independent and never apply a parent transform twice.
- Loading, hiding, transparency, sections, and explosion are review/display state; they do not modify the BOM. Avoid double-loading child geometry already represented by an assembly occurrence.
- Preserve the distinction between approximate mesh-point distances, CAD-derived bound envelopes, and future exact B-rep measurements. Materials must come from declared metadata, not visual colors.

## Documents and reviews

- Keep document identity, revision, edition, and hash with its pane and anchors. A pinned file can intentionally differ from the active assembly revision; label both clearly.
- Model anchors use occurrence-local coordinates and exact source context. Do not carry them to a new revision without an explicit remapping workflow.
- Suggested notes remain editable drafts until the user posts them. Do not overwrite an existing draft with a new suggestion.
- `LocalReviewStore` is preview persistence, not a transactional multiuser service. Preserve validation, workspace isolation, size limits, stale-write errors, and recoverable corrupt/quota states.
- Import replaces local review data only through the explicit UI operation. Do not silently clear invalid stored data or erase a user's draft after a failed save.
- A hidden UI field is not an authorization boundary. An Arena custom-attribute store is only an option after verifying capacity, rights, revision lifecycle, and concurrency behavior.

## Implementation and verification

- Keep changes scoped and preserve existing behavior outside the request. Use the lockfile and avoid unrelated dependency churn.
- Prefer accessible labeled controls, keyboard operation, meaningful loading/error/empty states, and cancellation of obsolete async work.
- Run `npm run check` and `npm run build` for substantive code changes. Add or adjust behavioral tests for concrete source-resolution, transform, validation, persistence, and integration risks; avoid tests that only mirror implementation details.
- Use `docs/test-guide.md` for browser verification of affected workflows. Report checks actually run and any remaining verification limit.
- When changing generated fixtures, update the generator and regenerate STEP, meshes, documents, hashes, and manifest together. Preserve the export/import/validate/tessellate pipeline. Inspect all changed document pages after rendering.
- Keep customer files, credentials, generated dependency folders, and build outputs out of source control. The included synthetic fixture sources and derived assets are intentional tracked test data.

The user's current instructions determine task scope and authorization. These conventions do not create permission to send messages, alter access, or operate on a live PLM workspace beyond that scope.
