export interface Stock {
  id: number;
  symbol: string;
  name: string;
  price: number;
  change: number;
  percent: number;
  price_updated_at: string;
  type: string;
  sub_sector: string;
  is_sharia: number;
  ipo_date: string;
}

export interface RawStockResponse {
  message: string;
  data: Stock;
}

export interface Fund {
  id: number;
  name: string;
  last_nav: number;
}

// Raw shape returned after decryption. Only fields we need are typed here.
export interface RawFund {
  id: number;
  name: string;
  nav?: {
    value: number | null;
    date: string | null;
    first_date: string | null;
  };
  [key: string]: unknown;
}

export interface ApiResponse {
  message: string;
  data: string; // AES-encrypted payload
}

export interface RawSbnItem {
  serie_id: number;
  serie_code: string;
  name: string;
  coupon_rate: number;
  due_at: string;
  first_coupon_date: string;
  [key: string]: unknown;
}

export interface SbnApiResponse {
  message: string;
  data: RawSbnItem[];
}

export interface SbnItem {
  id: number;
  code: string;
  name: string;
  coupon_rate: number;
  due_at: string;
  first_coupon_date: string;
}

export interface GlobalEtf {
  symbol: string;
  name: string;
  last_price: number;
  currency: string | null;
  exchange: string | null;
  quote_type: string | null;
  price_updated_at: string | null;
}

export interface GoldPrice {
  name: string;
  last_price: number;
  currency: string | null;
  exchange: string | null;
  price_updated_at: string | null;
}

export interface RawYahooQuote {
  symbol?: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice?: number | string | null;
  currency?: string;
  fullExchangeName?: string;
  exchange?: string;
  quoteType?: string;
  regularMarketTime?: number | string | null;
  [key: string]: unknown;
}

export interface YahooQuoteApiResponse {
  quoteResponse?: {
    result?: Array<RawYahooQuote | Record<string, unknown>>;
    error?: unknown;
  };
}

export interface BareksaNavItem {
  id: string;
  date: string;
  value: string;
}

export interface BareksaFundData {
  pid: string;
  pname: string;
  nav: BareksaNavItem[];
}

export interface BareksaNavApiResponse {
  status: boolean;
  data: {
    datas: BareksaFundData[];
  };
}
