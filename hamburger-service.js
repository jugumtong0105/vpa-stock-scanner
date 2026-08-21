const fs = require('fs');
const path = require('path');

const MIN_TRADING_VALUE_MILLION_WON = 3_000; // 네이버 거래대금 단위: 백만원 = 30억원
const RELATIVE_MULTIPLIER = 5;
const HISTORY_WINDOW = 20;
const CONFIRMATION_RATIO = 0.8;
const FETCH_CACHE_MS = 8_000;
const MARKET_OPEN_SECONDS = 9 * 60 * 60;
const MARKET_CLOSE_SECONDS = 15 * 60 * 60 + 30 * 60;
const BAR_SECONDS = 3 * 60;
const SNAPSHOT_FILE = path.join(__dirname, 'data', 'hamburger-snapshot.json');
const EXCLUDED_NAME_PATTERN = /KODEX|TIGER|ACE|RISE|SOL |HANARO|PLUS |TIMEFOLIO|KOSEF|KBSTAR|KIWOOM|WON |1Q |ARIRANG|TREX|KTOP|히어로즈|파워 |ETN|인버스|레버리지|스팩|우(?:B|C)?$/i;

function emptyMemory(date = '') {
  return {
    schemaVersion: 2,
    date,
    signals: [],
    activeRows: [],
    leaders: [],
    barKey: null,
    barIndex: null,
    barLabel: null,
    baselines: {},
    openPrices: {},
    currentRows: {},
    histories: {},
    historyLoaded: {},
    lastTotals: {},
    updatedAt: null,
    lastFetchAt: 0
  };
}

let memory = emptyMemory();

function resetMemoryForTests(date = '') {
  memory = emptyMemory(date);
}

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
      isFund: EXCLUDED_NAME_PATTERN.test(name)
    });
  }
  return stocks;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function getDynamicThreshold(history = []) {
  const recent = history
    .slice(-HISTORY_WINDOW)
    .map(bar => Number(bar.tradingValueMillion) || 0)
    .filter(value => value > 0);
  const medianMillion = median(recent);
  return {
    sampleSize: recent.length,
    medianMillion,
    thresholdMillion: Math.max(MIN_TRADING_VALUE_MILLION_WON, medianMillion * RELATIVE_MULTIPLIER)
  };
}

