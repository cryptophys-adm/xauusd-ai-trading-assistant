// lightweight-charts for the page render check (scripts/render-check.mjs): the library draws on a canvas in the
// browser, and a page builds its chart only in useEffect, which renderToStaticMarkup never runs. The stub carries the
// same enums (values of lightweight-charts 4.2.0) and a createChart whose chart, series and lines accept any call, so a
// page that imports the library renders its markup in Node. Never part of the build (build.mjs bundles the real one).

export const ColorType = Object.freeze({ Solid: "solid", VerticalGradient: "gradient" });
export const CrosshairMode = Object.freeze({ Normal: 0, Magnet: 1, Hidden: 2 });
export const LastPriceAnimationMode = Object.freeze({ Disabled: 0, Continuous: 1, OnDataUpdate: 2 });
export const LineStyle = Object.freeze({ Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 });
export const LineType = Object.freeze({ Simple: 0, WithSteps: 1, Curved: 2 });
export const MismatchDirection = Object.freeze({ NearestLeft: -1, None: 0, NearestRight: 1 });
export const PriceLineSource = Object.freeze({ LastBar: 0, LastVisible: 1 });
export const PriceScaleMode = Object.freeze({ Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 });
export const TickMarkType = Object.freeze({ Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 });
export const TrackingModeExitMode = Object.freeze({ OnTouchEnd: 0, OnNextTap: 1 });

/** Any property is a function that returns another such object: chart.addCandlestickSeries().createPriceLine(…). */
function inert() {
  const fn = () => proxy;
  const proxy = new Proxy(fn, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : proxy), apply: () => proxy });
  return proxy;
}

export const createChart = () => inert();
export const createChartEx = () => inert();
export const defaultHorzScaleBehavior = () => class {};
export const isBusinessDay = (t) => t != null && typeof t === "object";
export const isUTCTimestamp = (t) => typeof t === "number";
export const version = () => "4.2.0-render-check-stub";
