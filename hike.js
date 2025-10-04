import { getCandleChart,getMarketDetails,getTicker } from "./ApiInfo.js";
import { sendEmail, sendErrorMail } from "./Email.js";
import fetch from 'node-fetch'; 
import {  startBuyCoinProcess} from "./trans.js";
import { sendLogs } from "./firebase.js";
import { getPair, sleep,getPriceHistory } from "./util.js";
import * as CONSTANT from './Constant.js'
import { spikeGreedySell } from "./hikeAtOnce.js";
import { slowRiseBuyCheck } from "./slowRise.js";

/*
Target: Some coins suddenly increase by more than 100% or such in few hours/min.

Logic: target coins who have increased by more than @priceHikeThreshold in 10 minutes or combining prev 2 
candles of 10 min hike is more than 30% and also
make sure before buying coin that price have not started to decrease by more than 6%. If it is decreased 
don't buy otherwise buy immediately and sell.

Sell: bought coins should be sell in two ways
 1. If I have bought right coin at right time then most probably coin will increase more than 10%. So wait for 10% profit if predicted wrong then -11% loss.
 If coin is longer than 3 min bw -8 to -11 sell it.
2. greedy way @beGreedy().
In greedySell() function, idea is wait for coin to reach max price and as soon as it starts to decrease
sell it because coins which have hiked suddenly also decrease suddenly. Observed that they mostly follow
monotonic inc/dec. 

Remove:
Case 1: Where volume is 0. becuase it could have altered by huge investors and no chance to increase further.
case 2: If condition is met but price is not currently increasing.

*/



let id=0;

export async function coinHiked(ticker15minAgo,ticker20minAgo,lag1min,no) {
  console.log('coinHiked function called');
  id=no+"";
  if(ticker15minAgo == undefined) 
   return ;
  checkPriceHike(ticker15minAgo,ticker20minAgo,lag1min, true);
}


