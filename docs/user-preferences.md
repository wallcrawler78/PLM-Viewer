# Viewing preferences and roadmap

The 0.7 preference layer stores a small set of viewing defaults in the current browser. Documents and models share the same controls, while source selection, review findings and connection policy retain their existing ownership.

This document records implemented behavior, the boundaries that future preferences must preserve, and the next useful settings. Browser, installed Chrome and live Arena acceptance are reported separately in the [release verification record](release-07-qa.md).

## Implemented defaults

Open **Workspace settings → Viewer preferences**, or the preferences button in the **Local file review** header. Both surfaces use the same store. The local dialog can change graphics quality while files remain open; its Close button and Escape return to the existing workspace.

| Setting | Stored field and default | When it applies | Meaning |
| --- | --- | --- | --- |
| Document comparison | `documentComparison: "pages"` | A comparison pair mounts | Start with **Side by side**; **Text redline** is the alternative. This does not enable comparison, choose a baseline or replace an exact launch source. |
| Linked scrolling | `linkedScrolling: true` | A comparison pair mounts | Begin with linked source-page navigation. The comparison toolbar can change it for the open pair. |
| Source highlights | `sourceHighlights: true` | A comparison pair mounts | Begin with extracted-text change highlights in the source pages. This is separate from the PDF visual-difference mask. |
| 3D rendering | `renderQuality: "standard"` | Immediately for mounted model viewports; also when opening one | Standard preserves the backing-raster limits of two device pixels per CSS pixel in WebGL and 1.5 in software mode; **Economy** caps it at one. Devices already at or below one have no raster reduction. |

The document choices are initial values in `ComparisonReview`, keyed by the exact source pair. Changing defaults in Settings, resetting preferences or receiving another tab's update leaves an already open pair's layout, linked scrolling and highlights unchanged. Closing and reopening comparison creates a new pair session and reads the current defaults. Toolbar choices remain local to that pair; they do not silently become future defaults. See [DocumentWorkspace.tsx](../src/components/DocumentWorkspace.tsx).

Graphics quality is presentation state. It does not change STEP tessellation, imported geometry, coordinate units, measured values, picking coordinates, file identities, document text comparison, PDF visual-comparison resolution or sensitivity. The engine changes the backing raster without requesting a new source. Both the primary model workspace and local file review pass the setting to the same engine. See [App.tsx](../src/App.tsx), [LocalFileWorkspace.tsx](../src/components/LocalFileWorkspace.tsx), [model/types.ts](../src/components/model/types.ts) and [model/engine.ts](../src/components/model/engine.ts).

## Scope and precedence

“This browser” means this browser profile and this viewer origin's `localStorage`. The hosted viewer and packaged extension have different origins and therefore separate preference storage. Different Arena accounts and workspaces using the same hosted viewer origin share these four non-sensitive defaults. This first version makes no account, device or cross-origin synchronization promise.

The store accepts only the four scalar fields above. It contains no user identity, workspace ID, item number, source URL, file name, revision, hash, search text, geometry, document content, comment or credential. Adding workspace-specific or account-specific information requires a separate scoped design; a general browser preference must not become an implicit source cache.

| Decision | Authority |
| --- | --- |
| Whether a source may be read and which exact bytes are available | The authenticated provider, source validation and permission checks. Preferences never expand access or provide a fallback source. |
| Which source and initial workspace open | Explicit launch context, including item/revision/file/edition/hash and the requested document/model/Together view. An untargeted launch uses the application's existing defaults. |
| Returning to a saved review | The user's explicit restoration action, after exact document and baseline references are resolved. Persisted view fields override ordinary initial layout choices. |
| An open document pair's toolbar state | The current pair session. Browser defaults seed a newly mounted pair only. |
| A new pair with no saved value for a particular presentation option | The applicable browser default, followed by the built-in default if no valid value is available. |
| Raster quality | The current browser preference. Saved review views do not capture this device-oriented choice. |

Launch resolution is in [launch-context.ts](../src/launch-context.ts) and [integrations/liveWorkspace.ts](../src/integrations/liveWorkspace.ts). Saved-view validation and exact-source restoration are in [view-state.ts](../src/view-state.ts) and [App.tsx](../src/App.tsx). The precedence rule applies only to fields the saved-view schema actually captures. It currently records the document comparison flag and exact sources, but does not record the pages/redline/visual subview, linked scrolling, highlight toggle, reader page/search/zoom, or PDF visual-comparison controls. Complete document-session restoration would need explicit versioned saved-view fields and validation.

