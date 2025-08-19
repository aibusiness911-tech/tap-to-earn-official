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
app.use(express.static('public'));

// Environment variables
const BOT_TOKEN = process.env.BOT_TOKEN || '8105964064:AAE1rkye54RSBevmnYIIOBpCZnAkrMX-VsE';
const TON_API_KEY = process.env.TON_API_KEY || 'f0fae942c8bd9f735ce3cdf968aecdbc5bb2815d20966bf0a1b282b5ee9121d0';
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || 'CG-hNmKKyJRW1rZMhPASKoAYsEr';
const OWNER_WALLET = 'UQCUVSKh4SkJyEjhli0ntFVMkMYOLrm2_a5A6w4hWZwQCsOT';

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

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
async function getOrCreateUser(userId) {
    try {
        const { data: existingUser, error: fetchError } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', userId)
            .single();

        if (existingUser) {
            // Update last active
            await supabase
                .from('users')
                .update({ 
                    last_active: new Date().toISOString()
                })
                .eq('telegram_id', userId);
            
            return existingUser;
        }

        // Create new user
        const { data: newUser, error: createError } = await supabase
            .from('users')
            .insert({
                telegram_id: userId,
                balance: 0,
                total_taps: 0,
                energy: 1000,
                max_energy: 1000,
                level: 1,
                referral_count: 0,
                tap_value: 0.05,
                daily_tap_limit: 100,
                taps_used_today: 0,
                last_tap_reset: new Date().toISOString(),
                active_package: null,
                package_earnings: 0,
                max_package_earnings: 0,
                unlimited_taps: false
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

// Check daily reset (UTC time)
async function checkDailyReset(user) {
    const now = new Date();
    const lastReset = new Date(user.last_tap_reset);
    
    if (now.getUTCDate() !== lastReset.getUTCDate() || 
        now.getUTCMonth() !== lastReset.getUTCMonth() || 
        now.getUTCFullYear() !== lastReset.getUTCFullYear()) {
        
        // Reset daily taps
        const { error } = await supabase
            .from('users')
            .update({
                taps_used_today: 0,
                last_tap_reset: now.toISOString()
            })
            .eq('telegram_id', user.telegram_id);
        
        if (!error) {
            user.taps_used_today = 0;
            user.last_tap_reset = now.toISOString();
        }
    }
}

// Serve the main page
app.get('/', async (req, res) => {
    try {
        const html = await fs.readFile(path.join(__dirname, 'index.html'), 'utf8');
        res.send(html);
    } catch (error) {
        res.status(500).send('Server error loading page');
    }
});

// Get user data
app.get('/api/user/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const user = await getOrCreateUser(userId);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Check daily reset
        await checkDailyReset(user);
        
        // Calculate current values
        const tonPrice = await getTonPrice();
        const dollarValue = parseFloat(user.balance) / 1000;
        const tonValue = dollarValue / tonPrice;
        
        // Calculate taps remaining
        const tapsRemaining = user.unlimited_taps ? 999999 : (user.daily_tap_limit - user.taps_used_today);
        
        res.json({
            id: user.telegram_id,
            points: parseFloat(user.balance),
            tapsRemaining: Math.max(0, tapsRemaining),
            tapValue: parseFloat(user.tap_value),
            activePackage: user.active_package,
            packageEarnings: parseFloat(user.package_earnings || 0),
            maxPackageEarnings: parseFloat(user.max_package_earnings || 0),
            unlimitedTaps: user.unlimited_taps,
            totalReferrals: user.referral_count,
            referralEarnings: user.referral_count * 100, // 100 points per referral
            dollarValue,
            tonValue,
            tonPrice,
            level: user.level,
            energy: user.energy,
            maxEnergy: user.max_energy
        });
    } catch (error) {
        console.error('Error getting user:', error);
        res.status(500).json({ error: 'Failed to get user data' });
    }
});

// Handle tap
app.post('/api/tap', async (req, res) => {
    try {
        const { userId } = req.body;
        
        if (!userId) {
            return res.status(400).json({ error: 'User ID required' });
        }
        
        const user = await getOrCreateUser(parseInt(userId));
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        await checkDailyReset(user);
        
        // Check if user can tap
        const tapsRemaining = user.unlimited_taps ? 999999 : (user.daily_tap_limit - user.taps_used_today);
        if (tapsRemaining <= 0) {
            return res.status(400).json({ error: 'No taps remaining' });
        }
        
        // Check package limits
        if (user.max_package_earnings > 0 && user.package_earnings >= user.max_package_earnings) {
            return res.status(400).json({ error: 'Package earning limit reached' });
        }
        
        // Process tap
        const tapValue = parseFloat(user.tap_value);
        const newBalance = parseFloat(user.balance) + tapValue;
        const newPackageEarnings = parseFloat(user.package_earnings || 0) + tapValue;
        const newTotalTaps = user.total_taps + 1;
        const newTapsUsedToday = user.taps_used_today + 1;
        
        // Update user in database
        const { error } = await supabase
            .from('users')
            .update({
                balance: newBalance,
                package_earnings: newPackageEarnings,
                total_taps: newTotalTaps,
                taps_used_today: user.unlimited_taps ? user.taps_used_today : newTapsUsedToday,
                last_active: new Date().toISOString()
            })
            .eq('telegram_id', user.telegram_id);
        
        if (error) {
            throw error;
        }
        
        // Log transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: user.telegram_id,
                type: 'tap',
                amount: tapValue,
                description: 'Tap earning'
            });
        
        // Calculate current values
        const tonPrice = await getTonPrice();
        const dollarValue = newBalance / 1000;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            user: {
                id: user.telegram_id,
                points: newBalance,
                tapsRemaining: user.unlimited_taps ? 999999 : Math.max(0, user.daily_tap_limit - newTapsUsedToday),
                tapValue: tapValue,
                activePackage: user.active_package,
                packageEarnings: newPackageEarnings,
                maxPackageEarnings: parseFloat(user.max_package_earnings || 0),
                unlimitedTaps: user.unlimited_taps,
                totalReferrals: user.referral_count,
                referralEarnings: user.referral_count * 100,
                dollarValue,
                tonValue,
                tonPrice,
                level: user.level,
                energy: user.energy,
                maxEnergy: user.max_energy
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
        
        const user = await getOrCreateUser(parseInt(userId));
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Get package from database
        const { data: packageData, error: packageError } = await supabase
            .from('packages')
            .select('*')
            .eq('id', packageId)
            .eq('is_active', true)
            .single();
        
        if (packageError || !packageData) {
            return res.status(400).json({ error: 'Invalid package' });
        }
        
        // In production, verify the transaction here
        if (transactionHash) {
            console.log(`Verifying transaction ${transactionHash} for package ${packageId}`);
        }
        
        // Update user with package
        const { error } = await supabase
            .from('users')
            .update({
                active_package: packageData.name,
                tap_value: packageData.tap_multiplier * 0.05, // Base tap value * multiplier
                max_package_earnings: packageData.max_profit * 1000, // Convert to points
                package_earnings: 0,
                unlimited_taps: packageData.unlimited_taps || false,
                last_active: new Date().toISOString()
            })
            .eq('telegram_id', user.telegram_id);
        
        if (error) {
            throw error;
        }
        
        // Log package purchase
        await supabase
            .from('transactions')
            .insert({
                user_id: user.telegram_id,
                type: 'package_purchase',
                amount: -packageData.price * 1000, // Negative because it's a purchase
                description: `Purchased ${packageData.name} package`,
                metadata: { package_id: packageId, transaction_hash: transactionHash }
            });
        
        const tonPrice = await getTonPrice();
        const dollarValue = parseFloat(user.balance) / 1000;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            user: {
                id: user.telegram_id,
                points: parseFloat(user.balance),
                tapsRemaining: packageData.unlimited_taps ? 999999 : (user.daily_tap_limit - user.taps_used_today),
                tapValue: packageData.tap_multiplier * 0.05,
                activePackage: packageData.name,
                packageEarnings: 0,
                maxPackageEarnings: packageData.max_profit * 1000,
                unlimitedTaps: packageData.unlimited_taps || false,
                totalReferrals: user.referral_count,
                referralEarnings: user.referral_count * 100,
                dollarValue,
                tonValue,
                tonPrice,
                level: user.level,
                energy: user.energy,
                maxEnergy: user.max_energy
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
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const tonPrice = await getTonPrice();
        
        // Validate withdrawal
        if (amount < 0.01) {
            return res.status(400).json({ error: 'Minimum withdrawal is 0.01 TON' });
        }
        
        const requiredPoints = amount * tonPrice * 1000;
        if (parseFloat(user.balance) < requiredPoints) {
            return res.status(400).json({ error: 'Insufficient balance' });
        }
        
        // Check if user has any pending withdrawals
        const { data: pendingWithdrawals } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('user_id', user.telegram_id)
            .eq('status', 'pending');
        
        if (pendingWithdrawals && pendingWithdrawals.length > 0) {
            return res.status(400).json({ error: 'You have a pending withdrawal request' });
        }
        
        // In production, verify the fee transaction here
        if (feeTransactionHash) {
            console.log(`Verifying fee transaction ${feeTransactionHash}`);
        }
        
        // Create withdrawal request
        const { data: withdrawal, error: withdrawalError } = await supabase
            .from('withdrawals')
            .insert({
                user_id: user.telegram_id,
                amount: amount,
                wallet_address: walletAddress,
                status: 'pending',
                fee_transaction_hash: feeTransactionHash,
                request_date: new Date().toISOString()
            })
            .select()
            .single();
        
        if (withdrawalError) {
            throw withdrawalError;
        }
        
        // Deduct points from user
        const newBalance = parseFloat(user.balance) - requiredPoints;
        
        const { error: updateError } = await supabase
            .from('users')
            .update({
                balance: newBalance,
                last_active: new Date().toISOString()
            })
            .eq('telegram_id', user.telegram_id);
        
        if (updateError) {
            throw updateError;
        }
        
        // Log transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: user.telegram_id,
                type: 'withdrawal',
                amount: -requiredPoints,
                description: `Withdrawal of ${amount} TON to ${walletAddress}`,
                metadata: { 
                    withdrawal_id: withdrawal.id,
                    wallet_address: walletAddress,
                    ton_amount: amount
                }
            });
        
        const dollarValue = newBalance / 1000;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            withdrawalId: withdrawal.id,
            user: {
                id: user.telegram_id,
                points: newBalance,
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
        
        res.json(withdrawal);
    } catch (error) {
        console.error('Error getting withdrawal status:', error);
        res.status(500).json({ error: 'Failed to get withdrawal status' });
    }
});

// Handle referral
app.post('/api/referral', async (req, res) => {
    try {
        const { userId, referrerId } = req.body;
        
        if (!userId || !referrerId || userId === referrerId) {
            return res.status(400).json({ error: 'Invalid referral data' });
        }
        
        const user = await getOrCreateUser(parseInt(userId));
        const referrer = await getOrCreateUser(parseInt(referrerId));
        
        if (!user || !referrer) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Check if user is already referred
        if (user.referrer_id) {
            return res.status(400).json({ error: 'User already referred' });
        }
        
        // Update user with referrer
        const { error: userError } = await supabase
            .from('users')
            .update({ referrer_id: referrer.telegram_id })
            .eq('telegram_id', user.telegram_id);
        
        if (userError) {
            throw userError;
        }
        
        // Award referral bonus to referrer
        const bonusAmount = 100;
        const newReferrerBalance = parseFloat(referrer.balance) + bonusAmount;
        const newReferralCount = referrer.referral_count + 1;
        
        const { error: referrerError } = await supabase
            .from('users')
            .update({
                balance: newReferrerBalance,
                referral_count: newReferralCount,
                last_active: new Date().toISOString()
            })
            .eq('telegram_id', referrer.telegram_id);
        
        if (referrerError) {
            throw referrerError;
        }
        
        // Log referral transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: referrer.telegram_id,
                type: 'referral_bonus',
                amount: bonusAmount,
                description: `Referral bonus from user ${userId}`
            });
        
        const tonPrice = await getTonPrice();
        const dollarValue = newReferrerBalance / 1000;
        const tonValue = dollarValue / tonPrice;
        
        res.json({
            success: true,
            referrer: {
                id: referrer.telegram_id,
                points: newReferrerBalance,
                totalReferrals: newReferralCount,
                referralEarnings: newReferralCount * 100,
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
app.get('/api/referrals/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        
        const { data: user } = await supabase
            .from('users')
            .select('referral_count')
            .eq('telegram_id', userId)
            .single();
        
        const { data: referrals } = await supabase
            .from('users')
            .select('telegram_id, username, first_name, created_at, balance')
            .eq('referrer_id', userId)
            .order('created_at', { ascending: false })
            .limit(50);
        
        const referralsList = referrals ? referrals.map(ref => ({
            id: ref.telegram_id,
            username: ref.username || ref.first_name || `User${ref.telegram_id.toString().slice(-4)}`,
            points: parseFloat(ref.balance || 0),
            joinedAt: ref.created_at
        })) : [];
        
        res.json({
            totalReferrals: user?.referral_count || 0,
            referralEarnings: (user?.referral_count || 0) * 100,
            referrals: referralsList,
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

// Get available packages
app.get('/api/packages', async (req, res) => {
    try {
        const { data: packages, error } = await supabase
            .from('packages')
            .select('*')
            .eq('is_active', true)
            .order('price', { ascending: true });
        
        if (error) {
            throw error;
        }
        
        res.json(packages || []);
    } catch (error) {
        console.error('Error getting packages:', error);
        res.status(500).json({ error: 'Failed to get packages' });
    }
});

// Admin endpoints
app.get('/api/admin/stats', async (req, res) => {
    try {
        // Get total users
        const { count: totalUsers } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });
        
        // Get total balance
        const { data: balanceData } = await supabase
            .from('users')
            .select('balance');
        
        const totalBalance = balanceData ? 
            balanceData.reduce((sum, user) => sum + parseFloat(user.balance || 0), 0) : 0;
        
        // Get total referrals
        const { data: referralData } = await supabase
            .from('users')
            .select('referral_count');
        
        const totalReferrals = referralData ? 
            referralData.reduce((sum, user) => sum + (user.referral_count || 0), 0) : 0;
        
        // Get pending withdrawals
        const { count: pendingWithdrawals } = await supabase
            .from('withdrawals')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');
        
        // Get active packages
        const { count: activePackages } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true })
            .not('active_package', 'is', null);
        
        const stats = {
            totalUsers: totalUsers || 0,
            totalBalance: totalBalance,
            totalReferrals: totalReferrals,
            pendingWithdrawals: pendingWithdrawals || 0,
            activePackages: activePackages || 0
        };
        
        res.json(stats);
    } catch (error) {
        console.error('Error getting admin stats:', error);
        res.status(500).json({ error: 'Failed to get stats' });
    }
});

// Manual package activation (for admin use)
app.post('/api/admin/activate-package', async (req, res) => {
    try {
        const { userId, packageId } = req.body;
        
        const { data: packageData, error: packageError } = await supabase
            .from('packages')
            .select('*')
            .eq('id', packageId)
            .single();
        
        if (packageError || !packageData) {
            return res.status(400).json({ error: 'Invalid package' });
        }
        
        const { error } = await supabase
            .from('users')
            .update({
                active_package: packageData.name,
                tap_value: packageData.tap_multiplier * 0.05,
                max_package_earnings: packageData.max_profit * 1000,
                package_earnings: 0,
                unlimited_taps: packageData.unlimited_taps || false
            })
            .eq('telegram_id', parseInt(userId));
        
        if (error) {
            throw error;
        }
        
        res.json({
            success: true,
            message: `Package ${packageData.name} activated for user ${userId}`
        });
    } catch (error) {
        console.error('Error activating package:', error);
        res.status(500).json({ error: 'Failed to activate package' });
    }
});

// Manual withdrawal processing (for admin use)
app.post('/api/admin/process-withdrawal', async (req, res) => {
    try {
        const { withdrawalId, approve } = req.body;
        
        const { data: withdrawal, error: fetchError } = await supabase
            .from('withdrawals')
            .select('*')
            .eq('id', withdrawalId)
            .single();
        
        if (fetchError || !withdrawal) {
            return res.status(404).json({ error: 'Withdrawal not found' });
        }
        
        if (withdrawal.status !== 'pending') {
            return res.status(400).json({ error: 'Withdrawal already processed' });
        }
        
        let result = { success: false, error: 'Processing failed' };
        let newStatus = 'failed';
        
        if (approve) {
            // Process the withdrawal
            result = await sendTon(withdrawal.wallet_address, withdrawal.amount, `Withdrawal-${withdrawalId}`);
            newStatus = result.success ? 'completed' : 'failed';
        } else {
            // Reject the withdrawal - refund the user
            const tonPrice = await getTonPrice();
            const requiredPoints = withdrawal.amount * tonPrice * 1000;
            
            const { data: user } = await supabase
                .from('users')
                .select('balance')
                .eq('telegram_id', withdrawal.user_id)
                .single();
            
            if (user) {
                await supabase
                    .from('users')
                    .update({
                        balance: parseFloat(user.balance) + requiredPoints
                    })
                    .eq('telegram_id', withdrawal.user_id);
                
                // Log refund transaction
                await supabase
                    .from('transactions')
                    .insert({
                        user_id: withdrawal.user_id,
                        type: 'withdrawal_refund',
                        amount: requiredPoints,
                        description: `Refund for rejected withdrawal ${withdrawalId}`
                    });
            }
            
            newStatus = 'rejected';
            result = { success: true, message: 'Withdrawal rejected and refunded' };
        }
        
        // Update withdrawal status
        const updateData = {
            status: newStatus,
            processed_date: new Date().toISOString()
        };
        
        if (result.txHash) {
            updateData.transaction_hash = result.txHash;
        }
        
        if (result.error) {
            updateData.error_message = result.error;
        }
        
        const { error: updateError } = await supabase
            .from('withdrawals')
            .update(updateData)
            .eq('id', withdrawalId);
        
        if (updateError) {
            throw updateError;
        }
        
        res.json({
            success: true,
            withdrawal: {
                ...withdrawal,
                ...updateData
            },
            message: result.success ? 
                (approve ? 'Withdrawal processed successfully' : 'Withdrawal rejected and refunded') :
                'Withdrawal processing failed'
        });
    } catch (error) {
        console.error('Error processing withdrawal:', error);
        res.status(500).json({ error: 'Failed to process withdrawal' });
    }
});

// Get all withdrawals (admin)
app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const { data: withdrawals, error } = await supabase
            .from('withdrawals')
            .select(`
                *,
                users!withdrawals_user_id_fkey (
                    telegram_id,
                    username,
                    first_name
                )
            `)
            .order('request_date', { ascending: false })
            .limit(50);
        
        if (error) {
            throw error;
        }
        
        res.json(withdrawals || []);
    } catch (error) {
        console.error('Error getting withdrawals:', error);
        res.status(500).json({ error: 'Failed to get withdrawals' });
    }
});

// Get all users (admin)
app.get('/api/admin/users', async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);
        
        if (error) {
            throw error;
        }
        
        res.json(users || []);
    } catch (error) {
        console.error('Error getting users:', error);
        res.status(500).json({ error: 'Failed to get users' });
    }
});

