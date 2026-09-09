import importlib.util
import unittest
from pathlib import Path


SCRIPT = (
    Path(__file__).parents[2]
    / "scripts"
    / "huggingface"
    / "migrate-cyanobacteria-display-intervals.py"
)
SPEC = importlib.util.spec_from_file_location("migrate_cyanobacteria_display_intervals", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def record(record_id, start, end, anchor, strand, score="0.95000000", extra=""):
    suffix = f";{extra}" if extra else ""
    return (
        f"contig\tRAPPtor\tpromoter\t{start}\t{end}\t{score}\t{strand}\t.\t"
        f"ID={record_id};peak_position={anchor};upstream_length=80;downstream_length=20{suffix}"
    )


def data_rows(text):
    return [line.split("\t") for line in text.splitlines() if line and not line.startswith("#")]


class DisplayIntervalMigrationTests(unittest.TestCase):
    def test_migrates_both_strands_and_preserves_identity_and_scoring_coordinates(self):
        source = "\n".join([
            "##gff-version 3",
            record("plus", 20, 119, 100, "+", "0.93193528", "stride=2"),
            record("minus", 181, 280, 200, "-", "0.95591227", "stride=9"),
            "",
        ])

        migrated, report = MODULE.migrate_gff_text(source, [("contig", 500)])
        plus, minus = {row[8].split(";", 1)[0].split("=")[1]: row for row in data_rows(migrated)}.values()

        self.assertEqual((plus[3], plus[4], plus[5], plus[6]), ("21", "120", "0.93193528", "+"))
        self.assertEqual((minus[3], minus[4], minus[5], minus[6]), ("180", "279", "0.95591227", "-"))
        self.assertIn("stride=2", plus[8])
        self.assertIn("scoring_window_start_1based=20", plus[8])
        self.assertIn("scoring_window_end_1based=119", plus[8])
        self.assertIn("scoring_window_start_1based=181", minus[8])
        self.assertIn("scoring_window_end_1based=280", minus[8])
        self.assertEqual(report["records"], 2)
        self.assertEqual(report["strands"], {"plus": 1, "minus": 1})
        self.assertEqual(report["displayIntervals"], {"available": 2, "unavailable": 0})

    def test_keeps_anchor_point_when_new_interval_crosses_contig_boundary(self):
        # The legacy windows fit exactly, but shifting them by one base would not.
        source = "\n".join([
            record("plus-right-edge", 1, 100, 81, "+"),
            record("minus-left-edge", 1, 100, 20, "-"),
            "",
        ])

        migrated, report = MODULE.migrate_gff_text(source, [("contig", 100)])
        rows = data_rows(migrated)

        self.assertEqual((rows[0][3], rows[0][4]), ("20", "20"))
        self.assertEqual((rows[1][3], rows[1][4]), ("81", "81"))
        self.assertTrue(all("display_interval=unavailable" in row[8] for row in rows))
        self.assertEqual(report["displayIntervals"], {"available": 0, "unavailable": 2})

    def test_second_conversion_is_byte_stable(self):
        source = record("stable", 20, 119, 100, "+") + "\n"
        first, first_report = MODULE.migrate_gff_text(source, [("contig", 500)])
        second, second_report = MODULE.migrate_gff_text(first, [("contig", 500)])

        self.assertEqual(second, first)
        self.assertEqual(second_report["records"], first_report["records"])
        self.assertEqual(second_report["strands"], first_report["strands"])
        self.assertEqual(second_report["displayIntervals"], first_report["displayIntervals"])
        self.assertEqual(first_report["inputStates"], {"legacy": 1, "alreadyMigrated": 0})
        self.assertEqual(second_report["inputStates"], {"legacy": 0, "alreadyMigrated": 1})
        self.assertEqual(second.count(MODULE.DISPLAY_DIRECTIVE), 1)
        self.assertEqual(second.count(MODULE.SCORING_DIRECTIVE), 1)

    def test_rejects_new_coordinates_without_real_scoring_window_provenance(self):
        source = (
            "contig\tRAPPtor\tpromoter\t21\t120\t0.95\t+\t.\t"
            "ID=ambiguous;peak_position=100;upstream_length=79;downstream_length=20\n"
        )

        with self.assertRaisesRegex(MODULE.MigrationError, "cannot infer actual scoring window"):
            MODULE.migrate_gff_text(source, [("contig", 500)])

    def test_rejects_changed_or_partial_scoring_window_provenance(self):
        partial = record(
            "partial", 20, 119, 100, "+", extra="scoring_window_start_1based=20"
        ) + "\n"
        with self.assertRaisesRegex(MODULE.MigrationError, "incomplete scoring-window"):
            MODULE.migrate_gff_text(partial, [("contig", 500)])

        changed = (
            "contig\tRAPPtor\tpromoter\t21\t120\t0.95\t+\t.\t"
            "ID=changed;peak_position=100;upstream_length=79;downstream_length=20;"
            "scoring_window_start_1based=21;scoring_window_end_1based=120;"
            "scoring_window_coordinate_system=1-based_closed\n"
        )
        with self.assertRaisesRegex(MODULE.MigrationError, "differs from fixed source"):
            MODULE.migrate_gff_text(changed, [("contig", 500)])

    def test_rejects_duplicate_identity(self):
        source = "\n".join([
            record("same", 20, 119, 100, "+"),
            record("same", 20, 119, 100, "+"),
            "",
        ])
        with self.assertRaisesRegex(MODULE.MigrationError, "duplicate promoter identity"):
            MODULE.migrate_gff_text(source, [("contig", 500)])

    def test_updates_metadata_without_relabeling_the_source_backup(self):
        metadata = {
            "validation": {"predictionWindow": {"upstreamBp": 80, "downstreamBp": 20}},
            "coordinateSystems": {"sourceGff3": "1-based closed"},
            "sources": {
                "finalPredictions": {
                    "sha256": "source-sha",
                    "releaseAsset": "sources/final-predictions.source.gff3.gz",
                    "selection": "old display wording",
                }
            },
        }

        updated = MODULE.update_genome_metadata(metadata)

        self.assertEqual(updated["validation"]["predictionWindow"], MODULE.DISPLAY_WINDOW)
        self.assertEqual(updated["sources"]["finalPredictions"]["sha256"], "source-sha")
        self.assertIn("80/20 scoring windows", updated["sources"]["finalPredictions"]["selection"])
        self.assertIn("79 bp upstream", updated["sources"]["finalPredictions"]["selection"])
        self.assertEqual(updated["coordinateSystems"]["sourceGff3"], "1-based closed")


if __name__ == "__main__":
    unittest.main()
