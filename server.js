const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Bot configuration
const BOT_TOKEN = process.env.BOT_TOKEN || '8105964064:AAE1rkye54RSBevmnYIIOBpCZnAkrMX-VsE';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// API Keys
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || 'CG-hNmKKyJRW1rZMhPASKoAYsEr';
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || 'f0fae942c8bd9f735ce3cdf968aecdbc5bb2815d20966bf0a1b282b5ee9121d0';

// Wallet address
const OWNER_WALLET = 'UQCUVSKh4SkJyEjhli0ntFVMkMYOLrm2_a5A6w4hWZwQCsOT';

// In-memory storage (use database in production)
const users = new Map();
const transactions = new Map();
let tonPrice = 3.31; // Default price

// Package definitions
const PACKAGES = {
  '5': { price: 5, tapValue: 0.2, maxEarnings: 10000 },
  '10': { price: 10, tapValue: 0.25, maxEarnings: 20000 },
  '50': { price: 50, tapValue: 0.5, maxEarnings: 100000 },
  '100': { price: 100, tapValue: 1, maxEarnings: 200000 },
  '500': { price: 500, tapValue: 1, maxEarnings: -1, unlimited: true },
  '1000': { price: 1000, tapValue: 10, maxEarnings: 2000000 }
};

// Initialize user
function initUser(userId, username = '', firstName = '') {
  if (!users.has(userId)) {
    users.set(userId, {
      id: userId,
      username,
      firstName,
      points: 0,
      tapsRemaining: 100,
      tapValue: 0.05,
      referrals: [],
      referredBy: null,
      activePackage: null,
      packageEarnings: 0,
      maxPackageEarnings: 0,
      unlimitedTaps: false,
      lastTapReset: Date.now()
    });
  }
}

// Get user data
function getUser(userId) {
  if (!users.has(userId)) {
    initUser(userId);
  }
  return users.get(userId);
}

// Update TON price every 5 minutes
async function updateTonPrice() {
  try {
    const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd&x_cg_demo_api_key=${COINGECKO_API_KEY}`);
    tonPrice = response.data['the-open-network'].usd;
    console.log(`TON price updated: $${tonPrice}`);
  } catch (error) {
    console.error('Error updating TON price:', error);
  }
}

// Reset daily taps
function resetDailyTaps() {
  const now = Date.now();
  for (const [userId, user] of users) {
    if (now - user.lastTapReset > 24 * 60 * 60 * 1000) { // 24 hours
      if (!user.unlimitedTaps) {
        user.tapsRemaining = 100;
      }
      user.lastTapReset = now;
    }
  }
}

// Start price update interval
setInterval(updateTonPrice, 5 * 60 * 1000); // 5 minutes
setInterval(resetDailyTaps, 60 * 60 * 1000); // 1 hour

// Initial price fetch
updateTonPrice();

// Bot commands
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const referralCode = match ? match[1] : null;
  
  initUser(userId, msg.from.username || '', msg.from.first_name || '');
  
  // Handle referral
  if (referralCode && referralCode !== userId) {
    const user = getUser(userId);
    if (!user.referredBy) {
      user.referredBy = referralCode;
      
      // Add points to referrer
      const referrer = getUser(referralCode);
      if (referrer) {
        referrer.points += 100;
        referrer.referrals.push(userId);
        
        bot.sendMessage(referralCode, `🎉 You earned 100 points from a new referral!`);
      }
    }
  }
  
  const webAppUrl = `https://tap-to-earn-bot-production.up.railway.app?userId=${userId}`;
  
  bot.sendMessage(chatId, '🚀 Welcome to Tap to Earn Bot!\n\nTap the button below to start earning!', {
    reply_markup: {
      inline_keyboard: [[
        { text: '🎮 Open App', web_app: { url: webAppUrl } }
      ]]
    }
  });
});

// API Routes

// Get user data
app.get('/api/user/:userId', (req, res) => {
  const userId = req.params.userId;
  const user = getUser(userId);
  
  res.json({
    ...user,
    tonPrice,
    dollarValue: user.points / 1000,
    tonValue: (user.points / 1000) / tonPrice
  });
});

// Tap endpoint
app.post('/api/tap', (req, res) => {
  const { userId } = req.body;
  const user = getUser(userId);
  
  if (user.tapsRemaining <= 0 && !user.unlimitedTaps) {
    return res.status(400).json({ error: 'No taps remaining' });
  }
  
  // Check package earnings limit
  if (user.activePackage && user.maxPackageEarnings > 0 && 
      user.packageEarnings >= user.maxPackageEarnings) {
    return res.status(400).json({ error: 'Package earnings limit reached' });
  }
  
  user.points += user.tapValue;
  if (user.activePackage) {
    user.packageEarnings += user.tapValue;
  }
  
  if (!user.unlimitedTaps) {
    user.tapsRemaining--;
  }
  
  res.json({
    points: user.points,
    tapsRemaining: user.tapsRemaining,
    packageEarnings: user.packageEarnings,
    maxPackageEarnings: user.maxPackageEarnings
  });
});

