import type { UsageDayRow } from '@/types/usage-analytics';

const SLOT = 4;
const BAR = 3;
const HEIGHT = 100;

export default function UsageTrend({ daily }: { daily: UsageDayRow[] }) {
  if (daily.length === 0) return null;

  const max = Math.max(1, ...daily.map((entry) => entry.views));
  const width = daily.length * SLOT;

  return (
    <figure className="usage-trend">
      <svg viewBox={`0 0 ${width} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={`Daily page views and visitors from ${daily[0].day} to ${daily[daily.length - 1].day}.`}>
        {daily.map((entry, index) => {
          const viewHeight = (entry.views / max) * HEIGHT;
          const visitorHeight = (entry.visitors / max) * HEIGHT;
          return (
            <g key={entry.day}>
              <title>{`${entry.day}: ${entry.visitors.toLocaleString()} visitors, ${entry.views.toLocaleString()} page views`}</title>
              <rect x={index * SLOT} y={HEIGHT - viewHeight} width={BAR} height={viewHeight} fill="#cfeae5" />
              <rect x={index * SLOT} y={HEIGHT - visitorHeight} width={BAR} height={visitorHeight} fill="#00706a" />
            </g>
          );
        })}
      </svg>
      <figcaption>
        <span>{daily[0].day}</span>
        <em><i style={{ background: '#00706a' }} /> Visitors <i style={{ background: '#cfeae5' }} /> Page views</em>
        <span>{daily[daily.length - 1].day}</span>
      </figcaption>
    </figure>
  );
}
