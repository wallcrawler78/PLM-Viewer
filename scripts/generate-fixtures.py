#!/usr/bin/env python3
"""Generate original, synthetic STEP fixtures and document revisions.

Every display mesh is tessellated from the STEP file after it is imported again.
The demo is deliberately small; no proprietary source models are included.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

import cadquery as cq
import OCP
import reportlab
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from docx import Document
from docx.shared import Inches, Pt, RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

# Embed a TrueType font so documents render identically without PDF core-font substitution.
FONT_ROOT = Path(reportlab.__file__).parent / 'fonts'
pdfmetrics.registerFont(TTFont('FixtureSans', str(FONT_ROOT / 'Vera.ttf')))
pdfmetrics.registerFont(TTFont('FixtureSans-Bold', str(FONT_ROOT / 'VeraBd.ttf')))

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'fixtures'
for folder in ['step', 'meshes', 'documents']:
    (OUT / folder).mkdir(parents=True, exist_ok=True)

def cx(radius, length, x0=0):
    return cq.Workplane('YZ').circle(radius).extrude(length).translate((x0, 0, 0))

def base(rev):
    width = 120 if rev == 'A' else 136
    part = cq.Workplane('XY').box(180, width, 8, centered=(True, True, False)).edges('|Z').fillet(5)
    y = 45 if rev == 'A' else 53
    for x1 in [-75, 75]:
        for y1 in [-y, y]:
            part = part.cut(cq.Workplane('XY').circle(4.3).extrude(10).translate((x1, y1, -1)))
            part = part.cut(cq.Workplane('XY').circle(7).extrude(3).translate((x1, y1, 5)))
    for x1 in [-42,42]:
        for y1 in [-20,20]:
            part = part.cut(cq.Workplane('XY').circle(2.5).extrude(10).translate((x1,y1,-1)))
    return part

def motor():
    part = cx(26, 78, -39)
    for x in range(-32, 34, 8):
        part = part.union(cx(29, 2, x))
    part = part.union(cx(25, 4, -43)).union(cx(22, 4, 39))
    foot = cq.Workplane('XY').box(54, 52, 8).translate((0, 0, -30))
    part = part.union(foot)
    terminal = cq.Workplane('XY').box(28, 24, 12).edges('|Z').fillet(2).translate((-5, 0, 30))
    return part.union(terminal)

def gearbox():
    part = cq.Workplane('XY').box(72, 70, 62).edges('|Z').fillet(5)
    part = part.cut(cx(24, 62, -31)).cut(cx(10, 80, -40))
    for y in [-25,25]:
        for z in [-20,20]:
            part = part.cut(cx(2.5, 80, -40).translate((0,y,z)))
    # Open top pocket makes section and transparency inspection meaningful.
    part = part.cut(cq.Workplane('XY').box(50, 44, 25, centered=(True,True,False)).translate((0,0,17)))
    return part

def shaft():
    part = cx(9, 49, -5).union(cx(14, 8, 0))
    part = part.cut(cq.Workplane('XY').box(27, 5, 5).translate((29,0,9)))
    return part.union(cq.Workplane('XY').box(23, 4, 5).translate((29,0,8)))

def cover(rev):
    part = cq.Workplane('XY').box(72,70,5,centered=(True,True,False)).edges('|Z').fillet(5)
    slots = 6 if rev == 'A' else 9
    for i in range(slots):
        x = (i-(slots-1)/2) * (7 if rev == 'A' else 5)
        cut = cq.Workplane('XY').center(x,0).slot2D(31,2.2,90).extrude(7).translate((0,0,-1))
        part = part.cut(cut)
    for x in [-29,29]:
        for y in [-27,27]:
            part=part.cut(cq.Workplane('XY').circle(2.2).extrude(7).translate((x,y,-1)))
    return part

def fastener():
    part=cq.Workplane('XY').circle(3.8).extrude(11)
    part=part.union(cq.Workplane('XY').circle(6.2).extrude(5).translate((0,0,11)))
    return part.cut(cq.Workplane('XY').polygon(6,5).extrude(4).translate((0,0,13)))

def sensor():
    foot=cq.Workplane('XY').box(22,22,4,centered=(True,True,False)).edges('|Z').fillet(2)
    post=cq.Workplane('XY').box(22,4,29,centered=(True,True,False)).translate((0,9,0))
    body=cq.Workplane('XZ').circle(6).extrude(19).translate((0,10,22))
    connector=cq.Workplane('XZ').circle(4.5).extrude(6).translate((0,16,22))
    return foot.union(post).union(body).union(connector)

DEFS=[
 ('base','PLT-1001','Mounting plate','A','#8ca1b8','Aluminum 6061-T6',base('A')),
 ('base','PLT-1001','Mounting plate','B','#8ca1b8','Aluminum 6061-T6',base('B')),
 ('motor','MTR-2001','Brushless motor','A','#24485e','Aluminum housing',motor()),
 ('gearbox','GBX-2002','Gearbox housing','A','#b4c7d5','Aluminum A380',gearbox()),
 ('shaft','SFT-2003','Output shaft','A','#d0d9df','Stainless steel 17-4 PH',shaft()),
 ('cover','CVR-1002','Ventilated cover','A','#576f82','Aluminum 5052-H32',cover('A')),
 ('cover','CVR-1002','Ventilated cover','B','#576f82','Aluminum 5052-H32',cover('B')),
 ('fastener','HW-3001','M8 socket fastener','A','#47515d','Alloy steel',fastener()),
 ('sensor','SNS-4001','Position sensor and bracket','A','#df9b42','Stainless steel bracket',sensor()),
]

def normalize_step(path):
    text=path.read_text()
    text=re.sub(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", '2026-01-01T00:00:00', text)
    path.write_text(text)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def bounds(shape):
    # CadQuery BoundingBox() can include cached triangulation deflection after
    # tessellation. Compute directly from underlying geometry instead. Keep
    # conservative decimal rounding; do not snap arbitrary geometry to nominal
    # design dimensions. OCCT still uses its numerical geometry tolerance.
    box=Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped,box,False,False)
    values=box.Get()
    return {
        'min':[math.floor(value*1e9)/1e9 for value in values[:3]],
        'max':[math.ceil(value*1e9)/1e9 for value in values[3:]],
    }

BBOX_METHOD='Open CASCADE BRepBndLib.AddOptimal; useTriangulation=false; useShapeTolerance=false'

parts=[]
shape_map={}
checks=[]
for id,number,name,rev,color,material,wp in DEFS:
    stem=f'{id}-{rev}'
    path=OUT/'step'/f'{stem}.step'
    cq.exporters.export(wp,str(path),exportType='STEP')
    normalize_step(path)
    imported=cq.importers.importStep(str(path)).val()
    original=wp.val()
    assert imported.isValid(),f'Invalid round-trip STEP: {stem}'
    assert abs(imported.Volume()-original.Volume()) < max(0.001,original.Volume()*1e-7),stem
    geometry_bounds=bounds(imported)
    vertices,triangles=imported.tessellate(0.10,0.15)
    assert bounds(imported)==geometry_bounds,f'Tessellation changed CAD bounds: {stem}'
    if id=='base':
        expected=[180,120 if rev=='A' else 136,8]
        assert all(abs(geometry_bounds['max'][i]-geometry_bounds['min'][i]-expected[i])<1e-6 for i in range(3)),f'Incorrect base dimensions: {stem}'
    positions=[round(co,6) for v in vertices for co in v.toTuple()]
    indices=[index for tri in triangles for index in tri]
    (OUT/'meshes'/f'{stem}.json').write_text(json.dumps({'positions':positions,'indices':indices},separators=(',',':')))
    part={'id':id,'itemNumber':number,'name':name,'revision':rev,'stepUrl':f'/fixtures/step/{stem}.step','meshUrl':f'/fixtures/meshes/{stem}.json','color':color,'material':material,'materialSource':'Synthetic fixture metadata','bbox':bounds(imported),'volumeMm3':round(imported.Volume(),3),'sourceHash':sha(path),'tessellation':{'linearDeflectionMm':0.1,'angularDeflectionRadians':0.15,'triangles':len(triangles)},'bboxMethod':BBOX_METHOD,'bboxTessellationIndependent':True}
    parts.append(part)
    shape_map[(id,rev)]=imported
    checks.append({'part':stem,'valid':True,'solids':len(imported.Solids()),'volumeDeltaMm3':round(abs(imported.Volume()-original.Volume()),9),'triangleCount':len(triangles)})
    print(f'{stem}: {len(triangles)} triangles, {imported.Volume():.1f} mm3',flush=True)

def occurrences(rev):
    width=45 if rev=='A' else 53
    occ=[
     {'id':'occ-base','partId':'base','partRevision':rev,'position':[0,0,0],'rotation':[0,0,0],'name':'Mounting plate'},
     {'id':'occ-motor','partId':'motor','partRevision':'A','position':[-42 if rev=='A' else -38,0,42],'rotation':[0,0,0],'name':'Brushless motor'},
     {'id':'occ-gearbox','partId':'gearbox','partRevision':'A','position':[42,0,39],'rotation':[0,0,0],'name':'Gearbox housing'},
     {'id':'occ-shaft','partId':'shaft','partRevision':'A','position':[78,0,39],'rotation':[0,0,0],'name':'Output shaft'},
     {'id':'occ-cover','partId':'cover','partRevision':rev,'position':[42,0,70],'rotation':[0,0,0],'name':'Ventilated cover'},
    ]
    for n,(x,y) in enumerate([(-75,-width),(-75,width),(75,width),(75,-width)],1):
        if rev=='B' and n==4:continue
        occ.append({'id':f'occ-bolt-{n}','partId':'fastener','partRevision':'A','position':[x,y,-6],'rotation':[0,0,0],'name':f'M8 socket fastener {n}'})
    if rev=='B':
        occ.append({'id':'occ-sensor','partId':'sensor','partRevision':'A','position':[65,-43,8],'rotation':[0,0,0],'name':'Position sensor and bracket'})
    return occ

assemblies={rev:occurrences(rev) for rev in ['A','B']}
assembly_urls={}
for rev,occs in assemblies.items():
    assembly=cq.Assembly(name=f'ATLAS-DRIVE-MODULE-{rev}')
    for o in occs:
        p=next(p for p in parts if p['id']==o['partId'] and p['revision']==o['partRevision'])
        c=p['color'].lstrip('#')
        rgb=[int(c[i:i+2],16)/255 for i in [0,2,4]]
        assembly.add(shape_map[(o['partId'],o['partRevision'])],name=o['id'],loc=cq.Location(cq.Vector(*o['position'])),color=cq.Color(*rgb))
    ap=OUT/'step'/f'atlas-assembly-{rev}.step'
    assembly.save(str(ap),exportType='STEP')
    normalize_step(ap)
    assembly_urls[rev]=f'/fixtures/step/atlas-assembly-{rev}.step'

# The document fixtures use human-readable engineering requirements with an
# intentional, documented sensor datum discrepancy to exercise review comments.
NAVY=HexColor('#18283b');INK=HexColor('#25394b');MUTED=HexColor('#687c90');TEAL=HexColor('#0c7f85');LINE=HexColor('#d9e1e9');PALE=HexColor('#f1f5f8')

def pdf_header(c,rev,title,subtitle,page):
    c.setFillColor(TEAL);c.setFont('FixtureSans-Bold',10);c.drawString(48,748,'ATLAS  /  ENGINEERING')
    c.setFillColor(NAVY);c.setFont('FixtureSans-Bold',23);c.drawString(48,711,title)
    c.setFillColor(MUTED);c.setFont('FixtureSans',10);c.drawString(48,690,subtitle)
    c.setFillColor(INK);c.setFont('FixtureSans-Bold',9);c.drawRightString(564,748,f'REVISION {rev}')
    c.setStrokeColor(LINE);c.line(48,670,564,670)
    c.setFont('FixtureSans',8);c.setFillColor(MUTED);c.drawString(48,35,'Preview fixture  |  Synthetic engineering data  |  Units mm unless stated')
    c.drawRightString(564,35,f'{page} / 2')

def paragraph(c,text,x,y,width=510,size=10,leading=15):
    words=text.split();line='';c.setFont('FixtureSans',size);c.setFillColor(INK)
    for word in words:
        candidate=(line+' '+word).strip()
        if c.stringWidth(candidate,'FixtureSans',size)>width:
            c.drawString(x,y,line);y-=leading;line=word
        else:line=candidate
    if line:c.drawString(x,y,line);y-=leading
    return y

def section(c,title,y):
    c.setFillColor(NAVY);c.setFont('FixtureSans-Bold',12);c.drawString(48,y,title);return y-22

def spec_rows(rev):
    return [
     ('Assembly item','ASM-1000'),
     ('Nominal base envelope',f'180 x {120 if rev=="A" else 136} x 8 mm'),
     ('Maximum installed width',f'{125 if rev=="A" else 140}.0 mm'),
     ('Mounting hole diameter','8.6 +0.2 / -0.0 mm'),
     ('Mounting hole pitch Y',f'{90 if rev=="A" else 106}.0 +/- 0.1 mm'),
     ('Motor datum X',f'{-42 if rev=="A" else -38}.0 +/- 0.2 mm'),
     ('Cover vent count',str(6 if rev=='A' else 9)),
     ('Installed mounting fasteners','4' if rev=='A' else '3 pending structural review'),
     ('Sensor datum X','Not installed' if rev=='A' else '61.0 +/- 0.5 mm'),
    ]

def pdf_table(c,rows,y):
    for i,(key,value) in enumerate(rows):
        if i%2==0:c.setFillColor(PALE);c.rect(48,y-25,516,29,fill=1,stroke=0)
        c.setFillColor(INK);c.setFont('FixtureSans',10);c.drawString(58,y-14,key)
        c.setFont('FixtureSans-Bold',10);c.drawString(306,y-14,value)
        y-=29
    return y-22

def arrow(c,x1,y1,x2,y2,label):
    c.setStrokeColor(MUTED);c.setFillColor(MUTED);c.setLineWidth(0.7);c.line(x1,y1,x2,y2)
    for x,y,angle in [(x1,y1,math.atan2(y2-y1,x2-x1)),(x2,y2,math.atan2(y1-y2,x1-x2))]:
        c.line(x,y,x+5*math.cos(angle+0.45),y+5*math.sin(angle+0.45));c.line(x,y,x+5*math.cos(angle-0.45),y+5*math.sin(angle-0.45))
    c.setFont('FixtureSans',9)
    if abs(y2-y1)<1:c.drawCentredString((x1+x2)/2,(y1+y2)/2+6,label)
    else:
        c.saveState();c.translate((x1+x2)/2-7,(y1+y2)/2);c.rotate(90);c.drawCentredString(0,0,label);c.restoreState()

def drawing(c,rev,y_center=454):
    scale=2;w=120 if rev=='A' else 136;x0=126;y0=y_center-w
    c.setLineWidth(1.2);c.setStrokeColor(INK);c.setFillColor(PALE);c.roundRect(x0,y0,360,w*2,10,fill=1,stroke=1)
    for x in [-75,75]:
        for y in ([-45,45] if rev=='A' else [-53,53]):
            c.setFillColor(white);c.circle(306+x*2,y_center+y*2,8.6,fill=1,stroke=1);c.circle(306+x*2,y_center+y*2,14,fill=0,stroke=1)
    c.setDash(4,3);c.setStrokeColor(MUTED);c.line(100,y_center,514,y_center);c.line(306,y0-20,306,y0+w*2+20);c.setDash()
    c.setStrokeColor(TEAL);c.setLineWidth(1);c.roundRect(306-85*2,y_center-26*2,86*2,52*2,8,fill=0,stroke=1)
    c.roundRect(306+6*2,y_center-35*2,72*2,70*2,8,fill=0,stroke=1)
    c.rect(306+78*2,y_center-9*2,30*2,18*2,fill=0,stroke=1)
    if rev=='B':
        c.setStrokeColor(HexColor('#c47c21'));c.rect(306+54*2,y_center-54*2,44,44,fill=0,stroke=1)
        c.setFont('FixtureSans-Bold',8);c.setFillColor(HexColor('#a56416'));c.drawString(430,y_center-132,'SENSOR DATUM: X 61.0')
    arrow(c,x0,y0-35,x0+360,y0-35,'180.0')
    arrow(c,x0-28,y0,x0-28,y0+w*2,f'{w}.0')
    c.setFont('FixtureSans-Bold',9);c.setFillColor(TEAL);c.drawString(192,y_center+5,'MOTOR');c.drawString(366,y_center+5,'GEARBOX')
    c.setFont('FixtureSans',9);c.setFillColor(MUTED);c.drawString(48,y0-70,'PLAN VIEW   /   SCHEMATIC - NOT TO SCALE')

docs=[]
for rev in ['A','B']:
    pdf_path=OUT/'documents'/f'atlas-spec-{rev}.pdf'
    c=canvas.Canvas(str(pdf_path),pagesize=letter,invariant=1)
    c.setTitle(f'Atlas Drive Module Specification Revision {rev}');c.setAuthor('Assembly Review Preview')
    pdf_header(c,rev,'Drive module specification','ASM-1000   /   Mechanical envelope and installation requirements',1)
    y=paragraph(c,'Review the model and its item attachments together before releasing the assembly configuration. This specification defines the installation envelope, mounting pattern, and inspection requirements.',48,645)
    y=section(c,'01   Mechanical requirements',y-20)
    y=pdf_table(c,spec_rows(rev),y)
    y=section(c,'02   Material and workmanship',y)
    y=paragraph(c,'Mounting plate: Aluminum 6061-T6, clear anodized. Cover: Aluminum 5052-H32. Break exposed edges 0.3 to 0.5 mm. All dimensions refer to the un-exploded assembly coordinate frame.',48,y)
    y=section(c,'03   Revision scope',y-17)
    paragraph(c,('Initial configuration for assembly review. Four mounting fasteners are required. No position sensor is fitted.' if rev=='A' else 'Widen the mounting plate to 136 mm, move the motor datum +4 mm in X, increase cover vents to nine, and add the position sensor. The missing fourth mounting fastener requires a reviewer decision.'),48,y)
    c.showPage()
    pdf_header(c,rev,'Installation reference','ASM-1000   /   Attachment sheet 2   /   Plan view and review checklist',2)
    drawing(c,rev)
    y=section(c,'04   Review checkpoints',227)
    checks_text=[
      'Verify the mounting pattern against the base STEP file and the installation envelope.',
      'Confirm fastener quantity using occurrences, not only the aggregate BOM row.',
      ('Confirm the sensor datum at X = 61.0 mm. Attach a model pin and a document note if the model disagrees.' if rev=='B' else 'Record any clearance or installation concerns against this exact revision.'),
      'Resolve open findings before formal change approval in the PLM system.'
    ]
    for n,text in enumerate(checks_text,1):y=paragraph(c,f'{n}.  {text}',48,y,width=508)-8
    c.save()
    docs.append({'id':f'atlas-spec-{rev}-pdf','itemId':'assembly','revision':rev,'kind':'pdf','name':f'Atlas module specification Rev {rev}.pdf','url':f'/fixtures/documents/atlas-spec-{rev}.pdf','edition':'1','sourceHash':sha(pdf_path),'text':'\n'.join([f'Atlas Drive Module Specification Revision {rev}']+[f'{k}: {v}' for k,v in spec_rows(rev)]+checks_text)})
    bp=OUT/'documents'/f'base-drawing-{rev}.pdf'
    c=canvas.Canvas(str(bp),pagesize=letter,invariant=1);c.setTitle(f'Mounting plate drawing revision {rev}')
    pdf_header(c,rev,'Mounting plate reference','PLT-1001   /   Dimensional reference   /   Material Aluminum 6061-T6',1)
    drawing(c,rev)
    y=section(c,'Plate inspection',227)
    paragraph(c,f'Envelope: 180 x {120 if rev=="A" else 136} x 8 mm. Mounting holes: diameter 8.6 mm. All positions are in the assembly frame. Model and drawing revisions must match before recording measurements.',48,y)
    c.showPage();pdf_header(c,rev,'Manufacturing requirements','PLT-1001   /   Surface and edge requirements',2)
    y=section(c,'Material',635);y=paragraph(c,'Aluminum 6061-T6. Clear anodize after machining. Mask tapped holes where specified by the manufacturing process.',48,y)
    y=section(c,'Dimensions',y-25);y=pdf_table(c,[('Nominal length','180.0 mm'),('Nominal width',f'{120 if rev=="A" else 136}.0 mm'),('Nominal thickness','8.0 mm'),('Corner radius','5.0 mm'),('Hole pitch X','150.0 mm'),('Hole pitch Y',f'{90 if rev=="A" else 106}.0 mm')],y)
    y=section(c,'Inspection note',y);paragraph(c,'This drawing is a preview test fixture. Confirm the reported CAD bounding box and the measured distance between mounting holes using the viewer tools.',48,y);c.save()
    docs.append({'id':f'base-drawing-{rev}-pdf','itemId':'base','revision':rev,'kind':'pdf','name':f'Mounting plate drawing Rev {rev}.pdf','url':f'/fixtures/documents/base-drawing-{rev}.pdf','edition':'1','sourceHash':sha(bp),'text':f'Mounting plate revision {rev}. Nominal length 180 mm. Nominal width {120 if rev=="A" else 136} mm. Nominal thickness 8 mm. Aluminum 6061-T6.'})
    doc=Document();sec=doc.sections[0];sec.page_width=Inches(8.5);sec.page_height=Inches(11)
    sec.top_margin=Inches(0.65);sec.bottom_margin=Inches(0.65);sec.left_margin=Inches(0.7);sec.right_margin=Inches(0.7)
    for sty in ['Normal','Title','Subtitle','Heading 1','Heading 2']:
        doc.styles[sty].font.name='Calibri';doc.styles[sty].font.color.rgb=RGBColor(0,0,0)
    doc.styles['Normal'].font.size=Pt(10);doc.styles['Normal'].paragraph_format.space_after=Pt(7)
    doc.styles['Title'].font.size=Pt(25)
    for border in list(doc.styles.element.xpath('.//w:pBdr')):
        border.getparent().remove(border)
    doc.add_paragraph('Atlas Drive Module Specification','Title')
    p=doc.add_paragraph(f'ASM-1000   |   Revision {rev}   |   Edition 1','Subtitle');p.paragraph_format.space_after=Pt(16)
    doc.add_paragraph('Use this specification to review the installation envelope, mounting interfaces, and inspection requirements alongside the exact assembly and attachment revisions in the viewer.')
    doc.add_heading('Mechanical requirements',1)
    table=doc.add_table(rows=1,cols=2);table.autofit=False;table.columns[0].width=Inches(3.4);table.columns[1].width=Inches(3.65)
    table.rows[0].cells[0].text='Requirement';table.rows[0].cells[1].text='Specified value'
    for k,v in spec_rows(rev):
        cells=table.add_row().cells;cells[0].text=k;cells[1].text=v
    for ri,row in enumerate(table.rows):
        for cell in row.cells:
            pr=cell._tc.get_or_add_tcPr();borders=OxmlElement('w:tcBorders')
            for edge in ['top','left','bottom','right']:
                e=OxmlElement(f'w:{edge}');e.set(qn('w:val'),'single');e.set(qn('w:sz'),'4');e.set(qn('w:color'),'D9D9D9');borders.append(e)
            pr.append(borders)
            margins=OxmlElement('w:tcMar')
            for edge in ['top','left','bottom','right']:
                e=OxmlElement(f'w:{edge}');e.set(qn('w:w'),'90');e.set(qn('w:type'),'dxa');margins.append(e)
            pr.append(margins)
            shade=OxmlElement('w:shd');shade.set(qn('w:fill'),'20354B' if ri==0 else ('F2F5F8' if ri%2==0 else 'FFFFFF'));pr.append(shade)
            for p in cell.paragraphs:
                p.paragraph_format.space_after=Pt(1)
                for r in p.runs:
                    r.font.size=Pt(10)
                    if ri==0:r.font.bold=True;r.font.color.rgb=RGBColor(255,255,255)
    doc.add_heading('Material and workmanship',1)
    doc.add_paragraph('Mounting plate: Aluminum 6061-T6, clear anodized. Cover: Aluminum 5052-H32. Break exposed edges 0.3 to 0.5 mm. All dimensions refer to the un-exploded assembly coordinate frame.')
    doc.add_heading('Revision scope',1)
    doc.add_paragraph('Initial review configuration with four mounting fasteners and no position sensor.' if rev=='A' else 'Widen the plate to 136 mm, move the motor datum +4 mm in X, increase cover vents to nine, and add the position sensor. The removed fourth fastener requires a reviewer decision.')
    doc.add_page_break();doc.add_heading('Inspection and review requirements',1)
    doc.add_paragraph('Record findings against the source edition under review. A measurement pin should identify its component occurrence and local point; a document finding should identify the requirement text or page.')
    for n,t in enumerate(checks_text,1):doc.add_paragraph(f'{n}. {t}')
    doc.add_heading('Release checks',1)
    for t in ['Confirm the measured plate width is within the maximum installed width.','Inspect the motor mounting interface with the assembly collapsed.','Use the revision overlay to inspect changed geometry and placement.','Resolve document and model discrepancies before formal approval in Arena.']:doc.add_paragraph(t,style='List Bullet')
    doc.add_heading('Document control',1)
    doc.add_paragraph(f'Item ASM-1000. Revision {rev}. File edition 1. This synthetic attachment is supplied for the Assembly Review preview and carries no production release authority.')
    dp=OUT/'documents'/f'atlas-spec-{rev}.docx';doc.save(dp)
    docs.append({'id':f'atlas-spec-{rev}-docx','itemId':'assembly','revision':rev,'kind':'docx','name':f'Atlas module specification Rev {rev}.docx','url':f'/fixtures/documents/atlas-spec-{rev}.docx','edition':'1','sourceHash':sha(dp),'text':'\n'.join([f'Atlas Drive Module Specification Revision {rev}']+[f'{k}: {v}' for k,v in spec_rows(rev)]+checks_text)})

gp=OUT/'documents'/'gearbox-inspection-A.pdf'
c=canvas.Canvas(str(gp),pagesize=letter,invariant=1)
c.setTitle('Gearbox housing inspection requirements revision A')
pdf_header(c,'A','Gearbox housing inspection','GBX-2002   /   Applies to assembly configurations A and B',1)
y=section(c,'01   Dimensional requirements',635)
y=pdf_table(c,[('Housing envelope','72 x 70 x 62 mm'),('Main internal cavity radius','24.0 mm'),('Shaft through bore diameter','20.0 mm'),('Corner radius','5.0 mm'),('Material','Aluminum A380')],y)
y=section(c,'02   Assembly review',y)
y=paragraph(c,'This part remains at revision A in both assembly configurations. Use transparency or a section plane to inspect the internal cavity and shaft interface. Moving the motor changes its assembly placement without changing this gearbox source file.',48,y)
y=section(c,'03   Datum location',y-24)
paragraph(c,'The housing occurrence datum is X = 42.0 mm, Y = 0.0 mm, Z = 39.0 mm in the assembly frame. The part geometry is centered on its own local origin. Reusing this item in another parent assembly requires a separate occurrence transform.',48,y)
c.showPage();pdf_header(c,'A','Inspection record','GBX-2002   /   Review checkpoints',2)
y=section(c,'Review requirements',635)
for t in ['Check the shaft bore and internal cavity using a section view.','Confirm the shared item revision is preserved when comparing assembly A and B.','Record comments against the gearbox occurrence and exact STEP source hash.','Use the collapsed assembly for distances; exploded positions are presentation transforms.']:
    y=paragraph(c,t,48,y)-16
c.save()
docs.append({'id':'gearbox-inspection-A-pdf','itemId':'gearbox','revision':'A','kind':'pdf','name':'Gearbox housing inspection Rev A.pdf','url':'/fixtures/documents/gearbox-inspection-A.pdf','edition':'1','sourceHash':sha(gp),'text':'Gearbox housing revision A. Envelope 72 x 70 x 62 mm. Main cavity radius 24 mm. Shaft bore diameter 20 mm. Aluminum A380. Unchanged in assembly configurations A and B.'})

manifest={'units':'mm','upAxis':'Z','generator':{'name':'CadQuery / Open CASCADE','cadquery':cq.__version__,'ocp':OCP.__version__,'pipeline':'Construct solids -> export STEP -> import STEP -> validate -> tessellate','meshLinearDeflectionMm':0.1,'boundingBoxMethod':BBOX_METHOD},'parts':parts,'assemblies':assemblies,'assemblyStepUrls':assembly_urls,'documents':docs,'synthetic':True,'reviewScenarios':[{'id':'width','description':'Base width changes from 120 mm to 136 mm; the installation maximum changes from 125 mm to 140 mm.'},{'id':'motor-shift','description':'Unchanged motor geometry shifts +4 mm along assembly X.'},{'id':'sensor-datum','description':'Intentional discrepancy: revision B specification requires sensor X=61.0 mm, while occurrence transform places it at X=65.0 mm.'},{'id':'missing-fastener','description':'The fourth fastener occurrence is removed in revision B and requires review.'}],'validation':checks}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2))
print(f'Wrote {len(parts)} part variants, 2 assemblies, and {len(docs)} document editions into {OUT}')
