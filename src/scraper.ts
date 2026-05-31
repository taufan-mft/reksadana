import axios, { AxiosError } from 'axios';
import type { Stock, Fund, RawStockResponse, RawFund, ApiResponse, SbnApiResponse, SbnItem, BareksaNavApiResponse } from './types';
import { decrypt } from './decrypt';

const BAREKSA_NAV_URL = 'https://m.bareksa.com/ajax/mutualfund/nav/product/';
const BIBIT_API_URL = 'https://api.bibit.id/products/list';
const BIBIT_STOCKS_API_URL = 'https://api.bibit.id/stocks/companies';
const BIBIT_SBN_API_URL = 'https://api.bibit.id/sbn/products/histories';
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


