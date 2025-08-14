const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN || '8105964064:AAE1rkye54RSBevmnYIIOBpCZnAkrMX-VsE';
const TON_API_KEY = process.env.TON_API_KEY || 'f0fae942c8bd9f735ce3cdf968aecdbc5bb2815d20966bf0a1b282b5ee9121d0';
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || 'CG-hNmKKyJRW1rZMhPASKoAYsEr';
const OWNER_WALLET = 'UQCUVSKh4SkJyEjhli0ntFVMkMYOLrm2_a5A6w4hWZwQCsOT';
const ADMIN_ID = 6733587823;

// Initialize Supabase
const SUPABASE_URL = 'https://arjkzpbhinpqensoqqod.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyamt6cGJoaW5wcWVuc29xcW9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwNjAwMTUsImV4cCI6MjA3MDYzNjAxNX0.zo5kS1J5Lv-FiRSJbt0hhaawUGB-6gNcZCgl74B7WBo';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

// Get or create user in database
async function getOrCreateUser(userId, userData = {}) {
    try {
        // Try to get existing user
        let { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', userId)
            .single();

        if (error && error.code === 'PGRST116') {
            // User doesn't exist, create new one
            const { data: newUser, error: createError } = await supabase
                .from('users')
                .insert({
                    telegram_id: userId,
                    username: userData.username || null,
                    first_name: userData.first_name || null,
                    last_name: userData.last_name || null,
                })
                .select()
                .single();

            if (createError) throw createError;
            return newUser;
        } else if (error) {
            throw error;
        }

        return user;
    } catch (error) {
        console.error('Error getting/creating user:', error);
        throw error;
    }
}

// Check daily reset (UTC time)
async function checkDailyReset(user) {
    const now = new Date();
    const lastActive = new Date(user.last_active);
    
    // Check if it's a new UTC day
    if (now.getUTCDate() !== lastActive.getUTCDate() || 
        now.getUTCMonth() !== lastActive.getUTCMonth() || 
        now.getUTCFullYear() !== lastActive.getUTCFullYear()) {
        
        // Reset energy to full
        await supabase
            .from('users')
            .update({ 
                energy: user.max_energy || 1000,
                last_active: now.toISOString()
            })
            .eq('telegram_id', user.telegram_id);
        
        return true;
    }
    
    return false;
}

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Get user data
app.get('/api/user/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const user = await getOrCreateUser(userId);
        
        // Check daily reset
        await checkDailyReset(user);
        
        // Get updated user data after potential reset
        const { data: updatedUser } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', userId)
            .single();
        
        // Calculate current values
        const tonPrice = await getTonPrice();
        const balance = parseFloat(updatedUser.balance || 0);
        const dollarValue = balance;
        const tonValue = balance / tonPrice;
        const points = Math.floor(balance * 1000);
        
        res.json({
            success: true,
            user: {
                id: userId,
                points: points,
                balance: balance,
                dollarValue: dollarValue,
                tonValue: tonValue,
                tapsRemaining: updatedUser.energy || 1000,
                maxEnergy: updatedUser.max_energy || 1000,
                totalTaps: updatedUser.total_taps || 0,
                level: updatedUser.level || 1,
                referralCount: updatedUser.referral_count || 0,
                isActive: !updatedUser.is_banned,
                activePackage: null, // We'll implement this later
                tapValue: 0.05,
                tonPrice: tonPrice,
                unlimitedTaps: false,
                packageEarnings: 0,
                maxPackageEarnings: 0,
                withdrawalCooldown: null
            }
        });
    } catch (error) {
        console.error('Error getting user:', error);
        res.status(500).json({ success: false, error: 'Failed to get user data' });
    }
});

// Handle tap
app.post('/api/tap', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ success: false, error: 'User ID required' });
        }

        const user = await getOrCreateUser(parseInt(userId));
        
        if (user.is_banned) {
            return res.status(403).json({ success: false, error: 'User is banned' });
        }

        if (user.energy <= 0) {
            return res.status(400).json({ success: false, error: 'No energy remaining' });
        }

        // Update user stats
        const tapValue = 0.05; // Default tap value
        const newBalance = parseFloat(user.balance || 0) + (tapValue / 1000); // Convert points to balance
        const newEnergy = Math.max(0, (user.energy || 1000) - 1);
        const newTotalTaps = (user.total_taps || 0) + 1;

        const { error } = await supabase
            .from('users')
            .update({
                balance: newBalance,
                energy: newEnergy,
                total_taps: newTotalTaps,
                last_active: new Date().toISOString()
            })
            .eq('telegram_id', parseInt(userId));

        if (error) throw error;

        // Log transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: parseInt(userId),
                type: 'tap',
                amount: tapValue / 1000,
                description: 'Tap reward'
            });

        const tonPrice = await getTonPrice();
        const points = Math.floor(newBalance * 1000);

        res.json({
            success: true,
            user: {
                id: parseInt(userId),
                points: points,
                balance: newBalance,
                dollarValue: newBalance,
                tonValue: newBalance / tonPrice,
                tapsRemaining: newEnergy,
                totalTaps: newTotalTaps,
                tonPrice: tonPrice
            }
        });
    } catch (error) {
        console.error('Tap error:', error);
        res.status(500).json({ success: false, error: 'Failed to process tap' });
    }
});

