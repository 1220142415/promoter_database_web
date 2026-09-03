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
            "NC_1\tRAPPtor\tpromoter\t792\t891\t0.93193528\t+\t.\t"
            "ID=plus;peak_position=872;upstream_length=80;downstream_length=20\n"
            "NC_1\tRAPPtor\tpromoter\t1389\t1488\t0.95591227\t-\t.\t"
            "ID=minus;peak_position=1408;upstream_length=80;downstream_length=20\n"
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


if __name__ == "__main__":
    unittest.main()
