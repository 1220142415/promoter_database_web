"""Parity with call_peaks.py, coordinate conventions, and dense-scan integration."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks

from prediction_service.formats import ScanArtifactWriter, scan_output_formats, ArtifactFormatError


def rows(path):
    return [line.split('\t') for line in path.read_text().splitlines() if line and not line.startswith('#')]


class PeakCallingTests(unittest.TestCase):
    def writer(self, path, records, formats=('gff3', 'json'), **kwargs):
        return ScanArtifactWriter(path, formats, records, model_version='test', checkpoint_sha256='test', stride=1, **kwargs)

    def test_matches_original_per_contig_strand_algorithm_and_retains_raw_scores(self):
        rng = np.random.default_rng(17)
        # Ties, plateaus, closely spaced maxima, edge maxima, and asymmetric strands.
        signals = [np.r_[.99, np.zeros(10), np.full(9, .999), np.zeros(4), np.full(7, .999), np.zeros(20)],
                   rng.uniform(.82, 1, 90), np.zeros(24), np.array([1.0]), np.array([])]
        with TemporaryDirectory() as folder:
            path = Path(folder)
            records = [(f'contig_{i}', max(len(v) + 99, 100)) for i, v in enumerate(signals)]
            writer = self.writer(path, records)
            expected = []
            raw_expected = []
            for (seqid, length), signal in zip(records, signals):
                for strand in ('+', '-'):
                    raw = np.asarray(signal, dtype=np.float32)
                    writer.add_scores(seqid, length, strand, raw, upstream_len=80, window_length=100)
                    ordered = raw if strand == '+' else raw[::-1]
                    anchors = np.arange(len(raw)) + (80 if strand == '+' else length - len(raw) - 80)
                    if len(raw):
                        smooth = gaussian_filter1d(ordered.astype(float), 1, mode='reflect')
                        peaks, _ = find_peaks(smooth, distance=10)
                        expected.extend((seqid, int(anchors[i]) + 1, strand, float(smooth[i])) for i in peaks if smooth[i] > .9)
                    raw_expected.extend((seqid, int(a), strand, float(v)) for a, v in zip(anchors, ordered))
            writer.close(success=True)
            peaks = rows(path/'peaks.gff3')
            self.assertGreater(len(peaks), 0)
            self.assertEqual(writer.peak_count, len(expected))
            self.assertEqual(len(peaks), len(expected))
            for row, (seqid, anchor, strand, score) in zip(peaks, expected):
                self.assertEqual((row[0], int(row[3]), int(row[4]), row[6]), (seqid, anchor, anchor, strand))
                self.assertAlmostEqual(float(row[5]), score, places=7)
            raw_rows = json.loads((path/'scores.json').read_text())
            self.assertEqual([(r['sequence_id'], r['anchor_position_0based'], r['strand'], r['score']) for r in raw_rows], raw_expected)
            for row in raw_rows:
                self.assertEqual(row['anchor_position_0based'] - row['window_start_0based'], 80 if row['strand'] == '+' else 19)

    def test_cutoff_is_strict_and_also_controls_peak_calling(self):
        with TemporaryDirectory() as folder:
            path = Path(folder)
            writer = self.writer(path, [('a', 140)], score_cutoff=1)
            scores = np.r_[np.zeros(10), np.full(12, .99), np.zeros(19)].astype(np.float32)
            writer.add_scores('a', 140, '+', scores, upstream_len=80, window_length=100)
            writer.close(success=True)
            self.assertEqual(len(rows(path/'scores.gff3')), 0)
            self.assertEqual(json.loads((path/'scores.json').read_text()), [])
            self.assertEqual(writer.peak_count, 0)
            self.assertIn('##RAPPtor-peak-cutoff >1', (path/'peaks.gff3').read_text())

        with TemporaryDirectory() as folder:
            path = Path(folder)
            writer = self.writer(path, [('a', 140)])
            # float32(0.9) is below the strict float64 threshold after smoothing.
            writer.add_scores('a', 140, '+', np.r_[np.zeros(10), np.full(12, .9), np.zeros(19)], upstream_len=80, window_length=100)
            writer.close(success=True)
            self.assertEqual(writer.peak_count, 0)
            self.assertEqual(rows(path/'peaks.gff3'), [])

    def test_bigwig_is_smoothed_while_parquet_retains_raw_scores(self):
        import pyBigWig
        import pyarrow.parquet as pq
        with TemporaryDirectory() as folder:
            path = Path(folder)
            writer = ScanArtifactWriter(
                path, ('bigwig', 'parquet'), [('a', 900)],
                model_version='test', checkpoint_sha256='test', stride=20,
            )
            scores = np.linspace(0, 1, 41, dtype=np.float32)
            for strand in ('+', '-'):
                writer.add_scores('a', 900, strand, scores, upstream_len=80, window_length=100)
            writer.close(success=True)
            for strand, suffix in (('+', 'plus'), ('-', 'minus')):
                with pyBigWig.open(str(path/f'scores.{suffix}.bw')) as bw:
                    actual = [r[2] for r in bw.intervals('a')]
                    ordered = scores if strand == '+' else scores[::-1]
                    expected = gaussian_filter1d(ordered.astype(float), 1, mode='reflect')
                    np.testing.assert_allclose(actual, expected, rtol=1e-6, atol=1e-7)
            table = pq.read_table(path/'scores.parquet')
            self.assertEqual(table.num_rows, 82)
            self.assertEqual(table.schema.metadata[b'rapptor_window_start_coordinate_system'], b'reference_0based')
            np.testing.assert_array_equal(table.column('score').to_numpy()[:41], scores)

    def test_dense_scan_automatically_calls_peaks_even_with_default_formats(self):
        from prediction_service import jobs
        from prediction_service.storage import JobStorage
        fake = SimpleNamespace(seq_length=100, upstream_len=80, checkpoint_sha256='test', model_config_sha256='test',
                               make_cgr=lambda *args: None, metadata=lambda: {'seq_length': 100}, reverse_complement=lambda s: s)
        def score(sequence, cgr, *, stride, batch_size, progress_callback):
            n = (len(sequence) - 100) // stride + 1
            progress_callback(n, n)
            return np.full(n, .2, dtype=np.float32)
        fake.score_sequence = score
        with TemporaryDirectory() as folder, patch.object(jobs, 'get_runtime', return_value=fake), patch.object(jobs, '_progress'):
            storage = JobStorage(Path(folder))
            for stride in (1, 20):
                jobid = str(stride).zfill(32)
                storage.create(jobid)
                result = jobs._scan(jobid, {'fasta': '>a\n' + 'ACGT'*35 + '\n>b\n'+'ACGT'*10, 'stride': stride}, storage)
                summary = storage.read_json(jobid, 'summary.json')
                files = [a['filename'] for a in result['artifacts']]
                self.assertEqual('peaks.gff3' in files, stride == 1)
                self.assertEqual(summary['peak_count'], 0 if stride == 1 else None)
                self.assertEqual(summary['window_count'], 82 if stride == 1 else 6)
                self.assertEqual(summary['window_start_coordinate_system'], 'reference_0based')
                self.assertEqual(summary['bigwig_smoothing'], {'method': 'gaussian', 'sigma': 1.0, 'mode': 'reflect'})

    def test_non_dense_gff_is_rejected_before_writing_results(self):
        self.assertIn('gff3', scan_output_formats(['bigwig'], 1))
        self.assertEqual(scan_output_formats(['bigwig'], 20), ('bigwig',))
        with TemporaryDirectory() as folder:
            with self.assertRaises(ArtifactFormatError):
                ScanArtifactWriter(Path(folder), ['gff3'], [('a', 140)], model_version='test', checkpoint_sha256='test', stride=20)
            self.assertEqual(list(Path(folder).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
