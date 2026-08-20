const fs = require('fs');
const path = require('path');

const THRESHOLD_MILLION_WON = 50_000; // 네이버 거래대금 단위: 백만원 = 500억원
const FETCH_CACHE_MS = 4_000;
const SNAPSHOT_FILE = path.join(__dirname, 'data', 'hamburger-snapshot.json');
const ETF_NAME_PATTERN = /KODEX|TIGER|ACE|RISE|SOL |HANARO|PLUS |TIMEFOLIO|KOSEF|KBSTAR|KIWOOM|WON |1Q |ARIRANG|TREX|KTOP|히어로즈|파워 |ETN|인버스|레버리지/i;

let memory = {
  date: '',
  rows: [],
  leaders: [],
  updatedAt: null,
  locked: false,
  lastFetchAt: 0
};

function stripHtml(value) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(value) {
  const cleaned = String(value || '').replace(/[^0-9.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseQuantPage(html, market) {
  const stocks = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];
    const stockMatch = row.match(/code=(\d{6})[^>]*class="tltle"[^>]*>([^<]+)<\/a>/i);
    if (!stockMatch) continue;

    const numbers = [];
    const numberRegex = /<td[^>]*class="number"[^>]*>([\s\S]*?)<\/td>/gi;
    let numberMatch;
    while ((numberMatch = numberRegex.exec(row)) !== null) numbers.push(stripHtml(numberMatch[1]));
    if (numbers.length < 5) continue;

    const name = stripHtml(stockMatch[2]);
    stocks.push({
      code: stockMatch[1],
      name,
      market,
      price: parseNumber(numbers[0]),
      changeRate: parseNumber(numbers[2]),
      volume: parseNumber(numbers[3]),
      tradingValueMillion: parseNumber(numbers[4]),
      tradingValueEok: Math.round(parseNumber(numbers[4]) / 100 * 10) / 10,
      isFund: ETF_NAME_PATTERN.test(name)
    });
  }
  return stocks;
}

function getKstParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short'
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
    weekday: parts.weekday
  };
}

function getPhase(now = new Date()) {
  const kst = getKstParts(now);
  const seconds = kst.hour * 3600 + kst.minute * 60 + kst.second;
  if (kst.weekday === 'Sat' || kst.weekday === 'Sun') return { ...kst, phase: 'CLOSED' };
  if (seconds < 9 * 3600) return { ...kst, phase: 'WAITING' };
  if (seconds < 9 * 3600 + 3 * 60) return { ...kst, phase: 'SCANNING' };
  if (seconds < 15 * 3600 + 30 * 60) return { ...kst, phase: 'LOCKED' };
  return { ...kst, phase: 'CLOSED' };
}

function resetForDate(date) {
  if (memory.date === date) return;
  memory = { date, rows: [], leaders: [], updatedAt: null, locked: false, lastFetchAt: 0 };
  try {
    const saved = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (saved.date === date) memory = { ...memory, ...saved, lastFetchAt: 0 };
  } catch (_) {
    // 첫 실행 또는 저장 파일 없음
  }
}

function saveSnapshot() {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({
      date: memory.date,
      rows: memory.rows,
      leaders: memory.leaders,
      updatedAt: memory.updatedAt,
      locked: memory.locked
    }, null, 2));
  } catch (error) {
    console.warn('햄버거 스냅샷 저장 실패:', error.message);
  }
}

async function fetchMarketLeaders(fetchImpl = fetch) {
  const requests = [];
  for (const market of [{ sosok: 0, name: 'KOSPI' }, { sosok: 1, name: 'KOSDAQ' }]) {
    for (let page = 1; page <= 5; page++) {
      requests.push((async () => {
        const url = `https://finance.naver.com/sise/sise_quant.naver?sosok=${market.sosok}&page=${page}`;
        const response = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko' } });
        if (!response.ok) throw new Error(`네이버 금융 응답 ${response.status}`);
        const html = new TextDecoder('euc-kr').decode(await response.arrayBuffer());
        return parseQuantPage(html, market.name);
      })());
    }
  }

  const settled = await Promise.allSettled(requests);
  const unique = new Map();
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const stock of result.value) {
      if (!unique.has(stock.code) || unique.get(stock.code).tradingValueMillion < stock.tradingValueMillion) {
        unique.set(stock.code, stock);
      }
    }
  }
  if (!unique.size) throw new Error('거래대금 순위를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return [...unique.values()].filter(stock => !stock.isFund).sort((a, b) => b.tradingValueMillion - a.tradingValueMillion);
}

async function isKrxMarketOpen(date, fetchImpl = fetch) {
  const response = await fetchImpl('https://polling.finance.naver.com/api/realtime/domestic/stock/005930', {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko' }
  });
  if (!response.ok) throw new Error(`시장 상태 응답 ${response.status}`);
  const payload = await response.json();
  const quote = payload.datas?.[0];
  const tradedDate = String(quote?.localTradedAt || '').slice(0, 10);
  return quote?.marketStatus === 'OPEN' && tradedDate === date;
}

function responsePayload(phaseInfo, note) {
  return {
    success: true,
    date: memory.date,
    phase: memory.locked ? 'LOCKED' : phaseInfo.phase,
    thresholdEok: THRESHOLD_MILLION_WON / 100,
    rows: memory.rows,
    leaders: memory.leaders,
    updatedAt: memory.updatedAt,
    locked: memory.locked,
    note
  };
}

async function getHamburgerStatus({ now = new Date(), fetchImpl = fetch } = {}) {
  const phaseInfo = getPhase(now);
  resetForDate(phaseInfo.date);

  if (memory.locked) return responsePayload(phaseInfo, '오늘 첫 3분봉 결과가 확정되었습니다.');
  if (phaseInfo.phase === 'WAITING') return responsePayload(phaseInfo, '09:00부터 자동 검색을 시작합니다.');
  if (phaseInfo.phase === 'CLOSED') return responsePayload(phaseInfo, '장 시작 전 사이트를 열어 두면 09:00부터 자동 검색합니다.');

  if (phaseInfo.phase === 'LOCKED' && !memory.updatedAt) {
    return responsePayload(phaseInfo, '오늘 09:00~09:03에 수집된 기록이 없습니다. 다음 거래일 장 시작 전에 이 사이트를 열어 주세요.');
  }

  if (Date.now() - memory.lastFetchAt >= FETCH_CACHE_MS) {
    if (!(await isKrxMarketOpen(phaseInfo.date, fetchImpl))) {
      return responsePayload(phaseInfo, '현재 정규장이 열리지 않았습니다. 휴장일이면 검색 결과가 생성되지 않습니다.');
    }
    const stocks = await fetchMarketLeaders(fetchImpl);
    memory.lastFetchAt = Date.now();
    memory.leaders = stocks.slice(0, 12);
    memory.rows = stocks.filter(stock => stock.tradingValueMillion >= THRESHOLD_MILLION_WON);
    memory.updatedAt = now.toISOString();
    saveSnapshot();
  }

  return responsePayload(phaseInfo, '첫 3분봉 거래대금을 실시간 확인 중입니다.');
}

function finalizeIfNeeded(now = new Date()) {
  const phaseInfo = getPhase(now);
  resetForDate(phaseInfo.date);
  if (!memory.locked && memory.updatedAt && phaseInfo.phase === 'LOCKED') {
    memory.locked = true;
    saveSnapshot();
  }
}

module.exports = {
  THRESHOLD_MILLION_WON,
  parseQuantPage,
  getPhase,
  isKrxMarketOpen,
  fetchMarketLeaders,
  getHamburgerStatus,
  finalizeIfNeeded
};