// Get referrals
app.get('/api/referrals/:userId', (req, res) => {
  const userId = req.params.userId;
  const user = getUser(userId);
  
  const referralData = user.referrals.map(refId => {
    const refUser = getUser(refId);
    return {
      id: refId,
      username: refUser.username || refUser.firstName || 'Anonymous',
      points: refUser.points
    };
  });
  
  res.json({
    referrals: referralData,
    totalReferrals: referralData.length,
    referralLink: `https://t.me/Taptoearnofficial_bot?start=${userId}`
  });
});

// Get packages
app.get('/api/packages', (req, res) => {
  const packagesWithTon = Object.entries(PACKAGES).map(([key, pkg]) => ({
    id: key,
    ...pkg,
    priceInTon: pkg.price / tonPrice
  }));
  
  res.json({
    packages: packagesWithTon,
    tonPrice
  });
});

// Purchase package
app.post('/api/purchase', (req, res) => {
  const { userId, packageId } = req.body;
  const user = getUser(userId);
  const package = PACKAGES[packageId];
  
  if (!package) {
    return res.status(400).json({ error: 'Invalid package' });
  }
  
  const priceInTon = package.price / tonPrice;
  const transactionId = crypto.randomUUID();
  
  transactions.set(transactionId, {
    id: transactionId,
    userId,
    packageId,
    amount: priceInTon,
    status: 'pending',
    createdAt: Date.now()
  });
  
  // Generate payment link (simplified - in production use TON Connect)
  const paymentUrl = `ton://transfer/${OWNER_WALLET}?amount=${Math.round(priceInTon * 1000000000)}&text=package_${packageId}_${transactionId}`;
  
  res.json({
    transactionId,
    paymentUrl,
    amount: priceInTon,
    package: package
  });
});

// Confirm payment (simplified - in production implement webhook from TON)
app.post('/api/confirm-payment', (req, res) => {
  const { transactionId } = req.body;
  const transaction = transactions.get(transactionId);
  
  if (!transaction) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  
  const user = getUser(transaction.userId);
  const package = PACKAGES[transaction.packageId];
  
  // Activate package
  user.activePackage = transaction.packageId;
  user.tapValue = package.tapValue;
  user.packageEarnings = 0;
  user.maxPackageEarnings = package.maxEarnings;
  
  if (package.unlimited) {
    user.unlimitedTaps = true;
  }
  
  transaction.status = 'confirmed';
  
  res.json({ success: true, user: user });
});

// Withdrawal request
app.post('/api/withdraw', async (req, res) => {
  const { userId, amount, walletAddress } = req.body;
  const user = getUser(userId);
  
  const pointsRequired = amount * 1000;
  if (user.points < pointsRequired) {
    return res.status(400).json({ error: 'Insufficient points' });
  }
  
  // Withdrawal fee: 1 TON
  const withdrawalId = crypto.randomUUID();
  
  transactions.set(withdrawalId, {
    id: withdrawalId,
    userId,
    type: 'withdrawal',
    amount,
    walletAddress,
    status: 'pending_fee',
    createdAt: Date.now()
  });
  
  const feePaymentUrl = `ton://transfer/${OWNER_WALLET}?amount=1000000000&text=withdrawal_fee_${withdrawalId}`;
  
  res.json({
    withdrawalId,
    feePaymentUrl,
    fee: 1,
    amount
  });
});

// Confirm withdrawal fee
app.post('/api/confirm-withdrawal-fee', async (req, res) => {
  const { withdrawalId } = req.body;
  const transaction = transactions.get(withdrawalId);
  
  if (!transaction || transaction.type !== 'withdrawal') {
    return res.status(404).json({ error: 'Withdrawal not found' });
  }
  
  const user = getUser(transaction.userId);
  const pointsRequired = transaction.amount * 1000;
  
  // Deduct points
  user.points -= pointsRequired;
  
  // In production, implement actual TON transfer here
  transaction.status = 'processing';
  
  // Simulate processing time
  setTimeout(() => {
    transaction.status = 'completed';
    bot.sendMessage(transaction.userId, 
      `✅ Withdrawal completed!\n💰 Amount: ${transaction.amount} TON\n📍 Sent to: ${transaction.walletAddress}`
    );
  }, 5000);
  
  res.json({ success: true, status: 'processing' });
});

// Get TON price
app.get('/api/ton-price', (req, res) => {
  res.json({ price: tonPrice });
});

// Serve the main app
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Bot started successfully!`);
});
