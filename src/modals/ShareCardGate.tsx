import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import { ChunkLoadBoundary } from "../components/ChunkLoadBoundary";
import type { ShareCardProps } from "./ShareCardSheet";

// The builder, its canvas code and its fonts live in their own chunk, fetched on first open.
const ShareCardSheet = lazy(() => import("./ShareCardSheet"));

export function ShareCardGate(props: ShareCardProps) {
  const { t } = useTranslation();
  return (
    <ChunkLoadBoundary fallback={null} onError={() => { props.showToast?.(t("shareCard.loadError"), "err"); props.onClose(); }}>
      <Suspense fallback={<div className="fixed inset-0 z-[2100] bg-slate-900" />}>
        <ShareCardSheet {...props} />
      </Suspense>
    </ChunkLoadBoundary>
  );
}
