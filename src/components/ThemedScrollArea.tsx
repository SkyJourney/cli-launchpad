import clsx from "clsx";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type PropsWithChildren,
  type UIEvent,
} from "react";

interface ScrollDrag {
  pointerId: number;
  startY: number;
  startScrollTop: number;
  scrollRange: number;
  thumbTravel: number;
}

interface ThemedScrollAreaProps extends PropsWithChildren {
  className?: string;
  viewportClassName?: string;
  viewportProps?: Omit<
    HTMLAttributes<HTMLDivElement>,
    "className" | "onScroll"
  >;
}

const SCROLLBAR_HIDE_DELAY_MS = 750;
const SCROLLBAR_MIN_THUMB_HEIGHT = 24;

export function ThemedScrollArea({
  children,
  className,
  viewportClassName,
  viewportProps,
}: ThemedScrollAreaProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const dragRef = useRef<ScrollDrag | null>(null);
  const [scrollbarVisible, setScrollbarVisible] = useState(false);

  const updateThumb = useCallback(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!viewport || !track || !thumb) return;

    const scrollRange = viewport.scrollHeight - viewport.clientHeight;
    const trackHeight = track.clientHeight;
    if (scrollRange <= 0 || trackHeight <= 0) {
      thumb.style.display = "none";
      return;
    }

    const thumbHeight = Math.min(
      trackHeight,
      Math.max(
        SCROLLBAR_MIN_THUMB_HEIGHT,
        (viewport.clientHeight / viewport.scrollHeight) * trackHeight,
      ),
    );
    const thumbTravel = trackHeight - thumbHeight;
    const thumbTop = (viewport.scrollTop / scrollRange) * thumbTravel;
    thumb.style.display = "block";
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    updateThumb();
    const resizeObserver = new ResizeObserver(updateThumb);
    resizeObserver.observe(viewport);
    const mutationObserver = new MutationObserver(updateThumb);
    mutationObserver.observe(viewport, { childList: true, subtree: true });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [updateThumb]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    updateThumb();
    setScrollbarVisible(true);
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = window.setTimeout(() => {
      setScrollbarVisible(false);
      hideTimerRef.current = null;
    }, SCROLLBAR_HIDE_DELAY_MS);
  };

  const handleTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    const track = event.currentTarget;
    const thumb = thumbRef.current;
    if (!viewport || !thumb) return;

    event.preventDefault();
    const trackRect = track.getBoundingClientRect();
    const thumbTop = thumb.getBoundingClientRect().top - trackRect.top;
    const pointerTop = event.clientY - trackRect.top;
    viewport.scrollTop +=
      pointerTop < thumbTop ? -viewport.clientHeight : viewport.clientHeight;
  };

  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const thumb = event.currentTarget;
    if (!viewport || !track) return;

    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: viewport.scrollTop,
      scrollRange: viewport.scrollHeight - viewport.clientHeight,
      thumbTravel: track.clientHeight - thumb.clientHeight,
    };
    thumb.setPointerCapture(event.pointerId);
  };

  const handleThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    if (
      !drag ||
      drag.pointerId !== event.pointerId ||
      !viewport ||
      drag.thumbTravel <= 0
    ) {
      return;
    }

    viewport.scrollTop =
      drag.startScrollTop +
      ((event.clientY - drag.startY) / drag.thumbTravel) * drag.scrollRange;
  };

  const handleThumbPointerEnd = () => {
    dragRef.current = null;
  };

  return (
    <div className={clsx("themed-scroll-area", className)}>
      <div
        {...viewportProps}
        ref={viewportRef}
        className={clsx("themed-scroll-viewport", viewportClassName)}
        onScroll={handleScroll}
      >
        {children}
      </div>
      <div
        ref={trackRef}
        className={clsx("themed-scrollbar", {
          visible: scrollbarVisible,
        })}
        aria-hidden="true"
        onPointerDown={handleTrackPointerDown}
      >
        <div
          ref={thumbRef}
          className="themed-scrollbar-thumb"
          onPointerDown={handleThumbPointerDown}
          onPointerMove={handleThumbPointerMove}
          onPointerUp={handleThumbPointerEnd}
          onPointerCancel={handleThumbPointerEnd}
        />
      </div>
    </div>
  );
}
