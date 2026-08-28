import { predictionErrorResponse } from '@/features/prediction/api-response';
import { demoPredictionCapabilities } from '@/features/prediction/capabilities';
import { demoPredictionProvider, predictionAccessCookie } from '@/features/prediction/runtime';
import type { GenomeContext, PredictionSubmission } from '@/features/prediction/types';
import { PREDICTION_CONTRACT_VERSION } from '@/features/prediction/types';
import { parseDemoPredictionSubmission } from '@/features/prediction/validation';

export async function POST(request: Request) {
  try {
    const capabilities = demoPredictionCapabilities();
    const input = parseDemoPredictionSubmission(await request.json(), capabilities);
    const provider = demoPredictionProvider();
    const ticket = await provider.issueTicket({
      contractVersion: PREDICTION_CONTRACT_VERSION,
      turnstileToken: 'demo-turnstile-bypass',
      modelVersion: capabilities.modelVersion,
      targetBases: input.target.length,
      genomeBytes: input.genomeContext.kind === 'upload' ? input.genomeContext.fileSize : 0,
    });

    let genomeContext: GenomeContext;
    if (input.genomeContext.kind === 'catalog') {
      genomeContext = input.genomeContext;
    } else {
      const upload = await provider.createUpload({
        contractVersion: PREDICTION_CONTRACT_VERSION,
        ticket: ticket.ticket,
        fileName: input.genomeContext.fileName,
        fileSize: input.genomeContext.fileSize,
        sha256: input.genomeContext.sha256,
      });
      genomeContext = {
        kind: 'upload',
        uploadToken: upload.uploadToken,
        fileName: input.genomeContext.fileName,
        fileSize: input.genomeContext.fileSize,
        sha256: input.genomeContext.sha256,
      };
    }

    const submission: PredictionSubmission = {
      contractVersion: PREDICTION_CONTRACT_VERSION,
      predictionKind: 'candidate',
      ticket: ticket.ticket,
      modelVersion: capabilities.modelVersion,
      target: input.target,
      genomeContext,
      strandMode: input.strandMode,
    };
    const created = await provider.createJob(submission);
    const submitted = await provider.submitJob(created.job.jobId, created.accessToken);
    return Response.json(submitted, {
      status: 201,
      headers: {
        'Cache-Control': 'no-store',
        'Set-Cookie': predictionAccessCookie(created.job.jobId, created.accessToken),
      },
    });
  } catch (error) {
    return predictionErrorResponse(error);
  }
}
