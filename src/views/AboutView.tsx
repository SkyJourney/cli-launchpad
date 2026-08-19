import { useQuery } from "@tanstack/react-query";
import { getVersion } from "@tauri-apps/api/app";
import { useTranslation } from "react-i18next";
import appLicense from "../../LICENSE?raw";
import mapleLicense from "../assets/fonts/maple/LICENSE.txt?raw";
import notoSansLicense from "../assets/fonts/noto-sans-sc/LICENSE.txt?raw";
import lobeIconsLicense from "../assets/icons/brands/LICENSE.txt?raw";
import { AppLogo } from "../components/AppLogo";
import { qk } from "../lib/queryKeys";
import { TOOLS } from "../lib/tools";

export function AboutView() {
  const { t } = useTranslation();
  const version = useQuery({ queryKey: qk.appVersion(), queryFn: getVersion });

  return (
    <div className="about-view">
      <header className="detail-head">
        <h1>{t("about.title")}</h1>
      </header>

      <section className="about-card">
        <div className="about-brand">
          <AppLogo size={48} />
          <div>
            <strong>CLI Launchpad</strong>
            <span className="muted">
              {t("about.version", { version: version.data ?? "…" })}
            </span>
          </div>
        </div>

        <p className="muted">{t("about.description")}</p>

        <div className="about-rows">
          <div className="about-row">
            <span className="about-key">{t("about.supportedCli")}</span>
            <span className="about-tools">
              {TOOLS.map((tool) => (
                <span className="about-tool" key={tool.key}>
                  <tool.icon size={16} />
                  {tool.label}
                </span>
              ))}
            </span>
          </div>
        </div>
      </section>

      <section className="about-card about-license-card">
        <div>
          <span className="about-key">{t("about.licenses")}</span>
          <p className="muted about-license-intro">{t("about.licenseIntro")}</p>
        </div>

        <div className="about-license-list">
          <LicenseDetails
            title="CLI Launchpad · MIT License"
            text={appLicense}
          />
          <LicenseDetails
            title="Noto Sans SC · SIL OFL 1.1"
            text={notoSansLicense}
          />
          <LicenseDetails
            title="Maple Mono NF CN · SIL OFL 1.1"
            text={mapleLicense}
          />
          <LicenseDetails
            title="Lobe Icons · MIT License"
            text={lobeIconsLicense}
          />
        </div>
      </section>
    </div>
  );
}

function LicenseDetails({ title, text }: { title: string; text: string }) {
  return (
    <details className="license-details">
      <summary>{title}</summary>
      <pre>{text}</pre>
    </details>
  );
}
