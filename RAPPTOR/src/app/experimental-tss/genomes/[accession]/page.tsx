import { permanentRedirect } from 'next/navigation';

const SHARE_PARAMETERS = ['view', 'ref', 'center', 'zoom', 'rev', 'tracks'] as const;

type LegacySearchParams = Promise<Record<string, string | string[] | undefined>>;

function safeShareQuery(values: Awaited<LegacySearchParams>) {
  const query = new URLSearchParams();
  for (const name of SHARE_PARAMETERS) {
    const value = values[name];
    if (typeof value === 'string') query.set(name, value);
  }
  return query.toString();
}

export default async function LegacyExperimentalGenomePage({
  params,
  searchParams,
}: {
  params: Promise<{ accession: string }>;
  searchParams?: LegacySearchParams;
}) {
  const [{ accession }, queryValues] = await Promise.all([params, searchParams || Promise.resolve({})]);
  const query = safeShareQuery(queryValues);
  const destination = `/genomes/${encodeURIComponent(accession)}`;
  return permanentRedirect(query ? `${destination}?${query}` : destination);
}
