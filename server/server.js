const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const moment = require('moment');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== اتصال قاعدة البيانات ====================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/vaccination_system';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
  .then(() => console.log('✅ تم الاتصال بقاعدة البيانات MongoDB'))
  .catch(err => {
    console.error('❌ خطأ في الاتصال بقاعدة البيانات:', err.message);
    console.log('⚠️  النظام يعمل في وضع التخزين المؤقت');
  });

// ==================== نماذج البيانات ====================
const HospitalSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String, required: true },
  address: String,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const PatientSchema = new mongoose.Schema({
  hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', required: true },
  childName: { type: String, required: true },
  motherName: { type: String, required: true },
  motherPhone: { type: String, required: true, unique: true },
  birthDate: { type: Date, required: true },
  gender: { type: String, enum: ['ذكر', 'أنثى'], required: true },
  notes: String,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const VaccineSchema = new mongoose.Schema({
  patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  name: { type: String, required: true },
  dueDate: { type: Date, required: true },
  status: { type: String, enum: ['معلق', 'مكتمل', 'ملغي'], default: 'معلق' },
  completedDate: Date,
  notes: String,
  notified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Hospital = mongoose.model('Hospital', HospitalSchema);
const Patient = mongoose.model('Patient', PatientSchema);
const Vaccine = mongoose.model('Vaccine', VaccineSchema);

// ==================== دوال المساعدة ====================
const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return await bcrypt.hash(password, salt);
};

const comparePassword = async (password, hashedPassword) => {
  return await bcrypt.compare(password, hashedPassword);
};

const generateToken = (hospitalId) => {
  return jwt.sign(
    { id: hospitalId },
    process.env.JWT_SECRET || 'default_secret_key',
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );
};

const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET || 'default_secret_key');
  } catch (error) {
    return null;
  }
};

// Middleware للتحقق من التوكن
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, error: 'الوصول مرفوض. لا يوجد توكن' });
  }
  
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ success: false, error: 'توكن غير صالح' });
  }
  
  req.hospitalId = decoded.id;
  next();
};

// جدول التطعيمات الوطني حسب العمر بالأشهر
const NATIONAL_VACCINES = [
  { name: 'اللقاح الثلاثي البكتيري (الجرعة الأولى)', months: 2, code: 'DTP1' },
  { name: 'شلل الأطفال الفموي (الجرعة الأولى)', months: 2, code: 'OPV1' },
  { name: 'المستدمية النزلية (الجرعة الأولى)', months: 2, code: 'HIB1' },
  { name: 'اللقاح الثلاثي البكتيري (الجرعة الثانية)', months: 4, code: 'DTP2' },
  { name: 'شلل الأطفال الفموي (الجرعة الثانية)', months: 4, code: 'OPV2' },
  { name: 'المستدمية النزلية (الجرعة الثانية)', months: 4, code: 'HIB2' },
  { name: 'اللقاح الثلاثي البكتيري (الجرعة الثالثة)', months: 6, code: 'DTP3' },
  { name: 'شلل الأطفال الفموي (الجرعة الثالثة)', months: 6, code: 'OPV3' },
  { name: 'المستدمية النزلية (الجرعة الثالثة)', months: 6, code: 'HIB3' },
  { name: 'الحصبة والنكاف والحصبة الألمانية (الجرعة الأولى)', months: 9, code: 'MMR1' },
  { name: 'اللقاح الثلاثي البكتيري (الجرعة الرابعة)', months: 18, code: 'DTP4' },
  { name: 'شلل الأطفال الفموي (الجرعة الرابعة)', months: 18, code: 'OPV4' },
  { name: 'الحصبة والنكاف والحصبة الألمانية (الجرعة الثانية)', months: 24, code: 'MMR2' }
];

// دالة لتوليد جدول التطعيمات تلقائياً
const generateVaccineSchedule = (birthDate) => {
  return NATIONAL_VACCINES.map(vaccine => {
    const dueDate = new Date(birthDate);
    dueDate.setMonth(dueDate.getMonth() + vaccine.months);
    
    return {
      name: vaccine.name,
      code: vaccine.code,
      dueDate: dueDate,
      status: 'معلق',
      notified: false
    };
  });
};

// ==================== مسارات واجهة برمجة التطبيقات ====================

