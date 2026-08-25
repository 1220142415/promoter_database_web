#!/usr/bin/env node
// Generates src/generated/world-map.json: one compact SVG path per ISO 3166-1
// alpha-2 country, projected once at build time so the usage dashboard can render
// a choropleth on the server with no client-side mapping library.
//
// Geometry: Natural Earth 1:110m plus missing microstates from 1:50m.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { geoNaturalEarth1, geoPath } from 'd3-geo';
import countries from 'i18n-iso-countries';
import { feature } from 'topojson-client';

import detailedTopology from 'world-atlas/countries-50m.json' with { type: 'json' };
import topology from 'world-atlas/countries-110m.json' with { type: 'json' };

const WIDTH = 960;
const HEIGHT = 480;
const PRECISION = 1;

// Natural Earth marks a few de facto territories as "-99" because they have no
// assigned ISO code. Cloudflare reports Kosovo as XK and folds the other two
// into their neighbours, so the map follows the same convention.
const UNASSIGNED_BY_NAME = new Map([
  ['Kosovo', 'XK'],
  ['Somaliland', 'SO'],
  ['N. Cyprus', 'CY'],
]);

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outputPath = join(projectRoot, 'src', 'generated', 'world-map.json');

class RoundedPathContext {
  constructor(precision) {
    this.factor = 10 ** precision;
    this.parts = [];
  }

  round(value) {
    return Math.round(value * this.factor) / this.factor;
  }

  moveTo(x, y) {
    this.parts.push(`M${this.round(x)},${this.round(y)}`);
  }

  lineTo(x, y) {
    this.parts.push(`L${this.round(x)},${this.round(y)}`);
  }

  arc(x, y, radius) {
    const cx = this.round(x + radius);
    const cy = this.round(y);
    this.parts.push(`M${cx},${cy}A${this.round(radius)},${this.round(radius)} 0 1,1 ${this.round(x - radius)},${cy}A${this.round(radius)},${this.round(radius)} 0 1,1 ${cx},${cy}`);
  }

  closePath() {
    this.parts.push('Z');
  }

  toString() {
    const value = this.parts.join('');
    this.parts = [];
    return value;
  }
}

function alpha2ForGeometry(geometry) {
  const numeric = String(geometry.id ?? '');
  const byNumeric = numeric && numeric !== '-99' ? countries.numericToAlpha2(numeric) : undefined;
  return byNumeric || UNASSIGNED_BY_NAME.get(geometry.properties?.name) || null;
}

function build() {
  const collection = feature(topology, topology.objects.countries);
  const detailedCollection = feature(detailedTopology, detailedTopology.objects.countries);
  const context = new RoundedPathContext(PRECISION);
  const projection = geoNaturalEarth1().fitExtent([[2, 2], [WIDTH - 2, HEIGHT - 2]], { type: 'Sphere' });
  const path = geoPath(projection, context);

  path({ type: 'Sphere' });
  const sphere = context.toString();

  const byCode = new Map();
  const skipped = [];
  const append = (items, allowedCodes) => items.forEach((item) => {
    const code = alpha2ForGeometry(item);
    if (!code) {
      skipped.push(item.properties?.name || item.id);
      return;
    }
    if (allowedCodes && !allowedCodes.has(code)) return;
    path(item);
    const d = context.toString();
    if (!d) return;
    const existing = byCode.get(code);
    if (existing) existing.d += d;
    else byCode.set(code, { code, name: countries.getName(code, 'en') || item.properties?.name || code, d });
  });
  append(collection.features);
  const detailedCodes = new Set(detailedCollection.features.map(alpha2ForGeometry).filter(Boolean));
  append(detailedCollection.features, new Set([...detailedCodes].filter((code) => !byCode.has(code))));

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'Natural Earth 1:110m with 1:50m microstate fallback via world-atlas (public domain)',
    projection: 'naturalEarth1',
    width: WIDTH,
    height: HEIGHT,
    sphere,
    countries: [...byCode.values()].sort((left, right) => left.code.localeCompare(right.code)),
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(payload)}\n`, 'utf8');

  const bytes = Buffer.byteLength(JSON.stringify(payload));
  console.log(`world map: ${payload.countries.length} countries, ${(bytes / 1024).toFixed(0)} kB -> ${outputPath}`);
  if (skipped.length) console.log(`world map: skipped unmapped geometries: ${skipped.join(', ')}`);
}

build();
