# Preview fixture provenance

All geometry and documents in `public/fixtures` are original synthetic test data generated for this prototype. They contain no customer CAD or PLM records.

## Rebuild

Use Python 3.11 or later with these fixture-generation dependencies:

```text
cadquery==2.7.0
cadquery-ocp==7.8.1.1.post1
reportlab==4.4.9
python-docx==1.2.0
```

Run `python3 scripts/generate-fixtures.py` from the repository. The generated files are committed; running the viewer does not require Python or a CAD kernel.

The generator constructs solid CAD geometry, writes real ISO 10303 STEP files, imports those files again using Open CASCADE, validates the imported solids and volumes, and tessellates the imported B-rep. JSON meshes contain local coordinates in millimeters. Occurrence placement stays in the manifest and is never baked into each reusable part mesh. Materials are explicit fixture metadata; they are not inferred from display colors.

Each part includes the SHA-256 of the exact STEP source, its B-rep volume, its CAD bounding box, and tessellation settings. The mesh has a requested linear deflection of 0.1 mm and angular deflection of 0.15 radians. Point measurements on displayed triangles are approximate. Validation results are embedded in the manifest.

Bounding boxes use `BRepBndLib.AddOptimal` with `useTriangulation=false` and `useShapeTolerance=false`. This measures the underlying B-rep geometry independently of cached display tessellation and does not add shape-tolerance padding. Open CASCADE still uses numerical geometry tolerance; exported minima round down and maxima round up to nine decimal places to preserve the computed envelope. The generator does not snap arbitrary shapes to nominal dimensions. The fixture plate therefore reports 180 × 120 × 8 mm in A and 180 × 136 × 8 mm in B, without the display mesh deflection inflation. The viewport transforms and unions these part boxes, so a rotated assembly's result remains an envelope of part boxes rather than a minimum oriented bounding box.

## Assembly configuration

The global frame is right-handed, millimeters, Z up. Every occurrence includes its own translation and XYZ Euler rotation in radians. The JSON meshes are not independently centered. The repeated fastener uses a single reusable part source and separate placements. Combined assembly STEP exports are supplied alongside individual part STEP files.

| Item | Revision A configuration | Revision B configuration |
| --- | --- | --- |
| PLT-1001 Mounting plate | Part A, width 120 mm | Part B, width 136 mm |
| MTR-2001 Motor | Part A, X datum -42 mm | Same part A, X datum -38 mm |
| GBX-2002 Gearbox | Part A | Same part A |
| SFT-2003 Shaft | Part A | Same part A |
| CVR-1002 Cover | Part A, six vent slots | Part B, nine vent slots |
| HW-3001 Fastener | Four occurrences, part A | Three occurrences, part A |
| SNS-4001 Sensor | Not installed | New occurrence, part A |

## Intentional review findings

The revision B specification changes the installed maximum width from 125 to 140 mm. The sensor requirement says X = 61.0 +/- 0.5 mm, while the sensor occurrence is placed at X = 65.0 mm. This is an intentional model/document discrepancy to exercise comments and cross-references. The missing fourth fastener is also an intentional review scenario, not a recommendation for a production design.

The PDF and DOCX files are real document formats, with two pages per edition. They support model-plus-spec review, document revision comparison, and source-specific notes. No `.doc` legacy binary fixture is supplied; legacy Word conversion requires a future conversion service.

The fixtures are meant to validate viewer behavior and data flow. They are not manufacturing-ready mechanical designs. No engineering analysis, service life, structural strength, or tolerance stack is implied.
