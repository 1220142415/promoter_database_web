'use client';

import { useMemo } from 'react';
import { createViewState, JBrowseLinearGenomeView } from '@jbrowse/react-linear-genome-view';
import SeqEdgeTrackDownloadPlugin from '@/jbrowse/track-download-plugin';
import { visibleTrackRegion, type TrackDownloadMetadata } from '@/lib/track-download';
import type { JBrowseReleaseAssembly } from '@/types/release';

export interface BrowserRegion {
  refName: string;
  start: number;
  end: number;
}

function resolveAsset(base: string, path: string) {
  if (/^https?:\/\//i.test(path) || path.startsWith('/')) return path;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export default function PortalJBrowseViewer({ assembly, onRegionChange }: { assembly: JBrowseReleaseAssembly; onRegionChange?: (region: BrowserRegion) => void }) {
  const viewState = useMemo(() => {
    const regionExportBase = assembly.regionExportBase || '/api/local-region';
    const downloadMetadata = (
      kind: TrackDownloadMetadata['kind'],
      label: string,
      wholeAssetUrl: string,
    ): { seqEdgeDownload: TrackDownloadMetadata } => ({
      seqEdgeDownload: {
        kind,
        accession: assembly.assemblyName,
        label,
        regionExportBase,
        wholeAssetUrl,
      },
    });
    const predictedTrackId = `${assembly.assemblyName}-predicted-promoters`;
    const tracks: Array<Record<string, unknown>> = [
      {
        trackId: predictedTrackId,
        name: 'RAPPtor predicted promoter peaks',
        metadata: downloadMetadata(
          'promoters',
          'RAPPtor predicted promoter peaks',
          resolveAsset(assembly.assetBase, assembly.assets.predictedPromoters),
        ),
        assemblyNames: [assembly.assemblyName],
        type: 'FeatureTrack',
        adapter: {
          type: 'Gff3TabixAdapter',
          gffGzLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.predictedPromoters) },
          index: {
            indexType: 'TBI',
            location: { uri: resolveAsset(assembly.assetBase, assembly.assets.predictedPromotersIndex) },
          },
        },
        displays: [{ displayId: `${predictedTrackId}-display`, type: 'LinearBasicDisplay' }],
      },
    ];

    if (assembly.assets.ncbiAnnotations && assembly.assets.ncbiAnnotationsIndex) {
      const ncbiTrackId = `${assembly.assemblyName}-ncbi-annotations`;
      tracks.push({
        trackId: ncbiTrackId,
        name: 'NCBI genome annotation',
        metadata: downloadMetadata(
          'ncbi',
          'NCBI genome annotation',
          resolveAsset(assembly.assetBase, assembly.assets.ncbiAnnotations),
        ),
        assemblyNames: [assembly.assemblyName],
        type: 'FeatureTrack',
        adapter: {
          type: 'Gff3TabixAdapter',
          gffGzLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.ncbiAnnotations) },
          index: {
            indexType: 'TBI',
            location: { uri: resolveAsset(assembly.assetBase, assembly.assets.ncbiAnnotationsIndex) },
          },
        },
        displays: [{ displayId: `${ncbiTrackId}-display`, type: 'LinearBasicDisplay' }],
      });
    }

    const sessionTracks = tracks.map((track) => ({
      type: track.type,
      configuration: track.trackId,
      displays: (track.displays as Array<{ displayId: string; type: string }>).map((display) => ({
        type: display.type,
        configuration: display.displayId,
      })),
    }));

    const stateTree = createViewState({
      assembly: {
        name: assembly.assemblyName,
        sequence: {
          type: 'ReferenceSequenceTrack',
          trackId: `${assembly.assemblyName}-reference-sequence`,
          name: 'Reference sequence',
          metadata: downloadMetadata(
            'reference',
            'Reference sequence',
            resolveAsset(assembly.assetBase, assembly.assets.fasta),
          ),
          adapter: {
            type: 'BgzipFastaAdapter',
            fastaLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.fasta) },
            faiLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.fastaFai) },
            gziLocation: { uri: resolveAsset(assembly.assetBase, assembly.assets.fastaGzi) },
          },
        },
      },
      tracks,
      plugins: [SeqEdgeTrackDownloadPlugin],
      location: assembly.defaultLocus,
      defaultSession: {
        name: `${assembly.assemblyName} release view`,
        view: {
          id: `${assembly.assemblyName}-linear-view`,
          type: 'LinearGenomeView',
          tracks: [
            {
              type: 'ReferenceSequenceTrack',
              configuration: `${assembly.assemblyName}-reference-sequence`,
              displays: [{ type: 'LinearReferenceSequenceDisplay', configuration: `${assembly.assemblyName}-reference-sequence-LinearReferenceSequenceDisplay` }],
            },
            ...sessionTracks,
          ],
        },
      },
      onChange: () => {
        const view = stateTree?.session.view;
        if (!view || !onRegionChange || view.width <= 0) return;
        const region = visibleTrackRegion(view);
        if (region) onRegionChange(region);
      },
    });
    return stateTree;
  }, [assembly, onRegionChange]);

  return (
    <div className="portal-browser" data-testid="jbrowse-viewer">
      <JBrowseLinearGenomeView viewState={viewState} />
    </div>
  );
}