async function checkPriceHike(previousData,ticker20minAgo,lag1min, canCheckBranch) {
  try {
    const currentTicker = await getTicker();
    const priceHikeThreshold = 14; // Percentage threshold for considering a price hike
    const combineHikeThreshold = 16;
    const recheckThreshold = 8;
    let coinsWithHike = [];
    let coinsFailedHike = [];
    let prevChangePerc = 0;
    let price20minBack=0;
    let matched=true;
    let slowRiseCoins=[];

    currentTicker.forEach((currentCoin,idx) => {
      const symbol = currentCoin.market;
      if(!previousData || !ticker20minAgo) return;
      if(idx >= previousData.length || idx >= ticker20minAgo.length){ 
        sendLogs(`${prefix(id)} for coin: ${symbol} returning cos of length mismatch prev length:${previousData.length} before prev length:${ticker20minAgo.length} & idx: ${idx}`);
        return;
    }
 
      const previousPrice = getPriceOf(symbol, previousData , idx);
      const prev20minPrice = getPriceOf(symbol, ticker20minAgo, idx);

      if(!previousPrice || !prev20minPrice) {
        sendLogs(`${prefix(id)} for coin: ${symbol} returning cos their price is not defined`);
        console.log(`${prefix(id)} for coin: ${symbol} returning ${previousPrice} and ${prev20minPrice }`);
        return;
      }

        let prev10minDeltaPerc = ((previousPrice - prev20minPrice)/prev20minPrice) *100; 
        price20minBack = prev20minPrice;
        if(prev10minDeltaPerc >= 1.5) 
          prevChangePerc = prev10minDeltaPerc;
          else
          prevChangePerc = 0;

 
        const currentPrice = parseFloat(currentCoin.last_price);
        const priceChangePercent = ((currentPrice - previousPrice) / previousPrice) * 100;
         // current should be increasing
         
        if (priceChangePercent >= priceHikeThreshold || ( priceChangePercent + prevChangePerc >= combineHikeThreshold && priceChangePercent > 1 )) { 
          if(prevChangePerc >= priceHikeThreshold ){
            sendLogs(`${prefix(id)} recommended return, prev Inc is too much for coin: ${symbol}`);
          }else{
          coinsWithHike.push({
            symbol,
            priceChangePercent,
            combineChangePercent: (prevChangePerc+priceChangePercent),
            currentPrice,
            previousPrice,
            price20minBack,
          });
        }
        }
        else if(priceChangePercent >= recheckThreshold && canCheckBranch ){
         canCheckBranch = false;
         setTimeout(() => {
         sendLogs(`${prefix(id)}  running after Timeout for coin: ${symbol}, price was: ${currentPrice}`);
          id= id+'#';
          let previousData2 = [...previousData]
          let ticker20minAgo2 = [...ticker20minAgo];
         checkPriceHike(previousData2,ticker20minAgo2,lag1min, false);
       }, 1000 * 30);
        }
        else{
          coinsFailedHike.push({
            symbol,
            curr10minDeltaPerc: priceChangePercent.toFixed(3),
            combineChangePercent: (prevChangePerc+priceChangePercent).toFixed(3),
            currentPrice,
            previousPrice,
            price20minBack,
          });
        }

          if(( priceChangePercent + prevChangePerc >=4.6 || priceChangePercent >= 4.6 ) && priceChangePercent <= recheckThreshold +1){
            slowRiseCoins.push({
              symbol,
              curr10minDeltaPerc: priceChangePercent.toFixed(3),
              combineChangePercent: (prevChangePerc+priceChangePercent).toFixed(3),
              currentPrice,
              previousPrice,
              price20minBack
            });
          }


      price20minBack=0;
      prevChangePerc = 0;
    });

    if(!matched){
    sendLogs(`${prefix(id)}  current symbol doesnot match with prev20min symbol`);
      console.log(`id: ${id} not matched`);
  }else{
    sendLogs(`${prefix(id)}  matched`);
    console.log(`id: ${id}  matched`);
    }

    if(slowRiseCoins.length > 0){
    sendLogs(`${prefix(id)} slowRise List: ${JSON.stringify(slowRiseCoins)}`);
    slowRiseBuyCheck(slowRiseCoins, id);
    }

    if(coinsWithHike.length > 0) {
    // Sort coins by price change percentage in descending order
    coinsWithHike.sort((a, b) => b.priceChangePercent - a.priceChangePercent);

    console.log(`${prefix(id)}  Coins with Price Hike (>20%): ${JSON.stringify(coinsWithHike)}`);
    sendLogs(`${prefix(id)}  Coins with Price Hike ***** (>${priceHikeThreshold}/${combineHikeThreshold}%): ${JSON.stringify(coinsWithHike)}`)

    for(let i = 0; i < coinsWithHike.length; i++){
      if(i != 0)
      id = id + '-';
      checkAndBuy(coinsWithHike,i,id);
     }
    }
    else{
      // send log for both type of comparisons
    coinsFailedHike.sort((a, b) => b.curr10minDeltaPerc - a.curr10minDeltaPerc);
    let coinsFailedHike2 = [...coinsFailedHike];
    coinsFailedHike2.sort((a, b) => b.combineChangePercent - a.combineChangePercent);

    console.log('No coin met the criteria of sudden hike')
    sendLogs(`${prefix(id)}  Max reached alone: ${JSON.stringify(Object.entries(coinsFailedHike).slice(0, 3))} Max reached combined: ${JSON.stringify(Object.entries(coinsFailedHike2).slice(0, 2))}`);
  
    if(id.includes('#') && !id.includes('##$$')){
      if(id.includes('##')){
    setTimeout(() => {
      sendLogs(`${prefix(id)}  running after Timeout`);
       id= id+'$';
      checkPriceHike(previousData,ticker20minAgo,lag1min, false);
    }, 1000 * 30);
  }else if(id.includes('##$')){
    setTimeout(() => {
      sendLogs(`${prefix(id)}  running after Timeout`);
       id= id+'$';
      checkPriceHike(previousData,ticker20minAgo,lag1min, false);
    }, 1000 * 30);
  }else{
    setTimeout(() => {
      sendLogs(`${prefix(id)}  running after Timeout`);
       id= id+'#';
      checkPriceHike(previousData,ticker20minAgo,lag1min, false);
    }, 1000 * 30);
  }
  }
  }

  } catch (error) {
    console.error('An error occurred in checkPriceHike funtion:', error);
    sendLogs(`${prefix(id)} error in checkPriceHike function: ${error.message}`);
    sendErrorMail(`Found Error: in checkPriceHike function ${error.message}` );
  }
}