## Storage and recovery

[preferences.ts](../src/preferences.ts) owns validation and persistence. [ViewerPreferences.tsx](../src/ViewerPreferences.tsx) supplies one shared provider, reactive snapshots and same-origin storage-event handling. [main.tsx](../src/main.tsx) mounts it around the application; local file review inherits that provider.

The key is `review-studio.preferences.v1`, with this payload shape:

```json
{
  "version": 1,
  "preferences": {
    "documentComparison": "pages",
    "linkedScrolling": true,
    "sourceHighlights": true,
    "renderQuality": "standard"
  }
}
```

Reads are bounded to 4,096 UTF-8 bytes. Only known own data properties with supported enum or boolean values enter state. Missing known fields use built-in defaults; unknown fields are ignored and never enter the serialized preference object. A load does not rewrite stored bytes.

| Storage condition | In-memory behavior | Stored-data behavior and feedback |
| --- | --- | --- |
| No saved value | Use the built-in defaults | Do not create a record until an explicit change. |
| Valid version 1 | Read supported values | Explicit changes save the four-field allowlist. Settings says preferences are saved in this browser. |
| Corrupt JSON, invalid known fields, unsupported old/invalid version or oversized value | Use defaults on initial load; preserve current choices if the problem appears later | Preserve the original bytes. Changes work for the session; Settings explains that explicit Reset is required to replace the saved settings. |
| A newer integer version | Use defaults on initial load; preserve current choices if discovered later | Preserve the newer payload instead of downgrading it. Changes remain in memory until an explicit reset or a valid store becomes available. |
| Storage access denied or unavailable | Continue with session choices | Do not fail the viewer. Settings reports session-only persistence. |
| A write fails, including quota failure | Keep the user's changed values in the current session | Preserve existing bytes. Pending session overrides are retained if a later change can be saved. |
| Reset succeeds | Apply the built-in defaults | Remove only the preference key. Review notes, saved views, launcher settings and unrelated storage are untouched. |
| Reset cannot remove the key | Apply the built-in defaults for the session | Preserve the existing bytes and show the session-only message. |

Other tabs on the same origin receive safe storage changes through the `storage` event. The provider rereads current storage and never echoes an event back as a write. An explicit edit merges the latest valid saved values with pending session overrides before applying the new field change. This avoids sequential lost-field updates, but `localStorage` is not a transactional multiuser store: truly simultaneous writes can still race. Invalid or future-format events preserve the active choices and surface their status.

Reset is intentionally a separate action from review-data recovery. The existing preview [reviewStore.ts](../src/data/reviewStore.ts) retains its workspace isolation, validation, stale-write and explicit import/recovery rules. Neither store supplies authenticated team collaboration.

## Recommended next preferences

Keep the settings surface compact. Promote a setting to a persistent default only when it helps repeated review work and has a clear scope; contextual controls should stay beside the content they affect.

| Priority | Preference | Recommended behavior | Implementation boundary and acceptance |
| --- | --- | --- | --- |
| Next | Length display units and decimal precision | Start with millimeters/inches and a small explicit precision choice. Show the unit beside each displayed value. | Create one formatter for main/local measurement cards, bounding dimensions, section offsets and displayed model coordinates. Geometry, placement transforms and anchors remain millimeters internally. API attribute values retain their declared units; never relabel an attribute without a valid type-aware conversion. Precision must not imply exact B-rep measurement. |
| Next | BOM column visibility and order | Remember a user's preferred columns for a verified workspace/schema. | Key by verified workspace/schema identity and opaque attribute IDs, not labels. Filter removed or inaccessible attributes and preserve item-versus-BOM-line scope. Resolve account-sharing expectations before storing this data. Restored saved-view columns remain authoritative for that view. |
| Next | CAD navigation and trackpad controls | Offer clearly named interaction presets, with an easy return to the default. | Map orbit/pan/zoom gestures and input direction consistently; verify mouse and trackpad behavior. Never change the source's world frame, model alignment or a saved camera merely to match a navigation preset. |
| Following | Document fit policy and zoom default | Distinguish fit width, fit page and an explicitly defined percentage mode. | Current `zoom = 1` means width fit, so the existing percentage is a multiplier of fitted width. Define semantics before promising actual-size 100%. Preserve source anchors through PDF scale changes and DOCX reflow; seed new readers rather than disrupting an open page. |
| Following | Appearance, contrast and density | Add a coordinated theme/contrast/density choice when both document and model surfaces can support it. | Keep source document colors and difference colors meaningful. Respect existing OS reduced-motion support. Check all states, focus indicators and comparison legends together rather than adding isolated toggles. |
| Later | Initial workspace and panel layout | Seed an untargeted opening with a preferred workspace, navigator visibility or split. | Exact document/STEP launches and restored views win. Keep responsive constraints and the existing split limits; avoid reopening a remembered source automatically. |
| Later | Account synchronization | Use an authenticated preference service if customers need settings across browsers. | Define verified principal/workspace scope, conflict behavior, disconnect lifecycle and policy precedence first. The UI must continue to distinguish synchronized settings from this browser's choices. |

