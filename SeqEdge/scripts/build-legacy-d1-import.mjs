#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const options = { release: '2026-08-07', repo: 'liurulong/bacterial-promoter-genomes-pilot', revision: 'main' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--release') options.release = argv[++index];
    else if (argv[index] === '--repo') options.repo = argv[++index];
    else if (argv[index] === '--revision') options.revision = argv[++index];
    else throw new Error('Unknown argument: ' + argv[index]);
  }
  return options;
}

function sqlString(value) {
  return value === null || value === undefined ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
}

function sqlNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'NULL';
}

function normalizedSearchTokens(genome) {
  const values = [genome.accession, genome.organismName, genome.strain, genome.domain, genome.phylum, genome.className, genome.orderName || genome.order, genome.family, genome.genus];
  const tokens = new Set();
  for (const value of values) {
    for (const token of String(value || '').toLocaleLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}_.-]+/u)) if (token) tokens.add(token.slice(0, 200));
  }
  return [...tokens].sort();
}

function storageForGenome(genome, objectBase) {
  return { layout: 'individual-v1', logicalObjectPrefix: genome.accession, baseUrl: objectBase };
}

function genomeInsert(releaseId, genome, storage) {
  const values = [
    sqlString(releaseId), sqlString(genome.accession), sqlString(genome.organismName), sqlString(genome.strain),
    sqlString(genome.domain), sqlString(genome.phylum), sqlString(genome.className), sqlString(genome.orderName || genome.order),
    sqlString(genome.family), sqlString(genome.genus), sqlString(genome.genomeSource), sqlString(genome.assemblyLevel),
    sqlNumber(genome.genomeSizeBp), sqlNumber(genome.gcContent), sqlNumber(genome.contigCount), sqlNumber(genome.completeness),
    sqlNumber(genome.contamination), sqlNumber(genome.predictedPromoterCount), sqlString(genome.annotationStatus),
    sqlNumber(genome.annotationFeatureCount), sqlNumber(genome.annotationCircularOriginSplitCount || 0),
    sqlNumber(genome.experimentalTssCount || 0), genome.hasExperimentalTss ? '1' : '0', sqlString(genome.defaultLocus),
    sqlString(genome.primarySequence), sqlString(storage.logicalObjectPrefix), sqlString(JSON.stringify(genome.assets)), sqlString(JSON.stringify(storage)),
  ];
  return 'INSERT INTO genomes (release_id, accession, organism_name, strain, domain, phylum, class_name, order_name, family, genus, genome_source, assembly_level, genome_size_bp, gc_content, contig_count, completeness, contamination, predicted_promoter_count, annotation_status, annotation_feature_count, annotation_circular_origin_split_count, experimental_tss_count, has_experimental_tss, default_locus, primary_sequence, logical_object_prefix, assets_json, storage_json) VALUES (' + values.join(', ') + ');';
}

function summaryValue(summary, keys, fallback = 0) {
  for (const key of keys) if (Number.isFinite(summary[key])) return summary[key];
  return fallback;
}

