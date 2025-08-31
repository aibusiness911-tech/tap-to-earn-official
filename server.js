const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000; // Render uses port 10000

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN || '8105964064:AAE1rkye54RSBevmnYIIOBpCZnAkrMX-VsE';
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;
const TON_API_KEY = process.env.TON_API_KEY || 'f0fae942c8bd9f735ce3cdf968aecdbc5bb2815d20966bf0a1b282b5ee9121d0';
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || 'CG-hNmKKyJRW1rZMhPASKoAYsEr';
const OWNER_WALLET = 'UQCUVSKh4SkJyEjhli0ntFVMkMYOLrm2_a5A6w4hWZwQCsOT';

// Initialize Telegram Bot (webhook mode, NO polling)
let bot;
try {
    bot = new TelegramBot(BOT_TOKEN, { polling: false });
    console.log('Telegram Bot initialized in webhook mode');
} catch (error) {
    console.error('Error initializing Telegram Bot:', error);
}

// In-memory storage (in production, use a proper database)
const users = new Map();
const transactions = new Map();
const pendingWithdrawals = new Map();

// Helper function to get current TON price
async function getTonPrice() {
    try {
        // Try multiple API sources for TON price
        const apis = [
            `https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd`,
            `https://api.coinbase.com/v2/exchange-rates?currency=TON`,
            `https://api.binance.com/api/v3/ticker/price?symbol=TONUSDT`
        ];
        
        for (const apiUrl of apis) {
            try {
                const response = await fetch(apiUrl, {
                    headers: {
                        'User-Agent': 'TapToEarnBot/1.0'
                    }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    
                    if (apiUrl.includes('coingecko')) {
                        return data['the-open-network']?.usd || 3.31;
                    } else if (apiUrl.includes('binance')) {
                        return parseFloat(data.price) || 3.31;
                    }
                }
            } catch (apiError) {
                console.log(`API ${apiUrl} failed:`, apiError.message);
                continue;
            }
        }
        
        return 3.31; // Fallback price
    } catch (error) {
        console.error('Error fetching TON price:', error);
        return 3.31; // Fallback price
    }
}

// Helper function to validate Telegram WebApp data
function validateTelegramData(initData) {
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        
        const dataCheckString = Array.from(urlParams.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => `${key}=${value}`)
            .join('\n');
        
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        
        return calculatedHash === hash;
    } catch (error) {
        console.error('Telegram validation error:', error);
        return false;
    }
}

// Helper function to check TON transactions
async function checkTonTransaction(address, amount, memo = '') {
    try {
        const response = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${OWNER_WALLET}&limit=10&api_key=${TON_API_KEY}`);
        const data = await response.json();
        
        if (!data.ok || !data.result) return false;
        
        const transactions = data.result;
        const targetAmount = Math.floor(amount * 1000000000); // Convert to nanoTON
        
        // Check recent transactions (last 10 minutes)
        const tenMinutesAgo = Date.now() - (10 * 60 * 1000);
        
        for (const tx of transactions) {
            if (tx.utime * 1000 < tenMinutesAgo) break;
            
            if (tx.in_msg && tx.in_msg.value && 
                parseInt(tx.in_msg.value) >= targetAmount &&
                tx.in_msg.source?.address === address) {
                return true;
            }
        }
        
        return false;
    } catch (error) {
        console.error('Error checking TON transaction:', error);
        return false;
    }
}

// Helper function to send TON (simplified - you'd use actual TON SDK)
async function sendTon(toAddress, amount, memo = '') {
    try {
        // This is a placeholder - in production, you'd use:
        // - TON SDK to create and sign transactions
        // - Your wallet's private key (securely stored)
        // - Proper transaction broadcasting
        
        console.log(`Sending ${amount} TON to ${toAddress} with memo: ${memo}`);
        
        // For demo purposes, we'll simulate a successful transaction
        return {
            success: true,
            txHash: crypto.randomBytes(32).toString('hex'),
            message: 'Transaction sent successfully'
        };
    } catch (error) {
        console.error('Error sending TON:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Get or create user
function getUser(userId) {
    if (!users.has(userId)) {
        const now = Date.now();
        users.set(userId, {
            id: userId,
            points: 0,
            tapsRemaining: 100,
            lastTapReset: now,
            activePackage: null,
            tapValue: 0.05,
            packageEarnings: 0,
            maxPackageEarnings: 0,
            unlimitedTaps: false,
            withdrawalCooldown: now, // Start with 59-day cooldown
            totalReferrals: 0,
            referralEarnings: 0,
            createdAt: now
        });
    }
    return users.get(userId);
}

// Check daily reset (UTC time)
function checkDailyReset(user) {
    const now = new Date();
    const lastReset = new Date(user.lastTapReset);
    
    if (now.getUTCDate() !== lastReset.getUTCDate() || 
        now.getUTCMonth() !== lastReset.getUTCMonth() || 
        now.getUTCFullYear() !== lastReset.getUTCFullYear()) {
        
        if (!user.unlimitedTaps) {
            user.tapsRemaining = 100;
        }
        user.lastTapReset = now.getTime();
    }
}

// ===== TELEGRAM BOT HANDLERS =====

// /start command
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const referralCode = match[1] ? match[1].trim() : '';
    
    console.log(`User ${userId} started the bot`);
    
    try {
        // Create or get user
        const user = getUser(userId);
        
        // Handle referral if provided
        if (referralCode && referralCode !== userId) {
            const referrer = getUser(referralCode);
            if (!user.referredBy) {
                referrer.points += 100;
                referrer.totalReferrals += 1;
                referrer.referralEarnings += 100;
                user.referredBy = referralCode;
                
                // Notify referrer
                try {
                    await bot.sendMessage(referralCode, `🎉 New referral! You earned 100 points!`);
                } catch (error) {
                    console.log('Could not notify referrer');
                }
            }
        }
        
        const welcomeMessage = `
🎮 Welcome to Tap to Earn Bot!

💰 Earn TON cryptocurrency by tapping
📱 Complete tasks and challenges
👥 Invite friends for bonus rewards
💎 Withdraw your earnings to TON wallet

Your current balance: ${(user.points / 1000).toFixed(3)} points

Tap the button below to start earning!
        `;
        
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🎮 Open Mini App', web_app: { url: `https://tap-to-earn-bot.onrender.com` } }],
                    [
                        { text: '💰 Check Balance', callback_data: 'balance' },
                        { text: '👥 Referrals', callback_data: 'referrals' }
                    ],
                    [{ text: '❓ Help', callback_data: 'help' }]
                ]
            }
        };
        
        await bot.sendMessage(chatId, welcomeMessage, keyboard);
        
    } catch (error) {
        console.error('Error in /start command:', error);
        await bot.sendMessage(chatId, 'Sorry, there was an error. Please try again.');
    }
});

