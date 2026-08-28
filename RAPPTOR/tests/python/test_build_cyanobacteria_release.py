import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "data" / "build-cyanobacteria-release.py"
SPEC = importlib.util.spec_from_file_location("build_cyanobacteria_release", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)

try:
    import pyBigWig
    import pysam

    HAS_RELEASE_DEPS = True
except ImportError:
    HAS_RELEASE_DEPS = False


class CyanobacteriaReleaseValidationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, text):
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_reads_fai_and_rejects_duplicate_sequences(self):
        path = self.write("reference.fa.fai", "chr1\t100\t0\t0\t0\nplasmid\t20\t0\t0\t0\n")
        self.assertEqual(MODULE.read_fai(path), [("chr1", 100), ("plasmid", 20)])
        path.write_text("chr1\t100\nchr1\t20\n", encoding="utf-8")
        with self.assertRaises(MODULE.ReleaseValidationError):
            MODULE.read_fai(path)

    def test_normalizes_experimental_tss_bed_and_preserves_study_provenance(self):
        source = self.write(
            "experimental.bed",
            "GCF_fixture:chr1\t0\t1\tgeneA\t42\t+\n"
            "GCF_fixture:plasmid\t19\t20\tgeneB\t7\t-\n",
        )
        destination = self.root / "experimental.gff3"
        config = {
            "seqidPrefix": "GCF_fixture:",
            "studyId": "study_fixture",
            "pmid": "12345",
            "assemblyAccession": "GCF_fixture",
            "expectedObservationCount": 2,
            "expectedUniqueTssCount": 2,
            "expectedStrands": {"plus": 1, "minus": 1},
            "expectedSequenceCount": 2,
        }
        observed = MODULE.normalize_experimental_tss_bed(
            source,
            destination,
            [("chr1", 100), ("plasmid", 20)],
            config,
        )
        self.assertEqual(observed, {
            "observationCount": 2,
            "uniqueTssCount": 2,
            "duplicateObservationCount": 0,
            "strands": {"plus": 1, "minus": 1},
            "sequenceCount": 2,
            "sequences": ["chr1", "plasmid"],
        })
        rows = [line for line in destination.read_text(encoding="utf-8").splitlines() if not line.startswith("#")]
        self.assertEqual([(row.split("\t")[0], row.split("\t")[3], row.split("\t")[6]) for row in rows], [
            ("chr1", "1", "+"),
            ("plasmid", "20", "-"),
        ])
        self.assertIn("evidence=experimentally_supported", rows[0])
        self.assertIn("study_id=study_fixture", rows[0])
        self.assertIn("pmid=12345", rows[0])
        self.assertNotIn("source_signal", rows[0])
        first_attributes = MODULE.parse_gff3_attributes(rows[0].split("\t")[8])
        second_attributes = MODULE.parse_gff3_attributes(rows[1].split("\t")[8])
        self.assertEqual(first_attributes["Name"], "geneA")
        self.assertEqual(first_attributes["source_name"], "geneA")
        self.assertEqual(second_attributes["Name"], "geneB")
        self.assertEqual(second_attributes["source_name"], "geneB")

    def test_preserves_bed_name_column_without_relabeling(self):
        for name in ("all0006", "6210", "atpH"):
            source = self.write("experimental.bed", f"GCF_fixture:chr1\t0\t1\t{name}\t1\t+\n")
            destination = self.root / "experimental.gff3"
            MODULE.normalize_experimental_tss_bed(
                source,
                destination,
                [("chr1", 100)],
                {
                    "seqidPrefix": "GCF_fixture:",
                    "studyId": "study_fixture",
                    "pmid": "12345",
                    "assemblyAccession": "GCF_fixture",
                    "expectedObservationCount": 1,
                    "expectedUniqueTssCount": 1,
                    "expectedStrands": {"plus": 1, "minus": 0},
                    "expectedSequenceCount": 1,
                },
            )
            row = next(line for line in destination.read_text(encoding="utf-8").splitlines() if not line.startswith("#"))
            attributes = MODULE.parse_gff3_attributes(row.split("\t")[8])
            self.assertEqual(attributes["Name"], name)
            self.assertEqual(attributes["source_name"], name)

    def test_rejects_incompatible_experimental_tss_bed(self):
        config = {
            "seqidPrefix": "GCF_fixture:",
            "studyId": "study_fixture",
            "pmid": "12345",
            "assemblyAccession": "GCF_fixture",
            "expectedObservationCount": 1,
            "expectedUniqueTssCount": 1,
            "expectedStrands": {"plus": 1, "minus": 0},
            "expectedSequenceCount": 1,
        }
        cases = {
            "wrong assembly": "GCF_other:chr1\t0\t1\tgene\t1\t+\n",
            "unknown sequence": "GCF_fixture:chrX\t0\t1\tgene\t1\t+\n",
            "non point": "GCF_fixture:chr1\t0\t2\tgene\t1\t+\n",
            "out of range": "GCF_fixture:chr1\t100\t101\tgene\t1\t+\n",
            "unknown strand": "GCF_fixture:chr1\t0\t1\tgene\t1\t.\n",
        }
        for label, row in cases.items():
            with self.subTest(label=label):
                source = self.write("experimental.bed", row)
                with self.assertRaises(MODULE.ReleaseValidationError):
                    MODULE.normalize_experimental_tss_bed(
                        source,
                        self.root / "experimental.gff3",
                        [("chr1", 100)],
                        config,
                    )

    def test_converts_gff3_points_to_zero_based_bigwig_offsets(self):
        path = self.write(
            "candidate.gff3",
            "##gff-version 3\n"
            "chr1\tRAPPtor\tpromoter_peak\t1\t1\t0.25\t+\t.\tID=p1\n"
            "chr1\tRAPPtor\tpromoter_peak\t100\t100\t0.91\t-\t.\tID=p2\n",
        )
        records, counts, final = MODULE.read_peak_records(path, {"chr1": 100})
        self.assertEqual(records["+"]["chr1"], [(0, 0.25)])
        self.assertEqual(records["-"]["chr1"], [(99, 0.91)])
        self.assertEqual((counts["+"], counts["-"]), (1, 1))
        self.assertEqual(final, {("chr1", 100, "-", 0.91)})

    def test_rejects_invalid_scores_duplicates_unknown_sequences_and_strands(self):
        cases = {
            "zero score": "chr1\tRAPPtor\tpromoter_peak\t1\t1\t0\t+\t.\tID=p1\n",
            "score above one": "chr1\tRAPPtor\tpromoter_peak\t1\t1\t1.01\t+\t.\tID=p1\n",
            "unknown sequence": "chrX\tRAPPtor\tpromoter_peak\t1\t1\t0.2\t+\t.\tID=p1\n",
            "out of bounds": "chr1\tRAPPtor\tpromoter_peak\t101\t101\t0.2\t+\t.\tID=p1\n",
            "unknown strand": "chr1\tRAPPtor\tpromoter_peak\t1\t1\t0.2\t.\t.\tID=p1\n",
            "non point": "chr1\tRAPPtor\tpromoter_peak\t1\t2\t0.2\t+\t.\tID=p1\n",
            "duplicate": (
                "chr1\tRAPPtor\tpromoter_peak\t1\t1\t0.2\t+\t.\tID=p1\n"
                "chr1\tRAPPtor\tpromoter_peak\t1\t1\t0.3\t+\t.\tID=p2\n"
            ),
        }
        for label, row in cases.items():
            with self.subTest(label=label):
                path = self.write("candidate.gff3", f"##gff-version 3\n{row}")
                with self.assertRaises(MODULE.ReleaseValidationError):
                    MODULE.read_peak_records(path, {"chr1": 100})

    def test_enforces_strict_score_threshold_and_exact_final_subset(self):
        candidate = self.write(
            "candidate.gff3",
            "chr1\tRAPPtor\tpromoter_peak\t10\t10\t0.9\t+\t.\tID=p1\n"
            "chr1\tRAPPtor\tpromoter_peak\t20\t20\t0.90000001\t+\t.\tID=p2\n"
            "chr1\tRAPPtor\tpromoter_peak\t30\t30\t1\t-\t.\tID=p3\n",
        )
        _records, _counts, expected = MODULE.read_peak_records(candidate, {"chr1": 100})
        final = self.write(
            "final.gff3",
            "chr1\tRAPPtor\tpromoter_peak\t20\t20\t0.90000001\t+\t.\tID=p2\n"
            "chr1\tRAPPtor\tpromoter_peak\t30\t30\t1\t-\t.\tID=p3\n",
        )
        observed, _strands = MODULE.read_final_peak_set(final, {"chr1": 100})
        MODULE.require_exact_final_subset("fixture", expected, observed)
        with self.assertRaisesRegex(MODULE.ReleaseValidationError, "exact score > 0.9 subset"):
            MODULE.require_exact_final_subset("fixture", expected, set(list(observed)[:1]))

    def test_sorts_gff3_by_reference_and_coordinate(self):
        source = self.write(
            "unsorted.gff3",
            "chr2\tsrc\tgene\t8\t9\t.\t-\t.\tID=b\n"
            "chr1\tsrc\tgene\t20\t25\t.\t+\t.\tID=c\n"
            "chr1\tsrc\tgene\t2\t5\t.\t+\t.\tID=a\n",
        )
        destination = self.root / "sorted.gff3"
        counts, splits = MODULE.sorted_gff(source, destination, [("chr1", 100), ("chr2", 20)])
        rows = [line for line in destination.read_text(encoding="utf-8").splitlines() if not line.startswith("#")]
        self.assertEqual([row.split("\t")[8] for row in rows], ["ID=a", "ID=c", "ID=b"])
        self.assertEqual(counts["gene"], 3)
        self.assertEqual(splits, 0)

    def test_splits_only_declared_circular_origin_features(self):
        source = self.write(
            "circular.gff3",
            "##sequence-region plasmid 1 100\n"
            "plasmid\tsrc\tregion\t1\t100\t.\t+\t.\tID=plasmid;Is_circular=true\n"
            "plasmid\tsrc\tgene\t95\t105\t.\t-\t.\tID=origin-gene\n",
        )
        destination = self.root / "circular.sorted.gff3"
        counts, splits = MODULE.sorted_gff(source, destination, [("plasmid", 100)])
        rows = [line.split("\t") for line in destination.read_text(encoding="utf-8").splitlines() if not line.startswith("#")]
        gene_rows = [row for row in rows if row[2] == "gene"]
        self.assertEqual([(row[3], row[4]) for row in gene_rows], [("1", "5"), ("95", "100")])
        self.assertEqual({row[8].split(";")[0] for row in gene_rows}, {"ID=origin-gene"})
        self.assertTrue(all("rapptor_circular_origin_part=" in row[8] for row in gene_rows))
        self.assertEqual(counts["gene"], 1)
        self.assertEqual(splits, 1)

        source.write_text("plasmid\tsrc\tgene\t95\t105\t.\t-\t.\tID=bad\n", encoding="utf-8")
        with self.assertRaisesRegex(MODULE.ReleaseValidationError, "outside the reference"):
            MODULE.sorted_gff(source, destination, [("plasmid", 100)])

    @unittest.skipUnless(HAS_RELEASE_DEPS, "requires pyBigWig and pysam")
    def test_writes_browser_ready_fasta_bigwig_and_tabix_assets(self):
        fasta = self.write("reference.fa", ">chr1\nACGTACGTACGT\n")
        compressed_fasta = self.root / "reference.fa.gz"
        MODULE.bgzip_and_index_fasta(fasta, compressed_fasta)
        self.assertTrue(Path(f"{compressed_fasta}.fai").is_file())
        self.assertTrue(Path(f"{compressed_fasta}.gzi").is_file())
        with pysam.FastaFile(str(compressed_fasta)) as indexed:
            self.assertEqual(indexed.fetch("chr1", 0, 4), "ACGT")

        bigwig = self.root / "candidate-peak-scores.plus.bw"
        MODULE.write_bigwig(bigwig, [("chr1", 12)], {"+": {"chr1": [(0, 0.25), (11, 0.95)]}}, "+")
        with pyBigWig.open(str(bigwig)) as indexed:
            self.assertEqual(indexed.chroms(), {"chr1": 12})
            self.assertEqual([(start, end) for start, end, _score in indexed.intervals("chr1")], [(0, 1), (11, 12)])

        gff = self.write("annotations.gff3", "##gff-version 3\nchr1\tsrc\tCDS\t2\t5\t.\t+\t0\tID=cds1\n")
        compressed_gff = self.root / "genome-annotations.gff3.gz"
        MODULE.bgzip_and_index_gff(gff, compressed_gff)
        self.assertTrue(Path(f"{compressed_gff}.tbi").is_file())
        with pysam.TabixFile(str(compressed_gff)) as indexed:
            self.assertEqual(list(indexed.fetch("chr1", 0, 6)), ["chr1\tsrc\tCDS\t2\t5\t.\t+\t0\tID=cds1"])


if __name__ == "__main__":
    unittest.main()
