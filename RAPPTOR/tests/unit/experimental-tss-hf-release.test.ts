import { describe, expect, it } from 'vitest';
import {
  buildExperimentalTssHfActivationSql,
  buildExperimentalTssHfReleaseSql,
  buildExperimentalTssHfValidationSql,
} from '../../scripts/database/build-experimental-tss-hf-release.mjs';

describe('experimental TSS Hugging Face release SQL', () => {
  it('matches studies through stable genome identities and preserves every article track', () => {
    const sql = buildExperimentalTssHfReleaseSql({ generatedAt: '2026-08-28T00:00:00Z' });
    expect(sql).toContain('JOIN genome_registry registry ON registry.genome_id = source.genome_id');
    expect(sql).toContain('JOIN experimental_study_genomes link ON link.study_id = study.study_id');
    expect(sql).toContain("'experimentally_supported_tss_by_study/' || output_file");
    expect(sql).toContain("ROW_NUMBER() OVER (PARTITION BY link.source_accession");
    expect(sql).toContain("'stable_genome_id_only'");
    expect(sql).toContain('predicted_promoter_count');
    expect(sql).toContain("'promoter:rapptor:experimental-hf'");
    expect(sql).toContain("'prediction_not_in_active_release'");
    expect(sql).toContain("NULL, 'missing', 1, 'rapptor'");
    expect(sql).not.toContain('organism_name =');
  });

  it('keeps staging, validation, and activation separate', () => {
    expect(buildExperimentalTssHfReleaseSql()).toContain("'staged', 'experimental_tss'");
    expect(buildExperimentalTssHfValidationSql()).toContain('matched_prediction_genomes');
    expect(buildExperimentalTssHfValidationSql()).toContain('missing_prediction_features');
    expect(buildExperimentalTssHfActivationSql()).toContain("publication_status = 'ready'");
  });
});