// /help command
bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    const helpMessage = `
📚 *Available Commands:*

/start - Start the bot and open mini app
/help - Show this help message
/balance - Check your current balance
/referrals - View your referral stats
/admin - Admin panel (admin only)

💡 *How to Play:*
1. Tap the screen to earn points
2. Buy packages to increase earnings
3. Invite friends for bonus rewards
4. Withdraw TON to your wallet

💰 *Earning Rates:*
- Default: 0.05 points per tap
- With packages: up to 10 points per tap
- Daily limit: 100 taps (unlimited with premium)

Need more help? Contact support!
    `;
    
    await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

// /balance command
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    try {
        const user = getUser(userId);
        checkDailyReset(user);
        
        const tonPrice = await getTonPrice();
                
        const dollarValue = user.points / 1000;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            withdrawalId,
            user: {
                ...user,
                dollarValue,
                tonValue,
                tonPrice
            },
            message: 'Withdrawal request submitted successfully!'
        });
    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({ error: 'Failed to process withdrawal' });
    }
});

// Get withdrawal status
app.get('/api/withdrawal/:withdrawalId', (req, res) => {
    try {
        const withdrawalId = req.params.withdrawalId;
        const withdrawal = pendingWithdrawals.get(withdrawalId);
        
        if (!withdrawal) {
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        
        res.json(withdrawal);
    } catch (error) {
        console.error('Error getting withdrawal status:', error);
        res.status(500).json({ error: 'Failed to get withdrawal status' });
    }
});

// Handle referral
app.post('/api/referral', (req, res) => {
    try {
        const { userId, referrerId } = req.body;
        
        if (!userId || !referrerId || userId === referrerId) {
            return res.status(400).json({ error: 'Invalid referral data' });
        }
        
        const user = getUser(userId);
        const referrer = getUser(referrerId);
        
        // Check if user is already counted as referral
        if (user.referredBy) {
            return res.status(400).json({ error: 'User already referred' });
        }
        
        // Award referral bonus
        referrer.points += 100; // 100 points for referral
        referrer.totalReferrals += 1;
        referrer.referralEarnings += 100;
        
        // Mark user as referred
        user.referredBy = referrerId;
        
        const tonPrice = 3.31;
        const dollarValue = referrer.points / 1000;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            referrer: {
                ...referrer,
                dollarValue,
                tonValue,
                tonPrice
            },
            message: 'Referral bonus awarded!'
        });
    } catch (error) {
        console.error('Referral error:', error);
        res.status(500).json({ error: 'Failed to process referral' });
    }
});

// Get referral data
app.get('/api/referrals/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        
        // Get referred users (in production, you'd query the database)
        const referredUsers = [];
        for (const [id, userData] of users.entries()) {
            if (userData.referredBy === userId) {
                referredUsers.push({
                    id: id,
                    username: `User${id.slice(-4)}`, // Simplified username
                    points: userData.points,
                    joinedAt: userData.createdAt
                });
            }
        }
        
        res.json({
            totalReferrals: user.totalReferrals,
            referralEarnings: user.referralEarnings,
            referrals: referredUsers,
            referralLink: `https://t.me/Taptoearnofficial_bot?start=${userId}`
        });
    } catch (error) {
        console.error('Error getting referrals:', error);
        res.status(500).json({ error: 'Failed to get referral data' });
    }
});

// Get current TON price
app.get('/api/ton-price', async (req, res) => {
    try {
        const price = await getTonPrice();
        res.json({ price });
    } catch (error) {
        console.error('Error getting TON price:', error);
        res.status(500).json({ error: 'Failed to get TON price' });
    }
});

