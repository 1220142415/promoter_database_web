import torch
from torch import nn
from .layers import ConformerConvModule
from .attention import UnifiedMultiheadAttention

class UnifiedConformerBlock(nn.Module):
    """Conformer block: FFN, attention, convolution, FFN, and normalization.

    Based on Gulati et al., "Conformer: Convolution-augmented Transformer for
    Speech Recognition", Interspeech 2020.
    https://doi.org/10.21437/Interspeech.2020-3015
    """
    def __init__(
        self,
        d_model,
        n_head,
        conv_kernel_size=15,
        dropout=0.1,
        attention_type="rope",
    ):
        super().__init__()

        self.ff_module1 = nn.Sequential(
            nn.LayerNorm(d_model),
            nn.Linear(d_model, d_model * 4),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(d_model * 4, d_model),
            nn.Dropout(dropout)
        )

        self.attention_module = nn.Sequential(
            nn.LayerNorm(d_model),
            UnifiedMultiheadAttention(
                d_model,
                n_head,
                dropout,
                attention_type=attention_type,
            )
        )

        self.conv_module = ConformerConvModule(d_model, conv_kernel_size, dropout)

        self.ff_module2 = nn.Sequential(
            nn.LayerNorm(d_model),
            nn.Linear(d_model, d_model * 4),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(d_model * 4, d_model),
            nn.Dropout(dropout)
        )

        self.layer_norm_out = nn.LayerNorm(d_model)

    def forward(self, x, return_attn: bool = False):
        x = x + 0.5 * self.ff_module1(x)
        if return_attn:
            attn_in = self.attention_module[0](x)
            attn_out, attn_weights = self.attention_module[1](attn_in, return_attn=True)
            x = x + attn_out
        else:
            x = x + self.attention_module(x)
            attn_weights = None
        x = x + self.conv_module(x)
        x = x + 0.5 * self.ff_module2(x)
        x = self.layer_norm_out(x)
        if return_attn:
            return x, attn_weights
        return x
