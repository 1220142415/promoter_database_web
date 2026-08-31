from __future__ import annotations

import json
import os
from typing import Any, Dict, Tuple

import torch

from rapptor.config.schema import ExperimentConfig
from rapptor.models import build_model_variant, canonical_model_type


def _load_payload(model_dir: str) -> tuple[Dict[str, Any], str]:
    """Load the preferred experiment config or the fallback model config."""
    experiment_config = os.path.join(model_dir, "experiment_config.json")
    legacy_config = os.path.join(model_dir, "model_config.json")
    if os.path.exists(experiment_config):
        with open(experiment_config, "r", encoding="utf-8") as handle:
            return json.load(handle), "experiment"
    with open(legacy_config, "r", encoding="utf-8") as handle:
        return json.load(handle), "legacy"


def _load_legacy_payload(model_dir: str) -> Dict[str, Any]:
    """Load optional model metadata used to recover conditioning settings."""
    legacy_config = os.path.join(model_dir, "model_config.json")
    if not os.path.exists(legacy_config):
        return {}
    with open(legacy_config, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _to_experiment_config(payload: Dict[str, Any], payload_kind: str) -> ExperimentConfig:
    """Convert either supported config layout into an ExperimentConfig."""
    if payload_kind == "experiment":
        return ExperimentConfig.from_dict(payload)
    if "baseline_name" in payload:
        raise ValueError("Unsupported model configuration field: baseline_name")
    return ExperimentConfig.from_dict(
        {
            "data": {
                "genome_emb": None,
                "seq_length": payload.get("seq_length", 100),
                "upstream_len": payload.get("upstream_len", 80),
                "downstream_len": payload.get("downstream_len", 20),
                "encoding_type": payload.get("encoding_type", "onehot"),
            },
            "model": {
                "model_type": payload.get("model_type", "rapptor"),
                "d_model": payload["d_model"],
                "conformer_blocks": payload["conformer_blocks"],
                "conformer_heads": payload["conformer_heads"],
                "conformer_conv_kernel": payload["conformer_conv_kernel"],
                "dropout": payload["dropout"],
            },
        }
    )


def _resolve_model_conditioning(payload: Dict[str, Any], payload_kind: str, legacy_payload: Dict[str, Any]) -> Tuple[bool, int]:
    """Determine whether the saved model expects CGR images or vector inputs."""
    if payload_kind == "legacy":
        use_cgr = payload.get("use_cgr_image", False)
        emb_dim = payload.get("genome_emb_dim", 0)
        if isinstance(emb_dim, str):
            emb_dim = 0
        return use_cgr, emb_dim

    if "use_cgr_image" in legacy_payload or "genome_emb_dim" in legacy_payload:
        use_cgr = legacy_payload.get("use_cgr_image", False)
        emb_dim = legacy_payload.get("genome_emb_dim", 0)
        if isinstance(emb_dim, str):
            emb_dim = 0
        return use_cgr, emb_dim

    data_payload = payload.get("data", {})
    has_cgr_path = bool(data_payload.get("genome_emb"))
    return has_cgr_path, 0


def _canonicalize_loaded_model_identity(config: ExperimentConfig, payload_kind: str, use_cgr_image: bool) -> None:
    """Normalize the loaded model type after recovering its conditioning mode."""
    raw_model_type = (getattr(config.model, "model_type", "") or "").strip().lower()

    if payload_kind == "legacy" and raw_model_type == "rapptor" and not use_cgr_image:
        config.model.model_type = "conformer_rope"
        return

    config.model.model_type = canonical_model_type(raw_model_type, use_cgr_image=use_cgr_image)


def load_model_for_inference(model_dir: str, device: str = "cpu") -> Tuple[torch.nn.Module, ExperimentConfig, torch.device]:
    """Build, load, and place a saved model in evaluation mode."""
    payload, payload_kind = _load_payload(model_dir)
    legacy_payload = _load_legacy_payload(model_dir)
    config = _to_experiment_config(payload, payload_kind)
    weights_path = os.path.join(model_dir, "best_model.pt")
    if device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError(
            f"CUDA device {device!r} was requested, but CUDA is not available. "
            "Set device='cpu' explicitly to run on CPU."
        )
    device_obj = torch.device(device)
    use_cgr_image, genome_emb_dim = _resolve_model_conditioning(payload, payload_kind, legacy_payload)

    if not isinstance(genome_emb_dim, int):
        raise TypeError(f"genome_emb_dim must be int, got {type(genome_emb_dim).__name__}: {genome_emb_dim}")

    _canonicalize_loaded_model_identity(config, payload_kind, use_cgr_image)

    model = build_model_variant(
        config.model.model_type,
        n_input_channels=config.model.n_input_channels,
        d_model=config.model.d_model,
        n_blocks=config.model.conformer_blocks,
        n_head=config.model.conformer_heads,
        conv_kernel_size=config.model.conformer_conv_kernel,
        dropout=config.model.dropout,
        use_cgr_image=use_cgr_image,
    )
    config.use_cgr_image = use_cgr_image
    config.genome_emb_dim = genome_emb_dim
    state_dict = torch.load(weights_path, map_location=device_obj)
    state_dict = {key: value for key, value in state_dict.items() if not key.startswith("cgr_only_condition_gen.")}
    model.load_state_dict(state_dict, strict=True)
    model.to(device_obj)
    model.eval()
    return model, config, device_obj


def load_model_for_prediction(model_dir_path: str, device: str):
    """Compatibility wrapper for inference callers."""
    return load_model_for_inference(model_dir_path, device)


def require_genome_emb_for_cgr_model(config: ExperimentConfig, genome_emb: str | None, command_name: str) -> None:
    """Require a CGR image input when the loaded model was trained with CGR conditioning."""
    if getattr(config, "use_cgr_image", False) and not genome_emb:
        raise ValueError(
            f"{command_name} requires --genome-emb when the loaded model was trained with CGR image conditioning."
        )
