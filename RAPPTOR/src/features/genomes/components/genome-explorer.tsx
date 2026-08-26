'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import RestartAltRoundedIcon from '@mui/icons-material/RestartAltRounded';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import ArrowUpwardRoundedIcon from '@mui/icons-material/ArrowUpwardRounded';
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded';
import UnfoldMoreRoundedIcon from '@mui/icons-material/UnfoldMoreRounded';
import CircularProgress from '@mui/material/CircularProgress';
import { defaultGenomeSortDirection } from '@/features/genomes/search-query';
import type {
  GenomeAnnotationFilter,
  GenomeSearchQuery,
  GenomeSortDirection,
  GenomeSortField,
  GenomeTaxonomyFilters,
  GenomeTaxonomyRank,
} from '@/features/genomes/types';
import type {
  UnifiedGenomeEvidenceFilter,
  UnifiedGenomeSearchQuery,
  UnifiedGenomeSearchResponse,
} from '@/types/unified-genome';

const TAXONOMY_RANKS = [
  { key: 'domain', label: 'Domain', allLabel: 'All domains' },
  { key: 'phylum', label: 'Phylum', allLabel: 'All phyla' },
  { key: 'class', label: 'Class', allLabel: 'All classes' },
  { key: 'order', label: 'Order', allLabel: 'All orders' },
  { key: 'family', label: 'Family', allLabel: 'All families' },
  { key: 'genus', label: 'Genus', allLabel: 'All genera' },
] as const;

const EMPTY_TAXONOMY: GenomeTaxonomyFilters = {
  domain: '',
  phylum: '',
  class: '',
  order: '',
  family: '',
  genus: '',
};

type NavigationRequest =
  | { kind: 'reset'; cursor: null }
  | { kind: 'next'; cursor: string; fromCursor: string | null }
  | { kind: 'previous'; cursor: string | null; history: Array<string | null> };

function sortDirectionLabel(field: GenomeSortField, direction: GenomeSortDirection) {
  const numeric = field === 'genome-size' || field === 'promoters';
  if (numeric) return direction === 'asc' ? 'smallest to largest' : 'largest to smallest';
  return direction === 'asc' ? 'A to Z' : 'Z to A';
}

function formatCount(value: number | null) {
  return value === null ? 'Not reported' : new Intl.NumberFormat('en-US').format(value);
}

function buildRequestUrl(query: UnifiedGenomeSearchQuery) {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  for (const rank of TAXONOMY_RANKS) {
    if (query.taxonomy[rank.key]) params.set(rank.key, query.taxonomy[rank.key]);
  }
  if (query.source) params.set('source', query.source);
  if (query.annotation) params.set('annotation', query.annotation);
  if (query.evidence !== 'all') params.set('evidence', query.evidence);
  params.set('sort', query.sort);
  params.set('direction', query.direction);
  params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  return `/api/genomes?${params.toString()}`;
}

