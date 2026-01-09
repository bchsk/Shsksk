// --- server.js ---
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'your-secret-key';

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use(express.static('uploads')); // لتحميل الملفات

// Database setup
const dbPath = path.join(__dirname, 'rehla.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err);
  } else {
    console.log('Database connected successfully');
    initializeDatabase();
  }
});

function initializeDatabase() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      state TEXT NOT NULL,
      is_active BOOLEAN DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS agencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      state TEXT NOT NULL,
      city TEXT NOT NULL,
      phone TEXT NOT NULL,
      description TEXT,
      logo_url TEXT DEFAULT 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?ixlib=rb-4.0.3&auto=format&fit=crop&w=400&q=80',
      bg_url TEXT DEFAULT 'https://images.unsplash.com/photo-1551632811-561732d1e306?ixlib=rb-4.0.3&auto=format&fit=crop&w=1920&q=80',
      trip_limit INTEGER DEFAULT 100,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      state TEXT NOT NULL,
      city TEXT NOT NULL,
      price REAL NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      image1 TEXT NOT NULL,
      image2 TEXT,
      image3 TEXT,
      video_url TEXT,
      min_votes INTEGER DEFAULT 10,
      max_seats INTEGER DEFAULT 20,
      itinerary TEXT NOT NULL,
      status TEXT DEFAULT 'voting',
      agency_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agency_id) REFERENCES agencies (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      trip_id INTEGER NOT NULL,
      voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      FOREIGN KEY (trip_id) REFERENCES trips (id),
      UNIQUE(user_id, trip_id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      trip_id INTEGER NOT NULL,
      seats INTEGER DEFAULT 1,
      notes TEXT,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      FOREIGN KEY (trip_id) REFERENCES trips (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      trip_id INTEGER,
      agency_id INTEGER,
      rating INTEGER CHECK(rating >= 1 AND rating <= 5),
      comment TEXT,
      type TEXT CHECK(type IN ('trip', 'agency')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id),
      FOREIGN KEY (trip_id) REFERENCES trips (id),
      FOREIGN KEY (agency_id) REFERENCES agencies (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`,
    
    `CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    
    `CREATE TABLE IF NOT EXISTS cities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trips INTEGER DEFAULT 0,
      icon TEXT DEFAULT 'fas fa-map-marker-alt'
    )`
  ];

  tables.forEach(table => {
    db.run(table, (err) => {
      if (err) {
        console.error('Error creating table:', err);
      }
    });
  });

  insertSampleData();
}

function insertSampleData() {
  // Admin
  db.run(`INSERT OR IGNORE INTO admins (name, email, password) VALUES (?, ?, ?)`, 
    ['المشرف العام', 'admin@rehla.tn', bcrypt.hashSync('admin123', 10)]);

  // Cities
  const cities = [
    ['تونس العاصمة', 15, 'fas fa-building'],
    ['نابل', 8, 'fas fa-umbrella-beach'],
    ['سوسة', 12, 'fas fa-sun'],
    ['صفاقس', 6, 'fas fa-portrait'],
    ['سيدي بوزيد', 3, 'fas fa-mountain'],
    ['المنستير', 7, 'fas fa-anchor'],
    ['المهدية', 5, 'fas fa-fish'],
    ['قابس', 4, 'fas fa-cactus'],
    ['تطاوين', 6, 'fas fa-sandwich'],
    ['مدنين', 8, 'fas fa-palm-tree'],
    ['قفصة', 4, 'fas fa-tree'],
    ['الكاف', 3, 'fas fa-apple-alt'],
    ['سليانة', 2, 'fas fa-seedling'],
    ['القصرين', 3, 'fas fa-hiking'],
    ['زغوان', 2, 'fas fa-wine-glass'],
    ['بنزرت', 9, 'fas fa-ship'],
    ['باجة', 4, 'fas fa-tractor'],
    ['جندوبة', 5, 'fas fa-water'],
    ['قصرين', 3, 'fas fa-mountain']
  ];

  cities.forEach(([name, trips, icon]) => {
    db.run(`INSERT OR IGNORE INTO cities (name, trips, icon) VALUES (?, ?, ?)`, [name, trips, icon]);
  });
}

// Authentication Middleware
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, error: 'Token not provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    req.user = decoded;
    next();
  });
}

