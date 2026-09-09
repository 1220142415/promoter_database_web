import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "data" / "build-cyanobacteria-release.py"
SPEC = importlib.util.spec_from_file_location("build_cyanobacteria_release", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


class CyanobacteriaPredictionWindowTests(unittest.TestCase):
    def test_reads_strand_aware_100_bp_promoters_by_peak_anchor(self):
        rows = (
            "NC_1\tRAPPtor\tpromoter\t793\t892\t0.93193528\t+\t.\t"
            "ID=plus;peak_position=872;upstream_length=79;downstream_length=20;display_interval=available\n"
            "NC_1\tRAPPtor\tpromoter\t1388\t1487\t0.95591227\t-\t.\t"
            "ID=minus;peak_position=1408;upstream_length=79;downstream_length=20;display_interval=available\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "promoters.gff3"
            path.write_text(rows, encoding="utf-8")
            values, strands = MODULE.read_final_peak_set(path, {"NC_1": 2000})

        self.assertEqual(
            values,
            {
                ("NC_1", 872, "+", 0.93193528),
                ("NC_1", 1408, "-", 0.95591227),
            },
        )
        self.assertEqual(strands, {"+": 1, "-": 1})

    def test_normalization_is_repeatable_and_preserves_anchor_id_score_and_strand(self):
        old = (
            "##gff-version 3\n"
            "NC_1\tRAPPtor\tpromoter\t792\t891\t0.93193528\t+\t.\t"
            "ID=plus;peak_position=872;upstream_length=80;downstream_length=20\n"
            "NC_1\tRAPPtor\tpromoter\t1389\t1488\t0.95591227\t-\t.\t"
            "ID=minus;peak_position=1408;upstream_length=80;downstream_length=20\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, first, second = root / "old.gff3", root / "first.gff3", root / "second.gff3"
            source.write_text(old, encoding="utf-8")
            MODULE.normalize_prediction_display_gff(source, first, {"NC_1": 2000})
            MODULE.normalize_prediction_display_gff(first, second, {"NC_1": 2000})
            first_rows = [line for line in first.read_text().splitlines() if not line.startswith("#")]
            second_rows = [line for line in second.read_text().splitlines() if not line.startswith("#")]
            self.assertEqual(first_rows, second_rows)
            self.assertIn("\t793\t892\t0.93193528\t+\t", first_rows[0])
            self.assertIn("\t1388\t1487\t0.95591227\t-\t", first_rows[1])
            self.assertIn("ID=plus;peak_position=872", first_rows[0])
            self.assertIn("scoring_window_start_1based=792", first_rows[0])

    def test_boundary_interval_falls_back_to_the_anchor_point(self):
        source_text = (
            "NC_1\tRAPPtor\tpromoter\t1\t100\t0.95\t-\t.\t"
            "ID=boundary;peak_position=20;upstream_length=80;downstream_length=20\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "old.gff3", root / "new.gff3"
            source.write_text(source_text, encoding="utf-8")
            MODULE.normalize_prediction_display_gff(source, output, {"NC_1": 100})
            row = [line for line in output.read_text().splitlines() if not line.startswith("#")][0]
            self.assertIn("\t20\t20\t0.95\t-\t", row)
            self.assertIn("display_interval=unavailable", row)


if __name__ == "__main__":
    unittest.main()
