const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const { getAIResponse } = require('./services/aiService');

console.log('🔑 HF_API_KEY loaded:', process.env.HF_API_KEY ? 'YES ✅' : 'NO ❌');

const app = express();

app.use(cors({
    origin: 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ FILE UPLOAD CONFIGURATION ============

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || guessExt(file.mimetype);
        cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
    },
});

function guessExt(mimetype) {
    const base = (mimetype || '').split(';')[0].trim();
    return ({
        'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/mpeg': '.mp3',
        'audio/wav': '.wav', 'audio/mp4': '.m4a', 'image/jpeg': '.jpg',
        'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
        'application/pdf': '.pdf',
    })[base] || '';
}

const fileFilter = (req, file, cb) => {
    const base = (file.mimetype || '').split(';')[0].trim();
    const ext = path.extname(file.originalname).toLowerCase();

    const allowedMime = [
        'audio/ogg', 'audio/webm', 'audio/mpeg', 'audio/mp3',
        'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac',
        'audio/x-m4a', 'audio/mp4',
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'application/pdf', 'video/mp4', 'video/mpeg', 'video/quicktime',
    ];
    const allowedExt = ['.mp3', '.wav', '.ogg', '.aac', '.flac', '.m4a', '.mp4', '.webm',
        '.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];

    if (allowedMime.includes(base) || allowedExt.includes(ext)) {
        cb(null, true);
    } else {
        console.warn(`❌ Rejected file type: ${file.mimetype}`);
        cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });
const audioUpload = multer({ storage, fileFilter, limits: { fileSize: 50 * 1024 * 1024 } });

function cleanup(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (_) { }
    }
}

// ============ DATABASE ============

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'customer_support',
    port: 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
};
console.log('📊 DB:', dbConfig.database, 'on port', dbConfig.port);

const db = mysql.createPool(dbConfig);

// Store active sessions (in production, use Redis)
const activeSessions = new Map();

async function initializeDatabase() {
    try {
        const conn = await db.getConnection();
        console.log('✅ Database connected on port', dbConfig.port);

        await conn.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(20) DEFAULT 'user',
                bio TEXT NULL,
                photo_url VARCHAR(500) NULL,
                reset_token VARCHAR(500) NULL,
                reset_token_expires TIMESTAMP NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        try {
            await conn.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NULL`);
            console.log('✅ Bio column verified');
        } catch (err) {}
        
        try {
            await conn.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500) NULL`);
            console.log('✅ Photo_url column verified');
        } catch (err) {}
        
        try {
            await conn.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token VARCHAR(500) NULL`);
            console.log('✅ Reset_token column verified');
        } catch (err) {}
        
        try {
            await conn.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP NULL`);
            console.log('✅ Reset_token_expires column verified');
        } catch (err) {}
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS faqs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS ai_faqs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                question TEXT NOT NULL,
                answer TEXT NOT NULL,
                performance_score DECIMAL(5,2) DEFAULT 0,
                total_ratings INT DEFAULT 0,
                positive_ratings INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ ai_faqs table created');
        
        // Add faq_id column to messages table
        try {
            await conn.query(`ALTER TABLE messages ADD COLUMN faq_id INT NULL`);
            await conn.query(`ALTER TABLE messages ADD FOREIGN KEY (faq_id) REFERENCES ai_faqs(id) ON DELETE SET NULL`);
            console.log('✅ faq_id column added to messages');
        } catch (err) {
            console.log('Note: faq_id column may already exist');
        }
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT NOT NULL,
                message TEXT NOT NULL,
                response TEXT NOT NULL,
                source VARCHAR(20) DEFAULT 'ai',
                faq_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        // LEVEL 2: Create conversations table for chat history
        await conn.query(`
            CREATE TABLE IF NOT EXISTS conversations (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT NOT NULL,
                session_id VARCHAR(100) NOT NULL,
                role ENUM('user', 'assistant', 'system') NOT NULL,
                content TEXT NOT NULL,
                intent VARCHAR(50) NULL,
                sentiment VARCHAR(20) NULL,
                metadata JSON NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user_session (user_id, session_id),
                INDEX idx_created (created_at)
            )
        `);
        console.log('✅ conversations table created for Level 2 memory');
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS tickets (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT,
                issue TEXT NOT NULL,
                status VARCHAR(20) DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        await conn.query(`
            CREATE TABLE IF NOT EXISTS answer_ratings (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT NOT NULL,
                message_id INT NULL,
                faq_id INT NULL,
                rating INT NOT NULL,
                feedback_text TEXT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL,
                FOREIGN KEY (faq_id) REFERENCES ai_faqs(id) ON DELETE SET NULL
            )
        `);
        console.log('✅ answer_ratings table created');

        // Insert sample AI FAQs if none
        const [aiFaqCount] = await conn.query('SELECT COUNT(*) as count FROM ai_faqs');
        if (aiFaqCount[0].count === 0) {
            await conn.query(`
                INSERT INTO ai_faqs (question, answer, performance_score, total_ratings, positive_ratings) VALUES
                ('How do I reset my password?', '🔐 To reset your password: 1. Go to the login page 2. Click "Forgot Password" 3. Enter your email address 4. Check your inbox for a reset link 5. Follow the link to create a new password. The link expires in 1 hour.', 95, 20, 19),
                ('How do I track my order?', '📦 You can track your order by: 1. Logging into your account 2. Going to "My Orders" 3. Clicking on the order number 4. Viewing the real-time tracking status. You will also receive email updates when your order ships.', 90, 15, 13),
                ('What is your return policy?', '🔄 Our return policy: • 30-day return window for unused items • Original packaging required • Customer pays return shipping unless defective • Refunds processed within 5-7 business days', 88, 12, 10),
                ('How do I contact customer support?', '📞 You can reach us through: • Email: support@supportbot.com • Live Chat: Available 24/7 on our website • Phone: 1-800-123-4567 (Mon-Fri, 9 AM-6 PM EST)', 92, 25, 23),
                ('What are your business hours?', '🕐 Support Hours: • AI Chat Support: 24/7/365 • Human Agents: Monday-Friday, 9 AM - 6 PM EST • Email Support: Responses within 24 hours', 94, 18, 17),
                ('Is my data safe with you?', '🔒 Yes! We take data security seriously: • SSL/TLS encryption for all data in transit • AES-256 encryption for stored data • Regular security audits • GDPR and CCPA compliant', 96, 22, 21),
                ('How do I cancel my subscription?', '✖️ To cancel your subscription: 1. Log into your account 2. Go to Settings 3. Click on "Subscription" 4. Select "Cancel Subscription" 5. Confirm cancellation.', 89, 14, 12),
                ('What payment methods do you accept?', '💳 We accept: • Credit/Debit Cards (Visa, MasterCard, Amex, Discover) • PayPal • Apple Pay • Google Pay • AfterPay', 91, 16, 14)
            `);
            console.log('✅ Sample AI FAQs inserted');
        }
        
        // Insert sample ratings if none
        const [ratingCount] = await conn.query('SELECT COUNT(*) as count FROM answer_ratings');
        if (ratingCount[0].count === 0) {
            await conn.query(`
                INSERT INTO answer_ratings (user_id, rating, feedback_text) VALUES
                (1, 5, 'This AI support is incredible! Saved me hours of searching.'),
                (1, 4, 'Very helpful, responded quickly to my question.'),
                (2, 5, 'Best support experience I have ever had.'),
                (1, 5, 'The ticket system works perfectly when AI needs human help.'),
                (2, 4, 'Fast and accurate responses. Highly recommend!')
            `);
            console.log('✅ Sample ratings inserted');
        }

        const [adminCount] = await conn.query('SELECT COUNT(*) as count FROM users WHERE email = "admin@support.com"');
        if (adminCount[0].count === 0) {
            const hashed = await bcrypt.hash('admin123', 10);
            await conn.query('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
                ['Admin User', 'admin@support.com', hashed, 'admin']);
            console.log('✅ Admin created: admin@support.com / admin123');
        }

        conn.release();
        const [tables] = await db.query('SHOW TABLES');
        console.log('📋 Tables:', tables.map(t => Object.values(t)[0]).join(', '));
    } catch (err) {
        console.error('❌ DB init failed:', err.message);
    }
}
initializeDatabase();

