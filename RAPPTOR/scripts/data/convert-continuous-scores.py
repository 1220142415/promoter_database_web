#!/usr/bin/env python3
"""Export existing 1-based per-position scores with sigma=1, no cutoff or peaks."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pyarrow.compute as pc
import pyarrow.parquet as pq
import pyBigWig
from scipy.ndimage import gaussian_filter1d


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def convert(source, fasta, output):
    references = {}
    sequence_hashes = {}
    with fasta.open() as handle:
        for line in handle:
            if line.startswith('>'):
                name = line[1:].split()[0]
                if name in references:
                    raise ValueError(f'Duplicate reference: {name}')
                references[name] = 0
                sequence_hashes[name] = hashlib.sha256()
            else:
                sequence = line.strip().upper()
                references[name] += len(sequence)
                sequence_hashes[name].update(sequence.encode('ascii'))
    table = pq.read_table(source, columns=['Sequence_ID', 'Position', 'Score', 'Strand'])
    if any(column.null_count for column in table.columns):
        raise ValueError('Null score fields')
    if set(table['Sequence_ID'].unique().to_pylist()) != set(references):
        raise ValueError('Score and FASTA references differ')
    if set(table['Strand'].unique().to_pylist()) != {'+', '-'}:
        raise ValueError('Expected both strands')
    output.mkdir(parents=True, exist_ok=True)
    manifest = {
        'source': source.name, 'sourceSha256': sha256(source),
        'fastaSha256': sha256(fasta),
        'references': {name: {'length': length, 'sequenceSha256': sequence_hashes[name].hexdigest()}
                       for name, length in references.items()},
        'smoothing': {'method': 'scipy.ndimage.gaussian_filter1d', 'sigma': 1,
                      'mode': 'reflect', 'truncate': 4, 'grouping': 'Sequence_ID and Strand'},
        'cutoffApplied': False, 'peakCallingApplied': False,
        'coordinates': 'input 1-based; BigWig 0-based half-open', 'files': [],
    }
    for strand, label in [('+', 'plus'), ('-', 'minus')]:
        target = output / f'promoter_scores.sigma1.{label}.bw'
        if target.exists():
            raise FileExistsError(target)
        records = []
        with pyBigWig.open(str(target), 'w') as bw:
            bw.addHeader(list(references.items()))
            for name, length in references.items():
                mask = pc.and_(pc.equal(table['Sequence_ID'], name), pc.equal(table['Strand'], strand))
                group = table.filter(mask).sort_by([('Position', 'ascending')])
                positions = group['Position'].to_numpy().astype(np.int64)
                scores = group['Score'].to_numpy().astype(np.float64)
                if not len(positions) or np.any(np.diff(positions) != 1):
                    raise ValueError(f'Nonconsecutive positions: {name} {strand}')
                if positions[0] < 1 or positions[-1] > length or not np.isfinite(scores).all():
                    raise ValueError(f'Invalid score coordinates/values: {name} {strand}')
                # Full stride-1 predictions of a 100 bp window, anchored at its TSS.
                expected = (81, length - 19) if strand == '+' else (20, length - 80)
                if (int(positions[0]), int(positions[-1])) != expected:
                    raise ValueError(f'Incomplete 100 bp window coverage: {name} {strand}')
                values = gaussian_filter1d(scores, sigma=1, mode='reflect', truncate=4).astype(np.float32)
                start = int(positions[0]) - 1
                for offset in range(0, len(values), 100000):
                    bw.addEntries(name, start + offset, values=values[offset:offset + 100000].tolist(), span=1, step=1)
                records.append({'reference': name, 'start': start, 'end': int(positions[-1]), 'count': len(values)})
                print(label, name, records[-1], flush=True)
        # Recompute independently from the source and verify every stored value.
        with pyBigWig.open(str(target)) as bw:
            assert bw.chroms() == references
            for record in records:
                name = record['reference']
                group = table.filter(pc.and_(pc.equal(table['Sequence_ID'], name), pc.equal(table['Strand'], strand))).sort_by([('Position', 'ascending')])
                expected_values = gaussian_filter1d(group['Score'].to_numpy().astype(np.float64), sigma=1, mode='reflect', truncate=4).astype(np.float32)
                for offset in range(0, record['count'], 100000):
                    expected_chunk = expected_values[offset:offset + 100000]
                    observed = bw.values(name, record['start'] + offset, record['start'] + offset + len(expected_chunk), numpy=True)
                    np.testing.assert_array_equal(observed, expected_chunk)
            assert bw.header()['nBasesCovered'] == sum(row['count'] for row in records)
        manifest['files'].append({'path': target.name, 'bytes': target.stat().st_size,
                                  'sha256': sha256(target), 'records': records, 'allValuesVerified': True})
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--fasta', required=True, type=Path)
    parser.add_argument('--output-dir', required=True, type=Path)
    args = parser.parse_args()
    convert(args.input, args.fasta, args.output_dir)
