"""Canonical RAPPTOR model variants.

The public variants match the retained benchmark labels and architectures.
"""

from __future__ import annotations

from .core import PromoterModel


_MODEL_VARIANT_KWARGS = {
    "conformer": {
        "use_cgr_image": False,
        "attention_type": "vanilla",
    },
    "rapptor": {
        "use_cgr_image": True,
        "attention_type": "rope",
    },
    "conformer_rope": {
        "use_cgr_image": False,
        "attention_type": "rope",
    },
}


def canonical_model_type(model_type: str | None, use_cgr_image: bool | None = None) -> str:
    normalized = (model_type or "").strip().lower()
    if normalized in _MODEL_VARIANT_KWARGS:
        return normalized
    if normalized == "rapptor_cgr":
        return "rapptor"
    if not normalized:
        return "rapptor" if use_cgr_image else "conformer_rope"
    raise KeyError(
        f"Unknown model type {model_type}. Available public names: "
        "[conformer, conformer_rope, rapptor]"
    )


def build_model_variant(model_type: str, **model_kwargs):
    canonical_type = canonical_model_type(
        model_type,
        use_cgr_image=model_kwargs.get("use_cgr_image"),
    )
    return PromoterModel(**{**model_kwargs, **_MODEL_VARIANT_KWARGS[canonical_type]})
