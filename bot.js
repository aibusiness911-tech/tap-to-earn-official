const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize bot
const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Mini App URL
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://tap-to-earn-bot-production.up.railway.app';
const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID);

// Create or get user in database
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
        // Check if referral is valid
        if (newUserId === referrerId) return false;
        
        // Check if user already has a referrer
        const { data: user } = await supabase
            .from('users')
            .select('referrer_id')
            .eq('telegram_id', newUserId)
            .single();
        
        if (user?.referrer_id) return false;
        
        // Update new user's referrer
        await supabase
            .from('users')
            .update({ referrer_id: referrerId })
            .eq('telegram_id', newUserId);
        
        // Update referrer's stats and balance
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
                    balance: (parseFloat(referrer.balance) || 0) + 100 // 100 points for referral
                })
                .eq('telegram_id', referrerId);
            
            // Log the transaction
            await supabase
                .from('transactions')
                .insert({
                    user_id: referrerId,
                    type: 'referral_bonus',
                    amount: 100,
                    description: `Referral bonus from user ${newUserId}`
                });
            
            return true;
        }
        
        return false;
    } catch (error) {
        console.error('Error handling referral:', error);
        return false;
    }
}

// Bot Commands

// /start command - with referral support
bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const referralCode = match[1]; // Get referral code if present
    
    try {
        // Create or get user
        const user = await getOrCreateUser(msg.from);
        
        // Handle referral if code is present
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
        await bot.sendMessage(chatId, '❌ An error occurred. Please try again later.');
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
/referrals - View your referral statistics
/packages - Browse available packages
/withdraw - Withdraw your earnings
/support - Contact support
${msg.from.id === ADMIN_ID ? '/admin - Open admin panel' : ''}

💡 *How to Earn:*
1. Open the Mini App and start tapping
2. Share your referral link with friends
3. Purchase packages to increase earnings
4. Withdraw your earnings in TON

📱 Tap the button below to start earning!`;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '🎮 Open Mini App', web_app: { url: `${MINI_APP_URL}?userId=${msg.from.id}` } }]
        ]
    };
    
    await bot.sendMessage(chatId, helpMessage, { 
        parse_mode: 'Markdown',
        reply_markup: keyboard 
    });
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
            await bot.sendMessage(chatId, '❌ User not found. Please use /start first.');
            return;
        }
        
        const balance = parseFloat(user.balance || 0);
        const dollarValue = balance / 1000;
        
        // Get current TON price
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
        await bot.sendMessage(chatId, '❌ Error fetching balance. Please try again later.');
    }
});

// /referrals command
bot.onText(/\/referrals/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        const { data: user } = await supabase
            .from('users')
            .select('referral_count')
            .eq('telegram_id', userId)
            .single();
        
        const { data: referrals } = await supabase
            .from('users')
            .select('username, first_name, created_at')
            .eq('referrer_id', userId)
            .order('created_at', { ascending: false })
            .limit(10);
        
        const referralLink = `https://t.me/Taptoearnofficial_bot?start=${userId}`;
        const totalEarnings = (user?.referral_count || 0) * 100;
        
        let referralsList = 'No referrals yet';
        if (referrals && referrals.length > 0) {
            referralsList = referrals.map((ref, i) => 
                `${i + 1}. ${ref.username || ref.first_name || 'User'} - ${new Date(ref.created_at).toLocaleDateString()}`
            ).join('\n');
        }
        
        const message = `
👥 *Your Referrals:*

Total Referrals: ${user?.referral_count || 0}
Total Earnings: ${totalEarnings} points

📎 *Your Referral Link:*
\`${referralLink}\`

📋 *Recent Referrals:*
${referralsList}

💡 Share your link to earn 100 points per referral!`;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: '📤 Share Link', switch_inline_query: `Join Tap to Earn Bot and start earning! ${referralLink}` }],
                [{ text: '🎮 Open Mini App', web_app: { url: `${MINI_APP_URL}?userId=${userId}` } }]
            ]
        };
        
        await bot.sendMessage(chatId, message, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard 
        });
    } catch (error) {
        console.error('Referrals command error:', error);
        await bot.sendMessage(chatId, '❌ Error fetching referrals. Please try again later.');
    }
});

// /packages command
bot.onText(/\/packages/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    try {
        const { data: packages } = await supabase
            .from('packages')
            .select('*')
            .eq('is_active', true)
            .order('price', { ascending: true });
        
        let packagesList = '*Available Packages:*\n\n';
        
        if (packages && packages.length > 0) {
            for (const pkg of packages) {
                packagesList += `💎 *${pkg.name}*\n`;
                packagesList += `Price: $${pkg.price}\n`;
                packagesList += `Max Profit: $${pkg.max_profit}\n`;
                packagesList += `Daily Tap Limit: ${pkg.daily_tap_limit}\n\n`;
            }
        } else {
            packagesList += 'No packages available at the moment.';
        }
        
        const keyboard = {
            inline_keyboard: [
                [{ text: '🛍️ Purchase Package', web_app: { url: `${MINI_APP_URL}?userId=${userId}&tab=packages` } }],
                [{ text: '🎮 Open Mini App', web_app: { url: `${MINI_APP_URL}?userId=${userId}` } }]
            ]
        };
        
        await bot.sendMessage(chatId, packagesList, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard 
        });
    } catch (error) {
        console.error('Packages command error:', error);
        await bot.sendMessage(chatId, '❌ Error fetching packages. Please try again later.');
    }
});

