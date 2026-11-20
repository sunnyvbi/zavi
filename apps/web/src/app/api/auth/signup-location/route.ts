import { createHash, createHmac, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  const secret = process.env.SIGNUP_LOCATION_SIGNING_SECRET;
  if (!secret || secret.length < 32)
    return NextResponse.json({ ticket: null }, { headers });
  const origin = req.headers.get("origin");
  const expected = process.env.NEXT_PUBLIC_SITE_URL || new URL(req.url).origin;
  if (!origin || origin !== new URL(expected).origin)
    return NextResponse.json(
      { error: "Invalid origin" },
      { status: 403, headers },
    );
  const body = await req.json().catch(() => null);
  if (
    typeof body?.email !== "string" ||
    body.email.length > 320 ||
    !body.email.includes("@")
  )
    return NextResponse.json(
      { error: "Invalid request" },
      { status: 400, headers },
    );
  const country = req.headers.get("cloudfront-viewer-country");
  if (!country || !/^[A-Z]{2}$/.test(country) || country === "XX")
    return NextResponse.json({ ticket: null }, { headers });
  let city: string | null = null;
  try {
    city =
      decodeURIComponent(
        req.headers.get("cloudfront-viewer-city") ?? "",
      ).trim() || null;
  } catch {
  }
  if (city && (city.length > 120 || /[\u0000-\u001f\u007f]/.test(city)))
    city = null;
  const payload = JSON.stringify({
    email_hash: createHash("sha256")
      .update(body.email.trim().toLowerCase())
      .digest("hex"),
    country,
    city,
    issued_at: new Date().toISOString(),
    nonce: randomUUID(),
  });
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  return NextResponse.json({ ticket: { payload, signature } }, { headers });
}
