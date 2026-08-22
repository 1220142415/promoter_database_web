import worldMap from '@/generated/world-map.json';
import type { UsageCountryRow } from '@/types/usage-analytics';

// Five teal steps from the portal palette. A log scale keeps a single dominant
// country from flattening every other contributor to the lightest step.
const SCALE = ['#cfeae5', '#9ad6cd', '#5ebfb3', '#1f9c92', '#00706a'];
const EMPTY_FILL = '#edf1ef';

interface UsageWorldMapProps {
  countries: UsageCountryRow[];
  metricLabel?: string;
}

function bucketFor(value: number, max: number) {
  if (value <= 0 || max <= 0) return -1;
  const ratio = Math.log1p(value) / Math.log1p(max);
  return Math.min(SCALE.length - 1, Math.floor(ratio * SCALE.length));
}

function bucketFloor(index: number, max: number) {
  const value = Math.expm1((index / SCALE.length) * Math.log1p(max));
  return Math.max(1, Math.round(value));
}

export default function UsageWorldMap({ countries, metricLabel = 'visitors' }: UsageWorldMapProps) {
  const measured = new Map(countries.filter((country) => country.code !== 'XX').map((country) => [country.code, country]));
  const max = Math.max(0, ...[...measured.values()].map((country) => country.visitors));
  const mapped = worldMap.countries.filter((country) => measured.has(country.code)).length;

  return (
    <figure className="usage-map">
      <svg
        viewBox={`0 0 ${worldMap.width} ${worldMap.height}`}
        role="img"
        aria-label={`World map shading ${mapped} countries by ${metricLabel}. The country table below lists the same numbers.`}
        preserveAspectRatio="xMidYMid meet"
      >
        <path className="usage-map-sphere" d={worldMap.sphere} />
        {worldMap.countries.map((country) => {
          const row = measured.get(country.code);
          const index = bucketFor(row?.visitors ?? 0, max);
          return (
            <path
              key={country.code}
              d={country.d}
              fill={index < 0 ? EMPTY_FILL : SCALE[index]}
              className={row ? 'usage-map-country is-measured' : 'usage-map-country'}
            >
              <title>
                {row
                  ? `${row.name}: ${row.visitors.toLocaleString()} visitors, ${row.views.toLocaleString()} page views`
                  : `${country.name}: no recorded visits`}
              </title>
            </path>
          );
        })}
      </svg>
      <figcaption>
        <span>No visits</span>
        <ol aria-hidden="true">
          <li style={{ background: EMPTY_FILL }} />
          {SCALE.map((color, index) => <li key={color} style={{ background: color }} title={`${bucketFloor(index, max)}+`} />)}
        </ol>
        <span>{max > 0 ? `${max.toLocaleString()} ${metricLabel}` : `No ${metricLabel} yet`}</span>
      </figcaption>
    </figure>
  );
}
