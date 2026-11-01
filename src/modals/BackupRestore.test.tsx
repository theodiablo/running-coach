import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BackupModal } from "./BackupModal";
import { RestoreModal } from "./RestoreModal";

// Seeds the modal test layer. These two modals are the self-contained backup/restore
// round-trip (props: data/onRestore + onClose), so they need no `shared` bag. The
// accessible-name assertions on the close buttons guard their aria-labels.

describe("BackupModal", () => {
  const data = { runs: [{ id: "a" }, { id: "b" }], plan: {} };

  it("exposes a labelled Close control that calls onClose", () => {
    const onClose = vi.fn();
    render(<BackupModal data={data} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("copies the backup JSON to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<BackupModal data={data} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(data);
    vi.unstubAllGlobals();
  });
});

describe("RestoreModal", () => {
  beforeEach(() => vi.restoreAllMocks());

  const type = (value: string) =>
    fireEvent.change(screen.getByRole("textbox"), { target: { value } });

  it("exposes a labelled Close control that calls onClose", () => {
    const onClose = vi.fn();
    render(<RestoreModal onRestore={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("rejects invalid JSON with an error and does not restore", () => {
    const onRestore = vi.fn();
    render(<RestoreModal onRestore={onRestore} onClose={() => {}} />);
    type("{not json");
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    expect(screen.getByText(/invalid json/i)).toBeInTheDocument();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("rejects a well-formed but non-backup object", () => {
    const onRestore = vi.fn();
    render(<RestoreModal onRestore={onRestore} onClose={() => {}} />);
    type(JSON.stringify({ foo: 1 }));
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    expect(screen.getByText(/doesn't look like a valid backup/i)).toBeInTheDocument();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it("restores a valid backup and closes", () => {
    const onRestore = vi.fn();
    const onClose = vi.fn();
    const payload = { runs: [{ id: "x" }], plan: { weeks: [] } };
    render(<RestoreModal onRestore={onRestore} onClose={onClose} />);
    type(JSON.stringify(payload));
    fireEvent.click(screen.getByRole("button", { name: /restore/i }));
    expect(onRestore).toHaveBeenCalledOnce();
    expect(onRestore.mock.calls[0][0]).toMatchObject(payload);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
