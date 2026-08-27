require('dotenv').config();
const express = require('express');
const cors = require('cors');
const ccxt = require('ccxt');

const app = express();
app.use(cors());
app.use(express.json()); // To parse JSON bodies

const PORT = process.env.PORT || 3000;
const TRADE_PERCENTAGE = parseFloat(process.env.TRADE_BALANCE_PERCENTAGE || 5) / 100;
const USE_TESTNET = process.env.USE_TESTNET === 'true';

// Initialize Exchange Clients
const exchanges = {};

if (process.env.BYBIT_API_KEY && process.env.BYBIT_API_SECRET) {
    exchanges.bybit = new ccxt.bybit({
        apiKey: process.env.BYBIT_API_KEY,
        secret: process.env.BYBIT_API_SECRET,
        enableRateLimit: true,
        options: {
            defaultType: 'swap', // Set default to Perpetual/Futures
        },
    });
    if (USE_TESTNET) {
        exchanges.bybit.setSandboxMode(true);
    }
}

if (process.env.WEEX_API_KEY && process.env.WEEX_API_SECRET) {
    exchanges.weex = new ccxt.weex({
        apiKey: process.env.WEEX_API_KEY,
        secret: process.env.WEEX_API_SECRET,
        enableRateLimit: true,
        options: {
            defaultType: 'swap',
        },
    });
    if (USE_TESTNET) {
        exchanges.weex.setSandboxMode(true);
    }
}

// Function to calculate order size based on balance percentage
async function calculateOrderSize(exchange, symbol) {
    try {
        // Fetch balance for the quote currency (usually USDT)
        const quoteCurrency = symbol.split('/')[1].split(':')[0]; // e.g., 'BTC/USDT:USDT' -> 'USDT'
        const balance = await exchange.fetchBalance();
        
        let availableBalance = 0;
        if (balance[quoteCurrency] && balance[quoteCurrency].free) {
            availableBalance = balance[quoteCurrency].free;
        }

        if (availableBalance <= 0) {
            throw new Error(`Insufficient ${quoteCurrency} free balance.`);
        }

        // Fetch market info to get current price
        const ticker = await exchange.fetchTicker(symbol);
        const currentPrice = ticker.last;

        if (!currentPrice) {
            throw new Error(`Could not fetch price for ${symbol}`);
        }

        // Amount of quote currency to spend
        const spendAmount = availableBalance * TRADE_PERCENTAGE;
        
        // Calculate amount of base currency to buy
        const orderSize = spendAmount / currentPrice;
        
        // Load markets if not loaded to get precision limits
        await exchange.loadMarkets();
        const market = exchange.market(symbol);
        
        // Format size to exchange precision
        const formattedSize = exchange.amountToPrecision(symbol, orderSize);
        return parseFloat(formattedSize);
        
    } catch (error) {
        console.error('Error calculating order size:', error);
        throw error;
    }
}

// Execute Trade Route
// Expected payload: { exchange: 'bybit', symbol: 'BTC/USDT:USDT', side: 'buy' }
app.post('/api/trade', async (req, res) => {
    const { exchange: exchangeName, symbol, side } = req.body;

    if (!exchangeName || !symbol || !side) {
        return res.status(400).json({ error: 'Missing required parameters (exchange, symbol, side).' });
    }

    const exchange = exchanges[exchangeName.toLowerCase()];
    if (!exchange) {
        return res.status(400).json({ error: `Exchange ${exchangeName} is not configured or initialized.` });
    }

    try {
        console.log(`[${new Date().toISOString()}] Received signal: ${side.toUpperCase()} ${symbol} on ${exchangeName}`);
        
        // Calculate the position size based on % of free balance
        const amount = await calculateOrderSize(exchange, symbol);
        console.log(`Calculated order size: ${amount} based on ${TRADE_PERCENTAGE * 100}% of balance`);

        if (amount <= 0) {
             return res.status(400).json({ error: 'Calculated order size is too small.' });
        }

        // Place Market Order (Futures)
        const order = await exchange.createMarketOrder(symbol, side, amount);
        
        console.log(`Order successfully placed: ${order.id}`);
        res.json({ success: true, orderId: order.id, details: order });

    } catch (error) {
        console.error(`Trade execution failed:`, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Host static frontend files (if deploying to VPS later)
app.use(express.static('../'));

app.listen(PORT, () => {
    console.log(`Trading Backend listening on port ${PORT}`);
    console.log(`Loaded exchanges: ${Object.keys(exchanges).join(', ') || 'None (check .env file)'}`);
    console.log(`Trade sizing: ${TRADE_PERCENTAGE * 100}% of available balance`);
    console.log(`Testnet Mode: ${USE_TESTNET ? 'ON' : 'OFF'}`);
});
