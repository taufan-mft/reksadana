import axios, { AxiosError } from 'axios';
import type { GlobalEtf, RawYahooQuote, YahooQuoteApiResponse } from './types';

const YAHOO_QUOTE_API_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const STOOQ_QUOTE_API_URL = 'https://stooq.com/q/l/';

const STOOQ_SUFFIX_MAP: Record<string, string> = {
  L: 'UK',
  LN: 'UK',
};

const STOOQ_CURRENCY_BY_SUFFIX: Record<string, string> = {
  US: 'USD',
  UK: 'GBP',
};

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
  let response;

  try {
    response = await axios.get<string>(STOOQ_QUOTE_API_URL, {
      headers: { Accept: 'text/plain', 'User-Agent': USER_AGENT },
      params: { s: stooqSymbol, i: 'd' },
      responseType: 'text',
      decompress: true,
    });
  } catch (err) {
    console.error(`[fetchGlobalEtf] Stooq fetch failed for ${symbol}`, err);
    throw err;
  }

  if (typeof response.data !== 'string' || !response.data.trim()) {
    return null;
  }

  return parseStooqQuote(response.data, symbol);
}

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
        'User-Agent': USER_AGENT,
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
    console.error(`[fetchGlobalEtf] Yahoo fetch failed for ${trimmedSymbol}`, err);

    if (err instanceof AxiosError) {
      const statusCode = err.response?.status;
      if (statusCode === 401 || statusCode === 403 || statusCode === 404 || statusCode === 429) {
        return fetchGlobalEtfFromStooq(trimmedSymbol);
      }
    }

    return fetchGlobalEtfFromStooq(trimmedSymbol);
  }
}
