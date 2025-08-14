const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');

// Bot configuration
const BOT_TOKEN = '8105964064:AAE1rkye54RSBevmnYIIOBpCZnAkrMX-VsE';
const WEB_APP_URL = 'https://tap-to-earn-bot-production.up.railway.app';
const ADMIN_ID = 6733587823;

// Initialize Supabase
const SUPABASE_URL = 'https://arjkzpbhinpqensoqqod.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyamt6cGJoaW5wcWVuc29xcW9kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUwNjAwMTUsImV4cCI6MjA3MDYzNjAxNX0.zo5kS1J5Lv-FiRSJbt0hhaawUGB-6gNcZCgl74B7WBo';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Create bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Get or create user
async function getOrCreateUser(msg) {
    try {
        const telegramId = msg.from.id;
        
        let { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', telegramId)
            .single();

        if (error && error.code === 'PGRST116') {
            // Create new user
            const { data: newUser, error: createError } = await supabase
                .from('users')
                .insert({
                    telegram_id: telegramId,
                    username: msg.from.username || null,
                    first_name: msg.from.first_name || null,
                    last_name: msg.from.last_name || null,
                })
                .select()
                .single();

            if (createError) throw createError;
            return newUser;
        } else if (error) {
            throw error;
        }

        // Update user info
        await supabase
            .from('users')
            .update({
                username: msg.from.username || null,
                first_name: msg.from.first_name || null,
                last_name: msg.from.last_name || null,
                last_active: new Date().toISOString()
            })
            .eq('telegram_id', telegramId);

        return user;
    } catch (error) {
        console.error('Error with user:', error);
        return null;
    }
}

// Handle /start command
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const referrerId = match[1] ? match[1].trim() : null;
    
    try {
        const user = await getOrCreateUser(msg);
        
        // Handle referral
        if (referrerId && referrerId !== msg.from.id.toString() && user && !user.referred_by) {
            const referrerIdNum = parseInt(referrerId);
            if (!isNaN(referrerIdNum)) {
                // Update user with referrer
                await supabase
                    .from('users')
                    .update({ referred_by: referrerIdNum })
                    .eq('telegram_id', msg.from.id);

                // Give referrer bonus
                const { data: referrer } = await supabase
                    .from('users')
                    .select('balance, referral_count')
                    .eq('telegram_id', referrerIdNum)
                    .single();

                if (referrer) {
                    await supabase
                        .from('users')
                        .update({
                            balance: (parseFloat(referrer.balance || 0) + 0.1),
                            referral_count: (referrer.referral_count || 0) + 1
                        })
                        .eq('telegram_id', referrerIdNum);

                    // Log transaction
                    await supabase
                        .from('transactions')
                        .insert({
                            user_id: referrerIdNum,
                            type: 'referral',
                            amount: 0.1,
                            description: `Referral bonus from ${msg.from.first_name || msg.from.id}`
                        });

                    // Notify referrer
                    try {
                        await bot.sendMessage(referrerIdNum, 
                            `🎉 New referral! ${msg.from.first_name || 'Someone'} joined using your link!\n💰 You earned 100 points bonus!`
                        );
                    } catch (e) {
                        // Referrer might have blocked bot
                        console.log('Could not notify referrer:', e.message);
                    }
                }
            }
        }

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: '🚀 Start Earning',
                        web_app: { url: WEB_APP_URL }
                    }],
                    [
                        { text: '💰 Balance', callback_data: 'balance' },
                        { text: '👥 Referrals', callback_data: 'referrals' }
                    ],
                    [
                        { text: '📦 Packages', callback_data: 'packages' },
                        { text: '💳 Withdraw', callback_data: 'withdraw' }
                    ]
                ]
            }
        };

        const welcomeMessage = `🎯 Welcome to Tap to Earn Bot!

💎 Start tapping and earning real TON cryptocurrency!

🎮 How it works:
• Tap to earn points (1000 points = $1)
• Refer friends for 100 point bonus
• Upgrade packages for higher earnings
• Withdraw directly to TON wallet

🚀 Click "Start Earning" to begin!`;

        await bot.sendMessage(chatId, welcomeMessage, keyboard);
        
    } catch (error) {
        console.error('Start command error:', error);
        await bot.sendMessage(chatId, '❌ Something went wrong. Please try again later.');
    }
});

