import { describe, expect, it } from 'vitest';

import {
  CompositeUnifiedGenomeRepository,
  parseConfiguredUnifiedGenomeAliases,
  readD1UnifiedGenomeAliases,
  UnifiedGenomeAliasError,
  UnifiedGenomeCursorError,
} from '@/features/genome-browser/unified-genome-repository';
import { ExperimentalTssReleaseNotPublishedError } from '@/features/genome-browser/experimental-tss-repository';
import type { ExperimentalTssGenome, ExperimentalTssRepository } from '@/types/experimental-tss';
import type { GenomeCatalogRepository } from '@/features/genomes/repository';
import type { GenomeCatalogRow, GenomeSearchQuery } from '@/features/genomes/types';
import type { UnifiedGenomeSearchQuery } from '@/types/unified-genome';
import { makeCatalogRow, makeGenome } from '../fixtures/release';

const publication = {
  title: 'Primary transcriptome map', authors: ['A. Author'], journal: 'RNA',
  doi: '10.1/example', status: 'resolved' as const,
};

function experimentalGenome(accession: string, observations = 5, referenceSha256: string | null = 'a'.repeat(64)): ExperimentalTssGenome {
  return {
    releaseId: 'experimental-1', accession, organismName: `Experimental ${accession}`,
    strain: null, assemblyName: null, genbankAssemblyAccession: null,
    defaultLocus: 'NC_000001.1:1-1000', primarySequence: 'NC_000001.1',
    genomeSizeBp: 5_000_000, contigCount: 1, annotationStatus: 'available',
    referenceSha256,
    assetBase: `/api/experimental-data/${accession}`,
    assets: {
      fasta: 'reference.fa.gz', fastaFai: 'reference.fa.gz.fai', fastaGzi: 'reference.fa.gz.gzi',
      ncbiAnnotations: 'ncbi-annotations.gff3.gz', ncbiAnnotationsIndex: 'ncbi-annotations.gff3.gz.tbi',
    },
    studies: [{
      studyId: `2020_12345678_${accession}`, datasetRow: 1, accession,
      organismName: `Experimental ${accession}`, pmid: '12345678', year: 2020,
      recordCount: observations, sourceFile: 'source.bed', sourceSha256: 'a'.repeat(64),
      duplicateGroupCount: 0, publication,
      assets: { rawBed: 'raw.bed', data: 'data.gz', index: 'data.gz.tbi' }, checksums: {},
    }],
  };
}

function predictionRepository(rows: GenomeCatalogRow[]): GenomeCatalogRepository {
  return {
    async getActiveRelease() {
      return {
        releaseId: 'prediction-1', sourceReleaseId: null, releaseDate: null, generatedAt: null,
        description: null, totalGenomes: rows.length,
        totalPredictedPromoters: rows.reduce((sum, row) => sum + row.predictedPromoterCount, 0),
        totalAnnotatedGenomes: 0, totalDownloadedAnnotations: 0, totalMissingAnnotations: rows.length,
        totalIncompatibleAnnotations: 0, totalUsableAnnotations: 0,
        totalCircularOriginSplitFeatures: 0, totalCircularOriginSplitGenomes: 0,
        totalExperimentalTss: 0, topPhyla: [], releaseAssetBaseUrl: null, manifestIndexPath: null,
      };
    },
    async search(query: GenomeSearchQuery) {
      const start = query.cursor ? Number(query.cursor) : 0;
      const items = rows.slice(start, start + query.limit);
      const next = start + items.length < rows.length ? String(start + items.length) : null;
      return {
        releaseId: 'prediction-1', items, total: rows.length,
        facets: { sources: [], taxonomy: { domain: [], phylum: [], class: [], order: [], family: [], genus: [] } },
        pageInfo: { nextCursor: next, hasNext: next !== null },
      };
    },
    async getByAccession(accession: string) {
      const row = rows.find((candidate) => candidate.accession === accession);
      if (!row) return null;
      return {
        releaseId: 'prediction-1', referenceSha256: 'a'.repeat(64), assetBase: '/api/remote-data', storage: null,
        genome: makeGenome({
          accession: row.accession, organismName: row.organismName,
          predictedPromoterCount: row.predictedPromoterCount,
        }),
      };
    },
  };
}

