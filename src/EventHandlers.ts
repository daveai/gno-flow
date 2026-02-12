import { GnoToken } from "../generated";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

GnoToken.Transfer.handler(async ({ event, context }) => {
  const transferId = `${event.chainId}_${event.block.number}_${event.logIndex}`;
  const fromAddr = event.params.from.toLowerCase();
  const toAddr = event.params.to.toLowerCase();
  const value = event.params.value;

  // Store every transfer (including mints and burns)
  context.Transfer.set({
    id: transferId,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    logIndex: event.logIndex,
    from: fromAddr,
    to: toAddr,
    value,
  });

  // Update sender balance (skip zero address itself — it's not a real account)
  if (fromAddr !== ZERO_ADDRESS) {
    const fromId = `${event.chainId}_${fromAddr}`;
    const fromAccount = await context.Account.get(fromId);

    context.Account.set({
      id: fromId,
      chainId: event.chainId,
      address: fromAddr,
      balance: (fromAccount?.balance ?? 0n) - value,
      transferCount: (fromAccount?.transferCount ?? 0) + 1,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: event.block.timestamp,
    });
  }

  // Update receiver balance (skip zero address itself — it's not a real account)
  if (toAddr !== ZERO_ADDRESS) {
    const toId = `${event.chainId}_${toAddr}`;
    const toAccount = await context.Account.get(toId);

    context.Account.set({
      id: toId,
      chainId: event.chainId,
      address: toAddr,
      balance: (toAccount?.balance ?? 0n) + value,
      transferCount: (toAccount?.transferCount ?? 0) + 1,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: event.block.timestamp,
    });
  }
});