export default function PortalGenomeExplorer({
  initialResult,
  initialEvidence = 'all',
}: {
  initialResult: UnifiedGenomeSearchResponse;
  initialEvidence?: UnifiedGenomeEvidenceFilter;
}) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [taxonomy, setTaxonomy] = useState<GenomeTaxonomyFilters>(EMPTY_TAXONOMY);
  const [source, setSource] = useState('');
  const [annotationStatus, setAnnotationStatus] = useState<GenomeAnnotationFilter>('');
  const [evidence, setEvidence] = useState<UnifiedGenomeEvidenceFilter>(initialEvidence);
  const [sortField, setSortField] = useState<GenomeSortField>('accession');
  const [sortDirection, setSortDirection] = useState<GenomeSortDirection>('asc');
  const [pageSize, setPageSize] = useState<GenomeSearchQuery['limit']>(25);
  const [result, setResult] = useState(initialResult);
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [staleTaxonomyFrom, setStaleTaxonomyFrom] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const retryRef = useRef<NavigationRequest>({ kind: 'reset', cursor: null });
  const mountedRef = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  const requestCriteria = useMemo<Omit<UnifiedGenomeSearchQuery, 'cursor'>>(() => ({
    q: debouncedQuery,
    taxonomy,
    source,
    annotation: annotationStatus,
    evidence,
    sort: sortField,
    direction: sortDirection,
    limit: pageSize,
  }), [annotationStatus, debouncedQuery, evidence, pageSize, sortDirection, sortField, source, taxonomy]);

  const requestPage = useCallback(async (navigation: NavigationRequest) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    retryRef.current = navigation;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(buildRequestUrl({ ...requestCriteria, cursor: navigation.cursor }), {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      const body = await response.json() as UnifiedGenomeSearchResponse | { error?: string };
      if (!response.ok) throw new Error('error' in body && body.error ? body.error : 'Genome catalog request failed.');
      const nextResult = body as UnifiedGenomeSearchResponse;
      setResult(nextResult);
      setStaleTaxonomyFrom(null);
      if (navigation.kind === 'reset') {
        setCurrentCursor(null);
        setCursorHistory([]);
      } else if (navigation.kind === 'next') {
        setCurrentCursor(navigation.cursor);
        setCursorHistory((history) => [...history, navigation.fromCursor]);
      } else {
        setCurrentCursor(navigation.cursor);
        setCursorHistory(navigation.history);
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Genome catalog request failed.');
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setIsLoading(false);
      }
    }
  }, [requestCriteria]);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setCurrentCursor(null);
    setCursorHistory([]);
    void requestPage({ kind: 'reset', cursor: null });
  }, [requestPage]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const clearFilters = () => {
    setQuery('');
    setDebouncedQuery('');
    setTaxonomy(EMPTY_TAXONOMY);
    setStaleTaxonomyFrom(null);
    setSource('');
    setAnnotationStatus('');
    setEvidence('all');
    setSortField('accession');
    setSortDirection('asc');
  };

  const updateTaxonomy = (rank: GenomeTaxonomyRank, value: string) => {
    const changedIndex = TAXONOMY_RANKS.findIndex((item) => item.key === rank);
    setStaleTaxonomyFrom(value ? changedIndex : null);
    setTaxonomy((current) => {
      const next = { ...current, [rank]: value };
      TAXONOMY_RANKS.slice(changedIndex + 1).forEach((child) => { next[child.key] = ''; });
      return next;
    });
  };

  const updateSortFromHeader = (field: GenomeSortField) => {
    if (sortField === field) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortField(field);
    setSortDirection(defaultGenomeSortDirection(field));
  };

  const goToNextPage = () => {
    if (!result.pageInfo.nextCursor) return;
    void requestPage({ kind: 'next', cursor: result.pageInfo.nextCursor, fromCursor: currentCursor });
  };

  const goToPreviousPage = () => {
    if (!cursorHistory.length) return;
    const history = cursorHistory.slice(0, -1);
    void requestPage({ kind: 'previous', cursor: cursorHistory[cursorHistory.length - 1], history });
  };

  const sortHeader = (field: GenomeSortField, label: string) => {
    const active = sortField === field;
    const currentDirection = active ? sortDirection : defaultGenomeSortDirection(field);
    const nextDirection = active ? (sortDirection === 'asc' ? 'desc' : 'asc') : currentDirection;
    const ariaLabel = active
      ? `Sorted ${label} ${sortDirectionLabel(field, currentDirection)}; sort ${sortDirectionLabel(field, nextDirection)}`
      : `Sort ${label} ${sortDirectionLabel(field, nextDirection)}`;

    return (
      <button type="button" className={active ? 'catalog-sort-button is-active' : 'catalog-sort-button'} onClick={() => updateSortFromHeader(field)} aria-label={ariaLabel}>
        <span>{label}</span>
        {active
          ? sortDirection === 'asc'
            ? <ArrowUpwardRoundedIcon aria-hidden="true" />
            : <ArrowDownwardRoundedIcon aria-hidden="true" />
          : <UnfoldMoreRoundedIcon className="catalog-sort-neutral" aria-hidden="true" />}
      </button>
    );
  };

  const pageNumber = cursorHistory.length + 1;
  const pageCount = Math.max(1, Math.ceil(result.total / pageSize));
  const start = result.total ? (pageNumber - 1) * pageSize + 1 : 0;
  const end = result.total ? start + result.items.length - 1 : 0;

  return (
    <div className="catalog-workspace" aria-busy={isLoading}>
      <div className="catalog-toolbar">
        <label className="catalog-search">
          <span className="sr-only">Search genomes</span>
          <SearchRoundedIcon aria-hidden="true" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search accession, organism, strain or taxonomy" />
        </label>
        <label>
          <span>Genome source</span>
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="">All sources</option>
            {result.facets.sources.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label>
          <span>NCBI annotation</span>
          <select value={annotationStatus} onChange={(event) => setAnnotationStatus(event.target.value as GenomeAnnotationFilter)}>
            <option value="">Any status</option>
            <option value="available">Cataloged</option>
            <option value="unavailable">Missing</option>
          </select>
        </label>
        <label>
          <span>Evidence</span>
          <select value={evidence} onChange={(event) => setEvidence(event.target.value as UnifiedGenomeEvidenceFilter)}>
            <option value="all">All genomes</option>
            <option value="predictions">Predictions available</option>
            <option value="experimental">Experimental TSS available</option>
            <option value="both">Prediction and experimental</option>
          </select>
        </label>
        <button type="button" className="catalog-reset" onClick={clearFilters} title="Clear filters" aria-label="Clear filters"><RestartAltRoundedIcon /></button>
      </div>

      <div className="catalog-taxonomy-panel" role="group" aria-labelledby="taxonomy-filter-heading">
        <div className="catalog-taxonomy-heading" id="taxonomy-filter-heading">Taxonomy filters</div>
        <div className="catalog-taxonomy-grid">
          {TAXONOMY_RANKS.map((rank, index) => {
            const missingParent = index > 0 && !TAXONOMY_RANKS.slice(0, index).every((parent) => taxonomy[parent.key]);
            const waitingForFreshOptions = staleTaxonomyFrom !== null && index > staleTaxonomyFrom;
            const loadingThisRank = isLoading && staleTaxonomyFrom !== null && index === staleTaxonomyFrom + 1;
            return (
              <label key={rank.key}>
                <span>{rank.label}</span>
                <span className="catalog-taxonomy-select">
                  <select
                    value={taxonomy[rank.key]}
                    disabled={missingParent || waitingForFreshOptions}
                    aria-busy={loadingThisRank || undefined}
                    onChange={(event) => updateTaxonomy(rank.key, event.target.value)}
                  >
                    <option value="">{rank.allLabel}</option>
                    {result.facets.taxonomy[rank.key].map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                  {loadingThisRank ? <CircularProgress className="catalog-taxonomy-spinner" size={16} thickness={5} aria-label={`Loading ${rank.label} options`} /> : null}
                </span>
              </label>
            );
          })}
        </div>
      </div>

      {error && <div className="catalog-error" role="alert"><span>{error}</span><button type="button" onClick={() => void requestPage(retryRef.current)}>Retry</button></div>}

      <div className="catalog-result-line" role="status">
        <span>{result.total.toLocaleString()} genomes</span>
        <span>{isLoading ? 'Updating results…' : `Showing ${start.toLocaleString()}-${end.toLocaleString()}`}</span>
      </div>

      <div className="catalog-table-wrap">
        <table className="catalog-table">
          <thead><tr>
            <th className="catalog-sortable-heading" aria-sort={sortField === 'accession' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}>{sortHeader('accession', 'Accession')}</th>
            <th className="catalog-sortable-heading" aria-sort={sortField === 'organism' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}>{sortHeader('organism', 'Organism')}</th>
            <th>Taxonomy</th>
            <th className="catalog-sortable-heading" aria-sort={sortField === 'genome-size' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}>{sortHeader('genome-size', 'Assembly size')}</th>
            <th className="catalog-sortable-heading" aria-sort={sortField === 'promoters' ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined}>{sortHeader('promoters', 'Predicted promoters')}</th>
            <th>Annotation</th>
          </tr></thead>
          <tbody>
            {result.items.map((genome) => (
              <tr key={genome.assemblyKey || genome.canonicalAccession}>
                <td><Link href={`/genomes/${encodeURIComponent(genome.canonicalAccession)}${genome.assemblyCompatibility === 'mismatch' && genome.assemblySource === 'experimental' ? '?assembly=experimental' : ''}`} className="catalog-accession">{genome.canonicalAccession}</Link>{genome.aliases.filter((alias) => alias !== genome.canonicalAccession).map((alias) => <small key={alias}>{alias}</small>)}</td>
                <td><span className="organism-name">{genome.organismName}</span>{genome.strain && <small>{genome.strain}</small>}</td>
                <td><span>{genome.phylum || 'Unclassified'}</span><small>{genome.genus || 'Genus not assigned'}</small></td>
                <td><span>{formatCount(genome.genomeSizeBp)} bp</span><small>{formatCount(genome.contigCount)} contigs</small></td>
                <td data-predicted-promoters={genome.predictedPromoterCount} data-evidence-state={genome.evidenceState}>
                  <span className={genome.predictionAccession ? 'evidence-available' : 'evidence-muted'}>
                    {genome.predictionAccession ? `${genome.predictedPromoterCount.toLocaleString()} predictions` : 'No prediction release'}
                  </span>
                  <small className={genome.experimentalAccession ? 'evidence-available' : 'evidence-muted'}>
                    {genome.experimentalAccession
                      ? `${genome.experimentalStudyCount.toLocaleString()} ${genome.experimentalStudyCount === 1 ? 'study' : 'studies'} · ${genome.experimentalObservationCount.toLocaleString()} TSS`
                      : 'No experimental TSS'}
                  </small>
                </td>
                <td>{genome.annotationStatus === 'available'
                  ? <span className="evidence-available">Available</span>
                  : <span className="evidence-muted">Missing</span>}</td>
              </tr>
            ))}
            {result.items.length === 0 && <tr><td colSpan={6} className="catalog-empty">No genomes match the current filters.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="catalog-pagination">
        <label>Rows <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value) as GenomeSearchQuery['limit'])}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label>
        <span>Page {pageNumber.toLocaleString()} of {pageCount.toLocaleString()}</span>
        <div>
          <button type="button" onClick={goToPreviousPage} disabled={isLoading || cursorHistory.length === 0} title="Previous page" aria-label="Previous page"><ChevronLeftRoundedIcon /></button>
          <button type="button" onClick={goToNextPage} disabled={isLoading || !result.pageInfo.hasNext} title="Next page" aria-label="Next page"><ChevronRightRoundedIcon /></button>
        </div>
      </div>
    </div>
  );
}
