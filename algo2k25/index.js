import axios from "axios";
import { baseurl, publicbaseurl, ticker, market_details } from "../Constant.js";
import { sendEmail } from "../Email.js";
import { sendLogs, storeLog } from "../firebase.js";
import { prefix, getNowDate, getTime } from "../hike.js";

// Cache memory
let cachedPrices = {};                 // { "B-BTC_USDT": 24000 }
let phaseOneCandidates = {};           // { "B-BTC_USDT": 26000 }
let phaseTwoCandidate = {};               // { "B-BTC_USDT": { entryPrice, dropHistory } }
let boughtCoins = {};                  // { market: { buyPrice: number, priceHistory: number[] } }
let volumeHistory = {};                // { market: [volumes...] }
let cooldowns = {};                    // { market: timestamp }
let reboundWatchlist = {};             // { market: timestamp }
let reboundScheduler = {}
let notes = {}

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
    if( getNowDate() - cooldowns[market] < COOLDOWN_MS)
        return true;
    delete cooldowns[market]
    return false;
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
            if (volumeHistory[market].length > 10) volumeHistory[market].shift();

            // First run: just store price
            if (!cachedPrices[market]) {
                cachedPrices[market] = last_price;
                continue;
            }

            const oldPrice = cachedPrices[market];
            const hikePercent = ((last_price - oldPrice) / oldPrice) * 100;

            // Step 1: ≥3.5% hike → move to first list
            if (hikePercent >= 3.5 && !phaseOneCandidates[market] && !phaseTwoCandidate[market] && !boughtCoins[market] && !reboundWatchlist[market]) {
                clearNote(market)
                let valid = true;
                for (let i = 1; i < volumeHistory[market].length; i++) {
                    if (volumeHistory[market][i] == 0.0) {
                        valid = false; // means no trades happened in that hour
                        break;
                    }
                }

                if (!valid) {
                    logAndNote(market, `Volume check is skipped due to less/no data`)
                    // continue;
                }

                logAndNote(market, `First pass from: ${oldPrice} to: ${last_price} at ${getTime()} (${hikePercent})`)
                phaseOneCandidates[market] = {
                        startPrice: oldPrice,
                        basePrice: last_price,
                        attempts: 0,
                        time : getTime()
                    };
                sendLogs(`${prefix(market)} 🚀 ${market} jumped ${hikePercent.toFixed(2)}%. Added to phaseOneCandidates`);
            }

            // Step 2: check for ≥15% hike from first list price (within 3 runs)
            if (phaseOneCandidates[market]) {
                const candidate = phaseOneCandidates[market];
                candidate.attempts++;

                const secondHikePercent = ((last_price - candidate.basePrice) / candidate.basePrice) * 100; // Will be 0 in same run when entered in phaseOneCandidates

                if (secondHikePercent >= 15 ) {
                    logAndNote(market, `Second pass from: ${candidate.basePrice} to: ${last_price} at ${getTime()} (${secondHikePercent})`)
                    if (secondHikePercent > 75){
                        logAndNote(market, `Hike of: ${secondHikePercent} looks a fluctuating coin`)
                    }
                    phaseTwoCandidate[market] = {
                        basePrice: candidate.startPrice,
                        topPrice: last_price,
                        dropHistory: [],
                        startTime: getNowDate(),
                    };
                    sendLogs(`${prefix(market)} ⚡ ALERT: ${market} moved to PhaseTwo`);
                    delete phaseOneCandidates[market]; // cleanup
                } else if (candidate.attempts >= 3) {
                    // If fail to increase by 15% in 3 run → drop it
                    delete phaseOneCandidates[market];
                    sendLogs(`${prefix(market)} ℹ️ Dropped ${market} from PhaseOne after 3 attempts without 15% hike`);
                }
            }

            // Step 3: Track red candle for phaseTwoAlerts
            if (phaseTwoCandidate[market] ) {
                const entry = phaseTwoCandidate[market];
                entry.dropHistory.push([last_price, getTime()]);
                if (entry.dropHistory.length > 10) entry.dropHistory.shift();

                let consecutiveRedCandle = 0;
                let consecutiveGreenCandle = 0;
                let foundConsecutiveRedCandle = false
                const enteredPrice = entry.dropHistory[0][0]
                for (let i = 1; i < entry.dropHistory.length; i++) {
                    const prev = entry.dropHistory[i - 1][0]; // last_price
                    const curr = entry.dropHistory[i][0]; // last_price
                    const dropPercent = ((prev - curr) / prev) * 100.0;
                    const startToNowDrop = ((enteredPrice - last_price) / enteredPrice) * 100.0;


                    if (dropPercent > 0) {
                        consecutiveRedCandle++;
                        consecutiveGreenCandle = 0;// reset if not a green candle
                        if (consecutiveRedCandle >= 2 || foundConsecutiveRedCandle) {
                            foundConsecutiveRedCandle = true
                            if (startToNowDrop >= 12) {
                                let maxDropAllowed = entry.topPrice - ( 0.7 *(entry.topPrice - entry.basePrice)) // 70% of base to highest price diff -> max allowed drop 
                                if(last_price >= maxDropAllowed){
                                    const formattedHistory = entry.dropHistory
                                            .map(([price, time]) => `${price} @ ${time}`)
                                            .join("  → "); 
                                    logAndNote(market, ` dropHistory: ${formattedHistory}\nFound >=2 Red candle at: ${getTime()} @ ${last_price} (curr: ${curr}) with drop percent: ${startToNowDrop}`)

                                    reboundWatchlist[market] = { market, startTime: getNowDate(), lowestPrice: last_price };
                                    delete phaseTwoCandidate[market];
                                    sendLogs(`${prefix(market)} 📉 ${market} moved to reboundWatchlist after 2 consecutive red candles`);
                                    startReboundScheduler(market);
                                    break;
                                }else{
                                     sendLogs(`${prefix(market)} 📉 ${market}: Coin has dropped too much. Current Price: ${last_price} -> maxDropAllowed: ${maxDropAllowed}`);
                                    delete phaseTwoCandidate[market]
                                }
                            } else {
                                if (getNowDate() - entry.startTime > 1000 * 60 * 60 * 10) { // 10 hours
                                    sendLogs(`${prefix(market)} 📉 ${market}: Waiting from 10hrs. Total red candle sum < 5%. Dropping coin`);
                                    delete phaseTwoCandidate[market]
                                }
                            }
                        } else {
                            if (getNowDate() - entry.startTime > 1000 * 60 * 60 * 10) { // 10 hours
                                sendLogs(`${prefix(market)} 📉 ${market}: Waiting from 10hrs. Total red candle sum < 5%. Dropping coin`);
                                delete phaseTwoCandidate[market]
                            }
                        }
                    } else {
                        consecutiveRedCandle = 0; // reset if not a red candle
                        consecutiveGreenCandle++;

                        if(consecutiveGreenCandle >= 3){
                            sendLogs(`${prefix(market)} 📉 ${market}: Dropping coin. Got consecutive ${consecutiveGreenCandle} green candles while waiting for red candle`);
                            delete phaseTwoCandidate[market]
                        }

                        if (getNowDate() - entry.startTime > 1000 * 60 * 60 * 10) { // 10 hours
                            sendLogs(`${prefix(market)} 📉 ${market}: Waiting from 10hrs. Total red candle sum < 5%. Dropping coin`);
                            delete phaseTwoCandidate[market]
                        }

                        // if(dropPercent <= -4.5){ // Price increased by >= 4.5%
                        //     sendLogs(`${prefix(market)} 📉 ${market}:Price increased by ${-dropPercent} while waiting for 2 consecutive red candle`);
                        //     delete phaseTwoCandidate[market]
                        // }
                    }
                }
            }


            cachedPrices[market] = last_price;
        }
    } catch (err) {
        console.error("❌ monitorPrices error:", err.message);
    }
}

