const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL;
const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID);
const TON_API_KEY = process.env.TON_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const MINI_APP_URL = WEBHOOK_URL; // Your Render URL

// Initialize Telegram Bot (NO POLLING - webhook mode only)
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// In-memory storage for backward compatibility with your server.js
const users = new Map();
const transactions = new Map();
const pendingWithdrawals = new Map();

// Health check endpoint (REQUIRED for Render)
app.get('/', (req, res) => {
    res.json({ 
        status: 'Tap to Earn Bot is running!', 
        timestamp: new Date().toISOString(),
        webhook_url: WEBHOOK_URL + '/webhook',
        mini_app_url: MINI_APP_URL
    });
});

// Telegram Webhook endpoint
app.post('/webhook', (req, res) => {
    try {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    } catch (error) {
        console.error('Webhook error:', error);
        res.sendStatus(500);
    }
});

// Serve admin panel
app.get('/admin', (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'Fixed Admin Panel - Tap to Earn.html'));
    } catch (error) {
        res.status(404).send('Admin panel not found');
    }
});

// === TELEGRAM BOT HANDLERS ===

// Create or get user in Supabase
async function getOrCreateUser(telegramUser) {
    try {
        const { data: existingUser, error: fetchError } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', telegramUser.id)
            .single();

        if (existingUser) {
            // Update last active
            await supabase
                .from('users')
                .update({ 
                    last_active: new Date().toISOString(),
                    username: telegramUser.username || null
                })
                .eq('telegram_id', telegramUser.id);
            
            return existingUser;
        }

        // Create new user
        const { data: newUser, error: createError } = await supabase
            .from('users')
            .insert({
                telegram_id: telegramUser.id,
                username: telegramUser.username || null,
                first_name: telegramUser.first_name || null,
                last_name: telegramUser.last_name || null,
                balance: 0,
                total_taps: 0,
                energy: 1000,
                max_energy: 1000,
                level: 1,
                referral_count: 0
            })
            .select()
            .single();

        if (createError) throw createError;
        return newUser;
    } catch (error) {
        console.error('Error managing user:', error);
        return null;
    }
}

// Handle referral
async function handleReferral(newUserId, referrerId) {
    try {
        if (newUserId === referrerId) return false;
        
        const { data: user } = await supabase
            .from('users')
            .select('referrer_id')
            .eq('telegram_id', newUserId)
            .single();
        
        if (user?.referrer_id) return false;
        
        await supabase
            .from('users')
            .update({ referrer_id: referrerId })
            .eq('telegram_id', newUserId);
        
        const { data: referrer } = await supabase
            .from('users')
            .select('referral_count, balance')
            .eq('telegram_id', referrerId)
            .single();
        
        if (referrer) {
            await supabase
                .from('users')
                .update({ 
                    referral_count: (referrer.referral_count || 0) + 1,
                    balance: (parseFloat(referrer.balance) || 0) + 100
                })
                .eq('telegram_id', referrerId);
            
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('Error handling referral:', error);
        return false;
    }
}

// /start command
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const referralCode = match[1];
    
    try {
        const user = await getOrCreateUser(msg.from);
        
        if (referralCode && referralCode !== String(userId)) {
            const referrerId = parseInt(referralCode);
            if (!isNaN(referrerId)) {
                const referralSuccess = await handleReferral(userId, referrerId);
                if (referralSuccess) {
                    await bot.sendMessage(chatId, '✅ You were referred successfully! You and your referrer both received bonuses!');
                }
            }
        }
        
        const welcomeMessage = `
🎯 *Welcome to Tap to Earn Bot!*

Start earning points by tapping and referring friends!

💰 *Earning System:*
• Each tap = 0.05 points (without package)
• Each referral = 100 points
• 1000 points = $1

📱 *Open Mini App to start earning!*

Use /help to see all commands.`;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: '🎮 Open Mini App', web_app: { url: `${MINI_APP_URL}?userId=${userId}` } }],
                [{ text: '💰 Check Balance', callback_data: 'check_balance' }],
                [{ text: '👥 My Referrals', callback_data: 'check_referrals' }]
            ]
        };
        
        await bot.sendMessage(chatId, welcomeMessage, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard 
        });
    } catch (error) {
        console.error('Start command error:', error);
        await bot.sendMessage(chatId, 'An error occurred. Please try again later.');
    }
});