// Add points to user (admin)
app.post('/api/admin/add-points', async (req, res) => {
    try {
        const { userId, amount, description } = req.body;
        
        if (!userId || !amount) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const { data: user, error: fetchError } = await supabase
            .from('users')
            .select('balance')
            .eq('telegram_id', parseInt(userId))
            .single();
        
        if (fetchError || !user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        const newBalance = parseFloat(user.balance) + parseFloat(amount);
        
        const { error: updateError } = await supabase
            .from('users')
            .update({ balance: newBalance })
            .eq('telegram_id', parseInt(userId));
        
        if (updateError) {
            throw updateError;
        }
        
        // Log transaction
        await supabase
            .from('transactions')
            .insert({
                user_id: parseInt(userId),
                type: 'admin_adjustment',
                amount: parseFloat(amount),
                description: description || `Admin added ${amount} points`
            });
        
        res.json({
            success: true,
            message: `Added ${amount} points to user ${userId}`,
            newBalance: newBalance
        });
    } catch (error) {
        console.error('Error adding points:', error);
        res.status(500).json({ error: 'Failed to add points' });
    }
});

// Get user transactions
app.get('/api/transactions/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const limit = parseInt(req.query.limit) || 50;
        
        const { data: transactions, error } = await supabase
            .from('transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(limit);
        
        if (error) {
            throw error;
        }
        
        res.json(transactions || []);
    } catch (error) {
        console.error('Error getting transactions:', error);
        res.status(500).json({ error: 'Failed to get transactions' });
    }
});