// 1. تسجيل مستشفى جديد
app.post('/api/hospitals/register', async (req, res) => {
  try {
    const { name, email, password, phone, address } = req.body;
    
    // التحقق من البيانات
    if (!name || !email || !password || !phone) {
      return res.status(400).json({
        success: false,
        error: 'جميع الحقول المطلوبة: الاسم، البريد، كلمة المرور، الهاتف'
      });
    }
    
    // التحقق إذا كان البريد مستخدماً
    const existingHospital = await Hospital.findOne({ email });
    if (existingHospital) {
      return res.status(400).json({
        success: false,
        error: 'البريد الإلكتروني مستخدم بالفعل'
      });
    }
    
    // تشفير كلمة المرور
    const hashedPassword = await hashPassword(password);
    
    // إنشاء المستشفى
    const hospital = new Hospital({
      name,
      email,
      password: hashedPassword,
      phone,
      address: address || ''
    });
    
    await hospital.save();
    
    // إنشاء توكن
    const token = generateToken(hospital._id);
    
    res.status(201).json({
      success: true,
      message: 'تم تسجيل المستشفى بنجاح',
      token,
      hospital: {
        id: hospital._id,
        name: hospital.name,
        email: hospital.email,
        phone: hospital.phone
      }
    });
    
  } catch (error) {
    console.error('خطأ في تسجيل المستشفى:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ أثناء تسجيل المستشفى'
    });
  }
});

// 2. تسجيل دخول مستشفى
app.post('/api/hospitals/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'البريد الإلكتروني وكلمة المرور مطلوبان'
      });
    }
    
    // البحث عن المستشفى
    const hospital = await Hospital.findOne({ email, isActive: true });
    if (!hospital) {
      return res.status(401).json({
        success: false,
        error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة'
      });
    }
    
    // التحقق من كلمة المرور
    const isPasswordValid = await comparePassword(password, hospital.password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'البريد الإلكتروني أو كلمة المرور غير صحيحة'
      });
    }
    
    // إنشاء توكن
    const token = generateToken(hospital._id);
    
    res.json({
      success: true,
      message: 'تم تسجيل الدخول بنجاح',
      token,
      hospital: {
        id: hospital._id,
        name: hospital.name,
        email: hospital.email,
        phone: hospital.phone
      }
    });
    
  } catch (error) {
    console.error('خطأ في تسجيل الدخول:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ أثناء تسجيل الدخول'
    });
  }
});

// 3. الحصول على بيانات المستشفى
app.get('/api/hospitals/profile', authMiddleware, async (req, res) => {
  try {
    const hospital = await Hospital.findById(req.hospitalId)
      .select('-password -__v');
    
    if (!hospital) {
      return res.status(404).json({
        success: false,
        error: 'المستشفى غير موجود'
      });
    }
    
    res.json({
      success: true,
      hospital
    });
    
  } catch (error) {
    console.error('خطأ في جلب بيانات المستشفى:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ في جلب البيانات'
    });
  }
});

// 4. إضافة طفل جديد
app.post('/api/patients', authMiddleware, async (req, res) => {
  try {
    const { childName, motherName, motherPhone, birthDate, gender, notes } = req.body;
    
    // التحقق من البيانات
    if (!childName || !motherName || !motherPhone || !birthDate || !gender) {
      return res.status(400).json({
        success: false,
        error: 'جميع الحقول المطلوبة: اسم الطفل، اسم الأم، هاتف الأم، تاريخ الميلاد، الجنس'
      });
    }
    
    // التحقق إذا كان رقم الهاتف مستخدماً
    const existingPatient = await Patient.findOne({ motherPhone });
    if (existingPatient) {
      return res.status(400).json({
        success: false,
        error: 'رقم هاتف الأم مستخدم بالفعل'
      });
    }
    
    // إنشاء الطفل
    const patient = new Patient({
      hospitalId: req.hospitalId,
      childName,
      motherName,
      motherPhone,
      birthDate: new Date(birthDate),
      gender,
      notes: notes || ''
    });
    
    await patient.save();
    
    // توليد جدول التطعيمات تلقائياً
    const vaccineSchedule = generateVaccineSchedule(patient.birthDate);
    const vaccines = vaccineSchedule.map(vaccine => ({
      ...vaccine,
      patientId: patient._id
    }));
    
    await Vaccine.insertMany(vaccines);
    
    res.status(201).json({
      success: true,
      message: 'تم إضافة الطفل وتوليد جدول التطعيمات بنجاح',
      patient: {
        id: patient._id,
        childName: patient.childName,
        motherName: patient.motherName,
        motherPhone: patient.motherPhone
      }
    });
    
  } catch (error) {
    console.error('خطأ في إضافة الطفل:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ أثناء إضافة الطفل'
    });
  }
});