// Handle /balance command
bot.onText(/\/balance/, async (msg) => {
    try {
        const user = await getOrCreateUser(msg);
        if (!user) throw new Error('User not found');

        const balance = parseFloat(user.balance || 0);
        const points = Math.floor(balance * 1000);
        const dollarValue = balance.toFixed(4);
        const tonValue = (balance / 3.31).toFixed(6); // Assuming TON = $3.31

        const balanceMessage = `💰 Your Balance:

📊 Points: ${points.toLocaleString()}
💵 Dollar Value: $${dollarValue}
🪙 TON Value: ${tonValue} TON

⚡ Energy: ${user.energy || 1000}/1000
🎯 Total Taps: ${(user.total_taps || 0).toLocaleString()}
👥 Referrals: ${user.referral_count || 0}
🏆 Level: ${user.level || 1}

🚀 Keep tapping to earn more!`;

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: '🎮 Start Tapping',
                        web_app: { url: WEB_APP_URL }
                    }],
                    [
                        { text: '👥 Invite Friends', callback_data: 'referrals' },
                        { text: '📦 Upgrade', callback_data: 'packages' }
                    ]
                ]
            }
        };

        await bot.sendMessage(msg.chat.id, balanceMessage, keyboard);
    } catch (error) {
        console.error('Balance command error:', error);
        await bot.sendMessage(msg.chat.id, '❌ Failed to get balance. Please try again.');
    }
});

// Handle /admin command
bot.onText(/\/admin/, async (msg) => {
    if (msg.from.id !== ADMIN_ID) {
        await bot.sendMessage(msg.chat.id, '❌ Access denied. Admin only command.');
        return;
    }

    try {
        // Get quick stats
        const { count: userCount } = await supabase
            .from('users')
            .select('*', { count: 'exact', head: true });

        const { count: pendingWithdrawals } = await supabase
            .from('withdrawals')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'pending');

        const { data: totalBalance } = await supabase
            .from('users')
            .select('balance');
        
        const totalBalanceSum = totalBalance?.reduce((sum, user) => sum + parseFloat(user.balance || 0), 0) || 0;

        const adminMessage = `🔧 Admin Dashboard

👥 Total Users: ${userCount || 0}
💰 Total Balance: $${totalBalanceSum.toFixed(2)}
⏳ Pending Withdrawals: ${pendingWithdrawals || 0}

🚀 Click below to access full admin panel:`;

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: '🔧 Open Admin Panel',
                        web_app: { url: `${WEB_APP_URL}/admin` }
                    }],
                    [
                        { text: '📊 Quick Stats', callback_data: 'admin_stats' },
                        { text: '💳 Withdrawals', callback_data: 'admin_withdrawals' }
                    ]
                ]
            }
        };

        await bot.sendMessage(msg.chat.id, adminMessage, keyboard);
    } catch (error) {
        console.error('Admin command error:', error);
        await bot.sendMessage(msg.chat.id, '❌ Failed to load admin data.');
    }
});

// Handle /support command
bot.onText(/\/support/, async (msg) => {
    const supportMessage = `🆘 Need Help?

📞 Contact our support team:
• Telegram: @your_support_username
• Email: support@yourdomain.com

⏰ Support Hours: 24/7

🔧 Common Issues:
• Balance not updating? → Refresh the app
• Taps not working? → Check your energy level
• Withdrawal issues? → Contact support directly

💡 Quick Tips:
• Energy refills automatically every hour
• Refer friends for instant 100 point bonus
• Upgrade packages for higher tap rewards
• Minimum withdrawal: 0.01 TON

🎮 Having trouble? Try restarting the app first!`;

    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{
                    text: '🚀 Open App',
                    web_app: { url: WEB_APP_URL }
                }],
                [
                    { text: '💰 Check Balance', callback_data: 'balance' },
                    { text: '📖 How to Play', callback_data: 'help' }
                ]
            ]
        }
    };

    await bot.sendMessage(msg.chat.id, supportMessage, keyboard);
});