// Webhook for TON payments (if using TON payment processor)
app.post('/api/webhook/ton', async (req, res) => {
    try {
        const { transaction, status, user_id, package_id } = req.body;
        
        if (status === 'confirmed') {
            console.log('TON payment confirmed:', transaction);
            
            // If it's a package purchase
            if (user_id && package_id) {
                const { data: packageData } = await supabase
                    .from('packages')
                    .select('*')
                    .eq('id', package_id)
                    .single();
                
                if (packageData) {
                    // Activate package for user
                    await supabase
                        .from('users')
                        .update({
                            active_package: packageData.name,
                            tap_value: packageData.tap_multiplier * 0.05,
                            max_package_earnings: packageData.max_profit * 1000,
                            package_earnings: 0,
                            unlimited_taps: packageData.unlimited_taps || false
                        })
                        .eq('telegram_id', parseInt(user_id));
                    
                    // Log transaction
                    await supabase
                        .from('transactions')
                        .insert({
                            user_id: parseInt(user_id),
                            type: 'package_purchase',
                            amount: -packageData.price * 1000,
                            description: `Purchased ${packageData.name} package`,
                            metadata: { 
                                package_id: package_id, 
                                transaction_hash: transaction.hash,
                                confirmed: true
                            }
                        });
                }
            }
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
        database: 'supabase'
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

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Tap to Earn Bot server running on port ${PORT}`);
    console.log(`📱 Bot: @Taptoearnofficial_bot`);
    console.log(`💰 Owner Wallet: ${OWNER_WALLET}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🗄️  Database: Supabase Connected`);
    console.log(`📊 Supabase URL: ${process.env.SUPABASE_URL}`);
    
    // Load initial TON price
    getTonPrice().then(price => {
        console.log(`💎 Current TON Price: ${price}`);
    }).catch(err => {
        console.error('Failed to load TON price:', err);
    });
});
