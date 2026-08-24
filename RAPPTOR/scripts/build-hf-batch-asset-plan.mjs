#!/usr/bin/env node

import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const input = resolve(option('--input', 'gtdb_genome_metadata_r214.tsv'));
const output = resolve(option('--output', 'hf-batch-asset-plan'));
const releaseId = option('--release', 'gtdb-r214-2026-08-13');
const repository = option('--repo', 'liurulong/bacterial-promoter-genomes');
const revision = option('--revision', 'main');
const batchSize = Number(option('--batch-size', '1000'));
const expectedCount = Number(option('--expected-count', '80789'));
const scoreBatchValues = String(option('--score-batches', '') || '').split(',').map((batch) => batch.trim()).filter(Boolean);
const scoreBatches = new Set(scoreBatchValues);

if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('--batch-size must be a positive integer.');
if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) throw new Error('--expected-count must be a positive integer.');
if (!/^[a-z0-9][a-z0-9._-]+$/i.test(releaseId)) throw new Error('Invalid release ID.');
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid Hugging Face repository.');
if (!/^[\w./-]+$/.test(revision)) throw new Error('Invalid Hugging Face revision.');
if (scoreBatchValues.some((batch) => !/^\d{3}$/.test(batch)) || scoreBatches.size !== scoreBatchValues.length) {
  throw new Error('--score-batches must be a comma-separated list of unique three-digit batch IDs.');
}

const baseUrl = `https://huggingface.co/datasets/${repository}/resolve/${revision}`;
mkdirSync(output, { recursive: true });
const assetLinksPath = resolve(output, 'asset-links.tsv');
const assetLinks = createWriteStream(assetLinksPath);
assetLinks.write('accession\tbatch\treference_url\tpredicted_promoters_url\tpromoter_scores_plus_url\tpromoter_scores_minus_url\tncbi_annotations_url\n');

const batches = [];
let count = 0;
let previousAccession = null;
let currentBatch = null;
let sawHeader = false;

const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
for await (const line of lines) {
  if (!sawHeader) {
    const columns = line.split('\t');
    if (columns[0] !== 'accession') throw new Error('The metadata TSV must start with an accession column.');
    sawHeader = true;
    continue;
  }
  if (!line) continue;
  const accession = line.slice(0, line.indexOf('\t'));
  if (!/^GC[AF]_\d{9}\.\d+$/.test(accession)) throw new Error(`Invalid accession at record ${count + 1}: ${accession}`);
  if (previousAccession && accession.localeCompare(previousAccession) <= 0) {
    throw new Error(`Accessions are not strictly sorted: ${previousAccession}, ${accession}`);
  }
  const batchIndex = Math.floor(count / batchSize);
  if (!currentBatch || currentBatch.index !== batchIndex) {
    currentBatch = {
      index: batchIndex,
      id: String(batchIndex).padStart(3, '0'),
      firstAccession: accession,
      lastAccession: accession,
      count: 0,
      status: 'staged',
    };
    batches.push(currentBatch);
  }
  currentBatch.lastAccession = accession;
  currentBatch.count += 1;
  const batch = currentBatch.id;
  const referencePath = `${batch}/genomes/${accession}_genomic.fna.gz`;
  const promoterPath = `${batch}/promoter_gff/${accession}.promoters_up80_down20_gt_0.9.gff3`;
  const scoresPlusPath = scoreBatches.has(batch) ? `${batch}/promoter_bw/${accession}/promoter-scores.plus.bw` : '';
  const scoresMinusPath = scoreBatches.has(batch) ? `${batch}/promoter_bw/${accession}/promoter-scores.minus.bw` : '';
  const annotationPath = `${batch}/ncbi_gff3/${accession}.genomic.gff3.gz`;
  const scoresPlusUrl = scoresPlusPath ? `${baseUrl}/${scoresPlusPath}` : '';
  const scoresMinusUrl = scoresMinusPath ? `${baseUrl}/${scoresMinusPath}` : '';
  if (!assetLinks.write(`${accession}\t${batch}\t${baseUrl}/${referencePath}\t${baseUrl}/${promoterPath}\t${scoresPlusUrl}\t${scoresMinusUrl}\t${baseUrl}/${annotationPath}\n`)) {
    await once(assetLinks, 'drain');
  }
  count += 1;
  previousAccession = accession;
}

assetLinks.end();
await once(assetLinks, 'finish');

if (!sawHeader) throw new Error('The metadata TSV is empty.');
if (count !== expectedCount) throw new Error(`Expected ${expectedCount} genomes, found ${count}.`);
const knownBatchIds = new Set(batches.map((batch) => batch.id));
for (const batch of scoreBatches) {
  if (!knownBatchIds.has(batch)) throw new Error(`Score batch ${batch} is not present in the metadata input.`);
}

const plan = {
  schemaVersion: 1,
  layout: 'promoter-batch-v1',
  releaseId,
  repository,
  revision,
  baseUrl,
  batchSize,
  totalGenomes: count,
  status: 'staged',
  fileTemplates: {
    reference: '{batch}/genomes/{accession}_genomic.fna.gz',
    predictedPromoters: '{batch}/promoter_gff/{accession}.promoters_up80_down20_gt_0.9.gff3',
    ...(scoreBatches.size ? {
      promoterScoresPlus: '{batch}/promoter_bw/{accession}/promoter-scores.plus.bw',
      promoterScoresMinus: '{batch}/promoter_bw/{accession}/promoter-scores.minus.bw',
    } : {}),
    ncbiAnnotations: '{batch}/ncbi_gff3/{accession}.genomic.gff3.gz',
    batchManifest: '{batch}/manifest.tsv',
    inputMapping: '{batch}/input_mapping.tsv',
  },
  ...(scoreBatches.size ? { promoterScoreBatches: [...scoreBatches].sort() } : {}),
  batches,
};

const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;
const planJson = JSON.stringify(plan);
const sql = `UPDATE releases
SET hf_repository = ${sqlText(repository)},
    hf_revision = ${sqlText(revision)},
    feature_summary_json = json_set(feature_summary_json, '$.assetLayout', json(${sqlText(planJson)}))
WHERE release_id = ${sqlText(releaseId)}
  AND total_genomes = ${count};
`;

writeFileSync(resolve(output, 'asset-layout.json'), `${JSON.stringify(plan, null, 2)}\n`);
writeFileSync(resolve(output, 'update-release-asset-layout.sql'), sql);
console.log(JSON.stringify({ output, assetLinks: assetLinksPath, releaseId, totalGenomes: count, batches: batches.length, firstBatch: batches[0], lastBatch: batches.at(-1) }, null, 2));
