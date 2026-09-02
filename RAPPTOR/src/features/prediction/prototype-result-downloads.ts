import type {
  PrototypeCalledPeak,
  PrototypePredictionFixture,
  PrototypePredictionRun,
  PrototypeScoreWindow,
} from './prototype';

export type PrototypeDownloadFormat = 'bedgraph' | 'gff3';

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

function focusedWindowsForDownload(fixture: PrototypePredictionFixture) {
  return [...fixture.windows].sort((left, right) => left.strand === right.strand ? 0 : left.strand === '+' ? -1 : 1);
}

export function prototypeResultBedGraph(fixture: PrototypePredictionFixture) {
  const strands = (['+', '-'] as const).filter((strand) => fixture.scoreSeries.some((window) => window.strand === strand));
  return strands.flatMap((strand) => [
    `track type=bedGraph name="RAPPTOR prototype raw scores (${strand})" description="Illustrative fixture; no model was run"`,
    ...fixture.scoreSeries
      .filter((window) => window.strand === strand)
      .sort((left, right) => left.sequenceId.localeCompare(right.sequenceId) || left.anchor - right.anchor)
      .map((window) => [
        window.sequenceId,
        Math.max(0, window.anchor - 1),
        window.anchor,
        score(window.score),
      ].join('\t')),
  ]).join('\n') + '\n';
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

function safeRunName(runId: string) {
  return runId.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 90);
}

export function buildPrototypeDownload(run: PrototypePredictionRun, fixture: PrototypePredictionFixture, format: PrototypeDownloadFormat): PrototypeDownloadFile {
  const baseName = `rapptor-${safeRunName(run.runId)}`;
  switch (format) {
    case 'bedgraph':
      return { body: prototypeResultBedGraph(fixture), fileName: `${baseName}.bedGraph`, mediaType: 'text/plain;charset=utf-8' };
    case 'gff3':
      return { body: prototypeResultGff3(run, fixture), fileName: `${baseName}.gff3`, mediaType: 'text/plain;charset=utf-8' };
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
