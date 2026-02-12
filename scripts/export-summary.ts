import * as fs from "fs";
import * as path from "path";

const GRAPHQL_URL =
  process.env.GRAPHQL_URL || "http://localhost:8080/v1/graphql";
const HASURA_SECRET = process.env.HASURA_ADMIN_SECRET || "testing";
const LABELS_PATH = path.resolve(__dirname, "../data/labels.json");
const OUTPUT_PATH = path.resolve(__dirname, "../docs/summary.json");
const TOP_N = 50;
const DECIMALS = 18n;
const DECIMALS_DIVISOR = 10n ** DECIMALS;
const CHAIN_NAMES: Record<number, string> = { 1: "ethereum", 100: "gnosis" };

interface TransferRow {
  chainId: number;
  blockTimestamp: number;
  from: string;
  to: string;
  value: string;
}

interface AccountRow {
  address: string;
  chainId: number;
  balance: string;
  transferCount: number;
}

async function graphqlQuery(
  query: string,
  variables: Record<string, unknown> = {}
) {
  const resp = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-hasura-admin-secret": HASURA_SECRET,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok)
    throw new Error(`GraphQL error: ${resp.status} ${resp.statusText}`);
  const json = (await resp.json()) as {
    data?: Record<string, unknown>;
    errors?: unknown[];
  };
  if (json.errors)
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data!;
}

function bigintToDecimalString(raw: bigint): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const whole = abs / DECIMALS_DIVISOR;
  const frac = abs % DECIMALS_DIVISOR;
  const prefix = negative ? "-" : "";
  if (frac === 0n) return `${prefix}${whole}`;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "");
  return `${prefix}${whole}.${fracStr}`;
}

type FlowEntry = {
  inflow: bigint;
  outflow: bigint;
  count: number;
  chains: Set<string>;
};

async function fetchBalances(
  addresses: string[]
): Promise<Map<string, bigint>> {
  // Query Account entities for all addresses, summing across chains
  const balanceMap = new Map<string, bigint>();
  const batchSize = 500;

  for (let i = 0; i < addresses.length; i += batchSize) {
    const batch = addresses.slice(i, i + batchSize);
    const data = await graphqlQuery(
      `
      query AccountBalances($addresses: [String!]!) {
        Account(where: { address: { _in: $addresses } }) {
          address
          chainId
          balance
        }
      }
    `,
      { addresses: batch }
    );

    const accounts = (data as { Account: AccountRow[] }).Account;
    for (const acct of accounts) {
      const addr = acct.address.toLowerCase();
      const prev = balanceMap.get(addr) || 0n;
      balanceMap.set(addr, prev + BigInt(acct.balance));
    }
  }

  return balanceMap;
}

async function fetchTopHolders(): Promise<
  { address: string; balance: string; transfer_count: number; chains: string[] }[]
