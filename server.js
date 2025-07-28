const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Bot configuration
const BOT_TOKEN = '8105964064:AAE1rkye54RSBevmnYIIOBpCZnAkrMX-VsE';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const WEB_APP_URL = 'https://tap-to-earn-bot-production.up.railway.app';

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const db = new sqlite3.Database('taptoearn.db');

// Initialize database tables
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER UNIQUE,
        username TEXT,
        first_name TEXT,
        wallet_address TEXT,
        balance REAL DEFAULT 0,
        total_taps INTEGER DEFAULT 0,
        today_taps INTEGER DEFAULT 0,
        remaining_taps INTEGER DEFAULT 100,
        referrer_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_tap_reset DATE DEFAULT CURRENT_DATE
    )`);

    // Packages table
    db.run(`CREATE TABLE IF NOT EXISTS packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        package_type TEXT,
        price REAL,
        max_earn REAL,
        current_earned REAL DEFAULT 0,
        taps_used INTEGER DEFAULT 0,
        max_taps INTEGER,
        purchase_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        expiry_date DATETIME,
        is_active BOOLEAN DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users (telegram_id)
    )`);

    // Transactions table
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        type TEXT,
        amount REAL,
        status TEXT DEFAULT 'pending',
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (telegram_id)
    )`);

    // Referrals table
    db.run(`CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id INTEGER,
        referred_id INTEGER,
        commission_earned REAL DEFAULT 0,
        is_active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (referrer_id) REFERENCES users (telegram_id),
        FOREIGN KEY (referred_id) REFERENCES users (telegram_id)
    )`);
});

// Helper functions
function getUser(telegramId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE telegram_id = ?', [telegramId], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function createUser(telegramId, username, firstName, referrerId = null) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO users (telegram_id, username, first_name, referrer_id) VALUES (?, ?, ?, ?)',
            [telegramId, username, firstName, referrerId],
            function(err) {
                if (err) reject(err);
                else {
                    // Add referral if exists
                    if (referrerId) {
                        db.run('INSERT INTO referrals (referrer_id, referred_id) VALUES (?, ?)', 
                               [referrerId, telegramId]);
                    }
                    resolve(this.lastID);
                }
            }
        );
    });
}

function resetDailyTaps(telegramId) {
    return new Promise((resolve, reject) => {
        const today = new Date().toISOString().split('T')[0];
        db.run(`
            UPDATE users 
            SET today_taps = 0, 
                remaining_taps = 100, 
                last_tap_reset = ?
            WHERE telegram_id = ? AND last_tap_reset != ?
        `, [today, telegramId, today], function(err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}

// Telegram Bot Commands
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    const username = msg.from.username;
    const firstName = msg.from.first_name;
    
    let referrerId = null;
    if (match[1]) {
        const referralCode = match[1].trim();
        if (referralCode.startsWith(' ref_')) {
            referrerId = parseInt(referralCode.replace(' ref_', ''));
        }
    }

    try {
        let user = await getUser(telegramId);
        
        if (!user) {
            await createUser(telegramId, username, firstName, referrerId);
            
            const welcomeMessage = `🎉 Welcome to Tap to Earn! 🎉

💰 Earn real TON cryptocurrency by tapping!
📱 Purchase packages to increase your earning potential
👥 Refer friends and earn commissions

Click the button below to start earning!`;

            bot.sendMessage(chatId, welcomeMessage, {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🚀 Start Earning', web_app: { url: WEB_APP_URL } }
                    ]]
                }
            });
        } else {
            bot.sendMessage(chatId, `👋 Welcome back ${firstName}! Ready to earn some TON?`, {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '💰 Open App', web_app: { url: WEB_APP_URL } }
                    ]]
                }
            });
        }
    } catch (error) {
        console.error('Error in /start command:', error);
        bot.sendMessage(chatId, 'Sorry, something went wrong. Please try again.');
    }
});

bot.onText(/\/balance/, async (msg) => {
    const telegramId = msg.from.id;
    const chatId = msg.chat.id;

    try {
        const user = await getUser(telegramId);
        if (user) {
            const message = `💰 Your Stats:
Balance: ${user.balance.toFixed(4)} TON
Total Taps: ${user.total_taps}
Today's Taps: ${user.today_taps}
Remaining Taps: ${user.remaining_taps}`;
            bot.sendMessage(chatId, message);
        } else {
            bot.sendMessage(chatId, 'Please start the bot first with /start');
        }
    } catch (error) {
        console.error('Error in /balance command:', error);
        bot.sendMessage(chatId, 'Error retrieving balance.');
    }
});

// API Routes

