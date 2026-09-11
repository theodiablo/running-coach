import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the module-level mocks can reach them.
const h = vi.hoisted(() => ({
  insert: vi.fn(),
  notify: vi.fn(),
  userId: vi.fn(),
}));

vi.mock("./supabase", () => ({ supabase: { from: () => ({ insert: h.insert }) } }));
vi.mock("./db", () => ({ currentUserId: h.userId }));
vi.mock("./notify", () => ({ notifyContribution: h.notify }));
vi.mock("./native", () => ({ platform: "android", nativeBuildLabel: () => "1.14.2 (98)" }));

const { submitBetaFeedback, MAX_FEEDBACK_LEN } = await import("./betaFeedback");

const row = () => h.insert.mock.calls[0][0];

describe("submitBetaFeedback", () => {
  beforeEach(() => {
    h.insert.mockReset().mockResolvedValue({ error: null });
    h.notify.mockReset();
    h.userId.mockReset().mockReturnValue("user-1");
  });

  it("writes the context the maintainer reads in the SQL editor", async () => {
    await submitBetaFeedback({ body: "charts unreadable", source: "coach" });
    expect(row()).toMatchObject({
      user_id: "user-1",
      body: "charts unreadable",
      source: "coach",
      platform: "android",
      app_version: "1.14.2 (98)",
      input_mode: "text",
    });
    // Fire-and-forget maintainer email, keyed to the row just written.
    expect(h.notify).toHaveBeenCalledWith({ type: "beta_feedback", feedbackId: row().id });
  });

  it("trims, and stays inside the column's length check", async () => {
    // The table constrains body to 1..4000; a client that posted more would be
    // rejected by Postgres rather than by anything the user can see.
    await submitBetaFeedback({ body: `  ${"x".repeat(MAX_FEEDBACK_LEN + 500)}  `, source: "dash" });
    expect(row().body.length).toBe(MAX_FEEDBACK_LEN);
  });

  it("refuses an empty report and one from a signed-out client", async () => {
    await expect(submitBetaFeedback({ body: "   ", source: "dash" }))
      .rejects.toThrow();
    h.userId.mockReturnValue(null);
    await expect(submitBetaFeedback({ body: "real", source: "dash" }))
      .rejects.toThrow();
    expect(h.insert).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("does not send the maintainer an email for a write that failed", async () => {
    // beta_feedback has no client SELECT policy, so a failed insert is the only
    // signal there is — notifying anyway would point the email at a missing row.
    h.insert.mockResolvedValue({ error: { message: "denied" } });
    await expect(submitBetaFeedback({ body: "real", source: "settings" }))
      .rejects.toBeTruthy();
    expect(h.notify).not.toHaveBeenCalled();
  });
});