async function startReboundScheduler(market){
    try {
        if (reboundScheduler[market]) return; // already running
        reboundScheduler[market] = setInterval(checkReboundCandidates, 25*60*1000, market);// 25 min
    } catch (err) {
        console.error("Error in 25-min scheduler:", err);
    }
}

async function checkReboundCandidates(market) {
    try {
        if (!reboundWatchlist[market]) {
            sendLogs(`${prefix(market)} reboundWatchlist does not have market: ${JSON.stringify(reboundWatchlist)}`)
            clearInterval(reboundScheduler[market])
            delete reboundScheduler[market];
            return;
        }
        sendLogs(`${prefix(market)} reboundWatchlist: ${JSON.stringify(reboundWatchlist)}`)
        const  latestData  = await fetchAllPrices()
        const now = getNowDate();
        let reboundPercentThreshold = 1.3
        let maxReboundAllowed = 6.0

        const alert = reboundWatchlist[market];
        const coinData = latestData.find(c => c.market === market);
        if (!coinData) return; // Don't delete. May be Coindcx server is down

        const last_price = parseFloat(coinData.last_price);
        
        if (!alert.reboundHistory) {
            alert.reboundHistory = [];
        }

        alert.reboundHistory.push([last_price, getTime()]);

        // track lowest point
        alert.lowestPrice = Math.min(alert.lowestPrice || last_price, last_price);

        // check for rebound
        const reboundPercent = ((last_price - alert.lowestPrice) / alert.lowestPrice) * 100;

        if(now - alert.startTime > 50 * 60 * 1000)// 50 min
             reboundPercentThreshold = 1.8;

        if (reboundPercent >= reboundPercentThreshold) {
            sendLogs(`${prefix(market)} 📈 Rebound detected for ${market}, buying at ${last_price}`);
            logAndNote(market, `Rebound percent: ${reboundPercent}, rebound price: ${last_price} from ${alert.lowestPrice}`)
            const reboundHistoryText = alert.reboundHistory
                                        .map(([price, time]) => `${price} @ ${time}`)
                                        .join("  → "); 
            logAndNote(market, `ReboundHistory: ${reboundHistoryText}`)
            if(reboundPercent > maxReboundAllowed)
                logAndNote(market, "Not safe to buy. Rebound Percent is more than 4%")
            buyCoin(market, last_price);

            clearInterval(reboundScheduler[market])
            delete reboundWatchlist[market];
            delete reboundScheduler[market];
            return;
        }

        // check timeout (2 hours = 7200000 ms)
        if (now - alert.startTime >= 2 * 60 * 60 * 1000) {
            sendLogs(`${prefix(market)} ⌛ No rebound for ${market} in 2hrs, removing from watchlist`);

            clearInterval(reboundScheduler[market])
            delete reboundWatchlist[market];
            delete reboundScheduler[market];
        }
    } catch (err) {
        console.error("Error in running scheduler:", err);
    }
}


