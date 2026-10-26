import { NextResponse } from 'next/server';

/**
 * GET /api/token
 *
 * Returns the auth token to the browser at runtime.
 * VESSEL_TOKEN is a server-side-only environment variable (no NEXT_PUBLIC_ prefix),
 * so it is never included in the compiled JavaScript bundle.
 *
 * Set it in frontend/.env.local:
 *   VESSEL_TOKEN=<same value as backend/.env>
 */
export async function GET(): Promise<NextResponse> {
  const token = process.env.VESSEL_TOKEN;

  if (!token) {
    return NextResponse.json(
      { error: 'VESSEL_TOKEN is not configured on the server. Add it to frontend/.env.local.' },
      { status: 500 }
    );
  }

  return NextResponse.json({ token });
}
