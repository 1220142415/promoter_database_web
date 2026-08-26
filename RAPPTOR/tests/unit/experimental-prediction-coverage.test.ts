import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  auditExperimentalPredictionCoverage,
  coverageAuditToTsv,
  loadCatalogEntries,
  loadHfInputMapping,
  mergeEntryMaps,
  parseExperimentalManifestText,
} from '../../scripts/huggingface/lib/experimental-prediction-coverage.mjs';

const execute = promisify(execFile);
const temporary: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'seqedge-coverage-'));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function checksum(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

function manifest(accessions: string[]) {
  return [
    'study_id\tdataset_row\tgcf\tpmid\tsource_file\tsource_sha256\toutput_file\trecord_count',
    ...accessions.map((accession, index) => `2020_1234567${index}_${accession}\t${index + 1}\t${accession}\t1234567${index}\ta.bed\t${'a'.repeat(64)}\tb.bed\t1`),
    '',
  ].join('\n');
}

describe('experimental prediction coverage audit', () => {
  it('classifies exact HF coverage without guessing absent accessions and emits stable TSV', async () => {
    const root = await tempRoot();
    const mapping = join(root, 'input_mapping.tsv');
    await writeFile(mapping, [
      'accession\tbatch',
      'GCF_000000001.1\t000',
      '',
    ].join('\n'));
    const experimental = parseExperimentalManifestText(manifest(['GCF_000000001.1', 'GCF_000000002.1']));
    const predictions = await loadHfInputMapping(mapping);
    const audit = auditExperimentalPredictionCoverage(experimental, predictions);
    expect(audit.summary).toMatchObject({ experimentalGenomes: 2, exact_compatible: 1, prediction_missing: 1 });
    expect(audit.records.map((record) => [record.experimentalAccession, record.classification])).toEqual([
      ['GCF_000000001.1', 'exact_compatible'],
      ['GCF_000000002.1', 'prediction_missing'],
    ]);
    expect(audit.records[0].referenceComparison.status).toBe('unavailable');
    expect(coverageAuditToTsv(audit)).toContain('GCF_000000001.1\tGCF_000000001.1\texact_compatible\texact_accession');
  });

  it('uses only explicit reciprocal assembly metadata and verifies local FAI dictionaries', async () => {
    const root = await tempRoot();
    const experimentalPath = join(root, 'experimental.json');
    const predictionPath = join(root, 'prediction.json');
    await mkdir(join(root, 'objects', 'GCF_000000003.1'), { recursive: true });
    await mkdir(join(root, 'objects', 'GCA_999999999.1'), { recursive: true });
    await writeFile(join(root, 'objects', 'GCF_000000003.1', 'ref.fai'), 'chr\t10\t0\t10\t11\n');
    await writeFile(join(root, 'objects', 'GCA_999999999.1', 'ref.fai'), 'chr\t10\t0\t10\t11\n');
    await writeFile(experimentalPath, JSON.stringify({ genomes: [{
      accession: 'GCF_000000003.1',
      genbankAssemblyAccession: 'GCA_999999999.1',
      assets: { fastaFai: 'objects/GCF_000000003.1/ref.fai' },
    }, { accession: 'GCF_000000004.1' }] }));
    await writeFile(predictionPath, JSON.stringify({ genomes: [{
      accession: 'GCA_999999999.1',
      refseqAssemblyAccession: 'GCF_000000003.1',
      assets: { fastaFai: 'objects/GCA_999999999.1/ref.fai' },
    }, { accession: 'GCA_000000004.1' }] }));
    const audit = auditExperimentalPredictionCoverage(
      await loadCatalogEntries(experimentalPath, 'experimental_catalog'),
      await loadCatalogEntries(predictionPath, 'prediction_catalog'),
    );
    expect(audit.records[0]).toMatchObject({
      predictionAccession: 'GCA_999999999.1',
      classification: 'reciprocal_gca_gcf_candidate',
      matchBasis: 'reciprocal_explicit_metadata',
      referenceComparison: { status: 'structurally_compatible', contigDictionaryMatch: true },
    });
    expect(audit.records[1]).toMatchObject({ predictionAccession: null, classification: 'prediction_missing' });
  });

  it('reports reference mismatches and conflicting metadata separately', async () => {
    const root = await tempRoot();
    const experimentalPath = join(root, 'experimental.json');
    const predictionPath = join(root, 'prediction.json');
    const a = checksum('reference-a');
    const b = checksum('reference-b');
    await writeFile(experimentalPath, JSON.stringify({ genomes: [
      { accession: 'GCF_000000005.1', checksums: { fasta: a } },
      { accession: 'GCF_000000006.1', checksums: { fasta: a }, referenceStorage: { checksums: { fasta: b } } },
    ] }));
    await writeFile(predictionPath, JSON.stringify({ genomes: [
      { accession: 'GCF_000000005.1', checksums: { fasta: b } },
      { accession: 'GCF_000000006.1', checksums: { fasta: a } },
    ] }));
    const audit = auditExperimentalPredictionCoverage(
      await loadCatalogEntries(experimentalPath), await loadCatalogEntries(predictionPath),
    );
    expect(audit.records[0]).toMatchObject({ classification: 'reference_mismatch', referenceComparison: { checksumMatch: false } });
    expect(audit.records[1]).toMatchObject({ classification: 'metadata_incomplete', metadataIssues: ['conflicting_reference_checksums'] });
  });

  it('marks a manifest/catalog coverage hole as incomplete', async () => {
    const root = await tempRoot();
    const catalogPath = join(root, 'experimental.json');
    await writeFile(catalogPath, JSON.stringify({ genomes: [{ accession: 'GCF_000000007.1' }] }));
    const experimental = mergeEntryMaps([
      await loadCatalogEntries(catalogPath),
      parseExperimentalManifestText(manifest(['GCF_000000007.1', 'GCF_000000008.1'])),
    ]);
    const predictions = parseExperimentalManifestText(manifest(['GCF_000000007.1', 'GCF_000000008.1']));
    const audit = auditExperimentalPredictionCoverage(experimental, predictions, { experimentalCatalogExpected: true });
    expect(audit.records[1]).toMatchObject({ classification: 'metadata_incomplete', metadataIssues: ['missing_experimental_catalog_metadata'] });
  });

  it('rejects invalid accessions and unsafe reference paths', async () => {
    expect(() => parseExperimentalManifestText(manifest(['GCF_000000009.1']).replace('GCF_000000009.1', 'GCF_9.1'))).toThrow('invalid');
    const root = await tempRoot();
    const catalogPath = join(root, 'catalog.json');
    await writeFile(catalogPath, JSON.stringify({ genomes: [{
      accession: 'GCF_000000009.1', assets: { fastaFai: '../outside.fai' },
    }] }));
    await expect(loadCatalogEntries(catalogPath)).rejects.toThrow('unsafe');
    const mappingPath = join(root, 'input_mapping.tsv');
    await writeFile(mappingPath, 'accession\tfai_path\nGCF_000000009.1\tC:\\outside.fai\n');
    await expect(loadHfInputMapping(mappingPath)).rejects.toThrow('invalid');
  });

  it('runs the CLI and writes deterministic JSON and TSV artifacts', async () => {
    const root = await tempRoot();
    const manifestPath = join(root, 'manifest.tsv');
    const mappingPath = join(root, 'input_mapping.tsv');
    const output = join(root, 'audit');
    await writeFile(manifestPath, manifest(['GCF_000000010.1']));
    await writeFile(mappingPath, 'path\n000/genomes/GCF_000000010.1_genomic.fna.gz\n');
    await execute(process.execPath, [
      join(process.cwd(), 'scripts', 'huggingface', 'audit-experimental-prediction-coverage.mjs'),
      '--experimental-manifest', manifestPath,
      '--prediction-mapping', mappingPath,
      '--output-dir', output,
    ]);
    const json = JSON.parse(await readFile(join(output, 'experimental-prediction-coverage.json'), 'utf8'));
    expect(json.summary).toMatchObject({ exact_compatible: 1, prediction_missing: 0 });
    expect(await readFile(join(output, 'experimental-prediction-coverage.tsv'), 'utf8')).toContain('exact_compatible');
  });
});
