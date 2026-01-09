#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

console.log(`
╔═══════════════════════════════════════════════╗
║    🛠️  إعداد نظام تذكير التطعيمات - النسخة 1.0    ║
╚═══════════════════════════════════════════════╝
`);

// إنشاء واجهة للإدخال
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// دالة لسؤال المستخدم
const askQuestion = (question) => {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
};

// الدالة الرئيسية
const main = async () => {
  console.log('\n📦 جاري إعداد النظام...\n');
  
  // 1. التحقق من وجود package.json
  if (!fs.existsSync('package.json')) {
    console.log('❌ ملف package.json غير موجود!');
    console.log('📝 يرجى إنشاء المشروع أولاً:');
    console.log('   mkdir vaccination-system');
    console.log('   cd vaccination-system');
    console.log('   npm init -y');
    process.exit(1);
  }
  
  // 2. نسخ .env.example إلى .env إذا لم يكن موجوداً
  if (fs.existsSync('.env.example') && !fs.existsSync('.env')) {
    try {
      fs.copyFileSync('.env.example', '.env');
      console.log('✅ تم إنشاء ملف .env من .env.example');
    } catch (err) {
      console.log('⚠️  لم يتمكن من إنشاء ملف .env:', err.message);
    }
  } else if (!fs.existsSync('.env')) {
    // إنشاء ملف .env جديد
    const envContent = `# إعدادات النظام
PORT=3000
NODE_ENV=development

# قاعدة البيانات MongoDB
MONGODB_URI=mongodb://localhost:27017/vaccination_system

# الأمان
JWT_SECRET=change_this_to_a_random_secret_key_in_production
JWT_EXPIRE=7d

# التذكيرات (اختياري)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password
`;
    
    fs.writeFileSync('.env', envContent);
    console.log('✅ تم إنشاء ملف .env جديد');
  }
  
  // 3. إنشاء مجلدات إذا لم تكن موجودة
  const folders = ['server', 'logs'];
  folders.forEach(folder => {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
      console.log(`📁 تم إنشاء مجلد: ${folder}`);
    }
  });
  
  // 4. التحقق من وجود ملف server.js
  if (!fs.existsSync('server/server.js')) {
    console.log('❌ ملف server/server.js غير موجود!');
    console.log('📝 يرجى نسخ ملف server.js إلى مجلد server/');
    process.exit(1);
  }
  
  // 5. تثبيت الحزم
  console.log('\n📥 جاري تثبيت الحزم المطلوبة...');
  console.log('⏳ قد يستغرق هذا بضع دقائق...');
  
  try {
    // قراءة package.json
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    
    // الحزم المطلوبة
    const requiredDependencies = {
      "express": "^4.18.0",
      "mongoose": "^7.0.0",
      "cors": "^2.8.5",
      "dotenv": "^16.0.0",
      "bcryptjs": "^2.4.3",
      "jsonwebtoken": "^9.0.0",
      "moment": "^2.29.0"
    };
    
    // الحزم المطلوبة للتطوير
    const requiredDevDependencies = {
      "nodemon": "^2.0.0"
    };
    
    // تحديث package.json
    packageJson.dependencies = { ...packageJson.dependencies, ...requiredDependencies };
    packageJson.devDependencies = { ...packageJson.devDependencies, ...requiredDevDependencies };
    
    // إضافة scripts إذا لم تكن موجودة
    packageJson.scripts = {
      "start": "node server/server.js",
      "setup": "node server/setup.js",
      "dev": "nodemon server/server.js",
      "docker:up": "docker-compose up -d",
      "docker:down": "docker-compose down",
      ...packageJson.scripts
    };
    
    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
    console.log('✅ تم تحديث package.json');
    
  } catch (err) {
    console.log('⚠️  خطأ في تحديث package.json:', err.message);
  }
  
  // 6. سؤال المستخدم إذا كان يريد تشغيل Docker
  console.log('\n🐳 هل تريد تشغيل قاعدة البيانات باستخدام Docker؟');
  console.log('   (يحتاج Docker مثبتاً على جهازك)');
  
  const useDocker = await askQuestion('   (نعم/لا) [نعم]: ') || 'نعم';
  
  if (useDocker.toLowerCase().startsWith('ن')) {
    console.log('\n🔧 جاري إنشاء ملف docker-compose.yml...');
    
    const dockerCompose = `version: '3.8'
services:
  mongodb:
    image: mongo:latest
    container_name: vaccination-mongodb
    ports:
      - "27017:27017"
    volumes:
      - mongodb_data:/data/db
    environment:
      - MONGO_INITDB_DATABASE=vaccination_system
    restart: unless-stopped

volumes:
  mongodb_data:`;
    
    fs.writeFileSync('docker-compose.yml', dockerCompose);
    console.log('✅ تم إنشاء docker-compose.yml');
    
    console.log('\n🚀 لبدء قاعدة البيانات، قم بتشغيل:');
    console.log('   npm run docker:up');
    console.log('\n🛑 لإيقاف قاعدة البيانات، قم بتشغيل:');
    console.log('   npm run docker:down');
  }
  
  // 7. نصائح التشغيل
  console.log('\n🎉 تم الإعداد بنجاح!');
  console.log('\n📋 خطوات التشغيل:');
  console.log('──────────────────────────────────────');
  console.log('1. 📥 تثبيت الحزم:');
  console.log('   npm install');
  console.log('');
  console.log('2. 🗃️  تشغيل قاعدة البيانات:');
  console.log('   npm run docker:up   (إذا اخترت Docker)');
  console.log('   أو قم بتشغيل MongoDB يدوياً');
  console.log('');
  console.log('3. 🚀 تشغيل التطبيق:');
  console.log('   npm start           (للتشغيل العادي)');
  console.log('   npm run dev         (للتطوير مع إعادة تشغيل تلقائية)');
  console.log('');
  console.log('4. 🌐 فتح المتصفح:');
  console.log('   http://localhost:3000');
  console.log('──────────────────────────────────────');
  console.log('\n🔐 مفتاح التوكن الافتراضي:');
  console.log('   JWT_SECRET في ملف .env');
  console.log('\n📞 للدعم أو الأسئلة:');
  console.log('   راجع ملف README.md');
  
  // إنشاء ملف للدلالة على أن الإعداد تم
  fs.writeFileSync('setup-completed.txt', `تم الإعداد في: ${new Date().toISOString()}`);
  
  rl.close();
};

// تشغيل الإعداد
main().catch(console.error);
