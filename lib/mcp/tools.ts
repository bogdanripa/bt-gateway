/**
 * MCP tool catalog for BT Gateway.
 *
 * Each tool is a thin façade in front of a `/api/v1/*` endpoint. The MCP
 * dispatcher (app/mcp/route.ts) authenticates the inbound bearer token,
 * builds a `selfBaseUrl` from the request, then calls the matching
 * endpoint over HTTP with the same bearer attached. We deliberately do
 * NOT call internal route handlers directly — going through the network
 * means the underlying access / filter / audit checks run exactly once,
 * in exactly the same path a REST consumer would hit.
 *
 * Tool input schemas use JSON Schema (per the MCP spec). Keep them
 * minimal — the inner route does its own validation with zod and will
 * reject anything malformed with a clear error.
 */

import 'server-only';

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema describing the `arguments` object. */
  inputSchema: Record<string, unknown>;
  /** True if this tool can mutate state — gated on the caller's `rw` access. */
  mutating?: boolean;
  /**
   * Build the HTTP request for the inner /api/v1/* call. Returns the
   * sub-path (after the base URL), HTTP method, and optional JSON body.
   */
  invoke(args: Record<string, unknown>): {
    path: string;
    method: 'GET' | 'POST';
    body?: unknown;
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'get_cash',
    description:
      "Get cash balances in the user's BT trading account, across every evaluation currency the account holds. No arguments.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    invoke: () => ({ path: '/api/v1/cash', method: 'GET' }),
  },
  {
    name: 'get_holdings',
    description:
      "List the user's open positions with current marks, market value, and unrealized P&L. No arguments.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    invoke: () => ({ path: '/api/v1/holdings', method: 'GET' }),
  },
  {
    name: 'list_orders',
    description:
      "List the user's orders, optionally filtered. Statuses are BT's status codes (e.g. OPEN, FILLED, CANCELLED, REJECTED). Dates are YYYY-MM-DD.",
    inputSchema: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional status filter, e.g. ["OPEN","FILLED"].',
        },
        side: { type: 'string', enum: ['buy', 'sell'] },
        symbol: { type: 'string' },
        startDate: { type: 'string', description: 'YYYY-MM-DD inclusive lower bound.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD inclusive upper bound.' },
      },
      additionalProperties: false,
    },
    invoke: (a) => {
      const sp = new URLSearchParams();
      if (Array.isArray(a.statuses)) sp.set('statuses', a.statuses.join(','));
      if (str(a.side)) sp.set('side', str(a.side)!);
      if (str(a.symbol)) sp.set('symbol', str(a.symbol)!);
      if (str(a.startDate)) sp.set('startDate', str(a.startDate)!);
      if (str(a.endDate)) sp.set('endDate', str(a.endDate)!);
      const q = sp.toString();
      return { path: `/api/v1/orders${q ? `?${q}` : ''}`, method: 'GET' };
    },
  },
  {
    name: 'get_order',
    description: 'Fetch a single order by its BT order ID.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: "BT's opaque order ID." },
      },
      required: ['orderId'],
      additionalProperties: false,
    },
    invoke: (a) => ({
      path: `/api/v1/orders/${encodeURIComponent(String(a.orderId))}`,
      method: 'GET',
    }),
  },
  {
    name: 'get_instrument',
    description:
      'Look up an instrument by ticker symbol. Returns metadata, available listings/markets, and current quote info.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (case-insensitive), e.g. "TVBETETF", "TLV".' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    invoke: (a) => ({
      path: `/api/v1/instruments/${encodeURIComponent(String(a.symbol))}`,
      method: 'GET',
    }),
  },
  {
    name: 'list_markets',
    description:
      'List the markets/exchanges available on BT Trade (Bucharest stock exchange segments, foreign markets, etc.). Useful for understanding what marketId values place_order accepts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    invoke: () => ({ path: '/api/v1/markets', method: 'GET' }),
  },
  {
    name: 'preview_order',
    description:
      'Preview an order — get fees, net value, and validity — WITHOUT placing it. Always read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        marketId: { type: ['string', 'number'], description: 'Optional; resolved from symbol if omitted.' },
        quantity: { type: 'number', minimum: 0 },
        price: { type: 'number', exclusiveMinimum: 0 },
        side: { type: 'string', enum: ['buy', 'sell'] },
        type: { type: 'string', enum: ['limit', 'market'], default: 'limit' },
      },
      required: ['symbol', 'price', 'side'],
      additionalProperties: false,
    },
    invoke: (a) => ({
      path: '/api/v1/orders/preview',
      method: 'POST',
      body: {
        symbol: a.symbol,
        marketId: a.marketId,
        quantity: num(a.quantity),
        price: num(a.price),
        side: a.side,
        type: a.type ?? 'limit',
      },
    }),
  },
  {
    name: 'place_order',
    description:
      "Place an order on the user's BT account. Requires read+write access — read-only connections will get a FORBIDDEN error. Defaults: type=limit, valability=day.",
    mutating: true,
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        marketId: { type: ['string', 'number'], description: 'Optional; resolved from symbol if omitted.' },
        quantity: { type: 'number', minimum: 1 },
        price: { type: 'number', exclusiveMinimum: 0, description: 'Required unless type is "market".' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        type: { type: 'string', enum: ['limit', 'market'], default: 'limit' },
        valability: { type: 'string', enum: ['day', 'gtc'], default: 'day' },
      },
      required: ['symbol', 'quantity', 'side'],
      additionalProperties: false,
    },
    invoke: (a) => ({
      path: '/api/v1/orders',
      method: 'POST',
      body: {
        symbol: a.symbol,
        marketId: a.marketId,
        quantity: num(a.quantity),
        price: num(a.price),
        side: a.side,
        type: a.type ?? 'limit',
        valability: a.valability ?? 'day',
      },
    }),
  },
];

export function findTool(name: string): McpTool | undefined {
  return MCP_TOOLS.find((t) => t.name === name);
}
