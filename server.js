const express = require('express');
const WebSocket = require('ws');
const axios = require('axios');
const { SMA, RSI, ATR } = require('technicalindicators');

const app = express();
const port = 3000;
const wss = new WebSocket.Server({ port: 8080 });

let tradeLog = [];
let capital = 0;
let initialCapital = 0;
let symbol = '';
let isRunning = false;
let data = [];
let position = 0;
let shortPosition = 0;

app.use(express.static('public'));
app.use(express.json());

function getHistoricalData(symbol) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=192`;
  return axios.get(url).then(response => {
    return response.data.map(d => ({
      timestamp: d[0],
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    }));
  });
}

function calculateIndicators(data) {
  const closePrices = data.map(d => d.close);
  const highPrices = data.map(d => d.high);
  const lowPrices = data.map(d => d.low);

  const smaShort = SMA.calculate({ period: 5, values: closePrices });
  const smaLong = SMA.calculate({ period: 16, values: closePrices });
  const rsi = RSI.calculate({ period: 14, values: closePrices });
  const atr = ATR.calculate({ period: 14, high: highPrices, low: lowPrices, close: closePrices });

  return data.map((d, i) => ({
    ...d,
    SMA_Short: smaShort[i - 4],
    SMA_Long: smaLong[i - 15],
    RSI: rsi[i - 13],
    ATR: atr[i - 13],
  }));
}

function executeTrade() {
  data = calculateIndicators(data);

  data.forEach(d => {
    let action = null;
    if (d.SMA_Short > d.SMA_Long && d.RSI < 70) {
      action = 'Buy';
    } else if (d.SMA_Short < d.SMA_Long && d.RSI > 30) {
      action = 'Sell';
    }

    if (action === 'Buy' && capital > 0) {
      const entryPrice = d.close;
      const stopLoss = entryPrice - 1.0 * d.ATR;
      const takeProfit = entryPrice + 1.5 * d.ATR;
      position = capital / entryPrice;
      capital = 0;
      tradeLog.push({ action: 'Buy', price: entryPrice, capital, position, shortPosition });
    } else if (action === 'Sell' && position > 0) {
      const exitPrice = d.close;
      capital = position * exitPrice;
      position = 0;
      tradeLog.push({ action: 'Sell', price: exitPrice, capital, position, shortPosition });
    } else if (action === 'Sell' && shortPosition === 0 && position === 0) {
      const entryPrice = d.close;
      const stopLoss = entryPrice + 1.0 * d.ATR;
      const takeProfit = entryPrice - 1.5 * d.ATR;
      shortPosition = capital / entryPrice;
      capital = 0;
      tradeLog.push({ action: 'Short', price: entryPrice, capital, position, shortPosition });
    } else if (action === 'Buy' && shortPosition > 0) {
      const exitPrice = d.close;
      capital = shortPosition * (2 * entryPrice - exitPrice);
      shortPosition = 0;
      tradeLog.push({ action: 'Cover', price: exitPrice, capital, position, shortPosition });
    }
  });
}

app.post('/start', async (req, res) => {
  symbol = req.body.symbol.toUpperCase();
  initialCapital = parseFloat(req.body.capital);
  capital = initialCapital;
  tradeLog = [];
  isRunning = true;

  data = await getHistoricalData(symbol);
  res.json({ status: 'started', symbol, capital: initialCapital });
});

app.post('/stop', (req, res) => {
  isRunning = false;
  res.json({ status: 'stopped' });
});

app.get('/trades', (req, res) => {
  res.json(tradeLog);
});

app.get('/update', (req, res) => {
  if (isRunning) {
    axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`).then(response => {
      const livePrice = parseFloat(response.data.price);
      const newRow = {
        timestamp: Date.now(),
        open: livePrice,
        high: livePrice,
        low: livePrice,
        close: livePrice,
        volume: 0,
      };
      data.push(newRow);
      if (data.length > 192) data.shift();  // Keep only the last 192 records
      executeTrade();
    });
  }
  res.json({ status: 'updated' });
});

wss.on('connection', ws => {
  ws.on('message', message => {
    if (message === 'update') {
      if (isRunning) {
        axios.get(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`).then(response => {
          const livePrice = parseFloat(response.data.price);
          const newRow = {
            timestamp: Date.now(),
            open: livePrice,
            high: livePrice,
            low: livePrice,
            close: livePrice,
            volume: 0,
          };
          data.push(newRow);
          if (data.length > 192) data.shift();  // Keep only the last 192 records
          executeTrade();

          const latestData = data[data.length - 1];

          ws.send(JSON.stringify({
            action: 'update',
            price: latestData.close,
            smaShort: latestData.SMA_Short,
            smaLong: latestData.SMA_Long,
            rsi: latestData.RSI,
            atr: latestData.ATR,
            tradeLog,
          }));
        });
      }
    }
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