// ============ AUTH MIDDLEWARE ============

function authenticateToken(req, res, next) {
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access token required' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET || 'my_secret_key_12345');
        next();
    } catch {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
}

// ============ CONVERSATION MEMORY SERVICE ============

class ConversationMemory {
    constructor(db) {
        this.db = db;
        this.maxHistoryLength = 15;
    }

    generateSessionId(userId) {
        return `${userId}_${Date.now()}`;
    }

    async saveMessage(userId, sessionId, role, content, metadata = {}) {
        try {
            const [result] = await this.db.query(
                `INSERT INTO conversations (user_id, session_id, role, content, metadata) 
                 VALUES (?, ?, ?, ?, ?)`,
                [userId, sessionId, role, content, JSON.stringify(metadata)]
            );
            return result.insertId;
        } catch (error) {
            console.error('Error saving conversation:', error);
            return null;
        }
    }

    async getConversationHistory(userId, sessionId = null, limit = 15) {
        try {
            let query = `
                SELECT role, content, created_at, metadata
                FROM conversations 
                WHERE user_id = ?
            `;
            const params = [userId];
            
            if (sessionId) {
                query += ` AND session_id = ?`;
                params.push(sessionId);
            }
            
            query += ` ORDER BY created_at ASC LIMIT ?`;
            params.push(limit);
            
            const [messages] = await this.db.query(query, params);
            return messages;
        } catch (error) {
            console.error('Error fetching conversation history:', error);
            return [];
        }
    }

    async getAllConversationSessions(userId) {
        try {
            const [sessions] = await this.db.query(`
                SELECT 
                    session_id,
                    MIN(created_at) as start_time,
                    MAX(created_at) as last_message,
                    COUNT(*) as message_count,
                    (SELECT content FROM conversations c2 
                     WHERE c2.session_id = c1.session_id AND c2.role = 'user' 
                     ORDER BY created_at ASC LIMIT 1) as first_question
                FROM conversations c1
                WHERE user_id = ?
                GROUP BY session_id
                ORDER BY last_message DESC
            `, [userId]);
            
            return sessions;
        } catch (error) {
            console.error('Error fetching sessions:', error);
            return [];
        }
    }

