import torch
from torch import nn

class ConformerConvModule(nn.Module):
    """An efficient convolution module, a core component of Conformer"""
    def __init__(self, d_model, kernel_size=15, dropout=0.1):
        super().__init__()
        self.layer_norm = nn.LayerNorm(d_model)
        self.conv1 = nn.Conv1d(d_model, d_model * 2, kernel_size=1)
        self.glu = nn.GLU(dim=1)
        padding = (kernel_size - 1) // 2
        self.depthwise_conv = nn.Conv1d(d_model, d_model, kernel_size, padding=padding, groups=d_model)
        self.batch_norm = nn.BatchNorm1d(d_model)
        self.silu = nn.SiLU()
        self.conv2 = nn.Conv1d(d_model, d_model, kernel_size=1)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x):
        # x shape: (B, L, D)
        x = self.layer_norm(x)
        x = x.transpose(1, 2) # (B, L, D) -> (B, D, L)
        x = self.conv1(x)
        x = self.glu(x)
        x = self.depthwise_conv(x)
        x = self.batch_norm(x)
        x = self.silu(x)
        x = self.conv2(x)
        x = self.dropout(x)
        x = x.transpose(1, 2) # (B, D, L) -> (B, L, D)
        return x

class FiLMLayer(nn.Module):
    """Feature-wise linear modulation of sequence features.

    Based on Perez et al., "FiLM: Visual Reasoning with a General
    Conditioning Layer", AAAI 2018.
    https://doi.org/10.1609/aaai.v32i1.11671
    """
    def __init__(self, input_dim, condition_dim):
        super().__init__()
        self.projection = nn.Linear(condition_dim, 2 * input_dim)
        nn.init.zeros_(self.projection.weight)
        nn.init.zeros_(self.projection.bias)

    def forward(self, x, condition):
        # x: [Batch, Length, input_dim]
        # condition: [Batch, condition_dim]
        params = self.projection(condition)
        gamma, beta = params.chunk(2, dim=-1)
        gamma = gamma.unsqueeze(1)
        beta = beta.unsqueeze(1)
        return x * (1 + gamma) + beta
