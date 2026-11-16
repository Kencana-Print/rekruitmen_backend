/**
 * Tipe data bersama (shared types) untuk seluruh modul backend.
 */

export interface AppUser {
  kode: string;
  nama: string;
  bagian: string | null;
  is_hrd: number;
  jab_kode?: string | null;
  dep_kode?: string | null;
  pab_kode?: string | null;
}

export interface JwtPayload {
  kode: string;
  nama: string;
  is_hrd: number;
  jti: string;
  iat?: number;
  exp?: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message?: string;
  data?: T;
}

/** Baris hasil query yang bersifat dinamis (SELECT * / JOIN kompleks). */
export type DbRow = Record<string, any>;
