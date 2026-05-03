import axios from "axios";
import { baseurl, publicbaseurl, ticker, market_details } from "../Constant.js";
import { sendEmail } from "../Email.js";
import { sendLogs } from "../firebase.js";
import { prefix, getNowDate, getTime } from "../hike.js";

const DEFAULT_CONFIG = {
    quoteAssets: ["INR", "USDT"],
    maxMarketsPerPoll: 35,
    tickerPollMs: 60 * 1000,
    candleInterval: "15m",
    candleLimit: 120,
    min24hVolume: 0,
    maxSpreadPercent: 1.2,
    minSignalScore: 94,
    minPrice: 0.05,
    minAtrPercent: 0.35,
    maxAtrPercent: 6,
    maxDistanceFromEma55Percent: 7,
    minVolumeExpansion: 2.0,
    excludedMarkets: ["FDUSDUSDT", "USDCUSDT", "TUSDUSDT", "DAIUSDT", "USDTUSDT"],
    stopLossAtrMultiplier: 1.8,
    takeProfitAtrMultiplier: 2.7,
    maxHoldMs: 18 * 60 * 60 * 1000,
    cooldownMs: 4 * 60 * 60 * 1000,
    riskPerTradePercent: 1,
    mockCapital: 10000,
};

const state = {
    marketPairs: new Map(),
    openPositions: new Map(),
    cooldowns: new Map(),
    lastSignals: [],
    pollTimer: null,
};

export async function startAdvancedPolling(overrides = {}) {
    const config = { ...DEFAULT_CONFIG, ...overrides };

    if (state.pollTimer) {
        sendLogs(`${prefix("algo2k26")} polling is already running`);
        return state.pollTimer;
    }

    await pollOnce(config);
    state.pollTimer = setInterval(() => pollOnce(config), config.tickerPollMs);
    sendLogs(`${prefix("algo2k26")} started CoinDCX polling every ${config.tickerPollMs / 1000}s`);
    return state.pollTimer;
}

export function stopAdvancedPolling() {
    if (!state.pollTimer) return;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    sendLogs(`${prefix("algo2k26")} stopped CoinDCX polling`);
}

export function getAdvancedAlgoState() {
    return {
        openPositions: Object.fromEntries(state.openPositions),
        cooldowns: Object.fromEntries(state.cooldowns),
        lastSignals: state.lastSignals.slice(0, 20),
    };
}

export async function pollOnce(overrides = {}) {
    const config = { ...DEFAULT_CONFIG, ...overrides };

    try {
        await ensureMarketPairs();
        const tickers = await fetchTickers();
        const candidates = pickLiquidCandidates(tickers, config);

        for (const tickerData of candidates) {
            const market = tickerData.market;
            const pair = state.marketPairs.get(market);
            if (!pair || isCoolingDown(market, config)) continue;

            const candles = await fetchCandles(pair, config.candleInterval, config.candleLimit);
            if (candles.length < 60) continue;

            const orderBook = await fetchOrderBook(pair);
            const signal = buildSignal({ tickerData, candles, orderBook, config });
            rememberSignal(signal);

            if (state.openPositions.has(market)) {
                manageOpenPosition(market, signal, config);
                continue;
            }

            if (signal.action === "BUY" && signal.score >= config.minSignalScore) {
                mockBuy(market, signal, config);
            }
        }
    } catch (err) {
        sendLogs(`${prefix("algo2k26")} poll error: ${err.message}`);
        console.error("algo2k26 poll error:", err);
    }
}

async function ensureMarketPairs() {
    if (state.marketPairs.size > 0) return;

    const { data } = await axios.get(`${baseurl}${market_details}`, { timeout: 15000 });
    for (const item of data) {
        const marketName = item.coindcx_name || item.symbol || item.market || item.name;
        if (!marketName || !item.pair) continue;
        state.marketPairs.set(marketName, item.pair);
    }

    sendLogs(`${prefix("algo2k26")} loaded ${state.marketPairs.size} CoinDCX market pairs`);
}

async function fetchTickers() {
    const { data } = await axios.get(`${baseurl}${ticker}`, { timeout: 15000 });
    return data;
}

async function fetchCandles(pair, interval, limit) {
    const url = `${publicbaseurl}/market_data/candles`;
    const { data } = await axios.get(url, {
        params: { pair, interval, limit },
        timeout: 15000,
    });

    return data
        .map((candle) => ({
            open: Number(candle.open),
            high: Number(candle.high),
            low: Number(candle.low),
            close: Number(candle.close),
            volume: Number(candle.volume),
            time: Number(candle.time),
        }))
        .filter((candle) => Number.isFinite(candle.close))
        .sort((a, b) => a.time - b.time);
}

async function fetchOrderBook(pair) {
    const { data } = await axios.get(`${publicbaseurl}/market_data/orderbook`, {
        params: { pair },
        timeout: 15000,
    });
    return data;
}

