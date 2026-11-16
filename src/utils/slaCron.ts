// src/utils/slaCron.ts (Sesuaikan path jika berbeda)
import cron from 'node-cron';
import db from '../config/db';
import { fullSync as syncIndexHelper } from './tpkIndexSync';

const MAX_NOTES_LENGTH = 3000;

export const runSlaSync = async (): Promise<void> => {
  // Koneksi mysql2 bertipe dinamis (pool diketik sebagai DbLike) → any diperlukan.
  let connection: any;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    // SLA hanya ada untuk yang sudah HRD approve (ada di hrd2), jadi ini tetap sama
    const [activeSlas] = (await connection.query(
      `SELECT sla_tpk_nomor FROM rekruitmen2.t_recruitment_sla WHERE sla_status IN ('PENDING', 'CALCULATED')`
    )) as [Array<{ sla_tpk_nomor: string }>, unknown];

    if (activeSlas.length > 0) {
      const tpkNomors = activeSlas.map((s) => s.sla_tpk_nomor);
      const placeholders = tpkNomors.map(() => '?').join(',');

      const [hiredData] = (await connection.query(
        `
                SELECT 
                    rpk_tpk_nomor AS tlp_tpk_nomor, 
                    SUM(GREATEST(COALESCE(rpk_jumlah, 1), 1)) as total_hired 
                FROM hrd2.triilpermintaankaryawan 
                WHERE rpk_tpk_nomor IN (${placeholders})
                GROUP BY rpk_tpk_nomor
            `,
        tpkNomors
      )) as [Array<{ tlp_tpk_nomor: string; total_hired: number }>, unknown];

      const hiredMap: Record<string, number> = {};
      hiredData.forEach((row) => {
        hiredMap[row.tlp_tpk_nomor] = row.total_hired;
      });

      const caseStatements = activeSlas.map(() => `WHEN ? THEN ?`).join(' ');
      const flatValues = activeSlas.flatMap((sla) => [
        sla.sla_tpk_nomor,
        hiredMap[sla.sla_tpk_nomor] || 0,
      ]);

      await connection.query(
        `
                UPDATE rekruitmen2.t_recruitment_sla
                SET sla_hired_count = CASE sla_tpk_nomor ${caseStatements} END
                WHERE sla_tpk_nomor IN (${placeholders})
            `,
        [...flatValues, ...tpkNomors]
      );

      const [toComplete] = (await connection.query(
        `
                SELECT sla.sla_tpk_nomor, sla.sla_id
                FROM rekruitmen2.t_recruitment_sla sla
                JOIN hrd2.tpermintaankaryawan tpk ON sla.sla_tpk_nomor = tpk.tpk_nomor
                WHERE sla.sla_hired_count >= tpk.tpk_jumlah 
                  AND sla.sla_status      = 'CALCULATED'
                  AND sla.sla_tpk_nomor  IN (${placeholders})
            `,
        tpkNomors
      )) as [Array<{ sla_tpk_nomor: string; sla_id: number }>, unknown];

      if (toComplete.length > 0) {
        const tpksToClose = toComplete.map((row) => row.sla_tpk_nomor);
        const placeholdersClose = tpksToClose.map(() => '?').join(',');

        await connection.query(
          `
                    UPDATE rekruitmen2.t_recruitment_sla 
                    SET 
                        sla_status       = 'COMPLETED',
                        sla_completed_at = NOW(),
                        sla_is_editable  = 0,
                        sla_notes        = LEFT(CONCAT(
                            COALESCE(sla_notes, ''),
                            '\n[', NOW(), '] System: Target terpenuhi, SLA otomatis ditutup.'
                        ), ${MAX_NOTES_LENGTH})
                    WHERE sla_tpk_nomor IN (${placeholdersClose})
                `,
          tpksToClose
        );

        const logValues = toComplete.map((row) => [
          row.sla_tpk_nomor,
          row.sla_id,
          'SYSTEM',
          'status_sla',
          'CALCULATED',
          'COMPLETED (Auto-Sync)',
        ]);

        await connection.query(
          `
                    INSERT INTO rekruitmen2.t_pkar_log (tpk_nomor, sla_id, user_kode, field_name, old_value, new_value)
                    VALUES ?
                `,
          [logValues]
        );
      }
    }

    await connection.commit();
    console.log(
      `[${new Date().toLocaleString()}] SLA Sync Success.`,
      `Validated ${activeSlas.length} active requests.`
    );
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('SLA Sync Error:', error instanceof Error ? error.message : String(error));
  } finally {
    if (connection) connection.release();
  }

  // Sync shadow index table setelah SLA sync
  try {
    await syncIndexHelper(db);
  } catch (syncErr) {
    console.warn(
      '[tpkIndexSync] Periodic sync error (non-fatal):',
      syncErr instanceof Error ? syncErr.message : String(syncErr)
    );
  }

  // [FIX] Sequence sync harus baca dari DRAFT + hrd2 agar nomor draft tidak
  // di-reuse oleh request baru sebelum HRD approve memindahkan ke hrd2
  try {
    await db.execute(`
            INSERT INTO rekruitmen2.tpk_sequence (seq_year, seq_last)
            SELECT 
                YEAR(tpk_tanggal) AS seq_year,
                MAX(CAST(SUBSTRING_INDEX(tpk_nomor, '/', 1) AS UNSIGNED)) AS seq_last
            FROM (
                SELECT tpk_nomor, tpk_tanggal FROM rekruitmen2.tpermintaan_draft
                UNION ALL
                SELECT tpk_nomor, tpk_tanggal FROM hrd2.tpermintaankaryawan
            ) AS combined
            WHERE YEAR(tpk_tanggal) >= YEAR(CURDATE()) - 1
            GROUP BY YEAR(tpk_tanggal)
            ON DUPLICATE KEY UPDATE 
                seq_last = GREATEST(seq_last, VALUES(seq_last))
        `);
  } catch (sequenceErr) {
    console.warn(
      '[slaCron] Sequence sync failed (non-fatal):',
      sequenceErr instanceof Error ? sequenceErr.message : String(sequenceErr)
    );
  }

  // ✅ [SECURITY] Cleanup token expired dari database blacklist
  // Diletakkan di akhir agar tidak mengganggu proses utama jika gagal
  try {
    const [result] = await db.execute(
      'DELETE FROM rekruitmen2.t_revoked_tokens WHERE rt_expires_at < NOW()'
    );
    if (result.affectedRows > 0) {
      console.log(`[Token Cleanup] Berhasil menghapus ${result.affectedRows} token kadaluarsa.`);
    }
  } catch (tokenErr) {
    console.warn(
      '[Token Cleanup] Gagal menghapus token kadaluarsa (non-fatal):',
      tokenErr instanceof Error ? tokenErr.message : String(tokenErr)
    );
  }
};

cron.schedule('*/5 * * * *', runSlaSync);

/** Default export objek agar `slaCron.runSlaSync()` di index.ts tetap berjalan. */
const slaCron = { runSlaSync };

export default slaCron;
