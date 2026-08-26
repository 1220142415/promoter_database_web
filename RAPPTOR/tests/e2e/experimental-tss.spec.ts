import { deflateRawSync } from 'node:zlib';
import { expect, test, type Route } from '@playwright/test';

const accession = 'GCF_000210855.2';
const refName = 'NC_016810.1';
const firstStudy = '2012_22251276_GCF_000210855.2';
const secondStudy = '2012_22538806_GCF_000210855.2';

function crc32(input: Buffer) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function bgzf(input: Buffer) {
  const compressed = deflateRawSync(input, { level: 6 });
  const blockSize = 18 + compressed.length + 8;
  if (blockSize > 65_536) throw new Error('E2E BGZF fixture exceeds one block.');
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x04, 0, 0, 0, 0, 0, 0xff, 0x06, 0, 0x42, 0x43, 0x02, 0, 0, 0]);
  header.writeUInt16LE(blockSize - 1, 16);
  const footer = Buffer.alloc(8);
  footer.writeUInt32LE(crc32(input), 0);
  footer.writeUInt32LE(input.length, 4);
  const eof = Buffer.from('H4sIBAAAAAAA/wYAQkMCABsAAwAAAAAAAAAAAA==', 'base64');
  return Buffer.concat([header, compressed, footer, eof]);
}

function fixtureAssets() {
  const sequence = 'ACGT'.repeat(500);
  const fastaLines = sequence.match(/.{1,60}/g) || [];
  const fastaText = `>${refName}\n${fastaLines.join('\n')}\n`;
  const fasta = bgzf(Buffer.from(fastaText));
  const fai = Buffer.from(`${refName}\t2000\t${refName.length + 2}\t60\t61\n`);
  const gzi = Buffer.alloc(8);
  const studyGff = (studyId: string, pmid: string, positions: Array<[number, '+' | '-']>) => Buffer.from([
    '##gff-version 3',
    ...positions.map(([position, strand], index) => [
      refName, 'RAPPTOR', 'experimental_tss', position, position, '.', strand, '.',
      `ID=${encodeURIComponent(`${studyId}:${index + 1}`)};Name=${encodeURIComponent(`TSS ${index + 1}`)};study_id=${studyId};pmid=${pmid};year=2012;raw_row=${index + 1};evidence_type=experimental`,
    ].join('\t')),
    '',
  ].join('\n'));
  return new Map<string, { body: Buffer; contentType: string }>([
    ['reference.fa.gz', { body: fasta, contentType: 'application/gzip' }],
    ['reference.fa.gz.fai', { body: fai, contentType: 'text/plain' }],
    ['reference.fa.gz.gzi', { body: gzi, contentType: 'application/octet-stream' }],
    [`studies/${firstStudy}/experimental-tss.gff3.gz`, {
      body: studyGff(firstStudy, '22251276', [[995, '+'], [1005, '-']]), contentType: 'text/plain',
    }],
    [`studies/${secondStudy}/experimental-tss.gff3.gz`, {
      body: studyGff(secondStudy, '22538806', [[1000, '+'], [1010, '-']]), contentType: 'text/plain',
    }],
  ]);
}

