export class ModelChangeCoordinator {
  private pending: Promise<boolean> | null = null;

  track(change: Promise<boolean>): void {
    // Normalize unexpected rejections into a failed transition so a click
    // handler that intentionally does not await this Promise cannot create an
    // unhandled rejection.
    this.pending = change.catch(() => false);
  }

  async waitForIdle(): Promise<boolean> {
    while (true) {
      const pending = this.pending;
      if (!pending) return true;

      let succeeded = false;
      try {
        succeeded = await pending;
      } catch {
        succeeded = false;
      }

      // A newer user selection supersedes this result. Wait for that model
      // transition before deciding whether the prompt may be sent.
      if (this.pending !== pending) continue;
      this.pending = null;
      return succeeded;
    }
  }
}

export async function runModelChange(
  change: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<boolean> {
  try {
    await change();
    return true;
  } catch (error) {
    onFailure(error);
    return false;
  }
}
