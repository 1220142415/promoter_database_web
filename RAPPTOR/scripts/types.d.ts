declare module '../../scripts/huggingface/prepare-hf-pilot.mjs' {
  export function prepareHfPilot(options: {
    projectRoot: string;
    release: string;
    accessions: string[];
  }): Promise<{
    targetRoot: string;
    release: string;
    accessions: string[];
    objectFiles: number;
    objectBytes: number;
  }>;
}

declare module '../../scripts/huggingface/create-upload-plan.mjs' {
  export function createUploadPlan(options: { projectRoot: string; release: string; repo: string }): Promise<{ output: string; plan: unknown }>;
}

declare module '../../scripts/data/build-packed-release.mjs' {
  export function planShardPacks(entries: Array<{
    accession: string;
    file: string;
    shard: string;
    bytes: number;
    sha256: string;
  }>, options?: {
    releaseId?: string;
    targetBytes?: number;
    maxBytes?: number;
  }): Array<{
    part: number;
    path: string;
    bytes: number;
    entries: Array<{
      accession: string;
      file: string;
      shard: string;
      bytes: number;
      sha256: string;
      offset: number;
    }>;
  }>;
}