// Webhook for TON payments (if using TON payment processor)
app.post('/api/webhook/ton', (req, res) => {
    try {
        const { transaction, status } = req.body;
        
        if (status === 'confirmed') {
            console.log('TON payment confirmed:', transaction);
            
            // Here you would:
            // 1. Verify the transaction
            // 2. Find the associated user/purchase
            // 3. Activate the package or process withdrawal
            
            // For now, just log it
            transactions.set(transaction.hash, {
                ...transaction,
                processed: true,
                processedAt: Date.now()
            });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// Admin endpoints
app.get('/api/admin/stats', (req, res) => {
    try {
        const stats = {
            totalUsers: users.size,
            totalTransactions: transactions.size,
            pendingWithdrawals: Array.from(pendingWithdrawals.values()).filter(w => w.status === 'pending').length,
            totalPoints: Array.from(users.values()).reduce((sum, user) => sum + user.points, 0),
            activePackages: Array.from(users.values()).filter(user => user.activePackage).length
        };
        
        res.json(stats);
    } catch (error) {
        console.error('Error getting admin stats:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Manual package activation (for admin use)
app.post('/api/admin/activate-package', (req, res) => {
    try {
        const { userId, packageId } = req.body;
        
        const user = getUser(userId);
        const packages = {
            '5': { price: 5, tapValue: 0.2, maxEarnings: 10000 },
            '10': { price: 10, tapValue: 0.25, maxEarnings: 20000 },
            '50': { price: 50, tapValue: 0.5, maxEarnings: 100000 },
            '100': { price: 100, tapValue: 1.0, maxEarnings: 200000 },
            '1000': { price: 1000, tapValue: 10.0, maxEarnings: 2000000 },
            '500': { price: 500, tapValue: 1.0, maxEarnings: -1, unlimitedTaps: true }
        };
        
        const packageData = packages[packageId];
        if (!packageData) {
            return res.status(400).json({ error: 'Invalid package' });
        }
        
        // Apply package
        user.activePackage = `${packageId}`;
        user.tapValue = packageData.tapValue;
        user.maxPackageEarnings = packageData.maxEarnings;
        user.packageEarnings = 0;
        
        if (packageData.unlimitedTaps) {
            user.unlimitedTaps = true;
        }
        
        res.json({
            success: true,
            message: `Package ${packageId} activated for user ${userId}`
        });
    } catch (error) {
        console.error('Error activating package:', error);
        res.status(500).json({ error: 'Failed to activate package' });
    }
});

// Manual withdrawal processing (for admin use)
app.post('/api/admin/process-withdrawal', async (req, res) => {
    try {
        const { withdrawalId } = req.body;
        
        const withdrawal = pendingWithdrawals.get(withdrawalId);
        if (!withdrawal) {
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ error: 'Withdrawal already processed' });
        }
        
        // Process the withdrawal
        const result = await sendTon(withdrawal.walletAddress, withdrawal.amount, `Manual-${withdrawalId}`);
        
        withdrawal.status = result.success ? 'completed' : 'failed';
        withdrawal.processedAt = Date.now();
        
        if (result.success) {
            withdrawal.txHash = result.txHash;
        } else {
            withdrawal.error = result.error;
        }
        
        res.json({
            success: true,
            withdrawal,
            message: result.success ? 'Withdrawal processed successfully' : 'Withdrawal processing failed'
        });
    } catch (error) {
        console.error('Error processing withdrawal:', error);
        res.status(500).json({ error: 'Failed to process withdrawal' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// ===== SERVER STARTUP =====

// Start server
app.listen(PORT, async () => {
    console.log(`🚀 Tap to Earn Bot server running on port ${PORT}`);
    console.log(`📱 Bot: @Taptoearnofficial_bot`);
    console.log(`💰 Owner Wallet: ${OWNER_WALLET}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    
    // Load initial TON price
    try {
        const price = await getTonPrice();
        console.log(`💎 Current TON Price: ${price}`);
    } catch (error) {
        console.error('Could not fetch initial TON price:', error);
    }
    
    // Set webhook after server starts
    if (WEBHOOK_URL) {
        console.log('⏳ Setting up webhook...');
        setTimeout(async () => {
            const webhookSet = await setWebhook();
            if (webhookSet) {
                console.log('✅ Webhook configured successfully');
                console.log(`🔗 Webhook URL: ${WEBHOOK_URL}/webhook`);
            } else {
                console.log('❌ Failed to set webhook - check your WEBHOOK_URL environment variable');
                console.log(`Expected format: https://your-app-name.onrender.com`);
            }
        }, 3000); // Wait 3 seconds for server to fully start
    } else {
        console.log('⚠️  WEBHOOK_URL not configured - bot will not receive messages');
        console.log('Please set WEBHOOK_URL environment variable to https://your-app-name.onrender.com');
    }
    
    console.log('\n📋 Setup checklist:');
    console.log(`✅ Bot Token: ${BOT_TOKEN ? 'Configured' : '❌ Missing'}`);
    console.log(`${WEBHOOK_URL ? '✅' : '❌'} Webhook URL: ${WEBHOOK_URL || 'Not set'}`);
    console.log(`${SUPABASE_URL ? '✅' : '⚠️ '} Supabase URL: ${SUPABASE_URL ? 'Configured' : 'Not set (using in-memory storage)'}`);
    console.log(`${ADMIN_TELEGRAM_ID ? '✅' : '⚠️ '} Admin ID: ${ADMIN_TELEGRAM_ID ? 'Configured' : 'Not set'}`);
    console.log('\n🌐 Available endpoints:');
    console.log(`• Main app: https://tap-to-earn-bot.onrender.com`);
    console.log(`• Admin panel: https://tap-to-earn-bot.onrender.com/admin`);
    console.log(`• Health check: https://tap-to-earn-bot.onrender.com/api/health`);
    console.log(`• Webhook: https://tap-to-earn-bot.onrender.com/webhook`);
});
        
        const balanceMessage = `
💰 *Your Balance:*

🪙 Points: ${user.points.toLocaleString()}
💵 USD Value: $${dollarValue.toFixed(4)}
💎 TON Value: ${tonValue.toFixed(6)} TON

📊 *Account Stats:*
⚡ Taps Remaining: ${user.unlimitedTaps ? '∞' : user.tapsRemaining}
📦 Active Package: ${user.activePackage || 'None'}
💰 Tap Value: ${user.tapValue} points
👥 Total Referrals: ${user.totalReferrals}

📈 Current TON Price: $${tonPrice}
        `;
        
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🎮 Play Now', web_app: { url: `https://tap-to-earn-bot.onrender.com` } }],
                    [{ text: '👥 Referrals', callback_data: 'referrals' }]
                ]
            }
        };
        
        await bot.sendMessage(chatId, balanceMessage, { 
            parse_mode: 'Markdown',
            ...keyboard
        });
        
    } catch (error) {
        console.error('Error in /balance command:', error);
        await bot.sendMessage(chatId, 'Error fetching balance. Please try again.');
    }
});

// /referrals command
bot.onText(/\/referrals/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    try {
        const user = getUser(userId);
        
        const referralMessage = `
👥 *Your Referral Stats:*

📊 Total Referrals: ${user.totalReferrals}
💰 Referral Earnings: ${user.referralEarnings} points
🔗 Your Referral Link:
\`https://t.me/Taptoearnofficial_bot?start=${userId}\`

💡 *How it works:*
• Share your link with friends
• Earn 100 points for each new user
• No limit on referrals!

Tap below to share your link:
        `;
        
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📤 Share Referral Link', switch_inline_query: `Join me in Tap to Earn Bot! https://t.me/Taptoearnofficial_bot?start=${userId}` }],
                    [{ text: '💰 Check Balance', callback_data: 'balance' }]
                ]
            }
        };
        
        await bot.sendMessage(chatId, referralMessage, {
            parse_mode: 'Markdown',
            ...keyboard
        });
        
    } catch (error) {
        console.error('Error in /referrals command:', error);
        await bot.sendMessage(chatId, 'Error fetching referral data. Please try again.');
    }
});