// Handle /withdraw command
bot.onText(/\/withdraw/, async (msg) => {
    try {
        const user = await getOrCreateUser(msg);
        if (!user) throw new Error('User not found');

        const balance = parseFloat(user.balance || 0);
        const minWithdrawal = 0.01;
        const tonPrice = 3.31; // You can make this dynamic
        const minBalanceRequired = minWithdrawal * tonPrice;

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: '💳 Start Withdrawal',
                        web_app: { url: WEB_APP_URL }
                    }],
                    [
                        { text: '💰 Check Balance', callback_data: 'balance' }
                    ]
                ]
            }
        };

        let withdrawMessage;
        if (balance < minBalanceRequired) {
            withdrawMessage = `💳 Withdrawal Information

❌ Insufficient Balance
Your balance: $${balance.toFixed(4)}
Required: $${minBalanceRequired.toFixed(4)}

💡 Keep tapping to earn more!

📋 Withdrawal Requirements:
• Minimum: 0.01 TON (~$${minBalanceRequired.toFixed(2)})
• Processing Time: 24-48 hours
• Fee: 1 TON (auto-deducted)
• Payment: Sent to your TON wallet`;
        } else {
            const availableTon = (balance / tonPrice).toFixed(6);
            withdrawMessage = `💳 Withdrawal Available!

✅ Your Balance: $${balance.toFixed(4)}
🪙 Available TON: ${availableTon}

⚠️ Important Notes:
• Minimum withdrawal: 0.01 TON
• Processing fee: 1 TON
• Processing time: 24-48 hours
• Make sure your TON wallet address is correct!

🚀 Click below to start withdrawal:`;
        }

        await bot.sendMessage(msg.chat.id, withdrawMessage, keyboard);
    } catch (error) {
        console.error('Withdraw command error:', error);
        await bot.sendMessage(msg.chat.id, '❌ Failed to get withdrawal info. Please try again.');
    }
});

// Handle /referral command
bot.onText(/\/referral/, async (msg) => {
    try {
        const user = await getOrCreateUser(msg);
        if (!user) throw new Error('User not found');

        const referralLink = `https://t.me/Taptoearnofficial_bot?start=${msg.from.id}`;
        const referralEarnings = (user.referral_count || 0) * 100;
        
        const referralMessage = `👥 Invite Friends & Earn!

🔗 Your Referral Link:
${referralLink}

💰 Earn 100 points for each friend!

📊 Your Referral Stats:
• Total Referrals: ${user.referral_count || 0}
• Referral Earnings: ${referralEarnings.toLocaleString()} points
• Dollar Value: $${(referralEarnings / 1000).toFixed(2)}

🎯 How it Works:
1. Share your link with friends
2. They join and start playing
3. You get 100 points instantly
4. No limit on referrals!

🚀 Start sharing and earning now!`;

        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: '📤 Share Link',
                        switch_inline_query: `Join me on Tap to Earn Bot! 🚀\n\nEarn real TON cryptocurrency by tapping! 💰\n\nStart here: ${referralLink}`
                    }],
                    [{
                        text: '🎮 Start Tapping',
                        web_app: { url: WEB_APP_URL }
                    }]
                ]
            }
        };

        await bot.sendMessage(msg.chat.id, referralMessage, keyboard);
    } catch (error) {
        console.error('Referral command error:', error);
        await bot.sendMessage(msg.chat.id, '❌ Failed to get referral info. Please try again.');
    }
});

// Handle /packages command
bot.onText(/\/packages/, async (msg) => {
    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{
                    text: '📦 View All Packages',
                    web_app: { url: WEB_APP_URL }
                }],
                [
                    { text: '💰 Check Balance', callback_data: 'balance' }
                ]
            ]
        }
    };

    const packagesMessage = `📦 Upgrade Packages Available:

💎 Starter ($5) → 0.2 points/tap → Max $10 return
💎 Bronze ($10) → 0.25 points/tap → Max $20 return  
💎 Silver ($50) → 0.5 points/tap → Max $100 return
💎 Gold ($100) → 1 point/tap → Max $200 return
💎 Diamond ($1000) → 10 points/tap → Max $2000 return

🚀 SPECIAL: Unlimited Package ($500)
• 1 point per tap + UNLIMITED daily taps!
• Lifetime earnings with no limits!

🔥 All packages guarantee 2x return!
💳 Pay with TON cryptocurrency
⚡ Instant activation after payment

🚀 Click below to purchase:`;

    await bot.sendMessage(msg.chat.id, packagesMessage, keyboard);
});

