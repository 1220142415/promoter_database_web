'use client';

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import CloudUploadRoundedIcon from '@mui/icons-material/CloudUploadRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import type { GenomeSearchResponse } from '@/features/genomes/types';
import { predictionApi, PredictionClientError, sha256File, sha256Text } from '../client';
import type { DemoPredictionSubmission, GenomeContext, PredictionCapabilities, PredictionJob, PredictionSubmission, PredictionTicketResponse, PredictionUploadSlot } from '../types';
import { PREDICTION_CONTRACT_VERSION } from '../types';
import { parseTargetSequence, PredictionValidationError, validateTargetAgainstCapabilities } from '../validation';
import TurnstileField from './turnstile-field';
import styles from './prediction.module.css';

const EXAMPLE_SEQUENCE = '>example_candidate_112bp\nTTGACATGATCGATCGTACGATCGATGCTAGCTAGGCTAACGTTACGATCGATCGGATCCGATCGTTATAATGCGTACGATCGATCGATCGTAGCTAGCTAGCGATCGATCG';
const GENOME_FILE_PATTERN = /\.(?:fa|fasta|fna)(?:\.gz)?$/i;

type GenomeMode = 'catalog' | 'upload';
type SubmitMode = 'demo' | 'remote';
type CatalogSelection = GenomeSearchResponse['items'][number];

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function serviceCopy(capabilities: PredictionCapabilities) {
  if (capabilities.serviceStatus === 'ready') return { label: 'LIVE SERVICE', title: 'Cloud prediction is available', body: 'Validated inputs will be submitted to the configured RAPPtor inference service.', tone: styles.statusReady };
  if (capabilities.serviceStatus === 'unavailable') return { label: 'SERVICE UNAVAILABLE', title: 'Cloud inference is not connected', body: capabilities.unavailableReason || 'Cloud prediction is not available in this deployment yet.', tone: styles.statusUnavailable };
  return { label: 'DEMO PREVIEW', title: 'Explore the complete prediction workflow', body: 'No model runs. Raw sequence and genome files stay in this browser; only checksums and input metadata are used.', tone: styles.statusDemo };
}

