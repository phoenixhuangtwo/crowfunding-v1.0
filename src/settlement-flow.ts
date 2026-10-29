export async function beginSettlement(confirm: () => Promise<unknown>): Promise<boolean> {
  await confirm()
  return true
}
