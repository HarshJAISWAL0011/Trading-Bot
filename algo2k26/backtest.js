import axios from "axios";

const BASE = "https://api.coindcx.com";
const PUBLIC = "https://public.coindcx.com";
const CANDLE_INTERVAL = "15m";
const CANDLE_LIMIT = 1000;
const TOP_N = 15;
const INITIAL_CAPITAL = 100000;
const POSITION_PCT = 0.10;
const FEE_PER_SIDE = 0.002;
const SLIPPAGE_PER_SIDE = 0.001;
const MIN_SCORE = Number(process.env.MIN_SCORE || 94);
const MIN_PRICE = Number(process.env.MIN_PRICE || 0.05);
const MIN_ATR_PERCENT = Number(process.env.MIN_ATR_PERCENT || 0.35);
const MAX_ATR_PERCENT = Number(process.env.MAX_ATR_PERCENT || 6);
const MAX_DISTANCE_FROM_EMA55_PERCENT = Number(process.env.MAX_DISTANCE_FROM_EMA55_PERCENT || 7);
const MIN_VOLUME_EXPANSION = Number(process.env.MIN_VOLUME_EXPANSION || 2.0);
const EXCLUDED_MARKETS = ["FDUSDUSDT", "USDCUSDT", "TUSDUSDT", "DAIUSDT", "USDTUSDT"];
const ATR_STOP = 1.8;
const ATR_TP = 2.7;
const MAX_HOLD = 72;
const COOLDOWN = 16;

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

function sma(values) {
    return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0;
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
    const line = fast.map((value, index) => value - slow[index]);
    const signal = ema(line, 9);
    const histogram = line.map((value, index) => value - signal[index]);
    return { line, signal, histogram };
}