// /support command
bot.onText(/\/support/, async (msg) => {
    const chatId = msg.chat.id;
    
    const supportMessage = `
🛠️ *Support & Help*

Need assistance? Here's how to get help:

📧 Contact Support:
• Email: support@taptoearn.bot
• Telegram: @TapToEarnSupport

🔧 Common Issues:
• Bot not responding → Restart with /start
• Balance not updating → Wait a few seconds and check again
• Withdrawal issues → Contact admin
• Package problems → Use /packages command

💡 Quick Fixes:
• Clear browser cache
• Restart the mini app
• Check your internet connection

⚡ Response time: Usually within 24 hours
    `;
    
    await bot.sendMessage(chatId, supportMessage, { parse_mode: 'Markdown' });
});

// /withdraw command  
bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    try {
        const user = getUser(userId);
        const tonPrice = await getTonPrice();
        const dollarValue = user.points / 1000;
        const tonValue = dollarValue / tonPrice;
        
        // Check cooldown
        const now = Date.now();
        const cooldownEnd = user.withdrawalCooldown + (59 * 24 * 60 * 60 * 1000); // 59 days
        const isOnCooldown = now < cooldownEnd;
        const daysLeft = isOnCooldown ? Math.ceil((cooldownEnd - now) / (24 * 60 * 60 * 1000)) : 0;
        
        const withdrawMessage = `
💸 *Withdrawal Information*

💰 Your Current Balance:
• Points: ${user.points.toLocaleString()}
• USD Value: ${dollarValue.toFixed(4)}
• TON Value: ${tonValue.toFixed(6)} TON

📋 *Withdrawal Rules:*
• Minimum: 0.01 TON
• Fee: 1 TON (one-time)
• Cooldown: 59 days between withdrawals
• Status: ${isOnCooldown ? `🔒 ${daysLeft} days remaining` : '✅ Available'}

💎 Current TON Price: ${tonPrice}

${isOnCooldown ? 
    '⏳ Your next withdrawal will be available in ' + daysLeft + ' days.' : 
    '✅ You can withdraw now! Use the Mini App to process withdrawal.'
}

To withdraw, use the 🎮 Mini App button from /start
        `;
        
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🎮 Open Mini App', web_app: { url: 'https://tap-to-earn-bot.onrender.com' } }],
                    [{ text: '💰 Check Balance', callback_data: 'balance' }]
                ]
            }
        };
        
        await bot.sendMessage(chatId, withdrawMessage, { 
            parse_mode: 'Markdown',
            ...keyboard
        });
        
    } catch (error) {
        console.error('Error in /withdraw command:', error);
        await bot.sendMessage(chatId, 'Error fetching withdrawal info. Please try again.');
    }
});

