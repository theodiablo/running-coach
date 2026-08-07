// Which heart-rate nudge (if any) to offer when the user taps Start.
//
// Pure so the platform rules are testable without mounting the tracker: a synced
// hrMethod naming the OTHER platform's integration must produce NO nudge — the
// re-authorize prompt would be meaningless there, and the generic setup prompt
// would mislead, since the method is only effectively "off" on this device.
// Copy lives at the call site; this decides which prompt, never what it says.
export type HrNudgeId = "auth" | "hkAuth" | "pair" | "setup";

export type HrNudgeChoice = {
  id: HrNudgeId;
  // Only the generic off-state prompt may be permanently dismissed — a
  // re-authorize or pairing nudge is about a broken setup the user chose.
  allowOptOut: boolean;
};

export type HrNudgeInput = {
  isNative: boolean;
  isAndroid: boolean;
  isIos: boolean;
  hrMethod?: string | null;
  healthConnectAuthorized: boolean;
  healthKitAuthorized: boolean;
  pairedHrDevice: boolean;
  hrOptOut: boolean;
};

export function hrNudgeFor(o: HrNudgeInput): HrNudgeChoice | null {
  if (!o.isNative) return null;
  if (o.hrMethod === "healthconnect" && o.isAndroid && !o.healthConnectAuthorized) return { id: "auth", allowOptOut: false };
  if (o.hrMethod === "healthkit" && o.isIos && !o.healthKitAuthorized) return { id: "hkAuth", allowOptOut: false };
  if (o.hrMethod === "bluetooth" && !o.pairedHrDevice) return { id: "pair", allowOptOut: false };
  if ((o.hrMethod || "off") === "off" && !o.hrOptOut) return { id: "setup", allowOptOut: true };
  return null;
}
