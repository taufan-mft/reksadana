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
