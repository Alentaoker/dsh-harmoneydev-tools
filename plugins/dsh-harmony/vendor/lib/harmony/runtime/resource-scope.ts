/** A deadline bounds waiting, not physical device cleanup. Late work remains uncertain. */
export async function boundedCleanup(work: Promise<unknown>, timeoutMs: number): Promise<"complete" | "uncertain"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(() => "complete" as const, () => "uncertain" as const),
      new Promise<"uncertain">(resolve => { timer = setTimeout(() => resolve("uncertain"), timeoutMs); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
