process.env.DATABASE_URL = 'postgresql://x';
process.env.JWT_SECRET = 'a'.repeat(32);
process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);

import { decrypt, encrypt } from './crypto';

describe('token encryption', () => {
  it('round-trips', () => {
    const secret = 'EAAB-page-token-123';
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it('never repeats ciphertext for the same input', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('does not contain the plaintext', () => {
    expect(encrypt('EAAB-page-token-123')).not.toContain('EAAB');
  });

  it('detects tampering', () => {
    const [iv, tag, data] = encrypt('secret').split('.');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    expect(() => decrypt([iv, tag, flipped.toString('base64')].join('.'))).toThrow();
  });
});
