import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import RemoveCircleOutlineRoundedIcon from '@mui/icons-material/RemoveCircleOutlineRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import CircularProgress from '@mui/material/CircularProgress';

export type GenomeFileState = 'available' | 'preparing' | 'unavailable' | 'failed' | 'incompatible';
export type GenomeFileKind = 'reference' | 'promoters' | 'scores' | 'experimentalTss' | 'annotation';
export type GenomeFileProgress = { label: string; value?: number };

type Props = {
  states: Record<Exclude<GenomeFileKind, 'scores' | 'experimentalTss'>, GenomeFileState> & { scores?: GenomeFileState; experimentalTss?: GenomeFileState };
  progress?: Partial<Record<GenomeFileKind, GenomeFileProgress>>;
};

const stateLabels: Record<GenomeFileState, string> = {
  available: 'Available',
  preparing: 'Preparing',
  unavailable: 'Not available',
  failed: 'Failed',
  incompatible: 'incompatible',
};

const stateIcons = {
  available: CheckCircleRoundedIcon,
  preparing: ScheduleRoundedIcon,
  unavailable: RemoveCircleOutlineRoundedIcon,
  failed: ErrorOutlineRoundedIcon,
  incompatible: ErrorOutlineRoundedIcon,
};

export default function GenomeFileStatus({ states, progress = {} }: Props) {
  const files = [
    { kind: 'reference' as const, label: 'Reference', state: states.reference },
    { kind: 'promoters' as const, label: 'Promoters', state: states.promoters },
    ...(states.scores ? [{ kind: 'scores' as const, label: 'Scores', state: states.scores }] : []),
    ...(states.experimentalTss ? [{ kind: 'experimentalTss' as const, label: 'Experimental TSS', state: states.experimentalTss }] : []),
    { kind: 'annotation' as const, label: 'Annotation', state: states.annotation },
  ];

  return (
    <div className="genome-file-status" aria-label="Genome files">
      <div className="genome-file-status-items">
        {files.map(({ kind, label, state }) => {
          const Icon = stateIcons[state];
          const currentProgress = progress[kind];
          const statusLabel = currentProgress && state === 'preparing'
            ? currentProgress.label
            : stateLabels[state];
          return (
            <span className={`genome-file-state genome-file-state-${state}`} key={label}>
              {state === 'preparing'
                ? <CircularProgress
                    aria-label={`${label}: ${statusLabel}`}
                    size={18}
                    thickness={5}
                    variant={currentProgress?.value === undefined ? 'indeterminate' : 'determinate'}
                    value={currentProgress?.value}
                  />
                : <Icon aria-hidden="true" fontSize="small" />}
              <span>{label}</span>
              <strong>{statusLabel}</strong>
            </span>
          );
        })}
      </div>
      <div className="genome-file-status-share" data-testid="genome-file-status-share" />
    </div>
  );
}