// /packages command
bot.onText(/\/packages/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    try {
        const user = getUser(userId);
        const tonPrice = await getTonPrice();
        
        const packagesMessage = `
📦 *Available Packages*

💰 Current Package: ${user.activePackage || 'None'}
⚡ Current Tap Value: ${user.tapValue} points

🎯 *Package Options:*

💎 **$5 Package**
• Tap Value: 0.2 points
• Max Earnings: 10,000 points
• Price: ${(5/tonPrice).toFixed(3)} TON

💎 **$10 Package**
• Tap Value: 0.25 points  
• Max Earnings: 20,000 points
• Price: ${(10/tonPrice).toFixed(3)} TON

💎 **$50 Package**
• Tap Value: 0.5 points
• Max Earnings: 100,000 points
• Price: ${(50/tonPrice).toFixed(3)} TON

💎 **$100 Package**
• Tap Value: 1.0 points
• Max Earnings: 200,000 points
• Price: ${(100/tonPrice).toFixed(3)} TON

🚀 **$500 Unlimited**
• Tap Value: 1.0 points
• Unlimited Taps Daily!
• Price: ${(500/tonPrice).toFixed(3)} TON

🌟 **$1000 Premium**
• Tap Value: 10.0 points
• Max Earnings: 2,000,000 points
• Price: ${(1000/tonPrice).toFixed(3)} TON

💎 TON Price: ${tonPrice}

To buy packages, use the 🎮 Mini App!
        `;
        
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🎮 Buy Packages', web_app: { url: 'https://tap-to-earn-bot.onrender.com' } }],
                    [{ text: '💰 Check Balance', callback_data: 'balance' }]
                ]
            }
        };
        
        await bot.sendMessage(chatId, packagesMessage, { 
            parse_mode: 'Markdown',
            ...keyboard
        });
        
    } catch (error) {
        console.error('Error in /packages command:', error);
        await bot.sendMessage(chatId, 'Error fetching package info. Please try again.');
    }
});

// /stats command (public stats)
bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const stats = {
            totalUsers: users.size,
            totalPoints: Array.from(users.values()).reduce((sum, user) => sum + user.points, 0),
            activePackages: Array.from(users.values()).filter(user => user.activePackage).length,
            totalReferrals: Array.from(users.values()).reduce((sum, user) => sum + user.totalReferrals, 0)
        };
        
        const tonPrice = await getTonPrice();
        
        const statsMessage = `
📊 *Bot Statistics*

👥 Total Users: ${stats.totalUsers.toLocaleString()}
💰 Total Points: ${stats.totalPoints.toLocaleString()}
📦 Active Packages: ${stats.activePackages}
👥 Total Referrals: ${stats.totalReferrals}

💎 Current TON Price: ${tonPrice}
🤖 Bot Status: ✅ Online
⚡ Uptime: ${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m

Join the earning revolution! 🚀
        `;
        
        await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('Error in /stats command:', error);
        await bot.sendMessage(chatId, 'Error fetching stats. Please try again.');
    }
});
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    // Check if user is admin
    if (ADMIN_TELEGRAM_ID && userId !== ADMIN_TELEGRAM_ID) {
        await bot.sendMessage(chatId, '⛔ Access denied. Admin only.');
        return;
    }
    
    try {
        const stats = {
            totalUsers: users.size,
            totalTransactions: transactions.size,
            pendingWithdrawals: Array.from(pendingWithdrawals.values()).filter(w => w.status === 'pending').length,
            totalPoints: Array.from(users.values()).reduce((sum, user) => sum + user.points, 0),
            activePackages: Array.from(users.values()).filter(user => user.activePackage).length
        };
        
        const adminMessage = `
🔧 *Admin Panel:*

📊 *Statistics:*
👥 Total Users: ${stats.totalUsers}
💰 Total Points: ${stats.totalPoints.toLocaleString()}
📦 Active Packages: ${stats.activePackages}
💸 Pending Withdrawals: ${stats.pendingWithdrawals}
🔄 Total Transactions: ${stats.totalTransactions}

🌐 Admin Panel: https://tap-to-earn-bot.onrender.com/admin
        `;
        
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🌐 Open Admin Panel', url: 'https://tap-to-earn-bot.onrender.com/admin' }],
                    [{ text: '📊 Refresh Stats', callback_data: 'admin_stats' }]
                ]
            }
        };
        
        await bot.sendMessage(chatId, adminMessage, {
            parse_mode: 'Markdown',
            ...keyboard
        });
        
    } catch (error) {
        console.error('Error in /admin command:', error);
        await bot.sendMessage(chatId, 'Error loading admin data. Please try again.');
    }
});

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id.toString();
    const data = callbackQuery.data;
    
    console.log(`Callback query: ${data} from user ${userId}`);
    
    try {
        await bot.answerCallbackQuery(callbackQuery.id);
        
        switch(data) {
            case 'balance':
                // Execute balance command directly
                const user = getUser(userId);
                checkDailyReset(user);
                
                const tonPrice = await getTonPrice();
                const dollarValue = user.points / 1000;
                const tonValue = dollarValue / tonPrice;
                
                const balanceMessage = `
💰 *Your Balance:*

🪙 Points: ${user.points.toLocaleString()}
💵 USD Value: ${dollarValue.toFixed(4)}
💎 TON Value: ${tonValue.toFixed(6)} TON

📊 *Account Stats:*
⚡ Taps Remaining: ${user.unlimitedTaps ? '∞' : user.tapsRemaining}
📦 Active Package: ${user.activePackage || 'None'}
💰 Tap Value: ${user.tapValue} points
👥 Total Referrals: ${user.totalReferrals}

📈 Current TON Price: ${tonPrice}
                `;
                
                await bot.sendMessage(chatId, balanceMessage, { parse_mode: 'Markdown' });
                break;
                
            case 'referrals':
                // Execute referrals command directly
                const userRef = getUser(userId);
                
                const referralMessage = `
👥 *Your Referral Stats:*

📊 Total Referrals: ${userRef.totalReferrals}
💰 Referral Earnings: ${userRef.referralEarnings} points
🔗 Your Referral Link:
\`https://t.me/Taptoearnofficial_bot?start=${userId}\`

💡 *How it works:*
• Share your link with friends
• Earn 100 points for each new user
• No limit on referrals!
                `;
                
                await bot.sendMessage(chatId, referralMessage, { parse_mode: 'Markdown' });
                break;
                
            case 'help':
                // Execute help command directly
                const helpMessage = `
📚 *Available Commands:*

/start - Start the bot and open mini app
/help - Show this help message
/balance - Check your current balance
/referrals - View your referral stats
/admin - Admin panel (admin only)

💡 *How to Play:*
1. Tap the screen to earn points
2. Buy packages to increase earnings
3. Invite friends for bonus rewards
4. Withdraw TON to your wallet

💰 *Earning Rates:*
- Default: 0.05 points per tap
- With packages: up to 10 points per tap
- Daily limit: 100 taps (unlimited with premium)
                `;
                
                await bot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
                break;
                
            case 'admin_stats':
                if (ADMIN_TELEGRAM_ID && userId === ADMIN_TELEGRAM_ID) {
                    const stats = {
                        totalUsers: users.size,
                        totalTransactions: transactions.size,
                        pendingWithdrawals: Array.from(pendingWithdrawals.values()).filter(w => w.status === 'pending').length,
                        totalPoints: Array.from(users.values()).reduce((sum, user) => sum + user.points, 0),
                        activePackages: Array.from(users.values()).filter(user => user.activePackage).length
                    };
                    
                    const adminMessage = `
🔧 *Admin Panel:*

📊 *Statistics:*
👥 Total Users: ${stats.totalUsers}
💰 Total Points: ${stats.totalPoints.toLocaleString()}
📦 Active Packages: ${stats.activePackages}
💸 Pending Withdrawals: ${stats.pendingWithdrawals}
🔄 Total Transactions: ${stats.totalTransactions}

🌐 Admin Panel: https://tap-to-earn-bot.onrender.com/admin
                    `;
                    
                    await bot.sendMessage(chatId, adminMessage, { parse_mode: 'Markdown' });
                }
                break;
                
            default:
                await bot.sendMessage(chatId, 'Unknown command. Use /help for available commands.');
        }
    } catch (error) {
        console.error('Callback query error:', error);
        await bot.sendMessage(chatId, 'Error processing request. Please try again.');
    }
});

