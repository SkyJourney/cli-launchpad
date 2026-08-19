import type { CSSProperties } from "react";

export interface SvgAssetIconProps {
  className?: string;
  monochrome?: boolean;
  size?: number | string;
  src: string;
}

export function SvgAssetIcon({
  className,
  monochrome = false,
  size = "1em",
  src,
}: SvgAssetIconProps) {
  const dimension = typeof size === "number" ? `${size}px` : size;

  if (monochrome) {
    const maskUrl = `url("${src.replace(/"/g, "%22")}")`;

    return (
      <span
        aria-hidden="true"
        className={className}
        style={
          {
            backgroundColor: "currentColor",
            display: "inline-block",
            flex: "none",
            height: dimension,
            maskImage: maskUrl,
            maskPosition: "center",
            maskRepeat: "no-repeat",
            maskSize: "contain",
            width: dimension,
            WebkitMaskImage: maskUrl,
            WebkitMaskPosition: "center",
            WebkitMaskRepeat: "no-repeat",
            WebkitMaskSize: "contain",
          } as CSSProperties
        }
      />
    );
  }

  return (
    <img
      aria-hidden="true"
      className={className}
      src={src}
      alt=""
      height={dimension}
      width={dimension}
      style={{ display: "block", flex: "none" }}
    />
  );
}

export function createSvgAssetIcon(src: string) {
  return function StaticSvgIcon({ size }: { size?: number | string }) {
    return <SvgAssetIcon src={src} size={size} />;
  };
}
