// 데일리 트렌드 수집기 — 무료 소스만 사용 (계정·API키 불필요)
// 소스: ① 유튜브 인기 영상(카테고리별 주간 조회수 상위, youtubei.js)
//       ② 구글 트렌드 급상승 검색어 KR (RSS)
//       ③ 시그널 실시간 검색어 top10
// 실행: node collect.mjs  →  viewer/data/YYYY-MM-DD.js 생성 + viewer/data/manifest.js 갱신
// GitHub Actions(.github/workflows/collect.yml)가 하루 3번 자동 실행합니다.

import { Innertube, Log } from 'youtubei.js';

// 유튜브 화면 구조가 조금씩 바뀔 때마다 파서 경고가 수백 줄 찍혀서 로그가 안 보입니다. 끕니다.
Log.setLevel(Log.Level.NONE);
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, 'viewer', 'data');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

// 한국 시간 기준 오늘 날짜 (UTC+9)
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

const CATEGORIES = [
  { name: '음악/K-POP', query: 'K-POP 신곡 뮤직비디오' },
  { name: '예능', query: '예능 하이라이트' },
  { name: '드라마/영화', query: '드라마 예고편 영화' },
  { name: '게임/e스포츠', query: '게임 하이라이트 LCK' },
  { name: '먹방/요리', query: '먹방 요리' },
  { name: '스포츠', query: '축구 야구 하이라이트' },
  { name: '뉴스/이슈', query: '뉴스 이슈 정리' },
  { name: '브이로그/일상', query: '브이로그' },
];

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

function parseViews(text) {
  // "조회수 1,234,567회" → 1234567 / "조회수 2.6천만회" → 26000000 / "1.2억회" → 120000000
  if (!text) return 0;
  const m = String(text).replace(/,/g, '').match(/([\d.]+)\s*([천만억]*)/);
  if (!m) return 0;
  const unit = { '천': 1e3, '만': 1e4, '억': 1e8 };
  let n = parseFloat(m[1]);
  for (const ch of m[2]) n *= unit[ch] || 1;
  return Math.round(n);
}

// 유튜브 검색 결과는 옛 형식(Video)과 새 형식(LockupView)이 섞여서 옵니다. 둘 다 같은 모양으로 맞춥니다.
function normalizeVideo(v) {
  if (v?.type === 'LockupView') {
    if (v.content_type !== 'VIDEO' && v.content_type !== 'SHORT') return null;
    const parts = (v.metadata?.metadata?.metadata_rows || [])
      .flatMap((r) => (r.metadata_parts || []).map((p) => p.text?.text || p.text?.toString?.() || ''))
      .map((t) => t.trim())
      .filter(Boolean);
    const viewsText = parts.find((t) => /조회수|회$|views?$/i.test(t)) || '';
    const published = parts.find((t) => t !== viewsText && /전$|ago$|스트리밍/.test(t)) || '';
    const channel = parts.find((t) => t !== viewsText && t !== published) || '';
    return {
      id: v.content_id,
      title: v.metadata?.title?.text ?? v.metadata?.title?.toString?.() ?? '',
      channel, viewsText, published,
      duration: v.duration?.text || '',
    };
  }
  return {
    id: v?.id,
    title: v?.title?.text ?? String(v?.title ?? ''),
    channel: v?.author?.name ?? '',
    viewsText: v?.view_count?.text ?? v?.short_view_count?.text ?? '',
    published: v?.published?.text ?? '',
    duration: v?.duration?.text ?? '',
  };
}

async function collectYouTube() {
  const yt = await Innertube.create({ location: 'KR', lang: 'ko' });
  const seen = new Map();
  for (const cat of CATEGORIES) {
    try {
      const res = await yt.search(cat.query, { upload_date: 'week', sort_by: 'view_count' });
      let added = 0;
      for (const raw of (res.videos || [])) {
        if (added >= 12) break;
        const v = normalizeVideo(raw);
        if (!v || !v.id || !v.title || seen.has(v.id)) continue;
        seen.set(v.id, {
          source: 'youtube',
          category: cat.name,
          id: v.id,
          title: v.title,
          channel: v.channel,
          views: parseViews(v.viewsText),
          viewsText: v.viewsText,
          published: v.published,
          duration: v.duration,
          thumbnail: `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${v.id}`,
        });
        added++;
      }
      console.log(`[유튜브] ${cat.name}: +${added} (누적 ${seen.size}개)`);
    } catch (e) {
      console.error(`[유튜브] ${cat.name} 실패:`, e.message);
    }
  }
  const items = [...seen.values()].sort((a, b) => b.views - a.views);
  items.forEach((v, i) => (v.rank = i + 1));
  return items;
}

