import { NextResponse } from "next/server";

import { AASA } from "./aasa";

export function GET() {
  return NextResponse.json(AASA, {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