export default function PredictionForm({ capabilities }: { capabilities: PredictionCapabilities }) {
  const router = useRouter();
  const targetFileRef = useRef<HTMLInputElement>(null);
  const genomeFileRef = useRef<HTMLInputElement>(null);
  const [sequenceInput, setSequenceInput] = useState('');
  const [strandMode, setStrandMode] = useState<'both' | 'forward'>('both');
  const [genomeMode, setGenomeMode] = useState<GenomeMode>('catalog');
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogResults, setCatalogResults] = useState<CatalogSelection[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogSearched, setCatalogSearched] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedGenome, setSelectedGenome] = useState<CatalogSelection | null>(null);
  const [genomeFile, setGenomeFile] = useState<File | null>(null);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [submittingMode, setSubmittingMode] = useState<SubmitMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demoFallback, setDemoFallback] = useState(false);

  const targetState = useMemo(() => {
    if (!sequenceInput.trim()) return { parsed: null, error: null };
    try {
      const parsed = parseTargetSequence(sequenceInput);
      validateTargetAgainstCapabilities(parsed, capabilities);
      return { parsed, error: null };
    } catch (cause) {
      return { parsed: null, error: cause instanceof Error ? cause.message : 'Candidate sequence is invalid.' };
    }
  }, [capabilities, sequenceInput]);

  const genomeFileError = useMemo(() => {
    if (!genomeFile) return null;
    if (!GENOME_FILE_PATTERN.test(genomeFile.name)) return 'Choose a .fa, .fasta or .fna file, optionally gzip-compressed.';
    if (genomeFile.size > capabilities.limits.genomeMaxBytes) return `Genome FASTA exceeds ${formatBytes(capabilities.limits.genomeMaxBytes)}.`;
    return null;
  }, [capabilities.limits.genomeMaxBytes, genomeFile]);

  const genomeReady = genomeMode === 'catalog' ? Boolean(selectedGenome) : Boolean(genomeFile && !genomeFileError);
  const formReady = Boolean(targetState.parsed && genomeReady);
  const status = serviceCopy(capabilities);
  const primaryMode: SubmitMode = capabilities.serviceStatus === 'ready' ? 'remote' : 'demo';

  useEffect(() => {
    if (genomeMode !== 'catalog' || selectedGenome || catalogQuery.trim().length < 2) {
      setCatalogResults([]);
      setCatalogSearched(false);
      setCatalogError(null);
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setCatalogLoading(true);
      setCatalogSearched(false);
      setCatalogError(null);
      try {
        const response = await predictionApi<GenomeSearchResponse>(`/api/genomes?q=${encodeURIComponent(catalogQuery.trim())}&limit=25`, { signal: controller.signal });
        setCatalogResults(response.items.slice(0, 8));
        setCatalogSearched(true);
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          setCatalogResults([]);
          setCatalogSearched(true);
          setCatalogError('Genome catalog could not be searched. Check the connection and try again.');
        }
      } finally {
        setCatalogLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [catalogQuery, genomeMode, selectedGenome]);

  const handleTargetFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setSequenceInput(await file.text());
      setError(null);
    } catch {
      setError('Candidate sequence file could not be read as text.');
    } finally {
      event.target.value = '';
    }
  };

  const chooseGenomeMode = (value: GenomeMode) => {
    setGenomeMode(value);
    setError(null);
  };

  const handleTurnstile = useCallback((token: string) => setTurnstileToken(token), []);

  const submit = async (mode: SubmitMode) => {
    setError(null);
    setDemoFallback(false);
    setSubmittingMode(mode);
    try {
      const target = parseTargetSequence(sequenceInput);
      validateTargetAgainstCapabilities(target, capabilities);
      if (genomeMode === 'catalog' && !selectedGenome) throw new PredictionClientError('INVALID_GENOME_CONTEXT', 'Select the matching genome assembly.');
      if (genomeMode === 'upload' && (!genomeFile || genomeFileError)) throw new PredictionClientError('INVALID_GENOME_CONTEXT', genomeFileError || 'Upload the matching genome or contigs FASTA.');

      const targetSha256 = await sha256Text(target.sequence);
      const genomeSha256 = genomeFile ? await sha256File(genomeFile) : null;

      if (mode === 'demo') {
        const demoSubmission: DemoPredictionSubmission = {
          contractVersion: PREDICTION_CONTRACT_VERSION,
          predictionKind: 'candidate',
          target: { format: target.format, length: target.length, sha256: targetSha256 },
          genomeContext: selectedGenome && genomeMode === 'catalog'
            ? { kind: 'catalog', accession: selectedGenome.accession, organismName: selectedGenome.organismName }
            : { kind: 'upload', fileName: genomeFile!.name, fileSize: genomeFile!.size, sha256: genomeSha256! },
          strandMode,
        };
        const job = await predictionApi<PredictionJob>('/api/predictions/demo', { method: 'POST', body: JSON.stringify(demoSubmission) });
        router.push(`/predict/${encodeURIComponent(job.jobId)}`);
        return;
      }

      if (!capabilities.available) throw new PredictionClientError('PREDICTION_UNAVAILABLE', capabilities.unavailableReason || 'Cloud prediction is unavailable.', true);
      if (!turnstileToken) throw new PredictionClientError('INVALID_TURNSTILE', 'Complete Turnstile verification before submitting.');
      const ticket = await predictionApi<PredictionTicketResponse>('/api/prediction-tickets', {
        method: 'POST',
        body: JSON.stringify({ contractVersion: PREDICTION_CONTRACT_VERSION, turnstileToken, modelVersion: capabilities.modelVersion, targetBases: target.length, genomeBytes: genomeFile?.size || 0 }),
      });

      let genomeContext: GenomeContext;
      if (genomeMode === 'catalog' && selectedGenome) {
        genomeContext = { kind: 'catalog', accession: selectedGenome.accession, organismName: selectedGenome.organismName };
      } else if (genomeFile && genomeSha256) {
        const slot = await predictionApi<PredictionUploadSlot>('/api/predictions/uploads', {
          method: 'POST',
          body: JSON.stringify({ contractVersion: PREDICTION_CONTRACT_VERSION, ticket: ticket.ticket, fileName: genomeFile.name, fileSize: genomeFile.size, sha256: genomeSha256 }),
        });
        if (slot.uploadRequired) {
          if (!slot.uploadUrl || slot.method !== 'PUT') throw new PredictionClientError('INVALID_UPLOAD_SLOT', 'Prediction service returned an invalid upload slot.');
          const uploadResponse = await fetch(slot.uploadUrl, { method: 'PUT', body: genomeFile, headers: slot.headers });
          if (!uploadResponse.ok) throw new PredictionClientError('UPLOAD_FAILED', 'Genome FASTA upload failed.', true);
        }
        genomeContext = { kind: 'upload', uploadToken: slot.uploadToken, fileName: genomeFile.name, fileSize: genomeFile.size, sha256: genomeSha256 };
      } else {
        throw new PredictionClientError('INVALID_GENOME_CONTEXT', 'Choose a genome context.');
      }

      const submission: PredictionSubmission = {
        contractVersion: PREDICTION_CONTRACT_VERSION,
        predictionKind: 'candidate',
        ticket: ticket.ticket,
        modelVersion: capabilities.modelVersion,
        target: { format: target.format, length: target.length, sha256: targetSha256, sequence: target.sequence },
        genomeContext,
        strandMode,
      };
      const job = await predictionApi<PredictionJob>('/api/predictions', { method: 'POST', body: JSON.stringify(submission) });
      await predictionApi<PredictionJob>(`/api/predictions/${encodeURIComponent(job.jobId)}/submit`, { method: 'POST' });
      router.push(`/predict/${encodeURIComponent(job.jobId)}`);
    } catch (cause) {
      if (cause instanceof PredictionValidationError || cause instanceof PredictionClientError) {
        setError(cause.message);
        if (mode === 'remote' && cause instanceof PredictionClientError && (cause.retryable || cause.code === 'PREDICTION_UNAVAILABLE' || cause.code.startsWith('PREDICTION_UPSTREAM_'))) setDemoFallback(capabilities.demoPreviewAvailable);
      } else {
        setError('Prediction submission failed. Please try again.');
        if (mode === 'remote') setDemoFallback(capabilities.demoPreviewAvailable);
      }
      setSubmittingMode(null);
    }
  };

  const primaryDisabled = !formReady || Boolean(submittingMode) || (primaryMode === 'remote' && !turnstileToken);

  return (
    <section className={styles.section} id="predict" aria-labelledby="prediction-heading">
      <div className="portal-shell">
        <div className={styles.heading}>
          <div><p className="portal-kicker">Interactive prediction</p><h2 id="prediction-heading">Predict a promoter candidate</h2></div>
          <p>Score a candidate region against the CGR context of the genome it came from. RAPPTOR scores are computational predictions, not experimental validation.</p>
        </div>

        <div className={`${styles.serviceBar} ${status.tone}`} role="status">
          <span className={styles.serviceBadge}>{status.label}</span>
          <div><strong>{status.title}</strong><span>{status.body}</span></div>
        </div>

        <div className={styles.workbench}>
          <div className={styles.workbenchHeader}>
            <div><span>INPUT WORKBENCH</span><strong>Candidate sequence and matching genome context</strong></div>
            <p><strong>{capabilities.windowBases} bp</strong> windows · base {capabilities.predictionAnchorBase} anchor</p>
          </div>

          <div className={styles.inputGrid}>
            <fieldset className={styles.card}>
              <legend><span>1</span><div>Candidate sequence<small>Raw DNA or one FASTA record</small></div></legend>
              <label className="sr-only" htmlFor="prediction-sequence">Candidate DNA sequence</label>
              <textarea id="prediction-sequence" value={sequenceInput} onChange={(event) => { setSequenceInput(event.target.value); setError(null); }} placeholder=">candidate_sequence&#10;TTGACA...TATAAT..." spellCheck={false} rows={10} aria-invalid={Boolean(targetState.error)} aria-describedby="prediction-sequence-status" />
              <div id="prediction-sequence-status" className={`${styles.inputStatus} ${targetState.error ? styles.inputInvalid : targetState.parsed ? styles.inputValid : ''}`} aria-live="polite">
                {targetState.error ? <><ErrorOutlineRoundedIcon aria-hidden="true" /><span>{targetState.error}</span></> : targetState.parsed ? <><CheckCircleRoundedIcon aria-hidden="true" /><span>{targetState.parsed.length.toLocaleString()} bases · {targetState.parsed.ambiguousBases ? `${targetState.parsed.ambiguousBases.toLocaleString()} N bases` : 'ACGT only'} · normalized</span></> : <span>Minimum {capabilities.windowBases} bases · ACGTN accepted · U becomes T</span>}
              </div>
              <div className={styles.anchorRule}><strong>Window layout</strong><span>{capabilities.predictionAnchorBase} bp upstream-side segment (anchor at base {capabilities.predictionAnchorBase}) + {capabilities.windowBases - capabilities.predictionAnchorBase} bp downstream-side segment.</span></div>
              <div className={styles.inlineActions}>
                <button type="button" onClick={() => targetFileRef.current?.click()}><CloudUploadRoundedIcon aria-hidden="true" /> Upload</button>
                <button type="button" onClick={() => { setSequenceInput(EXAMPLE_SEQUENCE); setError(null); }}><CheckCircleRoundedIcon aria-hidden="true" /> Use example</button>
                <button type="button" onClick={() => { setSequenceInput(''); setError(null); }} disabled={!sequenceInput}><DeleteOutlineRoundedIcon aria-hidden="true" /> Clear</button>
                <input ref={targetFileRef} className="sr-only" type="file" accept=".txt,.fa,.fasta,.fna,text/plain" onChange={handleTargetFile} />
              </div>
              <label className={styles.checkbox}><input type="checkbox" checked={strandMode === 'both'} onChange={(event) => setStrandMode(event.target.checked ? 'both' : 'forward')} /><span><strong>Evaluate both strands</strong><small>Recommended when orientation is unknown.</small></span></label>
            </fieldset>

            <fieldset className={styles.card}>
              <legend><span>2</span><div>Genome context for CGR<small>Must contain the candidate sequence</small></div></legend>
              <div className={styles.contextWarning}><strong>Why this matters</strong><span>An unrelated reference genome produces a biologically mismatched CGR representation.</span></div>
              <div className={styles.tabs} role="tablist" aria-label="Genome context source">
                <button type="button" role="tab" aria-selected={genomeMode === 'catalog'} className={genomeMode === 'catalog' ? styles.activeTab : ''} onClick={() => chooseGenomeMode('catalog')}>Catalog assembly</button>
                <button type="button" role="tab" aria-selected={genomeMode === 'upload'} className={genomeMode === 'upload' ? styles.activeTab : ''} onClick={() => chooseGenomeMode('upload')}>Upload genome FASTA</button>
              </div>

              {genomeMode === 'catalog' ? (
                <div className={styles.contextPicker}>
                  {selectedGenome ? <div className={styles.selectedGenome}><CheckCircleRoundedIcon aria-hidden="true" /><span><strong>{selectedGenome.accession}</strong><small>{selectedGenome.organismName}</small></span><button type="button" onClick={() => { setSelectedGenome(null); setCatalogQuery(''); }}>Change</button></div> : <>
                    <label htmlFor="prediction-genome-search">Search accession or organism</label>
                    <div className={styles.searchField}><SearchRoundedIcon aria-hidden="true" /><input id="prediction-genome-search" value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder="GCA_000411415.1 or organism name" autoComplete="off" /></div>
                    <div className={styles.searchResults} aria-live="polite">
                      {catalogLoading ? <p>Searching genome catalog…</p> : catalogResults.map((genome) => <button key={genome.accession} type="button" onClick={() => { setSelectedGenome(genome); setCatalogQuery(`${genome.accession} ${genome.organismName}`); setCatalogResults([]); }}><strong>{genome.accession}</strong><span>{genome.organismName}</span></button>)}
                      {catalogError ? <p className={styles.searchError}>{catalogError}</p> : null}
                      {!catalogLoading && !catalogError && catalogSearched && catalogResults.length === 0 ? <p>No matching assemblies found.</p> : null}
                    </div>
                  </>}
                </div>
              ) : (
                <div className={styles.uploadZone}>
                  <input ref={genomeFileRef} className="sr-only" type="file" accept=".fa,.fasta,.fna,.fa.gz,.fasta.gz,.fna.gz" onChange={(event) => { setGenomeFile(event.target.files?.[0] || null); setError(null); }} />
                  <button type="button" onClick={() => genomeFileRef.current?.click()}><CloudUploadRoundedIcon aria-hidden="true" /><span><strong>{genomeFile ? genomeFile.name : 'Choose genome or contigs FASTA'}</strong><small>{genomeFile ? formatBytes(genomeFile.size) : `FASTA or FASTA.gz · up to ${formatBytes(capabilities.limits.genomeMaxBytes)}`}</small></span></button>
                  {genomeFile ? <button className={styles.removeFile} type="button" onClick={() => setGenomeFile(null)}>Remove file</button> : null}
                  {genomeFileError ? <p className={styles.fileError}>{genomeFileError}</p> : <p>Demo preview computes a checksum locally; the raw file is never uploaded.</p>}
                </div>
              )}
            </fieldset>
          </div>

          <div className={styles.submitRow}>
            {capabilities.serviceStatus === 'ready' ? <TurnstileField capabilities={capabilities} onToken={handleTurnstile} /> : <div className={styles.localOnly} data-testid="demo-turnstile"><CheckCircleRoundedIcon aria-hidden="true" /><div><strong>Local-only demo preparation</strong><span>No raw candidate or genome sequence is submitted.</span></div></div>}
            <div className={styles.submitCopy}><strong>{primaryMode === 'demo' ? 'Preview the result interface' : 'Anonymous cloud submission'}</strong><span>{primaryMode === 'demo' ? 'The next page uses deterministic fixture scores and is not biological output.' : 'Turnstile, service quotas and queue capacity apply.'}</span></div>
            <button className={`portal-button portal-button-primary ${styles.submitButton}`} type="button" onClick={() => void submit(primaryMode)} disabled={primaryDisabled}>{submittingMode === primaryMode ? 'Preparing…' : primaryMode === 'demo' ? 'Preview demo result' : 'Submit prediction'}</button>
          </div>

          {error ? <div className={styles.formError} role="alert"><ErrorOutlineRoundedIcon aria-hidden="true" /><div><strong>Submission could not continue</strong><span>{error}</span></div>{demoFallback ? <button type="button" onClick={() => void submit('demo')} disabled={Boolean(submittingMode)}>{submittingMode === 'demo' ? 'Preparing demo…' : 'Preview demo result'}</button> : null}</div> : null}
        </div>
      </div>
    </section>
  );
}
