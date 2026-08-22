import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import RemoveCircleOutlineRoundedIcon from '@mui/icons-material/RemoveCircleOutlineRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';

export type GenomeFileState = 'available' | 'preparing' | 'unavailable' | 'failed' | 'incompatible';

type Props = {
  states: {
    reference: GenomeFileState;
    promoters: GenomeFileState;
    annotation: GenomeFileState;
  };
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

export default function GenomeFileStatus({ states }: Props) {
  const files = [
    { label: 'Reference', state: states.reference },
    { label: 'Promoters', state: states.promoters },
    { label: 'Annotation', state: states.annotation },
  ];

  return (
    <div className="genome-file-status" aria-label="Genome files">
      {files.map(({ label, state }) => {
        const Icon = stateIcons[state];
        return (
          <span className={`genome-file-state genome-file-state-${state}`} key={label}>
            <Icon aria-hidden="true" fontSize="small" />
            <span>{label}</span>
            <strong>{stateLabels[state]}</strong>
          </span>
        );
      })}
    </div>
  );
}
