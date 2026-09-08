import Plugin from '@jbrowse/core/Plugin';
import type PluginManager from '@jbrowse/core/PluginManager';
import { ConfigurationSchema } from '@jbrowse/core/configuration';
import AdapterType from '@jbrowse/core/pluggableElementTypes/AdapterType';
import { ObservableCreate } from '@jbrowse/core/util/rxjs';
import { checkStopToken } from '@jbrowse/core/util/stopToken';
import type { Feature } from '@jbrowse/core/util';
import SimpleFeature from '@jbrowse/core/util/simpleFeature';
import BigWigAdapter from '@jbrowse/plugin-wiggle/esm/BigWigAdapter/BigWigAdapter.js';
import bigWigConfig from '@jbrowse/plugin-wiggle/esm/BigWigAdapter/configSchema.js';
import { readSmoothedScores } from '../score-smoothing';

export const SMOOTHED_SCORE_ADAPTER = 'RapptorSmoothedBigWigAdapter';
export const smoothedScoreConfig = ConfigurationSchema(SMOOTHED_SCORE_ADAPTER, {}, {
  baseConfiguration: bigWigConfig, explicitlyTyped: true,
});

export class SmoothedBigWigAdapter extends BigWigAdapter {
  getFeatures(region: Parameters<BigWigAdapter['getFeatures']>[0], opts: Parameters<BigWigAdapter['getFeatures']>[1] = {}) {
    return ObservableCreate<Feature>(async observer => {
      const { bigwig, header } = await this.setup(opts);
      const length = header.refsByNumber[header.refsByName[region.refName]]?.length;
      if (length === undefined) { observer.complete(); return; }
      const source = this.getConf('source');
      const checkCancelled = () => { opts.signal?.throwIfAborted(); checkStopToken(opts.stopToken); };
      const scores = readSmoothedScores(async (start, end) => {
        // Never smooth a precomputed BigWig zoom summary.
        const rows = await bigwig.getFeatures(region.refName, start, Math.min(length, end), { ...opts, basesPerSpan: 0, scale: Infinity });
        return rows.map(row => ({ start: row.start, end: row.end, score: row.score ?? NaN }));
      }, Math.max(0, Math.floor(region.start)), Math.min(length, Math.ceil(region.end)), {
        binSize: Math.max(1, Math.floor((opts.bpPerPx || 1) / (opts.resolution || 1))), checkCancelled,
      });
      for await (const row of scores) {
        const uniqueId = `smooth:${source}:${region.refName}:${row.start}-${row.end}`;
        observer.next(new SimpleFeature({ id: uniqueId, data: { ...row, refName: region.refName, source } }));
      }
      observer.complete();
    }, opts.stopToken);
  }
}

export default class RapptorSmoothedScorePlugin extends Plugin {
  name = 'RapptorSmoothedScorePlugin';
  install(pluginManager: PluginManager) {
    pluginManager.addAdapterType(() => new AdapterType({
      name: SMOOTHED_SCORE_ADAPTER, configSchema: smoothedScoreConfig,
      adapterCapabilities: BigWigAdapter.capabilities,
      AdapterClass: SmoothedBigWigAdapter,
    }));
  }
}
