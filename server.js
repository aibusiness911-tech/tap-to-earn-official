require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
const cors = require('cors');
const TonWeb = require('tonweb');
const cron = require('node-cron');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// TON setup
const tonweb = new TonWeb(new TonWeb.HttpProvider('https://toncenter.com/api/v2', {
  apiKey: process.env.TON_API_KEY
}));

// Global variables
let tonPriceUSD = 3.31;
let packages = {
  '5': { costTON: 1.49, pointsPerTap: 0.2, limit: 10000 },
  '10': { costTON: 2.98, pointsPerTap: 0.25, limit: 20000 },
  '50': { costTON: 15.11, pointsPerTap: 0.5, limit: 100000 },
  '100': { costTON: 30.21, pointsPerTap: 1, limit: 200000 },
  '1000': { costTON: 302.11, pointsPerTap: 10, limit: 2000000 },
  'unlimited': { costTON: 151.06, pointsPerTap: 1, limit: null }
};

// Update TON price
async function updateTonPrice() {
  try {
    const response = await axios.get(process.env.COINGECKO_API);
    tonPriceUSD = response.data['the-open-network'].usd;
    console.log(`TON Price Updated: $${tonPriceUSD}`);
    
    // Update package costs
    for (const [key, pkg] of Object.entries(packages)) {
      pkg.costTON = (pkg.costTON * 3.31 / tonPriceUSD).toFixed(2);
    }
  } catch (error) {
    console.error('TON Price Update Error:', error.message);
  }
}

// Scheduled tasks
cron.schedule('*/10 * * * *', updateTonPrice); // Every 10 minutes
updateTonPrice(); // Initial update

// API Endpoints

// Get user data
app.get('/user/:telegramId', async (req, res) => {
  try {
    const user = await pool.query(
      `INSERT INTO users (telegram_id) 
       VALUES ($1) 
       ON CONFLICT (telegram_id) DO UPDATE SET telegram_id = EXCLUDED.telegram_id 
       RETURNING *`,
      [req.params.telegramId]
    );
    res.json(user.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle tap
app.post('/tap/:telegramId', async (req, res) => {
  try {
    const user = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE',
      [req.params.telegramId]
    );
    
    if (!user.rows[0]) return res.status(404).send('User not found');
    
    const userData = user.rows[0];
    const today = new Date().toISOString().split('T')[0];
    const lastTapDate = userData.last_tap_date?.toISOString().split('T')[0];
    
    // Reset taps if new day
    if (lastTapDate !== today) {
      await pool.query(
        'UPDATE users SET taps_used = 0, last_tap_date = NOW() WHERE telegram_id = $1',
        [req.params.telegramId]
      );
      userData.taps_used = 0;
    }
    
    // Check tap limits
    if (userData.package_type !== 'unlimited' && userData.taps_used >= 100) {
      return res.status(400).json({ error: 'Daily tap limit reached' });
    }
    
    // Calculate points
    let pointsPerTap = userData.package_type ? 
      packages[userData.package_type].pointsPerTap : 0.05;
    
    // Update user
    await pool.query(
      `UPDATE users 
       SET points = points + $1, 
           taps_used = taps_used + 1 
       WHERE telegram_id = $2`,
      [pointsPerTap, req.params.telegramId]
    );
    
    // Return updated data
    const updatedUser = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [req.params.telegramId]
    );
    
    res.json(updatedUser.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle withdrawal
app.post('/withdraw', async (req, res) => {
  try {
    const { telegramId, walletAddress } = req.body;
    const user = await pool.query(
      'SELECT * FROM users WHERE telegram_id = $1 FOR UPDATE',
      [telegramId]
    );
    
    if (!user.rows[0]) return res.status(404).send('User not found');
    
    const userData = user.rows[0];
    
    // Check minimum withdrawal
    if (userData.points < 1000) {
      return res.status(400).json({ error: 'Minimum withdrawal is 1000 points ($1)' });
    }
    
    // Calculate TON amount
    const dollarAmount = userData.points / 1000;
    const tonAmount = dollarAmount / tonPriceUSD;
    
    // Deduct points
    await pool.query(
      'UPDATE users SET points = 0 WHERE telegram_id = $1',
      [telegramId]
    );
    
    // In production: Add code to actually send TON here
    console.log(`Withdrawal processed: ${tonAmount.toFixed(4)} TON to ${walletAddress}`);
    
    res.json({ 
      success: true, 
      message: `${tonAmount.toFixed(4)} TON sent to your wallet` 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Handle package purchase
app.post('/purchase', async (req, res) => {
  try {
    const { telegramId, packageType, transactionHash } = req.body;
    
    // Verify transaction (simplified)
    const isVerified = true; // In production: Add actual TON verification
    
    if (!isVerified) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }
    
    // Update user package
    await pool.query(
      'UPDATE users SET package_type = $1 WHERE telegram_id = $2',
      [packageType, telegramId]
    );
    
    res.json({ 
      success: true,
      package: packages[packageType]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get referrals
app.get('/referrals/:telegramId', async (req, res) => {
  try {
    const referrals = await pool.query(
      `SELECT u.telegram_id, u.username 
       FROM referrals r
       JOIN users u ON r.referee_id = u.telegram_id
       WHERE r.referrer_id = $1`,
      [req.params.telegramId]
    );
    res.json(referrals.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Initialize database
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id INTEGER UNIQUE NOT NULL,
      points FLOAT DEFAULT 0,
      taps_used INTEGER DEFAULT 0,
      last_tap_date TIMESTAMP,
      package_type VARCHAR(20)
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id SERIAL PRIMARY KEY,
      referrer_id INTEGER NOT NULL,
      referee_id INTEGER UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Start server
app.listen(port, async () => {
  await initDB();
  console.log(`Server running on port ${port}`);
});
