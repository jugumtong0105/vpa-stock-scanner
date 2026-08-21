(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlphaPrimeEngine = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function sma(data, period, field = 'close', endIndex = data.length - 1) {
    if (endIndex < period - 1) return null;
    return average(data.slice(endIndex - period + 1, endIndex + 1).map(row => Number(row[field]) || 0));
  }

  function pctChange(current, past) {
    return past > 0 ? (current / past - 1) * 100 : 0;
  }

  function atr(data, period = 14, endIndex = data.length - 1) {
    if (endIndex < period) return null;
    const ranges = [];
    for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
      const row = data[index];
      const previousClose = data[index - 1].close;
      ranges.push(Math.max(
        row.high - row.low,
        Math.abs(row.high - previousClose),
        Math.abs(row.low - previousClose)
      ));
    }
    return average(ranges);
  }

  function returnAt(data, lookback, endIndex = data.length - 1) {
    if (endIndex < lookback) return 0;
    return pctChange(data[endIndex].close, data[endIndex - lookback].close);
  }

  function getMarketRegime(data) {
    if (!Array.isArray(data) || data.length < 205) {
      return { code: 'UNKNOWN', label: '판정 불가', multiplier: 0.85, color: '#94a3b8', score: 0 };
    }
    const last = data.length - 1;
    const close = data[last].close;
    const ma50 = sma(data, 50);
    const ma200 = sma(data, 200);
    const ma200Past = sma(data, 200, 'close', last - 20);
    const return20 = returnAt(data, 20);
    if (close > ma50 && ma50 > ma200 && ma200 > ma200Past && return20 > 0) {
      return { code: 'RISK_ON', label: '공격 가능', multiplier: 1, color: '#22c55e', score: 10, close, ma50, ma200, return20 };
    }
    if (close > ma200 && ma200 >= ma200Past * 0.995) {
      return { code: 'NEUTRAL', label: '선별 대응', multiplier: 0.92, color: '#f59e0b', score: 5, close, ma50, ma200, return20 };
    }
    return { code: 'RISK_OFF', label: '현금 우선', multiplier: 0.78, color: '#ef4444', score: 0, close, ma50, ma200, return20 };
  }

  function gradeFor(score, marketCode, hasActionableSetup) {
    if (marketCode === 'RISK_ON' && score >= 85 && hasActionableSetup) return 'S급';
    if (marketCode !== 'RISK_OFF' && score >= 78) return 'A급';
    if (score >= 68) return 'B급';
    return '관찰';
  }

  function analyzeStock(rawData, stock, benchmarkData, options = {}) {
    const data = (rawData || []).filter(row => row && row.close > 0 && row.high > 0 && row.low > 0 && row.volume >= 0);
    if (data.length < 230) return null;
    const last = data.length - 1;
    const today = data[last];
    const yesterday = data[last - 1];
    const market = getMarketRegime(benchmarkData || []);
    const minAverageTradingValueEok = options.minAverageTradingValueEok ?? 30;

    const ma20 = sma(data, 20);
    const ma50 = sma(data, 50);
    const ma150 = sma(data, 150);
    const ma200 = sma(data, 200);
    const ma200Past = sma(data, 200, 'close', last - 20);
    const atr14 = atr(data, 14);
    if (![ma20, ma50, ma150, ma200, ma200Past, atr14].every(Number.isFinite)) return null;

    const trailing250 = data.slice(-250);
    const high52 = Math.max(...trailing250.map(row => row.high));
    const low52 = Math.min(...trailing250.map(row => row.low));
    const averageValue20 = average(data.slice(-21, -1).map(row => row.close * row.volume));
    const todayValue = today.close * today.volume;
    const averageVolume20 = average(data.slice(-21, -1).map(row => row.volume));
    const volumeRatio = averageVolume20 > 0 ? today.volume / averageVolume20 : 0;
    const averageValueEok = averageValue20 / 100_000_000;
    const todayValueEok = todayValue / 100_000_000;
    const atrPct = atr14 / today.close * 100;
    const distanceMa20Pct = pctChange(today.close, ma20);
    const distanceMa50Pct = pctChange(today.close, ma50);
    const highPosition = today.close / high52;

    const hardTrend = today.close > ma50 && ma50 > ma150 && ma150 > ma200 && ma200 > ma200Past;
    const liquid = averageValueEok >= minAverageTradingValueEok && todayValueEok >= 30;
    const healthyPosition = highPosition >= 0.80 && today.close >= low52 * 1.30;
    const notOverheated = distanceMa20Pct <= 15 && distanceMa50Pct <= 25 && atrPct <= 12;
    if (!hardTrend || !liquid || !healthyPosition || !notOverheated || today.close < 1_000) return null;

    const benchmarkReturns = {
      r20: returnAt(benchmarkData || [], 20),
      r60: returnAt(benchmarkData || [], 60),
      r120: returnAt(benchmarkData || [], 120)
    };
    const returns = { r20: returnAt(data, 20), r60: returnAt(data, 60), r120: returnAt(data, 120) };
    const relative = {
      r20: returns.r20 - benchmarkReturns.r20,
      r60: returns.r60 - benchmarkReturns.r60,
      r120: returns.r120 - benchmarkReturns.r120
    };

    let trendScore = 0;
    if (today.close > ma20 && ma20 > ma50) trendScore += 6;
    if (ma50 > ma150 && ma150 > ma200) trendScore += 7;
    if (ma200 > ma200Past) trendScore += 4;
    trendScore += highPosition >= 0.95 ? 3 : highPosition >= 0.90 ? 2 : 1;

    let momentumScore = 0;
    if (returns.r20 > 0) momentumScore += 4;
    if (returns.r20 >= 5 && returns.r20 <= 25) momentumScore += 3;
    if (returns.r60 >= 10) momentumScore += 5;
    if (returns.r120 >= 15) momentumScore += 5;
    if (returns.r20 > returns.r60 / 3) momentumScore += 3;
    momentumScore = Math.min(20, momentumScore);

    let relativeScore = 0;
    if (relative.r20 > 0) relativeScore += 5;
    if (relative.r20 >= 5) relativeScore += 2;
    if (relative.r60 > 0) relativeScore += 5;
    if (relative.r60 >= 10) relativeScore += 3;
    if (relative.r120 > 0) relativeScore += 5;
    relativeScore = Math.min(20, relativeScore);

    const recent20 = data.slice(-21, -1);
    const upVolume = recent20.filter(row => row.close >= row.open).reduce((sum, row) => sum + row.volume, 0);
    const downVolume = recent20.filter(row => row.close < row.open).reduce((sum, row) => sum + row.volume, 0);
    const accumulationRatio = downVolume > 0 ? upVolume / downVolume : 2;
    let volumeScore = 0;
    if (averageValueEok >= 50) volumeScore += 4;
    else if (averageValueEok >= 30) volumeScore += 2;
    if (accumulationRatio >= 1.15) volumeScore += 4;
    if (accumulationRatio >= 1.5) volumeScore += 2;
    if (volumeRatio >= 1.3 && volumeRatio <= 4) volumeScore += 5;
    else if (volumeRatio >= 0.8) volumeScore += 2;
    volumeScore = Math.min(15, volumeScore);

    const prior20High = Math.max(...data.slice(-21, -1).map(row => row.high));
    const tenDayHigh = Math.max(...data.slice(-10).map(row => row.high));
    const tenDayLow = Math.min(...data.slice(-10).map(row => row.low));
    const tenDayRangePct = pctChange(tenDayHigh, tenDayLow);
    const bullish = today.close > today.open && today.close > yesterday.close;
    const breakout = today.close >= prior20High * 0.995 && volumeRatio >= 1.3 && bullish;
    const touchedSupport = today.low <= ma20 * 1.02 || today.low <= ma50 * 1.02;
    const pullback = touchedSupport && bullish && today.close > ma20 && volumeRatio >= 0.8;
    const tight = tenDayRangePct <= 10 && highPosition >= 0.90;
    let setup = '추세 관찰';
    let setupScore = 4;
    if (breakout) { setup = '돌파 확인'; setupScore = 15; }
    else if (pullback) { setup = '눌림 반등'; setupScore = 13; }
    else if (tight) { setup = '신고가 수렴'; setupScore = 10; }
    else if (highPosition >= 0.90) { setup = '신고가 근접'; setupScore = 7; }

    const technicalStop = Math.max(ma50 * 0.99, today.close - atr14 * 2);
    const stopLoss = Math.min(technicalStop, today.close * 0.98);
    const riskPerShare = Math.max(1, today.close - stopLoss);
    const stopPct = riskPerShare / today.close * 100;
    let riskScore = 0;
    if (atrPct >= 1.5 && atrPct <= 6) riskScore += 4;
    else if (atrPct <= 9) riskScore += 2;
    if (stopPct >= 2 && stopPct <= 7) riskScore += 4;
    else if (stopPct <= 9) riskScore += 2;
    if (distanceMa20Pct <= 10) riskScore += 2;

    const rawScore = trendScore + momentumScore + relativeScore + volumeScore + setupScore + riskScore;
    const score = Math.round(Math.min(100, rawScore) * market.multiplier);
    const grade = gradeFor(score, market.code, breakout || pullback);
    if (score < (options.minimumScore ?? 60)) return null;

    const target2R = today.close + riskPerShare * 2;
    return {
      stock,
      score,
      rawScore,
      grade,
      setup,
      market,
      price: today.close,
      changeRate: pctChange(today.close, yesterday.close),
      todayValueEok,
      averageValueEok,
      volumeRatio,
      accumulationRatio,
      high52,
      highPositionPct: highPosition * 100,
      ma20,
      ma50,
      ma150,
      ma200,
      atrPct,
      stopLoss: Math.round(stopLoss),
      stopPct,
      target2R: Math.round(target2R),
      returns,
      relative,
      scores: {
        trend: trendScore,
        momentum: momentumScore,
        relative: relativeScore,
        volume: volumeScore,
        setup: setupScore,
        risk: riskScore
      },
      date: today.date
    };
  }

  function applySectorLeadership(signals, minimumScore = 60) {
    const groups = new Map();
    for (const signal of signals || []) {
      const sector = signal.stock?.sector || '업종 미분류';
      if (!groups.has(sector)) groups.set(sector, []);
      groups.get(sector).push(signal);
    }
    return (signals || []).map(signal => {
      const sector = signal.stock?.sector || '업종 미분류';
      const peers = groups.get(sector) || [];
      const averageRelative60 = average(peers.map(peer => peer.relative.r60));
      let sectorBonus = 0;
      if (sector !== '업종 미분류' && peers.length >= 3 && averageRelative60 >= 5) sectorBonus = 7;
      else if (sector !== '업종 미분류' && peers.length >= 2 && averageRelative60 > 0) sectorBonus = 4;
      const score = Math.min(100, signal.score + sectorBonus);
      return {
        ...signal,
        score,
        grade: gradeFor(score, signal.market.code, signal.setup === '돌파 확인' || signal.setup === '눌림 반등'),
        sector,
        sectorBonus,
        sectorBreadth: peers.length,
        sectorRelative60: averageRelative60
      };
    }).filter(signal => signal.score >= minimumScore);
  }

  function calculatePosition(signal, capitalWon, riskPercent = 0.5, maxPositionPercent = 25) {
    if (!signal || !signal.price || !signal.stopLoss || capitalWon <= 0) return { shares: 0, positionWon: 0, maxLossWon: 0 };
    const maxLossWon = capitalWon * riskPercent / 100;
    const riskPerShare = Math.max(1, signal.price - signal.stopLoss);
    const riskShares = Math.floor(maxLossWon / riskPerShare);
    const capShares = Math.floor(capitalWon * maxPositionPercent / 100 / signal.price);
    const shares = Math.max(0, Math.min(riskShares, capShares));
    return { shares, positionWon: shares * signal.price, maxLossWon: shares * riskPerShare };
  }

  return { average, sma, atr, returnAt, getMarketRegime, analyzeStock, applySectorLeadership, calculatePosition };
}));
