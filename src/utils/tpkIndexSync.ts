/**
 * src/utils/tpkIndexSync.ts
 *
 * Utilitas sinkronisasi shadow table rekruitmen2.tpk_index_helper.
 *
 * Shadow table ini menyimpan kolom-kolom yang paling sering digunakan sebagai
 * WHERE / ORDER-BY dari hrd2.tpermintaankaryawan, agar aplikasi baru dapat
 * melakukan indexed lookup tanpa menyentuh skema legacy hrd2.
 *
 * Pola penggunaan:
 *   - upsertRow()  → dipanggil di dalam transaksi saat INSERT/UPDATE baru
 *   - updateApproval() → dipanggil saat status approval berubah
 *   - deleteRow()  → dipanggil saat batch delete
 *   - deleteRows() → dipanggil saat batch delete banyak nomor
 *   - fullSync()   → dipanggil saat startup dan oleh slaCron setiap 5 menit
 */

import type { DbLike } from '../config/db';
import type { DbRow } from '../types';

/** Koneksi/objek apa pun yang punya `execute` (pool atau connection mysql2). */
interface ExecutableConn {
  execute(sql: string, params?: unknown[]): Promise<[any, any]>;
}

/** Baris shadow table yang di-upsert. */
export interface TpkIndexRow {
  tpk_nomor: string;
  tpk_peminta: string | null;
  tpk_approveatasan?: number;
  tpk_approveHRD?: number;
  tpk_tanggal?: string | null;
}

// ── SQL Templates ─────────────────────────────────────────────────────────────

const UPSERT_SQL = `
    INSERT INTO rekruitmen2.tpk_index_helper
        (tpk_nomor, tpk_peminta, tpk_approveatasan, tpk_approveHRD, tpk_tanggal)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
        tpk_peminta       = VALUES(tpk_peminta),
        tpk_approveatasan = VALUES(tpk_approveatasan),
        tpk_approveHRD    = VALUES(tpk_approveHRD),
        tpk_tanggal       = VALUES(tpk_tanggal),
        synced_at         = NOW()
`;

const UPDATE_APPROVAL_SQL = `
    UPDATE rekruitmen2.tpk_index_helper
    SET   tpk_approveatasan = ?,
          tpk_approveHRD    = ?,
          synced_at         = NOW()
    WHERE tpk_nomor = ?
`;

const DELETE_ONE_SQL = `
    DELETE FROM rekruitmen2.tpk_index_helper WHERE tpk_nomor = ?
`;

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Upsert satu shadow row (dipakai saat INSERT permintaan baru).
 */
export async function upsertRow(conn: ExecutableConn, row: TpkIndexRow): Promise<void> {
  const {
    tpk_nomor,
    tpk_peminta,
    tpk_approveatasan = 0,
    tpk_approveHRD = 0,
    tpk_tanggal = null,
  } = row;

  await conn.execute(UPSERT_SQL, [
    tpk_nomor,
    tpk_peminta ?? null,
    tpk_approveatasan,
    tpk_approveHRD,
    tpk_tanggal ?? null,
  ]);
}

/**
 * Update kolom approval saja — tanpa mengubah tpk_peminta & tpk_tanggal.
 * Dipakai saat atasan atau HRD melakukan APPROVE/REJECT.
 */
export async function updateApproval(
  conn: ExecutableConn,
  tpk_nomor: string,
  tpk_approveatasan: number,
  tpk_approveHRD: number
): Promise<void> {
  await conn.execute(UPDATE_APPROVAL_SQL, [tpk_approveatasan, tpk_approveHRD, tpk_nomor]);
}

/**
 * Hapus satu shadow row (jarang dipakai; ada deleteRows untuk batch).
 */
export async function deleteRow(conn: ExecutableConn, tpk_nomor: string): Promise<void> {
  await conn.execute(DELETE_ONE_SQL, [tpk_nomor]);
}

/**
 * Hapus banyak shadow row sekaligus (dipakai saat batch delete permintaan).
 */
export async function deleteRows(conn: ExecutableConn, tpkNomors: string[]): Promise<void> {
  if (!tpkNomors?.length) return;
  const placeholders = tpkNomors.map(() => '?').join(',');
  await conn.execute(
    `DELETE FROM rekruitmen2.tpk_index_helper WHERE tpk_nomor IN (${placeholders})`,
    tpkNomors
  );
}

/**
 * Full resync: tarik semua baris dari hrd2.tpermintaankaryawan lalu bulk-upsert
 * ke shadow table dalam chunk 500 baris.
 *
 * Dipanggil saat:
 *   - Server start (index.ts)
 *   - Setiap 5 menit oleh slaCron (untuk menangkap perubahan dari aplikasi legacy)
 */
export async function fullSync(db: DbLike): Promise<void> {
  const start = Date.now();

  // Gabungkan draft + live untuk shadow index PKAR
  const [rows] = await db.execute(`
        SELECT
            tpk_nomor,
            TRIM(tpk_peminta)              AS tpk_peminta,
            COALESCE(tpk_approveatasan, 0) AS tpk_approveatasan,
            COALESCE(tpk_approveHRD,   0) AS tpk_approveHRD,
            DATE(tpk_tanggal)              AS tpk_tanggal
        FROM rekruitmen2.tpermintaan_draft

        UNION ALL

        SELECT
            tpk_nomor,
            TRIM(tpk_peminta)              AS tpk_peminta,
            COALESCE(tpk_approveatasan, 0) AS tpk_approveatasan,
            COALESCE(tpk_approveHRD,   0) AS tpk_approveHRD,
            DATE(tpk_tanggal)              AS tpk_tanggal
        FROM hrd2.tpermintaankaryawan
    `);

  const rowList = rows as DbRow[];

  if (!rowList.length) return;

  const CHUNK = 500;
  for (let i = 0; i < rowList.length; i += CHUNK) {
    const chunk = rowList.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => '(?,?,?,?,?)').join(',');
    const values: unknown[] = chunk.flatMap((r) => [
      r.tpk_nomor,
      r.tpk_peminta,
      r.tpk_approveatasan,
      r.tpk_approveHRD,
      r.tpk_tanggal,
    ]);
    await db.execute(
      `
            INSERT INTO rekruitmen2.tpk_index_helper
                (tpk_nomor, tpk_peminta, tpk_approveatasan, tpk_approveHRD, tpk_tanggal)
            VALUES ${placeholders}
            ON DUPLICATE KEY UPDATE
                tpk_peminta       = VALUES(tpk_peminta),
                tpk_approveatasan = VALUES(tpk_approveatasan),
                tpk_approveHRD    = VALUES(tpk_approveHRD),
                tpk_tanggal       = VALUES(tpk_tanggal),
                synced_at         = NOW()
        `,
      values
    );
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`[tpkIndexSync] fullSync selesai: ${rowList.length} baris dalam ${elapsed}s`);
}
