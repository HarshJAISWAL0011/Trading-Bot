import { getCandleChart, getINRbalance,getTicker } from "./ApiInfo.js";
import { activeOrders, sellCoins } from "./trans.js";
import { buildPair, daysPassedSince, generateLossOrderId, getStoredJson, moveOrderIdToSell, updateFlatCoinsList } from "./util.js";
import * as CONSTANT from "./Constant.js"; 
import { convertPairIntoCoindcxName,getMiscData,saveMiscResults,sleep,updatePriceHistory,getPriceHistory} from "./util.js";
import { sendEmail, sendErrorMail } from "./Email.js";
import {getCoinReadyToBuy} from "./short-term.js";
import { suddenFallAlgo } from "./suddenfall.js";
import { coinHiked, getTime } from "./hike.js";
import { monitorPrices, manageBoughtCoins, checkReboundCandidates } from "./algo2k25/index.js";
import fetch from 'node-fetch'; 
import { sendLogs,runOnce,updatePriceHistoryInFirebase,initializePriceHistoryFromFirebase } from "./firebase.js";

let canRunShortTerm = true;
// const interval = setInterval(lossCheck, 30*60*1000); // Check every 30 minutes
// setInterval(runScheduled, 4 * 60 * 60 * 1000);  // Check every 4 hours
// setInterval(checkOrderOverTime,24*60*60*1000);  // check every 24 hours
setInterval(keepServerAlive, 5*60*1000); //Make request in every 5 minutes
// setInterval(hikeScheduler,4*60*1000); //Make request in every 4 min
// setInterval(buildPair,24*60*60*1000); //Make request in every 4 min

// await monitorPrices();
// setInterval(monitorPrices,1.5*60*60*1000); //Make request in every 2 hrs
// setInterval(manageBoughtCoins, 60*1000); // 1 min
// setInterval(checkReboundCandidates, 15*60*1000);// 15 min

matchTimeAndStart();

async function matchTimeAndStart() {
    const now = new Date();

    // Convert to IST (UTC+5:30)
    const istOffset = 5 * 60 + 30; // in minutes
    const utcOffset = now.getTimezoneOffset(); // in minutes (local - UTC)
    const istDate = new Date(now.getTime() + (istOffset - utcOffset) * 60 * 1000);

    const min = istDate.getMinutes();
    const sec = istDate.getSeconds();

    console.log(`🕒 Current IST time: ${istDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}, min: ${min}`);


    if(min >= 40){
        await sleep((60 - min) * 1000 * 60);
        await monitorPrices();
        setInterval(monitorPrices,1.3*60*60*1000); //Make request in every 2 hrs
        setInterval(manageBoughtCoins, 60*1000); // 1 min
        setInterval(checkReboundCandidates, 25*60*1000);// 25 min
    }else{
        await monitorPrices();
        await sleep((60 - min) * 1000 * 60) // Make sure to handle checkReboundCandidates & manageBoughtCoins on db edit
        await monitorPrices();
        setInterval(monitorPrices, 1.3*60*60*1000); //Make request in every 2 hrs
        setInterval(manageBoughtCoins, 60*1000); // 1 min
        setInterval(checkReboundCandidates, 25*60*1000);// 25 min
    }
}

// let ticker5minAgo;
// let ticker10minAgo;
// let id=1;
// hikeScheduler();  // important to run
// // runOnce();
// initializePriceHistoryFromFirebase();

// async function hikeScheduler() {
//   try{
//     if(ticker5minAgo == undefined){
//     ticker5minAgo =await getTicker();
//     return;
//   }

//   const lag1min=await getTicker();
//   await updatePriceHistory(ticker5minAgo); // in file system  ** Race condition** Need to run before running coinHiked.
//   updatePriceHistoryInFirebase(); // in firebase   
//   if(id % 2 == 0){ 
//    updateFlatCoinsList();
//   }
//   await sleep(1000*60); // sleep for 1 minute

//   coinHiked(ticker5minAgo,ticker10minAgo,lag1min,id);

//   ticker10minAgo=[...ticker5minAgo];
//   ticker5minAgo=await getTicker();
//   id++;
//   if(id>100) id=1;
 
// }catch(err) {console.error(err);}
// }

// async function runScheduled() {
//   try{
//     console.log("Schedule ran");
//   let balance=await getINRbalance();
//   if(balance <101) // check in every 4hrs if I have enough money to buy coins
//   return;
  
//   suddenFallAlgo();

