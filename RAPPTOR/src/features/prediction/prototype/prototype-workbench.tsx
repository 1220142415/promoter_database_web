'use client';

import { useRouter } from 'next/navigation';
import { ChangeEvent, FormEvent, KeyboardEvent, useMemo, useRef, useState } from 'react';
import type { GenomeCatalogRow, GenomeSearchResponse } from '@/features/genomes/types';
import { predictionApi } from '@/features/prediction/client';
import { parsePredictionHistory, PREDICTION_HISTORY_KEY, upsertPredictionHistory, type PredictionHistoryEntry } from '@/features/prediction/history';
import {
  DEFAULT_PROTOTYPE_MODEL_SPEC,
  PROTOTYPE_CANDIDATE_EXAMPLE,
  PROTOTYPE_CANDIDATE_GENOME_EXAMPLE,
  PROTOTYPE_CONTIG_EXAMPLE,
  formatPrototypeBytes,
  illustrativeCatalogContigs,
  parsePrototypeSequenceInput,
  readPrototypeGenomeFastaMetadata,
  readPrototypeSequenceFile,
  validatePrototypeGenomeFile,
  validatePrototypeInlineLength,
  type PrototypeGenomeContext,
  type PrototypeParsedSequenceInput,
  type PrototypePredictionMode,
  type PrototypeStrandMode,
} from '.';
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
  return {
    kind: 'catalog',
    accession: row.accession,
    displayName: row.organismName || row.accession,
    fileName: `${row.accession}.reference.fna.gz`,
    fileSize: null,
    checksum: null,
    totalLength: row.genomeSizeBp,
    contigs: illustrativeCatalogContigs(row.accession, row.genomeSizeBp, row.contigCount),
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
      setResults(payload.items.slice(0, 8));
      if (!payload.items.length) setError('No matching assemblies were found. Try an accession, organism, or strain.');
    } catch {
      setResults([]);
      setError('Genome catalog could not be searched. Your other inputs are still here.');
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
        <input id={`${idPrefix}-search`} role="combobox" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls={`${idPrefix}-results`} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} placeholder="GCF_000005845.2 or Escherichia coli" />
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
  return mode === 'candidate' ? 'Focused candidate' : 'Genome scan';
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
  let response = await fetch(`/api/remote-data/${accession}/reference.fa.gz`, { cache: 'no-store' });
  if (!response.ok) response = await fetch(`/api/experimental-data/${accession}/reference.fa.gz`, { cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error('The selected catalog genome FASTA is not available. Choose another genome or upload FASTA.');
  let text: string;
  try {
    if (response.headers.get('content-type')?.startsWith('text/plain')) text = await response.text();
    else {
      if (typeof DecompressionStream === 'undefined') throw new Error('unsupported gzip');
      text = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
    }
  } catch {
    throw new Error('The selected catalog genome FASTA could not be decompressed.');
  }
  return parsedGenomeInput(parsePrototypeSequenceInput(text), context.displayName);
}

export default function PrototypePredictionWorkbench({
  modelVersion = DEFAULT_PROTOTYPE_MODEL_SPEC.version,
  localTest = false,
}: {
  modelVersion?: string;
  localTest?: boolean;
}) {
  const router = useRouter();
  const primaryFileRef = useRef<HTMLInputElement>(null);
  const contextFileRef = useRef<HTMLInputElement>(null);
  const [primaryKind, setPrimaryKind] = useState<PrimarySourceKind>('inline');
  const [inlineInput, setInlineInput] = useState('');
  const [uploadedInput, setUploadedInput] = useState<UploadedInputState>(EMPTY_UPLOAD);
  const [inputCatalog, setInputCatalog] = useState<PrototypeGenomeContext | null>(null);
  const [contextKind, setContextKind] = useState<ContextSourceKind>('catalog');
  const [contextCatalog, setContextCatalog] = useState<PrototypeGenomeContext | null>(null);
  const [contextUpload, setContextUpload] = useState<ContextUploadState>(EMPTY_CONTEXT_UPLOAD);
  const [strandMode, setStrandMode] = useState<PrototypeStrandMode>('both');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const inlineState = useMemo(() => {
    if (!inlineInput.trim()) return { parsed: null, error: null };
    try {
      const parsed = parsePrototypeSequenceInput(inlineInput);
      validatePrototypeInlineLength(parsed.totalLength);
      return { parsed, error: null };
    }
    catch (cause) { return { parsed: null, error: cause instanceof Error ? cause.message : 'Sequence input is invalid.' }; }
  }, [inlineInput]);

  const parsedInput = primaryKind === 'inline' ? inlineState.parsed : primaryKind === 'upload' ? uploadedInput.parsed : null;
  const inputError = primaryKind === 'inline' ? inlineState.error : primaryKind === 'upload' ? uploadedInput.error : null;
  const inferredMode: PrototypePredictionMode | null = primaryKind === 'catalog' ? (inputCatalog ? 'genome-scan' : null) : parsedInput?.mode || null;
  const contextReady = inferredMode !== 'candidate' || (contextKind === 'catalog' ? Boolean(contextCatalog) : Boolean(contextUpload.file && !contextUpload.error && !contextUpload.loading));
  const inputReady = primaryKind === 'catalog'
    ? Boolean(inputCatalog)
    : primaryKind === 'upload'
      ? Boolean(parsedInput && !inputError && !uploadedInput.loading)
      : Boolean(parsedInput && !inputError);
  const workbenchReady = inputReady && contextReady && localTest;

  function choosePrimaryKind(next: PrimarySourceKind) {
    setPrimaryKind(next);
    setFormError(null);
  }

  function primaryTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const order: PrimarySourceKind[] = ['inline', 'upload', 'catalog'];
    const current = order.indexOf(primaryKind);
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (current + 1) % order.length;
    if (event.key === 'ArrowLeft') next = (current + order.length - 1) % order.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = order.length - 1;
    if (next === null) return;
    event.preventDefault();
    choosePrimaryKind(order[next]);
    document.getElementById(`prototype-input-${order[next]}-tab`)?.focus();
  }

  function contextTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    let next: ContextSourceKind | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = contextKind === 'catalog' ? 'upload' : 'catalog';
    if (event.key === 'Home') next = 'catalog';
    if (event.key === 'End') next = 'upload';
    if (!next) return;
    event.preventDefault();
    setContextKind(next);
    document.getElementById(`prototype-context-${next}-tab`)?.focus();
  }

  function loadFocusedExample() {
    setPrimaryKind('inline');
    setInlineInput(PROTOTYPE_CANDIDATE_EXAMPLE);
    setContextKind('catalog');
    setContextCatalog(PROTOTYPE_CANDIDATE_GENOME_EXAMPLE);
    setFormError(null);
  }

  function loadContigExample() {
    setPrimaryKind('inline');
    setInlineInput(PROTOTYPE_CONTIG_EXAMPLE);
    setFormError(null);
  }

  function loadExample(event: ChangeEvent<HTMLSelectElement>) {
    if (event.target.value === 'focused') loadFocusedExample();
    if (event.target.value === 'contig') loadContigExample();
    event.target.value = '';
  }

  async function handlePrimaryFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploadedInput({ file, parsed: null, loading: true, error: null });
    try {
      validatePrototypeGenomeFile(file);
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
    setContextUpload({ file, totalLength: null, contigs: [], loading: true, error: null });
    try {
      validatePrototypeGenomeFile(file);
      const metadata = await readPrototypeGenomeFastaMetadata(file);
      const valid = metadata.contigs.filter((contig) => contig.length >= 100);
      if (!valid.length) throw new Error('Genome context must contain at least one contig of 100 bp or longer.');
      setContextUpload({ file, totalLength: metadata.totalLength, contigs: valid, loading: false, error: null });
    } catch (cause) {
      setContextUpload({ file, totalLength: null, contigs: [], loading: false, error: cause instanceof Error ? cause.message : 'Genome context could not be read.' });
    }
  }

  async function resolveCandidateContext(): Promise<ResolvedGenomeInput> {
    if (contextKind === 'catalog') {
      if (!contextCatalog) throw new Error('Select the matching genome context.');
      return catalogGenomeInput(contextCatalog);
    }
    if (!contextUpload.file || contextUpload.error || contextUpload.loading) throw new Error('Choose a valid matching genome FASTA.');
    return parsedGenomeInput(await readPrototypeSequenceFile(contextUpload.file), contextUpload.file.name);
  }

  async function primaryGenomeContext(): Promise<ResolvedGenomeInput> {
    if (primaryKind === 'catalog') {
      if (!inputCatalog) throw new Error('Select a catalog genome.');
      return catalogGenomeInput(inputCatalog);
    }
    if (!parsedInput) throw new Error('Provide valid sequence input.');
    return parsedGenomeInput(parsedInput, primaryKind === 'upload' ? uploadedInput.file?.name || 'Uploaded FASTA' : 'Pasted sequence');
  }

  async function submitPrediction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inferredMode) return;
    setSubmitting(true);
    setFormError(null);
    try {
      let request: Record<string, unknown>;
      let bases: number;
      let referenceName: string;
      let label: string;
      let historyMode: PredictionHistoryEntry['mode'];
      if (inferredMode === 'candidate') {
        if (!parsedInput || parsedInput.records.length !== 1 || parsedInput.records[0].length !== 100 || primaryKind === 'catalog') throw new Error('Focused candidate scoring requires exactly one 100 bp sequence.');
        const context = await resolveCandidateContext();
        request = {
          mode: 'predict', complete_genome: true,
          sequence: parsedInput.records[0].normalizedSequence,
          genome_context: context.sequence,
          reverse_complementary: false,
        };
        bases = 100 + context.totalLength;
        referenceName = context.referenceName;
        label = primaryKind === 'upload' ? uploadedInput.file?.name || 'Candidate sequence' : 'Candidate sequence';
        historyMode = 'predict';
      } else {
        const genome = await primaryGenomeContext();
        request = {
          mode: 'genome_scan', complete_genome: true, fasta: genome.fasta,
          stride: 1, reverse_complementary: strandMode === 'both',
          output_formats: ['bigwig', 'gff3'],
        };
        bases = genome.totalLength;
        referenceName = genome.referenceName;
        label = genome.label;
        historyMode = 'genome_scan';
      }

      const issued = await predictionApi<PredictionTicket>('/api/prediction-tickets', {
        method: 'POST',
        body: JSON.stringify({ turnstileToken: 'local-test', modelVersion, bases }),
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
      };
      localStorage.setItem(PREDICTION_HISTORY_KEY, JSON.stringify(upsertPredictionHistory(parsePredictionHistory(localStorage.getItem(PREDICTION_HISTORY_KEY)), entry)));
      sessionStorage.setItem('rapptor-prediction-job', JSON.stringify(entry));
      router.push(`/predict/task/${encodeURIComponent(created.job_id)}`);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'Prediction could not be queued.');
      setSubmitting(false);
    }
  }

  const parsedDescription = parsedInput
    ? `${parsedInput.records.length} record${parsedInput.records.length === 1 ? '' : 's'} · ${parsedInput.totalLength.toLocaleString()} bp${parsedInput.skippedContigs.length ? ` · ${parsedInput.skippedContigs.length} short contig${parsedInput.skippedContigs.length === 1 ? '' : 's'} skipped` : ''}`
    : null;

  return (
    <main className={styles.page}>
      <section className={`${styles.hero} portal-shell`} aria-labelledby="prototype-heading">
        <div><p className="portal-kicker">Queued prediction</p><h1 id="prototype-heading">Prepare one input. RAPPTOR infers the workflow.</h1><p>A single 100 bp record is scored as a focused candidate. Longer sequences, multiple contigs, and catalog genomes use the scan workflow.</p></div>
      </section>

      <section className={`${styles.workspace} portal-shell`} aria-label="Prediction workbench">
        <form onSubmit={submitPrediction} className={styles.form}>
          <div className={styles.formHeading}>
            <div><span>Automatic workflow</span><h2>Sequence or genome input</h2></div>
            <label className={styles.examplePicker}>
              <span>Example input</span>
              <select defaultValue="" onChange={loadExample}>
                <option value="" disabled>Choose an example…</option>
                <option value="focused">Focused 100 bp</option>
                <option value="contig">Multi-contig scan</option>
              </select>
            </label>
          </div>

          <fieldset className={styles.stepCard}>
            <legend><span>1</span><div>Choose the input<small>Paste sequence, upload FASTA, or select a catalog genome</small></div></legend>
            <div className={styles.sourceTabs} role="tablist" aria-label="Prediction input source">
              {(['inline', 'upload', 'catalog'] as const).map((kind) => <button key={kind} id={`prototype-input-${kind}-tab`} type="button" role="tab" tabIndex={primaryKind === kind ? 0 : -1} aria-selected={primaryKind === kind} aria-controls="prototype-input-panel" onKeyDown={primaryTabKeyDown} onClick={() => choosePrimaryKind(kind)}>{kind === 'inline' ? 'Paste sequence' : kind === 'upload' ? 'Upload FASTA' : 'Genome catalog'}</button>)}
            </div>

            <div id="prototype-input-panel" role="tabpanel" aria-labelledby={`prototype-input-${primaryKind}-tab`}>
              {primaryKind === 'inline' ? (
                <><label className={styles.fieldLabel} htmlFor="prototype-sequence-input">Raw DNA or FASTA</label><textarea id="prototype-sequence-input" rows={10} spellCheck={false} value={inlineInput} aria-invalid={Boolean(inputError)} aria-describedby="prototype-input-status" onChange={(event) => { setInlineInput(event.target.value); setFormError(null); }} placeholder=">sequence&#10;ACGT..." /><p className={styles.localNote}>Paste up to 10,000 bases. The sequence is sent only to the configured prediction service after you queue the task.</p></>
              ) : primaryKind === 'upload' ? (
                <div className={styles.uploadPanel}><button type="button" className={styles.uploadButton} onClick={() => primaryFileRef.current?.click()}><strong>{uploadedInput.file?.name || 'Choose sequence, genome, or contigs FASTA'}</strong><span>{uploadedInput.loading ? 'Reading metadata…' : uploadedInput.file ? formatPrototypeBytes(uploadedInput.file.size) : '.fa, .fasta, or .fna, optionally .gz · maximum 12 MiB'}</span></button><input ref={primaryFileRef} className={styles.hiddenInput} hidden type="file" accept=".fa,.fasta,.fna,.fa.gz,.fasta.gz,.fna.gz" onChange={handlePrimaryFile} /><p className={styles.localNote}>The selected sequence is sent only to the configured prediction service after you queue the task.</p></div>
              ) : <CatalogPicker idPrefix="prototype-input-catalog" selected={inputCatalog} onSelect={setInputCatalog} onUploadInstead={() => setPrimaryKind('upload')} />}
            </div>

            <div id="prototype-input-status" className={`${styles.inferenceStatus} ${inputError ? styles.invalid : inferredMode ? styles.valid : ''}`} aria-live="polite">
              {inputError ? <span>{inputError}</span> : inferredMode ? <><span>Detected workflow</span><strong>{inferredLabel(inferredMode)}</strong><small>{primaryKind === 'catalog' ? 'Catalog genomes use genome scan.' : parsedDescription}</small></> : <span>Provide input to detect Focused candidate or Genome scan.</span>}
            </div>
          </fieldset>

          {inferredMode === 'candidate' ? (
            <fieldset className={styles.stepCard}>
              <legend><span>2</span><div>Matching genome context<small>Focused scoring conditions the 100 bp sequence on its source genome</small></div></legend>
              <div className={styles.sourceTabs} role="tablist" aria-label="Matching genome context source">
                {(['catalog', 'upload'] as const).map((kind) => <button key={kind} id={`prototype-context-${kind}-tab`} type="button" role="tab" tabIndex={contextKind === kind ? 0 : -1} aria-selected={contextKind === kind} aria-controls="prototype-context-panel" onKeyDown={contextTabKeyDown} onClick={() => setContextKind(kind)}>{kind === 'catalog' ? 'Genome catalog' : 'Upload genome FASTA'}</button>)}
              </div>
              <div id="prototype-context-panel" role="tabpanel" aria-labelledby={`prototype-context-${contextKind}-tab`}>
                {contextKind === 'catalog' ? <CatalogPicker idPrefix="prototype-context-catalog" selected={contextCatalog} onSelect={setContextCatalog} onUploadInstead={() => setContextKind('upload')} /> : <div className={styles.uploadPanel}><button type="button" className={styles.uploadButton} onClick={() => contextFileRef.current?.click()}><strong>{contextUpload.file?.name || 'Choose matching genome or contigs FASTA'}</strong><span>{contextUpload.loading ? 'Reading metadata…' : contextUpload.file ? formatPrototypeBytes(contextUpload.file.size) : '.fa, .fasta, or .fna, optionally .gz · maximum 12 MiB'}</span></button><input ref={contextFileRef} className={styles.hiddenInput} hidden type="file" accept=".fa,.fasta,.fna,.fa.gz,.fasta.gz,.fna.gz" onChange={handleContextFile} /><p className={contextUpload.error ? styles.fileError : styles.localNote}>{contextUpload.error || 'The complete genome is sent only to the configured prediction service to calculate its CGR context.'}</p></div>}
              </div>
            </fieldset>
          ) : null}

          {inferredMode ? (
            <fieldset className={styles.stepCard}>
              <legend><span>{inferredMode === 'candidate' ? '3' : '2'}</span><div>Parameters and summary<small>Controls appropriate for the detected workflow</small></div></legend>
              <div className={`${styles.parameterGrid} ${styles.parameterGridFocused}`}>
                {inferredMode === 'genome-scan'
                  ? <label><span>Strands</span><select value={strandMode} onChange={(event) => setStrandMode(event.target.value as PrototypeStrandMode)}><option value="both">Both strands</option><option value="forward">Forward only</option></select><small>Scan the forward assembly alone or both orientations.</small></label>
                  : <label><span>Orientation</span><input value="As provided" readOnly /><small>Focused scoring preserves the submitted 100 bp orientation.</small></label>}
              </div>
              {inferredMode === 'genome-scan' ? <p className={styles.managedPeakNote}>Peak calling uses backend-managed settings in a future live service; they are not user parameters.</p> : null}
              <dl className={styles.modelFacts}><div><dt>Workflow</dt><dd>{inferredLabel(inferredMode)}</dd></div><div><dt>Window</dt><dd>100 nt</dd></div><div><dt>Anchor</dt><dd>80 / 20</dd></div><div><dt>CGR</dt><dd>128 × 128</dd></div><div><dt>Stride</dt><dd>1 nt</dd></div><div><dt>Model</dt><dd>{modelVersion}</dd></div></dl>
            </fieldset>
          ) : null}

          {formError ? <div className={styles.formError} role="alert">{formError}</div> : null}
          <div className={styles.submitBar}><div><strong>{localTest ? 'Docker prediction service' : 'Prediction service unavailable'}</strong><span>{localTest ? 'The validated input is queued for the configured RAPPtor model. Results stay private in this browser.' : 'This deployment is not configured for direct prediction submission.'}</span></div><button type="submit" disabled={!workbenchReady || submitting}>{submitting ? 'Queuing…' : 'Queue prediction'}</button></div>
        </form>
      </section>
    </main>
  );
}
