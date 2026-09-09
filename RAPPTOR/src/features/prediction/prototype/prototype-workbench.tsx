'use client';

import { useRouter } from 'next/navigation';
import { ChangeEvent, FormEvent, useMemo, useRef, useState } from 'react';
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded';
import type { GenomeCatalogRow, GenomeSearchResponse } from '@/features/genomes/types';
import { predictionApi, sha256File, sha256Text } from '@/features/prediction/client';
import { genomeScanOutputs } from '../scan-options';
import { parsePredictionHistory, PREDICTION_HISTORY_KEY, upsertPredictionHistory, type PredictionHistoryEntry } from '@/features/prediction/history';
import {
  DEFAULT_PROTOTYPE_MODEL_SPEC,
  PROTOTYPE_CANDIDATE_EXAMPLE,
  PROTOTYPE_CANDIDATE_GENOME_EXAMPLE,
  PROTOTYPE_MAX_STRIDE_BASES,
  PROTOTYPE_MIN_STRIDE_BASES,
  PROTOTYPE_PREDICTION_SCHEMA_VERSION,
  PROTOTYPE_STRIDE_BASES,
  createPrototypeRunId,
  formatPrototypeBytes,
  parsePrototypeSequenceInput,
  prototypeParameters,
  readPrototypeGenomeFastaMetadata,
  readPrototypeSequenceFile,
  validatePrototypeGenomeFile,
  validatePrototypeInlineLength,
  writePrototypePredictionRun,
  type PrototypeGenomeContext,
  type PrototypeParsedSequenceInput,
  type PrototypePredictionMode,
  type PrototypePredictionRun,
  type PrototypeStrandMode,
  type PrototypeStrideBases,
} from '.';
import { REAL_PREDICTION_REFERENCE, validateReferenceExample } from '../reference-example';
import type { QueuedPredictionCapabilities } from '../service-capabilities';
import PredictionVerification from '../components/prediction-verification';
import { registerPrototypeTransientInput } from './transient-input';
import { DEFAULT_PREDICTION_MAX_REQUEST_BYTES, formatPredictionMaxRequestBytes } from '../capabilities';
import { PORTAL_COPY, PORTAL_TERMS, predictionModeLabel, thresholdLabel } from '@/components/portal-terminology';
import styles from './prototype-workbench.module.css';

type PrimarySourceKind = 'inline' | 'upload' | 'catalog';
type ContextSourceKind = 'catalog' | 'upload';

interface UploadedInputState {
  file: File | null;
  parsed: PrototypeParsedSequenceInput | null;
  loading: boolean;
  error: string | null;
}

interface ContextUploadState {
  file: File | null;
  totalLength: number | null;
  contigs: Array<{ sequenceId: string; length: number }>;
  loading: boolean;
  error: string | null;
}

type CreatedDockerJob = {
  job_id?: string;
  access_token?: string;
  artifacts_expires_at?: string | null;
};

type PredictionTicket = { ticket?: string };

interface ResolvedGenomeInput {
  fasta: string;
  sequence: string;
  totalLength: number;
  referenceName: string;
  label: string;
}

const EMPTY_UPLOAD: UploadedInputState = { file: null, parsed: null, loading: false, error: null };
const EMPTY_CONTEXT_UPLOAD: ContextUploadState = { file: null, totalLength: null, contigs: [], loading: false, error: null };

function catalogContext(row: GenomeCatalogRow): PrototypeGenomeContext {
  if (row.accession === REAL_PREDICTION_REFERENCE.accession) return PROTOTYPE_CANDIDATE_GENOME_EXAMPLE;
  return {
    kind: 'catalog',
    accession: row.accession,
    displayName: row.organismName || row.accession,
    fileName: `${row.accession}.reference.fna.gz`,
    fileSize: null,
    checksum: null,
    totalLength: row.genomeSizeBp,
    contigs: [],
  };
}