function pickLiquidCandidates(tickers, config) {
    return tickers
        .filter((item) => {
            const market = item.market || "";
            const lastPrice = Number(item.last_price);
            const volume = Number(item.volume || 0);
            return (
                Number.isFinite(lastPrice) &&
                lastPrice > 0 &&
                lastPrice >= config.minPrice &&
                volume >= config.min24hVolume &&
                config.quoteAssets.some((quote) => market.endsWith(quote)) &&
                state.marketPairs.has(market)
                && !config.excludedMarkets.includes(market)
            );
        })
        .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
        .slice(0, config.maxMarketsPerPoll);
}

function buildSignal({ tickerData, candles, orderBook, config }) {
    const closes = candles.map((candle) => candle.close);
    const highs = candles.map((candle) => candle.high);
    const lows = candles.map((candle) => candle.low);
    const volumes = candles.map((candle) => candle.volume);
    const last = closes.at(-1);

    const emaFast = ema(closes, 9);
    const emaSlow = ema(closes, 21);
    const emaTrend = ema(closes, 55);
    const rsi14 = rsi(closes, 14);
    const macdData = macd(closes);
    const bands = bollinger(closes, 20, 2);
    const atr14 = atr(highs, lows, closes, 14);
    const ema55 = emaTrend.at(-1);
    const distanceFromEma55 = ((last - ema55) / ema55) * 100;
    const atrPercent = (atr14 / last) * 100;
    const currentVolume = volumes.at(-1) || 0;
    const averageVolume = sma(volumes.slice(-20));
    const spreadPercent = getSpreadPercent(orderBook);
    const momentum = percentChange(closes.at(-1), closes.at(-5));
    const trendSlope = percentChange(emaTrend.at(-1), emaTrend.at(-6));

    let score = 0;
    const reasons = [];

    if (emaFast.at(-1) > emaSlow.at(-1) && emaSlow.at(-1) > emaTrend.at(-1)) {
        score += 22;
        reasons.push("EMA trend aligned");
    }

    if (rsi14 >= 50 && rsi14 <= 64) {
        score += 16;
        reasons.push(`RSI healthy (${rsi14.toFixed(1)})`);
    } else if (rsi14 > 72) {
        score -= 18;
        reasons.push(`RSI overbought (${rsi14.toFixed(1)})`);
    }

    if (macdData.histogram.at(-1) > 0 && macdData.macdLine.at(-1) > macdData.signalLine.at(-1)) {
        score += 16;
        reasons.push("MACD bullish");
    }

    if (last > bands.middle && last < bands.upper * 1.015) {
        score += 12;
        reasons.push("Bollinger breakout without extension");
    }

    if (currentVolume > averageVolume * config.minVolumeExpansion) {
        score += 14;
        reasons.push("volume expansion");
    }

    if (momentum > 0.4 && momentum < 5.5) {
        score += 10;
        reasons.push(`controlled momentum (${momentum.toFixed(2)}%)`);
    }

    if (distanceFromEma55 > 1.2 && distanceFromEma55 < config.maxDistanceFromEma55Percent) {
        score += 8;
        reasons.push("price above 55 EMA");
    }

    if (trendSlope > 0.25) {
        score += 8;
        reasons.push(`55 EMA rising (${trendSlope.toFixed(2)}%)`);
    }

    if (spreadPercent > config.maxSpreadPercent) {
        score -= 25;
        reasons.push(`wide spread (${spreadPercent.toFixed(2)}%)`);
    }

    if (atrPercent < config.minAtrPercent || atrPercent > config.maxAtrPercent) {
        score -= 22;
        reasons.push(`bad ATR range (${atrPercent.toFixed(2)}%)`);
    }

    const action = score >= config.minSignalScore ? "BUY" : "WATCH";
    return {
        action,
        market: tickerData.market,
        price: Number(tickerData.last_price),
        score: Math.max(0, Math.min(100, Math.round(score))),
        reasons,
        atr: atr14,
        rsi: rsi14,
        spreadPercent,
        stopLoss: roundPrice(last - atr14 * config.stopLossAtrMultiplier),
        takeProfit: roundPrice(last + atr14 * config.takeProfitAtrMultiplier),
        trailingStop: roundPrice(last - atr14 * config.stopLossAtrMultiplier),
        time: getTime(),
    };
}

function manageOpenPosition(market, signal, config) {
    const position = state.openPositions.get(market);
    const price = signal.price;
    const highestPrice = Math.max(position.highestPrice, price);
    const trailingStop = Math.max(position.trailingStop, highestPrice - signal.atr * config.stopLossAtrMultiplier);
    const pnlPercent = percentChange(price, position.entryPrice);
    const heldMs = getNowDate() - position.entryTime;

    state.openPositions.set(market, { ...position, highestPrice, trailingStop });

    if (price <= trailingStop) {
        mockSell(market, price, `ATR trailing stop hit. PnL ${pnlPercent.toFixed(2)}%`);
        return;
    }

    if (price >= position.takeProfit) {
        mockSell(market, price, `ATR take profit hit. PnL ${pnlPercent.toFixed(2)}%`);
        return;
    }

    if (heldMs > config.maxHoldMs && pnlPercent <= 0) {
        mockSell(market, price, `time exit. PnL ${pnlPercent.toFixed(2)}%`);
        return;
    }

    if (signal.score < 38 && pnlPercent > 0) {
        mockSell(market, price, `trend weakened. PnL ${pnlPercent.toFixed(2)}%`);
    }
}

