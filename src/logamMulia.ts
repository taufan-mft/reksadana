import axios, { AxiosError } from 'axios';
import type { GoldPrice } from './types';

const LOGAM_MULIA_PRICE_URL = 'https://www.logammulia.com/id/harga-emas-hari-ini';
const PROVIDER_TIMEOUT_MS = 5000;
const GOLD_SYMBOL = 'GOLD';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function logProviderError(provider: string, symbol: string, err: unknown): void {
  const statusCode = err instanceof AxiosError ? err.response?.status ?? null : null;
  const errorCode = err instanceof AxiosError ? err.code ?? null : null;
  const contentTypeHeader =
    err instanceof AxiosError
      ? (err.response?.headers?.['content-type'] as string | string[] | undefined)
      : undefined;
  const retryAfterHeader =
    err instanceof AxiosError ? (err.response?.headers?.['retry-after'] as string | string[] | undefined) : undefined;
  const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader.join(',') : contentTypeHeader ?? 'none';
  const retryAfter = Array.isArray(retryAfterHeader) ? retryAfterHeader.join(',') : retryAfterHeader ?? 'none';
  const statusClass =
    statusCode === 429
      ? 'rate_limited'
      : typeof statusCode === 'number' && statusCode >= 500
        ? 'server_error'
        : typeof statusCode === 'number' && statusCode >= 400
          ? 'request_error'
          : 'unknown';
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[fetchGlobalEtf] provider=${provider} symbol=${symbol} status=${statusCode ?? 'none'} class=${statusClass} code=${errorCode ?? 'none'} content_type=${contentType} retry_after=${retryAfter} message=${message}`,
  );
}

function logProviderParseIssue(provider: string, symbol: string, reason: string): void {
  console.error(`[fetchGlobalEtf] provider=${provider} symbol=${symbol} parse=failed reason=${reason}`);
}

function parseIdrInteger(value: string): number | null {
  const digitsOnly = value.replace(/\D/g, '');
  if (!digitsOnly) {
    return null;
  }

  const parsed = Number.parseInt(digitsOnly, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractLogamMuliaOneGramPrice(html: string): number | null {
  const pageText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!pageText) {
    return null;
  }

  const emasBatanganIndex = pageText.search(/Emas\s+Batangan/i);
  const scopedText = emasBatanganIndex >= 0 ? pageText.slice(emasBatanganIndex, emasBatanganIndex + 4000) : pageText;
  const rowMatch = scopedText.match(/1\s*gr\s*([0-9][0-9.,]{3,})/i);
  if (!rowMatch?.[1]) {
    return null;
  }

  return parseIdrInteger(rowMatch[1]);
}

export async function fetchGoldPrice(): Promise<GoldPrice | null> {

  try {
    const response = await axios.get<string>(LOGAM_MULIA_PRICE_URL, {
      headers: {
        accept: '*/*',
        'accept-language': 'en-GB,en;q=0.9',
        priority: 'u=1, i',
        'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"iOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        Referer: LOGAM_MULIA_PRICE_URL,
        'User-Agent': USER_AGENT,
      },
      responseType: 'text',
      decompress: true,
      timeout: PROVIDER_TIMEOUT_MS,
    });

    if (typeof response.data !== 'string' || !response.data.trim()) {
      logProviderParseIssue('logammulia', GOLD_SYMBOL, 'empty response body');
      return null;
    }

    const oneGramPrice = extractLogamMuliaOneGramPrice(response.data);
    if (oneGramPrice === null) {
      logProviderParseIssue('logammulia', GOLD_SYMBOL, 'failed to extract 1 gr base price');
      return null;
    }

    return {
      name: 'Antam Gold 1 gr',
      last_price: oneGramPrice,
      currency: 'IDR',
      exchange: 'Logam Mulia',
      price_updated_at: new Date().toISOString(),
    };
  } catch (err) {
    logProviderError('logammulia', GOLD_SYMBOL, err);
    return null;
  }
}

export const fetchGlobalEtfFromLogamMulia = fetchGoldPrice;