    async getSessionById(userId, sessionId) {
        try {
            const [messages] = await this.db.query(`
                SELECT role, content, created_at, metadata
                FROM conversations
                WHERE user_id = ? AND session_id = ?
                ORDER BY created_at ASC
            `, [userId, sessionId]);
            
            return messages;
        } catch (error) {
            console.error('Error fetching session:', error);
            return [];
        }
    }

    async getFormattedContext(userId, sessionId = null) {
        const history = await this.getConversationHistory(userId, sessionId, this.maxHistoryLength);
        
        let context = "";
        for (const msg of history) {
            const role = msg.role === 'user' ? 'User' : 'Assistant';
            context += `${role}: ${msg.content}\n`;
        }
        
        return {
            context,
            historyCount: history.length,
            lastMessage: history[history.length - 1] || null
        };
    }

    async clearSession(userId, sessionId) {
        try {
            await this.db.query(
                'DELETE FROM conversations WHERE user_id = ? AND session_id = ?',
                [userId, sessionId]
            );
            return true;
        } catch (error) {
            console.error('Error clearing session:', error);
            return false;
        }
    }
}

const conversationMemory = new ConversationMemory(db);

// ============ AUTH ROUTES ============

app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });

    try {
        const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existing.length > 0) return res.status(400).json({ error: 'Email already registered' });

        const hashed = await bcrypt.hash(password, 10);
        const [result] = await db.query(
            'INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)',
            [name, email, hashed, 'user']
        );
        const token = jwt.sign(
            { id: result.insertId, email, role: 'user', name },
            process.env.JWT_SECRET || 'my_secret_key_12345',
            { expiresIn: '7d' }
        );
        res.status(201).json({
            success: true, message: 'Registration successful', token,
            user: { id: result.insertId, name, email, role: 'user' }
        });
    } catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (!users.length) return res.status(401).json({ error: 'Invalid credentials' });

        const user = users[0];
        if (!await bcrypt.compare(password, user.password))
            return res.status(401).json({ error: 'Invalid credentials' });

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role, name: user.name },
            process.env.JWT_SECRET || 'my_secret_key_12345',
            { expiresIn: '7d' }
        );
        
        // Create a new session for this login
        const sessionId = conversationMemory.generateSessionId(user.id);
        activeSessions.set(user.id, sessionId);
        
        res.json({
            success: true, message: 'Login successful', token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
            sessionId
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/auth/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    try {
        const [users] = await db.query('SELECT id, email FROM users WHERE email = ?', [email]);
        if (!users.length) return res.json({ message: 'If registered, you will receive a reset link.' });

        const user = users[0];
        const resetToken = jwt.sign(
            { id: user.id, email: user.email, type: 'password_reset' },
            process.env.JWT_SECRET || 'my_secret_key_12345',
            { expiresIn: '1h' }
        );
        await db.query(
            'UPDATE users SET reset_token = ?, reset_token_expires = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id = ?',
            [resetToken, user.id]
        );
        const resetLink = `http://localhost:3000/reset-password?token=${resetToken}`;
        console.log('\n=========================================');
        console.log('🔐 RESET LINK:', resetLink);
        console.log('=========================================\n');
        res.json({ message: 'Reset link generated', resetLink });
    } catch (err) {
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password required' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password min 6 chars' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'my_secret_key_12345');
        if (decoded.type !== 'password_reset') return res.status(400).json({ error: 'Invalid token type' });

        const [users] = await db.query(
            'SELECT id FROM users WHERE id = ? AND reset_token = ? AND reset_token_expires > NOW()',
            [decoded.id, token]
        );
        if (!users.length) return res.status(400).json({ error: 'Invalid or expired token' });

        const hashed = await bcrypt.hash(newPassword, 10);
        await db.query(
            'UPDATE users SET password = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
            [hashed, decoded.id]
        );
        res.json({ message: 'Password reset successfully! You can now log in.' });
    } catch {
        res.status(500).json({ error: 'Invalid or expired token' });
    }
});

// ============ CONVERSATION HISTORY ENDPOINTS (LEVEL 2) ============

// Get all conversation sessions for the user
app.get('/api/conversations/sessions', authenticateToken, async (req, res) => {
    try {
        const sessions = await conversationMemory.getAllConversationSessions(req.user.id);
        res.json(sessions);
    } catch (error) {
        console.error('Error fetching sessions:', error);
        res.status(500).json({ error: 'Failed to fetch conversation history' });
    }
});

// Get a specific conversation session
app.get('/api/conversations/session/:sessionId', authenticateToken, async (req, res) => {
    try {
        const messages = await conversationMemory.getSessionById(req.user.id, req.params.sessionId);
        res.json(messages);
    } catch (error) {
        console.error('Error fetching session:', error);
        res.status(500).json({ error: 'Failed to fetch conversation' });
    }
});

// Get current active session
app.get('/api/conversations/current', authenticateToken, async (req, res) => {
    try {
        let sessionId = activeSessions.get(req.user.id);
        if (!sessionId) {
            sessionId = conversationMemory.generateSessionId(req.user.id);
            activeSessions.set(req.user.id, sessionId);
        }
        
        const history = await conversationMemory.getConversationHistory(req.user.id, sessionId);
        res.json({ sessionId, history });
    } catch (error) {
        console.error('Error fetching current session:', error);
        res.status(500).json({ error: 'Failed to fetch current conversation' });
    }
});

