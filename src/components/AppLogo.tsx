import appIcon from "../../src-tauri/icons/128x128.png";

interface AppLogoProps {
  size: number;
}

export function AppLogo({ size }: AppLogoProps) {
  return (
    <img
      className="app-logo"
      src={appIcon}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}
