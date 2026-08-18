import { withAuth } from "next-auth/middleware";

// Requires login for the workspace and admin. (Admin routes/pages additionally
// verify the email is an admin — see lib/isAdmin.ts.)
export default withAuth({
  pages: { signIn: "/login" },
});

export const config = { matcher: ["/app/:path*", "/admin/:path*"] };