function mockBuy(market, signal, config) {
    const riskAmount = config.mockCapital * (config.riskPerTradePercent / 100);
    const perUnitRisk = Math.max(signal.price - signal.stopLoss, signal.price * 0.01);
    const quantity = roundQuantity(riskAmount / perUnitRisk);

    state.openPositions.set(market, {
        entryPrice: signal.price,
        entryTime: getNowDate(),
        highestPrice: signal.price,
        trailingStop: signal.trailingStop,
        takeProfit: signal.takeProfit,
        quantity,
        score: signal.score,
    });

    const message = `MOCK BUY ${market} at ${signal.price}. Score ${signal.score}. SL ${signal.stopLoss}, TP ${signal.takeProfit}. Reasons: ${signal.reasons.join(", ")}`;
    sendEmail(message);
    sendLogs(`${prefix(market)} ${message}`);
}

function mockSell(market, price, reason) {
    const position = state.openPositions.get(market);
    if (!position) return;

    const pnlPercent = percentChange(price, position.entryPrice);
    const message = `MOCK SELL ${market} at ${price}. ${reason}. Entry ${position.entryPrice}, PnL ${pnlPercent.toFixed(2)}%`;
    sendEmail(message);
    sendLogs(`${prefix(market)} ${message}`);
    state.openPositions.delete(market);
    state.cooldowns.set(market, getNowDate());
}

function rememberSignal(signal) {
    state.lastSignals.unshift(signal);
    if (state.lastSignals.length > 100) state.lastSignals.pop();
}

function isCoolingDown(market, config) {
    const lastExit = state.cooldowns.get(market);
    if (!lastExit) return false;
    if (getNowDate() - lastExit < config.cooldownMs) return true;
    state.cooldowns.delete(market);
    return false;
}

function ema(values, period) {
    const multiplier = 2 / (period + 1);
    const result = [];
    let previous = values[0];

    for (const value of values) {
        previous = value * multiplier + previous * (1 - multiplier);
        result.push(previous);
    }

    return result;
}

function rsi(values, period) {
    if (values.length <= period) return 50;

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = values[i] - values[i - 1];
        if (change >= 0) gains += change;
        else losses -= change;
    }

    let averageGain = gains / period;
    let averageLoss = losses / period;

    for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];
        averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
        averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    }

    if (averageLoss === 0) return 100;
    const rs = averageGain / averageLoss;
    return 100 - 100 / (1 + rs);
}

function macd(values) {
    const fast = ema(values, 12);
    const slow = ema(values, 26);
    const macdLine = fast.map((value, index) => value - slow[index]);
    const signalLine = ema(macdLine, 9);
    const histogram = macdLine.map((value, index) => value - signalLine[index]);
    return { macdLine, signalLine, histogram };
}

function bollinger(values, period, deviations) {
    const slice = values.slice(-period);
    const middle = sma(slice);
    const variance = slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / slice.length;
    const deviation = Math.sqrt(variance);
    return {
        lower: middle - deviation * deviations,
        middle,
        upper: middle + deviation * deviations,
    };
}

function atr(highs, lows, closes, period) {
    const trueRanges = [];
    for (let i = 1; i < highs.length; i++) {
        trueRanges.push(Math.max(
            highs[i] - lows[i],
            Math.abs(highs[i] - closes[i - 1]),
            Math.abs(lows[i] - closes[i - 1]),
        ));
    }
    return sma(trueRanges.slice(-period));
}

function sma(values) {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

function getSpreadPercent(orderBook) {
    const bids = Object.keys(orderBook?.bids || {}).map(Number).filter(Number.isFinite);
    const asks = Object.keys(orderBook?.asks || {}).map(Number).filter(Number.isFinite);
    if (!bids.length || !asks.length) return 100;
    const bestBid = Math.max(...bids);
    const bestAsk = Math.min(...asks);
    const mid = (bestBid + bestAsk) / 2;
    return ((bestAsk - bestBid) / mid) * 100;
}

function percentChange(current, previous) {
    if (!previous) return 0;
    return ((current - previous) / previous) * 100;
}

function roundPrice(value) {
    if (!Number.isFinite(value)) return 0;
    return Number(value.toPrecision(8));
}

function roundQuantity(value) {
    if (!Number.isFinite(value)) return 0;
    return Number(value.toFixed(8));
}