// User Authentication
app.post('/api/register', (req, res) => {
  const { name, last_name, phone, email, state } = req.body;
  
  db.run(`INSERT INTO users (name, last_name, phone, email, state) VALUES (?, ?, ?, ?, ?)`, 
    [name, last_name, phone, email, state], function(err) {
    if (err) {
      return res.status(400).json({ success: false, error: 'User already exists' });
    }
    
    const token = jwt.sign({ user_id: this.lastID, name, user_type: 'user' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, user: { id: this.lastID, name, last_name, phone, email, state } });
  });
});

app.post('/api/login', (req, res) => {
  const { phone } = req.body;
  
  db.get(`SELECT * FROM users WHERE phone = ?`, [phone], (err, user) => {
    if (err || !user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ user_id: user.id, name: user.name, user_type: 'user' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, user: { id: user.id, name: user.name, last_name: user.last_name, phone: user.phone, email: user.email, state: user.state } });
  });
});

// Agency Authentication
app.post('/api/agency/login', (req, res) => {
  const { code } = req.body;
  
  db.get(`SELECT * FROM agencies WHERE code = ? AND status = 'active'`, [code], (err, agency) => {
    if (err || !agency) {
      return res.status(401).json({ success: false, error: 'Agency not found or inactive' });
    }
    
    const token = jwt.sign({ agency_id: agency.id, name: agency.name, user_type: 'agency' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, agency: { id: agency.id, name: agency.name, code: agency.code, state: agency.state, city: agency.city } });
  });
});

// Admin Authentication
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  
  db.get(`SELECT * FROM admins WHERE email = ?`, [email], (err, admin) => {
    if (err || !admin) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    if (!bcrypt.compareSync(password, admin.password)) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    
    const token = jwt.sign({ admin_id: admin.id, name: admin.name, user_type: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token, admin: { id: admin.id, name: admin.name, email: admin.email } });
  });
});

// User Routes
app.get('/api/user/profile/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'user' || req.user.user_id !== parseInt(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  db.get(`SELECT * FROM users WHERE id = ?`, [req.params.id], (err, user) => {
    if (err || !user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, user });
  });
});

app.put('/api/user/profile/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'user' || req.user.user_id !== parseInt(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const { name, last_name, phone, email, state, current_password } = req.body;
  
  db.run(`UPDATE users SET name = ?, last_name = ?, phone = ?, email = ?, state = ? WHERE id = ?`, 
    [name, last_name, phone, email, state, req.params.id], function(err) {
    if (err) {
      return res.status(400).json({ success: false, error: 'Update failed' });
    }
    res.json({ success: true, message: 'Profile updated successfully' });
  });
});

app.get('/api/user/stats/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'user' || req.user.user_id !== parseInt(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  // Check if user voted today
  const today = new Date().toISOString().split('T')[0];
  
  let stats = {
    hasVotedToday: false,
    totalVotes: 0,
    upcomingTrips: 0,
    newNotifications: 0
  };
  
  db.get(`SELECT COUNT(*) as count FROM votes WHERE user_id = ? AND date(voted_at) = ?`, 
    [req.params.id, today], (err, row) => {
    if (row && row.count > 0) stats.hasVotedToday = true;
    
    db.get(`SELECT COUNT(*) as count FROM votes WHERE user_id = ?`, [req.params.id], (err, row) => {
      stats.totalVotes = row ? row.count : 0;
      
      db.get(`SELECT COUNT(*) as count FROM bookings b 
              JOIN trips t ON b.trip_id = t.id 
              WHERE b.user_id = ? AND b.status = 'confirmed' AND t.end_date > date('now')`, 
        [req.params.id], (err, row) => {
        stats.upcomingTrips = row ? row.count : 0;
        
        db.get(`SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0`, 
          [req.params.id], (err, row) => {
          stats.newNotifications = row ? row.count : 0;
          res.json({ success: true, stats });
        });
      });
    });
  });
});