// Error handling for bot
bot.on('error', (error) => {
    console.error('Bot error:', error);
});

// ===== WEBHOOK SETUP =====

// Telegram Webhook endpoint
app.post('/webhook', (req, res) => {
    try {
        console.log('📨 Received webhook update:', JSON.stringify(req.body, null, 2));
        bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// Set webhook function
async function setWebhook() {
    try {
        if (!WEBHOOK_URL) {
            console.error('❌ WEBHOOK_URL environment variable is not set');
            return false;
        }
        
        const webhookUrl = `${WEBHOOK_URL}/webhook`;
        console.log(`🔗 Setting webhook to: ${webhookUrl}`);
        
        const result = await bot.setWebHook(webhookUrl);
        console.log('✅ Webhook set successfully:', result);
        return true;
    } catch (error) {
        console.error('❌ Failed to set webhook:', error);
        return false;
    }
}

// ===== WEB ROUTES =====

// Health check / Bot status
app.get('/', async (req, res) => {
    try {
        const tonPrice = await getTonPrice();
        res.json({
            status: 'Tap to Earn Bot is running!',
            bot: '@Taptoearnofficial_bot',
            webhook: WEBHOOK_URL ? `${WEBHOOK_URL}/webhook` : 'Not configured',
            tonPrice: tonPrice,
            timestamp: new Date().toISOString(),
            users: users.size,
            uptime: process.uptime()
        });
    } catch (error) {
        res.status(500).json({ error: 'Server error', message: error.message });
    }
});

// Serve admin panel
app.get('/admin', async (req, res) => {
    try {
        // Try to serve the admin panel HTML file from public folder first
        const adminPath = path.join(__dirname, 'public', 'admin.html');
        
        try {
            const html = await fs.readFile(adminPath, 'utf8');
            return res.send(html);
        } catch (err) {
            // If admin.html not found in public folder, create a working admin panel
            console.log('Admin panel file not found, serving default admin panel');
        }
        
        // Get current stats
        const stats = {
            totalUsers: users.size,
            totalTransactions: transactions.size,
            pendingWithdrawals: Array.from(pendingWithdrawals.values()).filter(w => w.status === 'pending').length,
            totalPoints: Array.from(users.values()).reduce((sum, user) => sum + user.points, 0),
            activePackages: Array.from(users.values()).filter(user => user.activePackage).length
        };
        
        const adminHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Admin Panel - Tap to Earn Bot</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container { 
            max-width: 1200px; 
            margin: 0 auto; 
            background: white; 
            border-radius: 15px; 
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #4CAF50 0%, #2196F3 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; }
        .header p { font-size: 1.1em; opacity: 0.9; }
        .stats-grid { 
            display: grid; 
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); 
            gap: 20px; 
            padding: 30px;
        }
        .stat-card { 
            background: linear-gradient(135deg, #ff6b6b 0%, #ee5a24 100%);
            color: white; 
            padding: 25px; 
            border-radius: 12px; 
            text-align: center;
            transform: translateY(0);
            transition: transform 0.3s ease;
        }
        .stat-card:nth-child(2) { background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%); }
        .stat-card:nth-child(3) { background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%); }
        .stat-card:nth-child(4) { background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%); }
        .stat-card:nth-child(5) { background: linear-gradient(135deg, #9C27B0 0%, #7B1FA2 100%); }
        .stat-card:hover { transform: translateY(-5px); }
        .stat-value { font-size: 3em; font-weight: bold; margin-bottom: 10px; }
        .stat-label { font-size: 1.1em; opacity: 0.9; }
        .controls {
            padding: 30px;
            background: #f8f9fa;
            border-top: 1px solid #dee2e6;
        }
        .control-section {
            margin-bottom: 30px;
        }
        .control-section h3 {
            color: #333;
            margin-bottom: 15px;
            font-size: 1.3em;
        }
        .form-group {
            display: flex;
            gap: 10px;
            margin-bottom: 15px;
            flex-wrap: wrap;
        }
        input, select, button {
            padding: 12px;
            border: 2px solid #ddd;
            border-radius: 8px;
            font-size: 16px;
        }
        button {
            background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
            color: white;
            border: none;
            cursor: pointer;
            transition: background 0.3s ease;
        }
        button:hover {
            background: linear-gradient(135deg, #45a049 0%, #4CAF50 100%);
        }
        .danger { background: linear-gradient(135deg, #f44336 0%, #d32f2f 100%); }
        .info-panel {
            background: #e3f2fd;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 30px;
            border-left: 5px solid #2196F3;
        }
        .status-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            background: #4CAF50;
            border-radius: 50%;
            margin-right: 8px;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔧 Admin Panel</h1>
            <p><span class="status-indicator"></span>Tap to Earn Bot - Live Dashboard</p>
        </div>
        
        <div class="info-panel">
            <strong>🤖 Bot Status:</strong> @Taptoearnofficial_bot is running<br>
            <strong>🔗 Webhook:</strong> https://tap-to-earn-bot.onrender.com/webhook<br>
            <strong>⏰ Last Updated:</strong> ${new Date().toLocaleString()}
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <div class="stat-value">${stats.totalUsers}</div>
                <div class="stat-label">Total Users</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.totalPoints.toLocaleString()}</div>
                <div class="stat-label">Total Points</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.activePackages}</div>
                <div class="stat-label">Active Packages</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.pendingWithdrawals}</div>
                <div class="stat-label">Pending Withdrawals</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">${stats.totalTransactions}</div>
                <div class="stat-label">Total Transactions</div>
            </div>
        </div>
        
        <div class="controls">
            <div class="control-section">
                <h3>👥 User Management</h3>
                <div class="form-group">
                    <input type="text" id="userId" placeholder="User ID" />
                    <select id="packageSelect">
                        <option value="5">$5 Package</option>
                        <option value="10">$10 Package</option>
                        <option value="50">$50 Package</option>
                        <option value="100">$100 Package</option>
                        <option value="500">$500 Unlimited</option>
                        <option value="1000">$1000 Premium</option>
                    </select>
                    <button onclick="activatePackage()">Activate Package</button>
                </div>
            </div>
            
            <div class="control-section">
                <h3>💸 Withdrawal Management</h3>
                <div class="form-group">
                    <input type="text" id="withdrawalId" placeholder="Withdrawal ID" />
                    <button onclick="processWithdrawal()">Process Withdrawal</button>
                    <button onclick="refreshStats()">Refresh Stats</button>
                </div>
            </div>
            
            <div class="control-section">
                <h3>📊 Quick Actions</h3>
                <div class="form-group">
                    <button onclick="window.open('/api/admin/stats', '_blank')">View Raw Stats</button>
                    <button onclick="window.open('/api/health', '_blank')">Health Check</button>
                    <button onclick="window.open('https://api.telegram.org/bot8105964064:AAE1rkye54RSBevmnYIIOBpCZnAkrMX-VsE/getWebhookInfo', '_blank')">Check Webhook</button>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        async function activatePackage() {
            const userId = document.getElementById('userId').value;
            const packageId = document.getElementById('packageSelect').value;
            
            if (!userId) {
                alert('Please enter a User ID');
                return;
            }
            
            try {
                const response = await fetch('/api/admin/activate-package', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId, packageId })
                });
                
                const result = await response.json();
                alert(result.message || 'Package activated successfully!');
                
                if (result.success) {
                    document.getElementById('userId').value = '';
                }
            } catch (error) {
                alert('Error activating package: ' + error.message);
            }
        }
        
        async function processWithdrawal() {
            const withdrawalId = document.getElementById('withdrawalId').value;
            
            if (!withdrawalId) {
                alert('Please enter a Withdrawal ID');
                return;
            }
            
            try {
                const response = await fetch('/api/admin/process-withdrawal', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ withdrawalId })
                });
                
                const result = await response.json();
                alert(result.message || 'Withdrawal processed!');
                
                if (result.success) {
                    document.getElementById('withdrawalId').value = '';
                }
            } catch (error) {
                alert('Error processing withdrawal: ' + error.message);
            }
        }
        
        function refreshStats() {
            window.location.reload();
        }
        
        // Auto-refresh stats every 30 seconds
        setInterval(() => {
            console.log('Auto-refreshing stats...');
            // You can add AJAX calls here to update stats without full page reload
        }, 30000);
    </script>
