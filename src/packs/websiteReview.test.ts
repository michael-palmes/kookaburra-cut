import { describe, expect, it, vi } from "vitest";
import { websiteReviewRows } from "./websiteReview";

describe("websiteReviewRows", () => {
  it("lists sanitised requested origins and calls out loopback", () => {
    const rows = websiteReviewRows("Launch", [
      { file: "scenes/01-plain.tsx", doc: { version: 1 } },
      {
        file: "scenes/02-demo.tsx",
        doc: {
          version: 1,
          name: "Live demo",
          website: {
            url: "https://example.com/product?token=hidden",
            requestedOrigins: ["https://login.example.com/path", "http://localhost"],
          },
        },
      },
    ]);
    expect(rows).toEqual([
      {
        project: "Launch",
        scene: "Live demo",
        file: "scenes/02-demo.tsx",
        origins: [
          { origin: "https://login.example.com", loopback: false },
          { origin: "http://localhost", loopback: true },
          { origin: "https://example.com", loopback: false },
        ],
      },
    ]);
  });

  it("drops unsafe origins and malformed Website blocks", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows = websiteReviewRows("Launch", [
      { file: "scenes/01-bad.tsx", doc: "not-an-object" },
      { file: "scenes/02-bad.tsx", doc: { website: 7 } },
      {
        file: "scenes/03-safe.tsx",
        doc: {
          website: {
            requestedOrigins: ["http://example.com", "javascript:alert(1)", "https://safe.test"],
          },
        },
      },
    ]);
    warn.mockRestore();
    expect(rows).toEqual([
      {
        project: "Launch",
        scene: "03-safe",
        file: "scenes/03-safe.tsx",
        origins: [{ origin: "https://safe.test", loopback: false }],
      },
    ]);
  });
});
