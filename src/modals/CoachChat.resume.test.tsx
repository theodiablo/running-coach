import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { CoachChat, type CoachChatSnapshot } from "./CoachChat";
import type { Plan } from "../types";

vi.mock("../coach", () => ({
  coachPing: () => Promise.resolve(),
  coachUsage: () => Promise.resolve(null),
  coachPropose: (text: string) => Promise.resolve({
    rationale: `heard: ${text}`, trajectoryId: "traj-1", roundIndex: 0, changed: false,
  }),
  coachCritique: () => Promise.resolve({ rationale: "ok", trajectoryId: "traj-1", roundIndex: 1, changed: false }),
  coachConfirm: () => Promise.resolve({ plan: null }),
  CoachServerError: class extends Error {},
}));

// jsdom has no layout: the chat scrolls to its end marker on every message.
Element.prototype.scrollIntoView = () => {};

afterEach(cleanup);

const plan = { weeks: [{ weekNumber: 1, sessions: [{ id: "s1", type: "EASY", date: "2026-01-05", km: 5 }] }] } as unknown as Plan;

const props = (over: Partial<React.ComponentProps<typeof CoachChat>> = {}) => ({
  plan,
  onApplyPlan: () => {},
  appendUserContext: () => true,
  showToast: () => {},
  onFeedback: () => {},
  onClose: () => {},
  onNavigate: () => {},
  onSuspend: () => {},
  ...over,
});

const send = async (text: string) => {
  fireEvent.change(screen.getByLabelText("Message to coach"), { target: { value: text } });
  await act(async () => { fireEvent.click(screen.getByLabelText("Send")); });
};

// Following one of the coach's in-app links closes the chat (RunningCoach's
// goCoachLink), so "open the coach again" must not mean "start over".
describe("CoachChat conversation retention", () => {
  it("hands the live conversation back on unmount and restores it", async () => {
    const onSuspend = vi.fn<(s: CoachChatSnapshot | null) => void>();
    const first = render(<CoachChat {...props({ onSuspend })} />);
    await send("my knee hurts");
    expect(screen.getByText("heard: my knee hurts")).toBeInTheDocument();

    first.unmount();
    const snap = onSuspend.mock.calls.at(-1)?.[0];
    expect(snap?.trajectoryId).toBe("traj-1");

    render(<CoachChat {...props({ resume: snap })} />);
    expect(screen.getByText("my knee hurts")).toBeInTheDocument();
    expect(screen.getByText("heard: my knee hurts")).toBeInTheDocument();
    // Resumed on the same trajectory: the next message is a follow-up.
    expect(screen.getByLabelText("Message to coach").getAttribute("placeholder"))
      .toBe("Suggest an edit…");
  });

  it("keeps a half-typed message", async () => {
    const onSuspend = vi.fn<(s: CoachChatSnapshot | null) => void>();
    const first = render(<CoachChat {...props({ onSuspend })} />);
    fireEvent.change(screen.getByLabelText("Message to coach"), { target: { value: "half typed" } });
    first.unmount();
    render(<CoachChat {...props({ resume: onSuspend.mock.calls.at(-1)?.[0] })} />);
    expect(screen.getByLabelText("Message to coach")).toHaveValue("half typed");
  });

  it("suspends nothing from an untouched chat", () => {
    const onSuspend = vi.fn<(s: CoachChatSnapshot | null) => void>();
    render(<CoachChat {...props({ onSuspend })} />).unmount();
    expect(onSuspend).toHaveBeenCalledWith(null);
  });

  it("blocks Apply when the plan changed while the chat was away", async () => {
    const snap: CoachChatSnapshot = {
      msgs: [
        { role: "user", text: "move my long run" },
        { role: "coach", text: "here you go", proposal: { diff: [{ weekNumber: 1, changes: ["Sat: long run moved"] }] } },
      ],
      trajectoryId: "traj-1", viewingClosed: null, applyBlocked: false, draft: "", flagged: [],
      plan, sessionKey: null,
    };
    // Same conversation, untouched plan: Apply is live.
    const same = render(<CoachChat {...props({ resume: snap })} />);
    expect(screen.getByText("Apply this adjustment")).toBeInTheDocument();
    same.unmount();

    const edited = { weeks: [{ weekNumber: 1, sessions: [{ id: "s1", type: "EASY", date: "2026-01-06", km: 9 }] }] } as unknown as Plan;
    render(<CoachChat {...props({ resume: snap, plan: edited })} />);
    expect(screen.queryByText("Apply this adjustment")).toBeNull();
  });
});
