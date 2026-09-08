import { SCORE_TRACK_FILENAMES } from './live-result';

type Track = { filename: string; size: number };
type TrackSource = Track & { body: ReadableStream<Uint8Array> };
const MAX_ZIP_SIZE = 0xffffffff;
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function entryName(filename: string) {
  if (!SCORE_TRACK_FILENAMES.some((name) => name === filename)) throw new Error('Invalid score track filename.');
  return encoder.encode(`model-score-tracks/${filename}`);
}

export function scoreTracksZipSize(tracks: Track[]) {
  if (!tracks.length || tracks.length > 2 || new Set(tracks.map((track) => track.filename)).size !== tracks.length) throw new Error('Invalid score tracks.');
  const size = tracks.reduce((total, track) => {
    if (!Number.isSafeInteger(track.size) || track.size < 0) throw new Error('Invalid score track size.');
    // Local header, name, stored bytes, data descriptor, central entry and name.
    return total + 30 + entryName(track.filename).length * 2 + track.size + 16 + 46;
  }, 22);
  if (size >= MAX_ZIP_SIZE) throw new RangeError('The score tracks exceed the ZIP size limit.');
  return size;
}

function header(length: number, signature: number) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, signature, true);
  return { bytes, view };
}

/** BigWig is already compressed: use streaming ZIP STORE, preserving its exact bytes. */
export function scoreTracksZipStream(tracks: TrackSource[]) {
  scoreTracksZipSize(tracks);
  async function* chunks() {
    const centralEntries: Uint8Array[] = [];
    let offset = 0;
    try {
      for (const track of tracks) {
        const name = entryName(track.filename);
        const localOffset = offset;
        const local = header(30 + name.length, 0x04034b50);
        local.view.setUint16(4, 20, true); // ZIP 2.0, with a trailing data descriptor.
        local.view.setUint16(6, 0x0808, true); // UTF-8 names, CRC/sizes follow the data.
        local.view.setUint16(12, 33, true); // Stable DOS date: 1980-01-01.
        local.view.setUint16(26, name.length, true);
        local.bytes.set(name, 30);
        yield local.bytes;
        offset += local.bytes.length;

        let crc = 0xffffffff;
        let size = 0;
        const reader = track.body.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > track.size) throw new Error('The score track size does not match its result metadata.');
            for (const byte of value) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
            yield value;
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (size !== track.size) throw new Error('The score track download was incomplete.');
        crc = (crc ^ 0xffffffff) >>> 0;
        offset += size;
        const descriptor = header(16, 0x08074b50);
        descriptor.view.setUint32(4, crc, true);
        descriptor.view.setUint32(8, size, true);
        descriptor.view.setUint32(12, size, true);
        yield descriptor.bytes;
        offset += descriptor.bytes.length;

        const central = header(46 + name.length, 0x02014b50);
        central.view.setUint16(4, 20, true);
        central.view.setUint16(6, 20, true);
        central.view.setUint16(8, 0x0808, true);
        central.view.setUint16(14, 33, true);
        central.view.setUint32(16, crc, true);
        central.view.setUint32(20, size, true);
        central.view.setUint32(24, size, true);
        central.view.setUint16(28, name.length, true);
        central.view.setUint32(42, localOffset, true);
        central.bytes.set(name, 46);
        centralEntries.push(central.bytes);
      }
      const centralSize = centralEntries.reduce((sum, entry) => sum + entry.length, 0);
      for (const entry of centralEntries) yield entry;
      const end = header(22, 0x06054b50);
      end.view.setUint16(8, tracks.length, true);
      end.view.setUint16(10, tracks.length, true);
      end.view.setUint32(12, centralSize, true);
      end.view.setUint32(16, offset, true);
      yield end.bytes;
    } finally {
      await Promise.allSettled(tracks.map((track) => track.body.cancel()));
    }
  }
  const iterator = chunks();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) controller.close(); else controller.enqueue(value);
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(); },
  });
}
