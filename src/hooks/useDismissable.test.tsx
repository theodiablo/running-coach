import { describe, it, expect } from "vitest";
import { useEffect, useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { useDismissable } from "./useDismissable";
import { dismissAll, dismissTop } from "../utils/backDismiss";

// End-to-end wiring: a component using useDismissable registers while mounted,
// and a dispatcher (mirroring RunningCoach's Escape handler) closes the topmost
// overlay first — proving the mount/unmount registration and LIFO order.

function Dispatcher() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismissTop(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
}

function Overlay({ label, onClose }: { label: string; onClose: () => void }) {
  useDismissable(true, onClose);
  return <div>{label}</div>;
}

function Harness() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(false);
  return (
    <>
      <Dispatcher />
      <button onClick={() => setInner(true)}>open inner</button>
      <button onClick={dismissAll}>go home</button>
      {outer && <Overlay label="outer" onClose={() => setOuter(false)} />}
      {inner && <Overlay label="inner" onClose={() => setInner(false)} />}
    </>
  );
}

describe("useDismissable (integration)", () => {
  it("Escape closes the innermost overlay first, then the outer", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("open inner"));
    expect(screen.getByText("outer")).toBeInTheDocument();
    expect(screen.getByText("inner")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("inner")).not.toBeInTheDocument();
    expect(screen.getByText("outer")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("outer")).not.toBeInTheDocument();
  });

  // The header's back-to-Home clears the whole stack in one go, not one level.
  it("dismissAll closes every open overlay", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("open inner"));
    fireEvent.click(screen.getByText("go home"));
    expect(screen.queryByText("inner")).not.toBeInTheDocument();
    expect(screen.queryByText("outer")).not.toBeInTheDocument();
  });
});