//   if (canRunShortTerm) {
//     const result = await getCoinReadyToBuy();
//     if (!result) {
//       canRunShortTerm = false;
//       setTimeout(() => {
//         canRunShortTerm = true;
//       }, 41 * 60 * 60 * 1000); // 41 hours
//     }
//   }
// }catch(err) {console.error(err);}
// }

 function keepServerAlive() {
  //render will stop the server if no request is received in 15 min.
  try{
  let baseurl = 'https://requester-twha.onrender.com/';
      fetch( baseurl )
      .then(response => {
          if (response.ok) {
            console.log(`URL ${baseurl} is reachable. Status Code: ${response.status}`);
          } else {
            console.error(`URL ${baseurl} returned an error. Status Code: ${response.status}`);
            if( !response.status.toString().includes('520')) {
            sendEmail(`${baseurl} have some Error. Status Code: ${response.status}`);
            }
          }
        })
        .catch(error => {
          console.error(`Error while checking URL ${baseurl}: ${error.message}`);
        });
}catch(error) {console.error(error);}

}
  

// // Run the function every 4 hours

// async function checkOrderOverTime(){   //Notify if the order has not been updated for more than 29 days
//   let storedObj= await getStoredJson(CONSTANT.suddenFall);      
//   let coinNames=storedObj.coin;

//   for(let name of coinNames){
//   let obj=await activeOrders(convertPairIntoCoindcxName(name.name)); 

//   for(let recObj of obj.orders){
//   let daysPassed=daysPassedSince(recObj.updated_at);
//   if(daysPassed>29)
//       sendEmail(`Its been ${daysPassed} days since your coin ${name.name} was last bought`);
//   }

// }
// }

//   async function getCurrentPrice(coinName) {
//     const candleData = await getCandleChart("1m", coinName);

//     const currentPrice = candleData[0].close;
//     return currentPrice;
//   }

//   async function lossCheck(){
//     try {
//       let jsonData=await getStoredJson(CONSTANT.suddenFall);
//       let coinArray=jsonData.coin;

//       for(let coinName of coinArray){

//         let active_orders=await activeOrders(convertPairIntoCoindcxName(coinName.name));

//         for(let orderObject of active_orders.orders){
//           if(orderObject.side=='buy') continue;

//       let initialPrice=orderObject.price_per_unit;

//       const currentPrice = await getCurrentPrice(coinName.name);
//       const priceChangePercentage = calculatePriceChangePercentage(initialPrice, currentPrice);
//       console.log(priceChangePercentage,initialPrice,coinName.name);
     
//        if (priceChangePercentage <= -8 && priceChangePercentage>-12) {
//         sendNotification(`Alert! \n Price of ${coinName.name} has decreased by more than 9%`,coinName.name,true);
//        }
//       else if(priceChangePercentage <=-12){ //check is already updated
//          sendNotification(`${coinName.name} is sold at loss of ${priceChangePercentage}`,coinName.name,false);
//         sellCoinProcess(orderObject,currentPrice)
//       }
//       }
//   }
//    }catch (error) {
//       console.error("Error checking coin price:", error);
//     }
//   }
  
//   function calculatePriceChangePercentage(initialPrice, currentPrice) {
//     return ((currentPrice - initialPrice) / initialPrice) * 100;
//   }
  
//   async function sendNotification(message,coin,isSaveResult) {
//     let miscData=await getMiscData();
//     let time=miscData.notif[coin];
//     if(time==null || time== undefined){
//       sendEmail(message);
     
//       miscData.notif[coin]=new Date().getTime();
//       if(isSaveResult)
//       saveMiscResults(miscData);
//     }
//     else{
//       if(daysPassedSince(time)>6){
//       sendEmail(message);
//       if(isSaveResult)
//       saveMiscResults(miscData);
//       miscData.notif[coin]=new Date().getTime();
//     }
//     }
//     console.log("Notification:", message);
//   }

// async function sellCoinProcess(obj,curr_price){
//   try{
//   let sudden_fallJson=await getStoredJson(CONSTANT.suddenFall);
//   let id=obj.client_order_id;
//   let idArray=sudden_fallJson.order_id.buy;
//   if(idArray.includes(id)){
//     moveOrderIdToSell(id,CONSTANT.suddenFall);
//   }else{
//     moveOrderIdToSell(id,CONSTANT.shortTerm);
//   }
//   let lossId=generateLossOrderId(obj.market);
//   sellCoins(obj.market, obj.quantity,curr_price,lossId);

//   }catch(e){console.error(e);}
// }
