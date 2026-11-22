import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import { ChunkLoadBoundary } from "../components/ChunkLoadBoundary";
import { useDismissable } from "../hooks/useDismissable";
import type { ShareCardProps } from "./ShareCardSheet";

// The builder, its canvas code and its fonts live in their own chunk, fetched on first open.
const load = () => lazy(() => import("./ShareCardSheet"));
// React caches a rejected lazy import; a failed load swaps in a fresh one so the next open retries.
let ShareCardSheet = load();

function Loading({ onClose }: { onClose: () => void }) {
  useDismissable(true, onClose);
  return <div className="fixed inset-0 z-[2100] bg-slate-900" />;
}

export function ShareCardGate(props: ShareCardProps) {
  const { t } = useTranslation();
  return (
    <ChunkLoadBoundary fallback={null} onError={() => { ShareCardSheet = load(); props.showToast?.(t("shareCard.loadError"), "err"); props.onClose(); }}>
      <Suspense fallback={<Loading onClose={props.onClose} />}>
        <ShareCardSheet {...props} />
      </Suspense>
    </ChunkLoadBoundary>
  );
}