// Serve the mini app
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get user data
app.get('/api/user/:telegramId', async (req, res) => {
    try {
        const telegramId = parseInt(req.params.telegramId);
        await resetDailyTaps(telegramId);
        
        const user = await getUser(telegramId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Get active packages
        const packages = await new Promise((resolve, reject) => {
            db.all(`
                SELECT * FROM packages 
                WHERE user_id = ? AND is_active = 1 AND expiry_date > datetime('now')
            `, [telegramId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        // Get referral stats
        const referralStats = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 
                    COUNT(*) as total_referrals,
                    COALESCE(SUM(commission_earned), 0) as total_commission
                FROM referrals 
                WHERE referrer_id = ?
            `, [telegramId], (err, row) => {
                if (err) reject(err);
                else resolve(row || { total_referrals: 0, total_commission: 0 });
            });
        });

        res.json({
            ...user,
            active_packages: packages.length,
            packages: packages,
            referral_count: referralStats.total_referrals,
            referral_earnings: referralStats.total_commission
        });
    } catch (error) {
        console.error('Error getting user data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Handle tap action
app.post('/api/tap', async (req, res) => {
    try {
        const { telegramId } = req.body;
        await resetDailyTaps(telegramId);
        
        const user = await getUser(telegramId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (user.remaining_taps <= 0) {
            return res.status(400).json({ error: 'No taps remaining today' });
        }

        // Check for active packages
        const activePackages = await new Promise((resolve, reject) => {
            db.all(`
                SELECT * FROM packages 
                WHERE user_id = ? AND is_active = 1 AND expiry_date > datetime('now')
                ORDER BY price DESC
            `, [telegramId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        if (activePackages.length === 0) {
            return res.status(400).json({ error: 'No active packages' });
        }

        // Calculate tap earnings based on highest package
        const highestPackage = activePackages[0];
        const baseEarning = highestPackage.price * 0.001; // 0.1% of package price per tap
        
        // Update user balance and taps
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE users 
                SET balance = balance + ?,
                    total_taps = total_taps + 1,
                    today_taps = today_taps + 1,
                    remaining_taps = remaining_taps - 1
                WHERE telegram_id = ?
            `, [baseEarning, telegramId], function(err) {
                if (err) reject(err);
                else resolve();
            });
        });

        // Update package earnings
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE packages 
                SET current_earned = current_earned + ?,
                    taps_used = taps_used + 1
                WHERE id = ?
            `, [baseEarning, highestPackage.id], function(err) {
                if (err) reject(err);
                else resolve();
            });
        });

        // Add transaction record
        db.run(`
            INSERT INTO transactions (user_id, type, amount, status, description)
            VALUES (?, 'tap_earn', ?, 'completed', 'Tap earning')
        `, [telegramId, baseEarning]);

        // Pay referral commission (10%)
        if (user.referrer_id) {
            const commission = baseEarning * 0.1;
            db.run(`
                UPDATE users 
                SET balance = balance + ?
                WHERE telegram_id = ?
            `, [commission, user.referrer_id]);

            db.run(`
                UPDATE referrals 
                SET commission_earned = commission_earned + ?
                WHERE referrer_id = ? AND referred_id = ?
            `, [commission, user.referrer_id, telegramId]);

            db.run(`
                INSERT INTO transactions (user_id, type, amount, status, description)
                VALUES (?, 'referral', ?, 'completed', 'Referral commission')
            `, [user.referrer_id, commission]);
        }

        res.json({
            success: true,
            earned: baseEarning,
            new_balance: user.balance + baseEarning,
            remaining_taps: user.remaining_taps - 1
        });

    } catch (error) {
        console.error('Error processing tap:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Purchase package
app.post('/api/purchase-package', async (req, res) => {
    try {
        const { telegramId, packageType, price, maxEarn } = req.body;
        
        const user = await getUser(telegramId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Calculate expiry date (30 days from now)
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 30);

        // Calculate max taps for this package
        const maxTaps = Math.floor(maxEarn / (price * 0.001));

        // Insert new package
        await new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO packages (user_id, package_type, price, max_earn, max_taps, expiry_date)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [telegramId, packageType, price, maxEarn, maxTaps, expiryDate.toISOString()], function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            });
        });

        // Add transaction record
        db.run(`
            INSERT INTO transactions (user_id, type, amount, status, description)
            VALUES (?, 'purchase', ?, 'completed', ?)
        `, [telegramId, price, `Package purchase: ${packageType}`]);

        res.json({
            success: true,
            message: 'Package purchased successfully',
            expiry_date: expiryDate.toISOString()
        });

    } catch (error) {
        console.error('Error purchasing package:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update wallet address
app.post('/api/update-wallet', async (req, res) => {
    try {
        const { telegramId, walletAddress } = req.body;
        
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE users 
                SET wallet_address = ?
                WHERE telegram_id = ?
            `, [walletAddress, telegramId], function(err) {
                if (err) reject(err);
                else resolve();
            });
        });

        res.json({ success: true, message: 'Wallet address updated' });

    } catch (error) {
        console.error('Error updating wallet:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Withdraw request
app.post('/api/withdraw', async (req, res) => {
    try {
        const { telegramId, amount } = req.body;
        
        const user = await getUser(telegramId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (!user.wallet_address) {
            return res.status(400).json({ error: 'Wallet address not set' });
        }

        if (amount < 1) {
            return res.status(400).json({ error: 'Minimum withdrawal is 1 TON' });
        }

        if (amount > user.balance) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Update user balance
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE users 
                SET balance = balance - ?
                WHERE telegram_id = ?
            `, [amount, telegramId], function(err) {
                if (err) reject(err);
                else resolve();
            });
        });

        // Add withdrawal transaction
        db.run(`
            INSERT INTO transactions (user_id, type, amount, status, description)
            VALUES (?, 'withdrawal', ?, 'pending', ?)
        `, [telegramId, amount, `Withdrawal to ${user.wallet_address}`]);

        res.json({
            success: true,
            message: 'Withdrawal request submitted',
            new_balance: user.balance - amount
        });

    } catch (error) {
        console.error('Error processing withdrawal:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Bot token: ${BOT_TOKEN}`);
    console.log(`💾 Database: taptoearn.db`);
    console.log(`🌐 Mini app available at: http://localhost:${PORT}`);
});

// Error handling
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    process.exit(1);
});