app.get('/api/user/voting-trips/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'user' || req.user.user_id !== parseInt(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  // Check if user voted today
  const today = new Date().toISOString().split('T')[0];
  
  db.get(`SELECT COUNT(*) as count FROM votes WHERE user_id = ? AND date(voted_at) = ?`, 
    [req.params.id, today], (err, row) => {
    const hasVotedToday = row && row.count > 0;
    
    db.all(`SELECT t.*, a.name as organizer, a.id as organizerId,
            (SELECT COUNT(*) FROM votes v WHERE v.trip_id = t.id) as current_votes
            FROM trips t 
            JOIN agencies a ON t.agency_id = a.id 
            WHERE t.status = 'voting' 
            ORDER BY t.created_at DESC`, (err, trips) => {
      res.json({ success: true, trips, hasVotedToday });
    });
  });
});

app.post('/api/user/vote/:tripId', verifyToken, (req, res) => {
  if (req.user.user_type !== 'user') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const today = new Date().toISOString().split('T')[0];
  const { user_id } = req.user;
  const tripId = req.params.tripId;
  
  // Check if user voted today
  db.get(`SELECT COUNT(*) as count FROM votes WHERE user_id = ? AND date(voted_at) = ?`, 
    [user_id, today], (err, row) => {
    if (row && row.count > 0) {
      return res.status(400).json({ success: false, error: 'Already voted today' });
    }
    
    db.run(`INSERT INTO votes (user_id, trip_id) VALUES (?, ?)`, [user_id, tripId], function(err) {
      if (err) {
        return res.status(400).json({ success: false, error: 'Vote failed' });
      }
      
      // Check if trip reached required votes
      db.get(`SELECT * FROM trips WHERE id = ?`, [tripId], (err, trip) => {
        if (trip) {
          db.get(`SELECT COUNT(*) as count FROM votes WHERE trip_id = ?`, [tripId], (err, row) => {
            if (row && row.count >= trip.min_votes) {
              db.run(`UPDATE trips SET status = 'activated' WHERE id = ?`, [tripId]);
            }
          });
        }
      });
      
      res.json({ success: true, message: 'Vote successful' });
    });
  });
});