function CatalogPicker({ idPrefix, selected, onSelect, onUploadInstead }: {
  idPrefix: string;
  selected: PrototypeGenomeContext | null;
  onSelect: (context: PrototypeGenomeContext | null) => void;
  onUploadInstead: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GenomeCatalogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    if (query.trim().length < 2) {
      setError('Enter at least two characters to search the genome catalog.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/genomes?q=${encodeURIComponent(query.trim())}&limit=25`, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error('Catalog request failed.');
      const payload = await response.json() as GenomeSearchResponse;
      const exactMatch = payload.items.find((item) => item.accession.toUpperCase() === query.trim().toUpperCase());
      if (exactMatch) {
        onSelect(catalogContext(exactMatch));
        setResults([]);
        return;
      }
      setResults(payload.items.slice(0, 8));
      if (!payload.items.length) setError(PORTAL_COPY.noAssemblies);
    } catch {
      setResults([]);
      setError('Genome catalog unavailable. Your input is unchanged.');
    } finally {
      setLoading(false);
    }
  }

  if (selected) {
    return (
      <div className={styles.selection}>
        <div><strong>{selected.displayName}</strong><span>{selected.kind === 'catalog' ? selected.accession : selected.fileName}</span></div>
        <button type="button" onClick={() => onSelect(null)}>Change</button>
      </div>
    );
  }

  return (
    <div className={styles.catalogPanel}>
      <label className={styles.fieldLabel} htmlFor={`${idPrefix}-search`}>Accession, organism, or strain</label>
      <div className={styles.searchRow}>
        <input id={`${idPrefix}-search`} role="combobox" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls={`${idPrefix}-results`} value={query} onChange={(event) => {
          const nextQuery = event.target.value;
          setQuery(nextQuery);
          if (nextQuery.trim().toUpperCase() === PROTOTYPE_CANDIDATE_GENOME_EXAMPLE.accession) {
            onSelect(PROTOTYPE_CANDIDATE_GENOME_EXAMPLE);
            setResults([]);
            setError(null);
          }
        }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} placeholder="GCF_000005845.1 or Escherichia coli" />
        <button type="button" onClick={() => void search()} disabled={loading}>{loading ? 'Searching…' : 'Search catalog'}</button>
      </div>
      {error ? (
        <div className={styles.catalogError} role="alert">
          <p>{error}</p>
          <div><button type="button" onClick={() => void search()}>Retry search</button><button type="button" onClick={onUploadInstead}>Upload FASTA instead</button></div>
        </div>
      ) : null}
      {results.length ? (
        <ul id={`${idPrefix}-results`} role="listbox" className={styles.catalogResults} aria-label="Genome catalog results">
          {results.map((row) => (
            <li key={row.accession} role="presentation"><button role="option" aria-selected="false" type="button" onClick={() => { onSelect(catalogContext(row)); setResults([]); setError(null); }}><strong>{row.organismName}</strong><span>{row.accession}{row.genomeSizeBp ? ` · ${row.genomeSizeBp.toLocaleString()} bp` : ''}</span></button></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function inferredLabel(mode: PrototypePredictionMode) {
  return predictionModeLabel(mode === 'candidate' ? 'candidate' : 'genome-scan');
}

function parsedGenomeInput(parsed: PrototypeParsedSequenceInput, label: string): ResolvedGenomeInput {
  return {
    fasta: parsed.normalizedForChecksum,
    sequence: parsed.records.map((record) => record.normalizedSequence).join(''),
    totalLength: parsed.totalLength,
    referenceName: parsed.records[0]?.sequenceId || '',
    label,
  };
}

async function catalogGenomeInput(context: PrototypeGenomeContext): Promise<ResolvedGenomeInput> {
  if (context.kind !== 'catalog' || !context.accession) throw new Error('Select a catalog genome.');
  const accession = encodeURIComponent(context.accession);
  if (context.accession === REAL_PREDICTION_REFERENCE.accession) {
    const response = await fetch(`/api/prediction-reference/${accession}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('The example reference could not be loaded. Retry the download.');
    const verified = await validateReferenceExample(await response.text());
    return parsedGenomeInput(parsePrototypeSequenceInput(verified.fasta), context.displayName);
  }
  let response = await fetch(`/api/remote-data/${accession}/reference.fa.gz`, { cache: 'no-store' });
  if (!response.ok) response = await fetch(`/api/experimental-data/${accession}/reference.fa.gz`, { cache: 'no-store' });
  if (!response.ok && context.accession === PROTOTYPE_CANDIDATE_GENOME_EXAMPLE.accession) {
    response = await fetch(`/api/prediction-reference/${accession}`, { cache: 'no-store' });
  }
  if (!response.ok || !response.body) throw new Error('Selected genome FASTA unavailable. Choose another genome or upload FASTA.');
  let text: string;
  try {
    if (response.headers.get('content-type')?.startsWith('text/plain')) text = await response.text();
    else {
      if (typeof DecompressionStream === 'undefined') throw new Error('unsupported gzip');
      text = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
    }
  } catch {
    throw new Error('Selected genome FASTA could not be decompressed.');
  }
  return parsedGenomeInput(parsePrototypeSequenceInput(text), context.displayName);
}

export default function PrototypePredictionWorkbench({
  modelVersion = DEFAULT_PROTOTYPE_MODEL_SPEC.version,
  maxSequenceBases = 10_000,
  maxGenomeBytes = DEFAULT_PREDICTION_MAX_REQUEST_BYTES,
  localTest = false,
  preview = false,
  service = { available: false, modelVersion: 'candidate-github-93cf', supportsScoreCutoff: false, siteKey: '', reason: 'Prediction service is not configured.' },
}: {
  modelVersion?: string;
  maxSequenceBases?: number;
  maxGenomeBytes?: number;
  localTest?: boolean;
  preview?: boolean;
  service?: QueuedPredictionCapabilities;
}) {
  const router = useRouter();
  const submissionBlock = preview ? null : !service.available ? service.reason || 'Prediction service is unavailable.'
    : service.submissionIssue || (!localTest && !service.siteKey ? 'Human verification is not configured on this site. Prediction cannot be submitted yet.' : null);
  const primaryFileRef = useRef<HTMLInputElement>(null);
  const contextFileRef = useRef<HTMLInputElement>(null);
  const primaryStepRef = useRef<HTMLFieldSetElement>(null);
  const contextStepRef = useRef<HTMLFieldSetElement>(null);
  const parameterStepRef = useRef<HTMLFieldSetElement>(null);
  const [primaryKind, setPrimaryKind] = useState<PrimarySourceKind>('inline');
  const [inlineInput, setInlineInput] = useState('');
  const [uploadedInput, setUploadedInput] = useState<UploadedInputState>(EMPTY_UPLOAD);
  const [inputCatalog, setInputCatalog] = useState<PrototypeGenomeContext | null>(null);
  const [contextKind, setContextKind] = useState<ContextSourceKind>('catalog');
  const [contextCatalog, setContextCatalog] = useState<PrototypeGenomeContext | null>(null);
  const [contextUpload, setContextUpload] = useState<ContextUploadState>(EMPTY_CONTEXT_UPLOAD);
  const [strandMode, setStrandMode] = useState<PrototypeStrandMode>('both');
  const [cutoff, setCutoff] = useState(0.9);
  const [strideBases, setStrideBases] = useState<PrototypeStrideBases>(PROTOTYPE_STRIDE_BASES);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [verificationRevision, setVerificationRevision] = useState(0);
  const [exampleLoading, setExampleLoading] = useState(false);
  const [exampleError, setExampleError] = useState<string | null>(null);
  const verifiedExample = useRef<ResolvedGenomeInput | null>(null);
  async function prepareExampleReference() {
    setExampleLoading(true); setExampleError(null);
    try { verifiedExample.current = await catalogGenomeInput(PROTOTYPE_CANDIDATE_GENOME_EXAMPLE); }
    catch (cause) { setExampleError(cause instanceof Error ? cause.message : 'Example reference unavailable.'); }
    finally { setExampleLoading(false); }
  }

  const inlineState = useMemo(() => {
    if (!inlineInput.trim()) return { parsed: null, error: null };
    try {
      const parsed = parsePrototypeSequenceInput(inlineInput);
      validatePrototypeInlineLength(parsed.totalLength, maxSequenceBases);
      return { parsed, error: null };
    }
    catch (cause) { return { parsed: null, error: cause instanceof Error ? cause.message : 'Sequence input is invalid.' }; }
  }, [inlineInput, maxSequenceBases]);

  const parsedInput = primaryKind === 'inline' ? inlineState.parsed : primaryKind === 'upload' ? uploadedInput.parsed : null;
  const inputError = primaryKind === 'inline' ? inlineState.error : primaryKind === 'upload' ? uploadedInput.error : null;
  const inferredMode: PrototypePredictionMode | null = primaryKind === 'catalog'
    ? (inputCatalog ? 'genome-scan' : null)
    : parsedInput?.mode || null;
  const usesExampleReference = (primaryKind === 'catalog' && inputCatalog?.kind === 'catalog' && inputCatalog.accession === REAL_PREDICTION_REFERENCE.accession)
    || (contextKind === 'catalog' && contextCatalog?.kind === 'catalog' && contextCatalog.accession === REAL_PREDICTION_REFERENCE.accession);
  const usesCachedCgr = inferredMode === 'candidate' && contextKind === 'catalog'
    && contextCatalog?.kind === 'catalog';
  const needsExampleReference = usesExampleReference && !usesCachedCgr;
  const automaticPeaks = !preview && inferredMode !== 'candidate' && service.supportsPeakCalling
    && (strideBases === 1 || service.gff3RequiresStride1 === false);
  const cutoffUnavailable = !preview && inferredMode !== 'candidate' && !service.supportsScoreCutoff;
  const cutoffReady = cutoffUnavailable || (Number.isFinite(cutoff) && cutoff >= 0 && cutoff <= 1);
  const strideReady = !inferredMode || (Number.isSafeInteger(strideBases)
    && strideBases >= PROTOTYPE_MIN_STRIDE_BASES && strideBases <= PROTOTYPE_MAX_STRIDE_BASES);
  const parametersReady = cutoffReady && strideReady;
  const genomeLimitLabel = formatPredictionMaxRequestBytes(maxGenomeBytes);
  const activeThresholdLabel = inferredMode
    ? thresholdLabel(inferredMode === 'candidate' ? 'candidate' : 'genome-scan')
    : PORTAL_TERMS.modelThreshold;
  const contextReady = Boolean(inferredMode) && (contextKind === 'catalog' ? Boolean(contextCatalog) : Boolean(contextUpload.file && !contextUpload.error && !contextUpload.loading));
  const inputReady = primaryKind === 'catalog'
    ? Boolean(inputCatalog)
    : primaryKind === 'upload'
      ? Boolean(parsedInput && !inputError && !uploadedInput.loading)
      : Boolean(parsedInput && !inputError);
  const verificationVisible = !preview && !localTest && Boolean(service.siteKey) && inputReady && contextReady && parametersReady
    && (!needsExampleReference || (!exampleLoading && !exampleError));
  function clearGenomeContext() {
    setContextKind('catalog');
    setContextCatalog(null);
    setContextUpload(EMPTY_CONTEXT_UPLOAD);
  }

  function removePrimaryFile() {
    setUploadedInput(EMPTY_UPLOAD);
    setPrimaryKind('inline');
    clearGenomeContext();
    setFormError(null);
  }

  function removeContextFile() {
    setContextUpload(EMPTY_CONTEXT_UPLOAD);
    setContextKind('catalog');
    setFormError(null);
  }

  function selectContextCatalog(context: PrototypeGenomeContext | null) {
    setContextCatalog(context);
    if (context) setContextKind('catalog');
    setFormError(null);
  }

  function loadFocusedExample() {
    setPrimaryKind('inline');
    setInlineInput(PROTOTYPE_CANDIDATE_EXAMPLE);
    clearGenomeContext();
    if (!preview) setContextCatalog(PROTOTYPE_CANDIDATE_GENOME_EXAMPLE);
    setFormError(null);
  }

  function loadGenomeExample() {
    setPrimaryKind('catalog');
    setInputCatalog(PROTOTYPE_CANDIDATE_GENOME_EXAMPLE);
    clearGenomeContext();
    if (!preview) { setContextCatalog(PROTOTYPE_CANDIDATE_GENOME_EXAMPLE); void prepareExampleReference(); }
    setFormError(null);
  }

  async function handlePrimaryFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setPrimaryKind('upload');
    clearGenomeContext();
    setFormError(null);
    setUploadedInput({ file, parsed: null, loading: true, error: null });
    try {
      validatePrototypeGenomeFile(file, maxGenomeBytes);
      const parsed = await readPrototypeSequenceFile(file);
      setUploadedInput({ file, parsed, loading: false, error: null });
    } catch (cause) {
      setUploadedInput({ file, parsed: null, loading: false, error: cause instanceof Error ? cause.message : 'FASTA could not be read.' });
    }
  }

  async function handleContextFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setContextKind('upload');
    setFormError(null);
    setContextUpload({ file, totalLength: null, contigs: [], loading: true, error: null });
    try {
      validatePrototypeGenomeFile(file, maxGenomeBytes);
      const metadata = await readPrototypeGenomeFastaMetadata(file);
      const valid = metadata.contigs.filter((contig) => contig.length >= 100);
      if (!valid.length) throw new Error('Genome context needs at least one contig of 100 bp or longer.');
      setContextUpload({ file, totalLength: metadata.totalLength, contigs: valid, loading: false, error: null });
    } catch (cause) {
      setContextUpload({ file, totalLength: null, contigs: [], loading: false, error: cause instanceof Error ? cause.message : 'Genome context could not be read.' });
    }
  }

  async function resolveGenomeContextMetadata(): Promise<PrototypeGenomeContext> {
    if (contextKind === 'catalog') {
      if (!contextCatalog) throw new Error('Select the matching genome context.');
      return contextCatalog;
    }
    if (!contextUpload.file || contextUpload.error || contextUpload.loading) throw new Error('Choose a valid matching genome FASTA.');
    return {
      kind: 'upload', displayName: contextUpload.file.name, fileName: contextUpload.file.name,
      fileSize: contextUpload.file.size, checksum: await sha256File(contextUpload.file),
      totalLength: contextUpload.totalLength, contigs: contextUpload.contigs,
    };
  }

  async function resolveGenomeContextSequence(): Promise<ResolvedGenomeInput> {
    if (contextKind === 'catalog') {
      if (!contextCatalog) throw new Error('Select the matching genome context.');
      if (contextCatalog.kind === 'catalog' && contextCatalog.accession === REAL_PREDICTION_REFERENCE.accession && verifiedExample.current) return verifiedExample.current;
      return catalogGenomeInput(contextCatalog);
    }
    if (!contextUpload.file || contextUpload.error || contextUpload.loading) throw new Error('Choose a valid matching genome FASTA.');
    return parsedGenomeInput(await readPrototypeSequenceFile(contextUpload.file), contextUpload.file.name);
  }

  async function primaryScanSourceMetadata(): Promise<PrototypeGenomeContext> {
    if (primaryKind === 'catalog') {
      if (!inputCatalog) throw new Error('Select a catalog genome.');
      return inputCatalog;
    }
    if (!parsedInput) throw new Error('Provide valid sequence input.');
    const validContigs = parsedInput.validContigs.map(({ sequenceId, length }) => ({ sequenceId, length }));
    if (primaryKind === 'inline') {
      return {
        kind: 'inline', displayName: 'Pasted sequence', fileName: null, fileSize: null,
        checksum: await sha256Text(parsedInput.normalizedForChecksum), totalLength: parsedInput.totalLength, contigs: validContigs,
      };
    }
    if (!uploadedInput.file) throw new Error('Choose a FASTA file.');
    return {
      kind: 'upload', displayName: uploadedInput.file.name, fileName: uploadedInput.file.name,
      fileSize: uploadedInput.file.size, checksum: await sha256File(uploadedInput.file),
      totalLength: parsedInput.totalLength, contigs: validContigs,
    };
  }

  async function primaryScanSequence(): Promise<ResolvedGenomeInput> {
    if (primaryKind === 'catalog') {
      if (!inputCatalog) throw new Error('Select a catalog genome.');
      if (inputCatalog.kind === 'catalog' && inputCatalog.accession === REAL_PREDICTION_REFERENCE.accession && verifiedExample.current) return verifiedExample.current;
      return catalogGenomeInput(inputCatalog);
    }
    if (!parsedInput) throw new Error('Provide valid sequence input.');
    return parsedGenomeInput(parsedInput, primaryKind === 'upload' ? uploadedInput.file?.name || 'Uploaded FASTA' : 'Pasted sequence');
  }

  async function submitPrediction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const revealStep = (step: HTMLFieldSetElement | null) => {
      step?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      step?.focus({ preventScroll: true });
    };
    if (!inputReady || !inferredMode) {
      setFormError('Add a valid sequence or genome in Step 1.');
      revealStep(primaryStepRef.current);
      return;
    }
    if (!contextReady) {
      setFormError('Genome context (CGR) is required. Select a catalog genome or upload its FASTA in Step 2.');
      revealStep(contextStepRef.current);
      return;
    }
    if (!parametersReady) {
      setFormError(!strideReady
        ? `Stride must be an integer from ${PROTOTYPE_MIN_STRIDE_BASES} to ${PROTOTYPE_MAX_STRIDE_BASES}.`
        : `${activeThresholdLabel} must be between 0 and 1.`);
      revealStep(parameterStepRef.current);
      return;
    }
    if (submissionBlock) { setFormError(submissionBlock); return; }
    if (!preview && !localTest && !turnstileToken) { setFormError('Complete human verification before submitting.'); return; }
    if (!preview && needsExampleReference && (exampleLoading || exampleError)) { setFormError('Load and verify the example reference before submitting.'); return; }
    setSubmitting(true);
    setFormError(null);
    try {
      if (preview) {
        const runId = createPrototypeRunId();
        const effectiveStride = strideBases;
        const base = { schemaVersion: PROTOTYPE_PREDICTION_SCHEMA_VERSION, runId, createdAt: new Date().toISOString(), modelSpec: { ...DEFAULT_PROTOTYPE_MODEL_SPEC, version: modelVersion, strideBases: effectiveStride } };
        let run: PrototypePredictionRun;
        if (inferredMode === 'candidate') {
          if (!parsedInput || parsedInput.records.length !== 1 || parsedInput.records[0].length !== 100 || primaryKind === 'catalog') throw new Error('100 bp scoring requires exactly one 100 bp sequence.');
          const checksum = primaryKind === 'upload' && uploadedInput.file ? await sha256File(uploadedInput.file) : await sha256Text(parsedInput.normalizedForChecksum);
          run = {
            ...base, mode: 'candidate', parameters: prototypeParameters('candidate', strandMode, cutoff, effectiveStride),
            input: {
              kind: 'candidate', displayName: 'candidate_sequence', format: parsedInput.format, length: 100, checksum,
              sourceKind: primaryKind, fileName: primaryKind === 'upload' ? uploadedInput.file?.name || null : null,
              fileSize: primaryKind === 'upload' ? uploadedInput.file?.size || null : null,
              genomeContext: await resolveGenomeContextMetadata(),
            },
          };
        } else {
          run = {
            ...base,
            mode: 'genome-scan',
            parameters: prototypeParameters('genome-scan', strandMode, cutoff, strideBases),
            input: {
              kind: 'genome-scan',
              scanSource: await primaryScanSourceMetadata(),
              genomeContext: await resolveGenomeContextMetadata(),
            },
          };
        }
        if (run.mode === 'genome-scan') {
          const parsed = primaryKind === 'catalog' ? parsePrototypeSequenceInput((await primaryScanSequence()).fasta) : parsedInput;
          if (parsed) registerPrototypeTransientInput(run.runId, parsed);
        }
        writePrototypePredictionRun(run);
        router.push(`/predict/demo/${encodeURIComponent(runId)}`);
        return;
      }

      let request: Record<string, unknown>;
      let bases: number;
      let referenceName: string;
      let label: string;
      let historyMode: PredictionHistoryEntry['mode'];
      if (inferredMode === 'candidate') {
        if (!parsedInput || parsedInput.records.length !== 1 || parsedInput.records[0].length !== 100 || primaryKind === 'catalog') throw new Error('100 bp scoring requires exactly one 100 bp sequence.');
        const sequence = parsedInput.records[0].normalizedSequence;
        if (usesCachedCgr) {
          if (contextCatalog?.kind !== 'catalog' || !/^GCF_\d{9}\.\d+$/.test(contextCatalog.accession)) {
            throw new Error('Cached short-sequence prediction currently requires a versioned GCF accession.');
          }
          request = {
            mode: 'predict', complete_genome: true, sequence,
            reference_accession: contextCatalog.accession,
            reverse_complementary: strandMode === 'both',
          };
          bases = sequence.length;
          referenceName = contextCatalog.accession;
        } else {
          const context = await resolveGenomeContextSequence();
          request = {
            mode: 'predict', complete_genome: true, sequence, fasta: context.fasta,
            reverse_complementary: strandMode === 'both',
          };
          bases = sequence.length + context.totalLength;
          referenceName = context.referenceName;
        }
        label = primaryKind === 'upload' ? uploadedInput.file?.name || 'Short sequence' : 'Short sequence';
        historyMode = 'predict';
      } else {
        const genome = await primaryScanSequence();
        const sameCatalogGenome = primaryKind === 'catalog'
          && contextKind === 'catalog'
          && inputCatalog?.kind === 'catalog'
          && contextCatalog?.kind === 'catalog'
          && inputCatalog?.accession === contextCatalog?.accession;
        const context = sameCatalogGenome ? genome : await resolveGenomeContextSequence();
        const scanSourceProvidesCgr = genome.sequence === context.sequence;
        request = {
          mode: 'genome_scan', complete_genome: true, fasta: genome.fasta,
          ...(scanSourceProvidesCgr ? {} : { genome_context: context.sequence }),
          stride: strideBases, reverse_complementary: strandMode === 'both',
          ...genomeScanOutputs(strideBases, service, cutoff),
        };
        bases = genome.totalLength + (scanSourceProvidesCgr ? 0 : context.totalLength);
        referenceName = genome.referenceName;
        label = genome.label;
        historyMode = 'genome_scan';
      }

      if (!localTest && !turnstileToken) throw new Error('Complete the human verification before submitting.');
      const issued = await predictionApi<PredictionTicket>('/api/prediction-tickets', {
        method: 'POST',
        body: JSON.stringify({ mode: historyMode, ...(localTest ? {} : { turnstileToken }), modelVersion, bases }),
      });
      if (!issued.ticket) throw new Error('Prediction ticket response is invalid.');
      const created = await predictionApi<CreatedDockerJob>('/api/predictions/jobs', {
        method: 'POST',
        headers: { Authorization: `Ticket ${issued.ticket}` },
        body: JSON.stringify(request),
      });
      if (!created.job_id || !created.access_token) throw new Error('Prediction job response is invalid.');
      const entry: PredictionHistoryEntry = {
        jobId: created.job_id,
        token: created.access_token,
        refName: referenceName,
        status: 'queued',
        mode: historyMode,
        submittedAt: new Date().toISOString(),
        label,
        bases,
        ...((historyMode === 'predict' || service.supportsScoreCutoff) ? { cutoff } : {}),
        strandMode,
        strideBases,
      };
      localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify(upsertPredictionHistory(parsePredictionHistory(localStorage.getItem(PREDICTION_HISTORY_KEY)), entry)));
      sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(entry));
      router.push(`/predict/task/${encodeURIComponent(created.job_id)}`);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : !preview ? 'Prediction could not be queued.' : 'The prototype run could not be prepared.');
      setSubmitting(false);
      if (!preview) { setTurnstileToken(''); setVerificationRevision((value) => value + 1); }
    }
  }

  const parsedDescription = parsedInput
    ? `${parsedInput.records.length} record${parsedInput.records.length === 1 ? '' : 's'} · ${parsedInput.totalLength.toLocaleString()} bp${parsedInput.skippedContigs.length ? ` · ${parsedInput.skippedContigs.length} short contig${parsedInput.skippedContigs.length === 1 ? '' : 's'} skipped` : ''}`
    : null;
  const activeInputLabel = primaryKind === 'inline' ? 'Pasted sequence' : primaryKind === 'upload' ? 'FASTA file' : 'Catalog genome';
  const activeInputDescription = primaryKind === 'catalog'
    ? `${inputCatalog?.displayName || 'Catalog genome'} · ${PORTAL_TERMS.sequenceScan}`
    : parsedDescription;
  const activeContextLabel = contextKind === 'catalog' ? 'Catalog genome' : 'Matching genome FASTA';
  const expectedExampleGenome = (primaryKind === 'inline' && inlineInput === PROTOTYPE_CANDIDATE_EXAMPLE)
    || (primaryKind === 'catalog' && inputCatalog?.kind === 'catalog' && inputCatalog.accession === PROTOTYPE_CANDIDATE_GENOME_EXAMPLE.accession)
    ? PROTOTYPE_CANDIDATE_GENOME_EXAMPLE
    : null;
  const submitGuidance = submissionBlock
    ? { title: 'Prediction unavailable', detail: 'Your input is kept. Prediction can start once the site configuration is complete.' }
    : needsExampleReference && exampleLoading
      ? { title: 'Verifying reference', detail: 'Wait for the reference download and checksum verification.' }
    : !inputReady
    ? { title: 'Prediction input required', detail: 'Add input in Step 1.' }
    : !contextReady
      ? { title: 'Genome context required', detail: 'Select a catalog genome or upload its FASTA in Step 2.' }
      : !parametersReady
        ? !strideReady
          ? { title: 'Check the stride', detail: `Enter a whole number from ${PROTOTYPE_MIN_STRIDE_BASES} to ${PROTOTYPE_MAX_STRIDE_BASES}.` }
          : { title: `Check the ${activeThresholdLabel.toLowerCase()}`, detail: 'Enter a value from 0 to 1.' }
        : !preview && !localTest && !turnstileToken
          ? { title: 'Human verification required', detail: 'Complete the verification above before queuing the task.' }
        : !preview
          ? { title: 'Ready to queue', detail: 'The validated input and matching CGR genome will be sent to the configured RAPPTOR prediction service.' }
          : { title: 'Ready to preview', detail: PORTAL_COPY.demoNotice };
  const submitLabel = submitting ? (!preview ? 'Queuing…' : 'Preparing…') : (!preview ? 'Queue prediction' : 'Preview illustrative result');
  const inputPrivacyCopy = !preview
    ? 'The selected input is sent to the configured prediction service only after you queue the task.'
    : 'The session stores a checksum, lengths, and generic record IDs—not DNA or FASTA headers.';
  const contextPrivacyCopy = !preview
    ? usesCachedCgr
      ? 'Only the exact accession version is submitted; the prediction service reuses a matching CGR cache or calculates it from that exact reference.'
      : 'The complete genome is sent to the configured prediction service to calculate its CGR context.'
    : 'Genome FASTA stays in this browser; sessionStorage receives only metadata and a checksum.';

  return (
    <main className={styles.page}>
      <section className={`${styles.hero} portal-shell`} aria-labelledby="prototype-heading">
        <div><p className="portal-kicker">{preview ? 'Prediction prototype' : localTest ? '本地真实预测测试' : 'Queued prediction'}</p><h1 id="prototype-heading">{PORTAL_COPY.prototypeHeading}</h1><p>{PORTAL_COPY.prototypeModeHelp}</p>{localTest && !preview ? <p>无需邮箱登录或人机验证。使用线上 {modelVersion} 候选模型进行真实推理。</p> : null}</div>
      </section>

      <section className={`${styles.workspace} portal-shell`} aria-label="Prediction input">
        <form onSubmit={submitPrediction} className={styles.form} noValidate>
          <div className={styles.formHeading}>
            <div><span>Automatic analysis</span><h2>Sequence or genome input</h2></div>
          </div>

          <fieldset ref={primaryStepRef} className={styles.stepCard} tabIndex={-1}>
            <legend><span>1</span><div>Add a sequence or genome<small>Paste raw DNA or FASTA, or choose a FASTA file</small></div></legend>
            <div className={styles.pasteSource}>
              <label className={styles.fieldLabel} htmlFor="prototype-sequence-input">Raw DNA or FASTA</label>
              <textarea id="prototype-sequence-input" rows={7} spellCheck={false} value={inlineInput} aria-invalid={primaryKind === 'inline' && Boolean(inputError)} aria-describedby="prototype-input-status" onChange={(event) => { setInlineInput(event.target.value); setPrimaryKind('inline'); clearGenomeContext(); setFormError(null); }} placeholder=">sequence&#10;ACGT..." />
              <p className={styles.localNote}>Paste up to {maxSequenceBases.toLocaleString()} bases. {inputPrivacyCopy}</p>
              <div className={styles.exampleRow} aria-label="Examples">
                <span>Try an example</span>
                <div><button type="button" onClick={loadFocusedExample} disabled={exampleLoading}>Use 100 bp example</button><button type="button" onClick={loadGenomeExample} disabled={exampleLoading}>Use E. coli K-12 genome example</button></div>
              </div>
              <p className={styles.localNote}>E. coli K-12 MG1655 · {REAL_PREDICTION_REFERENCE.accession} · {REAL_PREDICTION_REFERENCE.length.toLocaleString()} bp. The 100 bp example is {REAL_PREDICTION_REFERENCE.sequenceId}:100001–100100 (+), a reference-genome fragment.</p>
              {needsExampleReference && exampleLoading ? <p role="status">Loading and verifying the complete reference genome…</p> : null}
              {needsExampleReference && !exampleLoading && !exampleError && verifiedExample.current ? <p className={styles.localNote} role="status">Verified reference: {REAL_PREDICTION_REFERENCE.sequenceId} · {REAL_PREDICTION_REFERENCE.length.toLocaleString()} bp · SHA-256 {REAL_PREDICTION_REFERENCE.fastaSha256.slice(0, 12)}… · <a href={REAL_PREDICTION_REFERENCE.sourceUrl}>NCBI FASTA source</a></p> : null}
              {needsExampleReference && exampleError ? <div role="alert"><p>{exampleError}</p><button type="button" onClick={() => void prepareExampleReference()}>Retry reference download</button></div> : null}
              <div className={`${styles.fileAction} ${styles.primaryFileAction}`}>
                <button type="button" onClick={() => primaryFileRef.current?.click()}><UploadFileRoundedIcon aria-hidden="true" fontSize="small" />{uploadedInput.file ? 'Replace FASTA' : 'Upload FASTA'}</button>
                {uploadedInput.file ? <button type="button" aria-label="Remove uploaded FASTA" onClick={removePrimaryFile}>Remove</button> : null}
                <span className={styles.fileMeta}>{uploadedInput.loading ? 'Reading file metadata…' : uploadedInput.file ? `${uploadedInput.file.name} · ${formatPrototypeBytes(uploadedInput.file.size)}` : `FASTA (.fa, .fasta, .fna, optionally .gz) · max ${genomeLimitLabel}`}</span>
                <input ref={primaryFileRef} className={styles.hiddenInput} hidden type="file" accept=".fa,.fasta,.fna,.fa.gz,.fasta.gz,.fna.gz" onChange={handlePrimaryFile} />
              </div>
              {uploadedInput.error ? <p className={styles.fileError}>{uploadedInput.error}</p> : null}
            </div>

            <div id="prototype-input-status" className={`${styles.inferenceStatus} ${inputError ? styles.invalid : inferredMode ? styles.valid : ''}`} aria-live="polite">
              {inputError ? <span>{inputError}</span> : inferredMode ? <><span>Selected analysis</span><strong>{inferredLabel(inferredMode)}</strong><small>{activeInputLabel} · {activeInputDescription}</small></> : <span>Add input to select short-sequence prediction or a sequence scan.</span>}
            </div>
          </fieldset>

          {inferredMode ? (
            <fieldset ref={contextStepRef} className={styles.stepCard} tabIndex={-1}>
              <legend><span>2</span><div>{PORTAL_TERMS.genomeContextCgr}<small>Required for every result</small></div></legend>
              <p className={styles.localNote}>Choose the complete genome containing the input. {PORTAL_COPY.biologicalMatchUnavailable}</p>
              {expectedExampleGenome ? (
                <div className={styles.expectedContextPrompt}>
                  <div><span>Recommended genome for this example</span><strong>{expectedExampleGenome.displayName}</strong><small>{expectedExampleGenome.accession}</small></div>
                  <button type="button" onClick={() => selectContextCatalog(expectedExampleGenome)}>Use this genome</button>
                </div>
              ) : null}
              <div className={styles.contextSources}>
                <div className={styles.catalogSource}>
                  <p className={styles.sourceHeading}>Find the genome in the catalog</p>
                  <CatalogPicker idPrefix="prototype-context-catalog" selected={contextCatalog} onSelect={selectContextCatalog} onUploadInstead={() => contextFileRef.current?.click()} />
                </div>
                <div className={styles.contextUploadSource}>
                  <p className={styles.sourceHeading}>Or upload the genome FASTA</p>
                  <div className={styles.fileAction}>
                    <div><strong>{contextUpload.file?.name || 'Choose genome FASTA'}</strong><span>{contextUpload.loading ? 'Reading metadata…' : contextUpload.file ? formatPrototypeBytes(contextUpload.file.size) : `.fa, .fasta, or .fna, optionally .gz · max ${genomeLimitLabel}`}</span></div>
                    <button type="button" onClick={() => contextFileRef.current?.click()}>{contextUpload.file ? 'Replace FASTA file' : 'Choose FASTA file'}</button>
                    {contextUpload.file ? <button type="button" aria-label="Remove genome FASTA" onClick={removeContextFile}>Remove</button> : null}
                    <input ref={contextFileRef} className={styles.hiddenInput} hidden type="file" accept=".fa,.fasta,.fna,.fa.gz,.fasta.gz,.fna.gz" onChange={handleContextFile} />
                  </div>
                  <p className={contextUpload.error ? styles.fileError : styles.localNote}>{contextUpload.error || contextPrivacyCopy}</p>
                </div>
              </div>
              <p className={`${styles.contextStatus} ${contextReady ? styles.valid : ''}`} aria-live="polite">{contextReady ? `Genome context ready: ${activeContextLabel}.` : 'Select a catalog genome or upload its FASTA.'}</p>
            </fieldset>
          ) : null}

          {inferredMode ? (
            <fieldset ref={parameterStepRef} className={styles.stepCard} tabIndex={-1}>
              <legend><span>3</span><div>Parameters<small>Controls for the selected analysis</small></div></legend>
              <div className={styles.parameterGrid}>
                <label><span>Strands</span><select value={strandMode} onChange={(event) => setStrandMode(event.target.value as PrototypeStrandMode)}><option value="both">Both strands</option><option value="forward">Forward only</option></select><small>Evaluate the forward sequence alone or both orientations.</small></label>
                <label><span>{automaticPeaks ? 'Peak cutoff' : activeThresholdLabel}</span><input type="number" min="0" max="1" step="0.01" disabled={cutoffUnavailable} value={Number.isFinite(cutoff) ? cutoff : ''} aria-invalid={!cutoffReady} aria-describedby="prototype-cutoff-help" onChange={(event) => setCutoff(event.target.value === '' ? Number.NaN : Number(event.target.value))} /><small id="prototype-cutoff-help">{automaticPeaks ? `Local maxima above this cutoff are called as peaks at ${strideBases} bp sampling resolution.` : cutoffUnavailable ? 'This service does not support export filtering. All computed scores are retained.' : cutoffReady ? (inferredMode === 'candidate' ? PORTAL_COPY.focusedThresholdHelp : strideBases === 1 ? 'Filters smoothed GFF3 scores and sets the peak-calling cutoff.' : 'Filters the sparse JSON result; BigWig and Parquet retain all computed scores.') : 'Enter a value from 0 to 1.'}</small></label>
                <label><span>{PORTAL_TERMS.stride}</span><input type="number" min={PROTOTYPE_MIN_STRIDE_BASES} max={PROTOTYPE_MAX_STRIDE_BASES} step="1" inputMode="numeric" aria-label={PORTAL_TERMS.stride} aria-describedby="prototype-stride-help" value={Number.isFinite(strideBases) ? strideBases : ''} aria-invalid={!strideReady} onChange={(event) => setStrideBases(event.target.value === '' ? Number.NaN : Number(event.target.value) as PrototypeStrideBases)} /><small id="prototype-stride-help">{inferredMode === 'candidate' ? `A 100 bp input contains one window. You can record a stride from ${PROTOTYPE_MIN_STRIDE_BASES} to ${PROTOTYPE_MAX_STRIDE_BASES}, but it does not change this single score.` : strideReady ? `Bases between consecutive 100 bp windows. Enter an integer from ${PROTOTYPE_MIN_STRIDE_BASES} to ${PROTOTYPE_MAX_STRIDE_BASES}.` : `Enter an integer from ${PROTOTYPE_MIN_STRIDE_BASES} to ${PROTOTYPE_MAX_STRIDE_BASES}.`}</small></label>
              </div>
            </fieldset>
          ) : null}

          {submissionBlock ? <div role="alert"><p>{submissionBlock}</p><button type="button" onClick={() => router.refresh()}>Check availability again</button></div> : null}
          {formError ? <div className={styles.formError} role="alert">{formError}</div> : null}
          {verificationVisible ? <div className={styles.verificationRow}>
            <div><span>Final check</span><strong>Human verification</strong><small>Complete this immediately before queuing the task.</small></div>
            <PredictionVerification key={verificationRevision} siteKey={service.siteKey} onToken={setTurnstileToken} />
          </div> : null}
          <div className={styles.submitBar}>
            <div><strong>{submitGuidance.title}</strong><span id="prototype-submit-guidance">{submitGuidance.detail}</span></div>
            <button type="submit" aria-describedby="prototype-submit-guidance" disabled={submitting || (needsExampleReference && exampleLoading) || Boolean(submissionBlock) || (!preview && !localTest && !turnstileToken)}>{submitLabel}</button>
          </div>
        </form>
      </section>
    </main>
  );
}
