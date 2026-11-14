# Additional prototype quality check

This is the earlier quality-pass record. See [Universal viewer quality check](universal-viewer-qa.md) for the subsequent document-first workspace.

Completed for the requested second quality pass on the Assembly Review prototype. This record covers the synthetic Preview workspace, visual refinements, concrete defects corrected, and verification actually performed. The hosted preview retains its existing private audience.

## Result

The current code passed TypeScript checking and **64 tests across 10 test files**. The dependency audit reported **zero vulnerabilities** for the checked lockfile. Publication and the final production-build result are confirmed in the handoff after packaging.

The browser pass exercised the real application and its STEP-derived meshes, PDFs, and DOCX documents. It also uncovered a Word text-extraction regression that the initial unit checks did not detect; that was fixed and the actual document comparison was verified again.

Updated review workspace (historical screenshot omitted from this source export)

## Visual and usability improvements

| Area | Change |
| --- | --- |
| Readability | Increased task labels, BOM descriptions, review text, and table type. Darkened secondary text and document additions/removals. Preserved the navy, teal, and neutral engineering palette. |
| Control hierarchy | Clearer active states, more consistent spacing, rounded tool groups, stronger selected BOM rows, and larger compact controls. |
| Comparison plus section | Revision legend, opacity sliders, and section controls now flow vertically without occupying the same screen space. |
| Narrow layouts | Model, BOM, and reference panels become full-width sections on narrow screens, with section navigation. Compact desktop layouts place references below the model/BOM row. |
| Saved views on small screens | Workspace settings now provides access to saved views when the compact heading hides the desktop shortcut. |
| Keyboard access | Stable names and pressed states remain available when button text is hidden. The reference divider resizes with arrow keys. Save view opens with the name field focused. Dialog focus excludes hidden/disabled fields. |
| Source clarity | Removed components show baseline properties. Shared component selection in a comparison explicitly identifies the proposed-revision properties. |

The layout was checked at desktop width and effective CSS viewport widths of **1,085, 448, and 334 pixels** using Chrome's ordinary zoom controls. The measured document scroll width did not exceed the viewport at the compact widths. These are browser layout checks, not physical phone/tablet or touch-device certification.

## Functional defects corrected

| Issue | Corrected behavior |
| --- | --- |
| Previous geometry could be picked during a revision load | Selection, measurement, and model anchoring wait for the requested source. A gesture begun against the previous source is discarded. |
| A drag ending near its starting point could be treated as a click | Track movement throughout the gesture; drags, pinches, and cancelled gestures do not create accidental selections or anchors. |
| Invisible overlay components retained selected edge outlines | Edge opacity now follows effective component opacity. |
| A hidden/unloaded selection could display the remaining assembly's bounds | Bounds are restricted to the visible selected geometry. Unavailable selection bounds are not replaced with the assembly envelope. |
| Starting a new measurement retained the old numeric result | The previous result clears as soon as the next pair begins. |
| Previous document content could remain under a new source label | Exact file identity, revision, edition, hash, and URL create fresh render state. PDF markup waits for the current page and text layer; DOCX waits for its current render. |
| Word comparison extraction depended on visible rendered text | Extraction reads semantic page paragraphs independently of temporary rendering visibility. Injected style content is excluded. |
| Word comments always recorded page one | Comments use the clicked reflowed page and page-relative location. Page numbering is explicitly labeled as browser reflow. |
| Attachment errors exposed converter internals | Friendly error text and a working Retry document action replace raw parser messages and implementation links. |
| Workspace changes retained unrelated tool/reply state | Workspace transitions reset transient scene/document tools and protect unsent note/reply drafts. Replies are kept per finding. Orphaned replies from another tab remain available for recovery. |
| Saved comparisons lost removed baseline selection/visibility | Restore validates selection and visibility against both compared configurations, while loaded proposed models remain scoped to the proposed BOM. |
| An imported saved view could compare A with A under A/B labels | Invalid baseline-plus-comparison states are rejected. |

## Observed browser checks

| Workflow | Observed result |
| --- | --- |
| Select base and show bounds | **180.0 × 136.0 × 8.0 mm** for the proposed base. Hiding that selection removed the bounds card instead of showing other parts. |
| Point measurement | Two visible plate points produced **140.42 mm**. A third point cleared that result and prompted for the second point of the next measurement. The value is mesh-derived and approximate. |
| Overlay plus section | Baseline/proposed geometry, opacity controls, and the Z section were visible together without overlapping controls. |
| Side by side | Both real configurations rendered; camera interaction remained linked. |
| Removed-component properties | The removed fastener showed its released baseline configuration, material, occurrence position, and source hash. |
| Save/restore baseline visibility | Saved an overlay with the removed fastener selected and hidden, reset, and restored it. Selection and the hidden state returned. |
| PDF pages and zoom | Page two and 125% zoom rendered successfully. |
| PDF comparison | Actual source documents produced **29 extracted-text changes**. |
| Word source switching | Rapid A/B changes discarded obsolete content and rendered the requested source. |
| Word comparison | Actual source documents produced **22 paragraph-level text changes**, including width, motor datum, fastener quantity, and sensor requirements. |
| Word page-two comment | A posted comment retained edition one and reflowed page two. Reopening the reference navigated to the second-page location. |
| Unavailable attachment recovery | Temporarily made a local DOCX fixture unavailable, observed the error without stale content, restored the identical fixture, and successfully retried. No fixture changes were left behind. |
| Reply drafts | Typed a reply, opened another finding, returned, and recovered the original draft. Attempting to change workspace while that draft existed was blocked with a clear message. |
| Workspace-dependent attributes | Medical Device Lab displayed its distinct field definitions and values. The previous section tool and selection state were reset. |
| Reference sizing | Keyboard resizing changed the panel from **382 to 402 px**, and back. |
| Follow selection | Selecting the base opened its exact revision-B drawing. |
| Dialog keyboard behavior | Shift+Tab remained inside the comparison dialog; Escape closed it. |
| Narrow-screen saved views | Opened the saved-view list from Workspace settings at the narrow layout. |

Verified Word comparison (historical screenshot omitted from this source export)

Preview notes and views created during these checks belong to the local QA browser. They do not become shared production review records or alter the seeded fixtures.

## Automated coverage added

Six new engine interaction tests use actual Three.js geometry, raycasting, and the software-rendering path through simulated canvas events. They cover drag-versus-click behavior, cancelled/pinch gestures, stale-source anchoring, gestures spanning a source transition, measurement resets, and fully transparent outlines. Additional regressions cover unavailable selection bounds and invalid saved comparison states.

The preexisting checks for source hashes, repeated occurrence transforms, dynamic attributes, review validation, storage failures, text differences, and fail-closed Arena server behavior also passed.

## Verification limits

The cloud Chrome environment does not provide WebGL2. Browser geometry checks used **Software 3D**, which renders the original STEP-derived triangles but approximates intersecting depth and transparency. The accelerated GPU path, real mobile touch gestures, large customer assemblies, and representative customer CAD exports still require their own acceptance checks.

This quality pass does not connect to Arena or validate a customer's permissions, API mapping, hidden-field writes, Chrome attachment-click routing, or authenticated multiuser collaboration. Those remain integration work. Exact B-rep measurement, arbitrary STEP conversion, and legacy `.doc` conversion remain outside the current prototype.

The automated audit is a point-in-time dependency result, not a guarantee against unknown or future vulnerabilities. See [the original verification record](verification.md), [test guide](test-guide.md), and [Arena integration boundary](arena-integration.md) for the broader scope.