app.get('/api/user/trips/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'user' || req.user.user_id !== parseInt(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  db.all(`SELECT t.*, b.status as booking_status, a.name as organizer
          FROM trips t 
          JOIN bookings b ON t.id = b.trip_id
          JOIN agencies a ON t.agency_id = a.id
          WHERE b.user_id = ? 
          ORDER BY t.start_date DESC`, [req.params.id], (err, trips) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, trips });
  });
});

app.get('/api/user/reviews/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'user' || req.user.user_id !== parseInt(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  db.all(`SELECT r.*, t.title as trip_title, a.name as agency_name
          FROM reviews r
          LEFT JOIN trips t ON r.trip_id = t.id
          LEFT JOIN agencies a ON r.agency_id = a.id
          WHERE r.user_id = ? 
          ORDER BY r.created_at DESC`, [req.params.id], (err, reviews) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, reviews });
  });
});

app.get('/api/user/notifications/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'user' || req.user.user_id !== parseInt(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  db.all(`SELECT * FROM notifications 
          WHERE user_id = ? 
          ORDER BY created_at DESC`, [req.params.id], (err, notifications) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, notifications });
  });
});

app.put('/api/user/notification/:id/read', verifyToken, (req, res) => {
  const notificationId = req.params.id;
  const userId = req.user.user_id;
  
  db.run(`UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`, 
    [notificationId, userId], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, message: 'Notification marked as read' });
  });
});

app.put('/api/user/notifications/:id/read-all', verifyToken, (req, res) => {
  const userId = req.user.user_id;
  
  db.run(`UPDATE notifications SET is_read = 1 WHERE user_id = ?`, [userId], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, message: 'All notifications marked as read' });
  });
});

app.delete('/api/user/notification/:id', verifyToken, (req, res) => {
  const notificationId = req.params.id;
  const userId = req.user.user_id;
  
  db.run(`DELETE FROM notifications WHERE id = ? AND user_id = ?`, 
    [notificationId, userId], function(err) {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, message: 'Notification deleted' });
  });
});

// Agency Routes
app.get('/api/agency/profile/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'agency' || req.user.agency_id !== parseInt(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  db.get(`SELECT * FROM agencies WHERE id = ?`, [req.params.id], (err, agency) => {
    if (err || !agency) {
      return res.status(404).json({ success: false, error: 'Agency not found' });
    }
    res.json({ success: true, agency });
  });
});

app.put('/api/agency/profile/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'agency' || req.user.agency_id !== parseInt(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const { name, phone, state, city, description } = req.body;
  
  db.run(`UPDATE agencies SET name = ?, phone = ?, state = ?, city = ?, description = ? WHERE id = ?`, 
    [name, phone, state, city, description, req.params.id], function(err) {
    if (err) return res.status(400).json({ success: false, error: 'Update failed' });
    res.json({ success: true, message: 'Profile updated successfully' });
  });
});

app.get('/api/agency/trips/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'agency' || req.user.agency_id !== parseInt(req.params.id)) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  db.all(`SELECT t.*, 
          (SELECT COUNT(*) FROM votes v WHERE v.trip_id = t.id) as votes,
          (SELECT COUNT(*) FROM bookings b WHERE b.trip_id = t.id AND b.status = 'confirmed') as booked_seats
          FROM trips t 
          WHERE t.agency_id = ? 
          ORDER BY t.created_at DESC`, [req.params.id], (err, trips) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, trips });
  });
});

app.post('/api/agency/trips', verifyToken, (req, res) => {
  if (req.user.user_type !== 'agency') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const { title, description, state, city, price, start_date, end_date, image1, image2, image3, video_url, min_votes, max_seats, itinerary } = req.body;
  const agencyId = req.user.agency_id;
  
  // Check trip limit
  db.get(`SELECT COUNT(*) as count FROM trips WHERE agency_id = ?`, [agencyId], (err, row) => {
    if (row && row.count >= 100) {
      return res.status(400).json({ success: false, error: 'Trip limit reached' });
    }
    
    db.run(`INSERT INTO trips (title, description, state, city, price, start_date, end_date, image1, image2, image3, video_url, min_votes, max_seats, itinerary, agency_id) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 
      [title, description, state, city, price, start_date, end_date, image1, image2, image3, video_url, min_votes, max_seats, itinerary, agencyId], function(err) {
      if (err) return res.status(400).json({ success: false, error: err.message });
      res.json({ success: true, message: 'Trip created successfully', tripId: this.lastID });
    });
  });
});

app.put('/api/agency/trips/:id/status', verifyToken, (req, res) => {
  if (req.user.user_type !== 'agency') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const { status } = req.body;
  
  db.run(`UPDATE trips SET status = ? WHERE id = ? AND agency_id = ?`, 
    [status, req.params.id, req.user.agency_id], function(err) {
    if (err) return res.status(400).json({ success: false, error: 'Update failed' });
    res.json({ success: true, message: 'Trip status updated successfully' });
  });
});