// 5. الحصول على قائمة الأطفال
app.get('/api/patients', authMiddleware, async (req, res) => {
  try {
    const { search, page = 1, limit = 20 } = req.query;
    
    const query = { hospitalId: req.hospitalId, isActive: true };
    
    // إضافة البحث إذا كان موجوداً
    if (search) {
      query.$or = [
        { childName: { $regex: search, $options: 'i' } },
        { motherName: { $regex: search, $options: 'i' } },
        { motherPhone: { $regex: search, $options: 'i' } }
      ];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const patients = await Patient.find(query)
      .select('-__v')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));
    
    const total = await Patient.countDocuments(query);
    
    res.json({
      success: true,
      patients,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
    
  } catch (error) {
    console.error('خطأ في جلب قائمة الأطفال:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ في جلب البيانات'
    });
  }
});

// 6. الحصول على بيانات طفل معين
app.get('/api/patients/:id', authMiddleware, async (req, res) => {
  try {
    const patient = await Patient.findOne({
      _id: req.params.id,
      hospitalId: req.hospitalId,
      isActive: true
    }).select('-__v');
    
    if (!patient) {
      return res.status(404).json({
        success: false,
        error: 'الطفل غير موجود'
      });
    }
    
    // جلب التطعيمات الخاصة بالطفل
    const vaccines = await Vaccine.find({ patientId: patient._id })
      .sort({ dueDate: 1 })
      .select('-__v');
    
    res.json({
      success: true,
      patient,
      vaccines
    });
    
  } catch (error) {
    console.error('خطأ في جلب بيانات الطفل:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ في جلب البيانات'
    });
  }
});

// 7. تحديث بيانات الطفل
app.put('/api/patients/:id', authMiddleware, async (req, res) => {
  try {
    const { childName, motherName, motherPhone, birthDate, gender, notes } = req.body;
    
    const patient = await Patient.findOneAndUpdate(
      {
        _id: req.params.id,
        hospitalId: req.hospitalId,
        isActive: true
      },
      {
        childName,
        motherName,
        motherPhone,
        birthDate: birthDate ? new Date(birthDate) : undefined,
        gender,
        notes
      },
      { new: true, runValidators: true }
    ).select('-__v');
    
    if (!patient) {
      return res.status(404).json({
        success: false,
        error: 'الطفل غير موجود أو لا تملك صلاحية التعديل'
      });
    }
    
    res.json({
      success: true,
      message: 'تم تحديث بيانات الطفل بنجاح',
      patient
    });
    
  } catch (error) {
    console.error('خطأ في تحديث بيانات الطفل:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ أثناء التحديث'
    });
  }
});

// 8. تحديث حالة التطعيم
app.put('/api/vaccines/:id', authMiddleware, async (req, res) => {
  try {
    const { status, completedDate, notes } = req.body;
    
    // التحقق من البيانات
    if (!status || !['معلق', 'مكتمل', 'ملغي'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'الحالة يجب أن تكون: معلق، مكتمل، أو ملغي'
      });
    }
    
    // البحث عن التطعيم والتحقق من الملكية
    const vaccine = await Vaccine.findById(req.params.id).populate('patientId');
    
    if (!vaccine) {
      return res.status(404).json({
        success: false,
        error: 'التطعيم غير موجود'
      });
    }
    
    // التحقق إذا كان الطفل يتبع للمستشفى
    if (vaccine.patientId.hospitalId.toString() !== req.hospitalId) {
      return res.status(403).json({
        success: false,
        error: 'لا تملك صلاحية تعديل هذا التطعيم'
      });
    }
    
    // تحديث التطعيم
    vaccine.status = status;
    vaccine.completedDate = status === 'مكتمل' ? new Date(completedDate || Date.now()) : null;
    vaccine.notes = notes || '';
    
    await vaccine.save();
    
    res.json({
      success: true,
      message: 'تم تحديث حالة التطعيم بنجاح',
      vaccine
    });
    
  } catch (error) {
    console.error('خطأ في تحديث التطعيم:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ أثناء تحديث التطعيم'
    });
  }
});

