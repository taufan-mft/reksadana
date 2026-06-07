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

const YAHOO_CHART_REQUEST_PROFILES: Array<{
  providerLabel: string;
  buildHeaders: (symbol: string) => Record<string, string>;
  buildParams: () => Record<string, string | number | boolean>;
}> = [
  {
    providerLabel: 'browser-1m',
    buildHeaders: (symbol: string) => ({
      accept: '*/*',
      'accept-language': 'en-GB,en;q=0.9',
      priority: 'u=1, i',
      'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
      'sec-ch-ua-mobile': '?1',
      'sec-ch-ua-platform': '"iOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      Referer: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`,
    }),
    buildParams: () => {
      const period2 = Math.floor(Date.now() / 1000);
      const period1 = period2 - 2 * 24 * 60 * 60;
      return {
        period1,
        period2,
        interval: '1m',
        includePrePost: true,
        events: 'div|split|earn',
        lang: 'en-US',
        region: 'US',
        source: 'cosaic',
      };
    },
  },
  {
    providerLabel: 'legacy-1d',
    buildHeaders: () => ({
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://finance.yahoo.com/',
      'User-Agent': USER_AGENT,
    }),
    buildParams: () => ({
      interval: '1d',
      range: '1d',
    }),
  },
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

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function findLatestFiniteNumber(values: unknown): number | null {
  if (!Array.isArray(values)) {
    return null;
  }

  for (let index = values.length - 1; index >= 0; index -= 1) {
    const parsed = toFiniteNumber(values[index]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function toIsoFromUnixTimestamp(value: unknown): string | null {
  const timestamp = toFiniteNumber(value);
  if (timestamp === null) {
    return null;
  }

  const millis = timestamp >= 1_000_000_000_000 ? timestamp : timestamp * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return null;
}

function mapYahooQuoteToGlobalEtf(quote: RawYahooQuote, requestedSymbol: string): GlobalEtf | null {
  const symbol = firstString(quote.symbol, requestedSymbol?.toUpperCase());
  if (!symbol) {
    logProviderParseIssue('yahoo-quote', requestedSymbol, 'missing symbol');
    return null;
  }

  const marketPrice = toFiniteNumber(quote.regularMarketPrice);
  if (marketPrice === null) {
    logProviderParseIssue('yahoo-quote', requestedSymbol, 'missing regularMarketPrice');
    return null;
  }

  const displayName = firstString(quote.longName, quote.shortName, symbol) ?? symbol;

  const exchange = firstString(quote.fullExchangeName, quote.exchange);
  const priceUpdatedAt = toIsoFromUnixTimestamp(quote.regularMarketTime);

  return {
    symbol,
    name: displayName,
    last_price: marketPrice,
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
  const dataRecord = toRecord(data);
  const chart = toRecord(dataRecord?.chart);
  const resultList = Array.isArray(chart?.result) ? chart.result : null;
  if (!resultList?.length) {
    logProviderParseIssue('yahoo-chart', requestedSymbol, 'missing chart.result[]');
    return null;
  }

  const result = toRecord(resultList[0]);
  if (!result) {
    logProviderParseIssue('yahoo-chart', requestedSymbol, 'chart.result[0] is not an object');
    return null;
  }

  const meta = toRecord(result.meta) ?? {};
  let lastPrice = toFiniteNumber(meta.regularMarketPrice);

  if (lastPrice === null) {
    const indicators = toRecord(result.indicators) ?? {};
    const quotes = Array.isArray(indicators.quote) ? indicators.quote : [];
    const firstQuote = toRecord(quotes[0]);
    lastPrice = findLatestFiniteNumber(firstQuote?.close);
  }

  if (lastPrice === null) {
    lastPrice = toFiniteNumber(meta.chartPreviousClose) ?? toFiniteNumber(meta.previousClose);
  }

  if (lastPrice === null) {
    logProviderParseIssue(
      'yahoo-chart',
      requestedSymbol,
      'price missing in meta.regularMarketPrice, indicators.quote[0].close, and previous close fields',
    );
    return null;
  }

  const priceUpdatedAt = toIsoFromUnixTimestamp(meta.regularMarketTime);
  const name = firstString(meta.longName, meta.shortName, requestedSymbol.toUpperCase()) ?? requestedSymbol.toUpperCase();

  return {
    symbol: requestedSymbol.toUpperCase(),
    name,
    last_price: lastPrice,
    currency: typeof meta.currency === 'string' ? meta.currency : null,
    exchange: firstString(meta.fullExchangeName, meta.exchangeName),
    quote_type: typeof meta.instrumentType === 'string' ? meta.instrumentType : 'ETF',
    price_updated_at: priceUpdatedAt,
  };
}

function mapSparkMetaToGlobalEtf(meta: Record<string, unknown>, requestedSymbol: string): GlobalEtf | null {
  const marketPrice = toFiniteNumber(meta.regularMarketPrice) ?? toFiniteNumber(meta.previousClose);
  if (marketPrice === null) {
    logProviderParseIssue('yahoo-spark', requestedSymbol, 'missing regularMarketPrice and previousClose');
    return null;
  }

  const name = firstString(meta.longName, meta.shortName, requestedSymbol.toUpperCase()) ?? requestedSymbol.toUpperCase();
  const priceUpdatedAt = toIsoFromUnixTimestamp(meta.regularMarketTime);

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
  const dataRecord = toRecord(data);
  const spark = toRecord(dataRecord?.spark);
  const results = Array.isArray(spark?.result) ? spark.result : null;
  if (!results?.length) {
    logProviderParseIssue('yahoo-spark', requestedSymbol, 'missing spark.result[]');
    return null;
  }

  const matched = results.find((entry) => {
    const record = toRecord(entry);
    const symbol = record?.symbol;
    return typeof symbol === 'string' && symbol.toUpperCase() === requestedSymbol.toUpperCase();
  });

  const sparkResult = toRecord(matched ?? results[0]);
  if (!sparkResult) {
    logProviderParseIssue('yahoo-spark', requestedSymbol, 'spark.result entry is not an object');
    return null;
  }

  const response = Array.isArray(sparkResult?.response) ? sparkResult.response[0] : null;
  const responseRecord = toRecord(response);
  const meta = toRecord(responseRecord?.meta);
  if (!meta) {
    logProviderParseIssue('yahoo-spark', requestedSymbol, 'missing spark.response[0].meta');
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
    for (const profile of YAHOO_CHART_REQUEST_PROFILES) {
      try {
        const response = await axios.get(`${baseUrl}/${encodeURIComponent(symbol)}`, {
          headers: profile.buildHeaders(symbol),
          params: profile.buildParams(),
          decompress: true,
          timeout: PROVIDER_TIMEOUT_MS,
        });

        const parsed = parseYahooChartQuote(response.data, symbol);
        if (parsed) {
          return parsed;
        }
      } catch (err) {
        logProviderError(`yahoo-chart(${baseUrl};${profile.providerLabel})`, symbol, err);
      }
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
      const firstQuote = mapYahooQuoteToGlobalEtf(quotes[0], trimmedSymbol);
      if (firstQuote) {
        await writeEtfCacheEntry(trimmedSymbol, firstQuote);
        return firstQuote;
      }

      logProviderParseIssue('yahoo-quote', trimmedSymbol, 'quoteResponse.result[0] missing required fields');
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
