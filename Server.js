const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'rkaz.db');
const BACKUP_DIR = path.join(__dirname, 'backups');

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static(__dirname));

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('خطأ في الاتصال بقاعدة البيانات:', err.message);
    process.exit(1);
  }
  console.log('تم الاتصال بقاعدة بيانات نظام ركاز بنجاح.');
});

const runAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });

const getAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });

const allAsync = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

async function withTransaction(fn) {
  await runAsync('BEGIN TRANSACTION');
  try {
    const result = await fn();
    await runAsync('COMMIT');
    return result;
  } catch (err) {
    try { await runAsync('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

async function logAudit(userId, actionType, entityName, entityId = null, oldValues = null, newValues = null) {
  try {
    await runAsync(
      `INSERT INTO AuditLogs (UserId, ActionType, EntityName, EntityId, OldValues, NewValues)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId || 1,
        actionType,
        entityName,
        entityId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null
      ]
    );
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

async function ensureNotLockedPeriod(dateStr) {
  const checkDate = (dateStr || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const locked = await getAsync(
    `SELECT PeriodName FROM FiscalPeriods WHERE IsLocked = 1 AND ? BETWEEN StartDate AND EndDate`,
    [checkDate]
  );
  if (locked) {
    throw new Error(`الفترة المحاسبية (${locked.PeriodName}) مقفلة ولا يمكن الترحيل أو التعديل فيها.`);
  }
}

async function initDatabase() {
  await runAsync('PRAGMA foreign_keys = ON');

  await runAsync(`CREATE TABLE IF NOT EXISTS Users (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    Username TEXT UNIQUE NOT NULL,
    Password TEXT NOT NULL,
    FullName TEXT NOT NULL,
    Role TEXT NOT NULL DEFAULT 'CASHIER',
    MaxDiscountPercent REAL NOT NULL DEFAULT 0,
    PermissionsJson TEXT NOT NULL DEFAULT '{}',
    IsActive INTEGER NOT NULL DEFAULT 1
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS SystemSettings (
    SettingKey TEXT PRIMARY KEY,
    SettingValue TEXT
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS FiscalPeriods (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    PeriodName TEXT NOT NULL,
    StartDate TEXT NOT NULL,
    EndDate TEXT NOT NULL,
    IsLocked INTEGER NOT NULL DEFAULT 0,
    LockedBy INTEGER,
    LockedAt TEXT
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS Accounts (
    Code TEXT PRIMARY KEY,
    Name TEXT NOT NULL,
    Type TEXT NOT NULL,
    ParentCode TEXT,
    IsGroup INTEGER NOT NULL DEFAULT 0,
    Balance REAL NOT NULL DEFAULT 0
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS Parties (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT NOT NULL,
    Type TEXT NOT NULL,
    Phone TEXT,
    CreditLimit REAL NOT NULL DEFAULT 0,
    OpeningBalance REAL NOT NULL DEFAULT 0,
    Balance REAL NOT NULL DEFAULT 0
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS Items (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    Barcode TEXT UNIQUE NOT NULL,
    ScaleCode TEXT,
    Name TEXT NOT NULL,
    Category TEXT NOT NULL DEFAULT 'عام',
    Unit TEXT NOT NULL DEFAULT 'حبة',
    PackMultiplier REAL NOT NULL DEFAULT 1,
    CostPrice REAL NOT NULL DEFAULT 0,
    SalePrice REAL NOT NULL DEFAULT 0,
    TaxRate REAL NOT NULL DEFAULT 15,
    StockQty REAL NOT NULL DEFAULT 0,
    MinStock REAL NOT NULL DEFAULT 5,
    ExpiryDate TEXT,
    IsActive INTEGER NOT NULL DEFAULT 1
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS ItemUnits (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    ItemId INTEGER NOT NULL,
    UnitName TEXT NOT NULL,
    Barcode TEXT UNIQUE NOT NULL,
    Multiplier REAL NOT NULL DEFAULT 1,
    SalePrice REAL NOT NULL DEFAULT 0,
    CostPrice REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (ItemId) REFERENCES Items(Id) ON DELETE CASCADE
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS Promotions (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT NOT NULL,
    Priority INTEGER NOT NULL DEFAULT 1,
    ConditionType TEXT NOT NULL DEFAULT 'ITEM_QTY',
    StartDate TEXT NOT NULL,
    EndDate TEXT,
    IsActive INTEGER NOT NULL DEFAULT 1,
    CreatedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS PromotionItems (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    PromotionId INTEGER NOT NULL,
    ItemId INTEGER NOT NULL,
    Barcode TEXT NOT NULL,
    ItemName TEXT NOT NULL,
    Unit TEXT NOT NULL DEFAULT 'حبة',
    PromoPriceInclTax REAL NOT NULL,
    PromoPriceExclTax REAL NOT NULL,
    RequiredQty REAL NOT NULL DEFAULT 1,
    SecondQty REAL NOT NULL DEFAULT 0,
    MaxPerCustomer REAL NOT NULL DEFAULT 0,
    LimitCap REAL NOT NULL DEFAULT 0,
    FOREIGN KEY (PromotionId) REFERENCES Promotions(Id) ON DELETE CASCADE,
    FOREIGN KEY (ItemId) REFERENCES Items(Id) ON DELETE CASCADE
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS CashShifts (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    UserId INTEGER NOT NULL,
    CashierName TEXT NOT NULL,
    CashAccountCode TEXT NOT NULL DEFAULT '1101',
    OpenedAt TEXT NOT NULL,
    ClosedAt TEXT,
    OpeningBalance REAL NOT NULL DEFAULT 0,
    CashSales REAL NOT NULL DEFAULT 0,
    CardSales REAL NOT NULL DEFAULT 0,
    ReturnsTotal REAL NOT NULL DEFAULT 0,
    ExpectedBalance REAL NOT NULL DEFAULT 0,
    ActualBalance REAL NOT NULL DEFAULT 0,
    Variance REAL NOT NULL DEFAULT 0,
    Status TEXT NOT NULL DEFAULT 'OPEN',
    Notes TEXT
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS HeldInvoices (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    PartyId INTEGER,
    PartyName TEXT NOT NULL DEFAULT 'عميل نقدي عام',
    GlobalDiscount REAL NOT NULL DEFAULT 0,
    ItemsJson TEXT NOT NULL,
    CreatedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS Invoices (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    InvoiceNumber TEXT UNIQUE NOT NULL,
    Type TEXT NOT NULL,
    PaymentMethod TEXT NOT NULL,
    PartyId INTEGER,
    PartyName TEXT NOT NULL DEFAULT 'عميل نقدي عام',
    ShiftId INTEGER,
    UserId INTEGER,
    Subtotal REAL NOT NULL DEFAULT 0,
    DiscountTotal REAL NOT NULL DEFAULT 0,
    TaxableAmount REAL NOT NULL DEFAULT 0,
    TaxTotal REAL NOT NULL DEFAULT 0,
    NetTotal REAL NOT NULL DEFAULT 0,
    PaidCash REAL NOT NULL DEFAULT 0,
    PaidCard REAL NOT NULL DEFAULT 0,
    ChangeAmount REAL NOT NULL DEFAULT 0,
    Status TEXT NOT NULL DEFAULT 'COMPLETED',
    ItemsJson TEXT NOT NULL,
    CreatedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS WastageLogs (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    ItemId INTEGER NOT NULL,
    ItemName TEXT NOT NULL,
    Barcode TEXT NOT NULL,
    Qty REAL NOT NULL,
    UnitCost REAL NOT NULL DEFAULT 0,
    TotalCost REAL NOT NULL DEFAULT 0,
    Reason TEXT NOT NULL,
    UserId INTEGER,
    CreatedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS Journals (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    JournalNumber TEXT NOT NULL,
    RefType TEXT NOT NULL,
    RefId TEXT,
    Description TEXT NOT NULL,
    DebitAccount TEXT NOT NULL,
    CreditAccount TEXT NOT NULL,
    Amount REAL NOT NULL,
    CreatedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS Vouchers (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    VoucherNumber TEXT UNIQUE NOT NULL,
    Type TEXT NOT NULL,
    AccountCode TEXT NOT NULL,
    CounterAccountCode TEXT NOT NULL,
    PartyId INTEGER,
    Amount REAL NOT NULL,
    PaymentMethod TEXT NOT NULL DEFAULT 'CASH',
    Description TEXT,
    CreatedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS StockMovements (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    ItemId INTEGER NOT NULL,
    ItemName TEXT NOT NULL,
    MovementType TEXT NOT NULL,
    QtyChange REAL NOT NULL,
    CostImpact REAL NOT NULL DEFAULT 0,
    RefDoc TEXT,
    CreatedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await runAsync(`CREATE TABLE IF NOT EXISTS AuditLogs (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    UserId INTEGER NOT NULL,
    ActionType TEXT NOT NULL,
    EntityName TEXT NOT NULL,
    EntityId TEXT,
    OldValues TEXT,
    NewValues TEXT,
    CreatedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  const adminPerms = {
    pos_access: true, pos_new_invoice: true, pos_discount: true, pos_return: true,
    pos_hold: true, pos_shift_close: true, pos_sync: true, pos_customer_screen: true,
    pos_shortcuts: true, pos_open_admin: true,
    admin_access: true, accounts_manage: true, journal_create: true, vouchers_manage: true,
    items_manage: true, promos_manage: true, parties_manage: true, purchases_manage: true,
    stock_adjust: true, reports_view: true, fiscal_close: true, users_manage: true,
    audit_view: true, backup_manage: true
  };

  const cashierPerms = {
    pos_access: true, pos_new_invoice: true, pos_discount: false, pos_return: false,
    pos_hold: true, pos_shift_close: true, pos_sync: true, pos_customer_screen: true,
    pos_shortcuts: true, pos_open_admin: false,
    admin_access: false, accounts_manage: false, journal_create: false, vouchers_manage: false,
    items_manage: false, promos_manage: false, parties_manage: false, purchases_manage: false,
    stock_adjust: false, reports_view: false, fiscal_close: false, users_manage: false,
    audit_view: false, backup_manage: false
  };

  await runAsync(
    `INSERT OR IGNORE INTO Users (Username, Password, FullName, Role, MaxDiscountPercent, PermissionsJson, IsActive)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ['admin', '1234', 'مدير النظام', 'ADMIN', 100, JSON.stringify(adminPerms)]
  );
  await runAsync(
    `INSERT OR IGNORE INTO Users (Username, Password, FullName, Role, MaxDiscountPercent, PermissionsJson, IsActive)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    ['cashier1', '1234', 'كاشير السوبر ماركت', 'CASHIER', 5, JSON.stringify(cashierPerms)]
  );

  const defaultSettings = [
    ['company_name', 'نظام ركاز'],
    ['company_subtitle', 'نقطة البيع والإدارة المحاسبية للسوبر ماركت'],
    ['company_phone', ''],
    ['company_address', ''],
    ['tax_number', ''],
    ['receipt_footer', 'شكراً لتسوقكم معنا - نظام ركاز'],
    ['printer_type', 'POS_80MM'],
    ['currency', 'ر.س'],
    ['scale_prefix', '20'],
    ['expiry_alert_days', '7']
  ];
  for (const [k, v] of defaultSettings) {
    await runAsync(`INSERT OR IGNORE INTO SystemSettings (SettingKey, SettingValue) VALUES (?, ?)`, [k, v]);
  }

  const coa = [
    ['1', 'الأصول', 'ASSET', null, 1, 0],
    ['11', 'الأصول المتداولة', 'ASSET', '1', 1, 0],
    ['1101', 'الصندوق الرئيسي', 'ASSET', '11', 0, 0],
    ['1102', 'البنك / الشبكة', 'ASSET', '11', 0, 0],
    ['1103', 'العملاء (الذمم المدينة)', 'ASSET', '11', 0, 0],
    ['1104', 'المخزون السلعي', 'ASSET', '11', 0, 0],
    ['12', 'الأصول الثابتة', 'ASSET', '1', 1, 0],
    ['1201', 'الأثاث والتجهيزات والثلاجات والموازين', 'ASSET', '12', 0, 0],

    ['2', 'الخصوم (الالتزامات)', 'LIABILITY', null, 1, 0],
    ['21', 'الخصوم المتداولة', 'LIABILITY', '2', 1, 0],
    ['2101', 'الموردون (الذمم الدائنة)', 'LIABILITY', '21', 0, 0],
    ['2102', 'ضريبة القيمة المضافة المستحقة', 'LIABILITY', '21', 0, 0],
    ['2103', 'عجز / زيادة الصندوق', 'LIABILITY', '21', 0, 0],
    ['22', 'الخصوم طويلة الأجل', 'LIABILITY', '2', 1, 0],
    ['2201', 'قروض والتزامات طويلة الأجل', 'LIABILITY', '22', 0, 0],

    ['3', 'حقوق الملكية', 'EQUITY', null, 1, 0],
    ['3101', 'رأس المال', 'EQUITY', '3', 0, 0],
    ['3201', 'الأرباح المحتجزة / الجاري', 'EQUITY', '3', 0, 0],

    ['4', 'الإيرادات', 'REVENUE', null, 1, 0],
    ['4101', 'إيرادات المبيعات', 'REVENUE', '4', 0, 0],
    ['4102', 'مسموحات ومردودات المبيعات', 'REVENUE', '4', 0, 0],
    ['4201', 'إيرادات أخرى', 'REVENUE', '4', 0, 0],

    ['5', 'المصروفات', 'EXPENSE', null, 1, 0],
    ['5101', 'تكلفة البضاعة المباعة', 'EXPENSE', '5', 0, 0],
    ['5201', 'الرواتب والأجور', 'EXPENSE', '5', 0, 0],
    ['5202', 'الإيجارات والكهرباء والصيانة', 'EXPENSE', '5', 0, 0],
    ['5203', 'هالك وتالف السوبر ماركت', 'EXPENSE', '5', 0, 0],
    ['5204', 'مصروفات تشغيلية متنوعة', 'EXPENSE', '5', 0, 0]
  ];
  for (const acc of coa) {
    await runAsync(
      `INSERT OR IGNORE INTO Accounts (Code, Name, Type, ParentCode, IsGroup, Balance) VALUES (?, ?, ?, ?, ?, ?)`,
      acc
    );
  }

  await runAsync(
    `INSERT OR IGNORE INTO Parties (Id, Name, Type, Phone, CreditLimit, OpeningBalance, Balance)
     VALUES (1, 'عميل نقدي عام', 'CUSTOMER', '', 0, 0, 0)`
  );

  const futureExpiry = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const farExpiry = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  const sampleItems = [
    ['6281001001', '00101', 'حليب طازج كامل الدسم 1 لتر', 'ألبان', 'حبة', 1, 4.50, 6.00, 15, 50, 10, futureExpiry],
    ['6281001002', '00102', 'جبن أبيض طازج بالكيلو', 'أجبان وميزان', 'كيلو', 1, 22.00, 30.00, 15, 18, 5, futureExpiry],
    ['6281001003', '00103', 'عصير طبيعي مشكل 1 لتر', 'مشروبات', 'حبة', 1, 5.00, 7.00, 15, 40, 8, farExpiry],
    ['6281001004', '00104', 'زيت نباتي للطبخ 1.5 لتر', 'مواد غذائية', 'حبة', 1, 14.00, 18.50, 15, 30, 6, farExpiry],
    ['6281001005', '00105', 'أرز بسمتي 5 كجم', 'مواد غذائية', 'كيس', 1, 28.00, 36.00, 15, 25, 5, farExpiry],
    ['6281001006', '00106', 'كرتون مياه معدنية 24×330مل', 'مشروبات', 'كرتون*24', 24, 11.00, 15.00, 15, 60, 12, farExpiry]
  ];
  for (const it of sampleItems) {
    await runAsync(
      `INSERT OR IGNORE INTO Items (Barcode, ScaleCode, Name, Category, Unit, PackMultiplier, CostPrice, SalePrice, TaxRate, StockQty, MinStock, ExpiryDate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      it
    );
  }

  const waterItem = await getAsync(`SELECT Id, CostPrice, SalePrice FROM Items WHERE Barcode = '6281001006'`);
  if (waterItem) {
    await runAsync(
      `INSERT OR IGNORE INTO ItemUnits (ItemId, UnitName, Barcode, Multiplier, SalePrice, CostPrice)
       VALUES (?, 'حبة (مفرّق)', '6281001006-U1', 0.0417, 1.00, 0.50)`,
      [waterItem.Id]
    );
  }
}

// المصادقة والمستخدمون
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await getAsync(`SELECT * FROM Users WHERE Username = ? AND IsActive = 1`, [username]);
    if (!user || user.Password !== password) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }
    let permissions = {};
    try { permissions = JSON.parse(user.PermissionsJson || '{}'); } catch (_) {}
    await logAudit(user.Id, 'LOGIN', 'USER', user.Id, null, { username: user.Username, role: user.Role });
    res.json({
      id: user.Id,
      username: user.Username,
      fullName: user.FullName,
      role: user.Role,
      maxDiscountPercent: user.MaxDiscountPercent,
      permissions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const rows = await allAsync(`SELECT Id, Username, FullName, Role, MaxDiscountPercent, PermissionsJson, IsActive FROM Users`);
    res.json(rows.map(r => ({ ...r, permissions: JSON.parse(r.PermissionsJson || '{}') })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const { username, password, fullName, role, maxDiscountPercent, permissions, actorId } = req.body;
    const r = await runAsync(
      `INSERT INTO Users (Username, Password, FullName, Role, MaxDiscountPercent, PermissionsJson, IsActive)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [username, password || '1234', fullName, role || 'CASHIER', Number(maxDiscountPercent || 0), JSON.stringify(permissions || {})]
    );
    await logAudit(actorId || 1, 'CREATE', 'USER', r.id, null, { username, fullName, role });
    res.json({ id: r.id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:id/permissions', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const oldUser = await getAsync(`SELECT Id, Username, Role, MaxDiscountPercent, PermissionsJson FROM Users WHERE Id = ?`, [id]);
    const { role, maxDiscountPercent, permissions, isActive, actorId } = req.body;
    await runAsync(
      `UPDATE Users SET Role = COALESCE(?, Role), MaxDiscountPercent = COALESCE(?, MaxDiscountPercent),
       PermissionsJson = ?, IsActive = COALESCE(?, IsActive) WHERE Id = ?`,
      [role, maxDiscountPercent, JSON.stringify(permissions || {}), isActive, id]
    );
    await logAudit(actorId || 1, 'UPDATE', 'USER_PERMISSIONS', id, oldUser, { role, maxDiscountPercent, permissions, isActive });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// الإعدادات والنسخ الاحتياطي
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await allAsync(`SELECT SettingKey, SettingValue FROM SystemSettings`);
    const obj = {};
    rows.forEach(r => { obj[r.SettingKey] = r.SettingValue; });
    res.json(obj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { settings, actorId } = req.body;
    for (const [k, v] of Object.entries(settings || {})) {
      await runAsync(
        `INSERT INTO SystemSettings (SettingKey, SettingValue) VALUES (?, ?)
         ON CONFLICT(SettingKey) DO UPDATE SET SettingValue = excluded.SettingValue`,
        [k, String(v ?? '')]
      );
    }
    await logAudit(actorId || 1, 'UPDATE', 'SETTINGS', null, null, settings);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/backup', async (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `rkaz_backup_${stamp}.db`;
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, fileName));
    await logAudit(req.body?.actorId || 1, 'BACKUP', 'DATABASE', null, null, { fileName });
    res.json({ ok: true, fileName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/backups', (req, res) => {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return res.json([]);
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db'))
      .sort()
      .reverse()
      .map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { fileName: f, sizeBytes: st.size, createdAt: st.mtime };
      });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/restore', async (req, res) => {
  try {
    const { fileName, actorId } = req.body;
    const src = path.join(BACKUP_DIR, path.basename(fileName || ''));
    if (!fs.existsSync(src)) return res.status(404).json({ error: 'ملف النسخة غير موجود' });
    fs.copyFileSync(src, DB_PATH);
    await logAudit(actorId || 1, 'RESTORE', 'DATABASE', null, null, { fileName });
    res.json({ ok: true, message: 'تمت الاستعادة؛ يُفضل إعادة تشغيل الخادم لتحديث الاتصال.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// الحسابات والقيود والسندات والفترات
app.get('/api/accounts', async (req, res) => {
  try { res.json(await allAsync(`SELECT * FROM Accounts ORDER BY Code ASC`)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/accounts', async (req, res) => {
  try {
    const { code, name, type, parentCode, isGroup, openingBalance, actorId } = req.body;
    const bal = Number(openingBalance || 0);
    await runAsync(
      `INSERT INTO Accounts (Code, Name, Type, ParentCode, IsGroup, Balance) VALUES (?, ?, ?, ?, ?, ?)`,
      [code, name, type, parentCode || null, isGroup ? 1 : 0, bal]
    );
    await logAudit(actorId || 1, 'CREATE', 'ACCOUNT', code, null, { code, name, type, bal });
    res.json({ ok: true, code });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/journals', async (req, res) => {
  try {
    const { debitAccount, creditAccount, amount, description, refType, refId, date, actorId } = req.body;
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'المبلغ يجب أن يكون أكبر من صفر' });
    await ensureNotLockedPeriod(date);
    const jNum = 'JRN-' + Date.now();
    await withTransaction(async () => {
      await runAsync(
        `INSERT INTO Journals (JournalNumber, RefType, RefId, Description, DebitAccount, CreditAccount, Amount)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [jNum, refType || 'MANUAL', refId || null, description || 'قيد محاسبي', debitAccount, creditAccount, amt]
      );
      await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = ?`, [amt, debitAccount]);
      await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = ?`, [amt, creditAccount]);
      await logAudit(actorId || 1, 'CREATE', 'JOURNAL', jNum, null, { debitAccount, creditAccount, amt, description });
    });
    res.json({ ok: true, journalNumber: jNum });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/journals', async (req, res) => {
  try { res.json(await allAsync(`SELECT * FROM Journals ORDER BY Id DESC LIMIT 200`)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/vouchers', async (req, res) => {
  try {
    const { type, accountCode, counterAccountCode, partyId, amount, paymentMethod, description, actorId } = req.body;
    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'مبلغ السند غير صحيح' });
    await ensureNotLockedPeriod();
    const vNum = (type === 'RECEIPT' ? 'RCV-' : 'PAY-') + Date.now();
    await withTransaction(async () => {
      await runAsync(
        `INSERT INTO Vouchers (VoucherNumber, Type, AccountCode, CounterAccountCode, PartyId, Amount, PaymentMethod, Description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [vNum, type, accountCode, counterAccountCode, partyId || null, amt, paymentMethod || 'CASH', description || '']
      );
      if (type === 'RECEIPT') {
        await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = ?`, [amt, accountCode]);
        await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = ?`, [amt, counterAccountCode]);
        if (partyId) await runAsync(`UPDATE Parties SET Balance = Balance - ? WHERE Id = ?`, [amt, partyId]);
      } else {
        await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = ?`, [amt, accountCode]);
        await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = ?`, [amt, counterAccountCode]);
        if (partyId) await runAsync(`UPDATE Parties SET Balance = Balance - ? WHERE Id = ?`, [amt, partyId]);
      }
      await runAsync(
        `INSERT INTO Journals (JournalNumber, RefType, RefId, Description, DebitAccount, CreditAccount, Amount)
         VALUES (?, 'VOUCHER', ?, ?, ?, ?, ?)`,
        [
          'JRN-' + Date.now(), vNum,
          description || (type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'),
          type === 'RECEIPT' ? accountCode : counterAccountCode,
          type === 'RECEIPT' ? counterAccountCode : accountCode,
          amt
        ]
      );
      await logAudit(actorId || 1, 'CREATE', 'VOUCHER', vNum, null, { type, amt, accountCode, counterAccountCode });
    });
    res.json({ ok: true, voucherNumber: vNum });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/vouchers', async (req, res) => {
  try { res.json(await allAsync(`SELECT * FROM Vouchers ORDER BY Id DESC LIMIT 100`)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/fiscal-periods', async (req, res) => {
  try { res.json(await allAsync(`SELECT * FROM FiscalPeriods ORDER BY StartDate DESC`)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/fiscal-periods', async (req, res) => {
  try {
    const { periodName, startDate, endDate, actorId } = req.body;
    const r = await runAsync(
      `INSERT INTO FiscalPeriods (PeriodName, StartDate, EndDate, IsLocked) VALUES (?, ?, ?, 0)`,
      [periodName, startDate, endDate]
    );
    await logAudit(actorId || 1, 'CREATE', 'FISCAL_PERIOD', r.id, null, { periodName, startDate, endDate });
    res.json({ id: r.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/fiscal-periods/:id/toggle', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const period = await getAsync(`SELECT * FROM FiscalPeriods WHERE Id = ?`, [id]);
    if (!period) return res.status(404).json({ error: 'الفترة غير موجودة' });
    const nextLock = period.IsLocked ? 0 : 1;
    await runAsync(
      `UPDATE FiscalPeriods SET IsLocked = ?, LockedBy = ?, LockedAt = ? WHERE Id = ?`,
      [nextLock, req.body?.actorId || 1, nextLock ? new Date().toISOString() : null, id]
    );
    await logAudit(req.body?.actorId || 1, nextLock ? 'LOCK_PERIOD' : 'UNLOCK_PERIOD', 'FISCAL_PERIOD', id, period, { isLocked: nextLock });
    res.json({ ok: true, isLocked: nextLock });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/audit-logs', async (req, res) => {
  try { res.json(await allAsync(`SELECT * FROM AuditLogs ORDER BY Id DESC LIMIT 200`)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// العملاء والموردين وكشف الحساب التفصيلي
app.get('/api/parties', async (req, res) => {
  try { res.json(await allAsync(`SELECT * FROM Parties ORDER BY Id ASC`)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parties', async (req, res) => {
  try {
    const { name, type, phone, creditLimit, openingBalance, actorId } = req.body;
    const opBal = Number(openingBalance || 0);
    const r = await runAsync(
      `INSERT INTO Parties (Name, Type, Phone, CreditLimit, OpeningBalance, Balance) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, type || 'CUSTOMER', phone || '', Number(creditLimit || 0), opBal, opBal]
    );
    await logAudit(actorId || 1, 'CREATE', 'PARTY', r.id, null, { name, type, opBal });
    res.json({ id: r.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/parties/:id/statement', async (req, res) => {
  try {
    const partyId = Number(req.params.id);
    const party = await getAsync(`SELECT * FROM Parties WHERE Id = ?`, [partyId]);
    if (!party) return res.status(404).json({ error: 'الطرف غير موجود' });

    const invoices = await allAsync(`SELECT * FROM Invoices WHERE PartyId = ? ORDER BY Id ASC`, [partyId]);
    const vouchers = await allAsync(`SELECT * FROM Vouchers WHERE PartyId = ? ORDER BY Id ASC`, [partyId]);

    const entries = [];
    invoices.forEach(inv => {
      const isDebit = party.Type === 'CUSTOMER' ? inv.Type === 'SALE' : inv.Type === 'PURCHASE';
      entries.push({
        date: inv.CreatedAt,
        ref: inv.InvoiceNumber,
        desc: `${inv.Type === 'SALE' ? 'فاتورة مبيعات' : inv.Type === 'PURCHASE' ? 'فاتورة مشتريات' : 'مرتجع'} (${inv.PaymentMethod})`,
        debit: isDebit ? Number(inv.NetTotal) : 0,
        credit: !isDebit ? Number(inv.NetTotal) : 0
      });
    });
    vouchers.forEach(v => {
      entries.push({
        date: v.CreatedAt,
        ref: v.VoucherNumber,
        desc: v.Description || (v.Type === 'RECEIPT' ? 'سند قبض' : 'سند صرف'),
        debit: v.Type === 'PAYMENT' ? Number(v.Amount) : 0,
        credit: v.Type === 'RECEIPT' ? Number(v.Amount) : 0
      });
    });

    entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    let running = Number(party.OpeningBalance || 0);
    const rows = entries.map(e => {
      running = Number((running + e.debit - e.credit).toFixed(2));
      return { ...e, balance: running };
    });

    res.json({ party, openingBalance: Number(party.OpeningBalance || 0), rows, closingBalance: running });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// الأصناف والوحدات والهالك والجرد الأعمى
app.get('/api/items', async (req, res) => {
  try {
    const items = await allAsync(`SELECT * FROM Items WHERE IsActive = 1 ORDER BY Id DESC`);
    const units = await allAsync(`SELECT * FROM ItemUnits ORDER BY Id ASC`);
    const map = {};
    units.forEach(u => {
      if (!map[u.ItemId]) map[u.ItemId] = [];
      map[u.ItemId].push(u);
    });
    res.json(items.map(i => ({ ...i, units: map[i.Id] || [] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/items', async (req, res) => {
  try {
    const { barcode, scaleCode, name, category, unit, packMultiplier, costPrice, salePrice, taxRate, stockQty, minStock, expiryDate, actorId } = req.body;
    const r = await runAsync(
      `INSERT INTO Items (Barcode, ScaleCode, Name, Category, Unit, PackMultiplier, CostPrice, SalePrice, TaxRate, StockQty, MinStock, ExpiryDate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        barcode, scaleCode || null, name, category || 'عام', unit || 'حبة', Number(packMultiplier || 1),
        Number(costPrice || 0), Number(salePrice || 0), Number(taxRate ?? 15),
        Number(stockQty || 0), Number(minStock ?? 5), expiryDate || null
      ]
    );
    await logAudit(actorId || 1, 'CREATE', 'ITEM', r.id, null, { barcode, scaleCode, name, salePrice, stockQty, expiryDate });
    res.json({ id: r.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/items/:id/units', async (req, res) => {
  try {
    const itemId = Number(req.params.id);
    const { unitName, barcode, multiplier, salePrice, costPrice, actorId } = req.body;
    const r = await runAsync(
      `INSERT INTO ItemUnits (ItemId, UnitName, Barcode, Multiplier, SalePrice, CostPrice)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [itemId, unitName, barcode, Number(multiplier || 1), Number(salePrice || 0), Number(costPrice || 0)]
    );
    await logAudit(actorId || 1, 'CREATE', 'ITEM_UNIT', r.id, null, { itemId, unitName, barcode, multiplier });
    res.json({ id: r.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/wastage', async (req, res) => {
  try {
    const { itemId, qty, reason, userId } = req.body;
    const item = await getAsync(`SELECT * FROM Items WHERE Id = ?`, [itemId]);
    if (!item) return res.status(404).json({ error: 'الصنف غير موجود' });
    const q = Number(qty || 0);
    if (q <= 0) return res.status(400).json({ error: 'الكمية يجب أن تكون أكبر من صفر' });

    const totalCost = Number((q * Number(item.CostPrice || 0)).toFixed(2));
    await withTransaction(async () => {
      await runAsync(`UPDATE Items SET StockQty = StockQty - ? WHERE Id = ?`, [q, item.Id]);
      await runAsync(
        `INSERT INTO WastageLogs (ItemId, ItemName, Barcode, Qty, UnitCost, TotalCost, Reason, UserId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [item.Id, item.Name, item.Barcode, q, Number(item.CostPrice || 0), totalCost, reason || 'هالك / تالف', userId || 1]
      );
      await runAsync(
        `INSERT INTO StockMovements (ItemId, ItemName, MovementType, QtyChange, CostImpact, RefDoc)
         VALUES (?, ?, 'WASTAGE', ?, ?, ?)`,
        [item.Id, item.Name, -q, -totalCost, reason || 'هالك']
      );
      if (totalCost > 0) {
        await runAsync(
          `INSERT INTO Journals (JournalNumber, RefType, RefId, Description, DebitAccount, CreditAccount, Amount)
           VALUES (?, 'WASTAGE', ?, ?, '5203', '1104', ?)`,
          ['JRN-' + Date.now(), String(item.Id), `هالك صنف: ${item.Name} (${reason || 'تالف'})`, totalCost]
        );
        await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '5203'`, [totalCost]);
        await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = '1104'`, [totalCost]);
      }
      await logAudit(userId || 1, 'WASTAGE', 'ITEM', item.Id, null, { qty: q, totalCost, reason });
    });

    res.json({ ok: true, totalCost });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/wastage', async (req, res) => {
  try { res.json(await allAsync(`SELECT * FROM WastageLogs ORDER BY Id DESC LIMIT 100`)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/stock-count', async (req, res) => {
  try {
    const { counts = [], notes, actorId } = req.body;
    await withTransaction(async () => {
      for (const c of counts) {
        const item = await getAsync(`SELECT * FROM Items WHERE Id = ?`, [c.itemId]);
        if (!item) continue;
        const actualQty = Number(c.actualQty);
        const diff = Number((actualQty - Number(item.StockQty)).toFixed(3));
        const costDiff = Number((diff * Number(item.CostPrice || 0)).toFixed(2));
        await runAsync(`UPDATE Items SET StockQty = ? WHERE Id = ?`, [actualQty, item.Id]);
        await runAsync(
          `INSERT INTO StockMovements (ItemId, ItemName, MovementType, QtyChange, CostImpact, RefDoc)
           VALUES (?, ?, 'BLIND_COUNT', ?, ?, ?)`,
          [item.Id, item.Name, diff, costDiff, notes || 'جرد أعمى']
        );
        if (costDiff !== 0) {
          const absVal = Math.abs(costDiff);
          const debitAcc = costDiff > 0 ? '1104' : '5203';
          const creditAcc = costDiff > 0 ? '5203' : '1104';
          await runAsync(
            `INSERT INTO Journals (JournalNumber, RefType, RefId, Description, DebitAccount, CreditAccount, Amount)
             VALUES (?, 'BLIND_COUNT', ?, ?, ?, ?, ?)`,
            ['JRN-' + Date.now() + '-' + item.Id, String(item.Id), `فارق جرد أعمى: ${item.Name}`, debitAcc, creditAcc, absVal]
          );
          await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = ?`, [absVal, debitAcc]);
          await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = ?`, [absVal, creditAcc]);
        }
      }
      await logAudit(actorId || 1, 'BLIND_COUNT', 'STOCK', null, null, { itemsCount: counts.length, notes });
    });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// العروض الترويجية
app.get('/api/promotions', async (req, res) => {
  try {
    const promos = await allAsync(`SELECT * FROM Promotions ORDER BY Priority DESC, Id DESC`);
    const promoItems = await allAsync(`SELECT * FROM PromotionItems ORDER BY Id ASC`);
    const map = {};
    promoItems.forEach(pi => {
      if (!map[pi.PromotionId]) map[pi.PromotionId] = [];
      map[pi.PromotionId].push(pi);
    });
    res.json(promos.map(p => ({ ...p, items: map[p.Id] || [] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/promotions', async (req, res) => {
  try {
    const { name, priority, conditionType, startDate, endDate, isActive, actorId } = req.body;
    const r = await runAsync(
      `INSERT INTO Promotions (Name, Priority, ConditionType, StartDate, EndDate, IsActive) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, Number(priority || 1), conditionType || 'ITEM_QTY', startDate, endDate || null, isActive === 0 ? 0 : 1]
    );
    await logAudit(actorId || 1, 'CREATE', 'PROMOTION', r.id, null, { name, priority, conditionType, startDate, endDate });
    res.json({ id: r.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.put('/api/promotions/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const oldP = await getAsync(`SELECT * FROM Promotions WHERE Id = ?`, [id]);
    const { name, priority, conditionType, startDate, endDate, isActive, actorId } = req.body;
    await runAsync(
      `UPDATE Promotions SET Name = COALESCE(?, Name), Priority = COALESCE(?, Priority),
       ConditionType = COALESCE(?, ConditionType), StartDate = COALESCE(?, StartDate),
       EndDate = ?, IsActive = COALESCE(?, IsActive) WHERE Id = ?`,
      [name, priority !== undefined ? Number(priority) : null, conditionType, startDate, endDate || null, isActive !== undefined ? Number(isActive) : null, id]
    );
    await logAudit(actorId || 1, 'UPDATE', 'PROMOTION', id, oldP, { name, priority, conditionType, startDate, endDate, isActive });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/promotions/:id', async (req, res) => {
  try {
    await runAsync(`DELETE FROM Promotions WHERE Id = ?`, [Number(req.params.id)]);
    await logAudit(req.body?.actorId || 1, 'DELETE', 'PROMOTION', Number(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/promotions/:id/items', async (req, res) => {
  try {
    const promoId = Number(req.params.id);
    const { itemId, unit, promoPriceInclTax, promoPriceExclTax, requiredQty, secondQty, maxPerCustomer, limitCap, actorId } = req.body;
    const item = await getAsync(`SELECT * FROM Items WHERE Id = ?`, [itemId]);
    if (!item) return res.status(404).json({ error: 'الصنف غير موجود' });

    const taxPct = Number(item.TaxRate || 15);
    const incl = promoPriceInclTax !== undefined && promoPriceInclTax !== ''
      ? Number(promoPriceInclTax)
      : Number((Number(promoPriceExclTax || 0) * (1 + taxPct / 100)).toFixed(2));
    const excl = promoPriceExclTax !== undefined && promoPriceExclTax !== ''
      ? Number(promoPriceExclTax)
      : Number((incl / (1 + taxPct / 100)).toFixed(2));

    const r = await runAsync(
      `INSERT INTO PromotionItems (PromotionId, ItemId, Barcode, ItemName, Unit, PromoPriceInclTax, PromoPriceExclTax, RequiredQty, SecondQty, MaxPerCustomer, LimitCap)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [promoId, item.Id, item.Barcode, item.Name, unit || item.Unit, incl, excl, Number(requiredQty || 1), Number(secondQty || 0), Number(maxPerCustomer || 0), Number(limitCap || 0)]
    );
    await logAudit(actorId || 1, 'ADD_ITEM', 'PROMOTION', promoId, null, { itemId: item.Id, incl, excl });
    res.json({ id: r.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/promotion-items/:id', async (req, res) => {
  try {
    await runAsync(`DELETE FROM PromotionItems WHERE Id = ?`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// الفواتير المعلّقة في قاعدة البيانات
app.get('/api/held-invoices', async (req, res) => {
  try {
    const rows = await allAsync(`SELECT * FROM HeldInvoices ORDER BY Id DESC`);
    res.json(rows.map(r => ({ ...r, items: JSON.parse(r.ItemsJson || '[]') })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/held-invoices', async (req, res) => {
  try {
    const { partyId, partyName, globalDiscount, items } = req.body;
    const r = await runAsync(
      `INSERT INTO HeldInvoices (PartyId, PartyName, GlobalDiscount, ItemsJson) VALUES (?, ?, ?, ?)`,
      [partyId || 1, partyName || 'عميل نقدي عام', Number(globalDiscount || 0), JSON.stringify(items || [])]
    );
    res.json({ id: r.id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/held-invoices/:id', async (req, res) => {
  try {
    await runAsync(`DELETE FROM HeldInvoices WHERE Id = ?`, [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// الورديات
app.get('/api/shifts/current', async (req, res) => {
  try { res.json((await getAsync(`SELECT * FROM CashShifts WHERE Status = 'OPEN' ORDER BY Id DESC LIMIT 1`)) || null); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/shifts/open', async (req, res) => {
  try {
    const existing = await getAsync(`SELECT Id FROM CashShifts WHERE Status = 'OPEN' LIMIT 1`);
    if (existing) return res.status(400).json({ error: 'توجد وردية مفتوحة بالفعل' });
    const { userId, cashierName, openingBalance, cashAccountCode } = req.body;
    const openBal = Number(openingBalance || 0);
    const r = await runAsync(
      `INSERT INTO CashShifts (UserId, CashierName, CashAccountCode, OpenedAt, OpeningBalance, ExpectedBalance, Status)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN')`,
      [userId || 1, cashierName || 'كاشير', cashAccountCode || '1101', new Date().toISOString(), openBal, openBal]
    );
    await logAudit(userId || 1, 'SHIFT_OPEN', 'SHIFT', r.id, null, { openingBalance: openBal });
    res.json(await getAsync(`SELECT * FROM CashShifts WHERE Id = ?`, [r.id]));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/shifts/:id/close', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const shift = await getAsync(`SELECT * FROM CashShifts WHERE Id = ? AND Status = 'OPEN'`, [id]);
    if (!shift) return res.status(404).json({ error: 'الوردية غير موجودة أو مغلقة' });

    const actual = Number(req.body.actualBalance || 0);
    const expected = Number(shift.ExpectedBalance || 0);
    const variance = Number((actual - expected).toFixed(2));

    await withTransaction(async () => {
      await runAsync(
        `UPDATE CashShifts SET ClosedAt = ?, ActualBalance = ?, Variance = ?, Status = 'CLOSED', Notes = ? WHERE Id = ?`,
        [new Date().toISOString(), actual, variance, req.body.notes || '', id]
      );
      if (variance !== 0) {
        const absV = Math.abs(variance);
        const debitAcc = variance > 0 ? shift.CashAccountCode : '2103';
        const creditAcc = variance > 0 ? '2103' : shift.CashAccountCode;
        await runAsync(
          `INSERT INTO Journals (JournalNumber, RefType, RefId, Description, DebitAccount, CreditAccount, Amount)
           VALUES (?, 'SHIFT_VAR', ?, ?, ?, ?, ?)`,
          ['JRN-' + Date.now(), String(id), `فرق إغلاق وردية #${id}`, debitAcc, creditAcc, absV]
        );
        await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = ?`, [absV, debitAcc]);
        await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = ?`, [absV, creditAcc]);
      }
      await logAudit(req.body.actorId || shift.UserId, 'SHIFT_CLOSE', 'SHIFT', id, shift, { actual, expected, variance });
    });

    res.json({ ok: true, expected, actual, variance });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// الفواتير والترحيل المحاسبي والمخزني
app.get('/api/invoices', async (req, res) => {
  try {
    const rows = await allAsync(`SELECT * FROM Invoices ORDER BY Id DESC LIMIT 200`);
    res.json(rows.map(r => ({ ...r, items: JSON.parse(r.ItemsJson || '[]') })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/invoices', async (req, res) => {
  try {
    const {
      type = 'SALE', paymentMethod = 'CASH', partyId = 1, partyName = 'عميل نقدي عام',
      shiftId = null, userId = 1, userRole = 'CASHIER', maxDiscountPercent = 0,
      discountTotal = 0, paidCash = 0, paidCard = 0, items = [], date
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'الفاتورة لا تحتوي على أصناف' });
    }

    await ensureNotLockedPeriod(date);

    let subtotal = 0;
    let lineDiscTotal = 0;
    for (const line of items) {
      const qty = Number(line.qty || 0);
      const price = Number(line.unitPrice || 0);
      const disc = Number(line.discount || 0);
      subtotal += qty * price;
      lineDiscTotal += disc;
    }

    const totalDiscount = Number((lineDiscTotal + Number(discountTotal || 0)).toFixed(2));
    const discPct = subtotal > 0 ? (totalDiscount / subtotal) * 100 : 0;
    if (userRole !== 'ADMIN' && discPct > Number(maxDiscountPercent || 0) + 0.01) {
      return res.status(403).json({
        error: `نسبة الخصم (${discPct.toFixed(1)}%) تتجاوز الحد المسموح للمستخدم (${maxDiscountPercent}%)`
      });
    }

    const netInclTax = Math.max(0, Number((subtotal - totalDiscount).toFixed(2)));
    const taxableAmount = Number((netInclTax / 1.15).toFixed(2));
    const taxTotal = Number((netInclTax - taxableAmount).toFixed(2));
    const invNum = (type === 'RETURN' ? 'RTN-' : type === 'PURCHASE' ? 'PUR-' : 'INV-') + Date.now();

    const paidCashNum = Number(paidCash || 0);
    const paidCardNum = Number(paidCard || 0);
    const changeAmount = Math.max(0, Number(((paidCashNum + paidCardNum) - netInclTax).toFixed(2)));

    await withTransaction(async () => {
      await runAsync(
        `INSERT INTO Invoices (InvoiceNumber, Type, PaymentMethod, PartyId, PartyName, ShiftId, UserId,
         Subtotal, DiscountTotal, TaxableAmount, TaxTotal, NetTotal, PaidCash, PaidCard, ChangeAmount, Status, ItemsJson)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?)`,
        [
          invNum, type, paymentMethod, partyId || 1, partyName, shiftId, userId,
          subtotal, totalDiscount, taxableAmount, taxTotal, netInclTax, paidCashNum, paidCardNum, changeAmount,
          JSON.stringify(items)
        ]
      );

      let totalCost = 0;
      for (const line of items) {
        const baseQty = Number(line.qty || 0) * Number(line.multiplier || 1);
        const dbItem = line.itemId
          ? await getAsync(`SELECT * FROM Items WHERE Id = ?`, [line.itemId])
          : await getAsync(`SELECT * FROM Items WHERE Barcode = ?`, [line.barcode]);

        if (dbItem) {
          totalCost += baseQty * Number(dbItem.CostPrice || 0);
          if (type === 'SALE') {
            await runAsync(`UPDATE Items SET StockQty = StockQty - ? WHERE Id = ?`, [baseQty, dbItem.Id]);
            await runAsync(
              `INSERT INTO StockMovements (ItemId, ItemName, MovementType, QtyChange, CostImpact, RefDoc)
               VALUES (?, ?, 'SALE', ?, ?, ?)`,
              [dbItem.Id, dbItem.Name, -baseQty, -(baseQty * dbItem.CostPrice), invNum]
            );
          } else if (type === 'RETURN') {
            await runAsync(`UPDATE Items SET StockQty = StockQty + ? WHERE Id = ?`, [baseQty, dbItem.Id]);
            await runAsync(
              `INSERT INTO StockMovements (ItemId, ItemName, MovementType, QtyChange, CostImpact, RefDoc)
               VALUES (?, ?, 'RETURN', ?, ?, ?)`,
              [dbItem.Id, dbItem.Name, baseQty, baseQty * dbItem.CostPrice, invNum]
            );
          } else if (type === 'PURCHASE') {
            const newAvgCost = (Number(dbItem.StockQty) + baseQty) > 0
              ? Number((((Number(dbItem.StockQty) * Number(dbItem.CostPrice)) + (baseQty * Number(line.unitCost || line.unitPrice || dbItem.CostPrice))) / (Number(dbItem.StockQty) + baseQty)).toFixed(4))
              : Number(dbItem.CostPrice);

            await runAsync(`UPDATE Items SET StockQty = StockQty + ?, CostPrice = ? WHERE Id = ?`, [baseQty, newAvgCost, dbItem.Id]);
            await runAsync(
              `INSERT INTO StockMovements (ItemId, ItemName, MovementType, QtyChange, CostImpact, RefDoc)
               VALUES (?, ?, 'PURCHASE', ?, ?, ?)`,
              [dbItem.Id, dbItem.Name, baseQty, baseQty * newAvgCost, invNum]
            );
          }
        }
      }

      const jNum = 'JRN-' + Date.now();
      if (type === 'SALE') {
        const cashCollected = paymentMethod === 'CASH' ? netInclTax : (paymentMethod === 'MIXED' ? Math.max(0, Math.min(netInclTax, paidCashNum - changeAmount)) : 0);
        const cardCollected = paymentMethod === 'CARD' ? netInclTax : (paymentMethod === 'MIXED' ? paidCardNum : 0);

        if (cashCollected > 0) await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '1101'`, [cashCollected]);
        if (cardCollected > 0) await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '1102'`, [cardCollected]);
        if (paymentMethod === 'CREDIT') {
          await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '1103'`, [netInclTax]);
          if (partyId) await runAsync(`UPDATE Parties SET Balance = Balance + ? WHERE Id = ?`, [netInclTax, partyId]);
        }
        await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '4101'`, [taxableAmount]);
        await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '2102'`, [taxTotal]);

        if (totalCost > 0) {
          await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = '1104'`, [totalCost]);
          await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '5101'`, [totalCost]);
        }

        await runAsync(
          `INSERT INTO Journals (JournalNumber, RefType, RefId, Description, DebitAccount, CreditAccount, Amount)
           VALUES (?, 'SALE', ?, ?, ?, '4101', ?)`,
          [jNum, invNum, `فاتورة مبيعات ${invNum}`, paymentMethod === 'CREDIT' ? '1103' : (cardCollected > 0 ? '1102' : '1101'), taxableAmount]
        );

        if (shiftId) {
          await runAsync(
            `UPDATE CashShifts SET CashSales = CashSales + ?, CardSales = CardSales + ?, ExpectedBalance = ExpectedBalance + ? WHERE Id = ?`,
            [cashCollected, cardCollected, cashCollected, shiftId]
          );
        }
      } else if (type === 'RETURN') {
        await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = '1101'`, [netInclTax]);
        await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '4102'`, [taxableAmount]);
        await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = '2102'`, [taxTotal]);
        if (totalCost > 0) {
          await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '1104'`, [totalCost]);
          await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = '5101'`, [totalCost]);
        }
        await runAsync(
          `INSERT INTO Journals (JournalNumber, RefType, RefId, Description, DebitAccount, CreditAccount, Amount)
           VALUES (?, 'RETURN', ?, ?, '4102', '1101', ?)`,
          [jNum, invNum, `مرتجع مبيعات ${invNum}`, netInclTax]
        );
        if (shiftId) {
          await runAsync(
            `UPDATE CashShifts SET ReturnsTotal = ReturnsTotal + ?, ExpectedBalance = ExpectedBalance - ? WHERE Id = ?`,
            [netInclTax, netInclTax, shiftId]
          );
        }
      } else if (type === 'PURCHASE') {
        await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '1104'`, [taxableAmount]);
        await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '2102'`, [taxTotal]);
        if (paymentMethod === 'CREDIT') {
          await runAsync(`UPDATE Accounts SET Balance = Balance + ? WHERE Code = '2101'`, [netInclTax]);
          if (partyId) await runAsync(`UPDATE Parties SET Balance = Balance + ? WHERE Id = ?`, [netInclTax, partyId]);
        } else {
          await runAsync(`UPDATE Accounts SET Balance = Balance - ? WHERE Code = '1101'`, [netInclTax]);
        }
        await runAsync(
          `INSERT INTO Journals (JournalNumber, RefType, RefId, Description, DebitAccount, CreditAccount, Amount)
           VALUES (?, 'PURCHASE', ?, ?, '1104', ?, ?)`,
          [jNum, invNum, `فاتورة مشتريات ${invNum}`, paymentMethod === 'CREDIT' ? '2101' : '1101', taxableAmount]
        );
      }

      await logAudit(userId, 'CREATE', 'INVOICE', invNum, null, { type, paymentMethod, netInclTax });
    });

    res.json({ ok: true, invoiceNumber: invNum, netTotal: netInclTax, changeAmount });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// التقارير والملخص
app.get('/api/reports/summary', async (req, res) => {
  try {
    const days = Number(req.query.expiryDays || 7);
    const alertDate = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

    const sales = await getAsync(`SELECT COALESCE(SUM(NetTotal), 0) AS total FROM Invoices WHERE Type = 'SALE'`);
    const returns = await getAsync(`SELECT COALESCE(SUM(NetTotal), 0) AS total FROM Invoices WHERE Type = 'RETURN'`);
    const purchases = await getAsync(`SELECT COALESCE(SUM(NetTotal), 0) AS total FROM Invoices WHERE Type = 'PURCHASE'`);
    const wastage = await getAsync(`SELECT COALESCE(SUM(TotalCost), 0) AS total FROM WastageLogs`);
    const stockVal = await getAsync(`SELECT COALESCE(SUM(StockQty * CostPrice), 0) AS total FROM Items WHERE IsActive = 1`);
    const lowStock = await allAsync(`SELECT * FROM Items WHERE IsActive = 1 AND StockQty <= MinStock`);
    const expiring = await allAsync(`SELECT * FROM Items WHERE IsActive = 1 AND ExpiryDate IS NOT NULL AND ExpiryDate <= ?`, [alertDate]);

    res.json({
      totalSales: sales.total,
      totalReturns: returns.total,
      totalPurchases: purchases.total,
      totalWastage: wastage.total,
      stockValueCost: stockVal.total,
      lowStockItems: lowStock,
      expiringItems: expiring
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`يعمل نظام ركاز للسوبر ماركت على http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('فشل تهيئة قاعدة البيانات:', err);
    process.exit(1);
  });
