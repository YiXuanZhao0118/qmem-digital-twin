/**
 * Airy transmission / reflection spectrum — uPlot canvas chart.
 *
 * X axis: frequency offset from cavity resonance, in MHz.
 * Y axis: transmission (blue) and reflection (orange), both in [0, 1].
 *
 * Re-creates the chart whenever the spectrum array length changes (a
 * different compute call); just updates data when the array changes
 * in place.
 */
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

type Props = {
  freqOffsetMhz: number[];
  transmission: number[];
  reflection: number[];
  /** Cavity FWHM in MHz — drawn as a horizontal hint annotation. */
  fwhmMhz: number;
};

export function AiryChart({ freqOffsetMhz, transmission, reflection }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (freqOffsetMhz.length === 0) return;
    plotRef.current?.destroy();

    const data: uPlot.AlignedData = [
      Float64Array.from(freqOffsetMhz),
      Float64Array.from(transmission),
      Float64Array.from(reflection),
    ];

    const opts: uPlot.Options = {
      width: containerRef.current.clientWidth,
      height: 240,
      scales: {
        x: { time: false },
        y: { range: [-0.02, 1.05] },
      },
      axes: [
        {
          label: "frequency offset (MHz)",
          stroke: "rgba(15, 23, 42, 0.7)",
          grid: { stroke: "rgba(15, 23, 42, 0.08)" },
          ticks: { stroke: "rgba(15, 23, 42, 0.25)" },
        },
        {
          label: "intensity",
          stroke: "rgba(15, 23, 42, 0.7)",
          grid: { stroke: "rgba(15, 23, 42, 0.08)" },
          ticks: { stroke: "rgba(15, 23, 42, 0.25)" },
        },
      ],
      series: [
        {},
        { label: "T", stroke: "#2563eb", width: 2, fill: "rgba(37, 99, 235, 0.12)" },
        { label: "R", stroke: "#ea580c", width: 1.5 },
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
  }, [freqOffsetMhz, transmission, reflection]);

  return <div ref={containerRef} className="cavity-chart" />;
}
