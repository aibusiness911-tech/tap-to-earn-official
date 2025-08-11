require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { TonClient } = require("ton");
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Database setup (PostgreSQL on Railway)
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// API Routes (we'll add these later)
app.get('/user/:id', async (req, res) => { /* Get user data */ });
app.post('/tap/:userId', async (req, res) => { /* Handle taps */ });

app.listen(port, () => console.log(`Server running on port ${port}`));
