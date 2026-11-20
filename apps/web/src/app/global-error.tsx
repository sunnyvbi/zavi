"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#FAF7F0", color: "#111" }}>
        <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ maxWidth: 480, textAlign: "center" }}>
            <h1 style={{ fontSize: 28, margin: 0 }}>Zavi is having trouble right now.</h1>
            <p style={{ fontSize: 16, lineHeight: 1.6, color: "#555", marginTop: 16 }}>
              Your work is safe. Please try again in a moment.
            </p>
            <button
              type="button"
              onClick={() => reset()}
              style={{ marginTop: 24, padding: "10px 20px", borderRadius: 999, border: 0, background: "#111", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        </main>
      </body>
    </html>
  );
}
