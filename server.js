require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// ==================== التهيئة التلقائية ====================
console.log('🚀 بدء تشغيل نظام QR SaaS...');

// إنشاء المجلدات تلقائياً
const folders = ['uploads', 'uploads/qr-codes', 'logs', 'backups'];
folders.forEach(folder => {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
        console.log(`📁 تم إنشاء مجلد: ${folder}`);
    }
});

// إنشاء قاعدة البيانات تلقائياً
let db;
const dbPath = './qr-saas.db';
const isFirstRun = !fs.existsSync(dbPath);

db = new Database(dbPath);
console.log('✅ قاعدة البيانات جاهزة');

// إنشاء الجداول تلقائياً
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        role TEXT DEFAULT 'user',
        qr_limit INTEGER DEFAULT 10,
        qr_used INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
    );
    
    CREATE TABLE IF NOT EXISTS qr_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT DEFAULT 'text',
        size INTEGER DEFAULT 200,
        color TEXT DEFAULT '#000000',
        bg_color TEXT DEFAULT '#ffffff',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    
    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    
    CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        action TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// إدخال المسؤول الافتراضي تلقائياً عند التشغيل الأول
if (isFirstRun) {
    console.log('🎉 التشغيل الأول! جاري تهيئة النظام...');
    
    const hashedPassword = bcrypt.hashSync('admin123', 10);
    const adminId = uuidv4();
    
    db.prepare(`
        INSERT INTO users (id, email, password, name, role, qr_limit)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(adminId, 'admin@qr.com', hashedPassword, 'المسؤول', 'admin', 999999);
    
    db.prepare(`
        INSERT INTO system_settings (key, value) VALUES 
        ('system_name', 'QR Code SaaS'),
        ('default_qr_limit', '10'),
        ('allow_registration', 'true'),
        ('daily_qr_limit', '50'),
        ('jwt_secret', 'change-this-in-production')
    `).run();
    
    console.log('✅ تم إنشاء المسؤول الافتراضي');
    console.log('📧 البريد: admin@qr.com');
    console.log('🔐 كلمة المرور: admin123');
}

// ==================== إعداد Express ====================
const app = express();

// Middleware الأمان
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'لقد تجاوزت الحد المسموح من الطلبات' }
});
app.use('/api/', limiter);

// Middleware المصادقة
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: 'الوصول مرفوض' });
    
    jwt.verify(token, process.env.JWT_SECRET || 'secret', (err, user) => {
        if (err) return res.status(403).json({ error: 'التوكن غير صالح' });
        req.user = user;
        next();
    });
}

// Middleware للتحقق من الصلاحيات
function isAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'غير مصرح للمستخدمين العاديين' });
    }
    next();
}

// ==================== مسارات API ====================

// 1. تسجيل الدخول
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (!user) return res.status(400).json({ error: 'المستخدم غير موجود' });
        
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) return res.status(400).json({ error: 'كلمة المرور خاطئة' });
        
        // تحديث آخر تسجيل دخول
        db.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?').run(user.id);
        
        // تسجيل النشاط
        db.prepare(`
            INSERT INTO activity_logs (id, user_id, action, details, ip_address, user_agent)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), user.id, 'login', 'تسجيل دخول', req.ip, req.get('User-Agent'));
        
        const token = jwt.sign(
            { 
                id: user.id, 
                email: user.email, 
                role: user.role,
                name: user.name 
            }, 
            process.env.JWT_SECRET || 'secret',
            { expiresIn: '7d' }
        );
        
        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                qr_limit: user.qr_limit,
                qr_used: user.qr_used,
                remaining: user.qr_limit - user.qr_used
            }
        });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// 2. إنشاء QR Code
app.post('/api/qr/generate', authenticateToken, async (req, res) => {
    try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
        
        // التحقق من الحد
        if (user.qr_used >= user.qr_limit) {
            return res.status(403).json({ 
                error: 'لقد وصلت للحد الأقصى!',
                limit: user.qr_limit,
                used: user.qr_used
            });
        }
        
        const { content, type = 'text', size = 200, color = '#000000', bgColor = '#ffffff' } = req.body;
        
        if (!content) {
            return res.status(400).json({ error: 'المحتوى مطلوب' });
        }
        
        // توليد QR
        const qrDataURL = await QRCode.toDataURL(content, {
            width: Math.min(parseInt(size), 1000),
            color: { dark: color, light: bgColor },
            margin: 1,
            errorCorrectionLevel: 'H'
        });
        
        // حفظ في قاعدة البيانات
        const qrId = uuidv4();
        db.prepare(`
            INSERT INTO qr_codes (id, user_id, content, type, size, color, bg_color)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(qrId, user.id, content, type, size, color, bgColor);
        
        // تحديث العداد
        db.prepare('UPDATE users SET qr_used = qr_used + 1 WHERE id = ?').run(user.id);
        
        // تسجيل النشاط
        db.prepare(`
            INSERT INTO activity_logs (id, user_id, action, details, ip_address, user_agent)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(uuidv4(), user.id, 'qr_generated', `إنشاء QR: ${type}`, req.ip, req.get('User-Agent'));
        
        res.json({
            success: true,
            qr: {
                id: qrId,
                data_url: qrDataURL,
                content,
                type,
                size,
                color,
                bg_color: bgColor
            },
            remaining: user.qr_limit - user.qr_used - 1
        });
        
    } catch (error) {
        res.status(500).json({ error: 'فشل في إنشاء QR Code' });
    }
});