function parseMinuteHistory(xml, { currentDate = '', currentBarIndex = Number.POSITIVE_INFINITY } = {}) {
  const points = [...String(xml || '').matchAll(/<item data="(\d{12})\|[^|]*\|[^|]*\|[^|]*\|(\d+)\|(\d+)"/g)]
    .map(match => ({ at: match[1], close: Number(match[2]), cumulativeVolume: Number(match[3]) }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const groups = new Map();
  let previousDate = '';
  let previousCumulativeVolume = 0;

  for (const point of points) {
    const date = point.at.slice(0, 8);
    const hour = Number(point.at.slice(8, 10));
    const minute = Number(point.at.slice(10, 12));
    const barIndex = Math.floor((hour * 60 + minute - 9 * 60) / 3);
    if (barIndex < 0 || barIndex >= 130) continue;
    if (date !== previousDate) previousCumulativeVolume = 0;
    const volume = Math.max(0, point.cumulativeVolume - previousCumulativeVolume);
    previousDate = date;
    previousCumulativeVolume = point.cumulativeVolume;
    const key = `${date}-${barIndex}`;
    const bar = groups.get(key) || {
      barKey: key,
      barIndex,
      date,
      openPrice: point.close,
      closePrice: point.close,
      tradingValueMillion: 0
    };
    bar.closePrice = point.close;
    bar.tradingValueMillion += volume * point.close / 1_000_000;
    groups.set(key, bar);
  }

  return [...groups.values()]
    .filter(bar => bar.date < currentDate || (bar.date === currentDate && bar.barIndex < currentBarIndex))
    .map(bar => ({ ...bar, isBullish: bar.closePrice > bar.openPrice }))
    .slice(-HISTORY_WINDOW);
}

async function fetchMinuteHistory(code, phaseInfo, barInfo, fetchImpl = fetch) {
  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=minute&count=3000&requestType=0`;
  const response = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ko' } });
  if (!response.ok) throw new Error(`분봉 이력 응답 ${response.status}`);
  const xml = await response.text();
  return parseMinuteHistory(xml, {
    currentDate: phaseInfo.date.replaceAll('-', ''),
    currentBarIndex: barInfo.index
  });
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
    if (saved.schemaVersion === 2 && saved.date === date) {
      memory = { ...emptyMemory(date), ...saved, lastFetchAt: 0 };
    }
  } catch (_) {
    // 첫 실행 또는 저장 파일 없음
  }
}

function saveSnapshot() {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify({
      schemaVersion: memory.schemaVersion,
      date: memory.date,
      signals: memory.signals,
      activeRows: memory.activeRows,
      leaders: memory.leaders,
      barKey: memory.barKey,
      barIndex: memory.barIndex,
      barLabel: memory.barLabel,
      baselines: memory.baselines,
      openPrices: memory.openPrices,
      currentRows: memory.currentRows,
      histories: memory.histories,
      historyLoaded: memory.historyLoaded,
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

function addCompletedBar(code, bar) {
  const history = memory.histories[code] || [];
  const withoutDuplicate = history.filter(item => item.barKey !== bar.barKey);
  memory.histories[code] = [...withoutDuplicate, bar].slice(-HISTORY_WINDOW);
}

function finalizeCurrentBar(now) {
  const completed = Object.values(memory.currentRows || {});
  if (!completed.length) return;

  for (const row of completed) {
    const history = memory.histories[row.code] || [];
    const dynamic = getDynamicThreshold(history);
    const isBullish = row.price > row.openPrice;
    const previousSignal = memory.signals.find(signal =>
      signal.code === row.code && signal.barIndex === row.barIndex - 1 && signal.stage === 'HAMBURGER'
    );
    if (previousSignal && isBullish && row.tradingValueMillion >= previousSignal.tradingValueMillion * CONFIRMATION_RATIO) {
      previousSignal.stage = 'CONFIRMED';
      previousSignal.stageLabel = '확인';
      previousSignal.confirmedAt = now.toISOString();
      previousSignal.confirmationBarLabel = row.barLabel;
      previousSignal.confirmationValueEok = Math.round(row.tradingValueMillion / 10) / 10;
    }

    if (dynamic.sampleSize >= 5 && row.tradingValueMillion >= dynamic.thresholdMillion) {
      const signalId = `${row.barKey}-${row.code}`;
      const stage = isBullish ? 'HAMBURGER' : 'WATCH';
      const signal = {
        ...row,
        id: signalId,
        stage,
        stageLabel: isBullish ? '햄버거' : '관심',
        isBullish,
        medianTradingValueEok: Math.round(dynamic.medianMillion / 10) / 10,
        dynamicThresholdEok: Math.round(dynamic.thresholdMillion / 10) / 10,
        multiple: dynamic.medianMillion
          ? Math.round(row.tradingValueMillion / dynamic.medianMillion * 10) / 10
          : null,
        detectedAt: now.toISOString()
      };
      const existing = memory.signals.find(item => item.id === signalId);
      if (existing) Object.assign(existing, signal, { detectedAt: existing.detectedAt });
      else memory.signals.unshift(signal);
    }

    addCompletedBar(row.code, {
      barKey: row.barKey,
      barIndex: row.barIndex,
      openPrice: row.openPrice,
      closePrice: row.price,
      tradingValueMillion: row.tradingValueMillion,
      isBullish
    });
  }
  memory.signals.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt));
}

function beginBar(barInfo, now) {
  if (memory.barKey === barInfo.key) return;
  if (memory.barKey) finalizeCurrentBar(now);
  memory.barKey = barInfo.key;
  memory.barIndex = barInfo.index;
  memory.barLabel = barInfo.label;
  memory.activeRows = [];
  memory.leaders = [];
  memory.baselines = { ...memory.lastTotals };
  memory.openPrices = {};
  memory.currentRows = {};
  memory.lastFetchAt = 0;
}

async function ensureMinuteHistories(stocks, phaseInfo, barInfo, fetchImpl) {
  const missing = stocks.filter(stock => !memory.historyLoaded[stock.code]);
  for (let index = 0; index < missing.length; index += 8) {
    const batch = missing.slice(index, index + 8);
    const settled = await Promise.allSettled(batch.map(async stock => {
      const bars = await fetchMinuteHistory(stock.code, phaseInfo, barInfo, fetchImpl);
      if (bars.length) memory.histories[stock.code] = bars;
      memory.historyLoaded[stock.code] = true;
    }));
    settled.forEach((result, offset) => {
      if (result.status === 'rejected') {
        const code = batch[offset].code;
        memory.historyLoaded[code] = true;
        console.warn(`${code} 분봉 이력 로딩 실패:`, result.reason?.message || result.reason);
      }
    });
  }
}

function updateCurrentBar(stocks, barInfo, now) {
  const isFirstBar = barInfo.index === 0;
  const leaders = [];

  for (const stock of stocks) {
    const total = stock.accumulatedTradingValueMillion;
    if (!(stock.code in memory.baselines)) memory.baselines[stock.code] = isFirstBar ? 0 : total;
    if (!(stock.code in memory.openPrices)) memory.openPrices[stock.code] = stock.price;
    memory.lastTotals[stock.code] = total;
    const tradingValueMillion = Math.max(0, total - memory.baselines[stock.code]);
    const dynamic = getDynamicThreshold(memory.histories[stock.code] || []);
    const row = {
      code: stock.code,
      name: stock.name,
      market: stock.market,
      price: stock.price,
      openPrice: memory.openPrices[stock.code],
      changeRate: stock.changeRate,
      tradingValueMillion,
      tradingValueEok: Math.round(tradingValueMillion / 10) / 10,
      medianTradingValueEok: Math.round(dynamic.medianMillion / 10) / 10,
      dynamicThresholdEok: Math.round(dynamic.thresholdMillion / 10) / 10,
      multiple: dynamic.medianMillion ? Math.round(tradingValueMillion / dynamic.medianMillion * 10) / 10 : null,
      barKey: barInfo.key,
      barIndex: barInfo.index,
      barLabel: barInfo.label
    };
    memory.currentRows[stock.code] = row;
    leaders.push(row);
  }

  memory.activeRows = leaders
    .filter(row => row.tradingValueMillion >= row.dynamicThresholdEok * 100)
    .sort((a, b) => b.tradingValueMillion - a.tradingValueMillion);
  memory.leaders = leaders
    .sort((a, b) => (b.multiple || 0) - (a.multiple || 0))
    .slice(0, 12);
  memory.updatedAt = now.toISOString();
}

function responsePayload(phaseInfo, note) {
  return {
    success: true,
    date: memory.date,
    phase: phaseInfo.phase,
    thresholdEok: MIN_TRADING_VALUE_MILLION_WON / 100,
    relativeMultiplier: RELATIVE_MULTIPLIER,
    historyWindow: HISTORY_WINDOW,
    confirmationRatio: CONFIRMATION_RATIO,
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

  if (phaseInfo.phase === 'WAITING') return responsePayload(phaseInfo, '09:00부터 30억원 이상이면서 평소의 5배가 터지는 3분봉을 검색합니다.');
  if (phaseInfo.phase === 'CLOSED') return responsePayload(phaseInfo, '오늘 포착된 상대 거래대금 급증 종목입니다.');

  const barInfo = getBarInfo(phaseInfo);
  beginBar(barInfo, now);
  if (now.getTime() - memory.lastFetchAt >= FETCH_CACHE_MS) {
    if (!(await isKrxMarketOpen(phaseInfo.date, fetchImpl))) {
      return responsePayload(phaseInfo, '현재 정규장이 열리지 않았습니다. 휴장일이면 검색 결과가 생성되지 않습니다.');
    }
    const stocks = await fetchMarketLeaders(fetchImpl);
    await ensureMinuteHistories(stocks, phaseInfo, barInfo, fetchImpl);
    memory.lastFetchAt = now.getTime();
    updateCurrentBar(stocks, barInfo, now);
    saveSnapshot();
  }

  return responsePayload(phaseInfo, `${barInfo.label} 거래대금과 종목별 평소 대비 배수를 확인 중입니다. 신호는 3분봉 마감 후 확정됩니다.`);
}

module.exports = {
  MIN_TRADING_VALUE_MILLION_WON,
  RELATIVE_MULTIPLIER,
  HISTORY_WINDOW,
  CONFIRMATION_RATIO,
  parseQuantPage,
  parseMinuteHistory,
  getDynamicThreshold,
  getPhase,
  getBarInfo,
  isKrxMarketOpen,
  fetchMarketLeaders,
  getHamburgerStatus,
  resetMemoryForTests
};
