import axios, { AxiosError } from 'axios';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GlobalEtf, RawYahooQuote, YahooQuoteApiResponse } from './types';

const YAHOO_QUOTE_API_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const YAHOO_SPARK_API_URL = 'https://query1.finance.yahoo.com/v7/finance/spark';
const YAHOO_CHART_API_URLS = [
  'https://query2.finance.yahoo.com/v8/finance/chart',
  'https://query1.finance.yahoo.com/v8/finance/chart',
];
const STOOQ_QUOTE_API_URL = 'https://stooq.com/q/l/';
const PROVIDER_TIMEOUT_MS = 5000;
const ETF_CACHE_PATH = path.resolve(process.cwd(), 'output/globalEtf-cache.json');

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

function toCacheKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

async function readEtfCache(): Promise<Record<string, GlobalEtf>> {
  try {
    const content = await readFile(ETF_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    return parsed as Record<string, GlobalEtf>;
  } catch {
    return {};
  }
}

async function writeEtfCacheEntry(symbol: string, quote: GlobalEtf): Promise<void> {
  try {
    const cache = await readEtfCache();
    cache[toCacheKey(symbol)] = quote;
    await mkdir(path.dirname(ETF_CACHE_PATH), { recursive: true });
    await writeFile(ETF_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    // Cache persistence is best-effort; fetch should not fail because of local I/O issues.
  }
}

async function readEtfCacheEntry(symbol: string): Promise<GlobalEtf | null> {
  const cache = await readEtfCache();
  return cache[toCacheKey(symbol)] ?? null;
}

async function useCachedEtfIfAvailable(symbol: string): Promise<GlobalEtf | null> {
  const cached = await readEtfCacheEntry(symbol);
  if (!cached) {
    return null;
  }
  console.error(`[fetchGlobalEtf] provider=cache symbol=${symbol} status=hit`);
  return cached;
}

function logProviderError(provider: string, symbol: string, err: unknown): void {
  const statusCode = err instanceof AxiosError ? err.response?.status ?? null : null;
  const errorCode = err instanceof AxiosError ? err.code ?? null : null;
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[fetchGlobalEtf] provider=${provider} symbol=${symbol} status=${statusCode ?? 'none'} code=${errorCode ?? 'none'} message=${message}`,
  );
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

function parseYahooChartQuote(data: unknown, requestedSymbol: string): GlobalEtf | null {
  const chart = (data as { chart?: { result?: Array<Record<string, unknown>> } })?.chart;
  const result = chart?.result?.[0];
  if (!result) {
    return null;
  }

  const meta = (result.meta as Record<string, unknown> | undefined) ?? {};
  const priceFromMeta = meta.regularMarketPrice;
  let lastPrice = typeof priceFromMeta === 'number' && !Number.isNaN(priceFromMeta) ? priceFromMeta : null;

  if (lastPrice === null) {
    const indicators = (result.indicators as Record<string, unknown> | undefined) ?? {};
    const quote = Array.isArray(indicators.quote)
      ? (indicators.quote[0] as { close?: Array<number | null> } | undefined)
      : undefined;
    const closes = Array.isArray(quote?.close) ? quote.close : [];
    for (let index = closes.length - 1; index >= 0; index -= 1) {
      const value = closes[index];
      if (typeof value === 'number' && !Number.isNaN(value)) {
        lastPrice = value;
        break;
      }
    }
  }

  if (lastPrice === null) {
    return null;
  }

  const regularMarketTime = meta.regularMarketTime;
  const priceUpdatedAt =
    typeof regularMarketTime === 'number' ? new Date(regularMarketTime * 1000).toISOString() : null;

  const shortName = typeof meta.shortName === 'string' ? meta.shortName : null;

  return {
    symbol: requestedSymbol.toUpperCase(),
    name: shortName ?? requestedSymbol.toUpperCase(),
    last_price: lastPrice,
    currency: typeof meta.currency === 'string' ? meta.currency : null,
    exchange: typeof meta.exchangeName === 'string' ? meta.exchangeName : null,
    quote_type: typeof meta.instrumentType === 'string' ? meta.instrumentType : 'ETF',
    price_updated_at: priceUpdatedAt,
  };
}

function mapSparkMetaToGlobalEtf(meta: Record<string, unknown>, requestedSymbol: string): GlobalEtf | null {
  const marketPrice = meta.regularMarketPrice;
  if (typeof marketPrice !== 'number' || Number.isNaN(marketPrice)) {
    return null;
  }

  const name =
    typeof meta.longName === 'string'
      ? meta.longName
      : typeof meta.shortName === 'string'
        ? meta.shortName
        : requestedSymbol.toUpperCase();

  const regularMarketTime = meta.regularMarketTime;
  const priceUpdatedAt =
    typeof regularMarketTime === 'number' ? new Date(regularMarketTime * 1000).toISOString() : null;

  return {
    symbol: requestedSymbol.toUpperCase(),
    name,
    last_price: marketPrice,
    currency: typeof meta.currency === 'string' ? meta.currency : null,
    exchange: typeof meta.fullExchangeName === 'string' ? meta.fullExchangeName : null,
    quote_type: typeof meta.instrumentType === 'string' ? meta.instrumentType : 'ETF',
    price_updated_at: priceUpdatedAt,
  };
}

function parseYahooSparkQuote(data: unknown, requestedSymbol: string): GlobalEtf | null {
  const spark = (data as { spark?: { result?: Array<Record<string, unknown>> } })?.spark;
  const sparkResult = spark?.result?.find((entry) => {
    const symbol = entry.symbol;
    return typeof symbol === 'string' && symbol.toUpperCase() === requestedSymbol.toUpperCase();
  });

  const response = Array.isArray(sparkResult?.response) ? sparkResult.response[0] : null;
  const meta = response && typeof response === 'object' ? (response as { meta?: Record<string, unknown> }).meta : null;
  if (!meta) {
    return null;
  }

  return mapSparkMetaToGlobalEtf(meta, requestedSymbol);
}

async function fetchGlobalEtfFromYahooSpark(symbol: string): Promise<GlobalEtf | null> {
  try {
    const response = await axios.get(YAHOO_SPARK_API_URL, {
      headers: {
        Accept: 'application/json',
        Referer: 'https://finance.yahoo.com/',
        'User-Agent': USER_AGENT,
      },
      params: {
        symbols: symbol,
        interval: '1d',
        range: '1d',
      },
      decompress: true,
      timeout: PROVIDER_TIMEOUT_MS,
    });

    return parseYahooSparkQuote(response.data, symbol);
  } catch (err) {
    logProviderError('yahoo-spark', symbol, err);
    return null;
  }
}

async function fetchGlobalEtfFromYahooChart(symbol: string): Promise<GlobalEtf | null> {
  for (const baseUrl of YAHOO_CHART_API_URLS) {
    try {
      const response = await axios.get(`${baseUrl}/${encodeURIComponent(symbol)}`, {
        headers: {
          Accept: 'application/json',
          Referer: 'https://finance.yahoo.com/',
          'User-Agent': USER_AGENT,
        },
        params: {
          interval: '1d',
          range: '1d',
        },
        decompress: true,
        timeout: PROVIDER_TIMEOUT_MS,
      });

      const parsed = parseYahooChartQuote(response.data, symbol);
      if (parsed) {
        return parsed;
      }
    } catch (err) {
      logProviderError(`yahoo-chart(${baseUrl})`, symbol, err);
    }
  }

  return null;
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
      timeout: PROVIDER_TIMEOUT_MS,
    });
  } catch (err) {
    logProviderError('stooq', symbol, err);
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
      timeout: PROVIDER_TIMEOUT_MS,
    });

    const quotes = response.data?.quoteResponse?.result;
    if (Array.isArray(quotes) && quotes.length > 0) {
      const firstQuote = mapYahooQuoteToGlobalEtf(quotes[0]);
      if (firstQuote) {
        await writeEtfCacheEntry(trimmedSymbol, firstQuote);
        return firstQuote;
      }
    }

    const sparkQuote = await fetchGlobalEtfFromYahooSpark(trimmedSymbol);
    if (sparkQuote) {
      await writeEtfCacheEntry(trimmedSymbol, sparkQuote);
      return sparkQuote;
    }

    const chartQuote = await fetchGlobalEtfFromYahooChart(trimmedSymbol);
    if (chartQuote) {
      await writeEtfCacheEntry(trimmedSymbol, chartQuote);
      return chartQuote;
    }

    const stooqQuote = await fetchGlobalEtfFromStooq(trimmedSymbol);
    if (stooqQuote) {
      await writeEtfCacheEntry(trimmedSymbol, stooqQuote);
      return stooqQuote;
    }

    return useCachedEtfIfAvailable(trimmedSymbol);
  } catch (err) {
    logProviderError('yahoo', trimmedSymbol, err);

    const sparkQuote = await fetchGlobalEtfFromYahooSpark(trimmedSymbol);
    if (sparkQuote) {
      await writeEtfCacheEntry(trimmedSymbol, sparkQuote);
      return sparkQuote;
    }

    const chartQuote = await fetchGlobalEtfFromYahooChart(trimmedSymbol);
    if (chartQuote) {
      await writeEtfCacheEntry(trimmedSymbol, chartQuote);
      return chartQuote;
    }

    const stooqQuote = await fetchGlobalEtfFromStooq(trimmedSymbol);
    if (stooqQuote) {
      await writeEtfCacheEntry(trimmedSymbol, stooqQuote);
      return stooqQuote;
    }

    return useCachedEtfIfAvailable(trimmedSymbol);
  }
}
