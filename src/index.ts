import './config/env';
import { config, ENV_FILE, validateEnv } from './config/env';

// ================= SET TIMEZONE =================
process.env.TZ = 'Asia/Jakarta';

console.log(`📦 Using env file: ${ENV_FILE}`);
console.log(`📍 Environment: ${config.nodeEnv}`);

// Validasi wajib sebelum server berjalan
validateEnv();

import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';

import db, { testConnection } from './config/db';
import { authenticate } from './middleware/authMiddleware';
import appVersionRouter from './modules/appVersion';
import authRouter from './modules/auth';
import clientLogsRouter from './modules/clientLogs';
import masterDataRouter from './modules/masterData';
import recruitmentRouter from './modules/recruitment';
import dashboardRouter from './modules/dashboard';
import monitoringRouter from './modules/monitoring';
import slaCron from './utils/slaCron';
import { refreshHolidaysFromDB } from './utils/workdayCalculator';
import { fullSync as syncIndexHelper } from './utils/tpkIndexSync';

// ================= INIT APP =================
const app = express();

app.set('trust proxy', 1);

// ================= MIDDLEWARE =================
app.use((req: Request, _res: Response, next: NextFunction) => {
  req.dbTimezone = config.dbTimezone;
  next();
});

// ================= CORS CONFIG =================
const allowedOrigins = config.corsOrigins;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`⛔ CORS blocked: ${origin}`);
        callback(new Error(`CORS blocked: ${origin}`));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
  })
);

// ================= CSRF PROTECTION =================
// Melindungi endpoint cookie-based (web) dari cross-site request forgery.
// Android menggunakan Bearer token → tidak terdampak, dilewati otomatis.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  if (req.headers.authorization?.startsWith('Bearer ')) return next();

  // Lapis 1: Origin header harus cocok dengan CORS_ORIGINS
  const origin = req.headers.origin;
  if (origin) {
    const isAllowed = allowedOrigins.some((o) => origin === o || origin.startsWith(o));
    if (!isAllowed) {
      console.warn(`⛔ CSRF blocked (origin): ${origin}`);
      return res.status(403).json({ success: false, message: 'Forbidden: invalid origin' });
    }
  }

  // Lapis 2: Header kustom yang tidak bisa di-set oleh cross-site script
  const xrw = req.headers['x-requested-with'];
  if (!xrw && req.cookies?.token) {
    console.warn(`⛔ CSRF blocked (missing X-Requested-With): path=${req.path}`);
    return res.status(403).json({ success: false, message: 'Forbidden: missing request header' });
  }

  next();
});

// ================= SECURITY =================
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: config.isProduction ? undefined : false,
    hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
  })
);

// ================= GLOBAL RATE LIMITER =================
const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Terlalu banyak permintaan. Coba lagi dalam 15 menit.',
  },
  skip: (req) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
    return config.nodeEnv === 'local' && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
  },
});
app.use('/api/', globalApiLimiter);

// ================= ROUTES =================
app.get('/', (_req, res) => res.send('Backend Rekruitmen is Running! 🚀'));

app.use('/api/app-version', appVersionRouter);
app.use('/api/auth', authRouter);
// Endpoint publik untuk menerima log (tanpa authenticate)
app.use('/api/logs', clientLogsRouter);
app.use('/api/master', authenticate, masterDataRouter);
app.use('/api/recruitment', authenticate, recruitmentRouter);
app.use('/api/dashboard', authenticate, dashboardRouter);
app.use('/api/monitoring', authenticate, monitoringRouter);

// ================= 404 HANDLER =================
app.use((_req: Request, res: Response) => {
  res.status(404).json({ success: false, message: 'Endpoint tidak ditemukan' });
});

// ================= GLOBAL ERROR HANDLER =================
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('❌ GLOBAL ERROR:', err);
  res.status(500).json({
    success: false,
    message: 'Terjadi kesalahan server',
    ...(config.nodeEnv !== 'production' && { error: err?.message }),
  });
});

// ================= START SERVER =================
const PORT = config.port;

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Server running on port ${PORT}`);

  // Verifikasi koneksi database lebih awal
  await testConnection().catch(() => undefined);

  // ── Load holidays DULU, tunggu selesai ──────────────────────────────────
  try {
    await refreshHolidaysFromDB(db);
    console.log('✅ Holiday data loaded from DB.');
  } catch (err) {
    console.warn('⚠️ Initial holiday load failed, fallback active:', err instanceof Error ? err.message : err);
  }

  // ── Sync shadow index table (non-blocking — cron akan retry) ────────────
  syncIndexHelper(db).catch((err: any) => {
    console.warn('⚠️ Initial tpk_index_helper sync failed (akan dicoba ulang oleh cron):', err?.message);
  });

  // ── Init SLA cron (SETELAH holidays di-load) ────────────────────────────
  try {
    slaCron.runSlaSync();
    console.log('🔄 SLA Synchronization Service started.');
  } catch (err) {
    console.error('⚠️ Failed to start SLA Sync Service:', err instanceof Error ? err.message : err);
  }
});

// Graceful shutdown agar koneksi MySQL tertutup rapi
const shutdown = async () => {
  console.log('🛑 Shutting down server...');
  server.close();
  try {
    const { pool } = await import('./config/db');
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default app;
