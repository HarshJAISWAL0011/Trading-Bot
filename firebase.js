import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set,push } from "firebase/database";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { getTime } from "./hike.js";
import dotenv from 'dotenv';
dotenv.config();

let key= process.env.FIREBASE_CONFIG;
let firebaseConfig = JSON.parse(key);

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const MAX_COIN_HISTORY = 140;

export function sendLogs(logMsg) {
    const currentDate = new Date();
    const dateKey = formatDateKey(currentDate);
    console.log(`logMsg ${logMsg}`)
    let finalLog =`${logMsg} <---)`
  
    const db = getDatabase();
    const logsRef = ref(db, `logs/${dateKey}`);

    const newLogRef = push(logsRef);

    set(newLogRef, finalLog)
        .catch((error) => {
            console.error('Error storing log message:', error);
        });
  };

  export function storeLog(prefix, message) {
    const currentDate = new Date();
    const dateKey = formatDateKey(currentDate);
    console.log(`prefix: ${prefix} message ${message}`)
    const data = {prefix, message}
  
    const db = getDatabase();
    const logsRef = ref(db, `logs2/${dateKey}`);

    const newLogRef = push(logsRef);

    set(newLogRef, data)
        .catch((error) => {
            console.error('Error storing log message:', error);
        });
  };
  
  const formatDateKey = (date) => {

    date.setHours(date.getHours() + 5); // Add 5 hours for UTC+5
    date.setMinutes(date.getMinutes() + 30); // Add 30 minutes for UTC+5:30
  
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hour = String(date.getUTCHours()).padStart(2, '0');
  
    return `${month}/${day}/${hour}`;
  };
  
export function runOnce() {
    const currentDate = new Date();
    const dateKey = formatDateKey(currentDate);
  
    const db = getDatabase();
    const logsRef = ref(db, `logs/`);

    const newLogRef = push(logsRef);

    set(logsRef, 'logMsg')
        .catch((error) => {
            console.error('Error storing log message:', error);
        });
  };

  export async function updatePriceHistoryInFirebase() {
    try { 
        console.log('updatePriceHistory');


        // Get a reference to the database
        const database = getDatabase(app);
        const coinsPriceHistoryRef = ref(database, 'PriceHistory/Coins');

        // Retrieve current coin prices from Firebase
        const filePath = path.resolve(__dirname, PRICE_HISTORY_FILE);
        let currentPrices = await fs.promises.readFile(filePath, 'utf-8');
        currentPrices= await JSON.parse(currentPrices);
        if(currentPrices == null) 
         currentPrices ={};

        // Update the prices in Firebase
        set(coinsPriceHistoryRef, currentPrices)
        .catch((error) => {
            console.error('Error storing Price Histoty:', error);
        });
    } catch (error) {
        console.error('Error:', error);
        sendLogs(`${getTime}: Error in updatePriceHistoryInFirebase Firebase.js: ${error}`);
    }
}

export async function getPriceHistory(market) {
  try {
      market =market.toUpperCase();
      // Get a reference to the database
      const database = getDatabase(app);
      const coinsPriceHistoryRef = ref(database, `PriceHistory/Coins/${market}`);

      // Retrieve the price history from Firebase
      const snapshot = await get(coinsPriceHistoryRef);
      const priceHistory = snapshot.val();

      // Return the price history array
      return priceHistory.map(str => parseFloat(str)) || [];
  } catch (error) {
      console.error('Error:', error);
      // Handle errors appropriately (e.g., throw an error, return a default value)
      sendLogs(`${getTime}: Error in getPriceHistory Firebase.js: ${error}`);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PRICE_HISTORY_FILE = path.join(__dirname, "/fs/priceHistory.json");

export async function initializePriceHistoryFromFirebase() {
    try {

        // Get a reference to the database
        const database = getDatabase(app);
        const coinsPriceHistoryRef = ref(database, 'PriceHistory/Coins');

        // Retrieve current coin prices from Firebase
        const snapshot = await get(coinsPriceHistoryRef);
        let currentPrices = snapshot.val();
        // currentPrices = JSON.parse(currentPrices);

        // Write the prices to the local file
        if (currentPrices) {
            try {
                const filePath = path.resolve(__dirname, PRICE_HISTORY_FILE);
                await fs.promises.writeFile(filePath, JSON.stringify(currentPrices, null, 2), 'utf-8');
                console.log('Price history data successfully written to file system.');
            } catch (error) {
                console.error('Error writing Price History to file system:', error);
            }
        } else {
            console.log('No data retrieved from Firebase.');
        }
    } catch (error) {
        console.error('Error initializing Price History from Firebase:', error);
        sendLogs(`${getTime}: Error in initializePriceHistoryFromFirebase Firebase.js: ${error}`);

    }
}
