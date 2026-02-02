import { describe, expect, it } from "vitest";
import { createAppDb } from "./client.js";
import { commitmentTemplates } from "./schema.js";

describe("db", () => {
  it("creates schema and seeds templates", () => {
    const { db, close } = createAppDb(":memory:");
    try {
      const templates = db.select().from(commitmentTemplates).all();
      expect(templates.length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });
});