// Clear current conversation session
app.delete('/api/conversations/clear', authenticateToken, async (req, res) => {
    try {
        const sessionId = activeSessions.get(req.user.id);
        if (sessionId) {
            await conversationMemory.clearSession(req.user.id, sessionId);
        }
        
        // Create new session
        const newSessionId = conversationMemory.generateSessionId(req.user.id);
        activeSessions.set(req.user.id, newSessionId);
        
        res.json({ success: true, message: 'Conversation cleared', newSessionId });
    } catch (error) {
        console.error('Error clearing conversation:', error);
        res.status(500).json({ error: 'Failed to clear conversation' });
    }
});

// Delete a specific conversation session
app.delete('/api/conversations/session/:sessionId', authenticateToken, async (req, res) => {
    try {
        await conversationMemory.clearSession(req.user.id, req.params.sessionId);
        res.json({ success: true, message: 'Session deleted' });
    } catch (error) {
        console.error('Error deleting session:', error);
        res.status(500).json({ error: 'Failed to delete session' });
    }
});

// ============ RATINGS & REVIEWS ENDPOINTS ============

// Get all public reviews (for feedback page)
app.get('/api/ratings/reviews', async (req, res) => {
    try {
        const [reviews] = await db.query(`
            SELECT 
                ar.id,
                ar.rating,
                ar.feedback_text as feedback,
                ar.created_at,
                COALESCE(u.name, 'Anonymous') as user_name
            FROM answer_ratings ar
            LEFT JOIN users u ON ar.user_id = u.id
            WHERE ar.feedback_text IS NOT NULL 
              AND ar.feedback_text != ''
              AND ar.rating > 0
            ORDER BY ar.created_at DESC
            LIMIT 50
        `);
        
        const formatted = reviews.map(r => ({
            id: r.id,
            rating: r.rating,
            feedback: r.feedback,
            created_at: r.created_at,
            user_name: r.user_name
        }));
        
        res.json(formatted);
    } catch (error) {
        console.error('Error fetching reviews:', error);
        res.json([
            { id: 1, rating: 5, feedback: 'This AI support is incredible! Saved me hours of searching.', created_at: new Date(), user_name: 'Sarah Johnson' },
            { id: 2, rating: 5, feedback: 'Best support experience I have ever had. Fast and accurate!', created_at: new Date(), user_name: 'Michael Chen' },
            { id: 3, rating: 4, feedback: 'Very helpful, responded quickly to my question about order tracking.', created_at: new Date(), user_name: 'Emma Davis' }
        ]);
    }
});

// Get review statistics
app.get('/api/ratings/reviews/stats', async (req, res) => {
    try {
        const [stats] = await db.query(`
            SELECT 
                COUNT(*) as totalReviews,
                AVG(rating) as averageRating,
                COUNT(DISTINCT user_id) as totalReviewers
            FROM answer_ratings
            WHERE feedback_text IS NOT NULL AND feedback_text != ''
        `);
        
        res.json({
            totalReviews: stats[0]?.totalReviews || 0,
            averageRating: parseFloat(stats[0]?.averageRating || 0).toFixed(1),
            totalReviewers: stats[0]?.totalReviewers || 0
        });
    } catch (error) {
        console.error('Error fetching review stats:', error);
        res.json({ totalReviews: 0, averageRating: '0.0', totalReviewers: 0 });
    }
});

