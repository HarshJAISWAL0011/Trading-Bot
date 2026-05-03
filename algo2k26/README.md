# algo2k26

This folder is a standalone CoinDCX polling and mock-signal algorithm. It does not place live orders and does not modify `algo2k25`.

## What it does

- Polls CoinDCX ticker data from `https://api.coindcx.com/exchange/ticker`.
- Uses market details to map CoinDCX market names to public candle/orderbook pairs.
- Pulls candles from `https://public.coindcx.com/market_data/candles`.
- Pulls orderbook spread from `https://public.coindcx.com/market_data/orderbook`.
- Creates mock BUY/SELL notifications only.

## Strategy stack

The entry score combines several common systems:

- EMA 9/21/55 trend alignment.
- RSI 14, avoiding overheated entries.
- MACD bullish confirmation.
- Bollinger middle/upper-band breakout check.
- Volume expansion versus recent average.
- Orderbook spread filter.
- ATR based stop loss, take profit, and trailing stop.

This cannot guarantee profit. It is designed to reduce low-quality entries and enforce exits, but crypto can move violently and slippage/spread can erase expected edge.

## Run standalone

From the project root:

```bash
node algo2k26/runner.js
```

## Optional schedule.js wiring

If you want to run it from the existing server, import it in `schedule.js`:

```js
import { startAdvancedPolling } from "./algo2k26/index.js";

startAdvancedPolling();
```

Keep it in mock mode until you have watched enough logs to trust the behavior.
