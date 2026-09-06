import { describe, expect, it, vi } from "vitest";
import { createThemeWindowClose } from "./themeWindowClose";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function fixture(dirty = false) {
  const options = {
    pendingSave: vi.fn<() => Promise<void> | null>(() => null),
    flushInput: vi.fn(),
    isDirty: vi.fn(() => dirty),
    confirmDiscard: vi.fn(async () => true),
    destroy: vi.fn(async () => {}),
    onError: vi.fn(),
  };
  return { options, close: createThemeWindowClose(options), event: { preventDefault: vi.fn() } };
}

describe("theme window close", () => {
  it("closes an unchanged theme without a prompt and owns native destruction", async () => {
    const { options, close, event } = fixture();
    await close.onClose(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(options.confirmDiscard).not.toHaveBeenCalled();
    expect(options.destroy).toHaveBeenCalledOnce();
  });

  it("flushes focused edits before deciding whether to prompt", async () => {
    const { options, close, event } = fixture();
    options.flushInput.mockImplementation(() => options.isDirty.mockReturnValue(true));
    options.confirmDiscard.mockResolvedValue(false);
    await close.onClose(event);
    expect(options.confirmDiscard).toHaveBeenCalledOnce();
    expect(options.destroy).not.toHaveBeenCalled();
  });

  it("waits for a save before checking dirty state", async () => {
    const { options, close, event } = fixture(true);
    const save = deferred<void>();
    options.pendingSave.mockReturnValue(save.promise);
    const closing = close.onClose(event);
    expect(options.destroy).not.toHaveBeenCalled();
    options.isDirty.mockReturnValue(false);
    options.pendingSave.mockReturnValue(null);
    save.resolve();
    await closing;
    expect(options.confirmDiscard).not.toHaveBeenCalled();
    expect(options.destroy).toHaveBeenCalledOnce();
  });

  it("coalesces close clicks during a prompt and permits retry after cancellation", async () => {
    const { options, close, event } = fixture(true);
    const answer = deferred<boolean>();
    options.confirmDiscard.mockReturnValueOnce(answer.promise);
    const first = close.onClose(event);
    await close.onClose(event);
    expect(options.confirmDiscard).toHaveBeenCalledOnce();
    answer.resolve(false);
    await first;
    await close.onClose(event);
    expect(options.confirmDiscard).toHaveBeenCalledTimes(2);
    expect(options.destroy).toHaveBeenCalledOnce();
  });

  it.each(["destroy", "confirmDiscard"] as const)("recovers after %s fails", async (operation) => {
    const { options, close, event } = fixture(true);
    options[operation].mockRejectedValueOnce(new Error("native failure"));
    await close.onClose(event);
    expect(options.onError).toHaveBeenCalledOnce();
    await close.onClose(event);
    expect(options.destroy).toHaveBeenCalled();
  });

  it("keeps the window open when a pending save fails", async () => {
    const { options, close, event } = fixture();
    options.pendingSave.mockReturnValueOnce(Promise.reject(new Error("write failed")));
    await close.onClose(event);
    expect(options.destroy).not.toHaveBeenCalled();
    expect(options.onError).toHaveBeenCalledOnce();
    await close.onClose(event);
    expect(options.destroy).toHaveBeenCalledOnce();
  });

  it("ignores a listener disposed during registration or saving", async () => {
    const { options, close, event } = fixture();
    const save = deferred<void>();
    options.pendingSave.mockReturnValue(save.promise);
    const closing = close.onClose(event);
    close.dispose();
    save.resolve();
    await closing;
    await close.onClose(event);
    expect(options.destroy).not.toHaveBeenCalled();
  });
});
