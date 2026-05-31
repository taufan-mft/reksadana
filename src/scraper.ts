import axios, { AxiosError } from 'axios';
import * as CryptoJS from 'crypto-js';
import type {
  Stock,
  Fund,
  RawStockResponse,
  RawFund,
  ApiResponse,
  SbnApiResponse,
  SbnItem,
  GlobalEtf,
  RawYahooQuote,
  YahooQuoteApiResponse,
  BareksaNavApiResponse,
} from './types';

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

const BAREKSA_NAV_URL = 'https://m.bareksa.com/ajax/mutualfund/nav/product/';
const BIBIT_API_URL = 'https://api.bibit.id/products/list';
const BIBIT_STOCKS_API_URL = 'https://api.bibit.id/stocks/companies';
const BIBIT_SBN_API_URL = 'https://api.bibit.id/sbn/products/histories';
const YAHOO_QUOTE_API_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const STOOQ_QUOTE_API_URL = 'https://stooq.com/q/l/';
const PAGE_LIMIT = 25;
const DELAY_MS = 300;

const STOOQ_SUFFIX_MAP: Record<string, string> = {
  L: 'UK',
  LN: 'UK',
};

const STOOQ_CURRENCY_BY_SUFFIX: Record<string, string> = {
  US: 'USD',
  UK: 'GBP',
};

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

function mapYahooQuoteToGlobalEtf(quote: RawYahooQuote): GlobalEtf | null {
  if (typeof quote.symbol !== 'string') {
    return null;
  }

  if (typeof quote.regularMarketPrice !== 'number' || Number.isNaN(quote.regularMarketPrice)) {
    return null;
  }

  const displayName =
    typeof quote.longName === 'string'
      ? quote.longName
      : typeof quote.shortName === 'string'
        ? quote.shortName
        : quote.symbol;

  const exchange =
    typeof quote.fullExchangeName === 'string'
      ? quote.fullExchangeName
      : typeof quote.exchange === 'string'
        ? quote.exchange
        : null;

  const priceUpdatedAt =
    typeof quote.regularMarketTime === 'number'
      ? new Date(quote.regularMarketTime * 1000).toISOString()
      : null;

  return {
    symbol: quote.symbol,
    name: displayName,
    last_price: quote.regularMarketPrice,
    currency: typeof quote.currency === 'string' ? quote.currency : null,
    exchange,
    quote_type: typeof quote.quoteType === 'string' ? quote.quoteType : null,
    price_updated_at: priceUpdatedAt,
  };
}

function toStooqSymbol(symbol: string): string {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized.includes('.')) {
    return `${normalized}.US`.toLowerCase();
  }

  const [base, rawSuffix] = normalized.split('.', 2);
  const mappedSuffix = STOOQ_SUFFIX_MAP[rawSuffix] ?? rawSuffix;
  return `${base}.${mappedSuffix}`.toLowerCase();
}

function parseStooqTimestamp(datePart: string, timePart: string): string | null {
  if (datePart === 'N/D' || timePart === 'N/D' || datePart.length !== 8 || timePart.length !== 6) {
    return null;
  }

  const date = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
  const time = `${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}`;
  return `${date}T${time}Z`;
}

function parseStooqQuote(csvRow: string, requestedSymbol: string): GlobalEtf | null {
  const cells = csvRow.trim().split(',');
  if (cells.length < 7) {
    return null;
  }

  const [rawSymbol, rawDate, rawTime, , , , rawClose] = cells;
  if (!rawSymbol || !rawClose || rawClose === 'N/D') {
    return null;
  }

  const lastPrice = Number.parseFloat(rawClose);
  if (Number.isNaN(lastPrice)) {
    return null;
  }

  const symbolParts = rawSymbol.split('.');
  const symbolSuffix = symbolParts[symbolParts.length - 1] ?? '';

  return {
    symbol: requestedSymbol.toUpperCase(),
    name: requestedSymbol.toUpperCase(),
    last_price: lastPrice,
    currency: STOOQ_CURRENCY_BY_SUFFIX[symbolSuffix] ?? null,
    exchange: symbolSuffix || null,
    quote_type: 'ETF',
    price_updated_at: parseStooqTimestamp(rawDate, rawTime),
  };
}