async function collectGoogleTrends() {
  const res = await fetch('https://trends.google.com/trending/rss?geo=KR', {
    headers: { 'User-Agent': UA },
  });
  const xml = await res.text();
  const items = [];
  const blocks = xml.split('<item>').slice(1);
  for (const block of blocks) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`, 's'));
      return m ? decodeEntities(m[1].trim()) : '';
    };
    const keyword = pick('title');
    if (!keyword) continue;
    items.push({
      source: 'gtrends',
      rank: items.length + 1,
      keyword,
      traffic: pick('ht:approx_traffic'),
      newsTitle: pick('ht:news_item_title').replace(/<[^>]+>/g, ''),
      newsUrl: pick('ht:news_item_url'),
      newsSource: pick('ht:news_item_source'),
      picture: pick('ht:picture'),
      url: `https://www.google.com/search?q=${encodeURIComponent(keyword)}`,
    });
  }
  console.log(`[구글 트렌드] ${items.length}개`);
  return items;
}

async function collectSignal() {
  const res = await fetch('https://api.signal.bz/news/realtime', { headers: { 'User-Agent': UA } });
  const j = await res.json();
  const items = (j.top10 || []).map((k) => ({
    source: 'signal',
    rank: k.rank,
    keyword: k.keyword,
    url: `https://search.naver.com/search.naver?query=${encodeURIComponent(k.keyword)}`,
  }));
  console.log(`[실시간 검색어] ${items.length}개`);
  return items;
}

async function safe(fn, label) {
  try { return await fn(); } catch (e) { console.error(`[${label}] 수집 실패:`, e.message); return []; }
}

const [youtube, gtrends, signal] = await Promise.all([
  safe(collectYouTube, '유튜브'),
  safe(collectGoogleTrends, '구글 트렌드'),
  safe(collectSignal, '실시간 검색어'),
]);

fs.mkdirSync(DATA_DIR, { recursive: true });
const todayFile = path.join(DATA_DIR, `${today}.js`);

// 전부 실패했으면 아무것도 저장하지 않습니다 (빈 데이터로 덮어쓰기 방지)
if (!youtube.length && !gtrends.length && !signal.length) {
  console.error('\n모든 소스 수집 실패 — 저장하지 않고 종료합니다.');
  process.exit(1);
}

// 같은 날 두 번째 수집인데 일부 소스만 실패했다면, 그 소스는 아까 받은 걸 유지
let prev = {};
if (fs.existsSync(todayFile)) {
  try {
    const box = {};
    new Function('window', fs.readFileSync(todayFile, 'utf8'))(box);
    prev = (box.__TREND_DATA__ || {})[today] || {};
  } catch (e) { prev = {}; }
}
const keep = (fresh, key) => (fresh.length ? fresh : (prev[key] || []));

const payload = {
  date: today,
  collectedAt: new Date().toISOString(),
  youtube: keep(youtube, 'youtube'),
  gtrends: keep(gtrends, 'gtrends'),
  signal: keep(signal, 'signal'),
};

// file:// 에서도 열리도록 JS 파일로 저장
fs.writeFileSync(
  todayFile,
  `window.__TREND_DATA__ = window.__TREND_DATA__ || {};\nwindow.__TREND_DATA__[${JSON.stringify(today)}] = ${JSON.stringify(payload)};\n`,
  'utf8'
);

// 60일 지난 데이터는 정리
const KEEP_DAYS = 60;
const cutoff = new Date(Date.now() + 9 * 3600 * 1000 - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
for (const f of fs.readdirSync(DATA_DIR)) {
  if (/^\d{4}-\d{2}-\d{2}\.js$/.test(f) && f.slice(0, 10) < cutoff) {
    fs.unlinkSync(path.join(DATA_DIR, f));
    console.log(`정리: ${f}`);
  }
}

// 날짜 목록(manifest) 갱신
const dates = fs.readdirSync(DATA_DIR)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.js$/.test(f))
  .map((f) => f.slice(0, 10))
  .sort();
fs.writeFileSync(path.join(DATA_DIR, 'manifest.js'), `window.__TREND_DATES__ = ${JSON.stringify(dates)};\n`, 'utf8');

console.log(`\n완료: ${today} — 유튜브 ${payload.youtube.length} / 구글트렌드 ${payload.gtrends.length} / 실검 ${payload.signal.length}`);
console.log(`저장: viewer/data/${today}.js`);
