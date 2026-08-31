"""Rotary position embeddings.

Based on Su et al., "RoFormer: Enhanced Transformer with Rotary Position
Embedding", 2021. https://arxiv.org/abs/2104.09864
"""

import torch
from torch import nn


def apply_rotary_pos_emb(x, cos, sin):
    """Rotate paired attention-head channels with precomputed RoPE angles."""
    d_head = x.shape[-1]
    x1 = x[..., : d_head // 2]
    x2 = x[..., d_head // 2 :]
    cos = cos.unsqueeze(0).unsqueeze(1)
    sin = sin.unsqueeze(0).unsqueeze(1)
    rotated_x = torch.cat([x1 * cos - x2 * sin, x1 * sin + x2 * cos], dim=-1)
    return rotated_x


class RotaryEmbedding(nn.Module):
    """Cache and apply rotary position embeddings to attention heads."""
    def __init__(self, dim, base=500):
        super().__init__()
        assert dim % 2 == 0
        self.dim = dim
        self.base = base
        inv_freq = 1.0 / (self.base ** (torch.arange(0, dim, 2).float() / dim))
        self.register_buffer("inv_freq", inv_freq)
        self._cached_cos = None
        self._cached_sin = None

    def forward(self, x):
        seq_len = x.shape[-2]
        if (
            self._cached_cos is None
            or self._cached_cos.shape[0] < seq_len
            or self._cached_cos.device != x.device
            or self._cached_cos.dtype != x.dtype
        ):
            t = torch.arange(seq_len, device=x.device, dtype=self.inv_freq.dtype)
            freqs = torch.einsum("i,j->ij", t, self.inv_freq)
            self._cached_cos = freqs.cos().to(dtype=x.dtype)
            self._cached_sin = freqs.sin().to(dtype=x.dtype)
        return apply_rotary_pos_emb(x, self._cached_cos[:seq_len, :], self._cached_sin[:seq_len, :])
