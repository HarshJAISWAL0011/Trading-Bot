import axios from "axios";
import { baseurl, publicbaseurl, ticker, market_details } from "../Constant.js";
import { sendEmail } from "../Email.js";
import { sendLogs, storeLog } from "../firebase.js";
import { prefix, getNowDate, getTime } from "../hike.js";

// Cache memory
let cachedPrices = {};                 // { "B-BTC_USDT": 24000 }
let phaseOneCandidates = {};           // { "B-BTC_USDT": 26000 }
let phaseTwoAlerts = {};               // { "B-BTC_USDT": { entryPrice, dropHistory } }
let boughtCoins = {};                  // { market: { buyPrice: number, priceHistory: number[] } }
let volumeHistory = {};                // { market: [volumes...] }
let cooldowns = {};                    // { market: timestamp }
let reboundWatchlist = {};             // { market: timestamp }

// Cooldown settings
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

// Fetch all market prices
async function fetchAllPrices() {
    const url = `${publicbaseurl}${ticker}`;
    const { data } = await axios.get(url);
    sendLogs(`${prefix("12")} Fetched ${data.length} markets`);
    return data; // array of { market, last_price, volume }
}


// Check if market is on cooldown
function isOnCooldown(market) {
    if (!cooldowns[market]) return false;
    return getNowDate() - cooldowns[market] < COOLDOWN_MS;
}

// Main monitor function
export async function monitorPrices() {
    try {
        const prices = await fetchAllPrices();

        for (const coinData of prices) {
            const { market } = coinData;
            const last_price = parseFloat(coinData.last_price);

            // Skip if in cooldown
            if (isOnCooldown(market)) {
                continue;
            }

            // ---- Track Volume History (last 6 hrs) ----
            if (!volumeHistory[market]) volumeHistory[market] = [];
            volumeHistory[market].push(coinData.volume || 0);
            if (volumeHistory[market].length > 6) volumeHistory[market].shift();

            // First run: just store price
            if (!cachedPrices[market]) {
                cachedPrices[market] = last_price;
                continue;
            }

            const oldPrice = cachedPrices[market];
            const hikePercent = ((last_price - oldPrice) / oldPrice) * 100;

            // Step 1: ≥3.5% hike → move to first list
            if (hikePercent >= 3.5 && !phaseOneCandidates[market] && !phaseTwoAlerts[market] && !boughtCoins[market] && !reboundWatchlist[market]) {
                let notes = ""
                if (volumeHistory[market].length === 3) {
                    let valid = true;
                    for (let i = 1; i < volumeHistory[market].length; i++) {
                        if (volumeHistory[market][i] === volumeHistory[market][i - 1]) {
                            valid = false; // means no trades happened in that hour
                            break;
                        }
                    }

                    if (!valid) {
                        continue;
                    }
                } else {
                    notes = `Volume check is skipped due to less/no data`
                    // continue; // Not enough history yet
                }

                phaseOneCandidates[market] = {
                        basePrice: oldPrice,
                        notes,
                        attempts: 0
                    };
                sendLogs(`${prefix(market)} 🚀 ${market} jumped ${hikePercent.toFixed(2)}%. Added to phaseOneCandidates`);
            }

            // Step 2: check for ≥3.5% hike from first list price (within 3 runs)
            if (phaseOneCandidates[market]) {
                const candidate = phaseOneCandidates[market];
                candidate.attempts++;

                const secondHikePercent = ((last_price - candidate.basePrice) / candidate.basePrice) * 100;

                if (secondHikePercent >= 15 ) {

                    let notes = `${candidate.notes}\nFirst pass price: ${candidate.basePrice}\nSecond pass price: ${last_price}`
                    if (secondHikePercent > 75){
                        notes = `\nHike of: ${secondHikePercent} looks a fluctuating coin`
                    }
                    phaseTwoAlerts[market] = {
                        entryPrice: last_price,
                        dropHistory: [[last_price, getTime()]],
                        lowestPrice: last_price,
                        startTime: getNowDate(),
                        notes: notes
                    };
                    sendLogs(`${prefix(market)} ⚡ ALERT: ${market} moved to PhaseTwo`);
                    delete phaseOneCandidates[market]; // cleanup
                } else if (candidate.attempts >= 3) {
                    // If 3 chances are done and no 5% hike → drop it
                    delete phaseOneCandidates[market];
                    sendLogs(`${prefix(market)} ℹ️ Dropped ${market} from PhaseOne after 3 attempts without 15% hike`);
                }
            }

            // Track red candle for phaseTwoAlerts
            if (phaseTwoAlerts[market] ) {
                const entry = phaseTwoAlerts[market];
                entry.dropHistory.push([last_price, getTime()]);
                if (entry.dropHistory.length > 3) entry.dropHistory.shift();

                let consecutiveRedCandle = 0;
                let totalDrop = 0;
                let foundConsecutiveRedCandle = false
                sendLogs(`${prefix(market)} ${market} dropHistory: ${entry.dropHistory}`)
                for (let i = 1; i < entry.dropHistory.length; i++) {
                    const prev = entry.dropHistory[i - 1][0]; // last_price
                    const curr = entry.dropHistory[i][0]; // last_price
                    const dropPercent = ((prev - curr) / prev) * 100;

                    if (dropPercent > 0) {
                        consecutiveRedCandle++;
                        totalDrop += dropPercent
                        if (consecutiveRedCandle >= 2 || foundConsecutiveRedCandle) {
                            foundConsecutiveRedCandle = true
                            if (totalDrop >= 5) {
                                let newNote = entry.notes
                                newNote += `\ndropHistory prices: ${entry.dropHistory}\nRed candle: Ok at ${getTime()} @ ${curr} with drop percent: ${dropPercent}`

                                reboundWatchlist[market] = { market, startTime: getNowDate(), lowestPrice: last_price, notes: newNote };
                                delete phaseTwoAlerts[market];
                                sendLogs(`${prefix(market)} 📉 ${market} moved to reboundWatchlist after 2 consecutive red candles`);
                                break;
                            } else {
                                if (getNowDate() - entry.startTime > 1000 * 60 * 60 * 10) { // 10 hours
                                    sendLogs(`${prefix(market)} 📉 ${market}: Waiting from 10hrs. No rebound. Dropping coin`);
                                    delete phaseTwoAlerts[market]
                                }
                            }
                        } else {
                            if (getNowDate() - entry.startTime > 1000 * 60 * 60 * 10) { // 10 hours
                                sendLogs(`${prefix(market)} 📉 ${market}: Waiting from 10hrs. No rebound. Dropping coin`);
                                delete phaseTwoAlerts[market]
                            }
                        }
                    } else {
                        consecutiveRedCandle = 0; // reset if not a red candle
                        if (getNowDate() - entry.startTime > 1000 * 60 * 60 * 10) { // 10 hours
                            sendLogs(`${prefix(market)} 📉 ${market}: Waiting from 10hrs. No rebound. Dropping coin`);
                            delete phaseTwoAlerts[market]
                        }
                    }
                }
            }


            cachedPrices[market] = last_price;
        }
    } catch (err) {
        console.error("❌ monitorPrices error:", err.message);
    }
}

