"""Run with unittest as well as pytest; accounting tests need no ML dependencies."""

import importlib.util
import unittest

from prediction_service.scan_progress import ScanProgress, count_scan_windows


class ScanProgressTests(unittest.TestCase):
    def test_window_count_uses_stride_lengths_and_strands(self):
        self.assertEqual(count_scan_windows([114, 102, 90], 100, 2, True), 20)
        self.assertEqual(count_scan_windows([114, 102, 90], 100, 2, False), 10)
        self.assertEqual(count_scan_windows([100, 99], 100, 20, True), 2)
        self.assertEqual(count_scan_windows([10, 90], 100, 1, True), 0)

    def test_batches_accumulate_across_unequal_sequences_and_both_strands(self):
        events = []
        tracker = ScanProgress(20, lambda stage, percent, **data: events.append((stage, percent, data)), interval=0)
        for contig, strand, total in [('one', '+', 8), ('one', '-', 8), ('two', '+', 2), ('two', '-', 2)]:
            tracker.start_sequence(contig, strand)
            tracker.batch_completed(total // 2, total)
            tracker.batch_completed(total, total)
        counts = [data['windows'] for _, _, data in events]
        self.assertEqual(counts, sorted(counts))
        self.assertEqual(events[1][2]['scan_percent'], 20)
        self.assertEqual(events[2][2]['scan_percent'], 40)
        self.assertEqual(events[-1], ('scanning', 90.0, {
            'windows': 20, 'total_windows': 20, 'scan_percent': 100.0, 'contig': 'two', 'strand': '-',
        }))

    def test_reporting_is_throttled_but_last_batch_and_strand_changes_are_immediate(self):
        events = []
        now = [0.0]
        tracker = ScanProgress(16, lambda *args, **data: events.append(data), clock=lambda: now[0])
        tracker.start_sequence('one', '+')
        now[0] = 0.1
        tracker.batch_completed(2, 8)
        self.assertEqual(len(events), 1)
        now[0] = 1.1
        tracker.batch_completed(4, 8)
        self.assertEqual(events[-1]['windows'], 4)
        now[0] = 1.2
        tracker.batch_completed(8, 8)
        self.assertEqual(events[-1]['windows'], 8)
        tracker.start_sequence('one', '-')
        self.assertEqual(events[-1]['strand'], '-')
        self.assertEqual(events[-1]['windows'], 8)

    def test_empty_scan_does_not_divide_by_zero(self):
        events = []
        tracker = ScanProgress(0, lambda *args, **data: events.append(data))
        tracker.report(force=True)
        self.assertEqual(events[0]['windows'], 0)
        self.assertEqual(events[0]['total_windows'], 0)
        self.assertEqual(events[0]['scan_percent'], 0)

    @unittest.skipUnless(importlib.util.find_spec('torch'), 'PyTorch is required for the inference callback test')
    def test_inference_callback_counts_partial_batches_without_changing_scores(self):
        from types import SimpleNamespace
        import numpy as np
        import torch
        from rapptor.inference.scan_gtdb_shared import run_inference_on_sequence

        class Model(torch.nn.Module):
            def forward(self, values, genome_emb=None):
                return torch.stack((values[:, 0, :].sum(1), values[:, 1, :].sum(1)), dim=1)

        args = SimpleNamespace(length=4, stride=2, batch_size=3, device='cpu')
        events = []
        expected = run_inference_on_sequence('ACGTACGTACGT', Model(), None, args)
        actual = run_inference_on_sequence('ACGTACGTACGT', Model(), None, args, progress_callback=lambda done, total: events.append((done, total)))
        self.assertEqual(events, [(3, 5), (5, 5)])
        np.testing.assert_array_equal(actual, expected)


if __name__ == '__main__':
    unittest.main()