// Handle callback queries
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;
    
    try {
        await bot.answerCallbackQuery(callbackQuery.id);
        
        switch (data) {
            case 'balance':
                // Create a mock message object for balance command
                const balanceMsg = {
                    ...msg,
                    from: callbackQuery.from,
                    chat: msg.chat
                };
                
                // Call balance handler
                const user = await getOrCreateUser({ from: callbackQuery.from });
                if (!user) throw new Error('User not found');

                const balance = parseFloat(user.balance || 0);
                const points = Math.floor(balance * 1000);
                const dollarValue = balance.toFixed(4);
                const tonValue = (balance / 3.31).toFixed(6);

                const balanceMessage = `💰 Your Balance:

📊 Points: ${points.toLocaleString()}
💵 Dollar Value: $${dollarValue}
🪙 TON Value: ${tonValue} TON

⚡ Energy: ${user.energy || 1000}/1000
🎯 Total Taps: ${(user.total_taps || 0).toLocaleString()}
👥 Referrals: ${user.referral_count || 0}

🚀 Keep tapping to earn more!`;

                const balanceKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{
                                text: '🎮 Start Tapping',
                                web_app: { url: WEB_APP_URL }
                            }]
                        ]
                    }
                };

                await bot.editMessageText(balanceMessage, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    ...balanceKeyboard
                });
                break;
            
            case 'referrals':
                const referralUser = await getOrCreateUser({ from: callbackQuery.from });
                const referralLink = `https://t.me/Taptoearnofficial_bot?start=${userId}`;
                const referralEarnings = (referralUser.referral_count || 0) * 100;
                
                const referralMessage = `👥 Your Referral Stats:

🔗 Link: ${referralLink}

📊 Stats:
• Referrals: ${referralUser.referral_count || 0}
• Earnings: ${referralEarnings.toLocaleString()} points
• Value: ${(referralEarnings / 1000).toFixed(2)}

🚀 Share your link to earn more!`;

                const referralKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{
                                text: '📤 Share Link',
                                switch_inline_query: `Join Tap to Earn Bot! 🚀 ${referralLink}`
                            }]
                        ]
                    }
                };

                await bot.editMessageText(referralMessage, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    ...referralKeyboard
                });
                break;
                
            case 'packages':
                const packagesMessage = `📦 Available Packages:

💎 $5 → 0.2 points/tap (Max $10)
💎 $10 → 0.25 points/tap (Max $20)
💎 $50 → 0.5 points/tap (Max $100)
💎 $100 → 1 point/tap (Max $200)
💎 $1000 → 10 points/tap (Max $2000)
🚀 $500 → Unlimited package!

Click below to purchase:`;

                const packagesKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{
                                text: '📦 View Packages',
                                web_app: { url: WEB_APP_URL }
                            }]
                        ]
                    }
                };

                await bot.editMessageText(packagesMessage, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    ...packagesKeyboard
                });
                break;
                
            case 'withdraw':
                const withdrawUser = await getOrCreateUser({ from: callbackQuery.from });
                const withdrawBalance = parseFloat(withdrawUser.balance || 0);
                const minWithdrawal = 0.01;
                const tonPrice = 3.31;
                const minBalanceRequired = minWithdrawal * tonPrice;

                let withdrawMessage;
                if (withdrawBalance < minBalanceRequired) {
                    withdrawMessage = `💳 Withdrawal Info:

❌ Insufficient Balance
Your balance: ${withdrawBalance.toFixed(4)}
Required: ${minBalanceRequired.toFixed(4)}

Keep tapping to earn more! 🚀`;
                } else {
                    withdrawMessage = `💳 Withdrawal Available!

✅ Balance: ${withdrawBalance.toFixed(4)}
🪙 Available: ${(withdrawBalance / tonPrice).toFixed(6)} TON

🚀 Click to start withdrawal:`;
                }

                const withdrawKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{
                                text: '💳 Withdraw Now',
                                web_app: { url: WEB_APP_URL }
                            }]
                        ]
                    }
                };

                await bot.editMessageText(withdrawMessage, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    ...withdrawKeyboard
                });
                break;

            case 'admin_stats':
                if (userId !== ADMIN_ID) {
                    await bot.answerCallbackQuery(callbackQuery.id, '❌ Access denied');
                    return;
                }

                // Get detailed admin stats
                const { count: totalUsers } = await supabase
                    .from('users')
                    .select('*', { count: 'exact', head: true });

                const { count: todayUsers } = await supabase
                    .from('users')
                    .select('*', { count: 'exact', head: true })
                    .gte('created_at', new Date(Date.now() - 24*60*60*1000).toISOString());

                const { data: balanceData } = await supabase
                    .from('users')
                    .select('balance, total_taps');
                
                const totalBalance = balanceData?.reduce((sum, user) => sum + parseFloat(user.balance || 0), 0) || 0;
                const totalTaps = balanceData?.reduce((sum, user) => sum + (user.total_taps || 0), 0) || 0;

                const { count: pendingWithdrawals } = await supabase
                    .from('withdrawals')
                    .select('*', { count: 'exact', head: true })
                    .eq('status', 'pending');

                const adminStatsMessage = `📊 Detailed Admin Stats:

👥 Users:
• Total: ${totalUsers || 0}
• New today: ${todayUsers || 0}

💰 Economy:
• Total balance: ${totalBalance.toFixed(2)}
• Total taps: ${totalTaps.toLocaleString()}
• Avg balance: ${totalUsers ? (totalBalance / totalUsers).toFixed(4) : '0.0000'}

💳 Withdrawals:
• Pending: ${pendingWithdrawals || 0}

🕒 Last updated: ${new Date().toLocaleTimeString()}`;

                const adminStatsKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{
                                text: '🔧 Full Admin Panel',
                                web_app: { url: `${WEB_APP_URL}/admin` }
                            }],
                            [{
                                text: '🔄 Refresh', 
                                callback_data: 'admin_stats'
                            }]
                        ]
                    }
                };

                await bot.editMessageText(adminStatsMessage, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    ...adminStatsKeyboard
                });
                break;

            case 'admin_withdrawals':
                if (userId !== ADMIN_ID) {
                    await bot.answerCallbackQuery(callbackQuery.id, '❌ Access denied');
                    return;
                }

                const { data: withdrawals } = await supabase
                    .from('withdrawals')
                    .select(`
                        *,
                        users!withdrawals_user_id_fkey (username, first_name)
                    `)
                    .eq('status', 'pending')
                    .order('request_date', { ascending: false })
                    .limit(10);

                let withdrawalsMessage = `💳 Pending Withdrawals:\n\n`;
                
                if (!withdrawals || withdrawals.length === 0) {
                    withdrawalsMessage += `✅ No pending withdrawals`;
                } else {
                    withdrawals.forEach((w, i) => {
                        const username = w.users?.username || w.users?.first_name || 'Unknown';
                        withdrawalsMessage += `${i + 1}. ${username}\n`;
                        withdrawalsMessage += `   💰 ${parseFloat(w.amount).toFixed(4)} TON\n`;
                        withdrawalsMessage += `   📅 ${new Date(w.request_date).toLocaleDateString()}\n\n`;
                    });
                }

                const withdrawalsKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{
                                text: '🔧 Manage Withdrawals',
                                web_app: { url: `${WEB_APP_URL}/admin` }
                            }]
                        ]
                    }
                };

                await bot.editMessageText(withdrawalsMessage, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    ...withdrawalsKeyboard
                });
                break;

            case 'help':
                const helpMessage = `📖 How to Play Tap to Earn:

🎮 Basic Gameplay:
1. Tap the golden button to earn points
2. Each tap = 0.05 points (default)
3. 1000 points = $1 USD

⚡ Energy System:
• You have 1000 energy max
• Each tap uses 1 energy
• Energy refills over time

💰 Earning More:
• Refer friends: +100 points each
• Buy packages: Higher points per tap
• Upgrade for unlimited taps

📦 Packages:
• All packages give 2x returns
• Higher packages = more points per tap
• Unlimited package = no tap limits

💳 Withdrawals:
• Minimum: 0.01 TON
• Fee: 1 TON
• Processing: 24-48 hours

🎯 Pro Tips:
• Invite friends for quick points
• Save energy for when you're active
• Upgrade packages for passive income

🚀 Ready to start earning?`;

                const helpKeyboard = {
                    reply_markup: {
                        inline_keyboard: [
                            [{
                                text: '🎮 Start Playing',
                                web_app: { url: WEB_APP_URL }
                            }],
                            [{
                                text: '👥 Get Referral Link',
                                callback_data: 'referrals'
                            }]
                        ]
                    }
                };

                await bot.editMessageText(helpMessage, {
                    chat_id: msg.chat.id,
                    message_id: msg.message_id,
                    ...helpKeyboard
                });
                break;
                
            default:
                await bot.answerCallbackQuery(callbackQuery.id, '❓ Unknown action');
        }
    } catch (error) {
        console.error('Callback query error:', error);
        await bot.answerCallbackQuery(callbackQuery.id, '❌ Something went wrong');
    }
});

