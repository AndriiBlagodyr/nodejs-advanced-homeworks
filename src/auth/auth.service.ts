import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { ACCESS_TTL_SEC, loadAuthConfig, REFRESH_TTL_SEC } from './config';
import { verifyPassword } from './password';
import { type AccessClaims, AccessTokens, isRole, refreshTokenHash, type Role } from './tokens';

export type TokenPair = {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
};

type RefreshRow = {
  family_id: string;
  user_id: string;
  used_at: Date | null;
  revoked_at: Date | null;
  expired: boolean;
};

/**
 * Refresh tokens are opaque random strings. The table stores only the HMAC.
 * Rotation, reuse detection and family revocation happen in one transaction:
 * a crash in the middle leaves the old token still valid, never a half-rotated family.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tokens: AccessTokens,
  ) {}

  async login(email: string, password: string): Promise<TokenPair> {
    const rows = await this.dataSource.query<
      Array<{ id: string; password_hash: string | null; role: string }>
    >(
      `SELECT id::text AS id, password_hash, role
         FROM users WHERE lower(email) = lower($1)`,
      [email.trim()],
    );
    const user = rows[0];
    const ok = await verifyPassword(password, user?.password_hash ?? null);
    if (!user || !ok || !isRole(user.role)) {
      throw new UnauthorizedException('invalid credentials');
    }
    return this.issuePair(user.id, user.role, randomUUID());
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const cfg = loadAuthConfig();
    const hash = refreshTokenHash(cfg.pepper, refreshToken);

    const outcome = await this.dataSource.transaction(async (m) => {
      const rows = await m.query<RefreshRow[]>(
        `SELECT family_id::text AS family_id, user_id::text AS user_id,
                used_at, revoked_at, (expires_at <= now()) AS expired
           FROM refresh_tokens
          WHERE token_hash = $1
          FOR UPDATE`,
        [hash],
      );
      const row = rows[0];
      if (!row) return { kind: 'reject' as const };
      if (row.revoked_at) return { kind: 'reject' as const };

      if (row.used_at) {
        // Already rotated. A second presentation is the theft signal: the
        // honest client and the thief both hold a token of this family, and
        // RFC 9700 §4.14.2 says the whole family goes.
        await m.query(
          `UPDATE refresh_tokens SET revoked_at = now()
            WHERE family_id = $1 AND revoked_at IS NULL`,
          [row.family_id],
        );
        return { kind: 'reuse' as const, familyId: row.family_id };
      }

      if (row.expired) return { kind: 'reject' as const };

      const users = await m.query<Array<{ role: string }>>(
        `SELECT role FROM users WHERE id = $1`,
        [row.user_id],
      );
      const role = users[0]?.role;
      if (!isRole(role)) return { kind: 'reject' as const };

      await m.query(`UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1`, [hash]);
      const pair = await this.insertPair(m, row.user_id, role, row.family_id);
      return { kind: 'ok' as const, pair };
    });

    if (outcome.kind === 'reuse') {
      this.logger.warn(`refresh token reuse; family revoked family_id=${outcome.familyId}`);
      throw new UnauthorizedException('unauthorized');
    }
    if (outcome.kind === 'reject') throw new UnauthorizedException('unauthorized');
    return outcome.pair;
  }

  /**
   * Both effects in one COMMIT. The refresh family is a row; the access token
   * is not, so its jti is written to the denylist here rather than to Redis.
   * Two stores would be the dual write from HW-22, and logout would not be atomic.
   */
  async logout(claims: AccessClaims): Promise<void> {
    await this.dataSource.transaction(async (m) => {
      await m.query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [claims.fid],
      );
      await m.query(
        `INSERT INTO access_denylist (jti, expires_at) VALUES ($1, to_timestamp($2))
         ON CONFLICT (jti) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [claims.jti, claims.exp],
      );
      await m.query(`DELETE FROM access_denylist WHERE expires_at <= now()`);
    });
  }

  /**
   * The one place an access token becomes an identity: HTTP guard, SSE and
   * WebSocket all come through here. `exp` and the signature are the
   * library's job; `revoked` is ours.
   */
  async authenticate(token: string | undefined): Promise<AccessClaims> {
    if (!token) throw new UnauthorizedException('unauthorized');
    let claims: AccessClaims;
    try {
      claims = await this.tokens.verify(token);
    } catch {
      throw new UnauthorizedException('unauthorized');
    }
    if (await this.isAccessRevoked(claims.jti)) throw new UnauthorizedException('unauthorized');
    return claims;
  }

  async isAccessRevoked(jti: string): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ ok: number }>>(
      `SELECT 1 AS ok FROM access_denylist WHERE jti = $1 AND expires_at > now()`,
      [jti],
    );
    return rows.length > 0;
  }

  private async issuePair(userId: string, role: Role, familyId: string): Promise<TokenPair> {
    return this.dataSource.transaction((m) => this.insertPair(m, userId, role, familyId));
  }

  private async insertPair(
    m: EntityManager,
    userId: string,
    role: Role,
    familyId: string,
  ): Promise<TokenPair> {
    const cfg = loadAuthConfig();
    const refreshToken = randomBytes(32).toString('base64url');
    const hash = refreshTokenHash(cfg.pepper, refreshToken);
    await m.query(
      `INSERT INTO refresh_tokens (token_hash, family_id, user_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
      [hash, familyId, userId, REFRESH_TTL_SEC],
    );
    const accessToken = await this.tokens.sign(userId, role, familyId);
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SEC,
    };
  }
}
