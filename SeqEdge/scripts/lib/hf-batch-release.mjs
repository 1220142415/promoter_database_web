import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const ACCESSION = /GC[AF]_\d{9}\.\d+/g;
const BATCH = /^\d{3}$/;

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return false;
    throw error;
  }
}

export function parseHfInputMapping(text, batch) {
  const accessions = new Set();
  for (const line of text.split(/\r?\n/)) {
    const matches = line.match(ACCESSION) || [];
    for (const accession of matches) accessions.add(accession);
  }
  if (!accessions.size) throw new Error(`HF batch ${batch} input_mapping.tsv contains no accessions`);
  return [...accessions].sort();
}

export async function discoverHfBatchInputs(inputRoot) {
  const root = resolve(inputRoot);
  const rootName = root.split(/[\\/]/).at(-1) || '';
  const candidates = BATCH.test(rootName) && await exists(join(root, 'input_mapping.tsv'))
    ? [{ batch: rootName, path: root }]
    : (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && BATCH.test(entry.name))
      .map((entry) => ({ batch: entry.name, path: join(root, entry.name) }))
      .sort((left, right) => left.batch.localeCompare(right.batch));
  if (!candidates.length) throw new Error(`no three-digit HF batch directories found under ${root}`);

  const discovered = new Map();
  for (const candidate of candidates) {
    const mappingPath = join(candidate.path, 'input_mapping.tsv');
    if (!(await exists(mappingPath))) throw new Error(`HF batch ${candidate.batch} is missing input_mapping.tsv`);
    const accessions = parseHfInputMapping(await readFile(mappingPath, 'utf8'), candidate.batch);
    for (const accession of accessions) {
      if (discovered.has(accession)) throw new Error(`${accession} occurs in more than one HF batch`);
      discovered.set(accession, { batch: candidate.batch, batchRoot: candidate.path });
    }
  }
  return discovered;
}

export function hfBatchAssetPaths(batchRoot, accession) {
  return {
    fasta: join(batchRoot, 'genomes', `${accession}_genomic.fna.gz`),
    promoters: join(batchRoot, 'promoter_gff', `${accession}.promoters_up80_down20_gt_0.9.gff3`),
    annotations: join(batchRoot, 'ncbi_gff3', `${accession}.genomic.gff3.gz`),
  };
}

function templateTaxonomy(genome) {
  return {
    organismName: genome.organismName,
    species: genome.species,
    strain: genome.strain,
    taxonomy: genome.taxonomy,
    domain: genome.domain,
    phylum: genome.phylum,
    className: genome.className,
    order: genome.order || genome.orderName,
    orderName: genome.orderName || genome.order,
    family: genome.family,
    genus: genome.genus,
    genomeSource: genome.genomeSource,
    assemblyLevel: genome.assemblyLevel,
    completeness: genome.completeness,
    contamination: genome.contamination,
  };
}

export async function inspectHfBatchSample({ inputRoot, accessions, metadataCatalog }) {
  const discovered = await discoverHfBatchInputs(inputRoot);
  const catalog = JSON.parse(await readFile(metadataCatalog, 'utf8'));
  const templates = new Map((catalog.genomes || []).map((genome) => [genome.accession, genome]));
  const selected = [];
  for (const accession of accessions) {
    const entry = discovered.get(accession);
    if (!entry) throw new Error(`${accession} is absent from HF input mappings`);
    const template = templates.get(accession);
    if (!template) throw new Error(`${accession} is absent from metadata catalog ${metadataCatalog}`);
    const paths = hfBatchAssetPaths(entry.batchRoot, accession);
    if (!(await exists(paths.fasta))) throw new Error(`${accession}: missing HF FASTA ${paths.fasta}`);
    if (!(await exists(paths.promoters))) throw new Error(`${accession}: missing HF promoter GFF3 ${paths.promoters}`);
    selected.push({ accession, ...entry, paths, template, hasAnnotation: await exists(paths.annotations) });
  }
  return selected;
}

