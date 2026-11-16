import dotenv from 'dotenv';
import path from 'path';

/**
 * Pemuatan environment variable terpusat.
 *
 * Urutan pencarian file env (mengikuti perilaku aplikasi lama):
 *   production -> .env.production
 *   staging    -> .env.ngrok
 *   lainnya    -> .env.local
 *
 * Jika file tersebut tidak ada, dotenv otomatis jatuh ke `.env`.
 */
export const NODE_ENV = process.env.NODE_ENV || 'local';

export const ENV_FILE =
  NODE_ENV === 'production'
    ? '.env.production'
    : NODE_ENV === 'staging'
      ? '.env.ngrok'
      : '.env.local';

dotenv.config({ path: path.resolve(process.cwd(), ENV_FILE) });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

/**
 * Validasi JWT_SECRET — server menolak start dengan secret kosong/lemah
 * agar token tidak identik secara kriptografis antar deployment.
 */
export function validateEnv(): void {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('');
    console.error('❌ FATAL: JWT_SECRET tidak valid!');
    console.error('   Pastikan JWT_SECRET sudah di-set di env file dan panjangnya minimal 32 karakter.');
    console.error(`   Env file aktif: ${ENV_FILE}`);
    console.error('   Contoh: JWT_SECRET=your-very-long-and-secure-secret-key-here');
    console.error('');
    process.exit(1);
  }
}

export const config = {
  port: Number(process.env.PORT) || 8081,
  nodeEnv: NODE_ENV,
  isProduction: NODE_ENV === 'production',
  jwtSecret: process.env.JWT_SECRET as string,
  jwtExpiresDays: Number(process.env.JWT_EXPIRES_DAYS) || 1,
  db: {
    host: process.env.DB_HOST as string,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER as string,
    password: process.env.DB_PASSWORD as string,
    database: process.env.DB_NAME as string,
  },
  corsOrigins: process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim())
    : ['http://localhost:8181', 'http://localhost:8081'],
  dbTimezone: '+07:00',
};
