/**
 * Network guard for image URL downloads: SSRF address validation and
 * DNS-rebinding-safe HTTP(S) requests.
 *
 * `safeRequest` validates URL syntax, scheme, `localhost`, and IP
 * literals (including bracketed IPv6 literals like `[::1]`) upfront,
 * and for domain hosts passes a custom `lookup` hook to
 * `node:http` / `node:https` with `agent: false`:
 *   - The hostname is resolved AT MOST ONCE per request.
 *   - Every resolved address must pass `isAllowedAddress` (default:
 *     `isPublicIp`); a single non-public address aborts the lookup
 *     before any socket connects.
 *   - Only the validated address list is handed to `net.Socket`, so
 *     the address that was checked is the exact address connected to
 *     (no second DNS lookup, closing the DNS-rebinding window).
 *   - `lookup` supports both callback forms (`options.all === true`
 *     returning an address array, and single-address `(err, ip, family)`),
 *     as required by Node 20+ `autoSelectFamily`.
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class BlockedUrlError extends Error {
  public readonly reason: string;

  public constructor(reason: string) {
    super(reason);
    this.name = 'BlockedUrlError';
    this.reason = reason;
  }
}

export interface ResolvedAddress {
  address: string;
  family?: number;
}

export type SafeResolver = (
  hostname: string,
) => Promise<Array<ResolvedAddress | string>>;

export interface SafeRequestOptions {
  /** Custom hostname resolver (defaults to `dns.lookup(host, { all: true })`). */
  resolve?: SafeResolver;
  /** Address policy predicate (defaults to `isPublicIp`). */
  isAllowedAddress?: (ip: string) => boolean;
  /** AbortSignal governing both connection setup and response streaming. */
  signal?: AbortSignal;
  /** Optional extra request headers. */
  headers?: Record<string, string>;
}

/** True when an IPv4 address is globally routable (not loopback, private, link-local, or reserved). */
export function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return false;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return false;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return false;
    }
    octets.push(n);
  }
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 0) return false; // 0.0.0.0/8: "this network"
  if (a === 10) return false; // 10.0.0.0/8: private
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10: CGNAT
  if (a === 127) return false; // 127.0.0.0/8: loopback
  if (a === 169 && b === 254) return false; // 169.254.0.0/16: link-local (incl. cloud metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12: private
  if (a === 192 && b === 168) return false; // 192.168.0.0/16: private
  if (a >= 224) return false; // 224.0.0.0/4: multicast; 240.0.0.0/4: reserved
  return true;
}

