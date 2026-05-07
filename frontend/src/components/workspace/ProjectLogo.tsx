/**
 * Quantum Optics Lab project mark.
 *
 * Optimized SVG re-draw of the original PNG: two overlapping Gaussian beam
 * profiles sitting on a triangular peak. Pure paths so it scales cleanly,
 * picks up `currentColor` for the peak outline, and uses dedicated maroon
 * tones for the curves.
 */
export function ProjectLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`project-logo${compact ? " compact" : ""}`} aria-label="Quantum Optics Lab">
      <svg
        className="project-logo-mark"
        viewBox="0 0 64 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        {/* Triangular peak / mountain outline (uses currentColor so it themes with text) */}
        <path
          d="M 4 42 L 28 6 L 56 42"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Tall bell curve — primary mode (maroon) */}
        <path
          d="M 2 42 Q 12 42 16 32 Q 22 8 28 8 Q 34 8 38 32 Q 42 42 50 42"
          stroke="#9d2235"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        {/* Shorter bell curve — secondary mode (darker maroon, offset right) */}
        <path
          d="M 18 42 Q 26 42 30 36 Q 36 18 40 18 Q 44 18 48 36 Q 52 42 60 42"
          stroke="#5e1620"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
      {!compact && (
        <span className="project-logo-text">
          <span className="project-logo-line">QUANTUM</span>
          <span className="project-logo-line">OPTICS LAB</span>
        </span>
      )}
    </span>
  );
}