// Handle inline queries for sharing
bot.on('inline_query', async (inlineQuery) => {
    try {
        const userId = inlineQuery.from.id;
        const query = inlineQuery.query.toLowerCase();
        
        const referralLink = `https://t.me/Taptoearnofficial_bot?start=${userId}`;
        
        const results = [
            {
                type: 'article',
                id: '1',
                title: '🚀 Tap to Earn Bot - Start Earning TON!',
                description: 'Join me and start earning real cryptocurrency by tapping!',
                input_message_content: {
                    message_text: `🚀 Join Tap to Earn Bot!

💰 Earn real TON cryptocurrency just by tapping!
🎯 Get 100 points bonus when you join with my link!

🎮 How it works:
• Tap to earn points
• 1000 points = $1 USD  
• Refer friends for bonuses
• Withdraw to TON wallet

🔥 Start earning now: ${referralLink}

#TapToEarn #TON #Cryptocurrency #EarnMoney`
                },
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: '🚀 Start Earning',
                            url: referralLink
                        }]
                    ]
                }
            },
            {
                type: 'article',
                id: '2',
                title: '💰 Easy Money with Tap to Earn',
                description: 'Simple tapping game that pays real cryptocurrency!',
                input_message_content: {
                    message_text: `💰 Want to earn money easily?

🎮 Tap to Earn Bot is here!
• Simple tapping gameplay
• Earn real TON cryptocurrency
• No investment needed to start
• Instant withdrawals to wallet

🎁 Use my referral link and get bonus points!

${referralLink}

Start tapping, start earning! 🚀`
                },
                reply_markup: {
                    inline_keyboard: [
                        [{
                            text: '💰 Start Now',
                            url: referralLink
                        }]
                    ]
                }
            }
        ];

        await bot.answerInlineQuery(inlineQuery.id, results, {
            cache_time: 300,
            is_personal: true
        });
    } catch (error) {
        console.error('Inline query error:', error);
    }
});