</body>
</html>
        `;
        
        res.send(adminHtml);
    } catch (error) {
        console.error('Error serving admin panel:', error);
        res.status(500).send(`
            <h1>Admin Panel Error</h1>
            <p>Error loading admin panel: ${error.message}</p>
            <p><a href="/">Back to main page</a></p>
        `);
    }
});

// ===== API ROUTES (Your existing API endpoints) =====

// Get user data
app.get('/api/user/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        
        // Check daily reset
        checkDailyReset(user);
        
        // Calculate current values
        const tonPrice = 3.31; // You'd fetch this in real-time
        const dollarValue = user.points / 1000;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            ...user,
            dollarValue,
            tonValue,
            tonPrice
        });
    } catch (error) {
        console.error('Error getting user:', error);
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

// Handle tap
app.post('/api/tap', (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }
        
        const user = getUser(userId);
        checkDailyReset(user);
        
        // Check if user can tap
        if (user.tapsRemaining <= 0 && !user.unlimitedTaps) {
            return res.status(400).json({ error: 'No taps remaining' });
        }
        
        // Check package limits
        if (user.maxPackageEarnings > 0 && user.packageEarnings >= user.maxPackageEarnings) {
            return res.status(400).json({ error: 'Package earning limit reached' });
        }
        
        // Process tap
        user.points += user.tapValue;
        user.packageEarnings += user.tapValue;
        
        if (!user.unlimitedTaps) {
            user.tapsRemaining--;
        }
        
        // Calculate current values
        const tonPrice = 3.31;
        const dollarValue = user.points / 1000;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            user: {
                ...user,
                dollarValue,
                tonValue,
                tonPrice
            }
        });
    } catch (error) {
        console.error('Tap error:', error);
        res.status(500).json({ error: 'Failed to process tap' });
    }
});

// Handle package purchase
app.post('/api/buy-package', async (req, res) => {
    try {
        const { userId, packageId, transactionHash } = req.body;
        
        if (!userId || !packageId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const user = getUser(userId);
        
        // Package configurations
        const packages = {
            '5': { price: 5, tapValue: 0.2, maxEarnings: 10000 },
            '10': { price: 10, tapValue: 0.25, maxEarnings: 20000 },
            '50': { price: 50, tapValue: 0.5, maxEarnings: 100000 },
            '100': { price: 100, tapValue: 1.0, maxEarnings: 200000 },
            '1000': { price: 1000, tapValue: 10.0, maxEarnings: 2000000 },
            '500': { price: 500, tapValue: 1.0, maxEarnings: -1, unlimitedTaps: true }
        };
        
        const packageData = packages[packageId];
        if (!packageData) {
            return res.status(400).json({ error: 'Invalid package' });
        }
        
        // In production, verify the transaction here
        if (transactionHash) {
            console.log(`Verifying transaction ${transactionHash} for package ${packageId}`);
        }
        
        // Apply package
        user.activePackage = `$${packageId}`;
        user.tapValue = packageData.tapValue;
        user.maxPackageEarnings = packageData.maxEarnings;
        user.packageEarnings = 0;
        
        if (packageData.unlimitedTaps) {
            user.unlimitedTaps = true;
        }
        
        const tonPrice = await getTonPrice();
        const dollarValue = user.points / 1000;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            user: {
                ...user,
                dollarValue,
                tonValue,
                tonPrice
            },
            message: 'Package activated successfully!'
        });
    } catch (error) {
        console.error('Package purchase error:', error);
        res.status(500).json({ error: 'Failed to process package purchase' });
    }
});

// Handle withdrawal request
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, amount, walletAddress, feeTransactionHash } = req.body;
        
        if (!userId || !amount || !walletAddress) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const user = getUser(userId);
        const tonPrice = await getTonPrice();
        
        // Validate withdrawal
        if (amount < 0.01) {
            return res.status(400).json({ error: 'Minimum withdrawal is 0.01 TON' });
        }
        
        const requiredPoints = amount * tonPrice * 1000;
        if (user.points < requiredPoints) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        // Check cooldown
        if (user.withdrawalCooldown) {
            const now = Date.now();
            const cooldownEnd = user.withdrawalCooldown + (59 * 24 * 60 * 60 * 1000);
            if (now < cooldownEnd) {
                return res.status(400).json({ error: 'Withdrawal is on cooldown' });
            }
        }
        
        // In production, verify the fee transaction here
        if (feeTransactionHash) {
            console.log(`Verifying fee transaction ${feeTransactionHash}`);
        }
        
        // Create withdrawal request
        const withdrawalId = crypto.randomBytes(16).toString('hex');
        pendingWithdrawals.set(withdrawalId, {
            userId,
            amount,
            walletAddress,
            status: 'pending',
            createdAt: Date.now()
        });
        
        // Deduct points and set cooldown
        user.points -= requiredPoints;
        user.withdrawalCooldown = Date.now();
        
        // In production, you'd queue this for actual TON sending
        setTimeout(async () => {
            try {
                const result = await sendTon(walletAddress, amount, `Withdrawal-${withdrawalId}`);
                if (result.success) {
                    const withdrawal = pendingWithdrawals.get(withdrawalId);
                    if (withdrawal) {
                        withdrawal.status = 'completed';
                        withdrawal.txHash = result.txHash;
                    }
                    console.log(`Withdrawal ${withdrawalId} completed`);
                }
            } catch (error) {
                console.error(`Withdrawal ${withdrawalId} failed:`, error);
                const withdrawal = pendingWithdrawals.get(withdrawalId);
                if (withdrawal) {
                    withdrawal.status = 'failed';
                    withdrawal.error = error.message;
                }
