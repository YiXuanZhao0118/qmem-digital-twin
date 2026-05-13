/**
 * Phase RF.5 — read-only RF chain output indicator for AOM / EOM panels.
 *
 * Shows the computed drive state at the chain's terminal (this device):
 *   - source frequency (DDS @ chain[0])
 *   - source dBm + Σ gain_db of all later nodes
 *   - converted to mW / W
 *
 * Doesn't write back to OpticalElement.kindParams — those values are
 * still authoritative for the optics solver. This readout just answers
 * "what is the lab actually driving this AOM with right now."
 */
import { Antenna } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { fetchRfChainApi } from "../api/client";
import type { RfChainNode } from "../types/digitalTwin";

function dbmToMw(dbm: number): number {
  return Math.pow(10, dbm / 10);
}

export function RfChainReadout({ sceneObjectId }: { sceneObjectId: string }) {
  const [chain, setChain] = useState<RfChainNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchRfChainApi(sceneObjectId);
        if (!cancelled) setChain(rows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sceneObjectId]);

  const summary = useMemo(() => {
    if (chain.length === 0) return null;
    const sorted = [...chain].sort((a, b) => a.positionInChain - b.positionInChain);
    const source = sorted[0];
    if (source.nodeKind !== "dds" && source.nodeKind !== "synthesizer") return null;
    const sourceDbm = Number(
      (source.kindParams as { powerDbm?: number })?.powerDbm ?? 0,
    );
    const sourceFreqMhz = Number(
      (source.kindParams as { frequencyMhz?: number })?.frequencyMhz ?? 0,
    );
    const gainSum = sorted.slice(1).reduce((acc, n) => acc + (n.gainDb ?? 0), 0);
    const outputDbm = sourceDbm + gainSum;
    return {
      sourceFreqMhz,
      outputDbm,
      outputMw: dbmToMw(outputDbm),
      nodeCount: sorted.length,
      gainSum,
    };
  }, [chain]);

  if (error || !summary) return null;

  return (
    <section className="rf-chain-readout">
      <h3>
        <Antenna size={12} /> RF drive (from chain)
      </h3>
      <div className="rf-chain-grid">
        <span className="rf-chain-label">Frequency</span>
        <span className="rf-chain-value">{summary.sourceFreqMhz.toFixed(3)} MHz</span>

        <span className="rf-chain-label">Output power</span>
        <span className="rf-chain-value">
          {summary.outputDbm >= 0 ? "+" : ""}
          {summary.outputDbm.toFixed(1)} dBm
          <em className="rf-chain-secondary">
            ≈{" "}
            {summary.outputMw >= 1000
              ? `${(summary.outputMw / 1000).toFixed(3)} W`
              : `${summary.outputMw.toFixed(2)} mW`}
          </em>
        </span>

        <span className="rf-chain-label">Σ gain</span>
        <span className="rf-chain-value rf-chain-secondary">
          {summary.gainSum >= 0 ? "+" : ""}
          {summary.gainSum.toFixed(1)} dB over {summary.nodeCount - 1} stage
          {summary.nodeCount === 2 ? "" : "s"}
        </span>
      </div>
    </section>
  );
}
