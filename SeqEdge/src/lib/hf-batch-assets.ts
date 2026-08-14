export interface PlannedGenomeAssets {
  reference: string;
  predictedPromoters: string;
  ncbiAnnotations: string | null;
  batch: string;
}

type BatchRange = {
  id: string;
  firstAccession: string;
  lastAccession: string;
};

type AssetLayout = {
  layout: string;
  baseUrl: string;
  fileTemplates: Record<string, unknown>;
  batches: BatchRange[];
};

const ACCESSION_PATTERN = /^GC[AF]_\d{9}\.\d+$/;
const BATCH_PATTERN = /^\d{3}$/;
const TEMPLATE_PATTERN = /^[\w./{}-]+$/;

function validLayout(value: unknown): value is AssetLayout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const layout = value as Record<string, unknown>;
  if (layout.layout !== 'promoter-batch-v1' || typeof layout.baseUrl !== 'string') return false;
  if (!layout.fileTemplates || typeof layout.fileTemplates !== 'object' || Array.isArray(layout.fileTemplates)) return false;
  if (!Array.isArray(layout.batches)) return false;
  try {
    const base = new URL(layout.baseUrl);
    if (base.protocol !== 'https:' || base.hostname !== 'huggingface.co' || !base.pathname.startsWith('/datasets/')) return false;
  } catch {
    return false;
  }
  return layout.batches.every((batch) => {
    if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return false;
    const range = batch as Record<string, unknown>;
    return typeof range.id === 'string' && BATCH_PATTERN.test(range.id)
      && typeof range.firstAccession === 'string' && ACCESSION_PATTERN.test(range.firstAccession)
      && typeof range.lastAccession === 'string' && ACCESSION_PATTERN.test(range.lastAccession)
      && range.firstAccession <= range.lastAccession;
  });
}

function renderPath(template: unknown, accession: string, batch: string) {
  if (typeof template !== 'string' || !TEMPLATE_PATTERN.test(template) || template.includes('..')) return null;
  const path = template.replaceAll('{batch}', batch).replaceAll('{accession}', accession);
  return path.includes('{') || path.startsWith('/') ? null : path;
}

export function plannedHfBatchAssets(
  featureSummaryJson: unknown,
  accession: string,
  includeNcbiAnnotations: boolean,
): PlannedGenomeAssets | null {
  if (!ACCESSION_PATTERN.test(accession)) return null;
  let summary: Record<string, unknown>;
  try {
    summary = typeof featureSummaryJson === 'string'
      ? JSON.parse(featureSummaryJson) as Record<string, unknown>
      : featureSummaryJson as Record<string, unknown>;
  } catch {
    return null;
  }
  const layout = summary?.assetLayout;
  if (!validLayout(layout)) return null;
  const range = layout.batches.find((batch) => accession >= batch.firstAccession && accession <= batch.lastAccession);
  if (!range) return null;
  const reference = renderPath(layout.fileTemplates.reference, accession, range.id);
  const predictedPromoters = renderPath(layout.fileTemplates.predictedPromoters, accession, range.id);
  const ncbiAnnotations = includeNcbiAnnotations
    ? renderPath(layout.fileTemplates.ncbiAnnotations, accession, range.id)
    : null;
  if (!reference || !predictedPromoters || (includeNcbiAnnotations && !ncbiAnnotations)) return null;
  const base = layout.baseUrl.replace(/\/+$/, '');
  return {
    reference: `${base}/${reference}`,
    predictedPromoters: `${base}/${predictedPromoters}`,
    ncbiAnnotations: ncbiAnnotations ? `${base}/${ncbiAnnotations}` : null,
    batch: range.id,
  };
}
