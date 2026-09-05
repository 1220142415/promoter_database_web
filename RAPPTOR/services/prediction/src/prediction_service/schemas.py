from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


OutputFormat = Literal["bigwig", "parquet", "gff3", "json"]


class JobSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["predict", "genome_scan"]
    complete_genome: Literal[True] = Field(
        description="Confirms that genome_context or fasta contains the complete genome for CGR."
    )
    sequence: str | None = Field(default=None, description="Target DNA for mode=predict.")
    genome_context: str | None = Field(
        default=None,
        description="Complete genome DNA for the 128 × 128 CGR context.",
    )
    fasta: str | None = Field(
        default=None,
        description="Complete assembly FASTA. All records form one CGR context.",
    )
    stride: int | None = Field(
        default=None,
        ge=1,
        description="Window stride in bp. Limits: /v1/models/current.",
    )
    score_cutoff: float | None = Field(
        default=None,
        ge=0,
        le=1,
        description=(
            "Optional export cutoff for sparse GFF3/JSON records (score > score_cutoff). "
            "BigWig and Parquet keep every window."
        ),
    )
    batch_size: int | None = Field(default=None, ge=1, description="Inference batch size (deployment-limited).")
    reverse_complementary: bool = Field(default=True, description="Scan the reverse-complement strand.")
    output_formats: list[OutputFormat] | None = Field(
        default=None,
        description="Sequence-scan artifacts. Defaults: BigWig and Parquet.",
    )

    @model_validator(mode="after")
    def validate_mode_fields(self):
        if self.mode == "predict":
            if self.sequence is None:
                raise ValueError("For mode=predict, sequence is required.")
            if self.genome_context is None:
                raise ValueError("For mode=predict, genome_context must contain the complete genome.")
            if self.fasta is not None:
                raise ValueError("For mode=predict, omit fasta.")
            if self.output_formats:
                raise ValueError("output_formats is only supported for genome_scan mode.")
            if self.score_cutoff is not None:
                raise ValueError("score_cutoff is only supported for genome_scan mode.")
        else:
            if self.fasta is None:
                raise ValueError("For mode=genome_scan, fasta is required.")
            if self.sequence is not None:
                raise ValueError("For mode=genome_scan, use fasta and omit sequence.")
            if self.output_formats is not None:
                if not self.output_formats:
                    raise ValueError("output_formats must contain at least one format.")
                if len(set(self.output_formats)) != len(self.output_formats):
                    raise ValueError("output_formats must not contain duplicates.")
        return self


class JobCreated(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    job_id: str
    status: Literal["queued"] = "queued"
    access_token: str
    model_version: str
    artifacts_expires_at: str | None = None


class JobStatus(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    job_id: str
    status: Literal["queued", "running", "succeeded", "failed", "unknown"]
    model_version: str | None = None
    progress: dict | None = None
    submitted_at: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    artifacts_expires_at: str | None = None
    result: dict | None = None
    error: dict | None = None