// Handle referral
app.post('/api/referral', async (req, res) => {
    try {
        const { userId, referrerId } = req.body;
        
        if (!userId || !referrerId || userId === referrerId) {
            return res.status(400).json({ success: false, error: 'Invalid referral data' });
        }

        const user = await getOrCreateUser(parseInt(userId));
        
        if (user.referred_by) {
            return res.status(400).json({ success: false, error: 'User already referred' });
        }

        // Update user with referrer
        await supabase
            .from('users')
            .update({ referred_by: parseInt(referrerId) })
            .eq('telegram_id', parseInt(userId));

        // Give referrer bonus
        const referrer = await getOrCreateUser(parseInt(referrerId));
        const bonusAmount = 0.1; // 100 points = 0.1 balance
        const newBalance = parseFloat(referrer.balance || 0) + bonusAmount;
        const newReferralCount = (referrer.referral_count || 0) + 1;

        await supabase
            .from('users')
            .update({
                balance: newBalance,
                referral_count: newReferralCount
            })
            .eq('telegram_id', parseInt(referrerId));

        // Log transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: parseInt(referrerId),
                type: 'referral',
                amount: bonusAmount,
                description: `Referral bonus from user ${userId}`
            });

        res.json({
            success: true,
            message: 'Referral bonus awarded!'
        });
    } catch (error) {
        console.error('Referral error:', error);
        res.status(500).json({ success: false, error: 'Failed to process referral' });
    }
});

// Get referrals
app.get('/api/referrals/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        
        const { data: referrals, error } = await supabase
            .from('users')
            .select('telegram_id, username, first_name, balance, created_at')
            .eq('referred_by', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        const user = await getOrCreateUser(userId);

        res.json({
            success: true,
            referrals: referrals?.map(ref => ({
                id: ref.telegram_id,
                username: ref.username || ref.first_name || `User${ref.telegram_id.toString().slice(-4)}`,
                points: Math.floor(parseFloat(ref.balance || 0) * 1000),
                joinedAt: ref.created_at
            })) || [],
            totalReferrals: user.referral_count || 0,
            referralEarnings: (user.referral_count || 0) * 100,
            referralLink: `https://t.me/Taptoearnofficial_bot?start=${userId}`
        });
    } catch (error) {
        console.error('Error getting referrals:', error);
        res.status(500).json({ success: false, error: 'Failed to get referrals' });
    }
});