async function checkAndBuy(coinsWithHike,i,_id){
  try{
    let id = _id;
  let isStillinc = await isStillIncr(coinsWithHike[i], id);
  if (! isStillinc ){
   return;
  }
  
     let result =await isSingleMinHike(coinsWithHike[i]);
      sendLogs(`${prefix(id)}  volume == 0 ? -> ${result}`);
     if(result){
       return;
     }

   sendLogs(`${prefix(id)}  +++++ virtual Coin: ${coinsWithHike[i].symbol} bought at ${coinsWithHike[i].currentPrice}. Preparing to sell`)
   console.log(`virtual Coin: ${coinsWithHike[i].symbol} bought at ${coinsWithHike[i].currentPrice} preparing to sell`);
   //buy at current market
   if(coinsWithHike[i].priceChangePercent >20 || coinsWithHike[i].combineChangePercent > 27){
    //  spikeGreedySell(coinsWithHike[i], id);
  }
    else if(coinsWithHike[i].priceChangePercent >18 || coinsWithHike[i].combineChangePercent > 23)
     sendLogs(`${prefix(id)} taking entry is dangerous.`)
   else
    greedySell(coinsWithHike[i], id);

    }
    catch(error){
      sendLogs(`${prefix(id)}  error in checkAndBuy: ${error.message}`);
      console.log(error);
      sendErrorMail(`Found Error: in checkAndBuy function ${error}` );

    }

}

async function greedySell(coinsWithHike, id){
  try {
    sendLogs(`${prefix(id)} GreedySell: `);
  const boughtPrice=coinsWithHike.currentPrice;
  const symbol=coinsWithHike.symbol;

  var maxPrice = parseFloat(boughtPrice);
  console.log(maxPrice);
  let cnt = 0;
  let _id=id;
  let isMoreThan3 =false;
  let moreThan3cnt = 0;
  let maxLossAccepted = -3;
  let targetProfit = 7;
  let lastcnt = 0;
  let lastPrice = 100;
  let profitArr=[]
  let isNegWig = false;
  let negWigTime =-100;
  let isPriceInc = false;
  let negWigNumber = 0;


  // Fetch ticker data every 3 seconds
  const intervalId = setInterval(async () => {
    try {
      const tickerData = await getTicker(symbol);
      let currentPrice;
      cnt++;

      if (!tickerData) {
        console.error(`Ticker data not available for ${symbol}`);
        return;
      }

      // run at every 3 seconds
      tickerData.forEach((currentTicker)=> {
        if(currentTicker.market == symbol){
         currentPrice = parseFloat(currentTicker.last_price);
        return;
      }
      });

      if (currentPrice != undefined) {

          const percentageEarned = (((currentPrice - boughtPrice) / boughtPrice) * 100).toFixed(3);
          if ( percentageEarned >= 3 || percentageEarned < maxLossAccepted ){
            // if price is bw -8 to 3 then do nothing, hope coin to inc more than 3%

            moreThan3cnt++;

            // Wig checking process
            profitArr.push(percentageEarned);
            if (profitArr.length > 5) {
              profitArr = profitArr.slice(-6);
              if (profitArr[5] - profitArr[3]  >= 5 || profitArr[5] - profitArr[0]>= 5) {
                // increased suddenly
                sendLogs(`${prefix(_id)} seems to be +ve wick, so selling.`);
                sendLogs(`${prefix(_id)} profitArr: ${profitArr.toString()}`);
                beGreedy(coinsWithHike, _id, -1);
                clearInterval(intervalId);
              }
            }else if(profitArr[profitArr.length - 1] - profitArr[0] > 3.5) {
              sendLogs(`${prefix(_id)} seems to be a +ve wick, so selling. profitArr: ${profitArr.toString()}`);
              beGreedy(coinsWithHike, _id, -1);
              clearInterval(intervalId);
            }

            // decreased suddenly.
            if (profitArr.length > 3 && (profitArr[5] - profitArr[3] < -3.4 
                || profitArr[5] - profitArr[0] < -3.4) && !isNegWig) {
              isNegWig = true;
              negWigTime = cnt;
              sendLogs(`${prefix(_id)} seems to be -ve wick, so skipping. Sum of last 3 percEarned: ${profitArr[2] - profitArr[0]}`);
            }
            sendLogs(`${prefix(_id)} profitArr: ${profitArr.toString()}`);

            // Reset -ve wig after 4*3 sec.
            if (negWigTime + 4 < cnt) isNegWig = false;

            if (isMoreThan3) {
              targetProfit = 18;
              if (lastcnt + 15 <= cnt) {
                // after 45 sec

                if (currentPrice < lastPrice) {
                  isPriceInc = false;
                  if ( isNegWig && negWigNumber == 0) { // allowed only once to skip selling cos of neg Wig.
                    sendLogs(`${prefix(_id)} seems to be -ve wick, so skipping sell.`);
                    negWigNumber++;
                  } else if( negWigTime >= cnt - 18){
                    sendLogs(`${prefix(_id)} skipping sell. last price ${lastPrice} was on cliff, currentPrice: ${currentPrice}`);
                  }
                  else if (percentageEarned >= 2.7) {
                    sendLogs(
                      `${prefix(_id)} Price droped from last Price: ${lastPrice} currentPrice: ${currentPrice} perc. Earned: ${(percentageEarned)}%`);
                    beGreedy(coinsWithHike, _id, -0.5);
                    clearInterval(intervalId);
                  }else if(percentageEarned < 2.7){
                    maxLossAccepted = 0;
                  }
                } else {
                  isPriceInc = true;
                }

                lastPrice = currentPrice;
                lastcnt = cnt;
                sendLogs(`${prefix(_id)} After 45 sec perc. Earned: ${percentageEarned}% last Price: ${lastPrice} `);
              }
            }

            if (moreThan3cnt >= 3 && !isMoreThan3 ) {
              maxLossAccepted = -2;
              isMoreThan3 = true;
              lastPrice = currentPrice; // initalize for the first time
              sendLogs(`${prefix(_id)} more than 3 = true: ${percentageEarned}`);
            }

            // If targetProfit < 3 then no one can stop me to sell whether more than targetProfit or less than maxLossAccepted
            if (
              (percentageEarned >= targetProfit || percentageEarned < maxLossAccepted) &&
             ( !isNegWig && !isPriceInc || targetProfit < 3) 
            ) {
              // Extreme case.

              sendLogs(`${prefix(_id)} selling from last if block: targetProfit: ${targetProfit} 
              percentageEarned: ${percentageEarned}`);
              beGreedy(coinsWithHike, _id, -0.3);
              clearInterval(intervalId);
            }
          }
         
           
         else{
          sendLogs(`${prefix(_id)} trying to sell coin: ${symbol} cnt: ${cnt}, pending Percentage Earned: ${percentageEarned} `);
            if(isMoreThan3 && percentageEarned <= 0){
              targetProfit = 2.4;
            }
        } 
        sendLogs(`${prefix(_id)} trying to sell coin: ${symbol} with (>3% or <-8%) cnt: ${cnt} current price: ${currentPrice} Percentage Earned: ${percentageEarned} targetProfit: ${targetProfit} isNegWig: ${isNegWig}`);
      }

    } catch (error) {
      console.error('An error occurred:', error);
      sendLogs(`${prefix(id)} error in greedySell function inside scheduler: ${error.message}`);
      sendErrorMail(`Found Error: in greedySell function ${error.message}` );

    }
  }, 3000); // 3 seconds in milliseconds
}catch (error) {
  console.log('An error occurred:', error);
  sendLogs(`${prefix(id)} error in greedySell function: ${error.message}`);
  sendErrorMail(`Found Error: in greedySell function2 ${error.message}` );

}
}

