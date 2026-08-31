from pathlib import Path

import numpy as np
import torch
from PIL import Image


def load_cgr_tensor(path: Path, expected_size: int = 128) -> torch.Tensor:
    """Load a generated CGR image with the transform used by the checkpoint."""
    with Image.open(path) as image:
        grayscale = image.convert("L")
        if grayscale.size != (expected_size, expected_size):
            raise ValueError(
                f"CGR image must be {expected_size}x{expected_size} pixels; "
                f"got {grayscale.size[0]}x{grayscale.size[1]}"
            )
        pixels = np.asarray(grayscale, dtype=np.float32) / 255.0
    tensor = torch.from_numpy(pixels).unsqueeze(0)
    return (torch.log1p(tensor) - 0.5) / 0.5
