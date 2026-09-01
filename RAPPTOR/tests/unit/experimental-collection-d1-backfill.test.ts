import { describe, expect, it } from 'vitest';
import { buildExperimentalCollectionD1BackfillSql } from '../../scripts/database/build-experimental-collection-d1-backfill.mjs';

function fixtures() {
  const header = 'gcf\tpredicted_promoter_count\tcds_count\tgenome_path\tpromoter_path\tannotation_path';
  const rows: string[] = [];
  const checksums: string[] = [];
  for (let index = 1; index <= 90; index += 1) {
    const accession = `GCF_${String(index).padStart(9, '0')}.1`;
    const paths = [
      `genome_sequences/${accession}.fna`,
      `promoter_predictions/${accession}.promoter.gff3`,
      `cds_function_annotations/${accession}.eggnog.gff3`,
    ];
    rows.push([accession, index, index + 10, ...paths].join('\t'));
    paths.forEach((path, pathIndex) => checksums.push(`${String(pathIndex + 1).repeat(64)}  ${path}`));
  }
  for (let index = 1; index <= 98; index += 1) {
    const accession = `GCF_${String((index - 1) % 90 + 1).padStart(9, '0')}.1`;
    checksums.push(`${'a'.repeat(64)}  experimental_tss_by_study/2020_${String(index).padStart(8, '0')}_${accession}.bed`);
  }
  return { metadata: [header, ...rows].join('\n'), checksums: checksums.join('\n') };
}

describe('experimental collection D1 backfill', () => {
  it('stores all collection paths while keeping them relative to the pinned release base', () => {
    const fixture = fixtures();
    const sql = buildExperimentalCollectionD1BackfillSql(fixture.metadata, fixture.checksums);
    expect(sql).toContain("'$.files.fasta'");
    expect(sql).toContain("'promoter:rapptor:experimental-hf'");
    expect(sql).toContain("'gene-annotation:eggnog:experimental-hf'");
    expect(sql).toContain("'experimental_tss_by_study/' || definition_id || '.bed'");
    expect(sql).toContain('dde8d06cd82619e9dada766030511a81471ba9c3');
    expect(sql).not.toContain('/experimentally_supported_genomes/experimentally_supported_genomes/');
  });

  it('rejects a partial collection before producing SQL', () => {
    const fixture = fixtures();
    expect(() => buildExperimentalCollectionD1BackfillSql(
      fixture.metadata.split('\n').slice(0, -1).join('\n'),
      fixture.checksums,
    )).toThrow(/Expected 90 unique/);
  });
});