function bollinger(values, period, deviations) {
    const slice = values.slice(-period);
    const middle = sma(slice);
    const variance = slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / slice.length;
    const deviation = Math.sqrt(variance);
    return {
        lower: middle - deviations * deviation,
        middle,
        upper: middle + deviations * deviation,
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

function percentChange(current, previous) {
    return previous ? ((current - previous) / previous) * 100 : 0;
}

function scoreAt(window) {
    const closes = window.map((candle) => candle.close);
    const highs = window.map((candle) => candle.high);
    const lows = window.map((candle) => candle.low);
    const volumes = window.map((candle) => candle.volume);
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
    const momentum = percentChange(closes.at(-1), closes.at(-5));
    const trendSlope = percentChange(emaTrend.at(-1), emaTrend.at(-6));

    let score = 0;
    if (emaFast.at(-1) > emaSlow.at(-1) && emaSlow.at(-1) > emaTrend.at(-1)) score += 22;
    if (rsi14 >= 50 && rsi14 <= 64) score += 16;
    else if (rsi14 > 72) score -= 18;
    if (macdData.histogram.at(-1) > 0 && macdData.line.at(-1) > macdData.signal.at(-1)) score += 16;
    if (last > bands.middle && last < bands.upper * 1.015) score += 12;
    if (currentVolume > averageVolume * MIN_VOLUME_EXPANSION) score += 14;
    if (momentum > 0.4 && momentum < 5.5) score += 10;
    if (distanceFromEma55 > 1.2 && distanceFromEma55 < MAX_DISTANCE_FROM_EMA55_PERCENT) score += 8;
    if (trendSlope > 0.25) score += 8;
    if (atrPercent < MIN_ATR_PERCENT || atrPercent > MAX_ATR_PERCENT) score -= 22;

    return { score: Math.max(0, Math.min(100, Math.round(score))), atr: atr14 };
}

async function getJson(url, params) {
    const { data } = await axios.get(url, { params, timeout: 20000 });
    return data;
}

async function main() {
    const tickers = await getJson(`${BASE}/exchange/ticker`);
    const details = await getJson(`${BASE}/exchange/v1/markets_details`);
    const pairMap = new Map(details
        .map((item) => [item.coindcx_name || item.symbol || item.market || item.name, item.pair])
        .filter(([market, pair]) => market && pair));

    const candidates = tickers
        .filter((item) => (
            item.market?.endsWith("USDT")
            && pairMap.has(item.market)
            && Number(item.last_price) >= MIN_PRICE
            && !EXCLUDED_MARKETS.includes(item.market)
        ))
        .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
        .slice(0, TOP_N);

    let capital = INITIAL_CAPITAL;
    const allTrades = [];
    const perMarket = [];

    for (const ticker of candidates) {
        const pair = pairMap.get(ticker.market);
        const rawCandles = await getJson(`${PUBLIC}/market_data/candles`, {
            pair,
            interval: CANDLE_INTERVAL,
            limit: CANDLE_LIMIT,
        });

        const candles = rawCandles
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

        let position = null;
        let cooldownUntil = -1;
        const trades = [];

        for (let i = 60; i < candles.length; i++) {
            const window = candles.slice(0, i + 1);
            const candle = candles[i];
            const signal = scoreAt(window);

            if (position) {
                position.highest = Math.max(position.highest, candle.close);
                position.trailing = Math.max(position.trailing, position.highest - signal.atr * ATR_STOP);

                let reason = null;
                let exit = candle.close;
                if (candle.low <= position.trailing) {
                    reason = "trail";
                    exit = position.trailing;
                } else if (candle.high >= position.takeProfit) {
                    reason = "take_profit";
                    exit = position.takeProfit;
                } else if (i - position.entryIndex >= MAX_HOLD && candle.close <= position.entry) {
                    reason = "time";
                } else if (signal.score < 38 && candle.close > position.entry) {
                    reason = "weak_trend";
                }

                if (reason) {
                    const gross = (exit - position.entry) / position.entry;
                    const net = gross - 2 * (FEE_PER_SIDE + SLIPPAGE_PER_SIDE);
                    const pnl = position.size * net;
                    capital += pnl;

                    const trade = {
                        market: ticker.market,
                        entryTime: new Date(position.time).toISOString(),
                        exitTime: new Date(candle.time).toISOString(),
                        entry: position.entry,
                        exit,
                        netPct: net * 100,
                        pnl,
                        reason,
                        holdCandles: i - position.entryIndex,
                    };
                    trades.push(trade);
                    allTrades.push(trade);
                    position = null;
                    cooldownUntil = i + COOLDOWN;
                }
            } else if (i >= cooldownUntil && signal.score >= MIN_SCORE) {
                const size = capital * POSITION_PCT;
                position = {
                    entry: candle.close,
                    time: candle.time,
                    entryIndex: i,
                    size,
                    highest: candle.close,
                    trailing: candle.close - signal.atr * ATR_STOP,
                    takeProfit: candle.close + signal.atr * ATR_TP,
                };
            }
        }

        perMarket.push({
            market: ticker.market,
            pair,
            candles: candles.length,
            trades: trades.length,
            pnl: trades.reduce((sum, trade) => sum + trade.pnl, 0),
            wins: trades.filter((trade) => trade.pnl > 0).length,
        });
    }

    const wins = allTrades.filter((trade) => trade.pnl > 0).length;
    const totalPnl = allTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const averageNetPct = allTrades.length
        ? allTrades.reduce((sum, trade) => sum + trade.netPct, 0) / allTrades.length
        : 0;
    const exitReasons = {};
    for (const trade of allTrades) {
        exitReasons[trade.reason] = (exitReasons[trade.reason] || 0) + 1;
    }

    console.log(JSON.stringify({
        assumptions: {
            initialCapital: INITIAL_CAPITAL,
            positionPct: POSITION_PCT,
            feePerSide: FEE_PER_SIDE,
            slippagePerSide: SLIPPAGE_PER_SIDE,
            interval: CANDLE_INTERVAL,
            candleLimit: CANDLE_LIMIT,
            topMarkets: TOP_N,
            minScore: MIN_SCORE,
            minPrice: MIN_PRICE,
            minAtrPercent: MIN_ATR_PERCENT,
            maxAtrPercent: MAX_ATR_PERCENT,
            maxDistanceFromEma55Percent: MAX_DISTANCE_FROM_EMA55_PERCENT,
            minVolumeExpansion: MIN_VOLUME_EXPANSION,
        },
        markets: candidates.map((candidate) => candidate.market),
        summary: {
            trades: allTrades.length,
            wins,
            losses: allTrades.length - wins,
            winRate: allTrades.length ? (wins / allTrades.length) * 100 : 0,
            totalPnl,
            returnPct: (totalPnl / INITIAL_CAPITAL) * 100,
            endingCapital: capital,
            averageNetPctPerTrade: averageNetPct,
            maxWinPct: allTrades.length ? Math.max(...allTrades.map((trade) => trade.netPct)) : 0,
            maxLossPct: allTrades.length ? Math.min(...allTrades.map((trade) => trade.netPct)) : 0,
            exitReasons,
        },
        perMarket: perMarket.sort((a, b) => b.pnl - a.pnl),
        sampleTrades: allTrades.slice(-10),
    }, null, 2));
}

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