// 3. إدارة المستخدمين (للمسؤول)
app.get('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
    try {
        const users = db.prepare(`
            SELECT id, email, name, role, qr_limit, qr_used, status, created_at, last_login
            FROM users ORDER BY created_at DESC
        `).all();
        
        res.json({
            success: true,
            users: users.map(user => ({
                ...user,
                remaining: user.qr_limit - user.qr_used
            }))
        });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
    }
});

app.post('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { email, password, name, role = 'user', qr_limit = 10 } = req.body;
        
        // التحقق من البريد
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existing) {
            return res.status(400).json({ error: 'البريد الإلكتروني موجود مسبقاً' });
        }
        
        // إنشاء المستخدم
        const userId = uuidv4();
        const hashedPassword = await bcrypt.hash(password, 10);
        
        db.prepare(`
            INSERT INTO users (id, email, password, name, role, qr_limit)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(userId, email, hashedPassword, name, role, qr_limit);
        
        res.json({
            success: true,
            message: 'تم إنشاء المستخدم بنجاح',
            user_id: userId
        });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في إنشاء المستخدم' });
    }
});

app.put('/api/admin/users/:id', authenticateToken, isAdmin, (req, res) => {
    try {
        const { qr_limit, role, status } = req.body;
        const userId = req.params.id;
        
        db.prepare(`
            UPDATE users SET qr_limit = ?, role = ?, status = ? WHERE id = ?
        `).run(qr_limit, role, status, userId);
        
        res.json({ success: true, message: 'تم تحديث المستخدم' });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في تحديث المستخدم' });
    }
});

// 4. بيانات المستخدم
app.get('/api/user/profile', authenticateToken, (req, res) => {
    try {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
        
        const today = new Date().toISOString().split('T')[0];
        const todayQRs = db.prepare(`
            SELECT COUNT(*) as count FROM qr_codes 
            WHERE user_id = ? AND DATE(created_at) = ?
        `).get(req.user.id, today).count;
        
        res.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
                qr_limit: user.qr_limit,
                qr_used: user.qr_used,
                remaining: user.qr_limit - user.qr_used,
                today_qrs: todayQRs
            }
        });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب البيانات' });
    }
});

// 5. قائمة QR Codes
app.get('/api/user/qrcodes', authenticateToken, (req, res) => {
    try {
        const qrcodes = db.prepare(`
            SELECT * FROM qr_codes 
            WHERE user_id = ? 
            ORDER BY created_at DESC
        `).all(req.user.id);
        
        res.json({
            success: true,
            qrcodes,
            total: qrcodes.length
        });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب البيانات' });
    }
});

// 6. تحميل QR
app.get('/api/qr/:id/download', authenticateToken, async (req, res) => {
    try {
        const qr = db.prepare('SELECT * FROM qr_codes WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
        
        if (!qr) {
            return res.status(404).json({ error: 'QR غير موجود' });
        }
        
        const qrBuffer = await QRCode.toBuffer(qr.content, {
            width: qr.size,
            color: { dark: qr.color, light: qr.bg_color }
        });
        
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `attachment; filename="qr-${qr.id}.png"`);
        res.send(qrBuffer);
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في التحميل' });
    }
});

// 7. إحصائيات النظام
app.get('/api/admin/stats', authenticateToken, isAdmin, (req, res) => {
    try {
        const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
        const totalQRs = db.prepare('SELECT COUNT(*) as count FROM qr_codes').get().count;
        
        const today = new Date().toISOString().split('T')[0];
        const todayQRs = db.prepare('SELECT COUNT(*) as count FROM qr_codes WHERE DATE(created_at) = ?').get(today).count;
        const todayUsers = db.prepare('SELECT COUNT(*) as count FROM users WHERE DATE(created_at) = ?').get(today).count;
        
        res.json({
            success: true,
            stats: {
                total_users: totalUsers,
                total_qrs: totalQRs,
                today_qrs: todayQRs,
                today_users: todayUsers
            }
        });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
    }
});

// 8. إعدادات النظام
app.get('/api/admin/settings', authenticateToken, isAdmin, (req, res) => {
    try {
        const settings = db.prepare('SELECT * FROM system_settings').all();
        const settingsObj = {};
        
        settings.forEach(setting => {
            settingsObj[setting.key] = setting.value;
        });
        
        res.json({ success: true, settings: settingsObj });
        
    } catch (error) {
        res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
    }
});

// 9. صحة النظام
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: 'connected',
        uptime: process.uptime()
    });
});

// ==================== تشغيل الخادم ====================
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
║      🚀 نظام QR SaaS يعمل الآن!     ║
╠══════════════════════════════════════╣
║ 🌐 المنفذ: ${PORT}                   ║
║ 👑 لوحة الإدارة: /admin.html         ║
║ 👤 تطبيق المستخدم: /user.html        ║
╠══════════════════════════════════════╣
║ ${isFirstRun ? '🎉 التشغيل الأول!' : '✅ النظام جاهز'} ║
╚══════════════════════════════════════╝
    `);
});
