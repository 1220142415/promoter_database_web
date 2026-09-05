'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import type { ExperimentalTssStudySearchResponse } from '@/types/experimental-tss';

function searchable(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase();
}

export default function ExperimentalTssExplorer({ initialResult }: { initialResult: ExperimentalTssStudySearchResponse }) {
  const [query, setQuery] = useState('');
  const [year, setYear] = useState('');
  const items = useMemo(() => {
    const needle = searchable(query.trim());
    return initialResult.items.filter((study) => {
      if (year && study.year !== Number(year)) return false;
      if (!needle) return true;
      return searchable([
        study.studyId,
        study.accession,
        study.organismName,
        study.pmid,
        study.publication.title,
        study.publication.journal,
        study.publication.doi,
      ].filter(Boolean).join(' ')).includes(needle);
    });
  }, [initialResult.items, query, year]);

  return (
    <div className="experimental-catalog">
      <div className="experimental-toolbar">
        <label className="experimental-search">
          <span>Search studies</span>
          <div><SearchRoundedIcon aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Organism, GCF, PMID or title" /></div>
        </label>
        <label>
          <span>Publication year</span>
          <select value={year} onChange={(event) => setYear(event.target.value)}>
            <option value="">All years</option>
            {initialResult.release.years.map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => { setQuery(''); setYear(''); }} disabled={!query && !year}>Reset</button>
      </div>

      <p className="experimental-result-count" aria-live="polite">Showing <strong>{items.length.toLocaleString()}</strong> of {initialResult.release.studies.toLocaleString()} studies</p>
      {items.length ? (
        <div className="experimental-study-list">
          {items.map((study) => (
            <article className="experimental-study-card" key={study.studyId}>
              <div className="experimental-study-year" aria-label={`Published ${study.year}`}><strong>{study.year}</strong><span>PMID {study.pmid}</span></div>
              <div className="experimental-study-copy">
                <p className="portal-kicker">{study.accession}</p>
                <h2>{study.publication.title || `Experimental TSS study PMID ${study.pmid}`}</h2>
                <p>{study.organismName}</p>
                <div className="experimental-study-meta">
                  {study.publication.journal ? <span>{study.publication.journal}</span> : null}
                  <span>{study.recordCount.toLocaleString()} observations</span>
                  <a href={`https://pubmed.ncbi.nlm.nih.gov/${study.pmid}/`} target="_blank" rel="noreferrer">PubMed</a>
                </div>
              </div>
              <Link href={`/experimental-tss/genomes/${study.accession}`} className="experimental-study-open">
                Open genome <ArrowForwardRoundedIcon aria-hidden="true" fontSize="small" />
              </Link>
            </article>
          ))}
        </div>
      ) : <div className="experimental-empty"><strong>No studies match these filters.</strong><p>Try another organism, accession, PMID or publication year.</p></div>}
    </div>
  );
}
