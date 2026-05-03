import { startAdvancedPolling } from "./index.js";

startAdvancedPolling({
    tickerPollMs: 60 * 1000,
    candleInterval: "15m",
    maxMarketsPerPoll: 35,
    minSignalScore: 94,
    minVolumeExpansion: 2.0,
}).catch((err) => {
    console.error("algo2k26 runner failed:", err);
    process.exitCode = 1;
});