async function fetchGlobalEtfFromStooq(symbol: string): Promise<GlobalEtf | null> {
  const stooqSymbol = toStooqSymbol(symbol);
  const response = await axios.get<string>(STOOQ_QUOTE_API_URL, {
    headers: {
      Accept: 'text/plain',
      'User-Agent': HEADERS['User-Agent'],
    },
    params: { s: stooqSymbol, i: 'd' },
    responseType: 'text',
    decompress: true,
  });

  if (typeof response.data !== 'string' || !response.data.trim()) {
    return null;
  }

  return parseStooqQuote(response.data, symbol);
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

/**
 * Looks up one global ETF ticker (for example: VOO, CSPX.L).
 */
export async function fetchGlobalEtf(symbol: string): Promise<GlobalEtf | null> {
  const trimmedSymbol = symbol.trim();
  if (!trimmedSymbol) {
    return null;
  }

  try {
    const response = await axios.get<YahooQuoteApiResponse>(YAHOO_QUOTE_API_URL, {
      headers: {
        Accept: 'application/json',
        Referer: 'https://finance.yahoo.com/',
        'User-Agent': HEADERS['User-Agent'],
      },
      params: { symbols: trimmedSymbol },
      decompress: true,
    });

    const quotes = response.data?.quoteResponse?.result;
    if (Array.isArray(quotes) && quotes.length > 0) {
      const firstQuote = mapYahooQuoteToGlobalEtf(quotes[0]);
      if (firstQuote) {
        return firstQuote;
      }
    }

    return fetchGlobalEtfFromStooq(trimmedSymbol);
  } catch (err) {
    if (err instanceof AxiosError) {
      const statusCode = err.response?.status;
      if (statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 429) {
        return fetchGlobalEtfFromStooq(trimmedSymbol);
      }
    }

    return fetchGlobalEtfFromStooq(trimmedSymbol);
  }
}

export async function fetchSbn(period = '10y'): Promise<SbnItem[]> {
  const response = await axios.get<SbnApiResponse>(BIBIT_SBN_API_URL, {
    headers: { ...HEADERS, Referer: 'https://bibit.id/sbn' },
    params: { period },
    decompress: true,
  });

  if (!Array.isArray(response.data?.data)) {
    throw new Error(`Unexpected response shape for SBN endpoint: ${JSON.stringify(response.data)}`);
  }

  return response.data.data.map((item) => ({
    id: item.serie_id,
    code: item.serie_code,
    name: item.name,
    coupon_rate: item.coupon_rate,
    due_at: item.due_at,
    first_coupon_date: item.first_coupon_date,
  }));
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

// ─── Bareksa Fetcher ─────────────────────────────────────────────────────────

async function fetchBareksaFund(id: number): Promise<Fund | null> {
  const response = await axios.get<BareksaNavApiResponse>(BAREKSA_NAV_URL, {
    headers: {
      Accept: 'application/json',
      'User-Agent': HEADERS['User-Agent'],
    },
    params: { id, cperiod: '1y' },
    decompress: true,
  });

  if (!response.data?.status) {
    return null;
  }

  const fundData = response.data.data?.datas?.[0];
  if (!fundData || !Array.isArray(fundData.nav) || fundData.nav.length === 0) {
    return null;
  }

  const lastNav = fundData.nav[fundData.nav.length - 1];
  const navValue = Number.parseFloat(lastNav.value);
  if (Number.isNaN(navValue)) {
    return null;
  }

  return {
    id: Number(fundData.pid),
    name: fundData.pname,
    last_nav: navValue,
  };
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

  // Supplement with funds not listed on Bibit
  console.log('\n  Fetching supplemental funds from Bareksa ...');
  const bareksaFund = await fetchBareksaFund(5025);
  if (bareksaFund) {
    results.push(bareksaFund);
    console.log(`  → Added "${bareksaFund.name}" (NAV: ${bareksaFund.last_nav})`);
  } else {
    console.warn('  ⚠ Could not fetch Bareksa fund id=5025');
  }

  return results;
}


