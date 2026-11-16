import mysql from 'mysql2/promise';
import { config } from './env';

/**
 * Pool koneksi MySQL.
 *
 * timezone '+07:00' dan dateStrings true dipertahankan persis seperti
 * aplikasi lama: DATE/DATETIME dikembalikan sebagai string agar tidak
 * bergeser akibat konversi timezone di driver.
 */
const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  timezone: '+07:00',
  dateStrings: true,
});

pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+07:00'");
});

/**
 * Tipe minimal pool agar pemakaian `db.query` / `db.execute` tetap ringkas
 * saat porting query SQL yang panjang (hasil rows bertipe any).
 */
export interface DbLike {
  query(sql: string, params?: unknown[]): Promise<[any, any]>;
  execute(sql: string, params?: unknown[]): Promise<[any, any]>;
  getConnection(): Promise<any>;
}

const db = pool as unknown as DbLike;

/** Tes koneksi awal + set timezone per connection (perilaku lama). */
export async function testConnection(): Promise<void> {
  try {
    const conn = await pool.getConnection();
    console.log(`✅ Database connected: ${config.db.database}`);
    await conn.query("SET time_zone = '+07:00'");
    conn.release();
  } catch (err) {
    console.error('❌ Database connection failed!');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

export { pool };
export default db;