// 9. صفحة الأم (بدون توكن) - الحصول على بيانات الطفل والتطعيمات
app.get('/api/mother/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    
    // البحث عن الطفل برقم هاتف الأم
    const patient = await Patient.findOne({ motherPhone: phone, isActive: true })
      .select('-__v')
      .populate('hospitalId', 'name phone address');
    
    if (!patient) {
      return res.status(404).json({
        success: false,
        error: 'لا يوجد طفل مسجل بهذا الرقم'
      });
    }
    
    // جلب التطعيمات
    const vaccines = await Vaccine.find({ patientId: patient._id })
      .sort({ dueDate: 1 })
      .select('-__v');
    
    // حساب الإحصائيات
    const totalVaccines = vaccines.length;
    const completedVaccines = vaccines.filter(v => v.status === 'مكتمل').length;
    const pendingVaccines = vaccines.filter(v => v.status === 'معلق').length;
    const nextVaccine = vaccines.find(v => v.status === 'معلق');
    
    res.json({
      success: true,
      patient,
      vaccines,
      stats: {
        totalVaccines,
        completedVaccines,
        pendingVaccines,
        completionRate: totalVaccines > 0 ? Math.round((completedVaccines / totalVaccines) * 100) : 0,
        nextVaccine: nextVaccine || null
      }
    });
    
  } catch (error) {
    console.error('خطأ في جلب بيانات الأم:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ في جلب البيانات'
    });
  }
});

// 10. إحصائيات المستشفى
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const hospitalId = req.hospitalId;
    
    // عدد الأطفال
    const totalPatients = await Patient.countDocuments({ hospitalId, isActive: true });
    
    // التطعيمات
    const patients = await Patient.find({ hospitalId, isActive: true }).select('_id');
    const patientIds = patients.map(p => p._id);
    
    const totalVaccines = await Vaccine.countDocuments({ patientId: { $in: patientIds } });
    const completedVaccines = await Vaccine.countDocuments({
      patientId: { $in: patientIds },
      status: 'مكتمل'
    });
    const pendingVaccines = await Vaccine.countDocuments({
      patientId: { $in: patientIds },
      status: 'معلق'
    });
    
    // التطعيمات القادمة هذا الأسبوع
    const startOfWeek = new Date();
    const endOfWeek = new Date();
    endOfWeek.setDate(endOfWeek.getDate() + 7);
    
    const upcomingVaccines = await Vaccine.countDocuments({
      patientId: { $in: patientIds },
      status: 'معلق',
      dueDate: { $gte: startOfWeek, $lte: endOfWeek }
    });
    
    res.json({
      success: true,
      stats: {
        totalPatients,
        totalVaccines,
        completedVaccines,
        pendingVaccines,
        upcomingVaccines,
        completionRate: totalVaccines > 0 ? Math.round((completedVaccines / totalVaccines) * 100) : 0
      }
    });
    
  } catch (error) {
    console.error('خطأ في جلب الإحصائيات:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ في جلب الإحصائيات'
    });
  }
});

// 11. التطعيمات القادمة
app.get('/api/upcoming-vaccines', authMiddleware, async (req, res) => {
  try {
    const { days = 7 } = req.query;
    
    const patients = await Patient.find({ hospitalId: req.hospitalId, isActive: true }).select('_id');
    const patientIds = patients.map(p => p._id);
    
    const startDate = new Date();
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(days));
    
    const upcomingVaccines = await Vaccine.find({
      patientId: { $in: patientIds },
      status: 'معلق',
      dueDate: { $gte: startDate, $lte: endDate }
    })
      .populate('patientId', 'childName motherName motherPhone')
      .sort({ dueDate: 1 })
      .select('-__v');
    
    res.json({
      success: true,
      count: upcomingVaccines.length,
      vaccines: upcomingVaccines
    });
    
  } catch (error) {
    console.error('خطأ في جلب التطعيمات القادمة:', error);
    res.status(500).json({
      success: false,
      error: 'حدث خطأ في جلب البيانات'
    });
  }
});

// 12. جلب جدول التطعيمات الوطني
app.get('/api/national-vaccines', (req, res) => {
  res.json({
    success: true,
    vaccines: NATIONAL_VACCINES
  });
});

// 13. صفحة الصحة (Health Check)
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'النظام يعمل بشكل طبيعي',
    timestamp: new Date().toISOString(),
    database: mongoose.connection.readyState === 1 ? 'متصل' : 'غير متصل',
    version: '1.0.0'
  });
});

