const fs = require('fs');
const path = require('path');

const THRESHOLD_MILLION_WON = 30_000; // 네이버 거래대금 단위: 백만원 = 300억원
const FETCH_CACHE_MS = 8_000;
const MARKET_OPEN_SECONDS = 9 * 60 * 60;
const MARKET_CLOSE_SECONDS = 15 * 60 * 60 + 30 * 60;
const BAR_SECONDS = 3 * 60;
const SNAPSHOT_FILE = path.join(__dirname, 'data', 'hamburger-snapshot.json');
const ETF_NAME_PATTERN = /KODEX|TIGER|ACE|RISE|SOL |HANARO|PLUS |TIMEFOLIO|KOSEF|KBSTAR|KIWOOM|WON |1Q |ARIRANG|TREX|KTOP|히어로즈|파워 |ETN|인버스|레버리지/i;

function emptyMemory(date = '') {
  return {
    date,
    signals: [],
    activeRows: [],
    leaders: [],
    barKey: null,
    barIndex: null,
    barLabel: null,
    baselines: {},
    lastTotals: {},
    updatedAt: null,
    lastFetchAt: 0
  };
}

let memory = emptyMemory();

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
      accumulatedTradingValueMillion: parseNumber(numbers[4]),
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
  if (kst.weekday === 'Sat' || kst.weekday === 'Sun') return { ...kst, seconds, phase: 'CLOSED' };
  if (seconds < MARKET_OPEN_SECONDS) return { ...kst, seconds, phase: 'WAITING' };
  if (seconds < MARKET_CLOSE_SECONDS) return { ...kst, seconds, phase: 'SCANNING' };
  return { ...kst, seconds, phase: 'CLOSED' };
}

function formatClock(totalSeconds) {
  const bounded = Math.max(0, totalSeconds);
  const hour = Math.floor(bounded / 3600);
  const minute = Math.floor((bounded % 3600) / 60);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function getBarInfo(phaseInfo) {
  if (phaseInfo.phase !== 'SCANNING') return null;
  const index = Math.floor((phaseInfo.seconds - MARKET_OPEN_SECONDS) / BAR_SECONDS);
  const startSeconds = MARKET_OPEN_SECONDS + index * BAR_SECONDS;
  const endSeconds = Math.min(startSeconds + BAR_SECONDS, MARKET_CLOSE_SECONDS);
  const start = formatClock(startSeconds);
  const end = formatClock(endSeconds);
  return { index, key: `${phaseInfo.date}-${start}`, label: `${start}~${end}`, start, end };
}

function resetForDate(date) {
  if (memory.date === date) return;
  memory = emptyMemory(date);
  try {
    const saved = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    if (saved.date === date) memory = { ...emptyMemory(date), ...saved, lastFetchAt: 0 };
  } catch (_) {
    // 첫 실행 또는 저장 파일 없음
  }
}

function saveSnapshot() {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({
      date: memory.date,
      signals: memory.signals,
      activeRows: memory.activeRows,
      leaders: memory.leaders,
      barKey: memory.barKey,
      barIndex: memory.barIndex,
      barLabel: memory.barLabel,
      baselines: memory.baselines,
      lastTotals: memory.lastTotals,
      updatedAt: memory.updatedAt
    }, null, 2));
  } catch (error) {
    console.warn('햄버거 스냅샷 저장 실패:', error.message);
  }
}