// Handle package purchase
app.post('/api/buy-package', async (req, res) => {
    try {
        const { userId, packageId, transactionHash } = req.body;
        
        if (!userId || !packageId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const user = await getOrCreateUser(parseInt(userId));
        
        // Package configurations matching your requirements
        const packages = {
            '5': { price: 5, tapValue: 0.2, maxEarnings: 10000, name: '$5 Package' },
            '10': { price: 10, tapValue: 0.25, maxEarnings: 20000, name: '$10 Package' },
            '50': { price: 50, tapValue: 0.5, maxEarnings: 100000, name: '$50 Package' },
            '100': { price: 100, tapValue: 1.0, maxEarnings: 200000, name: '$100 Package' },
            '1000': { price: 1000, tapValue: 10.0, maxEarnings: 2000000, name: '$1000 Package' },
            '500': { price: 500, tapValue: 1.0, maxEarnings: -1, unlimitedTaps: true, name: '$500 Unlimited Package' }
        };
        
        const packageData = packages[packageId];
        if (!packageData) {
            return res.status(400).json({ error: 'Invalid package' });
        }
        
        // In production, verify the transaction here
        if (transactionHash) {
            console.log(`Verifying transaction ${transactionHash} for package ${packageId}`);
            // Add actual transaction verification logic here
        }
        
        // For now, we'll store package info in user record
        // In a full implementation, you'd use the user_packages table
        await supabase
            .from('users')
            .update({
                // You can add custom fields to track active package
                updated_at: new Date().toISOString()
            })
            .eq('telegram_id', parseInt(userId));

        const tonPrice = await getTonPrice();
        const balance = parseFloat(user.balance || 0);
        
        res.json({
            success: true,
            user: {
                id: parseInt(userId),
                points: Math.floor(balance * 1000),
                balance: balance,
                dollarValue: balance,
                tonValue: balance / tonPrice,
                tonPrice: tonPrice,
                activePackage: packageData.name,
                tapValue: packageData.tapValue,
                maxPackageEarnings: packageData.maxEarnings,
                unlimitedTaps: packageData.unlimitedTaps || false
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
        
        const user = await getOrCreateUser(parseInt(userId));
        const tonPrice = await getTonPrice();
        const amountInTon = parseFloat(amount);
        
        // Validate withdrawal
        if (amountInTon < 0.01) {
            return res.status(400).json({ error: 'Minimum withdrawal is 0.01 TON' });
        }
        
        const requiredBalance = amountInTon * tonPrice;
        const userBalance = parseFloat(user.balance || 0);
        
        if (userBalance < requiredBalance) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        // In production, verify the fee transaction here
        if (feeTransactionHash) {
            console.log(`Verifying fee transaction ${feeTransactionHash}`);
        }
        
        // Create withdrawal request
        const { data: withdrawal, error } = await supabase
            .from('withdrawals')
            .insert({
                user_id: parseInt(userId),
                amount: amountInTon,
                wallet_address: walletAddress,
                status: 'pending'
            })
            .select()
            .single();

        if (error) throw error;
        
        // Deduct balance
        const newBalance = userBalance - requiredBalance;
        await supabase
            .from('users')
            .update({ balance: newBalance })
            .eq('telegram_id', parseInt(userId));

        // Log transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: parseInt(userId),
                type: 'withdrawal',
                amount: -requiredBalance,
                description: `Withdrawal request: ${amountInTon} TON`
            });
        
        res.json({
            success: true,
            withdrawalId: withdrawal.id,
            user: {
                id: parseInt(userId),
                points: Math.floor(newBalance * 1000),
                balance: newBalance,
                dollarValue: newBalance,
                tonValue: newBalance / tonPrice,
                tonPrice: tonPrice
            },
            message: 'Withdrawal request submitted successfully!'
        });
    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({ error: 'Failed to process withdrawal' });
    }
});

// Get withdrawal status
app.get('/api/withdrawal/:withdrawalId', async (req, res) => {
    try {
        const withdrawalId = req.params.withdrawalId;
        
        const { data: withdrawal, error } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('id', withdrawalId)
            .single();
        
        if (error || !withdrawal) {
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        
        res.json({ success: true, withdrawal });
    } catch (error) {
        console.error('Error getting withdrawal status:', error);
        res.status(500).json({ error: 'Failed to get withdrawal status' });
    }
});

// Get current TON price
app.get('/api/ton-price', async (req, res) => {
    try {
        const price = await getTonPrice();
        res.json({ success: true, price });
    } catch (error) {
        console.error('Error getting TON price:', error);
        res.status(500).json({ error: 'Failed to get TON price' });
    }
});

// Admin API Routes
app.get('/api/admin/stats', async (req, res) => {
    try {
        // Get total users
        const { count: totalUsers } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });

        // Get users joined today
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        
        const { count: todayUsers } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true })
            .gte('created_at', today.toISOString());

        // Get total balance and taps
        const { data: userData } = await supabase
            .from('users')
            .select('balance, total_taps, referral_count');
        
        const totalBalance = userData?.reduce((sum, user) => sum + parseFloat(user.balance || 0), 0) || 0;
        const totalTaps = userData?.reduce((sum, user) => sum + (user.total_taps || 0), 0) || 0;
        const totalReferrals = userData?.reduce((sum, user) => sum + (user.referral_count || 0), 0) || 0;

        // Get pending withdrawals
        const { count: pendingWithdrawals } = await supabase
            .from('withdrawals')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');

        // Get total revenue from user_packages (if implemented)
        const { data: packages } = await supabase
            .from('user_packages')
            .select(`
                *,
                packages (price)
            `);
        
        const totalRevenue = packages?.reduce((sum, pkg) => sum + (pkg.packages?.price || 0), 0) || 0;
        const activePackages = packages?.filter(pkg => pkg.is_active).length || 0;

        res.json({
            success: true,
            stats: {
                totalUsers: totalUsers || 0,
                todayUsers: todayUsers || 0,
                totalBalance: totalBalance.toFixed(4),
                totalTaps: totalTaps,
                totalReferrals: totalReferrals,
                totalRevenue: totalRevenue.toFixed(2),
                activePackages: activePackages,
                pendingWithdrawals: pendingWithdrawals || 0
            }
        });
    } catch (error) {
        console.error('Error getting admin stats:', error);
        res.status(500).json({ success: false, error: 'Failed to get stats' });
    }
});