// 14. صفحة ترحيبية
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>نظام تذكير التطعيمات - API</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          direction: rtl;
          text-align: center;
          padding: 50px;
          background: #f5f5f5;
        }
        .container {
          max-width: 800px;
          margin: 0 auto;
          background: white;
          padding: 30px;
          border-radius: 10px;
          box-shadow: 0 0 10px rgba(0,0,0,0.1);
        }
        h1 {
          color: #2c3e50;
        }
        .api-list {
          text-align: right;
          margin: 30px 0;
        }
        .api-item {
          background: #f8f9fa;
          padding: 15px;
          margin: 10px 0;
          border-right: 4px solid #3498db;
          border-radius: 5px;
        }
        .method {
          display: inline-block;
          padding: 5px 10px;
          border-radius: 3px;
          font-weight: bold;
          margin-left: 10px;
        }
        .method.get { background: #61affe; color: white; }
        .method.post { background: #49cc90; color: white; }
        .method.put { background: #fca130; color: white; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚀 نظام تذكير التطعيمات - واجهة برمجة التطبيقات</h1>
        <p>نظام متكامل لإدارة تطعيمات الأطفال وتذكير الأمهات</p>
        
        <div class="api-list">
          <h3>📋 قائمة الـ APIs:</h3>
          
          <div class="api-item">
            <span class="method post">POST</span>
            <strong>/api/hospitals/register</strong> - تسجيل مستشفى جديد
          </div>
          
          <div class="api-item">
            <span class="method post">POST</span>
            <strong>/api/hospitals/login</strong> - تسجيل دخول مستشفى
          </div>
          
          <div class="api-item">
            <span class="method post">POST</span>
            <strong>/api/patients</strong> - إضافة طفل جديد (مع التوكن)
          </div>
          
          <div class="api-item">
            <span class="method get">GET</span>
            <strong>/api/patients</strong> - قائمة الأطفال (مع التوكن)
          </div>
          
          <div class="api-item">
            <span class="method get">GET</span>
            <strong>/api/mother/:phone</strong> - صفحة الأم (بدون تسجيل دخول)
          </div>
          
          <div class="api-item">
            <span class="method get">GET</span>
            <strong>/api/stats</strong> - إحصائيات المستشفى (مع التوكن)
          </div>
          
          <div class="api-item">
            <span class="method get">GET</span>
            <strong>/api/health</strong> - فحص حالة النظام
          </div>
        </div>
        
        <p>📚 للتشغيل: npm start | 🌐 البورت: ${process.env.PORT || 3000}</p>
      </div>
    </body>
    </html>
  `);
});

// ==================== معالجة الأخطاء ====================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'الصفحة غير موجودة'
  });
});

app.use((err, req, res, next) => {
  console.error('خطأ في السيرفر:', err);
  res.status(500).json({
    success: false,
    error: 'حدث خطأ داخلي في السيرفر'
  });
});

// ==================== تشغيل السيرفر ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║     🚀 نظام تذكير التطعيمات يعمل الآن!        ║
  ╠═══════════════════════════════════════════════╣
  ║ 📍 العنوان: http://localhost:${PORT}           ║
  ║ 🗃️  قاعدة البيانات: ${MONGODB_URI}            ║
  ║ ⏰ الوقت: ${new Date().toLocaleString('ar-SA')}  ║
  ╚═══════════════════════════════════════════════╝
  `);
  
  console.log('\n📋 واجهات برمجة التطبيقات المتاحة:');
  console.log('──────────────────────────────────────');
  console.log('🔐 المستشفيات:');
  console.log('  POST /api/hospitals/register  - تسجيل مستشفى جديد');
  console.log('  POST /api/hospitals/login     - تسجيل دخول مستشفى');
  console.log('  GET  /api/hospitals/profile   - بيانات المستشفى (مع التوكن)');
  console.log('');
  console.log('👶 الأطفال:');
  console.log('  POST /api/patients            - إضافة طفل جديد (مع التوكن)');
  console.log('  GET  /api/patients            - قائمة الأطفال (مع التوكن)');
  console.log('  GET  /api/patients/:id        - بيانات طفل (مع التوكن)');
  console.log('  PUT  /api/patients/:id        - تحديث بيانات طفل (مع التوكن)');
  console.log('');
  console.log('💉 التطعيمات:');
  console.log('  PUT  /api/vaccines/:id        - تحديث حالة تطعيم (مع التوكن)');
  console.log('');
  console.log('👩 الأمهات:');
  console.log('  GET  /api/mother/:phone       - صفحة الأم (بدون توكن)');
  console.log('');
  console.log('📊 التقارير:');
  console.log('  GET  /api/stats               - إحصائيات المستشفى (مع التوكن)');
  console.log('  GET  /api/upcoming-vaccines   - التطعيمات القادمة (مع التوكن)');
  console.log('  GET  /api/national-vaccines   - جدول التطعيمات الوطني');
  console.log('');
  console.log('🔧 النظام:');
  console.log('  GET  /api/health              - فحص حالة النظام');
  console.log('  GET  /                        - الصفحة الرئيسية');
  console.log('──────────────────────────────────────');
});
