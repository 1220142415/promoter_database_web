import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "convert-promoter-scores.py"
SPEC = importlib.util.spec_from_file_location("convert_promoter_scores", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)

try:
    import pyarrow as pa
    import pyarrow.parquet as pq
    import pyBigWig

    HAS_BIGWIG_DEPS = True
except ImportError:
    HAS_BIGWIG_DEPS = False


@unittest.skipUnless(HAS_BIGWIG_DEPS, "requires pyarrow and pyBigWig")
class ConvertPromoterScoresTests(unittest.TestCase):
    accession = "GCA_000411415.1"

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.object_root = self.root / "release" / "objects" / self.accession
        self.object_root.mkdir(parents=True)
        (self.object_root / "reference.fa.gz.fai").write_text("chr1\t500\t0\t0\t0\n", encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def write_parquet(self, rows, name=None):
        path = self.root / (name or f"{self.accession}.parquet")
        columns = {key: [row[key] for row in rows] for key in rows[0]}
        pq.write_table(pa.table(columns), path)
        return path

    def valid_rows(self):
        rows = []
        for strand, starts in (("+", [80, 130, 180]), ("-", [19, 69, 119])):
            for index, start in enumerate(starts):
                rows.append({
                    "Sequence_ID": "chr1",
                    "Start": start,
                    "End": start + 1,
                    "Score": 0.1 + index * 0.4,
                    "Strand": strand,
                })
        return rows

    def test_converts_both_strands_and_preserves_scores(self):
        source = self.write_parquet(self.valid_rows())
        accession, plus_count, minus_count = MODULE.convert_file(source, self.root / "release", 50)
        self.assertEqual((accession, plus_count, minus_count), (self.accession, 3, 3))
        plus_path = self.object_root / "promoter-scores.plus.bw"
        minus_path = self.object_root / "promoter-scores.minus.bw"
        self.assertTrue(plus_path.is_file())
        self.assertTrue(minus_path.is_file())
        with pyBigWig.open(str(plus_path)) as plus:
            self.assertEqual(plus.chroms(), {"chr1": 500})
            plus_intervals = plus.intervals("chr1")
            self.assertEqual([(start, end) for start, end, _score in plus_intervals], [(80, 81), (130, 131), (180, 181)])
            for observed, expected in zip((score for _start, _end, score in plus_intervals), (0.1, 0.5, 0.9)):
                self.assertAlmostEqual(observed, expected, places=6)

    def test_accepts_sidecar_position_schema(self):
        rows = [
            {"Sequence_ID": "chr1", "Position": start, "Score": score, "Strand": strand}
            for strand, starts in (("+", [80, 130]), ("-", [19, 69]))
            for start, score in zip(starts, (0.25, 0.75))
        ]
        path = self.root / f"{self.accession}.sidecar.parquet"
        pq.write_table(pa.table({key: [row[key] for row in rows] for key in rows[0]}), path)

        records = MODULE.load_records(path, {"chr1": 500}, 50)

        self.assertEqual(records["+"]["chr1"], [(80, 81, 0.25), (130, 131, 0.75)])
        self.assertEqual(records["-"]["chr1"], [(19, 20, 0.25), (69, 70, 0.75)])
        MODULE.convert_file(path, self.root / "release", 50)
        minus_path = self.object_root / "promoter-scores.minus.bw"
        with pyBigWig.open(str(minus_path)) as minus:
            minus_intervals = minus.intervals("chr1")
            self.assertEqual([(start, end) for start, end, _score in minus_intervals], [(19, 20), (69, 70)])
            for observed, expected in zip((score for _start, _end, score in minus_intervals), (0.25, 0.75)):
                self.assertAlmostEqual(observed, expected, places=6)

    def test_rejects_invalid_records(self):
        cases = {
            "unknown sequence": {"Sequence_ID": "chrX"},
            "non-point interval": {"End": 82},
            "out of bounds": {"Start": 500, "End": 501},
            "score out of range": {"Score": 1.1},
            "invalid strand": {"Strand": "?"},
            "wrong stride": {"Start": 131, "End": 132},
            "fractional coordinate": {"Start": 130.5, "End": 131.5},
        }
        for label, replacement in cases.items():
            with self.subTest(label=label):
                rows = self.valid_rows()
                rows[1] = {**rows[1], **replacement}
                path = self.write_parquet(rows, f"{self.accession}.{label.replace(' ', '-')}.parquet")
                with self.assertRaises(MODULE.ScoreValidationError):
                    MODULE.load_records(path, {"chr1": 500}, 50)

    def test_rejects_duplicates_missing_columns_and_missing_strand(self):
        duplicate = self.valid_rows()
        duplicate.append(dict(duplicate[0]))
        with self.assertRaises(MODULE.ScoreValidationError):
            MODULE.load_records(self.write_parquet(duplicate, f"{self.accession}.duplicate.parquet"), {"chr1": 500}, 50)

        plus_only = [row for row in self.valid_rows() if row["Strand"] == "+"]
        with self.assertRaises(MODULE.ScoreValidationError):
            MODULE.load_records(self.write_parquet(plus_only, f"{self.accession}.plus-only.parquet"), {"chr1": 500}, 50)

        missing_column = [{key: value for key, value in row.items() if key != "Score"} for row in self.valid_rows()]
        with self.assertRaises(MODULE.ScoreValidationError):
            MODULE.load_records(self.write_parquet(missing_column, f"{self.accession}.missing-column.parquet"), {"chr1": 500}, 50)

    def test_requires_accession_in_filename(self):
        with self.assertRaises(MODULE.ScoreValidationError):
            MODULE.accession_from_path(Path("scores.parquet"))
        with self.assertRaises(MODULE.ScoreValidationError):
            MODULE.accession_from_path(Path("GCA_000411415.1_GCF_000000002.1.parquet"))

    def test_main_requires_exactly_one_parquet_for_each_release_accession(self):
        other_accession = "GCF_000000002.1"
        other_root = self.root / "release" / "objects" / other_accession
        other_root.mkdir(parents=True)
        (other_root / "reference.fa.gz.fai").write_text("chr1\t500\t0\t0\t0\n", encoding="utf-8")
        self.write_parquet(self.valid_rows())

        with patch.object(MODULE.sys, "argv", [
            str(SCRIPT),
            "--score-root", str(self.root),
            "--release-root", str(self.root / "release"),
        ]):
            with self.assertRaisesRegex(MODULE.ScoreValidationError, other_accession):
                MODULE.main()
        self.assertFalse((self.object_root / "promoter-scores.plus.bw").exists())
        self.assertFalse((self.object_root / "promoter-scores.minus.bw").exists())

        self.write_parquet(self.valid_rows(), f"{other_accession}.parquet")
        self.write_parquet(self.valid_rows(), f"duplicate-{self.accession}.parquet")
        with patch.object(MODULE.sys, "argv", [
            str(SCRIPT),
            "--score-root", str(self.root),
            "--release-root", str(self.root / "release"),
        ]):
            with self.assertRaisesRegex(MODULE.ScoreValidationError, "duplicate Parquet files"):
                MODULE.main()


if __name__ == "__main__":
    unittest.main()