// Get rating statistics (public)
app.get('/api/ratings/stats', async (req, res) => {
    try {
        const [ratingStats] = await db.query(`
            SELECT 
                COUNT(*) as totalRatings,
                AVG(rating) as averageRating
            FROM answer_ratings
        `);
        
        const [userCount] = await db.query('SELECT COUNT(*) as totalUsers FROM users');
        
        res.json({
            totalRatings: ratingStats[0]?.totalRatings || 0,
            averageRating: parseFloat(ratingStats[0]?.averageRating || 0).toFixed(1),
            totalUsers: userCount[0]?.totalUsers || 0
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.json({ totalRatings: 0, averageRating: '0.0', totalUsers: 0 });
    }
});

// Get top performing AI FAQs (for About page)
app.get('/api/faqs/ai/top', async (req, res) => {
    try {
        const [faqs] = await db.query(`
            SELECT 
                id, 
                question, 
                answer,
                COALESCE(performance_score, 0) as perf_score,
                COALESCE(total_ratings, 0) as total_ratings
            FROM ai_faqs
            ORDER BY performance_score DESC, total_ratings DESC 
            LIMIT 10
        `);
        
        res.json(faqs);
    } catch (error) {
        console.error('Error fetching top AI FAQs:', error);
        res.status(500).json({ error: 'Failed to fetch top FAQs' });
    }
});

// Rating endpoint
app.post('/api/chat/rate-session', authenticateToken, async (req, res) => {
    const { rating, feedback, faqId } = req.body;
    const userId = req.user.id;
    
    console.log(`📝 RATING RECEIVED: user=${userId}, rating=${rating}, faqId=${faqId}`);
    
    if (!rating) {
        return res.status(400).json({ error: 'Rating is required' });
    }
    
    try {
        if (faqId) {
            const [faq] = await db.query(
                'SELECT total_ratings, positive_ratings FROM ai_faqs WHERE id = ?',
                [faqId]
            );
            
            if (faq.length > 0) {
                const currentTotal = faq[0].total_ratings || 0;
                const currentPositive = faq[0].positive_ratings || 0;
                const isPositive = rating >= 4 ? 1 : 0;
                
                const newTotal = currentTotal + 1;
                const newPositive = currentPositive + isPositive;
                const newScore = (newPositive / newTotal) * 100;
                
                await db.query(
                    `UPDATE ai_faqs 
                     SET total_ratings = ?, positive_ratings = ?, performance_score = ? 
                     WHERE id = ?`,
                    [newTotal, newPositive, newScore, faqId]
                );
                
                console.log(`✅ UPDATED FAQ ${faqId}: score=${newScore.toFixed(1)}%`);
            }
        }
        
        const [lastMessages] = await db.query(
            'SELECT id FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
            [userId]
        );
        const messageId = lastMessages.length > 0 ? lastMessages[0].id : null;
        
        await db.query(
            `INSERT INTO answer_ratings (user_id, message_id, faq_id, rating, feedback_text) 
             VALUES (?, ?, ?, ?, ?)`,
            [userId, messageId, faqId || null, rating, feedback || null]
        );
        
        res.json({ success: true, message: 'Rating submitted successfully!' });
    } catch (error) {
        console.error('Rating error:', error);
        res.status(500).json({ error: 'Failed to submit rating' });
    }
});

app.get('/api/ratings/my', authenticateToken, async (req, res) => {
    try {
        const [ratings] = await db.query(
            'SELECT * FROM answer_ratings WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
            [req.user.id]
        );
        res.json(ratings);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch ratings' });
    }
});

// ============ ADMIN ROUTES ============

app.get('/api/admin/users', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const [users] = await db.query('SELECT id, name, email, role, created_at FROM users ORDER BY id DESC');
        res.json(users);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.get('/api/admin/messages', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const [messages] = await db.query(
            'SELECT m.*, u.name, u.email FROM messages m LEFT JOIN users u ON m.user_id = u.id ORDER BY m.id DESC'
        );
        res.json(messages);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.get('/api/admin/tickets', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        const [tickets] = await db.query(
            'SELECT t.*, u.name, u.email FROM tickets t LEFT JOIN users u ON t.user_id = u.id ORDER BY t.id DESC'
        );
        res.json(tickets);
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.put('/api/admin/tickets/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    try {
        await db.query('UPDATE tickets SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
        res.json({ message: 'Ticket updated' });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

app.delete('/api/admin/ratings/:id', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    
    try {
        await db.query('DELETE FROM answer_ratings WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Testimonial deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete rating' });
    }
});

app.get('/api/admin/stats', authenticateToken, async (req, res) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    try {
        const [[userCount], [ratingCount], [avgRating], [messageCount], [ticketCount], [faqCount]] = await Promise.all([
            db.query('SELECT COUNT(*) as count FROM users'),
            db.query('SELECT COUNT(*) as count FROM answer_ratings'),
            db.query('SELECT AVG(rating) as avg FROM answer_ratings'),
            db.query('SELECT COUNT(*) as count FROM messages'),
            db.query('SELECT COUNT(*) as count FROM tickets WHERE status = "open"'),
            db.query('SELECT COUNT(*) as count FROM faqs')
        ]);
        
        res.json({
            totalUsers: userCount[0].count,
            totalRatings: ratingCount[0].count,
            averageRating: parseFloat(avgRating[0].avg || 0).toFixed(1),
            totalMessages: messageCount[0].count,
            openTickets: ticketCount[0].count,
            totalFAQs: faqCount[0].count
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ USER PROFILE ============

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const [users] = await db.query(
            'SELECT id, name, email, role, bio, photo_url, created_at FROM users WHERE id = ?', 
            [req.user.id]
        );
        if (!users.length) return res.status(404).json({ message: 'User not found' });
        res.json(users[0]);
    } catch (err) { 
        res.status(500).json({ message: 'Server error' }); 
    }
});

app.put('/api/auth/profile', authenticateToken, async (req, res) => {
    try {
        const { name, email, bio } = req.body;
        
        if (!name || name.trim() === '') {
            return res.status(400).json({ error: 'Name is required' });
        }
        if (!email || email.trim() === '') {
            return res.status(400).json({ error: 'Email is required' });
        }
        
        const [existing] = await db.query(
            'SELECT id FROM users WHERE email = ? AND id != ?', 
            [email.trim(), req.user.id]
        );
        if (existing.length > 0) {
            return res.status(400).json({ error: 'Email already in use by another account' });
        }
        
        await db.query(
            'UPDATE users SET name = ?, email = ?, bio = ? WHERE id = ?',
            [name.trim(), email.trim(), bio || null, req.user.id]
        );
        
        const [updated] = await db.query(
            'SELECT id, name, email, role, bio, photo_url, created_at FROM users WHERE id = ?', 
            [req.user.id]
        );
        
        res.json(updated[0]);
    } catch (err) { 
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

app.get('/api/tickets/my', authenticateToken, async (req, res) => {
    try {
        const [tickets] = await db.query(
            'SELECT id, issue, status, created_at FROM tickets WHERE user_id = ? ORDER BY created_at DESC',
            [req.user.id]);
        res.json(tickets);
    } catch (err) { 
        res.status(500).json({ message: 'Server error' }); 
    }
});

app.get('/api/messages/my', authenticateToken, async (req, res) => {
    try {
        const [messages] = await db.query(
            'SELECT id, message, response, source, created_at FROM messages WHERE user_id = ? ORDER BY created_at DESC',
            [req.user.id]);
        res.json(messages);
    } catch (err) { 
        res.status(500).json({ message: 'Server error' }); 
    }
});

// ============ PROFILE PHOTO UPLOAD ============

const profileUploadDir = './uploads/profiles';
if (!fs.existsSync(profileUploadDir)) {
    fs.mkdirSync(profileUploadDir, { recursive: true });
    console.log('✅ Created profiles directory');
}

const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, profileUploadDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `user_${req.user.id}_${Date.now()}${ext}`);
    }
});

const profileUpload = multer({ 
    storage: profileStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype && file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});
// ============ FAQ MANAGEMENT ENDPOINTS (ADD THIS SECTION) ============

// Get all FAQs (for admin dashboard)
app.get('/api/faqs', authenticateToken, async (req, res) => {
    try {
        const [faqs] = await db.query('SELECT * FROM faqs ORDER BY id DESC');
        res.json(faqs);
    } catch (error) {
        console.error('Error fetching FAQs:', error);
        res.status(500).json({ error: 'Failed to fetch FAQs' });
    }
});

// Get single FAQ
app.get('/api/faqs/:id', authenticateToken, async (req, res) => {
    try {
        const [faqs] = await db.query('SELECT * FROM faqs WHERE id = ?', [req.params.id]);
        if (faqs.length === 0) return res.status(404).json({ error: 'FAQ not found' });
        res.json(faqs[0]);
    } catch (error) {
        console.error('Error fetching FAQ:', error);
        res.status(500).json({ error: 'Failed to fetch FAQ' });
    }
});

// Add new FAQ
app.post('/api/faqs', authenticateToken, async (req, res) => {
    const { question, answer } = req.body;
    if (!question || !answer) {
        return res.status(400).json({ error: 'Question and answer are required' });
    }
    
    try {
        const [result] = await db.query(
            'INSERT INTO faqs (question, answer) VALUES (?, ?)',
            [question, answer]
        );
        
        // Also add to ai_faqs for better AI responses
        await db.query(
            'INSERT INTO ai_faqs (question, answer, performance_score, total_ratings, positive_ratings) VALUES (?, ?, 85, 0, 0)',
            [question, answer]
        );
        
        res.status(201).json({ 
            success: true, 
            message: 'FAQ added successfully',
            id: result.insertId 
        });
    } catch (error) {
        console.error('Error adding FAQ:', error);
        res.status(500).json({ error: 'Failed to add FAQ' });
    }
});

// Update FAQ
app.put('/api/faqs/:id', authenticateToken, async (req, res) => {
    const { question, answer } = req.body;
    const faqId = req.params.id;
    
    if (!question || !answer) {
        return res.status(400).json({ error: 'Question and answer are required' });
    }
    
    try {
        await db.query(
            'UPDATE faqs SET question = ?, answer = ? WHERE id = ?',
            [question, answer, faqId]
        );
        res.json({ success: true, message: 'FAQ updated successfully' });
    } catch (error) {
        console.error('Error updating FAQ:', error);
        res.status(500).json({ error: 'Failed to update FAQ' });
    }
});

// Delete FAQ
app.delete('/api/faqs/:id', authenticateToken, async (req, res) => {
    const faqId = req.params.id;
    
    try {
        await db.query('DELETE FROM faqs WHERE id = ?', [faqId]);
        res.json({ success: true, message: 'FAQ deleted successfully' });
    } catch (error) {
        console.error('Error deleting FAQ:', error);
        res.status(500).json({ error: 'Failed to delete FAQ' });
    }
});

app.post('/api/auth/upload-photo', authenticateToken, (req, res, next) => {
    profileUpload.single('photo')(req, res, (err) => {
        if (err) {
            console.error('Photo upload error:', err.message);
            return res.status(400).json({ error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const photoUrl = `http://localhost:5000/uploads/profiles/${req.file.filename}`;
        
        await db.query('UPDATE users SET photo_url = ? WHERE id = ?', [photoUrl, req.user.id]);
        
        res.json({ success: true, photo_url: photoUrl });
    } catch (error) {
        console.error('Photo update error:', error);
        res.status(500).json({ error: 'Failed to update profile photo' });
    }
});

app.use('/uploads/profiles', express.static(path.join(__dirname, 'uploads/profiles')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ============ PROXY: Forward chat to Python AI ============
app.post('/api/chat', authenticateToken, async (req, res) => {
    console.log('💬 /api/chat - Forwarding to Python AI');
    try {
        const response = await axios.post('http://127.0.0.1:8000/chat', {
            message: req.body.message,
            session_id: req.body.session_id || null
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000  // Increased from 15000 to 30000 ms
        });
        
        console.log('✅ Python AI response:', response.data);
        res.json(response.data);
    } catch (error) {
        console.error('❌ Python AI error:', error.message);
        res.status(500).json({
            reply: 'AI service is thinking... Please try again in a moment.',
            aiUsed: false,
            ticketCreated: false,
            source: 'error'
        });
    }
});

// ============ CHAT — TEXT ONLY WITH MEMORY (LEVEL 2) ============

app.post('/api/chat/send', authenticateToken, async (req, res) => {
    const { message } = req.body;
    const userId = req.user.id;
    
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    try {
        // Get or create session
        let sessionId = activeSessions.get(userId);
        if (!sessionId) {
            sessionId = conversationMemory.generateSessionId(userId);
            activeSessions.set(userId, sessionId);
        }
        
        // Save user message to conversation history
        await conversationMemory.saveMessage(userId, sessionId, 'user', message);
        
        // Get conversation context
        const { context, historyCount } = await conversationMemory.getFormattedContext(userId, sessionId);
        
        console.log(`📚 Conversation context for user ${userId}:`);
        console.log(`   Session: ${sessionId}`);
        console.log(`   History count: ${historyCount} messages`);
        
        let response, ticketCreated = false, ticketId = null, source = 'ai';
        let usedFaqId = null;
        
        // FIRST: Check regular FAQs
        const [faqs] = await db.query(
            `SELECT * FROM faqs
             WHERE LOWER(question) LIKE LOWER(?)
             OR LOWER(?) LIKE CONCAT('%', LOWER(question), '%')
             LIMIT 1`,
            [`%${message}%`, message]
        );
        
        if (faqs.length > 0) {
            response = faqs[0].answer;
            source = 'faq';
            usedFaqId = faqs[0].id;
        } else {
            // SECOND: Check AI FAQs
            const [aiFaqs] = await db.query(
                `SELECT id, answer FROM ai_faqs
                 WHERE LOWER(question) LIKE LOWER(?)
                 LIMIT 1`,
                [`%${message}%`]
            );
            
            if (aiFaqs.length > 0) {
                response = aiFaqs[0].answer;
                source = 'ai_faq';
                usedFaqId = aiFaqs[0].id;
            } else {
                // THIRD: Try Python AI with longer timeout
                try {
                    const aiRequest = {
                        message: message,
                        context: context,
                        has_context: historyCount > 0,
                        session_id: sessionId
                    };
                    
                    console.log(`🤖 Sending to Python AI: ${message.substring(0, 50)}...`);
                    
                    const aiReply = await axios.post('http://127.0.0.1:8000/chat-with-context', aiRequest, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 30000  // Increased timeout
                    });
                    
                    if (aiReply.data && aiReply.data.reply) {
                        response = aiReply.data.reply;
                        source = 'ai';
                        usedFaqId = aiReply.data.faqId || null;
                        console.log(`✅ Python AI responded successfully`);
                    } else {
                        throw new Error('No response from AI');
                    }
                } catch (aiError) {
                    console.error('AI error, falling back to FAQ:', aiError.message);
                    
                    // FOURTH: Try fallback to AI FAQ matching again with broader search
                    const [fallbackFaqs] = await db.query(
                        `SELECT answer FROM ai_faqs
                         WHERE LOWER(question) LIKE LOWER(?)
                         OR LOWER(?) LIKE CONCAT('%', LOWER(question), '%')
                         LIMIT 1`,
                        [`%${message.split(' ')[0]}%`, message]
                    );
                    
                    if (fallbackFaqs.length > 0) {
                        response = fallbackFaqs[0].answer;
                        source = 'ai_faq_fallback';
                    } else {
                        // LAST: Create ticket only as last resort
                        const [result] = await db.query(
                            'INSERT INTO tickets (user_id, issue, status) VALUES (?, ?, ?)',
                            [userId, message, 'open']
                        );
                        ticketId = result.insertId;
                        ticketCreated = true;
                        source = 'ticket';
                        response = `I wasn't able to find an answer. Ticket #${ticketId} created — our team will follow up shortly!`;
                    }
                }
            }
        }
        
        // Save assistant response to conversation history
        await conversationMemory.saveMessage(userId, sessionId, 'assistant', response, { source, faqId: usedFaqId });
        
        // Save to messages table for compatibility
        const [result] = await db.query(
            'INSERT INTO messages (user_id, message, response, source, faq_id) VALUES (?, ?, ?, ?, ?)',
            [userId, message, response, source, usedFaqId]
        );
        
        res.json({ 
            success: true, 
            response, 
            ticketCreated, 
            ticketId, 
            source,
            messageId: result.insertId,
            faqId: usedFaqId,
            sessionId,
            historyCount: historyCount + 1
        });
    } catch (err) {
        console.error('Chat error:', err);
        res.status(500).json({ error: 'Failed to process message' });
    }
});

// Clear ALL chat history for the user
app.delete('/api/conversations/clear-all', authenticateToken, async (req, res) => {
    const userId = req.user.id;
    
    try {
        // Delete all conversations for this user
        const [result] = await db.query(
            'DELETE FROM conversations WHERE user_id = ?',
            [userId]
        );
        
        // Also clear active session
        if (activeSessions.has(userId)) {
            activeSessions.delete(userId);
        }
        
        console.log(`✅ Cleared all chat history for user ${userId}, deleted ${result.affectedRows} conversations`);
        
        res.json({ 
            success: true, 
            message: 'All chat history cleared successfully',
            deletedCount: result.affectedRows
        });
    } catch (error) {
        console.error('Error clearing chat history:', error);
        res.status(500).json({ error: 'Failed to clear chat history' });
    }
});

// ============ CHAT WITH FILE UPLOAD ============
app.post('/api/chat/send-with-file', authenticateToken, upload.single('file'), async (req, res) => {
    const { message } = req.body;
    const userId = req.user.id;
    const file = req.file;
    
    console.log(`📎 File upload request from user ${userId}`);
    console.log(`   Message: ${message || '(no text)'}`);
    console.log(`   File: ${file ? file.originalname : 'none'}`);
    
    if (!file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    try {
        let sessionId = activeSessions.get(userId);
        if (!sessionId) {
            sessionId = conversationMemory.generateSessionId(userId);
            activeSessions.set(userId, sessionId);
        }
        
        const userMessageText = message || `[Uploaded file: ${file.originalname}]`;
        await conversationMemory.saveMessage(userId, sessionId, 'user', userMessageText, { hasFile: true, fileName: file.originalname });
        
        let response, ticketCreated = false, ticketId = null, source = 'ai';
        let usedFaqId = null;
        
        try {
            const formData = new FormData();
            formData.append('file', fs.createReadStream(file.path), {
                filename: file.originalname,
                contentType: file.mimetype
            });
            if (message) {
                formData.append('message', message);
            }
            
            const pythonResponse = await axios.post('http://127.0.0.1:8000/process-file', formData, {
                headers: { ...formData.getHeaders() },
                timeout: 30000
            });
            
            if (pythonResponse.data && pythonResponse.data.reply) {
                response = pythonResponse.data.reply;
                usedFaqId = pythonResponse.data.faqId || null;
                source = 'ai';
            } else {
                throw new Error('No response from AI');
            }
        } catch (aiError) {
            console.error('Python AI file processing error:', aiError.message);
            const [faqs] = await db.query(
                `SELECT * FROM faqs WHERE LOWER(question) LIKE LOWER(?) LIMIT 1`,
                [`%${message || file.originalname}%`]
            );
            
            if (faqs.length > 0) {
                response = faqs[0].answer;
                source = 'faq';
            } else {
                const [result] = await db.query(
                    'INSERT INTO tickets (user_id, issue, status) VALUES (?, ?, ?)',
                    [userId, `File: ${file.originalname}`, 'open']
                );
                ticketId = result.insertId;
                ticketCreated = true;
                response = `I've received your file "${file.originalname}". Ticket #${ticketId} has been created — our team will review it shortly!`;
                source = 'ticket';
            }
        }
        
        await conversationMemory.saveMessage(userId, sessionId, 'assistant', response, { source, faqId: usedFaqId, hasFile: true });
        
        await db.query(
            'INSERT INTO messages (user_id, message, response, source, faq_id) VALUES (?, ?, ?, ?, ?)',
            [userId, userMessageText, response, source, usedFaqId]
        );
        
        cleanup(file.path);
        
        res.json({ 
            success: true, 
            response, 
            ticketCreated, 
            ticketId, 
            source,
            faqId: usedFaqId,
            sessionId
        });
    } catch (err) {
        console.error('Chat with file error:', err);
        if (file && file.path) cleanup(file.path);
        res.status(500).json({ error: 'Failed to process file: ' + err.message });
    }
});

// ============ TRANSCRIBE AUDIO ENDPOINT ============
app.post('/api/transcribe-audio', authenticateToken, audioUpload.single('file'), async (req, res) => {
    console.log(`🎤 Audio transcription request from user ${req.user.id}`);
    
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No audio file provided' });
    }
    
    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(req.file.path), {
            filename: req.file.originalname,
            contentType: req.file.mimetype
        });
        
        const pythonResponse = await axios.post('http://127.0.0.1:8000/transcribe-audio', formData, {
            headers: { ...formData.getHeaders() },
            timeout: 30000
        });
        
        cleanup(req.file.path);
        
        if (pythonResponse.data && pythonResponse.data.success) {
            res.json({
                success: true,
                text: pythonResponse.data.text,
                message: 'Transcribed successfully'
            });
        } else {
            res.json({
                success: false,
                text: '',
                message: pythonResponse.data?.message || 'Could not transcribe audio'
            });
        }
    } catch (error) {
        console.error('Transcription error:', error.message);
        cleanup(req.file.path);
        res.json({
            success: false,
            text: '',
            message: 'Transcription service error. Please try typing your message.'
        });
    }
});

// ============ HEALTH CHECK ============

app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ============ START SERVER ============

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`\n📚 Level 2 Features:`);
    console.log(`   ✅ Conversation Memory (Contextual AI)`);
    console.log(`   ✅ Session Management`);
    console.log(`   ✅ Chat History View`);
    console.log(`   ✅ Session Clear/Delete`);
    console.log(`\n📚 About Page Endpoints:`);
    console.log(`   GET  /api/ratings/reviews - User reviews`);
    console.log(`   GET  /api/ratings/stats - Rating statistics`);
    console.log(`   GET  /api/faqs/ai/top - Top performing FAQs`);
    console.log(`\n💬 Conversation Endpoints:`);
    console.log(`   GET  /api/conversations/sessions - List all chat sessions`);
    console.log(`   GET  /api/conversations/session/:sessionId - Get session details`);
    console.log(`   GET  /api/conversations/current - Get current session`);
    console.log(`   DELETE /api/conversations/clear - Clear current session`);
    console.log(`   DELETE /api/conversations/session/:sessionId - Delete a session`);
    console.log(`\n🤖 Python AI on port 8000`);
    console.log(`\n⏱️  Timeout increased to 30 seconds for Llama 3.2 responses`);
});