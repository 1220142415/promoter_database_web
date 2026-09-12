"""Parity with call_peaks.py, coordinate conventions, and dense-scan integration."""
import json
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks

from prediction_service.formats import ScanArtifactWriter, scan_output_formats


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
                        expected.extend(
                            (
                                seqid,
                                int(anchors[i]) - (78 if strand == '+' else 19),
                                int(anchors[i]) + (21 if strand == '+' else 80),
                                int(anchors[i]) + 1,
                                strand,
                                float(smooth[i]),
                            )
                            for i in peaks if smooth[i] > .9
                        )
                    raw_expected.extend((seqid, int(a), strand, float(v)) for a, v in zip(anchors, ordered))
            writer.close(success=True)
            promoters = rows(path/'promoters.gff3')
            self.assertGreater(len(promoters), 0)
            self.assertEqual(writer.peak_count, len(expected))
            self.assertEqual(len(promoters), len(expected))
            promoter_text = (path/'promoters.gff3').read_text()
            self.assertNotIn('peak', promoter_text)
            self.assertNotRegex(promoter_text, r'upstream_length|downstream_length|stride|sampled_anchor|resolution_bp')
            for row, (seqid, start, end, anchor, strand, score) in zip(promoters, expected):
                self.assertEqual((row[0], int(row[3]), int(row[4]), row[6]), (seqid, start, end, strand))
                self.assertEqual(end - start + 1, 100)
                self.assertEqual(row[2], 'promoter')
                self.assertRegex(row[8], r'^ID=rapptor_promoter_\d{9};Name=Predicted\+promoter$')
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
            self.assertEqual((path/'promoters.gff3').read_text(), '##gff-version 3\n')

        with TemporaryDirectory() as folder:
            path = Path(folder)
            writer = self.writer(path, [('a', 140)])
            # float32(0.9) is below the strict float64 threshold after smoothing.
            writer.add_scores('a', 140, '+', np.r_[np.zeros(10), np.full(12, .9), np.zeros(19)], upstream_len=80, window_length=100)
            writer.close(success=True)
            self.assertEqual(writer.peak_count, 0)
            self.assertEqual(rows(path/'promoters.gff3'), [])

    def test_stride_one_is_smoothed_but_sampled_outputs_are_raw(self):
        import pyBigWig
        import pyarrow.parquet as pq
        scores = np.linspace(0, 1, 41, dtype=np.float32)
        for stride in (1, 10, 50, 100):
            with self.subTest(stride=stride), TemporaryDirectory() as folder:
                path = Path(folder)
                sequence_length = (len(scores) - 1) * stride + 100
                writer = ScanArtifactWriter(
                    path, ('bigwig', 'parquet'), [('a', sequence_length)],
                    model_version='test', checkpoint_sha256='test', stride=stride,
                )
                for strand in ('+', '-'):
                    writer.add_scores(
                        'a', sequence_length, strand, scores,
                        upstream_len=80, window_length=100,
                    )
                writer.close(success=True)
                for strand, suffix in (('+', 'plus'), ('-', 'minus')):
                    with pyBigWig.open(str(path/f'scores.{suffix}.bw')) as bw:
                        actual = [r[2] for r in bw.intervals('a')]
                        ordered = scores if strand == '+' else scores[::-1]
                        expected = gaussian_filter1d(ordered.astype(float), 1, mode='reflect') if stride == 1 else ordered
                        np.testing.assert_allclose(actual, expected, rtol=1e-6, atol=1e-7)
                table = pq.read_table(path/'scores.parquet')
                self.assertEqual(table.num_rows, 82)
                self.assertEqual(table.schema.metadata[b'rapptor_window_start_coordinate_system'], b'reference_0based')
                np.testing.assert_array_equal(table.column('score').to_numpy()[:41], scores)

    def test_scan_automatically_emits_promoters_with_stride_specific_summary(self):
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
                self.assertIn('model-score-tracks.zip', files)
                with zipfile.ZipFile(storage.job_dir(jobid) / 'model-score-tracks.zip') as archive:
                    self.assertEqual(archive.testzip(), None)
                    self.assertEqual(archive.namelist(), [
                        'model-score-tracks/scores.plus.bw',
                        'model-score-tracks/scores.minus.bw',
                    ])
                self.assertIn('promoters.gff3', files)
                self.assertEqual(summary['promoter_count'], 0)
                self.assertEqual(summary['peak_count'], 0)
                self.assertEqual(summary['window_count'], 82 if stride == 1 else 6)
                self.assertEqual(summary['window_start_coordinate_system'], 'reference_0based')
                self.assertEqual(
                    summary['bigwig_smoothing'],
                    {'method': 'gaussian', 'sigma': 1.0, 'mode': 'reflect'} if stride == 1 else None,
                )
                self.assertEqual(
                    summary['smoothing'],
                    {'method': 'gaussian', 'sigma': 1.0, 'mode': 'reflect'} if stride == 1 else None,
                )
                self.assertEqual(
                    summary['promoter_selection']['method'],
                    'local_maxima' if stride == 1 else 'all_windows_above_cutoff',
                )
                self.assertEqual(summary['peak_calling'] is not None, stride == 1)
                self.assertEqual(
                    summary['promoter_count'],
                    len(rows(storage.job_dir(jobid) / 'promoters.gff3')),
                )

    def test_sampled_stride_outputs_every_raw_window_above_cutoff(self):
        scores = np.array([.1, .75, .74, .5], dtype=np.float32)
        for stride in (10, 50, 100):
            with self.subTest(stride=stride), TemporaryDirectory() as folder:
                path = Path(folder)
                sequence_length = (len(scores) - 1) * stride + 100
                writer = ScanArtifactWriter(
                    path, ['gff3'], [('a', sequence_length)],
                    model_version='test', checkpoint_sha256='test',
                    stride=stride, score_cutoff=.5,
                )
                with patch(
                    'scipy.ndimage.gaussian_filter1d',
                    side_effect=AssertionError('sampled scans must not be smoothed'),
                ):
                    for strand in ('+', '-'):
                        writer.add_scores(
                            'a', sequence_length, strand, scores,
                            upstream_len=80, window_length=100,
                        )
                writer.close(success=True)
                promoter_text = (path/'promoters.gff3').read_text()
                promoter_rows = rows(path/'promoters.gff3')
                self.assertEqual(promoter_text.splitlines()[0], '##gff-version 3')
                self.assertEqual(sum(line.startswith('#') for line in promoter_text.splitlines()), 1)
                self.assertNotIn('peak', promoter_text)
                self.assertNotRegex(
                    promoter_text,
                    r'upstream_length|downstream_length|stride|sampled_anchor|resolution_bp',
                )
                self.assertEqual(len(promoter_rows), 4)
                self.assertEqual(
                    [(row[6], int(row[3]), int(row[4])) for row in promoter_rows],
                    [
                        ('+', stride + 2, stride + 101),
                        ('+', 2 * stride + 2, 2 * stride + 101),
                        ('-', stride, stride + 99),
                        ('-', 2 * stride, 2 * stride + 99),
                    ],
                )
                np.testing.assert_allclose(
                    [float(row[5]) for row in promoter_rows],
                    [.75, .74, .74, .75],
                    rtol=1e-7,
                    atol=1e-7,
                )
                self.assertTrue(all(row[2] == 'promoter' for row in promoter_rows))
                self.assertTrue(all(row[8].startswith('ID=rapptor_promoter_') for row in promoter_rows))
                self.assertIn('##RAPPtor-score-smoothing none', (path/'scores.gff3').read_text())

    def test_sampled_stride_does_not_promote_a_raw_low_score_via_neighbor_smoothing(self):
        scores = np.array([1.0, 0.0, 1.0, 0.5], dtype=np.float32)
        cutoff = .4
        self.assertGreater(gaussian_filter1d(scores.astype(float), 1, mode='reflect')[1], cutoff)
        with TemporaryDirectory() as folder:
            path = Path(folder)
            writer = ScanArtifactWriter(
                path, ['gff3'], [('a', 250)], model_version='test', checkpoint_sha256='test',
                stride=50, score_cutoff=cutoff,
            )
            writer.add_scores('a', 250, '+', scores, upstream_len=80, window_length=100)
            writer.close(success=True)
            promoter_rows = rows(path/'promoters.gff3')
            np.testing.assert_allclose([float(row[5]) for row in promoter_rows], [1.0, 1.0, .5])
            self.assertNotIn(0.0, [float(row[5]) for row in promoter_rows])

    def test_boundary_peaks_remain_single_anchor_points_without_clipping(self):
        for strand, sampled_index, expected_anchor in (('+', 2, 83), ('-', 0, 20)):
            with self.subTest(strand=strand), TemporaryDirectory() as folder:
                path = Path(folder)
                scores = np.ones(3, dtype=np.float32)
                writer = ScanArtifactWriter(
                    path, ['gff3'], [('a', 102)], model_version='test',
                    checkpoint_sha256='test', stride=1, score_cutoff=.2,
                )
                with patch('scipy.signal.find_peaks', return_value=(np.array([sampled_index]), {})):
                    writer.add_scores('a', 102, strand, scores, upstream_len=80, window_length=100)
                writer.close(success=True)
                promoter = rows(path / 'promoters.gff3')[0]
                self.assertEqual((int(promoter[3]), int(promoter[4])), (expected_anchor, expected_anchor))
                self.assertEqual(promoter[2], 'promoter')
                self.assertRegex(promoter[8], r'^ID=rapptor_promoter_\d{9};Name=Predicted\+promoter$')

    def test_non_dense_gff_is_supported_without_changing_default_formats(self):
        self.assertEqual(scan_output_formats(None, 50), ('bigwig', 'gff3'))
        self.assertIn('gff3', scan_output_formats(['bigwig'], 1))
        self.assertEqual(scan_output_formats(['bigwig'], 20), ('bigwig', 'gff3'))
        with TemporaryDirectory() as folder:
            writer = ScanArtifactWriter(Path(folder), ['gff3'], [('a', 140)], model_version='test', checkpoint_sha256='test', stride=20)
            writer.close(success=True)
            self.assertTrue((Path(folder)/'promoters.gff3').exists())


if __name__ == '__main__':
    unittest.main()
