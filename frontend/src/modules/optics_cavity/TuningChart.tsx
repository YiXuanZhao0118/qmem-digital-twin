/**
 * SPDC tuning curve — signal/idler λ vs temperature, on uPlot.
 *
 * `null` entries in the input arrays (temperatures where phase matching
 * could not be solved) are passed through as NaN so uPlot draws a gap.
 */
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

type Props = {
  tC: number[];
  signalNm: (number | null)[];
  idlerNm: (number | null)[];
};

export function TuningChart({ tC, signalNm, idlerNm }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current || tC.length === 0) return;
    plotRef.current?.destroy();

    const toFloat = (x: number | null): number => (x === null ? NaN : x);

    const data: uPlot.AlignedData = [
      Float64Array.from(tC),
      Float64Array.from(signalNm.map(toFloat)),
      Float64Array.from(idlerNm.map(toFloat)),
    ];

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 240,
      scales: {
        x: { time: false },
        y: { auto: true },
      },
      axes: [
        {
          label: "temperature (°C)",
          stroke: "rgba(15, 23, 42, 0.7)",
          grid: { stroke: "rgba(15, 23, 42, 0.08)" },
          ticks: { stroke: "rgba(15, 23, 42, 0.25)" },
        },
        {
          label: "wavelength (nm)",
          stroke: "rgba(15, 23, 42, 0.7)",
          grid: { stroke: "rgba(15, 23, 42, 0.08)" },
          ticks: { stroke: "rgba(15, 23, 42, 0.25)" },
        },
      ],
      series: [
        {},
        { label: "signal", stroke: "#2563eb", width: 2 },
        { label: "idler", stroke: "#ea580c", width: 1.5 },
      ],
      legend: { show: true },
    };

    plotRef.current = new uPlot(opts, data, containerRef.current);

    const onResize = () => {
      if (containerRef.current && plotRef.current) {
        plotRef.current.setSize({
          width: containerRef.current.clientWidth,
          height: 240,
        });
      }
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      plotRef.current?.destroy();
      plotRef.current = null;
    };
  }, [tC, signalNm, idlerNm]);

  return <div ref={containerRef} className="cavity-chart" />;
}
