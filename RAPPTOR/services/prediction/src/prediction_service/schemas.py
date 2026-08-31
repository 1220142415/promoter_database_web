from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


OutputFormat = Literal["bigwig", "parquet", "gff3", "json"]


class JobSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["predict", "genome_scan"]
    complete_genome: Literal[True] = Field(
        description="Confirms that genome_context or fasta contains the complete genome used to calculate CGR."
    )
    sequence: str | None = Field(default=None, description="Target sequence to score in predict mode.")
    genome_context: str | None = Field(
        default=None,
        description="Complete genome sequence used to calculate the model's 128 x 128 CGR context.",
    )
    fasta: str | None = Field(
        default=None,
        description="Complete single-genome assembly FASTA; all records jointly form the CGR context.",
    )
    stride: int | None = Field(default=None, ge=1)
    batch_size: int | None = Field(default=None, ge=1)
    reverse_complementary: bool = True
    output_formats: list[OutputFormat] | None = Field(
        default=None,
        description="Genome scan artifacts to generate. BigWig and Parquet are enabled by default.",
    )

    @model_validator(mode="after")
    def validate_mode_fields(self):
        if self.mode == "predict":
            if self.sequence is None:
                raise ValueError("predict mode requires sequence")
            if self.genome_context is None:
                raise ValueError(
                    "predict mode requires the complete genome in genome_context to calculate CGR"
                )
            if self.fasta is not None:
                raise ValueError("predict mode does not accept fasta")
            if self.output_formats:
                raise ValueError("output_formats is only supported for genome_scan mode")
        else:
            if self.fasta is None:
                raise ValueError("genome_scan mode requires a complete single-genome assembly FASTA to calculate CGR")
            if self.sequence is not None or self.genome_context is not None:
                raise ValueError("genome_scan mode accepts fasta, not sequence/genome_context")
            if self.output_formats is not None:
                if not self.output_formats:
                    raise ValueError("output_formats must contain at least one format")
                if len(set(self.output_formats)) != len(self.output_formats):
                    raise ValueError("output_formats must not contain duplicates")
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
