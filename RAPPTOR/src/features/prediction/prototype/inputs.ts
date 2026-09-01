import { PROTOTYPE_WINDOW_BASES, type PrototypeContigMetadata, type PrototypePredictionMode } from './types';
import { PrototypeValidationError } from './validation';

export interface PrototypeParsedSequenceRecord extends PrototypeContigMetadata {
  normalizedSequence: string;
}

export interface PrototypeParsedSequenceInput {
  format: 'raw' | 'fasta';
  records: PrototypeParsedSequenceRecord[];
  validContigs: PrototypeParsedSequenceRecord[];
  skippedContigs: PrototypeParsedSequenceRecord[];
  totalLength: number;
  mode: PrototypePredictionMode;
  normalizedForChecksum: string;
}

function normalizeSequenceId(header: string, index: number) {
  return header.trim().split(/\s+/, 1)[0] || `contig_${index}`;
}

function normalizeBases(value: string) {
  const sequence = value.replace(/\s+/g, '').toUpperCase().replaceAll('U', 'T');
  if (!sequence || !/^[ACGTN]+$/.test(sequence)) {
    throw new PrototypeValidationError('Only A, C, G, T, U, and N are accepted in sequence input.');
  }
  return sequence;
}

export function parsePrototypeSequenceInput(text: string): PrototypeParsedSequenceInput {
  const input = text.trim();
  if (!input) throw new PrototypeValidationError('Paste DNA or FASTA, upload a FASTA, or choose a catalog genome.');
  const format = input.startsWith('>') ? 'fasta' : 'raw';
  const records: PrototypeParsedSequenceRecord[] = [];

  if (format === 'raw') {
    const normalizedSequence = normalizeBases(input);
    records.push({ sequenceId: 'inline_sequence', length: normalizedSequence.length, normalizedSequence });
  } else {
    let header: string | null = null;
    let lines: string[] = [];
    const finishRecord = () => {
      if (header === null) return;
      const normalizedSequence = normalizeBases(lines.join(''));
      records.push({ sequenceId: normalizeSequenceId(header, records.length + 1), length: normalizedSequence.length, normalizedSequence });
    };
    for (const rawLine of input.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith('>')) {
        finishRecord();
        header = line.slice(1);
        lines = [];
      } else {
        if (header === null) throw new PrototypeValidationError('FASTA sequence data must follow a header beginning with >.');
        lines.push(line);
      }
    }
    finishRecord();
  }

  if (!records.length) throw new PrototypeValidationError('Sequence input does not contain a non-empty record.');
  const totalLength = records.reduce((total, record) => total + record.length, 0);
  const validContigs = records.filter((record) => record.length >= PROTOTYPE_WINDOW_BASES);
  const skippedContigs = records.filter((record) => record.length < PROTOTYPE_WINDOW_BASES);
  const isFocused = records.length === 1 && records[0].length === PROTOTYPE_WINDOW_BASES;
  if (!isFocused && (totalLength <= PROTOTYPE_WINDOW_BASES || !validContigs.length)) {
    throw new PrototypeValidationError('Scan input must total more than 100 bp and include at least one contig of 100 bp or longer.');
  }
  return {
    format,
    records,
    validContigs,
    skippedContigs,
    totalLength,
    mode: isFocused ? 'candidate' : 'genome-scan',
    normalizedForChecksum: records.map((record) => `>${record.sequenceId}\n${record.normalizedSequence}`).join('\n'),
  };
}

export function parsePrototypeGenomeFastaMetadata(text: string): PrototypeContigMetadata[] {
  const input = text.trim();
  if (!input.startsWith('>')) throw new PrototypeValidationError('Genome input must be FASTA with a header beginning with >.');
  const contigs: PrototypeContigMetadata[] = [];
  let header: string | null = null;
  let length = 0;
  const finishRecord = () => {
    if (header === null) return;
    if (!length) throw new PrototypeValidationError('Genome FASTA must not contain empty sequence records.');
    contigs.push({ sequenceId: normalizeSequenceId(header, contigs.length + 1), length });
  };
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      finishRecord();
      header = line.slice(1);
      length = 0;
      continue;
    }
    if (header === null) throw new PrototypeValidationError('Genome input must be FASTA with a header beginning with >.');
    length += normalizeBases(line).length;
  }
  finishRecord();
  if (!contigs.length) throw new PrototypeValidationError('Genome FASTA must contain at least one non-empty sequence record.');
  return contigs;
}

async function readFileText(file: File) {
  if (!/\.gz$/i.test(file.name)) return file.text();
  if (typeof DecompressionStream === 'undefined') {
    throw new PrototypeValidationError('This browser cannot inspect gzip FASTA files. Decompress the file and try again.');
  }
  try {
    const decompressed = file.stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(decompressed).text();
  } catch {
    throw new PrototypeValidationError('The gzip-compressed genome FASTA could not be read.');
  }
}

export async function readPrototypeSequenceFile(file: File) {
  return parsePrototypeSequenceInput(await readFileText(file));
}

export async function readPrototypeGenomeFastaMetadata(file: File) {
  const contigs = parsePrototypeGenomeFastaMetadata(await readFileText(file));
  return { contigs, totalLength: contigs.reduce((total, contig) => total + contig.length, 0) };
}

export function illustrativeCatalogContigs(accession: string, totalLength: number | null, contigCount: number | null) {
  if (!totalLength || totalLength < PROTOTYPE_WINDOW_BASES) return [];
  const count = Math.max(1, Math.min(contigCount || 1, 3));
  const baseLength = Math.floor(totalLength / count);
  return Array.from({ length: count }, (_, index) => ({
    sequenceId: `${accession}_contig_${index + 1}`,
    length: index === count - 1 ? totalLength - baseLength * index : baseLength,
  })).filter((contig) => contig.length >= PROTOTYPE_WINDOW_BASES);
}
