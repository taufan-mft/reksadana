import axios, { AxiosError } from 'axios';
import * as CryptoJS from 'crypto-js';
import type { Stock, Fund, RawStockResponse, RawFund, ApiResponse } from './types';

// ─── Decryption ───────────────────────────────────────────────────────────────

/**
 * The encrypted string embeds its own IV and key:
 *   [0..31]   → IV (32 hex chars)
 *   [32..-32] → ciphertext (hex-encoded)
 *   [-32..]   → AES key (32 UTF-8 chars)
 */
function decrypt(data: string): unknown {
  const iv = CryptoJS.enc.Hex.parse(data.slice(0, 32));
  const secret = CryptoJS.enc.Utf8.parse(data.slice(-32));
  const encryptedData = data.slice(32, -32);

  const bytes = CryptoJS.AES.decrypt(encryptedData, secret, {
    iv,
    mode: CryptoJS.mode.CBC,
    format: CryptoJS.format.Hex,
  });

  return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
}

// ─── API Fetcher ──────────────────────────────────────────────────────────────

const BIBIT_API_URL = 'https://api.bibit.id/products/list';
const BIBIT_STOCKS_API_URL = 'https://api.bibit.id/stocks/companies';
const PAGE_LIMIT = 25;
const DELAY_MS = 300;

const HEADERS = {
  Accept: 'application/json',
  'Accept-Encoding': 'gzip',
  'Accept-Language': 'en-US,en;q=0.9',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'https://bibit.id',
  Referer: 'https://bibit.id/reksadana',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Stock Fetcher ────────────────────────────────────────────────────────────

export async function fetchStock(symbol: string): Promise<Stock | null> {
  try {
    const response = await axios.get<RawStockResponse>(`${BIBIT_STOCKS_API_URL}/${encodeURIComponent(symbol)}`, {
      headers: { ...HEADERS, Referer: 'https://bibit.id/saham' },
      decompress: true,
    });
    return response.data.data;
  } catch (err) {
    if (err instanceof AxiosError && err.response?.status === 422) {
      return null;
    }
    throw err;
  }
}

async function fetchPage(page: number): Promise<RawFund[]> {
  const response = await axios.get<ApiResponse>(BIBIT_API_URL, {
    headers: HEADERS,
    params: {
      page,
      limit: PAGE_LIMIT,
      sort_by: 7, // 7 = sort by name
      sort: 'asc',
      tradable: 1, // only funds listed on bibit.id/reksadana
    },
    decompress: true,
  });

  const encrypted = response.data?.data;
  if (!encrypted || typeof encrypted !== 'string') {
    throw new Error(`Unexpected response shape on page ${page}: ${JSON.stringify(response.data)}`);
  }

  // Log the decrypted shape once on the first page so field names can be verified
  const decrypted = decrypt(encrypted);

  if (!Array.isArray(decrypted)) {
    throw new Error(`Decrypted data is not an array on page ${page}`);
  }

  return decrypted as RawFund[];
}

// ─── Main Scraper ─────────────────────────────────────────────────────────────

export async function scrapeAll(): Promise<Fund[]> {
  const results: Fund[] = [];
  let page = 1;

  console.log('Starting scrape of https://bibit.id/reksadana ...\n');

  while (true) {
    console.log(`  Fetching page ${page} ...`);

    const rawFunds = await fetchPage(page);

    if (rawFunds.length === 0) {
      console.log('  No more records, stopping.');
      break;
    }

    for (const fund of rawFunds) {
      results.push({
        id: fund.id,
        name: fund.name.trim(),
        last_nav: fund.nav?.value ?? 0,
      });
    }

    console.log(`  → Got ${rawFunds.length} funds (total so far: ${results.length})`);

    if (rawFunds.length < PAGE_LIMIT) {
      // Last page (partial)
      break;
    }

    page += 1;
    await sleep(DELAY_MS);
  }

  return results;
}


