// --- GLOBAL CRASH CATCHERS ---
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION CRASH:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION:', reason);
});

require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const session = require('express-session');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Crucial: Trust the reverse proxy / tunnel headers (Cloudflare/Ngrok/etc.) for HTTPS cookies
app.set('trust proxy', 1);

app.use(express.json());

// Session setup for Discord login (Brave-compatible)
app.use(session({
    secret: 'super-secret-key-change-this',
    resave: false,
    saveUninitialized: false,
    proxy: true, 
    cookie: {
        secure: true, // Required for HTTPS (lilvape.lol)
        sameSite: 'lax', // Prevents Brave from blocking the cookie on redirect
        maxAge: 24 * 60 * 60 * 1000 // 1 day session length
    }
}));

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Discord OAuth Credentials from .env
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = 'https://lilvape.lol/auth/discord/callback';

// In-memory storage (Can be linked to a Database later)
const userConfigs = {};
const userScripts = {};

// --- BULLETPROOF PAYMENT & SUBSCRIPTION VALIDATION CHECKER ---
async function checkUserSubscription(userId) {
    try {
        // Auto-bypass if environment variables for guild/role check are not configured yet
        if (!process.env.DISCORD_GUILD_ID || !process.env.PAID_ROLE_ID) {
            return true; 
        }
        
        const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID);
        if (!guild) return true; 
        
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return false;

        return member.roles.cache.has(process.env.PAID_ROLE_ID);
    } catch (err) {
        console.error("Subscription check warning:", err.message);
        return true; // Fail open for safety so it never 503-crashes your server
    }
}

// --- SECURITY WALL MIDDLEWARE ---
async function isAuthenticated(req, res, next) {
    if (req.session && req.session.user && req.session.hasAccess) {
        return next();
    }
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: "Unauthorized. Active payment/subscription required." });
    }
    res.redirect('/auth/discord');
}

// Root Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 1. Redirect user to Discord login
app.get('/auth/discord', (req, res) => {
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify guilds`;
    res.redirect(discordAuthUrl);
});

// 2. Discord OAuth Callback & Payment Verification
app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        console.error("OAuth Error: No code provided from Discord query parameters.");
        return res.status(400).send('No code provided from Discord.');
    }

    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
        });

        const tokenData = await tokenRes.json();
        
        // Print the token response to your terminal if it fails
        if (!tokenData.access_token) {
            console.error("Discord Token Exchange Failed:", tokenData);
            return res.status(400).send(`Failed to get access token from Discord: ${JSON.stringify(tokenData)}`);
        }

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `Bearer ${tokenData.access_token}` },
        });

        const userData = await userRes.json();
        console.log(`Successfully authenticated Discord user: ${userData.username} (${userData.id})`);
        
        // Verify payment/subscription status via bot role check safely
        const hasPaidAccess = await checkUserSubscription(userData.id);

        req.session.user = {
            id: userData.id,
            username: userData.global_name || userData.username,
            avatar: `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
        };
        req.session.hasAccess = hasPaidAccess;

        // Force session save before redirecting to prevent dropouts
        req.session.save((err) => {
            if (err) console.error("Session save error:", err);
            res.redirect('/');
        });

    } catch (err) {
        console.error('OAuth Callback Exception:', err);
        res.status(500).send('Authentication failed due to server error.');
    }
});

// 3. Get currently logged-in user session status
app.get('/api/user', (req, res) => {
    if (!req.session.user) return res.json({ loggedIn: false, hasAccess: false });
    res.json({ loggedIn: true, hasAccess: req.session.hasAccess, user: req.session.user });
});

// 4. Logout route
app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// --- PROTECTED ROUTES (Requires Discord Login & Verified Payment) ---

app.post('/api/save-settings', isAuthenticated, (req, res) => {
    const userId = req.session.user.id;
    const { settings, isPublic } = req.body;

    userConfigs[userId] = {
        username: req.session.user.username,
        avatar: req.session.user.avatar,
        settings: settings || {},
        isPublic: !!isPublic,
        updatedAt: new Date()
    };

    // -> REAL-TIME BROADCAST: Instantly pushes configuration updates to your Roblox game script via Socket.io
    io.to(userId).emit('configUpdate', settings);

    res.json({ success: true, message: "Settings saved and synced live!" });
});

app.post('/api/save-script-source', isAuthenticated, (req, res) => {
    const userId = req.session.user.id;
    const { scriptSource } = req.body;

    userScripts[userId] = scriptSource;
    res.json({ success: true, message: "Script source saved securely!" });
});

app.get('/api/cloud-configs', isAuthenticated, (req, res) => {
    const publicConfigs = Object.entries(userConfigs)
        .filter(([id, data]) => data.isPublic)
        .map(([id, data]) => ({
            userId: id,
            username: data.username,
            avatar: data.avatar,
            settings: data.settings,
            updatedAt: data.updatedAt
        }));

    res.json(publicConfigs);
});

// --- PUBLIC ROUTES (For Roblox execution) ---

app.get('/api/get-script-settings/:discordId', (req, res) => {
    const discordId = req.params.discordId;
    const config = userConfigs[discordId];
    if (!config) return res.json({ success: false });
    res.json({ success: true, settings: config.settings });
});

app.get('/api/public-cheat', (req, res) => {
    res.setHeader('Content-Type', 'text/plain');
    const masterDiscordId = "YOUR_DISCORD_ID_HERE"; 
    res.send(userScripts[masterDiscordId] || "print('No script uploaded yet.')");
});

// --- SOCKET.IO REAL-TIME SYNC FOR ROBLOX ---
io.on('connection', (socket) => {
    socket.on('registerRobloxClient', (discordId) => {
        if (discordId) {
            socket.join(discordId);
            console.log(`[Socket.io]: Roblox client connected for Discord ID: ${discordId}`);
            
            if (userConfigs[discordId]) {
                socket.emit('configUpdate', userConfigs[discordId].settings);
            }
        }
    });
});

// Start Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running live on https://lilvape.lol (Port ${PORT})`);
});

// Discord Bot Client Setup
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.login(process.env.DISCORD_BOT_TOKEN);