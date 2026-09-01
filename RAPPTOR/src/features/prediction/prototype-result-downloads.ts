import type {
  PrototypeCalledPeak,
  PrototypePredictionFixture,
  PrototypePredictionRun,
  PrototypeScoreWindow,
} from './prototype';

export type PrototypeDownloadFormat = 'json' | 'tsv' | 'bedgraph' | 'gff3' | 'bed';

export interface PrototypeDownloadFile {
  body: string;
  fileName: string;
  mediaType: string;
}

function score(value: number) {
  return value.toFixed(6);
}

function resultFeatures(run: PrototypePredictionRun, fixture: PrototypePredictionFixture): Array<PrototypeScoreWindow | PrototypeCalledPeak> {
  if (run.mode === 'genome-scan') return fixture.calledPeaks;
  return focusedWindowsForDownload(fixture);
}

function publicParameters(run: PrototypePredictionRun) {
  return run.mode === 'genome-scan'
    ? { strandMode: run.parameters.strandMode, cutoff: run.parameters.cutoff, topK: run.parameters.topK, peakCalling: 'backend-managed' }
    : { strandMode: run.parameters.strandMode, cutoff: run.parameters.cutoff };
}

function publicWindow(window: PrototypeScoreWindow) {
  return {
    sequenceId: window.sequenceId,
    anchor1Based: window.anchor,
    windowStart1Based: window.windowStart,
    windowEnd1Based: window.windowEnd,
    strand: window.strand,
    rawScore: window.score,
  };
}

function publicPeak(peak: PrototypeCalledPeak) {
  return {
    ...publicWindow(peak),
    smoothedScore: peak.smoothedScore,
    feature: 'called-peak',
  };
}

function publicFocusedWindow(window: PrototypeScoreWindow, cutoff: number) {
  return {
    ...publicWindow(window),
    resultType: 'focused-window',
    cutoff,
    cutoffState: window.score > cutoff ? 'above-cutoff' : 'at-or-below-cutoff',
  };
}