export async function checkReboundCandidates() {
    try {
        if (Object.keys(reboundWatchlist).length === 0) return;
        sendLogs(`${prefix("market")} reboundWatchlist: ${JSON.stringify(reboundWatchlist)}`)
        const  latestData  = await fetchAllPrices()
        const now = getNowDate();

        for (const market in reboundWatchlist) {
            const alert = reboundWatchlist[market];
            const coinData = latestData.find(c => c.market === market);
            if (!coinData) continue;

            const last_price = parseFloat(coinData.last_price);

            // track lowest point
            alert.lowestPrice = Math.min(alert.lowestPrice || last_price, last_price);

            // check for rebound
            const reboundPercent = ((last_price - alert.lowestPrice) / alert.lowestPrice) * 100;
            if (reboundPercent >= 1) {
                sendLogs(`${prefix(market)} 📈 Rebound detected for ${market}, buying at ${last_price}`);
                let updatedNotes = alert.notes
                updatedNotes += `\nRebound percent: ${reboundPercent}, rebound price: ${last_price} from ${alert.lowestPrice}`
                buyCoin(market, last_price, updatedNotes);
                delete reboundWatchlist[market];
                continue;
            }

            // check timeout (2 hours = 7200000 ms)
            if (now - alert.startTime >= 2 * 60 * 60 * 1000) {
                sendLogs(`${prefix(market)} ⌛ No rebound for ${market} in 2hrs, removing from watchlist`);
                delete reboundWatchlist[market];
            }
        }
    } catch (err) {
        console.error("Error in 15-min scheduler:", err);
    }
}


// ---- CHECK BOUGHT COINS (Take Profit / Stop Loss) ----
export async function manageBoughtCoins() {
    try {
        if (Object.keys(boughtCoins).length === 0) return;
        sendLogs(`${prefix("boughtCoins")} boughtCoins: ${JSON.stringify(boughtCoins)}`)
        const prices = await fetchAllPrices();

        var currTime = getNowDate();
        for (const coin of prices) {
            const { market, last_price } = coin;
            if (!boughtCoins[market]) continue;

            let { buyPrice, priceHistory } = boughtCoins[market];

            priceHistory.push(last_price);
            if (priceHistory.length > 3) priceHistory.shift();
            boughtCoins[market].priceHistory = priceHistory;

            const profitPercent = ((last_price - buyPrice) / buyPrice) * 100;

            // Take profit (≥3.5%)
            if (profitPercent >= 3.5) {
                sellCoin(market, last_price, "Take Profit (≥3.5%)");
                continue;
            }

            // Stop loss (≥15% drop in last 3 checks)
            const lossPercent = (( boughtCoins[market].buyPrice - last_price) /  boughtCoins[market].buyPrice) * 100;

            if (lossPercent >= 15) {
                sellCoin(market, last_price, "Stop Loss (≥15%)");
           } else if (currTime - boughtCoins[market].boughtTime > 3 * 24 * 60 * 60 * 1000) { // 3 days
                sellCoin(market, last_price, `Waited for 3 days. Selling with loss of ${lossPercent}`);
            }
        }
    } catch (err) {
        console.error("❌ manageBoughtCoins error:", err.message);
    }
}

// ---- MOCK BUY/SELL ----
function buyCoin(market, price, notes) {
    sendEmail(`🟢 BUY ${market} at ${price}\nNotes: ${notes}`)
    sendLogs(`${prefix(market)} 🟢 BUY ${market} at ${price}\nNotes: ${notes}`);
    boughtCoins[market] = { buyPrice: price, priceHistory: [price], boughtTime: getNowDate() };
    cooldowns[market] = getNowDate(); // set cooldown
}

function sellCoin(market, price, reason) {
    sendEmail(`🔴 SELL ${market} at ${price} (Reason: ${reason})`)
    sendLogs(`${prefix(market)} 🔴 SELL ${market} at ${price} (Reason: ${reason})`);
    delete boughtCoins[market];
    cooldowns[market] = getNowDate(); // set cooldown
}