function getPriceOf(symbol, arr, probableIdx){
  if(arr[probableIdx].market == symbol ){
    if(!arr[probableIdx].last_price) return undefined;
    return parseFloat(arr[probableIdx].last_price);

    }
    else{
      for (const coinObj of arr) {
        if (coinObj.market == symbol) {
            if (!coinObj.last_price) return undefined;
            return parseFloat(coinObj.last_price);
        }
    }
}
    return undefined;
  }










async function isStillIncr( coinsWithHike, id ){
  let symbol = coinsWithHike.symbol;
  let shouldReturn = false;
  try {
  let priceHistory= await getPriceHistory(coinsWithHike.symbol);
  if(priceHistory && priceHistory.length > 15){
    let price30minBack = priceHistory[priceHistory.length -15];
    let arr= priceHistory.slice(0, -6);
    let temp=arr[0];

    for(let i=1; i<arr.length; i++){
      if( ( (Math.abs(temp - arr[i]) * 100 )/ Math.min(temp,arr[i])) > (5.5*coinsWithHike.combineChangePercent)/17 ){
        sendLogs( `${prefix(id)} recommended return for coin: ${coinsWithHike.symbol}, might have incerased already candle length: ${( (Math.abs(temp - arr[i]) * 100 )/ Math.min(temp,arr[i])).toFixed(3)}% `);
       shouldReturn = true;
        break;
      }
    temp = arr[i];
  }

   priceHistory = priceHistory.slice(0,-4);
   priceHistory.sort((a, b) => b - a); // desc remember original array is modified.
   if( ((0.07 * priceHistory[0]) + priceHistory[0] ) >= coinsWithHike.currentPrice) {  // max till now should be lesser 7%
    let check = priceHistory.slice(0,10).toString();
    sendLogs( `${prefix(id)} recommended return coin: ${coinsWithHike.symbol}, might have incerased already max price: ${priceHistory[0]}, history: ${check}` );
    shouldReturn = true;
  }

  if( ((coinsWithHike.price20minBack - priceHistory[priceHistory.length - 8])/priceHistory[priceHistory.length - 8]) > 23 ) { // gradually already increased by more than 23%
    sendLogs( `${prefix(id)} recommended return coin: ${coinsWithHike.symbol}, cos 9th lowest price was ${priceHistory[priceHistory.length - 8]} lesser than 23%` );
    shouldReturn =true;
  }

  if( ( (coinsWithHike.price20minBack - price30minBack) * 100 / price30minBack ) > 15){ // ensure sudden hike is first time after tiny candles 
    sendLogs( `${prefix(id)} recommended return for coin: ${coinsWithHike.symbol}, You have missed right time to buy. Recently incr. ${((coinsWithHike.price20minBack - price30minBack )* 100 / price30minBack).toFixed(3)  }%` );
   shouldReturn =true;
  }

  if(shouldReturn) {
   return false; // Coin will not be bought
  }
}
} catch (error) {sendLogs( `${prefix(id)} Catch error: ${error}` ); sendErrorMail(`Found Error: in isStillInc ${error}` );}

//------------------------------------------------------------------------------

 for ( let i=0; i<10; i++ ){
     await sleep(3 * 1000);
     let secFurtherList= await getTicker();
     
    for (const secFurther of secFurtherList) {
     if (secFurther.market === coinsWithHike.symbol) {
     let delta = (parseFloat(secFurther.last_price)- parseFloat(coinsWithHike.currentPrice)) / parseFloat(coinsWithHike.currentPrice) * 100;

     if (delta >= 1 ) {
     // sendLogs(`${prefix(id)}  second candle's first 30sec delta: ${delta} and secFurther: ${parseFloat(secFurther.last_price)}, returning...`);
      sendLogs(`${prefix(id)}  second candle's first ${i} loop delta: ${delta} for ${symbol}: and secFurther: ${parseFloat(secFurther.last_price)}`);
       coinsWithHike.currentPrice = parseFloat(secFurther.last_price);
      return true;
      }
      if (i == 9 ){
       sendLogs(`${prefix(id)}  second candle's first ${i} loop delta: ${delta} for ${symbol}: and secFurther: ${parseFloat(secFurther.last_price)}, returning`);
      }
      break;
  }
    }

 }
 return false;
}



