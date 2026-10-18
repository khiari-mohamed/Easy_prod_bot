import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = address.toLowerCase();
    if (x === '::' || x === '::1') return true;
    // IPv4 embedded in IPv6: ::ffff:a.b.c.d, ::ffff:7f00:1, ::7f00:1, 64:ff9b::7f00:1
    const dotted = x.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateAddress(dotted[1]);
    const hex = x.match(/^(?:::ffff:|::|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return x.startsWith('fc') || x.startsWith('fd') || /^fe[89ab]/.test(x) || x.startsWith('ff') || x.startsWith('2002:');
  }
  return true; // not an IP: treat as unsafe
}

/**
 * Server-side fetches must only reach the public internet: never localhost, Docker-internal services
 * (postgres, redis, api...), or cloud metadata addresses. Only http(s) on the default ports.
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BadRequestException('Only http(s) links are accepted');
  if (url.username || url.password) throw new BadRequestException('Links with embedded credentials are not accepted');
  if (url.port && url.port !== '80' && url.port !== '443') throw new BadRequestException('Only the standard web ports are allowed');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new BadRequestException('This address is not allowed');
    return url;
  }
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new BadRequestException('This host is not allowed');
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new BadRequestException('The host could not be resolved');
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new BadRequestException('This host is not allowed');
  }
  return url;
}
