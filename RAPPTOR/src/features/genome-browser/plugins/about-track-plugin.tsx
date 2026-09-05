'use client';

import type { ComponentType, ReactNode } from 'react';
import Plugin from '@jbrowse/core/Plugin';
import type PluginManager from '@jbrowse/core/PluginManager';
import { getConf, readConfObject } from '@jbrowse/core/configuration';
import { PORTAL_TERMS } from '@/components/portal-terminology';

type JsonRecord = Record<string, unknown>;

export type RapptorAboutProps = { config: unknown };
export type RapptorAboutComponent = ComponentType<RapptorAboutProps>;

type AboutKind = 'reference' | 'scores' | 'promoters' | 'experimental' | 'annotation' | 'illustrative' | 'unknown';

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).trim();
  return result ? result : null;
}

function number(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshot(config: unknown): JsonRecord {
  try {
    const value = readConfObject(config as never);
    const result = record(value);
    if (result && (result.type || result.name || result.metadata || !result.configuration)) return result;
  } catch {
    // About can also be used with a plain configuration object in tests and
    // by integrations that do not create an MST configuration model.
  }

  const direct = record(config);
  if (direct) {
    const nested = record(direct.configuration);
    if (nested) {
      try {
        const value = readConfObject(direct.configuration as never);
        const result = record(value);
        if (result) return result;
      } catch {
        // Fall through to the direct object below.
      }
      return nested;
    }
    return direct;
  }
  return {};
}

function metadataFrom(config: unknown, configSnapshot: JsonRecord) {
  const fromSnapshot = record(configSnapshot.metadata);
  if (fromSnapshot) return fromSnapshot;
  try {
    const value = getConf(config as never, 'metadata');
    return record(value) || {};
  } catch {
    return {};
  }
}

function downloads(metadata: JsonRecord) {
  const result: JsonRecord[] = [];
  const single = record(metadata.rapptorDownload);
  if (single) result.push(single);
  if (Array.isArray(metadata.rapptorDownloads)) {
    for (const value of metadata.rapptorDownloads) {
      const item = record(value);
      if (item) result.push(item);
    }
  }
  return result;
}

function trackKind(configSnapshot: JsonRecord, metadata: JsonRecord): AboutKind {
  const evidence = text(metadata.rapptorEvidenceType);
  if (evidence === 'experimental_tss') return 'experimental';

  const kinds = downloads(metadata).map((item) => text(item.kind)).filter((value): value is string => Boolean(value));
  if (kinds.includes('reference')) return 'reference';
  if (kinds.some((kind) => kind === 'scores-plus' || kind === 'scores-minus')) return 'scores';
  if (kinds.includes('promoters')) return evidence === 'illustrative_prototype' ? 'illustrative' : 'promoters';
  if (kinds.includes('annotation') || kinds.includes('ncbi')) return 'annotation';
  if (evidence === 'illustrative_prototype' && metadata.rapptorMirroredScore === true) return 'scores';
  if (evidence === 'illustrative_prototype') return 'illustrative';
  if (evidence === 'prediction') return 'promoters';
  if (metadata.rapptorMirroredScore === true) return 'scores';
  if (metadata.rapptorStrandFeatureMode === 'annotation') return 'annotation';
  if (metadata.rapptorStrandFeatureMode === 'promoter') return 'promoters';
  return 'unknown';
}

function assemblyName(configSnapshot: JsonRecord, metadata: JsonRecord) {
  const names = Array.isArray(configSnapshot.assemblyNames)
    ? configSnapshot.assemblyNames.map(text).filter((value): value is string => Boolean(value))
    : [];
  if (names.length) return names.join(', ');
  return downloads(metadata).map((item) => text(item.accession)).find(Boolean) || null;
}

function formatDate(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(parsed);
}

function safeHref(value: unknown) {
  const href = text(value);
  if (!href) return null;
  if (href.startsWith('/')) return href;
  return /^https?:\/\//iu.test(href) ? href : null;
}

function displayValue(value: ReactNode) {
  return value === null || value === undefined || value === '' ? null : value;
}

function AboutFacts({ facts }: { facts: Array<[string, ReactNode]> }) {
  const visible = facts.filter(([, value]) => displayValue(value) !== null);
  if (!visible.length) return null;
  return (
    <dl className="rapptor-about-facts">
      {visible.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AboutSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rapptor-about-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function AboutLinkActions({ links }: { links: Array<{ href: string; label: string }> }) {
  const visible = links.filter((link) => Boolean(link.href));
  if (!visible.length) return null;
  return (
    <div className="rapptor-about-actions">
      {visible.map((link) => (
        <a
          key={link.label}
          className="rapptor-about-action"
          href={link.href}
          target="_blank"
          rel="noreferrer"
        >
          {link.label}
        </a>
      ))}
    </div>
  );
}

function assemblyFacts(configSnapshot: JsonRecord, metadata: JsonRecord): Array<[string, ReactNode]> {
  const assembly = assemblyName(configSnapshot, metadata);
  return assembly ? [['Assembly', <code key="assembly">{assembly}</code>]] : [];
}

function processingFacts(metadata: JsonRecord): Array<[string, ReactNode]> {
  const processing = record(metadata.rapptorProcessing) || {};
  const cutoff = number(processing.cutoff ?? processing.scoreCutoff) ?? 0.9;
  const label = metadata.rapptorEvidenceType === 'illustrative_prototype'
    ? PORTAL_TERMS.exportCutoff
    : PORTAL_TERMS.modelThreshold;
  return [
    [label, cutoff.toFixed(2)],
  ];
}

function annotationFacts(metadata: JsonRecord, configSnapshot: JsonRecord): Array<[string, ReactNode]> {
  const annotation = record(metadata.rapptorAnnotation) || {};
  const build = text(annotation.genomeBuild ?? annotation.build);
  const buildAccession = text(annotation.genomeBuildAccession ?? annotation.buildAccession);
  const annotationDate = formatDate(text(annotation.annotationDate ?? annotation.generatedAt));
  const source = text(annotation.annotationSource ?? annotation.source);
  const regions = Array.isArray(annotation.sequenceRegions)
    ? annotation.sequenceRegions
      .map((value) => {
        const item = record(value);
        const refName = text(item?.refName ?? item?.sequenceId);
        const start = number(item?.start);
        const end = number(item?.end);
        return refName && start !== null && end !== null ? `${refName} · ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')}` : null;
      })
      .filter((value): value is string => Boolean(value))
    : [];
  const facts: Array<[string, ReactNode]> = [
    ...assemblyFacts(configSnapshot, metadata),
    ['Format', 'GFF3'],
    ['Genome build', build],
    ['Build accession', buildAccession && buildAccession !== assemblyName(configSnapshot, metadata) ? buildAccession : null],
    ['Annotation date', annotationDate],
    ['Annotation source', source],
    ['Sequence region', regions.length ? regions.join('; ') : null],
  ];
  return facts;
}

function experimentalAbout(configSnapshot: JsonRecord, metadata: JsonRecord) {
  const study = record(metadata.rapptorStudy) || {};
  const pmid = text(study.pmid);
  const pubmedUrl = safeHref(study.pubmedUrl) || (pmid ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(pmid)}/` : null);
  const doiUrl = safeHref(study.doiUrl);
  const authors = Array.isArray(study.authors)
    ? study.authors.map(text).filter((value): value is string => Boolean(value)).join('; ')
    : text(study.authors);
  return (
    <>
      <AboutFacts facts={[
        ...assemblyFacts(configSnapshot, metadata),
        ['Evidence', 'Published observations'],
        ['Study', text(study.title)],
        ['Year', text(study.year)],
        ['PMID', pmid],
        ['Observations', number(study.recordCount)?.toLocaleString('en-US') || null],
        ['Journal', text(study.journal)],
        ['Authors', authors],
      ]} />
      <AboutLinkActions links={[
        ...(pubmedUrl ? [{ href: pubmedUrl, label: 'Open PubMed record' }] : []),
        ...(doiUrl ? [{ href: doiUrl, label: 'Open DOI' }] : []),
      ]} />
    </>
  );
}

export function RapptorAbout({ config }: RapptorAboutProps) {
  const configSnapshot = snapshot(config);
  const metadata = metadataFrom(config, configSnapshot);
  const kind = trackKind(configSnapshot, metadata);
  const assemblyFactsValue = assemblyFacts(configSnapshot, metadata);

  if (kind === 'experimental') {
    return <div className="rapptor-about-content" data-testid="rapptor-about-experimental">{experimentalAbout(configSnapshot, metadata)}</div>;
  }

  if (kind === 'reference') {
    return (
      <div className="rapptor-about-content" data-testid="rapptor-about-reference">
        <AboutFacts facts={assemblyFactsValue} />
        <AboutFacts facts={[['Format', 'FASTA']]} />
      </div>
    );
  }

  if (kind === 'promoters' || kind === 'illustrative') {
    const illustrative = kind === 'illustrative';
    return (
      <div className="rapptor-about-content" data-testid="rapptor-about-promoters">
        <AboutFacts facts={[
          ...assemblyFactsValue,
          ['Evidence', illustrative ? 'Illustrative browser fixture' : null],
          ['Format', 'GFF3'],
        ]} />
        <AboutSection title="Processing details">
          <AboutFacts facts={processingFacts(metadata)} />
        </AboutSection>
      </div>
    );
  }

  if (kind === 'annotation') {
    return (
      <div className="rapptor-about-content" data-testid="rapptor-about-annotation">
        <AboutFacts facts={annotationFacts(metadata, configSnapshot)} />
      </div>
    );
  }

  if (kind === 'scores') {
    const scoreDownloads = downloads(metadata).filter((item) => {
      const value = text(item.kind);
      return value === 'scores-plus' || value === 'scores-minus';
    });
    const strand = scoreDownloads.length > 1 ? '+ / − strands' : scoreDownloads[0] && text(scoreDownloads[0].kind) === 'scores-minus' ? '− strand' : '+ strand';
    const evidence = metadata.rapptorEvidenceType === 'illustrative_prototype'
      ? 'Illustrative browser fixture'
      : null;
    return (
      <div className="rapptor-about-content" data-testid="rapptor-about-scores">
        <AboutFacts facts={[...assemblyFactsValue, ['Evidence', evidence], ['Strand', strand], ['Format', 'BigWig']]} />
      </div>
    );
  }

  return null;
}

export function isRapptorAboutTrack(config: unknown) {
  const configSnapshot = snapshot(config);
  const metadata = metadataFrom(config, configSnapshot);
  return trackKind(configSnapshot, metadata) !== 'unknown';
}

export function replaceRapptorAbout(
  Original: RapptorAboutComponent,
  props: Record<string, unknown> = {},
) {
  return isRapptorAboutTrack(props.config) ? RapptorAbout : Original;
}

export default class RapptorAboutTrackPlugin extends Plugin {
  name = 'RAPPTORAboutTrackPlugin';

  install(pluginManager: PluginManager) {
    pluginManager.addToExtensionPoint<RapptorAboutComponent>('Core-replaceAbout', replaceRapptorAbout);
  }
}
