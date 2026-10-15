import { isPrivateAddress, assertPublicUrl } from './url-guard';
import { sniffMedia } from './assets.constants';

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'blocks %s',
    (a) => expect(isPrivateAddress(a)).toBe(true),
  );
  it.each(['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', (a) =>
    expect(isPrivateAddress(a)).toBe(false),
  );
});

describe('assertPublicUrl', () => {
  it.each(['http://localhost/x', 'http://127.0.0.1/x', 'http://169.254.169.254/latest', 'http://redis:6379/', 'http://api:4000/', 'ftp://example.com/x', 'https://example.com:6379/x', 'https://u:p@example.com/x', 'file:///etc/passwd'])(
    'rejects %s',
    async (u) => {
      await expect(assertPublicUrl(u)).rejects.toThrow();
    },
  );
  it('accepts a public IP literal', async () => {
    await expect(assertPublicUrl('https://8.8.8.8/video.mp4')).resolves.toBeInstanceOf(URL);
  });
});

describe('sniffMedia (real content, not the claimed type)', () => {
  const b = (...bytes: number[]) => Buffer.from(bytes);
  it('detects jpeg and png', () => {
    expect(sniffMedia(b(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0))?.mime).toBe('image/jpeg');
    expect(sniffMedia(Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1'))?.mime).toBe('image/png');
  });
  it('detects mp4 and mov by ftyp brand', () => {
    expect(sniffMedia(Buffer.from('\0\0\0\x18ftypisom', 'latin1'))).toMatchObject({ mime: 'video/mp4', kind: 'VIDEO' });
    expect(sniffMedia(Buffer.from('\0\0\0\x14ftypqt  ', 'latin1'))).toMatchObject({ mime: 'video/quicktime' });
  });
  it('rejects HEIC (ftyp but an image) and audio', () => {
    expect(sniffMedia(Buffer.from('\0\0\0\x18ftypheic', 'latin1'))).toBeNull();
    expect(sniffMedia(Buffer.from('\0\0\0\x18ftypM4A ', 'latin1'))).toBeNull();
  });
  it('rejects html/exe/pdf disguised as media', () => {
    expect(sniffMedia(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffMedia(Buffer.from('MZ\x90\0\x03\0\0\0\x04\0\0\0', 'latin1'))).toBeNull();
    expect(sniffMedia(Buffer.from('%PDF-1.7\n%....', 'latin1'))).toBeNull();
  });
});