async function fulfillRange(route: Route, body: Buffer, contentType: string) {
  const range = route.request().headers().range;
  const match = range && /^bytes=(\d+)-(\d*)$/u.exec(range);
  if (!match) {
    await route.fulfill({ status: 200, body, headers: { 'Accept-Ranges': 'bytes', 'Content-Type': contentType } });
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
  if (start >= body.length || end < start) {
    await route.fulfill({ status: 416, headers: { 'Content-Range': `bytes */${body.length}` } });
    return;
  }
  const slice = body.subarray(start, end + 1);
  await route.fulfill({
    status: 206,
    body: slice,
    headers: {
      'Accept-Ranges': 'bytes',
      'Content-Length': String(slice.length),
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Content-Type': contentType,
    },
  });
}

test('experimental collection shows dual-study evidence and preserves its shared view', async ({ page, context }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const assets = fixtureAssets();
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(`${message.type()}: ${message.text()}`);
  });
  await page.route(`**/api/experimental-data/${accession}/**`, async (route) => {
    const prefix = `/api/experimental-data/${accession}/`;
    const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(prefix.length));
    const asset = assets.get(path);
    if (!asset) await route.fulfill({ status: 404, body: 'missing fixture asset' });
    else await fulfillRange(route, asset.body, asset.contentType);
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.goto('/genomes?evidence=experimental');
  await expect(page.getByRole('heading', { name: 'Genome catalog' })).toBeVisible();
  await expect(page.getByLabel('Genome evidence statistics')).toContainText('4');
  await expect(page.getByRole('link', { name: accession })).toBeVisible();
  await Promise.all([
    page.waitForURL(new RegExp(`/genomes/${accession.replaceAll('.', '\\.')}$`)),
    page.getByRole('link', { name: accession }).click(),
  ]);
  await expect(page.getByRole('heading', { name: 'Experimental TSS studies' })).toBeVisible();
  await expect(page.getByText(`2012 · PMID 22251276`, { exact: true })).toBeVisible();
  await expect(page.getByText(`2012 · PMID 22538806`, { exact: true })).toBeVisible();

  const tracks = `study.${firstStudy}:170,sequence:120,study.${secondStudy}:190`;
  const sharedPath = `/genomes/${accession}?view=1&ref=${refName}&center=1000&zoom=0.5&rev=1&tracks=${encodeURIComponent(tracks)}`;
  await page.goto(`/experimental-tss/genomes/${accession}?private=discard&view=1&ref=${refName}&center=1000&zoom=0.5&rev=1&tracks=${encodeURIComponent(tracks)}`);
  await expect(page).toHaveURL((url) => url.pathname === `/genomes/${accession}`
    && url.searchParams.get('view') === '1'
    && !url.searchParams.has('private'));
  await page.goto(sharedPath);
  const viewer = page.getByTestId('jbrowse-viewer');
  await expect(viewer).toContainText('PMID 22251276', { timeout: 30_000 });
  await expect(viewer).toContainText('PMID 22538806');
  await expect(viewer.locator('[data-feature-type="experimental-tss"]')).toHaveCount(4, { timeout: 30_000 });

  await viewer.locator('[data-role="experimental-tss-flag"]').first().click({ force: true });
  await expect(page.getByRole('heading', { name: 'Feature details' })).toBeVisible();
  await expect(page.getByText(/Experimental TSS.*one original observation/)).toBeVisible();
  await page.getByRole('button', { name: 'Close feature details' }).click();
  await page.goto(sharedPath);
  await expect(viewer.locator('[data-feature-type="experimental-tss"]')).toHaveCount(4, { timeout: 30_000 });

  const captureShare = async () => {
    const button = page.getByRole('button', { name: 'Share current view' });
    await expect(button).toBeEnabled({ timeout: 60_000 });
    await button.click({ force: true });
    const manual = page.getByLabel('Share link');
    await expect.poll(async () => await manual.count() || await page.getByText('Link copied', { exact: true }).count()).toBeTruthy();
    return new URL(await manual.count() ? await manual.inputValue() : await page.evaluate(() => navigator.clipboard.readText()));
  };

  const desktop = await captureShare();
  expect(desktop.pathname).toBe(`/genomes/${accession}`);
  expect(desktop.searchParams.get('ref')).toBe(refName);
  expect(desktop.searchParams.get('rev')).toBe('1');
  expect(desktop.searchParams.get('tracks')).toBe(tracks);
  expect(Math.abs(Number(desktop.searchParams.get('center')) - 1000)).toBeLessThanOrEqual(1);
  expect(Number(desktop.searchParams.get('zoom'))).toBeCloseTo(0.5, 9);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(desktop.toString());
  const mobile = await captureShare();
  expect(mobile.searchParams.get('ref')).toBe(desktop.searchParams.get('ref'));
  expect(mobile.searchParams.get('rev')).toBe(desktop.searchParams.get('rev'));
  expect(mobile.searchParams.get('tracks')).toBe(desktop.searchParams.get('tracks'));
  expect(Math.abs(Number(mobile.searchParams.get('center')) - Number(desktop.searchParams.get('center')))).toBeLessThanOrEqual(1);
  expect(Number(mobile.searchParams.get('zoom'))).toBeCloseTo(Number(desktop.searchParams.get('zoom')), 9);
  expect(errors).toEqual([]);
});
