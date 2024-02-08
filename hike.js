import { getCandleChart,getMarketDetails,getTicker } from "./ApiInfo.js";
import { sendEmail } from "./Email.js";
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
      const previousCoin=previousData[idx];
      // console.log(`previousData ${previousCoin}`);
      const previousPrice = parseFloat(previousCoin.last_price);

      if(symbol !==previousCoin.market)
      return;

      if(ticker20minAgo){
        let coin20minAgo = ticker20minAgo[idx];
        if(coin20minAgo.market == symbol ){
        let prev20minPrice = parseFloat(coin20minAgo.last_price);
        let prev10minDeltaPerc = ((previousPrice - prev20minPrice)/prev20minPrice) *100; 
        price20minBack = prev20minPrice;
        if(prev10minDeltaPerc >= 1.5) 
          prevChangePerc = prev10minDeltaPerc;
          else
          prevChangePerc = 0;

        }
        else{
          ticker20minAgo.forEach((coin20minAgo)=>{
            if(coin20minAgo.market == symbol){
            let prev20minPrice = parseFloat(coin20minAgo.last_price);
            let prev10minDeltaPerc = ((previousPrice - prev20minPrice)/prev20minPrice) *100; 
            price20minBack = prev20minPrice;
            if(prev10minDeltaPerc >= 1.5 ) 
              prevChangePerc = prev10minDeltaPerc;
              else
              prevChangePerc = 0;
            return;
          }

          })
          matched = false;
      }
        }
      // console.log(symbol, previousCoin.market)

      if (previousPrice) {
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
         checkPriceHike(previousData,ticker20minAgo,lag1min, false);
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

          if(priceChangePercent >= 4.6 && priceChangePercent <= recheckThreshold +1){
            slowRiseCoins.push({
              symbol,
              curr10minDeltaPerc: priceChangePercent.toFixed(3),
              combineChangePercent: (prevChangePerc+priceChangePercent).toFixed(3),
              currentPrice,
              previousPrice,
              price20minBack
            });
          }
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
    sendLogs(`${prefix(id)}  No coin met the criteria of sudden hike`);
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
    console.error('An error occurred:', error);
    sendLogs(`${prefix(id)} error in checkPriceHike function: ${error.message}`);
  }
}

