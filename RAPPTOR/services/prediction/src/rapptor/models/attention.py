import torch
from torch import nn
import math
from .embeddings import RotaryEmbedding

class UnifiedMultiheadAttention(nn.Module):
    """Multi-head self-attention with optional rotary position encoding."""

    def __init__(self, d_model, n_head, dropout=0.1, attention_type="rope"):
        super().__init__()
        assert d_model % n_head == 0
        if attention_type not in {"rope", "vanilla"}:
            raise ValueError(f"Unsupported attention_type: {attention_type}")
        self.d_model = d_model
        self.n_head = n_head
        self.d_head = d_model // n_head
        self.attention_type = attention_type

        self.qkv_linear = nn.Linear(d_model, d_model * 3)
        self.out_linear = nn.Linear(d_model, d_model)
        self.dropout = nn.Dropout(dropout)
        self.rope = RotaryEmbedding(dim=self.d_head) if attention_type == "rope" else None

    def forward(self, x, return_attn: bool = False):
        B, L, D = x.shape
        qkv = self.qkv_linear(x).chunk(3, dim=-1)
        q, k, v = map(
            lambda tensor: tensor.view(B, L, self.n_head, self.d_head).transpose(1, 2),
            qkv,
        )
        if self.rope is not None:
            q = self.rope(q)
            k = self.rope(k)

        scores = torch.matmul(q, k.transpose(-2, -1)) / math.sqrt(self.d_head)
        attn_weights = self.dropout(torch.softmax(scores, dim=-1))
        output = torch.matmul(attn_weights, v)
        output = output.transpose(1, 2).contiguous().view(B, L, D)
        output = self.out_linear(output)

        if return_attn:
            return output, attn_weights
        return output
