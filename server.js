require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const moment = require('moment');
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

// قاعدة البيانات
let db;
const dbPath = './qr-saas.db';
const isFirstRun = !fs.existsSync(dbPath);

// إنشاء جداول قاعدة البيانات
function createTables() {
    return new Promise((resolve, reject) => {
        const queries = [
            `CREATE TABLE IF NOT EXISTS users (
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
            )`,
            
            `CREATE TABLE IF NOT EXISTS qr_codes (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                content TEXT NOT NULL,
                type TEXT DEFAULT 'text',
                size INTEGER DEFAULT 200,
                color TEXT DEFAULT '#000000',
                bg_color TEXT DEFAULT '#ffffff',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )`,
            
            `CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )`,
            
            `CREATE TABLE IF NOT EXISTS activity_logs (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                action TEXT,
                details TEXT,
                ip_address TEXT,
                user_agent TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        ];
        
        let completed = 0;
        queries.forEach((query, index) => {
            db.run(query, (err) => {
                if (err) {
                    console.error(`❌ خطأ في إنشاء الجدول ${index + 1}:`, err.message);
                    reject(err);
                } else {
                    completed++;
                    if (completed === queries.length) {
                        console.log('✅ تم إنشاء الجداول تلقائياً');
                        resolve();
                    }
                }
            });
        });
    });
}

// إدخال البيانات الافتراضية
function insertDefaultData() {
    return new Promise((resolve, reject) => {
        // إدخال المسؤول الافتراضي
        bcrypt.hash('admin123', 10, (err, hashedPassword) => {
            if (err) {
                reject(err);
                return;
            }
            
            const adminId = uuidv4();
            const queries = [
                `INSERT OR REPLACE INTO users (id, email, password, name, role, qr_limit) 
                 VALUES (?, ?, ?, ?, ?, ?)`,
                `INSERT OR IGNORE INTO system_settings (key, value) VALUES 
                 ('system_name', 'QR Code SaaS'),
                 ('default_qr_limit', '10'),
                 ('allow_registration', 'true'),
                 ('daily_qr_limit', '50')`
            ];
            
            const params = [
                [adminId, 'admin@qr.com', hashedPassword, 'المسؤول', 'admin', 999999]
            ];
            
            let completed = 0;
            queries.forEach((query, index) => {
                db.run(query, ...params[index] || [], function(err) {
                    if (err) {
                        console.error(`❌ خطأ في إدخال البيانات ${index + 1}:`, err.message);
                        reject(err);
                    } else {
                        completed++;
                        if (completed === queries.length) {
                            console.log('✅ تم إدخال البيانات الافتراضية تلقائياً');
                            console.log('🔐 بيانات المسؤول: admin@qr.com / admin123');
                            resolve();
                        }
                    }
                });
            });
        });
    });
}

// تهيئة قاعدة البيانات
function initDB() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('❌ خطأ في فتح قاعدة البيانات:', err.message);
                reject(err);
            } else {
                console.log('✅ قاعدة البيانات متصلة بنجاح');
                
                // تمكين المفاتيح الأجنبية
                db.run('PRAGMA foreign_keys = ON');
                
                createTables()
                    .then(() => {
                        if (isFirstRun) {
                            return insertDefaultData();
                        }
                    })
                    .then(() => {
                        console.log('🎉 قاعدة البيانات جاهزة للاستخدام');
                        resolve();
                    })
                    .catch(reject);
            }
        });
    });
}

// ==================== إعداد Express ====================
const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Middleware الأمان
app.use(helmet({
    contentSecurityPolicy: false // يمكن تفعيله لاحقاً
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate Limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: 100,
    message: { error: 'لقد تجاوزت الحد المسموح من الطلبات' }
});
app.use('/api/', apiLimiter);

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

// ==================== دوال مساعدة للقاعدة البيانات ====================
function dbGet(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function dbRun(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

// ==================== مسارات API ====================

// 1. تسجيل الدخول
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const user = await dbGet('SELECT * FROM users WHERE email = ? AND status = ?', [email, 'active']);
        if (!user) {
            return res.status(400).json({ error: 'المستخدم غير موجود' });
        }
        
        const validPass = await bcrypt.compare(password, user.password);
        if (!validPass) {
            return res.status(400).json({ error: 'كلمة المرور خاطئة' });
        }
        
        // تحديث آخر تسجيل دخول
        await dbRun('UPDATE users SET last_login = datetime("now") WHERE id = ?', [user.id]);
        
        // تسجيل النشاط
        await dbRun(
            'INSERT INTO activity_logs (id, user_id, action, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
            [uuidv4(), user.id, 'login', 'تسجيل دخول', req.ip, req.get('User-Agent')]
        );
        
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
        console.error('Login error:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// 2. إنشاء QR Code
app.post('/api/qr/generate', authenticateToken, async (req, res) => {
    try {
        const user = await dbGet('SELECT * FROM users WHERE id = ? AND status = ?', [req.user.id, 'active']);
        
        if (!user) {
            return res.status(404).json({ error: 'الحساب غير نشط أو غير موجود' });
        }
        
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
        await dbRun(
            'INSERT INTO qr_codes (id, user_id, content, type, size, color, bg_color) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [qrId, user.id, content, type, size, color, bgColor]
        );
        
        // تحديث العداد
        await dbRun('UPDATE users SET qr_used = qr_used + 1 WHERE id = ?', [user.id]);
        
        // تسجيل النشاط
        await dbRun(
            'INSERT INTO activity_logs (id, user_id, action, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
            [uuidv4(), user.id, 'qr_generated', `إنشاء QR: ${type}`, req.ip, req.get('User-Agent')]
        );
        
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
        console.error('Generate QR error:', error);
        res.status(500).json({ error: 'فشل في إنشاء QR Code' });
    }
});

// 3. بيانات المستخدم
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const user = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
        
        const today = moment().format('YYYY-MM-DD');
        const todayQRs = await dbGet(
            'SELECT COUNT(*) as count FROM qr_codes WHERE user_id = ? AND DATE(created_at) = ?',
            [req.user.id, today]
        );
        
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
                today_qrs: todayQRs.count || 0
            }
        });
        
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: 'خطأ في جلب البيانات' });
    }
});

// 4. قائمة QR Codes الخاصة بالمستخدم
app.get('/api/user/qrcodes', authenticateToken, async (req, res) => {
    try {
        const { page = 1, limit = 20, type, sort = 'newest' } = req.query;
        const offset = (parseInt(page) - 1) * parseInt(limit);
        
        let query = 'SELECT * FROM qr_codes WHERE user_id = ?';
        let params = [req.user.id];
        
        if (type && type !== 'all') {
            query += ' AND type = ?';
            params.push(type);
        }
        
        // الترتيب
        const sortMap = {
            'newest': 'created_at DESC',
            'oldest': 'created_at ASC',
            'size_asc': 'size ASC',
            'size_desc': 'size DESC'
        };
        
        query += ` ORDER BY ${sortMap[sort] || 'created_at DESC'}`;
        query += ' LIMIT ? OFFSET ?';
        params.push(parseInt(limit), offset);
        
        const qrCodes = await dbAll(query, params);
        const total = await dbGet('SELECT COUNT(*) as count FROM qr_codes WHERE user_id = ?', [req.user.id]);
        
        res.json({
            success: true,
            qr_codes: qrCodes,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: total.count,
                pages: Math.ceil(total.count / parseInt(limit))
            }
        });
        
    } catch (error) {
        console.error('List QR error:', error);
        res.status(500).json({ error: 'خطأ في جلب البيانات' });
    }
});

// 5. تحميل QR
app.get('/api/qr/:id/download', authenticateToken, async (req, res) => {
    try {
        const qr = await dbGet('SELECT * FROM qr_codes WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        
        if (!qr) {
            return res.status(404).json({ error: 'QR غير موجود' });
        }
        
        const qrBuffer = await QRCode.toBuffer(qr.content, {
            width: qr.size,
            color: { dark: qr.color, light: qr.bg_color }
        });
        
        // تسجيل النشاط
        await dbRun(
            'INSERT INTO activity_logs (id, user_id, action, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
            [uuidv4(), req.user.id, 'qr_downloaded', `تحميل QR: ${qr.id}`, req.ip, req.get('User-Agent')]
        );
        
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', `attachment; filename="qr-${qr.id}.png"`);
        res.send(qrBuffer);
        
    } catch (error) {
        console.error('Download QR error:', error);
        res.status(500).json({ error: 'خطأ في التحميل' });
    }
});

// 6. حذف QR
app.delete('/api/qr/:id', authenticateToken, async (req, res) => {
    try {
        const qr = await dbGet('SELECT * FROM qr_codes WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        
        if (!qr) {
            return res.status(404).json({ error: 'QR غير موجود' });
        }
        
        await dbRun('DELETE FROM qr_codes WHERE id = ?', [req.params.id]);
        
        // تحديث العداد
        await dbRun('UPDATE users SET qr_used = GREATEST(qr_used - 1, 0) WHERE id = ?', [req.user.id]);
        
        // تسجيل النشاط
        await dbRun(
            'INSERT INTO activity_logs (id, user_id, action, details, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
            [uuidv4(), req.user.id, 'qr_deleted', `حذف QR: ${qr.id}`, req.ip, req.get('User-Agent')]
        );
        
        res.json({ success: true, message: 'تم حذف QR Code بنجاح' });
        
    } catch (error) {
        console.error('Delete QR error:', error);
        res.status(500).json({ error: 'خطأ في حذف البيانات' });
    }
});

// 7. تسجيل مستخدم جديد
app.post('/api/auth/register', async (req, res) => {
    try {
        const settings = await dbGet("SELECT value FROM system_settings WHERE key = 'allow_registration'");
        if (!settings || settings.value !== 'true') {
            return res.status(403).json({ error: 'التسجيل مغلق حالياً' });
        }
        
        const { email, password, name } = req.body;
        
        if (!email || !password || !name) {
            return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
        }
        
        // التحقق من عدم وجود المستخدم مسبقاً
        const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
        if (existing) {
            return res.status(400).json({ error: 'البريد الإلكتروني مسجل مسبقاً' });
        }
        
        // تشفير كلمة المرور
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // الحصول على الحد الافتراضي
        const defaultLimit = await dbGet("SELECT value FROM system_settings WHERE key = 'default_qr_limit'");
        const qrLimit = defaultLimit ? parseInt(defaultLimit.value) : 10;
        
        // إدخال المستخدم الجديد
        const userId = uuidv4();
        await dbRun(
            'INSERT INTO users (id, email, password, name, role, qr_limit) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, email, hashedPassword, name, 'user', qrLimit]
        );
        
        res.status(201).json({
            success: true,
            message: 'تم إنشاء الحساب بنجاح، يمكنك تسجيل الدخول الآن'
        });
        
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'خطأ في إنشاء الحساب' });
    }
});

// 8. تحديث الملف الشخصي
app.put('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const { name, currentPassword, newPassword } = req.body;
        
        if (newPassword) {
            if (!currentPassword) {
                return res.status(400).json({ error: 'كلمة المرور الحالية مطلوبة' });
            }
            
            const user = await dbGet('SELECT password FROM users WHERE id = ?', [req.user.id]);
            const validPass = await bcrypt.compare(currentPassword, user.password);
            
            if (!validPass) {
                return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
            }
            
            const hashedPassword = await bcrypt.hash(newPassword, 10);
            await dbRun('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.user.id]);
        }
        
        if (name) {
            await dbRun('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
        }
        
        res.json({ success: true, message: 'تم تحديث الملف الشخصي بنجاح' });
        
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ error: 'خطأ في تحديث البيانات' });
    }
});

// ==================== مسارات الإدارة (للمسؤولين فقط) ====================

// 9. إحصائيات النظام
app.get('/api/admin/stats', authenticateToken, isAdmin, async (req, res) => {
    try {
        const totalUsers = await dbGet('SELECT COUNT(*) as count FROM users');
        const totalQRs = await dbGet('SELECT COUNT(*) as count FROM qr_codes');
        
        const today = moment().format('YYYY-MM-DD');
        const todayQRs = await dbGet('SELECT COUNT(*) as count FROM qr_codes WHERE DATE(created_at) = ?', [today]);
        const todayUsers = await dbGet('SELECT COUNT(*) as count FROM users WHERE DATE(created_at) = ?', [today]);
        const activeUsers = await dbGet('SELECT COUNT(DISTINCT user_id) as count FROM qr_codes WHERE DATE(created_at) = ?', [today]);
        
        res.json({
            success: true,
            stats: {
                total_users: totalUsers.count,
                total_qrs: totalQRs.count,
                today_qrs: todayQRs.count,
                today_users: todayUsers.count,
                active_users: activeUsers.count || 0
            }
        });
        
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: 'خطأ في جلب الإحصائيات' });
    }
});

// 10. إدارة المستخدمين
app.get('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
    try {
        const users = await dbAll(
            'SELECT id, email, name, role, qr_limit, qr_used, status, created_at, last_login FROM users ORDER BY created_at DESC'
        );
        
        res.json({
            success: true,
            users: users.map(user => ({
                ...user,
                remaining: user.qr_limit - user.qr_used
            }))
        });
        
    } catch (error) {
        console.error('Admin users error:', error);
        res.status(500).json({ error: 'خطأ في جلب المستخدمين' });
    }
});

app.post('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { email, password, name, role = 'user', qr_limit = 10 } = req.body;
        
        const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
        if (existing) {
            return res.status(400).json({ error: 'البريد الإلكتروني موجود مسبقاً' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const userId = uuidv4();
        
        await dbRun(
            'INSERT INTO users (id, email, password, name, role, qr_limit) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, email, hashedPassword, name, role, qr_limit]
        );
        
        res.json({
            success: true,
            message: 'تم إنشاء المستخدم بنجاح',
            user_id: userId
        });
        
    } catch (error) {
        console.error('Create user error:', error);
        res.status(500).json({ error: 'خطأ في إنشاء المستخدم' });
    }
});

app.put('/api/admin/users/:id', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { qr_limit, role, status } = req.body;
        const userId = req.params.id;
        
        await dbRun(
            'UPDATE users SET qr_limit = ?, role = ?, status = ? WHERE id = ?',
            [qr_limit, role, status, userId]
        );
        
        res.json({ success: true, message: 'تم تحديث المستخدم' });
        
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ error: 'خطأ في تحديث المستخدم' });
    }
});

// 11. عرض جميع رموز QR
app.get('/api/admin/qrcodes', authenticateToken, isAdmin, async (req, res) => {
    try {
        const { user_id, type } = req.query;
        
        let query = `
            SELECT q.*, u.email, u.name as user_name
            FROM qr_codes q
            LEFT JOIN users u ON q.user_id = u.id
            WHERE 1=1
        `;
        let params = [];
        
        if (user_id) {
            query += ' AND q.user_id = ?';
            params.push(user_id);
        }
        
        if (type && type !== 'all') {
            query += ' AND q.type = ?';
            params.push(type);
        }
        
        query += ' ORDER BY q.created_at DESC';
        
        const qrCodes = await dbAll(query, params);
        
        res.json({
            success: true,
            qr_codes: qrCodes
        });
        
    } catch (error) {
        console.error('Admin QR codes error:', error);
        res.status(500).json({ error: 'خطأ في جلب بيانات QR Codes' });
    }
});

// 12. إعدادات النظام
app.get('/api/admin/settings', authenticateToken, isAdmin, async (req, res) => {
    try {
        const settings = await dbAll('SELECT * FROM system_settings');
        const settingsObj = {};
        
        settings.forEach(setting => {
            settingsObj[setting.key] = setting.value;
        });
        
        res.json({ success: true, settings: settingsObj });
        
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'خطأ في جلب الإعدادات' });
    }
});

app.put('/api/admin/settings', authenticateToken, isAdmin, async (req, res) => {
    try {
        const settings = req.body;
        
        for (const [key, value] of Object.entries(settings)) {
            await dbRun(
                'INSERT OR REPLACE INTO system_settings (key, value) VALUES (?, ?)',
                [key, value]
            );
        }
        
        res.json({ 
            success: true, 
            message: 'تم حفظ الإعدادات بنجاح' 
        });
        
    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({ error: 'خطأ في حفظ الإعدادات' });
    }
});

// 13. صحة النظام
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        database: db ? 'connected' : 'disconnected',
        uptime: process.uptime()
    });
});

// ==================== معالجة الأخطاء ====================
app.use((req, res) => {
    res.status(404).json({ 
        error: 'الصفحة غير موجودة',
        path: req.path,
        method: req.method 
    });
});

app.use((err, req, res, next) => {
    console.error('🚨 Server error:', err);
    
    // تسجيل الخطأ
    const errorLog = {
        timestamp: new Date().toISOString(),
        method: req.method,
        url: req.url,
        ip: req.ip,
        error: err.message
    };
    
    if (NODE_ENV === 'production') {
        fs.appendFileSync('logs/errors.log', JSON.stringify(errorLog) + '\n');
    }
    
    res.status(500).json({
        error: 'حدث خطأ في الخادم',
        ...(NODE_ENV === 'development' && { details: err.message })
    });
});

// ==================== تشغيل الخادم ====================
async function startServer() {
    try {
        await initDB();
        
        // تقديم الملفات الثابتة
        app.use(express.static('public', {
            maxAge: NODE_ENV === 'production' ? '1d' : 0
        }));
        
        // صفحة البداية
        app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'user.html'));
        });
        
        // تشغيل الخادم
        app.listen(PORT, () => {
            console.log(`
╔══════════════════════════════════════════════════════════╗
║                🚀 نظام QR SaaS يعمل الآن!                ║
╠══════════════════════════════════════════════════════════╣
║ 📍 البيئة: ${NODE_ENV.padEnd(30)} ║
║ 🌐 المنفذ: ${PORT.toString().padEnd(30)} ║
║ 📊 حالة قاعدة البيانات: متصلة                           ║
╠══════════════════════════════════════════════════════════╣
║ 🔗 الروابط:                                              ║
║ 👑 لوحة الإدارة: http://localhost:${PORT}/admin.html      ║
║ 👤 تطبيق المستخدم: http://localhost:${PORT}/user.html     ║
║ 🩺 صحة النظام: http://localhost:${PORT}/api/health        ║
╠══════════════════════════════════════════════════════════╣
${isFirstRun ? `║ 🔐 بيانات المسؤول الافتراضية:                           ║
║   البريد: admin@qr.com                                   ║
║   كلمة المرور: admin123                                  ║
╠══════════════════════════════════════════════════════════╣` : ''}║ 📝 سجلات النظام في: logs/                                ║
║ 💾 قاعدة البيانات في: qr-saas.db                        ║
╚══════════════════════════════════════════════════════════╝
            `);
        });
        
    } catch (error) {
        console.error('❌ فشل في تشغيل الخادم:', error);
        process.exit(1);
    }
}

// معالجة إشارات الإغلاق
process.on('SIGTERM', () => {
    console.log('📤 تلقت إشارة SIGTERM، جاري الإغلاق النظيف...');
    if (db) db.close();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('📤 تلقت إشارة SIGINT، جاري الإغلاق النظيف...');
    if (db) db.close();
    process.exit(0);
});

// بدء التشغيل
startServer();
