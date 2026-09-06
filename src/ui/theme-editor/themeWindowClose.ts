interface CloseEvent {
  preventDefault(): void;
}

interface ThemeCloseOptions {
  pendingSave(): Promise<void> | null;
  flushInput(): void;
  isDirty(): boolean;
  confirmDiscard(): Promise<boolean>;
  destroy(): Promise<void>;
  onError(error: unknown): void;
}

export function createThemeWindowClose(options: ThemeCloseOptions) {
  let closing = false;
  let disposed = false;
  return {
    dispose() {
      disposed = true;
    },
    async onClose(event: CloseEvent) {
      event.preventDefault();
      if (closing || disposed) return;
      closing = true;
      try {
        options.flushInput();
        let saving = options.pendingSave();
        while (saving) {
          await saving;
          const next = options.pendingSave();
          if (next === saving) break;
          saving = next;
        }
        if (disposed) return;
        options.flushInput();
        if (options.isDirty() && !(await options.confirmDiscard())) return;
        if (!disposed) await options.destroy();
      } catch (error) {
        if (!disposed) options.onError(error);
      } finally {
        closing = false;
      }
    },
  };
}