function experimentalRepository(genomes: ExperimentalTssGenome[]): ExperimentalTssRepository {
  return {
    async getActiveRelease() {
      const studies = genomes.flatMap((genome) => genome.studies);
      return {
        releaseId: 'experimental-1', generatedAt: null, description: null,
        studies: studies.length, genomes: genomes.length,
        publications: new Set(studies.map((study) => study.pmid)).size,
        observations: studies.reduce((sum, study) => sum + study.recordCount, 0), years: [2020],
      };
    },
    async search() {
      const release = await this.getActiveRelease();
      const items = genomes.flatMap((genome) => genome.studies);
      return { release, items, total: items.length };
    },
    async listGenomes() { return genomes; },
    async getGenome(accession: string) { return genomes.find((genome) => genome.accession === accession) || null; },
    async resolveAsset() { return null; },
  };
}

function query(overrides: Partial<UnifiedGenomeSearchQuery> = {}): UnifiedGenomeSearchQuery {
  return {
    q: '', taxonomy: { domain: '', phylum: '', class: '', order: '', family: '', genus: '' },
    source: '', annotation: '', evidence: 'all', sort: 'accession', direction: 'asc',
    limit: 25, cursor: null, ...overrides,
  };
}

describe('unified genome repository', () => {
  it('composes exact accessions into all three evidence states and keeps release pointers independent', async () => {
    const predictionRows = [
      makeCatalogRow(makeGenome({ accession: 'GCF_000000001.1', predictedPromoterCount: 10 })),
      makeCatalogRow(makeGenome({ accession: 'GCA_000000002.1', predictedPromoterCount: 20 })),
    ];
    const experimental = [experimentalGenome('GCF_000000001.1', 3), experimentalGenome('GCF_000000003.1', 7)];
    const repository = new CompositeUnifiedGenomeRepository(
      predictionRepository(predictionRows), experimentalRepository(experimental),
    );

    const result = await repository.search(query());
    expect(result.releases).toEqual({
      predictionReleaseId: 'prediction-1', experimentalReleaseId: 'experimental-1',
      compositeRevision: 'prediction-1:experimental-1',
    });
    expect(result.items.map((row) => [row.canonicalAccession, row.evidenceState])).toEqual([
      ['GCA_000000002.1', 'prediction_only'],
      ['GCF_000000001.1', 'both'],
      ['GCF_000000003.1', 'experimental_only'],
    ]);
    expect(result.facets.evidence).toEqual({ prediction_only: 1, experimental_only: 1, both: 1 });
    expect(result.stats).toMatchObject({
      totalGenomes: 3, predictionGenomes: 2, experimentalGenomes: 2, bothGenomes: 1,
      totalPredictedPromoters: 30, totalExperimentalObservations: 10,
      totalExperimentalStudies: 2, totalExperimentalPublications: 1,
    });
  });

  it('does not merge matching GCA/GCF stems without an explicit reciprocal alias', async () => {
    const prediction = predictionRepository([
      makeCatalogRow(makeGenome({ accession: 'GCA_000210855.2' })),
    ]);
    const experimental = experimentalRepository([experimentalGenome('GCF_000210855.2')]);
    const repository = new CompositeUnifiedGenomeRepository(prediction, experimental);
    const result = await repository.search(query());
    expect(result.items).toHaveLength(2);
    expect(result.items.every((row) => row.evidenceState !== 'both')).toBe(true);
  });

  it('merges only an explicit reciprocal alias and resolves either accession to the stable canonical detail', async () => {
    const prediction = predictionRepository([
      makeCatalogRow(makeGenome({ accession: 'GCA_000210855.2', predictedPromoterCount: 50 })),
    ]);
    const experimental = experimentalRepository([experimentalGenome('GCF_000210855.2')]);
    const repository = new CompositeUnifiedGenomeRepository(prediction, experimental, [{
      canonicalAccession: 'GCA_000210855.2', predictionAccession: 'GCA_000210855.2',
      experimentalAccession: 'GCF_000210855.2', relation: 'ncbi_reciprocal',
    }]);

    const result = await repository.search(query());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      canonicalAccession: 'GCA_000210855.2', aliases: ['GCA_000210855.2', 'GCF_000210855.2'],
      evidenceState: 'both', predictionAccession: 'GCA_000210855.2', experimentalAccession: 'GCF_000210855.2',
    });
    const fromGcf = await repository.getByAccession('GCF_000210855.2');
    expect(fromGcf).toMatchObject({
      canonicalAccession: 'GCA_000210855.2', evidenceState: 'both', assemblyCompatibility: 'reciprocal_alias',
    });
    expect(await repository.getByAccession('GCA_000210855.2')).toEqual(fromGcf);
  });

  it('loads reciprocal aliases from the active D1 release registry once', async () => {
    let queries = 0;
    const database = {
      prepare(sql: string) {
        queries += 1;
        expect(sql).toContain('JOIN release_genomes experimental');
        return {
          async all() {
            return { success: true, meta: {}, results: [{
              canonical_accession: 'GCA_000210855.2',
              prediction_accession: 'GCA_000210855.2',
              experimental_accession: 'GCF_000210855.2',
            }, {
              canonical_accession: 'GCF_000006985.1',
              prediction_accession: 'GCF_000006985.1',
              experimental_accession: 'GCF_000006985.1',
            }] };
          },
        };
      },
    } as unknown as D1Database;
    const exactMetadataOnly = experimentalGenome('GCF_000006985.1');
    exactMetadataOnly.primarySequence = null;
    const repository = new CompositeUnifiedGenomeRepository(
      predictionRepository([
        makeCatalogRow(makeGenome({ accession: 'GCA_000210855.2' })),
        makeCatalogRow(makeGenome({ accession: 'GCF_000006985.1', predictedPromoterCount: 4335 })),
      ]),
      experimentalRepository([experimentalGenome('GCF_000210855.2'), exactMetadataOnly]),
      [],
      () => readD1UnifiedGenomeAliases(database),
    );

    const items = (await repository.search(query())).items;
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.canonicalAccession === 'GCF_000006985.1')).toMatchObject({
      evidenceState: 'both', predictedPromoterCount: 4335, assemblyCompatibility: 'exact',
    });
    await repository.getByAccession('GCF_000210855.2');
    expect(queries).toBe(1);
  });

  it('accepts a trusted reciprocal alias when checksums are unavailable and GCA/GCF reference names differ', async () => {
    const prediction = predictionRepository([
      makeCatalogRow(makeGenome({ accession: 'GCA_000007325.1', predictedPromoterCount: 748 })),
    ]);
    const getPrediction = prediction.getByAccession.bind(prediction);
    prediction.getByAccession = async (accession) => {
      const match = await getPrediction(accession);
      if (match) match.referenceSha256 = null;
      return match;
    };
    const experimental = experimentalGenome('GCF_000007325.1', 930, null);
    experimental.referenceAccession = 'GCF_000007325.1';
    const repository = new CompositeUnifiedGenomeRepository(
      prediction,
      experimentalRepository([experimental]),
      [{
        canonicalAccession: 'GCA_000007325.1', predictionAccession: 'GCA_000007325.1',
        experimentalAccession: 'GCF_000007325.1', relation: 'ncbi_reciprocal',
      }],
    );

    await expect(repository.getByAccession('GCF_000007325.1')).resolves.toMatchObject({
      canonicalAccession: 'GCA_000007325.1', evidenceState: 'both',
      assemblyCompatibility: 'reciprocal_alias', overlayAllowed: true,
    });
  });

  it('keeps checksum-mismatched exact accessions as separate assembly rows and gates detail overlays', async () => {
    const repository = new CompositeUnifiedGenomeRepository(
      predictionRepository([makeCatalogRow(makeGenome({ accession: 'GCF_000210855.2' }))]),
      experimentalRepository([experimentalGenome('GCF_000210855.2', 5, 'b'.repeat(64))]),
    );
    const result = await repository.search(query());
    expect(result.items.map((row) => [row.assemblyKey, row.evidenceState, row.overlayAllowed])).toEqual([
      ['GCF_000210855.2::prediction', 'prediction_only', false],
      ['GCF_000210855.2::experimental', 'experimental_only', false],
    ]);
    expect(result.stats).toMatchObject({ totalGenomes: 2, bothGenomes: 0 });
    expect(result.facets.evidence).toEqual({ prediction_only: 1, experimental_only: 1, both: 0 });

    const predictionDetail = await repository.getByAccession('GCF_000210855.2');
    expect(predictionDetail).toMatchObject({
      evidenceState: 'prediction_only', assemblyCompatibility: 'mismatch', overlayAllowed: false,
      availableAssemblySources: ['prediction', 'experimental'], experimental: null,
    });
    const experimentalDetail = await repository.getByAccession('GCF_000210855.2', 'experimental');
    expect(experimentalDetail).toMatchObject({
      evidenceState: 'experimental_only', assemblyCompatibility: 'mismatch', overlayAllowed: false,
      availableAssemblySources: ['prediction', 'experimental'], prediction: null,
    });
  });

  it('also rejects an explicit reciprocal alias when its reference checksums disagree', async () => {
    const repository = new CompositeUnifiedGenomeRepository(
      predictionRepository([makeCatalogRow(makeGenome({ accession: 'GCA_000210855.2' }))]),
      experimentalRepository([experimentalGenome('GCF_000210855.2', 5, 'b'.repeat(64))]),
      [{
        canonicalAccession: 'GCA_000210855.2', predictionAccession: 'GCA_000210855.2',
        experimentalAccession: 'GCF_000210855.2', relation: 'ncbi_reciprocal',
      }],
    );
    const result = await repository.search(query());
    expect(result.items.map((row) => row.evidenceState).sort()).toEqual(['experimental_only', 'prediction_only']);
    expect(result.stats.bothGenomes).toBe(0);
    expect((await repository.getByAccession('GCF_000210855.2'))?.evidenceState).toBe('experimental_only');
    expect((await repository.getByAccession('GCA_000210855.2'))?.evidenceState).toBe('prediction_only');
  });

  it('filters evidence, searches study provenance, and returns stable cursor pages', async () => {
    const repository = new CompositeUnifiedGenomeRepository(
      predictionRepository([
        makeCatalogRow(makeGenome({ accession: 'GCA_000000001.1', organismName: 'Alpha', predictedPromoterCount: 30 })),
        makeCatalogRow(makeGenome({ accession: 'GCA_000000002.1', organismName: 'Beta', predictedPromoterCount: 20 })),
      ]),
      experimentalRepository([experimentalGenome('GCF_000000003.1')]),
    );
    const experimentalResult = await repository.search(query({ q: '12345678', evidence: 'experimental' }));
    expect(experimentalResult.items.map((row) => row.experimentalAccession)).toEqual(['GCF_000000003.1']);

    const first = await repository.search(query({ limit: 25 }));
    expect(first.pageInfo.hasNext).toBe(false);
    const predictionOnly = await repository.search(query({ evidence: 'predictions', sort: 'promoters', direction: 'desc' }));
    expect(predictionOnly.items.map((row) => row.predictedPromoterCount)).toEqual([30, 20]);

    const malformed = Buffer.from(JSON.stringify({ v: 1, revision: 'other', query: 'x', accession: 'GCA_000000001.1' })).toString('base64url');
    await expect(repository.search(query({ cursor: malformed }))).rejects.toBeInstanceOf(UnifiedGenomeCursorError);
  });

  it('rejects ambiguous or malformed explicit alias registries', () => {
    const prediction = predictionRepository([]);
    const experimental = experimentalRepository([]);
    expect(() => new CompositeUnifiedGenomeRepository(prediction, experimental, [{
      canonicalAccession: 'GCA_000000001.1', predictionAccession: 'GCA_000000001.1',
      experimentalAccession: 'GCF_000000001.1', relation: 'ncbi_reciprocal',
    }, {
      canonicalAccession: 'GCF_000000001.1', predictionAccession: 'GCA_000000001.1',
      experimentalAccession: 'GCF_000000001.1', relation: 'ncbi_reciprocal',
    }])).toThrow(UnifiedGenomeAliasError);
  });

  it('paginates a large prediction catalog without scanning every prediction page', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => makeCatalogRow(makeGenome({
      accession: `GCA_${String(index + 1).padStart(9, '0')}.1`,
    })));
    const prediction = predictionRepository(rows);
    const originalSearch = prediction.search.bind(prediction);
    let searchCalls = 0;
    prediction.search = async (value) => { searchCalls += 1; return originalSearch(value); };
    const repository = new CompositeUnifiedGenomeRepository(prediction, experimentalRepository([]));

    const first = await repository.search(query());
    expect(first.items).toHaveLength(25);
    expect(first.total).toBe(500);
    expect(first.pageInfo.hasNext).toBe(true);
    expect(searchCalls).toBeLessThanOrEqual(2);
  });

  it('links metadata-only experimental assemblies to an exact prediction accession', async () => {
    const prediction = predictionRepository([makeCatalogRow(makeGenome({
      accession: 'GCF_000000002.1', predictedPromoterCount: 42,
    }))]);
    const metadataOnly = experimentalGenome('GCF_000000002.1');
    metadataOnly.primarySequence = null;
    const repository = new CompositeUnifiedGenomeRepository(prediction, experimentalRepository([metadataOnly]), [{
      canonicalAccession: 'GCF_000000002.1', predictionAccession: 'GCF_000000002.1',
      experimentalAccession: 'GCF_000000002.1', relation: 'exact',
    }]);

    const result = await repository.search(query({ evidence: 'experimental' }));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      predictionAccession: 'GCF_000000002.1', experimentalAccession: 'GCF_000000002.1',
      evidenceState: 'both', predictedPromoterCount: 42,
    });
  });

  it('keeps prediction search and detail available before an experimental release is published', async () => {
    const prediction = predictionRepository([
      makeCatalogRow(makeGenome({ accession: 'GCA_000000001.1', predictedPromoterCount: 10 })),
    ]);
    const experimental = experimentalRepository([]);
    let listCalls = 0;
    let getCalls = 0;
    experimental.getActiveRelease = async () => { throw new ExperimentalTssReleaseNotPublishedError(); };
    experimental.listGenomes = async () => { listCalls += 1; return []; };
    experimental.getGenome = async () => { getCalls += 1; return null; };
    const repository = new CompositeUnifiedGenomeRepository(prediction, experimental);

    const result = await repository.search(query());
    expect(result.releases).toEqual({
      predictionReleaseId: 'prediction-1', experimentalReleaseId: null,
      compositeRevision: 'prediction-1:none',
    });
    expect(result.items).toHaveLength(1);
    expect(result.stats).toMatchObject({ predictionGenomes: 1, experimentalGenomes: 0, totalGenomes: 1 });
    expect(await repository.getByAccession('GCA_000000001.1')).toMatchObject({
      evidenceState: 'prediction_only', experimental: null,
    });
    expect(listCalls).toBe(0);
    expect(getCalls).toBe(0);
  });

  it('does not read or expose an active experimental release when public access is disabled', async () => {
    const experimental = experimentalRepository([experimentalGenome('GCF_000000001.1')]);
    let activeCalls = 0;
    const getActiveRelease = experimental.getActiveRelease.bind(experimental);
    experimental.getActiveRelease = async () => { activeCalls += 1; return getActiveRelease(); };
    const repository = new CompositeUnifiedGenomeRepository(
      predictionRepository([makeCatalogRow(makeGenome({ accession: 'GCF_000000001.1' }))]),
      experimental,
      [],
      undefined,
      false,
    );

    const result = await repository.search(query());
    expect(result.items[0]).toMatchObject({ evidenceState: 'prediction_only', experimentalAccession: null });
    expect(result.stats).toMatchObject({ experimentalGenomes: 0, totalExperimentalObservations: 0 });
    expect(activeCalls).toBe(0);
  });

  it('keeps unconsumed prediction rows across a merged experimental cursor page', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => index + 1)
      .filter((value) => value !== 15)
      .map((value) => makeCatalogRow(makeGenome({ accession: `GCF_${String(value).padStart(9, '0')}.1` })));
    const repository = new CompositeUnifiedGenomeRepository(
      predictionRepository(rows),
      experimentalRepository([experimentalGenome('GCF_000000015.1')]),
    );
    const first = await repository.search(query());
    const second = await repository.search(query({ cursor: first.pageInfo.nextCursor }));
    const all = [...first.items, ...second.items];
    expect(all).toHaveLength(30);
    expect(new Set(all.map((row) => row.assemblyKey)).size).toBe(30);
    expect(all.map((row) => row.canonicalAccession)).toEqual([...all.map((row) => row.canonicalAccession)].sort());
    expect(second.pageInfo.hasNext).toBe(false);
  });

  it('parses only explicit server-side reciprocal alias configuration', () => {
    expect(parseConfiguredUnifiedGenomeAliases(JSON.stringify([{
      canonicalAccession: 'GCA_000000001.1',
      predictionAccession: 'GCA_000000001.1',
      experimentalAccession: 'GCF_000000001.1',
      relation: 'ncbi_reciprocal',
    }]))).toEqual([{
      canonicalAccession: 'GCA_000000001.1',
      predictionAccession: 'GCA_000000001.1',
      experimentalAccession: 'GCF_000000001.1',
      relation: 'ncbi_reciprocal',
    }]);
    expect(() => parseConfiguredUnifiedGenomeAliases('{')).toThrow(UnifiedGenomeAliasError);
    expect(() => parseConfiguredUnifiedGenomeAliases(JSON.stringify([{
      canonicalAccession: 'GCA_000000001.1', predictionAccession: 'GCA_000000001.1',
      experimentalAccession: 'GCF_000000001.1', relation: 'organism_name',
    }]))).toThrow(UnifiedGenomeAliasError);
  });
});
