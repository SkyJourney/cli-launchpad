import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { takeStartupNotices, type StartupNotice } from "../lib/tauri";

export function StartupNotices({ ready }: { ready: boolean }) {
  const { t } = useTranslation();
  const requestedRef = useRef(false);
  const [notices, setNotices] = useState<StartupNotice[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!ready || requestedRef.current) return;
    requestedRef.current = true;
    void takeStartupNotices()
      .then((result) => setNotices(Array.isArray(result) ? result : []))
      .catch((error: unknown) =>
        console.warn("startup_notice.take_failed", error),
      );
  }, [ready]);

  const abnormal = notices.find(
    (notice) => notice.kind === "abnormal_exit_detected",
  );
  if (dismissed || !abnormal) return null;
  const time =
    abnormal.startedAtMs == null
      ? null
      : new Date(abnormal.startedAtMs).toLocaleString();
  return (
    <div className="startup-notice" role="status">
      <p>
        {time === null
          ? t("startupNotice.abnormalExit")
          : t("startupNotice.abnormalExitWithTime", { time })}
      </p>
      <button
        type="button"
        className="ghost-button"
        onClick={() => setDismissed(true)}
      >
        {t("startupNotice.dismiss")}
      </button>
    </div>
  );
}
