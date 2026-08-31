from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Optional


@dataclass
class DataConfig:
    """Input paths, sequence geometry, and sampling settings."""
    train_positive: str = ""
    train_negative: str = ""
    val_positive: Optional[str] = None
    val_negative: Optional[str] = None
    test_positive: Optional[str] = None
    test_negative: Optional[str] = None
    val_fraction: float = 0.0
    genome_emb: Optional[str] = None
    upstream_len: int = 80
    downstream_len: int = 20
    seq_length: int = 100
    encoding_type: str = "onehot"
    stratified: bool = True
    train_neg_ratio: float = 1.0
    test_neg_ratio: float = 10.0


@dataclass
class ModelConfig:
    """Architecture settings for a canonical model variant."""
    model_type: str = "rapptor"
    d_model: int = 128
    conformer_blocks: int = 4
    conformer_heads: int = 4
    conformer_conv_kernel: int = 15
    dropout: float = 0.1
    n_input_channels: int = 4


@dataclass
class TrainConfig:
    """Optimization, scheduling, and early-stopping settings."""
    epochs: int = 25
    batch_size: int = 256
    learning_rate: float = 5e-4
    optimizer: str = "adamw"
    weight_decay: float = 0.01
    use_scheduler: bool = False
    warmup_epochs: int = 5
    num_workers: int = 4
    seed: int = 42
    patience: int = 7
    pretrained: Optional[str] = None
    freeze_cgr: bool = False
    checkpoint_selection: str = "validation_auprc"


@dataclass
class RuntimeConfig:
    """Device and data-transfer settings."""
    device: str = "cuda:0"
    pin_memory: bool = True


@dataclass
class OutputConfig:
    """Names and locations of persisted training artifacts."""
    model_dir: str = "rapptor_outputs/default_run"
    save_name: str = "best_model.pt"
    final_name: str = "final_model.pt"
    config_name: str = "experiment_config.json"
    legacy_config_name: str = "model_config.json"
    metrics_name: str = "training_metrics.csv"


@dataclass
class ExperimentConfig:
    """Top-level serializable configuration for one RAPPtor run."""
    data: DataConfig = field(default_factory=DataConfig)
    model: ModelConfig = field(default_factory=ModelConfig)
    train: TrainConfig = field(default_factory=TrainConfig)
    runtime: RuntimeConfig = field(default_factory=RuntimeConfig)
    output: OutputConfig = field(default_factory=OutputConfig)

    def to_dict(self) -> Dict[str, Any]:
        """Return the configuration as nested plain dictionaries."""
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "ExperimentConfig":
        """Build a configuration from serialized values and reject removed fields."""
        model_payload = dict(payload.get("model", {}))
        model_payload.pop("use_self_cond", None)
        if "baseline_name" in model_payload:
            raise ValueError("Unsupported model configuration field: baseline_name")
        cfg = cls(
            data=DataConfig(**payload.get("data", {})),
            model=ModelConfig(**model_payload),
            train=TrainConfig(**payload.get("train", {})),
            runtime=RuntimeConfig(**payload.get("runtime", {})),
            output=OutputConfig(**payload.get("output", {})),
        )
        cfg.data.seq_length = cfg.data.upstream_len + cfg.data.downstream_len
        return cfg
