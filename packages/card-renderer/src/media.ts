import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface DownloadedImage {
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly dataUri: string;
}

export async function downloadExternalImage(
  inputUrl: string,
  options: {
    readonly maxBytes?: number;
    readonly maxRedirects?: number;
    readonly fetchImplementation?: typeof fetch;
  } = {},
): Promise<DownloadedImage> {
  const maximumBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const maximumRedirects = options.maxRedirects ?? 3;
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let current = new URL(inputUrl);

  for (let redirect = 0; redirect <= maximumRedirects; redirect += 1) {
    await assertPublicHttpUrl(current);
    const response = await fetchImplementation(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'image/*' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirect === maximumRedirects)
        throw new Error('Image redirect was invalid.');
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Image download failed with status ${response.status}.`);
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) {
      throw new Error('Downloaded media is not an allowed image type.');
    }
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > maximumBytes) throw new Error('Image exceeds the configured size limit.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) throw new Error('Image exceeds the configured size limit.');
    return {
      bytes,
      mimeType,
      dataUri: `data:${mimeType};base64,${bytes.toString('base64')}`,
    };
  }
  throw new Error('Image redirect limit exceeded.');
}

async function assertPublicHttpUrl(url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('External image URL must use HTTP or HTTPS.');
  }
  if (url.username || url.password)
    throw new Error('External image URL cannot contain credentials.');

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('External image URL resolves to a private or reserved address.');
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    normalized.startsWith('169.254.') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  ) {
    return true;
  }
  const match = /^172\.(\d+)\./u.exec(normalized);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}