// /balance command
bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', userId)
            .single();
        
        if (error || !user) {
            await bot.sendMessage(chatId, 'User not found. Please use /start first.');
            return;
        }
        
        const balance = parseFloat(user.balance || 0);
        const dollarValue = balance / 1000;
        const tonPrice = await getTonPrice();
        const tonValue = dollarValue / tonPrice;
        
        const balanceMessage = `
💰 *Your Balance:*

📊 Points: ${balance.toFixed(2)}
💵 USD Value: $${dollarValue.toFixed(2)}
💎 TON Value: ${tonValue.toFixed(4)} TON

📈 Total Taps: ${user.total_taps || 0}
👥 Referrals: ${user.referral_count || 0}
⚡ Energy: ${user.energy}/${user.max_energy}
🎯 Level: ${user.level}

_Current TON Price: $${tonPrice.toFixed(2)}_`;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: '🎮 Open Mini App', web_app: { url: `${MINI_APP_URL}?userId=${userId}` } }],
                [{ text: '💸 Withdraw', callback_data: 'withdraw' }]
            ]
        };
        
        await bot.sendMessage(chatId, balanceMessage, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard 
        });
    } catch (error) {
        console.error('Balance command error:', error);
        await bot.sendMessage(chatId, 'Error fetching balance. Please try again later.');
    }
});

// /admin command (only for admin)
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (userId !== ADMIN_ID) {
        await bot.sendMessage(chatId, 'You do not have permission to access this command.');
        return;
    }
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '👨‍💼 Open Admin Panel', web_app: { url: `${MINI_APP_URL}/admin` } }],
            [{ text: '📊 View Stats', callback_data: 'admin_stats' }]
        ]
    };
    
    await bot.sendMessage(chatId, '👨‍💼 *Admin Panel Access:*', { 
        parse_mode: 'Markdown',
        reply_markup: keyboard 
    });
});

// Callback query handler
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    
    try {
        switch(data) {
            case 'check_balance':
                bot.emit('text', { 
                    chat: { id: chatId }, 
                    from: callbackQuery.from, 
                    text: '/balance' 
                });
                break;
        }
        
        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error('Callback query error:', error);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Error occurred', show_alert: true });
    }
});

// === API ENDPOINTS (from your server.js) ===

// Helper functions
async function getTonPrice() {
    try {
        const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd&x_cg_demo_api_key=${COINGECKO_API_KEY}`);
        const data = await response.json();
        return data['the-open-network']?.usd || 3.31;
    } catch (error) {
        console.error('Error fetching TON price:', error);
        return 3.31;
    }
}

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
            withdrawalCooldown: now,
            totalReferrals: 0,
            referralEarnings: 0,
            createdAt: now
        });
    }
    return users.get(userId);
}

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

// API Routes
app.get('/api/user/:userId', (req, res) => {
    try {
        const userId = req.params.userId;
        const user = getUser(userId);
        checkDailyReset(user);
        
        const tonPrice = 3.31;
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

app.post('/api/tap', (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }
        
        const user = getUser(userId);
        checkDailyReset(user);
        
        if (user.tapsRemaining <= 0 && !user.unlimitedTaps) {
            return res.status(400).json({ error: 'No taps remaining' });
        }
        
        if (user.maxPackageEarnings > 0 && user.packageEarnings >= user.maxPackageEarnings) {
            return res.status(400).json({ error: 'Package earning limit reached' });
        }
        
        user.points += user.tapValue;
        user.packageEarnings += user.tapValue;
        
        if (!user.unlimitedTaps) {
            user.tapsRemaining--;
        }
        
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

app.get('/api/ton-price', async (req, res) => {
    try {
        const price = await getTonPrice();
        res.json({ price });
    } catch (error) {
        console.error('Error getting TON price:', error);
        res.status(500).json({ error: 'Failed to get TON price' });
    }
});

// Set webhook function
async function setWebhook() {
    try {
        const webhookUrl = `${WEBHOOK_URL}/webhook`;
        console.log(`Setting webhook to: ${webhookUrl}`);
        
        const result = await bot.setWebHook(webhookUrl);
        console.log('✅ Webhook set successfully:', result);
        
        // Verify webhook
        const info = await bot.getWebHookInfo();
        console.log('📡 Webhook info:', info);
        
    } catch (error) {
        console.error('❌ Failed to set webhook:', error);
        
        // Retry once
        try {
            await bot.deleteWebHook();
            await new Promise(resolve => setTimeout(resolve, 2000));
            await bot.setWebHook(`${WEBHOOK_URL}/webhook`);
            console.log('✅ Webhook set successfully on retry');
        } catch (retryError) {
            console.error('❌ Webhook retry failed:', retryError);
        }
    }
}

// Start server
app.listen(PORT, async () => {
    console.log(`🚀 Unified server running on port ${PORT}`);
    console.log(`🤖 Bot: @Taptoearnofficial_bot`);
    console.log(`🌐 Mini App URL: ${MINI_APP_URL}`);
    console.log(`📡 Webhook URL: ${WEBHOOK_URL}/webhook`);
    
    // Set webhook after server is ready
    if (WEBHOOK_URL && BOT_TOKEN) {
        setTimeout(setWebhook, 3000); // Wait 3 seconds for server to be ready
    } else {
        console.error('❌ Missing BOT_TOKEN or WEBHOOK_URL environment variables');
    }
});

// Graceful shutdown
process.once('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.once('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

module.exports = app;