/** Parse an IPv6 address into 8 16-bit words; null when invalid. */
function parseIpv6Words(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const v4Match = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4Match !== null) {
    const parts = (v4Match[2] as string).split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((parts[0] as number) << 8) | (parts[1] as number);
    const lo = ((parts[2] as number) << 8) | (parts[3] as number);
    addr = `${v4Match[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = addr.split('::');
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const full = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (full.length !== 8) {
    return null;
  }
  const words = full.map((w) => parseInt(w, 16));
  return words.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff) ? null : words;
}

/** True when an IPv6 address is globally routable. */
export function isPublicIpv6(ip: string): boolean {
  const w = parseIpv6Words(ip);
  if (w === null) {
    return false;
  }
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = w;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && (w7 === 0 || w7 === 1)) {
    return false; // loopback (::1) / unspecified (::)
  }
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): judge by embedded IPv4.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && (w5 === 0xffff || w5 === 0)) {
    const ipv4 = `${w6 >> 8}.${w6 & 0xff}.${w7 >> 8}.${w7 & 0xff}`;
    return isPublicIpv4(ipv4);
  }
  if (w0 === 0x0064 && w1 === 0xff9b) return false; // 64:ff9b::/96: NAT64 well-known prefix
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return false; // 100::/64: discard prefix
  if (w0 === 0x2001 && (w1 === 0x0db8 || w1 === 0x0000)) return false; // 2001:db8::/32 (doc) & 2001::/32 (Teredo)
  if (w0 === 0x2002) return false; // 2002::/16: 6to4
  if (w0 >= 0xfc00 && w0 <= 0xfdff) return false; // fc00::/7: unique-local
  if (w0 >= 0xfe80 && w0 <= 0xfebf) return false; // fe80::/10: link-local
  if (w0 >= 0xfec0 && w0 <= 0xfeff) return false; // fec0::/10: site-local, deprecated
  if (w0 >= 0xff00) return false; // ff00::/8: multicast
  return true;
}

/** True when `ip` is a globally routable unicast address. */
export function isPublicIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPublicIpv4(ip);
  if (family === 6) return isPublicIpv6(ip);
  return false;
}

/**
 * Synchronous pre-check for URL syntax, scheme, `localhost`, and IP
 * literals (stripping brackets on IPv6 literals before checking).
 * Returns the refusal reason, or null when the URL passes pre-check.
 */
export function precheckUrlReason(
  rawUrl: string,
  isAllowedAddress: (ip: string) => boolean = isPublicIp,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return 'not a valid URL';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `unsupported scheme ${parsed.protocol}`;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (host.length === 0) {
    return 'missing host';
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'localhost is not a public address';
  }
  // Node's URL.hostname keeps the brackets on IPv6 literals ('[::1]'),
  // and http(s).request skips `lookup` for literal IP hosts — strip
  // brackets and check literal IPs here so they cannot bypass the
  // connection-time check.
  const bareHost = host.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(bareHost) !== 0) {
    return isAllowedAddress(bareHost) ? null : `${bareHost} is not a public address`;
  }
  return null;
}

/**
 * Check whether `rawUrl` must be refused before fetching. When called
 * with a domain name, also resolves and checks all addresses if a
 * standalone pre-check is requested; `safeRequest` performs the
 * authoritative single-resolution check at connection time.
 */
export async function blockedUrlReason(
  rawUrl: string,
  opts: {
    resolve?: SafeResolver;
    isAllowedAddress?: (ip: string) => boolean;
  } = {},
): Promise<string | null> {
  const isAllowed = opts.isAllowedAddress ?? isPublicIp;
  const pre = precheckUrlReason(rawUrl, isAllowed);
  if (pre !== null) {
    return pre;
  }
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const bareHost = host.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(bareHost) !== 0) {
    return null;
  }
  const resolveFn: SafeResolver =
    opts.resolve ?? ((h: string) => dns.lookup(h, { all: true }));
  let rawList: Array<ResolvedAddress | string>;
  try {
    rawList = await resolveFn(host);
  } catch {
    return 'host could not be resolved';
  }
  if (rawList.length === 0) {
    return 'host could not be resolved';
  }
  for (const item of rawList) {
    const address = typeof item === 'string' ? item : item.address;
    if (!isAllowed(address)) {
      return `${address} is not a public address`;
    }
  }
  return null;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

/**
 * Issue a GET request with connection-time IP validation (`agent: false`
 * + custom `lookup` that resolves once, validates every returned IP,
 * and hands only the validated IPs to the socket).
 */
export function safeRequest(
  rawUrl: string,
  opts: SafeRequestOptions = {},
): Promise<http.IncomingMessage> {
  const isAllowed = opts.isAllowedAddress ?? isPublicIp;
  const resolveFn: SafeResolver =
    opts.resolve ?? ((h: string) => dns.lookup(h, { all: true }));

  const preReason = precheckUrlReason(rawUrl, isAllowed);
  if (preReason !== null) {
    return Promise.reject(new BlockedUrlError(preReason));
  }

  const parsed = new URL(rawUrl);
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const bareHost = host.replace(/^\[(.*)\]$/, '$1');
  const isLiteralIp = net.isIP(bareHost) !== 0;

  let resolvedPromise: Promise<Array<{ address: string; family: 4 | 6 }>> | null =
    null;
  const resolveOnce = (): Promise<Array<{ address: string; family: 4 | 6 }>> => {
    if (resolvedPromise === null) {
      resolvedPromise = (async () => {
        let rawList: Array<ResolvedAddress | string>;
        try {
          rawList = await resolveFn(host);
        } catch {
          throw new BlockedUrlError('host could not be resolved');
        }
        const list: Array<{ address: string; family: 4 | 6 }> = [];
        for (const item of rawList) {
          const address = typeof item === 'string' ? item : item.address;
          const fam = net.isIP(address);
          if (fam !== 4 && fam !== 6) {
            throw new BlockedUrlError('host could not be resolved');
          }
          if (!isAllowed(address)) {
            throw new BlockedUrlError(`${address} is not a public address`);
          }
          list.push({ address, family: fam });
        }
        if (list.length === 0) {
          throw new BlockedUrlError('host could not be resolved');
        }
        return list;
      })();
    }
    return resolvedPromise;
  };

  const lookup: net.LookupFunction | undefined = isLiteralIp
    ? undefined
    : (_hostname, options, cb) => {
        const callback = cb as unknown as LookupCallback;
        resolveOnce().then(
          (list) => {
            const wantAll =
              typeof options === 'object' &&
              options !== null &&
              (options as { all?: boolean }).all === true;
            if (wantAll) {
              callback(null, list);
            } else {
              const first = list[0];
              if (first === undefined) {
                callback(new BlockedUrlError('host could not be resolved'));
                return;
              }
              callback(null, first.address, first.family);
            }
          },
          (err: unknown) => {
            const error = (
              err instanceof Error ? err : new Error(String(err))
            ) as NodeJS.ErrnoException;
            callback(error);
          },
        );
      };

  const requestFn = parsed.protocol === 'https:' ? https.request : http.request;
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = requestFn(
      parsed,
      {
        method: 'GET',
        agent: false,
        ...(lookup !== undefined ? { lookup } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        headers: {
          'User-Agent': 'memdrive-mcp/0.8.1',
          Accept: 'image/*',
          ...opts.headers,
        },
      },
      (res) => {
        if (opts.signal !== undefined) {
          if (opts.signal.aborted) {
            res.destroy(
              opts.signal.reason instanceof Error
                ? opts.signal.reason
                : new Error('The operation was aborted'),
            );
            return;
          }
          const onAbort = (): void => {
            res.destroy(
              opts.signal?.reason instanceof Error
                ? opts.signal.reason
                : new Error('The operation was aborted'),
            );
          };
          opts.signal.addEventListener('abort', onAbort, { once: true });
          res.once('close', () => {
            opts.signal?.removeEventListener('abort', onAbort);
          });
        }
        resolve(res);
      },
    );
    req.once('error', (err) => {
      reject(err);
    });
    req.end();
  });
}