Current reasons for these priorities are visible in the code. Measurement and section labels use millimeters with differing hardcoded precision in [ModelViewport.tsx](../src/components/ModelViewport.tsx), [LocalFileWorkspace.tsx](../src/components/LocalFileWorkspace.tsx) and [App.tsx](../src/App.tsx). BOM columns start from each schema attribute's `defaultVisible` value when loading a workspace, and saved-view restoration already filters column IDs against the current schema. [Documents.tsx](../src/components/Documents.tsx) owns width-fit zoom, page and search state. [styles.css](../src/styles.css) and [model/viewport.css](../src/components/model/viewport.css) already honor reduced motion.

## Keep these source-bound

Exact item/occurrence identities, selected revisions and baselines, page correspondence, camera pose, hidden/loaded components, opacity, section position, explosion and annotation anchors belong to the active review or its validated saved view. A global preference must not carry them into another source or Arena connection.

PDF visual sensitivity and overlay blend also remain visible comparison controls. They influence how a specific pair is inspected; Economy must not silently relax the difference threshold or comparison coverage. [VisualDocumentComparison.tsx](../src/components/VisualDocumentComparison.tsx) owns these controls separately from the source-text highlight default. Changing them must retain the existing invalidation and coverage rules.

Do not add an automatic “compare against latest” preference without a verified baseline-resolution contract. A file GUID or part number alone does not establish an exact revision pair, and a stored default cannot resolve missing historical access.

## Keep these under connection or administrator policy

Permissions, user-bound authorization, MCP endpoints and reviewed read-tool mappings, allowed origins, credential/session handling, exact content delivery, worker/file/size limits and any enterprise content-retention rules belong to the deployment and provider boundary. Users must not be able to bypass them with a viewing preference. See [arena-integration.md](arena-integration.md), [server/mcp-provider.mjs](../server/mcp-provider.mjs) and [integrations/protectedContent.ts](../src/integrations/protectedContent.ts).

Export restrictions, shared annotation persistence or mandatory retention policy would require their own enforceable design if requested; a disabled UI control or hidden Arena field is insufficient. Extension launch configuration remains separate from the preference payload. Nothing in this implementation introduces Arena writes, account synchronization or a shared review service.

## Verification status and next checks

The focused [preferences.test.ts](../tests/preferences.test.ts) suite passed **19 tests** during implementation. It covers safe reads, bounded/allowlisted data, malformed and newer versions, unavailable storage and failed writes, cross-tab refresh/merge behavior, reset isolation, failed reset, stable immutable snapshots and rejecting accessor-based patches.

Code review confirmed that the provider encloses the main and local-file routes, both model surfaces receive graphics quality, and document defaults use state initializers on an exact-pair mount. This is source-level evidence. It does not establish visual layout, keyboard behavior, installed Chrome support, representative large-file performance or live Arena readiness.

The integrated release check should verify preference persistence after reload, another tab's safe update, session-only feedback, reset leaving review data intact, current-pair overrides surviving changed defaults, new pairs taking the defaults, and the local dialog's Escape/focus behavior. Exercise Standard/Economy with an open model and measurement; source, camera and measured values should remain stable. Check the settings layout at narrow viewport sizes and preserve access to every control through scrolling. Run the repository's type/test and build gates and record their actual results with the rest of the release QA.
