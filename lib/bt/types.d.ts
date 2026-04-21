/**
 * Ambient type declarations for `@bogdanripa/bt-trade` (plain JS module).
 *
 * Only the surface we actually use. Return values are `unknown` — the route
 * handlers validate / shape them explicitly before returning to the caller.
 */

declare module '@bogdanripa/bt-trade' {
  export interface SessionSnapshot {
    username: string;
    accessToken: string;
    refreshToken: string;
    refreshTokenExpires: string | null;
    expiresAt: number;
    sessionId: string | null;
  }

  export interface OtpPromptInfo {
    username: string;
    prefix: string;
    details: string;
    expiresIn: number;
  }

  export type OtpProvider = (info: OtpPromptInfo) => Promise<string>;

  export interface ClientOptions {
    baseUrl?: string;
    demo?: boolean;
    otpProvider?: OtpProvider;
    log?: (msg: string, data?: unknown) => void;
    debug?: boolean;
    timeoutMs?: number;
    onSessionChange?: (snap: SessionSnapshot | null) => void | Promise<void>;
    onExpired?: (err: Error) => void;
  }

  export interface Account {
    id: string;
    displayName: string;
    relation: string;
    portfolioKey: string;
    selected: boolean;
    allowTrading: boolean;
    allowTopUp: boolean;
    allowView: boolean;
    allowEdit: boolean;
    allowUpdate: boolean;
    allowFatca: boolean;
    pending: boolean;
    approved: boolean;
    portfolios: Array<{
      id: string | number;
      name: string;
      currencies?: Array<{ id: string | number; name: string }>;
    }>;
    raw: unknown;
  }

  export interface AccountsApi {
    list(): Promise<Account[]>;
    defaultCurrencyId(account: Account): string | number | null;
    getAvailableTypes(portfolioKey: string): Promise<unknown>;
  }

  export interface BtProfile {
    selectedPortfolioPanelCurrencyID: string;
    [key: string]: unknown;
  }

  export interface ProfileApi {
    get(opts?: { device?: string }): Promise<BtProfile>;
  }

  export interface MarketsApi {
    list(): Promise<unknown>;
    searchInstrument(code: string): Promise<unknown[]>;
    getInstrument(args: { portfolioKey: string; code: string; marketId: string | number }): Promise<unknown>;
  }

  export interface ReferenceApi {
    listCurrencies(): Promise<unknown>;
    listEvaluationCurrencies(): Promise<unknown>;
    listAccountTypes(): Promise<unknown>;
    listOrderStatuses(): Promise<unknown>;
    listTradeTypes(): Promise<unknown>;
  }

  export interface PortfolioApi {
    getCash(args: { portfolioKey: string; currencyId?: string | number }): Promise<unknown>;
    getCashDetails(args: { portfolioKey: string; currencyId?: string | number }): Promise<unknown>;
    getCashAccounts(args: { portfolioKey: string }): Promise<unknown>;
    getBankAccounts(args: { portfolioKey: string }): Promise<unknown>;
    getHoldings(args: {
      portfolioKey: string;
      market?: string;
      endDate?: string;
      queryModel?: Record<string, unknown>;
    }): Promise<unknown>;
  }

  export type OrderSide = 'buy' | 'sell';
  export type OrderType = 'limit' | 'market';
  export type OrderValability = 'day' | 'gtc';

  export interface OrdersApi {
    search(args: {
      portfolioKey: string;
      statuses?: string[];
      side?: OrderSide;
      symbol?: string;
      interval?: string;
      startDate?: string;
      endDate?: string;
      queryModel?: Record<string, unknown>;
    }): Promise<unknown>;
    get(orderNumber: string | number): Promise<unknown>;
    getActions(orderNumber: string | number): Promise<unknown>;
    getHistory(orderNumber: string | number): Promise<unknown>;
    preview(args: {
      portfolioKey: string;
      symbol: string;
      marketId: string | number;
      quantity?: number | null;
      price: number;
      side: OrderSide;
      type?: OrderType;
    }): Promise<unknown>;
    placeOrder(args: {
      portfolioKey: string;
      symbol: string;
      marketId: string | number;
      quantity: number;
      price?: number;
      side: OrderSide;
      type?: OrderType;
      valability?: OrderValability;
    }): Promise<unknown>;
  }

  export class BTTradeClient {
    constructor(opts?: ClientOptions);
    readonly demo: boolean;
    readonly profile: ProfileApi;
    readonly markets: MarketsApi;
    readonly reference: ReferenceApi;
    readonly accounts: AccountsApi;
    readonly portfolio: PortfolioApi;
    readonly orders: OrdersApi;
    login(args: { username: string; password: string }): Promise<SessionSnapshot>;
    restore(snapshot: SessionSnapshot): void;
    toSnapshot(): SessionSnapshot | null;
    logout(): Promise<void>;
  }

  export function ntfyOtpProvider(opts?: {
    topic?: string;
    server?: string;
    timeoutMs?: number;
    since?: string;
    log?: (msg: string, data?: unknown) => void;
  }): OtpProvider;

  export function stdinOtpProvider(): OtpProvider;
  export function defaultNtfyTopic(username: string): string;
  export function normalizeOtp(typed: string, prefix?: string): string;

  export class BTTradeError extends Error { code?: string; }
  export class AuthError extends BTTradeError {}
  export class NetworkError extends BTTradeError {}
  export class ApiError extends BTTradeError { status?: number; }
  export class ValidationError extends BTTradeError {}
}