export function prototypeResultJson(run: PrototypePredictionRun, fixture: PrototypePredictionFixture) {
  const genomeContext = run.input.genomeContext;
  const payload = {
    schemaVersion: 1,
    prototype: true,
    notice: 'No model was run. These values are deterministic interface fixtures.',
    runId: run.runId,
    mode: run.mode,
    createdAt: run.createdAt,
    modelVersion: run.modelSpec.version,
    input: run.mode === 'candidate'
      ? {
          displayName: run.input.displayName,
          format: run.input.format,
          length: run.input.length,
          checksum: run.input.checksum,
          genomeContext: genomeContext.displayName,
        }
      : {
          displayName: genomeContext.displayName,
          fileName: genomeContext.fileName,
          totalLength: genomeContext.totalLength,
          checksum: genomeContext.checksum,
        },
    parameters: publicParameters(run),
    rawScores: run.mode === 'candidate'
      ? focusedWindowsForDownload(fixture).map((window) => publicFocusedWindow(window, run.parameters.cutoff))
      : fixture.scoreSeries.map(publicWindow),
    calledPeaks: run.mode === 'genome-scan' ? fixture.calledPeaks.map(publicPeak) : undefined,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function focusedWindowsForDownload(fixture: PrototypePredictionFixture) {
  return [...fixture.windows].sort((left, right) => left.strand === right.strand ? 0 : left.strand === '+' ? -1 : 1);
}

export function prototypeResultTsv(run: PrototypePredictionRun, fixture: PrototypePredictionFixture) {
  if (run.mode === 'candidate') {
    return [
      ['sequence_id', 'strand', 'raw_score', 'cutoff', 'cutoff_state', 'anchor_1based', 'window_start_1based', 'window_end_1based', 'result_type'].join('\t'),
      ...focusedWindowsForDownload(fixture).map((window) => [
        window.sequenceId,
        window.strand,
        score(window.score),
        score(run.parameters.cutoff),
        window.score > run.parameters.cutoff ? 'above-cutoff' : 'at-or-below-cutoff',
        window.anchor,
        window.windowStart,
        window.windowEnd,
        'focused-window',
      ].join('\t')),
    ].join('\n') + '\n';
  }
  const rows = fixture.calledPeaks.map((peak, index) => [
    index + 1,
    peak.sequenceId,
    peak.anchor,
    peak.windowStart,
    peak.windowEnd,
    peak.strand,
    score(peak.rawScore),
    score(peak.smoothedScore),
    'called-peak',
  ]);
  return [
    ['rank', 'sequence_id', 'anchor_1based', 'window_start_1based', 'window_end_1based', 'strand', 'raw_score', 'smoothed_score', 'result_type'].join('\t'),
    ...rows.map((row) => row.join('\t')),
  ].join('\n') + '\n';
}

export function prototypeResultBedGraph(fixture: PrototypePredictionFixture) {
  return [
    'track type=bedGraph name="RAPPTOR prototype raw scores" description="Illustrative fixture; no model was run"',
    ...fixture.scoreSeries.map((window) => [
      window.sequenceId,
      Math.max(0, window.anchor - 1),
      window.anchor,
      score(window.score),
    ].join('\t')),
  ].join('\n') + '\n';
}

function safeGffAttribute(value: string) {
  return encodeURIComponent(value).replace(/%20/g, '%20');
}

export function prototypeResultGff3(run: PrototypePredictionRun, fixture: PrototypePredictionFixture) {
  const features = resultFeatures(run, fixture);
  return [
    '##gff-version 3',
    '# RAPPTOR prototype fixture. No model was run.',
    ...features.map((feature, index) => {
      const isPeak = 'smoothedScore' in feature;
      const featureName = isPeak ? 'called_peak' : 'focused_window';
      const attributes = [
        `ID=prototype_${featureName}_${index + 1}`,
        `Name=${safeGffAttribute(`Illustrative ${featureName.replace('_', ' ')}`)}`,
        `anchor_1based=${feature.anchor}`,
        `raw_score=${score(isPeak ? feature.rawScore : feature.score)}`,
        ...(isPeak ? [`smoothed_score=${score(feature.smoothedScore)}`] : []),
        ...(!isPeak ? [`cutoff=${score(run.parameters.cutoff)}`, `cutoff_state=${feature.score > run.parameters.cutoff ? 'above-cutoff' : 'at-or-below-cutoff'}`] : []),
        'prototype=true',
      ].join(';');
      const featureStart = isPeak ? feature.anchor : feature.windowStart;
      const featureEnd = isPeak ? feature.anchor : feature.windowEnd;
      const featureScore = isPeak ? feature.smoothedScore : feature.score;
      return [feature.sequenceId, 'RAPPTOR_prototype', featureName, featureStart, featureEnd, score(featureScore), feature.strand, '.', `${attributes};window_start_1based=${feature.windowStart};window_end_1based=${feature.windowEnd}`].join('\t');
    }),
  ].join('\n') + '\n';
}

export function prototypeResultBed6(run: PrototypePredictionRun, fixture: PrototypePredictionFixture) {
  return resultFeatures(run, fixture).map((feature, index) => {
    const isPeak = 'smoothedScore' in feature;
    const kind = isPeak ? 'called_peak' : 'focused_window';
    const resultScore = isPeak ? feature.smoothedScore : feature.score;
    const bedScore = Math.max(0, Math.min(1000, Math.round(resultScore * 1000)));
    const start = isPeak ? feature.anchor - 1 : feature.windowStart - 1;
    const end = isPeak ? feature.anchor : feature.windowEnd;
    return [feature.sequenceId, start, end, `prototype_${kind}_${index + 1}`, bedScore, feature.strand].join('\t');
  }).join('\n') + '\n';
}

function safeRunName(runId: string) {
  return runId.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 90);
}

export function buildPrototypeDownload(run: PrototypePredictionRun, fixture: PrototypePredictionFixture, format: PrototypeDownloadFormat): PrototypeDownloadFile {
  const baseName = `rapptor-${safeRunName(run.runId)}`;
  switch (format) {
    case 'json':
      return { body: prototypeResultJson(run, fixture), fileName: `${baseName}.json`, mediaType: 'application/json;charset=utf-8' };
    case 'tsv':
      return { body: prototypeResultTsv(run, fixture), fileName: `${baseName}.tsv`, mediaType: 'text/tab-separated-values;charset=utf-8' };
    case 'bedgraph':
      return { body: prototypeResultBedGraph(fixture), fileName: `${baseName}.bedGraph`, mediaType: 'text/plain;charset=utf-8' };
    case 'gff3':
      return { body: prototypeResultGff3(run, fixture), fileName: `${baseName}.gff3`, mediaType: 'text/plain;charset=utf-8' };
    case 'bed':
      return { body: prototypeResultBed6(run, fixture), fileName: `${baseName}.bed`, mediaType: 'text/plain;charset=utf-8' };
  }
}

export function downloadPrototypeResult(run: PrototypePredictionRun, fixture: PrototypePredictionFixture, format: PrototypeDownloadFormat) {
  const file = buildPrototypeDownload(run, fixture, format);
  const url = URL.createObjectURL(new Blob([file.body], { type: file.mediaType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
