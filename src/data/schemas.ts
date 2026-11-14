import type { AttributeValues, PartDefinition, WorkspacePreset, WorkspaceSchema } from '../domain';

export const schemas: Record<WorkspacePreset, WorkspaceSchema> = {
  precision: {
    workspaceId: 'preview-precision', name: 'Precision Engineering', preset: 'precision', version: '2026.1',
    attributes: [
      { id: 'attr-pe-7f-material', label: 'Material', type: 'text', scope: 'item', defaultVisible: true },
      { id: 'attr-pe-2c-finish', label: 'Surface finish', type: 'enum', scope: 'item', options: ['Clear anodize', 'Black anodize', 'Passivated', 'Powder coat', 'As machined'], defaultVisible: true },
      { id: 'attr-pe-9a-mass', label: 'Estimated mass', type: 'number', scope: 'item', unit: 'g', defaultVisible: false },
      { id: 'attr-pe-b4-make', label: 'Sourcing', type: 'enum', scope: 'item', options: ['Make', 'Buy'], defaultVisible: true },
      { id: 'attr-pe-e1-ref', label: 'Reference designator', type: 'text', scope: 'bom', defaultVisible: false },
      { id: 'attr-pe-a2-critical', label: 'Critical fit', type: 'boolean', scope: 'bom', defaultVisible: false },
    ],
  },
  medical: {
    workspaceId: 'preview-medical', name: 'Medical Device Lab', preset: 'medical', version: '2026.2',
    attributes: [
      { id: 'attr-md-f1-grade', label: 'Material specification', type: 'text', scope: 'item', defaultVisible: true },
      { id: 'attr-md-06-class', label: 'Risk classification', type: 'enum', scope: 'item', options: ['Low', 'Medium', 'High'], defaultVisible: true },
      { id: 'attr-md-c3-contact', label: 'Patient contact', type: 'boolean', scope: 'item', defaultVisible: true },
      { id: 'attr-md-31-trace', label: 'Lot traceability', type: 'enum', scope: 'item', options: ['Required', 'Not required'], defaultVisible: false },
      { id: 'attr-md-84-verify', label: 'Verification method', type: 'text', scope: 'bom', defaultVisible: true },
      { id: 'attr-md-a7-sequence', label: 'Assembly sequence', type: 'number', scope: 'bom', defaultVisible: false },
    ],
  },
};

export function itemAttributes(part: Omit<PartDefinition, 'attributes'>, preset: WorkspacePreset): AttributeValues {
  if (preset === 'medical') return {
    'attr-md-f1-grade': part.material,
    'attr-md-06-class': ['shaft', 'gearbox'].includes(part.id) ? 'High' : 'Low',
    'attr-md-c3-contact': false,
    'attr-md-31-trace': ['motor', 'sensor', 'gearbox'].includes(part.id) ? 'Required' : 'Not required',
  };
  const density = /steel|stainless/i.test(part.material) ? 0.00785 : /plastic|polymer/i.test(part.material) ? 0.0012 : 0.0027;
  return {
    'attr-pe-7f-material': part.material,
    'attr-pe-2c-finish': part.id === 'motor' ? 'Powder coat' : part.id === 'cover' ? 'Black anodize' : ['shaft', 'fastener'].includes(part.id) ? 'Passivated' : 'Clear anodize',
    'attr-pe-9a-mass': part.volumeMm3 === undefined ? null : Math.round(part.volumeMm3 * density * 10) / 10,
    'attr-pe-b4-make': ['motor', 'fastener', 'sensor'].includes(part.id) ? 'Buy' : 'Make',
  };
}
export function occurrenceAttributes(partId: string, index: number, preset: WorkspacePreset): AttributeValues {
  return preset === 'medical' ? {
    'attr-md-84-verify': ['shaft', 'gearbox'].includes(partId) ? 'Dimensional inspection' : 'Visual inspection',
    'attr-md-a7-sequence': index + 1,
  } : {
    'attr-pe-e1-ref': `${partId.toUpperCase().slice(0, 3)}-${String(index + 1).padStart(2, '0')}`,
    'attr-pe-a2-critical': ['shaft', 'gearbox'].includes(partId),
  };
}