export async function buildLegacyD1Import({ projectRoot, release, repo, revision = 'main' }) {
  const sourceRoot = path.join(projectRoot, '.data', 'releases', release);
  const outputRoot = path.join(projectRoot, '.data', 'd1-imports', release);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const [catalog, releaseJson] = await Promise.all([
    readFile(path.join(sourceRoot, 'catalog.json'), 'utf8').then(JSON.parse),
    readFile(path.join(sourceRoot, 'release.json'), 'utf8').then(JSON.parse),
  ]);
  const releaseBase = 'https://huggingface.co/datasets/' + repo + '/resolve/' + revision + '/releases/' + release;
  const objectBase = releaseBase + '/objects';
  const summary = catalog.summary || {};
  const phylumCounts = new Map();
  for (const genome of catalog.genomes) if (genome.phylum) phylumCounts.set(genome.phylum, (phylumCounts.get(genome.phylum) || 0) + 1);
  const topPhyla = [...phylumCounts.entries()].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)).slice(0, 8);
  const releaseValues = [
    sqlString(release), 'NULL', sqlString(releaseJson.date || release), sqlString(releaseJson.generatedAt || null), sqlString(releaseJson.description || null),
    "'individual-v1'", sqlString(repo), sqlString(revision), sqlString(releaseBase), 'NULL', String(catalog.genomes.length),
    String(summaryValue(summary, ['totalPredictedPromoters'])), String(summaryValue(summary, ['usableAnnotationGenomes', 'annotatedGenomes'])),
    String(summaryValue(summary, ['downloadedAnnotationGenomes', 'annotatedGenomes'])), String(summaryValue(summary, ['missingAnnotationGenomes'])),
    String(summaryValue(summary, ['incompatibleAnnotationGenomes'])), String(summaryValue(summary, ['usableAnnotationGenomes', 'annotatedGenomes'])),
    String(summaryValue(summary, ['circularOriginSplitFeatures'])), String(summaryValue(summary, ['circularOriginSplitGenomes'])),
    String(summaryValue(summary, ['totalExperimentalTss'])), sqlString(JSON.stringify(topPhyla)), "'inactive'",
  ];
  await writeFile(path.join(outputRoot, '000-release.sql'), 'BEGIN TRANSACTION;\nINSERT INTO releases (release_id, source_release_id, release_date, generated_at, description, layout, hf_repository, hf_revision, release_asset_base_url, manifest_index_path, total_genomes, total_predicted_promoters, total_annotated_genomes, total_downloaded_annotations, total_missing_annotations, total_incompatible_annotations, total_usable_annotations, total_circular_origin_split_features, total_circular_origin_split_genomes, total_experimental_tss, top_phyla_json, state) VALUES (' + releaseValues.join(', ') + ');\nCOMMIT;\n');
  for (let start = 0, part = 1; start < catalog.genomes.length; start += 500, part += 1) {
    const lines = ['BEGIN TRANSACTION;'];
    for (const genome of catalog.genomes.slice(start, start + 500)) {
      const storage = storageForGenome(genome, objectBase);
      lines.push(genomeInsert(release, genome, storage));
      for (const token of normalizedSearchTokens(genome)) lines.push('INSERT OR IGNORE INTO genome_search_terms (release_id, accession, token) VALUES (' + sqlString(release) + ', ' + sqlString(genome.accession) + ', ' + sqlString(token) + ');');
    }
    lines.push('COMMIT;', '');
    await writeFile(path.join(outputRoot, String(part).padStart(3, '0') + '-genomes.sql'), lines.join('\n'));
  }
  const ranks = [['source', 'genomeSource'], ['domain', 'domain'], ['phylum', 'phylum'], ['class', 'className'], ['order', 'orderName'], ['family', 'family'], ['genus', 'genus']];
  const facets = new Set();
  for (const genome of catalog.genomes) {
    for (const [kind, field] of ranks) {
      const value = genome[field] || (field === 'orderName' ? genome.order : null);
      if (!value) continue;
      const hierarchyValues = [genome.domain, genome.phylum, genome.className, genome.orderName || genome.order, genome.family];
      const parentCount = kind === 'source' ? 0 : ranks.findIndex(([rankKind]) => rankKind === kind) - 1;
      const hierarchy = hierarchyValues.map((item, index) => sqlString(index < parentCount ? item || '' : ''));
      facets.add('INSERT OR IGNORE INTO facet_options (release_id, kind, value, domain, phylum, class_name, order_name, family) VALUES (' + [sqlString(release), sqlString(kind), sqlString(value), ...hierarchy].join(', ') + ');');
    }
  }
  await writeFile(path.join(outputRoot, '999-facets.sql'), ['BEGIN TRANSACTION;', ...[...facets].sort(), 'COMMIT;', ''].join('\n'));
  await writeFile(path.join(outputRoot, 'activate-rollback.sql'), [
    'BEGIN TRANSACTION;', "UPDATE releases SET state = 'inactive' WHERE state = 'active';",
    "UPDATE releases SET state = 'active' WHERE release_id = " + sqlString(release) + ';',
    'INSERT INTO portal_state (singleton, active_release_id) VALUES (1, ' + sqlString(release) + ') ON CONFLICT(singleton) DO UPDATE SET active_release_id = excluded.active_release_id;',
    'COMMIT;', '',
  ].join('\n'));
  return { outputRoot, genomes: catalog.genomes.length, release, repo };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(await buildLegacyD1Import({ projectRoot, ...options }), null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
