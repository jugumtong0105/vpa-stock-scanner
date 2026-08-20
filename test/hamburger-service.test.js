const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuantPage, getPhase, isKrxMarketOpen, getHamburgerStatus, finalizeIfNeeded, THRESHOLD_MILLION_WON } = require('../hamburger-service');

test('네이버 거래량 표에서 거래대금을 백만원 단위로 읽는다', () => {
  const html = `
    <table><tr>
      <td class="no">1</td>
      <td><a href="/item/main.naver?code=005930" class="tltle">삼성전자</a></td>
      <td class="number">271,000</td>
      <td class="number"><span>23,500</span></td>
      <td class="number"><span>+9.49%</span></td>
      <td class="number">26,093,355</td>
      <td class="number">6,960,702</td>
      <td class="number">270,500</td><td class="number">271,000</td>
    </tr></table>`;
  const rows = parseQuantPage(html, 'KOSPI');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, '005930');
  assert.equal(rows[0].tradingValueMillion, 6_960_702);
  assert.equal(rows[0].tradingValueEok, 69_607);
  assert.equal(rows[0].changeRate, 9.49);
});

test('ETF와 레버리지 상품을 표시한다', () => {
  const html = `<tr><td><a href="/item/main.naver?code=252670" class="tltle">KODEX 200선물인버스2X</a></td>${
    ['76','12','-13.64%','11749610712','917583'].map(value => `<td class="number">${value}</td>`).join('')
  }</tr>`;
  assert.equal(parseQuantPage(html, 'KOSPI')[0].isFund, true);
});

test('500억원 기준은 네이버 표의 50,000백만원이다', () => {
  assert.equal(THRESHOLD_MILLION_WON, 50_000);
});

test('서울 시간 기준 첫 3분봉 구간을 구분한다', () => {
  assert.equal(getPhase(new Date('2026-08-20T08:59:59+09:00')).phase, 'WAITING');
  assert.equal(getPhase(new Date('2026-08-20T09:00:00+09:00')).phase, 'SCANNING');
  assert.equal(getPhase(new Date('2026-08-20T09:02:59+09:00')).phase, 'SCANNING');
  assert.equal(getPhase(new Date('2026-08-20T09:03:00+09:00')).phase, 'LOCKED');
});

test('정규장 상태와 거래일이 모두 맞을 때만 시장이 열린 것으로 본다', async () => {
  const mock = quote => async () => ({ ok: true, json: async () => ({ datas: [quote] }) });
  assert.equal(await isKrxMarketOpen('2026-08-20', mock({ marketStatus: 'OPEN', localTradedAt: '2026-08-20T09:01:00+09:00' })), true);
  assert.equal(await isKrxMarketOpen('2026-08-20', mock({ marketStatus: 'CLOSE', localTradedAt: '2026-08-20T15:30:00+09:00' })), false);
  assert.equal(await isKrxMarketOpen('2026-08-20', mock({ marketStatus: 'OPEN', localTradedAt: '2026-08-19T15:30:00+09:00' })), false);
});

test('첫 3분 중 500억원 이상 일반 주식만 결과로 확정한다', async () => {
  const stockRow = (code, name, value) => `<tr><td><a href="/item/main.naver?code=${code}" class="tltle">${name}</a></td>${
    ['10000', '100', '+1.00%', '1000000', String(value)].map(item => `<td class="number">${item}</td>`).join('')
  }</tr>`;
  const html = `${stockRow('111111', 'ALPHA', 50_001)}${stockRow('222222', 'KODEX TEST', 80_000)}${stockRow('333333', 'BETA', 49_999)}`;
  const fetchImpl = async url => url.includes('polling.finance.naver.com')
    ? { ok: true, json: async () => ({ datas: [{ marketStatus: 'OPEN', localTradedAt: '2026-08-21T09:01:00+09:00' }] }) }
    : { ok: true, arrayBuffer: async () => Buffer.from(html) };

  const scanning = await getHamburgerStatus({ now: new Date('2026-08-21T09:01:00+09:00'), fetchImpl });
  assert.deepEqual(scanning.rows.map(row => row.code), ['111111']);
  finalizeIfNeeded(new Date('2026-08-21T09:03:00+09:00'));
  const locked = await getHamburgerStatus({ now: new Date('2026-08-21T09:03:01+09:00'), fetchImpl });
  assert.equal(locked.locked, true);
  assert.deepEqual(locked.rows.map(row => row.code), ['111111']);
});
