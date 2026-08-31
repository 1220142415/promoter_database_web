"""Convert FASTA sequences to Chaos Game Representation (CGR).

The coordinate construction follows Jeffrey, "Chaos game representation of
gene structure", Nucleic Acids Research 18(8), 1990.
https://doi.org/10.1093/nar/18.8.2163
"""

from pathlib import Path

import numpy as np
from PIL import Image


_CORNERS = {
    "A": np.array([0.0, 0.0]),
    "C": np.array([0.0, 1.0]),
    "G": np.array([1.0, 1.0]),
    "T": np.array([1.0, 0.0]),
}


def _read_fasta(path):
    sequence = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line and not line.startswith(">"):
                sequence.append(line)
    return "".join(sequence).upper()


def _generate_matrix(sequence, resolution, normalize):
    current = np.array([0.5, 0.5])
    coordinates = []
    for base in sequence:
        corner = _CORNERS.get(base)
        if corner is not None:
            current = 0.5 * (current + corner)
            coordinates.append(current.copy())

    if not coordinates:
        return np.zeros((resolution, resolution), dtype=np.float32)

    coordinates = np.asarray(coordinates)
    indices = np.clip(
        (coordinates * resolution).astype(int),
        0,
        resolution - 1,
    )
    matrix, _, _ = np.histogram2d(
        indices[:, 0],
        indices[:, 1],
        bins=resolution,
        range=[[0, resolution], [0, resolution]],
    )
    if not normalize:
        return matrix

    matrix = np.log1p(matrix)
    maximum = matrix.max()
    return matrix / maximum if maximum > 0 else matrix


def _save_image(matrix, path, raw_counts):
    image = matrix
    if raw_counts:
        image = np.log1p(image)

    minimum = image.min()
    maximum = image.max()
    if maximum > minimum:
        image = (image - minimum) / (maximum - minimum)
    else:
        image = np.zeros_like(image)

    pixels = np.clip(np.flipud(image) * 256, 0, 255).astype(np.uint8)
    Image.fromarray(pixels).save(path)


def generate_cgr_from_fasta(
    input_path,
    output_path,
    image_path=None,
    resolution=128,
    raw_counts=False,
):
    """Write a CGR matrix and optional grayscale PNG for one FASTA file."""
    sequence = _read_fasta(input_path)
    if len(sequence) < 10:
        raise ValueError("Input sequence must contain at least 10 bases.")

    matrix = _generate_matrix(sequence, resolution, normalize=not raw_counts)
    np.save(output_path, matrix)
    if image_path:
        _save_image(matrix, image_path, raw_counts)
    return matrix