async function beGreedy(coinsWithHike, id, maxGreedy){
  try {
    const boughtPrice=coinsWithHike.currentPrice;
    const symbol=coinsWithHike.symbol;
    sendLogs(`${prefix(id)}  inside beGreedy`);
  
    // var maxPrice =-1;
    // console.log(maxPrice);
    // let cnt = 0;
    
    // if (maxGreedy == undefined)
    //   maxGreedy = -2;
     
    // // Fetch ticker data every 3 seconds
    // const intervalId = setInterval(async () => {
    //   try {
        const tickerData = await getTicker();
        let currentPrice;
    //     cnt++;

        if (!tickerData) {
          console.error(`Ticker data not available for ${symbol}`);
          return;
        }

    //     // run at every 3 seconds
        tickerData.forEach((currentTicker)=> {
          if(currentTicker.market == symbol){
           currentPrice = parseFloat(currentTicker.last_price);
          // if(maxPrice == -1)
          //  maxPrice = currentPrice;
          return; // leaves only current iteration
        }
        });
  
    //     console.log(currentPrice,maxPrice);
    //     if (currentPrice != undefined) {
  
    //       if (currentPrice >= maxPrice) {
    //         maxPrice = currentPrice;
    //         console.log(`New max price for ${symbol}: ${maxPrice}`);
    //         sendLogs(`${prefix(id)} updated maxPrice: ${maxPrice}` );          

    //       }
    //       else{
          // const priceChangePercent = ((currentPrice - maxPrice ) / maxPrice) * 100;
  
    //       if (priceChangePercent <= maxGreedy) {
            const percentageEarned = ((currentPrice - boughtPrice) / boughtPrice) * 100;
            sell('',id,symbol,boughtPrice,currentPrice,'',percentageEarned,'','','')  
        //   }
        //   sendLogs(`${prefix(id)} inside beGreedy current price: ${currentPrice} priceChange%: ${priceChangePercent} maxPrice: ${maxPrice}` );          
        //   }
          
        // }
    //   } catch (error) {
    //     console.error('An error occurred:', error);
    //   }
    // }, 3000); // 3 seconds in milliseconds
  }catch (error) {
    console.log('An error occurred:', error);
    sendErrorMail(`Found Error: in beGreedy function ${error.message}` );

  }
}


