// A frame can survive several writes and a replacement frame can show an intermediate
// revision. Only advance through acknowledged writes made by this Studio instance.
type FileChain = { base: string; current: string; recent: Set<string> };
const chains = new Map<string, FileChain>();

export function isolatedEditVersion(project: string, path: string, shown: string): string {
  const chain = chains.get(JSON.stringify([project, path]));
  return chain && (shown === chain.base || chain.recent.has(shown)) ? chain.current : shown;
}

export function acknowledgeFileEdit(
  project: string, path: string, expected: string | null | undefined, committed: string | null | undefined,
) {
  if (!expected || !committed || expected === committed) return;
  const key = JSON.stringify([project, path]);
  const previous = chains.get(key);
  const chain = previous?.current === expected ? previous : { base: expected, current: expected, recent: new Set<string>() };
  chain.recent.add(expected);
  chain.current = committed;
  // Keep the original frame usable during a long gesture; evicted intermediate frames revalidate normally.
  if (chain.recent.size > 64) chain.recent.delete(chain.recent.values().next().value!);
  chains.delete(key);
  chains.set(key, chain);
  if (chains.size > 128) chains.delete(chains.keys().next().value!);
}