// Handle text messages (for general chat)
bot.on('message', async (msg) => {
    // Skip if it's a command
    if (msg.text && msg.text.startsWith('/')) return;
    
    // Skip if it's not a text message
    if (!msg.text) return;
    
    const chatId = msg.chat.id;
    
    // Simple keyword responses
    const text = msg.text.toLowerCase();
    
    if (text.includes('help') || text.includes('how')) {
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: '📖 How to Play',
                        callback_data: 'help'
                    }],
                    [{
                        text: '🚀 Start Playing',
                        web_app: { url: WEB_APP_URL }
                    }]
                ]
            }
        };
        
        await bot.sendMessage(chatId, '📖 Need help? Check out our guide!', keyboard);
    }
    else if (text.includes('balance') || text.includes('money')) {
        await bot.sendMessage(chatId, '💰 Use /balance to check your current balance!');
    }
    else if (text.includes('referral') || text.includes('invite')) {
        await bot.sendMessage(chatId, '👥 Use /referral to get your referral link and earn bonuses!');
    }
    else if (text.includes('withdraw') || text.includes('cash out')) {
        await bot.sendMessage(chatId, '💳 Use /withdraw to cash out your earnings!');
    }
    else if (text.includes('package') || text.includes('upgrade')) {
        await bot.sendMessage(chatId, '📦 Use /packages to see available upgrade packages!');
    }
    else if (text.includes('hi') || text.includes('hello') || text.includes('start')) {
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: '🚀 Start Earning',
                        web_app: { url: WEB_APP_URL }
                    }]
                ]
            }
        };
        
        await bot.sendMessage(chatId, '👋 Hello! Ready to start earning? Use /start to begin!', keyboard);
    }
    else {
        // Default response for other messages
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: '🎮 Play Game',
                        web_app: { url: WEB_APP_URL }
                    }],
                    [
                        { text: '💰 Balance', callback_data: 'balance' },
                        { text: '📖 Help', callback_data: 'help' }
                    ]
                ]
            }
        };
        
        await bot.sendMessage(chatId, '🤖 Use /start to see all available commands!', keyboard);
    }
});

// Handle errors
bot.on('error', (error) => {
    console.error('Bot error:', error.code, error.message);
});

bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});

// Webhook error handling
bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error.code, error.message);
});

console.log('🤖 Telegram bot started successfully!');
console.log('📱 Bot username: @Taptoearnofficial_bot');
console.log('🌐 Web App URL:', WEB_APP_URL);
console.log('👤 Admin ID:', ADMIN_ID);

module.exports = bot;