export async function buildHfBatchSample(options, helpers) {
  const selected = await inspectHfBatchSample(options);
  if (options.preflightOnly) {
    return selected.map(({ accession, batch, paths, hasAnnotation }) => ({ accession, batch, paths, hasAnnotation }));
  }
  if (!helpers.toolchain.selected && !options.allowUnindexed) {
    throw new Error('bgzip, tabix, samtools, and gzip are required for an indexed HF sample release');
  }

  const workRoot = resolve(options.projectRoot, '.data', 'work');
  await mkdir(workRoot, { recursive: true });
  const temporary = await mkdtemp(join(workRoot, 'hf-batch-release-'));
  const stage = join(temporary, 'release');
  const objectsRoot = join(stage, 'objects');
  await mkdir(objectsRoot, { recursive: true });
  let published = false;

  try {
    const indexed = Boolean(helpers.toolchain.selected);
    const records = [];
    for (const item of selected) {
      const objectRoot = join(objectsRoot, item.accession);
      await mkdir(objectRoot);
      const fasta = await helpers.parseFasta(item.paths.fasta);
      await copyFile(item.paths.fasta, join(objectRoot, 'reference.fa.gz'));
      if (!indexed) {
        const expandGzip = helpers.expandGzip || (async (source, destination) => {
          await pipeline(createReadStream(source).pipe(createGunzip()), createWriteStream(destination));
        });
        await expandGzip(item.paths.fasta, join(objectRoot, 'reference.fa'));
      }
      const promoters = await helpers.normalizeGff(item.paths.promoters, join(objectRoot, 'predicted-promoters.gff3.gz'), {
        expectedType: 'promoter',
        sequences: fasta.sequenceLengths,
      });
      let annotationFeatureCount = 0;
      let annotationStatus = item.hasAnnotation ? 'available' : 'missing';
      let annotationIssue = null;
      if (item.hasAnnotation) {
        try {
          const annotations = await helpers.normalizeGff(item.paths.annotations, join(objectRoot, 'ncbi-annotations.gff3.gz'), {
            sequences: fasta.sequenceLengths,
          });
          annotationFeatureCount = annotations.featureCount;
        } catch (error) {
          if (!(error instanceof helpers.NcbiAnnotationCompatibilityError)) throw error;
          annotationStatus = 'incompatible';
          annotationIssue = error.issue;
          await rm(join(objectRoot, 'ncbi-annotations.gff3.gz'), { force: true });
        }
      }
      records.push({ ...item, ...fasta, sequenceLengths: undefined, promoterCount: promoters.featureCount, annotationFeatureCount, annotationStatus, annotationIssue });
    }

    if (indexed) await helpers.preprocessRelease(stage, helpers.toolchain, options);
    const genomes = [];
    const knownHashes = new Map();
    let totalPromoters = 0;
    let annotatedGenomes = 0;
    for (const record of records) {
      const hasAnnotation = record.annotationStatus === 'available';
      const assets = helpers.assetPaths(record.accession, hasAnnotation, indexed, false);
      const checksums = {};
      for (const [key, asset] of Object.entries(assets)) {
        if (!asset || key === 'metadata') continue;
        const releasePath = `objects/${asset}`;
        const digest = await helpers.hashFile(join(stage, releasePath));
        checksums[key] = digest;
        knownHashes.set(releasePath, digest);
      }
      const defaultLocus = `${record.primarySequence}:1-${Math.min(10000, record.primarySequenceLength)}`;
      const genome = {
        accession: record.accession,
        ...templateTaxonomy(record.template),
        genomeSizeBp: record.genomeSizeBp,
        gcContent: record.gcContent,
        contigCount: record.contigCount,
        promoterCount: record.promoterCount,
        predictedPromoterCount: record.promoterCount,
        experimentalTssCount: 0,
        hasExperimentalTss: false,
        annotationStatus: record.annotationStatus,
        annotationFeatureCount: record.annotationFeatureCount,
        annotationCircularOriginSplitCount: 0,
        annotationIssue: record.annotationIssue,
        primarySequence: record.primarySequence,
        defaultLocus,
        assets,
        checksums,
      };
      const metadataPath = join(stage, 'objects', assets.metadata);
      await helpers.writeJson(metadataPath, {
        schemaVersion: 1,
        datasetVersion: options.releaseDate,
        coordinateSystems: { fasta: '1-based sequence', gff3: '1-based closed', browser: '1-based display' },
        promoterDefinition: { lengthBp: 100, anchorBase: 80, orientation: 'transcription' },
        ...genome,
      });
      const metadataHash = await helpers.hashFile(metadataPath);
      genome.checksums.metadata = metadataHash;
      knownHashes.set(`objects/${assets.metadata}`, metadataHash);
      genomes.push(genome);
      totalPromoters += record.promoterCount;
      if (hasAnnotation) annotatedGenomes += 1;
    }

    const generatedAt = `${options.releaseDate}T00:00:00.000Z`;
    const releaseSummary = {
      id: options.releaseDate,
      version: options.releaseDate,
      datasetVersion: options.releaseDate,
      date: options.releaseDate,
      generatedAt,
      genomeCount: genomes.length,
      promoterCount: totalPromoters,
      annotatedGenomeCount: annotatedGenomes,
      usableAnnotationGenomeCount: annotatedGenomes,
      downloadedAnnotationGenomeCount: annotatedGenomes,
      incompatibleAnnotationGenomeCount: genomes.filter((genome) => genome.annotationStatus === 'incompatible').length,
      missingAnnotationGenomeCount: genomes.filter((genome) => genome.annotationStatus === 'missing').length,
      circularOriginSplitFeatureCount: 0,
      circularOriginSplitGenomeCount: 0,
      experimentalTssCount: 0,
      taxonomySource: `metadata template ${options.metadataCatalog}`,
      indexed,
      publishable: indexed,
      preprocessing: indexed ? 'bgzip-tabix-samtools' : 'gzip-only-fallback',
      rawScoreTracks: null,
    };
    const catalog = {
      schemaVersion: 1,
      generatedAt,
      assetBase: '/api/local-data',
      release: releaseSummary,
      summary: {
        totalGenomes: genomes.length,
        totalPredictedPromoters: totalPromoters,
        totalExperimentalTss: 0,
        annotatedGenomes,
        usableAnnotationGenomes: annotatedGenomes,
        downloadedAnnotationGenomes: annotatedGenomes,
        incompatibleAnnotationGenomes: releaseSummary.incompatibleAnnotationGenomeCount,
        missingAnnotationGenomes: releaseSummary.missingAnnotationGenomeCount,
        circularOriginSplitFeatures: 0,
        circularOriginSplitGenomes: 0,
      },
      genomes,
    };
    await helpers.writeJson(join(stage, 'catalog.json'), catalog);
    await helpers.writeJson(join(stage, 'release.json'), {
      schemaVersion: 1,
      source: {
        repository: 'liurulong/bacterial-promoter-genomes',
        revision: 'main',
        layout: 'promoter-batch-v1',
        inputRoot: resolve(options.inputRoot),
        batches: [...new Set(selected.map((item) => item.batch))],
      },
      ...releaseSummary,
    });
    for (const path of ['catalog.json', 'release.json']) knownHashes.set(path, await helpers.hashFile(join(stage, path)));
    const manifestRows = ['path\tbytes\tsha256'];
    for (const path of [...knownHashes.keys()].sort()) {
      manifestRows.push(`${path}\t${(await stat(join(stage, path))).size}\t${knownHashes.get(path)}`);
    }
    await writeFile(join(stage, 'manifest.tsv'), `${manifestRows.join('\n')}\n`, 'utf8');
    knownHashes.set('manifest.tsv', await helpers.hashFile(join(stage, 'manifest.tsv')));
    const checksumText = [...knownHashes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, digest]) => `${digest}  ${path}`)
      .join('\n');
    await writeFile(join(stage, 'checksums.sha256'), `${checksumText}\n`, 'utf8');
    await helpers.replaceRelease(stage, options.output, options.force);
    if (options.appCatalog && releaseSummary.publishable) {
      await mkdir(dirname(options.appCatalog), { recursive: true });
      await copyFile(join(options.output, 'catalog.json'), options.appCatalog);
    }
    published = true;
    return { output: options.output, catalog, release: releaseSummary };
  } finally {
    if (published) await rm(temporary, { recursive: true, force: true });
    else console.error(`Preserved incomplete HF sample work directory: ${temporary}`);
  }
}