async function fetchMarketLeaders(fetchImpl = fetch) {
  const requests = [];
  for (const market of [{ sosok: 0, name: 'KOSPI' }, { sosok: 1, name: 'KOSDAQ' }]) {
    for (let page = 1; page <= 2; page++) {
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
      const previous = unique.get(stock.code);
      if (!previous || previous.accumulatedTradingValueMillion < stock.accumulatedTradingValueMillion) unique.set(stock.code, stock);
    }
  }
  if (!unique.size) throw new Error('거래대금 순위를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return [...unique.values()].filter(stock => !stock.isFund);
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

function beginBar(barInfo) {
  if (memory.barKey === barInfo.key) return;
  memory.barKey = barInfo.key;
  memory.barIndex = barInfo.index;
  memory.barLabel = barInfo.label;
  memory.activeRows = [];
  memory.leaders = [];
  memory.baselines = {};
  memory.lastFetchAt = 0;
}

function updateCurrentBar(stocks, barInfo, now) {
  const isFirstBar = barInfo.index === 0;
  const leaders = [];
  const activeRows = [];

  for (const stock of stocks) {
    const total = stock.accumulatedTradingValueMillion;
    if (!(stock.code in memory.baselines)) memory.baselines[stock.code] = isFirstBar ? 0 : total;
    memory.lastTotals[stock.code] = total;
    const tradingValueMillion = Math.max(0, total - memory.baselines[stock.code]);
    const row = {
      code: stock.code,
      name: stock.name,
      market: stock.market,
      price: stock.price,
      changeRate: stock.changeRate,
      tradingValueMillion,
      tradingValueEok: Math.round(tradingValueMillion / 100 * 10) / 10,
      barKey: barInfo.key,
      barLabel: barInfo.label
    };
    leaders.push(row);

    if (tradingValueMillion >= THRESHOLD_MILLION_WON) {
      const signalId = `${barInfo.key}-${stock.code}`;
      const existing = memory.signals.find(item => item.id === signalId);
      const signal = { ...row, id: signalId, detectedAt: existing?.detectedAt || now.toISOString() };
      if (existing) Object.assign(existing, signal);
      else memory.signals.unshift(signal);
      activeRows.push(signal);
    }
  }

  memory.activeRows = activeRows.sort((a, b) => b.tradingValueMillion - a.tradingValueMillion);
  memory.leaders = leaders.sort((a, b) => b.tradingValueMillion - a.tradingValueMillion).slice(0, 12);
  memory.signals.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt));
  memory.updatedAt = now.toISOString();
}

function responsePayload(phaseInfo, note) {
  return {
    success: true,
    date: memory.date,
    phase: phaseInfo.phase,
    thresholdEok: THRESHOLD_MILLION_WON / 100,
    rows: memory.signals,
    activeRows: memory.activeRows,
    leaders: memory.leaders,
    currentBarLabel: memory.barLabel,
    updatedAt: memory.updatedAt,
    note
  };
}

async function getHamburgerStatus({ now = new Date(), fetchImpl = fetch } = {}) {
  const phaseInfo = getPhase(now);
  resetForDate(phaseInfo.date);

  if (phaseInfo.phase === 'WAITING') return responsePayload(phaseInfo, '09:00부터 장중 모든 3분봉을 자동 검색합니다.');
  if (phaseInfo.phase === 'CLOSED') return responsePayload(phaseInfo, '장중 포착된 3분봉 거래대금 300억원 돌파 종목입니다.');

  const barInfo = getBarInfo(phaseInfo);
  beginBar(barInfo);
  if (now.getTime() - memory.lastFetchAt >= FETCH_CACHE_MS) {
    if (!(await isKrxMarketOpen(phaseInfo.date, fetchImpl))) {
      return responsePayload(phaseInfo, '현재 정규장이 열리지 않았습니다. 휴장일이면 검색 결과가 생성되지 않습니다.');
    }
    const stocks = await fetchMarketLeaders(fetchImpl);
    memory.lastFetchAt = now.getTime();
    updateCurrentBar(stocks, barInfo, now);
    saveSnapshot();
  }

  return responsePayload(phaseInfo, `${barInfo.label} 거래대금을 실시간 확인 중입니다.`);
}

module.exports = {
  THRESHOLD_MILLION_WON,
  parseQuantPage,
  getPhase,
  getBarInfo,
  isKrxMarketOpen,
  fetchMarketLeaders,
  getHamburgerStatus
};