// /withdraw command
bot.onText(/\/withdraw/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    const message = `
💸 *Withdrawal Information:*

To withdraw your earnings:
1. Open the Mini App
2. Go to the withdrawal section
3. Enter your TON wallet address
4. Pay the 1 TON withdrawal fee
5. Your earnings will be sent to your wallet

⚠️ *Important:*
• Minimum withdrawal: 0.01 TON
• Withdrawal fee: 1 TON
• Processing time: 24 hours
• Cooldown period: 59 days

Click below to proceed with withdrawal:`;
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '💸 Withdraw Now', web_app: { url: `${MINI_APP_URL}?userId=${userId}&action=withdraw` } }],
            [{ text: '💰 Check Balance', callback_data: 'check_balance' }]
        ]
    };
    
    await bot.sendMessage(chatId, message, { 
        parse_mode: 'Markdown',
        reply_markup: keyboard 
    });
});

// /support command
bot.onText(/\/support/, async (msg) => {
    const chatId = msg.chat.id;
    
    const message = `
📞 *Support Information:*

If you need help or have questions:

1. Check our FAQ in the Mini App
2. Contact support through the bot
3. Email: support@taptoearn.com

Common Issues:
• Package not activated - Contact support with transaction ID
• Withdrawal pending - Allow 24 hours for processing
• Referral not counted - Ensure friend used your link

For urgent issues, please provide:
• Your Telegram ID: ${msg.from.id}
• Description of the issue
• Any transaction IDs`;
    
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// /admin command (only for admin)
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    
    if (userId !== ADMIN_ID) {
        await bot.sendMessage(chatId, '❌ You do not have permission to access this command.');
        return;
    }
    
    const keyboard = {
        inline_keyboard: [
            [{ text: '👨‍💼 Open Admin Panel', web_app: { url: `${MINI_APP_URL}/admin.html` } }],
            [{ text: '📊 View Stats', callback_data: 'admin_stats' }],
            [{ text: '💰 Pending Withdrawals', callback_data: 'admin_withdrawals' }]
        ]
    };
    
    await bot.sendMessage(chatId, '👨‍💼 *Admin Panel Access:*', { 
        parse_mode: 'Markdown',
        reply_markup: keyboard 
    });
});

// Callback query handlers
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    
    try {
        switch(data) {
            case 'check_balance':
                // Trigger balance command
                bot.emit('text', { 
                    chat: { id: chatId }, 
                    from: callbackQuery.from, 
                    text: '/balance' 
                });
                break;
                
            case 'check_referrals':
                // Trigger referrals command
                bot.emit('text', { 
                    chat: { id: chatId }, 
                    from: callbackQuery.from, 
                    text: '/referrals' 
                });
                break;
                
            case 'withdraw':
                // Trigger withdraw command
                bot.emit('text', { 
                    chat: { id: chatId }, 
                    from: callbackQuery.from, 
                    text: '/withdraw' 
                });
                break;
                
            case 'admin_stats':
                if (userId === ADMIN_ID) {
                    const { data: stats } = await supabase
                        .from('users')
                        .select('*');
                    
                    const totalUsers = stats?.length || 0;
                    const totalBalance = stats?.reduce((sum, user) => sum + parseFloat(user.balance || 0), 0) || 0;
                    const totalReferrals = stats?.reduce((sum, user) => sum + (user.referral_count || 0), 0) || 0;
                    
                    await bot.sendMessage(chatId, `
📊 *Admin Statistics:*

👥 Total Users: ${totalUsers}
💰 Total Balance: ${totalBalance.toFixed(2)} points
👥 Total Referrals: ${totalReferrals}
                    `, { parse_mode: 'Markdown' });
                }
                break;
                
            case 'admin_withdrawals':
                if (userId === ADMIN_ID) {
                    const { data: withdrawals } = await supabase
                        .from('withdrawals')
                        .select('*')
                        .eq('status', 'pending')
                        .limit(5);
                    
                    let message = '💸 *Pending Withdrawals:*\n\n';
                    
                    if (withdrawals && withdrawals.length > 0) {
                        withdrawals.forEach(w => {
                            message += `User: ${w.user_id}\n`;
                            message += `Amount: ${w.amount} TON\n`;
                            message += `Date: ${new Date(w.request_date).toLocaleDateString()}\n\n`;
                        });
                    } else {
                        message += 'No pending withdrawals';
                    }
                    
                    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                }
                break;
        }
        
        // Answer callback query to remove loading state
        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error('Callback query error:', error);
        await bot.answerCallbackQuery(callbackQuery.id, { text: 'Error occurred', show_alert: true });
    }
});

// Helper function to get TON price
async function getTonPrice() {
    try {
        const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd&x_cg_demo_api_key=${process.env.COINGECKO_API_KEY}`);
        const data = await response.json();
        return data['the-open-network']?.usd || 3.31;
    } catch (error) {
        console.error('Error fetching TON price:', error);
        return 3.31;
    }
}

console.log('🤖 Telegram Bot is running...');
console.log(`📱 Bot: @Taptoearnofficial_bot`);
console.log(`🔗 Mini App URL: ${MINI_APP_URL}`);
