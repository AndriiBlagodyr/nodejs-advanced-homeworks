import { createHmac, type KeyObject, randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import jwt, { type JwtHeader, type JwtPayload } from 'jsonwebtoken';
import {
  ACCESS_TTL_SEC,
  JWT_ALG,
  JWT_AUDIENCE,
  JWT_ISSUER,
  loadAuthConfig,
} from './config';

export const ROLES = ['buyer', 'seller', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type AccessClaims = {
  sub: string;
  role: Role;
  jti: string;
  fid: string;
  exp: number;
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** HMAC-SHA256 with the vault pepper. A dump of the table is not a dump of sessions. */
export function refreshTokenHash(pepper: string, token: string): string {
  return createHmac('sha256', pepper).update(token).digest('hex');
}

@Injectable()
export class AccessTokens implements OnModuleInit {
  /** Any process that boots the app (demos, tests) fails here, before serving, without keys. */
  onModuleInit(): void {
    loadAuthConfig();
  }

  sign(userId: string, role: Role, familyId: string): string {
    const cfg = loadAuthConfig();
    return jwt.sign({ role, fid: familyId }, cfg.privateKey, {
      algorithm: JWT_ALG,
      expiresIn: ACCESS_TTL_SEC,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      subject: userId,
      jwtid: randomUUID(),
      keyid: cfg.kid,
    });
  }

  /**
   * The key is chosen by `kid`. `algorithms` is an allowlist, not a preference:
   * anything other than ES256 is rejected before the signature is trusted.
   */
  verify(token: string): Promise<AccessClaims> {
    const { publicKeys } = loadAuthConfig();
    return new Promise((resolve, reject) => {
      jwt.verify(
        token,
        (header, done) => {
          const key = keyFor(publicKeys, header);
          if (key) done(null, key);
          else done(new Error('unknown kid'));
        },
        { algorithms: [JWT_ALG], issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
        (err, decoded) => {
          if (err || !decoded || typeof decoded === 'string') {
            reject(err ?? new Error('invalid access token'));
            return;
          }
          const claims = readClaims(decoded);
          if (!claims) reject(new Error('incomplete access token'));
          else resolve(claims);
        },
      );
    });
  }
}

function keyFor(publicKeys: Map<string, KeyObject>, header: JwtHeader): KeyObject | undefined {
  return header.kid ? publicKeys.get(header.kid) : undefined;
}

type AccessPayload = JwtPayload & { role?: unknown; fid?: unknown };

function readClaims(payload: AccessPayload): AccessClaims | undefined {
  if (!payload.sub || !payload.jti || typeof payload.exp !== 'number') return undefined;
  if (!isRole(payload.role) || typeof payload.fid !== 'string') return undefined;
  return { sub: payload.sub, role: payload.role, jti: payload.jti, fid: payload.fid, exp: payload.exp };
}