app.get('/api/agency/bookings/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'agency') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  db.all(`SELECT b.*, u.name, u.last_name, u.phone, u.email, t.title as trip_title
          FROM bookings b
          JOIN users u ON b.user_id = u.id
          JOIN trips t ON b.trip_id = t.id
          WHERE t.agency_id = ? AND b.status = 'pending'
          ORDER BY b.created_at DESC`, [req.params.id], (err, bookings) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, bookings });
  });
});

app.put('/api/agency/bookings/:bookingId/status', verifyToken, (req, res) => {
  if (req.user.user_type !== 'agency') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const { status } = req.body;
  
  db.run(`UPDATE bookings SET status = ? WHERE id = ?`, [status, req.params.bookingId], function(err) {
    if (err) return res.status(400).json({ success: false, error: 'Update failed' });
    res.json({ success: true, message: 'Booking status updated successfully' });
  });
});

// Admin Routes
app.get('/api/admin/stats', verifyToken, (req, res) => {
  if (req.user.user_type !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  let stats = {};
  
  db.get(`SELECT COUNT(*) as count FROM users WHERE is_active = 1`, (err, row) => {
    stats.users = row ? row.count : 0;
    
    db.get(`SELECT COUNT(*) as count FROM agencies WHERE status = 'active'`, (err, row) => {
      stats.agencies = row ? row.count : 0;
      
      db.get(`SELECT COUNT(*) as count FROM trips WHERE status = 'voting'`, (err, row) => {
        stats.trips = row ? row.count : 0;
        
        db.get(`SELECT COUNT(*) as count FROM bookings WHERE status = 'pending'`, (err, row) => {
          stats.bookings = row ? row.count : 0;
          
          res.json({ success: true, stats });
        });
      });
    });
  });
});

app.get('/api/admin/agencies', verifyToken, (req, res) => {
  if (req.user.user_type !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  db.all(`SELECT a.*, 
          (SELECT COUNT(*) FROM trips t WHERE t.agency_id = a.id) as trips,
          (SELECT COUNT(*) FROM votes v WHERE v.trip_id IN (SELECT id FROM trips WHERE agency_id = a.id)) as votes
          FROM agencies a 
          ORDER BY a.created_at DESC`, (err, agencies) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, agencies });
  });
});

app.post('/api/admin/agencies', verifyToken, (req, res) => {
  if (req.user.user_type !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const { name, state, city, phone, description, trip_limit } = req.body;
  const code = generateAgencyCode();
  
  db.run(`INSERT INTO agencies (name, code, state, city, phone, description, trip_limit) 
          VALUES (?, ?, ?, ?, ?, ?, ?)`, 
    [name, code, state, city, phone, description, trip_limit || 100], function(err) {
    if (err) return res.status(400).json({ success: false, error: err.message });
    
    // Create notification
    db.run(`INSERT INTO notifications (user_id, title, message) 
            VALUES (?, ?, ?)`, [1, 'Agency Created', `Agency ${name} has been created with code ${code}`]);
    
    res.json({ success: true, code, link: `https://rehla.tn/agency?code=${code}` });
  });
});

app.put('/api/admin/agencies/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const { name, trip_limit, status } = req.body;
  
  db.run(`UPDATE agencies SET name = ?, trip_limit = ?, status = ? WHERE id = ?`, 
    [name, trip_limit, status, req.params.id], function(err) {
    if (err) return res.status(400).json({ success: false, error: 'Update failed' });
    res.json({ success: true, message: 'Agency updated successfully' });
  });
});

app.delete('/api/admin/agencies/:id', verifyToken, (req, res) => {
  if (req.user.user_type !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  db.run(`DELETE FROM agencies WHERE id = ?`, [req.params.id], function(err) {
    if (err) return res.status(400).json({ success: false, error: 'Delete failed' });
    res.json({ success: true, message: 'Agency deleted successfully' });
  });
});

app.post('/api/admin/agencies/:id/regenerate-code', verifyToken, (req, res) => {
  if (req.user.user_type !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const newCode = generateAgencyCode();
  
  db.run(`UPDATE agencies SET code = ? WHERE id = ?`, [newCode, req.params.id], function(err) {
    if (err) return res.status(400).json({ success: false, error: 'Code regeneration failed' });
    res.json({ success: true, code: newCode });
  });
});

app.put('/api/admin/agencies/:id/status', verifyToken, (req, res) => {
  if (req.user.user_type !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const { status } = req.body;
  
  db.run(`UPDATE agencies SET status = ? WHERE id = ?`, [status, req.params.id], function(err) {
    if (err) return res.status(400).json({ success: false, error: 'Status update failed' });
    res.json({ success: true, message: 'Agency status updated successfully' });
  });
});

app.get('/api/admin/users', verifyToken, (req, res) => {
  if (req.user.user_type !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  db.all(`SELECT u.*, 
          (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id) as bookings_count,
          (SELECT COUNT(*) FROM votes v WHERE v.user_id = u.id) as votes_count
          FROM users u 
          ORDER BY u.created_at DESC`, (err, users) => {
    if (err) return res.status(500).json({ success: false, error: err.message });
    res.json({ success: true, users });
  });
});

app.put('/api/admin/users/:id/status', verifyToken, (req, res) => {
  if (req.user.user_type !== 'admin') {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }
  
  const { is_active } = req.body;
  
  db.run(`UPDATE users SET is_active = ? WHERE id = ?`, [is_active, req.params.id], function(err) {
    if (err) return res.status(400).json({ success: false, error: 'Status update failed' });
    res.json({ success: true, message: 'User status updated successfully' });
  });
});

// Helper Functions
function generateAgencyCode() {
  return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
