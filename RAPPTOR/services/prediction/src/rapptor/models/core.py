import torch
from torch import nn
from .layers import FiLMLayer
from .blocks import UnifiedConformerBlock


def validate_model_geometry(d_model, n_head, conv_kernel_size, attention_type):
    """Reject dimensions that cannot form the requested Conformer variant."""
    if d_model <= 0:
        raise ValueError("d_model must be positive")
    if n_head <= 0:
        raise ValueError("n_head must be positive")
    if d_model % n_head != 0:
        raise ValueError("d_model must be divisible by n_head")
    if attention_type == "rope" and (d_model // n_head) % 2 != 0:
        raise ValueError("RoPE requires an even attention-head dimension (d_model / n_head)")
    if conv_kernel_size <= 0 or conv_kernel_size % 2 == 0:
        raise ValueError("conv_kernel_size must be a positive odd integer")


# ==============================================================================
#   CGR encoder and conditioning modules
# ==============================================================================
# ==============================================================================
#   Encoder 3: FNet (Fourier Network) - The "Spectral" Approach
# ==============================================================================


class HybridConditionGenerator(nn.Module):
    def __init__(self, seq_dim, cgr_dim, film_dim):
        super().__init__()

        # Combined dimension after concatenation
        total_in_dim = seq_dim + cgr_dim

        # Core structure: Concat -> Norm -> MLP
        self.net = nn.Sequential(
            # LayerNorm is critical here to align scale between CGR and sequence features
            nn.LayerNorm(total_in_dim),

            # Bottleneck layer to compress and filter noise
            nn.Linear(total_in_dim, film_dim // 2),
            nn.GELU(),

            nn.Dropout(0.2),

            # Final projection to FiLM parameter dimension
            nn.Linear(film_dim // 2,  film_dim)
        )

    def forward(self, seq_feat, cgr_feat):
        # seq_feat: [Batch, seq_dim]
        # cgr_feat: [Batch, cgr_dim]

        # Simple concatenation
        cat_feat = torch.cat([seq_feat, cgr_feat], dim=-1)

        # MLP fusion
        return self.net(cat_feat)

class FNetBlock(nn.Module):
    """FNet-style Fourier mixing followed by a feed-forward network.

    Based on Lee-Thorp et al., "FNet: Mixing Tokens with Fourier Transforms",
    NAACL 2022. https://doi.org/10.18653/v1/2022.naacl-main.319
    """
    def __init__(self, dim, mlp_ratio=4.0, dropout=0.3):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim)
        self.norm2 = nn.LayerNorm(dim)

        # Standard MLP
        self.mlp = nn.Sequential(
            nn.Linear(dim, int(dim * mlp_ratio)),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(int(dim * mlp_ratio), dim),
            nn.Dropout(dropout)
        )

    def forward(self, x):
        # x: [Batch, Num_Patches, Dim]

        # 1. Fourier Mixing (parameter-free)
        # Convert to frequency domain and take real part
        # FFT over both (Num_Patches, Dim) achieves global receptive field
        x_fft = torch.fft.fftn(x, dim=(1, 2)).real

        x = self.norm1(x + x_fft)

        # 2. Feed Forward
        x = self.norm2(x + self.mlp(x))

        return x

class CGRFNet(nn.Module):
    """
    Frequency-domain CGR encoder using FNet architecture.
    Extremely lightweight and well-suited for fractal/signal analysis.
    """
    def __init__(self, output_dim=128, img_size=128, patch_size=16,
                 hidden_dim=128, depth=4):
        super().__init__()

        assert img_size % patch_size == 0
        self.num_patches = (img_size // patch_size) ** 2

        # 1. Patch embedding (like Mixer, convert image to sequence)
        self.patch_embed = nn.Conv2d(1, hidden_dim, kernel_size=patch_size, stride=patch_size)

        # 2. FNet blocks
        self.blocks = nn.ModuleList([
            FNetBlock(dim=hidden_dim, mlp_ratio=2.0, dropout=0.3)
            for _ in range(depth)
        ])

        # 3. Projection head
        self.norm = nn.LayerNorm(hidden_dim)
        self.head = nn.Linear(hidden_dim, output_dim)

    def forward(self, x):
        # x: [B, 1, 128, 128]

        # [B, hidden_dim, 8, 8] -> [B, 64, hidden_dim]
        x = self.patch_embed(x).flatten(2).transpose(1, 2)

        for blk in self.blocks:
            x = blk(x)

        x = self.norm(x)
        x = x.mean(dim=1)  # Global pooling
        x = self.head(x)
        return x

# ==============================================================================
#   Main Model Class
# ==============================================================================

class PromoterModel(nn.Module):
    """
    Configurable Promoter Classifier

    """
    def __init__(self, n_input_channels=4, d_model=128, n_blocks=4, n_head=4,
                 conv_kernel_size=15, dropout=0.1, use_cgr_image=True,
                 attention_type="rope"):
        super().__init__()
        validate_model_geometry(d_model, n_head, conv_kernel_size, attention_type)

        self.use_cgr_image = use_cgr_image
        self.attention_type = attention_type

        kernel_size = 5
        padding_size = kernel_size // 2

        self.conv_in = nn.Conv1d(n_input_channels, d_model, kernel_size=kernel_size, padding=padding_size)

        if self.use_cgr_image:
            self.cgr_encoder = CGRFNet(
                output_dim=d_model, img_size=128, patch_size=16, hidden_dim=d_model, depth=4
            )
            self.condition_gen = HybridConditionGenerator(
                seq_dim=d_model, cgr_dim=d_model, film_dim=d_model
            )
            self.film_layer = FiLMLayer(input_dim=d_model, condition_dim=d_model)


        self.conformer_blocks = nn.ModuleList([
            UnifiedConformerBlock(
                d_model,
                n_head,
                conv_kernel_size,
                dropout,
                attention_type=attention_type,
            )
            for _ in range(n_blocks)
        ])
        self.layer_norm_out = nn.LayerNorm(d_model)
        self.fc_out = nn.Linear(d_model, 2)


    def forward(self, x, genome_emb=None, return_embedding=False, return_attn: bool = False):
        if self.use_cgr_image and genome_emb is None:
            raise ValueError("RAPPtor requires a CGR image when use_cgr_image=True")

        x = self.conv_in(x)
        x = x.transpose(1, 2)


        if self.use_cgr_image:
            cgr_features = self.cgr_encoder(genome_emb)
            condition = self.condition_gen(x.mean(dim=1), cgr_features)
            x = self.film_layer(x, condition)

        attn_maps = {} if return_attn else None
        for idx, block in enumerate(self.conformer_blocks):
            if return_attn:
                x, attn_weights = block(x, return_attn=True)
                attn_maps[idx] = attn_weights
            else:
                x = block(x)

        x = self.layer_norm_out(x)
        embedding_vector = x.mean(dim=1)


        logits = self.fc_out(embedding_vector)
        if return_attn:
            if return_embedding:
                return logits, embedding_vector, attn_maps
            return logits, attn_maps

        if return_embedding:
            return logits, embedding_vector

        return logits
