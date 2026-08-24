// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TrackDownloadDialog from '@/components/track-download-dialog';
import type { TrackDownloadMetadata } from '@/lib/track-download';

const promoterMetadata: TrackDownloadMetadata = {
  kind: 'promoters',
  accession: 'GCA_000411415.1',
  label: 'RAPPTOR predicted promoter peaks',
  regionExportBase: '/api/local-region',
  wholeAssetUrl: '/api/local-data/GCA_000411415.1/predicted-promoters.gff3.gz',
};

const referenceMetadata: TrackDownloadMetadata = {
  kind: 'reference',
  accession: 'GCA_000411415.1',
  label: 'Reference sequence',
  regionExportBase: '/api/local-region',
  wholeAssetUrl: '/api/local-data/GCA_000411415.1/reference.fa.gz',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('track download dialog', () => {
  it('downloads one visible annotation track with a sanitized editable filename', async () => {
    const user = userEvent.setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const handleClose = vi.fn();
    render(
      <TrackDownloadDialog
        handleClose={handleClose}
        metadata={promoterMetadata}
        visibleRegion={{ refName: 'CP003597.1', start: 10, end: 20 }}
      />,
    );

    expect(screen.getByRole('radio', { name: /Visible region/ })).toBeChecked();
    expect(screen.getByLabelText('Download format')).toHaveTextContent('GFF3');
    const filename = screen.getByLabelText('Filename');
    await user.clear(filename);
    await user.type(filename, '../custom name.txt');
    await user.click(screen.getByRole('button', { name: 'Download' }));

    const anchor = click.mock.contexts[0] as unknown as HTMLAnchorElement;
    const url = new URL(anchor.href);
    expect(url.pathname).toBe('/api/local-region/GCA_000411415.1');
    expect(url.searchParams.get('tracks')).toBe('promoters');
    expect(url.searchParams.get('filename')).toBe('custom_name.gff3');
    expect(anchor.download).toBe('custom_name.gff3');
    expect(handleClose).toHaveBeenCalledOnce();
  });

  it('switches to the complete compressed track and resets the filename extension', async () => {
    const user = userEvent.setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(
      <TrackDownloadDialog
        handleClose={vi.fn()}
        metadata={promoterMetadata}
        visibleRegion={{ refName: 'CP003597.1', start: 10, end: 20 }}
      />,
    );

    await user.click(screen.getByRole('radio', { name: 'Whole assembly' }));
    expect(screen.getByLabelText('Filename')).toHaveValue('RAPPTOR-promoters_GCA_000411415.1.gff3.gz');
    await user.click(screen.getByRole('button', { name: 'Download' }));

    const anchor = click.mock.contexts[0] as unknown as HTMLAnchorElement;
    const url = new URL(anchor.href);
    expect(url.pathname).toContain('/predicted-promoters.gff3.gz');
    expect(url.searchParams.get('filename')).toBe('RAPPTOR-promoters_GCA_000411415.1.gff3.gz');
  });

  it('defaults to a whole FASTA download when the view spans reference sequences', () => {
    render(
      <TrackDownloadDialog
        handleClose={vi.fn()}
        metadata={referenceMetadata}
        visibleRegion={null}
      />,
    );

    expect(screen.getByRole('radio', { name: /Visible region/ })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Whole assembly' })).toBeChecked();
    expect(screen.getByLabelText('Download format')).toHaveTextContent('FASTA');
    expect(screen.getByLabelText('Filename')).toHaveValue('reference_GCA_000411415.1.fa.gz');
  });

  it('cancels without creating a download', async () => {
    const user = userEvent.setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const handleClose = vi.fn();
    render(
      <TrackDownloadDialog
        handleClose={handleClose}
        metadata={promoterMetadata}
        visibleRegion={{ refName: 'CP003597.1', start: 10, end: 20 }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(click).not.toHaveBeenCalled();
    expect(handleClose).toHaveBeenCalledOnce();
  });

  it('creates a visible-region download from browser-prepared data', async () => {
    const user = userEvent.setup();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const handleClose = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => ({
        text: async () => '##gff-version 3\ncontig_1\tRAPPtor\tpromoter\t5\t5\t.\t+\t.\tID=p1\n',
      } as Blob),
    }));
    class MockUrl extends URL {
      static createObjectURL = vi.fn(() => 'blob:visible-export');
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', MockUrl);
    render(
      <TrackDownloadDialog
        handleClose={handleClose}
        metadata={{ ...promoterMetadata, wholeAssetUrl: 'blob:promoters', downloadMode: 'browser' }}
        visibleRegion={{ refName: 'contig_1', start: 1, end: 10 }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    const anchor = click.mock.contexts[0] as unknown as HTMLAnchorElement;
    expect(anchor.href).toBe('blob:visible-export');
    expect(anchor.download).toBe('RAPPTOR-promoters_GCA_000411415.1_contig_1_1-10.gff3');
    expect(handleClose).toHaveBeenCalledOnce();
  });
});
