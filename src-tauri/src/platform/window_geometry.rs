use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkArea {
    pub rect: Rect,
    pub scale_factor: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowBoundsPlan {
    pub outer: Rect,
    pub inner_width: u32,
    pub inner_height: u32,
    pub min_inner_width: f64,
    pub min_inner_height: f64,
}

/// Selects the work area containing the largest part of the restored window.
/// If the window is fully off-screen, the primary monitor is used when available.
pub fn select_work_area(
    window: Rect,
    work_areas: &[WorkArea],
    primary_index: Option<usize>,
) -> Option<usize> {
    if work_areas.is_empty() {
        return None;
    }

    let best = work_areas
        .iter()
        .enumerate()
        .map(|(index, area)| (index, intersection_area(window, area.rect)))
        .max_by_key(|(_, area)| *area);

    match best {
        Some((index, area)) if area > 0 => Some(index),
        _ => primary_index
            .filter(|index| *index < work_areas.len())
            .or(Some(0)),
    }
}

/// Fits the restored client size and outer position into a physical monitor work area.
/// The configured minimum is lowered only when the selected display cannot fit it.
pub fn plan_window_bounds(
    restored_outer: Rect,
    restored_inner: PhysicalSize<u32>,
    work_area: WorkArea,
    configured_min_inner: LogicalSize<f64>,
) -> WindowBoundsPlan {
    let scale_factor = if work_area.scale_factor.is_finite() && work_area.scale_factor > 0.0 {
        work_area.scale_factor
    } else {
        1.0
    };

    let work_width = work_area.rect.width.max(1);
    let work_height = work_area.rect.height.max(1);
    // A decorated frame can never consume the entire work area; retain at least one client pixel.
    let frame_width = restored_outer
        .width
        .saturating_sub(restored_inner.width)
        .min(work_width - 1);
    let frame_height = restored_outer
        .height
        .saturating_sub(restored_inner.height)
        .min(work_height - 1);
    let max_inner_width = work_width - frame_width;
    let max_inner_height = work_height - frame_height;

    let min_inner_width =
        bounded_minimum(configured_min_inner.width, max_inner_width, scale_factor);
    let min_inner_height =
        bounded_minimum(configured_min_inner.height, max_inner_height, scale_factor);
    let min_inner_width_px =
        logical_minimum_to_physical(min_inner_width, scale_factor, max_inner_width);
    let min_inner_height_px =
        logical_minimum_to_physical(min_inner_height, scale_factor, max_inner_height);

    let inner_width = restored_inner
        .width
        .clamp(min_inner_width_px, max_inner_width);
    let inner_height = restored_inner
        .height
        .clamp(min_inner_height_px, max_inner_height);
    let outer_width = inner_width.saturating_add(frame_width).min(work_width);
    let outer_height = inner_height.saturating_add(frame_height).min(work_height);
    let x = clamp_axis(restored_outer.x, work_area.rect.x, work_width, outer_width);
    let y = clamp_axis(
        restored_outer.y,
        work_area.rect.y,
        work_height,
        outer_height,
    );

    WindowBoundsPlan {
        outer: Rect {
            x,
            y,
            width: outer_width,
            height: outer_height,
        },
        inner_width,
        inner_height,
        min_inner_width,
        min_inner_height,
    }
}

fn bounded_minimum(configured: f64, available_physical: u32, scale_factor: f64) -> f64 {
    let configured = if configured.is_finite() && configured > 0.0 {
        configured
    } else {
        1.0
    };
    configured.min(available_physical as f64 / scale_factor)
}

fn logical_minimum_to_physical(logical: f64, scale_factor: f64, maximum: u32) -> u32 {
    ((logical * scale_factor).ceil() as u32).clamp(1, maximum.max(1))
}

fn clamp_axis(position: i32, area_start: i32, area_length: u32, window_length: u32) -> i32 {
    let start = i64::from(area_start);
    let max_start = start + i64::from(area_length.saturating_sub(window_length));
    i64::from(position)
        .clamp(start, max_start)
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn intersection_area(left: Rect, right: Rect) -> u64 {
    let overlap_width = (right_edge(left).min(right_edge(right))
        - i64::from(left.x).max(i64::from(right.x)))
    .max(0) as u64;
    let overlap_height = (bottom_edge(left).min(bottom_edge(right))
        - i64::from(left.y).max(i64::from(right.y)))
    .max(0) as u64;
    overlap_width.saturating_mul(overlap_height)
}

fn right_edge(rect: Rect) -> i64 {
    i64::from(rect.x) + i64::from(rect.width)
}

fn bottom_edge(rect: Rect) -> i64 {
    i64::from(rect.y) + i64::from(rect.height)
}

/// Corrects the state restored by `tauri-plugin-window-state` after its initial restore.
/// Maximized and fullscreen windows are left to the operating system to preserve their state.
pub fn constrain_restored_window<R: Runtime>(
    window: &WebviewWindow<R>,
    configured_min_width: f64,
    configured_min_height: f64,
) -> tauri::Result<bool> {
    if window.is_maximized()? || window.is_fullscreen()? {
        return Ok(false);
    }

    let monitors = window.available_monitors()?;
    if monitors.is_empty() {
        return Ok(false);
    }

    let restored_position = window.outer_position()?;
    let restored_outer_size = window.outer_size()?;
    let restored_inner_size = window.inner_size()?;
    let restored_outer = Rect {
        x: restored_position.x,
        y: restored_position.y,
        width: restored_outer_size.width,
        height: restored_outer_size.height,
    };
    let work_areas: Vec<WorkArea> = monitors
        .iter()
        .map(|monitor| WorkArea {
            rect: Rect {
                x: monitor.work_area().position.x,
                y: monitor.work_area().position.y,
                width: monitor.work_area().size.width,
                height: monitor.work_area().size.height,
            },
            scale_factor: monitor.scale_factor(),
        })
        .collect();
    let primary_index = window.primary_monitor()?.and_then(|primary| {
        work_areas.iter().position(|area| {
            area.rect.x == primary.work_area().position.x
                && area.rect.y == primary.work_area().position.y
                && area.rect.width == primary.work_area().size.width
                && area.rect.height == primary.work_area().size.height
        })
    });
    let Some(monitor_index) = select_work_area(restored_outer, &work_areas, primary_index) else {
        return Ok(false);
    };
    let work_area = work_areas[monitor_index];
    let plan = plan_window_bounds(
        restored_outer,
        restored_inner_size,
        work_area,
        LogicalSize::new(configured_min_width, configured_min_height),
    );

    window.set_min_size(Some(LogicalSize::new(
        plan.min_inner_width,
        plan.min_inner_height,
    )))?;
    if plan.inner_width != restored_inner_size.width
        || plan.inner_height != restored_inner_size.height
    {
        window.set_size(PhysicalSize::new(plan.inner_width, plan.inner_height))?;
    }
    let actual_outer_size = window.outer_size()?;
    // Use the larger of observed and planned bounds in case the native resize event
    // has not completed yet; this keeps the position safe during asynchronous resizing.
    let position_width = actual_outer_size.width.max(plan.outer.width);
    let position_height = actual_outer_size.height.max(plan.outer.height);
    let final_position = PhysicalPosition::new(
        clamp_axis(
            plan.outer.x,
            work_area.rect.x,
            work_area.rect.width.max(1),
            position_width,
        ),
        clamp_axis(
            plan.outer.y,
            work_area.rect.y,
            work_area.rect.height.max(1),
            position_height,
        ),
    );
    let position_changed =
        final_position.x != restored_position.x || final_position.y != restored_position.y;
    if position_changed {
        window.set_position(final_position)?;
    }

    let adjusted = plan.inner_width != restored_inner_size.width
        || plan.inner_height != restored_inner_size.height
        || position_changed;
    log::log!(
        if adjusted { log::Level::Info } else { log::Level::Debug },
        "restored main window {}work-area bounds position=({}, {}) outer={}x{} inner={}x{} minimum={:.1}x{:.1}",
        if adjusted { "constrained to " } else { "fits " },
        final_position.x,
        final_position.y,
        actual_outer_size.width,
        actual_outer_size.height,
        plan.inner_width,
        plan.inner_height,
        plan.min_inner_width,
        plan.min_inner_height,
    );
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> WorkArea {
        WorkArea {
            rect: Rect {
                x,
                y,
                width,
                height,
            },
            scale_factor,
        }
    }

    fn restored(x: i32, y: i32, outer_width: u32, outer_height: u32) -> Rect {
        Rect {
            x,
            y,
            width: outer_width,
            height: outer_height,
        }
    }

    #[test]
    fn preserves_geometry_when_window_fits_work_area() {
        let plan = plan_window_bounds(
            restored(120, 80, 1200, 800),
            PhysicalSize::new(1184, 761),
            area(0, 0, 1920, 1080, 1.0),
            LogicalSize::new(860.0, 560.0),
        );

        assert_eq!(plan.outer, restored(120, 80, 1200, 800));
        assert_eq!((plan.inner_width, plan.inner_height), (1184, 761));
        assert_eq!(
            (plan.min_inner_width, plan.min_inner_height),
            (860.0, 560.0)
        );
    }

    #[test]
    fn clamps_oversized_window_and_offscreen_position() {
        let plan = plan_window_bounds(
            restored(-800, 700, 3000, 1800),
            PhysicalSize::new(2984, 1761),
            area(0, 0, 1920, 1080, 1.0),
            LogicalSize::new(860.0, 560.0),
        );

        assert_eq!(plan.outer, restored(0, 0, 1920, 1080));
        assert_eq!((plan.inner_width, plan.inner_height), (1904, 1041));
    }

    #[test]
    fn handles_negative_monitor_origins_and_partial_overflow() {
        let plan = plan_window_bounds(
            restored(-2300, -120, 1200, 800),
            PhysicalSize::new(1184, 761),
            area(-1920, -100, 1920, 1040, 1.0),
            LogicalSize::new(860.0, 560.0),
        );

        assert_eq!(plan.outer, restored(-1920, -100, 1200, 800));
    }

    #[test]
    fn lowers_minimum_to_fit_small_high_dpi_display() {
        let plan = plan_window_bounds(
            restored(50, 40, 1600, 1000),
            PhysicalSize::new(1584, 961),
            area(0, 0, 1280, 720, 1.5),
            LogicalSize::new(860.0, 560.0),
        );

        assert_eq!(plan.outer, restored(0, 0, 1280, 720));
        assert_eq!((plan.inner_width, plan.inner_height), (1264, 681));
        assert!(plan.min_inner_width < 860.0);
        assert!(plan.min_inner_height < 560.0);
    }

    #[test]
    fn chooses_largest_overlap_and_primary_for_fully_offscreen_window() {
        let monitors = [area(-1920, 0, 1920, 1080, 1.0), area(0, 0, 1600, 900, 1.0)];
        assert_eq!(
            select_work_area(restored(-1100, 100, 1200, 800), &monitors, Some(1)),
            Some(0)
        );
        assert_eq!(
            select_work_area(restored(4000, 4000, 1200, 800), &monitors, Some(1)),
            Some(1)
        );
    }

    #[test]
    fn falls_back_to_first_monitor_when_no_primary_is_available() {
        let monitors = [area(0, 0, 1920, 1080, 1.0)];
        assert_eq!(
            select_work_area(restored(3000, 3000, 800, 600), &monitors, None),
            Some(0)
        );
        assert_eq!(select_work_area(restored(0, 0, 10, 10), &[], None), None);
    }
}
