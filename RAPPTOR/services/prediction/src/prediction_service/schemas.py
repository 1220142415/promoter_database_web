from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


OutputFormat = Literal["bigwig", "parquet", "gff3", "json"]


class JobSubmission(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["predict", "genome_scan"]
    complete_genome: Literal[True] = Field(
        description="Confirms that the selected reference, genome_context, or fasta is a complete genome."
    )
    sequence: str | None = Field(default=None, description="Target DNA for mode=predict.")
    genome_context: str | None = Field(
        default=None,
        description="Complete genome DNA for the 128 × 128 CGR context.",
    )
    reference_accession: str | None = Field(
        default=None,
        pattern=r"^GCF_[0-9]{9}\.[0-9]+$",
        description="Accession of a server-side precomputed genome CGR.",
    )
    fasta: str | None = Field(
        default=None,
        description="Complete assembly FASTA. All records form one CGR context.",
    )
    cgr_png_base64: str | None = Field(
        default=None,
        description="Optional 128x128 CGR PNG for a custom genome context. Never used with reference_accession.",
    )
    stride: int | None = Field(
        default=None,
        ge=1,
        description="Bases between adjacent genome-scan windows; deployment limits are published by /v1/models/current.",
    )
    score_cutoff: float | None = Field(
        default=None,
        ge=0,
        le=1,
        description=(
            "Optional strict score cutoff for sparse GFF3/JSON records. "
            "BigWig and Parquet always retain every scanned window."
        ),
    )
    batch_size: int | None = Field(default=None, ge=1, description="Inference tuning parameter bounded by the deployment.")
    reverse_complementary: bool = Field(default=True, description="Also scan the reverse-complement strand.")
    output_formats: list[OutputFormat] | None = Field(
        default=None,
        description="Sequence-scan artifacts. Defaults: BigWig and Parquet.",
    )

    @model_validator(mode="after")
    def validate_mode_fields(self):
        if self.mode == "predict":
            if self.sequence is None:
                raise ValueError("For mode=predict, sequence is required.")
            sources = (self.genome_context, self.reference_accession, self.fasta)
            if sum(value is not None for value in sources) != 1:
                raise ValueError("For mode=predict, provide exactly one of genome_context, reference_accession, or fasta.")
            if self.reference_accession is not None and self.cgr_png_base64 is not None:
                raise ValueError("Catalog references use the server CGR cache; omit cgr_png_base64.")
            if self.output_formats:
                raise ValueError("output_formats is only supported for genome_scan mode.")
            if self.score_cutoff is not None:
                raise ValueError("score_cutoff is only supported for genome_scan mode.")
        else:
            if self.fasta is None:
                raise ValueError("For mode=genome_scan, fasta is required.")
            if (
                self.sequence is not None
                or self.genome_context is not None
                or self.reference_accession is not None
                or self.cgr_png_base64 is not None
            ):
                raise ValueError(
                    "For mode=genome_scan, use fasta and omit sequence/genome_context/reference_accession."
                )
            if self.output_formats is not None:
                if not self.output_formats:
                    raise ValueError("output_formats must contain at least one format.")
                if len(set(self.output_formats)) != len(self.output_formats):
                    raise ValueError("output_formats must not contain duplicates.")
        return self


class JobQueueStatus(BaseModel):
    ahead: int | None = None
    estimated_wait_seconds: int | None = Field(default=None, ge=0)
    waiting: int | None = None
    running: int | None = None
    worker_ready: bool | None = None
    total_waiting: int | None = None
    waiting_by_mode: dict[str, int] | None = None


class JobCreated(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    job_id: str
    status: Literal["queued"] = "queued"
    access_token: str
    model_version: str
    artifacts_expires_at: str | None = None
    queue: JobQueueStatus
    status_url: str
    poll_after_seconds: int = 3


class JobStatus(BaseModel):
    model_config = ConfigDict(protected_namespaces=())
    job_id: str
    status: Literal["queued", "running", "succeeded", "failed", "unknown"]
    mode: Literal["predict", "genome_scan"] | None = None
    input_bases: int | None = None
    model_version: str | None = None
    progress: dict | None = None
    submitted_at: str | None = None
    started_at: str | None = None
    ended_at: str | None = None
    artifacts_expires_at: str | None = None
    queue: JobQueueStatus
    result: dict | None = None
    error: dict | None = None


class ReferenceCacheQuery(BaseModel):
    accessions: list[str] = Field(min_length=1, max_length=100)


class ReferenceCacheStatus(BaseModel):
    accession: str
    status: Literal["ready", "missing", "preparing", "invalid"]
    cgr_version: str
    source_sha256: str | None = None


class ReferenceCacheQueryResult(BaseModel):
    entries: list[ReferenceCacheStatus]


class ReferenceCacheImportStatus(BaseModel):
    import_id: str | None = None
    accession: str
    status: Literal["preparing", "ready", "failed"]
    cgr_version: str
    source_sha256: str
    cgr_sha256: str
    error: dict | None = None
