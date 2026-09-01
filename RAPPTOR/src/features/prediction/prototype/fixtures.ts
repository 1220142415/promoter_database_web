import {
  PROTOTYPE_ANCHOR_BASE,
  PROTOTYPE_WINDOW_BASES,
  type PrototypeCalledPeak,
  type PrototypeContigMetadata,
  type PrototypePredictionFixture,
  type PrototypePredictionParameters,
  type PrototypePredictionRun,
  type PrototypeScoreWindow,
  type PrototypeStrand,
  type PrototypeWindowParameters,
} from './types';

const FIXTURE_CONTIGS: PrototypeContigMetadata[] = [
  { sequenceId: 'demo_contig_A', length: 920 },
  { sequenceId: 'demo_contig_B', length: 760 },
  { sequenceId: 'demo_plasmid', length: 540 },
];

const INTERNAL_PEAK_SEPARATION_BASES = 10;

export const PROTOTYPE_CANDIDATE_EXAMPLE = [
  '>focused_candidate_100bp',
  'ACGT'.repeat(25),
].join('\n');

export const PROTOTYPE_CONTIG_EXAMPLE = [
  '>tutorial_contig_A',
  'ACGT'.repeat(40),
  '>short_contig_skipped',
  'TGCA'.repeat(20),
  '>tutorial_contig_B',
  'GATT'.repeat(35),
].join('\n');

export const PROTOTYPE_CANDIDATE_GENOME_EXAMPLE = {
  kind: 'catalog' as const,
  accession: 'GCF_000005845.2',
  displayName: 'Escherichia coli str. K-12 substr. MG1655 (tutorial context)',
  fileName: 'GCF_000005845.2.reference.fna.gz',
  fileSize: null,
  checksum: '33f9e5082e35d141d2b1bb9fc20786b48f760981c14c508476212d2d75c85d01',
  totalLength: 4_641_652,
  contigs: [{ sequenceId: 'NC_000913.3', length: 4_641_652 }],
};

export const PROTOTYPE_GENOME_EXAMPLE = {
  kind: 'catalog' as const,
  accession: 'RAPPTOR_TUTORIAL_001',
  displayName: 'RAPPTOR paired multi-contig tutorial genome',
  fileName: 'rapptor-tutorial-contigs.fna',
  fileSize: 2_298,
  checksum: '4ea0b813ea8cb1d7acfac151f068e27520aab2efb1101207fd37777157078464',
  totalLength: FIXTURE_CONTIGS.reduce((total, contig) => total + contig.length, 0),
  contigs: FIXTURE_CONTIGS,
};

function hashSeed(value: string) {
  let seed = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    seed ^= value.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return seed >>> 0;
}

