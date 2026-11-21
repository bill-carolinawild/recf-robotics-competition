// Reads the current qualification match off the YouTube live stream.
// GET /api/current -> {"live":true,"m":"Q12","screen":"match","at":...}
//   live: true/false, or null if YouTube couldn't be checked; "m" is missing when the stream shows no match number
// There's no cron: viewers poll this, and the CDN caches each answer for 20s, so they all share one read.
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs/promises');
const ffmpeg = require('ffmpeg-static');
const { createWorker } = require('tesseract.js');

const VIDEO = process.env.VIDEO_ID || 'RNHNQwf6D2s';
const LAST_MATCH = Number(process.env.LAST_MATCH || 74);
// The stream alternates between three screens (crops are x, y, w, h at 1280x720):
//   match overlay  - "Q7" in the top-left corner        -> current = Q7
//   results screen - "Q7 · ENGINEERING" in the top center -> Q7 just finished, current = Q8
//   schedule       - "MATCH SCHEDULE" in the top center   -> no information
const CORNER = [12, 12, 76, 36];
const HEADER = [380, 5, 560, 90];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const TMP = '/tmp';

async function get(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
  return r;
}

// Watch page -> HLS master playlist -> ~720p variant -> newest segment (null when the stream isn't live)
async function latestSegment() {
  const html = await (await get(`https://www.youtube.com/watch?v=${VIDEO}`)).text();
  const hls = (html.match(/"hlsManifestUrl":"([^"]+)"/) || [])[1];
  if (!hls) {
    const status = (html.match(/"playabilityStatus":\{"status":"(\w+)"/) || [])[1];
    if (/"isLiveNow":true/.test(html)) throw new Error(`no stream URL (${status})`);
    return null;
  }
  const master = (await (await get(hls.replace(/\\u0026/g, '&'))).text()).split('\n');
  const variants = [];
  master.forEach((l, i) => {
    const h = l.startsWith('#EXT-X-STREAM-INF') && l.match(/RESOLUTION=\d+x(\d+)/);
    if (h) variants.push({ h: +h[1], url: master[i + 1].trim() });
  });
  if (!variants.length) throw new Error('no variants in playlist');
  const v = variants.filter(x => x.h <= 720).sort((a, b) => b.h - a.h)[0] || variants[0];
  const segs = (await (await get(v.url)).text()).split('\n').filter(l => l && !l.startsWith('#'));
  return new URL(segs[segs.length - 1], v.url).href;
}

// One frame -> two crops, enlarged, grayscale and inverted (dark text on white reads best)
async function crops(input) {
  const crop = ([x, y, w, h], l) => `[${l}in]crop=${w}:${h}:${x}:${y},scale=iw*3:ih*3,format=gray,negate[${l}]`;
  const fc = `[0:v]scale=1280:720,split=2[cin][hin];${crop(CORNER, 'c')};${crop(HEADER, 'h')}`;
  await promisify(execFile)(ffmpeg, ['-y', '-loglevel', 'error', '-i', input, '-frames:v', '1', '-filter_complex', fc,
    '-map', '[c]', `${TMP}/corner.png`, '-map', '[h]', `${TMP}/header.png`], { timeout: 20000 });
  return [`${TMP}/corner.png`, `${TMP}/header.png`];
}

let worker; // reused while the function stays warm
async function ocr(file) {
  if (!worker) {
    worker = await createWorker('eng', 1, { cachePath: TMP });
    await worker.setParameters({ tessedit_pageseg_mode: '7' }); // single line
  }
  return (await worker.recognize(file)).data.text.trim().toUpperCase();
}

async function readImage(input) {
  const [cornerPng, headerPng] = await crops(input);
  const corner = (await ocr(cornerPng)).replace(/O/g, '0');
  let m = corner.match(/^Q\s*(\d{1,3})$/);
  if (m) return { n: +m[1], screen: 'match' };
  const header = await ocr(headerPng);
  if (header.includes('SCHEDULE')) return { screen: 'schedule' };
  m = header.replace(/O/g, '0').match(/Q\s*(\d{1,3})/);
  if (m) return { n: +m[1] + 1, screen: 'results' };
  return { screen: 'unknown' };
}

async function readStream() {
  const seg = await latestSegment();
  if (!seg) return { live: false };
  try {
    const file = `${TMP}/seg.ts`;
    await fs.writeFile(file, Buffer.from(await (await get(seg)).arrayBuffer()));
    return { live: true, ...await readImage(file) };
  } catch (e) {
    return { live: true, error: e.message };
  }
}

module.exports = async (req, res) => {
  let body;
  try {
    const { n, ...rest } = await readStream();
    body = { ...rest, at: Date.now() };
    if (n >= 1 && n <= LAST_MATCH) body.m = `Q${n}`;
  } catch (e) {
    body = { live: null, error: e.message, at: Date.now() };
  }
  res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=40');
  res.status(200).json(body);
};
module.exports.readImage = readImage;
