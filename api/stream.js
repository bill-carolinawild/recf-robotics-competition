// The channel's current live stream, so the page always embeds the latest one and can show a LIVE/OFFLINE badge.
// GET /api/stream -> {"live":true,"video":"CIM9G8gUqeA","at":...}
//   video: the current (or most recent/upcoming) stream; live is null if YouTube couldn't be checked
// There's no cron: viewers poll this, and the CDN caches each answer for 20s, so they all share one lookup.
const CHANNEL = process.env.CHANNEL_ID || 'UCU9DBV19vLjnKPoFA-N_g8Q'; // @cteearobotics8294
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

module.exports = async (req, res) => {
  let body;
  try {
    const r = await fetch(`https://www.youtube.com/channel/${CHANNEL}/live`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} from YouTube`);
    const html = await r.text();
    // The /live page is the watch page of the current stream; YouTube serves variants that carry one flag or the other
    const video = (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/) || [])[1];
    body = { live: !!video && /"isLiveNow":true|"isLive":true/.test(html), video, at: Date.now() };
  } catch (e) {
    body = { live: null, error: e.message, at: Date.now() };
  }
  res.setHeader('Cache-Control', 'public, s-maxage=20, stale-while-revalidate=40');
  res.status(200).json(body);
};