> {
  // Fetch all accounts sorted by balance descending, paginated
  const holderMap = new Map<
    string,
    { balance: bigint; transferCount: number; chains: Set<string> }
  >();
  let offset = 0;
  const limit = 5000;

  while (true) {
    const data = await graphqlQuery(
      `
      query TopAccounts($limit: Int!, $offset: Int!) {
        Account(
          where: { balance: { _gt: "0" } }
          order_by: { balance: desc }
          limit: $limit
          offset: $offset
        ) {
          address
          chainId
          balance
          transferCount
        }
      }
    `,
      { limit, offset }
    );

    const accounts = (data as { Account: AccountRow[] }).Account;
    for (const acct of accounts) {
      const addr = acct.address.toLowerCase();
      const existing = holderMap.get(addr);
      const chainName = CHAIN_NAMES[acct.chainId] || `chain_${acct.chainId}`;
      if (existing) {
        existing.balance += BigInt(acct.balance);
        existing.transferCount += acct.transferCount;
        existing.chains.add(chainName);
      } else {
        holderMap.set(addr, {
          balance: BigInt(acct.balance),
          transferCount: acct.transferCount,
          chains: new Set([chainName]),
        });
      }
    }
    if (accounts.length < limit) break;
    offset += limit;
  }

  return [...holderMap.entries()]
    .sort((a, b) => (b[1].balance > a[1].balance ? 1 : b[1].balance < a[1].balance ? -1 : 0))
    .slice(0, TOP_N)
    .map(([address, entry]) => ({
      address,
      balance: bigintToDecimalString(entry.balance),
      transfer_count: entry.transferCount,
      chains: [...entry.chains].sort(),
    }));
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const cutoff7d = now - 7 * 86400;
  const cutoff30d = now - 30 * 86400;

  // Fetch all transfers in the 30d window (paginated)
  let allTransfers: TransferRow[] = [];
  let offset = 0;
  const limit = 10000;

  while (true) {
    const data = await graphqlQuery(
      `
      query RecentTransfers($cutoff: Int!, $limit: Int!, $offset: Int!) {
        Transfer(
          where: { blockTimestamp: { _gte: $cutoff } }
          order_by: { blockTimestamp: asc }
          limit: $limit
          offset: $offset
        ) {
          chainId
          blockTimestamp
          from
          to
          value
        }
      }
    `,
      { cutoff: cutoff30d, limit, offset }
    );

    const batch = (data as { Transfer: TransferRow[] }).Transfer;
    allTransfers = allTransfers.concat(batch);
    if (batch.length < limit) break;
    offset += limit;
  }

  // Get total transfer count
  const countData = await graphqlQuery(`
    query TotalCount {
      Transfer_aggregate {
        aggregate {
          count
        }
      }
    }
  `);
  const totalTransfers = (
    countData as {
      Transfer_aggregate: { aggregate: { count: number } };
    }
  ).Transfer_aggregate.aggregate.count;

  // Compute net flows
  const flows7d = new Map<string, FlowEntry>();
  const flows30d = new Map<string, FlowEntry>();
  const ZERO = "0x0000000000000000000000000000000000000000";

  for (const t of allTransfers) {
    const chainName = CHAIN_NAMES[t.chainId] || `chain_${t.chainId}`;
    const value = BigInt(t.value);
    const fromAddr = t.from.toLowerCase();
    const toAddr = t.to.toLowerCase();

    for (const [cutoff, flows] of [
      [cutoff30d, flows30d],
      [cutoff7d, flows7d],
    ] as [number, Map<string, FlowEntry>][]) {
      if (t.blockTimestamp < cutoff) continue;

      if (fromAddr && fromAddr !== ZERO) {
        const entry = flows.get(fromAddr) || {
          inflow: 0n,
          outflow: 0n,
          count: 0,
          chains: new Set<string>(),
        };
        entry.outflow += value;
        entry.count += 1;
        entry.chains.add(chainName);
        flows.set(fromAddr, entry);
      }

      if (toAddr && toAddr !== ZERO) {
        const entry = flows.get(toAddr) || {
          inflow: 0n,
          outflow: 0n,
          count: 0,
          chains: new Set<string>(),
        };
        entry.inflow += value;
        entry.count += 1;
        entry.chains.add(chainName);
        flows.set(toAddr, entry);
      }
    }
  }

  function buildTop(flows: Map<string, FlowEntry>) {
    return [...flows.entries()]
      .sort((a, b) => {
        const net = (e: FlowEntry) => e.inflow - e.outflow;
        const absA = (() => { const n = net(a[1]); return n < 0n ? -n : n; })();
        const absB = (() => { const n = net(b[1]); return n < 0n ? -n : n; })();
        return absB > absA ? 1 : absB < absA ? -1 : 0;
      })
      .slice(0, TOP_N)
      .map(([address, entry]) => ({
        address,
        inflow: bigintToDecimalString(entry.inflow),
        outflow: bigintToDecimalString(entry.outflow),
        net_flow: bigintToDecimalString(entry.inflow - entry.outflow),
        transfer_count: entry.count,
        chains: [...entry.chains].sort(),
      }));
  }

  const top7d = buildTop(flows7d);
  const top30d = buildTop(flows30d);

  // Collect all unique addresses and fetch balances
  const allAddresses = new Set<string>();
  for (const r of top7d) allAddresses.add(r.address);
  for (const r of top30d) allAddresses.add(r.address);

  console.log(`Fetching balances for ${allAddresses.size} addresses...`);
  const balances = await fetchBalances([...allAddresses]);

  console.log("Fetching top holders...");
  const topHolders = await fetchTopHolders();

  // Add balance to rows
  function addBalances(
    rows: { address: string; inflow: string; outflow: string; net_flow: string; transfer_count: number; chains: string[] }[]
  ) {
    return rows.map((r) => ({
      ...r,
      balance: bigintToDecimalString(balances.get(r.address) || 0n),
    }));
  }

  // Load labels
  let labels: Record<string, string> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(LABELS_PATH, "utf-8"));
    labels = Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v as string])
    );
  } catch {
    // labels.json not found; proceed without
  }

  const summary = {
    top_7d: addBalances(top7d),
    top_30d: addBalances(top30d),
    top_holders: topHolders,
    labels,
    synced_at: new Date().toISOString(),
    total_transfers: totalTransfers,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(summary, null, 2) + "\n");
  console.log(
    `Exported: ${summary.top_7d.length} addresses (7d), ` +
      `${summary.top_30d.length} (30d), ${totalTransfers} total transfers`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
