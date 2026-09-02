'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChangeEvent, FormEvent, useMemo, useRef, useState } from 'react';
import UploadFileRoundedIcon from '@mui/icons-material/UploadFileRounded';
import type { GenomeCatalogRow, GenomeSearchResponse } from '@/features/genomes/types';
import { sha256File, sha256Text } from '@/features/prediction/client';
import {
  DEFAULT_PROTOTYPE_MODEL_SPEC,
  PROTOTYPE_CANDIDATE_EXAMPLE,
  PROTOTYPE_CANDIDATE_GENOME_EXAMPLE,
  PROTOTYPE_PREDICTION_SCHEMA_VERSION,
  PROTOTYPE_STRIDE_BASES,
  PROTOTYPE_STRIDE_OPTIONS,
  createPrototypeRunId,
  formatPrototypeBytes,
  illustrativeCatalogContigs,
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
import { registerPrototypeTransientInput } from './transient-input';
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
      const exactMatch = payload.items.find((item) => item.accession.toUpperCase() === query.trim().toUpperCase());
      if (exactMatch) {
        onSelect(catalogContext(exactMatch));
        setResults([]);
        return;
      }
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
        <input id={`${idPrefix}-search`} role="combobox" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls={`${idPrefix}-results`} value={query} onChange={(event) => {
          const nextQuery = event.target.value;
          setQuery(nextQuery);
          if (nextQuery.trim().toUpperCase() === PROTOTYPE_CANDIDATE_GENOME_EXAMPLE.accession) {
            onSelect(PROTOTYPE_CANDIDATE_GENOME_EXAMPLE);
            setResults([]);
            setError(null);
          }
        }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void search(); } }} placeholder="GCF_000005845.2 or Escherichia coli" />
        <button type="button" onClick={() => void search()} disabled={loading}>{loading ? 'Searching…' : 'Search catalog'}</button>
      </div>
      {error ? (
        <div className={styles.catalogError} role="alert">
          <p>{error}</p>
          <div><button type="button" onClick={() => void search()}>Retry search</button><button type="button" onClick={onUploadInstead}>Upload FASTA instead</button><Link href="/help/prediction#troubleshooting">Open Help</Link></div>
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
  return mode === 'candidate' ? 'Focused 100 bp window' : 'Sequence / contig scan';
}

export default function PrototypePredictionWorkbench({ modelVersion = DEFAULT_PROTOTYPE_MODEL_SPEC.version }: { modelVersion?: string }) {
  const router = useRouter();
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
  const parametersReady = Number.isFinite(cutoff) && cutoff >= 0 && cutoff <= 1;
  const contextReady = Boolean(inferredMode) && (contextKind === 'catalog' ? Boolean(contextCatalog) : Boolean(contextUpload.file && !contextUpload.error && !contextUpload.loading));
  const inputReady = primaryKind === 'catalog'
    ? Boolean(inputCatalog)
    : primaryKind === 'upload'
      ? Boolean(parsedInput && !inputError && !uploadedInput.loading)
      : Boolean(parsedInput && !inputError);
  function clearGenomeContext() {
    setContextKind('catalog');
    setContextCatalog(null);
    setContextUpload(EMPTY_CONTEXT_UPLOAD);
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
    setFormError(null);
  }

  function loadGenomeExample() {
    setPrimaryKind('catalog');
    setInputCatalog(PROTOTYPE_CANDIDATE_GENOME_EXAMPLE);
    clearGenomeContext();
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
    setContextKind('upload');
    setFormError(null);
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

  async function resolveGenomeContext(): Promise<PrototypeGenomeContext> {
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

  async function primaryScanSource(): Promise<PrototypeGenomeContext> {
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

  async function submitPrototype(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const revealStep = (step: HTMLFieldSetElement | null) => {
      step?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      step?.focus({ preventScroll: true });
    };
    if (!inputReady || !inferredMode) {
      setFormError('Add a valid sequence or genome input in Step 1 before previewing a result.');
      revealStep(primaryStepRef.current);
      return;
    }
    if (!contextReady) {
      setFormError('Genome context for CGR is required. Select a catalog genome or upload the matching genome FASTA in Step 2.');
      revealStep(contextStepRef.current);
      return;
    }
    if (!parametersReady) {
      setFormError('Enter a score cutoff from 0 to 1 in Step 3.');
      revealStep(parameterStepRef.current);
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const runId = createPrototypeRunId();
      const base = { schemaVersion: PROTOTYPE_PREDICTION_SCHEMA_VERSION, runId, createdAt: new Date().toISOString(), modelSpec: { ...DEFAULT_PROTOTYPE_MODEL_SPEC, version: modelVersion, strideBases } };
      let run: PrototypePredictionRun;
      if (inferredMode === 'candidate') {
        if (!parsedInput || parsedInput.records.length !== 1 || parsedInput.records[0].length !== 100 || primaryKind === 'catalog') throw new Error('Focused candidate scoring requires exactly one 100 bp sequence.');
        const checksum = primaryKind === 'upload' && uploadedInput.file ? await sha256File(uploadedInput.file) : await sha256Text(parsedInput.normalizedForChecksum);
        run = {
          ...base, mode: 'candidate', parameters: prototypeParameters('candidate', strandMode, cutoff, strideBases),
          input: {
            kind: 'candidate', displayName: 'candidate_sequence', format: parsedInput.format, length: 100, checksum,
            sourceKind: primaryKind, fileName: primaryKind === 'upload' ? uploadedInput.file?.name || null : null,
            fileSize: primaryKind === 'upload' ? uploadedInput.file?.size || null : null,
            genomeContext: await resolveGenomeContext(),
          },
        };
      } else {
        run = {
          ...base,
          mode: 'genome-scan',
          parameters: prototypeParameters('genome-scan', strandMode, cutoff, strideBases),
          input: {
            kind: 'genome-scan',
            scanSource: await primaryScanSource(),
            genomeContext: await resolveGenomeContext(),
          },
        };
      }
      writePrototypePredictionRun(run);
      if (run.mode === 'genome-scan' && primaryKind !== 'catalog' && parsedInput) {
        registerPrototypeTransientInput(run.runId, parsedInput);
      }
      router.push(`/predict/demo/${encodeURIComponent(runId)}`);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : 'The prototype run could not be prepared.');
      setSubmitting(false);
    }
  }

  const parsedDescription = parsedInput
    ? `${parsedInput.records.length} record${parsedInput.records.length === 1 ? '' : 's'} · ${parsedInput.totalLength.toLocaleString()} bp${parsedInput.skippedContigs.length ? ` · ${parsedInput.skippedContigs.length} short contig${parsedInput.skippedContigs.length === 1 ? '' : 's'} skipped` : ''}`
    : null;
  const activeInputLabel = primaryKind === 'inline' ? 'Pasted sequence' : primaryKind === 'upload' ? 'FASTA file' : 'Catalog genome';
  const activeInputDescription = primaryKind === 'catalog'
    ? `${inputCatalog?.displayName || 'Catalog genome'} · Catalog genomes use a sequence scan.`
    : parsedDescription;
  const activeContextLabel = contextKind === 'catalog' ? 'Catalog genome' : 'Matching genome FASTA';
  const expectedExampleGenome = (primaryKind === 'inline' && inlineInput === PROTOTYPE_CANDIDATE_EXAMPLE)
    || (primaryKind === 'catalog' && inputCatalog?.kind === 'catalog' && inputCatalog.accession === PROTOTYPE_CANDIDATE_GENOME_EXAMPLE.accession)
    ? PROTOTYPE_CANDIDATE_GENOME_EXAMPLE
    : null;
  const submitGuidance = !inputReady
    ? { title: 'Prediction input required', detail: 'Complete Step 1 to detect the analysis and continue.' }
    : !contextReady
      ? { title: 'Genome context required', detail: 'Complete Step 2 by selecting a catalog genome or uploading the matching genome FASTA. The result preview will then become available.' }
      : !parametersReady
        ? { title: 'Check the score cutoff', detail: 'Enter a score cutoff from 0 to 1 to continue.' }
        : { title: 'Ready to preview', detail: 'The next page shows a deterministic illustrative result; no prediction model will run.' };
  const submitLabel = submitting ? 'Preparing…' : 'Preview illustrative result';

  return (
    <main className={styles.page}>
      <section className={`${styles.hero} portal-shell`} aria-labelledby="prototype-heading">
        <div><p className="portal-kicker">Prediction prototype</p><h1 id="prototype-heading">Prepare one input. RAPPTOR detects the analysis.</h1><p>A single 100 bp record is scored as a focused window. Longer sequences, multiple contigs, and catalog genomes use a sequence scan.</p></div>
      </section>

      <section className={`${styles.workspace} portal-shell`} aria-label="Prediction input">
        <form onSubmit={submitPrototype} className={styles.form}>
          <div className={styles.formHeading}>
            <div><span>Automatic detection</span><h2>Sequence or genome input</h2></div>
          </div>

          <fieldset ref={primaryStepRef} className={styles.stepCard} tabIndex={-1}>
            <legend><span>1</span><div>Add a sequence or genome<small>Paste raw DNA or FASTA, or choose a FASTA file</small></div></legend>
            <div className={styles.pasteSource}>
              <label className={styles.fieldLabel} htmlFor="prototype-sequence-input">Raw DNA or FASTA</label>
              <textarea id="prototype-sequence-input" rows={7} spellCheck={false} value={inlineInput} aria-invalid={primaryKind === 'inline' && Boolean(inputError)} aria-describedby="prototype-input-status" onChange={(event) => { setInlineInput(event.target.value); setPrimaryKind('inline'); clearGenomeContext(); setFormError(null); }} placeholder=">sequence&#10;ACGT..." />
              <p className={styles.localNote}>Paste up to 10,000 bases. The session stores a checksum, lengths, and generic record ids—not pasted DNA or FASTA headers.</p>
              <div className={styles.exampleRow} aria-label="Examples">
                <span>Try an example</span>
                <div><button type="button" onClick={loadFocusedExample}>Use 100 bp example</button><button type="button" onClick={loadGenomeExample}>Use E. coli K-12 genome example</button></div>
              </div>
              <div className={`${styles.fileAction} ${styles.primaryFileAction}`}>
                <button type="button" onClick={() => primaryFileRef.current?.click()}><UploadFileRoundedIcon aria-hidden="true" fontSize="small" />{uploadedInput.file ? 'Replace FASTA' : 'Upload FASTA'}</button>
                <span className={styles.fileMeta}>{uploadedInput.loading ? 'Reading file metadata…' : uploadedInput.file ? `${uploadedInput.file.name} · ${formatPrototypeBytes(uploadedInput.file.size)}` : 'FASTA (.fa, .fasta, .fna, optionally .gz) · max 50 MiB'}</span>
                <input ref={primaryFileRef} className={styles.hiddenInput} hidden type="file" accept=".fa,.fasta,.fna,.fa.gz,.fasta.gz,.fna.gz" onChange={handlePrimaryFile} />
              </div>
              {uploadedInput.error ? <p className={styles.fileError}>{uploadedInput.error}</p> : null}
            </div>

            <div id="prototype-input-status" className={`${styles.inferenceStatus} ${inputError ? styles.invalid : inferredMode ? styles.valid : ''}`} aria-live="polite">
              {inputError ? <span>{inputError}</span> : inferredMode ? <><span>Detected analysis</span><strong>{inferredLabel(inferredMode)}</strong><small>{activeInputLabel} · {activeInputDescription}</small></> : <span>Provide input to detect a focused 100 bp window or sequence scan.</span>}
            </div>
          </fieldset>

          {inferredMode ? (
            <fieldset ref={contextStepRef} className={styles.stepCard} tabIndex={-1}>
              <legend><span>2</span><div>Genome context for CGR<small>Required for every focused or scan result</small></div></legend>
              <p className={styles.localNote}>Choose the complete genome that contains the submitted sequence. The prototype cannot verify the biological match.</p>
              {expectedExampleGenome ? (
                <div className={styles.expectedContextPrompt}>
                  <div><span>Recommended CGR genome for this example</span><strong>{expectedExampleGenome.displayName}</strong><small>{expectedExampleGenome.accession}</small></div>
                  <button type="button" onClick={() => selectContextCatalog(expectedExampleGenome)}>Use this genome for CGR</button>
                </div>
              ) : null}
              <div className={styles.contextSources}>
                <div className={styles.catalogSource}>
                  <p className={styles.sourceHeading}>Find the CGR genome in the catalog</p>
                  <CatalogPicker idPrefix="prototype-context-catalog" selected={contextCatalog} onSelect={selectContextCatalog} onUploadInstead={() => contextFileRef.current?.click()} />
                </div>
                <div className={styles.contextUploadSource}>
                  <p className={styles.sourceHeading}>Or upload the CGR genome FASTA</p>
                  <div className={styles.fileAction}>
                    <div><strong>{contextUpload.file?.name || 'Choose CGR genome FASTA'}</strong><span>{contextUpload.loading ? 'Reading metadata…' : contextUpload.file ? formatPrototypeBytes(contextUpload.file.size) : '.fa, .fasta, or .fna, optionally .gz · maximum 50 MiB'}</span></div>
                    <button type="button" onClick={() => contextFileRef.current?.click()}>{contextUpload.file ? 'Replace FASTA file' : 'Choose FASTA file'}</button>
                    <input ref={contextFileRef} className={styles.hiddenInput} hidden type="file" accept=".fa,.fasta,.fna,.fa.gz,.fasta.gz,.fna.gz" onChange={handleContextFile} />
                  </div>
                  <p className={contextUpload.error ? styles.fileError : styles.localNote}>{contextUpload.error || 'Raw genome FASTA remains browser-local; only metadata and checksum enter sessionStorage.'}</p>
                </div>
              </div>
              <p className={`${styles.contextStatus} ${contextReady ? styles.valid : ''}`} aria-live="polite">{contextReady ? `CGR context ready: ${activeContextLabel}.` : 'Select a catalog genome or upload a genome FASTA for CGR.'}</p>
            </fieldset>
          ) : null}

          {inferredMode ? (
            <fieldset ref={parameterStepRef} className={styles.stepCard} tabIndex={-1}>
              <legend><span>3</span><div>Parameters<small>Controls for the detected analysis</small></div></legend>
              <div className={styles.parameterGrid}>
                <label><span>Strands</span><select value={strandMode} onChange={(event) => setStrandMode(event.target.value as PrototypeStrandMode)}><option value="both">Both strands</option><option value="forward">Forward only</option></select><small>Evaluate the forward sequence alone or both orientations.</small></label>
                <label><span>Score cutoff</span><input type="number" min="0" max="1" step="0.01" value={Number.isNaN(cutoff) ? '' : cutoff} aria-invalid={!parametersReady} aria-describedby="prototype-cutoff-help" onChange={(event) => setCutoff(event.target.value === '' ? Number.NaN : Number(event.target.value))} /><small id="prototype-cutoff-help">{parametersReady ? 'Changes filtering only; raw scores stay unchanged.' : 'Enter a value from 0 to 1.'}</small></label>
                <label><span>Step</span><select aria-label="Step" aria-describedby="prototype-stride-help" value={strideBases} onChange={(event) => setStrideBases(Number(event.target.value) as PrototypeStrideBases)}>{PROTOTYPE_STRIDE_OPTIONS.map((option) => <option key={option} value={option}>{option} nt</option>)}</select><small id="prototype-stride-help">{inferredMode === 'candidate' ? 'A 100 bp input contains one window.' : 'Bases between consecutive 100 nt windows.'}</small></label>
              </div>
            </fieldset>
          ) : null}

          {formError ? <div className={styles.formError} role="alert">{formError}</div> : null}
          <div className={styles.submitBar}>
            <div><strong>{submitGuidance.title}</strong><span id="prototype-submit-guidance">{submitGuidance.detail}</span></div>
            <button type="submit" aria-describedby="prototype-submit-guidance" disabled={submitting}>{submitLabel}</button>
          </div>
        </form>
      </section>
    </main>
  );
}
