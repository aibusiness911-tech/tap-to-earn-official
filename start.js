const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 Starting Tap to Earn Bot Application...');

// Start the web server
console.log('📡 Starting web server...');
const server = spawn('node', [path.join(__dirname, 'server.js')], { 
    stdio: 'inherit',
    env: { ...process.env }
});

// Wait a bit before starting the bot
setTimeout(() => {
    console.log('🤖 Starting Telegram bot...');
    // Start the bot
    const bot = spawn('node', [path.join(__dirname, 'bot.js')], { 
        stdio: 'inherit',
        env: { ...process.env }
    });

    // Handle bot process events
    bot.on('error', (error) => {
        console.error('❌ Bot process error:', error);
    });

    bot.on('exit', (code, signal) => {
        console.log(`🤖 Bot process exited with code ${code} and signal ${signal}`);
        if (code !== 0) {
            console.log('🔄 Restarting bot in 5 seconds...');
            setTimeout(() => {
                const newBot = spawn('node', [path.join(__dirname, 'bot.js')], { 
                    stdio: 'inherit',
                    env: { ...process.env }
                });
            }, 5000);
        }
    });
}, 3000);

// Handle server process events
server.on('error', (error) => {
    console.error('❌ Server process error:', error);
});

server.on('exit', (code, signal) => {
    console.log(`📡 Server process exited with code ${code} and signal ${signal}`);
});

// Handle process termination gracefully
process.on('SIGTERM', () => {
    console.log('📡 Received SIGTERM, shutting down gracefully...');
    server.kill('SIGTERM');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('📡 Received SIGINT, shutting down gracefully...');
    server.kill('SIGINT');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log('✅ Application started successfully!');
console.log('🌐 Web App: https://tap-to-earn-bot-production.up.railway.app');
console.log('👤 Admin Panel: https://tap-to-earn-bot-production.up.railway.app/admin');
console.log('🤖 Bot: @Taptoearnofficial_bot');