// ---- CHECK BOUGHT COINS (Take Profit / Stop Loss) ----
export async function manageBoughtCoins() {
    try {
        if (Object.keys(boughtCoins).length === 0) return;
        sendLogs(`${prefix("boughtCoins")} boughtCoins: ${JSON.stringify(boughtCoins)}`)
        const prices = await fetchAllPrices();

        let currTime = getNowDate();
        for (const coin of prices) {
            const { market, last_price } = coin;
            if (!boughtCoins[market]) continue;
            let profitPercentThreshold = 6;
            let lossPercentThreshold = 8;
            const { buyPrice, priceHistory } = boughtCoins[market];

            priceHistory.push(last_price);
            if (priceHistory.length > 15) priceHistory.shift();
            boughtCoins[market].priceHistory = priceHistory;

            let maxPriceReached = last_price
            for(let idx = 0; idx<priceHistory.length; idx++){
                let lossAtPoint = ((buyPrice - priceHistory[idx])/buyPrice) * 100.0;
                if( lossAtPoint >= 3.0) // if loss is more than 3% at any point, resest profitPercentThreshold --> recovered from loss, confiedence dropped
                    profitPercentThreshold = 2;
                maxPriceReached = Math.max(maxPriceReached, priceHistory[idx])
            }

            let lowestPriceReached = -1;
            let startCheck = false;
            for(let idx = 0; idx<priceHistory.length; idx++){
                if(priceHistory[idx] == maxPriceReached){
                    startCheck = true;
                }

                if(startCheck && priceHistory[idx] >=( buyPrice +0.02*buyPrice)){ // if profit at some point was >= 2% & then price dec. by 1.5% then set profit threshold to 0
                    if(lowestPriceReached == -1)
                        lowestPriceReached = priceHistory[idx]
                    else
                        lowestPriceReached = Math.min(lowestPriceReached, priceHistory[idx]) // lowest price still greater than bought price --> close to reach profit threshold, but couldn't
                }
            }

            const profitPercent = ((last_price - buyPrice) / buyPrice) * 100;
            if( getNowDate() - boughtCoins[market].boughtDate > 6 * 60 * 60 * 1000 ||   // --> 6 hrs
                ( (lowestPriceReached != -1 &&  (maxPriceReached - lowestPriceReached)/lowestPriceReached)*100 >= 1.5)) { // if price decreased by 1.5% from max reached but less than profitPercentThreshold
                profitPercentThreshold = 0;
            }

            // Take profit 
            if (profitPercent >= profitPercentThreshold) {
                sellCoin(market, last_price, `Take Profit (${profitPercent}%) with profitThreshold: ${profitPercentThreshold}`);
                continue;
            }

            // Stop loss (≥15% drop in last 3 checks)
            const lossPercent = (( buyPrice - last_price) / buyPrice) * 100;
            
            if(getNowDate() - boughtCoins[market].boughtDate >= 4 * 60 * 60 * 1000){
                lossPercentThreshold -= (getNowDate() - boughtCoins[market].boughtDate) /(2 * 60 * 60 * 1000) // Decrease loss bearing capacity by 1% with every 1.5 hrs
                lossPercentThreshold = Math.max(0, lossPercentThreshold);
            }

            if (lossPercent >= lossPercentThreshold) {
                sellCoin(market, last_price, `Stop Loss (${lossPercent}%)`);
           } else if (currTime - boughtCoins[market].boughtTime > 3 * 24 * 60 * 60 * 1000) { // 3 days
                sellCoin(market, last_price, `Waited for 3 days. Selling with loss of ${lossPercent}`);
            }
        }
    } catch (err) {
        console.error("❌ manageBoughtCoins error:", err.message);
    }
}

// ---- MOCK BUY/SELL ----
function buyCoin(market, price) {
    sendEmail(`🟢 BUY ${market} at ${price}\nNotes: ${notes[market]}`)
    sendLogs(`${prefix(market)} 🟢 BUY ${market} at ${price}\nNotes: ${notes[market]}`);
    boughtCoins[market] = { buyPrice: price, priceHistory: [price], boughtTime: getNowDate(), boughtDate: getNowDate() };
    cooldowns[market] = getNowDate(); // set cooldown
    notes[market] = ""
}

function sellCoin(market, price, reason) {
    sendEmail(`🔴 SELL ${market} at ${price} (Reason: ${reason})`)
    sendLogs(`${prefix(market)} 🔴 SELL ${market} at ${price} (Reason: ${reason})`);
    delete boughtCoins[market];
    cooldowns[market] = getNowDate(); // set cooldown
}

function logAndNote(market, msg){
    sendLogs(`${prefix(market)} ${msg}`);
    notes[market]  = (notes[market] || "") + `${msg}\n`
}

function clearNote(market){
    notes[market] = ""
}