const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../public/js/alpha-prime-engine');

function buildSeries({ days = 280, start = 10_000, dailyGrowth = 0.002, volume = 1_000_000, breakout = false } = {}) {
  const rows = [];
  let close = start;
  const begin = new Date('2025-01-02T00:00:00Z');
  for (let index = 0; index < days; index += 1) {
    close *= 1 + dailyGrowth + Math.sin(index / 9) * 0.0008;
    const open = close * (1 - 0.003);
    const date = new Date(begin.getTime() + index * 86400000).toISOString().slice(0, 10).replaceAll('-', '');
    rows.push({ date, open, high: close * 1.008, low: open * 0.994, close, volume });
  }
  if (breakout) {
    const last = rows.at(-1);
    last.open = rows.at(-2).close * 1.002;
    last.close = rows.at(-2).high * 1.015;
    last.high = last.close * 1.006;
    last.low = last.open * 0.995;
    last.volume = volume * 2;
  }
  return rows;
}

test('시장 국면을 공격 가능·현금 우선으로 구분한다', () => {
  const strong = buildSeries({ dailyGrowth: 0.001 });
  const weak = buildSeries({ dailyGrowth: -0.001 });
  assert.equal(Engine.getMarketRegime(strong).code, 'RISK_ON');
  assert.equal(Engine.getMarketRegime(weak).code, 'RISK_OFF');
});

test('상승추세·상대강도·유동성·돌파를 갖춘 종목을 종합 점수화한다', () => {
  const stockData = buildSeries({ dailyGrowth: 0.0022, volume: 1_500_000, breakout: true });
  const benchmark = buildSeries({ dailyGrowth: 0.0007, volume: 1_000_000 });
  const result = Engine.analyzeStock(stockData, { code: '123456', name: '테스트리더', market: 'KOSPI' }, benchmark);
  assert.ok(result);
  assert.ok(result.score >= 68);
  assert.ok(result.relative.r60 > 0);
  assert.equal(result.setup, '돌파 확인');
  assert.ok(result.stopLoss < result.price);
  assert.ok(result.target2R > result.price);
});

test('하락추세 종목은 높은 거래량이 있어도 제외한다', () => {
  const stockData = buildSeries({ dailyGrowth: -0.0008, volume: 5_000_000, breakout: true });
  const benchmark = buildSeries({ dailyGrowth: 0.0007 });
  assert.equal(Engine.analyzeStock(stockData, { code: '654321', name: '하락종목', market: 'KOSPI' }, benchmark), null);
});

test('계좌 위험과 종목당 최대 비중 중 더 작은 수량을 사용한다', () => {
  const position = Engine.calculatePosition({ price: 10_000, stopLoss: 9_500 }, 100_000_000, 0.5, 25);
  assert.equal(position.shares, 1_000);
  assert.equal(position.positionWon, 10_000_000);
  assert.equal(position.maxLossWon, 500_000);
});

test('같은 업종의 강한 후보가 둘 이상일 때만 섹터 가점을 준다', () => {
  const base = {
    score: 58,
    grade: '관찰',
    setup: '신고가 수렴',
    market: { code: 'RISK_ON' },
    relative: { r60: 12 }
  };
  const ranked = Engine.applySectorLeadership([
    { ...base, stock: { code: '111111', sector: '반도체' } },
    { ...base, stock: { code: '222222', sector: '반도체' } },
    { ...base, stock: { code: '333333', sector: '자동차' } }
  ], 60);
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every(row => row.sector === '반도체' && row.sectorBonus === 4 && row.score === 62));
});
