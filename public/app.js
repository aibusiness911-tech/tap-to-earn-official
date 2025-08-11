document.addEventListener('DOMContentLoaded', async () => {
  // Initialize Telegram Web App
  const tg = window.Telegram.WebApp;
  tg.expand();
  tg.enableClosingConfirmation();
  
  const user = tg.initDataUnsafe.user;
  const userId = user.id;
  
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
  
  // Load user data
  async function loadUserData() {
    try {
      const response = await fetch(`${process.env.SERVER_URL}/user/${userId}`);
      const userData = await response.json();
      
      // Update UI
      document.getElementById('points').textContent = userData.points.toFixed(2);
      document.getElementById('usd-value').textContent = 
        `$${(userData.points / 1000).toFixed(2)}`;
      document.getElementById('ton-value').textContent = 
        `${(userData.points / 1000 / window.tonPrice).toFixed(4)} TON`;
      
      document.getElementById('taps-left').textContent = 
        userData.package_type === 'unlimited' ? '∞' : (100 - (userData.taps_used || 0));
      
      // Update tap rate
      const tapRate = userData.package_type ? 
        window.packages[userData.package_type].pointsPerTap : 0.05;
      document.getElementById('tap-rate').textContent = tapRate;
      
      return userData;
    } catch (error) {
      console.error('Error loading user data:', error);
    }
  }
  
  // TAP button functionality
  document.getElementById('tap-btn').addEventListener('click', async () => {
    try {
      const response = await fetch(`${process.env.SERVER_URL}/tap/${userId}`, {
        method: 'POST'
      });
      
      if (response.ok) {
        const updatedUser = await response.json();
        document.getElementById('points').textContent = updatedUser.points.toFixed(2);
        document.getElementById('usd-value').textContent = 
          `$${(updatedUser.points / 1000).toFixed(2)}`;
        document.getElementById('ton-value').textContent = 
          `${(updatedUser.points / 1000 / window.tonPrice).toFixed(4)} TON`;
        document.getElementById('taps-left').textContent = 
          updatedUser.package_type === 'unlimited' ? '∞' : (100 - updatedUser.taps_used);
      } else {
        const error = await response.json();
        tg.showPopup({ title: 'Error', message: error.error });
      }
    } catch (error) {
      tg.showPopup({ title: 'Error', message: 'Network error' });
    }
  });
  
  // Withdrawal functionality
  document.getElementById('withdraw-btn').addEventListener('click', async () => {
    const walletAddress = document.getElementById('wallet-address').value;
    if (!walletAddress) {
      tg.showPopup({ title: 'Error', message: 'Please enter your TON wallet address' });
      return;
    }
    
    tg.showPopup({
      title: 'Confirm Withdrawal',
      message: `You will pay 1 TON fee. Continue?`,
      buttons: [{
        id: 'confirm',
        type: 'destructive',
        text: 'Confirm'
      }, {
        id: 'cancel',
        type: 'cancel'
      }]
    }, (buttonId) => {
      if (buttonId === 'confirm') {
        processWithdrawal(walletAddress);
      }
    });
  });
  
  async function processWithdrawal(walletAddress) {
    try {
      const response = await fetch(`${process.env.SERVER_URL}/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telegramId: userId,
          walletAddress: walletAddress
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        tg.showPopup({ title: 'Success', message: result.message });
        await loadUserData();
      } else {
        const error = await response.json();
        tg.showPopup({ title: 'Error', message: error.error });
      }
    } catch (error) {
      tg.showPopup({ title: 'Error', message: 'Withdrawal failed' });
    }
  }
  
  // Package purchase
  document.querySelectorAll('.buy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const packageType = btn.closest('.package-card').dataset.package;
      const pkg = window.packages[packageType];
      
      tg.showPopup({
        title: 'Confirm Purchase',
        message: `Buy $${packageType === 'unlimited' ? '500 Unlimited' : packageType} package for ${pkg.costTON} TON?`,
        buttons: [{
          id: 'buy',
          type: 'default',
          text: `Pay ${pkg.costTON} TON`
        }, {
          id: 'cancel',
          type: 'cancel'
        }]
      }, async (buttonId) => {
        if (buttonId === 'buy') {
          // Open TON wallet for payment
          const paymentLink = `ton://transfer/${process.env.WALLET_ADDRESS}?amount=${Math.round(pkg.costTON * 1000000000)}`;
          tg.openLink(paymentLink);
          
          // Wait for payment (in real app, you'd verify transaction)
          tg.showPopup({
            title: 'Processing',
            message: 'Confirm payment in your wallet...'
          });
          
          // Simulate payment verification
          setTimeout(async () => {
            const response = await fetch(`${process.env.SERVER_URL}/purchase`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                telegramId: userId,
                packageType: packageType,
                transactionHash: 'simulated_' + Date.now()
              })
            });
            
            if (response.ok) {
              tg.showPopup({ 
                title: 'Success', 
                message: 'Package activated!' 
              });
              await loadUserData();
            } else {
              const error = await response.json();
              tg.showPopup({ title: 'Error', message: error.error });
            }
          }, 3000);
        }
      });
    });
  });
  
  // Referral system
  document.getElementById('copy-link').addEventListener('click', () => {
    const linkInput = document.getElementById('ref-link');
    linkInput.select();
    document.execCommand('copy');
    tg.showPopup({ title: 'Copied!', message: 'Referral link copied to clipboard' });
  });
  
  // Initialize referral link
  document.getElementById('ref-link').value = 
    `https://t.me/${tg.initDataUnsafe.user.username}?start=${userId}`;
  
  // Load initial data
  try {
    const tonResponse = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd');
    const tonData = await tonResponse.json();
    window.tonPrice = tonData['the-open-network'].usd;
    
    // Update package costs
    window.packages = {
      '5': { costTON: (1.49 * 3.31 / window.tonPrice).toFixed(2), pointsPerTap: 0.2, limit: 10000 },
      '10': { costTON: (2.98 * 3.31 / window.tonPrice).toFixed(2), pointsPerTap: 0.25, limit: 20000 },
      '50': { costTON: (15.11 * 3.31 / window.tonPrice).toFixed(2), pointsPerTap: 0.5, limit: 100000 },
      '100': { costTON: (30.21 * 3.31 / window.tonPrice).toFixed(2), pointsPerTap: 1, limit: 200000 },
      '1000': { costTON: (302.11 * 3.31 / window.tonPrice).toFixed(2), pointsPerTap: 10, limit: 2000000 },
      'unlimited': { costTON: (151.06 * 3.31 / window.tonPrice).toFixed(2), pointsPerTap: 1, limit: null }
    };
    
    // Update UI costs
    document.querySelectorAll('.ton-cost').forEach(el => {
      const packageType = el.closest('.package-card').dataset.package;
      el.textContent = window.packages[packageType].costTON;
    });
    
    await loadUserData();
  } catch (error) {
    console.error('Initialization error:', error);
  }
});
