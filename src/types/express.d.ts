import type { AppUser, JwtPayload } from './index';

declare global {
  namespace Express {
    interface Request {
      /** Diisi oleh middleware authenticate. */
      user?: AppUser;
      /** Payload token asli (termasuk jti) untuk kebutuhan logout. */
      auth?: JwtPayload;
      /** Timezone database yang dipakai modul (selalu '+07:00'). */
      dbTimezone?: string;
    }
  }
}

export {};