function pseudoRandom(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function windowParameters(parameters: PrototypePredictionParameters): PrototypeWindowParameters {
  return {
    strandMode: parameters.strandMode,
    cutoff: parameters.cutoff,
    topK: parameters.mode === 'genome-scan' ? parameters.topK : null,
  };
}

function coordinates(windowStart: number, strand: PrototypeStrand) {
  return {
    anchor: strand === '+'
      ? windowStart + PROTOTYPE_ANCHOR_BASE - 1
      : windowStart + PROTOTYPE_WINDOW_BASES - PROTOTYPE_ANCHOR_BASE,
    windowStart,
    windowEnd: windowStart + PROTOTYPE_WINDOW_BASES - 1,
  };
}

function illustrativeScore(position: number, totalPositions: number, random: () => number, strand: PrototypeStrand) {
  const normalized = totalPositions <= 1 ? 0 : position / (totalPositions - 1);
  const centers = strand === '+' ? [0.17, 0.51, 0.79] : [0.31, 0.66, 0.91];
  const amplitudes = strand === '+' ? [0.8, 0.99, 0.86] : [0.75, 0.94, 0.8];
  let score = 0.035 + random() * 0.11;
  centers.forEach((center, index) => {
    const width = 0.018 + index * 0.006;
    score += amplitudes[index] * Math.exp(-((normalized - center) ** 2) / (2 * width ** 2));
  });
  return Math.min(0.997, Math.round(score * 1000) / 1000);
}

function windowsForSequence(
  sequenceId: string,
  sequenceLength: number,
  parameters: PrototypePredictionParameters,
  seedText: string,
  maximumPoints: number | null,
) {
  const validStarts = Math.max(1, sequenceLength - PROTOTYPE_WINDOW_BASES + 1);
  const step = maximumPoints && validStarts > maximumPoints
    ? Math.max(1, Math.floor(validStarts / maximumPoints))
    : 1;
  const starts: number[] = [];
  for (let start = 1; start <= validStarts; start += step) starts.push(start);
  if (starts.at(-1) !== validStarts) starts.push(validStarts);
  const strands: PrototypeStrand[] = parameters.strandMode === 'both' ? ['+', '-'] : ['+'];
  const metadata = windowParameters(parameters);
  const output: PrototypeScoreWindow[] = [];

  for (const strand of strands) {
    const random = pseudoRandom(hashSeed(`${seedText}:${sequenceId}:${strand}`));
    starts.forEach((windowStart, index) => {
      output.push({
        sequenceId,
        ...coordinates(windowStart, strand),
        strand,
        score: illustrativeScore(index, starts.length, random, strand),
        parameters: metadata,
      });
    });
  }
  return output;
}

function smoothSeries(windows: PrototypeScoreWindow[]) {
  const bySeries = new Map<string, PrototypeScoreWindow[]>();
  windows.forEach((window) => {
    const key = `${window.sequenceId}:${window.strand}`;
    bySeries.set(key, [...(bySeries.get(key) || []), window]);
  });

  const smoothed = new Map<PrototypeScoreWindow, number>();
  for (const series of bySeries.values()) {
    series.sort((left, right) => left.anchor - right.anchor);
    series.forEach((window, index) => {
      const previous = series[index - 1]?.score ?? window.score;
      const next = series[index + 1]?.score ?? window.score;
      smoothed.set(window, Math.round(((previous + 2 * window.score + next) / 4) * 1000) / 1000);
    });
  }
  return { bySeries, smoothed };
}

export function callPrototypePeaks(
  windows: PrototypeScoreWindow[],
  cutoff: number,
): PrototypeCalledPeak[] {
  const { bySeries, smoothed } = smoothSeries(windows);
  const candidates: PrototypeCalledPeak[] = [];

  for (const series of bySeries.values()) {
    const localMaxima: PrototypeCalledPeak[] = [];
    series.forEach((window, index) => {
      const score = smoothed.get(window) ?? window.score;
      const previous = index === 0 ? -Infinity : (smoothed.get(series[index - 1]) ?? series[index - 1].score);
      const next = index === series.length - 1 ? -Infinity : (smoothed.get(series[index + 1]) ?? series[index + 1].score);
      if (score > cutoff && score >= previous && score >= next) {
        localMaxima.push({ ...window, rawScore: window.score, smoothedScore: score });
      }
    });

    const retained: PrototypeCalledPeak[] = [];
    for (const peak of localMaxima.sort((left, right) => right.smoothedScore - left.smoothedScore || right.rawScore - left.rawScore || left.anchor - right.anchor)) {
      if (retained.every((existing) => Math.abs(existing.anchor - peak.anchor) >= INTERNAL_PEAK_SEPARATION_BASES)) {
        retained.push(peak);
      }
    }
    candidates.push(...retained);
  }

  return candidates.sort((left, right) => left.sequenceId.localeCompare(right.sequenceId) || left.anchor - right.anchor || left.strand.localeCompare(right.strand));
}

function fallbackContigs(run: PrototypePredictionRun) {
  const context = run.input.genomeContext;
  if (context.contigs.length) return context.contigs;
  const length = context.totalLength && context.totalLength >= PROTOTYPE_WINDOW_BASES
    ? context.totalLength
    : 2_400;
  return [
    { sequenceId: 'illustrative_contig_1', length: Math.max(600, Math.round(length * 0.5)) },
    { sequenceId: 'illustrative_contig_2', length: Math.max(500, Math.round(length * 0.3)) },
    { sequenceId: 'illustrative_contig_3', length: Math.max(400, Math.round(length * 0.2)) },
  ];
}

export function createPrototypeFixture(run: PrototypePredictionRun): PrototypePredictionFixture {
  const genomeContext = run.input.genomeContext;
  const checksum = run.mode === 'candidate'
    ? run.input.checksum
    : genomeContext.checksum
      || `${genomeContext.kind}:${genomeContext.kind === 'catalog' ? genomeContext.accession : genomeContext.fileName}:${genomeContext.totalLength ?? 'unknown'}`;
  const windows = run.mode === 'candidate'
    ? windowsForSequence('candidate_sequence', run.input.length, run.parameters, checksum, null)
    : fallbackContigs(run).flatMap((contig) => windowsForSequence(contig.sequenceId, contig.length, run.parameters, checksum, 180));
  const scoreSeries = [...windows].sort((left, right) => left.sequenceId.localeCompare(right.sequenceId) || left.anchor - right.anchor || left.strand.localeCompare(right.strand));
  const calledPeaks = run.mode === 'genome-scan'
    ? callPrototypePeaks(windows, run.parameters.cutoff)
    : [];
  return { runId: run.runId, mode: run.mode, windows, scoreSeries, calledPeaks };
}
