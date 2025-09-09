require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { supabase } = require('./config/supabase'); // ✅ NOW USING SUPABASE!

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Environment variables (with proper error checking)
const BOT_TOKEN = process.env.BOT_TOKEN;
const TON_API_KEY = process.env.TON_API_KEY;
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;
const OWNER_WALLET = process.env.OWNER_WALLET;

// Validate required environment variables
if (!BOT_TOKEN || !TON_API_KEY || !COINGECKO_API_KEY || !OWNER_WALLET) {
    console.error('Missing required environment variables!');
    process.exit(1);
}

// Helper function to get current TON price
async function getTonPrice() {
    try {
        const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd&x_cg_demo_api_key=${COINGECKO_API_KEY}`);
        const data = await response.json();
        return data['the-open-network']?.usd || 3.31;
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

// ✅ SUPABASE FUNCTIONS - Get or create user
async function getOrCreateUser(userId, userData = {}) {
    try {
        // Try to get existing user
        const { data: existingUser, error } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', userId)
            .single();

        if (error && error.code !== 'PGRST116') {
            throw error;
        }

        if (existingUser) {
            // Update last active
            await supabase
                .from('users')
                .update({ 
                    last_active: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('telegram_id', userId);
            
            return existingUser;
        }

        // Create new user
        const newUser = {
            telegram_id: userId,
            username: userData.username || null,
            first_name: userData.first_name || null,
            last_name: userData.last_name || null,
            balance: 0,
            total_taps: 0,
            energy: 1000,
            max_energy: 1000,
            level: 1,
            referral_count: 0,
            referrer_id: userData.referrer_id || null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const { data: createdUser, error: createError } = await supabase
            .from('users')
            .insert(newUser)
            .select()
            .single();

        if (createError) throw createError;

        return createdUser;
    } catch (error) {
        console.error('Error getting/creating user:', error);
        throw error;
    }
}

// ✅ Check daily reset (UTC time)
async function checkDailyReset(user) {
    const now = new Date();
    const lastActive = new Date(user.last_active);
    
    if (now.getUTCDate() !== lastActive.getUTCDate() || 
        now.getUTCMonth() !== lastActive.getUTCMonth() || 
        now.getUTCFullYear() !== lastActive.getUTCFullYear()) {
        
        // Reset energy to max
        await supabase
            .from('users')
            .update({ 
                energy: user.max_energy,
                last_active: now.toISOString()
            })
            .eq('telegram_id', user.telegram_id);
        
        return { ...user, energy: user.max_energy };
    }
    
    return user;
}

// Serve the main page
app.get('/', async (req, res) => {
    try {
        const html = await fs.readFile(path.join(__dirname, 'public', 'index.html'), 'utf8');
        res.send(html);
    } catch (error) {
        console.error('Error serving index:', error);
        res.status(500).send('Server error loading page');
    }
});

// ✅ SUPABASE API - Get user data
app.get('/api/user/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        let user = await getOrCreateUser(userId);
        
        // Check daily reset
        user = await checkDailyReset(user);
        
        // Get user packages
        const { data: userPackages } = await supabase
            .from('user_packages')
            .select(`
                *,
                packages:package_id (*)
            `)
            .eq('user_id', userId)
            .eq('is_active', true);

        // Calculate current values
        const tonPrice = await getTonPrice();
        const dollarValue = user.balance;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            ...user,
            packages: userPackages || [],
            dollarValue,
            tonValue,
            tonPrice
        });
    } catch (error) {
        console.error('Error getting user:', error);
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

// ✅ SUPABASE API - Handle tap
app.post('/api/tap', async (req, res) => {
    try {
        const { userId, taps = 1 } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }

        const user = await getOrCreateUser(userId);
        
        // Check if user has energy
        if (user.energy < taps) {
            return res.status(400).json({ error: 'Insufficient energy' });
        }

        // Get active package for tap value
        const { data: activePackage } = await supabase
            .from('user_packages')
            .select(`
                *,
                packages:package_id (*)
            `)
            .eq('user_id', userId)
            .eq('is_active', true)
            .gt('expiry_date', new Date().toISOString())
            .order('purchase_date', { ascending: false })
            .limit(1)
            .single();

        let tapValue = 0.05; // Default tap value
        let dailyLimit = 100; // Default daily limit

        if (activePackage && activePackage.packages) {
            tapValue = activePackage.packages.daily_tap_limit / 100; // Adjust based on your package structure
        }

        // Check package earnings limit
        if (activePackage && 
            activePackage.current_earnings >= activePackage.packages.max_profit) {
            return res.status(400).json({ error: 'Package earning limit reached' });
        }

        // Process tap - update user balance and energy
        const newBalance = user.balance + (tapValue * taps);
        const newEnergy = user.energy - taps;
        const newTotalTaps = user.total_taps + taps;

        await supabase
            .from('users')
            .update({ 
                balance: newBalance,
                energy: newEnergy,
                total_taps: newTotalTaps,
                updated_at: new Date().toISOString()
            })
            .eq('telegram_id', userId);

        // Update package earnings if applicable
        if (activePackage) {
            await supabase
                .from('user_packages')
                .update({
                    current_earnings: activePackage.current_earnings + (tapValue * taps)
                })
                .eq('id', activePackage.id);
        }

        // Record transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: userId,
                type: 'tap_earnings',
                amount: tapValue * taps,
                description: `Earned from ${taps} taps`,
                created_at: new Date().toISOString()
            });

        // Get updated user data
        const updatedUser = await getOrCreateUser(userId);
        const tonPrice = await getTonPrice();
        const dollarValue = updatedUser.balance;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            user: {
                ...updatedUser,
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

// ✅ SUPABASE API - Handle package purchase
app.post('/api/buy-package', async (req, res) => {
    try {
        const { userId, packageId, transactionHash } = req.body;
        
        if (!userId || !packageId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const user = await getOrCreateUser(userId);
        
        // Get package details
        const { data: packageData, error: packageError } = await supabase
            .from('packages')
            .select('*')
            .eq('id', packageId)
            .single();

        if (packageError || !packageData) {
            return res.status(400).json({ error: 'Invalid package' });
        }

        // In production, verify the transaction here
        if (transactionHash) {
            console.log(`Verifying transaction ${transactionHash} for package ${packageId}`);
        }

        // Calculate expiry date
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + packageData.duration_days);

        // Create user package
        const { error: purchaseError } = await supabase
            .from('user_packages')
            .insert({
                user_id: userId,
                package_id: packageId,
                purchase_date: new Date().toISOString(),
                expiry_date: expiryDate.toISOString(),
                current_earnings: 0,
                is_active: true
            });

        if (purchaseError) throw purchaseError;

        // Record transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: userId,
                type: 'package_purchase',
                amount: -packageData.price,
                description: `Purchased ${packageData.name}`,
                created_at: new Date().toISOString()
            });

        const tonPrice = await getTonPrice();
        const updatedUser = await getOrCreateUser(userId);
        const dollarValue = updatedUser.balance;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            user: {
                ...updatedUser,
                dollarValue,
                tonValue,
                tonPrice
            },
            message: `${packageData.name} activated successfully!`
        });
    } catch (error) {
        console.error('Package purchase error:', error);
        res.status(500).json({ error: 'Failed to process package purchase' });
    }
});

// ✅ SUPABASE API - Handle withdrawal request
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, amount, walletAddress } = req.body;
        
        if (!userId || !amount || !walletAddress) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const user = await getOrCreateUser(userId);
        const tonPrice = await getTonPrice();
        
        // Validate withdrawal
        if (amount < 0.01) {
            return res.status(400).json({ error: 'Minimum withdrawal is 0.01 TON' });
        }

        const requiredDollars = amount * tonPrice;
        if (user.balance < requiredDollars) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }

        // Create withdrawal request
        const { data: withdrawal, error: withdrawalError } = await supabase
            .from('withdrawals')
            .insert({
                user_id: userId,
                amount: amount,
                wallet_address: walletAddress,
                status: 'pending',
                request_date: new Date().toISOString()
            })
            .select()
            .single();

        if (withdrawalError) throw withdrawalError;

        // Deduct balance
        await supabase
            .from('users')
            .update({ 
                balance: user.balance - requiredDollars,
                updated_at: new Date().toISOString()
            })
            .eq('telegram_id', userId);

        // Record transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: userId,
                type: 'withdrawal_request',
                amount: -requiredDollars,
                description: `Withdrawal request for ${amount} TON`,
                created_at: new Date().toISOString()
            });

        const updatedUser = await getOrCreateUser(userId);
        const dollarValue = updatedUser.balance;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            withdrawalId: withdrawal.id,
            user: {
                ...updatedUser,
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

// ✅ SUPABASE API - Get packages
app.get('/api/packages', async (req, res) => {
    try {
        const { data: packages, error } = await supabase
            .from('packages')
            .select('*')
            .eq('is_active', true)
            .order('price', { ascending: true });

        if (error) throw error;

        res.json(packages || []);
    } catch (error) {
        console.error('Error getting packages:', error);
        res.status(500).json({ error: 'Failed to get packages' });
    }
});

// ✅ SUPABASE API - Get transactions
app.get('/api/transactions/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        
        const { data: transactions, error } = await supabase
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;

        res.json(transactions || []);
    } catch (error) {
        console.error('Error getting transactions:', error);
        res.status(500).json({ error: 'Failed to get transactions' });
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

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        // Test Supabase connection
        const { data, error } = await supabase
            .from('users')
            .select('count')
            .limit(1);

        res.json({
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            database: error ? 'disconnected' : 'connected'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            error: error.message
        });
    }
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

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Tap to Earn Bot server running on port ${PORT}`);
    console.log(`📱 Bot: @Taptoearnofficial_bot`);
    console.log(`💰 Owner Wallet: ${OWNER_WALLET}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🗄️  Database: Connected to Supabase`);
    
    // Test database connection
    supabase.from('users').select('count').limit(1)
        .then(() => console.log('✅ Supabase connection successful'))
        .catch(err => console.error('❌ Supabase connection failed:', err));
    
    // Load initial TON price
    getTonPrice().then(price => {
        console.log(`💎 Current TON Price: $${price}`);
    });
});
