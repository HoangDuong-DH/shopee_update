import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export class SecretBox {
  private readonly key: Buffer;
  constructor(keyHex: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error('SERVER_ENCRYPTION_KEY_REQUIRED');
    this.key = Buffer.from(keyHex, 'hex');
  }
  seal(value: unknown, scope: string): string {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      bytes.toString('base64url'),
    ].join('.');
  }
  open(value: string, scope: string): unknown {
    const [version, iv, tag, bytes, ...extra] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !bytes || extra.length)
      throw new Error('INVALID_CIPHERTEXT');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(scope));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(bytes, 'base64url')), decipher.final()]).toString(
        'utf8',
      ),
    );
  }
}
