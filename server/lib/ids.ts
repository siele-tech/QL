import crypto from 'node:crypto';

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
export const shortRef = (prefix: string) => `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
