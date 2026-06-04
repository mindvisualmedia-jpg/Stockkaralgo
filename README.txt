STOCKKAR TRADER
═══════════════════════════════

SETUP (one time only — 5 minutes)
───────────────────────────────────
1. Install Node.js from: https://nodejs.org
   → Download the LTS version → Install with all defaults

2. Double-click START.bat
   → First launch installs dependencies automatically (~1 min)
   → App opens as a desktop window

DAILY USE
──────────────────────────────────
1. Double-click START.bat
2. Settings tab → Enter Stockkar token + Dhan token → Save
3. Screener tab → Click Fetch
4. Execute tab → Select stocks → Fire orders

GETTING YOUR TOKENS
──────────────────────────────────
Stockkar token:
  → Open stockkar.in → Login → Press F12
  → Go to Network tab → Click any API call
  → Look for "Authorization" header → copy the value

Dhan token (refreshes daily):
  → Open Dhan App → My Profile → Dhan HQ → Generate Access Token

Zerodha Kite daily token:
  1. Set the Kite Developer Redirect URL to:
     https://YOUR-STOCKKAR-APP/broker/zerodha/callback
  2. Save the Kite API key and API secret in Stockkar Settings.
  3. Click Renew Zerodha Token after 6:00 AM IST each trading day.
  4. Complete Kite login. Stockkar updates queued Zerodha algos automatically.

Angel One SmartAPI:
  1. Generate a SmartAPI session using Angel One and copy the API key, client code,
     JWT token, and refresh token.
  2. Select Angel One SmartAPI in Stockkar Settings and save those credentials.
  3. Stockkar refreshes the Angel One JWT token daily at 4:00 PM IST while the
     refresh token remains valid.

SUPPORT
──────────────────────────────────
support@stockkar.in