export function getTime() {
  const nowUTC = new Date(); // Current UTC time
  const now = new Date(new Date(nowUTC.getTime() + (5 * 60 + 30) * 60000)); // Adding 5 hours and 30 minutes);

  const hours = now.getUTCHours().toString().padStart(2, '0');
  const minutes = now.getUTCMinutes().toString().padStart(2, '0');
  const seconds = now.getUTCSeconds().toString().padStart(2, '0');

  return `${hours}:${minutes}:${seconds}`;
}

export function getNowDate(){
   const nowUTC = new Date(); // Current UTC time
  return new Date(new Date(nowUTC.getTime() + (5 * 60 + 30) * 60000)).getTime(); // Adding 5 hours and 30 minutes
}

async function isSingleMinHike(coinToMonitor) {
  const symbol=coinToMonitor.symbol;
  const hikeRecordedPerc=coinToMonitor.priceChangePercent;
  let pair=getPair(symbol);
  if( ! pair)
  return true;

  let lastCandles=await getLastCandles(pair);
  lastCandles=lastCandles.slice(0,15);

  const priceChange = coinToMonitor.currentPrice - coinToMonitor.previousPrice;

  let cnt=0;
  for(const coinDetails of lastCandles){
    if(coinDetails.volume == 0){
      sendLogs(`${prefix(id)}  in singleMinHike for coin: ${symbol}, volume == ${coinDetails.volume}`);
      return true;
    }
  }
  lastCandles=lastCandles.slice(0,4);

  // for(const coinDetails of lastCandles){
  //   let open=coinDetails.open;
  //   let close=coinDetails.close;
  //   let changePerc= ((close - open)/priceChange) * 100;
  //   // console.log(`changePerc ${changePerc}`);
  //   if (changePerc > 60 && cnt==0){ // current min is increasing 
  //     sendLogs(`${prefix(id)}  in singleMinHike changePerc > 60 && cnt==0`);
  //    return false;
  //   }
  //   else if(changePerc > 60 ){
  //     sendLogs(`${prefix(id)}  in singleMinHike changePerc > 60`);
  //     return true;
  //   }
  // }
  return false;
}

async function getLastCandles(coinName){    
    return fetch(CONSTANT.publicbaseurl + `/market_data/candles?pair=${coinName}&interval=1m`)
      .then(response => response.json())
      .catch(error => {
        console.error('An error occurred:', error);
        throw error; 
      });
}

function sell(intervalId,id,symbol,boughtPrice,currentPrice,maxPrice,percentageEarned,cntLoss,cntLossRestore,cnt){
  sendLogs(`${prefix(id)}  For coin: ${symbol} Bought Price: ${boughtPrice}  Selling Price: ${currentPrice} max price: ${maxPrice}  Percentage Earned/loss: ${percentageEarned.toFixed(2)}% cntLoss: ${cntLoss} cntLossRestore: ${cntLossRestore} cnt: ${cnt}`);
  console.log(`For coin: ${symbol} Bought Price: ${boughtPrice}  Selling Price: ${currentPrice} max price: ${maxPrice} Percentage Earned/loss: ${percentageEarned.toFixed(2)}%`);
  sendLogs(`${prefix(id)} ----------------------------------------------------------`);
  sendEmail(`From Hike, for coin: ${symbol}, \nBought Price: ${boughtPrice}  Selling Price: ${currentPrice}  Percentage Earned/loss: ${percentageEarned.toFixed(2)}% `)
 //clear the interval
 clearInterval(intervalId);
}

export function prefix(id){
return `id: ${id} ${getTime()}: `;
}

function isPriceEqual(incTicker,coinsWithHike){
  const symbol=coinsWithHike.symbol;
  const price=parseFloat(coinsWithHike.currentPrice); // bought price
  for (const currentTicker of incTicker) {
    if (currentTicker.market === symbol) {
      console.log(parseFloat(currentTicker.last_price), price, parseFloat(currentTicker.last_price) === price);
  
      if (parseFloat(currentTicker.last_price) === price) {
        return true;
      } else {
        return false;
      }
    }
  }
  return true;
  }