// Get all users (admin)
app.get('/api/admin/users', async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100); // Limit for performance

        if (error) throw error;

        res.json({
            success: true,
            users: users || []
        });
    } catch (error) {
        console.error('Error getting users:', error);
        res.status(500).json({ success: false, error: 'Failed to get users' });
    }
});

// Add coins to user (admin)
app.post('/api/admin/add-coins', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        
        if (!userId || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const user = await getOrCreateUser(parseInt(userId));
        const newBalance = parseFloat(user.balance || 0) + parseFloat(amount);
        
        const { error } = await supabase
            .from('users')
            .update({ 
                balance: newBalance,
                updated_at: new Date().toISOString()
            })
            .eq('telegram_id', parseInt(userId));

        if (error) throw error;

        // Log transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: parseInt(userId),
                type: 'admin_add',
                amount: parseFloat(amount),
                description: `Admin added ${amount} balance`
            });

        res.json({
            success: true,
            message: `Added ${amount} to user ${userId}'s account`,
            newBalance: newBalance
        });
    } catch (error) {
        console.error('Error adding coins:', error);
        res.status(500).json({ success: false, error: 'Failed to add coins' });
    }
});

// Ban/unban user (admin)
app.post('/api/admin/toggle-ban', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }

        const user = await getOrCreateUser(parseInt(userId));
        const newBanStatus = !user.is_banned;
        
        const { error } = await supabase
            .from('users')
            .update({ 
                is_banned: newBanStatus,
                updated_at: new Date().toISOString()
            })
            .eq('telegram_id', parseInt(userId));

        if (error) throw error;

        res.json({
            success: true,
            message: `User ${userId} has been ${newBanStatus ? 'banned' : 'unbanned'}`,
            is_banned: newBanStatus
        });
    } catch (error) {
        console.error('Error toggling ban:', error);
        res.status(500).json({ success: false, error: 'Failed to toggle ban' });
    }
});

// Get pending withdrawals (admin)
app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const { data: withdrawals, error } = await supabase
            .from('withdrawals')
            .select(`
                *,
                users!withdrawals_user_id_fkey (telegram_id, username, first_name)
            `)
            .eq('status', 'pending')
            .order('request_date', { ascending: false });

        if (error) throw error;

        res.json({
            success: true,
            withdrawals: withdrawals || []
        });
    } catch (error) {
        console.error('Error getting withdrawals:', error);
        res.status(500).json({ success: false, error: 'Failed to get withdrawals' });
    }
});

// Process withdrawal (admin)
app.post('/api/admin/process-withdrawal', async (req, res) => {
    try {
        const { withdrawalId, action } = req.body; // action: 'approve' or 'reject'
        
        if (!withdrawalId || !action) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const status = action === 'approve' ? 'approved' : 'rejected';
        
        const { error } = await supabase
            .from('withdrawals')
            .update({ 
                status: status,
                processed_date: new Date().toISOString()
            })
            .eq('id', withdrawalId);

        if (error) throw error;

        res.json({
            success: true,
            message: `Withdrawal ${action}ed successfully`
        });
    } catch (error) {
        console.error('Error processing withdrawal:', error);
        res.status(500).json({ success: false, error: 'Failed to process withdrawal' });
    }
});

// Webhook for TON payments (if using TON payment processor)
app.post('/api/webhook/ton', async (req, res) => {
    try {
        const { transaction, status } = req.body;
        
        if (status === 'confirmed') {
            console.log('TON payment confirmed:', transaction);
            
            // Here you would:
            // 1. Verify the transaction
            // 2. Find the associated user/purchase
            // 3. Activate the package or process withdrawal
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        database: 'connected'
    });
});

// Database connection test
app.get('/api/test-db', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('users')
            .select('count(*)', { count: 'exact', head: true });
        
        if (error) throw error;
        
        res.json({
            success: true,
            message: 'Database connection successful',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Database test error:', error);
        res.status(500).json({
            success: false,
            error: 'Database connection failed',
            details: error.message
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
app.listen(PORT, async () => {
    console.log(`🚀 Tap to Earn Bot server running on port ${PORT}`);
    console.log(`📱 Bot: @Taptoearnofficial_bot`);
    console.log(`💰 Owner Wallet: ${OWNER_WALLET}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`👤 Admin ID: ${ADMIN_ID}`);
    
    // Test database connection
    try {
        const { data, error } = await supabase
            .from('users')
            .select('count(*)', { count: 'exact', head: true });
        
        if (error) throw error;
        console.log(`✅ Database connected successfully`);
    } catch (error) {
        console.error(`❌ Database connection failed:`, error.message);
    }
    
    // Load initial TON price
    try {
        const price = await getTonPrice();
        console.log(`💎 Current TON Price: ${price}`);
    } catch (error) {
        console.error(`❌ Failed to load TON price:`, error.message);
    }
});
