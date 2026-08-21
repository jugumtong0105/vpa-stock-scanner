const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseQuantPage,
  getPhase,
  getBarInfo,
  isKrxMarketOpen,
  getHamburgerStatus,
  THRESHOLD_MILLION_WON
} = require('../hamburger-service');

test('네이버 거래량 표에서 누적 거래대금을 백만원 단위로 읽는다', () => {
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
  assert.equal(rows[0].accumulatedTradingValueMillion, 6_960_702);
  assert.equal(rows[0].changeRate, 9.49);
});

test('ETF와 레버리지 상품을 표시한다', () => {
  const html = `<tr><td><a href="/item/main.naver?code=252670" class="tltle">KODEX 200선물인버스2X</a></td>${
    ['76', '12', '-13.64%', '11749610712', '917583'].map(value => `<td class="number">${value}</td>`).join('')
  }</tr>`;
  assert.equal(parseQuantPage(html, 'KOSPI')[0].isFund, true);
});

test('300억원 기준은 네이버 표의 30,000백만원이다', () => {
  assert.equal(THRESHOLD_MILLION_WON, 30_000);
});

test('정규장 전체를 검색 구간으로 구분한다', () => {
  assert.equal(getPhase(new Date('2026-08-24T08:59:59+09:00')).phase, 'WAITING');
  assert.equal(getPhase(new Date('2026-08-24T09:00:00+09:00')).phase, 'SCANNING');
  assert.equal(getPhase(new Date('2026-08-24T12:15:00+09:00')).phase, 'SCANNING');
  assert.equal(getPhase(new Date('2026-08-24T15:29:59+09:00')).phase, 'SCANNING');
  assert.equal(getPhase(new Date('2026-08-24T15:30:00+09:00')).phase, 'CLOSED');
});

test('장중 시간을 정렬된 3분봉으로 나눈다', () => {
  const first = getBarInfo(getPhase(new Date('2026-08-24T09:02:59+09:00')));
  const second = getBarInfo(getPhase(new Date('2026-08-24T09:03:00+09:00')));
  const midday = getBarInfo(getPhase(new Date('2026-08-24T12:16:40+09:00')));
  assert.equal(first.label, '09:00~09:03');
  assert.equal(second.label, '09:03~09:06');
  assert.equal(midday.label, '12:15~12:18');
});

test('정규장 상태와 거래일이 모두 맞을 때만 시장이 열린 것으로 본다', async () => {
  const mock = quote => async () => ({ ok: true, json: async () => ({ datas: [quote] }) });
  assert.equal(await isKrxMarketOpen('2026-08-24', mock({ marketStatus: 'OPEN', localTradedAt: '2026-08-24T09:01:00+09:00' })), true);
  assert.equal(await isKrxMarketOpen('2026-08-24', mock({ marketStatus: 'CLOSE', localTradedAt: '2026-08-24T15:30:00+09:00' })), false);
  assert.equal(await isKrxMarketOpen('2026-08-24', mock({ marketStatus: 'OPEN', localTradedAt: '2026-08-21T15:30:00+09:00' })), false);
});

test('각 3분봉의 누적 거래대금 차이가 300억원을 넘을 때마다 포착한다', async () => {
  let accumulated = 10_000;
  const stockRow = (code, name, value) => `<tr><td><a href="/item/main.naver?code=${code}" class="tltle">${name}</a></td>${
    ['10000', '100', '+1.00%', '1000000', String(value)].map(item => `<td class="number">${item}</td>`).join('')
  }</tr>`;
  const fetchImpl = async url => {
    if (url.includes('polling.finance.naver.com')) {
      return { ok: true, json: async () => ({ datas: [{ marketStatus: 'OPEN', localTradedAt: '2026-08-24T09:01:00+09:00' }] }) };
    }
    const html = `${stockRow('111111', 'ALPHA', accumulated)}${stockRow('222222', 'KODEX TEST', accumulated + 50_000)}`;
    return { ok: true, arrayBuffer: async () => Buffer.from(html) };
  };

  let result = await getHamburgerStatus({ now: new Date('2026-08-24T09:00:01+09:00'), fetchImpl });
  assert.equal(result.rows.length, 0);

  accumulated = 30_100;
  result = await getHamburgerStatus({ now: new Date('2026-08-24T09:02:00+09:00'), fetchImpl });
  assert.deepEqual(result.rows.map(row => row.barLabel), ['09:00~09:03']);
  assert.equal(result.rows[0].tradingValueMillion, 30_100);

  accumulated = 31_000;
  result = await getHamburgerStatus({ now: new Date('2026-08-24T09:03:01+09:00'), fetchImpl });
  assert.equal(result.activeRows.length, 0);

  accumulated = 61_500;
  result = await getHamburgerStatus({ now: new Date('2026-08-24T09:05:30+09:00'), fetchImpl });
  assert.equal(result.rows.length, 2);
  assert.deepEqual(result.rows.map(row => row.barLabel), ['09:03~09:06', '09:00~09:03']);
  assert.equal(result.rows[0].tradingValueMillion, 30_500);
  assert.ok(result.rows.every(row => row.code === '111111'));
});
