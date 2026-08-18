
import { useEffect, useMemo, useState } from "react";
import { getServerSession } from "next-auth";
import { notFound } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { isAdmin } from "@/lib/isAdmin";
import AdminClient from "./AdminClient";

// Never cache: admin status is checked per request.
export const dynamic = "force-dynamic";

/** SERVER-SIDE ADMIN GUARD.
 *  Middleware only proves someone is LOGGED IN, and middleware auth has been bypassable
 *  before (CVE-2025-29927), so authorization must never depend on it alone.
 *  This runs on the server before a single byte of admin HTML is produced. A non-admin
 *  gets a plain 404: we do not even confirm that /admin exists. */
export default async function AdminPage() {
  const session = await getServerSession(authOptions);
  if (!(await isAdmin(session?.user?.email))) notFound();
  return <AdminClient />;
}