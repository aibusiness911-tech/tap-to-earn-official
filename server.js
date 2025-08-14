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
const SUPABASE_URL = 'https://arjkzpbhinpqensoqqod.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyamt6cGJoaW5wcWVuc29xcW9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwNjAwMTUsImV4cCI6MjA3MDYzNjAxNX0.zo5kS1J5Lv-FiRSJbt0hhaawUGB-6gNcZCgl74B7WBo';
const ADMIN_ID = 6733587823; // Your Telegram ID

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Serve main app
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve admin panel
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Get or create user
async function getOrCreateUser(telegramId, userData = {}) {
    try {
        // Try to get existing user
        let { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', telegramId)
            .single();

        if (error && error.code === 'PGRST116') {
            // User doesn't exist, create new one
            const { data: newUser, error: createError } = await supabase
                .from('users')
                .insert({
                    telegram_id: telegramId,
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

// API Routes

// Get user data
app.get('/api/user/:userId', async (req, res) => {
    try {
        const userId = parseInt(req.params.userId);
        const user = await getOrCreateUser(userId);
        
        res.json({
            success: true,
            user: {
                id: user.telegram_id,
                points: parseFloat(user.balance || 0) * 1000, // Convert balance to points
                tapsRemaining: user.energy || 1000,
                totalTaps: user.total_taps || 0,
                level: user.level || 1,
                referralCount: user.referral_count || 0,
                isActive: !user.is_banned
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
        const newBalance = parseFloat(user.balance || 0) + 0.00005; // 0.05 points = 0.00005 balance
        const newEnergy = Math.max(0, user.energy - 1);
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
                amount: 0.00005,
                description: 'Tap reward'
            });

        res.json({
            success: true,
            user: {
                id: parseInt(userId),
                points: newBalance * 1000,
                tapsRemaining: newEnergy,
                totalTaps: newTotalTaps
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
        const newBalance = parseFloat(referrer.balance || 0) + 0.1; // 100 points = 0.1 balance
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
                amount: 0.1,
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

        res.json({
            success: true,
            referrals: referrals || [],
            totalReferrals: referrals?.length || 0,
            referralLink: `https://t.me/Taptoearnofficial_bot?start=${userId}`
        });
    } catch (error) {
        console.error('Error getting referrals:', error);
        res.status(500).json({ success: false, error: 'Failed to get referrals' });
    }
});

// Submit withdrawal
app.post('/api/withdraw', async (req, res) => {
    try {
        const { userId, amount, walletAddress } = req.body;
        
        if (!userId || !amount || !walletAddress) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        const user = await getOrCreateUser(parseInt(userId));
        const requiredBalance = parseFloat(amount) / 1000; // Convert points to balance

        if (parseFloat(user.balance || 0) < requiredBalance) {
            return res.status(400).json({ success: false, error: 'Insufficient balance' });
        }

        // Create withdrawal request
        const { error } = await supabase
            .from('withdrawals')
            .insert({
                user_id: parseInt(userId),
                amount: parseFloat(amount),
                wallet_address: walletAddress,
                status: 'pending'
            });

        if (error) throw error;

        // Deduct balance
        await supabase
            .from('users')
            .update({
                balance: parseFloat(user.balance || 0) - requiredBalance
            })
            .eq('telegram_id', parseInt(userId));

        res.json({
            success: true,
            message: 'Withdrawal request submitted successfully!'
        });
    } catch (error) {
        console.error('Withdrawal error:', error);
        res.status(500).json({ success: false, error: 'Failed to process withdrawal' });
    }
});

// Admin API Routes
app.get('/api/admin/stats', async (req, res) => {
    try {
        // Get user count
        const { count: userCount } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });

        // Get total balance
        const { data: balanceData } = await supabase
            .from('users')
            .select('balance');
        
        const totalBalance = balanceData?.reduce((sum, user) => sum + parseFloat(user.balance || 0), 0) || 0;

        // Get pending withdrawals
        const { count: pendingWithdrawals } = await supabase
            .from('withdrawals')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');

        res.json({
            success: true,
            stats: {
                totalUsers: userCount || 0,
                totalBalance: totalBalance.toFixed(4),
                pendingWithdrawals: pendingWithdrawals || 0
            }
        });
    } catch (error) {
        console.error('Error getting admin stats:', error);
        res.status(500).json({ success: false, error: 'Failed to get stats' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Tap to Earn Bot server running on port ${PORT}`);
    console.log(`📱 Bot: @Taptoearnofficial_bot`);
    console.log(`🌐 Web App: https://tap-to-earn-bot-production.up.railway.app`);
});