async function checkAndBuy(coinsWithHike,i,_id){
  try{
    let id = _id;
  let isStillinc = await isStillIncr(coinsWithHike[i], id);
  sendLogs(`${prefix(id)}  isStillinc= ${isStillinc}`);
  if (! isStillinc ){
   sendLogs(`${prefix(id)}  second candle's first 30sec returned false, returning...`);
   return;
  }
  
     let result =await isSingleMinHike(coinsWithHike[i]);
    sendLogs(`${prefix(id)}  result of singleminHike = ${result}`);
     if(result){
       sendLogs(`${prefix(id)} For Coin ${coinsWithHike[i].symbol} : Single Min Hiked, recommended return...`);
       console.log(`${prefix(id)}  For Coin ${coinsWithHike[i].symbol} Single Min Hiked, recommended return...`);
       return;
     }
   sendLogs(`${prefix(id)}  +++++ virtual Coin: ${coinsWithHike[i].symbol} bought at ${coinsWithHike[i].currentPrice}. Preparing to sell`)
   console.log(`virtual Coin: ${coinsWithHike[i].symbol} bought at ${coinsWithHike[i].currentPrice} preparing to sell`);
   //buy at current market
   if(coinsWithHike[i].priceChangePercent >20 || coinsWithHike[i].combineChangePercent > 30)
     spikeGreedySell(coinsWithHike[i], id);
   else
    greedySell(coinsWithHike[i], id);

    }
    catch(error){
      sendLogs(`${prefix(id)}  error in checkAndBuy: ${error.message}`);
      console.log(error);
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
  let cntLoss=0;
  let cntLossRestore=0;
  let _id=id;
  let isMoreThan3 =false;
  let moreThan3cnt = 0;
  let maxLossAccepted = -10;
  let targetProfit = 7;
  let lastcnt = 0;
  let lastPrice = 100;
  let profitArr=[]
  let isNegWig = false;
  let negWigTime =0;
  let isPriceInc = false;


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

          const percentageEarned = ((currentPrice - boughtPrice) / boughtPrice) * 100;
          if ( percentageEarned >= 3 || percentageEarned < maxLossAccepted ){  // if price is bw -8 to 3 then do nothing, hope coin to inc more than 3%

            moreThan3cnt++;
            if(isMoreThan3){
              targetProfit = 10;
              if(lastcnt + 7 <= cnt ){ // after 21 sec
                if(currentPrice < lastPrice){
                  maxLossAccepted = -2;
                } 
                if(currentPrice < lastPrice ){
                  isPriceInc = false
                  if(profitArr.length >3 && (profitArr[2]- profitArr[1] < -5 || profitArr[3]- profitArr[0] < -5 )){
                    sendLogs(`${prefix(_id)} seems to be -ve wick, so skipping sell.`);
                  }else if( percentageEarned >= 2.7){
                  sendLogs(`${prefix(_id)} Being Greedy: perc. Earned: ${percentageEarned.toFixed(3)}% last Price: ${lastPrice} currentPrice: ${currentPrice}`);
                  beGreedy(coinsWithHike,_id,-0.5);
                  clearInterval(intervalId);
                  }
                }else{
                  isPriceInc =true;
                
                }
                lastPrice = currentPrice;
                lastcnt = cnt;
                sendLogs(`${prefix(_id)} After 21 sec perc. Earned: ${percentageEarned.toFixed(3)}% last Price: ${lastPrice} `);
              }

              // Wig checking process
              profitArr.push(percentageEarned);
              if(profitArr.length >3){
              profitArr=profitArr.slice(-4);
              if( profitArr[2] -profitArr[0] >= 7){   // increased suddenly
                sendLogs(`${prefix(_id)} seems to be wick, so selling. Sum of last 3 percEarned: ${profitArr[2] - profitArr[0]}`);
                beGreedy(coinsWithHike,_id,-1);
                clearInterval(intervalId);
            }
            sendLogs(`${prefix(_id)} profitArr: ${profitArr.toString()}`);
            }

            }

            // decreased suddenly.
            if(profitArr.length >3 && (profitArr[2]- profitArr[1] < -5 || profitArr[3]- profitArr[0] < -5 )){ 
              isNegWig =true;
              negWigTime = cnt;
              sendLogs(`${prefix(_id)} seems to be -ve wick, so skipping. Sum of last 3 percEarned: ${profitArr[2] - profitArr[0]}`);
            }

            // Reset -ve wig after 6*3 sec.
            if(negWigTime + 6 < cnt)
              isNegWig =false;

            if(moreThan3cnt >= 4){
              maxLossAccepted = -3;
              isMoreThan3 = true;
              lastPrice = currentPrice;
              sendLogs(`${prefix(_id)} more than 3 = true: ${percentageEarned.toFixed(3)}`);
            }

            if((percentageEarned >= targetProfit || percentageEarned < maxLossAccepted) && !isNegWig && !isPriceInc){  // Extreme case.

              sendLogs(`${prefix(_id)} inside greedy sell: targetProfit: ${targetProfit} percentageEarned: ${percentageEarned}`); 
                beGreedy(coinsWithHike,_id,-0.3);
                clearInterval(intervalId);
             }

            }
         
            sendLogs(`${prefix(_id)} trying to sell coin: ${symbol} with (>3% or <-8%) cnt: ${cnt} current price: ${currentPrice} Percentage Earned: ${percentageEarned.toFixed(3)} targetProfit: ${targetProfit} isNegWig: ${isNegWig}`);
          }
         else{
          sendLogs(`${prefix(_id)} trying to sell coin: ${symbol} cnt: ${cnt}, pending Percentage Earned: ${percentageEarned.toFixed(3)} cntLossRestore: ${cntLossRestore}`);
          cntLossRestore++;
          if(cntLossRestore > 4) // if price remained better than -8% atleast for 4*3 sec then restore cntLoss variable to 0 
            cntLoss= 0;
            if(isMoreThan3 && percentageEarned <= 0){
              targetProfit = 3;
            }
            moreThan3cnt = 0;
        } 

    } catch (error) {
      console.error('An error occurred:', error);
      sendLogs(`${prefix(id)} error in greedySell function inside scheduler: ${error.message}`);
    }
  }, 3000); // 3 seconds in milliseconds
}catch (error) {
  console.log('An error occurred:', error);
  sendLogs(`${prefix(id)} error in greedySell function: ${error.message}`);

}
}












async function isStillIncr( coinsWithHike, id ){
  let symbol = coinsWithHike.symbol;
  let shouldReturn = false;
  try {
  let priceHistory= await getPriceHistory(coinsWithHike.symbol);
  if(priceHistory && priceHistory.length > 6){
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
  }

  if( ( (coinsWithHike.price20minBack - price30minBack) * 100 / price30minBack ) > 15){
    sendLogs( `${prefix(id)} recommended return for coin: ${coinsWithHike.symbol}, You have missed right time to buy. Recently incr. ${((coinsWithHike.price20minBack - price30minBack )* 100 / price30minBack).toFixed(3)  }%` );
   shouldReturn =true;
  }

  if(shouldReturn) {
   return false; // Coin will not be bought
  }
}
} catch (error) {sendLogs( `${prefix(id)} Catch error: ${error}` );}

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

async function isSingleMinHike(coinToMonitor) {
  const symbol=coinToMonitor.symbol;
  const hikeRecordedPerc=coinToMonitor.priceChangePercent;
  let pair=getPair(symbol);
  if( ! pair)
  return true;

  let lastCandles=await getLastCandles(pair);
  lastCandles=lastCandles.slice(0,9);

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

