'use client';

import { useMemo, useState } from 'react';
import DownloadRoundedIcon from '@mui/icons-material/DownloadRounded';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  FormLabel,
  Radio,
  RadioGroup,
  TextField,
} from '@mui/material';
import {
  defaultTrackDownloadFilename,
  normalizeDownloadFilename,
  regionTrackDownloadUrl,
  trackDownloadSettings,
  wholeTrackDownloadUrl,
  type TrackDownloadMetadata,
  type TrackDownloadRegion,
  type TrackDownloadScope,
} from '@/lib/track-download';

export interface TrackDownloadDialogProps {
  handleClose: () => void;
  metadata: TrackDownloadMetadata;
  visibleRegion: TrackDownloadRegion | null;
}

function scopeLabel(region: TrackDownloadRegion | null) {
  return region
    ? `Visible region — ${region.refName}:${region.start.toLocaleString()}-${region.end.toLocaleString()}`
    : 'Visible region — unavailable across multiple reference sequences';
}

export default function TrackDownloadDialog({ handleClose, metadata, visibleRegion }: TrackDownloadDialogProps) {
  const initialScope: TrackDownloadScope = visibleRegion ? 'visible' : 'whole';
  const [scope, setScope] = useState<TrackDownloadScope>(initialScope);
  const [filename, setFilename] = useState(() => defaultTrackDownloadFilename(metadata, initialScope, visibleRegion));
  const settings = trackDownloadSettings(metadata.kind);
  const requiredExtension = scope === 'visible' ? settings.regionExtension : settings.wholeExtension;
  const fallbackFilename = useMemo(
    () => defaultTrackDownloadFilename(metadata, scope, visibleRegion),
    [metadata, scope, visibleRegion],
  );

  const changeScope = (nextScope: TrackDownloadScope) => {
    if (nextScope === 'visible' && !visibleRegion) return;
    setScope(nextScope);
    setFilename(defaultTrackDownloadFilename(metadata, nextScope, visibleRegion));
  };

  const download = () => {
    const safeFilename = normalizeDownloadFilename(filename, requiredExtension, fallbackFilename);
    const url = scope === 'visible' && visibleRegion
      ? regionTrackDownloadUrl(metadata, visibleRegion, safeFilename)
      : wholeTrackDownloadUrl(metadata, safeFilename);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeFilename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    handleClose();
  };

  return (
    <Dialog open onClose={handleClose} fullWidth maxWidth="sm" aria-labelledby="track-download-title">
      <DialogTitle id="track-download-title">Download track data</DialogTitle>
      <DialogContent className="track-download-dialog">
        <p className="track-download-track-name">{metadata.label}</p>
        <FormControl component="fieldset" className="track-download-fieldset">
          <FormLabel component="legend">Region to save</FormLabel>
          <RadioGroup
            value={scope}
            onChange={(event) => changeScope(event.target.value as TrackDownloadScope)}
          >
            <FormControlLabel
              value="visible"
              disabled={!visibleRegion}
              control={<Radio size="small" />}
              label={scopeLabel(visibleRegion)}
            />
            <FormControlLabel
              value="whole"
              control={<Radio size="small" />}
              label="Whole assembly"
            />
          </RadioGroup>
        </FormControl>

        <div className="track-download-format" aria-label="Download format">
          <span>Format</span>
          <strong>{settings.format === 'fasta' ? 'FASTA' : 'GFF3'}</strong>
        </div>

        <TextField
          label="Filename"
          value={filename}
          onChange={(event) => setFilename(event.target.value)}
          fullWidth
          size="small"
          helperText={`The downloaded file will use ${requiredExtension}. Unsupported characters are replaced.`}
          inputProps={{ maxLength: 220 }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} color="inherit">Cancel</Button>
        <Button onClick={download} variant="contained" startIcon={<DownloadRoundedIcon />}>Download</Button>
      </DialogActions>
    </Dialog>
  );
}
